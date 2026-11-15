/* Jedi Hub: zentrale Konten. Von hier aus kommt man per Einmal-Anmeldung in die Wachen Datenbank (Wachen)
   und das Jedi Wissensarchiv (Gesandter). Node.js, keine Abhängigkeiten. */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'hub.json');
const INDEX_FILE = path.join(__dirname, 'public', 'index.html');
const TRUST_PROXY = process.env.TRUST_PROXY !== '0';
const SESSION_MS = 12 * 60 * 60 * 1000;
const COOKIE = 'hub_sess';
const SSO_SECRET = process.env.HUB_SSO_SECRET || '';
/* Zugänge: Schlüssel im Konto -> Ziel-Seite */
const SITES = {
  schatten: { aud: 'schatten', label: 'Wachen Datenbank', role: 'Wachen', url: (process.env.SCHATTEN_URL || '').replace(/\/+$/, '') },
  gesandter: { aud: 'archiv', label: 'Jedi Wissensarchiv', role: 'Gesandter', url: (process.env.ARCHIV_URL || '').replace(/\/+$/, '') },
  hueter: { aud: 'hueter', label: 'Hüter-Bereich', role: 'Hüter', url: (process.env.HUETER_URL || '').replace(/\/+$/, '') },
  tempelwache: { aud: 'tempelwache', label: 'Tempelwachen-Bereich', role: 'Tempelwache', url: (process.env.TEMPELWACHE_URL || '').replace(/\/+$/, '') }
};
const RESERVED = ['owner', 'mace windu']; // gibt es auf den Seiten schon als lokale Konten
let MAIN = '';

/* ---------- Passwörter ---------- */
const SCRYPT = { N: 16384, r: 8, p: 1 };
function hashPw(pw) { const salt = crypto.randomBytes(16); return 'scrypt$' + salt.toString('hex') + '$' + crypto.scryptSync(String(pw), salt, 64, SCRYPT).toString('hex'); }
function checkPw(pw, stored) {
  const p = String(stored || '').split('$');
  if (p.length !== 3 || p[0] !== 'scrypt') return false;
  const expected = Buffer.from(p[2], 'hex');
  const h = crypto.scryptSync(String(pw), Buffer.from(p[1], 'hex'), expected.length, SCRYPT);
  return h.length === expected.length && crypto.timingSafeEqual(h, expected);
}
if (process.argv[2] === '--hash') { console.log(hashPw(process.argv[3] || '')); process.exit(0); }
function validPassword(p) {
  if (typeof p !== 'string' || p.length < 5 || p.length > 200 || !/\p{L}/u.test(p) || !/[0-9]/.test(p)) { const e = new Error('Das Passwort braucht mindestens 5 Zeichen mit Buchstaben und Zahlen.'); e.status = 400; throw e; }
}
function genPassword() {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz', D = '23456789', ALL = L + D;
  for (;;) { let s = ''; for (let i = 0; i < 12; i++) s += ALL[crypto.randomInt(ALL.length)]; if (/[A-Za-z]/.test(s) && /[0-9]/.test(s)) return s.replace(/(.{4})(?=.)/g, '$1-'); }
}
function userKey(n) { return String(n || '').trim().replace(/\s+/g, ' ').toLowerCase(); }
function cleanDisplay(n) { // dieselbe Regel wie in den beiden Seiten, sonst würde dort die Anmeldung scheitern
  const d = String(n || '').trim().replace(/\s+/g, ' ');
  if (d.length < 3 || d.length > 40 || !/^[\p{L}\p{N}][\p{L}\p{N} ._'-]*$/u.test(d)) { const e = new Error('Name: 3 bis 40 Zeichen aus Buchstaben, Zahlen, Leerzeichen, Punkt, Strich.'); e.status = 400; throw e; }
  return d;
}

/* ---------- Speicher (Datei, optional zusätzlich Upstash Redis) ---------- */
let db;
const REMOTE_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const REMOTE_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const REMOTE = !!(REMOTE_URL && REMOTE_TOKEN);
const REMOTE_KEY = 'hub:db'; // eigener Schlüssel, damit er sich nicht mit den anderen Seiten überschneidet
let remoteBusy = false, remoteDirty = false, remoteOk = true;
async function remoteCmd(cmd) {
  const r = await fetch(REMOTE_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + REMOTE_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
  return j.result;
}
async function remoteFlush() {
  if (!REMOTE) return;
  if (remoteBusy) { remoteDirty = true; return; }
  remoteBusy = true;
  try { do { remoteDirty = false; await remoteCmd(['SET', REMOTE_KEY, JSON.stringify(db)]); remoteOk = true; } while (remoteDirty); }
  catch (e) { remoteOk = false; console.error('Dauerspeicher fehlgeschlagen:', e.message); setTimeout(remoteFlush, 5000); }
  remoteBusy = false;
}
async function remotePull() {
  if (!REMOTE) return;
  try {
    const val = await remoteCmd(['GET', REMOTE_KEY]);
    if (val) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(DB_FILE, val, { mode: 0o600 }); console.log('Daten aus dem Dauerspeicher geladen.'); }
  } catch (e) { console.error('Dauerspeicher nicht erreichbar:', e.message); }
}
function save() {
  remoteFlush();
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); const tmp = DB_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 }); fs.renameSync(tmp, DB_FILE); }
  catch (e) { console.error('Speichern fehlgeschlagen:', e.message); }
}
function logAct(u, a, t) { db.logs.push({ ts: Date.now(), u: u ? u.display : '–', a: a, t: t || '' }); if (db.logs.length > 1000) db.logs.splice(0, db.logs.length - 1000); }
function load() {
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { db = null; }
  if (!db || typeof db !== 'object') db = {};
  if (!db.users || typeof db.users !== 'object') db.users = {};
  if (!Array.isArray(db.logs)) db.logs = [];
  if (!db.secret) db.secret = crypto.randomBytes(32).toString('hex');
  if (process.env.SESSION_SECRET) db.secret = process.env.SESSION_SECRET;
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'owner.json'), 'utf8'));
  const name = String(process.env.OWNER_USER || cfg.username).toLowerCase();
  MAIN = name;
  let u = db.users[name];
  if (!u) u = db.users[name] = { name, display: name.charAt(0).toUpperCase() + name.slice(1), created: new Date().toISOString(), since: Date.now(), hash: process.env.OWNER_PASSWORD ? hashPw(process.env.OWNER_PASSWORD) : cfg.hash };
  else if (process.env.OWNER_PASSWORD && !checkPw(process.env.OWNER_PASSWORD, u.hash)) { u.hash = hashPw(process.env.OWNER_PASSWORD); u.since = Date.now(); }
  u.owner = true; u.admin = true; delete u.blocked;
  u.access = { schatten: true, gesandter: true };
  save();
}

/* ---------- Sitzung ---------- */
const b64 = function (s) { return Buffer.from(s).toString('base64url'); };
function sign(data) { return crypto.createHmac('sha256', db.secret).update(data).digest('base64url'); }
function makeToken(name) { const body = b64(JSON.stringify({ u: name, iat: Date.now(), exp: Date.now() + SESSION_MS })); return body + '.' + sign(body); }
function sessionUser(req) {
  const m = new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)').exec(req.headers.cookie || '');
  if (!m) return null;
  const parts = m[1].split('.');
  if (parts.length !== 2) return null;
  const a = Buffer.from(parts[1]), b = Buffer.from(sign(parts[0]));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let t; try { t = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!t || t.exp < Date.now()) return null;
  const u = db.users[t.u];
  if (!u || t.iat < (u.since || 0) || u.blocked) return null;
  return u;
}
function isHttps(req) { return !!req.socket.encrypted || (TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'); }
function setCookie(res, req, value, maxAge) { res.setHeader('Set-Cookie', COOKIE + '=' + value + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + maxAge + (isHttps(req) ? '; Secure' : '')); }
const fails = new Map();
function clientIp(req) { if (TRUST_PROXY && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim(); return req.socket.remoteAddress || 'x'; }
function limited(key, max) { const e = fails.get(key); if (!e) return false; if (Date.now() - e.t > 15 * 60 * 1000) { fails.delete(key); return false; } return e.n >= max; }
function fail(key) { const e = fails.get(key); if (!e || Date.now() - e.t > 15 * 60 * 1000) fails.set(key, { n: 1, t: Date.now() }); else e.n++; }
setInterval(function () { const now = Date.now(); fails.forEach(function (v, k) { if (now - v.t > 15 * 60 * 1000) fails.delete(k); }); }, 5 * 60 * 1000).unref();

/* ---------- Anbindung an die Seiten ---------- */
function siteToken(kind, u, aud, ttl, extra) {
  const body = b64(JSON.stringify(Object.assign({ u: u.name, d: u.display, aud: aud, exp: Date.now() + ttl, jti: crypto.randomBytes(12).toString('hex') }, extra || {})));
  return body + '.' + crypto.createHmac('sha256', SSO_SECRET).update(kind + '.' + body).digest('base64url');
}
function hasAccess(u, key) { return !!(u && !u.blocked && u.access && u.access[key]); }
/* Konten-Abgleich: Der Hub führt (Name, Passwort-Hash, Sperre). u.sync[k] = 'ok' | 'wait' | 'conflict' */
const HASH_RE = /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/;
async function callSite(key, endpoint, kind, u, extra) {
  const s = SITES[key];
  if (!s.url || !SSO_SECRET) return { status: 0 };
  try {
    const r = await fetch(s.url + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'shadow-net' }, body: JSON.stringify({ t: siteToken(kind, u, s.aud, 120000, extra) }), signal: AbortSignal.timeout(70000) });
    let j = {}; try { j = await r.json(); } catch (e) { /* leer */ }
    return { status: r.status, json: j };
  } catch (e) { return { status: 0 }; }
}
async function pushOne(u, key, del, tries) {
  if (u.owner) return;
  const want = !del && hasAccess(u, key);
  if (!want && !(u.onSite && u.onSite[key])) return;
  const r = await callSite(key, '/api/hub/sync', 'sync', u, { h: u.hash, mc: !!u.mustChange, blk: !want });
  if (!del && db.users[u.name] !== u) return;
  u.sync = u.sync || {}; u.onSite = u.onSite || {};
  if (r.status === 200) { u.sync[key] = 'ok'; if (want) u.onSite[key] = true; }
  else if (r.status === 409) u.sync[key] = 'conflict';
  else { u.sync[key] = 'wait'; if (tries > 1) setTimeout(function () { pushOne(u, key, del, tries - 1); }, 20000).unref(); }
  if (!del) save();
}
function syncUser(u, del, only) { Object.keys(SITES).forEach(function (k) { if (!only || only.indexOf(k) >= 0) pushOne(u, k, !!del, 4); }); }
setInterval(function () { // hängende Abgleiche (Seite schlief) regelmäßig wiederholen
  Object.keys(db.users).forEach(function (n) { const u = db.users[n]; Object.keys(u.sync || {}).forEach(function (k) { if (u.sync[k] === 'wait') pushOne(u, k, false, 1); }); });
}, 10 * 60 * 1000).unref();
async function importFrom(key) { // vorhandene Konten einer Seite in den Hub übernehmen
  const res = { added: 0, merged: 0, unified: 0, skipped: 0, error: '' };
  const r = await callSite(key, '/api/hub/export', 'export', { name: 'hub', display: 'hub' });
  if (r.status !== 200 || !r.json || !Array.isArray(r.json.users)) { res.error = SITES[key].url && SSO_SECRET ? 'Seite nicht erreichbar oder HUB_SSO_SECRET passt nicht.' : 'Adresse oder HUB_SSO_SECRET fehlt.'; return res; }
  r.json.users.forEach(function (x) {
    let display; try { display = cleanDisplay(x.d); } catch (e) { res.skipped++; return; }
    const k = userKey(display);
    if (RESERVED.indexOf(k) >= 0 || !HASH_RE.test(String(x.h))) { res.skipped++; return; }
    let u = db.users[k];
    if (u && u.owner) { res.skipped++; return; }
    if (!u) { u = db.users[k] = { name: k, display: display, hash: x.h, created: new Date().toISOString(), since: Date.now(), access: cleanAccess({}), admin: false }; if (x.mc) u.mustChange = true; res.added++; }
    else { res.merged++; if (u.hash !== x.h) res.unified++; }
    u.access = u.access || cleanAccess({}); u.access[key] = true; u.onSite = u.onSite || {}; u.onSite[key] = true; u.sync = u.sync || {}; u.sync[key] = 'ok';
  });
  return res;
}

/* ---------- Helfer ---------- */
function headers(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
}
function send(res, status, obj) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
function readBody(req) {
  return new Promise(function (resolve, reject) {
    let size = 0; const chunks = [];
    req.on('data', function (c) { size += c.length; if (size > 50 * 1024) { const e = new Error('Anfrage zu groß.'); e.status = 413; reject(e); req.destroy(); return; } chunks.push(c); });
    req.on('end', function () { if (!chunks.length) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { const err = new Error('Ungültiges JSON.'); err.status = 400; reject(err); } });
    req.on('error', reject);
  });
}
function need(req, admin) {
  const u = sessionUser(req);
  if (!u) { const e = new Error('Bitte melde dich an.'); e.status = 401; throw e; }
  if (u.mustChange && req.url.indexOf('/api/password') !== 0) { const e = new Error('Bitte vergib zuerst ein eigenes Passwort.'); e.status = 403; e.code = 'must_change'; throw e; }
  if (admin && !u.admin) { const e = new Error('Dafür fehlen dir die Rechte.'); e.status = 403; throw e; }
  return u;
}
function pub(u) { return { name: u.name, display: u.display, owner: !!u.owner, admin: !!u.admin, access: u.access || {}, blocked: !!u.blocked, mustChange: !!u.mustChange, created: u.created, lastLogin: u.lastLogin || 0, sync: u.sync || {} }; }
function cleanAccess(a) { const o = {}; Object.keys(SITES).forEach(function (k) { o[k] = !!(a && a[k]); }); return o; }
function sitesOut() { return Object.keys(SITES).map(function (k) { return { key: k, label: SITES[k].label, role: SITES[k].role, ready: !!(SITES[k].url && SSO_SECRET) }; }); }
function target(name) { const key = userKey(name); const u = db.users[key]; if (!u) { const e = new Error('Konto nicht gefunden.'); e.status = 404; throw e; } return u; }

const seen = new Map();
function verifyInbound(tok, kind) {
  if (!SSO_SECRET || typeof tok !== 'string' || tok.length > 3000) return null;
  const parts = tok.split('.'); if (parts.length !== 2) return null;
  const good = Buffer.from(crypto.createHmac('sha256', SSO_SECRET).update(kind + '.' + parts[0]).digest('base64url')), got = Buffer.from(parts[1]);
  if (good.length !== got.length || !crypto.timingSafeEqual(good, got)) return null;
  let t; try { t = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch (e) { return null; }
  const now = Date.now();
  if (!t || typeof t.jti !== 'string' || !(t.exp > now) || t.exp > now + 5 * 60 * 1000) return null;
  seen.forEach(function (e, k) { if (e < now) seen.delete(k); });
  if (seen.has(t.jti)) return null; seen.set(t.jti, t.exp);
  return t;
}
async function api(req, res, url) {
  const method = req.method, p = url.pathname;
  if (method !== 'GET' && (req.headers['x-requested-with'] !== 'jedi-hub' || !/^application\/json/.test(req.headers['content-type'] || (method === 'DELETE' ? 'application/json' : '')))) return send(res, 400, { error: 'Ungültige Anfrage.' });

  if (p === '/api/site/passwd' && method === 'POST') { // eine Seite meldet: Konto hat dort sein Passwort geändert
    const b = await readBody(req), t = verifyInbound(b && b.t, 'passwd');
    const key = t && Object.keys(SITES).filter(function (k) { return SITES[k].aud === t.aud; })[0];
    const u = t && key && db.users[userKey(t.d)];
    if (!u || u.owner || !hasAccess(u, key) || !HASH_RE.test(String(t.h))) return send(res, 403, { error: 'Ungültig.' });
    u.hash = t.h; u.since = Date.now(); delete u.mustChange; logAct(u, 'Passwort geändert (über ' + SITES[key].label + ')', ''); save();
    syncUser(u, false, Object.keys(SITES).filter(function (k) { return k !== key; }));
    return send(res, 200, { ok: true });
  }
  if (p === '/api/session' && method === 'GET') { const u = sessionUser(req); return send(res, 200, { user: u ? pub(u) : null, sites: sitesOut() }); }
  if (p === '/api/login' && method === 'POST') {
    const b = await readBody(req), ip = clientIp(req), name = userKey(String(b.username || '').slice(0, 60));
    if (limited('ip:' + ip, 8) || limited('u:' + name, 30)) return send(res, 429, { error: 'Zu viele Versuche. Bitte warte 15 Minuten.' });
    const u = db.users[name];
    const ok = u ? checkPw(String(b.password || ''), u.hash) : (checkPw('x', 'scrypt$00$00'), false);
    if (!ok) { fail('ip:' + ip); fail('u:' + name); logAct(u || null, 'Anmeldung fehlgeschlagen', u ? '' : 'Name: ' + name.slice(0, 40)); save(); return send(res, 401, { error: 'Benutzername oder Passwort stimmt nicht.' }); }
    if (u.blocked) return send(res, 401, { error: 'Dieses Konto ist gesperrt.' });
    fails.delete('ip:' + ip); fails.delete('u:' + name);
    u.lastLogin = Date.now(); logAct(u, 'Anmeldung', ''); save();
    setCookie(res, req, makeToken(u.name), Math.floor(SESSION_MS / 1000));
    return send(res, 200, { user: pub(u), sites: sitesOut() });
  }
  if (p === '/api/logout' && method === 'POST') { setCookie(res, req, '', 0); return send(res, 200, { ok: true }); }
  if (p === '/api/password' && method === 'POST') {
    const u = need(req); const b = await readBody(req);
    if (!checkPw(String(b.current || ''), u.hash)) return send(res, 400, { error: 'Das aktuelle Passwort stimmt nicht.' });
    validPassword(b.next);
    if (checkPw(String(b.next), u.hash)) return send(res, 400, { error: 'Das neue Passwort muss sich vom bisherigen unterscheiden.' });
    u.hash = hashPw(b.next); u.since = Date.now(); delete u.mustChange; logAct(u, 'Passwort geändert', ''); save(); syncUser(u);
    setCookie(res, req, makeToken(u.name), Math.floor(SESSION_MS / 1000));
    return send(res, 200, { ok: true, user: pub(u) });
  }
  if (p === '/api/launch' && method === 'POST') { // Einmal-Anmeldung auf einer der Seiten
    const u = need(req); const b = await readBody(req);
    const key = String(b.target || ''), s = SITES[key];
    if (!s) return send(res, 400, { error: 'Unbekanntes Ziel.' });
    if (!hasAccess(u, key)) return send(res, 403, { error: 'Dein Konto hat keinen Zugang zu: ' + s.label + '.' });
    if (!s.url || !SSO_SECRET) return send(res, 503, { error: s.label + ' ist im Hub noch nicht verbunden (Adresse oder HUB_SSO_SECRET fehlt).' });
    logAct(u, 'Betritt ' + s.label, ''); save();
    if (u.owner) return send(res, 200, { url: s.url }); // Haupt-Owner hat auf den Seiten eigene lokale Konten: normale Anmeldeseite
    return send(res, 200, { url: s.url + '/api/sso?t=' + siteToken('sso', u, s.aud, 60000) });
  }
  if (p === '/api/users' && method === 'GET') {
    need(req, true);
    return send(res, 200, { storage: REMOTE ? (remoteOk ? 'remote' : 'remote-error') : 'file', users: Object.keys(db.users).map(function (k) { return pub(db.users[k]); }).sort(function (a, b) { return (b.owner - a.owner) || a.display.localeCompare(b.display, 'de'); }) });
  }
  if (p === '/api/users' && method === 'POST') {
    const me = need(req, true); const b = await readBody(req);
    const display = cleanDisplay(b.username), key = userKey(display);
    if (db.users[key] || RESERVED.indexOf(key) >= 0) return send(res, 400, { error: 'Diesen Namen gibt es schon.' });
    if (b.admin && !me.owner) return send(res, 403, { error: 'Hub-Verwalter legt nur das Haupt-Owner-Konto an.' });
    const pw = genPassword();
    db.users[key] = { name: key, display: display, hash: hashPw(pw), created: new Date().toISOString(), since: Date.now(), mustChange: true, access: cleanAccess(b.access), admin: !!b.admin };
    logAct(me, 'Konto angelegt', display + ' (' + Object.keys(SITES).filter(function (k) { return db.users[key].access[k]; }).map(function (k) { return SITES[k].role; }).join(', ') + ')'); save(); syncUser(db.users[key]);
    return send(res, 200, { ok: true, username: display, password: pw });
  }
  const m = /^\/api\/users\/([^/]+)(\/reset)?$/.exec(p);
  if (m) {
    const me = need(req, true), u = target(decodeURIComponent(m[1]));
    if (u.owner) return send(res, 403, { error: 'Das Haupt-Owner-Konto kann hier nicht geändert werden.' });
    if (u.admin && !me.owner) return send(res, 403, { error: 'Hub-Verwalter verwaltet nur das Haupt-Owner-Konto.' });
    if (m[2] && method === 'POST') {
      const pw = genPassword(); u.hash = hashPw(pw); u.since = Date.now(); u.mustChange = true; logAct(me, 'Passwort neu erzeugt', u.display); save(); syncUser(u);
      return send(res, 200, { ok: true, username: u.display, password: pw });
    }
    if (method === 'PUT') {
      const b = await readBody(req), lost = [];
      if (b.access) {
        const na = cleanAccess(b.access);
        Object.keys(SITES).forEach(function (k) { if (u.access && u.access[k] && !na[k]) lost.push(k); });
        u.access = na; logAct(me, 'Zugang geändert', u.display + ': ' + (Object.keys(SITES).filter(function (k) { return na[k]; }).map(function (k) { return SITES[k].role; }).join(', ') || 'keiner'));
      }
      if (typeof b.blocked === 'boolean') { if (b.blocked && !u.blocked) { u.blocked = true; u.since = Date.now(); lost.push.apply(lost, Object.keys(SITES)); } else if (!b.blocked) delete u.blocked; logAct(me, b.blocked ? 'Konto gesperrt' : 'Konto entsperrt', u.display); }
      if (typeof b.admin === 'boolean') { if (!me.owner) return send(res, 403, { error: 'Hub-Verwalter vergibt nur das Haupt-Owner-Konto.' }); u.admin = b.admin; logAct(me, b.admin ? 'Zum Hub-Verwalter gemacht' : 'Hub-Verwalter entzogen', u.display); }
      save(); syncUser(u);
      return send(res, 200, { ok: true, user: pub(u) });
    }
    if (method === 'DELETE') { delete db.users[u.name]; logAct(me, 'Konto gelöscht', u.display); save(); syncUser(u, true); return send(res, 200, { ok: true }); }
  }
  if (p === '/api/import' && method === 'POST') {
    const me = need(req, true); const out = {};
    for (const k of Object.keys(SITES)) { if (SITES[k].url) out[k] = await importFrom(k); }
    logAct(me, 'Konten von den Seiten übernommen', Object.keys(out).map(function (k) { return SITES[k].role + ': ' + out[k].added + ' neu, ' + out[k].merged + ' zusammengeführt'; }).join('; ')); save();
    Object.keys(db.users).forEach(function (n) { syncUser(db.users[n]); });
    return send(res, 200, { ok: true, result: out, labels: Object.keys(SITES).reduce(function (o, k) { o[k] = SITES[k].label; return o; }, {}) });
  }
  if (p === '/api/sync' && method === 'POST') { need(req, true); Object.keys(db.users).forEach(function (n) { const u = db.users[n]; Object.keys(SITES).forEach(function (k) { pushOne(u, k, false, 4); }); }); return send(res, 200, { ok: true }); }
  if (p === '/api/logs' && method === 'GET') { need(req, true); return send(res, 200, { logs: db.logs.slice(-300).reverse() }); }
  return send(res, 404, { error: 'Nicht gefunden.' });
}

const server = http.createServer(function (req, res) {
  headers(res);
  const url = new URL(req.url, 'http://x');
  if (url.pathname.indexOf('/api/') === 0) {
    api(req, res, url).catch(function (e) {
      if (!e.status) console.error('API-Fehler bei ' + req.method + ' ' + url.pathname + ':', e && e.stack || e);
      if (!res.headersSent) { const o = { error: e.status ? e.message : 'Serverfehler.' }; if (e.code) o.code = e.code; send(res, e.status || 500, o); }
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    return fs.readFile(INDEX_FILE, function (err, buf) {
      if (err) { res.writeHead(500); return res.end('index.html fehlt'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : buf);
    });
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Nicht gefunden');
});

remotePull().then(function () {
  load();
  if (!SSO_SECRET) console.warn('WARNUNG: HUB_SSO_SECRET fehlt – die Weiterleitung auf die Seiten ist deaktiviert.');
  server.listen(PORT, '0.0.0.0', function () { console.log('Jedi Hub läuft auf Port ' + PORT + (REMOTE ? ', Dauerspeicher aktiv' : ', FLÜCHTIG: ohne Dauerspeicher gehen Änderungen beim Neustart verloren')); });
});
