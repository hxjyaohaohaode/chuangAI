# 2026-08-01 指定参考资产采用矩阵

> 2026-08-10 更新：长期记忆治理、供应链修复与本地混合来源前端组件闭合状态已按最新代码和证据边界刷新。

## 判定原则

参考项目不是“功能越多越好”的素材库。只有同时满足以下条件的机制才进入系统：

1. 直接增强官方评分项中的真实问题解决、易用性、AI 赋能开发、创新性或完整性；
2. 与当前 React + Fastify + SQLite 架构兼容，能够在比赛现场离线/弱网条件下稳定运行；
3. 许可证可满足参赛开源、署名和未来分发要求；
4. 能用测试、事件记录或用户证据证明，不制造“代码存在但链路未接通”的假能力；
5. 新增复杂度、首屏体积、外部服务和运维成本小于其评分收益。

## 资产盘点与决策

| 参考资产 | 本地规模（文件） | 许可/边界 | 可借鉴机制 | 当前映射 | 决策 |
|---|---:|---|---|---|---|
| `创AI/优质前端部件组` | 45 | 根目录没有统一 LICENSE/NOTICE；文档可见 CodePen、Animate UI、GitHub 等混合来源，不能证明为单一 React Bits 快照或统一许可证 | 交互动效、文本与卡片反馈 | CardSwap、PixelTransition、StackGallery、GlowBorder、TextPressure、StreamText、VariableProximity、ScrollReveal、GradualBlur、ElectricBorder、FallingText、MasonryGrid、StarfieldBackground、MagicRings、Radar、MagicBento、PixelSnow、TextSwitch、SphereGallery 共十九项已改为独立实现；无生产调用的 PixelCard、ShapeBlur 两项已删除；共二十一项闭合，当前来源待闭合项为 0。SphereGallery 为原生 DOM/CSS `scroll-snap` + React Portal 模态预览，无 Three.js/WebGL/Canvas、RAF、定时器或随机运行时；最新生产 E2E 证据已将 LessonPlan、StarMapDome 两条业务专项及轻量资源边界记录为 `checked: true`，聚合结果为 32 个路由/视口组合、0 warnings、0 failures。StarMapDome 是项目专用消费层，不归入该本地参考目录的外部来源计数 | **停止代码复用并保持逐项证据治理**：当前已识别项全部通过独立重写或删除闭合；未来新增参考代码仍须逐件固化不可变上游/许可证/署名、取得书面授权，或独立重写/移除。仅保留产品需求和可验证的无障碍、降级、性能机制；当前回归聚合值只证明生成物中逐项声明的受控前端契约，不证明教学效果、内容真实性、真实后端可用性、未测浏览器行为或比赛结果 |
| `D:/项目文件/优质前端部件组` | 554 | 混合来源，必须逐组件核验 | 补充组件与展示样例 | 当前 UI 库已很大 | **按需采用**：只有明确解决任务问题时使用，禁止整包复制 |
| Activepieces（“后台自动化与工作流”） | 24,345 | 核心 MIT，EE 目录另有条款 | durable run、步骤状态、重试、人工审批、幂等执行 | 已补 SQLite 会话检查点与教师审批重试；精确节点续跑/副作用幂等仍需按工具逐项设计 | **部分采用机制，不嵌入平台**：已完成安全检查点，下一步只为真实写操作补幂等键 |
| CopilotKit（“从聊天框到智能应用”） | 18,961 | MIT | shared state、generative UI、前端 action、human-in-the-loop | 已实现问答/任务双模式与计划预览、修改、批准、暂停/恢复/中止，浏览器回归验证完整 HITL 链路 | **已采用交互范式**：不新增 SDK 依赖，保持现有 React/Fastify 架构与教师最终控制权 |
| LangChain | 3,019 | MIT；本地为 Python 主仓 | 模型/工具抽象、结构化输出 | 已有自研 Router、Agent 与严格 JSON | **不直接引入**：避免跨语言重复抽象；仅对照契约和评测思路 |
| Langfuse | 4,600 | 核心 MIT，EE 目录另有条款 | trace/span、prompt version、token/cost、evaluation | 已实现按会话的本地 SQLite 脱敏证据链、教师归属校验和证据面板，覆盖批准、Agent/LLM、版本、费用、重试/降级/错误与验收 | **已采用最小可观测模型**：不保存提示词、模型原文或学生身份，不自托管完整 Langfuse |
| LangGraph | 668 | MIT；本地为 Python 主仓 | checkpoint、durable execution、interrupt、memory | TypeScript DAG 已接入 SQLite checkpoint；重启时失败关闭并由教师确认重试，不冒充精确节点续跑 | **已采用检查点/中断语义**：不增加 Python 服务；副作用任务未具备幂等键前禁止自动续跑 |
| Postiz | 924 | AGPL-3.0 | 调度日历、队列与发布状态 | 与古诗教学主任务弱相关 | **排除代码复用**：许可和领域均不匹配；最多研究通用日历交互 |
| BettaFish | 288 | GPL-2.0 | 多视角并行研究、阶段性综合 | 曾有未接通 ForumHost 原型 | **移除派生代码**：2026-08-01 已删除未接通的四段式主持人链路；未来若需要须独立设计并测试 |
| Graphify | 644 | MIT | 多模态代码知识图谱、关系置信度 | 已生成 graphify-out；知识图谱采用三档置信度 | **继续用于审计**：保留方法归因，不把审计产物计为产品功能；本地约 9MB 前端图谱及后端图谱均从发布包强制排除 |
| Microsoft GraphRAG | 893 | MIT；官方提示索引成本高且非正式支持产品 | 实体/关系抽取、global/local search、社区摘要 | 当前教材语料规模有限，已有 Neo4j + 本地 seed | **延后完整集成**：先证明现有知识图谱检索质量；语料显著扩张后再做离线索引实验 |
| GenericAgent | 214 | MIT | 技能沉淀、自我改进、极简 agent loop | 已有 evolution engine 与 prompt version | **受控采用**：只沉淀教学策略与 Prompt 模式；禁止无审核系统级自修改，所有激活须教师批准和可回滚 |
| Mem0 | 1,681 | Apache-2.0 | 多级记忆、增删改查、多信号检索、遗忘 | 已有 TypeScript 适配实现；SQLite 持久化、TTL、owner/班级隔离、删除权、容量上限、不可信上下文预算和教师治理 UI 已落地并通过 616 项关键后端测试与生产 E2E | **受控采用**：继续用匿名评测样本验证召回质量；不复制 Python 运行时，不开放 agent/session 内部记忆给教师端 |

## 面向奖项的优先采用顺序

1. **可证明闭环**：LangGraph/Activepieces 的 checkpoint、幂等、失败续跑，直接提高现场演示和完整性。
2. **AI 从建议到行动**：CopilotKit 的 shared-state/HITL 思路，使每次 AI 输出都有“预览—修改—批准—执行—撤销”链路。
3. **可观测与可验真**：Langfuse 的 trace/span/evaluation 模型，为每个 Agent、Prompt、模型、耗时、成本、失败与降级提供证据。
4. **记忆与隐私并重**：Mem0 的多级记忆必须与保留期、删除、教师可见性、学生隔离共同落地。
5. **知识质量而非图谱规模**：Graphify/GraphRAG 只用于提高来源追溯、置信度和检索评测，不以节点数量包装创新。
6. **视觉服务于任务且来源可证**：来源已闭合或独立实现的视觉组件才可保留；本轮待闭合项已归零，但任何未来新增的未闭合组件只能作为待替换风险项管理，并必须提供 reduced-motion 与静态兜底。

## 明确不采用

- 不引入第二套 Python Agent 运行时与现有 TypeScript Orchestrator 并存；这会扩大部署和现场故障面。
- 不直接复制 GPL/AGPL 项目代码到当前 MIT 主体。
- 不部署完整 Activepieces、Langfuse 或 GraphRAG 服务只为“技术栈看起来高级”。
- 不把未接通的事件、空 store、仅类型声明或静态演示数据计为完成的产品能力。
- 不伪造真实用户、学校、课堂、提效比例、获奖概率或外部模型效果。
