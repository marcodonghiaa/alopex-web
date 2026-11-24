import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { CategoryAvatar } from "@/components/category-avatar";
import { Icon } from "@/components/icons/icon";
import { CATEGORY_ICON_NAMES, ICON_LABELS, type IconName } from "@/components/icons/icon-nodes";
import {
  ALWAYS_SHOWN,
  CATEGORIES,
  CATEGORY_PALETTE,
  PALETTE_COLORS,
  categoryIconName,
  checkCategoryName,
  MAX_CATEGORY_NAME,
  pickedColor,
  type PaletteColor,
} from "@/lib/categories";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type EditTarget =
  { kind: "new"; name: string } | { kind: "edit"; name: string; hidden: boolean };

const BUILT_IN = CATEGORIES as ReadonlyArray<string>;

/**
 * Add or edit a category: name, icon and colour, with a live preview. Deleting one of your own
 * asks where its transactions go and moves them there (move_category), so none is left on a
 * category that no longer exists. A new name moves everything the same way: that is a rename.
 */
export function CategoryEditor({
  target,
  categories,
  onClose,
}: {
  target: EditTarget;
  /** Every category in use (built-in and yours, hidden ones too), to refuse a taken name. */
  categories: ReadonlyArray<{ name: string; hidden: boolean }>;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const isNew = target.kind === "new";
  const original = target.name;
  const locked = !isNew && ALWAYS_SHOWN.includes(original);
  const [name, setName] = useState(original);
  const [icon, setIcon] = useState<string | null>(isNew ? null : categoryIconName(original));
  const [color, setColor] = useState<PaletteColor | null>(isNew ? null : pickedColor(original));
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const moveTargets = categories.filter((c) => !c.hidden && c.name !== original).map((c) => c.name);
  const [moveTo, setMoveTo] = useState(
    moveTargets.includes("Others") ? "Others" : (moveTargets[0] ?? ""),
  );

  const done = () => void queryClient.invalidateQueries();
  const save = useMutation({
    mutationFn: async (next: string) => {
      const look = { icon, color };
      if (isNew) {
        const { error } = await supabase.from("user_categories").insert({ name: next, ...look });
        if (error) throw new Error(error.message);
        return;
      }
      // The look goes on the current name first, so a rename carries it over.
      const { error } = await supabase
        .from("user_categories")
        .upsert({ name: original, hidden: target.hidden, ...look }, { onConflict: "user_id,name" });
      if (error) throw new Error(error.message);
      if (next !== original) {
        const moved = await supabase.rpc("move_category", { p_from: original, p_to: next });
        if (moved.error) throw new Error(moved.error.message);
      }
    },
    onSuccess: () => {
      done();
      toast.success(isNew ? "Category added" : "Category saved");
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });
  const remove = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("move_category", {
        p_from: original,
        p_to: moveTo,
      });
      if (error) throw new Error(error.message);
      return data ?? 0;
    },
    onSuccess: (moved) => {
      done();
      toast.success(`Deleted "${original}"`, {
        description:
          moved > 0
            ? `${moved} ${moved === 1 ? "transaction" : "transactions"} moved to ${moveTo}.`
            : undefined,
      });
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });
  const busy = save.isPending || remove.isPending;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    // Renaming onto another category merges the two: that is Delete, which says where things go.
    const others = categories.filter((c) => c.name !== original).map((c) => c.name);
    const { name: next, error: invalid } = checkCategoryName(name, others);
    if (invalid) return setError(invalid);
    setError(null);
    save.mutate(next);
  }

  const preview = name.trim() || "New category";
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-w-md" closeDisabled={busy}>
        <DialogHeader>
          <DialogTitle>
            {isNew ? "New category" : deleting ? `Delete "${original}"` : "Edit category"}
          </DialogTitle>
          <DialogDescription>
            {deleting
              ? "Its transactions, rules, subscriptions and budgets move to the category you pick."
              : "Pick an icon and a colour so it reads at a glance everywhere."}
          </DialogDescription>
        </DialogHeader>

        {deleting ? (
          <div className="space-y-4">
            <label className="block space-y-1.5 text-sm">
              <span className="text-muted-foreground">Move them to</span>
              <Select
                value={moveTo}
                onChange={(e) => setMoveTo(e.target.value)}
                className="w-full px-4"
              >
                {moveTargets.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </label>
            {error && (
              <p role="alert" className="text-sm text-negative">
                {error}
              </p>
            )}
            <DialogFooter className="gap-2">
              <Button variant="quiet" disabled={busy} onClick={() => setDeleting(false)}>
                Back
              </Button>
              <Button disabled={busy || !moveTo} onClick={() => remove.mutate()}>
                {remove.isPending ? "Deleting…" : "Move and delete"}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-5">
            <div className="flex items-center gap-3">
              <CategoryAvatar category={preview} size="lg" look={{ icon, color }} />
              <Input
                aria-label="Name"
                value={name}
                maxLength={MAX_CATEGORY_NAME}
                disabled={locked}
                onChange={(e) => setName(e.target.value)}
                className="flex-1 px-4"
              />
            </div>

            <fieldset>
              <legend className="mb-2 text-sm text-muted-foreground">Icon</legend>
              <div
                role="radiogroup"
                aria-label="Icon"
                className="grid grid-cols-6 gap-1.5 sm:grid-cols-8"
              >
                <Choice
                  label="First letter"
                  selected={icon === null}
                  onSelect={() => setIcon(null)}
                >
                  <span className="text-sm font-semibold">{preview.charAt(0).toUpperCase()}</span>
                </Choice>
                {CATEGORY_ICON_NAMES.map((n: IconName) => (
                  <Choice
                    key={n}
                    label={ICON_LABELS[n]}
                    selected={icon === n}
                    onSelect={() => setIcon(n)}
                  >
                    <Icon name={n} className="size-5" />
                  </Choice>
                ))}
              </div>
            </fieldset>

            <fieldset>
              <legend className="mb-2 text-sm text-muted-foreground">Colour</legend>
              <div role="radiogroup" aria-label="Colour" className="flex flex-wrap gap-1.5">
                <Choice
                  label="Default colour"
                  selected={color === null}
                  onSelect={() => setColor(null)}
                  round
                >
                  <span className="size-5 rounded-full border border-dashed border-muted-foreground" />
                </Choice>
                {PALETTE_COLORS.map((c) => (
                  <Choice
                    key={c}
                    label={c}
                    selected={color === c}
                    onSelect={() => setColor(c)}
                    round
                  >
                    <span
                      className="size-5 rounded-full"
                      style={{ backgroundColor: CATEGORY_PALETTE[c] }}
                    />
                  </Choice>
                ))}
              </div>
            </fieldset>

            {error && (
              <p role="alert" className="text-sm text-negative">
                {error}
              </p>
            )}
            <DialogFooter className="gap-2">
              {!isNew && !BUILT_IN.includes(original) && (
                <Button
                  variant="destructive"
                  className="sm:mr-auto"
                  disabled={busy}
                  onClick={() => {
                    setError(null);
                    setDeleting(true);
                  }}
                >
                  Delete…
                </Button>
              )}
              <Button variant="quiet" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {save.isPending ? "Saving…" : isNew ? "Add" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Choice({
  label,
  selected,
  onSelect,
  round = false,
  children,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
  round?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      title={label}
      onClick={onSelect}
      className={`flex items-center justify-center text-foreground transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${round ? "size-11 rounded-full" : "aspect-square min-h-11 rounded-md"} ${selected ? "bg-accent ring-2 ring-foreground" : ""}`}
    >
      {children}
    </button>
  );
}
