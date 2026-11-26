"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, useContext, type ComponentRef, type RefObject } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Html, OrbitControls } from "@react-three/drei";
import { Color, DynamicDrawUsage, MathUtils, Object3D } from "three";
import type { Group, InstancedMesh, PerspectiveCamera } from "three";
import type { ClinicWait } from "@/lib/opd/types";
import { fmtNum, waitTone, type Tone } from "../format";
import { LabelPortal, clamp01, detectWebGL, goalPose, hash01, now, readAnimPref, writeAnimPref, type Goal } from "../scene3d";
import { buttonGhostClass, toneBadge } from "../ui";
import { OpdGrid2D } from "./OpdGrid2D";

const COLS = 3;
const CELL_W = 15;
const CELL_D = 16;
const ROOM_W = 11;
const ROOM_D = 5.5;
const SCREEN_D = 5.5;
/** Patients drawn per clinic queue; the rest is shown as "+N" on the label. */
const MAX_SHOWN = 30;
const LANE_COLS = 3;
const SLOT_DX = 0.78;
const SLOT_DZ = 0.7;
const MOVE_SECONDS = 1.4;

const TONE_COLOR: Record<Tone, string> = {
  green: "#22c55e",
  amber: "#f59e0b",
  orange: "#f97316",
  red: "#dc2626",
  slate: "#94a3b8",
  brand: "#14b8a6",
};
const FLOOR_COLOR: Record<Tone, string> = {
  green: "#bbf7d0",
  amber: "#fde68a",
  orange: "#fed7aa",
  red: "#fecaca",
  slate: "#e2e8f0",
  brand: "#d5f2ed",
};
const TONE_THREE = Object.fromEntries(Object.entries(TONE_COLOR).map(([k, v]) => [k, new Color(v)])) as Record<Tone, Color>;

/** Tone of the clinic as a whole: expected wait, else today's average, else the longest current wait. */
function clinicMinutes(c: ClinicWait): number {
  return c.estimatedWaitMinutes ?? c.avgWaitMinutes ?? c.longestWaitMinutes;
}

type Cell = { clinic: ClinicWait; cx: number; cz: number; shown: number; tone: Tone };
type Hall = { cells: Cell[]; width: number; depth: number; screenZ: number };

function layoutHall(clinics: ClinicWait[]): Hall {
  const cols = Math.max(1, Math.min(COLS, clinics.length));
  const rows = Math.max(1, Math.ceil(clinics.length / COLS));
  const width = cols * CELL_W;
  const depth = rows * CELL_D + SCREEN_D;
  const cells = clinics.map((clinic, i) => ({
    clinic,
    cx: ((i % COLS) - (cols - 1) / 2) * CELL_W,
    cz: -depth / 2 + Math.floor(i / COLS) * CELL_D + CELL_D / 2,
    shown: Math.min(clinic.waitingNow, MAX_SHOWN),
    tone: waitTone(clinicMinutes(clinic)),
  }));
  return { cells, width, depth, screenZ: depth / 2 - SCREEN_D / 2 };
}

/** Local (to the cell) position of queue slot j; slot 0 is right at the room door. */
const doorZ = -CELL_D / 2 + ROOM_D + 0.9;
function slotPos(j: number): [number, number] {
  const row = Math.floor(j / LANE_COLS);
  return [((j % LANE_COLS) - (LANE_COLS - 1) / 2) * SLOT_DX, doorZ + 0.8 + row * SLOT_DZ];
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
        const z = q.cell.cz + az + (bz - az) * e;
        // Walker leaves at the head, newcomer arrives at the tail.
        let sc = 1;
        if (i === 0) sc = 1 - e;
        else if (i === n) sc = e;
        const hv = hash01(i + k + q.base * 0.37);
        const seated = hv < 0.3;
        const ys = seated ? 0.72 : 1;
        const size = (0.9 + hv * 0.25) * sc;
        if (anim && q.moving) x += Math.sin(t * 1.3 + i * 1.7) * 0.03;
        dummy.rotation.set(0, 0, 0);
        dummy.position.set(x, 0.28 * ys * size, z);
        dummy.scale.set(size, ys * size, size);
        dummy.updateMatrix();
        b.setMatrixAt(idx, dummy.matrix);
        dummy.position.set(x, (0.58 * ys + 0.16) * size, z);
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
        {...meshProps}
      >
        <cylinderGeometry args={[0.2, 0.24, 0.56, 8]} />
        <meshStandardMaterial />
      </instancedMesh>
      <instancedMesh
        key={`ph${total}`}
        ref={(m) => {
          head.current = m;
          if (m) m.instanceMatrix.setUsage(DynamicDrawUsage);
        }}
        args={[undefined, undefined, total]}
        {...meshProps}
      >
        <sphereGeometry args={[0.15, 8, 6]} />
        <meshStandardMaterial color="#d9a47a" />
      </instancedMesh>
    </>
  );
}

/** A standing staff member (doctor / nurse) behind a desk; bobs and "writes" when active. */
function Person({ x, z, coat, active, seed, anim }: { x: number; z: number; coat: string; active: boolean; seed: number; anim: boolean }) {
  const root = useRef<Group>(null);
  const arm = useRef<Group>(null);
  useFrame(() => {
    if (!root.current || !arm.current) return;
    if (anim && active) {
      const t = now() + seed;
      root.current.position.y = Math.abs(Math.sin(t * 2.2)) * 0.03;
      arm.current.rotation.x = -0.9 + Math.sin(t * 5) * 0.25;
    } else {
      root.current.position.y = 0;
      arm.current.rotation.x = -0.4;
    }
  });
  return (
    <group ref={root} position={[x, 0, z]}>
      <mesh position={[0, 0.5, 0]}>
        <cylinderGeometry args={[0.24, 0.3, 0.9, 8]} />
        <meshStandardMaterial color={coat} />
      </mesh>
      <mesh position={[0, 1.15, 0]}>
        <sphereGeometry args={[0.2, 8, 6]} />
        <meshStandardMaterial color="#d9a47a" />
      </mesh>
      <group ref={arm} position={[0.28, 0.85, 0]}>
        <mesh position={[0, -0.05, 0.25]}>
          <boxGeometry args={[0.1, 0.1, 0.5]} />
          <meshStandardMaterial color={coat} />
        </mesh>
      </group>
    </group>
  );
}

function Desk({ x, z, w }: { x: number; z: number; w: number }) {
  return (
    <mesh position={[x, 0.4, z]}>
      <boxGeometry args={[w, 0.8, 0.9]} />
      <meshStandardMaterial color="#a16207" />
    </mesh>
  );
}

function ClinicRoom({ cell, anim }: { cell: Cell; anim: boolean }) {
  const portal = useContext(LabelPortal) ?? undefined;
  const c = cell.clinic;
  const roomZ = -CELL_D / 2 + ROOM_D / 2;
  const deskZ = -CELL_D / 2 + 2.6;
  const docs = Math.min(c.doctorsActive, 2);
  const over = Math.max(c.waitingNow - MAX_SHOWN, 0);
  const est = c.estimatedWaitMinutes;
  return (
    <group position={[cell.cx, 0, cell.cz]}>
      <mesh position={[0, 0.02, 0]}>
        <boxGeometry args={[CELL_W - 1, 0.1, CELL_D - 1]} />
        <meshStandardMaterial color={FLOOR_COLOR[cell.tone]} />
      </mesh>
      {/* Examination room: back wall + low side walls, open to the queue. */}
      <mesh position={[0, 1.1, -CELL_D / 2 + 0.2]}>
        <boxGeometry args={[ROOM_W, 2.2, 0.2]} />
        <meshStandardMaterial color="#e2e8f0" />
      </mesh>
      {[-1, 1].map((s) => (
        <mesh key={s} position={[s * (ROOM_W / 2 - 0.1), 0.5, roomZ]}>
          <boxGeometry args={[0.2, 1, ROOM_D]} />
          <meshStandardMaterial color="#cbd5e1" />
        </mesh>
      ))}
      <mesh position={[0, 0.09, roomZ]}>
        <boxGeometry args={[ROOM_W - 0.4, 0.04, ROOM_D - 0.2]} />
        <meshStandardMaterial color="#f1f5f9" />
      </mesh>
      <Desk x={0} z={deskZ} w={3.2} />
      {docs === 0 ? null : docs === 1 ? (
        <Person x={0} z={deskZ - 0.9} coat="#f8fafc" active anim={anim} seed={cell.cx + cell.cz} />
      ) : (
        <>
          <Person x={-0.9} z={deskZ - 0.9} coat="#f8fafc" active anim={anim} seed={cell.cx} />
          <Person x={0.9} z={deskZ - 0.9} coat="#f8fafc" active anim={anim} seed={cell.cz + 2} />
        </>
      )}
      <mesh position={[0, 0.4, deskZ + 1.4]}>
        <boxGeometry args={[0.6, 0.8, 0.6]} />
        <meshStandardMaterial color="#64748b" />
      </mesh>
      {/* Clinic pill: screen-aligned, never rotates. Always portal into the canvas box. */}
      <Html portal={portal} position={[0, 0.2, CELL_D / 2 - 0.3]} center zIndexRange={[5, 0]} pointerEvents="none">
        <div className="translate-y-3 whitespace-nowrap rounded-md bg-white/95 px-2 py-1 text-center text-xs shadow">
          <div className="font-semibold">{c.clinicName}</div>
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
  return (
    <group position={[0, 0, hall.screenZ]}>
      <mesh position={[0, 0.02, 0]}>
        <boxGeometry args={[hall.width - 1, 0.1, SCREEN_D - 1]} />
        <meshStandardMaterial color="#99d5cd" />
      </mesh>
      <Desk x={0} z={-0.3} w={Math.min(hall.width * 0.5, 14)} />
      {[-3, 0, 3].map((x, i) => (
        <Person key={x} x={x} z={-1.2} coat="#0f766e" active anim={anim} seed={i * 1.9} />
      ))}
      <Html portal={portal} position={[0, 0.2, SCREEN_D / 2 - 0.6]} center zIndexRange={[5, 0]} pointerEvents="none">
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
  return <OrbitControls ref={controls} makeDefault maxPolarAngle={Math.PI / 2.3} minDistance={6} maxDistance={220} />;
}

function Scene({ hall, anim, goal }: { hall: Hall; anim: boolean; goal: Goal }) {
  const { queues, total } = useMemo(() => buildQueues(hall), [hall]);
  return (
    <>
      <ambientLight intensity={1.1} />
      <directionalLight position={[15, 30, 20]} intensity={1.6} />
      <mesh position={[0, -0.1, 0]}>
        <boxGeometry args={[hall.width + 6, 0.2, hall.depth + 6]} />
        <meshStandardMaterial color="#cbd5e1" />
      </mesh>
      {hall.cells.map((cell) => (
        <ClinicRoom key={cell.clinic.clinicCode} cell={cell} anim={anim} />
      ))}
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
  const [visible, setVisible] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  const hall = useMemo(() => layoutHall(clinics), [clinics]);
  const goal = useMemo<Goal>(
    () => ({ key: `${hall.width}x${hall.depth}`, cx: 0, cz: hall.depth * 0.04, w: hall.width, d: hall.depth, margin: 2.5 }),
    [hall.width, hall.depth],
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
  if (!webgl) return <OpdGrid2D clinics={clinics} />;

  const toggleAnim = () => {
    const next = !anim;
    setAnim(next);
    writeAnimPref(next);
  };

  return (
    <div className="space-y-2">
      <div ref={box} className="relative h-[520px] overflow-hidden rounded-md bg-brand-50 lg:h-[600px]">
        <Canvas
          frameloop={anim && visible ? "always" : "demand"}
          dpr={[1, 1.5]}
          camera={{ position: [0, 60, 50], fov: 45, far: 600 }}
        >
          <LabelPortal.Provider value={box as RefObject<HTMLElement>}>
            <Scene hall={hall} anim={anim} goal={goal} />
          </LabelPortal.Provider>
        </Canvas>
        <div className="absolute right-3 top-3 flex flex-col items-end gap-2">
          <button type="button" className={buttonGhostClass} aria-pressed={anim} onClick={toggleAnim}>
            ภาพเคลื่อนไหว {anim ? "เปิด" : "ปิด"}
          </button>
        </div>
      </div>
      <Legend />
    </div>
  );
}
