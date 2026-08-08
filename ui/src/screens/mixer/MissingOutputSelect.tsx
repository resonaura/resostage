import type { CSSProperties, ReactElement, ReactNode } from "react";
import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useState,
} from "react";
import { resolveCssVar } from "../../lib/cssColor";

type SelectLike =
  | ReactElement<{ style?: CSSProperties }>
  | ReactElement<
      { style?: CSSProperties },
      string | ((props: { style?: CSSProperties }) => ReactElement | null)
    >;

/**
 * Serialise a physical-output pick that is present in the mapping but no
 * longer reachable on the device. Used as an <option value> so the select
 * still shows exactly what the route targets, even though that output is gone
 * (rather than silently snapping to a different, available device output).
 */

// Warning-triangle (lucide TriangleAlert) inlined as an SVG so it can be
// painted as a background-image INSIDE the native <select> box -- exactly
// aligned with the control's own text line, instead of an overlay next to it.
// Stroke color will be injected dynamically from --warning CSS variable.
function getWarnIconSvg(color: string): string {
  return encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`,
  );
}

/**
 * Wrapper that injects an attention triangle INTO the select box itself (left
 * edge, vertically centered against the control's text) when the
 * currently-selected output is the missing one -- instead of a warning banner
 * below the control or an overlay next to it. The missing option itself is
 * still rendered as an <option> inside the select (that is the caller's job),
 * so the naming survives.
 */
export function MissingSelectFrame({
  missing,
  children,
}: {
  missing: boolean;
  children: ReactNode;
}) {
  const [warningColor, setWarningColor] = useState("#fbbf24");

  useEffect(() => {
    const color = resolveCssVar("--warning", "#fbbf24");
    setWarningColor(color);
  }, []);

  if (!missing) return <>{children}</>;

  const warnIconSvg = getWarnIconSvg(warningColor);

  return (
    <>
      {Children.map(children, (child) => {
        if (!isValidElement<ReactElement>(child)) return child;
        const styled = child as SelectLike;
        return cloneElement(styled, {
          style: {
            ...(styled.props.style ?? {}),
            appearance: "none",
            WebkitAppearance: "none",
            MozAppearance: "textfield",
            backgroundImage: `url("data:image/svg+xml,${warnIconSvg}")`,
            backgroundPosition: "6px center",
            backgroundRepeat: "no-repeat",
            backgroundSize: "12px 12px",
            paddingLeft: "20px",
            // Warning colour the whole control when it holds a missing output.
            backgroundColor:
              "color-mix(in oklab, var(--warning) 15%, transparent)",
            boxShadow:
              "inset 0 0 0 1px color-mix(in oklab, var(--warning) 50%, transparent)",
            color: "var(--warning)",
          },
        });
      })}
    </>
  );
}
