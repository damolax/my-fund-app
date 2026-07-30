# My Fund App — standalone and Supabase-ready

My Fund App tracks income, actual expenses, monthly PV and Upkeep limits, negative balances, borrowed funds, goals, and the total funds held for everyone.

## Safe with Elevate Office Tracker

This build can use the **same Supabase project** as Elevate Office Tracker. Every My Fund App database object is prefixed with `mfa_`:

- `mfa_workspaces`
- `mfa_people`
- `mfa_transactions`
- `mfa_monthly_budgets`
- `mfa_goals`
- `mfa_is_workspace_owner`
- `mfa_get_person_public_view`

Do not rename these to generic names. The prefix keeps both applications isolated while allowing them to share one Supabase project and its Auth service.

## Connect the existing Supabase project

1. Open the same Supabase project used by Elevate Office Tracker.
2. Open **SQL Editor**.
3. Copy and run the complete contents of `supabase/schema.sql`.
4. Open **Project Settings → API**.
5. Copy the project URL and publishable/anon key.
6. Put them in `config.js`:

```javascript
window.MY_FUND_CONFIG = {
  supabaseUrl: 'https://YOUR-PROJECT.supabase.co',
  supabasePublishableKey: 'YOUR-PUBLISHABLE-OR-ANON-KEY'
}
```

Never place the Supabase `service_role` or secret key in this browser app.

## Authentication behavior

Supabase Auth belongs to the whole Supabase project. A person who already has an Auth account in Elevate Office Tracker technically exists in the same Auth user directory. My Fund App still creates and reads only that user's own `mfa_workspaces` row through Row Level Security.

## Run locally

Double-click `index.html`, or from this folder run:

```bash
python -m http.server 8080
```

Then open `http://localhost:8080`.

## Deploy

The folder is static and can be deployed to Vercel, Netlify, or Cloudflare Pages. No build command is required.

## Core rules

- Only Income and Expense change money balances.
- PV is an expense category with an adjustable monthly limit.
- Upkeep is an expense category with a percentage-based monthly limit.
- A budget/limit never changes the money held.
- Only recorded expenses reduce balances.
- A person's balance may be negative and is shown as borrowed funds.
- Workspace totals include positive and negative balances.
- Currencies remain separate and are never converted automatically.
