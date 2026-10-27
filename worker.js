// instabox-waker: manual-only wake panel for one InstaBox machine, behind Cloudflare Access.
// Config (Worker vars/secrets): INSTABOX_API_KEY, INSTABOX_MACHINE_ID, ACCESS_TEAM_DOMAIN, ACCESS_AUD,
//   ADMIN_EMAILS, CF_API_TOKEN, CF_ACCOUNT_ID, ACCESS_POLICY_ID, optional DISPLAY_TIMEZONE. See README.md.
// No cron, no scheduled handler, no auto-wake. Wake happens only on POST /api/wake (button press).
const API = 'https://api.instabox.sh';

const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
let jwksCache = null, jwksAt = 0;
async function verifyAccess(req, env) {
  const tok = req.headers.get('cf-access-jwt-assertion');
  if (!tok || !env.ACCESS_AUD || !env.ACCESS_TEAM_DOMAIN) return null;
  const [h, p, s] = tok.split('.');
  if (!s) return null;
  let header, payload;
  try { header = JSON.parse(new TextDecoder().decode(b64url(h))); payload = JSON.parse(new TextDecoder().decode(b64url(p))); } catch { return null; }
  if (header.alg !== 'RS256') return null;
  if (Date.now() - jwksAt > 3600e3 || !jwksCache) {
    const r = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
    jwksCache = (await r.json()).keys; jwksAt = Date.now();
  }
  const jwk = jwksCache.find(k => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) return null;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) return null;
  if (payload.exp && payload.exp * 1000 < Date.now()) return null;
  if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
  return payload;
}

async function ib(env, method, path, idem) {
  const headers = { 'X-API-Key': env.INSTABOX_API_KEY, 'Accept': 'application/json' };
  if (idem) headers['Idempotency-Key'] = crypto.randomUUID();
  const r = await fetch(API + path, { method, headers });
  let body = null; try { body = await r.json(); } catch {}
  return { status: r.status, body };
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
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const notFound = () => new Response('Not Found', { status: 404 });

export default {
  async fetch(req, env) {
    const who = await verifyAccess(req, env);
    if (!who) return notFound();
    const url = new URL(req.url);
    const MID = env.INSTABOX_MACHINE_ID;
    if (!MID || !/^[A-Za-z0-9_-]+$/.test(MID)) return json({ error: 'config', message: 'INSTABOX_MACHINE_ID is not set' }, 500);

    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return handleAdmin(req, env, url, who);

    if (url.pathname === '/api/status' && req.method === 'GET') {
      const r = await ib(env, 'GET', `/v1/machines/${MID}`);
      if (r.status !== 200) return json({ error: 'instabox', status: r.status, detail: r.body && r.body.error }, 502);
      const out = { machine: pick(r.body), serverTime: new Date().toISOString(), user: who.email || who.common_name || null };
      const op = url.searchParams.get('op');
      if (op && /^op_[a-z0-9]+$/.test(op)) {
        const o = await ib(env, 'GET', `/v1/operations/${op}`);
        if (o.status === 200) out.operation = { id: o.body.id, type: o.body.type, state: o.body.state, phase: o.body.phase || null, error: o.body.error || null };
      }
      return json(out);
    }

    if (url.pathname === '/api/wake' && req.method === 'POST') {
      // CSRF guard: same-origin fetch only
      const origin = req.headers.get('origin');
      if (req.headers.get('x-ib-waker') !== '1' || (origin && origin !== url.origin)) return json({ error: 'forbidden' }, 403);
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
      const page = PAGE.replace('__TZ__', JSON.stringify(tz(env)));
      return new Response(isAdmin(who, env) ? page.replace('<!--ADMINLINK-->', '<a href="/admin" style="color:#93c5fd;font-size:13px">管理员面板 →</a>') : page, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' } });
    }
    return notFound();
  },
};

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0f172a"><title>InstaBox 唤醒</title>
<style>
:root{--bg:#0f172a;--card:#1e293b;--mut:#94a3b8;--fg:#f1f5f9;--g:#22c55e;--y:#f59e0b;--r:#ef4444;--b:#3b82f6}
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans SC",sans-serif;background:var(--bg);color:var(--fg);min-height:100vh;display:flex;justify-content:center;padding:env(safe-area-inset-top) 16px 24px}
main{width:100%;max-width:440px;padding-top:24px}h1{font-size:20px;margin:0 0 4px}.sub{color:var(--mut);font-size:13px;margin-bottom:18px}
.card{background:var(--card);border-radius:16px;padding:18px;margin-bottom:14px}
.st{display:flex;align-items:center;gap:10px;font-size:26px;font-weight:700}.dot{width:14px;height:14px;border-radius:50%;background:var(--mut);flex:none}
.running .dot{background:var(--g);box-shadow:0 0 12px var(--g)}.suspended .dot,.stopped .dot{background:var(--r)}.busy .dot{background:var(--y);animation:p 1s infinite}
@keyframes p{50%{opacity:.3}}.meta{color:var(--mut);font-size:13px;margin-top:8px;line-height:1.7}
button{width:100%;border:0;border-radius:18px;padding:26px 0;font-size:30px;font-weight:800;letter-spacing:6px;color:#fff;background:linear-gradient(135deg,#2563eb,#7c3aed);box-shadow:0 8px 24px rgba(59,130,246,.35)}
button:disabled{opacity:.55}button.touch{font-size:20px;letter-spacing:2px;padding:18px 0;background:#334155;box-shadow:none}
.cd{font-size:40px;font-weight:800;font-variant-numeric:tabular-nums}.lbl{color:var(--mut);font-size:13px}.est{display:inline-block;font-size:11px;background:#334155;color:var(--y);border-radius:6px;padding:1px 6px;margin-left:6px}
.bar{height:6px;background:#334155;border-radius:3px;overflow:hidden;margin-top:10px}.bar>i{display:block;height:100%;background:var(--g);transition:width 1s}
#msg{min-height:20px;font-size:14px;margin-top:12px;color:var(--y);text-align:center}.small{font-size:12px;color:var(--mut);line-height:1.6}
</style></head><body><main>
<h1>InstaBox · <span id="nm"></span></h1><div class="sub">手动唤醒面板（仅按下按钮时唤醒，无自动保活） <!--ADMINLINK--></div>
<div class="card" id="stc"><div class="st"><span class="dot"></span><span id="st">加载中…</span></div>
<div class="meta" id="meta"></div></div>
<button id="btn" disabled>唤醒</button><div id="msg"></div>
<div class="card" style="margin-top:14px"><div class="lbl">距离自动休眠（空闲 30 分钟）<span class="est">估算</span></div>
<div class="cd" id="cd">--:--</div><div class="bar"><i id="bar" style="width:0"></i></div>
<div class="small" id="cdnote" style="margin-top:8px"></div></div>
<div class="card"><div class="lbl">最长连续运行上限（免费版 8 小时，精确）</div><div class="cd" id="mr" style="font-size:28px">--</div>
<div class="small" id="mrnote"></div></div>
<div class="small">状态每 10 秒自动刷新。InstaBox API 不公开"最后活动时间"，空闲倒计时从本机最近一次唤醒（或本次运行开始）起算；期间如有 SSH、终端、代理流量等活动，实际休眠会更晚。</div>
</main><script>
const $=id=>document.getElementById(id);const ZH={running:'运行中',suspended:'已休眠',suspending:'正在休眠',resuming:'唤醒中',starting:'启动中',stopped:'已关机',stopping:'关机中',creating:'创建中',deleting:'删除中',error:'异常'};
let M=null,serverOff=0,op=null,polling=null,waking=false;
const fmt=s=>{s=Math.max(0,Math.floor(s));const h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=s%60;return (h?h+':'+String(m).padStart(2,'0'):String(m).padStart(2,'0'))+':'+String(x).padStart(2,'0')};
const TZ=__TZ__;const t=s=>s?new Date(s).toLocaleString('zh-CN',{hour12:false,timeZone:TZ||undefined}):'—';
const now=()=>Date.now()+serverOff;
async function load(){
  try{const r=await fetch('/api/status'+(op?'?op='+op:''),{cache:'no-store',credentials:'same-origin'});
    if(!r.ok)throw new Error('HTTP '+r.status);const d=await r.json();M=d.machine;serverOff=new Date(d.serverTime)-Date.now();
    if(d.operation&&(d.operation.state==='succeeded'||d.operation.state==='failed')){if(d.operation.state==='failed')$('msg').textContent='操作失败：'+((d.operation.error&&d.operation.error.message)||'');op=null;}
    render(d);}catch(e){$('msg').textContent='获取状态失败：'+e.message}
}
function render(d){
  const s=M.state,busy=!!M.operationId||['resuming','starting','suspending','stopping','creating'].includes(s);
  $('nm').textContent=M.name||M.id;$('stc').className='card '+(busy?'busy':s);$('st').textContent=(ZH[s]||s)+(s==='running'&&!M.ready?'（准备中）':'');
  $('meta').innerHTML='最后更新：'+t(d.serverTime)+'<br>状态变更：'+t(M.updatedAt)+(M.runStartedAt&&s==='running'?'<br>本次运行开始：'+t(M.runStartedAt):'')+(M.autoSuspendedAt?'<br>自动休眠于：'+t(M.autoSuspendedAt):'')+(M.cooldownUntil?'<br>冷却至：'+t(M.cooldownUntil):'')+'<br><span style="opacity:.7">'+M.spec.vcpus+' vCPU / '+(M.spec.memMiB/1024)+' GiB · 休眠阈值 '+(M.autoSuspendAfterSeconds/60)+' 分钟</span>';
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
$('btn').onclick=async()=>{
  const b=$('btn');b.disabled=true;$('msg').textContent='发送请求…';
  try{const r=await fetch('/api/wake',{method:'POST',headers:{'x-ib-waker':'1'},credentials:'same-origin'});const d=await r.json();
    if(d.action==='touch'&&d.ok){localStorage.setItem('ib_wake_at',Date.parse(d.wakeAt));$('msg').textContent='✅ 已记录活动，空闲计时重置';load();return;}
    if(!d.ok&&d.action!=='busy'&&d.action!=='wait')throw new Error((d.error&&(d.error.message||d.error.code))||('HTTP '+(d.status||r.status)));
    if(d.wakeAt)localStorage.setItem('ib_wake_at',Date.parse(d.wakeAt));
    op=d.operationId||null;waking=true;$('msg').textContent=d.action==='start'?'正在启动…':'正在唤醒…';fast(true);load();
  }catch(e){$('msg').textContent='唤醒失败：'+e.message;b.disabled=false;}
};
load();fast(false);setInterval(tick,1000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)load()});
</script></body></html>`;

// ---------------- Admin: manage allowed emails in the Access policy ----------------
const CF = 'https://api.cloudflare.com/client/v4';
const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const owners = (env) => String(env.ADMIN_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
function isAdmin(who, env) {
  if (!who) return false;
  const email = (who.email || '').toLowerCase();
  return !!email && owners(env).includes(email);
}
// Optional IANA time zone for displayed times (e.g. "Asia/Shanghai"); empty = viewer's browser time zone.
function tz(env) {
  const z = String(env.DISPLAY_TIMEZONE || '').trim();
  if (!z) return '';
  try { new Intl.DateTimeFormat('en', { timeZone: z }); return z; } catch { return ''; }
}
async function cf(env, method, path, body) {
  const r = await fetch(CF + path, { method, headers: { 'Authorization': `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, ok: r.ok && j && j.success, body: j };
}
const polPath = (env) => `/accounts/${env.CF_ACCOUNT_ID}/access/policies/${env.ACCESS_POLICY_ID}`;
async function readPolicy(env) {
  const r = await cf(env, 'GET', polPath(env));
  if (!r.ok) throw new Error('读取 Access 策略失败 (' + r.status + ')');
  return r.body.result;
}
function emailsOf(pol) {
  return (pol.include || []).filter(x => x.email && x.email.email).map(x => x.email.email.toLowerCase());
}
async function writeEmails(env, pol, emails) {
  const others = (pol.include || []).filter(x => !(x.email && x.email.email));
  const include = [...others, ...emails.map(e => ({ email: { email: e } }))];
  const body = { name: pol.name, decision: pol.decision, include, exclude: pol.exclude || [], require: pol.require || [] };
  if (pol.session_duration) body.session_duration = pol.session_duration;
  const r = await cf(env, 'PUT', polPath(env), body);
  if (!r.ok) throw new Error('更新 Access 策略失败 (' + r.status + ')');
  return r.body.result;
}
function listOut(env, pol) {
  const own = owners(env);
  const emails = emailsOf(pol);
  return { emails: emails.map(e => ({ email: e, locked: own.includes(e) })), updatedAt: pol.updated_at || null, owners: own };
}
async function handleAdmin(req, env, url, who) {
  if (!isAdmin(who, env)) {
    if (url.pathname.startsWith('/admin/api/')) return json({ error: 'forbidden', message: '无管理员权限' }, 403);
    return new Response(FORBIDDEN_PAGE, { status: 403, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  }
  if (url.pathname === '/admin' && req.method === 'GET') {
    return new Response(ADMIN_PAGE.replace('__TZ__', JSON.stringify(tz(env))), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' } });
  }
  if (url.pathname === '/admin/api/emails' && req.method === 'GET') {
    try { return json(listOut(env, await readPolicy(env))); } catch (e) { return json({ error: 'cf', message: e.message }, 502); }
  }
  if ((url.pathname === '/admin/api/add' || url.pathname === '/admin/api/remove') && req.method === 'POST') {
    const origin = req.headers.get('origin');
    if (req.headers.get('x-ib-waker') !== '1' || (origin && origin !== url.origin)) return json({ error: 'forbidden', message: '请求来源无效' }, 403);
    if (!(req.headers.get('content-type') || '').includes('application/json')) return json({ error: 'bad_request', message: '需要 JSON' }, 400);
    let email;
    try { email = String((await req.json()).email || '').trim().toLowerCase(); } catch { return json({ error: 'bad_request', message: '请求格式错误' }, 400); }
    if (!email || email.length > 254 || !EMAIL_RE.test(email)) return json({ error: 'invalid_email', message: '邮箱格式不正确' }, 400);
    try {
      const pol = await readPolicy(env);
      const cur = emailsOf(pol);
      if (url.pathname === '/admin/api/add') {
        if (cur.includes(email)) return json({ error: 'exists', message: '该邮箱已在列表中', ...listOut(env, pol) }, 409);
        if (cur.length >= 50) return json({ error: 'too_many', message: '最多 50 个邮箱' }, 400);
        return json({ ok: true, action: 'add', email, ...listOut(env, await writeEmails(env, pol, [...cur, email])) });
      } else {
        if (owners(env).includes(email)) return json({ error: 'locked', message: '管理员邮箱已锁定，不能删除' }, 403);
        if (!cur.includes(email)) return json({ error: 'not_found', message: '列表中没有该邮箱', ...listOut(env, pol) }, 404);
        return json({ ok: true, action: 'remove', email, ...listOut(env, await writeEmails(env, pol, cur.filter(e => e !== email))) });
      }
    } catch (e) { return json({ error: 'cf', message: e.message }, 502); }
  }
  return notFound();
}

const STYLE = `<style>
:root{--bg:#0f172a;--card:#1e293b;--mut:#94a3b8;--fg:#f1f5f9;--g:#22c55e;--y:#f59e0b;--r:#ef4444;--b:#3b82f6}
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans SC",sans-serif;background:var(--bg);color:var(--fg);min-height:100vh;display:flex;justify-content:center;padding:env(safe-area-inset-top) 16px 24px}
main{width:100%;max-width:440px;padding-top:24px}h1{font-size:20px;margin:0 0 4px}.sub{color:var(--mut);font-size:13px;margin-bottom:18px}a{color:#93c5fd}
.card{background:var(--card);border-radius:16px;padding:18px;margin-bottom:14px}.lbl{color:var(--mut);font-size:13px;margin-bottom:10px}
.row{display:flex;align-items:center;gap:10px;padding:12px 0;border-bottom:1px solid #334155;word-break:break-all}.row:last-child{border-bottom:0}.row .e{flex:1;font-size:15px}
.lock{font-size:12px;color:var(--y);background:#334155;border-radius:6px;padding:3px 8px;white-space:nowrap}
.del{border:0;border-radius:10px;padding:8px 14px;font-size:14px;font-weight:700;color:#fff;background:#475569;white-space:nowrap}.del.confirm{background:var(--r)}
input{width:100%;font-size:16px;padding:14px;border-radius:12px;border:1px solid #334155;background:#0b1220;color:var(--fg);outline:none}input:focus{border-color:var(--b)}
.add{width:100%;margin-top:10px;border:0;border-radius:14px;padding:16px 0;font-size:18px;font-weight:800;color:#fff;background:linear-gradient(135deg,#2563eb,#7c3aed)}
button:disabled{opacity:.55}#msg{min-height:20px;font-size:14px;margin:8px 0;text-align:center}.ok{color:var(--g)}.err{color:var(--r)}.small{font-size:12px;color:var(--mut);line-height:1.6}
</style>`;
const FORBIDDEN_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>无权限</title>${STYLE}</head><body><main><h1>403 · 无管理员权限</h1><div class="sub">只有管理员邮箱可以访问此页面。</div><a href="/">← 返回唤醒页</a></main></body></html>`;
const ADMIN_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0f172a"><title>管理员面板 · 允许登录的邮箱</title>${STYLE}</head><body><main>
<h1>管理员面板</h1><div class="sub">管理可登录本面板的邮箱（Cloudflare Access 一次性验证码） · <a href="/">返回唤醒页</a></div>
<div class="card"><div class="lbl">添加邮箱</div><form id="f"><input id="em" type="email" inputmode="email" autocomplete="off" autocapitalize="off" placeholder="name@example.com" required><button class="add" id="addb" type="submit">添加</button></form></div>
<div id="msg"></div>
<div class="card"><div class="lbl" id="cnt">允许登录的邮箱</div><div id="list">加载中…</div></div>
<div class="small">修改直接写入 Cloudflare Access 策略，一般几秒到一分钟内生效。删除邮箱后，对方已登录的会话可能在会话到期前仍然有效（取决于 Access 会话时长）。🔒 管理员邮箱已锁定，不能在此删除。</div>
</main><script>
const $=id=>document.getElementById(id);const RE=/^[a-z0-9.!#$%&'*+/=?^_\`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const TZ=__TZ__;let pending=null,pendTimer=null;
function msg(t,c){$('msg').textContent=t;$('msg').className=c||''}
function esc(s){return s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function render(d){
  $('cnt').textContent='允许登录的邮箱（'+d.emails.length+'）'+(d.updatedAt?' · 更新于 '+new Date(d.updatedAt).toLocaleString('zh-CN',{hour12:false,timeZone:TZ||undefined}):'');
  $('list').innerHTML=d.emails.map(x=>'<div class="row"><span class="e">'+esc(x.email)+'</span>'+(x.locked?'<span class="lock">🔒 管理员</span>':'<button class="del" data-e="'+esc(x.email)+'">删除</button>')+'</div>').join('')||'<div class="small">（空）</div>';
  document.querySelectorAll('.del').forEach(b=>b.onclick=()=>del(b));
}
async function load(){try{const r=await fetch('/admin/api/emails',{cache:'no-store',credentials:'same-origin'});const d=await r.json();if(!r.ok)throw new Error(d.message||r.status);render(d)}catch(e){msg('加载失败：'+e.message,'err')}}
async function post(path,email){const r=await fetch(path,{method:'POST',credentials:'same-origin',headers:{'x-ib-waker':'1','content-type':'application/json'},body:JSON.stringify({email})});const d=await r.json();if(d.emails)render(d);if(!r.ok)throw new Error(d.message||('HTTP '+r.status));return d}
$('f').onsubmit=async ev=>{ev.preventDefault();const e=$('em').value.trim().toLowerCase();if(!RE.test(e)){msg('邮箱格式不正确','err');return}
  $('addb').disabled=true;msg('正在添加…');try{await post('/admin/api/add',e);$('em').value='';msg('✅ 已添加 '+e+'（策略生效可能需要几十秒）','ok')}catch(x){msg('添加失败：'+x.message,'err')}$('addb').disabled=false};
async function del(b){const e=b.dataset.e;
  if(pending!==b){if(pending){pending.textContent='删除';pending.classList.remove('confirm')}pending=b;b.textContent='确认删除？';b.classList.add('confirm');clearTimeout(pendTimer);pendTimer=setTimeout(()=>{b.textContent='删除';b.classList.remove('confirm');pending=null},4000);return}
  clearTimeout(pendTimer);pending=null;if(!confirm('确定删除 '+e+' 吗？删除后对方将无法再登录。'))return load();
  b.disabled=true;b.textContent='删除中…';try{await post('/admin/api/remove',e);msg('✅ 已删除 '+e,'ok')}catch(x){msg('删除失败：'+x.message,'err');load()}}
load();
</script></body></html>`;
