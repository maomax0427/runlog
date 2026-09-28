// ランログ — 指標の計算（画面には依存しない）
(function () {
  const RUN = { Run: 1, TrailRun: 1, VirtualRun: 1 };
  const DAY = 86400e3;

  const isRun = a => !!RUN[a.type];
  const t = a => new Date(a.date).getTime();
  const dayKey = d => { const x = new Date(d); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
  const startOfDay = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
  // 週は月曜はじまり
  const startOfWeek = d => { const x = new Date(startOfDay(d)); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x.getTime(); };
  const startOfMonth = d => { const x = new Date(d); return new Date(x.getFullYear(), x.getMonth(), 1).getTime(); };

  /* ---------- 表示 ---------- */
  const paceSec = a => (a.km > 0 ? a.mt / a.km : null);
  function fmtPace(sec) {
    if (!sec || !isFinite(sec)) return '–';
    const s = Math.round(sec);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  function fmtDur(sec, short) {
    if (sec == null || !isFinite(sec)) return '–';
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
    if (short && h) return h + '時間' + (m ? m + '分' : '');
    if (short) return m + '分';
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
  }
  const fmtKm = (km, d = 1) => (km || 0).toFixed(d);

  /* ---------- 心拍 ---------- */
  // 最大心拍：設定が無ければ記録の最大値の上位（誤計測を避けて上から3番目程度）
  function hrParams(acts, cfg) {
    let max = +cfg.hrMax || 0, auto = false;
    if (!max) {
      const xs = acts.filter(a => isRun(a) && a.hrMax > 120 && a.hrMax < 225).map(a => a.hrMax).sort((a, b) => b - a);
      max = xs.length ? xs[Math.min(2, xs.length - 1)] : 190;
      auto = true;
    }
    const rest = +cfg.hrRest || 60;
    return { max: max, rest: rest, auto: auto };
  }
  const hrr = (hr, P) => (hr - P.rest) / (P.max - P.rest);

  /* ---------- 走力（VO2max / VDOT, Daniels の式） ---------- */
  const vo2AtSpeed = v => -4.6 + 0.182258 * v + 0.000104 * v * v;             // v: m/分
  const pctMax = tMin => 0.8 + 0.1894393 * Math.exp(-0.012778 * tMin) + 0.2989558 * Math.exp(-0.1932605 * tMin);
  function vdot(distM, sec) {
    if (!distM || !sec) return null;
    const tMin = sec / 60;
    return vo2AtSpeed(distM / tMin) / pctMax(tMin);
  }
  // VDOT から、その距離の予想タイム（秒）
  function predict(v, distM) {
    if (!v) return null;
    let lo = 60, hi = 60 * 60 * 10;
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2;
      if (vdot(distM, mid) > v) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }
  // 登りを平地に換算した距離（1m 登る ≒ 平地 6m）
  const flatM = a => a.km * 1000 + (a.elev || 0) * 6;

  // 心拍からの推定 VO2max：そのペースで使う酸素量 ÷ 心拍の余力の使い具合（%HRR ≒ %VO2R）
  function hrVo2(a, P) {
    if (!isRun(a) || !a.hr || a.mt < 15 * 60 || a.km < 2) return null;
    const r = hrr(a.hr, P);
    if (r < 0.45 || r > 0.97) return null;
    const vo2 = vo2AtSpeed(flatM(a) / (a.mt / 60));
    const est = (vo2 - 3.5) / r + 3.5;
    return est > 20 && est < 90 ? est : null;
  }

  // 記録（ベスト記録や全体タイム）からの VDOT。短すぎる区間は除く
  const EFFORT_M = { '1 mile': 1609, '2 mile': 3219, '5K': 5000, '10K': 10000, '15K': 15000, '10 mile': 16093, '20K': 20000, 'Half-Marathon': 21097, '30K': 30000, 'Marathon': 42195 };
  function raceVdot(a) {
    if (!isRun(a)) return null;
    let best = null;
    (a.efforts || []).forEach(e => { const d = EFFORT_M[e[0]]; if (d) { const v = vdot(d, e[1]); if (v && (!best || v > best)) best = v; } });
    if (a.km >= 3) { const v = vdot(a.km * 1000, a.mt); if (v && (!best || v > best)) best = v; }
    return best;
  }

  /**
   * 走力スコアの推移。各ランの心拍推定値の、直近6週間の加重平均（新しいほど重い）
   * 心拍の無い期間はスコアなし
   */
  function fitnessSeries(runs, P) {
    const pts = runs.map(a => ({ t: t(a), v: hrVo2(a, P), a: a })).filter(p => p.v);
    const out = [];
    pts.forEach((p, i) => {
      let sw = 0, sv = 0;
      for (let j = i; j >= 0 && p.t - pts[j].t <= 42 * DAY; j--) {
        const w = Math.exp(-(p.t - pts[j].t) / (21 * DAY)) * Math.min(1, pts[j].a.mt / 2400);
        sw += w; sv += w * pts[j].v;
      }
      out.push({ t: p.t, raw: p.v, v: sv / sw, a: p.a });
    });
    return out;
  }
  function scoreAt(series, when) {
    let s = null;
    for (const p of series) { if (p.t <= when) s = p; else break; }
    return s && when - s.t < 60 * DAY ? s.v : null;
  }

  /* ---------- 心拍効率（1拍で進む距離） ---------- */
  function efficiency(a) {
    if (!isRun(a) || !a.hr || a.mt < 10 * 60 || a.km < 2) return null;
    return flatM(a) / (a.hr * a.mt / 60);
  }

  /* ---------- 負荷（TRIMP）と 体力・疲労・調子 ---------- */
  function trimp(a, P) {
    const min = a.mt / 60;
    if (a.hr) {
      const r = Math.max(0, Math.min(1, hrr(a.hr, P)));
      const f = isRun(a) ? 1 : 0.7;
      return min * r * 0.64 * Math.exp(1.92 * r) * f;
    }
    return min * (isRun(a) ? 0.9 : 0.5);   // 心拍が無い日はそこそこの強度とみなす
  }
  // 体力 = 42日の指数移動平均、疲労 = 7日、調子 = 体力 − 疲労
  function loadSeries(acts, P, until) {
    if (!acts.length) return [];
    const daily = {};
    acts.forEach(a => { const k = startOfDay(t(a)); daily[k] = (daily[k] || 0) + trimp(a, P); });
    const first = startOfDay(t(acts[0]));
    const end = startOfDay(until || Date.now());
    const out = [];
    let ctl = 0, atl = 0;
    const k1 = 1 - Math.exp(-1 / 42), k2 = 1 - Math.exp(-1 / 7);
    for (let d = first; d <= end; d = startOfDay(d + DAY * 1.5)) {
      const x = daily[d] || 0;
      ctl += (x - ctl) * k1; atl += (x - atl) * k2;
      out.push({ t: d, ctl: ctl, atl: atl, tsb: ctl - atl, load: x });
    }
    return out;
  }
  function formLabel(tsb, ctl) {
    const r = ctl > 5 ? tsb / ctl : 0;
    if (ctl < 5) return { k: 'none', t: 'データを集め中' };
    if (r > 0.25) return { k: 'fresh', t: 'フレッシュ', d: '疲れは抜けています。レースやポイント練習に◎' };
    if (r > -0.1) return { k: 'good', t: 'ちょうどいい', d: '無理なく鍛えられている状態' };
    if (r > -0.3) return { k: 'build', t: '鍛えている最中', d: '疲労がたまり気味。質の高い練習は様子を見て' };
    return { k: 'over', t: '疲労注意', d: '急に負荷が増えています。休養日を入れましょう' };
  }

  /* ---------- 集計 ---------- */
  function sumRuns(runs) {
    const o = { n: runs.length, km: 0, mt: 0, elev: 0 };
    runs.forEach(a => { o.km += a.km; o.mt += a.mt; o.elev += a.elev || 0; });
    o.pace = o.km ? o.mt / o.km : null;
    return o;
  }
  // 期間ごとに区切る。unit: 'week' | 'month'
  function buckets(runs, unit, from, to) {
    const start = unit === 'week' ? startOfWeek : startOfMonth;
    const next = k => { const d = new Date(k); if (unit === 'week') d.setDate(d.getDate() + 7); else d.setMonth(d.getMonth() + 1); return d.getTime(); };
    const out = [];
    for (let k = start(from); k <= to; k = next(k)) out.push({ k: k, end: next(k), runs: [] });
    runs.forEach(a => { const k = start(t(a)); const b = out.find(x => x.k === k); if (b) b.runs.push(a); });
    return out.map(b => Object.assign(b, sumRuns(b.runs)));
  }

  /* ---------- 自己ベスト ---------- */
  const PR_DIST = [
    { key: '1K', name: '1km', m: 1000 },
    { key: '1 mile', name: '1マイル', m: 1609 },
    { key: '5K', name: '5km', m: 5000 },
    { key: '10K', name: '10km', m: 10000 },
    { key: 'Half-Marathon', name: 'ハーフ', m: 21097 },
    { key: 'Marathon', name: 'フル', m: 42195 },
  ];
  // Strava のベスト記録が無い（詳細未取得の）ランは、距離がほぼその距離のランの全体タイムで代用
  function prs(runs) {
    const res = {};
    PR_DIST.forEach(d => { res[d.key] = { d: d, best: null, history: [] }; });
    runs.slice().sort((a, b) => t(a) - t(b)).forEach(a => {
      const cands = {};
      (a.efforts || []).forEach(e => { if (res[e[0]]) cands[e[0]] = e[1]; });
      PR_DIST.forEach(d => {
        if (cands[d.key] == null && a.km * 1000 >= d.m * 0.995 && a.km * 1000 <= d.m * 1.03) cands[d.key] = a.mt * d.m / (a.km * 1000);
      });
      Object.keys(cands).forEach(k => {
        const r = res[k], sec = cands[k];
        if (!r.best || sec < r.best.sec) {
          const rec = { sec: sec, a: a, prev: r.best ? r.best.sec : null };
          r.best = rec; r.history.push(rec);
        }
      });
    });
    return PR_DIST.map(d => res[d.key]);
  }

  /* ---------- シューズ ---------- */
  function shoes(acts, gear) {
    const map = {};
    gear.forEach(g => { map[g.id] = Object.assign({ runs: [], appKm: 0 }, g); });
    acts.filter(isRun).forEach(a => {
      if (!a.gear) return;
      if (!map[a.gear]) map[a.gear] = { id: a.gear, name: '（削除された靴）', km: 0, retired: true, runs: [], appKm: 0 };
      map[a.gear].runs.push(a); map[a.gear].appKm += a.km;
    });
    return Object.values(map).map(g => {
      const s = sumRuns(g.runs);
      const total = Math.max(g.km || 0, g.appKm);
      const last = g.runs.length ? g.runs[g.runs.length - 1] : null;
      const ef = g.runs.map(efficiency).filter(Boolean);
      return Object.assign(g, { total: total, n: s.n, pace: s.pace, last: last, first: g.runs[0] || null,
        ef: ef.length ? ef.reduce((x, y) => x + y, 0) / ef.length : null, longest: g.runs.reduce((m, a) => Math.max(m, a.km), 0) });
    }).sort((a, b) => (a.retired - b.retired) || ((b.last ? t(b.last) : 0) - (a.last ? t(a.last) : 0)));
  }

  /* ---------- 心拍ゾーン（心拍予備量 = カルボーネン法） ---------- */
  const ZONES = [
    { n: 'Z1', name: 'リカバリー', d: 'ごく楽。ウォームアップや疲労抜き' },
    { n: 'Z2', name: '有酸素ベース', d: '会話できる楽さ。持久力の土台を作る' },
    { n: 'Z3', name: 'テンポ', d: 'ややきつい。マラソンペース前後' },
    { n: 'Z4', name: '閾値', d: 'きつい。ハーフ〜10kmのレースペース' },
    { n: 'Z5', name: '最大', d: '非常にきつい。インターバルの疾走区間' },
  ];
  const ZONE_F = [0.6, 0.7, 0.8, 0.9];
  const zoneBpm = P => ZONE_F.map(f => Math.round(P.rest + f * (P.max - P.rest)));
  function zoneOf(hr, bounds) { let z = 0; while (z < 4 && hr >= bounds[z]) z++; return z; }
  // hz.h（2bpm ごとの滞在秒）→ ゾーンごとの秒
  function zoneSec(hz, P) {
    const out = [0, 0, 0, 0, 0];
    if (!hz || !hz.h) return out;
    const b = zoneBpm(P);
    Object.keys(hz.h).forEach(k => { out[zoneOf(+k + 1, b)] += hz.h[k]; });
    return out;
  }
  // 心拍の推移 [[秒, 心拍, 距離m]] → 一覧用のまとめ（Apps Script の hrSummary_ と同じ計算）
  function hrSummary(p) {
    if (!p || !p.length) return null;
    const h = {};
    for (let i = 1; i < p.length; i++) {
      const dt = p[i][0] - p[i - 1][0];
      if (dt <= 0 || dt > 120 || !p[i][1]) continue;
      const k = String(Math.floor(p[i][1] / 2) * 2);
      h[k] = (h[k] || 0) + dt;
    }
    let dr = null;
    const T = p[p.length - 1][0];
    if (T >= 1800) {
      const s0 = T * 0.1, mid = s0 + (T - s0) / 2;
      const half = (a, b) => {
        const q = p.filter(x => x[0] >= a && x[0] <= b);
        if (q.length < 3) return null;
        const hr = q.reduce((s, x) => s + x[1], 0) / q.length;
        return (q[q.length - 1][2] - q[0][2]) / (q[q.length - 1][0] - q[0][0]) / hr;
      };
      const a = half(s0, mid), b = half(mid, T);
      if (a && b) dr = Math.round((a - b) / a * 1000) / 10;
    }
    return { h: h, dr: dr };
  }
  // 推移からペース（秒/km）を前後 window 秒の平均で
  function paceStream(p, win) {
    win = win || 60;
    return p.map((x, i) => {
      let j = i, k = i;
      while (j > 0 && x[0] - p[j - 1][0] <= win / 2) j--;
      while (k < p.length - 1 && p[k + 1][0] - x[0] <= win / 2) k++;
      const dd = p[k][2] - p[j][2], dt = p[k][0] - p[j][0];
      return dd > 5 && dt > 0 ? dt / dd * 1000 : null;
    });
  }

  function rolling(values, n) {
    return values.map((_, i) => {
      const w = values.slice(Math.max(0, i - n + 1), i + 1).filter(v => v != null);
      return w.length ? w.reduce((a, b) => a + b, 0) / w.length : null;
    });
  }

  window.M = {
    DAY, isRun, t, dayKey, startOfDay, startOfWeek, startOfMonth, paceSec, fmtPace, fmtDur, fmtKm,
    hrParams, hrr, vdot, predict, hrVo2, raceVdot, fitnessSeries, scoreAt, efficiency, trimp, loadSeries, formLabel,
    sumRuns, buckets, PR_DIST, prs, shoes, rolling, EFFORT_M,
    ZONES, zoneBpm, zoneOf, zoneSec, hrSummary, paceStream,
  };
})();
