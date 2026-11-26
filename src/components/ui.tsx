import type { ReactNode } from "react";
import { AlertTriangle, Inbox, Loader2 } from "lucide-react";
import type { Tone } from "./format";

export const toneBadge: Record<Tone, string> = {
  green: "bg-emerald-100 text-emerald-800",
  amber: "bg-amber-100 text-amber-800",
  orange: "bg-orange-100 text-orange-800",
  red: "bg-red-100 text-red-800",
  slate: "bg-slate-200 text-slate-700",
  brand: "bg-brand-100 text-brand-800",
};

export const toneBar: Record<Tone, string> = {
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  orange: "bg-orange-500",
  red: "bg-red-500",
  slate: "bg-slate-400",
  brand: "bg-brand-500",
};

export const toneText: Record<Tone, string> = {
  green: "text-emerald-700",
  amber: "text-amber-700",
  orange: "text-orange-700",
  red: "text-red-700",
  slate: "text-slate-600",
  brand: "text-brand-700",
};

export const inputClass =
  "w-full rounded-md border border-slate-300 bg-surface px-2 py-1 text-xs focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500";

export const buttonClass =
  "inline-flex items-center justify-center gap-1 rounded-md bg-brand-600 px-3 py-1 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50";

export const buttonGhostClass =
  "inline-flex items-center justify-center gap-1 rounded-md border border-slate-300 bg-surface px-3 py-1 text-xs hover:bg-brand-50 disabled:opacity-50";

export function Card({
  title,
  action,
  children,
  className = "",
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-lg border border-brand-100 bg-surface shadow-sm ${className}`}>
      {title ? (
        <div className="flex items-center justify-between gap-2 border-b border-brand-100 px-4 py-2">
          <h2 className="text-base font-semibold">{title}</h2>
          {action}
        </div>
      ) : null}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function StatTile({
  label,
  value,
  unit,
  tone = "brand",
  hint,
}: {
  label: string;
  value: string;
  unit?: string;
  tone?: Tone;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-brand-100 bg-surface p-4 shadow-sm">
      <div className="text-sm text-slate-600">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${toneText[tone]}`}>
        {value}
        {unit ? <span className="ml-1 text-xs font-normal text-slate-500">{unit}</span> : null}
      </div>
      {hint ? <div className="mt-0.5 text-xs text-slate-500">{hint}</div> : null}
    </div>
  );
}

export function Badge({ tone = "slate", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${toneBadge[tone]}`}
    >
      {children}
    </span>
  );
}

/** pct is a data-driven width, capped visually at 100. */
export function ProgressBar({ pct, tone }: { pct: number; tone: Tone }) {
  const width = Math.min(Math.max(pct, 0), 100);
  return (
    <div
      className="h-2 w-full overflow-hidden rounded-full bg-slate-200"
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className={`h-full rounded-full ${toneBar[tone]}`} style={{ width: `${width}%` }} />
    </div>
  );
}

const spcltyColors = [
  "bg-brand-500",
  "bg-sky-500",
  "bg-violet-500",
  "bg-rose-400",
  "bg-lime-500",
  "bg-orange-400",
];

/** Stacked bar of occupied beds split by clinical department (spclty). */
export function SpcltyBar({
  items,
}: {
  items: { spcltyCode: string; spcltyName: string; occupied: number }[];
}) {
  const total = items.reduce((s, i) => s + i.occupied, 0);
  if (total === 0) return <div className="text-xs text-slate-500">ไม่มีผู้ป่วย</div>;
  return (
    <div className="space-y-1">
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-slate-200">
        {items.map((i, idx) => (
          <div
            key={i.spcltyCode}
            className={spcltyColors[idx % spcltyColors.length]}
            style={{ width: `${(i.occupied / total) * 100}%` }}
            title={`${i.spcltyName} ${i.occupied}`}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-600">
        {items.map((i, idx) => (
          <span key={i.spcltyCode} className="inline-flex items-center gap-1">
            <span className={`inline-block h-2 w-2 rounded-sm ${spcltyColors[idx % spcltyColors.length]}`} />
            {i.spcltyName} {i.occupied.toLocaleString("th-TH")}
          </span>
        ))}
      </div>
    </div>
  );
}

export function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-3 py-1 text-xs ${
        active
          ? "border-brand-600 bg-brand-600 text-white"
          : "border-slate-300 bg-surface hover:bg-brand-50"
      }`}
    >
      {children}
    </button>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-8 text-sm text-slate-500">
      <Inbox size={28} aria-hidden />
      {message}
    </div>
  );
}

export function ErrorState({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-red-200 bg-red-50 py-8 text-sm text-red-800">
      <AlertTriangle size={28} aria-hidden />
      <div>{message}</div>
      {action}
    </div>
  );
}

export function LoadingState({ message = "กำลังโหลดข้อมูล..." }: { message?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-8 text-sm text-slate-500">
      <Loader2 size={20} className="animate-spin" aria-hidden />
      {message}
    </div>
  );
}
