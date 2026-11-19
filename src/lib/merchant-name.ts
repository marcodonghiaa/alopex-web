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
  /^(amazon|amzn)(\.[a-z]{2,3})*(\s+(mark|mktp|reta|payment|eu)\w*)*(\s+[a-z]{2})?(\s+(sarl|s\.?\s?a\.?\s?r\.?\s?l\.?|s\.?c\.?a\.?))?\s*(\*.*)?$/i;
/** Words a card or POS terminal puts before the merchant ("POS LIDL"), followed by a letter. */
const CARD_PREFIX =
  /^(pos( purchase)?|(debit )?card (payment|purchase)( to| at)?|contactless( payment)?|pagamento (pos|carta)|acquisto (pos|carta)|kartenzahlung|compra con tarjeta) (?=\p{L})/iu;
/** A whole name that is a web address: "NETFLIX.COM", "www.ryanair.com", "apple.com/bill". */
const DOMAIN =
  /^(www\.)?([a-z0-9-]+)\.(com|it|io|eu|net|org|co|uk|de|fr|es|nl|be|at|ch|ie|pt|pl|app|tv|me)(\/\S*)?$/i;

export function cleanMerchantName(raw: string): string;
export function cleanMerchantName(raw: string | null | undefined): string | null;
export function cleanMerchantName(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const input = raw.trim().replace(/\s+/g, " ");
  if (AMAZON.test(input)) return "Amazon";

  // Bank text is upper case; a name a person typed ("POS system") is left alone.
  let name = input === input.toUpperCase() ? input.replace(CARD_PREFIX, "") : input;
  const star = name.indexOf("*");
  if (star >= 0) {
    const left = name.slice(0, star).trim();
    const right = name.slice(star + 1).trim();
    // A processor tag hides the merchant after it, unless only a code follows ("PAYPAL *1234AB");
    // otherwise "Merchant*REF": keep the merchant.
    const merchantFollows = /^(?=[^\s\d]*\p{L}{2})[^\s\d]*(\s|$)/u.test(right);
    name = PROCESSORS.has(left.toLowerCase()) && merchantFollows ? right : left;
  }

  const domain = DOMAIN.exec(name);
  if (domain?.[2]) name = domain[2];

  name = name
    .replace(/(?<![\s-])[\s-]+\d{5,}$/, "") // store or terminal number: "Mbta-550057141438"
    .replace(/(?<=\p{L}{4})\s+&\s*\S?$/u, "") // cut off mid-word: "Bagels & S"; "H & M" stays
    .trim();

  if (!name) return raw;
  // Capitalise only what was cut ("Tst*zuckers" -> "Zuckers"); "eBay" stays as typed.
  return name === input ? name : name.charAt(0).toUpperCase() + name.slice(1);
}
