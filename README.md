# My Fund App — Neon production build

My Fund App tracks money you are holding for different people: starting balances, income, expenses, PV and Upkeep limits, borrowed/negative balances, goals, exports, secure person links, approval requests and platform-admin analytics.

## Architecture

- App: `https://my-fund-app-one.vercel.app/`
- Database: Neon Postgres, database `my_fund_app`
- Browser database access: Neon Data API
- Owner/admin authentication: Neon Auth
- Platform administrator: `oyekunleolalekan3168@gmail.com`

The browser never receives a Postgres password. Neon Auth protects the owner workspace, while each tracked person gets one unguessable secure link for their own account view.

## Owner / manager

The workspace owner can:

- add people whose money is being held
- record income and expenses directly
- set starting balances
- manage PV and Upkeep limits
- manage goals
- view reports and exports
- share each person's secure finance link
- review pending record requests from those links
- approve or reject every requested record

## Secure person link

There is no contributor account, contributor role or separate contributor login.

A tracked person receives their existing secure link:

```text
https://my-fund-app-one.vercel.app/#/view/<secure-token>
```

That link allows the holder to:

- view only that person's approved records and balances
- request a new income record
- request a new expense record
- edit a request while it is still pending
- delete a request while it is still pending
- see whether a request was approved or rejected
- read an optional manager note

The link never allows the holder to:

- edit an approved transaction
- delete an approved transaction
- change a starting balance
- change PV or Upkeep limits
- change goals
- access another person's account
- write directly to the real ledger

Replacing the secure link invalidates the old URL.

## Approval workflow

Requests are stored separately in `mfa_record_requests`.

1. The person opens their secure link.
2. They submit a new income or expense request.
3. Neon stores it as `pending`; the real `mfa_transactions` ledger stays unchanged.
4. The owner gets an in-app notification.
5. While still pending, the person may edit or delete that request from the same secure link.
6. The owner opens **Approvals** and reviews the proposed record.
7. **Approve and record** creates the real transaction.
8. **Reject** leaves the ledger unchanged.
9. After either decision, the person can no longer edit or delete that request.
10. Approved ledger records remain read-only from the person's link.

The backend enforces that person-link requests are create-only. They cannot be used to request edits to an already-approved transaction.

PV and Upkeep rules are validated again during manager approval.

## Approval email notifications

When a person submits or edits a pending request, Neon creates an email outbox item with a direct manager link:

```text
https://my-fund-app-one.vercel.app/#/approvals?request=<request-id>
```

The Vercel endpoint `/api/record-request-email` supports secure-link submissions as well as authenticated calls.

Outbound mail requires:

```text
RESEND_API_KEY=<your Resend API key>
MY_FUND_FROM_EMAIL=My Fund App <notifications@your-verified-domain.com>
```

Without those variables, the request and in-app manager notification still work; the email remains pending rather than being falsely marked sent.

## Neon schema

Canonical schema:

```text
neon/schema.sql
```

Person-link workflow patch:

```text
neon/person-link-approval.sql
```

Main finance tables:

- `mfa_workspaces`
- `mfa_app_users`
- `mfa_people`
- `mfa_transactions`
- `mfa_monthly_budgets`
- `mfa_goals`

Approval support:

- `mfa_record_requests`
- `mfa_notifications`
- `mfa_email_outbox`

Older account-based approval tables/functions may remain in the schema for compatibility, but their authenticated RPC access is disabled and the application does not expose that workflow.

## Platform administrator

The platform admin dashboard includes:

- accounts using the app
- people being tracked
- total finance records
- gross money tracked per currency
- current holdings
- expenses
- borrowed/negative balances
- per-account and per-person balances
- the administrator's Main account

## Financial definitions

**Total money tracked**

```text
positive opening balances + recorded income
```

**Current balance**

```text
starting balance + recorded income - recorded expenses
```

Currencies are always kept separate.

## Authentication

Owner/admin login uses Neon Auth.

Supported flows:

- Create account
- Sign in
- Forgot password
- Reset password
- Sign out
- Cross-tab session updates

The person-facing secure finance link does not require a login.

## Deployment

The app deploys from GitHub to Vercel. `api/record-request-email.js` is deployed as a Vercel serverless function.
