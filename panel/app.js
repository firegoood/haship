const BASE = document.documentElement.dataset.base || '';
const at = p => BASE + p;
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function toast(msg) { toastMsg('info', String(msg)); }
function toastOk(title, sub) { toastMsg('ok', title, sub); }
function toastErr(title, sub) { toastMsg('err', title, sub); }
function toastWarn(title, sub) { toastMsg('warn', title, sub); }
// Typed enterprise toast. First line = title, rest (e.g. E-CODE hint) = sub.
function toastMsg(kind, title, sub) {
  let box = $('entToasts');
  if (!box) { // fallback to legacy toast if container missing
    const t = $('toast'); if (t) { t.textContent = title; t.classList.remove('hidden'); setTimeout(() => t.classList.add('hidden'), 2500); }
    return;
  }
  if (sub === undefined && /\n/.test(title)) {
    const i = title.indexOf('\n');
    sub = title.slice(i + 1).replace(/^↪\s*/, '');
    title = title.slice(0, i);
  }
  const el = document.createElement('div');
  el.className = 'ent-toast ' + kind;
  el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  const b = document.createElement('b'); b.textContent = title;
  const wrap = document.createElement('div'); wrap.appendChild(b);
  if (sub) { const s = document.createElement('small'); s.textContent = sub; wrap.appendChild(s); }
  const dot = document.createElement('i');
  el.appendChild(dot); el.appendChild(wrap);
  box.appendChild(el);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, kind === 'err' ? 5000 : 2800);
}
// ---- Error surfacing: console.warn + deduplicated, rate-limited toast (language-aware) ----
const _errSeen = new Map();
let _errLastToast = 0;
function reportErr(ctx, err) {
  const msg = (err && err.message) ? err.message : String(err == null ? '' : err);
  console.warn('[hashem] ' + ctx + ' failed:', err);
  if (/session|expired|unauthorized/i.test(msg)) return; // login screen already handles this
  const now = Date.now();
  const key = ctx + '|' + msg;
  if (now - (_errSeen.get(key) || 0) < 30000) return;   // same error: at most once / 30s
  if (now - _errLastToast < 4000) return;                // any error toast: at most once / 4s
  _errSeen.set(key, now); _errLastToast = now;
  if (_errSeen.size > 50) _errSeen.delete(_errSeen.keys().next().value);
  toastErr(tr('err_' + ctx, tr('err_generic', 'Request failed') + ': ' + ctx), msg.split('\n')[0].slice(0, 160));
}
// ---- Poller: pauses while the tab is hidden, exponential backoff (cap 60s) after failures ----
// fn() resolves truthy/undefined = success, false (or throws) = failure.
function makePoller(fn, baseMs) {
  let fails = 0, timer = null, running = false;
  const delay = () => Math.min(60000, baseMs * Math.pow(2, fails));
  const schedule = () => { clearTimeout(timer); timer = setTimeout(tick, delay()); };
  async function tick() {
    timer = null;
    if (document.hidden) return;                // paused; visibilitychange resumes it
    if (running) { schedule(); return; }
    running = true;
    try { const ok = await fn(); fails = (ok === false) ? Math.min(fails + 1, 10) : 0; }
    catch (e) { fails = Math.min(fails + 1, 10); console.warn('[hashem] poll error', e); }
    finally { running = false; }
    schedule();
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { clearTimeout(timer); fails = 0; tick(); } });
  schedule();
}
// ---- Shared empty / error / loading state blocks (enterprise.css .ent-empty / .ent-skel) ----
const ST_ICO_EMPTY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z"/></svg>';
const ST_ICO_ERR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>';
// o: {title, msg, icon(svg html), actionKey, actionLabel, compact}
function stateEmpty(o) {
  return '<div class="ent-empty' + (o.compact ? ' ent-empty-sm' : '') + '" role="status"><span class="ent-empty-ic" aria-hidden="true">' + (o.icon || ST_ICO_EMPTY) + '</span>'
    + '<b>' + esc(o.title) + '</b>' + (o.msg ? '<span>' + esc(o.msg) + '</span>' : '')
    + (o.actionKey ? '<button type="button" class="hashem-btn hashem-btn-secondary u-btn-xs" data-state-action="' + esc(o.actionKey) + '">' + esc(o.actionLabel || tr('state_retry', 'Retry')) + '</button>' : '')
    + '</div>';
}
function stateError(msg, actionKey, compact) {
  return '<div class="ent-empty ent-error' + (compact ? ' ent-empty-sm' : '') + '" role="alert"><span class="ent-empty-ic" aria-hidden="true">' + ST_ICO_ERR + '</span>'
    + '<b>' + esc(tr('state_error_title', 'Could not load data')) + '</b>'
    + (msg ? '<span class="ent-err-text">' + esc(String(msg).split('\n')[0].slice(0, 200)) + '</span>' : '')
    + (actionKey ? '<button type="button" class="hashem-btn hashem-btn-secondary u-btn-xs" data-state-action="' + esc(actionKey) + '">' + esc(tr('state_retry', 'Retry')) + '</button>' : '')
    + '</div>';
}
// Retry / action buttons re-run the loader that rendered them.
const STATE_ACTIONS = {
  benchmark: () => loadBenchmark(), runbench: () => runBenchmarkClick(), logs: () => loadLogs(),
  errors: () => loadErrors(), status: () => refresh(), rslogs: () => refreshRightSidebarLogs(),
};
document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('[data-state-action]');
  if (!b) return;
  const fn = STATE_ACTIONS[b.dataset.stateAction];
  if (fn) { try { fn(); } catch (err) { reportErr('retry', err); } }
});
// ---- Modal a11y: Escape closes, Tab is trapped inside, focus returns to the opener ----
// Call BEFORE the modal is shown/focused. Returns release() to call when it closes.
function trapModal(ov, onClose) {
  const opener = document.activeElement;
  const onKey = e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
    if (e.key !== 'Tab') return;
    const f = Array.from(ov.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
      .filter(x => !x.disabled && x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (!ov.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', onKey, true);
  return function release() {
    document.removeEventListener('keydown', onKey, true);
    if (opener && opener.focus && document.contains(opener)) { try { opener.focus(); } catch (_) { /* opener gone: nothing to restore */ } }
  };
}
let _csrfToken = '';
function getCSRFToken() {
  if (_csrfToken) return _csrfToken;
  const match = document.cookie.match(/(?:^|; )gre_csrf=([^;]*)/);
  if (match) return decodeURIComponent(match[1]);
  return '';
}
function setCSRFToken(tok) {
  if (tok) _csrfToken = tok;
}
// idle-timeout support: requests made within 30 s of real user input are marked active
let userActiveAt = Date.now();
['pointerdown','keydown','wheel','touchstart'].forEach(ev => window.addEventListener(ev, () => { userActiveAt = Date.now(); }, {passive: true, capture: true}));
async function api(path, body, method) {
  const m = method || (body ? 'POST' : 'GET');
  const headers = {};
  if (Date.now() - userActiveAt < 30000) headers['X-User-Active'] = '1';
  if (body) headers['Content-Type'] = 'application/json';
  if (m === 'POST' || m === 'PATCH' || m === 'DELETE' || m === 'PUT') {
    const csrf = getCSRFToken();
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }
  const r = await fetch(at(path), {
    method: m,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401 && !path.endsWith('/api/login')) {
    showLogin();
    throw new Error('session expired');
  }
  if (!r.ok) {
    const txt = await r.text();
    try {
      const j = JSON.parse(txt);
      if (j.error_code) {
        const e = new Error((j.error_code ? '[' + j.error_code + '] ' : '') + (j.error || r.statusText) + (j.hint ? '\n\u21AA ' + j.hint : ''));
        e.code = j.error_code; e.hint = j.hint; e.steps = j.steps;
        throw e;
      }
    } catch(e) { if (e.code) throw e; }
    throw new Error(txt || r.statusText);
  }
  const data = await r.json();
  if (data && data.csrf_token) setCSRFToken(data.csrf_token);
  return data;
}
function showLogin() { $('login').classList.remove('hidden'); $('app').classList.add('hidden'); }
function showApp() { $('login').classList.add('hidden'); $('app').classList.remove('hidden'); }
// Enterprise confirm modal (replaces native confirm(); same approve/cancel contract).
// confirmYes: danger button label; returns a Promise<boolean>.
let _entModalCleanup = null;
function entConfirm(title, body, confirmYes) {
  return new Promise(resolve => {
    const ov = $('entModal');
    $('entModalTitle').textContent = title;
    $('entModalBody').textContent = body;
    $('entModalYes').textContent = confirmYes || 'Confirm';
    const release = trapModal(ov, () => done(false));
    ov.hidden = false;
    $('entModalYes').focus();
    const done = v => {
      ov.hidden = true;
      release();
      resolve(v);
    };
    if (_entModalCleanup) _entModalCleanup();
    const yes = () => done(true), no = () => done(false);
    $('entModalYes').onclick = yes; $('entModalNo').onclick = no; $('entModalX').onclick = no;
    ov.onclick = e => { if (e.target === ov) done(false); };
    _entModalCleanup = () => { $('entModalYes').onclick = $('entModalNo').onclick = $('entModalX').onclick = null; ov.onclick = null; };
  });
}
// Skeleton blocks for loading states (Dashboard/Logs/Update reuse).
function skel(n) {
  let s = '';
  for (let i = 0; i < (n || 3); i++) s += '<div class="ent-skel" style="height:14px"></div>';
  return '<div style="display:grid;gap:8px">' + s + '</div>';
}
// tabs (sidebar + mobile drawer)
function isBagherLicensed() {
  if (_licenseData && _licenseData.is_valid) {
    const feats = _licenseData.features;
    if (!feats || feats.length === 0) return true;
    for (let i = 0; i < feats.length; i++) {
      const f = String(feats[i]).toLowerCase();
      if (f === '*' || f === 'all' || f === 'bagher' || f === 'frp_ssh') return true;
    }
  }
  if (_sshfwdData && (_sshfwdData.licensed_bagher || _sshfwdData.licensed_frp_ssh)) {
    return true;
  }
  return false;
}

function goTab(name) {
  if (name === 'terminal' && !$('termNav').classList.contains('hidden') && $('tab-terminal').hidden && !termState.ready) { /* allowed: overlay shows connect */ }
  if (name === 'terminal' && $('termNav').classList.contains('hidden')) return; // flag off: tab doesn't exist
  if (name === 'add-peer') { goTab('setup'); const c = $('setupAddPeerStep'); if (c && c.scrollIntoView) c.scrollIntoView({behavior: 'smooth', block: 'start'}); return; }
  if (name === 'sshfwd' && !isBagherLicensed()) {
    if (_licenseData === null) {
      loadLicense().then(() => {
        if (isBagherLicensed()) goTab('sshfwd');
        else openBagherLicModal();
      });
      return;
    }
    openBagherLicModal();
    return;
  }
  if (name === 'cluster' && !isBagherLicensed()) {
    if (_licenseData === null) {
      loadLicense().then(() => {
        if (isBagherLicensed()) goTab('cluster');
        else openBagherLicModal();
      });
      return;
    }
    openBagherLicModal();
    return;
  }
  ['dashboard','tunnel','sshfwd','cluster','setup','logs','perf','watchdog','doctor','benchmark','update','settings','terminal'].forEach(t => { const el = $('tab-'+t); if (el) el.hidden = t !== name; });
  const markTab = b => {
    const on = b.dataset.tab === name;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.setAttribute('tabindex', on ? '0' : '-1');
  };
  document.querySelectorAll('.sidebar-nav [data-tab]').forEach(markTab);
  const dr = $('drawerNav');
  if (dr) dr.querySelectorAll('[data-tab]').forEach(markTab);
  if (name === 'sshfwd') {
    loadSSHFwd();
  }
  if (name === 'cluster') {
    loadClusterStatus();
  }
  if (name === 'perf') { loadPerf(); loadCarrier(); }
  if (name === 'tunnel') { loadCarrier(); loadFleet(); loadTunnelHealth(); }
  if (name === 'watchdog') loadWatchdog();
  if (name === 'doctor') loadDoctor();
  if (name === 'benchmark') loadBenchmark();
  if (name === 'update') loadVersion();
  if (name === 'logs') { refreshLogPeers(); loadLogs(); loadErrors(); armLogFollow(); }
  if (name === 'terminal') termOnShow();
  if (name === 'settings' || name === 'sshfwd') loadLicense();
  if (name === 'dashboard') {
    // tab was hidden: the rAF loop stopped itself; resume it without replaying
    // the draw-in animation (refreshDash() also redraws within 5s anyway).
    const c = $('trafficChart');
    if (c && c._hist && !c._isDown && !c._animId) {
      c._forceAnim = false;
      drawChart(c._hist, c._isDown);
    }
  }
}
document.querySelectorAll('[data-tab]').forEach(b => { b.onclick = () => goTab(b.dataset.tab); });
// mobile drawer: clones the sidebar nav so phone users get a hamburger
// menu instead of the cramped tab strip. Synced with the
// sidebar on terminal-flag, add-peer visibility and update-badge changes.
function drawerSync() {
  const nav = $('drawerNav'); if (!nav) return;
  nav.innerHTML = $('sideNav') ? $('sideNav').innerHTML : '';
  // strip duplicated ids from the clone (single source of truth stays in sidebar)
  nav.querySelectorAll('[data-tab]').forEach(b => {
    b.onclick = () => { goTab(b.dataset.tab); drawerClose(); };
    if (b.id === 'termNav') b.id = '';
    if (b.querySelector('#updBadge')) b.querySelector('#updBadge').id = 'updBadgeM';
  });
  // hide the terminal entry in the drawer while the flag is off
  const t = nav.querySelector('[data-tab="terminal"]');
  if (t && $('termNav') && $('termNav').classList.contains('hidden')) t.classList.add('hidden');
  const bd = nav.querySelector('#updBadgeM');
  const src = $('updBadge');
  if (bd && src) bd.classList.toggle('hidden', src.classList.contains('hidden'));
  const cur = document.querySelector('.sidebar-nav [data-tab].on');
  nav.querySelectorAll('[data-tab]').forEach(b => {
    const on = !!cur && b.dataset.tab === cur.dataset.tab;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.setAttribute('tabindex', on ? '0' : '-1');
  });
}
// Roving-tabindex keyboard nav for the tablist (Arrow Up/Down/Left/Right, Home, End).
function tabKeyNav(e) {
  const tab = e.target.closest && e.target.closest('[role="tab"]');
  if (!tab) return;
  const list = Array.from(tab.parentElement.querySelectorAll('[role="tab"]')).filter(b => !b.classList.contains('hidden') && b.offsetParent !== null);
  const i = list.indexOf(tab);
  if (i < 0) return;
  const rtl = document.documentElement.dir === 'rtl';
  let n = -1;
  if (e.key === 'ArrowDown' || (e.key === 'ArrowRight' && !rtl) || (e.key === 'ArrowLeft' && rtl)) n = (i + 1) % list.length;
  else if (e.key === 'ArrowUp' || (e.key === 'ArrowLeft' && !rtl) || (e.key === 'ArrowRight' && rtl)) n = (i - 1 + list.length) % list.length;
  else if (e.key === 'Home') n = 0;
  else if (e.key === 'End') n = list.length - 1;
  if (n < 0) return;
  e.preventDefault();
  list[n].focus();
  if (tab.closest('#drawerNav')) goTab(list[n].dataset.tab); // keep the drawer open while arrowing
  else list[n].click(); // automatic activation: selecting follows focus
}
['sideNav', 'drawerNav'].forEach(id => { const n = $(id); if (n) n.addEventListener('keydown', tabKeyNav); });
let _drawerOpener = null;
function drawerOpen() {
  _drawerOpener = document.activeElement;
  drawerSync(); $('drawer').classList.add('open'); $('drawerOv').classList.add('open');
  const cur = $('drawerNav').querySelector('[role="tab"][aria-selected="true"]') || $('drawerX');
  if (cur) cur.focus();
}
function drawerClose() {
  const wasOpen = $('drawer').classList.contains('open');
  $('drawer').classList.remove('open'); $('drawerOv').classList.remove('open');
  if (wasOpen && _drawerOpener && _drawerOpener.focus && document.contains(_drawerOpener)) { try { _drawerOpener.focus(); } catch (_) { /* opener gone */ } }
  _drawerOpener = null;
}
$('menuBtn').onclick = drawerOpen;
$('drawerX').onclick = drawerClose;
$('drawerOv').onclick = drawerClose;
document.addEventListener('keydown', e => { if (e.key === 'Escape') drawerClose(); });
$('themeBtnM').onclick = () => setTheme(document.body.dataset.t === 'dark' ? 'light' : 'dark');
$('logoutBtnM').onclick = async () => { try { await api('/api/logout', {}); } catch(e){ /* logout best-effort: always fall through to login screen */ } showLogin(); };
drawerSync();
// theme (hashem-style: localStorage + data-t on html and body)
function setTheme(t) {
  document.documentElement.dataset.t = t; document.body.dataset.t = t;
  try { localStorage.setItem('gre_theme', t); } catch(e) { /* storage blocked (private mode): theme just won't persist */ }
  const b = $('themeBtn');
  if (b) { const lab = t === 'dark' ? '☀️ Light' : '🌙 Dark', sp = b.querySelector('.sf-t');
    if (sp) { sp.textContent = lab; sp.removeAttribute('data-i18n'); } else b.textContent = lab;
    b.setAttribute('aria-label', lab.replace(/^\S+\s/, '')); b.removeAttribute('data-i18n-aria'); }
  const bm = $('themeBtnM'); if (bm) bm.textContent = t === 'dark' ? '☀️ Light' : '🌙 Dark';
  try { if (typeof refreshDash === 'function') refreshDash(); } catch(e) { /* dashboard not ready yet; polling repaints it */ }
}
$('themeBtn').onclick = () => setTheme(document.body.dataset.t === 'dark' ? 'light' : 'dark');
try { setTheme(localStorage.getItem('gre_theme') || document.body.dataset.t || 'dark'); } catch(e) { /* storage blocked: keep default theme */ }

// i18n & Persian (Farsi) Language System
const I18N = {
  en: {
    nav_dashboard: "Dashboard",
    nav_tunnel: "Tunnel",
    nav_sshfwd: "Bagher",
    nav_bagher: "Bagher",
    nav_cluster: "Cluster",
    nav_setup: "Setup",
    nav_logs: "Logs",
    nav_perf: "Performance",
    perf_mux_title: "TCP Multiplexing (transport.tcpMux)",
    perf_mux_hint: "Packs every user stream into ONE TCP connection between frpc and frps. Measured over GRE it roughly halves tunnel throughput (e.g. 460 vs 1010 Mbit on Finland). Default is OFF (max speed). It must be identical on the Iran hub AND every foreign server, otherwise frpc cannot log in.",
    nav_watchdog: "Watchdog",
    nav_doctor: "Diagnostics",
    nav_benchmark: "Benchmark",
    nav_update: "Update",
    upd_channel: "Update channel",
    upd_channel_stable: "Stable",
    upd_channel_dev: "Dev",
    upd_dev_warn: "Dev channel: test builds, may break. Not for production tunnels.",
    upd_dev_badge: "DEV",
    nav_settings: "Settings",
    nav_terminal: "Terminal",
    sec_overview: "Overview",
    sec_tunnel: "Tunnel",
    sec_system: "System",
    theme: "Theme",
    logout: "Logout",
    refresh: "Refresh",
    kpi_traffic: "Traffic & Speed",
    kpi_status: "Tunnel Status",
    kpi_links: "Links (GRE / FRP)",
    kpi_latency: "Latency",
    kpi_cpu: "CPU",
    kpi_ram: "RAM",
    kpi_disk: "Disk",
    kpi_conns: "Uptime / Conns",
    details: "Details",
    chart_traffic_title: "Tunnel Traffic Throughput",
    chart_traffic_sub: "Real-time download and upload speeds over time",
    chart_activity_title: "Tunnel Activity & Connections",
    chart_activity_sub: "Active concurrent connections and session stream over time",
    download: "Download",
    upload: "Upload",

    // General
    status_active: "Active",
    status_down: "Down",
    status_healthy: "Healthy",
    status_connected: "Connected",
    status_disconnected: "Disconnected",
    status_unreachable: "Unreachable",
    status_running: "Running",
    status_stopped: "Stopped",
    status_error: "Error",
    actions: "Actions",
    confirm: "Confirm",
    apply: "Apply",
    copy: "Copy",
    copied: "Copied!",
    remove: "Remove",
    restart: "Restart",
    ping: "Ping",
    bundle: "Bundle",
    show_bundle: "Show Bundle",
    copy_bundle: "Copy Bundle",
    test: "Test",
    switch: "Switch",
    current: "Current",
    loading: "Loading…",
    save_settings: "Save Settings",

    // Dashboard Details & Cards
    card_server_title: "Server & Role",
    card_gre_title: "GRE Kernel Tunnel",
    card_frp_title: "FRP Relay & Traffic",
    card_peers_title: "Peer Tunnels",
    lbl_public_ip: "Public IP",
    lbl_role: "Role",
    lbl_forwarded_ports: "Forwarded Ports",
    lbl_gre_local: "Local GRE IP",
    lbl_gre_peer: "Peer GRE IP",
    lbl_gre_interface: "Interface",
    lbl_frp_status: "Status",
    lbl_control_port: "Control Port",
    lbl_bind_port: "Bind Port",
    lbl_tunnel_ports: "Tunnel Ports",
    lbl_uptime_since: "Active Since",
    lbl_peer_name: "Name",
    lbl_peer_id: "ID",
    lbl_peer_foreign_ip: "Foreign IP",
    lbl_peer_ports: "Ports",
    lbl_peer_latency: "Ping Latency",

    // Tunnel Tab
    tun_title: "Tunnel Topology & Status",
    tun_sub: "Live link metrics, peer inventory, and interface health",
    tun_main_card: "Main Link (Hub / Spoke 1)",
    tun_add_peer_btn: "+ Connect Another Server",
    tun_view_bundle_btn: "📦 View Setup Bundle",

    // Setup Tab
    setup_title: "Quick setup — GRE + FRP tunnel",
    setup_sub: "Two servers, one tunnel. Answer on this machine; the Iran side gives you a token to paste on the Foreign side.",
    setup_step1: "1. Which server am I on right now?",
    setup_role_iran: "Iran — users connect here",
    setup_role_foreign: "Foreign — service runs here",
    setup_step2_engine: "2. Tunnel Engine",
    setup_eng_frp: "🚀 GRE + FRP",
    setup_eng_grebh: "⚡ GRE + Backhaul",
    setup_eng_bh: "🌐 Backhaul (No-GRE)",
    setup_step3_params: "3. Connection Parameters",
    setup_local_pub: "Iran public IP (auto, editable)",
    setup_remote_pub: "Remote public IP (the other server)",
    setup_local_gre: "Local GRE IP",
    setup_peer_gre: "Peer GRE IP",
    setup_ctrl_port: "Control / Bind port",
    setup_transport: "Transport Protocol",
    setup_forward_ports: "Forwarded Ports (single, ranges, mappings)",
    setup_step4_token: "4. Token & apply",
    setup_apply_btn: "Apply setup",
    setup_unlock_btn: "Unlock to replace",
    setup_relock_btn: "Keep locked",
    setup_bundle_title: "📦 Setup Bundle (Copy to Foreign server)",
    setup_foreign_step2: "2. Join tunnel (from Iran bundle)",
    setup_bundle_paste_lbl: "Setup bundle or token (from Iran side)",
    setup_bundle_paste_ph: "paste hsh1_..., bh1_..., or gh1_... bundle",
    setup_join_btn: "Connect to Iran",
    setup_foreign_step3: "3. Advanced (optional)",
    setup_add_peer_title: "➕ Connect another foreign server",
    setup_peer_name_lbl: "Name (label for this tunnel)",
    setup_add_tunnel_btn: "Add tunnel",

    // Performance & Tuning Tab
    perf_status_pool: "Work-conn pool (frpc / frps)",
    perf_status_decision: "Auto Pool decision",
    perf_mode_auto: "Auto Pool",
    perf_mode_manual: "Manual",
    perf_ap_title: "Auto Pool (FRP work connections)",
    perf_ap_sub: "Sizes frpc poolCount and frps maxPoolCount from pool-full errors, active connections, CPU and free RAM. Scales up fast, scales down slowly, restarts only frpc and only when few users are connected.",
    perf_ap_toggle: "Auto Pool (recommended)",
    perf_ap_toggle_hint: "When off, the manual values below are written to frpc.toml / frps.toml as typed.",
    perf_ap_last_decision: "Last decision",
    perf_ap_errors: "Pool-full errors (last tick)",
    perf_ap_last_restart: "Last frpc restart",
    perf_ap_frps_note: "maxPoolCount was raised in frps.toml; restart frps during a quiet period to apply it.",
    perf_ap_saved: "Auto Pool updated",
    perf_ap_on_msg: "Pool is resized automatically every minute.",
    perf_ap_off_msg: "Manual values apply after Save & Apply.",
    perf_pool_count: "Client Pool Count (frpc)",
    perf_pool_sub: "Pre-opened work connections on foreign spokes.",
    perf_max_pool: "Max Pool Count (frps)",
    perf_max_sub: "Server-side maximum work connection headroom (always at least 1.5 × poolCount).",
    perf_save_tuning: "💾 Save & Apply Capacity",
    perf_carrier_title: "Carrier & UDP Encapsulation (FOU)",
    perf_carrier_save: "Save Mode",

    // Watchdog
    wd_title: "Tunnel Watchdog",
    wd_hint: "Monitors GRE ping and FRP service every 1 minute. Sends Telegram alerts and optional auto-restart after consecutive failures.",
    wd_autorestart_label: "Auto-Restart on Failure",
    wd_autorestart_sub: "(Disabled by default to prevent CPU spike storms; alerts only)",
    wd_health: "Tunnel Health",
    wd_fails: "Consecutive Fails",
    wd_last_check: "Last Check",
    wd_restart_title: "Tunnel Auto-Restart Schedule",
    wd_restart_hint: "Periodically refreshes the tunnel interfaces and restarts FRP/Backhaul relay services gracefully without interrupting the web panel or losing configuration.",
    wd_restart_interval: "Restart Interval",
    wd_restart_save: "Save Schedule",
    wd_restart_now: "Restart Tunnel Now",
    wd_tg_title: "Telegram Alerts",
    wd_tg_hint: "Receive instant Telegram notifications when the tunnel drops or recovers. Middle of bot token is never exposed.",
    wd_tg_token: "Bot Token",
    wd_tg_chat: "Chat ID",
    wd_tg_route: "Telegram Route",
    wd_tg_save: "Save Telegram Settings",
    wd_tg_test: "Test Alert",
    wd_backup_title: "Encrypted Backups",
    wd_backup_hint: "Full backup of FRP tomls, panel settings, peers registry, and systemd units encrypted with OpenSSL AES-256-CBC keyed from your panel password.",
    wd_backup_now: "Create Backup Now",
    wd_backup_sched: "Backup Schedule",
    wd_backup_save: "Save Schedule",
    wd_events_title: "Watchdog Event Log",

    // Benchmark Tab
    bench_title: "Carrier Benchmark & Auto-Pilot",
    bench_peer_link_title: "Inter-Panel Link (Peer)",
    bench_peer_link_sub: "Master/Worker dual-path synchronization with remote panel.",
    bench_peer_test_btn: "Test Connection",
    bench_peer_cfg_btn: "Configure Link",
    bench_failover_title: "Automatic Failover",
    bench_failover_sub: "Strictly OFF by default. When OFF, the tunnel never switches automatically.",
    bench_failover_toggle: "Enable Automatic Failover (Auto-Switching)",
    bench_failover_threshold: "Packet Loss Trigger Threshold (%)",
    bench_failover_save: "Save Failover Policy",
    bench_leaderboard_title: "Carrier Performance Leaderboard",
    bench_run_btn: "Run Carrier Benchmark",
    bench_tbl_rank: "Carrier & Route",
    bench_tbl_trans: "Transport",
    bench_tbl_port: "Port",
    bench_tbl_rtt: "Latency (RTT)",
    bench_tbl_loss: "Packet Loss",
    bench_tbl_jitter: "Jitter",
    bench_tbl_score: "Quality Score",
    bench_tbl_status: "Status",
    bench_tbl_action: "Action",

    // Diagnostics / Doctor Tab
    doc_title: "Network Doctor & Diagnostic Suite",
    doc_sub: "Automated end-to-end path tests, MTU probe, socket exhaustion check, and routing health",
    doc_run_btn: "Run Full Diagnostics",
    doc_fix_btn: "Quick Repair & Optimize",
    doc_fix_box_btn: "Auto-Fix Detected Issues",
    doc_issues_title: "Issues & Recommendations",

    // Logs Tab
    logs_title: "System & Tunnel Service Logs",
    logs_sub: "Real-time journal logs for FRP services, GRE interfaces, and watchdog events",
    logs_svc_label: "Service",
    logs_lines_label: "Lines",
    logs_refresh_btn: "Refresh Logs",
    logs_copy_btn: "Copy Logs",

    // Settings & Update Tab
    settings_title: "Panel Security & Password",
    settings_cur_pass: "Current panel password",
    settings_new_pass: "New panel password",
    settings_change_btn: "Change Password",
    update_title: "Panel update",
    update_current: "Installed version",
    update_check_btn: "Check for updates",

    // Terminal Tab
    term_title: "Interactive Web Console (PTY)",
    term_connect: "Connect Terminal",
    term_clear: "Clear Screen",

    // Right Sidebar & Modals
    login_sub: "Sign in with your username and password",
    login_user_ph: "Username",
    login_pass_ph: "Password",
    login_signin: "Sign in",
    rs_header: "Live Activity Stream",
    rsc_title: "Connectivity Rescue", rsc_remote: "Reachable server (the one that can connect to this server)", rsc_ports: "Ports to connect (TCP + UDP)",
    rsc_code: "Rescue code from the blocked server", rsc_ban_t: "This server cannot connect to its peer",
    rsc_ban_d: "Ping works but every TCP connection is dropped on the way. A one-click fix reverses the connection direction.", rsc_ban_go: "Fix it",
    rsc_idle_ok: "No problem detected. If a peer can ping you but connections time out, this tool reverses the direction automatically.",
    rsc_idle_warn: "A one-way block was detected: ping works but TCP is dropped. Enable Rescue to reverse the direction.",
    rsc_b_off: "Off", rsc_b_susp: "Block detected", rsc_b_on: "Active", rsc_b_on_auto: "Active (Auto)", rsc_b_wait: "Waiting for peer", rsc_b_lift: "Block lifted",
    rsc_check: "Check now", rsc_enable: "Enable Rescue", rsc_join: "Join with code", rsc_apply: "Apply code", rsc_disable: "Disable and remove",
    rsc_cancel: "Cancel", rsc_getcode: "Show rescue code", rsc_copy: "Copy code", rsc_nocfg: "frp binaries are missing on this server. Run hashem update first.",
    rsc_origin: "This server is the blocked side. {n} port(s) are forwarded through {ip}.", rsc_origin_auto: "One-way block detected: connectivity automatically established through {ip} ({n} ports forwarded).", rsc_entry: "This server is the entry. {n} port(s) are served here and tunnelled to {ip}.", rsc_entry_auto: "This server is acting as the entry for {ip} ({n} ports tunnelled).",
    rsc_skipped: "Skipped (busy or reserved): {p}", rsc_conn: "Control link", rsc_conn_ok: "connected", rsc_conn_no: "not connected yet",
    rsc_svc: "Services", rsc_direct: "Kernel forward (full speed)", rsc_relay: "FRP relay (filtered path)", rsc_auto: "The other panel picks this up by itself within a few minutes if the two panels are paired. Otherwise use the code.",
    rsc_lift: "The direct route works again. You can disable Rescue and use the normal tunnel.",
    rsc_confirm_t: "Enable Connectivity Rescue?", rsc_confirm_b: "This starts three small services here and opens one firewalled control port. The reachable server is the only host allowed to use it. You can remove everything with one click.",
    rsc_dis_t: "Remove Rescue?", rsc_dis_b: "The forwarded ports on the entry server stop working until the normal tunnel is up.",
    rsc_probe_ok: "Peer reachable", rsc_probe_block: "One-way block confirmed", rsc_probe_down: "Peer unreachable (outage, not a block)", rsc_probe_svc: "Peer reachable but its panel is not listening",
    rsc_done: "Rescue enabled", rsc_removed: "Rescue removed", rsc_copied: "Copied",
    pal_open: "Search and commands", pal_search: "Search", pal_title: "Command palette", pal_ph: "Search pages and actions…",
    pal_nav: "navigate", pal_run: "run", pal_close: "close", pal_none: "Nothing matches", pal_go: "Go to", pal_act: "Actions", pal_look: "Appearance",
    pal_refresh: "Refresh data", pal_theme: "Toggle dark / light theme", pal_lang: "Switch language", pal_stream: "Show / hide Live Activity Stream",
    pal_sidebar: "Collapse / expand sidebar", pal_density: "Toggle table density", pal_diag: "Run diagnostics", pal_donate: "Support Hashem", pal_logout: "Log out",
    pal_accent: "Accent colour",
    sb_collapse: "Collapse sidebar", sb_expand: "Expand sidebar",
    tbl_filter: "Filter errors…", tbl_shown: "{n} of {t} shown",
    dens_title: "Table density", dens_comfy: "Comfortable", dens_compact: "Compact",
    onb_title: "Welcome to Hashem", onb_sub: "No tunnel yet. Three steps and you are live.",
    onb_s1: "Choose this server's role", onb_s1d: "Iran hub (server) or foreign server (client) from the Setup tab.",
    onb_s2: "Link the other server", onb_s2d: "Create the tunnel and paste the connection bundle on the other side.",
    onb_s3: "Verify and optimise", onb_s3d: "Run Diagnostics, then Optimize in the Tunnel tab.",
    onb_go: "Open Setup", onb_later: "Not now", onb_dismiss: "Dismiss",
    badge_tunnel: "{n} tunnel(s) need attention", badge_doctor: "{n} diagnostic issue(s)",
    fleet_title: "Fleet health",
    fleet_all_ok: "All servers healthy",
    fleet_some: "{n} of {t} servers need attention",
    fleet_all_down: "All servers are down",
    fleet_meta: "Updated {time} · sampled every {s}s · last hour",
    fleet_hub: "Iran hub",
    fleet_healthy: "Healthy",
    fleet_degraded: "Degraded",
    fleet_down: "Down",
    fleet_avg: "Avg",
    fleet_loss: "Loss",
    fleet_uptime: "Uptime",
    fleet_nodata: "Collecting data…",
    fleet_frp_only: "FRP only",
    fleet_icmp_filtered: "ICMP filtered",
    fleet_session_up: "session up",
    fleet_updated: "updated",
    fleet_ago: "ago",
    dial_title: "Route to the Iran hub", dial_hint: "How this server reaches Iran: over the GRE inner IP, directly to the hub's public IP, or Auto (GRE when it works, public IP otherwise).", dial_auto: "Auto", dial_gre: "GRE inner IP", dial_public: "Public IP", dial_public_btn: "Iran public IP",
    fleet_topo_aria: "Tunnel topology: {hub} connected to {n} servers",
    fleet_ring_aria: "{h} of {t} servers healthy",
    rs_hide_aria: "Hide live activity stream",
    rs_hidden_toast: "Live Activity Stream hidden",
    rs_hidden_sub: "Bring it back from Logs → Live Activity Stream",
    rs_restore_hint: "Side panel with the latest events. Wide screens (1200px+) only.",
    rs_btn_hide: "Hide",
    rs_btn_show: "Show",
    sup_title: "Enjoying a stable tunnel?",
    sup_body: "Hashem is free and built by one developer. If it keeps your connection alive, a small donation helps keep it improving.",
    sup_donate: "Donate",
    sup_later: "Maybe later",
    sup_snooze: "Don't remind me for 30 days",
    sup_card_title: "Support Hashem",
    sup_card_hint: "Hashem is free. If it helps you, you can support its development any time.",
    appear_title: "Appearance",
    appear_hint: "Pick an accent colour. Every preset is contrast-checked for both dark and light themes.",
    appear_aria: "Accent colour",
    acc_blue: "Blue", acc_indigo: "Indigo", acc_violet: "Violet", acc_rose: "Rose", acc_emerald: "Emerald", acc_teal: "Teal", acc_orange: "Orange",
    rs_waiting: "Waiting for logs...",
    edit_tunnel_title: "Edit Tunnel",
    edit_tunnel_sub: "Modify tunnel parameters, carrier protocol, or forwarded ports. Changes apply immediately.",
    carrier_title: "Carrier Selection / Policy",
    save_carrier: "Save Mode",
    connect_iran: "Connect to Iran",
    reverse_ports: "Reverse ports (ranges & mappings allowed)",
    disabled: "Disabled",
    enabled: "Enabled",
    save: "Save",
    cancel: "Cancel",
    close: "Close",
    x002: "Iran",
    x003: "Foreign",
    x004: "[ ON ] Auto-Switching",
    x005: "[ OFF ] Manual Mode",
    x006: "Stable / Zero Drops",
    x007: "Engine",
    x008: "Carrier & Failover",
    x009: "Active Carrier",
    x010: "Failover Policy",
    x011: "Diagnostics",
    x012: "tunnel up",
    x013: "Open full card in Tunnel tab",
    x014: "All diagnostic tests passed with zero bottlenecks. Connection is operating at peak performance.",
    x015: "Recommendation: Run automated repair to resolve bottlenecks and optimize parameters.",
    x016: "Auto-Fix Detected Issues",
    x017: "Diagnosing… (sweep MTU & ping)",
    x018: "Diagnostics complete",
    x019: "Health score",
    x020: "Diagnostics failed",
    x021: "Run Diagnostics",
    x022: "Apply Automated Optimizations?",
    x023: "This will enable TCP BBR, configure MSS clamping, ensure IPv4 forwarding, tune FRP concurrency limits, and restore tunnel interface connectivity.",
    x024: "Repair & Optimize",
    x025: "Applying fixes…",
    x026: "Applying…",
    x027: "Optimizations applied",
    x028: "System stack optimized",
    x029: "Fix failed",
    x030: "Quick Repair & Optimize",
    x031: "Active route",
    x032: "Best round-trip",
    x033: "Zero loss link",
    x034: "Packet drop rate",
    x035: "Last benchmark",
    x036: "candidates probed",
    x037: "None",
    x038: "No benchmark metrics yet. Click \"Run Carrier Benchmark\".",
    x039: "Healthy",
    x040: "Good",
    x041: "Warning",
    x042: "Down",
    x043: "Raw 47",
    x044: "ACTIVE",
    x045: "BEST",
    x046: "Current",
    x047: "Switch",
    x048: "Probing carriers...",
    x049: "Benchmarking carriers",
    x050: "Probing GRE, WSS, TCP, KCP, QUIC, and WS...",
    x051: "Benchmark Complete",
    x052: "Best Carrier",
    x053: "Benchmark failed",
    x054: "Applying carrier",
    x055: "Carrier Applied",
    x056: "Apply failed",
    err_generic: "Request failed",
    state_retry: "Retry",
    state_error_title: "Could not load data",
    rs_empty_title: "No log lines yet",
    rs_waiting_sys: "Waiting for system logs...",
    empty_bench_title: "No benchmark metrics yet",
    empty_bench_msg: "Run a carrier benchmark to compare protocols.",
    empty_peers_title: "No peer tunnels yet",
    empty_peers_msg: "Add one from Setup → Add another foreign server.",
    empty_logs_title: "No log lines",
    empty_logs_msg: "Nothing to show for this service yet.",
    empty_errors_title: "No panel errors",
    empty_errors_msg: "Clean run — every failure will appear here with its code.",
    aria_close: "Close",
    aria_menu: "Menu",
    aria_main_nav: "Main navigation",
    aria_toggle_visibility: "Toggle visibility",
    aria_copy: "Copy",
    aria_edit_ports: "Edit ports",
    aria_close_search: "Close search",
    aria_close_proxy: "Close proxy configuration",
    aria_font_smaller: "Smaller font",
    aria_font_larger: "Larger font",
    aria_fullscreen: "Fullscreen",
    err_status: "Refresh failed",
    err_dashboard: "Dashboard refresh failed",
    err_carrier: "Carrier status failed",
    err_peers: "Peers load failed",
    err_setup: "Setup defaults failed",
    err_logs: "Logs load failed",
    err_errors: "Error history failed",
    err_rslogs: "Live log stream failed",
    err_benchmark: "Benchmark load failed",
    err_peerlink: "Peer link status failed",
    err_bundle: "Bundle lookup failed",
    err_retry: "Retry failed",
    carrier_switch_confirm: "Switch both Iran & Foreign servers to carrier \"{id}\"?"
  },
  fa: {}
};

let currentLang = 'en';

function setLanguage(lang) {
  currentLang = (lang === 'fa') ? 'fa' : 'en';
  try { localStorage.setItem('hashem_lang', currentLang); } catch(e) { /* storage blocked */ }
  document.documentElement.setAttribute('dir', currentLang === 'fa' ? 'rtl' : 'ltr');
  document.documentElement.setAttribute('lang', currentLang);
  if (currentLang === 'fa') {
    document.body.classList.add('is-rtl');
  } else {
    document.body.classList.remove('is-rtl');
  }
  applyTranslations(currentLang);
}

function applyTranslations(lang) {
  const dict = I18N[lang] || I18N.en;
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    if (dict[key]) {
      if (el.tagName === 'INPUT' && (el.type === 'button' || el.type === 'submit')) {
        el.value = dict[key];
      } else {
        el.textContent = dict[key];
      }
    }
  });
  document.querySelectorAll('[data-i18n-aria]').forEach(el => {
    const v = dict[el.dataset.i18nAria];
    if (v) el.setAttribute('aria-label', v);
  });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => {
    const key = el.dataset.i18nPh;
    if (dict[key]) {
      el.placeholder = dict[key];
    }
  });
  if (typeof rsSync === 'function') rsSync();
  if (typeof sbApply === 'function') sbApply();
  if (typeof densApply === 'function') densApply();
  if (typeof accRender === 'function') accRender();
  if (typeof fleetRender === 'function' && typeof _fleetLast !== 'undefined' && _fleetLast) fleetRender(_fleetLast);
  if (typeof drawerSync === 'function') drawerSync();
  try { if (typeof rscRender === 'function') rscRender(); } catch (e) { /* first call runs before the rescue state exists */ }
}

function tr(k, fb) {
  return (I18N[currentLang] && I18N[currentLang][k]) ? I18N[currentLang][k] : (fb || k);
}

function toggleLang() {
  setLanguage(currentLang === 'fa' ? 'en' : 'fa');
}

if ($('langToggleBtn')) $('langToggleBtn').onclick = toggleLang;
if ($('langToggleBtnM')) $('langToggleBtnM').onclick = toggleLang;
try { setLanguage(localStorage.getItem('hashem_lang') || 'en'); } catch(e) { /* storage blocked: stay on default language */ }

function dot(ok) { return `<span class="dot ${ok ? 'up' : 'down'}"></span>`; }
// Shared detail-card icons + builder (Dashboard AND peer cards use these;
// keep global so renderPeers works even when refreshDash never ran).
const ICO_SRV = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><circle cx="7" cy="7.5" r="1" fill="currentColor"/><circle cx="7" cy="16.5" r="1" fill="currentColor"/></svg>';
const ICO_GRE = '<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>';
const ICO_FRP = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>';
function setBtnLoading(btn, isLoading, loadingText) {
  if (!btn) return;
  if (isLoading) {
    if (!btn.dataset.origHtml) btn.dataset.origHtml = btn.innerHTML;
    btn.disabled = true;
    btn.classList.add('is-loading');
    btn.innerHTML = '<span class="ent-spinner"></span> ' + (loadingText || 'Working…');
  } else {
    btn.disabled = false;
    btn.classList.remove('is-loading');
    if (btn.dataset.origHtml) {
      btn.innerHTML = btn.dataset.origHtml;
      delete btn.dataset.origHtml;
    }
  }
}
function peerAct(action, peerId) {
  return (async () => {
    const btn = document.querySelector(`[data-peer-act="${action}-${peerId}"]`);
    const actLabels = { restart: 'Restarting…', stop: 'Stopping…', start: 'Starting…', ping: 'Pinging…' };
    const label = actLabels[action] || (action + '…');
    setBtnLoading(btn, true, label);
    try {
      const r = await api('/api/action', {action, peer_id: peerId});
      $('actOut').classList.remove('hidden');
      $('actOut').textContent = r.output || 'ok';
      toastOk(action + ' ok', r.output ? String(r.output).slice(0, 120) : '');
      refresh();
    } catch(e) { toastErr(action + ' failed', e.message); refresh(); }
    finally { setBtnLoading(btn, false); }
  })();
}
// Inline two-step remove: first click arms (5s + Undo), second click deletes.
// No modal — the confirm lives inside the card so it works from any tab.
const peerRemoveTimers = {};
function armRemovePeer(peerId, name) {
  const box = $('peer-confirm-' + peerId);
  if (!box) return;
  const btns = document.querySelectorAll(`[data-peer-remove="${peerId}"]`);
  btns.forEach(b => { b.classList.add('armed'); b.innerHTML = '⚠️ Confirm 5s <span class="peer-count" data-peer-n="' + peerId + '">5</span>'; });
  box.classList.remove('hidden');
  box.innerHTML = `<div class="peer-confirm-in">Remove <b>${esc(name)} (#${peerId})</b>? GRE + frps go away; other tunnels keep running. <button class="hashem-btn hashem-btn-ghost u-btn-28" onclick="disarmRemovePeer(${peerId})">Undo</button></div>`;
  clearTimeout(peerRemoveTimers[peerId]); clearInterval(peerRemoveTimers[peerId + '_n']);
  let n = 5;
  peerRemoveTimers[peerId + '_n'] = setInterval(() => {
    n--; const el = document.querySelector(`[data-peer-n="${peerId}"]`); if (el) el.textContent = n;
    if (n <= 0) clearInterval(peerRemoveTimers[peerId + '_n']);
  }, 1000);
  peerRemoveTimers[peerId] = setTimeout(() => disarmRemovePeer(peerId), 5000);
}
function disarmRemovePeer(peerId) {
  clearTimeout(peerRemoveTimers[peerId]); clearInterval(peerRemoveTimers[peerId + '_n']);
  const box = $('peer-confirm-' + peerId);
  if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
  document.querySelectorAll(`[data-peer-remove="${peerId}"]`).forEach(b => { b.classList.remove('armed'); b.textContent = 'Remove'; b.disabled = false; });
}
async function removePeer(peerId, name) {
  disarmRemovePeer(peerId);
  const btns = document.querySelectorAll(`[data-peer-remove="${peerId}"]`);
  btns.forEach(b => { b.disabled = true; b.innerHTML = '<span class="ent-spinner"></span> Removing…'; });
  try {
    await api('/api/action', {action: 'remove-tunnel', peer_id: peerId});
    toastOk(`tunnel '${name}' removed`);
    refresh();
  } catch(e) { toastErr('remove failed', e.message); refresh(); }
}
async function showPeerToken(peerId, name) {
  try {
    const r = await api('/api/peers?id=' + peerId);
    const show = r.bundle || r.token || '';
    toastOk(`bundle for '${name}'`, show + ' (also in logs)');
    $('actOut').classList.remove('hidden');
    $('actOut').textContent = `Bundle for '${name}': ${show}\nForeign side: paste it into the token field (fills everything). Legacy token: ${r.token || '—'}`;
  } catch(e) { toastErr('token lookup failed', e.message); }
}
function renderPeers(peers) {
  const box = $('peerCards');
  if (!box) return;
  tunPeerCache = peers || null;
  try { renderTunChips(window._lastLocal || null); } catch(_){ /* chips are cosmetic; cards still render */ }
  const b = (_sshfwdData || (window._lastDash && window._lastDash.bagher) || window._lastBagher || {});
  const bagherUp = !!(b.is_active || b.enabled || b.connected);
  const bagherHasCfg = !!(bagherUp || b.has_config || (b.remote_host && b.remote_host.length) || (Array.isArray(b.ports) && b.ports.length));
  
  let bagherCardHtml = '';
  if (bagherHasCfg) {
    const fwdPorts = Array.isArray(b.ports) ? b.ports.join(', ') : (b.ports || '—');
    const roleLabel = b.role === 'foreign' ? 'Foreign Client' : 'Iran Hub';
    bagherCardHtml = `<div class="tunnel-card peer-card u-peer-card-wide" id="peer-card-bagher" style="border:1px solid rgba(16,185,129,0.3); background:linear-gradient(135deg, rgba(15,23,42,0.85) 0%, rgba(6,78,59,0.2) 100%);">
      <div class="tc-header u-flex-wrap-gap8">
        <div class="u-flex-center-gap10">
          <span class="status-indicator ${bagherUp ? 'active' : 'offline'}"><span class="dot"></span></span>
          <b class="u-fs-16-tx">Bagher Tunnel</b>
          <span class="qs-hint mono">#stealth</span>
          <span class="badge" style="background:rgba(16,185,129,0.18);color:#10b981;border:1px solid rgba(16,185,129,0.35);font-weight:700">🟢 Bagher Engine</span>
          <span class="badge" style="background:rgba(255,255,255,0.06);color:var(--mu);font-size:12px">${esc(roleLabel)}</span>
          <span class="badge ${bagherUp ? 'ok' : 'err'}"><span class="dot"></span>${bagherUp ? 'active' : 'inactive'}</span>
        </div>
      </div>
      <div class="det-grid">
        <div class="det-card">
          <div class="det-card-head">${ICO_SRV} <span>Bagher Node</span></div>
          <div class="det-row"><span class="det-k">Foreign Endpoint</span><span class="det-v mono">${esc(b.remote_host || '—')}</span></div>
          <div class="det-row"><span class="det-k">Role</span><span class="det-v mono">${esc(roleLabel)}</span></div>
          <div class="det-row"><span class="det-k">Forwarded</span><span class="det-v mono">${esc(fwdPorts)}</span></div>
        </div>
        <div class="det-card">
          <div class="det-card-head">⚡ <span>Link Status</span></div>
          <div class="det-row"><span class="det-k">Status</span><span class="det-v"><span class="badge ${bagherUp ? 'ok' : 'err'}"><span class="dot"></span>${bagherUp ? 'Running' : 'Stopped'}</span></span></div>
          <div class="det-row"><span class="det-k">Latency</span><span class="det-v mono" style="color:#38bdf8">${(typeof b.latency_ms === 'number' && b.latency_ms > 0) ? (b.latency_ms.toFixed(1) + ' ms') : (bagherUp ? 'Optimal' : '—')}</span></div>
          <div class="det-row"><span class="det-k">Services</span><span class="det-v mono">${esc(b.active_services || (bagherUp ? 'frps, frpc, ssh-fwd' : 'none'))}</span></div>
        </div>
      </div>
      <div class="tc-acts u-flex-gap-8 u-mt-4">
        <button class="hashem-btn hashem-btn-secondary" onclick="openBagherQuickEdit()">✏️ Quick Edit</button>
        <button class="hashem-btn hashem-btn-secondary" onclick="goTab('sshfwd')">⚙️ Manage</button>
        <button class="hashem-btn hashem-btn-danger" onclick="cleanBagherTunnelClick()">🗑️ Clean</button>
      </div>
    </div>`;
  }

  if (!peers || !peers.length) {
    if (bagherCardHtml) {
      box.innerHTML = bagherCardHtml;
    } else {
      box.innerHTML = '<div class="u-col-full">' + stateEmpty({ title: tr('empty_peers_title', 'No peer tunnels yet'), msg: tr('empty_peers_msg', 'Add one from Setup → Add another foreign server.'), icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/></svg>' }) + '</div>';
    }
    return;
  }
  const stBadge = (ok, label) => `<span class="badge ${ok ? 'ok' : 'err'}"><span class="dot"></span>${esc(label)}</span>`;
  box.innerHTML = bagherCardHtml + peers.map(p => {
    const up = !!(p.gre_up || p.frp_up);
    const nm = p.name || ('peer-' + p.id);
    const traffic = (p.rx != null && p.tx != null)
      ? ('↓ ' + fmtBytes(p.rx) + ' · ↑ ' + fmtBytes(p.tx))
      : 'N/A';
    const isBh = p.engine === 'backhaul' || (p.frps_svc && p.frps_svc.includes('backhaul') && p.no_gre);
    const isGreBh = p.engine === 'gre-backhaul' || (p.frps_svc && p.frps_svc.includes('backhaul') && !p.no_gre);
    const engBadge = isBh
      ? `<span class="badge u-pill-sky">⚡ Backhaul</span>`
      : (isGreBh
         ? `<span class="badge u-pill-violet">⚡ GRE+Backhaul</span>`
         : `<span class="badge" style="background:rgba(234,179,8,0.15);color:#facc15;border:1px solid rgba(234,179,8,0.3)">🚀 FRP</span>`);
    const transBadge = p.transport ? `<span class="badge" style="background:rgba(255,255,255,0.06);color:var(--mu);font-size:12px">${esc(p.transport)}</span>` : '';
    const fwdPorts = p.raw_ports || (p.ports || []).join(', ') || '—';
    const greIfLabel = isBh ? 'N/A (Standalone)' : (p.gre_if || 'gre-t' + p.id);
    const svcTitle = (isBh || isGreBh) ? 'Backhaul & Traffic' : 'FRP & Traffic';
    return `<div class="tunnel-card peer-card u-peer-card-wide" id="peer-card-${p.id}">
      <div class="tc-header u-flex-wrap-gap8">
        <div class="u-flex-center-gap10">
          <span class="status-indicator ${up ? 'active' : 'offline'}"><span class="dot"></span></span>
          <b class="u-fs-16-tx">${esc(nm)}</b>
          <span class="qs-hint mono">#${p.id}</span>
          ${engBadge}
          ${transBadge}
          <span class="badge ${up ? 'ok' : 'err'}"><span class="dot"></span>${up ? 'active' : 'down'}</span>
        </div>
      </div>
      <div class="det-grid">
        <div class="det-card">
          <div class="det-card-head">${ICO_SRV} <span>Foreign Server</span></div>
          <div class="det-row"><span class="det-k">Foreign IP</span><span class="det-v mono">${esc(p.remote_pub || '—')}<button type="button" class="det-copy" data-copy="${esc(p.remote_pub || '')}" title="Copy" aria-label="Copy">⧉</button></span></div>
          <div class="det-row"><span class="det-k">Iran IP</span><span class="det-v mono">${esc(p.local_pub || '—')}<button type="button" class="det-copy" data-copy="${esc(p.local_pub || '')}" title="Copy" aria-label="Copy">⧉</button></span></div>
          <div class="det-row"><span class="det-k">Forwarded</span><span class="det-v mono">${esc(fwdPorts)}<button type="button" class="det-copy u-ml-5" onclick="editPeerPortsClick(${p.id})" title="Edit Ports" aria-label="Edit ports">✏️</button></span></div>
        </div>
        <div class="det-card">
          <div class="det-card-head">${ICO_GRE} <span>GRE Tunnel</span></div>
          <div class="det-row"><span class="det-k">Interface</span><span class="det-v">${stBadge(isBh ? true : p.gre_up, greIfLabel)}</span></div>
          <div class="det-row"><span class="det-k">GRE Inner</span><span class="det-v mono">${isBh ? 'N/A' : (esc(p.local_gre || '?') + ' ⇄ ' + esc(p.peer_gre || '?'))}</span></div>
          <div class="det-row"><span class="det-k">Ping / Latency</span><span class="det-v">${isBh ? '<span class="badge ok">Direct</span>' : pingBadge(p)}</span></div>
        </div>
        <div class="det-card">
          <div class="det-card-head">${(isBh || isGreBh) ? '⚡' : ICO_FRP} <span>${svcTitle}</span></div>
          <div class="det-row"><span class="det-k">Service</span><span class="det-v">${stBadge(p.frp_up, p.frps_svc || 'service')}</span></div>
          <div class="det-row"><span class="det-k">Control Port</span><span class="det-v mono">${esc(String(p.frp_port || '—'))}<button type="button" class="det-copy" data-copy="${esc(String(p.frp_port || ''))}" title="Copy" aria-label="Copy">⧉</button></span></div>
          <div class="det-row"><span class="det-k">Traffic</span><span class="det-v mono">${esc(traffic)}</span></div>
        </div>
      </div>
      <div class="peer-acts u-peer-acts-bar">
        <button class="hashem-btn hashem-btn-secondary u-btn-30" data-peer-act="ping-${p.id}" onclick="peerAct('ping', ${p.id})">Ping</button>
        <button class="hashem-btn hashem-btn-secondary u-btn-30" onclick="editPeerPortsClick(${p.id})">✏️ Edit Peer</button>
        <button class="hashem-btn hashem-btn-secondary u-btn-30" onclick="showPeerToken(${p.id}, '${esc(nm)}')">📦 Bundle</button>
        <button class="hashem-btn hashem-btn-secondary u-btn-30" data-peer-act="restart-frps-${p.id}" onclick="peerAct('restart-frps', ${p.id})">Restart</button>
        <button class="hashem-btn hashem-btn-danger peer-remove-btn u-btn-30" data-peer-remove="${p.id}" onclick="peerRemoveClick(${p.id}, '${esc(nm)}')">Remove</button>
      </div>
      <div id="peer-confirm-${p.id}" class="peer-confirm warnbox hidden"></div>
    </div>`;
  }).join('');
  box.querySelectorAll('[data-copy]').forEach(b => {
    b.onclick = () => {
      const v = b.dataset.copy;
      (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject())
        .then(() => { b.textContent = '✓'; b.classList.add('ok'); setTimeout(() => { b.textContent = '⧉'; b.classList.remove('ok'); }, 1200); })
        .catch(() => toastWarn('copy failed', v));
    };
  });
}
// Two-step remove (inline confirm, no modal): 1st click arms 5s + Undo,
// 2nd click while armed deletes. Same from Tunnel tab or Dashboard summary.
function peerRemoveClick(peerId, name) {
  const armed = document.querySelector(`[data-peer-remove="${peerId}"].armed`);
  if (armed) removePeer(peerId, name);
  else armRemovePeer(peerId, name);
}
function renderTunnel(st) {
  $('roleLine').textContent = esc(st.role || 'unknown role');
  const up = !!(st.gre.exists || st.frp_up);
  const d = $('tunnelDot');
  if (d) { d.className = 'status-indicator ' + (up ? 'active' : 'offline'); $('tunnelDotTxt').textContent = up ? 'up' : 'down'; }
  const badge = (ok, label) => `<span class="badge ${ok ? 'ok' : 'err'}"><span class="dot"></span>${esc(label)}</span>`;
  const svcBadge = st.frp_up
    ? `<span class="badge ok"><span class="dot"></span>${esc(st.frp_svc || 'frp')}</span>`
    : `<span class="badge dim"><span class="dot"></span>stopped</span>`;
  // Main tunnel full card (dashboard-style, distinct gold accent): same
  // detail rows as a peer card so the base tunnel isn't a plain text list.
  const hasMain = !!(st.gre.exists || st.frp_up || (st.proxies || []).length);
  const mainCard = !hasMain ? '' : `
    <div class="tunnel-card peer-card main-card u-peer-card-wide" id="peer-card-main">
      <div class="tc-header u-flex-wrap-gap8">
        <div class="u-flex-center-gap10">
          <span class="status-indicator ${up ? 'active' : 'offline'}"><span class="dot"></span></span>
          <b class="u-fs-16-tx">${esc(st.remote_pub ? 'Tunnel · ' + st.remote_pub : 'Tunnel')}</b>
          <span class="badge ${up ? 'ok' : 'err'}"><span class="dot"></span>${up ? 'active' : 'down'}</span>
          ${(!st.ping_ok && st.frp_up) ? '<span class="badge info"><span class="dot"></span>' + esc(tr('fleet_frp_only', 'FRP only')) + '</span>' : ''}
        </div>
      </div>
      <div class="det-grid">
        <div class="det-card">
          <div class="det-card-head">${ICO_SRV} <span>Server</span></div>
          <div class="det-row"><span class="det-k">GRE Path</span><span class="det-v mono">${esc(st.gre.local || '?')} → ${esc(st.gre.peer_ip || st.gre_peer || '?')}</span></div>
          <div class="det-row"><span class="det-k">Forwarded</span><span class="det-v mono">${esc(((st.proxy_ports && st.proxy_ports.length) ? st.proxy_ports : (st.proxies || [])).join(', ') || '—')}<button type="button" class="det-copy u-ml-5" onclick="editMainPortsClick()" title="Edit Ports" aria-label="Edit ports">✏️</button></span></div>
        </div>
        <div class="det-card">
          <div class="det-card-head">${ICO_GRE} <span>GRE Tunnel</span></div>
          <div class="det-row"><span class="det-k">Interface</span><span class="det-v">${badge(st.gre.exists, (st.gre.name || 'gre-tunnel') + ' ' + (st.gre.inner || ''))}</span></div>
          <div class="det-row"><span class="det-k">Ping / Latency</span><span class="det-v">${pingBadge(st)}</span></div>
        </div>
        <div class="det-card">
          <div class="det-card-head">${ICO_FRP} <span>FRP Service</span></div>
          <div class="det-row"><span class="det-k">Service</span><span class="det-v">${svcBadge}</span></div>
          <div class="det-row"><span class="det-k">Port</span><span class="det-v mono">${esc(String(st.frp_port || st.bind_port || '?'))}</span></div>
        </div>
      </div>
      <div class="peer-acts u-peer-acts-bar">
        <button class="hashem-btn hashem-btn-secondary u-btn-30" onclick="peerAct('ping', 0)">Ping</button>
        <button class="hashem-btn hashem-btn-secondary u-btn-30" onclick="editMainPortsClick()">✏️ Edit Tunnel</button>
        ${st.role === 'iran' ? '<button class="hashem-btn hashem-btn-secondary u-btn-30" onclick="copyMainIranBundle()">📦 Copy Bundle</button>' : ''}
        <button class="hashem-btn hashem-btn-secondary u-btn-30" onclick="peerAct('restart-gre', 0)">Restart GRE</button>
        <button class="hashem-btn hashem-btn-secondary u-btn-30" onclick="peerAct('restart-frps', 0)">Restart FRP</button>
      </div>
    </div>`;
  $('tunnel').innerHTML = mainCard;
  window._lastLocal = st;
  // Sync live engine switcher card
  const eng = st.engine || st.tunnel_engine || 'frp';
  const aBadge = $('activeEngineBadge');
  if (aBadge) {
    aBadge.textContent = eng.toUpperCase();
    aBadge.className = 'badge ' + (eng === 'frp' ? 'info' : 'ok');
  }
  const lSel = $('liveEngineSelect');
  if (lSel && document.activeElement !== lSel) {
    lSel.value = eng;
  }
  const tSel = $('liveTransportSelect');
  if (tSel && st.transport && document.activeElement !== tSel) {
    tSel.value = st.transport;
  }
  // role-specific button label: foreign runs frpc, so show the right name.
  const rb = $('frpRestartBtn');
  if (rb) rb.textContent = (st.frp_svc === 'frpc' || /foreign/i.test(st.role || '')) ? 'Restart frpc' : 'Restart frps';
  renderTunChips(st);
}
// shared cache: refresh() fills it from /api/status before renderTunChips runs
let tunPeerCache = null;
// One-line health chips per tunnel (compact status at a glance):
// legacy/base tunnel first, then every peer. Each chip shows live/dot,
// name, ping and traffic; clicking jumps to the peer row in the table.
// Compact by design: the Tunnel tab stays scannable with 5 peers.
function renderTunChips(st) {
  const box = $('tunChips');
  if (!box) return;
  const chips = [];
  if (st && (st.gre.exists || st.frp_up || (st.proxies || []).length)) {
    chips.push({
      key: 'base',
      name: 'main',
      up: !!(st.gre.exists || st.frp_up),
      ping: pingText(st),
      sub: esc(st.frp_svc || 'frp') + ' :' + esc(st.frp_port || st.bind_port || '?'),
    });
  }
  (tunPeerCache || []).forEach((p, i) => {
    const up = !!(p.gre_up || p.frp_up);
    const traffic = (p.rx != null && p.tx != null)
      ? ('↓ ' + fmtBytes(p.rx) + ' · ↑ ' + fmtBytes(p.tx)) : null;
    chips.push({
      key: 'peer-' + (p.id ?? i),
      name: p.name || ('peer-' + (p.id ?? (i + 1))),
      up,
      ping: pingText(p),
      sub: traffic || ((p.ports || []).join(', ') || '—'),
    });
  });
  if (!chips.length) { box.innerHTML = ''; return; }
  box.innerHTML = chips.map(c =>
    `<button class="tun-chip" data-chip="${esc(c.key)}"><span class="ent-st ${c.up ? 'on' : 'off'}"><i></i></span><span>${esc(c.name)}</span><span class="qs-hint">${esc(c.ping)} · ${esc(c.sub)}</span></button>`
  ).join('');
  box.querySelectorAll('[data-chip]').forEach(b => b.onclick = () => {
    const key = b.dataset.chip;
    const cards = document.querySelectorAll('#peerCards .peer-card');
    const idx = key === 'base' ? -1 : chips.findIndex(c => c.key === key) - (chips.length - (tunPeerCache || []).length);
    const target = key === 'base' ? $('tunnelStatusCard') : (cards[idx] || $('peerCards'));
    if (target && target.scrollIntoView) target.scrollIntoView({behavior: 'smooth', block: 'start'});
  });
}
async function refresh() {
  let ok = true;
  try {
    const s = await api('/api/status');
    // peers first: renderTunChips (called inside renderTunnel) reads the cache
    tunPeerCache = s.peers || null;
    renderTunnel(s.local);
    renderPeers(s.peers);
    updatePeerHints(s);
    if (typeof supObserve === 'function') supObserve(s);
    if (typeof uiObserve === 'function') uiObserve(s);
    if (s.local) {
      const isForeign = /foreign/i.test(s.local.role || '') || (s.local.frp_svc === 'frpc');
      const ap = $('setupAddPeerStep');
      if (ap) ap.hidden = isForeign;
    }
  } catch(e) {
    reportErr('status', e);
    { const g0 = $('dashGrid'); if (g0) g0.classList.remove('dash-loading'); }
    const pc = $('peerCards');
    if (pc && !pc.children.length) pc.innerHTML = stateError(e.message, 'status');
    ok = false;
  }
  refreshDash();
  loadCarrier().catch(e => reportErr('carrier', e));
  return ok;
}
// peer add-form: prefill Iran IP + suggest next control port / GRE pair
async function updatePeerHints(s) {
  try {
    const d = await api('/api/setup');
    if (!$('pLocalPub').value) $('pLocalPub').value = d.local_public || '';
    const n = (s && s.peer_count) || 0;
    const hint = $('peerCountHint');
    if (hint) hint.textContent = n + ' / 5 tunnels';
    if (!$('pFrpPort').value) $('pFrpPort').value = 7000 + n;
    if (!$('pLocalGre').value) $('pLocalGre').value = '10.1' + (n + 1) + '.0.2';
    if (!$('pPeerGre').value) $('pPeerGre').value = '10.1' + (n + 1) + '.0.1';
  } catch(e) { reportErr('peers', e); }
}
$('addPeerBtn').onclick = async () => {
  const b = $('addPeerBtn');
  b.disabled = true;
  const oldTxt = b.textContent;
  b.innerHTML = '<span class="ent-spinner"></span> Adding…';
  $('peerToken').classList.add('hidden');
  $('peerWarn').classList.add('hidden');
  try {
    const pEng = $('pEngine') ? $('pEngine').value : 'frp';
    const pTrans = $('pTransport') ? $('pTransport').value : 'tcp';
    const body = {
      role: 'add-peer',
      engine: pEng,
      transport: pTrans,
      frp_transport: pEng === 'frp' ? pTrans : '',
      name: $('pName').value.trim(),
      local_public: $('pLocalPub').value.trim(),
      remote_public: $('pRemotePub').value.trim(),
      local_gre: $('pLocalGre') ? $('pLocalGre').value.trim() : '',
      peer_gre: $('pPeerGre') ? $('pPeerGre').value.trim() : '',
      frp_port: parseInt($('pFrpPort').value, 10),
      ports: $('pPorts').value,
      autogen: true,
    };
    let r;
    try {
      r = await api('/api/setup', body);
    } catch(e) {
      // 409 = port already served by another tunnel — show it inline,
      // same for a stale hashem.sh on this host (E-INSTALL-02 "Unknown command"):
      // tell the user to update instead of a bare failure.
      if (/already served|already used|peer table full/i.test(e.message)) {
        const w = $('peerWarn');
        w.innerHTML = '⚠️ ' + esc(e.message);
        w.classList.remove('hidden');
        toastWarn('pick a different port', e.code ? '[' + e.code + ']' : '');
        b.disabled = false;
        b.textContent = oldTxt;
        return;
      }
      if (/Unknown command|old version/i.test(e.message)) {
        const w = $('peerWarn');
        w.innerHTML = '⚠️ ' + esc(e.message) + '<br>Go to <b>Update</b> tab → install latest, then add the server again.';
        w.classList.remove('hidden');
        toastWarn('panel files outdated', e.code ? '[' + e.code + ']' : '');
        b.disabled = false;
        b.textContent = oldTxt;
        return;
      }
      throw e;
    }
    const out = $('peerOut');
    out.classList.remove('hidden');
    out.textContent = (r.steps || []).join('\n');
    if (r.bundle || r.token) {
      const t = $('peerToken');
      const show = r.bundle || r.token;
      t.innerHTML = '📦 Bundle (paste on the Foreign side — fills everything): <b>' + esc(show) + '</b>';
      t.classList.remove('hidden');
    }
    toastOk('tunnel added', $('pName').value.trim() || 'peer');
    refresh();
  } catch(e) { toastErr('add tunnel failed', e.message); }
  b.disabled = false;
  b.textContent = oldTxt;
};
// ---- dashboard ----
const NA = 'N/A';
const fmtBytes = n => {
  if (n == null) return NA;
  const u = ['B','KB','MB','GB','TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length-1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(1)) + ' ' + u[i];
};
const fmtRate = bps => {
  if (bps == null || !isFinite(bps)) return NA;
  const u = ['B/s','KB/s','MB/s','GB/s'];
  let i = 0, v = bps;
  while (v >= 1024 && i < u.length-1) { v /= 1024; i++; }
  return v.toFixed(1) + ' ' + u[i];
};
const fmtSecs = s => {
  if (s == null) return NA;
  const d = Math.floor(s/86400), h = Math.floor(s%86400/3600), m = Math.floor(s%3600/60);
  if (d > 0) return d + 'd ' + h + 'h';
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
};
const dr = (k, v) => `<div class="dr"><span class="k">${esc(k)}</span><span>${esc(v ?? NA)}</span></div>`;
let dashRange = '24h';
document.querySelectorAll('[data-range]').forEach(b => b.onclick = () => {
  dashRange = b.dataset.range;
  document.querySelectorAll('[data-range]').forEach(x => x.setAttribute('aria-pressed', x === b));
  const cv = $('trafficChart');
  if (cv) { cv._forceAnim = true; cv._ymax = null; }
  refreshDash();
});
// Throughput chart: cumulative counters to interval rate.
function drawChart(hist, isDown) {
  const cv = $('trafficChart');
  if (!cv) return;
  cv._isDown = isDown;
  if (hist) cv._hist = hist;

  const light = (document.body && document.body.dataset.t === 'light') ||
    (document.documentElement && document.documentElement.dataset.t === 'light');

  // Palette: cyan download, violet upload, down red.
  const C_GRID = light ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.06)';
  const C_AXIS = light ? 'rgba(24,24,27,0.6)' : 'rgba(255,255,255,0.45)';
  const C_IDLE = light ? 'rgba(24,24,27,0.55)' : 'rgba(255,255,255,0.45)';

  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || (cv.parentElement ? cv.parentElement.clientWidth : 600) || 600;
  const H = 260;
  if (cv.width !== W * dpr || cv.height !== H * dpr) {
    cv.width = W * dpr;
    cv.height = H * dpr;
  }
  const ctx = cv.getContext('2d');

  const padL = 46, padR = 10, padT = 18, padB = 24;
  const iw = Math.max(10, W - padL - padR), ih = Math.max(10, H - padT - padB);
  cv._padL = padL;
  cv._iw = iw;

  const pts = (hist || []).filter(p => p && p.t != null);
  if (pts.length < 2) {
    if (cv._animId) { cancelAnimationFrame(cv._animId); cv._animId = null; }
    cv._peak = null; cv._peakRange = null;
    cv._ymax = null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = C_IDLE; ctx.font = '12px -apple-system, system-ui, sans-serif'; ctx.textAlign = 'center';
    if (pts.length === 0) {
      ctx.fillText('No history yet', W/2, H/2 - 9);
      ctx.fillText('collecting every 5s while the panel runs', W/2, H/2 + 9);
    } else {
      ctx.fillText('Collecting… need at least 2 samples', W/2, H/2);
    }
    return;
  }

  // per-interval bytes/sec for up & down
  const series = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i-1], b = pts[i];
    const dt = (b.t - a.t) || 1;
    const aDown = a.down != null ? a.down : 0;
    const bDown = b.down != null ? b.down : 0;
    const aUp = a.up != null ? a.up : 0;
    const bUp = b.up != null ? b.up : 0;
    let dd = (bDown - aDown) / dt, du = (bUp - aUp) / dt;
    if (dd < 0 || du < 0) { dd = Math.max(0, dd); du = Math.max(0, du); }
    let aTot = a.total != null ? a.total : (aDown + aUp);
    let bTot = b.total != null ? b.total : (bDown + bUp);
    let dtot = (bTot - aTot) / dt;
    if (dtot < 0) dtot = dd + du;
    series.push({t: b.t, down: dd, up: du, total: dtot, conns: b.conns || 0});
  }
  cv._series = series;

  const vals = series.filter(Boolean);
  if (!vals.length) {
    if (cv._animId) { cancelAnimationFrame(cv._animId); cv._animId = null; }
    cv._peak = null; cv._peakRange = null;
    cv._ymax = null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = C_IDLE; ctx.font = '12px -apple-system, system-ui, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('Waiting for traffic…', W/2, H/2);
    return;
  }

  // Nice ceiling: 1/2/5 × 10^n rule.
  const niceCeil = val => {
    const v = val || 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
  };

  let rawMax = 0;
  vals.forEach(p => { rawMax = Math.max(rawMax, p.down || 0, p.up || 0); });
  const candidate = niceCeil(rawMax * 1.2);

  const isFirstShow = !cv._hasDrawn;
  const rangeChanged = cv._drawnRange !== dashRange;
  const forceAnim = !!cv._forceAnim;

  if (rangeChanged) cv._ymax = null;

  let max;
  const stored = (cv._ymax && cv._ymax.range === dashRange) ? cv._ymax.nice : null;
  if (stored == null) {
    max = candidate;
  } else if (candidate > stored) {
    max = candidate;
  } else if (candidate < stored * 0.6) {
    // one nice-rung down per draw: next lower 1/2/5 step below stored
    const rung = v => { const p = Math.pow(10, Math.floor(Math.log10(v || 1))); const n = v / p;
      return (n > 5 ? 5 : n > 2 ? 2 : n > 1 ? 1 : 0.5) * p; };
    max = Math.max(candidate, rung(stored));
  } else {
    max = stored;
  }
  cv._ymax = { range: dashRange, nice: max };

  const t0 = pts[0].t;
  const t1 = pts[pts.length - 1].t;
  const dtRange = (t1 - t0) || 1;
  const X = t => padL + ((t - t0) / dtRange) * iw;
  const Y = v => padT + ih - (v / max) * ih;
  cv._t0 = t0;
  cv._t1 = t1;

  // Build precise point sequences
  const getSeq = key => {
    return series.map((p, i) => p ? { x: X(p.t), y: Y(p[key]), val: p[key], i, t: p.t } : null).filter(Boolean);
  };

  const seqUl = getSeq('up');
  const seqDl = getSeq('down');

  // Sticky peak detection on download series.
  let curMaxPt = null;
  for (const pt of seqDl) {
    if (!curMaxPt || pt.val > curMaxPt.val) curMaxPt = pt;
  }

  let peakPt = null;
  if (rangeChanged || isFirstShow || forceAnim || !cv._peak || cv._peakRange !== dashRange) {
    // Reset/re-seed peak from current visible max
    if (curMaxPt && curMaxPt.val > 0) {
      cv._peak = { val: curMaxPt.val, x: curMaxPt.x, t: curMaxPt.t };
      peakPt = curMaxPt;
    } else {
      cv._peak = null;
      peakPt = null;
    }
    cv._peakRange = dashRange;
  } else {
    // Moves only when a new point EXCEEDS stored val with hysteresis (new > stored*1.02)
    if (curMaxPt && curMaxPt.val > cv._peak.val * 1.02) {
      cv._peak = { val: curMaxPt.val, x: curMaxPt.x, t: curMaxPt.t };
      peakPt = curMaxPt;
    } else {
      // Stored peak point still visible in series?
      let match = null;
      if (cv._peak.t != null) {
        match = seqDl.find(p => p.t === cv._peak.t);
        if (!match) {
          // If downsample shifted timestamp slightly, find closest within 60s
          let minDt = Infinity;
          for (const p of seqDl) {
            const dt = Math.abs(p.t - cv._peak.t);
            if (dt < minDt && dt <= 60) { minDt = dt; match = p; }
          }
        }
      }
      if (match) {
        cv._peak.x = match.x;
        cv._peak.val = match.val;
        cv._peak.t = match.t;
        peakPt = match;
      } else {
        // Stored peak point scrolled out of view: re-seed from current visible max
        if (curMaxPt && curMaxPt.val > 0) {
          cv._peak = { val: curMaxPt.val, x: curMaxPt.x, t: curMaxPt.t };
          peakPt = curMaxPt;
        } else {
          cv._peak = null;
          peakPt = null;
        }
      }
    }
  }

  // Curve tracer for Catmull-Rom cubic beziers
  const traceCurve = seq => {
    ctx.beginPath();
    if (seq.length === 1) {
      ctx.moveTo(seq[0].x, seq[0].y);
      ctx.lineTo(seq[0].x + 0.01, seq[0].y);
    } else if (seq.length > 1) {
      ctx.moveTo(seq[0].x, seq[0].y);
      for (let i = 0; i < seq.length - 1; i++) {
        const p0 = seq[Math.max(0, i - 1)], p1 = seq[i], p2 = seq[i + 1], p3 = seq[Math.min(seq.length - 1, i + 2)];
        const c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6;
        const c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6;
        ctx.bezierCurveTo(c1x, c1y, c2x, c2y, p2.x, p2.y);
      }
    }
  };

  // Pre-generate styles & gradients
  const gradDl = ctx.createLinearGradient(padL, 0, W - padR, 0);
  const gradUl = ctx.createLinearGradient(padL, 0, W - padR, 0);
  const gradFill = ctx.createLinearGradient(0, padT, 0, padT + ih);

  let glowDl, glowUl, colDlEnd, colUlEnd;
  if (isDown) {
    if (light) {
      gradDl.addColorStop(0, '#dc2626'); gradDl.addColorStop(1, '#b91c1c');
      gradUl.addColorStop(0, 'rgba(220,38,38,0.4)'); gradUl.addColorStop(1, 'rgba(185,28,28,0.55)');
      glowDl = 'rgba(220,38,38,0.35)'; glowUl = 'rgba(220,38,38,0.2)';
      colDlEnd = '#dc2626'; colUlEnd = '#b91c1c';
      gradFill.addColorStop(0, 'rgba(220,38,38,0.12)'); gradFill.addColorStop(1, 'rgba(220,38,38,0)');
    } else {
      gradDl.addColorStop(0, '#f87171'); gradDl.addColorStop(1, '#ef4444');
      gradUl.addColorStop(0, 'rgba(248,113,113,0.45)'); gradUl.addColorStop(1, 'rgba(239,68,68,0.6)');
      glowDl = 'rgba(239,68,68,0.5)'; glowUl = 'rgba(248,113,113,0.35)';
      colDlEnd = '#ef4444'; colUlEnd = '#f87171';
      gradFill.addColorStop(0, 'rgba(239,68,68,0.18)'); gradFill.addColorStop(1, 'rgba(239,68,68,0)');
    }
  } else {
    if (light) {
      // Light theme: crisp, high-contrast cyan-blue & violet readable on pure white cards
      gradDl.addColorStop(0, '#0284c7'); gradDl.addColorStop(1, '#0369a1');
      gradUl.addColorStop(0, '#6366f1'); gradUl.addColorStop(1, '#7c3aed');
      glowDl = 'rgba(2,132,199,0.35)'; glowUl = 'rgba(99,102,241,0.25)';
      colDlEnd = '#0284c7'; colUlEnd = '#6366f1';
      gradFill.addColorStop(0, 'rgba(2,132,199,0.14)'); gradFill.addColorStop(1, 'rgba(2,132,199,0)');
    } else {
      // Dark theme: Hashem cyan (#38bdf8) & lighter blue/violet (#a78bfa)
      gradDl.addColorStop(0, '#0ea5e9'); gradDl.addColorStop(1, '#38bdf8');
      gradUl.addColorStop(0, '#818cf8'); gradUl.addColorStop(1, '#a78bfa');
      glowDl = 'rgba(56,189,248,0.55)'; glowUl = 'rgba(167,139,250,0.4)';
      colDlEnd = '#38bdf8'; colUlEnd = '#a78bfa';
      gradFill.addColorStop(0, 'rgba(56,189,248,0.22)'); gradFill.addColorStop(1, 'rgba(56,189,248,0)');
    }
  }

  // Pre-compute x tick labels
  const fmtTick = t => {
    const d = new Date(t * 1000);
    const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
    return (dashRange === '1h' || dashRange === '24h')
      ? String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0')
      : M + ' ' + d.getDate();
  };
  const approxLabel = 64, nTicks = Math.max(2, Math.min(6, Math.floor(iw / approxLabel)));

  // Frame renderer
  const renderFrame = (progress, pulsePhase) => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    ctx.strokeStyle = C_GRID; ctx.lineWidth = 1;
    ctx.fillStyle = C_AXIS; ctx.font = '12px -apple-system, system-ui, sans-serif'; ctx.textAlign = 'left';
    for (let g = 0; g <= 4; g++) {
      const y = Math.round(padT + ih * g / 4) + 0.5, val = max * (1 - g / 4);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
      ctx.fillText(fmtRate(val), 4, y + 3);
    }

    ctx.fillStyle = C_AXIS; ctx.font = '12px -apple-system, system-ui, sans-serif'; ctx.textAlign = 'center';
    for (let k = 0; k < nTicks; k++) {
      const tickTime = t0 + ((t1 - t0) * k) / (nTicks - 1);
      const x = X(tickTime);
      const gx = Math.round(x) + 0.5;
      ctx.beginPath(); ctx.moveTo(gx, padT); ctx.lineTo(gx, padT + ih); ctx.stroke();
      ctx.fillText(fmtTick(tickTime), Math.min(Math.max(x, padL + 20), W - padR - 20), H - 7);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(padL - 2, 0, (iw + 4) * Math.max(0, Math.min(1, progress)), H);
    ctx.clip();

    if (seqUl.length) {
      traceCurve(seqUl);
      ctx.strokeStyle = gradUl; ctx.lineWidth = 1.8; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.shadowColor = glowUl; ctx.shadowBlur = light ? 4 : 7;
      ctx.stroke(); ctx.shadowBlur = 0;

      const lastUl = seqUl[seqUl.length - 1];
      ctx.beginPath(); ctx.arc(lastUl.x, lastUl.y, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = colUlEnd; ctx.fill();
    }

    if (seqDl.length) {
      traceCurve(seqDl);
      const lastDl = seqDl[seqDl.length - 1];
      ctx.lineTo(lastDl.x, padT + ih);
      ctx.lineTo(seqDl[0].x, padT + ih);
      ctx.closePath();
      ctx.fillStyle = gradFill;
      ctx.fill();
    }

    if (seqDl.length) {
      traceCurve(seqDl);
      ctx.strokeStyle = gradDl; ctx.lineWidth = 2.2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.shadowColor = glowDl; ctx.shadowBlur = light ? 6 : 10;
      ctx.stroke(); ctx.shadowBlur = 0;
    }

    ctx.restore();

    if (peakPt && peakPt.val > 0 && progress >= Math.min(1, Math.max(0.2, (peakPt.x - padL) / iw))) {
      const px = peakPt.x, py = peakPt.y;
      const peakTxt = 'Peak ' + fmtRate(peakPt.val);
      ctx.font = '600 12px -apple-system, system-ui, sans-serif';
      const tw = ctx.measureText(peakTxt).width;
      const tagW = Math.round(tw + 12), tagH = 17;

      // Nudge flag away from active hover tooltip.
      let placeAbovePeak = (py - tagH - 12) >= padT;
      try {
        const tipEl = document.querySelector('.ent-chart-tip');
        if (tipEl && tipEl.style.display !== 'none') {
          const tipX = (cv.offsetLeft || 0) + (parseFloat(tipEl.style.left) || 0);
          if (Math.abs(tipX - px) < tagW + 40) placeAbovePeak = false;
        }
      } catch (_) { /* tooltip overlap check is cosmetic */ }
      const placeAbove = placeAbovePeak;
      const tagY = placeAbove ? (py - 12 - tagH / 2) : (py + 12 + tagH / 2);
      let tagX = px - tagW / 2;
      if (tagX < padL + 4) tagX = padL + 4;
      if (tagX + tagW > W - padR - 4) tagX = W - padR - 4 - tagW;

      const peakBorder = isDown ? (light ? 'rgba(220,38,38,0.45)' : 'rgba(239,68,68,0.45)') : (light ? 'rgba(2,132,199,0.45)' : 'rgba(56,189,248,0.45)');
      const peakTxtCol = isDown ? (light ? '#dc2626' : '#f87171') : (light ? '#0369a1' : '#38bdf8');
      const peakDotCol = isDown ? (light ? '#dc2626' : '#ef4444') : (light ? '#0284c7' : '#38bdf8');
      const peakGlow = isDown ? (light ? 'rgba(220,38,38,0.5)' : 'rgba(239,68,68,0.8)') : (light ? 'rgba(2,132,199,0.5)' : 'rgba(56,189,248,0.8)');

      ctx.beginPath();
      ctx.moveTo(px, placeAbove ? (py - 3) : (py + 3));
      ctx.lineTo(px, placeAbove ? (tagY + tagH / 2) : (tagY - tagH / 2));
      ctx.strokeStyle = peakBorder;
      ctx.lineWidth = 1;
      ctx.stroke();

      const rx = 4;
      if (ctx.roundRect) ctx.roundRect(tagX, tagY - tagH / 2, tagW, tagH, rx);
      else ctx.rect(tagX, tagY - tagH / 2, tagW, tagH);
      ctx.fillStyle = light ? 'rgba(255,255,255,0.94)' : 'rgba(15,23,42,0.88)';
      ctx.fill();
      ctx.strokeStyle = peakBorder;
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = peakTxtCol;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(peakTxt, tagX + tagW / 2, tagY);

      ctx.beginPath(); ctx.arc(px, py, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = peakDotCol;
      ctx.shadowColor = peakGlow; ctx.shadowBlur = 6;
      ctx.fill(); ctx.shadowBlur = 0;
      ctx.beginPath(); ctx.arc(px, py, 1.5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff'; ctx.fill();
    }

    if (seqDl.length && progress >= 1) {
      const lastDl = seqDl[seqDl.length - 1];
      if (isDown) {
        ctx.beginPath(); ctx.arc(lastDl.x, lastDl.y, 3, 0, Math.PI * 2);
        ctx.fillStyle = colDlEnd; ctx.fill();
      } else if (prefersReduced) {
        ctx.beginPath(); ctx.arc(lastDl.x, lastDl.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = light ? 'rgba(2,132,199,0.25)' : 'rgba(56,189,248,0.25)';
        ctx.fill();
        ctx.beginPath(); ctx.arc(lastDl.x, lastDl.y, 3, 0, Math.PI * 2);
        ctx.fillStyle = colDlEnd; ctx.fill();
        ctx.beginPath(); ctx.arc(lastDl.x, lastDl.y, 1.3, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff'; ctx.fill();
      } else {
        const ripR = 3.5 + pulsePhase * 7.5;
        const ripAlpha = (1 - pulsePhase) * (light ? 0.45 : 0.65);
        ctx.beginPath(); ctx.arc(lastDl.x, lastDl.y, ripR, 0, Math.PI * 2);
        ctx.strokeStyle = light ? ('rgba(2,132,199,' + ripAlpha.toFixed(2) + ')') : ('rgba(56,189,248,' + ripAlpha.toFixed(2) + ')');
        ctx.lineWidth = 1.5; ctx.stroke();

        ctx.beginPath(); ctx.arc(lastDl.x, lastDl.y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = light ? 'rgba(2,132,199,0.22)' : 'rgba(56,189,248,0.3)';
        ctx.fill();

        ctx.beginPath(); ctx.arc(lastDl.x, lastDl.y, 3, 0, Math.PI * 2);
        ctx.fillStyle = colDlEnd;
        ctx.shadowColor = colDlEnd; ctx.shadowBlur = light ? 5 : 8;
        ctx.fill(); ctx.shadowBlur = 0;

        ctx.beginPath(); ctx.arc(lastDl.x, lastDl.y, 1.3, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff'; ctx.fill();
      }
    }
  };

  // Determine animation need
  const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const shouldAnimate = !prefersReduced && (isFirstShow || rangeChanged || forceAnim);
  cv._hasDrawn = true;
  cv._drawnRange = dashRange;
  cv._forceAnim = false;
  cv._dataSig = dashRange + '_' + (isDown ? '1' : '0') + '_' + (light ? '1' : '0') + '_' + Math.round(W);

  if (cv._animId) { cancelAnimationFrame(cv._animId); cv._animId = null; }

  const startPulseLoop = () => {
    if (cv._animId) cancelAnimationFrame(cv._animId);
    const pulseStep = () => {
      if (document.hidden || ($('tab-dashboard') && $('tab-dashboard').hidden)) {
        cv._animId = null;
        return;
      }
      const pPhase = (Date.now() % 1600) / 1600;
      renderFrame(1, pPhase);
      cv._animId = requestAnimationFrame(pulseStep);
    };
    const pPhase = (Date.now() % 1600) / 1600;
    renderFrame(1, pPhase);
    cv._animId = requestAnimationFrame(pulseStep);
  };

  if (prefersReduced) {
    renderFrame(1, 0);
  } else if (shouldAnimate) {
    const animStart = performance.now();
    const DURATION = 550;
    const animStep = now => {
      const elapsed = now - animStart;
      const p = Math.min(1, elapsed / DURATION);
      const progress = 1 - Math.pow(1 - p, 3);
      renderFrame(progress, 0);
      if (p < 1) {
        cv._animId = requestAnimationFrame(animStep);
      } else {
        if (!isDown) startPulseLoop();
        else cv._animId = null;
      }
    };
    cv._animId = requestAnimationFrame(animStep);
  } else {
    // Soft update: same range, no draw animation.
    if (!isDown) {
      startPulseLoop();
    } else {
      renderFrame(1, 0);
    }
  }
}
async function refreshDash() {
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  const setHTML = (id, v) => { const el = $(id); if (el) el.innerHTML = v; };
  const setBar = (id, pct) => { const el = $(id); if (el) el.style.width = pct; };
  try {
    const d = await api('/api/dashboard?range=' + dashRange);
    if (!d || typeof d !== 'object') return;
    const on = !!d.online;
    const nPeers = d.peer_count || 0;
    { const g0 = $('dashGrid'); if (g0) g0.classList.remove('dash-loading'); }
    const multi = nPeers > 0;
    const bObj = d.bagher || {};
    window._lastBagher = bObj;
    const bagherUp = !!(bObj.is_active || bObj.enabled || bObj.connected);
    let statusText = d.health ? (d.health === 'HEALTHY' ? 'Healthy' : (d.health === 'DEGRADED' ? 'Degraded' : 'Down')) : (on ? 'Online' : 'Offline');
    let statusColor = d.health ? (d.health === 'HEALTHY' ? 'var(--ok)' : (d.health === 'DEGRADED' ? 'var(--wr)' : 'var(--er)')) : (on ? 'var(--ok)' : 'var(--er)');
    if (bagherUp && (statusText === 'Down' || statusText === 'Offline')) {
      statusText = 'Healthy';
      statusColor = 'var(--ok)';
    }
    set('kpiStatus', statusText);
    const kpiStatus = $('kpiStatus'); if (kpiStatus) kpiStatus.style.color = statusColor;
    set('kpiStatusSub', (multi ? nPeers + ' tunnel' + (nPeers > 1 ? 's' : '') + ' · ' : (bagherUp && !nPeers ? 'Bagher tunnel · ' : '')) + (d.role || 'unknown role') + ' · ' + (d.checked ? 'checked ' + String(d.checked).slice(11, 19) + ' UTC' : ''));
    const g = d.gre || {}, f = d.frp || {};
    const peers = d.peers || [];
    const kpiLinks = $('kpiLinks');
    if (multi) {
      // multi-peer: count legs up
      const greUp = peers.filter(p => p.gre_up).length, frpUp = peers.filter(p => p.frp_up).length;
      let multiLinks = '<span class="badge ' + (greUp ? 'ok' : 'err') + '"><span class="dot"></span>GRE ' + greUp + '/' + nPeers + '</span> <span class="badge ' + (frpUp ? 'ok' : 'err') + '"><span class="dot"></span>FRP ' + frpUp + '/' + nPeers + '</span>';
      if (bagherUp) {
        multiLinks += ' <span class="badge ok" style="background:rgba(16,185,129,0.18);color:#10b981;border:1px solid rgba(16,185,129,0.35);font-weight:700"><span class="dot"></span>Bagher</span>';
      }
      if (kpiLinks) kpiLinks.innerHTML = multiLinks;
    } else {
      const greUp = !!g.exists, frpUp = !!f.up;
      let linksHtml = '';
      if (bagherUp) {
        linksHtml += '<span class="badge ok" style="background:rgba(16,185,129,0.18);color:#10b981;border:1px solid rgba(16,185,129,0.35);font-weight:700"><span class="dot"></span>Bagher</span>';
      }
      if (greUp || frpUp || !bagherUp) {
        if (linksHtml) linksHtml += ' ';
        linksHtml += '<span class="badge ' + (greUp ? 'ok' : 'err') + '"><span class="dot"></span>GRE</span> <span class="badge ' + (frpUp ? 'ok' : 'err') + '"><span class="dot"></span>FRP</span>';
      }
      if (kpiLinks) kpiLinks.innerHTML = linksHtml;
    }
    if (multi) {
      // multi-peer: best ping across legs, sub lists per-peer names
      let best = null;
      peers.forEach(p => { const v = (p.ping_ok && p.ping_ms) ? parseFloat(p.ping_ms) : (p.health_state === 'healthy' && p.latency_ms >= 0 ? p.latency_ms : null); if (v != null && (best == null || v < best)) best = v; });
      set('kpiLinksSub', peers.map(p => (p.gre_up || p.frp_up ? '● ' : '○ ') + (p.name || ('peer-' + p.id))).join(' · '));
      set('kpiPing', best != null ? Math.round(best) + 'ms' : NA);
      setHTML('kpiPingSub', best == null ? 'no answer' : best < 80 ? '<span class="badge ok"><span class="dot"></span>Optimal</span>' : best < 200 ? '<span class="badge ok"><span class="dot"></span>Good</span>' : '<span class="badge warn"><span class="dot"></span>High</span>');
    } else {
      if (bagherUp && !g.exists && !f.up) {
        set('kpiLinksSub', 'Bagher stealth tunnel · ' + ((bObj.ports || []).length ? bObj.ports.length + ' forwarded ports' : 'active link') + ' · ' + (bObj.remote_host || 'connected'));
      } else {
        set('kpiLinksSub', (f.svc || 'no frp') + ((f.proxies || []).length ? ' · ' + f.proxies.length + ' proxies' : '') + ' · ' + (g.inner || 'no gre ip'));
      }
      const ms = d.ping_ok && d.ping ? parseFloat(d.ping) : (d.health_state === 'healthy' && d.latency_ms >= 0 ? d.latency_ms : null);
      if (ms != null) {
        set('kpiPing', d.ping_ok && d.ping ? d.ping : (Math.round(ms) + 'ms'));
        setHTML('kpiPingSub', (ms < 80 ? '<span class="badge ok"><span class="dot"></span>Optimal</span>' : ms < 200 ? '<span class="badge ok"><span class="dot"></span>Good</span>' : '<span class="badge warn"><span class="dot"></span>High</span>') + (d.icmp_filtered ? icmpChip() : ''));
      } else if (bagherUp && typeof bObj.latency_ms === 'number' && bObj.latency_ms > 0) {
        set('kpiPing', Math.round(bObj.latency_ms) + 'ms');
        setHTML('kpiPingSub', '<span class="badge ok"><span class="dot"></span>Optimal</span>');
      } else {
        set('kpiPing', NA);
        setHTML('kpiPingSub', 'no answer');
      }
    }
    const t = d.traffic || {};
    set('kpiTraffic', fmtBytes(t.total));
    let rtUp = '0.0 B/s', rtDown = '0.0 B/s';
    if (t.speed_up != null && t.speed_down != null) {
      rtUp = fmtRate(t.speed_up);
      rtDown = fmtRate(t.speed_down);
    } else if (d.history && d.history.length >= 2) {
      const b = d.history[d.history.length - 1];
      const a = d.history[d.history.length - 2];
      const dt = (b.t - a.t) || 1;
      if (b.up != null && a.up != null && b.up >= a.up) rtUp = fmtRate((b.up - a.up) / dt);
      if (b.down != null && a.down != null && b.down >= a.down) rtDown = fmtRate((b.down - a.down) / dt);
    }
    set('kpiTrafficSub', 'Speed: ↓ ' + rtDown + ' · ↑ ' + rtUp + '  |  Tot: ↓ ' + fmtBytes(t.down) + ' · ↑ ' + fmtBytes(t.up));
    drawChart(d.history, !on);
    drawActivityChart(d.history, !on);
    const cd = $('chartDown'), cc = $('chartCard');
    if (cd) cd.classList.toggle('hidden', on);
    if (cc) cc.classList.toggle('is-down', !on);
    const badge = $('chartLiveBadge');
    if (badge) {
      const paused = !on || document.hidden;
      badge.classList.toggle('is-paused', paused);
      const txt = badge.querySelector('.live-txt');
      if (txt) txt.textContent = paused ? 'PAUSED' : 'LIVE';
    }

    const b = d.bagher || {};
    const bagherActive = !!(b.is_active || b.enabled);
    const dashBagherCard = $('dashBagherCard');
    const tunBagherCard = $('tunnelBagherCard');
    if (dashBagherCard) {
      if (bagherActive) {
        dashBagherCard.classList.remove('hidden');
        const roleStr = b.role === 'foreign' ? 'Foreign Server' : 'Iran Server';
        set('dashBagherRoleSub', 'Stealth Hybrid Tunnel · Role: ' + roleStr);
        set('dashBagherPing', (typeof b.latency_ms === 'number' && b.latency_ms > 0) ? (b.latency_ms.toFixed(1) + ' ms') : 'Optimal');
        const tp = b.throughput || {};
        const rx = tp.rx_bytes_sec || b.rx_bytes_sec || 0;
        const tx = tp.tx_bytes_sec || b.tx_bytes_sec || 0;
        set('dashBagherRate', '↓ ' + fmtRate(rx) + ' · ↑ ' + fmtRate(tx));
        set('dashBagherForeign', b.remote_host || '—');
        const portsStr = Array.isArray(b.ports) ? b.ports.join(', ') : (b.ports || '—');
        set('dashBagherPorts', portsStr);
        const bBadge = $('dashBagherStatusBadge');
        if (bBadge) {
          if (b.connected) {
            bBadge.className = 'badge ok';
            set('dashBagherStatusText', 'Connected');
          } else {
            bBadge.className = 'badge warn';
            set('dashBagherStatusText', 'Waiting for Peer');
          }
        }
      } else {
        dashBagherCard.classList.add('hidden');
      }
    }
    const hasBagherConfigOrActive = !!(bagherActive || b.has_config || (b.remote_host && b.remote_host.length > 0) || (Array.isArray(b.ports) && b.ports.length > 0));
    if (tunBagherCard) {
      if (hasBagherConfigOrActive) {
        tunBagherCard.classList.remove('hidden');
        set('tunBagherPing', bagherActive ? ((typeof b.latency_ms === 'number' && b.latency_ms > 0) ? (b.latency_ms.toFixed(1) + ' ms') : 'Optimal') : 'Standby');
        set('tunBagherForeign', b.remote_host || '—');
        const portsStr = Array.isArray(b.ports) ? b.ports.join(', ') : (b.ports || '—');
        set('tunBagherPorts', portsStr);
        const tp = b.throughput || {};
        const tot = tp.total_bytes || b.total_bytes || 0;
        set('tunBagherTotal', fmtBytes(tot));
        const tbBadge = $('tunBagherStatusBadge');
        if (tbBadge) {
          if (b.connected) {
            tbBadge.className = 'badge ok';
            set('tunBagherStatusText', 'Connected');
          } else if (bagherActive) {
            tbBadge.className = 'badge warn';
            set('tunBagherStatusText', 'Waiting for Peer');
          } else {
            tbBadge.className = 'badge dim';
            set('tunBagherStatusText', 'Stopped');
          }
        }
      } else {
        tunBagherCard.classList.add('hidden');
      }
    }
    // Chart hover tooltip (read-only; data source untouched).
    const cv = $('trafficChart');
    if (cv && !cv.dataset.tipBound) {
      cv.dataset.tipBound = '1';
      const wrap = cv.parentElement;
      if (wrap && getComputedStyle(wrap).position === 'static') wrap.classList.add('ent-chart-wrap');
      const tip = document.createElement('div');
      tip.className = 'ent-chart-tip'; tip.style.display = 'none';
      (wrap || cv.parentElement).appendChild(tip);
      cv.addEventListener('mousemove', e => {
        const s = cv._series;
        if (!s || !s.length) { tip.style.display = 'none'; return; }
        const r = cv.getBoundingClientRect();
        const mx = e.clientX - r.left;
        const my = e.clientY - r.top;
        const padL = cv._padL || 46;
        const iw = cv._iw || Math.max(1, r.width - padL - 10);
        const fx = (mx - padL) / (cv._iw || iw);
        if (fx < -0.05 || fx > 1.05) { tip.style.display = 'none'; return; }
        const t0 = cv._t0, t1 = cv._t1;
        let p = null;
        if (t0 != null && t1 != null) {
          const mt = t0 + fx * (t1 - t0);
          let minDt = Infinity;
          for (let i = 0; i < s.length; i++) {
            const item = s[i];
            if (!item || item.t == null) continue;
            const dt = Math.abs(item.t - mt);
            if (dt < minDt) { minDt = dt; p = item; }
          }
        } else {
          const idx = Math.max(0, Math.min(s.length - 1, Math.round(fx * (s.length - 1))));
          p = s[idx];
        }
        if (!p || p.t == null) { tip.style.display = 'none'; return; }
        const d = new Date(p.t * 1000);
        const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
        const hhmm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
        const when = (dashRange === '1h' || dashRange === '24h') ? hhmm : M + ' ' + d.getDate() + ' ' + hhmm;
        tip.innerHTML = '<span class="tip-time">' + esc(when) + '</span><span class="tip-sep">·</span>' +
          '<span class="tip-down"><i class="sw-dl"></i>↓ ' + esc(fmtRate(p.down)) + '</span><span class="tip-sep">·</span>' +
          '<span class="tip-up"><i class="sw-ul"></i>↑ ' + esc(fmtRate(p.up)) + '</span>';
        tip.style.display = 'inline-flex';
        const tw = tip.offsetWidth || 180;
        const th = tip.offsetHeight || 30;
        let left = mx + 14;
        if (left + tw > r.width - 8) left = mx - tw - 14;
        left = Math.max(6, Math.min(left, r.width - tw - 6));
        let top = my - th - 12;
        if (top < 6) top = my + 18;
        tip.style.left = (cv.offsetLeft + left) + 'px';
        tip.style.top = (cv.offsetTop + top) + 'px';
      });
      cv.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
    }
    const acv = $('activityChart');
    if (acv && !acv.dataset.tipBound) {
      acv.dataset.tipBound = '1';
      const wrap = acv.parentElement;
      if (wrap && getComputedStyle(wrap).position === 'static') wrap.classList.add('ent-chart-wrap');
      const tip = document.createElement('div');
      tip.className = 'ent-chart-tip'; tip.style.display = 'none';
      (wrap || acv.parentElement).appendChild(tip);
      acv.addEventListener('mousemove', e => {
        const pts = acv._pts;
        if (!pts || !pts.length) { tip.style.display = 'none'; return; }
        const r = acv.getBoundingClientRect();
        const mx = e.clientX - r.left;
        const my = e.clientY - r.top;
        const padL = acv._padL || 46;
        const iw = acv._iw || Math.max(1, r.width - padL - 10);
        const fx = (mx - padL) / iw;
        if (fx < -0.05 || fx > 1.05) { tip.style.display = 'none'; return; }
        const t0 = acv._t0, t1 = acv._t1;
        let p = null;
        if (t0 != null && t1 != null) {
          const mt = t0 + fx * (t1 - t0);
          let minDt = Infinity;
          for (let i = 0; i < pts.length; i++) {
            const item = pts[i];
            if (!item || item.t == null) continue;
            const dt = Math.abs(item.t - mt);
            if (dt < minDt) { minDt = dt; p = item; }
          }
        } else {
          const idx = Math.max(0, Math.min(pts.length - 1, Math.round(fx * (pts.length - 1))));
          p = pts[idx];
        }
        if (!p || p.t == null) { tip.style.display = 'none'; return; }
        const d = new Date(p.t * 1000);
        const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
        const hhmm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
        const when = (dashRange === '1h' || dashRange === '24h') ? hhmm : M + ' ' + d.getDate() + ' ' + hhmm;
        tip.innerHTML = '<span class="tip-time">' + esc(when) + '</span><span class="tip-sep">·</span>' +
          '<span style="color:#10b981;font-weight:600">● ' + esc(String(p.conns ?? 0)) + ' active connections</span>';
        tip.style.display = 'inline-flex';
        const tw = tip.offsetWidth || 160;
        const th = tip.offsetHeight || 30;
        let left = mx + 14;
        if (left + tw > r.width - 8) left = mx - tw - 14;
        left = Math.max(6, Math.min(left, r.width - tw - 6));
        let top = my - th - 12;
        if (top < 6) top = my + 18;
        tip.style.left = (acv.offsetLeft + left) + 'px';
        tip.style.top = (acv.offsetTop + top) + 'px';
      });
      acv.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
    }
    if (cv && d.history) cv._hist = d.history;
    const w = $('tunnelWarn');
    if (w) {
      if (!on) { w.innerHTML = '⚠️ <b>Tunnel is not running.</b> Go to Setup to configure GRE + FRP, or check the Tunnel tab.'; w.classList.remove('hidden'); }
      else w.classList.add('hidden');
    }
    const s = d.system || {};
    let cpu = s.cpu_pct != null ? parseFloat(s.cpu_pct) : null;
    if (cpu != null && !isFinite(cpu)) cpu = null;
    set('kpiCpu', cpu != null ? cpu.toFixed(1) + '%' : '…');
    set('kpiCpuSub', 'load ' + (s.load || NA) + ' · ' + (s.cores || '?') + ' cores');
    setBar('cpuBar', (cpu != null ? Math.min(100, Math.max(0, cpu)) : 0) + '%');
    const m = s.mem || {};
    let memp = m.pct != null ? parseFloat(m.pct) : null;
    if (memp != null && !isFinite(memp)) memp = null;
    set('kpiRam', memp != null ? memp.toFixed(1) + '%' : '…');
    set('kpiRamSub', m.used != null ? fmtBytes(m.used) + ' / ' + fmtBytes(m.total) + (m.cache ? ' · cache ' + fmtBytes(m.cache) : '') : '—');
    setBar('ramBar', (memp != null ? Math.min(100, Math.max(0, memp)) : 0) + '%');
    let dp = s.disk_pct != null ? parseFloat(s.disk_pct) : null;
    if (dp != null && !isFinite(dp)) dp = null;
    set('kpiDisk', dp != null ? dp.toFixed(1) + '%' : '…');
    set('kpiDiskSub', 'root partition');
    setBar('diskBar', (dp != null ? Math.min(100, Math.max(0, dp)) : 0) + '%');
    const u = d.uptime || {};
    set('kpiUp', fmtSecs(u.system));
    set('kpiUpSub', 'panel ' + fmtSecs(u.panel) + ' · ' + (d.conns != null ? d.conns + ' conns' : 'conns N/A'));
    // premium details: 3 categorized glass cards with badges + copy buttons.
    // dval() = plain text cell, dmono(ip) = mono pill + one-click copy,
    // dbadge() = status pill (ok/err/warn/neutral).
    const dval = v => `<span class="det-v">${esc(v ?? NA)}</span>`;
    const dmono = v => (!v || v === NA)
      ? `<span class="det-v">—</span>`
      : `<span style="display:flex;align-items:center;gap:6px;min-width:0"><span class="det-v mono">${esc(v)}</span><button class="det-copy" data-copy="${esc(v)}" title="Copy" aria-label="Copy">⧉</button></span>`;
    const dbadge = (txt, cls) => `<span class="det-v"><span class="badge ${cls || ''}"><span class="dot"></span>${esc(txt)}</span></span>`;
    const detCard = (icon, title, rows) =>
      `<div class="det-card"><div class="det-head"><span class="det-ico">${icon}</span>${esc(title)}</div><div class="det-rows">${rows}</div></div>`;
    const detRow = (k, cell) => `<div class="det-row"><span class="det-k">${esc(k)}</span>${cell}</div>`;
    const frpBadge = f.up ? dbadge(f.svc || tr('status_running', 'running'), 'ok') : dbadge(tr('status_down', 'down'), 'err');
    const roleBadge = d.role === 'iran' ? dbadge('🇮🇷 ' + (tr('x002', "Iran")), 'ok') : d.role === 'foreign' ? dbadge('🌍 ' + (tr('x003', "Foreign")), '') : dval(d.role);
    const bindPort = (f.port && f.port !== NA) ? String(f.port) : '';
    const proxyPorts = (f.proxy_ports || []).filter(p => p && String(p) !== bindPort);
    const isFrpc = (f.svc === 'frpc') || /foreign/i.test(d.role || '');
    const portLabel = isFrpc ? tr('lbl_control_port', 'Server Port') : tr('lbl_bind_port', 'Bind Port');
    const portCell = bindPort ? dmono(bindPort) : dval('—');
    const proxyList = (f.proxy_ports && f.proxy_ports.length) ? f.proxy_ports.join(', ') : ((f.proxies || []).join(', ') || '—');
    const activeEng = String(d.active_engine || 'frp').toUpperCase();
    const activeCarr = String(d.active_carrier || 'direct');
    const failoverBadge = d.auto_failover ? dbadge(tr('x004', "[ ON ] Auto-Switching"), 'warn') : dbadge(tr('x005', "[ OFF ] Manual Mode"), 'dim');
    const diagBadge = d.last_error
      ? `<span class="badge err" title="${esc(d.last_error.detail || '')}"><span class="dot"></span>${esc(d.last_error.code || 'ERR')} (${esc(String(d.last_error.time || '').slice(11, 19))})</span>`
      : dbadge(tr('x006', "Stable / Zero Drops"), 'ok');
    const ICO_BOLT = '<svg viewBox="0 0 24 24"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>';
    setHTML('dashDetails',
      detCard(ICO_SRV, tr('card_server_title', 'Server & Role'), detRow(tr('lbl_public_ip', 'Public IP'), dmono(d.local_pub)) + detRow(tr('lbl_role', 'Role'), roleBadge) + detRow(tr('lbl_forwarded_ports', 'Forwarded'), dval(proxyList)))
      + detCard(ICO_GRE, tr('card_gre_title', 'GRE Tunnel'), detRow(tr('lbl_gre_local', 'Local'), dmono(g.local)) + detRow(tr('lbl_gre_peer', 'Peer'), dmono(g.peer)) + detRow(tr('lbl_gre_interface', 'Inner'), dmono(g.inner)))
      + detCard(ICO_FRP, tr('card_frp_title', 'Tunnel Engine'), detRow(tr('lbl_frp_status', 'Status'), frpBadge) + detRow(tr('x007', "Engine"), dval(activeEng)) + detRow(portLabel, portCell)
        + (proxyPorts.length ? detRow(tr('lbl_tunnel_ports', 'Tunnel Ports'), `<span class="det-v">${proxyPorts.map(p => `<span class="det-v mono" style="margin-right:4px">${esc(String(p))}</span>`).join('')}</span>`) : '')
        + (u.frp_since ? detRow(tr('lbl_uptime_since', 'Since'), dval(u.frp_since)) : ''))
      + detCard(ICO_BOLT, tr('x008', "Carrier & Failover"), detRow(tr('x009', "Active Carrier"), dmono(activeCarr)) + detRow(tr('x010', "Failover Policy"), failoverBadge) + detRow(tr('x011', "Diagnostics"), diagBadge))
      + dashPeersCard(d.peers || []));
    // one-click copy for IP/port pills
    document.querySelectorAll('#dashDetails [data-copy]').forEach(b => { if (!b.dataset.cpBound) { b.dataset.cpBound = '1';
      b.onclick = () => { const v = b.dataset.copy; (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject())
        .then(() => { b.textContent = '✓'; b.classList.add('ok'); setTimeout(() => { b.textContent = '⧉'; b.classList.remove('ok'); }, 1200); })
        .catch(() => toastWarn('copy failed', v)); }; } });
    set('dashChecked', 'checked ' + String(d.checked || '').slice(11, 19));
    // click-through for dashboard peer rows → jump to the full card.
    document.querySelectorAll('#dashDetails [data-goto-peer]').forEach(b => { if (!b.dataset.cpBound) { b.dataset.cpBound = '1';
      b.onclick = () => gotoPeerCard(parseInt(b.dataset.gotoPeer, 10)); }; });
  } catch(e) { reportErr('dashboard', e); /* keep old values; N/A already default */ return false; }
  return true;
}
// Dashboard per-peer summary: one compact row per tunnel (name, status,
// foreign IP, forwarded ports, ping) + a jump to the full card in Tunnel.
// Hidden when there are no peers (single-tunnel servers stay unchanged).

function drawActivityChart(hist, isDown) {
  const cv = $('activityChart');
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || (cv.parentElement ? cv.parentElement.clientWidth : 600) || 600, H = 130;
  if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  
  const light = (document.body && document.body.dataset.t === 'light') ||
    (document.documentElement && document.documentElement.dataset.t === 'light');
  const C_GRID = light ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.06)';
  const C_AXIS = light ? 'rgba(24,24,27,0.6)' : 'rgba(255,255,255,0.45)';
  const C_IDLE = light ? 'rgba(24,24,27,0.55)' : 'rgba(255,255,255,0.45)';
  
  const pts = (hist || []).filter(p => p && p.t != null && p.conns != null);
  cv._pts = pts;
  if (pts.length < 2) {
    ctx.fillStyle = C_IDLE; ctx.font = '12px -apple-system, system-ui, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('Waiting for connection stream…', W/2, H/2);
    return;
  }
  
  const padL = 46, padR = 10, padT = 14, padB = 22;
  const iw = Math.max(10, W - padL - padR), ih = Math.max(10, H - padT - padB);
  cv._padL = padL; cv._iw = iw;
  
  let max = 5;
  pts.forEach(p => { if (p.conns > max) max = p.conns; });
  max = Math.ceil(max * 1.25);
  
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t, dt = (t1 - t0) || 1;
  cv._t0 = t0; cv._t1 = t1;
  const X = t => padL + ((t - t0) / dt) * iw;
  const Y = v => padT + ih - (v / max) * ih;
  
  // Gridlines & Axis labels
  ctx.strokeStyle = C_GRID;
  ctx.lineWidth = 1;
  for (let g = 0; g <= 2; g++) {
    const y = Math.round(padT + ih * g / 2) + 0.5;
    const val = Math.round(max * (1 - g / 2));
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.fillStyle = C_AXIS; ctx.font = '12px tabular-nums'; ctx.textAlign = 'right';
    ctx.fillText(String(val), padL - 8, y + 3);
  }
  
  // Time ticks on bottom
  const fmtTick = t => {
    const d = new Date(t * 1000);
    const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
    return (dashRange === '1h' || dashRange === '24h')
      ? String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0')
      : M + ' ' + d.getDate();
  };
  const nTicks = Math.max(2, Math.min(5, Math.floor(iw / 80)));
  ctx.fillStyle = C_AXIS; ctx.font = '12px -apple-system, system-ui, sans-serif'; ctx.textAlign = 'center';
  for (let k = 0; k < nTicks; k++) {
    const tickTime = t0 + (dt * k) / (nTicks - 1);
    const x = X(tickTime);
    ctx.fillText(fmtTick(tickTime), Math.min(Math.max(x, padL + 20), W - padR - 20), H - 5);
  }

  // Draw smooth Catmull-Rom curve
  const seq = pts.map(p => ({ x: X(p.t), y: Y(p.conns), val: p.conns, t: p.t }));
  ctx.beginPath();
  if (seq.length === 1) {
    ctx.moveTo(seq[0].x, seq[0].y);
    ctx.lineTo(seq[0].x + 0.01, seq[0].y);
  } else if (seq.length > 1) {
    ctx.moveTo(seq[0].x, seq[0].y);
    for (let i = 0; i < seq.length - 1; i++) {
      const p0 = seq[Math.max(0, i - 1)], p1 = seq[i], p2 = seq[i + 1], p3 = seq[Math.min(seq.length - 1, i + 2)];
      const c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6;
      const c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6;
      ctx.bezierCurveTo(c1x, c1y, c2x, c2y, p2.x, p2.y);
    }
  }
  
  const grad = ctx.createLinearGradient(0, padT, 0, padT + ih);
  if (light) {
    grad.addColorStop(0, 'rgba(16, 185, 129, 0.35)'); grad.addColorStop(1, 'rgba(16, 185, 129, 0)');
    ctx.strokeStyle = '#059669';
  } else {
    grad.addColorStop(0, 'rgba(52, 211, 153, 0.35)'); grad.addColorStop(1, 'rgba(52, 211, 153, 0)');
    ctx.strokeStyle = '#10b981';
  }
  
  ctx.lineWidth = 2; ctx.lineJoin = 'round';
  ctx.shadowColor = light ? 'rgba(5,150,105,0.3)' : 'rgba(16,185,129,0.5)';
  ctx.shadowBlur = 6;
  ctx.stroke();
  ctx.shadowBlur = 0;
  
  ctx.lineTo(seq[seq.length-1].x, padT + ih);
  ctx.lineTo(seq[0].x, padT + ih);
  ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();

  // End live point
  const last = seq[seq.length - 1];
  ctx.beginPath(); ctx.arc(last.x, last.y, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = light ? '#059669' : '#34d399';
  ctx.fill();
  ctx.beginPath(); ctx.arc(last.x, last.y, 1.5, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff'; ctx.fill();
}

// ICMP is metadata (health.go): a link whose control session is live is healthy
// even when ICMP is filtered, so show its TCP latency plus a muted chip - never "no ping".
function icmpChip() { return '<span class="qs-hint" style="margin-left:6px;opacity:.7">' + esc(tr('fleet_icmp_filtered', 'ICMP filtered')) + '</span>'; }
function linkPing(o) {
  if (o.ping_ok) return { ok: true, txt: o.ping_ms || 'ok', chip: '' };
  if (o.health_state === 'healthy') {
    const lat = (o.latency_ms != null && o.latency_ms >= 0) ? Math.round(o.latency_ms) + 'ms' : '';
    return { ok: true, txt: lat || tr('fleet_session_up', 'session up'), chip: o.icmp_filtered ? icmpChip() : '' };
  }
  return { ok: false, txt: '', chip: '' };
}
function pingText(o) { const p = linkPing(o); return p.ok ? p.txt : 'down'; }
function reasonsTip(o) { return (o.health_state && o.health_state !== 'healthy' && (o.reasons || []).length) ? esc(o.reasons.join(' \u00b7 ')) : ''; }
function pingBadge(o) {
  const p = linkPing(o), tip = reasonsTip(o);
  return '<span class="badge ' + (p.ok ? 'ok' : 'err') + '"' + (tip ? ' title="' + tip + '"' : '') + '><span class="dot"></span>' + esc(p.ok ? p.txt : 'no answer') + '</span>' + p.chip;
}
function fleetMs(n) { return n.ping_ms >= 0 ? n.ping_ms : (n.latency_ms >= 0 ? n.latency_ms : -1); }
function dashPeersCard(peers) {
  if (!peers || !peers.length) return '';
  const rows = peers.map(p => {
    const up = !!(p.gre_up || p.frp_up);
    const nm = p.name || ('peer-' + p.id);
    const pg = linkPing(p), pgTip = reasonsTip(p);
    const pingTxt = pg.ok ? pg.txt : tr('status_down', 'down');
    const pingCls = pg.ok ? 'ok' : 'err';
    const statusTxt = up ? (tr('x012', "tunnel up")) : tr('status_down', 'down');
    return `<div class="dash-peer-row" data-goto-peer="${p.id}" title="${tr('x013', "Open full card in Tunnel tab")}">`
      + `<span class="ent-st ${up ? 'on' : 'off'}"><i></i></span>`
      + `<b style="color:var(--tx)">${esc(nm)}</b><span class="qs-hint mono">#${p.id}</span>`
      + `<span class="badge ${up ? 'ok' : 'err'}"><span class="dot"></span>${statusTxt}</span>`
      + `<span class="det-v mono">${esc(p.remote_pub || '—')}</span>`
      + `<span class="qs-hint">${esc((p.ports || []).join(', ') || '—')} · </span><span class="badge ${pingCls}"${pgTip ? ` title="${pgTip}"` : ''}><span class="dot"></span>${esc(pingTxt)}</span>${pg.chip}`
      + `</div>`;
  }).join('');
  return `<div class="det-card u-col-full"><div class="det-head"><span class="det-ico">${ICO_SRV}</span>${esc(tr('card_peers_title', 'Peer Tunnels'))} (${peers.length})</div><div>${rows}</div></div>`;
}
// Scroll to a peer's full card (switches tab if needed).
function gotoPeerCard(peerId) {
  goTab('tunnel');
  requestAnimationFrame(() => {
    const el = $('peer-card-' + peerId);
    if (el && el.scrollIntoView) el.scrollIntoView({behavior: 'smooth', block: 'start'});
  });
}
// ---- setup form (unified Setup tab: step 1 role, steps 2-3 per role, + add-peer card) ----
let setupExists = false;
let setupUnlocked = false;
function setRole(role) {
  $('sRole').value = role;
  const iran = role === 'iran';
  $('roleIran').setAttribute('aria-pressed', iran);
  $('roleForeign').setAttribute('aria-pressed', !iran);
  $('iranWrap').hidden = !iran;
  $('foreignWrap').hidden = iran;
  // the add-peer card is an Iran-side action: hidden on foreign role
  // (refresh() re-applies this from live status as well).
  if ($('setupAddPeerStep')) $('setupAddPeerStep').hidden = !iran;
  if (iran) { if (!$('sLocalGre').value) $('sLocalGre').value = '10.10.10.2'; if (!$('sPeerGre').value) $('sPeerGre').value = '10.10.10.1'; }
  else { if (!$('fLocalGre').value) $('fLocalGre').value = '10.10.10.1'; if (!$('fPeerGre').value) $('fPeerGre').value = '10.10.10.2'; }
  renderSetupLock();
}
$('roleIran').onclick = () => setRole('iran');
$('roleForeign').onclick = () => setRole('foreign');
// Locked form: when a tunnel exists the Iran fields are disabled and the
// warnbox explains the two paths. Unlocking is the explicit replace consent
// (no modal confirm, no second Overwrite button doing the same thing).
function renderSetupLock() {
  const iran = $('sRole').value !== 'foreign';
  const locked = iran && setupExists && !setupUnlocked;
  const fs = $('iranFields');
  if (fs) fs.disabled = locked;
  const lw = $('setupLockWarn');
  if (lw) {
    if (locked) {
      lw.innerHTML = '⛔ A tunnel <b>already exists</b> on this server — the form is <b>locked</b> so it can\'t be replaced by accident. Applying a new setup generates a <b>new token</b> and old Foreign sides disconnect.';
      lw.classList.remove('hidden');
    } else lw.classList.add('hidden');
  }
  const show = (id, on) => { const el = $(id); if (el) el.classList.toggle('hidden', !on); };
  if (!iran) { show('setupBtn', false); show('setupUnlockBtn', false); show('setupAddBtn', false); show('setupRelockBtn', false); return; }
  if (!setupExists) {
    $('setupBtn').textContent = 'Apply setup';
    show('setupBtn', true); show('setupUnlockBtn', false); show('setupAddBtn', false); show('setupRelockBtn', false);
  } else if (locked) {
    show('setupBtn', false); show('setupUnlockBtn', true); show('setupAddBtn', true); show('setupRelockBtn', false);
  } else {
    $('setupBtn').textContent = 'Apply setup (replace)';
    show('setupBtn', true); show('setupUnlockBtn', false); show('setupAddBtn', false); show('setupRelockBtn', true);
  }
}
$('setupUnlockBtn').onclick = () => { setupUnlocked = true; renderSetupLock(); };
$('setupRelockBtn').onclick = () => { setupUnlocked = false; renderSetupLock(); };
function renderIranBundleBox(bundleStr) {
  const bb = $('setupBundle');
  if (!bb || !bundleStr) return;
  window._currentIranBundle = bundleStr;
  bb.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px">
      <span style="font-weight:600;color:var(--tx)">📦 Setup Bundle (Copy to Foreign server)</span>
      <button type="button" class="hashem-btn hashem-btn-primary" id="copyIranBundleBtn" style="padding:4px 14px;font-size:12px">📋 Copy Bundle</button>
    </div>
    <div style="font-family:var(--font-mono);font-size:12px;background:rgba(0,0,0,0.35);padding:10px 12px;border-radius:var(--r-sm);word-break:break-all;color:var(--cyan);user-select:all;border:1px solid rgba(56,189,248,0.25)">${esc(bundleStr)}</div>
    <div style="font-size:12px;color:var(--mu);margin-top:6px">Paste this single string into the Foreign server token box to establish the tunnel and peer link automatically.</div>
  `;
  bb.classList.remove('hidden');
  const btn = $('copyIranBundleBtn');
  if (btn) {
    btn.onclick = () => {
      (navigator.clipboard ? navigator.clipboard.writeText(bundleStr) : Promise.reject())
        .then(() => {
          btn.textContent = '✔️ Copied!';
          setTimeout(() => { btn.textContent = '📋 Copy Bundle'; }, 2000);
          toastOk('Bundle Copied!', 'Paste into Foreign server');
        })
        .catch(() => {
          prompt('Copy setup bundle:', bundleStr);
        });
    };
  }
}

async function copyMainIranBundle() {
  try {
    let b = window._currentIranBundle;
    if (!b) {
      const d = await api('/api/setup');
      if (d && d.bundle) {
        b = d.bundle;
        window._currentIranBundle = b;
      }
    }
    if (!b) {
      toastWarn('No bundle found', 'Setup an Iran tunnel first');
      return;
    }
    await (navigator.clipboard ? navigator.clipboard.writeText(b) : Promise.reject());
    toastOk('Bundle Copied!', 'Paste on Foreign server');
  } catch(e) {
    if (window._currentIranBundle) prompt('Copy setup bundle:', window._currentIranBundle);
    else toastWarn('Copy failed', e.message);
  }
}

async function loadSetupDefaults() {
  try {
    const d = await api('/api/setup');
    setupExists = !!d.exists;
    setupUnlocked = false;
    if (d.bundle) {
      window._currentIranBundle = d.bundle;
      // Keep bundle cached for on-demand actions; do not auto-display box on initial view
    }
    if (!$('sLocalPub').value) $('sLocalPub').value = d.local_public || '';
    if (!$('fLocalPub').value) $('fLocalPub').value = d.local_public || '';
    $('sLocalGre').value = '10.10.10.2'; $('sPeerGre').value = '10.10.10.1';
    $('fLocalGre').value = '10.10.10.1'; $('fPeerGre').value = '10.10.10.2';
    if (d.iran_gre) { $('sLocalGre').value = d.iran_gre; $('fPeerGre').value = d.iran_gre; }
    if (d.foreign_gre) { $('sPeerGre').value = d.foreign_gre; $('fLocalGre').value = d.foreign_gre; }
    if (!$('sFrpPort').value) $('sFrpPort').value = d.frp_port || 7000;
    if (!$('fFrpPort').value) $('fFrpPort').value = d.frp_port || 7000;
    const isForeignHost = d.role_guess && /foreign|frpc/.test(d.role_guess);
    setRole(isForeignHost ? 'foreign' : 'iran');
  } catch(e) { reportErr('setup', e); }
}
// Iran-only apply: token is auto-generated server-side. When a tunnel exists
// the form must be unlocked first (the lock IS the replace consent).
async function doSetup() {
  if ($('sRole').value === 'foreign') return;
  if (setupExists && !setupUnlocked) { toastWarn('form is locked', 'unlock to replace'); return; }
  const btn = $('setupBtn');
  btn.disabled = true;
  const oldTxt = btn.textContent;
  btn.innerHTML = '<span class="ent-spinner"></span> Applying…';
  $('setupToken').classList.add('hidden');
  $('setupWarn').classList.add('hidden');
  try {
    const selTrans = $('sTransport') ? $('sTransport').value : 'tcp';
    const body = {
      role: 'iran',
      engine: $('sEngine') ? $('sEngine').value : 'frp',
      transport: selTrans,
      frp_transport: ($('sEngine') && $('sEngine').value === 'frp') ? selTrans : '',
      local_public: $('sLocalPub').value.trim(),
      remote_public: $('sRemotePub').value.trim(),
      local_gre: $('sLocalGre') ? $('sLocalGre').value.trim() : '',
      peer_gre: $('sPeerGre') ? $('sPeerGre').value.trim() : '',
      frp_port: parseInt($('sFrpPort').value, 10),
      token: '',
      ports: ($('sIranPorts') && !$('wrapIranPorts').classList.contains('hidden')) ? $('sIranPorts').value.trim() : '',
      force: setupExists,
    };
    let r;
    try {
      r = await api('/api/setup', body);
    } catch(e) {
      const w = $('setupWarn');
      w.innerHTML = '⚠️ ' + esc(e.message);
      w.classList.remove('hidden');
      toastErr('setup failed', e.message);
      btn.disabled = false;
      btn.textContent = oldTxt;
      return;
    }
    const out = $('setupOut');
    out.classList.remove('hidden');
    out.textContent = (r.steps || []).join('\n');
    $('setupToken').classList.add('hidden');
    $('setupBundle').classList.add('hidden');
    if (r.bundle) {
      window._currentIranBundle = r.bundle;
      renderIranBundleBox(r.bundle);
    }
    if (r.token) {
      const t = $('setupToken');
      t.innerHTML = '🔑 Token (legacy 32-char, for old panels): <b>' + esc(r.token) + '</b>';
      t.classList.remove('hidden');
    }
    toastOk('setup done', 'iran');
    setupUnlocked = false;
  } catch(e) {
    toastErr('setup failed', e.message);
    if (e.steps && e.steps.length) {
      const out = $('setupOut');
      out.classList.remove('hidden');
      out.textContent = e.steps.join('\n');
    }
  }
  btn.disabled = false;
  btn.textContent = oldTxt;
  renderSetupLock();
}
$('setupBtn').onclick = () => doSetup();

function updateTransportSelect(selId, eng) {
  const el = $(selId);
  if (!el) return;
  const cur = el.value;
  if (eng === 'frp') {
    el.innerHTML = `
      <option value="tcp">TCP Multiplexed (Default)</option>
      <option value="kcp">KCP ARQ UDP (Anti-Loss)</option>
      <option value="quic">QUIC UDP Stream (High-Speed)</option>
      <option value="websocket">WebSocket (HTTP Upgrade)</option>
      <option value="wss">WSS TLS (Obfuscated)</option>
    `;
    if (['tcp', 'kcp', 'quic', 'websocket', 'wss'].includes(cur)) el.value = cur;
    else el.value = 'tcp';
  } else {
    el.innerHTML = `
      <option value="tcpmux">TCPMUX (Multi-stream TCP - Recommended)</option>
      <option value="wssmux">WSSMUX (WebSocket + TLS Obfuscation)</option>
      <option value="tcp">TCP (Standard Plain TCP)</option>
      <option value="ws">WS (Plain WebSocket)</option>
      <option value="wsmux">WSMUX (Multiplexed WebSocket)</option>
      <option value="wss">WSS (TLS WebSocket)</option>
    `;
    if (['tcpmux', 'wssmux', 'tcp', 'ws', 'wsmux', 'wss'].includes(cur)) el.value = cur;
    else el.value = 'tcpmux';
  }
}

function setIranEngine(eng) {
  const isBh = eng === 'backhaul';
  const isGreBh = eng === 'gre-backhaul';
  if ($('sEngine')) $('sEngine').value = eng;
  if ($('engGreFrp')) $('engGreFrp').setAttribute('aria-pressed', eng === 'frp');
  if ($('engGreBh')) $('engGreBh').setAttribute('aria-pressed', isGreBh);
  if ($('engBh')) $('engBh').setAttribute('aria-pressed', isBh);
  if ($('wrapLocalGre')) $('wrapLocalGre').classList.toggle('hidden', isBh);
  if ($('wrapPeerGre')) $('wrapPeerGre').classList.toggle('hidden', isBh);
  if ($('wrapTransport')) $('wrapTransport').classList.remove('hidden');
  updateTransportSelect('sTransport', eng);
  if ($('wrapIranPorts')) $('wrapIranPorts').classList.toggle('hidden', eng === 'frp');
  if ($('engHint')) {
    if (eng === 'frp') {
      $('engHint').textContent = 'High-stability Linux GRE kernel tunnel paired with FRP reverse proxy.';
    } else if (isGreBh) {
      $('engHint').textContent = 'Linux GRE tunnel carries multiplexed Backhaul connections for ultra-low overhead and maximum throughput.';
    } else {
      $('engHint').textContent = 'Pure user-space multiplexed reverse tunnel over public IP. No GRE interfaces required.';
    }
  }
}
if ($('engGreFrp')) $('engGreFrp').onclick = () => setIranEngine('frp');
if ($('engGreBh')) $('engGreBh').onclick = () => setIranEngine('gre-backhaul');
if ($('engBh')) $('engBh').onclick = () => setIranEngine('backhaul');

if ($('pEngine')) {
  $('pEngine').addEventListener('change', () => {
    const v = $('pEngine').value;
    const isBh = v === 'backhaul';
    if ($('wrapPeerTransport')) $('wrapPeerTransport').classList.remove('hidden');
    updateTransportSelect('pTransport', v);
    if ($('wrapPeerLocalGre')) $('wrapPeerLocalGre').classList.toggle('hidden', isBh);
    if ($('wrapPeerPeerGre')) $('wrapPeerPeerGre').classList.toggle('hidden', isBh);
  });
}

// Foreign join: bundle-first UX supporting hsh1_, bh1_, and gh1_ bundles.
function parseBundleClient(s) {
  s = (s || '').trim();
  const v4 = ip => /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) && ip.split('.').every(o => +o <= 255);
  if (s.startsWith('bh1_')) {
    const parts = s.slice(4).split('_');
    if (parts.length < 4 || parts.length > 5) return {error: 'bh1 bundle must have 4 or 5 parts'};
    const [iranPub, portS, transport, token] = parts;
    if (!v4(iranPub)) return {error: 'bad Iran public IP in bundle'};
    const port = parseInt(portS, 10);
    if (!/^\d+$/.test(portS) || port < 1 || port > 65535) return {error: 'bad port in bundle'};
    if (!token || token.length > 128) return {error: 'bad token in bundle'};
    const rawPorts = (parts[4] || '').trim();
    return {engine: 'backhaul', iranPub, port, transport: transport || 'tcpmux', token, rawPorts, ports: rawPorts ? rawPorts.split(',') : []};
  }
  if (s.startsWith('gh1_')) {
    const parts = s.slice(4).split('_');
    if (parts.length < 6 || parts.length > 7) return {error: 'gh1 bundle must have 6 or 7 parts'};
    const [iranPub, portS, iranGre, foreignGre, transport, token] = parts;
    if (!v4(iranPub)) return {error: 'bad Iran public IP in bundle'};
    const port = parseInt(portS, 10);
    if (!/^\d+$/.test(portS) || port < 1 || port > 65535) return {error: 'bad port in bundle'};
    if (!v4(iranGre)) return {error: 'bad Iran GRE IP in bundle'};
    if (!v4(foreignGre)) return {error: 'bad foreign GRE IP in bundle'};
    if (!token || token.length > 128) return {error: 'bad token in bundle'};
    const rawPorts = (parts[6] || '').trim();
    return {engine: 'gre-backhaul', iranPub, port, iranGre, foreignGre, transport: transport || 'tcpmux', token, rawPorts, ports: rawPorts ? rawPorts.split(',') : []};
  }
  if (s.startsWith('hsh1_')) {
    const parts = s.slice(5).split('_');
    if (parts.length < 5 || parts.length > 7) return {error: 'bundle must have 5, 6, or 7 underscore parts'};
    const [iranPub, portS, iranGre, foreignGre, token] = parts;
    if (!v4(iranPub)) return {error: 'bad Iran public IP in bundle'};
    const port = parseInt(portS, 10);
    if (!/^\d+$/.test(portS) || port < 1 || port > 65535) return {error: 'bad control port in bundle'};
    if (!v4(iranGre)) return {error: 'bad Iran GRE IP in bundle'};
    if (!v4(foreignGre)) return {error: 'bad foreign GRE IP in bundle'};
    if (!token || token.length > 128) return {error: 'bad token in bundle'};
    let ports = [];
    let fouPorts = [];
    for (let i = 5; i < parts.length; i++) {
      const p = parts[i];
      if (!p) continue;
      if (p.startsWith('fou')) {
        const fps = p.slice(3).split('-').map(x => parseInt(x.trim(), 10)).filter(x => x >= 1 && x <= 65535);
        if (fps.length) fouPorts = fps;
      } else {
        const parsed = p.split(/[-,]/).map(x => parseInt(x.trim(), 10)).filter(x => x >= 1 && x <= 65535);
        if (parsed.length) ports = parsed;
      }
    }
    return {engine: 'frp', iranPub, port, iranGre, foreignGre, token, ports, fouPorts};
  }
  return null;
}

// Pasting a bundle auto-fills ports + advanced fields
$('jToken').addEventListener('input', () => {
  const w = $('joinWarn');
  const raw = $('jToken').value.trim();
  const isBundle = raw.startsWith('hsh1_') || raw.startsWith('bh1_') || raw.startsWith('gh1_');
  if (!isBundle) return;
  const b = parseBundleClient(raw);
  if (!b || b.error) {
    w.innerHTML = '⚠️ ' + esc(b ? b.error : 'bad bundle') + ' — check the paste, or use a legacy token + manual fields.';
    w.classList.remove('hidden');
    return;
  }
  w.classList.add('hidden');
  const forceSet = (id, v) => { const el = $(id); if (el) el.value = v; };
  if (b.engine === 'backhaul') {
    forceSet('jPorts', b.rawPorts || (b.ports.length ? b.ports.join(', ') : ''));
    forceSet('fRemotePub', b.iranPub);
    forceSet('fFrpPort', String(b.port));
    const adv = $('foreignAdv');
    if (adv && !adv.open) adv.open = true;
    w.innerHTML = '⚡ Backhaul Standalone bundle detected (Iran: <b>' + esc(b.iranPub) + '</b>, Port: <b>' + b.port + '</b>, Transport: <b>' + esc(b.transport) + '</b>).';
    w.classList.remove('hidden');
    w.style.color = '#38bdf8';
  } else if (b.engine === 'gre-backhaul') {
    forceSet('jPorts', b.rawPorts || (b.ports.length ? b.ports.join(', ') : ''));
    forceSet('fRemotePub', b.iranPub);
    forceSet('fLocalGre', b.foreignGre);
    forceSet('fPeerGre', b.iranGre);
    forceSet('fFrpPort', String(b.port));
    const adv = $('foreignAdv');
    if (adv && !adv.open) adv.open = true;
    w.innerHTML = '⚡ GRE+Backhaul bundle detected (Iran: <b>' + esc(b.iranPub) + '</b>, Port: <b>' + b.port + '</b>, Transport: <b>' + esc(b.transport) + '</b>).';
    w.classList.remove('hidden');
    w.style.color = '#c084fc';
  } else {
    forceSet('jPorts', b.ports.length ? b.ports.join(', ') : '');
    forceSet('fRemotePub', b.iranPub);
    forceSet('fLocalGre', b.foreignGre);
    forceSet('fPeerGre', b.iranGre);
    forceSet('fFrpPort', String(b.port));
    const adv = $('foreignAdv');
    if (adv && !adv.open) adv.open = true;
    if (!b.ports.length) {
      w.innerHTML = 'ℹ️ Bundle parsed (Iran: <b>' + esc(b.iranPub) + '</b>, FRP port: <b>' + b.port + '</b>). Enter reverse ports above.';
      w.classList.remove('hidden');
      w.style.color = 'var(--info, #38bdf8)';
    }
  }
});

$('joinBtn').onclick = async () => {
  const b = $('joinBtn');
  b.disabled = true;
  const oldTxt = b.textContent;
  b.innerHTML = '<span class="ent-spinner"></span> Connecting…';
  $('joinWarn').classList.add('hidden');
  try {
    const st = await api('/api/status').then(s => s.local || {}).catch(() => ({}));
    const d = await api('/api/setup').catch(() => ({}));
    const rawToken = $('jToken').value.trim();
    let token = rawToken, bundle = null;
    const isBundle = rawToken.startsWith('hsh1_') || rawToken.startsWith('bh1_') || rawToken.startsWith('gh1_');
    if (isBundle) {
      bundle = parseBundleClient(rawToken);
      if (!bundle || bundle.error) {
        const w = $('joinWarn');
        w.innerHTML = '⚠️ ' + esc(bundle ? bundle.error : 'bad bundle') + ' — check the paste, or use a legacy token + manual fields.';
        w.classList.remove('hidden');
        b.disabled = false; b.textContent = oldTxt; return;
      }
      token = bundle.token;
      if (!$('jPorts').value.trim() && bundle.ports.length) {
        $('jPorts').value = bundle.rawPorts || bundle.ports.join(', ');
      }
    }
    const ports = $('jPorts').value.trim() || ((st.proxy_ports || []).join(', ') || (st.proxies || []).join(', '));
    if (!token) {
      const w = $('joinWarn');
      w.innerHTML = '⚠️ Token is required — paste the bundle or token from the Iran side (Setup tab → step 4 bundle box, or Tunnel tab peer card → Bundle).';
      w.classList.remove('hidden');
      b.disabled = false; b.textContent = oldTxt; return;
    }
    const m = (st.gre || {});
    const adv = id => { const el = $(id); return el ? el.value.trim() : ''; };
    const ppVal = $('jProxyProtocol') && $('jProxyProtocol').checked ? 'v2' : 'off';
    const frpTransVal = $('jFRPTransport') ? $('jFRPTransport').value : 'tcp';
    const encVal = $('jEncryption') && $('jEncryption').checked;
    const compVal = $('jCompression') && $('jCompression').checked;
    const body = bundle ? {
      role: 'foreign',
      engine: bundle.engine || 'frp',
      transport: bundle.transport || 'tcpmux',
      frp_transport: frpTransVal,
      use_encryption: encVal,
      use_compression: compVal,
      proxy_protocol: ppVal,
      local_public: adv('fLocalPub') || m.local || d.local_public || '',
      remote_public: bundle.iranPub || m.peer_ip || '',
      local_gre: bundle.foreignGre || (m.inner || '').split('/')[0] || '',
      peer_gre: bundle.iranGre || '',
      frp_port: bundle.port,
      token: rawToken,
      ports, force: true,
    } : {
      role: 'foreign',
      frp_transport: frpTransVal,
      use_encryption: encVal,
      use_compression: compVal,
      proxy_protocol: ppVal,
      local_public: m.local || adv('fLocalPub') || d.local_public || '',
      remote_public: m.peer_ip || adv('fRemotePub') || $('sRemotePub').value.trim(),
      local_gre: (m.inner || '').split('/')[0] || adv('fLocalGre') || $('sLocalGre').value.trim(),
      peer_gre: peerInnerHint(st) || adv('fPeerGre') || $('sPeerGre').value.trim(),
      frp_port: st.frp_port || parseInt(adv('fFrpPort') || $('sFrpPort').value, 10) || 7000,
      token, ports, force: true,
    };
    if (!body.ports) {
      const w = $('joinWarn');
      const bundleNoPorts = bundle && bundle.ports.length === 0;
      w.innerHTML = bundleNoPorts
        ? '⚠️ This bundle does not include ports — enter the reverse ports (e.g. 443, 2083) in the Reverse Ports field above.'
        : '⚠️ Reverse ports are required (e.g. 443, 2083).';
      w.classList.remove('hidden');
      b.disabled = false; b.textContent = oldTxt; return;
    }
    const r = await api('/api/setup', body);
    const out = $('joinOut');
    out.classList.remove('hidden');
    out.textContent = (r.steps || []).join('\n');
    toastOk('connected to Iran');
    refresh(); loadSetupDefaults();
  } catch(e) {
    const w = $('joinWarn');
    w.innerHTML = '⚠️ ' + esc(e.message);
    w.classList.remove('hidden');
    if (e.steps && e.steps.length) {
      const out = $('joinOut');
      out.classList.remove('hidden');
      out.textContent = e.steps.join('\n');
    }
  }
  b.disabled = false;
  b.textContent = oldTxt;
};
// best-effort Iran-side inner IP hint: known default, else peer GRE +/-1 guess
function peerInnerHint(st) {
  if (st && st.gre_peer) return st.gre_peer;
  return '';
}

function doLogin() {
  return (async () => {
    try {
      await api('/api/login', {username: $('u').value, password: $('p').value, code: $('totpCode').value.trim()});
      $('p').value = ''; $('totpCode').value = ''; $('codeField').classList.add('hidden'); $('loginErr').textContent = '';
      showApp(); refresh(); loadSetupDefaults(); loadVersion(); termFlagRefresh(); tlsRefresh(); twofaRefresh(); idleRefresh(); termAllowRefresh(); alertsRefresh(); metricsRefresh(); histRefresh(); advisorRefresh();
    } catch(e) {
      if (e.code === 'E-AUTH-09') { $('codeField').classList.remove('hidden'); $('totpCode').focus(); }
      $('loginErr').textContent = e.message;
    }
  })();
}
$('loginForm').addEventListener('submit', e => { e.preventDefault(); doLogin(); });
$('u').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('p').focus(); } });
$('toggle').addEventListener('click', () => {
  const i = $('p'), t = $('toggle'), e = $('eye');
  const show = i.type === 'password';
  i.type = show ? 'text' : 'password';
  t.setAttribute('aria-pressed', show); t.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  e.innerHTML = show
    ? '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/><path d="M3 3l18 18"/>'
    : '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>';
  i.focus();
});
// kinetic grid background (same as Hashem login)
(function(){
  const CELL_SIZE = 55, INFLUENCE_RADIUS = 260, MAX_WARP = 24;
  const INFLUENCE_RADIUS_SQ = INFLUENCE_RADIUS * INFLUENCE_RADIUS;
  const DOT_SPACING = 28, LERP_SPEED = 0.08;
  const LINE_BASE = { r: 255, g: 255, b: 255, a: 0.13 };
  const NODE_BASE_RADIUS = 1.8, NODE_ACTIVE_RADIUS = 3.2;
  const lerpN = (a,b,t) => a + (b - a) * t;
  const lerpColor = (base,active,t) => {
    const r = Math.round(lerpN(base.r,active.r,t)), g = Math.round(lerpN(base.g,active.g,t)),
          b = Math.round(lerpN(base.b,active.b,t)), a = lerpN(base.a,active.a,t);
    return 'rgba('+r+','+g+','+b+','+a.toFixed(3)+')';
  };
  const canvas = document.getElementById('kineticGrid');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, mouse = {x:-9999,y:-9999}, targetMouse = {x:-9999,y:-9999}, ripples = [];
  const theme = { bg:'#09090b', lineActive:{r:56,g:189,b:248,a:0.9},
    nodeActive:{r:56,g:189,b:248,a:1.0}, glow:'56,189,248', ripple:'56,189,248' };

  // Offscreen canvas cache for static background dot grid
  const bgCanvas = document.createElement('canvas');
  const bgCtx = bgCanvas.getContext('2d');
  function renderStaticBg() {
    bgCanvas.width = W;
    bgCanvas.height = H;
    bgCtx.fillStyle = theme.bg;
    bgCtx.fillRect(0, 0, W, H);
    bgCtx.fillStyle = 'rgba(255,255,255,0.05)';
    for (let x = DOT_SPACING/2; x < W; x += DOT_SPACING) {
      for (let y = DOT_SPACING/2; y < H; y += DOT_SPACING) {
        bgCtx.beginPath();
        bgCtx.arc(x, y, 0.7, 0, Math.PI * 2);
        bgCtx.fill();
      }
    }
  }

  // Pre-allocated reusable grid point and proximity buffers
  let cols = 0, rows = 0, cellW = 0, cellH = 0;
  let pts = [], prox = [];
  function allocateBuffers() {
    cols = Math.max(2, Math.ceil(W / CELL_SIZE)) + 1;
    rows = Math.max(2, Math.ceil(H / CELL_SIZE)) + 1;
    cellW = W / (cols - 1);
    cellH = H / (rows - 1);
    pts = new Array(rows);
    prox = new Array(rows);
    for (let r = 0; r < rows; r++) {
      pts[r] = new Array(cols);
      prox[r] = new Float32Array(cols);
      for (let c = 0; c < cols; c++) {
        pts[r][c] = { x: 0, y: 0 };
      }
    }
  }

  function setSize(){
    W = innerWidth; H = innerHeight;
    canvas.width = W; canvas.height = H;
    renderStaticBg();
    allocateBuffers();
    if (mouse.x === -9999) { mouse = {x:W/2,y:H/2}; targetMouse = {x:W/2,y:H/2}; }
  }
  addEventListener('resize', setSize); setSize();
  addEventListener('mousemove', e => { targetMouse.x = e.clientX; targetMouse.y = e.clientY; });
  addEventListener('click', e => { ripples.push({x:e.clientX,y:e.clientY,radius:0,opacity:1,born:performance.now()}); });

  function updateWarpedPoint(gx, gy, col, row, targetPt, rowIdx, colIdx){
    const edgeMargin = 1.5;
    const colPin = Math.min(col/edgeMargin,(cols-1-col)/edgeMargin,1);
    const rowPin = Math.min(row/edgeMargin,(rows-1-row)/edgeMargin,1);
    const pinFactor = colPin*colPin*rowPin*rowPin;

    const dx = gx - mouse.x, dy = gy - mouse.y;
    const distSq = dx * dx + dy * dy;
    let proximity = 0, mx = 0, my = 0;

    if (distSq < INFLUENCE_RADIUS_SQ && distSq > 0 && pinFactor > 0){
      const dist = Math.sqrt(distSq);
      const t = dist / INFLUENCE_RADIUS;
      proximity = (1 - t) * pinFactor;
      const eased = t < 0.01 ? 0 : (1 - t) * (1 - t) * Math.min(1, dist / 60);
      const warpAmt = eased * MAX_WARP * pinFactor;
      const invDist = 1 / dist;
      mx = -dx * invDist * warpAmt;
      my = -dy * invDist * warpAmt;
    }

    let rx = 0, ry = 0;
    const waveWidth = 55;
    for (let i = 0; i < ripples.length; i++){
      const r = ripples[i];
      const rdx = gx - r.x, rdy = gy - r.y;
      const rdistSq = rdx * rdx + rdy * rdy;
      const minR = Math.max(0, r.radius - waveWidth);
      const maxR = r.radius + waveWidth;
      if (rdistSq >= minR * minR && rdistSq <= maxR * maxR) {
        const rdist = Math.sqrt(rdistSq);
        const diff = rdist - r.radius;
        if (Math.abs(diff) < waveWidth){
          const strength = (1 - Math.abs(diff) / waveWidth) * r.opacity * 18 * pinFactor;
          const invRDist = rdist > 0 ? 1 / rdist : 0;
          const sign = diff < 0 ? 1 : -1;
          rx += rdx * invRDist * strength * sign;
          ry += rdy * invRDist * strength * sign;
        }
      }
    }

    targetPt.x = gx + mx + rx;
    targetPt.y = gy + my + ry;
    prox[rowIdx][colIdx] = proximity;
  }

  function draw(now){
    ctx.drawImage(bgCanvas, 0, 0);

    for (let i = ripples.length-1; i >= 0; i--){
      const r = ripples[i], age = (now-r.born)/1000;
      r.radius = Math.max(0,age*400); r.opacity = Math.max(0,1-age*1.2);
      if (r.opacity <= 0) {
        ripples[i] = ripples[ripples.length - 1];
        ripples.pop();
      }
    }

    for (let row = 0; row < rows; row++){
      for (let col = 0; col < cols; col++){
        updateWarpedPoint(col*cellW, row*cellH, col, row, pts[row][col], row, col);
      }
    }

    const drawSeg = (p1,p2,pr1,pr2) => {
      const avg = (pr1+pr2)/2, t = avg*avg*(3-2*avg);
      ctx.beginPath(); ctx.moveTo(p1.x,p1.y); ctx.lineTo(p2.x,p2.y);
      ctx.strokeStyle = lerpColor(LINE_BASE,theme.lineActive,t);
      ctx.lineWidth = lerpN(0.8,1.5,t); ctx.stroke();
    };
    ctx.lineCap = 'butt';
    for (let row = 0; row < rows; row++)
      for (let col = 0; col < cols-1; col++) drawSeg(pts[row][col],pts[row][col+1],prox[row][col],prox[row][col+1]);
    for (let col = 0; col < cols; col++)
      for (let row = 0; row < rows-1; row++) drawSeg(pts[row][col],pts[row+1][col],prox[row][col],prox[row+1][col]);
    for (let row = 0; row < rows; row++)
      for (let col = 0; col < cols; col++){
        const p = pts[row][col], pr = prox[row][col], t = pr*pr*(3-2*pr);
        const r = lerpN(NODE_BASE_RADIUS,NODE_ACTIVE_RADIUS,t);
        if (t > 0.3){
          const glowR = r+lerpN(0,6,(t-0.3)/0.7);
          const grd = ctx.createRadialGradient(p.x,p.y,r*0.5,p.x,p.y,glowR);
          grd.addColorStop(0,'rgba('+theme.glow+','+(t*0.3).toFixed(3)+')');
          grd.addColorStop(1,'rgba('+theme.glow+',0)');
          ctx.beginPath(); ctx.arc(p.x,p.y,glowR,0,Math.PI*2);
          ctx.fillStyle = grd; ctx.fill();
        }
        ctx.beginPath(); ctx.arc(p.x,p.y,r,0,Math.PI*2);
        ctx.fillStyle = lerpColor({r:255,g:255,b:255,a:0.2},theme.nodeActive,t); ctx.fill();
      }
    for (let i = 0; i < ripples.length; i++){
      const r = ripples[i];
      ctx.beginPath(); ctx.arc(r.x,r.y,Math.max(0,r.radius),0,Math.PI*2);
      ctx.strokeStyle = 'rgba('+theme.ripple+','+(r.opacity*0.28).toFixed(3)+')';
      ctx.lineWidth = 1.5; ctx.stroke();
    }
  }

  (function animate(now){
    if (document.hidden || $('login')?.classList.contains('hidden')) {
      requestAnimationFrame(animate);
      return;
    }
    mouse.x = lerpN(mouse.x,targetMouse.x,LERP_SPEED);
    mouse.y = lerpN(mouse.y,targetMouse.y,LERP_SPEED);
    draw(now);
    requestAnimationFrame(animate);
  })(0);
})();
$('logoutBtn').onclick = async () => { try { await api('/api/logout', {}); } catch(e){ /* logout best-effort: always fall through to login screen */ } showLogin(); };
$('refreshBtn').onclick = refresh;
$('removeTunnelBtn').onclick = async () => {
  if (!await entConfirm('Remove tunnel?', 'Remove the tunnel from THIS server? GRE + FRP will be deleted; the panel stays.', 'Remove tunnel')) return;
  const b = $('removeTunnelBtn');
  b.disabled = true;
  try {
    const r = await api('/api/action', {action: 'remove-tunnel'});
    $('actOut').classList.remove('hidden');
    $('actOut').textContent = r.output || 'tunnel removed';
    toastOk('tunnel removed');
    refresh();
  } catch(e) { toastErr('tunnel remove failed', e.message); }
  b.disabled = false;
};
$('optimizeBtn').onclick = async () => {
  if (!await entConfirm('Optimize network?', 'Optimize network for tunnel throughput? (BBR + buffers + MTU/MSS — current settings are backed up first)', 'Optimize')) return;
  const b = $('optimizeBtn');
  b.disabled = true;
  try {
    const r = await api('/api/action', {action: 'optimize'});
    $('actOut').classList.remove('hidden');
    $('actOut').textContent = r.output || 'optimized';
    $('restoreBtn').classList.remove('hidden');
    toastOk('tunnel optimized');
    refresh();
  } catch(e) { toastErr('optimize failed', e.message); }
  b.disabled = false;
};
$('restoreBtn').onclick = async () => {
  if (!await entConfirm('Restore settings?', 'Restore the settings from before optimization?', 'Restore')) return;
  const b = $('restoreBtn');
  b.disabled = true;
  try {
    const r = await api('/api/action', {action: 'restore'});
    $('actOut').classList.remove('hidden');
    $('actOut').textContent = r.output || 'restored';
    toastOk('settings restored');
    refresh();
  } catch(e) { toastErr('restore failed', e.message); }
  b.disabled = false;
};
document.querySelectorAll('[data-act]').forEach(b => b.onclick = async () => {
  b.disabled = true;
  try {
    const r = await api('/api/action', {action: b.dataset.act});
    $('actOut').classList.remove('hidden');
    $('actOut').textContent = r.output || 'ok';
    toastOk(b.dataset.act + ' ok');
    refresh();
  } catch(e) { toastErr(b.dataset.act + ' failed', e.message); }
  b.disabled = false;
});
let logSvc = 'frps', logTimer = null, logRaw = '', logFindings = [];
function logLevelMatch(line, lvl) {
  if (!lvl) return true;
  const l = line.toLowerCase();
  if (lvl === 'error') return /error|fail|refus|denied|panic|fatal/.test(l);
  if (lvl === 'warn') return /warn|error|fail|refus|denied|retry|timeout/.test(l);
  if (lvl === 'login') return /login|auth|sess|password|unauthor/.test(l);
  return true;
}
function paintLogs() {
  const q = ($('logSearch').value || '').toLowerCase();
  const lvl = $('logLevel').value;
  const lines = logRaw.split('\n').filter(ln => (!q || ln.toLowerCase().includes(q)) && logLevelMatch(ln, lvl));
  if (lines.length) $('logs').textContent = lines.join('\n');
  else $('logs').innerHTML = stateEmpty({ title: tr('empty_logs_title', 'No log lines'), msg: tr('empty_logs_msg', 'Nothing to show for this service yet.'), actionKey: 'logs', compact: true });
  $('logMeta').textContent = logRaw ? `${logRaw.split('\n').length} lines from ${logSvc} · showing ${lines.length}` : '—';
  const box = $('logFindings');
  if (!logFindings.length) { box.innerHTML = '<div class="qs-hint">\u2713 no known error signatures in these lines.</div>'; }
  else box.innerHTML = logFindings.map(f =>
    `<div style="border:1px solid rgba(255,90,90,.35);background:rgba(255,90,90,.07);border-radius:10px;padding:10px 12px">` +
    `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="badge" style="border-color:rgba(255,90,90,.5);color:#ff8f8f"><span class="dot" style="background:#ff5f5f"></span>${esc(f.code)}${f.count > 1 ? ' ×' + f.count : ''}</span>` +
    `<b>${esc(f.msg)}</b></div>` +
    (f.hint ? `<div class="qs-hint u-mt-4">\u21AA ${esc(f.hint)}</div>` : '') +
    (f.line ? `<div class="qs-hint" style="margin-top:4px;font-family:monospace">“${esc(f.line)}”</div>` : '') +
    `</div>`).join('');
}
async function loadErrors() {
  try {
    const j = await api('/api/errors?n=50');
    const evs = j.events || [];
    const ec = $('errCount'); if (ec) ec.textContent = evs.length ? evs.length + ' recorded' : '';
    $('errList').innerHTML = evs.length ? '<div class="ent-tbl-wrap" tabindex="0"><table class="ent-tbl ent-stack"><thead><tr><th data-sort="0" tabindex="0" aria-sort="none">Code</th><th data-sort="1" tabindex="0" aria-sort="none">Time · Endpoint</th><th data-sort="2" tabindex="0" aria-sort="none">Detail</th></tr></thead><tbody>'
      + evs.slice().reverse().map(e =>
      `<tr><td data-label="Code"><span class="badge err"><span class="dot"></span>${esc(e.code)}</span></td>` +
      `<td data-label="Time" class="mono u-ws-normal">${esc(e.time || '')}<br>${esc(e.endpoint || '')}</td>` +
      `<td data-label="Detail" class="u-ws-normal">${esc(e.detail || '')}</td></tr>`).join('') + '</tbody></table></div>'
      : stateEmpty({ title: tr('empty_errors_title', 'No panel errors'), msg: tr('empty_errors_msg', 'Clean run — every failure will appear here with its code.'), compact: true });
    if (typeof tblRefilter === 'function') tblRefilter();
  } catch(e) { reportErr('errors', e); $('errList').innerHTML = stateError(e.message, 'errors', true); }
}
async function loadLogs() {
  const pre = $('logs');
  if (!logRaw) pre.innerHTML = skel(4);
  try {
    const r = await fetch(at('/api/logs?svc=' + encodeURIComponent(logSvc) + '&n=' + $('logLines').value));
    const j = await r.json();
    logRaw = j.logs || '';
    logFindings = j.findings || [];
    paintLogs();
  } catch(e) {
    reportErr('logs', e);
    if (!logRaw) { pre.innerHTML = stateError(e.message, 'logs', true); }
  }
}
function setLogSvc(svc) {
  logSvc = svc;
  document.querySelectorAll('#logSvcSeg [data-log]').forEach(x => x.setAttribute('aria-pressed', x === svc));
  loadLogs();
}
function armLogFollow() {
  if (logTimer) clearInterval(logTimer);
  logTimer = setInterval(() => {
    if (document.hidden) return;
    if (!$('app').classList.contains('hidden') && !$('tab-logs').hidden && $('logFollow').checked) { loadLogs(); loadErrors(); }
  }, 5000);
}
document.querySelectorAll('#logSvcSeg [data-log]').forEach(b => b.onclick = () => setLogSvc(b.dataset.log));
$('errRefresh').onclick = loadErrors;
$('logSearch').oninput = paintLogs;
$('logLevel').onchange = paintLogs;
$('logLines').onchange = loadLogs;
// peer tunnel log buttons appear once peers exist
async function refreshLogPeers() {
  try {
    const s = await api('/api/status');
    const seg = $('logSvcSeg');
    seg.querySelectorAll('[data-peerlog]').forEach(b => b.remove());
    (s.peers || []).forEach(p => {
      const b = document.createElement('button');
      b.dataset.log = p.frps_svc; b.setAttribute('data-peerlog', p.id);
      b.setAttribute('aria-pressed', logSvc === p.frps_svc);
      b.textContent = p.name || ('peer-' + p.id);
      b.onclick = () => setLogSvc(p.frps_svc);
      seg.appendChild(b);
    });
    const h = $('logPeerHint');
    if (h) h.textContent = (s.peers || []).length ? (s.peers.length + ' peer tunnel(s) — pick one to see its frps log.') : '';
    if (!h.textContent) h.classList.add('hidden'); else h.classList.remove('hidden');
  } catch(e) { reportErr('peers', e); }
}
function checkPassStrength(pw) {
  if (!pw) return { score: 0, text: '', color: 'var(--mu)' };
  let score = 0;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw)) score++;
  if (/[a-z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  if (score <= 2) return { score, text: 'Strength: Weak (needs upper, lower, number, symbol & 12+ chars)', color: 'var(--er)' };
  if (score <= 4) return { score, text: 'Strength: Medium (add missing character types)', color: 'var(--wr)' };
  return { score, text: 'Strength: Strong (NIST 800-63B compliant)', color: 'var(--ok)' };
}
const npEl = $('newPass');
if (npEl) {
  npEl.addEventListener('input', () => {
    const sm = $('passStrengthMeter');
    if (!sm) return;
    const res = checkPassStrength(npEl.value);
    sm.textContent = res.text;
    sm.style.color = res.color;
  });
}
$('savePass').onclick = async () => {
  const cur = ($('curPass') ? $('curPass').value : '').trim();
  const v = ($('newPass') ? $('newPass').value : '').trim();
  if (!cur) { toastWarn('current password required', 'Please enter your current password.'); return; }
  if (!v || v.length < 12) { toastWarn('password too short', 'Minimum 12 characters required (NIST 800-63B).'); return; }
  const st = checkPassStrength(v);
  if (st.score < 5) {
    toastWarn('weak password', 'Must include uppercase, lowercase, numbers, and special symbols.');
    return;
  }
  const b = $('savePass'); b.disabled = true;
  try {
    const res = await api('/api/password', {current_password: cur, new_password: v});
    if ($('curPass')) $('curPass').value = '';
    if ($('newPass')) $('newPass').value = '';
    const sm = $('passStrengthMeter'); if (sm) sm.textContent = '';
    if (res && res.csrf_token) setCSRFToken(res.csrf_token);
    toastOk('password changed');
  }
  catch(e) { toastErr('password change failed', e.message); }
  b.disabled = false;
};
async function loadVersion() {
  try {
    const v = await api('/api/version');
    const cur = $('verCurrent'); if (cur) cur.textContent = v.current || '—';
    const isDev = v.channel === 'dev';
    if ($('updChannel')) $('updChannel').value = isDev ? 'dev' : 'stable';
    $('updDevBadge').classList.toggle('hidden', !isDev);
    $('updChannelWarn').classList.toggle('hidden', !isDev);
    const rows = $('verRowsUpd');
    if (rows) rows.innerHTML = '<div class="ver-row"><span class="k">Latest release</span><span>' + esc(v.latest || 'unknown') + '</span></div>'
      + '<div class="ver-row"><span class="k">Status</span><span>' + (v.update_available ? '<span class="badge info"><span class="dot"></span>update available</span>' : '<span class="badge ok"><span class="dot"></span>up to date</span>') + '</span></div>';
    const badge = $('updBadge'); if (badge) badge.classList.toggle('hidden', !v.update_available);
    if (typeof drawerSync === 'function') drawerSync();
    const dot = $('updDot');
    if (dot) { dot.className = 'status-indicator ' + (v.update_available ? 'offline' : 'active'); $('updDotTxt').textContent = v.update_available ? 'update available' : 'up to date'; }
    const btn = $('updateBtn');
    if (v.update_available) { btn.disabled = false; btn.textContent = 'Update to ' + v.latest; }
    else { btn.disabled = true; btn.textContent = 'Check for updates'; }
    $('updateMsg').textContent = v.update_available ? 'A newer release (' + v.latest + ') is ready. Press Update to install it here.' : 'You are on the latest release.';
  } catch(e) {
    const rows = $('verRowsUpd'); if (rows) rows.innerHTML = '<div class="warnbox">Version check failed: ' + esc(e.message) + '</div>';
    $('updateMsg').textContent = 'Check failed — will retry. (' + e.message + ')';
    // Auto-retry once after 5s so a transient GitHub hiccup doesn't stick.
    setTimeout(async () => { try { await api('/api/status'); loadVersion(); } catch(_){ /* panel still restarting: ignore */ } }, 5000);
  }
}
$('updChannel').onchange = async () => {
  const sel = $('updChannel');
  try { await api('/api/update/channel', {channel: sel.value}); toastOk(tr('upd_channel', 'Update channel'), sel.value); }
  catch(e) { toastErr('channel change failed', e.message); }
  loadVersion();
};
$('updateBtn').onclick = async () => {
  const btn = $('updateBtn');
  // First click = check; second click (when update known) = install.
  if (btn.disabled) return;
  if (/^Check/.test(btn.textContent)) { btn.disabled = true; btn.textContent = 'Checking…'; loadVersion(); setTimeout(() => { if (/^Checking/.test(btn.textContent)) { btn.disabled = false; btn.textContent = 'Check for updates'; } }, 8000); return; }
  if (!await entConfirm('Update panel?', 'Update panel to the latest release? The panel will restart (a few seconds downtime). Tunnel services keep running.', 'Update')) return;
  btn.disabled = true;
  $('updateMsg').textContent = 'Updating… the panel will restart. This page refreshes automatically.';
  try {
    const r = await api('/api/update', {});
    $('updateMsg').textContent = (r.detail || 'updated') + ' — refreshing…';
    toastOk('update started', r.detail || '');
    // Poll health until the new binary is up, then reload (max ~60s).
    let n = 0;
    const iv = setInterval(async () => {
      n++;
      try { const h = await (await fetch(at('/api/health'), {cache: 'no-store'})).json(); if (h && h.status === 'ok') { clearInterval(iv); location.reload(); } }
      catch(_){ /* health endpoint down while restarting: keep polling */ }
      if (n > 30) { clearInterval(iv); $('updateMsg').textContent = 'Update sent — if this page does not refresh, reload it manually in ~20s.'; }
    }, 2000);
  }
  catch(e) { $('updateMsg').textContent = e.message; toastErr('update failed', e.message); btn.disabled = false; }
};
// ---------- interactive terminal (Phase 3: xterm.js + WS + PTY) ----------
const termState = { ready: false, enabled: false, ws: null, term: null, fit: null, search: null, hb: null, fontSize: 14, libs: false, connecting: false };
function termLibURLs() { return [at('/xterm.js'), at('/xterm-fit.js'), at('/xterm-search.js')]; }
function termLoadLibs() {
  if (termState.libs) return Promise.resolve();
  if (window.Terminal && window.FitAddon && window.SearchAddon) { termState.libs = true; return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    const urls = termLibURLs();
    let i = 0;
    const next = () => {
      if (i >= urls.length) { termState.libs = !!(window.Terminal); termState.libs ? resolve() : reject(new Error('terminal libs failed to load')); return; }
      const s = document.createElement('script');
      s.src = urls[i++]; s.async = false;
      s.onload = next; s.onerror = () => reject(new Error('cannot load terminal library'));
      document.head.appendChild(s);
    };
    next();
  });
}
function termSetDot(state, label) {
  const d = $('termDot');
  if (d) { d.className = 'status-indicator ' + (state === 'on' ? 'active' : state === 'warn' ? 'offline' : ''); $('termDotTxt').textContent = label; }
  const live = $('termLiveDot'); if (live) live.classList.toggle('hidden', state !== 'on');
  const btn = $('termConnBtn'); if (btn) btn.textContent = state === 'on' ? 'Disconnect' : 'Connect';
}
function termOverlay(show, title, sub) {
  const ov = $('termOverlay'); if (!ov) return;
  ov.classList.toggle('hidden', !show);
  if (title) $('termOverlayTitle').textContent = title;
  if (sub) $('termOverlaySub').textContent = sub;
}

// ---- optional TOTP 2FA (Settings) ----
const twofa = {enabled: false, step: 'idle'};
function twofaRender() {
  $('twofaState').textContent = twofa.enabled
    ? 'Enabled. Sign-in needs your password and an authenticator code (or a one-time recovery code).'
    : 'Disabled. Enable it to require an authenticator code at sign-in.';
  $('twofaSetupBox').classList.toggle('hidden', twofa.step !== 'setup');
  $('twofaDisableBox').classList.toggle('hidden', twofa.step !== 'disable');
  $('twofaCancel').classList.toggle('hidden', twofa.step === 'idle');
  $('twofaBtn').textContent = twofa.step === 'setup' ? 'Confirm & enable' : twofa.step === 'disable' ? 'Disable 2FA' : (twofa.enabled ? 'Disable 2FA…' : 'Enable 2FA');
}
async function advisorRefresh() {
  try {
    const r = await api('/api/carrier/advice');
    const a = (r.advice || [])[0] || {};
    $('advMsg').textContent = (a.level === 'warn' ? '⚠ ' : a.level === 'ok' ? '✓ ' : 'ℹ ') + (a.message || '') + (a.suggest ? '  → consider: ' + a.suggest : '');
    $('advStats').textContent = (r.stats || []).map(x => x.carrier + ': ' + x.up_pct + '% up (' + x.samples + ' samples)').join(' · ');
    const [p, n] = await Promise.all([api('/api/suggest?kind=port&n=4'), api('/api/suggest?kind=sni&n=3')]);
    $('advSuggest').textContent = 'free ports: ' + ((p.ports || []).join(', ') || 'none') + ' · SNI: ' + ((n.sni || []).join(', ') || 'none');
  } catch(e) {}
}
$('advRefresh').onclick = advisorRefresh;
async function metricsRefresh() {
  try { const r = await api('/api/metrics-token'); $('metricsState').firstChild && ($('metricsState').textContent = r.enabled ? 'Enabled. Scrape GET …/metrics with the bearer token (rotate to get a new one; the old one stops working).' : 'Disabled. Generate a token to enable GET …/metrics for your scraper (Authorization: Bearer <token>). The token is shown once.'); } catch(e) {}
}
$('metricsRotate').onclick = async () => {
  if (!await entConfirm('Rotate metrics token?', 'The previous token stops working immediately. The new one is shown once.', 'Rotate')) return;
  try { const r = await api('/api/metrics-token', {action: 'rotate'}); const p = $('metricsTok'); p.textContent = r.token; p.classList.remove('hidden'); metricsRefresh(); }
  catch(e) { toastErr('metrics token', e.message); }
};
$('metricsOff').onclick = async () => {
  try { await api('/api/metrics-token', {action: 'disable'}); $('metricsTok').classList.add('hidden'); toastOk('metrics endpoint disabled'); metricsRefresh(); }
  catch(e) { toastErr('metrics token', e.message); }
};
async function histRefresh() {
  try {
    const idx = await api('/api/history');
    const sel = $('histLink'), cur = sel.value;
    sel.innerHTML = (idx.links || []).map(n => '<option>' + esc(n) + '</option>').join('');
    if (cur && (idx.links || []).includes(cur)) sel.value = cur;
    await histDraw();
  } catch(e) {}
}
async function histDraw() {
  const name = $('histLink').value, svg = $('histSvg');
  if (!name) { svg.innerHTML = ''; $('histSum').textContent = 'No links yet.'; return; }
  try {
    const r = await api('/api/history?link=' + encodeURIComponent(name) + '&hours=' + $('histHours').value);
    const pts = r.points || [];
    if (pts.length < 2) { svg.innerHTML = ''; $('histSum').textContent = 'Collecting data… (' + pts.length + ' point' + (pts.length === 1 ? '' : 's') + ')'; return; }
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t, span = Math.max(1, t1 - t0);
    const lat = pts.filter(p => p.ms >= 0), maxMs = Math.max(1, ...lat.map(p => p.ms));
    const X = p => ((p.t - t0) / span * 300).toFixed(1), Y = p => (58 - p.ms / maxMs * 54).toFixed(1);
    let path = '', pen = false;
    for (const p of pts) { if (p.ms < 0) { pen = false; continue; } path += (pen ? 'L' : 'M') + X(p) + ',' + Y(p); pen = true; }
    const down = pts.map(p => p.state === 0 ? '<rect x="' + X(p) + '" y="0" width="2" height="60" fill="rgba(239,68,68,.35)"/>' : '').join('');
    svg.innerHTML = down + '<path d="' + path + '" fill="none" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke"/>';
    const avg = lat.length ? (lat.reduce((a, p) => a + p.ms, 0) / lat.length).toFixed(1) : 'n/a';
    const upPct = (pts.filter(p => p.state > 0).length / pts.length * 100).toFixed(1);
    $('histSum').textContent = 'avg latency ' + avg + ' ms · max ' + (lat.length ? maxMs.toFixed(1) : 'n/a') + ' ms · up ' + upPct + '% · ' + pts.length + ' samples (red = down)';
  } catch(e) {}
}
$('histLink').onchange = histDraw; $('histHours').onchange = histDraw;
async function alertsRefresh() {
  try {
    const r = await api('/api/alerts');
    $('alEnabled').checked = !!r.enabled; $('alWebhook').value = r.webhook_url || '';
    $('alTelegram').checked = !!r.telegram; $('alDegraded').checked = !!r.notify_degraded; $('alGap').value = r.min_gap_sec || 120;
    $('alTgNote').textContent = r.telegram_configured ? '' : '(set bot token + chat id in the Watchdog tab first)';
  } catch(e) {}
}
$('alSave').onclick = async () => {
  try {
    await api('/api/alerts', {enabled: $('alEnabled').checked, webhook_url: $('alWebhook').value.trim(), telegram: $('alTelegram').checked,
      notify_degraded: $('alDegraded').checked, min_gap_sec: parseInt($('alGap').value || '120', 10)});
    toastOk('alert settings saved'); alertsRefresh();
  } catch(e) { toastErr('alerts', e.message); }
};
$('alTest').onclick = async () => {
  try { await api('/api/alerts', {action: 'test'}); toastOk('test alert sent'); }
  catch(e) { toastErr('test alert failed', e.message); }
};
async function idleRefresh() { try { const r = await api('/api/session-settings'); $('idleMin').value = r.idle_minutes; } catch(e) {} }
$('idleSave').onclick = async () => {
  try { await api('/api/session-settings', {idle_minutes: parseInt($('idleMin').value || '0', 10)}); toastOk('idle timeout saved'); }
  catch(e) { toastErr('idle timeout', e.message); }
};
async function twofaRefresh() {
  try { const s = await api('/api/2fa'); twofa.enabled = !!s.enabled; if (s.enabled) $('twofaState').dataset.left = s.recovery_left; } catch(e) {}
  twofa.step = 'idle'; twofaRender();
}
$('twofaCancel').onclick = () => { twofa.step = 'idle'; twofaRender(); };
$('twofaBtn').onclick = async () => {
  try {
    if (twofa.step === 'idle' && !twofa.enabled) {
      const r = await api('/api/2fa/setup', {});
      $('twofaSecret').value = r.secret; $('twofaUri').value = r.uri; $('twofaConfirm').value = '';
      twofa.step = 'setup'; $('twofaCodes').classList.add('hidden');
    } else if (twofa.step === 'setup') {
      const r = await api('/api/2fa/enable', {code: $('twofaConfirm').value.trim()});
      twofa.enabled = true; twofa.step = 'idle';
      const c = $('twofaCodes'); c.textContent = 'Recovery codes — save them now, each works once:\n' + r.recovery_codes.join('\n'); c.classList.remove('hidden');
      toastOk('2FA enabled');
    } else if (twofa.step === 'idle' && twofa.enabled) {
      twofa.step = 'disable'; $('twofaPass').value = ''; $('twofaDisCode').value = '';
    } else if (twofa.step === 'disable') {
      await api('/api/2fa/disable', {password: $('twofaPass').value, code: $('twofaDisCode').value.trim()});
      twofa.enabled = false; twofa.step = 'idle'; $('twofaCodes').classList.add('hidden');
      toastOk('2FA disabled');
    }
  } catch(e) { toastErr('2FA', e.message); }
  twofaRender();
};
// terminal re-authentication: password (+2FA code) -> one-time 60 s ticket
function termGetTicket() {
  return new Promise((resolve, reject) => {
    const ov = $('termAuthModal');
    $('termAuthPass').value = ''; $('termAuthCode').value = '';
    api('/api/2fa').then(r => $('termAuthCodeBox').classList.toggle('hidden', !r.enabled)).catch(() => {});
    const release = trapModal(ov, () => cancel());
    ov.hidden = false; $('termAuthPass').focus();
    const close = () => { ov.hidden = true; release(); $('termAuthPass').value = ''; $('termAuthCode').value = ''; };
    const cancel = () => { close(); reject(new Error('cancelled')); };
    const go = async () => {
      try {
        const r = await api('/api/term/ticket', {password: $('termAuthPass').value, code: $('termAuthCode').value.trim()});
        close(); resolve(r.ticket);
      } catch(e) { close(); reject(e); }
    };
    $('termAuthYes').onclick = go; $('termAuthNo').onclick = cancel; $('termAuthX').onclick = cancel;
    $('termAuthPass').onkeydown = e => { if (e.key === 'Enter') go(); };
  });
}
async function termAllowRefresh() {
  try { const r = await api('/api/term/allowlist'); $('termAllow').value = (r.ips || []).join('\n'); $('termAllowMsg').textContent = 'Your current IP: ' + r.your_ip + (r.ips && r.ips.length ? '' : ' · no restriction active'); } catch(e) {}
}
$('termAllowSave').onclick = async () => {
  const ips = $('termAllow').value.split(/[\s,]+/).map(x => x.trim()).filter(Boolean);
  try { await api('/api/term/allowlist', {ips}); toastOk('terminal allowlist saved'); termAllowRefresh(); }
  catch(e) { toastErr('allowlist', e.message); }
};
async function termFlagRefresh() {
  try {
    const s = await api('/api/term/status');
    termState.enabled = !!s.enabled;
    const nav = $('termNav');
    if (nav) nav.classList.toggle('hidden', !s.enabled);
    if (typeof drawerSync === 'function') drawerSync();
    const dot = $('termFlagDot');
    if (dot) { dot.className = 'status-indicator ' + (s.enabled ? 'active' : ''); $('termFlagTxt').textContent = s.enabled ? 'enabled' : 'disabled'; }
    const tb = $('termToggleBtn'); if (tb) tb.textContent = s.enabled ? 'Disable terminal' : 'Enable terminal';
    const fm = $('termFlagMsg');
    if (fm) fm.textContent = s.enabled ? (s.busy ? 'Terminal tab is visible. A shell is currently active.' : 'Terminal tab is visible. No active shell.') : 'Terminal tab is hidden until enabled.';
    if (!s.enabled && !$('tab-terminal').hidden) goTab('dashboard');
  } catch(e) { /* status endpoint failure: leave tab hidden */ }
}
$('termToggleBtn').onclick = async () => {
  const want = !termState.enabled;
  if (want) {
    if (!await entConfirm('Enable interactive terminal?', 'Opens a root shell in the browser tab. Same login session, single shell, 10-minute idle kill, commands audit-logged.', 'Enable')) return;
  } else if (termState.ws) {
    if (!await entConfirm('Disable terminal?', 'The active shell will be killed and the tab hidden. Other tabs keep working.', 'Disable')) return;
    termDisconnect();
  }
  try {
    const r = await api('/api/term/enable', {enabled: want});
    termState.enabled = !!r.enabled;
    toastOk(want ? 'terminal enabled' : 'terminal disabled');
    termFlagRefresh();
  } catch(e) { toastErr('terminal toggle failed', e.message); }
};
function termOnShow() {
  // lazy libs + fit when the tab first opens
  termLoadLibs().then(() => {
    termEnsure();
    setTimeout(() => { try { termState.fit && termState.fit.fit(); termSendResize(); } catch(_){ /* term.fit / ws send / close: harmless if terminal not ready */ } }, 60);
  }).catch(e => termOverlay(true, 'Terminal unavailable', e.message));
}
function termEnsure() {
  if (termState.term) return;
  const t = new window.Terminal({ fontSize: termState.fontSize, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', cursorBlink: true, scrollback: 5000, theme: { background: '#0a0e17', foreground: '#e4e4e7', cursor: '#38bdf8', selectionBackground: 'rgba(56,189,248,.3)' } });
  termState.search = new window.SearchAddon.SearchAddon();
  t.loadAddon(termState.search);
  termState.fit = new window.FitAddon.FitAddon();
  t.loadAddon(termState.fit);
  t.open($('termBox'));
  t.onData(d => termSend({v:1, t:'in', d}));
  t.onResize(sz => termSend({v:1, t:'resize', cols: sz.cols, rows: sz.rows}));
  termState.term = t;
  t.writeln('\x1b[1;36mHashem terminal\x1b[0m — press Connect for a root shell on this server.');
  t.writeln('Type \x1b[1mhashem\x1b[0m + Enter for the full tunnel menu (setup · peers · logs · update · HTTPS).');
  try { termState.fit.fit(); } catch(_){ /* term.fit / ws send / close: harmless if terminal not ready */ }
}
function termSend(m) { try { if (termState.ws && termState.ws.readyState === 1) termState.ws.send(JSON.stringify(m)); } catch(_){ /* term.fit / ws send / close: harmless if terminal not ready */ } }
function termSendResize() {
  const t = termState.term; if (!t) return;
  termSend({v:1, t:'resize', cols: t.cols, rows: t.rows});
}
function termB64(s) {
  // base64 -> binary string -> xterm (ASCII-safe path; UTF-8 passthrough)
  try {
    const bin = atob(s);
    if (termState.term) termState.term.write(bin);
  } catch(e) { if (termState.term) termState.term.write(s); }
}
async function termConnect() {
  if (termState.ws || termState.connecting) return;
  termState.connecting = true;
  try { await termLoadLibs(); } catch(e) { toastErr('terminal libs failed', e.message); termState.connecting = false; return; }
  termEnsure();
  let st = null;
  try { st = await api('/api/term/status'); } catch(e) { toastErr('terminal status failed', e.message); termState.connecting = false; return; }
  if (!st.enabled) { toastWarn('terminal disabled', 'Enable it from Settings first.'); termState.connecting = false; return; }
  let ticket;
  try { ticket = await termGetTicket(); }
  catch(e) { if (e && e.message !== 'cancelled') toastErr('terminal sign-in failed', e.message); termState.connecting = false; return; }
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  let ws;
  try { ws = new WebSocket(proto + location.host + at('/api/term/ws') + '?ticket=' + encodeURIComponent(ticket)); }
  catch(e) { toastErr('websocket failed', e.message); termState.connecting = false; return; }
  termState.ws = ws;
  termSetDot('warn', 'connecting…');
  termOverlay(false);
  ws.onopen = () => { termState.connecting = false; termSetDot('on', 'connected'); $('termMeta').textContent = 'Root shell on this server · single session · 10m idle kill · 30m cap · type hashem for the tunnel menu'; try { termState.fit.fit(); } catch(_){ /* term.fit / ws send / close: harmless if terminal not ready */ } termSendResize(); termState.hb = setInterval(() => termSend({v:1,t:'hb'}), 25000); termState.term && termState.term.focus(); };
  ws.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch(_) { return; /* non-JSON frame: ignore */ }
    if (m.v !== 1) return;
    if (m.t === 'out' && m.d) termB64(m.d);
    else if (m.t === 'exit') { termState.term.writeln('\r\n\x1b[1;33m[shell exited]\x1b[0m'); termDisconnect('Shell exited.'); }
    else if (m.t === 'err') { toastErr(m.code ? '[' + m.code + ']' : 'terminal error', m.msg || ''); if (/E-TERM-0[689]|E-TERM-11/.test(m.code || '')) termDisconnect(m.msg || 'Session ended.'); }
  };
  const gone = () => { if (termState.ws === ws) termDisconnect('Connection lost. Press Connect to reopen.'); };
  ws.onclose = gone; ws.onerror = gone;
}
function termDisconnect(note) {
  const ws = termState.ws; termState.ws = null;
  if (termState.hb) { clearInterval(termState.hb); termState.hb = null; }
  try { ws && ws.close(); } catch(_){ /* already closed */ }
  termSetDot('', 'disconnected');
  termOverlay(true, 'Disconnected', note || 'Press Connect to open a root shell on this server.');
}
$('termConnBtn').onclick = () => { termState.ws ? termDisconnect() : termConnect(); };
$('termOverlayBtn').onclick = () => termConnect();
// hashem quick buttons: type the command into the live shell + Enter.
// 'check'/'logs'/'update' are shortcuts for the matching hashem subcommands.
const termQuickMap = { check: 'hashem status', logs: 'hashem logs', update: 'hashem update' };
function termTypeCmd(cmd) {
  if (!termState.ws || !termState.term) { toastWarn('not connected', 'Press Connect first, then run hashem commands.'); return; }
  termSend({v:1, t:'in', d: cmd + '\r'});
  termState.term.focus();
}
$('termHashemBtn').onclick = () => termTypeCmd('hashem');
document.querySelectorAll('#tab-terminal .term-quick button').forEach(b => b.onclick = () => termTypeCmd(termQuickMap[b.dataset.q] || b.dataset.q));
$('termKillBtn').onclick = async () => {
  if (!termState.ws) { toastWarn('no active session', 'Nothing to kill — connect first.'); return; }
  if (!await entConfirm('Kill terminal session?', 'The root shell ends immediately. Unsaved command-line state is lost.', 'Kill')) return;
  try { await api('/api/term/kill', {}); toastOk('session killed'); } catch(e) { toastErr('kill failed', e.message); }
  termDisconnect();
};
$('termClearBtn').onclick = () => { termState.term && termState.term.clear(); termState.term && termState.term.focus(); };
$('termFullBtn').onclick = () => { const w = $('termWrap'); w.classList.toggle('full'); setTimeout(() => { try { termState.fit.fit(); termSendResize(); } catch(_){ /* term.fit / ws send / close: harmless if terminal not ready */ } }, 60); };
$('termFontUp').onclick = () => { termState.fontSize = Math.min(22, termState.fontSize + 1); if (termState.term) { termState.term.options.fontSize = termState.fontSize; try { termState.fit.fit(); termSendResize(); } catch(_){ /* term.fit / ws send / close: harmless if terminal not ready */ } } };
$('termFontDown').onclick = () => { termState.fontSize = Math.max(10, termState.fontSize - 1); if (termState.term) { termState.term.options.fontSize = termState.fontSize; try { termState.fit.fit(); termSendResize(); } catch(_){ /* term.fit / ws send / close: harmless if terminal not ready */ } } };
$('termCopyBtn').onclick = async () => {
  try {
    const sel = termState.term ? termState.term.getSelection() : '';
    if (!sel) { toastWarn('nothing selected', 'Drag to select text in the terminal first.'); return; }
    await navigator.clipboard.writeText(sel);
    toastOk('copied', sel.length + ' chars');
  } catch(e) { toastErr('copy failed', e.message); }
};
$('termSearchBtn').onclick = () => { $('termSearchBar').classList.toggle('hidden'); $('termSearchInput').focus(); };
$('termSearchClose').onclick = () => { $('termSearchBar').classList.add('hidden'); };
const termDoSearch = next => {
  const q = $('termSearchInput').value; if (!q || !termState.search) return;
  next ? termState.search.findNext(q) : termState.search.findPrevious(q);
};
$('termSearchNext').onclick = () => termDoSearch(true);
$('termSearchPrev').onclick = () => termDoSearch(false);
$('termSearchInput').addEventListener('keydown', e => { if (e.key === 'Enter') termDoSearch(!e.shiftKey); if (e.key === 'Escape') $('termSearchBar').classList.add('hidden'); });
document.querySelectorAll('#termKeys button').forEach(b => b.onclick = () => { termSend({v:1, t:'in', d: b.dataset.k}); termState.term && termState.term.focus(); });
window.addEventListener('resize', () => {
  if (!$('tab-terminal').hidden && termState.fit) { try { termState.fit.fit(); termSendResize(); } catch(_){ /* term.fit / ws send / close: harmless if terminal not ready */ } }
  const c = $('trafficChart'); if (c && c._hist && !$('tab-dashboard').hidden) { drawChart(c._hist, c._isDown); drawActivityChart(c._hist, c._isDown); }
});
// ---------- Performance (tab-perf) ----------
let perfState = { proxy_encryption: false, proxy_compression: false, auto_pool: true };

function perfAgo(ts) {
  if (!ts) return '—';
  const d = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (d < 90) return d + 's ago';
  if (d < 5400) return Math.round(d / 60) + ' min ago';
  if (d < 172800) return Math.round(d / 3600) + ' h ago';
  return new Date(ts * 1000).toLocaleDateString();
}

async function loadPerf() {
  try {
    const s = await api('/api/perf');
    perfState = s;
    const ap = s.auto_pool_state || {};

    // Status hero card
    const ind = $('perfSyncInd');
    if (ind) {
      ind.className = 'status-indicator ' + (s.in_sync ? 'active' : 'offline');
      $('perfSyncTxt').textContent = s.in_sync ? 'In Sync' : 'Needs Apply';
    }
    const cVal = $('perfCryptoVal');
    if (cVal) cVal.textContent = 'Mux: ' + (s.tcp_mux_live ? s.tcp_mux_live : (s.tcp_mux ? 'On' : 'Off'));
    const cSub = $('perfCryptoSub');
    if (cSub) cSub.textContent = `Enc: ${s.proxy_encryption ? 'On' : 'Off'} · Comp: ${s.proxy_compression ? 'On' : 'Off'}`;
    if ($('perfPoolVal')) $('perfPoolVal').textContent = `${s.effective_pool_count} / ${s.effective_max_pool}`;
    if ($('perfPoolSub')) $('perfPoolSub').textContent = s.auto_pool ? tr('perf_mode_auto', 'Auto Pool') : tr('perf_mode_manual', 'Manual');
    if ($('perfDecisionVal')) $('perfDecisionVal').textContent = s.auto_pool ? (ap.last_decision || 'waiting') : 'off';
    if ($('perfDecisionSub')) $('perfDecisionSub').textContent = s.auto_pool ? (ap.last_reason || 'first tick pending (runs every minute)') : tr('perf_mode_manual', 'Manual');

    // Checkboxes
    if ($('perfEncCheck')) $('perfEncCheck').checked = !!s.proxy_encryption;
    if ($('perfCompCheck')) $('perfCompCheck').checked = !!s.proxy_compression;
    if ($('perfMuxCheck')) $('perfMuxCheck').checked = !!s.tcp_mux;
    if ($('perfMuxLive')) {
      const live = s.tcp_mux_live || 'n/a';
      const want = s.tcp_mux_set ? (s.tcp_mux ? 'on' : 'off') : 'not set';
      const warn = (s.tcp_mux_set && s.tcp_mux_live && live !== (s.tcp_mux ? 'on' : 'off')) ? ' — differs, press Apply & restart' : '';
      $('perfMuxLive').textContent = 'Setting: ' + want + ' · Live toml: ' + live + warn + (live === 'on' ? ' · slower path active' : '');
      $('perfMuxLive').style.color = (live === 'on' || warn) ? 'var(--warn, #f0a020)' : '';
    }

    // Role badge
    if ($('perfRoleBadge')) {
      const rName = s.role === 'iran' ? 'Iran (Server)' : (s.role === 'foreign' ? 'Foreign (Client)' : 'No Tunnel');
      $('perfRoleBadge').textContent = rName;
      $('perfRoleBadge').className = 'badge ' + (s.role === 'iran' ? 'ok' : 'info');
    }

    // Auto Pool card
    if ($('perfAutoPool')) $('perfAutoPool').checked = !!s.auto_pool;
    if ($('perfApDecision')) $('perfApDecision').textContent = ap.last_decision || '—';
    if ($('perfApReason')) $('perfApReason').textContent = ap.last_reason || '—';
    if ($('perfApErrors')) $('perfApErrors').textContent = ap.last_tick ? String(ap.errors_last_tick || 0) : '—';
    if ($('perfApConns')) $('perfApConns').textContent = ap.last_tick ? `active conns ≈ ${ap.active_conns || 0}` : '—';
    if ($('perfApRestart')) $('perfApRestart').textContent = perfAgo(ap.last_restart);
    if ($('perfApQuiet')) $('perfApQuiet').textContent = ap.last_tick ? `quiet ticks: ${ap.quiet_ticks || 0}` : '—';
    if ($('perfApFrpsNote')) $('perfApFrpsNote').hidden = !(s.auto_pool && ap.frps_restart_needed);
    if ($('perfPoolCount')) $('perfPoolCount').value = s.auto_pool ? s.effective_pool_count : (s.frp_pool_count || 20);
    if ($('perfMaxPool')) $('perfMaxPool').value = s.auto_pool ? s.effective_max_pool : (s.frp_max_pool || 60);
    updateAutoPoolUI(!!s.auto_pool);
  } catch (e) {
    toastErr('performance error', e.message);
  }
}

function updateAutoPoolUI(isAuto) {
  const badge = $('perfAutoPoolBadge');
  if (badge) {
    badge.className = 'badge ' + (isAuto ? 'ok' : 'info');
    badge.textContent = isAuto ? tr('perf_mode_auto', 'Auto Pool') : tr('perf_mode_manual', 'Manual');
  }
  if ($('perfPoolCount')) $('perfPoolCount').readOnly = isAuto;
  if ($('perfMaxPool')) $('perfMaxPool').readOnly = isAuto;
  if ($('perfSaveTuningBtn')) $('perfSaveTuningBtn').disabled = isAuto;
}

if ($('perfAutoPool')) {
  $('perfAutoPool').onchange = async () => {
    const on = $('perfAutoPool').checked;
    updateAutoPoolUI(on);
    try {
      await api('/api/perf', { action: 'update', auto_pool: on });
      toastOk(tr('perf_ap_saved', 'Auto Pool updated'), on ? tr('perf_ap_on_msg', 'Pool is resized automatically every minute.') : tr('perf_ap_off_msg', 'Manual values apply after Save & Apply.'));
      await loadPerf();
    } catch (e) {
      toastErr('Auto Pool error', e.message);
      await loadPerf();
    }
  };
}

if ($('perfSaveTuningBtn')) {
  $('perfSaveTuningBtn').onclick = async () => {
    const btn = $('perfSaveTuningBtn');
    btn.disabled = true;
    const pool = parseInt($('perfPoolCount') ? $('perfPoolCount').value : 20, 10) || 20;
    const maxPool = parseInt($('perfMaxPool') ? $('perfMaxPool').value : 60, 10) || 60;
    try {
      const res = await api('/api/perf', {
        action: 'set-tuning',
        auto_pool: false,
        frp_pool_count: pool,
        frp_max_pool: maxPool,
      });
      toastOk('Capacity Updated', res.detail || 'FRP scaling settings saved and applied.');
      if ($('perfTuningStatus')) {
        $('perfTuningStatus').textContent = '✓ Saved & Applied';
        setTimeout(() => { if ($('perfTuningStatus')) $('perfTuningStatus').textContent = ''; }, 3000);
      }
      await loadPerf();
    } catch (e) {
      toastErr('Tuning error', e.message);
    } finally {
      btn.disabled = false;
    }
  };
}

async function doPerfApply(btnEl) {
  const orig = btnEl ? btnEl.textContent : '';
  if (btnEl) { btnEl.disabled = true; btnEl.textContent = 'Applying…'; }
  const msgEl = $('perfApplyMsg');
  if (msgEl) msgEl.textContent = 'Regenerating configs and restarting services…';
  try {
    const enc = $('perfEncCheck') ? $('perfEncCheck').checked : perfState.proxy_encryption;
    const comp = $('perfCompCheck') ? $('perfCompCheck').checked : perfState.proxy_compression;
    const mux = $('perfMuxCheck') ? $('perfMuxCheck').checked : !!perfState.tcp_mux;
    const res = await api('/api/perf', {
      action: 'apply',
      proxy_encryption: enc,
      proxy_compression: comp,
      tcp_mux: mux
    });
    toastOk('Settings applied', res.detail || 'Live tunnels updated and restarted.');
    if (msgEl) msgEl.textContent = 'Applied successfully.';
    await loadPerf();
  } catch (e) {
    toastErr('apply failed', e.message);
    if (msgEl) msgEl.textContent = 'Error: ' + e.message;
  } finally {
    if (btnEl) { btnEl.disabled = false; btnEl.textContent = orig; }
  }
}

async function doPerfSaveOnly() {
  const enc = $('perfEncCheck') ? $('perfEncCheck').checked : perfState.proxy_encryption;
  const comp = $('perfCompCheck') ? $('perfCompCheck').checked : perfState.proxy_compression;
  const mux = $('perfMuxCheck') ? $('perfMuxCheck').checked : !!perfState.tcp_mux;
  try {
    await api('/api/perf', {
      action: 'update',
      proxy_encryption: enc,
      proxy_compression: comp,
      tcp_mux: mux
    });
    toastOk('Settings saved', 'Remember to Apply & restart tunnels to make them active.');
    await loadPerf();
  } catch (e) {
    toastErr('save failed', e.message);
  }
}

const perfApplyBtn = $('perfApplyBtn');
if (perfApplyBtn) perfApplyBtn.onclick = () => doPerfApply(perfApplyBtn);
const perfApplyTopBtn = $('perfApplyTopBtn');
if (perfApplyTopBtn) perfApplyTopBtn.onclick = () => doPerfApply(perfApplyTopBtn);
const perfSaveOnlyBtn = $('perfSaveOnlyBtn');
if (perfSaveOnlyBtn) perfSaveOnlyBtn.onclick = () => doPerfSaveOnly();

const perfResetBtn = $('perfResetBtn');
if (perfResetBtn) {
  perfResetBtn.onclick = async () => {
    const ok = await entConfirm('Reset Performance Settings', 'This will turn Auto Pool on, disable extra proxy encryption/compression and TCP multiplexing, and restart tunnels in clean wire-speed mode. Continue?', 'Reset to Safe Defaults');
    if (!ok) return;
    perfResetBtn.disabled = true;
    try {
      const res = await api('/api/perf', { action: 'reset' });
      toastOk('Settings Reset', res.detail || 'Restored clean wire-speed settings.');
      await loadPerf();
    } catch (e) {
      toastErr('Reset failed', e.message);
    } finally {
      perfResetBtn.disabled = false;
    }
  };
}

// ---------- Multi-Carrier & UDP Encapsulation (FOU) ----------
let carrierState = { mode: 'direct', active: 'direct', fou_ports: [], direct_gre: true, watchdog_auto: false };

async function loadCarrier() {
  try {
    const s = await api('/api/carrier');
    carrierState = s;

    const curActive = s.active || s.active_carrier || 'direct';
    const curPorts = s.fou_ports || [s.fou_port1 || 443, s.fou_port2 || 55555];

    const badge = $('carrierActiveBadge');
    if (badge) {
      if (curActive.startsWith('wss')) {
        badge.textContent = '🛡️ ' + curActive.toUpperCase() + ' (TLS)';
        badge.className = 'badge ok';
      } else if (curActive.startsWith('fou:')) {
        badge.textContent = '⚡ ' + curActive.toUpperCase();
        badge.className = 'badge ok';
      } else {
        badge.textContent = '🟢 Direct GRE';
        badge.className = 'badge info';
      }
    }

    if ($('carrierActiveVal')) {
      $('carrierActiveVal').textContent = curActive.toUpperCase();
    }
    if ($('carrierModeVal')) {
      $('carrierModeVal').textContent = 'MANUAL';
    }
    if ($('carrierModeSub')) {
      $('carrierModeSub').textContent = 'Auto Failover OFF';
    }
    if ($('carrierPortsVal')) {
      $('carrierPortsVal').textContent = (curPorts && curPorts.length > 0) ? curPorts.join(', ') : 'None';
    }

    const cms = $('carrierModeSelect');
    if (cms && document.activeElement !== cms) {
      const wp = s.wss_port || 8443;
      const opts = [
        { v: 'direct', t: '🟢 Direct GRE (Protocol 47)' },
        { v: `wss:${wp}`, t: `🛡️ Obfuscated WSS (TLS ${wp})` }
      ];
      cms.innerHTML = opts.map(o => `<option value="${o.v}" ${o.v === curActive ? 'selected' : ''}>${o.t}</option>`).join('');
    }

    if ($('carrierWSSPortInput') && s.wss_port && document.activeElement !== $('carrierWSSPortInput')) {
      $('carrierWSSPortInput').value = s.wss_port;
    }
    if ($('carrierWSSTxt') && s.wss) {
      $('carrierWSSTxt').textContent = s.wss.running
        ? (s.wss.connected ? `🟢 Connected (${s.wss.packets_sent || 0} pkts sent / ${s.wss.packets_recv || 0} recv)` : '🟡 Active / Listening')
        : '⚪ Idle';
    }

    const ind = $('carrierStatusInd');
    if (ind) {
      ind.className = 'status-indicator active';
      $('carrierStatusTxt').textContent = s.status_text || (s.ping_status === 'ok' ? ('Ping ' + (s.ping_rtt || 'OK')) : 'Active');
    }

    const tunCarrier = $('tunnelCarrierTxt');
    if (tunCarrier) tunCarrier.textContent = curActive.toUpperCase();
  } catch (e) {
    reportErr('carrier', e);
    const ind = $('carrierStatusInd');
    if (ind) {
      ind.className = 'status-indicator offline';
      $('carrierStatusTxt').textContent = 'Error';
    }
  }
}

const carrierCycleBtn = $('carrierCycleBtn');
if (carrierCycleBtn) {
  carrierCycleBtn.onclick = async () => {
    carrierCycleBtn.disabled = true;
    try {
      const res = await api('/api/carrier', { action: 'cycle' });
      toastOk('Carrier Switched', 'Active: ' + (res.active || res.active_carrier || 'updated'));
      await loadCarrier();
    } catch (e) {
      toastErr('Switch failed', e.message);
    } finally {
      carrierCycleBtn.disabled = false;
    }
  };
}

const tunnelCarrierCycleBtn = $('tunnelCarrierCycleBtn');
if (tunnelCarrierCycleBtn) {
  tunnelCarrierCycleBtn.onclick = async () => {
    tunnelCarrierCycleBtn.disabled = true;
    try {
      const res = await api('/api/carrier', { action: 'cycle' });
      toastOk('Carrier Switched', 'Active: ' + (res.active || res.active_carrier || 'updated'));
      await loadCarrier();
    } catch (e) {
      toastErr('Switch failed', e.message);
    } finally {
      tunnelCarrierCycleBtn.disabled = false;
    }
  };
}

const carrierApplyBtn = $('carrierApplyBtn');
if (carrierApplyBtn) {
  carrierApplyBtn.onclick = async () => {
    carrierApplyBtn.disabled = true;
    try {
      const res = await api('/api/carrier', { action: 'apply' });
      toastOk('Carrier Applied', res.detail || 'Encapsulation refreshed');
      await loadCarrier();
    } catch (e) {
      toastErr('Apply failed', e.message);
    } finally {
      carrierApplyBtn.disabled = false;
    }
  };
}

const carrierSaveModeBtn = $('carrierSaveModeBtn');
if (carrierSaveModeBtn) {
  carrierSaveModeBtn.onclick = async () => {
    const m = $('carrierModeSelect') ? $('carrierModeSelect').value : 'direct';
    carrierSaveModeBtn.disabled = true;
    try {
      const res = await api('/api/carrier', { action: 'set-active', target: m });
      toastOk('Carrier Switched', 'Active: ' + (res.active || res.active_carrier || m));
      await loadCarrier();
    } catch (e) {
      toastErr('Save mode failed', e.message);
    } finally {
      carrierSaveModeBtn.disabled = false;
    }
  };
}

const liveSwitchEngineBtn = $('liveSwitchEngineBtn');
if (liveSwitchEngineBtn) {
  liveSwitchEngineBtn.onclick = async () => {
    const eng = $('liveEngineSelect') ? $('liveEngineSelect').value : 'frp';
    const trans = $('liveTransportSelect') ? $('liveTransportSelect').value : 'tcpmux';
    const stTxt = $('liveEngineStatusTxt');
    liveSwitchEngineBtn.disabled = true;
    const oldTxt = liveSwitchEngineBtn.textContent;
    liveSwitchEngineBtn.innerHTML = '<span class="ent-spinner"></span> Switching Engine…';
    if (stTxt) stTxt.textContent = 'Stopping previous services & applying new engine...';
    try {
      const res = await api('/api/action', {
        action: 'switch-engine',
        target_engine: eng,
        target_transport: trans
      });
      toastOk('Engine Switched', `Active: ${eng.toUpperCase()} (${trans})`);
      if (stTxt) stTxt.textContent = '✔️ Successfully switched to ' + eng.toUpperCase();
      setTimeout(() => { refresh(); if (stTxt) stTxt.textContent = ''; }, 2500);
    } catch(e) {
      toastErr('Engine Switch Failed', e.message);
      if (stTxt) stTxt.textContent = '⚠️ ' + e.message;
    } finally {
      liveSwitchEngineBtn.disabled = false;
      liveSwitchEngineBtn.textContent = oldTxt;
    }
  };
}

const carrierSaveWSSBtn = $('carrierSaveWSSBtn');
if (carrierSaveWSSBtn) {
  carrierSaveWSSBtn.onclick = async () => {
    const p = parseInt($('carrierWSSPortInput') ? $('carrierWSSPortInput').value : '8443', 10);
    const sni = $('carrierWSSSNIInput') ? $('carrierWSSSNIInput').value.trim() : '';
    carrierSaveWSSBtn.disabled = true;
    try {
      await api('/api/carrier', { action: 'set_wss', wss_port: p, wss_sni: sni });
      toastOk('WSS Settings Saved', `Port: ${p}${sni ? ' · SNI: ' + sni : ''}`);
      await loadCarrier();
    } catch (e) {
      toastErr('Save WSS failed', e.message);
    } finally {
      carrierSaveWSSBtn.disabled = false;
    }
  };
}

// ---------- Watchdog & Backup (tab-watchdog) ----------
let wdState = { enabled: false, tg_bot_token_masked: '', ports: [] };

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

async function loadWatchdog() {
  try {
    const s = await api('/api/watchdog');
    wdState = s;

    // Status hero card
    const ind = $('wdStatusInd');
    if (ind) {
      ind.className = 'status-indicator ' + (s.enabled ? 'active' : 'offline');
      $('wdStatusTxt').textContent = s.enabled ? 'Active' : 'Disabled';
    }
    const tog = $('wdToggleBtn');
    if (tog) {
      tog.textContent = s.enabled ? 'Disable' : 'Enable';
      tog.className = 'hashem-btn ' + (s.enabled ? 'hashem-btn-ghost' : 'hashem-btn-primary');
    }
    const hVal = $('wdHealthVal');
    if (hVal) {
      if (!s.enabled) {
        hVal.innerHTML = '<span style="color:var(--dim)">○ Disabled</span>';
      } else if (s.status === 'up') {
        hVal.innerHTML = '<span style="color:var(--ok)">● Online</span>';
      } else {
        hVal.innerHTML = '<span style="color:var(--er)">● Offline</span>';
      }
    }
    const hDet = $('wdHealthDetail');
    if (hDet) hDet.textContent = s.check_result || s.status;
    const fVal = $('wdFailsVal');
    if (fVal) fVal.textContent = (s.consec_fails || 0) + ' / ' + (s.fail_threshold || 2);
    const lVal = $('wdLastCheckVal');
    if (lVal) lVal.textContent = s.last_check || 'Never';

    if ($('wdAutoRestart')) {
      $('wdAutoRestart').checked = !!s.auto_restart;
      $('wdAutoRestart').onchange = async () => {
        try {
          await api('/api/watchdog', { action: 'set-autorestart', auto_restart: $('wdAutoRestart').checked });
          toastOk('Watchdog auto-restart ' + ($('wdAutoRestart').checked ? 'enabled' : 'disabled'));
        } catch(e) {
          toastErr('Failed to update auto-restart', e.message);
        }
      };
    }

    // Telegram card
    if ($('wdBotToken')) $('wdBotToken').value = s.tg_bot_token_masked || '';
    if ($('wdChatId')) $('wdChatId').value = s.tg_chat_id || '';
    if (s.tg_route === 'tunnel') {
      $('wdRouteTunnel').checked = true;
      $('wdTunnelPortGroup').classList.remove('hidden');
      $('wdTgRouteBadge').textContent = 'Tunnel (SOCKS5)';
      $('wdTgRouteBadge').className = 'badge info';
    } else {
      $('wdRouteDirect').checked = true;
      $('wdTunnelPortGroup').classList.add('hidden');
      $('wdTgRouteBadge').textContent = 'Direct';
      $('wdTgRouteBadge').className = 'badge';
    }

    // Tunnel ports dropdown
    const sel = $('wdTunnelPortSelect');
    if (sel) {
      sel.innerHTML = '';
      const ports = s.tunnel_ports || [];
      if (ports.length === 0 && s.tg_tunnel_port) ports.push(s.tg_tunnel_port);
      ports.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p;
        opt.textContent = 'Port ' + p;
        if (p === s.tg_tunnel_port) opt.selected = true;
        sel.appendChild(opt);
      });
      const optManual = document.createElement('option');
      optManual.value = 'custom';
      optManual.textContent = 'Custom port…';
      sel.appendChild(optManual);
      if (s.tg_tunnel_port && !ports.includes(s.tg_tunnel_port)) {
        optManual.selected = true;
        $('wdTunnelPortManual').value = s.tg_tunnel_port;
        $('wdTunnelPortManual').classList.remove('hidden');
      }
    }

    // Tunnel Auto-Restart Scheduler card
    const rBadge = $('wdRestartBadge');
    const rSel = $('wdRestartHoursSelect');
    const rCustom = $('wdRestartCustomHours');
    const rSub = $('wdRestartStatusSub');
    const rHours = s.restart_every_hours || 0;
    if (rBadge) {
      if (rHours > 0) {
        rBadge.textContent = 'Every ' + rHours + 'h';
        rBadge.className = 'badge ok';
      } else {
        rBadge.textContent = 'Disabled';
        rBadge.className = 'badge';
      }
    }
    if (rSel) {
      const known = [0, 1, 3, 6, 12, 24];
      if (known.includes(rHours)) {
        rSel.value = String(rHours);
        if (rCustom) rCustom.classList.add('hidden');
      } else {
        rSel.value = 'custom';
        if (rCustom) {
          rCustom.value = rHours;
          rCustom.classList.remove('hidden');
        }
      }
    }
    if (rSub) {
      rSub.textContent = 'Next restart: ' + (s.next_restart_human || 'Not scheduled') + (s.last_restart_date ? ' · Last run: ' + s.last_restart_date : '');
    }

    // Backup schedule
    $('wdSchedBadge').textContent = s.schedule_human || 'Off';
    $('wdSchedBadge').className = 'badge ' + (s.schedule_mode !== 'off' ? 'info' : '');
    if (s.schedule_mode === 'interval') {
      $('wdSchedInterval').checked = true;
      $('wdSchedHoursGroup').classList.remove('hidden');
      $('wdSchedDailyGroup').classList.add('hidden');
      $('wdSchedHours').value = s.backup_every_hours || 6;
    } else if (s.schedule_mode === 'daily') {
      $('wdSchedDaily').checked = true;
      $('wdSchedHoursGroup').classList.add('hidden');
      $('wdSchedDailyGroup').classList.remove('hidden');
      $('wdSchedDailyAt').value = s.backup_daily_at || '03:00';
    } else {
      $('wdSchedOff').checked = true;
      $('wdSchedHoursGroup').classList.add('hidden');
      $('wdSchedDailyGroup').classList.add('hidden');
    }

    // Backup list
    const bList = $('wdBackupList');
    if (bList) {
      if (!s.backups || s.backups.length === 0) {
        bList.innerHTML = '<div class="qs-hint">No backups stored on disk yet.</div>';
      } else {
        bList.innerHTML = '';
        s.backups.forEach(b => {
          const item = document.createElement('div');
          item.className = 'wd-backup-item';
          item.innerHTML = `
            <div class="wd-backup-meta">
              <span class="wd-backup-name">${esc(b.name)}</span>
              <span class="wd-backup-info">${formatBytes(b.size)} · ${esc(b.time)}</span>
            </div>
            <div class="wd-backup-acts">
              <button class="hashem-btn hashem-btn-secondary u-btn-xs" data-dl="${esc(b.name)}">Download</button>
              <button class="hashem-btn hashem-btn-danger u-btn-xs" data-rst="${esc(b.name)}">Restore</button>
            </div>
          `;
          bList.appendChild(item);
        });
        bList.querySelectorAll('[data-dl]').forEach(btn => {
          btn.onclick = () => {
            window.location.href = at('/api/watchdog/backup-download?f=' + encodeURIComponent(btn.dataset.dl));
          };
        });
        bList.querySelectorAll('[data-rst]').forEach(btn => {
          btn.onclick = () => restoreBackupFile(btn.dataset.rst);
        });
      }
    }

    // Event mini-log
    const eList = $('wdEventLog');
    if (eList) {
      if (!s.recent_events || s.recent_events.length === 0) {
        eList.innerHTML = '<div class="qs-hint">No watchdog events recorded yet.</div>';
      } else {
        eList.innerHTML = '';
        s.recent_events.forEach(ev => {
          const item = document.createElement('div');
          item.className = 'wd-event-item';
          item.innerHTML = `
            <span class="wd-event-time">${esc(ev.time)}</span>
            <span class="wd-event-detail">${esc(ev.detail || ev.code)}</span>
          `;
          eList.appendChild(item);
        });
      }
    }
  } catch(e) {
    toastErr('watchdog error', e.message);
  }
}

// Watchdog UI listeners
$('wdToggleBtn').onclick = async () => {
  const act = wdState.enabled ? 'off' : 'on';
  try {
    await api('/api/watchdog', { action: act });
    toastOk(act === 'on' ? 'Watchdog enabled' : 'Watchdog disabled');
    loadWatchdog();
  } catch(e) {
    toastErr('toggle failed', e.message);
  }
};

$('wdShowTokenBtn').onclick = () => {
  const inp = $('wdBotToken');
  inp.type = inp.type === 'password' ? 'text' : 'password';
};

$('wdRouteDirect').onchange = () => {
  $('wdTunnelPortGroup').classList.add('hidden');
};
$('wdRouteTunnel').onchange = () => {
  $('wdTunnelPortGroup').classList.remove('hidden');
};

$('wdTunnelPortSelect').onchange = () => {
  if ($('wdTunnelPortSelect').value === 'custom') {
    $('wdTunnelPortManual').classList.remove('hidden');
    $('wdTunnelPortManual').focus();
  } else {
    $('wdTunnelPortManual').classList.add('hidden');
  }
};

$('wdSaveTgBtn').onclick = async () => {
  const botToken = $('wdBotToken').value.trim();
  const chatId = $('wdChatId').value.trim();
  const route = $('wdRouteTunnel').checked ? 'tunnel' : 'direct';
  let port = 0;
  if (route === 'tunnel') {
    const selVal = $('wdTunnelPortSelect').value;
    port = selVal === 'custom' ? parseInt($('wdTunnelPortManual').value) : parseInt(selVal);
    if (!port || port < 1 || port > 65535) {
      toastWarn('invalid port', 'Please select or enter a valid tunnel port (1-65535).');
      return;
    }
  }
  try {
    await api('/api/watchdog', {
      action: 'set-telegram',
      bot_token: botToken,
      chat_id: chatId,
      route: route,
      tunnel_port: port,
    });
    toastOk('Telegram settings saved');
    $('wdTgMsg').textContent = 'Saved at ' + new Date().toLocaleTimeString();
    loadWatchdog();
  } catch(e) {
    toastErr('save failed', e.message);
  }
};

$('wdTestTgBtn').onclick = async () => {
  const btn = $('wdTestTgBtn');
  btn.disabled = true;
  btn.textContent = 'Testing…';
  $('wdTgMsg').textContent = 'Sending test alert via ' + ($('wdRouteTunnel').checked ? 'tunnel' : 'direct') + '…';
  try {
    const res = await api('/api/watchdog', { action: 'test' });
    toastOk('Telegram test OK', res.detail);
    $('wdTgMsg').textContent = '✅ ' + (res.detail || 'Test alert delivered');
  } catch(e) {
    toastErr('Telegram test failed', e.message);
    $('wdTgMsg').textContent = '❌ ' + e.message;
  }
  btn.disabled = false;
  btn.textContent = 'Test Alert';
};

$('wdSchedOff').onchange = () => {
  $('wdSchedHoursGroup').classList.add('hidden');
  $('wdSchedDailyGroup').classList.add('hidden');
};
$('wdSchedInterval').onchange = () => {
  $('wdSchedHoursGroup').classList.remove('hidden');
  $('wdSchedDailyGroup').classList.add('hidden');
};
$('wdSchedDaily').onchange = () => {
  $('wdSchedHoursGroup').classList.add('hidden');
  $('wdSchedDailyGroup').classList.remove('hidden');
};

$('wdSaveSchedBtn').onclick = async () => {
  let mode = 'off';
  let hours = 0;
  let atTime = '';
  if ($('wdSchedInterval').checked) {
    mode = 'interval';
    hours = parseInt($('wdSchedHours').value) || 6;
  } else if ($('wdSchedDaily').checked) {
    mode = 'daily';
    atTime = $('wdSchedDailyAt').value || '03:00';
  }
  try {
    await api('/api/watchdog', { action: 'set-schedule', mode: mode, hours: hours, at: atTime });
    toastOk('Schedule saved');
    loadWatchdog();
  } catch(e) {
    toastErr('save schedule failed', e.message);
  }
};

// Tunnel Auto-Restart Scheduler listeners
if ($('wdRestartHoursSelect')) {
  $('wdRestartHoursSelect').onchange = () => {
    if ($('wdRestartHoursSelect').value === 'custom') {
      $('wdRestartCustomHours').classList.remove('hidden');
      $('wdRestartCustomHours').focus();
    } else {
      $('wdRestartCustomHours').classList.add('hidden');
    }
  };
}

if ($('wdSaveRestartSchedBtn')) {
  $('wdSaveRestartSchedBtn').onclick = async () => {
    const selVal = $('wdRestartHoursSelect').value;
    let hours = 0;
    if (selVal === 'custom') {
      hours = parseInt($('wdRestartCustomHours').value) || 0;
      if (hours < 1) {
        toastWarn('Invalid hours', 'Please specify a positive integer for custom hours.');
        return;
      }
    } else {
      hours = parseInt(selVal) || 0;
    }
    setBtnLoading($('wdSaveRestartSchedBtn'), true, 'Saving…');
    try {
      const res = await api('/api/watchdog', { action: 'set-restart-schedule', restart_hours: hours });
      toastOk(res.detail || 'Schedule saved');
      loadWatchdog();
    } catch(e) {
      toastErr('Failed to save schedule', e.message);
    } finally {
      setBtnLoading($('wdSaveRestartSchedBtn'), false);
    }
  };
}

if ($('wdRestartTunnelNowBtn')) {
  $('wdRestartTunnelNowBtn').onclick = async () => {
    const ok = await entConfirm({
      title: 'Restart Tunnel Services?',
      body: 'This will perform a graceful soft-restart of GRE interface and FRP/Backhaul relay services. The web panel will stay online.',
      yesText: 'Restart Tunnel',
      noText: 'Cancel'
    });
    if (!ok) return;
    setBtnLoading($('wdRestartTunnelNowBtn'), true, 'Restarting…');
    try {
      const res = await api('/api/watchdog', { action: 'restart-tunnel-now' });
      toastOk('Tunnel Restarted', res.detail || 'Services refreshed successfully');
      loadWatchdog();
    } catch(e) {
      toastErr('Restart failed', e.message);
    } finally {
      setBtnLoading($('wdRestartTunnelNowBtn'), false);
    }
  };
}

$('wdBackupNowBtn').onclick = async () => {
  const btn = $('wdBackupNowBtn');
  btn.disabled = true;
  btn.textContent = 'Backing up…';
  $('wdBackupNowMsg').textContent = 'Encrypting configuration files…';
  try {
    const res = await api('/api/watchdog', { action: 'backup-now' });
    toastOk('Backup created');
    $('wdBackupNowMsg').textContent = 'Done at ' + new Date().toLocaleTimeString();
    loadWatchdog();
  } catch(e) {
    toastErr('backup failed', e.message);
    $('wdBackupNowMsg').textContent = 'Failed: ' + e.message;
  }
  btn.disabled = false;
  btn.textContent = 'Create Backup Now';
};

async function restoreBackupFile(filename) {
  if (!await entConfirm('Restore Backup ' + filename + '?', 'This will decrypt the backup using your panel password, overwrite existing FRP configs and systemd units, and restart services.', 'Restore')) return;
  try {
    const res = await api('/api/watchdog', { action: 'restore', file: filename });
    toastOk('Backup restored', 'Tunnel services restarted.');
    loadWatchdog();
  } catch(e) {
    toastErr('restore failed', e.message);
  }
}

// ---------- panel TLS (Settings: Let's Encrypt via certbot) ----------
async function tlsRefresh() {
  try {
    const s = await api('/api/tls');
    const dot = $('tlsDot');
    if (dot) {
      dot.className = 'status-indicator ' + (s.enabled ? 'active' : (s.days_left != null && s.days_left < 15 ? 'offline' : ''));
      $('tlsDotTxt').textContent = s.enabled ? (s.days_left != null ? s.days_left + ' days left' : 'enabled') : 'no certificate';
    }
    const info = $('tlsInfo');
    if (info) {
      if (s.enabled) {
        let txt = 'Domain <b>' + esc(s.domain || '') + '</b> · expires <b>' + esc(s.expiry || '') + '</b>' + (s.days_left != null ? ' (' + esc(String(s.days_left)) + ' days)' : '') + '<br>HTTPS: <b>' + esc(s.https_url || '') + '</b><br>HTTP IP access: ' + esc(s.http_url || '');
        if (s.port_conflict) {
          txt += '<br><span style="color:var(--err);">⚠️ Port conflict: ' + esc(s.port_conflict_detail || '') + '</span>';
        }
        info.innerHTML = txt;
      } else {
        info.innerHTML = 'No certificate installed yet. Enter the domain above — it must resolve to this server and port 80 must be reachable (or use Reverse Proxy mode below).';
      }
    }
    const msg = $('tlsMsg');
    if (msg) msg.textContent = s.enabled ? ('HTTPS serves on port ' + (s.https_port || 7443) + ' alongside HTTP on ' + (s.http_port || 7777) + '.') : 'HTTPS appears on port 7443 after the first certificate.';
    const remBtn = $('tlsRemoveBtn');
    if (remBtn) remBtn.style.display = s.enabled ? 'inline-block' : 'none';
    if (s.enabled && s.expiring_soon) toastWarn('certificate expiring soon', (s.expiry || '') + ' — Renew now or wait for certbot auto-renew.');
    if (s.domain && !$('tlsDomain').value) $('tlsDomain').value = s.domain;
  } catch(e) { /* leave placeholder text */ }
}

$('tlsIssueBtn').onclick = async () => {
  const domain = $('tlsDomain').value.trim();
  if (!domain) { toastWarn('domain required', 'Enter the panel domain first (e.g. panel.example.com).'); return; }

  const b = $('tlsIssueBtn');
  b.disabled = true; b.textContent = 'Checking…';
  try {
    const chk = await api('/api/tls/check', { domain });
    if (chk.port_conflict) {
      toastErr('Port Conflict', chk.port_conflict_error || 'Port conflict with active tunnel detected.');
      b.disabled = false; b.textContent = 'Get certificate';
      return;
    }
    if (chk.dns_ok === false) {
      toastErr('DNS Mismatch', chk.dns_error || 'Domain DNS does not point to this server.');
      b.disabled = false; b.textContent = 'Get certificate';
      return;
    }
  } catch(e) { /* proceed if check endpoint unreachable */ }
  b.disabled = false; b.textContent = 'Get certificate';

  if (!await entConfirm('Get HTTPS certificate?', 'Certbot will issue a Let\'s Encrypt certificate for ' + domain + '. HTTP and active tunnels continue running without interruption.', 'Get certificate')) return;
  b.disabled = true; b.textContent = 'Issuing… (up to 60s)';
  try {
    const r = await api('/api/tls', {domain, email: $('tlsEmail').value.trim()});
    toastOk('certificate installed', 'HTTPS: ' + (r.https_url || ''));
    tlsRefresh();
  } catch(e) { toastErr('certificate failed', e.message); }
  b.disabled = false; b.textContent = 'Get certificate';
};

$('tlsRenewBtn').onclick = async () => {
  const b = $('tlsRenewBtn'); b.disabled = true; b.textContent = 'Renewing…';
  try {
    const r = await api('/api/tls/renew', {});
    toastOk('certificate renewed', 'Expires: ' + (r.expiry || ''));
    tlsRefresh();
  } catch(e) { toastErr('renew failed', e.message); }
  b.disabled = false; b.textContent = 'Renew now';
};

$('tlsRemoveBtn').onclick = async () => {
  if (!await entConfirm('Remove domain?', 'This will disable HTTPS and return the panel to HTTP (IP:port) access. Active tunnels will NOT be affected.', 'Remove domain')) return;
  const b = $('tlsRemoveBtn'); b.disabled = true; b.textContent = 'Removing…';
  try {
    const r = await api('/api/tls', { action: 'remove' });
    toastOk('Domain removed', r.message || 'Reverted to HTTP IP access.');
    $('tlsDomain').value = '';
    tlsRefresh();
  } catch(e) { toastErr('remove failed', e.message); }
  b.disabled = false; b.textContent = 'Remove domain';
};

$('tlsProxyConfBtn').onclick = async () => {
  const domain = $('tlsDomain').value.trim() || 'panel.example.com';
  try {
    const p = await api('/api/tls/proxy-config?domain=' + encodeURIComponent(domain));
    const box = $('tlsProxyBox');
    if (box) {
      $('tlsNginxCode').textContent = p.nginx || '';
      $('tlsCaddyCode').textContent = p.caddy || '';
      box.style.display = 'block';
    }
  } catch(e) { toastErr('Proxy Config Failed', e.message); }
};

$('tlsProxyCloseBtn').onclick = () => {
  const box = $('tlsProxyBox');
  if (box) box.style.display = 'none';
};

// ---------- Diagnostics & Doctor (tab-doctor) ----------
let doctorData = null;
let doctorRunning = false;

async function loadDoctor(forceRun = false) {
  try {
    let rep;
    if (forceRun) {
      rep = await api('/api/doctor', { action: 'run' });
    } else {
      rep = await api('/api/doctor');
    }
    renderDoctor(rep);
  } catch(e) {
    toastErr('Diagnostics failed', e.message);
  }
}

function renderDoctor(rep) {
  if (!rep) return;
  doctorData = rep;

  // Score & Rating
  const scoreVal = $('docScoreVal');
  const scoreCircle = $('docScoreCircle');
  if (scoreVal) scoreVal.textContent = rep.score != null ? rep.score : '—';
  if (scoreCircle) {
    scoreCircle.className = 'doc-score-circle ' + (rep.rating || '');
  }

  const ratingBadge = $('docRatingBadge');
  if (ratingBadge) {
    ratingBadge.textContent = (rep.rating || 'UNKNOWN').toUpperCase();
    let bClass = 'dim';
    if (rep.rating === 'excellent') bClass = 'ok';
    else if (rep.rating === 'good') bClass = 'info';
    else if (rep.rating === 'warning') bClass = 'warn';
    else if (rep.rating === 'critical') bClass = 'err';
    ratingBadge.className = 'badge ' + bClass;
  }

  // Meta subtitle
  const metaSub = $('docMetaSub');
  if (metaSub) {
    const roleTxt = rep.role ? rep.role.toUpperCase() : 'NO TUNNEL';
    metaSub.textContent = `Peer GRE: ${rep.peer_gre_ip || 'None'} · Role: ${roleTxt} · Checked: ${rep.timestamp || 'Never'}`;
  }

  // Fix button visibility: always keep visible in hero actions
  const fixBtn = $('docFixBtn');
  if (fixBtn) {
    fixBtn.classList.remove('hidden');
    if (rep.issues && rep.issues.length > 0) {
      fixBtn.style.boxShadow = '0 0 12px rgba(16,185,129,0.3)';
      fixBtn.style.borderColor = 'rgba(52,211,153,0.6)';
    } else {
      fixBtn.style.boxShadow = 'none';
      fixBtn.style.borderColor = 'rgba(16,185,129,0.35)';
    }
  }

  // Ping Card
  const ping = rep.ping_result || {};
  if ($('docAvgRttVal')) $('docAvgRttVal').textContent = ping.success ? (ping.avg_rtt.toFixed(1) + ' ms') : 'Unreachable';
  if ($('docPingSub')) $('docPingSub').textContent = `Loss: ${(ping.packet_loss || 0).toFixed(0)}% · Min: ${(ping.min_rtt || 0).toFixed(1)} ms · Max: ${(ping.max_rtt || 0).toFixed(1)} ms`;
  if ($('docJitterVal')) $('docJitterVal').textContent = (ping.jitter || 0).toFixed(2) + ' ms';
  if ($('docPacketsVal')) $('docPacketsVal').textContent = `${ping.received || 0} / ${ping.sent || 0}`;
  const pingBadge = $('docPingBadge');
  if (pingBadge) {
    if (!ping.success) { pingBadge.textContent = 'OFFLINE'; pingBadge.className = 'badge err'; }
    else if (ping.packet_loss > 10) { pingBadge.textContent = 'HIGH LOSS'; pingBadge.className = 'badge warn'; }
    else if (ping.avg_rtt > 120) { pingBadge.textContent = 'HIGH RTT'; pingBadge.className = 'badge warn'; }
    else { pingBadge.textContent = 'OPTIMAL'; pingBadge.className = 'badge ok'; }
  }

  // MTU Card
  const mtu = rep.mtu_result || {};
  if ($('docMtuVal')) $('docMtuVal').textContent = mtu.optimal ? (mtu.optimal + ' bytes') : '—';
  if ($('docMtu1420Val')) $('docMtu1420Val').innerHTML = mtu.mtu_1420 ? '<span class="badge ok">Pass</span>' : '<span class="badge warn">Fragmented</span>';
  if ($('docMtu1400Val')) $('docMtu1400Val').innerHTML = mtu.mtu_1400 ? '<span class="badge ok">Pass</span>' : '<span class="badge warn">Fragmented</span>';
  if ($('docMtu1360Val')) $('docMtu1360Val').innerHTML = mtu.mtu_1360 ? '<span class="badge ok">Pass</span>' : '<span class="badge err">Blocked</span>';
  const mtuBadge = $('docMtuBadge');
  if (mtuBadge) {
    if (mtu.optimal >= 1400) { mtuBadge.textContent = 'OPTIMAL'; mtuBadge.className = 'badge ok'; }
    else if (mtu.optimal > 0) { mtuBadge.textContent = 'REDUCED'; mtuBadge.className = 'badge warn'; }
    else { mtuBadge.textContent = 'UNKNOWN'; mtuBadge.className = 'badge dim'; }
  }

  // Speed Card
  const speed = rep.speed_result || {};
  if ($('docSpeedVal')) $('docSpeedVal').textContent = speed.tested ? ((speed.throughput_mbps || 0).toFixed(1) + ' Mbps') : '—';
  if ($('docSpeedSub')) $('docSpeedSub').textContent = speed.detail || 'Real tunnel bandwidth capacity';
  if ($('docSpeedMode')) $('docSpeedMode').textContent = speed.mode ? speed.mode.toUpperCase() : 'None';
  if ($('docIperfStatusVal')) $('docIperfStatusVal').innerHTML = speed.server_active ? '<span class="badge ok">Listening (:5201)</span>' : '<span class="badge dim">Stopped</span>';
  const speedBadge = $('docSpeedBadge');
  if (speedBadge) {
    if (!speed.tested) { speedBadge.textContent = 'NOT TESTED'; speedBadge.className = 'badge dim'; }
    else if (speed.throughput_mbps > 50) { speedBadge.textContent = 'FAST'; speedBadge.className = 'badge ok'; }
    else if (speed.throughput_mbps > 15) { speedBadge.textContent = 'MODERATE'; speedBadge.className = 'badge info'; }
    else { speedBadge.textContent = 'SLOW'; speedBadge.className = 'badge warn'; }
  }
  const iperfTxt = $('docIperfTxt');
  if (iperfTxt) iperfTxt.textContent = speed.server_active ? 'Stop iPerf3 Server' : 'Start iPerf3 Server';

  // Kernel Card
  const k = rep.kernel_audit || {};
  if ($('docCongestionVal')) $('docCongestionVal').textContent = k.congestion_alg ? k.congestion_alg.toUpperCase() : '—';
  if ($('docBbrVal')) $('docBbrVal').innerHTML = k.bbr_enabled ? '<span class="badge ok">Active</span>' : '<span class="badge warn">Disabled (Cubic)</span>';
  if ($('docMssVal')) $('docMssVal').innerHTML = k.mss_clamping ? '<span class="badge ok">Clamped</span>' : '<span class="badge warn">Inactive</span>';
  if ($('docIpFwdVal')) $('docIpFwdVal').innerHTML = k.ip_forwarding ? '<span class="badge ok">Enabled</span>' : '<span class="badge err">Disabled</span>';
  const kBadge = $('docKernelBadge');
  if (kBadge) {
    if (k.bbr_enabled && k.mss_clamping && k.ip_forwarding) { kBadge.textContent = 'TUNED'; kBadge.className = 'badge ok'; }
    else { kBadge.textContent = 'NEEDS TUNE'; kBadge.className = 'badge warn'; }
  }

  // Issues Box
  const issuesBox = $('docIssuesBox');
  const issuesCount = $('docIssuesCount');
  const issues = rep.issues || [];
  const recs = rep.recommendations || [];
  if (issuesCount) issuesCount.textContent = `${issues.length} issue${issues.length === 1 ? '' : 's'} detected`;
  if (issuesBox) {
    if (issues.length === 0) {
      issuesBox.innerHTML = '<div class="qs-hint u-color-ok">✓ ' + (tr('x014', "All diagnostic tests passed with zero bottlenecks. Connection is operating at peak performance.")) + '</div>';
    } else {
      let html = '';
      for (let i = 0; i < issues.length; i++) {
        const iss = issues[i];
        const rec = recs[i] || '';
        html += `<div class="doc-issue-item">
          <span class="badge warn u-btn-xs u-flex-none">!</span>
          <div>
            <b>${esc(iss)}</b>
            ${rec ? `<div class="qs-hint u-mt-2">${esc(rec)}</div>` : ''}
          </div>
        </div>`;
      }
      html += `<div style="margin-top:14px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.08);display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
        <span class="qs-hint" style="color:var(--mu);">${tr('x015', "Recommendation: Run automated repair to resolve bottlenecks and optimize parameters.")}</span>
        <button class="hashem-btn hashem-btn-primary u-btn-sm" id="docBoxFixBtn" onclick="fixDoctor()" style="font-weight:600;display:inline-flex;align-items:center;gap:6px;">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
          <span data-i18n="doc_fix_box_btn">${tr('x016', "Auto-Fix Detected Issues")}</span>
        </button>
      </div>`;
      issuesBox.innerHTML = html;
    }
  }

  // Reverse-path card: per-peer two-direction diagnosis + fix buttons.
  renderRevPath(rep.revpath || []);
}

// ---- Reverse path (Phase 4): diagnosis cards + dry-run / apply ----
function revVerdictBadge(v) {
  if (v === 'HEALTHY') return '<span class="badge ok"><span class="dot"></span>HEALTHY</span>';
  if (v === 'UNKNOWN') return '<span class="badge dim">UNKNOWN</span>';
  return '<span class="badge warn"><span class="dot"></span>' + esc(v) + '</span>';
}
function renderRevPath(entries) {
  const box = $('docRevPathBox');
  if (!box) return;
  if (!entries || !entries.length) {
    box.innerHTML = '<div class="qs-hint">No peer reverse-path data yet — run diagnostics on a hub with peers.</div>';
    return;
  }
  box.innerHTML = entries.map(e => {
    const d = e.diagnosis || {};
    const ev = (d.evidence || []).map(x => '<div class="qs-hint">· ' + esc(x) + '</div>').join('');
    const fix = d.suggested_fix ? '<div class="qs-hint">Fix: ' + esc(d.suggested_fix) + '</div>' : '';
    const btn = (d.verdict && d.verdict !== 'HEALTHY' && d.verdict !== 'UNKNOWN')
      ? '<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">'
        + '<button class="hashem-btn hashem-btn-secondary u-btn-xs" onclick="revFix(' + e.peer_id + ',false)">Show plan</button>'
        + '<button class="hashem-btn hashem-btn-primary u-btn-xs" onclick="revFix(' + e.peer_id + ',true)">Apply fix</button>'
        + '</div><div class="qs-hint" id="revSteps' + e.peer_id + '"></div>'
      : '';
    return '<div class="det-card u-col-full"><div class="det-head"><span>' + esc(e.name || ('peer-' + e.peer_id)) + '</span>'
      + revVerdictBadge(d.verdict) + '</div>'
      + '<div class="qs-hint">confidence: ' + esc(d.confidence || '?') + ' · checked: ' + esc(e.checked || '?') + '</div>'
      + ev + fix + btn + '</div>';
  }).join('');
}
async function revFix(peerId, apply) {
  const out = $('revSteps' + peerId);
  if (out) out.textContent = apply ? 'Applying…' : 'Planning…';
  try {
    const r = await api('/api/revpath/fix', { peer_id: peerId, apply: !!apply });
    const steps = (r.steps || []).map(s => (s.ok ? '✓ ' : '✗ ') + s.action + ': ' + (s.detail || '')).join('\n');
    const head = r.dry_run ? 'Plan (nothing applied):\n' : ('Before: ' + ((r.before || {}).verdict || '?') + ' → After: ' + ((r.after || {}).verdict || '?') + '\n');
    if (out) out.innerHTML = '<pre class="qs-hint" style="white-space:pre-wrap">' + esc(head + steps) + '</pre>';
    if (r.after) await loadDoctor(false);
  } catch (e) { if (out) out.textContent = e.message; reportErr('revpath', e); }
}

// ---- Tunnel Health: cached result on open, POST on demand ----
function thBadge(v) {
  if (v === 'PASS') return '<span class="badge ok"><span class="dot"></span>PASS</span>';
  if (v === 'FAIL') return '<span class="badge err"><span class="dot"></span>FAIL</span>';
  return '<span class="badge warn"><span class="dot"></span>' + esc(v || 'UNREACHABLE') + '</span>';
}
function renderTunnelHealth(res) {
  const box = $('thBox'), meta = $('thMeta');
  if (!box) return;
  const rows = (res && res.tunnels) || [];
  if (!rows.length) {
    if (meta) meta.textContent = res && res.checked ? 'no tunnels found' : 'not tested yet';
    return;
  }
  if (meta) meta.textContent = 'checked: ' + (res.checked || '?');
  box.innerHTML = rows.map(t => {
    const l = t.layers || {};
    const lat = t.latency_ms >= 0 ? t.latency_ms + ' ms' + (t.latency_kind ? ' (' + esc(t.latency_kind) + ')' : '') : '—';
    return '<div class="det-card u-col-full"><div class="det-head"><span>' + esc(t.name || ('tunnel-' + t.id))
      + ' · ' + esc(t.engine) + '</span>' + thBadge(t.verdict) + '</div>'
      + '<div class="qs-hint">' + esc(t.reason || '') + '</div>'
      + '<div class="qs-hint">service: ' + esc(l.service || '?') + ' · session: ' + esc(l.session || '?')
      + ' · data: ' + esc(l.data || '?') + ' · latency: ' + lat + '</div></div>';
  }).join('');
}
async function loadTunnelHealth() {
  try { renderTunnelHealth(await api('/api/tunnel-health?cached=1')); }
  catch (e) { reportErr('tunnel-health', e); }
}
async function runTunnelHealthClick() {
  const btn = $('thRunBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Testing…'; }
  try { renderTunnelHealth(await api('/api/tunnel-health/run', {})); }
  catch (e) { toastErr('Tunnel health test failed', e.message || e); reportErr('tunnel-health', e); }
  finally { if (btn) { btn.disabled = false; btn.textContent = 'Test all tunnels'; } }
}
(function initTunnelHealthEvents() {
  const b = $('thRunBtn');
  if (b) b.addEventListener('click', runTunnelHealthClick);
})();

async function runDoctor() {
  if (doctorRunning) return;
  doctorRunning = true;
  const btn = $('docRunBtn');
  if (btn) {
    btn.disabled = true;
    btn.classList.add('doc-pulse');
    btn.querySelector('span').textContent = tr('x017', "Diagnosing… (sweep MTU & ping)");
  }
  try {
    await loadDoctor(true);
    toastOk(tr('x018', "Diagnostics complete"), `${tr('x019', "Health score")}: ${doctorData ? doctorData.score : '—'}/100`);
  } catch(e) {
    toastErr(tr('x020', "Diagnostics failed"), e.message);
  } finally {
    doctorRunning = false;
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('doc-pulse');
      btn.querySelector('span').textContent = tr('x021', "Run Diagnostics");
    }
  }
}

async function fixDoctor() {
  const confirmTitle = tr('x022', "Apply Automated Optimizations?");
  const confirmDesc = tr('x023', "This will enable TCP BBR, configure MSS clamping, ensure IPv4 forwarding, tune FRP concurrency limits, and restore tunnel interface connectivity.");
  const confirmBtn = tr('x024', "Repair & Optimize");

  if (!await entConfirm(confirmTitle, confirmDesc, confirmBtn)) return;
  const btn = $('docFixBtn');
  const boxBtn = $('docBoxFixBtn');
  if (btn) {
    btn.disabled = true;
    const sp = btn.querySelector('span');
    if (sp) sp.textContent = tr('x025', "Applying fixes…");
  }
  if (boxBtn) {
    boxBtn.disabled = true;
    const sp = boxBtn.querySelector('span');
    if (sp) sp.textContent = tr('x026', "Applying…");
  }
  try {
    const res = await api('/api/doctor', { action: 'fix' });
    const appliedList = (res && res.fix && res.fix.applied) || (res && res.applied) || [];
    toastOk(tr('x027', "Optimizations applied"),
      appliedList.length > 0 ? appliedList.join(' · ') : (tr('x028', "System stack optimized")));
    if (res && res.report) renderDoctor(res.report);
    else await loadDoctor(true);
  } catch(e) {
    toastErr(tr('x029', "Fix failed"), e.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg><span data-i18n="doc_fix_btn">${tr('x030', "Quick Repair & Optimize")}</span>`;
    }
  }
}

async function toggleIperf() {
  const isRunning = doctorData && doctorData.speed_result && doctorData.speed_result.server_active;
  const action = isRunning ? 'iperf-stop' : 'iperf-start';
  const btn = $('docIperfBtn');
  const txt = $('docIperfTxt');
  if (btn) btn.disabled = true;
  if (txt) txt.textContent = isRunning ? 'Stopping…' : 'Starting…';
  try {
    const res = await api('/api/doctor', { action });
    toastOk(isRunning ? 'iPerf3 Stopped' : 'iPerf3 Started', (res && res.message) || (isRunning ? 'Server listener stopped' : 'Listening on port 5201'));
    await loadDoctor(false);
  } catch(e) {
    toastErr('iPerf3 action failed', e.message);
  } finally {
    if (btn) btn.disabled = false;
    if (txt && doctorData && doctorData.speed_result) {
      txt.textContent = doctorData.speed_result.server_active ? 'Stop iPerf3 Server' : 'Start iPerf3 Server';
    }
  }
}

if ($('docRunBtn')) $('docRunBtn').onclick = runDoctor;
if ($('docFixBtn')) $('docFixBtn').onclick = fixDoctor;
if ($('docIperfBtn')) $('docIperfBtn').onclick = toggleIperf;

// boot: if already logged in, status works; else show login
(async () => {
  try { await api('/api/status'); showApp(); refresh(); loadSetupDefaults(); loadVersion(); termFlagRefresh(); tlsRefresh(); twofaRefresh(); idleRefresh(); termAllowRefresh(); alertsRefresh(); metricsRefresh(); histRefresh(); advisorRefresh(); }
  catch(e) { showLogin(); }
})();
// light pollers: skip when the tab is in the background (background tabs
// throttle timers anyway and would wake queuing overlapping refreshes);
// clear the chart cache on hide so a long-hidden tab does not burst on return.
// Pollers (makePoller): skip while hidden, exponential backoff up to 60s on failure, immediate run on return.
makePoller(async () => { if ($('app').classList.contains('hidden')) return true; return await refresh(); }, 15000);
armLogFollow();
makePoller(async () => { if ($('app').classList.contains('hidden') || $('tab-dashboard').hidden) return true; return await refreshDash(); }, 5000);
document.addEventListener('visibilitychange', () => {
  const badge = $('chartLiveBadge');
  const cv = $('trafficChart');
  if (badge) {
    const paused = document.hidden || (cv && !!cv._isDown);
    badge.classList.toggle('is-paused', paused);
    const txt = badge.querySelector('.live-txt');
    if (txt) txt.textContent = paused ? 'PAUSED' : 'LIVE';
  }
  if (document.hidden) {
    if (cv) {
      cv._hist = null;
      if (cv._animId) { cancelAnimationFrame(cv._animId); cv._animId = null; }
    }
  }
  // resume: makePoller() re-runs refresh/refreshDash/rs-logs immediately on visibility
});

async function refreshRightSidebarLogs() {
  if (document.hidden || window.innerWidth < 1200 || rsIsHidden()) return true;
  const rs = $('rsLogs');
  try {
    const s = await api('/api/logs?svc=stream&n=22');
    if (!rs) return true;
    const lines = s.lines || (s.logs ? s.logs.trim().split('\n') : []);
    if (lines.length > 0) {
      rs.innerHTML = lines.map(l => {
        let tag = '';
        if (/frps/i.test(l)) tag = '<span class="badge info log-tag">FRPS</span>';
        else if (/frpc/i.test(l)) tag = '<span class="badge ok log-tag">FRPC</span>';
        else if (/watchdog|alert/i.test(l)) tag = '<span class="badge warn log-tag">WD</span>';
        else if (/gre-panel|panel/i.test(l)) tag = '<span class="badge dim log-tag">PANEL</span>';
        else if (/gre/i.test(l)) tag = '<span class="badge log-tag">GRE</span>';

        const timeMatch = l.match(/(\d{2}:\d{2}:\d{2})/);
        const timeTag = timeMatch ? `<span class="rs-log-time">${esc(timeMatch[1])}</span>` : '';
        const cleanMsg = l.replace(/^.*?\[\d+\]:\s*/, '').replace(/^[A-Za-z]+\s+\d+\s+\d+:\d+:\d+\s+\S+\s+\S+:\s*/, '');
        return '<div class="rs-log-line rs-log-mono">' + timeTag + tag + esc(cleanMsg || l) + '</div>';
      }).join('');
    } else {
      rs.innerHTML = stateEmpty({ title: tr('rs_empty_title', 'No log lines yet'), msg: tr('rs_waiting_sys', 'Waiting for system logs...'), compact: true });
    }
    return true;
  } catch(e) {
    reportErr('rslogs', e);
    if (rs && !rs.querySelector('.rs-log-mono')) rs.innerHTML = stateError(e.message, 'rslogs', true);
    return false;
  }
}
makePoller(refreshRightSidebarLogs, 3000);
setTimeout(refreshRightSidebarLogs, 300);

// ============================================================
// Live Activity Stream: closable, restorable from Logs
// ============================================================
function rsIsHidden() { return document.documentElement.dataset.rs === '0'; }
function rsSync() {
  const hid = rsIsHidden();
  const b = $('rsToggleBtn');
  if (b) { b.textContent = tr(hid ? 'rs_btn_show' : 'rs_btn_hide', hid ? 'Show' : 'Hide'); b.setAttribute('aria-pressed', hid ? 'false' : 'true'); }
}
function rsSet(hidden, silent) {
  document.documentElement.dataset.rs = hidden ? '0' : '1';
  try { localStorage.setItem('hashem_rs_hidden', hidden ? '1' : '0'); } catch (e) { /* storage blocked: choice lasts this session */ }
  rsSync();
  if (hidden && !silent) toastOk(tr('rs_hidden_toast', 'Live Activity Stream hidden'), tr('rs_hidden_sub', 'Bring it back from Logs \u2192 Live Activity Stream'));
  if (!hidden) refreshRightSidebarLogs();
}
$('rsClose').onclick = () => rsSet(true);
$('rsToggleBtn').onclick = () => rsSet(!rsIsHidden(), true);
rsSync();

// ============================================================
// Accent presets (contrast-checked; see enterprise.css)
// ============================================================
const ACCENTS = [
  ['blue', 'hsl(217 91% 60%)'], ['indigo', 'hsl(243 75% 62%)'], ['violet', 'hsl(265 83% 60%)'], ['rose', 'hsl(341 75% 50%)'],
  ['emerald', 'hsl(160 84% 36%)'], ['teal', 'hsl(178 80% 34%)'], ['orange', 'hsl(22 90% 46%)'],
];
function accCurrent() { return document.documentElement.dataset.acc || 'blue'; }
function accSet(name) {
  if (name === 'blue') delete document.documentElement.dataset.acc; else document.documentElement.dataset.acc = name;
  try { if (name === 'blue') localStorage.removeItem('hashem_accent'); else localStorage.setItem('hashem_accent', name); } catch (e) { /* storage blocked: choice lasts this session */ }
  accRender();
  try { if (typeof refreshDash === 'function') refreshDash(); } catch (e) { /* dashboard repaints on its next poll */ }
}
function accRender() {
  const g = $('accGrid'); if (!g) return;
  const cur = accCurrent();
  g.innerHTML = ACCENTS.map(([n, c]) => {
    const label = tr('acc_' + n, n);
    return '<button type="button" role="radio" class="acc-sw" data-acc="' + n + '" aria-checked="' + (n === cur) + '" aria-label="' + esc(label) + '" title="' + esc(label) + '" style="--sw:' + c + '"><span class="acc-dot"></span><span class="acc-name">' + esc(label) + '</span></button>';
  }).join('');
}
$('accGrid').addEventListener('click', e => { const b = e.target.closest('.acc-sw'); if (b) accSet(b.dataset.acc); });
$('accGrid').addEventListener('keydown', e => {
  if (!/^Arrow(Left|Right|Up|Down)$/.test(e.key)) return;
  const names = ACCENTS.map(a => a[0]); const rtl = document.documentElement.dir === 'rtl';
  const fwd = (e.key === 'ArrowRight') !== rtl && e.key !== 'ArrowLeft' || e.key === 'ArrowDown';
  const i = names.indexOf(accCurrent()); const n = (i + (fwd ? 1 : -1) + names.length) % names.length;
  e.preventDefault(); accSet(names[n]);
  const nb = $('accGrid').querySelector('[data-acc="' + names[n] + '"]'); if (nb) nb.focus();
});
accRender();

// ============================================================
// Support (donate) nudge: rare, calm, and coordinated by the server.
// Shown only after the tunnel has been healthy for SUP_DELAY_MS while the
// user is actively on a visible panel tab. The server's claim() hands the
// popup to exactly one tab/device per window (7 days) so it cannot spam.
// ============================================================
const SUP_DELAY_MS = 30000;
const SUP = { since: 0, shown: false, busy: false };
function supHealthy(s) {
  const L = (s && s.local) || {}; const g = L.gre || {};
  const localOk = !!L.frp_up && (g.exists ? !!(L.ping_ok || L.health_state === 'healthy') : /foreign/i.test(L.role || ''));
  const peerOk = ((s && s.peers) || []).some(p => p.frp_up && (p.ping_ok || p.health_state === 'healthy'));
  return localOk || peerOk;
}
function supObserve(s) {
  if (supHealthy(s)) { if (!SUP.since) SUP.since = Date.now(); } else SUP.since = 0;
}
function supBlocked() {
  if (document.hidden || $('app').classList.contains('hidden')) return true;
  if (document.querySelector('.ent-modal-ov:not([hidden])')) return true;
  if ($('drawer') && $('drawer').classList.contains('open')) return true;
  if ($('tab-terminal') && !$('tab-terminal').hidden) return true;      // never interrupt a shell
  const a = document.activeElement;
  if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return true;    // never interrupt typing
  return false;
}
async function supTick() {
  if (document.hidden) return; // C2.7: support popup never polls a hidden tab
  if (SUP.shown || SUP.busy || !SUP.since || Date.now() - SUP.since < SUP_DELAY_MS || supBlocked()) return;
  SUP.busy = true;
  try {
    const r = await api('/api/support', { action: 'claim' });
    if (r && r.show) supShow();
  } catch (e) { /* offline or logged out: stay quiet, retry later */ }
  finally { SUP.busy = false; }
}
function supShow() {
  const c = $('supCard'); SUP.shown = true;
  c.hidden = false; document.body.classList.add('sup-open'); c.classList.remove('out'); void c.offsetWidth; c.classList.add('in');
  document.body.style.setProperty('--sup-h', c.offsetHeight + 'px');
  if (window.ResizeObserver && !c._ro) { c._ro = new ResizeObserver(() => document.body.style.setProperty('--sup-h', c.offsetHeight + 'px')); c._ro.observe(c); }
}
function supHide(action) {
  const c = $('supCard'); if (c.hidden) return;
  c.classList.remove('in'); c.classList.add('out');
  setTimeout(() => { c.hidden = true; c.classList.remove('out'); document.body.classList.remove('sup-open'); }, 220);
  if (action) api('/api/support', { action }).catch(e => reportErr('support', e));
}
$('supX').onclick = () => supHide('close');
$('supLater').onclick = () => supHide('close');
$('supSnooze').onclick = () => supHide('snooze');
$('supGo').addEventListener('click', () => { supHide('donate'); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('supCard').hidden && !document.querySelector('.ent-modal-ov:not([hidden])')) supHide('close'); });
setInterval(supTick, 5000);

// ============================================================
// Fleet: health hero + topology + per-server sparklines (Tunnel tab).
// Display only. Data: /api/fleet (server-persisted ping history).
// Hidden entirely when there are no peer tunnels (e.g. foreign server).
// ============================================================
const FLEET_COL = { healthy: 'var(--ok)', degraded: 'var(--wr)', down: 'var(--er)' };
function fleetFmt(k, vars) { let t = tr(k, k); for (const x in (vars || {})) t = t.replace('{' + x + '}', vars[x]); return t; }
function fleetSpark(h) {
  const W = 120, H = 36, P = 3, MAX = 60;
  if (!h || h.length < 2) return '<div class="fl-nodata">' + esc(tr('fleet_nodata', 'Collecting data…')) + '</div>';
  // downsample to <= MAX buckets (avg of answered pings; a bucket with any loss keeps a loss mark)
  const step = Math.max(1, Math.ceil(h.length / MAX)), pts = [];
  for (let i = 0; i < h.length; i += step) {
    const b = h.slice(i, i + step), ok = b.filter(x => x.ms >= 0);
    pts.push({ ms: ok.length ? ok.reduce((a, x) => a + x.ms, 0) / ok.length : -1, loss: ok.length < b.length });
  }
  const vals = pts.filter(p => p.ms >= 0).map(p => p.ms);
  const lo = vals.length ? Math.min(...vals) : 0, hi = vals.length ? Math.max(...vals) : 1, span = Math.max(hi - lo, 5);
  const x = i => P + (W - 2 * P) * (pts.length === 1 ? 1 : i / (pts.length - 1));
  const y = v => H - P - (H - 2 * P) * ((v - lo) / span);
  let d = '', pen = false, lossMarks = '';
  pts.forEach((p, i) => {
    if (p.ms < 0) { pen = false; lossMarks += '<line x1="' + x(i).toFixed(1) + '" x2="' + x(i).toFixed(1) + '" y1="' + (H - P - 4) + '" y2="' + (H - P) + '" class="fl-loss"/>'; return; }
    d += (pen ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.ms).toFixed(1); pen = true;
  });
  const area = d && vals.length > 1 ? '<path d="' + d + ' L' + x(pts.length - 1).toFixed(1) + ' ' + (H - P) + ' L' + x(0).toFixed(1) + ' ' + (H - P) + ' Z" class="fl-area"/>' : '';
  return '<svg class="fl-spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true">' + area + '<path d="' + d + '" class="fl-line" vector-effect="non-scaling-stroke"/>' + lossMarks + '</svg>';
}
function fleetTopo(nodes, hubIp) {
  const n = nodes.length, rowH = 62, padY = 26, W = 380, H = Math.max(130, padY * 2 + (n - 1) * rowH + 30);
  const hx = 58, hy = H / 2, nx = 206;
  let links = '', dots = '';
  nodes.forEach((nd, i) => {
    const ny = padY + 15 + i * rowH, c = nd.health;
    const path = 'M' + (hx + 28) + ' ' + hy + ' C' + (hx + 110) + ' ' + hy + ' ' + (nx - 90) + ' ' + ny + ' ' + (nx - 26) + ' ' + ny;
    links += '<path d="' + path + '" class="tp-link tp-' + c + '"/>';
    const ms = fleetMs(nd) >= 0 ? Math.round(fleetMs(nd)) + ' ms' : '—';
    dots += '<g class="tp-node tp-' + c + '"><circle cx="' + nx + '" cy="' + ny + '" r="22" class="tp-ring"/><circle cx="' + nx + '" cy="' + ny + '" r="6" class="tp-core"/>'
      + '<text x="' + (nx + 32) + '" y="' + (ny - 3) + '" class="tp-name"><title>' + esc(nd.name) + '</title>' + esc(nd.name.length > 17 ? nd.name.slice(0, 16) + '…' : nd.name) + '</text>'
      + '<text x="' + (nx + 32) + '" y="' + (ny + 13) + '" class="tp-sub">' + esc(tr('fleet_' + c, c)) + ' · ' + ms + (nd.frp_only ? ' · ' + esc(tr('fleet_frp_only', 'FRP only')) : '') + '</text></g>';
  });
  const hub = '<g class="tp-hub"><circle cx="' + hx + '" cy="' + hy + '" r="30" class="tp-hub-ring"/><circle cx="' + hx + '" cy="' + hy + '" r="20" class="tp-hub-core"/>'
    + '<text x="' + hx + '" y="' + (hy + 4) + '" class="tp-hub-ic" text-anchor="middle">IR</text>'
    + '<text x="' + hx + '" y="' + (hy + 50) + '" class="tp-name" text-anchor="middle">' + esc(tr('fleet_hub', 'Iran hub')) + '</text>'
    + (hubIp ? '<text x="' + hx + '" y="' + (hy + 65) + '" class="tp-sub" text-anchor="middle">' + esc(hubIp) + '</text>' : '') + '</g>';
  return '<svg viewBox="0 0 ' + W + ' ' + (H + 20) + '" role="img" aria-label="' + esc(fleetFmt('fleet_topo_aria', { hub: tr('fleet_hub', 'Iran hub'), n })) + '" class="fl-topo-svg">' + links + hub + dots + '</svg>';
}
function fleetRender(d) {
  const card = $('fleetCard'); if (!card) return;
  const nodes = (d && d.nodes) || [];
  card.hidden = !nodes.length;
  if (!nodes.length) return;
  const t = nodes.length, h = d.healthy || 0, bad = t - h;
  const state = h === t ? 'healthy' : (d.down === t ? 'down' : 'degraded');
  const ring = $('fleetRing');
  ring.style.setProperty('--p', Math.round(h * 100 / t));
  ring.style.setProperty('--c', FLEET_COL[state]);
  ring.setAttribute('aria-label', fleetFmt('fleet_ring_aria', { h, t }));
  $('fleetRingNum').textContent = h + '/' + t;
  const sum = $('fleetSum');
  sum.textContent = h === t ? tr('fleet_all_ok', 'All servers healthy') : (d.down === t ? tr('fleet_all_down', 'All servers are down') : fleetFmt('fleet_some', { n: bad, t }));
  sum.style.color = FLEET_COL[state];
  $('fleetMeta').textContent = fleetFmt('fleet_meta', { time: String(d.checked || '').slice(11, 19) + ' UTC', s: d.interval_s || 15 }) + (d.snapshot_age_ms >= 0 ? ' · ' + tr('fleet_updated', 'updated') + ' ' + Math.round(d.snapshot_age_ms / 1000) + 's ' + tr('fleet_ago', 'ago') : '');
  $('fleetTopo').innerHTML = fleetTopo(nodes, d.hub);
  $('fleetGrid').innerHTML = nodes.map(n => {
    const st = n.stats || {}, ms = fleetMs(n) >= 0 ? Math.round(fleetMs(n)) : null;
    const eng = n.engine === 'backhaul' ? 'Backhaul' : n.engine === 'gre-backhaul' ? 'GRE+Backhaul' : 'FRP';
    const cls = n.health === 'healthy' ? 'ok' : n.health === 'degraded' ? 'warn' : 'err';
    return '<article class="fl-card fl-' + n.health + '" aria-label="' + esc(n.name) + '"' + (reasonsTip(n) ? ' title="' + reasonsTip(n) + '"' : '') + '>'
      + '<header class="fl-head"><span class="fl-name" title="' + esc(n.name) + '">' + esc(n.name) + '</span><span class="badge ' + cls + '"><span class="dot"></span>' + esc(tr('fleet_' + n.health, n.health)) + '</span></header>'
      + '<div class="fl-ip mono">' + esc(n.remote_pub || '—') + ' · ' + esc(eng) + (n.transport ? ' · ' + esc(n.transport) : '') + (n.frp_only ? ' · ' + esc(tr('fleet_frp_only', 'FRP only')) : '') + (n.icmp_filtered ? ' · ' + esc(tr('fleet_icmp_filtered', 'ICMP filtered')) : '') + '</div>'
      + '<div class="fl-ms"><b>' + (ms != null ? ms : '—') + '</b><span>ms</span></div>'
      + fleetSpark(n.history)
      + '<footer class="fl-stats"><div><span>' + esc(tr('fleet_avg', 'Avg')) + '</span><b>' + (st.samples && st.avg_ms ? Math.round(st.avg_ms) + ' ms' : '—') + '</b></div>'
      + '<div><span>' + esc(tr('fleet_loss', 'Loss')) + '</span><b>' + (st.samples ? st.loss_pct + '%' : '—') + '</b></div>'
      + '<div><span>' + esc(tr('fleet_uptime', 'Uptime')) + '</span><b>' + (st.samples ? st.up_pct + '%' : '—') + '</b></div></footer></article>';
  }).join('');
}
let _fleetLast = null;
async function loadFleet() {
  try { _fleetLast = await api('/api/fleet'); fleetRender(_fleetLast); return true; }
  catch (e) { reportErr('fleet', e); return false; }
}
makePoller(async () => { if ($('app').classList.contains('hidden') || $('tab-tunnel').hidden) return true; return await loadFleet(); }, 10000);

// ============================================================
// Dial route (foreign side only): GRE inner IP vs Iran public IP vs auto.
// ============================================================
let _dial = null;
async function loadDial() {
  try { _dial = await api('/api/dial'); dialRender(); return true; }
  catch (e) { reportErr('dial', e); return false; }
}
function dialRender() {
  const d = _dial || {}, card = $('dialCard'); if (!card) return;
  card.hidden = !d.available; if (!d.available) return;
  const b = $('dialBadge'); b.className = 'badge ' + (d.active === 'public' ? 'info' : 'ok');
  $('dialBadgeTxt').textContent = (d.active === 'public' ? tr('dial_public', 'Public IP') : d.active === 'gre' ? 'GRE' : (d.addr || '?')) + ' · ' + (d.addr || '') + ':' + (d.port || '');
  const acts = $('dialActs'); acts.textContent = '';
  [['auto', 'dial_auto', 'Auto'], ['gre', 'dial_gre', 'GRE inner IP'], ['public', 'dial_public_btn', 'Iran public IP']].forEach(([m, k, def]) => {
    const btn = document.createElement('button'); btn.type = 'button';
    btn.className = 'hashem-btn ' + (d.mode === m ? 'hashem-btn-primary' : 'hashem-btn-secondary');
    btn.textContent = tr(k, def) + (d.mode === m ? ' ✓' : '');
    btn.onclick = async () => {
      btn.disabled = true;
      try { _dial = await api('/api/dial', { mode: m }); dialRender(); toastOk && toastOk('Dial', m); }
      catch (e) { reportErr('dial', e); btn.disabled = false; }
    };
    acts.appendChild(btn);
  });
}
makePoller(async () => { if ($('app').classList.contains('hidden') || $('tab-tunnel').hidden) return true; return await loadDial(); }, 15000);

// ============================================================
// Connectivity Rescue: detect a one-way block and reverse the dial direction.
// Nothing is changed until the user clicks; the banner only reports.
// ============================================================
let _rsc = null, _rscFull = false, _rscMode = '';
function rscSet(id, v) { const e = $(id); if (e) e.textContent = v; }
async function loadRescue() {
  try { _rsc = await api('/api/rescue' + (_rscFull ? '?full=1' : '')); rscRender(); return true; }
  catch (e) { reportErr('rescue', e); return false; }
}
function rscBadge(kind, key) {
  const b = $('rscBadge'); b.className = 'badge ' + kind;
  rscSet('rscBadgeTxt', tr(key, key));
}
function rscBtn(id, key, cls, fn) {
  const b = document.createElement('button'); b.type = 'button'; b.id = id; b.className = 'hashem-btn ' + cls;
  b.textContent = tr(key, key); b.onclick = fn; return b;
}
function rscRender() {
  const s = _rsc || {}, card = $('rescueCard'), ban = $('rscBanner');
  const active = !!s.role, show = active || s.suspected || _rscMode;
  card.hidden = !show;
  // Banner: only on the tunnel-less detection state, and only outside the card's own tab flow.
  ban.hidden = !(s.suspected && !active);
  if (!show) return;
  const acts = $('rscActs'); acts.textContent = '';
  const det = $('rscDet'); det.textContent = '';
  $('rscForm').hidden = _rscMode !== 'enable'; $('rscJoin').hidden = _rscMode !== 'join';
  const ic = $('rscIc'); ic.className = 'rsc-ic' + (active ? (s.block_lifted ? ' warn' : ' ok') : (s.suspected ? ' warn' : ''));
  let msg = '';
  if (!s.frp_ok) msg = tr('rsc_nocfg', '');
  if (active) {
    const onBadge = s.auto_triggered ? 'rsc_b_on_auto' : 'rsc_b_on';
    if (s.role === 'origin') {
      rscBadge(s.connected ? 'ok' : 'warn', s.connected ? onBadge : 'rsc_b_wait');
      msg = msg || fleetFmt(s.auto_triggered ? 'rsc_origin_auto' : 'rsc_origin', { n: (s.ports || []).length, ip: s.remote_ip });
    } else {
      rscBadge(s.connected ? 'ok' : 'warn', s.connected ? onBadge : 'rsc_b_wait');
      msg = msg || fleetFmt(s.auto_triggered ? 'rsc_entry_auto' : 'rsc_entry', { n: (s.ports || []).length, ip: s.remote_ip });
    }
    if (s.block_lifted) { rscBadge('warn', 'rsc_b_lift'); msg += ' ' + tr('rsc_lift', ''); }
    const rows = [[tr('rsc_conn', ''), s.connected ? tr('rsc_conn_ok', '') : tr('rsc_conn_no', '')],
      ['TCP/UDP', (s.ports || []).join(', ')]];
    if (s.direct && s.direct.length) rows.push([tr('rsc_direct', ''), s.direct.join(', ')]);
    if (s.role === 'entry' && s.relay && s.relay.length) rows.push([tr('rsc_relay', ''), s.relay.join(', ')]);
    if (s.skipped && s.skipped.length) rows.push([tr('rsc_skipped', '').replace('{p}', '').replace(/[:：]\s*$/, ''), s.skipped.join(', ')]);
    if (s.services) rows.push([tr('rsc_svc', ''), Object.entries(s.services).map(([k, v]) => k + (v ? ' ✓' : ' ✗')).join('  ')]);
    rows.forEach(([k, v]) => { const d = document.createElement('div'); d.className = 'rsc-row'; const a = document.createElement('span'); a.textContent = k; const b = document.createElement('b'); b.textContent = v; d.append(a, b); det.appendChild(d); });
    if (s.role === 'origin' && s.offer_pending) { const h = document.createElement('div'); h.className = 'qs-hint'; h.textContent = tr('rsc_auto', ''); det.appendChild(h); }
    if (s.role === 'origin') acts.appendChild(rscBtn('rscGetCode', 'rsc_getcode', 'hashem-btn-secondary', rscShowCode));
    acts.appendChild(rscBtn('rscDisable', 'rsc_disable', 'hashem-btn-danger', rscDisable));
  } else if (_rscMode === 'enable') {
    rscBadge('', 'rsc_b_off'); msg = msg || tr('rsc_idle_warn', '');
    acts.appendChild(rscBtn('rscEnableGo', 'rsc_enable', 'hashem-btn-primary', rscEnable));
    acts.appendChild(rscBtn('rscCancel', 'rsc_cancel', 'hashem-btn-secondary', () => { _rscMode = ''; rscRender(); }));
  } else if (_rscMode === 'join') {
    rscBadge('', 'rsc_b_off'); msg = msg || tr('rsc_auto', '');
    acts.appendChild(rscBtn('rscJoinGo', 'rsc_apply', 'hashem-btn-primary', rscJoin));
    acts.appendChild(rscBtn('rscCancel', 'rsc_cancel', 'hashem-btn-secondary', () => { _rscMode = ''; rscRender(); }));
  } else {
    rscBadge(s.suspected ? 'warn' : '', s.suspected ? 'rsc_b_susp' : 'rsc_b_off');
    msg = msg || tr(s.suspected ? 'rsc_idle_warn' : 'rsc_idle_ok', '');
    acts.appendChild(rscBtn('rscOpenEnable', 'rsc_enable', 'hashem-btn-primary', rscOpenEnable));
    acts.appendChild(rscBtn('rscOpenJoin', 'rsc_join', 'hashem-btn-secondary', () => { _rscMode = 'join'; rscRender(); $('rscCode').focus(); }));
    acts.appendChild(rscBtn('rscProbe', 'rsc_check', 'hashem-btn-ghost', rscProbe));
  }
  rscSet('rscMsg', msg);
}
async function rscOpenEnable() {
  _rscFull = true; await loadRescue(); const s = _rsc || {};
  _rscMode = 'enable';
  if (!$('rscRemote').value && s.suggest_remote) $('rscRemote').value = s.suggest_remote;
  if (!$('rscPorts').value && (s.suggest_ports || []).length) $('rscPorts').value = s.suggest_ports.join(', ');
  rscRender(); $('rscRemote').focus();
}
async function rscProbe() {
  const b = $('rscProbe'); if (b) b.disabled = true;
  try {
    const r = await api('/api/rescue', { action: 'probe' });
    const v = r.result && r.result.verdict;
    const k = { ok: 'rsc_probe_ok', one_way_block: 'rsc_probe_block', host_unreachable: 'rsc_probe_down', service_down: 'rsc_probe_svc' }[v] || 'rsc_probe_down';
    (v === 'ok' ? toastOk : toastWarn)(tr(k, k));
    await loadRescue();
  } catch (e) { toastErr(e.message || String(e)); reportErr('rescue', e); }
  finally { if ($('rscProbe')) $('rscProbe').disabled = false; }
}
async function rscEnable() {
  if (!await entConfirm(tr('rsc_confirm_t', ''), tr('rsc_confirm_b', ''), tr('rsc_enable', ''))) return;
  const b = $('rscEnableGo'); if (b) b.disabled = true;
  try {
    await api('/api/rescue', { action: 'enable', remote_ip: $('rscRemote').value.trim(), ports: $('rscPorts').value.trim() });
    _rscMode = ''; toastOk(tr('rsc_done', '')); await loadRescue(); rscShowCode();
  } catch (e) { toastErr(e.message || String(e)); }
  finally { if ($('rscEnableGo')) $('rscEnableGo').disabled = false; }
}
async function rscJoin() {
  const b = $('rscJoinGo'); if (b) b.disabled = true;
  try {
    await api('/api/rescue', { action: 'join', code: $('rscCode').value.trim() });
    $('rscCode').value = ''; _rscMode = ''; toastOk(tr('rsc_done', '')); await loadRescue();
  } catch (e) { toastErr(e.message || String(e)); }
  finally { if ($('rscJoinGo')) $('rscJoinGo').disabled = false; }
}
async function rscDisable() {
  if (!await entConfirm(tr('rsc_dis_t', ''), tr('rsc_dis_b', ''), tr('rsc_disable', ''))) return;
  try { await api('/api/rescue', { action: 'disable' }); _rscMode = ''; toastOk(tr('rsc_removed', '')); await loadRescue(); }
  catch (e) { toastErr(e.message || String(e)); }
}
async function rscShowCode() {
  try {
    const r = await api('/api/rescue', { action: 'code' });
    const box = $('rscDet'); let row = $('rscCodeRow');
    if (!row) { row = document.createElement('div'); row.id = 'rscCodeRow'; row.className = 'rsc-code'; box.appendChild(row); }
    row.textContent = '';
    const inp = document.createElement('input'); inp.className = 'hashem-input mono'; inp.readOnly = true; inp.value = r.code; inp.setAttribute('aria-label', tr('rsc_code', ''));
    inp.onfocus = () => inp.select();
    const cp = document.createElement('button'); cp.type = 'button'; cp.className = 'hashem-btn hashem-btn-secondary'; cp.textContent = tr('rsc_copy', '');
    cp.onclick = () => { navigator.clipboard.writeText(r.code).then(() => toastOk(tr('rsc_copied', '')), () => { inp.select(); }); };
    row.append(inp, cp);
  } catch (e) { toastErr(e.message || String(e)); }
}
$('rscBanGo').onclick = () => { goTab('tunnel'); setTimeout(() => { $('rescueCard').scrollIntoView({ behavior: 'smooth', block: 'start' }); rscOpenEnable(); }, 80); };
makePoller(async () => { if ($('app').classList.contains('hidden')) return true; return await loadRescue(); }, 20000);
// First paint must not wait a whole poll interval: fetch once as soon as the app is visible.
(function rscFirst(n) { if (!$('app').classList.contains('hidden')) { loadRescue(); return; } if (n < 40) setTimeout(() => rscFirst(n + 1), 500); })(0);

// ============================================================
// Stage 3: command palette, collapsible sidebar + alert badges,
// table tools (filter / sort / density), onboarding.
// ============================================================
// ---- nav badges (sidebar + drawer share them) ----
function navBadge(tab, n, kind, titleKey) {
  document.querySelectorAll('[data-tab="' + tab + '"] .nav-badge').forEach(b => {
    b.classList.toggle('hidden', !n);
    b.textContent = n > 9 ? '9+' : String(n || '');
    b.className = 'nav-badge u-ml-auto ' + (kind || 'warn') + (n ? '' : ' hidden');
    const t = n ? fleetFmt(titleKey, { n }) : '';
    b.title = t; b.setAttribute('aria-label', t);
  });
}
function uiObserve(s) {
  const peers = (s && s.peers) || [], L = (s && s.local) || {};
  let bad = peers.filter(p => p.health_state ? p.health_state !== 'healthy' : !(p.gre_up && p.frp_up && p.ping_ok)).length;
  const anyDown = peers.some(p => !p.gre_up && !p.frp_up);
  if (!peers.length && L.gre && L.gre.exists && !L.frp_up) bad = 1;
  navBadge('tunnel', bad, (anyDown || (!peers.length && bad)) ? 'err' : 'warn', 'badge_tunnel');
  // onboarding: only when nothing is configured at all
  // `role` is always populated (it has a default), so it cannot signal "configured".
  const bObj = (_sshfwdData || (window._lastDash && window._lastDash.bagher) || window._lastBagher || {});
  const bagherConfigured = !!(bObj.is_active || bObj.enabled || bObj.connected || bObj.has_config || (bObj.remote_host && bObj.remote_host.length) || (Array.isArray(bObj.ports) && bObj.ports.length));
  const empty = !peers.length && !(L.gre && L.gre.exists) && !L.frp_up && !bagherConfigured;
  let dismissed = false; try { dismissed = localStorage.getItem('hashem_onb_done') === '1'; } catch (e) { /* storage blocked */ }
  const c = $('onbCard'); if (c) c.hidden = !empty || dismissed;
}
{ const _rd = renderDoctor; renderDoctor = function (rep) { _rd(rep); try { navBadge('doctor', ((rep && rep.issues) || []).length, rep && rep.rating === 'critical' ? 'err' : 'warn', 'badge_doctor'); } catch (e) { /* cosmetic */ } }; }
$('onbGo').onclick = () => goTab('setup');
function onbHide() { try { localStorage.setItem('hashem_onb_done', '1'); } catch (e) { /* session only */ } $('onbCard').hidden = true; }
$('onbLater').onclick = onbHide; $('onbX').onclick = onbHide;

// ---- sidebar collapse ----
function sbIsCollapsed() { return document.documentElement.dataset.sb === '1'; }
function sbApply() {
  const c = sbIsCollapsed(), b = $('sbToggle');
  if (b) { b.setAttribute('aria-pressed', c ? 'true' : 'false'); const t = tr(c ? 'sb_expand' : 'sb_collapse', c ? 'Expand sidebar' : 'Collapse sidebar'); b.setAttribute('aria-label', t); b.title = t; }
  // icon-only rows still need an accessible name + tooltip
  document.querySelectorAll('#sideNav [data-tab]').forEach(n => {
    const lab = n.querySelector('[data-i18n]'); const t = lab ? lab.textContent.trim() : '';
    if (c && t) { n.title = t; n.setAttribute('aria-label', t); } else { n.removeAttribute('title'); n.removeAttribute('aria-label'); }
  });
}
function sbSet(c) {
  if (c) document.documentElement.dataset.sb = '1'; else delete document.documentElement.dataset.sb;
  try { localStorage.setItem('hashem_sb', c ? '1' : '0'); } catch (e) { /* session only */ }
  sbApply();
}
$('sbToggle').onclick = () => sbSet(!sbIsCollapsed());
sbApply();

// ---- table density ----
function densApply() {
  const c = document.documentElement.dataset.dens === 'compact';
  document.querySelectorAll('#densSeg [data-dens]').forEach(b => b.setAttribute('aria-pressed', (b.dataset.dens === 'compact') === c ? 'true' : 'false'));
}
function densSet(v) {
  if (v === 'compact') document.documentElement.dataset.dens = 'compact'; else delete document.documentElement.dataset.dens;
  try { localStorage.setItem('hashem_dens', v); } catch (e) { /* session only */ }
  densApply();
}
$('densSeg').addEventListener('click', e => { const b = e.target.closest('[data-dens]'); if (b) densSet(b.dataset.dens); });
densApply();

// ---- table tools: filter + sortable headers (errors table) ----
function tblRefilter() {
  const wrap = $('errList'), inp = $('errFilter'); if (!wrap || !inp) return;
  const q = inp.value.trim().toLowerCase(), rows = wrap.querySelectorAll('tbody tr');
  let shown = 0;
  rows.forEach(r => { const ok = !q || r.textContent.toLowerCase().includes(q); r.hidden = !ok; if (ok) shown++; });
  const c = $('errFilterCount'); if (c) c.textContent = rows.length && q ? fleetFmt('tbl_shown', { n: shown, t: rows.length }) : '';
}
$('errFilter').addEventListener('input', tblRefilter);
function tblSort(th) {
  const table = th.closest('table'), idx = +th.dataset.sort, body = table.tBodies[0];
  const dir = th.getAttribute('aria-sort') === 'ascending' ? 'descending' : 'ascending';
  table.querySelectorAll('th[data-sort]').forEach(h => h.setAttribute('aria-sort', 'none'));
  th.setAttribute('aria-sort', dir);
  const rows = Array.from(body.rows);
  rows.sort((a, b) => { const x = a.cells[idx].textContent.trim(), y = b.cells[idx].textContent.trim(); return (dir === 'ascending' ? 1 : -1) * x.localeCompare(y, undefined, { numeric: true }); });
  rows.forEach(r => body.appendChild(r));
}
document.addEventListener('click', e => { const th = e.target.closest && e.target.closest('th[data-sort]'); if (th) tblSort(th); });
document.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('th[data-sort]')) { e.preventDefault(); tblSort(e.target); } });

// ---- command palette ----
const PAL = { open: false, items: [], shown: [], sel: 0, release: null };
const palMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
{ const k = $('palKbd'); if (k) k.textContent = palMac ? '\u2318 K' : 'Ctrl K'; }
function palItems() {
  const go = tr('pal_go', 'Go to'), act = tr('pal_act', 'Actions'), look = tr('pal_look', 'Appearance');
  const it = [];
  document.querySelectorAll('#sideNav [data-tab]').forEach(b => {
    if (b.classList.contains('hidden')) return;
    const lab = b.querySelector('[data-i18n]'); const t = lab ? lab.textContent.trim() : b.dataset.tab;
    it.push({ g: go, t, k: b.dataset.tab, ic: b.querySelector('svg') ? b.querySelector('svg').outerHTML : '', run: () => goTab(b.dataset.tab) });
  });
  it.push({ g: act, t: tr('pal_refresh', 'Refresh data'), k: 'refresh reload', run: () => $('refreshBtn').click() });
  it.push({ g: act, t: tr('pal_diag', 'Run diagnostics'), k: 'doctor health check diagnostics', run: () => { goTab('doctor'); loadDoctor(true); } });
  it.push({ g: act, t: tr('pal_stream', 'Show / hide Live Activity Stream'), k: 'stream logs live activity', run: () => rsSet(!rsIsHidden(), true) });
  it.push({ g: act, t: tr('pal_donate', 'Support Hashem'), k: 'donate support pdnczone', run: () => window.open('https://www.pdnczone.ir', '_blank', 'noopener,noreferrer') });
  it.push({ g: act, t: tr('pal_logout', 'Log out'), k: 'logout sign out exit', run: () => $('logoutBtn').click() });
  it.push({ g: look, t: tr('pal_theme', 'Toggle dark / light theme'), k: 'theme dark light mode', run: () => $('themeBtn').click() });
  it.push({ g: look, t: tr('pal_lang', 'Switch language'), k: 'language persian farsi english', run: () => toggleLang() });
  it.push({ g: look, t: tr('pal_sidebar', 'Collapse / expand sidebar'), k: 'sidebar menu collapse', run: () => sbSet(!sbIsCollapsed()) });
  it.push({ g: look, t: tr('pal_density', 'Toggle table density'), k: 'density compact comfortable table', run: () => densSet(document.documentElement.dataset.dens === 'compact' ? 'comfortable' : 'compact') });
  ACCENTS.forEach(([n, c]) => it.push({ g: look, t: tr('pal_accent', 'Accent colour') + ': ' + tr('acc_' + n, n), k: 'accent color colour ' + n, sw: c, run: () => accSet(n) }));
  return it;
}
function palScore(item, toks) {
  const h = (item.t + ' ' + item.k + ' ' + item.g).toLowerCase(); let sc = 0;
  for (const t of toks) { const i = h.indexOf(t); if (i < 0) return -1; sc += i === 0 ? 0 : (h.charAt(i - 1) === ' ' ? 2 : 6) + i / 100; }
  return sc;
}
function palRender() {
  const q = $('palInput').value.trim().toLowerCase(), toks = q.split(/\s+/).filter(Boolean);
  let list = PAL.items.map((x, i) => ({ x, s: toks.length ? palScore(x, toks) : i })).filter(r => r.s >= 0);
  if (toks.length) list.sort((a, b) => a.s - b.s);
  PAL.shown = list.map(r => r.x); PAL.sel = Math.min(PAL.sel, Math.max(0, PAL.shown.length - 1));
  const box = $('palList');
  if (!PAL.shown.length) { box.innerHTML = '<div class="pal-none" role="status">' + esc(tr('pal_none', 'Nothing matches')) + '</div>'; $('palInput').removeAttribute('aria-activedescendant'); return; }
  let lastG = '', html = '';
  PAL.shown.forEach((x, i) => {
    if (x.g !== lastG && !toks.length) { html += '<div class="pal-g" role="presentation">' + esc(x.g) + '</div>'; lastG = x.g; }
    html += '<div class="pal-it' + (i === PAL.sel ? ' on' : '') + '" role="option" id="palo' + i + '" data-i="' + i + '" aria-selected="' + (i === PAL.sel) + '">'
      + (x.sw ? '<i class="pal-sw" style="background:' + x.sw + '"></i>' : '<span class="pal-ic" aria-hidden="true">' + (x.ic || '') + '</span>') + '<span class="pal-t">' + esc(x.t) + '</span>'
      + (toks.length ? '<span class="pal-gt">' + esc(x.g) + '</span>' : '') + '</div>';
  });
  box.innerHTML = html;
  $('palInput').setAttribute('aria-activedescendant', 'palo' + PAL.sel);
}
function palSel(n) {
  if (!PAL.shown.length) return;
  PAL.sel = (n + PAL.shown.length) % PAL.shown.length;
  document.querySelectorAll('#palList .pal-it').forEach(el => { const on = +el.dataset.i === PAL.sel; el.classList.toggle('on', on); el.setAttribute('aria-selected', on); if (on) el.scrollIntoView({ block: 'nearest' }); });
  $('palInput').setAttribute('aria-activedescendant', 'palo' + PAL.sel);
}
function palOpen() {
  if (PAL.open || $('app').classList.contains('hidden')) return;
  if (document.querySelector('.ent-modal-ov:not([hidden])')) return;
  PAL.open = true; PAL.items = palItems(); PAL.sel = 0;
  $('palInput').value = ''; $('pal').hidden = false;
  PAL.release = trapModal($('pal'), palClose);
  palRender(); $('palInput').focus();
}
function palClose() {
  if (!PAL.open) return; PAL.open = false; $('pal').hidden = true;
  if (PAL.release) { PAL.release(); PAL.release = null; }
}
function palRun(i) { const x = PAL.shown[i]; if (!x) return; palClose(); try { x.run(); } catch (e) { reportErr('palette', e); } }
$('palBtn').onclick = palOpen;
$('palClose').onclick = palClose;
$('palInput').addEventListener('input', () => { PAL.sel = 0; palRender(); });
$('palInput').addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') { e.preventDefault(); palSel(PAL.sel + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); palSel(PAL.sel - 1); }
  else if (e.key === 'Enter') { e.preventDefault(); palRun(PAL.sel); }
});
$('palList').addEventListener('click', e => { const el = e.target.closest('.pal-it'); if (el) palRun(+el.dataset.i); });
$('palList').addEventListener('mousemove', e => { const el = e.target.closest('.pal-it'); if (el && +el.dataset.i !== PAL.sel) palSel(+el.dataset.i); });
$('pal').addEventListener('mousedown', e => { if (e.target === $('pal')) palClose(); });
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') { e.preventDefault(); PAL.open ? palClose() : palOpen(); }
});

// ============================================================
// Edit Peer / Edit Tunnel Modal
// ============================================================
let _editPortsPeerId = null;
let _editPortsList   = [];
let _editPeerBundle  = '';

function openEditPeer(peerId) {
  _editPortsPeerId = peerId;
  _editPeerBundle  = '';
  const modal = $('editPortsModal');
  if (!modal) return;

  let name = '', remoteIp = '', carrier = 'direct', ports = [], engine = 'frp', transport = 'tcpmux';
  const p = (peerId === 0) ? (window._lastLocal || {}) : ((tunPeerCache || []).find(x => x.id === peerId) || {});
  if (peerId === 0) {
    const st = p;
    name = 'Main tunnel';
    remoteIp = (st.gre && (st.gre.peer_ip || st.gre_peer)) || '';
    carrier = (st.carrier && (st.carrier.active || st.carrier.mode)) || 'direct';
    engine = st.engine || (st.frp_svc && st.frp_svc.includes('backhaul') ? (st.no_gre ? 'backhaul' : 'gre-backhaul') : 'frp');
    transport = st.transport || 'tcpmux';
    ports = st.proxy_ports || [];
    if (!ports.length && st.proxies) {
      ports = st.proxies.map(x => {
        const m = String(x).match(/\d+/);
        return m ? parseInt(m[0], 10) : null;
      }).filter(Boolean);
    }
  } else {
    name = p.name || ('peer-' + peerId);
    remoteIp = p.remote_pub || '';
    carrier = p.carrier || 'direct';
    engine = p.engine || (p.frps_svc && p.frps_svc.includes('backhaul') ? (p.no_gre ? 'backhaul' : 'gre-backhaul') : 'frp');
    transport = p.transport || 'tcpmux';
    if (p.raw_ports) {
      ports = p.raw_ports.split(',').map(s => s.trim()).filter(Boolean);
    } else {
      ports = p.ports ? [...p.ports] : [];
    }
  }

  _editPortsList = [...ports];

  $('editPortsTitle').textContent = 'Edit Tunnel \u2014 ' + name;
  $('editPortsSub').textContent   = 'Modify tunnel parameters, carrier protocol, or forwarded ports. Changes apply immediately.';
  
  if ($('editPeerName'))   $('editPeerName').value = name;
  if ($('editPeerRemote')) $('editPeerRemote').value = remoteIp;
  if ($('editPeerProxyProtocol')) {
    $('editPeerProxyProtocol').checked = (p.proxy_protocol === 'v2');
  }
  if ($('editPeerFRPTransport')) {
    $('editPeerFRPTransport').value = p.frp_transport || 'tcp';
  }
  if ($('editPeerEncryption')) {
    $('editPeerEncryption').checked = !!p.use_encryption;
  }
  if ($('editPeerCompression')) {
    $('editPeerCompression').checked = !!p.use_compression;
  }
  if ($('editPeerEngine')) {
    $('editPeerEngine').value = engine;
    const isBh = engine === 'backhaul';
    if ($('wrapEditTransport')) $('wrapEditTransport').classList.toggle('hidden', engine === 'frp');
    if ($('wrapEditFRPTransport')) $('wrapEditFRPTransport').classList.toggle('hidden', engine !== 'frp');
    if ($('wrapEditCarrier')) $('wrapEditCarrier').classList.toggle('hidden', isBh);
    $('editPeerEngine').onchange = () => {
      const eng = $('editPeerEngine').value;
      if ($('wrapEditTransport')) $('wrapEditTransport').classList.toggle('hidden', eng === 'frp');
      if ($('wrapEditFRPTransport')) $('wrapEditFRPTransport').classList.toggle('hidden', eng !== 'frp');
      if ($('wrapEditCarrier')) $('wrapEditCarrier').classList.toggle('hidden', eng === 'backhaul');
    };
  }
  if ($('editPeerTransport')) $('editPeerTransport').value = transport;
  if ($('editPeerCarrier')) {
    const sel = $('editPeerCarrier');
    let matched = false;
    for (let opt of sel.options) {
      if (opt.value === carrier) { opt.selected = true; matched = true; break; }
    }
    if (!matched) {
      if (/wss/i.test(carrier)) sel.value = 'wss:8443';
      else sel.value = 'direct';
    }
  }
  if ($('editPortsNew'))  $('editPortsNew').value = '';
  if ($('editPortsWarn')) $('editPortsWarn').classList.add('hidden');

  renderEditPortsChips();
  if (_editModalRelease) _editModalRelease();
  _editModalRelease = trapModal(modal, closeEditPorts);
  modal.hidden = false;
  if ($('editPeerName')) $('editPeerName').focus();
}

function openEditPorts(peerId, peerName, currentPorts) {
  openEditPeer(peerId);
}

let _editModalRelease = null;
function closeEditPorts() {
  const modal = $('editPortsModal');
  if (modal) modal.hidden = true;
  if (_editModalRelease) { const r = _editModalRelease; _editModalRelease = null; r(); }
}

function renderEditPortsChips() {
  const box = $('editPortsChips');
  if (!box) return;
  if (!_editPortsList.length) {
    box.innerHTML = '<span style="color:var(--dim);font-size:12px">No ports \u2014 add one below.</span>';
    return;
  }
  box.innerHTML = _editPortsList.map(p =>
    `<span style="display:inline-flex;align-items:center;gap:4px;background:var(--s2);border:1px solid var(--ln);border-radius:8px;padding:4px 10px;font-size:13px;font-weight:600;font-variant-numeric:tabular-nums">` +
    esc(String(p)) +
    `<button type="button" onclick="removeEditPort('${esc(String(p))}')" title="Remove port ${esc(String(p))}" ` +
    `style="background:none;border:none;color:var(--er);cursor:pointer;padding:0 0 0 4px;font-size:14px;line-height:1;display:inline-flex">\u00d7</button></span>`
  ).join('');
}

function removeEditPort(port) {
  _editPortsList = _editPortsList.filter(p => String(p) !== String(port));
  renderEditPortsChips();
}

function addEditPort() {
  const inp    = $('editPortsNew');
  const warnEl = $('editPortsWarn');
  const val    = inp.value.trim();
  warnEl.classList.add('hidden');
  const portRe = /^(\d{1,5}|\d{1,5}-\d{1,5}|\d{1,5}=\d{1,5})$/;
  if (!portRe.test(val)) {
    warnEl.textContent = 'Enter a valid port (e.g. 8080), range (10000-10050), or mapping (2083=8443).';
    warnEl.classList.remove('hidden');
    inp.focus();
    return;
  }
  if (val.includes('-')) {
    const [s, e] = val.split('-').map(Number);
    if (s < 1 || s > 65535 || e < 1 || e > 65535 || s >= e) {
      warnEl.textContent = 'Invalid port range: start must be less than end (1-65535).';
      warnEl.classList.remove('hidden');
      inp.focus();
      return;
    }
  } else if (val.includes('=')) {
    const [s, e] = val.split('=').map(Number);
    if (s < 1 || s > 65535 || e < 1 || e > 65535) {
      warnEl.textContent = 'Invalid port mapping: ports must be 1-65535.';
      warnEl.classList.remove('hidden');
      inp.focus();
      return;
    }
  } else {
    const n = Number(val);
    if (n < 1 || n > 65535) {
      warnEl.textContent = 'Port must be between 1 and 65535.';
      warnEl.classList.remove('hidden');
      inp.focus();
      return;
    }
  }
  if (_editPortsList.includes(val)) {
    warnEl.textContent = 'Port/range "' + val + '" is already in the list.';
    warnEl.classList.remove('hidden');
    inp.focus();
    return;
  }
  _editPortsList.push(val);
  inp.value = '';
  renderEditPortsChips();
  inp.focus();
}

async function saveEditPorts() {
  const warnEl = $('editPortsWarn');
  warnEl.classList.add('hidden');
  if (!_editPortsList.length) {
    warnEl.textContent = 'You must keep at least one port.';
    warnEl.classList.remove('hidden');
    return;
  }

  const nameVal      = $('editPeerName') ? $('editPeerName').value.trim() : '';
  const remoteVal    = $('editPeerRemote') ? $('editPeerRemote').value.trim() : '';
  const carrierVal   = $('editPeerCarrier') ? $('editPeerCarrier').value : '';
  const engineVal    = $('editPeerEngine') ? $('editPeerEngine').value : '';
  const transportVal = $('editPeerTransport') ? $('editPeerTransport').value : '';
  const ppVal        = $('editPeerProxyProtocol') && $('editPeerProxyProtocol').checked ? 'v2' : 'off';
  const frpTransVal  = $('editPeerFRPTransport') ? $('editPeerFRPTransport').value : 'tcp';
  const encVal       = $('editPeerEncryption') && $('editPeerEncryption').checked;
  const compVal      = $('editPeerCompression') && $('editPeerCompression').checked;

  if (remoteVal) {
    const parts = remoteVal.split('.');
    const valid = parts.length === 4 && parts.every(p => {
      const n = parseInt(p, 10);
      return !isNaN(n) && n >= 0 && n <= 255 && String(n) === p;
    });
    if (!valid) {
      warnEl.textContent = 'Enter a valid IPv4 address for Remote Public IP.';
      warnEl.classList.remove('hidden');
      return;
    }
  }

  const btn  = $('editPortsSave');
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="ent-spinner"></span> Saving\u2026';
  try {
    const payload = {
      id: _editPortsPeerId,
      ports: _editPortsList.join(', ')
    };
    if (nameVal) payload.name = nameVal;
    if (remoteVal) payload.remote_pub = remoteVal;
    if (carrierVal) payload.carrier = carrierVal;
    if (engineVal) payload.engine = engineVal;
    if (transportVal) payload.transport = transportVal;
    if (ppVal) payload.proxy_protocol = ppVal;
    if (frpTransVal) payload.frp_transport = frpTransVal;
    payload.use_encryption = encVal;
    payload.use_compression = compVal;

    const res = await api('/api/peers', payload, 'PATCH');
    if (res && res.bundle) {
      _editPeerBundle = res.bundle;
    }
    if (res && res.warning) {
      toastWarn('Saved with note', res.warning);
    } else {
      toastOk('Tunnel updated', 'Tunnel configuration saved \u2014 changes take effect immediately.');
    }
    closeEditPorts();
    refresh();
  } catch(e) {
    warnEl.textContent = e.message || 'Save failed.';
    warnEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

async function copyEditPeerBundle() {
  if (_editPeerBundle) {
    (navigator.clipboard ? navigator.clipboard.writeText(_editPeerBundle) : Promise.reject())
      .then(() => toastOk('Bundle copied', 'Setup bundle copied to clipboard.'))
      .catch(() => toastWarn('Copy failed', _editPeerBundle));
    return;
  }
  if (_editPortsPeerId !== null && _editPortsPeerId > 0) {
    try {
      const r = await api('/api/peers?id=' + _editPortsPeerId);
      const b = r.bundle || r.token || '';
      if (b) {
        _editPeerBundle = b;
        (navigator.clipboard ? navigator.clipboard.writeText(b) : Promise.reject())
          .then(() => toastOk('Bundle copied', 'Setup bundle copied to clipboard.'))
          .catch(() => toastWarn('Copy bundle', b));
        return;
      }
    } catch(e) { reportErr('bundle', e); }
  }
  toast('Save changes first to generate an updated bundle.');
}

function editPeerPortsClick(peerId) {
  openEditPeer(peerId);
}

function editMainPortsClick() {
  openEditPeer(0);
}

// Wire up modal buttons
(function initEditPortsModal() {
  function on(id, ev, fn) { const el = $(id); if (el) el.addEventListener(ev, fn); }
  on('editPortsClose',         'click', closeEditPorts);
  on('editPortsCancel',        'click', closeEditPorts);
  on('editPortsSave',          'click', saveEditPorts);
  on('editPortsAddBtn',        'click', addEditPort);
  on('editPeerCopyBundleBtn',  'click', copyEditPeerBundle);
  on('editPortsNew', 'keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addEditPort(); } });
  const ov = $('editPortsModal');
  if (ov) ov.addEventListener('click', e => { if (e.target === ov) closeEditPorts(); });
})();

// ---------- Benchmark & Peer Link (tab-benchmark) ----------
let benchData = null;
let peerData = null;
let benchRunning = false;

async function loadBenchmark(forceRun = false) {
  let benchErr = null;
  const _tb = $('benchTableBody');
  if (_tb && !(benchData && benchData.metrics && benchData.metrics.length)) _tb.innerHTML = '<tr><td colspan="10">' + skel(3) + '</td></tr>';
  try {
    if (forceRun) {
      benchData = await api('/api/benchmark/run');
    } else {
      benchData = await api('/api/benchmark');
    }
  } catch (err) {
    benchErr = err;
    reportErr('benchmark', err);
  }

  try {
    peerData = await api('/api/peer/status');
  } catch (err) {
    reportErr('peerlink', err);
  }

  renderBenchmark(benchData, peerData);
  if (benchErr && !(benchData && benchData.metrics && benchData.metrics.length) && _tb) {
    _tb.innerHTML = '<tr><td colspan="10" class="u-text-center">' + stateError(benchErr.message, 'benchmark', true) + '</td></tr>';
  }
}

function renderBenchmark(bench, peer) {
  // Render Peer Link Status
  if (peer) {
    const isConn = peer.is_connected;
    const badge = $('peerLinkBadge');
    if (badge) {
      badge.className = 'badge ' + (isConn ? 'ok' : 'err');
      badge.textContent = isConn ? 'Connected' : (peer.peer_url ? 'Unreachable' : 'Unpaired');
    }
    if ($('peerRoleVal')) $('peerRoleVal').textContent = (peer.role === 'master' ? 'Master (Iran)' : 'Worker (Kharej)');
    if ($('peerUrlVal')) $('peerUrlVal').textContent = peer.peer_url || '—';
    if ($('peerInternalVal')) $('peerInternalVal').textContent = peer.internal_ip || '—';
    if ($('peerLatencyVal')) $('peerLatencyVal').textContent = (peer.latency_ms > 0 ? peer.latency_ms.toFixed(1) + ' ms' : '—');
    if ($('peerLastSyncVal')) $('peerLastSyncVal').textContent = peer.last_sync || 'Never';

    // Automatic Failover Policy
    if ($('autoPilotToggle')) $('autoPilotToggle').checked = !!peer.autopilot;
    if ($('autoPilotThresholdInput')) $('autoPilotThresholdInput').value = peer.threshold || 20;
    if ($('autoPilotBadge')) {
      const b = $('autoPilotBadge');
      b.className = 'badge ' + (peer.autopilot ? 'warn' : 'dim');
      b.textContent = peer.autopilot ? '[ ON ] Auto-Switching' : '[ OFF ] Manual Mode';
    }
  }

  if (bench && bench.metrics && bench.metrics.length > 0) {
    const winner = bench.metrics.find(m => m.is_recommended) || bench.metrics[0];
    const active = bench.metrics.find(m => m.is_active) || { name: bench.active_carrier || 'Direct GRE', id: bench.active_carrier || 'direct' };
    const minRtt = bench.metrics.reduce((acc, m) => (m.avg_rtt_ms > 0 && (acc === 0 || m.avg_rtt_ms < acc)) ? m.avg_rtt_ms : acc, 0);

    const winnerName = winner ? (winner.name || winner.id).replace(/\s*\(.*?\)/, '') : '—';
    const activeName = active ? (active.name || active.id).replace(/\s*\(.*?\)/, '') : '—';

    if ($('benchStatWinner')) $('benchStatWinner').textContent = winnerName;
    if ($('benchStatWinnerSub')) $('benchStatWinnerSub').textContent = winner ? `Score: ${winner.score}/100 · ${winner.avg_rtt_ms} ms` : 'Top candidate';
    if ($('benchStatActive')) $('benchStatActive').textContent = activeName;
    if ($('benchStatActiveSub')) $('benchStatActiveSub').textContent = tr('x031', "Active route");
    if ($('benchStatMinRtt')) $('benchStatMinRtt').textContent = minRtt > 0 ? `${minRtt.toFixed(1)} ms` : (winner && winner.avg_rtt_ms > 0 ? `${winner.avg_rtt_ms} ms` : '—');
    if ($('benchStatMinRttSub')) $('benchStatMinRttSub').textContent = tr('x032', "Best round-trip");
    if ($('benchStatLoss')) $('benchStatLoss').textContent = winner ? `${winner.packet_loss}%` : '0%';
    if ($('benchStatLossSub')) $('benchStatLossSub').textContent = (winner && winner.packet_loss === 0) ? (tr('x033', "Zero loss link")) : (tr('x034', "Packet drop rate"));

    if ($('benchMetaSub')) {
      $('benchMetaSub').textContent = `${tr('x035', "Last benchmark")}: ${bench.timestamp || '—'} · ${bench.metrics.length} ${tr('x036', "candidates probed")}`;
    }
  }

  if (bench && bench.auto_pilot) {
    if ($('autoPilotLastVal')) $('autoPilotLastVal').textContent = bench.auto_pilot.last_triggered || (tr('x037', "None"));
    if ($('autoPilotCountVal')) $('autoPilotCountVal').textContent = bench.auto_pilot.trigger_count || 0;
  }

  // Render Table
  const tbody = $('benchTableBody');
  if (!tbody) return;

  if (!bench || !bench.metrics || bench.metrics.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" class="u-text-center">${stateEmpty({ title: tr('empty_bench_title', 'No benchmark metrics yet'), msg: tr('empty_bench_msg', 'Run a carrier benchmark to compare protocols.'), actionKey: 'runbench', actionLabel: tr('bench_run_btn', 'Run Carrier Benchmark'), compact: true })}</td></tr>`;
    return;
  }

  let html = '';
  bench.metrics.forEach((m, idx) => {
    const isWinner = !!m.is_recommended;
    const isActive = !!m.is_active;

    let statusClass = 'dim';
    let statusLabel = m.status;
    if (m.status === 'healthy') {
      statusClass = 'ok';
      statusLabel = tr('x039', "Healthy");
    } else if (m.status === 'good') {
      statusClass = 'info';
      statusLabel = tr('x040', "Good");
    } else if (m.status === 'warning') {
      statusClass = 'warn';
      statusLabel = tr('x041', "Warning");
    } else if (m.status === 'critical' || m.status === 'down') {
      statusClass = 'err';
      statusLabel = tr('x042', "Down");
    }

    let lossClass = 'ok';
    if (m.packet_loss > 0 && m.packet_loss <= 15) lossClass = 'warn';
    else if (m.packet_loss > 15) lossClass = 'err';

    const rank = idx + 1;
    const rankBadge = `<span class="bench-rank-num ${rank === 1 ? 'bench-rank-1' : ''}">${rank}</span>`;

    const cleanName = (m.name || m.id).replace(/\s*\(.*?\)/, '');
    const cleanSub = m.name && m.name.includes('(') ? m.name.match(/\((.*?)\)/)[1] : '';

    const portStr = m.port > 0 ? m.port : (tr('x043', "Raw 47"));

    // Protocol badge styling
    let protoPill = `<span class="bench-proto-pill dim">${esc(m.type.toUpperCase())}</span>`;
    const tLower = (m.type || '').toLowerCase();
    if (tLower === 'gre') {
      protoPill = `<span class="bench-proto-pill u-pill-sky">GRE KERNEL</span>`;
    } else if (tLower === 'frp_tcp') {
      protoPill = `<span class="bench-proto-pill" style="background:rgba(59,130,246,0.15);color:#60a5fa;border:1px solid rgba(59,130,246,0.3)">TCP MUX</span>`;
    } else if (tLower === 'frp_kcp') {
      protoPill = `<span class="bench-proto-pill" style="background:rgba(245,158,11,0.15);color:#fbbf24;border:1px solid rgba(245,158,11,0.3)">KCP ARQ</span>`;
    } else if (tLower === 'frp_quic') {
      protoPill = `<span class="bench-proto-pill u-pill-violet">QUIC UDP</span>`;
    } else if (tLower === 'frp_ws') {
      protoPill = `<span class="bench-proto-pill" style="background:rgba(20,184,166,0.15);color:#2dd4bf;border:1px solid rgba(20,184,166,0.3)">WEBSOCKET</span>`;
    } else if (tLower === 'wss') {
      protoPill = `<span class="bench-proto-pill" style="background:rgba(16,185,129,0.15);color:#34d399;border:1px solid rgba(16,185,129,0.3)">WSS TLS</span>`;
    } else if (tLower.includes('backhaul')) {
      protoPill = `<span class="bench-proto-pill info">BACKHAUL</span>`;
    }

    const rowBg = isActive
      ? 'background:rgba(56,189,248,0.06);'
      : (isWinner ? 'background:rgba(16,185,129,0.03);' : '');

    html += `<tr class="${isActive ? 'row-active' : ''}" style="${rowBg}">
      <td style="text-align:center;width:44px;">${rankBadge}</td>
      <td>
        <div class="u-flex-center-gap8">
          <strong style="color:var(--tx);font-size:13.5px;">${esc(cleanName)}</strong>
          ${isActive ? `<span class="badge ok" style="font-size:12px;padding:2px 6px;">${tr('x044', "ACTIVE")}</span>` : ''}
          ${isWinner ? `<span class="badge info" style="font-size:12px;padding:2px 6px;">${tr('x045', "BEST")}</span>` : ''}
        </div>
        ${cleanSub ? `<div style="font-size:12px;color:var(--mu);margin-top:2px;">${esc(cleanSub)}</div>` : ''}
      </td>
      <td>${protoPill}</td>
      <td><code class="mono" style="font-size:12px;background:rgba(255,255,255,0.04);padding:3px 7px;border-radius:4px;border:1px solid rgba(255,255,255,0.05);">${portStr}</code></td>
      <td><span style="font-weight:700;font-family:var(--font-mono);font-size:13px;color:var(--tx);">${m.avg_rtt_ms > 0 ? m.avg_rtt_ms + ' ms' : '—'}</span></td>
      <td><span class="badge ${lossClass}" style="font-size:12px;font-weight:700;">${m.packet_loss}%</span></td>
      <td><span style="color:var(--mu);font-size:12px;font-family:var(--font-mono);">${m.jitter_ms > 0 ? m.jitter_ms + ' ms' : '—'}</span></td>
      <td>
        <div class="bench-score-bar-wrap">
          <div class="bench-score-track">
            <div class="bench-score-fill" style="width:${Math.max(4, m.score)}%;background:${m.score >= 70 ? 'linear-gradient(90deg, #10b981, #34d399)' : (m.score >= 40 ? 'linear-gradient(90deg, #f59e0b, #fbbf24)' : 'linear-gradient(90deg, #ef4444, #f87171)')};box-shadow:0 0 8px ${m.score >= 70 ? 'rgba(16,185,129,0.35)' : 'rgba(239,68,68,0.35)'};"></div>
          </div>
          <strong style="font-size:12px;font-family:var(--font-mono);min-width:26px;color:var(--tx);">${m.score}</strong>
        </div>
      </td>
      <td><span class="badge ${statusClass} u-fs-12">${esc(statusLabel)}</span></td>
      <td>
        ${isActive ? `<button class="hashem-btn hashem-btn-ghost u-btn-xs" disabled style="opacity:0.65;font-weight:600;padding:5px 12px;">${tr('x046', "Current")}</button>` :
          `<button class="hashem-btn ${isWinner ? 'hashem-btn-primary' : 'hashem-btn-secondary'} u-btn-xs" style="font-weight:600;padding:5px 12px;" onclick="applyCarrierClick('${esc(m.id)}')">${tr('x047', "Switch")}</button>`}
      </td>
    </tr>`;
  });

  tbody.innerHTML = html;
}

async function runBenchmarkClick() {
  if (benchRunning) return;
  benchRunning = true;
  const btn = $('benchRunBtn');
  const txt = $('benchRunBtnTxt');
  if (btn) btn.disabled = true;
  if (txt) txt.textContent = tr('x048', "Probing carriers...");
  toast(tr('x049', "Benchmarking carriers"), tr('x050', "Probing GRE, WSS, TCP, KCP, QUIC, and WS..."));

  try {
    await loadBenchmark(true);
    toastOk(tr('x051', "Benchmark Complete"), `${tr('x052', "Best Carrier")}: ${benchData ? (benchData.best_carrier || '—') : '—'}`);
  } catch (err) {
    toastErr(tr('x053', "Benchmark failed"), err.message || err);
  } finally {
    benchRunning = false;
    if (btn) btn.disabled = false;
    if (txt) txt.textContent = tr('bench_run_btn', 'Run Carrier Benchmark');
  }
}

async function applyCarrierClick(carrierId) {
  const confirmMsg = tr('carrier_switch_confirm', 'Switch both Iran & Foreign servers to carrier "{id}"?').replace('{id}', carrierId);
  if (!confirm(confirmMsg)) return;
  toast(tr('x054', "Applying carrier"), `${carrierId}...`);
  try {
    const res = await api('/api/benchmark/apply', { carrier: carrierId });
    toastOk(tr('x055', "Carrier Applied"), res.detail || `Active carrier is now ${carrierId}`);
    await loadBenchmark();
  } catch (err) {
    toastErr(tr('x056', "Apply failed"), err.message || err);
  }
}

async function testPeerLinkClick() {
  toast('Testing link', 'Sending probe to peer...');
  try {
    const res = await api('/api/peer/config', { action: 'test' });
    if (res.reachable) {
      toastOk('Peer reachable', `Round-trip latency: ${res.latency_ms.toFixed(1)} ms`);
    } else {
      toastWarn('Peer unreachable', 'Could not establish connection to remote peer.');
    }
    await loadBenchmark();
  } catch (err) {
    toastErr('Peer probe failed', err.message || err);
  }
}

async function saveAutoPilotClick() {
  const btn = $('autoPilotSaveBtn');
  const enabled = $('autoPilotToggle') ? $('autoPilotToggle').checked : false;
  const thresh = $('autoPilotThresholdInput') ? parseFloat($('autoPilotThresholdInput').value) || 20 : 20;

  setBtnLoading(btn, true, 'Saving…');
  try {
    await api('/api/benchmark/autopilot', { enabled: enabled, threshold: thresh });
    toastOk('Failover Policy Saved', enabled ? `Automatic Failover is now ON (threshold: ${thresh}%)` : 'Automatic Failover is OFF (Manual Mode)');
    await loadBenchmark();
  } catch (err) {
    toastErr('Failed to save Failover Policy', err.message || err);
  } finally {
    setBtnLoading(btn, false);
  }
}

function openPeerConfig() {
  const card = $('peerConfigCard');
  if (!card) return;
  card.classList.remove('hidden');
  if (peerData) {
    if ($('cfgPeerRole')) $('cfgPeerRole').value = peerData.role || 'master';
    if ($('cfgPeerUrl')) $('cfgPeerUrl').value = peerData.peer_url || '';
    if ($('cfgPeerInternal')) $('cfgPeerInternal').value = peerData.internal_ip || '';
  }
}

function closePeerConfig() {
  const card = $('peerConfigCard');
  if (card) card.classList.add('hidden');
}

async function savePeerConfigClick() {
  const role = $('cfgPeerRole') ? $('cfgPeerRole').value : 'master';
  const url = $('cfgPeerUrl') ? $('cfgPeerUrl').value.trim() : '';
  const internal = $('cfgPeerInternal') ? $('cfgPeerInternal').value.trim() : '';
  const secret = $('cfgPeerSecret') ? $('cfgPeerSecret').value.trim() : '';

  try {
    const payload = { role, peer_url: url, internal_ip: internal };
    if (secret) payload.peer_secret = secret;
    await api('/api/peer/config', payload);
    toastOk('Peer Config Saved', 'Remote link configuration updated.');
    closePeerConfig();
    await loadBenchmark();
  } catch (err) {
    toastErr('Save failed', err.message || err);
  }
}

// Wire up events
(function initBenchmarkEvents() {
  function on(id, ev, fn) { const el = $(id); if (el) el.addEventListener(ev, fn); }
  on('benchRunBtn', 'click', runBenchmarkClick);
  on('peerTestBtn', 'click', testPeerLinkClick);
  on('peerConfigBtn', 'click', openPeerConfig);
  on('peerConfigCloseBtn', 'click', closePeerConfig);
  on('cfgPeerSaveBtn', 'click', savePeerConfigClick);
  on('autoPilotSaveBtn', 'click', saveAutoPilotClick);
})();

// ---------- SSH Forward Carrier (tab-sshfwd) ----------
let _sshfwdData = null;

let lastBagherBytesRx = 0, lastBagherBytesTx = 0, lastBagherTime = 0;
function formatSpeedRate(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return '0 B/s';
  const k = 1024;
  const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  const i = Math.min(Math.floor(Math.log(bytesPerSec) / Math.log(k)), sizes.length - 1);
  return (bytesPerSec / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
}

async function loadSSHFwd() {
  try {
    _sshfwdData = await api('/api/sshfwd');
    renderSSHFwd();
  } catch (err) {
    reportErr('sshfwd', err);
  }
}

let _bagherUserPickedRole = null;

function setBagherRole(role) {
  _bagherUserPickedRole = role;
  const iran = role === 'iran';
  if ($('bagherRoleIran')) $('bagherRoleIran').setAttribute('aria-pressed', iran ? 'true' : 'false');
  if ($('bagherRoleForeign')) $('bagherRoleForeign').setAttribute('aria-pressed', !iran ? 'true' : 'false');
  if ($('bagherRoleInput')) $('bagherRoleInput').value = role;
  if ($('bagherIranWrap')) $('bagherIranWrap').hidden = !iran;
  if ($('bagherForeignWrap')) $('bagherForeignWrap').hidden = iran;
  if ($('bagherActiveRoleBadge')) {
    $('bagherActiveRoleBadge').textContent = 'Role: ' + (iran ? 'Iran Server' : 'Foreign Server');
  }
  if ($('bagherRoleHint')) {
    $('bagherRoleHint').textContent = iran
      ? 'Iran server receives inbound user traffic, listens on forwarded ports, and securely multiplexes to the Foreign server.'
      : 'Foreign server runs outbound proxy/services, terminates stealth multiplexed tunnels, and processes traffic.';
  }
}

function renderSSHFwd() {
  const d = _sshfwdData || {};
  const active = !!(d.is_active || d.enabled);
  const badge = $('sshfwdStatusBadge');
  const toggleBtn = $('sshfwdToggleBtn');

  if (badge) {
    badge.className = 'badge ' + (active ? 'ok' : 'info');
    badge.textContent = active ? (d.connected ? 'Active' : 'Standby / Ready') : 'Inactive';
  }
  if (toggleBtn) {
    toggleBtn.textContent = active ? 'Disable' : 'Enable';
    toggleBtn.className = 'hashem-btn ' + (active ? 'hashem-btn-danger' : 'hashem-btn-primary');
  }

  // Server role rendering
  const serverRole = d.role === 'foreign' ? 'foreign' : 'iran';
  if (!_bagherUserPickedRole) {
    setBagherRole(serverRole);
  } else {
    setBagherRole(_bagherUserPickedRole);
  }

  const iranApplyBtn = $('bagherIranApplyBtn');
  const iranStopBtn = $('bagherIranStopBtn');
  const foreignConnectBtn = $('bagherForeignConnectBtn');
  const foreignStopBtn = $('bagherForeignStopBtn');

  if (active) {
    if (iranApplyBtn) iranApplyBtn.textContent = '🔄 Update Iran Server & Re-issue Bundle';
    if (iranStopBtn) iranStopBtn.classList.remove('hidden');
    if (foreignConnectBtn) foreignConnectBtn.textContent = '🔄 Update Foreign Connection';
    if (foreignStopBtn) foreignStopBtn.classList.remove('hidden');
  } else {
    if (iranApplyBtn) iranApplyBtn.textContent = '🚀 Initialize Iran Server & Issue Bundle';
    if (iranStopBtn) iranStopBtn.classList.add('hidden');
    if (foreignConnectBtn) foreignConnectBtn.textContent = '⚡ Connect to Iran & Start Foreign Tunnel';
    if (foreignStopBtn) foreignStopBtn.classList.add('hidden');
  }

  // Live health & metrics
  const connBadge = $('bagherConnBadge');
  if (connBadge) {
    if (d.connected) {
      connBadge.className = 'badge ok';
      connBadge.textContent = 'Connected (Online)';
      connBadge.style.background = '#10b981';
      connBadge.style.color = '#fff';
    } else if (active) {
      connBadge.className = 'badge warn';
      connBadge.textContent = d.role === 'foreign' ? 'Connecting to Iran...' : 'Ready (Waiting for Peer)';
      connBadge.style.background = '#f59e0b';
      connBadge.style.color = '#000';
    } else {
      connBadge.className = 'badge info';
      connBadge.textContent = 'Inactive (Offline)';
      connBadge.style.background = 'rgba(255,255,255,0.1)';
      connBadge.style.color = '';
    }
  }
  if ($('bagherRoleTxt')) {
    $('bagherRoleTxt').textContent = 'Role: ' + (d.role === 'foreign' ? 'Foreign Server' : 'Iran Server');
  }
  if ($('bagherLatencyVal')) {
    $('bagherLatencyVal').textContent = (typeof d.latency_ms === 'number' && d.latency_ms > 0) ? (d.latency_ms.toFixed(1) + ' ms') : '—';
  }
  if ($('bagherLivePing')) {
    if (active) {
      $('bagherLivePing').textContent = (typeof d.latency_ms === 'number' && d.latency_ms > 0) ? (d.latency_ms.toFixed(1) + ' ms') : 'Optimal';
    } else {
      $('bagherLivePing').textContent = 'Standby';
    }
  }
  if ($('bagherTrafficTotal')) {
    $('bagherTrafficTotal').textContent = d.total_formatted || '0 B';
  }
  if ($('bagherTrafficUpDown')) {
    $('bagherTrafficUpDown').textContent = `↓ ${d.rx_formatted || '0 B'}  ↑ ${d.tx_formatted || '0 B'}`;
  }
  const now = Date.now();
  let rxSpeedStr = '0 B/s', txSpeedStr = '0 B/s';
  const curRx = typeof d.rx_bytes === 'number' ? d.rx_bytes : 0;
  const curTx = typeof d.tx_bytes === 'number' ? d.tx_bytes : 0;
  if (lastBagherTime && now > lastBagherTime) {
    const deltaSec = (now - lastBagherTime) / 1000;
    if (deltaSec >= 0.5) {
      if (curRx >= lastBagherBytesRx) rxSpeedStr = formatSpeedRate((curRx - lastBagherBytesRx) / deltaSec);
      if (curTx >= lastBagherBytesTx) txSpeedStr = formatSpeedRate((curTx - lastBagherBytesTx) / deltaSec);
    }
  }
  lastBagherBytesRx = curRx;
  lastBagherBytesTx = curTx;
  lastBagherTime = now;

  if ($('bagherLiveSpeed')) {
    $('bagherLiveSpeed').textContent = `↓ ${rxSpeedStr}  ↑ ${txSpeedStr}`;
  }
  if ($('bagherLiveTotal')) {
    $('bagherLiveTotal').textContent = d.total_formatted || '0 B';
  }
  if ($('bagherLiveSockets')) {
    if (active) {
      $('bagherLiveSockets').textContent = (d.pool_count || 25) + ' Active';
    } else {
      $('bagherLiveSockets').textContent = `0 Active (Pool: ${d.pool_count || 25})`;
    }
  }
  if ($('bagherConnsVal')) {
    $('bagherConnsVal').textContent = String(d.cur_conns || 0);
  }
  if ($('bagherBundleText')) {
    $('bagherBundleText').value = d.bundle || '';
  }

  // Inputs: do not force default values; keep empty placeholders unless saved
  if ($('sshfwdRemoteHost') && !$('sshfwdRemoteHost').value && d.remote_host) $('sshfwdRemoteHost').value = d.remote_host;
  if ($('sshfwdRemoteUser') && !$('sshfwdRemoteUser').value && d.remote_user) $('sshfwdRemoteUser').value = d.remote_user;
  if ($('sshfwdRemotePort') && !$('sshfwdRemotePort').value && d.remote_ssh_port > 0) $('sshfwdRemotePort').value = d.remote_ssh_port;
  if ($('sshfwdPorts') && !$('sshfwdPorts').value && Array.isArray(d.ports) && d.ports.length > 0) $('sshfwdPorts').value = d.ports.join(', ');

  const modeEl = $('sshfwdMode');
  if (modeEl) modeEl.value = 'bagher';
  if ($('sshfwdPoolCount') && !$('sshfwdPoolCount').value && d.pool_count > 0) $('sshfwdPoolCount').value = d.pool_count;
  if ($('sshfwdFRPPort') && !$('sshfwdFRPPort').value && d.frp_bind_port > 0) $('sshfwdFRPPort').value = d.frp_bind_port;

  const foreignCmd = $('sshfwdForeignCmd');
  if (foreignCmd) foreignCmd.value = d.foreign_setup_cmd || '';

  const authLine = $('sshfwdAuthLine');
  if (authLine) authLine.value = d.auth_line || '';

  const isLicensed = isBagherLicensed();
  const bagherContainer = $('bagherCardContainer');
  const bagherLockedBanner = $('bagherLockedBanner');
  const bagherModal = $('bagherLicModal');
  const bagherMachineHash = $('bagherLicMachineHash');

  if (bagherMachineHash && (d.machine_hash || (_licenseData && _licenseData.machine_hash))) {
    bagherMachineHash.value = d.machine_hash || _licenseData.machine_hash;
  }

  if (!isLicensed) {
    if (bagherContainer) {
      bagherContainer.style.filter = 'blur(10px)';
      bagherContainer.style.pointerEvents = 'none';
      bagherContainer.style.opacity = '0.2';
      bagherContainer.style.userSelect = 'none';
    }
    if (bagherLockedBanner) {
      bagherLockedBanner.classList.remove('hidden');
    }
    if (state && state.tab === 'sshfwd' && bagherModal && bagherModal.hidden && !_bagherModalDismissed) {
      bagherModal.hidden = false;
    }
  } else {
    _bagherModalDismissed = true;
    if (bagherContainer) {
      bagherContainer.style.filter = '';
      bagherContainer.style.pointerEvents = '';
      bagherContainer.style.opacity = '';
      bagherContainer.style.userSelect = '';
    }
    if (bagherLockedBanner) {
      bagherLockedBanner.classList.add('hidden');
    }
    if (bagherModal) {
      bagherModal.hidden = true;
    }
  }
}

// Universal Clipboard Copy with legacy execCommand and prompt fallbacks
function copyTextSafe(text, title, msg) {
  if (!text) {
    toastErr('Copy Error', 'No text to copy.');
    return;
  }
  const fallback = () => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '0';
      ta.setAttribute('readonly', '');
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, 999999);
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (ok) {
        toastOk(title || 'Copied', msg || 'Copied to clipboard successfully.');
        return;
      }
    } catch (e) {
      console.warn('execCommand copy failed:', e);
    }
    window.prompt('Copy with Ctrl+C:', text);
  };

  if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    navigator.clipboard.writeText(text).then(() => {
      toastOk(title || 'Copied', msg || 'Copied to clipboard successfully.');
    }).catch(err => {
      console.warn('clipboard.writeText failed, using fallback:', err);
      fallback();
    });
  } else {
    fallback();
  }
}

let _bagherModalDismissed = false;

function openBagherLicModal() {
  _bagherModalDismissed = false;
  const m = $('bagherLicModal');
  if (m) m.hidden = false;
  const hashEl = $('bagherLicMachineHash');
  if (hashEl) {
    if (_licenseData && _licenseData.machine_hash) {
      hashEl.value = _licenseData.machine_hash;
    } else if (_sshfwdData && _sshfwdData.machine_hash) {
      hashEl.value = _sshfwdData.machine_hash;
    } else {
      api('/api/license').then(d => {
        if (d && d.machine_hash) hashEl.value = d.machine_hash;
      }).catch(() => {});
    }
  }
  const keyEl = $('bagherLicKeyInput');
  if (keyEl && !keyEl.value) {
    try {
      const saved = localStorage.getItem('hashem_bagher_license');
      if (saved) keyEl.value = saved;
    } catch (e) {}
  }
}

function closeBagherLicModal() {
  _bagherModalDismissed = true;
  const m = $('bagherLicModal');
  if (m) m.hidden = true;
}

function cancelBagherLicModal() {
  closeBagherLicModal();
  goTab('dashboard');
}

function openBagherLicenseSettings() {
  closeBagherLicModal();
  goTab('settings');
  setTimeout(() => {
    const el = $('licKeyInput') || $('licenseCard');
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (el.focus) el.focus();
    }
  }, 100);
}

async function activateBagherLicenseClick() {
  const keyEl = $('bagherLicKeyInput');
  const key = keyEl ? keyEl.value.trim() : '';
  if (!key) {
    toastErr('Empty Key', 'Please enter a valid license key.');
    return;
  }
  try {
    const res = await api('/api/license', { key });
    try { localStorage.setItem('hashem_bagher_license', key); } catch (e) {}
    toastOk('License Activated', 'Hashem Pro features unlocked successfully!');
    if (keyEl) keyEl.value = '';
    closeBagherLicModal();
    await loadLicense();
    await loadSSHFwd();
    goTab('sshfwd');
  } catch (err) {
    toastErr('Activation Failed', err.message || String(err));
  }
}

function bagherLicCopyMachineClick() {
  const t = $('bagherLicMachineHash');
  if (t && t.value) {
    copyTextSafe(t.value, 'Copied', 'Server machine hash copied to clipboard.');
  }
}

async function sshfwdToggleClick() {
  const d = _sshfwdData || {};
  const active = !!(d.is_active || d.enabled);
  if (!active) {
    const isLicensed = isBagherLicensed();
    if (!isLicensed) {
      openBagherLicModal();
      toastErr('License Required', 'Bagher Tunnel requires an active Hashem Pro license.');
      return;
    }
  }
  try {
    if (active) {
      await api('/api/sshfwd', { action: 'disable' });
      toastOk('Bagher Tunnel', 'Service stopped.');
    } else {
      const isLicensed = isBagherLicensed();
      if (!isLicensed) {
        openBagherLicModal();
        toastErr('License Required', 'Bagher Tunnel requires an active Hashem Pro license.');
        return;
      }
      const remote_host = $('sshfwdRemoteHost') ? $('sshfwdRemoteHost').value.trim() : '';
      const remote_user = $('sshfwdRemoteUser') ? $('sshfwdRemoteUser').value.trim() || 'root' : 'root';
      const ssh_port = parseInt($('sshfwdRemotePort') ? $('sshfwdRemotePort').value : '', 10) || 22;
      const ports = $('sshfwdPorts') ? $('sshfwdPorts').value.trim() : '';
      const mode = 'bagher';
      const pool_count = parseInt($('sshfwdPoolCount') ? $('sshfwdPoolCount').value : '', 10) || 25;
      const frp_bind_port = parseInt($('sshfwdFRPPort') ? $('sshfwdFRPPort').value : '', 10) || 55400;
      if (!remote_host) {
        toastErr('Foreign IP Required', 'Please enter the Foreign server IP address.');
        return;
      }
      if (!ports) {
        toastErr('Forwarded Ports Required', 'Please specify at least one port to forward (e.g. 443, 8443).');
        return;
      }
      await api('/api/sshfwd', { action: 'enable', mode, remote_host, remote_user, ssh_port, ports, pool_count, frp_bind_port });
      toastOk('Bagher Tunnel', 'Bagher Tunnel started successfully.');
    }
    await loadSSHFwd();
  } catch (err) {
    toastErr('Operation Failed', err.message || err);
  }
}

async function bagherIranApplyClick() {
  const d = _sshfwdData || {};
  const isLicensed = isBagherLicensed();
  if (!isLicensed) {
    openBagherLicModal();
    toastErr('License Required', 'Bagher Tunnel requires an active Hashem Pro license.');
    return;
  }
  const remote_host = $('sshfwdRemoteHost') ? $('sshfwdRemoteHost').value.trim() : '';
  const ports = $('sshfwdPorts') ? $('sshfwdPorts').value.trim() : '';
  if (!remote_host) {
    toastErr('Foreign IP Required', 'Please enter the Foreign server IP address.');
    if ($('sshfwdRemoteHost')) $('sshfwdRemoteHost').focus();
    return;
  }
  if (!ports) {
    toastErr('Forwarded Ports Required', 'Please specify at least one port to forward (e.g. 443, 8443).');
    if ($('sshfwdPorts')) $('sshfwdPorts').focus();
    return;
  }
  const remote_user = $('sshfwdRemoteUser') ? $('sshfwdRemoteUser').value.trim() || 'root' : 'root';
  const ssh_port = parseInt($('sshfwdRemotePort') ? $('sshfwdRemotePort').value : '', 10) || 22;
  const pool_count = parseInt($('sshfwdPoolCount') ? $('sshfwdPoolCount').value : '', 10) || 25;
  const frp_bind_port = parseInt($('sshfwdFRPPort') ? $('sshfwdFRPPort').value : '', 10) || 55400;

  try {
    toastOk('Initializing...', 'Configuring Iran service and generating connection bundle...');
    const res = await api('/api/sshfwd', {
      action: 'enable',
      mode: 'bagher',
      role: 'iran',
      remote_host,
      remote_user,
      ssh_port,
      ports,
      pool_count,
      frp_bind_port
    });
    if (res && res.bundle && $('bagherBundleText')) {
      $('bagherBundleText').value = res.bundle;
    }
    toastOk('Iran Server Ready', 'Iran service active. Connection bundle generated in Step 3.');
    await loadSSHFwd();
    if ($('bagherIranBundleCard')) {
      $('bagherIranBundleCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  } catch (err) {
    toastErr('Iran Setup Failed', err.message || err);
  }
}

async function bagherForeignConnectClick() {
  const d = _sshfwdData || {};
  let savedLic = '';
  try { savedLic = (localStorage.getItem('hashem_bagher_license') || '').trim(); } catch (e) {}
  let isLicensed = !!(d.licensed_bagher || d.licensed_frp_ssh || (_licenseData && _licenseData.is_valid) || savedLic);
  if (!isLicensed && savedLic) {
    try {
      await api('/api/license', { key: savedLic });
      isLicensed = true;
    } catch (e) {}
  }
  if (!isLicensed) {
    openBagherLicModal();
    toastErr('License Required', 'Bagher Engine requires an active premium license.');
    return;
  }
  const input = $('bagherPasteBundleInput');
  const bundle = input ? input.value.trim() : '';
  if (!bundle) {
    toastErr('Empty Bundle', 'Please paste the connection bundle received from the Iran server.');
    if (input) input.focus();
    return;
  }
  try {
    toastOk('Connecting...', 'Applying configuration and connecting Foreign server to Iran...');
    const res = await api('/api/sshfwd', { action: 'apply_bundle', bundle });
    toastOk('Foreign Connected', res.message || 'Foreign server connected to Iran successfully!');
    if (input) input.value = '';
    await loadSSHFwd();
  } catch (err) {
    toastErr('Connection Failed', err.message || String(err));
  }
}

async function bagherStopTunnelClick() {
  try {
    toastOk('Stopping...', 'Stopping Bagher tunnel services...');
    await api('/api/sshfwd', { action: 'disable' });
    toastOk('Tunnel Stopped', 'Bagher tunnel service disabled successfully.');
    await loadSSHFwd();
  } catch (err) {
    toastErr('Failed to Stop Tunnel', err.message || err);
  }
}

async function cleanBagherTunnelClick() {
  const ok = confirm('Clean and purge Bagher Tunnel?\n\nThis will stop and remove all Bagher systemd services (frps, frpc, ssh-fwd), delete systemd service units, remove generated frp configs, clear firewall rules, and reset the tunnel to initial state. The SSH keypair is preserved.');
  if (!ok) return;
  try {
    toastOk('Cleaning Tunnel', 'Purging Bagher services and configuration...');
    const res = await api('/api/sshfwd', { action: 'clean' });
    if (res && res.status === 'ok') {
      toastOk('Tunnel Cleaned', 'Bagher tunnel has been completely reset.');
      const bText = $('bagherBundleText'); if (bText) bText.value = '';
      const bPast = $('bagherPasteBundleInput'); if (bPast) bPast.value = '';
      await loadSSHFwd();
      if (typeof refreshDash === 'function') await refreshDash();
      if (typeof refreshTunnel === 'function') await refreshTunnel();
    } else {
      toastErr('Clean Failed', res ? res.message : 'Unknown error');
    }
  } catch (err) {
    toastErr('Clean Error', err.message || err);
  }
}

function bagherCopyBundleClick() {
  const t = $('bagherBundleText');
  const val = t ? t.value.trim() : '';
  if (!val) {
    toastErr('No Bundle', 'Please fill in Step 2 and click "Initialize Iran Server" first.');
    return;
  }
  copyTextSafe(val, 'Bundle Copied', 'Bagher connection bundle copied to clipboard. Paste into Foreign server panel.');
}

async function sshfwdApplyClick() {
  await bagherIranApplyClick();
}

async function bagherApplyBundleClick() {
  await bagherForeignConnectClick();
}

(function initSSHFwdEvents() {
  function on(id, ev, fn) { const el = $(id); if (el) el.addEventListener(ev, fn); }
  on('bagherRoleIran', 'click', () => setBagherRole('iran'));
  on('bagherRoleForeign', 'click', () => setBagherRole('foreign'));
  on('bagherIranApplyBtn', 'click', bagherIranApplyClick);
  on('bagherIranStopBtn', 'click', bagherStopTunnelClick);
  on('bagherIranCleanBtn', 'click', cleanBagherTunnelClick);
  on('bagherForeignConnectBtn', 'click', bagherForeignConnectClick);
  on('bagherForeignStopBtn', 'click', bagherStopTunnelClick);
  on('bagherForeignCleanBtn', 'click', cleanBagherTunnelClick);
  on('sshfwdClearDnatBtn', 'click', sshfwdClearDnatClick);
  on('sshfwdCopyAuthBtn', 'click', sshfwdCopyAuthClick);
  on('sshfwdCopyForeignBtn', 'click', sshfwdCopyForeignClick);
  on('bagherCopyBundleBtn', 'click', bagherCopyBundleClick);

  // License Modal events
  on('bagherLicModalClose', 'click', closeBagherLicModal);
  on('bagherLicCancelBtn', 'click', cancelBagherLicModal);
  on('bagherLicSubmitBtn', 'click', activateBagherLicenseClick);
  on('bagherLicCopyMachineBtn', 'click', bagherLicCopyMachineClick);
  on('bagherOpenLicModalBtn', 'click', openBagherLicModal);

  // Auto-select text on click
  ['bagherBundleText', 'sshfwdForeignCmd', 'sshfwdAuthLine', 'bagherLicMachineHash'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('click', () => { el.select(); });
  });

  // Periodic poll when on sshfwd tab
  setInterval(() => {
    const tab = $('tab-sshfwd');
    if (tab && !tab.hidden && document.visibilityState === 'visible') {
      loadSSHFwd();
    }
  }, 3500);
})();

/* --- License & Premium Feature Management --- */
let _licenseData = null;

async function loadLicense() {
  try {
    let d = await api('/api/license');
    if (!d || !d.is_valid) {
      let saved = null;
      try { saved = localStorage.getItem('hashem_bagher_license'); } catch (e) {}
      if (saved && saved.trim()) {
        try {
          const autoRes = await api('/api/license', { key: saved.trim() });
          if (autoRes && autoRes.status === 'ok') {
            d = await api('/api/license');
          }
        } catch (e) {}
      }
    }
    _licenseData = d;
    renderLicense(d);
  } catch (err) {
    console.warn('Failed loading license:', err);
  }
}

function renderLicense(d) {
  if (!d) return;
  if ($('licMachineHash')) $('licMachineHash').value = d.machine_hash || '';

  const badge = $('licBadge');
  const details = $('licActiveDetails');
  const deactBtn = $('licDeactivateBtn');
  const brandEls = document.querySelectorAll('.sidebar-brand .brand-name, .drawer-head .brand-name, #sidebarBrandName, #drawerBrandName');

  if (d.is_valid) {
    brandEls.forEach(el => {
      el.innerHTML = 'Hashem <span class="badge" style="background:linear-gradient(135deg, #f59e0b, #ec4899); color:#fff; font-size:10px; font-weight:800; padding:2px 7px; border-radius:12px; letter-spacing:0.05em; vertical-align:middle; margin-left:6px; box-shadow:0 2px 8px rgba(245,158,11,0.4);">PRO</span>';
    });
    if (badge) {
      badge.textContent = 'PREMIUM (Active)';
      badge.style.background = '#10b981';
      badge.style.color = '#fff';
    }
    if (details) details.classList.remove('hidden');
    if (deactBtn) deactBtn.classList.remove('hidden');

    if ($('licCustomerRow')) $('licCustomerRow').textContent = 'Customer: ' + (d.customer || '-');
    if ($('licExpiresRow')) {
      const expStr = d.expires_human || '-';
      const daysStr = d.days_remaining >= 0 ? ` (${d.days_remaining} days left)` : ' (Lifetime)';
      $('licExpiresRow').textContent = 'Expires: ' + expStr + daysStr;
    }
    if ($('licFeaturesRow')) {
      $('licFeaturesRow').textContent = 'Unlocked Features: ' + (d.features && d.features.length ? d.features.join(', ') : 'All');
    }
    if ($('bagherLockedBanner')) $('bagherLockedBanner').classList.add('hidden');
  } else {
    brandEls.forEach(el => {
      el.textContent = 'Hashem';
    });
    if (badge) {
      badge.textContent = 'FREE EDITION';
      badge.style.background = 'rgba(255,255,255,0.1)';
      badge.style.color = '';
    }
    if (details) details.classList.add('hidden');
    if (deactBtn) deactBtn.classList.add('hidden');
    if ($('bagherLockedBanner') && $('sshfwdMode') && ($('sshfwdMode').value === 'bagher' || $('sshfwdMode').value === 'frp_ssh')) {
      $('bagherLockedBanner').classList.remove('hidden');
    }
  }
}

async function activateLicenseClick() {
  const keyEl = $('licKeyInput');
  const key = keyEl ? keyEl.value.trim() : '';
  if (!key) {
    toastErr('Missing Key', 'Paste a valid license key string first.');
    return;
  }
  try {
    const res = await api('/api/license', { key });
    try { localStorage.setItem('hashem_bagher_license', key); } catch (e) {}
    toastOk('License Activated', 'Premium features unlocked for ' + (res.customer || 'this server') + '!');
    if (keyEl) keyEl.value = '';
    await loadLicense();
    if (typeof loadSSHFwd === 'function') await loadSSHFwd();
  } catch (err) {
    toastErr('Activation Failed', err.message || String(err));
  }
}

async function deactivateLicenseClick() {
  if (!confirm('Deactivate and remove current license? Premium features will lock.')) return;
  try {
    await api('/api/license', { key: '' });
    try { localStorage.removeItem('hashem_bagher_license'); } catch (e) {}
    toastOk('License Removed', 'Reverted to Free edition.');
    await loadLicense();
    if (typeof loadSSHFwd === 'function') await loadSSHFwd();
  } catch (err) {
    toastErr('Failed', String(err));
  }
}

function copyMachineHashClick() {
  const el = $('licMachineHash');
  if (el && el.value) {
    copyTextSafe(el.value, 'Copied', 'Hardware machine hash copied to clipboard.');
  }
}

function openBagherQuickEdit() {
  const d = _sshfwdData || {};
  if ($('bagherQuickRemoteHost')) $('bagherQuickRemoteHost').value = d.remote_host || ($('sshfwdRemoteHost') ? $('sshfwdRemoteHost').value : '');
  if ($('bagherQuickPorts')) {
    const p = Array.isArray(d.ports) ? d.ports.join(', ') : (d.ports || ($('sshfwdPorts') ? $('sshfwdPorts').value : ''));
    $('bagherQuickPorts').value = p;
  }
  if ($('bagherQuickPoolCount')) $('bagherQuickPoolCount').value = d.pool_count || 25;
  if ($('bagherQuickBindPort')) $('bagherQuickBindPort').value = d.frp_bind_port || 55400;
  const warn = $('bagherQuickEditWarn');
  if (warn) { warn.textContent = ''; warn.classList.add('hidden'); }
  const m = $('bagherQuickEditModal');
  if (m) m.hidden = false;
}

function closeBagherQuickEdit() {
  const m = $('bagherQuickEditModal');
  if (m) m.hidden = true;
}

async function saveBagherQuickEdit() {
  const remote_host = $('bagherQuickRemoteHost') ? $('bagherQuickRemoteHost').value.trim() : '';
  const ports = $('bagherQuickPorts') ? $('bagherQuickPorts').value.trim() : '';
  const pool_count = parseInt($('bagherQuickPoolCount') ? $('bagherQuickPoolCount').value : '', 10) || 25;
  const frp_bind_port = parseInt($('bagherQuickBindPort') ? $('bagherQuickBindPort').value : '', 10) || 55400;
  const warn = $('bagherQuickEditWarn');

  if (!remote_host) {
    if (warn) { warn.textContent = 'Please enter a valid Foreign Server IP / Host.'; warn.classList.remove('hidden'); }
    return;
  }
  if (!ports) {
    if (warn) { warn.textContent = 'Please specify at least one forwarded port.'; warn.classList.remove('hidden'); }
    return;
  }
  if (warn) warn.classList.add('hidden');

  try {
    toastOk('Updating...', 'Applying Bagher tunnel changes...');
    const res = await api('/api/sshfwd', {
      action: 'enable',
      mode: 'bagher',
      role: 'iran',
      remote_host,
      remote_user: 'root',
      ssh_port: 22,
      ports,
      pool_count,
      frp_bind_port
    });
    if (res && res.bundle && $('bagherBundleText')) {
      $('bagherBundleText').value = res.bundle;
    }
    toastOk('Bagher Updated', 'Tunnel settings updated and applied successfully!');
    closeBagherQuickEdit();
    if (typeof loadSSHFwd === 'function') await loadSSHFwd();
    if (typeof pollDashboard === 'function') await pollDashboard();
  } catch (err) {
    if (warn) { warn.textContent = err.message || String(err); warn.classList.remove('hidden'); }
    toastErr('Update Failed', err.message || String(err));
  }
}

window.openBagherLicModal = openBagherLicModal;
window.closeBagherLicModal = closeBagherLicModal;
window.cancelBagherLicModal = cancelBagherLicModal;
window.openBagherLicenseSettings = openBagherLicenseSettings;
window.activateBagherLicenseClick = activateBagherLicenseClick;
window.bagherLicCopyMachineClick = bagherLicCopyMachineClick;
window.bagherIranApplyClick = bagherIranApplyClick;
window.bagherForeignConnectClick = bagherForeignConnectClick;
window.bagherStopTunnelClick = bagherStopTunnelClick;
window.bagherCopyBundleClick = bagherCopyBundleClick;
window.cleanBagherTunnelClick = cleanBagherTunnelClick;
window.openBagherQuickEdit = openBagherQuickEdit;
window.closeBagherQuickEdit = closeBagherQuickEdit;
window.saveBagherQuickEdit = saveBagherQuickEdit;
window.setBagherRole = setBagherRole;
window.sshfwdClearDnatClick = sshfwdClearDnatClick;
window.sshfwdCopyForeignClick = sshfwdCopyForeignClick;
window.sshfwdCopyAuthClick = sshfwdCopyAuthClick;
window.activateLicenseClick = activateLicenseClick;
window.deactivateLicenseClick = deactivateLicenseClick;
window.copyMachineHashClick = copyMachineHashClick;

(function initLicenseEvents() {
  function on(id, ev, fn) { const el = $(id); if (el) el.addEventListener(ev, fn); }
  on('licActivateBtn', 'click', activateLicenseClick);
  on('licDeactivateBtn', 'click', deactivateLicenseClick);
  on('licCopyMachineBtn', 'click', copyMachineHashClick);

  const origTabSwitch = window.switchTab;
  if (typeof origTabSwitch === 'function') {
    window.switchTab = function(name) {
      origTabSwitch(name);
      if (name === 'settings') loadLicense();
    };
  }
  document.addEventListener('DOMContentLoaded', () => {
    loadLicense();
  });
  setTimeout(loadLicense, 500);
})();

// ==========================================
// Iran Mesh Cluster & High Availability
// ==========================================
let _clusterData = null;

async function loadClusterStatus() {
  try {
    const res = await api('/api/cluster/status');
    _clusterData = res;
    renderClusterUI(res);
  } catch (err) {
    if (err && err.message && (err.message.includes('402') || err.message.includes('Payment Required'))) {
      const banner = $('clusterLockedBanner');
      const card = $('clusterCardContainer');
      if (banner) banner.classList.remove('hidden');
      if (card) card.classList.add('hidden');
      return;
    }
    toastMsg('err', 'Failed to load cluster status: ' + (err.message || err));
  }
}

function renderClusterUI(data) {
  const banner = $('clusterLockedBanner');
  const card = $('clusterCardContainer');
  if (!data || !data.licensed) {
    if (banner) banner.classList.remove('hidden');
    if (card) card.classList.add('hidden');
    return;
  }
  if (banner) banner.classList.add('hidden');
  if (card) card.classList.remove('hidden');

  // Status Badge
  const badge = $('clusterStatusBadge');
  if (badge) {
    if (!data.enabled) {
      badge.className = 'badge info';
      badge.textContent = 'Disabled';
    } else if (data.active_failover) {
      badge.className = 'badge warn';
      badge.textContent = 'Failover Active';
    } else {
      badge.className = 'badge ok';
      badge.textContent = 'Healthy & Mesh Active';
    }
  }

  // Live Gauges
  if ($('clusterLocalNodeID')) $('clusterLocalNodeID').textContent = data.node_id || '--';
  if ($('clusterLocalIP')) $('clusterLocalIP').textContent = data.public_ip || '--';

  const tStatusEl = $('clusterLocalTunnelStatus');
  if (tStatusEl) {
    const isUp = (data.tunnel_status || 'UP').toUpperCase() === 'UP';
    tStatusEl.innerHTML = `<span class="badge ${isUp ? 'ok' : 'err'}">${isUp ? 'UP (Healthy)' : 'DOWN (Failed)'}</span>`;
  }

  const actRouteEl = $('clusterActiveRouting');
  if (actRouteEl) {
    if (data.active_failover && data.failover_target) {
      actRouteEl.innerHTML = `<span style="color:#f87171;">Rerouted \u2192 ${data.failover_target}</span>`;
    } else {
      actRouteEl.innerHTML = `<span style="color:#34d399;">Local Tunnel (Direct)</span>`;
    }
  }

  // Failover Alert Banner
  const foBar = $('clusterFailoverBar');
  const foText = $('clusterFailoverBarText');
  if (foBar) {
    if (data.active_failover) {
      foBar.classList.remove('hidden');
      if (foText) {
        foText.textContent = `Foreign tunnel down. All client traffic on forwarded ports is rerouted to peer ${data.failover_target}.`;
      }
    } else {
      foBar.classList.add('hidden');
    }
  }

  // Foreign Nodes List (Kharej Pool)
  const foreignNodes = Array.isArray(data.foreign_nodes) ? data.foreign_nodes : Object.values(data.foreign_nodes || {});
  if ($('clusterForeignCount')) $('clusterForeignCount').textContent = foreignNodes.length;
  const fContainer = $('clusterForeignList');
  if (fContainer) {
    if (foreignNodes.length === 0) {
      fContainer.innerHTML = `
        <div style="grid-column:1/-1; text-align:center; padding:24px 16px; background:rgba(0,0,0,0.25); border:1px dashed rgba(2,132,199,0.25); border-radius:10px;">
          <div style="font-size:22px; margin-bottom:6px;">🌐</div>
          <div style="font-weight:700; color:#cbd5e1; font-size:13px; margin-bottom:4px;">No Foreign Exit Servers Configured</div>
          <div style="font-size:12px; color:#94a3b8; max-width:440px; margin:0 auto 10px auto;">
            Add your foreign servers here to monitor latency, auto-failover, or manually switch exit paths.
          </div>
          <button class="hashem-btn hashem-btn-primary" onclick="openClusterAddForeignModal()" style="font-size:11px; padding:5px 14px; background:#0284c7; border-color:#0284c7;">
            + Add Foreign Exit Server
          </button>
        </div>`;
    } else {
      let fhtml = '';
      foreignNodes.forEach(fn => {
        const isActive = (fn.id === data.active_foreign) || !!fn.is_active;
        const isHealthy = !!fn.is_healthy;
        const latency = fn.latency_ms ? `${fn.latency_ms.toFixed(1)} ms` : '--';

        fhtml += `
          <div style="background:rgba(15,23,42,0.7); border:1px solid ${isActive ? '#0284c7' : 'rgba(2,132,199,0.25)'}; border-radius:10px; padding:16px; display:flex; flex-direction:column; justify-content:space-between; box-shadow:0 4px 14px rgba(0,0,0,0.3);">
            <div>
              <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:10px;">
                <div>
                  <div style="font-weight:700; color:#f8fafc; font-size:14px; display:flex; align-items:center; gap:6px;">
                    <span>🌐</span> ${escapeHtml(fn.name || fn.id)}
                  </div>
                  <div style="font-size:11px; font-family:monospace; color:#94a3b8; margin-top:2px;">ID: ${escapeHtml(fn.id)}</div>
                </div>
                <div style="display:flex; gap:6px; align-items:center;">
                  ${isActive ? `<span class="badge info" style="font-size:9px; font-weight:800; background:#0284c7; color:#fff;">ACTIVE</span>` : ''}
                  <span class="badge ${isHealthy ? 'ok' : 'err'}" style="font-size:10px; font-weight:700;">${isHealthy ? 'UP' : 'DOWN'}</span>
                </div>
              </div>

              <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; font-size:11px; margin-bottom:14px; background:rgba(0,0,0,0.3); padding:8px 10px; border-radius:6px;">
                <div>
                  <span style="color:#94a3b8;">Public IP:</span>
                  <div style="font-family:monospace; color:#e2e8f0; font-weight:600;">${escapeHtml(fn.public_ip || '--')}</div>
                </div>
                <div>
                  <span style="color:#94a3b8;">Port / Proto:</span>
                  <div style="font-family:monospace; color:#38bdf8; font-weight:600;">${fn.tunnel_port || 55354} / ${(fn.protocol || 'wss').toUpperCase()}</div>
                </div>
                <div>
                  <span style="color:#94a3b8;">TCP Latency:</span>
                  <div style="font-family:monospace; color:#34d399; font-weight:600;">${latency}</div>
                </div>
                <div>
                  <span style="color:#94a3b8;">Status:</span>
                  <div style="font-weight:600; color:${isHealthy ? '#34d399' : '#f87171'};">${isHealthy ? 'Reachable' : 'Unreachable'}</div>
                </div>
              </div>
            </div>

            <div style="display:flex; justify-content:space-between; align-items:center; padding-top:8px; border-top:1px solid rgba(255,255,255,0.06); margin-top:8px;">
              ${isActive
                ? `<span style="font-size:11px; color:#38bdf8; font-weight:700;">✓ In Use</span>`
                : `<button class="hashem-btn" onclick="switchClusterForeign('${escapeHtml(fn.id)}')" style="font-size:11px; padding:4px 10px; background:rgba(2,132,199,0.2); border-color:#0284c7; color:#38bdf8;">Switch to This</button>`
              }
              <button class="hashem-btn hashem-btn-ghost" onclick="deleteClusterForeign('${escapeHtml(fn.id)}')" style="font-size:11px; padding:4px 8px; color:#ef4444;" title="Remove foreign node">&#128465;</button>
            </div>
          </div>
        `;
      });
      fContainer.innerHTML = fhtml;
    }
  }

  // Nodes List
  const nodes = Array.isArray(data.nodes) ? data.nodes : Object.values(data.nodes || {});
  if ($('clusterNodeCount')) $('clusterNodeCount').textContent = nodes.length;

  const container = $('clusterNodesList');
  if (!container) return;

  if (nodes.length === 0) {
    container.innerHTML = `
      <div style="grid-column:1/-1; text-align:center; padding:32px 16px; background:rgba(0,0,0,0.25); border:1px dashed rgba(168,85,247,0.25); border-radius:10px;">
        <div style="font-size:24px; margin-bottom:8px;">📡</div>
        <div style="font-weight:700; color:#cbd5e1; font-size:14px; margin-bottom:4px;">No Peer Iran Servers Configured</div>
        <div style="font-size:12px; color:#94a3b8; max-width:440px; margin:0 auto 12px auto;">
          Connect at least one additional Iran server to establish a resilient intra-Iran failover mesh.
        </div>
        <button class="hashem-btn hashem-btn-primary" onclick="openClusterAddNodeModal()" style="font-size:12px; padding:6px 16px; background:#7c3aed; border-color:#7c3aed;">
          + Add First Peer Node
        </button>
      </div>`;
    return;
  }

  let html = '';
  nodes.forEach(node => {
    const isHealthy = !!node.is_healthy;
    const isFailing = !!node.is_failing;
    const tunnelUp = (node.tunnel_status || 'UP').toUpperCase() === 'UP';
    const latency = node.ping_ms ? `${node.ping_ms.toFixed(1)} ms` : '--';
    const lastSeen = node.last_seen ? new Date(node.last_seen * 1000).toLocaleTimeString() : 'Never';

    let statusBadgeClass = 'ok';
    let statusText = 'HEALTHY';
    if (!isHealthy) {
      statusBadgeClass = 'err';
      statusText = 'OFFLINE';
    } else if (isFailing || !tunnelUp) {
      statusBadgeClass = 'warn';
      statusText = 'TUNNEL DOWN';
    }

    const isCurrentFailoverTarget = data.active_failover && data.failover_target === node.id;

    html += `
      <div style="background:rgba(15,23,42,0.7); border:1px solid ${isCurrentFailoverTarget ? '#ef4444' : 'rgba(168,85,247,0.25)'}; border-radius:10px; padding:16px; display:flex; flex-direction:column; justify-content:space-between; box-shadow:0 4px 14px rgba(0,0,0,0.3);">
        <div>
          <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:10px;">
            <div>
              <div style="font-weight:700; color:#f8fafc; font-size:14px; display:flex; align-items:center; gap:6px;">
                <span>🇮🇷</span> ${escapeHtml(node.name || node.id)}
              </div>
              <div style="font-size:11px; font-family:monospace; color:#94a3b8; margin-top:2px;">ID: ${escapeHtml(node.id)}</div>
            </div>
            <span class="badge ${statusBadgeClass}" style="font-size:10px; font-weight:700;">${statusText}</span>
          </div>

          <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; font-size:11px; margin-bottom:14px; background:rgba(0,0,0,0.3); padding:8px 10px; border-radius:6px;">
            <div>
              <span style="color:#94a3b8;">Public IP:</span>
              <div style="font-family:monospace; color:#e2e8f0; font-weight:600;">${escapeHtml(node.public_ip || '--')}</div>
            </div>
            <div>
              <span style="color:#94a3b8;">Peer Ping:</span>
              <div style="font-family:monospace; color:#38bdf8; font-weight:600;">${latency}</div>
            </div>
            <div>
              <span style="color:#94a3b8;">Kharej Tunnel:</span>
              <div style="font-weight:600; color:${tunnelUp ? '#34d399' : '#f87171'};">${tunnelUp ? 'UP' : 'DOWN'}</div>
            </div>
            <div>
              <span style="color:#94a3b8;">Last Heartbeat:</span>
              <div style="color:#cbd5e1;">${lastSeen}</div>
            </div>
          </div>
        </div>

        <div style="display:flex; justify-content:space-between; align-items:center; padding-top:8px; border-top:1px solid rgba(255,255,255,0.06); margin-top:8px;">
          ${isCurrentFailoverTarget
            ? `<button class="hashem-btn hashem-btn-danger" onclick="revertClusterFailover()" style="font-size:11px; padding:4px 10px;">Revert Reroute</button>`
            : `<button class="hashem-btn" onclick="triggerClusterFailover('${escapeHtml(node.id)}')" ${(!isHealthy || isFailing || !tunnelUp) ? 'disabled' : ''} style="font-size:11px; padding:4px 10px; background:rgba(124,58,237,0.2); border-color:#7c3aed; color:#c084fc;">\u2192 Failover Here</button>`
          }
          <button class="hashem-btn hashem-btn-ghost" onclick="deleteClusterNode('${escapeHtml(node.id)}')" style="font-size:11px; padding:4px 8px; color:#ef4444;" title="Remove peer">&#128465;</button>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

function openClusterAddNodeModal() {
  $('clusterPeerID').value = '';
  $('clusterPeerName').value = '';
  $('clusterPeerAPI').value = '';
  $('clusterPeerIP').value = '';
  $('clusterNodeModal').hidden = false;
}

function closeClusterAddNodeModal() {
  $('clusterNodeModal').hidden = true;
}

async function submitClusterAddNode() {
  const id = ($('clusterPeerID').value || '').trim();
  const name = ($('clusterPeerName').value || '').trim();
  const api_url = ($('clusterPeerAPI').value || '').trim();
  const public_ip = ($('clusterPeerIP').value || '').trim();

  if (!id || !api_url) {
    toastMsg('err', 'Node ID and Panel Base URL are required');
    return;
  }

  try {
    await api('/api/cluster/nodes/add', { id, name, api_url, public_ip });
    toastMsg('ok', 'Peer node added and verified');
    closeClusterAddNodeModal();
    loadClusterStatus();
  } catch (err) {
    toastMsg('err', 'Failed to add node: ' + (err.message || err));
  }
}

async function deleteClusterNode(id) {
  if (!confirm(`Are you sure you want to remove peer node "${id}" from the cluster?`)) return;
  try {
    await api('/api/cluster/nodes/delete', { id });
    toastMsg('ok', 'Peer node removed');
    loadClusterStatus();
  } catch (err) {
    toastMsg('err', 'Failed to delete node: ' + (err.message || err));
  }
}

function openClusterConfigModal() {
  if (!_clusterData) return;
  $('clusterCfgEnabled').checked = !!_clusterData.enabled;
  $('clusterCfgAutoFailover').checked = !!_clusterData.auto_failover;
  $('clusterCfgNodeID').value = _clusterData.node_id || '';
  $('clusterCfgSecret').value = _clusterData.cluster_secret || '';
  $('clusterCfgPorts').value = (_clusterData.service_ports || []).join(', ');
  $('clusterConfigModal').hidden = false;
}

function closeClusterConfigModal() {
  $('clusterConfigModal').hidden = true;
}

function generateClusterSecret() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_';
  let sec = '';
  const arr = new Uint8Array(32);
  window.crypto.getRandomValues(arr);
  arr.forEach(b => { sec += chars[b % chars.length]; });
  $('clusterCfgSecret').value = sec;
}

async function submitClusterConfig() {
  const enabled = $('clusterCfgEnabled').checked;
  const auto_failover = $('clusterCfgAutoFailover').checked;
  const node_id = ($('clusterCfgNodeID').value || '').trim();
  const cluster_secret = ($('clusterCfgSecret').value || '').trim();
  const rawPorts = ($('clusterCfgPorts').value || '').split(',');
  const service_ports = [];
  rawPorts.forEach(p => {
    const n = parseInt(p.trim(), 10);
    if (!isNaN(n) && n > 0 && n <= 65535) service_ports.push(n);
  });

  try {
    await api('/api/cluster/config', {
      enabled,
      auto_failover,
      node_id,
      cluster_secret,
      service_ports
    });
    toastMsg('ok', 'Cluster configuration updated');
    closeClusterConfigModal();
    loadClusterStatus();
  } catch (err) {
    toastMsg('err', 'Failed to save configuration: ' + (err.message || err));
  }
}

async function triggerClusterFailover(targetId) {
  if (!confirm(`Manual failover: Reroute all client traffic to peer "${targetId}"?`)) return;
  try {
    await api('/api/cluster/failover/trigger', { target_id: targetId });
    toastMsg('ok', `Failover active: Traffic rerouted to ${targetId}`);
    loadClusterStatus();
  } catch (err) {
    toastMsg('err', 'Failover failed: ' + (err.message || err));
  }
}

async function revertClusterFailover() {
  if (!confirm('Revert failover: Restore traffic routing to the local tunnel?')) return;
  try {
    await api('/api/cluster/failover/revert', {});
    toastMsg('ok', 'Failover reverted: Local routing restored');
    loadClusterStatus();
  } catch (err) {
    toastMsg('err', 'Revert failed: ' + (err.message || err));
  }
}

function openClusterAddForeignModal() {
  $('clusterForeignID').value = '';
  $('clusterForeignName').value = '';
  $('clusterForeignIP').value = '';
  $('clusterForeignPort').value = '55354';
  $('clusterForeignProtocol').value = 'wss';
  $('clusterForeignModal').hidden = false;
}

function closeClusterAddForeignModal() {
  $('clusterForeignModal').hidden = true;
}

async function submitClusterAddForeign() {
  const id = ($('clusterForeignID').value || '').trim();
  const name = ($('clusterForeignName').value || '').trim();
  const public_ip = ($('clusterForeignIP').value || '').trim();
  const tunnel_port = parseInt(($('clusterForeignPort').value || '55354').trim(), 10) || 55354;
  const protocol = ($('clusterForeignProtocol').value || 'wss').trim();

  if (!id || !public_ip) {
    toastMsg('err', 'Node ID and Public IP are required');
    return;
  }

  try {
    await api('/api/cluster/foreign/add', { id, name, public_ip, tunnel_port, protocol });
    toastMsg('ok', 'Foreign exit node added to pool');
    closeClusterAddForeignModal();
    loadClusterStatus();
  } catch (err) {
    toastMsg('err', 'Failed to add foreign node: ' + (err.message || err));
  }
}

async function deleteClusterForeign(id) {
  if (!confirm(`Remove foreign exit node "${id}" from the pool?`)) return;
  try {
    await api('/api/cluster/foreign/delete', { id });
    toastMsg('ok', 'Foreign exit node removed');
    loadClusterStatus();
  } catch (err) {
    toastMsg('err', 'Failed to remove foreign node: ' + (err.message || err));
  }
}

async function switchClusterForeign(targetId) {
  if (!confirm(`Switch active exit tunnel to "${targetId}"?`)) return;
  try {
    await api('/api/cluster/foreign/switch', { target_id: targetId });
    toastMsg('ok', `Active foreign exit switched to ${targetId}`);
    loadClusterStatus();
  } catch (err) {
    toastMsg('err', 'Failed to switch foreign node: ' + (err.message || err));
  }
}

window.loadClusterStatus = loadClusterStatus;
window.openClusterAddNodeModal = openClusterAddNodeModal;
window.closeClusterAddNodeModal = closeClusterAddNodeModal;
window.submitClusterAddNode = submitClusterAddNode;
window.deleteClusterNode = deleteClusterNode;
window.openClusterAddForeignModal = openClusterAddForeignModal;
window.closeClusterAddForeignModal = closeClusterAddForeignModal;
window.submitClusterAddForeign = submitClusterAddForeign;
window.deleteClusterForeign = deleteClusterForeign;
window.switchClusterForeign = switchClusterForeign;
window.openClusterConfigModal = openClusterConfigModal;
window.closeClusterConfigModal = closeClusterConfigModal;
window.generateClusterSecret = generateClusterSecret;
window.submitClusterConfig = submitClusterConfig;
window.triggerClusterFailover = triggerClusterFailover;
window.revertClusterFailover = revertClusterFailover;
