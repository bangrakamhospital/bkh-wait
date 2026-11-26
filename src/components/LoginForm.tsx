"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { buttonClass, inputClass } from "./ui";

export function LoginForm() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "เข้าสู่ระบบไม่สำเร็จ");
        setSaving(false);
        return;
      }
      router.push("/refer");
      router.refresh();
    } catch {
      setError("ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้");
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <label className="block space-y-1">
        <span className="text-xs text-slate-600">ชื่อผู้ใช้</span>
        <input className={inputClass} value={username} autoComplete="username" required onChange={(e) => setUsername(e.target.value)} />
      </label>
      <label className="block space-y-1">
        <span className="text-xs text-slate-600">รหัสผ่าน</span>
        <input
          className={inputClass}
          type="password"
          value={password}
          autoComplete="current-password"
          required
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      {error ? <div className="rounded-md bg-red-50 p-2 text-xs text-red-800">{error}</div> : null}
      <button type="submit" className={`${buttonClass} w-full`} disabled={saving}>
        {saving ? "กำลังเข้าสู่ระบบ..." : "เข้าสู่ระบบ"}
      </button>
    </form>
  );
}
