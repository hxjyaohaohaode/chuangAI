# GitHub → Render 可复现部署手册

本手册对应仓库根目录的 `render.yaml`。它说明如何完成首次创建和验收；仓库中的蓝图与本地测试通过，不等于 Render 控制台已经创建服务，也不等于真实域名、供应商密钥和公网网络已经验收。

## 1. 已固化的部署契约

- Render 原生 Node 运行时，Node `24.21.0`；应用自身再次校验 `>=24.11 <25`。
- `scripts/render-build.mjs` 分别使用 `frontend/pnpm-lock.yaml` 与 `backend/pnpm-lock.yaml` 执行 `pnpm install --frozen-lockfile --prod=false`，不会制造或合并第三套锁文件。
- 前端先构建到 `frontend/dist`，后端构建到 `backend/dist`；生产时由 Fastify 同源托管前端、API、SSE、WebSocket 和受保护媒体。
- Web Service 监听 Render 注入的 `PORT`，并强制 `HOST=0.0.0.0`。
- `/api/health` 是匿名健康检查；业务 API、WebSocket 和生成图片仍受服务端会话边界保护。
- `/var/data` 是唯一持久化根：

  ```text
  /var/data/
  ├── poetic-realm.db        # SQLite + WAL/SHM
  ├── uploads/               # 批改原图
  │   └── generated/         # 已压缩 WebP + 生图索引
  └── audio/
      ├── recitations/       # 教师会话保护的朗诵录音
      └── tts/               # 范读缓存
  ```

`APP_DATA_DIR=/var/data` 控制全部运行时资产，`SQLITE_PATH=/var/data/poetic-realm.db` 作为数据库的显式二次约束。只有这个挂载点内的变更能跨重启和部署保留。

## 2. GitHub 上传前的硬门禁

不要把当前工作目录直接拖入 GitHub 网页。先在仓库根执行：

```powershell
node scripts/audit-release-boundary.mjs
node scripts/prepare-competition-release.mjs --verify-only
node scripts/render-build.mjs
node scripts/render-smoke.mjs
```

`render-smoke.mjs` 只使用进程内随机测试会话密钥、临时 scrypt 密码摘要和隔离临时目录，并显式清空真实供应商凭据。它会真实启动生产入口，并验证 `0.0.0.0`/环境 `PORT` 契约、危险监听与盘外 SQLite 配置失败关闭、健康检查、首页与 SPA 深链、匿名共享报告的精确公开边界、恶意 Origin 拒绝、Secure 会话 Cookie，以及同一 `APP_DATA_DIR` 下 SQLite 和生成目录写入探针的跨重启保留。该本地烟测通过仍不等于 Render 持久盘、TLS 或公网供应商已经验收。

如果当前项目还没有 `.git/`，先在**本项目根目录**执行一次 `git init`；不要在上级 `创AI` 或 Nutstore 根目录初始化，以免把官方材料、真实数据和其他项目卷入仓库。`git init` 只创建本地元数据，不会自动提交或联网推送。

然后人工检查：

```powershell
git init  # 仅当前项目尚无 .git/ 时执行；已有仓库可跳过
git status --short --ignored
git check-ignore -v backend/.env data/ static/audio/ audit-artifacts/
git ls-files --cached --others --exclude-standard | ForEach-Object { Get-Item -LiteralPath $_ } | Sort-Object Length -Descending | Select-Object -First 30 FullName,Length
$oversized = git ls-files --cached --others --exclude-standard | ForEach-Object { Get-Item -LiteralPath $_ } | Where-Object Length -ge 50MB
if ($oversized) { $oversized | Select-Object FullName,Length; throw '存在达到 GitHub 50 MiB 告警线的候选文件' }
```

必须确认以下内容没有进入暂存区：

- 根目录或 `backend/` 下的真实 `.env`；
- API Key、RAM AccessKey、Bearer Token、私钥、真实会话密钥、真实密码或明文密码；
- `AUTH_PASSWORD_SCRYPT` 的真实部署值（它虽是单向摘要，仍是登录认证材料）；
- `data/`、`static/audio/`、任何 `*.db*`、学生作业、朗诵音频、日志；
- `node_modules/`、`dist/`、浏览器回归截图、临时审计数据库和 Graphify 生成物。

同时检查上面列出的最大文件。GitHub 网页单文件上传上限为 25 MiB；普通 Git 对超过 50 MiB 的文件告警，并阻止超过 100 MiB 的文件。用于 Render 构建的源码、锁文件和 22 张通过文字/语义审计的受控 WebP 应保持在普通 Git 中且单文件低于 50 MiB；大型非运行时答辩录像或归档证据应在完成授权、隐私与许可证复核后使用 GitHub Release 或 Git LFS，不要把学生数据、数据库或真实上传物借 LFS 绕过本仓库的发布边界。

`.gitignore` 只阻止尚未跟踪的文件；如果某个秘密曾经被提交或暂存，必须先从 Git 索引和历史中移除并轮换相应凭据，不能把“后来加入 ignore”当作清除历史。

新仓库可在人工确认后执行：

```powershell
git add .
git diff --cached --check
git status --short
git commit -m "Prepare reproducible Render deployment"
git branch -M main
git remote add origin <你的 GitHub 仓库 URL>
git push -u origin main
```

推送前应再次浏览 `git diff --cached`。不要把 GitHub Personal Access Token 写进 remote URL、脚本或文档。

## 3. 生成密码摘要

在本机交互终端执行：

```powershell
cd backend
pnpm auth:hash-password
```

输入至少 12 个字符的长口令。脚本不接受命令行参数或管道输入，避免密码进入 Shell 历史和 CI 日志。它只输出形如 `scrypt$...` 的摘要；把摘要复制到 Render 的 `AUTH_PASSWORD_SCRYPT` Secret，禁止写入 `.env` 后提交。

## 4. 在 Render 创建 Blueprint

若已安装并登录官方 Render CLI，可先针对真实 Workspace 做语义与资源冲突校验：

```bash
render blueprints validate render.yaml --workspace <WORKSPACE_ID>
```

仓库内的 YAML/官方 JSON Schema 校验不需要账号，但不能替代这一步的 Workspace 计划、权限和现有资源冲突检查。

1. 在 Render Dashboard 选择 **New → Blueprint**，连接刚才的 GitHub 仓库。
2. 确认 Blueprint 路径是仓库根的 `render.yaml`。
3. 首次创建时填写 `sync: false` 的值：
   - `AUTH_PASSWORD_SCRYPT`：上一步生成的完整 scrypt 摘要；
   - `AUTH_TEACHER_NAME`：部署主体显示名；
   - `AUTH_TEACHER_PHONE`：系统所有者手机号。若比赛部署刻意复用内置演示手机号，
     该手机号在 `AUTH_MODE=password` 下会优先按所有者摘要认证并获得所有者权限；
     因此绝不能再把对应密码公开在登录页、仓库说明或答辩截图中。
4. `AUTH_SESSION_SECRET` 与 `CREDENTIAL_VAULT_MASTER_KEY` 由 Blueprint 的 `generateValue: true` 分别生成；不要手工替换、复制到仓库或在应用界面展示。
5. 确认实例为 `starter`、单实例、持久盘名 `poetic-realm-data`、挂载路径 `/var/data`、初始容量 `1 GB`。Starter 或更高付费实例（Starter+）是持久盘的最低部署边界；持久盘和实例会产生费用，容量可增加但不能缩小。
6. 创建并等待 Build、Deploy 和 `/api/health` 三项均成功。

Render 会自动提供 `RENDER_EXTERNAL_URL=https://<service>.onrender.com`。应用只把这个精确 HTTPS Origin 加入 CORS、CSRF 和 WebSocket 白名单，**不要手动覆盖该变量**。

云端模型凭据的唯一持久权威是 `/var/data/provider-credentials.v1.json` 加密保险柜。系统所有者登录后在“系统设置 → 模型凭据”录入或轮换 DeepSeek、MiMo、DashScope 密钥以及 Wan Workspace 地址，保存后立即生效，无需重启。浏览器和 GET 接口只接收掩码；保险柜使用独立主密钥和 AES-256-GCM 完整性保护。被认证为 `demo` 的账号只能体验合成数据，无法查看掩码、保存凭据或发起付费连通测试；与所有者手机号相同的账号在正式密码模式下按所有者身份认证，不属于该只读边界。

Blueprint 不再要求供应商密钥，因此首次部署可在零模型凭据下启动。缺少某项时对应能力必须展示诚实降级；不得伪造 URL 或密钥。具备真实值后由所有者在应用设置页补齐，并逐项执行 provider canary。

Neo4j 仍是可选外部能力：需要时在 Dashboard 配置受控实例的 `NEO4J_URI`、`NEO4J_USER`、`NEO4J_PASSWORD`。未配置可用实例时知识图谱走已有降级路径，不能宣称已验证外部 Neo4j。

## 5. 自定义域名与 Origin

先在 Render 完成自定义域名和托管 TLS 验证，再在服务 Environment 中新增：

```text
PUBLIC_APP_ORIGINS=https://teach.example.edu.cn
```

多个精确 Origin 用英文逗号分隔。配置会失败关闭，明确拒绝：

- `http://` 公网域名（HTTP 仅允许 `localhost`、`127.0.0.0/8`、`::1`）；
- `https://*.example.edu.cn` 等通配符；
- `/app` 等路径、查询参数或片段；
- `user:password@host` 凭据；
- 空条目和尾随逗号。

保存后重新部署。不要从请求 `Host` 或 `X-Forwarded-Proto` 动态扩展白名单。

## 6. 真实公网验收清单

以下项目必须针对部署后的真实 URL 执行并保存带时间戳、版本提交 SHA 和脱敏结果的证据。

### 6.1 健康、TLS 与生产壳

```bash
curl --fail --silent --show-error https://<service>.onrender.com/api/health
curl --head http://<service>.onrender.com/
curl --head https://<service>.onrender.com/
```

第一条应返回 `status: "ok"`；HTTP 应由 Render 边缘跳转 HTTPS；HTTPS 首页应返回生产 HTML 和安全响应头。健康检查通过只证明进程/路由可达，不证明模型、登录或持久化成功。

### 6.2 密码会话与 Cookie

1. 用教师 ID 和部署密码登录。
2. 在浏览器 Network/Application 面板确认会话 Cookie 含 `Secure`、`HttpOnly`、`SameSite=Strict`；CSRF Cookie 含 `Secure`、`SameSite=Strict`。
3. 错误密码反复尝试应触发限流/锁定；无会话业务 API 应返回 `401`。
4. 从未列入白名单的 Origin 发起写请求或 WebSocket，应返回 `403`。

### 6.3 WebSocket、SSE 与长请求

- 打开需要编排进度的真实页面，确认 WebSocket 握手是 `wss://` 且返回 `101`；
- 运行一次 SSE 生成流程，确认事件完整结束，没有代理提前截断、重复终态或无限重连；
- 在浏览器切换网络离线/恢复，确认界面有明确失败、重试和本地降级提示。

### 6.4 上传与生成图片

- 上传一张合法的小尺寸 PNG/JPEG/WebP，确认批改预览可读；上传超限、伪 MIME、损坏图片应被拒绝；
- 配置 Wan 后执行一次真实生图，确认返回 `/uploads/generated/<key>.webp`、刷新后仍可读，响应不是占位图；
- 不配置 Wan 时必须显示明确降级标记，不能把占位图宣传为真实模型输出。

### 6.5 重启持久性

1. 记录一个新建业务对象、一个批改上传、一个生成 WebP 和一段测试朗诵/TTS 的受控标识；
2. 从 Render Dashboard 执行 Manual Deploy 或 Restart；
3. 重启后逐项确认数据库记录和文件仍存在、仍受认证保护；
4. 在 Shell 中确认这些文件全部位于 `/var/data`，仓库目录中没有新的运行时资产。

如果任一项丢失，立即停止真实数据试点；这通常意味着服务未挂盘、挂载路径错误、环境变量未生效，或仍有未纳入 `APP_DATA_DIR` 的写入点。

## 7. Render/SQLite 的外部边界

- **Starter 或更高付费实例（Starter+）是本项目持久盘部署的最低配置。** Free Web Service 没有持久盘；其本地 SQLite、上传、生成图片和音频会随休眠、重启或部署丢失，不能用于本项目的生产、比赛部署或长期演示。
- 挂盘服务只能单实例，不能水平扩容，并且部署时没有零停机实例切换。比赛现场需预留维护窗口，不要在答辩前临时部署。
- 持久盘在 Build、Pre-deploy 和 one-off job 中不可用；数据库初始化必须在运行时完成，本仓库已按此设计。
- 每日磁盘快照不应成为 SQLite 唯一备份策略。应定期做 SQLite 一致性备份、复制到独立加密存储，并实际演练恢复；恢复前停止写入，避免 WAL 与主文件时间点不一致。
- 若未来需要多实例、跨区或严格零停机，应把业务数据库迁移到托管数据库，把上传/音频/WebP 迁移到对象存储；不能让多个实例共享当前单文件 SQLite。
- Render 控制台账号、GitHub 权限、付费计划、域名 DNS、TLS 签发、服务商余额/限流和中国大陆到 Render/模型供应商的网络质量都属于外部验收项，代码不能代替它们。

## 8. 官方依据（部署当日仍需复核）

- [Render Blueprint YAML Reference](https://render.com/docs/blueprint-spec)
- [Render Web Services 与 0.0.0.0:$PORT](https://render.com/docs/web-services)
- [Render 默认环境变量（含 RENDER_EXTERNAL_URL）](https://render.com/docs/environment-variables)
- [Render Node 版本解析](https://render.com/docs/node-version)
- [Render Persistent Disks 与限制](https://render.com/docs/disks)
- [Render Free 实例的数据丢失限制](https://render.com/docs/free)
- [GitHub 大文件与 25/50/100 MiB 边界](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github)

上述文档链接已在 2026-08-10 复核；Render 字段、套餐和价格会变化，真正创建服务前必须再次查看官方现态。
