import {
  THEME_LABELS,
  THEME_NAMES,
  type ThemeName,
} from "../../../../lib/theme";
import { ToggleButton } from "../../../../components/ui";
import { SettingsSection } from "../../components/SettingsPrimitives";
import type { ThemeControls } from "../../types";

/**
 * A theme swatch: the accent over the panel colour, plus three track colours.
 *
 * Rendered by applying the theme's own selector to a bare element rather than
 * by listing hexes here -- the swatch is then literally the theme, and cannot
 * drift from it.
 */
function ThemeSwatch({ name }: { name: ThemeName }) {
  return (
    <span
      aria-hidden
      // The swatch IS the theme: its own selector is applied here, so it can
      // never drift from what picking it actually does. The default family
      // carries no name -- that is the base stylesheet.
      data-theme="dark"
      {...(name === "default" ? {} : { "data-theme-name": name })}
      className="dark flex h-6 w-12 shrink-0 items-center gap-0.5 overflow-hidden rounded-md border border-default/40 bg-background px-1"
    >
      <span className="h-3 w-3 shrink-0 rounded-full bg-accent" />
      <span
        className="h-3 w-1.5 shrink-0 rounded-sm"
        style={{ background: "var(--track-color-0)" }}
      />
      <span
        className="h-3 w-1.5 shrink-0 rounded-sm"
        style={{ background: "var(--track-color-4)" }}
      />
      <span
        className="h-3 w-1.5 shrink-0 rounded-sm"
        style={{ background: "var(--track-color-8)" }}
      />
    </span>
  );
}

export function AppearanceSettingsTab({ theme }: { theme: ThemeControls }) {
  return (
    <div className="flex flex-col gap-4">
      <SettingsSection
        title="Theme"
        description="Each one recolours the whole interface, including the track, light and bus palettes. Track colours stay as easy to tell apart as the default set — that was measured, not eyeballed."
      >
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {THEME_NAMES.map((name) => (
            <ToggleButton
              key={name}
              size="sm"
              tone="accent-soft"
              isSelected={theme.name === name}
              onChange={() => theme.setName(name)}
              className="w-full justify-start gap-2.5 px-2.5"
            >
              <ThemeSwatch name={name} />
              <span className="font-semibold">{THEME_LABELS[name]}</span>
            </ToggleButton>
          ))}
        </div>
      </SettingsSection>
    </div>
  );
}
