import { plural } from "@/lib/plural";
import type { Trade } from "@/lib/trades";
import { splitLine, unheldKeys } from "./csv";
import type { BrokerParser } from "./types";

const COLUMNS = [
  "operation date",
  "status",
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

/**
 * Ledger Live's operations export (Settings › Accounts › Export operations). It lists what came in
 * and went out of each wallet, not what you paid, so each move is priced at its value that day:
 * coming in is a buy, going out a sale. An OUT amount includes its network fee, a FEES row is gas
 * paid in ETH for a token transfer, and a failed send costs its fee: all count as a cost. Staking
 * rewards come in at no cost. Failed rows are counted like Ledger Live counts them, so the totals
 * match the balance it shows. Values are in the currency Ledger Live shows
 * (usually USD), turned into euro with that day's rate. One transaction hash can carry a token and
 * its gas, so a trade's id is hash, coin and type. The file is every operation of those wallets, so
 * it sets your Ledger holdings; coins you hold elsewhere stay as they are.
 */
export const ledgerLive: BrokerParser = {
  id: "ledger_live",
  name: "Ledger Live",
  country: "Any country",
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
        errors: ["This is a Ledger Live export: import it on the Crypto page."],
        notes: [],
      };
    }
    const rows = lines.slice(1).map((line) => {
      const cells = splitLine(line, separator);
      return (name: string) => cells[header.indexOf(name)] ?? "";
    });

    // Every day priced in a currency other than euro, so the screen can load its rates first.
    if (!rateToEur) {
      const dates = rows
        .filter((get) => get("countervalue ticker") && get("countervalue ticker") !== "EUR")
        .map((get) => get("operation date").slice(0, 10))
        .sort();
      const currency = rows.find((get) => get("countervalue ticker") !== "EUR")?.(
        "countervalue ticker",
      );
      if (currency && dates.length > 0) {
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
      const family = IN.has(type) ? "in" : OUT.has(type) ? "out" : STAKE.has(type) ? "stake" : null;
      if (!family) return void skipped++;
      const date = get("operation date").slice(0, 10);
      const key = get("currency ticker").toUpperCase();
      const amount = Number(get("operation amount") || 0);
      const fee = Number(get("operation fees") || 0);
      const valueText = get("countervalue at operation date").trim();
      const value = Number(valueText);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !key || !(amount >= 0) || !(fee >= 0)) {
        return void errors.push(`Line ${i + 2}: couldn't read this ${type} row.`);
      }
      if (!(value >= 0)) return void errors.push(`Line ${i + 2}: couldn't read this ${type} row.`);
      // What leaves or enters the wallet, as Ledger Live counts its balance.
      const shares = family === "stake" ? fee : amount;
      if (shares === 0) return;
      if (date > today) return void errors.push(`Line ${i + 2}: the date is in the future.`);
      const currency = get("countervalue ticker") || "EUR";
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
      const hash = get("operation hash").trim();
      let id: string | null = null;
      if (hash) {
        const base = `${hash}:${key}:${type}`;
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);
        id = n === 1 ? base : `${base}#${n}`;
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
        `${key} isn't one of your holdings, so it was left out. Add it, then import again.`,
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
