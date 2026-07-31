# Corrected production release

This release consolidates all My Fund App corrections into one package.

## Authentication corrections

- Uses the existing Elevate Office Tracker Supabase Auth user directory.
- Adds the My Fund App production URL to account-confirmation requests.
- Sends password-recovery users back to My Fund App, not the Supabase Site URL.
- Keeps the default Supabase email templates unchanged.
- Adds confirm-password validation during account creation.
- Keeps show/hide password controls.
- Prevents silent fallback to local mode when cloud credentials exist but the Supabase browser library fails to load.
- Gives a clear database-setup error when the `mfa_*` schema has not been run.

## Admin corrections

- Locks platform access to `oyekunleolalekan3168@gmail.com` in both the interface and database function.
- Tracks only users who create an account through or sign in to My Fund App.
- Prevents callers from spoofing the email saved by the account-activity function.

## Finance rules retained

- Budgets do not affect balances.
- Only recorded income and expenses affect balances.
- PV is an actual expense category with a monthly limit.
- Upkeep is an actual expense category with a percentage-based monthly limit.
- Negative balances are allowed and displayed as borrowed funds.
- Workspace totals include every positive and negative person balance.
- Multi-currency balances remain separate.
