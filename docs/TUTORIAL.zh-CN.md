# instabox-waker 新手教程（零基础）

做完之后你会得到：一个只有你（和你允许的人）能打开的网页 `https://waker.你的域名/`，手机上点一下就能唤醒你的 InstaBox 机器。登录靠邮箱验证码，不需要记密码。

预计用时：30～60 分钟（不算等待域名生效的时间）。全程免费（Cloudflare 开通 Zero Trust 免费版时可能要求绑定一张卡，但不会扣费）。

> 想让 AI 帮你做？把 [`skills/instabox-waker-deploy/SKILL.md`](../skills/instabox-waker-deploy/SKILL.md) 发给它（DeepSeek、Claude Code、Cursor 等都可以）。它会做能做的部分，并在需要你粘贴密钥的时候停下来让你自己粘贴。

---

## 你需要准备

- 一台电脑（Windows / macOS / Linux 都行），能打开"终端"（Windows 用 PowerShell）。
- 一个**域名**（比如在 Cloudflare、Namecheap、阿里云买的 `example.com`）。没有的话需要先买一个，便宜的一年几美元。
- 一个能收邮件的邮箱（以后用来登录）。
- 一台 InstaBox 机器，以及已登录的 `instabox` 命令行工具。

下面所有的 `waker.example.com` 都换成你自己的子域名，比如 `waker.yourname.com`。

---

## 第 1 步：注册 Cloudflare 账号

1. 打开 <https://dash.cloudflare.com/sign-up>，用邮箱注册并验证邮箱。
2. 登录后就是 Cloudflare 控制台。

## 第 2 步：把域名加到 Cloudflare

1. 控制台首页点 **Add a domain / 添加域**，输入你的根域名（`example.com`，不要带 `waker.`）。
2. 选 **Free** 套餐。
3. Cloudflare 会给你两个 **nameserver**（形如 `xxx.ns.cloudflare.com`）。登录你买域名的网站，把域名的 nameserver 改成这两个。
4. 等它变成 **Active**（几分钟到 24 小时）。Cloudflare 会发邮件通知你。

> 域名本来就在 Cloudflare 买的？这一步已经自动完成了。

## 第 3 步：开通 Zero Trust 免费版

1. 控制台左侧菜单点 **Zero Trust**（或直接打开 <https://one.dash.cloudflare.com/>）。
2. 第一次进入会让你起一个 **team name（团队名）**，随便起，比如 `myteam`。你的团队域名就是 `myteam.cloudflareaccess.com`，后面要用。
3. 选择 **Free** 套餐（最多 50 个用户，够用了）。可能要求绑卡，价格是 $0。

## 第 4 步：打开"邮箱验证码"登录方式

Zero Trust → **Settings（设置）→ Authentication（身份验证）→ Login methods（登录方式）→ Add new（添加）→ One-time PIN**，保存。

（用下面第 7 步的脚本的话，脚本会自动做这一步。）

## 第 5 步：安装工具

1. 安装 **Node.js 18 或更新版本**：<https://nodejs.org/>，下载 LTS 版安装。装完在终端里输入 `node -v`，能看到版本号就行。
2. 下载本项目：
   ```sh
   git clone https://github.com/Tx13758627780/instabox-waker.git
   cd instabox-waker
   ```
   没有 git 的话，在 GitHub 页面点 **Code → Download ZIP**，解压后在终端里 `cd` 进去。
3. 登录 Cloudflare 命令行工具（会打开浏览器让你点"允许"）：
   ```sh
   npx wrangler login
   ```

## 第 6 步：创建 InstaBox key

```sh
instabox ls
```
找到你的机器，记下以 `m_` 开头的 **机器 ID**。

```sh
instabox keys create -name instabox-waker -scope machines:read,machines:write -expires-in-days 90
```
屏幕上会显示一个 key，**只显示这一次**。先别关窗口，第 9 步要粘贴它。不要把它发给任何人或任何 AI 聊天窗口。

> 90 天后这个 key 会过期，到期前重新创建一个，用 `npx wrangler secret put INSTABOX_API_KEY` 替换，再用 `instabox keys rm` 删除旧的。

## 第 7 步：设置 Cloudflare Access（二选一）

### 方式 A：用脚本（推荐，最快）

1. 找到你的 **账号 ID**：Cloudflare 控制台首页 → 右侧或账号菜单里的 **Account ID**（32 位十六进制）。
2. 创建一个**临时的 bootstrap token**：右上角头像 → **My Profile → API Tokens → Create Token → Create Custom Token**，权限添加：
   - Account → **Access: Apps and Policies** → Edit
   - Account → **Access: Organizations, Identity Providers, and Groups** → Edit
   - Account → **Account API Tokens** → Edit（让脚本帮你生成 Worker 专用的小权限 token）

   Account Resources 选你的账号，TTL 设成今天到明天。创建后复制 token。
3. 运行（把 token 粘贴到第一行引号里，**不要**发给别人）：
   ```sh
   export CF_BOOTSTRAP_TOKEN='粘贴到这里'
   node scripts/bootstrap-access.mjs --account 你的账号ID --host waker.example.com --create-worker-token
   ```
   脚本会打印一串 ID（`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`、`ACCESS_POLICY_ID`、`CF_ACCOUNT_ID`、`SETUP_ACCESS_APP_ID`、`SETUP_BYPASS_POLICY_ID`），这些不是密码，可以放心复制。Worker 专用 token 被写进了 `.worker-cf-token` 文件，不会显示在屏幕上。

   如果报错说邮箱不合法（placeholder），在命令末尾加 `--placeholder 你的邮箱` 再跑一次。

### 方式 B：在网页上点（不想用 bootstrap token 时）

在 Zero Trust 控制台（菜单可能叫 **Access** 或 **Access controls**）：

1. **策略**：Access → **Policies → Add a policy**。名称 `instabox-waker allow`，Action = **Allow**，Session duration = **24 hours**，Include → **Emails** → 填**你打算用作管理员的邮箱**。保存。打开这个策略，浏览器地址栏最后那一段就是**策略 ID**。
2. **主应用**：Access → **Applications → Add an application → Self-hosted**。
   - 名称 `instabox-waker`，Session duration **24 hours**，域名填 `waker.example.com`。
   - Policies 里选择上一步的 `instabox-waker allow`。
   - Login methods 只勾 **One-time PIN**，并打开 **Instant Auth（自动跳转）**。
   - 保存后在应用的 **Overview** 里复制 **Application Audience (AUD) Tag**。
3. **安装页临时放行应用**：再 Add 一个 Self-hosted 应用。
   - 名称 `instabox-waker setup`，域名 `waker.example.com`，**Path 填 `setup`**。
   - 新建一个策略：Action = **Bypass**，Include = **Everyone**。
   - 保存。地址栏里的那段 ID 就是 `SETUP_ACCESS_APP_ID`。（别担心，`/setup` 还需要只有你知道的安装口令，安装完成后永久 404。）
4. **Worker 专用 token**：My Profile → API Tokens → Create Custom Token。
   - 权限：Account → **Access: Policies** → Edit（列表里没有的话，选 **Access: Apps and Policies** → Edit，范围大一点，但安装完成后 Worker 能自动删除上面的临时应用）。
   - Account Resources 只选你的账号；TTL 设 **90 天**。
   - 创建后把 token 存进项目目录下的 `.worker-cf-token` 文件。

## 第 8 步：填写 `wrangler.toml`

用任意文本编辑器打开 `wrangler.toml`：

- `routes` 里把 `waker.example.com` 改成你的子域名；
- `INSTABOX_MACHINE_ID` = 第 6 步的机器 ID；
- `ACCESS_TEAM_DOMAIN` = `你的团队名.cloudflareaccess.com`；
- `ACCESS_AUD`、`CF_ACCOUNT_ID`、`ACCESS_POLICY_ID`、`SETUP_ACCESS_APP_ID` = 第 7 步得到的值；
- 其他保持不变。**不要**加 `[triggers]`。

## 第 9 步：部署并写入密钥

```sh
npx wrangler deploy
npx wrangler secret put INSTABOX_API_KEY
```
第二条命令会让你粘贴，把第 6 步的 InstaBox key 粘贴进去回车（屏幕上不会显示，这是正常的）。

```sh
npx wrangler secret put CF_API_TOKEN < .worker-cf-token
rm .worker-cf-token
openssl rand -hex 24 > .setup-token
chmod 600 .setup-token
npx wrangler secret put SETUP_TOKEN < .setup-token
```

> Windows 没有 `openssl`？在 PowerShell 里先运行 `-join ((1..48) | % { '{0:x}' -f (Get-Random -Max 16) }) | Out-File -NoNewline -Encoding ascii .setup-token`，再执行最后一行。Windows 的 PowerShell 不支持 `<`，改用 `Get-Content .setup-token | npx wrangler secret put SETUP_TOKEN`（`.worker-cf-token` 同理）。

## 第 10 步：首次安装（只有这一次）

1. 打开 `.setup-token` 文件看里面的口令（只给你自己看）。
2. 浏览器打开：`https://waker.example.com/setup#t=口令`
3. 会弹出 **"输入初始管理员邮箱"**，输入你的邮箱，点 **发送验证码**。
4. 页面会跳到 Cloudflare 登录页，再输入一次同一个邮箱，查收邮件里的 6 位验证码并填入。
5. 登录成功后自动进入 **管理员面板**，看到"✅ 初始化完成"就大功告成。从此 `/setup` 永远是 404。

**收不到验证码 = 这一步完成不了。** 你可以在 15 分钟后重新打开第 2 步的链接，换个邮箱或再试一次。

## 第 11 步：收尾（重要）

```sh
npx wrangler secret delete SETUP_TOKEN
rm .setup-token
```
- 删除临时放行应用：方式 A 用
  `node scripts/bootstrap-access.mjs --account 你的账号ID --cleanup-setup <SETUP_ACCESS_APP_ID> --bypass-policy <SETUP_BYPASS_POLICY_ID>`；
  方式 B 在 Access → Applications 里删除 `instabox-waker setup`（以及它的 Bypass 策略）。如果管理员面板没有提示，说明 Worker 已经自动删掉了。
- 到 API Tokens 页面**删除 bootstrap token**（Worker 专用 token 保留）。
- 在 InstaBox 那边保存好的 key 文本可以删掉了（Worker 里已经有了）。

## 日常使用

- 打开 `https://waker.example.com/` → 邮箱验证码登录 → 点 **唤醒**。
- 打开 `https://waker.example.com/admin` → 添加家人朋友的邮箱，他们就能用验证码登录唤醒页；"设为管理员"可以让他们也能管理名单。最后一个管理员不能被取消。

---

## 常见问题

### 收不到验证码

1. **看垃圾邮件 / 广告邮件 / 促销** 文件夹。发件人是 Cloudflare（`noreply@notify.cloudflare.com`），把它加入联系人或白名单。
2. **等 1～2 分钟**，再点重新发送。不要连续狂点。
3. **检查邮箱有没有拼错**。Cloudflare 只给允许列表里的邮箱发验证码，拼错了就永远收不到，而且页面不会提示错误。
4. **刚提交就去登录**：策略同步到全球通常只要几秒，偶尔要 1 分钟。等一下再请求验证码。
5. **公司 / 学校邮箱** 可能拦截外部验证码邮件，换成 Gmail、Outlook、QQ 邮箱等个人邮箱。
6. 第 4 步 **One-time PIN 没打开**，或者主应用的 Login methods 没勾选 One-time PIN。
7. 超过 15 分钟没完成：重新打开 `/setup#t=口令` 再提交一次即可。

### 打开 `/setup` 是 404

- 已经安装完成（正常现象，它是一次性的）；
- 链接里的口令缺失：必须带 `#t=口令`，或者在弹窗里手动输入；
- `SETUP_TOKEN` 没写入 / 少于 16 个字符，或者 `wrangler.toml` 里少了 Durable Object 配置；
- `/setup` 的放行应用没建好，这时你会先看到 Cloudflare 登录页而不是弹窗。

### 弹窗提示"安装口令不正确"

口令要和 `.setup-token` 里的完全一致（不要多空格或换行）。

### 登录后显示"尚未完成初始化"

你登录用的邮箱和弹窗里填的不一样，或者已经超过 15 分钟。回到 `/setup#t=口令` 重新填写。

### 页面显示 502 / "无法写入 Access 策略" / 管理员面板加载失败

`CF_API_TOKEN` 错了、过期了或权限不够。重新创建并 `npx wrangler secret put CF_API_TOKEN`。

### 唤醒按钮报错

`INSTABOX_API_KEY` 过期或被删除，或者 `INSTABOX_MACHINE_ID` 填错了。重新创建 key 并写入。

### 我想换掉 / 增加管理员

在 `/admin` 里先添加对方邮箱，再点"设为管理员"。要移除管理员，先"取消管理员"再删除。
