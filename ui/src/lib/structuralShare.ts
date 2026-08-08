/**
 * Reuse the previous object graph wherever the new one is equal to it.
 *
 * Every telemetry frame arrives as fresh JSON, so `JSON.parse` hands back an
 * entirely new object graph ~30 times a second even when nothing in the
 * project changed. To React that reads as "all of it changed": the setlist,
 * the fixture roster, the device lists, every region of every song. Any
 * `useMemo` keyed on `state.songs`, any `React.memo` around a panel, any
 * effect with `state.lighting` in its dependencies re-fires on every frame,
 * because the *reference* moved even though the *value* did not.
 *
 * Walking the two graphs and handing back the OLD reference for every subtree
 * that compares equal restores the thing those APIs were designed around:
 * reference identity that means something. A playhead ticking forward now
 * produces a new top-level state object whose `songs`, `lighting`, `settings`
 * and `busses` are all still the exact objects from the previous frame.
 *
 * The comparison is cheap relative to what it replaces -- it walks the same
 * data `JSON.parse` just allocated, and it is bounded by frame size, whereas
 * the re-renders it prevents are bounded by how much UI is on screen.
 *
 * Only plain JSON shapes go through here (objects, arrays, primitives), which
 * is exactly what the wire carries.
 */
export function shareStructure<T>(prev: unknown, next: T): T {
  if (Object.is(prev, next)) return next;
  if (next === null || typeof next !== "object") return next;
  if (prev === null || typeof prev !== "object") return next;

  if (Array.isArray(next)) {
    if (!Array.isArray(prev)) return next;
    // Length differences still share element-wise: appending one region to a
    // song must not orphan the identity of the fifty regions before it.
    let identical = prev.length === next.length;
    const out: unknown[] = new Array(next.length);
    for (let i = 0; i < next.length; i++) {
      const shared = shareStructure(prev[i], next[i]);
      out[i] = shared;
      if (identical && !Object.is(shared, prev[i])) identical = false;
    }
    return (identical ? prev : out) as T;
  }
  if (Array.isArray(prev)) return next;

  const nextObj = next as Record<string, unknown>;
  const prevObj = prev as Record<string, unknown>;
  const nextKeys = Object.keys(nextObj);
  let identical = nextKeys.length === Object.keys(prevObj).length;
  const out: Record<string, unknown> = {};
  for (const key of nextKeys) {
    const shared = shareStructure(prevObj[key], nextObj[key]);
    out[key] = shared;
    if (identical && !Object.is(shared, prevObj[key])) identical = false;
  }
  return (identical ? prev : out) as T;
}
