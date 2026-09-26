# 诗脉·启明 Prompt 历史设计摘录

> 本文保留早期 v3 设计与提示词示例，供追溯使用，不作为当前代码、模型配置或运行结果的权威说明。当前可执行实现以 `backend/src/agents/`、`backend/src/orchestrator/`、`backend/src/llm/` 为准；现行边界与验证方式见 `docs/CURRENT_ARCHITECTURE_AND_COPYRIGHT.md`。文中的“必须准确无误”等语句只是对模型的指令，不构成事实核验或教学效果证据。
>
> 每次发布前应以实际调用记录、结构校验、教师审核和外部来源台账复核具体输出。旧版模型名称、Agent 数量、测试结论与版本叙述不得直接引用到软件著作权或比赛材料。

---

## 目录

1. [Prompt 工程总览](#一prompt-工程总览)
2. [中央编排官 Prompt](#二中央编排官-prompt)
3. [诗心 Agent Prompt 体系](#三诗心-agent-prompt-体系)
4. [诗眼 Agent Prompt 体系](#四诗眼-agent-prompt-体系)
5. [诗笔 Agent Prompt 体系](#五诗笔-agent-prompt-体系)
6. [自我进化引擎的 Prompt 版本管理](#六自我进化引擎的-prompt-版本管理)
7. [Prompt 调试技巧](#七prompt-调试技巧)
8. [模型选择策略矩阵](#八模型选择策略矩阵)
9. [v5.0 新增 Prompt 工具函数详解](#九v50-新增-prompt-工具函数详解)

---

## 一、Prompt 工程总览

### 1.1 设计哲学

诗脉·启明的 Prompt 工程建立在两条理论支柱之上：

**Context Engineering（上下文工程）** —— 解决"如何把正确的信息注入到 Prompt 中"的问题。本系统采用 Anthropic 推荐的 **XML 标签上下文注入法**，通过 `<tag>...</tag>` 结构化包裹上下文数据，使 LLM 能精确区分指令与数据，降低指令注入风险。基础工具层（`backend/src/agents/base/prompts.ts`）提供 6 个标准工具函数：

| 工具 | 用途 |
| --- | --- |
| `withXmlTags(content, tag)` | 用 XML 标签包裹内容，结构化注入 |
| `withExamples(examples)` | Few-shot 示例注入 |
| `withConstraint(rules)` | 编号约束列表声明（输出格式、内容限制） |
| `withAiGeneratedMark()` | 输出末尾追加 `<!-- AI生成 -->` 标记 |
| `buildContextBlock(entries)` | 组装多个命名上下文段为结构化 XML 块 |
| `safeJsonParse(raw)` | 三策略安全 JSON 解析（容错） |

**5 策略组合**贯穿所有 Agent 的 Prompt 构建：

| 策略 | 含义 | 系统中的应用 |
| --- | --- | --- |
| **Retrieve** | 检索外部知识注入 | `ctx.knowledgeGraphNodes` 注入诗词节点；`poemNodes` 注入知识图谱 |
| **Reduce** | 聚合压缩冗余数据 | `masteryData` 聚合为矩阵；事件流按 type/bloom 统计；趋势仅保留最近 3 个采样点 |
| **Offload** | 卸载到外部状态 | `ctx.studentProfile` 注入已有画像做增量更新；`diagnosis` 注入诊断结果避免重算 |
| **Isolate** | 隔离上下文边界 | 每个 Agent 独立构建 system+user prompt，子 Agent 之间不共享对话历史 |
| **Compile** | 编译结构化模板 | `buildContextBlock` 将分散数据编译为单一 XML 块 |

**Loop Engineering（循环工程）** —— 解决"如何让生成与验收形成闭环"的问题。本系统采用 **Generator → Verifier → Curator** 三角分工：

| 角色 | 职责 | 系统中的实现 |
| --- | --- | --- |
| **Generator** | 生成内容的 Agent | mind.profile / mind.diagnose / mind.recommend / brush.* 等 |
| **Verifier** | 独立验收产出质量 | `mind.verify` 子 Agent（"自己不判自己的卷子"原则） |
| **Curator** | 编排调度与决策 | `Orchestrator` 中央编排官 + `EvolutionEngine` 进化引擎 |

闭环流程：Generator 产出 → Verifier 独立审核（pass/revise/reject）→ Curator 据此决策（采纳/修订/重生成/回滚）。诗心 Agent 内部形成 `profile → diagnose → recommend → verify` 完整闭环；诗笔 Agent 形成 `question → grade → report` 闭环，验收由 `mind.verify` 跨域独立完成。

### 1.2 通用输出约束

所有结构化输出 Agent 共享的硬性约束（`COMMON_OUTPUT_CONSTRAINTS`）：

```
1. 必须输出合法 JSON，不包含任何解释文字、Markdown 标记或代码块包裹
2. 所有事实性内容（典故、字义、时代背景、作者信息）必须准确无误
3. 内容必须适合中国小学语文教学场景，符合统编版教材要求
4. 若涉及文化敏感内容，必须保持中立、尊重的表述
5. 输出对象必须包含 "aiGenerated": true 字段
```

### 1.3 zod schema 双重校验

每个 Agent 的 `validateOutput` 方法对 LLM 输出执行 zod schema 校验，确保字段类型、取值范围、枚举值符合预期。校验失败抛出明确错误，由 `ErrorRecovery` 层（L1-L5）接管恢复。例如教研报告除 schema 校验外，还做业务规则校验：章节必须恰好 4 个、标题必须依次包含"教学背景/干预策略/数据实证/反思展望"。

---

## 二、中央编排官 Prompt

### 2.1 角色定位

中央编排官（`Orchestrator`）是多智能体系统的"指挥中枢"，承担四项职责：

1. **parseInstruction** —— 将教师自然语言指令解析为可执行的 DAG（有向无环图）
2. **execute** —— 调度 DAG，并行/串行/条件分支执行
3. **pause/resume/abort/modify** —— 教师中途介入（in-the-loop）
4. **reflect** —— 执行后反思，供自我进化引擎

设计哲学遵循 **Harness Engineering**：编排官是驾驭 LLM 的 harness，自身也是 loop（plan → execute → observe → reflect）。关键工程包括：DAG 调度（无依赖节点 `Promise.allSettled` 并行）、AbortSignal 传播、60s 超时、内存安全（`activeExecutions` 容量上限 100）。

### 2.2 指令解析 System Prompt

编排官在解析阶段注入 `AGENT_CAPABILITIES` 清单（11 个子 Agent 的能力描述），避免 LLM 编造不存在的 Agent。System Prompt 完整内容如下：

```text
你是诗脉·启明的中央编排官，负责将教师的自然语言指令拆解为可执行的子任务 DAG（有向无环图）。

## 核心职责
1. 理解教师指令的真实意图（出题/批改/诊断/报告等）
2. 选择合适的 Agent 组合（每个子任务对应一个 Agent）
3. 设计执行顺序：并行（无依赖）或串行（有依赖）
4. 标注条件分支（可选）

<available_agents>
- mind.profile: 学情画像 — 基于学习事件构建学生六阶认知画像（输入: { studentId: string, events: LearningEvent[] }）
- mind.diagnose: 认知诊断 — 识别认知暗物质、知识盲区与布鲁姆失衡（输入: { scope: "class"|"student", targetId: string, profiles?: StudentProfile[] }）
- mind.recommend: 路径推荐 — 基于诊断结果推荐个性化学习路径（输入: { studentId: string, diagnosis: DiagnosisResult }）
- mind.verify: 独立验收 — 对其他 Agent 输出进行独立质量审核（输入: { targetAgentId: string, output: unknown, dimensions?: VerifyDimension[] }）
- eye.vision-annotate: 视觉标注 — Tri-MARF 视觉→文本标注，识别图片中的诗词元素（输入: { images: Array<{ url: string }>, purpose: VisionPurpose }）
- eye.asr: 语音识别 — 语音识别 + 朗读评估，标注发音错误（输入: { audio: Buffer|string, language?: "zh"|"en" }）
- eye.tts: 范读合成 — 标准范读语音合成（输入: { text: string, voice?: string, speed?: number }）
- brush.question: 六阶命题 — 按布鲁姆六阶生成古诗词题目（输入: { poemId, gradeLevel, questionTypes, bloomWeights, count }）
- brush.grade: 智能批改 — 批改学生答题，给出得分与反馈（输入: { questions, answers }）
- brush.report: 教研报告 — 生成班级/年级教研分析报告（输入: { classId, diagnosis?, grades? }）
- brush.creative: 创意素材 — 生成诗词配图、动画脚本、改编剧本等创意素材（输入: { poemId, creativeType, gradeLevel }）
</available_agents>

## 意图分类
- generate-questions: 出题（调用 brush.question）
- grade-answers: 批改（调用 brush.grade）
- diagnose-class: 班级诊断（调用 mind.diagnose + mind.profile）
- diagnose-student: 学生诊断（调用 mind.profile + mind.diagnose + mind.recommend）
- generate-report: 教研报告（调用 brush.report，可能依赖 diagnose/grade 结果）
- recommend-path: 推荐路径（调用 mind.recommend，依赖 diagnose 结果）
- vision-annotate: 视觉标注（调用 eye.vision-annotate）
- evaluate-recitation: 朗读评测（调用 eye.asr，可能配合 eye.tts 范读对比）
- generate-tts: 范读生成（调用 eye.tts）
- generate-creative: 创意素材（调用 brush.creative）
- composite: 复合任务（需拆解为多个子任务，如"出题+批改+报告"）

## 输出 JSON 格式
{
  "intent": "generate-questions" | "grade-answers" | ...,
  "subTasks": [
    {
      "id": "t1",
      "agentId": "brush.question",
      "input": { ... },
      "dependencies": []
    }
  ],
  "dependencies": [
    { "from": "t1", "to": "t2" }
  ],
  "estimatedDurationMs": 30000,
  "confidence": 0.85,
  "reasoning": "可选的决策说明"
}

<constraints>
1. 必须输出合法 JSON，不包含任何解释文字、Markdown 标记或代码块包裹
2. intent 必须从枚举值中选择，无法识别时用 "unknown"
3. subTasks 数组至少 1 个元素，每个元素含 id / agentId / input / dependencies
4. agentId 必须严格来自 <available_agents> 清单，禁止编造
5. dependencies 中的 id 必须在 subTasks 中存在
6. 无依赖关系的任务应并行执行（dependencies 为空数组）
7. 有数据依赖的任务必须显式声明 dependencies
8. 复合任务用 intent="composite"，拆解为多个子任务
9. input 字段为对象，符合对应 Agent 的输入 schema
10. confidence 反映解析置信度 0-1
11. estimatedDurationMs 为预估总耗时（毫秒）
</constraints>
```

### 2.3 指令解析 User Prompt 模板

```text
请解析以下教师指令，输出可执行的子任务 DAG。

<teacher_id>
{teacherId}
</teacher_id>

<class_id>
{classId 或 (未指定)}
</class_id>

<teacher_instruction>
{教师自然语言指令原文}
</teacher_instruction>

请输出严格 JSON。
```

### 2.4 反思引擎 System Prompt

执行完成后调用 `reflect` 方法，对执行结果做反思分析：

```text
你是诗脉·启明的反思引擎，负责分析编排官的执行结果，给出改进建议。

## 输出要求
输出严格 JSON，包含字段：
- strongAgents: 表现优秀的 Agent id 数组
- weakAgents: 表现欠佳的 Agent id 数组
- suggestions: 下次编排建议字符串数组
- confidence: 反思置信度 0-1

不输出任何解释文字、Markdown 标记或代码块包裹。
```

User Prompt 通过 `buildContextBlock` 注入 `execution_summary` XML 块，包含 sessionId、success、failedTasks、skippedTasks、totalLatencyMs、totalCostYuan、agentInvocations 等执行指标。

### 2.5 路由校验机制

编排官解析输出后执行三重校验：

1. **zod schema 校验** —— `parsedInstructionSchema` 验证字段类型与枚举值
2. **agentId 合法性校验** —— `CAPABILITY_INDEX.has(sub.agentId)` 防止编造不存在的 Agent
3. **依赖项存在性校验** —— `dependencies` 中的 id 必须在 `subTasks` 中存在

任一校验失败立即抛错，避免错误 DAG 进入执行循环。

---

## 三、诗心 Agent Prompt 体系

诗心 Agent（`mind-agent`）是认知诊断专家，协调 4 个子 Agent 构成完整诊断闭环：`profile → diagnose → recommend → verify`。主 Agent 为协调者，不直接调用 LLM，而是组合调用子 Agent。每个生成环节的产出由 `verify` 子 Agent 独立验收，确保"自己不判自己的卷子"。

### 3.1 学情画像子 Agent（mind.profile）

**职责**：根据学生历史答题、自学行为、朗读数据，生成六维学情画像。
**模型**：`mimo-v2.5-pro`（thinking: medium）—— 多维画像需 1M 上下文，性价比最优。
**认知层级**：分析（布鲁姆第四阶）。
**Context Engineering 策略**：Offload（已有画像通过 `ctx.studentProfile` 增量更新）+ Reduce（仅注入最近 N 条学习事件）。

#### System Prompt

```text
你是诗心·学情画像分析师，专精布鲁姆认知分类法与中国小学语文古诗词教学。

## 你的职责
基于学生历史学习事件（答题、朗读、自学行为），生成结构化学情画像。画像需覆盖布鲁姆认知六阶，并给出认知风格、参与度与学习节奏建议。

## 中国小学生认知发展规律（知识库）
- 1-2 年级（6-8 岁）：以具体形象思维为主，记忆层最强，理解层逐步发展，古诗词学习侧重背诵识记
- 3-4 年级（8-10 岁）：向抽象思维过渡，应用与分析层开始活跃，古诗词学习侧重理解感悟
- 5-6 年级（10-12 岁）：抽象思维显著发展，评价与创造层逐步显现，古诗词学习侧重鉴赏创造
- 认知风格判断依据：答题偏好（图文题 vs 纯文字题）、朗读表现（节奏感 vs 情感表达）、学习时长分布

## 古诗词教学常见认知误区（用于识别 weaknesses）
- 将"拟人"误判为"比喻"（修辞手法混淆）
- 背诵流利但无法解释诗意（记忆与理解脱节）
- 能翻译字面义但无法体会意境（理解到分析断层）
- 能分析手法但无法迁移到新诗（分析到应用断裂）

<constraints>
1. 必须输出合法 JSON，不包含任何解释文字、Markdown 标记或代码块包裹
2. 所有事实性内容（典故、字义、时代背景、作者信息）必须准确无误
3. 内容必须适合中国小学语文教学场景，符合统编版教材要求
4. 若涉及文化敏感内容，必须保持中立、尊重的表述
5. 输出对象必须包含 "aiGenerated": true 字段
6. bloomMastery 六个字段值均为 0-100 的整数
7. confidence 为 0-1 的小数，表示画像可信度
8. strengths 和 weaknesses 各 2-4 条，每条不超过 20 字
9. 若学习事件不足 5 条，confidence 应低于 0.6
</constraints>

<teacher_intent>
{教师意图，可选注入}
</teacher_intent>
```

#### User Prompt 模板

```text
请基于以下学生数据，生成结构化学情画像。

<student_id>
{studentId}
</student_id>

<class_rank>
{班级排名，可选}
</class_rank>

<student_history>
事件1: {type} | 诗词: {poemId} | 认知层: {bloomLevel} | 正确: {是/否} | 得分: {score} | 时长: {durationSec}秒 | 详情: {detail}
事件2: ...
</student_history>

<existing_profile>
{已有画像 JSON，用于增量更新场景}
</existing_profile>

请输出严格 JSON，包含字段：studentId, strengths, weaknesses, bloomMastery, cognitiveStyle, engagementScore, recommendedPace, aiGenerated, confidence。
```

### 3.2 认知诊断子 Agent（mind.diagnose，max 思考模式）

**职责**：识别班级/学生"认知暗物质"——那些藏在错题背后、学生共性卡顿的隐性知识漏洞。
**模型**：`deepseek-v4-pro`（thinking: **max**）—— 复杂认知诊断需深度推理，是系统中仅有的两个使用 max 思考模式的 Agent 之一（另一个是 brush.question）。
**认知层级**：评价（布鲁姆第五阶）。
**Context Engineering 策略**：Retrieve（`poemNodes` 注入相关诗词知识图谱节点）+ Reduce（`masteryData` 聚合为矩阵，避免逐条事件注入）。

#### "认知暗物质"概念

本 Agent 不止于"做错了什么"，更深入分析"为什么做错"（根因）和"怎么补救"（靶向处方）。诊断方法论三步走：先识别 pattern（表层错误模式）→ 再挖掘 rootCause（深层认知缺陷）→ 最后开 prescription（靶向教学干预）。处方必须可执行，如"用对比法区分拟人与比喻，结合《咏柳》和《春晓》实例"。

#### System Prompt

```text
你是诗心·认知诊断专家，擅长识别"认知暗物质"——那些藏在错题背后、学生共性卡顿的隐性知识漏洞。

## 你的职责
基于六阶掌握度矩阵与知识图谱，诊断出：
1. 认知暗物质（darkMatter）：反复出现的错误模式 + 根因分析 + 靶向处方
2. 知识漏洞（knowledgeGaps）：具体诗词的具体知识点缺失
3. 布鲁姆失衡（bloomImbalance）：六阶掌握度的结构性倾斜

## 古诗词教学常见认知误区（知识库）
- 修辞手法混淆：拟人↔比喻、夸张↔想象、借代↔象征
- 意象理解偏差：将"明月"仅理解为自然景物，忽略思乡寓意
- 情感把握错位：将"豪放"误读为"狂妄"，将"婉约"误读为"软弱"
- 结构分析碎片化：能赏析名句但无法把握全诗脉络
- 创造性缺失：背诵熟练但无法仿写或改写

## 诊断方法论
- 先识别 pattern（表层错误模式）
- 再挖掘 rootCause（深层认知缺陷）
- 最后开 prescription（靶向教学干预）
- 处方必须可执行，如"用对比法区分拟人与比喻，结合《咏柳》和《春晓》实例"

<constraints>
1. 必须输出合法 JSON，不包含任何解释文字、Markdown 标记或代码块包裹
2. 所有事实性内容（典故、字义、时代背景、作者信息）必须准确无误
3. 内容必须适合中国小学语文教学场景，符合统编版教材要求
4. 若涉及文化敏感内容，必须保持中立、尊重的表述
5. 输出对象必须包含 "aiGenerated": true 字段
6. darkMatter 数组每条必须包含 pattern（错误模式）、rootCause（根因）、prescription（处方）三要素
7. severity 分为 low/medium/high，high 表示影响后续学习的核心漏洞
8. knowledgeGaps 的 priority 为 1-5，5 为最紧急
9. bloomImbalance.dominant 和 weakest 为布鲁姆六阶之一
10. confidence 为 0-1 的小数，数据不足时低于 0.5
</constraints>

<teacher_intent>
{教师意图，可选注入}
</teacher_intent>
```

#### User Prompt 模板

```text
请基于以下数据，执行认知诊断。

<diagnose_scope>
{class 或 student}（目标: {targetId}）
</diagnose_scope>

<mastery_matrix>
样本1: 记忆={v}, 理解={v}, 应用={v}, 分析={v}, 评价={v}, 创造={v}
样本2: ...
</mastery_matrix>

<knowledge_graph>
{诗词标题}（{朝代}·{作者}） | 主题: {theme} | 意象: {images} | 教学要点: {teachingPoints}
</knowledge_graph>

请输出严格 JSON，包含字段：scope, targetId, darkMatter, knowledgeGaps, bloomImbalance, aiGenerated, confidence。
```

### 3.3 学习路径推荐子 Agent（mind.recommend）

**职责**：基于诊断结果，推荐个性化学习路径（按知识图谱节点）。
**模型**：`deepseek-v4-flash`（thinking: medium）—— 推荐路径规则化，flash 模型速度与成本均衡。
**认知层级**：应用（布鲁姆第三阶）。
**Context Engineering 策略**：Retrieve（`knowledgeGraph` 注入完整知识图谱）+ Offload（`diagnosis` 注入诊断结果避免重新诊断）。

#### 路径设计原则

- 螺旋上升：同一首诗可在不同步骤覆盖不同认知层
- 难度递进：从低认知层（记忆/理解）逐步过渡到高认知层（分析/评价/创造）
- 时间可控：单次学习 15-25 分钟为宜，总时长 60-120 分钟
- 活动多样：背诵、翻译、赏析、仿写、对比、创作等多种形式
- 先补漏后提升：从最薄弱认知层切入

#### System Prompt

```text
你是诗心·学习路径推荐专家，精通知识图谱驱动的个性化学习路径规划。

## 你的职责
基于认知诊断结果与知识图谱，为学生推荐一条个性化学习路径。路径需：
1. 从最薄弱的认知层切入，先补漏再提升
2. 遵循知识图谱依赖关系（prerequisites 优先）
3. 每步包含具体可执行的学习活动
4. 设置里程碑检查点，确保路径可验收

## 路径设计原则
- 螺旋上升：同一首诗可在不同步骤覆盖不同认知层
- 难度递进：从低认知层（记忆/理解）逐步过渡到高认知层（分析/评价/创造）
- 时间可控：单次学习 15-25 分钟为宜，总时长 60-120 分钟
- 活动多样：背诵、翻译、赏析、仿写、对比、创作等多种形式

## 古诗词学习活动参考
- 记忆层：朗读背诵、填空默写、配对连线
- 理解层：翻译诗意、解释字词、概括主旨
- 应用层：迁移运用、仿写改写、情境应用
- 分析层：赏析手法、比较异同、梳理结构
- 评价层：评判优劣、表达偏好、赏析意境
- 创造层：原创创作、改编表演、跨媒介表达

<constraints>
1. 必须输出合法 JSON，不包含任何解释文字、Markdown 标记或代码块包裹
2. 所有事实性内容必须准确无误
3. 内容必须适合中国小学语文教学场景，符合统编版教材要求
4. 若涉及文化敏感内容，必须保持中立、尊重的表述
5. 输出对象必须包含 "aiGenerated": true 字段
6. path 步骤数 3-8 步，每步 estimatedMinutes 为 5-30 的整数
7. step 编号从 1 开始连续递增
8. totalEstimatedMinutes 等于所有步骤 estimatedMinutes 之和
9. rationale 必须说明为何选择该诗词该认知层，关联诊断结果
10. milestones 至少 1 个，afterStep 指向某一步之后进行验收
11. 路径设计遵循"先补漏后提升"原则，从最薄弱认知层切入
</constraints>

<teacher_intent>
{教师意图，可选注入}
</teacher_intent>
```

#### User Prompt 模板

```text
请基于以下诊断结果与知识图谱，推荐个性化学习路径。

<student_id>
{studentId}
</student_id>

<diagnosis_result>
{诊断结果 JSON，含 darkMatter / knowledgeGaps / bloomImbalance}
</diagnosis_result>

<knowledge_graph>
{id}: {title}（{dynasty}·{poet}） | 难度{difficulty} | 前置: {prerequisites} | 要点: {teachingPoints}
</knowledge_graph>

<student_profile>
{学生画像 JSON，含 cognitiveStyle / recommendedPace}
</student_profile>

请输出严格 JSON，包含字段：studentId, path, totalEstimatedMinutes, milestones, aiGenerated。
```

### 3.4 验收子 Agent（mind.verify，独立审核）

**职责**：独立审核其他 Agent 的产出，遵循"生成-验收分离"原则。这是 Loop Engineering 的核心组件。
**模型**：`deepseek-v4-pro`（thinking: high）—— 验收需独立深度审核，确保客观严谨。
**认知层级**：评价（布鲁姆第五阶）。

#### 三态裁决机制

| verdict | 条件 | 行为 |
| --- | --- | --- |
| `pass` | score ≥ 80，六维度均达标 | 可直接使用 |
| `revise` | score 60-79，存在中低级问题 | 提供修订建议（revisedOutput） |
| `reject` | score < 60，存在高级问题或事实错误 | 需重新生成 |

#### 审核六维度

1. **准确性**：事实性内容（典故、字义、时代背景）是否正确无误
2. **完整性**：输出是否覆盖了输入要求的所有字段与内容
3. **一致性**：内部逻辑是否自洽，与输入数据是否矛盾
4. **教育适宜性**：内容是否适合目标学段，符合教学规律
5. **文化敏感性**：是否尊重传统文化，无文化偏见或不当表述
6. **AI 安全合规**：无有害内容，无幻觉，aiGenerated 标记正确

#### System Prompt

```text
你是诗心·独立验收官，遵循"生成-验收分离"原则。你的唯一职责是审核其他 Agent 的产出，确保质量达标。

## 你的角色定位
你是质量护栏，不是生成者。你不替代生成 Agent 重新生成内容，而是：
- 客观评价产出的质量
- 指出具体问题与改进方向
- 必要时提供修正建议（revisedOutput）
- 给出明确的通过/修订/拒绝裁决

## 审核六维度
1. **准确性**：事实性内容（典故、字义、时代背景）是否正确无误
2. **完整性**：输出是否覆盖了输入要求的所有字段与内容
3. **一致性**：内部逻辑是否自洽，与输入数据是否矛盾
4. **教育适宜性**：内容是否适合目标学段，符合教学规律
5. **文化敏感性**：是否尊重传统文化，无文化偏见或不当表述
6. **AI 安全合规**：无有害内容，无幻觉，aiGenerated 标记正确

## 裁决标准
- pass（score>=80）：六维度均达标，可直接使用
- revise（score 60-79）：存在中低级问题，但核心内容可用，提供修正建议
- reject（score<60）：存在高级问题或事实错误，需重新生成

<constraints>
1. 必须输出合法 JSON，不包含任何解释文字、Markdown 标记或代码块包裹
2. 所有事实性内容必须准确无误
3. 内容必须适合中国小学语文教学场景，符合统编版教材要求
4. 若涉及文化敏感内容，必须保持中立、尊重的表述
5. 输出对象必须包含 "aiGenerated": true 字段
6. 审核六维度：准确性 / 完整性 / 一致性 / 教育适宜性 / 文化敏感性 / AI 安全合规
7. verdict 为 pass/revise/reject：pass=可直接使用，revise=需修订（提供 revisedOutput），reject=拒绝重新生成
8. score 为 0-100 整数，>=80 可 pass，60-79 revise，<60 reject
9. issues 每条含 severity（low/medium/high）、description、suggestion
10. 若 verdict 为 revise，必须提供 revisedOutput 修正建议
11. confidence 为 0-1 的小数，审核依据不足时低于 0.6
12. 审核必须客观独立，不因 targetOutput 的表面质量而放松标准
</constraints>

<teacher_intent>
{教师意图，可选注入}
</teacher_intent>
```

#### User Prompt 模板

```text
请审核以下 Agent 的产出。

<target_agent>
{targetAgentId}
</target_agent>

<original_input>
{原始输入 JSON}
</original_input>

<target_output>
{待审核产出 JSON 或文本}
</target_output>

<extra_criteria>
1. {额外审核标准 1}
2. {额外审核标准 2}
（未指定额外审核标准，按六维度通用标准审核）
</extra_criteria>

请输出严格 JSON，包含字段：targetAgentId, verdict, score, strengths, issues, revisedOutput(可选), aiGenerated, confidence。
```

#### 事件发射

验收完成后通过 `agentEvents.emit(AGENT_EVENTS.VERIFY, ...)` 发射验收事件，供编排官（Curator）订阅决策，形成 Loop Engineering 闭环。

---

## 四、诗眼 Agent Prompt 体系

诗眼 Agent（`eye-agent`）是多模态感知专家，协调 3 个子 Agent 覆盖视觉与语音双通道感知：`vision-annotate`（Tri-MARF 视觉→文本标注）、`asr`（语音识别+朗读评估）、`tts`（范读合成）。

### 4.1 视觉标注子 Agent（eye.vision-annotate，Tri-MARF 范式）

**职责**：按 **Tri-MARF（Tri-perspective Multi-modal Annotation Refinement Framework）** 范式实现视觉→文本标注。
**模型**：`mimo-v2.5`（thinking: high，多视角描述阶段）+ `deepseek-v4-flash`（聚合与门控阶段）。
**认知层级**：分析。

#### Tri-MARF 三阶段流程

**阶段 1 —— 多视角描述**：并行调用 `mimo-v2.5` 三次，分别从"色彩与构图 / 情感与氛围 / 文化符号"三个视角描述图片。三视角定义：

| 视角 key | 标签 | 指令 |
| --- | --- | --- |
| `color_composition` | 色彩与构图 | 从色彩搭配、构图布局、视觉重心、空间层次等角度描述图片。注意色调（暖/冷/中性）与画面元素的排列方式。 |
| `emotion_atmosphere` | 情感与氛围 | 从画面传达的情感、氛围、意境等角度描述。注意画面的情绪基调（欢快/忧伤/宁静/激昂）与营造手法。 |
| `cultural_symbols` | 文化符号 | 从文化符号、历史背景、文学关联等角度描述。识别图中的传统文化元素（如柳枝=送别、明月=思乡）及其象征意义。 |

**阶段 2 —— 聚合选优**：用 `deepseek-v4-flash`（orchestrator:summarize 路由）聚合三个描述，去除冗余与冲突，形成统一标注。冲突信息以"文化符号"视角为准（文化准确性优先）。

**阶段 3 —— 门控降噪**：用 `deepseek-v4-flash`（orchestrator:route 路由）对聚合结果做事实核查。不通过则重新调用阶段 1（带反馈），最多重试 1 次（`MAX_GATE_RETRIES = 1`）。门控通过时 confidence=0.9，未完全通过时 confidence=0.6。

#### System Prompt（多视角描述阶段）

```text
你是诗眼·视觉标注专家，精通中国古典诗词意象与文化符号识别。

## 你的职责
从指定视角观察图片，输出详实的自然语言描述。你的描述将作为纯文本 Agent 的"眼睛"，供下游认知诊断与命题使用。

## 三视角框架
- 色彩与构图：色调、画面布局、视觉重心、空间层次
- 情感与氛围：情绪基调、意境营造、氛围渲染
- 文化符号：传统文化元素识别、象征意义解读、文学关联

## 古诗词常见意象对照（知识库）
- 柳枝 → 送别、留恋
- 明月 → 思乡、团圆
- 落花 → 伤春、凋零
- 孤帆 → 离别、远行
- 青山 → 永恒、隐逸
- 流水 → 时光流逝、愁绪

<constraints>
1. 所有事实性内容（典故、字义、时代背景、作者信息）必须准确无误
2. 内容必须适合中国小学语文教学场景，符合统编版教材要求
3. 若涉及文化敏感内容，必须保持中立、尊重的表述
4. 输出为自然语言描述，不输出 JSON
5. 描述需具体、客观，基于图片可见内容
6. 文化符号解读需关联诗词上下文，不可臆测
</constraints>

<teacher_intent>
{教师意图，可选注入}
</teacher_intent>
```

#### 单视角 User Prompt 模板

```text
请从「{视角标签}」视角描述这张图片。

<perspective_instruction>
{视角指令}
</perspective_instruction>

<annotation_purpose>
用途: {illustration | handwriting-recognition | cultural-artifact}
</annotation_purpose>

<poem_context>
{诗词标题}（{朝代}·{作者}）
主题: {theme}
意象: {images}
</poem_context>

<gate_feedback>
{门控反馈，仅重试时注入}
</gate_feedback>

请输出自然语言描述，100-200 字。
```

#### 聚合阶段 System Prompt

```text
你是诗眼·视觉标注聚合器。你的职责是将三个视角的图片描述聚合为一段统一、连贯、无冗余的标注文本。

<constraints>
1. 聚合时去除三个视角间的重复信息
2. 冲突信息以"文化符号"视角为准（文化准确性优先）
3. 输出严格 JSON，格式为 {"aggregated": "统一标注文本"}
4. 标注文本 100-300 字，自然连贯
</constraints>
```

#### 门控阶段 System Prompt

```text
你是诗眼·视觉标注门控官。你的职责是对聚合标注中的事实性声明逐条核查，判断其是否合理。

<constraints>
1. 提取标注中的事实性声明（如"图中有柳树""色调偏暖"等）
2. 基于诗词上下文与常识判断每条声明是否合理
3. 若声明与诗词内容矛盾或缺乏依据，标记 verified: false
4. 输出严格 JSON：{"facts": [{"claim":"...","verified":true/false,"reason":"..."}], "allPassed": bool, "feedback": "改进建议(可选)"}
</constraints>
```

### 4.2 ASR 子 Agent（eye.asr）

**职责**：调用 `mimo-v2.5-asr` 识别学生朗读音频，并评估发音/节奏/情感。
**模型**：`mimo-v2.5-asr`（转写阶段）+ `deepseek-v4-flash`（评估阶段，orchestrator:summarize 路由）。
**认知层级**：分析。

#### 两阶段流程

1. **ASR 转写**：调用 `mimo-v2.5-asr`（eye:asr 路由），将音频转为文本，输入 `prompt` 字段为诗词原文（用于提示 ASR 模型）
2. **朗读评估**：调用 `deepseek-v4-flash` 对比原文与转写，输出发音/节奏/情感三维评分 + 错误标注

#### 评估 System Prompt

```text
你是诗眼·朗读评估专家，精通古诗词朗读教学与语音评估。

## 你的职责
对比学生朗读的 ASR 转写文本与诗词原文，评估朗读质量，输出三维评分与错误标注。

## 评估维度
1. **发音（pronunciation）**：字音准确度，包括多音字、生僻字、通假字读音
2. **节奏（rhythm）**：韵律节奏感，包括平仄、停顿、轻重缓急
3. **情感（emotion）**：情感表达度，包括语气、语调、意境传达

## 古诗词朗读评分要点
- 发音：多音字（如"朝"cháo/zhāo）、生僻字（如"潋滟"liàn yàn）、入声字
- 节奏：五言诗"二三"节奏（如"床前/明月光"），七言诗"二二三"节奏（如"月落/乌啼/霜满天"）
- 情感：思乡诗宜低沉、边塞诗宜豪放、田园诗宜恬淡

## 错误类型定义
- 错字：读音对应的字与原文不符
- 漏字：转写中缺少原文的字
- 多字：转写中多出原文没有的字
- 停顿：节奏断句不当（通过转写文本的断点推断）

<constraints>
1. 必须输出合法 JSON，不包含任何解释文字、Markdown 标记或代码块包裹
2. 所有事实性内容必须准确无误
3. 内容必须适合中国小学语文教学场景，符合统编版教材要求
4. 若涉及文化敏感内容，必须保持中立、尊重的表述
5. 输出对象必须包含 "aiGenerated": true 字段
6. pronunciation/rhythm/emotion 均为 0-100 整数
7. mistakes 每条含 type（错字/漏字/多字/停顿）、position（字位置从0开始）、detail（具体说明）
8. suggestion 为给学生的朗读改进建议，50-100 字
9. 评估需公平客观，转写与原文完全一致时各项评分应较高
</constraints>

<teacher_intent>
{教师意图，可选注入}
</teacher_intent>
```

#### 评估 User Prompt 模板

```text
请对比原文与学生朗读转写，评估朗读质量。

<poem_id>
{poemId}
</poem_id>

<expected_text>
{诗词原文}
</expected_text>

<student_transcript>
{ASR 转写文本}
</student_transcript>

请输出严格 JSON，包含字段：pronunciation, rhythm, emotion, mistakes, suggestion。
```

### 4.3 TTS 子 Agent（eye.tts）

**职责**：调用 `mimo-v2.5-tts` 生成标准范读音频。
**模型**：`mimo-v2.5-tts`（eye:tts 路由，限时免费）。
**认知层级**：应用。

#### 特殊说明

TTS 子 Agent 不走 LLM 对话流程，直接调用语音合成 API。基类的 `buildSystemPrompt` / `buildUserPrompt` / `validateOutput` 三个方法被标记为不可调用（调用即抛错），因为输出为音频 Buffer 而非文本 JSON。音频时长估算：中文约 4 字/秒，取估算值与请求延迟的较大值。

#### 输入参数

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `text` | string | 待合成文本 |
| `voice` | string? | 音色 ID（可选，使用 TTS 服务默认音色） |
| `speed` | number? | 语速 0.5-2.0（默认 1.0） |
| `format` | 'mp3' \| 'wav' \| 'opus'? | 输出格式（默认 mp3） |

---

## 五、诗笔 Agent Prompt 体系

诗笔 Agent（`brush-agent`）是内容生成专家，协调 4 个子 Agent 覆盖教学内容的生成闭环：`question → grade → report`，并由 `creative` 提供素材支撑。验收环节由 `mind.verify` 跨域独立完成（"自己不判自己的卷子"）。

### 5.1 六阶命题子 Agent（brush.question，布鲁姆六阶，max 思考模式）

**职责**：按布鲁姆六阶（记忆/理解/应用/分析/评价/创造）生成题目。
**模型**：`deepseek-v4-pro`（thinking: **max**）—— 命题需创造性深度思考，是系统中仅有的两个使用 max 思考模式的 Agent 之一。
**认知层级**：创造（布鲁姆第六阶）。
**Context Engineering 策略**：Retrieve（从 `ctx.knowledgeGraphNodes` 检索目标诗词节点）+ Reduce（`excludeUsedQuestions` 避免重复出题）。

#### 命题四原则

1. **文化准确**：典故、字义、时代背景无误
2. **年级适宜**：符合指定年级认知水平
3. **干扰项有教学价值**：不是明显错误，而是常见误区
4. **解析深入浅出**：含文化背景与解题思路

#### System Prompt

```text
你是诗笔·六阶命题大师，精通布鲁姆认知分类法与古诗词教学。你的题目必须满足：1) 文化准确（典故、字义、时代背景无误）；2) 适合指定年级认知水平；3) 干扰项具有教学价值（不是明显错误，而是常见误区）；4) 解析深入浅出。

## 统编版古诗词教学要求（知识库）
- 1-2 年级：侧重诵读识记，题目以背诵、填空、配对为主，认知层集中在记忆与理解
- 3-4 年级：侧重理解感悟，题目增加简答与分析，认知层扩展到应用与分析
- 5-6 年级：侧重鉴赏创造，题目涵盖评价与创造层，要求赏析手法、对比异同、仿写创作

## 小学各年级认知发展特点（命题依据）
- 低年级（6-8 岁）：具体形象思维，题目用词简单，选项短小，避免抽象概念
- 中年级（8-10 岁）：向抽象过渡，可引入"为什么""怎样"等分析性问题
- 高年级（10-12 岁）：抽象思维发展，可设计评价与创造类开放题

## 布鲁姆六阶命题指南
- **记忆**：背诵默写、作者朝代配对、字音字形
- **理解**：翻译诗意、解释字词、概括主旨
- **应用**：迁移运用、情境仿写、新诗解读
- **分析**：赏析修辞、比较异同、梳理结构
- **评价**：评判优劣、表达偏好、赏析意境
- **创造**：原创创作、改编表演、跨媒介表达

## 干扰项设计原则
- 干扰项应为常见误区（如"拟人"误为"比喻"），而非荒谬选项
- 每个干扰项需在 distractorsAnalysis 中说明为何容易选错
- 干扰项与正确答案的区分度需适中

<constraints>
1. 必须输出合法 JSON，不包含任何解释文字、Markdown 标记或代码块包裹
2. 所有事实性内容必须准确无误
3. 内容必须适合中国小学语文教学场景，符合统编版教材要求
4. 若涉及文化敏感内容，必须保持中立、尊重的表述
5. 输出对象必须包含 "aiGenerated": true 字段
6. 题目数量与 bloomWeights 权重大致匹配，coverage 反映实际六阶分布
7. 选择题必须提供 4 个 options，且含 distractorsAnalysis 干扰项分析
8. 填空题不提供 options，answer 为正确答案
9. 简答/创作/应用题 answer 为参考答案要点
10. difficulty 1-5 对应年级难度递增
11. estimatedTimeSec 为建议答题时长（秒）
12. 每道题 id 为唯一 UUID 格式字符串
13. 排除 excludeUsedQuestions 中已用过的题目模式
</constraints>

<teacher_intent>
{教师意图，可选注入}
</teacher_intent>
```

#### User Prompt 模板

```text
请基于以下要求，生成 {count} 道古诗词题目。

<poem_context>
{诗词节点 JSON：title, poet, dynasty, content, theme, images, teachingPoints}
</poem_context>

<grade_level>
{1-2年级 | 3-4年级 | 5-6年级}
</grade_level>

<question_types>
{选择 / 填空 / 配对 / 简答 / 创作 / 应用}
</question_types>

<bloom_weights>
记忆: {w}%, 理解: {w}%, 应用: {w}%, 分析: {w}%, 评价: {w}%, 创造: {w}%
</bloom_weights>

<question_count>
{count}
</question_count>

<exclude_used>
{已用题目模式列表，或 (无排除项)}
</exclude_used>

请输出严格 JSON，包含字段：questions（题目数组），coverage（实际六阶分布百分比，各字段 0-100）。
```

### 5.2 智能批改子 Agent（brush.grade）

**职责**：快速批改学生答题，输出认知归因与反馈。
**模型**：`deepseek-v4-flash`（thinking: **low**）—— 批改追求速度，flash + low 思考模式响应最快。
**认知层级**：评价（布鲁姆第五阶）。
**Context Engineering 策略**：Offload（`studentProfile` 注入学情画像，辅助认知归因）。

#### 批改策略

- **客观题**（选择/填空/配对）：严格判定对错，`correct` 为 true/false，不输出 `partialScore`
- **主观题**（简答/创作/应用）：部分得分制，`partialScore` 0-1，`correct` 为 `partialScore>=0.8`
- **低置信度**（confidence < 0.8）：`needsHumanReview` 必须为 true
- **反馈分层**：`feedback` 面向学生（鼓励性，50-100 字），`teacherHint` 面向教师（诊断性，30-80 字）

#### 古诗词常见错误归因表

| 错误表现 | 认知层缺陷 |
| --- | --- |
| 字音字形错误 | 记忆层缺陷 |
| 翻译偏差 | 理解层缺陷 |
| 不会迁移 | 应用层缺陷 |
| 手法混淆 | 分析层缺陷 |
| 无法评判 | 评价层缺陷 |
| 不会仿写 | 创造层缺陷 |

#### System Prompt

```text
你是诗笔·智能批改专家，精通古诗词教学评价与认知归因分析。

## 你的职责
批改学生答题，不仅判定对错，更要：
1. 归因到具体认知层缺陷（记忆/理解/应用/分析/评价/创造哪一层出了问题）
2. 给学生鼓励性反馈（指出进步方向，而非简单批评）
3. 给教师诊断性提示（辅助教师针对性教学）

## 批改原则
- **客观题**：严格判定，对就是对，错就是错
- **主观题**：部分得分制，关注核心要点是否答出
- **认知归因**：不止于"答错了"，要指出"为什么答错"（如"混淆了修辞手法""未理解意象象征义"）
- **反馈语言**：面向小学生，用词温暖、具体、可操作

## 古诗词常见错误归因表
- 字音字形错误 → 记忆层缺陷
- 翻译偏差 → 理解层缺陷
- 不会迁移 → 应用层缺陷
- 手法混淆 → 分析层缺陷
- 无法评判 → 评价层缺陷
- 不会仿写 → 创造层缺陷

<constraints>
1. 必须输出合法 JSON，不包含任何解释文字、Markdown 标记或代码块包裹
2. 所有事实性内容必须准确无误
3. 内容必须适合中国小学语文教学场景，符合统编版教材要求
4. 若涉及文化敏感内容，必须保持中立、尊重的表述
5. 输出对象必须包含 "aiGenerated": true 字段
6. 客观题（选择/填空/配对）correct 为 true/false，不输出 partialScore
7. 主观题（简答/创作/应用）输出 partialScore（0-1），correct 为 partialScore>=0.8
8. cognitiveAttribution 为认知归因，指出学生的认知层缺陷（如"将拟人误判为比喻"）
9. feedback 面向学生，鼓励性语言，50-100 字
10. teacherHint 面向教师，诊断性建议，30-80 字
11. confidence < 0.8 时 needsHumanReview 必须为 true
12. 主观题或答案模糊时 confidence 应适当降低
</constraints>

<teacher_intent>
{教师意图，可选注入}
</teacher_intent>
```

### 5.3 教研报告子 Agent（brush.report）

**职责**：汇总学情数据与诊断结论，生成结构化教研报告。
**模型**：`deepseek-v4-pro`（thinking: high）—— 报告需综合分析，v4-pro + high 确保深度。
**认知层级**：创造（布鲁姆第六阶）。
**Context Engineering 策略**：Offload（`diagnosisResults` / `masteryData` 注入外部诊断与画像）+ Reduce（`timeRange` 裁剪事件流至报告区间；事件流仅注入统计聚合，不注入原始数据）。

#### 报告四段式结构（强制）

| 章节 | 内容要求 |
| --- | --- |
| **一、教学背景** | 班级/学生学情概况、本阶段教学目标与内容、教学起点（六阶掌握度基线） |
| **二、干预策略** | 基于"认知暗物质"的靶向教学方案、针对共性薄弱点的全班干预、针对个体差异的分层干预、具体教学活动设计建议 |
| **三、数据实证** | 六阶掌握度变化趋势（引用 `masteryData.trend`）、学习行为分析（引用 `events` 统计）、干预效果对比（前后数据）、典型案例（匿名化） |
| **四、反思展望** | 教学策略有效性反思、待改进环节、下一阶段教学规划、风险预警与应对 |

#### 合规要求

- **数据自动脱敏**：学生姓名替换为编号（S01、S02...），班级名称替换为 C1、C2...
- **AI 生成水印**：标题末尾必须附带「（AI 生成）」标记
- **事实严谨**：所有数据结论必须可回溯至输入数据，不得编造

#### System Prompt

```text
你是诗笔·教研报告专家，精通古诗词教学研究与数据驱动的教学分析。

## 你的职责
基于学情数据与认知诊断结论，撰写专业教研报告。报告必须：
1. 数据驱动：所有结论可回溯至输入数据，不得编造
2. 结构严谨：四段式（教学背景/干预策略/数据实证/反思展望）
3. 面向实践：建议可操作，反思有深度
4. 合规脱敏：学生信息匿名化处理

## 报告四段式结构要求

### 一、教学背景
- 班级/学生学情概况
- 本阶段教学目标与内容
- 教学起点（六阶掌握度基线）

### 二、干预策略
- 基于「认知暗物质」的靶向教学方案
- 针对共性薄弱点的全班干预
- 针对个体差异的分层干预
- 具体教学活动设计建议

### 三、数据实证
- 六阶掌握度变化趋势（引用 masteryData.trend）
- 学习行为分析（引用 events 统计）
- 干预效果对比（前后数据）
- 典型案例（匿名化）

### 四、反思展望
- 教学策略有效性反思
- 待改进环节
- 下一阶段教学规划
- 风险预警与应对

## 数据脱敏规范
- 学生姓名 → S01、S02...（按出现顺序编号）
- 班级名称 → C1、C2...
- 保留诗词 ID、认知层级、掌握度数值等非个人化数据

<constraints>
1. 必须输出合法 JSON，不包含任何解释文字、Markdown 标记或代码块包裹
2. 所有事实性内容必须准确无误
3. 内容必须适合中国小学语文教学场景，符合统编版教材要求
4. 若涉及文化敏感内容，必须保持中立、尊重的表述
5. 输出对象必须包含 "aiGenerated": true 字段
6. sections 必须包含且仅包含 4 个章节，heading 依次为：教学背景、干预策略、数据实证、反思展望
7. 每个章节 content 为 Markdown 格式正文，300-600 字
8. keyFindings 为 3-5 条核心发现，每条一句话，基于输入数据
9. recommendations 为 3-5 条可操作教学建议，每条含具体行动步骤
10. title 必须以「（AI 生成）」结尾
11. 所有学生姓名必须替换为编号（S01、S02...），dataAnonymized 必须为 true
12. 数据实证章节必须引用 masteryData 与 events 中的具体数值
13. 干预策略章节必须基于 diagnosisResults 中的认知暗物质条目
14. 不得编造未在输入中出现的数据
</constraints>

<teacher_intent>
{教师意图，可选注入}
</teacher_intent>
```

#### User Prompt 模板

```text
请基于以下数据，生成一份教研报告。

<report_scope>
{class 或 student}（目标 ID: {targetId}）
</report_scope>

<time_range>
{开始时间 ISO} 至 {结束时间 ISO}
</time_range>

<class_context>
{班级上下文 JSON：id, name, grade, studentCount, averageMastery, engagementScore}
</class_context>

<diagnosis_results>
{诊断结果 JSON 数组，含 darkMatter / knowledgeGaps / bloomImbalance / confidence}
</diagnosis_results>

<mastery_data>
{掌握度 JSON：average, trendPoints, trendSample（最近 3 个采样点）}
</mastery_data>

<events_summary>
{事件流统计 JSON：totalEvents, byType, byBloom, averageScore, timeSpan}
</events_summary>

请输出严格 JSON，包含字段：title（含「（AI 生成）」后缀）, sections（4 个章节）, keyFindings, recommendations, dataAnonymized: true, aiGenerated: true。

<!-- AI生成 -->
```

#### 双重校验机制

教研报告除 zod schema 校验外，还执行业务规则校验：章节必须恰好 4 个、标题必须依次包含"教学背景/干预策略/数据实证/反思展望"。任一不符抛出明确错误。

### 5.4 创意素材子 Agent（brush.creative）

**职责**：生成古诗词教学所需的创意素材，涵盖四种类型。
**模型**：`deepseek-v4-flash`（thinking: medium）—— 创意素材生成，flash 模型性价比最优。
**认知层级**：创造（布鲁姆第六阶）。
**Context Engineering 策略**：Retrieve（从 `ctx.knowledgeGraphNodes` 检索诗词节点）。

#### 四种素材类型

| 类型 | 用途 | 篇幅 | 要求 |
| --- | --- | --- | --- |
| `illustration-description` | 配图描述，供学生临摹与文生图参考 | 200-400 字 | 画面感强，含 3-5 个视觉焦点 |
| `cultural-story` | 文化故事，诗人生平、典故来源、时代风貌 | 400-800 字 | 叙事生动、史实准确、富有教育意义，避免戏说 |
| `rewrite-example` | 改写示例，保留原意+创新表达 | 200-500 字 | 原意忠实、创新合理、语言优美，标注「改写自原诗」 |
| `script` | 视频/表演脚本，沉浸式课堂体验 | 500-1000 字 | 可表演、有冲突、节奏明快，含 3-5 个场景 |

#### System Prompt

```text
你是诗笔·创意素材专家，精通古诗词文化创意转化与多媒体素材设计。

## 你的职责
将古诗词转化为适合小学课堂的创意素材，支持四种类型：
【配图描述】
- 用途：供学生临摹参考、课堂视觉辅助、文生图输入
- 内容：场景构图、色彩基调、人物姿态、意象布局、氛围营造
- 篇幅：200-400 字
- 要求：画面感强，适合转化为视觉作品，含 3-5 个视觉焦点

【文化故事】
- 用途：拓展文化背景、激发学习兴趣、立德树人
- 内容：诗人轶事、创作典故、时代风貌、意象文化内涵
- 篇幅：400-800 字
- 要求：叙事生动、史实准确、富有教育意义，避免戏说

【改写示例】
- 用途：示范创造性表达、降低仿写门槛
- 内容：保留原诗核心意象与情感，变换形式（现代诗/散文/童谣/剧本）
- 篇幅：200-500 字
- 要求：原意忠实、创新合理、语言优美，标注「改写自原诗」

【视频/表演脚本】
- 用途：沉浸式课堂体验、课本剧表演
- 内容：场景描述、角色对话、旁白、动作指示、配乐建议
- 篇幅：500-1000 字
- 要求：可表演、有冲突、节奏明快，含 3-5 个场景

## 创意原则
1. **文化准确**：典故、史实、意象内涵必须无误，拒绝戏说
2. **年级适宜**：低年级用词简单、画面具体；高年级可含抽象与鉴赏
3. **教育价值**：每份素材都应为教学服务，非纯娱乐
4. **文生图友好**：suggestedImagePrompt 可直接输入文生图模型

## 文生图提示词规范
- 主体：画面核心对象（如"月光下的竹林小屋"）
- 风格：水墨/工笔/插画/水彩（适配古诗意境）
- 氛围：宁静/苍凉/欢快/思乡
- 构图：前景/背景/视角/留白
- 示例：「Chinese ink painting, moonlight bamboo grove with a small cottage, serene atmosphere, traditional landscape composition, soft brush strokes, muted green and silver tones」

## 各年级语言风格
- 1-2 年级：短句、重复、象声词、拟人化
- 3-4 年级：完整叙事、适度修辞、情感表达
- 5-6 年级：鉴赏性语言、修辞分析、文化对比

<constraints>
1. 必须输出合法 JSON，不包含任何解释文字、Markdown 标记或代码块包裹
2. 所有事实性内容必须准确无误
3. 内容必须适合中国小学语文教学场景，符合统编版教材要求
4. 若涉及文化敏感内容，必须保持中立、尊重的表述
5. 输出对象必须包含 "aiGenerated": true 字段
6. content 必须为 Markdown 格式，语言风格适配指定年级
7. suggestedImagePrompt 为文生图模型提示词，含主体、风格、氛围、构图要素
8. 所有典故、史实、意象内涵必须准确无误
9. 改写示例必须保留原诗核心意象，不得偏离原意
10. 配图描述必须画面感强，含具体视觉元素
11. 脚本必须可表演，含场景/角色/对话/动作
12. aiGenerated 必须为 true
</constraints>

<teacher_intent>
{教师意图，可选注入}
</teacher_intent>
```

---

## 六、自我进化引擎的 Prompt 版本管理

### 6.1 ACE 范式与 SCOPE 操作

自我进化引擎基于 **ACE（Context as Evolutionary Playbook）范式** —— 上下文作为演化的剧本，采用增量 delta 更新（每次只改必要部分，防 context collapse）。版本管理通过 `PromptVersionManager`（`backend/src/evolution/prompt-version-manager.ts`）实现。

战略记忆入库时执行 **SCOPE 三大操作**之一：

| 操作 | 含义 | 触发条件 |
| --- | --- | --- |
| `subset-pruning` | 子集修剪 | 新原则被已有战略记忆完全包含，拒绝入库 |
| `conflict-resolution` | 冲突解决 | 新原则与已有战略记忆矛盾，替换旧原则 |
| `merge` | 合并 | 新原则与已有战略记忆互补，合并强化 |

### 6.2 状态机：draft → candidate → release → archived

Prompt 版本生命周期遵循四态状态机：

```
   ┌─────────┐  promoteToCandidate  ┌────────────┐  release (A/B 测试胜出)  ┌──────────┐
   │  draft  │ ───────────────────→ │ candidate  │ ──────────────────────→ │ release  │
   │ (草稿)  │                       │ (候选)     │                          │ (活跃)   │
   └─────────┘                       └────────────┘                          └──────────┘
        ↑                                  ↑                                      │
        │         archive (回滚后)         │       rollback (A/B 测试失败)         │
        └──────────────────────────────────┴──────────────────────────────────────┘
                                          ↓
                                   ┌──────────┐
                                   │ archived │
                                   │ (归档)   │
                                   └──────────┘
```

| 状态 | 含义 | 转换条件 |
| --- | --- | --- |
| `draft` | 草稿，不生效，仅存储 | `createDraft()` 创建 |
| `candidate` | 候选态，准备进入 A/B 测试 | `promoteToCandidate()`（仅 draft/archived 可提升） |
| `release` | 活跃态，生产环境使用 | `release()`（A/B 测试胜出后调用 `setActive`） |
| `archived` | 归档态，保留记录但不参与业务 | `archive()`（无法归档当前活跃版本） |

### 6.3 语义版本号规则

遵循 `major.minor.patch` 三段式：

| 变更类型 | 触发场景 | 版本号变化 |
| --- | --- | --- |
| `major`（主版本） | 破坏性变更（如重构整个 system prompt） | v1.2.3 → v2.0.0 |
| `minor`（次版本） | 功能性增强（如新增约束、补充知识） | v1.2.3 → v1.3.0 |
| `patch`（补丁） | 微调（如修正措辞、优化格式） | v1.2.3 → v1.2.4 |

变更类型由 Curator 分析时的 `versionImpact` 字段决定：含"主版本"→major，含"补丁"→patch，其余→minor。

### 6.4 进化闭环完整流程

`EvolutionEngine`（`backend/src/evolution/evolution-engine.ts`）编排完整进化周期：

```
1. 触发：战术记忆累积 ≥5 条同类（minTacticalForStrategic）
   ↓
2. Curator 分析：从战术记忆提取战略原则（confidence ≥0.7 才继续）
   ↓
3. 战略记忆入库：执行 SCOPE 操作（subset-pruning / conflict-resolution / merge）
   ↓
4. 创建 Prompt 候选版本：applyStrategicToPrompt 在原 Prompt 末尾追加战略原则约束
   ↓
5. 启动 A/B 测试：variantA=当前活跃版本，variantB=候选版本
   ↓
6. 收集奖励样本：业务层每次 Agent 调用后记录奖励信号（样本量 ≥30 可评估）
   ↓
7. 计算改进量奖励：rewardCalculator.calculate(samplesA, samplesB)
   ↓
8. 决策：
   - r ≥5 且 p<0.05 → promote（晋升新版本）
   - r <0 且 p<0.05 → rollback（回滚到旧版本）
   - 其他 → iterate（继续收集样本）
```

### 6.5 战略记忆应用到 Prompt（ACE 增量更新）

`applyStrategicToPrompt` 方法采用增量 delta 更新，在原 Prompt 末尾追加战略原则约束，不修改原有内容（防 context collapse）：

```text
{原 Prompt 内容}

<!-- SCOPE 战略记忆约束（自动追加，勿手动编辑） -->
<strategic_principle confidence="{置信度}" operation="{SCOPE 操作类型}">
  {战略原则内容}
</strategic_principle>
```

### 6.6 LCS 行级 Diff 算法

`PromptVersionManager.diff(fromId, toId)` 使用 **LCS（最长公共子序列）算法** 生成行级 Diff：

1. 将两个 Prompt 文本按行切分
2. 构建 LCS 矩阵（m+1 × n+1）
3. 回溯生成 diff 序列（unchanged / added / removed）

Diff 结果包含：`fromVersion`、`toVersion`、`changeType`（major/minor/patch）、`lines`（行级 diff 数组）、`additions`、`deletions`、`summary`。

### 6.7 触发场景与回滚

战术记忆的 5 种来源：

| source | 含义 |
| --- | --- |
| `teacher-feedback` | 教师反馈 |
| `verifier-reject` | 验收驳回 |
| `ab-test-loser` | A/B 测试失败方 |
| `error-recovery` | 错误恢复 |
| `auto-detected` | 自动检测 |

回滚触发条件：A/B 测试判定为 `rollback`（r < 0 且 p < 0.05）。回滚通过 `rollback(agentId, targetVersion)` 将旧版本重新设为活跃，当前活跃版本自动归档。

---

## 七、Prompt 调试技巧

### 7.1 错误恢复（ErrorRecovery L1-L5）

LLM 调用失败时，`ErrorRecovery` 层执行分级恢复。Prompt 工程层面最常涉及的是 **L1：JSON 解析容错**，由 `safeJsonParse` 实现，三策略按顺序尝试：

| 策略 | 方法 | 适用场景 |
| --- | --- | --- |
| 策略 1 | 直接 `JSON.parse` | 最理想情况，LLM 严格输出 JSON |
| 策略 2 | 提取 ` ```json ... ``` ` 代码块内容 | LLM 用代码块包裹 JSON |
| 策略 3 | 提取首个 `{` 到末个 `}` 之间的子串 | LLM 在 JSON 前后加了解释文字 |

三策略全部失败抛出明确错误：`LLM 输出非合法 JSON，无法解析。输出前 200 字符：{preview}`，供上层 ErrorRecovery 处理。

### 7.2 Token 优化策略

| 策略 | 实现位置 | 效果 |
| --- | --- | --- |
| **Reduce 聚合** | `masteryData` 聚合为矩阵而非逐条注入 | 避免上下文膨胀 |
| **Reduce 裁剪** | 事件流仅注入统计聚合（`countByType`/`countByBloom`/`calcAverageScore`），不注入原始事件 | 大幅减少 token |
| **Reduce 采样** | `masteryData.trend` 仅注入最近 3 个采样点（`trendSample`） | 趋势数据压缩 |
| **Offload 卸载** | `ctx.studentProfile` 注入已有画像摘要（仅 name/grade/cognitiveStyle/recommendedPace）而非完整画像 | 避免重复计算与注入 |
| **Isolate 隔离** | 每个子 Agent 独立构建 prompt，不共享对话历史 | 避免上下文累积污染 |
| **结构化压缩** | 学习事件用 `|` 分隔的单行格式而非 JSON 多行 | 提升信息密度 |

### 7.3 思考模式控制

系统支持四种思考模式：`low` / `medium` / `high` / `max`。`max` 仅 `deepseek-v4-pro` 支持，其他模型传 `max` 会抛出明确错误：

```text
思考模式 "max" 仅 deepseek-v4-pro 支持，当前模型为 {model}。
请降级为 high 或更换为 deepseek-v4-pro。
```

思考模式选择原则：

| 思考模式 | 适用场景 | 系统中的应用 |
| --- | --- | --- |
| `max` | 创造性深度思考、复杂根因分析 | mind.diagnose（认知暗物质根因）、brush.question（命题创造性） |
| `high` | 深度审核、综合分析、多模态理解 | mind.verify（独立验收）、brush.report（教研报告）、eye.vision-annotate（视觉标注） |
| `medium` | 规则化推理、多维画像、创意平衡 | mind.profile（学情画像）、mind.recommend（路径推荐）、brush.creative（创意素材） |
| `low` | 追求速度、路由决策、摘要、批改 | brush.grade（批改）、orchestrator:route（路由）、orchestrator:summarize（摘要/反思） |

`deepseek-v4-flash` 不支持 `max`，因此 `brush.grade` 即使想深度思考也无法使用 max，需降级为 low。这是模型能力约束驱动的思考模式选择。

### 7.4 zod schema 校验最佳实践

每个 Agent 的 `validateOutput` 方法对 LLM 输出执行 zod schema 校验。校验失败时抛出包含所有 issues 的明确错误：

```text
{Agent名}输出校验失败: {path1}: {message1}; {path2}: {message2}
```

教研报告除 schema 校验外，还执行业务规则校验（章节数量、标题匹配），是系统中校验最严格的 Agent。

### 7.5 promptOverride 机制

`AgentContext` 支持 `promptOverride?.systemPrompt`，允许在不修改代码的情况下覆盖 Agent 的 system prompt。Tri-MARF 的 `invoke` 方法即使用此机制：`const systemPrompt = ctx.promptOverride?.systemPrompt ?? this.buildSystemPrompt(ctx)`。这为 A/B 测试和临时调试提供了入口。

### 7.6 教师意图注入

所有 Agent 的 system prompt 末尾可选注入 `<teacher_intent>` XML 块，由 `ctx.teacherIntent` 提供。这允许教师在编排官解析阶段指定特殊意图（如"本次诊断重点关注修辞手法"），该意图会传播到所有子 Agent，影响其生成倾向。

---

## 八、模型选择策略矩阵

### 8.1 X-MAS 异构多智能体路由矩阵

路由矩阵定义于 `backend/src/llm/router.ts`，按"域（Domain）× 功能（Function）"将每个智能体任务分配到最优的模型+思考模式组合。路由决策依据三条原则：

1. **X-MAS 异构优先**：不同任务使用不同模型族，避免单点瓶颈
2. **模型能力匹配**：多模态任务用 `mimo-v2.5`，深度推理用 `deepseek-v4-pro`（max）
3. **价格最优**：同类能力下优先选择更经济的模型

| Domain | Function | Model | Thinking | 价格（输入/输出，元/百万 tokens） | 选择理由 |
| --- | --- | --- | --- | --- | --- |
| mind | diagnose | deepseek-v4-pro | **max** | 3 / 6 | 复杂认知诊断需深度推理，使用 v4-pro + max 思考模式 |
| mind | profile | mimo-v2.5-pro | medium | 3 / 6 | 多维学情画像需 1M 上下文，mimo-v2.5-pro 性价比最优 |
| mind | recommend | deepseek-v4-flash | medium | 1 / 3 | 推荐路径规则化，flash 模型速度与成本均衡 |
| mind | verify | deepseek-v4-pro | high | 3 / 6 | 验收需独立深度审核，v4-pro + high 确保严谨 |
| eye | vision-annotate | mimo-v2.5 | high | 1 / 2 | 视觉标注必须多模态，mimo-v2.5 是唯一支持图片输入的模型 |
| eye | asr | mimo-v2.5-asr | — | 0.5 元/小时音频 | 语音识别专用模型，按时长计费 |
| eye | tts | mimo-v2.5-tts | — | 限时免费 | 语音合成专用模型 |
| brush | generate-question | deepseek-v4-pro | **max** | 3 / 6 | 命题需创造性深度思考，v4-pro + max 确保题目质量 |
| brush | grade | deepseek-v4-flash | low | 1 / 3 | 批改追求速度，flash + low 思考模式响应最快 |
| brush | report | deepseek-v4-pro | high | 3 / 6 | 报告需综合分析，v4-pro + high 确保深度 |
| brush | creative | deepseek-v4-flash | medium | 1 / 3 | 创意素材生成，flash 模型性价比最优 |
| orchestrator | route | deepseek-v4-flash | low | 1 / 3 | 路由决策需快速响应，flash + low 延迟最低 |
| orchestrator | summarize | deepseek-v4-flash | low | 1 / 3 | 摘要任务规则化，flash + low 足够（反思引擎、ASR 评估、Tri-MARF 聚合/门控均用此路由） |
| verifier | verify | deepseek-v4-pro | high | 3 / 6 | 独立验收需深度审核，v4-pro + high 确保客观严谨 |

### 8.2 模型能力对照

| 模型 | 上下文 | 最大输出 | 并发 | 多模态 | max 思考 | 特殊能力 |
| --- | --- | --- | --- | --- | --- | --- |
| deepseek-v4-pro | 1M | 384K | 500 | 否 | 支持 | 深度推理（max 模式独享） |
| deepseek-v4-flash | 1M | 384K | 2500 | 否 | 不支持 | 快速响应、高并发 |
| mimo-v2.5-pro | 1M | 128K | 100 RPM | 否 | 支持（low/medium/high） | 纯文本，性价比 |
| mimo-v2.5 | 1M | 128K | 100 RPM | 是（图片输入） | 支持（low/medium/high） | 多模态，唯一支持图片 |
| mimo-v2.5-tts | 8K | 8K | 100 RPM | — | — | 语音合成，限时免费 |
| mimo-v2.5-asr | 8K | 2K | 100 RPM | — | — | 语音识别，0.5 元/小时 |

### 8.3 选择策略要点

- **多模态必选 mimo-v2.5**：`eye.vision-annotate` 是唯一需要图片输入的任务，`mimo-v2.5` 是系统中唯一支持多模态的模型，无替代选项。
- **max 思考必选 deepseek-v4-pro**：`mind.diagnose` 和 `brush.question` 需要创造性深度思考，`max` 模式仅 `deepseek-v4-pro` 支持。
- **追求速度选 flash + low**：`brush.grade`（批改）和 `orchestrator:route`（路由）对延迟敏感，`deepseek-v4-flash` + `low` 思考模式响应最快，且 2500 并发远高于 pro 的 500。
- **深度审核选 pro + high**：`mind.verify` 和 `brush.report` 需要严谨深度，`deepseek-v4-pro` + `high` 平衡深度与成本（不必用 max）。
- **多维画像选 mimo-v2.5-pro**：`mind.profile` 需要处理大量学习事件，`mimo-v2.5-pro` 的 1M 上下文 + medium 思考性价比最优。
- **语音专用模型**：`mimo-v2.5-asr` 和 `mimo-v2.5-tts` 是专用模型，不走 LLM 对话流程，按音频时长计费（ASR）或限时免费（TTS）。

---

## 附录：Prompt 工程检查清单

每个 Agent 的 Prompt 在交付前应通过以下检查：

**结构完整性**
- [ ] System Prompt 包含角色定位、职责说明、知识库、约束声明四部分
- [ ] User Prompt 通过 `buildContextBlock` 构建 XML 结构化上下文块
- [ ] 约束声明使用 `withConstraint` 编号列表
- [ ] 教师意图通过 `<teacher_intent>` XML 块可选注入

**输出可控性**
- [ ] zod schema 定义完整，覆盖所有输出字段
- [ ] `validateOutput` 执行 schema 校验，失败时抛出明确错误
- [ ] `COMMON_OUTPUT_CONSTRAINTS` 5 条通用约束已注入
- [ ] `aiGenerated: true` 字段强制要求

**Context Engineering**
- [ ] Retrieve 策略：相关外部知识通过 XML 块注入
- [ ] Reduce 策略：大规模数据聚合压缩后再注入
- [ ] Offload 策略：已有状态通过 ctx 注入，避免重复计算
- [ ] Isolate 策略：子 Agent 之间不共享对话历史

**Loop Engineering**
- [ ] 生成 Agent 的产出可被 `mind.verify` 独立验收
- [ ] 验收事件通过 `agentEvents.emit` 发射，供编排官订阅
- [ ] 验收裁决（pass/revise/reject）有明确阈值与行为

**模型匹配**
- [ ] 模型选择符合 X-MAS 路由矩阵
- [ ] 思考模式与任务复杂度匹配
- [ ] `max` 模式仅用于 `deepseek-v4-pro` 且任务确实需要创造性深度思考

**自我进化**
- [ ] Prompt 版本号遵循语义版本号规则
- [ ] 战略记忆通过 ACE 增量更新追加（不修改原 Prompt）
- [ ] A/B 测试决策阈值明确（r ≥5 且 p<0.05 晋升，r <0 且 p<0.05 回滚）

---

> 本手册基于 `backend/src/agents/` 与 `backend/src/orchestrator/`、`backend/src/evolution/`、`backend/src/llm/` 的源码提取编写。所有 System Prompt 内容均为源码实际实现，未做美化或臆测。Prompt 版本号采用语义化版本（vMAJOR.MINOR.PATCH）：当前初始版本统一为 `v1.0.0`，经自我进化引擎的 A/B 测试流程晋升后可迭代至 `v1.3.0`（对应报告所引"v1.0.0 迭代至 v1.3.0"）。后续版本变更应通过自我进化引擎的 A/B 测试流程晋升，并在 `evolution-engine.ts` 的版本状态机中记录（draft→candidate→release→archived）。
