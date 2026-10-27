import type { AccessState } from "../api";

export function TrialBanner({ access }: { access: AccessState }) {
  if (access.phase === "ACTIVE") return null;
  if (access.phase === "TRIAL") {
    if (access.daysLeft > 3) return null;
    return <div className="banner info">Your free trial ends in {plural(access.daysLeft, "day")}.</div>;
  }
  if (access.phase === "GRACE") {
    return (
      <div className="banner warn">
        Your trial has ended. You have {plural(access.daysLeft, "day")} before your data becomes read-only.
      </div>
    );
  }
  return <div className="banner danger">Your trial has ended. Your data is read-only until you subscribe.</div>;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
