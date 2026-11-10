-- SAFE PATCH FOR AN EXISTING DATABASE: update only the rejection RPC.
-- Does not delete or modify any stored inventory, delivery, or user rows.
create or replace function public.reject_delivery_request(request_id uuid, rejection_reason text default '')
returns public.delivery_requests
language plpgsql
security definer
set search_path = public
as $$
declare r public.delivery_requests;
begin
  if not public.is_admin() then raise exception 'Admin access required'; end if;

  select * into r from public.delivery_requests where id = request_id for update;
  if r.id is null then raise exception 'Delivery request not found'; end if;
  if r.status in ('completed','rejected') then raise exception 'This request is already closed'; end if;

  if r.status in ('approved_for_delivery','delivery_note_submitted') then
    update public.inventory_units
    set status = 'available'
    where id = r.unit_id and status in ('reserved','out_for_delivery');
  end if;

  update public.delivery_requests
  set status = 'rejected', rejection_reason = coalesce(reject_delivery_request.rejection_reason, '')
  where id = request_id
  returning * into r;

  insert into public.notifications(recipient_id, title, body, type, reference_id)
  values (
    r.delivery_guy_id,
    'Delivery rejected',
    'Your delivery request was rejected.' || case when coalesce(reject_delivery_request.rejection_reason,'') <> '' then ' Reason: ' || reject_delivery_request.rejection_reason else '' end,
    'delivery',
    r.id
  );

  return r;
end;
$$;


revoke all on function public.reject_delivery_request(uuid,text) from public;
grant execute on function public.reject_delivery_request(uuid,text) to authenticated;
