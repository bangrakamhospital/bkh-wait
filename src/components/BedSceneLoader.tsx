"use client";

import dynamic from "next/dynamic";
import type { DepartmentOccupancy, WardOccupancy } from "@/lib/beds/types";
import { LoadingState } from "./ui";

const BedScene = dynamic(() => import("./BedScene"), {
  ssr: false,
  loading: () => (
    <div className="h-[420px]">
      <LoadingState message="กำลังโหลดแบบจำลอง 3 มิติ..." />
    </div>
  ),
});

export function BedSceneLoader({
  wards,
  departments,
  focusDept,
}: {
  wards: WardOccupancy[];
  departments: DepartmentOccupancy[];
  /** Department code to fly the camera to ("" = overview). */
  focusDept: string;
}) {
  return <BedScene wards={wards} departments={departments} focusDept={focusDept} />;
}
