"use client";

import {
  useContext,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentRef,
  type RefObject,
} from "react";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Edges, Html, OrbitControls } from "@react-three/drei";
import { Color, DynamicDrawUsage, Euler, MathUtils, Matrix4, Object3D, Quaternion, Vector3 } from "three";
import type { BufferGeometry, Group, InstancedMesh, Mesh, PerspectiveCamera } from "three";
import type { BedOccupant, BedSlot, DepartmentOccupancy, WardOccupancy } from "@/lib/beds/types";
import { BedGrid2D } from "./BedGrid2D";
import { BedInfoPanel, type OccupantState, type PickedBed } from "./BedInfoPanel";
import { bedsInUse } from "./beds";
import { fmtNum, occupancyTone } from "./format";
import { buttonGhostClass } from "./ui";
import { WardDetail } from "./WardDetail";
import { NAV_CONTROL_PROPS, NavDriver, NavPad, useNavHold, useNavKeys } from "./scene3dNav";
import { ANIM_KEY, LabelPortal, clamp01, detectWebGL, goalPose, hash01, now, readAnimPref, type Goal } from "./scene3d";
import {
  DepthFog,
  QualityToggle,
  RoomEnv,
  SceneLights,
  canvasProps,
  edgeShadeTexture,
  readQuality,
  roundedBox,
  tileTexture,
  type Quality,
} from "./scene3dLook";

const ZONE_COLS = 3;
const ROOMS_PER_ZONE_ROW = 2;
const GAP = 3;
const ZONE_PAD = 1.5;
const ZONE_GAP = 7;
/** Strip at the front edge of every zone reserved for the department label. */
const LABEL_STRIP = 2.2;
const MAX_NURSES = 15;
/** Top of a bay floor; beds and nurses stand on it. */
const FLOOR_TOP = 0.22;
const BG_COLOR = "#effaf8";
/** Staff occupant list is reused for this long before a new tap refetches it. */
const OCCUPANT_TTL_MS = 60_000;

/*
 * Ward plan (Nightingale style): a ward is a corridor along x with the
 * nurse station in the middle and bays opening onto it on both sides. Each
 * bay (one per HOSxP room, large rooms split to <= MAX_BAY beds) has two
 * rows of single beds, headboards against the side walls, facing each other
 * across a central aisle that ends at the door to the corridor.
 */
const MAX_BAY = 10;
const BED_L = 1.24;
/** Bed centre to bed centre along a row: ~0.85 bed width free between neighbours. */
const PITCH = 1.25;
const WALL_T = 0.08;
const HEAD_GAP = 0.12;
const AISLE_W = 1.5;
/** Free floor from a bay end wall to the first/last bed centre (room for the bedside table). */
const END_PAD = 0.95;
const CORRIDOR = 2.0;
const WARD_MARGIN = 0.3;
const BAY_W2 = 2 * (WALL_T + HEAD_GAP + BED_L) + AISLE_W;
const BAY_W1 = WALL_T + HEAD_GAP + BED_L + 1.3 + WALL_T;

const COLOR_FREE = "#22c55e";
const COLOR_OCCUPIED = "#f59e0b";
const COLOR_FULL = "#dc2626";
const COLOR_OVER = "#7f1d1d";
const PULSE_OCCUPIED = new Color("#fde68a");
const PULSE_FULL = new Color("#ff8a80");
const WHITE = new Color("#ffffff");

const FLOOR_COLOR = {
  green: "#b4ecc6",
  amber: "#fbe08a",
  orange: "#fdcf9e",
  red: "#f9bcbc",
  slate: "#e2e8f0",
  brand: "#d5f2ed",
};
const CORRIDOR_COLOR = "#e4eaed";
/** Soft floor colour per department zone. */
const ZONE_COLORS = ["#a9dbd2", "#bcd3ee", "#e8d3ad", "#d4c5ec", "#bfe0b8", "#eec3cc"];

const IDLE_SECONDS = 8;
const INTRO_STAGGER = 0.12;

type BedKind = "free" | "occ" | "full" | "over";
/** A bed position in a bay: world x/z, yaw, and whether a neighbour sits on its local +x side. */
type BedSpot = { slot: number; x: number; z: number; rot: number; pair: boolean };
type Bay = {
  x0: number;
  z0: number;
  w: number;
  d: number;
  /** Above the corridor (door at its +z end) or below it (door at its -z end). */
  top: boolean;
  aisleX: number;
  beds: BedSpot[];
};
type RoomLayout = {
  ward: WardOccupancy;
  idx: number;
  cx: number;
  cz: number;
  w: number;
  d: number;
  /** Column of the room inside its zone (label stagger). */
  col: number;
  bays: Bay[];
  corridorZ: number;
};
type ZoneLayout = {
  code: string;
  name: string;
  idx: number;
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
  rot: number;
  color: string;
  kind: BedKind;
  pair: boolean;
  pick: PickedBed;
};
type SceneLayout = {
  rooms: RoomLayout[];
  zones: ZoneLayout[];
  width: number;
  depth: number;
};
type View = { kind: "overview" | "ward" | "dept"; code: string; n: number };
/** Mutable animation state shared by rooms, beds and the camera rig (never read during render). */
type Shared = { lift: Record<string, number>; rise: Record<string, number>; introAt: number };
const SHARED: Shared = { lift: {}, rise: {}, introAt: 0 };

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

/** Real HOSxP beds of a ward (empty when the data layer has none for it). */
const slotsOf = (w: WardOccupancy): BedSlot[] => (Array.isArray(w.bedSlots) ? w.bedSlots : []);

/** Beds drawn for a ward: the real bed list, else capacity (plus overflow). */
function bedCount(w: WardOccupancy): number {
  const slots = slotsOf(w);
  return slots.length > 0 ? slots.length : Math.max(w.beds, bedsInUse(w));
}

/** Split bed indices into bays: one per HOSxP room (first-seen order), large rooms into even chunks <= MAX_BAY. */
function bayGroups(ward: WardOccupancy): number[][] {
  const slots = slotsOf(ward);
  const n = bedCount(ward);
  const rooms = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const key = slots[i]?.roomName ?? "";
    const list = rooms.get(key);
    if (list) list.push(i);
    else rooms.set(key, [i]);
  }
  const out: number[][] = [];
  for (const list of rooms.values()) {
    const chunks = Math.ceil(list.length / MAX_BAY);
    const size = Math.ceil(list.length / chunks);
    for (let c = 0; c < chunks; c++) out.push(list.slice(c * size, (c + 1) * size));
  }
  return out;
}

/** Plan one ward relative to its centre: bays above/below a corridor, single beds in facing rows. */
function planWard(ward: WardOccupancy): { w: number; d: number; bays: Bay[]; corridorZ: number } {
  const groups = bayGroups(ward);
  if (groups.length === 0) return { w: 4, d: 3, bays: [], corridorZ: 0 };
  const sized = groups.map((beds) => {
    const rows = beds.length <= 2 ? 1 : 2;
    const perRow = rows === 2 ? Math.ceil(beds.length / 2) : beds.length;
    return { beds, rows, perRow, w: rows === 2 ? BAY_W2 : BAY_W1, d: 2 * END_PAD + (perRow - 1) * PITCH };
  });
  const nTop = Math.ceil(sized.length / 2);
  const topBays = sized.slice(0, nTop);
  const botBays = sized.slice(nTop);
  const sumW = (bs: typeof sized) => bs.reduce((a, b) => a + b.w, 0);
  const maxD = (bs: typeof sized) => bs.reduce((a, b) => Math.max(a, b.d), 0);
  const innerW = Math.max(sumW(topBays), sumW(botBays), 3);
  const topD = maxD(topBays);
  const botD = maxD(botBays);
  const w = innerW + 2 * WARD_MARGIN;
  const d = topD + CORRIDOR + botD + 2 * WARD_MARGIN;
  const corridorTop = -d / 2 + WARD_MARGIN + topD;
  const corridorBot = corridorTop + CORRIDOR;

  const bays: Bay[] = [];
  const place = (list: typeof sized, top: boolean) => {
    let x = -sumW(list) / 2;
    for (const b of list) {
      const z0 = top ? corridorTop - b.d : corridorBot;
      const x0 = x;
      x += b.w;
      const leftX = x0 + WALL_T + HEAD_GAP + BED_L / 2;
      const rightX = x0 + b.w - WALL_T - HEAD_GAP - BED_L / 2;
      const aisleX = b.rows === 2 ? x0 + b.w / 2 : x0 + WALL_T + HEAD_GAP + BED_L + (b.w - 2 * WALL_T - HEAD_GAP - BED_L) / 2;
      // Beds run away from the door: the first bed sits at the far end of the bay.
      const zAt = (j: number) => (top ? z0 + END_PAD + j * PITCH : z0 + b.d - END_PAD - j * PITCH);
      const left = b.beds.slice(0, b.perRow);
      const right = b.beds.slice(b.perRow);
      const spots: BedSpot[] = [];
      // Left row: head against the left wall (yaw +90°) so local +x is world -z; right row (yaw -90°): local +x is world +z.
      // `pair` = a neighbour on the bed's local +x side, where its table and curtain stand.
      left.forEach((slot, j) => {
        const pair = top ? j > 0 : j < left.length - 1;
        spots.push({ slot, x: leftX, z: zAt(j), rot: Math.PI / 2, pair });
      });
      right.forEach((slot, j) => {
        const pair = top ? j < right.length - 1 : j > 0;
        spots.push({ slot, x: rightX, z: zAt(j), rot: -Math.PI / 2, pair });
      });
      bays.push({ x0, z0, w: b.w, d: b.d, top, aisleX, beds: spots });
    }
  };
  place(topBays, true);
  place(botBays, false);
  return { w, d, bays, corridorZ: (corridorTop + corridorBot) / 2 };
}

/** Cluster wards into one floor zone per department; rooms are sized to their bays. */
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
    const rooms = g.wards.map((ward) => ({ ward, plan: planWard(ward) }));
    const rowCount = Math.ceil(rooms.length / ROOMS_PER_ZONE_ROW);
    const colCount = Math.min(rooms.length, ROOMS_PER_ZONE_ROW);
    const colW = Array.from({ length: colCount }, (_, c) =>
      Math.max(...rooms.filter((_, k) => k % ROOMS_PER_ZONE_ROW === c).map((r) => r.plan.w)),
    );
    const rowD = Array.from({ length: rowCount }, (_, r) =>
      Math.max(...rooms.slice(r * ROOMS_PER_ZONE_ROW, (r + 1) * ROOMS_PER_ZONE_ROW).map((x) => x.plan.d)),
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
    zones.push({ code: z.code, name: z.name, idx: i, cx: x0 + z.w / 2, cz: z0 + z.d / 2, w: z.w, d: z.d });
    z.rooms.forEach(({ ward, plan }, k) => {
      const col = k % ROOMS_PER_ZONE_ROW;
      const row = Math.floor(k / ROOMS_PER_ZONE_ROW);
      const cellX = x0 + ZONE_PAD + z.colW.slice(0, col).reduce((a, b) => a + b + GAP, 0);
      const cellZ = z0 + ZONE_PAD + z.rowD.slice(0, row).reduce((a, b) => a + b + GAP, 0);
      const cx = cellX + z.colW[col] / 2;
      const cz = cellZ + z.rowD[row] / 2;
      rooms.push({
        ward,
        idx: rooms.length,
        cx,
        cz,
        w: plan.w,
        d: plan.d,
        col,
        corridorZ: cz + plan.corridorZ,
        bays: plan.bays.map((b) => ({
          ...b,
          x0: b.x0 + cx,
          z0: b.z0 + cz,
          aisleX: b.aisleX + cx,
          beds: b.beds.map((s) => ({ ...s, x: s.x + cx, z: s.z + cz })),
        })),
      });
    });
  });
  return { rooms, zones, width, depth };
}

function layoutBeds(rooms: RoomLayout[]): BedItem[] {
  const items: BedItem[] = [];
  for (const room of rooms) {
    const { ward, idx } = room;
    const slots = slotsOf(ward);
    const used = bedsInUse(ward);
    const full = ward.occupancyPct >= 100;
    const spots = room.bays.flatMap((b) => b.beds).sort((a, b) => a.slot - b.slot);
    for (const s of spots) {
      const i = s.slot;
      const slot = slots[i] as BedSlot | undefined;
      const occupied = slot ? slot.occupied : i < used;
      const kind: BedKind = !slot && i >= ward.beds ? "over" : occupied ? (full ? "full" : "occ") : "free";
      const key = slot ? `${ward.wardCode}:b${slot.bedno}` : `${ward.wardCode}:${i}`;
      items.push({
        key,
        ward: ward.wardCode,
        wardIdx: idx,
        i,
        x: s.x,
        z: s.z,
        rot: s.rot,
        pair: s.pair,
        kind,
        color:
          kind === "over" ? COLOR_OVER : kind === "full" ? COLOR_FULL : kind === "occ" ? COLOR_OCCUPIED : COLOR_FREE,
        pick: {
          key,
          wardCode: ward.wardCode,
          bedno: slot ? slot.bedno : null,
          bedName: slot ? slot.bedName : String(i + 1),
          roomName: slot ? slot.roomName : null,
          occupied: kind !== "free",
        },
      });
    }
  }
  return items;
}

type BedState = { cur: Color; target: Color; birth: number; hop: number; occ: boolean; pat: number };

const meshProps = {
  frustumCulled: false,
  onUpdate: (m: InstancedMesh) => m.instanceMatrix.setUsage(DynamicDrawUsage),
};

const Q0 = new Quaternion();
const Y_AXIS = new Vector3(0, 1, 0);
const mat = (x: number, y: number, z: number, sx = 1, sy = 1, sz = 1) =>
  new Matrix4().compose(new Vector3(x, y, z), Q0, new Vector3(sx, sy, sz));

/** Static part transforms in bed space (origin on the floor under the bed centre, head towards -z). */
const PART = {
  legs: [-1, 1].flatMap((sx) => [-1, 1].map((sz) => mat(sx * 0.28, 0.13, sz * 0.54))),
  frame: mat(0, 0.29, 0),
  headboard: mat(0, 0.45, -0.62),
  footboard: mat(0, 0.4, 0.62),
  mattress: mat(0, 0.395, 0),
  pillow: mat(0, 0.51, -0.42),
  /** Bedside table in the gap on the bed's local +x side, at the head. */
  table: mat(PITCH / 2, 0.2, -0.45),
  /** Curtain panel (rail height) in the same gap, towards the foot. */
  curtain: mat(PITCH / 2, 0.55, 0.2),
};
const MATTRESS_TOP = 0.465;
const _p = new Vector3();
const _s = new Vector3();
const _q = new Quaternion();
const _part = new Matrix4();
/** Reusable (allocation-free) variant of mat() for per-frame parts. */
const dyn = (x: number, y: number, z: number, sx = 1, sy = 1, sz = 1) => _part.compose(_p.set(x, y, z), Q0, _s.set(sx, sy, sz));

function Beds({
  items,
  anim,
  selectedKey,
  onPick,
}: {
  items: BedItem[];
  anim: boolean;
  selectedKey: string | null;
  onPick: (it: BedItem) => void;
}) {
  const legs = useRef<InstancedMesh>(null);
  const frame = useRef<InstancedMesh>(null);
  const headboard = useRef<InstancedMesh>(null);
  const footboard = useRef<InstancedMesh>(null);
  const mattress = useRef<InstancedMesh>(null);
  const pillow = useRef<InstancedMesh>(null);
  const pHead = useRef<InstancedMesh>(null);
  const blanket = useRef<InstancedMesh>(null);
  const table = useRef<InstancedMesh>(null);
  const pole = useRef<InstancedMesh>(null);
  const bag = useRef<InstancedMesh>(null);
  const curtain = useRef<InstancedMesh>(null);
  const states = useRef(new Map<string, BedState>());
  const invalidate = useThree((s) => s.invalidate);
  const geo = useMemo(
    () => ({
      frame: roundedBox(0.68, 0.07, 1.24, 0.03),
      headboard: roundedBox(0.7, 0.5, 0.05, 0.024),
      footboard: roundedBox(0.7, 0.3, 0.05, 0.024),
      mattress: roundedBox(0.62, 0.14, 1.16, 0.05, 3),
      pillow: roundedBox(0.42, 0.09, 0.24, 0.04, 3),
      blanket: roundedBox(0.64, 0.1, 0.72, 0.045, 3),
      table: roundedBox(0.26, 0.4, 0.26, 0.03),
      bag: roundedBox(0.1, 0.16, 0.04, 0.02),
    }),
    [],
  );
  const curtains = useMemo(() => items.filter((it) => it.pair).length, [items]);
  const tmp = useMemo(() => ({ base: new Matrix4(), m: new Matrix4(), c: new Color(), bc: new Color(), mc: new Color() }), []);

  const apply = useCallback(
    (t: number, dt: number) => {
      const meshes = [legs, frame, headboard, footboard, mattress, pillow, pHead, blanket, table, pole, bag].map((r) => r.current);
      if (meshes.some((m) => !m)) return;
      const [lg, fr, hb, fb, ms, pl, ph, bl, tb, po, bg] = meshes as InstancedMesh[];
      const ct = curtain.current;
      const { base, m, c, bc, mc } = tmp;
      const k = 1 - Math.exp(-8 * dt);
      let cj = 0;
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
          st.pat += ((st.occ ? 1 : 0) - st.pat) * k;
          lift = SHARED.lift[it.ward] ?? 0;
        } else {
          st.cur.copy(st.target);
          st.pat = st.occ ? 1 : 0;
        }
        c.copy(st.cur);
        if (anim && (it.kind === "occ" || it.kind === "full")) {
          const full = it.kind === "full";
          const wave = 0.5 + 0.5 * Math.sin(t * (full ? 4 : 1.6) + it.wardIdx * 0.7 + it.i * 0.35);
          c.lerp(full ? PULSE_FULL : PULSE_OCCUPIED, (full ? 0.4 : 0.18) * wave);
        }
        if (it.key === selectedKey) c.lerp(WHITE, 0.3);
        base.compose(
          _p.set(it.x, FLOOR_TOP + lift + hop, it.z),
          _q.setFromAxisAngle(Y_AXIS, it.rot),
          _s.setScalar(Math.max(scale, 0.001)),
        );
        for (let l = 0; l < 4; l++) lg.setMatrixAt(i * 4 + l, m.multiplyMatrices(base, PART.legs[l]));
        fr.setMatrixAt(i, m.multiplyMatrices(base, PART.frame));
        hb.setMatrixAt(i, m.multiplyMatrices(base, PART.headboard));
        fb.setMatrixAt(i, m.multiplyMatrices(base, PART.footboard));
        ms.setMatrixAt(i, m.multiplyMatrices(base, PART.mattress));
        pl.setMatrixAt(i, m.multiplyMatrices(base, PART.pillow));
        tb.setMatrixAt(i, m.multiplyMatrices(base, PART.table));
        if (ct && it.pair) ct.setMatrixAt(cj++, m.multiplyMatrices(base, PART.curtain));
        // Sheet: a light tint of the status colour (stronger on a free bed, whose blanket is folded away).
        const hs = hash01(it.i + it.wardIdx * 131);
        mc.copy(c).lerp(WHITE, 0.55 - 0.4 * (1 - st.pat));
        ms.setColorAt(i, mc);
        bc.copy(c).multiplyScalar(0.92 + 0.08 * hs);
        bl.setColorAt(i, bc);
        // Patient (head on the pillow, breathing under the blanket) scales in/out with occupancy.
        const p = st.pat;
        const breathe = anim ? 1 + 0.1 * Math.sin(t * 1.8 + hs * 6.283) : 1;
        ph.setMatrixAt(i, m.multiplyMatrices(base, dyn(0, 0.57, -0.37, p, p, p)));
        const sy = MathUtils.lerp(0.7, 1.35 * breathe, p);
        const sz = MathUtils.lerp(0.38, 1, p);
        const bz = MathUtils.lerp(0.42, 0.17, p);
        bl.setMatrixAt(i, m.multiplyMatrices(base, dyn(0, MATTRESS_TOP + 0.05 * sy, bz, 1, sy, sz)));
        // IV pole + bag beside occupied beds only (local -x side, away from the table).
        po.setMatrixAt(i, m.multiplyMatrices(base, dyn(-0.46, 0.63 * p, -0.62, p, p, p)));
        bg.setMatrixAt(i, m.multiplyMatrices(base, dyn(-0.46, 1.16 * p, -0.62, p, p, p)));
      });
      const all = ct ? [...(meshes as InstancedMesh[]), ct] : (meshes as InstancedMesh[]);
      for (const mesh of all) {
        mesh.instanceMatrix.needsUpdate = true;
        mesh.boundingSphere = null;
      }
      if (ms.instanceColor) ms.instanceColor.needsUpdate = true;
      if (bl.instanceColor) bl.instanceColor.needsUpdate = true;
    },
    [items, anim, tmp, selectedKey],
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
      const occ = it.kind !== "free";
      const st = map.get(it.key);
      if (!st) {
        const birth = anim && first ? introTime(SHARED) + 0.5 + it.wardIdx * INTRO_STAGGER + it.i * 0.006 : t;
        map.set(it.key, { cur: next.clone(), target: next.clone(), birth, hop: -1, occ, pat: occ ? 1 : 0 });
      } else {
        if (st.occ !== occ) {
          st.occ = occ;
          if (anim) st.hop = t;
        }
        if (!next.equals(st.target)) {
          st.target.copy(next);
          if (anim) st.hop = t;
        }
      }
    }
    for (const key of map.keys()) if (!seen.has(key)) map.delete(key);
    apply(t, 0.016);
    invalidate();
  }, [items, anim, apply, invalidate]);

  useFrame((_, dt) => {
    if (anim) apply(now(), Math.min(dt, 0.1));
  });

  const n = items.length;
  if (n === 0) return null;
  const click = {
    onClick: (e: ThreeEvent<MouseEvent>) => {
      e.stopPropagation();
      const it = e.instanceId === undefined ? undefined : items[e.instanceId];
      if (it) onPick(it);
    },
    onPointerOver: () => {
      document.body.style.cursor = "pointer";
    },
  };
  return (
    <>
      <instancedMesh key={`lg${n}`} ref={legs} args={[undefined, undefined, n * 4]} {...meshProps}>
        <cylinderGeometry args={[0.022, 0.022, 0.26, 6]} />
        <meshStandardMaterial color="#64748b" metalness={0.6} roughness={0.35} />
      </instancedMesh>
      <instancedMesh key={`fr${n}`} ref={frame} args={[geo.frame, undefined, n]} castShadow {...meshProps} {...click}>
        <meshStandardMaterial color="#cfd8e0" metalness={0.55} roughness={0.32} />
      </instancedMesh>
      <instancedMesh key={`hb${n}`} ref={headboard} args={[geo.headboard, undefined, n]} castShadow {...meshProps} {...click}>
        <meshStandardMaterial color="#e8eef3" metalness={0.25} roughness={0.4} />
      </instancedMesh>
      <instancedMesh key={`fb${n}`} ref={footboard} args={[geo.footboard, undefined, n]} castShadow {...meshProps} {...click}>
        <meshStandardMaterial color="#e8eef3" metalness={0.25} roughness={0.4} />
      </instancedMesh>
      <instancedMesh key={`ms${n}`} ref={mattress} args={[geo.mattress, undefined, n]} castShadow receiveShadow {...meshProps} {...click}>
        <meshStandardMaterial roughness={0.85} />
      </instancedMesh>
      <instancedMesh key={`pl${n}`} ref={pillow} args={[geo.pillow, undefined, n]} castShadow {...meshProps}>
        <meshStandardMaterial color="#f8fafc" roughness={0.9} />
      </instancedMesh>
      <instancedMesh key={`ph${n}`} ref={pHead} args={[undefined, undefined, n]} castShadow {...meshProps}>
        <sphereGeometry args={[0.12, 16, 12]} />
        <meshStandardMaterial color="#c68a5e" roughness={0.7} />
      </instancedMesh>
      <instancedMesh key={`bl${n}`} ref={blanket} args={[geo.blanket, undefined, n]} castShadow receiveShadow {...meshProps} {...click}>
        <meshStandardMaterial roughness={0.8} />
      </instancedMesh>
      <instancedMesh key={`tb${n}`} ref={table} args={[geo.table, undefined, n]} castShadow {...meshProps}>
        <meshStandardMaterial color="#f1f5f9" roughness={0.6} />
      </instancedMesh>
      <instancedMesh key={`po${n}`} ref={pole} args={[undefined, undefined, n]} {...meshProps}>
        <cylinderGeometry args={[0.012, 0.012, 1.26, 6]} />
        <meshStandardMaterial color="#94a3b8" metalness={0.7} roughness={0.3} />
      </instancedMesh>
      <instancedMesh key={`bg${n}`} ref={bag} args={[geo.bag, undefined, n]} {...meshProps}>
        <meshStandardMaterial color="#cfeefa" transparent opacity={0.85} roughness={0.2} />
      </instancedMesh>
      {curtains > 0 ? (
        <instancedMesh key={`ct${curtains}`} ref={curtain} args={[undefined, undefined, curtains]} {...meshProps}>
          <boxGeometry args={[0.015, 0.75, 0.85]} />
          <meshStandardMaterial color="#9fd3e3" transparent opacity={0.6} roughness={0.9} depthWrite={false} />
        </instancedMesh>
      ) : null}
    </>
  );
}

/** Pulsing outline on the floor under the bed picked in the panel. */
function SelectionMarker({ item, anim }: { item: BedItem | null; anim: boolean }) {
  const ref = useRef<Mesh>(null);
  const invalidate = useThree((s) => s.invalidate);
  useLayoutEffect(() => {
    invalidate();
  }, [item, invalidate]);
  useFrame(() => {
    const m = ref.current;
    if (!m || !item) return;
    const pulse = anim ? 1 + 0.06 * Math.sin(now() * 5) : 1;
    m.position.set(item.x, FLOOR_TOP + 0.02 + (SHARED.lift[item.ward] ?? 0), item.z);
    m.scale.set(pulse, pulse * 1.75, 1);
  });
  if (!item) return null;
  return (
    <mesh ref={ref} rotation={[-Math.PI / 2, 0, item.rot]} position={[item.x, FLOOR_TOP + 0.02, item.z]} scale={[1, 1.75, 1]}>
      <ringGeometry args={[0.42, 0.5, 40]} />
      <meshBasicMaterial color="#0f766e" toneMapped={false} />
    </mesh>
  );
}

/* ---------- Ward fixtures: walls, doors, bay floors, nurse stations (instanced across the scene) ---------- */

type Fixture = { ward: string; x: number; y: number; z: number; sx: number; sy: number; sz: number; ry?: number; color?: string };
type FixtureKind = "wall" | "door" | "bayFloor" | "counter" | "monitor";

function wardFixtures(rooms: RoomLayout[]): Record<FixtureKind, Fixture[]> {
  const out: Record<FixtureKind, Fixture[]> = { wall: [], door: [], bayFloor: [], counter: [], monitor: [] };
  const wall = (ward: string, x: number, z: number, sx: number, sz: number, h: number) =>
    out.wall.push({ ward, x, y: FLOOR_TOP + h / 2, z, sx, sy: h, sz });
  for (const room of rooms) {
    const code = room.ward.wardCode;
    const tone = FLOOR_COLOR[occupancyTone(room.ward.occupancyPct)];
    for (const b of room.bays) {
      out.bayFloor.push({ ward: code, x: b.x0 + b.w / 2, y: 0.21, z: b.z0 + b.d / 2, sx: b.w - 0.02, sy: 0.02, sz: b.d - 0.02, color: tone });
      // Far walls taller, near (camera-side) walls low so the bay stays visible.
      const farZ = b.z0 + WALL_T / 2;
      const nearZ = b.z0 + b.d - WALL_T / 2;
      const doorZ = b.top ? nearZ : farZ;
      const endZ = b.top ? farZ : nearZ;
      const endH = b.top ? 0.9 : 0.3;
      const doorH = b.top ? 0.3 : 0.6;
      wall(code, b.x0 + b.w / 2, endZ, b.w, WALL_T, endH);
      wall(code, b.x0 + WALL_T / 2, b.z0 + b.d / 2, WALL_T, b.d, 0.6);
      wall(code, b.x0 + b.w - WALL_T / 2, b.z0 + b.d / 2, WALL_T, b.d, 0.6);
      // Door wall with a gap at the end of the aisle.
      const gap = 1.0;
      const gl = b.aisleX - gap / 2 - b.x0;
      const gr = b.x0 + b.w - (b.aisleX + gap / 2);
      if (gl > 0.01) wall(code, b.x0 + gl / 2, doorZ, gl, WALL_T, doorH);
      if (gr > 0.01) wall(code, b.x0 + b.w - gr / 2, doorZ, gr, WALL_T, doorH);
      // Door leaf swung open into the corridor, hinged at the left jamb.
      const hingeX = b.aisleX - gap / 2;
      const swing = b.top ? -1.1 : 1.1;
      const half = gap * 0.45;
      out.door.push({
        ward: code,
        x: hingeX + Math.cos(swing) * half,
        y: FLOOR_TOP + 0.33,
        z: doorZ - Math.sin(swing) * half,
        sx: gap * 0.9,
        sy: 0.66,
        sz: 0.04,
        ry: swing,
      });
    }
    if (room.bays.length > 0) {
      out.counter.push({ ward: code, x: room.cx, y: FLOOR_TOP + 0.25, z: room.corridorZ, sx: 1.8, sy: 0.5, sz: 0.5 });
      out.monitor.push({ ward: code, x: room.cx - 0.4, y: FLOOR_TOP + 0.66, z: room.corridorZ - 0.05, sx: 0.36, sy: 0.24, sz: 0.04 });
    }
  }
  return out;
}

const FIXTURE_LOOK: Record<FixtureKind, { color: string; roughness: number; metalness?: number; rounded?: boolean }> = {
  wall: { color: "#f8fafc", roughness: 0.85 },
  door: { color: "#c79f74", roughness: 0.6 },
  bayFloor: { color: "#ffffff", roughness: 0.75 },
  counter: { color: "#5eb3a8", roughness: 0.5, rounded: true },
  monitor: { color: "#1e293b", roughness: 0.3, metalness: 0.4 },
};

function FixtureMesh({ kind, list, anim }: { kind: FixtureKind; list: Fixture[]; anim: boolean }) {
  const ref = useRef<InstancedMesh>(null);
  const invalidate = useThree((s) => s.invalidate);
  const look = FIXTURE_LOOK[kind];
  const geom = useMemo<BufferGeometry | undefined>(() => (look.rounded ? roundedBox(1, 1, 1, 0.08) : undefined), [look.rounded]);
  const tmp = useMemo(() => ({ m: new Matrix4(), e: new Euler(), c: new Color() }), []);

  const apply = useCallback(
    (colors: boolean) => {
      const mesh = ref.current;
      if (!mesh) return;
      const { m, e, c } = tmp;
      list.forEach((f, i) => {
        const rise = SHARED.rise[f.ward] ?? (anim ? 0 : 1);
        const lift = SHARED.lift[f.ward] ?? 0;
        m.compose(
          _p.set(f.x, f.y * rise + lift, f.z),
          _q.setFromEuler(e.set(0, f.ry ?? 0, 0)),
          _s.set(f.sx, Math.max(f.sy * rise, 0.0001), f.sz),
        );
        mesh.setMatrixAt(i, m);
        if (colors && f.color) mesh.setColorAt(i, c.set(f.color));
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (colors && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    },
    [list, anim, tmp],
  );

  useLayoutEffect(() => {
    apply(true);
    invalidate();
  }, [apply, invalidate]);
  useFrame(() => {
    if (anim) apply(false);
  });

  const n = list.length;
  if (n === 0) return null;
  return (
    <instancedMesh key={`${kind}${n}`} ref={ref} args={[geom, undefined, n]} castShadow={kind !== "bayFloor"} receiveShadow {...meshProps}>
      {geom ? null : <boxGeometry />}
      <meshStandardMaterial
        color={look.color}
        roughness={look.roughness}
        metalness={look.metalness ?? 0}
        map={kind === "bayFloor" ? edgeShadeTexture() : null}
      />
    </instancedMesh>
  );
}

function WardFixtures({ rooms, anim }: { rooms: RoomLayout[]; anim: boolean }) {
  const fx = useMemo(() => wardFixtures(rooms), [rooms]);
  return (
    <>
      {(Object.keys(fx) as FixtureKind[]).map((k) => (
        <FixtureMesh key={k} kind={k} list={fx[k]} anim={anim} />
      ))}
    </>
  );
}

/* ---------- Nurses: walk the aisle of a bay to an occupied bed; one at each nurse station ---------- */

type NurseSpec = { key: string; room: RoomLayout; n: number; bay: Bay | null; occ: BedSpot[] };
type NurseState = {
  x: number;
  z: number;
  heading: number;
  target: { x: number; z: number } | null;
  face: { x: number; z: number };
  until: number;
  rng: () => number;
};

function seeded(key: string): () => number {
  let a = 2166136261;
  for (let i = 0; i < key.length; i++) a = Math.imul(a ^ key.charCodeAt(i), 16777619);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bed i of a ward is occupied (real flag, else one of the first bedsInUse beds). */
function isOccupied(ward: WardOccupancy, i: number): boolean {
  const slots = slotsOf(ward);
  return slots.length > 0 ? Boolean(slots[i]?.occupied) : i < bedsInUse(ward);
}

function nurseSpecs(rooms: RoomLayout[]): NurseSpec[] {
  const per = rooms.map((room) => {
    const bays = room.bays
      .map((bay) => ({ bay, occ: bay.beds.filter((s) => isOccupied(room.ward, s.slot)) }))
      .filter((b) => b.occ.length > 0)
      .sort((a, b) => b.occ.length - a.occ.length);
    const used = bays.reduce((a, b) => a + b.occ.length, 0);
    return { room, bays, count: used === 0 ? 0 : Math.min(3, Math.max(1, Math.ceil(used / 10)), bays.length) };
  });
  let total = per.reduce((a, b) => a + b.count, 0);
  while (total > MAX_NURSES) {
    const big = per.reduce((a, b) => (b.count > a.count ? b : a));
    big.count -= 1;
    total -= 1;
  }
  const out: NurseSpec[] = [];
  for (const { room, bays, count } of per) {
    if (room.bays.length > 0) out.push({ key: `${room.ward.wardCode}:st`, room, n: 0, bay: null, occ: [] });
    for (let n = 0; n < count; n++) {
      const b = bays[n % bays.length];
      out.push({ key: `${room.ward.wardCode}:n${n}`, room, n: n + 1, bay: b.bay, occ: b.occ });
    }
  }
  return out;
}

/** Where a nurse stands to tend a bed: in the aisle, just off the foot end. */
function standAt(bay: Bay, s: BedSpot) {
  const toward = Math.sign(s.x - bay.aisleX) || -1;
  return { x: bay.aisleX + toward * 0.3, z: s.z };
}

function dampAngle(cur: number, target: number, lambda: number, dt: number): number {
  const diff = ((((target - cur + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
  return cur + diff * (1 - Math.exp(-lambda * dt));
}

function Nurses({ rooms, anim }: { rooms: RoomLayout[]; anim: boolean }) {
  const specs = useMemo(() => nurseSpecs(rooms), [rooms]);
  const body = useRef<InstancedMesh>(null);
  const head = useRef<InstancedMesh>(null);
  const cap = useRef<InstancedMesh>(null);
  const states = useRef(new Map<string, NurseState>());
  const invalidate = useThree((s) => s.invalidate);
  const capGeo = useMemo(() => roundedBox(0.2, 0.06, 0.18, 0.025), []);
  const parts = useMemo(() => {
    const g = new Object3D();
    const b = new Object3D();
    const h = new Object3D();
    const c = new Object3D();
    b.position.set(0, 0.33, 0);
    h.position.set(0, 0.72, 0);
    c.position.set(0, 0.83, -0.01);
    g.add(b, h, c);
    return { g, b, h, c };
  }, []);

  const update = useCallback(
    (t: number, dt: number, advance: boolean) => {
      const bm = body.current;
      const hm = head.current;
      const cm = cap.current;
      if (!bm || !hm || !cm) return;
      const { g, b, h, c } = parts;
      specs.forEach((sp, i) => {
        const ns = states.current.get(sp.key);
        if (!ns) return;
        let walking = false;
        if (advance && sp.bay) {
          if (ns.target) {
            const dx = ns.target.x - ns.x;
            const dz = ns.target.z - ns.z;
            const dist = Math.hypot(dx, dz);
            const step = 1.1 * dt;
            if (dist <= step) {
              ns.x = ns.target.x;
              ns.z = ns.target.z;
              ns.target = null;
              ns.until = t + 2 + ns.rng() * 2;
            } else {
              ns.x += (dx / dist) * step;
              ns.z += (dz / dist) * step;
              ns.heading = dampAngle(ns.heading, Math.atan2(dx, dz), 10, dt);
              walking = true;
            }
          } else if (t > ns.until && sp.occ.length > 0) {
            const bed = sp.occ[Math.floor(ns.rng() * sp.occ.length)];
            ns.target = standAt(sp.bay, bed);
            ns.face = { x: bed.x, z: bed.z };
          }
          if (!ns.target) ns.heading = dampAngle(ns.heading, Math.atan2(ns.face.x - ns.x, ns.face.z - ns.z), 8, dt);
        }
        const room = sp.room;
        const appear = anim ? easeOutBack(clamp01((t - introTime(SHARED) - 1.6 - room.idx * INTRO_STAGGER) / 0.5)) : 1;
        const phase = sp.n * 1.7 + room.idx;
        const lean = anim && !walking ? 0.22 * (0.5 + 0.5 * Math.sin(t * 2.5 + phase)) : 0;
        const bob = walking ? Math.abs(Math.sin(t * 9 + phase)) * 0.05 : 0;
        g.position.set(ns.x, FLOOR_TOP + (SHARED.lift[room.ward.wardCode] ?? 0) + bob, ns.z);
        g.rotation.set(lean, ns.heading, 0, "YXZ");
        g.scale.setScalar(Math.max(appear, 0.001));
        g.updateMatrixWorld(true);
        bm.setMatrixAt(i, b.matrixWorld);
        hm.setMatrixAt(i, h.matrixWorld);
        cm.setMatrixAt(i, c.matrixWorld);
      });
      bm.instanceMatrix.needsUpdate = true;
      hm.instanceMatrix.needsUpdate = true;
      cm.instanceMatrix.needsUpdate = true;
    },
    [specs, anim, parts],
  );

  useLayoutEffect(() => {
    const map = states.current;
    const seen = new Set<string>();
    const t = now();
    for (const sp of specs) {
      seen.add(sp.key);
      if (map.has(sp.key)) continue;
      const rng = seeded(sp.key);
      if (!sp.bay) {
        // Nurse station: behind the counter, facing the camera side of the corridor.
        const x = sp.room.cx + 0.3;
        const z = sp.room.corridorZ - 0.55;
        map.set(sp.key, { x, z, heading: 0, target: null, face: { x, z: z + 1 }, until: Infinity, rng });
        continue;
      }
      // Start beside a (seeded) occupied bed, so the static pose is already sensible.
      const bed = sp.occ[Math.floor(rng() * sp.occ.length)];
      const at = standAt(sp.bay, bed);
      map.set(sp.key, {
        x: at.x,
        z: at.z,
        heading: Math.atan2(bed.x - at.x, 0),
        target: null,
        face: { x: bed.x, z: bed.z },
        until: t + rng() * 3,
        rng,
      });
    }
    for (const key of map.keys()) if (!seen.has(key)) map.delete(key);
    update(t, 0.016, false);
    invalidate();
  }, [specs, update, invalidate]);

  useFrame((_, dt) => {
    if (anim) update(now(), Math.min(dt, 0.1), true);
  });

  const n = specs.length;
  if (n === 0) return null;
  return (
    <>
      <instancedMesh key={`nb${n}`} ref={body} args={[undefined, undefined, n]} castShadow {...meshProps}>
        <capsuleGeometry args={[0.14, 0.34, 4, 12]} />
        <meshStandardMaterial color="#0f766e" roughness={0.7} />
      </instancedMesh>
      <instancedMesh key={`nh${n}`} ref={head} args={[undefined, undefined, n]} castShadow {...meshProps}>
        <sphereGeometry args={[0.115, 16, 12]} />
        <meshStandardMaterial color="#d9a679" roughness={0.7} />
      </instancedMesh>
      <instancedMesh key={`nc${n}`} ref={cap} args={[capGeo, undefined, n]} {...meshProps}>
        <meshStandardMaterial color="#ffffff" roughness={0.6} />
      </instancedMesh>
    </>
  );
}

function Zone({ zone }: { zone: ZoneLayout }) {
  const portal = useContext(LabelPortal) ?? undefined;
  return (
    <group position={[zone.cx, 0, zone.cz]}>
      <mesh position={[0, 0.02, 0]} receiveShadow>
        <boxGeometry args={[zone.w, 0.1, zone.d]} />
        <meshStandardMaterial color={ZONE_COLORS[zone.idx % ZONE_COLORS.length]} map={edgeShadeTexture()} roughness={0.95} />
      </mesh>
      {/* Department pill: screen-aligned, at the zone front edge at floor level; never rotates. */}
      <Html portal={portal} position={[0, 0.2, zone.d / 2 - 0.8]} center zIndexRange={[5, 0]} pointerEvents="none">
        <div className="translate-y-1 whitespace-nowrap rounded-md bg-brand-700 px-3 py-0.5 text-xs font-semibold text-white shadow">
          แผนก{zone.name}
        </div>
      </Html>
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
  const over = bedsInUse(ward) > ward.beds;
  const portal = useContext(LabelPortal) ?? undefined;

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
    SHARED.rise[ward.wardCode] = rise;
    g.scale.y = Math.max(rise, 0.001);
    g.position.y = lift;
  });

  return (
    <group position={[cx, 0, cz]}>
      <group
        ref={inner}
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
        {over ? (
          <mesh position={[0, 0.08, 0]}>
            <boxGeometry args={[w + 0.6, 0.1, d + 0.6]} />
            <meshStandardMaterial color="#dc2626" emissive="#dc2626" emissiveIntensity={0.6} />
          </mesh>
        ) : null}
        {/* Ward slab = corridor floor; the bays on top carry the occupancy colour. */}
        <mesh position={[0, 0.1, 0]} receiveShadow>
          <boxGeometry args={[w, 0.2, d]} />
          <meshStandardMaterial
            color={CORRIDOR_COLOR}
            map={edgeShadeTexture()}
            roughness={0.6}
            emissive={active ? "#ffffff" : "#000000"}
            emissiveIntensity={active ? 0.25 : 0}
          />
          {active ? <Edges color="#0f766e" /> : null}
        </mesh>
        {showLabel ? (
          <Html
            portal={portal}
            position={[0, 1.4 + (room.col % 2) * 1.5, -d / 2 + 0.6]}
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

  return <OrbitControls ref={controls} makeDefault {...NAV_CONTROL_PROPS} maxPolarAngle={Math.PI / 2.3} minDistance={6} maxDistance={220} />;
}

/** Tiled hospital floor under the whole scene. */
function Ground({ w, d }: { w: number; d: number }) {
  const tex = useMemo(() => tileTexture("#cfd8dd", "#b3bfc6", w / 2.4, d / 2.4), [w, d]);
  useEffect(() => () => tex.dispose(), [tex]);
  return (
    <mesh position={[0, -0.1, 0]} receiveShadow>
      <boxGeometry args={[w, 0.2, d]} />
      <meshStandardMaterial map={tex} roughness={0.55} metalness={0.05} />
    </mesh>
  );
}

function Scene({
  layout,
  items,
  activeCode,
  anim,
  goal,
  idleOk,
  labelCodes,
  quality,
  selected,
  onHover,
  onSelect,
  onPickBed,
}: {
  layout: SceneLayout;
  items: BedItem[];
  activeCode: string | null;
  anim: boolean;
  labelCodes: ReadonlySet<string> | null;
  goal: Goal;
  idleOk: boolean;
  quality: Quality;
  selected: BedItem | null;
  onHover: (code: string | null) => void;
  onSelect: (code: string) => void;
  onPickBed: (it: BedItem) => void;
}) {
  useEffect(
    () => () => {
      SHARED.lift = {};
      SHARED.rise = {};
      SHARED.introAt = 0;
    },
    [],
  );
  const high = quality === "high";
  return (
    <>
      <SceneLights quality={quality} w={layout.width + 6} d={layout.depth + 6} />
      {high ? <RoomEnv intensity={0.35} /> : null}
      {high ? <DepthFog color={BG_COLOR} /> : null}
      <Ground w={layout.width + 6} d={layout.depth + 6} />
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
      <WardFixtures rooms={layout.rooms} anim={anim} />
      <Beds items={items} anim={anim} selectedKey={selected?.key ?? null} onPick={onPickBed} />
      <SelectionMarker item={selected} anim={anim} />
      <Nurses rooms={layout.rooms} anim={anim} />
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
      <span className="inline-flex items-center gap-1">
        <span className={`${dot} rounded-full bg-[#c68a5e]`} /> ผู้ป่วย
      </span>
      <span className="inline-flex items-center gap-1">
        <span className={`${dot} rounded-full bg-teal-700`} /> พยาบาล
      </span>
      <span className="text-slate-500">คลิกที่ห้องเพื่อดูหอผู้ป่วย แตะที่เตียงเพื่อดูรายละเอียดเตียง</span>
    </div>
  );
}

function fitGoal(key: string, cx: number, cz: number, w: number, d: number, margin: number): Goal {
  return { key, cx, cz, w, d, margin };
}

type Auth = "unknown" | "staff" | "guest" | "forbidden";
/** Occupants of one ward for the staff panel. Tied to the board data it was fetched for. */
type OccupantCache = { wards: WardOccupancy[]; ward: string; at: number; list: BedOccupant[] };

async function loadRole(): Promise<Auth> {
  try {
    const r = await fetch("/api/session", { cache: "no-store" });
    if (!r.ok) return "guest";
    const j = (await r.json()) as { user?: { role?: string } | null };
    if (!j.user) return "guest";
    // admin and staff may see HN; partner (outsiders) never.
    return j.user.role === "staff" || j.user.role === "admin" ? "staff" : "forbidden";
  } catch {
    return "guest";
  }
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
  const [quality, setQuality] = useState<Quality>(readQuality);
  const [visible, setVisible] = useState(true);
  const [pickedKey, setPickedKey] = useState<string | null>(null);
  const [auth, setAuth] = useState<Auth>("unknown");
  const [occ, setOcc] = useState<OccupantCache | null>(null);
  const [occLoad, setOccLoad] = useState<"idle" | "loading" | "error">("idle");
  const reqWard = useRef<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const layout = useMemo(() => layoutScene(wards, departments), [wards, departments]);
  const items = useMemo(() => layoutBeds(layout.rooms), [layout.rooms]);
  // A refreshed board can drop or move the picked bed: look it up by key every render.
  const picked = useMemo(() => items.find((it) => it.key === pickedKey) ?? null, [items, pickedKey]);
  // Stable canvas config: a new gl/shadows object on every render makes R3F reconfigure the renderer.
  const glProps = useMemo(() => canvasProps(quality), [quality]);

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

  // Bed panel: close on Esc or a click anywhere outside the 3D box (clicks inside are handled by the scene).
  useEffect(() => {
    if (!pickedKey) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPickedKey(null);
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && box.current && !box.current.contains(t)) setPickedKey(null);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [pickedKey]);

  const nav = useNavHold();
  useNavKeys(box, nav);

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
    return fitGoal(key, 0, layout.depth * 0.04, layout.width, layout.depth, 2.5);
  }, [view, layout]);

  // Hide ward labels outside the focus when zoomed into a ward or department.
  const labelCodes = useMemo<ReadonlySet<string> | null>(() => {
    if (view.kind === "ward") return new Set([view.code]);
    if (view.kind === "dept") return new Set(departments.find((d) => d.departmentCode === view.code)?.wardCodes ?? []);
    return null;
  }, [view, departments]);

  if (webgl === null) return <div className="h-[420px]" />;
  if (!webgl) return <BedGrid2D wards={wards} />;

  const selectedWard = view.kind === "ward" ? view.code : null;
  const activeCode = hovered ?? selectedWard;
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

  /** Bed tapped: open the panel; for an occupied real bed and a staff session, fetch the ward's occupants (cached). */
  const pickBed = async (it: BedItem) => {
    setPickedKey(it.key);
    if (!it.pick.occupied || it.pick.bedno === null) return;
    let role = auth;
    if (role === "unknown") {
      role = await loadRole();
      setAuth(role);
    }
    if (role !== "staff") return;
    if (occ && occ.wards === wards && occ.ward === it.ward && Date.now() - occ.at < OCCUPANT_TTL_MS) return;
    reqWard.current = it.ward;
    setOccLoad("loading");
    try {
      const r = await fetch(`/api/beds/occupants?ward=${encodeURIComponent(it.ward)}`, { cache: "no-store" });
      if (reqWard.current !== it.ward) return;
      if (r.status === 401) {
        setAuth("guest");
        setOccLoad("idle");
        return;
      }
      if (r.status === 403) {
        setAuth("forbidden");
        setOccLoad("idle");
        return;
      }
      if (!r.ok) {
        setOccLoad("error");
        return;
      }
      // API body: { wardCode, asOf, occupants: BedOccupant[] } (older builds: a bare array).
      const body = (await r.json()) as { occupants?: BedOccupant[] } | BedOccupant[];
      const list = Array.isArray(body) ? body : Array.isArray(body?.occupants) ? body.occupants : [];
      if (reqWard.current !== it.ward) return;
      setOcc({ wards, ward: it.ward, at: Date.now(), list });
      setOccLoad("idle");
    } catch {
      if (reqWard.current === it.ward) setOccLoad("error");
    }
  };

  let occupant: OccupantState = { kind: "none" };
  if (picked?.pick.occupied) {
    if (auth === "guest") occupant = { kind: "guest" };
    else if (auth === "forbidden") occupant = { kind: "forbidden" };
    else if (occ && occ.wards === wards && occ.ward === picked.ward)
      occupant = { kind: "ready", occupant: occ.list.find((o) => o.bedno === picked.pick.bedno) ?? null };
    else if (occLoad === "error") occupant = { kind: "error" };
    else occupant = { kind: "loading" };
  }

  return (
    <div className="space-y-2">
      <div
        ref={box}
        tabIndex={0}
        aria-label="ภาพ 3 มิติ หอผู้ป่วย ใช้ลูกศรเพื่อเลื่อน"
        className="relative h-[520px] overflow-hidden rounded-md bg-brand-50 outline-none focus-visible:ring-2 focus-visible:ring-brand-400 lg:h-[600px]"
      >
        <Canvas
          key={quality}
          {...glProps}
          frameloop={anim && visible ? "always" : "demand"}
          camera={{ position: [0, 60, 50], fov: 45, far: 600 }}
          onPointerMissed={() => setPickedKey(null)}
        >
          <LabelPortal.Provider value={box as RefObject<HTMLElement>}>
            <Scene
              layout={layout}
              items={items}
              activeCode={activeCode}
              anim={anim}
              goal={goal}
              idleOk={selectedWard === null}
              labelCodes={labelCodes}
              quality={quality}
              selected={picked}
              onHover={setHovered}
              onSelect={(code) => {
                setPickedKey(null);
                setView((v) => ({ kind: "ward", code, n: v.n + 1 }));
              }}
              onPickBed={(it) => void pickBed(it)}
            />
          </LabelPortal.Provider>
          <NavDriver nav={nav} w={layout.width} d={layout.depth} />
        </Canvas>
        <div className="absolute bottom-3 right-3 z-30">
          <NavPad
            nav={nav}
            onReset={() => {
              setPickedKey(null);
              setView((v) => ({ kind: "overview", code: "", n: v.n + 1 }));
            }}
          />
        </div>
        {picked ? (
          <div className="absolute bottom-3 left-3 z-30">
            <BedInfoPanel
              bed={picked.pick}
              ward={wards.find((w) => w.wardCode === picked.ward) ?? null}
              occupant={occupant}
              onClose={() => setPickedKey(null)}
            />
          </div>
        ) : active ? (
          <div className="absolute bottom-3 left-3 max-w-xs rounded-md bg-white/90 p-2 shadow">
            <WardDetail ward={active} />
          </div>
        ) : null}
        <div className="absolute right-3 top-3 z-30 flex flex-col items-end gap-2">
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
          <QualityToggle quality={quality} onChange={setQuality} />
        </div>
      </div>
      <Legend />
    </div>
  );
}
