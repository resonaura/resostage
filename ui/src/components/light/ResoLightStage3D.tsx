import { Canvas, useThree } from "@react-three/fiber";
import { Grid, OrbitControls, Text } from "@react-three/drei";
import { useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, MoveUp } from "lucide-react";
import * as THREE from "three";
import type { LightFixtureRow } from "../../lib/types";
import type { LightCueValue } from "../../lib/lightCueInterpolation";
import type { LiveLedColor } from "../../lib/liveLevels";

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
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
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
// oklch()/color-mix() but not var() -- normalize them into an rgb() string
// three.js's Color can parse.
function resolveCssColor(raw: string, fallback: string): string {
  if (!raw) return fallback;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return fallback;
  ctx.fillStyle = "#000";
  ctx.fillStyle = raw;
  return ctx.fillStyle || fallback;
}

function useHeroDefaultGridColors(): { cell: string; section: string } {
  const [colors, setColors] = useState({ cell: "#1e293b", section: "#334155" });
  useEffect(() => {
    const root = getComputedStyle(document.documentElement);
    const rawDefault = root.getPropertyValue("--default").trim();
    const rawForeground = root.getPropertyValue("--default-foreground").trim();
    if (!rawDefault || !rawForeground) return;
    const cell = resolveCssColor(rawDefault, "#1e293b");
    // Section (major) lines read as a lighter tint of the same "default"
    // surface -- blended toward its paired foreground token rather than a
    // second unrelated color, so it stays in-family with cell color.
    const section = resolveCssColor(
      `color-mix(in oklch, ${rawDefault} 55%, ${rawForeground} 45%)`,
      "#334155",
    );
    setColors({ cell, section });
  }, []);
  return colors;
}

// ─── Camera frame utility ─────────────────────────────────────────────────

function FrameAllHelper({
  fixtures,
  triggerRef,
}: {
  fixtures: LightFixtureRow[];
  triggerRef: React.MutableRefObject<(() => void) | null>;
}) {
  const { camera, controls } = useThree();

  useEffect(() => {
    triggerRef.current = () => {
      if (fixtures.length === 0) {
        camera.position.set(4, 3.5, 5);
        if (controls) (controls as unknown as { target: THREE.Vector3 }).target.set(0, 1, 0);
        camera.updateProjectionMatrix();
        return;
      }

      const xs = fixtures.map((f) => f.posX);
      const zs = fixtures.map((f) => f.posZ);
      const ys = fixtures.map((f) => f.posY + Math.min(3, Math.max(0.3, f.ledCount / 30)));

      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minZ = Math.min(...zs);
      const maxZ = Math.max(...zs);
      const maxY = Math.max(...ys);

      const cx = (minX + maxX) / 2;
      const cy = maxY / 2;
      const cz = (minZ + maxZ) / 2;

      const spread = Math.max(maxX - minX, maxZ - minZ, maxY, 3);

      if (controls) {
        (controls as unknown as { target: THREE.Vector3 }).target.set(cx, cy, cz);
      }
      camera.position.set(cx + spread * 0.8, cy + spread * 0.7, cz + spread * 1.2);
      camera.updateProjectionMatrix();
    };
  }, [fixtures, camera, controls, triggerRef]);

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
      const xs = fixtures.length ? fixtures.map((f) => f.posX) : [0];
      const zs = fixtures.length ? fixtures.map((f) => f.posZ) : [0];
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
      const cz = (Math.min(...zs) + Math.max(...zs)) / 2;

      if (controls) {
        (controls as unknown as { target: THREE.Vector3 }).target.set(cx, 0, cz);
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
  previewColors,
}: {
  mode: "edit" | "preview";
  fixtures: LightFixtureRow[];
  selectedFixtureId?: string | null;
  onSelectFixture?: (id: string) => void;
  onFixtureMoved?: (id: string, x: number, z: number) => void;
  previewColors?: Record<string, PreviewColor>;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragPos, setDragPos] = useState<{ x: number; z: number } | null>(null);
  const gridColors = useHeroDefaultGridColors();

  const frameAllRef = useRef<(() => void) | null>(null);
  const topViewRef = useRef<(() => void) | null>(null);

  return (
    <div className="relative w-full h-full">
      {/* 3D Controls overlay */}
      <div className="absolute top-2 right-2 z-10 flex flex-col gap-1.5">
        <button
          type="button"
          onClick={() => frameAllRef.current?.()}
          className="flex items-center gap-1.5 rounded-lg border border-default/50 bg-default/80 px-2.5 py-1.5 text-xs font-medium text-foreground/80 backdrop-blur-sm transition-colors hover:bg-default/90"
          title="Frame all fixtures"
        >
          <Maximize2 size={12} />
          Frame All
        </button>
        <button
          type="button"
          onClick={() => topViewRef.current?.()}
          className="flex items-center gap-1.5 rounded-lg border border-default/50 bg-default/80 px-2.5 py-1.5 text-xs font-medium text-foreground/80 backdrop-blur-sm transition-colors hover:bg-default/90"
          title="Top-down view"
        >
          <MoveUp size={12} />
          Top View
        </button>
      </div>

      <Canvas
        camera={{ position: [4, 3.5, 5], fov: 50 }}
        style={{ width: "100%", height: "100%" }}
      >
        <color attach="background" args={["#0b0f14"]} />
        <ambientLight intensity={0.55} />
        <directionalLight position={[5, 8, 4]} intensity={0.7} />
        <Grid
          args={[40, 40]}
          cellColor={gridColors.cell}
          sectionColor={gridColors.section}
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
            setDragPos({ x: snapToStageGrid(e.point.x), z: snapToStageGrid(e.point.z) });
          }}
          onPointerUp={() => {
            if (dragId !== null && dragPos !== null)
              onFixtureMoved?.(dragId, snapToStageGrid(dragPos.x), snapToStageGrid(dragPos.z));
            setDragId(null);
            setDragPos(null);
          }}
          onPointerLeave={() => {
            if (dragId !== null && dragPos !== null)
              onFixtureMoved?.(dragId, snapToStageGrid(dragPos.x), snapToStageGrid(dragPos.z));
            setDragId(null);
            setDragPos(null);
          }}
        >
          <planeGeometry args={[200, 200]} />
        </mesh>

        {fixtures.map((f) => {
          const isDragging = dragId === f.id;
          const x = isDragging && dragPos ? dragPos.x : snapToStageGrid(f.posX);
          const z = isDragging && dragPos ? dragPos.z : snapToStageGrid(f.posZ);
          return (
            <ResoLightBar
              key={f.id}
              fixture={f}
              x={x}
              z={z}
              selected={mode === "edit" && f.id === selectedFixtureId}
              editable={mode === "edit"}
              onPointerDownStart={() => {
                onSelectFixture?.(f.id);
                if (mode === "edit") setDragId(f.id);
              }}
              previewColor={previewColors?.[f.id]}
            />
          );
        })}

        <OrbitControls makeDefault enabled={dragId === null} enableDamping={false} />
        <FrameAllHelper fixtures={fixtures} triggerRef={frameAllRef} />
        <TopViewHelper fixtures={fixtures} triggerRef={topViewRef} />
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

function ResoLightBar({
  fixture,
  x,
  z,
  selected,
  editable,
  onPointerDownStart,
  previewColor,
}: {
  fixture: LightFixtureRow;
  x: number;
  z: number;
  selected: boolean;
  editable: boolean;
  onPointerDownStart: () => void;
  previewColor?: PreviewColor;
}) {
  // Rough visual scale: ~30 LEDs per meter of bar height, clamped so a
  // 1-LED or 500-LED fixture still renders as something sane on stage.
  const heightMeters = Math.min(3, Math.max(0.3, fixture.ledCount / 30));

  const liveLeds = previewColor?.ledColors;
  const perLed = (liveLeds?.length ?? 0) > 1;
  const uniformLive = (liveLeds?.length ?? 0) === 1;

  // The scene's ambient + directional lights reflect off a mesh's diffuse
  // `color` regardless of `emissive` -- so a fully-saturated diffuse color
  // with only a low emissiveIntensity still reads as fairly bright (the
  // "strobe/converge never really looks off" bug this fixes). Baking the
  // resolved intensity straight into the diffuse color (not just emissive)
  // means an LED at intensity 0 is actually black under any lighting, matching
  // real DMX output where 0 intensity means 0 on the wire -- no artificial
  // floor needed for "visibility", since a real blackout looks like nothing.
  const color = useMemo(() => {
    if (uniformLive && liveLeds) {
      // Wire colors already have intensity baked in.
      const c = liveLeds[0];
      return new THREE.Color(c.r / 255, c.g / 255, c.b / 255);
    }
    if (previewColor && !perLed) {
      return new THREE.Color(
        previewColor.r / 255,
        previewColor.g / 255,
        previewColor.b / 255,
      ).multiplyScalar(Math.max(0, Math.min(1, previewColor.intensity)));
    }
    return new THREE.Color(0.55, 0.58, 0.65);
  }, [uniformLive, liveLeds, perLed, previewColor]);

  const emissiveIntensity = uniformLive && liveLeds
    ? (liveLeds[0].r + liveLeds[0].g + liveLeds[0].b > 0 ? 1 : 0)
    : previewColor ? 1 : 0.25;

  // Capped/floored purely for render cost and visibility -- the real DMX
  // output still addresses every physical LED; this is just how many
  // discrete segments the 3D preview bothers to draw.
  const totalSegments = Math.min(20, Math.max(3, Math.round(fixture.ledCount / 3)));

  // Live per-LED pattern straight from the backend stream -- subsampled to
  // totalSegments, each segment keeping its exact wire color. No local
  // effect re-simulation; brightness rides the wire color itself.
  const segments = useMemo(() => {
    if (!perLed || !liveLeds) return null;
    return Array.from({ length: totalSegments }, (_, i) => {
      const srcIdx = totalSegments > 1
        ? Math.round((i * (liveLeds.length - 1)) / (totalSegments - 1))
        : 0;
      const c = liveLeds[Math.min(srcIdx, liveLeds.length - 1)];
      const level = Math.max(c.r, c.g, c.b) / 255;
      return { color: new THREE.Color(c.r / 255, c.g / 255, c.b / 255), level };
    });
  }, [perLed, liveLeds, totalSegments]);
  const segmentCount = segments ? totalSegments : 1;

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
      position={[x, fixture.posY, z]}
      rotation={[0, THREE.MathUtils.degToRad(fixture.rotationYDeg), 0]}
    >
      <group rotation={[0, 0, fixture.mountedHorizontally ? Math.PI / 2 : 0]}>
        {segments ? (
          segments.map((seg, idx) => {
            const segH = heightMeters / segmentCount;
            const segY = idx * segH + segH / 2;
            return (
              <group key={idx}>
              <mesh
                position={[0, segY, 0]}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onPointerDownStart();
                }}
              >
                <boxGeometry args={[0.08, segH * 0.95, 0.08]} />
                <meshStandardMaterial
                  color={seg.color}
                  emissive={seg.color}
                  emissiveIntensity={seg.level > 0 ? 1 : 0}
                />
              </mesh>
              {/* A radial-falloff additive sprite reads as light spilling
                  from one physical LED (see getGlowTexture) -- not a flat
                  billboard halo, and no scene-wide bloom pass needed. */}
              <sprite position={[0, segY, 0]} scale={[0.42, 0.42, 1]}>
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
            <boxGeometry args={[0.08, heightMeters, 0.08]} />
            <meshStandardMaterial
              color={color}
              emissive={color}
              emissiveIntensity={emissiveIntensity}
            />
          </mesh>
        )}

        <Text
          position={[0, heightMeters + 0.18, 0]}
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
