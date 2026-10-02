# My Fund App — Neon production build

My Fund App tracks money held for different people using starting balances, income, expenses, monthly PV and Upkeep limits, negative balances, borrowed funds, goals, exports, secure viewer links, contributor approvals and platform-admin analytics.

## Architecture

- App URL: `https://my-fund-app-one.vercel.app/`
- Database: Neon Postgres, database `my_fund_app`
- Browser database access: Neon Data API
- Authentication: Neon Auth
- Platform administrator: `oyekunleolalekan3168@gmail.com`

The browser never receives a Postgres password. Neon Auth JWTs are injected into Data API requests and PostgreSQL row-level security controls access.

## Roles

### Workspace owner

The owner has the normal My Fund App workspace and can:

- create people
- record income and expenses directly
- set starting balances
- manage PV and Upkeep limits
- manage goals
- view reports and exports
- invite contributors for specific people
- approve or reject contributor record requests
- disable contributor access

### Contributor

A contributor is connected to one tracked person by a secure, email-bound invite.

A contributor can:

- see that person's approved records and balances
- submit a new income or expense request
- request a correction to an existing approved record
- edit or delete their own request while it is pending
- see whether a request was approved or rejected
- read manager notes

A contributor cannot directly insert, update or delete the real ledger. After a request is approved or rejected, the contributor cannot edit or delete that request.

## Approval workflow

Contributor requests are stored separately in `mfa_record_requests`.

Approval rules are enforced inside Neon:

1. Contributor submits a pending request.
2. The owner receives an in-app notification.
3. The real `mfa_transactions` ledger remains unchanged.
4. The contributor may edit or delete the request while it is pending.
5. The owner opens **Approvals** and reviews the exact proposed record.
6. **Approve** inserts a new ledger record or applies the requested update.
7. **Reject** leaves the ledger unchanged.
8. The reviewed request becomes immutable to the contributor.
9. The contributor receives an in-app approved/rejected notification.

PV and Upkeep limits are checked again inside the approval transaction, including update requests, so contributor approvals cannot bypass the finance rules.

## Approval email notifications

When a contributor submits or edits a request, Neon creates an email outbox record containing a deep link such as:

```text
https://my-fund-app-one.vercel.app/#/approvals?request=<request-id>
```

The Vercel route `/api/record-request-email` safely claims the outbox item before sending, preventing duplicate sends.

To enable outbound approval emails, configure these Vercel environment variables:

```text
RESEND_API_KEY=<your Resend API key>
MY_FUND_FROM_EMAIL=My Fund App <notifications@your-verified-domain.com>
```

If those variables are not configured, the finance request and in-app notification still work and the email remains pending instead of being falsely marked sent.

## Neon schema

The canonical schema is:

```text
neon/schema.sql
```

The approval migration is also retained separately at:

```text
neon/approval-workflow.sql
```

Core tables:

- `mfa_workspaces`
- `mfa_app_users`
- `mfa_people`
- `mfa_transactions`
- `mfa_monthly_budgets`
- `mfa_goals`

Approval tables:

- `mfa_workspace_members`
- `mfa_member_invites`
- `mfa_record_requests`
- `mfa_notifications`
- `mfa_email_outbox`

## Platform administrator

Admin access is restricted in the database and interface to:

```text
oyekunleolalekan3168@gmail.com
```

The admin dashboard includes accounts using the app, people being tracked, total records, gross money tracked by currency, expenses, current holdings, borrowed balances, per-account totals, per-person balances and a dedicated Main account section.

## Financial definitions

**Total money tracked**:

```text
positive opening balances + recorded income
```

**Current balance**:

```text
starting balance + recorded income - recorded expenses
```

Currencies are always kept separate.

## Authentication

My Fund App uses the Neon Auth integration already available in the Neon project.

Supported flows:

- Create account
- Sign in
- Forgot password
- Reset password
- Sign out
- Cross-tab session updates

The frontend uses `@neondatabase/neon-js` with its Supabase-compatible adapter only as an API style. No Supabase service or Supabase key is used by My Fund App.

## Deployment

The app deploys from GitHub to Vercel. The static frontend has no build command; `api/record-request-email.js` is deployed as a Vercel serverless function.
