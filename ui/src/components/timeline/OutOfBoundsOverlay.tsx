/**
 * The dimmed canvas past the end of the project.
 *
 * Logic shades everything after the project end marker, and the shading is
 * doing real work: it is the difference between "the arrangement is over" and
 * "the arrangement continues and happens to be empty here". Without it, free
 * canvas and a silent stretch of song look identical, so it is never obvious
 * whether dragging something out there would extend the project or drop it
 * into nowhere.
 *
 * Purely decorative -- `pointer-events: none` throughout. Everything out here
 * still accepts drops and drags; the slack is somewhere you CAN work, it is
 * just not somewhere the transport will go (see the playhead clamp in
 * AudioEngine::songLengthFrames and Timeline's own scrub clamp).
 */
export function OutOfBoundsOverlay({
  startPx,
  widthPx,
  height,
}: {
  /** Where the project ends, in content pixels. */
  startPx: number;
  /** How much slack follows it. */
  widthPx: number;
  /** Full height of the scrollable arrangement, or "100%". */
  height?: number | string;
}) {
  if (widthPx <= 0) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute top-0 z-[5]"
      style={{
        left: startPx,
        width: widthPx,
        height: height ?? "100%",
        // Hatching, not shading.
        //
        // Logic darkens this area, which works because its lanes are mid-grey.
        // Ours are near-black already, so darkening them further is invisible
        // -- the first attempt at this was a 62% wash over `--background` and
        // could not be told apart from an empty lane. A hatch reads as "not
        // part of the project" at any lane colour and at any brightness,
        // including on a stage at night with the screen dimmed right down.
        backgroundColor:
          "color-mix(in oklab, var(--background) 45%, transparent)",
        backgroundImage: `repeating-linear-gradient(
          45deg,
          color-mix(in oklab, var(--foreground) 4%, transparent) 0px,
          color-mix(in oklab, var(--foreground) 4%, transparent) 1px,
          transparent 1px,
          transparent 7px
        )`,
      }}
    >
      {/* The boundary itself, so the edge of the project is a line you can
          see rather than just where the dimming starts. */}
      <div
        className="absolute inset-y-0 left-0 w-px"
        style={{
          backgroundColor:
            "color-mix(in oklab, var(--foreground) 22%, transparent)",
        }}
      />
    </div>
  );
}
