interface Chargeable {
  last_charged?: string | null;
  billing_frequency?: string | null;
  custom_interval_value?: number | null;
  custom_interval_unit?: string | null;
}

const UNIT_DAYS: Record<string, number> = { days: 1, weeks: 7, months: 30.437, years: 365.25 };
const FREQUENCY_DAYS: Record<string, number> = {
  Weekly: 7,
  Monthly: 30.437,
  Quarterly: 91.31,
  Yearly: 365.25,
};

/** Days between charges, or null when the frequency isn't known. */
export function periodDays(sub: Chargeable): number | null {
  if (sub.billing_frequency === "Custom") {
    const unit = UNIT_DAYS[sub.custom_interval_unit ?? ""];
    return sub.custom_interval_value && unit ? sub.custom_interval_value * unit : null;
  }
  return FREQUENCY_DAYS[sub.billing_frequency ?? ""] ?? null;
}

/**
 * A subscription whose next charge is overdue by more than a period (at most 60 days of
 * grace) is treated as stopped: a cancelled Netflix no longer counts as a monthly cost.
 */
export function isStopped(sub: Chargeable, today: Date): boolean {
  const period = periodDays(sub);
  if (!sub.last_charged || period == null) return false;
  const last = new Date(`${sub.last_charged}T00:00:00`);
  const daysSince = (today.getTime() - last.getTime()) / 86_400_000;
  return daysSince > period + Math.min(period, 60);
}
