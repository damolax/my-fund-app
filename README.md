# FHG Funds — Working Standalone MVP

This folder contains a complete zero-build web app for tracking money held on behalf of multiple people.

## Open it immediately

Double-click `index.html`.

The app starts in **local mode** and saves records in that browser. No installation is required.

For the most reliable local use, run a simple web server:

### Windows

```powershell
py -m http.server 8080
```

### macOS or Linux

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

## Implemented financial rules

- Only **Income** and **Expense** change money balances.
- A person is created using only their name.
- Previous records can be entered using their original dates.
- PV is an expense category with a monthly spending limit.
- The PV limit can be updated during the month.
- Upkeep is an expense category with a monthly limit calculated from the percentage in Settings.
- Budget limits do not change balances.
- Only recorded expenses reduce balances.
- PV and Upkeep expenses cannot exceed their monthly category limits.
- A person’s overall balance may be negative.
- A negative balance is displayed as borrowed funds in use.
- Negative balances are included in the owner’s net funds held.
- New income naturally reduces a negative balance.
- Multiple currencies are tracked independently without conversion.
- Goals are informational and do not change balances.

## Owner features

- Workspace dashboard with positive funds, borrowed funds and net funds by currency.
- People list and individual person dashboards.
- Historical and new income entry.
- Expense entry with purpose, price, currency, date and category.
- Monthly PV-limit editing.
- Upkeep-limit tracking.
- Negative-balance visibility.
- Complete transaction ledger.
- Secure read-only viewer links.
- Reports for everyone or one person.
- Today, 7-day, monthly, yearly, all-time and custom ranges.
- PDF, Excel and CSV downloads.
- Local JSON backup and restore.

## Enable real accounts and live cross-device links

Local mode is intended for immediate review and use on one browser. To make data available across devices and make viewer links update from anywhere:

1. Create a Supabase project.
2. Open the Supabase SQL Editor.
3. Run `supabase/schema.sql`.
4. Open `config.js`.
5. Paste your project URL and publishable key:

```javascript
window.FHG_CONFIG = {
  supabaseUrl: 'https://YOUR-PROJECT.supabase.co',
  supabasePublishableKey: 'YOUR-PUBLISHABLE-KEY'
}
```

6. Deploy the folder to a static host such as Vercel, Netlify or Cloudflare Pages.

Cloud mode provides:

- Account registration and sign-in.
- One isolated workspace per account.
- Supabase row-level security.
- Cross-device records.
- Owner dashboard realtime updates.
- Secure token-based read-only links that refresh every five seconds.

## Reports

Reports can be filtered by:

- Everyone or one person.
- All currencies or one currency.
- This month, last month, all time or a custom date range.

Exports include opening balance, income, expenses, closing balance and transaction details.

PDF and Excel libraries are loaded only when those buttons are used. CSV is generated directly by the app.

## Files

- `index.html` — application entry point.
- `app.js` — application logic and interface.
- `styles.css` — responsive visual design.
- `config.js` — optional Supabase credentials.
- `supabase/schema.sql` — cloud database, RLS and read-only viewer function.
- `PLAN.md` — final business rules and product plan.
