import { createFileRoute } from "@tanstack/react-router";
import { ImportWizard } from "@/components/import/import-wizard";
import { ImportStatement } from "@/components/transactions/import-statement";

export const Route = createFileRoute("/_authenticated/import")({
  component: ImportPage,
});

function ImportPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-8 md:py-12">
      <header className="mb-8">
        <h1 className="ios-large-title">Import data</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Bank statements, or past net worth and spending from a spreadsheet. Splitwise has its own
          page.
        </p>
      </header>
      <section className="mb-8 rounded-2xl border bg-card p-5 card-ring">
        <h2 className="text-sm font-semibold">Bank statement</h2>
        <p className="mt-1 mb-3 text-sm text-muted-foreground">
          Transactions from a CSV or PDF your bank gives you. Duplicates are skipped.
        </p>
        <ImportStatement label="Import a statement" />
      </section>
      <h2 className="mb-3 text-sm font-semibold">Monthly history from a spreadsheet</h2>
      <ImportWizard />
    </div>
  );
}
