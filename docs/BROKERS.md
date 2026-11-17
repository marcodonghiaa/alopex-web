# Supported brokers

Alopex reads these exports with Import trades from CSV: stock brokers on the Portfolio page, crypto
wallets on the Crypto page. Anything else can be imported as a plain CSV with the columns
`date, side, isin, shares, price, fee` (`symbol` instead of `isin` for coins).

<!-- This table is checked against src/lib/brokers/index.ts (brokers.test.ts). Change both together. -->

| Broker         | Accounts in             | File | Last checked with a real export |
| -------------- | ----------------------- | ---- | ------------------------------- |
| Trade Republic | DE, IT, FR, ES and more | CSV  | 2026-11-10                      |
| Ledger Live    | Desktop app export      | CSV  | 2026-11-17                      |

## Ledger Live and your crypto holdings

A Ledger Live export lists every operation of those wallets, so it sets how many coins you hold
there. It writes to the crypto holding whose source is `Ledger`, or else to the one whose source is
`Manual` (typed in by hand). A coin you still hold only under another source (an exchange sync, say) is
left out, with a note: add it as a coin, then import again. Those other holdings are never changed.

## Your broker isn't here, or stopped working?

Open [Add my broker](https://github.com/marcodonghiaa/alopex/issues/new?template=new-broker.yml) with a
sample of its export, personal details removed. A parser is one file in `src/lib/brokers/`, a sample
in `src/lib/brokers/fixtures/` with no personal data, and a test. Pull requests are welcome.

When a broker changes its export, Alopex refuses the file instead of guessing, so nothing wrong is saved.
