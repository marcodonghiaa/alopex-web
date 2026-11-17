// Card statements carry the payment processor and reference codes in the merchant field
// ("Tst*zuckers Bagels & S", "Amazon Mark* Tg3ql5f23"). For display only: rules, search and
// renames keep using the stored name.

/** Processors that put their own tag before the "*": the merchant follows it. */
const PROCESSORS = new Set(["tst", "sq", "sp", "paypal", "pp", "sumup", "zettle", "iz", "crv"]);
const AMAZON = /^(amazon(\s*(mark|mktp|reta|marketplace|prime))?|amzn(\s*mktp)?)\b/i;

export function cleanMerchantName(raw: string): string;
export function cleanMerchantName(raw: string | null): string | null;
export function cleanMerchantName(raw: string | null): string | null {
  if (raw == null) return null;
  let name = raw.trim().replace(/\s+/g, " ");
  if (AMAZON.test(name)) return "Amazon";

  const star = name.indexOf("*");
  if (star >= 0) {
    const left = name.slice(0, star).trim();
    const right = name.slice(star + 1).trim();
    // A processor tag hides the merchant after it; otherwise "Merchant*CITY": keep the merchant.
    name = PROCESSORS.has(left.toLowerCase()) ? right : left;
  }

  name = name
    .replace(/[\s-]+\d{5,}$/, "") // store or terminal number: "Mbta-550057141438"
    .replace(/\s+&\s*\S?$/, "") // cut off mid-word: "Bagels & S"
    .trim();

  if (!name) return raw;
  return name.charAt(0).toUpperCase() + name.slice(1);
}
