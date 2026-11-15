create or replace function public.manager_delete_warehouse_order(p_order_id uuid)
returns uuid language plpgsql security definer set search_path=public
as $$
declare o public.warehouse_delivery_orders; v_label text; v_actor text;
begin
 if not public.is_admin() then raise exception 'Manager access required'; end if;
 select * into o from public.warehouse_delivery_orders where id=p_order_id for update;
 if o.id is null then raise exception 'Order not found'; end if;
 v_label := 'Delivery order deleted | '||coalesce(o.destination,'')||
   ' | Recipient: '||coalesce(o.recipient,'')||
   ' | Previous status: '||coalesce(o.status,'unknown')||
   ' | Order ID: '||o.id::text;
 v_actor := coalesce(auth.jwt()->>'email','Manager');
 update public.inventory_units u set status='available',updated_at=now()
 where u.id in (select dr.unit_id from public.delivery_requests dr
   where dr.warehouse_order_id=p_order_id and dr.unit_id is not null)
 and u.status in ('reserved','out_for_delivery');
 insert into public.activity(product_id,action,product_name,actor_email)
 values(null,'deleted',left(v_label,500),v_actor);
 delete from public.delivery_requests where warehouse_order_id=p_order_id;
 delete from public.warehouse_delivery_order_lines where order_id=p_order_id;
 delete from public.notifications where reference_id=p_order_id;
 delete from public.warehouse_delivery_orders where id=p_order_id;
 return p_order_id;
end $$;
revoke all on function public.manager_delete_warehouse_order(uuid) from public, anon;
grant execute on function public.manager_delete_warehouse_order(uuid) to authenticated;
