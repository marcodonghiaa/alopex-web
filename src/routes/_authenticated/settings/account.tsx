import { createFileRoute } from "@tanstack/react-router";
import { AccountSettingsPage } from "@/components/settings/settings-page";

export const Route = createFileRoute("/_authenticated/settings/account")({
  head: () => ({ meta: [{ title: "Account · Settings — Alopex" }] }),
  component: AccountSettingsPage,
});
