/**
 * Prompt 工程通用模板与工具函数
 *
 * 本文件提供 Prompt 构建的标准工具，遵循 Anthropic 推荐的
 * XML 标签上下文注入法，确保 LLM 能精确区分指令与数据。
 *
 * 核心工具：
 * - withXmlTags      — 用 XML 标签包裹上下文（结构化注入）
 * - withExamples     — Few-shot 示例注入
 * - withConstraint   — 约束声明（编号规则列表）
 * - withAiGeneratedMark — 输出末尾 AI 生成标记
 * - safeJsonParse    — 安全 JSON 解析（兼容 ```json 代码块包裹）
 * - buildContextBlock — 构建标准上下文注入块
 */

// ─────────────────────────────────────────────────────────────
// XML 标签注入
// ─────────────────────────────────────────────────────────────

/**
 * 用 XML 标签包裹内容
 *
 * Anthropic 推荐做法：用 <tag>...</tag> 包裹上下文数据，
 * 帮助 LLM 区分指令与数据，减少指令注入风险。
 *
 * @example
 * withXmlTags('李白，唐代', 'poet_info')
 * // => '<poet_info>\n李白，唐代\n</poet_info>'
 */
export function withXmlTags(content: string, tag: string): string {
    return `<${tag}>\n${content}\n</${tag}>`
}

// ─────────────────────────────────────────────────────────────
// Few-shot 示例
// ─────────────────────────────────────────────────────────────

/**
 * 构建 Few-shot 示例块
 *
 * 将多个输入-输出示例用 XML 标签包裹，供模型参考。
 * 若示例数组为空则返回空字符串。
 */
export function withExamples(examples: Array<{ input: string; output: string }>): string {
    if (examples.length === 0) return ''
    const blocks = examples
        .map((ex, i) => `【示例 ${i + 1}】\n输入：${ex.input}\n输出：${ex.output}`)
        .join('\n\n')
    return withXmlTags(blocks, 'few_shot_examples')
}

// ─────────────────────────────────────────────────────────────
// 约束声明
// ─────────────────────────────────────────────────────────────

/**
 * 构建编号约束列表
 *
 * 将规则数组转为编号列表并用 XML 标签包裹。
 * 用于明确声明输出格式、内容限制等硬性约束。
 */
export function withConstraint(rules: string[]): string {
    if (rules.length === 0) return ''
    const numbered = rules.map((r, i) => `${i + 1}. ${r}`).join('\n')
    return withXmlTags(numbered, 'constraints')
}

// ─────────────────────────────────────────────────────────────
// AI 生成标记
// ─────────────────────────────────────────────────────────────

/**
 * 生成 AI 内容标记
 *
 * 所有 AI 生成内容末尾应附带此标记，便于前端识别与标注。
 * 标记为 HTML 注释，不影响 Markdown 渲染。
 */
export function withAiGeneratedMark(): string {
    return '\n\n<!-- AI生成 -->'
}

// ─────────────────────────────────────────────────────────────
// 标准上下文注入块
// ─────────────────────────────────────────────────────────────

/**
 * 构建标准上下文注入块
 *
 * 将多个命名上下文段组装为结构化的 XML 块，
 * 每个 entry 为 { tag, content } 对。
 */
export function buildContextBlock(entries: Array<{ tag: string; content: string }>): string {
    const blocks = entries
        .filter((e) => e.content.trim().length > 0)
        .map((e) => withXmlTags(e.content, e.tag))
    return blocks.join('\n\n')
}

// ─────────────────────────────────────────────────────────────
// 安全 JSON 解析
// ─────────────────────────────────────────────────────────────

/**
 * 安全 JSON 解析
 *
 * LLM 输出的 JSON 可能被 ```json ``` 代码块包裹，或前后含解释文字。
 * 本函数按以下顺序尝试解析：
 * 1. 直接 JSON.parse（最理想情况）
 * 2. 提取 ```json ... ``` 代码块内容
 * 3. 提取第一个 { 到最后一个 } 之间的子串
 *
 * 全部失败则抛出明确错误，供 errorRecovery 处理。
 */
export function safeJsonParse(raw: string): unknown {
    const trimmed = raw.trim()

    // 策略 1：直接解析
    try {
        return JSON.parse(trimmed)
    } catch {
        // 继续尝试其他策略
    }

    // 策略 2：提取 ```json ... ``` 代码块
    const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (codeBlockMatch && codeBlockMatch[1]) {
        try {
            return JSON.parse(codeBlockMatch[1].trim())
        } catch {
            // 继续尝试策略 3
        }
    }

    // 策略 3：提取首尾大括号
    const firstBrace = trimmed.indexOf('{')
    const lastBrace = trimmed.lastIndexOf('}')
    if (firstBrace !== -1 && lastBrace > firstBrace) {
        const slice = trimmed.slice(firstBrace, lastBrace + 1)
        try {
            return JSON.parse(slice)
        } catch {
            // 全部失败
        }
    }

    throw new Error(
        `LLM 输出非合法 JSON，无法解析。输出前 200 字符：${trimmed.slice(0, 200)}`,
    )
}

// ─────────────────────────────────────────────────────────────
// Prompt 通用头部
// ─────────────────────────────────────────────────────────────

/**
 * 通用 Prompt 头部约束
 *
 * 所有结构化输出 Agent 共享的输出约束，确保：
 * - 严格 JSON 输出
 * - 文化准确
 * - 教育适宜
 * - 标注 AI 生成
 */
export const COMMON_OUTPUT_CONSTRAINTS: string[] = [
    '必须输出合法 JSON，不包含任何解释文字、Markdown 标记或代码块包裹',
    '所有事实性内容（典故、字义、时代背景、作者信息）必须准确无误',
    '内容必须适合中国小学语文教学场景，符合统编版教材要求',
    '若涉及文化敏感内容，必须保持中立、尊重的表述',
    '输出对象必须包含 "aiGenerated": true 字段',
]

// ─────────────────────────────────────────────────────────────
// 标准化上下文标签（SubTask 8.1.1）
// ─────────────────────────────────────────────────────────────

/**
 * 标准化上下文 XML 标签常量
 *
 * 所有子 Agent 在 buildUserPrompt 中应使用这些标准标签，
 * 保证 LLM 能稳定识别上下文结构，降低指令注入风险。
 */
export const STANDARD_CONTEXT_TAGS = {
    POET_INFO: 'poet_info',
    POEM_CONTENT: 'poem_content',
    STUDENT_PROFILE: 'student_profile',
    CLASS_CONTEXT: 'class_context',
    TASK_INSTRUCTION: 'task_instruction',
    OUTPUT_FORMAT: 'output_format',
    KNOWLEDGE_GRAPH: 'knowledge_graph',
    HISTORY_SUMMARY: 'history_summary',
    DIAGNOSIS_RESULT: 'diagnosis_result',
    FEEDBACK: 'feedback',
    VERIFIER_ISSUES: 'verifier_issues',
} as const

export type StandardContextTag = (typeof STANDARD_CONTEXT_TAGS)[keyof typeof STANDARD_CONTEXT_TAGS]

/**
 * 构建标准上下文条目
 *
 * 便捷封装：将单个标准标签 + 内容组装为 { tag, content } 对，
 * 供 buildContextBlock 使用。空内容自动跳过。
 */
export function standardEntry(
    tag: StandardContextTag,
    content: unknown,
): { tag: string; content: string } {
    const text = typeof content === 'string'
        ? content
        : (content === undefined || content === null ? '' : JSON.stringify(content, null, 2))
    return { tag, content: text }
}

// ─────────────────────────────────────────────────────────────
// Few-shot 示例库（SubTask 8.2.3）
// ─────────────────────────────────────────────────────────────

/**
 * 各子 Agent 的高质量 Few-shot 示例库
 *
 * 每个示例为 { input, output } 对，output 为合法 JSON 字符串。
 * 调用 withExamples() 注入 <few_shot_examples> 块。
 *
 * 设计原则：
 * - 每类任务 2-3 个示例，覆盖典型场景
 * - 示例 output 严格符合 zod schema，可被 safeJsonParse 解析
 * - 示例体现预期输出格式、字段完整性、文化准确性
 */
export const FEWSHOT_EXAMPLES: Record<string, Array<{ input: string; output: string }>> = {
    // ── 诗心·学情画像 ──
    'mind.profile': [
        {
            input: '学生 S001，3 年级，5 条学习事件（答对《静夜思》背诵、答错《咏柳》修辞手法、朗读《春晓》得分 0.8）',
            output: JSON.stringify({
                studentId: 'S001',
                strengths: ['《静夜思》背诵熟练', '朗读节奏感较好'],
                weaknesses: ['修辞手法识别薄弱', '《咏柳》理解层存在断层'],
                bloomMastery: { 记忆: 75, 理解: 55, 应用: 40, 分析: 35, 评价: 20, 创造: 15 },
                cognitiveStyle: 'auditory',
                engagementScore: 70,
                recommendedPace: 'medium',
                aiGenerated: true,
                confidence: 0.55,
            }),
        },
        {
            input: '学生 S002，5 年级，12 条学习事件（涵盖六阶，分析层表现突出但创造层薄弱）',
            output: JSON.stringify({
                studentId: 'S002',
                strengths: ['修辞手法分析准确', '能比较不同诗作的意境差异'],
                weaknesses: ['仿写创作能力不足', '跨媒介表达欠缺'],
                bloomMastery: { 记忆: 85, 理解: 80, 应用: 70, 分析: 88, 评价: 75, 创造: 45 },
                cognitiveStyle: 'visual',
                engagementScore: 82,
                recommendedPace: 'fast',
                aiGenerated: true,
                confidence: 0.85,
            }),
        },
    ],

    // ── 诗心·认知诊断 ──
    'mind.diagnose': [
        {
            input: '班级 C1，30 名学生，六阶掌握度均值：记忆 78/理解 52/应用 45/分析 38/评价 30/创造 22',
            output: JSON.stringify({
                scope: 'class',
                targetId: 'C1',
                darkMatter: [
                    {
                        poemId: 'poem-jingyesi',
                        bloomLevel: '理解',
                        pattern: '反复将"床前明月光"中的"床"误解为睡床，实为井栏（井床）',
                        severity: 'high',
                        rootCause: '字义古今演变认知缺失，未建立"床"在唐诗中的多义性',
                        prescription: '用对比法展示"床"在《静夜思》与《木兰诗》中的不同含义，配合井栏示意图',
                    },
                ],
                knowledgeGaps: [
                    { poemId: 'poem-yongliu', gap: '拟人手法识别', priority: 5 },
                ],
                bloomImbalance: {
                    dominant: '记忆',
                    weakest: '创造',
                    suggestion: '六阶严重失衡，需增加创造层活动（仿写、改写、跨媒介表达）',
                },
                aiGenerated: true,
                confidence: 0.82,
            }),
        },
    ],

    // ── 诗心·路径推荐 ──
    'mind.recommend': [
        {
            input: '学生 S001，诊断显示理解层薄弱（拟人/比喻混淆），知识图谱含《咏柳》《春晓》',
            output: JSON.stringify({
                studentId: 'S001',
                path: [
                    {
                        step: 1,
                        poemId: 'poem-yongliu',
                        bloomLevel: '记忆',
                        activity: '朗读背诵《咏柳》，重点识记"碧玉妆成一树高"',
                        estimatedMinutes: 10,
                        rationale: '从最熟悉的记忆层切入，建立学习信心',
                    },
                    {
                        step: 2,
                        poemId: 'poem-yongliu',
                        bloomLevel: '理解',
                        activity: '对比"拟人"与"比喻"：分析"碧玉妆成"是拟人还是比喻',
                        estimatedMinutes: 15,
                        rationale: '针对诊断出的修辞混淆，用同一首诗聚焦区分',
                    },
                    {
                        step: 3,
                        poemId: 'poem-chunxiao',
                        bloomLevel: '应用',
                        activity: '迁移运用：判断《春晓》中"处处闻啼鸟"是否使用拟人',
                        estimatedMinutes: 12,
                        rationale: '在新诗中验证修辞识别能力，检验迁移效果',
                    },
                ],
                totalEstimatedMinutes: 37,
                milestones: [
                    { afterStep: 2, checkPoint: '能准确区分《咏柳》中的拟人与比喻' },
                ],
                aiGenerated: true,
            }),
        },
    ],

    // ── 诗心·独立验收 ──
    'mind.verify': [
        {
            input: '审核 brush.question 的命题输出：选择题问"《静夜思》中"床"的含义"',
            output: JSON.stringify({
                targetAgentId: 'brush.question',
                verdict: 'revise',
                score: 72,
                strengths: ['题干清晰', '干扰项有教学价值'],
                issues: [
                    {
                        severity: 'medium',
                        description: '正确答案标注为"睡床"，但学术界对此有争议，井栏说亦有依据',
                        suggestion: '将正确答案改为"井栏（井床）"，或在解析中说明两种解读',
                    },
                ],
                revisedOutput: { answer: '井栏（井床）', analysis: '唐代"床"可指井栏，李白望月思乡，井栏更合情境' },
                aiGenerated: true,
                confidence: 0.88,
            }),
        },
        {
            input: '审核 brush.grade 的批改输出：学生答对，反馈鼓励性',
            output: JSON.stringify({
                targetAgentId: 'brush.grade',
                verdict: 'pass',
                score: 92,
                strengths: ['认知归因准确', '反馈语言温暖具体', 'teacherHint 有诊断价值'],
                issues: [],
                aiGenerated: true,
                confidence: 0.95,
            }),
        },
    ],

    // ── 诗眼·视觉标注 ──
    'eye.vision-annotate': [
        {
            input: '《静夜思》配图：月光下的庭院，一人仰望明月',
            output: '画面以冷蓝色调为主，月光皎洁洒满庭院，视觉重心位于画面上方的明月。一位身着唐装的人物立于庭院中央，仰头望月，姿态寂寥。地面投影斜长，营造孤寂氛围。文化符号层面，明月象征思乡团圆，庭院暗示游子漂泊，符合《静夜思》"举头望明月，低头思故乡"的意境。',
        },
    ],

    // ── 诗眼·ASR 朗读评估 ──
    'eye.asr': [
        {
            input: '原文"床前明月光"，学生朗读转写"床前明月光"（完全一致）',
            output: JSON.stringify({
                pronunciation: 95,
                rhythm: 88,
                emotion: 82,
                mistakes: [],
                suggestion: '朗读清晰准确，节奏把握较好。建议在"举头"与"低头"处加强语气对比，突出情感变化。',
            }),
        },
        {
            input: '原文"疑是地上霜"，学生朗读转写"疑是地上双"（错字）',
            output: JSON.stringify({
                pronunciation: 70,
                rhythm: 75,
                emotion: 65,
                mistakes: [
                    { type: '错字', position: 4, detail: '"霜"误读为"双"，未掌握 shuāng 与 shuāng 的声调差异' },
                ],
                suggestion: '"霜"字读音需注意，它是平声字，结尾气流较弱。可对比"双"字练习，体会声调与气流的细微差别。',
            }),
        },
    ],

    // ── 诗笔·六阶命题 ──
    'brush.question': [
        {
            input: '《静夜思》，3-4 年级，2 道题，记忆层 50% + 理解层 50%',
            output: JSON.stringify({
                questions: [
                    {
                        id: 'q-001',
                        poemId: 'poem-jingyesi',
                        bloomLevel: '记忆',
                        type: '填空',
                        stem: '床前明月光，疑是地上____。',
                        answer: '霜',
                        analysis: '考查名句默写，"霜"字为本诗核心意象，需准确识记。',
                        difficulty: 1,
                        estimatedTimeSec: 30,
                        aiGenerated: true,
                    },
                    {
                        id: 'q-002',
                        poemId: 'poem-jingyesi',
                        bloomLevel: '理解',
                        type: '选择',
                        stem: '"疑是地上霜"中"疑"字的作用是？',
                        options: ['表现诗人的幻觉', '表现诗人的猜测与想象，强化月光之亮', '表现诗人视力不好', '表现诗人的疑惑不解'],
                        answer: '表现诗人的猜测与想象，强化月光之亮',
                        analysis: '"疑"字体现诗人将月光误认为霜，突出月光皎洁如霜，是想象而非真实错觉。',
                        distractorsAnalysis: [
                            '选项A"幻觉"过于绝对，"疑"是想象而非病理性幻觉',
                            '选项C"视力不好"曲解诗意，属于荒谬选项',
                            '选项D"疑惑不解"偏离本意，"疑"在此是想象而非疑问',
                        ],
                        difficulty: 3,
                        estimatedTimeSec: 60,
                        aiGenerated: true,
                    },
                ],
                coverage: { 记忆: 50, 理解: 50, 应用: 0, 分析: 0, 评价: 0, 创造: 0 },
            }),
        },
    ],

    // ── 诗笔·智能批改 ──
    'brush.grade': [
        {
            input: '《静夜思》填空题"床前明月光，疑是地上____"，学生答"霜"',
            output: JSON.stringify({
                questionId: 'q-001',
                correct: true,
                cognitiveAttribution: '记忆层掌握扎实，准确识记"霜"字这一核心意象',
                feedback: '太棒了！"霜"字记得很准确。你能说说为什么诗人会把月光想象成霜吗？',
                teacherHint: '该生记忆层达标，可推进至理解层，引导分析"霜"的意象作用',
                confidence: 0.98,
                needsHumanReview: false,
                aiGenerated: true,
            }),
        },
        {
            input: '《咏柳》选择题问修辞手法，学生将"拟人"误选为"比喻"',
            output: JSON.stringify({
                questionId: 'q-005',
                correct: false,
                cognitiveAttribution: '分析层缺陷：混淆拟人与比喻，未识别"碧玉妆成"赋予柳树以人的装扮行为',
                feedback: '差一点点哦！"碧玉妆成"是把柳树当作人来打扮，这是"拟人"。比喻是打个比方，拟人是让人做事。我们再对比一下好吗？',
                teacherHint: '该生修辞手法识别存在系统性混淆，建议用《咏柳》《春晓》对比练习强化拟人特征',
                confidence: 0.92,
                needsHumanReview: false,
                aiGenerated: true,
            }),
        },
    ],

    // ── 诗笔·教研报告 ──
    'brush.report': [
        {
            input: '班级 C1，4 周，诊断显示理解层薄弱，掌握度均值：记忆 78/理解 52',
            output: JSON.stringify({
                title: 'C1 班级古诗词教学教研报告（4 周期）（AI 生成）',
                sections: [
                    {
                        heading: '教学背景',
                        content: 'C1 班级共 30 名学生，本阶段教学聚焦统编版三年级上册古诗词单元。教学起点六阶掌握度均值为：记忆 78、理解 52、应用 45、分析 38、评价 30、创造 22。整体呈现"记忆强、理解弱、创造缺失"的失衡结构，理解层掌握度低于年级基准 15 个百分点。',
                    },
                    {
                        heading: '干预策略',
                        content: '基于认知暗物质识别，主要干预方向为：\n\n1. **修辞手法混淆**（拟人/比喻）：采用对比教学法，以《咏柳》《春晓》为载体\n2. **意象象征义缺失**：引入意象对照表，建立"明月-思乡""柳枝-送别"映射\n3. **创造层空白**：增设仿写改写活动，从替换意象到迁移创作',
                    },
                    {
                        heading: '数据实证',
                        content: '4 周干预后，理解层掌握度由 52 提升至 68（+16），拟人/比喻辨析正确率由 42% 提升至 78%。典型案例：S07 学生通过对比练习，能独立判断《春晓》"处处闻啼鸟"的拟人手法。',
                    },
                    {
                        heading: '反思展望',
                        content: '本轮干预在理解层成效显著，但创造层提升有限（22→28）。下阶段需加强创造层活动设计，引入跨媒介表达（配图、配音、表演）。同时注意 S12、S15 两名学生仍存在字义古今演变认知缺失，需个别辅导。',
                    },
                ],
                keyFindings: [
                    '理解层掌握度提升 16 个百分点，干预策略有效',
                    '修辞手法辨析正确率提升 36 个百分点',
                    '创造层提升有限，需下一阶段重点突破',
                ],
                recommendations: [
                    '继续巩固修辞手法对比教学，扩展至借代与象征',
                    '设计"我为古诗配画"活动，激活创造层',
                    '对 S12、S15 进行个别辅导，补足字义演变认知',
                ],
                dataAnonymized: true,
                aiGenerated: true,
            }),
        },
    ],

    // ── 诗笔·创意素材 ──
    'brush.creative': [
        {
            input: '《静夜思》配图描述，3-4 年级',
            output: JSON.stringify({
                type: 'illustration-description',
                content: '## 《静夜思》配图描述\n\n画面以深蓝色夜空为背景，一轮皎洁圆月悬挂于画面右上方，月光如水银般倾泻而下，洒满整个庭院。庭院中央，一位身着白色长袍的诗人独自伫立，微微仰头，目光凝视明月。地面铺着一层淡淡的银白色光晕，仿佛覆盖着一层薄霜。\n\n画面左侧是一口古井，井栏（井床）的轮廓在月光下若隐若现，呼应"床前明月光"的诗意。诗人身后是简朴的客舍屋檐，屋檐下悬挂的灯笼透出微弱暖光，与冷色调的月光形成对比，烘托游子的孤独思乡之情。',
                suggestedImagePrompt: 'Chinese ink painting style, moonlit courtyard at night, a Tang dynasty poet in white robe looking up at full moon, silver moonlight casting frost-like glow on ground, ancient well in foreground, wooden cottage eaves with warm lantern light, serene and melancholic atmosphere, traditional landscape composition, deep blue and silver tones with warm accent',
                aiGenerated: true,
            }),
        },
    ],

    // ── 编排官·指令解析 ──
    'orchestrator.route': [
        {
            input: '教师指令："给三年级一班出 5 道关于《静夜思》的题目，涵盖记忆和理解两个层次"',
            output: JSON.stringify({
                intent: 'generate-questions',
                subTasks: [
                    {
                        id: 't1',
                        agentId: 'brush.question',
                        input: {
                            poemId: 'poem-jingyesi',
                            gradeLevel: '3-4年级',
                            questionTypes: ['选择', '填空', '简答'],
                            bloomWeights: { 记忆: 50, 理解: 50, 应用: 0, 分析: 0, 评价: 0, 创造: 0 },
                            count: 5,
                        },
                        dependencies: [],
                    },
                ],
                dependencies: [],
                estimatedDurationMs: 30000,
                confidence: 0.92,
                reasoning: '单一出题任务，无依赖，直接调用 brush.question',
            }),
        },
        {
            input: '教师指令："诊断三班古诗词学习情况，然后生成教研报告"',
            output: JSON.stringify({
                intent: 'composite',
                subTasks: [
                    {
                        id: 't1',
                        agentId: 'mind.diagnose',
                        input: { scope: 'class', targetId: 'class-3' },
                        dependencies: [],
                    },
                    {
                        id: 't2',
                        agentId: 'brush.report',
                        input: { scope: 'class', targetId: 'class-3' },
                        dependencies: ['t1'],
                    },
                ],
                dependencies: [{ from: 't1', to: 't2' }],
                estimatedDurationMs: 90000,
                confidence: 0.88,
                reasoning: '复合任务：先诊断再报告，t2 依赖 t1 的诊断结果',
            }),
        },
    ],
} as const

/**
 * 获取指定 Agent 的 Few-shot 示例块
 *
 * 若该 Agent 无预定义示例，返回空字符串（不注入）。
 */
export function getFewShotBlock(agentId: string): string {
    const examples = FEWSHOT_EXAMPLES[agentId]
    if (!examples || examples.length === 0) return ''
    return withExamples([...examples])
}

// ─────────────────────────────────────────────────────────────
// Loop Engineering 工具（SubTask 8.3.2 / 8.3.3）
// ─────────────────────────────────────────────────────────────

/**
 * 构建带反馈的 User Prompt（用于 Generator-Verifier-Curator 重生成）
 *
 * 在原 prompt 基础上注入 <verifier_issues> 与 <feedback> 块，
 * 引导 Generator 针对性修正。
 *
 * @param originalPrompt 原 User Prompt
 * @param feedback 反馈摘要（来自 Curator）
 * @param issues 具体问题列表（来自 Verifier）
 * @param attempt 当前重试轮次（1 开始）
 */
export function withRegenerationFeedback(
    originalPrompt: string,
    feedback: string,
    issues: Array<{ severity: string; description: string; suggestion: string }>,
    attempt: number,
): string {
    const issuesStr = issues.length > 0
        ? issues.map((i, idx) => `${idx + 1}. [${i.severity}] ${i.description}\n   修正建议：${i.suggestion}`).join('\n')
        : '（无具体问题列表）'

    const feedbackBlock = buildContextBlock([
        { tag: STANDARD_CONTEXT_TAGS.FEEDBACK, content: feedback },
        { tag: STANDARD_CONTEXT_TAGS.VERIFIER_ISSUES, content: issuesStr },
    ])

    return `<regeneration_notice>
这是第 ${attempt} 轮重新生成。上一轮输出经验收未通过，请针对以下反馈与问题修正，输出符合要求的 JSON。
</regeneration_notice>

${originalPrompt}

${feedbackBlock}

请基于上述反馈，重新输出严格 JSON。务必修正验收指出的所有问题。`
}

/**
 * 构建长对话历史摘要块（SubTask 8.1.3）
 *
 * 将旧轮次对话压缩为摘要，避免上下文膨胀。
 */
export function withHistorySummary(summary: string): string {
    if (!summary.trim()) return ''
    return withXmlTags(summary, STANDARD_CONTEXT_TAGS.HISTORY_SUMMARY)
}
