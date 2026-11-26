"use client";

import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { Html, OrbitControls } from "@react-three/drei";
import { Color, InstancedMesh, Object3D } from "three";
import type { DepartmentOccupancy, WardOccupancy } from "@/lib/beds/types";
import { BedGrid2D } from "./BedGrid2D";
import { bedsInUse } from "./beds";
import { fmtNum, occupancyTone } from "./format";
import { WardDetail } from "./WardDetail";

const ZONE_COLS = 2;
const ROOMS_PER_ZONE_ROW = 2;
const ROOM_W = 10;
const ROOM_D = 8;
const GAP = 1.5;
const ZONE_PAD = 1.5;
const ZONE_GAP = 3;
const BED_SX = 0.8;
const BED_SZ = 1.5;

const COLOR_FREE = "#22c55e";
const COLOR_OCCUPIED = "#f59e0b";
const COLOR_FULL = "#dc2626";
const COLOR_OVER = "#7f1d1d";

const FLOOR_COLOR = { green: "#bbf7d0", amber: "#fde68a", red: "#fecaca", slate: "#e2e8f0", brand: "#d5f2ed" };

type RoomLayout = { ward: WardOccupancy; cx: number; cz: number };
type ZoneLayout = { code: string; name: string; cx: number; cz: number; w: number; d: number };
type BedItem = { x: number; z: number; s: number; color: string };
type SceneLayout = { rooms: RoomLayout[]; zones: ZoneLayout[]; width: number; depth: number };

function detectWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

/** Cluster wards into one floor zone per department; zones sit on a 2-column grid. */
function layoutScene(wards: WardOccupancy[], departments: DepartmentOccupancy[]): SceneLayout {
  const groups: { code: string; name: string; wards: WardOccupancy[] }[] = [];
  for (const d of departments) {
    const ws = wards.filter((w) => d.wardCodes.includes(w.wardCode));
    if (ws.length > 0) groups.push({ code: d.departmentCode, name: d.departmentName, wards: ws });
  }
  const placed = new Set(groups.flatMap((g) => g.wards.map((w) => w.wardCode)));
  const rest = wards.filter((w) => !placed.has(w.wardCode));
  if (rest.length > 0) groups.push({ code: "none", name: "ไม่ระบุแผนก", wards: rest });

  const sized = groups.map((g) => {
    const cols = Math.min(g.wards.length, ROOMS_PER_ZONE_ROW);
    const rows = Math.ceil(g.wards.length / ROOMS_PER_ZONE_ROW);
    return {
      ...g,
      cols,
      rows,
      w: cols * ROOM_W + (cols - 1) * GAP + ZONE_PAD * 2,
      d: rows * ROOM_D + (rows - 1) * GAP + ZONE_PAD * 2 + 1.5,
    };
  });

  const zoneRows = Math.ceil(sized.length / ZONE_COLS);
  const colW: number[] = Array.from({ length: ZONE_COLS }, (_, c) =>
    Math.max(0, ...sized.filter((_, i) => i % ZONE_COLS === c).map((z) => z.w)),
  );
  const rowD: number[] = Array.from({ length: zoneRows }, (_, r) =>
    Math.max(0, ...sized.slice(r * ZONE_COLS, r * ZONE_COLS + ZONE_COLS).map((z) => z.d)),
  );
  const width = colW.reduce((a, b) => a + b, 0) + (ZONE_COLS - 1) * ZONE_GAP;
  const depth = rowD.reduce((a, b) => a + b, 0) + (zoneRows - 1) * ZONE_GAP;

  const rooms: RoomLayout[] = [];
  const zones: ZoneLayout[] = [];
  sized.forEach((z, i) => {
    const c = i % ZONE_COLS;
    const r = Math.floor(i / ZONE_COLS);
    const x0 = colW.slice(0, c).reduce((a, b) => a + b + ZONE_GAP, 0) - width / 2;
    const z0 = rowD.slice(0, r).reduce((a, b) => a + b + ZONE_GAP, 0) - depth / 2;
    const zcx = x0 + z.w / 2;
    const zcz = z0 + z.d / 2;
    zones.push({ code: z.code, name: z.name, cx: zcx, cz: zcz, w: z.w, d: z.d });
    z.wards.forEach((ward, k) => {
      const rowCount = Math.min(ROOMS_PER_ZONE_ROW, z.wards.length - Math.floor(k / ROOMS_PER_ZONE_ROW) * ROOMS_PER_ZONE_ROW);
      const col = k % ROOMS_PER_ZONE_ROW;
      rooms.push({
        ward,
        cx: zcx + (col - (rowCount - 1) / 2) * (ROOM_W + GAP),
        cz: z0 + ZONE_PAD + 1.5 + ROOM_D / 2 + Math.floor(k / ROOMS_PER_ZONE_ROW) * (ROOM_D + GAP),
      });
    });
  });
  return { rooms, zones, width, depth };
}

function layoutBeds(rooms: RoomLayout[]): BedItem[] {
  const items: BedItem[] = [];
  for (const { ward, cx, cz } of rooms) {
    const used = bedsInUse(ward);
    const n = Math.max(ward.beds, used);
    if (n === 0) continue;
    const cols = Math.ceil(Math.sqrt(n * 1.6));
    const rows = Math.ceil(n / cols);
    const s = Math.min(1, (ROOM_W - 1) / (cols * BED_SX), (ROOM_D - 1.5) / (rows * BED_SZ));
    const stepX = BED_SX * s;
    const stepZ = BED_SZ * s;
    const startX = cx - (cols * stepX) / 2 + stepX / 2;
    const startZ = cz - (rows * stepZ) / 2 + stepZ / 2 + 0.3;
    const occupiedColor = ward.occupancyPct >= 100 ? COLOR_FULL : COLOR_OCCUPIED;
    for (let i = 0; i < n; i++) {
      items.push({
        x: startX + (i % cols) * stepX,
        z: startZ + Math.floor(i / cols) * stepZ,
        s,
        color: i >= ward.beds ? COLOR_OVER : i < used ? occupiedColor : COLOR_FREE,
      });
    }
  }
  return items;
}

function Beds({ items }: { items: BedItem[] }) {
  const mattress = useRef<InstancedMesh>(null);
  const head = useRef<InstancedMesh>(null);
  const invalidate = useThree((s) => s.invalidate);

  useLayoutEffect(() => {
    const m = mattress.current;
    const h = head.current;
    if (!m || !h) return;
    const o = new Object3D();
    const c = new Color();
    items.forEach((it, i) => {
      o.scale.setScalar(it.s);
      o.position.set(it.x, 0.3 * it.s + 0.2, it.z);
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
      m.setColorAt(i, c.set(it.color));
      o.position.set(it.x, 0.5 * it.s + 0.2, it.z - 0.55 * it.s);
      o.updateMatrix();
      h.setMatrixAt(i, o.matrix);
    });
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    h.instanceMatrix.needsUpdate = true;
    invalidate();
  }, [items, invalidate]);

  return (
    <>
      <instancedMesh key={`m${items.length}`} ref={mattress} args={[undefined, undefined, items.length]}>
        <boxGeometry args={[0.6, 0.25, 1.1]} />
        <meshStandardMaterial />
      </instancedMesh>
      <instancedMesh key={`h${items.length}`} ref={head} args={[undefined, undefined, items.length]}>
        <boxGeometry args={[0.6, 0.6, 0.1]} />
        <meshStandardMaterial color="#e2e8f0" />
      </instancedMesh>
    </>
  );
}

function Zone({ zone }: { zone: ZoneLayout }) {
  return (
    <group position={[zone.cx, 0, zone.cz]}>
      <mesh position={[0, 0.02, 0]}>
        <boxGeometry args={[zone.w, 0.1, zone.d]} />
        <meshStandardMaterial color="#99d5cd" />
      </mesh>
      <Html position={[0, 0.3, -zone.d / 2 + 0.9]} center zIndexRange={[10, 0]} pointerEvents="none">
        <div className="whitespace-nowrap rounded-md bg-brand-700 px-3 py-0.5 text-sm font-semibold text-white shadow">
          แผนก{zone.name}
        </div>
      </Html>
    </group>
  );
}

function Room({
  room,
  active,
  onHover,
  onSelect,
}: {
  room: RoomLayout;
  active: boolean;
  onHover: (code: string | null) => void;
  onSelect: (code: string) => void;
}) {
  const { ward, cx, cz } = room;
  const tone = occupancyTone(ward.occupancyPct);
  const over = bedsInUse(ward) > ward.beds;
  return (
    <group position={[cx, 0, cz]}>
      {over ? (
        <mesh position={[0, 0.08, 0]}>
          <boxGeometry args={[ROOM_W + 0.6, 0.1, ROOM_D + 0.6]} />
          <meshStandardMaterial color="#dc2626" emissive="#dc2626" emissiveIntensity={0.6} />
        </mesh>
      ) : null}
      <mesh
        position={[0, 0.1, 0]}
        onPointerOver={(e) => {
          e.stopPropagation();
          onHover(ward.wardCode);
          document.body.style.cursor = "pointer";
        }}
        onPointerOut={() => {
          onHover(null);
          document.body.style.cursor = "";
        }}
        onClick={(e) => {
          e.stopPropagation();
          onSelect(ward.wardCode);
        }}
      >
        <boxGeometry args={[ROOM_W, 0.2, ROOM_D]} />
        <meshStandardMaterial
          color={FLOOR_COLOR[tone]}
          emissive={active ? "#ffffff" : "#000000"}
          emissiveIntensity={active ? 0.35 : 0}
        />
      </mesh>
      <Html position={[0, 0.4, -ROOM_D / 2 - 0.2]} center zIndexRange={[10, 0]} pointerEvents="none">
        <div
          className={`whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium shadow ${
            over ? "bg-red-600 text-white" : "bg-white/90 text-slate-800"
          }`}
        >
          {ward.wardName} ว่าง {fmtNum(ward.available)}/{fmtNum(ward.beds)}
        </div>
      </Html>
    </group>
  );
}

function Scene({
  layout,
  activeCode,
  onHover,
  onSelect,
}: {
  layout: SceneLayout;
  activeCode: string | null;
  onHover: (code: string | null) => void;
  onSelect: (code: string) => void;
}) {
  const items = useMemo(() => layoutBeds(layout.rooms), [layout.rooms]);
  return (
    <>
      <ambientLight intensity={1.1} />
      <directionalLight position={[15, 30, 20]} intensity={1.6} />
      <mesh position={[0, -0.1, 0]}>
        <boxGeometry args={[layout.width + 6, 0.2, layout.depth + 6]} />
        <meshStandardMaterial color="#cbd5e1" />
      </mesh>
      {layout.zones.map((z) => (
        <Zone key={z.code} zone={z} />
      ))}
      {layout.rooms.map((r) => (
        <Room key={r.ward.wardCode} room={r} active={r.ward.wardCode === activeCode} onHover={onHover} onSelect={onSelect} />
      ))}
      <Beds items={items} />
      <OrbitControls makeDefault maxPolarAngle={Math.PI / 2.3} minDistance={12} maxDistance={120} />
    </>
  );
}

function Legend() {
  const dot = "inline-block h-2.5 w-2.5 rounded-sm";
  return (
    <div className="flex flex-wrap gap-3 text-xs text-slate-600">
      <span className="inline-flex items-center gap-1">
        <span className={`${dot} bg-emerald-500`} /> เตียงว่าง
      </span>
      <span className="inline-flex items-center gap-1">
        <span className={`${dot} bg-amber-500`} /> เตียงคนนอน
      </span>
      <span className="inline-flex items-center gap-1">
        <span className={`${dot} bg-red-600`} /> หอเต็ม
      </span>
      <span className="inline-flex items-center gap-1">
        <span className={`${dot} bg-red-900`} /> เกินจำนวนเตียง
      </span>
    </div>
  );
}

export default function BedScene({
  wards,
  departments,
}: {
  wards: WardOccupancy[];
  departments: DepartmentOccupancy[];
}) {
  const webgl = useSyncExternalStore(
    () => () => {},
    detectWebGL,
    () => null,
  );
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const layout = useMemo(() => layoutScene(wards, departments), [wards, departments]);

  if (webgl === null) return <div className="h-[420px]" />;
  if (!webgl) return <BedGrid2D wards={wards} />;

  const activeCode = hovered ?? selected;
  const active = wards.find((w) => w.wardCode === activeCode) ?? null;
  const reach = Math.max(layout.width, layout.depth * 1.3);

  return (
    <div className="space-y-2">
      <div className="relative h-[520px] overflow-hidden rounded-md bg-brand-50">
        <Canvas frameloop="demand" dpr={[1, 1.5]} camera={{ position: [0, reach * 0.9, reach * 0.8], fov: 45 }}>
          <Scene layout={layout} activeCode={activeCode} onHover={setHovered} onSelect={setSelected} />
        </Canvas>
        <div className="absolute left-3 top-3 max-w-xs rounded-md bg-white/90 p-2 shadow">
          <WardDetail ward={active} />
        </div>
      </div>
      <Legend />
    </div>
  );
}
