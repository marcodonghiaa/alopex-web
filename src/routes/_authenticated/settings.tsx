import { createFileRoute, Outlet } from "@tanstack/react-router";

// Settings is its own screen: the app sidebar gives way to the settings menu (see route.tsx).
export const Route = createFileRoute("/_authenticated/settings")({
  head: () => ({
    meta: [
      { title: "Settings — Alopex" },
      { name: "description", content: "Health checks, formats, menus, categories and account." },
    ],
  }),
  component: Outlet,
});
