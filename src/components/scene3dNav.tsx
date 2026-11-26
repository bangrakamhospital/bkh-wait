"use client";

// Free navigation for the 3D scenes: map-style mouse/touch (drag = move
// across the floor, right-drag = rotate, wheel/pinch = zoom), an on-screen
// pad (move / rotate / zoom, press and hold) and arrow keys on the focused
// scene. Shared by BedScene and OpdScene.

import { useEffect, useMemo, useRef, type ComponentRef, type MutableRefObject, type RefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import type { OrbitControls } from "@react-three/drei";
import { MOUSE, TOUCH, Vector3 } from "three";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, House, Minus, Plus, RotateCcw, RotateCw } from "lucide-react";

/** OrbitControls props for map-style navigation (spread onto <OrbitControls>). */
export const NAV_CONTROL_PROPS = {
  screenSpacePanning: false,
  mouseButtons: { LEFT: MOUSE.PAN, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.ROTATE },
  touches: { ONE: TOUCH.PAN, TWO: TOUCH.DOLLY_ROTATE },
  panSpeed: 1.1,
} as const;

/** Held direction from the pad or keyboard; each axis -1, 0 or 1. */
export type NavHold = { x: number; z: number; rot: number; zoom: number };
export type NavHoldRef = MutableRefObject<NavHold>;
/** Navigation state shared by the pad, the keyboard hook and NavDriver. */
export type Nav = {
  hold: NavHoldRef;
  press: (dir: Partial<NavHold>) => void;
  release: (dir: Partial<NavHold>) => void;
  clear: () => void;
};

export function useNavHold(): Nav {
  const hold = useRef<NavHold>({ x: 0, z: 0, rot: 0, zoom: 0 });
  return useMemo<Nav>(
    () => ({
      hold,
      press: (dir) => Object.assign(hold.current, dir),
      release: (dir) => {
        for (const axis of Object.keys(dir) as (keyof NavHold)[]) hold.current[axis] = 0;
      },
      clear: () => Object.assign(hold.current, { x: 0, z: 0, rot: 0, zoom: 0 }),
    }),
    [],
  );
}

type Controls = ComponentRef<typeof OrbitControls>;

const fwd = new Vector3();
const right = new Vector3();
const move = new Vector3();
const offset = new Vector3();
const UP = new Vector3(0, 1, 0);

/**
 * Inside <Canvas>: applies the held pad/keyboard direction to the default
 * controls and keeps the look-at point over the floor (w x d around 0,0
 * plus a margin) so the scene cannot be lost off screen.
 */
export function NavDriver({ nav, w, d }: { nav: Nav; w: number; d: number }) {
  const controls = useThree((s) => s.controls) as Controls | null;
  const camera = useThree((s) => s.camera);
  const invalidate = useThree((s) => s.invalidate);
  const active = useRef(false);

  useFrame((_, dtRaw) => {
    const c = controls;
    if (!c) return;
    const dt = Math.min(dtRaw, 0.1);
    const h = nav.hold.current;
    const moving = h.x !== 0 || h.z !== 0 || h.rot !== 0 || h.zoom !== 0;
    if (moving !== active.current) {
      active.current = moving;
      // Lets the camera rig cancel its flight / idle rotation like a mouse drag.
      c.dispatchEvent({ type: moving ? "start" : "end" } as Parameters<Controls["dispatchEvent"]>[0]);
    }
    if (moving) {
      const dist = camera.position.distanceTo(c.target);
      if (h.x !== 0 || h.z !== 0) {
        fwd.subVectors(c.target, camera.position).setY(0);
        if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
        fwd.normalize();
        right.crossVectors(fwd, UP).normalize();
        const step = dist * 0.9 * dt;
        move.copy(right).multiplyScalar(h.x * step).addScaledVector(fwd, h.z * step);
        camera.position.add(move);
        c.target.add(move);
      }
      if (h.rot !== 0) {
        offset.subVectors(camera.position, c.target).applyAxisAngle(UP, h.rot * 1.2 * dt);
        camera.position.copy(c.target).add(offset);
      }
      if (h.zoom !== 0) {
        offset.subVectors(camera.position, c.target);
        const len = Math.min(Math.max(offset.length() * Math.exp(-h.zoom * 1.3 * dt), c.minDistance), c.maxDistance);
        offset.setLength(len);
        camera.position.copy(c.target).add(offset);
      }
    }
    // Keep the look-at point over the floor.
    const hx = w / 2 + 4;
    const hz = d / 2 + 4;
    const tx = Math.min(Math.max(c.target.x, -hx), hx);
    const tz = Math.min(Math.max(c.target.z, -hz), hz);
    if (tx !== c.target.x || tz !== c.target.z) {
      move.set(tx - c.target.x, 0, tz - c.target.z);
      c.target.add(move);
      camera.position.add(move);
    }
    if (moving) {
      c.update();
      invalidate();
    }
  });
  return null;
}

const KEYS: Record<string, Partial<NavHold>> = {
  ArrowLeft: { x: -1 },
  ArrowRight: { x: 1 },
  ArrowUp: { z: 1 },
  ArrowDown: { z: -1 },
  "+": { zoom: 1 },
  "=": { zoom: 1 },
  "-": { zoom: -1 },
};

/** Arrow keys (move) and +/- (zoom) while the scene box has focus. */
export function useNavKeys(box: RefObject<HTMLElement | null>, nav: Nav) {
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const down = (e: KeyboardEvent) => {
      const k = KEYS[e.key];
      if (!k || e.target !== el) return;
      e.preventDefault();
      nav.press(k);
    };
    const up = (e: KeyboardEvent) => {
      const k = KEYS[e.key];
      if (k) nav.release(k);
    };
    const blur = nav.clear;
    el.addEventListener("keydown", down);
    el.addEventListener("keyup", up);
    el.addEventListener("blur", blur);
    return () => {
      el.removeEventListener("keydown", down);
      el.removeEventListener("keyup", up);
      el.removeEventListener("blur", blur);
    };
  });
}

const padBtn =
  "flex h-8 w-8 items-center justify-center rounded-md border border-slate-300 bg-white/90 text-slate-700 shadow-sm hover:bg-brand-50 active:bg-brand-100 touch-none select-none";

function HoldButton({ nav, dir, label, children }: { nav: Nav; dir: Partial<NavHold>; label: string; children: React.ReactNode }) {
  const stop = () => nav.release(dir);
  return (
    <button
      type="button"
      className={padBtn}
      aria-label={label}
      title={label}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        nav.press(dir);
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </button>
  );
}

/** On-screen pad: move (arrows), rotate, zoom (press and hold), reset view. */
export function NavPad({ nav, onReset }: { nav: Nav; onReset: () => void }) {
  const icon = "h-4 w-4";
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-1">
        <HoldButton nav={nav} dir={{ rot: -1 }} label="หมุนซ้าย">
          <RotateCcw className={icon} />
        </HoldButton>
        <HoldButton nav={nav} dir={{ rot: 1 }} label="หมุนขวา">
          <RotateCw className={icon} />
        </HoldButton>
        <HoldButton nav={nav} dir={{ zoom: 1 }} label="ซูมเข้า">
          <Plus className={icon} />
        </HoldButton>
        <HoldButton nav={nav} dir={{ zoom: -1 }} label="ซูมออก">
          <Minus className={icon} />
        </HoldButton>
      </div>
      <div className="grid grid-cols-3 gap-1">
        <span />
        <HoldButton nav={nav} dir={{ z: 1 }} label="เลื่อนขึ้น">
          <ArrowUp className={icon} />
        </HoldButton>
        <span />
        <HoldButton nav={nav} dir={{ x: -1 }} label="เลื่อนซ้าย">
          <ArrowLeft className={icon} />
        </HoldButton>
        <button type="button" className={padBtn} aria-label="กลับมุมมองเริ่มต้น" title="กลับมุมมองเริ่มต้น" onClick={onReset}>
          <House className={icon} />
        </button>
        <HoldButton nav={nav} dir={{ x: 1 }} label="เลื่อนขวา">
          <ArrowRight className={icon} />
        </HoldButton>
        <span />
        <HoldButton nav={nav} dir={{ z: -1 }} label="เลื่อนลง">
          <ArrowDown className={icon} />
        </HoldButton>
        <span />
      </div>
      <p className="rounded bg-white/80 px-1.5 py-0.5 text-xs text-slate-600">
        ลากเมาส์ = เลื่อน · คลิกขวาลาก = หมุน · ล้อเมาส์ = ซูม
      </p>
    </div>
  );
}
