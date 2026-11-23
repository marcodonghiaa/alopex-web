import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import { queryWrapper } from "@/test/query-wrapper";
import userEvent from "@testing-library/user-event";
import { useMutation } from "@tanstack/react-query";
import type { TransactionRow } from "@/lib/transactions";
import { CategoryPicker, TypePicker } from "./pickers";
import { SplitEditor } from "./split-editor";
import { setLocaleOverride } from "@/lib/locale";
import { WorthItPrompt, WorthItSpotlight } from "./worth-it";

const render = (ui: React.ReactElement) => rtlRender(ui, { wrapper: queryWrapper() });

const tx = (over: Partial<TransactionRow> = {}): TransactionRow => ({
  entry_reference: "r1",
  account_uid: "a1",
  booking_date: "2026-10-05",
  category: "Shopping",
  transaction_type: "One-time",
  creditor_name: "Amazon",
  currency: "EUR",
  amount: 20,
  signed_amount_eur: -20,
  credit_debit_indicator: "DBIT",
  created_at: "2026-10-05T08:00:00Z",
  worth_it: null,
  personal_amount: null,
  owed_by: null,
  flow_type: "spend",
  refund_of: null,
  note: null,
  tags: [],
  ...over,
});

describe("WorthItPrompt", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-10-05T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("shows the recorded answer when one exists", () => {
    render(<WorthItPrompt tx={tx({ worth_it: "no" })} onAnswer={vi.fn()} />);
    expect(screen.getByText("Not worth it")).toBeInTheDocument();
  });

  it("asks and reports the answer for an eligible purchase", async () => {
    const onAnswer = vi.fn();
    render(<WorthItPrompt tx={tx()} onAnswer={onAnswer} />);
    await userEvent
      .setup({ advanceTimers: vi.advanceTimersByTime })
      .click(screen.getByRole("button", { name: "Yes" }));
    expect(onAnswer).toHaveBeenCalledWith("yes");
  });

  it("renders nothing for an ineligible transaction", () => {
    const { container } = render(
      <WorthItPrompt tx={tx({ category: "Groceries" })} onAnswer={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("WorthItSpotlight", () => {
  it("answers and closes", async () => {
    const onAnswer = vi.fn();
    const onClose = vi.fn();
    render(<WorthItSpotlight tx={tx()} onAnswer={onAnswer} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "No" }));
    expect(onAnswer).toHaveBeenCalledWith(tx(), "no");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders no dialog without a transaction", () => {
    render(<WorthItSpotlight tx={null} onAnswer={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("pickers", () => {
  it("CategoryPicker reports a new category and ignores the current one", async () => {
    const onSelect = vi.fn();
    render(<CategoryPicker tx={tx()} onSelect={onSelect} saving={false} />);

    await userEvent.click(screen.getByRole("button", { name: /Change category for Amazon/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Groceries" }));
    expect(onSelect).toHaveBeenCalledWith("Groceries");

    await userEvent.click(screen.getByRole("button", { name: /Change category for Amazon/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Shopping" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  // polish-4 #3b: locked with aria-disabled (it keeps focus), not native disabled: a click opens
  // nothing and picks nothing.
  it("CategoryPicker is disabled while saving", async () => {
    const onSelect = vi.fn();
    render(<CategoryPicker tx={tx()} onSelect={onSelect} saving />);
    const trigger = screen.getByRole("button", { name: /Change category/ });
    expect(trigger).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(trigger);
    expect(screen.queryByRole("button", { name: "Groceries" })).not.toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });

  // Type audit P1: a charge already showing One-time (from the AI) must be claimable as yours.
  it("TypePicker lets you pick the type a charge already has when it isn't yours yet", async () => {
    const onSelect = vi.fn();
    render(
      <TypePicker tx={tx({ transaction_type: "One-time" })} onSelect={onSelect} saving={false} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Change type/ }));
    await userEvent.click(await screen.findByRole("button", { name: "One-time" }));
    expect(onSelect).toHaveBeenCalledWith("One-time");
  });

  // A list row (v_transactions_eur) carries no type source, so re-picking its type always saves:
  // that is how you claim a type the AI set.
  it("TypePicker saves a re-pick of the same type on a list row", async () => {
    const onSelect = vi.fn();
    const listRow = tx({ transaction_type: "Subscription" });
    expect(listRow).not.toHaveProperty("transaction_type_source");
    render(<TypePicker tx={listRow} onSelect={onSelect} saving={false} />);
    await userEvent.click(screen.getByRole("button", { name: /Change type/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Subscription" }));
    expect(onSelect).toHaveBeenCalledWith("Subscription");
  });

  // Re-audit F1b: a row that does carry the source as 'manual' (as the old optimistic cache did)
  // still saves a re-pick; the old "already yours" skip swallowed it.
  it("TypePicker saves a re-pick even on a row whose type is already yours", async () => {
    const onSelect = vi.fn();
    const mine = { ...tx({ transaction_type: "One-time" }), transaction_type_source: "manual" };
    render(<TypePicker tx={mine as TransactionRow} onSelect={onSelect} saving={false} />);
    await userEvent.click(screen.getByRole("button", { name: /Change type/ }));
    await userEvent.click(await screen.findByRole("button", { name: "One-time" }));
    expect(onSelect).toHaveBeenCalledWith("One-time");
  });

  // polish-3 F8: a slow type save locks the picker, so a second pick can't go out on top of it.
  it("TypePicker is locked while a type save is pending, and unlocks when it lands", async () => {
    const saves: Array<string> = [];
    let land = () => {};
    function Row() {
      const save = useMutation({
        mutationFn: (type: string) => {
          saves.push(type);
          return new Promise<void>((r) => (land = r));
        },
      });
      return <TypePicker tx={tx()} onSelect={(t) => save.mutate(t)} saving={save.isPending} />;
    }
    render(<Row />);
    const trigger = screen.getByRole("button", { name: /Change type/ });
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole("button", { name: "Subscription" }));
    // polish-4 #3: locked with aria-disabled (it keeps focus), not native disabled.
    await waitFor(() => expect(trigger).toHaveAttribute("aria-disabled", "true"));
    await userEvent.click(trigger);
    expect(screen.queryByRole("button", { name: "One-time" })).not.toBeInTheDocument();
    expect(saves).toEqual(["Subscription"]);

    land();
    await waitFor(() => expect(trigger).not.toHaveAttribute("aria-disabled"));
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole("button", { name: "One-time" }));
    expect(saves).toEqual(["Subscription", "One-time"]);
  });

  // polish-4 #3: the trigger was natively disabled while saving, so after a keyboard pick Radix
  // handed focus back to a disabled button and it fell to <body>. fails_when=focus isn't on the
  // trigger after a keyboard pick and its save
  it("TypePicker keeps focus on its trigger through a keyboard pick and the save", async () => {
    let land = () => {};
    function Row() {
      const save = useMutation({
        mutationFn: (_t: string) => new Promise<void>((r) => (land = r)),
      });
      return <TypePicker tx={tx()} onSelect={(t) => save.mutate(t)} saving={save.isPending} />;
    }
    render(<Row />);
    const trigger = screen.getByRole("button", { name: /Change type/ });
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    (await screen.findByRole("button", { name: "Subscription" })).focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(trigger).toHaveAttribute("aria-disabled", "true"));
    expect(trigger).toHaveFocus();
    land();
    await waitFor(() => expect(trigger).not.toHaveAttribute("aria-disabled"));
    expect(trigger).toHaveFocus();
  });

  it("TypePicker shows a spinner while its save is pending, and none otherwise", () => {
    const { rerender } = render(<TypePicker tx={tx()} onSelect={vi.fn()} saving />);
    expect(screen.getByRole("button", { name: /Change type/ })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByTestId("picker-spinner")).toBeInTheDocument();
    rerender(<TypePicker tx={tx()} onSelect={vi.fn()} saving={false} />);
    expect(screen.queryByTestId("picker-spinner")).not.toBeInTheDocument();
  });

  // polish-4 #3b (re-audit gap 1): the Category chip was still natively disabled while saving, so
  // a keyboard pick dropped focus to <body>. fails_when=focus isn't on the category trigger after
  // a keyboard pick and its save
  it("CategoryPicker keeps focus on its trigger through a keyboard pick and the save", async () => {
    let land = () => {};
    function Row() {
      const save = useMutation({
        mutationFn: (_c: string) => new Promise<void>((r) => (land = r)),
      });
      return <CategoryPicker tx={tx()} onSelect={(c) => save.mutate(c)} saving={save.isPending} />;
    }
    render(<Row />);
    const trigger = screen.getByRole("button", { name: /Change category/ });
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    (await screen.findByRole("button", { name: "Groceries" })).focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(document.activeElement?.tagName).toBe("BUTTON"));
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-busy", "true");
    land();
    await waitFor(() => expect(trigger).not.toHaveAttribute("aria-busy"));
    expect(trigger).toHaveFocus();
  });

  it("CategoryPicker shows the same spinner while saving, and none otherwise", () => {
    const { rerender } = render(<CategoryPicker tx={tx()} onSelect={vi.fn()} saving />);
    expect(screen.getByTestId("picker-spinner")).toBeInTheDocument();
    rerender(<CategoryPicker tx={tx()} onSelect={vi.fn()} saving={false} />);
    expect(screen.queryByTestId("picker-spinner")).not.toBeInTheDocument();
  });

  // polish-5 B1: the icon chip (desktop table rows) showed no spinner while saving.
  // fails_when=no spinner on the icon chip while saving, one when idle, or the icon is dropped
  it("CategoryPicker's icon chip shows the spinner over its icon while saving, and none otherwise", () => {
    const { rerender } = render(
      <CategoryPicker tx={tx()} onSelect={vi.fn()} saving variant="icon" />,
    );
    const trigger = screen.getByRole("button", { name: /Change category/ });
    expect(within(trigger).getByTestId("picker-spinner")).toBeInTheDocument();
    expect(trigger.querySelector("[data-category]")).not.toBeNull();
    rerender(<CategoryPicker tx={tx()} onSelect={vi.fn()} saving={false} variant="icon" />);
    expect(screen.queryByTestId("picker-spinner")).not.toBeInTheDocument();
    expect(trigger.querySelector("[data-category]")).not.toBeNull();
  });

  // polish-5 B1 note: the locked icon chip still faded on hover. jsdom has no CSS, so this checks
  // the hover fade is scoped to an unlocked trigger. fails_when=an unscoped hover:opacity class
  it("CategoryPicker's icon chip only fades on hover while unlocked", () => {
    render(<CategoryPicker tx={tx()} onSelect={vi.fn()} saving variant="icon" />);
    const trigger = screen.getByRole("button", { name: /Change category/ });
    const classes = [...trigger.querySelectorAll("*")].flatMap((el) => [...el.classList]);
    expect(classes.filter((c) => /(^|:)hover:opacity/.test(c))).toEqual([
      "[:not([aria-disabled])>&]:hover:opacity-80",
    ]);
  });

  // polish-4 #4: the current type showed only by font weight, and screen readers got no state.
  // fails_when=the current type has no check mark or no pressed state
  it("TypePicker marks the current type with a check and a pressed state", async () => {
    render(
      <TypePicker tx={tx({ transaction_type: "One-time" })} onSelect={vi.fn()} saving={false} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Change type/ }));
    const current = await screen.findByRole("button", { name: "One-time", pressed: true });
    const other = screen.getByRole("button", { name: "Subscription", pressed: false });
    expect(current.querySelector("svg")).not.toBeNull();
    expect(other.querySelector("svg")).toBeNull();
  });

  it("TypePicker marks no type when none is set", async () => {
    render(<TypePicker tx={tx({ transaction_type: null })} onSelect={vi.fn()} saving={false} />);
    await userEvent.click(screen.getByRole("button", { name: /Change type/ }));
    await screen.findByRole("button", { name: "One-time" });
    expect(screen.queryByRole("button", { pressed: true })).toBeNull();
  });

  it("TypePicker shows a dash when the type is unset", () => {
    render(<TypePicker tx={tx({ transaction_type: null })} onSelect={vi.fn()} saving={false} />);
    expect(screen.getByRole("button", { name: /Change type/ })).toHaveTextContent("—");
  });
});

describe("SplitEditor", () => {
  async function open() {
    await userEvent.click(screen.getByRole("button", { name: /Split Amazon/ }));
  }

  it("saves a partial share with the person who owes the rest", async () => {
    const onSave = vi.fn();
    render(<SplitEditor tx={tx()} onSave={onSave} saving={false} />);
    await open();
    const share = await screen.findByLabelText(/Your share/);
    await userEvent.clear(share);
    await userEvent.type(share, "5");
    await userEvent.click(screen.getByRole("button", { name: "+ New" }));
    await userEvent.type(screen.getByLabelText("New contact name"), " Anna {Enter}");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(5, "Anna");
  });

  it("left-open #1 says why an unclear share like 1,250 is refused", async () => {
    const onSave = vi.fn();
    render(<SplitEditor tx={tx()} onSave={onSave} saving={false} />);
    await open();
    const share = await screen.findByLabelText(/Your share/);
    await userEvent.clear(share);
    await userEvent.type(share, "1,250");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent('"1,250" could mean 1250 or 1.25');
  });

  it("polish-3 #4 takes a share typed with a decimal comma and says when it can't", async () => {
    const onSave = vi.fn();
    render(<SplitEditor tx={tx()} onSave={onSave} saving={false} />);
    await open();
    const share = await screen.findByLabelText(/Your share/);
    await userEvent.clear(share);
    await userEvent.type(share, "abc");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/between 0 and/);
    await userEvent.clear(share);
    await userEvent.type(share, "6,25");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(6.25, null);
  });

  it("polish-4 #6 flags a bad share when you leave the box, tied to the field", async () => {
    render(<SplitEditor tx={tx()} onSave={vi.fn()} saving={false} />);
    await open();
    const share = await screen.findByLabelText(/Your share/);
    await userEvent.clear(share);
    await userEvent.type(share, "abc");
    await userEvent.tab();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveClass("text-negative");
    expect(share).toHaveAttribute("aria-invalid", "true");
    expect(share).toHaveAttribute("aria-describedby", alert.id);
  });

  it("polish-4 #12 gives quick-split and contact pills a 44px tap target", async () => {
    render(<SplitEditor tx={tx()} onSave={vi.fn()} saving={false} contacts={["Anna"]} />);
    await open();
    for (const name of ["Split in 2", "Anna", "+ New"]) {
      expect(await screen.findByRole("button", { name })).toHaveClass("min-h-11");
    }
  });

  it("polish-4 #6 clears the error when a quick split fills a valid share", async () => {
    render(<SplitEditor tx={tx()} onSave={vi.fn()} saving={false} />);
    await open();
    const share = await screen.findByLabelText(/Your share/);
    await userEvent.clear(share);
    await userEvent.type(share, "abc");
    await userEvent.click(screen.getByRole("button", { name: "Split in 2" }));
    expect(share).toHaveValue("10");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("polish-4 #2 keeps Latin digits in the share box so it can be read back", async () => {
    setLocaleOverride("");
    Object.defineProperty(navigator, "language", { value: "ar-EG", configurable: true });
    try {
      render(<SplitEditor tx={tx({ amount: 23.78 })} onSave={vi.fn()} saving={false} />);
      await open();
      expect(await screen.findByLabelText(/Your share/)).toHaveValue("23.78");
    } finally {
      Object.defineProperty(navigator, "language", { value: "en-GB", configurable: true });
    }
  });

  it("polish-4 #2 fills the share box with the chosen decimal mark", async () => {
    setLocaleOverride("it-IT");
    try {
      const onSave = vi.fn();
      render(<SplitEditor tx={tx({ amount: 23.78 })} onSave={onSave} saving={false} />);
      await open();
      expect(await screen.findByLabelText(/Your share/)).toHaveValue("23,78");
      await userEvent.click(screen.getByRole("button", { name: "Split in 3" }));
      expect(screen.getByLabelText(/Your share/)).toHaveValue("7,93");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(onSave).toHaveBeenCalledWith(7.93, null);
    } finally {
      setLocaleOverride("");
    }
  });

  // protects=quick ÷2/÷3 splits; fails_when=the preset share is wrong or not saved
  it("fills the share from a quick split", async () => {
    const onSave = vi.fn();
    render(<SplitEditor tx={tx()} onSave={onSave} saving={false} />);
    await open();
    await userEvent.click(await screen.findByRole("button", { name: "Split in 3" }));
    expect(screen.getByLabelText(/Your share/)).toHaveValue("6.67");
    await userEvent.click(screen.getByRole("button", { name: "Split in 2" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(10, null);
  });

  // protects=saved contacts as pills; fails_when=picking several people loses one
  it("offers saved contacts as pills and saves everyone picked", async () => {
    const onSave = vi.fn();
    render(<SplitEditor tx={tx()} onSave={onSave} saving={false} contacts={["Luca M", "Anna"]} />);
    await open();
    await userEvent.click(await screen.findByRole("button", { name: "Split in 3" }));
    await userEvent.click(screen.getByRole("button", { name: "Luca M" }));
    await userEvent.click(screen.getByRole("button", { name: "Anna" }));
    expect(screen.getByRole("button", { name: "Anna" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Anna" }));
    expect(screen.getByRole("button", { name: "Anna" })).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(6.67, "Luca M");
  });

  it("doesn't add a blank or duplicate new contact, and Escape cancels", async () => {
    const onSave = vi.fn();
    render(<SplitEditor tx={tx()} onSave={onSave} saving={false} contacts={["Anna"]} />);
    await open();
    await userEvent.click(await screen.findByRole("button", { name: "Split in 2" }));
    await userEvent.click(screen.getByRole("button", { name: "+ New" }));
    await userEvent.type(screen.getByLabelText("New contact name"), "   {Enter}");
    await userEvent.click(screen.getByRole("button", { name: "+ New" }));
    await userEvent.type(screen.getByLabelText("New contact name"), "anna{Enter}");
    await userEvent.click(screen.getByRole("button", { name: "+ New" }));
    await userEvent.type(screen.getByLabelText("New contact name"), "Bob{Escape}");
    expect(screen.queryByRole("button", { name: "Bob" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(10, "anna");
  });

  it("stores the full amount as no split", async () => {
    const onSave = vi.fn();
    render(<SplitEditor tx={tx()} onSave={onSave} saving={false} />);
    await open();
    await userEvent.click(await screen.findByRole("button", { name: "+ New" }));
    await userEvent.type(screen.getByLabelText("New contact name"), "Anna{Enter}");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(null, null);
  });

  it("ignores a share above the full amount", async () => {
    const onSave = vi.fn();
    render(<SplitEditor tx={tx()} onSave={onSave} saving={false} />);
    await open();
    const share = await screen.findByLabelText(/Your share/);
    await userEvent.clear(share);
    await userEvent.type(share, "99");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("ignores an empty share instead of saving it as zero", async () => {
    const onSave = vi.fn();
    render(<SplitEditor tx={tx()} onSave={onSave} saving={false} />);
    await open();
    await userEvent.clear(await screen.findByLabelText(/Your share/));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("offers Clear only for an existing split and clears it", async () => {
    const onSave = vi.fn();
    render(
      <SplitEditor
        tx={tx({ personal_amount: 8, owed_by: "Anna" })}
        onSave={onSave}
        saving={false}
      />,
    );
    expect(screen.getByRole("button", { name: /Split Amazon/ })).toHaveTextContent("owed €12.00");
    await open();
    expect(await screen.findByRole("button", { name: "Anna" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(await screen.findByRole("button", { name: "Clear" }));
    expect(onSave).toHaveBeenCalledWith(null, null);
  });
});
