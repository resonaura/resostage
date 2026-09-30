import { TOGGLE_BLINK_ACCENT } from "@/components/ui";

/**
 * Mute / Solo.
 *
 * Soft tones rather than a saturated fill: a console is a wall of these, and
 * twelve solid red blocks read as an error state rather than as twelve
 * controls. The soft tones still carry full-strength foreground colour (see
 * styles/tones.css), so an engaged mute is unmistakable from across a stage
 * without shouting when it is off.
 */
export function StripButton({
  active,
  variant,
  soloSafe = false,
  blink,
  children,
  onPress,
  onContextMenu,
  title,
}: {
  active: boolean;
  variant: "mute" | "solo";
  soloSafe?: boolean;
  blink?: boolean;
  children: React.ReactNode;
  onPress: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onContextMenu?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  title?: string;
}) {
  const isMute = variant === "mute";

  // Apple Logic Pro X semantic tokens
  const activeClass = isMute
    ? "bg-[var(--rs-mute)] text-white border-[var(--rs-mute)] shadow-[0_0_8px_rgba(0,122,255,0.6)] font-black"
    : "bg-[var(--rs-solo)] text-black border-[var(--rs-solo)] shadow-[0_0_8px_rgba(255,214,10,0.6)] font-black";

  const inactiveClass =
    "bg-surface/60 text-foreground/75 border-default/30 hover:bg-surface hover:text-foreground";

  return (
    <button
      type="button"
      onClick={onPress}
      onContextMenu={onContextMenu}
      title={title}
      className={`relative flex h-6 flex-1 items-center justify-center rounded border text-[11px] font-bold transition-all select-none ${
        active ? activeClass : inactiveClass
      } ${blink ? TOGGLE_BLINK_ACCENT : ""} ${
        soloSafe ? "ring-1 ring-danger ring-inset" : ""
      }`}
    >
      <span className="relative z-10 flex items-center justify-center">
        {children}
      </span>
      {soloSafe && (
        <span
          className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none select-none text-danger font-black text-sm"
          style={{ transform: "rotate(-25deg)" }}
        >
          /
        </span>
      )}
    </button>
  );
}
