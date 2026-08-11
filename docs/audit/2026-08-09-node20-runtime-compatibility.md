# Node 20 运行时兼容性修复与复核

复核日期：2026-08-09

## 结论

项目声明的比赛机运行时是 Node `>=20.19 <21`。本轮已用官方 Windows x64 便携
Node **20.20.2** 和 Corepack pnpm **10.34.5** 完成前后端冻结安装、原生 SQLite
探针、后端全量测试/路由烟测、前端生产构建/生产同源 E2E 以及 DEMO 赛前预检。

最终 Node 20 DEMO 预检为 **32 PASS / 3 WARN / 0 FAIL**。三个警告是许可证人工复核、
148 首诗篇人工验收和授权真实试点，均未被技术状态伪装为通过。

## 发现的真实阻断

初始配置同时声明 Node `>=20.19 <21` 与 pnpm 11.18.0。实际在 Node 20.20.2 中启动
pnpm 11.18.0 时，pnpm 报告要求 Node `>=22.13`，并因缺少 `node:sqlite` 退出。后端的
`better-sqlite3@13.0.1` 还声明 `engines.node: >=22`；将 Node 20 放入 PATH 并启动隔离
服务时，最小 SQLite 进程以 Windows `0xC0000005` 崩溃。

这两个结果证明旧配置不是“仅文档提示不一致”，而是会阻断 Node 20 比赛机安装和运行的
真实故障。因此不能继续将 Node 20 与 pnpm 11 / better-sqlite3 13 描述为已验证组合。

## 修复方案

1. 前后端 `packageManager` 统一锁定为 `pnpm@10.34.5`。官方 npm registry 元数据显示该
   版本支持 Node `>=18.12`，满足 Node 20。
2. Docker Compose、赛前预检、安装手册、使用手册与赛场 SOP 同步使用 pnpm 10.34.5。
   预检在仓库根目录显式调用 `pnpm@10.34.5`，不再依赖根目录外子项目的声明或机器缓存默认值。
3. 后端 `better-sqlite3` 固定为 `12.11.1`；官方 npm registry 元数据显示其支持
   `20.x || 22.x || 23.x || 24.x || 25.x || 26.x`。锁文件按官方 registry 更新。
4. 不通过关闭 engine 检查、伪造版本号或让 Node 24 生命周期脚本代替 Node 20 编译来掩盖问题。

## 复核证据

| 层级 | 实际执行与结果 |
|---|---|
| 运行时来源 | 官方 Node 20.20.2 Windows x64 ZIP；SHA-256 `dc3700fdd57a63eedb8fd7e3c7baaa32e6a740a1b904167ff4204bc68ed8bf77` 与官方 `SHASUMS256.txt` 一致 |
| 前端依赖 | Node 20 + pnpm 10.34.5 下 `pnpm install --frozen-lockfile` 通过 |
| 前端构建 | `pnpm lint`、`pnpm build` 通过；真实初始 preload/module gzip 93,725B / 120,000B |
| SQLite 原生模块 | Node 20 PATH 首位时以 Node 20.20.2 头文件构建 `better-sqlite3@12.11.1`；内存库建表、写入、查询探针返回 `42` |
| 后端回归 | `pnpm lint` 通过；51 个测试文件、616 项测试通过；受配置范围内语句 97.04%、分支 76.70%、函数 97.32%、行 97.49% |
| 路由与流 | 210 条破坏性路由 0 失败；218 HTTP + 1 WebSocket 运行时证据通过；DEMO SSE 正常结束、首帧取消、取消后健康检查通过 |
| 教学闭环 | Node 20 下课堂启动、答题、事件入库、热点变化、趋势刷新与报告持久化闭环通过 |
| 浏览器回归 | Node 20 下生产同源 E2E：32 个界面—视口组合，0 警告、0 失败 |
| 赛前预检 | Node 20 DEMO 本地模式：32 PASS / 3 WARN / 0 FAIL；课堂启动持久化失败关闭与前端无假导航/安全重试契约已纳入；提交物哈希 8/8 通过 |
| 发布边界 | Node 20 下白名单发布验证：1,289 文件；发布候选密钥 0、链接 0、本地私密文件 51 个被排除 |

## 本机运行时漂移的二次复核

2026-08-09 的后续复核没有沿用旧结论：机器上的默认 `C:\node.exe` 为 Node 24.15.0，桌面运行时包中的 Node 也为 24.14.0，且用户级 Corepack 缓存会优先解析 pnpm 11.18.0。pnpm 11 要求 Node `>=22.13`，所以它不能作为 Node 20 验证器。

本次仅在临时运行时目录放置官方 Node 20.20.2 Windows x64 ZIP，ZIP SHA-256
`dc3700fdd57a63eedb8fd7e3c7baaa32e6a740a1b904167ff4204bc68ed8bf77` 已与官方
`SHASUMS256.txt` 对照。新的空 Corepack 缓存只激活 `pnpm@10.34.5`，随后实测：

- Node `20.20.2`、pnpm `10.34.5`；前端 TypeScript 检查与生产构建通过，初始 gzip `93,725B / 120,000B`。
- 密码认证生产同源 E2E：32 个界面—视口组合，0 警告、0 失败。
- DEMO 本地赛前预检：32 PASS / 3 WARN / 0 FAIL；白名单发布复核：1,289 文件通过。

同一次复核还捕获了 E2E 父命令被错误 PATH 解析为 Node 24 后加载 Node 20 构建的
`better-sqlite3` 时出现的 ABI 不匹配。`frontend/scripts/run-e2e-isolated.mjs` 已在任何
端口、临时数据库或后端子进程创建前强制拒绝非 Node `>=20.19 <21`；Node 24.15.0 的
负向执行已确认以具名错误退出。此门禁降低“错误运行时导致原生模块崩溃”的定位成本，
但实体比赛机仍必须按本页 SOP 在干净环境重新执行。

## 仍需赛前人工复核的边界

- 本证据来自隔离的本机 Windows Node 20.20.2；实体比赛机仍必须从干净环境按 SOP 冷启动复跑。
- 本机 Docker Client 存在但 Docker daemon 未启动，因此本轮不能把 Docker Compose 记为已实机验证。
- 许可证、诗篇教师验收与真实试点属于人工/外部证据，不得以本运行时通过替代。
- 若更改 Node 主版本、pnpm、`better-sqlite3`、锁文件、SQLite 构建工具链或 Docker 基础镜像，必须重新执行本页列出的完整验证链。
