"use client";

import { useState } from "react";
import type { WardOccupancy } from "@/lib/beds/types";
import { bedsInUse } from "./beds";
import { fmtNum, occupancyTone } from "./format";
import { toneBadge } from "./ui";
import { WardDetail } from "./WardDetail";

/** 2D fallback used when WebGL is unavailable. */
export function BedGrid2D({ wards }: { wards: WardOccupancy[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const current = wards.find((w) => w.wardCode === selected) ?? null;

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {wards.map((w) => {
          const tone = occupancyTone(w.occupancyPct);
          const used = bedsInUse(w);
          const total = Math.max(w.beds, used);
          return (
            <button
              key={w.wardCode}
              type="button"
              onClick={() => setSelected(w.wardCode)}
              className={`rounded-md border p-2 text-left hover:border-brand-500 ${
                selected === w.wardCode ? "border-brand-600" : "border-slate-200"
              }`}
            >
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium">{w.wardName}</span>
                <span className={`rounded-full px-2 ${toneBadge[tone]}`}>
                  ว่าง {fmtNum(w.available)}/{fmtNum(w.beds)}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-0.5">
                {Array.from({ length: total }, (_, i) => (
                  <span
                    key={i}
                    className={`h-2 w-2 rounded-sm ${
                      i >= w.beds ? "bg-red-900" : i < used ? "bg-amber-500" : "bg-emerald-500"
                    }`}
                  />
                ))}
              </div>
            </button>
          );
        })}
      </div>
      <WardDetail ward={current} />
    </div>
  );
}
