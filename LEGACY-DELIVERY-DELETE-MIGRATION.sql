create or replace function public.manager_delete_legacy_delivery_request(p_request_id uuid)
returns uuid language plpgsql security definer set search_path=public
as $$
declare r public.delivery_requests; v_label text; v_actor text; v_product text;
begin
 if not public.is_admin() then raise exception 'Manager access required'; end if;
 select * into r from public.delivery_requests where id=p_request_id for update;
 if r.id is null then raise exception 'Delivery request not found'; end if;
 if r.warehouse_order_id is not null then raise exception 'Use manager order deletion for this request'; end if;
 select name into v_product from public.products where id=r.product_id;
 v_label := 'Legacy delivery request deleted | '||coalesce(v_product,'Product')||
   ' | Destination: '||coalesce(r.destination,'')||
   ' | Previous status: '||coalesce(r.status,'unknown')||
   ' | Request ID: '||r.id::text;
 v_actor := coalesce(auth.jwt()->>'email','Manager');
 update public.inventory_units u set status='available',updated_at=now()
 where u.id in (
   select d.unit_id from public.delivery_requests d
   where (r.batch_id is not null and d.batch_id=r.batch_id)
      or (r.batch_id is null and d.id=r.id)
 ) and u.status in ('reserved','out_for_delivery');
 insert into public.activity(product_id,action,product_name,actor_email)
 values(r.product_id,'deleted',left(v_label,500),v_actor);
 delete from public.notifications
 where reference_id=p_request_id or (r.batch_id is not null and reference_id=r.batch_id);
 delete from public.delivery_requests
 where (r.batch_id is not null and batch_id=r.batch_id) or (r.batch_id is null and id=r.id);
 return p_request_id;
end $$;
revoke all on function public.manager_delete_legacy_delivery_request(uuid) from public, anon;
grant execute on function public.manager_delete_legacy_delivery_request(uuid) to authenticated;
