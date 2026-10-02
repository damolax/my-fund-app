# My Fund App — Neon Auth and approval workflow

## Current target architecture

My Fund App runs fully on Neon for application identity and finance data.

- Neon project: `divine-silence-16162248`
- Neon database: `my_fund_app`
- Authentication: Neon Auth
- Database access: Neon Data API
- Production app: `https://my-fund-app-one.vercel.app/`

There are no legacy My Fund App accounts that require a Supabase account migration.

## Approval workflow objects

The person-link user workflow adds:

- `mfa_workspace_members`
- `mfa_record_requests`
- `mfa_record_requests`
- `mfa_notifications`
- `mfa_email_outbox`

The person-link user cannot directly write to `mfa_transactions`. Ledger changes are performed only by the owner-review RPC after the request is approved.

Reviewed requests are immutable to the person-link user.

## Notification delivery

In-app notifications are written transactionally in Neon.

Approval emails use an outbox and the Vercel endpoint `/api/record-request-email`. Email sending is idempotent through claim/complete RPCs.

Required Vercel secrets for outbound email:

- `RESEND_API_KEY`
- `MY_FUND_FROM_EMAIL`

## Security

- Database passwords are never exposed in the browser.
- Owner ledger tables remain owner-scoped by RLS.
- person-link user reads use restricted security-definer RPCs.
- person-link user writes are requests, not ledger writes.
- The secure person link is the bearer credential; no separate person login or invite is required.
- Manager review is checked against the workspace owner inside PostgreSQL.
- PV and Upkeep limits are revalidated during approval.
- Anonymous direct access to finance tables remains blocked.
