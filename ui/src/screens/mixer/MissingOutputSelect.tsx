import { TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import type { Tone } from "../../components/ui";

/**
 * How a routing picker says "this output is gone".
 *
 * A route can name a physical output the current device does not have -- a
 * project authored against an 8-out interface, opened on a laptop. The picker
 * deliberately stays on that pick rather than snapping to an available output
 * (silently rerouting a show is worse than showing it is broken), so it has to
 * look wrong: the whole control goes soft warning, with a triangle ahead of
 * the value.
 *
 * This used to be a wrapper component that cloned the native `<select>` and
 * injected inline styles plus a background-image triangle positioned by hand
 * against the control's text line. The Select wrapper takes a tone and start
 * content directly, so it is now just those two props, spread at the call site.
 */
export function missingOutputSelectProps(missing: boolean): {
  tone?: Tone;
  startContent?: ReactNode;
} {
  if (!missing) return {};
  return {
    tone: "warning-soft",
    startContent: (
      <TriangleAlert
        size={11}
        className="shrink-0"
        aria-label="Output unavailable on this device"
      />
    ),
  };
}
