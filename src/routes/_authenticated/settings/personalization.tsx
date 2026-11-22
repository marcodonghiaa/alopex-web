import { createFileRoute } from "@tanstack/react-router";
import { PersonalizationSettingsPage } from "@/components/settings/settings-page";

export const Route = createFileRoute("/_authenticated/settings/personalization")({
  head: () => ({ meta: [{ title: "Personalization · Settings — Alopex" }] }),
  component: PersonalizationSettingsPage,
});
