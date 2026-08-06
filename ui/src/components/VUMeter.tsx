import { useEffect, useRef } from "react";

// A 1:1 recreation of the analog VU meter reference (cream face, black scale,
// red drive arcs, drop-shadowed needle, VU legend + scale numerals). The
// needle rotates around the same hidden pivot below the frame, but is driven
// by the live level instead of the CSS keyframes: ballistic smoothing, fast
// rise / lazy fall. Pure SVG -- nothing per-frame but one transform attribute.

const VU_MIN_DB = -20;
const VU_MAX_DB = 6;
const ROT_MIN = 0; // degrees, needle parked on the "-20" numeral at silence
const ROT_MAX = 75; // degrees, needle at +6 dB
const VU_ATTACK_DB_PER_SEC = 360;
const VU_DECAY_DB_PER_SEC = 26;
// Pivot is BELOW the visible frame (same as the reference).
const PIVOT_X = 537.57412;
const PIVOT_Y = 730.481;

export function VUMeter({
  name,
  db,
  getDb,
}: {
  name: string;
  db: number;
  getDb?: () => number;
}) {
  const needleRef = useRef<SVGPathElement | null>(null);
  const dbRef = useRef(db);
  dbRef.current = db;
  const getRef = useRef(getDb);
  getRef.current = getDb;

  useEffect(() => {
    const needle = needleRef.current;
    if (!needle) return;
    const anim = { display: VU_MIN_DB, lastT: 0 };
    let raf = 0;

    const tick = (t: number) => {
      const dt =
        anim.lastT > 0 ? Math.min(0.25, (t - anim.lastT) / 1000) : 1 / 60;
      anim.lastT = t;

      const live = getRef.current?.();
      const raw =
        live !== undefined && Number.isFinite(live) ? live : dbRef.current;
      const target = Math.max(raw, VU_MIN_DB);
      if (target >= anim.display)
        anim.display = Math.min(target, anim.display + VU_ATTACK_DB_PER_SEC * dt);
      else
        anim.display = Math.max(target, anim.display - VU_DECAY_DB_PER_SEC * dt);

      const norm = Math.max(
        0,
        Math.min(1, (anim.display - VU_MIN_DB) / (VU_MAX_DB - VU_MIN_DB)),
      );
      const rot = ROT_MIN + norm * (ROT_MAX - ROT_MIN);
      needle.setAttribute(
        "transform",
        `rotate(${rot.toFixed(2)} ${PIVOT_X} ${PIVOT_Y})`,
      );
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="relative block h-full w-full select-none">
      <svg
        viewBox="0 0 1080 600"
        className="block h-full w-full"
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <filter id="vuShadowBig" x="-20%" y="-20%" width="140%" height="160%">
            <feDropShadow
              dx="3"
              dy="3"
              stdDeviation="8"
              floodColor="#000000"
              floodOpacity="0.5"
            />
          </filter>
          <filter id="vuShadowSmall" x="-40%" y="-40%" width="180%" height="180%">
            <feDropShadow
              dx="2.5"
              dy="2.5"
              stdDeviation="4"
              floodColor="#000000"
              floodOpacity="0.5"
            />
          </filter>
        </defs>

        {/* Panel */}
        <rect
          x="0.5"
          y="0.5"
          width="1077"
          height="633"
          fill="#ffeea9"
          filter="url(#vuShadowBig)"
        />

        {/* Lens base */}
        <path
          d="m 537.18074,590.23438 a 150.76556,150.76556 0 0 0 -107.3086,45.05078 l 214.73829,0 A 150.76556,150.76556 0 0 0 537.18074,590.23438 Z"
          fill="#000000"
        />

        {/* Red + black scale arcs */}
        <path
          d="m 657,277.24518 c 85.60879,8.87328 173.21481,25.29511 295.97922,75.9692"
          fill="none"
          stroke="#ff0000"
          strokeWidth="15"
          strokeLinecap="butt"
        />
        <path
          d="m 126.01626,357.7731 c 161.49448,-60.14366 315.01211,-98.096 531.2366,-81.4418"
          fill="none"
          stroke="#000000"
          strokeWidth="15"
          strokeLinecap="butt"
        />

        {/* Ticks */}
        <g fill="none" stroke="#000000" strokeWidth="8" strokeLinecap="butt">
          <path d="m 210.72277,271.30126 34.37058,47.77511" />
          <path d="m 285.65064,249.6478 27.49646,52.24328" />
          <path d="m 365.73409,233.49363 18.56011,52.93069" />
          <path d="m 451.66054,221.12022 8.93635,53.96181" />
          <path d="m 544.1174,217.33945 -0.68741,53.96181" />
          <path d="m 620.76379,220.0891 -8.59264,53.2744" />
        </g>
        <path
          d="m 669.22631,226.96322 -14.43565,56.36775"
          fill="none"
          stroke="#ff0000"
          strokeWidth="8"
          strokeLinecap="butt"
        />

        {/* Needle */}
        <path
          ref={needleRef}
          d="M 184.04706,291.70923 537.57412,730.481"
          fill="none"
          stroke="#000000"
          strokeWidth="6.7"
          strokeLinecap="butt"
          strokeDasharray="430"
          filter="url(#vuShadowSmall)"
          transform={`rotate(${ROT_MIN} ${PIVOT_X} ${PIVOT_Y})`}
        />

        {/* Red over-drive tick pair */}
        <path
          d="m 777.83734,243.8048 -24.40311,48.80622"
          fill="none"
          stroke="#ff0000"
          strokeWidth="8"
          strokeLinecap="butt"
        />
        <path
          d="m 864.4512,318.73266 34.37058,-43.65063"
          fill="none"
          stroke="#ff0000"
          strokeWidth="8"
          strokeLinecap="butt"
        />

        {/* Pivot */}
        <ellipse
          cx="537.66882"
          cy="730.48907"
          rx="3.7858648"
          ry="3.5416155"
          fill="#ffffff"
          stroke="#0000ff"
          strokeWidth="0.61062336"
        />

        {/* Scale numerals */}
        <g fill="#000000" fontFamily="sans-serif" fontSize="40">
          <text x="902.58594" y="255.49496">5</text>
          <text x="775.54688" y="218.96762">3</text>
          <text x="663.13672" y="202.96762">0</text>
          <text x="612.89453" y="196.49496">1</text>
          <text x="530.54688" y="194.96762">3</text>
          <text x="439.58594" y="202.49496">5</text>
          <text x="348.78125" y="210.49496">7</text>
          <text x="251.89453" y="221.96762">10</text>
          <text x="160.42969" y="243.96762">20</text>
        </g>

        {/* VU legend */}
        <text
          x="492.73926"
          y="393.86093"
          fontFamily="sans-serif"
          fontSize="50"
          fontWeight="900"
          fill="#000000"
        >
          VU
        </text>

        {/* +/- corner marks */}
        <g fill="none" stroke="#000000" strokeWidth="5" strokeLinecap="butt">
          <path d="m 82,292 45.3061,0" />
          <path d="m 948.30743,285.82189 45.3061,0" />
          <path d="m 970.96048,263.16884 0,45.3061" />
        </g>
      </svg>

      <div className="pointer-events-none absolute inset-x-0 bottom-0.5 flex justify-center">
        <span className="truncate px-1 text-[9px] font-semibold tracking-widest text-foreground/70 drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
          {name}
        </span>
      </div>
    </div>
  );
}