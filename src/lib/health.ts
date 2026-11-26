import { bankOf } from "@/components/bank-badge";
import { accessText, consentAlerts } from "@/lib/consent-expiry";
import { plural } from "@/lib/plural";
import { maskIban } from "@/lib/iban";
import { syncErrorKind, syncErrorMessage } from "@/lib/sync-error";

export type HealthState = "ok" | "warn" | "bad";

export interface HealthRow {
  id: string;
  title: string;
  state: HealthState;
  detail: string;
  // The bank a per-bank check belongs to: Settings groups these rows under the bank.
  bank?: string;
  // Tells apart two accounts of one bank in the same currency: the IBAN's last four, else the label.
  account?: string;
  // The one fix: a page to open, or a built-in control for the row.
  fix?: { label: string; to: "/accounts" } | { label: string; href: string } | { push: true };
}

export interface HealthAccount {
  uid: string | null;
  label: string | null;
  currency: string | null;
  bank_name?: string | null;
  iban?: string | null;
  consent_valid_until: string | null;
  snapshot_date: string | null;
  // What the last sync hit (absent on a database without the bank-sync-health migration).
  sync_error?: string | null;
}

const HOUR_MS = 60 * 60 * 1000;
// Amber once a whole calendar day passed with no sync: syncs run 4 times a day, the first at
// 05:17 UTC, so from midnight UTC until then yesterday's balance is still on schedule.
const STALE_AMBER_H = 48;
const STALE_RED_H = 72;

// Worst first, so a page can show what needs attention at the top.
const SEVERITY: Record<HealthState, number> = { bad: 0, warn: 1, ok: 2 };
export const bySeverity = (a: { state: HealthState }, b: { state: HealthState }) =>
  SEVERITY[a.state] - SEVERITY[b.state];

// Hours since the account's latest balance snapshot. The snapshot is a calendar day (UTC), so a
// balance from today reads 0-24 h, yesterday's 24-48 h (both fresh), and three days back is red.
export function syncAgeHours(snapshotDate: string, now: Date): number {
  return (now.getTime() - Date.parse(snapshotDate.slice(0, 10))) / HOUR_MS;
}

export function syncState(ageHours: number): HealthState {
  if (ageHours > STALE_RED_H) return "bad";
  return ageHours > STALE_AMBER_H ? "warn" : "ok";
}

function ageText(ageHours: number): string {
  const days = Math.floor(ageHours / 24);
  return days < 1 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}

// Only accounts with a bank consent are bank-synced; imported and manual ones are skipped.
const connected = (accounts: Array<HealthAccount>) => accounts.filter((a) => a.consent_valid_until);

/** One row per connected bank: how long its access lasts (the bank stops syncing silently after). */
export function accessRows(accounts: Array<HealthAccount>, today: Date): Array<HealthRow> {
  const alerts = new Map(consentAlerts(accounts, today).map((a) => [a.bank, a.daysLeft]));
  const banks = new Set(connected(accounts).map(bankOf));
  const fix = { label: "Renew access", to: "/accounts" } as const;
  return [...banks].map((bank) => {
    const title = `${bank} access`;
    const daysLeft = alerts.get(bank);
    if (daysLeft === undefined) {
      return { id: `access:${bank}`, title, bank, state: "ok", detail: "Bank access is valid." };
    }
    if (daysLeft < 0) {
      return {
        id: `access:${bank}`,
        title,
        bank,
        state: "bad",
        detail: accessText(daysLeft),
        fix,
      };
    }
    return {
      id: `access:${bank}`,
      title,
      bank,
      state: daysLeft === 0 ? "bad" : "warn",
      detail: accessText(daysLeft),
      fix,
    };
  });
}

/**
 * One row per connected account: when its balance last updated and, when that is late or the
 * last sync failed, why and the one fix for it. `projectUrl` (this dashboard's Supabase URL)
 * links the sync logs and secrets; without a supabase.co address those rows have no link.
 */
export function syncRows(
  accounts: Array<HealthAccount>,
  now: Date,
  projectUrl?: string,
): Array<HealthRow> {
  const secrets = supabaseSecretsUrl(projectUrl);
  const logs = supabaseDashboardUrl(projectUrl, "functions/sync-bank/logs");
  const logsFix = logs ? { fix: { label: "Open sync logs", href: logs } } : {};
  return connected(accounts).map((a) => {
    const id = `sync:${a.uid ?? a.label}`;
    const bank = bankOf(a);
    const title = `${[bank, a.currency].filter(Boolean).join(" ")} sync`;
    const account = a.iban ? maskIban(a.iban) : (a.label ?? undefined);
    const base = { id, title, bank, ...(account && { account }) };
    const ended = Date.parse(a.consent_valid_until!) <= now.getTime();
    if (ended || (a.sync_error && syncErrorKind(a.sync_error) === "consent")) {
      return {
        ...base,
        state: "bad",
        detail: `${bank} access ended, so this account no longer syncs. Renew it to start again.`,
        fix: { label: "Renew access", to: "/accounts" },
      };
    }
    const kind = a.sync_error ? syncErrorKind(a.sync_error) : null;
    const why = a.sync_error ? syncErrorMessage(a.sync_error, bank) : null;
    // Waiting doesn't fix these, so they show even while the balance is still fresh.
    if (kind === "reconnect" && why) {
      return {
        ...base,
        state: "warn",
        detail: why,
        fix: { label: "Connect again", to: "/accounts" },
      };
    }
    if (kind === "setup" && why) {
      return {
        ...base,
        state: "warn",
        detail: why,
        ...(secrets && { fix: { label: "Open Supabase secrets", href: secrets } }),
      };
    }
    if (!a.snapshot_date) {
      return {
        ...base,
        state: "warn",
        detail: why ?? "No balance synced yet.",
        ...(why && logsFix),
      };
    }
    const age = syncAgeHours(a.snapshot_date, now);
    const state = syncState(age);
    const last = `Last synced ${ageText(age)}.`;
    if (state === "ok") return { ...base, state, detail: last };
    return {
      ...base,
      state,
      detail: why
        ? `${last} ${why}`
        : `${last} The last sync reported no error, so the scheduled sync may not have run since. The sync-bank logs in Supabase show each run.`,
      ...logsFix,
    };
  });
}

/** This browser's push status. Null where push can't work (demo, no service worker). */
export function pushRow(
  support: "ok" | "install" | "unsupported",
  subscribed: boolean,
): HealthRow | null {
  const title = "Push notifications";
  if (support === "unsupported") return null;
  if (support === "install") {
    return {
      id: "push",
      title,
      state: "warn",
      detail:
        "Install the app first (iPhone: Safari → Share → Add to Home Screen), then turn this on.",
    };
  }
  return subscribed
    ? { id: "push", title, state: "ok", detail: "This browser gets purchase check-ins." }
    : {
        id: "push",
        title,
        state: "warn",
        detail: "This browser isn't subscribed to purchase check-ins.",
        fix: { push: true },
      };
}

/**
 * Whether the backend knows this dashboard's address, from what register_dashboard_origin answered
 * when this page loaded. Null when there is nothing to say (not the owner, no answer, demo).
 */
export function originRow(status: string | null): HealthRow | null {
  const title = "Dashboard address";
  if (status === "added" || status === "exists")
    return {
      id: "origin",
      title,
      state: "ok",
      detail: "The backend knows this dashboard's address.",
    };
  if (status === "full")
    return {
      id: "origin",
      title,
      state: "warn",
      detail:
        "The backend already keeps 5 dashboard addresses, so it didn't add this one, and bank linking may not bring you back here. Delete old rows from the dashboard_origins table in Supabase, then reload.",
    };
  if (status === "rejected")
    return {
      id: "origin",
      title,
      state: "warn",
      detail:
        "The backend doesn't accept this address, so bank linking may not bring you back here. Use an https address (or localhost) that stays the same, not a per-deployment Vercel one.",
    };
  return null;
}

// A page of this dashboard's own Supabase project ("https://<ref>.supabase.co") in its dashboard.
function supabaseDashboardUrl(projectUrl: string | undefined, path: string): string | null {
  const ref = projectUrl?.match(/^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/)?.[1];
  return ref ? `https://supabase.com/dashboard/project/${ref}/${path}` : null;
}

// The Edge Function secrets page of this dashboard's own Supabase project.
export const supabaseSecretsUrl = (projectUrl: string | undefined) =>
  supabaseDashboardUrl(projectUrl, "functions/secrets");

/**
 * Whether AI categorization works, read from what it did: the key itself never reaches the
 * browser. Last 30 days: rows sorted by AI, and rows still without a category a day after they
 * arrived (each sync run clears them while the key works, so these mean no key, a revoked one or
 * a spent quota). Null when there is nothing to judge or the counts couldn't be read.
 */
export function aiRow(
  counts: { ai: number; stuck: number } | null,
  secretsUrl: string | null,
): HealthRow | null {
  if (!counts || (counts.ai === 0 && counts.stuck === 0)) return null;
  const title = "AI categories";
  if (counts.stuck === 0) {
    return {
      id: "ai",
      title,
      state: "ok",
      detail: `Gemini sorted ${plural(counts.ai)} in the last 30 days.`,
    };
  }
  return {
    id: "ai",
    title,
    state: "warn",
    detail:
      `${plural(counts.stuck)} still ${counts.stuck === 1 ? "has" : "have"} no category a day after syncing. ` +
      "Add or check GEMINI_API_KEY in your Supabase secrets. " +
      "Descriptions go to Google; its free tier may train on them.",
    ...(secretsUrl && { fix: { label: "Open Supabase secrets", href: secretsUrl } }),
  };
}

export type HealthItem = HealthRow | { bank: string; state: HealthState; rows: Array<HealthRow> };

/**
 * Per-bank checks folded into one item per bank (its worst state on top), so a long list of
 * linked accounts reads as a few banks. Other checks stay single rows. Worst first.
 */
export function groupByBank(rows: Array<HealthRow>): Array<HealthItem> {
  const banks = new Map<string, Array<HealthRow>>();
  const singles: Array<HealthItem> = [];
  for (const row of rows) {
    if (!row.bank) singles.push(row);
    else banks.set(row.bank, [...(banks.get(row.bank) ?? []), row]);
  }
  const groups = [...banks].map(([bank, list]): HealthItem => {
    // Two "Revolut EUR sync" rows: name each by its account; when that is shared too (labels
    // are often the holder's name), by the end of its id.
    const twins = (r: HealthRow) => list.filter((o) => o !== r && o.title === r.title);
    const tag = (r: HealthRow) =>
      r.account && !twins(r).some((o) => o.account === r.account)
        ? r.account
        : `…${r.id.slice(-4)}`;
    const sorted = [...list]
      .sort(bySeverity)
      .map((r) => (twins(r).length ? { ...r, title: `${r.title} · ${tag(r)}` } : r));
    return { bank, state: sorted[0]!.state, rows: sorted };
  });
  // Banks lead at equal severity: they are what the section is mostly about.
  return [...groups, ...singles].sort(bySeverity);
}

export const attentionCount = (rows: Array<HealthRow>) =>
  rows.filter((r) => r.state !== "ok").length;

/**
 * The one-line freshness sign under the Net Worth figure: when the stalest connected bank last
 * synced, and how many bank checks need attention. Null without a connected bank (nothing syncs).
 */
export function syncStatus(
  accounts: Array<HealthAccount>,
  now: Date,
): { text: string; attention: number } | null {
  const list = connected(accounts);
  if (list.length === 0) return null;
  const attention = attentionCount([...accessRows(list, now), ...syncRows(list, now)]);
  const dates = list.map((a) => a.snapshot_date).filter((d): d is string => !!d);
  if (dates.length === 0) return { text: "Not synced yet", attention };
  const oldest = dates.reduce((a, b) => (a < b ? a : b));
  return { text: `Synced ${ageText(syncAgeHours(oldest, now))}`, attention };
}
