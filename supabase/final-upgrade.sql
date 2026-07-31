-- My Fund App final upgrade
-- Safe to run on an existing My Fund App installation in the shared Supabase project.
-- Adds starting balances and allows transactions whose exact date is unknown.

begin;

alter table public.mfa_people
  add column if not exists starting_balances jsonb not null default '{}'::jsonb;

alter table public.mfa_transactions
  alter column date drop not null;

alter table public.mfa_transactions
  alter column date drop default;

-- Keep existing records safe and ensure every person has a JSON object.
update public.mfa_people
set starting_balances = '{}'::jsonb
where starting_balances is null;

commit;
