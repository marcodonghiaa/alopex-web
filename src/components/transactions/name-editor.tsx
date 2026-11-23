import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SegmentedControl } from "@/components/segmented-control";

type Scope = "all" | "one";

// Lets you give a transaction your own name (e.g. a transfer to a friend that is really a
// subscription). An empty name goes back to the one the bank sent. With `scoped`, you pick
// whether the name goes on every transaction like this one (the default) or only on this one.
export function NameEditor({
  name,
  onSave,
  saving,
  scoped = false,
}: {
  name: string | null;
  onSave: (name: string | null, onlyThis: boolean) => void;
  saving: boolean;
  scoped?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState(name ?? "");
  const [scope, setScope] = useState<Scope>("all");

  function save() {
    const next = input.trim();
    setOpen(false);
    if (next === (name ?? "")) return;
    onSave(next === "" ? null : next, scoped && scope === "one");
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setInput(name ?? "");
          setScope("all");
        }
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Rename ${name ?? "transaction"}`}
          disabled={saving}
          className="max-w-full cursor-pointer truncate text-left font-medium text-foreground decoration-dotted underline-offset-4 hover:underline disabled:opacity-60"
        >
          {name ?? "—"}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 space-y-2.5 p-3">
        <label className="block text-xs font-medium text-muted-foreground">
          Name
          <Input
            type="text"
            value={input}
            maxLength={100}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()}
            className="mt-1"
          />
        </label>
        {scoped && (
          <>
            <SegmentedControl
              label="Rename"
              options={[
                { value: "all", label: "All like this" },
                { value: "one", label: "Only this one" },
              ]}
              value={scope}
              onChange={setScope}
            />
            <p className="text-xs text-muted-foreground">
              {scope === "all"
                ? "Past and future ones from this merchant. Apple, PayPal and Google: same price only."
                : "Just this transaction. Others keep their name."}
            </p>
          </>
        )}
        <p className="text-xs text-muted-foreground">Leave empty to use the bank's name.</p>
        <Button onClick={save} className="w-full px-3">
          Save
        </Button>
      </PopoverContent>
    </Popover>
  );
}
