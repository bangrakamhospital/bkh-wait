"use client";

import dynamic from "next/dynamic";
import type { ClinicWait } from "@/lib/opd/types";
import { LoadingState } from "../ui";

const OpdScene = dynamic(() => import("./OpdScene"), {
  ssr: false,
  loading: () => (
    <div className="h-[420px]">
      <LoadingState message="กำลังโหลดแบบจำลอง 3 มิติ..." />
    </div>
  ),
});

export function OpdSceneLoader({ clinics }: { clinics: ClinicWait[] }) {
  return <OpdScene clinics={clinics} />;
}
