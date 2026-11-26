// Where sign-in sends the user back to afterwards. Kept out of the route file so importing it
// doesn't pull the sign-in page into the main bundle.

export function safeNext(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/")) return undefined;
  // Parse (not regex-match) so the URL parser's own backslash/protocol-relative
  // normalization catches bypasses like "/\evil.com" -> "//evil.com" that a
  // leading-slash regex alone would miss.
  try {
    const parsed = new URL(value, window.location.origin);
    return parsed.origin === window.location.origin ? value : undefined;
  } catch {
    return undefined;
  }
}

// The hash (a bank's #bank_code) is kept out of ?next=: a reload of /auth would send it to the
// dashboard host. It waits in this tab's sessionStorage, for the page it came from.
const SAVED_HASH = "alopex.next-hash";

/** Sign-in's search for coming back to this page afterwards; withSavedHash adds the hash back. */
export function backHereSearch(location: { pathname: string; searchStr: string; hash: string }): {
  next?: string;
} {
  const path = location.pathname + location.searchStr;
  if (!location.hash) return path === "/" ? {} : { next: path };
  try {
    sessionStorage.setItem(SAVED_HASH, JSON.stringify({ path, hash: location.hash }));
    return { next: path };
  } catch {
    return { next: `${path}#${location.hash}` };
  }
}

/** `next` with the hash backHereSearch saved for it, once. */
export function withSavedHash(next: string): string {
  try {
    const raw = sessionStorage.getItem(SAVED_HASH);
    sessionStorage.removeItem(SAVED_HASH);
    const saved = raw ? (JSON.parse(raw) as { path?: unknown; hash?: unknown }) : null;
    if (saved?.path === next && typeof saved.hash === "string") return `${next}#${saved.hash}`;
  } catch {
    // No storage: next is used as it is.
  }
  return next;
}
