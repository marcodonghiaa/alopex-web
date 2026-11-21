import { createFileRoute } from "@tanstack/react-router";
import { OverviewSettingsPage } from "@/components/settings/settings-page";

export const Route = createFileRoute("/_authenticated/settings/overview")({
  head: () => ({ meta: [{ title: "Overview · Settings — Alopex" }] }),
  component: OverviewSettingsPage,
});
