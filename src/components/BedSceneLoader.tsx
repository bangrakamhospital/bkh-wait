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
}: {
  wards: WardOccupancy[];
  departments: DepartmentOccupancy[];
}) {
  return <BedScene wards={wards} departments={departments} />;
}
