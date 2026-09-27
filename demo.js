// ランログ — お試し用のサンプルデータ（9か月で少しずつ速くなるランナー）
(function () {
  function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }; }

  function make() {
    const R = rng(42);
    const rand = (a, b) => a + (b - a) * R();
    const HRMAX = 188, REST = 55;
    const DAYS = 270;
    const now = new Date(); now.setHours(0, 0, 0, 0);
    const start = now.getTime() - DAYS * 86400e3;
    const speedFor = vo2 => (-0.182258 + Math.sqrt(0.182258 ** 2 + 4 * 0.000104 * (vo2 + 4.6))) / (2 * 0.000104);   // m/分
    const gear = [
      { id: 'g1', name: 'ペガサス 41', km: 0, retired: true, primary: false },
      { id: 'g2', name: 'ノヴァブラスト 5', km: 0, retired: false, primary: true },
      { id: 'g3', name: 'ヴェイパーフライ 3', km: 0, retired: false, primary: false },
    ];
    const acts = [];
    let id = 1000;
    for (let d = 0; d <= DAYS; d++) {
      const day = new Date(start + d * 86400e3);
      const dow = day.getDay();
      const vo2max = 42 + 8 * (1 - Math.exp(-d / 150)) + Math.sin(d / 9) * 0.4;
      let kind = null;
      if (dow === 2 && R() < 0.85) kind = d > 40 ? (R() < 0.5 ? 'interval' : 'tempo') : 'easy';
      else if (dow === 4 && R() < 0.75) kind = 'easy';
      else if (dow === 6 && R() < 0.8) kind = 'easy';
      else if (dow === 0 && R() < 0.85) kind = 'long';
      else if (dow === 1 && R() < 0.2) kind = 'easy';
      if (d === 180) kind = 'race10';
      if (d === 245) kind = 'raceHalf';
      if (dow === 3 && R() < 0.15) {
        acts.push({ id: String(id++), date: iso(day, 7, 30), name: '朝のサイクリング', type: 'Ride', km: rand(15, 30), mt: 3600, et: 3900, elev: 120, hr: 128, hrMax: 150, cad: null, gear: null, tm: false, wt: null, suffer: 20, cal: 500, det: false, splits: null, efforts: null });
      }
      if (!kind) continue;
      let km, r, name, wt = null, hour = 6;
      if (kind === 'easy') { km = rand(5, 9) + d / 90; r = rand(0.62, 0.72); name = ['朝ラン', 'ジョグ', 'イージーラン', '夜ラン'][Math.floor(R() * 4)]; if (name === '夜ラン') hour = 20; }
      else if (kind === 'long') { km = Math.min(28, rand(11, 15) + d / 25); r = rand(0.66, 0.74); name = 'ロング走'; hour = 7; wt = 2; }
      else if (kind === 'tempo') { km = rand(8, 11); r = rand(0.8, 0.86); name = 'テンポ走'; hour = 19; wt = 3; }
      else if (kind === 'interval') { km = rand(7, 9); r = rand(0.78, 0.84); name = '1000m×5 インターバル'; hour = 19; wt = 3; }
      else if (kind === 'race10') { km = 10.05; r = 0.93; name = '秋の10kmロードレース'; hour = 9; wt = 1; }
      else { km = 21.2; r = 0.88; name = 'ハーフマラソン大会'; hour = 9; wt = 1; }
      const elev = kind === 'long' ? rand(60, 180) : rand(10, 60);
      const drift = kind === 'long' ? 0.03 : 0.015;
      const vo2 = (vo2max - 3.5) * r + 3.5;
      const v = speedFor(vo2) * (1 - (elev * 6) / (km * 1000 + elev * 6)) * rand(0.98, 1.02);
      const mt = Math.round(km * 1000 / v * 60);
      const hr = Math.round(REST + (r + drift / 2) * (HRMAX - REST) + rand(-2, 2));
      const race = kind.startsWith('race');
      const shoe = race || kind === 'tempo' ? 'g3' : d < 130 ? 'g1' : 'g2';
      // 1km ごと
      const splits = [];
      let left = km * 1000, i = 0;
      while (left > 50) {
        const dist = Math.min(1000, left);
        const p = mt / km * (race ? 1.01 - i * 0.002 : rand(0.97, 1.04));
        const intv = kind === 'interval' && i >= 2 && i < 7;
        splits.push([Math.round(dist), Math.round(p * dist / 1000 * (intv ? 0.88 : 1)),
          Math.round((hr - 6 + i * drift * 60 + (intv ? 8 : 0)) * 10) / 10, Math.round(rand(-8, 8) * 10) / 10]);
        left -= dist; i++;
      }
      const eff = [];
      const addE = (n, m, f) => { if (km * 1000 >= m) eff.push([n, Math.round(mt / km * m / 1000 * f), 0]); };
      const fast = kind === 'interval' ? 0.88 : 0.985;
      addE('400m', 400, fast * 0.97); addE('1/2 mile', 805, fast * 0.98); addE('1K', 1000, fast); addE('1 mile', 1609, fast * 1.005);
      addE('2 mile', 3219, kind === 'interval' ? 0.95 : 0.99); addE('5K', 5000, kind === 'interval' ? 0.97 : 0.995);
      addE('10K', 10000, 0.998); addE('15K', 15000, 1); addE('10 mile', 16093, 1); addE('20K', 20000, 1); addE('Half-Marathon', 21097, 1);
      acts.push({
        id: String(id++), date: iso(day, hour, Math.floor(rand(0, 50))), name: name, type: 'Run', km: Math.round(km * 1000) / 1000,
        mt: mt, et: Math.round(mt * (race ? 1.001 : rand(1.02, 1.1))), elev: Math.round(elev), hr: hr,
        hrMax: Math.min(HRMAX, Math.round(hr + (race ? 12 : rand(8, 20)))), cad: Math.round(rand(164, 176) + d / 60), gear: shoe,
        tm: false, wt: wt, suffer: Math.round(mt / 60 * r), cal: Math.round(km * 65), det: true, splits: splits, efforts: eff,
      });
    }
    acts.forEach(a => { const g = gear.find(x => x.id === a.gear); if (g) g.km += a.km; });
    gear[0].km += 180;   // サンプル: アプリ導入前に走っていた分
    return { acts: acts, gear: gear, config: null, demo: true };
  }
  function iso(day, h, m) {
    const d = new Date(day); d.setHours(h, m, 0, 0);
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(h) + ':' + p(m) + ':00';
  }
  window.DEMO = { make };
})();
