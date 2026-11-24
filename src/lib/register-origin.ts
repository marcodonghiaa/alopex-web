// The owner's browser tells the backend which address the dashboard is served from, so bank linking
// can send them back here and the Edge Functions accept this site in CORS. The backend reads the
// browser's own Origin header (nothing is sent from here) and only accepts the owner. Best effort: an
// older backend without the function, or a refusal, must never get in the way of the app.
/** The backend's answer (added, exists, full, rejected, not_owner, no_origin), or null on failure. */
export async function registerDashboardOrigin(
  register: () => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<string | null> {
  try {
    const { data, error } = await register();
    return !error && typeof data === "string" ? data : null;
  } catch {
    return null; // ignored on purpose, see above
  }
}

// Once per page load (the layout asks first); the Health page reads the same answer, since the
// table itself is not readable from the browser.
export const originStatusQuery = (
  register: () => PromiseLike<{ data: unknown; error: unknown }>,
) => ({
  queryKey: ["dashboard-origin-status"],
  queryFn: () => registerDashboardOrigin(register),
  staleTime: Infinity,
  retry: false,
});
