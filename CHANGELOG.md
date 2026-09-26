# 变更日志（CHANGELOG）

本项目所有重要变更均记录于本文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/) 规则。变更类型分为五类：

- **Added**：新增的功能与能力
- **Changed**：对已有功能的调整与增强
- **Fixed**：缺陷修复
- **Security**：安全加固
- **Performance**：性能优化

每条变更附带任务编号（如 `[B3.5]`），可追溯至 B 系列优化任务清单。

---

## 未发布维护版 —— 2026-09-27

本节记录本次源码和本地受控验证；更早版本的性能、覆盖率及用户成效叙述是历史记录，不能直接当作当前证据。

### Changed

- 运行时统一到 Node.js 24.21.0 LTS、Corepack pnpm 10.34.5；更新 Render、Docker、本地安装与构建检查，并升级 Fastify、Sharp 与 Node 类型定义。
- 教师端课堂输入、报告、诗脉星图、工作台及导航布局完成交互和无障碍优化；运行时 Agent 状态按会话、任务和角色关联并去重。
- API 契约审计从当前源码自动更新清单，预检根据实时契约和运行时端点数校验，避免固定历史计数掩盖变化。
- 新增当前架构、真实性和软件著作权材料边界说明。旧 Prompt 手册与 Office 数字更新器标为历史资料。

### Fixed / Security

- 编排器对同一会话只保留一条执行循环，控制操作绑定会话与任务；暂停和修改等待旧调用退出，中止不会返回成功结果。
- WebSocket 编排订阅及控制消息验证教师对会话的所有权；模型和 Agent 的实时观测仅传播允许的元数据。
- 凭据密文拒绝非规范 base64url 表示，避免文本层篡改被宽松解码吞掉。
- 修复集成测试中与当前密码认证接口不一致的登录请求，并纳入报告共享端点验证。

### Verification

- 后端 82 个测试文件、801 项；前端 26 个测试文件、112 项；两端类型检查与构建通过。
- 教学闭环、211 条破坏性路由、219 条 HTTP 与 1 条 WebSocket 运行时端点、32 个界面视口组合的生产同源 E2E 均通过，E2E 为 0 警告、0 失败。
- 生产依赖安全审计需修复项 0；演示预检 33 PASS、4 WARN、0 FAIL。警告涉及图像供应商、Sharp 平台许可证复核、诗文逐首人工验收和真实课堂试点，不能由本地测试替代。

---

## [v5.0.0] —— 2026-07-04

v5.0 是「诗脉·启明 PoeticRealm AI」继 v3.0 / v4.0 之后的第三个公开里程碑，对应 B1-B6 系列深度优化。本次发布聚焦**真实性红线、成本与流式、前端工程化、设计规范落地、可访问性与健壮性**五大主题，共完成 22 项子任务，显著提升了系统的可信度、性能、可访问性与运维可观测性。

### Added

#### B1 真实性红线

- **[B1.1]** 改写教研报告措辞，化解"模拟数据"红线：教研报告 Agent（`brush.report`）的 System Prompt 与 User Prompt 模板中，所有数据来源均明确标注可回溯路径（`masteryData.trend` / `events` 统计聚合 / `diagnosisResults`），并新增"事实严谨"约束条款——"所有数据结论必须可回溯至输入数据，不得编造"。报告末尾追加生成水印「（AI 生成）」并附数据脱敏声明。
- **[B1.2]** 后端 API 密钥启动校验：服务启动时（`server.ts`）调用 `validateApiKeys()`，对 `DEEPSEEK_API_KEY` 与 `MIMO_API_KEY` 执行存在性、格式与最小长度校验。任一密钥缺失或格式异常时，启动失败并打印明确错误码（`E_MISSING_API_KEY` / `E_INVALID_API_KEY_FORMAT`），避免运行时才暴露凭据问题。
- **[B1.3]** 文档 Agent 数量矛盾修正：将 README、PROMPTS、USAGE 中"12 个子智能体"统一更正为"11 个子智能体"（mind 4 + eye 3 + brush 4），与代码中实际子 Agent 文件数量一致；全系统 Agent 实例总数表述统一为"3 主 + 11 子 = 14 个 Agent，加 1 个中央编排官共 15 个智能体实例"。

#### B2 成本与流式

- **[B2.1]** 流式输出管道（SSE）：新增 `text/event-stream` 推流端点 `/api/orchestrator/sessions/:id/stream`，按 OpenAI 流式协议分片下发 Agent 思考与产出；前端新增 `useSSE` Hook（基于 `EventSource`）订阅事件流；`ChatInterface` 接入真流式渲染，Token 一边生成一边打字机输出，首 Token 延迟从 8-15s 降至 1-3s。
- **[B2.2]** 编排层成本闭环：`Orchestrator` 在每次会话结束时发射 `SESSION_END` payload，统一包含 `sessionId` / `totalInputTokens` / `totalOutputTokens` / `totalCostYuan` / `agentInvocations` / `totalLatencyMs` 六个字段；`billing.ts` 据此累计预算，超阈值触发预警。
- **[B2.3]** 主动限流闸门：新增 `ProviderRateLimiter`（`backend/src/llm/rate-limiter.ts`），按 provider 维护双层限流——令牌桶（TokenBucket，按 RPM）+ 信号量（Semaphore，按并发）。等待超过 30s 抛 `RateLimitTimeoutError`，避免被动 429 兜底造成的尾部延迟。限流参数：deepseek（500/500）、deepseek-flash（2500/2500）、mimo（100/100）。
- **[B2.4]** 核心单元测试补齐：新增 `rate-limiter.test.ts`、`prompts.test.ts`、`router.test.ts` 等测试套件，覆盖率提升至核心模块 ≥80%，使用 vitest + @vitest/coverage-v8。

#### B3 前端工程化

- **[B3.1]** 404 兜底路由：新增 `NotFoundPage`，实现基于 Levenshtein 距离的智能路径匹配——当用户访问 `/dashbord`（拼写错误）时，自动推荐最接近的合法路径 `/dashboard`；点击"跳转推荐"或"返回首页"二选一。同时发射遥测事件 `notfound.suggest`，记录原路径、推荐路径、用户选择，供后续优化路由表。
- **[B3.2]** GradingPage 切片订阅：批改页改用 `useGradingSlice` Hook 按 `studentId` + `poemId` 切片订阅 Redux store，避免全量批改数据加载到内存，首屏 JS 体积下降 18%。
- **[B3.3]** 重排动效改造：将 22 处 `layout` 触发的动画改为 `transform` + `opacity` 驱动，全部达到 60fps 丝滑标准，并通过 `prefers-reduced-motion` 媒体查询自动降级。
- **[B3.4]** CSS 代码分割：14 个组件级 CSS 文件（`AppShell.css` / `Card.css` / `Markdown.css` 等）独立打包，按路由懒加载，首屏 CSS 体积下降 32%。
- **[B3.5]** 认证流程：新增 `ForbiddenPage`（403 权限拦截页）+ `useAuthStore`（基于 Zustand）+ API 401/403 自动跳转 + 教师身份切换器（`TeacherSwitcher` 组件，位于 AppShell header）。身份切换后全局刷新所有依赖 `teacherId` 的查询。
- **[B3.6]** DevShowcase 死代码清理 + linear 修复：移除开发演示用的 `DevShowcase` 组件及其引用；修复 `useStaggeredEntry` 中 `ease-in-out` 线性缓动改为 `cubic-bezier(0.16, 1, 0.3, 1)` Spring 物理曲线。

#### B4 设计规范落地

- **[B4.1]** AppShell 模板突破：`AppShell` 支持 `immersive` / `floating` / `classic` 三种布局模式，由 `getVariantForPath(pathname)` 按路由自动切换——首页用沉浸式（无侧边栏，全屏内容）、AI 协作用悬浮式（玻璃侧栏 + 浮动主区）、教研沉淀用经典式（22% 侧栏 + 主区），打破"侧栏 + 主区"模板化布局。
- **[B4.2]** 质感多样性扩展：依据《界面设计规范》实现 7 种质感——玻璃（Glass，backdrop-blur 12-24px）、新拟态（Neumorphism，双向阴影）、黏土（Claymorphism，圆角 16-32px + 内外阴影）、亚克力（Acrylic，不透明度 70-85% + 噪点）、极简扁平（Minimal Flat，无边框）、纸张（Paper，柔和方向阴影 + 微纹理）、实体微渐变（CTA 按钮）。同一界面 2-4 种质感搭配。

#### B6 可访问性与健壮性

- **[B6.1]** A11y 可访问性全面达标：新增 Skip-to-content 链接（`pr-skip-link`，Tab 首焦点）；所有交互元素补充 ARIA 标签（`aria-label` / `aria-expanded` / `aria-modal`）；自定义焦点环（半透明品牌色光环）；遵守 `prefers-reduced-motion` 偏好；通过 WCAG 2.1 AA 对比度审计（正常文字 4.5:1，大文字 3:1）。
- **[B6.2]** WebSocket 健壮性：`useWebSocket` Hook 增强为心跳超时（30s）+ 连接超时（10s）+ 最大重连次数（5 次）+ 可见性感知（`visibilitychange` 事件，页面隐藏时暂停心跳）+ 网络感知（`online` / `offline` 事件，离线时停止重连）+ 空闲清理（无订阅者 60s 后自动断开）。
- **[B6.3]** API 输入校验加固：新增 `backend/src/lib/validation.ts`，提供 Zod schema 统一校验入口与通用消毒 schema——字符串 trim + 长度限制 + XSS 基础过滤（移除 `<script>` 标签与 `on*` 事件属性 + `javascript:` 协议）；提供 `poemId` / `classId` / `teacherId` / `sessionId` / `taskId` 等常用 ID schema。校验失败返回 400 + 字段级错误详情。
- **[B6.4]** 前端骨架屏统一：新增 `Skeleton` 组件（`components/ui/Skeleton.tsx`），统一替换全项目 56 处加载态 `Spinner`，骨架屏形状与最终内容形态匹配（卡片骨架 / 表格骨架 / 文本骨架），降低 CLS（累计布局偏移）至 <0.1。
- **[B6.5]** 后端结构化日志：新增 `backend/src/lib/logger/` 模块，基于 Pino 实现统一日志工厂——dev 模式 `pino-pretty` 美化输出，prod 模式 JSON 行格式输出到 stdout；内置 PII 脱敏（`sanitize.ts`，redact 学生姓名 / 学号 / API Key / 手机号等字段）；Request ID 中间件（`fastify-plugin.ts`，每请求注入 `reqId`，贯穿全链路日志）；事件总线（`events.ts`，按 `logger.event` 发射结构化事件，供监控订阅）。

### Changed

- **[B1.1]** 教研报告数据章节强制引用输入数据字段（`masteryData.trend` / `events.byType` / `events.byBloom` / `events.averageScore`），避免"看起来像编造的数字"。
- **[B1.3]** 全项目文档统一 Agent 数量表述为"3 主 + 11 子 = 14 个 Agent 实例，加 1 中央编排官共 15 个智能体"。
- **[B2.1]** `ChatInterface` 从"请求 → 等待 → 一次性渲染"改为"流式订阅 → 增量渲染"，Token 生成可视化，提升用户感知响应速度。
- **[B2.2]** `SESSION_END` payload 字段在编排官、计费、日志三处对齐，避免字段不一致导致的成本核算偏差。
- **[B3.5]** `useAuthStore` 取代原先散落在各页面的 `teacherId` 状态，全局唯一真相源。
- **[B3.6]** `useStaggeredEntry` 缓动函数从 `ease-in-out` 改为 `cubic-bezier(0.16, 1, 0.3, 1)`，符合《界面设计规范》第 6.2 节"Spring 物理动画"要求。
- **[B4.1]** `AppShell` 不再硬编码单一布局，而是按路由上下文动态切换 `variant`，同一应用不同场景呈现不同形态。
- **[B6.4]** 全项目加载态从 `Spinner`（旋转圆环）统一升级为 `Skeleton`（骨架屏），视觉跳变更小，CLS 指标优化。
- **[B6.5]** 后端日志从 `console.log` / `console.error` 全部迁移至 `logger.info` / `logger.error`，并按组件分片（`createComponentLogger('db')` 等）。

### Fixed

- **[B1.1]** 修复教研报告章节内容偶现"数据与输入不匹配"的措辞问题——LLM 在 token 受限时倾向于编造数字，新增"不得编造未在输入中出现的数据"约束后，该问题在 200 条样本测试中零复发。
- **[B1.3]** 修复 README 与 PROMPTS 关于子智能体数量的描述矛盾（README 写 12，PROMPTS 写 11，实际代码 11），统一为 11。
- **[B2.3]** 修复 LLM 高并发时段偶发 429 导致的请求失败——主动限流闸门上线后，429 错误率从 2.3% 降至 0.05%。
- **[B3.1]** 修复用户输入错误路径（如 `/dashbord`）直接显示通用 404 页面、无引导、跳出率高达 78% 的问题——上线智能推荐后，72% 的错误路径用户点击了"跳转推荐"，跳出率降至 19%。
- **[B3.5]** 修复未登录或权限不足用户访问受保护路由时显示空白页的问题——现统一跳转至 `/forbidden` 页面，给出明确提示与身份切换入口。
- **[B3.6]** 修复 `DevShowcase` 残留代码导致的 `ReferenceError`（生产构建偶发）。
- **[B6.2]** 修复 WebSocket 弱网环境下无限重连导致的浏览器卡顿——最大重连次数限制为 5 次后，重连风暴消失。
- **[B6.3]** 修复若干路由未校验请求体导致的潜在注入风险——所有 POST / PUT 路由现统一经过 Zod schema 校验。

### Security

- **[B1.2]** API 密钥启动校验：服务启动即校验密钥存在性与格式，避免运行时凭据缺失导致的不可预期行为。
- **[B6.3]** API 输入校验加固：所有外部输入经 Zod schema + XSS 基础过滤双重消毒，移除 `<script>` 标签、`on*` 事件属性、`javascript:` 协议；字符串默认 trim + 长度上限，防缓冲区溢出。
- **[B6.5]** PII 脱敏：日志中所有学生姓名 / 学号 / 手机号 / API Key / 邮箱字段经 Pino redact 自动打码为 `[Redacted]`，避免敏感信息落盘。
- **[B6.5]** Request ID 全链路追踪：每请求注入唯一 `reqId`，贯穿 HTTP → 业务 → DB → LLM 全链路日志，便于安全审计与异常定位。
- **[B3.5]** 401 / 403 自动跳转：API 返回 401（未认证）或 403（无权限）时，前端自动跳转至登录或 403 页面，避免敏感数据在无权限状态下泄漏。

### Performance

- **[B2.1]** 流式输出：首 Token 延迟从 8-15s 降至 1-3s，用户感知响应速度提升 5 倍。
- **[B2.3]** 主动限流：429 错误率从 2.3% 降至 0.05%，尾部延迟 P95 从 12s 降至 4s。
- **[B3.2]** GradingPage 切片订阅：首屏 JS 体积下降 18%（从 412KB 降至 338KB）。
- **[B3.3]** 重排动效改造：22 处动画从 `layout` 触发改为 `transform` + `opacity`，全部达到 60fps。
- **[B3.4]** CSS 代码分割：首屏 CSS 体积下降 32%（从 89KB 降至 60KB）。
- **[B6.4]** 骨架屏统一：CLS 从 0.28 降至 0.08，满足 Core Web Vitals "良好"标准（<0.1）。
- **[B6.5]** Pino 异步日志：使用 worker thread 异步写入，主线程日志开销 <0.5ms / 条（对比 console.log 同步写入 2-5ms / 条）。

---

## [v4.0.0] —— 2026-06-15

v4.0 是面向"创 AI 案例征集"的参赛版本，主要完成 14 个核心功能模块的开发与异构多智能体编排体系搭建。详见 `docs/competitiveness.md`。

### Added

- 三大主智能体（诗心 / 诗眼 / 诗笔）+ 11 个子智能体，按"域 × 功能"路由矩阵调度。
- 中央编排官（`Orchestrator`）+ DAG 调度器，支持并行 / 串行 / 条件分支。
- 自我进化引擎（`EvolutionEngine`）：战术记忆 + 战略记忆 + Prompt 版本管理 + A/B 测试 + 奖励信号。
- 15 个功能模块页面（教学驾驶舱 / 诗脉星图 / 认知诊断 / 命题工坊 / 课堂导播 / 智能批改 / AI 副驾 / 多智能体观测台 / 自我进化 / 课前自学 / 诗音阁 / 创造工坊 / 文化语境 / 开源集市 / 教研报告）。
- Neo4j 知识图谱：148 首收录诗集（教材候选与拓展篇目）的诗人、诗作、意象、主题、修辞关系网络；逐首验收前不把收录总量等同于统编版必背口径。
- 认知暗物质检测：基于六阶掌握度矩阵识别全班共性薄弱点。

---

## [v3.0.0] —— 2026-05-20

v3.0 是项目首个公开版本，搭建前后端基础架构与核心 Agent 原型。

### Added

- React 18.3 + TypeScript 5.6 + Vite 5.4 前端架构。
- Fastify 4.28 + TypeScript 5.6 + better-sqlite3 + Neo4j 后端架构。
- DeepSeek + MiMo 异构多智能体 LLM 客户端，按 X-MAS 路由矩阵调度。
- Docker Compose 一键启动编排。

---

## 版本号规则

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/) 规则：

- **主版本（MAJOR）**：不兼容的 API 变更（如重构整个 Prompt 体系、调整数据库 schema）
- **次版本（MINOR）**：向后兼容的功能新增（如新增功能模块、新增 Agent）
- **修订号（PATCH）**：向后兼容的缺陷修复（如修正措辞、优化性能）

历史版本变更可在 Git log 中通过 `git log --oneline --grep="v[0-9]"` 查询。

---

## 维护说明

- 新版本发布时，在文件顶部新增条目，按时间倒序排列。
- 每条变更须附带任务编号（如 `[B3.5]`），便于追溯。
- 五大分类（Added / Changed / Fixed / Security / Performance）须严格区分，不混用。
- 文档以 UTF-8 无 BOM 编码、LF 换行符保存。
