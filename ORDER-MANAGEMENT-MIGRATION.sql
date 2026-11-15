-- Wearhouse order management RPCs for Trade Supabase
create or replace function public.manager_update_warehouse_order(
  p_order_id uuid, p_driver_id uuid, p_lines jsonb, p_destination text,
  p_recipient text, p_delivery_date date, p_service_type text, p_notes text default ''
) returns uuid
language plpgsql security definer set search_path=public
as $$
declare o public.warehouse_delivery_orders; v_n int; v_distinct int; v_valid int; v_sum int;
begin
 if not public.is_admin() then raise exception 'Manager access required'; end if;
 select * into o from public.warehouse_delivery_orders where id=p_order_id for update;
 if o.id is null then raise exception 'Order not found'; end if;
 if o.status not in ('assigned','correction_required') or o.current_batch_id is not null then
   raise exception 'This order can only be edited before serials are submitted';
 end if;
 if not exists(select 1 from public.profiles p where p.id=p_driver_id and p.active and p.role='delivery_guy'
   and not exists(select 1 from public.admin_users a where a.user_id=p.id)) then
   raise exception 'Select an active delivery employee';
 end if;
 if p_service_type not in ('delivery','delivery_installation') then raise exception 'Invalid service type'; end if;
 if p_delivery_date is null or length(btrim(coalesce(p_destination,'')))<2 or length(p_destination)>200 then
   raise exception 'Enter a valid destination and delivery date';
 end if;
 if p_lines is null or jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines) not between 1 and 25 then
   raise exception 'Add 1 to 25 products';
 end if;
 select count(*),count(distinct product_id),count(*) filter(where qty between 1 and 50),coalesce(sum(qty),0)
 into v_n,v_distinct,v_valid,v_sum
 from (select (e->>'product_id')::uuid product_id,(e->>'quantity')::integer qty from jsonb_array_elements(p_lines) e) x;
 if v_n<>v_distinct or v_n<>v_valid or v_sum>50 then raise exception 'Check product quantities'; end if;
 if exists(select 1 from (select (e->>'product_id')::uuid product_id,(e->>'quantity')::integer qty from jsonb_array_elements(p_lines) e) x
   where not exists(select 1 from public.products p where p.id=x.product_id)
   or (select count(*) from public.inventory_units u where u.product_id=x.product_id and u.status='available'
       and not exists(select 1 from public.delivery_requests dr where dr.unit_id=u.id and dr.status in ('pending_admin_approval','approved_for_delivery','delivery_note_submitted'))) < x.qty)
 then raise exception 'Requested quantity exceeds available inventory'; end if;
 update public.warehouse_delivery_orders set driver_id=p_driver_id, destination=btrim(p_destination),
 recipient=left(coalesce(p_recipient,''),120),delivery_date=p_delivery_date,
 service_type=p_service_type,notes=left(coalesce(p_notes,''),500),updated_at=now() where id=p_order_id;
 delete from public.warehouse_delivery_order_lines where order_id=p_order_id;
 insert into public.warehouse_delivery_order_lines(order_id,product_id,quantity)
 select p_order_id,(e->>'product_id')::uuid,(e->>'quantity')::integer from jsonb_array_elements(p_lines) e;
 insert into public.notifications(recipient_id,title,body,type,reference_id)
 values(p_driver_id,'Delivery order updated','A manager updated an assigned delivery order.','delivery',p_order_id);
 return p_order_id;
end $$;
revoke all on function public.manager_update_warehouse_order(uuid,uuid,jsonb,text,text,date,text,text) from public, anon;
grant execute on function public.manager_update_warehouse_order(uuid,uuid,jsonb,text,text,date,text,text) to authenticated;

create or replace function public.manager_delete_cancelled_warehouse_order(p_order_id uuid)
returns uuid language plpgsql security definer set search_path=public
as $$
declare o public.warehouse_delivery_orders;
begin
 if not public.is_admin() then raise exception 'Manager access required'; end if;
 select * into o from public.warehouse_delivery_orders where id=p_order_id for update;
 if o.id is null then raise exception 'Order not found'; end if;
 if o.status<>'cancelled' then raise exception 'Only cancelled orders can be permanently deleted'; end if;
 delete from public.delivery_requests where warehouse_order_id=p_order_id;
 delete from public.warehouse_delivery_order_lines where order_id=p_order_id;
 delete from public.notifications where reference_id=p_order_id;
 delete from public.warehouse_delivery_orders where id=p_order_id;
 return p_order_id;
end $$;
revoke all on function public.manager_delete_cancelled_warehouse_order(uuid) from public, anon;
grant execute on function public.manager_delete_cancelled_warehouse_order(uuid) to authenticated;
