Fishing Boat Safety Check-In and Alert Network
Falcon MinGW 4.4.1 / older C++ compatible version

Compile in PowerShell from this folder:
g++ server.cpp -o server.exe -lws2_32
g++ boat_client.cpp -o boat_client.exe -lws2_32
g++ monitor_client.cpp -o monitor_client.exe -lws2_32

If using the MSYS2 compiler directly, use:
& "C:\msys64\ucrt64\bin\g++.exe" server.cpp -o server.exe -lws2_32
& "C:\msys64\ucrt64\bin\g++.exe" boat_client.cpp -o boat_client.exe -lws2_32
& "C:\msys64\ucrt64\bin\g++.exe" monitor_client.cpp -o monitor_client.exe -lws2_32

Run each in its own terminal, in this order:
1. server.exe
2. monitor_client.exe
3. boat_client.exe

Boat client keys:
S = stop heartbeats
R = resume heartbeats
D = send distress
Q = quit

UDP port 5000; TCP port 5001; heartbeat timeout 10 seconds.
Coordinates are simulated. Educational localhost demonstration only.
