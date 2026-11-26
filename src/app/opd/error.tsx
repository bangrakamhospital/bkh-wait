"use client";

import { ErrorState, buttonClass } from "@/components/ui";

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <ErrorState
      message="เกิดข้อผิดพลาดในการแสดงผล"
      action={
        <button type="button" className={buttonClass} onClick={reset}>
          ลองใหม่
        </button>
      }
    />
  );
}
