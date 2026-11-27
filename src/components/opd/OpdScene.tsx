"use client";

import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentRef, type ReactNode, type RefObject } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Html, OrbitControls } from "@react-three/drei";
import { Color, DynamicDrawUsage, Object3D } from "three";
import type { Group, InstancedMesh, PerspectiveCamera } from "three";
import { FLOW_COLOR, FLOW_DEFS } from "@/lib/opd/flow";
import type { ClinicWait, OpdFlow, OpdFlowKey } from "@/lib/opd/types";
import { fmtNum, waitTone, type Tone } from "../format";
import { NAV_CONTROL_PROPS, NavDriver, NavPad, useNavHold, useNavKeys } from "../scene3dNav";
import { LabelPortal, detectWebGL, goalPose, hash01, now, readAnimPref, writeAnimPref, type Goal } from "../scene3d";
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
} from "../scene3dLook";
import { buttonGhostClass, toneBadge } from "../ui";
import { OpdGrid2D } from "./OpdGrid2D";

/*
 * OPD hall organised by the WAITING POINTS of today's visit flow (OpdFlow):
 *
 *   back wing   one exam room per clinic (all clinics, also those with 0
 *               waiting), patients waiting for the doctor seated on the
 *               benches in front of each room  -> bucket "doctor"
 *   corridor    banner of the doctor queue, Admit sign, "other" sign
 *   front wing  screening, seen-doctor-next-step, Lab / X-ray (large),
 *               other services, pharmacy / cashier, exit door (home), ER
 *
 * Every waiting point draws min(count, seats) seated figures in its bucket
 * colour and labels the full count; the exam rooms together draw the doctor
 * bucket (clinic waitingForDoctor, the remainder of hidden clinics in an
 * extra "คลินิกอื่น" room). Aggregates only.
 */

/** Seat pitch along a bench and between bench rows. */
const SX = 0.7;
const SZ = 1.0;
/** Seats per bench module (instanced unit). */
const MOD = 3;
const SEAT_H = 0.42;
/** Front wing: depth from the zone back wall to the first bench row, and bench rows. */
const DESK_AREA = 2.7;
const ZONE_ROWS = 5;
const ZONE_D = DESK_AREA + ZONE_ROWS * SZ + 0.6;
const ZONE_GAP = 0.6;
/** Back wing: exam room + two queue benches (6 seats each) in front of it. */
const ROOM_D = 3.3;
const ROOM_COLS = 6;
const ROOM_ROWS = 2;
const CELL_D = ROOM_D + 1.0 + ROOM_ROWS * SZ + 0.3;
const MIN_CELL_W = 8.6;
const BACK_STRIP = 1.4;
const CORRIDOR = 3.6;
const FRONT_STRIP = 3.6;
const BG_COLOR = "#effaf8";

const TONE_FLOOR: Record<Tone, string> = {
  green: "#c8f0d4",
  amber: "#fbe7a6",
  orange: "#fdd9b5",
  red: "#fbcaca",
  slate: "#e8edf2",
  brand: "#d5f2ed",
};

type ZoneSpec = { key: OpdFlowKey; name: string; cols: number; rows: number; side: number };
/** Front wing, left to right: ER at the left edge, then the patient path; the exit door follows pharmacy. side = extra width for rooms/props beside the benches. */
const ZONE_SPECS: ZoneSpec[] = [
  { key: "er", name: "ห้องฉุกเฉิน (ER)", cols: 3, rows: 4, side: 2.6 },
  { key: "screening", name: "จุดซักประวัติ/คัดกรอง", cols: 6, rows: 4, side: 0.6 },
  { key: "after_doctor", name: "พบแพทย์แล้ว รอขั้นตอนต่อ", cols: 6, rows: 4, side: 0.6 },
  { key: "lab", name: "ห้อง Lab / X-ray", cols: 12, rows: 5, side: 3.8 },
  { key: "services", name: "ทันตกรรม / ตา / กายภาพ / อื่นๆ", cols: 6, rows: 5, side: 0.8 },
  { key: "pharmacy", name: "ห้องยา / การเงิน", cols: 9, rows: 5, side: 0.6 },
];

type Fig = { x: number; z: number; color: string; seed: number };
type Zone = {
  key: OpdFlowKey;
  name: string;
  count: number;
  shown: number;
  color: string;
  x: number;
  z: number;
  w: number;
  benchX: number;
  /** Every other zone drops its label a little so neighbouring pills never overlap. */
  stagger: boolean;
};
type Room = {
  code: string;
  name: string;
  count: number;
  shown: number;
  tone: Tone;
  est: number | null;
  doctors: number;
  active: boolean;
  x: number;
  z: number;
  w: number;
};
type Sign = { x: number; z: number; count: number };
type Layout = {
  W: number;
  D: number;
  zones: Zone[];
  rooms: Room[];
  figs: Fig[];
  benches: [number, number][];
  corridorZ: number;
  doctorCount: number;
  exit: Sign | null;
  admit: Sign | null;
  other: Sign | null;
  total: number | null;
  present: number;
};

/** Display name for the 3D pill: HOSxP names carry notes in brackets, e.g. "(รอพบแพทย์ ห้ามนัด)". */
function shortName(name: string): string {
  const s = name.replace(/\s*[(（][^)）]*[)）]/g, "").trim();
  return s || name;
}

const isActive = (c: ClinicWait) => c.waitingNow > 0 || c.seenToday > 0;

/**
 * Seat grid (cols x rows, centred on cx, first row at z0) plus its bench
 * modules; fills n seats, mostly the front rows with natural gaps.
 * Returns how many figures were placed.
 */
function seatBlock(cx: number, z0: number, cols: number, rows: number, n: number, color: string, seed: number, out: Layout): number {
  const seats: { x: number; z: number; p: number }[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      seats.push({ x: cx + (c - (cols - 1) / 2) * SX, z: z0 + r * SZ, p: r + hash01(seed + r * 31 + c * 7) * 1.7 });
    }
    for (let m = 0; m < cols / MOD; m++) out.benches.push([cx + (m * MOD + (MOD - 1) / 2 - (cols - 1) / 2) * SX, z0 + r * SZ]);
  }
  seats.sort((a, b) => a.p - b.p);
  const shown = Math.min(Math.max(n, 0), seats.length);
  for (let i = 0; i < shown; i++) out.figs.push({ x: seats[i].x, z: seats[i].z, color, seed: seed + i });
  return shown;
}

function layoutOpd(flow: OpdFlow | null, clinics: ClinicWait[]): Layout {
  const count = (k: OpdFlowKey) => flow?.buckets.find((b) => b.key === k)?.count ?? 0;
  // Without the flow (no sync with db/008 yet) only the clinic queue is known.
  const sum = (f: (c: ClinicWait) => number) => clinics.reduce((n, c) => n + f(c), 0);
  const screening = flow ? count("screening") : sum((c) => c.waitingNow - c.waitingForDoctor);
  const specs = flow ? ZONE_SPECS : ZONE_SPECS.filter((s) => s.key === "screening");

  // Front wing widths.
  const zoneW = (s: ZoneSpec) => s.cols * SX + 1.4 + s.side;
  const frontW = specs.reduce((n, s) => n + zoneW(s), 0) + ZONE_GAP * (specs.length - 1);

  // Back wing: every clinic (active first, HOSxP order kept), plus the doctor
  // queue of clinics not on the board so the rooms add up to the bucket.
  type RoomIn = Omit<Room, "x" | "z" | "w" | "shown">;
  const list: RoomIn[] = [...clinics.filter(isActive), ...clinics.filter((c) => !isActive(c))].map((c) => ({
    code: c.clinicCode,
    name: shortName(c.clinicName),
    count: c.waitingForDoctor,
    tone: waitTone(c.estimatedDoctorWaitMinutes ?? c.screenToDoctor.medianMinutes ?? c.longestScreenWaitMinutes ?? 0),
    est: c.estimatedDoctorWaitMinutes,
    doctors: c.doctorsActive,
    active: isActive(c),
  }));
  const doctorCount = flow ? count("doctor") : sum((c) => c.waitingForDoctor);
  const rest = doctorCount - sum((c) => c.waitingForDoctor);
  if (rest > 0) list.push({ code: "_rest", name: "คลินิกอื่น", count: rest, tone: "slate", est: null, doctors: 0, active: true });
  const n = Math.max(list.length, 1);
  // About 5 rooms per row keeps the hall close to the canvas aspect (wide but not a strip).
  const cols = Math.min(n, Math.max(4, Math.min(8, Math.ceil(Math.sqrt(n * 1.4)))));
  const roomRows = Math.ceil(n / cols);
  const cellW = Math.max(MIN_CELL_W, frontW / cols);
  const backW = cols * cellW;
  const W = Math.max(frontW, backW);
  const D = BACK_STRIP + roomRows * CELL_D + CORRIDOR + ZONE_D + FRONT_STRIP;
  const z0 = -D / 2;

  const out: Layout = {
    W,
    D,
    zones: [],
    rooms: [],
    figs: [],
    benches: [],
    corridorZ: z0 + BACK_STRIP + roomRows * CELL_D + CORRIDOR / 2,
    doctorCount,
    exit: null,
    admit: null,
    other: null,
    total: flow?.total ?? null,
    present: 0,
  };

  const doctorHex = FLOW_COLOR.doctor.hex;
  list.forEach((r, i) => {
    const row = Math.floor(i / cols);
    // Centre a short last row.
    const inRow = row === roomRows - 1 ? list.length - row * cols : cols;
    const x = ((i % cols) - (inRow - 1) / 2) * cellW;
    const z = z0 + BACK_STRIP + row * CELL_D;
    const shown = seatBlock(x, z + ROOM_D + 1.0, ROOM_COLS, ROOM_ROWS, r.count, doctorHex, i * 101 + 7, out);
    out.rooms.push({ ...r, x, z, w: cellW, shown });
  });

  const zTop = z0 + BACK_STRIP + roomRows * CELL_D + CORRIDOR;
  let x = -frontW / 2;
  specs.forEach((s, i) => {
    const w = zoneW(s);
    const cx = x + w / 2;
    // Props (X-ray room, ER beds) sit on the right of the benches.
    const benchX = s.side < 1 ? cx : cx - s.side / 2;
    const c = s.key === "screening" ? screening : count(s.key);
    const shown = seatBlock(benchX, zTop + DESK_AREA, s.cols, s.rows, c, FLOW_COLOR[s.key].hex, i * 977 + 13, out);
    out.zones.push({ key: s.key, name: s.name, count: c, shown, color: FLOW_COLOR[s.key].hex, x: cx, z: zTop, w, benchX, stagger: (specs.length - 1 - i) % 2 === 1 });
    x += w + ZONE_GAP;
  });

  if (flow) {
    const er = out.zones.find((z) => z.key === "er");
    // Corridor ends: Admit (towards the wards) next to ER on the left, the exit door on the right.
    out.admit = { x: er ? er.x : -W / 2 + 3, z: out.corridorZ, count: count("admit") };
    out.exit = { x: W / 2 - 0.6, z: out.corridorZ, count: count("done") };
    const o = count("other");
    if (o > 0) out.other = { x: W / 2 - 9, z: out.corridorZ, count: o };
    out.present = flow.total - count("done") - count("admit");
  }
  return out;
}

const dummy = new Object3D();
const tmpColor = new Color();
const white = new Color("#ffffff");

/** All seated patients: two instanced meshes (bodies + heads); breathing sway when animated. */
function PatientMeshes({ figs, anim }: { figs: Fig[]; anim: boolean }) {
  const body = useRef<InstancedMesh>(null);
  const head = useRef<InstancedMesh>(null);
  const dirty = useRef(true);
  const invalidate = useThree((s) => s.invalidate);
  const total = figs.length;

  useLayoutEffect(() => {
    dirty.current = true;
    invalidate();
  }, [figs, anim, invalidate]);

  useFrame(() => {
    const b = body.current;
    const h = head.current;
    if (!b || !h || (!anim && !dirty.current)) return;
    const t = now();
    const first = dirty.current;
    for (let i = 0; i < total; i++) {
      const f = figs[i];
      const hv = hash01(f.seed);
      const size = 1.35 + hv * 0.3;
      const sway = anim ? Math.sin(t * (0.7 + hv * 0.6) + f.seed) : 0;
      const breathe = anim ? 1 + Math.sin(t * 1.6 + f.seed * 1.3) * 0.025 : 1;
      const bodyH = 0.6 * size * 0.7;
      const x = f.x + sway * 0.025;
      const z = f.z - 0.05;
      dummy.rotation.set(sway * 0.04, Math.PI, sway * 0.05);
      dummy.position.set(x, SEAT_H + bodyH / 2, z);
      dummy.scale.set(size, 0.7 * size * breathe, size);
      dummy.updateMatrix();
      b.setMatrixAt(i, dummy.matrix);
      dummy.rotation.set(0, 0, 0);
      dummy.position.set(x + sway * 0.02, SEAT_H + bodyH * breathe + 0.12 * size, z);
      dummy.scale.set(size, size, size);
      dummy.updateMatrix();
      h.setMatrixAt(i, dummy.matrix);
      if (first) {
        b.setColorAt(i, tmpColor.set(f.color).lerp(white, hv * 0.22));
        h.setColorAt(i, tmpColor.set("#d9a47a").offsetHSL(0, 0, (hv - 0.5) * 0.12));
      }
    }
    b.instanceMatrix.needsUpdate = true;
    h.instanceMatrix.needsUpdate = true;
    if (first) {
      if (b.instanceColor) b.instanceColor.needsUpdate = true;
      if (h.instanceColor) h.instanceColor.needsUpdate = true;
    }
    dirty.current = false;
  });

  if (total === 0) return null;
  return (
    <>
      <instancedMesh
        key={`pb${total}`}
        ref={(m) => {
          body.current = m;
          if (m) m.instanceMatrix.setUsage(DynamicDrawUsage);
        }}
        args={[undefined, undefined, total]}
        castShadow
        frustumCulled={false}
      >
        <capsuleGeometry args={[0.17, 0.26, 4, 10]} />
        <meshStandardMaterial roughness={0.65} />
      </instancedMesh>
      <instancedMesh
        key={`ph${total}`}
        ref={(m) => {
          head.current = m;
          if (m) m.instanceMatrix.setUsage(DynamicDrawUsage);
        }}
        args={[undefined, undefined, total]}
        castShadow
        frustumCulled={false}
      >
        <sphereGeometry args={[0.12, 14, 10]} />
        <meshStandardMaterial roughness={0.7} />
      </instancedMesh>
    </>
  );
}

/** Every waiting bench of the hall (3-seat modules: seat + backrest + legs), instanced. */
function Benches({ benches }: { benches: [number, number][] }) {
  const seat = useRef<InstancedMesh>(null);
  const back = useRef<InstancedMesh>(null);
  const legs = useRef<InstancedMesh>(null);
  const invalidate = useThree((s) => s.invalidate);
  const w = MOD * SX - 0.08;
  const geo = useMemo(() => ({ seat: roundedBox(w, 0.06, 0.42, 0.025), back: roundedBox(w, 0.34, 0.05, 0.022) }), [w]);
  const n = benches.length;
  useLayoutEffect(() => {
    const s = seat.current;
    const b = back.current;
    const l = legs.current;
    if (!s || !b || !l) return;
    benches.forEach(([x, z], i) => {
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.position.set(x, SEAT_H - 0.03, z);
      dummy.updateMatrix();
      s.setMatrixAt(i, dummy.matrix);
      dummy.position.set(x, SEAT_H + 0.17, z + 0.21);
      dummy.updateMatrix();
      b.setMatrixAt(i, dummy.matrix);
      [-1, 1].forEach((side, k) => {
        dummy.position.set(x + side * (w / 2 - 0.12), (SEAT_H - 0.06) / 2, z);
        dummy.scale.set(0.05, SEAT_H - 0.06, 0.36);
        dummy.updateMatrix();
        l.setMatrixAt(i * 2 + k, dummy.matrix);
      });
    });
    for (const m of [s, b, l]) m.instanceMatrix.needsUpdate = true;
    invalidate();
  }, [benches, w, invalidate]);
  if (n === 0) return null;
  return (
    <>
      <instancedMesh key={`bs${n}`} ref={seat} args={[geo.seat, undefined, n]} castShadow receiveShadow frustumCulled={false}>
        <meshStandardMaterial color="#3b82a0" roughness={0.45} metalness={0.1} />
      </instancedMesh>
      <instancedMesh key={`bb${n}`} ref={back} args={[geo.back, undefined, n]} castShadow frustumCulled={false}>
        <meshStandardMaterial color="#3b82a0" roughness={0.45} metalness={0.1} />
      </instancedMesh>
      <instancedMesh key={`bl${n}`} ref={legs} args={[undefined, undefined, n * 2]} frustumCulled={false}>
        <boxGeometry />
        <meshStandardMaterial color="#94a3b8" metalness={0.6} roughness={0.35} />
      </instancedMesh>
    </>
  );
}

/** A seated staff member (doctor / nurse / lab / pharmacy) behind a desk facing +z; "writes" when animated. */
function Person({ x, z, coat, seed, anim }: { x: number; z: number; coat: string; seed: number; anim: boolean }) {
  const root = useRef<Group>(null);
  const arm = useRef<Group>(null);
  useFrame(() => {
    if (!root.current || !arm.current) return;
    if (anim) {
      const t = now() + seed;
      root.current.rotation.x = 0.06 + Math.sin(t * 1.4) * 0.04;
      arm.current.rotation.x = -1.1 + Math.sin(t * 5) * 0.22;
    } else {
      root.current.rotation.x = 0.06;
      arm.current.rotation.x = -0.9;
    }
  });
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, 0.42, -0.05]} castShadow>
        <cylinderGeometry args={[0.24, 0.24, 0.07, 16]} />
        <meshStandardMaterial color="#334155" roughness={0.6} />
      </mesh>
      <mesh position={[0, 0.21, -0.05]}>
        <cylinderGeometry args={[0.03, 0.03, 0.4, 8]} />
        <meshStandardMaterial color="#64748b" metalness={0.6} roughness={0.35} />
      </mesh>
      <mesh position={[0, 0.72, -0.3]} castShadow>
        <boxGeometry args={[0.42, 0.5, 0.06]} />
        <meshStandardMaterial color="#334155" roughness={0.6} />
      </mesh>
      <group ref={root} position={[0, 0.46, 0]}>
        <mesh position={[0, 0.3, 0]} castShadow>
          <capsuleGeometry args={[0.2, 0.3, 4, 12]} />
          <meshStandardMaterial color={coat} roughness={0.7} />
        </mesh>
        <mesh position={[0, 0.74, 0.02]} castShadow>
          <sphereGeometry args={[0.16, 16, 12]} />
          <meshStandardMaterial color="#d9a47a" roughness={0.7} />
        </mesh>
        <group ref={arm} position={[0.22, 0.42, 0.04]}>
          <mesh position={[0, 0, 0.18]}>
            <capsuleGeometry args={[0.055, 0.28, 3, 8]} />
            <meshStandardMaterial color={coat} roughness={0.7} />
          </mesh>
        </group>
      </group>
    </group>
  );
}

/** Desk with a rounded top, modesty panel, and one monitor per seat (facing the staff). */
function Desk({ x, z, w, seats, color = "#d6b48a" }: { x: number; z: number; w: number; seats: number[]; color?: string }) {
  const top = useMemo(() => roundedBox(w, 0.06, 0.8, 0.03), [w]);
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, 0.76, 0]} geometry={top} castShadow receiveShadow>
        <meshStandardMaterial color={color} roughness={0.55} />
      </mesh>
      <mesh position={[0, 0.38, 0.34]} castShadow>
        <boxGeometry args={[w - 0.1, 0.7, 0.04]} />
        <meshStandardMaterial color="#f1f5f9" roughness={0.7} />
      </mesh>
      {[-1, 1].map((s) => (
        <mesh key={s} position={[s * (w / 2 - 0.05), 0.38, 0]} castShadow>
          <boxGeometry args={[0.05, 0.74, 0.74]} />
          <meshStandardMaterial color="#f1f5f9" roughness={0.7} />
        </mesh>
      ))}
      {seats.map((sx) => (
        <group key={sx} position={[sx, 0.79, 0.12]}>
          <mesh position={[0, 0.2, 0]} castShadow>
            <boxGeometry args={[0.5, 0.32, 0.03]} />
            <meshStandardMaterial color="#0f172a" roughness={0.25} metalness={0.3} />
          </mesh>
          <mesh position={[0, 0.2, -0.017]} rotation={[0, Math.PI, 0]}>
            <planeGeometry args={[0.46, 0.28]} />
            <meshStandardMaterial color="#60a5fa" emissive="#3b82f6" emissiveIntensity={0.5} roughness={0.2} />
          </mesh>
          <mesh position={[0, 0.03, 0.03]}>
            <boxGeometry args={[0.16, 0.06, 0.12]} />
            <meshStandardMaterial color="#334155" />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/** Patient chair in front of a desk. */
function Chair({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, 0.44, 0]} castShadow>
        <boxGeometry args={[0.44, 0.06, 0.42]} />
        <meshStandardMaterial color="#3b82a0" roughness={0.45} />
      </mesh>
      <mesh position={[0, 0.68, 0.2]} castShadow>
        <boxGeometry args={[0.44, 0.42, 0.05]} />
        <meshStandardMaterial color="#3b82a0" roughness={0.45} />
      </mesh>
      <mesh position={[0, 0.21, 0]}>
        <cylinderGeometry args={[0.03, 0.03, 0.42, 8]} />
        <meshStandardMaterial color="#94a3b8" metalness={0.5} roughness={0.4} />
      </mesh>
    </group>
  );
}

/** Stretcher bed (ER / exam couch), head towards -z. */
function Stretcher({ x, z, blanket }: { x: number; z: number; blanket: string }) {
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, 0.62, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.8, 0.12, 1.9]} />
        <meshStandardMaterial color="#f8fafc" roughness={0.6} />
      </mesh>
      <mesh position={[0, 0.7, 0.25]} castShadow>
        <boxGeometry args={[0.82, 0.06, 1.1]} />
        <meshStandardMaterial color={blanket} roughness={0.8} />
      </mesh>
      <mesh position={[0, 0.72, -0.7]}>
        <boxGeometry args={[0.5, 0.1, 0.32]} />
        <meshStandardMaterial color="#ffffff" roughness={0.8} />
      </mesh>
      {[-0.75, 0.75].map((dz) => (
        <mesh key={dz} position={[0, 0.3, dz]}>
          <boxGeometry args={[0.7, 0.6, 0.05]} />
          <meshStandardMaterial color="#94a3b8" metalness={0.5} roughness={0.4} />
        </mesh>
      ))}
    </group>
  );
}

/** Floor plate of an area (baked edge shading). */
function Plate({ w, d, color }: { w: number; d: number; color: string }) {
  return (
    <mesh position={[0, 0.02, 0]} receiveShadow>
      <boxGeometry args={[w, 0.1, d]} />
      <meshStandardMaterial color={color} map={edgeShadeTexture()} roughness={0.8} />
    </mesh>
  );
}

/** Screen-aligned label; always portalled into the canvas box (see LabelPortal). */
function Label({ position, z = 10, children }: { position: [number, number, number]; z?: number; children: ReactNode }) {
  const portal = useContext(LabelPortal) ?? undefined;
  return (
    <Html portal={portal} position={position} center zIndexRange={[z, 0]} pointerEvents="none">
      {children}
    </Html>
  );
}

/** "+N" when a waiting point holds more patients than it draws. */
function Over({ count, shown }: { count: number; shown: number }) {
  return count > shown ? <span className="ml-1 text-xs font-normal text-slate-500">(+{fmtNum(count - shown)})</span> : null;
}

function ExamRoom({ room, anim }: { room: Room; anim: boolean }) {
  const roomW = room.w - 1.2;
  const deskZ = 1.6;
  const docs = Math.min(room.doctors, 2);
  const seatXs = docs === 2 ? [-0.9, 0.9] : [0];
  const rest = room.code === "_rest";
  const cellD = CELL_D - 0.3;
  return (
    <group position={[room.x, 0, room.z]}>
      <group position={[0, 0, cellD / 2]}>
        <Plate w={room.w - 0.5} d={cellD} color={TONE_FLOOR[room.tone]} />
      </group>
      {/* Exam room: back wall + low side walls, open to its queue. */}
      <mesh position={[0, 1.1, 0.1]} castShadow receiveShadow>
        <boxGeometry args={[roomW, 2.2, 0.2]} />
        <meshStandardMaterial color="#f8fafc" roughness={0.85} />
      </mesh>
      <mesh position={[0, 2.22, 0.1]}>
        <boxGeometry args={[roomW + 0.02, 0.06, 0.24]} />
        <meshStandardMaterial color={FLOW_COLOR.doctor.hex} roughness={0.6} />
      </mesh>
      {[-1, 1].map((s) => (
        <mesh key={s} position={[s * (roomW / 2 - 0.1), 0.5, ROOM_D / 2]} castShadow receiveShadow>
          <boxGeometry args={[0.2, 1, ROOM_D]} />
          <meshStandardMaterial color="#eef2f6" roughness={0.85} />
        </mesh>
      ))}
      <mesh position={[0, 0.09, ROOM_D / 2]} receiveShadow>
        <boxGeometry args={[roomW - 0.4, 0.04, ROOM_D - 0.2]} />
        <meshStandardMaterial color="#f5f7f9" map={edgeShadeTexture()} roughness={0.6} />
      </mesh>
      {rest ? null : (
        <>
          <Desk x={-0.4} z={deskZ} w={3} seats={docs === 0 ? [0] : seatXs} />
          {seatXs.slice(0, docs).map((sx, k) => (
            <Person key={sx} x={sx - 0.4} z={deskZ - 0.75} coat="#f8fafc" anim={anim} seed={room.x + room.z + k * 2} />
          ))}
          <Chair x={-0.4} z={deskZ + 0.95} />
          <group position={[roomW / 2 - 0.8, 0, 1.5]} scale={0.8}>
            <Stretcher x={0} z={0} blanket="#bfdbfe" />
          </group>
        </>
      )}
      <Label position={[0, 2.5, -0.2]}>
        <div
          className={`max-w-[9.5rem] whitespace-nowrap rounded-md border-l-4 px-2 py-0.5 text-center text-xs shadow ${room.active ? "bg-white/95" : "bg-slate-100/95 text-slate-500"}`}
          style={{ borderColor: FLOW_COLOR.doctor.hex }}
        >
          <div className="truncate font-semibold">{room.name}</div>
          <div className="flex items-center justify-center gap-1">
            {room.active ? (
              <>
                <span className="font-semibold tabular-nums">
                  รอ {fmtNum(room.count)} คน
                  <Over count={room.count} shown={room.shown} />
                </span>
                {room.est !== null ? (
                  <span className={`rounded-full px-1.5 font-medium ${toneBadge[room.tone]}`}>~{fmtNum(Math.round(room.est))} น.</span>
                ) : null}
              </>
            ) : (
              <span className="text-slate-500">ยังไม่มีผู้ป่วย</span>
            )}
          </div>
        </div>
      </Label>
    </group>
  );
}

const tint = (hex: string, k: number) => `#${new Color(hex).lerp(white, k).getHexString()}`;

/** Furniture per waiting point (local coordinates: zone back wall at z = 0, centre x = 0). */
function ZoneProps({ zone, anim }: { zone: Zone; anim: boolean }) {
  const deskZ = 1.15;
  const bx = zone.benchX - zone.x;
  const right = zone.w / 2;
  switch (zone.key) {
    case "screening":
      return (
        <>
          <Desk x={bx} z={deskZ} w={3.6} seats={[-0.9, 0.9]} />
          {[-0.9, 0.9].map((sx, i) => (
            <Person key={sx} x={bx + sx} z={deskZ - 0.75} coat="#0f766e" anim={anim} seed={i * 1.9} />
          ))}
          {[-0.9, 0.9].map((sx) => (
            <Chair key={sx} x={bx + sx + 0.2} z={deskZ + 0.95} />
          ))}
        </>
      );
    case "after_doctor":
      return (
        <>
          <Desk x={bx} z={deskZ} w={3} seats={[0]} />
          <Person x={bx} z={deskZ - 0.75} coat="#0f766e" anim={anim} seed={4.2} />
          <Chair x={bx + 0.2} z={deskZ + 0.95} />
        </>
      );
    case "lab": {
      const xr = right - 2.2;
      return (
        <>
          {/* Blood draw counter with three stations. */}
          <Desk x={bx} z={deskZ} w={6} seats={[-2, 0, 2]} color="#cbd5e1" />
          {[-2, 0, 2].map((sx, i) => (
            <Person key={sx} x={bx + sx} z={deskZ - 0.75} coat="#7dd3fc" anim={anim} seed={7 + i} />
          ))}
          {[-2, 0, 2].map((sx) => (
            <Chair key={sx} x={bx + sx} z={deskZ + 0.95} />
          ))}
          {/* X-ray room: walls, table, tube stand and a warning light over the door. */}
          <group position={[xr, 0, 0]}>
            <mesh position={[0, 0.06, 2.1]} receiveShadow>
              <boxGeometry args={[3.6, 0.04, 4]} />
              <meshStandardMaterial color="#e2e8f0" roughness={0.6} />
            </mesh>
            {[-1, 1].map((s) => (
              <mesh key={s} position={[s * 1.75, 0.9, 2.1]} castShadow receiveShadow>
                <boxGeometry args={[0.12, 1.8, 4]} />
                <meshStandardMaterial color="#f1f5f9" roughness={0.8} />
              </mesh>
            ))}
            <mesh position={[0, 0.9, 0.12]} castShadow>
              <boxGeometry args={[3.6, 1.8, 0.16]} />
              <meshStandardMaterial color="#f1f5f9" roughness={0.8} />
            </mesh>
            <mesh position={[-0.9, 0.9, 4.06]} castShadow>
              <boxGeometry args={[1.7, 1.8, 0.12]} />
              <meshStandardMaterial color="#f1f5f9" roughness={0.8} />
            </mesh>
            <mesh position={[0.2, 0.5, 2]} castShadow>
              <boxGeometry args={[0.8, 0.12, 2]} />
              <meshStandardMaterial color="#e5e7eb" roughness={0.5} />
            </mesh>
            <mesh position={[0.2, 0.25, 2]}>
              <boxGeometry args={[0.4, 0.5, 1.2]} />
              <meshStandardMaterial color="#94a3b8" metalness={0.4} roughness={0.4} />
            </mesh>
            <mesh position={[1.2, 1, 2]} castShadow>
              <boxGeometry args={[0.2, 2, 0.2]} />
              <meshStandardMaterial color="#64748b" metalness={0.5} roughness={0.4} />
            </mesh>
            <mesh position={[0.6, 1.65, 2]} castShadow>
              <boxGeometry args={[1.2, 0.3, 0.45]} />
              <meshStandardMaterial color="#e2e8f0" metalness={0.2} roughness={0.4} />
            </mesh>
            <mesh position={[0.4, 1.86, 4.1]}>
              <boxGeometry args={[0.5, 0.18, 0.06]} />
              <meshStandardMaterial color="#facc15" emissive="#f59e0b" emissiveIntensity={0.8} />
            </mesh>
          </group>
        </>
      );
    }
    case "services":
      return (
        <>
          {/* Dental chair with lamp, a dentist and an eye chart. */}
          <group position={[bx - 1, 0, 1.2]}>
            <mesh position={[0, 0.5, 0]} rotation={[-0.35, 0, 0]} castShadow>
              <boxGeometry args={[0.7, 0.12, 1.6]} />
              <meshStandardMaterial color={tint(zone.color, 0.35)} roughness={0.5} />
            </mesh>
            <mesh position={[0, 0.22, 0.1]}>
              <cylinderGeometry args={[0.12, 0.25, 0.44, 12]} />
              <meshStandardMaterial color="#e2e8f0" metalness={0.3} roughness={0.4} />
            </mesh>
            <mesh position={[0.6, 1.4, -0.4]}>
              <sphereGeometry args={[0.18, 16, 10]} />
              <meshStandardMaterial color="#f8fafc" emissive="#fef9c3" emissiveIntensity={0.6} />
            </mesh>
            <mesh position={[0.6, 0.75, -0.4]}>
              <cylinderGeometry args={[0.03, 0.03, 1.3, 8]} />
              <meshStandardMaterial color="#94a3b8" metalness={0.6} roughness={0.3} />
            </mesh>
          </group>
          <Person x={bx + 0.2} z={0.75} coat="#f8fafc" anim={anim} seed={11} />
          <Desk x={bx + 1.4} z={deskZ} w={1.4} seats={[0]} />
          <mesh position={[bx + 1.9, 1.25, 0.2]}>
            <boxGeometry args={[0.6, 0.9, 0.04]} />
            <meshStandardMaterial color="#ffffff" roughness={0.6} />
          </mesh>
          {[0.25, 0.1, -0.05, -0.2].map((dy, i) => (
            <mesh key={dy} position={[bx + 1.9, 1.25 + dy, 0.23]}>
              <boxGeometry args={[0.4 - i * 0.08, 0.05, 0.01]} />
              <meshStandardMaterial color="#1e293b" />
            </mesh>
          ))}
        </>
      );
    case "pharmacy":
      return (
        <>
          {/* Medicine shelves along the back wall. */}
          {[-2.2, 0, 2.2].map((sx, k) => (
            <group key={sx} position={[bx + sx, 0, 0.35]}>
              <mesh position={[0, 0.9, 0]} castShadow>
                <boxGeometry args={[1.9, 1.8, 0.4]} />
                <meshStandardMaterial color="#e2e8f0" roughness={0.7} />
              </mesh>
              {[0.5, 0.95, 1.4].map((y, i) => (
                <mesh key={y} position={[0, y, 0.18]}>
                  <boxGeometry args={[1.7, 0.22, 0.06]} />
                  <meshStandardMaterial color={["#fca5a5", "#93c5fd", "#86efac"][(i + k) % 3]} roughness={0.6} />
                </mesh>
              ))}
            </group>
          ))}
          <Desk x={bx - 0.9} z={deskZ + 0.4} w={4.4} seats={[-1.2, 0.6]} color="#cbd5e1" />
          {[-1.2, 0.6].map((sx, i) => (
            <Person key={sx} x={bx - 0.9 + sx} z={deskZ - 0.35} coat="#ccfbf1" anim={anim} seed={20 + i} />
          ))}
          {/* Glass partition over the counter. */}
          <mesh position={[bx - 0.9, 1.25, deskZ + 0.78]}>
            <boxGeometry args={[4.3, 0.9, 0.03]} />
            <meshStandardMaterial color="#e0f2fe" transparent opacity={0.35} roughness={0.1} />
          </mesh>
          {/* Cashier window. */}
          <Desk x={bx + 2.6} z={deskZ + 0.4} w={1.6} seats={[0]} color="#fde68a" />
          <Person x={bx + 2.6} z={deskZ - 0.35} coat="#fef3c7" anim={anim} seed={23} />
        </>
      );
    case "er": {
      const bedX = right - 1.5;
      return (
        <>
          <Stretcher x={bedX - 0.6} z={1.6} blanket="#fecaca" />
          <Stretcher x={bedX + 0.6} z={1.6} blanket="#fecaca" />
          <Person x={bx} z={0.75} coat="#0f766e" anim={anim} seed={30} />
          <Desk x={bx} z={deskZ + 0.4} w={2} seats={[0]} />
          {/* Red cross on the back wall. */}
          <mesh position={[bedX, 1.3, 0.2]}>
            <boxGeometry args={[0.7, 0.2, 0.05]} />
            <meshStandardMaterial color="#ef4444" emissive="#ef4444" emissiveIntensity={0.4} />
          </mesh>
          <mesh position={[bedX, 1.3, 0.2]}>
            <boxGeometry args={[0.2, 0.7, 0.05]} />
            <meshStandardMaterial color="#ef4444" emissive="#ef4444" emissiveIntensity={0.4} />
          </mesh>
        </>
      );
    }
    default:
      return null;
  }
}

function WaitZone({ zone, anim }: { zone: Zone; anim: boolean }) {
  const floor = useMemo(() => tint(zone.color, 0.8), [zone.color]);
  const wall = useMemo(() => tint(zone.color, 0.9), [zone.color]);
  return (
    <group position={[zone.x, 0, zone.z]}>
      <group position={[0, 0, ZONE_D / 2]}>
        <Plate w={zone.w} d={ZONE_D} color={floor} />
      </group>
      {/* Low back wall with a band in the waiting point's colour. */}
      <mesh position={[0, 0.8, 0.08]} castShadow receiveShadow>
        <boxGeometry args={[zone.w, 1.6, 0.16]} />
        <meshStandardMaterial color={wall} roughness={0.85} />
      </mesh>
      <mesh position={[0, 1.62, 0.08]}>
        <boxGeometry args={[zone.w + 0.02, 0.08, 0.2]} />
        <meshStandardMaterial color={zone.color} roughness={0.6} />
      </mesh>
      <ZoneProps zone={zone} anim={anim} />
      <Label position={[0, 0.3, ZONE_D + (zone.stagger ? 2.4 : 0.8)]} z={12}>
        <div className="whitespace-nowrap rounded-lg border-2 bg-white/95 px-2.5 py-0.5 text-center shadow" style={{ borderColor: zone.color }}>
          <div className="flex items-center justify-center gap-1 text-xs font-semibold text-slate-700">
            <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: zone.color }} aria-hidden />
            {zone.name}
          </div>
          <div className="text-sm font-bold tabular-nums text-slate-900">
            รอ {fmtNum(zone.count)} คน
            <Over count={zone.count} shown={zone.shown} />
          </div>
        </div>
      </Label>
    </group>
  );
}

/** Exit door at the front edge: visits sent home (not waiting, no crowd). */
function ExitDoor({ sign }: { sign: Sign }) {
  const c = FLOW_COLOR.done.hex;
  return (
    <group position={[sign.x, 0, sign.z]} rotation={[0, Math.PI / 2, 0]}>
      {[-1, 1].map((s) => (
        <mesh key={s} position={[s * 0.95, 1.1, 0]} castShadow>
          <boxGeometry args={[0.16, 2.2, 0.16]} />
          <meshStandardMaterial color="#64748b" metalness={0.4} roughness={0.4} />
        </mesh>
      ))}
      <mesh position={[0, 2.25, 0]} castShadow>
        <boxGeometry args={[2.06, 0.16, 0.16]} />
        <meshStandardMaterial color="#64748b" metalness={0.4} roughness={0.4} />
      </mesh>
      <mesh position={[0, 1.1, -0.02]}>
        <boxGeometry args={[1.74, 2.04, 0.04]} />
        <meshStandardMaterial color="#d1fae5" transparent opacity={0.45} roughness={0.1} />
      </mesh>
      <mesh position={[0, 2.5, 0]}>
        <boxGeometry args={[0.9, 0.3, 0.08]} />
        <meshStandardMaterial color={c} emissive={c} emissiveIntensity={0.7} />
      </mesh>
      <Label position={[0, 3.1, 0]} z={12}>
        <div className="whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold text-white shadow" style={{ background: c }}>
          ทางออก · กลับบ้านแล้ว {fmtNum(sign.count)} คน
        </div>
      </Label>
    </group>
  );
}

/** Small post sign in the corridor (Admit / other): a counter only, no crowd. */
function PostSign({ sign, color, text }: { sign: Sign; color: string; text: string }) {
  return (
    <group position={[sign.x, 0, sign.z]}>
      <mesh position={[0, 0.7, 0]} castShadow>
        <cylinderGeometry args={[0.05, 0.05, 1.4, 8]} />
        <meshStandardMaterial color="#64748b" metalness={0.5} roughness={0.4} />
      </mesh>
      <mesh position={[0, 0.02, 0]}>
        <cylinderGeometry args={[0.28, 0.32, 0.05, 16]} />
        <meshStandardMaterial color="#475569" />
      </mesh>
      <mesh position={[0, 1.5, 0]} castShadow>
        <boxGeometry args={[1.2, 0.45, 0.06]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.25} roughness={0.5} />
      </mesh>
      <Label position={[0, 1.95, 0]} z={12}>
        <div className="whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold text-white shadow" style={{ background: color }}>
          {text}
        </div>
      </Label>
    </group>
  );
}

function Rig({ goal }: { goal: Goal }) {
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    camera.position.copy(goalPose(goal, (camera as PerspectiveCamera).fov, size.width / Math.max(size.height, 1)));
    c.target.set(goal.cx, 0, goal.cz);
    c.update();
    invalidate();
  }, [goal, size.width, size.height, camera, invalidate]);
  return <OrbitControls ref={controls} makeDefault {...NAV_CONTROL_PROPS} maxPolarAngle={Math.PI / 2.3} minDistance={6} maxDistance={220} />;
}

/** Tiled hall floor. */
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

function Scene({ lay, anim, goal, quality }: { lay: Layout; anim: boolean; goal: Goal; quality: Quality }) {
  const high = quality === "high";
  return (
    <>
      <SceneLights quality={quality} w={lay.W + 6} d={lay.D + 6} />
      {high ? <RoomEnv intensity={0.35} /> : null}
      {high ? <DepthFog color={BG_COLOR} /> : null}
      <Ground w={lay.W + 4} d={lay.D + 2} />
      {lay.rooms.map((r) => (
        <ExamRoom key={r.code} room={r} anim={anim} />
      ))}
      {lay.zones.map((z) => (
        <WaitZone key={z.key} zone={z} anim={anim} />
      ))}
      <Benches benches={lay.benches} />
      <PatientMeshes figs={lay.figs} anim={anim} />
      {lay.rooms.length > 0 ? (
        <Label position={[0, 0.25, lay.corridorZ - 0.7]} z={12}>
          <div className="whitespace-nowrap rounded-lg border-2 bg-white/95 px-2.5 py-0.5 text-center shadow" style={{ borderColor: FLOW_COLOR.doctor.hex }}>
            <div className="flex items-center justify-center gap-1 text-xs font-semibold text-slate-700">
              <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: FLOW_COLOR.doctor.hex }} aria-hidden />
              หน้าห้องตรวจทุกห้อง · รอพบแพทย์
            </div>
            <div className="text-sm font-bold tabular-nums text-slate-900">รอ {fmtNum(lay.doctorCount)} คน</div>
          </div>
        </Label>
      ) : null}
      {lay.exit ? <ExitDoor sign={lay.exit} /> : null}
      {lay.admit ? <PostSign sign={lay.admit} color={FLOW_COLOR.admit.hex} text={`Admit ${fmtNum(lay.admit.count)} คน → หอผู้ป่วยใน`} /> : null}
      {lay.other ? <PostSign sign={lay.other} color="#64748b" text={`อื่นๆ / ค้างในระบบ ${fmtNum(lay.other.count)}`} /> : null}
      <Rig goal={goal} />
    </>
  );
}

function Legend({ flow }: { flow: OpdFlow | null }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
      {flow
        ? FLOW_DEFS.map((d) => (
            <span key={d.key} className="inline-flex items-center gap-1">
              <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: FLOW_COLOR[d.key].hex }} aria-hidden />
              {d.label} {fmtNum(flow.buckets.find((b) => b.key === d.key)?.count ?? 0)}
            </span>
          ))
        : null}
      <span className="inline-flex items-center gap-1">
        <span className="inline-block h-2.5 w-2.5 rounded-full bg-slate-100 ring-1 ring-slate-400" /> แพทย์
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="inline-block h-2.5 w-2.5 rounded-full bg-teal-700" /> พยาบาล
      </span>
      <span className="text-slate-500">
        ผู้ป่วย 1 ตัว = 1 คน แสดงเท่าที่นั่งของแต่ละจุด (+N = ส่วนที่เกิน) · สีพื้นห้องตรวจตามเวลารอ เขียว/เหลือง/ส้ม/แดง
      </span>
    </div>
  );
}

export default function OpdScene({ flow, clinics }: { flow: OpdFlow | null; clinics: ClinicWait[] }) {
  const webgl = useSyncExternalStore(
    () => () => {},
    detectWebGL,
    () => null,
  );
  const [anim, setAnim] = useState(readAnimPref);
  const [quality, setQuality] = useState<Quality>(readQuality);
  const [visible, setVisible] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  const lay = useMemo(() => layoutOpd(flow, clinics), [flow, clinics]);
  const glProps = useMemo(() => canvasProps(quality), [quality]);
  const [resetN, setResetN] = useState(0);
  const nav = useNavHold();
  useNavKeys(box, nav);
  // Opening view: the whole hall, both wings (labels are fixed-size pills),
  // nudged left so the navigation pad (bottom right) does not cover the last area.
  const goal = useMemo<Goal>(
    () => ({ key: `${lay.W}x${lay.D}:${resetN}`, cx: lay.W * 0.07, cz: lay.D * 0.12, w: lay.W * 1.14, d: lay.D * 0.9, margin: 0.5 }),
    [lay.W, lay.D, resetN],
  );

  // Stop rendering while the canvas is scrolled out of view.
  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, [webgl]);

  if (webgl === null) return <div className="h-[420px]" />;
  if (!webgl) return <OpdGrid2D flow={flow} clinics={clinics} />;

  const toggleAnim = () => {
    const next = !anim;
    setAnim(next);
    writeAnimPref(next);
  };

  return (
    <div className="space-y-2">
      <div
        ref={box}
        tabIndex={0}
        aria-label="ภาพ 3 มิติ จุดที่ผู้ป่วยนอกนั่งรอ ใช้ลูกศรเพื่อเลื่อน"
        className="relative h-[520px] overflow-hidden rounded-md bg-brand-50 outline-none focus-visible:ring-2 focus-visible:ring-brand-400 lg:h-[680px]"
      >
        <Canvas
          key={quality}
          {...glProps}
          frameloop={anim && visible ? "always" : "demand"}
          camera={{ position: [0, 60, 50], fov: 45, far: 600 }}
        >
          <LabelPortal.Provider value={box as RefObject<HTMLElement>}>
            <Scene lay={lay} anim={anim} goal={goal} quality={quality} />
          </LabelPortal.Provider>
          <NavDriver nav={nav} w={lay.W} d={lay.D} />
        </Canvas>
        <div className="pointer-events-none absolute left-3 top-3 z-20 rounded-md bg-white/90 px-2.5 py-1 text-xs text-slate-700 shadow">
          {lay.total !== null ? (
            <>
              visit วันนี้ <span className="text-sm font-bold text-brand-700 tabular-nums">{fmtNum(lay.total)}</span> ครั้ง · อยู่ตามจุดบริการ{" "}
              <span className="text-sm font-bold tabular-nums">{fmtNum(lay.present)}</span> คน
            </>
          ) : (
            "ยังไม่มีข้อมูลสถานะ visit วันนี้ แสดงเฉพาะคิวห้องตรวจ"
          )}
        </div>
        <div className="absolute bottom-3 right-3 z-30">
          <NavPad nav={nav} onReset={() => setResetN((n) => n + 1)} />
        </div>
        <div className="absolute right-3 top-3 z-30 flex flex-col items-end gap-2">
          <button type="button" className={buttonGhostClass} aria-pressed={anim} onClick={toggleAnim}>
            ภาพเคลื่อนไหว {anim ? "เปิด" : "ปิด"}
          </button>
          <QualityToggle quality={quality} onChange={setQuality} />
        </div>
      </div>
      <Legend flow={flow} />
    </div>
  );
}
