import type { Trade } from "@/lib/trades";

export interface CsvResult {
  trades: Array<Trade>;
  errors: Array<string>;
  /** Left out on purpose, but you should know. */
  notes: Array<string>;
  /** The file is your broker's full record, so it can correct how many shares you hold. */
  setsShares?: boolean;
  /** Names the file gives its holdings, by key, for the summary before you save. */
  names?: Map<string, string>;
  /** No parser recognised the file: the screen offers to ask for your broker. */
  unknownFormat?: boolean;
  /** Prices are in another currency: load its rates for these days, then parse again with them. */
  needsRates?: { currency: string; from: string; to: string };
}

export interface ParseContext {
  kind: "stock" | "crypto";
  knownKeys: Set<string>;
  today: string;
  /** Euro per one unit of a currency on a day (or the last day before it), null when unknown. */
  rateToEur?: (currency: string, date: string) => number | null;
}

/**
 * One broker's export. To add a broker: one file in this folder, a sample export in
 * `fixtures/` with no personal data, a test, and an entry in BROKERS (index.ts).
 */
export interface BrokerParser {
  /** Stored on each trade as `source`, so never rename it. */
  id: string;
  name: string;
  country: string;
  /** Which page imports it: stock trades on Portfolio, coins on Crypto. */
  kind: "stock" | "crypto";
  /** Where to find the file in the broker's app, one short step each, shown before you upload. */
  howToExport: Array<string>;
  /**
   * Crypto only: the holding source the file is the full record of (crypto_holdings.source). Its
   * share counts are set from this broker's trades alone, so coins held elsewhere stay as they are.
   */
  holdingSource?: string;
  /** Last day a real export was imported without problems, or null if only the sample was tested. */
  verifiedAt: string | null;
  /** Lowercased header cells. Must be strict: two parsers may never accept the same file. */
  detect: (header: Array<string>) => boolean;
  parse: (
    lines: Array<string>,
    separator: string,
    header: Array<string>,
    ctx: ParseContext,
  ) => CsvResult;
}
