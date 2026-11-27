"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { signIn, signOut } from "next-auth/react";
import { AlertTriangle, ArrowLeft, CheckCircle2, KeyRound, Loader2, LogIn, LogOut, UserCog } from "lucide-react";

import { ACCESS_CODE_INPUT_MAX } from "@/lib/access-codes/types";
import { AUTH_DISABLED_MESSAGE, loginErrorMessage } from "@/lib/auth/messages";
import { ROLE_LABEL, type SessionInfo } from "@/lib/auth/roles";
import { ACCESS_CODE_PROVIDER_ID, LOCAL_PROVIDER_ID, SSO_PROVIDER_ID } from "@/lib/auth/sso-id";
import { buttonClass, buttonGhostClass, Card, inputClass } from "../ui";

export interface LoginMethods {
  configured: boolean;
  /** AUTH_PLKHEALTH_* complete: show the Provider ID button. */
  sso: boolean;
  /** Access codes usable (secret + PostgreSQL). */
  code: boolean;
  /** WAIT_USERS has entries: offer the collapsed backup account form. */
  local: boolean;
}

const iconCls = "h-4 w-4 shrink-0";

function ErrorBox({ message }: { message: string }) {
  return (
    <p role="alert" className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
      <AlertTriangle aria-hidden className={`${iconCls} mt-0.5`} />
      {message}
    </p>
  );
}

/**
 * Sign-in like bkh-kpi: Provider ID (SSO) first, then the access code for
 * outsiders, then the WAIT_USERS backup account (collapsed). Credentials
 * go through Auth.js (CSRF token flow of next-auth/react signIn).
 */
export function LoginPanel({
  next,
  current,
  error,
  methods,
}: {
  next: string;
  current: SessionInfo | null;
  error: string | null;
  methods: LoginMethods;
}) {
  const [message, setMessage] = useState<string | null>(error);
  const [busy, setBusy] = useState<null | "sso" | "code" | "local" | "out">(null);
  const [code, setCode] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  async function credentials(provider: "code" | "local", data: Record<string, string>) {
    setBusy(provider);
    setMessage(null);
    try {
      const res = await signIn(provider === "code" ? ACCESS_CODE_PROVIDER_ID : LOCAL_PROVIDER_ID, {
        ...data,
        redirect: false,
        redirectTo: next,
      });
      if (!res || res.error || !res.ok) {
        setMessage(loginErrorMessage(res?.error ?? "CredentialsSignin", res?.code));
        setBusy(null);
        return;
      }
      // Full navigation: every server component and the header re-read the session.
      window.location.assign(next);
    } catch {
      setMessage(loginErrorMessage("CredentialsSignin", "provider_unavailable"));
      setBusy(null);
    }
  }

  if (current) {
    return (
      <Card title="เข้าสู่ระบบ">
        <div className="flex flex-col items-center gap-3 text-center">
          <CheckCircle2 aria-hidden className="h-8 w-8 text-emerald-700" />
          <p className="text-sm font-semibold">เข้าสู่ระบบแล้วในชื่อ {current.name}</p>
          <p className="text-xs text-slate-600">{ROLE_LABEL[current.role]}</p>
          <div className="flex flex-wrap justify-center gap-2">
            <Link href={next} className={buttonClass}>
              <ArrowLeft aria-hidden className={iconCls} /> ไปต่อ
            </Link>
            <button
              type="button"
              className={buttonGhostClass}
              disabled={busy !== null}
              onClick={async () => {
                setBusy("out");
                await signOut({ redirect: false }).catch(() => undefined);
                window.location.reload();
              }}
            >
              <LogOut aria-hidden className={iconCls} /> ออกจากระบบ
            </button>
          </div>
        </div>
      </Card>
    );
  }

  const nothing = !methods.sso && !methods.code && !methods.local;

  return (
    <Card title="เข้าสู่ระบบ">
      <div className="space-y-4">
        <p className="text-xs text-slate-600">
          เจ้าหน้าที่โรงพยาบาลบางระกำเข้าสู่ระบบด้วย Provider ID (บัญชีใหม่ต้องรอผู้ดูแลระบบอนุมัติ) บุคคลภายนอกใช้รหัสที่ได้รับจากผู้ดูแลระบบ
        </p>
        {message ? <ErrorBox message={message} /> : null}
        {!methods.configured || nothing ? <ErrorBox message={AUTH_DISABLED_MESSAGE} /> : null}

        {methods.sso ? (
          <button
            type="button"
            disabled={busy !== null}
            aria-busy={busy === "sso"}
            onClick={() => {
              setBusy("sso");
              setMessage(null);
              void signIn(SSO_PROVIDER_ID, { redirectTo: next }).catch(() => setBusy(null));
            }}
            className="flex h-12 w-full items-center justify-center gap-3 rounded-lg border border-slate-300 bg-white text-sm font-semibold text-slate-800 shadow-sm hover:bg-brand-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Image
              src="/provider-id.png"
              alt=""
              width={80}
              height={32}
              className={`h-8 w-20 object-contain ${busy === "sso" ? "animate-pulse" : ""}`}
            />
            {busy === "sso" ? "กำลังไปที่ Provider ID..." : "เข้าสู่ระบบด้วย Provider ID"}
          </button>
        ) : null}

        {methods.code ? (
          <form
            className="space-y-2 border-t border-brand-100 pt-4"
            onSubmit={(e) => {
              e.preventDefault();
              void credentials("code", { code });
            }}
          >
            <label className="block space-y-1">
              <span className="flex items-center gap-1 text-sm font-semibold">
                <KeyRound aria-hidden className={iconCls} /> รหัสสำหรับบุคคลภายนอก
              </span>
              <input
                className={`${inputClass} font-mono tracking-widest`}
                value={code}
                maxLength={ACCESS_CODE_INPUT_MAX}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder="XXXX-XXXX-XXXX-XXXX"
                required
                onChange={(e) => setCode(e.target.value)}
              />
            </label>
            <button type="submit" className={`${buttonClass} w-full`} disabled={busy !== null}>
              {busy === "code" ? <Loader2 aria-hidden className={`${iconCls} animate-spin`} /> : <LogIn aria-hidden className={iconCls} />}
              {busy === "code" ? "กำลังตรวจสอบรหัส..." : "เข้าสู่ระบบด้วยรหัส"}
            </button>
          </form>
        ) : null}

        {methods.local ? (
          <details className="rounded-md border border-slate-200 px-3 py-2" open={!methods.sso && !methods.code}>
            <summary className="flex cursor-pointer items-center gap-1 text-xs font-medium text-slate-700">
              <UserCog aria-hidden className={iconCls} /> บัญชีสำรอง (ชื่อผู้ใช้ / รหัสผ่าน)
            </summary>
            <form
              className="mt-3 space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                void credentials("local", { username, password });
              }}
            >
              <p className="text-xs text-slate-500">ใช้เมื่อ Provider ID ยังใช้งานไม่ได้ หรือบัญชีที่ผู้ดูแลระบบกำหนดไว้</p>
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
              <button type="submit" className={`${buttonGhostClass} w-full`} disabled={busy !== null}>
                {busy === "local" ? <Loader2 aria-hidden className={`${iconCls} animate-spin`} /> : <LogIn aria-hidden className={iconCls} />}
                {busy === "local" ? "กำลังเข้าสู่ระบบ..." : "เข้าสู่ระบบด้วยบัญชีสำรอง"}
              </button>
            </form>
          </details>
        ) : null}

        <Link href="/" className="inline-block text-xs text-brand-700 underline-offset-2 hover:underline">
          กลับหน้าแรกโดยไม่เข้าสู่ระบบ
        </Link>
      </div>
    </Card>
  );
}
