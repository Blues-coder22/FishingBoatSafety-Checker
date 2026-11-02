
#include <winsock2.h>
#include <windows.h>
#include <iostream>
#include <string>
#include <vector>
#include <map>
#include <sstream>
#include <cctype>
#include <cstring>
#include <stdio.h>

#pragma comment(lib, "ws2_32.lib")

#define UDP_PORT 5000
#define TCP_PORT 5001
#define BRIDGE_PORT 5002
#define TIMEOUT_MS 10000
#define APP_MAX_MONITORS 20
#define MAX_HISTORY 20

// Structure for storing each boat's information
struct Boat {
    int sequence;
    bool hasSequence;
    DWORD lastSeen;
    bool overdue;
    double latitude;
    double longitude;

    Boat() {
        sequence = -1;
        hasSequence = false;
        lastSeen = 0;
        overdue = false;
        latitude = 0.0;
        longitude = 0.0;
    }
};

// Shared server data
std::map<std::string, Boat> boats;
std::vector<SOCKET> monitors;
std::vector<std::string> historyMessages;

CRITICAL_SECTION dataLock;

SOCKET bridgeSock = INVALID_SOCKET;
sockaddr_in bridgeAddr;

// Get current time
std::string nowText() {
    SYSTEMTIME t;
    GetLocalTime(&t);

    char b[16];

    sprintf(b, "%02d:%02d:%02d",
        (int)t.wHour,
        (int)t.wMinute,
        (int)t.wSecond);

    return std::string(b);
}

// Split incoming messages
std::vector<std::string> split(
    const std::string &s, char delim) {

    std::vector<std::string> v;
    std::stringstream ss(s);
    std::string item;

    while (std::getline(ss, item, delim)) {
        v.push_back(item);
    }

    return v;
}

// Validate boat ID
bool validId(const std::string &s) {

    if (s.empty() || s.size() > 20) {
        return false;
    }

    for (unsigned int i = 0; i < s.size(); i++) {

        unsigned char c = (unsigned char)s[i];

        if (!isalnum(c) && c != '_' && c != '-') {
            return false;
        }
    }

    return true;
}

// Convert string to integer
bool getInt(const std::string &s, int &n) {

    std::istringstream in(s);
    char extra;

    if (!(in >> n) || (in >> extra) || n < 0) {
        return false;
    }

    return true;
}

// Convert string to double
bool getDouble(const std::string &s, double &n) {

    std::istringstream in(s);
    char extra;

    if (!(in >> n) || (in >> extra)) {
        return false;
    }

    return true;
}

// Send a complete TCP message
bool sendLine(SOCKET s, const std::string &msg) {

    int total = (int)msg.size();
    int sent = 0;

    while (sent < total) {

        int n = send(
            s,
            msg.c_str() + sent,
            total - sent,
            0
        );

        if (n == SOCKET_ERROR || n == 0) {
            return false;
        }

        sent += n;
    }

    return true;
}

// Remove disconnected monitoring client
void removeMonitor(SOCKET s) {

    EnterCriticalSection(&dataLock);

    for (unsigned int i = 0; i < monitors.size(); i++) {

        if (monitors[i] == s) {

            monitors.erase(monitors.begin() + i);
            break;
        }
    }

    LeaveCriticalSection(&dataLock);

    shutdown(s, SD_BOTH);
    closesocket(s);
}

// Generate and broadcast an alert
void alert(
    const std::string &type,
    const std::string &id) {

    std::string msg =
        "ALERT|" + type + "|" + id + "|" +
        nowText() + "\n";

    std::cout << msg;

    EnterCriticalSection(&dataLock);

    // Store alert history
    historyMessages.push_back(msg);

    if (historyMessages.size() > MAX_HISTORY) {
        historyMessages.erase(historyMessages.begin());
    }

    // Broadcast to connected monitoring clients
    unsigned int i = 0;

    while (i < monitors.size()) {

        if (!sendLine(monitors[i], msg)) {

            SOCKET dead = monitors[i];

            monitors.erase(monitors.begin() + i);

            shutdown(dead, SD_BOTH);
            closesocket(dead);

        } else {
            i++;
        }
    }

    LeaveCriticalSection(&dataLock);
}

// Process incoming UDP messages
void processUdp(SOCKET udp) {

    char buf[512];

    sockaddr_in from;
    int fromLen = sizeof(from);

    int n = recvfrom(
        udp,
        buf,
        sizeof(buf) - 1,
        0,
        (sockaddr *)&from,
        &fromLen
    );

    if (n == SOCKET_ERROR) {
        return;
    }

    buf[n] = '\0';

    std::string raw(buf);

    std::vector<std::string> f = split(raw, ',');

    if (f.size() != 5) {

        std::cout << "Ignored malformed UDP message: "
                  << raw << "\n";

        return;
    }

    int seq;
    double lat, lon;

    if ((f[0] != "HB" && f[0] != "DISTRESS") ||
        !validId(f[1]) ||
        !getInt(f[2], seq) ||
        !getDouble(f[3], lat) ||
        !getDouble(f[4], lon) ||
        lat < -90.0 || lat > 90.0 ||
        lon < -180.0 || lon > 180.0) {

        std::cout << "Ignored invalid UDP message: "
                  << raw << "\n";

        return;
    }

    bool recovered = false;

    EnterCriticalSection(&dataLock);

    Boat &b = boats[f[1]];

    // Reject duplicate or old sequence numbers
    if (b.hasSequence && seq <= b.sequence) {

        LeaveCriticalSection(&dataLock);

        std::cout << "Ignored duplicate/out-of-order message from "
                  << f[1] << "\n";

        return;
    }

    b.sequence = seq;
    b.hasSequence = true;
    b.lastSeen = GetTickCount();
    b.latitude = lat;
    b.longitude = lon;

    // Check whether boat has recovered
    if (f[0] == "HB" && b.overdue) {

        b.overdue = false;
        recovered = true;
    }

    LeaveCriticalSection(&dataLock);

    // Forward valid messages to Node.js bridge
    if (bridgeSock != INVALID_SOCKET) {

        sendto(
            bridgeSock,
            raw.c_str(),
            (int)raw.size(),
            0,
            (sockaddr *)&bridgeAddr,
            sizeof(bridgeAddr)
        );
    }

    // Handle distress messages
    if (f[0] == "DISTRESS") {

        std::cout << "DISTRESS received from "
                  << f[1] << "\n";

        alert("DISTRESS", f[1]);

    } else {

        std::cout << "Heartbeat from "
                  << f[1]
                  << " seq=" << seq
                  << " position=(" << lat
                  << "," << lon << ")\n";

        if (recovered) {
            alert("RECOVERED", f[1]);
        }
    }
}

// THREAD 1: UDP receiver
DWORD WINAPI udpReceiverThread(LPVOID parameter) {

    SOCKET udp = (SOCKET)(UINT_PTR)parameter;

    while (true) {
        processUdp(udp);
    }

    return 0;
}

// THREAD 2: Individual TCP monitor client handler
DWORD WINAPI monitorClientThread(LPVOID parameter) {

    SOCKET client = (SOCKET)(UINT_PTR)parameter;

    char buffer[128];

    while (true) {

        int n = recv(
            client,
            buffer,
            sizeof(buffer),
            0
        );

        if (n <= 0) {
            break;
        }
    }

    std::cout << "TCP monitor disconnected.\n";

    removeMonitor(client);

    return 0;
}

// THREAD 3: TCP connection acceptor
DWORD WINAPI tcpAcceptThread(LPVOID parameter) {

    SOCKET tcp = (SOCKET)(UINT_PTR)parameter;

    while (true) {

        sockaddr_in clientAddr;
        int clientLen = sizeof(clientAddr);

        SOCKET client = accept(
            tcp,
            (sockaddr *)&clientAddr,
            &clientLen
        );

        if (client == INVALID_SOCKET) {
            continue;
        }

        EnterCriticalSection(&dataLock);

        // Check maximum number of monitoring clients
        if (monitors.size() >= APP_MAX_MONITORS) {

            LeaveCriticalSection(&dataLock);

            sendLine(client, "SERVER|BUSY\n");

            closesocket(client);

            continue;
        }

        monitors.push_back(client);

        // Send previous alert history to new client
        unsigned int h;
        bool historyOk = true;

        for (h = 0; h < historyMessages.size(); h++) {

            if (!sendLine(client, historyMessages[h])) {

                historyOk = false;
                break;
            }
        }

        LeaveCriticalSection(&dataLock);

        if (!historyOk) {

            removeMonitor(client);

            continue;
        }

        std::cout << "TCP monitor connected.\n";

        // Create a separate thread for this monitor
        HANDLE threadHandle = CreateThread(
            NULL,
            0,
            monitorClientThread,
            (LPVOID)(UINT_PTR)client,
            0,
            NULL
        );

        if (threadHandle == NULL) {

            std::cout << "Could not create monitor client thread.\n";

            removeMonitor(client);

        } else {

            CloseHandle(threadHandle);
        }
    }

    return 0;
}

// THREAD 4: Monitor overdue boats
DWORD WINAPI overdueMonitorThread(LPVOID) {

    while (true) {

        Sleep(500);

        DWORD now = GetTickCount();

        std::vector<std::string> newlyOverdue;

        EnterCriticalSection(&dataLock);

        std::map<std::string, Boat>::iterator it;

        for (it = boats.begin(); it != boats.end(); it++) {

            Boat &b = it->second;

            if (b.hasSequence &&
                !b.overdue &&
                (DWORD)(now - b.lastSeen) > TIMEOUT_MS) {

                b.overdue = true;

                newlyOverdue.push_back(it->first);
            }
        }

        LeaveCriticalSection(&dataLock);

        // Generate overdue alerts outside the lock
        for (unsigned int i = 0; i < newlyOverdue.size(); i++) {

            alert("OVERDUE", newlyOverdue[i]);
        }
    }

    return 0;
}

// MAIN SERVER
int main() {

    InitializeCriticalSection(&dataLock);

    WSADATA wsa;

    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {

        std::cout << "WSAStartup failed.\n";

        DeleteCriticalSection(&dataLock);

        return 1;
    }

    // Create UDP socket for bridge communication
    bridgeSock = socket(
        AF_INET,
        SOCK_DGRAM,
        IPPROTO_UDP
    );

    memset(&bridgeAddr, 0, sizeof(bridgeAddr));

    bridgeAddr.sin_family = AF_INET;
    bridgeAddr.sin_port = htons(BRIDGE_PORT);
    bridgeAddr.sin_addr.s_addr = inet_addr("127.0.0.1");

    // Create UDP and TCP server sockets
    SOCKET udp = socket(
        AF_INET,
        SOCK_DGRAM,
        IPPROTO_UDP
    );

    SOCKET tcp = socket(
        AF_INET,
        SOCK_STREAM,
        IPPROTO_TCP
    );

    if (udp == INVALID_SOCKET || tcp == INVALID_SOCKET) {

        std::cout << "Socket creation failed.\n";

        if (udp != INVALID_SOCKET) closesocket(udp);
        if (tcp != INVALID_SOCKET) closesocket(tcp);

        if (bridgeSock != INVALID_SOCKET) {
            closesocket(bridgeSock);
        }

        WSACleanup();

        DeleteCriticalSection(&dataLock);

        return 1;
    }

    sockaddr_in udpAddr;
    sockaddr_in tcpAddr;

    memset(&udpAddr, 0, sizeof(udpAddr));
    memset(&tcpAddr, 0, sizeof(tcpAddr));

    udpAddr.sin_family = AF_INET;
    udpAddr.sin_port = htons(UDP_PORT);
    udpAddr.sin_addr.s_addr = htonl(INADDR_ANY);

    tcpAddr.sin_family = AF_INET;
    tcpAddr.sin_port = htons(TCP_PORT);
    tcpAddr.sin_addr.s_addr = htonl(INADDR_ANY);

    // Bind UDP socket
    if (bind(
        udp,
        (sockaddr *)&udpAddr,
        sizeof(udpAddr)
    ) == SOCKET_ERROR) {

        std::cout << "UDP bind failed. Port 5000 may be in use.\n";

        closesocket(udp);
        closesocket(tcp);

        if (bridgeSock != INVALID_SOCKET) {
            closesocket(bridgeSock);
        }

        WSACleanup();
        DeleteCriticalSection(&dataLock);

        return 1;
    }

    // Bind and listen on TCP socket
    if (bind(
        tcp,
        (sockaddr *)&tcpAddr,
        sizeof(tcpAddr)
    ) == SOCKET_ERROR || listen(tcp, 20) == SOCKET_ERROR) {

        std::cout << "TCP setup failed. Port 5001 may be in use.\n";

        closesocket(udp);
        closesocket(tcp);

        if (bridgeSock != INVALID_SOCKET) {
            closesocket(bridgeSock);
        }

        WSACleanup();
        DeleteCriticalSection(&dataLock);

        return 1;
    }

    std::cout << "\n========================================\n";
    std::cout << " FISHING BOAT SAFETY NETWORK SERVER\n";
    std::cout << " MULTITHREADED VERSION\n";
    std::cout << "========================================\n";

    std::cout << "UDP port: " << UDP_PORT << "\n";
    std::cout << "TCP port: " << TCP_PORT << "\n";
    std::cout << "Bridge UDP port: " << BRIDGE_PORT << "\n";

    std::cout << "Heartbeat timeout: 10 seconds\n";
    std::cout << "Maximum monitors: " << APP_MAX_MONITORS << "\n";

    std::cout << "\nServer threads:\n";
    std::cout << "1. UDP receiver thread\n";
    std::cout << "2. TCP acceptor thread\n";
    std::cout << "3. Individual monitor client threads\n";
    std::cout << "4. Overdue monitoring thread\n";

    std::cout << "\nServer is running...\n";
    std::cout << "Press Ctrl+C to stop.\n\n";

    // Create UDP receiver thread
    HANDLE udpThread = CreateThread(
        NULL,
        0,
        udpReceiverThread,
        (LPVOID)(UINT_PTR)udp,
        0,
        NULL
    );

    // Create TCP acceptor thread
    HANDLE acceptThread = CreateThread(
        NULL,
        0,
        tcpAcceptThread,
        (LPVOID)(UINT_PTR)tcp,
        0,
        NULL
    );

    // Create overdue monitoring thread
    HANDLE overdueThread = CreateThread(
        NULL,
        0,
        overdueMonitorThread,
        NULL,
        0,
        NULL
    );

    if (udpThread == NULL ||
        acceptThread == NULL ||
        overdueThread == NULL) {

        std::cout << "Failed to create one or more server threads.\n";

        closesocket(udp);
        closesocket(tcp);

        if (udpThread != NULL) CloseHandle(udpThread);
        if (acceptThread != NULL) CloseHandle(acceptThread);
        if (overdueThread != NULL) CloseHandle(overdueThread);

        if (bridgeSock != INVALID_SOCKET) {
            closesocket(bridgeSock);
        }

        WSACleanup();
        DeleteCriticalSection(&dataLock);

        return 1;
    }

    // Keep the main server running
    WaitForSingleObject(udpThread, INFINITE);
    WaitForSingleObject(acceptThread, INFINITE);
    WaitForSingleObject(overdueThread, INFINITE);

    CloseHandle(udpThread);
    CloseHandle(acceptThread);
    CloseHandle(overdueThread);

    closesocket(udp);
    closesocket(tcp);

    if (bridgeSock != INVALID_SOCKET) {
        closesocket(bridgeSock);
    }

    WSACleanup();

    DeleteCriticalSection(&dataLock);

    return 0;
}
