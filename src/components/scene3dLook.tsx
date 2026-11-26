"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import {
  ACESFilmicToneMapping,
  CanvasTexture,
  Fog,
  PCFShadowMap,
  PMREMGenerator,
  RepeatWrapping,
  SRGBColorSpace,
  Vector3,
} from "three";
import type { DirectionalLight } from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { buttonGhostClass } from "./ui";

/** Look & feel shared by the 3D scenes: quality preference, lights, environment, fog, textures. */

export type Quality = "high" | "low";
const QUALITY_KEY = "sceneQuality";

/** Old hospital PCs (<= 4 cores or <= 4 GB) start in the light mode. */
export function autoQuality(): Quality {
  try {
    const nav = navigator as Navigator & { deviceMemory?: number };
    if ((nav.hardwareConcurrency ?? 8) <= 4) return "low";
    if (nav.deviceMemory !== undefined && nav.deviceMemory <= 4) return "low";
  } catch {
    // navigator unavailable: assume a capable machine
  }
  return "high";
}

export function readQuality(): Quality {
  try {
    const v = localStorage.getItem(QUALITY_KEY);
    if (v === "high" || v === "low") return v;
  } catch {
    // storage unavailable: fall through to auto-detection
  }
  return autoQuality();
}

export function writeQuality(q: Quality): void {
  try {
    localStorage.setItem(QUALITY_KEY, q);
  } catch {
    // ignore storage failures
  }
}

/** Canvas props per quality. The canvas is keyed on quality, so these apply on a fresh renderer. */
export function canvasProps(q: Quality) {
  return {
    dpr: (q === "high" ? [1, 1.5] : 1) as number | [number, number],
    shadows: q === "high" ? { enabled: true, type: PCFShadowMap } : false,
    gl: {
      antialias: true,
      powerPreference: "high-performance" as const,
      toneMapping: ACESFilmicToneMapping,
      toneMappingExposure: 0.95,
      outputColorSpace: SRGBColorSpace,
    },
  };
}

export function QualityToggle({ quality, onChange }: { quality: Quality; onChange: (q: Quality) => void }) {
  return (
    <button
      type="button"
      className={buttonGhostClass}
      aria-pressed={quality === "high"}
      title="ปกติ: ปิดเงาและแสงสะท้อน เหมาะกับเครื่องรุ่นเก่า"
      onClick={() => {
        const next = quality === "high" ? "low" : "high";
        writeQuality(next);
        onChange(next);
      }}
    >
      คุณภาพภาพ {quality === "high" ? "สูง" : "ปกติ"}
    </button>
  );
}

/**
 * Hemisphere + ambient fill and one directional "sun" whose orthographic
 * shadow camera tightly wraps the scene bounds (w x d around cx/cz).
 */
export function SceneLights({ quality, w, d, cx = 0, cz = 0 }: { quality: Quality; w: number; d: number; cx?: number; cz?: number }) {
  const high = quality === "high";
  const sun = useRef<DirectionalLight>(null);
  const invalidate = useThree((s) => s.invalidate);
  const r = Math.hypot(w, d) / 2 + 2;
  const dir = new Vector3(0.45, 1, 0.55).normalize().multiplyScalar(r + 30);

  useLayoutEffect(() => {
    const l = sun.current;
    if (!l) return;
    l.target.position.set(cx, 0, cz);
    l.target.updateMatrixWorld();
    const cam = l.shadow.camera;
    cam.left = -r;
    cam.right = r;
    cam.top = r;
    cam.bottom = -r;
    cam.near = 1;
    cam.far = r * 2 + 40;
    cam.updateProjectionMatrix();
    l.shadow.needsUpdate = true;
    invalidate();
  }, [r, cx, cz, invalidate]);

  return (
    <>
      <hemisphereLight args={["#ffffff", "#9fb7b2", high ? 0.75 : 1.25]} />
      <ambientLight intensity={high ? 0.25 : 0.55} />
      <directionalLight
        ref={sun}
        position={[cx + dir.x, dir.y, cz + dir.z]}
        intensity={high ? 2.3 : 1.7}
        color="#fff8ee"
        castShadow={high}
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0005}
        shadow-normalBias={0.03}
        shadow-radius={3}
      />
    </>
  );
}

/** Soft image-based reflections from three's procedural RoomEnvironment (no network fetch). */
export function RoomEnv({ intensity = 0.4 }: { intensity?: number }) {
  const get = useThree((s) => s.get);
  useEffect(() => {
    const { gl, scene, invalidate } = get();
    const pm = new PMREMGenerator(gl);
    const room = new RoomEnvironment();
    const rt = pm.fromScene(room, 0.04);
    room.dispose();
    pm.dispose();
    scene.environment = rt.texture;
    scene.environmentIntensity = intensity;
    invalidate();
    return () => {
      scene.environment = null;
      rt.dispose();
    };
  }, [get, intensity]);
  return null;
}

/** Light distance fog that follows the camera zoom, fading the far side into the page colour. */
export function DepthFog({ color }: { color: string }) {
  const fog = useRef<Fog>(null);
  useFrame(({ camera, controls }) => {
    const f = fog.current;
    if (!f) return;
    const target = (controls as { target?: Vector3 } | null)?.target;
    const dist = target ? camera.position.distanceTo(target) : camera.position.length();
    f.near = dist * 0.95;
    f.far = dist * 3.2;
  });
  return <fog ref={fog} attach="fog" args={[color, 60, 240]} />;
}

function canvas2d(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  return [c, c.getContext("2d") as CanvasRenderingContext2D];
}

/** Floor tiles: subtle grout lines and slight per-tile variation (generated, no image files). */
export function tileTexture(base: string, grout: string, repeatX: number, repeatY: number): CanvasTexture {
  const size = 256;
  const n = 4;
  const [c, g] = canvas2d(size);
  const step = size / n;
  g.fillStyle = base;
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const v = ((i * 7 + j * 13) % 5) / 5;
      g.fillStyle = `rgba(255,255,255,${0.05 + v * 0.06})`;
      g.fillRect(i * step + 2, j * step + 2, step - 4, step - 4);
    }
  g.strokeStyle = grout;
  g.lineWidth = 2;
  for (let i = 0; i <= n; i++) {
    g.beginPath();
    g.moveTo(i * step, 0);
    g.lineTo(i * step, size);
    g.moveTo(0, i * step);
    g.lineTo(size, i * step);
    g.stroke();
  }
  const t = new CanvasTexture(c);
  t.wrapS = RepeatWrapping;
  t.wrapT = RepeatWrapping;
  t.repeat.set(repeatX, repeatY);
  t.anisotropy = 4;
  t.colorSpace = SRGBColorSpace;
  return t;
}

let edgeShade: CanvasTexture | null = null;

/** White centre with darker edges: a baked ambient-occlusion look for room/zone floors (multiplies the colour). */
export function edgeShadeTexture(): CanvasTexture {
  if (edgeShade) return edgeShade;
  const size = 128;
  const [c, g] = canvas2d(size);
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, size, size);
  const band = size * 0.12;
  const sides: [number, number, number, number, number, number, number, number][] = [
    [0, 0, 0, band, 0, 0, size, band],
    [0, size, 0, size - band, 0, size - band, size, band],
    [0, 0, band, 0, 0, 0, band, size],
    [size, 0, size - band, 0, size - band, 0, band, size],
  ];
  for (const [x0, y0, x1, y1, rx, ry, rw, rh] of sides) {
    const grad = g.createLinearGradient(x0, y0, x1, y1);
    grad.addColorStop(0, "rgba(40,60,60,0.30)");
    grad.addColorStop(1, "rgba(40,60,60,0)");
    g.fillStyle = grad;
    g.fillRect(rx, ry, rw, rh);
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  edgeShade = t;
  return t;
}

/** Rounded box geometry (three/examples), for smooth furniture and figures. */
export function roundedBox(w: number, h: number, d: number, radius: number, segments = 2): RoundedBoxGeometry {
  return new RoundedBoxGeometry(w, h, d, segments, Math.min(radius, w / 2, h / 2, d / 2) * 0.999);
}
