import { redirect } from "next/navigation";

// The OPD waiting board is the landing page (first visit and after sign-in).
// The bed board lives at /beds.
export default function Home() {
  redirect("/opd");
}
