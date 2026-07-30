-- My Fund App: platform admin + account tracking + password-ready auth upgrade
-- Run once in the SAME Supabase project already used by My Fund App.
-- Safe beside Elevate Office Tracker: all objects are prefixed mfa_.

create table if not exists public.mfa_app_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

revoke all on public.mfa_app_users from anon, authenticated;
alter table public.mfa_app_users enable row level security;

create or replace function public.mfa_touch_app_user(p_email text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_email text := lower(trim(coalesce(p_email, (select auth.jwt() ->> 'email'), '')));
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
