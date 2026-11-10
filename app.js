const C = window.WAREHOUSE_CONFIG || {};

const configured =
  /^https:\/\//i.test(C.SUPABASE_URL || '') &&
  !!C.SUPABASE_ANON_KEY &&
  !String(C.SUPABASE_URL).includes('PASTE') &&
  !String(C.SUPABASE_ANON_KEY).includes('PASTE');

const sb = configured && window.supabase
  ? supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY, {auth: {storageKey: "wearhouse-trade-auth-v1"}})
  : null;

let products = [];
let activities = [];
let profiles = [];
let serials = [];
let deliveryRequests = [];
let notifications = [];
let user = null;
let profile = null;
let isAdmin = false;
let currentPage = 'dashboard';
let realtimeChannel = null;
let realtimeTimer = null;

const $ = id => document.getElementById(id);
const view = $('view');
const fallback = 'https://images.unsplash.com/photo-1497366754035-f200968a6e72?auto=format&fit=crop&w=1000&q=85';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
}[c]));

const safeImg = value => value && /^https?:\/\//i.test(value) ? value : fallback;
const isDelivery = () => !!user && !isAdmin && !!profile && profile?.active !== false;
const isStaff = () => isAdmin || isDelivery();

function toast(message, kind = '') {
  const el = $('toast');
  if (!el) return;
  el.textContent = message;
  el.className = `toast show ${kind}`;
  clearTimeout(window.__toast);
  window.__toast = setTimeout(() => { el.className = 'toast'; }, 3200);
}

function busy(btn, on, label = 'Saving…') {
  if (!btn) return;
  btn.disabled = on;
  if (on) {
    btn.dataset.old = btn.textContent;
    btn.textContent = label;
  } else {
    btn.textContent = btn.dataset.old || btn.textContent;
  }
}

function setConnection(ok) {
  $('liveDot')?.classList.toggle('offline', !ok);
  if ($('statusText')) $('statusText').textContent = ok ? 'Live' : 'Connecting';
}

function getDateValue(obj) {
  const value = obj?.created_at || obj?.createdAt || obj?.timestamp || obj?.inserted_at || obj?.updated_at || obj?.updatedAt;
  const n = value ? new Date(value).getTime() : 0;
  return Number.isNaN(n) ? 0 : n;
}

function timeAgo(value) {
  const timestamp = typeof value === 'number' ? value : new Date(value || 0).getTime();
  if (!timestamp) return '—';
  const seconds = Math.max(1, (Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${Math.round(seconds)}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

function empty(title, sub) {
  return `<div class="empty"><strong>${esc(title)}</strong><span>${esc(sub)}</span></div>`;
}

function statusLabel(status) {
  return ({
    pending_admin_approval: 'Pending approval',
    approved_for_delivery: 'Approved',
    delivery_note_submitted: 'Note submitted',
    completed: 'Completed',
    rejected: 'Rejected',
    available: 'Available',
    reserved: 'Reserved',
    out_for_delivery: 'Out for delivery',
    delivered: 'Delivered'
  })[status] || status || 'Unknown';
}

function parseProductSerials() {
  const raw = $('pSerials')?.value || '';
  return [...new Set(raw.split(/[\n,;]+/).map(x => x.trim()).filter(Boolean))];
}

function syncProductQuantityFromSerials() {
  if ($('productId')?.value) return;
  if ($('pQty')) $('pQty').value = String(parseProductSerials().length);
}

async function boot() {
  if (!sb) return renderSetup();

  try {
    const { data } = await sb.auth.getSession();
    user = data?.session?.user || null;
    await refreshAuth();
    await loadAll();
    if (isDelivery()) currentPage = 'deliveries';
    subscribeRealtime();
    setConnection(true);
    render();
  } catch (err) {
    console.error(err);
    setConnection(false);
    toast(err.message || 'Connection failed', 'error');
  }

  // Supabase auth callbacks must stay synchronous. Calling Supabase APIs while
  // the auth event is being processed can deadlock the client.
  sb.auth.onAuthStateChange((event, session) => {
    const nextUser = session?.user || null;
    setTimeout(async () => {
      try {
        user = nextUser;
        await refreshAuth();
        await loadAll();
        if (isDelivery()) currentPage = 'deliveries';
        subscribeRealtime();
        if (!user && ['deliveries', 'users', 'serials', 'notifications'].includes(currentPage)) currentPage = 'dashboard';
        render();
      } catch (err) {
        console.error('Auth refresh failed:', err);
        toast(err.message || 'Could not refresh your session.', 'error');
      }
    }, 0);
  });
}

async function refreshAuth() {
  isAdmin = false;
  profile = null;
  if (!user || !sb) {
    updateAuth();
    return;
  }

  const [adminRow, profileRow] = await Promise.all([
    sb.from('admin_users').select('user_id').eq('user_id', user.id).maybeSingle(),
    sb.from('profiles').select('*').eq('id', user.id).maybeSingle()
  ]);

  isAdmin = !adminRow.error && !!adminRow.data;
  profile = profileRow.error ? null : profileRow.data;
  if (profile?.role === 'admin') isAdmin = true;
  updateAuth();
}

function updateAuth() {
  const name = profile?.full_name || user?.email || 'Warehouse';
  if ($('hello')) {
    $('hello').textContent = !user
      ? 'Public inventory'
      : isAdmin
        ? `Admin · ${name}`
        : isDelivery()
          ? `Warehouse staff · ${name}`
          : `Signed in · ${name}`;
  }
  if ($('avatar')) $('avatar').textContent = String(name).slice(0, 1).toUpperCase();
  $('logout')?.classList.toggle('hidden', !user);

  document.querySelectorAll('.admin-only').forEach(el => el.classList.toggle('hidden', !isAdmin));
  document.querySelectorAll('.delivery-only').forEach(el => el.classList.toggle('hidden', !isDelivery()));
  document.querySelectorAll('.staff-only').forEach(el => el.classList.toggle('hidden', !isStaff()));

  const notificationBtn = $('notificationsBtn');
  notificationBtn?.classList.toggle('hidden', !user);
  const unread = notifications.filter(n => !n.read_at).length;
  const badge = $('notificationBadge');
  if (badge) {
    badge.textContent = unread > 99 ? '99+' : String(unread);
    badge.classList.toggle('hidden', unread === 0);
  }
}

async function loadAll() {
  if (!sb) return;

  // Products are loaded through a read-only RPC first. This keeps the public
  // Inventory visible even if an older RLS policy is still present in Supabase.
  // It does not create, delete or reset any inventory data.
  let p = await sb.rpc('warehouse_inventory_products');
  if (p.error) {
    console.warn('Inventory RPC fallback:', p.error);
    p = await sb.from('products').select('*').order('created_at', { ascending: false });
  }

  const a = await sb.from('activity').select('*').order('created_at', { ascending: false }).limit(60);

  if (!p.error) {
    products = (p.data || []).sort((x, y) => getDateValue(y) - getDateValue(x));
  } else {
    console.error('Products:', p.error);
    products = [];
    toast(`Inventory could not load: ${p.error.message || 'read error'}`, 'error');
  }

  if (!a.error) activities = a.data || [];
  else console.warn('Activity:', a.error);

  profiles = [];
  serials = [];
  deliveryRequests = [];
  notifications = [];

  if (!user) {
    updateAuth();
    return;
  }

  const notificationQuery = sb.from('notifications')
    .select('*')
    .eq('recipient_id', user.id)
    .order('created_at', { ascending: false })
    .limit(50);

  if (isAdmin) {
    const [pr, sr, dr, nt] = await Promise.all([
      sb.from('profiles').select('*').eq('role', 'delivery_guy').order('created_at', { ascending: false }),
      sb.from('inventory_units').select('*, products(name, location, image_url)').order('created_at', { ascending: false }),
      sb.from('delivery_requests').select('*, products(name, location, image_url), inventory_units(serial_number, status)').order('created_at', { ascending: false }),
      notificationQuery
    ]);
    if (!pr.error) profiles = pr.data || []; else console.warn('Profiles:', pr.error);
    if (!sr.error) serials = sr.data || []; else console.warn('Serials:', sr.error);
    if (!dr.error) deliveryRequests = dr.data || []; else console.warn('Deliveries:', dr.error);
    if (!nt.error) notifications = nt.data || [];
  } else if (isDelivery()) {
    const [sr, dr, nt] = await Promise.all([
      sb.from('inventory_units').select('*, products(name, location, image_url)').order('created_at', { ascending: false }),
      sb.from('delivery_requests').select('*, products(name, location, image_url), inventory_units(serial_number, status)').eq('delivery_guy_id', user.id).order('created_at', { ascending: false }),
      notificationQuery
    ]);
    if (!sr.error) serials = sr.data || []; else console.warn('Serials:', sr.error);
    if (!dr.error) deliveryRequests = dr.data || []; else console.warn('Deliveries:', dr.error);
    if (!nt.error) notifications = nt.data || [];
  } else {
    const nt = await notificationQuery;
    if (!nt.error) notifications = nt.data || [];
  }

  updateAuth();
}

function subscribeRealtime() {
  if (!sb) return;
  if (realtimeChannel) sb.removeChannel(realtimeChannel);

  const refresh = () => {
    clearTimeout(realtimeTimer);
    realtimeTimer = setTimeout(async () => {
      await refreshAuth();
      await loadAll();
      render();
    }, 220);
  };

  realtimeChannel = sb.channel(`warehouse-live-${user?.id || 'public'}`);
  ['products', 'activity', 'inventory_units', 'delivery_requests', 'notifications', 'profiles'].forEach(table => {
    realtimeChannel.on('postgres_changes', { event: '*', schema: 'public', table }, refresh);
  });
  realtimeChannel.subscribe(status => setConnection(status === 'SUBSCRIBED'));
}

function renderSetup() {
  view.innerHTML = `<section class="hero setup"><span class="eyebrow">ONE-TIME CONNECTION</span><h1>Your warehouse.<br><em>Live.</em></h1><p>Add your Supabase URL and publishable key in <b>config.js</b>, then run <b>schema.sql</b>.</p></section>`;
}

function render() {
  document.querySelectorAll('.sidebar nav button').forEach(btn => btn.classList.toggle('active', btn.dataset.page === currentPage));
  updateAuth();

  if (!isAdmin && ['users', 'serials'].includes(currentPage)) currentPage = 'dashboard';
  if (!isStaff() && currentPage === 'deliveries') currentPage = 'admin';
  if (!user && currentPage === 'notifications') currentPage = 'dashboard';

  if (currentPage === 'dashboard') dashboard();
  else if (currentPage === 'inventory') inventory();
  else if (currentPage === 'activity') activity();
  else if (currentPage === 'admin') admin();
  else if (currentPage === 'users') adminUsers();
  else if (currentPage === 'serials') serialManager();
  else if (currentPage === 'deliveries') deliveries();
  else if (currentPage === 'notifications') notificationsPage();
}

function dashboard() {
  const total = products.reduce((n, p) => n + Number(p.quantity || 0), 0);
  const low = products.filter(p => Number(p.quantity || 0) <= 7).length;
  const locs = new Set(products.map(p => p.location).filter(Boolean)).size;
  const cats = new Set(products.map(p => p.category).filter(Boolean)).size;
  const pending = deliveryRequests.filter(r => r.status === 'pending_admin_approval').length;
  const active = deliveryRequests.filter(r => ['approved_for_delivery', 'delivery_note_submitted'].includes(r.status)).length;

  const action = isAdmin
    ? `<button class="ghost" onclick="go('admin')">Open control center</button>`
    : isDelivery()
      ? `<button class="ghost" onclick="go('deliveries')">My deliveries</button>`
      : `<button class="ghost" onclick="loginDialog.showModal()">Staff sign in</button>`;

  view.innerHTML = `
    <section class="hero">
      <span class="eyebrow">WAREHOUSE · LIVE OVERVIEW</span>
      <h1>Everything<br><em>in one place.</em></h1>
      <p>Live inventory, serialized stock and controlled delivery handover in one system.</p>
      <div class="hero-actions"><button class="primary" onclick="go('inventory')">Browse inventory <span>→</span></button>${action}</div>
    </section>
    <section class="stats">
      <div class="stat glass"><small>Total units</small><b>${total.toLocaleString()}</b><span>all stock combined</span></div>
      <div class="stat glass"><small>Products</small><b>${products.length}</b><span>unique items</span></div>
      <div class="stat glass"><small>Low stock</small><b>${low}</b><span>${low ? 'needs attention' : 'everything healthy'}</span></div>
      <div class="stat glass"><small>${isStaff() ? 'Active deliveries' : 'Locations'}</small><b>${isStaff() ? active + pending : locs}</b><span>${isStaff() ? `${pending} waiting approval` : `${cats} categories`}</span></div>
    </section>
    <section class="content">
      <div class="panel glass">
        <div class="head"><div><small class="section-label">LATEST</small><h2>Recently added</h2></div><button class="textbtn" onclick="go('inventory')">View all →</button></div>
        ${products.slice(0, 6).map(itemRow).join('') || empty('No products yet', 'Your first item will appear here.')}
      </div>
      <div class="panel glass">
        <div class="head"><div><small class="section-label">STOCK HEALTH</small><h2>Needs attention</h2></div><span class="pill">${low ? low + ' low' : 'All good'}</span></div>
        <div class="health">${products.filter(p => Number(p.quantity || 0) <= 7).slice(0, 6).map(p => `<div class="health-row"><span class="health-dot"></span><div><b>${esc(p.name)}</b><small>${Number(p.quantity || 0)} units · ${esc(p.location)}</small></div></div>`).join('') || `<div class="healthy"><span>✓</span><div><b>Everything looks good</b><small>No item is at or below 7 units.</small></div></div>`}</div>
      </div>
    </section>`;
}

function itemRow(p) {
  return `<div class="item"><img class="thumb" src="${safeImg(p.image_url)}" onerror="this.src='${fallback}'"><div class="itemmain"><b>${esc(p.name)}</b><span>${esc(p.category)} · ${esc(p.location)}</span></div><strong>${Number(p.quantity || 0)} pcs</strong><span class="badge ${Number(p.quantity || 0) <= 7 ? 'low' : ''}">${Number(p.quantity || 0) <= 7 ? 'Low' : 'In stock'}</span></div>`;
}

function inventory() {
  const cats = [...new Set(products.map(p => p.category).filter(Boolean))].sort();
  const locs = [...new Set(products.map(p => p.location).filter(Boolean))].sort();
  view.innerHTML = `
    <section class="hero compact"><span class="eyebrow">LIVE INVENTORY</span><h1>What we<br><em>have.</em></h1><p>Search current warehouse stock by product, category or location.</p></section>
    <section class="panel glass inventory-panel">
      <div class="head wrap"><div><small class="section-label">CATALOG</small><h2>All items <span class="muted">${products.length} products</span></h2></div>
      <div class="filters"><input id="filter" class="search" placeholder="Search inventory…"><select id="catFilter"><option value="">All categories</option>${cats.map(x => `<option value="${esc(x)}">${esc(x)}</option>`).join('')}</select><select id="locFilter"><option value="">All locations</option>${locs.map(x => `<option value="${esc(x)}">${esc(x)}</option>`).join('')}</select></div></div>
      <div id="cards" class="cards">${cards(products)}</div>
    </section>`;

  const apply = () => {
    const q = ($('filter')?.value || '').toLowerCase();
    const c = $('catFilter')?.value || '';
    const l = $('locFilter')?.value || '';
    const filtered = products.filter(p => `${p.name || ''} ${p.description || ''} ${p.category || ''} ${p.location || ''}`.toLowerCase().includes(q) && (!c || p.category === c) && (!l || p.location === l));
    $('cards').innerHTML = cards(filtered);
  };
  $('filter').oninput = apply;
  $('catFilter').onchange = apply;
  $('locFilter').onchange = apply;
}

function cards(arr) {
  return arr.map(p => {
    const availableSerials = serials.filter(s => s.product_id === p.id && s.status === 'available').length;
    return `<article class="product glass"><div class="imgwrap"><img loading="lazy" src="${safeImg(p.image_url)}" onerror="this.src='${fallback}'"><span class="stock-dot ${Number(p.quantity || 0) <= 7 ? 'warn' : ''}"></span><span class="image-label">${esc(p.category || 'General')}</span></div><div class="body"><div class="product-meta"><span>${esc(p.location)}</span><span>${Number(p.quantity || 0)} pcs</span></div><h3>${esc(p.name)}</h3><p>${esc(p.description || 'No description provided.')}</p><div class="foot"><b>${Number(p.price || 0) > 0 ? Number(p.price).toFixed(2) + ' OMR' : 'Price on request'}</b><span class="badge ${Number(p.quantity || 0) <= 7 ? 'low' : ''}">${Number(p.quantity || 0) <= 7 ? 'Low stock' : 'Available'}</span></div>
      ${isAdmin ? `<div class="actions"><button class="smallbtn" onclick="editProduct('${p.id}')">✎ Edit item</button><button class="smallbtn danger" onclick="deleteProduct('${p.id}')">× Delete item</button></div>` : ''}
      ${isDelivery() ? `<div class="actions"><button class="smallbtn" onclick="go('deliveries')">⇢ Enter serial in Deliveries</button></div>` : ''}
    </div></article>`;
  }).join('') || empty('No products found', 'Try another search or filter.');
}

function activity() {
  view.innerHTML = `<section class="hero compact"><span class="eyebrow">AUDIT TRAIL</span><h1>Warehouse<br><em>history.</em></h1><p>Every product change is recorded automatically.</p></section><section class="panel glass"><div class="head"><div><small class="section-label">RECENT EVENTS</small><h2>Activity</h2></div><span class="pill">${activities.length} events</span></div><div class="timeline">${activities.map(a => {
    const icon = a.action === 'created' ? '+' : a.action === 'deleted' ? '×' : '↻';
    return `<div class="timeline-row"><div class="timeline-icon">${icon}</div><div><b>${esc(a.product_name || 'Product')}</b><p>${esc(a.action || 'updated')}${a.actor_email ? ` · ${esc(a.actor_email)}` : ''}</p></div><time>${timeAgo(getDateValue(a))}</time></div>`;
  }).join('') || empty('No activity yet', 'Changes will appear here automatically.')}</div></section>`;
}

function admin() {
  if (!isAdmin) {
    if (isDelivery()) {
      view.innerHTML = `<section class="hero"><span class="eyebrow">DELIVERY ACCOUNT</span><h1>Your<br><em>workspace.</em></h1><p>You are signed in as a delivery user. Create and track delivery requests from your delivery dashboard.</p><button class="primary" onclick="go('deliveries')">Open deliveries →</button></section>`;
      return;
    }
    if (user) {
      view.innerHTML = `<section class="hero"><span class="eyebrow">PRIVATE AREA</span><h1>Not<br><em>authorized.</em></h1><p>This account is not an active warehouse staff account.</p><button class="ghost" onclick="document.getElementById('logout').click()">Sign out</button></section>`;
      return;
    }
    view.innerHTML = `<section class="hero"><span class="eyebrow">STAFF AREA</span><h1>Warehouse<br><em>access.</em></h1><p>Administrators and delivery staff can sign in here.</p><button class="primary" onclick="loginDialog.showModal()">Sign in <span>→</span></button></section>`;
    return;
  }

  const pending = deliveryRequests.filter(r => r.status === 'pending_admin_approval').length;
  const noteReady = deliveryRequests.filter(r => r.status === 'delivery_note_submitted').length;
  view.innerHTML = `
    <section class="hero compact"><span class="eyebrow">ADMIN · ${esc(user.email || '')}</span><h1>Control the<br><em>warehouse.</em></h1><p>Manage inventory, serialized units, delivery staff and delivery approvals.</p><div class="hero-actions"><button class="primary" onclick="openAdd()">＋ Add item</button><button class="ghost" onclick="go('deliveries')">Deliveries ${pending + noteReady ? `· ${pending + noteReady}` : ''} →</button><button class="ghost" onclick="go('serials')">Serials →</button></div></section>
    <section class="panel glass"><div class="head"><div><small class="section-label">MANAGEMENT</small><h2>Inventory</h2></div><span class="pill">${products.length} items</span></div>${products.map(p => `<div class="item admin-row"><img class="thumb" src="${safeImg(p.image_url)}" onerror="this.src='${fallback}'"><div class="itemmain"><b>${esc(p.name)}</b><span>${Number(p.quantity || 0)} pcs · ${esc(p.location)} · ${esc(p.category)}</span></div><button class="smallbtn" onclick="editProduct('${p.id}')">✎ Edit</button><button class="smallbtn danger" onclick="deleteProduct('${p.id}')">× Delete</button></div>`).join('') || empty('No items yet', 'Add your first item above.')}</section>`;
}

function adminUsers() {
  if (!isAdmin) return admin();
  view.innerHTML = `<section class="hero compact"><span class="eyebrow">ADMIN · TEAM</span><h1>Delivery<br><em>accounts.</em></h1><p>Create and control delivery accounts.</p><div class="hero-actions"><button class="primary" onclick="deliveryUserDialog.showModal()">＋ Add delivery guy</button></div></section><section class="panel glass"><div class="head"><div><small class="section-label">DELIVERY TEAM</small><h2>Delivery guys</h2></div><span class="pill">${profiles.length} accounts</span></div>${profiles.map(p => `<div class="item admin-row"><div class="avatar small-avatar">${esc((p.full_name || p.email || 'D').slice(0, 1).toUpperCase())}</div><div class="itemmain"><b>${esc(p.full_name || 'Unnamed')}</b><span>${esc(p.email || 'No email saved')} · ${p.active === false ? 'Disabled' : 'Active'}</span></div><button class="smallbtn ${p.active === false ? '' : 'danger'}" onclick="setDeliveryUserActive('${p.id}', ${p.active === false})">${p.active === false ? 'Enable' : 'Disable'}</button></div>`).join('') || empty('No delivery accounts yet', 'Create your first delivery guy above.')}</section>`;
}

function serialManager() {
  if (!isAdmin) return admin();
  const available = serials.filter(s => s.status === 'available').length;
  const reserved = serials.filter(s => ['reserved', 'out_for_delivery'].includes(s.status)).length;
  const delivered = serials.filter(s => s.status === 'delivered').length;
  view.innerHTML = `<section class="hero compact"><span class="eyebrow">ADMIN · PHYSICAL STOCK</span><h1>Serial<br><em>manager.</em></h1><p>Track the exact physical unit used in every delivery.</p><div class="hero-actions"><button class="primary" onclick="openSerialDialog()">＋ Add serial</button></div></section><section class="stats"><div class="stat glass"><small>Total serials</small><b>${serials.length}</b><span>physical units</span></div><div class="stat glass"><small>Available</small><b>${available}</b><span>ready</span></div><div class="stat glass"><small>Reserved / out</small><b>${reserved}</b><span>active delivery</span></div><div class="stat glass"><small>Delivered</small><b>${delivered}</b><span>completed units</span></div></section><section class="panel glass"><div class="head wrap"><div><small class="section-label">SERIAL INVENTORY</small><h2>Physical units</h2></div><div class="filters"><input id="serialFilter" class="search" placeholder="Search serial or product…"><select id="serialStatus"><option value="">All statuses</option><option value="available">Available</option><option value="reserved">Reserved</option><option value="out_for_delivery">Out for delivery</option><option value="delivered">Delivered</option></select></div></div><div id="serialList">${serialRows(serials)}</div></section>`;
  const apply = () => {
    const q = ($('serialFilter')?.value || '').toLowerCase();
    const s = $('serialStatus')?.value || '';
    const filtered = serials.filter(x => `${x.serial_number || ''} ${x.products?.name || ''}`.toLowerCase().includes(q) && (!s || x.status === s));
    $('serialList').innerHTML = serialRows(filtered);
  };
  $('serialFilter').oninput = apply;
  $('serialStatus').onchange = apply;
}

function serialRows(arr) {
  return arr.map(s => `<div class="item admin-row"><div class="serial-icon">№</div><div class="itemmain"><b>${esc(s.serial_number)}</b><span>${esc(s.products?.name || 'Unknown product')} · ${esc(statusLabel(s.status))}</span></div>${s.status === 'available' ? `<button class="smallbtn danger" onclick="deleteSerial('${s.id}')">Delete</button>` : `<span class="pill">${esc(statusLabel(s.status))}</span>`}</div>`).join('') || empty('No serials found', 'Add or change your filter.');
}

function deliveryGroups() {
  const groups = new Map();
  for (const request of deliveryRequests) {
    const key = request.batch_id || request.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(request);
  }
  return [...groups.values()];
}

function deliveries() {
  if (!isStaff()) return admin();
  const groups = deliveryGroups();
  const pending = groups.filter(g => g[0].status === 'pending_admin_approval').length;
  const approved = groups.filter(g => g[0].status === 'approved_for_delivery').length;
  const noteReady = groups.filter(g => g[0].status === 'delivery_note_submitted').length;
  const completed = groups.filter(g => g[0].status === 'completed').length;

  view.innerHTML = `
    <section class="hero compact"><span class="eyebrow">${isAdmin ? 'ADMIN · DELIVERY CONTROL' : 'DELIVERY WORKSPACE'}</span><h1>${isAdmin ? 'Delivery' : 'My delivery'}<br><em>workflow.</em></h1><p>${isAdmin ? 'Create requests, assign a delivery employee and review completed handovers.' : 'Your assigned deliveries appear here. After delivery, upload the delivery note for manager approval.'}</p>${isAdmin ? `<div class="hero-actions"><button class="primary" onclick="openDeliveryAssignment()">＋ New delivery request</button></div>` : ''}</section>
    <section class="stats"><div class="stat glass"><small>Pending</small><b>${pending}</b><span>older requests awaiting approval</span></div><div class="stat glass"><small>Assigned</small><b>${approved}</b><span>ready for driver</span></div><div class="stat glass"><small>Notes ready</small><b>${noteReady}</b><span>waiting review</span></div><div class="stat glass"><small>Completed</small><b>${completed}</b><span>finished</span></div></section>
    <section class="panel glass delivery-list"><div class="head"><div><small class="section-label">${isAdmin ? 'ALL REQUESTS' : 'YOUR ASSIGNMENTS'}</small><h2>Deliveries</h2></div><span class="pill">${groups.length}</span></div>${groups.map(g => g[0].batch_id ? deliveryBatchCard(g) : deliveryCard(g[0])).join('') || empty('No delivery requests', isAdmin ? 'Select New delivery request to assign your first delivery.' : 'Assigned deliveries will appear here after a manager creates them.')}</section>`;
}

function deliveryBatchCard(rows) {
  const r = rows[0];
  const employee = profiles.find(p => p.id === r.delivery_guy_id);
  const serialNames = rows.map(x => x.inventory_units?.serial_number || serials.find(s => s.id === x.unit_id)?.serial_number || '—');
  const batchId = r.batch_id;
  let actions = '';
  if (isAdmin) {
    if (r.status === 'approved_for_delivery') actions = `<button class="smallbtn danger" onclick="cancelDeliveryBatch('${batchId}')">Cancel request</button>`;
    else if (r.status === 'delivery_note_submitted') actions = `<button class="smallbtn" onclick="viewBatchDeliveryNote('${batchId}')">View note</button><button class="smallbtn" onclick="completeDeliveryBatch('${batchId}')">✓ Confirm delivery & deduct stock</button><button class="smallbtn danger" onclick="cancelDeliveryBatch('${batchId}')">Cancel</button>`;
    else if (r.delivery_note_url) actions = `<button class="smallbtn" onclick="viewBatchDeliveryNote('${batchId}')">View note</button>`;
  } else if (isDelivery() && r.status === 'approved_for_delivery') {
    actions = `<button class="smallbtn" onclick="openBatchDeliveryNote('${batchId}')">Upload delivery note</button>`;
  } else if (isDelivery() && r.delivery_note_url) {
    actions = `<button class="smallbtn" onclick="viewBatchDeliveryNote('${batchId}')">View note</button>`;
  }
  return `<article class="delivery-card glass"><div class="delivery-top"><div><small class="section-label">${esc(r.products?.name || 'Product')}</small><h3>${rows.length} unit${rows.length === 1 ? '' : 's'} · Delivery request</h3></div><span class="delivery-status ${esc(r.status)}">${esc(statusLabel(r.status))}</span></div><div class="delivery-grid">${isAdmin ? `<div><small>Assigned employee</small><b>${esc(employee?.full_name || employee?.email || r.delivery_guy_id)}</b></div>` : ''}<div><small>Quantity</small><b>${rows.length}</b></div><div><small>Destination</small><b>${esc(r.destination)}</b></div><div><small>Recipient</small><b>${esc(r.recipient || '—')}</b></div><div><small>Delivery date</small><b>${esc(r.delivery_date)}</b></div><div><small>Warehouse</small><b>${esc(r.products?.location || '—')}</b></div><div><small>Created</small><b>${timeAgo(r.created_at)}</b></div></div><p class="delivery-copy"><b>Serial numbers:</b> ${serialNames.map(esc).join(', ')}</p>${r.notes ? `<p class="delivery-copy"><b>Instructions:</b> ${esc(r.notes)}</p>` : ''}${r.delivery_note_number ? `<p class="delivery-copy"><b>Delivery note:</b> ${esc(r.delivery_note_number)}${r.driver_notes ? ` · ${esc(r.driver_notes)}` : ''}</p>` : ''}${r.rejection_reason ? `<p class="delivery-copy rejected-copy"><b>Cancelled:</b> ${esc(r.rejection_reason)}</p>` : ''}${actions ? `<div class="delivery-actions">${actions}</div>` : ''}</article>`;
}

function deliveryCard(r) {
  const driver = profiles.find(p => p.id === r.delivery_guy_id);
  const serial = r.inventory_units?.serial_number || serials.find(s => s.id === r.unit_id)?.serial_number || '—';
  let actions = '';
  if (isAdmin) {
    if (r.status === 'pending_admin_approval') actions = `<button class="smallbtn" onclick="approveDelivery('${r.id}')">✓ Approve old request</button><button class="smallbtn danger" onclick="rejectDelivery('${r.id}')">Reject</button>`;
    else if (r.status === 'approved_for_delivery') actions = `<button class="smallbtn danger" onclick="rejectDelivery('${r.id}')">Cancel request</button>`;
    else if (r.status === 'delivery_note_submitted') actions = `<button class="smallbtn" onclick="viewDeliveryNote('${r.id}')">View note</button><button class="smallbtn" onclick="completeDelivery('${r.id}')">✓ Confirm delivery</button><button class="smallbtn danger" onclick="rejectDelivery('${r.id}')">Reject</button>`;
    else if (r.delivery_note_url) actions = `<button class="smallbtn" onclick="viewDeliveryNote('${r.id}')">View note</button>`;
  } else if (isDelivery() && r.status === 'approved_for_delivery') {
    actions = `<button class="smallbtn" onclick="openDeliveryNote('${r.id}')">Upload delivery note</button>`;
  } else if (isDelivery() && r.delivery_note_url) {
    actions = `<button class="smallbtn" onclick="viewDeliveryNote('${r.id}')">View note</button>`;
  }

  return `<article class="delivery-card glass"><div class="delivery-top"><div><small class="section-label">${esc(r.products?.name || 'Product')}</small><h3>${esc(serial)}</h3></div><span class="delivery-status ${esc(r.status)}">${esc(statusLabel(r.status))}</span></div><div class="delivery-grid">${isAdmin ? `<div><small>Delivery employee</small><b>${esc(driver?.full_name || driver?.email || r.delivery_guy_id)}</b></div>` : ''}<div><small>Destination</small><b>${esc(r.destination)}</b></div><div><small>Recipient</small><b>${esc(r.recipient || '—')}</b></div><div><small>Delivery date</small><b>${esc(r.delivery_date)}</b></div><div><small>Warehouse</small><b>${esc(r.products?.location || '—')}</b></div><div><small>Created</small><b>${timeAgo(r.created_at)}</b></div></div>${r.notes ? `<p class="delivery-copy"><b>Instructions:</b> ${esc(r.notes)}</p>` : ''}${r.delivery_note_number ? `<p class="delivery-copy"><b>Delivery note:</b> ${esc(r.delivery_note_number)}${r.driver_notes ? ` · ${esc(r.driver_notes)}` : ''}</p>` : ''}${r.rejection_reason ? `<p class="delivery-copy rejected-copy"><b>Rejected:</b> ${esc(r.rejection_reason)}</p>` : ''}${actions ? `<div class="delivery-actions">${actions}</div>` : ''}</article>`;
}

function notificationsPage() {
  if (!user) return go('dashboard');
  view.innerHTML = `<section class="hero compact"><span class="eyebrow">STAFF · ALERTS</span><h1>Notifications<br><em>& updates.</em></h1><p>Delivery approvals, new requests and completed handovers appear here.</p><div class="hero-actions"><button class="ghost" onclick="markAllNotificationsRead()">Mark all as read</button></div></section><section class="panel glass"><div class="head"><div><small class="section-label">LATEST</small><h2>Notifications</h2></div><span class="pill">${notifications.filter(n => !n.read_at).length} unread</span></div>${notifications.map(n => `<button class="notification-row notification-button ${n.read_at ? '' : 'unread'}" onclick="openNotification('${n.id}', '${n.reference_id || ''}')"><b>${esc(n.title)}</b><span>${esc(n.body)}</span><time>${timeAgo(n.created_at)}</time></button>`).join('') || empty('No notifications', 'New delivery updates will appear here.')}</section>`;
}

function go(page) {
  currentPage = page;
  render();
}

function openAdd() {
  if (!isAdmin) return loginDialog.showModal();
  $('productForm').reset();
  $('productId').value = '';
  $('formTitle').textContent = 'Add item + serials';
  $('formMsg').textContent = '';
  if ($('pQty')) $('pQty').value = '0';
  if ($('pSerialsLabel')) $('pSerialsLabel').classList.remove('hidden');
  if ($('pSerials')) {
    $('pSerials').value = '';
    $('pSerials').required = true;
  }
  $('imagePreview').classList.add('hidden');
  productDialog.showModal();
}

function editProduct(id) {
  const p = products.find(x => x.id === id);
  if (!p || !isAdmin) return;
  $('productId').value = p.id;
  $('pName').value = p.name || '';
  $('pDesc').value = p.description || '';
  $('pQty').value = p.quantity ?? 0;
  if ($('pSerialsLabel')) $('pSerialsLabel').classList.add('hidden');
  if ($('pSerials')) {
    $('pSerials').value = '';
    $('pSerials').required = false;
  }
  $('pLoc').value = p.location || '';
  $('pCat').value = p.category || 'General';
  $('pPrice').value = p.price ?? 0;
  $('pImage').value = p.image_url || '';
  $('pImageFile').value = '';
  $('formTitle').textContent = 'Edit item';
  $('formMsg').textContent = '';
  preview(p.image_url);
  productDialog.showModal();
}

function preview(url) {
  const el = $('imagePreview');
  if (!url) return el.classList.add('hidden');
  el.innerHTML = `<img src="${safeImg(url)}" onerror="this.src='${fallback}'"><span>Image preview</span>`;
  el.classList.remove('hidden');
}

async function uploadImage(file) {
  if (!file) return '';
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw Error('Choose PNG, JPG, WEBP or GIF.');
  if (file.size > 5 * 1024 * 1024) throw Error('Image is larger than 5 MB.');
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const path = `${user.id}/${crypto.randomUUID()}.${ext}`;
  const { error } = await sb.storage.from(C.STORAGE_BUCKET || 'product-images').upload(path, file, { contentType: file.type });
  if (error) throw error;
  return sb.storage.from(C.STORAGE_BUCKET || 'product-images').getPublicUrl(path).data.publicUrl;
}

async function deleteProduct(id) {
  if (!isAdmin || !confirm('Delete this item?')) return;
  const { error } = await sb.from('products').delete().eq('id', id);
  if (error) return toast(error.message, 'error');
  toast('Item deleted');
  await loadAll();
  render();
}

async function createDeliveryUser(e) {
  e?.preventDefault();
  if (!isAdmin) return;
  const btn = $('createDeliveryUserBtn');
  const msg = $('deliveryUserMsg');
  const full_name = $('duName')?.value.trim();
  const email = $('duEmail')?.value.trim().toLowerCase();
  const password = $('duPassword')?.value;
  if (!full_name || !email || !password) return;
  if (password.length < 8) return msg.textContent = 'Password must be at least 8 characters.';
  busy(btn, true, 'Creating…');
  msg.textContent = '';
  try {
    const { data, error } = await sb.functions.invoke('create-delivery-user', { body: { full_name, email, password } });
    if (error) throw error;
    if (!data?.ok) throw Error(data?.error || 'Could not create account.');
    deliveryUserDialog.close();
    $('deliveryUserForm').reset();
    toast('Delivery account created.');
    await loadAll();
    render();
  } catch (err) {
    console.error(err);
    msg.textContent = err.message || 'Could not create account.';
  } finally {
    busy(btn, false);
  }
}

async function setDeliveryUserActive(id, active) {
  if (!isAdmin || !id) return;
  const { error } = await sb.from('profiles').update({ active }).eq('id', id).eq('role', 'delivery_guy');
  if (error) return toast(error.message, 'error');
  toast(active ? 'Delivery account enabled.' : 'Delivery account disabled.');
  await loadAll();
  render();
}

function openSerialDialog() {
  if (!isAdmin) return;
  $('serialProduct').innerHTML = products.map(p => `<option value="${esc(p.id)}">${esc(p.name)} · ${Number(p.quantity || 0)} pcs</option>`).join('');
  $('serialNumber').value = '';
  $('serialMsg').textContent = '';
  serialDialog.showModal();
}

async function saveSerial(e) {
  e?.preventDefault();
  if (!isAdmin) return;
  const btn = $('saveSerialBtn');
  const msg = $('serialMsg');
  const product_id = $('serialProduct')?.value;
  const serial_number = $('serialNumber')?.value.trim();
  if (!product_id || !serial_number) return;
  busy(btn, true, 'Saving…');
  msg.textContent = '';
  const { error } = await sb.from('inventory_units').insert({ product_id, serial_number, status: 'available' });
  if (error) {
    msg.textContent = error.message;
    busy(btn, false);
    return;
  }
  serialDialog.close();
  $('serialForm').reset();
  toast('Serial number added.');
  await loadAll();
  render();
  busy(btn, false);
}

async function deleteSerial(id) {
  if (!isAdmin || !id || !confirm('Delete this serial number?')) return;
  const { error } = await sb.from('inventory_units').delete().eq('id', id).eq('status', 'available');
  if (error) return toast(error.message, 'error');
  toast('Serial deleted.');
  await loadAll();
  render();
}

function availableUnitsForProduct(productId) {
  const activeUnits = new Set(deliveryRequests
    .filter(r => ['pending_admin_approval', 'approved_for_delivery', 'delivery_note_submitted'].includes(r.status))
    .map(r => r.unit_id));
  return serials.filter(s => s.product_id === productId && s.status === 'available' && !activeUnits.has(s.id));
}

function openDeliveryAssignment() {
  if (!isAdmin) return;
  const employees = profiles.filter(p => p.role === 'delivery_guy' && p.active !== false);
  if (!employees.length) return toast('Create or enable a delivery employee in Delivery Guys first.', 'error');
  const eligibleProducts = products.filter(p => availableUnitsForProduct(p.id).length);
  if (!eligibleProducts.length) return toast('Add a product with available serial numbers first.', 'error');
  $('deliveryAssignmentForm').reset();
  $('deliveryAssignmentMsg').textContent = '';
  $('daDriver').innerHTML = '<option value="">Select an employee...</option>' + employees.map(p => `<option value="${esc(p.id)}">${esc(p.full_name || p.email)}</option>`).join('');
  $('daProduct').innerHTML = '<option value="">Select a product...</option>' + eligibleProducts.map(p => `<option value="${esc(p.id)}">${esc(p.name)} (${availableUnitsForProduct(p.id).length} available)</option>`).join('');
  $('daQuantity').value = '1';
  $('daDate').value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000 + 86400000).toISOString().slice(0, 10);
  updateAssignmentPreview();
  deliveryAssignmentDialog.showModal();
}

function updateAssignmentPreview() {
  const product = products.find(p => p.id === $('daProduct')?.value);
  const available = product ? availableUnitsForProduct(product.id) : [];
  const count = Number($('daQuantity')?.value || 0);
  if ($('daQuantity')) $('daQuantity').max = String(Math.min(100, available.length || 1));
  const preview = $('daSerialPreview');
  if (!product) {
    preview.innerHTML = '<span>Select a product to see available inventory.</span>';
    return;
  }
  if (!Number.isInteger(count) || count < 1 || count > available.length || count > 100) {
    preview.innerHTML = `<span>${available.length} available serial(s). Choose a quantity from 1 to ${Math.min(100, available.length)}.</span>`;
    return;
  }
  preview.innerHTML = `<div><b>${esc(product.name)} · ${count} unit${count === 1 ? '' : 's'}</b><span>${available.length} available · Serials reserved automatically on assignment.</span></div>`;
}

async function submitDeliveryAssignment(e) {
  e.preventDefault();
  if (!isAdmin) return;
  const msg = $('deliveryAssignmentMsg');
  const btn = $('submitDeliveryAssignmentBtn');
  const productId = $('daProduct').value;
  const count = Number($('daQuantity').value);
  const available = availableUnitsForProduct(productId);
  if (!profiles.some(p => p.id === $('daDriver').value && p.active !== false)) return msg.textContent = 'Choose an active delivery employee.';
  if (!Number.isInteger(count) || count < 1 || count > Math.min(100, available.length)) return msg.textContent = 'Quantity exceeds available inventory.';
  busy(btn, true, 'Assigning…');
  msg.textContent = '';
  try {
    const { error } = await sb.rpc('create_delivery_assignment', {
      p_driver_id: $('daDriver').value,
      p_product_id: productId,
      p_quantity: count,
      p_destination: $('daDestination').value.trim(),
      p_recipient: $('daRecipient').value.trim(),
      p_delivery_date: $('daDate').value,
      p_notes: $('daNotes').value.trim()
    });
    if (error) throw error;
    deliveryAssignmentDialog.close();
    toast(`Assigned ${count} unit${count === 1 ? '' : 's'} to the delivery employee.`);
    await loadAll();
    go('deliveries');
  } catch (err) {
    msg.textContent = err.message || 'Could not create the delivery request.';
  } finally {
    busy(btn, false);
  }
}

async function cancelDeliveryBatch(batchId) {
  if (!isAdmin) return;
  const reason = prompt('Reason for cancellation (optional):');
  if (reason === null) return;
  const { error } = await sb.rpc('cancel_delivery_assignment', { p_batch_id: batchId, p_reason: reason.trim() });
  if (error) return toast(error.message, 'error');
  toast('Delivery cancelled and stock released.');
  await loadAll();
  render();
}

async function completeDeliveryBatch(batchId) {
  if (!isAdmin || !confirm('Confirm this entire delivery and deduct all assigned units from stock?')) return;
  const { error } = await sb.rpc('complete_delivery_assignment', { p_batch_id: batchId });
  if (error) return toast(error.message, 'error');
  toast('Delivery completed and stock updated.');
  await loadAll();
  render();
}

function openBatchDeliveryNote(batchId) {
  if (!isDelivery()) return;
  const rows = deliveryRequests.filter(r => r.batch_id === batchId);
  if (!rows.length || rows.some(r => r.status !== 'approved_for_delivery')) return;
  $('deliveryNoteForm').reset();
  $('dnRequestId').value = `batch:${batchId}`;
  $('deliveryNoteMsg').textContent = '';
  const names = rows.map(r => r.inventory_units?.serial_number || '—').map(esc).join(', ');
  $('deliveryNotePreview').innerHTML = `<b>${esc(rows[0].products?.name || 'Product')} · ${rows.length} units</b><span>${names} · ${esc(rows[0].destination)}</span>`;
  deliveryNoteDialog.showModal();
}

async function viewBatchDeliveryNote(batchId) {
  const r = deliveryRequests.find(x => x.batch_id === batchId && x.delivery_note_url);
  if (!r) return toast('No delivery note file.', 'error');
  const { data, error } = await sb.storage.from('delivery-notes').createSignedUrl(r.delivery_note_url, 300);
  if (error) return toast(error.message, 'error');
  window.open(data.signedUrl, '_blank', 'noopener');
}

async function approveDelivery(id) {
  if (!isAdmin) return;
  const { error } = await sb.rpc('approve_delivery_request', { request_id: id });
  if (error) return toast(error.message, 'error');
  toast('Delivery approved.');
  await loadAll();
  render();
}

async function rejectDelivery(id) {
  if (!isAdmin) return;
  const reason = prompt('Reason for rejection (optional):') ?? null;
  if (reason === null) return;
  const { error } = await sb.rpc('reject_delivery_request', { request_id: id, rejection_reason: reason });
  if (error) return toast(error.message, 'error');
  toast('Delivery rejected.');
  await loadAll();
  render();
}

function openDeliveryNote(id) {
  if (!isDelivery()) return;
  const r = deliveryRequests.find(x => x.id === id && x.status === 'approved_for_delivery');
  if (!r) return;
  $('dnRequestId').value = id;
  $('deliveryNoteForm').reset();
  $('dnRequestId').value = id;
  $('deliveryNoteMsg').textContent = '';
  $('deliveryNotePreview').innerHTML = `<b>${esc(r.products?.name || 'Product')}</b><span>${esc(r.inventory_units?.serial_number || '—')} · ${esc(r.destination)}</span>`;
  deliveryNoteDialog.showModal();
}

async function uploadDeliveryNote(file, requestId) {
  if (!file) throw Error('Choose a delivery note file.');
  if (!/^image\/(png|jpeg|webp)$/.test(file.type) && file.type !== 'application/pdf') throw Error('Use PDF, PNG, JPG or WEBP.');
  if (file.size > 10 * 1024 * 1024) throw Error('File is larger than 10 MB.');
  const ext = (file.name.split('.').pop() || 'bin').toLowerCase();
  const path = `${user.id}/${requestId}/${crypto.randomUUID()}.${ext}`;
  const { error } = await sb.storage.from('delivery-notes').upload(path, file, { contentType: file.type });
  if (error) throw error;
  return path;
}

async function submitDeliveryNote(e) {
  e.preventDefault();
  if (!isDelivery()) return;
  const btn = $('submitDeliveryNoteBtn');
  const msg = $('deliveryNoteMsg');
  const requestId = $('dnRequestId').value;
  const file = $('dnFile').files[0];
  busy(btn, true, 'Uploading…');
  msg.textContent = '';
  try {
    const isBatch = requestId.startsWith('batch:');
    const id = isBatch ? requestId.slice(6) : requestId;
    const path = await uploadDeliveryNote(file, id);
    const { error } = isBatch
      ? await sb.rpc('submit_delivery_assignment_note', {
          p_batch_id: id, p_note_path: path,
          p_note_number: $('dnNumber').value.trim(), p_note_text: $('dnNotes').value.trim()
        })
      : await sb.rpc('submit_delivery_note', {
          request_id: id, note_path: path,
          note_number: $('dnNumber').value.trim(), note_text: $('dnNotes').value.trim()
        });
    if (error) throw error;
    deliveryNoteDialog.close();
    toast('Delivery note submitted.');
    await loadAll();
    render();
  } catch (err) {
    console.error(err);
    msg.textContent = err.message || 'Could not submit delivery note.';
  } finally {
    busy(btn, false);
  }
}

async function viewDeliveryNote(id) {
  const r = deliveryRequests.find(x => x.id === id);
  if (!r?.delivery_note_url) return toast('No delivery note file.', 'error');
  const { data, error } = await sb.storage.from('delivery-notes').createSignedUrl(r.delivery_note_url, 300);
  if (error) return toast(error.message, 'error');
  window.open(data.signedUrl, '_blank', 'noopener');
}

async function completeDelivery(id) {
  if (!isAdmin || !confirm('Complete this delivery and deduct one unit from stock?')) return;
  const { error } = await sb.rpc('complete_delivery_request', { request_id: id });
  if (error) return toast(error.message, 'error');
  toast('Delivery completed.');
  await loadAll();
  render();
}

async function markAllNotificationsRead() {
  if (!user) return;
  const { error } = await sb.from('notifications').update({ read_at: new Date().toISOString() }).eq('recipient_id', user.id).is('read_at', null);
  if (error) return toast(error.message, 'error');
  await loadAll();
  render();
}

async function openNotification(id, referenceId) {
  if (!user) return;
  const { error } = await sb.from('notifications').update({ read_at: new Date().toISOString() }).eq('id', id).eq('recipient_id', user.id);
  if (error) toast(error.message, 'error');
  if (referenceId) go('deliveries');
  else {
    await loadAll();
    render();
  }
}

$('productForm').onsubmit = async e => {
  e.preventDefault();
  if (!isAdmin) return;
  const btn = $('saveProduct');
  busy(btn, true);
  $('formMsg').textContent = '';
  let createdProductId = null;

  try {
    let image = $('pImage').value.trim();
    const file = $('pImageFile').files[0];
    if (file) image = await uploadImage(file);

    const id = $('productId').value;
    const newSerials = id ? [] : parseProductSerials();
    if (!id && newSerials.length === 0) throw Error('Add at least one serial number.');

    const payload = {
      name: $('pName').value.trim(),
      description: $('pDesc').value.trim(),
      quantity: id ? Math.max(0, Number($('pQty').value) || 0) : newSerials.length,
      location: $('pLoc').value.trim(),
      category: $('pCat').value.trim() || 'General',
      price: Math.max(0, Number($('pPrice').value) || 0),
      image_url: image
    };

    if (id) {
      const { data, error } = await sb.from('products').update(payload).eq('id', id).select('*').single();
      if (error) throw error;
      const i = products.findIndex(p => p.id === id);
      if (i >= 0 && data) products[i] = data;
      toast('Item updated');
    } else {
      // Create the product and all serials in ONE database transaction.
      // If any serial already exists, Supabase rolls the whole attempt back.
      // Existing inventory is never deleted or reset.
      const { data, error } = await sb.rpc('create_product_with_serials', {
        p_name: payload.name,
        p_description: payload.description,
        p_location: payload.location,
        p_category: payload.category,
        p_price: payload.price,
        p_image_url: payload.image_url,
        p_serials: newSerials
      });
      if (error) throw error;
      const product = Array.isArray(data) ? data[0] : data;
      if (!product?.id) throw Error('Product was not returned after saving.');
      toast(`Item added · ${newSerials.length} serial${newSerials.length === 1 ? '' : 's'}`);
    }

    productDialog.close();
    await loadAll();
    currentPage = 'admin';
    render();
  } catch (err) {
    console.error('Save product failed:', err);
    $('formMsg').textContent = err.message || String(err);
  } finally {
    busy(btn, false);
  }
};

$('loginForm').onsubmit = async e => {
  e.preventDefault();
  if (!sb) return;
  const btn = $('loginSubmit');
  busy(btn, true, 'Signing in…');
  $('loginMsg').textContent = '';
  const { error } = await sb.auth.signInWithPassword({ email: $('email').value.trim(), password: $('password').value });
  if (error) $('loginMsg').textContent = error.message;
  else {
    loginDialog.close();
    toast('Signed in');
  }
  busy(btn, false);
};

$('logout').onclick = async () => {
  if (!sb) return;
  await sb.auth.signOut();
  toast('Signed out');
  go('dashboard');
};

document.querySelectorAll('.sidebar nav button').forEach(btn => btn.onclick = () => go(btn.dataset.page));
document.querySelector('.brand')?.addEventListener('click', () => go('dashboard'));
$('adminQuick')?.addEventListener('click', () => go(isDelivery() ? 'deliveries' : 'admin'));
$('notificationsBtn')?.addEventListener('click', () => go('notifications'));
$('searchBtn')?.addEventListener('click', () => { go('inventory'); setTimeout(() => $('filter')?.focus(), 60); });
$('pImageFile')?.addEventListener('change', e => { if (e.target.files[0]) preview(URL.createObjectURL(e.target.files[0])); });
$('deliveryUserForm')?.addEventListener('submit', createDeliveryUser);
$('serialForm')?.addEventListener('submit', saveSerial);
$('deliveryAssignmentForm')?.addEventListener('submit', submitDeliveryAssignment);
$('daProduct')?.addEventListener('change', updateAssignmentPreview);
$('daQuantity')?.addEventListener('input', updateAssignmentPreview);
$('deliveryNoteForm')?.addEventListener('submit', submitDeliveryNote);

$('pSerials')?.addEventListener('input', syncProductQuantityFromSerials);

boot();
