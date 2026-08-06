import { useEffect, useRef } from "react";

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

const SVG_BACKGROUND = `data:image/svg+xml;utf8,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 600">
  <rect x="0.5" y="0.5" width="1077" height="633" fill="#121214"/>
  <path d="m 657,277.24518 c 85.60879,8.87328 173.21481,25.29511 295.97922,75.9692" fill="none" stroke="#ff3b30" stroke-width="15"/>
  <path d="m 126.01626,357.7731 c 161.49448,-60.14366 315.01211,-98.096 531.2366,-81.4418" fill="none" stroke="#2a2a2e" stroke-width="15"/>
  <g fill="none" stroke="#cccccc" stroke-width="8">
    <path d="m 210.72277,271.30126 34.37058,47.77511" />
    <path d="m 285.65064,249.6478 27.49646,52.24328" />
    <path d="m 365.73409,233.49363 18.56011,52.93069" />
    <path d="m 451.66054,221.12022 8.93635,53.96181" />
    <path d="m 544.1174,217.33945 -0.68741,53.96181" />
    <path d="m 620.76379,220.0891 -8.59264,53.2744" />
  </g>
  <path d="m 669.22631,226.96322 -14.43565,56.36775" fill="none" stroke="#ff3b30" stroke-width="8"/>
  <path d="m 777.83734,243.8048 -24.40311,48.80622" fill="none" stroke="#ff3b30" stroke-width="8"/>
  <path d="m 864.4512,318.73266 34.37058,-43.65063" fill="none" stroke="#ff3b30" stroke-width="8"/>
  <g fill="#cccccc" font-family="sans-serif" font-size="40">
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
  <text x="492.73926" y="393.86093" font-family="sans-serif" font-size="50" font-weight="900" fill="#cccccc">VU</text>
  <g fill="none" stroke="#fff" stroke-width="5">
    <path d="m 82,292 45.3061,0" />
    <path d="m 948.30743,285.82189 45.3061,0" />
    <path d="m 970.96048,263.16884 0,45.3061" />
  </g>
</svg>
`)}`;

export function VUMeter({
  name,
  db,
  getDb,
}: {
  name: string;
  db: number;
  getDb?: () => number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bgImageRef = useRef<HTMLImageElement | null>(null);
  const dbRef = useRef(db);
  dbRef.current = db;
  const getRef = useRef(getDb);
  getRef.current = getDb;

  useEffect(() => {
    const img = new Image();
    img.src = SVG_BACKGROUND;
    bgImageRef.current = img;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Сохраняем состояние текущего угла и сглаженного входного уровня
    const anim = {
      currentRot: DB_MAP[0].rot,
      smoothedDb: VU_MIN_DB,
      lastT: 0,
    };
    let raf = 0;

    const render = (t: number) => {
      const dt =
        anim.lastT > 0 ? Math.min(0.1, (t - anim.lastT) / 1000) : 1 / 60;
      anim.lastT = t;

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

      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);

      const scale = Math.min(w / 1080, h / 600);
      const offsetX = (w - 1080 * scale) / 2;
      const offsetY = (h - 600 * scale) / 2;

      ctx.translate(offsetX, offsetY);
      ctx.scale(scale, scale);

      // Маска прибора
      ctx.beginPath();
      ctx.rect(0, 0, 1080, 600);
      ctx.clip();

      // Background
      if (bgImageRef.current && bgImageRef.current.complete) {
        ctx.drawImage(bgImageRef.current, 0, 0, 1080, 600);
      }

      // Needle
      const rotRad = (anim.currentRot * Math.PI) / 180;

      ctx.save();
      ctx.translate(PIVOT_X, PIVOT_Y);
      ctx.rotate(rotRad);

      ctx.shadowColor = "rgba(0, 0, 0, 0.5)";
      ctx.shadowBlur = 4;
      ctx.shadowOffsetX = 2.5;
      ctx.shadowOffsetY = 2.5;

      ctx.beginPath();
      ctx.moveTo(NEEDLE_TIP_X - PIVOT_X, NEEDLE_TIP_Y - PIVOT_Y);
      ctx.lineTo(0, 0);
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 6.7;
      ctx.lineCap = "butt";
      ctx.stroke();
      ctx.restore();

      // Pivot dot
      ctx.beginPath();
      ctx.arc(PIVOT_X, PIVOT_Y, 3.78, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.lineWidth = 0.6;
      ctx.strokeStyle = "#0000ff";
      ctx.stroke();

      ctx.restore();
      raf = requestAnimationFrame(render);
    };

    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="relative block h-full w-full select-none">
      <canvas ref={canvasRef} className="block h-full w-full" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0.5 flex justify-center">
        <span className="truncate px-1 text-[9px] font-semibold tracking-widest text-foreground/70 drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
          {name}
        </span>
      </div>
    </div>
  );
}
