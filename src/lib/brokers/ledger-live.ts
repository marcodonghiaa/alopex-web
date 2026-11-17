import { addDays, formatDay, isDay } from "@/lib/date";
import { plural } from "@/lib/plural";
import type { Trade } from "@/lib/trades";
import { splitLine, unheldKeys } from "./csv";
import type { BrokerParser } from "./types";

const COLUMNS = [
  "operation date",
  "currency ticker",
  "operation type",
  "operation amount",
  "operation fees",
  "operation hash",
  "countervalue ticker",
  "countervalue at operation date",
];

// How each operation type moves the balance, as Ledger Live itself counts it
// (getOperationAmountNumber in ledger-live's operation.ts). IN: the amount comes in. OUT: the
// amount goes out, its network fee included. STAKE: only the fee goes out. Anything else (NFTs)
// moves no coins.
const IN = new Set([
  "IN",
  "REWARD",
  "REWARD_PAYOUT",
  "WITHDRAW",
  "SHIELDED_TX_SAPLING_IN",
  "SHIELDED_TX_ORCHARD_IN",
  "SHIELDED_TX_IRONWOOD_IN",
]);
const OUT = new Set([
  "OUT",
  "REVEAL",
  "CREATE",
  "FEES",
  "DELEGATE",
  "REDELEGATE",
  "UNDELEGATE",
  "OPT_IN",
  "OPT_OUT",
  "OPT_EDIT",
  "SLASH",
  "LOCK",
  "BURN",
  "ASSOCIATE_TOKEN",
  "CONTRACT_CALL",
  "UPDATE_ACCOUNT",
  "SHIELDED_TX_SAPLING_OUT",
  "SHIELDED_TX_ORCHARD_OUT",
  "SHIELDED_TX_IRONWOOD_OUT",
  "STAKE_NEURON",
  "TOP_UP_NEURON",
]);
const STAKE = new Set([
  "FREEZE",
  "UNFREEZE",
  "UNDELEGATE_RESOURCE",
  "WITHDRAW_EXPIRE_UNFREEZE",
  "LEGACY_UNFREEZE",
  "VOTE",
  "BOND",
  "UNBOND",
  "WITHDRAW_UNBONDED",
  "SET_CONTROLLER",
  "NOMINATE",
  "CHILL",
  "REVOKE",
  "APPROVE",
  "ACTIVATE",
  "UNLOCK",
  "STAKE",
  "UNSTAKE",
  "WITHDRAW_UNSTAKED",
]);
// Staking rewards cost you nothing: all their value is gain. Slashed or burnt coins bring nothing back.
const FREE = new Set(["REWARD", "REWARD_PAYOUT"]);
const LOST = new Set(["SLASH", "BURN"]);
const familyOf = (type: string) =>
  IN.has(type) ? "in" : OUT.has(type) ? "out" : STAKE.has(type) ? "stake" : null;
// An operation type in plain words, for line errors.
const wordFor = (type: string) =>
  FREE.has(type)
    ? "reward"
    : type === "FEES"
      ? "fee"
      : ({ in: "received", out: "sent", stake: "staking" } as const)[familyOf(type)!];
// A plain decimal (1e-8 too); Number alone would also read 0x10 as 16. Blank is zero.
const num = (text: string) => {
  const t = text.trim();
  return t === "" ? 0 : /^\d*\.?\d+(e[+-]?\d+)?$/i.test(t) ? Number(t) : NaN;
};

/**
 * Ledger Live's operations export (Settings › Accounts › Export operations). It lists what came in
 * and went out of each wallet, not what you paid, so each move is priced at its value that day:
 * coming in is a buy, going out a sale. An OUT amount includes its network fee, a FEES row is gas
 * paid in ETH for a token transfer, and a failed send costs only its fee: all count as a cost. Staking
 * rewards come in at no cost. Older exports have no Status column; columns are read by name. Values are in the currency Ledger Live shows
 * (usually USD), turned into euro with that day's rate. One transaction hash can carry a token and
 * its gas, so a trade's id is hash, coin and type. The file is every operation of those wallets, so
 * it sets your Ledger holdings; coins you hold elsewhere stay as they are.
 */
export const ledgerLive: BrokerParser = {
  id: "ledger_live",
  name: "Ledger Live",
  country: "Desktop app export",
  kind: "crypto",
  holdingSource: "Ledger",
  howToExport: [
    "Open Ledger Live on your computer",
    "Settings › Accounts › Export operations, all accounts",
    "Pick the file here, as it comes",
  ],
  verifiedAt: "2026-11-17",
  detect: (header) => COLUMNS.every((c) => header.includes(c)),
  parse(lines, separator, header, { kind, knownKeys, today, rateToEur }) {
    if (kind !== "crypto") {
      return {
        trades: [],
        errors: ["This file comes from Ledger Live: import it on the Crypto page."],
        notes: [],
      };
    }
    const rows = lines.slice(1).map((line) => {
      const cells = splitLine(line, separator);
      return (name: string) => cells[header.indexOf(name)] ?? "";
    });
    const currencyOf = (get: (name: string) => string) =>
      get("countervalue ticker").trim().toUpperCase() || "EUR";

    // Every day priced in a currency other than euro, so the screen can load its rates first.
    if (!rateToEur) {
      // Only rows that move coins, on real days; any other row is reported (or skipped) below.
      const priced = rows.filter(
        (get) =>
          familyOf(get("operation type")) &&
          currencyOf(get) !== "EUR" &&
          isDay(get("operation date").slice(0, 10)),
      );
      const dates = priced.map((get) => get("operation date").slice(0, 10)).sort();
      const currency = priced[0] ? currencyOf(priced[0]) : "";
      if (/^[A-Z]{3}$/.test(currency)) {
        return {
          trades: [],
          errors: [],
          notes: [],
          needsRates: { currency, from: dates[0]!, to: dates[dates.length - 1]! },
        };
      }
    }

    const trades: Array<Trade> = [];
    const errors: Array<string> = [];
    const notes: Array<string> = [];
    const seen = new Map<string, number>();
    let skipped = 0;
    let noValue = 0;
    rows.forEach((get, i) => {
      const type = get("operation type");
      const family = familyOf(type);
      if (!family) return void skipped++;
      const date = get("operation date").slice(0, 10);
      const key = get("currency ticker").toUpperCase();
      const amount = num(get("operation amount"));
      const fee = num(get("operation fees"));
      const valueText = get("countervalue at operation date").trim();
      const value = num(valueText);
      // A line error says what's wrong, then the coin and what the operation was.
      const fail = (what: string, withCoin = true) => {
        const when = [wordFor(type), isDay(date) ? formatDay(date) : ""].filter(Boolean).join(" ");
        const about = withCoin && key ? `${key}, ${when}` : when;
        return void errors.push(`Line ${i + 2}: ${what} (${about}).`);
      };
      const bad = (field: string, n: number, text: string) =>
        Number.isNaN(n)
          ? `the ${field} "${text.trim()}" isn't a number`
          : !Number.isFinite(n)
            ? `the ${field} "${text.trim()}" is too big`
            : null;
      if (!isDay(date)) return fail(`the date "${date}" isn't a date`);
      if (!key) return fail("there's no coin");
      const unreadable =
        bad("amount", amount, get("operation amount")) ??
        bad("fee", fee, get("operation fees")) ??
        bad("value", value, valueText);
      if (unreadable) return fail(unreadable);
      // What leaves or enters the wallet, as Ledger Live counts its balance.
      // A failed send moved nothing but its fee, and a failed receive cost you nothing.
      const failed = get("status") === "Failed";
      if (failed && family === "in") return;
      const shares = family === "stake" || failed ? fee : amount;
      if (shares === 0) return;
      // Ledger dates are UTC days; west of UTC that can be a day past your local today.
      if (date > addDays(today, 1))
        return void errors.push(`Line ${i + 2}: the date is in the future.`);
      const currency = currencyOf(get);
      const rate = currency === "EUR" ? 1 : (rateToEur?.(currency, date) ?? null);
      if (rate == null) {
        return void errors.push(`Line ${i + 2}: no ${currency} to EUR rate for ${date}.`);
      }
      // The value is of the amount; with none (or a fee-only row worth nothing) the coin counts at €0.
      if (valueText === "" || amount === 0) noValue++;
      const price = FREE.has(type) || amount === 0 ? 0 : (value * rate) / amount;
      // Fees, failed sends, staking actions and slashing bring nothing back: their value is a cost.
      const cost =
        family === "stake" || LOST.has(type)
          ? shares
          : family === "out"
            ? Math.min(fee, amount)
            : 0;
      const hash = get("operation hash").trim().toLowerCase();
      let id: string | null = null;
      if (hash) {
        const base = `${hash}:${key}:${type}`;
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);
        id = n === 1 ? base : `${base}#${n}`;
      }
      // Each number can be fine and still give a price too big to save. The database keeps coin
      // symbols up to 100 characters and ids up to 200, counted as it does (code points).
      if ([...key].length > 100) return fail("the coin name is too long", false);
      if ([...(id ?? "")].length > 200) return fail("the operation hash is too long");
      if (!Number.isFinite(price) || !Number.isFinite(shares * price)) {
        return fail(
          `the value "${valueText}" is too big for the amount "${get("operation amount").trim()}"`,
        );
      }
      trades.push({
        kind,
        key,
        side: family === "in" ? "buy" : "sell",
        trade_date: date,
        shares,
        price_eur: price,
        fee_eur: cost * price,
        source: "ledger_live",
        external_id: id,
      });
    });

    const open = unheldKeys(trades, knownKeys);
    for (const key of open)
      notes.push(
        `${key} has no Ledger or manual holding, so it was left out. Add it as a coin, then import again.`,
      );
    const ops = (n: number, one: string, many: string) =>
      `${plural(n, "operation")} ${n === 1 ? one : many}`;
    if (skipped > 0)
      notes.push(
        ops(
          skipped,
          "that doesn't move coins (an NFT or similar) was skipped.",
          "that don't move coins (NFTs or similar) were skipped.",
        ),
      );
    if (noValue > 0) {
      const counted = "had no value in the file, so it was counted at €0.";
      notes.push(ops(noValue, counted, counted.replace("it was", "they were")));
    }
    return {
      trades: trades.filter((t) => !open.includes(t.key)),
      errors,
      notes,
      setsShares: true,
    };
  },
};
