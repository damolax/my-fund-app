-- My Fund App database schema (safe to use beside Elevate Office Tracker)
-- All objects are prefixed with mfa_ so they do not overlap with another app.
-- Run this entire file once in the Supabase SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.mfa_workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'My Fund App',
  default_currency text not null default 'NGN',
  upkeep_percentage numeric(7,2) not null default 20
    check (upkeep_percentage >= 0 and upkeep_percentage <= 100),
  created_at timestamptz not null default now(),
  unique(owner_id)
);

-- Tracks only accounts that actually use My Fund App.
-- This does not list unrelated users from other apps sharing the Supabase project.
create table if not exists public.mfa_app_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists public.mfa_people (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.mfa_workspaces(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  share_token uuid not null default gen_random_uuid() unique,
  created_at timestamptz not null default now(),
  unique(id, workspace_id)
);

create table if not exists public.mfa_transactions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.mfa_workspaces(id) on delete cascade,
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
  foreign key (person_id, workspace_id)
    references public.mfa_people(id, workspace_id) on delete cascade
);

create index if not exists mfa_transactions_person_date_idx
  on public.mfa_transactions(person_id, date desc);
create index if not exists mfa_transactions_workspace_idx
  on public.mfa_transactions(workspace_id);

create table if not exists public.mfa_monthly_budgets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.mfa_workspaces(id) on delete cascade,
  person_id uuid not null,
  currency text not null,
  month date not null check (extract(day from month) = 1),
  pv_limit numeric(18,2) not null default 0 check (pv_limit >= 0),
  updated_at timestamptz not null default now(),
  unique(person_id, currency, month),
  foreign key (person_id, workspace_id)
    references public.mfa_people(id, workspace_id) on delete cascade
);

create table if not exists public.mfa_goals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.mfa_workspaces(id) on delete cascade,
  person_id uuid not null,
  name text not null check (length(trim(name)) > 0),
  target_amount numeric(18,2) not null check (target_amount >= 0),
  reserved_amount numeric(18,2) not null default 0 check (reserved_amount >= 0),
  currency text not null,
  target_date date,
  status text not null default 'Active'
    check (status in ('Active', 'Completed', 'Paused', 'Cancelled')),
  created_at timestamptz not null default now(),
  foreign key (person_id, workspace_id)
    references public.mfa_people(id, workspace_id) on delete cascade
);

-- Browser Data API privileges. Anonymous viewers have no direct table access.
grant usage on schema public to authenticated, anon;
grant select, insert, update, delete on public.mfa_workspaces to authenticated;
revoke all on public.mfa_app_users from anon, authenticated;
grant select, insert, update, delete on public.mfa_people to authenticated;
grant select, insert, update, delete on public.mfa_transactions to authenticated;
grant select, insert, update, delete on public.mfa_monthly_budgets to authenticated;
grant select, insert, update, delete on public.mfa_goals to authenticated;
revoke all on public.mfa_workspaces, public.mfa_people, public.mfa_transactions,
  public.mfa_monthly_budgets, public.mfa_goals from anon;

alter table public.mfa_workspaces enable row level security;
alter table public.mfa_app_users enable row level security;
alter table public.mfa_people enable row level security;
alter table public.mfa_transactions enable row level security;
alter table public.mfa_monthly_budgets enable row level security;
alter table public.mfa_goals enable row level security;

create or replace function public.mfa_is_workspace_owner(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.mfa_workspaces w
    where w.id = p_workspace_id
      and w.owner_id = (select auth.uid())
  );
$$;

revoke all on function public.mfa_is_workspace_owner(uuid) from public;
grant execute on function public.mfa_is_workspace_owner(uuid) to authenticated;

-- Records that the signed-in account has used My Fund App.
create or replace function public.mfa_touch_app_user(p_email text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_email text := lower(trim(coalesce((select auth.jwt() ->> 'email'), '')));
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  if v_email = '' then
    raise exception 'Account email is unavailable';
  end if;

  insert into public.mfa_app_users (user_id, email, created_at, last_seen_at)
  values (v_user_id, v_email, now(), now())
  on conflict (user_id) do update
    set email = excluded.email,
        last_seen_at = now();
end;
$$;

revoke all on function public.mfa_touch_app_user(text) from public;
grant execute on function public.mfa_touch_app_user(text) to authenticated;

-- Registers newly created My Fund App accounts immediately, even when email
-- confirmation is enabled. Other apps in the same Supabase project are ignored.
create or replace function public.mfa_handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(new.raw_user_meta_data ->> 'app_name', '') = 'my_fund_app' then
    insert into public.mfa_app_users (user_id, email, created_at, last_seen_at)
    values (new.id, lower(coalesce(new.email, '')), now(), now())
    on conflict (user_id) do update
      set email = excluded.email,
          last_seen_at = now();
  end if;
  return new;
end;
$$;

drop trigger if exists mfa_on_auth_user_created on auth.users;
create trigger mfa_on_auth_user_created
  after insert on auth.users
  for each row execute function public.mfa_handle_new_auth_user();

-- Platform-wide read-only payload. Access is restricted inside the database,
-- not merely hidden in the browser interface.
create or replace function public.mfa_admin_overview()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(trim(coalesce((select auth.jwt() ->> 'email'), '')));
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required';
  end if;

  if v_email <> 'oyekunleolalekan3168@gmail.com' then
    raise exception 'Platform admin access denied' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'users', coalesce((
      select jsonb_agg(to_jsonb(u) order by u.last_seen_at desc)
      from public.mfa_app_users u
    ), '[]'::jsonb),
    'workspaces', coalesce((
      select jsonb_agg(to_jsonb(w) order by w.created_at desc)
      from public.mfa_workspaces w
      where exists (select 1 from public.mfa_app_users u where u.user_id = w.owner_id)
    ), '[]'::jsonb),
    'people', coalesce((
      select jsonb_agg(to_jsonb(p) order by p.created_at desc)
      from public.mfa_people p
      join public.mfa_workspaces w on w.id = p.workspace_id
      where exists (select 1 from public.mfa_app_users u where u.user_id = w.owner_id)
    ), '[]'::jsonb),
    'transactions', coalesce((
      select jsonb_agg(to_jsonb(t) order by t.date desc, t.created_at desc)
      from public.mfa_transactions t
      join public.mfa_workspaces w on w.id = t.workspace_id
      where exists (select 1 from public.mfa_app_users u where u.user_id = w.owner_id)
    ), '[]'::jsonb),
    'budgets', coalesce((
      select jsonb_agg(to_jsonb(b) order by b.month desc)
      from public.mfa_monthly_budgets b
      join public.mfa_workspaces w on w.id = b.workspace_id
      where exists (select 1 from public.mfa_app_users u where u.user_id = w.owner_id)
    ), '[]'::jsonb),
    'goals', coalesce((
      select jsonb_agg(to_jsonb(g) order by g.created_at desc)
      from public.mfa_goals g
      join public.mfa_workspaces w on w.id = g.workspace_id
      where exists (select 1 from public.mfa_app_users u where u.user_id = w.owner_id)
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.mfa_admin_overview() from public;
grant execute on function public.mfa_admin_overview() to authenticated;

-- Workspace policies.
drop policy if exists "MFA owner reads workspace" on public.mfa_workspaces;
drop policy if exists "MFA owner creates workspace" on public.mfa_workspaces;
drop policy if exists "MFA owner updates workspace" on public.mfa_workspaces;
drop policy if exists "MFA owner deletes workspace" on public.mfa_workspaces;

create policy "MFA owner reads workspace"
  on public.mfa_workspaces for select to authenticated
  using ((select auth.uid()) is not null and owner_id = (select auth.uid()));

create policy "MFA owner creates workspace"
  on public.mfa_workspaces for insert to authenticated
  with check ((select auth.uid()) is not null and owner_id = (select auth.uid()));

create policy "MFA owner updates workspace"
  on public.mfa_workspaces for update to authenticated
  using ((select auth.uid()) is not null and owner_id = (select auth.uid()))
  with check ((select auth.uid()) is not null and owner_id = (select auth.uid()));

create policy "MFA owner deletes workspace"
  on public.mfa_workspaces for delete to authenticated
  using ((select auth.uid()) is not null and owner_id = (select auth.uid()));

-- Child-table policies.
drop policy if exists "MFA owner manages people" on public.mfa_people;
create policy "MFA owner manages people"
  on public.mfa_people for all to authenticated
  using (public.mfa_is_workspace_owner(workspace_id))
  with check (public.mfa_is_workspace_owner(workspace_id));

drop policy if exists "MFA owner manages transactions" on public.mfa_transactions;
create policy "MFA owner manages transactions"
  on public.mfa_transactions for all to authenticated
  using (public.mfa_is_workspace_owner(workspace_id))
  with check (public.mfa_is_workspace_owner(workspace_id));

drop policy if exists "MFA owner manages monthly budgets" on public.mfa_monthly_budgets;
create policy "MFA owner manages monthly budgets"
  on public.mfa_monthly_budgets for all to authenticated
  using (public.mfa_is_workspace_owner(workspace_id))
  with check (public.mfa_is_workspace_owner(workspace_id));

drop policy if exists "MFA owner manages goals" on public.mfa_goals;
create policy "MFA owner manages goals"
  on public.mfa_goals for all to authenticated
  using (public.mfa_is_workspace_owner(workspace_id))
  with check (public.mfa_is_workspace_owner(workspace_id));

-- Token-based read-only dashboard. Anonymous users cannot query tables directly.
create or replace function public.mfa_get_person_public_view(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_person public.mfa_people%rowtype;
  v_workspace public.mfa_workspaces%rowtype;
begin
  select * into v_person
  from public.mfa_people
  where share_token = p_token;

  if not found then
    return null;
  end if;

  select * into v_workspace
  from public.mfa_workspaces
  where id = v_person.workspace_id;

  return jsonb_build_object(
    'workspace', jsonb_build_object(
      'name', v_workspace.name,
      'default_currency', v_workspace.default_currency,
      'upkeep_percentage', v_workspace.upkeep_percentage
    ),
    'person', to_jsonb(v_person),
    'transactions', coalesce((
      select jsonb_agg(to_jsonb(t) order by t.date desc, t.created_at desc)
      from public.mfa_transactions t
      where t.person_id = v_person.id
    ), '[]'::jsonb),
    'budgets', coalesce((
      select jsonb_agg(to_jsonb(b) order by b.month desc)
      from public.mfa_monthly_budgets b
      where b.person_id = v_person.id
    ), '[]'::jsonb),
    'goals', coalesce((
      select jsonb_agg(to_jsonb(g) order by g.created_at desc)
      from public.mfa_goals g
      where g.person_id = v_person.id
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.mfa_get_person_public_view(uuid) from public;
grant execute on function public.mfa_get_person_public_view(uuid) to anon, authenticated;

-- Enable Realtime for My Fund App tables only. Safe to rerun.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'mfa_people'
  ) then
    alter publication supabase_realtime add table public.mfa_people;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'mfa_transactions'
  ) then
    alter publication supabase_realtime add table public.mfa_transactions;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'mfa_monthly_budgets'
  ) then
    alter publication supabase_realtime add table public.mfa_monthly_budgets;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'mfa_goals'
  ) then
    alter publication supabase_realtime add table public.mfa_goals;
  end if;
end $$;
