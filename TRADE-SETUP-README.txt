WEARHOUSE on existing Supabase TRADE — 10 Nov 2026

DONE IN TRADE:
- Seven new warehouse tables, 0 warehouse records
- Warehouse RLS access policies, inventory + delivery RPCs, notification and stock triggers
- product-images public bucket and delivery-notes private bucket
- create-delivery-user Edge Function deployed
- config.js linked to Trade project; isolated local browser auth storage
- Existing Trade tables trade_entries, planner_items, studyglass_reminder_logs were not modified.

STILL NEEDED:
1. Set up a warehouse administrator in Supabase Trade -> Authentication -> Users.
   Use a user account you explicitly choose. DO NOT blindly select a Trade user.
   Copy its UUID and email and run the following in Trade SQL Editor after replacing placeholders:
   insert into public.admin_users(user_id,email)
   values ('YOUR_USER_UUID','YOUR_EMAIL') on conflict(user_id) do update set email=excluded.email;
   insert into public.profiles(id,full_name,email,role,active)
   values ('YOUR_USER_UUID','Warehouse Admin','YOUR_EMAIL','admin',true)
   on conflict(id) do update set role='admin',active=true;
   Security note: ensure YOUR_USER_UUID is indeed an account you control.
2. Upload updated index.html, app.js, styles.css, config.js to GitHub Pages.
3. Realtime has been enabled for the six warehouse tables already.
4. Test login, add product+serial, staff creation, delivery request/approval, and upload.

Important: These two apps now share Supabase Authentication project-wide.
Do not run schema.sql, persistence-safe.sql, or other legacy setup files on Trade.
Do not expose the service role/secret key in the browser.
No inventory from the previous paused Wearhouse Supabase project has been migrated.
