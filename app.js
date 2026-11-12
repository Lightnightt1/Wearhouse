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
const SITE_OWNER_ID = '86377fb6-03b1-4066-a3f6-b55133f3350a';
let serials = [];
let deliveryRequests = [];
let warehouseOrders = [];
let activeOrderId = null;
let notifications = [];
let user = null;
let profile = null;
let isAdmin = false;
let currentPage = 'dashboard';
let realtimeChannel = null;
let realtimeTimer = null;
let selectedDriverSerialIds = [];
let editingSerialRows = [];

const $ = id => document.getElementById(id);
const view = $('view');
const fallback = 'https://images.unsplash.com/photo-1497366754035-f200968a6e72?auto=format&fit=crop&w=1000&q=85';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
}[c]));

const safeImg = value => value && /^https?:\/\//i.test(value) ? value : fallback;
const isDelivery = () => !!user && !isAdmin && profile?.role === 'delivery_guy' && profile.active === true;
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
    pending_admin_approval: 'Pending manager approval',
    assigned: 'Awaiting employee serials',
    correction_required: 'Correct serial numbers',
    cancelled: 'Cancelled',
    approved_for_delivery: 'Approved',
    delivery_note_submitted: 'Proof submitted',
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

  profile = profileRow.error ? null : profileRow.data;
  isAdmin = !adminRow.error && !!adminRow.data && profile?.role === 'admin' && profile?.active === true;
  updateAuth();
}

const DEFAULT_THEME = { text: '#f4ffff', bg: '#052a30', accent: '#aaffef' };
const validThemeColor = value => /^#[0-9a-f]{6}$/i.test(value || '');
let pendingTheme = { ...DEFAULT_THEME };
function applyTheme(theme, enabled = true) {
  const safe = {
    text: validThemeColor(theme?.text) ? theme.text : DEFAULT_THEME.text,
    bg: validThemeColor(theme?.bg) ? theme.bg : DEFAULT_THEME.bg,
    accent: validThemeColor(theme?.accent) ? theme.accent : DEFAULT_THEME.accent
  };
  const root = document.documentElement;
  if (enabled) {
    root.style.setProperty('--ink', safe.text);
    root.style.setProperty('--bg', safe.bg);
    root.style.setProperty('--accent', safe.accent);
    root.dataset.customTheme = 'true';
  } else {
    ['--ink','--bg','--accent'].forEach(name => root.style.removeProperty(name));
    delete root.dataset.customTheme;
  }
  if ($('themeTextColor')) $('themeTextColor').value = safe.text;
  if ($('themeBgColor')) $('themeBgColor').value = safe.bg;
  if ($('themeAccentColor')) $('themeAccentColor').value = safe.accent;
  if ($('themePreview')) {
    $('themePreview').style.color = safe.text;
    $('themePreview').style.backgroundColor = safe.bg;
    $('themePreview').style.setProperty('--preview-accent', safe.accent);
  }
  return safe;
}
function loadAccountTheme() {
  const saved = user?.user_metadata?.wearhouse_theme;
  pendingTheme = saved ? applyTheme(saved, true) : applyTheme(DEFAULT_THEME, false);
}
function openThemeEditor() {
  if (!user) return;
  pendingTheme = applyTheme(user.user_metadata?.wearhouse_theme || DEFAULT_THEME, !!user.user_metadata?.wearhouse_theme);
  $('themeMsg').textContent = '';
  $('themeDialog').show();
}
$('themeBtn')?.addEventListener('click', openThemeEditor);
$('themeClose')?.addEventListener('click', () => $('themeDialog').close());
$('themeDialog')?.addEventListener('close', () => loadAccountTheme());
function previewThemeChange(key, value) {
  pendingTheme[key] = value;
  applyTheme(pendingTheme, true);
}
$('themeTextColor')?.addEventListener('input', e => previewThemeChange('text', e.target.value));
$('themeBgColor')?.addEventListener('input', e => previewThemeChange('bg', e.target.value));
$('themeAccentColor')?.addEventListener('input', e => previewThemeChange('accent', e.target.value));
$('themeReset')?.addEventListener('click', () => {
  pendingTheme = { ...DEFAULT_THEME };
  applyTheme(pendingTheme, true);
});
$('themeSave')?.addEventListener('click', async () => {
  if (!sb || !user) return;
  const btn = $('themeSave'); busy(btn, true, 'Saving…'); $('themeMsg').textContent = '';
  const { data, error } = await sb.auth.updateUser({ data: { wearhouse_theme: pendingTheme } });
  if (error) { $('themeMsg').textContent = error.message; }
  else { user = data.user || user; pendingTheme = applyTheme(user.user_metadata?.wearhouse_theme || pendingTheme, true); $('themeDialog').close(); toast('Your colors have been saved.'); }
  busy(btn, false);
});

function updateAuth() {
  loadAccountTheme();
  $('themeBtn')?.classList.toggle('hidden', !user);
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
      sb.from('profiles').select('*').order('created_at', { ascending: false }),
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

  warehouseOrders = [];
  if (isStaff()) {
    const [oh, ol] = await Promise.all([
      sb.from('warehouse_delivery_orders').select('*').order('created_at', {ascending:false}),
      sb.from('warehouse_delivery_order_lines').select('order_id,product_id,quantity')
    ]);
    if (oh.error || ol.error) console.error('Manager delivery orders:', oh.error || ol.error);
    else warehouseOrders = (oh.data || []).map(o => ({...o, lines:(ol.data||[]).filter(l => l.order_id===o.id)}));
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
  ['products', 'activity', 'inventory_units', 'delivery_requests', 'warehouse_delivery_orders', 'notifications', 'profiles'].forEach(table => {
    realtimeChannel.on('postgres_changes', { event: '*', schema: 'public', table }, refresh);
  });
  realtimeChannel.subscribe(status => setConnection(status === 'SUBSCRIBED'));
}

function renderSetup() {
  view.innerHTML = `<section class="hero setup"><span class="eyebrow">ONE-TIME CONNECTION</span><h1>Your warehouse.<br><em>Live.</em></h1><p>Add your Supabase URL and publishable key in <b>config.js</b>, then run <b>schema.sql</b>.</p></section>`;
}

function render() {
  updateAuth();

  if (!isAdmin && ['admin', 'users', 'serials'].includes(currentPage)) currentPage = isDelivery() ? 'deliveries' : 'dashboard';
  if (!isStaff() && currentPage === 'deliveries') currentPage = 'dashboard';
  document.querySelectorAll('.sidebar nav button').forEach(btn => btn.classList.toggle('active', btn.dataset.page === currentPage));
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

function uiIcon(name, extra = '') {
  return `<svg class="icon ${extra}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

function dashboardGreeting() {
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const raw = String(profile?.full_name || user?.email?.split('@')[0] || 'there');
  return `${greeting}, ${esc(raw.trim().split(/\s+/)[0] || 'there')}`;
}

// The visual follows the supplied reference, while every number is drawn from
// live inventory/activity/order arrays. No decorative sample statistics.
function dashboardActivityChart() {
  const windowDays = 30;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Array.from({length:windowDays}, (_, i) => {
    const day = new Date(today);
    day.setDate(today.getDate() - (windowDays - i - 1));
    return { day, key: `${day.getFullYear()}-${day.getMonth()+1}-${day.getDate()}`, count:0 };
  });
  const counts = new Map(days.map((d,i) => [d.key, i]));
  activities.forEach(a => {
    const date = new Date(a.created_at || a.timestamp || 0);
    if (Number.isNaN(date.getTime())) return;
    const key = `${date.getFullYear()}-${date.getMonth()+1}-${date.getDate()}`;
    const idx=counts.get(key);
    if (idx !== undefined) days[idx].count++;
  });
  const values = days.map(d => d.count);
  const totalEvents = values.reduce((sum,v)=>sum+v,0);
  const ymax = Math.max(4, Math.ceil(Math.max(...values) / 4) * 4);
  const x0=49, x1=734, y0=20, y1=182;
  const pts=values.map((v,i)=>({x:x0+(x1-x0)*i/(windowDays-1),y:y1-(v/ymax)*(y1-y0)}));
  const curve = pts.reduce((path,p,i)=>{
    if(i===0) return `M ${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
    const previous=pts[i-1];
    const before=pts[Math.max(0,i-2)];
    const after=pts[Math.min(pts.length-1,i+1)];
    const c1x=previous.x+(p.x-before.x)/6;
    const c1y=previous.y+(p.y-before.y)/6;
    const c2x=p.x-(after.x-previous.x)/6;
    const c2y=p.y-(after.y-previous.y)/6;
    return `${path} C ${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  },'');
  const area = `${curve} L ${x1} ${y1} L ${x0} ${y1} Z`;
  const gridY=Array.from({length:5},(_,i)=>{
    const y=y0+(y1-y0)*i/4;
    const v=Math.round(ymax*(4-i)/4);
    return `<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="rgba(193,255,251,.1)"/><text x="${x0-10}" y="${y+4}" text-anchor="end">${v}</text>`;
  }).join('');
  const dateLabel = index => days[index].day.toLocaleDateString('en',{month:'short',day:'numeric'});
  const gridX=[0,5,10,15,20,25,29].map(i=>{
    const x=pts[i].x;
    return `<line x1="${x}" y1="${y0}" x2="${x}" y2="${y1}" stroke="rgba(193,255,251,.06)"/><text x="${x}" y="208" text-anchor="middle">${dateLabel(i)}</text>`;
  }).join('');
  const maxIndex=values.indexOf(Math.max(...values));
  return {totalEvents,markup:`<svg class="trend-chart" viewBox="0 0 760 225" role="img" aria-label="Daily recorded inventory changes over the last 30 days">
    <defs><linearGradient id="activityArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#59e7cc" stop-opacity=".52"/><stop offset="1" stop-color="#59e7cc" stop-opacity=".025"/></linearGradient><filter id="trendGlow"><feGaussianBlur stdDeviation="3"/></filter></defs>
    <g class="chart-grid">${gridY}${gridX}</g>
    <path d="${area}" fill="url(#activityArea)"/>
    <path d="${curve}" fill="none" stroke="#9dfff1" stroke-width="6" opacity=".4" filter="url(#trendGlow)"/>
    <path d="${curve}" fill="none" stroke="#b6fff5" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>
    ${totalEvents?`<circle cx="${pts[maxIndex].x}" cy="${pts[maxIndex].y}" r="11" fill="#b5fff5" fill-opacity=".2"/><circle cx="${pts[maxIndex].x}" cy="${pts[maxIndex].y}" r="5.5" fill="#b5fff5"/>`:''}
  </svg>`};
}

function dashboard() {
  const total=products.reduce((sum,p)=>sum+Number(p.quantity||0),0);
  const lowProducts=products.filter(p=>Number(p.quantity||0)<=7);
  const low=lowProducts.length;
  const staffOrders=isStaff()?warehouseOrders:[];
  const today=new Date().toDateString();
  const todayOrders=staffOrders.filter(o=>new Date(o.created_at).toDateString()===today).length;
  const completed=staffOrders.filter(o=>o.status==='completed').length;
  const awaiting=staffOrders.filter(o=>o.status==='pending_admin_approval').length;
  const graph=dashboardActivityChart();
  const locations=[...new Set(products.map(p=>p.location).filter(Boolean))].slice(0,3);
  const locationCards=locations.map(loc=>{
    const localProducts=products.filter(p=>p.location===loc);
    const units=localProducts.reduce((sum,p)=>sum+Number(p.quantity||0),0);
    const lowLocal=localProducts.filter(p=>Number(p.quantity||0)<=7).length;
    const share=total>0?Math.round(units/total*100):0;
    return `<article class="location-card glass">
      <div class="location-heading"><span class="location-symbol">${uiIcon('home')}</span><div class="location-info"><h3>${esc(loc)}</h3><span>${uiIcon('location')} Stock location</span></div></div>
      <div class="location-share"><span>Share of inventory</span><strong>${share}%</strong></div>
      <div class="location-bar" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${share}" aria-label="Share of inventory"><i style="width:${share}%"></i></div>
      <div class="location-metrics"><div><b>${units.toLocaleString()}</b><span>Units</span></div><div><b>${localProducts.length}</b><span>Products</span></div><div><b>${lowLocal}</b><span>Low stock</span></div></div>
    </article>`;
  }).join('') || empty('No locations added','Add inventory to see warehouse locations.');
  const feed=[...activities].sort((a,b)=>getDateValue(b)-getDateValue(a)).slice(0,4);
  const feedMarkup=feed.map(a=>{
    const text=a.action==='created'?'Item added':a.action==='deleted'?'Item removed':'Inventory updated';
    return `<div class="dashboard-feed-row"><span class="feed-symbol">${uiIcon(a.action==='created'?'package':a.action==='deleted'?'alert':'layers')}</span><div class="feed-body"><b>${esc(a.product_name||text)}</b><small>${esc(text)}${a.actor_email?' · '+esc(a.actor_email.split('@')[0]):''}</small></div><time>${timeAgo(getDateValue(a))}</time></div>`;
  }).join('') || empty('No recent activity','Inventory updates will show here.');
  const alerts=[
    ...(isAdmin&&awaiting?[{name:`${awaiting} order${awaiting===1?'':'s'} awaiting approval`,note:'Review employee-selected serial numbers',page:'deliveries',icon:'clock'}]:[]),
    ...lowProducts.slice(0,3).map(p=>({name:`Low stock: ${p.name}`,note:`${Number(p.quantity||0)} unit(s) remaining · ${p.location||'Unassigned'}`,page:'inventory',icon:'alert'}))
  ];
  const alertMarkup=alerts.slice(0,3).map(a=>`<button class="dashboard-alert-row" onclick="go('${a.page}')"><span class="alert-symbol ${a.icon==='clock'?'waiting':''}">${uiIcon(a.icon)}</span><span><b>${esc(a.name)}</b><small>${esc(a.note)}</small></span>${uiIcon('arrow-right','alert-arrow')}</button>`).join('') || `<div class="dashboard-all-clear">${uiIcon('check')} <span>All caught up — no inventory alerts.</span></div>`;
  view.innerHTML=`
    <section class="dashboard-welcome"><div><h1>${dashboardGreeting()}</h1><p>Here's what's happening across your warehouse today.</p></div><div class="dashboard-actions"><button class="glass-action" onclick="go('inventory')">${uiIcon('package')} Inventory</button>${isAdmin?`<button class="glass-action primary-action" onclick="openManagerOrder()">${uiIcon('plus')} New delivery order</button>`:isDelivery()?`<button class="glass-action primary-action" onclick="go('deliveries')">${uiIcon('truck')} My deliveries</button>`:`<button class="glass-action primary-action" onclick="loginDialog.showModal()">Sign in</button>`}</div></section>
    <section class="dashboard-kpis" aria-label="Warehouse metrics">
      <article class="dashboard-kpi glass"><div class="metric-label">${uiIcon('package')} <span>Total Inventory</span></div><div class="metric-count">${total.toLocaleString()}</div><div class="metric-caption">${products.length} products tracked</div><span class="metric-art cube-art">${uiIcon('package')}</span></article>
      <article class="dashboard-kpi glass"><div class="metric-label">${uiIcon('boxes')} <span>Orders Today</span></div><div class="metric-count">${todayOrders.toLocaleString()}</div><div class="metric-caption">${isStaff()?'Manager-created orders':'Sign in for staff orders'}</div><span class="metric-art cubes-art">${uiIcon('boxes')}</span></article>
      <article class="dashboard-kpi glass"><div class="metric-label">${uiIcon('truck')} <span>Completed Orders</span></div><div class="metric-count">${completed.toLocaleString()}</div><div class="metric-caption">${awaiting} waiting for item approval</div><span class="metric-art truck-art">${uiIcon('truck')}</span></article>
      <article class="dashboard-kpi glass"><div class="metric-label">${uiIcon('alert')} <span>Low Stock</span></div><div class="metric-count">${low.toLocaleString()}</div><div class="metric-caption ${low?'metric-warning':''}">${low?`${low} item(s) need attention`:'No low-stock items'}</div><span class="metric-art warning-art">${uiIcon('alert')}</span></article>
    </section>
    <section class="dashboard-content">
      <div class="dashboard-left-column">
        <section class="dashboard-panel glass trend-panel"><div class="dashboard-panel-head"><h2>${uiIcon('activity')} Inventory Activity</h2><span class="chart-window">Last 30 Days ${uiIcon('chevron-down')}</span></div><div class="trend-summary"><strong>${graph.totalEvents.toLocaleString()}</strong><span>Recorded changes</span></div><p>Daily activity from the latest inventory events</p>${graph.markup}</section>
        <section class="dashboard-panel glass warehouse-panel"><div class="dashboard-panel-head"><h2>${uiIcon('home')} Stock Locations</h2><button class="dashboard-panel-link" onclick="${isAdmin?'openAdd()':"go('inventory')"}">${uiIcon(isAdmin?'plus':'arrow-right')} ${isAdmin?'Add inventory':'Browse inventory'}</button></div><div class="location-cards">${locationCards}</div></section>
      </div>
      <div class="dashboard-right-column">
        <section class="dashboard-panel glass recent-panel"><div class="dashboard-panel-head"><h2>${uiIcon('clock')} Recent Activity</h2><button class="dashboard-panel-link" onclick="go('activity')">View all ${uiIcon('arrow-right')}</button></div><div class="dashboard-feed">${feedMarkup}</div></section>
        <section class="dashboard-panel glass alerts-panel"><div class="dashboard-panel-head"><h2>${uiIcon('alert')} Alerts</h2><button class="dashboard-panel-link" onclick="go('${isAdmin&&awaiting?'deliveries':'inventory'}')">View all ${uiIcon('arrow-right')}</button></div><div class="dashboard-alerts">${alertMarkup}</div></section>
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
    if (isDelivery()) return deliveries();
    view.innerHTML = `<section class="hero"><span class="eyebrow">WAREHOUSE ACCESS</span><h1>Team access.<br><em>Protected.</em></h1><p>Sign in with an administrator account to manage people and roles.</p><button class="primary" onclick="loginDialog.showModal()">Sign in</button></section>`;
    return;
  }
  const list = [...profiles].sort((a,b) => (a.role==='admin'?0:1)-(b.role==='admin'?0:1) || (a.full_name||a.email||'').localeCompare(b.full_name||b.email||''));
  const admins = list.filter(p => p.role==='admin' && p.active).length;
  const staff = list.filter(p => p.role==='delivery_guy' && p.active).length;
  const disabled = list.filter(p => p.active===false).length;
  view.innerHTML = `
    <section class="hero compact"><span class="eyebrow">ADMIN · ACCESS CONTROL</span><h1>Users &amp;<br><em>roles.</em></h1>
      <p>Manage who can access the Wearhouse site. Give a member Admin or Staff permissions, or disable access.</p>
      <div class="hero-actions"><button class="primary" onclick="deliveryUserDialog.showModal()">＋ Add staff account</button><button class="ghost" onclick="go('inventory')">Manage inventory →</button></div>
    </section>
    <section class="stats member-stats"><div class="stat glass"><small>Site members</small><b>${list.length}</b><span>Wearhouse accounts</span></div><div class="stat glass"><small>Administrators</small><b>${admins}</b><span>Full management access</span></div><div class="stat glass"><small>Delivery staff</small><b>${staff}</b><span>Assigned deliveries</span></div><div class="stat glass"><small>Disabled</small><b>${disabled}</b><span>Access blocked</span></div></section>
    <section class="panel glass member-panel"><div class="head wrap"><div><small class="section-label">USER MANAGEMENT</small><h2>Staff / Admin</h2><p class="member-help">Change a member's role or disable their access. Your owner account is protected.</p></div><span class="pill">${list.length} accounts</span></div>
      <div class="member-list">${list.map(p => {
        const owner = p.id===SITE_OWNER_ID;
        const self = p.id===user?.id;
        const locked = owner || self;
        return `<article class="member-row glass">
          <span class="member-avatar">${esc((p.full_name||p.email||'?').slice(0,1).toUpperCase())}</span>
          <div class="member-info"><strong>${esc(p.full_name||'Unnamed user')} ${owner?'<span class="member-owner">Owner</span>':self?'<span class="member-owner">You</span>':''}</strong><span>${esc(p.email||'—')}</span><small class="member-status ${p.active?'enabled':'disabled'}">${p.active?'● Active':'● Disabled'}</small></div>
          <label class="member-role-label">Role<select id="role-${p.id}" aria-label="Role for ${esc(p.full_name||p.email||'member')}" ${locked?'disabled':''}>
            <option value="admin" ${p.role==='admin'?'selected':''}>Admin</option><option value="delivery_guy" ${p.role==='delivery_guy'?'selected':''}>Staff / Delivery</option>
          </select></label>
          <div class="member-actions">${locked?`<span class="pill member-protected">${owner?'Owner protected':'Own account'}</span>`:
          `<button class="smallbtn" onclick="saveMemberRole('${p.id}')">Save role</button><button class="smallbtn ${p.active?'danger':''}" onclick="toggleMemberActive('${p.id}')">${p.active?'Disable':'Enable'}</button>`}</div>
        </article>`;
      }).join('')||empty('No members yet','Add a delivery staff account to get started.')}</div>
    </section>`;
}

// Staff / Admin is the single permissions page. Existing deep links remain supported.
function adminUsers() { return admin(); }

async function updateMemberAccess(member, nextRole, nextActive) {
  if (!isAdmin || !member) return;
  if (member.id===SITE_OWNER_ID || member.id===user?.id) return toast('This administrator account is protected.', 'error');
  const nextLabel = nextRole==='admin'?'Admin':'Staff / Delivery';
  const action = member.role!==nextRole ? `change ${member.full_name||member.email} to ${nextLabel}` : `${nextActive?'enable':'disable'} ${member.full_name||member.email}`;
  if (!confirm(`Are you sure you want to ${action}?`)) return;
  const {error}=await sb.rpc('warehouse_set_member_access', {p_member_id:member.id,p_role:nextRole,p_active:nextActive});
  if (error) return toast(error.message||'Could not update user access.', 'error');
  toast('User access updated.');
  await loadAll();
  render();
}

async function saveMemberRole(id) {
  const member=profiles.find(p=>p.id===id);
  const role=$(`role-${id}`)?.value;
  if (!member || !['admin','delivery_guy'].includes(role)) return;
  if (role===member.role) return toast('This user already has that role.');
  await updateMemberAccess(member,role,member.active);
}

async function toggleMemberActive(id) {
  const member=profiles.find(p=>p.id===id);
  if (!member) return;
  await updateMemberAccess(member,member.role,!member.active);
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
  const legacy = deliveryGroups().filter(g=>!g.some(r=>r.warehouse_order_id));
  const waiting = warehouseOrders.filter(o=>o.status==='pending_admin_approval').length;
  const proof = warehouseOrders.filter(o=>o.status==='approved_for_delivery').length;
  const completed = warehouseOrders.filter(o=>o.status==='completed').length;
  view.innerHTML = `
    <section class="hero compact"><span class="eyebrow">${isAdmin ? 'MANAGER · CREATE & APPROVE' : 'EMPLOYEE · ASSIGNED ORDERS'}</span>
    <h1>Delivery<br><em>orders.</em></h1>
    <p>${isAdmin ? 'Only managers create delivery orders. Employees choose their assigned serial numbers, then wait for your approval before delivering.' : 'Your manager assigns orders here. Select matching serial numbers, wait for approval, then upload delivery proof.'}</p>
    ${isAdmin ? `<div class="hero-actions"><button class="primary" onclick="openManagerOrder()">＋ New delivery order</button></div>` : ''}
    </section>
    <section class="stats">
      <div class="stat glass"><small>Awaiting approval</small><b>${waiting}</b><span>serials to review</span></div>
      <div class="stat glass"><small>Approved</small><b>${proof}</b><span>waiting for delivery evidence</span></div>
      <div class="stat glass"><small>Completed</small><b>${completed}</b><span>confirmed deliveries</span></div>
      <div class="stat glass"><small>All orders</small><b>${warehouseOrders.length}</b><span>manager-created</span></div>
    </section>
    <section class="panel glass delivery-list"><div class="head"><div><small class="section-label">${isAdmin ? 'MANAGER ORDERS' : 'MY ASSIGNED ORDERS'}</small><h2>Orders</h2></div><span class="pill">${warehouseOrders.length}</span></div>
    ${warehouseOrders.map(warehouseOrderCard).join('') || empty('No manager orders yet', isAdmin ? 'Use New delivery order to assign products to a delivery employee.' : 'Your manager must create and assign an order first.')}</section>
    ${legacy.length ? `<section class="panel glass delivery-list"><div class="head"><div><small class="section-label">PREVIOUS SYSTEM</small><h2>Older delivery requests</h2></div></div>${legacy.map(g=>g[0].batch_id ? deliveryBatchCard(g) : deliveryCard(g[0])).join('')}</section>` : ''}`;
}

function warehouseOrderCard(o) {
  const driver = profiles.find(p=>p.id===o.driver_id);
  const batchRows = deliveryRequests.filter(r => o.current_batch_id && r.batch_id===o.current_batch_id);
  const required = o.lines.map(l => {
    const p=products.find(p=>p.id===l.product_id);
    return `${p?.name || 'Product'} × ${l.quantity}`;
  });
  const serialLabels = batchRows.map(r=> `${r.products?.name||'Product'} · ${r.inventory_units?.serial_number||'—'}`);
  let actions='';
  if (isAdmin) {
    if (o.status==='pending_admin_approval') actions += `<button class="smallbtn" onclick="approveWarehouseOrder('${o.id}')">✓ Approve serials</button><button class="smallbtn danger" onclick="rejectWarehouseSerials('${o.id}')">Reject serials</button>`;
    if (o.status==='delivery_note_submitted') actions += `<button class="smallbtn" onclick="viewBatchDeliveryEvidence('${o.current_batch_id}')">View proof</button>`;
    if (['assigned','correction_required','approved_for_delivery','pending_admin_approval','delivery_note_submitted'].includes(o.status)) actions += `<button class="smallbtn danger" onclick="cancelWarehouseOrder('${o.id}')">Cancel order</button>`;
    if (o.status==='completed') actions+=`<button class="smallbtn" onclick="viewBatchDeliveryEvidence('${o.current_batch_id}')">View proof</button>`;
  } else if (isDelivery()) {
    if (['assigned','correction_required'].includes(o.status)) actions += `<button class="smallbtn" onclick="openDriverRequest('${o.id}')">Choose serial numbers</button>`;
    if (o.status==='approved_for_delivery') actions += `<button class="smallbtn" onclick="openWarehouseDeliveryProof('${o.id}')">Upload ${o.service_type==='delivery_installation'?'installation photos & document':'delivery document'}</button>`;
    if (['delivery_note_submitted','completed'].includes(o.status)) actions += `<button class="smallbtn" onclick="viewBatchDeliveryEvidence('${o.current_batch_id}')">View proof</button>`;
  }
  return `<article class="delivery-card glass"><div class="delivery-top"><div><small class="section-label">MANAGER-CREATED ORDER</small><h3>${required.reduce((a,l)=>a+1,0)} product type(s) · ${esc(o.destination)}</h3></div><span class="delivery-status ${esc(o.status)}">${esc(statusLabel(o.status))}</span></div>
  <div class="delivery-grid">${isAdmin?`<div><small>Delivery employee</small><b>${esc(driver?.full_name||driver?.email||o.driver_id)}</b></div>`:''}<div><small>Service</small><b>${o.service_type==='delivery_installation'?'Delivery + installation':'Delivery only'}</b></div><div><small>Recipient</small><b>${esc(o.recipient||'—')}</b></div><div><small>Delivery date</small><b>${esc(o.delivery_date)}</b></div><div><small>Created</small><b>${timeAgo(o.created_at)}</b></div></div>
  <div class="delivery-copy"><b>Items requested by manager</b><div class="delivery-serial-list">${required.map(x=>`<span class="pill">${esc(x)}</span>`).join('')}</div></div>
  ${serialLabels.length ? `<div class="delivery-copy"><b>Employee-selected serial numbers</b><div class="delivery-serial-list">${serialLabels.map(x=>`<span class="pill">${esc(x)}</span>`).join('')}</div></div>`:''}
  ${o.notes ? `<p class="delivery-copy"><b>Instructions:</b> ${esc(o.notes)}</p>`:''}
  ${o.rejection_reason && o.status==='correction_required' ? `<p class="delivery-copy rejected-copy"><b>Correction requested:</b> ${esc(o.rejection_reason)}</p>`:''}
  ${actions?`<div class="delivery-actions">${actions}</div>`:''}</article>`;
}

function deliveryBatchCard(rows) {
  const r = rows[0];
  const employee = profiles.find(p => p.id === r.delivery_guy_id);
  const names = rows.map(x => `${x.products?.name || 'Product'} · ${x.inventory_units?.serial_number || serials.find(s => s.id === x.unit_id)?.serial_number || '—'}`);
  const batchId = r.batch_id;
  const hasPhotoProof = Array.isArray(r.delivery_photo_paths) && r.delivery_photo_paths.length > 0;
  let actions = '';
  if (isAdmin) {
    if (r.status === 'pending_admin_approval' || r.status === 'approved_for_delivery') {
      actions = `<span class="pill">${r.status === 'pending_admin_approval' ? 'Awaiting employee proof' : 'Awaiting delivery note (legacy)'}</span><button class="smallbtn danger" onclick="cancelDeliveryBatch('${batchId}')">Cancel</button>`;
    } else if (r.status === 'delivery_note_submitted') {
      actions = `<button class="smallbtn" onclick="viewBatchDeliveryEvidence('${batchId}')">View ${hasPhotoProof ? 'photos & note' : 'note'}</button><button class="smallbtn" onclick="completeDeliveryBatch('${batchId}')">✓ Confirm completed</button><button class="smallbtn danger" onclick="cancelDeliveryBatch('${batchId}')">Reject</button>`;
    } else if (r.delivery_note_url) actions = `<button class="smallbtn" onclick="viewBatchDeliveryEvidence('${batchId}')">View evidence</button>`;
  } else if (isDelivery() && (r.status === 'pending_admin_approval' || r.status === 'approved_for_delivery')) {
    actions = `<span class="pill">Previous system · ask your manager for a new order</span>`;
  } else if (isDelivery() && r.delivery_note_url) {
    actions = `<button class="smallbtn" onclick="viewBatchDeliveryEvidence('${batchId}')">View evidence</button>`;
  }
  return `<article class="delivery-card glass"><div class="delivery-top"><div><small class="section-label">${esc([...new Set(rows.map(x => x.products?.name || 'Product'))].join(', '))}</small><h3>${rows.length} item${rows.length === 1 ? '' : 's'} · Delivery request</h3></div><span class="delivery-status ${esc(r.status)}">${esc(statusLabel(r.status))}</span></div>
  <div class="delivery-grid">${isAdmin ? `<div><small>Delivery employee</small><b>${esc(employee?.full_name || employee?.email || r.delivery_guy_id)}</b></div>` : ''}<div><small>Quantity</small><b>${rows.length}</b></div><div><small>Destination</small><b>${esc(r.destination)}</b></div><div><small>Recipient</small><b>${esc(r.recipient || '—')}</b></div><div><small>Delivery date</small><b>${esc(r.delivery_date)}</b></div><div><small>Created</small><b>${timeAgo(r.created_at)}</b></div></div>
  <div class="delivery-copy"><b>Selected items & serials:</b><div class="delivery-serial-list">${names.map(n => `<span class="pill">${esc(n)}</span>`).join('')}</div></div>
  ${r.notes ? `<p class="delivery-copy"><b>Instructions:</b> ${esc(r.notes)}</p>` : ''}
  ${r.delivery_note_number ? `<p class="delivery-copy"><b>Delivery note:</b> ${esc(r.delivery_note_number)}${r.driver_notes ? ` · ${esc(r.driver_notes)}` : ''}</p>` : ''}
  ${r.rejection_reason ? `<p class="delivery-copy rejected-copy"><b>Cancelled:</b> ${esc(r.rejection_reason)}</p>` : ''}
  ${actions ? `<div class="delivery-actions">${actions}</div>` : ''}</article>`;
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

function serialQuantityInEditor() {
  return editingSerialRows.filter(r => r.status !== 'delivered').length;
}

function syncEditSerialCount() {
  const current = serialQuantityInEditor();
  if ($('pQty')) $('pQty').value = String(current);
  if ($('editSerialCount')) {
    const editable = editingSerialRows.filter(r => !r.locked).length;
    const protectedCount = editingSerialRows.filter(r => r.locked).length;
    $('editSerialCount').textContent = `${current} in stock · ${editable} editable · ${protectedCount} protected`;
  }
}

function renderEditSerialRows() {
  const container = $('editSerialRows');
  if (!container) return;
  container.innerHTML = editingSerialRows.map((row, i) => {
    if (row.locked) {
      const status = row.status === 'delivered' ? 'Delivered · history' : row.status === 'available' ? 'Used in an order · history' : statusLabel(row.status);
      return `<div class="edit-serial-row protected"><span class="edit-serial-tag">${esc(String(i + 1))}</span><input type="text" value="${esc(row.serial_number)}" disabled aria-label="Protected serial number"><span class="edit-serial-lock">${esc(status)}</span></div>`;
    }
    return `<div class="edit-serial-row"><span class="edit-serial-tag">${esc(String(i + 1))}</span><input type="text" value="${esc(row.serial_number)}" maxlength="120" required placeholder="Enter serial number" aria-label="Serial number ${i + 1}" oninput="editSerialValue(${i}, this.value)"><button type="button" class="smallbtn danger" onclick="removeEditSerialRow(${i})" aria-label="Remove serial number">×</button></div>`;
  }).join('') || '<p class="field-note">No serial numbers yet. Add one to increase the quantity.</p>';
  syncEditSerialCount();
}

function editSerialValue(i, value) {
  if (!editingSerialRows[i] || editingSerialRows[i].locked) return;
  editingSerialRows[i].serial_number = value;
  if ($('editSerialStatus')) $('editSerialStatus').textContent = '';
}

function addEditSerialRow() {
  if (!$('productId')?.value || !isAdmin) return;
  if (editingSerialRows.length >= 1000) return toast('Maximum 1,000 serials per edit.','error');
  editingSerialRows.push({id:null, serial_number:'', status:'available', locked:false});
  renderEditSerialRows();
  $('editSerialRows')?.querySelector('.edit-serial-row:last-child input')?.focus();
}

function removeEditSerialRow(i) {
  const row=editingSerialRows[i];
  if (!row || row.locked) return;
  if (row.id && !confirm(`Remove serial ${row.serial_number}? The change will take effect when you save.`)) return;
  editingSerialRows.splice(i,1);
  renderEditSerialRows();
}

function adjustEditSerialQuantity() {
  if (!$('productId')?.value) return;
  const desired = Number($('pQty').value);
  if (!Number.isInteger(desired) || desired < 0 || desired > 10000) {
    $('editSerialStatus').textContent='Enter a valid quantity.';
    return;
  }
  const minimum=editingSerialRows.filter(r => r.locked && r.status !== 'delivered').length;
  if (desired < minimum) {
    $('editSerialStatus').textContent=`Cannot reduce below ${minimum}. These items are protected by delivery records.`;
    return;
  }
  const current = serialQuantityInEditor();
  if (desired > current) {
    const difference = desired-current;
    if (editingSerialRows.length+difference > 1000) {
      $('editSerialStatus').textContent='Too many serial numbers for one edit.';
      return;
    }
    for(let i=0;i<difference;i++) editingSerialRows.push({id:null,serial_number:'',status:'available',locked:false});
    renderEditSerialRows();
    $('editSerialStatus').textContent=`Fill in the ${difference} new serial number${difference===1?'':'s'} before saving.`;
  } else if (desired < current) {
    // Never guess which physical serial to delete from stock.
    $('editSerialStatus').textContent=`Remove ${current-desired} unused serial number${current-desired===1?'':'s'} using × below. Do not remove delivered or reserved items.`;
    $('editSerialRows')?.scrollIntoView({behavior:'smooth',block:'nearest'});
  } else {
    $('editSerialStatus').textContent='';
    syncEditSerialCount();
  }
}

function openAdd() {
  if (!isAdmin) return loginDialog.showModal();
  $('productForm').reset();
  $('productId').value = '';
  $('formTitle').textContent = 'Add item + serials';
  $('formMsg').textContent = '';
  editingSerialRows = [];
  if ($('pQty')) { $('pQty').value='0'; $('pQty').readOnly=true; }
  if ($('pQtyHelp')) $('pQtyHelp').textContent='Calculated automatically from serial numbers.';
  $('editSerialEditor')?.classList.add('hidden');
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
  const previouslyUsedSerialIds = new Set(deliveryRequests.map(r => r.unit_id));
  editingSerialRows = serials.filter(s => s.product_id === p.id).map(s => ({
    id:s.id, serial_number:s.serial_number, status:s.status,
    locked:s.status !== 'available' || previouslyUsedSerialIds.has(s.id)
  }));
  $('pQty').readOnly = false;
  $('pQty').value = String(editingSerialRows.filter(r => r.status !== 'delivered').length);
  if ($('pQtyHelp')) $('pQtyHelp').textContent='Change this number to add serial fields; use × below to reduce quantity.';
  if ($('pSerialsLabel')) $('pSerialsLabel').classList.add('hidden');
  $('editSerialEditor')?.classList.remove('hidden');
  $('editSerialStatus').textContent = '';
  renderEditSerialRows();
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
  const member=profiles.find(p=>p.id===id && p.role==='delivery_guy');
  if (!member || !isAdmin) return;
  await updateMemberAccess(member,'delivery_guy',active);
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

function availableStockByProduct(productId) {
  const assignedSerials = new Set(deliveryRequests.filter(r =>
    ['pending_admin_approval','approved_for_delivery','delivery_note_submitted'].includes(r.status)
  ).map(r => r.unit_id));
  return serials.filter(s => s.product_id === productId && s.status === 'available' && !assignedSerials.has(s.id)).length;
}

function availableDriverUnits() {
  const active = new Set(deliveryRequests.filter(r =>
    ['pending_admin_approval','approved_for_delivery','delivery_note_submitted'].includes(r.status)
  ).map(r => r.unit_id));
  return serials.filter(s => s.status === 'available' && !active.has(s.id));
}

function openManagerOrder() {
  if (!isAdmin) return;
  const staff=profiles.filter(p=>p.active && p.role==='delivery_guy');
  if (!staff.length) return toast('Create an active delivery employee account first.', 'error');
  $('managerOrderForm').reset();
  $('moDriver').innerHTML = staff.map(p=>`<option value="${esc(p.id)}">${esc(p.full_name||p.email)}</option>`).join('');
  $('moItems').innerHTML='';
  $('moDate').value = new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,10);
  $('managerOrderMsg').textContent='';
  addManagerOrderLine();
  managerOrderDialog.showModal();
}

function addManagerOrderLine() {
  if (!isAdmin) return;
  if ($('moItems').children.length>=25) return toast('Maximum 25 product types.', 'error');
  const el=document.createElement('div');
  el.className='twocol warehouse-line';
  const opts=products.map(p=>`<option value="${esc(p.id)}">${esc(p.name)} · ${availableStockByProduct(p.id)} available</option>`).join('');
  el.innerHTML=`<label>Product<select class="mo-product" required>${opts}</select><small class="mo-stock-note field-note">Available: 0</small></label><label>Quantity<input class="mo-qty" type="number" required min="1" max="50" value="1"></label><button type="button" class="smallbtn danger" onclick="this.parentElement.remove()">Remove</button>`;
  const updateStock=()=>{
    const n=availableStockByProduct(el.querySelector('.mo-product').value);
    el.querySelector('.mo-stock-note').textContent=`Available: ${n}`;
    el.querySelector('.mo-qty').max=String(Math.min(n,50));
  };
  el.querySelector('.mo-product').addEventListener('change',updateStock);
  updateStock();
  $('moItems').appendChild(el);
}

async function submitManagerOrder(e) {
  e.preventDefault();
  if (!isAdmin) return;
  const msg=$('managerOrderMsg');
  const items=[...document.querySelectorAll('#moItems .warehouse-line')].map(x=>({product_id:x.querySelector('.mo-product').value,quantity:Number(x.querySelector('.mo-qty').value)}));
  if (!items.length) return msg.textContent='Choose at least one product.';
  if (new Set(items.map(i=>i.product_id)).size !== items.length) return msg.textContent='Choose each product only once; adjust its quantity instead.';
  const beyond = items.find(i => !Number.isInteger(i.quantity) || i.quantity<1 || i.quantity>availableStockByProduct(i.product_id));
  if (beyond) return msg.textContent=`The requested quantity exceeds available stock (${availableStockByProduct(beyond.product_id)}).`;
  const btn=$('submitManagerOrderBtn');busy(btn,true,'Creating order…');msg.textContent='';
  try {
    const {error}=await sb.rpc('manager_create_warehouse_order_v2',{
      p_driver_id:$('moDriver').value,p_lines:items,
      p_destination:$('moDestination').value.trim(),p_recipient:$('moRecipient').value.trim(),
      p_delivery_date:$('moDate').value,p_service_type:$('moServiceType').value,
      p_notes:$('moNotes').value.trim()
    });
    if (error) throw error;
    managerOrderDialog.close();toast('Order assigned. The employee can now select serial numbers.');
    await loadAll();go('deliveries');
  } catch(err){msg.textContent=err.message||'Could not create the order.';}
  finally{busy(btn,false);}
}

function orderRequirements() {
  const order=warehouseOrders.find(o=>o.id===activeOrderId);
  return new Map((order?.lines||[]).map(l=>[l.product_id,l.quantity]));
}

function openDriverRequest(orderId) {
  const o=warehouseOrders.find(o=>o.id===orderId);
  if (!isDelivery() || !o || !['assigned','correction_required'].includes(o.status)) return;
  activeOrderId=orderId;selectedDriverSerialIds=[];
  $('driverRequestForm').reset();$('driverRequestMsg').textContent='';
  $('driverAssignedItems').innerHTML=(o.lines||[]).map(l=>`<span class="pill">${esc(products.find(p=>p.id===l.product_id)?.name||'Product')} × ${l.quantity}</span>`).join('');
  renderDriverSerialSelection();driverRequestDialog.showModal();
}

function renderDriverSerialSelection() {
  const requirements=orderRequirements();
  const selectedSet=new Set(selectedDriverSerialIds);
  const currentCounts={};
  for(const id of selectedDriverSerialIds){const s=serials.find(x=>x.id===id);if(s)currentCounts[s.product_id]=(currentCounts[s.product_id]||0)+1;}
  const q=($('drSerialSearch')?.value||'').trim().toLowerCase();
  const matches=q ? availableDriverUnits().filter(s=>requirements.has(s.product_id) && !selectedSet.has(s.id)
    && (currentCounts[s.product_id]||0)<requirements.get(s.product_id)
    && `${s.serial_number||''} ${s.products?.name||''}`.toLowerCase().includes(q)).slice(0,12) : [];
  $('drSerialOptions').innerHTML=matches.map(s=>
    `<button type="button" role="option" class="serial-option" onclick="selectDriverSerial('${s.id}')"><b>${esc(s.serial_number)}</b><span>${esc(s.products?.name||'Product')}</span></button>`
  ).join('') || `<div class="serial-option-empty">${q?'No matching available serials':'Type a letter or digit to see serial suggestions'}</div>`;
  const selected=selectedDriverSerialIds.map(id=>serials.find(s=>s.id===id)).filter(Boolean);
  const total=[...requirements.values()].reduce((x,y)=>x+y,0);
  $('drSelectedCount').textContent=`${selected.length} / ${total} selected`;
  $('drSelectedList').innerHTML=selected.map(s=>
    `<div class="serial-selected"><span><b>${esc(s.serial_number)}</b><small>${esc(s.products?.name||'Product')}</small></span><button type="button" class="smallbtn danger" onclick="removeDriverSerial('${s.id}')">×</button></div>`
  ).join('')||'<p class="field-note">Start typing a serial number and select the exact items assigned to you.</p>';
}

function selectDriverSerial(id) {
  const s=availableDriverUnits().find(x=>x.id===id);
  if (!s||selectedDriverSerialIds.includes(id)) return;
  const requirements=orderRequirements();
  const n=selectedDriverSerialIds.filter(x=>serials.find(a=>a.id===x)?.product_id===s.product_id).length;
  if(n>=(requirements.get(s.product_id)||0)) return toast('All required serials for this product are already selected.','error');
  selectedDriverSerialIds.push(id);$('drSerialSearch').value='';renderDriverSerialSelection();$('drSerialSearch').focus();
}
function removeDriverSerial(id){selectedDriverSerialIds=selectedDriverSerialIds.filter(x=>x!==id);renderDriverSerialSelection();}

async function submitDriverRequest(e) {
  e.preventDefault();if (!isDelivery()||!activeOrderId) return;
  const msg=$('driverRequestMsg');
  const required=[...orderRequirements().values()].reduce((a,b)=>a+b,0);
  if(selectedDriverSerialIds.length!==required) return msg.textContent=`Select exactly ${required} serial number(s).`;
  const btn=$('submitDriverRequestBtn');busy(btn,true,'Submitting serials…');msg.textContent='';
  try{
    const {error}=await sb.rpc('driver_select_warehouse_order_serials',{p_order_id:activeOrderId,p_unit_ids:selectedDriverSerialIds});
    if(error) throw error;
    driverRequestDialog.close();toast('Serials submitted. Waiting for manager approval.');
    selectedDriverSerialIds=[];activeOrderId=null;await loadAll();go('deliveries');
  }catch(err){msg.textContent=err.message||'Could not submit serials.';}
  finally{busy(btn,false);}
}

async function approveWarehouseOrder(id) {
  if(!isAdmin) return;
  const o=warehouseOrders.find(x=>x.id===id);
  const rows=deliveryRequests.filter(r=>r.batch_id===o?.current_batch_id);
  if(!confirm(`Approve these ${rows.length} serial number(s) and allow the employee to deliver?\n${rows.map(r=>r.inventory_units?.serial_number||'—').join(', ')}`)) return;
  const {error}=await sb.rpc('manager_approve_warehouse_order',{p_order_id:id});
  if(error) return toast(error.message,'error');toast('Serials approved. Employee can now deliver.');await loadAll();render();
}
async function rejectWarehouseSerials(id) {
  if(!isAdmin) return;const reason=prompt('What should the employee correct in the selected serials?');if(reason===null) return;
  const {error}=await sb.rpc('manager_reject_warehouse_order_serials',{p_order_id:id,p_reason:reason.trim()});
  if(error) return toast(error.message,'error');toast('Serial selection rejected. Employee can select again.');await loadAll();render();
}
async function cancelWarehouseOrder(id) {
  if(!isAdmin) return;const reason=prompt('Reason to cancel this order?');if(reason===null) return;
  const {error}=await sb.rpc('manager_cancel_warehouse_order',{p_order_id:id,p_reason:reason.trim()});
  if(error) return toast(error.message,'error');toast('Order cancelled.');await loadAll();render();
}
function openWarehouseDeliveryProof(id) {
  const o=warehouseOrders.find(x=>x.id===id);
  if(!isDelivery()||!o||o.status!=='approved_for_delivery'||!o.current_batch_id) return;
  $('deliveryNoteForm').reset();$('dnRequestId').value=`order:${id}`;$('deliveryNoteMsg').textContent='';
  const installation=o.service_type==='delivery_installation';
  $('dnPhotosLabel').classList.toggle('hidden',!installation);
  $('dnPhotos').required=installation;
  const rows=deliveryRequests.filter(r=>r.batch_id===o.current_batch_id);
  $('deliveryNotePreview').innerHTML=`<b>${rows.length} item(s)</b><span>${rows.map(r=>esc(`${r.products?.name||'Product'} · ${r.inventory_units?.serial_number||'—'}`)).join(', ')} · ${esc(o.destination)}</span>`;
  deliveryNoteDialog.showModal();
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

function openDriverDeliveryProof(batchId) {
  if (!isDelivery()) return;
  const rows = deliveryRequests.filter(r => r.batch_id === batchId);
  if (!rows.length || rows.some(r => r.status !== 'pending_admin_approval')) return;
  $('deliveryNoteForm').reset();
  $('dnRequestId').value = `driver:${batchId}`;
  $('deliveryNoteMsg').textContent = '';
  $('dnPhotos').required = true;
  $('deliveryNotePreview').innerHTML = `<b>${rows.length} item(s)</b><span>${rows.map(r => esc(`${r.products?.name || 'Product'} · ${r.inventory_units?.serial_number || '—'}`)).join(', ')} · ${esc(rows[0].destination)}</span>`;
  deliveryNoteDialog.showModal();
}

async function viewBatchDeliveryEvidence(batchId) {
  const r = deliveryRequests.find(x => x.batch_id === batchId && x.delivery_note_url);
  if (!r) return toast('No delivery proof yet.', 'error');
  $('deliveryEvidenceContent').innerHTML = '<p>Loading evidence…</p>';
  deliveryEvidenceDialog.showModal();
  const paths = [r.delivery_note_url,...(r.delivery_photo_paths || [])];
  const signed = await Promise.all(paths.map(path => sb.storage.from('delivery-notes').createSignedUrl(path, 300)));
  if (signed.some(x => x.error)) {
    $('deliveryEvidenceContent').textContent = 'Could not open proof: ' + signed.find(x => x.error).error.message;
    return;
  }
  const urls = signed.map(x => x.data.signedUrl);
  const photos = (r.delivery_photo_paths || []).map((_,i) => `<a href="${esc(urls[i+1])}" target="_blank" rel="noopener noreferrer"><img src="${esc(urls[i+1])}" alt="Delivery photo ${i+1}"></a>`).join('');
  $('deliveryEvidenceContent').innerHTML = `<p><b>Delivery note:</b> ${esc(r.delivery_note_number || 'Document attached')}</p><a class="smallbtn" href="${esc(urls[0])}" target="_blank" rel="noopener noreferrer">Open delivery note (PDF / image) ↗</a>
    ${(r.delivery_photo_paths || []).length ? `<h3>Installation photos · ${(r.delivery_photo_paths || []).length}</h3><div class="evidence-grid">${photos}</div>` : '<p>Delivery only · no installation photos required.</p>'}`;
}

function openBatchDeliveryNote(batchId) {
  if (!isDelivery()) return;
  const rows = deliveryRequests.filter(r => r.batch_id === batchId);
  if (!rows.length || rows.some(r => r.status !== 'approved_for_delivery')) return;
  $('deliveryNoteForm').reset();
  $('dnPhotos').required = false;
  $('dnRequestId').value = `batch:${batchId}`;
  $('deliveryNoteMsg').textContent = '';
  const names = rows.map(r => r.inventory_units?.serial_number || '—').map(esc).join(', ');
  $('deliveryNotePreview').innerHTML = `<b>${esc(rows[0].products?.name || 'Product')} · ${rows.length} units</b><span>${names} · ${esc(rows[0].destination)}</span>`;
  deliveryNoteDialog.showModal();
}

async function viewBatchDeliveryNote(batchId) {
  return viewBatchDeliveryEvidence(batchId);
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
  $('dnPhotos').required = false;
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

async function uploadDeliveryPhoto(file, batchId) {
  if (!file || !/^image\/(png|jpeg|webp)$/.test(file.type)) throw Error('Delivery photos must be PNG, JPG or WEBP.');
  if (file.size > 6 * 1024 * 1024) throw Error('A delivery photo exceeds 6 MB.');
  const ext = file.type === 'image/jpeg' ? 'jpg' : file.type.split('/')[1];
  const path = `${user.id}/${batchId}/${crypto.randomUUID()}.${ext}`;
  const {error} = await sb.storage.from('delivery-notes').upload(path,file,{contentType:file.type,upsert:false});
  if (error) throw error;
  return path;
}

async function submitDeliveryNote(e) {
  e.preventDefault();
  if (!isDelivery()) return;
  const btn=$('submitDeliveryNoteBtn');
  const msg=$('deliveryNoteMsg');
  const requestId=$('dnRequestId').value;
  if (!requestId.startsWith('order:')) {
    msg.textContent='Use the new manager-created order to upload delivery proof.';
    return;
  }
  const orderId=requestId.slice('order:'.length);
  const order=warehouseOrders.find(o=>o.id===orderId);
  if (!order || order.status!=='approved_for_delivery' || !order.current_batch_id) {
    msg.textContent='Wait for manager approval before completing the delivery.';
    return;
  }
  const note=$('dnFile').files[0];
  const photos=[...($('dnPhotos').files||[])];
  const installation=order.service_type==='delivery_installation';
  if (!note) {msg.textContent='Upload the signed delivery document.';return;}
  if (installation && (photos.length<1 || photos.length>6)) {
    msg.textContent='Installation requires 1–6 installation photos.';
    return;
  }
  if (photos.length>6) {msg.textContent='Maximum 6 photos.';return;}
  busy(btn,true,'Uploading and completing…');
  msg.textContent='';
  try {
    const notePath=await uploadDeliveryNote(note,order.current_batch_id);
    const photoPaths=[];
    for (const photo of photos) photoPaths.push(await uploadDeliveryPhoto(photo,order.current_batch_id));
    const {error}=await sb.rpc('driver_submit_warehouse_order_evidence',{
      p_order_id:order.id,p_note_path:notePath,p_photo_paths:photoPaths,
      p_note_number:$('dnNumber').value.trim(),p_note_text:$('dnNotes').value.trim()
    });
    if (error) throw error;
    deliveryNoteDialog.close();
    toast('Delivery marked Completed automatically. Manager notified.');
    await loadAll();go('deliveries');
  } catch(err) {
    console.error(err);
    msg.textContent=err.message||'Delivery proof could not be saved.';
  } finally {busy(btn,false);}
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
      const editable = editingSerialRows.filter(r => !r.locked);
      const values = editingSerialRows.map(r => r.serial_number.trim());
      if (values.some(x => !x || x.length > 120)) throw Error('Every serial number must be filled in (max 120 characters).');
      if (new Set(values).size !== values.length) throw Error('Duplicate serial number in this product.');
      const desiredQty=Number($('pQty').value);
      const calculatedQty=serialQuantityInEditor();
      if (!Number.isInteger(desiredQty) || desiredQty !== calculatedQty)
        throw Error(`Quantity must match the physical serial numbers (${calculatedQty}). Add or remove serials before saving.`);
      const {data,error}=await sb.rpc('admin_update_product_and_serials',{
        p_product_id:id, p_name:payload.name,p_description:payload.description,
        p_location:payload.location,p_category:payload.category,p_price:payload.price,
        p_image_url:payload.image_url,p_expected_quantity:desiredQty,
        p_editable_serials:editable.map(r=>({id:r.id,serial_number:r.serial_number.trim()}))
      });
      if (error) throw error;
      const i=products.findIndex(p=>p.id===id);
      if (i>=0 && data) products[i]=data;
      toast('Item, quantity and serial numbers updated.');
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
    currentPage = 'inventory';
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
document.querySelector('.tool-brand')?.addEventListener('click', () => go('dashboard'));
$('profileQuick')?.addEventListener('click', () => go(isDelivery() ? 'deliveries' : 'admin'));
$('notificationsBtn')?.addEventListener('click', () => go('notifications'));
$('searchBtn')?.addEventListener('click', () => { go('inventory'); setTimeout(() => $('filter')?.focus(), 60); });
$('pImageFile')?.addEventListener('change', e => { if (e.target.files[0]) preview(URL.createObjectURL(e.target.files[0])); });
$('deliveryUserForm')?.addEventListener('submit', createDeliveryUser);
$('serialForm')?.addEventListener('submit', saveSerial);
$('driverRequestForm')?.addEventListener('submit', submitDriverRequest);
$('managerOrderForm')?.addEventListener('submit',submitManagerOrder);
$('drSerialSearch')?.addEventListener('input', renderDriverSerialSelection);
$('drSerialSearch')?.addEventListener('focus', renderDriverSerialSelection);
$('deliveryNoteForm')?.addEventListener('submit', submitDeliveryNote);

$('pSerials')?.addEventListener('input', syncProductQuantityFromSerials);
$('pQty')?.addEventListener('change', adjustEditSerialQuantity);

boot();
