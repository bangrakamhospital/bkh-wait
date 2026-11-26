import type { BedBoard } from "@/lib/beds/types";
import { AutoRefresh } from "@/components/AutoRefresh";
import { DashboardView } from "@/components/DashboardView";
import { getBedBoard } from "@/lib/beds/board";
import { ErrorState } from "@/components/ui";

export const dynamic = "force-dynamic";

async function loadBoard(): Promise<BedBoard | null> {
  try {
    return await getBedBoard();
  } catch {
    return null;
  }
}

export default async function DashboardPage() {
  const board = await loadBoard();
  if (!board) {
    return <ErrorState message="ไม่สามารถโหลดข้อมูลเตียงได้ กรุณาลองใหม่อีกครั้ง" />;
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-base font-semibold">สถานะเตียงรายแผนกและหอผู้ป่วย</h1>
        <AutoRefresh asOf={board.asOf} />
      </div>
      <DashboardView board={board} />
    </>
  );
}
