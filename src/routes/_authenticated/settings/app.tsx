import { createFileRoute } from "@tanstack/react-router";
import { AppSettingsPage } from "@/components/settings/settings-page";

export const Route = createFileRoute("/_authenticated/settings/app")({
  head: () => ({ meta: [{ title: "App · Settings — Alopex" }] }),
  component: AppSettingsPage,
});
