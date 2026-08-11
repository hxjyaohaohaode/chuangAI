# 诗脉·启明 PoeticRealm AI v5.0 开发文档

> 面向小学古诗词教学的异构多智能体（X-MAS）Web 应用
> 中央电教馆创 AI 案例征集参赛项目

---

## 目录

1. [架构总览](#一架构总览)
2. [异构多智能体设计](#二异构多智能体设计)
3. [中央编排官与 DAG 调度器](#三中央编排官与-dag-调度器)
4. [LLM 客户端与错误恢复](#四llm-客户端与错误恢复)
5. [自我进化引擎](#五自我进化引擎)
6. [知识图谱与认知暗物质检测](#六知识图谱与认知暗物质检测)
7. [学情数据库设计](#七学情数据库设计)
8. [WebSocket 实时协作推送](#八websocket-实时协作推送)
9. [前端架构](#九前端架构)
10. [本地开发指南](#十本地开发指南)
11. [贡献指南](#十一贡献指南)

---

## 一、架构总览

### 1.1 系统定位

诗脉·启明 PoeticRealm AI v5.0 是一套面向小学古诗词教学场景的异构多智能体（X-MAS，eXtended Multi-Agent System）Web 应用。系统以"教师 in-the-loop"为核心交互范式，通过中央编排官将教师的自然语言指令拆解为子任务 DAG，调度三大主智能体（诗心 / 诗眼 / 诗笔）与 11 个子智能体协同完成认知诊断、命题、批改、教研报告等教学任务，并通过自我进化引擎实现 Prompt 的持续优化。

### 1.2 设计哲学

本系统的工程实现遵循四条核心范式：

| 范式 | 内涵 | 本系统落点 |
| --- | --- | --- |
| Harness Engineering | 编排官是驾驭 LLM 的"线具"，负责拆解、调度、收集结果，而非让 LLM 自主决策一切 | Orchestrator + DAGScheduler |
| Loop Engineering | 编排官自身处于 plan → execute → observe → reflect 闭环 | reflect() 方法 + 进化引擎 |
| Context Engineering | 五策略管理 LLM 上下文窗口：Offload / Retrieve / Isolate / Cache / Reduce | AgentContext 五字段注入 |
| 教师 in-the-loop | 教师可随时 pause / resume / abort / modify 任一 Agent | Orchestrator 介入接口 |

### 1.3 顶层架构图

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              浏览器（教师 / 学生）                          │
│  React 18 + TS 5.6 + Vite 5.4 + Tailwind 3.4 + Zustand + D3.js 7.9     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │ 教学驾驶舱    │  │ 多智能体观测台│  │ 自我进化引擎  │  │ 诗脉星图   │ │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └─────┬──────┘ │
└─────────┼──────────────────┼──────────────────┼────────────────┼────────┘
          │ HTTP REST        │ WebSocket        │ HTTP REST      │ HTTP
          ▼                  ▼                  ▼                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                       Fastify 4.28（API 网关）                            │
│            @fastify/cors  @fastify/websocket  @fastify/multipart         │
└──────────────────────────────────────┬──────────────────────────────────┘
                                       │
          ┌────────────────────────────┴────────────────────────────┐
          ▼                                                           ▼
┌───────────────────────────┐                          ┌──────────────────────┐
│   中央编排官 Orchestrator  │  教师 in-the-loop 介入    │  WSBroadcaster       │
│  parseInstruction/execute │ ◀────── pause/resume ──── │  按订阅过滤器分发     │
│  pause/resume/abort/modify│                          │  orch:* / agent:* 事件│
│  reflect                  │                          └──────────────────────┘
└─────────────┬─────────────┘
              │ DAG 调度（拓扑序 + 并行/串行/条件分支）
              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         DAGScheduler（Kahn 拓扑排序）                     │
│   getReadyNodes() → Promise.allSettled 并行 → evaluateConditions 条件分支  │
└──────────────────────────────────────┬──────────────────────────────────┘
                                       │ 按节点 agentId 派发
       ┌───────────────────┬───────────┴───────────┬───────────────────┐
       ▼                   ▼                       ▼                   ▼
┌─────────────┐    ┌──────────────┐        ┌──────────────┐    ┌──────────────┐
│  诗心 mind   │    │  诗眼 eye     │        │  诗笔 brush   │    │ verifier     │
│  认知诊断域  │    │  多模态感知域 │        │  内容生成域   │    │ 独立验收域   │
├─────────────┤    ├──────────────┤        ├──────────────┤    ├──────────────┤
│ profile     │    │ vision-annot │        │ question     │    │ verify       │
│ diagnose    │    │ asr          │        │ grade        │    │              │
│ recommend   │    │ tts          │        │ report       │    │              │
│ verify      │    │              │        │ creative     │    │              │
└──────┬──────┘    └──────┬───────┘        └──────┬───────┘    └──────┬───────┘
       │                  │                       │                   │
       └──────────────────┴───────────┬───────────┴───────────────────┘
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      LLMRouter（域 × 功能 路由矩阵）                      │
│   resolve(domain, fn) → {provider, model, thinking, reason}              │
└──────────────────────────────────────┬──────────────────────────────────┘
                                       │
          ┌────────────────────────────┼────────────────────────────┐
          ▼                            ▼                            ▼
┌─────────────────────┐    ┌─────────────────────┐    ┌─────────────────────┐
│  DeepSeekClient     │    │  MiMoClient         │    │  ErrorRecovery      │
│  v4-pro / v4-flash  │    │  v2.5 / v2.5-pro    │    │  L1 退避 / L2 参数  │
│  thinking: low~max  │    │  v2.5-tts / v2.5-asr│    │  L3 工具 / L4 死循环│
│  JSON Output        │    │  多模态 / 语音       │    │  L5 降级            │
└─────────────────────┘    └─────────────────────┘    └─────────────────────┘
          │                            │                            │
          └──────────────┬─────────────┘                            │
                         ▼                                          │
              ┌──────────────────────┐                              │
              │  TokenBilling        │ ◀────────────────────────────┘
              │  按 model 计费 + 缓存│
              └──────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                            持久化与知识层                                 │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────┐  │
│  │ SQLite (WAL)     │  │ Neo4j 5.x        │  │ EvolutionEngine      │  │
│  │ 11 表 + 2 视图   │  │ 6 节点 + 10 边   │  │ 战术/战略记忆         │  │
│  │ 事件溯源架构     │  │ 148 首收录诗集图谱│  │ Prompt 版本 + A/B 测试│  │
│  └──────────────────┘  └──────────────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

### 1.4 核心数据流

以"为三年级二班出题并批改"这一复合指令为例，系统数据流如下：

```
教师指令                            编排官解析                          DAG 调度
   │                                   │                                  │
   │  "给三二班出《静夜思》             │  parseInstruction()              │ getReadyNodes()
   │   六阶题，批改后生成报告"  ──────▶│  → intent=composite              │ → [t1] 并行就绪
   │                                   │  → subTasks: [t1,t2,t3]          │
   │                                   │  → dependencies: t1→t2→t3        │
   │                                   └──────────────────────────────────┘
   │                                                                       │
   │                                            ┌──────────────────────────┘
   │                                            ▼
   │   ┌──────────────────────────────────────────────────────────────┐
   │   │ t1: brush.question  命题（v4-pro/max）                        │
   │   │     ↓ 依赖 t1 完成                                           │
   │   │ t2: brush.grade     批改（v4-flash/low）                      │
   │   │     ↓ 依赖 t2 完成                                           │
   │   │ t3: brush.report    报告（v4-pro/high）                       │
   │   └──────────────────────────────────────────────────────────────┘
   │                                            │
   │                                            ▼ 每个 Agent.invoke
   │   ┌──────────────────────────────────────────────────────────────┐
   │   │ BaseAgent.invoke()（模板方法）                                │
   │   │  1. emitStart  → agent:call:start 事件                       │
   │   │  2. buildSystemPrompt + buildUserPrompt                      │
   │   │  3. router.execute(domain, fn, params)                       │
   │   │     → resolve 路由 → errorRecovery.wrap → invokeClient       │
   │   │  4. validateOutput（zod 校验）                                │
   │   │  5. emitSuccess → agent:call:success 事件                    │
   │   │  6. 返回 AgentResult<T>（含 aiGenerated: true）              │
   │   └──────────────────────────────────────────────────────────────┘
   │                                            │
   │                                            ▼ 事件流
   │   ┌──────────────────────────────────────────────────────────────┐
   │   │ WSBroadcaster.broadcast() → 前端观测台实时渲染                │
   │   │   orch:task:start / orch:task:done / llm:call:success ...    │
   │   └──────────────────────────────────────────────────────────────┘
   │                                            │
   │                                            ▼ 执行完成
   │   ┌──────────────────────────────────────────────────────────────┐
   │   │ Orchestrator.reflect() → 反思建议 → EvolutionEngine          │
   │   │ SQLite 写入 answers / mastery / events 表（事件溯源）        │
   │   └──────────────────────────────────────────────────────────────┘
   ▼
教师获得：题目 + 批改反馈 + 教研报告 + 观测台回放
```

---

## 二、异构多智能体设计

### 2.1 三大主智能体

系统按"认知—感知—生成"三分法划分三大主智能体域。主智能体本身不直接调用 LLM，仅作为子智能体的逻辑分组容器，由 `flattenAgents()` 扁平化为 `Record<string, BaseAgent>` 注册表供编排官按 `agentId` 查找。

| 主智能体 | 域（Domain） | 隐喻 | 职责 |
| --- | --- | --- | --- |
| 诗心 | `mind` | 认知诊断 | 学情画像、认知暗物质检测、路径推荐、独立验收 |
| 诗眼 | `eye` | 多模态感知 | 视觉标注（Tri-MARF）、语音识别、范读合成 |
| 诗笔 | `brush` | 内容生成 | 六阶命题、智能批改、教研报告、创意素材 |

### 2.2 子智能体职责矩阵

下表列出全部 11 个子智能体的能力契约（与 `Orchestrator.AGENT_CAPABILITIES` 严格对齐，编排官在解析阶段注入此清单以避免 LLM 编造不存在的 Agent）：

| agentId | 名称 | 所属域 | 输入契约（inputHint） | 路由模型 | 思考模式 |
| --- | --- | --- | --- | --- | --- |
| `mind.profile` | 学情画像 | mind | `{ studentId, events: LearningEvent[] }` | mimo-v2.5-pro | medium |
| `mind.diagnose` | 认知诊断 | mind | `{ scope, targetId, profiles? }` | deepseek-v4-pro | max |
| `mind.recommend` | 路径推荐 | mind | `{ studentId, diagnosis }` | deepseek-v4-flash | medium |
| `mind.verify` | 独立验收 | mind | `{ targetAgentId, output, dimensions? }` | deepseek-v4-pro | high |
| `eye.vision-annotate` | 视觉标注 | eye | `{ images, purpose }` | mimo-v2.5 | high |
| `eye.asr` | 语音识别 | eye | `{ audio, language? }` | mimo-v2.5-asr | — |
| `eye.tts` | 范读合成 | eye | `{ text, voice?, speed? }` | mimo-v2.5-tts | — |
| `brush.question` | 六阶命题 | brush | `{ poemId, gradeLevel, questionTypes, bloomWeights, count }` | deepseek-v4-pro | max |
| `brush.grade` | 智能批改 | brush | `{ questions, answers }` | deepseek-v4-flash | low |
| `brush.report` | 教研报告 | brush | `{ classId, diagnosis?, grades? }` | deepseek-v4-pro | high |
| `brush.creative` | 创意素材 | brush | `{ poemId, creativeType, gradeLevel }` | deepseek-v4-flash | medium |

> 注：另有 `verifier:verify` 路由用于独立验收域，与 `mind.verify` 形成"生产者—审核者"分离的制衡结构。

### 2.3 Agent 基类：模板方法模式

所有子 Agent 继承 `BaseAgent` 抽象基类，采用模板方法模式封装统一的调用生命周期。基类定义于 `backend/src/agents/base/Agent.ts`：

```typescript
export abstract class BaseAgent {
    // 元数据（子类必须声明）
    abstract readonly id: string
    abstract readonly name: string
    abstract readonly domain: Domain
    abstract readonly fn: Function
    abstract readonly bloomLevel: BloomLevel
    abstract readonly promptVersion: string

    // 抽象方法（子类实现单次调用逻辑）
    protected abstract buildSystemPrompt(ctx: AgentContext): string
    protected abstract buildUserPrompt(input: unknown, ctx: AgentContext): string
    protected abstract validateOutput(raw: string): unknown

    // 模板方法：统一调用入口
    async invoke(input: unknown, ctx: AgentContext): Promise<AgentResult<unknown>> {
        const startedAt = Date.now()
        this.emitStart(this.previewInput(input), ctx)

        try {
            const systemPrompt = ctx.promptOverride?.systemPrompt ?? this.buildSystemPrompt(ctx)
            const userPrompt = this.buildUserPrompt(input, ctx)
            const messages: ChatMessage[] = [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ]

            // 路由矩阵自动选择最优模型 + 错误恢复包装
            const result = await router.execute(this.domain, this.fn, {
                messages,
                jsonOutput: this.useJsonOutput(),
                metadata: { agent: this.id, task: ctx.taskId, sessionId: ctx.sessionId },
                signal: ctx.signal,
            })

            const output = this.validateOutput(result.content)
            const agentResult: AgentResult<unknown> = {
                agentId: this.id,
                output,
                usage: { ...result.usage },
                latencyMs: Date.now() - startedAt,
                promptVersion: ctx.promptOverride?.version ?? this.promptVersion,
                aiGenerated: true,
                ...(result.fallback ? { warnings: ['本次输出为降级模式，质量可能受限'] } : {}),
            }
            this.emitSuccess(agentResult, ctx)
            return agentResult
        } catch (err) {
            this.emitError(err, ctx)
            throw err
        }
    }
}
```

**生命周期七步**：发射 `agent:call:start` → 构建 system+user prompt → `router.execute` 调用 LLM → `validateOutput` 解析与 zod 校验 → 发射 `agent:call:success` → 失败时发射 `agent:call:error` 交由 errorRecovery 处理 → 返回 `AgentResult<T>`（强制携带 `aiGenerated: true` 元数据）。

### 2.4 Context Engineering 五策略注入

`AgentContext` 是上下文工程的统一注入入口，五策略对应五字段：

| 策略 | 字段 | 作用 |
| --- | --- | --- |
| Offload（外部记忆卸载） | `studentProfile` / `classContext` | 将学情画像从 LLM 上下文窗口卸载到结构化字段 |
| Retrieve（检索增强） | `knowledgeGraphNodes` | 知识图谱检索结果作为外部知识注入 |
| Isolate（历史隔离） | `history` | 历史对话隔离注入，避免污染当前 prompt |
| Cache（Prompt 缓存） | `promptOverride` | 自我进化引擎的 Prompt 版本覆盖 |
| Reduce（意图裁剪） | `teacherIntent` | 教师意图裁剪，去除无关上下文 |

### 2.5 模型路由策略

路由矩阵遵循三条原则（见 `backend/src/llm/router.ts` 顶部注释）：

1. **X-MAS 异构优先**：不同任务使用不同模型族，避免单点瓶颈与单模型故障传导
2. **模型能力匹配**：多模态任务强制使用 mimo-v2.5（唯一支持图片输入），深度推理使用 v4-pro + max 思考模式
3. **价格最优**：同类能力下优先选择更经济的模型（如批改用 flash+low 而非 pro+high）

路由决策由 `LLMRouter.resolve()` 实现，按 `${domain}:${function}` 拼接键查询 `ROUTE_MATRIX`：

```typescript
resolve(domain: Domain, fn: Function): RouteDecision {
    const key = `${domain}:${fn}`
    const entry = ROUTE_MATRIX[key]
    if (!entry) {
        throw new Error(`路由矩阵未覆盖: ${key}，请检查 domain/function 组合`)
    }
    return {
        provider: entry.provider,
        model: entry.model,
        thinking: entry.thinking,
        reason: entry.reason,
    }
}
```

模型选型依据项目大模型规范：仅使用 deepseek 系列（v4-pro / v4-flash）与 mimo 系列（v2.5 / v2.5-pro / v2.5-tts / v2.5-asr），禁用其他任何大模型。思考模式分低（low）、中（medium）、高（high）三档，deepseek-v4-pro 额外支持超高模式（max）。

---

## 三、中央编排官与 DAG 调度器

### 3.1 编排官职责

中央编排官（`Orchestrator`，定义于 `backend/src/orchestrator/Orchestrator.ts`）是多智能体系统的指挥中枢，承担四类职责：

| 职责 | 方法 | 说明 |
| --- | --- | --- |
| 解析指令 | `parseInstruction` | 将教师自然语言指令解析为可执行的 DAG |
| 执行调度 | `execute` | 调度 DAG，并行/串行/条件分支执行 |
| 教师介入 | `pause` / `resume` / `abort` / `modify` / `abortSession` | 教师 in-the-loop 中途介入 |
| 执行反思 | `reflect` | 执行后反思，输出强弱 Agent 与改进建议 |

### 3.2 任务拆解：从自然语言到 DAG

`parseInstruction` 调用 `router.execute('orchestrator', 'route', ...)`，通过 XML 标签 `<available_agents>` 注入可用 Agent 清单（防止 LLM 编造不存在的 Agent），输出严格 JSON。输出经 `parsedInstructionSchema`（zod）校验：

```typescript
const parsedInstructionSchema = z.object({
    intent: intentSchema,                       // 11 种意图枚举
    subTasks: z.array(subTaskNodeSchema).min(1),// 至少 1 个子任务
    dependencies: z.array(z.object({            // 条件分支依赖
        from: z.string(),
        to: z.string(),
        condition: z.string().optional(),
    })).default([]),
    estimatedDurationMs: z.number().int().positive().default(30_000),
    confidence: z.number().min(0).max(1).default(0.5),
    reasoning: z.string().optional(),
})
```

校验通过后，编排官额外执行两项合法性检查：`agentId` 必须存在于 `CAPABILITY_INDEX`；`dependencies` 中的 id 必须在 `subTasks` 中存在。最终构建 `DAG = { nodes: SubTask[], edges: Dependency[] }` 交由调度器执行。

意图分类覆盖 11 种：`generate-questions` / `grade-answers` / `diagnose-class` / `diagnose-student` / `generate-report` / `recommend-path` / `vision-annotate` / `evaluate-recitation` / `generate-tts` / `generate-creative` / `composite`（复合任务）/ `unknown`。

### 3.3 DAG 调度器：Kahn 拓扑排序

`DAGScheduler`（定义于 `backend/src/orchestrator/dag-scheduler.ts`）负责 DAG 的拓扑排序、就绪节点计算、条件分支评估与状态机推进，不直接执行 Agent 调用。

**拓扑排序基于 Kahn 算法**：每次取入度为 0 的节点加入结果并移除其所有出边，若结果长度小于节点数则存在环：

```typescript
topologicalSort(): string[] {
    const inDegree = new Map<string, number>()
    for (const [nodeId, preds] of this.predecessors) {
        inDegree.set(nodeId, preds.size)
    }
    const queue: string[] = []
    for (const [nodeId, deg] of inDegree) {
        if (deg === 0) queue.push(nodeId)
    }
    const result: string[] = []
    while (queue.length > 0) {
        const current = queue.shift()!
        result.push(current)
        const succs = this.successors.get(current)
        if (succs) {
            for (const succ of succs) {
                const newDeg = (inDegree.get(succ) ?? 0) - 1
                inDegree.set(succ, newDeg)
                if (newDeg === 0) queue.push(succ)
            }
        }
    }
    return result
}
```

构造函数在初始化时即执行环检测，发现环立即抛出 `DAGErr('CYCLE')`。

### 3.4 并行 / 串行 / 条件分支

**就绪节点判定**（`getReadyNodes`）：节点状态为 `pending` 且所有依赖节点状态为 `success`。返回结果按拓扑序排序，保证执行顺序稳定。

**并行执行**：编排官的 `runDAGLoop` 主循环每轮调用 `getReadyNodes`，对返回的就绪节点批 `Promise.allSettled` 并行执行：

```typescript
private async runDAGLoop(execution: ActiveExecution): Promise<void> {
    const { scheduler, sessionController } = execution
    while (!scheduler.isComplete()) {
        if (sessionController.signal.aborted) { this.abortAllRunning(execution); break }
        scheduler.evaluateConditions(scheduler.collectResults())
        const ready = scheduler.getReadyNodes()
        if (ready.length === 0) {
            if (execution.runningControllers.size === 0) {
                const snap = scheduler.snapshot()
                if (snap.paused > 0) { await sleep(100); continue }  // 等待 resume
                break                                                 // 死锁或完成
            }
            await this.waitForRunningTasks(execution); continue
        }
        const batchPromises = ready.map((node) => this.executeNode(node, execution))
        await Promise.allSettled(batchPromises)
        scheduler.evaluateConditions(scheduler.collectResults())
    }
}
```

**串行执行**：通过 `dependencies` 显式声明数据依赖，被依赖节点未完成时当前节点不进入就绪集合。

**条件分支**：节点可携带 `condition: (results: Map<string, unknown>) => boolean` 谓词。`evaluateConditions` 在每轮批次后评估所有依赖已完成的 pending 节点，谓词返回 false 则标记 `skipped`：

```typescript
evaluateConditions(results: Map<string, unknown>): string[] {
    const skipped: string[] = []
    for (const [nodeId, preds] of this.predecessors) {
        const node = this.nodes.get(nodeId)!
        if (node.status !== 'pending' || !node.condition) continue
        // 检查依赖是否全部 success ...
        try {
            if (!node.condition(results)) {
                node.status = 'skipped'
                node.error = '条件分支评估为 false，跳过执行'
                skipped.push(nodeId)
                this.propagateFailure(nodeId)
            }
        } catch (err) {
            // 条件评估抛错视为 false
        }
    }
    return skipped
}
```

### 3.5 状态机与失败传播

子任务状态机严格单向：`pending → running → success / failed / paused / skipped`。合法转换表由 `VALID_TRANSITIONS` 常量定义。

**失败传播**：当节点失败或被跳过时，`propagateFailure` 递归地将依赖它的 pending 节点（无自定义 condition）标记为 `skipped`。带自定义 condition 的节点保留给 `evaluateConditions` 决策，允许 condition 函数读取失败状态并决定是否仍然执行（实现"失败后改走备用分支"）。

### 3.6 教师介入与超时控制

| 介入操作 | 实现 | 行为 |
| --- | --- | --- |
| `pause(taskId)` | 触发任务级 `AbortController`（reason: 'pause'） | `executeNode` 捕获后标记 `paused` 而非 `failed` |
| `resume(taskId)` | 重置 paused 节点为 pending | 下一轮 `getReadyNodes` 重新拾取 |
| `abort(taskId)` | 触发 `AbortController`（reason: 'abort'） | 标记 `failed` |
| `modify(taskId, newInput)` | 中止当前运行 + 修改输入 + 重置 pending | 重跑该节点 |
| `abortSession(sessionId)` | 触发会话级 `AbortController` | 中止所有运行中任务 |

每个节点默认 60s 超时（`DEFAULT_NODE_TIMEOUT_MS`），超时自动标记失败。`activeExecutions` 容量上限 100（`MAX_ACTIVE_EXECUTIONS`），超出拒绝新建以防内存泄漏。

---

## 四、LLM 客户端与错误恢复

### 4.1 LLMRouter 编排链路

`LLMRouter`（定义于 `backend/src/llm/router.ts`）继承 `EventEmitter`，是 LLM 调用的统一编排层。`execute()` 方法的完整链路：

1. `resolve()` 路由决策（domain × function → model + thinking）
2. 发射 `llm:call:start` 事件
3. `errorRecovery.wrap()` 包装调用（L1 重试 + L5 降级）
4. 按 provider + category 调用对应 client（text / tts / asr / vision 四类分发）
5. L4 死循环检测（`trackOutput`）
6. `billing.record()` 计费
7. 发射 `llm:call:success` / `llm:call:error` 事件

按功能类别分发的核心逻辑：

```typescript
private async invokeClient(decision, category, params): Promise<LLMResult> {
    switch (category) {
        case 'tts':    return this.invokeTts(decision, params, startTime)    // mimo-v2.5-tts
        case 'asr':    return this.invokeAsr(decision, params, startTime)    // mimo-v2.5-asr
        case 'vision': return this.invokeVision(decision, params, startTime) // mimo-v2.5 多模态
        case 'text':
        default:       return this.invokeText(decision, params, startTime)   // deepseek / mimo 文本
    }
}
```

流式输出通过 `executeStream` 方法返回 `AsyncGenerator`，每个分片同时通过 `llm:stream:delta` 事件推送，供前端观测台实时渲染多智能体协作过程。

### 4.2 五层错误恢复策略

`ErrorRecovery`（定义于 `backend/src/llm/error-recovery.ts`）实现 5 层恢复策略，覆盖从网络抖动到死循环检测的全链路错误处理：

| 层级 | 名称 | 触发条件 | 恢复动作 | 可重试 |
| --- | --- | --- | --- | --- |
| L1 | 指数退避重试 | network / rate-limit(429) / server(5xx) | base 1s × 2^attempt ± 25% jitter，上限 30s；429 优先尊重 Retry-After | 是 |
| L2 | 参数错回注 | 4xx 参数错误（BadRequestError 等） | 将错误信息回注 system message，提示模型调整 | 否（交上层） |
| L3 | 工具失败回注 | tool 调用返回错误 | 将错误注入对话让模型自我修正 | 否（交上层） |
| L4 | 死循环检测 | 连续相同输出 ≥3 次 / 工具调用未收敛 ≥5 次 | 抛出 `loop` 错误，不可重试 | 否 |
| L5 | 优雅降级 | 所有重试失败 | 返回预定义 fallback 内容（标注"AI 生成（降级模式）"） | — |

`wrap()` 方法的核心逻辑：

```typescript
async wrap<T>(fn: () => Promise<T>, opts: WrapOptions): Promise<T> {
    const maxRetries = opts.maxRetries ?? 3
    let lastError: LLMError | undefined
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn()
        } catch (err) {
            const llmErr = this.classifyError(err)
            if (llmErr.type === 'loop') throw llmErr           // L4 直接抛出
            if (!llmErr.retryable) throw llmErr                 // L2/L3 交上层
            lastError = llmErr
            if (attempt >= maxRetries) break
            const delay = this.calcBackoff(llmErr, attempt)     // L1 退避
            opts.onRetry?.(llmErr, attempt + 1)
            await this.sleep(delay)
        }
    }
    if (opts.fallback) {                                        // L5 降级
        const fallbackValue = await opts.fallback()
        this.emit('llm:fallback', { agent: opts.agent, task: opts.task, error: lastError?.message })
        return fallbackValue as T
    }
    throw lastError ?? new LLMError('L5', 'unknown', '所有重试失败且无降级方案', false)
}
```

**错误分类规则**（`classifyError`）：基于 OpenAI SDK 错误类名映射，`APIConnectionError`/`APIConnectionTimeoutError` → network；`RateLimitError` → rate-limit；`InternalServerError` → server；`BadRequestError`/`AuthenticationError`/`PermissionDeniedError`/`NotFoundError` 等 → param；`AbortError`（用户中断）→ network 且不可重试；已是 `LLMError` 实例则透传。

**降级内容表**：按 `domain:function` 预定义，所有降级返回必须明确标注"AI 生成（降级模式）"，避免用户误以为是正常输出。降级结果在 `AgentResult` 中通过 `warnings: ['本次输出为降级模式，质量可能受限']` 字段传递给前端。

---

## 五、自我进化引擎

### 5.1 进化闭环

自我进化引擎（`EvolutionEngine`，定义于 `backend/src/evolution/evolution-engine.ts`）是本系统的核心创新，实现 Prompt 的持续自动优化。完整进化闭环：

```
触发 → Curator 分析 → 战略记忆入库（SCOPE） → Prompt 候选版本 → A/B 测试 → 改进量奖励 → 决策
                                                                                      │
                                              ┌───────────────────────────────────────┤
                                              ▼                                       ▼
                                         promote（晋升）                        rollback（回滚）/ iterate（迭代）
```

**触发条件**（严格阈值控制）：

| 阶段 | 触发条件 | 动作 |
| --- | --- | --- |
| 战术记忆累积 | 同类战术记忆 ≥ 5 条 | 触发 Curator 提取战略记忆 |
| 战略记忆置信度 | Curator 置信度 ≥ 0.7 | 创建 Prompt 候选版本 |
| 候选版本创建 | — | 启动 A/B 测试 |
| A/B 测试样本量 | ≥ 30 | 计算改进量奖励 |
| 奖励 r ≥ 5 且 p < 0.05 | — | 晋升为新活跃版本 |
| 奖励 r < 0 且 p < 0.05 | — | 回滚到旧版本 |

### 5.2 SCOPE 范式：战略记忆操作

战略记忆入库遵循 SCOPE 范式，三种操作：

| 操作 | 语义 | 触发条件 |
| --- | --- | --- |
| Supersede（覆盖） | 新原则取代旧原则 | 新原则与旧原则冲突且置信度更高 |
| Conflict-resolution（冲突解决） | 标记冲突并选择更优者 | 新旧原则部分冲突 |
| Subset-pruning（子集修剪） | 拒绝入库（新原则是旧原则的子集） | 新原则被旧原则包含 |
| Merge（合并） | 合并新旧原则 | 新旧原则互补 |

`strategicMemoryStore.createWithSCOPE()` 在入库前自动检测与已有战略记忆的关系，执行对应操作并返回 `scopeResult`（含 `executed` / `affectedIds` / `resultId`）。子集修剪时不入库，直接终止当次进化周期。

### 5.3 ACE Framework：Prompt 增量更新

战略记忆应用到 Prompt 时遵循 ACE Framework 的 delta 增量更新策略——在原 Prompt 末尾追加战略原则约束，而非整体重写：

```typescript
private applyStrategicToPrompt(originalPrompt: string, strategic: StrategicMemory): string {
    const constraint = [
        '',
        '<!-- SCOPE 战略记忆约束（自动追加，勿手动编辑） -->',
        `<strategic_principle confidence="${strategic.confidence.toFixed(2)}" operation="${strategic.operation}">`,
        `  ${strategic.principle}`,
        `</strategic_principle>`,
        '',
    ].join('\n')
    return originalPrompt + constraint
}
```

版本号变更遵循语义化版本：主版本（major）/ 次版本（minor）/ 补丁（patch），由 `curatorAnalysis.versionImpact` 字段决定。

### 5.4 战术记忆与战略记忆

| 维度 | 战术记忆（TacticalMemory） | 战略记忆（StrategicMemory） |
| --- | --- | --- |
| TTL | 7 天 | 无 TTL（永久） |
| 粒度 | 单次事件级（before/after snippet） | 抽象原则级（principle） |
| 来源 | 教师反馈 / 验收驳回 / A/B 测试败方 / 错误恢复 / 自动检测 | Curator 从 ≥5 条同类战术记忆中提取 |
| 用途 | 进化闭环输入 | Prompt 版本变更依据 |

战术记忆的五种触发场景（`source` 字段）：`teacher-feedback` / `verifier-reject` / `ab-test-loser` / `error-recovery` / `auto-detected`。`recordTacticalMemory()` 是进化引擎的主入口，记录后自动检查阈值并触发进化周期。

### 5.5 A/B 测试与奖励信号

A/B 测试由 `abTestFramework` 管理，变体 A 为当前活跃版本，变体 B 为候选版本。样本通过 `assignVariant(sessionId)` 按 session 哈希均匀分流。

**奖励信号来源**（`RewardSignalSource`）：教师显式反馈、验收通过率、批改准确率、学生参与度等。每次 Agent 调用后业务层调用 `recordRewardSample()` 记录样本，达到样本量阈值时自动触发 `evaluateABTest()`。

**奖励计算**（`rewardCalculator.calculate()`）：对比 A/B 两组的均值奖励，输出改进量 `improvement`、p 值（统计显著性）、效应量（effect size）、决策建议（`promote` / `rollback` / `iterate`）。决策依据：`r ≥ 5 且 p < 0.05` → promote；`r < 0 且 p < 0.05` → rollback；其余 → iterate（继续收集样本）。

### 5.6 可解释性与审计

所有进化操作记录为 `EvolutionEvent`，内存存储最近 200 条（`MAX_EVENTS`）。事件类型涵盖 `tactical-created` / `strategic-extracted` / `strategic-merged` / `strategic-conflict` / `strategic-pruned` / `prompt-draft-created` / `prompt-released` / `prompt-rolled-back` / `ab-test-started` / `ab-test-completed` / `reward-calculated` / `evolution-cycle` / `tactical-expired`。`getDashboardStats()` 提供仪表盘统计，前端进化引擎页面可视化展示完整时间轴。

---

## 六、知识图谱与认知暗物质检测

### 6.1 Neo4j Schema

知识图谱服务（`KnowledgeGraphService`，定义于 `backend/src/services/knowledge-graph/knowledge-graph-service.ts`）基于 Neo4j 5.x，存储 148 首收录诗集的诗人、诗作、意象、主题、修辞关系网络。148 是运行时收录量，包含教材候选与拓展篇目；只有在逐首登记 `TEXTBOOK_CORE / EXTENDED` 并完成双信源和语文教师验收后，才可统计教材核心覆盖率。

**6 种节点类型**：

| Label | 主键 | 用途 |
| --- | --- | --- |
| `Poet` | `id` | 诗人（姓名、朝代、生卒年、风格、简介） |
| `Poem` | `id` | 古诗（标题、原文、难度、年级、教材版本） |
| `Image` | `name` | 意象（名称、文化含义） |
| `Theme` | `name` | 主题（名称） |
| `Era` | `name` | 朝代（名称、起止年） |
| `Rhetoric` | `name` | 修辞（名称、描述） |

**10 种边类型**：

| 边类型 | 方向 | 语义 | 权重属性 |
| --- | --- | --- | --- |
| `WROTE` | Poet → Poem | 创作 | — |
| `OF_ERA` | Poem → Era | 属于朝代 | — |
| `USES_IMAGE` | Poem → Image | 使用意象 | — |
| `EXPRESSES_THEME` | Poem → Theme | 表达主题 | — |
| `USES_RHETORIC` | Poem → Rhetoric | 使用修辞 | — |
| `MENTORS` | Poet → Poet | 师承 | `note` |
| `CONTEMPORARY` | Poet → Poet | 同时代 | 自动推导（生卒年重叠） |
| `SHARES_IMAGE` | Poem → Poem | 共享意象 | `count`、`images` |
| `SIMILAR_THEME` | Poem → Poem | 主题相似 | `score`（Jaccard）、`themes` |
| `BORROWS_RHETORIC` | Poem → Poem | 共享修辞 | `count`、`rhetoric` |

**诗与诗的关联自动推导**：`SIMILAR_THEME` 边基于 Jaccard 相似度计算——`sharedCount / (t1Count + t2Count - sharedCount)`，仅保留相似度 > 0 的边对。

### 6.2 种子数据幂等导入

`seedIfEmpty()` 启动时检查 `Poem` 节点数量，为空时按顺序导入：朝代 → 诗人 → 古诗+6 种直接关系 → 师承 → 同时代（自动推导）→ 诗与诗关联（自动推导）。所有写操作使用 `MERGE` 保证幂等。

### 6.3 八个公开查询方法

| 方法 | Cypher 核心模式 | 用途 |
| --- | --- | --- |
| `findRelatedPoems` | `MATCH (p)-[r:SHARES_IMAGE\|SIMILAR_THEME\|BORROWS_RHETORIC]-(related)` | 按诗找关联 |
| `findPoemsByTheme` | `MATCH (poem)-[:EXPRESSES_THEME]->(t {name})` | 按主题找诗 |
| `findPoemsByImage` | `MATCH (poem)-[:USES_IMAGE]->(i {name})` | 按意象找诗 |
| `findPoemsByRhetoric` | `MATCH (poem)-[:USES_RHETORIC]->(r {name})` | 按修辞找诗 |
| `findPoemsByPoet` | `MATCH (:Poet {name})-[:WROTE]->(poem)` | 按诗人找诗 |
| `getPoetMentorChain` | `MATCH (mentee)-[:MENTORS*1..5]->(mentor)` | 师承链（递归 5 跳） |
| `getFullGraph` | `MATCH (n) WHERE n:Poet OR ... LIMIT 500` | 全图谱（D3.js 渲染） |
| `getPoemSubgraph` | `MATCH path = (center)-[*1..3]-(neighbor)` | 诗的邻居子图 |

### 6.4 掌握度着色与认知暗物质检测

`getGraphWithMastery(studentId)` 将 Neo4j 全图谱与 SQLite `mastery` 表联动，按学生六阶掌握度为 Poem 节点着色：

| 颜色 | 判定条件 | 语义 |
| --- | --- | --- |
| green | 六阶皆 ≥ 80 | 已掌握 |
| yellow | 记忆层 ≥ 60 但任一高阶层 < 80 | 高阶薄弱 |
| red | 记忆层 < 60 | 记忆层卡顿 |

**认知暗物质**（`DarkMatterEntry`）由 `mind.diagnose` Agent 检测，定义于 `backend/src/agents/base/types.ts`：

```typescript
export interface DarkMatterEntry {
    poemId: string
    bloomLevel: BloomLevel
    pattern: string         // 错误模式描述，如"反复将'拟人'误判为'比喻'"
    severity: 'low' | 'medium' | 'high'
    rootCause: string       // 根因分析
    prescription: string    // 靶向处方
}
```

认知暗物质是"学生反复犯但自身未察觉的隐性知识盲区"，通过事件溯源架构累积的作答、朗读、自学事件，由 `mind.diagnose` Agent 调用 deepseek-v4-pro + max 思考模式进行深度推理识别，输出 `DiagnosisResult`（含 `darkMatter` / `knowledgeGaps` / `bloomImbalance` 三类诊断）。

### 6.5 优雅降级

Neo4j 不可用时，`init()` 捕获 `verifyConnectivity` 失败并标记 `connected = false`，所有查询通过 `safeRead()` 返回空数组/空图，不抛错。`isConnectionError()` 检测连接类错误（connection / econnrefused / timeout / broken pipe / session expired）后自动切换降级模式，确保系统在 Neo4j 故障时仍可运行（仅图谱功能不可用）。

---

## 七、学情数据库设计

### 7.1 数据库架构

学情数据库基于 SQLite（better-sqlite3），定义于 `backend/src/db/index.ts`。启用 WAL 模式提升并发读性能，`synchronous = NORMAL`（WAL 模式推荐值），`foreign_keys = ON`。Schema 内嵌为 `EMBEDDED_SCHEMA` 常量（防云同步清空 schema.sql），同时兼容外部 schema.sql 文件覆盖。

### 7.2 ER 关系（11 张核心表 + 3 张集市表 + 2 视图）

```
classes (1) ─────────< students (N)
   │                      │
   │                      │ ──< answers >── questions (N)
   │                      │        │            │
   │                      │        │            │
   │                      │ ──< mastery >── poems (N)
   │                      │        │            │
   │                      │ ──< events         │
   │                      │        │            │
   │                      │ ──< recitations ───┘
   │                      │
   └──< lessons (N) >─────┘
            │
            └── poems

evolution_memory（独立）   prompt_versions（独立）

marketplace_resources ──< marketplace_fork_records
                     └──< marketplace_feedback

视图：v_class_poem_mastery / v_student_bloom_radar
```

### 7.3 核心表说明

| 表 | 主键 | 核心字段 | 用途 |
| --- | --- | --- | --- |
| `classes` | id | name, grade, teacher_id, student_count | 班级 |
| `students` | id | class_id(FK), name, anonymous_name, cognitive_style, engagement_score | 学生（含匿名名） |
| `poems` | id | title, poet, dynasty, content, theme(JSON), images(JSON), rhetoric(JSON), difficulty | 古诗元数据 |
| `lessons` | id | class_id(FK), poem_id(FK), status, mode | 课程 |
| `questions` | id | poem_id(FK), bloom_level, type, stem, answer, ai_generated, prompt_version | 题目（含 AI 生成标记） |
| `answers` | id | student_id(FK), question_id(FK), correct, partial_score, cognitive_attribution, needs_human_review | 作答（含认知归因） |
| `mastery` | id | student_id, poem_id, bloom_level, score, attempts, correct_count, `UNIQUE(student_id, poem_id, bloom_level)` | 六阶掌握度（核心） |
| `events` | id | student_id, class_id, type, action, payload, occurred_at, recorded_at | 事件溯源 |
| `recitations` | id | student_id, poem_id, transcript, pronunciation_score, rhythm_score, emotion_score | 朗读评测 |
| `evolution_memory` | id | type, agent_id, pattern, before_prompt, after_prompt, improvement_reward | 进化引擎记忆 |
| `prompt_versions` | id | agent_id, version, system_prompt, is_active, `UNIQUE(agent_id, version)` | Prompt 版本 |

### 7.4 事件溯源架构

`events` 表实现事件溯源：所有学习行为（答题、朗读、自学、复习）以不可变事件形式追加写入，包含 `occurred_at`（实际发生时间）与 `recorded_at`（入库时间）双时间戳。当前状态（如 `mastery` 表）由事件重放推导，支持时间旅行查询与状态重建。

`EventService` 封装事件写入与查询，`MasteryService` 基于事件流计算六阶掌握度。事件类型字段 `type` 与动作字段 `action` 分离，便于按类型聚合统计。

### 7.5 两个聚合视图

| 视图 | 聚合维度 | 输出 |
| --- | --- | --- |
| `v_class_poem_mastery` | 班级 × 古诗 × 阶 | `avg_score`、`student_count`、`mastered_count`（score ≥ 60） |
| `v_student_bloom_radar` | 学生 × 阶 | `avg_score`、`last_updated`（雷达图数据源） |

### 7.6 仓储层与服务层单例

`db/index.ts` 在 schema 初始化后实例化所有 Repository（14 个）与 Service（2 个）单例，统一通过 `repos` / `services` / `utils` 三个命名导出访问：

```typescript
export const repos = {
    classes: new ClassRepository(db),
    students: new StudentRepository(db),
    poems: new PoemRepository(db),
    // ... 共 14 个仓储
} as const

export const services = {
    mastery: new MasteryService({ db, masteryRepo: repos.mastery, ... }),
    event: new EventService({ eventRepo: repos.events }),
} as const
```

`getDbStatus()` 提供健康检查（连接状态、路径、schema 初始化状态、表数量），供 `/health` 端点使用。

---

## 八、WebSocket 实时协作推送

### 8.1 设计目标

多智能体协作过程对教师是不可见的黑盒。WebSocket 实时推送将编排官的调度决策、Agent 调用状态、LLM 调用计费等信息实时推送至前端观测台，实现"过程透明化"。

### 8.2 WSBroadcaster 架构

`WSBroadcaster`（定义于 `backend/src/orchestrator/websocket/broadcaster.ts`）管理前端观测台的 WebSocket 连接，按订阅过滤器分发事件。核心设计：

| 设计点 | 实现 |
| --- | --- |
| 订阅过滤 | 每个连接携带 `WSSubscriptionFilter`（sessionId / agentIds / eventTypes） |
| 精准分发 | `broadcast` 时按过滤器决定是否推送，避免无关事件淹没客户端 |
| 自动清理 | 客户端异常断开自动从 `connections` 集合移除，防内存泄漏 |
| 容错发送 | 发送失败仅记录日志不抛出，避免一个客户端拖垮全局 |

### 8.3 事件类型与过滤匹配

`matchFilter` 的三层匹配规则：

```typescript
private matchFilter(event: WSEvent, filter: WSSubscriptionFilter): boolean {
    // 1. eventTypes 过滤：事件 type 必须在过滤器列表中（空则全部通过）
    if (filter.eventTypes?.length && !filter.eventTypes.includes(event.type)) return false
    // 2. sessionId 过滤：全局事件（sessionId 为空）总是通过
    if (filter.sessionId && event.sessionId !== '' && event.sessionId !== filter.sessionId) return false
    // 3. agentIds 过滤：检查 payload.agentId
    if (filter.agentIds?.length) {
        const payload = event.payload as { agentId?: string } | null
        if (payload?.agentId && !filter.agentIds.includes(payload.agentId)) return false
    }
    return true
}
```

事件类型覆盖三大类：
- `orch:*`（编排官）：`INSTRUCTION_PARSED` / `TASK_START` / `TASK_DONE` / `TASK_FAILED` / `TASK_PAUSED` / `SESSION_END` / `REFLECTION`
- `agent:*`（智能体）：`CALL_START` / `CALL_SUCCESS` / `CALL_ERROR` / `FALLBACK`
- `llm:*`（LLM 调用）：`call:start` / `call:success` / `call:error` / `stream:delta`

### 8.4 客户端动态订阅

客户端可通过 `orch:subscribe` 消息动态调整订阅过滤器（`updateFilter`），实现"只看某个 session"或"只看某些 Agent"的精细化观测。`closeAll()` 用于服务优雅关闭时统一断开所有连接。

---

## 九、前端架构

### 9.1 技术栈

| 类别 | 选型 | 版本 | 用途 |
| --- | --- | --- | --- |
| 框架 | React | 18.3 | UI 基座 |
| 语言 | TypeScript | 5.6 strict | 类型安全（零 any，启用 noUncheckedIndexedAccess） |
| 构建 | Vite | 5.4 | 开发服务器 + 打包 |
| 样式 | Tailwind CSS | 3.4 | 原子化 CSS |
| 路由 | react-router-dom | 6.26 | 声明式路由 |
| 状态 | Zustand | 4.5 | 轻量全局状态 |
| 数据 | @tanstack/react-query | 5.59 | 服务端状态缓存 |
| 可视化 | D3.js | 7.9 | 力导向图谱渲染 |
| 图标 | @phosphor-icons/react | 2.1 | 统一图标集（零 emoji） |
| Markdown | react-markdown + remark-gfm + rehype-highlight | 9.1 / 4.0 / 7.0 | 排文级 Markdown 渲染 |

### 9.2 路由与懒加载

`App.tsx` 采用路由级代码分割，创新功能模块（Task 15-22）通过 `lazy()` 动态导入，降低首屏 JS 体积：

```typescript
const SelfStudyPage = lazy(() =>
    import('@/pages/SelfStudyPage/SelfStudyPage').then((m) => ({ default: m.SelfStudyPage })),
)
const DiagnosisPage = lazy(() => import('@/pages/DiagnosisPage/DiagnosisPage'))
const ObservatoryPage = lazy(() =>
    import('@/pages/ObservatoryPage/ObservatoryPage').then((m) => ({ default: m.ObservatoryPage })),
)
// ... 共 8 个懒加载页面
```

懒加载页面统一通过 `<Suspense fallback={<PageFallback />}>` 包裹，fallback 显示加载占位。导航分七组：教学核心、备课授课、AI 协作、学生端、文化沉淀、教研沉淀、开发演示。

### 9.3 状态管理

采用 Zustand 进行轻量全局状态管理，按领域拆分 store：

- `useUiStore`：侧边栏折叠态（`sidebarCollapsed`），持久化至 localStorage
- `useToast`：通知队列（toast.success / info / warning / error）
- 业务 store：按页面职责划分

服务端状态（API 数据）通过 @tanstack/react-query 管理，自动缓存与重验证。

### 9.4 AppShell 流体布局

`AppShell`（定义于 `frontend/src/components/layout/AppShell.tsx`）实现规范第 8、5.4 章的流体布局外壳：

- 桌面：左侧 sidebar（`22vw`，clamp 220-280px）+ 右侧主内容区
- 移动端（<768px）：sidebar 折叠为 56px 图标条
- 主内容区：`max-width` 用 `--content-max-width` 流体 token 居中
- 路由切换过渡：入场 350ms ease-out（opacity 0→1 + scale 0.98→1 + translateY 8→0），通过 `key={location.pathname}` 触发
- 顶部 header：`scrollY > 48px` 时切换为 `surface-glass`（backdrop-blur 12px）+ 200ms 过渡

```typescript
// 监听主内容滚动，48px 后切换 header 玻璃态
useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 48)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
}, [])
```

### 9.5 设计令牌与流体布局

遵循项目界面设计规范，CSS 自定义属性驱动设计令牌体系：

- **色彩**：透明度驱动暖调色板（`surface-primary` `#FAF8F5` 至 `surface-glass-heavy`），禁止纯黑纯白，所有灰色微偏暖色
- **间距**：4px 基准网格，`clamp()` 流体插值（如 `--space-md: clamp(12px, 0.75rem + 0.29vw, 16px)`）
- **字号**：流体字阶（如 `--text-base: clamp(14px, 0.875rem + 0.14vw, 16px)`）
- **无边框设计**：区域分隔优先透明度差异 + backdrop-blur，仅 hover 微边框（alpha 8%）与焦点环（alpha 12%）
- **动效**：标准缓动曲线（ease-out `cubic-bezier(0.16, 1, 0.3, 1)`），仅 transform/opacity 动画

### 9.6 关键页面

| 页面 | 路由 | 核心能力 |
| --- | --- | --- |
| 教学驾驶舱 | `/dashboard` | 班级/学生/课程概览 |
| 诗脉星图 | `/starmap` | D3.js 力导向图谱渲染 + 掌握度着色 |
| 认知诊断中心 | `/diagnosis` | 认知暗物质可视化 + 靶向处方 |
| 命题工坊 | `/workbench` | 六阶命题 + 布鲁姆权重调节 |
| 诗音阁 | `/recitation` | ASR 朗读评测 + TTS 范读对比 |
| 创造工坊 | `/creation` | 创意素材生成（配图/剧本/动画脚本） |

---

## 十、本地开发指南

### 10.1 环境准备

| 依赖 | 版本要求 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 20.x（推荐 20.18 LTS） | 后端使用 ESM + 原生 fetch |
| npm | ≥ 10.x | 依赖管理 |
| Neo4j | 5.x（可选） | 知识图谱服务，未启动时自动降级 |
| SQLite | 内嵌（better-sqlite3 预编译） | 无需单独安装 |

### 10.2 环境变量配置

在 `backend/` 目录创建 `.env` 文件（参考 `.env.example`）：

```bash
# 服务端口
PORT=3000

# DeepSeek API（base_url: https://api.deepseek.com）
DEEPSEEK_API_KEY=sk-your-deepseek-key

# MiMo API（base_url: https://api.xiaomimimo.com/v1）
MIMO_API_KEY=your-mimo-key

# SQLite 路径（留空则使用默认 ./data/poetic-realm.db）
SQLITE_PATH=

# Neo4j 连接（可选，未启动时知识图谱降级）
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=your-password

# 日志级别
LOG_LEVEL=info
```

> 安全提示：`.env` 文件已加入 `.gitignore`，禁止提交到版本库。API Key 属于敏感凭据，切勿在日志或前端代码中暴露。

### 10.3 启动开发环境

**后端**（`backend/` 目录）：

```bash
corepack enable
pnpm install --frozen-lockfile  # 严格按锁文件安装依赖
pnpm run dev           # 启动开发服务器（nodemon + tsx 热重载）
```

开发服务器默认监听 `http://localhost:3000`，`tsx` 提供 TypeScript 原生执行能力，`nodemon` 监听文件变更自动重启。

**前端**（`frontend/` 目录）：

```bash
pnpm install --frozen-lockfile  # 严格按锁文件安装依赖
pnpm run dev           # 启动 Vite 开发服务器
```

Vite 开发服务器默认监听 `http://localhost:5173`，已配置代理转发 API 请求至后端。

**Neo4j（可选）**：

```bash
# 使用 Docker 快速启动
docker run -d --name neo4j -p 7474:7474 -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/your-password \
  neo4j:5
```

未启动 Neo4j 时，知识图谱服务自动降级（所有查询返回空结果），不影响其他功能。

### 10.4 调试

**后端调试**：
- 日志基于 Pino（生产）+ pino-pretty（开发可读格式）
- `getDbStatus()` 提供 SQLite 健康检查，访问 `/health` 端点
- 编排官 `activeExecutionCount` 属性可用于诊断活跃会话数
- LLM 调用事件通过 `LLMRouter` 的 EventEmitter 推送，可临时挂载监听器调试

**前端调试**：
- Vite HMR 热模块替换
- React DevTools + Zustand DevTools
- WebSocket 连接状态通过浏览器开发者工具 Network 面板查看

**类型检查**：

```bash
cd backend && pnpm run lint    # tsc --noEmit
cd frontend && pnpm run lint   # tsc --noEmit
```

### 10.5 构建与生产部署

```bash
# 后端构建
cd backend && pnpm run build     # tsc -p tsconfig.json → dist/
pnpm start                       # node dist/server.js

# 前端构建
cd frontend && pnpm run build    # tsc -b && vite build → dist/
pnpm run preview                 # 本地预览构建产物
```

### 10.6 测试

项目通过 `tsc --noEmit` 进行静态类型检查作为基础测试门禁。建议为新功能补充以下层面的测试：

- **Agent 单测**：mock `router.execute`，验证 `buildSystemPrompt` / `validateOutput` 行为
- **DAG 调度器单测**：覆盖拓扑排序、环检测、条件分支、失败传播
- **错误恢复单测**：模拟各类 OpenAI SDK 错误，验证 L1-L5 分发
- **进化引擎单测**：验证阈值触发、SCOPE 操作、A/B 测试决策

---

## 十一、贡献指南

### 11.1 代码规范

**TypeScript 严格模式**：全项目启用 `strict`、`noUncheckedIndexedAccess`、`strictNullChecks`。零 `any`，所有类型显式标注。Record 访问返回 `T | undefined`，可选字段显式 `?`。

**ESM 规范**：后端 `"type": "module"`，所有相对导入必须带 `.js` 后缀（即使源文件是 `.ts`）。例如 `import { router } from '../../llm/index.js'`。

**AI 生成内容标记**：所有 Agent 输出必须携带 `aiGenerated: true` 元数据，降级输出额外携带 `warnings` 字段。这是数据治理与审计的硬性要求。

**零 emoji 原则**：界面任何位置不得出现 emoji，所有图形语义由 Phosphor Icons SVG 承担。

**注释规范**：公共 API 与复杂逻辑必须附 JSDoc 注释，说明"做什么"与"为什么"。文件顶部附模块说明注释（职责、设计要点、关键工程）。

### 11.2 提交规范

采用 Conventional Commits 规范，提交信息格式 `<type>(<scope>): <subject>`：

| type | 语义 |
| --- | --- |
| `feat` | 新功能 |
| `fix` | Bug 修复 |
| `refactor` | 重构（无功能变化） |
| `perf` | 性能优化 |
| `docs` | 文档 |
| `test` | 测试 |
| `chore` | 构建/工具/依赖 |

scope 示例：`agent` / `orchestrator` / `llm` / `kg` / `db` / `evolution` / `frontend` / `ws`。

示例：`feat(orchestrator): 支持条件分支谓词评估` / `fix(llm): 修复 429 限流时未尊重 Retry-After`。

### 11.3 分支策略

| 分支 | 用途 | 命名 |
| --- | --- | --- |
| `main` | 生产稳定分支，保护分支 | — |
| `develop` | 集成分支 | — |
| `feature/*` | 功能开发 | `feature/evolution-engine` |
| `fix/*` | Bug 修复 | `fix/dag-cycle-detection` |
| `hotfix/*` | 紧急修复（直合 main） | `hotfix/llm-fallback` |

**提交前自检清单**：
- `pnpm run lint` 通过（前后端均需）
- 新增 Agent 必须在 `AGENT_CAPABILITIES` 注册，否则编排官无法调度
- 新增 LLM 路由必须在 `ROUTE_MATRIX` 覆盖，否则 `resolve()` 抛错
- 新增数据库表必须同步更新 `EMBEDDED_SCHEMA` 与仓储层单例
- 涉及 AI 生成的功能必须携带 `aiGenerated: true` 标记
- 界面变更须符合界面设计规范（透明度暖调、无边框、流体布局、零 emoji）

### 11.4 新增 Agent 检查清单

新增一个子 Agent 需完成以下全部步骤：

1. 在 `backend/src/agents/<domain>/` 创建 Agent 类，继承 `BaseAgent`
2. 实现五个抽象成员：`id` / `name` / `domain` / `fn` / `bloomLevel` / `promptVersion`
3. 实现三个抽象方法：`buildSystemPrompt` / `buildUserPrompt` / `validateOutput`
4. 在 `Orchestrator.AGENT_CAPABILITIES` 注册能力描述（id / name / description / inputHint）
5. 在 `LLMRouter.ROUTE_MATRIX` 添加 `${domain}:${fn}` 路由条目
6. 在 `ErrorRecovery` 的 `FALLBACK_CONTENT` 添加降级内容
7. 在 `flattenAgents()` 中注册到对应主 Agent 分组
8. 补充 zod schema 用于 `validateOutput` 校验

---

## 附录：关键文件索引

| 模块 | 文件路径 |
| --- | --- |
| Agent 基类 | `backend/src/agents/base/Agent.ts` |
| Agent 类型 | `backend/src/agents/base/types.ts` |
| LLM 路由器 | `backend/src/llm/router.ts` |
| 错误恢复 | `backend/src/llm/error-recovery.ts` |
| 编排官 | `backend/src/orchestrator/Orchestrator.ts` |
| DAG 调度器 | `backend/src/orchestrator/dag-scheduler.ts` |
| WebSocket 广播器 | `backend/src/orchestrator/websocket/broadcaster.ts` |
| 进化引擎 | `backend/src/evolution/evolution-engine.ts` |
| 知识图谱服务 | `backend/src/services/knowledge-graph/knowledge-graph-service.ts` |
| 数据库初始化 | `backend/src/db/index.ts` |
| 前端路由 | `frontend/src/App.tsx` |
| 布局 Shell | `frontend/src/components/layout/AppShell.tsx` |

---

*本文档随系统迭代持续更新，任何架构变更须同步修订对应章节。*
