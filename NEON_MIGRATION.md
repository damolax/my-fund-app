# My Fund App — Neon database migration

## Current production state

My Fund App now uses Neon as its finance database.

- Neon project: `divine-silence-16162248`
- Neon database: `my_fund_app`
- Finance data access: Neon Data API
- Authentication: existing Supabase Auth for sign-in, sign-up and password recovery
- Production app: `https://my-fund-app-one.vercel.app/`

There were no legacy My Fund App accounts or finance records to move, so all Supabase-to-Neon data-import tooling has been removed.

## Neon objects

The production schema in `neon/schema.sql` creates:

- `mfa_workspaces`
- `mfa_app_users`
- `mfa_people`
- `mfa_transactions`
- `mfa_monthly_budgets`
- `mfa_goals`
- owner-scoped RLS policies
- `mfa_touch_app_user()`
- `mfa_admin_overview()`
- `mfa_get_person_public_view()`

## Security

The browser never receives a Neon Postgres password.

Authenticated finance requests use the Neon Data API and database row-level security. Anonymous users cannot query finance tables directly. Public viewer links use only the secure token-based viewer RPC.

The platform administrator is enforced in the database as well as in the application interface.

## Admin analytics

The platform admin dashboard shows:

- accounts using My Fund App
- people being tracked
- total finance records
- gross money tracked by currency
- current holdings by currency
- expenses by currency
- borrowed/negative balances
- per-account totals
- per-person current balances
- the administrator's Main account

## Rollback

The Git history contains the previous Supabase-backed implementation if a code rollback is ever needed. New production finance records should be treated as Neon data.
