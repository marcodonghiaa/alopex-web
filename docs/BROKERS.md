# Supported brokers

Alopex reads these exports with Import trades from CSV: stock brokers on the Portfolio page, crypto
wallets on the Crypto page. Anything else can be imported as a plain CSV with the columns
`date, side, isin, shares, price, fee` (`symbol` instead of `isin` for coins).

<!-- This table is checked against src/lib/brokers/index.ts (brokers.test.ts). Change both together. -->

| Broker         | Accounts in             | File | Last checked with a real export |
| -------------- | ----------------------- | ---- | ------------------------------- |
| Trade Republic | DE, IT, FR, ES and more | CSV  | 2026-11-17                      |
| Ledger Live    | Desktop app export      | CSV  | 2026-11-17                      |

## Ledger Live and your crypto holdings

A Ledger Live export lists every operation of those wallets, so it sets how many coins you hold
there. Nothing creates a Ledger holding for you: add each coin first with Add a coin on the Crypto
page, which makes a holding whose source is `Manual`, and the import corrects its amount. If a coin
already has a holding whose source is `Ledger` (from older data), the import uses that one instead.
A coin you still hold only under another source (an exchange sync, say) is left out, with a note: add
it as a coin, then import again. Those other holdings are never changed. A coin the file sold down to zero
that you don't hold on Ledger or by hand is left out too, with a note ("sold to zero and not held on
Ledger or by hand"), even if you hold it under another source. If a holding the file sets (`Manual` or
`Ledger`) already has trades not from Ledger Live (typed in, or from a spreadsheet import), the review
says so whether or not its amount changes: on its row under Holdings corrected, or else under Trades to
check. Those trades stay, and its return shows as not matching until you remove them.

Files priced in dollars need daily USD rates. Alopex uses the ones it has stored, and for older days
your browser asks `api.frankfurter.dev` (the app's CSP allows it); behind a firewall, allow that host.

## Your broker isn't here, or stopped working?

Open [Add my broker](https://github.com/marcodonghiaa/alopex/issues/new?template=new-broker.yml) with a
sample of its export, personal details removed. A parser is one file in `src/lib/brokers/`, a sample
in `src/lib/brokers/fixtures/` with no personal data, and a test. Pull requests are welcome.

When a broker changes its export, Alopex refuses the file instead of guessing, so nothing wrong is saved.
