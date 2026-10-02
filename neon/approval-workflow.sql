-- My Fund App approval workflow
-- Adds contributor access, pending record requests, approvals, notifications and email outbox.

create table if not exists public.mfa_workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.mfa_workspaces(id) on delete cascade,
  person_id uuid not null,
  user_id text not null,
  email text not null,
  role text not null default 'contributor' check (role in ('contributor')),
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_at timestamptz not null default now(),
  unique (workspace_id, user_id, person_id),
  foreign key (person_id, workspace_id)
    references public.mfa_people(id, workspace_id) on delete cascade
);

create index if not exists mfa_workspace_members_user_idx
  on public.mfa_workspace_members(user_id, status);
create index if not exists mfa_workspace_members_person_idx
  on public.mfa_workspace_members(person_id, status);

create table if not exists public.mfa_member_invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.mfa_workspaces(id) on delete cascade,
  person_id uuid not null,
  email text not null,
  token uuid not null default gen_random_uuid() unique,
  expires_at timestamptz not null default (now() + interval '14 days'),
  created_by text not null,
  created_at timestamptz not null default now(),
  accepted_by text,
  accepted_at timestamptz,
  revoked_at timestamptz,
  foreign key (person_id, workspace_id)
    references public.mfa_people(id, workspace_id) on delete cascade
);

create index if not exists mfa_member_invites_token_idx on public.mfa_member_invites(token);
create index if not exists mfa_member_invites_workspace_idx on public.mfa_member_invites(workspace_id, created_at desc);

create table if not exists public.mfa_record_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.mfa_workspaces(id) on delete cascade,
  person_id uuid not null,
  submitted_by_user_id text not null,
  submitted_by_email text not null,
  request_action text not null default 'create'
    check (request_action in ('create', 'update')),
  target_transaction_id uuid references public.mfa_transactions(id) on delete restrict,
  transaction_type text not null check (transaction_type in ('income', 'expense')),
  amount numeric(18,2) not null check (amount > 0),
  currency text not null,
  date date,
  description text not null check (length(trim(description)) > 0),
  category text check (
    (transaction_type = 'income' and category is null)
    or
    (transaction_type = 'expense' and category in ('PV', 'Upkeep', 'Investment', 'Other'))
  ),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  reviewer_user_id text,
  reviewer_note text,
  reviewed_at timestamptz,
  recorded_transaction_id uuid references public.mfa_transactions(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (person_id, workspace_id)
    references public.mfa_people(id, workspace_id) on delete cascade,
  check (
    (request_action = 'create' and target_transaction_id is null)
    or
    (request_action = 'update' and target_transaction_id is not null)
  )
);

create index if not exists mfa_record_requests_workspace_status_idx
  on public.mfa_record_requests(workspace_id, status, created_at desc);
create index if not exists mfa_record_requests_submitter_idx
  on public.mfa_record_requests(submitted_by_user_id, created_at desc);
create index if not exists mfa_record_requests_person_idx
  on public.mfa_record_requests(person_id, created_at desc);

create table if not exists public.mfa_notifications (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.mfa_workspaces(id) on delete cascade,
  recipient_user_id text not null,
  kind text not null check (kind in ('record_request', 'request_approved', 'request_rejected')),
  title text not null,
  body text not null,
  request_id uuid references public.mfa_record_requests(id) on delete cascade,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists mfa_notifications_recipient_idx
  on public.mfa_notifications(recipient_user_id, is_read, created_at desc);

create table if not exists public.mfa_email_outbox (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.mfa_workspaces(id) on delete cascade,
  request_id uuid references public.mfa_record_requests(id) on delete cascade,
  recipient_email text not null,
  subject text not null,
  html_body text not null,
  deep_link text not null,
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'sent', 'failed')),
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index if not exists mfa_email_outbox_status_idx
  on public.mfa_email_outbox(status, created_at);

alter table public.mfa_email_outbox
  add column if not exists last_attempt_at timestamptz;

alter table public.mfa_workspace_members enable row level security;
alter table public.mfa_member_invites enable row level security;
alter table public.mfa_record_requests enable row level security;
alter table public.mfa_notifications enable row level security;
alter table public.mfa_email_outbox enable row level security;

revoke all on public.mfa_workspace_members,
  public.mfa_member_invites,
  public.mfa_record_requests,
  public.mfa_notifications,
  public.mfa_email_outbox
from anonymous, authenticated;

create or replace function public.mfa_current_email()
returns text
language sql
stable
security definer
set search_path = auth
as $mfa$
  select lower(trim(coalesce(auth.session() ->> 'email', '')));
$mfa$;

revoke all on function public.mfa_current_email() from public;
grant execute on function public.mfa_current_email() to authenticated;

create or replace function public.mfa_get_access_context()
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $mfa$
declare
  v_uid text := (select auth.user_id());
  v_workspace public.mfa_workspaces%rowtype;
  v_member public.mfa_workspace_members%rowtype;
  v_person public.mfa_people%rowtype;
begin
  if coalesce(v_uid, '') = '' then
    raise exception 'Authentication required';
  end if;

  select * into v_workspace
  from public.mfa_workspaces
  where owner_id = v_uid
  limit 1;

  if found then
    return jsonb_build_object(
      'role', 'owner',
      'workspace', to_jsonb(v_workspace)
    );
  end if;

  select * into v_member
  from public.mfa_workspace_members
  where user_id = v_uid and status = 'active'
  order by created_at
  limit 1;

  if not found then
    return null;
  end if;

  select * into v_workspace from public.mfa_workspaces where id = v_member.workspace_id;
  select * into v_person from public.mfa_people where id = v_member.person_id;

  return jsonb_build_object(
    'role', 'contributor',
    'workspace', jsonb_build_object(
      'id', v_workspace.id,
      'name', v_workspace.name,
      'default_currency', v_workspace.default_currency,
      'upkeep_percentage', v_workspace.upkeep_percentage
    ),
    'member', to_jsonb(v_member),
    'person', to_jsonb(v_person)
  );
end;
$mfa$;

revoke all on function public.mfa_get_access_context() from public;
grant execute on function public.mfa_get_access_context() to authenticated;

create or replace function public.mfa_create_member_invite(
  p_person_id uuid,
  p_email text
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $mfa$
declare
  v_uid text := (select auth.user_id());
  v_email text := lower(trim(coalesce(p_email, '')));
  v_person public.mfa_people%rowtype;
  v_invite public.mfa_member_invites%rowtype;
begin
  if coalesce(v_uid, '') = '' then raise exception 'Authentication required'; end if;
  if v_email = '' or position('@' in v_email) <= 1 then raise exception 'Enter a valid email address'; end if;

  select p.* into v_person
  from public.mfa_people p
  join public.mfa_workspaces w on w.id = p.workspace_id
  where p.id = p_person_id and w.owner_id = v_uid;

  if not found then raise exception 'Person not found or access denied'; end if;

  update public.mfa_member_invites
  set revoked_at = now()
  where workspace_id = v_person.workspace_id
    and person_id = v_person.id
    and lower(email) = v_email
    and accepted_at is null
    and revoked_at is null;

  insert into public.mfa_member_invites (
    workspace_id, person_id, email, created_by
  )
  values (
    v_person.workspace_id, v_person.id, v_email, v_uid
  )
  returning * into v_invite;

  return jsonb_build_object(
    'id', v_invite.id,
    'token', v_invite.token,
    'email', v_invite.email,
    'expires_at', v_invite.expires_at,
    'person_id', v_invite.person_id
  );
end;
$mfa$;

revoke all on function public.mfa_create_member_invite(uuid, text) from public;
grant execute on function public.mfa_create_member_invite(uuid, text) to authenticated;

create or replace function public.mfa_revoke_member_invite(p_invite_id uuid)
returns void
language plpgsql
security definer
set search_path = public, auth
as $mfa$
declare
  v_uid text := (select auth.user_id());
begin
  update public.mfa_member_invites i
  set revoked_at = now()
  from public.mfa_workspaces w
  where i.id = p_invite_id
    and w.id = i.workspace_id
    and w.owner_id = v_uid
    and i.accepted_at is null;

  if not found then raise exception 'Invite not found or access denied'; end if;
end;
$mfa$;

revoke all on function public.mfa_revoke_member_invite(uuid) from public;
grant execute on function public.mfa_revoke_member_invite(uuid) to authenticated;

create or replace function public.mfa_accept_member_invite(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $mfa$
declare
  v_uid text := (select auth.user_id());
  v_email text := public.mfa_current_email();
  v_invite public.mfa_member_invites%rowtype;
  v_member public.mfa_workspace_members%rowtype;
begin
  if coalesce(v_uid, '') = '' then raise exception 'Authentication required'; end if;
  if v_email = '' then raise exception 'Your account email is unavailable'; end if;

  select * into v_invite
  from public.mfa_member_invites
  where token = p_token
  for update;

  if not found then raise exception 'This invite is invalid'; end if;
  if v_invite.revoked_at is not null then raise exception 'This invite has been revoked'; end if;
  if v_invite.accepted_at is not null and v_invite.accepted_by <> v_uid then
    raise exception 'This invite has already been used';
  end if;
  if v_invite.expires_at < now() then raise exception 'This invite has expired'; end if;
  if lower(v_invite.email) <> v_email then
    raise exception 'Sign in using the email address this invite was sent to';
  end if;

  insert into public.mfa_workspace_members (
    workspace_id, person_id, user_id, email, status
  )
  values (
    v_invite.workspace_id, v_invite.person_id, v_uid, v_email, 'active'
  )
  on conflict (workspace_id, user_id, person_id) do update
    set email = excluded.email,
        status = 'active'
  returning * into v_member;

  update public.mfa_member_invites
  set accepted_by = v_uid,
      accepted_at = coalesce(accepted_at, now())
  where id = v_invite.id;

  insert into public.mfa_app_users (user_id, email, created_at, last_seen_at)
  values (v_uid, v_email, now(), now())
  on conflict (user_id) do update
    set email = excluded.email,
        last_seen_at = now();

  return jsonb_build_object(
    'member', to_jsonb(v_member),
    'workspace_id', v_member.workspace_id,
    'person_id', v_member.person_id
  );
end;
$mfa$;

revoke all on function public.mfa_accept_member_invite(uuid) from public;
grant execute on function public.mfa_accept_member_invite(uuid) to authenticated;

create or replace function public.mfa_get_contributor_dashboard()
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $mfa$
declare
  v_uid text := (select auth.user_id());
  v_member public.mfa_workspace_members%rowtype;
  v_workspace public.mfa_workspaces%rowtype;
  v_person public.mfa_people%rowtype;
begin
  if coalesce(v_uid, '') = '' then raise exception 'Authentication required'; end if;

  select * into v_member
  from public.mfa_workspace_members
  where user_id = v_uid and status = 'active'
  order by created_at
  limit 1;

  if not found then raise exception 'Contributor access has not been granted'; end if;

  select * into v_workspace from public.mfa_workspaces where id = v_member.workspace_id;
  select * into v_person from public.mfa_people where id = v_member.person_id;

  return jsonb_build_object(
    'workspace', jsonb_build_object(
      'id', v_workspace.id,
      'name', v_workspace.name,
      'default_currency', v_workspace.default_currency,
      'upkeep_percentage', v_workspace.upkeep_percentage
    ),
    'member', to_jsonb(v_member),
    'person', to_jsonb(v_person),
    'transactions', coalesce((
      select jsonb_agg(to_jsonb(t) order by t.date desc nulls last, t.created_at desc)
      from public.mfa_transactions t
      where t.person_id = v_member.person_id
    ), '[]'::jsonb),
    'budgets', coalesce((
      select jsonb_agg(to_jsonb(b) order by b.month desc)
      from public.mfa_monthly_budgets b
      where b.person_id = v_member.person_id
    ), '[]'::jsonb),
    'goals', coalesce((
      select jsonb_agg(to_jsonb(g) order by g.created_at desc)
      from public.mfa_goals g
      where g.person_id = v_member.person_id
    ), '[]'::jsonb),
    'requests', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.created_at desc)
      from public.mfa_record_requests r
      where r.submitted_by_user_id = v_uid
    ), '[]'::jsonb),
    'notifications', coalesce((
      select jsonb_agg(to_jsonb(n) order by n.created_at desc)
      from public.mfa_notifications n
      where n.recipient_user_id = v_uid
      limit 100
    ), '[]'::jsonb)
  );
end;
$mfa$;

revoke all on function public.mfa_get_contributor_dashboard() from public;
grant execute on function public.mfa_get_contributor_dashboard() to authenticated;

create or replace function public.mfa_get_approval_center()
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $mfa$
declare
  v_uid text := (select auth.user_id());
  v_workspace public.mfa_workspaces%rowtype;
begin
  if coalesce(v_uid, '') = '' then raise exception 'Authentication required'; end if;

  select * into v_workspace
  from public.mfa_workspaces
  where owner_id = v_uid
  limit 1;

  if not found then raise exception 'Owner access required'; end if;

  return jsonb_build_object(
    'requests', coalesce((
      select jsonb_agg(
        to_jsonb(r) ||
        jsonb_build_object('person_name', p.name)
        order by
          case when r.status = 'pending' then 0 else 1 end,
          r.created_at desc
      )
      from public.mfa_record_requests r
      join public.mfa_people p on p.id = r.person_id
      where r.workspace_id = v_workspace.id
    ), '[]'::jsonb),
    'notifications', coalesce((
      select jsonb_agg(to_jsonb(n) order by n.created_at desc)
      from public.mfa_notifications n
      where n.recipient_user_id = v_uid
    ), '[]'::jsonb),
    'members', coalesce((
      select jsonb_agg(
        to_jsonb(m) || jsonb_build_object('person_name', p.name)
        order by m.created_at desc
      )
      from public.mfa_workspace_members m
      join public.mfa_people p on p.id = m.person_id
      where m.workspace_id = v_workspace.id
    ), '[]'::jsonb),
    'invites', coalesce((
      select jsonb_agg(
        to_jsonb(i) || jsonb_build_object('person_name', p.name)
        order by i.created_at desc
      )
      from public.mfa_member_invites i
      join public.mfa_people p on p.id = i.person_id
      where i.workspace_id = v_workspace.id
    ), '[]'::jsonb)
  );
end;
$mfa$;

revoke all on function public.mfa_get_approval_center() from public;
grant execute on function public.mfa_get_approval_center() to authenticated;

create or replace function public.mfa_submit_record_request(
  p_person_id uuid,
  p_request_action text,
  p_target_transaction_id uuid,
  p_transaction_type text,
  p_amount numeric,
  p_currency text,
  p_date date,
  p_description text,
  p_category text
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $mfa$
declare
  v_uid text := (select auth.user_id());
  v_email text := public.mfa_current_email();
  v_member public.mfa_workspace_members%rowtype;
  v_workspace public.mfa_workspaces%rowtype;
  v_person public.mfa_people%rowtype;
  v_request public.mfa_record_requests%rowtype;
  v_owner_email text;
  v_link text;
begin
  if coalesce(v_uid, '') = '' then raise exception 'Authentication required'; end if;
  if p_request_action not in ('create', 'update') then raise exception 'Invalid request action'; end if;
  if p_transaction_type not in ('income', 'expense') then raise exception 'Invalid transaction type'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Amount must be greater than zero'; end if;
  if length(trim(coalesce(p_currency, ''))) <> 3 then raise exception 'Use a three-letter currency code'; end if;
  if length(trim(coalesce(p_description, ''))) = 0 then raise exception 'Description is required'; end if;
  if p_transaction_type = 'income' then p_category := null; end if;
  if p_transaction_type = 'expense' and p_category not in ('PV', 'Upkeep', 'Investment', 'Other') then
    raise exception 'Choose a valid expense category';
  end if;

  select * into v_member
  from public.mfa_workspace_members
  where user_id = v_uid
    and person_id = p_person_id
    and status = 'active'
  limit 1;

  if not found then raise exception 'Contributor access denied for this person'; end if;

  select * into v_workspace from public.mfa_workspaces where id = v_member.workspace_id;
  select * into v_person from public.mfa_people where id = v_member.person_id;

  if p_request_action = 'create' then
    p_target_transaction_id := null;
  else
    if p_target_transaction_id is null then raise exception 'Select the record to update'; end if;
    if not exists (
      select 1 from public.mfa_transactions t
      where t.id = p_target_transaction_id
        and t.workspace_id = v_member.workspace_id
        and t.person_id = v_member.person_id
    ) then
      raise exception 'The selected record does not belong to your account';
    end if;
  end if;

  insert into public.mfa_record_requests (
    workspace_id, person_id, submitted_by_user_id, submitted_by_email,
    request_action, target_transaction_id, transaction_type, amount, currency,
    date, description, category
  )
  values (
    v_member.workspace_id, v_member.person_id, v_uid, v_email,
    p_request_action, p_target_transaction_id, p_transaction_type, round(p_amount, 2),
    upper(trim(p_currency)), p_date, trim(p_description), p_category
  )
  returning * into v_request;

  insert into public.mfa_notifications (
    workspace_id, recipient_user_id, kind, title, body, request_id
  )
  values (
    v_member.workspace_id,
    v_workspace.owner_id,
    'record_request',
    case when p_request_action = 'update' then 'Record update needs approval' else 'New record needs approval' end,
    coalesce(v_email, 'A contributor') || ' submitted ' ||
      upper(trim(p_currency)) || ' ' || round(p_amount, 2)::text ||
      ' for ' || v_person.name || '.',
    v_request.id
  );

  select email into v_owner_email
  from public.mfa_app_users
  where user_id = v_workspace.owner_id
  limit 1;

  v_link := 'https://my-fund-app-one.vercel.app/#/approvals?request=' || v_request.id::text;

  if coalesce(v_owner_email, '') <> '' then
    insert into public.mfa_email_outbox (
      workspace_id, request_id, recipient_email, subject, html_body, deep_link
    )
    values (
      v_member.workspace_id,
      v_request.id,
      v_owner_email,
      case when p_request_action = 'update'
        then 'My Fund App: record update needs your approval'
        else 'My Fund App: new record needs your approval'
      end,
      '<p><strong>' || replace(v_person.name, '<', '&lt;') || '</strong> has a pending ' ||
      p_transaction_type || ' request for <strong>' || upper(trim(p_currency)) || ' ' ||
      round(p_amount, 2)::text || '</strong>.</p><p>Submitted by ' ||
      replace(v_email, '<', '&lt;') || '.</p><p><a href="' || v_link ||
      '">Review this request in My Fund App</a></p>',
      v_link
    );
  end if;

  return to_jsonb(v_request);
end;
$mfa$;

revoke all on function public.mfa_submit_record_request(uuid, text, uuid, text, numeric, text, date, text, text) from public;
grant execute on function public.mfa_submit_record_request(uuid, text, uuid, text, numeric, text, date, text, text) to authenticated;

create or replace function public.mfa_update_record_request(
  p_request_id uuid,
  p_transaction_type text,
  p_amount numeric,
  p_currency text,
  p_date date,
  p_description text,
  p_category text
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $mfa$
declare
  v_uid text := (select auth.user_id());
  v_request public.mfa_record_requests%rowtype;
begin
  select * into v_request
  from public.mfa_record_requests
  where id = p_request_id
  for update;

  if not found then raise exception 'Request not found'; end if;
  if v_request.submitted_by_user_id <> v_uid then raise exception 'Access denied'; end if;
  if v_request.status <> 'pending' then raise exception 'Only pending requests can be edited'; end if;
  if p_transaction_type not in ('income', 'expense') then raise exception 'Invalid transaction type'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Amount must be greater than zero'; end if;
  if length(trim(coalesce(p_currency, ''))) <> 3 then raise exception 'Use a three-letter currency code'; end if;
  if length(trim(coalesce(p_description, ''))) = 0 then raise exception 'Description is required'; end if;
  if p_transaction_type = 'income' then p_category := null; end if;
  if p_transaction_type = 'expense' and p_category not in ('PV', 'Upkeep', 'Investment', 'Other') then
    raise exception 'Choose a valid expense category';
  end if;

  update public.mfa_record_requests
  set transaction_type = p_transaction_type,
      amount = round(p_amount, 2),
      currency = upper(trim(p_currency)),
      date = p_date,
      description = trim(p_description),
      category = p_category,
      updated_at = now()
  where id = p_request_id
  returning * into v_request;

  update public.mfa_notifications
  set body = public.mfa_current_email() || ' updated a pending request: ' ||
      v_request.currency || ' ' || v_request.amount::text || '.'
  where request_id = v_request.id
    and kind = 'record_request';

  update public.mfa_email_outbox
  set subject = 'My Fund App: pending record request updated',
      html_body = '<p>A pending request was updated to <strong>' ||
        v_request.currency || ' ' || v_request.amount::text ||
        '</strong>.</p><p><a href="' || deep_link || '">Review this request in My Fund App</a></p>',
      status = case when status = 'sent' then 'pending' else status end,
      sent_at = case when status = 'sent' then null else sent_at end
  where request_id = v_request.id;

  return to_jsonb(v_request);
end;
$mfa$;

revoke all on function public.mfa_update_record_request(uuid, text, numeric, text, date, text, text) from public;
grant execute on function public.mfa_update_record_request(uuid, text, numeric, text, date, text, text) to authenticated;

create or replace function public.mfa_delete_record_request(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = public, auth
as $mfa$
declare
  v_uid text := (select auth.user_id());
begin
  delete from public.mfa_record_requests
  where id = p_request_id
    and submitted_by_user_id = v_uid
    and status = 'pending';

  if not found then
    raise exception 'Only your pending requests can be deleted';
  end if;
end;
$mfa$;

revoke all on function public.mfa_delete_record_request(uuid) from public;
grant execute on function public.mfa_delete_record_request(uuid) to authenticated;

create or replace function public.mfa_validate_month_limits(
  p_workspace_id uuid,
  p_person_id uuid,
  p_currency text,
  p_month date
)
returns void
language plpgsql
security definer
set search_path = public
as $mfa$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_pv_limit numeric(18,2) := 0;
  v_pv_spent numeric(18,2) := 0;
  v_upkeep_percentage numeric(7,2) := 0;
  v_month_income numeric(18,2) := 0;
  v_upkeep_spent numeric(18,2) := 0;
  v_upkeep_limit numeric(18,2) := 0;
begin
  if p_month is null then return; end if;

  select coalesce(b.pv_limit, 0)
  into v_pv_limit
  from public.mfa_monthly_budgets b
  where b.workspace_id = p_workspace_id
    and b.person_id = p_person_id
    and b.currency = upper(trim(p_currency))
    and b.month = v_month;

  v_pv_limit := coalesce(v_pv_limit, 0);

  select coalesce(sum(t.amount), 0)
  into v_pv_spent
  from public.mfa_transactions t
  where t.workspace_id = p_workspace_id
    and t.person_id = p_person_id
    and t.currency = upper(trim(p_currency))
    and t.type = 'expense'
    and t.category = 'PV'
    and t.date >= v_month
    and t.date < (v_month + interval '1 month')::date;

  if v_pv_spent > v_pv_limit + 0.00001 then
    raise exception 'Approval would exceed the PV monthly limit by % %',
      upper(trim(p_currency)),
      round(v_pv_spent - v_pv_limit, 2);
  end if;

  select coalesce(w.upkeep_percentage, 0)
  into v_upkeep_percentage
  from public.mfa_workspaces w
  where w.id = p_workspace_id;

  select coalesce(sum(t.amount), 0)
  into v_month_income
  from public.mfa_transactions t
  where t.workspace_id = p_workspace_id
    and t.person_id = p_person_id
    and t.currency = upper(trim(p_currency))
    and t.type = 'income'
    and t.date >= v_month
    and t.date < (v_month + interval '1 month')::date;

  select coalesce(sum(t.amount), 0)
  into v_upkeep_spent
  from public.mfa_transactions t
  where t.workspace_id = p_workspace_id
    and t.person_id = p_person_id
    and t.currency = upper(trim(p_currency))
    and t.type = 'expense'
    and t.category = 'Upkeep'
    and t.date >= v_month
    and t.date < (v_month + interval '1 month')::date;

  v_upkeep_limit := round(v_month_income * (v_upkeep_percentage / 100), 2);

  if v_upkeep_spent > v_upkeep_limit + 0.00001 then
    raise exception 'Approval would exceed the Upkeep monthly limit by % %',
      upper(trim(p_currency)),
      round(v_upkeep_spent - v_upkeep_limit, 2);
  end if;
end;
$mfa$;

revoke all on function public.mfa_validate_month_limits(uuid, uuid, text, date) from public;
grant execute on function public.mfa_validate_month_limits(uuid, uuid, text, date) to authenticated;

create or replace function public.mfa_review_record_request(
  p_request_id uuid,
  p_decision text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $mfa$
declare
  v_uid text := (select auth.user_id());
  v_request public.mfa_record_requests%rowtype;
  v_original public.mfa_transactions%rowtype;
  v_record_id uuid;
begin
  if p_decision not in ('approve', 'reject') then
    raise exception 'Decision must be approve or reject';
  end if;

  select r.* into v_request
  from public.mfa_record_requests r
  join public.mfa_workspaces w on w.id = r.workspace_id
  where r.id = p_request_id
    and w.owner_id = v_uid
  for update of r;

  if not found then raise exception 'Request not found or access denied'; end if;
  if v_request.status <> 'pending' then raise exception 'This request has already been reviewed'; end if;

  if p_decision = 'approve' then
    if v_request.request_action = 'update' then
      select * into v_original
      from public.mfa_transactions
      where id = v_request.target_transaction_id
        and workspace_id = v_request.workspace_id
        and person_id = v_request.person_id
      for update;

      if not found then
        raise exception 'The original record could not be found';
      end if;
    end if;

    if v_request.request_action = 'create' then
      insert into public.mfa_transactions (
        workspace_id, person_id, type, amount, currency, date, description, category
      )
      values (
        v_request.workspace_id, v_request.person_id, v_request.transaction_type,
        v_request.amount, v_request.currency, v_request.date,
        v_request.description, v_request.category
      )
      returning id into v_record_id;
    else
      update public.mfa_transactions
      set type = v_request.transaction_type,
          amount = v_request.amount,
          currency = v_request.currency,
          date = v_request.date,
          description = v_request.description,
          category = v_request.category
      where id = v_request.target_transaction_id
        and workspace_id = v_request.workspace_id
        and person_id = v_request.person_id
      returning id into v_record_id;

      if v_record_id is null then
        raise exception 'The original record could not be found';
      end if;
    end if;

    if v_request.date is not null then
      perform public.mfa_validate_month_limits(
        v_request.workspace_id,
        v_request.person_id,
        v_request.currency,
        v_request.date
      );
    end if;

    if v_request.request_action = 'update'
      and v_original.date is not null
      and (
        v_original.currency <> v_request.currency
        or date_trunc('month', v_original.date)::date <> date_trunc('month', v_request.date)::date
        or v_request.date is null
      )
    then
      perform public.mfa_validate_month_limits(
        v_original.workspace_id,
        v_original.person_id,
        v_original.currency,
        v_original.date
      );
    end if;

    update public.mfa_record_requests
    set status = 'approved',
        reviewer_user_id = v_uid,
        reviewer_note = nullif(trim(coalesce(p_note, '')), ''),
        reviewed_at = now(),
        recorded_transaction_id = v_record_id,
        updated_at = now()
    where id = v_request.id;
  else
    update public.mfa_record_requests
    set status = 'rejected',
        reviewer_user_id = v_uid,
        reviewer_note = nullif(trim(coalesce(p_note, '')), ''),
        reviewed_at = now(),
        updated_at = now()
    where id = v_request.id;
  end if;

  update public.mfa_notifications
  set is_read = true
  where request_id = v_request.id
    and recipient_user_id = v_uid
    and kind = 'record_request';

  insert into public.mfa_notifications (
    workspace_id, recipient_user_id, kind, title, body, request_id
  )
  values (
    v_request.workspace_id,
    v_request.submitted_by_user_id,
    case when p_decision = 'approve' then 'request_approved' else 'request_rejected' end,
    case when p_decision = 'approve' then 'Your record was approved' else 'Your record was rejected' end,
    case when p_decision = 'approve'
      then 'Your ' || v_request.currency || ' ' || v_request.amount::text || ' request is now recorded.'
      else 'Your ' || v_request.currency || ' ' || v_request.amount::text || ' request was not recorded.'
    end ||
    case when nullif(trim(coalesce(p_note, '')), '') is not null
      then ' Manager note: ' || trim(p_note)
      else ''
    end,
    v_request.id
  );

  return (
    select to_jsonb(r)
    from public.mfa_record_requests r
    where r.id = v_request.id
  );
end;
$mfa$;

revoke all on function public.mfa_review_record_request(uuid, text, text) from public;
grant execute on function public.mfa_review_record_request(uuid, text, text) to authenticated;

create or replace function public.mfa_mark_notification_read(p_notification_id uuid)
returns void
language plpgsql
security definer
set search_path = public, auth
as $mfa$
declare
  v_uid text := (select auth.user_id());
begin
  update public.mfa_notifications
  set is_read = true
  where id = p_notification_id
    and recipient_user_id = v_uid;

  if not found then raise exception 'Notification not found'; end if;
end;
$mfa$;

revoke all on function public.mfa_mark_notification_read(uuid) from public;
grant execute on function public.mfa_mark_notification_read(uuid) to authenticated;

create or replace function public.mfa_claim_request_email(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $mfa$
declare
  v_uid text := (select auth.user_id());
  v_request public.mfa_record_requests%rowtype;
  v_owner_id text;
  v_outbox public.mfa_email_outbox%rowtype;
begin
  if coalesce(v_uid, '') = '' then raise exception 'Authentication required'; end if;

  select r.*, w.owner_id
  into v_request, v_owner_id
  from public.mfa_record_requests r
  join public.mfa_workspaces w on w.id = r.workspace_id
  where r.id = p_request_id;

  if not found then return jsonb_build_object('status', 'none'); end if;

  if v_uid <> v_request.submitted_by_user_id and v_uid <> v_owner_id then
    raise exception 'Access denied';
  end if;

  select * into v_outbox
  from public.mfa_email_outbox
  where request_id = p_request_id
  order by created_at desc
  limit 1
  for update;

  if not found then return jsonb_build_object('status', 'none'); end if;
  if v_outbox.status = 'sent' then
    return jsonb_build_object('status', 'sent');
  end if;
  if v_outbox.status = 'sending'
    and v_outbox.last_attempt_at is not null
    and v_outbox.last_attempt_at > now() - interval '10 minutes'
  then
    return jsonb_build_object('status', 'busy');
  end if;
  if v_outbox.attempts >= 5 then
    return jsonb_build_object('status', 'failed', 'reason', 'attempt_limit');
  end if;

  update public.mfa_email_outbox
  set status = 'sending',
      attempts = attempts + 1,
      last_attempt_at = now(),
      last_error = null
  where id = v_outbox.id
  returning * into v_outbox;

  return jsonb_build_object(
    'status', 'ready',
    'outbox_id', v_outbox.id,
    'recipient_email', v_outbox.recipient_email,
    'subject', v_outbox.subject,
    'html_body', v_outbox.html_body,
    'deep_link', v_outbox.deep_link
  );
end;
$mfa$;

revoke all on function public.mfa_claim_request_email(uuid) from public;
grant execute on function public.mfa_claim_request_email(uuid) to authenticated;

create or replace function public.mfa_complete_request_email(
  p_outbox_id uuid,
  p_success boolean,
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = public, auth
as $mfa$
declare
  v_uid text := (select auth.user_id());
  v_outbox public.mfa_email_outbox%rowtype;
  v_submitter text;
  v_owner text;
begin
  if coalesce(v_uid, '') = '' then raise exception 'Authentication required'; end if;

  select o.*, r.submitted_by_user_id, w.owner_id
  into v_outbox, v_submitter, v_owner
  from public.mfa_email_outbox o
  join public.mfa_record_requests r on r.id = o.request_id
  join public.mfa_workspaces w on w.id = o.workspace_id
  where o.id = p_outbox_id
  for update of o;

  if not found then raise exception 'Email outbox item not found'; end if;
  if v_uid <> v_submitter and v_uid <> v_owner then raise exception 'Access denied'; end if;

  update public.mfa_email_outbox
  set status = case when p_success then 'sent' else 'failed' end,
      sent_at = case when p_success then now() else null end,
      last_error = case when p_success then null else left(coalesce(p_error, 'Delivery failed'), 1000) end
  where id = p_outbox_id;
end;
$mfa$;

revoke all on function public.mfa_complete_request_email(uuid, boolean, text) from public;
grant execute on function public.mfa_complete_request_email(uuid, boolean, text) to authenticated;

create or replace function public.mfa_set_member_status(
  p_member_id uuid,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = public, auth
as $mfa$
declare
  v_uid text := (select auth.user_id());
begin
  if p_status not in ('active', 'disabled') then raise exception 'Invalid status'; end if;

  update public.mfa_workspace_members m
  set status = p_status
  from public.mfa_workspaces w
  where m.id = p_member_id
    and w.id = m.workspace_id
    and w.owner_id = v_uid;

  if not found then raise exception 'Member not found or access denied'; end if;
end;
$mfa$;

revoke all on function public.mfa_set_member_status(uuid, text) from public;
grant execute on function public.mfa_set_member_status(uuid, text) to authenticated;
