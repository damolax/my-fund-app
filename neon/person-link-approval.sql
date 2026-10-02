-- Person-link record request workflow
-- The secure person share link is a bearer credential. It may read that person's
-- approved ledger and create/edit/delete only pending new-record requests.
-- It never receives direct INSERT/UPDATE/DELETE privileges on mfa_transactions.

create or replace function public.mfa_public_request_payload(p_request public.mfa_record_requests)
returns jsonb
language sql
stable
security definer
set search_path = public
as $mfa$
  select jsonb_build_object(
    'id', p_request.id,
    'person_id', p_request.person_id,
    'transaction_type', p_request.transaction_type,
    'amount', p_request.amount,
    'currency', p_request.currency,
    'date', p_request.date,
    'description', p_request.description,
    'category', p_request.category,
    'status', p_request.status,
    'reviewer_note', p_request.reviewer_note,
    'reviewed_at', p_request.reviewed_at,
    'recorded_transaction_id', p_request.recorded_transaction_id,
    'created_at', p_request.created_at,
    'updated_at', p_request.updated_at
  );
$mfa$;

revoke all on function public.mfa_public_request_payload(public.mfa_record_requests) from public;

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
    'person', to_jsonb(v_person),
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

create or replace function public.mfa_submit_public_record_request(
  p_token uuid,
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
set search_path = public
as $mfa$
declare
  v_person public.mfa_people%rowtype;
  v_workspace public.mfa_workspaces%rowtype;
  v_request public.mfa_record_requests%rowtype;
  v_owner_email text;
  v_submitter text;
  v_link text;
begin
  select * into v_person
  from public.mfa_people
  where share_token = p_token;

  if not found then raise exception 'This secure link is invalid or has been replaced'; end if;

  select * into v_workspace
  from public.mfa_workspaces
  where id = v_person.workspace_id;

  if p_transaction_type not in ('income', 'expense') then raise exception 'Invalid record type'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Amount must be greater than zero'; end if;
  if length(trim(coalesce(p_currency, ''))) <> 3 then raise exception 'Use a three-letter currency code'; end if;
  if length(trim(coalesce(p_description, ''))) = 0 then raise exception 'Description is required'; end if;

  if p_transaction_type = 'income' then
    p_category := null;
  elsif p_category not in ('PV', 'Upkeep', 'Investment', 'Other') then
    raise exception 'Choose a valid expense category';
  end if;

  v_submitter := 'person-link:' || v_person.id::text;

  insert into public.mfa_record_requests (
    workspace_id,
    person_id,
    submitted_by_user_id,
    submitted_by_email,
    request_action,
    target_transaction_id,
    transaction_type,
    amount,
    currency,
    date,
    description,
    category
  )
  values (
    v_person.workspace_id,
    v_person.id,
    v_submitter,
    'Personal secure link',
    'create',
    null,
    p_transaction_type,
    round(p_amount, 2),
    upper(trim(p_currency)),
    p_date,
    trim(p_description),
    p_category
  )
  returning * into v_request;

  insert into public.mfa_notifications (
    workspace_id,
    recipient_user_id,
    kind,
    title,
    body,
    request_id
  )
  values (
    v_person.workspace_id,
    v_workspace.owner_id,
    'record_request',
    'New record needs approval',
    v_person.name || ' submitted a ' || p_transaction_type || ' request for ' ||
      upper(trim(p_currency)) || ' ' || round(p_amount, 2)::text || '.',
    v_request.id
  );

  select email into v_owner_email
  from public.mfa_app_users
  where user_id = v_workspace.owner_id
  limit 1;

  v_link := 'https://my-fund-app-one.vercel.app/#/approvals?request=' || v_request.id::text;

  if coalesce(v_owner_email, '') <> '' then
    insert into public.mfa_email_outbox (
      workspace_id,
      request_id,
      recipient_email,
      subject,
      html_body,
      deep_link
    )
    values (
      v_person.workspace_id,
      v_request.id,
      v_owner_email,
      'My Fund App: new record needs your approval',
      '<p><strong>' || replace(replace(replace(v_person.name, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') ||
      '</strong> submitted a pending ' || p_transaction_type ||
      ' request for <strong>' || upper(trim(p_currency)) || ' ' || round(p_amount, 2)::text ||
      '</strong>.</p><p><a href="' || v_link || '">Review this request in My Fund App</a></p>',
      v_link
    );
  end if;

  return public.mfa_public_request_payload(v_request);
end;
$mfa$;

revoke all on function public.mfa_submit_public_record_request(uuid, text, numeric, text, date, text, text) from public;
grant execute on function public.mfa_submit_public_record_request(uuid, text, numeric, text, date, text, text) to anonymous, authenticated;

create or replace function public.mfa_update_public_record_request(
  p_token uuid,
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
set search_path = public
as $mfa$
declare
  v_person public.mfa_people%rowtype;
  v_request public.mfa_record_requests%rowtype;
  v_submitter text;
begin
  select * into v_person
  from public.mfa_people
  where share_token = p_token;

  if not found then raise exception 'This secure link is invalid or has been replaced'; end if;

  v_submitter := 'person-link:' || v_person.id::text;

  select * into v_request
  from public.mfa_record_requests
  where id = p_request_id
    and person_id = v_person.id
    and submitted_by_user_id = v_submitter
    and request_action = 'create'
  for update;

  if not found then raise exception 'Request not found'; end if;
  if v_request.status <> 'pending' then raise exception 'Only pending requests can be edited'; end if;
  if p_transaction_type not in ('income', 'expense') then raise exception 'Invalid record type'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Amount must be greater than zero'; end if;
  if length(trim(coalesce(p_currency, ''))) <> 3 then raise exception 'Use a three-letter currency code'; end if;
  if length(trim(coalesce(p_description, ''))) = 0 then raise exception 'Description is required'; end if;

  if p_transaction_type = 'income' then
    p_category := null;
  elsif p_category not in ('PV', 'Upkeep', 'Investment', 'Other') then
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
  where id = v_request.id
  returning * into v_request;

  update public.mfa_notifications
  set title = 'Pending record request updated',
      body = v_person.name || ' updated a pending request to ' ||
        v_request.currency || ' ' || v_request.amount::text || '.',
      is_read = false
  where request_id = v_request.id
    and kind = 'record_request';

  update public.mfa_email_outbox
  set subject = 'My Fund App: pending record request updated',
      html_body = '<p><strong>' ||
        replace(replace(replace(v_person.name, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') ||
        '</strong> updated a pending request to <strong>' ||
        v_request.currency || ' ' || v_request.amount::text ||
        '</strong>.</p><p><a href="' || deep_link || '">Review this request in My Fund App</a></p>',
      status = case when status = 'sent' then 'pending' else status end,
      sent_at = case when status = 'sent' then null else sent_at end
  where request_id = v_request.id;

  return public.mfa_public_request_payload(v_request);
end;
$mfa$;

revoke all on function public.mfa_update_public_record_request(uuid, uuid, text, numeric, text, date, text, text) from public;
grant execute on function public.mfa_update_public_record_request(uuid, uuid, text, numeric, text, date, text, text) to anonymous, authenticated;

create or replace function public.mfa_delete_public_record_request(
  p_token uuid,
  p_request_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $mfa$
declare
  v_person public.mfa_people%rowtype;
  v_submitter text;
begin
  select * into v_person
  from public.mfa_people
  where share_token = p_token;

  if not found then raise exception 'This secure link is invalid or has been replaced'; end if;

  v_submitter := 'person-link:' || v_person.id::text;

  delete from public.mfa_record_requests
  where id = p_request_id
    and person_id = v_person.id
    and submitted_by_user_id = v_submitter
    and request_action = 'create'
    and status = 'pending';

  if not found then
    raise exception 'Only pending requests created from this secure link can be deleted';
  end if;
end;
$mfa$;

revoke all on function public.mfa_delete_public_record_request(uuid, uuid) from public;
grant execute on function public.mfa_delete_public_record_request(uuid, uuid) to anonymous, authenticated;

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
        jsonb_build_object(
          'person_name', p.name,
          'source_label',
            case when r.submitted_by_user_id = 'person-link:' || p.id::text
              then 'Personal secure link'
              else 'Account user'
            end
        )
        order by
          case when r.status = 'pending' then 0 else 1 end,
          r.created_at desc
      )
      from public.mfa_record_requests r
      join public.mfa_people p on p.id = r.person_id
      where r.workspace_id = v_workspace.id
        and r.request_action = 'create'
    ), '[]'::jsonb),
    'notifications', coalesce((
      select jsonb_agg(to_jsonb(n) order by n.created_at desc)
      from public.mfa_notifications n
      where n.recipient_user_id = v_uid
    ), '[]'::jsonb),
    'members', '[]'::jsonb,
    'invites', '[]'::jsonb
  );
end;
$mfa$;

revoke all on function public.mfa_get_approval_center() from public;
grant execute on function public.mfa_get_approval_center() to authenticated;

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
  if v_request.request_action <> 'create' or v_request.target_transaction_id is not null then
    raise exception 'Only new-record requests can be approved from the personal link';
  end if;

  if p_decision = 'approve' then
    insert into public.mfa_transactions (
      workspace_id,
      person_id,
      type,
      amount,
      currency,
      date,
      description,
      category
    )
    values (
      v_request.workspace_id,
      v_request.person_id,
      v_request.transaction_type,
      v_request.amount,
      v_request.currency,
      v_request.date,
      v_request.description,
      v_request.category
    )
    returning id into v_record_id;

    if v_request.date is not null then
      perform public.mfa_validate_month_limits(
        v_request.workspace_id,
        v_request.person_id,
        v_request.currency,
        v_request.date
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

  if v_request.submitted_by_user_id not like 'person-link:%' then
    insert into public.mfa_notifications (
      workspace_id,
      recipient_user_id,
      kind,
      title,
      body,
      request_id
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
  end if;

  return (
    select to_jsonb(r)
    from public.mfa_record_requests r
    where r.id = v_request.id
  );
end;
$mfa$;

revoke all on function public.mfa_review_record_request(uuid, text, text) from public;
grant execute on function public.mfa_review_record_request(uuid, text, text) to authenticated;

create or replace function public.mfa_claim_public_request_email(
  p_request_id uuid,
  p_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $mfa$
declare
  v_person public.mfa_people%rowtype;
  v_request public.mfa_record_requests%rowtype;
  v_outbox public.mfa_email_outbox%rowtype;
  v_submitter text;
begin
  select * into v_person
  from public.mfa_people
  where share_token = p_token;

  if not found then raise exception 'Invalid secure link'; end if;

  v_submitter := 'person-link:' || v_person.id::text;

  select * into v_request
  from public.mfa_record_requests
  where id = p_request_id
    and person_id = v_person.id
    and submitted_by_user_id = v_submitter;

  if not found then raise exception 'Request not found'; end if;

  select * into v_outbox
  from public.mfa_email_outbox
  where request_id = p_request_id
  order by created_at desc
  limit 1
  for update;

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

revoke all on function public.mfa_claim_public_request_email(uuid, uuid) from public;
grant execute on function public.mfa_claim_public_request_email(uuid, uuid) to anonymous, authenticated;

create or replace function public.mfa_complete_public_request_email(
  p_outbox_id uuid,
  p_token uuid,
  p_success boolean,
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $mfa$
declare
  v_person public.mfa_people%rowtype;
  v_submitter text;
begin
  select * into v_person
  from public.mfa_people
  where share_token = p_token;

  if not found then raise exception 'Invalid secure link'; end if;

  v_submitter := 'person-link:' || v_person.id::text;

  if not exists (
    select 1
    from public.mfa_email_outbox o
    join public.mfa_record_requests r on r.id = o.request_id
    where o.id = p_outbox_id
      and r.person_id = v_person.id
      and r.submitted_by_user_id = v_submitter
  ) then
    raise exception 'Email outbox item not found';
  end if;

  update public.mfa_email_outbox
  set status = case when p_success then 'sent' else 'failed' end,
      sent_at = case when p_success then now() else null end,
      last_error = case when p_success then null else left(coalesce(p_error, 'Delivery failed'), 1000) end
  where id = p_outbox_id;
end;
$mfa$;

revoke all on function public.mfa_complete_public_request_email(uuid, uuid, boolean, text) from public;
grant execute on function public.mfa_complete_public_request_email(uuid, uuid, boolean, text) to anonymous, authenticated;
