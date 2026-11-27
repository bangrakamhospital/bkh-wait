import type { OpdFlowKey } from "./types";

/**
 * Visit-flow buckets in display order (= patient path), with the Thai label
 * and the one-line definition shown to staff. The HOSxP rules live in
 * scripts/lib/hosxp-opd.mjs ("Visit flow"); keep the two in sync.
 * Client-safe (no server-only import): used by the board and the UI.
 */
export const FLOW_DEFS: readonly { key: OpdFlowKey; label: string; definition: string }[] = [
  {
    key: "screening",
    label: "รอซักประวัติ/คัดกรอง",
    definition: "ยังไม่พบแพทย์ ยังไม่ได้ซักประวัติ (ลงทะเบียนไม่เกิน 8 ชม.)",
  },
  {
    key: "doctor",
    label: "รอพบแพทย์",
    definition: "ซักประวัติแล้วหรืออยู่หน้าห้องตรวจ ยังไม่พบแพทย์ (รวมผู้ที่ไปเจาะเลือด/X-ray ก่อนพบแพทย์)",
  },
  {
    key: "after_doctor",
    label: "พบแพทย์แล้ว รอขั้นตอนต่อ",
    definition: "แพทย์ตรวจแล้ว ยังอยู่ที่ห้องตรวจ/จุดซักประวัติ เช่น รอผลตรวจ นัดหมาย เอกสาร",
  },
  {
    key: "lab",
    label: "ห้อง Lab / X-ray",
    definition: "อยู่ที่ห้อง Lab หรือ X-ray (ส่วนใหญ่มาเจาะเลือดอย่างเดียว ไม่ต้องพบแพทย์)",
  },
  {
    key: "services",
    label: "ทันตกรรม / ตา / กายภาพ / คลินิกอื่น",
    definition: "อยู่ที่แผนกบริการอื่นที่ไม่มีคิวแพทย์ เช่น ทันตกรรม คลินิกตา กายภาพบำบัด แพทย์แผนไทย",
  },
  {
    key: "pharmacy",
    label: "ห้องยา / การเงิน",
    definition: "ส่งไปห้องจ่ายยาหรือการเงินแล้ว (HOSxP ไม่บันทึกเวลาจ่ายยา จึงรวมผู้ที่รับยาแล้วแต่ยังไม่ได้ส่งกลับบ้าน)",
  },
  { key: "done", label: "กลับบ้านแล้ว", definition: "ส่งกลับบ้านในระบบแล้ว (จุดปัจจุบัน 999)" },
  { key: "er", label: "ห้องฉุกเฉิน (ER)", definition: "visit ที่ลงทะเบียนที่ห้องฉุกเฉิน หรืออยู่ที่ ER ขณะนี้" },
  { key: "admit", label: "Admit", definition: "รับไว้เป็นผู้ป่วยใน (มี AN) หรืออยู่ที่แผนกผู้ป่วยใน" },
  {
    key: "other",
    label: "อื่นๆ / ค้างในระบบ",
    definition: "ไม่เข้ากลุ่มใดข้างต้น เช่น ยังไม่พบแพทย์แต่ลงทะเบียนเกิน 8 ชม. หรือไม่ระบุจุด",
  },
];

/**
 * One fixed colour per bucket, shared by the flow tiles (Tailwind class) and
 * the 3D / 2D waiting-point scene (hex, same Tailwind palette value), so a
 * bucket looks the same everywhere.
 */
export const FLOW_COLOR: Record<OpdFlowKey, { bg: string; hex: string }> = {
  screening: { bg: "bg-amber-400", hex: "#fbbf24" },
  doctor: { bg: "bg-orange-500", hex: "#f97316" },
  after_doctor: { bg: "bg-brand-500", hex: "#1f9a8f" },
  lab: { bg: "bg-sky-500", hex: "#0ea5e9" },
  services: { bg: "bg-violet-500", hex: "#8b5cf6" },
  pharmacy: { bg: "bg-teal-600", hex: "#0d9488" },
  done: { bg: "bg-emerald-500", hex: "#10b981" },
  er: { bg: "bg-red-500", hex: "#ef4444" },
  admit: { bg: "bg-rose-400", hex: "#fb7185" },
  other: { bg: "bg-slate-400", hex: "#94a3b8" },
};
