import { createElement, type ComponentType } from "react";
import { ICON_NODES, type IconName } from "./icon-nodes";

export { isIconName } from "./icon-nodes";

export type IconProps = { className?: string; "aria-label"?: string };
export type IconComponent = ComponentType<IconProps>;

/** One icon of the Alopex set, in the text colour; decorative unless given an aria-label. */
export function Icon({ name, className, "aria-label": label }: IconProps & { name: IconName }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? "size-6"}
      data-icon={name}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {ICON_NODES[name].map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs }))}
    </svg>
  );
}

/** A component for one icon, for places that take an icon component (navigation). */
export function iconOf(name: IconName): IconComponent {
  const Named = (props: IconProps) => <Icon name={name} {...props} />;
  Named.displayName = `Icon(${name})`;
  return Named;
}
