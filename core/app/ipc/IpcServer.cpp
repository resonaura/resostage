#include "IpcServer.h"

#include <juce_core/juce_core.h>

#include "glaze/glaze.hpp"

#include <cstring>

#if JUCE_WINDOWS
#include <windows.h>
#else
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/select.h>
#include <unistd.h>
#endif

#include <chrono>

namespace resostage {

// Glaze-reflected IPC wire messages (mirror electron/src/main.mts sendIpcMessage).
// Must have external linkage for glaze reflection, so not in an anonymous ns.
struct IpcReadyMsg {
    std::string type = "ready";
    int sampleRate = 0;
    int blockSize = 0;
    int latency = 0;
};
struct IpcStatusMsg {
    std::string type; // "started" | "stopped"
};
struct IpcErrorMsg {
    std::string type = "error";
    std::string message;
};
struct IpcOpenProjectMsg {
    std::string type;
    std::string path;
};

std::string writeJson(const auto& value) {
    std::string out;
    (void)glz::write_json(value, out);
    return out;
}

IpcServer::IpcServer() = default;

IpcServer::~IpcServer() { stop(); }

std::string IpcServer::jsonReady(int sampleRate, int blockSize, int outputLatencySamples) const {
    return writeJson(IpcReadyMsg{"ready", sampleRate, blockSize, outputLatencySamples});
}

bool IpcServer::start(const std::string& socketPath) {
#if JUCE_WINDOWS
    // Windows: именованный канал потоковый. Формат пути \\.\pipe\name.
    // Если путь уже начинается с \\.\pipe\, используем как есть.
    std::string pipeName = socketPath;
    const std::string prefix = "\\\\.\\pipe\\";
    if (pipeName.rfind(prefix, 0) != 0)
        pipeName = prefix + pipeName;

    for (int attempt = 0; attempt < 20; ++attempt) {
        serverHandle_ = CreateNamedPipeA(
            pipeName.c_str(),
            PIPE_ACCESS_OUTBOUND,          // Core только пишет клиенту
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            1,                             // max instances
            0, 0,                          // out/in buffer sizes
            0,                             // timeout
            nullptr);
        if (serverHandle_ != nullptr && serverHandle_ != INVALID_HANDLE_VALUE)
            break;
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
    if (serverHandle_ == nullptr || serverHandle_ == INVALID_HANDLE_VALUE) {
        serverHandle_ = nullptr;
        return false;
    }
#else
    const int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0)
        return false;

    // Удаляем возможный старый файл сокета (от убитого процесса).
    ::unlink(socketPath.c_str());

    struct sockaddr_un addr;
    std::memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    // sun_path ограничен длиной; проверяем.
    if (socketPath.size() >= sizeof(addr.sun_path)) {
        ::close(fd);
        return false;
    }
    std::strcpy(addr.sun_path, socketPath.c_str());

    if (::bind(fd, reinterpret_cast<struct sockaddr*>(&addr), sizeof(addr)) < 0) {
        ::close(fd);
        return false;
    }
    if (::listen(fd, 1) < 0) {
        ::close(fd);
        return false;
    }
    serverFd_ = fd;
#endif
    listener_ = std::make_unique<std::thread>(&IpcServer::listenerThread, this);
    return true;
}

void IpcServer::stop() {
    stopRequested_.store(true, std::memory_order_relaxed);
#if JUCE_WINDOWS
    if (clientHandle_ && clientHandle_ != INVALID_HANDLE_VALUE)
        DisconnectNamedPipe(clientHandle_);
    if (serverHandle_ && serverHandle_ != INVALID_HANDLE_VALUE)
        CloseHandle(serverHandle_);
#else
    if (clientFd_ >= 0)
        ::close(clientFd_);
    if (serverFd_ >= 0) {
        ::close(serverFd_);
        serverFd_ = -1;
    }
#endif
    if (listener_ && listener_->joinable())
        listener_->join();
}

void IpcServer::listenerThread() {
#if JUCE_WINDOWS
    if (!serverHandle_ || serverHandle_ == INVALID_HANDLE_VALUE)
        return;
    // Ждём клиента: ConnectNamedPipe блокирует до подключения или ошибки.
    BOOL ok = ConnectNamedPipe(serverHandle_, nullptr);
    if (!ok && GetLastError() != ERROR_PIPE_CONNECTED)
        return;
    clientHandle_ = serverHandle_;
    // После отключения клиента серверный handle нельзя переиспользовать —
    // достаточно ждать завершения процесса Core (он умирает с ним).
#else
    if (serverFd_ < 0)
        return;
    // Принимаем ровно одного клиента (Electron).
    clientFd_ = ::accept(serverFd_, nullptr, nullptr);
    if (clientFd_ < 0)
        return;
#endif

    // Read buffer for incoming messages from Electron.
    std::string readBuf;

    // Цикл: отправляем исходящие сообщения И читаем входящие от Electron.
    while (!stopRequested_.load(std::memory_order_relaxed)) {
        // 1. Send any pending outbound message.
        if (hasPending_.load(std::memory_order_acquire)) {
            std::string msg;
            {
                std::lock_guard lock(messageLock_);
                msg = pending_;
                hasPending_.store(false, std::memory_order_release);
            }
            if (!writeMessage(msg))
                break; // клиент отключился
        }

        // 2. Try to read inbound data (non-blocking poll + read).
        char buf[1024];
        int n = 0;
#if JUCE_WINDOWS
        DWORD available = 0;
        if (clientHandle_ && clientHandle_ != INVALID_HANDLE_VALUE) {
            if (PeekNamedPipe(clientHandle_, nullptr, 0, nullptr, &available, nullptr) && available > 0) {
                DWORD read = 0;
                if (ReadFile(clientHandle_, buf, sizeof(buf) - 1, &read, nullptr) && read > 0) {
                    n = static_cast<int>(read);
                }
            }
        }
#else
        if (clientFd_ >= 0) {
            fd_set fds;
            FD_ZERO(&fds);
            FD_SET(clientFd_, &fds);
            struct timeval tv = {0, 0};
            int sel = select(clientFd_ + 1, &fds, nullptr, nullptr, &tv);
            if (sel > 0 && FD_ISSET(clientFd_, &fds)) {
                n = static_cast<int>(::read(clientFd_, buf, sizeof(buf) - 1));
            }
        }
#endif
        if (n > 0) {
            buf[n] = '\0';
            readBuf += buf;
            // Process complete lines (JSON messages terminated by '\n').
            size_t pos;
            while ((pos = readBuf.find('\n')) != std::string::npos) {
                std::string line = readBuf.substr(0, pos);
                readBuf.erase(0, pos + 1);
                handleIncomingMessage(line);
            }
        }

        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    // Гарантируем доставку readiness, если клиент всё ещё подключён.
    if (hasPending_.load(std::memory_order_acquire)) {
        std::string msg;
        {
            std::lock_guard lock(messageLock_);
            msg = pending_;
            hasPending_.store(false, std::memory_order_release);
        }
        writeMessage(msg);
    }
}

void IpcServer::handleIncomingMessage(const std::string& line) {
    // Parse the Electron IPC message with Glaze. Currently the only inbound
    // message is {"type":"open-project","path":"..."}.
    constexpr glz::opts opts{
        .error_on_unknown_keys = false,
        .error_on_missing_keys = false,
    };
    IpcOpenProjectMsg msg;
    if (glz::read<opts>(msg, line))
        return;
    if (msg.type == "open-project" && onOpenProject_)
        onOpenProject_(msg.path);
}

bool IpcServer::writeMessage(const std::string& msg) {
    std::string framed = msg;
    if (framed.find('\n') == std::string::npos)
        framed += '\n';
    const int n = static_cast<int>(framed.size());
    int sent = 0;
#if JUCE_WINDOWS
    if (!clientHandle_ || clientHandle_ == INVALID_HANDLE_VALUE)
        return false;
    DWORD written = 0;
    if (!WriteFile(clientHandle_, framed.data(), static_cast<DWORD>(n), &written, nullptr))
        return false;
    sent = static_cast<int>(written);
#else
    if (clientFd_ < 0)
        return false;
    sent = static_cast<int>(::write(clientFd_, framed.data(), static_cast<size_t>(n)));
    if (sent <= 0)
        return false;
#endif
    return sent == n;
}

void IpcServer::notifyReady(int sampleRate, int blockSize, int outputLatencySamples) {
    std::lock_guard lock(messageLock_);
    pending_ = jsonReady(sampleRate, blockSize, outputLatencySamples);
    hasPending_.store(true, std::memory_order_release);
}

void IpcServer::notifyStarted() {
    std::lock_guard lock(messageLock_);
    pending_ = writeJson(IpcStatusMsg{"started"});
    hasPending_.store(true, std::memory_order_release);
}

void IpcServer::notifyStopped() {
    std::lock_guard lock(messageLock_);
    pending_ = writeJson(IpcStatusMsg{"stopped"});
    hasPending_.store(true, std::memory_order_release);
}

void IpcServer::notifyError(const std::string& message) {
    std::lock_guard lock(messageLock_);
    pending_ = writeJson(IpcErrorMsg{"error", message});
    hasPending_.store(true, std::memory_order_release);
}

} // namespace resostage
