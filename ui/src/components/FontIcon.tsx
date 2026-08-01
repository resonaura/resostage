// Thin wrapper around fontaudio (MIT, see assets/fontaudio/LICENSE) glyphs so
// they drop in next to lucide-react icons with the same tag-like usage --
// <FontIcon name="metronome" /> -- instead of each call site hand-writing an
// <i className="icon-fad-..."> and remembering the font's naming convention.
// Only add a name here once its glyph is actually vendored in fontaudio.css.
export type FontIconName = "metronome" | "midiplug";

export function FontIcon({
  name,
  size = 16,
  className = "",
  title,
}: {
  name: FontIconName;
  size?: number;
  className?: string;
  /** Accessible label. Omit for a purely decorative icon (e.g. next to its own text label). */
  title?: string;
}) {
  return (
    <i
      className={`icon-fad-${name} inline-block not-italic ${className}`}
      style={{ fontSize: size, lineHeight: 1 }}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      aria-label={title}
      title={title}
    />
  );
}
