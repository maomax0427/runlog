/**
 * ランログ — Strava 取り込み用 Apps Script
 *
 * スプレッドシート「ランログデータ」の 拡張機能 → Apps Script に貼り付けて:
 *   1. プロジェクトの設定 → スクリプト プロパティ に次の2つを追加
 *        STRAVA_CLIENT_ID      … Strava の「マイAPIアプリケーション」のクライアントID
 *        STRAVA_CLIENT_SECRET  … 同じ画面のクライアントシークレット
 *   2. 関数「setup」を一度実行（権限を承認）。1時間ごとの自動取り込みも登録されます
 *   3. デプロイ → 新しいデプロイ → 種類「ウェブアプリ」
 *        次のユーザーとして実行：自分 / アクセスできるユーザー：全員
 *   発行された URL をアプリの 設定 → 連携 に貼ります（他人に教えないこと）。
 *   Strava の API アプリ設定の「認証コールバックドメイン」は script.google.com にします。
 *
 * シート
 *   activities … 1アクティビティにつき1行（分析用。splits / efforts 列はアプリ用の JSON）
 *   gear       … Strava に登録したシューズ
 *   config     … アプリの設定（A2 に JSON）
 *
 * Strava のトークンはスクリプト プロパティに保存され、シートには書きません。
 */
const ACT_SHEET = 'activities';
const GEAR_SHEET = 'gear';
const CFG_SHEET = 'config';
const ACT_HEAD = ['id', '日時', '名前', '種別', '距離(km)', '移動時間(秒)', '経過時間(秒)', 'ペース(/km)',
  '獲得標高(m)', '平均心拍', '最大心拍', 'ケイデンス(spm)', 'gearId', '靴', 'トレッドミル', 'ワークアウト種別',
  '相対的努力', 'カロリー', '詳細', 'splits', 'efforts'];
const GEAR_HEAD = ['gearId', '名前', '距離(km)', '引退', 'メイン'];
const RUN_TYPES = { Run: 1, TrailRun: 1, VirtualRun: 1 };
const DETAIL_PER_SYNC = 25;   // 1回の同期で詳細（ラップ・ベスト記録）を取りに行く件数。Strava の上限（15分100回）対策
const API = 'https://www.strava.com/api/v3';

const props_ = () => PropertiesService.getScriptProperties();
const ss_ = () => SpreadsheetApp.getActiveSpreadsheet();
const tz_ = () => Session.getScriptTimeZone();

function sheet_(name, head) {
  let sh = ss_().getSheetByName(name);
  if (!sh) {
    sh = ss_().insertSheet(name);
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}
function actSheet_() {
  const sh = sheet_(ACT_SHEET, ACT_HEAD);
  sh.getRange('A:A').setNumberFormat('@');
  sh.getRange('B:B').setNumberFormat('yyyy-mm-dd hh:mm');
  sh.getRange('M:M').setNumberFormat('@');
  return sh;
}
const gearSheet_ = () => sheet_(GEAR_SHEET, GEAR_HEAD);
function cfgSheet_() {
  let sh = ss_().getSheetByName(CFG_SHEET);
  if (!sh) {
    sh = ss_().insertSheet(CFG_SHEET);
    sh.getRange('A1').setValue('config (JSON)').setFontWeight('bold');
    sh.getRange('A2').setNumberFormat('@');
  }
  return sh;
}

/** 初回に一度だけ実行 */
function setup() {
  actSheet_(); gearSheet_(); cfgSheet_();
  const sh1 = ss_().getSheetByName('シート1') || ss_().getSheetByName('Sheet1');
  if (sh1 && sh1.getLastRow() === 0 && ss_().getSheets().length > 1) ss_().deleteSheet(sh1);
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'syncStrava').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncStrava').timeBased().everyHours(1).create();
  const p = props_().getProperties();
  Logger.log(p.STRAVA_CLIENT_ID && p.STRAVA_CLIENT_SECRET ? '準備OK。ウェブアプリとしてデプロイしてください。'
    : 'スクリプト プロパティに STRAVA_CLIENT_ID と STRAVA_CLIENT_SECRET を入れてください。');
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Strava の認可画面から戻ってくる先（redirect_uri = このウェブアプリの URL）
function doGet(e) {
  const q = (e && e.parameter) || {};
  if (q.error) return page_('連携できませんでした', 'Strava で許可されませんでした（' + q.error + '）。アプリからもう一度お試しください。');
  if (q.code) {
    try {
      const scope = String(q.scope || '');
      exchange_(q.code);
      let msg = 'アプリに戻って「同期」を押してください。';
      if (scope.indexOf('activity:read') < 0) msg = 'アクティビティの閲覧が許可されていません。アプリからもう一度連携し、すべてにチェックを入れてください。';
      try { withLock_(() => sync_(false)); } catch (err) { msg = '連携はできましたが、取り込みでエラー: ' + err.message; }
      return page_('Strava と連携しました', msg);
    } catch (err) {
      return page_('連携できませんでした', String(err.message || err));
    }
  }
  return json_(status_());
}

function page_(title, msg) {
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return HtmlService.createHtmlOutput(
    '<div style="font-family:-apple-system,sans-serif;max-width:420px;margin:48px auto;padding:0 20px;text-align:center">' +
    '<div style="font-size:44px">🏃</div><h2>' + esc(title) + '</h2><p style="color:#666;line-height:1.6">' + esc(msg) + '</p></div>')
    .setTitle(title).addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents || '{}');
    switch (req.action) {
      case 'status': return json_(status_());
      case 'load': {
        let sync = null;
        if (req.sync && connected_()) {
          try { sync = withLock_(() => sync_(false)); } catch (err) { sync = { error: String(err.message || err) }; }
        }
        return json_(Object.assign({ ok: true, sync: sync }, load_()));
      }
      case 'resync': {
        const r = withLock_(() => sync_(true));
        return json_(Object.assign({ ok: true, sync: r }, load_()));
      }
      case 'saveConfig':
        cfgSheet_().getRange('A2').setValue(JSON.stringify(req.config || {}));
        return json_({ ok: true });
      case 'disconnect':
        ['ACCESS_TOKEN', 'REFRESH_TOKEN', 'EXPIRES_AT', 'ATHLETE'].forEach(k => props_().deleteProperty(k));
        return json_({ ok: true });
      default: return json_({ ok: false, error: 'unknown action' });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return { busy: true };
  try { return fn(); } finally { lock.releaseLock(); }
}

const connected_ = () => !!props_().getProperty('REFRESH_TOKEN');

function status_() {
  const p = props_().getProperties();
  return {
    ok: true, clientId: p.STRAVA_CLIENT_ID || '', hasSecret: !!p.STRAVA_CLIENT_SECRET,
    connected: !!p.REFRESH_TOKEN, athlete: p.ATHLETE ? JSON.parse(p.ATHLETE) : null, lastSync: p.LAST_SYNC || null,
  };
}

/* ---------------- Strava 認証 ---------------- */

function tokenRequest_(payload) {
  const p = props_().getProperties();
  if (!p.STRAVA_CLIENT_ID || !p.STRAVA_CLIENT_SECRET) throw new Error('スクリプト プロパティに STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET がありません');
  payload.client_id = p.STRAVA_CLIENT_ID;
  payload.client_secret = p.STRAVA_CLIENT_SECRET;
  const res = UrlFetchApp.fetch('https://www.strava.com/oauth/token', { method: 'post', payload: payload, muteHttpExceptions: true });
  const body = JSON.parse(res.getContentText() || '{}');
  if (res.getResponseCode() !== 200) throw new Error('Strava 認証エラー: ' + (body.message || res.getResponseCode()));
  const save = { ACCESS_TOKEN: body.access_token, REFRESH_TOKEN: body.refresh_token, EXPIRES_AT: String(body.expires_at) };
  if (body.athlete) {
    const a = body.athlete;
    save.ATHLETE = JSON.stringify({ id: a.id, name: [a.lastname, a.firstname].filter(Boolean).join(' '), photo: a.profile_medium || '' });
  }
  props_().setProperties(save);
  return body;
}

function exchange_(code) {
  if (!code) throw new Error('code がありません');
  tokenRequest_({ code: code, grant_type: 'authorization_code' });
}

function token_() {
  const p = props_().getProperties();
  if (!p.REFRESH_TOKEN) throw new Error('Strava と未連携です');
  if (p.ACCESS_TOKEN && Number(p.EXPIRES_AT) - 300 > Date.now() / 1000) return p.ACCESS_TOKEN;
  return tokenRequest_({ refresh_token: p.REFRESH_TOKEN, grant_type: 'refresh_token' }).access_token;
}

function get_(path, token) {
  const res = UrlFetchApp.fetch(API + path, { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  const code = res.getResponseCode();
  if (code === 429) { const e = new Error('Strava の回数制限に達しました。しばらくすると自動で続きを取り込みます'); e.rate = true; throw e; }
  if (code !== 200) throw new Error('Strava API エラー ' + code + ': ' + res.getContentText().slice(0, 200));
  return JSON.parse(res.getContentText());
}

/* ---------------- 取り込み ---------------- */

/** 1時間ごとのトリガーから呼ばれる */
function syncStrava() {
  if (!connected_()) return;
  withLock_(() => sync_(false));
}

// Strava の start_date_local は「現地時刻に Z が付いた」形式なので、そのまま現地時刻として Date にする
function localDate_(s) {
  const m = String(s).match(/(\d+)-(\d+)-(\d+)T(\d+):(\d+):(\d+)/);
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}
const r1_ = v => (v == null || v === '' ? '' : Math.round(v * 10) / 10);
function paceStr_(sec, km) {
  if (!km) return '';
  const p = Math.round(sec / km);
  return Math.floor(p / 60) + ':' + ('0' + (p % 60)).slice(-2);
}

function actRow_(a, gearNames) {
  const km = (a.distance || 0) / 1000;
  const run = !!RUN_TYPES[a.sport_type || a.type];
  const cad = a.average_cadence ? Math.round(a.average_cadence * (run ? 2 : 1)) : '';
  return [String(a.id), localDate_(a.start_date_local), a.name || '', a.sport_type || a.type || '',
    Math.round(km * 1000) / 1000, a.moving_time || 0, a.elapsed_time || 0, paceStr_(a.moving_time, km),
    r1_(a.total_elevation_gain), r1_(a.average_heartrate), a.max_heartrate || '', cad,
    a.gear_id || '', gearNames[a.gear_id] || '', !!a.trainer, a.workout_type == null ? '' : a.workout_type,
    a.suffer_score == null ? '' : a.suffer_score, '', false, '', ''];
}

function gearNames_() {
  const sh = gearSheet_();
  const map = {};
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(r => { map[r[0]] = r[1]; });
  return map;
}

function saveGear_(token) {
  const a = get_('/athlete', token);
  const shoes = (a.shoes || []).map(s => [s.id, s.name || s.nickname || '', r1_((s.distance || 0) / 1000), !!s.retired, !!s.primary]);
  const sh = gearSheet_();
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, GEAR_HEAD.length).clearContent();
  if (shoes.length) sh.getRange(2, 1, shoes.length, GEAR_HEAD.length).setValues(shoes);
  props_().setProperty('GEAR_AT', String(Date.now()));
}

/**
 * full=false: 前回より新しいアクティビティだけ取得（初回は全件）
 * full=true : 一覧を全件取り直す（Strava 側で消した・直した記録を反映）。取得済みの詳細は残す
 */
function sync_(full) {
  const token = token_();
  const sh = actSheet_();
  const W = ACT_HEAD.length;
  const last = sh.getLastRow();
  const rows = last > 1 ? sh.getRange(2, 1, last - 1, W).getValues() : [];
  const byId = {};
  rows.forEach((r, i) => { byId[String(r[0])] = i; });

  let added = 0, newest = 0;
  if (!full) rows.forEach(r => { const t = r[1] instanceof Date ? r[1].getTime() : 0; if (t > newest) newest = t; });

  // ギアは新規があった時か6時間おきに更新
  const gearAt = Number(props_().getProperty('GEAR_AT') || 0);
  let gearFetched = false;
  if (!rows.length || full || Date.now() - gearAt > 6 * 3600e3) { saveGear_(token); gearFetched = true; }
  let names = gearNames_();

  // 一覧（after は UTC 秒。現地時刻とのずれを吸収するため1日さかのぼって、重複は id で弾く）
  const after = newest ? Math.floor(newest / 1000) - 86400 : 0;
  const fetched = [];
  for (let page = 1; page < 50; page++) {
    const list = get_('/athlete/activities?per_page=200&page=' + page + (after ? '&after=' + after : ''), token);
    fetched.push.apply(fetched, list);
    if (list.length < 200) break;
  }
  if (!gearFetched && fetched.some(a => a.gear_id && !names[a.gear_id] && byId[String(a.id)] == null)) { saveGear_(token); names = gearNames_(); }

  const seen = {};
  fetched.forEach(a => {
    const id = String(a.id);
    seen[id] = true;
    const row = actRow_(a, names);
    if (byId[id] != null) {
      const old = rows[byId[id]];
      row[17] = old[17]; row[18] = old[18]; row[19] = old[19]; row[20] = old[20];   // 詳細は残す
      rows[byId[id]] = row;
    } else {
      byId[id] = rows.length; rows.push(row); added++;
    }
  });
  let removed = 0;
  let out = rows;
  if (full) { out = rows.filter(r => seen[String(r[0])]); removed = rows.length - out.length; }
  // 靴の名前を最新に
  out.forEach(r => { if (r[12]) r[13] = names[r[12]] || r[13]; });

  // 詳細（ラップ・ベスト記録・カロリー）を新しいランから少しずつ
  const pending = out.map((r, i) => i).filter(i => RUN_TYPES[out[i][3]] && out[i][18] !== true)
    .sort((a, b) => out[b][1] - out[a][1]).slice(0, DETAIL_PER_SYNC);
  let detailed = 0, note = '';
  for (let k = 0; k < pending.length; k++) {
    const r = out[pending[k]];
    try {
      const d = get_('/activities/' + r[0], token);
      r[17] = d.calories ? Math.round(d.calories) : '';
      r[18] = true;
      r[19] = JSON.stringify((d.splits_metric || []).map(s => [Math.round(s.distance), s.moving_time, r1_(s.average_heartrate), r1_(s.elevation_difference)]));
      r[20] = JSON.stringify((d.best_efforts || []).map(b => [b.name, b.moving_time, b.pr_rank || 0]));
      detailed++;
    } catch (err) {
      if (err.rate) { note = err.message; break; }
      r[18] = true;   // 取れないもの（削除済み等）は飛ばす
    }
  }

  out.sort((a, b) => a[1] - b[1]);
  if (last > 1) sh.getRange(2, 1, last - 1, W).clearContent();
  if (out.length) sh.getRange(2, 1, out.length, W).setValues(out);
  const leftover = out.filter(r => RUN_TYPES[r[3]] && r[18] !== true).length;
  props_().setProperty('LAST_SYNC', new Date().toISOString());
  return { added: added, removed: removed, detailed: detailed, detailPending: leftover, note: note };
}

/* ---------------- アプリへ返す ---------------- */

function load_() {
  const sh = actSheet_();
  const last = sh.getLastRow();
  const tz = tz_();
  const acts = last > 1 ? sh.getRange(2, 1, last - 1, ACT_HEAD.length).getValues().map(r => ({
    id: String(r[0]),
    date: r[1] instanceof Date ? Utilities.formatDate(r[1], tz, "yyyy-MM-dd'T'HH:mm:ss") : String(r[1]),
    name: r[2], type: r[3], km: Number(r[4]) || 0, mt: Number(r[5]) || 0, et: Number(r[6]) || 0,
    elev: Number(r[8]) || 0, hr: Number(r[9]) || null, hrMax: Number(r[10]) || null, cad: Number(r[11]) || null,
    gear: r[12] || null, tm: r[14] === true, wt: r[15] === '' ? null : Number(r[15]),
    suffer: r[16] === '' ? null : Number(r[16]), cal: Number(r[17]) || null, det: r[18] === true,
    splits: r[19] ? JSON.parse(r[19]) : null, efforts: r[20] ? JSON.parse(r[20]) : null,
  })) : [];
  const gsh = gearSheet_();
  const gear = gsh.getLastRow() > 1 ? gsh.getRange(2, 1, gsh.getLastRow() - 1, GEAR_HEAD.length).getValues()
    .map(r => ({ id: r[0], name: r[1], km: Number(r[2]) || 0, retired: r[3] === true, primary: r[4] === true })) : [];
  let config = null;
  const raw = cfgSheet_().getRange('A2').getValue();
  if (raw) { try { config = JSON.parse(raw); } catch (e) { } }
  return { acts: acts, gear: gear, config: config, status: status_() };
}
