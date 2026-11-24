import { Icon, isIconName } from "@/components/icons/icon";
import {
  CATEGORY_PALETTE,
  categoryColor,
  categoryIconName,
  isPaletteColor,
  type CategoryLook,
} from "@/lib/categories";

/**
 * 40px circle with the category's line icon, tinted in the category colour, so rows scan by
 * what the money went on. The icon and colour are the ones picked in Settings › Categories, else
 * the built-in ones; a category with no icon shows its initial; no category shows a dashed circle.
 */
export function CategoryAvatar({
  category,
  size = "md",
  look,
}: {
  category: string | null;
  size?: "sm" | "md" | "lg";
  /** Draw this icon and colour instead of the saved ones (the editor's preview). */
  look?: CategoryLook;
}) {
  const missing = !category || category === "Uncategorized";
  const name = missing ? "uncategorized" : look ? (look.icon ?? null) : categoryIconName(category);
  const color = isPaletteColor(look?.color)
    ? CATEGORY_PALETTE[look.color]
    : categoryColor(category);
  return (
    <span
      aria-hidden
      data-category={category ?? ""}
      className={`flex shrink-0 items-center justify-center rounded-full ${size === "sm" ? "size-8" : size === "lg" ? "size-14" : "size-10"}`}
      style={{ color, backgroundColor: `color-mix(in oklab, ${color} 16%, var(--color-card))` }}
    >
      {isIconName(name) ? (
        <Icon
          name={name}
          className={size === "sm" ? "size-4" : size === "lg" ? "size-7" : "size-5"}
        />
      ) : (
        <span
          className={`font-semibold ${size === "sm" ? "text-[0.8125rem]" : size === "lg" ? "text-xl" : "text-[0.9375rem]"}`}
        >
          {(category?.trim().charAt(0) || "-").toUpperCase()}
        </span>
      )}
    </span>
  );
}
