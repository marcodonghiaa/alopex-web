import { createFileRoute, redirect } from "@tanstack/react-router";

// Import moved to Settings › Import; old links and bookmarks land there.
export const Route = createFileRoute("/_authenticated/import")({
  beforeLoad: ({ location }) => {
    throw redirect({
      to: "/settings/import",
      ...(location.hash && { hash: location.hash }),
      replace: true,
    });
  },
});
