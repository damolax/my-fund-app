-- FHG Funds database schema
-- Run this entire file once in the Supabase SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'FHG Funds',
  default_currency text not null default 'NGN',
  upkeep_percentage numeric(7,2) not null default 20 check (upkeep_percentage >= 0 and upkeep_percentage <= 100),
  created_at timestamptz not null default now(),
  unique(owner_id)
);

create table if not exists public.people (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  share_token uuid not null default gen_random_uuid() unique,
  created_at timestamptz not null default now(),
  unique(id, workspace_id)
);

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  person_id uuid not null,
  type text not null check (type in ('income', 'expense')),
  amount numeric(18,2) not null check (amount > 0),
  currency text not null,
  date date not null default current_date,
  description text not null check (length(trim(description)) > 0),
  category text check (
    (type = 'income' and category is null)
    or
    (type = 'expense' and category in ('PV', 'Upkeep', 'Investment', 'Other'))
  ),
  created_at timestamptz not null default now(),
  foreign key (person_id, workspace_id) references public.people(id, workspace_id) on delete cascade
);

create index if not exists transactions_person_date_idx
  on public.transactions(person_id, date desc);
create index if not exists transactions_workspace_idx
  on public.transactions(workspace_id);

create table if not exists public.monthly_budgets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  person_id uuid not null,
  currency text not null,
  month date not null check (extract(day from month) = 1),
  pv_limit numeric(18,2) not null default 0 check (pv_limit >= 0),
  updated_at timestamptz not null default now(),
  unique(person_id, currency, month),
  foreign key (person_id, workspace_id) references public.people(id, workspace_id) on delete cascade
);

create table if not exists public.goals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  person_id uuid not null,
  name text not null check (length(trim(name)) > 0),
  target_amount numeric(18,2) not null check (target_amount >= 0),
  reserved_amount numeric(18,2) not null default 0 check (reserved_amount >= 0),
  currency text not null,
  target_date date,
  status text not null default 'Active' check (status in ('Active', 'Completed', 'Paused', 'Cancelled')),
  created_at timestamptz not null default now(),
  foreign key (person_id, workspace_id) references public.people(id, workspace_id) on delete cascade
);

-- Data API privileges. Anonymous users receive no direct table access.
grant usage on schema public to authenticated, anon;
grant select, insert, update, delete on public.workspaces to authenticated;
grant select, insert, update, delete on public.people to authenticated;
grant select, insert, update, delete on public.transactions to authenticated;
grant select, insert, update, delete on public.monthly_budgets to authenticated;
grant select, insert, update, delete on public.goals to authenticated;
revoke all on public.workspaces, public.people, public.transactions, public.monthly_budgets, public.goals from anon;

-- Row-level security: each signed-in owner can access only their own workspace.
alter table public.workspaces enable row level security;
alter table public.people enable row level security;
alter table public.transactions enable row level security;
alter table public.monthly_budgets enable row level security;
alter table public.goals enable row level security;

create or replace function public.is_workspace_owner(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.workspaces w
    where w.id = p_workspace_id
      and w.owner_id = auth.uid()
  );
$$;

revoke all on function public.is_workspace_owner(uuid) from public;
grant execute on function public.is_workspace_owner(uuid) to authenticated;

-- Recreate policies safely.
drop policy if exists "Owner reads workspace" on public.workspaces;
drop policy if exists "Owner creates workspace" on public.workspaces;
drop policy if exists "Owner updates workspace" on public.workspaces;
drop policy if exists "Owner deletes workspace" on public.workspaces;
create policy "Owner reads workspace" on public.workspaces for select to authenticated using (owner_id = auth.uid());
create policy "Owner creates workspace" on public.workspaces for insert to authenticated with check (owner_id = auth.uid());
create policy "Owner updates workspace" on public.workspaces for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "Owner deletes workspace" on public.workspaces for delete to authenticated using (owner_id = auth.uid());


-- Policies on child tables.
drop policy if exists "Owner manages people" on public.people;
create policy "Owner manages people" on public.people for all to authenticated
  using (public.is_workspace_owner(workspace_id))
  with check (public.is_workspace_owner(workspace_id));

drop policy if exists "Owner manages transactions" on public.transactions;
create policy "Owner manages transactions" on public.transactions for all to authenticated
  using (public.is_workspace_owner(workspace_id))
  with check (public.is_workspace_owner(workspace_id));

drop policy if exists "Owner manages monthly budgets" on public.monthly_budgets;
create policy "Owner manages monthly budgets" on public.monthly_budgets for all to authenticated
  using (public.is_workspace_owner(workspace_id))
  with check (public.is_workspace_owner(workspace_id));

drop policy if exists "Owner manages goals" on public.goals;
create policy "Owner manages goals" on public.goals for all to authenticated
  using (public.is_workspace_owner(workspace_id))
  with check (public.is_workspace_owner(workspace_id));

-- A secure public function for the token-based, read-only dashboard.
-- Anonymous viewers never receive direct table access.
create or replace function public.get_person_public_view(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_person public.people%rowtype;
  v_workspace public.workspaces%rowtype;
begin
  select * into v_person from public.people where share_token = p_token;
  if not found then
    return null;
  end if;

  select * into v_workspace from public.workspaces where id = v_person.workspace_id;

  return jsonb_build_object(
    'workspace', jsonb_build_object(
      'name', v_workspace.name,
      'default_currency', v_workspace.default_currency,
      'upkeep_percentage', v_workspace.upkeep_percentage
    ),
    'person', to_jsonb(v_person),
    'transactions', coalesce((
      select jsonb_agg(to_jsonb(t) order by t.date desc, t.created_at desc)
      from public.transactions t
      where t.person_id = v_person.id
    ), '[]'::jsonb),
    'budgets', coalesce((
      select jsonb_agg(to_jsonb(b) order by b.month desc)
      from public.monthly_budgets b
      where b.person_id = v_person.id
    ), '[]'::jsonb),
    'goals', coalesce((
      select jsonb_agg(to_jsonb(g) order by g.created_at desc)
      from public.goals g
      where g.person_id = v_person.id
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_person_public_view(uuid) from public;
grant execute on function public.get_person_public_view(uuid) to anon, authenticated;

-- Enable Realtime for owner dashboards. Safe to rerun.
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'people') then
    alter publication supabase_realtime add table public.people;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'transactions') then
    alter publication supabase_realtime add table public.transactions;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'monthly_budgets') then
    alter publication supabase_realtime add table public.monthly_budgets;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'goals') then
    alter publication supabase_realtime add table public.goals;
  end if;
end $$;
