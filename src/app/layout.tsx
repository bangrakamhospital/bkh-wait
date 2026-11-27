import type { Metadata } from "next";
import { Sarabun } from "next/font/google";
import Link from "next/link";
import { BedDouble, ClipboardList, Stethoscope } from "lucide-react";
import { HeaderAuth } from "@/components/auth/HeaderAuth";
import "./globals.css";

const sarabun = Sarabun({
  subsets: ["thai", "latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sarabun",
  display: "swap",
});

export const metadata: Metadata = {
  title: "ระบบบริหารเตียงและการรอคอย โรงพยาบาลบางระกำ",
  description: "แดชบอร์ดเตียงว่างและคิวส่งกลับผู้ป่วย โรงพยาบาลบางระกำ",
};

const navLink =
  "inline-flex items-center gap-1 rounded-md px-3 py-1 text-sm text-white/90 hover:bg-white/15";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th" className={sarabun.variable}>
      <body className="min-h-screen antialiased">
        <header className="bg-brand-700 text-white">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 px-4 py-2">
            <div className="text-base font-semibold">
              ระบบบริหารเตียงและการรอคอย โรงพยาบาลบางระกำ
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <nav className="flex flex-wrap gap-1">
                <Link href="/opd" className={navLink}>
                  <Stethoscope size={16} aria-hidden /> รอพบแพทย์ OPD
                </Link>
                <Link href="/beds" className={navLink}>
                  <BedDouble size={16} aria-hidden /> เตียงผู้ป่วยใน
                </Link>
                <Link href="/refer" className={navLink}>
                  <ClipboardList size={16} aria-hidden /> ส่งตัวกลับ
                </Link>
              </nav>
              <HeaderAuth />
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-7xl space-y-4 px-4 py-4">{children}</main>
      </body>
    </html>
  );
}
