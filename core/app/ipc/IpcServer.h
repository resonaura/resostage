// resostage::IpcServer
// ----------------------
// Кроссплатформенный IPC-канал между C++/JUCE Core и Electron UI.
//
// Транспорт: потоковый сокет — AF_UNIX (Linux/macOS) или именованный канал
// Windows (\\.\pipe\...). Electron подключается через Node.js net.connect(),
// поэтому НЕ JUCE NamedPipe: тот на POSIX создаёт FIFO‑файлы с суффиксами
// _in/_out, к которым net.connect путём указания пути не подключиться.
//
// Протокол: одна строка JSON + '\n' на сообщение, от Core → UI:
//
//   {"type":"ready",   "sampleRate":48000,"blockSize":512,"latency":44}
//   {"type":"started"}
//   {"type":"stopped"}
//   {"type":"error","message":"..."}
//
// Жизненный цикл:
//   - Core запускается с --ipc-socket <path>, создаёт слушающий сервер,
//     вызывает notifyReady(...) после инициализации аудиоустройства.
//   - Electron: spawn(core, ['--ipc-socket', path]) → net.connect(path) →
//     ждёт {"type":"ready"} → createWindow. При закрытии окна core.kill('SIGTERM').
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
    using OpenProjectCallback = std::function<void(const std::string& projectPath)>;

    IpcServer();
    ~IpcServer();
    IpcServer(const IpcServer&) = delete;
    IpcServer& operator=(const IpcServer&) = delete;

    // Создаёт слушающий потоковый сокет/канал. Возвращает false при ошибке.
    bool start(const std::string& socketPath);

    // Останавливает сервер и закрывает клиентское соединение (если есть).
    void stop();

    // Вызываются из аудио/транспортных потоков Core. Накапливают сообщение;
    // фоновый поток рассылает его подключённому клиенту.
    void notifyReady(int sampleRate, int blockSize, int outputLatencySamples);
    void notifyStarted();
    void notifyStopped();
    void notifyError(const std::string& message);

    // Register callback for open-project requests from Electron.
    void onOpenProject(OpenProjectCallback cb) { onOpenProject_ = std::move(cb); }

private:
    std::string jsonReady(int sampleRate, int blockSize, int outputLatencySamples) const;
    void listenerThread();
    void handleIncomingMessage(const std::string& line);
    bool writeMessage(const std::string& msg);

#if JUCE_WINDOWS
    // Win32 HANDLE идентификатора серверного именованного канала и клиента.
    void* serverHandle_ = nullptr;
    void* clientHandle_ = nullptr;
#else
    int serverFd_ = -1;
    int clientFd_ = -1;
#endif

    std::atomic<bool> stopRequested_{false};
    std::unique_ptr<std::thread> listener_;

    std::mutex messageLock_;
    std::string pending_;
    std::atomic<bool> hasPending_{false};

    OpenProjectCallback onOpenProject_;
};

} // namespace resostage
