"use client";

import { createContext, type RefObject } from "react";
import { Vector3 } from "three";

/** Helpers shared by the 3D scenes (bed board, OPD hall). */

export const ANIM_KEY = "bedSceneAnimation";

export const hash01 = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};
export const now = () => performance.now() / 1000;
export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

let webglSupport: boolean | null = null;

/**
 * WebGL available? Probed once per page and cached: this is a
 * useSyncExternalStore snapshot (read on every render), and each probe would
 * otherwise create a new WebGL context until the browser starts dropping the
 * scene’s own context ("Too many active WebGL contexts").
 */
export function detectWebGL(): boolean {
  if (webglSupport !== null) return webglSupport;
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    webglSupport = Boolean(gl);
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    webglSupport = false;
  }
  return webglSupport;
}

/** Animation preference: stored choice, else the OS reduced-motion setting. */
export function readAnimPref(): boolean {
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

export function writeAnimPref(on: boolean): void {
  try {
    localStorage.setItem(ANIM_KEY, on ? "on" : "off");
  } catch {
    // ignore storage failures
  }
}

/**
 * DOM container for drei <Html> labels. Without an explicit portal the very
 * first <Html> mounted in the scene never attaches to the page.
 */
export const LabelPortal = createContext<RefObject<HTMLElement> | null>(null);

/** What the camera should frame: a box on the floor plus a margin (room for labels). */
export type Goal = { key: string; cx: number; cz: number; w: number; d: number; margin: number };

export const VIEW_ELEV = Math.atan2(0.9, 0.8);

/** Camera position that fits the goal box into the current viewport aspect, with perspective slack. */
export function goalPose(g: Goal, fov: number, aspect: number): Vector3 {
  const v = (fov * Math.PI) / 180;
  const h = 2 * Math.atan(Math.tan(v / 2) * aspect);
  const halfW = g.w / 2 + g.margin;
  const halfD = (g.d * Math.sin(VIEW_ELEV)) / 2 + g.margin;
  const dist = Math.max(12, Math.max(halfW / Math.tan(h / 2), halfD / Math.tan(v / 2)) * 1.2);
  return new Vector3(g.cx, dist * Math.sin(VIEW_ELEV), g.cz + dist * Math.cos(VIEW_ELEV));
}
