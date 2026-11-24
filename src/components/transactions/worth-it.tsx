import { Button } from "@/components/ui/button";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { formatMoney, isSplit, myShare, type TransactionRow } from "@/lib/transactions";
import { cleanMerchantName } from "@/lib/merchant-name";

/** The recorded answer, in the edit sheet's "Worth it" row (shown only once there is one). */
export function WorthItPrompt({ tx }: { tx: TransactionRow }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      {tx.worth_it === "yes" ? <ThumbsUp className="size-3" /> : <ThumbsDown className="size-3" />}
      {tx.worth_it === "yes" ? "Worth it" : "Not worth it"}
    </span>
  );
}

export function WorthItSpotlight({
  tx,
  onAnswer,
  onClose,
}: {
  tx: TransactionRow | null;
  onAnswer: (tx: TransactionRow, worthIt: "yes" | "no") => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={tx != null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {tx && (
        <DialogContent className="max-w-sm text-center">
          <DialogHeader>
            <DialogTitle className="text-center text-xl">Worth it?</DialogTitle>
            <DialogDescription className="text-center">
              {cleanMerchantName(tx.creditor_name) ?? "A purchase"} · {tx.category}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <p className="font-figure text-4xl text-foreground">
              {formatMoney(myShare(tx), tx.currency ?? "EUR")}
            </p>
            {isSplit(tx) && (
              <p className="mt-1 text-sm text-muted-foreground">
                your share of {formatMoney(Math.abs(tx.amount ?? 0), tx.currency ?? "EUR")}
              </p>
            )}
          </div>
          <div className="flex gap-3">
            <Button
              variant="quiet"
              onClick={() => {
                onAnswer(tx, "no");
                onClose();
              }}
              className="flex-1 bg-muted"
            >
              No
            </Button>
            <Button
              onClick={() => {
                onAnswer(tx, "yes");
                onClose();
              }}
              className="flex-1"
            >
              Yes
            </Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
