import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

// White list on the snow ground (DESIGN.md "Grouped Lists"): 8px corners, hairline dividers, no outline.
export function GroupedList({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("divide-y divide-hairline overflow-hidden rounded-lg bg-card", className)}
      {...props}
    />
  );
}

// A section's title, styled like Net Worth's "Breakdown" card everywhere. `label` is the muted
// 13px line inset with the rows, for day dividers and counts ("Today", "3 rules").
export function SectionTitle({
  children,
  action,
  className,
  variant = "title",
  id,
}: {
  children: ReactNode;
  /** For aria-labelledby: lets a section take its name from this heading. */
  id?: string;
  action?: ReactNode;
  className?: string;
  variant?: "title" | "label";
}) {
  const label = variant === "label";
  return (
    <div
      className={cn(
        "flex items-end justify-between gap-3",
        label ? "px-4 pb-1.5" : "pb-2",
        className,
      )}
    >
      <h2
        id={id}
        className={
          label
            ? "text-[0.8125rem] leading-tight font-medium text-muted-foreground"
            : "text-lg font-semibold text-foreground"
        }
      >
        {children}
      </h2>
      {action}
    </div>
  );
}
