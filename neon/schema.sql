-- My Fund App on Neon
-- Database: my_fund_app
-- Auth: existing Supabase Auth temporarily; Neon Data API validates Supabase JWTs.
-- This lets the database move first without forcing existing users to reset passwords.

create extension if not exists pgcrypto;

create table if not exists public.mfa_workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null,
  name text not null default 'My Fund App',
  default_currency text not null default 'NGN',
  upkeep_percentage numeric(7,2) not null default 20
    check (upkeep_percentage >= 0 and upkeep_percentage <= 100),
  created_at timestamptz not null default now(),
  unique(owner_id)
);

create table if not exists public.mfa_app_users (
  user_id text primary key,
  email text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists public.mfa_people (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.mfa_workspaces(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  starting_balances jsonb not null default '{}'::jsonb,
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
  date date,
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

alter table public.mfa_workspaces enable row level security;
alter table public.mfa_app_users enable row level security;
alter table public.mfa_people enable row level security;
alter table public.mfa_transactions enable row level security;
alter table public.mfa_monthly_budgets enable row level security;
alter table public.mfa_goals enable row level security;

revoke all on public.mfa_workspaces, public.mfa_app_users, public.mfa_people,
  public.mfa_transactions, public.mfa_monthly_budgets, public.mfa_goals
  from anonymous, authenticated;

grant select, insert, update, delete on public.mfa_workspaces to authenticated;
grant select, insert, update, delete on public.mfa_people to authenticated;
grant select, insert, update, delete on public.mfa_transactions to authenticated;
grant select, insert, update, delete on public.mfa_monthly_budgets to authenticated;
grant select, insert, update, delete on public.mfa_goals to authenticated;

create or replace function public.mfa_is_workspace_owner(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.mfa_workspaces w
    where w.id = p_workspace_id
      and w.owner_id = (select auth.user_id())
  );
$$;

revoke all on function public.mfa_is_workspace_owner(uuid) from public;
grant execute on function public.mfa_is_workspace_owner(uuid) to authenticated;

create or replace function public.mfa_touch_app_user(p_email text default null)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_user_id text := (select auth.user_id());
  v_email text := lower(trim(coalesce((select auth.session() ->> 'email'), '')));
begin
  if coalesce(v_user_id, '') = '' then
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

create or replace function public.mfa_admin_overview()
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_email text := lower(trim(coalesce((select auth.session() ->> 'email'), '')));
begin
  if coalesce((select auth.user_id()), '') = '' then
    raise exception 'Authentication required';
  end if;
  if v_email <> 'oyekunleolalekan3168@gmail.com' then
    raise exception 'Platform admin access denied' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'users', coalesce((select jsonb_agg(to_jsonb(u) order by u.last_seen_at desc) from public.mfa_app_users u), '[]'::jsonb),
    'workspaces', coalesce((select jsonb_agg(to_jsonb(w) order by w.created_at desc) from public.mfa_workspaces w), '[]'::jsonb),
    'people', coalesce((select jsonb_agg(to_jsonb(p) order by p.created_at desc) from public.mfa_people p), '[]'::jsonb),
    'transactions', coalesce((select jsonb_agg(to_jsonb(t) order by t.date desc nulls last, t.created_at desc) from public.mfa_transactions t), '[]'::jsonb),
    'budgets', coalesce((select jsonb_agg(to_jsonb(b) order by b.month desc) from public.mfa_monthly_budgets b), '[]'::jsonb),
    'goals', coalesce((select jsonb_agg(to_jsonb(g) order by g.created_at desc) from public.mfa_goals g), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.mfa_admin_overview() from public;
grant execute on function public.mfa_admin_overview() to authenticated;

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
  select * into v_person from public.mfa_people where share_token = p_token;
  if not found then return null; end if;
  select * into v_workspace from public.mfa_workspaces where id = v_person.workspace_id;

  return jsonb_build_object(
    'workspace', jsonb_build_object(
      'name', v_workspace.name,
      'default_currency', v_workspace.default_currency,
      'upkeep_percentage', v_workspace.upkeep_percentage
    ),
    'person', to_jsonb(v_person),
    'transactions', coalesce((select jsonb_agg(to_jsonb(t) order by t.date desc nulls last, t.created_at desc) from public.mfa_transactions t where t.person_id = v_person.id), '[]'::jsonb),
    'budgets', coalesce((select jsonb_agg(to_jsonb(b) order by b.month desc) from public.mfa_monthly_budgets b where b.person_id = v_person.id), '[]'::jsonb),
    'goals', coalesce((select jsonb_agg(to_jsonb(g) order by g.created_at desc) from public.mfa_goals g where g.person_id = v_person.id), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.mfa_get_person_public_view(uuid) from public;
grant execute on function public.mfa_get_person_public_view(uuid) to anonymous, authenticated;

create or replace function public.mfa_import_own_snapshot(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $
declare
  v_user_id text := (select auth.user_id());
  v_email text := lower(trim(coalesce((select auth.session() ->> 'email'), '')));
  v_workspace_id uuid;
  v_existing_workspace_id uuid;
begin
  if coalesce(v_user_id, '') = '' then raise exception 'Authentication required'; end if;
  if v_email = '' then raise exception 'Account email is unavailable'; end if;

  if jsonb_array_length(coalesce(p_payload->'workspaces', '[]'::jsonb)) > 1 then
    raise exception 'Only one workspace can be imported for the signed-in account';
  end if;

  select x.id into v_workspace_id
  from jsonb_to_recordset(coalesce(p_payload->'workspaces', '[]'::jsonb))
    as x(id uuid, owner_id text)
  where x.owner_id = v_user_id
  limit 1;

  if v_workspace_id is null then
    return jsonb_build_object('imported', false, 'reason', 'no_source_workspace');
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(coalesce(p_payload->'workspaces', '[]'::jsonb))
      as x(id uuid, owner_id text)
    where x.owner_id <> v_user_id
  ) then
    raise exception 'Workspace owner does not match the signed-in account';
  end if;

  select id into v_existing_workspace_id
  from public.mfa_workspaces
  where owner_id = v_user_id
  limit 1;

  if v_existing_workspace_id is not null and v_existing_workspace_id <> v_workspace_id then
    raise exception 'A different Neon workspace already exists for this account';
  end if;

  insert into public.mfa_app_users (user_id, email, created_at, last_seen_at)
  values (v_user_id, v_email, now(), now())
  on conflict (user_id) do update
    set email = excluded.email,
        last_seen_at = now();

  insert into public.mfa_workspaces (id, owner_id, name, default_currency, upkeep_percentage, created_at)
  select x.id, x.owner_id, x.name, x.default_currency, x.upkeep_percentage, x.created_at
  from jsonb_to_recordset(coalesce(p_payload->'workspaces', '[]'::jsonb))
    as x(id uuid, owner_id text, name text, default_currency text, upkeep_percentage numeric, created_at timestamptz)
  where x.owner_id = v_user_id
  on conflict (id) do update set
    name = excluded.name,
    default_currency = excluded.default_currency,
    upkeep_percentage = excluded.upkeep_percentage;

  insert into public.mfa_people (id, workspace_id, name, starting_balances, share_token, created_at)
  select x.id, x.workspace_id, x.name, coalesce(x.starting_balances, '{}'::jsonb), x.share_token, x.created_at
  from jsonb_to_recordset(coalesce(p_payload->'people', '[]'::jsonb))
    as x(id uuid, workspace_id uuid, name text, starting_balances jsonb, share_token uuid, created_at timestamptz)
  where x.workspace_id = v_workspace_id
  on conflict (id) do update set
    name = excluded.name,
    starting_balances = excluded.starting_balances,
    share_token = excluded.share_token;

  insert into public.mfa_transactions (id, workspace_id, person_id, type, amount, currency, date, description, category, created_at)
  select x.id, x.workspace_id, x.person_id, x.type, x.amount, x.currency, x.date, x.description, x.category, x.created_at
  from jsonb_to_recordset(coalesce(p_payload->'transactions', '[]'::jsonb))
    as x(id uuid, workspace_id uuid, person_id uuid, type text, amount numeric, currency text, date date, description text, category text, created_at timestamptz)
  where x.workspace_id = v_workspace_id
  on conflict (id) do update set
    type = excluded.type,
    amount = excluded.amount,
    currency = excluded.currency,
    date = excluded.date,
    description = excluded.description,
    category = excluded.category;

  insert into public.mfa_monthly_budgets (id, workspace_id, person_id, currency, month, pv_limit, updated_at)
  select x.id, x.workspace_id, x.person_id, x.currency, x.month, x.pv_limit, x.updated_at
  from jsonb_to_recordset(coalesce(p_payload->'budgets', '[]'::jsonb))
    as x(id uuid, workspace_id uuid, person_id uuid, currency text, month date, pv_limit numeric, updated_at timestamptz)
  where x.workspace_id = v_workspace_id
  on conflict (id) do update set
    currency = excluded.currency,
    month = excluded.month,
    pv_limit = excluded.pv_limit,
    updated_at = excluded.updated_at;

  insert into public.mfa_goals (id, workspace_id, person_id, name, target_amount, reserved_amount, currency, target_date, status, created_at)
  select x.id, x.workspace_id, x.person_id, x.name, x.target_amount, x.reserved_amount, x.currency, x.target_date, x.status, x.created_at
  from jsonb_to_recordset(coalesce(p_payload->'goals', '[]'::jsonb))
    as x(id uuid, workspace_id uuid, person_id uuid, name text, target_amount numeric, reserved_amount numeric, currency text, target_date date, status text, created_at timestamptz)
  where x.workspace_id = v_workspace_id
  on conflict (id) do update set
    name = excluded.name,
    target_amount = excluded.target_amount,
    reserved_amount = excluded.reserved_amount,
    currency = excluded.currency,
    target_date = excluded.target_date,
    status = excluded.status;

  return jsonb_build_object(
    'imported', true,
    'workspace_id', v_workspace_id,
    'people', jsonb_array_length(coalesce(p_payload->'people', '[]'::jsonb)),
    'transactions', jsonb_array_length(coalesce(p_payload->'transactions', '[]'::jsonb))
  );
end;
$;

revoke all on function public.mfa_import_own_snapshot(jsonb) from public;
grant execute on function public.mfa_import_own_snapshot(jsonb) to authenticated;

create or replace function public.mfa_import_supabase_snapshot(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_email text := lower(trim(coalesce((select auth.session() ->> 'email'), '')));
  v_count_users integer := 0;
  v_count_workspaces integer := 0;
  v_count_people integer := 0;
  v_count_transactions integer := 0;
  v_count_budgets integer := 0;
  v_count_goals integer := 0;
begin
  if coalesce((select auth.user_id()), '') = '' then raise exception 'Authentication required'; end if;
  if v_email <> 'oyekunleolalekan3168@gmail.com' then
    raise exception 'Migration admin access denied' using errcode = '42501';
  end if;

  insert into public.mfa_app_users (user_id, email, created_at, last_seen_at)
  select x.user_id::text, x.email, x.created_at, x.last_seen_at
  from jsonb_to_recordset(coalesce(p_payload->'users', '[]'::jsonb))
    as x(user_id text, email text, created_at timestamptz, last_seen_at timestamptz)
  on conflict (user_id) do update set
    email = excluded.email,
    last_seen_at = greatest(public.mfa_app_users.last_seen_at, excluded.last_seen_at);
  get diagnostics v_count_users = row_count;

  insert into public.mfa_workspaces (id, owner_id, name, default_currency, upkeep_percentage, created_at)
  select x.id, x.owner_id::text, x.name, x.default_currency, x.upkeep_percentage, x.created_at
  from jsonb_to_recordset(coalesce(p_payload->'workspaces', '[]'::jsonb))
    as x(id uuid, owner_id text, name text, default_currency text, upkeep_percentage numeric, created_at timestamptz)
  on conflict (id) do update set
    owner_id = excluded.owner_id, name = excluded.name, default_currency = excluded.default_currency, upkeep_percentage = excluded.upkeep_percentage;
  get diagnostics v_count_workspaces = row_count;

  insert into public.mfa_people (id, workspace_id, name, starting_balances, share_token, created_at)
  select x.id, x.workspace_id, x.name, coalesce(x.starting_balances, '{}'::jsonb), x.share_token, x.created_at
  from jsonb_to_recordset(coalesce(p_payload->'people', '[]'::jsonb))
    as x(id uuid, workspace_id uuid, name text, starting_balances jsonb, share_token uuid, created_at timestamptz)
  on conflict (id) do update set
    workspace_id = excluded.workspace_id, name = excluded.name, starting_balances = excluded.starting_balances, share_token = excluded.share_token;
  get diagnostics v_count_people = row_count;

  insert into public.mfa_transactions (id, workspace_id, person_id, type, amount, currency, date, description, category, created_at)
  select x.id, x.workspace_id, x.person_id, x.type, x.amount, x.currency, x.date, x.description, x.category, x.created_at
  from jsonb_to_recordset(coalesce(p_payload->'transactions', '[]'::jsonb))
    as x(id uuid, workspace_id uuid, person_id uuid, type text, amount numeric, currency text, date date, description text, category text, created_at timestamptz)
  on conflict (id) do update set
    workspace_id = excluded.workspace_id, person_id = excluded.person_id, type = excluded.type, amount = excluded.amount,
    currency = excluded.currency, date = excluded.date, description = excluded.description, category = excluded.category;
  get diagnostics v_count_transactions = row_count;

  insert into public.mfa_monthly_budgets (id, workspace_id, person_id, currency, month, pv_limit, updated_at)
  select x.id, x.workspace_id, x.person_id, x.currency, x.month, x.pv_limit, x.updated_at
  from jsonb_to_recordset(coalesce(p_payload->'budgets', '[]'::jsonb))
    as x(id uuid, workspace_id uuid, person_id uuid, currency text, month date, pv_limit numeric, updated_at timestamptz)
  on conflict (id) do update set
    workspace_id = excluded.workspace_id, person_id = excluded.person_id, currency = excluded.currency,
    month = excluded.month, pv_limit = excluded.pv_limit, updated_at = excluded.updated_at;
  get diagnostics v_count_budgets = row_count;

  insert into public.mfa_goals (id, workspace_id, person_id, name, target_amount, reserved_amount, currency, target_date, status, created_at)
  select x.id, x.workspace_id, x.person_id, x.name, x.target_amount, x.reserved_amount, x.currency, x.target_date, x.status, x.created_at
  from jsonb_to_recordset(coalesce(p_payload->'goals', '[]'::jsonb))
    as x(id uuid, workspace_id uuid, person_id uuid, name text, target_amount numeric, reserved_amount numeric, currency text, target_date date, status text, created_at timestamptz)
  on conflict (id) do update set
    workspace_id = excluded.workspace_id, person_id = excluded.person_id, name = excluded.name, target_amount = excluded.target_amount,
    reserved_amount = excluded.reserved_amount, currency = excluded.currency, target_date = excluded.target_date, status = excluded.status;
  get diagnostics v_count_goals = row_count;

  return jsonb_build_object(
    'users', v_count_users,
    'workspaces', v_count_workspaces,
    'people', v_count_people,
    'transactions', v_count_transactions,
    'budgets', v_count_budgets,
    'goals', v_count_goals
  );
end;
$$;

revoke all on function public.mfa_import_supabase_snapshot(jsonb) from public;
grant execute on function public.mfa_import_supabase_snapshot(jsonb) to authenticated;

drop policy if exists "MFA owner reads workspace" on public.mfa_workspaces;
drop policy if exists "MFA owner creates workspace" on public.mfa_workspaces;
drop policy if exists "MFA owner updates workspace" on public.mfa_workspaces;
drop policy if exists "MFA owner deletes workspace" on public.mfa_workspaces;

create policy "MFA owner reads workspace"
  on public.mfa_workspaces for select to authenticated
  using ((select auth.user_id()) is not null and owner_id = (select auth.user_id()));
create policy "MFA owner creates workspace"
  on public.mfa_workspaces for insert to authenticated
  with check ((select auth.user_id()) is not null and owner_id = (select auth.user_id()));
create policy "MFA owner updates workspace"
  on public.mfa_workspaces for update to authenticated
  using ((select auth.user_id()) is not null and owner_id = (select auth.user_id()))
  with check ((select auth.user_id()) is not null and owner_id = (select auth.user_id()));
create policy "MFA owner deletes workspace"
  on public.mfa_workspaces for delete to authenticated
  using ((select auth.user_id()) is not null and owner_id = (select auth.user_id()));

drop policy if exists "MFA owner manages people" on public.mfa_people;
create policy "MFA owner manages people" on public.mfa_people for all to authenticated
  using (public.mfa_is_workspace_owner(workspace_id))
  with check (public.mfa_is_workspace_owner(workspace_id));

drop policy if exists "MFA owner manages transactions" on public.mfa_transactions;
create policy "MFA owner manages transactions" on public.mfa_transactions for all to authenticated
  using (public.mfa_is_workspace_owner(workspace_id))
  with check (public.mfa_is_workspace_owner(workspace_id));

drop policy if exists "MFA owner manages monthly budgets" on public.mfa_monthly_budgets;
create policy "MFA owner manages monthly budgets" on public.mfa_monthly_budgets for all to authenticated
  using (public.mfa_is_workspace_owner(workspace_id))
  with check (public.mfa_is_workspace_owner(workspace_id));

drop policy if exists "MFA owner manages goals" on public.mfa_goals;
create policy "MFA owner manages goals" on public.mfa_goals for all to authenticated
  using (public.mfa_is_workspace_owner(workspace_id))
  with check (public.mfa_is_workspace_owner(workspace_id));
