import { dateLocale } from "@/lib/locale";
import { fetchSplitContacts } from "@/lib/splits";
import { EmptyState } from "@/components/empty-state";
import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { makeRuleAction } from "@/lib/rules";
import { rulesQuery } from "@/lib/rules-query";
import { accountName, bankOf } from "@/components/bank-badge";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { SectionTitle } from "@/components/ui/grouped-list";
import { Alert } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { formatISODate } from "@/lib/date";
import {
  UNCATEGORIZED,
  activeFilterCount,
  filterTransactions,
  formatDayHeading,
  formatEur,
  groupByDay,
  selectedOnly,
  isPaidForOthers,
  isWorthItEligible,
  isSplitwiseShare,
  shareId,
  listCategories,
  listTags,
  sameTag,
  mergeShares,
  nameRefunds,
  monthFromParam,
  parseTransactionsSearch,
  withoutHighlight,
  searchPattern,
  SEARCH_LIMIT,
  startOfMonth,
  totalsOf,
  type AccountRow,
  type TransactionsSearch,
  type SplitwiseShare,
  type TransactionRow,
  type TransferRow,
  isSameTx,
  txId,
} from "@/lib/transactions";
import { BulkCategoryPicker } from "@/components/transactions/pickers";
import { TransfersSection } from "@/components/transactions/transfers-section";
import { ReviewSection } from "@/components/transactions/review-section";
import {
  fetchReviewRows,
  pairIdByTx,
  reviewGroups,
  type TransferPair,
} from "@/lib/transfer-review";
import { AddTransaction } from "@/components/transactions/add-transaction";
import { ImportStatement } from "@/components/transactions/import-statement";
import {
  useBulkCategoryMutation,
  useDeleteMutation,
  useFlowMutation,
  useManualAmountMutation,
  useRenameMerchantMutation,
  useResolvePairMutation,
  useReviewGroupMutation,
  useShareMutation,
  useSplitMutation,
  useTransactionFieldMutation,
} from "@/components/transactions/mutations";
import {
  TransactionCardView,
  TransactionRowView,
  DayHeaderRow,
  type TransactionViewProps,
} from "@/components/transactions/transaction-views";
import { WorthItSpotlight } from "@/components/transactions/worth-it";
import { MonthSwitcher } from "@/components/month-switcher";
import { FilterSheet } from "@/components/transactions/filter-sheet";
import { RECURRING_KEY, refreshRecurring } from "@/lib/use-recurring-streams";

export const Route = createFileRoute("/_authenticated/transactions")({
  head: () => ({
    meta: [
      { title: "Transactions — Alopex" },
      {
        name: "description",
        content: "Browse and search transactions month by month, newest first.",
      },
      { property: "og:title", content: "Transactions — Alopex" },
      {
        property: "og:description",
        content: "Browse and search transactions month by month, newest first.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  validateSearch: parseTransactionsSearch,
  component: TransactionsRoute,
});

// A new deep link (another category or month) starts the page fresh; the Activity tab, with no
// params, does too.
function TransactionsRoute() {
  const search = useSearch({ from: "/_authenticated/transactions" });
  return <TransactionsPage key={`${search.category ?? ""}|${search.month ?? ""}`} {...search} />;
}

// What the list shows: one month, or a search through every month.
type Scope = { month: Date } | { query: string };

const monthBounds = (month: Date) => ({
  start: formatISODate(startOfMonth(month)),
  end: formatISODate(new Date(month.getFullYear(), month.getMonth() + 1, 1)),
});

// A search matches the merchant or the note, like the list's own filter, in any month.
const searchOr = (query: string, columns: Array<string>) =>
  columns.map((c) => `${c}.ilike.${searchPattern(query)}`).join(",");

async function fetchTransactions(scope: Scope): Promise<Array<TransactionRow>> {
  let q = supabase
    .from("v_transactions_eur")
    .select(
      "entry_reference,account_uid,booking_date,category,transaction_type,creditor_name,bank_creditor_name,currency,amount,signed_amount_eur,credit_debit_indicator,created_at,worth_it,personal_amount,owed_by,flow_type,refund_of,note,tags",
    )
    .in("flow_type", ["spend", "refunded"])
    .neq("amount", 0);
  if ("query" in scope) q = q.or(searchOr(scope.query, ["creditor_name", "note"]));
  else {
    const { start, end } = monthBounds(scope.month);
    q = q.gte("booking_date", start).lt("booking_date", end);
  }
  const ordered = q
    .order("booking_date", { ascending: false })
    .order("entry_reference", { ascending: false });
  const { data, error } = await ("query" in scope ? ordered.limit(SEARCH_LIMIT) : ordered);
  if (error) throw error;
  return (data ?? []) as Array<TransactionRow>;
}

// Transfers are left out of spending and income; they are listed on request so a wrong one can be moved back.
async function fetchTransfers(scope: Scope): Promise<Array<TransferRow>> {
  let q = supabase
    .from("v_transactions_eur")
    .select(
      "entry_reference,account_uid,booking_date,category,transaction_type,creditor_name,bank_creditor_name,currency,amount,signed_amount_eur,credit_debit_indicator,created_at,worth_it,personal_amount,owed_by,flow_type,refund_of",
    )
    .eq("flow_type", "transfer")
    .neq("amount", 0);
  if ("query" in scope) q = q.or(searchOr(scope.query, ["creditor_name", "note"]));
  else {
    const { start, end } = monthBounds(scope.month);
    q = q.gte("booking_date", start).lt("booking_date", end);
  }
  const ordered = q
    .order("booking_date", { ascending: false })
    .order("entry_reference", { ascending: false });
  const { data, error } = await ("query" in scope ? ordered.limit(SEARCH_LIMIT) : ordered);
  if (error) throw error;
  return (data ?? []) as Array<TransferRow>;
}

// Transfers the sync paired on its own, waiting for a yes or no.
async function fetchSuggestedPairs(): Promise<Array<TransferPair>> {
  const { data, error } = await supabase
    .from("transfer_pairs")
    .select("id,out_account_uid,out_ref,in_account_uid,in_ref")
    .eq("status", "suggested");
  if (error) throw error;
  return data ?? [];
}

// My share of Splitwise expenses in the month (shares already paid by card are bank rows).
async function fetchShares(scope: Scope): Promise<Array<SplitwiseShare>> {
  let q = supabase
    .from("v_splitwise_eur")
    .select("id,booking_date,category,description,group_name,currency,amount,amount_eur");
  if ("query" in scope) q = q.or(searchOr(scope.query, ["description"]));
  else {
    const { start, end } = monthBounds(scope.month);
    q = q.gte("booking_date", start).lt("booking_date", end);
  }
  const ordered = q.order("booking_date", { ascending: false });
  const { data, error } = await ("query" in scope ? ordered.limit(SEARCH_LIMIT) : ordered);
  if (error) throw error;
  return (data ?? []) as Array<SplitwiseShare>;
}

// The month's money in and out, from the same view as Reports so the figures agree.
async function fetchInOut(
  monthKey: string,
): Promise<{ income_eur: number | null; expenses_eur: number | null } | null> {
  const { data, error } = await supabase
    .from("v_income_vs_expenses_monthly")
    .select("income_eur,expenses_eur")
    .eq("month", monthKey)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Suggestions are a help, not the list: a failure leaves the tag field without them, logged.
async function fetchTagSuggestions(): Promise<Array<string>> {
  const { data, error } = await supabase.rpc("my_transaction_tags");
  if (error) {
    console.error("Couldn't load tag suggestions", error);
    return [];
  }
  return (data ?? []).map((r) => r.tag);
}

async function fetchAccounts(): Promise<Record<string, AccountRow>> {
  const { data, error } = await supabase.from("accounts").select("*");
  if (error) throw error;
  const map: Record<string, AccountRow> = {};
  for (const row of (data ?? []) as Array<AccountRow>) map[row.uid] = row;
  return map;
}

function TransactionsPage({ category: initialCategory, month: initialMonth }: TransactionsSearch) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<string>(initialCategory ?? "all");
  const [bank, setBank] = useState<string>("all");
  const [tag, setTag] = useState<string>(""); // "" = all tags (a tag may be named "all")
  const [day, setDay] = useState("");
  // The row whose sheet is open stays listed until it closes, even if an edit stops it matching.
  const [editing, setEditing] = useState<string | null>(null);
  // Whether the open row sat in "Paid for others" when its sheet opened: it stays there until it closes.
  const [editingApart, setEditingApart] = useState(false);
  const [month, setMonth] = useState(() => monthFromParam(initialMonth));
  const monthKey = useMemo(() => formatISODate(month), [month]);
  // The search sent to the server: through every month once typing pauses, back to the month at
  // once when cleared. The list's own filter keeps following each keystroke meanwhile.
  const [query, setQuery] = useState("");
  useEffect(() => {
    const next = search.trim();
    if (!next) return setQuery("");
    const timer = setTimeout(() => setQuery(next), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const scope: Scope = query ? { query } : { month };
  // The cache key of what's listed, so edits update the rows on screen, searched or not.
  const listKey = query ? `search:${query.toLowerCase()}` : monthKey;
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const navigate = useNavigate();
  // "Make a rule" (toast and sheet); not offered when a saved rule already sorts the name.
  const rules = useQuery(rulesQuery).data;
  const ruleAction = (name: string | null | undefined, category: string | null) =>
    makeRuleAction(name, category, navigate, rules);
  // Rules match the bank's own name. No bank name (a manual or broker row): no rule can match it.
  // A database without the bank_creditor_name column yet: the shown name, as before.
  const ruleName = (tx: {
    creditor_name?: string | null | undefined;
    bank_creditor_name?: string | null | undefined;
  }) => (tx.bank_creditor_name === undefined ? tx.creditor_name : tx.bank_creditor_name);
  const updateCategory = useTransactionFieldMutation(queryClient, listKey, "category", {
    errorMessage: "Couldn't save category",
    successMessage: (value) => `Saved — ${value}`,
    successAction: ({ tx, value }) => ruleAction(ruleName(tx), value),
  });

  // A type decides what counts as a subscription: re-check them so the nav badge follows.
  // The server allows one run per 5 s, so a 429 is retried once after that window, while the
  // page is still open (as on the Subscriptions page). Every answer refetches, which is harmless.
  const open = useRef(true);
  const retry = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
      clearTimeout(retry.current);
    };
  }, []);
  const recheck = (retryIfLimited: boolean): void =>
    void refreshRecurring().then((result) => {
      if (result === "limited" && retryIfLimited && open.current) {
        clearTimeout(retry.current);
        retry.current = setTimeout(() => recheck(false), 5_000);
      }
      return queryClient.invalidateQueries({ queryKey: RECURRING_KEY });
    });

  const updateType = useTransactionFieldMutation(queryClient, listKey, "transaction_type", {
    errorMessage: "Couldn't save type",
    successMessage: (value) => `Saved — ${value}`,
    onSaved: () => recheck(true),
  });

  const answerWorthIt = useTransactionFieldMutation(queryClient, listKey, "worth_it", {
    errorMessage: "Couldn't save answer",
  });

  const renameTx = useRenameMerchantMutation(queryClient);

  const updateNote = useTransactionFieldMutation(queryClient, listKey, "note", {
    errorMessage: "Couldn't save note",
  });
  const updateTags = useTransactionFieldMutation(queryClient, listKey, "tags", {
    errorMessage: "Couldn't save tags",
  });
  // Every tag used before (all months), most used first, for suggestions while typing one.
  const tagsQuery = useQuery({
    queryKey: ["transaction-tags"],
    queryFn: fetchTagSuggestions,
    staleTime: 5 * 60_000,
  });

  const updateSplit = useSplitMutation(queryClient, listKey);

  const updateShare = useShareMutation(queryClient, listKey);

  const restoreTransfer = useFlowMutation(queryClient, listKey);
  const changeAmount = useManualAmountMutation(queryClient);
  const [showTransfers, setShowTransfers] = useState(false);
  const [showForOthers, setShowForOthers] = useState(false);

  const bulkUpdateCategory = useBulkCategoryMutation(queryClient, listKey, () =>
    setSelected(new Set()),
  );

  const deleteTxs = useDeleteMutation(queryClient, () => setSelected(new Set()));

  const accountsQuery = useQuery({
    queryKey: ["accounts"],
    queryFn: fetchAccounts,
    staleTime: 5 * 60_000,
  });

  const txQuery = useQuery({
    queryKey: ["transactions", listKey],
    queryFn: () => fetchTransactions(scope),
    staleTime: 60_000,
  });

  const transfersQuery = useQuery({
    queryKey: ["transfers", listKey],
    queryFn: () => fetchTransfers(scope),
    staleTime: 60_000,
  });
  const transfers = transfersQuery.data ?? [];

  const pairsQuery = useQuery({
    queryKey: ["transfer-pairs"],
    queryFn: fetchSuggestedPairs,
    staleTime: 60_000,
  });
  const pairIdOf = useMemo(() => pairIdByTx(pairsQuery.data ?? []), [pairsQuery.data]);
  const resolvePair = useResolvePairMutation(queryClient);

  const reviewQuery = useQuery({
    queryKey: ["transfer-review"],
    queryFn: fetchReviewRows,
    staleTime: 5 * 60_000,
  });
  const review = useMemo(() => reviewGroups(reviewQuery.data ?? []), [reviewQuery.data]);
  const decideGroup = useReviewGroupMutation(queryClient);

  const contactsQuery = useQuery({
    queryKey: ["split-contacts"],
    queryFn: fetchSplitContacts,
    staleTime: 5 * 60_000,
  });

  const sharesQuery = useQuery({
    queryKey: ["splitwise-shares", listKey],
    queryFn: () => fetchShares(scope),
    staleTime: 60_000,
  });

  const inOutQuery = useQuery({
    queryKey: ["income-vs-expenses", monthKey],
    queryFn: () => fetchInOut(monthKey),
    staleTime: 60_000,
  });

  const extraError = [sharesQuery, accountsQuery, transfersQuery].find((q) => q.isError)?.error;

  const transactions = useMemo(
    () => mergeShares(nameRefunds(txQuery.data ?? []), sharesQuery.data ?? []),
    [txQuery.data, sharesQuery.data],
  );

  // Arrived via a "worth it?" push: force fresh data (the cache may be stale
  // from before this notification's transaction existed) and jump to it.
  const [highlightRef, setHighlightRef] = useState<string | null>(null);
  useEffect(() => {
    const ref = new URLSearchParams(window.location.search).get("highlight");
    if (!ref) return;
    setHighlightRef(ref);
    void queryClient.invalidateQueries({ queryKey: ["transactions", monthKey] });
    // Keep ?month and ?category: they key this page, so dropping them would remount it.
    window.history.replaceState(
      null,
      "",
      window.location.pathname + withoutHighlight(window.location.search),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [spotlightTx, setSpotlightTx] = useState<TransactionRow | null>(null);

  // Act on a link once (it can take a refetch to find its row), so later toggles don't redo it.
  const handledLink = useRef<string | null>(null);
  useEffect(() => {
    if (!highlightRef || txQuery.isPending || handledLink.current === highlightRef) return;
    const tx = transactions.find((t) => t.entry_reference === highlightRef);
    if (!tx) return;
    handledLink.current = highlightRef;
    // A row others owe all of isn't my spending: open its section, ask nothing.
    if (isPaidForOthers(tx)) setShowForOthers(true);
    else if (isWorthItEligible(tx)) setSpotlightTx(tx);
  }, [highlightRef, txQuery.isPending, transactions]);

  // Scroll once the row is on screen (an opened section renders it a beat later), then unring it.
  const scrolledLink = useRef<string | null>(null);
  useEffect(() => {
    if (!highlightRef || txQuery.isPending || scrolledLink.current === highlightRef) return;
    // Each row has a desktop and a phone copy, one of them hidden: scroll to the one on screen.
    const el = [
      ...document.querySelectorAll(`[data-entry-ref="${CSS.escape(highlightRef)}"]`),
    ].find((e) => e.getClientRects().length > 0);
    if (!el) return;
    // After the router's scroll restoration, which jumps to the top just after the page renders.
    const timer = setTimeout(() => {
      scrolledLink.current = highlightRef;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 100);
    return () => clearTimeout(timer);
  }, [highlightRef, txQuery.isPending, transactions, showForOthers]);
  useEffect(() => {
    if (!highlightRef || txQuery.isPending) return;
    const timer = setTimeout(() => setHighlightRef(null), 3000);
    return () => clearTimeout(timer);
  }, [highlightRef, txQuery.isPending]);

  const categories = useMemo(() => listCategories(transactions), [transactions]);
  // Only tags on this month's rows, so every option matches something.
  const tags = useMemo(
    () => listTags(transactions, tagsQuery.data),
    [transactions, tagsQuery.data],
  );
  // Removing the last use of the selected tag turns the filter off, so the list isn't left empty;
  // if it's still used in another spelling (Trip/trip), the filter follows that spelling.
  const tagNow = tags.find((t) => sameTag(t, tag));
  // A day picked while searching every month may not be in this month: back on the month, drop it.
  if (!query && day && day.slice(0, 7) !== monthKey.slice(0, 7)) setDay("");
  if (tag && !txQuery.isPending && tagNow !== tag) setTag(tagNow ?? "");

  const accounts = useMemo(() => accountsQuery.data ?? {}, [accountsQuery.data]);
  const bankFor = useCallback(
    (uid: string | null) => {
      const account = uid ? accounts[uid] : undefined;
      return account ? bankOf(account) : "—";
    },
    [accounts],
  );
  // Only banks that appear this month, so every option matches something.
  const banks = useMemo(
    () =>
      [...new Set(transactions.filter((tx) => tx.account_uid).map((tx) => bankFor(tx.account_uid)))]
        .filter((b) => b !== "—")
        .sort(),
    [transactions, bankFor],
  );

  const filtered = useMemo(() => {
    const shown = filterTransactions(transactions, search, category, { bank, bankFor, day, tag });
    if (!editing || shown.some((tx) => txId(tx) === editing)) return shown;
    const keep = new Set(shown);
    return transactions.filter((tx) => keep.has(tx) || txId(tx) === editing);
  }, [transactions, search, category, bank, bankFor, day, tag, editing]);

  // Charges paid entirely for others count nothing, so they sit apart, below the list. The row
  // being edited stays where it is until its sheet closes.
  const forOthers = useMemo(
    () => filtered.filter((tx) => (txId(tx) === editing ? editingApart : isPaidForOthers(tx))),
    [filtered, editing, editingApart],
  );
  const mine = useMemo(() => {
    const apart = new Set(forOthers);
    return filtered.filter((tx) => !apart.has(tx));
  }, [filtered, forOthers]);
  // A search shows them too, so it never comes up empty for something you paid.
  // Forced open (a search, or nothing else to list): then there is no toggle to offer.
  const forOthersForced = search.trim() !== "" || mine.length === 0;
  const forOthersOpen = forOthers.length > 0 && (showForOthers || forOthersForced);
  const visible = forOthersOpen ? filtered : mine;
  // A row whose share crossed 0 while its sheet was open moves list as the sheet closes, taking
  // the sheet's trigger with it: focus its new Edit button, or the toggle if it went out of sight.
  const forOthersToggle = useRef<HTMLButtonElement>(null);
  function focusAfterMove(ref: string) {
    setTimeout(() => {
      const rows = [...document.querySelectorAll(`[data-entry-ref="${CSS.escape(ref)}"]`)];
      const targets = rows
        .map((el) =>
          el.matches("li")
            ? el.querySelector<HTMLElement>(":scope > button")
            : el.querySelector<HTMLElement>('button[aria-label^="Edit"]'),
        )
        .filter((el): el is HTMLElement => el != null);
      const shown = targets.find((el) => el.getClientRects().length > 0) ?? targets[0];
      (shown ?? forOthersToggle.current)?.focus();
    }, 0);
  }
  // Desktop opens the rows above the toggle, so the next Tab would skip them: start at the heading.
  function focusForOthersHeading() {
    setTimeout(() => {
      const headings = ["paid-for-others-desktop", "paid-for-others-phone"]
        .map((id) => document.getElementById(id))
        .filter((el): el is HTMLElement => el != null);
      (headings.find((el) => el.getClientRects().length > 0) ?? headings[0])?.focus();
    }, 0);
  }
  const forOthersHeading = (id: string) => (
    <>
      <SectionTitle id={id} focusable className="pb-0">
        Paid for others
      </SectionTitle>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Others owe you all of it. Not counted in your spending.
      </p>
    </>
  );

  // Shares cannot be bulk edited or deleted: they are not rows of the transactions table.
  const filteredIds = useMemo(
    () => visible.filter((tx) => !isSplitwiseShare(tx)).map(txId),
    [visible],
  );
  const allFilteredSelected = filteredIds.length > 0 && filteredIds.every((id) => selected.has(id));
  // Bulk actions touch only rows you can see: a row selected before a filter hid it stays out.
  const selectedVisible = useMemo(() => selectedOnly(visible, selected), [visible, selected]);

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllFiltered() {
    setSelected((prev) => {
      if (allFilteredSelected) {
        const next = new Set(prev);
        for (const id of filteredIds) next.delete(id);
        return next;
      }
      return new Set([...prev, ...filteredIds]);
    });
  }

  const filterCount = activeFilterCount({ category, bank, day, tag });
  const filtersOn = filterCount > 0 || search.trim() !== "";
  // The phone filter sheet clears its own fields; search sits outside it.
  function clearSheetFilters() {
    setCategory("all");
    setBank("all");
    setDay("");
    setTag("");
  }
  function clearFilters() {
    setSearch("");
    clearSheetFilters();
  }
  const filterSummary = [
    category === "all" ? null : category === UNCATEGORIZED ? "Uncategorized" : category,
    day ? formatDayHeading(day) : null,
    bank === "all" ? null : bank,
    tag ? `#${tag}` : null,
  ].filter(Boolean);

  function goToMonth(next: Date) {
    setSelected(new Set());
    setDay(""); // a day belongs to one month
    setTag(""); // the next month may not use it
    setMonth(next);
  }

  // With one account the badge says the same thing on every row.
  const multiAccount = useMemo(
    () =>
      new Set(transactions.filter((tx) => !isSplitwiseShare(tx)).map((tx) => tx.account_uid)).size >
      1,
    [transactions],
  );

  const savingShare = (tx: TransactionRow) =>
    updateShare.isPending && updateShare.variables?.id === shareId(tx);

  const labelFor = (uid: string | null) => {
    if (!uid) return "—";
    const account = accounts[uid];
    return account ? accountName(account) : "Unknown account";
  };
  const viewProps = (tx: TransactionRow): TransactionViewProps => ({
    tx,
    selected: selected.has(txId(tx)),
    onToggleSelect: () => toggleOne(txId(tx)),
    savingCategory: isSplitwiseShare(tx)
      ? savingShare(tx)
      : updateCategory.isPending && isSameTx(updateCategory.variables?.tx, tx),
    onSelectCategory: (next, o) =>
      isSplitwiseShare(tx)
        ? updateShare.mutate({ id: shareId(tx), patch: { category: next } })
        : updateCategory.mutate({ tx, value: next, noAction: !!o?.inSheet }),
    savingType: updateType.isPending && isSameTx(updateType.variables?.tx, tx),
    onSelectType: (next) => updateType.mutate({ tx, value: next }),
    accountLabel: labelFor(tx.account_uid),
    onAnswerWorthIt: (worthIt) => answerWorthIt.mutate({ tx, value: worthIt }),
    savingSplit: updateSplit.isPending && isSameTx(updateSplit.variables?.tx, tx),
    onSaveSplit: (personalAmount, owedBy) => updateSplit.mutate({ tx, personalAmount, owedBy }),
    splitContacts: contactsQuery.data ?? [],
    savingRename: isSplitwiseShare(tx)
      ? savingShare(tx)
      : renameTx.isPending && isSameTx(renameTx.variables?.tx, tx),
    onRename: (name, onlyThis) =>
      isSplitwiseShare(tx)
        ? name && updateShare.mutate({ id: shareId(tx), patch: { description: name } })
        : renameTx.mutate({ tx, name, onlyThis }),
    highlighted: tx.entry_reference === highlightRef,
    // In the sheet too: on a phone the open sheet covers the toast's button.
    makeRule: isSplitwiseShare(tx) ? undefined : ruleAction(ruleName(tx), tx.category),
    showAccount: multiAccount,
    // false when the save failed (the hook already showed why), so the editor can retry or roll back.
    onSaveNote: (note) =>
      updateNote.mutateAsync({ tx, value: note }).then(
        () => true,
        () => false,
      ),
    savingNote: updateNote.isPending && isSameTx(updateNote.variables?.tx, tx),
    onSaveTags: (next) =>
      updateTags.mutateAsync({ tx, value: next }).then(
        () => true,
        () => false,
      ),
    savingTags: updateTags.isPending && isSameTx(updateTags.variables?.tx, tx),
    tagSuggestions: tagsQuery.data ?? [],
    onOpenChange: (open) => {
      if (open) setEditingApart(isPaidForOthers(tx));
      else if (isPaidForOthers(tx) !== editingApart) focusAfterMove(tx.entry_reference);
      setEditing((now) => (open ? txId(tx) : now === txId(tx) ? null : now));
    },
    ...(tx.account_uid && accounts[tx.account_uid]?.manual
      ? {
          onSaveAmount: (amount: number) => changeAmount.mutate({ tx, amount }),
          savingAmount: changeAmount.isPending && isSameTx(changeAmount.variables?.tx, tx),
        }
      : {}),
  });

  const monthLabel = month.toLocaleDateString(dateLocale(), {
    month: "long",
    year: "numeric",
  });

  const currentMonthStart = startOfMonth(new Date());
  const canGoNext = month < currentMonthStart;

  function goToPrevMonth() {
    goToMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1));
  }

  function goToNextMonth() {
    if (!canGoNext) return;
    goToMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1));
  }

  // Totals of what a search found (the month's come from the same view as Reports).
  const searchTotals = useMemo(() => totalsOf(mine), [mine]);
  const inOut = query
    ? { income_eur: searchTotals.income, expenses_eur: searchTotals.expenses }
    : inOutQuery.data;
  // The search hit its cap: older matches exist but aren't listed.
  const searchCapped = !!query && (txQuery.data?.length ?? 0) >= SEARCH_LIMIT;
  const monthDays = query
    ? {}
    : {
        min: formatISODate(month),
        max: formatISODate(new Date(month.getFullYear(), month.getMonth() + 1, 0)),
      };

  const emptyList =
    query && transactions.length === 0 && !txQuery.isPending ? (
      <EmptyState
        title={`Nothing matches “${query}” in any month.`}
        action={
          <Button variant="quiet" onClick={clearFilters} className="bg-muted">
            Clear search
          </Button>
        }
      />
    ) : transactions.length === 0 ? (
      <EmptyState
        title={`No transactions for ${monthLabel}.`}
        action={
          <Button variant="quiet" onClick={goToPrevMonth} className="bg-muted">
            Previous month
          </Button>
        }
      />
    ) : (
      <EmptyState
        title={
          search.trim() && filterCount === 0
            ? `Nothing matches “${search.trim()}”.`
            : "No transactions match your filters."
        }
        action={
          filtersOn && (
            <Button variant="quiet" onClick={clearFilters} className="bg-muted">
              Clear {filterCount ? "filters" : "search"}
            </Button>
          )
        }
      />
    );

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-8 md:py-12">
      <WorthItSpotlight
        tx={spotlightTx}
        onAnswer={(tx, value) => answerWorthIt.mutate({ tx, value })}
        onClose={() => setSpotlightTx(null)}
      />

      <header className="mb-8 flex items-start justify-between gap-3">
        <div className="min-w-0">
          {/* The phone tab says Activity, so its large title does too; the desktop nav says Transactions. */}
          <h1 className="ios-large-title">
            <span className="md:hidden">Activity</span>
            <span className="hidden md:inline">Transactions</span>
          </h1>
        </div>
        <div className="flex shrink-0 gap-2">
          {/* A rare setup task: on a phone it lives under More › Import. */}
          <div className="hidden md:block">
            <ImportStatement />
          </div>
          <AddTransaction today={formatISODate(new Date())} />
        </div>
      </header>

      {txQuery.isError && (
        <Alert className="mb-6">Couldn't load transactions: {txQuery.error.message}</Alert>
      )}

      {extraError && <Alert className="mb-6">List may be incomplete: {extraError.message}</Alert>}

      <ReviewSection
        groups={review}
        savingKey={decideGroup.isPending ? decideGroup.variables.group.key : undefined}
        onDecide={(group, choice) => decideGroup.mutate({ group, choice })}
      />

      {query ? (
        // Searching looks through every month, so the month arrows give way to a way back.
        <div className="flex min-h-11 items-center gap-3">
          <span aria-live="polite" className="mr-auto text-xl font-semibold text-foreground">
            All months
          </span>
          <Button variant="quiet" onClick={() => setSearch("")} className="bg-card">
            Back to {monthLabel}
          </Button>
        </div>
      ) : (
        <MonthSwitcher
          label={monthLabel}
          onPrev={goToPrevMonth}
          onNext={goToNextMonth}
          canGoNext={canGoNext}
        />
      )}
      <p className="mt-0.5 mb-4 min-h-5 text-sm text-muted-foreground">
        {inOut && !(query && txQuery.isPending) && (
          <>
            In{" "}
            <span className="font-figure text-foreground">{formatEur(inOut.income_eur ?? 0)}</span>
            {" · "}
            Out{" "}
            <span className="font-figure text-foreground">
              {formatEur(inOut.expenses_eur ?? 0)}
            </span>
            {searchCapped && ` · Newest ${SEARCH_LIMIT} matches. Type more to narrow it.`}
          </>
        )}
      </p>

      {/* Filters: search + Filter sheet on a phone, every field inline from md up */}
      <div className="mb-4 flex gap-3">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            onGround
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search"
            aria-label="Search by merchant or note"
            className="pr-4 pl-10"
          />
        </div>
        <div className="md:hidden">
          <FilterSheet
            category={category}
            onCategory={setCategory}
            categories={categories}
            bank={bank}
            onBank={setBank}
            banks={banks}
            tag={tag}
            onTag={setTag}
            tags={tags}
            day={day}
            onDay={setDay}
            minDay={monthDays.min}
            maxDay={monthDays.max}
            count={filterCount}
            resultCount={visible.length}
            onClear={clearSheetFilters}
          />
        </div>
        <div className="hidden gap-3 md:flex">
          <Select
            onGround
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            aria-label="Filter by category"
            className="w-auto px-4"
          >
            <option value="all">All categories</option>
            {categories.hasUncategorized && <option value={UNCATEGORIZED}>Uncategorized</option>}
            {categories.list.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
          {banks.length > 1 && (
            <Select
              onGround
              value={bank}
              onChange={(e) => setBank(e.target.value)}
              aria-label="Filter by bank"
              className="w-auto px-4"
            >
              <option value="all">All banks</option>
              {banks.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </Select>
          )}
          {tags.length > 0 && (
            <Select
              onGround
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              aria-label="Filter by tag"
              className="w-auto max-w-48 truncate px-4"
            >
              <option value="">All tags</option>
              {tags.map((t) => (
                <option key={t} value={t}>
                  #{t}
                </option>
              ))}
            </Select>
          )}
          <Input
            onGround
            type="date"
            value={day}
            min={monthDays.min}
            max={monthDays.max}
            onChange={(e) => setDay(e.target.value)}
            aria-label="Filter by day"
            className="w-auto px-4"
          />
        </div>
      </div>
      {filterSummary.length > 0 && (
        <div className="-mt-2 mb-2 flex items-center justify-between gap-3 text-sm text-muted-foreground md:hidden">
          <span className="truncate">{filterSummary.join(" · ")}</span>
          <Button variant="ghost" onClick={clearFilters} className="-mr-3 px-3">
            Clear
          </Button>
        </div>
      )}

      {/* Bulk action bar */}
      {selectedVisible.length > 0 && (
        <div className="sticky top-[calc(2.75rem+env(safe-area-inset-top)+0.5rem)] z-20 mb-4 flex flex-wrap items-center gap-3 rounded-lg bg-card p-3 shadow-[0_8px_24px_-12px_oklch(0_0_0/0.25)] md:top-4">
          <span className="text-sm font-medium text-foreground">
            {selectedVisible.length} selected
          </span>
          <BulkCategoryPicker
            onSelect={(next) =>
              bulkUpdateCategory.mutate({
                txs: selectedVisible,
                category: next,
              })
            }
            disabled={bulkUpdateCategory.isPending}
          />
          <Button
            variant="destructive"
            size="md"
            onClick={() =>
              deleteTxs.mutate({
                txs: selectedVisible,
                deleted: true,
              })
            }
            disabled={deleteTxs.isPending}
            className="gap-1.5 px-3"
          >
            <Trash2 className="size-4" />
            Delete
          </Button>
          <Button variant="ghost" onClick={() => setSelected(new Set())} className="ml-auto px-3">
            Clear
          </Button>
        </div>
      )}

      {/* Register: day groups on a phone, one table from md up */}
      <div className="md:hidden">
        {txQuery.isPending ? (
          <div className="space-y-3 rounded-lg bg-card p-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        ) : txQuery.isError ? null : filtered.length === 0 ? (
          <div className="rounded-lg bg-card">{emptyList}</div>
        ) : (
          <div className="space-y-5">
            {groupByDay(mine).map((group) => (
              <section key={group.day ?? "none"}>
                <SectionTitle variant="label">{formatDayHeading(group.day)}</SectionTitle>
                <ul className="divide-y divide-hairline overflow-hidden rounded-lg bg-card">
                  {group.rows.map((tx) => (
                    <TransactionCardView key={txId(tx)} {...viewProps(tx)} />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>

      <section className="hidden overflow-hidden rounded-lg bg-card md:block">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="w-10 px-4 py-3">
                  <label className="-m-3.5 inline-flex size-11 cursor-pointer items-center justify-center p-3.5">
                    <input
                      type="checkbox"
                      aria-label="Select all filtered transactions"
                      checked={allFilteredSelected}
                      onChange={toggleAllFiltered}
                      className="size-4 rounded border-border accent-primary"
                    />
                  </label>
                </th>
                <th className="px-2 py-3 font-medium lg:px-4">Merchant</th>
                <th className="px-2 py-3 text-right font-medium lg:px-4">Amount</th>
                <th className="w-12 px-2 py-3">
                  <span className="sr-only">Edit</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {txQuery.isPending ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td colSpan={4} className="px-4 py-3">
                      <Skeleton className="h-5" />
                    </td>
                  </tr>
                ))
              ) : txQuery.isError ? null : filtered.length === 0 ? (
                <tr>
                  <td colSpan={4}>{emptyList}</td>
                </tr>
              ) : (
                <>
                  {groupByDay(mine).map((group) => (
                    <Fragment key={group.day ?? "none"}>
                      <DayHeaderRow day={group.day} colSpan={4} />
                      {group.rows.map((tx) => (
                        <TransactionRowView key={txId(tx)} {...viewProps(tx)} />
                      ))}
                    </Fragment>
                  ))}
                  {/* In the same table so the columns line up with the rows above. */}
                  {forOthersOpen && (
                    <>
                      <tr className="border-b bg-background/40">
                        <td colSpan={4} className="px-4 pt-5 pb-3">
                          {forOthersHeading("paid-for-others-desktop")}
                        </td>
                      </tr>
                      {groupByDay(forOthers).map((group) => (
                        <Fragment key={group.day ?? "none"}>
                          <DayHeaderRow day={group.day} colSpan={4} />
                          {group.rows.map((tx) => (
                            <TransactionRowView key={txId(tx)} {...viewProps(tx)} />
                          ))}
                        </Fragment>
                      ))}
                    </>
                  )}
                </>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* A failed load hides the list, so the section goes with it. */}
      {!txQuery.isError && forOthers.length > 0 && (
        <>
          {!forOthersForced && (
            <Button
              ref={forOthersToggle}
              variant="quiet"
              size="sm"
              onClick={() => {
                setShowForOthers(!forOthersOpen);
                if (!forOthersOpen) focusForOthersHeading();
              }}
              aria-expanded={forOthersOpen}
              className="mt-4 min-h-11 px-4"
            >
              {forOthersOpen ? "Hide" : "Show"} {forOthers.length} charge
              {forOthers.length === 1 ? "" : "s"} paid for others
            </Button>
          )}
          {forOthersOpen && (
            <section
              aria-labelledby="paid-for-others-phone"
              className="mt-2 overflow-hidden rounded-lg bg-card md:hidden"
            >
              <div className="px-4 py-3">{forOthersHeading("paid-for-others-phone")}</div>
              {/* Cards carry no date, so they are grouped by day like the main list. */}
              {groupByDay(forOthers).map((group) => (
                <div key={group.day ?? "none"} className="border-t">
                  <p className="px-4 pt-3 text-xs font-medium text-muted-foreground">
                    {formatDayHeading(group.day)}
                  </p>
                  <ul className="divide-y divide-hairline">
                    {group.rows.map((tx) => (
                      <TransactionCardView key={txId(tx)} {...viewProps(tx)} />
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          )}
        </>
      )}

      {transfers.length > 0 && (
        <Button
          variant="quiet"
          size="sm"
          onClick={() => setShowTransfers((v) => !v)}
          className="mt-4 min-h-11 px-4"
        >
          {showTransfers ? "Hide" : "Show"} {transfers.length} transfer
          {transfers.length === 1 ? "" : "s"}
        </Button>
      )}
      {showTransfers && transfers.length > 0 && (
        <TransfersSection
          rows={transfers}
          savingId={restoreTransfer.isPending ? txId(restoreTransfer.variables.tx) : undefined}
          onRestore={(tx) => restoreTransfer.mutate({ tx })}
          pairIdOf={pairIdOf}
          savingPair={resolvePair.isPending ? resolvePair.variables.pairId : undefined}
          onResolvePair={(pairId, keep) => resolvePair.mutate({ pairId, keep })}
        />
      )}
    </div>
  );
}
