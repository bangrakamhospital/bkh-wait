"use client";

import { useEffect, useRef, useState } from "react";
import type { OpdHourPoint } from "@/lib/opd/types";
import { fmtNum } from "../format";
import { Card, EmptyState } from "../ui";

const H = 224;
const PAD = { l: 40, r: 44, t: 16, b: 28 };
const TITLE = "ผู้ป่วยมาถึงและได้พบแพทย์รายชั่วโมง (วันนี้)";

const niceMax = (v: number) => {
  if (v <= 10) return 10;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  return Math.ceil(v / p) * p;
};

/** Hourly arrivals vs seen (bars) and average wait (line, right axis) for today. */
export function OpdHourlyChart({ points }: { points: OpdHourPoint[] }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const update = () => setWidth(Math.max(Math.floor(el.clientWidth), 360));
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [points.length]);
  const W = width;
  const active = points.filter((p) => p.arrived > 0 || p.seen > 0);
  if (active.length === 0) {
    return (
      <Card title={TITLE}>
        <EmptyState message="ยังไม่มีข้อมูลรายชั่วโมงของวันนี้" />
      </Card>
    );
  }
  const first = Math.max(Math.min(...active.map((p) => p.hour)), 0);
  const last = Math.min(Math.max(...active.map((p) => p.hour)), 23);
  const hours = Array.from({ length: last - first + 1 }, (_, i) => first + i);
  const byHour = new Map(points.map((p) => [p.hour, p]));
  const maxCount = niceMax(Math.max(...points.map((p) => Math.max(p.arrived, p.seen))));
  const maxWait = niceMax(Math.max(30, ...points.map((p) => p.avgWaitMinutes ?? 0)));
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const slot = iw / hours.length;
  const bw = Math.min(slot * 0.36, 22);
  const base = PAD.t + ih;
  const yC = (v: number) => base - (v / maxCount) * ih;
  const yW = (v: number) => base - (v / maxWait) * ih;
  const xC = (i: number) => PAD.l + slot * i + slot / 2;

  const linePts = hours
    .map((h, i) => ({ i, v: byHour.get(h)?.avgWaitMinutes ?? null }))
    .filter((p): p is { i: number; v: number } => p.v !== null);
  const path = linePts.map((p, k) => `${k === 0 ? "M" : "L"}${xC(p.i)},${yW(p.v)}`).join(" ");

  return (
    <Card title={TITLE}>
      <div ref={wrap} className="w-full">
        <svg
          width={W}
          height={H}
          className="block h-56"
          role="img"
          aria-label="กราฟแท่งผู้ป่วยมาถึงและได้พบแพทย์รายชั่วโมง พร้อมเส้นเวลารอเฉลี่ย"
        >
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <g key={f}>
              <line x1={PAD.l} x2={W - PAD.r} y1={base - ih * f} y2={base - ih * f} className="stroke-slate-200" />
              <text x={PAD.l - 6} y={base - ih * f + 4} textAnchor="end" className="fill-slate-500 text-xs">
                {fmtNum(Math.round(maxCount * f))}
              </text>
              <text x={W - PAD.r + 6} y={base - ih * f + 4} className="fill-amber-700 text-xs">
                {fmtNum(Math.round(maxWait * f))}
              </text>
            </g>
          ))}
          {hours.map((h, i) => {
            const p = byHour.get(h);
            const arrived = p?.arrived ?? 0;
            const seen = p?.seen ?? 0;
            return (
              <g key={h}>
                <rect x={xC(i) - bw - 1} y={yC(arrived)} width={bw} height={base - yC(arrived)} rx={2} className="fill-brand-500">
                  <title>{`${h}:00 มาถึง ${arrived} คน`}</title>
                </rect>
                <rect x={xC(i) + 1} y={yC(seen)} width={bw} height={base - yC(seen)} rx={2} className="fill-emerald-500">
                  <title>{`${h}:00 ได้พบแพทย์ ${seen} คน`}</title>
                </rect>
                <text x={xC(i)} y={H - 8} textAnchor="middle" className="fill-slate-600 text-xs">
                  {String(h).padStart(2, "0")}
                </text>
              </g>
            );
          })}
          {path ? <path d={path} fill="none" strokeWidth={2} className="stroke-amber-500" /> : null}
          {linePts.map((p) => (
            <circle key={p.i} cx={xC(p.i)} cy={yW(p.v)} r={3.5} className="fill-amber-500">
              <title>{`${hours[p.i]}:00 รอเฉลี่ย ${Math.round(p.v)} นาที`}</title>
            </circle>
          ))}
        </svg>
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-600">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-brand-500" /> มาถึง (คน)
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-emerald-500" /> ได้พบแพทย์ (คน)
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-0.5 w-4 bg-amber-500" /> รอเฉลี่ย (นาที, แกนขวา)
        </span>
      </div>
    </Card>
  );
}
