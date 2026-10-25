/* =====================================================================
   Fishing Boat Safety Dashboard - app.js

   Everything goes through ONE function: handleLine(line).
   Lines use the same text format as your C++ server:

     ALERT|OVERDUE|BOAT001|10:42:15      (sent by your server today)
     ALERT|DISTRESS|BOAT002|10:43:02
     ALERT|RECOVERED|BOAT001|10:44:30
     HB|BOAT001|12|-0.45|34.18           (optional: lets cards show position)

   Demo mode generates these lines itself.
   Live mode receives them from a WebSocket bridge (added in a later step).
   ===================================================================== */

const CONFIG = {
  wsUrl: "ws://localhost:8080",   // address of the bridge (Step 3)
  heartbeatMs: 3000,              // boats send a heartbeat every 3 s
  timeoutMs: 10000,               // server marks a boat OVERDUE after 10 s
  maxFeed: 50                     // alerts kept on screen
};

/* ---------- State ---------- */
const boats = new Map();   // id -> { id, seq, lat, lon, lastSeen, overdue, distress, lastAlert }
let mode = "demo";
let ws = null;
let reconnectTimer = null;
let bridgeOnline = false;        // true only while the WebSocket to the bridge is open
const STORE_KEY = "fbs_registered_boats_v1";

/* ---------- DOM ---------- */
const $ = (id) => document.getElementById(id);
const els = {
  grid: $("boatGrid"), boatsEmpty: $("boatsEmpty"),
  feed: $("feed"), feedEmpty: $("feedEmpty"),
  total: $("statTotal"), active: $("statActive"),
  overdue: $("statOverdue"), distress: $("statDistress"),
  dot: $("connDot"), connText: $("connText"), clock: $("clock"),
  modeDemo: $("modeDemo"), modeLive: $("modeLive"),
  boatsHint: $("boatsHint")
};

/* ---------- Helpers ---------- */
function clockText(d = new Date()) {
  return d.toLocaleTimeString("en-GB", { hour12: false });
}

function getBoat(id) {
  if (!boats.has(id)) {
    boats.set(id, {
      id, seq: null, lat: null, lon: null,
      lastSeen: null, overdue: false, distress: false, lastAlert: null, details: null
    });
  }
  return boats.get(id);
}

function statusOf(b) {
  if (mode === "live" && !bridgeOnline) return "offline";   // data is out of date
  if (b.distress) return "distress";
  if (b.overdue) return "overdue";
  if (b.lastSeen == null) return "nodata";   // registered, but no heartbeat received yet
  return "active";
}

function agoText(ms) {
  if (ms == null) return "No heartbeat data";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return s + " s ago";
  return Math.floor(s / 60) + " min " + (s % 60) + " s ago";
}

/* ---------- Message handling (the heart of the dashboard) ---------- */
function handleLine(raw) {
  const line = String(raw).trim();
  if (!line) return;

  // DETAILS|BOAT001|{json}  - boat registration details (JSON may contain "|")
  if (line.startsWith("DETAILS|")) {
    const rest = line.slice(8);
    const cut = rest.indexOf("|");
    if (cut > 0) {
      try { getBoat(rest.slice(0, cut)).details = JSON.parse(rest.slice(cut + 1)); }
      catch (e) { return; }
      if (mode === "live") saveCache();
      render();
    }
    return;
  }

  const p = line.split("|");

  if (p[0] === "BRIDGE" && p[1] === "SAVED") { formDone(true, "Saved to database."); return; }
  if (p[0] === "BRIDGE" && p[1] === "ERROR") { formDone(false, p.slice(2).join("|") || "Could not save."); return; }

  if (p[0] === "ALERT" && p.length >= 4) {
    const type = p[1], id = p[2], time = p[3];
    const b = getBoat(id);
    b.lastAlert = type + " at " + time;
    if (type === "OVERDUE") b.overdue = true;
    if (type === "DISTRESS") b.distress = true;
    if (type === "RECOVERED") { b.overdue = false; b.lastSeen = Date.now(); }
    addFeed(type, id, time);
  } else if (p[0] === "HB" && p.length >= 5) {
    const b = getBoat(p[1]);
    b.seq = parseInt(p[2], 10);
    b.lat = parseFloat(p[3]);
    b.lon = parseFloat(p[4]);
    // optional 6th field = how many seconds old this heartbeat already is (bridge replay)
    const age = p.length >= 6 ? parseFloat(p[5]) : 0;
    b.lastSeen = Date.now() - (isFinite(age) ? age * 1000 : 0);
  } else if (p[0] === "BRIDGE" && p[1] === "SERVER") {
    if (mode === "live") {
      if (p[2] === "UP") setConn("on", "Live - C++ server connected");
      else setConn("wait", "Bridge OK - C++ server not running");
    }
    return;
  } else if (p[0] === "SERVER" && p[1] === "BUSY") {
    addFeed("INFO", "Server busy (too many monitors)", clockText());
  } else {
    return; // ignore anything we do not understand
  }
  render();
}

/* ---------- Rendering ---------- */
function addFeed(type, who, time) {
  const li = document.createElement("li");

  const badge = document.createElement("span");
  badge.className = "badge " + type;
  badge.textContent = type;

  const name = document.createElement("span");
  name.className = "who";
  name.textContent = who;

  const when = document.createElement("span");
  when.className = "when";
  when.textContent = time;

  li.append(badge, name, when);
  els.feed.prepend(li);
  while (els.feed.children.length > CONFIG.maxFeed) els.feed.lastChild.remove();
}

function row(label, value) {
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = value;
  return [dt, dd];
}

function makeButton(text, action, id, extra) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn" + (extra ? " " + extra : "");
  b.textContent = text;
  b.dataset.action = action;
  b.dataset.id = id;
  return b;
}

function render() {
  const list = Array.from(boats.values()).sort((a, b) => a.id.localeCompare(b.id));
  els.grid.replaceChildren();

  list.forEach((b) => {
    const st = statusOf(b);

    const card = document.createElement("article");
    card.className = "boat-card " + st;

    const top = document.createElement("div");
    top.className = "boat-top";
    const id = document.createElement("div");
    const d = b.details || {};
    const title = document.createElement("span");
    title.className = "boat-id";
    title.textContent = d.boat_name || b.id;
    id.append(title);
    if (d.boat_name || d.registration_no) {
      const sub = document.createElement("span");
      sub.className = "boat-sub";
      sub.textContent = [d.boat_name ? b.id : "", d.registration_no].filter(Boolean).join(" \u00b7 ");
      id.append(sub);
    }
    const pill = document.createElement("span");
    pill.className = "pill " + st;
    pill.textContent = st.toUpperCase();
    top.append(id, pill);

    const meta = document.createElement("dl");
    meta.className = "boat-meta";
    meta.append(
      ...row("Last heartbeat", agoText(b.lastSeen)),
      ...row("Position", b.lat == null ? "Unknown" : b.lat.toFixed(3) + ", " + b.lon.toFixed(3)),
      ...row("Sequence", b.seq == null ? "-" : "#" + b.seq),
      ...row("Last alert", b.lastAlert || "None")
    );

    card.append(top, meta);

    if (b.details) {
      const dl = document.createElement("dl");
      dl.className = "boat-meta boat-details";
      const add = (label, v) => { if (v !== null && v !== undefined && v !== "") dl.append(...row(label, String(v))); };
      add("Captain", d.captain);
      add("Owner", d.owner);
      add("Phone", d.phone);
      add("Crew", d.crew_count);
      add("Landing site", d.landing_site);
      if (dl.children.length) card.append(dl);
    }

    const actions = document.createElement("div");
    actions.className = "boat-actions";
    if (st !== "offline") {
      if (b.distress) actions.append(makeButton("Acknowledge distress", "ack", b.id, "solid"));
      actions.append(makeButton(b.details ? "Edit details" : "Add details", "edit", b.id));
    }
    if (mode === "demo") {
      const s = sim.boats.get(b.id);
      if (s) {
        actions.append(
          s.stopped ? makeButton("Resume", "resume", b.id)
                    : makeButton("Stop heartbeats", "stop", b.id),
          makeButton("Send distress", "distress", b.id, "danger")
        );
      }
    }
    if (actions.children.length) card.append(actions);

    els.grid.append(card);
  });

  const counts = { active: 0, overdue: 0, distress: 0, nodata: 0, offline: 0 };
  list.forEach((b) => counts[statusOf(b)]++);
  const stale = mode === "live" && !bridgeOnline;
  els.total.textContent = list.length;
  els.active.textContent = stale ? "-" : counts.active;
  els.overdue.textContent = stale ? "-" : counts.overdue;
  els.distress.textContent = stale ? "-" : counts.distress;

  els.boatsHint.textContent = stale
    ? "Bridge offline - boat details shown from this browser, status unknown"
    : mode === "live" ? "Showing data from your C++ server" : "Heartbeat every 3 s \u00b7 overdue after 10 s";
  els.boatsHint.classList.toggle("stale", stale);

  els.boatsEmpty.style.display = list.length ? "none" : "block";
  els.feedEmpty.style.display = els.feed.children.length ? "none" : "block";
}

/* Button clicks on boat cards (one listener for all buttons) */
els.grid.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const { action, id } = btn.dataset;
  if (action === "ack") { getBoat(id).distress = false; render(); }
  else if (action === "edit") openForm(id);
  else if (mode === "demo") sim.command(action, id);
});

$("clearFeed").addEventListener("click", () => { els.feed.replaceChildren(); render(); });

/* Remember registered boats in this browser so they still show when the bridge is offline.
   The database stays the real source: the bridge sends fresh details every time it connects. */
function saveCache() {
  try {
    const o = {};
    boats.forEach((b, id) => { if (b.details) o[id] = b.details; });
    localStorage.setItem(STORE_KEY, JSON.stringify(o));
  } catch (e) { /* storage blocked: fine */ }
}

function loadCache() {
  try {
    const o = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    Object.keys(o).forEach((id) => { if (/^[A-Za-z0-9_-]{1,20}$/.test(id)) getBoat(id).details = o[id]; });
  } catch (e) { /* ignore */ }
}

/* =====================================================================
   BOAT DETAILS FORM  (saves to MySQL through the bridge in Live mode)
   ===================================================================== */
const form = {
  dlg: $("detailsDialog"), f: $("detailsForm"), msg: $("formMsg"),
  title: $("formTitle"), save: $("formSave")
};
const FIELDS = ["boat_id", "boat_name", "registration_no", "captain", "owner", "phone", "crew_count", "landing_site"];

function openForm(id) {
  const b = id ? getBoat(id) : null;
  const d = (b && b.details) || {};
  form.f.reset();
  form.msg.textContent = "";
  form.msg.className = "form-msg";
  form.f.elements.boat_id.value = id || "";
  form.f.elements.boat_id.readOnly = !!id;
  FIELDS.slice(1).forEach((k) => { form.f.elements[k].value = d[k] == null ? "" : d[k]; });
  form.title.textContent = id ? "Boat details - " + id : "Register a boat";
  form.save.disabled = false;
  form.dlg.showModal();
}

function formDone(ok, text) {
  form.msg.textContent = text;
  form.msg.className = "form-msg " + (ok ? "ok" : "bad");
  form.save.disabled = false;
  if (ok) setTimeout(() => { if (form.dlg.open) form.dlg.close(); }, 700);
}

form.f.addEventListener("submit", (e) => {
  e.preventDefault();
  const v = {};
  FIELDS.forEach((k) => { v[k] = form.f.elements[k].value.trim(); });

  if (!/^[A-Za-z0-9_-]{1,20}$/.test(v.boat_id)) return formDone(false, "Boat ID: 1-20 letters, digits, - or _ (no spaces).");
  if (v.phone && !/^[0-9+()\- ]{1,20}$/.test(v.phone)) return formDone(false, "Phone: digits, spaces, + ( ) - only.");
  if (v.crew_count !== "" && !/^\d{1,2}$/.test(v.crew_count)) return formDone(false, "Crew count must be a whole number 0-99.");

  form.save.disabled = true;
  form.msg.textContent = "Saving...";
  form.msg.className = "form-msg";

  if (mode === "live") {
    if (!ws || ws.readyState !== 1) return formDone(false, "Not connected to the bridge.");
    ws.send(JSON.stringify({ type: "save_details", boat: v }));        // bridge answers SAVED / ERROR
  } else {
    // demo mode: keep in the browser only
    const d = Object.assign({}, v); delete d.boat_id;
    d.crew_count = v.crew_count === "" ? null : parseInt(v.crew_count, 10);
    handleLine("DETAILS|" + v.boat_id + "|" + JSON.stringify(d));
    formDone(true, "Saved (demo mode - not stored in the database).");
  }
});

$("formCancel").addEventListener("click", () => form.dlg.close());
$("registerBtn").addEventListener("click", () => openForm(null));

/* ---------- Connection status ---------- */
function setConn(kind, text) {
  els.dot.className = "dot " + kind;
  els.connText.textContent = text;
}

/* =====================================================================
   DEMO MODE - pretends to be the C++ server + boat clients
   ===================================================================== */
const sim = {
  boats: new Map(),
  hbTimer: null,
  watchTimer: null,

  start() {
    ["BOAT001", "BOAT002", "BOAT003"].forEach((id, i) => {
      this.boats.set(id, {
        seq: 0, stopped: false, overdueSent: false,
        lat: -0.45 + i * 0.07, lon: 34.18 + i * 0.05, lastHb: Date.now()
      });
    });
    handleLine('DETAILS|BOAT001|{"boat_name":"Samaki Mzuri","registration_no":"KSM-2041","captain":"Otieno Odhiambo","owner":"Odhiambo Fishers","phone":"0712 345 678","crew_count":4,"landing_site":"Kisumu Beach"}');
    handleLine('DETAILS|BOAT002|{"boat_name":"Jaber","registration_no":"KSM-2077","captain":"Achieng Adhiambo","owner":"Lakeside Co-op","phone":"0723 456 789","crew_count":3,"landing_site":"Dunga"}');
    this.hbTimer = setInterval(() => this.heartbeats(), CONFIG.heartbeatMs);
    this.watchTimer = setInterval(() => this.watchdog(), 500);
    this.heartbeats();
  },

  stop() {
    clearInterval(this.hbTimer);
    clearInterval(this.watchTimer);
    this.boats.clear();
  },

  heartbeats() {
    this.boats.forEach((s, id) => {
      if (s.stopped) return;
      s.seq++;
      s.lat += (Math.random() - 0.5) * 0.004;
      s.lon += (Math.random() - 0.5) * 0.004;
      s.lastHb = Date.now();
      handleLine(`HB|${id}|${s.seq}|${s.lat.toFixed(4)}|${s.lon.toFixed(4)}`);
      if (s.overdueSent) {
        s.overdueSent = false;
        handleLine(`ALERT|RECOVERED|${id}|${clockText()}`);
      }
    });
  },

  // same rule as the C++ server: overdue after 10 s of silence, alert only once
  watchdog() {
    const now = Date.now();
    this.boats.forEach((s, id) => {
      if (!s.overdueSent && now - s.lastHb > CONFIG.timeoutMs) {
        s.overdueSent = true;
        handleLine(`ALERT|OVERDUE|${id}|${clockText()}`);
      }
    });
  },

  command(action, id) {
    const s = this.boats.get(id);
    if (!s) return;
    if (action === "stop") s.stopped = true;
    if (action === "resume") { s.stopped = false; this.heartbeats(); }
    if (action === "distress") {
      s.seq++;
      handleLine(`ALERT|DISTRESS|${id}|${clockText()}`);
    }
    render();
  }
};

/* =====================================================================
   LIVE MODE - WebSocket bridge to the C++ server (built in Step 3)
   ===================================================================== */
function connectLive() {
  clearTimeout(reconnectTimer);
  setConn("wait", "Connecting to " + CONFIG.wsUrl + " ...");
  try {
    ws = new WebSocket(CONFIG.wsUrl);
  } catch (err) {
    setConn("off", "Bridge unavailable");
    return;
  }
  ws.onopen = () => {
    boats.clear();                       // the bridge now resends everything that is current
    els.feed.replaceChildren();
    bridgeOnline = true;
    setConn("on", "Live - connected to bridge");
    render();
  };
  ws.onmessage = (ev) => String(ev.data).split("\n").forEach(handleLine);
  ws.onclose = () => {
    if (mode !== "live") return;
    bridgeOnline = false;
    setConn("off", "Bridge offline - retrying in 3 s");
    render();
    reconnectTimer = setTimeout(connectLive, 3000);
  };
  ws.onerror = () => { try { ws.close(); } catch (e) { /* ignore */ } };
}

function disconnectLive() {
  clearTimeout(reconnectTimer);
  if (ws) { ws.onclose = null; try { ws.close(); } catch (e) { /* ignore */ } ws = null; }
}

/* ---------- Mode switching ---------- */
function setMode(next) {
  mode = next;
  boats.clear();
  els.feed.replaceChildren();
  disconnectLive();
  sim.stop();
  bridgeOnline = false;
  if (next === "live") loadCache();

  els.modeDemo.classList.toggle("active", next === "demo");
  els.modeLive.classList.toggle("active", next === "live");

  if (next === "demo") {
    setConn("on", "Demo mode - simulated boats");
    els.boatsHint.textContent = "Heartbeat every 3 s · overdue after 10 s";
    sim.start();
  } else {
    els.boatsHint.textContent = "Showing data from your C++ server";
    connectLive();
  }
  render();
}

els.modeDemo.addEventListener("click", () => setMode("demo"));
els.modeLive.addEventListener("click", () => setMode("live"));

/* ---------- Clock + refresh "x s ago" every second ---------- */
setInterval(() => {
  els.clock.textContent = clockText();
  render();
}, 1000);

setMode("demo");
