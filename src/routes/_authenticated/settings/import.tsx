import { createFileRoute } from "@tanstack/react-router";
import { ImportSettingsPage } from "@/components/settings/settings-page";

export const Route = createFileRoute("/_authenticated/settings/import")({
  head: () => ({ meta: [{ title: "Import · Settings — Alopex" }] }),
  component: ImportSettingsPage,
});
