import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { ALWAYS_SHOWN, CATEGORIES } from "@/lib/categories";
import { CATEGORIES_KEY, useCategories } from "@/lib/use-categories";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { GroupedList } from "@/components/ui/grouped-list";
import { CategoryAvatar } from "@/components/category-avatar";
import { CategoryEditor, type EditTarget } from "./category-editor";

// Your categories: add your own, give any of them an icon and a colour, hide built-in ones you
// don't use. Pickers everywhere and the AI categorizer use the result. A hidden category stays on
// the transactions that have it; deleting one of yours moves them to a category you pick.
export function CategoriesSection() {
  const queryClient = useQueryClient();
  const { list, settings, available, looksAvailable, isPending } = useCategories();
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [error, setError] = useState<string | null>(null);

  const done = () => void queryClient.invalidateQueries({ queryKey: CATEGORIES_KEY });
  const onError = (err: Error) => toast.error("Couldn't save", { description: err.message });

  const save = useMutation({
    mutationFn: async (row: { name: string; hidden: boolean }) => {
      const { error } = await supabase.from("user_categories").upsert(row);
      if (error) throw new Error(error.message);
    },
    onSuccess: done,
    onError,
  });
  const remove = useMutation({
    mutationFn: async (category: string) => {
      const { error } = await supabase.from("user_categories").delete().eq("name", category);
      if (error) throw new Error(error.message);
    },
    onSuccess: done,
    onError,
  });

  const builtIn = CATEGORIES as ReadonlyArray<string>;
  const hidden = new Set(settings.filter((s) => s.hidden).map((s) => s.name));
  const own = list.filter((c) => !builtIn.includes(c));
  const busy = save.isPending || remove.isPending;

  function add(e: React.FormEvent) {
    e.preventDefault();
    const next = name.trim().replace(/\s+/g, " ");
    if (!next) return setError("Type a name.");
    if (next.length > 40) return setError("At most 40 characters.");
    const taken = [...builtIn, ...own].some((c) => c.toLowerCase() === next.toLowerCase());
    if (taken) return setError(`"${next}" is already in the list.`);
    setError(null);
    // With icons available, Add opens the editor to pick the look; the category is saved there.
    if (looksAvailable) {
      setEditing({ kind: "new", name: next });
      setName("");
      return;
    }
    save.mutate({ name: next, hidden: false }, { onSuccess: () => setName("") });
  }
  const everyCategory = [...builtIn, ...own].map((c) => ({ name: c, hidden: hidden.has(c) }));

  return (
    <section
      id="categories"
      aria-labelledby="categories-heading"
      className="scroll-mt-20 md:scroll-mt-6"
    >
      <h2 id="categories-heading" className="mb-4 text-lg font-semibold text-foreground">
        Categories
      </h2>
      {!isPending && !available ? (
        <p className="text-sm text-muted-foreground">
          Your own categories need a database update first: run supabase db push --linked in the
          backend.
        </p>
      ) : (
        <div className="space-y-4">
          <form onSubmit={add} className="flex gap-2">
            <Input
              aria-label="New category"
              placeholder="New category"
              value={name}
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
              className="flex-1 px-4"
            />
            <Button type="submit" disabled={busy}>
              Add
            </Button>
          </form>
          {error && (
            <p role="alert" className="text-sm text-negative">
              {error}
            </p>
          )}
          <GroupedList>
            <ul className="divide-y divide-hairline">
              {[...builtIn, ...own].map((c) => {
                const isOwn = !builtIn.includes(c);
                const isHidden = hidden.has(c);
                return (
                  <li key={c} className="flex min-h-12 items-center gap-3 px-4 py-1">
                    <CategoryAvatar category={c} size="sm" />
                    <span
                      className={`min-w-0 flex-1 truncate text-sm ${isHidden ? "text-muted-foreground line-through" : "text-foreground"}`}
                    >
                      {c}
                    </span>
                    {isOwn ? (
                      looksAvailable ? null : (
                        <Button
                          variant="ghost"
                          className="px-3"
                          disabled={busy}
                          onClick={() => remove.mutate(c)}
                        >
                          Delete
                        </Button>
                      )
                    ) : ALWAYS_SHOWN.includes(c) ? null : isHidden ? (
                      <Button
                        variant="ghost"
                        className="px-3"
                        disabled={busy}
                        // Unhide only: the row may also carry the category's icon and colour.
                        onClick={() => save.mutate({ name: c, hidden: false })}
                      >
                        Show
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        className="px-3"
                        disabled={busy}
                        onClick={() => save.mutate({ name: c, hidden: true })}
                      >
                        Hide
                      </Button>
                    )}
                    {looksAvailable && (
                      <Button
                        variant="ghost"
                        className="px-3"
                        disabled={busy}
                        aria-label={`Edit ${c}`}
                        onClick={() => setEditing({ kind: "edit", name: c, hidden: isHidden })}
                      >
                        Edit
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </GroupedList>
          {!isPending && !looksAvailable && (
            <p className="text-sm text-muted-foreground">
              Icons, colours and moving transactions when you delete a category need a database
              update: run supabase db push --linked in the backend.
            </p>
          )}
          {editing && (
            <CategoryEditor
              key={editing.kind + editing.name}
              target={editing}
              categories={everyCategory}
              onClose={() => setEditing(null)}
            />
          )}
        </div>
      )}
    </section>
  );
}
