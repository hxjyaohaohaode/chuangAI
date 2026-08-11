# 后端未被静态 API 扫描直接命中的端点分类

生成日期：2026-08-01

## 结论

`scripts/audit-api-contracts.mjs` 对 `frontend/src/**/*.{ts,tsx}` 与 Fastify 路由进行结构化比对，当前结果为：前端调用 210、后端端点 219、匹配 210、缺失路径 0、方法错配 0、未被普通 HTTP 调用表达式直接命中 17。

这 17 项已全部逐项归属：5 项为浏览器媒体、WebSocket 或 SSE 的间接调用，1 项为回归自动化写操作，1 项为运维探针，10 项为高级控制、兼容协议或替代视图。未发现“来源不明且无人使用”的裸端点；也不能据此声称全部端点都已被真实用户流量验证。

## 逐项台账

| 端点 | 分类 | 真实调用或存在依据 | 决策与边界 |
|---|---|---|---|
| `POST /api/orchestrator/parse` | 高级控制 API | `backend/src/orchestrator/routes.ts` 明确把解析与执行分离，允许教师审查 plan 后再执行 | 保留；当前主界面直接走 execute，未来若开放计划审查 UI 再接入 |
| `GET /api/orchestrator/sessions` | 高级/管理 API | 同模块已有单会话查询，列表接口支持按 teacherId 筛选 | 保留；不把管理列表误计为主流程覆盖 |
| `GET /ws/orchestrator` | 间接活跃 | `frontend/src/lib/ws-dispatcher.ts` 固定路径并通过 `new WebSocket(url)` 建连；AI 副驾也声明订阅该通道 | 保留；HTTP 正则扫描天然无法识别 WebSocket 构造器 |
| `POST /api/classroom/sessions` | 兼容轻量协议 | `backend/src/routes/classroom.ts` 标注为简化版 `/start`，与 lessonId 流程共用 runtime | 保留兼容；主教师流继续使用 lessonId 会话流程 |
| `GET /api/classroom/sessions/:sessionId` | 兼容轻量协议 | 与上项配套的轻量会话状态接口 | 保留兼容；不能独立删除配套查询 |
| `POST /api/classroom/sessions/:sessionId/score` | 教师手工评分兼容入口 | 后端注释明确与已接入的 AI `smart-score` 互补：调用方直接给出 score | 保留；AI 判分失败时可作为人工兜底协议 |
| `POST /api/dashboard/alerts/trend/refresh` | 自动化活跃 | `backend/scripts/closed-loop-regression.mjs` 第 123 行显式调用并断言持久化结果 | 保留；这是显式写操作，不能被 GET 列表替代 |
| `POST /api/diagnosis/students/:studentId/learning-path` | SSE 间接活跃 | `frontend/src/lib/api.ts` 的 `streamAiLearningPath` 通过 `streamDiagnosisSSE` 动态发起 POST | 保留；审计器后续应增加 SSE helper 识别规则 |
| `POST /api/diagnosis/students/:studentId/prescription` | SSE 间接活跃 | `frontend/src/lib/api.ts` 的 `streamPrescription` 通过 `streamDiagnosisSSE` 动态发起 POST | 保留；与 GET 非流式版本是两种交互模式 |
| `GET /api/diagnosis/students/:studentId/radar` | 替代聚合视图 | 后端提供单学生雷达聚合；当前诊断页使用画像/Bloom 等更细粒度接口 | 保留为兼容视图；若发布前仍无消费者，应纳入 v6 废弃评审 |
| `GET /api/diagnosis/classes/:classId/radar` | 替代聚合视图 | 后端提供班级雷达聚合；当前驾驶舱使用其他班级诊断接口 | 同上，不把“可用”写成“主流程已使用” |
| `GET /api/evolution/ab-test` | 单 Agent 详情视图 | `backend/src/routes/evolution.ts` 明确区分单数详情与已接入的复数汇总 `/ab-tests` | 保留详情 API；当前 UI 只展示全体汇总 |
| `GET /api/grading/files/:fileId` | 浏览器媒体间接活跃 | 上传结果返回 `file.url`，`RecognitionResult.tsx` 直接作为 `<img src={file.url}>` | 保留；浏览器资源属性不属于 fetch 调用表达式 |
| `GET /api/health/db` | 运维探针 | `backend/src/routes/health.test.ts` 覆盖正常、未初始化、断连等状态；供就绪检查而非业务页面 | 保留；部署/赛场自检应直接调用 |
| `GET /api/illustration/scenes` | 服务发现/预取 API | 后端返回受控 `SCENES` 目录；当前 UI 按场景 ID 获取资源 | 保留但标记非主流程；若不做预取 UI，可在 v6 收敛 |
| `GET /api/lesson-plan/templates` | 生成骨架资源 | `backend/src/routes/lesson-plan-templates.ts` 明确说明单数端点是生成节奏骨架，复数端点才是教师浏览的成品模板库 | 两者字段完全不同，禁止误合并；当前主 UI 使用复数端点 |
| `GET /api/recitation/audio/*` | 静态媒体兼容 | `backend/src/routes/recitation.ts` 将受约束路径映射到 `backend/static/audio`，并含路径穿越校验 | 保留为生成音频静态资源兜底；主 API 另有按 recitationId 获取接口 |

## 风险与收敛规则

1. “匹配 200”只证明路径/方法契约，不证明请求字段、响应字段、权限、并发与故障恢复都正确；这些必须由单元、集成、浏览器和故障注入共同覆盖。
2. 高级/兼容接口增加维护面。比赛提交版本冻结后，若无演示、自动化或兼容需求，应以调用遥测和契约测试为依据做废弃，而不是凭静态扫描直接删除。
3. WebSocket、SSE、`img/audio src` 与脚本调用应在下一版审计器中作为独立来源纳入，使“未直接命中”从 17 降到只剩真实的管理/兼容接口。
4. 任何端点删除前必须同时验证：无前端引用、无脚本引用、无浏览器媒体 URL、无外部客户端约定、无回归测试依赖，并保留迁移说明。
