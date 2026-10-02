# My Fund App — Neon production build

My Fund App tracks money held for different people using starting balances, income, actual expenses, monthly PV and Upkeep limits, negative balances, borrowed funds, goals, exports, secure viewer links, and a platform-admin overview.

## Production architecture

- App URL: `https://my-fund-app-one.vercel.app/`
- Finance database: Neon Postgres, database `my_fund_app`
- Browser data access: Neon Data API
- Authentication during the current transition: existing Supabase Auth
- Platform administrator: `oyekunleolalekan3168@gmail.com`

The browser never receives a Neon Postgres password. Finance data is protected by Neon row-level security and accessed through the Neon Data API.

Supabase is retained temporarily only for sign-in, sign-up, password recovery and existing user sessions. All My Fund App finance data is stored in Neon.

## Neon database setup

The production Neon schema is stored in:

```text
neon/schema.sql
```

It creates:

- `mfa_workspaces`
- `mfa_app_users`
- `mfa_people`
- `mfa_transactions`
- `mfa_monthly_budgets`
- `mfa_goals`
- workspace-owner RLS policies
- secure public-view RPC
- platform-admin overview RPC

## Platform administrator

Admin access is restricted in the database and interface to:

```text
oyekunleolalekan3168@gmail.com
```

The admin dashboard provides:

- number of accounts using My Fund App
- total people being tracked
- total income and expense records
- gross money tracked per currency
- current holdings per currency
- total expenses per currency
- borrowed/negative balances per currency
- per-account people and record counts
- per-person current balances
- a dedicated Main account section for the administrator account

### Analytics definitions

**Total money tracked**:

```text
positive opening balances + recorded income
```

**Current balance for a person**:

```text
starting balance + recorded income - recorded expenses
```

**Current platform holdings** are the sum of all current person balances by currency. Negative balances are shown separately as borrowed funds. Currencies are never converted or combined.

## Financial rules

- Starting balance is an opening position, not income or expense.
- Starting balances can be positive or negative and are stored separately per currency.
- Only Income and Expense are transactions.
- PV is an expense category with an adjustable monthly spending limit.
- Upkeep is an expense category with a monthly limit based on the percentage in Settings.
- Budgets do not change balances; only recorded expenses do.
- A person can have a negative balance, displayed as borrowed funds.
- Workspace totals include starting balances and every positive or negative person balance.
- Currencies remain separate and are never converted.

## Bulk records

The Income and Expense forms allow multiple rows to be saved together. Every row can have its own:

- Amount
- Currency
- Date or Date unknown
- Expense category, where applicable
- Description

An unknown-date record affects all-time balances immediately. Because no month is known, it does not count in month-specific reports or against a particular month's PV or Upkeep limit.

## Starting balances

A starting balance can be entered when a person is created. It can also be added or updated later from the person dashboard for any currency.

Updating it recalculates person balance, owner totals, borrowed funds, viewer dashboard, admin overview, reports and exports. It does not create a transaction.

## Authentication

The current release keeps the existing Supabase Auth directory so existing users keep their login credentials while the finance database moves to Neon.

Supported flows remain:

- Sign in
- Create account
- Forgot password
- Password reset
- Show/hide password

A later phase can move authentication to Neon Auth if complete Supabase removal is desired.

## Deployment

This remains a static Vercel app with no build command. The production Vercel project deploys from the repository's `main` branch.

See `NEON_MIGRATION.md` for migration and rollback details.
