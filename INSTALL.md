# 诗脉·启明 PoeticRealm AI v5.0 安装手册

> 面向小学古诗词教学的异构多智能体 Web 应用 · 详细安装与部署指南

本手册覆盖三种部署形态：Docker Compose 一键启动（推荐）、本地开发模式、生产部署模式，并附带国产操作系统候选部署指引与常见问题排查指南。

---

## 目录

1. [环境前提](#一环境前提)
2. [Docker Compose 一键启动（推荐）](#二docker-compose-一键启动推荐)
3. [本地开发模式](#三本地开发模式)
4. [生产部署模式](#四生产部署模式)
5. [国产操作系统部署指引（尚未完成实机兼容认证）](#五国产操作系统部署指引尚未完成实机兼容认证)
6. [常见问题排查](#六常见问题排查)
7. [卸载说明](#七卸载说明)

---

## 一、环境前提

### 1.1 软件依赖清单

| 组件 | 最低版本 | 推荐版本 | 用途说明 |
| --- | --- | --- | --- |
| Node.js | 20.19.0 LTS | 当前 Node 20 LTS | 前后端 JavaScript 运行时（Fastify 5 与构建工具要求） |
| pnpm | 10.34.5 | 10.34.5 | 由 Corepack 按 `packageManager` 字段锁定；该版本支持 Node 20，使用仓库锁文件复现依赖 |
| Docker Engine | 24.0 | 27.0 | 容器运行时 |
| Docker Compose | v2.20 | v2.29 | 多容器编排工具 |
| Git | 2.40 | 2.45 | 版本控制（克隆源码） |

### 1.2 硬件资源起点（非容量结论）

下表仅用于准备演示机，不是并发容量测试结果。当前自动化证据覆盖单机、单教师竞赛演示；30 人课堂并发、200 人年级部署和国产操作系统均尚未完成目标机压测，不得据此承诺容量。

| 部署形态 | CPU | 内存 | 磁盘 | 说明 |
| --- | --- | --- | --- | --- |
| 开发 / 演示 | 2 核 | 4 GB | 5 GB | 单机 Docker Compose 全量运行 |
| 班级试点起点 | 4 核 | 8 GB | 10 GB | 上线前须按真实接口、数据量与网络条件压测 |
| 扩容评估起点 | 8 核 | 16 GB | 30 GB | 当前单教师架构不能直接用于多教师/年级生产部署 |

### 1.3 外部服务依赖

| 服务 | 用途 | 获取方式 |
| --- | --- | --- |
| DeepSeek API Key | 大语言模型调用（deepseek-v4-pro / v4-flash） | https://platform.deepseek.com 注册获取 |
| MiMo API Key | 多模态模型调用（mimo-v2.5 / v2.5-pro / tts / asr） | https://api.xiaomimimo.com 注册获取 |

> `DEMO_MODE=true` 时可不配置模型 Key，系统会使用明确标注的本地降级结果。需要验证真实生成、ASR/TTS 或在线生图时，才配置对应服务商 Key，并通过设置页凭据测试与比赛预检确认有效；不要把格式校验当作真实调用成功。

### 1.4 端口占用说明

启动前请确认以下端口未被占用：

| 端口 | 服务 | 默认占用方 |
| --- | --- | --- |
| 5173 | 前端 Vite 开发服务器 | 本项目前端 |
| 3001 | 后端 Fastify API 服务 | 本项目后端 |
| 7474 | Neo4j Browser（HTTP 管理界面） | Neo4j 图数据库 |
| 7687 | Neo4j Bolt（二进制协议） | Neo4j 图数据库 |

### 1.5 环境验证命令

在终端执行以下命令确认依赖已就绪：

```bash
node --version        # 预期输出 v20.x.x
corepack enable
pnpm --version        # 应输出 10.34.5
docker --version      # 预期输出 Docker version 24.x 或更高
docker compose version  # 预期输出 Docker Compose version v2.20 或更高
git --version         # 预期输出 git version 2.40 或更高
```

---

## 二、Docker Compose 一键启动（推荐）

此方式只适合本机首次体验与竞赛 DEMO，三条命令可拉起前端、后端与 Neo4j。Compose 入口只绑定 `127.0.0.1:5173`，容器鉴权固定为 `AUTH_MODE=demo`；它不是 LIVE、班级并发或公网部署方案。`competition-preflight --mode live --deployment docker` 会按设计失败，直至另行提供并审计生产编排。

### 2.1 步骤一：获取源码

```bash
git clone <仓库地址> poetic-realm-v3
cd poetic-realm-v3
```

若以压缩包形式获取，解压后进入项目根目录即可。

### 2.2 步骤二：配置环境变量

复制环境变量示例文件。至少为 Neo4j 设置随机长密码；模型 Key 可按演示模式选择是否填写：

```bash
cp .env.example .env
```

使用文本编辑器打开 `.env`，按如下指引填写：

```dotenv
# DeepSeek API（真实模型验证时填写；DEMO 可留空）
DEEPSEEK_API_KEY=your_deepseek_api_key
DEEPSEEK_BASE_URL=https://api.deepseek.com

# MiMo API（真实朗读/多模态验证时填写；DEMO 可留空）
MIMO_API_KEY=your_mimo_api_key
MIMO_BASE_URL=https://api.xiaomimimo.com/v1

# Compose 会注入内部连接地址；此处只需提供随机长密码
NEO4J_PASSWORD=请生成并保存在本机密钥文件中的随机长密码

# 无 Key 本机演示保持 true；真实模型演练改为 false 并填入对应 Key
DEMO_MODE=true

# 可选：固定后端会话密钥；留空会在每次容器启动时随机生成并要求重新登录
AUTH_SESSION_SECRET=
```

> Compose 已在容器内部设置 `NEO4J_URI=bolt://neo4j:7687`、demo 认证和同源代理。不要把后端或 Neo4j 端口另行发布到宿主机；如需修改架构，必须重新做认证、Origin、WebSocket 与发布边界审计。

### 2.3 步骤三：启动全部服务

```bash
docker compose up -d
```

首次启动会执行以下操作；耗时取决于镜像源、依赖源和网络，不承诺固定分钟数：

1. 拉取 `node:20-alpine` 与 `neo4j:5-community` 镜像
2. 在容器内安装前后端 npm 依赖
3. 初始化 Neo4j 数据库（含 APOC 插件）
4. 启动后端时会自动创建 SQLite 学情数据库并写入种子数据（含示例班级与 Prompt 配方）
5. 启动前端 Vite 开发服务器

### 2.4 步骤四：验证服务状态

```bash
# 查看三个容器运行状态
docker compose ps

# 查看后端日志（确认数据库初始化完成）
docker compose logs -f backend

# 健康检查接口
curl http://localhost:5173/api/health
```

健康检查预期返回：

```json
{"status":"ok","timestamp":"2026-06-26T08:00:00.000Z","uptime":12.345}
```

### 2.5 步骤五：访问应用

浏览器打开以下地址：

| 入口 | 地址 | 说明 |
| --- | --- | --- |
| 应用主界面 | http://localhost:5173 | 教师端演示入口 |
| 同源健康检查 | http://localhost:5173/api/health | 经 Vite 代理访问后端（无 Swagger） |

当前安全 Compose 不向宿主机发布 3001、7474 或 7687；需要排障时使用 `docker compose logs` 或进入容器，不要临时开放固定口令端口。

### 2.6 服务管理命令速查

| 操作 | 命令 |
| --- | --- |
| 查看实时日志（全部服务） | `docker compose logs -f` |
| 仅查看后端日志 | `docker compose logs -f backend` |
| 重启后端服务 | `docker compose restart backend` |
| 停止全部服务（保留数据） | `docker compose down` |
| 停止并清除数据卷（重置） | `docker compose down -v` |
| 更新基础镜像 | `docker compose pull` |
| 进入后端容器调试 | `docker compose exec backend sh` |

---

## 三、本地开发模式

适合二次开发、调试源码、自定义功能扩展场景。前后端分别启动，支持热重载。

### 3.1 前置准备：独立启动 Neo4j

本地开发模式下可通过 Docker 单独启动 Neo4j。先在当前 PowerShell 生成并保存一个随机长密码，再把同一个值写入 `backend/.env`；不要使用仓库固定口令：

```bash
docker run -d \
  --name poetic-realm-neo4j \
  -p 7474:7474 -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/请替换为本机随机长密码 \
  -e NEO4J_PLUGINS='["apoc"]' \
  -e NEO4J_dbms_security_procedures_unrestricted=apoc.* \
  -e NEO4J_server_memory_heap_initial__size=256m \
  -e NEO4J_server_memory_heap_max__size=512m \
  -v neo4j_data:/data \
  -v neo4j_logs:/logs \
  --restart unless-stopped \
  neo4j:5-community
```

等待容器健康后，可在仅本机开发环境访问 http://localhost:7474 排障；不要把该端口发布到不受信任网络。

### 3.2 配置环境变量

后端使用启动工作目录中的 `.env`。在项目根目录执行：

```bash
cp .env.example backend/.env
```

编辑 `.env`，**本地开发模式下需将 Neo4j URI 改为 localhost**：

```dotenv
HOST=127.0.0.1
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=与上一步Docker容器一致的随机长密码
DEMO_MODE=true
```

无 Key 开发保持 `DEMO_MODE=true`；验证真实模型时改为 `false`，并只填写所需服务商 Key。不要把 `backend/.env` 提交或放入发布包。

### 3.3 启动后端（终端 1）

```bash
cd backend

# 使用锁文件安装依赖
pnpm install --frozen-lockfile

# 启动开发服务器（nodemon + tsx 热重载）
pnpm dev
```

后端启动成功标志：

```
[config] 环境变量校验通过
诗脉·启明后端服务已启动: http://localhost:3001
健康检查: http://localhost:3001/api/health
编排官 WebSocket: ws://localhost:3001/ws/orchestrator
...
```

### 3.4 启动前端（终端 2）

```bash
cd frontend

# 安装依赖
pnpm install --frozen-lockfile

# 启动 Vite 开发服务器
pnpm dev
```

前端启动成功标志：

```
  VITE v5.4.x  ready in 320 ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: use --host to expose
```

### 3.5 验证开发环境

1. 浏览器访问 http://localhost:5173，应见到教学驾驶舱界面
2. 后端日志应显示前端 WebSocket 连接建立
3. 修改任意前端 `.tsx` 文件，页面应自动热更新
4. 修改任意后端 `.ts` 文件，nodemon 应自动重启服务

### 3.6 开发模式特性说明

| 特性 | 说明 |
| --- | --- |
| 前端热重载 | Vite HMR，组件级热更新，保留组件状态 |
| 后端热重载 | Nodemon 监听文件变更，自动 tsx 重编译重启 |
| TypeScript 严格模式 | 前后端均启用 `strict: true`，编译期类型检查 |
| CORS 跨域 | 后端已配置允许 `http://localhost:5173` 与 `http://127.0.0.1:5173` |
| 日志美化 | 后端开发模式启用 pino-pretty，彩色化输出日志 |

---

## 四、生产部署模式

本节说明生产构建与反向代理方式。当前版本已实现签名 HttpOnly 教师会话、写请求 CSRF/Origin 防护和顶层 `teacherId` 会话绑定；默认 `AUTH_MODE=demo` 只适用于本机竞赛演示。学校长期线上服务必须改用 `AUTH_MODE=password` 或校园统一身份源、强制 TLS/Secure Cookie，并完成逐资源权限审计、集中会话撤销、备份加密与数据处理评估。生产模式下后端会托管前端构建产物，无需独立前端服务。

### 4.1 构建前端产物

```bash
cd frontend
pnpm install --frozen-lockfile
pnpm build
# 产物输出至 frontend/dist/ 目录
```

构建完成后，`frontend/dist/` 应包含 `index.html` 与 `assets/` 子目录。

### 4.2 编译后端 TypeScript

```bash
cd backend
pnpm install --frozen-lockfile
pnpm build
# 产物输出至 backend/dist/ 目录
```

### 4.3 配置生产环境变量

```dotenv
# 生产环境配置示例
NODE_ENV=production
PORT=3001
HOST=127.0.0.1

# 当前仅支持一个本地教师主体；学校统一身份源需另行实现和验收
AUTH_MODE=password
AUTH_SESSION_SECRET=至少32字符且仅存放于部署密钥管理器
AUTH_COOKIE_SECURE=true
AUTH_TEACHER_ID=teacher-001
AUTH_TEACHER_NAME=王雅琴
AUTH_PASSWORD_SCRYPT=通过pnpm-auth-hash-password交互生成的完整摘要

DEEPSEEK_API_KEY=sk-生产环境真实Key
DEEPSEEK_BASE_URL=https://api.deepseek.com

MIMO_API_KEY=生产环境真实Key
MIMO_BASE_URL=https://api.xiaomimimo.com/v1

NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=请修改为强密码
```

> 先在 `backend` 目录运行 `pnpm auth:hash-password`，把输出写入密钥管理器，不要把密码或摘要提交到仓库。`HOST=127.0.0.1` 使服务只接受本机反向代理连接；不要直接改成 `0.0.0.0`。`NODE_ENV=production` 会启用 Fastify 对 `frontend/dist/` 的同源托管。该配置仍是单教师本地账号，不是学校多租户身份方案。

### 4.4 启动 Neo4j（生产配置）

建议为生产环境分配更大内存并启用持久化：

```bash
docker run -d \
  --name poetic-realm-neo4j-prod \
  -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/强密码 \
  -e NEO4J_PLUGINS='["apoc"]' \
  -e NEO4J_server_memory_heap_initial__size=512m \
  -e NEO4J_server_memory_heap_max__size=2G \
  -e NEO4J_server_memory_pagecache_size=1G \
  -v /opt/poetic-realm/neo4j/data:/data \
  -v /opt/poetic-realm/neo4j/logs:/logs \
  --restart unless-stopped \
  neo4j:5-community
```

> 生产环境建议关闭 Neo4j Browser 的 7474 端口对外暴露，仅保留 Bolt 7687 供后端连接。

### 4.5 使用 PM2 守护后端进程

```bash
# 全局安装 PM2
npm install -g pm2

# 启动后端进程（持久化运行）
cd backend
pm2 start dist/server.js --name poetic-realm-backend

# 设置开机自启
pm2 startup
pm2 save

# 查看运行状态
pm2 status
pm2 logs poetic-realm-backend
```

### 4.6 Nginx 反向代理参考（正式部署必须目标机复验）

以下是 TLS 与 WebSocket 代理的最小参考，不是已在学校环境验收的完整安全基线。证书签发、HSTS、CSP、代理信任链、日志脱敏、限流、WAF 与运维监控须由部署方按实际域名和制度补齐：

```nginx
server {
    listen 443 ssl http2;
    server_name poetic-realm.yourschool.edu.cn;

    ssl_certificate     /etc/nginx/ssl/poetic-realm.crt;
    ssl_certificate_key /etc/nginx/ssl/poetic-realm.key;

    # 常规 API（含单文件至多 10MiB 的语音）继续使用较小入口上限。
    # 不要为了一个批改端点把整个站点都放宽到大请求体。
    client_max_body_size 15m;

    # 批改上传：后端允许最多 30 个文件、单文件 10MiB、文件总计 80MiB。
    # 90m 覆盖 80MiB 文件数据及 multipart boundary/字段/头开销；
    # 关闭请求缓冲后，Fastify 能在未知字段、重复字段或超限 part 出现时尽早停止解析。
    location = /api/grading/upload {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 90m;
        client_body_timeout 65s;
        proxy_read_timeout 65s;
        proxy_request_buffering off;
    }

    # Wan 生图的后端最坏正常路径为 90s 推理 + 30s 受控下载；
    # 前端在 125s 主动中止，因此代理读超时稍后于前端，避免代理先返回 504。
    # 响应是小型终态 JSON，不是 SSE，明确保留响应缓冲。
    location = /api/ai/image-generate {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 130s;
        proxy_buffering on;
    }

    # 前端静态资源 + 后端 API 统一入口
    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket 升级（多智能体实时协作）
    location /ws/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
    }
}
```

这里的 `90m` 是 Nginx 请求体上限（包含 multipart 开销），不是把后端的 80MiB 文件总量业务限制改成 90MiB；后端仍会独立执行 30 文件、单文件 10MiB、总文件字节 80MiB、字段、MIME 与魔数校验。`proxy_request_buffering off` 只应用于该精确上传路径。`proxy_read_timeout 130s` 也只应用于生图路径；其他路由不会因此获得更大的请求体或更长的代理等待时间。此代码块仍只是仓库内的参考示例，目标机实际 Nginx 配置必须执行 `nginx -t` 并做 80MiB 边界上传与生图超时复验。

### 4.7 数据备份策略

| 数据 | 位置 | 备份方式 | 建议频率 |
| --- | --- | --- | --- |
| SQLite 学情库 | `backend/data/poetic-realm.db` | 文件复制（停服或在线备份均可） | 每日 |
| Neo4j 图数据 | Neo4j 数据卷 | `neo4j-admin database dump` | 每周 |
| 已评估朗读音频、批改原图 | 后端受控目录 | 仅在取得授权、明确期限且加密时备份 | 按学校数据制度；不得默认每日全量复制 |
| ASR 中间音频 | `backend/static/audio/recitations/` + SQLite 中间表 | 不进入常规备份；系统 10 分钟后成对清理文件与元数据 | 不备份 |
| 生成教学插画 | `data/uploads/generated/` | 可按已核验教学资源备份；访问仍需教师会话 | 按需 |

SQLite 在线备份示例（无需停服）：

```bash
sqlite3 backend/data/poetic-realm.db ".backup '/opt/backup/poetic-realm-$(date +%Y%m%d).db'"
```

---

## 五、国产操作系统部署指引（尚未完成实机兼容认证）

项目使用 Node.js、Docker 与浏览器标准能力，理论上可在多种 Linux 发行版部署；但当前证据没有覆盖统信 UOS、银河麒麟或 deepin 实机。以下仅是候选安装路径，比赛机或学校目标机必须完成冷启动、原生模块、字体、浏览器、文件权限、网络与性能复验后，才能写入兼容清单。

### 5.1 通用前置说明

| 系统 | 常见生态 | 包管理器 | 当前结论 |
| --- | --- | --- | --- |
| 统信 UOS V20 / V25 | Debian 系 | apt / dpkg | 候选；未实机验证 |
| 银河麒麟 V10（桌面 / 服务器） | Debian/Ubuntu 系变体 | apt / dpkg | 候选；版本与架构须核对 |
| 深度 deepin V23 | Debian 系 | apt / dpkg | 候选；未实机验证 |

> 发行版版本、CPU 架构、官方软件源和安全策略可能不同。不要假设代号、包名或 Docker 官方源完全一致；先查目标系统官方文档与组织软件源策略。

### 5.2 安装 Node.js 20 LTS（统信 UOS 示例）

```bash
# 更新包索引
sudo apt update

# 安装 NodeSource 仓库（提供官方 LTS 版本）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -

# 安装 Node.js 20（含 npm）
sudo apt install -y nodejs

# 验证版本
node --version    # 预期 v20.x.x
npm --version     # 预期 10.x.x
```

> 如果系统源没有 Node.js 20.19+，应优先采用组织批准的运行时或容器镜像。是否允许 NodeSource 由目标单位的软件源与供应链策略决定。

### 5.3 安装 Docker Engine

```bash
# 安装 Docker 依赖
sudo apt install -y ca-certificates curl gnupg lsb-release

# 添加 Docker 官方 GPG 密钥
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | \
  sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg

# 添加 Docker 软件源（UOS / deepin 使用 debian 发行版）
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/debian $(lsb_release -cs) stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# 安装 Docker
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# 将当前用户加入 docker 组（免 sudo）
sudo usermod -aG docker $USER
newgrp docker

# 验证
docker --version
docker compose version
```

> ARM、x64 以及发行版代号必须在目标机实际确认；即使上游镜像提供相应架构，也仍需复验 `better-sqlite3`、`sharp`、浏览器与 Neo4j 镜像。上面的 Docker 源命令只适用于其发行版代号被官方源支持的机器。

### 5.4 启用锁定版本的 pnpm

```bash
corepack enable
pnpm --version
```

### 5.5 部署本系统

若目标机通过前述前置检查，可参考本文档 [第二节 Docker Compose 一键启动](#二docker-compose-一键启动推荐) 或 [第四节 生产部署模式](#四生产部署模式) 进行试装；最终结论以目标机复验记录为准。

### 5.6 国产 OS 特有注意事项

| 事项 | 说明 |
| --- | --- |
| 字体渲染 | 国产 OS 默认未安装 Noto Sans SC，建议执行 `sudo apt install fonts-noto-cjk` 以确保中文界面字体一致 |
| 防火墙 | 安全 Compose 仅在宿主机回环地址暴露 5173，后端与 Neo4j 端口保持容器内部；不要为排障直接开放 3001/7687。真实局域网/公网方案须先完成认证、TLS 与网络分区设计 |
| SELinux / 强制访问控制 | 若容器无法访问挂载卷，应按目标系统文档配置卷标签或最小权限策略；不要通过关闭安全机制作为长期方案 |
| 网络代理 | 校园网若需代理访问外部 API，在 `.env` 同级目录配置 `HTTP_PROXY` 与 `HTTPS_PROXY` 环境变量 |
| 离线部署 | 当前 Compose 启动时仍需下载 pnpm 与锁定依赖；只导入基础镜像不够，详见下一节边界 |

### 5.7 离线部署边界

当前 Compose 在容器启动时执行 `corepack prepare` 与 `pnpm install`，真实模型也依赖外部服务，所以仅 `docker save` 两个基础镜像**不能**构成完全离线包。现阶段可验证的是：依赖和镜像已预热后，`DEMO_MODE=true` 的本地降级链路可在断网演练中复测。

要交付正式离线包，必须另建固定摘要的前后端镜像，把锁定依赖与构建产物预装进镜像，打包全部多架构镜像和校验和，并在一台无缓存、断网的目标机执行导入、冷启动、登录、12 路由、SQLite/Neo4j、重启恢复及故障降级演练。当前仓库尚未提供这套离线镜像工件，因此不得宣称“完全离线部署已交付”。

---

## 六、常见问题排查

### 6.1 端口冲突

**现象**：`docker compose up` 或 `npm run dev` 时报错 `EADDRINUSE: address already in use`。

**排查**：

```bash
# Windows
netstat -ano | findstr :5173
netstat -ano | findstr :3001
netstat -ano | findstr :7687

# Linux / macOS
lsof -i :5173
lsof -i :3001
lsof -i :7687
```

**解决方案**：

1. 终止占用端口的进程
2. 或修改本项目端口配置：
   - 前端端口：编辑 `frontend/vite.config.ts` 中的 `server.port`
   - 本地后端端口：修改 `backend/.env` 中的 `PORT`
   - 本地 Neo4j 端口：同步修改 `docker run` 映射和 `backend/.env` 的 `NEO4J_URI`

> 本地开发修改后端端口后，还需在启动前端的环境中设置 `VITE_DEV_PROXY_TARGET=http://127.0.0.1:<新端口>`。Compose 模式只占用宿主机 5173，3001/7474/7687 均为容器内部端口。

### 6.2 Neo4j 连接失败

**现象**：后端日志报错 `Neo4jError: Could not perform discovery. No routing servers available.`

**排查步骤**：

1. 确认 Neo4j 容器已健康运行：

   ```bash
   docker compose ps neo4j
   # STATUS 应为 healthy
   ```

2. 确认 Neo4j 容器内部健康接口可达：

   ```bash
   docker compose exec neo4j wget -q -O - http://127.0.0.1:7474
   ```

   独立 `docker run` 的本地开发模式才可直接访问 `http://localhost:7474`。

3. 确认 `.env` 中 `NEO4J_URI` 配置正确：
   - Docker Compose 模式：`bolt://neo4j:7687`（使用服务名）
   - 本地开发模式：`bolt://localhost:7687`（使用 localhost）

4. 确认根 `.env` 的随机 `NEO4J_PASSWORD` 已同时注入 backend 与 neo4j；仓库不提供默认口令

**解决方案**：

```bash
# 重启 Neo4j 容器
docker compose restart neo4j

# 等待健康检查通过后再启动后端
docker compose up -d backend
```

### 6.3 API Key 无效或余额不足

**现象**：调用大模型相关功能时返回 401 或 403 错误，日志显示 `AuthenticationError` 或 `InsufficientBalance`。

**排查步骤**：

1. 确认 `.env` 中 API Key 已正确填写（无多余空格、引号）
2. 登录 DeepSeek 与 MiMo 控制台确认 Key 状态与账户余额
3. 验证网络可达性：

   ```bash
   curl -H "Authorization: Bearer $DEEPSEEK_API_KEY" \
        https://api.deepseek.com/v1/models
   ```

**解决方案**：

- 充值账户余额
- 重新生成 API Key 并更新 `.env`
- 重启后端服务使配置生效：`docker compose restart backend`

> 系统启动时不会校验 Key 有效性，仅校验格式。Key 失效不影响服务启动，但相关 AI 功能将不可用。

### 6.4 SQLite 权限错误

**现象**：后端日志报错 `SQLITE_CANTOPEN: unable to open database file`。

**原因**：`backend/data/` 目录不存在或当前用户无写入权限。

**解决方案**：

```bash
# 确保目录存在
mkdir -p backend/data

# 赋予写入权限（Linux / macOS）
chmod 755 backend/data

# Docker 模式下确认数据卷挂载正确
docker compose exec backend ls -la /app/data
```

> Docker Compose 模式下，数据持久化于命名卷 `backend_data`，删除容器不会丢失数据。仅执行 `docker compose down -v` 才会清除数据卷。

### 6.5 Node.js 版本不兼容

**现象**：启动时报错 `Error: require() of ES Module` 或 `SyntaxError: Cannot use import statement outside a module`。

**原因**：本项目前后端均使用 ES Modules（`"type": "module"`），Fastify 5 与构建链要求 Node.js 20.19.0 及以上版本。

**排查**：

```bash
node --version
# 若低于 v20.19.0，需升级
```

**解决方案**：

```bash
# 使用 nvm 升级 Node.js（推荐）
nvm install 20
nvm use 20
nvm alias default 20

# 或使用 n（npm 全局包）
sudo npm install -g n
sudo n 20
```

### 6.6 better-sqlite3 原生模块编译失败

**现象**：`pnpm install` 或 `npm install` 时报错 `node-gyp rebuild failed`。

**原因**：`better-sqlite3` 是原生 C++ 扩展，编译需要构建工具链。

**解决方案**：

```bash
# Windows：安装 Visual Studio Build Tools（Desktop development with C++）与 Python 3，
# 并在新的 PowerShell 中重试 pnpm install

# Linux / macOS：安装构建工具
sudo apt install -y python3 make g++ build-essential
```

> `node:20-alpine` 不应被假设包含完整原生编译工具链；优先使用依赖提供的匹配预编译二进制。若目标架构需要源码编译，应在自建镜像中显式安装并固定 `python3 make g++`，再做供应链与体积复审。

### 6.7 前端无法连接后端 WebSocket

**现象**：浏览器控制台报告 `/ws/orchestrator` WebSocket 连接失败。

**排查步骤**：

1. 确认后端已启动且 3001 端口可达
2. 本地开发确认 `VITE_DEV_PROXY_TARGET` 与后端端口一致；Compose 保持默认同源代理
3. 浏览器开发者工具 Network 面板查看 WebSocket 连接请求状态码
4. 若使用 Nginx 反向代理，确认已配置 WebSocket 升级（见 [4.6 节](#46-nginx-反向代理可选推荐)）

### 6.8 Docker 镜像拉取超时

**现象**：`docker compose up` 时报错 `Get "https://registry-1.docker.io/v2/": net/http: TLS handshake timeout`。

**解决方案**：

配置国内镜像加速器：

```bash
# 编辑 Docker 配置文件
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json <<-'EOF'
{
  "registry-mirrors": [
    "https://docker.mirrors.ustc.edu.cn",
    "https://hub-mirror.c.163.com",
    "https://mirror.baidubce.com"
  ]
}
EOF

# 重启 Docker
sudo systemctl daemon-reload
sudo systemctl restart docker
```

---

## 七、卸载说明

### 7.1 Docker Compose 模式卸载

```bash
# 步骤一：停止并删除容器（保留数据）
docker compose down

# 步骤二（可选）：删除数据卷（彻底清除数据）
docker compose down -v
docker volume rm poetic-realm-v3_frontend_node_modules \
                 poetic-realm-v3_backend_node_modules \
                 poetic-realm-v3_backend_data \
                 poetic-realm-v3_neo4j_data \
                 poetic-realm-v3_neo4j_logs

# 步骤三（可选）：删除 Docker 镜像
docker rmi node:20-alpine neo4j:5-community
```

### 7.2 本地开发模式卸载

```bash
# 步骤一：停止前后端进程（Ctrl+C）

# 步骤二：删除依赖目录
rm -rf frontend/node_modules backend/node_modules

# 步骤三（可选）：删除 SQLite 数据库
rm -f backend/data/poetic-realm.db

# 步骤四（可选）：删除构建产物
rm -rf frontend/dist backend/dist

# 步骤五（可选）：删除 Neo4j 容器与数据
docker stop poetic-realm-neo4j
docker rm poetic-realm-neo4j
docker volume rm neo4j_data neo4j_logs
```

### 7.3 生产模式卸载

```bash
# 步骤一：停止 PM2 守护进程
pm2 delete poetic-realm-backend
pm2 save

# 步骤二：停止 Neo4j 容器
docker stop poetic-realm-neo4j-prod
docker rm poetic-realm-neo4j-prod

# 步骤三（可选）：删除数据目录
sudo rm -rf /opt/poetic-realm

# 步骤四（可选）：删除 Nginx 配置
sudo rm /etc/nginx/conf.d/poetic-realm.conf
sudo nginx -t && sudo systemctl reload nginx
```

### 7.4 数据保留说明

| 卸载方式 | 数据是否保留 |
| --- | --- |
| `docker compose down` | 保留（数据卷未删除） |
| `docker compose down -v` | 不保留（数据卷已删除） |
| 本地模式删除 `backend/data/` | 不保留 |
| 生产模式删除 `/opt/poetic-realm` | 不保留 |

> 卸载前如需保留学情数据，请参照 [4.7 节](#47-数据备份策略) 执行数据备份。

---

## 附录：快速启动检查清单

部署完成后，请逐项确认以下检查点：

- [ ] `docker compose ps` 显示三个容器均为 `running` 状态
- [ ] Neo4j 容器健康检查为 `healthy`（约 30 秒后）
- [ ] `curl http://localhost:5173/api/health` 经同源代理返回 `{"status":"ok"}`
- [ ] 浏览器访问 http://localhost:5173 见到教学驾驶舱界面
- [ ] 教学驾驶舱显示示例班级数据（种子数据已自动写入）
- [ ] 诗脉星图页面可正常加载 D3.js 知识图谱
- [ ] DEMO 模式明确显示降级/示例标识；真实模型模式则由设置页凭据测试与流式回复共同验证 Key

全部通过即表示安装成功，可参阅 [USAGE.md](./USAGE.md) 开始使用。

---

*本手册最后更新于 2026 年 8 月 4 日。部署声明以目标机复验与最新审计证据为准。*
