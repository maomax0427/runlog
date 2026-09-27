// ランログ — 画面
(function () {
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const DATA_KEY = 'runlog:v1', API_KEY = 'runlog:api', CFG_KEY = 'runlog:cfg', DEMO_KEY = 'runlog:demo', TAB_KEY = 'runlog:tab';
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { } },
  };
  const DEF_CFG = { hrMax: 0, hrRest: 60, refHr: 150, weeklyKm: 20, monthlyKm: 80, shoeLife: 700, shoeLimits: {} };

  const S = {
    tab: store.get(TAB_KEY, 'home'),
    api: store.get(API_KEY, ''),
    cfg: Object.assign({}, DEF_CFG, store.get(CFG_KEY, {})),
    data: null, status: null, syncing: false, lastSync: null,
    range: '6m', runFilter: 'run',
  };

  function loadData() {
    if (S.api) {
      const c = store.get(DATA_KEY, null);
      S.data = c ? { acts: c.acts || [], gear: c.gear || [] } : { acts: [], gear: [] };
      S.status = c && c.status || null;
      S.lastSync = c && c.at || null;
    } else if (store.get(DEMO_KEY, false)) {
      S.data = Object.assign(window.DEMO.make(), { demo: true });
    } else {
      S.data = { acts: [], gear: [] };
    }
    D = null;
  }

  /* ---------------- 派生データ ---------------- */
  let D = null;
  function derive() {
    if (D) return D;
    const acts = S.data.acts.slice().sort((a, b) => M.t(a) - M.t(b));
    const runs = acts.filter(M.isRun);
    const P = M.hrParams(acts, S.cfg);
    const fit = M.fitnessSeries(runs, P);
    const load = M.loadSeries(acts, P);
    const prs = M.prs(runs);
    const prIds = {};
    prs.forEach(p => p.history.forEach(h => { (prIds[h.a.id] = prIds[h.a.id] || []).push(p.d.name); }));
    // 現在のベストかどうか（過去のベストは「当時のベスト」）
    const curPr = {};
    prs.forEach(p => { if (p.best) (curPr[p.best.a.id] = curPr[p.best.a.id] || []).push(p.d.name); });
    D = { acts, runs, P, fit, load, prs, prIds, curPr, shoes: M.shoes(runs, S.data.gear || []) };
    return D;
  }
  const gearName = id => { const g = (S.data.gear || []).find(x => x.id === id); return g ? g.name : null; };

  /* ---------------- 通信 ---------------- */
  async function api(action, payload) {
    const res = await fetch(S.api, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(Object.assign({ action: action }, payload || {})) });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || '通信エラー');
    return j;
  }
  function applyLoad(j) {
    S.data = { acts: j.acts || [], gear: j.gear || [] };
    S.status = j.status || S.status;
    S.lastSync = Date.now();
    if (j.config && !store.get('runlog:cfgDirty', false)) {
      S.cfg = Object.assign({}, DEF_CFG, j.config);
      store.set(CFG_KEY, S.cfg);
    }
    store.set(DATA_KEY, { acts: S.data.acts, gear: S.data.gear, status: S.status, at: S.lastSync });
    D = null;
  }
  async function sync(mode) {
    if (!S.api || S.syncing) return;
    S.syncing = true; render();
    try {
      const j = await api(mode === 'full' ? 'resync' : 'load', { sync: true });
      const before = S.data.acts.length;
      applyLoad(j);
      const s = j.sync || {};
      if (s.error) toast(s.error);
      else if (s.busy) toast('別の取り込みが実行中です。少し待ってからもう一度');
      else if (mode) {
        const msg = [];
        if (s.added) msg.push(s.added + '件を取り込みました'); else if (mode === 'manual') msg.push('最新です');
        if (s.removed) msg.push(s.removed + '件を削除');
        if (s.detailPending) msg.push('ラップ詳細は残り' + s.detailPending + '件（自動で取得）');
        if (s.note) msg.push(s.note);
        if (msg.length) toast(msg.join(' / '));
      } else if (S.data.acts.length > before) toast((S.data.acts.length - before) + '件の新しい記録');
      if (store.get('runlog:cfgDirty', false)) pushCfg();
    } catch (e) {
      if (mode) toast('同期できませんでした: ' + e.message);
    } finally {
      S.syncing = false; render();
    }
  }
  let cfgTimer = null;
  function saveCfg() {
    store.set(CFG_KEY, S.cfg);
    D = null;
    if (!S.api) return;
    store.set('runlog:cfgDirty', true);
    clearTimeout(cfgTimer);
    cfgTimer = setTimeout(pushCfg, 800);
  }
  async function pushCfg() {
    try { await api('saveConfig', { config: S.cfg }); store.del('runlog:cfgDirty'); } catch (e) { }
  }
  function connectStrava() {
    const st = S.status || {};
    if (!st.clientId) { toast('Apps Script に STRAVA_CLIENT_ID が設定されていません'); return; }
    const url = 'https://www.strava.com/oauth/authorize?client_id=' + encodeURIComponent(st.clientId) +
      '&response_type=code&approval_prompt=auto&scope=' + encodeURIComponent('read,activity:read_all,profile:read_all') +
      '&redirect_uri=' + encodeURIComponent(S.api);
    store.set('runlog:connecting', Date.now());
    window.open(url, '_blank');
  }
  async function refreshStatus() {
    if (!S.api) return;
    try { const j = await api('status'); S.status = j; render(); } catch (e) { toast('URL に接続できません: ' + e.message); }
  }

  /* ---------------- 共通パーツ ---------------- */
  let toastTimer;
  function toast(msg) {
    const el = $('#toast'); el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 2800);
  }
  const W = ['日', '月', '火', '水', '木', '金', '土'];
  function fmtDate(iso, withTime) {
    const d = new Date(iso);
    const s = (d.getMonth() + 1) + '/' + d.getDate() + '（' + W[d.getDay()] + '）';
    return withTime ? s + ' ' + d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0') : s;
  }
  const fmtYmd = ms => { const d = new Date(ms); return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate(); };
  function ago(ms) {
    if (!ms) return '';
    const m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return 'たった今'; if (m < 60) return m + '分前';
    const h = Math.round(m / 60); if (h < 24) return h + '時間前';
    return Math.round(h / 24) + '日前';
  }
  function delta(v, digits, unit, betterUp = true) {
    if (v == null || !isFinite(v)) return '';
    const r = Math.round(v * 10 ** digits) / 10 ** digits;
    if (r === 0) return '<span class="delta">±0' + unit + '</span>';
    const good = (r > 0) === betterUp;
    return '<span class="delta ' + (good ? 'up' : 'down') + '">' + (r > 0 ? '+' : '') + r.toFixed(digits) + unit + '</span>';
  }
  const ICON = {
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/></svg>',
    runs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/></svg>',
    growth: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/></svg>',
    shoes: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 16.5V8.5l4 1 2-3.5 3 2 1.5 2.5 5 1.5a3 3 0 0 1 2.5 3v1.5z"/><path d="M3 16.5v2h19v-2"/></svg>',
    settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    sync: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 1-15.5 6.2M3 12a9 9 0 0 1 15.5-6.2"/><path d="M21 4v5h-5M3 20v-5h5"/></svg>',
  };
  const TABS = [['home', 'ホーム'], ['runs', '記録'], ['growth', '成長'], ['shoes', 'シューズ'], ['settings', '設定']];

  /* ---------------- グラフ ---------------- */
  // 描画は DOM に置いてから幅を測って行う。spec は id ごとに保持
  const charts = {};
  const chartBox = (id, spec, h) => { charts[id] = spec; return '<div class="chart-wrap"><div class="readout" id="' + id + '-r"></div><svg class="chart" id="' + id + '" height="' + (h || 170) + '"></svg>' + (spec.legend ? '<div class="legend">' + spec.legend + '</div>' : '') + '</div>'; };

  function niceTicks(lo, hi, n) {
    const span = hi - lo || 1;
    const step0 = span / n;
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= step0) || 10 * mag;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
    return out;
  }

  function drawCharts() {
    Object.keys(charts).forEach(id => {
      const svg = document.getElementById(id);
      if (!svg) { delete charts[id]; return; }
      const spec = charts[id];
      (spec.bars ? drawBars : drawLines)(svg, spec, id);
    });
  }

  function drawLines(svg, spec, id) {
    const w = svg.clientWidth || 320, h = +svg.getAttribute('height');
    const L = 38, R = 10, T = 10, B = 22;
    const all = [];
    spec.series.forEach(s => s.pts.forEach(p => { if (p.y != null) all.push(p); }));
    (spec.extra || []).forEach(p => { if (p.y != null) all.push(p); });
    const ro = document.getElementById(id + '-r');
    if (!all.length) { svg.innerHTML = '<text x="' + w / 2 + '" y="' + h / 2 + '" text-anchor="middle" class="ax">データがありません</text>'; ro.innerHTML = ''; return; }
    let x0 = spec.x0 != null ? spec.x0 : Math.min.apply(null, all.map(p => p.x)), x1 = Math.max.apply(null, all.map(p => p.x));
    if (x1 === x0) x1 = x0 + M.DAY;
    let y0 = Math.min.apply(null, all.map(p => p.y)), y1 = Math.max.apply(null, all.map(p => p.y));
    const padY = (y1 - y0) * 0.12 || Math.abs(y0) * 0.05 || 1;
    y0 -= padY; y1 += padY;
    if (spec.zero) y0 = Math.min(0, y0);
    const ticks = niceTicks(y0, y1, 4);
    const X = x => L + (x - x0) / (x1 - x0) * (w - L - R);
    const Y = y => spec.invert ? T + (y - y0) / (y1 - y0) * (h - T - B) : h - B - (y - y0) / (y1 - y0) * (h - T - B);
    let g = '';
    ticks.forEach(v => { const y = Y(v); if (y < T - 1 || y > h - B + 1) return; g += '<line class="gl" x1="' + L + '" x2="' + (w - R) + '" y1="' + y + '" y2="' + y + '"/><text class="ax" x="' + (L - 6) + '" y="' + (y + 3.5) + '" text-anchor="end">' + esc(spec.yFmt ? spec.yFmt(v) : v) + '</text>'; });
    // x 軸：月の頭
    const months = [];
    const d = new Date(x0); d.setDate(1); d.setHours(0, 0, 0, 0); d.setMonth(d.getMonth() + 1);
    for (; d.getTime() <= x1; d.setMonth(d.getMonth() + 1)) months.push(d.getTime());
    const every = Math.max(1, Math.ceil(months.length / Math.max(2, Math.floor((w - L) / 56))));
    months.forEach((m, i) => { if (i % every) return; const md = new Date(m); g += '<text class="ax" x="' + X(m) + '" y="' + (h - 5) + '" text-anchor="middle">' + (md.getMonth() === 0 ? md.getFullYear() + '/' : '') + (md.getMonth() + 1) + '月</text>'; });
    (spec.extra || []).forEach(p => { if (p.y != null) g += '<circle class="dot" cx="' + X(p.x) + '" cy="' + Y(p.y) + '" r="3"/>'; });
    spec.series.forEach(s => {
      const pts = s.pts.filter(p => p.y != null);
      if (!pts.length) return;
      g += '<path class="ln ' + (s.cls || '') + '" d="' + pts.map((p, i) => (i ? 'L' : 'M') + X(p.x).toFixed(1) + ',' + Y(p.y).toFixed(1)).join('') + '"/>';
    });
    g += '<line class="cross" id="' + id + '-x" y1="' + T + '" y2="' + (h - B) + '" visibility="hidden"/>';
    spec.series.forEach((s, k) => { g += '<circle class="hl ' + (s.cls || '') + '" id="' + id + '-h' + k + '" r="5" visibility="hidden"/>'; });
    svg.innerHTML = g;
    const main = spec.series[0].pts.filter(p => p.y != null);
    const pick = i => {
      const p = main[i]; if (!p) return;
      const cx = X(p.x);
      const cr = svg.querySelector('#' + id + '-x'); cr.setAttribute('x1', cx); cr.setAttribute('x2', cx); cr.setAttribute('visibility', 'visible');
      spec.series.forEach((s, k) => {
        const q = s.pts.find(z => z.x === p.x) || null;
        const c = svg.querySelector('#' + id + '-h' + k);
        if (q && q.y != null) { c.setAttribute('cx', X(q.x)); c.setAttribute('cy', Y(q.y)); c.setAttribute('visibility', 'visible'); } else c.setAttribute('visibility', 'hidden');
      });
      ro.innerHTML = spec.readout(p, i);
    };
    const onMove = e => {
      const r = svg.getBoundingClientRect();
      const x = x0 + ((e.clientX - r.left) - L) / (w - L - R) * (x1 - x0);
      let best = 0, bd = Infinity;
      main.forEach((p, i) => { const dd = Math.abs(p.x - x); if (dd < bd) { bd = dd; best = i; } });
      pick(best);
    };
    svg.onpointermove = onMove; svg.onpointerdown = onMove;
    svg.onpointerleave = () => pick(main.length - 1);
    pick(main.length - 1);
  }

  function drawBars(svg, spec, id) {
    const w = svg.clientWidth || 320, h = +svg.getAttribute('height');
    const L = 34, R = 6, T = 10, B = 22;
    const bars = spec.bars;
    const ro = document.getElementById(id + '-r');
    const max = Math.max(spec.goal || 0, ...bars.map(b => b.v), 1) * 1.1;
    const ticks = niceTicks(0, max, 3);
    const Y = v => h - B - v / max * (h - T - B);
    const bw = (w - L - R) / bars.length;
    const gap = Math.min(6, Math.max(2, bw * 0.25));
    let g = '';
    ticks.forEach(v => { const y = Y(v); g += '<line class="gl" x1="' + L + '" x2="' + (w - R) + '" y1="' + y + '" y2="' + y + '"/><text class="ax" x="' + (L - 6) + '" y="' + (y + 3.5) + '" text-anchor="end">' + v + '</text>'; });
    const every = Math.max(1, Math.ceil(bars.length / Math.floor((w - L) / 36)));
    bars.forEach((b, i) => {
      const x = L + i * bw + gap / 2, bwid = Math.max(1, bw - gap), y = Y(b.v), hh = h - B - y;
      const rr = Math.min(4, bwid / 2, hh);
      if (b.v > 0) g += '<path class="bar" data-i="' + i + '" d="M' + x + ',' + (h - B) + 'V' + (y + rr) + 'Q' + x + ',' + y + ' ' + (x + rr) + ',' + y + 'H' + (x + bwid - rr) + 'Q' + (x + bwid) + ',' + y + ' ' + (x + bwid) + ',' + (y + rr) + 'V' + (h - B) + 'Z"/>';
      if ((bars.length - 1 - i) % every === 0) g += '<text class="ax" x="' + (x + bwid / 2) + '" y="' + (h - 5) + '" text-anchor="middle">' + esc(b.label) + '</text>';
    });
    if (spec.goal) g += '<line class="goal" x1="' + L + '" x2="' + (w - R) + '" y1="' + Y(spec.goal) + '" y2="' + Y(spec.goal) + '"/>';
    svg.innerHTML = g;
    const pick = i => {
      svg.querySelectorAll('.bar').forEach(el => el.classList.toggle('dim', +el.dataset.i !== i));
      ro.innerHTML = spec.readout(bars[i], i);
    };
    const onMove = e => {
      const r = svg.getBoundingClientRect();
      const i = Math.max(0, Math.min(bars.length - 1, Math.floor((e.clientX - r.left - L) / bw)));
      pick(i);
    };
    svg.onpointermove = onMove; svg.onpointerdown = onMove;
    svg.onpointerleave = () => { svg.querySelectorAll('.bar').forEach(el => el.classList.remove('dim')); ro.innerHTML = spec.readout(bars[bars.length - 1], bars.length - 1); };
    ro.innerHTML = spec.readout(bars[bars.length - 1], bars.length - 1);
  }

  /* ---------------- ホーム ---------------- */
  function vHome() {
    const d = derive();
    let h = '<div class="page-h"><div><h1>ランログ</h1><div class="sub">' + (S.data.demo ? 'サンプルデータを表示中' : S.lastSync ? '同期 ' + ago(S.lastSync) : '') + '</div></div>' +
      (S.api ? '<button class="icon-btn' + (S.syncing ? ' spin' : '') + '" data-act="sync" aria-label="同期">' + ICON.sync + '</button>' : '') + '</div>';
    if (!d.runs.length) {
      if (S.api && S.status && !S.status.connected) return h + '<div class="card welcome"><div class="emoji">🔗</div><h2>Strava と連携しましょう</h2><p>スプレッドシートとの接続はできています。<br>次は Strava の記録を読み込む許可を出します。</p><button class="btn primary block" data-act="connect">Strava と連携</button></div>';
      if (S.api) return h + '<div class="card welcome"><div class="emoji">⏳</div><h2>記録を読み込み中</h2><p>Strava からの取り込みが終わると、ここに表示されます。</p><button class="btn soft block" data-act="sync">今すぐ同期</button></div>';
      return h + '<div class="card welcome"><div class="emoji">🏃</div><h2>走った記録で、成長を見える化</h2><p>Strava のランを自動で取り込み、距離・ペース・心拍から<br>走力の伸びやシューズの走行距離を追いかけます。</p>' +
        '<button class="btn primary block" data-go="settings">Strava と連携する</button><button class="btn gray block" data-act="demo">サンプルデータで試す</button></div>';
    }
    if (S.data.demo) h += '<div class="banner"><span>サンプルデータです</span><button class="btn sm primary" data-go="settings">自分の記録にする</button></div>';

    const now = Date.now();
    // 今週
    const ws = M.startOfWeek(now);
    const wk = d.runs.filter(a => M.t(a) >= ws);
    const wkKm = wk.reduce((s, a) => s + a.km, 0);
    const days = [];
    for (let i = 0; i < 7; i++) days.push(wk.filter(a => M.startOfDay(M.t(a)) === ws + i * M.DAY).reduce((s, a) => s + a.km, 0));
    const dmax = Math.max(8, ...days);
    const today = (new Date().getDay() + 6) % 7;
    const goal = +S.cfg.weeklyKm || 0;
    h += '<div class="card pad"><div class="card-t"><h3>今週</h3><span class="muted small">' + wk.length + '回 · ' + M.fmtDur(wk.reduce((s, a) => s + a.mt, 0), true) + '</span></div>' +
      '<div class="hero-num"><span class="v">' + M.fmtKm(wkKm) + '</span><span class="u">km' + (goal ? ' / 目標 ' + goal + 'km' : '') + '</span></div>' +
      (goal ? '<div class="goalbar' + (wkKm >= goal ? ' done' : '') + '"><i style="width:' + Math.min(100, wkKm / goal * 100) + '%"></i></div>' : '') +
      '<div class="week-bars">' + days.map((v, i) => '<div class="wb' + (i === today ? ' today' : '') + '"><i class="' + (v ? '' : 'zero') + '" style="height:' + (v / dmax * 64) + 'px"></i><span>' + '月火水木金土日'[i] + '</span></div>').join('') + '</div></div>';

    // 今月
    const ms = M.startOfMonth(now);
    const mo = M.sumRuns(d.runs.filter(a => M.t(a) >= ms));
    const pm = new Date(ms); pm.setMonth(pm.getMonth() - 1);
    const sameDay = pm.getTime() + (now - ms);
    const prev = M.sumRuns(d.runs.filter(a => M.t(a) >= pm.getTime() && M.t(a) < sameDay));
    h += '<div class="sec-h"><span>' + (new Date().getMonth() + 1) + '月</span><span>先月の同じ日まで ' + M.fmtKm(prev.km) + 'km</span></div>' +
      '<div class="kpis"><div class="kpi"><b>' + M.fmtKm(mo.km) + '<small>km</small></b><span>距離' + (S.cfg.monthlyKm ? '（目標' + S.cfg.monthlyKm + '）' : '') + '</span></div>' +
      '<div class="kpi"><b>' + mo.n + '<small>回</small></b><span>ラン</span></div>' +
      '<div class="kpi"><b>' + M.fmtPace(mo.pace) + '<small>/km</small></b><span>平均ペース</span></div></div>';

    // 走力スコア
    h += '<div class="sec-h"><span>走力</span></div>' + fitnessCard(d, true);

    // コンディション
    h += '<div class="sec-h"><span>コンディション</span></div>' + formCard(d);

    // 最近
    h += '<div class="sec-h"><span>最近のラン</span><button class="link" data-go="runs">すべて</button></div><div class="card">' +
      d.runs.slice(-4).reverse().map(runRow).join('') + '</div>';
    return h;
  }

  function fitnessCard(d, compact) {
    const s = d.fit;
    if (!s.length) {
      const rv = d.runs.slice(-60).map(M.raceVdot).filter(Boolean);
      return '<div class="card pad"><div class="card-t"><h3>走力スコア</h3><button class="info" data-act="explain">?</button></div><p class="hint">心拍数のあるランが15分以上あると、走力スコア（推定VO2max）を計算します。' +
        (rv.length ? '<br>記録から: VDOT ' + Math.max.apply(null, rv).toFixed(1) : '') + '</p></div>';
    }
    const cur = s[s.length - 1].v;
    const was = M.scoreAt(s, Date.now() - 28 * M.DAY);
    const recent = s.filter(p => p.t >= Date.now() - 120 * M.DAY);
    let h = '<div class="card pad"><div class="card-t"><h3>走力スコア <span class="muted small">推定VO2max</span></h3><button class="info" data-act="explain">?</button></div>' +
      '<div class="hero-num"><span class="v">' + cur.toFixed(1) + '</span>' + (was ? delta(cur - was, 1, '', true) + '<span class="muted small">4週間前から</span>' : '') + '</div>';
    if (compact && recent.length > 1) h += chartBox('ch-fit-mini', { series: [{ pts: recent.map(p => ({ x: p.t, y: p.v, p: p })) }], yFmt: v => v.toFixed(0), readout: p => '<span>' + fmtYmd(p.x) + '</span><b>' + p.y.toFixed(1) + '</b>' }, 110);
    const P = [['5km', 5000], ['10km', 10000], ['ハーフ', 21097.5], ['フル', 42195]];
    h += '<div class="preds">' + P.map(x => '<div><b>' + M.fmtDur(M.predict(cur, x[1])) + '</b><span>' + x[0] + '予想</span></div>').join('') + '</div></div>';
    return h;
  }

  function formCard(d) {
    const l = d.load[d.load.length - 1];
    if (!l) return '';
    const f = M.formLabel(l.tsb, l.ctl);
    const r = l.ctl > 5 ? l.tsb / l.ctl : 0;
    const pos = Math.max(0, Math.min(100, (r + 0.5) / 0.9 * 100));   // -0.5〜+0.4 を 0〜100%
    return '<div class="card pad"><div class="card-t"><span class="form-badge ' + f.k + '"><i></i>' + f.t + '</span><button class="info" data-act="explain" data-k="form">?</button></div>' +
      (f.d ? '<p class="hint" style="margin-top:0">' + f.d + '</p>' : '') +
      '<div class="meter"><b style="left:' + pos + '%"></b></div><div class="meter-l"><span>疲労注意</span><span>鍛え中</span><span>ちょうどいい</span><span>フレッシュ</span></div>' +
      '<div class="kpis" style="margin-top:14px"><div class="kpi" style="box-shadow:none;background:var(--field)"><b>' + l.ctl.toFixed(0) + '</b><span>体力</span></div>' +
      '<div class="kpi" style="box-shadow:none;background:var(--field)"><b>' + l.atl.toFixed(0) + '</b><span>疲労</span></div>' +
      '<div class="kpi" style="box-shadow:none;background:var(--field)"><b>' + (l.tsb > 0 ? '+' : '') + l.tsb.toFixed(0) + '</b><span>調子</span></div></div></div>';
  }

  function runRow(a) {
    const d = derive();
    const tags = [];
    if (a.wt === 1) tags.push('<span class="tag race">レース</span>');
    (d.curPr[a.id] || []).forEach(n => tags.push('<span class="tag pr">🏅 ' + n + 'ベスト</span>'));
    const g = a.gear && gearName(a.gear);
    if (g) tags.push('<span class="tag shoe">' + esc(g) + '</span>');
    if (a.tm) tags.push('<span class="tag">トレッドミル</span>');
    if (!M.isRun(a)) tags.push('<span class="tag">' + esc(a.type) + '</span>');
    return '<button class="run" data-run="' + esc(a.id) + '"><div class="top"><span class="nm">' + esc(a.name || 'ラン') + '</span><span class="dt">' + fmtDate(a.date, true) + '</span></div>' +
      '<div class="st"><div><b>' + M.fmtKm(a.km, 2) + '</b>km</div><div><b>' + M.fmtDur(a.mt) + '</b>タイム</div>' +
      (M.isRun(a) ? '<div><b>' + M.fmtPace(M.paceSec(a)) + '</b>/km</div>' : '') + (a.hr ? '<div><b>' + Math.round(a.hr) + '</b>bpm</div>' : '') + '</div>' +
      (tags.length ? '<div class="tags">' + tags.join('') + '</div>' : '') + '</button>';
  }

  /* ---------------- 記録 ---------------- */
  function vRuns() {
    const d = derive();
    const F = [['run', 'ラン'], ['race', 'レース'], ['long', '15km以上'], ['pr', '自己ベスト'], ['all', 'すべての種目']];
    let list = S.runFilter === 'all' ? d.acts : d.runs;
    if (S.runFilter === 'race') list = list.filter(a => a.wt === 1);
    if (S.runFilter === 'long') list = list.filter(a => a.km >= 15);
    if (S.runFilter === 'pr') list = list.filter(a => d.prIds[a.id]);
    let h = '<div class="page-h"><h1>記録</h1></div><div class="chips">' + F.map(f => '<button class="chip' + (S.runFilter === f[0] ? ' on' : '') + '" data-filter="' + f[0] + '">' + f[1] + '</button>').join('') + '</div>';
    if (!list.length) return h + '<div class="empty">記録がありません</div>';
    const groups = [];
    list.slice().reverse().forEach(a => {
      const k = M.startOfMonth(M.t(a));
      let g = groups[groups.length - 1];
      if (!g || g.k !== k) groups.push(g = { k: k, items: [] });
      g.items.push(a);
    });
    groups.slice(0, S.monthsShown || 6).forEach(g => {
      const s = M.sumRuns(g.items.filter(M.isRun));
      const dd = new Date(g.k);
      h += '<div class="month-h"><b>' + dd.getFullYear() + '年' + (dd.getMonth() + 1) + '月</b><span>' + M.fmtKm(s.km) + 'km · ' + s.n + '回 · ' + M.fmtDur(s.mt, true) + '</span></div><div class="card">' + g.items.map(runRow).join('') + '</div>';
    });
    if (groups.length > (S.monthsShown || 6)) h += '<button class="btn gray block" style="margin-top:14px" data-act="more">さらに表示</button>';
    return h;
  }

  function runDetail(id) {
    const d = derive();
    const a = d.acts.find(x => x.id === id);
    if (!a) return;
    const run = M.isRun(a);
    const k = (v, l, u) => '<div class="kpi"><b>' + v + (u ? '<small>' + u + '</small>' : '') + '</b><span>' + l + '</span></div>';
    let h = '<div class="kpis">' + k(M.fmtKm(a.km, 2), '距離', 'km') + k(M.fmtDur(a.mt), '移動時間') + (run ? k(M.fmtPace(M.paceSec(a)), 'ペース', '/km') : k(M.fmtKm(a.km / a.mt * 3600), '速度', 'km/h')) + '</div>' +
      '<div class="kpis" style="margin-top:8px">' + k(a.hr ? Math.round(a.hr) : '–', '平均心拍', a.hr ? 'bpm' : '') + k(a.hrMax || '–', '最大心拍', a.hrMax ? 'bpm' : '') + k(Math.round(a.elev || 0), '獲得標高', 'm') + '</div>' +
      '<div class="kpis" style="margin-top:8px">' + k(a.cad || '–', 'ピッチ', a.cad ? 'spm' : '') + k(a.cal || '–', 'カロリー', a.cal ? 'kcal' : '') + k(M.fmtDur(a.et), '経過時間') + '</div>';
    if (run) {
      const ef = M.efficiency(a), v = M.hrVo2(a, d.P), tr = M.trimp(a, d.P);
      const recentEf = d.runs.filter(x => M.t(x) < M.t(a) && M.t(x) > M.t(a) - 42 * M.DAY).map(M.efficiency).filter(Boolean);
      const avgEf = recentEf.length ? recentEf.reduce((s, x) => s + x, 0) / recentEf.length : null;
      const g = a.gear && gearName(a.gear);
      h += '<div class="sec-h"><span>このランの指標</span><button class="link" data-act="explain">指標について</button></div><div class="card">' +
        (ef ? '<div class="eff-row"><span>心拍効率（1拍で進む距離）</span><b>' + ef.toFixed(2) + ' m ' + (avgEf ? delta((ef / avgEf - 1) * 100, 0, '%', true) : '') + '</b></div>' : '') +
        (v ? '<div class="eff-row"><span>このランから見た走力</span><b>' + v.toFixed(1) + '</b></div>' : '') +
        '<div class="eff-row"><span>トレーニング負荷</span><b>' + Math.round(tr) + '</b></div>' +
        (a.hr ? '<div class="eff-row"><span>心拍の余力の使用率</span><b>' + Math.round(M.hrr(a.hr, d.P) * 100) + '%</b></div>' : '') +
        '<div class="eff-row"><span>シューズ</span><b>' + esc(g || '未設定') + '</b></div></div>';
    }
    if (a.splits && a.splits.length) {
      const ps = a.splits.map(s => s[0] > 100 ? s[1] / s[0] * 1000 : null);
      const valid = ps.filter(Boolean);
      const fast = Math.min.apply(null, valid), slow = Math.max.apply(null, valid);
      const avg = a.mt / a.km;
      h += '<div class="sec-h"><span>1kmごとのペース</span><span>平均 ' + M.fmtPace(avg) + '</span></div><div class="card splits"><div class="sp h"><span>km</span><span>ペース</span><span></span><span style="text-align:right">心拍</span></div>' +
        a.splits.map((s, i) => {
          const p = ps[i];
          const wd = p ? 35 + 65 * (slow === fast ? 1 : (slow - p) / (slow - fast)) : 0;
          return '<div class="sp"><span class="k">' + (s[0] < 950 ? (s[0] / 1000).toFixed(1) : i + 1) + '</span><span class="p">' + M.fmtPace(p) + '</span><span><div class="bar' + (p && p > avg * 1.02 ? ' slow' : '') + '" style="width:' + wd + '%"></div></span><span class="hr">' + (s[2] ? Math.round(s[2]) : '') + '</span></div>';
        }).join('') + '</div>';
    }
    if (a.efforts && a.efforts.length) {
      const names = { '400m': '400m', '1/2 mile': '800m', '1K': '1km', '1 mile': '1マイル', '2 mile': '2マイル', '5K': '5km', '10K': '10km', '15K': '15km', '10 mile': '10マイル', '20K': '20km', 'Half-Marathon': 'ハーフ', '30K': '30km', 'Marathon': 'フル' };
      h += '<div class="sec-h"><span>区間ベスト</span></div><div class="card">' + a.efforts.map(e => '<div class="eff-row"><span>' + (names[e[0]] || esc(e[0])) + (e[2] === 1 ? ' <span class="tag pr">🏅 自己ベスト</span>' : e[2] ? ' <span class="tag">' + e[2] + '番目</span>' : '') + '</span><b>' + M.fmtDur(e[1]) + '</b></div>').join('') + '</div>';
    } else if (run && !a.det && !S.data.demo) {
      h += '<p class="hint">ラップと区間ベストは順番に取り込み中です（1時間ごとに自動）。</p>';
    }
    if (!S.data.demo) h += '<p style="text-align:center;margin-top:18px"><a class="link" href="https://www.strava.com/activities/' + encodeURIComponent(a.id) + '" target="_blank" rel="noopener">Strava で開く</a></p>';
    openSheet(esc(a.name || 'ラン'), fmtYmd(M.t(a)) + '（' + W[new Date(a.date).getDay()] + '） ' + new Date(a.date).getHours() + ':' + String(new Date(a.date).getMinutes()).padStart(2, '0'), h);
  }

  /* ---------------- 成長 ---------------- */
  function vGrowth() {
    const d = derive();
    const RG = [['3m', '3か月', 91], ['6m', '6か月', 182], ['1y', '1年', 365], ['all', '全期間', 0]];
    const rg = RG.find(r => r[0] === S.range) || RG[1];
    let h = '<div class="page-h"><h1>成長</h1></div><div class="chips">' + RG.map(r => '<button class="chip' + (S.range === r[0] ? ' on' : '') + '" data-range="' + r[0] + '">' + r[1] + '</button>').join('') + '</div>';
    if (!d.runs.length) return h + '<div class="empty">ランの記録がありません</div>';
    const now = Date.now();
    const from = rg[2] ? now - rg[2] * M.DAY : M.t(d.runs[0]);
    const runs = d.runs.filter(a => M.t(a) >= from);

    // 期間の比較（前半と後半ではなく、同じ長さの直前の期間と）
    const len = now - from;
    const prevRuns = d.runs.filter(a => M.t(a) >= from - len && M.t(a) < from);
    const cur = M.sumRuns(runs), pre = M.sumRuns(prevRuns);
    const hasPrev = rg[2] && prevRuns.length;
    h += '<div class="kpis" style="margin-top:12px"><div class="kpi"><b>' + M.fmtKm(cur.km, 0) + '<small>km</small></b><span>距離 ' + (hasPrev ? delta((cur.km / Math.max(1, pre.km) - 1) * 100, 0, '%') : '') + '</span></div>' +
      '<div class="kpi"><b>' + cur.n + '<small>回</small></b><span>ラン</span></div>' +
      '<div class="kpi"><b>' + M.fmtPace(cur.pace) + '</b><span>平均/km ' + (hasPrev && pre.pace ? delta(pre.pace - cur.pace, 0, '秒', true) : '') + '</span></div></div>';
    if (hasPrev) h += '<p class="hint" style="margin:6px 4px 0">％と秒は、その直前の' + rg[1] + 'との比較</p>';

    // 走力スコア
    const fit = d.fit.filter(p => p.t >= from);
    h += '<div class="sec-h"><span>走力スコア（推定VO2max）</span><button class="link" data-act="explain">?</button></div><div class="card pad">' +
      (fit.length > 1 ? chartBox('ch-fit', { x0: from, series: [{ pts: fit.map(p => ({ x: p.t, y: p.v, a: p.a })) }], extra: fit.map(p => ({ x: p.t, y: p.raw })), yFmt: v => v.toFixed(0),
        readout: p => '<b>' + p.y.toFixed(1) + '</b><span>' + fmtYmd(p.x) + ' · 5km予想 ' + M.fmtDur(M.predict(p.y, 5000)) + '</span>' }) +
        '<p class="hint">点は1回ごとの推定値、線は直近6週間の平均。線が右上がりなら、同じ心拍でより速く走れるようになっています。</p>'
        : '<p class="hint">心拍数付きのランが増えると表示されます。</p>') + '</div>';

    // 距離
    const unit = rg[2] && rg[2] <= 182 ? 'week' : 'month';
    const bk = M.buckets(d.runs, unit, from, now);
    const goal = unit === 'week' ? +S.cfg.weeklyKm : +S.cfg.monthlyKm;
    h += '<div class="sec-h"><span>' + (unit === 'week' ? '週' : '月') + 'ごとの距離</span>' + (goal ? '<span>点線 = 目標 ' + goal + 'km</span>' : '') + '</div><div class="card pad">' +
      chartBox('ch-dist', { bars: bk.map(b => { const dd = new Date(b.k); return { v: +b.km.toFixed(1), label: unit === 'week' ? (dd.getMonth() + 1) + '/' + dd.getDate() : (dd.getMonth() + 1) + '月', b: b }; }), goal: goal,
        readout: x => '<b>' + x.b.km.toFixed(1) + ' km</b><span>' + (unit === 'week' ? fmtYmd(x.b.k) + 'の週' : new Date(x.b.k).getFullYear() + '年' + (new Date(x.b.k).getMonth() + 1) + '月') + ' · ' + x.b.n + '回 · ' + M.fmtDur(x.b.mt, true) + '</span>' }) + '</div>';

    // ペース
    const mb = M.buckets(d.runs, unit, from, now).filter(b => b.n);
    h += '<div class="sec-h"><span>平均ペースの推移</span><span>上ほど速い</span></div><div class="card pad">' +
      chartBox('ch-pace', { invert: true, series: [{ pts: mb.map(b => ({ x: b.k, y: b.pace, b: b })) }], yFmt: M.fmtPace,
        readout: p => '<b>' + M.fmtPace(p.y) + ' /km</b><span>' + (unit === 'week' ? fmtYmd(p.x) + 'の週' : (new Date(p.x).getMonth() + 1) + '月') + ' · ' + p.b.n + '回</span>' }) +
      '<p class="hint">ゆっくり走る日が増えると遅く見えます。本当の伸びは下の「心拍効率」や走力スコアで。</p></div>';

    // 心拍効率
    const efPts = runs.map(a => ({ x: M.t(a), y: M.efficiency(a), a: a })).filter(p => p.y);
    if (efPts.length) {
      const sm = M.rolling(efPts.map(p => p.y), 8);
      const ref = +S.cfg.refHr || 150;
      const last = sm[sm.length - 1];
      const paceAt = ef => 1000 / (ef * ref) * 60;
      const first = sm[Math.min(sm.length - 1, 7)];
      h += '<div class="sec-h"><span>心拍効率（1拍で進む距離）</span><span>上ほど楽に速い</span></div><div class="card pad">' +
        '<div class="kpis two" style="margin-bottom:6px"><div class="kpi" style="box-shadow:none;background:var(--field)"><b>' + M.fmtPace(paceAt(last)) + '<small>/km</small></b><span>心拍' + ref + 'で走れるペース</span></div>' +
        '<div class="kpi" style="box-shadow:none;background:var(--field)"><b>' + (efPts.length > 8 ? (paceAt(first) - paceAt(last) >= 0 ? '−' : '+') + Math.abs(Math.round(paceAt(first) - paceAt(last))) + '<small>秒</small>' : '–') + '</b><span>期間のはじめから</span></div></div>' +
        chartBox('ch-ef', { series: [{ pts: efPts.map((p, i) => ({ x: p.x, y: sm[i], a: p.a })) }], extra: efPts, yFmt: v => v.toFixed(2),
          readout: p => '<b>' + p.y.toFixed(2) + ' m/拍</b><span>' + fmtYmd(p.x) + ' · 心拍' + ref + 'なら ' + M.fmtPace(paceAt(p.y)) + '/km</span>' }) + '</div>';
    }

    // 体力と疲労
    const ld = d.load.filter(p => p.t >= from);
    if (ld.length > 1) {
      const step = Math.max(1, Math.floor(ld.length / 120));
      const pts = ld.filter((_, i) => i % step === 0 || i === ld.length - 1);
      h += '<div class="sec-h"><span>体力と疲労</span><button class="link" data-act="explain" data-k="form">?</button></div><div class="card pad">' +
        chartBox('ch-load', { zero: true, series: [{ pts: pts.map(p => ({ x: p.t, y: p.ctl, l: p })) }, { cls: 'b', pts: pts.map(p => ({ x: p.t, y: p.atl })) }], yFmt: v => v.toFixed(0),
          legend: '<span><i></i>体力（6週間の積み上げ）</span><span><i class="b"></i>疲労（直近1週間）</span>',
          readout: p => '<b>' + p.l.ctl.toFixed(0) + '</b><span>体力</span><b style="color:var(--blue)">' + p.l.atl.toFixed(0) + '</b><span>疲労 · ' + fmtYmd(p.x) + ' · ' + M.formLabel(p.l.tsb, p.l.ctl).t + '</span>' }) + '</div>';
    }

    // 自己ベスト
    h += '<div class="sec-h"><span>自己ベスト</span><span>タップで更新の歴史</span></div><div class="card">' + d.prs.map((p, i) => {
      if (!p.best) return '<div class="pr-row none"><span class="d">' + p.d.name + '</span><span class="tm">まだ記録なし</span><span></span></div>';
      const b = p.best;
      return '<button class="pr-row" data-pr="' + i + '"><span class="d">' + p.d.name + '</span><span><span class="tm">' + M.fmtDur(b.sec) + '</span><br><span class="m">' + fmtYmd(M.t(b.a)) + ' · ' + M.fmtPace(b.sec / p.d.m * 1000) + '/km</span></span>' +
        '<span class="imp">' + (b.prev ? '−' + M.fmtDur(b.prev - b.sec) : '') + '<br><span class="m">' + p.history.length + '回更新</span></span></button>';
    }).join('') + '</div>';

    // 記録いろいろ
    const longest = runs.reduce((m, a) => (a.km > (m ? m.km : 0) ? a : m), null);
    const longestT = runs.reduce((m, a) => (a.mt > (m ? m.mt : 0) ? a : m), null);
    const allTime = M.sumRuns(d.runs);
    h += '<div class="sec-h"><span>' + rg[1] + 'の記録</span></div><div class="card">' +
      (longest ? '<button class="eff-row run" style="display:flex" data-run="' + longest.id + '"><span>いちばん長い距離</span><b>' + M.fmtKm(longest.km, 2) + ' km</b></button>' : '') +
      (longestT ? '<button class="eff-row run" style="display:flex" data-run="' + longestT.id + '"><span>いちばん長い時間</span><b>' + M.fmtDur(longestT.mt) + '</b></button>' : '') +
      '<div class="eff-row"><span>獲得標高の合計</span><b>' + Math.round(cur.elev).toLocaleString() + ' m</b></div>' +
      '<div class="eff-row"><span>これまでの合計</span><b>' + Math.round(allTime.km).toLocaleString() + ' km · ' + allTime.n + '回</b></div></div>';
    return h;
  }

  function prDetail(i) {
    const p = derive().prs[i];
    if (!p || !p.best) return;
    const hist = p.history;
    let h = hist.length > 1 ? '<div class="card pad">' + chartBox('ch-pr', { invert: true, series: [{ pts: hist.map(r => ({ x: M.t(r.a), y: r.sec, r: r })) }], yFmt: v => M.fmtDur(v),
      readout: q => '<b>' + M.fmtDur(q.y) + '</b><span>' + fmtYmd(q.x) + '</span>' }, 150) + '</div>' : '';
    h += '<div class="sec-h"><span>更新の歴史</span></div><div class="card">' + hist.slice().reverse().map(r =>
      '<button class="pr-row" data-run="' + r.a.id + '"><span class="m">' + fmtYmd(M.t(r.a)) + '</span><span><span class="tm">' + M.fmtDur(r.sec) + '</span><br><span class="m">' + esc(r.a.name) + '</span></span><span class="imp">' + (r.prev ? '−' + M.fmtDur(r.prev - r.sec) : '初記録') + '</span></button>').join('') + '</div>' +
      '<p class="hint">Strava の区間ベスト（ランの途中の最速区間）も含みます。</p>';
    openSheet(p.d.name + 'の自己ベスト', '現在 ' + M.fmtDur(p.best.sec), h);
  }

  /* ---------------- シューズ ---------------- */
  const limitOf = g => +(S.cfg.shoeLimits || {})[g.id] || +S.cfg.shoeLife || 700;
  function vShoes() {
    const d = derive();
    let h = '<div class="page-h"><h1>シューズ</h1></div>';
    if (!d.shoes.length) return h + '<div class="card guide">Strava の「設定 → マイギア」でシューズを登録し、ランに靴を設定すると、ここで走行距離や寿命を管理できます。</div>';
    const none = d.runs.filter(a => !a.gear);
    const active = d.shoes.filter(g => !g.retired), retired = d.shoes.filter(g => g.retired);
    const card = g => {
      const lim = limitOf(g);
      const pct = g.total / lim * 100;
      const cls = pct >= 100 ? 'over' : pct >= 80 ? 'warn' : '';
      return '<button class="card shoe' + (g.retired ? ' retired' : '') + '" data-shoe="' + esc(g.id) + '" style="display:block;width:100%;text-align:left"><div class="top"><span class="nm">' + esc(g.name) + (g.primary ? ' <span class="tag">メイン</span>' : '') + (g.retired ? ' <span class="tag">引退</span>' : '') + '</span><span class="km">' + Math.round(g.total).toLocaleString() + '<small>km</small></span></div>' +
        '<div class="life ' + cls + '"><i style="width:' + Math.min(100, pct) + '%"></i></div>' +
        '<div class="meta"><span>' + (pct >= 100 ? '寿命の目安（' + lim + 'km）を超えました' : 'あと ' + Math.round(lim - g.total) + 'km（目安 ' + lim + 'km）') + '</span><span>' + (g.last ? '最終 ' + fmtDate(g.last.date) : '') + '</span></div>' +
        '<div class="grid3"><div><b>' + g.n + '</b><span>ラン</span></div><div><b>' + M.fmtPace(g.pace) + '</b><span>平均ペース</span></div><div><b>' + (g.ef ? g.ef.toFixed(2) : '–') + '</b><span>心拍効率</span></div></div></button>';
    };
    h += active.map(card).join('');
    if (none.length) h += '<p class="hint" style="margin:10px 4px">靴が未設定のラン: ' + none.length + '回（' + Math.round(none.reduce((s, a) => s + a.km, 0)) + 'km）。Strava 側で設定すると反映されます。</p>';
    if (retired.length) h += '<div class="sec-h"><span>引退したシューズ</span></div>' + retired.map(card).join('');
    return h;
  }
  function shoeDetail(id) {
    const g = derive().shoes.find(x => x.id === id);
    if (!g) return;
    const lim = limitOf(g);
    const bk = g.runs.length ? M.buckets(g.runs, 'month', M.t(g.runs[0]), Date.now()) : [];
    let h = '<div class="kpis"><div class="kpi"><b>' + Math.round(g.total) + '<small>km</small></b><span>走行距離</span></div><div class="kpi"><b>' + g.n + '<small>回</small></b><span>ラン</span></div><div class="kpi"><b>' + M.fmtKm(g.longest) + '<small>km</small></b><span>最長</span></div></div>' +
      '<div class="card" style="margin-top:12px"><div class="set-row"><span class="l">寿命の目安<small>この距離に近づくと色が変わります</small></span><span><input class="num-in" type="number" inputmode="numeric" data-limit="' + esc(g.id) + '" value="' + lim + '"> km</span></div>' +
      '<div class="set-row"><span class="l">使いはじめ</span><span>' + (g.first ? fmtYmd(M.t(g.first)) : '–') + '</span></div>' +
      (g.km && g.km > g.appKm + 1 ? '<div class="set-row"><span class="l">Strava 上の距離<small>取り込み前の分や手入力を含む</small></span><span>' + Math.round(g.km) + 'km</span></div>' : '') + '</div>';
    if (bk.length > 1) h += '<div class="sec-h"><span>月ごとの距離</span></div><div class="card pad">' + chartBox('ch-shoe', { bars: bk.map(b => ({ v: +b.km.toFixed(1), label: (new Date(b.k).getMonth() + 1) + '月', b: b })), readout: x => '<b>' + x.b.km.toFixed(1) + ' km</b><span>' + new Date(x.b.k).getFullYear() + '年' + (new Date(x.b.k).getMonth() + 1) + '月 · ' + x.b.n + '回</span>' }, 130) + '</div>';
    h += '<div class="sec-h"><span>最近のラン</span></div><div class="card">' + g.runs.slice(-10).reverse().map(runRow).join('') + '</div>';
    openSheet(esc(g.name), g.retired ? '引退' : '', h);
  }

  /* ---------------- 設定 ---------------- */
  function vSettings() {
    const d = derive();
    const st = S.status || {};
    const numRow = (key, label, sub, ph) => '<div class="set-row"><span class="l">' + label + (sub ? '<small>' + sub + '</small>' : '') + '</span><input class="num-in" type="number" inputmode="numeric" data-cfg="' + key + '" value="' + (S.cfg[key] || '') + '" placeholder="' + (ph || '') + '"></div>';
    let h = '<div class="page-h"><h1>設定</h1></div>';
    h += '<div class="sec-h"><span>Strava 連携</span></div><div class="card">';
    if (S.api) {
      h += '<div class="set-row"><span class="l"><span class="status-dot' + (st.connected ? ' on' : '') + '"></span>' + (st.connected ? 'Strava と連携中' + (st.athlete && st.athlete.name ? '（' + esc(st.athlete.name) + '）' : '') : st.ok ? 'Strava 未連携' : '接続を確認中…') +
        '<small>' + (S.lastSync ? '最終同期 ' + ago(S.lastSync) + ' · ' : '') + d.acts.length + '件のアクティビティ</small></span></div>';
      if (st.ok && !st.connected) h += '<div class="set-row"><button class="btn primary block" data-act="connect">Strava と連携する</button></div>';
      if (st.connected) h += '<div class="set-row"><button class="btn soft" style="flex:1" data-act="sync-manual">今すぐ同期</button><button class="btn gray" style="flex:1" data-act="sync-full">全件取り直す</button></div>';
      h += '<div class="set-row"><span class="l">連携 URL<small>' + esc(S.api.slice(0, 42)) + '…</small></span><button class="btn sm gray" data-act="unset-api">変更</button></div>';
      if (st.connected) h += '<div class="set-row"><button class="link" style="color:var(--red)" data-act="disconnect">Strava との連携を解除</button></div>';
    } else {
      h += '<div class="guide"><b>はじめての設定（10分ほど）</b><ol>' +
        '<li>Google ドライブで新しいスプレッドシート「<b>ランログデータ</b>」を作る</li>' +
        '<li>拡張機能 → Apps Script に <a class="link" href="https://github.com/maomax0427/runlog/blob/main/apps-script/Code.gs" target="_blank" rel="noopener">Code.gs</a> の中身を貼り付ける</li>' +
        '<li>ウェブアプリとしてデプロイ（実行ユーザー: 自分 / アクセス: 全員）して URL をコピー</li>' +
        '<li><a class="link" href="https://www.strava.com/settings/api" target="_blank" rel="noopener">Strava の API 設定</a>でアプリを作る。認証コールバックドメインは <code>script.google.com</code></li>' +
        '<li>クライアントID とシークレットを Apps Script の スクリプト プロパティ に <code>STRAVA_CLIENT_ID</code> <code>STRAVA_CLIENT_SECRET</code> として保存し、<code>setup</code> を実行</li>' +
        '<li>下に URL を貼って「接続」→「Strava と連携する」</li></ol></div>' +
        '<div class="set-row" style="gap:8px"><input class="field" id="apiIn" placeholder="https://script.google.com/macros/s/…/exec" autocomplete="off" autocapitalize="off"><button class="btn sm primary" data-act="set-api">接続</button></div>';
    }
    h += '</div>';

    h += '<div class="sec-h"><span>心拍</span></div><div class="card">' +
      numRow('hrMax', '最大心拍数', '空欄なら記録から自動（いま ' + d.P.max + '）', d.P.auto ? String(d.P.max) : '') +
      numRow('hrRest', '安静時心拍数', '朝起きてすぐの心拍。走力スコアの精度に影響', '60') +
      numRow('refHr', '目安にする心拍', '「この心拍で何分/kmで走れるか」の基準', '150') + '</div>';
    h += '<div class="sec-h"><span>目標</span></div><div class="card">' +
      numRow('weeklyKm', '週の距離（km）', '', '20') + numRow('monthlyKm', '月の距離（km）', '', '80') + numRow('shoeLife', 'シューズ寿命の目安（km）', '靴ごとの設定はシューズ画面で', '700') + '</div>';
    h += '<div class="sec-h"><span>その他</span></div><div class="card">' +
      '<div class="set-row"><button class="link" data-act="explain">指標の見かた</button></div>' +
      (!S.api ? '<div class="set-row"><span class="l">サンプルデータ</span><button class="btn sm ' + (S.data.demo ? 'danger" data-act="demo-off">消す' : 'gray" data-act="demo">表示する') + '</button></div>' : '') +
      '</div><p class="hint" style="text-align:center;margin-top:18px">ランログ · 記録は Strava から自動で取り込み、スプレッドシートに保存されます</p>';
    return h;
  }

  function explain(k) {
    const P = derive().P;
    let h = '<div class="card pad explain">';
    if (k === 'form') {
      h += '<p><b>トレーニング負荷</b>は、走った時間と心拍の高さから計算します（TRIMP）。心拍が高いほど、同じ時間でも負荷は大きくなります。</p>' +
        '<p><b>体力</b>は過去6週間ほどの負荷の積み上げ、<b>疲労</b>は直近1週間の負荷です。</p>' +
        '<p><b>調子</b> = 体力 − 疲労。マイナスが大きいほど疲れがたまっていて、プラスなら疲れが抜けてフレッシュな状態です。レース前に練習量を落として調子をプラスにするのが「テーパリング」です。</p>' +
        '<p>体力の線が少しずつ右上がりなら、順調に積み上げられています。疲労が体力を大きく上回る状態が続くと、ケガや不調の原因になります。</p>';
    } else {
      h += '<p><b>走力スコア（推定VO2max）</b>は、ペースと心拍数から計算する持久力の指標です。「どのくらいのペースで走ったか」と「そのとき心拍の余力をどれだけ使ったか」から、全力で走ったらどこまで出せるかを推定します。レースをしなくても、普段のジョグで毎回更新されます。</p>' +
        '<p>予想タイムは、このスコアから J. ダニエルズの計算式（VDOT）で出した目安です。距離が長いほど、練習量（特にロング走）が足りないと予想より遅くなりがちです。</p>' +
        '<p><b>心拍効率</b>は「心臓が1回打つあいだに何m進んだか」。同じ心拍でも速く走れるようになる＝有酸素能力が伸びている、ということです。暑い日や疲れている日は下がるので、1回ではなく線の傾きを見てください。</p>' +
        '<p>登りは平地の距離に換算しています（1m登る ≒ 平地6m）。</p>' +
        '<p>精度は<b>最大心拍数</b>と<b>安静時心拍数</b>で大きく変わります。いまは最大 ' + P.max + (P.auto ? '（記録からの自動推定）' : '') + '、安静時 ' + P.rest + ' で計算しています。設定から変えられます。</p>' +
        '<p class="muted">光学式の心拍計（腕時計）は走りはじめの数分がずれやすく、短いランは計算から除いています（15分未満・2km未満）。</p>';
    }
    openSheet(k === 'form' ? '体力・疲労・調子' : '指標の見かた', '', h + '</div>');
  }

  /* ---------------- 描画 ---------------- */
  function render() {
    Object.keys(charts).forEach(k => { if (k.indexOf('ch-') === 0 && !document.querySelector('#sheet #' + k)) delete charts[k]; });
    const v = { home: vHome, runs: vRuns, growth: vGrowth, shoes: vShoes, settings: vSettings }[S.tab] || vHome;
    $('#main').innerHTML = v();
    $('#tabbar').innerHTML = TABS.map(t => '<button class="tab' + (S.tab === t[0] ? ' on' : '') + '" data-tab="' + t[0] + '">' + ICON[t[0]] + '<span>' + t[1] + '</span></button>').join('');
    drawCharts();
  }
  function openSheet(title, sub, body) {
    $('#sheet').innerHTML = '<div class="sh-h"><div><h3>' + title + '</h3>' + (sub ? '<div class="dt">' + sub + '</div>' : '') + '</div><button class="close-x" data-act="close">×</button></div><div class="sh-b">' + body + '</div>';
    $('#sheet').hidden = false; $('#sheetBack').hidden = false;
    document.body.style.overflow = 'hidden';
    drawCharts();
  }
  function closeSheet() {
    $('#sheet').hidden = true; $('#sheetBack').hidden = true; $('#sheet').innerHTML = '';
    document.body.style.overflow = '';
  }

  document.addEventListener('click', e => {
    const b = e.target.closest('button, a');
    if (!b) return;
    if (b.dataset.tab) { S.tab = b.dataset.tab; store.set(TAB_KEY, S.tab); closeSheet(); render(); window.scrollTo(0, 0); return; }
    if (b.dataset.go) { S.tab = b.dataset.go; store.set(TAB_KEY, S.tab); closeSheet(); render(); window.scrollTo(0, 0); return; }
    if (b.dataset.run) { runDetail(b.dataset.run); return; }
    if (b.dataset.pr) { prDetail(+b.dataset.pr); return; }
    if (b.dataset.shoe) { shoeDetail(b.dataset.shoe); return; }
    if (b.dataset.filter) { S.runFilter = b.dataset.filter; S.monthsShown = 6; render(); return; }
    if (b.dataset.range) { S.range = b.dataset.range; render(); return; }
    const act = b.dataset.act;
    if (!act) return;
    if (act === 'close') closeSheet();
    else if (act === 'sync') sync('manual');
    else if (act === 'sync-manual') sync('manual');
    else if (act === 'sync-full') { if (confirm('Strava の記録一覧を全部取り直します（Strava で消した記録も反映されます）。よろしいですか？')) sync('full'); }
    else if (act === 'more') { S.monthsShown = (S.monthsShown || 6) + 6; render(); }
    else if (act === 'explain') explain(b.dataset.k);
    else if (act === 'demo') { store.set(DEMO_KEY, true); loadData(); S.tab = 'home'; render(); }
    else if (act === 'demo-off') { store.del(DEMO_KEY); loadData(); render(); }
    else if (act === 'connect') connectStrava();
    else if (act === 'set-api') {
      const v = ($('#apiIn').value || '').trim();
      if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(v)) { toast('…/exec で終わる Apps Script の URL を貼ってください'); return; }
      S.api = v; store.set(API_KEY, v); store.del(DEMO_KEY); loadData(); render();
      refreshStatus().then(() => { if (S.status && S.status.connected) sync('manual'); });
    }
    else if (act === 'unset-api') { if (confirm('連携 URL を外しますか？（スプレッドシートのデータは消えません）')) { S.api = ''; store.del(API_KEY); store.del(DATA_KEY); S.status = null; loadData(); render(); } }
    else if (act === 'disconnect') {
      if (!confirm('Strava との連携を解除しますか？取り込み済みの記録は残ります。')) return;
      api('disconnect').then(refreshStatus).then(() => toast('連携を解除しました')).catch(err => toast(err.message));
    }
  });
  $('#sheetBack').addEventListener('click', closeSheet);
  document.addEventListener('change', e => {
    const el = e.target;
    if (el.dataset.cfg) {
      const v = el.value === '' ? (el.dataset.cfg === 'hrMax' ? 0 : DEF_CFG[el.dataset.cfg]) : Math.max(0, +el.value);
      S.cfg[el.dataset.cfg] = v; saveCfg(); render();
    }
    if (el.dataset.limit) {
      S.cfg.shoeLimits = Object.assign({}, S.cfg.shoeLimits, { [el.dataset.limit]: Math.max(50, +el.value || S.cfg.shoeLife) });
      saveCfg(); render();
    }
  });
  let resizeT;
  window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(drawCharts, 150); });
  // Strava の許可画面から戻ってきたら状態を取り直す
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !S.api) return;
    const c = store.get('runlog:connecting', 0);
    if (c && Date.now() - c < 30 * 60e3) { store.del('runlog:connecting'); refreshStatus().then(() => sync('manual')); }
    else if (!S.lastSync || Date.now() - S.lastSync > 10 * 60e3) sync();
  });

  loadData();
  render();
  if (S.api) { if (!S.status) refreshStatus(); sync(); }
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js');
})();
