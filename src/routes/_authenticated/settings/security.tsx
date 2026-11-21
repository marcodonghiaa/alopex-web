import { createFileRoute } from "@tanstack/react-router";
import { SecuritySettingsPage } from "@/components/settings/settings-page";

export const Route = createFileRoute("/_authenticated/settings/security")({
  head: () => ({ meta: [{ title: "Security · Settings — Alopex" }] }),
  component: SecuritySettingsPage,
});
