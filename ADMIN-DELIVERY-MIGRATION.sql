-- Wearhouse manager-created delivery assignments (Supabase Trade only).
-- The migration is already deployed when this ZIP is delivered.
-- Do not run manually unless instructed. Existing Trade tables are untouched.
alter table public.delivery_requests add column if not exists batch_id uuid;
create index if not exists delivery_requests_batch_idx on public.delivery_requests(batch_id);

-- Only managers create new requests. Legacy pending driver requests remain readable
-- and managers can still finish or reject them.
drop policy if exists "delivery can create requests" on public.delivery_requests;

create or replace function public.notify_new_delivery() returns trigger
language plpgsql security definer set search_path=public as $$
declare a record;
begin
 if new.batch_id is not null then return new; end if;
 for a in select user_id from public.admin_users loop
  insert into public.notifications(recipient_id,title,body,type,reference_id)
  values(a.user_id,'New delivery request','A delivery request for serial ' ||
  (select serial_number from public.inventory_units where id=new.unit_id) || ' was submitted for ' ||
  new.destination || '.','delivery',new.id);
 end loop;
 return new;
end $$;

create or replace function public.notify_delivery_note() returns trigger
language plpgsql security definer set search_path=public as $$
declare a record;
begin
 if new.batch_id is not null then return new; end if;
 if new.status='delivery_note_submitted' and old.status is distinct from new.status then
  for a in select user_id from public.admin_users loop
   insert into public.notifications(recipient_id,title,body,type,reference_id)
   values(a.user_id,'Delivery note submitted','A delivery note is ready for review for serial ' ||
   (select serial_number from public.inventory_units where id=new.unit_id) || '.','delivery',new.id);
  end loop;
 end if;
 return new;
end $$;

create or replace function public.create_delivery_assignment(
 p_driver_id uuid,
 p_product_id uuid,
 p_quantity integer,
 p_destination text,
 p_recipient text,
 p_delivery_date date,
 p_notes text default ''
) returns uuid language plpgsql security definer set search_path=public as $$
declare v_batch uuid := gen_random_uuid(); v_unit_ids uuid[]; v_num integer;
begin
 if not public.is_admin() then raise exception 'Only warehouse managers can create delivery requests'; end if;
 if p_quantity is null or p_quantity < 1 or p_quantity > 100 then raise exception 'Quantity must be between 1 and 100'; end if;
 if p_delivery_date is null then raise exception 'Delivery date is required'; end if;
 if coalesce(length(btrim(p_destination)),0)=0 or length(p_destination)>200 then
  raise exception 'A valid destination is required'; end if;
 if not exists (select 1 from public.products where id=p_product_id) then
  raise exception 'Product not found'; end if;
 if not exists (
  select 1 from public.profiles p where p.id=p_driver_id and p.role='delivery_guy'
   and p.active=true and not exists(select 1 from public.admin_users a where a.user_id=p.id)
 ) then raise exception 'Choose an active delivery employee'; end if;

 select array_agg(selected.id) into v_unit_ids
 from (
  select u.id from public.inventory_units u
  where u.product_id=p_product_id and u.status='available'
    and not exists(select 1 from public.delivery_requests dr
     where dr.unit_id=u.id and dr.status in
      ('pending_admin_approval','approved_for_delivery','delivery_note_submitted'))
  order by u.created_at,u.id
  limit p_quantity for update of u skip locked
 ) as selected;
 v_num:=coalesce(cardinality(v_unit_ids),0);
 if v_num <> p_quantity then raise exception 'Not enough available units (requested %, available %)', p_quantity, v_num; end if;

 update public.inventory_units set status='reserved' where id=any(v_unit_ids) and status='available';
 get diagnostics v_num = row_count;
 if v_num <> p_quantity then raise exception 'Inventory changed during assignment. Try again'; end if;

 insert into public.delivery_requests(
  batch_id,delivery_guy_id,product_id,unit_id,destination,recipient,delivery_date,notes,status,
  approved_by,approved_at
 ) select v_batch,p_driver_id,p_product_id,item_id,btrim(p_destination),
  left(coalesce(p_recipient,''),120),p_delivery_date,left(coalesce(p_notes,''),500),
  'approved_for_delivery',auth.uid(),now()
 from unnest(v_unit_ids) as item_id;

 insert into public.notifications(recipient_id,title,body,type,reference_id)
 values(p_driver_id,'New delivery assigned',p_quantity || ' unit(s) of ' ||
 (select name from public.products where id=p_product_id) || ' for ' || btrim(p_destination) ||
 ' · ' || p_delivery_date::text,'delivery',v_batch);
 return v_batch;
end $$;

create or replace function public.submit_delivery_assignment_note(
 p_batch_id uuid,
 p_note_path text,
 p_note_number text default '',
 p_note_text text default ''
) returns uuid language plpgsql security definer set search_path=public as $$
declare v_count integer; v_changed integer; v_allowed boolean; a record;
begin
 if not public.is_delivery() then raise exception 'Only delivery employees can upload notes'; end if;
 perform 1 from public.delivery_requests where batch_id=p_batch_id for update;
 select count(*),coalesce(bool_and(delivery_guy_id=auth.uid() and status='approved_for_delivery'),false)
 into v_count,v_allowed from public.delivery_requests where batch_id=p_batch_id;
 if v_count=0 or not v_allowed then raise exception 'This delivery is not assigned to you or is not ready'; end if;
 if coalesce(p_note_path,'') not like auth.uid()::text || '/' || p_batch_id::text || '/%' then
  raise exception 'Delivery note must be uploaded to your assignment folder'; end if;
 if not exists(select 1 from storage.objects where bucket_id='delivery-notes' and name=p_note_path) then
  raise exception 'Delivery note upload was not found'; end if;
 update public.inventory_units u set status='out_for_delivery'
 from public.delivery_requests d where d.batch_id=p_batch_id and d.unit_id=u.id and u.status='reserved';
 get diagnostics v_changed = row_count;
 if v_changed <> v_count then raise exception 'Reserved inventory does not match this delivery'; end if;
 update public.delivery_requests set status='delivery_note_submitted',
  delivery_note_url=p_note_path,delivery_note_number=left(coalesce(p_note_number,''),120),
  driver_notes=left(coalesce(p_note_text,''),500),delivered_at=now()
 where batch_id=p_batch_id;
 for a in select user_id from public.admin_users loop
  insert into public.notifications(recipient_id,title,body,type,reference_id)
  values(a.user_id,'Delivery note submitted',v_count || ' unit(s) delivered. Review the note and confirm completion.',
  'delivery',p_batch_id);
 end loop;
 return p_batch_id;
end $$;

create or replace function public.complete_delivery_assignment(p_batch_id uuid)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_count integer; v_changed integer; v_valid boolean; v_driver uuid;
begin
 if not public.is_admin() then raise exception 'Only managers can confirm deliveries'; end if;
 perform 1 from public.delivery_requests where batch_id=p_batch_id for update;
 select count(*),coalesce(bool_and(status='delivery_note_submitted'),false),(array_agg(delivery_guy_id))[1]
 into v_count,v_valid,v_driver from public.delivery_requests where batch_id=p_batch_id;
 if v_count=0 or not v_valid then raise exception 'A delivery note must be submitted first'; end if;
 update public.inventory_units u set status='delivered'
 from public.delivery_requests d where d.batch_id=p_batch_id and d.unit_id=u.id and u.status='out_for_delivery';
 get diagnostics v_changed = row_count;
 if v_changed <> v_count then raise exception 'Inventory does not match the delivery'; end if;
 update public.delivery_requests set status='completed',completed_at=now(),completed_by=auth.uid()
 where batch_id=p_batch_id;
 insert into public.notifications(recipient_id,title,body,type,reference_id)
 values(v_driver,'Delivery completed',v_count || ' unit(s) were confirmed by the manager.','delivery',p_batch_id);
 return p_batch_id;
end $$;

create or replace function public.cancel_delivery_assignment(p_batch_id uuid,p_reason text default '')
returns uuid language plpgsql security definer set search_path=public as $$
declare v_count integer; v_changed integer; v_valid boolean; v_driver uuid;
begin
 if not public.is_admin() then raise exception 'Only managers can cancel deliveries'; end if;
 perform 1 from public.delivery_requests where batch_id=p_batch_id for update;
 select count(*),coalesce(bool_and(status in ('approved_for_delivery','delivery_note_submitted')),false),(array_agg(delivery_guy_id))[1]
 into v_count,v_valid,v_driver from public.delivery_requests where batch_id=p_batch_id;
 if v_count=0 or not v_valid then raise exception 'This delivery cannot be cancelled'; end if;
 update public.inventory_units u set status='available'
 from public.delivery_requests d where d.batch_id=p_batch_id and d.unit_id=u.id and u.status in ('reserved','out_for_delivery');
 get diagnostics v_changed = row_count;
 if v_changed <> v_count then raise exception 'Inventory does not match the delivery'; end if;
 update public.delivery_requests set status='rejected',rejection_reason=left(coalesce(p_reason,''),500)
 where batch_id=p_batch_id;
 insert into public.notifications(recipient_id,title,body,type,reference_id)
 values(v_driver,'Delivery cancelled','The manager cancelled a delivery for ' || v_count || ' unit(s).',
 'delivery',p_batch_id);
 return p_batch_id;
end $$;

-- Privileged functions must never be callable anonymously.
revoke all on function public.create_delivery_assignment(uuid,uuid,integer,text,text,date,text) from public,anon;
revoke all on function public.submit_delivery_assignment_note(uuid,text,text,text) from public,anon;
revoke all on function public.complete_delivery_assignment(uuid) from public,anon;
revoke all on function public.cancel_delivery_assignment(uuid,text) from public,anon;
grant execute on function public.create_delivery_assignment(uuid,uuid,integer,text,text,date,text) to authenticated;
grant execute on function public.submit_delivery_assignment_note(uuid,text,text,text) to authenticated;
grant execute on function public.complete_delivery_assignment(uuid) to authenticated;
grant execute on function public.cancel_delivery_assignment(uuid,text) to authenticated;
