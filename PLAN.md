# FHG Funds — Final Product Plan

## Product goal

FHG Funds is a focused held-money tracker. An account owner records income and actual expenses for several people, while each person gets a secure read-only dashboard.

## Non-negotiable financial rules

1. The only financial transactions are **Income** and **Expense**.
2. A person requires only a **name** when created.
3. Previous records are entered as dated income and expense transactions.
4. **PV is an expense category**, not an allocation transaction.
5. A PV limit is set per person, currency and month. It can be increased during the month, but only recorded PV expenses affect balances.
6. Upkeep is an expense category with a monthly limit equal to the workspace Upkeep percentage multiplied by the person’s recorded income for that month and currency.
7. PV and Upkeep expenses cannot exceed their category limits.
8. The overall person balance may become negative. Negative means the person is using borrowed funds.
9. New income naturally reduces a negative balance because balance is always income minus expenses.
10. The owner’s net funds held are the sum of every person’s balance, including negative balances.
11. Different currencies are never converted or combined.
12. A budget or goal never changes a balance. Only an Income or Expense transaction changes money held.

## Main calculations

- Person balance = all recorded income − all recorded expenses.
- Borrowed funds for a person = absolute value of a negative balance.
- Positive funds held = sum of positive person balances.
- Borrowed funds in use = sum of absolute negative person balances.
- Net funds held = positive funds held − borrowed funds in use.
- PV available this month = PV monthly limit − recorded PV expenses this month.
- Upkeep available this month = monthly income × Upkeep percentage − recorded Upkeep expenses.

## Core screens

- Owner sign-up and sign-in.
- Dashboard with positive funds, borrowed funds and net funds by currency.
- People list.
- Person dashboard.
- Add Income.
- Add Expense.
- Monthly PV limit editor.
- Transactions ledger.
- Reports and downloads.
- Secure read-only person dashboard.
- Workspace settings.

## Exports

The owner can export everyone or one person for all time, a preset period or a custom range in:

- PDF
- Excel
- CSV

Reports include opening balance, period income, period expenses, closing balance and detailed transactions.

## Delivery approach

- Responsive React/Vite web app.
- Immediate local demo mode using browser storage.
- Supabase cloud mode for accounts, protected data, cross-device access and live viewer links.
- Realtime refresh for owner screens and five-second secure polling for anonymous viewer links.
