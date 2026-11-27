"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, useContext, type ComponentRef, type RefObject } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Html, OrbitControls } from "@react-three/drei";
import { Color, DynamicDrawUsage, MathUtils, Object3D } from "three";
import type { Group, InstancedMesh, PerspectiveCamera } from "three";
import type { ClinicWait } from "@/lib/opd/types";
import { fmtNum, waitTone, type Tone } from "../format";
import { NAV_CONTROL_PROPS, NavDriver, NavPad, useNavHold, useNavKeys } from "../scene3dNav";
import { LabelPortal, clamp01, detectWebGL, goalPose, hash01, now, readAnimPref, writeAnimPref, type Goal } from "../scene3d";
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

/** Fewest room columns; more for many clinics so the hall matches a wide screen. */
const MIN_COLS = 3;
const CELL_W = 12.5;
const ROOM_W = 7.5;
const ROOM_D = 3.6;
/** Strip behind every room's back wall reserved for the clinic label pill. */
const LABEL_STRIP = 3.2;
const SCREEN_D = 4;
/** Patients drawn per clinic queue; the rest is shown as "+N" on the label. */
const MAX_SHOWN = 30;
const LANE_COLS = 5;
const LANE_ROWS = MAX_SHOWN / LANE_COLS;
const SLOT_DX = 0.95;
const SLOT_DZ = 0.85;
const MOVE_SECONDS = 1.4;
const CELL_D = LABEL_STRIP + ROOM_D + 0.6 + 0.7 + (LANE_ROWS - 1) * SLOT_DZ + 0.8;
const ROOM_BACK = -CELL_D / 2 + LABEL_STRIP;
const BG_COLOR = "#effaf8";
/** Bench seat behind each queue row; seated patients sit on it. */
const BENCH_DZ = 0.3;
const SEAT_H = 0.42;

const TONE_COLOR: Record<Tone, string> = {
  green: "#22c55e",
  amber: "#f59e0b",
  orange: "#f97316",
  red: "#dc2626",
  slate: "#94a3b8",
  brand: "#14b8a6",
};
const FLOOR_COLOR: Record<Tone, string> = {
  green: "#b4ecc6",
  amber: "#fbe08a",
  orange: "#fdcf9e",
  red: "#f9bcbc",
  slate: "#e2e8f0",
  brand: "#d5f2ed",
};
const TONE_THREE = Object.fromEntries(Object.entries(TONE_COLOR).map(([k, v]) => [k, new Color(v)])) as Record<Tone, Color>;

/** Tone of the clinic as a whole: expected wait, else today's average, else the longest current wait. */
function clinicMinutes(c: ClinicWait): number {
  return c.estimatedWaitMinutes ?? c.avgWaitMinutes ?? c.longestWaitMinutes;
}

type Cell = { clinic: ClinicWait; cx: number; cz: number; shown: number; tone: Tone };
type Hall = { cells: Cell[]; width: number; depth: number; screenZ: number; rows: number; activeRows: number };

/** Clinic with patients today (waiting or seen). */
const isActive = (c: ClinicWait) => c.waitingNow > 0 || c.seenToday > 0;

/** Display name for the 3D pill: HOSxP names carry notes in brackets, e.g. "(รอพบแพทย์ ห้ามนัด)". */
function shortName(name: string): string {
  const s = name.replace(/\s*[(（][^)）]*[)）]/g, "").trim();
  return s || name;
}

function layoutHall(input: ClinicWait[]): Hall {
  // Active clinics first (stable: keeps HOSxP order within each group) so the
  // opening view can sit on the rows that matter.
  const clinics = [...input.filter(isActive), ...input.filter((c) => !isActive(c))];
  const n = clinics.length;
  const perRow = Math.max(1, Math.min(n, Math.max(MIN_COLS, Math.round(Math.sqrt(n * 1.8)))));
  const cols = perRow;
  const rows = Math.max(1, Math.ceil(n / perRow));
  const activeRows = Math.ceil(input.filter(isActive).length / perRow);
  const width = cols * CELL_W;
  const depth = rows * CELL_D + SCREEN_D;
  const cells = clinics.map((clinic, i) => ({
    clinic,
    cx: ((i % perRow) - (cols - 1) / 2) * CELL_W,
    cz: -depth / 2 + Math.floor(i / perRow) * CELL_D + CELL_D / 2,
    shown: Math.min(clinic.waitingNow, MAX_SHOWN),
    tone: waitTone(clinicMinutes(clinic)),
  }));
  return { cells, width, depth, screenZ: depth / 2 - SCREEN_D / 2, rows, activeRows };
}

/** Local (to the cell) position of queue slot j; slot 0 is right at the room door. */
const doorZ = ROOM_BACK + ROOM_D + 0.6;
/** Snake order so that moving from slot j to j-1 is always one step. */
function slotPos(j: number): [number, number] {
  const row = Math.floor(j / LANE_COLS);
  const c = j % LANE_COLS;
  const col = row % 2 === 0 ? c : LANE_COLS - 1 - c;
  return [(col - (LANE_COLS - 1) / 2) * SLOT_DX, doorZ + 0.7 + row * SLOT_DZ];
}

type Queue = {
  cell: Cell;
  /** First instance index in the shared meshes. */
  base: number;
  /** n shown + 1: a leaving walker at the head and an arriving patient at the tail. */
  count: number;
  period: number;
  phase: number;
  moving: boolean;
};

function buildQueues(hall: Hall): { queues: Queue[]; total: number } {
  let total = 0;
  const queues: Queue[] = [];
  hall.cells.forEach((cell, i) => {
    if (cell.shown === 0) return;
    const c = cell.clinic;
    // Seen-per-hour sets the pace of the line: a patient enters every period seconds.
    const period = MathUtils.clamp(60 / Math.max(c.seenLastHour, 1) * 1.6, 5, 16);
    queues.push({ cell, base: total, count: cell.shown + 1, period, phase: hash01(i + 3) * period, moving: c.doctorsActive > 0 });
    total += cell.shown + 1;
  });
  return { queues, total };
}

const dummy = new Object3D();
const tmpColor = new Color();
const easeInOut = (p: number) => p * p * (3 - 2 * p);

/** All waiting patients of the hall: two instanced meshes (bodies + heads), updated per frame. */
function PatientMeshes({ queues, total, anim }: { queues: Queue[]; total: number; anim: boolean }) {
  const body = useRef<InstancedMesh>(null);
  const head = useRef<InstancedMesh>(null);
  const dirty = useRef(true);
  const invalidate = useThree((s) => s.invalidate);

  useLayoutEffect(() => {
    dirty.current = true;
    invalidate();
  }, [queues, anim, invalidate]);

  useFrame(() => {
    const b = body.current;
    const h = head.current;
    if (!b || !h) return;
    const t = now();
    let colorsChanged = false;
    for (const q of queues) {
      const c = q.cell.clinic;
      const nTotal = Math.max(c.waitingNow - 1, 1);
      let e = 0;
      let k = 0;
      if (anim && q.moving) {
        const tt = t + q.phase;
        k = Math.floor(tt / q.period);
        const local = tt - k * q.period;
        const start = q.period - MOVE_SECONDS;
        if (local > start) e = easeInOut(clamp01((local - start) / MOVE_SECONDS));
      }
      const moving = e > 0 && e < 1;
      const n = q.count - 1;
      for (let i = 0; i <= n; i++) {
        const idx = q.base + i;
        const [ax, az] = slotPos(i);
        const [bx, bz] = i === 0 ? [0, doorZ - 1.4] : slotPos(i - 1);
        let x = q.cell.cx + ax + (bx - ax) * e;
        let z = q.cell.cz + az + (bz - az) * e;
        // Walker leaves at the head, newcomer arrives at the tail.
        let sc = 1;
        if (i === 0) sc = 1 - e;
        else if (i === n) sc = e;
        const hv = hash01(i + k + q.base * 0.37);
        // Some sit on the bench behind their spot (not while stepping forward).
        const seated = hv < 0.35 && !moving && i > 0;
        const size = (1.4 + hv * 0.3) * sc;
        if (seated) z += BENCH_DZ - 0.08;
        if (anim && q.moving) x += Math.sin(t * 1.3 + i * 1.7) * 0.03;
        const bodyH = 0.6 * size;
        const y0 = seated ? SEAT_H : 0;
        const ys = seated ? 0.7 : 1;
        dummy.rotation.set(0, Math.PI, 0);
        dummy.position.set(x, y0 + (bodyH * ys) / 2, z);
        dummy.scale.set(size, ys * size, size);
        dummy.updateMatrix();
        b.setMatrixAt(idx, dummy.matrix);
        dummy.position.set(x, y0 + bodyH * ys + 0.12 * size, z);
        dummy.scale.set(size, size, size);
        dummy.updateMatrix();
        h.setMatrixAt(idx, dummy.matrix);
        if (dirty.current || moving) {
          const slot = Math.max(0, Math.round(i - e));
          const w = c.longestWaitMinutes * (1 - slot / nTotal);
          b.setColorAt(idx, tmpColor.copy(TONE_THREE[waitTone(w)]));
          colorsChanged = true;
        }
      }
    }
    b.instanceMatrix.needsUpdate = true;
    h.instanceMatrix.needsUpdate = true;
    if (colorsChanged && b.instanceColor) b.instanceColor.needsUpdate = true;
    dirty.current = false;
  });

  const meshProps = { frustumCulled: false } as const;
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
        {...meshProps}
      >
        <capsuleGeometry args={[0.17, 0.26, 4, 10]} />
        <meshStandardMaterial roughness={0.7} />
      </instancedMesh>
      <instancedMesh
        key={`ph${total}`}
        ref={(m) => {
          head.current = m;
          if (m) m.instanceMatrix.setUsage(DynamicDrawUsage);
        }}
        args={[undefined, undefined, total]}
        castShadow
        {...meshProps}
      >
        <sphereGeometry args={[0.12, 14, 10]} />
        <meshStandardMaterial color="#d9a47a" roughness={0.7} />
      </instancedMesh>
    </>
  );
}

/** Waiting benches (seat + backrest + legs) behind every queue row of every clinic, all instanced. */
function Benches({ hall }: { hall: Hall }) {
  const seat = useRef<InstancedMesh>(null);
  const back = useRef<InstancedMesh>(null);
  const legs = useRef<InstancedMesh>(null);
  const invalidate = useThree((s) => s.invalidate);
  const geo = useMemo(
    () => ({ seat: roundedBox(LANE_COLS * SLOT_DX, 0.06, 0.4, 0.025), back: roundedBox(LANE_COLS * SLOT_DX, 0.34, 0.05, 0.022) }),
    [],
  );
  const n = hall.cells.length * LANE_ROWS;
  useLayoutEffect(() => {
    const s = seat.current;
    const b = back.current;
    const l = legs.current;
    if (!s || !b || !l) return;
    let i = 0;
    for (const cell of hall.cells) {
      for (let r = 0; r < LANE_ROWS; r++) {
        const z = cell.cz + slotPos(r * LANE_COLS)[1] + BENCH_DZ;
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, 1, 1);
        dummy.position.set(cell.cx, SEAT_H - 0.03, z);
        dummy.updateMatrix();
        s.setMatrixAt(i, dummy.matrix);
        dummy.position.set(cell.cx, SEAT_H + 0.17, z + 0.2);
        dummy.updateMatrix();
        b.setMatrixAt(i, dummy.matrix);
        [-1, 1].forEach((side, k) => {
          dummy.position.set(cell.cx + side * (LANE_COLS * SLOT_DX * 0.5 - 0.15), (SEAT_H - 0.06) / 2, z);
          dummy.scale.set(0.05, SEAT_H - 0.06, 0.36);
          dummy.updateMatrix();
          l.setMatrixAt(i * 2 + k, dummy.matrix);
        });
        i++;
      }
    }
    for (const m of [s, b, l]) m.instanceMatrix.needsUpdate = true;
    invalidate();
  }, [hall, invalidate]);
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

/** A seated staff member (doctor / nurse) behind a desk facing +z; "writes" when active. */
function Person({ x, z, coat, active, seed, anim }: { x: number; z: number; coat: string; active: boolean; seed: number; anim: boolean }) {
  const root = useRef<Group>(null);
  const arm = useRef<Group>(null);
  useFrame(() => {
    if (!root.current || !arm.current) return;
    if (anim && active) {
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
      {/* Office chair */}
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
function Desk({ x, z, w, seats }: { x: number; z: number; w: number; seats: number[] }) {
  const top = useMemo(() => roundedBox(w, 0.06, 0.8, 0.03), [w]);
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, 0.76, 0]} geometry={top} castShadow receiveShadow>
        <meshStandardMaterial color="#d6b48a" roughness={0.55} />
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

/** Patient chair in front of a consultation desk. */
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

function ClinicRoom({ cell, anim }: { cell: Cell; anim: boolean }) {
  const portal = useContext(LabelPortal) ?? undefined;
  const c = cell.clinic;
  const roomZ = ROOM_BACK + ROOM_D / 2;
  const deskZ = ROOM_BACK + 1.6;
  const docs = Math.min(c.doctorsActive, 2);
  const over = Math.max(c.waitingNow - MAX_SHOWN, 0);
  const est = c.estimatedWaitMinutes;
  const seatXs = docs === 2 ? [-0.9, 0.9] : [0];
  return (
    <group position={[cell.cx, 0, cell.cz]}>
      <mesh position={[0, 0.02, 0]} receiveShadow>
        <boxGeometry args={[CELL_W - 0.6, 0.1, CELL_D - 0.6]} />
        <meshStandardMaterial color={FLOOR_COLOR[cell.tone]} map={edgeShadeTexture()} roughness={0.8} />
      </mesh>
      {/* Examination room: back wall + low side walls, open to the queue. */}
      <mesh position={[0, 1.1, ROOM_BACK + 0.1]} castShadow receiveShadow>
        <boxGeometry args={[ROOM_W, 2.2, 0.2]} />
        <meshStandardMaterial color="#f8fafc" roughness={0.85} />
      </mesh>
      <mesh position={[0, 2.22, ROOM_BACK + 0.1]}>
        <boxGeometry args={[ROOM_W + 0.02, 0.06, 0.24]} />
        <meshStandardMaterial color="#5eb3a8" roughness={0.6} />
      </mesh>
      {[-1, 1].map((s) => (
        <mesh key={s} position={[s * (ROOM_W / 2 - 0.1), 0.5, roomZ]} castShadow receiveShadow>
          <boxGeometry args={[0.2, 1, ROOM_D]} />
          <meshStandardMaterial color="#eef2f6" roughness={0.85} />
        </mesh>
      ))}
      <mesh position={[0, 0.09, roomZ]} receiveShadow>
        <boxGeometry args={[ROOM_W - 0.4, 0.04, ROOM_D - 0.2]} />
        <meshStandardMaterial color="#f5f7f9" map={edgeShadeTexture()} roughness={0.6} />
      </mesh>
      <mesh position={[0, 0.08, doorZ + 0.7 + ((LANE_ROWS - 1) * SLOT_DZ) / 2]} receiveShadow>
        <boxGeometry args={[LANE_COLS * SLOT_DX + 0.8, 0.03, LANE_ROWS * SLOT_DZ + 0.6]} />
        <meshStandardMaterial color="#f8fafc" roughness={0.7} />
      </mesh>
      <Desk x={0} z={deskZ} w={3} seats={docs === 0 ? [0] : seatXs} />
      {docs === 0
        ? null
        : seatXs.map((sx, k) => (
            <Person key={sx} x={sx} z={deskZ - 0.75} coat="#f8fafc" active anim={anim} seed={cell.cx + cell.cz + k * 2} />
          ))}
      <Chair x={0} z={deskZ + 0.95} />
      {/* Clinic pill: screen-aligned, never rotates. Always portal into the canvas box. */}
      <Html portal={portal} position={[0, 2.6, ROOM_BACK - 0.5]} center zIndexRange={[5, 0]} pointerEvents="none">
        <div className="max-w-[13rem] whitespace-nowrap rounded-md bg-white/95 px-2 py-1 text-center text-xs shadow">
          <div className="truncate font-semibold">{shortName(c.clinicName)}</div>
          <div className="mt-0.5 flex items-center justify-center gap-1">
            <span>
              รอ {fmtNum(c.waitingNow)} คน{over > 0 ? ` (+${fmtNum(over)})` : ""}
            </span>
            {est !== null ? (
              <span className={`rounded-full px-1.5 py-0.5 font-medium ${toneBadge[cell.tone]}`}>~{fmtNum(Math.round(est))} นาที</span>
            ) : (
              <span className={`rounded-full px-1.5 py-0.5 font-medium ${toneBadge[cell.tone]}`}>-</span>
            )}
          </div>
        </div>
      </Html>
    </group>
  );
}

function ScreeningDesk({ hall, anim }: { hall: Hall; anim: boolean }) {
  const portal = useContext(LabelPortal) ?? undefined;
  const nurses = [-3, 0, 3];
  return (
    <group position={[0, 0, hall.screenZ]}>
      <mesh position={[0, 0.02, 0]} receiveShadow>
        <boxGeometry args={[hall.width - 1, 0.1, SCREEN_D - 1]} />
        <meshStandardMaterial color="#a9dbd2" map={edgeShadeTexture()} roughness={0.9} />
      </mesh>
      <Desk x={0} z={0.2} w={Math.min(hall.width * 0.5, 12)} seats={nurses} />
      {nurses.map((x, i) => (
        <Person key={x} x={x} z={-0.55} coat="#0f766e" active anim={anim} seed={i * 1.9} />
      ))}
      {nurses.map((x) => (
        <Chair key={x} x={x + 0.2} z={1.05} />
      ))}
      <Html portal={portal} position={[0, 0.2, SCREEN_D / 2 - 0.4]} center zIndexRange={[5, 0]} pointerEvents="none">
        <div className="whitespace-nowrap rounded-md bg-brand-700 px-3 py-0.5 text-xs font-semibold text-white shadow">
          จุดคัดกรอง (พยาบาล)
        </div>
      </Html>
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

function Scene({ hall, anim, goal, quality }: { hall: Hall; anim: boolean; goal: Goal; quality: Quality }) {
  const { queues, total } = useMemo(() => buildQueues(hall), [hall]);
  const high = quality === "high";
  return (
    <>
      <SceneLights quality={quality} w={hall.width + 6} d={hall.depth + 6} />
      {high ? <RoomEnv intensity={0.35} /> : null}
      {high ? <DepthFog color={BG_COLOR} /> : null}
      <Ground w={hall.width + 6} d={hall.depth + 6} />
      {hall.cells.map((cell) => (
        <ClinicRoom key={cell.clinic.clinicCode} cell={cell} anim={anim} />
      ))}
      <Benches hall={hall} />
      <ScreeningDesk hall={hall} anim={anim} />
      {total > 0 ? <PatientMeshes queues={queues} total={total} anim={anim} /> : null}
      <Rig goal={goal} />
    </>
  );
}

function Legend() {
  const dot = "inline-block h-2.5 w-2.5 rounded-full";
  return (
    <div className="flex flex-wrap gap-3 text-xs text-slate-600">
      <span className="inline-flex items-center gap-1">
        <span className={`${dot} bg-emerald-500`} /> รอน้อยกว่า 30 นาที
      </span>
      <span className="inline-flex items-center gap-1">
        <span className={`${dot} bg-amber-500`} /> 30-60 นาที
      </span>
      <span className="inline-flex items-center gap-1">
        <span className={`${dot} bg-orange-500`} /> 60-120 นาที
      </span>
      <span className="inline-flex items-center gap-1">
        <span className={`${dot} bg-red-600`} /> มากกว่า 120 นาที
      </span>
      <span className="inline-flex items-center gap-1">
        <span className={`${dot} bg-slate-100 ring-1 ring-slate-400`} /> แพทย์
      </span>
      <span className="inline-flex items-center gap-1">
        <span className={`${dot} bg-teal-700`} /> พยาบาล
      </span>
      <span className="text-slate-500">ผู้ป่วยหน้าสุดของแถวรอนานที่สุด แสดงสูงสุด {MAX_SHOWN} คนต่อห้อง</span>
    </div>
  );
}

export default function OpdScene({ clinics }: { clinics: ClinicWait[] }) {
  const webgl = useSyncExternalStore(
    () => () => {},
    detectWebGL,
    () => null,
  );
  const [anim, setAnim] = useState(readAnimPref);
  const [quality, setQuality] = useState<Quality>(readQuality);
  const [visible, setVisible] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  const hall = useMemo(() => layoutHall(clinics), [clinics]);
  const glProps = useMemo(() => canvasProps(quality), [quality]);
  const [resetN, setResetN] = useState(0);
  const nav = useNavHold();
  useNavKeys(box, nav);
  // Opening view: the rows with patients today (closer, readable labels);
  // the whole hall when every row is busy. Zoom out / pan for the rest.
  const goal = useMemo<Goal>(() => {
    const key = `${hall.width}x${hall.depth}:${hall.activeRows}:${resetN}`;
    if (hall.activeRows > 0 && hall.activeRows < hall.rows) {
      const d = hall.activeRows * CELL_D;
      return { key, cx: 0, cz: -hall.depth / 2 + d / 2, w: hall.width, d, margin: 1 };
    }
    return { key, cx: 0, cz: hall.depth * 0.07, w: hall.width, d: hall.depth * 0.95, margin: 1 };
  }, [hall.width, hall.depth, hall.rows, hall.activeRows, resetN]);

  // Stop rendering while the canvas is scrolled out of view.
  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, [webgl]);

  if (webgl === null) return <div className="h-[420px]" />;
  if (!webgl) return <OpdGrid2D clinics={clinics} />;

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
        aria-label="ภาพ 3 มิติ ห้องตรวจผู้ป่วยนอก ใช้ลูกศรเพื่อเลื่อน"
        className="relative h-[520px] overflow-hidden rounded-md bg-brand-50 outline-none focus-visible:ring-2 focus-visible:ring-brand-400 lg:h-[680px]"
      >
        <Canvas
          key={quality}
          {...glProps}
          frameloop={anim && visible ? "always" : "demand"}
          camera={{ position: [0, 60, 50], fov: 45, far: 600 }}
        >
          <LabelPortal.Provider value={box as RefObject<HTMLElement>}>
            <Scene hall={hall} anim={anim} goal={goal} quality={quality} />
          </LabelPortal.Provider>
          <NavDriver nav={nav} w={hall.width} d={hall.depth} />
        </Canvas>
        <div className="absolute bottom-3 right-3 z-30">
          <NavPad nav={nav} onReset={() => setResetN((n) => n + 1)} />
        </div>
        <div className="absolute right-3 top-3 flex flex-col items-end gap-2">
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
