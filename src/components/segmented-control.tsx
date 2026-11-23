import type { KeyboardEvent } from "react";

interface Option<T extends string> {
  value: T;
  label: string;
}

interface SegmentedControlProps<T extends string> {
  label: string;
  /** id of a visible label: the group is named by it instead of `label`, so it's read once. */
  labelledBy?: string;
  options: Array<Option<T>>;
  value: T;
  onChange: (value: T) => void;
  /** Inside a popover or form: 32px segments (36px on phones, hit area kept at 44px). */
  compact?: boolean;
}

// Same-surface choice (DESIGN.md "Segmented Control"): a Fill pill track, sans labels, one ink pill
// slides under the selected option. 44px tall on phones (thumb targets, often right under a
// touch-scrubbed chart), 36px from md up. `compact` is for small surfaces like a popover.
export function SegmentedControl<T extends string>({
  label,
  labelledBy,
  options,
  value,
  onChange,
  compact = false,
}: SegmentedControlProps<T>) {
  const index = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // The standard radio-group keys: arrows step (and wrap), Home/End jump to the ends.
    const last = options.length - 1;
    const target: Record<string, number> = {
      ArrowRight: index === last ? 0 : index + 1,
      ArrowDown: index === last ? 0 : index + 1,
      ArrowLeft: index === 0 ? last : index - 1,
      ArrowUp: index === 0 ? last : index - 1,
      Home: 0,
      End: last,
    };
    const nextIndex = target[event.key];
    if (nextIndex === undefined) return;
    event.preventDefault();
    const next = options[nextIndex];
    if (!next) return;
    onChange(next.value);
    // Roving focus: the selected radio is the only tabbable one, so focus follows the selection
    // (otherwise it stays on a button that just became tabIndex -1).
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[nextIndex]?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      onKeyDown={onKeyDown}
      className="relative grid rounded-full bg-muted p-0.5"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      <div
        aria-hidden
        className="absolute inset-y-0.5 left-0.5 rounded-full bg-primary transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none"
        style={{
          width: `calc((100% - 0.25rem) / ${options.length})`,
          transform: `translateX(${index * 100}%)`,
        }}
      />
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={`relative z-10 rounded-full px-3 text-[0.8125rem] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
              selected ? "text-primary-foreground" : "text-muted-foreground hover:text-foreground"
            } ${
              compact
                ? "min-h-9 after:absolute after:inset-x-0 after:-inset-y-1 after:content-[''] md:min-h-8 md:after:hidden"
                : "min-h-11 md:min-h-9"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
