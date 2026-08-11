# 全国奖目标系统终审报告（阶段版，2026-07-28）

> 历史阶段快照：本文件记录 2026-07-28 的问题基线和当时门禁，不代表 2026-08-04 的当前状态；升级后的技术证据以 `2026-08-01-extreme-audit-and-award-readiness.md`、`2026-08-01-verification-matrix.md` 和最新 JSON 证据为准。

## 审计结论

项目已经从“多数页面可展示”提升到“生产构建可启动、主路由可刷新、30 组 UI 回归为零失败、课堂主闭环可重复验证、入口不可达死文件归零”的状态。

但当前**不符合“可以无保留宣称全国最高奖/前 1%”的证据标准**。技术绿灯不能替代真实落地和提交材料，425 项测试通过也不能掩盖覆盖率门槛失败。

## 本轮修复

### P0/P1 功能与构建

- 修复 `Combobox` 只读选项类型导致的前端 TypeScript 构建失败。
- 修复课堂页面演示主键与真实数据库主键混用造成的首屏 404。
- 增加 favicon，消除默认静态资源 404。
- 增加生产 History API fallback；未知 API/uploads 保留 JSON 404。
- Fastify 升级到 5.10，并修复 `loggerInstance` 兼容。
- 生产 5xx 响应隐藏内部异常详情，4xx 保留可操作信息。

### 安全与依赖

- 后端生产依赖审计：0 已知漏洞。
- 增加 Helmet 安全头与生产 CSP。
- 后端默认监听从 `0.0.0.0` 收敛到 `127.0.0.1`；Docker 通过显式 `HOST=0.0.0.0` 暴露。
- 修正文档和隐私页中不真实的登录、K-匿名、录音外发和模型数据承诺。
- 前端 React Router 剩余 1 个 high advisory；官方说明仅影响 unstable RSC API。本项目使用 `BrowserRouter` 声明式 SPA，不使用 RSC/SSR/Action，因此当前调用路径不可达。仍需跟踪 `react-router-dom` 兼容修复版。

### 死代码与架构

- 删除前端 41 个、后端 11 个入口不可达文件。
- Knip 前后端 unused files 均归零。
- Graphify 前后端 import cycle 均为 0。
- 识别 `types.ts`、`api.ts`、`classroom.ts` 等巨型模块作为后续维护风险。

### 回归与证据

- 前端生产构建通过。
- 后端构建通过。
- 后端 13 个测试文件、425 项测试通过。
- 30 个桌面/移动路由组合：0 warning、0 failure。
- 链接审计：241 个文件、96,769 行，死链/冗余/占位为 0。
- 星图接口：924 节点、10,343 边，重复节点/边、悬空边均为 0。
- 课堂闭环脚本通过并输出 JSON 证据。
- Docker Compose 配置可解析。

## 未通过项

### 阻断全国最高奖声明

1. `提交材料/` 无最终文件；报告、PPT、视频、PDF/ZIP 资源包未完成。
2. 无真实教师/班级使用记录、第三方反馈和量化成效。
3. 服务端身份认证与细粒度授权未实现；当前只能安全声明为本机/隔离环境竞赛原型。
4. 后端覆盖率未达自身 80% 门槛：
   - Statements 47.13%
   - Branches 31.52%
   - Functions 42.16%
   - Lines 50.25%
5. 外部模型、OCR、ASR/TTS、生图、Neo4j、并发与真机没有完整验收。

### 高优先级工程风险

- `frontend/src/lib/types.ts` 6,072 行、`api.ts` 4,450 行。
- `backend/src/routes/classroom.ts` 3,697 行、`report.ts` 2,649 行、`diagnosis.ts` 2,235 行。
- 懒加载 `three-vendor` 仍为 837.48KB（gzip 225.54KB）；不是首屏阻断，但低端设备首次进入 3D 页面存在卡顿风险。
- README 约 140KB 首屏 JS 是构建体积推算，不是浏览器网络瀑布；Lighthouse、FCP、LCP、CLS 尚未实测。

## 为什么这些结论不是幻觉

| 结论 | 证据类型 |
|---|---|
| 页面能打开且无控制台/HTTP 错误 | Playwright 生产 E2E JSON + 30 张截图 |
| 主课堂闭环可跑 | 可重复脚本 + SQLite 持久化查询 + JSON |
| 没有入口不可达文件 | Knip 前后端二次扫描为 0 |
| 没有 import cycle | Graphify 重建报告 |
| 单测通过但覆盖不足 | Vitest 原始输出与非零退出 |
| 安全头已启用 | 生产 HTTP 响应头 |
| 不能证明真实落地 | 提交目录为空且无第三方材料 |
| 不能称生产级安全 | 代码中无服务端认证中间件；登录状态在 localStorage |

## 建议的下一阶段顺序

1. 先补真实落地：试用协议、匿名前后测、教师反馈、使用日志。
2. 同步实现服务端认证/授权与审计日志，确定可发布边界。
3. 为仓储、关键路由和 LLM 客户端补测试，把覆盖率拉到 80%。
4. 完成真实 OCR/ASR/TTS/生图/Neo4j/并发验证。
5. 基于真实数据写 ≤3000 字报告与 8 分钟脚本。
6. 完成 PPT、录屏、真人解说与技术参数验收。
7. 让一名未参与开发的人从全新环境按 INSTALL 盲装，记录并修复所有阻塞。

## 复验命令

```powershell
# 前端
cd frontend
pnpm install --frozen-lockfile
pnpm run build
pnpm run link-audit:json
$env:E2E_BASE_URL='http://127.0.0.1:3001'
pnpm run e2e:regression

# 后端
cd ../backend
pnpm install --frozen-lockfile
pnpm run lint
pnpm run build
pnpm run test
pnpm run test:coverage      # 当前预期因未达 80% 而非零退出
pnpm run test:closed-loop

# 依赖与部署
pnpm audit --prod --registry=https://registry.npmjs.org
cd ..
docker compose config --quiet
```
