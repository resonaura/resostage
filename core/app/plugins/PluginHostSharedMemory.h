#pragma once

#include "plugins/PluginHostProtocol.h"

#include <memory>
#include <string>

namespace resostage {

/**
 * Owns or opens the bounded shared-memory data plane for one live host.
 * Construction, mapping, launch, and destruction are non-realtime only.
 * The versioned mapped protocol uses SPSC audio slots and a bounded MPMC
 * control queue. Callbacks may only touch lock-free slot state, fixed arrays,
 * and the non-waiting wake signal.
 */
class PluginHostSharedMemory final {
public:
    PluginHostSharedMemory();
    ~PluginHostSharedMemory();
    PluginHostSharedMemory(PluginHostSharedMemory&&) noexcept;
    PluginHostSharedMemory& operator=(PluginHostSharedMemory&&) noexcept;
    PluginHostSharedMemory(const PluginHostSharedMemory&) = delete;
    PluginHostSharedMemory& operator=(const PluginHostSharedMemory&) = delete;

    /** Creates and initializes a private mapping. `name` must be unique. */
    bool create(const std::string& name, uint64_t generation,
                uint32_t maximumBlockSamples, std::string& error,
                double sampleRate = 48000.0);
    /** Opens a mapping created by Core and validates its immutable ABI fields. */
    bool open(const std::string& name, uint64_t generation,
              uint32_t maximumBlockSamples, std::string& error,
              double sampleRate = 48000.0);

    plugin_host::SharedArea* area() noexcept;
    const plugin_host::SharedArea* area() const noexcept;
    const std::string& name() const noexcept;
    bool isOwner() const noexcept;

    /** Non-waiting wake from Core to the helper after publishing a request. */
    bool signalWake() noexcept;
    /** Worker-only wait with a finite timeout; never call from an audio callback. */
    bool waitForWake(uint32_t timeoutMilliseconds) noexcept;

private:
    struct Impl;
    std::unique_ptr<Impl> impl;
};

} // namespace resostage
