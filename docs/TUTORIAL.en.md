# instabox-waker beginner tutorial (no experience needed)

When you're done you'll have a web page, `https://waker.yourdomain/`, that only you (and people you allow) can open, with a button that wakes your InstaBox machine from your phone. You sign in with a code sent to your email, so there's no password to remember.

Time: 30–60 minutes, plus however long your domain takes to activate. Everything is free. (Cloudflare may ask for a card when you enable the Zero Trust Free plan, but it costs $0.)

> Want an AI to do it? Give [`skills/instabox-waker-deploy/SKILL.md`](../skills/instabox-waker-deploy/SKILL.md) to it (DeepSeek, Claude Code, Cursor, …). It does what it can and stops whenever you need to paste a secret yourself.

---

## What you need

- A computer (Windows, macOS or Linux) and a terminal (PowerShell on Windows).
- A **domain name** such as `example.com` (from Cloudflare, Namecheap, etc.). If you don't have one, buy one first; cheap ones cost a few dollars a year.
- An email inbox you can receive mail in (you'll sign in with it).
- An InstaBox machine and the `instabox` command-line tool, signed in.

Everywhere below, replace `waker.example.com` with your own subdomain, for example `waker.yourname.com`.

---

## Step 1: Create a Cloudflare account

1. Go to <https://dash.cloudflare.com/sign-up>, sign up with your email and verify it.
2. After signing in you're in the Cloudflare dashboard.

## Step 2: Add your domain to Cloudflare

1. On the dashboard home page click **Add a domain** and enter the root domain (`example.com`, without `waker.`).
2. Pick the **Free** plan.
3. Cloudflare shows you two **nameservers** (like `xxx.ns.cloudflare.com`). Sign in where you bought the domain and replace its nameservers with these two.
4. Wait until the domain shows **Active** (minutes to 24 hours). Cloudflare emails you when it is.

> Bought the domain from Cloudflare? This step is already done.

## Step 3: Enable Zero Trust (Free)

1. In the left menu click **Zero Trust**, or open <https://one.dash.cloudflare.com/>.
2. The first time, it asks for a **team name**. Anything works, e.g. `myteam`. Your team domain is then `myteam.cloudflareaccess.com`; you'll need it later.
3. Choose the **Free** plan (up to 50 users). It may ask for a card; the price is $0.

## Step 4: Turn on email-code login

Zero Trust → **Settings → Authentication → Login methods → Add new → One-time PIN**, then save.

(The script in Step 7 does this for you.)

## Step 5: Install the tools

1. Install **Node.js 18 or newer** from <https://nodejs.org/> (the LTS version). Check it with `node -v` in a terminal.
2. Get this project:
   ```sh
   git clone https://github.com/Tx13758627780/instabox-waker.git
   cd instabox-waker
   ```
   No git? On the GitHub page click **Code → Download ZIP**, unzip it and `cd` into the folder.
3. Sign the Cloudflare CLI in (it opens a browser; click Allow):
   ```sh
   npx wrangler login
   ```

## Step 6: Create an InstaBox key

```sh
instabox ls
```
Find your machine and note its **machine ID** (starts with `m_`).

```sh
instabox keys create -name instabox-waker -scope machines:read,machines:write -expires-in-days 90
```
It prints a key **only once**. Keep the window open; you'll paste it in Step 9. Never send it to anyone or paste it into an AI chat.

> The key expires after 90 days. Before then, create a new one, replace it with `npx wrangler secret put INSTABOX_API_KEY`, and delete the old one with `instabox keys rm`.

## Step 7: Set up Cloudflare Access (pick one)

### Option A: the script (recommended, fastest)

1. Find your **Account ID**: Cloudflare dashboard home → **Account ID** (32 hex characters), on the right or in the account menu.
2. Create a **temporary bootstrap token**: avatar (top right) → **My Profile → API Tokens → Create Token → Create Custom Token**, with these permissions:
   - Account → **Access: Apps and Policies** → Edit
   - Account → **Access: Organizations, Identity Providers, and Groups** → Edit
   - Account → **Account API Tokens** → Edit (so the script can create the small Worker token for you)

   Set Account Resources to your account and the TTL to today–tomorrow. Copy the token after creating it.
3. Run this (paste the token inside the quotes on the first line, and **don't** share it):
   ```sh
   export CF_BOOTSTRAP_TOKEN='paste here'
   node scripts/bootstrap-access.mjs --account YOUR_ACCOUNT_ID --host waker.example.com --create-worker-token
   ```
   The script prints some IDs (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ACCESS_POLICY_ID`, `CF_ACCOUNT_ID`, `SETUP_ACCESS_APP_ID`, `SETUP_BYPASS_POLICY_ID`). These aren't secrets, so they're safe to copy. The Worker token goes into the file `.worker-cf-token` and is never shown on screen.

   If it complains that the placeholder email is invalid, run it again with `--placeholder your@email` at the end.

### Option B: click through the dashboard (no bootstrap token)

In Zero Trust (the menu may be called **Access** or **Access controls**):

1. **Policy**: Access → **Policies → Add a policy**. Name `instabox-waker allow`, Action **Allow**, Session duration **24 hours**, Include → **Emails** → **the email you'll use as admin**. Save. Open the policy; the last part of the browser URL is the **policy ID**.
2. **Main app**: Access → **Applications → Add an application → Self-hosted**.
   - Name `instabox-waker`, session duration **24 hours**, domain `waker.example.com`.
   - Under Policies, select `instabox-waker allow`.
   - Under Login methods, tick only **One-time PIN** and turn on **Instant Auth**.
   - Save, then copy the **Application Audience (AUD) Tag** from the app's **Overview**.
3. **Temporary setup bypass app**: add another Self-hosted app.
   - Name `instabox-waker setup`, domain `waker.example.com`, **path `setup`**.
   - Create a new policy with Action **Bypass** and Include **Everyone**.
   - Save. The ID in the URL is `SETUP_ACCESS_APP_ID`. (Don't worry: `/setup` also needs a setup password only you know, and it's a permanent 404 after setup.)
4. **Worker token**: My Profile → API Tokens → Create Custom Token.
   - Permission: Account → **Access: Policies** → Edit. If that isn't listed, use **Access: Apps and Policies** → Edit; it's broader, but it lets the Worker delete the temporary app automatically after setup.
   - Account Resources: only your account. TTL: **90 days**.
   - Save the token into a file named `.worker-cf-token` in the project folder.

## Step 8: Fill in `wrangler.toml`

Open `wrangler.toml` in any text editor:

- In `routes`, change `waker.example.com` to your subdomain.
- `INSTABOX_MACHINE_ID` = the machine ID from Step 6.
- `ACCESS_TEAM_DOMAIN` = `yourteam.cloudflareaccess.com`.
- `ACCESS_AUD`, `CF_ACCOUNT_ID`, `ACCESS_POLICY_ID` and `SETUP_ACCESS_APP_ID` = the values from Step 7.
- Leave everything else alone. **Don't** add `[triggers]`.

## Step 9: Deploy and add the secrets

```sh
npx wrangler deploy
npx wrangler secret put INSTABOX_API_KEY
```
The second command asks for a value. Paste the InstaBox key from Step 6 and press Enter (nothing shows on screen, which is normal).

```sh
npx wrangler secret put CF_API_TOKEN < .worker-cf-token
rm .worker-cf-token
openssl rand -hex 24 > .setup-token
chmod 600 .setup-token
npx wrangler secret put SETUP_TOKEN < .setup-token
```

> No `openssl` on Windows? In PowerShell, first run `-join ((1..48) | % { '{0:x}' -f (Get-Random -Max 16) }) | Out-File -NoNewline -Encoding ascii .setup-token`. PowerShell doesn't support `<`, so use `Get-Content .setup-token | npx wrangler secret put SETUP_TOKEN` instead (same for `.worker-cf-token`).

## Step 10: First-run setup (only once)

1. Open the file `.setup-token` and look at the setup password (for your eyes only).
2. In a browser, open `https://waker.example.com/setup#t=PASSWORD`.
3. A box titled **"输入初始管理员邮箱" (enter the initial admin email)** appears. Type your email and click **发送验证码 (send code)**.
4. You're taken to the Cloudflare sign-in page. Enter the same email, then the 6-digit code from your inbox.
5. Once you're signed in you land on the **admin panel**. When you see "✅ 初始化完成" (setup complete), you're done. From now on `/setup` is always a 404.

**If the code never arrives, this step can't complete.** After 15 minutes you can open the link from step 2 again and retry, with the same or a different email.

## Step 11: Clean up (important)

```sh
npx wrangler secret delete SETUP_TOKEN
rm .setup-token
```
- Delete the temporary bypass app. With Option A, run
  `node scripts/bootstrap-access.mjs --account YOUR_ACCOUNT_ID --cleanup-setup <SETUP_ACCESS_APP_ID> --bypass-policy <SETUP_BYPASS_POLICY_ID>`.
  With Option B, delete `instabox-waker setup` (and its Bypass policy) under Access → Applications. If the admin panel shows no notice about it, the Worker already deleted it.
- **Delete the bootstrap token** on the API Tokens page. Keep the Worker token.
- You can delete any copy of the InstaBox key you saved; the Worker has it now.

## Everyday use

- Open `https://waker.example.com/` → sign in with an email code → tap **唤醒 (wake)**.
- Open `https://waker.example.com/admin` to add family or friends by email; they can then sign in to the wake page with a code. "设为管理员" (make admin) lets them manage the list too. The last admin can't be demoted.

(The interface is in Chinese; the buttons are simple, and your browser's translate feature works on it.)

---

## Troubleshooting

### The code never arrives

1. **Check spam, junk, promotions and updates folders.** The sender is Cloudflare (`noreply@notify.cloudflare.com`); add it to your contacts or allow list.
2. **Wait 1–2 minutes**, then request a new code once. Don't hammer the button.
3. **Check the email for typos.** Cloudflare only sends codes to allowed emails, so a typo means no code will ever arrive, and the page won't tell you.
4. **Signed in right after submitting?** Policy changes usually spread in seconds, but sometimes take a minute. Wait and request the code again.
5. **Work or school mailboxes** may block outside code emails. Use a personal address (Gmail, Outlook, etc.).
6. **One-time PIN isn't enabled** (Step 4), or isn't ticked under the main app's Login methods.
7. **More than 15 minutes passed**: open `/setup#t=PASSWORD` again and resubmit.

### `/setup` returns 404

- Setup is already finished. That's expected; it only works once.
- The password is missing: the link must include `#t=PASSWORD`, or you type it into the box.
- `SETUP_TOKEN` isn't set or is shorter than 16 characters, or the Durable Object section is missing from `wrangler.toml`.
- The `/setup` bypass app is missing. In that case you see the Cloudflare sign-in page instead of the box.

### "安装口令不正确" (wrong setup password)

The password must match `.setup-token` exactly, with no extra spaces or line breaks.

### After signing in: "尚未完成初始化" (setup not finished)

You signed in with a different email than the one you entered in the box, or more than 15 minutes passed. Go back to `/setup#t=PASSWORD` and submit again.

### 502 / "无法写入 Access 策略" (can't write the Access policy) / admin panel fails to load

`CF_API_TOKEN` is wrong, expired or lacks permission. Create a new one and run `npx wrangler secret put CF_API_TOKEN`.

### The wake button shows an error

`INSTABOX_API_KEY` expired or was deleted, or `INSTABOX_MACHINE_ID` is wrong. Create a new key and set it again.

### Changing or adding admins

In `/admin`, add the person's email first, then click "设为管理员" (make admin). To remove an admin, click "取消管理员" (demote) first, then delete them.
