/** Compact track volume slider with track-color accent. */
export function MiniSlider({
  value,
  min,
  max,
  step = 0.5,
  accent,
  onChange,
  defaultValue = 0,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  accent: string;
  onChange: (v: number) => void;
  defaultValue?: number;
}) {
  const percent = Math.max(
    0,
    Math.min(100, ((value - min) / (max - min)) * 100),
  );

  return (
    <div
      className="relative flex-1 flex items-center h-3 select-none touch-none"
      title="Double-click to reset"
      onDoubleClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onChange(defaultValue);
      }}
    >
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
      />
      {/* Track Background */}
      <div className="w-full h-1 rounded-full bg-default/20 overflow-hidden relative">
        {/* Accent Filled Track */}
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${percent}%`, backgroundColor: accent }}
        />
      </div>
      {/* HeroUI-Style Rounded Pill Thumb */}
      <div
        className="absolute h-2.5 w-3.5 rounded-full border border-background shadow-md pointer-events-none -translate-x-1/2"
        style={{ left: `${percent}%`, backgroundColor: accent }}
      />
    </div>
  );
}
