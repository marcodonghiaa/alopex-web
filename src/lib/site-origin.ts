import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestUrl } from "@tanstack/react-start/server";

// The origin this copy of the dashboard is served from, for the few tags that need an absolute
// URL (og:image): each self-hosted copy points at its own address, not the author's.
export const siteOrigin = createIsomorphicFn()
  .server(() => {
    try {
      return getRequestUrl({ xForwardedHost: true, xForwardedProto: true }).origin;
    } catch {
      return ""; // outside a request: a relative URL
    }
  })
  .client(() => window.location.origin);

/** The link-preview image, absolute when the origin is known. */
export const ogImageUrl = (origin: string) => `${origin}/og-image.png`;
