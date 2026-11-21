import { createFileRoute, redirect } from "@tanstack/react-router";
import { SettingsIndexPage } from "@/components/settings/settings-page";

/** Desktop has the settings menu on the side, so /settings opens straight on Overview. */
const isWide = () =>
  typeof window !== "undefined" && window.matchMedia?.("(min-width: 768px)").matches;

export const Route = createFileRoute("/_authenticated/settings/")({
  beforeLoad: ({ location }) => {
    // Keep the hash: old /settings#health links still land on the Health section.
    if (isWide() || location.hash)
      throw redirect({
        to: "/settings/overview",
        ...(location.hash && { hash: location.hash }),
        replace: true,
      });
  },
  component: SettingsIndexPage,
});
