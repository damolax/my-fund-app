-- Person email + ledger change notifications

alter table public.mfa_people
  add column if not exists email text;

do $mfa$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'mfa_people_email_format_check'
  ) then
    alter table public.mfa_people
      add constraint mfa_people_email_format_check
      check (
        email is null
        or email = ''
        or email ~* '^[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}$'
      );
  end if;
end;
$mfa$;

create table if not exists public.mfa_person_ledger_email_outbox (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.mfa_workspaces(id) on delete cascade,
  person_id uuid not null,
  transaction_id uuid not null,
  change_type text not null check (change_type in ('created', 'updated', 'deleted')),
  recipient_email text not null,
  subject text not null,
  html_body text not null,
  deep_link text not null,
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'sent', 'failed')),
  attempts integer not null default 0,
  last_error text,
  last_attempt_at timestamptz,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  foreign key (person_id, workspace_id)
    references public.mfa_people(id, workspace_id) on delete cascade
);

create index if not exists mfa_person_ledger_email_lookup_idx
  on public.mfa_person_ledger_email_outbox(
    workspace_id, transaction_id, change_type, status, created_at desc
  );

alter table public.mfa_person_ledger_email_outbox enable row level security;
revoke all on public.mfa_person_ledger_email_outbox from anonymous, authenticated;

create or replace function public.mfa_queue_person_ledger_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $mfa$
declare
  v_row public.mfa_transactions%rowtype;
  v_person public.mfa_people%rowtype;
  v_change_type text;
  v_type_label text;
  v_subject text;
  v_body text;
  v_link text;
begin
  if tg_op = 'UPDATE' then
    if to_jsonb(old) - 'created_at' = to_jsonb(new) - 'created_at' then
      return new;
    end if;
    v_row := new;
    v_change_type := 'updated';
  elsif tg_op = 'DELETE' then
    v_row := old;
    v_change_type := 'deleted';
  else
    v_row := new;
    v_change_type := 'created';
  end if;

  select * into v_person
  from public.mfa_people
  where id = v_row.person_id
    and workspace_id = v_row.workspace_id;

  if not found or length(trim(coalesce(v_person.email, ''))) = 0 then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  v_type_label := case when v_row.type = 'income' then 'income' else 'expense' end;
  v_link := 'https://my-fund-app-one.vercel.app/#/view/' || v_person.share_token::text;

  v_subject := case v_change_type
    when 'created' then 'My Fund App: ' || initcap(v_type_label) || ' record added'
    when 'updated' then 'My Fund App: ' || initcap(v_type_label) || ' record updated'
    else 'My Fund App: ' || initcap(v_type_label) || ' record removed'
  end;

  v_body :=
    '<p>Hello ' || replace(replace(replace(v_person.name, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || ',</p>' ||
    '<p>An ' || v_type_label || ' record in your My Fund App account was <strong>' ||
    v_change_type || '</strong>.</p>' ||
    '<p><strong>' || v_row.currency || ' ' || v_row.amount::text || '</strong>' ||
    case when length(trim(coalesce(v_row.description, ''))) > 0
      then ' · ' || replace(replace(replace(v_row.description, '&', '&amp;'), '<', '&lt;'), '>', '&gt;')
      else ''
    end ||
    case when v_row.date is not null
      then ' · ' || v_row.date::text
      else ' · date unknown'
    end ||
    '</p><p><a href="' || v_link || '">View your current records in My Fund App</a></p>';

  insert into public.mfa_person_ledger_email_outbox (
    workspace_id,
    person_id,
    transaction_id,
    change_type,
    recipient_email,
    subject,
    html_body,
    deep_link
  )
  values (
    v_row.workspace_id,
    v_row.person_id,
    v_row.id,
    v_change_type,
    lower(trim(v_person.email)),
    v_subject,
    v_body,
    v_link
  );

  return case when tg_op = 'DELETE' then old else new end;
end;
$mfa$;

drop trigger if exists mfa_person_ledger_email_trigger on public.mfa_transactions;
create trigger mfa_person_ledger_email_trigger
after insert or update or delete on public.mfa_transactions
for each row
execute function public.mfa_queue_person_ledger_email();

create or replace function public.mfa_claim_person_ledger_email(
  p_transaction_id uuid,
  p_change_type text
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $mfa$
declare
  v_uid text := (select auth.user_id());
  v_outbox public.mfa_person_ledger_email_outbox%rowtype;
begin
  if coalesce(v_uid, '') = '' then
    raise exception 'Authentication required';
  end if;

  select o.* into v_outbox
  from public.mfa_person_ledger_email_outbox o
  join public.mfa_workspaces w on w.id = o.workspace_id
  where o.transaction_id = p_transaction_id
    and o.change_type = p_change_type
    and w.owner_id = v_uid
  order by o.created_at desc
  limit 1
  for update of o;

  if not found then return jsonb_build_object('status', 'none'); end if;
  if v_outbox.status = 'sent' then return jsonb_build_object('status', 'sent'); end if;

  if v_outbox.status = 'sending'
    and v_outbox.last_attempt_at is not null
    and v_outbox.last_attempt_at > now() - interval '10 minutes'
  then
    return jsonb_build_object('status', 'busy');
  end if;

  if v_outbox.attempts >= 5 then
    return jsonb_build_object('status', 'failed', 'reason', 'attempt_limit');
  end if;

  update public.mfa_person_ledger_email_outbox
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

revoke all on function public.mfa_claim_person_ledger_email(uuid, text) from public;
grant execute on function public.mfa_claim_person_ledger_email(uuid, text) to authenticated;

create or replace function public.mfa_complete_person_ledger_email(
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
begin
  if coalesce(v_uid, '') = '' then
    raise exception 'Authentication required';
  end if;

  update public.mfa_person_ledger_email_outbox o
  set status = case when p_success then 'sent' else 'failed' end,
      sent_at = case when p_success then now() else null end,
      last_error = case when p_success then null else left(coalesce(p_error, 'Delivery failed'), 1000) end
  from public.mfa_workspaces w
  where o.id = p_outbox_id
    and w.id = o.workspace_id
    and w.owner_id = v_uid;

  if not found then
    raise exception 'Email outbox item not found';
  end if;
end;
$mfa$;

revoke all on function public.mfa_complete_person_ledger_email(uuid, boolean, text) from public;
grant execute on function public.mfa_complete_person_ledger_email(uuid, boolean, text) to authenticated;

-- Owner-only approved-record edits, validated atomically.
create or replace function public.mfa_update_owner_transaction(
  p_transaction_id uuid,
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
  v_old public.mfa_transactions%rowtype;
  v_new public.mfa_transactions%rowtype;
begin
  select t.* into v_old
  from public.mfa_transactions t
  join public.mfa_workspaces w on w.id = t.workspace_id
  where t.id = p_transaction_id
    and w.owner_id = v_uid
  for update of t;

  if not found then raise exception 'Record not found or access denied'; end if;
  if p_transaction_type not in ('income', 'expense') then raise exception 'Invalid record type'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Amount must be greater than zero'; end if;
  if length(trim(coalesce(p_currency, ''))) <> 3 then raise exception 'Use a three-letter currency code'; end if;
  if length(trim(coalesce(p_description, ''))) = 0 then raise exception 'Description is required'; end if;

  if p_transaction_type = 'income' then
    p_category := null;
  elsif p_category not in ('PV', 'Upkeep', 'Investment', 'Other') then
    raise exception 'Choose a valid expense category';
  end if;

  update public.mfa_transactions
  set type = p_transaction_type,
      amount = round(p_amount, 2),
      currency = upper(trim(p_currency)),
      date = p_date,
      description = trim(p_description),
      category = p_category
  where id = v_old.id
  returning * into v_new;

  if v_new.date is not null then
    perform public.mfa_validate_month_limits(
      v_new.workspace_id,
      v_new.person_id,
      v_new.currency,
      v_new.date
    );
  end if;

  if v_old.date is not null
    and (
      v_old.currency <> v_new.currency
      or date_trunc('month', v_old.date)::date is distinct from date_trunc('month', v_new.date)::date
      or v_new.date is null
    )
  then
    perform public.mfa_validate_month_limits(
      v_old.workspace_id,
      v_old.person_id,
      v_old.currency,
      v_old.date
    );
  end if;

  return to_jsonb(v_new);
end;
$mfa$;

revoke all on function public.mfa_update_owner_transaction(uuid, text, numeric, text, date, text, text) from public;
grant execute on function public.mfa_update_owner_transaction(uuid, text, numeric, text, date, text, text) to authenticated;

-- Do not expose the attached email address through the bearer person link.
create or replace function public.mfa_get_person_public_view(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $mfa$
declare
  v_person public.mfa_people%rowtype;
  v_workspace public.mfa_workspaces%rowtype;
  v_submitter text;
begin
  select * into v_person
  from public.mfa_people
  where share_token = p_token;

  if not found then return null; end if;

  select * into v_workspace
  from public.mfa_workspaces
  where id = v_person.workspace_id;

  v_submitter := 'person-link:' || v_person.id::text;

  return jsonb_build_object(
    'workspace', jsonb_build_object(
      'name', v_workspace.name,
      'default_currency', v_workspace.default_currency,
      'upkeep_percentage', v_workspace.upkeep_percentage
    ),
    'person', to_jsonb(v_person) - 'email',
    'transactions', coalesce((
      select jsonb_agg(to_jsonb(t) order by t.date desc nulls last, t.created_at desc)
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
    ), '[]'::jsonb),
    'requests', coalesce((
      select jsonb_agg(public.mfa_public_request_payload(r) order by r.created_at desc)
      from public.mfa_record_requests r
      where r.person_id = v_person.id
        and r.submitted_by_user_id = v_submitter
        and r.request_action = 'create'
    ), '[]'::jsonb)
  );
end;
$mfa$;

revoke all on function public.mfa_get_person_public_view(uuid) from public;
grant execute on function public.mfa_get_person_public_view(uuid) to anonymous, authenticated;
