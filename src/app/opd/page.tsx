import type { OpdBoard } from "@/lib/opd/types";
import { AutoRefresh } from "@/components/AutoRefresh";
import { getOpdBoard } from "@/lib/opd/board";
import { OpdView } from "@/components/opd/OpdView";
import { ErrorState } from "@/components/ui";

export const dynamic = "force-dynamic";

async function loadBoard(): Promise<OpdBoard | null> {
  try {
    return await getOpdBoard();
  } catch {
    return null;
  }
}

export default async function OpdPage() {
  const board = await loadBoard();
  if (!board) {
    return <ErrorState message="ไม่สามารถโหลดข้อมูลการรอพบแพทย์ได้ กรุณาลองใหม่อีกครั้ง" />;
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-base font-semibold">
          การรอคอยการพบแพทย์แต่ละแผนก (ผู้ป่วยนอก)
          <span className="ml-2 text-xs font-normal text-slate-500">
            วันที่ {new Date(`${board.date}T00:00:00+07:00`).toLocaleDateString("th-TH", { dateStyle: "medium", timeZone: "Asia/Bangkok" })}
          </span>
        </h1>
        <AutoRefresh asOf={board.asOf} stale={board.stale} />
      </div>
      <OpdView board={board} />
    </>
  );
}
