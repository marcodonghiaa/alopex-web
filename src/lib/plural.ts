import { numberFormat } from "@/lib/locale";

// "1 transaction", "2,000 transactions": the count in the app's locale (2.000 in Italian).
export const plural = (n: number, word = "transaction") =>
  `${numberFormat().format(n)} ${word}${n === 1 ? "" : "s"}`;
