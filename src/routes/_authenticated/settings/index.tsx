import { createFileRoute, redirect } from "@tanstack/react-router";
import { SettingsIndexPage } from "@/components/settings/settings-page";

/** Desktop has the settings menu on the side, so /settings opens straight on Overview. */
const isWide = () =>
  typeof window !== "undefined" && window.matchMedia?.("(min-width: 768px)").matches;

// Settings used to be one page: its anchors now live on these pages. Anything else is Overview's.
const PAGE_OF_ANCHOR: Record<
  string,
  "/settings/personalization" | "/settings/security" | "/settings/account"
> = {
  categories: "/settings/personalization",
  account: "/settings/security",
  "two-step": "/settings/security",
  data: "/settings/account",
};

export const Route = createFileRoute("/_authenticated/settings/")({
  beforeLoad: ({ location }) => {
    // Keep the hash: old /settings#health (and other section) links still land on their section.
    if (isWide() || location.hash)
      throw redirect({
        to: PAGE_OF_ANCHOR[location.hash] ?? "/settings/overview",
        ...(location.hash && { hash: location.hash }),
        replace: true,
      });
  },
  component: SettingsIndexPage,
});
