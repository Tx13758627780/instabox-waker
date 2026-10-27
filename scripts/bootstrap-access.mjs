#!/usr/bin/env node
// instabox-waker — create the Cloudflare Access pieces with the API (Node 18+, no dependencies).
//
//   CF_BOOTSTRAP_TOKEN=... node scripts/bootstrap-access.mjs --account <ACCOUNT_ID> --host waker.example.com [--create-worker-token]
//   (if Cloudflare rejects the placeholder email, add --placeholder you@example.com: before setup nobody can use the panel anyway)
//   CF_BOOTSTRAP_TOKEN=... node scripts/bootstrap-access.mjs --account <ACCOUNT_ID> --cleanup-setup <SETUP_APP_ID> [--bypass-policy <ID>]
//
// What it creates (idempotent: existing apps for the same hostname are reused):
//   1. One-time PIN login method (if missing)
//   2. Reusable Allow policy "instabox-waker allow" (24 h session, starts with a harmless placeholder email)
//   3. Self-hosted Access app for <host> (24 h session, One-time PIN only) using that policy
//   4. Temporary path-scoped app for <host>/setup with a Bypass policy, so the first-run page is reachable
//   5. With --create-worker-token: a 90-day Cloudflare API token limited to "Access: Policies Read/Write" on this
//      account, written to ./.worker-cf-token (mode 600). It is never printed.
// It prints only non-secret IDs as JSON. The bootstrap token itself is read from the environment and never printed.
//
// Bootstrap token permissions (Account scope, only this account): Access: Apps and Policies → Edit,
// Access: Organizations, Identity Providers, and Groups → Edit; plus Account API Tokens → Edit if you use
// --create-worker-token. Delete the bootstrap token when you are done.
import fs from 'node:fs';

const CF = 'https://api.cloudflare.com/client/v4';
const PLACEHOLDER_EMAIL = 'nobody@setup.invalid';

export async function bootstrap(opts, log = (m) => process.stderr.write(m + '\n')) {
  const { token, account, host } = opts;
  if (!token) throw new Error('CF_BOOTSTRAP_TOKEN is not set');
  if (!/^[0-9a-f]{32}$/.test(account || '')) throw new Error('--account must be your 32-character Cloudflare account ID');
  const call = async (method, path, body) => {
    const r = await fetch(CF + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch {}
    if (!r.ok || !j || !j.success) {
      const msg = j && j.errors && j.errors.map(e => `${e.code} ${e.message}`).join('; ');
      throw new Error(`${method} ${path.replace(account, '<account>')} failed: HTTP ${r.status}${msg ? ' — ' + msg : ''}`);
    }
    return j.result;
  };
  const A = `/accounts/${account}`;

  if (opts.cleanupSetup) {
    await call('DELETE', `${A}/access/apps/${opts.cleanupSetup}`);
    log('deleted setup bypass app');
    if (opts.bypassPolicy) { await call('DELETE', `${A}/access/policies/${opts.bypassPolicy}`); log('deleted bypass policy'); }
    return { cleaned: true };
  }
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host || '')) throw new Error('--host must be a hostname like waker.example.com');

  let org;
  try { org = await call('GET', `${A}/access/organizations`); } catch (e) { throw new Error('Zero Trust is not enabled on this account yet (open one.dash.cloudflare.com once and pick the Free plan). ' + e.message); }
  const team = org && org.auth_domain;
  if (!team) throw new Error('could not read your Zero Trust team domain');
  log('team domain: ' + team);

  const idps = await call('GET', `${A}/access/identity_providers`);
  let otp = (idps || []).find(i => i.type === 'onetimepin');
  if (!otp) { otp = await call('POST', `${A}/access/identity_providers`, { name: 'One-time PIN', type: 'onetimepin', config: {} }); log('enabled One-time PIN'); }

  const apps = await call('GET', `${A}/access/apps`);
  let main = (apps || []).find(a => a.domain === host);
  let policyId;
  if (main) {
    policyId = main.policies && main.policies[0] && main.policies[0].id;
    log('reusing existing Access app for ' + host);
  } else {
    const pol = await call('POST', `${A}/access/policies`, { name: 'instabox-waker allow', decision: 'allow', include: [{ email: { email: opts.placeholder || PLACEHOLDER_EMAIL } }], exclude: [], require: [], session_duration: '24h' });
    policyId = pol.id;
    main = await call('POST', `${A}/access/apps`, { name: 'instabox-waker', type: 'self_hosted', domain: host, session_duration: '24h',
      allowed_idps: [otp.id], auto_redirect_to_identity: true, app_launcher_visible: false, policies: [{ id: policyId, precedence: 1 }] });
    log('created Access app for ' + host);
  }

  let setup = (apps || []).find(a => a.domain === host + '/setup');
  let bypassId = setup && setup.policies && setup.policies[0] && setup.policies[0].id;
  if (!setup) {
    const bp = await call('POST', `${A}/access/policies`, { name: 'instabox-waker setup bypass (temporary)', decision: 'bypass', include: [{ everyone: {} }], exclude: [], require: [] });
    bypassId = bp.id;
    setup = await call('POST', `${A}/access/apps`, { name: 'instabox-waker setup (temporary)', type: 'self_hosted', domain: host + '/setup', app_launcher_visible: false, policies: [{ id: bp.id, precedence: 1 }] });
    log('created temporary bypass app for ' + host + '/setup');
  }

  let workerToken = null;
  if (opts.createWorkerToken) {
    const groups = await call('GET', `${A}/tokens/permission_groups`);
    const g = (n) => (groups || []).find(x => x.name === n);
    const w = g('Access: Policies Write'), r = g('Access: Policies Read');
    if (!w || !r) throw new Error('permission groups "Access: Policies Read/Write" not found; create the Worker token in the dashboard instead');
    const exp = new Date(Date.now() + 90 * 864e5).toISOString().replace(/\.\d+Z$/, 'Z');
    const t = await call('POST', `${A}/tokens`, { name: 'instabox-waker access policies', expires_on: exp,
      policies: [{ effect: 'allow', permission_groups: [{ id: w.id }, { id: r.id }], resources: { [`com.cloudflare.api.account.${account}`]: '*' } }] });
    fs.writeFileSync('.worker-cf-token', t.value, { mode: 0o600 });
    workerToken = { id: t.id, expires_on: t.expires_on || exp, file: '.worker-cf-token' };
    log('created Worker API token (saved to .worker-cf-token, not printed)');
  }

  return { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: main.aud, ACCESS_POLICY_ID: policyId, CF_ACCOUNT_ID: account,
    SETUP_ACCESS_APP_ID: setup.id, SETUP_BYPASS_POLICY_ID: bypassId, workerToken };
}

function arg(name) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; }
if (import.meta.url === `file://${process.argv[1]}`) {
  bootstrap({ token: process.env.CF_BOOTSTRAP_TOKEN, account: arg('--account'), host: arg('--host'),
    createWorkerToken: process.argv.includes('--create-worker-token'), cleanupSetup: arg('--cleanup-setup'), bypassPolicy: arg('--bypass-policy'), placeholder: arg('--placeholder') })
    .then(out => console.log(JSON.stringify(out, null, 2)))
    .catch(e => { console.error('error: ' + e.message); process.exit(1); });
}
