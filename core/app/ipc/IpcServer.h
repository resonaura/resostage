// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

// resostage::IpcServer
// ----------------------
// Cross-platform IPC channel between the C++/JUCE Core and Electron UI.
//
// Transport: a stream socket -- AF_UNIX (Linux/macOS) or a Windows named pipe
// (\\.\pipe\...). Electron connects with Node.js net.connect(), so this does
// not use JUCE NamedPipe: on POSIX that creates FIFO files with _in/_out
// suffixes, which net.connect cannot open by path.
//
// Protocol: one JSON line plus '\n' per message, from Core to UI:
//
//   {"type":"ready",   "sampleRate":48000,"blockSize":512,"latency":44}
//   {"type":"started"}
//   {"type":"stopped"}
//   {"type":"error","message":"..."}
//
// Lifecycle:
//   - Core starts with --ipc-socket <path>, creates the listener, and calls
//     notifyReady(...) after audio-device initialization.
//   - Electron: spawn(core, ['--ipc-socket', path]) -> net.connect(path) ->
//     wait for {"type":"ready"} -> createWindow. Closing the window sends
//     core.kill('SIGTERM').
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

    // Creates a listening stream socket/pipe. Returns false on failure.
    bool start(const std::string& socketPath);

    // Stops the server and closes the client connection, if present.
    void stop();

    // Called from Core audio/transport threads. These queue a message for the
    // background listener to deliver to the connected client.
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
    // Win32 HANDLEs for the server named pipe and connected client.
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
