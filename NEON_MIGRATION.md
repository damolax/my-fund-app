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

The contributor workflow adds:

- `mfa_workspace_members`
- `mfa_member_invites`
- `mfa_record_requests`
- `mfa_notifications`
- `mfa_email_outbox`

The contributor cannot directly write to `mfa_transactions`. Ledger changes are performed only by the owner-review RPC after the request is approved.

Reviewed requests are immutable to the contributor.

## Notification delivery

In-app notifications are written transactionally in Neon.

Approval emails use an outbox and the Vercel endpoint `/api/record-request-email`. Email sending is idempotent through claim/complete RPCs.

Required Vercel secrets for outbound email:

- `RESEND_API_KEY`
- `MY_FUND_FROM_EMAIL`

## Security

- Database passwords are never exposed in the browser.
- Owner ledger tables remain owner-scoped by RLS.
- Contributor reads use restricted security-definer RPCs.
- Contributor writes are requests, not ledger writes.
- Invite acceptance is bound to the invited email address.
- Manager review is checked against the workspace owner inside PostgreSQL.
- PV and Upkeep limits are revalidated during approval.
- Anonymous direct access to finance tables remains blocked.
