# 代码、架构与功能清单（2026-07-28）

> 历史阶段快照：本文件记录 2026-07-28 的基线，不覆盖 2026-08-04 的长期记忆治理、依赖修复、最新源码台账和 528 项测试结果；当前值以 `2026-08-01-source-inventory.*`、`2026-08-01-verification-matrix.md` 为准。

## 审查规模

| 项目 | 数量 |
|---|---:|
| 前端 TS/TSX/CSS 文件 | 332 |
| 前端代码与样式行数 | 159,882 |
| 后端 TS/SQL 文件 | 148 |
| 后端代码行数 | 70,001 |
| 前端 `<Route>` 元素 | 22 |
| 后端插件/路由注册调用 | 32 |
| 后端 HTTP 端点声明 | 206 |
| 后端单元测试 | 13 文件 / 425 项 |

行数包含样式和声明型类型文件，不等于有效业务逻辑量；数量大不代表质量高。

## 入口与主模块

### 前端

- 教学驾驶舱与诊断页签
- 诗脉星图
- 教案工坊
- 命题工坊
- 课堂导播
- 智能批改
- AI 副驾
- 进化之眼
- 思考宫殿
- 文化语境
- 教研报告
- 登录、隐私、403、404 等基础页面

### 后端

- 健康、驾驶舱、课堂、批改、命题、报告、诊断、教案
- 编排器、Agent、WebSocket/SSE、AI 副驾
- 朗读、创造、文化、鉴赏、诗内容、插画、统一 AI
- 知识图谱、学生、错题本、进化、设置
- SQLite 业务仓储与运行时存储；Neo4j 可选降级

## 架构图证据

Graphify 在删除死代码后重新提取：

- 前端：242 个语料文件、2,539 节点、5,711 边、129 社区。
- 后端：149 个语料文件、2,274 节点、5,655 边、110 社区。
- 前后端均未检测到 import cycle。
- 前端高连接点：`Icon`、`cn`、`api`、`Button`、`toast`。
- 后端高连接点：`AgentContext`、`BloomLevel`、`WSBroadcaster`、`ChatMessage`、`classroomRoutes`。

报告：

- `frontend/src/graphify-out/GRAPH_REPORT.md`
- `backend/src/graphify-out/GRAPH_REPORT.md`

## 死代码治理

Knip 初次检测到：

- 前端入口不可达文件 41 个。
- 后端入口不可达文件 11 个。

已删除旧 E2E、旧星图渲染器、未挂载 UI 组件、旧手工 smoke、未使用的 LLM mock/degradation 模块等共 52 个文件。删除后：

- 前端 `knip --include files`：0 个未使用文件。
- 后端 `knip --include files`：0 个未使用文件。
- 前端生产构建、链接审计、30 组 E2E 通过。
- 后端 TypeScript 构建、425 项单测通过。

Knip 的“unused export/type”不等于死文件；大量公共类型和 barrel export 仍需后续按域拆分，未做机械删除以避免破坏 API。

## 主要维护性风险

| 文件 | 行数 | 风险 |
|---|---:|---|
| `frontend/src/lib/types.ts` | 6,072 | 领域类型全集中，修改影响面难界定 |
| `frontend/src/lib/api.ts` | 4,450 | API 契约、SSE、fallback 混在单文件 |
| `backend/src/routes/classroom.ts` | 3,697 | 课堂状态机、持久化、AI、WS 与多模式高度耦合 |
| `backend/src/routes/report.ts` | 2,649 | 生成、验证、导出、历史聚合集中 |
| `backend/src/routes/diagnosis.ts` | 2,235 | 算法、查询和 HTTP 适配耦合 |
| `frontend/src/pages/ReportPage/ReportCharts.tsx` | 1,752 | 多图表实现集中，视觉回归成本高 |

这些文件能编译、能运行，但“巨型模块”会提高回归风险。全国最高奖后的可持续性展示，建议按领域拆分并维持稳定契约测试。

## 未覆盖边界

- 本轮没有人工逐字符证明 230,000 行均无语义缺陷；采用的是 TypeScript strict、依赖图、死代码分析、模式扫描、单测、集成闭环和逐路由 E2E 交叉审查。
- 206 个 HTTP 端点没有逐个执行所有合法/非法分支。
- 外部 DeepSeek/MiMo/Wan、摄像头、麦克风、真实 OCR、Neo4j 实例和高并发班级未做完整在线实测。
