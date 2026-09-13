// 极简 WebSocket 客户端（Winsock2 手写，**不引 Boost/websocketpp**）。
//
// 只实现注入工具真正需要的部分：
//   · 连 127.0.0.1 的裸 ws://
//   · 握手（带自定义 User-Agent，便于宿主识别是我们的原生侧）
//   · 文本帧收发；**客户端发出的帧必须掩码**（RFC 6455 强制）
//   · 帧长 7bit / 16bit / 64bit 三种；分片帧只处理不分片的简单情况
//
// 不做的事（够用就行，需要再加）：
//   · 不校验 Sec-WebSocket-Accept（只判 "101 Switching Protocols"）—— 本机回环连接，够用
//   · 不支持 permessage-deflate / wss（TLS）—— 我们只走本机明文回环
//   · 不支持 ping/pong 自动应答以外的控制帧（pong 会忽略）
#pragma once

#include <winsock2.h>
#include <ws2tcpip.h>
#include <string>
#include <cstdint>
#include <cstdio>
#include "log.h"

#pragma comment(lib, "ws2_32.lib")

namespace bb {

class WsClient {
public:
    ~WsClient() { close(); }

    bool connectTo(const char* host, unsigned short port, const char* userAgent = "baibao-native/1.0") {
        WSADATA wsa{};
        if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
            BB_ERR(L"WSAStartup 失败");
            return false;
        }
        wsaReady() = true;

        SOCKET s = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
        if (s == INVALID_SOCKET) {
            BB_ERR(L"socket 创建失败: %d", WSAGetLastError());
            return false;
        }

        sockaddr_in addr{};
        addr.sin_family = AF_INET;
        addr.sin_port = htons(port);
        inet_pton(AF_INET, host, &addr.sin_addr);

        if (::connect(s, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
            BB_WARN(L"连接 %s:%u 失败: %d（宿主可能还没起来）", host, port, WSAGetLastError());
            ::closesocket(s);
            return false;
        }
        sock() = s;
        BB_LOG(L"已连接宿主总线 %s:%u，开始握手", host, port);

        return handshake(host, port, userAgent);
    }

    bool isOpen() const { return sock() != INVALID_SOCKET; }

    /** 发一个文本帧（JSON 报文） */
    bool sendText(const std::string& text) {
        if (!isOpen()) return false;
        std::string frame;
        frame.push_back(static_cast<char>(0x81)); // FIN=1, opcode=1(text)

        const size_t n = text.size();
        if (n < 126) {
            frame.push_back(static_cast<char>(0x80 | n)); // MASK=1
        } else if (n <= 0xFFFF) {
            frame.push_back(static_cast<char>(0x80 | 126));
            frame.push_back(static_cast<char>((n >> 8) & 0xFF));
            frame.push_back(static_cast<char>(n & 0xFF));
        } else {
            frame.push_back(static_cast<char>(0x80 | 127));
            for (int i = 7; i >= 0; --i) frame.push_back(static_cast<char>((n >> (i * 8)) & 0xFF));
        }

        // 掩码（4 字节密钥 + 逐字节异或）—— 客户端帧必须掩码，否则对方会直接断连
        unsigned char mask[4];
        for (int i = 0; i < 4; ++i) mask[i] = static_cast<unsigned char>(rand() & 0xFF);
        for (int i = 0; i < 4; ++i) frame.push_back(static_cast<char>(mask[i]));
        for (size_t i = 0; i < n; ++i) {
            frame.push_back(static_cast<char>(text[i] ^ mask[i & 3]));
        }
        return sendAll(frame.data(), frame.size());
    }

    /** 收一个文本帧（阻塞）。返回 false 表示连接断了。 */
    bool recvText(std::string& out, int timeoutMs = 30000) {
        if (!isOpen()) return false;
        out.clear();

        for (;;) {
            unsigned char hdr[2];
            if (!recvAll(reinterpret_cast<char*>(hdr), 2, timeoutMs)) return false;

            const bool fin = (hdr[0] & 0x80) != 0;
            const unsigned opcode = hdr[0] & 0x0F;
            const bool masked = (hdr[1] & 0x80) != 0;
            uint64_t len = hdr[1] & 0x7F;

            if (len == 126) {
                unsigned char e[2];
                if (!recvAll(reinterpret_cast<char*>(e), 2, timeoutMs)) return false;
                len = (uint64_t(e[0]) << 8) | e[1];
            } else if (len == 127) {
                unsigned char e[8];
                if (!recvAll(reinterpret_cast<char*>(e), 8, timeoutMs)) return false;
                len = 0;
                for (int i = 0; i < 8; ++i) len = (len << 8) | e[i];
            }

            unsigned char maskKey[4] = {0, 0, 0, 0};
            if (masked && !recvAll(reinterpret_cast<char*>(maskKey), 4, timeoutMs)) return false;

            if (len > (16u << 20)) { // 16MB 上限，防止被塞爆
                BB_ERR(L"帧过大: %llu 字节，断开", static_cast<unsigned long long>(len));
                close();
                return false;
            }

            std::string payload;
            payload.resize(static_cast<size_t>(len));
            if (len && !recvAll(&payload[0], static_cast<int>(len), timeoutMs)) return false;
            if (masked) {
                for (size_t i = 0; i < payload.size(); ++i) {
                    payload[i] = static_cast<char>(payload[i] ^ maskKey[i & 3]);
                }
            }

            if (opcode == 0x8) { // close
                BB_LOG(L"宿主关闭了连接");
                close();
                return false;
            }
            if (opcode == 0x9) { // ping → 回 pong（不回会被判死连接）
                sendPong(payload);
                continue;
            }
            if (opcode == 0xA) continue; // pong，忽略
            if (opcode == 0x1 || opcode == 0x2) {
                if (!fin) { BB_WARN(L"收到分片帧，暂不支持，已忽略"); continue; }
                out = payload;
                return true;
            }
            // 其它 opcode：忽略后继续读
        }
    }

    void close() {
        if (sock() != INVALID_SOCKET) {
            ::closesocket(sock());
            sock() = INVALID_SOCKET;
        }
        if (wsaReady()) {
            WSACleanup();
            wsaReady() = false;
        }
    }

private:
    static SOCKET& sock() { static SOCKET s = INVALID_SOCKET; return s; }
    static bool& wsaReady() { static bool b = false; return b; }

    bool sendAll(const char* data, size_t len) {
        size_t sent = 0;
        while (sent < len) {
            int n = ::send(sock(), data + sent, static_cast<int>(len - sent), 0);
            if (n <= 0) return false;
            sent += static_cast<size_t>(n);
        }
        return true;
    }

    bool recvAll(char* data, int len, int timeoutMs) {
        // 设置接收超时，避免永久阻塞把游戏卡死
        DWORD tv = static_cast<DWORD>(timeoutMs);
        setsockopt(sock(), SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&tv), sizeof(tv));

        int got = 0;
        while (got < len) {
            int n = ::recv(sock(), data + got, len - got, 0);
            if (n <= 0) return false;
            got += n;
        }
        return true;
    }

    void sendPong(const std::string& payload) {
        std::string frame;
        frame.push_back(static_cast<char>(0x8A)); // FIN + pong
        if (payload.size() < 126) {
            frame.push_back(static_cast<char>(0x80 | payload.size()));
        } else {
            frame.push_back(static_cast<char>(0x80 | 126));
            frame.push_back(static_cast<char>((payload.size() >> 8) & 0xFF));
            frame.push_back(static_cast<char>(payload.size() & 0xFF));
        }
        unsigned char mask[4] = {1, 2, 3, 4};
        for (int i = 0; i < 4; ++i) frame.push_back(static_cast<char>(mask[i]));
        for (size_t i = 0; i < payload.size(); ++i) {
            frame.push_back(static_cast<char>(payload[i] ^ mask[i & 3]));
        }
        sendAll(frame.data(), frame.size());
    }

    bool handshake(const char* host, unsigned short port, const char* userAgent) {
        char req[512];
        // 固定一个 Key 即可：我们**不校验** Sec-WebSocket-Accept（只判 101）
        std::snprintf(req, sizeof(req),
            "GET / HTTP/1.1\r\n"
            "Host: %s:%u\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "User-Agent: %s\r\n"
            "\r\n",
            host, port, userAgent);

        if (!sendAll(req, std::strlen(req))) return false;

        // 读响应头（到 \r\n\r\n 为止）
        std::string resp;
        char c;
        while (resp.size() < 4096) {
            if (!recvAll(&c, 1, 5000)) return false;
            resp.push_back(c);
            if (resp.size() >= 4 && resp.compare(resp.size() - 4, 4, "\r\n\r\n") == 0) break;
        }
        if (resp.find("101") == std::string::npos) {
            BB_ERR(L"WebSocket 握手失败，响应: %.120S", resp.c_str());
            close();
            return false;
        }
        BB_LOG(L"WebSocket 握手成功");
        return true;
    }
};

} // namespace bb
