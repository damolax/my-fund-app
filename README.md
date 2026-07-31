# My Fund App — final working build

My Fund App tracks money held for different people using starting balances, income, actual expenses, monthly PV and Upkeep limits, negative balances, borrowed funds, goals, exports, secure viewer links, and a platform-admin overview.

## Production configuration already included

- Supabase project: `https://qsnlvpwqkxqyeluafhoe.supabase.co`
- My Fund App URL: `https://my-fund-app-one.vercel.app/`
- Platform administrator: `oyekunleolalekan3168@gmail.com`

The browser app uses only the Supabase publishable key. Never add a `service_role` or secret key to `config.js`.

## Shared Supabase project

My Fund App can safely use the same Supabase project and Auth accounts as Elevate Office Tracker. Every My Fund App database object begins with `mfa_`, so the finance records stay separate from Elevate Office Tracker.

The same Supabase email and password can sign in to both apps. Browser sessions may still require a separate sign-in on each domain.

## Required database setup

### New My Fund App installation

Run this entire file in Supabase SQL Editor:

```text
supabase/schema.sql
```

### Existing My Fund App installation

Run this file once in Supabase SQL Editor:

```text
supabase/final-upgrade.sql
```

It adds:

- Editable multi-currency starting balances for every person.
- Transactions whose exact date is unknown.

It does not touch Elevate Office Tracker tables.

If the platform-admin functions have never been installed, also run:

```text
supabase/admin-auth-upgrade.sql
```

## Supabase Auth URL configuration

Keep the existing Site URL as:

```text
https://elevate-office-tracker.vercel.app/
```

Under Authentication → URL Configuration → Redirect URLs, include:

```text
https://elevate-office-tracker.vercel.app/**
https://my-fund-app-one.vercel.app/**
```

The default Supabase email templates can remain unchanged.

## Final financial rules

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

An unknown-date record affects all-time balances immediately. Because no month is known, it does not count in month-specific reports or against a particular month’s PV or Upkeep limit.

## Starting balances

A starting balance can be entered when a person is created. It can also be added or updated later from the person dashboard for any currency.

Updating it recalculates:

- Person balance
- Owner totals
- Borrowed funds
- Viewer dashboard
- Admin overview
- Reports and exports

It does not create a transaction.

## Authentication and administration

- Sign in and create account
- Forgot password
- Show/hide password
- Secure password reset
- Platform admin restricted in the database to `oyekunleolalekan3168@gmail.com`
- Admin view includes only accounts that actually use My Fund App

Passwords are never readable by the platform administrator.

## Deploy

This is a static app. Vercel requires no build command. Push the contents of this folder to:

```text
https://github.com/damolax/my-fund-app
```

Vercel will redeploy from the repository.
