import { Canvas, useThree } from "@react-three/fiber";
import { Grid, OrbitControls, Text } from "@react-three/drei";
import { useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, MoveUp } from "lucide-react";
import * as THREE from "three";
import type { LightFixtureRow } from "../../lib/types";
import { addressableEffectLedColor, type LightCueValue, type SpatialEffectType } from "../../lib/lightCueInterpolation";

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
          cellColor="#1e293b"
          sectionColor="#334155"
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
            setDragPos({ x: e.point.x, z: e.point.z });
          }}
          onPointerUp={() => {
            if (dragId !== null && dragPos !== null)
              onFixtureMoved?.(dragId, dragPos.x, dragPos.z);
            setDragId(null);
            setDragPos(null);
          }}
          onPointerLeave={() => {
            if (dragId !== null && dragPos !== null)
              onFixtureMoved?.(dragId, dragPos.x, dragPos.z);
            setDragId(null);
            setDragPos(null);
          }}
        >
          <planeGeometry args={[200, 200]} />
        </mesh>

        {fixtures.map((f) => {
          const isDragging = dragId === f.id;
          const x = isDragging && dragPos ? dragPos.x : f.posX;
          const z = isDragging && dragPos ? dragPos.z : f.posZ;
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

// meterLevel01/gradientPreset are only present when the fixture's active
// cue is a Meter effect; effectType/effectTSec/effectRateHz are only
// meaningful for Converge/GradientFlow -- see WebUiState.lightOutput's doc
// comment. Extends the plain resolved color with what's needed to draw the
// same per-LED pattern the real addressable hardware gets (see
// LightEngine.cpp's writeDmxChannels).
export type PreviewColor = LightCueValue & {
  meterLevel01?: number;
  gradientPreset?: "solid" | "greenYellowRed";
  effectType?: SpatialEffectType | "none" | "meter" | "strobe" | "pulse" | "ripple";
  effectTSec?: number;
  effectRateHz?: number;
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

  // The scene's ambient + directional lights reflect off a mesh's diffuse
  // `color` regardless of `emissive` -- so a fully-saturated diffuse color
  // with only a low emissiveIntensity still reads as fairly bright (the
  // "strobe/converge never really looks off" bug this fixes). Baking the
  // resolved intensity straight into the diffuse color (not just emissive)
  // means an LED at intensity 0 is actually black under any lighting, matching
  // real DMX output where 0 intensity means 0 on the wire -- no artificial
  // floor needed for "visibility", since a real blackout looks like nothing.
  const color = useMemo(() => {
    if (previewColor) {
      return new THREE.Color(
        previewColor.r / 255,
        previewColor.g / 255,
        previewColor.b / 255,
      ).multiplyScalar(Math.max(0, Math.min(1, previewColor.intensity)));
    }
    return new THREE.Color(0.55, 0.58, 0.65);
  }, [previewColor]);

  const emissiveIntensity = previewColor ? 1 : 0.25;

  // Addressable fixtures only render a segmented per-LED pattern while
  // their active cue is genuinely Meter, Converge, or GradientFlow --
  // matching the real DMX output exactly (see writeDmxChannels) instead of
  // an always-on decorative gradient that wouldn't reflect reality.
  const meterActive =
    fixture.addressable && previewColor?.meterLevel01 !== undefined && previewColor.meterLevel01 > 0;
  const spatialEffectActive =
    fixture.addressable && !meterActive &&
    (previewColor?.effectType === "converge" || previewColor?.effectType === "gradientflow");
  // Capped/floored purely for render cost and visibility -- the real DMX
  // output still addresses every physical LED; this is just how many
  // discrete segments the 3D preview bothers to draw.
  const totalSegments = Math.min(20, Math.max(3, Math.round(fixture.ledCount / 3)));
  const litCount = meterActive
    ? Math.round((previewColor!.meterLevel01 ?? 0) * totalSegments)
    : totalSegments;
  const segments = useMemo(() => {
    if (meterActive) {
      const preset = previewColor?.gradientPreset ?? "solid";
      return Array.from({ length: totalSegments }, (_, i) => {
        if (i >= litCount) return { color: new THREE.Color(0, 0, 0), level: 1 };
        if (preset === "solid") {
          return {
            color: new THREE.Color(
              (previewColor?.r ?? 0) / 255,
              (previewColor?.g ?? 0) / 255,
              (previewColor?.b ?? 0) / 255,
            ),
            level: 1,
          };
        }
        // greenYellowRed: colored by position on the bar, same bands as
        // LightOutputResolver.h's meterLedColor (bottom 60% green, next
        // 25% yellow, top 15% red) -- independent of the cue's own color.
        const t = totalSegments > 1 ? i / (totalSegments - 1) : 0;
        if (t < 0.6) return { color: new THREE.Color(40 / 255, 220 / 255, 90 / 255), level: 1 };
        if (t < 0.85) return { color: new THREE.Color(240 / 255, 210 / 255, 40 / 255), level: 1 };
        return { color: new THREE.Color(235 / 255, 60 / 255, 50 / 255), level: 1 };
      });
    }
    if (spatialEffectActive) {
      const type = previewColor!.effectType as "converge" | "gradientflow";
      return Array.from({ length: totalSegments }, (_, i) => {
        const led = addressableEffectLedColor(
          i, totalSegments, type,
          previewColor?.effectTSec ?? 0, previewColor?.effectRateHz ?? 2,
          previewColor?.r ?? 0, previewColor?.g ?? 0, previewColor?.b ?? 0,
        );
        return { color: new THREE.Color(led.r / 255, led.g / 255, led.b / 255), level: led.level };
      });
    }
    return null;
  }, [meterActive, spatialEffectActive, litCount, totalSegments, previewColor]);
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
              <mesh
                key={idx}
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
                  emissiveIntensity={Math.max(0.08, previewColor!.intensity * seg.level)}
                />
              </mesh>
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
