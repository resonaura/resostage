/**
 * Class strings shared by the two light editors.
 *
 * HeroUI's Button/ToggleButton are sized for a toolbar: `h-9`, `px-4`,
 * `rounded-3xl`, `whitespace-nowrap`, and SVGs forced to `size-4`. That is the
 * right default for a row of three buttons and completely wrong for the dense
 * grids these panels are made of -- two dozen effect tiles in a 230px sidebar
 * column, where a nowrap "Barberpole" simply runs out over its neighbours.
 * Utilities win over the component layer (see @heroui/styles' `@layer theme,
 * base, components, utilities`), so these overrides are just Tailwind classes.
 */

/**
 * ToggleButtonGroup is a toolbar row first and foremost: `inline-flex w-fit
 * items-center justify-center`. Any grid or list built from it has to reset
 * that, otherwise the rows shrink-wrap and centre themselves inside the card.
 */
export const TOGGLE_GROUP_CLS = "w-full items-stretch justify-start";

/** Section / field caption. */
export const CAPTION_CLS =
  "text-[11px] font-semibold uppercase tracking-wide text-muted";

/** Grid cell with an icon above a label (effects, fixture shapes). Fixed
 *  height so a one-line and a two-line label still line up in the grid. */
export const TILE_TOGGLE_CLS =
  "h-13 w-full min-w-0 flex-col justify-center gap-1 rounded-lg px-0.5 py-1 " +
  "text-center text-[9px] leading-tight whitespace-normal [&>svg]:m-0 [&>svg]:size-4";

/** Grid cell with a text label only (gradient palettes, colour types, idle
 *  behaviour). Wraps instead of overflowing; grows to fit two lines. */
export const CELL_TOGGLE_CLS =
  "h-auto min-h-8 w-full min-w-0 rounded-lg px-2 py-1 " +
  "text-center text-[10px] leading-tight whitespace-normal";

/** Narrow monospaced cell (tempo subdivisions) -- no room for any padding. */
export const TIGHT_TOGGLE_CLS =
  "h-7 w-full min-w-0 rounded-md px-0 font-mono text-[9px]";

/** Inline chip-sized toggle (tempo sync, discovered board IPs). */
export const CHIP_TOGGLE_CLS =
  "h-6 gap-1 rounded-md px-2 text-[10px] [&>svg]:size-3";
