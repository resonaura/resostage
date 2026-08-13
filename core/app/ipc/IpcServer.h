// resostage::IpcServer
// ----------------------
// Кроссплатформенный IPC-канал между C++/JUCE Core и Electron UI.
//
// Транспорт: JUCE NamedPipe (Unix domain socket на Linux/macOS, \\.\pipe\ на
// Windows). Electron подключается к нему через Node.js net.connect().
//
// Протокол: одна строка JSON + '\n' на сообщение, от Core → UI:
//
//   {"type":"ready",   "sampleRate":48000,"blockSize":512,"latency":44}
//   {"type":"started"}
//   {"type":"stopped"}
//   {"type":"error","message":"..."}
//
// Жизненный цикл:
//   - Core запускается с --ipc-socket <path>, создаёт серверный канал, вызывает
//     notifyReady(...) после инициализации аудиоустройства, затем run() блокирует
//     основной поток до отключения клиента или stop().
//   - Electron: spawn(core, ['--ipc-socket', path]) → net.connect(path) → ждёт
//     {"type":"ready"} → createWindow. При закрытии окна core.kill('SIGTERM').
#pragma once

#include <juce_events/juce_events.h>

#include <atomic>
#include <functional>
#include <memory>
#include <string>
#include <thread>

namespace resostage {

class IpcServer {
public:
    using ReadyCallback  = std::function<void(int sampleRate, int blockSize, int outputLatencySamples)>;
    using EmptyCallback  = std::function<void()>;
    using ErrorCallback  = std::function<void(const std::string& message)>;

    IpcServer();
    ~IpcServer();
    IpcServer(const IpcServer&) = delete;
    IpcServer& operator=(const IpcServer&) = delete;

    // Создаёт слушающий именованный канал. Возвращает false при ошибке.
    bool start(const std::string& socketPath);

    // Блокирует вызывающий поток, пока клиент не отключится или stop() не вызван.
    void run();
    void stop();

    // Вызываются из аудио/транспортных потоков Core. Накапливают сообщение;
    // run()/listenThread рассылает его клиенту при подключении.
    void notifyReady(int sampleRate, int blockSize, int outputLatencySamples);
    void notifyStarted();
    void notifyStopped();
    void notifyError(const std::string& message);

private:
    void listenerThread();
    bool writeMessage(const std::string& msg);
    std::string jsonReady(int sampleRate, int blockSize, int outputLatencySamples) const;

    std::string socketPath_;
    std::unique_ptr<juce::NamedPipe> serverPipe_;
    std::unique_ptr<std::thread> listener_;
    std::atomic<bool> stopRequested_{false};
    std::atomic<bool> clientConnected_{false};

    mutable juce::CriticalSection messageLock_;
    std::string pending_; // буфер исходящих сообщений (ready/started/stopped/error)

    ReadyCallback onReady_;
    EmptyCallback onStarted_;
    EmptyCallback onStopped_;
    ErrorCallback onError_;

public:
    // Регистраторы — вызываются на потоке listenerThread, когда клиент подключается
    // и сервер готов дальше взаимодействовать (например, чтобы UI знала readiness).
    void onReady(ReadyCallback cb);
    void onStarted(EmptyCallback cb);
    void onStopped(EmptyCallback cb);
    void onError(ErrorCallback cb);
};

} // namespace resostage
