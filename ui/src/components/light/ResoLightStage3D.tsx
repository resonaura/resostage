import { Button } from "../ui";
import { Grid, OrbitControls, Text } from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import { Maximize2, MoveUp } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { useRenderActive } from "../../lib/appActivity";
import type { FixtureShape } from "../../lib/dmxProfiles";
import { beginCancellableDrag } from "../../lib/dragCancel";
import type { LightCueValue } from "../../lib/lightCueInterpolation";
import type { LiveLedColor } from "../../lib/liveLevels";
import type { LightFixtureRow } from "../../lib/types";

// One stage-grid cell is deliberately small enough for practical placement,
// while still guaranteeing panels never slowly drift off the visual grid.
const STAGE_GRID_STEP = 0.25;
const snapToStageGrid = (value: number) =>
  Math.round(value / STAGE_GRID_STEP) * STAGE_GRID_STEP;

// ─── Radial-falloff glow sprite ────────────────────────────────────────────
//
// A flat solid-color sprite reads as a uniform billboard halo (the previous
// attempt). A proper radial gradient -- bright core, smooth falloff to
// transparent -- is what makes a sprite read as light spilling off a point
// source instead. Three.js sprites always face the camera, so this single
// shared texture works for every LED with no scene-wide bloom pass, and with
// AdditiveBlending the core tints by the LED's own color while the falloff
// blends into whatever is behind it. The texture is created once per module
// load and reused -- SpriteMaterial.map is shared, color/opacity are per-LED.
let glowTexture: THREE.CanvasTexture | null = null;
function getGlowTexture(): THREE.CanvasTexture {
  if (glowTexture) return glowTexture;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2,
  );
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.25, "rgba(255,255,255,0.6)");
  g.addColorStop(0.55, "rgba(255,255,255,0.18)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  glowTexture = new THREE.CanvasTexture(canvas);
  return glowTexture;
}

// ─── Theme-driven grid colors ──────────────────────────────────────────────
//
// The stage grid used to be two hardcoded hex slate colors, so it never
// matched a theme change. HeroUI exposes its palette as CSS custom
// properties (--default / --default-foreground, see @heroui/styles) rather
// than a JS token table, so resolving them means walking the CSS cascade:
// read the (already var()-substituted) computed values off :root, then let
// a throwaway canvas 2D context's fillStyle parser -- which understands
// oklch()/color-mix() but not var() -- turn them into real pixels. Sampling
// those pixels with getImageData is what guarantees an rgb(r, g, b) string
// three.js's Color can actually parse: the context serializes supported
// colors back as oklch(...)/color-mix(...), which THREE.Color would silently
// reject (falling back to white).
function resolveCssColor(raw: string, fallback: string): string {
  if (!raw) return fallback;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return fallback;
  ctx.fillStyle = "#000";
  ctx.fillStyle = raw;
  // An invalid color leaves fillStyle at the previous value (#000000) --
  // bail to the fallback instead of sampling black.
  if (ctx.fillStyle === "#000000") return fallback;
  ctx.fillRect(0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  return `rgb(${d[0]}, ${d[1]}, ${d[2]})`;
}

// Stage background + grid colors, all derived from the same HeroUI tokens
// (--background, --default, --default-foreground) so they can never drift
// apart into an arbitrary hardcoded hex that stops matching a theme change.
// The stage stays dark (resolved --background); the grid is a tint of the
// "default" surface pushed back toward the background, with the major
// (section) lines blended a bit toward the paired --default-foreground so
// minor/major still read as distinct -- visible on the dark floor without
// ever going bright/white.
function useHeroStageColors(): {
  background: string;
  cell: string;
  section: string;
} {
  const [colors, setColors] = useState({
    background: "#060607",
    cell: "#18181b",
    section: "#313032",
  });
  useEffect(() => {
    const root = getComputedStyle(document.documentElement);
    const rawBackground = root.getPropertyValue("--background").trim();
    const rawDefault = root.getPropertyValue("--default").trim();
    if (!rawBackground) return;
    const background = resolveCssColor(rawBackground, "#060607");
    const tint = rawDefault || rawBackground;
    // Minor lines: a clearly visible tint of the "default" theme surface.
    const cell = resolveCssColor(
      `color-mix(in oklch, ${tint} 60%, ${rawBackground} 40%)`,
      "#18181b",
    );
    // Major (section) lines: same surface tinted slightly toward its paired
    // foreground token, so they read a step brighter than the minor lines.
    const section = resolveCssColor(
      `color-mix(in oklch, ${root.getPropertyValue("--default-foreground").trim() || tint} 22%, ${rawBackground} 78%)`,
      "#313032",
    );
    setColors({ background, cell, section });
  }, []);
  return colors;
}

// ─── Camera frame utility ─────────────────────────────────────────────────

function frameCameraToFixtures(
  camera: THREE.Camera,
  controls: unknown,
  fixtures: LightFixtureRow[],
) {
  if (fixtures.length === 0) {
    camera.position.set(4, 3.5, 5);
    if (controls) (controls as { target: THREE.Vector3 }).target.set(0, 1, 0);
    if ("updateProjectionMatrix" in camera)
      (camera as THREE.PerspectiveCamera).updateProjectionMatrix();
    return;
  }

  const xs = fixtures.map((f) => f.position.x);
  const zs = fixtures.map((f) => f.position.z);
  const ys = fixtures.map(
    (f) => f.position.y + Math.min(3, Math.max(0.3, f.ledCount / 30)),
  );

  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  const maxY = Math.max(...ys);

  const cx = (minX + maxX) / 2;
  const cy = maxY / 2;
  const cz = (minZ + maxZ) / 2;

  const spread = Math.max(maxX - minX, maxZ - minZ, maxY, 3);

  if (controls) (controls as { target: THREE.Vector3 }).target.set(cx, cy, cz);
  camera.position.set(cx + spread * 0.8, cy + spread * 0.7, cz + spread * 1.2);
  if ("updateProjectionMatrix" in camera)
    (camera as THREE.PerspectiveCamera).updateProjectionMatrix();
}

function FrameAllHelper({
  fixtures,
  triggerRef,
  autoFrame = true,
  onFramed,
}: {
  fixtures: LightFixtureRow[];
  triggerRef: React.MutableRefObject<(() => void) | null>;
  /** When true, frame once after the canvas is ready (before parent fade-in). */
  autoFrame?: boolean;
  onFramed?: () => void;
}) {
  const { camera, controls } = useThree();
  // `run` always reads the LATEST fixtures via this ref, regardless of how
  // rarely the effect below re-subscribes -- see fixtureSetKey.
  const fixturesRef = useRef(fixtures);
  fixturesRef.current = fixtures;

  // Stable identity for the effect: only the fixture *set* (which ids
  // exist), not the array reference. The backend resends the whole fixture
  // roster fresh on every ~30Hz telemetry tick regardless of whether
  // anything actually changed ("lighting ... always shipped" in
  // WebServer.cpp), so keying this effect on the raw `fixtures` prop
  // re-ran it -- and re-snapped the camera to Frame All -- on nearly every
  // frame, fighting any manual OrbitControls drag ("график поворачивается к
  // Frame All при попытке покрутить"). Only re-auto-frame when fixtures are
  // actually added/removed, per the original intent below.
  const fixtureSetKey = fixtures.map((f) => f.id).join("\n");

  useEffect(() => {
    const run = () =>
      frameCameraToFixtures(camera, controls, fixturesRef.current);
    triggerRef.current = run;
    if (!autoFrame)
      return () => {
        triggerRef.current = null;
      };
    // Frame once after layout, then signal parent to fade in — avoids the
    // visible camera jump during fade-in.
    let cancelled = false;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        if (cancelled) return;
        run();
        onFramed?.();
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      triggerRef.current = null;
    };
    // Only re-auto-frame when fixture *count* or ids change significantly --
    // deps intentionally key off fixtureSetKey, not the fixtures array
    // reference itself.
  }, [fixtureSetKey, camera, controls, triggerRef, autoFrame, onFramed]);

  return null;
}

function TopViewHelper({
  triggerRef,
  fixtures,
}: {
  triggerRef: React.MutableRefObject<(() => void) | null>;
  fixtures: LightFixtureRow[];
}) {
  const { camera, controls } = useThree();

  useEffect(() => {
    triggerRef.current = () => {
      const xs = fixtures.length ? fixtures.map((f) => f.position.x) : [0];
      const zs = fixtures.length ? fixtures.map((f) => f.position.z) : [0];
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
      const cz = (Math.min(...zs) + Math.max(...zs)) / 2;

      if (controls) {
        (controls as unknown as { target: THREE.Vector3 }).target.set(
          cx,
          0,
          cz,
        );
      }
      camera.position.set(cx, 12, cz + 0.001);
      camera.updateProjectionMatrix();
    };
  }, [fixtures, camera, controls, triggerRef]);

  return null;
}

// ─── Main component ───────────────────────────────────────────────────────

export function ResoLightStage3D({
  mode,
  fixtures,
  selectedFixtureId,
  onSelectFixture,
  onFixtureMoved,
  /** Whether to show the live per-LED binary stream at all (mirrors the
   * caller's own `li.enabled`/rig-connected gate) -- when false, every
   * fixture just shows its dark/off housing. Each fixture subscribes to the
   * stream itself (see ResoLightBar/GenericFixture below) instead of this
   * component holding the live data in React state: that used to live in
   * three near-identical useState+useEffect blocks in every caller
   * (PlayerScreen, ProjectLightingPanel, LightSidePanel), each re-rendering
   * its whole tree (every fixture, every segment mesh) on every binary WS
   * frame -- 30-60Hz during a show, entirely through React's reconciler for
   * what's ultimately just a color/opacity number changing. */
  live = true,
  /** Compact player preview: no overlay buttons, no orbit drag. */
  chrome = "full",
}: {
  mode: "edit" | "preview";
  fixtures: LightFixtureRow[];
  selectedFixtureId?: string | null;
  onSelectFixture?: (id: string) => void;
  onFixtureMoved?: (id: string, x: number, z: number) => void;
  live?: boolean;
  chrome?: "full" | "minimal";
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragPos, setDragPos] = useState<{ x: number; z: number } | null>(null);
  const renderActive = useRenderActive();
  const stageColors = useHeroStageColors();
  const minimal = chrome === "minimal";
  const orbitEnabled = !minimal && dragId === null;

  // Ground-plane onPointerUp (below) only fires when the release lands on
  // the plane itself -- but a fixture drag visually follows the cursor, so
  // releasing right where you dropped it lands the pointerup on the FIXTURE
  // mesh instead (a sibling, not an ancestor, of the plane -- R3F never
  // bubbles the event there). dragId was then stuck non-null forever,
  // permanently disabling OrbitControls (orbitEnabled above) -- "zoom
  // stopped working" after the first drag. A window-level listener commits
  // the drop and clears drag state no matter what's under the cursor at
  // release; the native pointerup always bubbles to window regardless of
  // which mesh R3F routed the synthetic event to.
  const dragIdRef = useRef(dragId);
  dragIdRef.current = dragId;
  const dragPosRef = useRef(dragPos);
  dragPosRef.current = dragPos;
  const onFixtureMovedRef = useRef(onFixtureMoved);
  onFixtureMovedRef.current = onFixtureMoved;
  useEffect(() => {
    if (dragId === null) return;
    const endDrag = () => {
      const id = dragIdRef.current;
      const pos = dragPosRef.current;
      if (id !== null && pos !== null) {
        onFixtureMovedRef.current?.(
          id,
          snapToStageGrid(pos.x),
          snapToStageGrid(pos.z),
        );
      }
      setDragId(null);
      setDragPos(null);
    };
    // Esc: leave the fixture where it was. A move only reaches the project in
    // endDrag above, so dropping the drag state is the whole revert -- and
    // clearing dragId re-runs this effect's cleanup, which unhooks endDrag so
    // the pointerup that follows can't commit the abandoned position.
    const cancel = beginCancellableDrag(() => {
      setDragId(null);
      setDragPos(null);
    });
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    return () => {
      cancel.end();
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
    };
  }, [dragId]);

  const frameAllRef = useRef<(() => void) | null>(null);
  const topViewRef = useRef<(() => void) | null>(null);
  // Fade-in only AFTER auto Frame All so the camera jump is never visible.
  const [fadedIn, setFadedIn] = useState(false);
  // Bump to remount <Canvas> after WebGL context loss (sleep / GPU reset)
  // or an Electron shell-resume when the compositor left a black surface.
  const [canvasEpoch, setCanvasEpoch] = useState(0);
  const onFramed = useMemo(
    () => () => {
      requestAnimationFrame(() => setFadedIn(true));
    },
    [],
  );

  // The canvas this instance is currently showing, and whether it is still
  // mounted -- both are what tells a real GPU fault apart from the teardown of
  // a canvas we have already walked away from. See the context-lost handler.
  const liveCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const aliveRef = useRef(true);
  useEffect(() => {
    // Re-armed on mount, not just cleared on unmount: React re-mounts a
    // component after tearing it down (StrictMode does it on purpose in dev,
    // and Suspense/offscreen can do it in production). A flag that is only
    // ever set to false left the stage unable to rebuild itself after a real
    // context loss -- it came back as an empty white panel.
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    const remount = () => {
      setFadedIn(false);
      setCanvasEpoch((n) => n + 1);
    };
    // Soft recover on plain focus/show (don't tear down the GL context —
    // that flickers the stage every alt-tab). Hard remount only after the
    // events that actually leave a dead GPU surface: sleep, screen unlock,
    // a discarded/restored page.
    //
    // "visibility" is deliberately NOT one of them. It fires whenever the
    // window merely becomes visible -- including once at startup, since the
    // shell shows the window after the page has mounted -- and remounting
    // <Canvas> there tore down a GL context that had just been built, took
    // the fade back to zero and re-framed the camera. That was the flicker on
    // first open. Becoming visible is the ordinary case and the existing
    // context is fine; the genuinely broken-surface cases stay hard below.
    const onShellResume = (e: Event) => {
      const reason =
        e instanceof CustomEvent
          ? String((e.detail as { reason?: string } | undefined)?.reason ?? "")
          : "";
      const hard =
        reason.startsWith("power-resume") ||
        reason.startsWith("unlock-screen") ||
        reason === "restore" ||
        reason === "menu" ||
        reason === "page-resume" ||
        reason === "pageshow-bfcache";
      if (hard) {
        remount();
        return;
      }
      // focus/show/activate/visibility: keep the canvas, just be visible.
      setFadedIn(true);
      requestAnimationFrame(() => frameAllRef.current?.());
    };
    window.addEventListener("resoshell-resume", onShellResume);
    return () => {
      window.removeEventListener("resoshell-resume", onShellResume);
    };
  }, []);

  return (
    <div
      className="relative h-full w-full transition-opacity duration-500 ease-out"
      style={{ opacity: fadedIn ? 1 : 0 }}
    >
      {/* 3D Controls overlay — hidden on compact player preview */}
      {!minimal && (
        <div className="absolute top-2 right-2 z-10 flex flex-col gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            onPress={() => frameAllRef.current?.()}
            aria-label="Frame all fixtures"
          >
            <Maximize2 size={14} />
            Frame All
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onPress={() => topViewRef.current?.()}
            aria-label="Top-down view"
          >
            <MoveUp size={14} />
            Top View
          </Button>
        </div>
      )}

      <Canvas
        key={canvasEpoch}
        camera={{ position: [4, 3.5, 5], fov: 50 }}
        style={{ width: "100%", height: "100%" }}
        // On screen this is an ordinary continuous render loop -- unchanged,
        // so nothing about how the stage looks or how the shaders run is
        // being traded away. "never" only ever applies while the window is
        // genuinely not being shown AND the transport is stopped, where the
        // GPU was previously redrawing the same frame sixty times a second
        // for nobody. Resuming is one prop flip on the next event; the WebGL
        // context, camera and scene all stay exactly as they were.
        frameloop={renderActive ? "always" : "never"}
        // A 3x+ HiDPI panel would otherwise render this preview at nine times
        // the pixels of a 1x one for no visible gain at these sizes.
        dpr={[1, 2]}
        onCreated={({ gl }) => {
          const el = gl.domElement;
          liveCanvasRef.current = el;
          // Bound to THIS canvas, not to window.
          //
          // It used to be a capture listener on window, which meant any
          // canvas anywhere losing its context rebuilt this stage -- including
          // the context of a canvas this component had itself just discarded.
          // On startup that is exactly what happened: the stage faded in,
          // the superseded canvas released its context a beat later, and the
          // fade was yanked back to zero and restarted. Hence the blink.
          //
          // A canvas that is no longer in the document, or is not the one
          // currently on screen, has nothing worth rebuilding.
          const lost = (e: Event) => {
            e.preventDefault();
            if (!aliveRef.current) return;
            if (!el.isConnected || liveCanvasRef.current !== el) return;
            setFadedIn(false);
            setCanvasEpoch((n) => n + 1);
          };
          el.addEventListener("webglcontextlost", lost, false);
        }}
      >
        <color attach="background" args={[stageColors.background]} />
        <ambientLight intensity={0.55} />
        <directionalLight position={[5, 8, 4]} intensity={0.7} />
        <Grid
          args={[40, 40]}
          cellColor={stageColors.cell}
          sectionColor={stageColors.section}
          fadeDistance={28}
          infiniteGrid
        />

        {/* Invisible ground plane -- drag raycast target for edit mode. */}
        <mesh
          rotation={[-Math.PI / 2, 0, 0]}
          visible={false}
          onPointerMove={(e) => {
            if (mode !== "edit" || dragId === null) return;
            e.stopPropagation();
            setDragPos({
              x: snapToStageGrid(e.point.x),
              z: snapToStageGrid(e.point.z),
            });
          }}
          onPointerUp={() => {
            if (dragId !== null && dragPos !== null)
              onFixtureMoved?.(
                dragId,
                snapToStageGrid(dragPos.x),
                snapToStageGrid(dragPos.z),
              );
            setDragId(null);
            setDragPos(null);
          }}
          onPointerLeave={() => {
            if (dragId !== null && dragPos !== null)
              onFixtureMoved?.(
                dragId,
                snapToStageGrid(dragPos.x),
                snapToStageGrid(dragPos.z),
              );
            setDragId(null);
            setDragPos(null);
          }}
        >
          <planeGeometry args={[200, 200]} />
        </mesh>

        {fixtures.map((f, i) => {
          const isDragging = dragId === f.id;
          const x =
            isDragging && dragPos ? dragPos.x : snapToStageGrid(f.position.x);
          const z =
            isDragging && dragPos ? dragPos.z : snapToStageGrid(f.position.z);
          const commonProps = {
            fixture: f,
            fixtureIndex: i,
            live,
            x,
            z,
            selected: mode === "edit" && f.id === selectedFixtureId,
            editable: mode === "edit",
            onPointerDownStart: () => {
              onSelectFixture?.(f.id);
              if (mode === "edit") setDragId(f.id);
            },
          };
          return f.kind === "resolight::bar" ? (
            <ResoLightBar key={f.id} {...commonProps} />
          ) : (
            <GenericFixture key={f.id} {...commonProps} />
          );
        })}

        <OrbitControls
          makeDefault
          enabled={orbitEnabled}
          enableDamping={false}
          enableRotate={orbitEnabled}
          enablePan={orbitEnabled}
          enableZoom={orbitEnabled}
        />
        <FrameAllHelper
          fixtures={fixtures}
          triggerRef={frameAllRef}
          autoFrame
          onFramed={onFramed}
        />
        {!minimal && (
          <TopViewHelper fixtures={fixtures} triggerRef={topViewRef} />
        )}
      </Canvas>
    </div>
  );
}

// ─── Single light bar ─────────────────────────────────────────────────────

// Backend-rendered per-LED wire colors (intensity already baked in) are
// what the live preview draws, one entry per LED for addressable fixtures
// and a single uniform entry for non-addressable ones -- streamed over the
// binary websocket (see liveLevels.ts). Extends the plain resolved editor
// color with what's needed to draw the exact per-LED pattern the real
// hardware gets (see resolveLedWireColors / LightOutputResolver.h).
export type PreviewColor = LightCueValue & {
  ledColors?: LiveLedColor[];
};

// Each fixture subscribes to the live binary stream itself, filtered to its
// own fixtureIdx, instead of a parent screen holding ALL fixtures' colors in
// React state and re-rendering the entire stage on every WS frame. Still a
// React state update (not a ref+useFrame mutation) -- but it's now scoped to
// exactly the one fixture whose color actually changed, instead of cascading
// through the whole scene, every OTHER fixture, and the parent screen too.
import { useLiveFixtureColor } from "../../hooks/useLiveFixtureColor";

// Dark housing when a fixture has no live output (unbound, empty track,
// blackout). Ambient/directional still pick up a faint charcoal so the
// mesh reads as a physical bar on stage — never a glowing near-white
// "placeholder" that looked like a dim idle white.
const kOffFixtureColor = new THREE.Color(0.07, 0.08, 0.1);

// Resolves a non-addressable fixture's single displayed color -- shared by
// ResoLightBar's uniform (non-segmented) path and every GenericFixture
// shape below, since a DmxGeneric fixture is always non-addressable
// (ledCount=1) and therefore always takes this same uniform path. See the
// call site's own comment for why intensity gets baked into the diffuse
// color, not just emissive.
function useUniformFixtureColor(previewColor?: PreviewColor): {
  color: THREE.Color;
  emissiveIntensity: number;
} {
  const liveLeds = previewColor?.ledColors;
  const uniformLive = (liveLeds?.length ?? 0) >= 1;
  const color = useMemo(() => {
    if (uniformLive && liveLeds) {
      const c = liveLeds[0];
      return new THREE.Color(c.r / 255, c.g / 255, c.b / 255);
    }
    if (previewColor) {
      return new THREE.Color(
        previewColor.r / 255,
        previewColor.g / 255,
        previewColor.b / 255,
      ).multiplyScalar(Math.max(0, Math.min(1, previewColor.intensity)));
    }
    // No resolved output for this fixture: dark, not faintly lit white.
    return kOffFixtureColor.clone();
  }, [uniformLive, liveLeds, previewColor]);
  const emissiveIntensity =
    uniformLive && liveLeds
      ? liveLeds[0].r + liveLeds[0].g + liveLeds[0].b > 0
        ? 1
        : 0
      : previewColor
        ? // intensity already baked into diffuse; still emit when on
          previewColor.intensity > 0 &&
          (previewColor.r > 0 || previewColor.g > 0 || previewColor.b > 0)
          ? 1
          : 0
        : 0; // off / unbound / empty tracks — no glow
  return { color, emissiveIntensity };
}

// Where each of `count` LED segments sits, purely as a function of shape --
// see ProjectSchema.h's LightFixture::shape doc comment: ring/matrix
// genuinely reposition every pixel of the SAME linear array, bar/strip keep
// the existing vertical stack (strip only changes the per-segment
// cross-section below, not position, so "bar" behavior is byte-identical
// to before this function existed -- zero risk to the default/common case).
// `topY` is how high the name label/glow anchor needs to clear the layout.
function computeSegmentLayout(
  shape: FixtureShape,
  count: number,
  heightMeters: number,
  matrixCols: number,
): { positions: [number, number, number][]; topY: number } {
  if (shape === "ring") {
    // Flat horizontal ring, radius chosen so its circumference roughly
    // matches the equivalent bar's height -- a "ring" reads as the same
    // amount of LED as the same fixture would as a "bar", just bent into a
    // circle instead of a line.
    const radius = Math.max(0.1, heightMeters / (Math.PI * 2));
    const y = heightMeters / 2;
    const positions = Array.from(
      { length: count },
      (_, i): [number, number, number] => {
        const angle = (i / count) * Math.PI * 2;
        return [Math.cos(angle) * radius, y, Math.sin(angle) * radius];
      },
    );
    return { positions, topY: y + radius };
  }
  if (shape === "matrix") {
    const cols = Math.max(1, matrixCols || Math.ceil(Math.sqrt(count)));
    const rows = Math.ceil(count / cols);
    const spacing = 0.12;
    const positions = Array.from(
      { length: count },
      (_, i): [number, number, number] => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        return [
          (col - (cols - 1) / 2) * spacing,
          row * spacing + spacing / 2,
          0,
        ];
      },
    );
    return { positions, topY: rows * spacing + spacing / 2 };
  }
  // "bar" / "strip": the original vertical stack.
  const segH = heightMeters / count;
  const positions = Array.from(
    { length: count },
    (_, i): [number, number, number] => [0, i * segH + segH / 2, 0],
  );
  return { positions, topY: heightMeters };
}

// Per-segment box dimensions -- "strip" is a flatter/wider cross-section of
// the same stack "bar" uses; ring/matrix pixels aren't stretched along a
// stacking axis at all, so they get a small roughly-cubic size instead. The
// *0.95 factor leaves a visible gap between adjacent stacked segments --
// only meaningful when there ARE multiple segments, see uniformBoxSize for
// the single-continuous-box (no live data) case.
function segmentBoxSize(
  shape: FixtureShape,
  segH: number,
): [number, number, number] {
  if (shape === "strip") return [0.14, segH * 0.9, 0.025];
  if (shape === "ring" || shape === "matrix") return [0.07, 0.07, 0.07];
  return [0.08, segH * 0.95, 0.08];
}

// The whole-bar box for the uniform (non-segmented, no live per-LED data)
// fallback -- shape-aware like segmentBoxSize, but WITHOUT its inter-segment
// gap factor: this is one continuous box spanning the full height, not a
// stack, so shrinking it would just leave an unexplained gap at the tip.
// "bar" here is exactly the original hardcoded box, unchanged.
function uniformBoxSize(
  shape: FixtureShape,
  heightMeters: number,
): [number, number, number] {
  if (shape === "strip") return [0.14, heightMeters, 0.025];
  return [0.08, heightMeters, 0.08];
}

function ResoLightBar({
  fixture,
  fixtureIndex,
  live,
  x,
  z,
  selected,
  editable,
  onPointerDownStart,
}: {
  fixture: LightFixtureRow;
  fixtureIndex: number;
  live: boolean;
  x: number;
  z: number;
  selected: boolean;
  editable: boolean;
  onPointerDownStart: () => void;
}) {
  const previewColor = useLiveFixtureColor(fixtureIndex, live);
  // Rough visual scale: ~30 LEDs per meter of bar height, clamped so a
  // 1-LED or 500-LED fixture still renders as something sane on stage.
  const heightMeters = Math.min(3, Math.max(0.3, fixture.ledCount / 30));

  const liveLeds = previewColor?.ledColors;
  const perLed = (liveLeds?.length ?? 0) > 1;

  // The scene's ambient + directional lights reflect off a mesh's diffuse
  // `color` regardless of `emissive` -- so a fully-saturated diffuse color
  // with only a low emissiveIntensity still reads as fairly bright (the
  // "strobe/converge never really looks off" bug this fixes). Baking the
  // resolved intensity straight into the diffuse color (not just emissive)
  // means an LED at intensity 0 is actually black under any lighting, matching
  // real DMX output where 0 intensity means 0 on the wire -- no artificial
  // floor needed for "visibility", since a real blackout looks like nothing.
  // Only meaningful along the non-segmented (uniform) path below -- the
  // per-LED `segments` path derives its own colors straight from `liveLeds`.
  const { color, emissiveIntensity } = useUniformFixtureColor(
    perLed ? undefined : previewColor,
  );

  // Capped/floored purely for render cost and visibility -- the real DMX
  // output still addresses every physical LED; this is just how many
  // discrete segments the 3D preview bothers to draw.
  const totalSegments = Math.min(
    20,
    Math.max(3, Math.round(fixture.ledCount / 3)),
  );

  // Ring/matrix genuinely need multiple positioned pixels to read as their
  // shape at all -- unlike bar/strip, which can fall back to a single
  // uniform blob when there's no live per-LED stream to segment.
  const showShapeSegments =
    fixture.shape === "ring" || fixture.shape === "matrix";

  // Live per-LED pattern straight from the backend stream -- subsampled to
  // totalSegments, each segment keeping its exact wire color. No local
  // effect re-simulation; brightness rides the wire color itself.
  const segments = useMemo(() => {
    if (perLed && liveLeds) {
      return Array.from({ length: totalSegments }, (_, i) => {
        const srcIdx =
          totalSegments > 1
            ? Math.round((i * (liveLeds.length - 1)) / (totalSegments - 1))
            : 0;
        const c = liveLeds[Math.min(srcIdx, liveLeds.length - 1)];
        const level = Math.max(c.r, c.g, c.b) / 255;
        return {
          color: new THREE.Color(c.r / 255, c.g / 255, c.b / 255),
          level,
        };
      });
    }
    if (showShapeSegments) {
      // No live per-LED stream (idle rig / static editor) -- still draw
      // `totalSegments` pixels sharing the resolved uniform color, so a
      // ring/matrix layout is visible while placing the fixture instead of
      // collapsing to the single blob bar/strip fall back to below.
      const level =
        emissiveIntensity > 0 ? Math.max(color.r, color.g, color.b) : 0;
      return Array.from({ length: totalSegments }, () => ({ color, level }));
    }
    return null;
  }, [
    perLed,
    liveLeds,
    totalSegments,
    showShapeSegments,
    color,
    emissiveIntensity,
  ]);
  const segmentCount = segments ? totalSegments : 1;

  const layout = useMemo(
    () =>
      computeSegmentLayout(
        fixture.shape,
        segmentCount,
        heightMeters,
        fixture.matrixColumns,
      ),
    [fixture.shape, segmentCount, heightMeters, fixture.matrixColumns],
  );
  const glowScale = showShapeSegments ? 0.22 : 0.42;

  // The bar mesh is ALWAYS built as a vertical box standing on its own
  // origin (base at local y=0, tip at y=heightMeters) -- orientation is
  // purely a matter of the two nested rotations below, never a change to
  // the geometry itself. Composing "which way is it pointing" (yaw) and
  // "is it standing or lying down" (roll) as two SEPARATE nested groups,
  // each with a single-axis rotation, keeps the math unambiguous: the
  // outer group yaws around world Y at the fixture's floor position (its
  // local Z stays purely horizontal throughout), so the inner group's roll
  // around that now-yawed local Z always correctly tips the bar down into
  // the ground plane along the yawed direction -- one clean composition
  // instead of swapping box dimensions AND rotating AND overloading yaw to
  // mean "lying down" (which produced a squashed/near-square bar).
  return (
    <group
      position={[x, fixture.position.y, z]}
      rotation={[0, THREE.MathUtils.degToRad(fixture.rotation.y), 0]}
    >
      <group rotation={[0, 0, fixture.mountedHorizontally ? Math.PI / 2 : 0]}>
        {segments ? (
          segments.map((seg, idx) => {
            const segH = heightMeters / segmentCount;
            const segPos = layout.positions[idx] ?? [0, 0, 0];
            const boxSize = segmentBoxSize(fixture.shape, segH);
            return (
              <group key={idx}>
                <mesh
                  position={segPos}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    onPointerDownStart();
                  }}
                >
                  <boxGeometry args={boxSize} />
                  <meshStandardMaterial
                    color={seg.color}
                    emissive={seg.color}
                    emissiveIntensity={seg.level > 0 ? 1 : 0}
                  />
                </mesh>
                {/* A radial-falloff additive sprite reads as light spilling
                  from one physical LED (see getGlowTexture) -- not a flat
                  billboard halo, and no scene-wide bloom pass needed. */}
                <sprite position={segPos} scale={[glowScale, glowScale, 1]}>
                  <spriteMaterial
                    map={getGlowTexture()}
                    color={seg.color}
                    transparent
                    opacity={Math.min(0.85, seg.level * 0.9)}
                    depthWrite={false}
                    blending={THREE.AdditiveBlending}
                  />
                </sprite>
              </group>
            );
          })
        ) : (
          <mesh
            position={[0, heightMeters / 2, 0]}
            onPointerDown={(e) => {
              e.stopPropagation();
              onPointerDownStart();
            }}
          >
            {/* Only reachable for "bar"/"strip" (ring/matrix always take the
                segmented branch above, even with no live data -- see
                showShapeSegments) -- still shape-aware so a non-addressable
                or currently-idle "strip" fixture doesn't fall back to
                looking like a plain "bar". */}
            <boxGeometry args={uniformBoxSize(fixture.shape, heightMeters)} />
            <meshStandardMaterial
              color={color}
              emissive={color}
              emissiveIntensity={emissiveIntensity}
            />
          </mesh>
        )}

        <Text
          position={[0, layout.topY + 0.18, 0]}
          fontSize={0.14}
          color="#cbd5e1"
          anchorX="center"
          anchorY="bottom"
        >
          {fixture.name}
        </Text>
      </group>

      {editable && (
        <mesh position={[0, -0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.12, selected ? 0.18 : 0.15, 24]} />
          <meshBasicMaterial color={selected ? "#38bdf8" : "#475569"} />
        </mesh>
      )}
    </group>
  );
}

// ─── Generic DMX fixture (PAR/wash/spot/moving head/strip) ────────────────
//
// DmxGeneric fixtures are always non-addressable (ledCount=1), so they only
// ever need the same uniform-color path ResoLightBar's non-segmented branch
// uses -- no per-LED segment logic applies. `shape` is purely cosmetic
// (which primitive silhouette gets drawn); the actual color/brightness
// logic, selection ring, and label are identical in spirit to ResoLightBar
// so a rig mixing bars and generic fixtures reads as one consistent stage.
function GenericFixture({
  fixture,
  fixtureIndex,
  live,
  x,
  z,
  selected,
  editable,
  onPointerDownStart,
}: {
  fixture: LightFixtureRow;
  fixtureIndex: number;
  live: boolean;
  x: number;
  z: number;
  selected: boolean;
  editable: boolean;
  onPointerDownStart: () => void;
}) {
  const previewColor = useLiveFixtureColor(fixtureIndex, live);
  const { color, emissiveIntensity } = useUniformFixtureColor(previewColor);
  // How strongly the glow sprite reads -- mirrors ResoLightBar's per-segment
  // `seg.level` (the resolved color's own brightness), not a separate signal.
  const glowLevel = Math.max(color.r, color.g, color.b);

  const onBodyPointerDown = (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    onPointerDownStart();
  };

  // Per-shape body mesh(es) + where its "lens" (glow sprite + label anchor)
  // sits. Every shape stands with its base at local y=0, same convention as
  // ResoLightBar, so posY means the same thing regardless of fixture kind.
  let body: React.ReactNode;
  let lensY: number;
  let labelY: number;
  switch (fixture.shape) {
    case "wash":
      lensY = 0.06;
      labelY = 0.18;
      body = (
        <mesh position={[0, lensY, 0]} onPointerDown={onBodyPointerDown}>
          <cylinderGeometry args={[0.15, 0.13, 0.12, 20]} />
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={emissiveIntensity}
          />
        </mesh>
      );
      break;
    case "spot":
      lensY = 0.14;
      labelY = 0.32;
      body = (
        <mesh position={[0, lensY, 0]} onPointerDown={onBodyPointerDown}>
          <coneGeometry args={[0.08, 0.28, 16]} />
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={emissiveIntensity}
          />
        </mesh>
      );
      break;
    case "moving-head":
      lensY = 0.19;
      labelY = 0.34;
      body = (
        <>
          {/* Static yoke/base -- never colored by the resolved cue, same
              as the housing of a real moving head staying neutral while
              only its lamp/lens changes color. */}
          <mesh position={[0, 0.06, 0]}>
            <boxGeometry args={[0.16, 0.12, 0.1]} />
            <meshStandardMaterial color="#3a4149" />
          </mesh>
          <mesh position={[0, lensY, 0]} onPointerDown={onBodyPointerDown}>
            <sphereGeometry args={[0.09, 16, 16]} />
            <meshStandardMaterial
              color={color}
              emissive={color}
              emissiveIntensity={emissiveIntensity}
            />
          </mesh>
        </>
      );
      break;
    case "strip":
      lensY = 0.03;
      labelY = 0.15;
      body = (
        <mesh position={[0, lensY, 0]} onPointerDown={onBodyPointerDown}>
          <boxGeometry args={[0.5, 0.05, 0.05]} />
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={emissiveIntensity}
          />
        </mesh>
      );
      break;
    case "par":
    default:
      lensY = 0.11;
      labelY = 0.28;
      body = (
        <mesh position={[0, lensY, 0]} onPointerDown={onBodyPointerDown}>
          <cylinderGeometry args={[0.08, 0.1, 0.22, 20]} />
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={emissiveIntensity}
          />
        </mesh>
      );
      break;
  }

  return (
    <group
      position={[x, fixture.position.y, z]}
      rotation={[0, THREE.MathUtils.degToRad(fixture.rotation.y), 0]}
    >
      {/* Tilt (aim pitch) nests inside yaw, same two-group composition
          ResoLightBar uses for yaw+mount -- so tilting always pitches the
          fixture in whatever horizontal direction it's already yawed to
          face, not some fixed world axis. Selection ring stays outside:
          it's a floor-anchored UI affordance, not part of the fixture. */}
      <group rotation={[THREE.MathUtils.degToRad(fixture.tiltDegrees), 0, 0]}>
        {body}

        <sprite position={[0, lensY, 0]} scale={[0.5, 0.5, 1]}>
          <spriteMaterial
            map={getGlowTexture()}
            color={color}
            transparent
            opacity={Math.min(0.85, glowLevel * 0.9)}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </sprite>

        <Text
          position={[0, labelY, 0]}
          fontSize={0.14}
          color="#cbd5e1"
          anchorX="center"
          anchorY="bottom"
        >
          {fixture.name}
        </Text>
      </group>

      {editable && (
        <mesh position={[0, -0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.12, selected ? 0.18 : 0.15, 24]} />
          <meshBasicMaterial color={selected ? "#38bdf8" : "#475569"} />
        </mesh>
      )}
    </group>
  );
}
