# My Fund App — final product plan

## Purpose

My Fund App is a held-money tracker. An account owner records and manages funds for multiple people, while each person receives a secure read-only dashboard.

## Core records

### Starting balance

A starting balance is the amount already held for a person before the app’s recorded income and expenses. It may be positive or negative and is tracked separately for every currency. It can be entered when the person is created or updated later.

### Income

Income is money received for a person. Multiple income records can be entered in one operation.

### Expense

Expense is money used for a person. Each expense includes the purpose, price, currency, category, and an optional date. Multiple expenses can be entered in one operation.

## Dates

A record may be saved as Date unknown when the exact date cannot be remembered.

- It is included in all-time totals.
- It immediately changes the current balance.
- It is excluded from month-specific activity and monthly PV/Upkeep calculations because no month can be proven.

## PV and Upkeep

- PV is an expense category.
- A PV spending limit is set per person, currency, and month and can be updated during the month.
- Only dated PV expenses count toward a specific month’s limit.
- Upkeep is an expense category with a monthly limit based on the workspace percentage and dated monthly income.
- Budgets are not expenses and do not reduce the money held.

## Balance calculations

Person balance:

```text
Starting balance + recorded income − recorded expenses
```

Borrowed funds:

```text
Absolute value of a negative person balance
```

Workspace net funds held:

```text
Sum of every person’s balance, including negative balances
```

Every currency is calculated independently.

## Main owner screens

- Authentication
- Dashboard
- People
- Person dashboard
- Bulk Add Income
- Bulk Add Expense
- Starting Balance editor
- Monthly PV limit editor
- Transactions ledger
- Reports and downloads
- Settings
- Platform admin

## Person dashboard

The owner and read-only viewer see:

- Starting balance
- Total income
- Total expenses
- Current balance
- Borrowed funds when negative
- Monthly PV limit, spent, and available
- Monthly Upkeep limit, spent, and available
- Savings goals
- Recent records, including Date unknown

## Downloads

PDF, Excel, and CSV exports support:

- Everyone or one person
- All currencies or one currency
- All time, a selected period, or a custom date range
- Starting balances
- Income and expenses
- Negative balances
- Unknown-date records in all-time exports

## Administration

The platform admin can see My Fund App accounts, their workspaces, tracked people, transactions, starting balances, positive funds, borrowed funds, and net funds. Access is restricted in Supabase to `oyekunleolalekan3168@gmail.com`.
