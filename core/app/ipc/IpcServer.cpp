#include "IpcServer.h"

#include <juce_core/juce_core.h>

#include <cstring>

#if JUCE_WINDOWS
#include <windows.h>
#else
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#endif

#include <chrono>

namespace resostage {

IpcServer::IpcServer() = default;

IpcServer::~IpcServer() { stop(); }

std::string IpcServer::jsonReady(int sampleRate, int blockSize, int outputLatencySamples) const {
    return std::string("{\"type\":\"ready\",\"sampleRate\":") +
           std::to_string(sampleRate) + ",\"blockSize\":" +
           std::to_string(blockSize) + ",\"latency\":" +
           std::to_string(outputLatencySamples) + "}";
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

    // Ждём readiness, пока клиент подключается, либо дожидаемся немедленно.
    // Цикл: периодически пытаемся отправить накопленное сообщение,
    // пока клиент не отключится (write с ошибкой) или stop не вызван.
    while (!stopRequested_.load(std::memory_order_relaxed)) {
        if (hasPending_.load(std::memory_order_acquire)) {
            std::string msg;
            {
                std::lock_guard lock(messageLock_);
                msg = pending_;
                hasPending_.store(false, std::memory_order_release);
            }
            if (!writeMessage(msg))
                break; // клиент отключился
            // readiness-сообщение может один раз; продолжаем ждать старта/стопа.
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
    pending_ = "{\"type\":\"started\"}";
    hasPending_.store(true, std::memory_order_release);
}

void IpcServer::notifyStopped() {
    std::lock_guard lock(messageLock_);
    pending_ = "{\"type\":\"stopped\"}";
    hasPending_.store(true, std::memory_order_release);
}

void IpcServer::notifyError(const std::string& message) {
    std::lock_guard lock(messageLock_);
    std::string safe;
    safe.reserve(message.size() + 8);
    for (char c : message) {
        if (c == '"' || c == '\\') {
            safe += '\\';
            safe += c;
        } else if (c == '\n') {
            safe += "\\n";
        } else if (c == '\r') {
            safe += "\\r";
        } else if (c == '\t') {
            safe += "\\t";
        } else {
            safe += c;
        }
    }
    pending_ = "{\"type\":\"error\",\"message\":\"" + safe + "\"}";
    hasPending_.store(true, std::memory_order_release);
}

} // namespace resostage
