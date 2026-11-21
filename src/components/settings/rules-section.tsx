import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { GroupedList } from "@/components/ui/grouped-list";

// Rules are setup, not a page you visit daily, so they live in Settings instead of the sidebar.
export function RulesSection() {
  return (
    <section aria-labelledby="rules-heading">
      <h2 id="rules-heading" className="mb-4 text-lg font-semibold text-foreground">
        Rules
      </h2>
      <GroupedList className="max-w-sm">
        <Link
          to="/rules"
          className="flex min-h-11 items-center gap-3 px-4 py-3 text-foreground transition-colors hover:bg-accent active:bg-accent"
        >
          <span className="flex-1">
            <span className="block text-[0.9375rem]">Category rules</span>
            <span className="block text-sm text-muted-foreground">
              Sort transactions into categories automatically.
            </span>
          </span>
          <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
        </Link>
      </GroupedList>
    </section>
  );
}
