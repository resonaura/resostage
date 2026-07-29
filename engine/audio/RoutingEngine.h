#pragma once

#include "RoutingTypes.h"

#include <atomic>
#include <memory>

namespace resostage {

// Flat routing table published via atomic std::shared_ptr swap.
//
// Rationale for the flat (non-matrix) representation: with realistic channel
// counts for a live set (dozens of tracks, a handful of busses) a dense NxM
// coefficient matrix wastes both memory and cycles multiplying mostly-zero
// entries. A flat array of (track, bus) route edges walked in a straight-line
// loop gets the same cache-locality and auto-vectorization benefits without
// the sparsity waste.
//
// Concurrency model: exactly one audio thread calls acquireForRender(), and
// exactly one non-real-time thread calls publish(). publish() allocates (a
// new snapshot + control block). acquireForRender() copies a shared_ptr --
// an atomic refcount increment, no heap allocation -- safe on the audio thread.
//
// Reclamation: atomic shared_ptr operations (std::atomic_load/atomic_store),
// not a hand-rolled hazard pointer. An earlier hand-rolled single-reader
// hazard-pointer version (and, before that, a fixed-size retirement ring)
// both turned out to have genuine use-after-free bugs under concurrent
// stress testing, caught by tests/test_routing_engine.cpp's concurrency test
// running under AddressSanitizer. Reference counting is the standard,
// provably-correct primitive for "publish immutable snapshots, readers keep
// old ones alive as long as they need them" -- not worth re-deriving by hand
// a second time. (Using the std::atomic_load/store free-function form rather
// than C++20's std::atomic<shared_ptr<T>> class template because this
// toolchain's libc++ doesn't yet implement that partial specialization --
// static_assert failure on is_trivially_copyable. The free functions are
// deprecated-for-removal in a future standard but are exactly the mechanism
// atomic<shared_ptr<T>> itself replaces, and remain fully supported here.)
class RoutingEngine {
public:
    RoutingEngine();
    ~RoutingEngine();

    RoutingEngine(const RoutingEngine&) = delete;
    RoutingEngine& operator=(const RoutingEngine&) = delete;

    // Called from the message/UI thread. Takes ownership of `next`.
    void publish(std::unique_ptr<RoutingSnapshot> next);

    // Called from the audio thread. Returns a shared_ptr keeping the
    // snapshot alive for as long as the caller holds it. Never allocates;
    // returns nullptr only if publish() has never been called yet.
    std::shared_ptr<const RoutingSnapshot> acquireForRender();

private:
    std::shared_ptr<const RoutingSnapshot> active;
};

} // namespace resostage
