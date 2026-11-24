// connect-src must name the Supabase this dashboard was built for: hosted (<ref>.supabase.co),
// self-hosted on a custom domain, or local (http://127.0.0.1:54321). A fixed *.supabase.co would
// block sign-in for every self-hoster. ws(s):// is the same origin for Supabase Realtime.
// Public exchange rates for days older than the ones the sync stored, read when a wallet export
// is priced in dollars (src/lib/brokers/rates.ts). The same source the backend sync uses.
export const FX_HISTORY = "https://api.frankfurter.dev";

export function connectSrc(supabaseUrl: string | undefined): string {
  let url: URL;
  try {
    url = new URL(supabaseUrl ?? "");
  } catch {
    return `'self' ${FX_HISTORY}`;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return `'self' ${FX_HISTORY}`;
  const ws = url.protocol === "https:" ? "wss:" : "ws:";
  return `'self' ${url.origin} ${ws}//${url.host} ${FX_HISTORY}`;
}

// script-src allows 'unsafe-inline' because TanStack Start SSR injects a per-request inline
// hydration script whose content (and therefore hash) varies every render -- a nonce would need
// framework-level SSR changes. Still blocks remote script inclusion, framing, and MIME-sniffing.
// form-action 'self': every form is handled in script; none posts to another site.
export function contentSecurityPolicy(supabaseUrl: string | undefined): string {
  return (
    "default-src 'self'; script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    `img-src 'self' data: https:; connect-src ${connectSrc(supabaseUrl)}; ` +
    "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'"
  );
}
