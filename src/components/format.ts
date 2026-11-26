const numberFmt = new Intl.NumberFormat("th-TH");
const pctFmt = new Intl.NumberFormat("th-TH", { maximumFractionDigits: 1 });
const dateTimeFmt = new Intl.DateTimeFormat("th-TH", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Bangkok",
});

export const fmtNum = (n: number): string => numberFmt.format(n);
export const fmtPct = (n: number): string => `${pctFmt.format(n)}%`;
export const fmtDateTime = (iso: string): string => dateTimeFmt.format(new Date(iso));

/** 135 -> "2 ชม. 15 นาที" */
export function fmtWait(minutes: number): string {
  const m = Math.max(Math.round(minutes), 0);
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${fmtNum(r)} นาที`;
  return r === 0 ? `${fmtNum(h)} ชม.` : `${fmtNum(h)} ชม. ${fmtNum(r)} นาที`;
}

export type Tone = "green" | "amber" | "orange" | "red" | "slate" | "brand";

/** <80% green, 80-<100% amber, >=100% red */
export function occupancyTone(pct: number): Tone {
  if (pct >= 100) return "red";
  if (pct >= 80) return "amber";
  return "green";
}

/** OPD wait minutes: <30 green, 30-<60 amber, 60-120 orange, >120 red */
export function waitTone(minutes: number): Tone {
  if (minutes > 120) return "red";
  if (minutes >= 60) return "orange";
  if (minutes >= 30) return "amber";
  return "green";
}
