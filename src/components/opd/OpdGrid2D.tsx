import type { ClinicWait } from "@/lib/opd/types";
import { fmtNum, waitTone } from "../format";
import { Badge } from "../ui";

/** 2D fallback for the OPD hall when WebGL is unavailable. */
export function OpdGrid2D({ clinics }: { clinics: ClinicWait[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {clinics.map((c) => {
        const est = c.estimatedWaitMinutes;
        return (
          <div key={c.clinicCode} className="rounded-md border border-brand-100 bg-surface p-3">
            <div className="text-sm font-semibold">{c.clinicName}</div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
              <span>รอ {fmtNum(c.waitingNow)} คน</span>
              {est !== null ? <Badge tone={waitTone(est)}>~{fmtNum(Math.round(est))} นาที</Badge> : null}
              <span className="text-slate-500">แพทย์ {fmtNum(c.doctorsActive)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
