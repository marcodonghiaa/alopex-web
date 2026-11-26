import { Link, useRouterState } from "@tanstack/react-router";
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

interface SettingsSection {
  label: string;
  to: string;
  icon: LucideIcon;
  hint: string;
  /** Sub-pages listed under it in the sidebar. */
  children?: Array<{ label: string; to: string; hash?: string }>;
  /** Needs a real account: the demo leaves it out. */
  account?: boolean;
}

const SETTINGS_SECTIONS: Array<SettingsSection> = [
  {
    label: "General",
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

/** A settings page's name, for the phone top bar; undefined outside Settings. */
export function settingsTitle(pathname: string) {
  if (pathname === "/settings") return "Settings";
  return SETTINGS_SECTIONS.find((s) => s.to === pathname)?.label;
}

/** Paths that show the settings sidebar instead of the app's (Rules is part of Personalization). */
export const isSettingsPath = (pathname: string) =>
  pathname === "/settings" || pathname.startsWith("/settings/") || pathname === "/rules";

// Desktop sidebar link (DESIGN.md "Navigation"): 18px line icon + label, 4px corners; hover and
// active take the sidebar accent fill, active adds weight 500. Shared with the app sidebar.
export const SIDEBAR_LINK =
  "flex items-center gap-3 rounded-sm px-3 py-2 text-[0.9375rem] text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground";
export const SIDEBAR_LINK_ACTIVE =
  "flex items-center gap-3 rounded-sm px-3 py-2 text-[0.9375rem] font-medium bg-sidebar-accent text-foreground";
const SUB =
  "block rounded-sm py-1.5 pr-3 pl-[2.625rem] text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground";

/** Desktop: replaces the app sidebar while in Settings, like most sites' settings screens. */
export function SettingsSidebar({
  backTo,
}: {
  /** The last page outside Settings, with its filters. */
  backTo: { to: string; search: object };
}) {
  const { pathname, hash } = useRouterState({ select: (st) => st.location });
  // A section stays lit on its sub-pages too (Personalization while on Rules).
  const lit = (s: SettingsSection) =>
    s.to === pathname || !!s.children?.some((c) => !c.hash && c.to === pathname);
  return (
    <nav aria-label="Settings" className="flex-1 space-y-4 overflow-y-auto px-3 py-3">
      <Link to={backTo.to} search={backTo.search as never} className={SIDEBAR_LINK}>
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
                className={lit(s) ? SIDEBAR_LINK_ACTIVE : SIDEBAR_LINK}
                activeOptions={{ exact: true }}
              >
                <s.icon className="size-[1.125rem] shrink-0" />
                {s.label}
              </Link>
              {s.children?.map((c) => (
                <Link
                  key={c.label}
                  to={c.to}
                  {...(c.hash && { hash: c.hash })}
                  // Same URL, so the router keeps the scroll: pressing it again would do nothing.
                  onClick={() => {
                    if (c.hash && c.to === pathname && c.hash === hash)
                      document.getElementById(c.hash)?.scrollIntoView({ block: "start" });
                  }}
                  // Categories is a section of its page: lit only when its anchor is the target.
                  activeOptions={{ exact: true, includeHash: !!c.hash }}
                  className={SUB}
                  activeProps={{ className: `${SUB} font-medium text-foreground` }}
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

/** A settings page: the large title, then its sections (the phone top bar has Back). */
export function SettingsPageFrame({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-5xl space-y-10 px-4 py-8 sm:px-8 md:py-12">
      <h1 className="ios-large-title">{title}</h1>
      {children}
    </div>
  );
}
