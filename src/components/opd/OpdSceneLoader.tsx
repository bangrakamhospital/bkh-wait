"use client";

import dynamic from "next/dynamic";
import type { ClinicWait, OpdFlow } from "@/lib/opd/types";
import { LoadingState } from "../ui";

const OpdScene = dynamic(() => import("./OpdScene"), {
  ssr: false,
  loading: () => (
    <div className="h-[420px]">
      <LoadingState message="กำลังโหลดแบบจำลอง 3 มิติ..." />
    </div>
  ),
});

export function OpdSceneLoader({ flow, clinics }: { flow: OpdFlow | null; clinics: ClinicWait[] }) {
  return <OpdScene flow={flow} clinics={clinics} />;
}
