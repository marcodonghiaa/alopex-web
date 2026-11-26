import {
  createFileRoute,
  Outlet,
  Link,
  redirect,
  useNavigate,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { LogOut, Download, MoreHorizontal, ChevronLeft, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { Icon, iconOf, type IconComponent } from "@/components/icons/icon";
import { useCategories } from "@/lib/use-categories";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { loadDemoClient, recoverySignIn, supabase } from "@/integrations/supabase/client";
import { isDemoMode } from "@/lib/demo/mode";
import { needsMfaCode } from "@/lib/mfa";
import { backHereSearch } from "@/lib/next-url";
import { originStatusQuery } from "@/lib/register-origin";
import { MadeWith } from "@/components/made-with";
import { forgetThisBrowserPush } from "@/components/push-subscribe";
import { cn } from "@/lib/utils";
import { GroupedList } from "@/components/ui/grouped-list";
import { BrandMark } from "@/components/brand-mark";
import { TrustNote } from "@/components/trust-note";
import { DemoBadge } from "@/components/demo-badge";
import { NavBadge } from "@/components/nav-badge";
import { groupStreams, romeToday } from "@/lib/recurring";
import { useRecurringStreams } from "@/lib/use-recurring-streams";
import { useQuery } from "@tanstack/react-query";
import { fetchReviewCount, REVIEW_COUNT_KEY } from "@/lib/splitwise-sync";
import { useHiddenPages } from "@/lib/hidden-pages";
import { useEdgeSwipeBack } from "@/components/ui/edge-swipe-back";
import {
  isSettingsPath,
  settingsTitle,
  SettingsSidebar,
  SIDEBAR_LINK,
  SIDEBAR_LINK_ACTIVE,
} from "@/components/settings/settings-nav";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async ({ location }) => {
    // Sign-in sends the user back here, so a bank redirect (#bank_code=…) survives an expired
    // session. The hash waits in sessionStorage, not in `next`, so it never reaches the server.
    const toAuth = () => redirect({ to: "/auth", search: backHereSearch(location) });
    // A reloaded demo tab needs the fake client (its own chunk) before anything asks for data.
    if (isDemoMode()) await loadDemoClient();
    try {
      // getSession reads the stored login with no network call; getUser asked Supabase's server
      // on every page change. The database still enforces access, so this only picks the screen.
      const { data, error } = await supabase.auth.getSession();
      if (error || !data.session) {
        throw toAuth();
      }
      // A recovery link that landed here (Supabase sends it to the Site URL when this address isn't
      // allowed) opens the new-password form, which also asks for the authenticator code.
      if (!isDemoMode() && (await recoverySignIn())) throw redirect({ to: "/reset-password" });
      // Signed in with the password but not yet the authenticator code: the sign-in page asks for it.
      if (!isDemoMode() && (await needsMfaCode())) throw toAuth();
      return { user: data.session.user };
    } catch (err) {
      if (err instanceof Response) throw err;
      throw toAuth();
    }
  },
  component: AuthenticatedLayout,
});

/** Where the demo sends visitors who want their own dashboard: the setup steps. */
export const GET_YOUR_OWN_URL = "https://alopex.finance/#how";

interface NavItem {
  label: string;
  icon: IconComponent;
  to: string;
}

interface NavGroup {
  label: string;
  items: Array<NavItem>;
}

const NAV_GROUPS: Array<NavGroup> = [
  {
    label: "Overview",
    items: [
      { label: "Net Worth", icon: iconOf("net-worth"), to: "/" },
      { label: "Reports", icon: iconOf("reports"), to: "/reports" },
    ],
  },
  {
    label: "Banking",
    items: [
      { label: "Accounts", icon: iconOf("accounts"), to: "/accounts" },
      { label: "Transactions", icon: iconOf("transactions"), to: "/transactions" },
      { label: "Income", icon: iconOf("income"), to: "/income" },
      { label: "Spending", icon: iconOf("spending"), to: "/spending" },
      { label: "Budgets", icon: iconOf("budgets"), to: "/budgets" },
      { label: "Subscriptions", icon: iconOf("subscriptions"), to: "/subscriptions" },
      { label: "Who owes you", icon: iconOf("who-owes-you"), to: "/splitwise" },
    ],
  },
  {
    label: "Investing",
    items: [
      { label: "Portfolio", icon: iconOf("portfolio"), to: "/portfolio" },
      { label: "Crypto", icon: iconOf("crypto"), to: "/crypto" },
    ],
  },
  {
    label: "Tools",
    items: [{ label: "Import", icon: iconOf("import"), to: "/import" }],
  },
];

// iOS HIG: bottom tabs max 5, icon + label, current tab visually distinct.
// The 5th slot opens More (Sheet) with every page that has no tab. A tab also lights up for the
// pages it owns (Investing covers Portfolio and Crypto, switched inside the page).
export const TAB_BAR_ITEMS: Array<{
  label: string;
  icon: IconComponent;
  to: string;
  owns: Array<string>;
}> = [
  { label: "Net Worth", icon: iconOf("net-worth"), to: "/", owns: ["/"] },
  { label: "Activity", icon: iconOf("transactions"), to: "/transactions", owns: ["/transactions"] },
  { label: "Spending", icon: iconOf("spending"), to: "/spending", owns: ["/spending"] },
  {
    label: "Investing",
    icon: iconOf("portfolio"),
    to: "/portfolio",
    owns: ["/portfolio", "/crypto"],
  },
];

const TAB_PATHS = new Set(TAB_BAR_ITEMS.flatMap((t) => t.owns));
/** A tab's own page: a phone shows it without Back, and tabs swap without a slide. */
export const isTabPath = (pathname: string) => TAB_PATHS.has(pathname);

// Pages reached from elsewhere than the menus (Reports, Settings, Health in General).
const OTHER_TITLES: Record<string, string> = {
  "/cash-flow": "Cash flow",
  "/health": "Health",
  "/rules": "Rules",
};

/** The phone top bar's title: the tab's name on a tab, else the page's menu name. */
export function phoneTitle(pathname: string) {
  const tab = TAB_BAR_ITEMS.find((t) => t.owns.includes(pathname));
  if (tab) return tab.label;
  const item = NAV_GROUPS.flatMap((g) => g.items).find((i) => i.to === pathname);
  return item?.label ?? OTHER_TITLES[pathname] ?? settingsTitle(pathname) ?? "Alopex";
}

/** Where Back goes on a page opened with no in-app history behind it (a link, a reload). */
export function phoneParent(pathname: string) {
  if (pathname === "/rules") return "/settings/personalization";
  if (pathname.startsWith("/settings/")) return "/settings";
  return "/";
}

// The pages people open most from More come first; the rest keep their sidebar order.
const MORE_FIRST = ["/accounts", "/subscriptions", "/splitwise"];
const moreRank = (to: string) => {
  const i = MORE_FIRST.indexOf(to);
  return i < 0 ? MORE_FIRST.length : i;
};

/**
 * The More sheet lists only the pages without a tab, so nothing appears twice on a phone.
 * Pages form one untitled list (most used first); Tools stays its own titled group.
 */
export const MORE_GROUPS: Array<NavGroup> = (() => {
  const untabbed = NAV_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((i) => !TAB_PATHS.has(i.to)),
  }));
  const tools = untabbed.filter((g) => g.label === "Tools");
  const pages = untabbed
    .filter((g) => g.label !== "Tools")
    .flatMap((g) => g.items)
    .sort((a, b) => moreRank(a.to) - moreRank(b.to));
  return [{ label: "", items: pages }, ...tools].filter((g) => g.items.length > 0);
})();

// Mobile tab bar: a floating pill (Marco, native feel); icon + sans label, the current tab sits in a soft fill.
const TAB_LINK =
  "flex flex-col items-center justify-center gap-0.5 rounded-full text-muted-foreground transition-[opacity,background-color] active:opacity-60";
const TAB_LINK_ACTIVE =
  "flex flex-col items-center justify-center gap-0.5 rounded-full bg-accent text-foreground transition-[opacity,background-color] active:opacity-60";
const TAB_LABEL = "text-[0.6875rem] font-medium";

// More sheet rows: 44px+ grouped-list rows; the current page takes the accent fill and weight 500.
const SHEET_ROW =
  "flex min-h-11 items-center gap-3 px-4 py-2.5 text-left text-[0.9375rem] text-foreground active:bg-accent";
const SHEET_ROW_ACTIVE = `${SHEET_ROW} bg-accent font-medium`;

type AppPage = { to: string; search: object };
const LAST_APP_PAGE = "alopex.lastAppPage";
// The last page outside Settings saved in this tab; only a plain in-app path is trusted
// (no //host, backslash or whitespace such as tabs, whatever the router would make of them).
function savedAppPage(): AppPage {
  try {
    const v = JSON.parse(sessionStorage.getItem(LAST_APP_PAGE) ?? "null") as Partial<AppPage>;
    if (
      typeof v?.to === "string" &&
      /^\/(?!\/)/.test(v.to) &&
      !/[\\\s]/.test(v.to) &&
      !isSettingsPath(v.to)
    ) {
      return { to: v.to, search: typeof v.search === "object" && v.search ? v.search : {} };
    }
  } catch {
    // Blocked or malformed: start from Net Worth.
  }
  return { to: "/", search: {} };
}

function AuthenticatedLayout() {
  const { user } = Route.useRouteContext();
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const pathname = useRouterState({ select: (st) => st.location.pathname });
  // Loaded once for every page: the icon and colour you picked per category.
  useCategories();
  // Pages switched off in Settings › App drop out of the sidebar and More.
  const hidden = useHiddenPages();
  const shown = (items: Array<NavItem>) => items.filter((i) => !hidden.includes(i.to));
  // Settings replaces the sidebar; "Back to app" returns to the last page outside it.
  const inSettings = isSettingsPath(pathname);
  const search = useRouterState({ select: (st) => st.location.search });
  const [savedPage] = useState(savedAppPage);
  const lastAppPage = useRef<AppPage>(savedPage);
  if (!inSettings) lastAppPage.current = { to: pathname, search };
  // Kept for this tab, so a reload inside Settings still goes back to the filtered page.
  useEffect(() => {
    if (inSettings) return;
    try {
      sessionStorage.setItem(LAST_APP_PAGE, JSON.stringify({ to: pathname, search }));
    } catch {
      // Storage blocked: Back to app falls back to this session's memory.
    }
  }, [inSettings, pathname, search]);
  // Entering or leaving Settings unmounts the link that was pressed: put keyboard focus on the
  // new menu's current link (else its first), so the next Tab doesn't skip the whole menu.
  const sidebar = useRef<HTMLElement>(null);
  const wasInSettings = useRef(inSettings);
  useEffect(() => {
    if (wasInSettings.current === inSettings) return;
    wasInSettings.current = inSettings;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const links = sidebar.current?.querySelectorAll<HTMLElement>("nav a");
    (
      [...(links ?? [])].find((a) => a.getAttribute("aria-current") === "page") ?? links?.[0]
    )?.focus();
  }, [inSettings]);
  // Phone Back (top bar and edge swipe) on any page that isn't a tab: the previous page when the
  // app has one, else the page's parent (Settings comes back to the last app page).
  const router = useRouter();
  const pushed = !isTabPath(pathname);
  const goBack = () => {
    // A home-screen app starts with one entry, so more means an app page sits behind this one.
    if (window.history.length > 1) {
      router.history.back();
      return;
    }
    if (pathname === "/settings") {
      void navigate({ ...lastAppPage.current, replace: true });
      return;
    }
    void navigate({ to: phoneParent(pathname), replace: true });
  };
  const page = useRef<HTMLElement>(null);
  useEdgeSwipeBack(page, pushed && !menuOpen, goBack, pathname);
  // iOS large titles: the top bar names the page only once its own large title has scrolled under.
  const [largeTitleShown, setLargeTitleShown] = useState(false);
  useEffect(() => {
    const title = page.current?.querySelector("h1.ios-large-title");
    setLargeTitleShown(!!title);
    if (!title || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setLargeTitleShown(!!e?.isIntersecting), {
      rootMargin: "-56px 0px 0px 0px",
    });
    io.observe(title);
    return () => io.disconnect();
  }, [pathname]);

  // A More link to the page you're on only closes the sheet: navigating would replace the
  // sheet's history entry with the same page and leave a Back that does nothing.
  const closeMenuTo = (e: React.MouseEvent, to: string) => {
    if (to === pathname) e.preventDefault();
    setMenuOpen(false);
  };
  // The Subscriptions badge follows transaction edits once Subscriptions is opened (it re-checks)
  // or after the 6-hourly detection run, not at the moment of the edit.
  const streams = useRecurringStreams().data;
  // A head-only count under the To link list's key, so a link or a sync refreshes the badge too.
  // A failure leaves the badge off and doesn't retry: it's only a hint.
  const review = useQuery({
    queryKey: REVIEW_COUNT_KEY,
    queryFn: fetchReviewCount,
    retry: false,
  });
  const badges: Record<string, number> = {
    "/subscriptions": streams ? groupStreams(streams, romeToday()).toReview.length : 0,
    "/splitwise": review.data ?? 0,
  };
  // The More tab sums what waits on the pages it holds that carry a badge.
  // A page hidden in Settings › App has no row in More, so its count stays out too.
  const inMore = MORE_GROUPS.flatMap((g) => shown(g.items)).reduce(
    (sum, i) => sum + (badges[i.to] ?? 0),
    0,
  );

  // Once per page load: tells the backend this address is the dashboard (setup no longer asks for
  // it). Health shows the answer.
  useQuery(originStatusQuery(() => supabase.rpc("register_dashboard_origin")));

  // Keep route data in sync with auth transitions (e.g. token expiry).
  useEffect(() => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        void navigate({ to: "/auth", replace: true });
      }
    });
    return () => subscription.unsubscribe();
  }, [navigate]);

  // The demo has no exit into this app: its only way out is the setup guide for your own copy.
  const demo = isDemoMode();

  async function handleSignOut() {
    setSigningOut(true);
    await forgetThisBrowserPush();
    // This device only, and its stored session goes before the network call, so signing out
    // offline still works. The default (global) would also sign out the user's other devices.
    const { error } = await supabase.auth.signOut({ scope: "local" });
    // Still signed in: /auth would only send the user back here.
    if (error && (await supabase.auth.getSession()).data.session) {
      setSigningOut(false);
      toast.error("Couldn't sign out", { description: error.message });
      return;
    }
    await navigate({ to: "/auth", replace: true });
  }

  return (
    <div className="flex min-h-dvh overflow-x-clip bg-background">
      {/* Sidebar */}
      <aside
        ref={sidebar}
        className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r bg-sidebar md:flex"
      >
        <div className="flex h-16 items-center gap-2.5 px-5">
          <BrandMark className="size-8" />
          <span className="text-[0.9375rem] font-semibold tracking-tight text-sidebar-foreground">
            Alopex
          </span>
          <DemoBadge className="ml-auto" />
        </div>

        {inSettings ? (
          <SettingsSidebar backTo={lastAppPage.current} />
        ) : (
          <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-3">
            {NAV_GROUPS.filter((g) => shown(g.items).length > 0).map((group, i) => (
              <div key={group.label}>
                <div className="eyebrow px-3 pb-2">
                  {String(i + 1).padStart(2, "0")} {group.label}
                </div>
                <div className="space-y-0.5">
                  {shown(group.items).map((item) => (
                    <Link
                      key={item.label}
                      to={item.to}
                      activeOptions={{ exact: true }}
                      className={SIDEBAR_LINK}
                      activeProps={{ className: SIDEBAR_LINK_ACTIVE }}
                    >
                      <item.icon className="size-[1.125rem] shrink-0" />
                      {item.label}
                      <NavBadge count={badges[item.to]} />
                    </Link>
                  ))}
                </div>
              </div>
            ))}
          </nav>
        )}

        <div className="border-t p-3">
          <div className="mb-2 truncate px-3 text-xs text-muted-foreground">{user.email}</div>
          {/* In Settings its own menu is above; the link would only repeat it. Desktop opens
              Overview directly (phone /settings is the list), so focus lands on its link. */}
          {!inSettings && (
            <Link to="/settings/overview" className={SIDEBAR_LINK}>
              <Icon name="settings" className="size-[1.125rem] shrink-0" />
              Settings
            </Link>
          )}
          {demo ? (
            <a href={GET_YOUR_OWN_URL} className={SIDEBAR_LINK}>
              <Download className="size-[1.125rem] shrink-0" />
              Get your own
            </a>
          ) : (
            <button
              type="button"
              onClick={handleSignOut}
              disabled={signingOut}
              className={`${SIDEBAR_LINK} w-full disabled:opacity-50`}
            >
              <LogOut className="size-[1.125rem] shrink-0" />
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
          )}
        </div>
      </aside>

      {/* Mobile top bar (iOS navigation bar): padded for the notch (safe-area-inset-top is 0 in a
          normal tab). Back on pages that aren't a tab; the page's name, unless its large title
          is still on screen. */}
      <div
        data-phone-bar="top"
        className="glass fixed inset-x-0 top-0 z-30 grid h-[calc(2.75rem+env(safe-area-inset-top))] grid-cols-[1fr_auto_1fr] items-center border-b px-1 pt-[env(safe-area-inset-top)] md:hidden"
      >
        <div>
          {pushed && (
            <button
              type="button"
              onClick={goBack}
              aria-label="Back"
              className="flex size-11 items-center justify-center rounded-full text-primary active:opacity-60"
            >
              <ChevronLeft className="size-7" strokeWidth={2.25} aria-hidden />
            </button>
          )}
        </div>
        <span
          aria-hidden
          className={cn(
            "truncate text-[1.0625rem] font-semibold text-foreground transition-opacity duration-200",
            largeTitleShown && "opacity-0",
          )}
        >
          {phoneTitle(pathname)}
        </span>
        <DemoBadge className="mr-2 justify-self-end" />
      </div>

      {/* Mobile bottom tab bar: a floating pill above the home indicator, max 5 items, icon + label. */}
      <nav
        aria-label="Primary"
        data-phone-bar="bottom"
        className="glass fixed inset-x-3.5 bottom-[calc(0.625rem+env(safe-area-inset-bottom))] z-30 grid h-16 grid-cols-5 rounded-full border p-1.5 shadow-[0_10px_30px_rgb(0_0_0/0.28)] md:hidden"
      >
        {TAB_BAR_ITEMS.map((item) => {
          const active = item.owns.includes(pathname);
          return (
            <Link
              key={item.label}
              to={item.to}
              aria-current={active ? "page" : undefined}
              className={active ? TAB_LINK_ACTIVE : TAB_LINK}
            >
              <item.icon className="size-6" />
              <span className={TAB_LABEL}>{item.label}</span>
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setMenuOpen(true)}
          aria-haspopup="dialog"
          aria-label={inMore ? `More, ${inMore} to review` : "More"}
          className={TAB_PATHS.has(pathname) ? TAB_LINK : TAB_LINK_ACTIVE}
        >
          <span className="relative">
            <MoreHorizontal className="size-6" />
            <span aria-hidden="true" className="absolute -top-1 left-full flex">
              <NavBadge count={inMore} />
            </span>
          </span>
          <span className={TAB_LABEL}>More</span>
        </button>
      </nav>

      {/* More: bottom sheet with the full nav as grouped lists. */}
      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent
          side="bottom"
          className="max-h-[88dvh] gap-0 overflow-y-auto rounded-t-xl border-0 bg-background p-0 pb-[env(safe-area-inset-bottom)] [&>button]:size-11"
        >
          <div aria-hidden className="mx-auto mt-2 h-1 w-9 rounded-md bg-muted-foreground/40" />
          <SheetHeader className="px-5 pt-3 pb-2 text-left">
            <SheetTitle className="ios-large-title !text-2xl">More</SheetTitle>
          </SheetHeader>

          <nav aria-label="More" className="space-y-5 px-4 pt-2 pb-4">
            {MORE_GROUPS.filter((g) => shown(g.items).length > 0).map((group) => (
              <div key={group.label || "pages"}>
                {group.label && <div className="ios-section-title">{group.label}</div>}
                <GroupedList>
                  {shown(group.items).map((item) => (
                    <Link
                      key={item.label}
                      to={item.to}
                      // Replace the sheet's own history entry, so one Back returns to the page.
                      replace
                      activeOptions={{ exact: true }}
                      onClick={(e) => closeMenuTo(e, item.to)}
                      className={SHEET_ROW}
                      activeProps={{ className: SHEET_ROW_ACTIVE }}
                    >
                      <item.icon className="size-5 shrink-0" />
                      {item.label}
                      <NavBadge count={badges[item.to]} />
                      <ChevronRight
                        aria-hidden
                        className={`size-4 shrink-0 text-muted-foreground ${badges[item.to] ? "" : "ml-auto"}`}
                      />
                    </Link>
                  ))}
                </GroupedList>
              </div>
            ))}

            {/* Settings, then the way out last and apart; the email says whose data this is. */}
            <div>
              <GroupedList>
                <Link
                  to="/settings"
                  replace
                  onClick={(e) => closeMenuTo(e, "/settings")}
                  // Lit on every settings page, Rules included (it lives in Personalization).
                  aria-current={inSettings ? "page" : undefined}
                  className={inSettings ? SHEET_ROW_ACTIVE : SHEET_ROW}
                >
                  <Icon name="settings" className="size-5 shrink-0" />
                  Settings
                  <ChevronRight
                    aria-hidden
                    className="ml-auto size-4 shrink-0 text-muted-foreground"
                  />
                </Link>
                {demo ? (
                  <a href={GET_YOUR_OWN_URL} className={SHEET_ROW}>
                    <Download className="size-5 shrink-0" />
                    Get your own
                  </a>
                ) : (
                  <button
                    type="button"
                    onClick={handleSignOut}
                    disabled={signingOut}
                    className={cn(SHEET_ROW, "w-full text-negative disabled:opacity-50")}
                  >
                    <LogOut className="size-5 shrink-0" />
                    {signingOut ? "Signing out…" : "Sign out"}
                  </button>
                )}
              </GroupedList>
              <p className="truncate px-4 pt-1.5 text-xs text-muted-foreground">
                Signed in as {user.email}
              </p>
            </div>
          </nav>
        </SheetContent>
      </Sheet>

      {/* Main content */}
      <main
        ref={page}
        className="min-w-0 flex-1 pt-[calc(2.75rem+env(safe-area-inset-top))] pb-[calc(5.25rem+env(safe-area-inset-bottom))] md:pt-0 md:pb-0 md:pl-64"
      >
        <Outlet />
        <footer className="mx-auto max-w-5xl px-4 pb-8 sm:px-8 md:pb-12">
          <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-start sm:justify-between">
            <TrustNote />
            <MadeWith />
          </div>
        </footer>
      </main>
    </div>
  );
}
