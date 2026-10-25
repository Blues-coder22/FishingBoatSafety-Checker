/* =====================================================================
   Fishing Boat Safety - Bridge

   C++ server --TCP 5001 (alerts)------\
                                        >--  bridge.js  --WebSocket 8080--> browser dashboard
   C++ server --UDP 5002 (heartbeats)--/            \
                                                     `--MySQL (XAMPP)--> phpMyAdmin

   Run:  node bridge.js
   ===================================================================== */

const net = require("net");
const dgram = require("dgram");
const { WebSocketServer } = require("ws");
const mysql = require("mysql2/promise");

/* ---------- Settings (change here, or set environment variables) ---------- */
const CONFIG = {
  serverHost: process.env.SERVER_HOST || "127.0.0.1",
  serverTcpPort: Number(process.env.SERVER_TCP_PORT || 5001),   // C++ alerts
  heartbeatUdpPort: Number(process.env.HB_UDP_PORT || 5002),    // copy of heartbeats from the C++ server
  wsPort: Number(process.env.WS_PORT || 8080),                  // dashboard connects here
  db: {
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "root",        // XAMPP default
    password: process.env.DB_PASSWORD || "",    // XAMPP default is empty
    database: process.env.DB_NAME || "fishing_boat_safety"
  },
  maxHistory: 50
};

const log = (...a) => console.log(new Date().toLocaleTimeString("en-GB"), ...a);

/* ---------- In-memory state (sent to dashboards that connect late) ---------- */
const alertHistory = [];          // newest last, e.g. "ALERT|OVERDUE|BOAT001|10:42:15"
const latestHb = new Map();       // boatId -> { seq, lat, lon, at }
let serverUp = false;

/* =====================================================================
   DATABASE
   ===================================================================== */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS boats (
     boat_id    VARCHAR(20) PRIMARY KEY,
     status     VARCHAR(10) NOT NULL DEFAULT 'ACTIVE',
     last_seq   INT NULL,
     last_lat   DECIMAL(9,6) NULL,
     last_lon   DECIMAL(9,6) NULL,
     last_seen  DATETIME NULL,
     updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
   ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS heartbeats (
     id          BIGINT AUTO_INCREMENT PRIMARY KEY,
     boat_id     VARCHAR(20) NOT NULL,
     msg_type    VARCHAR(10) NOT NULL,
     seq         INT NOT NULL,
     latitude    DECIMAL(9,6) NOT NULL,
     longitude   DECIMAL(9,6) NOT NULL,
     received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
     INDEX idx_boat_time (boat_id, received_at)
   ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS boat_details (
     boat_id         VARCHAR(20) PRIMARY KEY,
     boat_name       VARCHAR(60) NULL,
     registration_no VARCHAR(30) NULL,
     captain         VARCHAR(60) NULL,
     owner           VARCHAR(60) NULL,
     phone           VARCHAR(20) NULL,
     crew_count      TINYINT UNSIGNED NULL,
     landing_site    VARCHAR(60) NULL,
     updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
   ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS alerts (
     id          BIGINT AUTO_INCREMENT PRIMARY KEY,
     alert_type  VARCHAR(10) NOT NULL,
     boat_id     VARCHAR(20) NOT NULL,
     alert_time  VARCHAR(8) NOT NULL,
     received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
     UNIQUE KEY uq_alert (alert_type, boat_id, alert_time)
   ) ENGINE=InnoDB`
];

let pool = null;

async function initDb() {
  const { database, ...conn } = CONFIG.db;
  const first = await mysql.createConnection(conn);
  await first.query("CREATE DATABASE IF NOT EXISTS `" + database + "` CHARACTER SET utf8mb4");
  await first.end();

  const p = mysql.createPool({ ...CONFIG.db, waitForConnections: true, connectionLimit: 5 });
  for (const sql of SCHEMA) await p.query(sql);
  pool = p;
  log("[db] connected to MySQL, database '" + database + "' ready");
  await loadDetails();
}

/* ---------- Boat details (registration form on the dashboard) ---------- */
const detailsCache = new Map();   // boatId -> { boat_name, registration_no, ... }
const DETAIL_COLS = ["boat_name", "registration_no", "captain", "owner", "phone", "crew_count", "landing_site"];

function detailsLine(id) {
  return "DETAILS|" + id + "|" + JSON.stringify(detailsCache.get(id));
}

async function loadDetails() {
  const [rows] = await pool.query("SELECT * FROM boat_details");
  for (const r of rows) {
    const d = {};
    DETAIL_COLS.forEach((c) => { d[c] = r[c]; });
    detailsCache.set(r.boat_id, d);
    broadcast(detailsLine(r.boat_id));
  }
  log("[db] loaded details for " + rows.length + " boat(s)");
}

// Validate what the browser sent. Returns { id, d } or throws an Error with a readable message.
function cleanDetails(b) {
  if (!b || typeof b !== "object") throw new Error("Invalid data.");
  const id = String(b.boat_id || "").trim();
  if (!/^[A-Za-z0-9_-]{1,20}$/.test(id)) throw new Error("Invalid boat ID.");
  const text = (v, max) => {
    const s = String(v == null ? "" : v).trim();
    if (s.length > max) throw new Error("A field is too long (max " + max + ").");
    if (/[\r\n\u0000]/.test(s)) throw new Error("Invalid characters.");
    return s === "" ? null : s;
  };
  const d = {
    boat_name: text(b.boat_name, 60),
    registration_no: text(b.registration_no, 30),
    captain: text(b.captain, 60),
    owner: text(b.owner, 60),
    phone: text(b.phone, 20),
    crew_count: null,
    landing_site: text(b.landing_site, 60)
  };
  if (d.phone && !/^[0-9+()\- ]{1,20}$/.test(d.phone)) throw new Error("Invalid phone number.");
  const crew = String(b.crew_count == null ? "" : b.crew_count).trim();
  if (crew !== "") {
    if (!/^\d{1,2}$/.test(crew)) throw new Error("Crew count must be 0-99.");
    d.crew_count = parseInt(crew, 10);
  }
  return { id, d };
}

async function saveDetails(b) {
  const { id, d } = cleanDetails(b);
  if (!pool) throw new Error("Database not available - start MySQL in XAMPP.");
  await pool.execute(
    `INSERT INTO boat_details (boat_id, boat_name, registration_no, captain, owner, phone, crew_count, landing_site)
     VALUES (?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE boat_name=VALUES(boat_name), registration_no=VALUES(registration_no),
       captain=VALUES(captain), owner=VALUES(owner), phone=VALUES(phone),
       crew_count=VALUES(crew_count), landing_site=VALUES(landing_site)`,
    [id, d.boat_name, d.registration_no, d.captain, d.owner, d.phone, d.crew_count, d.landing_site]);
  detailsCache.set(id, d);
  broadcast(detailsLine(id));          // every open dashboard updates
  log("[db] saved details for " + id);
}

// Keep trying: the bridge still works (dashboard only) if MySQL is not started yet.
async function dbLoop() {
  while (!pool) {
    try { await initDb(); }
    catch (err) {
      log("[db] not available (" + err.code + " " + err.message + ") - is MySQL started in XAMPP? Retrying in 10 s");
      await new Promise((r) => setTimeout(r, 10000));
    }
  }
}

async function dbRun(sql, params) {
  if (!pool) return;                       // DB not ready: skip, never crash
  try { await pool.execute(sql, params); }
  catch (err) { log("[db] write failed:", err.code || "", err.message); }
}

function saveHeartbeat(type, id, seq, lat, lon) {
  dbRun("INSERT INTO heartbeats (boat_id, msg_type, seq, latitude, longitude) VALUES (?,?,?,?,?)",
        [id, type, seq, lat, lon]);
  dbRun(`INSERT INTO boats (boat_id, status, last_seq, last_lat, last_lon, last_seen)
         VALUES (?, 'ACTIVE', ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE last_seq=VALUES(last_seq), last_lat=VALUES(last_lat),
                                 last_lon=VALUES(last_lon), last_seen=NOW()`,
        [id, seq, lat, lon]);
}

function saveAlert(type, id, time) {
  dbRun("INSERT IGNORE INTO alerts (alert_type, boat_id, alert_time) VALUES (?,?,?)", [type, id, time]);
  const status = type === "RECOVERED" ? "ACTIVE" : type;   // OVERDUE or DISTRESS
  dbRun(`INSERT INTO boats (boat_id, status) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE status=VALUES(status)`, [id, status]);
}

/* =====================================================================
   WEBSOCKET (to the dashboard)
   ===================================================================== */
// Only pages opened from a file, localhost or 127.0.0.1 may connect (blocks other websites)
function originAllowed(origin) {
  return !origin || origin === "null" || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}
const wss = new WebSocketServer({
  port: CONFIG.wsPort,
  maxPayload: 4096,
  verifyClient: (info) => originAllowed(info.origin)
});
wss.on("listening", () => log("[ws] dashboard bridge listening on ws://localhost:" + CONFIG.wsPort));
wss.on("error", (e) => { log("[ws] error:", e.message); if (e.code === "EADDRINUSE") process.exit(1); });

function broadcast(line) {
  for (const c of wss.clients) if (c.readyState === 1) c.send(line + "\n");
}

function hbLine(id, h) {
  const ageSec = Math.max(0, Math.round((Date.now() - h.at) / 1000));
  return `HB|${id}|${h.seq}|${h.lat}|${h.lon}|${ageSec}`;
}

wss.on("connection", (ws) => {
  log("[ws] dashboard connected");
  ws.send(`BRIDGE|SERVER|${serverUp ? "UP" : "DOWN"}\n`);
  detailsCache.forEach((d, id) => ws.send(detailsLine(id) + "\n"));
  latestHb.forEach((h, id) => ws.send(hbLine(id, h) + "\n"));
  alertHistory.forEach((l) => ws.send(l + "\n"));

  ws.on("message", async (data) => {
    let msg;
    try { msg = JSON.parse(String(data)); } catch (e) { return; }
    if (!msg || msg.type !== "save_details") return;
    try {
      await saveDetails(msg.boat);
      ws.send("BRIDGE|SAVED|" + msg.boat.boat_id + "\n");
    } catch (err) {
      log("[db] save details failed:", err.message);
      ws.send("BRIDGE|ERROR|" + String(err.message).replace(/[\r\n|]/g, " ") + "\n");
    }
  });
});

function setServerState(up) {
  if (serverUp === up) return;
  serverUp = up;
  broadcast(`BRIDGE|SERVER|${up ? "UP" : "DOWN"}`);
}

/* =====================================================================
   TCP client -> C++ server (alerts)
   ===================================================================== */
let tcpBuffer = "";

function handleServerLine(raw) {
  const line = raw.trim();
  const p = line.split("|");
  if (p[0] !== "ALERT" || p.length < 4) return;       // ignore anything unexpected
  if (alertHistory.includes(line)) return;            // the server replays its history on every connect
  alertHistory.push(line);
  if (alertHistory.length > CONFIG.maxHistory) alertHistory.shift();
  log("[alert]", line);
  broadcast(line);
  saveAlert(p[1], p[2], p[3]);
}

function connectToServer() {
  const sock = net.connect(CONFIG.serverTcpPort, CONFIG.serverHost);
  sock.setEncoding("utf8");

  sock.on("connect", () => { log("[tcp] connected to C++ server"); tcpBuffer = ""; setServerState(true); });
  sock.on("data", (chunk) => {
    tcpBuffer += chunk;
    let i;
    while ((i = tcpBuffer.indexOf("\n")) >= 0) {       // messages are newline-delimited
      handleServerLine(tcpBuffer.slice(0, i));
      tcpBuffer = tcpBuffer.slice(i + 1);
    }
  });
  sock.on("error", () => { /* 'close' follows and handles the retry */ });
  sock.on("close", () => {
    if (serverUp) log("[tcp] C++ server connection lost");
    setServerState(false);
    setTimeout(connectToServer, 3000);
  });
}

/* =====================================================================
   UDP listener (copy of each heartbeat from the C++ server)
   Same field format as the boats send: HB,BOAT001,12,-0.45,34.18
   ===================================================================== */
const udp = dgram.createSocket("udp4");
udp.on("message", (msg) => {
  const f = msg.toString("utf8").trim().split(",");
  if (f.length !== 5 || (f[0] !== "HB" && f[0] !== "DISTRESS")) return;
  const [type, id, seqS, latS, lonS] = f;
  const seq = parseInt(seqS, 10), lat = parseFloat(latS), lon = parseFloat(lonS);
  if (!/^[A-Za-z0-9_-]{1,20}$/.test(id) || !Number.isFinite(seq) || !Number.isFinite(lat) || !Number.isFinite(lon)) return;

  const h = { seq, lat, lon, at: Date.now() };
  latestHb.set(id, h);
  broadcast(hbLine(id, h));
  saveHeartbeat(type, id, seq, lat, lon);
});
udp.on("error", (e) => { log("[udp] error:", e.message); });
udp.bind(CONFIG.heartbeatUdpPort, "127.0.0.1", () =>
  log("[udp] listening for heartbeat copies on 127.0.0.1:" + CONFIG.heartbeatUdpPort));

/* ---------- Start ---------- */
log("Fishing Boat Safety bridge starting");
dbLoop();
connectToServer();
