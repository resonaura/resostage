#include "RoutingEngine.h"

namespace resoset {

RoutingEngine::RoutingEngine() = default;
RoutingEngine::~RoutingEngine() = default;

void RoutingEngine::publish(std::unique_ptr<RoutingSnapshot> next) {
    RoutingSnapshot* raw = next.release();
    RoutingSnapshot* previous = active.exchange(raw, std::memory_order_acq_rel);

    if (previous != nullptr)
        retired.push_back(std::unique_ptr<RoutingSnapshot>(previous));

    // Sweep: free any retired snapshot the reader is no longer hazarding.
    // Whatever IS still hazarded (the reader is mid-render against it) is
    // left in place until a future publish() observes it's no longer hazarded.
    const RoutingSnapshot* currentHazard = hazard.load(std::memory_order_acquire);
    for (size_t i = 0; i < retired.size();) {
        if (retired[i].get() != currentHazard) {
            retired[i] = std::move(retired.back());
            retired.pop_back();
        } else {
            ++i;
        }
    }
}

const RoutingSnapshot* RoutingEngine::acquireForRender() {
    // Protect-and-validate: publish our intent to read `p` into the hazard
    // slot, then confirm `active` hasn't moved on since we loaded it. If it
    // has, the snapshot we grabbed may already be mid-reclamation elsewhere;
    // re-protect the new value and re-check until stable.
    RoutingSnapshot* p = active.load(std::memory_order_acquire);
    for (;;) {
        hazard.store(p, std::memory_order_release);
        RoutingSnapshot* recheck = active.load(std::memory_order_acquire);
        if (recheck == p)
            return p;
        p = recheck;
    }
}

} // namespace resoset
