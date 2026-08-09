import { useEffect, useRef } from "react";
import { addRafTask } from "../../lib/rafLoop";
import { onThemeChanged, roleColor } from "../../lib/theme";

const VU_MIN_DB = -40;
const VU_MAX_DB = 7;

const PIVOT_X = 537.57412;
const PIVOT_Y = 730.481;
const NEEDLE_TIP_X = 184.04706;
const NEEDLE_TIP_Y = 291.70923;

// Калиброванная карта углов
const DB_MAP: Array<{ db: number; rot: number }> = [
  { db: -40, rot: -8.9 },
  { db: -20, rot: 3.5 },
  { db: -10, rot: 11.2 },
  { db: -7, rot: 19.8 },
  { db: -5, rot: 29.3 },
  { db: -3, rot: 39.6 },
  { db: -1, rot: 48.1 },
  { db: 0, rot: 53.5 },
  { db: 3, rot: 65.1 },
  { db: 5, rot: 77.3 },
  { db: 7, rot: 86.4 },
];

function dbToRotation(db: number): number {
  const clampedDb = Math.max(VU_MIN_DB, Math.min(VU_MAX_DB, db));

  for (let i = 0; i < DB_MAP.length - 1; i++) {
    const p1 = DB_MAP[i];
    const p2 = DB_MAP[i + 1];
    if (clampedDb >= p1.db && clampedDb <= p2.db) {
      const t = (clampedDb - p1.db) / (p2.db - p1.db);
      return p1.rot + t * (p2.rot - p1.rot);
    }
  }
  return DB_MAP[DB_MAP.length - 1].rot;
}

/**
 * The dial face, in the current theme's colours.
 *
 * The plate is drawn from tokens rather than baked as `#000`/`#ccc` because a
 * VU is almost entirely canvas: nothing about it follows a theme unless it is
 * resolved here first. Keeping plate and ink at opposite ends of the mode's
 * own background/foreground is also what makes the face invert by itself in
 * light mode -- a backlit plate becomes a printed one, which is what a real
 * VU looks like under either kind of light.
 */
function faceSvg(c: FaceColors): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 600">
  <defs>
    <filter id="redGlow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="4" result="blur" />
      <feComponentTransfer in="blur" result="brightBlur">
        <feFuncA type="linear" slope="0.4"/>
      </feComponentTransfer>
      <feMerge>
        <feMergeNode in="brightBlur" />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
  </defs>
  <rect x="0.5" y="0.5" width="1077" height="598" rx="36" ry="36" fill="${c.plate}"/>
  <path d="m 657,277.24518 c 85.60879,8.87328 173.21481,25.29511 295.97922,75.9692" fill="none" stroke="${c.hot}" stroke-width="15" filter="url(#redGlow)"/>
  <path d="m 126.01626,357.7731 c 161.49448,-60.14366 315.01211,-98.096 531.2366,-81.4418" fill="none" stroke="${c.scale}" stroke-width="15"/>
  <g fill="none" stroke="${c.scale}" stroke-width="8">
    <path d="m 210.72277,271.30126 34.37058,47.77511" />
    <path d="m 285.65064,249.6478 27.49646,52.24328" />
    <path d="m 365.73409,233.49363 18.56011,52.93069" />
    <path d="m 451.66054,221.12022 8.93635,53.96181" />
    <path d="m 544.1174,217.33945 -0.68741,53.96181" />
    <path d="m 620.76379,220.0891 -8.59264,53.2744" />
  </g>
  <g fill="none" stroke="${c.hot}" stroke-width="8" filter="url(#redGlow)">
    <path d="m 669.22631,226.96322 -14.43565,56.36775" />
    <path d="m 777.83734,243.8048 -24.40311,48.80622" />
    <path d="m 864.4512,318.73266 34.37058,-43.65063" />
  </g>
  <g fill="${c.scale}" font-family="sans-serif" font-size="40">
    <text x="612.89453" y="196.49496">1</text>
    <text x="530.54688" y="194.96762">3</text>
    <text x="439.58594" y="202.49496">5</text>
    <text x="348.78125" y="210.49496">7</text>
    <text x="251.89453" y="221.96762">10</text>
    <text x="160.42969" y="243.96762">20</text>
  </g>
  <g fill="${c.hot}" font-family="sans-serif" font-size="40" font-weight="bold" filter="url(#redGlow)">
    <text x="902.58594" y="255.49496">5</text>
    <text x="775.54688" y="218.96762">3</text>
    <text x="663.13672" y="202.96762">0</text>
  </g>
  <text x="492.73926" y="393.86093" font-family="sans-serif" font-size="50" font-weight="900" fill="${c.scale}">VU</text>
  <g fill="none" stroke="${c.needle}" stroke-width="5">
    <path d="m 82,292 45.3061,0" />
  </g>
  <g fill="none" stroke="${c.hot}" stroke-width="5" filter="url(#redGlow)">
    <path d="m 948.30743,285.82189 45.3061,0" />
    <path d="m 970.96048,263.16884 0,45.3061" />
  </g>
</svg>
`)}`;
}

interface FaceColors {
  plate: string;
  scale: string;
  hot: string;
  needle: string;
}

// The dial face is a static SVG data URL. Decoding it is per-document work,
// not per-meter work, so every VU on screen shares one <img> instead of each
// one kicking off its own decode of the same bytes.
//
// A theme swap invalidates it: the old <img> is dropped, every meter picks the
// new one up on its next frame, and each keeps blitting its already-rasterized
// face until the replacement has decoded -- so the dial recolours without ever
// flashing empty.
let sharedFaceImage: HTMLImageElement | null = null;
let sharedFaceColors: FaceColors | null = null;

function currentFaceColors(): FaceColors {
  return {
    plate: roleColor("vuPlate"),
    scale: roleColor("vuScale"),
    hot: roleColor("vuHot"),
    needle: roleColor("vuNeedle"),
  };
}

function faceImage(): HTMLImageElement {
  if (!sharedFaceImage) {
    sharedFaceColors = currentFaceColors();
    sharedFaceImage = new Image();
    sharedFaceImage.src = faceSvg(sharedFaceColors);
  }
  return sharedFaceImage;
}

/**
 * Rasterized dial faces, shared by every meter drawing at the same size.
 *
 * The face is already rasterized once per meter rather than once per frame,
 * which was the big win. This is the next one: a player with a master, four
 * sends and a dozen output lanes draws a dozen meters at *identical* sizes,
 * and each was keeping its own pixel-for-pixel duplicate of the same plate --
 * at 2x DPR that is a dozen 352x288 bitmaps of the same picture.
 *
 * Keyed on the source image too, so a theme swap (which replaces the <img>)
 * invalidates every entry without anyone having to remember to clear it.
 */
const faceCache = new Map<string, HTMLCanvasElement>();
let faceCacheImage: HTMLImageElement | null = null;

function sharedFace(
  img: HTMLImageElement,
  w: number,
  h: number,
  dpr: number,
): HTMLCanvasElement | null {
  if (!img.complete || img.naturalWidth === 0) return null;
  if (faceCacheImage !== img) {
    faceCache.clear();
    faceCacheImage = img;
  }
  const bw = Math.max(1, Math.round(w * dpr));
  const bh = Math.max(1, Math.round(h * dpr));
  const key = `${bw}x${bh}`;
  const hit = faceCache.get(key);
  if (hit) return hit;

  const off = document.createElement("canvas");
  off.width = bw;
  off.height = bh;
  const octx = off.getContext("2d");
  if (!octx) return null;
  octx.scale(dpr, dpr);
  const scale = Math.min(w / 1080, h / 600);
  octx.translate((w - 1080 * scale) / 2, (h - 600 * scale) / 2);
  octx.scale(scale, scale);
  octx.drawImage(img, 0, 0, 1080, 600);
  faceCache.set(key, off);
  return off;
}

/** The needle and pivot, which are painted live rather than baked into the face. */
function needleColors(): { needle: string; plate: string } {
  const c = sharedFaceColors ?? currentFaceColors();
  return { needle: c.needle, plate: c.plate };
}

onThemeChanged(() => {
  sharedFaceImage = null;
  sharedFaceColors = null;
});

/** Needle movement below this (in degrees) is invisible -- treat as at rest. */
const REST_EPSILON_DEG = 0.02;

export function VUMeter({
  name,
  db,
  getDb,
  color,
}: {
  name: string;
  db: number;
  getDb?: () => number;
  color?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dbRef = useRef(db);
  dbRef.current = db;
  const getRef = useRef(getDb);
  getRef.current = getDb;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Never null once the SVG has decoded; sharedFace hands back the one
    // bitmap every meter of this size is using.
    let face: HTMLCanvasElement | null = null;

    // Сохраняем состояние текущего угла и сглаженного входного уровня
    const anim = {
      currentRot: DB_MAP[0].rot,
      smoothedDb: VU_MIN_DB,
    };
    // Everything the last painted frame depended on. When none of it moves,
    // the canvas already holds the right pixels and the whole draw is skipped
    // -- which is the normal state of a stopped or silent channel.
    let paintedRot = Number.NaN;
    let paintedW = 0;
    let paintedH = 0;
    let paintedDpr = 0;
    let paintedFace: HTMLCanvasElement | null = null;

    const render = (_nowMs: number, dt: number) => {
      const live = getRef.current?.();
      const raw =
        live !== undefined && Number.isFinite(live) ? live : dbRef.current;
      const rawTargetDb = Math.max(VU_MIN_DB, Math.min(VU_MAX_DB, raw));

      // 1. Фильтр низкой частоты на входные дБ (гасит резкий микрофонный/аудио шум)
      const inputSmoothing = 1 - Math.exp(-25 * dt);
      anim.smoothedDb += (rawTargetDb - anim.smoothedDb) * inputSmoothing;

      // 2. Расчет идеального угла
      const targetRot = dbToRotation(anim.smoothedDb);

      // 3. Аналоговая инерция стрелки
      if (targetRot >= anim.currentRot) {
        // Плавная атака с инерцией (подъем)
        const attackEase = 1 - Math.exp(-18 * dt);
        anim.currentRot += (targetRot - anim.currentRot) * attackEase;
      } else {
        // Мягкий, слегка вязкий спад (релиз)
        const decayEase = 1 - Math.exp(-8 * dt);
        anim.currentRot += (targetRot - anim.currentRot) * decayEase;
      }

      // Отсекаем бесконечно малый хвост при возврате на ноль
      if (Math.abs(anim.currentRot - targetRot) < 0.005) {
        anim.currentRot = targetRot;
      }

      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      if (w <= 0 || h <= 0) return;

      face = sharedFace(faceImage(), w, h, dpr);

      const geometryChanged =
        w !== paintedW || h !== paintedH || dpr !== paintedDpr;
      const needleMoved =
        !Number.isFinite(paintedRot) ||
        Math.abs(anim.currentRot - paintedRot) >= REST_EPSILON_DEG;
      // `face` flips from null to a bitmap once the SVG finishes decoding --
      // that first arrival has to force a repaint or the dial stays blank
      // until the needle happens to move.
      if (!geometryChanged && !needleMoved && face === paintedFace) return;

      paintedRot = anim.currentRot;
      paintedW = w;
      paintedH = h;
      paintedDpr = dpr;
      paintedFace = face;

      const bw = Math.max(1, Math.round(w * dpr));
      const bh = Math.max(1, Math.round(h * dpr));
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      // Background (pre-rasterized at exactly this size — 1:1 device blit).
      if (face) ctx.drawImage(face, 0, 0);

      ctx.save();
      ctx.scale(dpr, dpr);

      const scale = Math.min(w / 1080, h / 600);
      const offsetX = (w - 1080 * scale) / 2;
      const offsetY = (h - 600 * scale) / 2;

      ctx.translate(offsetX, offsetY);
      ctx.scale(scale, scale);

      // Маска прибора
      ctx.beginPath();
      ctx.rect(0, 0, 1080, 600);
      ctx.clip();

      // Needle
      const rotRad = (anim.currentRot * Math.PI) / 180;

      ctx.save();
      ctx.translate(PIVOT_X, PIVOT_Y);
      ctx.rotate(rotRad);

      ctx.shadowColor = "rgba(0, 0, 0, 0.5)";
      ctx.shadowBlur = 4;
      ctx.shadowOffsetX = 2.5;
      ctx.shadowOffsetY = 2.5;

      const ink = needleColors();

      ctx.beginPath();
      ctx.moveTo(NEEDLE_TIP_X - PIVOT_X, NEEDLE_TIP_Y - PIVOT_Y);
      ctx.lineTo(0, 0);
      ctx.strokeStyle = ink.needle;
      ctx.lineWidth = 6.7;
      ctx.lineCap = "butt";
      ctx.stroke();
      ctx.restore();

      // Pivot dot, ringed in the plate colour so it reads as seated in the
      // face rather than floating on it.
      ctx.beginPath();
      ctx.arc(PIVOT_X, PIVOT_Y, 3.78, 0, Math.PI * 2);
      ctx.fillStyle = ink.needle;
      ctx.fill();
      ctx.lineWidth = 0.6;
      ctx.strokeStyle = ink.plate;
      ctx.stroke();

      ctx.restore();
    };

    // ── Only run while on screen ────────────────────────────────────────
    //
    // The bus panel renders every group, and a real rig has a master, four
    // sends and a dozen output lanes: measured on the player, twelve canvases
    // laid out to x=3393 in a 1680px window. Eleven of them were stepping
    // ballistics and scanning the whole live-levels array sixty times a
    // second to move a needle nobody could see.
    //
    // Gating beats windowing the DOM here. The canvas stays mounted and keeps
    // the pixels it last painted, so scrolling one back into view shows a
    // dial rather than a blank -- and it works unchanged for the compact
    // density, which wraps and scrolls vertically instead.
    let stopRaf: (() => void) | null = null;
    const start = () => {
      if (stopRaf) return;
      // Re-entering after a pause: the needle would otherwise sweep up from
      // wherever it was parked, which reads as a meter catching up rather
      // than a meter that was simply off screen.
      const live = getRef.current?.();
      const at = live !== undefined && Number.isFinite(live) ? live : dbRef.current;
      anim.smoothedDb = Math.max(VU_MIN_DB, Math.min(VU_MAX_DB, at));
      anim.currentRot = dbToRotation(anim.smoothedDb);
      stopRaf = addRafTask(render);
    };
    const stop = () => {
      stopRaf?.();
      stopRaf = null;
    };

    // No IntersectionObserver (jsdom, ancient webview): just always run, which
    // is exactly the old behaviour.
    if (typeof IntersectionObserver === "undefined") {
      start();
      return stop;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) start();
          else stop();
        }
      },
      // A screen of slack on each side: a meter is already live by the time
      // the scroll actually reaches it, so it is never caught mid-sweep.
      { rootMargin: "200px" },
    );
    observer.observe(canvas);

    return () => {
      observer.disconnect();
      stop();
    };
  }, []);

  return (
    <div className="relative block h-full w-full select-none">
      <canvas ref={canvasRef} className="block h-full w-full" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0.5 flex items-center justify-center gap-1.5 px-2">
        {color && (
          <span
            className="h-2 w-2 rounded-full shrink-0 shadow-[0_0_4px_rgba(0,0,0,0.6)]"
            style={{ backgroundColor: color }}
          />
        )}
        <span className="truncate text-[9px] font-bold tracking-widest text-foreground/80 drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]">
          {name}
        </span>
      </div>
    </div>
  );
}
