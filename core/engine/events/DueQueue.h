#pragma once

#include <cstddef>
#include <cstdint>
#include <utility>
#include <vector>

namespace resostage {

/**
 * Holding scheduled work until its moment, and letting nothing fall out.
 *
 * Timeline triggers are stamped with the host time at which their audio will
 * be heard rather than the time it was rendered (see timing/OutputLatency.h),
 * so whoever delivers them has to wait. That waiting is a few lines of list
 * compaction, and those few lines already produced one silent, expensive bug:
 *
 * Compacting in place with `pending[kept++] = std::move(pending[i])` moves an
 * element onto ITSELF whenever nothing has been sent yet, because `kept` and
 * `i` are then the same index. Self-move-assignment leaves a std::string in a
 * valid but unspecified state -- empty, in practice. So a trigger that waited
 * even one pass had its URL quietly erased, and the send that followed
 * "succeeded" against an unparseable address. Nothing logged, nothing threw,
 * the cue simply never arrived.
 *
 * It lives here, apart from the dispatcher, because the dispatcher's own
 * version is wrapped in sockets and threads and cannot be tested against a
 * clock you control -- and this is arithmetic and moves, which can.
 */

/**
 * Sends everything due at `now`, keeps the rest, and preserves order.
 *
 * `T` needs a `targetHostTimeNanos` member. `send` is called with a const
 * reference to each due item, in the order they were queued.
 *
 * Late is not the same as lost: an item whose moment has already passed is
 * sent, not dropped. A cue that missed by a few milliseconds still has to
 * fire, because the alternative is a light that never comes on at all.
 */
template <typename T, typename SendFn>
size_t drainDue(std::vector<T>& pending, uint64_t now, SendFn&& send) {
    size_t sent = 0;
    size_t kept = 0;
    for (size_t i = 0; i < pending.size(); ++i) {
        if (pending[i].targetHostTimeNanos <= now) {
            send(static_cast<const T&>(pending[i]));
            ++sent;
        } else {
            // The guard that the original was missing.
            if (kept != i)
                pending[kept] = std::move(pending[i]);
            ++kept;
        }
    }
    pending.resize(kept);
    return sent;
}

/**
 * Resizes a per-event "already fired" vector to match the song's event list.
 *
 * Sounds trivial; was a real bug. The vector is sized when a song is STAGED,
 * and the loop that fires events stops at ITS length -- so an event appended
 * to the song already open sat outside the bound and never fired, no matter
 * how many times the operator pressed Play. Play only zeroed the flags that
 * already existed. The only way to arm it was to switch songs and come back,
 * which is not a thing anyone would think to try.
 *
 * Grows with zeros (a new event is armed) and preserves what is already
 * there, so adding a trigger halfway through a song does not re-fire every
 * trigger before it.
 */
inline void resizeFiredFlags(std::vector<uint8_t>& flags, size_t eventCount) {
    if (flags.size() == eventCount)
        return;
    flags.resize(eventCount, 0);
}

} // namespace resostage
