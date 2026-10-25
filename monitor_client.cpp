#include <winsock2.h>
#include <windows.h>
#include <iostream>
#include <string>

#pragma comment(lib, "ws2_32.lib")

#define SERVER_IP "127.0.0.1"
#define TCP_PORT 5001

int main() {
    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
        std::cout << "WSAStartup failed.\n"; return 1;
    }

    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s == INVALID_SOCKET) {
        std::cout << "Could not create TCP socket.\n"; WSACleanup(); return 1;
    }

    sockaddr_in server;
    server.sin_family = AF_INET;
    server.sin_port = htons(TCP_PORT);
    server.sin_addr.s_addr = inet_addr(SERVER_IP);

    std::cout << "Connecting to " << SERVER_IP << ":" << TCP_PORT << "...\n";
    if (connect(s, (sockaddr *)&server, sizeof(server)) == SOCKET_ERROR) {
        std::cout << "Connection failed. Start server.exe first.\n";
        closesocket(s); WSACleanup(); return 1;
    }

    std::cout << "Connected. Waiting for alerts...\n\n";
    char buffer[512];
    std::string pending;
    while (true) {
        int n = recv(s, buffer, sizeof(buffer) - 1, 0);
        if (n == 0) {
            std::cout << "Server disconnected.\n"; break;
        }
        if (n == SOCKET_ERROR) {
            std::cout << "recv failed: " << WSAGetLastError() << "\n"; break;
        }
        buffer[n] = '\0';
        pending += buffer;
        std::string::size_type pos;
        while ((pos = pending.find('\n')) != std::string::npos) {
            std::string line = pending.substr(0, pos);
            pending.erase(0, pos + 1);
            if (!line.empty()) std::cout << "[MONITOR] " << line << "\n";
        }
    }

    shutdown(s, SD_BOTH);
    closesocket(s);
    WSACleanup();
    return 0;
}
