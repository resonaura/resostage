#pragma once

#include "RoutingTypes.h"

#include <atomic>
#include <memory>
#include <vector>

namespace resoset {

// Flat, lock-free routing table with atomic-swap updates.
//
// Rationale for the flat (non-matrix) representation: with realistic channel
// counts for a live set (dozens of tracks, a handful of busses) a dense NxM
// coefficient matrix wastes both memory and cycles multiplying mostly-zero
// entries. A flat array of (track, bus) route edges walked in a straight-line
// loop gets the same cache-locality and auto-vectorization benefits without
// the sparsity waste, while keeping the same zero-allocation, zero-lock,
// atomic-pointer-swap update model.
//
// Concurrency model: exactly one audio thread calls acquireForRender(), and
// exactly one non-real-time thread calls publish() (the message/UI thread).
// publish() may allocate/free; acquireForRender() never allocates and never
// blocks.
//
// Reclamation: a single-reader hazard pointer. acquireForRender() publishes
// the pointer it's about to return into an atomic `hazard` slot before
// returning it (with a protect-and-validate retry, the standard hazard-
// pointer pattern, in case the snapshot was retired between the load and the
// hazard publish). publish() only actually frees a retired snapshot once it
// observes that it is no longer the hazarded pointer. This is a correctness
// guarantee, not a timing assumption: an early version of this class instead
// used a fixed-size retirement ring sized on the assumption that the reader
// would always finish with a snapshot before ~8 further publishes occurred --
// a concurrent stress test (see tests/test_routing_engine.cpp) proved that
// assumption false under a fast writer / slow reader race and produced a
// real use-after-free. The hazard-pointer scheme has no such assumption.
class RoutingEngine {
public:
    RoutingEngine();
    ~RoutingEngine();

    RoutingEngine(const RoutingEngine&) = delete;
    RoutingEngine& operator=(const RoutingEngine&) = delete;

    // Called from the message/UI thread. Takes ownership of `next`. May
    // allocate/free (sweeps retired snapshots that are no longer hazarded).
    void publish(std::unique_ptr<RoutingSnapshot> next);

    // Called from the audio thread. Never allocates, never blocks. Returns
    // nullptr only if publish() has never been called yet.
    const RoutingSnapshot* acquireForRender();

private:
    std::atomic<RoutingSnapshot*> active{nullptr};
    std::atomic<RoutingSnapshot*> hazard{nullptr};

    // Only ever touched from the publish() thread.
    std::vector<std::unique_ptr<RoutingSnapshot>> retired;
};

} // namespace resoset
