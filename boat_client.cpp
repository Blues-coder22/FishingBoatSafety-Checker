#include <winsock2.h>
#include <windows.h>
#include <conio.h>
#include <iostream>
#include <string>
#include <sstream>

#pragma comment(lib, "ws2_32.lib")

#define SERVER_IP "127.0.0.1"
#define UDP_PORT 5000

bool validId(const std::string &s) {
    unsigned int i;
    if (s.empty() || s.size() > 20) return false;
    for (i = 0; i < s.size(); ++i) {
        char c = s[i];
        if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
              (c >= '0' && c <= '9') || c == '_' || c == '-')) return false;
    }
    return true;
}

int main() {
    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
        std::cout << "WSAStartup failed.\n"; return 1;
    }

    std::string boatId;
    std::cout << "Enter boat ID (example BOAT001): ";
    std::cin >> boatId;
    if (!validId(boatId)) {
        std::cout << "Invalid ID. Use letters, numbers, _ or - (max 20 characters).\n";
        WSACleanup(); return 1;
    }

    SOCKET s = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (s == INVALID_SOCKET) {
        std::cout << "Could not create UDP socket.\n"; WSACleanup(); return 1;
    }

    sockaddr_in server;
    server.sin_family = AF_INET;
    server.sin_port = htons(UDP_PORT);
    server.sin_addr.s_addr = inet_addr(SERVER_IP);

    int sequence = 0;
    bool sending = true;
    DWORD lastHeartbeat = 0;

    std::cout << "\nBoat client running; coordinates are simulated.\n";
    std::cout << "Press: S=stop heartbeats, R=resume, D=distress, Q=quit\n";

    bool running = true;
    while (running) {
        DWORD now = GetTickCount();
        if (sending && (lastHeartbeat == 0 || (DWORD)(now - lastHeartbeat) >= 3000)) {
            ++sequence;
            std::ostringstream msg;
            msg << "HB," << boatId << "," << sequence << ",-0.45,34.18";
            std::string data = msg.str();
            sendto(s, data.c_str(), (int)data.size(), 0, (sockaddr *)&server, sizeof(server));
            std::cout << "Sent: " << data << "\n";
            lastHeartbeat = now;
        }

        if (_kbhit()) {
            int key = _getch();
            if (key == 's' || key == 'S') {
                sending = false;
                std::cout << "Heartbeats stopped. Wait over 10 seconds to trigger OVERDUE.\n";
            } else if (key == 'r' || key == 'R') {
                sending = true;
                lastHeartbeat = 0;
                std::cout << "Heartbeats resumed.\n";
            } else if (key == 'd' || key == 'D') {
                ++sequence;
                std::ostringstream msg;
                msg << "DISTRESS," << boatId << "," << sequence << ",-0.45,34.18";
                std::string data = msg.str();
                sendto(s, data.c_str(), (int)data.size(), 0, (sockaddr *)&server, sizeof(server));
                std::cout << "Sent: " << data << "\n";
            } else if (key == 'q' || key == 'Q') {
                running = false;
            }
        }
        Sleep(50);
    }

    closesocket(s);
    WSACleanup();
    std::cout << "Boat client stopped.\n";
    return 0;
}
