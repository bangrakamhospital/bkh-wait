"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { fmtDateTime } from "./format";
import { buttonGhostClass } from "./ui";

const INTERVAL_MS = 60_000;

/** Shows the data timestamp and re-renders the server page every 60 seconds. */
export function AutoRefresh({ asOf }: { asOf: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    const id = setInterval(() => startTransition(() => router.refresh()), INTERVAL_MS);
    return () => clearInterval(id);
  }, [paused, router]);

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-slate-600">ข้อมูล ณ {fmtDateTime(asOf)}</span>
      <button type="button" className={buttonGhostClass} disabled={pending} onClick={() => startTransition(() => router.refresh())}>
        <RefreshCw size={14} className={pending ? "animate-spin" : ""} aria-hidden /> รีเฟรช
      </button>
      <label className="inline-flex items-center gap-1">
        <input type="checkbox" checked={!paused} onChange={(e) => setPaused(!e.target.checked)} />
        รีเฟรชอัตโนมัติทุก 60 วินาที
      </label>
    </div>
  );
}
