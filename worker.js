// instabox-waker: manual-only wake panel for one InstaBox machine, behind Cloudflare Access.
// Config (Worker vars/secrets): INSTABOX_API_KEY, INSTABOX_MACHINE_ID, ACCESS_TEAM_DOMAIN, ACCESS_AUD,
//   CF_API_TOKEN, CF_ACCOUNT_ID, ACCESS_POLICY_ID, SETUP_TOKEN (first run only), Durable Object binding WAKER_STATE;
//   optional DISPLAY_TIMEZONE, SERVICE_TOKEN_IDS, SETUP_ACCESS_APP_ID, ADMIN_EMAILS (legacy fallback). See README.md.
// No cron, no scheduled handler, no auto-wake. Wake happens only on POST /api/wake (button press).
const API = 'https://api.instabox.sh';
const CF = 'https://api.cloudflare.com/client/v4';
const CLOCK_SKEW_S = 60;          // allowed clock skew for exp / nbf
const JWKS_TTL_MS = 3600e3;       // cache Access certs for 1 h
const JWKS_FORCE_MIN_MS = 30e3;   // refetch certs on unknown kid at most every 30 s
const ALLOW_TTL_MS = 60e3;        // cache the live allow list for 60 s
const PENDING_TTL_MS = 15 * 60e3; // first-run setup: the pending admin email must verify within 15 min
const PLACEHOLDER_EMAIL = 'nobody@setup.invalid'; // keeps the policy include non-empty before setup

// ---------------- Access JWT verification ----------------
const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
let jwks = null, jwksAt = 0, jwksForcedAt = 0;
async function loadJwks(env) {
  try {
    const r = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
    if (!r.ok) return false;
    const keys = (await r.json()).keys;
    if (!Array.isArray(keys)) return false;
    jwks = keys.filter(k => k && k.kty === 'RSA' && typeof k.kid === 'string');
    jwksAt = Date.now();
    return true;
  } catch { return false; }
}
async function findKey(env, kid) {
  if (!jwks || Date.now() - jwksAt > JWKS_TTL_MS) await loadJwks(env);
  let jwk = jwks && jwks.find(k => k.kid === kid);
  if (!jwk && Date.now() - jwksForcedAt > JWKS_FORCE_MIN_MS) {   // key rotation: refetch once
    jwksForcedAt = Date.now();
    await loadJwks(env);
    jwk = jwks && jwks.find(k => k.kid === kid);
  }
  return jwk || null;
}
async function verifyAccess(req, env) {
  const tok = req.headers.get('cf-access-jwt-assertion');
  if (!tok || !env.ACCESS_AUD || !env.ACCESS_TEAM_DOMAIN) return null;
  const parts = tok.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  let header, payload;
  try { header = JSON.parse(new TextDecoder().decode(b64url(h))); payload = JSON.parse(new TextDecoder().decode(b64url(p))); } catch { return null; }
  if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string' || !payload || typeof payload !== 'object') return null;
  const jwk = await findKey(env, header.kid);
  if (!jwk) return null;
  let ok = false;
  try {
    const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(s), new TextEncoder().encode(`${h}.${p}`));
  } catch { return null; }
  if (!ok) return null;
  const now = Date.now() / 1000;
  if (typeof payload.exp !== 'number' || now > payload.exp + CLOCK_SKEW_S) return null;   // exp is required
  if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || now + CLOCK_SKEW_S < payload.nbf)) return null;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) return null;
  if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
  return payload;
}

// ---------------- Persistent state (Durable Object) ----------------
// One strongly consistent object holds: done flag, admin list, pending first-run email, cleanup bookkeeping.
// Every operation runs inside blockConcurrencyWhile, so setup steps are atomic (no claim races).
const csv = (v) => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
const normEmail = (e) => (typeof e === 'string' ? e.trim().toLowerCase() : '');
const envAdmins = (env) => csv(env.ADMIN_EMAILS).map(s => s.toLowerCase());
const adminsOf = (s, env) => (s.admins && s.admins.length ? s.admins : envAdmins(env));
const isDone = (s, env) => !!s.done || envAdmins(env).length > 0;
function view(s, env) {
  return { done: isDone(s, env), admins: adminsOf(s, env), denied: s.toRemove || [], hasPending: !!s.pending,
    setupAt: s.setupAt || null, setupApp: s.setupApp || null, legacy: !s.done && envAdmins(env).length > 0 };
}
async function removeFromPolicy(env, s) {   // retry removals of expired/abandoned setup emails until they succeed
  if (!s.toRemove || !s.toRemove.length) return;
  try {
    const pol = await readPolicy(env);
    const admins = adminsOf(s, env);
    const drop = s.toRemove.filter(e => !admins.includes(e));
    let next = emailsOf(pol).filter(e => !drop.includes(e));
    if (!next.length) next = [PLACEHOLDER_EMAIL];
    if (emailsOf(pol).some(e => drop.includes(e))) await writeEmails(env, pol, next, true);
    s.toRemove = [];
  } catch { /* keep for the next attempt; these emails are denied meanwhile */ }
}
async function stateOp(sto, env, op, a) {
  const s = (await sto.get('s')) || {};
  const save = () => sto.put('s', s);
  let dirty = false;
  if (s.pending && Date.now() > s.pending.exp) {   // never verified in time -> drop it
    if (s.pending.added) (s.toRemove = s.toRemove || []).push(s.pending.email);
    s.pending = null; dirty = true;
  }
  if (s.toRemove && s.toRemove.length) { await removeFromPolicy(env, s); dirty = true; }
  if (dirty) await save();
  switch (op) {
    case 'get': return view(s, env);
    case 'start': {
      if (isDone(s, env)) return { error: 'done' };
      const email = normEmail(a.email);
      if (s.pending && s.pending.added && s.pending.email !== email) { (s.toRemove = s.toRemove || []).push(s.pending.email); s.pending = null; await removeFromPolicy(env, s); }
      const pol = await readPolicy(env);
      const cur = emailsOf(pol);
      const added = !cur.includes(email) || !!(s.pending && s.pending.email === email && s.pending.added);
      const next = [...cur.filter(e => !e.endsWith('.invalid') && e !== email), email];
      await writeEmails(env, pol, next, true);
      s.pending = { email, exp: Date.now() + PENDING_TTL_MS, added };
      s.toRemove = (s.toRemove || []).filter(e => e !== email);
      await save();
      if (sto.setAlarm) await sto.setAlarm(s.pending.exp + 5e3);
      return { ok: true, expiresAt: new Date(s.pending.exp).toISOString() };
    }
    case 'complete': {
      if (isDone(s, env)) return { error: 'done' };
      const email = normEmail(a.email);
      if (!s.pending || s.pending.email !== email) return { error: 'no_pending' };
      s.done = true; s.admins = [email]; s.setupAt = new Date().toISOString(); s.pending = null;
      await save();                       // the done flag is persisted before anything else happens
      s.setupApp = await deleteSetupApp(env);
      await save();
      return { ok: true };
    }
    case 'promote': case 'demote': {
      if (!isDone(s, env)) return { error: 'not_setup' };
      const email = normEmail(a.email);
      const admins = adminsOf(s, env);
      if (op === 'promote') { if (!admins.includes(email)) s.admins = [...admins, email]; else return { ok: true, ...view(s, env) }; }
      else {
        if (!admins.includes(email)) return { error: 'not_admin' };
        if (admins.length <= 1) return { error: 'last_admin' };
        s.admins = admins.filter(e => e !== email);
      }
      s.done = true; await save();
      return { ok: true, ...view(s, env) };
    }
    case 'ack': { if (s.setupApp) { s.setupApp.ack = true; await save(); } return view(s, env); }
    default: return { error: 'bad_op' };
  }
}
async function deleteSetupApp(env) {
  // Best effort: works only if CF_API_TOKEN may edit Access apps. Either way /setup is 404 forever (done flag).
  if (!env.SETUP_ACCESS_APP_ID || !/^[0-9a-f-]{36}$/.test(env.SETUP_ACCESS_APP_ID)) return { deleted: false, reason: 'no_app_id' };
  const r = await cf(env, 'DELETE', `/accounts/${env.CF_ACCOUNT_ID}/access/apps/${env.SETUP_ACCESS_APP_ID}`);
  return r.ok ? { deleted: true } : { deleted: false, reason: 'http_' + r.status };
}
export class WakerState {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async fetch(req) {
    const op = new URL(req.url).pathname.slice(1);
    const args = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    let out;
    await this.ctx.blockConcurrencyWhile(async () => {
      try { out = await stateOp(this.ctx.storage, this.env, op, args); } catch (e) { out = { error: 'internal', message: String(e && e.message || e) }; }
    });
    return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } });
  }
  async alarm() { await this.fetch(new Request('https://state/get')); }   // drops an expired pending email
}
async function state(env, op = 'get', args) {
  if (!env.WAKER_STATE) {   // legacy mode: no Durable Object, admins only from ADMIN_EMAILS
    const admins = envAdmins(env);
    return op === 'get' ? { done: admins.length > 0, admins, denied: [], legacy: true, noState: true } : { error: 'no_state' };
  }
  const stub = env.WAKER_STATE.get(env.WAKER_STATE.idFromName('global'));
  const r = await stub.fetch(new Request('https://state/' + op, args ? { method: 'POST', body: JSON.stringify(args) } : {}));
  return r.json();
}

// ---------------- Identity / authorization ----------------
const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const isAdmin = (who, st) => { const e = who && normEmail(who.email); return !!e && st.admins.includes(e); };
let allowCache = { set: null, at: 0 };
function cacheAllow(pol) { allowCache = { set: new Set(emailsOf(pol)), at: Date.now() }; }
async function allowList(env) {
  if (allowCache.set && Date.now() - allowCache.at < ALLOW_TTL_MS) return allowCache.set;
  cacheAllow(await readPolicy(env));   // throws on failure -> caller fails closed
  return allowCache.set;
}
// Every request: admins always pass; other emails must be in the live policy list (cached 60 s);
// service tokens (no email) only if their client ID is in SERVICE_TOKEN_IDS. Fail closed.
async function authorize(who, env, st) {
  const email = normEmail(who.email);
  if (email) {
    if (st.admins.includes(email)) return { ok: true };
    if (st.denied.includes(email)) return { ok: false, msg: '你的邮箱不在允许列表中，请联系管理员。' };
    try {
      return (await allowList(env)).has(email) ? { ok: true } : { ok: false, msg: '你的邮箱已不在允许列表中，请联系管理员。' };
    } catch { return { ok: false, msg: '暂时无法校验访问权限，请稍后再试。' }; }
  }
  if (!who.email && typeof who.common_name === 'string' && csv(env.SERVICE_TOKEN_IDS).includes(who.common_name)) return { ok: true };
  return { ok: false, msg: '无访问权限。' };
}

// ---------------- Helpers ----------------
async function ib(env, method, path, idem) {
  const headers = { 'X-API-Key': env.INSTABOX_API_KEY, 'Accept': 'application/json' };
  if (idem) headers['Idempotency-Key'] = crypto.randomUUID();
  try {
    const r = await fetch(API + path, { method, headers });
    let body = null; try { body = await r.json(); } catch {}
    return { status: r.status, body };
  } catch { return { status: 0, body: null }; }
}
function pick(m) {
  return {
    id: m.id, name: m.name, state: m.state, desiredState: m.desiredState, operationId: m.operationId,
    ready: !!(m.runtime && m.runtime.ready), autoSuspendAfterSeconds: m.autoSuspendAfterSeconds,
    autoSuspendedAt: m.autoSuspendedAt || null, runStartedAt: m.runStartedAt || null,
    maxRunMinutes: m.maxRunMinutes ?? null, cooldownUntil: m.cooldownUntil || null, updatedAt: m.updatedAt,
    spec: m.spec, free: m.free,
  };
}
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const SEC_HEADERS = { 'cache-control': 'no-store', 'content-security-policy': CSP, 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...SEC_HEADERS, 'content-type': 'application/json; charset=utf-8' } });
const html = (b, s = 200) => new Response(b, { status: s, headers: { ...SEC_HEADERS, 'content-type': 'text/html; charset=utf-8' } });
const asset = (b, ct) => new Response(b, { headers: { ...SEC_HEADERS, 'content-type': ct } });
const notFound = () => new Response('Not Found', { status: 404, headers: SEC_HEADERS });
const redirect = (to) => new Response(null, { status: 302, headers: { ...SEC_HEADERS, location: to } });
const escHtml = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sameOrigin = (req, url) => { const o = req.headers.get('origin'); return req.headers.get('x-ib-waker') === '1' && (!o || o === url.origin); };
const isJson = (req) => (req.headers.get('content-type') || '').toLowerCase().startsWith('application/json');
// Optional IANA time zone for displayed times (e.g. "Europe/Berlin"); empty = viewer's browser time zone.
function tz(env) {
  const z = String(env.DISPLAY_TIMEZONE || '').trim();
  if (!z) return '';
  try { new Intl.DateTimeFormat('en', { timeZone: z }); return z; } catch { return ''; }
}
const page = (tpl, env, extra = '') => html(tpl.replace('__TZ__', escHtml(tz(env))).replace('<!--ADMINLINK-->', extra));
async function tokenOk(given, expected) {   // constant-time compare of SHA-256 digests
  if (typeof given !== 'string' || typeof expected !== 'string' || expected.length < 16 || given.length > 512) return false;
  const d = async (x) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(x)));
  const [a, b] = await Promise.all([d(given), d(expected)]);
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---------------- First-run setup (/setup, reachable through a path-scoped Access *bypass* app) ----------------
// 1. Deployer opens /setup#t=<SETUP_TOKEN>, enters the initial admin email.
// 2. The Worker records it as pending (15 min) and adds it to the Access allow policy, then sends the browser to /.
// 3. Cloudflare Access emails a one-time code. Only after a verified Access JWT for exactly that email arrives
//    does the Worker mark setup done (permanent), make that email the admin and try to delete the bypass app.
// 4. Once done, every /setup URL returns 404 forever and SETUP_TOKEN is useless. Never verified = never done.
async function handleSetup(req, env, url) {
  if (!env.SETUP_TOKEN || String(env.SETUP_TOKEN).length < 16 || !env.WAKER_STATE) return notFound();
  const st = await state(env);
  if (st.error || st.done) return notFound();
  if (req.method === 'GET' && url.pathname === '/setup') return page(SETUP_PAGE, env);
  if (req.method === 'GET' && url.pathname === '/setup/setup.css') return asset(CSS, 'text/css; charset=utf-8');
  if (req.method === 'GET' && url.pathname === '/setup/setup.js') return asset(SETUP_JS, 'text/javascript; charset=utf-8');
  if (req.method === 'POST' && url.pathname === '/setup/api/start') {
    if (!sameOrigin(req, url)) return json({ error: 'forbidden', message: '请求来源无效' }, 403);
    if (!isJson(req)) return json({ error: 'bad_request', message: '需要 JSON' }, 400);
    let b; try { b = await req.json(); } catch { return json({ error: 'bad_request', message: '请求格式错误' }, 400); }
    if (!(await tokenOk(b && b.token, String(env.SETUP_TOKEN)))) return json({ error: 'bad_token', message: '安装口令不正确' }, 403);
    const email = normEmail(b.email);
    if (!email || email.length > 254 || !EMAIL_RE.test(email) || email.endsWith('.invalid')) return json({ error: 'invalid_email', message: '邮箱格式不正确' }, 400);
    const r = await state(env, 'start', { email });
    if (r.error === 'done') return notFound();
    if (r.error) return json({ error: r.error, message: r.message || '无法写入 Access 策略，请检查 CF_API_TOKEN / ACCESS_POLICY_ID' }, 502);
    return json({ ok: true, email, expiresAt: r.expiresAt, next: '/' });
  }
  return notFound();
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/setup' || url.pathname.startsWith('/setup/')) return handleSetup(req, env, url);

    const who = await verifyAccess(req, env);
    if (!who) return notFound();
    const MID = env.INSTABOX_MACHINE_ID;
    if (!MID || !/^[A-Za-z0-9_-]+$/.test(MID)) return json({ error: 'config', message: 'INSTABOX_MACHINE_ID is not set' }, 500);
    if (req.method === 'GET' && url.pathname === '/assets/app.css') return asset(CSS, 'text/css; charset=utf-8');

    let st = await state(env);
    if (st.error) return json({ error: 'state', message: 'state unavailable' }, 500);
    if (!st.done) {
      // First-run: the only thing an Access-verified user can do is complete a pending setup for their own email.
      const email = normEmail(who.email);
      if (email) {
        const r = await state(env, 'complete', { email });
        if (r.ok) return redirect('/admin?setup=done');
      }
      return html(DENIED_PAGE.replace('__TITLE__', '尚未完成初始化').replace('__MSG__', '本面板还没有管理员。请部署者打开安装链接（/setup）完成初始化；如果安装已超过 15 分钟未验证，请重新提交。'), 403);
    }

    const gate = await authorize(who, env, st);
    if (!gate.ok) {
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin/api/')) return json({ error: 'forbidden', message: gate.msg }, 403);
      return html(DENIED_PAGE.replace('__TITLE__', '无访问权限').replace('__MSG__', escHtml(gate.msg)), 403);
    }

    if (req.method === 'GET') {
      if (url.pathname === '/assets/app.js') return asset(APP_JS, 'text/javascript; charset=utf-8');
      if (url.pathname === '/assets/admin.js') return isAdmin(who, st) ? asset(ADMIN_JS, 'text/javascript; charset=utf-8') : notFound();
    }

    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return handleAdmin(req, env, url, who, st);

    if (url.pathname === '/api/status' && req.method === 'GET') {
      const r = await ib(env, 'GET', `/v1/machines/${MID}`);
      if (r.status !== 200) return json({ error: 'instabox', status: r.status, detail: r.body && r.body.error && r.body.error.code || null }, 502);
      const out = { machine: pick(r.body), serverTime: new Date().toISOString(), user: who.email || who.common_name || null };
      const op = url.searchParams.get('op');
      if (op && /^op_[a-z0-9]{1,64}$/.test(op)) {
        const o = await ib(env, 'GET', `/v1/operations/${op}`);
        // only report operations that belong to the configured machine
        if (o.status === 200 && o.body && o.body.machineId === MID) out.operation = { id: o.body.id, type: o.body.type, state: o.body.state, phase: o.body.phase || null, error: o.body.error || null };
      }
      return json(out);
    }

    if (url.pathname === '/api/wake' && req.method === 'POST') {
      if (!sameOrigin(req, url)) return json({ error: 'forbidden' }, 403);   // CSRF guard
      const g = await ib(env, 'GET', `/v1/machines/${MID}`);
      if (g.status !== 200) return json({ error: 'instabox', status: g.status }, 502);
      const m = g.body;
      if (m.operationId) return json({ action: 'busy', operationId: m.operationId, machine: pick(m) });
      let action, r;
      if (m.state === 'suspended') { action = 'resume'; r = await ib(env, 'POST', `/v1/machines/${MID}/resume`, true); }
      else if (m.state === 'stopped' || m.state === 'error') { action = 'start'; r = await ib(env, 'POST', `/v1/machines/${MID}/start`, true); }
      else if (m.state === 'running') { action = 'touch'; r = await ib(env, 'POST', `/v1/machines/${MID}/wake`); }
      else return json({ action: 'wait', machine: pick(m) });
      const ok = r.status >= 200 && r.status < 300;
      return json({ action, ok, status: r.status, wakeAt: new Date().toISOString(),
        operationId: ok && r.body && r.body.id && String(r.body.id).startsWith('op_') ? r.body.id : null,
        error: ok ? null : (r.body && r.body.error) || null }, ok ? 200 : 502);
    }

    if ((url.pathname === '/' || url.pathname === '/index.html') && req.method === 'GET') {
      return page(PAGE, env, isAdmin(who, st) ? '<a class="alink" href="/admin">管理员面板 →</a>' : '');
    }
    return notFound();
  },
};

// ---------------- Admin: manage allowed emails (Access policy) and admins (Durable Object) ----------------
async function cf(env, method, path, body) {
  try {
    const r = await fetch(CF + path, { method, headers: { 'Authorization': `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, ok: r.ok && j && j.success, body: j };
  } catch { return { status: 0, ok: false, body: null }; }
}
const polPath = (env) => `/accounts/${env.CF_ACCOUNT_ID}/access/policies/${env.ACCESS_POLICY_ID}`;
async function readPolicy(env) {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID || !env.ACCESS_POLICY_ID) throw new Error('未配置 Access 策略');
  const r = await cf(env, 'GET', polPath(env));
  if (!r.ok || !r.body || !r.body.result) throw new Error('读取 Access 策略失败 (' + r.status + ')');
  return r.body.result;
}
const isEmailRule = (x) => x && typeof x === 'object' && Object.keys(x).length === 1 && x.email && typeof x.email.email === 'string';
function emailsOf(pol) {
  return (pol.include || []).filter(isEmailRule).map(x => normEmail(x.email.email));
}
function otherRules(pol) {
  const out = [];
  for (const where of ['include', 'exclude', 'require'])
    for (const r of (pol[where] || [])) if (where !== 'include' || !isEmailRule(r)) out.push({ where, type: Object.keys(r || {}).join(',') || '?', rule: JSON.stringify(r).slice(0, 300) });
  return out;
}
async function writeEmails(env, pol, emails, fromState) {
  // refuse to save when the include list has anything but plain email rules
  if ((pol.include || []).some(x => !isEmailRule(x))) throw Object.assign(new Error('策略中含有非邮箱规则，已拒绝保存，请先在 Cloudflare 面板中处理'), { code: 'other_rules' });
  const body = { name: pol.name, decision: pol.decision, include: emails.map(e => ({ email: { email: e } })), exclude: pol.exclude || [], require: pol.require || [] };
  if (pol.session_duration) body.session_duration = pol.session_duration;
  const r = await cf(env, 'PUT', polPath(env), body);
  if (!r.ok || !r.body || !r.body.result) throw new Error('更新 Access 策略失败 (' + r.status + ')');
  if (!fromState) cacheAllow(r.body.result); else allowCache = { set: null, at: 0 };
  return r.body.result;
}
function listOut(env, pol, st) {
  const admins = st.admins;
  const others = otherRules(pol);
  const sa = st.setupApp;
  return { emails: emailsOf(pol).filter(e => e !== PLACEHOLDER_EMAIL).map(e => ({ email: e, admin: admins.includes(e) })), admins,
    updatedAt: pol.updated_at || null, sessionDuration: pol.session_duration || null, otherRules: others,
    readOnly: others.some(r => r.where === 'include'), canManageAdmins: !st.noState,
    setupNotice: sa && !sa.deleted && !sa.ack && sa.reason !== 'no_app_id' ? 'setup_app_left' : null };
}
async function handleAdmin(req, env, url, who, st) {
  if (!isAdmin(who, st)) {
    if (url.pathname.startsWith('/admin/api/')) return json({ error: 'forbidden', message: '无管理员权限' }, 403);
    return html(FORBIDDEN_PAGE, 403);
  }
  if (url.pathname === '/admin' && req.method === 'GET') return page(ADMIN_PAGE, env);
  if (url.pathname === '/admin/api/emails' && req.method === 'GET') {
    try { const pol = await readPolicy(env); cacheAllow(pol); return json(listOut(env, pol, st)); } catch (e) { return json({ error: 'cf', message: e.message }, 502); }
  }
  const ops = ['add', 'remove', 'promote', 'demote', 'ack-setup'];
  const op = url.pathname.startsWith('/admin/api/') ? url.pathname.slice(11) : '';
  if (ops.includes(op) && req.method === 'POST') {
    if (!sameOrigin(req, url)) return json({ error: 'forbidden', message: '请求来源无效' }, 403);
    if (!isJson(req)) return json({ error: 'bad_request', message: '需要 JSON' }, 400);
    let email = '';
    try { const b = await req.json(); email = b && typeof b.email === 'string' ? normEmail(b.email) : ''; } catch { return json({ error: 'bad_request', message: '请求格式错误' }, 400); }
    try {
      if (op === 'ack-setup') { st = await state(env, 'ack', {}); return json(listOut(env, await readPolicy(env), st)); }
      if (!email || email.length > 254 || !EMAIL_RE.test(email)) return json({ error: 'invalid_email', message: '邮箱格式不正确' }, 400);
      const pol = await readPolicy(env);
      const cur = emailsOf(pol);
      if (op === 'add') {
        if (cur.includes(email)) return json({ error: 'exists', message: '该邮箱已在列表中', ...listOut(env, pol, st) }, 409);
        if (cur.length >= 50) return json({ error: 'too_many', message: '最多 50 个邮箱' }, 400);
        return json({ ok: true, action: 'add', email, ...listOut(env, await writeEmails(env, pol, [...cur.filter(e => e !== PLACEHOLDER_EMAIL), email]), st) });
      }
      if (op === 'remove') {
        if (st.admins.includes(email)) return json({ error: 'locked', message: '管理员邮箱已锁定：请先取消其管理员身份再删除' }, 403);
        if (!cur.includes(email)) return json({ error: 'not_found', message: '列表中没有该邮箱', ...listOut(env, pol, st) }, 404);
        return json({ ok: true, action: 'remove', email, ...listOut(env, await writeEmails(env, pol, cur.filter(e => e !== email)), st) });
      }
      // promote / demote
      if (st.noState) return json({ error: 'no_state', message: '未配置 Durable Object，管理员只能通过 ADMIN_EMAILS 设置' }, 501);
      if (op === 'promote' && !cur.includes(email)) return json({ error: 'not_found', message: '请先把该邮箱加入允许列表' }, 404);
      const r = await state(env, op, { email });
      if (r.error === 'last_admin') return json({ error: 'last_admin', message: '至少要保留一个管理员', ...listOut(env, pol, st) }, 409);
      if (r.error) return json({ error: r.error, message: '操作失败' }, 400);
      return json({ ok: true, action: op, email, ...listOut(env, pol, r) });
    } catch (e) {
      if (e.code === 'other_rules') { let extra = {}; try { extra = listOut(env, await readPolicy(env), st); } catch {} return json({ error: 'other_rules', message: e.message, ...extra }, 409); }
      return json({ error: 'cf', message: e.message }, 502);
    }
  }
  return notFound();
}

// ---------------- Static assets (no inline script/style: strict CSP) ----------------
const CSS = `:root{--bg:#0f172a;--card:#1e293b;--mut:#94a3b8;--fg:#f1f5f9;--g:#22c55e;--y:#f59e0b;--r:#ef4444;--b:#3b82f6}
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans SC",sans-serif;background:var(--bg);color:var(--fg);min-height:100vh;display:flex;justify-content:center;padding:env(safe-area-inset-top) 16px 24px}
main{width:100%;max-width:440px;padding-top:24px}h1{font-size:20px;margin:0 0 4px}.sub{color:var(--mut);font-size:13px;margin-bottom:18px}a{color:#93c5fd}.alink{font-size:13px}
.card{background:var(--card);border-radius:16px;padding:18px;margin-bottom:14px}.mt{margin-top:14px}.mt8{margin-top:8px}
.st{display:flex;align-items:center;gap:10px;font-size:26px;font-weight:700}.dot{width:14px;height:14px;border-radius:50%;background:var(--mut);flex:none}
.running .dot{background:var(--g);box-shadow:0 0 12px var(--g)}.suspended .dot,.stopped .dot{background:var(--r)}.busy .dot{background:var(--y);animation:p 1s infinite}
@keyframes p{50%{opacity:.3}}.meta{color:var(--mut);font-size:13px;margin-top:8px;line-height:1.7}.meta .dim{opacity:.7}
#btn{width:100%;border:0;border-radius:18px;padding:26px 0;font-size:30px;font-weight:800;letter-spacing:6px;color:#fff;background:linear-gradient(135deg,#2563eb,#7c3aed);box-shadow:0 8px 24px rgba(59,130,246,.35)}
button:disabled{opacity:.55}#btn.touch{font-size:20px;letter-spacing:2px;padding:18px 0;background:#334155;box-shadow:none}
.cd{font-size:40px;font-weight:800;font-variant-numeric:tabular-nums}.cd.sm{font-size:28px}.lbl{color:var(--mut);font-size:13px;margin-bottom:6px}.est{display:inline-block;font-size:11px;background:#334155;color:var(--y);border-radius:6px;padding:1px 6px;margin-left:6px}
.bar{height:6px;background:#334155;border-radius:3px;overflow:hidden;margin-top:10px}.bar>i{display:block;height:100%;width:0;background:var(--g);transition:width 1s}
#msg{min-height:20px;font-size:14px;margin:12px 0 8px;color:var(--y);text-align:center}#msg.ok{color:var(--g)}#msg.err{color:var(--r)}.small{font-size:12px;color:var(--mut);line-height:1.6}
.row{display:flex;align-items:center;gap:10px;padding:12px 0;border-bottom:1px solid #334155;word-break:break-all}.row:last-child{border-bottom:0}.row .e{flex:1;font-size:15px}
.lock{font-size:12px;color:var(--y);background:#334155;border-radius:6px;padding:3px 8px;white-space:nowrap}
.del{border:0;border-radius:10px;padding:8px 14px;font-size:14px;font-weight:700;color:#fff;background:#475569;white-space:nowrap}.del.confirm{background:var(--r)}
input{width:100%;font-size:16px;padding:14px;border-radius:12px;border:1px solid #334155;background:#0b1220;color:var(--fg);outline:none}input:focus{border-color:var(--b)}
.add{width:100%;margin-top:10px;border:0;border-radius:14px;padding:16px 0;font-size:18px;font-weight:800;color:#fff;background:linear-gradient(135deg,#2563eb,#7c3aed)}
.mask{position:fixed;inset:0;background:rgba(2,6,23,.75);display:flex;align-items:center;justify-content:center;padding:16px}.modal{width:100%;max-width:420px;background:var(--card);border-radius:18px;padding:22px;box-shadow:0 20px 60px rgba(0,0,0,.5)}.modal h2{margin:0 0 6px;font-size:20px}.modal label{display:block;color:var(--mut);font-size:13px;margin:14px 0 6px}
.mini{border:0;border-radius:10px;padding:8px 12px;font-size:13px;font-weight:700;color:#fff;background:#334155;white-space:nowrap}
.warn{border:1px solid var(--y);color:#fde68a}.warn code{display:block;margin-top:6px;font-size:12px;color:var(--fg);word-break:break-all;white-space:pre-wrap}.hide{display:none}
`;
const HEAD = (title, css = '/assets/app.css') => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0f172a"><meta name="robots" content="noindex"><title>${title}</title><link rel="stylesheet" href="${css}"></head>`;
const DENIED_PAGE = `${HEAD('无访问权限')}<body><main><h1>403 · __TITLE__</h1><div class="sub">__MSG__</div></main></body></html>`;
const SETUP_PAGE = `${HEAD('初始化 · 设置管理员邮箱', '/setup/setup.css')}<body data-tz="__TZ__"><main><h1>InstaBox 唤醒面板</h1><div class="sub">首次安装</div></main>
<div class="mask"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="t">
<h2 id="t">输入初始管理员邮箱</h2><div class="small">这个窗口只会出现一次。提交后会跳转到 Cloudflare 登录页，向这个邮箱发送一次性验证码；<b>只有收到验证码并登录成功</b>，这个邮箱才会成为管理员，安装页随即永久关闭。15 分钟内未完成验证则作废，可重新提交。</div>
<form id="f"><label for="em">管理员邮箱</label><input id="em" type="email" inputmode="email" autocomplete="email" autocapitalize="off" placeholder="you@example.com" required>
<div id="tokrow"><label for="tk">安装口令（SETUP_TOKEN，部署时生成）</label><input id="tk" type="password" autocomplete="off" required></div>
<button class="add" id="go" type="submit">发送验证码</button></form><div id="msg"></div></div></div>
<script src="/setup/setup.js"></script></body></html>`;
const FORBIDDEN_PAGE = `${HEAD('无权限')}<body><main><h1>403 · 无管理员权限</h1><div class="sub">只有管理员邮箱可以访问此页面。</div><a href="/">← 返回唤醒页</a></main></body></html>`;
const PAGE = `${HEAD('InstaBox 唤醒')}<body data-tz="__TZ__"><main>
<h1>InstaBox · <span id="nm"></span></h1><div class="sub">手动唤醒面板（仅按下按钮时唤醒，无自动保活） <!--ADMINLINK--></div>
<div class="card" id="stc"><div class="st"><span class="dot"></span><span id="st">加载中…</span></div>
<div class="meta" id="meta"></div></div>
<button id="btn" disabled>唤醒</button><div id="msg"></div>
<div class="card mt"><div class="lbl">距离自动休眠（空闲 30 分钟）<span class="est">估算</span></div>
<div class="cd" id="cd">--:--</div><div class="bar"><i id="bar"></i></div>
<div class="small mt8" id="cdnote"></div></div>
<div class="card"><div class="lbl">最长连续运行上限（免费版 8 小时，精确）</div><div class="cd sm" id="mr">--</div>
<div class="small" id="mrnote"></div></div>
<div class="small">状态每 10 秒自动刷新。InstaBox API 不公开"最后活动时间"，空闲倒计时从本机最近一次唤醒（或本次运行开始）起算；期间如有 SSH、终端、代理流量等活动，实际休眠会更晚。</div>
</main><script src="/assets/app.js"></script></body></html>`;
const ADMIN_PAGE = `${HEAD('管理员面板 · 允许登录的邮箱')}<body data-tz="__TZ__"><main>
<h1>管理员面板</h1><div class="sub">管理可登录本面板的邮箱（Cloudflare Access 一次性验证码） · <a href="/">返回唤醒页</a></div>
<div class="card warn hide" id="welcome">✅ 初始化完成：你现在是管理员，安装页已永久关闭。建议现在执行 wrangler secret delete SETUP_TOKEN 删除安装口令。</div>
<div class="card warn hide" id="notice"></div>
<div class="card warn hide" id="warn"></div>
<div class="card"><div class="lbl">添加邮箱</div><form id="f"><input id="em" type="email" inputmode="email" autocomplete="off" autocapitalize="off" placeholder="name@example.com" required><button class="add" id="addb" type="submit">添加</button></form></div>
<div id="msg"></div>
<div class="card"><div class="lbl" id="cnt">允许登录的邮箱</div><div id="list">加载中…</div></div>
<div class="small">修改直接写入 Cloudflare Access 策略，并在 1 分钟内对所有请求生效（Worker 每次请求都会核对当前列表）；Access 边缘策略本身一般几秒到一分钟内同步。🔒 管理员不能被删除：要删除请先“取消管理员”；至少保留一个管理员。</div>
</main><script src="/assets/admin.js"></script></body></html>`;

const APP_JS = `'use strict';
const $=id=>document.getElementById(id);const ZH={running:'运行中',suspended:'已休眠',suspending:'正在休眠',resuming:'唤醒中',starting:'启动中',stopped:'已关机',stopping:'关机中',creating:'创建中',deleting:'删除中',error:'异常'};
let M=null,serverOff=0,op=null,polling=null,waking=false;
const fmt=s=>{s=Math.max(0,Math.floor(s));const h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=s%60;return (h?h+':'+String(m).padStart(2,'0'):String(m).padStart(2,'0'))+':'+String(x).padStart(2,'0')};
const TZ=document.body.dataset.tz||undefined;const t=s=>s?new Date(s).toLocaleString('zh-CN',{hour12:false,timeZone:TZ}):'—';
const now=()=>Date.now()+serverOff;
async function load(){
  try{const r=await fetch('/api/status'+(op?'?op='+encodeURIComponent(op):''),{cache:'no-store',credentials:'same-origin'});
    if(!r.ok){let m='HTTP '+r.status;try{const j=await r.json();if(j.message)m=j.message}catch(e){}throw new Error(m)}
    const d=await r.json();M=d.machine;serverOff=new Date(d.serverTime)-Date.now();
    if(d.operation&&(d.operation.state==='succeeded'||d.operation.state==='failed')){if(d.operation.state==='failed')$('msg').textContent='操作失败：'+((d.operation.error&&d.operation.error.message)||'');op=null;}
    render(d);}catch(e){$('msg').textContent='获取状态失败：'+e.message}
}
function line(parent,text,cls){const d=document.createElement('div');d.textContent=text;if(cls)d.className=cls;parent.appendChild(d)}
function render(d){
  const s=M.state,busy=!!M.operationId||['resuming','starting','suspending','stopping','creating'].includes(s);
  $('nm').textContent=M.name||M.id;$('stc').className='card '+(busy?'busy':s);$('st').textContent=(ZH[s]||s)+(s==='running'&&!M.ready?'（准备中）':'');
  const mt=$('meta');mt.replaceChildren();line(mt,'最后更新：'+t(d.serverTime));line(mt,'状态变更：'+t(M.updatedAt));
  if(M.runStartedAt&&s==='running')line(mt,'本次运行开始：'+t(M.runStartedAt));if(M.autoSuspendedAt)line(mt,'自动休眠于：'+t(M.autoSuspendedAt));if(M.cooldownUntil)line(mt,'冷却至：'+t(M.cooldownUntil));
  if(M.spec)line(mt,M.spec.vcpus+' vCPU / '+(M.spec.memMiB/1024)+' GiB · 休眠阈值 '+((M.autoSuspendAfterSeconds||1800)/60)+' 分钟','dim');
  const b=$('btn');
  if(busy||waking){b.disabled=true;b.className='';b.textContent='唤醒中…';}
  else if(s==='running'){b.disabled=false;b.className='touch';b.textContent='已运行 · 点此重置空闲计时';}
  else{b.disabled=false;b.className='';b.textContent='唤醒';}
  if(waking&&s==='running'&&M.ready){waking=false;$('msg').textContent='✅ 已运行';setTimeout(()=>{if($('msg').textContent==='✅ 已运行')$('msg').textContent=''},5000);fast(false);render(d);}
  tick();
}
function tick(){
  if(!M)return;const A=(M.autoSuspendAfterSeconds||1800)*1000;
  if(M.state!=='running'){$('cd').textContent='--:--';$('bar').style.width='0';$('cdnote').textContent='机器未运行';}
  else{const lw=+localStorage.getItem('ib_wake_at')||0,rs=M.runStartedAt?Date.parse(M.runStartedAt):0,base=Math.max(lw,rs);
    const left=(base+A-now())/1000;
    if(left>0){$('cd').textContent=fmt(left);$('bar').style.width=(left*1000/A*100)+'%';$('bar').style.background=left<300?'var(--r)':left<600?'var(--y)':'var(--g)';$('cdnote').textContent='起算点：'+(lw>rs?'本机最近一次按下按钮 ':'本次运行开始 ')+t(base);}
    else{$('cd').textContent='00:00';$('bar').style.width='0';$('cdnote').textContent='估算已到期，但机器仍在运行：说明期间有活动重置了空闲计时，实际剩余时间未知（最多 30 分钟）。可按上方按钮重置计时。';}}
  if(M.state==='running'&&M.runStartedAt&&M.maxRunMinutes>0){const end=Date.parse(M.runStartedAt)+M.maxRunMinutes*60000;$('mr').textContent=fmt((end-now())/1000);$('mrnote').textContent='到 '+t(new Date(end).toISOString())+' 将被强制休眠，随后约 10 分钟冷却期内无法唤醒';}
  else{$('mr').textContent='--';$('mrnote').textContent='';}
}
function fast(on){clearInterval(polling);polling=setInterval(load,on?2500:10000);}
$('btn').addEventListener('click',async()=>{
  const b=$('btn');b.disabled=true;$('msg').textContent='发送请求…';
  try{const r=await fetch('/api/wake',{method:'POST',headers:{'x-ib-waker':'1'},credentials:'same-origin'});const d=await r.json();
    if(d.action==='touch'&&d.ok){localStorage.setItem('ib_wake_at',Date.parse(d.wakeAt));$('msg').textContent='✅ 已记录活动，空闲计时重置';load();return;}
    if(!d.ok&&d.action!=='busy'&&d.action!=='wait')throw new Error(d.message||(d.error&&(d.error.message||d.error.code))||('HTTP '+(d.status||r.status)));
    if(d.wakeAt)localStorage.setItem('ib_wake_at',Date.parse(d.wakeAt));
    op=d.operationId||null;waking=true;$('msg').textContent=d.action==='start'?'正在启动…':'正在唤醒…';fast(true);load();
  }catch(e){$('msg').textContent='唤醒失败：'+e.message;b.disabled=false;}
});
load();fast(false);setInterval(tick,1000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)load()});
`;

const ADMIN_JS = `'use strict';
const $=id=>document.getElementById(id);const RE=${EMAIL_RE.toString()};
const TZ=document.body.dataset.tz||undefined;let pending=null,pendTimer=null,readOnly=false;
function msg(t,c){$('msg').textContent=t;$('msg').className=c||''}
function el(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}
function render(d){
  readOnly=!!d.readOnly;
  $('cnt').textContent='允许登录的邮箱（'+d.emails.length+'）'+(d.updatedAt?' · 更新于 '+new Date(d.updatedAt).toLocaleString('zh-CN',{hour12:false,timeZone:TZ}):'')+(d.sessionDuration?' · 会话 '+d.sessionDuration:'');
  const w=$('warn');w.replaceChildren();
  if(d.otherRules&&d.otherRules.length){w.classList.remove('hide');
    w.appendChild(el('div',null,'⚠️ 策略中有 '+d.otherRules.length+' 条非邮箱规则'+(readOnly?'（include 中含非邮箱规则：为安全起见，面板已禁止保存，请先在 Cloudflare Zero Trust 面板中处理）':'（exclude/require，仅供参考）')));
    d.otherRules.forEach(r=>w.appendChild(el('code',null,r.where+' · '+r.type+' · '+r.rule)));
  }else w.classList.add('hide');
  $('addb').disabled=readOnly;$('em').disabled=readOnly;
  const list=$('list');list.replaceChildren();
  if(!d.emails.length)list.appendChild(el('div','small','（空）'));
  const nAdmin=d.emails.filter(x=>x.admin).length;
  d.emails.forEach(x=>{const row=el('div','row');row.appendChild(el('span','e',x.email));
    if(x.admin){row.appendChild(el('span','lock','🔒 管理员'));
      if(d.canManageAdmins){const m=el('button','mini','取消管理员');m.type='button';m.disabled=nAdmin<=1;m.title=nAdmin<=1?'至少保留一个管理员':'';m.addEventListener('click',()=>role('demote',x.email,m));row.appendChild(m)}}
    else{if(d.canManageAdmins){const m=el('button','mini','设为管理员');m.type='button';m.addEventListener('click',()=>role('promote',x.email,m));row.appendChild(m)}
      const b=el('button','del','删除');b.type='button';b.dataset.e=x.email;b.disabled=readOnly;b.addEventListener('click',()=>del(b));row.appendChild(b)}
    list.appendChild(row)});
  const n=$('notice');n.replaceChildren();
  if(d.setupNotice==='setup_app_left'){n.classList.remove('hide');n.appendChild(el('div',null,'ℹ️ 安装用的 /setup 绕过应用（Access bypass）没能自动删除（CF token 没有 Access 应用权限，这是正常的）。/setup 已永久返回 404；为了整洁，可以在 Zero Trust → Access → Applications 里手动删除它。'));
    const k=el('button','mini','我已处理，不再提示');k.type='button';k.addEventListener('click',async()=>{try{await post('/admin/api/ack-setup','')}catch(e){}});n.appendChild(k)}
  else n.classList.add('hide');
}
async function role(op,email,btn){if(op==='demote'&&!confirm('取消 '+email+' 的管理员身份？'))return;btn.disabled=true;
  try{await post('/admin/api/'+op,email);msg(op==='promote'?'✅ 已设为管理员 '+email:'✅ 已取消管理员 '+email,'ok')}catch(x){msg('操作失败：'+x.message,'err');load()}}
async function load(){try{const r=await fetch('/admin/api/emails',{cache:'no-store',credentials:'same-origin'});const d=await r.json();if(!r.ok)throw new Error(d.message||r.status);render(d)}catch(e){msg('加载失败：'+e.message,'err')}}
async function post(path,email){const r=await fetch(path,{method:'POST',credentials:'same-origin',headers:{'x-ib-waker':'1','content-type':'application/json'},body:JSON.stringify({email})});const d=await r.json();if(d.emails)render(d);if(!r.ok)throw new Error(d.message||('HTTP '+r.status));return d}
$('f').addEventListener('submit',async ev=>{ev.preventDefault();const e=$('em').value.trim().toLowerCase();if(!RE.test(e)){msg('邮箱格式不正确','err');return}
  $('addb').disabled=true;msg('正在添加…');try{await post('/admin/api/add',e);$('em').value='';msg('✅ 已添加 '+e,'ok')}catch(x){msg('添加失败：'+x.message,'err')}$('addb').disabled=readOnly});
async function del(b){const e=b.dataset.e;
  if(pending!==b){if(pending){pending.textContent='删除';pending.classList.remove('confirm')}pending=b;b.textContent='确认删除？';b.classList.add('confirm');clearTimeout(pendTimer);pendTimer=setTimeout(()=>{b.textContent='删除';b.classList.remove('confirm');pending=null},4000);return}
  clearTimeout(pendTimer);pending=null;if(!confirm('确定删除 '+e+' 吗？删除后对方将在 1 分钟内无法再访问。'))return load();
  b.disabled=true;b.textContent='删除中…';try{await post('/admin/api/remove',e);msg('✅ 已删除 '+e,'ok')}catch(x){msg('删除失败：'+x.message,'err');load()}}
if(new URLSearchParams(location.search).get('setup')==='done'){$('welcome').classList.remove('hide');history.replaceState(null,'','/admin')}
load();
`;

const SETUP_JS = `'use strict';
const $=id=>document.getElementById(id);const RE=${EMAIL_RE.toString()};
function msg(t,c){$('msg').textContent=t;$('msg').className=c||''}
const h=new URLSearchParams(location.hash.slice(1));const tok=h.get('t');
if(tok){$('tk').value=tok;$('tokrow').classList.add('hide');history.replaceState(null,'',location.pathname)}
$('f').addEventListener('submit',async ev=>{ev.preventDefault();const email=$('em').value.trim().toLowerCase();
  if(!RE.test(email)){msg('邮箱格式不正确','err');return}
  if(!confirm('确认把 '+email+' 设为初始管理员？接下来会向这个邮箱发送验证码。'))return;
  $('go').disabled=true;msg('正在提交…');
  try{const r=await fetch('/setup/api/start',{method:'POST',credentials:'same-origin',headers:{'x-ib-waker':'1','content-type':'application/json'},body:JSON.stringify({email,token:$('tk').value.trim()})});
    let d={};try{d=await r.json()}catch(e){}
    if(!r.ok){if(r.status===404)throw new Error('安装已完成或已关闭');if(d.error==='bad_token')$('tokrow').classList.remove('hide');throw new Error(d.message||('HTTP '+r.status))}
    msg('✅ 已记录。5 秒后跳转到 Cloudflare 登录页：输入 '+email+'，查收验证码（也看看垃圾邮件），在 15 分钟内完成登录。','ok');
    setTimeout(()=>{location.href=d.next||'/'},5000);
  }catch(e){msg('提交失败：'+e.message,'err');$('go').disabled=false}});
`;
