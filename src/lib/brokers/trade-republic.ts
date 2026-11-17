import type { EventKind, InvestmentEvent } from "@/lib/investment-events";
import type { Trade } from "@/lib/trades";
import { parseDate, splitLine, unheldKeys } from "./csv";
import type { BrokerParser } from "./types";

const COLUMNS = ["transaction_id", "category", "type", "symbol", "shares", "price", "currency"];

// Rows that change how many shares or coins you hold.
//   BUY/SELL and the private-market ones: trades at the file's price.
//   Shares you got for free (a stock perk, a gift, a staking reward): a buy at no cost, all gain.
//   A bond paid back at maturity: a sale at what you got for it.
//   A split: more shares at no cost. Shares that come in from or go out to another broker: their
//   price isn't in the file, so they're counted at no cost and you're told.
const TRADES = new Set(["BUY", "SELL", "PRIVATE_MARKET_BUY", "PRIVATE_MARKET_SELL"]);
const FREE = new Set(["FREE_RECEIPT", "GIFT", "STOCKPERK", "STOCK_PERK"]);
const PAID_BACK = new Set(["FINAL_MATURITY", "REDEMPTION", "TILG", "LIQUIDATION"]);
const MOVED = new Set(["MERGER", "SPIN_OFF", "SECURITY_TRANSFER", "TRANSFER", "DELIVERY"]);
// A MIGRATION row moves shares in and straight out again: nothing changes.
const IGNORED = new Set(["MIGRATION"]);
// Spending on the card and transfers from your own bank are your bank account's, not your
// investments': connect Trade Republic as a bank to see them in Transactions.
const CARD = /^CARD_/;

// Cash rows: what kind of event each is. Deposits and withdrawals go by the sign of the amount.
const CASH: Record<string, EventKind> = {
  DIVIDEND: "dividend",
  DISTRIBUTION: "dividend",
  DIVIDEND_EQUIVALENT_PAYMENT: "dividend",
  INTEREST_PAYMENT: "interest",
  BOND_ACCRUED_INTEREST: "interest",
  BENEFITS_SAVEBACK: "reward",
  BONUS: "reward",
  REFERRAL: "reward",
  KINDERGELD_BONUS: "reward",
  FEE: "fee",
  CARD_ORDERING_FEE: "fee",
  TAX: "tax",
  PRE_DETERMINED_TAX_BASE: "tax",
  TAX_OPTIMIZATION: "tax",
  SEC_ACCOUNT: "tax",
};
const MONEY_MOVE = /^(CUSTOMER_|TRANSFER_|VIBAN_|PAYMENT_|SEPA_|INPAYMENT|OUTPAYMENT)/;

const num = (text: string) => (text.trim() === "" ? 0 : Number(text));
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Trade Republic's transaction export (Profile › Statements › Transaction export, CSV): the whole
 * history in one file. Trades go to your holdings; dividends, interest, saveback, fees, taxes,
 * deposits and withdrawals are saved as events, so returns count what your investments paid you.
 * Crypto rows are imported on the Crypto page, the rest on Portfolio, from the same file. Card
 * payments are your bank account's and are skipped. Each row keeps Trade Republic's
 * transaction_id, so importing the file again skips exactly what's saved.
 */
export const tradeRepublic: BrokerParser = {
  id: "trade_republic",
  name: "Trade Republic",
  country: "DE, IT, FR, ES and more",
  kind: "both",
  howToExport: [
    "Open the Trade Republic app",
    "Profile › Statements › Transaction export",
    "Pick a start date before your first deposit, create the CSV",
    "Pick the file here, as it comes. Import it again any time: what's saved is skipped",
  ],
  verifiedAt: "2026-11-10",
  detect: (header) => COLUMNS.every((c) => header.includes(c)),
  parse(lines, separator, header, { kind, knownKeys, today }) {
    const trades: Array<Trade> = [];
    const events: Array<InvestmentEvent> = [];
    const errors: Array<string> = [];
    const notes: Array<string> = [];
    const names = new Map<string, string>();
    let card = 0;
    let otherPage = 0;
    let unknown = 0;
    let movedIn = 0;
    let reverse = 0;

    lines.slice(1).forEach((line, i) => {
      const cells = splitLine(line, separator);
      const get = (name: string) => cells[header.indexOf(name)] ?? "";
      const category = get("category");
      const type = get("type");
      const rowKind: "stock" | "crypto" = get("asset_class") === "CRYPTO" ? "crypto" : "stock";
      const key = get("symbol").toUpperCase() || null;
      const date = get("date");
      const id = get("transaction_id").trim() || null;
      const at = get("datetime").trim() || null;
      const line_ = `Line ${i + 2}`;

      if (IGNORED.has(type)) return;
      if (parseDate(date) == null) return void errors.push(`${line_}: the date isn't valid.`);
      if (date > today) return void errors.push(`${line_}: the date is in the future.`);
      const shares = num(get("shares"));
      const amount = num(get("amount"));
      const fee = Math.abs(num(get("fee")));
      const tax = Math.abs(num(get("tax")));
      if (![shares, amount, fee, tax].every(Number.isFinite)) {
        return void errors.push(`${line_}: couldn't read this ${type} row.`);
      }

      const movesShares =
        TRADES.has(type) ||
        FREE.has(type) ||
        PAID_BACK.has(type) ||
        MOVED.has(type) ||
        type === "SPLIT" ||
        category === "CORPORATE_ACTION" ||
        category === "DELIVERY";
      if (movesShares && key && shares !== 0) {
        if (rowKind !== kind) return void otherPage++;
        names.set(key, get("name"));
        if (type === "SPLIT" && shares < 0) {
          reverse++;
          return;
        }
        let price: number;
        let note: string | null = null;
        if (TRADES.has(type)) {
          // A blank price read as 0 and saved a buy at no cost, inflating the return.
          if (get("price").trim() === "")
            return void errors.push(`${line_}: this ${type} row has no price.`);
          price = num(get("price"));
          if (get("currency") !== "EUR")
            return void errors.push(`${line_}: the price isn't in EUR.`);
          const description = get("description").trim();
          if (description) note = description.slice(0, 200);
        } else if (PAID_BACK.has(type)) {
          price = Math.abs(amount) / Math.abs(shares);
          note = "Paid back";
        } else {
          price = 0;
          note = FREE.has(type) ? "Received free" : type === "SPLIT" ? "Split" : "Moved in or out";
          if (!FREE.has(type) && type !== "SPLIT" && shares > 0) movedIn++;
        }
        if (!(price >= 0)) return void errors.push(`${line_}: couldn't read this ${type} row.`);
        trades.push({
          kind,
          key,
          side: shares < 0 ? "sell" : "buy",
          trade_date: date,
          shares: Math.abs(shares),
          price_eur: price,
          fee_eur: TRADES.has(type) ? fee : 0,
          tax_eur: TRADES.has(type) ? tax : 0,
          traded_at: at,
          note,
          source: "trade_republic",
          external_id: id,
        });
        // A corporate action is also kept as an event, so its cash (if any) and type aren't lost.
        if (!TRADES.has(type) && !FREE.has(type)) {
          events.push(event("corporate_action"));
        }
        return;
      }

      if (CARD.test(type) && type !== "CARD_ORDERING_FEE") return void card++;
      let eventKind: EventKind | undefined = CASH[type];
      if (eventKind === "tax" && amount > 0) eventKind = "tax_refund";
      if (!eventKind && MONEY_MOVE.test(type)) eventKind = amount >= 0 ? "deposit" : "withdrawal";
      if (!eventKind) {
        unknown++;
        eventKind = "other";
      }
      // An event about a coin goes with the Crypto page, about a share with Portfolio; cash alone
      // (interest, a deposit) with Portfolio.
      const eventPage = key && rowKind === "crypto" ? "crypto" : "stock";
      if (eventPage !== kind) return void otherPage++;
      if (key) names.set(key, get("name"));
      events.push(event(eventKind));

      function event(k: EventKind): InvestmentEvent {
        const orig = get("original_amount").trim();
        const rate = get("fx_rate").trim();
        const origCurrency = get("original_currency").trim().toUpperCase();
        return {
          kind: k,
          asset_kind: key ? rowKind : null,
          key,
          event_date: date,
          occurred_at: at,
          amount_eur: amount,
          tax_eur: tax,
          fee_eur: fee,
          shares: shares !== 0 ? Math.abs(shares) : null,
          orig_amount: orig !== "" && Number.isFinite(Number(orig)) ? Number(orig) : null,
          orig_currency: /^[A-Z]{3}$/.test(origCurrency) ? origCurrency : null,
          fx_rate: rate !== "" && Number(rate) > 0 ? Number(rate) : null,
          raw_type: `${category}|${type}`.slice(0, 80),
          source: "trade_republic",
          external_id: id,
        };
      }
    });

    const open = unheldKeys(trades, knownKeys);
    for (const key of open)
      notes.push(
        `${names.get(key) || key} isn't in your holdings, so it was left out. Add it, then import again.`,
      );
    if (reverse > 0)
      notes.push(
        `${plural(reverse, "reverse split wasn't", "reverse splits weren't")} imported. Add ${reverse === 1 ? "it" : "them"} by hand.`,
      );
    if (movedIn > 0)
      notes.push(
        `${plural(movedIn, "row moved shares in", "rows moved shares in")} from elsewhere at no cost: the file doesn't say what you paid. Edit the price in the holding's trades.`,
      );
    if (otherPage > 0)
      notes.push(
        kind === "stock"
          ? `${plural(otherPage, "crypto row is", "crypto rows are")} for the Crypto page: import this file there too.`
          : `${plural(otherPage, "row is", "rows are")} for shares and cash: import this file on the Portfolio page too.`,
      );
    if (card > 0)
      notes.push(
        `${plural(card, "card payment was", "card payments were")} skipped: they're your bank account's. Connect Trade Republic as a bank to see them.`,
      );
    if (unknown > 0)
      notes.push(
        `${plural(unknown, "row of a kind Alopex doesn't know yet was", "rows of kinds Alopex doesn't know yet were")} kept as "other".`,
      );
    return {
      trades: trades.filter((t) => !open.includes(t.key)),
      events: events.filter((e) => !(e.key && open.includes(e.key))),
      errors,
      notes,
      // The file is your whole history, but only for shares: coins also sit in other wallets.
      setsShares: kind === "stock",
      names,
    };
  },
};
