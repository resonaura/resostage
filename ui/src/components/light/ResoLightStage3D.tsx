import { Canvas } from "@react-three/fiber";
import { Grid, OrbitControls, Text } from "@react-three/drei";
import { useMemo, useState } from "react";
import * as THREE from "three";
import type { LightFixtureRow } from "../../lib/types";
import type { LightCueValue } from "../../lib/lightCueInterpolation";

// One shared 3D scene, two modes, so the "3D editor" (Settings' project
// card) and the "live preview simulator" (Timeline's Light mode) render
// identically -- see RESTORE_POINT.md Feature 6. `edit` lets the user
// click-drag a bar across the ground plane to reposition it (X/Z only --
// height/rotation are precise-entry fields in the surrounding panel, not a
// 3D drag, since dragging vertically in a top-down-ish view is awkward
// UX); `preview` is read-only and colors each bar from `previewColors`.
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
  previewColors?: Record<string, LightCueValue>;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragPos, setDragPos] = useState<{ x: number; z: number } | null>(null);

  return (
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
    </Canvas>
  );
}

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
  previewColor?: LightCueValue;
}) {
  // Rough visual scale: ~30 LEDs per meter of bar height, clamped so a
  // 1-LED or 500-LED fixture still renders as something sane on stage.
  const heightMeters = Math.min(3, Math.max(0.3, fixture.ledCount / 30));

  const color = useMemo(() => {
    if (previewColor) {
      return new THREE.Color(
        previewColor.r / 255,
        previewColor.g / 255,
        previewColor.b / 255,
      );
    }
    return new THREE.Color(0.55, 0.58, 0.65);
  }, [previewColor]);
  const emissiveIntensity = previewColor ? Math.max(0.08, previewColor.intensity) : 0.25;

  return (
    <group
      position={[x, fixture.posY, z]}
      rotation={[0, THREE.MathUtils.degToRad(fixture.rotationYDeg), 0]}
    >
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
      {editable && (
        <mesh position={[0, -0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.12, selected ? 0.18 : 0.15, 24]} />
          <meshBasicMaterial color={selected ? "#38bdf8" : "#475569"} />
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
  );
}
