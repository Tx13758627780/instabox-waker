---
name: instabox-waker-deploy
description: Deploy the instabox-waker Cloudflare Worker (a manual, Access-protected wake button for one InstaBox machine) for a human, end to end. Use when someone asks you to set up, install or deploy instabox-waker, or to "make a page that wakes my InstaBox". Covers Cloudflare login, Durable Object config, Access (email one-time PIN) app plus the temporary /setup bypass, secrets, deploy, the one-time first-run admin setup, cleanup and verification, without ever seeing or printing a secret.
---

# Deploy instabox-waker

You are helping a human deploy this repository to their own Cloudflare account. The result is
`https://<their-subdomain>/`, protected by Cloudflare Access email one-time PIN, with a button that wakes
their InstaBox machine, plus `/admin` to manage who may sign in.

The human-oriented version of these steps is `docs/TUTORIAL.en.md` (Chinese: `docs/TUTORIAL.zh-CN.md`).
Point the human there whenever they need to click through a dashboard.

## Hard rules

1. **Never print, echo, log, paste or ask the human to paste secrets into the chat.** Secrets are the InstaBox
   key, every Cloudflare API token, and `SETUP_TOKEN`. The human types or pastes them **directly into a
   terminal prompt** (`npx wrangler secret put …`, `export …`) or a file you never `cat`. Don't run `cat`, `echo`, `env`,
   `printenv`, `set -x`, or `wrangler secret list --format json | …` on anything that could contain a secret. If a secret
   ends up in your context by accident, tell the human to rotate it.
2. **Manual only.** Never add `[triggers]`/cron, scheduled pings, keepalive loops, or change the machine's
   auto-suspend settings. The Worker must only wake the machine when a human presses the button.
3. **Don't touch other things in their account**: existing DNS records, other Workers, other Access apps or
   policies. Only create the resources listed here.
4. Keep `workers_dev = false` and `preview_urls = false`.
5. Anything you can't do (the human must click, sign in, receive email, or paste a secret): stop, tell them exactly
   what to do, and wait.

## Ask the human first

- **Subdomain** to use, e.g. `waker.example.com`. Its root domain must already be **Active** on Cloudflare
  (Tutorial Steps 1–2). If it isn't, walk them through that first.
- Whether **Zero Trust (Free)** is enabled and what the **team name** is (Tutorial Step 3; enabling it may need a
  card at $0; only the human can do this).
- The **email** they'll use as the first admin (not a secret; it's needed only for Option B or `--placeholder`).
- Which Access path they prefer: **A** (script with a temporary bootstrap token, faster) or **B** (dashboard
  clicks, no broad token).
- Whether they run `instabox` themselves or want you to run the non-secret parts (`instabox ls`).

## Steps

Run from the repo root. Prefer `npx wrangler` so no global install is needed. Requires Node.js ≥ 18.

### 1. Cloudflare CLI login

```sh
node -v
npx wrangler login          # opens a browser; the HUMAN clicks Allow
npx wrangler whoami         # shows the account name/ID (not secret)
```
Record the **Account ID**.

### 2. InstaBox machine and key

```sh
instabox ls                 # note the machine ID (m_…), not secret
```
Ask the human to create the key **in their own terminal** and keep the output private:
```sh
instabox keys create -name instabox-waker -scope machines:read,machines:write -expires-in-days 90
```
Don't capture this command's output yourself.

### 3. Cloudflare Access

**Option A: script.** Ask the human to create a temporary *Custom API token* (My Profile → API Tokens) with
Account → *Access: Apps and Policies* Edit, *Access: Organizations, Identity Providers, and Groups* Edit, and
*Account API Tokens* Edit, scoped to their account with a short TTL. Then the **human** runs:
```sh
export CF_BOOTSTRAP_TOKEN='…'        # the human pastes this; you never see it
node scripts/bootstrap-access.mjs --account <ACCOUNT_ID> --host <SUBDOMAIN> --create-worker-token
```
The script is idempotent (safe to rerun). It prints non-secret IDs as JSON: `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`,
`ACCESS_POLICY_ID`, `CF_ACCOUNT_ID`, `SETUP_ACCESS_APP_ID`, `SETUP_BYPASS_POLICY_ID`, and writes the 90-day Worker
token (Access: Policies read/write only) to `.worker-cf-token` (mode 600, gitignored, never printed). If Cloudflare rejects
the placeholder email, rerun with `--placeholder <admin email>`.

**Option B: dashboard.** Have the human follow Tutorial Step 7 Option B and tell you the policy ID, AUD tag,
team domain and the `/setup` app ID. They save the Worker token into `.worker-cf-token` themselves.

What must exist either way:
- Login method **One-time PIN**.
- Reusable **Allow** policy, session 24h, include = email rules only (one placeholder or the admin's email).
- Self-hosted app for `<SUBDOMAIN>`, session 24h, that policy, OTP as the only login method.
- Self-hosted app for `<SUBDOMAIN>/setup` with a **Bypass / Everyone** policy (temporary).

### 4. Fill `wrangler.toml`

Edit only: the `routes` pattern → `<SUBDOMAIN>`, and in `[vars]` set `INSTABOX_MACHINE_ID`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`,
`CF_ACCOUNT_ID`, `ACCESS_POLICY_ID`, `SETUP_ACCESS_APP_ID`. Optionally set `DISPLAY_TIMEZONE`. Leave `ADMIN_EMAILS` commented out (setting
it skips first-run setup). Keep the `[[durable_objects.bindings]]` (`WAKER_STATE` → `WakerState`) and `[[migrations]]`
(`new_sqlite_classes`) sections as they are.

### 5. Deploy and set secrets

```sh
npx wrangler deploy
npx wrangler secret put INSTABOX_API_KEY                   # HUMAN pastes the InstaBox key at the prompt
npx wrangler secret put CF_API_TOKEN < .worker-cf-token && rm .worker-cf-token
openssl rand -hex 24 > .setup-token && chmod 600 .setup-token
npx wrangler secret put SETUP_TOKEN < .setup-token        # you never read .setup-token
```
(On Windows PowerShell use `Get-Content FILE | npx wrangler secret put NAME`; see the tutorial for generating the token there.)

### 6. First-run setup (the human does this)

Tell the human:
1. Open `.setup-token` yourself (don't paste it here).
2. Visit `https://<SUBDOMAIN>/setup#t=<that value>`.
3. Enter your admin email → "发送验证码" → enter the same email on the Cloudflare page → type the emailed code.
4. You land on `/admin` with "✅ 初始化完成". If no code arrives, see Troubleshooting in the tutorial
   (spam folder, typo, wait a minute, personal mailbox). Without the code setup can't finish; the pending email
   expires after 15 min and can be resubmitted.

### 7. Cleanup

```sh
npx wrangler secret delete SETUP_TOKEN
rm -f .setup-token
# Option A only (the human still has CF_BOOTSTRAP_TOKEN exported):
node scripts/bootstrap-access.mjs --account <ACCOUNT_ID> --cleanup-setup <SETUP_ACCESS_APP_ID> --bypass-policy <SETUP_BYPASS_POLICY_ID>
unset CF_BOOTSTRAP_TOKEN
```
Then ask the human to **delete the bootstrap token** in the dashboard. For Option B, they delete the
`<SUBDOMAIN>/setup` app and its Bypass policy (unless the admin panel says the Worker already did).

## Verification checks

Run these and report the results (none of them reveal secrets):

```sh
npx wrangler deployments list | head                          # a deployment exists
npx wrangler secret list                                       # names only: INSTABOX_API_KEY, CF_API_TOKEN (SETUP_TOKEN gone after cleanup)
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' https://<SUBDOMAIN>/
#   expect 302 to https://<team>.cloudflareaccess.com/… (Access is in front)
curl -sS -o /dev/null -w '%{http_code}\n' https://<SUBDOMAIN>/setup
#   before setup: 200 (setup page). After setup: 404. After the bypass app is deleted: 302 to Access.
curl -sS -o /dev/null -w '%{http_code}\n' https://<SUBDOMAIN>/api/status
#   expect 302 (Access); never 200 without signing in
grep -nE '^\s*\[triggers\]|crons' wrangler.toml || echo "no cron: OK"
grep -nE 'workers_dev\s*=\s*false' wrangler.toml && grep -nE 'preview_urls\s*=\s*false' wrangler.toml
git status --porcelain                                         # .setup-token/.worker-cf-token must not appear (gitignored or deleted)
```
Then ask the human to confirm: signing in at `https://<SUBDOMAIN>/` shows the status card, the wake button works,
and `/admin` lists their email as 🔒 管理员 (admin).

## Common failures

| Symptom | Likely cause / fix |
|---|---|
| `/setup` shows the Cloudflare sign-in page | The `/setup` bypass app is missing or has the wrong path |
| `/setup` is 404 before setup | `SETUP_TOKEN` missing or under 16 chars, Durable Object binding missing, or `ADMIN_EMAILS` is set |
| "安装口令不正确" (wrong setup password) | The `#t=` value doesn't match `.setup-token` |
| Signed in, sees "尚未完成初始化" (setup not finished) | Signed in with a different email than submitted, or the 15 min expired; resubmit `/setup` |
| No OTP email | Spam folder, typo, policy propagation (wait ~1 min), OTP not enabled on the app |
| 502 on `/admin` or setup submit | `CF_API_TOKEN` invalid/expired, or wrong `ACCESS_POLICY_ID`/`CF_ACCOUNT_ID` |
| Wake errors | `INSTABOX_API_KEY` expired/revoked or wrong `INSTABOX_MACHINE_ID` |
| `wrangler deploy` fails on the Durable Object | Keep the `[[migrations]]` block; SQLite DOs work on the Free plan |

## Maintenance to mention to the human

- Both credentials are set to expire after 90 days. Before then, create a new one, `npx wrangler secret put` it, verify, and revoke the old one.
- Admins are managed in `/admin`: add an email, then "设为管理员" (make admin). The last admin can't be demoted.
