import type { WardOccupancy } from "@/lib/beds/types";

/** Beds with a patient in them ("เตียงคนนอน"): patients minus those without their own bed. */
export const bedsInUse = (w: Pick<WardOccupancy, "occupied" | "occupiedNoBed">): number =>
  Math.max(w.occupied - w.occupiedNoBed, 0);

export type BedSummary = {
  beds: number;
  /** Beds with a patient (เตียงคนนอน). */
  inUse: number;
  available: number;
  occupancyPct: number;
  /** Patients without their own bed. */
  noBed: number;
  referWaiting: number;
};

export function summarize(wards: WardOccupancy[]): BedSummary {
  const beds = wards.reduce((s, w) => s + w.beds, 0);
  const available = wards.reduce((s, w) => s + w.available, 0);
  return {
    beds,
    inUse: wards.reduce((s, w) => s + bedsInUse(w), 0),
    available,
    occupancyPct: beds === 0 ? 0 : ((beds - available) / beds) * 100,
    noBed: wards.reduce((s, w) => s + w.occupiedNoBed, 0),
    referWaiting: wards.reduce((s, w) => s + w.referWaiting, 0),
  };
}
