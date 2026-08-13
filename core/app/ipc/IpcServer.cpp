#include "IpcServer.h"

#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>

#include <chrono>

namespace resostage {

IpcServer::IpcServer() = default;
IpcServer::~IpcServer() { stop(); }

bool IpcServer::start(const std::string& socketPath) {
    socketPath_ = socketPath;
    serverPipe_ = std::make_unique<juce::NamedPipe>();
    if (!serverPipe_->createNewPipe(juce::String(socketPath)))
        return false;
    if (!serverPipe_->isOpen())
        return false;
    // Фоновый поток слушает клиентские подключения и рассылает накопленные
    // сообщения (ready/started/stopped/error). Живёт до stop().
    listener_ = std::make_unique<std::thread>(&IpcServer::listenerThread, this);
    return true;
}

void IpcServer::stop() {
    stopRequested_.store(true, std::memory_order_relaxed);
    if (serverPipe_ && serverPipe_->isOpen())
        serverPipe_->close();
    if (listener_ && listener_->joinable())
        listener_->join();
}

// run() больше не блокирует — сервер живёт на фоновом потоке из start().
void IpcServer::run() {}

void IpcServer::onReady(ReadyCallback cb)  { onReady_  = std::move(cb); }
void IpcServer::onStarted(EmptyCallback cb) { onStarted_ = std::move(cb); }
void IpcServer::onStopped(EmptyCallback cb) { onStopped_ = std::move(cb); }
void IpcServer::onError(ErrorCallback cb)  { onError_  = std::move(cb); }

std::string IpcServer::jsonReady(int sampleRate, int blockSize, int outputLatencySamples) const {
    // Ручная сборка JSON — гарантирует одинаковый результат на всех платформах
    // и не зависит от серийзатора JUCE.
    return std::string("{\"type\":\"ready\",\"sampleRate\":") +
           std::to_string(sampleRate) + ",\"blockSize\":" +
           std::to_string(blockSize) + ",\"latency\":" +
           std::to_string(outputLatencySamples) + "}";
}

void IpcServer::notifyReady(int sampleRate, int blockSize, int outputLatencySamples) {
    juce::ScopedLock lock(messageLock_);
    pending_ = jsonReady(sampleRate, blockSize, outputLatencySamples);
}

void IpcServer::notifyStarted() {
    juce::ScopedLock lock(messageLock_);
    pending_ = "{\"type\":\"started\"}";
}

void IpcServer::notifyStopped() {
    juce::ScopedLock lock(messageLock_);
    pending_ = "{\"type\":\"stopped\"}";
}

void IpcServer::notifyError(const std::string& message) {
    juce::ScopedLock lock(messageLock_);
    // Минимальное экранирование кавычек и backslash для JSON-строки.
    std::string safe;
    safe.reserve(message.size() + 8);
    for (char c : message) {
        if (c == '"' || c == '\\') safe.push_back('\\');
        safe.push_back(c);
    }
    pending_ = "{\"type\":\"error\",\"message\":\"" + safe + "\"}";
}

bool IpcServer::writeMessage(const std::string& msg) {
    if (!serverPipe_ || !serverPipe_->isOpen())
        return false;
    const std::string withNl = msg + "\n";
    const int n = serverPipe_->write(static_cast<const void*>(withNl.data()),
                                     static_cast<int>(withNl.size()), -1);
    return n > 0;
}

void IpcServer::listenerThread() {
    // Ждём подключения клиента. JUCE NamedPipe серверный read() блокируется,
    // пока клиент не подключится и не пошлёт данные (любые). Мы читаем "ping",
    // затем считаем клиента подключенным и отсылаем накопленные сообщения.
    for (;;) {
        if (stopRequested_.load(std::memory_order_relaxed))
            break;
        char buf[16] = {};
        const int n = serverPipe_->read(buf, sizeof(buf), 1000);
        if (n > 0) {
            clientConnected_.store(true, std::memory_order_release);
            // Отсылаем накопленное сообщение (если оно есть).
            juce::ScopedLock lock(messageLock_);
            if (!pending_.empty()) {
                writeMessage(pending_);
                pending_.clear();
            }
        }
    }
}

} // namespace resostage
