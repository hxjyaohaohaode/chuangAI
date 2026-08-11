# National Award System Audit and Regression Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 以“创AI案例评价标准”为验收基线，完成诗脉·启明前后端、12 个界面、关键教学闭环、安装复现能力与安全性的证据化审查、修复和完整回归。

**Architecture:** 前端为 React 18 + Vite + TypeScript 单页应用，后端为 Fastify + TypeScript，SQLite 为主业务存储，Neo4j 可选降级，多智能体与大模型能力支持无密钥演示模式。验证采用“官方要求追踪矩阵 → 静态分析 → 自动化测试 → 实际启动 → 浏览器逐页遍历 → 关键业务闭环 → 修复 → 全量回归”的分层策略；任何未实测能力不得标记为通过。

**Tech Stack:** React 18、React Router、Zustand、D3、Three.js、Vite 5、TypeScript 5.6、Fastify 5、Vitest、Playwright、SQLite、Neo4j（可选）、Docker Compose。

## 2026-07-28 执行状态

- Task 1：完成。官方评分与硬格式追踪矩阵已生成。
- Task 2：完成本轮静态范围。Graphify 重建、Knip 入口不可达文件归零；巨型模块风险已记录。
- Task 3：完成。lint/build/425 tests 通过；coverage 未达 80%，保持失败；依赖风险已分类。
- Task 4：部分完成。1440×900 与 390×844 共 30 组合通过；1280×720、完整键盘与所有弹窗/编辑态未穷举。
- Task 5：部分完成。登录与课堂—作答—报告主闭环已自动化；真实 OCR/ASR/TTS/生图/Neo4j/并发仍缺外部环境。
- Task 6：完成本轮可证实缺陷修复；未以降低测试门槛掩盖覆盖率。
- Task 7：完成阶段报告，但最终交付门槛未满足，不能标记“全国最高奖就绪”。

---

### Task 1: 建立官方要求与证据基线

**Files:**
- Read: `../../../官方文件/创AI案例征集指南.md`
- Read: `../../../官方文件/附件3：创AI案例征集指南(1).docx`
- Read: `../../../官方文件/模板材料/演示视频PPT模板.pptx`
- Create: `docs/audit/2026-07-28-requirements-traceability.md`

**Step 1: 提取硬性资格条件**

记录国产大模型、原创真实性、隐私、AI 生成标记、提交格式、视频参数、报告字数和配套资源复现要求。

**Step 2: 建立评分追踪矩阵**

将 100 分标准拆为可验证证据：导向性 20、实用性 40、影响力 20、创新性 10、完整性 10。

**Step 3: 标注证据状态**

每项只允许使用 `PASS-实测`、`PARTIAL-部分证据`、`FAIL-不满足`、`BLOCKED-缺外部证据` 四类状态。

**Step 4: 校验**

逐条回查官方指南原文，确保矩阵无漏项、无自行拔高。

### Task 2: 建立代码与架构清单

**Files:**
- Read: `frontend/src/**/*.{ts,tsx,css}`
- Read: `backend/src/**/*.ts`
- Read: `frontend/src/App.tsx`
- Read: `backend/src/server.ts`
- Create: `docs/audit/2026-07-28-code-and-feature-inventory.md`

**Step 1: 排除非人工源代码**

排除 `node_modules`、`dist`、缓存、数据库 WAL、日志、source map、截图和自动生成文件。

**Step 2: 映射界面和路由**

将 12 个公开模块、登录、404、共享布局、弹窗和导航动作映射到组件、API、Store 与后端路由。

**Step 3: 映射关键闭环**

至少覆盖登录、命题生成、课堂下发、作答数据、诊断、靶向练习、批改审核、教研报告和通知反馈。

**Step 4: 扫描死代码和断链**

结合 TypeScript、导入图、路由表、按钮链接和 API 使用关系，区分真正未引用代码与动态加载入口。

**Step 5: 校验**

交叉核对 README 功能矩阵、实际路由和后端注册，不允许以文档声明代替代码证据。

### Task 3: 执行无修改基线验证

**Files:**
- Read: `frontend/package.json`
- Read: `frontend/e2e-verify.mjs`
- Read: `backend/package.json`
- Read: `backend/vitest.config.ts`
- Read: `docker-compose.yml`

**Step 1: 前端类型检查**

Run: `pnpm lint`

Expected: 退出码 0，TypeScript 0 错误。

**Step 2: 前端生产构建**

Run: `pnpm build`

Expected: 退出码 0；记录构建时间、chunk 大小和警告。

**Step 3: 后端类型检查与构建**

Run: `npm run lint`，随后 `npm run build`

Expected: 两项均退出码 0。

**Step 4: 后端单元测试与覆盖率**

Run: `npm test`，随后 `npm run test:coverage`

Expected: 全部测试通过；记录实际覆盖率，不用测试数量替代覆盖率。

**Step 5: 依赖安全检查**

Run: 前后端锁文件对应的 audit 命令。

Expected: 记录每个漏洞的严重度、可利用路径和是否影响运行时。

### Task 4: 实际启动与逐界面冒烟

**Files:**
- Read: `frontend/e2e-verify.mjs`
- Modify: `frontend/e2e-verify.mjs`（仅当发现覆盖缺口）
- Create: `frontend/e2e-regression.mjs`（仅当现有脚本无法覆盖关键闭环）
- Create: `docs/audit/2026-07-28-ui-smoke-results.md`

**Step 1: 以无密钥演示模式启动后端**

验证健康检查、启动日志、数据库迁移、可选 Neo4j 降级和静态资源行为。

**Step 2: 启动前端**

验证登录页加载、无控制台异常、无失败资源、无未处理 Promise 拒绝。

**Step 3: 逐路由巡检**

在 1440×900、1280×720、390×844 三种视口检查 12 个模块、登录和 404；记录截图、控制台错误、网络失败、横向溢出、可访问性和交互状态。

**Step 4: 逐功能交互**

点击主要按钮、筛选、搜索、分页、弹窗、表单、导出、返回、通知、路由跳转和错误恢复；验证操作有反馈且不会静默失败。

**Step 5: 校验**

对每个页面给出功能实现度、合理性、易用性、稳定性和实际需求匹配度，不以“页面能打开”判定通过。

### Task 5: 运行关键教学闭环回归

**Files:**
- Read: `frontend/src/lib/api.ts`
- Read: `frontend/src/stores/**/*.ts`
- Read: `backend/src/routes/**/*.ts`
- Read: `backend/src/services/**/*.ts`
- Read: `backend/src/orchestrator/**/*.ts`
- Create: `docs/audit/2026-07-28-closed-loop-regression.md`

**Step 1: 登录与会话闭环**

登录 → 进入驾驶舱 → 刷新恢复 → 退出 → 受保护路由回登录。

**Step 2: 命题教学闭环**

选诗与六阶权重 → 生成题目 → 验收/降级 → 下发课堂 → 结果回传。

**Step 3: 诊断干预闭环**

作答记录 → 六阶诊断 → 暗物质识别 → 学习路径/靶向练习 → 再测反馈。

**Step 4: 批改审核闭环**

上传/模拟答题 → OCR/归因 → 教师审核 → 状态持久化 → 报告可见。

**Step 5: 教研报告闭环**

聚合班级数据 → 生成报告 → 建议可追溯到数据 → 导出/回看。

**Step 6: 失败路径**

覆盖网络断开、API 失败、超时、重复提交、空数据、非法输入、模型无密钥和刷新中断。

### Task 6: 修复缺陷并补齐测试

**Files:**
- Modify: 由缺陷定位结果决定的最小文件集合
- Test: 与每个修复同域的现有或新增测试文件

**Step 1: 为每个确定缺陷增加失败验证**

先使用单元测试、接口测试或可重复的浏览器步骤证明问题存在。

**Step 2: 实施最小充分修复**

避免无关重构；安全、数据一致性和闭环断裂问题优先于纯视觉问题。

**Step 3: 运行聚焦测试**

Expected: 新增验证由失败转为通过，且相邻模块无回归。

**Step 4: 更新用户文档**

只有安装、配置、使用或限制发生变化时，才同步修改 README/INSTALL/USAGE。

### Task 7: 全量回归与冲奖差距报告

**Files:**
- Create: `docs/audit/2026-07-28-final-audit-report.md`
- Update: `docs/audit/2026-07-28-requirements-traceability.md`

**Step 1: 重跑全部自动化验证**

重跑前后端 lint、build、后端测试/覆盖率、依赖审计、E2E、链接审计和新增回归脚本。

**Step 2: 重跑关键闭环**

以全新会话和干净演示数据再次执行五条闭环及失败路径。

**Step 3: 形成结论**

列出已修复缺陷、未修复风险、外部证据缺口、官方评分映射和建议优先级；禁止承诺“零漏洞”或“必进前 1%”。

**Step 4: 最终交付门槛**

仅当所有 P0/P1 缺陷关闭、关键闭环实测通过、无高危运行时漏洞、复现文档可执行时，才可判定“具备参评稳定性”；真实落地和反馈不足必须保持为外部阻塞项。
