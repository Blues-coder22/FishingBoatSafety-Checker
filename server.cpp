#include <winsock2.h>
#include <windows.h>
#include <iostream>
#include <string>
#include <vector>
#include <map>
#include <sstream>
#include <ctime>
#include <cctype>
#include <cstring>

#pragma comment(lib, "ws2_32.lib")

#define UDP_PORT 5000
#define TCP_PORT 5001
#define TIMEOUT_MS 10000
#define MAX_MONITORS 20
#define MAX_HISTORY 20

struct Boat {
    int sequence;
    bool hasSequence;
    DWORD lastSeen;
    bool overdue;
    double latitude;
    double longitude;
    Boat() : sequence(-1), hasSequence(false), lastSeen(0), overdue(false),
             latitude(0.0), longitude(0.0) {}
};

std::map<std::string, Boat> boats;
std::vector<SOCKET> monitors;
std::vector<std::string> historyMessages;

// --- Dashboard bridge: a copy of every valid UDP message is sent to localhost:5002 ---
#define BRIDGE_PORT 5002
SOCKET bridgeSock = INVALID_SOCKET;
sockaddr_in bridgeAddr;

std::string nowText() {
    time_t raw = time(NULL);
    struct tm *t = localtime(&raw);
    char b[16];
    if (!t) return "unknown";
    strftime(b, sizeof(b), "%H:%M:%S", t);
    return std::string(b);
}

std::vector<std::string> split(const std::string &s, char delim) {
    std::vector<std::string> v;
    std::stringstream ss(s);
    std::string item;
    while (std::getline(ss, item, delim)) v.push_back(item);
    return v;
}

bool validId(const std::string &s) {
    unsigned int i;
    if (s.empty() || s.size() > 20) return false;
    for (i = 0; i < s.size(); ++i) {
        unsigned char c = (unsigned char)s[i];
        if (!isalnum(c) && c != '_' && c != '-') return false;
    }
    return true;
}

bool getInt(const std::string &s, int &n) {
    std::istringstream in(s);
    char extra;
    if (!(in >> n) || (in >> extra) || n < 0) return false;
    return true;
}

bool getDouble(const std::string &s, double &n) {
    std::istringstream in(s);
    char extra;
    if (!(in >> n) || (in >> extra)) return false;
    return true;
}

bool sendLine(SOCKET s, const std::string &msg) {
    int total = (int)msg.size(), sent = 0;
    while (sent < total) {
        int n = send(s, msg.c_str() + sent, total - sent, 0);
        if (n == SOCKET_ERROR || n == 0) return false;
        sent += n;
    }
    return true;
}

void removeMonitorAt(int index) {
    shutdown(monitors[index], SD_BOTH);
    closesocket(monitors[index]);
    monitors.erase(monitors.begin() + index);
}

void alert(const std::string &type, const std::string &id) {
    std::string msg = "ALERT|" + type + "|" + id + "|" + nowText() + "\n";
    std::cout << msg;
    historyMessages.push_back(msg);
    if (historyMessages.size() > MAX_HISTORY) historyMessages.erase(historyMessages.begin());

    int i = 0;
    while (i < (int)monitors.size()) {
        if (!sendLine(monitors[i], msg)) removeMonitorAt(i);
        else ++i;
    }
}

void processUdp(SOCKET udp) {
    char buf[512];
    sockaddr_in from;
    int fromLen = sizeof(from);
    int n = recvfrom(udp, buf, sizeof(buf) - 1, 0, (sockaddr *)&from, &fromLen);
    if (n == SOCKET_ERROR) return;
    buf[n] = '\0';
    std::string raw(buf);
    std::vector<std::string> f = split(raw, ',');
    if (f.size() != 5) {
        std::cout << "Ignored malformed UDP message: " << raw << "\n";
        return;
    }

    int seq;
    double lat, lon;
    if ((f[0] != "HB" && f[0] != "DISTRESS") || !validId(f[1]) ||
        !getInt(f[2], seq) || !getDouble(f[3], lat) || !getDouble(f[4], lon) ||
        lat < -90.0 || lat > 90.0 || lon < -180.0 || lon > 180.0) {
        std::cout << "Ignored invalid UDP message: " << raw << "\n";
        return;
    }

    Boat &b = boats[f[1]];
    if (b.hasSequence && seq <= b.sequence) {
        std::cout << "Ignored duplicate/out-of-order message from " << f[1] << "\n";
        return;
    }

    b.sequence = seq;
    b.hasSequence = true;
    b.lastSeen = GetTickCount();
    b.latitude = lat;
    b.longitude = lon;

    // forward a copy to the dashboard bridge (ignored if the bridge is not running)
    if (bridgeSock != INVALID_SOCKET) {
        sendto(bridgeSock, raw.c_str(), (int)raw.size(), 0,
               (sockaddr *)&bridgeAddr, sizeof(bridgeAddr));
    }

    if (f[0] == "DISTRESS") {
        std::cout << "DISTRESS received from " << f[1] << "\n";
        alert("DISTRESS", f[1]);
    } else {
        std::cout << "Heartbeat from " << f[1] << " seq=" << seq
                  << " position=(" << lat << "," << lon << ")\n";
        if (b.overdue) {
            b.overdue = false;
            alert("RECOVERED", f[1]);
        }
    }
}

int main() {
    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
        std::cout << "WSAStartup failed.\n";
        return 1;
    }

    // separate socket used only to forward heartbeats to the bridge
    bridgeSock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    memset(&bridgeAddr, 0, sizeof(bridgeAddr));
    bridgeAddr.sin_family = AF_INET;
    bridgeAddr.sin_port = htons(BRIDGE_PORT);
    bridgeAddr.sin_addr.s_addr = inet_addr("127.0.0.1");

    SOCKET udp = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    SOCKET tcp = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (udp == INVALID_SOCKET || tcp == INVALID_SOCKET) {
        std::cout << "Socket creation failed.\n";
        WSACleanup();
        return 1;
    }

    sockaddr_in udpAddr, tcpAddr;
    udpAddr.sin_family = AF_INET;
    udpAddr.sin_port = htons(UDP_PORT);
    udpAddr.sin_addr.s_addr = htonl(INADDR_ANY);
    tcpAddr.sin_family = AF_INET;
    tcpAddr.sin_port = htons(TCP_PORT);
    tcpAddr.sin_addr.s_addr = htonl(INADDR_ANY);

    if (bind(udp, (sockaddr *)&udpAddr, sizeof(udpAddr)) == SOCKET_ERROR) {
        std::cout << "UDP bind failed. Port 5000 may be in use.\n";
        closesocket(udp); closesocket(tcp); WSACleanup(); return 1;
    }
    if (bind(tcp, (sockaddr *)&tcpAddr, sizeof(tcpAddr)) == SOCKET_ERROR ||
        listen(tcp, 5) == SOCKET_ERROR) {
        std::cout << "TCP setup failed. Port 5001 may be in use.\n";
        closesocket(udp); closesocket(tcp); WSACleanup(); return 1;
    }

    std::cout << "Fishing Boat Safety Check-In and Alert Network\n";
    std::cout << "UDP port " << UDP_PORT << "; TCP port " << TCP_PORT << "\n";
    std::cout << "Heartbeat timeout: 10 seconds. Press Ctrl+C to stop.\n";

    DWORD lastCheck = GetTickCount();
    bool running = true;
    while (running) {
        fd_set reads;
        FD_ZERO(&reads);
        FD_SET(udp, &reads);
        FD_SET(tcp, &reads);
        unsigned int i;
        for (i = 0; i < monitors.size(); ++i) FD_SET(monitors[i], &reads);

        timeval waitTime;
        waitTime.tv_sec = 0;
        waitTime.tv_usec = 500000;
        int ready = select(0, &reads, NULL, NULL, &waitTime);
        if (ready == SOCKET_ERROR) {
            std::cout << "select failed: " << WSAGetLastError() << "\n";
            break;
        }

        if (FD_ISSET(udp, &reads)) processUdp(udp);

        if (FD_ISSET(tcp, &reads)) {
            sockaddr_in clientAddr;
            int clientLen = sizeof(clientAddr);
            SOCKET client = accept(tcp, (sockaddr *)&clientAddr, &clientLen);
            if (client != INVALID_SOCKET) {
                if (monitors.size() >= MAX_MONITORS) {
                    sendLine(client, "SERVER|BUSY\n");
                    closesocket(client);
                } else {
                    unsigned int h;
                    for (h = 0; h < historyMessages.size(); ++h) {
                        if (!sendLine(client, historyMessages[h])) break;
                    }
                    monitors.push_back(client);
                    std::cout << "TCP monitor connected.\n";
                }
            }
        }

        i = 0;
        while (i < monitors.size()) {
            if (FD_ISSET(monitors[i], &reads)) {
                char discard[32];
                int n = recv(monitors[i], discard, sizeof(discard), 0);
                if (n <= 0) {
                    std::cout << "TCP monitor disconnected.\n";
                    removeMonitorAt((int)i);
                    continue;
                }
            }
            ++i;
        }

        DWORD now = GetTickCount();
        if ((DWORD)(now - lastCheck) >= 500) {
            lastCheck = now;
            std::map<std::string, Boat>::iterator it;
            for (it = boats.begin(); it != boats.end(); ++it) {
                Boat &b = it->second;
                if (b.hasSequence && !b.overdue &&
                    (DWORD)(now - b.lastSeen) > TIMEOUT_MS) {
                    b.overdue = true;
                    alert("OVERDUE", it->first);
                }
            }
        }
    }

    for (unsigned int j = 0; j < monitors.size(); ++j) {
        shutdown(monitors[j], SD_BOTH);
        closesocket(monitors[j]);
    }
    if (bridgeSock != INVALID_SOCKET) closesocket(bridgeSock);
    closesocket(udp);
    closesocket(tcp);
    WSACleanup();
    return 0;
}
