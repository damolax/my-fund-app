# My Fund App — Neon database migration

## Target architecture

My Fund App finance data moves from Supabase Postgres to the dedicated Neon database:

- Neon project: `divine-silence-16162248`
- Neon database: `my_fund_app`
- Finance data: Neon Data API
- Authentication during phase 1: existing Supabase Auth
- Production app: `https://my-fund-app-one.vercel.app/`

Supabase is retained temporarily only for sign-in, sign-up, password reset and existing user sessions. This avoids forcing current users to recreate accounts or reset passwords while the database is moved.

## What moves to Neon

The Neon schema creates:

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
- `mfa_import_supabase_snapshot()`

The schema is in `neon/schema.sql`.

## Security model

The browser never receives a Neon Postgres password.

The browser sends the signed-in user's JWT to the Neon Data API. Neon RLS uses the JWT user ID to restrict each owner to their own workspace.

Anonymous users have no direct table privileges. The public viewer can access only `mfa_get_person_public_view()` using a person's unguessable share token.

The platform admin and import functions also verify the authenticated admin email inside the database.

## Migration sequence

1. Verify that the current Supabase Auth JWT signing configuration can be validated by Neon's external-JWKS Data API configuration.
2. Apply `neon/schema.sql` to the production `my_fund_app` Neon database.
3. The Neon-backed application code is merged to `main` for production deployment.
4. Sign in with the platform-admin account.
5. Existing users automatically import their own legacy workspace on first login when Neon has no workspace yet.
6. Open **Platform admin** and click **Import Supabase data** to migrate all known My Fund App accounts at once.
7. Compare user, workspace, person and transaction counts and verify balances.
8. Keep Supabase tables unchanged until the Neon copy has been verified.
9. After verification, remove the temporary import function/button.
10. Optional phase 2: migrate authentication to Neon Auth so Supabase can be removed entirely.

## Rollback

Do not delete or modify the existing Supabase finance tables during phase 1. If a cutover issue is found, redeploy the current `main` branch and the existing Supabase-backed app remains the source of truth.

## Validation already completed

On an isolated Neon test branch:

- all six My Fund App tables were created successfully;
- all RLS policies and RPC functions were created successfully;
- anonymous direct table access was blocked;
- an authenticated database role without a valid JWT was blocked by RLS;
- the tokenized public-view RPC returned only the selected person's records;
- the frontend Neon adapter passed syntax and request-shape checks.

Production Neon schema has been applied and the Neon-backed application code has been merged to `main`. Legacy Supabase finance data is preserved as the migration source until it has been copied and verified in Neon.
