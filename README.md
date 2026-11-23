# Alopex (dashboard)

A self-hosted net worth dashboard. Bank accounts, investments and crypto in one place, converted to a single currency.

**[Try the live demo →](https://app.alopex.finance/demo)** No sign-up. The demo runs on generated fake data inside your browser and never touches a real account. The data follows today's date, so the latest transactions are always from today or yesterday.

![Net worth dashboard](docs/screenshots/net-worth.png)

| Transactions                                       | Spending                                               | Portfolio                                    | Phone                                        |
| -------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------- | -------------------------------------------- |
| ![Transactions](docs/screenshots/transactions.png) | ![Spending by category](docs/screenshots/spending.png) | ![Portfolio](docs/screenshots/portfolio.png) | ![Phone layout](docs/screenshots/mobile.png) |

- **Net Worth**: total over time (bank + portfolio + crypto), in EUR, USD or GBP
- **Transactions**: full register with inline categories and a "worth it?" check
- **Subscriptions**: recurring charges with detected billing frequency and true monthly cost; one-off charges are listed separately and left out of the estimate
- **Spending** and **Income vs Expenses**: monthly breakdowns
- **Portfolio** and **Crypto**: holdings, allocation and live-priced value

This is the frontend. The data pipeline (bank sync, FX rates, AI categorization, pricing, setup wizard) is in [alopex](https://github.com/marcodonghiaa/alopex). Start there to self-host.

## Look and feel

Number-first design in the spirit of Trade Republic and Revolut:

- Each screen opens on one exact figure, set in Fragment Mono; words are Geist.
- Scrub the net-worth chart to read any past day.
- Snow ground, hairline rows, 4px and 8px corners, no pills.
- Cold ink is the only control colour (white in dark mode); Ember, the fox's fur, is the one accent.
- Phones get a bottom tab bar.
- Light and dark themes follow the system setting (no toggle). Account numbers are masked until tapped, charts carry text alternatives, and translucency falls back to solid when the OS asks for reduced transparency.

## Stack

TanStack Start (React), TypeScript, Tailwind, shadcn/ui, Recharts, Supabase, Vitest, deployed on Vercel. The app only uses the publishable key, so every read and write goes through Row Level Security (`auth.uid() = user_id`). No service-role key is used anywhere.

## Self-host it

One command installs both apps (Node 20+):

```bash
npx create-alopex
```

It creates your Supabase project, tables, Edge Functions and login, turns on the scheduled sync inside Supabase, walks you through Enable Banking and puts this dashboard online on Vercel. About 30 minutes the first time. To update, run `npx create-alopex@latest` from the same place, or inside the install folder (`@latest` so npx doesn't reuse an older cached installer). See [the installer guide](https://github.com/marcodonghiaa/alopex/blob/main/installer/README.md).

## Develop

Needs [Bun](https://bun.sh) and a `.env` (written by `npx create-alopex`, or `cp .env.example .env` and fill in your Supabase URL and publishable key).

```sh
bun install
bun run dev
```

Set your own `.env`. Without it a production build refuses to start, and `bun run dev` runs only the demo (`/demo`): the app never connects to anyone else's Supabase project.

## Import your history

Open **Import data** (a link on the Accounts page, also offered on a new empty dashboard). Pick net worth by month or spending by month, then choose a CSV: in Excel, File → Save As → CSV. The file is read in your browser and nothing is sent until you press Import.

- Amounts are read as EUR. Spending rows in another currency are skipped.
- Months can be `2024-03`, `03/2024`, `Mar 2024`, `marzo 2024` or an Excel date. Day-first dates (`03/04/2024` is 3 April) are assumed.
- Importing again overwrites months that already exist. Undo removes the rows of that import but does not bring back values it replaced.
- Examples: [`docs/examples/net-worth.csv`](docs/examples/net-worth.csv) and [`docs/examples/spending.csv`](docs/examples/spending.csv).

## Deploy on Vercel

`npx create-alopex` deploys it for you. By hand: import the repo in Vercel (framework: Other, defaults for build). Vercel sets `VERCEL=1`, which switches the Nitro preset to `vercel` in `vite.config.ts`. Add `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` (and `VITE_VAPID_PUBLIC_KEY` for push) as environment variables, then add the Vercel domain under Supabase → Authentication → URL Configuration so login redirects work: set it as Site URL and add `https://<your-domain>/reset-password` to the Redirect URLs, or the "Forgot password?" email links back to the wrong address. Every merge to `main` deploys; every PR gets a preview URL.

## Keeping your dashboard up to date

Installed with `npx create-alopex`? Run `npx create-alopex@latest` again from the same place, or inside the install folder; the rest of this section is for a dashboard you deployed from your own GitHub copy of this repo.

A GitHub copy never receives upstream fixes by itself. It ships a workflow, **update-from-upstream**, that does it as a pull request:

- Runs every Monday and on demand: **Actions** tab → **update-from-upstream** → **Run workflow**.
- Fetches the latest `main` of this repo and opens a PR titled "Update Alopex dashboard to <sha>" with the upstream commit list. If one is still open it updates that PR instead of opening another.
- Never pushes to your default branch. Review the PR and merge it; Vercel redeploys.
- Copies over the files upstream has, leaving alone `.env*`, `vercel.json`, `.vercel/`, anything your `.gitignore` matches and `.github/workflows/` (GitHub does not let a workflow change workflows). Files only in your copy are kept; edits you made to files upstream also has are overwritten, so keep customisations in new files.
- First time only: Settings → Actions → General → enable **Allow GitHub Actions to create and approve pull requests**, or the run stops after pushing the branch `update-from-upstream` and you open the PR from it by hand.

## Scripts

`bun run dev` · `bun run build` · `bun run test` · `bun run lint` · `bun run format`

## Support

If Alopex is useful to you, a ⭐ on [GitHub](https://github.com/marcodonghiaa/alopex-web) helps others find it. The app shows a small "Made with Alopex" credit at the bottom of each page.

## License

[MIT](LICENSE)
