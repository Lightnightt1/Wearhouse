# Warehouse — Inventory & Delivery

Static warehouse management app using Supabase.

## Included

- Public inventory catalog
- Admin product management
- Product image uploads
- Serialized physical inventory
- Delivery staff accounts
- Delivery request → admin approval → delivery note → completion workflow
- Notifications
- Realtime refresh
- Row Level Security (RLS)
- Private delivery-note storage

## 1. Configure Supabase

Edit `config.js` and keep your Supabase URL + publishable/anon key there.

## 2. Run the database setup

**Fresh database only:** In **Supabase → SQL Editor**, run these SQL files in order:

1. `schema.sql`
2. `persistence-safe.sql` (creates the atomic product+serial RPC and quantity sync trigger)
3. `inventory-read-fix.sql` (creates the inventory read RPC)

**Existing database:** **Do not rerun `schema.sql` to troubleshoot existing records.**
If the site cannot create products or load inventory and those functions have not been installed, run
`persistence-safe.sql` and `inventory-read-fix.sql` once. For an existing database with a rejection error,
run `fix-rejection.sql`. These patches do not delete inventory rows.

Create your admin user in **Authentication → Users**, then run:

```sql
insert into public.admin_users(user_id,email)
values ('YOUR_ADMIN_AUTH_UUID','admin@example.com')
on conflict (user_id) do update set email=excluded.email;

insert into public.profiles(id,full_name,email,role,active)
values ('YOUR_ADMIN_AUTH_UUID','Admin','admin@example.com','admin',true)
on conflict (id) do update set role='admin', active=true;
```

## 3. Deploy the delivery-user Edge Function

The function is included at:

`supabase/functions/create-delivery-user/index.ts`

With the Supabase CLI:

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase functions deploy create-delivery-user
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are available to deployed Supabase Edge Functions automatically.

## 4. Enable Realtime

In Supabase, enable Realtime replication for:

- `products`
- `activity`
- `inventory_units`
- `delivery_requests`
- `notifications`
- `profiles`

## Delivery flow

1. Admin adds products and serial numbers.
2. Admin creates a delivery account.
3. Delivery user signs in, goes to the warehouse, and types or scans the serial number on the physical item.
4. The site finds the product automatically from that serial; the delivery user does not choose the product manually.
5. Admin gives the first approval, reserving that exact serial.
6. After delivery, the delivery user uploads the delivery note.
7. Admin gives the final approval. Only then the serial becomes delivered and the product quantity decreases by one.
