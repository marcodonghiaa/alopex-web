import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { GroupedList } from "@/components/ui/grouped-list";
import { Switch } from "@/components/ui/switch";
import { HIDEABLE_PAGES, setPageHidden, useHiddenPages } from "@/lib/hidden-pages";

/** Settings › App: switch off pages you don't use, so the sidebar and More only list the rest. */
export function MenuPagesSection() {
  const hidden = useHiddenPages();
  const [failed, setFailed] = useState(false);
  return (
    <section aria-labelledby="menu-pages-heading">
      <h2 id="menu-pages-heading" className="text-lg font-semibold text-foreground">
        Pages in the menu
      </h2>
      <p className="mt-1 mb-4 text-sm text-muted-foreground">
        Turn off what you don&apos;t use. Its data stays, and links to it still work. Only on this
        device.
      </p>
      <GroupedList className="max-w-xl">
        {Object.entries(HIDEABLE_PAGES).map(([path, label]) => {
          const on = !hidden.includes(path);
          return (
            <label
              key={path}
              className="flex min-h-11 cursor-pointer items-center justify-between gap-3 px-4 py-2.5"
            >
              <span className="text-[0.9375rem] text-foreground">{label}</span>
              <Switch checked={on} onChange={() => setFailed(!setPageHidden(path, on))} />
            </label>
          );
        })}
      </GroupedList>
      {failed && (
        <Alert className="mt-3 max-w-xl">
          Couldn&apos;t save on this device: the browser blocks site storage.
        </Alert>
      )}
    </section>
  );
}
