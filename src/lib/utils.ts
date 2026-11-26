import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** A colour's tinted circle: the colour itself on a 16% wash of it over the card. */
export const tinted = (color: string) => ({
  color,
  backgroundColor: `color-mix(in oklab, ${color} 16%, var(--color-card))`,
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
