import { FLOW_COLOR, FLOW_DEFS } from "@/lib/opd/flow";
import type { ClinicWait, OpdFlow } from "@/lib/opd/types";
import { fmtNum, waitTone } from "../format";
import { Badge } from "../ui";

/** Waiting points shown as areas in the 3D scene (Admit / home / other are counters only). */
const WAIT_KEYS = new Set(["screening", "doctor", "after_doctor", "lab", "services", "pharmacy", "er"]);

/** 2D fallback for the OPD waiting-point scene when WebGL is unavailable: same areas and counts. */
export function OpdGrid2D({ flow, clinics }: { flow: OpdFlow | null; clinics: ClinicWait[] }) {
  const count = (key: string) => flow?.buckets.find((b) => b.key === key)?.count ?? 0;
  return (
    <div className="space-y-3">
      {flow ? (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
            {FLOW_DEFS.filter((d) => WAIT_KEYS.has(d.key)).map((d) => (
              <div key={d.key} className="rounded-md border-2 bg-surface p-2" style={{ borderColor: FLOW_COLOR[d.key].hex }}>
                <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-700">
                  <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: FLOW_COLOR[d.key].hex }} aria-hidden />
                  {d.label}
                </div>
                <div className="text-sm font-bold tabular-nums">รอ {fmtNum(count(d.key))} คน</div>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            {(["done", "admit", "other"] as const)
              .filter((k) => k !== "other" || count(k) > 0)
              .map((k) => (
                <span key={k} className="rounded-full px-2.5 py-0.5 font-semibold text-white" style={{ background: FLOW_COLOR[k].hex }}>
                  {FLOW_DEFS.find((d) => d.key === k)?.label} {fmtNum(count(k))}
                </span>
              ))}
          </div>
        </>
      ) : null}
      <div className="text-sm font-semibold text-slate-700">หน้าห้องตรวจ · รอพบแพทย์</div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {clinics.map((c) => {
          const est = c.estimatedDoctorWaitMinutes;
          return (
            <div key={c.clinicCode} className="rounded-md border border-brand-100 bg-surface p-3">
              <div className="text-sm font-semibold">{c.clinicName}</div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                <span>รอพบแพทย์ {fmtNum(c.waitingForDoctor)} คน</span>
                {est !== null ? <Badge tone={waitTone(est)}>~{fmtNum(Math.round(est))} นาที</Badge> : null}
                <span className="text-slate-500">แพทย์ {fmtNum(c.doctorsActive)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
