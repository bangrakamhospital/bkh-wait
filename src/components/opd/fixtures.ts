import type { ClinicWait, OpdBoard } from "@/lib/opd/types";

type Seed = [string, string, number, number, number, number, number | null, number | null, number | null, number, number, number | null];
const seeds: Seed[] = [
  ["MED", "อายุรกรรม", 42, 18, 160, 96, 78, 66, 135, 3, 22, 85],
  ["SUR", "ศัลยกรรม", 14, 6, 70, 38, 52, 45, 95, 1, 9, 50],
  ["PED", "กุมารเวช", 8, 3, 35, 51, 30, 26, 60, 1, 11, 25],
  ["OBG", "สูติ-นรีเวช", 21, 9, 105, 44, 61, 55, 110, 2, 13, 60],
  ["DEN", "ทันตกรรม", 0, 0, 0, 30, 25, 20, 48, 2, 8, null],
  ["NCD", "คลินิกโรคเรื้อรัง (NCD)", 33, 15, 125, 72, 110, 98, 175, 2, 14, 120],
  ["TTM", "แพทย์แผนไทย", 3, 1, 18, 25, 27, 24, 41, 1, 6, 15],
  ["EYE", "ตา", 11, 5, 55, 19, 66, 60, 108, 1, 5, 62],
];

const clinics: ClinicWait[] = seeds.map(
  ([clinicCode, clinicName, waitingNow, waitingForDoctor, longestWaitMinutes, seenToday, avg, median, p90, doctorsActive, seenLastHour, est]) => ({
    clinicCode,
    clinicName,
    waitingNow,
    waitingForDoctor,
    longestWaitMinutes,
    seenToday,
    avgWaitMinutes: avg,
    medianWaitMinutes: median,
    p90WaitMinutes: p90,
    doctorsActive,
    seenLastHour,
    estimatedWaitMinutes: est,
  }),
);

export const fixtureBoard: OpdBoard = {
  asOf: new Date().toISOString(),
  stale: false,
  date: new Date().toISOString().slice(0, 10),
  clinics,
  hourly: Array.from({ length: 10 }, (_, i) => ({
    hour: 7 + i,
    arrived: [40, 95, 120, 88, 52, 30, 44, 38, 20, 0][i],
    seen: [18, 70, 110, 95, 60, 38, 40, 36, 24, 0][i],
    avgWaitMinutes: [22, 48, 85, 92, 70, 55, 50, 44, 38, null][i],
  })),
  totals: {
    waitingNow: clinics.reduce((s, c) => s + c.waitingNow, 0),
    waitingForDoctor: clinics.reduce((s, c) => s + c.waitingForDoctor, 0),
    seenToday: clinics.reduce((s, c) => s + c.seenToday, 0),
    avgWaitMinutes: 63,
    medianWaitMinutes: 52,
    longestWaitMinutes: 175,
  },
};
