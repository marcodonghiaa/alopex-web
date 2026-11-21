import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  ChevronRight,
  Gauge,
  LayoutGrid,
  Palette,
  ShieldCheck,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { GroupedList } from "@/components/ui/grouped-list";
import { isDemoMode } from "@/lib/demo/mode";

export interface SettingsSection {
  label: string;
  to: string;
  icon: LucideIcon;
  hint: string;
  /** Sub-pages listed under it in the sidebar. */
  children?: Array<{ label: string; to: string; hash?: string }>;
  /** Needs a real account: the demo leaves it out. */
  account?: boolean;
}

export const SETTINGS_SECTIONS: Array<SettingsSection> = [
  {
    label: "Overview",
    to: "/settings/overview",
    icon: Gauge,
    hint: "Health, number and date format, notifications",
  },
  {
    label: "App",
    to: "/settings/app",
    icon: LayoutGrid,
    hint: "Choose which pages the menu shows",
  },
  {
    label: "Personalization",
    to: "/settings/personalization",
    icon: Palette,
    hint: "Categories and rules",
    children: [
      { label: "Categories", to: "/settings/personalization", hash: "categories" },
      { label: "Rules", to: "/rules" },
    ],
  },
  {
    label: "Security",
    to: "/settings/security",
    icon: ShieldCheck,
    hint: "Password and two-step sign-in",
    account: true,
  },
  {
    label: "Account",
    to: "/settings/account",
    icon: UserRound,
    hint: "Download your data, delete your account",
    account: true,
  },
];

/** The sections this session can use: the demo has no real account to secure or delete. */
export const settingsSections = () =>
  isDemoMode() ? SETTINGS_SECTIONS.filter((s) => !s.account) : SETTINGS_SECTIONS;

/** Paths that show the settings sidebar instead of the app's (Rules is part of Personalization). */
export const isSettingsPath = (pathname: string) =>
  pathname === "/settings" || pathname.startsWith("/settings/") || pathname === "/rules";

// Same look as the app sidebar (DESIGN.md "Navigation").
const LINK =
  "flex items-center gap-3 rounded-sm px-3 py-2 text-[0.9375rem] text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground";
const LINK_ACTIVE =
  "flex items-center gap-3 rounded-sm px-3 py-2 text-[0.9375rem] font-medium bg-sidebar-accent text-foreground";
const SUB =
  "block rounded-sm py-1.5 pr-3 pl-[2.625rem] text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground";

/** Desktop: replaces the app sidebar while in Settings, like most sites' settings screens. */
export function SettingsSidebar({ backTo, pathname }: { backTo: string; pathname: string }) {
  return (
    <nav aria-label="Settings" className="flex-1 space-y-4 overflow-y-auto px-3 py-3">
      <Link to={backTo} className={LINK}>
        <ArrowLeft className="size-[1.125rem] shrink-0" />
        Back to app
      </Link>
      <div>
        <div className="eyebrow px-3 pb-2">Settings</div>
        <div className="space-y-0.5">
          {settingsSections().map((s) => (
            <div key={s.to}>
              <Link
                to={s.to}
                className={LINK}
                activeOptions={{ exact: true }}
                activeProps={{ className: LINK_ACTIVE }}
              >
                <s.icon className="size-[1.125rem] shrink-0" />
                {s.label}
              </Link>
              {s.children?.map((c) => (
                <Link
                  key={c.label}
                  to={c.to}
                  {...(c.hash && { hash: c.hash })}
                  aria-current={c.to === "/rules" && pathname === "/rules" ? "page" : undefined}
                  className={`${SUB} aria-[current=page]:font-medium aria-[current=page]:text-foreground`}
                >
                  {c.label}
                </Link>
              ))}
            </div>
          ))}
        </div>
      </div>
    </nav>
  );
}

/** Phone: Settings opens on this list; each row is its own page. */
export function SettingsMenuList() {
  return (
    <GroupedList>
      {settingsSections().map((s) => (
        <Link
          key={s.to}
          to={s.to}
          className="flex min-h-11 items-center gap-3 px-4 py-3 text-foreground transition-colors hover:bg-accent active:bg-accent"
        >
          <s.icon className="size-5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block text-[0.9375rem]">{s.label}</span>
            <span className="block text-sm text-muted-foreground">{s.hint}</span>
          </span>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </Link>
      ))}
    </GroupedList>
  );
}

/** A settings page: phone back link to the list, then the large title and its sections. */
export function SettingsPageFrame({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-5xl space-y-10 px-4 py-6 sm:px-8 md:py-12">
      <div>
        <Link
          to="/settings"
          className="-ml-1 mb-2 inline-flex min-h-11 items-center gap-1 text-[0.9375rem] text-primary md:hidden"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Settings
        </Link>
        <h1 className="ios-large-title">{title}</h1>
      </div>
      {children}
    </div>
  );
}
