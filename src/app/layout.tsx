import type { Metadata } from "next";
import { Sarabun } from "next/font/google";
import Link from "next/link";
import { BedDouble, ClipboardList } from "lucide-react";
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
            <nav className="flex gap-1">
              <Link href="/" className={navLink}>
                <BedDouble size={16} aria-hidden /> เตียงว่าง
              </Link>
              <Link href="/refer" className={navLink}>
                <ClipboardList size={16} aria-hidden /> คิวส่งกลับ
              </Link>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-7xl space-y-4 px-4 py-4">{children}</main>
      </body>
    </html>
  );
}
