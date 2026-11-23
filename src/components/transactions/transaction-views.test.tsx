import { describe, expect, it, vi } from "vitest";
import { render as rtlRender, screen, within } from "@testing-library/react";
import { queryWrapper } from "@/test/query-wrapper";
import userEvent from "@testing-library/user-event";
import { shareToRow } from "@/lib/transactions";
import {
  TransactionCardView,
  TransactionRowView,
  type TransactionViewProps,
} from "./transaction-views";

const render = (ui: React.ReactElement) => rtlRender(ui, { wrapper: queryWrapper() });

const props = (): TransactionViewProps => ({
  tx: shareToRow({
    id: "s1",
    booking_date: "2026-10-04",
    category: "Dine Out",
    description: "Dinner",
    group_name: "Trip",
    currency: "EUR",
    amount: 12.5,
    amount_eur: 12.5,
  }),
  accountLabel: "—",
  onSelectCategory: vi.fn(),
  savingCategory: false,
  onSelectType: vi.fn(),
  savingType: false,
  selected: false,
  onToggleSelect: vi.fn(),
  onAnswerWorthIt: vi.fn(),
  savingSplit: false,
  onSaveSplit: vi.fn(),
  onRename: vi.fn(),
  savingRename: false,
});

// protects=a Splitwise share offers only name and category: the other editors and the bulk
// select/delete write to the transactions table, which a share is not part of;
// fails_when=a checkbox, type or split editor appears, or name/category cannot be changed
describe("Splitwise share rows allow only name and category edits", () => {
  it("table row lets you rename and recategorise, with no checkbox", async () => {
    const p = props();
    render(
      <table>
        <tbody>
          <TransactionRowView {...p} />
        </tbody>
      </table>,
    );
    expect(screen.getByTitle("Splitwise")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /Edit/ })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Rename Dinner" }));
    const input = await screen.findByRole("textbox");
    await userEvent.clear(input);
    await userEvent.type(input, "Pizza");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(p.onRename).toHaveBeenCalledWith("Pizza");

    await userEvent.click(screen.getByRole("button", { name: /Change category for/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Groceries" }));
    expect(p.onSelectCategory).toHaveBeenCalledWith("Groceries");
  });

  it("card opens a sheet with name and category only", async () => {
    render(
      <ul>
        <TransactionCardView {...props()} />
      </ul>,
    );
    expect(screen.getByTitle("Splitwise")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Dinner/ }));
    expect(await screen.findByRole("button", { name: "Rename Dinner" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Change category for/ })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByText("Type")).toBeNull();
    expect(screen.queryByText("Split")).toBeNull();
  });

  // polish-4 #E: fails_when=opening the edit sheet leaves focus on the row behind the overlay
  it("card moves focus into the sheet when it opens", async () => {
    render(
      <ul>
        <TransactionCardView {...props()} />
      </ul>,
    );
    await userEvent.click(screen.getByRole("button", { name: /Dinner/ }));
    expect(await screen.findByRole("dialog")).toContainElement(
      document.activeElement as HTMLElement,
    );
  });
});

// protects=a bank row stays a single clean line on a phone and every editor sits behind a tap;
// fails_when=the editors render inline in the row again, or the tap no longer opens them
describe("Bank card rows", () => {
  const bankProps = (): TransactionViewProps => {
    const base = props();
    return {
      ...base,
      tx: {
        ...base.tx,
        entry_reference: "bank-1",
        creditor_name: "Uber",
        category: "Transports",
        currency: "USD",
        amount: 15,
        signed_amount_eur: -13.2,
      },
      accountLabel: "Revolut USD",
    };
  };

  it("shows the foreign amount with its symbol and the euro value, with no editors inline", () => {
    render(
      <ul>
        <TransactionCardView {...bankProps()} />
      </ul>,
    );
    expect(screen.getByText("Uber")).toBeInTheDocument();
    expect(screen.getByText(/−US\$15\.00/)).toBeInTheDocument();
    expect(screen.getByText(/≈ €13\.20/)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByLabelText(/Change category/)).toBeNull();
  });

  it("opens the editors in a sheet when tapped", async () => {
    render(
      <ul>
        <TransactionCardView {...bankProps()} />
      </ul>,
    );
    await userEvent.click(screen.getByRole("button", { name: /Uber/ }));
    expect(await screen.findByLabelText(/Change category for Uber/)).toBeInTheDocument();
    // iOS view board (Revolut-style sheet): Select lives in the ⋯ menu, not in the list.
    expect(screen.queryByRole("checkbox")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(await screen.findByRole("checkbox", { name: "Select" })).toBeInTheDocument();
  });

  // iOS view board: a Revolut-style header with the merchant's initial, the amount and the day.
  it("opens on a header with the merchant initial, amount, and date with account", async () => {
    render(
      <ul>
        <TransactionCardView {...bankProps()} />
      </ul>,
    );
    await userEvent.click(screen.getByRole("button", { name: /Uber/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByTestId("merchant-initial")).toHaveTextContent("U");
    expect(within(dialog).getByText(/Revolut USD/)).toBeInTheDocument();
  });

  // protects=on a phone the sheet covers the toast, so Make a rule must be in the sheet itself
  it("offers Make a rule in the sheet, next to the category", async () => {
    const onClick = vi.fn();
    render(
      <ul>
        <TransactionCardView {...bankProps()} makeRule={{ label: "Make a rule", onClick }} />
      </ul>,
    );
    await userEvent.click(screen.getByRole("button", { name: /Uber/ }));
    await userEvent.click(await screen.findByRole("button", { name: /Make a rule/ }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});

// protects=only transactions added by hand get an amount editor: bank amounts are the bank's
describe("amount editing", () => {
  const bankRow = (): TransactionViewProps => ({
    ...props(),
    tx: { ...props().tx, account_uid: "acc", entry_reference: "manual-1", amount: 45.5 },
  });

  it("shows Change amount in the sheet for a manual row", async () => {
    render(<TransactionCardView {...bankRow()} onSaveAmount={vi.fn()} savingAmount={false} />);
    await userEvent.click(screen.getAllByRole("button")[0]!);
    expect(await screen.findByRole("button", { name: "Change amount" })).toBeTruthy();
  });

  it("has no amount editor for a bank row", async () => {
    render(<TransactionCardView {...bankRow()} />);
    await userEvent.click(screen.getAllByRole("button")[0]!);
    await screen.findByRole("dialog");
    expect(screen.queryByRole("button", { name: "Change amount" })).toBeNull();
  });
});

describe("polish-5 #14 long descriptions on desktop", () => {
  // jsdom has no layout: check the table-cell trick itself. A w-full cell with max-w-0 takes the
  // space left and lets the name truncate, instead of widening the table past the Amount column.
  it("lets the merchant cell shrink so the name truncates", () => {
    render(
      <table>
        <tbody>
          <TransactionRowView {...props()} />
        </tbody>
      </table>,
    );
    const cell = screen.getByRole("button", { name: "Rename Dinner" }).closest("td");
    expect(cell).toHaveClass("w-full", "max-w-0");
  });
});

// protects=the table drops the account badge when every row is from one account, and an open
// "worth it?" is a one-line hint (answered in the sheet), so rows keep one height;
// fails_when=the badge shows with one account, hides with several, or Yes/No buttons are inline
describe("Table row noise", () => {
  const bank = (over: Partial<TransactionViewProps> = {}): TransactionViewProps => {
    const base = props();
    return {
      ...base,
      tx: {
        ...base.tx,
        entry_reference: "bank-2",
        account_uid: "acc-1",
        creditor_name: "Zalando",
        category: "Shopping",
        amount: 40,
        signed_amount_eur: -40,
        credit_debit_indicator: "DBIT",
        created_at: "2020-01-01T00:00:00Z",
      },
      accountLabel: "Revolut EUR",
      ...over,
    };
  };
  const renderRow = (p: TransactionViewProps) =>
    render(
      <table>
        <tbody>
          <TransactionRowView {...p} />
        </tbody>
      </table>,
    );

  it("shows the account badge with several accounts", () => {
    renderRow(bank({ showAccount: true }));
    expect(screen.getByTitle("Revolut EUR")).toBeInTheDocument();
  });

  it("hides the account badge with one account", () => {
    renderRow(bank({ showAccount: false }));
    expect(screen.queryByTitle("Revolut EUR")).toBeNull();
  });

  it("puts an open worth-it question on the second line, with no inline buttons", () => {
    renderRow(bank());
    expect(screen.getByText("Worth it?")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Yes" })).toBeNull();
  });

  // iOS view board: an answer is counted on Spending's recap; the list stays clean.
  it("drops a recorded answer from the second line", () => {
    const p = bank();
    renderRow({ ...p, tx: { ...p.tx, worth_it: "no" } });
    expect(screen.queryByText(/worth it/i)).toBeNull();
  });

  it("card shows the open question but not a recorded answer", () => {
    const p = bank();
    const { unmount } = render(<TransactionCardView {...p} />);
    expect(screen.getByText("Worth it?")).toBeInTheDocument();
    unmount();
    render(<TransactionCardView {...p} tx={{ ...p.tx, worth_it: "yes" }} />);
    expect(screen.getByText("Shopping")).toBeInTheDocument();
    expect(screen.queryByText(/worth it/i)).toBeNull();
  });

  // iOS view board: opening an unanswered purchase asks first, inside the sheet.
  it("opens the sheet on the worth-it question when it is unanswered", async () => {
    const p = bank();
    render(<TransactionCardView {...p} />);
    await userEvent.click(screen.getByRole("button", { name: /Zalando/ }));
    const ask = await screen.findByRole("group", { name: "Worth it?" });
    await userEvent.click(within(ask).getByRole("button", { name: /Yes/ }));
    expect(p.onAnswerWorthIt).toHaveBeenCalledWith("yes");
  });

  it("asks nothing up top once answered", async () => {
    const p = bank();
    render(<TransactionCardView {...p} tx={{ ...p.tx, worth_it: "yes" }} />);
    await userEvent.click(screen.getByRole("button", { name: /Zalando/ }));
    await screen.findByRole("dialog");
    expect(screen.queryByRole("group", { name: "Worth it?" })).toBeNull();
  });

  // iOS view board: card-processor prefixes and reference codes are trimmed for display.
  it("shows a cleaned merchant name", () => {
    const p = bank();
    render(<TransactionCardView {...p} tx={{ ...p.tx, creditor_name: "Sq *veniero's" }} />);
    expect(screen.getByText("Veniero's")).toBeInTheDocument();
  });
});

// protects=a bank row's sheet has note and tags editors and the row shows its tags and note;
// a Splitwise share has neither; fails_when=the editors vanish or appear on a share
describe("notes and tags", () => {
  const bankRow = (): TransactionViewProps => ({
    ...props(),
    tx: {
      ...props().tx,
      account_uid: "acc",
      entry_reference: "bank-2",
      creditor_name: "Hotel",
      note: "Paid for two",
      tags: ["trip"],
    },
    onSaveNote: vi.fn(),
    onSaveTags: vi.fn(),
    tagSuggestions: ["work"],
  });

  it("card shows the tags and opens note and tag editors", async () => {
    const p = bankRow();
    render(
      <ul>
        <TransactionCardView {...p} />
      </ul>,
    );
    expect(screen.getByText(/#trip/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Hotel/ }));
    expect(await screen.findByLabelText("Note")).toHaveValue("Paid for two");
    await userEvent.type(screen.getByRole("combobox", { name: "Tags" }), "work{Enter}");
    expect(p.onSaveTags).toHaveBeenCalledWith(["trip", "work"]);
  });

  // fails_when=a search that matches a note shows a phone card with no visible reason
  it("card shows the note too", () => {
    render(
      <ul>
        <TransactionCardView {...bankRow()} />
      </ul>,
    );
    expect(screen.getByText("Paid for two")).toBeInTheDocument();
  });

  // polish-4 #8: fails_when=a note cut short on a phone card can't be read in full by hovering
  it("card puts the whole note in its title, like the table row", () => {
    render(
      <ul>
        <TransactionCardView {...bankRow()} />
      </ul>,
    );
    expect(screen.getByText("Paid for two")).toHaveAttribute("title", "Paid for two");
  });

  // polish-3 #9: fails_when=the visible Note / Tags headings aren't the fields' labels
  it("labels the note and tag fields with their headings", async () => {
    render(
      <ul>
        <TransactionCardView {...bankRow()} />
      </ul>,
    );
    await userEvent.click(screen.getByRole("button", { name: /Hotel/ }));
    const note = await screen.findByLabelText("Note");
    expect(screen.getByText("Note", { selector: "label" })).toHaveAttribute("for", note.id);
    expect(screen.getByText("Tags", { selector: "label" })).toHaveAttribute(
      "for",
      screen.getByRole("combobox", { name: "Tags" }).id,
    );
    // polish-4 #10: fails_when=an aria-label hides the visible heading, so "click Tags" by voice
    // finds nothing
    expect(screen.getByRole("combobox", { name: "Tags" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Note" })).toBe(note);
  });

  it("table row shows the note under the name", () => {
    render(
      <table>
        <tbody>
          <TransactionRowView {...bankRow()} />
        </tbody>
      </table>,
    );
    expect(screen.getByText("Paid for two")).toBeInTheDocument();
    expect(screen.getByText(/#trip/)).toBeInTheDocument();
  });

  it("a Splitwise share gets no note or tag editor", async () => {
    render(
      <ul>
        <TransactionCardView {...props()} onSaveNote={vi.fn()} onSaveTags={vi.fn()} />
      </ul>,
    );
    await userEvent.click(screen.getByRole("button", { name: /Dinner/ }));
    await screen.findByRole("dialog");
    expect(screen.queryByLabelText("Note")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});

const bankProps = (over: Partial<TransactionViewProps["tx"]> = {}): TransactionViewProps => ({
  ...props(),
  tx: {
    entry_reference: "b1",
    account_uid: "a1",
    booking_date: "2026-10-04",
    category: "Groceries",
    transaction_type: "One-time",
    creditor_name: "Market",
    currency: "EUR",
    amount: 59.08,
    signed_amount_eur: -59.08,
    credit_debit_indicator: "DBIT",
    created_at: null,
    worth_it: null,
    personal_amount: null,
    owed_by: null,
    flow_type: "spend",
    refund_of: null,
    note: null,
    tags: [],
    ...over,
  },
});

const inTable = (p: TransactionViewProps) =>
  render(
    <table>
      <tbody>
        <TransactionRowView {...p} />
      </tbody>
    </table>,
  );

// Polish 4 #8: at 768px, with the sidebar open, 16px paddings left merchant names ~6 characters.
// fails_when=the date, merchant or amount cell keeps 16px side padding below lg
describe("Table row at tablet width", () => {
  it("uses tight side padding below lg so the merchant name has room", () => {
    inTable(bankProps());
    const cells = screen.getAllByRole("cell").slice(1, 4);
    for (const cell of cells) expect(cell).toHaveClass("px-2", "lg:px-4");
  });
});

// protects=a split charge shows my share as the big number; fails_when=the row leads with the whole charge
describe("Split charge amount", () => {
  it("shows my share large and the whole charge under it", () => {
    inTable(bankProps({ personal_amount: 29.54 }));
    expect(screen.getByText("−€29.54")).toBeInTheDocument();
    expect(screen.getByText("of €59.08")).toBeInTheDocument();
    expect(screen.queryByText("−€59.08")).toBeNull();
  });

  // Marco's review: the section already says it's for others, so show just the owed amount.
  it("shows a charge paid entirely for others as just the owed amount", () => {
    inTable(bankProps({ personal_amount: 0 }));
    expect(screen.getByText("−€59.08")).toBeInTheDocument();
    expect(screen.queryByText("€0.00")).toBeNull();
    expect(screen.queryByText(/^of /)).toBeNull();
  });

  // Re-audit gap on polish 1 #7: the row note's owed amount.
  it("notes what others owe on a split row", () => {
    inTable(bankProps({ amount: 20, signed_amount_eur: -20, personal_amount: 8 }));
    expect(screen.getByText(/split, owed €12\.00/)).toBeInTheDocument();
  });

  // Polish 4 #7: the sheet showed −€18.00 with nothing saying others owe all of it.
  // fails_when=the sheet header of a paid-for-others row has no "not counted" line
  it("says in the sheet that a charge paid for others isn't counted", async () => {
    render(
      <ul>
        <TransactionCardView {...bankProps({ personal_amount: 0 })} />
      </ul>,
    );
    await userEvent.click(screen.getByRole("button", { name: /Market/ }));
    expect(await screen.findByText("Paid for others · not counted")).toBeInTheDocument();
  });

  it("adds no such line to a charge that is mine", async () => {
    render(
      <ul>
        <TransactionCardView {...bankProps({ personal_amount: 20 })} />
      </ul>,
    );
    await userEvent.click(screen.getByRole("button", { name: /Market/ }));
    await screen.findByRole("dialog");
    expect(screen.queryByText(/not counted/)).toBeNull();
  });

  // Polish 4 #5: money in can't be owed to me. fails_when=the row note says "owed" on money in
  it("notes 'not mine', not 'owed', on split money in", () => {
    inTable(
      bankProps({
        credit_debit_indicator: "CRDT",
        amount: 20,
        signed_amount_eur: 20,
        personal_amount: 0,
      }),
    );
    expect(screen.getByText(/split, not mine €20\.00/)).toBeInTheDocument();
    expect(screen.queryByText(/owed/)).toBeNull();
  });

  // Polish 3 #6: money in with a 0 share showed "+€0.00 of €20.00".
  it("shows money in with a 0 share as the whole amount", () => {
    inTable(
      bankProps({
        credit_debit_indicator: "CRDT",
        amount: 20,
        signed_amount_eur: 20,
        personal_amount: 0,
      }),
    );
    expect(screen.getByText("+€20.00")).toBeInTheDocument();
    expect(screen.queryByText(/^of /)).toBeNull();
  });

  it("shows an unsplit charge as before, with no 'of' line", () => {
    inTable(bankProps());
    expect(screen.getByText("−€59.08")).toBeInTheDocument();
    expect(screen.queryByText(/^of /)).toBeNull();
  });

  it("converts only my share to euros for a foreign charge", () => {
    inTable(
      bankProps({ currency: "USD", amount: 100, signed_amount_eur: -90, personal_amount: 50 }),
    );
    expect(screen.getByText("≈ €45.00")).toBeInTheDocument();
  });
});
