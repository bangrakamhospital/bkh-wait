"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentRef,
} from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Edges, Html, OrbitControls } from "@react-three/drei";
import { CanvasTexture, Color, DynamicDrawUsage, MathUtils, Object3D, SRGBColorSpace, Vector3 } from "three";
import type { Group, InstancedMesh, PerspectiveCamera } from "three";
import type { DepartmentOccupancy, WardOccupancy } from "@/lib/beds/types";
import { BedGrid2D } from "./BedGrid2D";
import { bedsInUse } from "./beds";
import { fmtNum, occupancyTone } from "./format";
import { buttonGhostClass } from "./ui";
import { WardDetail } from "./WardDetail";

const ZONE_COLS = 2;
const ROOMS_PER_ZONE_ROW = 2;
const GAP = 3;
const ZONE_PAD = 1.5;
const ZONE_GAP = 4;
/** Strip at the front edge of every zone reserved for the department label. */
const LABEL_STRIP = 2.2;
/** One fixed bed footprint everywhere; rooms grow with their bed grid. */
const BED_SX = 0.8;
const BED_SZ = 1.5;
const MIN_ROOM_W = 6;
const MIN_ROOM_D = 5;

const COLOR_FREE = "#22c55e";
const COLOR_OCCUPIED = "#f59e0b";
const COLOR_FULL = "#dc2626";
const COLOR_OVER = "#7f1d1d";
const PULSE_OCCUPIED = new Color("#fde68a");
const PULSE_FULL = new Color("#ff8a80");

const FLOOR_COLOR = {
  green: "#bbf7d0",
  amber: "#fde68a",
  red: "#fecaca",
  slate: "#e2e8f0",
  brand: "#d5f2ed",
};

const ANIM_KEY = "bedSceneAnimation";
const IDLE_SECONDS = 8;
const INTRO_STAGGER = 0.12;

type BedKind = "free" | "occ" | "full" | "over";
type RoomLayout = {
  ward: WardOccupancy;
  idx: number;
  cx: number;
  cz: number;
  w: number;
  d: number;
  cols: number;
  col: number;
  rows: number;
};
type ZoneLayout = {
  code: string;
  name: string;
  cx: number;
  cz: number;
  w: number;
  d: number;
};
type BedItem = {
  key: string;
  ward: string;
  wardIdx: number;
  i: number;
  x: number;
  z: number;
  color: string;
  kind: BedKind;
};
type SceneLayout = {
  rooms: RoomLayout[];
  zones: ZoneLayout[];
  width: number;
  depth: number;
};
/** What the camera should frame: a box on the floor plus a margin (room for labels). */
type Goal = { key: string; cx: number; cz: number; w: number; d: number; margin: number };

const VIEW_ELEV = Math.atan2(0.9, 0.8);

/** Camera position that fits the goal box into the current viewport aspect, with perspective slack. */
function goalPose(g: Goal, fov: number, aspect: number): Vector3 {
  const v = (fov * Math.PI) / 180;
  const h = 2 * Math.atan(Math.tan(v / 2) * aspect);
  // Bounding sphere: stays fully in view from every auto-rotate angle.
  const radius = Math.hypot(g.w, g.d) / 2 + g.margin;
  const dist = Math.max(14, (radius / Math.sin(Math.min(v, h) / 2)) * 1.05);
  return new Vector3(g.cx, dist * Math.sin(VIEW_ELEV), g.cz + dist * Math.cos(VIEW_ELEV));
}
type View = { kind: "overview" | "ward" | "dept"; code: string; n: number };
/** Mutable animation state shared by rooms, beds and the camera rig (never read during render). */
type Shared = { lift: Record<string, number>; introAt: number };
const SHARED: Shared = { lift: {}, introAt: 0 };

const now = () => performance.now() / 1000;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const easeOutCubic = (p: number) => 1 - Math.pow(1 - p, 3);
const easeOutBack = (p: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
};
function introTime(shared: Shared): number {
  if (shared.introAt === 0) shared.introAt = now();
  return shared.introAt;
}

function detectWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

function readAnimPref(): boolean {
  try {
    const v = localStorage.getItem(ANIM_KEY);
    if (v === "on") return true;
    if (v === "off") return false;
  } catch {
    // storage unavailable: fall through to the OS preference
  }
  try {
    return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return true;
  }
}

function roomSize(n: number) {
  if (n === 0) return { cols: 0, rows: 0, w: MIN_ROOM_W, d: MIN_ROOM_D };
  const cols = Math.ceil(Math.sqrt(n * 1.6));
  const rows = Math.ceil(n / cols);
  return {
    cols,
    rows,
    w: Math.max(MIN_ROOM_W, cols * BED_SX + 1.4),
    d: Math.max(MIN_ROOM_D, rows * BED_SZ + 1.8),
  };
}

/** Cluster wards into one floor zone per department; rooms are sized to their bed grid. */
function layoutScene(wards: WardOccupancy[], departments: DepartmentOccupancy[]): SceneLayout {
  const groups: { code: string; name: string; wards: WardOccupancy[] }[] = [];
  for (const d of departments) {
    const ws = wards.filter((w) => d.wardCodes.includes(w.wardCode));
    if (ws.length > 0)
      groups.push({
        code: d.departmentCode,
        name: d.departmentName,
        wards: ws,
      });
  }
  const placed = new Set(groups.flatMap((g) => g.wards.map((w) => w.wardCode)));
  const rest = wards.filter((w) => !placed.has(w.wardCode));
  if (rest.length > 0) groups.push({ code: "none", name: "ไม่ระบุแผนก", wards: rest });

  const sized = groups.map((g) => {
    const rooms = g.wards.map((ward) => ({
      ward,
      ...roomSize(Math.max(ward.beds, bedsInUse(ward))),
    }));
    const rowCount = Math.ceil(rooms.length / ROOMS_PER_ZONE_ROW);
    const colCount = Math.min(rooms.length, ROOMS_PER_ZONE_ROW);
    const colW = Array.from({ length: colCount }, (_, c) =>
      Math.max(...rooms.filter((_, k) => k % ROOMS_PER_ZONE_ROW === c).map((r) => r.w)),
    );
    const rowD = Array.from({ length: rowCount }, (_, r) =>
      Math.max(...rooms.slice(r * ROOMS_PER_ZONE_ROW, (r + 1) * ROOMS_PER_ZONE_ROW).map((x) => x.d)),
    );
    return {
      ...g,
      rooms,
      colW,
      rowD,
      w: colW.reduce((a, b) => a + b, 0) + (colCount - 1) * GAP + ZONE_PAD * 2,
      d: rowD.reduce((a, b) => a + b, 0) + (rowCount - 1) * GAP + ZONE_PAD * 2 + LABEL_STRIP,
    };
  });

  const zoneRows = Math.ceil(sized.length / ZONE_COLS);
  const gridW: number[] = Array.from({ length: ZONE_COLS }, (_, c) =>
    Math.max(0, ...sized.filter((_, i) => i % ZONE_COLS === c).map((z) => z.w)),
  );
  const gridD: number[] = Array.from({ length: zoneRows }, (_, r) =>
    Math.max(0, ...sized.slice(r * ZONE_COLS, r * ZONE_COLS + ZONE_COLS).map((z) => z.d)),
  );
  const width = gridW.reduce((a, b) => a + b, 0) + (ZONE_COLS - 1) * ZONE_GAP;
  const depth = gridD.reduce((a, b) => a + b, 0) + (zoneRows - 1) * ZONE_GAP;

  const rooms: RoomLayout[] = [];
  const zones: ZoneLayout[] = [];
  sized.forEach((z, i) => {
    const c = i % ZONE_COLS;
    const r = Math.floor(i / ZONE_COLS);
    const x0 = gridW.slice(0, c).reduce((a, b) => a + b + ZONE_GAP, 0) - width / 2;
    const z0 = gridD.slice(0, r).reduce((a, b) => a + b + ZONE_GAP, 0) - depth / 2;
    zones.push({
      code: z.code,
      name: z.name,
      cx: x0 + z.w / 2,
      cz: z0 + z.d / 2,
      w: z.w,
      d: z.d,
    });
    z.rooms.forEach((room, k) => {
      const col = k % ROOMS_PER_ZONE_ROW;
      const row = Math.floor(k / ROOMS_PER_ZONE_ROW);
      const cellX = x0 + ZONE_PAD + z.colW.slice(0, col).reduce((a, b) => a + b + GAP, 0);
      const cellZ = z0 + ZONE_PAD + z.rowD.slice(0, row).reduce((a, b) => a + b + GAP, 0);
      rooms.push({
        ward: room.ward,
        idx: rooms.length,
        cx: cellX + z.colW[col] / 2,
        cz: cellZ + z.rowD[row] / 2,
        w: room.w,
        d: room.d,
        cols: room.cols,
        col,
        rows: room.rows,
      });
    });
  });
  return { rooms, zones, width, depth };
}

function layoutBeds(rooms: RoomLayout[]): BedItem[] {
  const items: BedItem[] = [];
  for (const { ward, idx, cx, cz, cols, rows } of rooms) {
    const used = bedsInUse(ward);
    const n = Math.max(ward.beds, used);
    if (n === 0) continue;
    const startX = cx - (cols * BED_SX) / 2 + BED_SX / 2;
    const startZ = cz - (rows * BED_SZ) / 2 + BED_SZ / 2 + 0.2;
    const full = ward.occupancyPct >= 100;
    for (let i = 0; i < n; i++) {
      const kind: BedKind = i >= ward.beds ? "over" : i < used ? (full ? "full" : "occ") : "free";
      items.push({
        key: `${ward.wardCode}:${i}`,
        ward: ward.wardCode,
        wardIdx: idx,
        i,
        x: startX + (i % cols) * BED_SX,
        z: startZ + Math.floor(i / cols) * BED_SZ,
        kind,
        color:
          kind === "over" ? COLOR_OVER : kind === "full" ? COLOR_FULL : kind === "occ" ? COLOR_OCCUPIED : COLOR_FREE,
      });
    }
  }
  return items;
}

type BedState = { cur: Color; target: Color; birth: number; hop: number };

function Beds({ items, anim }: { items: BedItem[]; anim: boolean }) {
  const mattress = useRef<InstancedMesh>(null);
  const head = useRef<InstancedMesh>(null);
  const states = useRef(new Map<string, BedState>());
  const invalidate = useThree((s) => s.invalidate);
  const tmp = useMemo(() => ({ o: new Object3D(), c: new Color() }), []);

  const apply = useCallback(
    (t: number, dt: number) => {
      const m = mattress.current;
      const h = head.current;
      if (!m || !h) return;
      const { o, c } = tmp;
      const k = 1 - Math.exp(-8 * dt);
      items.forEach((it, i) => {
        const st = states.current.get(it.key);
        if (!st) return;
        let scale = 1;
        let hop = 0;
        let lift = 0;
        if (anim) {
          scale = easeOutBack(clamp01((t - st.birth) / 0.5));
          if (st.hop >= 0) {
            const p = clamp01((t - st.hop) / 0.45);
            hop = Math.sin(p * Math.PI) * 0.7;
            if (p >= 1) st.hop = -1;
          }
          st.cur.lerp(st.target, k);
          lift = SHARED.lift[it.ward] ?? 0;
        } else {
          st.cur.copy(st.target);
        }
        c.copy(st.cur);
        if (anim && (it.kind === "occ" || it.kind === "full")) {
          const full = it.kind === "full";
          const wave = 0.5 + 0.5 * Math.sin(t * (full ? 4 : 1.6) + it.wardIdx * 0.7 + it.i * 0.35);
          c.lerp(full ? PULSE_FULL : PULSE_OCCUPIED, (full ? 0.4 : 0.18) * wave);
        }
        o.scale.setScalar(scale);
        o.position.set(it.x, 0.5 + hop + lift, it.z);
        o.updateMatrix();
        m.setMatrixAt(i, o.matrix);
        m.setColorAt(i, c);
        o.position.set(it.x, 0.7 + hop + lift, it.z - 0.55);
        o.updateMatrix();
        h.setMatrixAt(i, o.matrix);
      });
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      h.instanceMatrix.needsUpdate = true;
    },
    [items, anim, tmp],
  );

  // Reconcile per-bed state with the new data: colour changes start a transition + hop.
  useLayoutEffect(() => {
    const map = states.current;
    const t = now();
    const first = map.size === 0;
    const seen = new Set<string>();
    const next = new Color();
    for (const it of items) {
      seen.add(it.key);
      next.set(it.color);
      const st = map.get(it.key);
      if (!st) {
        const birth = anim && first ? introTime(SHARED) + 0.5 + it.wardIdx * INTRO_STAGGER + it.i * 0.006 : t;
        map.set(it.key, {
          cur: next.clone(),
          target: next.clone(),
          birth,
          hop: -1,
        });
      } else if (!next.equals(st.target)) {
        st.target.copy(next);
        if (anim) st.hop = t;
      }
    }
    for (const key of map.keys()) if (!seen.has(key)) map.delete(key);
    apply(t, 0.016);
    invalidate();
  }, [items, anim, apply, invalidate]);

  useFrame((_, dt) => {
    if (anim) apply(now(), Math.min(dt, 0.1));
  });

  return (
    <>
      <instancedMesh
        key={`m${items.length}`}
        ref={mattress}
        args={[undefined, undefined, items.length]}
        frustumCulled={false}
        onUpdate={(m) => m.instanceMatrix.setUsage(DynamicDrawUsage)}
      >
        <boxGeometry args={[0.6, 0.25, 1.1]} />
        <meshStandardMaterial />
      </instancedMesh>
      <instancedMesh
        key={`h${items.length}`}
        ref={head}
        args={[undefined, undefined, items.length]}
        frustumCulled={false}
        onUpdate={(m) => m.instanceMatrix.setUsage(DynamicDrawUsage)}
      >
        <boxGeometry args={[0.6, 0.6, 0.1]} />
        <meshStandardMaterial color="#e2e8f0" />
      </instancedMesh>
    </>
  );
}

const FLOOR_LABEL_H = 1.4;

/** Flat text on the floor, drawn to a canvas texture (system fonts cover Thai; no font download). */
function FloorLabel({ text, width, z }: { text: string; width: number; z: number }) {
  const texture = useMemo(() => {
    const W = 1024;
    const H = Math.round((W * FLOOR_LABEL_H) / width);
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#14635f";
      ctx.beginPath();
      ctx.roundRect(0, 0, W, H, H * 0.25);
      ctx.fill();
      const family = getComputedStyle(document.body).fontFamily || "sans-serif";
      let size = H * 0.6;
      ctx.font = `600 ${size}px ${family}`;
      const measured = ctx.measureText(text).width;
      if (measured > W * 0.9) {
        size = (size * W * 0.9) / measured;
        ctx.font = `600 ${size}px ${family}`;
      }
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, W / 2, H / 2);
    }
    const t = new CanvasTexture(canvas);
    t.colorSpace = SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }, [text, width]);
  useEffect(() => () => texture.dispose(), [texture]);
  return (
    <mesh position={[0, 0.1, z]} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[width, FLOOR_LABEL_H]} />
      <meshBasicMaterial map={texture} transparent toneMapped={false} />
    </mesh>
  );
}

function Zone({ zone }: { zone: ZoneLayout }) {
  return (
    <group position={[zone.cx, 0, zone.cz]}>
      <mesh position={[0, 0.02, 0]}>
        <boxGeometry args={[zone.w, 0.1, zone.d]} />
        <meshStandardMaterial color="#99d5cd" />
      </mesh>
      {/* Department tag lies flat on the floor in the zone's front margin, so it can never overlap a room. */}
      <FloorLabel text={`แผนก${zone.name}`} width={Math.min(zone.w - 1, 12)} z={zone.d / 2 - LABEL_STRIP / 2} />
    </group>
  );
}

function Room({
  room,
  active,
  anim,
  showLabel,
  onHover,
  onSelect,
}: {
  room: RoomLayout;
  active: boolean;
  anim: boolean;
  showLabel: boolean;
  onHover: (code: string | null) => void;
  onSelect: (code: string) => void;
}) {
  const { ward, cx, cz, w, d } = room;
  const inner = useRef<Group>(null);
  const tone = occupancyTone(ward.occupancyPct);
  const over = bedsInUse(ward) > ward.beds;

  useFrame((_, dt) => {
    const g = inner.current;
    if (!g) return;
    let rise = 1;
    let lift = 0;
    if (anim) {
      rise = easeOutCubic(clamp01((now() - introTime(SHARED) - room.idx * INTRO_STAGGER) / 0.8));
      lift = MathUtils.damp(SHARED.lift[ward.wardCode] ?? 0, active ? 0.6 : 0, 10, Math.min(dt, 0.1));
    }
    SHARED.lift[ward.wardCode] = lift;
    g.scale.y = Math.max(rise, 0.001);
    g.position.y = lift;
  });

  return (
    <group position={[cx, 0, cz]}>
      <group ref={inner}>
        {over ? (
          <mesh position={[0, 0.08, 0]}>
            <boxGeometry args={[w + 0.6, 0.1, d + 0.6]} />
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
          <boxGeometry args={[w, 0.2, d]} />
          <meshStandardMaterial
            color={FLOOR_COLOR[tone]}
            emissive={active ? "#ffffff" : "#000000"}
            emissiveIntensity={active ? 0.35 : 0}
          />
          {active ? <Edges color="#0f766e" /> : null}
        </mesh>
        {showLabel ? (
          <Html
            position={[0, 2.2 + (room.col % 2) * 1.8, -d / 2 + 0.6]}
            center
            zIndexRange={[20, 0]}
            pointerEvents="none"
          >
            <div className={anim ? "bed-float" : undefined}>
              <div
                className={`flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs shadow ${
                  over ? "bg-red-50 ring-1 ring-red-600" : "bg-white/95"
                }`}
              >
                <span className="font-semibold text-slate-800">{ward.wardName}</span>
                <span
                  className={`rounded-full px-2 py-0.5 font-semibold text-white ${
                    ward.available > 0 ? "bg-emerald-600" : "bg-red-600"
                  }`}
                >
                  {over ? "เกิน" : ward.available > 0 ? `ว่าง ${fmtNum(ward.available)}` : "เต็ม"}
                </span>
                <span className="text-slate-500">/{fmtNum(ward.beds)}</span>
              </div>
            </div>
          </Html>
        ) : null}
      </group>
    </group>
  );
}

type RigProps = { goal: Goal; anim: boolean; idleOk: boolean };

/** Camera flights (intro, ward, department, overview) and idle auto-rotate. */
function CameraRig({ goal, anim, idleOk }: RigProps) {
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null);
  const camera = useThree((s) => s.camera);
  const invalidate = useThree((s) => s.invalidate);
  const size = useThree((s) => s.size);
  const latest = useRef<RigProps>({ goal, anim, idleOk });
  const flight = useRef<{ pos: Vector3; target: Vector3 } | null>(null);
  const lastActive = useRef(0);
  const started = useRef(false);

  useEffect(() => {
    latest.current = { goal, anim, idleOk };
  });

  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    const { goal: g, anim: animated } = latest.current;
    const pos = goalPose(g, (camera as PerspectiveCamera).fov, size.width / Math.max(size.height, 1));
    const target = new Vector3(g.cx, 0, g.cz);
    if (!animated) {
      camera.position.copy(pos);
      c.target.copy(target);
      c.update();
      flight.current = null;
      invalidate();
      return;
    }
    if (!started.current) {
      // Intro: start high and far, off to one side.
      camera.position.set(pos.x + 22, pos.y * 1.9 + 20, pos.z * 1.9 + 10);
      started.current = true;
    }
    flight.current = { pos, target };
    lastActive.current = now();
  }, [goal.key, size.width, size.height, camera, controls, invalidate]);

  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    const stop = () => {
      flight.current = null;
      lastActive.current = now();
    };
    const touch = () => {
      lastActive.current = now();
    };
    c.addEventListener("start", stop);
    c.addEventListener("end", touch);
    return () => {
      c.removeEventListener("start", stop);
      c.removeEventListener("end", touch);
    };
  }, [controls]);

  useFrame((_, dtRaw) => {
    const c = controls.current;
    if (!c) return;
    const dt = Math.min(dtRaw, 0.1);
    const f = flight.current;
    if (f && latest.current.anim) {
      const lam = 3.2;
      camera.position.set(
        MathUtils.damp(camera.position.x, f.pos.x, lam, dt),
        MathUtils.damp(camera.position.y, f.pos.y, lam, dt),
        MathUtils.damp(camera.position.z, f.pos.z, lam, dt),
      );
      c.target.set(
        MathUtils.damp(c.target.x, f.target.x, lam, dt),
        MathUtils.damp(c.target.y, f.target.y, lam, dt),
        MathUtils.damp(c.target.z, f.target.z, lam, dt),
      );
      if (camera.position.distanceTo(f.pos) < 0.05 && c.target.distanceTo(f.target) < 0.05) {
        camera.position.copy(f.pos);
        c.target.copy(f.target);
        flight.current = null;
        lastActive.current = now();
      }
    }
    const { anim: animated, idleOk: ok } = latest.current;
    c.autoRotate = animated && ok && !flight.current && now() - lastActive.current > IDLE_SECONDS;
    c.autoRotateSpeed = 0.35;
  });

  return <OrbitControls ref={controls} makeDefault maxPolarAngle={Math.PI / 2.3} minDistance={6} maxDistance={220} />;
}

function Scene({
  layout,
  activeCode,
  anim,
  goal,
  idleOk,
  labelCodes,
  onHover,
  onSelect,
}: {
  layout: SceneLayout;
  activeCode: string | null;
  anim: boolean;
  labelCodes: ReadonlySet<string> | null;
  goal: Goal;
  idleOk: boolean;
  onHover: (code: string | null) => void;
  onSelect: (code: string) => void;
}) {
  const items = useMemo(() => layoutBeds(layout.rooms), [layout.rooms]);
  useEffect(
    () => () => {
      SHARED.lift = {};
      SHARED.introAt = 0;
    },
    [],
  );
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
        <Room
          key={r.ward.wardCode}
          room={r}
          active={r.ward.wardCode === activeCode}
          anim={anim}
          showLabel={labelCodes === null || labelCodes.has(r.ward.wardCode)}
          onHover={onHover}
          onSelect={onSelect}
        />
      ))}
      <Beds items={items} anim={anim} />
      <CameraRig goal={goal} anim={anim} idleOk={idleOk} />
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

function fitGoal(key: string, cx: number, cz: number, w: number, d: number, margin: number): Goal {
  return { key, cx, cz, w, d, margin };
}

export default function BedScene({
  wards,
  departments,
  focusDept,
}: {
  wards: WardOccupancy[];
  departments: DepartmentOccupancy[];
  focusDept: string;
}) {
  const webgl = useSyncExternalStore(
    () => () => {},
    detectWebGL,
    () => null,
  );
  const [hovered, setHovered] = useState<string | null>(null);
  const [view, setView] = useState<View>(() => ({
    kind: focusDept ? "dept" : "overview",
    code: focusDept,
    n: 0,
  }));
  const [prevDept, setPrevDept] = useState(focusDept);
  const [anim, setAnim] = useState(readAnimPref);
  const [visible, setVisible] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  const layout = useMemo(() => layoutScene(wards, departments), [wards, departments]);

  // Department chip changed: fly to that zone (or back to the overview).
  if (focusDept !== prevDept) {
    setPrevDept(focusDept);
    setView((v) => ({
      kind: focusDept ? "dept" : "overview",
      code: focusDept,
      n: v.n + 1,
    }));
  }

  // Stop rendering while the canvas is scrolled out of view.
  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, [webgl]);

  useEffect(
    () => () => {
      document.body.style.cursor = "";
    },
    [],
  );

  const goal = useMemo<Goal>(() => {
    const key = `${view.kind}:${view.code}:${view.n}`;
    if (view.kind === "ward") {
      const r = layout.rooms.find((x) => x.ward.wardCode === view.code);
      if (r) return fitGoal(key, r.cx, r.cz, r.w, r.d, 3);
    }
    if (view.kind === "dept") {
      const z = layout.zones.find((x) => x.code === view.code);
      if (z) return fitGoal(key, z.cx, z.cz, z.w, z.d, 4);
    }
    return fitGoal(key, 0, 0, layout.width + 6, layout.depth + 6, 5);
  }, [view, layout]);

  // Hide ward labels outside the focus when zoomed into a ward or department.
  const labelCodes = useMemo<ReadonlySet<string> | null>(() => {
    if (view.kind === "ward") return new Set([view.code]);
    if (view.kind === "dept") return new Set(departments.find((d) => d.departmentCode === view.code)?.wardCodes ?? []);
    return null;
  }, [view, departments]);

  if (webgl === null) return <div className="h-[420px]" />;
  if (!webgl) return <BedGrid2D wards={wards} />;

  const selected = view.kind === "ward" ? view.code : null;
  const activeCode = hovered ?? selected;
  const active = wards.find((w) => w.wardCode === activeCode) ?? null;

  const toggleAnim = () => {
    const next = !anim;
    setAnim(next);
    try {
      localStorage.setItem(ANIM_KEY, next ? "on" : "off");
    } catch {
      // ignore storage failures
    }
  };

  return (
    <div className="space-y-2">
      <div ref={box} className="relative h-[520px] overflow-hidden lg:h-[600px] rounded-md bg-brand-50">
        <Canvas
          frameloop={anim && visible ? "always" : "demand"}
          dpr={[1, 1.5]}
          camera={{ position: [0, 60, 50], fov: 45, far: 600 }}
        >
          <Scene
            layout={layout}
            activeCode={activeCode}
            anim={anim}
            goal={goal}
            idleOk={selected === null}
            labelCodes={labelCodes}
            onHover={setHovered}
            onSelect={(code) => setView((v) => ({ kind: "ward", code, n: v.n + 1 }))}
          />
        </Canvas>
        <div className="absolute left-3 top-3 max-w-xs rounded-md bg-white/90 p-2 shadow">
          <WardDetail ward={active} />
        </div>
        <div className="absolute right-3 top-3 flex flex-col items-end gap-2">
          {view.kind !== "overview" ? (
            <button
              type="button"
              className={buttonGhostClass}
              onClick={() => setView((v) => ({ kind: "overview", code: "", n: v.n + 1 }))}
            >
              ดูภาพรวม
            </button>
          ) : null}
          <button type="button" className={buttonGhostClass} aria-pressed={anim} onClick={toggleAnim}>
            ภาพเคลื่อนไหว {anim ? "เปิด" : "ปิด"}
          </button>
        </div>
      </div>
      <Legend />
    </div>
  );
}
