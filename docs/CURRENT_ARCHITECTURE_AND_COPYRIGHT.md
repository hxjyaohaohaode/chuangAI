# 诗脉·启明：当前架构、可验证边界与软著材料核对

更新日期：2026-09-27。本文描述当前源码与可复现的本地验证方式；带日期的 `docs/audit/` 报告保留为历史证据，不能直接继承其通过结论。

## 产品边界

本系统是面向小学古诗词教学的**教师端**应用。教师可从诗目和班级数据进入备课、六阶命题、课堂问答、批改、诊断、报告、创作及文化讲解等模块。学生自学端、学校统一身份管理和经独立验证的教学提分效果不在当前交付范围内。演示班级与姓名是合成数据；界面显示名和持久化学生 ID 分离。

核心教学链路是：诗目与班级选择 → 教师审查 AI 计划与题目 → 课堂活动和作答入库 → 六阶分析与报告 → 教师调整下一次教学。每个 AI 建议都应由教师判断，不把模型输出当成权威学科结论。

## 代码结构与数据流

| 区域 | 当前职责 | 主要入口 |
| --- | --- | --- |
| `frontend/src/pages` | 教师业务页面；移动与桌面视口 | `frontend/src/App.tsx` |
| `frontend/src/stores`、`frontend/src/lib` | 前端状态、HTTP/SSE/WS 调用与会话处理 | `frontend/src/lib/api.ts` |
| `backend/src/routes` | Fastify 业务接口与输入校验 | `backend/src/server.ts` |
| `backend/src/orchestrator`、`backend/src/agents` | 教师批准后执行 DAG、分工 Agent、暂停/恢复/修改/中止 | `backend/src/orchestrator/Orchestrator.ts` |
| `backend/src/llm` | 模型选择、重试、降级、计费 | `backend/src/llm/router.ts` |
| `backend/src/db` | SQLite 业务与运行时状态；Neo4j 为可选图谱增强 | `backend/src/db/index.ts` |
| `backend/src/security`、`backend/src/observability` | 服务端会话、凭据加密与运行证据 | `backend/src/security/auth.ts` |

业务接口返回服务端状态作为当前操作的权威结果。WebSocket 用于跨页/跨端通知，断线后客户端需要重新查询权威状态。编排计划由模型生成草案，执行前由教师批准并重新进行结构、Agent 注册表、依赖图与输入大小校验。一个会话只允许一条执行循环；任务控制同时校验 `sessionId` 与 `taskId`。暂停与输入修改先等待旧调用结束，避免旧输出覆盖新输入。运行时观测只广播白名单元数据，原始教学输入和模型输出不进入全局观测通道。

## 身份、隐私与真实性

- Fastify 签发 HttpOnly 签名会话，写请求校验 CSRF；WebSocket 握手要求允许的 Origin。编排会话控制与订阅还要复核会话所有者。
- 当前部署按**单教师本地租户**设计。上述边界不能替代校园多租户授权、集中撤销、备份加密与真实学校数据合规评估。
- 长期记忆由教师主动开启，学生记忆必须绑定教师、班级和学生；默认保留期按主体类型设置，可查询和删除。输入中的直接身份标识符会被拒绝。脱敏规则不是保证任何文本都不可反推的证明。
- 148 首运行时诗集代表系统收录量，逐首双信源与语文教师验收以 `evidence/content/` 工作表为准；模型生成的讲解、拼音和评价均需人工复核。
- DEMO 仅验证代码在合成数据与受控模型响应下的行为；真实课堂、供应商可用性、模型质量、成效与软著授权归属需要独立证据。

## 本地回归的可复现命令

以 `.node-version` 指定的 Node 24.21.0、Corepack pnpm 10.34.5 执行。前后端各有冻结锁文件；不要以无锁安装替代。

```text
backend:  pnpm install --frozen-lockfile
          pnpm lint && pnpm test && pnpm build
          pnpm test:closed-loop
          pnpm test:routes
frontend: pnpm install --frozen-lockfile
          pnpm lint && pnpm test && pnpm build
          pnpm e2e:password
root:     node scripts/audit-api-contracts.mjs
          node scripts/audit-production-dependencies.mjs
          node scripts/audit-release-boundary.mjs
          node scripts/competition-preflight.mjs --mode demo --deployment local --write
```

集成测试与浏览器测试会启动隔离服务，按顺序运行以避免端口和构建产物竞争。完整证据应保存命令退出码、运行时版本、时间、失败数以及所用测试数据类型；`docs/audit/*-latest.json` 是工具输出，不能代替真实使用记录。

## 2026-09-27 本地受控验证摘要

冻结安装、前后端类型检查和生产构建通过。后端 82 个测试文件共 801 项，前端 26 个文件共 112 项；教学闭环、211 条破坏性主业务路由、219 条 HTTP 与 1 条 WebSocket 运行时端点、32 个界面视口组合生产同源 E2E（0 警告、0 失败）通过。API 契约为 211 条前端调用、220 个后端端点，0 路径缺失与 0 方法错配。生产依赖安全审计当前需修复项为 0；演示预检为 33 PASS、4 WARN、0 FAIL；发布包隔离复核通过 1714 个文件。

四项 WARN 分别是未配置的 Wan 生图端点、Sharp Windows 原生包的平台许可证复核、诗文双信源与语文教师验收 0/148、以及缺少真实课堂试点。演示回归使用合成数据和受控响应；上述警告不应被写成已完成或通过。前端包体和安全审计是本地构建快照，部署到目标 Linux/Render 环境后仍需复测；未经核对的旧 Office 文件不能继承本节数字。

## 软件著作权材料核对

申请人需确认软件名称/版本、完成日期、作者与权利归属，并对源代码、说明书和第三方声明保持一致。源码、图像、字体、样式组件、诗文数据、模型 API 与文档不是自动享有同一权利；逐项查 `LICENSE`、`THIRD_PARTY_NOTICES.md` 和来源台账，保存授权依据。生成提交包前运行白名单打包器，排除 `.env`、密钥、数据库、日志和真实学生数据。`提交材料/` 的旧 Office 文件以及 `scripts/refresh-submission-artifacts.py` 仍保留历史数字，须根据当前证据重新编制，不能直接作为新版申报材料。申报中只写已实现且能复核的能力，不把演示样本、AI 自述、旧审计数字写成真实应用成效。具体受理格式和法律判断由申请人按当前主管机构要求核对。
