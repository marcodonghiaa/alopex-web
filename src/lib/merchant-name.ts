// Card statements carry the payment processor and reference codes in the merchant field
// ("Tst*zuckers Bagels & S", "Amazon Mark* Tg3ql5f23"). For display only: rules, search and
// renames keep using the stored name. Same file in alopex (supabase/functions/_shared/, push
// notifications): keep the two copies and merchant-name.cases.json in sync.

/** Processors that put their own tag before the "*": the merchant follows it. */
const PROCESSORS = new Set(
  (
    "tst sq squ sp paypal pp sumup zettle zettle_ iz crv py mgp ubr eb nyx satispay nexi stripe " +
    "square nayax mypos viva google gpay applepay"
  ).split(" "),
);
/** Amazon's shop charges ("Amazon Mark* X", "AMZN Mktp DE", "Amazon.it*AB"), not every name that starts with Amazon. */
const AMAZON =
  /^(amazon|amzn)(\.[a-z]{2,3})*(\s+(mark|mktp|mktplace|marketplace|reta|retail|payments?|eu|europe)\w*)*(\s+[a-z]{2})?\s*(\*.*)?$/i;
/** Words a card or POS terminal puts before the merchant ("POS LIDL", "Card payment to Lidl"). */
const CARD_PREFIX =
  /^(pos( purchase)?|(debit )?card (payment|purchase)( to| at)?|contactless( payment)?|pagamento (pos|carta)|acquisto (pos|carta)|kartenzahlung|compra con tarjeta)\s+(?=\S)/i;
/** A whole name that is a web address: "NETFLIX.COM", "www.ryanair.com", "apple.com/bill". */
const DOMAIN =
  /^(www\.)?([a-z0-9-]+)\.(com|it|io|eu|net|org|co|uk|de|fr|es|nl|be|at|ch|ie|pt|pl|app|tv|me)(\/\S*)?$/i;

const isReference = (t: string) =>
  /^#\d+$/.test(t) ||
  /^\d{1,2}[./]\d{1,2}([./]\d{2,4})?$/.test(t) ||
  (t.length >= 6 && /\d/.test(t) && /\p{L}/u.test(t));

export function cleanMerchantName(raw: string): string;
export function cleanMerchantName(raw: string | null | undefined): string | null;
export function cleanMerchantName(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let name = raw.trim().replace(/\s+/g, " ");
  if (AMAZON.test(name)) return "Amazon";

  name = name.replace(CARD_PREFIX, "");
  const star = name.indexOf("*");
  if (star >= 0) {
    const left = name.slice(0, star).trim();
    const right = name.slice(star + 1).trim();
    // A processor tag hides the merchant after it; otherwise "Merchant*REF": keep the merchant.
    name = PROCESSORS.has(left.toLowerCase()) ? right : left;
  }

  const domain = DOMAIN.exec(name);
  if (domain?.[2]) name = domain[2];

  // Reference codes at the end go: "E46na7fw3", "#1234", "12/03". "Hotel 31" and "Route 66" stay.
  const words = name.split(" ");
  while (words.length > 1 && isReference(words[words.length - 1] ?? "")) words.pop();
  name = words
    .join(" ")
    .replace(/[\s-]+\d{5,}$/, "") // store or terminal number: "Mbta-550057141438"
    .replace(/\s+&\s*\S?$/, "") // cut off mid-word: "Bagels & S"
    .trim();

  if (!name) return raw;
  return name.charAt(0).toUpperCase() + name.slice(1);
}
