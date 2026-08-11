/**
 * 诗脉星图 · 知识图谱类型定义
 *
 * 节点类型 6 种：Poet / Poem / Image / Theme / Era / Rhetoric
 * 边类型：师承 / 同意象 / 同主题 / 同修辞 / 属朝代 / 创作 / 使用修辞 / 关联
 *
 * 掌握度着色规则（规范 spec）：
 *   - 六阶皆通（所有阶层 ≥80）→ accent-success
 *   - 高阶薄弱（分析/评价/创造 <60）→ accent-warning
 *   - 记忆层卡顿（记忆/理解 <60）→ accent-error
 *   - 未学习（无 mastery 记录）→ text-tertiary
 */

/** 节点类型 —— 决定节点形状与基础色相 */
export type NodeType = 'Poet' | 'Poem' | 'Image' | 'Theme' | 'Era' | 'Rhetoric'

/** 边类型 —— 决定边的语义与图例归属 */
export type EdgeType =
    | 'MENTORS'           // 师承关系（Poet→Poet）
    | 'CONTEMPORARY'      // 同时代诗人
    | 'AUTHORED_BY'       // 诗 → 诗人
    | 'BELONGS_TO_ERA'    // 诗/诗人 → 朝代
    | 'SHARES_IMAGE'      // 同意象（Poem↔Poem）
    | 'SHARES_THEME'      // 同主题（Poem↔Poem）
    | 'SHARES_RHETORIC'   // 同修辞（Poem↔Poem）
    | 'USES_IMAGE'        // 诗 → 意象
    | 'USES_THEME'        // 诗 → 主题
    | 'USES_RHETORIC'     // 诗 → 修辞
    | 'RELATED_TO'        // 泛化关联

/** 六阶认知层级（布卢姆修正版） */
export interface Mastery {
    remember: number      // 记忆 0-100
    understand: number    // 理解
    apply: number         // 运用
    analyze: number       // 分析
    evaluate: number      // 评价
    create: number        // 创造
}

/** 掌握度分级 —— 决定 Poem 节点着色 */
export type MasteryLevel = 'mastered' | 'high-weak' | 'memory-stuck' | 'unlearned'

/** 图谱节点 */
export interface GraphNode {
    id: string
    type: NodeType
    label: string
    /** 连接数（degree），由后端计算或前端兜底 */
    degree?: number
    /** 通用描述（Image/Theme/Rhetoric 的文化内涵解读） */
    description?: string
    /** 朝代 */
    dynasty?: string
    /** Poem 原文（Markdown） */
    content?: string
    /** Poem 所属诗人 id */
    poetId?: string
    /** Poem 所属诗人姓名 */
    poet?: string
    /** Poet 生平简介 */
    bio?: string
    /** Poet 作品 id 列表 */
    works?: string[]
    /** Poet 师承的诗人 id 列表 */
    mentors?: string[]
    /** 掌握度（mastery-colored 端点提供） */
    mastery?: Mastery
    /** 认知暗物质 —— 卡顿的阶层名列表 */
    darkMatter?: string[]
    /** 班级共性卡顿标记（dark-matter 端点提供） */
    isDarkMatter?: boolean
}

/** 图谱边 */
export interface GraphEdge {
    source: string
    target: string
    type: EdgeType
    weight?: number
    /** 支撑关系的可读证据，如共享意象/主题/修辞词 */
    evidence?: string[]
    /** 师承等人工标注关系的说明 */
    note?: string
    /** 关系来源等级：直接抽取 / 推断 / 存疑 */
    confidence?: 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS'
}

/** 完整图谱数据 */
export interface GraphData {
    nodes: GraphNode[]
    edges: GraphEdge[]
}

/** 视图模式：按类型着色 / 按掌握度着色 */
export type ViewMode = 'type' | 'mastery'

/** 六阶层级中文名映射 */
export const MASTERY_TIERS: ReadonlyArray<{ key: keyof Mastery; label: string }> = [
    { key: 'remember', label: '记忆' },
    { key: 'understand', label: '理解' },
    { key: 'apply', label: '运用' },
    { key: 'analyze', label: '分析' },
    { key: 'evaluate', label: '评价' },
    { key: 'create', label: '创造' },
] as const

/** 节点类型中文标签 */
export const NODE_TYPE_LABELS: Record<NodeType, string> = {
    Poet: '诗人',
    Poem: '诗篇',
    Image: '意象',
    Theme: '主题',
    Era: '朝代',
    Rhetoric: '修辞',
}

/** 边类型中文标签 */
export const EDGE_TYPE_LABELS: Record<EdgeType, string> = {
    MENTORS: '师承',
    CONTEMPORARY: '同时代',
    AUTHORED_BY: '作者',
    BELONGS_TO_ERA: '朝代',
    SHARES_IMAGE: '同意象',
    SHARES_THEME: '同主题',
    SHARES_RHETORIC: '同修辞',
    USES_IMAGE: '用意象',
    USES_THEME: '用主题',
    USES_RHETORIC: '用修辞',
    RELATED_TO: '关联',
}

/**
 * 按掌握度判定分级 —— 严格依据 spec 规则
 *  - 无 mastery → unlearned
 *  - 记忆/理解 <60 → memory-stuck（红色优先，基础层卡顿最严重）
 *  - 分析/评价/创造 <60 → high-weak
 *  - 其余 ≥80 → mastered
 */
export function classifyMastery(m?: Mastery): MasteryLevel {
    if (!m) return 'unlearned'
    if (m.remember < 60 || m.understand < 60) return 'memory-stuck'
    if (m.analyze < 60 || m.evaluate < 60 || m.create < 60) return 'high-weak'
    const all = [m.remember, m.understand, m.apply, m.analyze, m.evaluate, m.create]
    if (all.every((v) => v >= 80)) return 'mastered'
    return 'high-weak'
}

/* ============================================================
 * 教学驾驶舱 Dashboard 类型（Task 9）
 * 与后端 backend/src/routes/dashboard.ts 保持一致
 * ============================================================ */

/** 布鲁姆六阶（中文键，与后端 BloomLevel 对齐） */
export type BloomLevel = '记忆' | '理解' | '应用' | '分析' | '评价' | '创造'

/** 六阶顺序（雷达图轴序） */
export const BLOOM_ORDER: readonly BloomLevel[] = ['记忆', '理解', '应用', '分析', '评价', '创造'] as const

/** 顶部统计卡片数据 */
export interface DashboardStats {
    classId: string
    className: string
    studentCount: number
    /** 本周已学古诗数 */
    weekLearnedPoems: number
    /** 班级综合掌握度 0-100 */
    classMasteryAvg: number
    /** 参与聚合的真实掌握度记录数；0 表示尚未形成成绩 */
    masteryRecordCount: number
    /** 待处理预警数 */
    pendingAlerts: number
    /** 本周进度 */
    weekProgress: { learned: number; total: number }
    /** 数据来源披露：用于区分演示种子与真实课堂数据 */
    dataProvenance?: {
        containsSyntheticData: boolean
        seedSource: string | null
        syntheticAnswerCount: number
        syntheticStudentCount: number
    }
}

/** 六阶能力雷达数据 */
export interface BloomRadar {
    classId: string
    radar: Record<BloomLevel, number>
    /** 参与雷达聚合的真实记录数 */
    sampleSize: number
    /** 年级均值（可选，用于对比） */
    comparison?: Record<BloomLevel, number>
    /** 各阶层标准差（可选，用于绘制 ±1σ 置信带，0-100 尺度） */
    stdDev?: Partial<Record<BloomLevel, number>>
}

/** 预警类型 */
export type AlertType =
    | 'cognitive-dark-matter'
    | 'student-drop'
    | 'lesson-delay'
    | 'mastery-warning'

/** 预警严重程度 */
export type AlertSeverity = 'low' | 'medium' | 'high'

/** 单条预警 */
export interface DashboardAlert {
    id: string
    type: AlertType
    severity: AlertSeverity
    title: string
    description: string
    affectedStudents?: string[]
    suggestedAction: string
    createdAt: number
}

/** 预警列表响应 */
export interface AlertsResponse {
    alerts: DashboardAlert[]
}

/** 周进度课程项 */
export interface WeeklyLesson {
    id: string
    poemTitle: string
    poet: string
    status: 'planned' | 'ongoing' | 'completed' | 'cancelled'
    masteryBefore?: number
    masteryAfter?: number
    studentCount: number
}

/** 周进度单日 */
export interface WeeklyDay {
    date: string
    lessons: WeeklyLesson[]
}

/** 周进度响应 */
export interface WeeklyProgressResponse {
    days: WeeklyDay[]
}

/** WebSocket 连接状态 */
export type WSStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error'

/** WebSocket 事件信封（与后端 WSEvent 对齐） */
export interface WSEvent {
    type: string
    timestamp: number
    sessionId: string
    payload: unknown
}

/* ============================================================
 * 课堂导播台 Classroom 类型（Task 11）
 * 与后端 backend/src/routes/classroom.ts 保持一致
 * ============================================================ */

/** 课堂模式 —— v5.0 创新扩展：新增 3 种寓教于乐模式
 * - 4 种基础模式：collective-race / speed-pk / flying-flower / six-level-immersive
 * - 3 种创新模式：poem-wheel（诗词大转盘）/ poem-relay（诗词接龙）/ imagery-puzzle（意境拼图） */
export type ClassroomMode =
    | 'collective-race'
    | 'speed-pk'
    | 'flying-flower'
    | 'six-level-immersive'
    | 'poem-wheel'
    | 'poem-relay'
    | 'imagery-puzzle'

/** 课堂氛围 */
export type ClassMood = 'focused' | 'excited' | 'bored' | 'confused'

/** 课堂模式中文标签 —— 含 3 种创新模式 */
export const CLASSROOM_MODE_LABELS: Record<ClassroomMode, string> = {
    'collective-race': '集体闯关',
    'speed-pk': '速答 PK',
    'flying-flower': '飞花令擂台',
    'six-level-immersive': '六阶沉浸课',
    'poem-wheel': '诗词大转盘',
    'poem-relay': '诗词接龙',
    'imagery-puzzle': '意境拼图',
}

/** 课堂模式分组：基础 4 模式 + 创新 3 模式 */
export const CLASSROOM_MODE_BASIC: ClassroomMode[] = [
    'collective-race',
    'speed-pk',
    'flying-flower',
    'six-level-immersive',
]

export const CLASSROOM_MODE_INNOVATIVE: ClassroomMode[] = [
    'poem-wheel',
    'poem-relay',
    'imagery-puzzle',
]

/** 课堂模式是否为创新模式 */
export function isInnovativeMode(mode: ClassroomMode): boolean {
    return CLASSROOM_MODE_INNOVATIVE.includes(mode)
}

/** 课堂氛围中文标签 */
export const CLASS_MOOD_LABELS: Record<ClassMood, string> = {
    focused: '专注',
    excited: '活跃',
    bored: '疲倦',
    confused: '困惑',
}

/** 题目类型（脱敏后，不含答案） */
export interface ClassroomQuestion {
    id: string
    poemId: string
    bloomLevel: BloomLevel
    type: string
    stem: string
    options?: string[]
    estimatedTimeSec: number
    difficulty: 1 | 2 | 3 | 4 | 5
    aiGenerated: boolean
    answer?: string
    analysis?: string
}

/** 学生答题记录 */
export interface StudentResponse {
    studentId: string
    /** 学生姓名（WS 事件与提交时可携带，用于展示） */
    studentName?: string
    answer: string
    correct?: boolean
    /** AI 批改得分（速答 PK 模式由后端计算） */
    score?: number
    at: number
}

/** 启发提示记录 */
export interface HintRecord {
    id: string
    questionId: string
    type: 'nudge' | 'scaffold' | 'reframe'
    hint: string
    deliveredAt: number
    aiGenerated: boolean
}

/** 讨论题记录 */
export interface DiscussionRecord {
    id: string
    questionId: string
    angle: 'cultural' | 'comparative' | 'creative'
    topic: string
    followUp: string[]
    generatedAt: number
    /** true 代表由 AI 深度生成；false 代表基于已采集学情的规则兜底。 */
    aiGenerated: boolean
}

/** 开始课堂响应 */
export interface StartClassroomResponse {
    lessonId: string
    joinCode: string
    joinUrl: string
    startedAt: number
}

export interface ClassroomReadiness {
    poemId: string
    questionCount: number
    bloomCoverage: Record<BloomLevel, number>
    ready: boolean
    source: 'question-bank'
}

/** 课堂实时状态响应 */
export interface ClassroomStatus {
    lessonId: string
    /** 关联班级 ID，用于课堂内加载真实学生名单 */
    classId?: string
    /** 闯关快照（服务端随 status 一并下发，供刷新/中途接入时补水 HUD） */
    quest?: QuestSnapshot
    mode: ClassroomMode
    /** 课堂生命周期阶段：ongoing 进行中 / ended 已结束 */
    phase?: 'ongoing' | 'ended'
    currentQuestionIndex: number
    totalQuestions: number
    currentQuestion?: ClassroomQuestion
    activeStudents: number
    responses: StudentResponse[]
    classMood: ClassMood
    cognitiveLoad: number
    engagement: number
    hintsDelivered: number
    joinCode: string
    flyingFlowerKeyword?: string
    /** 是否已有协奏报告（runtime 缓存） */
    hasReport?: boolean
    aiGenerated: true
}

/** 提交答案响应 */
export interface SubmitResponse {
    correct: boolean
    feedback: string
    aiGenerated: true
}

/** 启发提示响应 */
export interface HintResponse {
    hint: string
    aiGenerated: true
}

/** 讨论题响应 */
export interface DiscussResponse {
    discussionTopic: string
    followUp: string[]
    aiGenerated: true
}

/** 课堂协奏报告 */
export interface ClassroomReport {
    lessonId: string
    report: {
        summary: string
        participation: number
        masteryChange: { before: number; after: number }
        highlights: string[]
        improvements: string[]
        aiGenerated: boolean
    }
}

/** 课堂 WebSocket 事件载荷类型 */
export interface ClassroomWSPayload {
    lessonId?: string
    questionId?: string
    studentId?: string
    studentName?: string
    answer?: string
    correct?: boolean
    /** 速答 PK 模式得分 */
    score?: number
    feedback?: string
    type?: 'nudge' | 'scaffold' | 'reframe'
    angle?: 'cultural' | 'comparative' | 'creative'
    hint?: string
    topic?: string
    followUp?: string[]
    deliveredAt?: number
    currentIndex?: number
    totalQuestions?: number
    cognitiveLoad?: number
    classMood?: ClassMood
    engagement?: number
    endedAt?: number
    report?: ClassroomReport['report']
    /** 闯关快照（classroom:response / level-cleared / quest / ai-feedback 帧携带） */
    quest?: QuestSnapshot
    /** 本次作答对闯关状态的增量 */
    delta?: { power: number; combo: number; levelCleared: boolean; nextLevel: string | null; allCleared: boolean }
    /** 本地判不了、正等 AI 评阅 */
    pendingAiReview?: boolean
    /** 通关事件字段 */
    clearedLevel?: string
    nextLevel?: string | null
    allCleared?: boolean
    /** 课堂指挥深化：模式切换事件 */
    fromMode?: ClassroomMode
    toMode?: ClassroomMode
    /** 课堂指挥深化：调度事件 */
    scheduleStrategy?: ScheduleStrategy
    scheduledStudentId?: string
    scheduledStudentName?: string
    /** 课堂指挥深化：AI 协同建议事件 */
    aiCategory?: AISuggestionCategory
    aiSummary?: string
    /** 课堂指挥深化：复盘报告事件 */
    afterActionReport?: AfterActionReportData
}

/* ============================================================
 * 课堂 v5.0 Task 18-20 —— 单设备场景 + AI 虚拟对手 + 智能赋分
 *
 * 设计约束：
 *  - 单设备场景：课堂上仅有一台教学大屏，学生没有任何电子设备
 *  - 教师代为输入学生回答（StudentInputPanel）
 *  - AI 虚拟对手作为陪练（AIOpponentState）
 *  - 智能赋分 0-100 + 个性化反馈（SmartScoreResult）
 * ============================================================ */

/** AI 虚拟对手难度档位 */
export type AIOpponentLevel = 'easy' | 'medium' | 'hard'

/** AI 虚拟对手难度中文标签 */
export const AI_OPPONENT_LEVEL_LABELS: Record<AIOpponentLevel, string> = {
    easy: '新秀 AI',
    medium: '老练 AI',
    hard: '诗仙 AI',
}

/** AI 虚拟对手状态 —— 陪练角色，与学生同台竞技 */
export interface AIOpponentState {
    /** 对手昵称（如：诗仙 AI / 小诗童 AI） */
    name: string
    /** 难度档位 */
    level: AIOpponentLevel
    /** 当前累计得分 */
    score: number
    /** 已答对题数 */
    correctCount: number
    /** 已答题总数 */
    totalCount: number
    /** 平均响应时延（ms） */
    avgLatencyMs: number
    /** 最近一次作答时间戳 */
    lastAnswerAt?: number
    /** 是否启用陪练 */
    enabled: boolean
}

/** 智能赋分请求 —— POST /api/classroom/sessions/:id/score */
export interface SmartScoreRequest {
    /** 学生 ID（虚拟对手使用固定 ID：'ai-opponent'） */
    studentId: string
    /** 学生姓名（虚拟对手使用 AI 昵称） */
    studentName?: string
    /** 题目 ID */
    questionId?: string
    /** 学生作答文本 */
    answer: string
    /** 标准答案（可选，部分模式无标准答案，由 AI 主观赋分） */
    referenceAnswer?: string
    /** 题目类型（影响赋分维度权重） */
    questionType?: string
    /** 当前课堂模式 */
    mode?: ClassroomMode
    /** 作答时延（ms）—— 速答 PK 等模式用于加分 */
    latencyMs?: number
}

/** 智能赋分响应 —— 0-100 分 + 个性化反馈 */
export interface SmartScoreResult {
    /** 课堂 ID */
    lessonId: string
    /** 学生 ID */
    studentId: string
    /** 题目 ID */
    questionId?: string
    /** 最终得分 0-100 */
    score: number
    /** 是否答对（>=60 视为答对） */
    correct: boolean
    /** 个性化反馈（含亮点 + 改进建议） */
    feedback: string
    /** 分维度得分（选项/释义/意象/结构等，可选） */
    dimensions?: Array<{
        name: string
        score: number
        maxScore: number
        comment: string
    }>
    /** 赋分模型（deepseek-v4-pro） */
    model: string
    /** 赋分时间戳 */
    scoredAt: number
    /** AI 生成标记 */
    aiGenerated: true
}

/** AI 实时点评分片（SSE 流式） —— POST /api/classroom/sessions/:id/comment */
export interface ClassroomCommentChunk {
    /** 文本增量 */
    delta?: string
    /** 是否完成 */
    done?: boolean
    /** 关联学生 ID（点评针对的学生） */
    studentId?: string
    /** 关联题目 ID */
    questionId?: string
    /** 点评类型：praise 鼓励 / guide 引导 / challenge 挑战 / correct 纠错 */
    commentType?: 'praise' | 'guide' | 'challenge' | 'correct'
    /** 错误信息（仅错误帧） */
    error?: string
}

/** AI 虚拟对手作答请求 —— POST /api/classroom/sessions/:id/ai-opponent/answer */
export interface AIOpponentAnswerRequest {
    /** 题目 ID */
    questionId?: string
    /** 题干（让 AI 据此作答） */
    questionStem?: string
    /** 选项（若有） */
    options?: string[]
    /** 飞花令关键字（flying-flower 模式） */
    flyingFlowerKeyword?: string
    /** 接龙上句（poem-relay 模式） */
    relayPrevious?: string
    /** 当前模式 */
    mode: ClassroomMode
    /** 难度档位 */
    level: AIOpponentLevel
    /** 课堂诗篇 ID（限定 AI 答案范围） */
    poemId?: string
}

/** AI 虚拟对手作答响应 */
export interface AIOpponentAnswerResult {
    lessonId: string
    /** AI 作答内容 */
    answer: string
    /** 是否答对 */
    correct: boolean
    /** 得分 */
    score: number
    /** 响应时延（ms）—— 模拟"思考时间" */
    latencyMs: number
    /** AI 自述理由 */
    reasoning?: string
    /** 使用的模型 */
    model: string
    /** 时间戳 */
    answeredAt: number
    aiGenerated: true
}

/** 诗篇接龙 —— 单条诗 */
export interface PoemRelayLine {
    /** 诗句文本 */
    line: string
    /** 出处诗名 */
    poemTitle?: string
    /** 作者 */
    poet?: string
    /** 是否为学生接的下一句 */
    isStudentAnswer?: boolean
    /** 是否正确 */
    correct?: boolean
    /** 提交者：student / ai-opponent / system */
    source: 'student' | 'ai-opponent' | 'system'
    /** 提交时间戳 */
    at: number
}

/** 诗篇接龙会话状态 */
export interface PoemRelaySession {
    /** 起始诗 ID */
    startPoemId: string
    /** 起始句 */
    startLine: string
    /** 接龙链（按时间顺序） */
    chain: PoemRelayLine[]
    /** 当前等待接的学生 ID */
    currentStudentId?: string
    /** 当前等待接的学生姓名 */
    currentStudentName?: string
    /** 是否已结束 */
    finished: boolean
}

/** 拼图块 —— ImageryPuzzleMode */
export interface PuzzlePiece {
    /** 块 ID */
    id: string
    /** 在原图中的行索引 */
    row: number
    /** 在原图中的列索引 */
    col: number
    /** 当前所在的槽位（位置）索引 */
    currentSlot: number
    /** 背景图 X 偏移（百分比） */
    bgX: number
    /** 背景图 Y 偏移（百分比） */
    bgY: number
    /** 是否已放入正确位置 */
    isCorrect: boolean
}

/** 拼图选项（4 选 1 看图猜诗） */
export interface PuzzlePoemOption {
    /** 诗篇 ID */
    poemId: string
    /** 诗题 */
    title: string
    /** 作者 */
    poet: string
    /** 朝代 */
    dynasty: string
    /** 是否为正确答案 */
    isCorrect: boolean
}

/* ============================================================
 * 课堂指挥深化 —— 实时调度（Task 2）
 * ============================================================ */

/** 调度策略 */
export type ScheduleStrategy = 'round-robin' | 'random-draw' | 'pk' | 'tiered'

/** 调度策略中文标签 */
export const SCHEDULE_STRATEGY_LABELS: Record<ScheduleStrategy, string> = {
    'round-robin': '轮询调度',
    'random-draw': '抽签调度',
    'pk': '对战调度',
    'tiered': '分层调度',
}

/** 调度学生候选项 */
export interface ScheduleCandidate {
    studentId: string
    studentName: string
    /** 学生状态：active 活跃 / idle 空闲 / struggling 困难 */
    status: 'active' | 'idle' | 'struggling'
    /** 近期正确率 0-1 */
    accuracy: number
    /** 累计被调度次数 */
    callCount: number
    /** 上次被调度时间戳 */
    lastCalledAt?: number
}

/** POST /schedule/next 响应 */
export interface ScheduleNextResponse {
    lessonId: string
    /** 调度策略 */
    strategy: ScheduleStrategy
    /** 被选中学生 ID */
    studentId: string
    /** 被选中学生姓名 */
    studentName: string
    /** 选择理由 */
    reason: string
    /** 候选学生列表（前端展示） */
    candidates: ScheduleCandidate[]
    /** 调度时间戳 */
    scheduledAt: number
    aiGenerated: true
}

/** POST /schedule/override 请求 */
export interface ScheduleOverrideRequest {
    studentId: string
    /** 教师覆盖理由（可选） */
    reason?: string
}

/** POST /schedule/override 响应 */
export interface ScheduleOverrideResponse {
    lessonId: string
    studentId: string
    studentName: string
    overriddenAt: number
}

/** GET /schedule/status 响应 */
export interface ScheduleStatusResponse {
    lessonId: string
    /** 当前调度策略 */
    currentStrategy: ScheduleStrategy
    /** 时间进度 0-1 */
    timeProgress: number
    /** 已调度次数 */
    totalCalls: number
    /** 候选学生列表 */
    candidates: ScheduleCandidate[]
    /** 当前被调度学生（若有） */
    currentStudent?: {
        studentId: string
        studentName: string
        calledAt: number
    }
    /** 是否被教师手动覆盖 */
    isOverridden: boolean
}

/* ============================================================
 * 课堂指挥深化 —— AI 协同教学（Task 3）
 * ============================================================ */

/** AI 建议类别 */
export type AISuggestionCategory = 'feedback' | 'supplement' | 'followup' | 'intervention'

/** AI 建议类别中文标签 */
export const AI_SUGGESTION_CATEGORY_LABELS: Record<AISuggestionCategory, string> = {
    feedback: '实时反馈',
    supplement: '背景补充',
    followup: '追问生成',
    intervention: '干预建议',
}

/** AI 建议流式分片 */
export interface AISuggestionChunk {
    /** 文本增量 */
    delta?: string
    /** 是否完成 */
    done?: boolean
    /** 建议类别 */
    category: AISuggestionCategory
}

/** POST /ai/suggest 响应（实时反馈建议） */
export interface AISuggestResponse {
    lessonId: string
    category: 'feedback'
    /** 建议内容 */
    content: string
    /** 关联学生 ID（若有） */
    studentId?: string
    /** 关联题目 ID */
    questionId?: string
    /** 生成时间戳 */
    generatedAt: number
    aiGenerated: true
}

/** POST /ai/supplement 响应（背景补充） */
export interface AISupplementResponse {
    lessonId: string
    category: 'supplement'
    content: string
    questionId?: string
    generatedAt: number
    aiGenerated: true
}

/** POST /ai/followup 响应（追问生成） */
export interface AIFollowupResponse {
    lessonId: string
    category: 'followup'
    /** 追问列表 */
    followUps: string[]
    questionId?: string
    generatedAt: number
    aiGenerated: true
}

/** POST /ai/intervention 响应（基于课堂已发生作答的确定性干预分析） */
export interface AIInterventionResponse {
    lessonId: string
    category: 'intervention'
    intervention: {
        strugglingStudents: Array<{
            studentId: string
            studentName: string
            accuracy: number
            suggestion: string
        }>
        classSuggestion: string
    }
}

/* ============================================================
 * 课堂指挥深化 —— 复盘报告（Task 5）
 * ============================================================ */

/** 难度分析项 */
export interface DifficultyAnalysisItem {
    /** 题目 ID */
    questionId: string
    /** 题干摘要 */
    stemSummary: string
    /** Bloom 层级 */
    bloomLevel: BloomLevel
    /** 难度 1-5 */
    difficulty: number
    /** 正确率 0-1 */
    accuracy: number
    /** 平均响应时长（秒） */
    avgResponseSec: number
    /** 需要重点讲解 */
    needsReview: boolean
}

/** AI 建议采纳统计 */
export interface AISuggestionStats {
    /** 反馈建议数 */
    feedbackCount: number
    /** 补充建议数 */
    supplementCount: number
    /** 追问建议数 */
    followupCount: number
    /** 干预建议数 */
    interventionCount: number
    /** 总采纳数 */
    adoptedCount: number
    /** 采纳率 0-1 */
    adoptionRate: number
}

/** 时间分配项 */
export interface TimeAllocationItem {
    /** 模式名称 */
    mode: string
    /** 模式中文标签 */
    modeLabel: string
    /** 占用时长（秒） */
    durationSec: number
    /** 占比 0-1 */
    ratio: number
}

/** 复盘报告数据 */
export interface AfterActionReportData {
    lessonId: string
    /** 课堂基本信息 */
    classInfo: {
        classId: string
        className: string
        poemId: string
        poemTitle: string
        poet: string
        startedAt: number
        endedAt: number
        /** 课堂时长（秒） */
        durationSec: number
        mode: ClassroomMode
    }
    /** 参与度统计 */
    participation: {
        /** 应到人数 */
        expectedCount: number
        /** 实到人数 */
        actualCount: number
        /** 参与率 0-1 */
        rate: number
        /** 参与度热力图（学生 × 题目，0-1 参与强度） */
        heatmap: Array<{
            studentId: string
            studentName: string
            /** 每题的参与强度 0-1 */
            cells: number[]
        }>
    }
    /** Bloom 覆盖雷达 */
    bloomCoverage: Record<BloomLevel, number>
    /** 难度分析 */
    difficultyAnalysis: DifficultyAnalysisItem[]
    /** AI 建议采纳统计 */
    aiSuggestionStats: AISuggestionStats
    /** 时间分配 */
    timeAllocation: TimeAllocationItem[]
    /** 改进建议（AI 流式生成） */
    improvementSuggestions: string
    aiGenerated: true
}

/** POST /report/generate 响应 */
export interface AfterActionReportGenerateResponse {
    lessonId: string
    report: AfterActionReportData
    generatedAt: number
}

/** GET /report 响应（复盘报告） */
export interface AfterActionReportGetResponse {
    lessonId: string
    report: AfterActionReportData
}

/* ============================================================
 * 智能批改台 Grading 类型（Task 12）
 * 与后端 backend/src/routes/grading.ts 保持一致
 * ============================================================ */

/** 批次状态 */
export type GradingBatchStatus = 'uploading' | 'recognizing' | 'grading' | 'reviewing' | 'completed'

/** 教师审核动作 */
export type ReviewAction = 'confirm' | 'modify' | 'reference'

/** 已上传文件元数据（前端视角） */
export interface GradingFile {
    id: string
    /** 前端可访问的相对 URL（/api/grading/files/:fileId） */
    url: string
    fileName?: string
}

/** 单条识别结果 */
export interface RecognizedItem {
    fileId: string
    /** 教师确认的学生归属；提供后批改结果才会进入该生长期档案 */
    studentId?: string
    /** 自动匹配的题目 ID（未匹配则为 undefined） */
    questionId?: string
    /** 识别出的学生答案文本 */
    studentAnswer: string
    confidence: number
    /** 如未匹配到题目则为 true */
    needsManualMatch: boolean
}

export interface GradingStudentOption {
    id: string
    name: string
}

export interface GradingQuestionOption {
    id: string
    stem: string
    bloomLevel: BloomLevel
    type: string
}

export interface GradingBatchHistoryItem {
    batchId: string
    classId: string
    lessonId?: string
    questionId?: string
    poemId?: string
    questionStem?: string
    status: GradingBatchStatus
    fileCount: number
    recognizedCount: number
    resultCount: number
    reviewedCount: number
    needsReview: number
    createdAt: number
    updatedAt: number
}

/** 单条批改结果 */
export interface GradingResult {
    fileId: string
    studentId?: string
    questionId: string
    correct: boolean
    partialScore?: number
    cognitiveAttribution: string
    feedback: string
    teacherHint: string
    confidence: number
    needsHumanReview: boolean
    aiGenerated: true
    /** 教师审核状态 */
    reviewed?: boolean
    /** 审核动作 */
    reviewAction?: ReviewAction
    /** 教师修正的反馈 */
    teacherFeedback?: string
    /** 教师修正的认知归因 */
    teacherAttribution?: string
}

/** 批次统计摘要 */
export interface GradingSummary {
    total: number
    correct: number
    partial: number
    wrong: number
    needsReview: number
    avgConfidence: number
}

/** /upload 响应 */
export interface UploadResponse {
    status: 'ok'
    batchId: string
    uploadedFiles: Array<{ id: string; url: string }>
    pendingRecognition: number
}

/** /recognize 响应 */
export interface RecognizeResponse {
    status: 'ok'
    recognized: RecognizedItem[]
    aiGenerated: true
}

/** /grade 请求单条 */
export interface GradeRequestItem {
    fileId: string
    questionId: string
    studentId?: string
    studentAnswer: string
}

/** /grade 响应 */
export interface GradeResponse {
    status: 'ok'
    results: GradingResult[]
    summary: GradingSummary
}

/** /review 请求 */
export interface ReviewRequest {
    fileId: string
    batchId: string
    correct?: boolean
    feedback?: string
    cognitiveAttribution?: string
    action?: ReviewAction
}

/** /review 权威响应：供前端替换乐观结果并重算汇总，防止界面与持久化事实漂移。 */
export interface ReviewResponse {
    status: 'ok'
    success: true
    batchStatus: GradingBatchStatus
    result: GradingResult
    summary: GradingSummary
}

/** /batch/:batchId 响应 */
export interface GradingBatch {
    status: 'ok'
    batchId: string
    classId: string
    lessonId?: string
    questionId?: string
    poemId?: string
    questionStem?: string
    batchStatus: GradingBatchStatus
    progress: { total: number; done: number }
    files: GradingFile[]
    recognized: RecognizedItem[]
    results: GradingResult[]
    summary: GradingSummary
}

/** 认知归因统计项（用于 GradingStats Top N） */
export interface CognitiveAttributionStat {
    label: string
    count: number
}

/* ============================================================
 * 六阶命题工坊 Workbench 类型（Task 10）
 * 与后端 backend/src/routes/workbench.ts 保持一致
 * ============================================================ */

/** 年级分段 */
export type WorkbenchGradeLevel = '1-2年级' | '3-4年级' | '5-6年级'

/** 题目类型 */
export type WorkbenchQuestionType = '选择' | '填空' | '配对' | '简答' | '创作' | '应用'

/** 布鲁姆六阶权重（各阶 0-100） */
export interface WorkbenchBloomWeights {
    记忆: number
    理解: number
    应用: number
    分析: number
    评价: number
    创造: number
}

/** 命题工坊题目（与后端 Question 对齐） */
export interface WorkbenchQuestion {
    id: string
    poemId: string
    bloomLevel: BloomLevel
    type: WorkbenchQuestionType
    stem: string
    options?: string[]
    answer: string
    analysis: string
    distractorsAnalysis?: string[]
    difficulty: 1 | 2 | 3 | 4 | 5
    estimatedTimeSec: number
    aiGenerated: true
}

/** 验收问题项 */
export interface WorkbenchVerifyIssue {
    severity: 'low' | 'medium' | 'high'
    description: string
    suggestion: string
}

/** 验收结果 */
export interface WorkbenchVerification {
    targetAgentId: string
    verdict: 'pass' | 'revise' | 'reject'
    score: number
    strengths: string[]
    issues: WorkbenchVerifyIssue[]
    revisedOutput?: unknown
    aiGenerated: true
    confidence: number
}

/** 多智能体任务状态（WebSocket 推送） */
export interface WorkbenchAgentTask {
    taskId: string
    agentId: string
    status: 'pending' | 'running' | 'success' | 'failed' | 'skipped'
    startedAt?: number
    endedAt?: number
    error?: string
}

/** /generate 请求体 */
export interface WorkbenchGenerateRequest {
    poemId: string
    gradeLevel: WorkbenchGradeLevel
    questionTypes: WorkbenchQuestionType[]
    bloomWeights: WorkbenchBloomWeights
    count: number
    teacherId: string
    classId?: string
    excludeUsedQuestions?: string[]
}

/** /generate 响应 */
export interface WorkbenchGenerateResponse {
    sessionId: string
    aiGenerated: true
}

/** /refine 请求体 */
export interface WorkbenchRefineRequest {
    question: WorkbenchQuestion
    instruction: string
    poemId: string
    gradeLevel: WorkbenchGradeLevel
    teacherId: string
}

/** /refine 响应 */
export interface WorkbenchRefineResponse {
    original: WorkbenchQuestion
    refined: WorkbenchQuestion
    aiGenerated: true
}

/** /questions 响应 */
export interface WorkbenchQuestionsResponse {
    sessionId: string
    questions: WorkbenchQuestion[]
    verification?: WorkbenchVerification
    coverage?: WorkbenchBloomWeights
    aiGenerated: true
}

/** /export 请求体 */
export interface WorkbenchExportRequest {
    questionIds: string[]
    format: 'json' | 'csv'
}

/** /export 响应 */
export interface WorkbenchExportResponse {
    format: 'json' | 'csv'
    count: number
    data: string
    aiGenerated: true
}

/** /publish 请求体 */
export interface WorkbenchPublishRequest {
    classId: string
    poemId: string
    teacherId: string
    questions: WorkbenchQuestion[]
    mode: ClassroomMode
    scheduledAt?: number
}

/** /publish 响应 */
export interface WorkbenchPublishResponse {
    lessonId: string
    questionIds: string[]
    aiGenerated: true
}

/** 古诗选项（下拉用） */
export interface WorkbenchPoemOption {
    id: string
    title: string
    poet: string
    dynasty: string
}

/** 布鲁姆六阶顺序与标签 */
export const WORKBENCH_BLOOM_TIERS: ReadonlyArray<{ key: keyof WorkbenchBloomWeights; label: BloomLevel }> = [
    { key: '记忆', label: '记忆' },
    { key: '理解', label: '理解' },
    { key: '应用', label: '应用' },
    { key: '分析', label: '分析' },
    { key: '评价', label: '评价' },
    { key: '创造', label: '创造' },
] as const

/** 布鲁姆六阶颜色映射（用于卡片左侧竖线与步骤条） */
export const WORKBENCH_BLOOM_COLORS: Record<BloomLevel, string> = {
    记忆: 'rgb(var(--c-accent-info))',
    理解: 'rgb(var(--c-accent-success))',
    应用: 'rgb(var(--c-accent-primary))',
    分析: 'rgb(var(--c-accent-warning))',
    评价: 'rgb(var(--c-accent-error))',
    创造: 'rgb(var(--c-accent-primary-hover))',
}

/** 三档预设权重 */
export const WORKBENCH_PRESETS: Record<string, { label: string; weights: WorkbenchBloomWeights }> = {
    basic: {
        label: '基础识记',
        weights: { 记忆: 40, 理解: 30, 应用: 20, 分析: 10, 评价: 0, 创造: 0 },
    },
    balanced: {
        label: '六阶均衡',
        weights: { 记忆: 17, 理解: 17, 应用: 17, 分析: 17, 评价: 16, 创造: 16 },
    },
    advanced: {
        label: '高阶挑战',
        weights: { 记忆: 5, 理解: 10, 应用: 15, 分析: 25, 评价: 25, 创造: 20 },
    },
}

/* ============================================================
 * 六阶命题工坊扩展类型（Task 21 + Task 22）
 *
 * 1. Agent 编排（POST /api/agents/orchestrate，SSE 流式）
 * 2. 题卡列表查询（GET /api/workbench/questions，分页/筛选/排序）
 * 3. 题卡质量验证（GET /api/workbench/questions/:id/verification，5 维度）
 * 4. 导出（POST /api/workbench/export，Word/Excel/PDF）
 * 5. 智能组卷（POST /api/workbench/smart-compose）
 * 6. 学生薄弱点（GET /api/students/:id/weak-points）
 * ============================================================ */

/** 命题工坊扩展题卡字段（在 WorkbenchQuestion 基础上增加元数据） */
export interface WorkbenchQuestionMeta extends WorkbenchQuestion {
    /** 知识点列表（与课程图谱节点对齐） */
    knowledgePoints: string[]
    /** 分值（默认 5 分） */
    score: number
    /** 收藏标记 */
    favorited: boolean
    /** 创建时间戳（ms） */
    createdAt: number
    /** 更新时间戳（ms） */
    updatedAt: number
}

/** 题卡收藏写入必须声明目标状态，网络重试不会产生二次翻转。 */
export interface WorkbenchFavoriteRequest {
    favorited: boolean
}

/** 服务端持久化后的权威收藏状态。 */
export interface WorkbenchFavoriteResponse {
    questionId: string
    favorited: boolean
}

/** Agent 编排任务类型（命题工坊固定 4 Agent） */
export type WorkbenchAgentKind = 'question_generator' | 'verifier' | 'refiner' | 'accepter'

/** Agent 编排任务状态 */
export type WorkbenchAgentStatus = 'pending' | 'running' | 'success' | 'failed'

/** Agent 编排 SSE 事件类型 */
export type WorkbenchAgentEventType =
    | 'agent:start'
    | 'agent:progress'
    | 'agent:output'
    | 'agent:done'
    | 'agent:failed'
    | 'session:end'
    | 'session:error'

/** Agent 编排 SSE 单帧事件 */
export interface WorkbenchAgentEvent {
    /** 事件类型 */
    type: WorkbenchAgentEventType
    /** 会话 ID */
    sessionId: string
    /** Agent 标识 */
    agentId?: WorkbenchAgentKind
    /** Agent 中文名 */
    agentLabel?: string
    /** 进度百分比 0-100 */
    progress?: number
    /** 流式输出文本增量 */
    delta?: string
    /** 累计输出文本（可选，由前端累加） */
    output?: string
    /** 状态 */
    status?: WorkbenchAgentStatus
    /** 错误信息（仅 agent:failed / session:error） */
    error?: string
    /** 时间戳（ms） */
    timestamp: number
    /** 耗时（ms，仅 agent:done） */
    elapsedMs?: number
}

/** Agent 编排 SSE 控制器 */
export interface WorkbenchAgentStreamController {
    abort: () => void
    get streaming(): boolean
}

/** Agent 编排 SSE 回调 */
export interface WorkbenchAgentStreamCallbacks {
    onEvent: (event: WorkbenchAgentEvent) => void
    onDone?: () => void
    onError?: (err: Error) => void
}

/** Agent 编排运行时态（前端维护的 DAG 节点状态） */
export interface WorkbenchAgentRuntime {
    agentId: WorkbenchAgentKind
    label: string
    desc: string
    icon: string
    status: WorkbenchAgentStatus
    progress: number
    output: string
    startedAt?: number
    endedAt?: number
    elapsedMs?: number
    error?: string
}

/** POST /api/agents/orchestrate 请求体 */
export interface WorkbenchAgentOrchestrateRequest {
    /** 任务类型，命题工坊恒为 question_generate */
    task: 'question_generate'
    /** 命题参数 */
    params: {
        poemId: string
        gradeLevel: WorkbenchGradeLevel
        questionTypes: WorkbenchQuestionType[]
        bloomWeights: WorkbenchBloomWeights
        count: number
        teacherId: string
        classId?: string
        excludeUsedQuestions?: string[]
    }
}

/** GET /api/workbench/questions 查询参数 */
export interface WorkbenchQuestionQuery {
    page?: number
    pageSize?: number
    type?: WorkbenchQuestionType
    difficulty?: 1 | 2 | 3 | 4 | 5
    knowledgePoint?: string
    sortBy?: 'difficulty' | 'createdAt' | 'score'
    sortOrder?: 'asc' | 'desc'
    sessionId?: string
}

/** GET /api/workbench/questions 响应 */
export interface WorkbenchQuestionListResponse {
    questions: WorkbenchQuestionMeta[]
    total: number
    page: number
    pageSize: number
}

/** GET /api/workbench/questions/:id/verification 响应（5 维度质量验证） */
export interface WorkbenchQuestionVerification {
    questionId: string
    /** 难度系数 0-1（越高越难） */
    difficulty: number
    /** 区分度 0-1（越高区分越好） */
    discrimination: number
    /** 知识点覆盖率 0-100 */
    coverage: number
    /** 答案正确性 */
    correctness: boolean
    /** 题目表述清晰度 0-100 */
    clarity: number
    /** 总评分 0-100 */
    overallScore: number
    /** 验证时间戳 */
    verifiedAt: number
}

/** POST /api/workbench/export 请求体（Word .doc / Excel .csv / PDF 打印版 .html） */
export interface WorkbenchDocExportRequest {
    questionIds: string[]
    format: 'word' | 'excel' | 'pdf' | 'json' | 'csv'
    includeAnswer: boolean
    includeAnalysis: boolean
    /** 排版样式 */
    layout?: 'A4' | 'B5'
}

/** POST /api/workbench/export 响应（Blob 文件流） */
export interface WorkbenchDocExportResponse {
    blob: Blob
    filename: string
    count: number
}

/** POST /api/workbench/smart-compose 请求体 */
export interface WorkbenchSmartComposeRequest {
    totalCount: number
    difficultyDistribution: { easy: number; medium: number; hard: number }
    knowledgePoints: string[]
    totalScore: number
    poemId?: string
}

/** POST /api/workbench/smart-compose 响应 */
export interface WorkbenchSmartComposeResponse {
    paper: WorkbenchQuestionMeta[]
    coverage: number
    difficultyChart: { easy: number; medium: number; hard: number }
    totalScore: number
}

/** GET /api/students/:id/weak-points 响应 */
export interface StudentWeakPointsResponse {
    studentId: string
    studentName: string
    weakPoints: StudentWeakPoint[]
}

/** 学生薄弱知识点单项 */
export interface StudentWeakPoint {
    /** 知识点名称 */
    knowledge: string
    /** 掌握度 0-100（越低越薄弱） */
    level: number
    /** 关联诗篇 ID */
    poemId?: string
    /** 推荐 Bloom 层级 */
    bloomLevel?: BloomLevel
}

/** 学生选项（推荐 AI 学生选择 Combobox 用） */
export interface StudentOption {
    id: string
    name: string
    classId?: string
    className?: string
}

/** 推荐题卡单项（含推荐理由 + 匹配度） */
export interface RecommendedQuestion extends WorkbenchQuestionMeta {
    /** 推荐理由 */
    reason: string
    /** 难度匹配度 0-100 */
    matchScore: number
    /** 命中的薄弱知识点 */
    matchedWeakPoints: string[]
}

/* ============================================================
 * AI 副驾 Copilot 类型（Task 13）
 * 与后端 backend/src/routes/copilot.ts、orchestrator/types.ts 对齐
 * ============================================================ */

/** 消息角色 */
export type CopilotMessageRole = 'user' | 'assistant' | 'system'

/** 聊天消息 */
export interface CopilotMessage {
    id: string
    role: CopilotMessageRole
    content: string
    timestamp: number
    /** 涉及的 Agent id 列表 */
    agentInvolved?: string[]
    /** 是否 AI 生成 */
    aiGenerated?: boolean
    /**
     * B2.1 真流式标记：是否为 /stream-chat SSE 真流式生成的消息。
     * - true：内容通过 LLM 流式分片实时累加，渲染时用 Markdown + 流式光标
     * - false/undefined：内容一次性确定，渲染时走 Typewriter 伪流式（fallback）
     */
    realStream?: boolean
}

/** 会话摘要（列表用） */
export interface CopilotSessionSummary {
    id: string
    title: string
    lastMessage: string
    updatedAt: number
}

/** 会话状态（与后端 SessionStatus 对齐） */
export type CopilotSessionStatus =
    | 'idle'
    | 'planning'
    | 'executing'
    | 'paused'
    | 'completed'
    | 'aborted'

/** 会话详情 */
export interface CopilotSessionDetail {
    id: string
    messages: CopilotMessage[]
    orchestrationLog: WSEvent[]
    createdAt: number
    status: CopilotSessionStatus
}

/** 快捷指令类型 */
export type CopilotQuickAction =
    | 'generate-questions'
    | 'grade-answers'
    | 'diagnose-class'
    | 'generate-report'
    | 'prepare-lesson'
    | 'create-materials'

/** /chat 请求体 */
export interface CopilotChatRequest {
    message: string
    sessionId?: string
    classId?: string
    teacherId?: string
    context?: {
        currentPage?: string
        selectedPoemId?: string
        selectedClassId?: string
    }
}

/** /chat 响应 */
export interface CopilotChatResponse {
    status: 'ok'
    sessionId: string
    parsedInstruction: ParsedInstruction
    copilotStatus: 'planning'
}

/** /sessions 响应 */
export interface CopilotSessionsResponse {
    status: 'ok'
    sessions: CopilotSessionSummary[]
}

/** /sessions/:id 响应 */
export interface CopilotSessionDetailResponse {
    status: 'ok'
    session: CopilotSessionDetail
}

/** /quick-action 请求体 */
export interface CopilotQuickActionRequest {
    action: CopilotQuickAction
    params?: {
        classId?: string
        poemId?: string
        studentId?: string
        [key: string]: unknown
    }
    teacherId?: string
}

/** /quick-action 响应 */
export interface CopilotQuickActionResponse {
    status: 'ok'
    sessionId: string
    prefillMessage: string
}

/** /feedback 请求体 */
export interface CopilotFeedbackRequest {
    sessionId: string
    taskId?: string
    agentId?: string
    feedbackType: 'good' | 'bad' | 'correction'
    content: string
}

/** /agent-labels 响应 */
export interface CopilotAgentLabelsResponse {
    status: 'ok'
    labels: Record<string, string>
}

/* ============================================================
 * B2.1 真流式 SSE 端点类型（/copilot/stream-chat）
 * 与后端 backend/src/llm/types.ts ChatChunk 对齐
 * ============================================================ */

/** 流式分片（与后端 ChatChunk 镜像） */
export interface CopilotStreamChunk {
    /** 正文本增量 */
    content?: string
    /** 思考过程增量（思考模式开启时） */
    reasoning?: string
    /** 是否为最终分片 */
    done?: boolean
    /** token 用量（仅最后一个分片） */
    usage?: {
        promptTokens: number
        completionTokens: number
        cachedTokens?: number
    }
    /** 错误信息（仅错误帧） */
    error?: string
    /** 错误消息（仅错误帧） */
    message?: string
    /** 服务端按能力改选模型的说明（仅首帧，且仅在确实改选时出现） */
    autoRouted?: AiAutoRouteNotice
}

/** /stream-chat 请求体 */
export interface CopilotStreamChatRequest {
    /** 对话消息数组 */
    messages: Array<{
        role: 'system' | 'user' | 'assistant' | 'tool'
        content: string
        name?: string
        tool_call_id?: string
    }>
    /** 会话 ID（可选，用于计费追踪） */
    sessionId?: string
    /** 教师 ID（可选） */
    teacherId?: string
    /** 采样温度 0-2 */
    temperature?: number
    /** 最大输出 token */
    maxTokens?: number
}

/** streamChat 返回的流式控制器 */
export interface CopilotStreamController {
    /** 中止流式请求 */
    abort: () => void
    /** 当前是否仍在接收 */
    readonly streaming: boolean
}

/** streamChat 回调配置 */
export interface CopilotStreamCallbacks {
    /** 收到一个分片 */
    onChunk: (chunk: CopilotStreamChunk) => void
    /** 流式完成（收到 [DONE] 或服务端关闭） */
    onDone?: () => void
    /** 错误回调 */
    onError?: (err: Error) => void
}

/* ============================================================
 * 通用 AI 对话流式类型（POST /api/ai/chat）
 *
 * 用于学情诊断页 SuggestionPanel 真实 AI 调用：
 * - 支持 deepseek-v4-pro / mimo-v2.5-pro 等模型
 * - 支持 thinking_mode（low/medium/high/max）
 * - SSE 流式输出，逐字推送
 * - 至少 3 轮上下文记忆（messages 数组）
 * ============================================================ */

/** AI 对话消息角色 */
export type AiChatRole = 'system' | 'user' | 'assistant' | 'tool'

/** AI 对话单条消息 */
/** 文本片段 */
export interface AiTextContentPart {
    type: 'text'
    text: string
}

/**
 * 图片片段
 *
 * url 必须是 data URL（`data:image/*;base64,...`）：
 * 云端模型要自己抓取图片，本机 http://localhost 的地址它够不到；
 * 后端也只放行 data URL，避免自己变成任意 URL 的抓取代理。
 */
export interface AiImageContentPart {
    type: 'image_url'
    image_url: { url: string; detail?: 'auto' | 'low' | 'high' }
}

export type AiContentPart = AiTextContentPart | AiImageContentPart

export interface AiChatMessage {
    role: AiChatRole
    /** 纯文本，或「文本 + 图片」的多模态片段数组 */
    content: string | AiContentPart[]
    name?: string
    tool_call_id?: string
}

/**
 * 服务端按能力自动改选模型的说明
 *
 * 依据《大模型API文档.md》，mimo-v2.5 是唯一多模态模型，
 * 带图请求会被服务端强制路由过去。界面必须如实展示这次改选，
 * 否则用户看到的模型名与真正作答的模型对不上。
 */
export interface AiAutoRouteNotice {
    from: string
    to: string
    reason: string
}

/** 思考模式（与 deepseek-v4-pro / mimo-v2.5-pro 对齐） */
export type AiThinkingMode = 'low' | 'medium' | 'high' | 'max' | null

/** AI 对话流式请求体 */
export interface AiChatStreamRequest {
    /** 对话消息数组（含历史上下文，至少 3 轮记忆） */
    messages: AiChatMessage[]
    /** 模型名称（默认 deepseek-v4-pro） */
    model?: string
    /** 思考模式：low/medium/high/max */
    thinking_mode?: AiThinkingMode
    /** 是否流式输出（恒为 true） */
    stream?: true
    /** 采样温度 0-2 */
    temperature?: number
    /** 最大输出 token */
    max_tokens?: number
    /** 会话 ID（可选，用于追踪） */
    session_id?: string
}

/** AI 对话流式分片（与后端 SSE 帧对齐） */
export interface AiChatStreamChunk {
    /** 正文本增量 */
    content?: string
    /** 思考过程增量（思考模式开启时） */
    reasoning?: string
    /** 是否为最终分片 */
    done?: boolean
    /** 模型名称（首个分片） */
    model?: string
    /** token 用量（仅最后一个分片） */
    usage?: {
        prompt_tokens: number
        completion_tokens: number
        cached_tokens?: number
    }
    /** 错误信息（仅错误帧） */
    error?: string
    /** 错误消息（仅错误帧） */
    message?: string
    /** 服务端按能力改选模型的说明（仅首帧，且仅在确实改选时出现） */
    autoRouted?: AiAutoRouteNotice
}

/** AI 对话流式控制器 */
export interface AiChatStreamController {
    /** 中止流式请求 */
    abort: () => void
    /** 当前是否仍在接收 */
    readonly streaming: boolean
}

/** AI 对话流式回调配置 */
export interface AiChatStreamCallbacks {
    /** 收到一个分片 */
    onChunk: (chunk: AiChatStreamChunk) => void
    /** 流式完成（收到 [DONE] 或服务端关闭） */
    onDone?: () => void
    /** 错误回调 */
    onError?: (err: Error) => void
}

/* ============================================================
 * v5.0 SubTask 27：诗篇重构 AI 能力扩展类型
 *
 * 端点：
 *  - POST /api/ai/image-generate（wan2.7-image）
 *  - POST /api/ai/tts（mimo-v2.5-tts）
 *  - POST /api/ai/asr（mimo-v2.5-asr）
 *
 * 模型约束（见《大模型API文档.md》）：
 *  - 仅使用 deepseek 系列 + mimo 系列
 *  - wan2.7-image 走阿里云 Workspace MaaS 北京端点，由后端代理
 *  - mimo-v2.5-tts / mimo-v2.5-asr 走 https://api.xiaomimimo.com/v1
 * ============================================================ */

export type AiDegradationReason =
    | 'demo-mode'
    | 'provider-unavailable'
    | 'provider-noncompliant'
    | 'provider-failed'

/** AI 生图请求体（wan2.7-image） */
export interface AiImageGenerateRequest {
    /** 文生图 prompt（基于诗词内容生成的画面描述） */
    prompt: string
    /** 图片方向：portrait 竖屏 / landscape 横屏，默认 landscape */
    orientation?: 'portrait' | 'landscape'
    /** 单次固定生成 1 张；多图由调用方按不同诗句并发请求 */
    n?: 1
    /** 关联诗 ID（用于服务端缓存与配额统计） */
    poemId?: string
    /** 关联诗句（用于图注展示） */
    verse?: string
}

/** 单张生成图片 */
export interface AiGeneratedImage {
    /** 图片 ID */
    id: string
    /** 图片 URL（可直链展示） */
    url: string
    /** 缩略图 URL（可选，用于网格预览） */
    thumbUrl?: string
    /** 生成所用 prompt（用于"为什么这样画"解释） */
    prompt: string
    /** 关联诗句（如有） */
    verse?: string
    /** 图片方向 */
    orientation: 'portrait' | 'landscape'
    /** 生成模型名 */
    model: string
    /** 原本请求的官方模型；降级时与实际处理器 model 分开记录 */
    requestedModel: 'wan2.7-image'
    /** 生成时间戳 */
    createdAt: number
    /** 是否命中服务端持久缓存 */
    cached: boolean
    /** 生图成功只允许真实模型结果 */
    aiGenerated: true
    /** 动态生图不以演示占位伪装成功 */
    demo: false
    /** 生图失败走非 2xx，不返回占位图片 */
    degraded: false
}

/** AI 生图响应体 */
export interface AiImageGenerateResponse {
    status: 'ok'
    /** 生成图片列表 */
    images: AiGeneratedImage[]
    /** 生成模型 */
    model: string
    /** 请求的官方模型 */
    requestedModel: 'wan2.7-image'
    /** 服务端请求 ID（用于排查） */
    requestId?: string
    aiGenerated: true
    demo: false
    degraded: false
}

/** AI TTS 请求体（mimo-v2.5-tts） */
export interface AiTtsRequest {
    /** 要合成语音的文本（诗词内容） */
    text: string
    /** MiMo 音色 ID，默认 'mimo_default' */
    voice?: string
    /** 语速 0.5-2.0，默认 1.0 */
    speed?: number
    /** 输出格式，默认 'mp3' */
    responseFormat?: 'mp3' | 'wav'
    /** 关联诗 ID（用于缓存） */
    poemId?: string
}

/** AI TTS 响应体 */
export interface AiTtsResponse {
    status: 'ok'
    /** 音频 Blob URL（可直链 <audio src>；调用方替换或卸载时须 revoke） */
    audioUrl: string
    /** 音频时长（毫秒） */
    durationMs: number
    /** 是否命中缓存 */
    cached: boolean
    /** 生成模型 */
    model: string
    /** 服务端真实模型为 true；明确的离线 DEMO 静音兜底为 false */
    aiGenerated: boolean
}

/** AI ASR 请求体（mimo-v2.5-asr）
 *  multipart/form-data 上传，此处仅描述元数据字段 */
export interface AiAsrRequest {
    /** 关联诗 ID（可选，用于评分对比） */
    poemId?: string
    /** 用于对比的原文（可选，启用相似度评分） */
    referenceText?: string
    /** 语种提示 */
    language?: 'zh' | 'en'
    /** 最长 500 字的识别引导词 */
    prompt?: string
}

/** AI ASR 响应体 */
export interface AiAsrResponse {
    status: 'ok' | 'degraded'
    /** 转写文本 */
    transcript: string
    /** 音频时长（秒） */
    audioDurationSec: number
    /** 模型基于分段 logprob 推导的置信度 0-1（供应商提供时） */
    confidence?: number
    /** 与原文的相似度评分 0-100（仅当请求提供 referenceText 时返回） */
    similarityScore?: number
    /** 错字/漏字详情（仅当请求提供 referenceText 时返回） */
    diff?: Array<{
        type: 'missing' | 'wrong' | 'extra'
        position: number
        expected?: string
        actual?: string
    }>
    /** 生成模型 */
    model: string
    /** 请求的官方模型；降级态下实际 model 为 local-placeholder */
    requestedModel: 'mimo-v2.5-asr'
    aiGenerated: boolean
    demo: boolean
    degraded: boolean
    degradationReason?: AiDegradationReason
}

/* ============================================================
 * 编排官类型（前端镜像，与后端 orchestrator/types.ts 对齐）
 * 注意：SubTask.condition 为函数，不可序列化，前端恒为 undefined
 * ============================================================ */

/** 教师指令意图分类 */
export type Intent =
    | 'generate-questions'
    | 'grade-answers'
    | 'diagnose-class'
    | 'diagnose-student'
    | 'generate-report'
    | 'recommend-path'
    | 'vision-annotate'
    | 'evaluate-recitation'
    | 'generate-tts'
    | 'generate-creative'
    | 'composite'
    | 'unknown'

/** 子任务状态机 */
export type SubTaskStatus =
    | 'pending'
    | 'running'
    | 'paused'
    | 'success'
    | 'failed'
    | 'skipped'

/** DAG 中的子任务节点（前端镜像，condition 不可序列化） */
export interface SubTask {
    id: string
    agentId: string
    input: unknown
    dependencies: string[]
    condition?: undefined
    status: SubTaskStatus
    result?: unknown
    error?: string
    startedAt?: number
    endedAt?: number
}

/** DAG 边 */
export interface DAGEdge {
    from: string
    to: string
    condition?: string
}

/** 有向无环图 */
export interface DAG {
    nodes: SubTask[]
    edges: DAGEdge[]
}

/** 解析后的指令 */
export interface ParsedInstruction {
    intent: Intent
    subTasks: SubTask[]
    executionPlan: DAG
    estimatedAgents: string[]
    estimatedDurationMs: number
    confidence: number
}

/** 意图中文标签 */
export const INTENT_LABELS: Record<Intent, string> = {
    'generate-questions': '出题',
    'grade-answers': '批改',
    'diagnose-class': '班级诊断',
    'diagnose-student': '学生诊断',
    'generate-report': '教研报告',
    'recommend-path': '路径推荐',
    'vision-annotate': '视觉标注',
    'evaluate-recitation': '朗读评测',
    'generate-tts': '范读生成',
    'generate-creative': '创意素材',
    composite: '复合任务',
    unknown: '未识别',
}

/** Agent id → 中文标签映射（与后端 AGENT_LABELS 对齐） */
export const AGENT_LABELS: Record<string, string> = {
    'mind.profile': '诗心·画像',
    'mind.diagnose': '诗心·诊断',
    'mind.recommend': '诗心·推荐',
    'mind.verify': '诗心·验收',
    'eye.vision-annotate': '诗眼·标注',
    'eye.asr': '诗眼·识别',
    'eye.tts': '诗眼·范读',
    'brush.question': '诗笔·命题',
    'brush.grade': '诗笔·批改',
    'brush.report': '诗笔·报告',
    'brush.creative': '诗笔·创意',
    orchestrator: '编排官',
}

/** Agent 分类（用于协作可视化着色） */
export type AgentCategory = 'mind' | 'eye' | 'brush' | 'orchestrator'

/** 根据 agentId 推断分类 */
export function getAgentCategory(agentId: string): AgentCategory {
    if (agentId.startsWith('mind.')) return 'mind'
    if (agentId.startsWith('eye.')) return 'eye'
    if (agentId.startsWith('brush.')) return 'brush'
    return 'orchestrator'
}

/** Agent 图标名映射（用于协作可视化） */
export const AGENT_ICONS: Record<AgentCategory, string> = {
    mind: 'brain',
    eye: 'eye',
    brush: 'feather',
    orchestrator: 'gear',
}

/* ============================================================
 * 编排官 REST API 类型（前端调用 /api/orchestrator/* 用）
 * ============================================================ */

/** /execute 请求体 */
export interface OrchestratorExecuteRequest {
    sessionId: string
    plan: ParsedInstruction
    teacherId: string
    classId?: string
}

/** /execute 响应 */
export interface OrchestratorExecuteResponse {
    status: 'ok'
    message: string
    sessionId: string
}

/** /pause /resume 请求体 */
export interface OrchestratorTaskControlRequest {
    sessionId: string
    taskId: string
}

/** /abort 请求体 */
export interface OrchestratorAbortRequest {
    sessionId: string
    taskId?: string
}

/** /modify 请求体 */
export interface OrchestratorModifyRequest {
    sessionId: string
    taskId: string
    newInput: unknown
}

/** /sessions/:id 响应中的任务状态项（condition 已剥离） */
export interface OrchestratorTaskStateItem {
    id: string
    agentId: string
    input: unknown
    dependencies: string[]
    hasCondition: boolean
    condition?: undefined
    status: SubTaskStatus
    result?: unknown
    error?: string
    startedAt?: number
    endedAt?: number
}

/** /sessions/:id 响应 */
export interface OrchestratorSessionResponse {
    status: 'ok'
    session: {
        id: string
        teacherId: string
        classId?: string
        startedAt: number
        endedAt?: number
        status: CopilotSessionStatus
        currentPlan?: ParsedInstruction
        taskStates: OrchestratorTaskStateItem[]
        eventsCount: number
        reflections: unknown[]
        executionResult?: unknown
    }
}

/* ============================================================
 * 教研报告 Report 类型（Task 14）
 * 与后端 backend/src/routes/report.ts、
 *   backend/src/agents/brush-agent/report.sub-agent.ts、
 *   backend/src/agents/mind-agent/verify.sub-agent.ts、
 *   backend/src/db/utils/export.ts、
 *   backend/src/services/knowledge-graph/dark-matter-detector.ts 对齐
 * ============================================================ */

/** 报告模板类型（4 选 1） */
export type ReportTemplate = 'standard' | 'data-driven' | 'narrative' | 'executive'

/** 可包含的章节（多选） */
export type ReportSectionKey = 'background' | 'intervention' | 'evidence' | 'reflection'

/** 报告状态 */
export type ReportStatus = 'generating' | 'completed' | 'failed'

/** 布鲁姆六阶掌握度（中文键，与后端 BloomMastery 对齐） */
export interface ReportBloomMastery {
    记忆: number
    理解: number
    应用: number
    分析: number
    评价: number
    创造: number
}

/** 报告章节 */
export interface ReportSection {
    key: ReportSectionKey
    title: string
    content: string
}

/** brush.report 输出 */
export interface ReportOutput {
    title: string
    sections: ReportSection[]
    keyFindings: string[]
    recommendations: string[]
    dataAnonymized: true
    aiGenerated: true
}

/** mind.verify 验收结果 */
export interface ReportVerification {
    targetAgentId: string
    verdict: 'pass' | 'revise' | 'reject'
    score: number
    strengths: string[]
    issues: Array<{ severity: 'low' | 'medium' | 'high'; description: string; suggestion: string }>
    aiGenerated: true
    confidence: number
}

/** 暗物质 Top 模式 */
export interface DarkMatterPattern {
    pattern: string
    affectedStudents: number
    affectedPoems: string[]
    prescription: string
}

/** 暗物质诊断报告 */
export interface DarkMatterReport {
    classId: string
    totalDarkMatter: number
    byBloomLevel: Record<string, number>
    byTheme: Record<string, number>
    byImage: Record<string, number>
    topPatterns: DarkMatterPattern[]
}

/** 脱敏学生 */
export interface AnonymizedStudent {
    id: string
    anonymousName: string
}

/** 学生六阶雷达 */
export interface StudentRadar {
    studentId: string
    anonymousName: string
    radar: ReportBloomMastery
}

/** 脱敏学习事件 */
export interface AnonymizedEvent {
    id: number
    studentId: string
    anonymousName: string
    type: string
    action: string
    occurredAt: number
    poemId: string | null
}

/** 班级报告脱敏导出数据（供前端图表渲染） */
export interface ClassReportData {
    className: string
    classId: string
    period: { from: number; to: number }
    anonymizedStudents: AnonymizedStudent[]
    classBloomRadar: ReportBloomMastery
    studentRadars: StudentRadar[]
    events: AnonymizedEvent[]
    aiGenerated: true
}

/** 完整报告记录（与后端 ReportRecord 对齐） */
export interface ReportRecord {
    id: string
    teacherId: string
    classId: string
    className: string
    period: { from: number; to: number }
    template: ReportTemplate
    includeSections: ReportSectionKey[]
    status: ReportStatus
    output?: ReportOutput
    verification?: ReportVerification
    darkMatterReport?: DarkMatterReport
    exportedData?: ClassReportData
    error?: string
    progress: number
    createdAt: number
    updatedAt: number
}

/** 历史报告摘要（列表用，不含完整 output） */
export interface ReportSummary {
    id: string
    teacherId: string
    classId: string
    className: string
    template: ReportTemplate
    status: ReportStatus
    progress: number
    title?: string
    period: { from: number; to: number }
    createdAt: number
    updatedAt: number
    error?: string
}

/** 模板选项 */
export interface ReportTemplateOption {
    key: ReportTemplate
    label: string
}

/** 章节选项 */
export interface ReportSectionOption {
    key: ReportSectionKey
    label: string
}

/** 章节中文标题映射 */
export const REPORT_SECTION_TITLES: Record<ReportSectionKey, string> = {
    background: '教学背景',
    intervention: '干预策略',
    evidence: '数据实证',
    reflection: '反思展望',
}

/** 模板中文标签映射 */
export const REPORT_TEMPLATE_LABELS: Record<ReportTemplate, string> = {
    standard: '标准教研报告',
    'data-driven': '数据驱动型报告',
    narrative: '叙事型报告',
    executive: '摘要型报告',
}

/** 模板描述（用于生成表单的选择卡片） */
export const REPORT_TEMPLATE_DESCRIPTIONS: Record<ReportTemplate, string> = {
    standard: '四段式结构，适用于常规教研汇报',
    'data-driven': '侧重数据图表与量化分析',
    narrative: '叙事化表达，适用于案例分享',
    executive: '精简摘要，适用于管理层快速浏览',
}

/** 章节描述（用于生成表单的复选框提示） */
export const REPORT_SECTION_DESCRIPTIONS: Record<ReportSectionKey, string> = {
    background: '班级学情概况与教学目标',
    intervention: '采用的教学策略与课堂活动',
    evidence: '掌握度变化与认知分析数据',
    reflection: '教学反思与后续改进方向',
}

/** /generate 请求体 */
export interface ReportGenerateRequest {
    classId: string
    period: { from: string; to: string }
    template?: ReportTemplate
    includeSections?: ReportSectionKey[]
    teacherId: string
}

/** /generate 响应 */
export interface ReportGenerateResponse {
    reportId: string
    sessionId: string
    status: ReportStatus
    aiGenerated: true
}

/** /:reportId 响应 */
export interface ReportGetResponse {
    status: 'ok'
    report: ReportRecord
    aiGenerated: true
}

/** /templates 响应 */
export interface ReportTemplatesResponse {
    status: 'ok'
    templates: ReportTemplateOption[]
    sections: ReportSectionOption[]
}

/** / 历史列表响应 */
export interface ReportListResponse {
    status: 'ok'
    total: number
    limit: number
    offset: number
    items: ReportSummary[]
    aiGenerated: true
}

/** 导出格式（扩展：新增 Excel） */
export type ReportExportFormat = 'word' | 'pdf' | 'markdown' | 'excel'

/* ============================================================
 * v5.0 ReportPage 数据真实化：图表数据 / 家校联系本 / 历史筛选
 *
 * 与后端契约对齐：
 *   GET /api/report/:id/charts         → ReportChartsData
 *   GET /api/report/:id/preview        → ReportPreviewData（Markdown 文本流）
 *   POST /api/report/export/:reportId  → 结构化导出结果（打印版 HTML / CSV / Word 兼容 HTML）
 *   GET /api/report/home-school-book   → HomeSchoolBookData
 *   GET /api/report/history            → ReportHistoryResponse（支持筛选）
 * ============================================================ */

/** 班级整体成绩分布柱状图数据 */
export interface ScoreDistributionBin {
    /** 区间标签，如 "0-59" / "60-69" / "70-79" / "80-89" / "90-100" */
    label: string
    /** 区间下界（含） */
    min: number
    /** 区间上界（不含，最后一档为含） */
    max: number
    /** 落入该区间的学生数 */
    count: number
}

/** 知识点掌握度折线图数据 */
export interface KnowledgeMasteryPoint {
    /** 知识点名称（如"意象理解"、"修辞辨识"） */
    knowledge: string
    /** 班级平均掌握度（0-100） */
    mastery: number
    /** 上期掌握度（用于对比，可选） */
    previousMastery?: number
}

/** Bloom 分类分布饼图数据 */
export interface BloomDistributionSlice {
    /** Bloom 层级（中文键：记忆/理解/应用/分析/评价/创造） */
    level: string
    /** 该层级题目/活动占比（0-100） */
    percentage: number
    /** 该层级实际数量 */
    count: number
}

/** 周次对比多系列折线图数据 */
export interface WeeklyComparisonSeries {
    /** 系列名称（如"本周"、"上周" 或 "本班"、"年级均值"） */
    name: string
    /** 各周次数据点 */
    points: Array<{
        /** 周次标签（如 "第1周" / "W32"） */
        week: string
        /** 数值（掌握度 / 平均分 / 活跃度等，由图表标题决定语义） */
        value: number
    }>
}

/** GET /api/report/:id/charts 响应 */
export interface ReportChartsData {
    reportId: string
    classId: string
    className: string
    /** 班级整体成绩分布柱状图 */
    scoreDistribution: ScoreDistributionBin[]
    /** 知识点掌握度折线图 */
    knowledgeMastery: KnowledgeMasteryPoint[]
    /** Bloom 分类分布饼图 */
    bloomDistribution: BloomDistributionSlice[]
    /** 周次对比多系列折线图 */
    weeklyComparison: WeeklyComparisonSeries[]
    /** 数据生成时间戳（ms） */
    generatedAt: number
    /** AI 生成标记 */
    aiGenerated: true
}

/** GET /api/report/:id/preview 响应 */
export interface ReportPreviewData {
    reportId: string
    /** Markdown 全文（已包含标题、章节、关键发现、建议等） */
    markdown: string
    /** 是否流式输出（true 时 markdown 为增量片段） */
    streaming?: boolean
    /** 完成标记（流式结束时为 true） */
    done?: boolean
    /** AI 生成标记 */
    aiGenerated: true
}

// 说明：此处原有 `HomeSchoolStudentCard` 与 `HomeSchoolBookData` 两个类型，
// 描述的是一个后端从不存在的 `GET /report/home-school-book` 响应
// （teacherMessage / parentSuggestion / goalCompletionRate 等字段皆为虚构）。
// 家校联系本真实的数据结构是本文件下方的 `HomeSchoolWeekly`，
// 与 backend/src/services/profile/home-school-book.ts 逐字段对齐。

/** 历史报告筛选参数 */
export interface ReportHistoryQuery {
    teacherId?: string
    classId?: string
    /** 时间范围筛选（ISO 字符串） */
    from?: string
    to?: string
    /** 模板筛选 */
    template?: ReportTemplate
    /** 状态筛选 */
    status?: ReportStatus
    /** 关键词 */
    keyword?: string
    /** 分页 */
    limit?: number
    offset?: number
}

/** 历史报告响应（扩展自 ReportListResponse，增加 filter 元数据） */
export interface ReportHistoryResponse {
    total: number
    limit: number
    offset: number
    items: ReportSummary[]
    /** 当前筛选条件回显 */
    filters?: {
        classId?: string
        template?: ReportTemplate
        status?: ReportStatus
        from?: string
        to?: string
    }
    aiGenerated: true
}

/** POST /api/report/export/:reportId 请求 */
export interface ReportExportRequest {
    reportId: string
    format: ReportExportFormat
    /** 包含的模块（章节 key 数组，空表示全部） */
    includeSections?: ReportSectionKey[]
    /** 是否包含图表 */
    includeCharts?: boolean
    /** 是否包含验收信息 */
    includeVerification?: boolean
}

/* ============================================================
 * 诗音阁 Recitation 类型（Task 19）
 * 与后端 backend/src/routes/recitation.ts 保持一致
 *
 * 语音核心：mimo-v2.5-asr 朗读转写 + 诗心 Agent 评估发音/节奏/情感
 *           + mimo-v2.5-tts 标准范读生成 + 朗读排行榜
 * ============================================================ */

/** 可朗读诗选项（列表用） */
export interface RecitationPoem {
    id: string
    title: string
    poet: string
    dynasty: string
    content: string
    /** 题材标签（教材人工校订的受控词，如 ["节庆","春节"]），用于体裁着色与筛选 */
    theme?: string[]
    /** 修辞手法（教材人工校订，如 ["比喻","拟人"]） */
    rhetoric?: string[]
    /** 学段（如"三年级"） */
    gradeLevel?: string
    /** 当前学生是否已朗读过（前端展示徽章用） */
    recitedByStudent?: boolean
    /** 已缓存范读 URL（若有） */
    ttsAudioUrl?: string
}

/** TTS 范读生成请求体 */
export interface RecitationTtsRequest {
    poemId: string
    /** MiMo 音色 ID（可选，默认 mimo_default） */
    voice?: string
    /** 语速 0.5-2.0（可选，默认 0.9 适合古诗朗读） */
    speed?: number
    /** 输出格式 */
    format?: 'mp3' | 'wav'
}

/** TTS 范读生成响应 */
export interface RecitationTtsResponse {
    status: 'ok'
    audioUrl: string
    durationMs: number
    /** 是否命中缓存（命中时不消耗 TTS 配额） */
    cached: boolean
    aiGenerated: boolean
}

/** ASR 转写响应（multipart 上传后返回） */
export interface RecitationAsrResponse {
    status: 'ok'
    /** 学生朗读音频的受保护 API URL（/api/recitation/audio/recitations/xxx.webm） */
    audioUrl: string
    /** 转写文本 */
    transcript: string
    /** 音频时长（秒） */
    audioDurationSec: number
    aiGenerated: boolean
}

/** 朗读评估请求体 */
export interface RecitationEvaluateRequest {
    studentId: string
    poemId: string
    /** 学生朗读音频的受保护 API 路径（由 /asr/transcribe 返回） */
    audioUrl: string
    /** 已转写的文本（若来自 /asr/transcribe，避免重复 ASR） */
    transcript?: string
    /** 音频时长（秒，来自 /asr/transcribe） */
    audioDurationSec?: number
}

/** 单条朗读错误信息（ASR 评估阶段输出） */
export interface RecitationMistake {
    /** 错误类型：字音/节奏/情感 */
    type: 'pronunciation' | 'rhythm' | 'emotion' | 'text'
    /** 错误位置描述 */
    position?: string
    /** 错误详情 */
    detail: string
    /** 修正建议 */
    suggestion?: string
}

/** 朗读评估响应（三维评分 + 综合分 + 建议） */
export interface RecitationEvaluateResponse {
    status: 'ok'
    recitationId: string
    transcript: string
    /** 发音得分 0-100 */
    pronunciation: number
    /** 节奏得分 0-100 */
    rhythm: number
    /** 情感得分 0-100 */
    emotion: number
    /** 综合得分（三维加权 0.4/0.3/0.3） */
    overallScore: number
    mistakes: RecitationMistake[]
    /** AI 或本地降级规则给出的改进建议 */
    suggestion: string
    audioDurationSec: number
    aiGenerated: boolean
}

/** 朗读历史条目 */
export interface RecitationHistoryEntry {
    id: string
    poemId: string
    poemTitle: string
    poet: string
    dynasty: string
    audioUrl: string | null
    transcript: string | null
    pronunciationScore: number | null
    rhythmScore: number | null
    emotionScore: number | null
    overallScore: number | null
    suggestion: string | null
    audioDurationSec: number | null
    createdAt: number
    aiGenerated: boolean
}

/** 朗读历史响应 */
export interface RecitationHistoryResponse {
    status: 'ok'
    history: RecitationHistoryEntry[]
}

/** 排行榜条目（学生姓名已脱敏为"学生H01"格式） */
export interface RecitationLeaderboardEntry {
    rank: number
    recitationId: string
    studentId: string
    /** 脱敏姓名，如"学生H01" */
    anonymousName: string
    poemId: string
    poemTitle: string
    poet: string
    /** 综合得分（三维加权） */
    overallScore: number
    pronunciationScore: number
    rhythmScore: number
    emotionScore: number
    createdAt: number
    aiGenerated: boolean
}

/** 排行榜响应 */
export interface RecitationLeaderboardResponse {
    status: 'ok'
    leaderboard: RecitationLeaderboardEntry[]
    aiGenerated: boolean
}

/** 朗读音频对比响应（学生原音 + 范读） */
export interface RecitationAudioResponse {
    status: 'ok'
    recitationId: string
    /** 学生朗读音频 URL */
    studentAudioUrl: string | null
    /** 标准范读 URL（若已生成） */
    ttsAudioUrl: string | null
    transcript: string | null
    poemId: string
}

/** 删除朗读记录响应 */
export interface RecitationDeleteResponse {
    status: 'ok'
    recitationId: string
    deleted: true
}

/** 诗列表响应 */
export interface RecitationPoemsResponse {
    status: 'ok'
    poems: RecitationPoem[]
}

/** 朗读评估维度（用于 UI 着色与图标映射） */
export type RecitationDimension = 'pronunciation' | 'rhythm' | 'emotion'

/** 朗读评估维度中文标签 */
export const RECITATION_DIMENSION_LABELS: Record<RecitationDimension, string> = {
    pronunciation: '发音',
    rhythm: '节奏',
    emotion: '情感',
}

/** 朗读评估维度图标映射 */
export const RECITATION_DIMENSION_ICONS: Record<RecitationDimension, string> = {
    pronunciation: 'waveform',
    rhythm: 'metronome',
    emotion: 'heart',
}

/** 朗读评估维度颜色映射（用于分数环与进度条） */
export const RECITATION_DIMENSION_COLORS: Record<RecitationDimension, string> = {
    pronunciation: 'rgb(var(--c-accent-primary))',
    rhythm: 'rgb(var(--c-accent-info))',
    emotion: 'rgb(var(--c-accent-error))',
}

/** 综合得分分级（用于排行榜徽章与色彩） */
export type RecitationScoreTier = 'excellent' | 'good' | 'fair' | 'needs-improvement'

/** 按综合得分判定分级 */
export function classifyRecitationScore(score: number): RecitationScoreTier {
    if (score >= 90) return 'excellent'
    if (score >= 75) return 'good'
    if (score >= 60) return 'fair'
    return 'needs-improvement'
}

/** 分级中文标签 */
export const RECITATION_TIER_LABELS: Record<RecitationScoreTier, string> = {
    excellent: '优秀',
    good: '良好',
    fair: '合格',
    'needs-improvement': '待提升',
}

/** 录音状态机 */
export type RecordingState = 'idle' | 'requesting' | 'recording' | 'stopping' | 'error'

/** 录音会话元数据（前端 MediaRecorder 状态） */
export interface RecordingSession {
    state: RecordingState
    /** 已录制时长（秒，实时更新） */
    durationSec: number
    /** 麦克风音量（0-1，用于波形可视化） */
    volume: number
    /** 错误信息（state === 'error' 时） */
    error: string | null
}



/* ============================================================
 * 认知诊断中心 Diagnosis 类型（Task 17）
 * 与后端 backend/src/routes/diagnosis.ts、
 *   backend/src/services/knowledge-graph/dark-matter-detector.ts 对齐
 *
 * 设计要点：
 *  - 所有响应携带 aiGenerated: false（算法计算结果，非 AI 生成）
 *  - 学生姓名一律脱敏为 anonymousName（"学生H01"格式）
 *  - 六阶使用中文键，与 BloomLevel 对齐
 * ============================================================ */

/** 诊断中心 Tab 类型（spec v7：移除 dark-matter 与 suggestion，精简为三 Tab；建议提升至 Dashboard 顶层 Tab） */
export type DiagnosisTab = 'class' | 'student' | 'learning-path'

/** 认知暗物质单条（与后端 DarkMatter 对齐） */
export interface DarkMatter {
    id: string
    classId: string
    /** 模式描述，如"含'月'意象的诗在'分析'层卡顿" */
    pattern: string
    bloomLevel: string
    affectedPoems: Array<{ poemId: string; title: string }>
    affectedStudents: string[]
    /** 0-1，受影响学生占全班比例 */
    affectedRatio: number
    /** 推测的根因 */
    rootCause: string
    /** 靶向处方（具体可执行的教学干预建议） */
    prescription: string
    detectedAt: number
}

/** 学生个体知识漏洞（与后端 StudentGap 对齐） */
export interface StudentGap {
    poemId: string
    bloomLevel: string
    /** 相关的其他诗/意象/主题（说明漏洞的"辐射范围"） */
    relatedWeaknesses: string[]
    /** 建议学习路径（图谱节点 ID 序列，从易到难） */
    suggestedPath: string[]
}

/** 六阶分布单项 */
export interface BloomDistributionLevel {
    level: BloomLevel
    /** 该阶层平均掌握度 0-100 */
    avg: number
    /** 标准差（反映班级内部离散程度） */
    stdDev: number
    /** 该阶层有记录的学生数 */
    studentCount: number
}

/** 班级六阶能力分布响应 */
export interface BloomDistributionResponse {
    classId: string
    levels: BloomDistributionLevel[]
    aiGenerated: false
}

/** 热力图学生行 */
export interface HeatmapStudent {
    id: string
    anonymousName: string
}

/** 热力图诗列 */
export interface HeatmapPoem {
    id: string
    title: string
    poet: string
}

/** 热力图单元格 */
export interface HeatmapCell {
    studentId: string
    poemId: string
    bloomLevel: BloomLevel
    score: number
}

/** 班级热力图响应 */
export interface HeatmapResponse {
    classId: string
    students: HeatmapStudent[]
    poems: HeatmapPoem[]
    cells: HeatmapCell[]
    aiGenerated: false
}

/** 学习路径节点 */
export interface LearningPathNode {
    poemId: string
    title: string
    poet: string
    dynasty: string
    difficulty: number
    /** 当前学生在该诗的综合掌握度（六阶均值），无记录为 0 */
    currentMastery: number
    /** 推荐理由 */
    reason: string
    /** 与薄弱诗的关联类型（如有） */
    relationType?: string
    /** 关联强度（如有） */
    strength?: number
}

/** 学生认知画像响应 */
export interface StudentProfileResponse {
    studentId: string
    anonymousName: string
    /** 六阶雷达（所有诗的六阶均值） */
    bloomRadar: Record<BloomLevel, number>
    /** 知识漏洞列表 */
    gaps: StudentGap[]
    /** 推荐学习路径节点 */
    learningPath: LearningPathNode[]
    aiGenerated: false
}

/** 推荐学习路径响应 */
export interface LearningPathResponse {
    studentId: string
    anonymousName: string
    path: LearningPathNode[]
    aiGenerated: false
}

/** 班级认知暗物质列表响应 */
export interface DarkMatterListResponse {
    classId: string
    darkMatter: DarkMatter[]
    aiGenerated: false
}

/** 暗物质汇总报告响应（扩展 DarkMatterReport，附加 aiGenerated 标记） */
export interface DarkMatterReportResponse extends DarkMatterReport {
    aiGenerated: false
}

/** 学生知识漏洞响应 */
export interface StudentGapsResponse {
    studentId: string
    anonymousName: string
    gaps: StudentGap[]
    aiGenerated: false
}

/** 靶向处方详情响应 */
export interface PrescriptionResponse {
    prescription: DarkMatter | null
    aiGenerated: false
}

/** 诊断中心加载态键名联合类型 */
export type DiagnosisLoadingKey =
    | 'bloomDistribution'
    | 'heatmap'
    | 'studentProfile'
    | 'studentGaps'
    | 'darkMatter'
    | 'darkMatterReport'
    | 'learningPath'
    | 'students'
    | 'suggestions'
    // 批改诊断深化能力：多维度评分 / 手写识别 / 错题归因
    | 'multiDimScore'
    | 'ocr'
    | 'errorAttribution'
    // 批改诊断深化能力：学习路径生成 / 个性化处方
    | 'aiLearningPath'
    | 'prescription'
    // v5.0 学情诊断 AI 建议流式
    | 'aiSuggestion'

/* ============================================================
 * 批改诊断深化能力 1/5：多维度评分
 * 与后端 backend/src/services/grading/multi-dimension-scorer.ts 对齐
 *
 * 六维度评分（准确性/完整性/理解力/表达力/创造性/文化敏感度）
 * 模型：deepseek-v4-pro（thinking: high）+ JSON Output
 * ============================================================ */

/** 评分维度标识 */
export type ScoreDimension =
    | 'accuracy'      // 准确性
    | 'completeness'  // 完整性
    | 'comprehension' // 理解力
    | 'expression'    // 表达力
    | 'creativity'    // 创造性
    | 'cultural'      // 文化敏感度

/** 维度中文标签映射 */
export const DIMENSION_LABELS: Record<ScoreDimension, string> = {
    accuracy: '准确性',
    completeness: '完整性',
    comprehension: '理解力',
    expression: '表达力',
    creativity: '创造性',
    cultural: '文化敏感度',
}

/** 默认权重（等权） */
export const DEFAULT_DIMENSION_WEIGHTS: Record<ScoreDimension, number> = {
    accuracy: 1,
    completeness: 1,
    comprehension: 1,
    expression: 1,
    creativity: 1,
    cultural: 1,
}

/** 单维度评分 */
export interface DimensionScore {
    dimension: ScoreDimension
    label: string
    score: number
    comment: string
    teachingHint: string
}

/** 多维度评分请求体 */
export interface MultiDimScoreRequest {
    fileId: string
    questionId: string
    studentAnswer: string
    weights?: Partial<Record<ScoreDimension, number>>
}

/** 多维度评分输出 */
export interface MultiDimScoreOutput {
    questionId: string
    dimensions: DimensionScore[]
    weightedTotal: number
    appliedWeights: Record<ScoreDimension, number>
    overallComment: string
    needsHumanReview: boolean
    aiGenerated: true
    confidence: number
}

/** 批量多维度评分请求 */
export interface BatchScoreRequest {
    items: MultiDimScoreRequest[]
    concurrency?: number
}

/** 批量多维度评分响应 */
export interface BatchScoreResponse {
    results: MultiDimScoreOutput[]
    totalCount: number
    successCount: number
    failedCount: number
    aiGenerated: true
}

/* ============================================================
 * 批改诊断深化能力 2/5：手写识别
 * 与后端 backend/src/services/grading/handwriting-ocr.ts 对齐
 *
 * 模型：mimo-v2.5（多模态）+ thinking: high
 * 输出：识别文本 + 整体置信度 + 逐字置信度 + 可疑字标记
 * ============================================================ */

/** 单字识别结果（含置信度） */
export interface CharRecognition {
    char: string
    confidence: number
    suspicious: boolean
    reason?: string
}

/** 手写识别请求体 */
export interface HandwritingOcrRequest {
    /** 仅允许格式与魔数匹配的 data:image/jpeg|png|webp;base64 内联图片。 */
    imageUrl: string
    detail?: 'auto' | 'low' | 'high'
    context?: string
    expectedRange?: string
}

/** 手写识别输出 */
export interface HandwritingOcrOutput {
    text: string
    confidence: number
    chars: CharRecognition[]
    suspiciousCount: number
    suspiciousIndices: number[]
    notes: string
    needsManualCheck: boolean
    aiGenerated: true
}

/** 批量识别请求 */
export interface BatchOcrRequest {
    items: HandwritingOcrRequest[]
    concurrency?: number
}

/** 批量识别响应 */
export interface BatchOcrResponse {
    results: HandwritingOcrOutput[]
    totalCount: number
    successCount: number
    failedCount: number
    aiGenerated: true
}

/* ============================================================
 * 批改诊断深化能力 3/5：错题归因
 * 与后端 backend/src/services/grading/error-attribution.ts 对齐
 *
 * 模型：deepseek-v4-pro（thinking: high）+ JSON Output
 * 五类错误：知识型 / 理解型 / 表达型 / 粗心型 / 文化型
 * ============================================================ */

/** 错误类型标识 */
export type ErrorType =
    | 'knowledge'       // 知识型
    | 'comprehension'   // 理解型
    | 'expression'      // 表达型
    | 'careless'        // 粗心型
    | 'cultural'        // 文化型

/** 错误类型中文标签 */
export const ERROR_TYPE_LABELS: Record<ErrorType, string> = {
    knowledge: '知识型错误',
    comprehension: '理解型错误',
    expression: '表达型错误',
    careless: '粗心型错误',
    cultural: '文化型错误',
}

/** 错题归因请求体 */
export interface ErrorAttributionRequest {
    fileId: string
    questionId: string
    studentAnswer: string
}

/** 次要错误类型项 */
export interface SecondaryErrorType {
    type: ErrorType
    label: string
    contribution: number
}

/** 关联知识图谱节点 */
export interface RelatedNode {
    type: 'poem' | 'image' | 'theme' | 'rhetoric' | 'era'
    id: string
    label: string
    relation: string
}

/** 教学干预建议项 */
export interface InterventionItem {
    type: 'review' | 'practice' | 'compare' | 'create' | 'discuss'
    label: string
    description: string
    estimatedMinutes: number
}

/** 错题归因输出 */
export interface ErrorAttributionOutput {
    questionId: string
    primaryErrorType: ErrorType
    primaryErrorLabel: string
    bloomLevel: string
    severity: number
    rootCause: string
    secondaryErrorTypes: SecondaryErrorType[]
    relatedNodes: RelatedNode[]
    interventions: InterventionItem[]
    isRecurring?: boolean
    aiGenerated: true
    confidence: number
}

/* ============================================================
 * 批改诊断深化能力 4/5：学习路径生成
 * 与后端 backend/src/services/grading/learning-path-generator.ts 对齐
 *
 * 模型：deepseek-v4-pro（thinking: high）+ JSON Output + SSE 流式
 * 输出：起点测试 + 薄弱点 + 学习序列 + 检查点
 * ============================================================ */

/** 学习路径节点状态 */
export type PathNodeStatus = 'completed' | 'in-progress' | 'pending' | 'locked'

/** 起点测试题 */
export interface DiagnosticTest {
    id: string
    poemId: string
    bloomLevel: string
    type: 'choice' | 'fill' | 'short-answer'
    stem: string
    estimatedTimeSec: number
}

/** 学习路径步骤 */
export interface LearningPathStep {
    step: number
    poemId: string
    title: string
    poet: string
    dynasty: string
    difficulty: number
    bloomLevel: string
    activity: string
    activityType: 'recite' | 'translate' | 'analyze' | 'compare' | 'create' | 'discuss' | 'practice'
    estimatedMinutes: number
    rationale: string
    currentMastery: number
    status: PathNodeStatus
    relatedWeakPoemId?: string
    relationType?: string
}

/** 检查点 */
export interface Checkpoint {
    order: number
    afterStep: number
    title: string
    assessment: string
    passingCriteria: string
    fallbackAction: string
}

/** 薄弱点识别项 */
export interface IdentifiedWeakness {
    bloomLevel: string
    description: string
    severity: number
    relatedPoemIds: string[]
}

/** AI 学习路径输出（区别于规则路径 LearningPathResponse） */
export interface LearningPathOutput {
    studentId: string
    anonymousName: string
    diagnosticTests: DiagnosticTest[]
    identifiedWeaknesses: IdentifiedWeakness[]
    path: LearningPathStep[]
    checkpoints: Checkpoint[]
    totalEstimatedMinutes: number
    designRationale: string
    aiGenerated: true
    generatedAt: number
}

/** 学习路径生成请求体 */
export interface LearningPathGenerateRequest {
    teacherIntent?: string
}

/* ============================================================
 * 批改诊断深化能力 5/5：个性化处方
 * 与后端 backend/src/services/grading/prescription-generator.ts 对齐
 *
 * 模型：deepseek-v4-pro（thinking: max，最高推理强度）+ JSON Output + SSE 流式
 * 输出：画像 / 优势 / 劣势 / 建议 / 推荐 / 活动 / SMART 目标
 * ============================================================ */

/** 学生画像模块 */
export interface StudentPortrait {
    summary: string
    cognitiveStyle: string
    recommendedPace: 'slow' | 'medium' | 'fast'
    currentStage: string
}

/** 优势项 */
export interface StrengthItem {
    description: string
    bloomLevel?: string
    evidence: string
}

/** 劣势项 */
export interface WeaknessItem {
    description: string
    bloomLevel?: string
    severity: number
    rootCause: string
}

/** 教学建议项 */
export interface SuggestionItem {
    title: string
    description: string
    category: 'reinforce' | 'extend' | 'remediate' | 'enrich' | 'pace'
    priority: 'high' | 'medium' | 'low'
    poemId?: string
    bloomLevel?: string
}

/** 资源推荐项 */
export interface RecommendationItem {
    title: string
    type: 'poem' | 'lesson' | 'exercise' | 'material' | 'activity'
    reason: string
    poemId?: string
    estimatedMinutes: number
}

/** 学习活动项 */
export interface ActivityItem {
    title: string
    type: 'recite' | 'translate' | 'analyze' | 'compare' | 'create' | 'discuss' | 'practice' | 'game'
    description: string
    steps: string[]
    estimatedMinutes: number
    poemId?: string
    bloomLevel?: string
}

/** SMART 目标项 */
export interface SmartGoal {
    title: string
    specific: string
    measurable: string
    achievable: string
    relevant: string
    timeBound: string
    verification: string
}

/** 个性化处方输出（区别于暗物质处方 PrescriptionResponse） */
export interface PrescriptionOutput {
    studentId: string
    anonymousName: string
    generatedAt: number
    portrait: StudentPortrait
    strengths: StrengthItem[]
    weaknesses: WeaknessItem[]
    suggestions: SuggestionItem[]
    recommendations: RecommendationItem[]
    activities: ActivityItem[]
    smartGoals: SmartGoal[]
    overallRationale: string
    aiGenerated: true
    confidence: number
}

/** 处方生成请求体 */
export interface PrescriptionGenerateRequest {
    teacherIntent?: string
}

/* ============================================================
 * 课前自学舱 SelfStudy 类型（Task 15）
 * 与后端 backend/src/routes/self-study.ts 保持一致
 *
 * 学生端核心入口：登录 → 前置诊断 → 识记闯关 → 朗读跟读 → 画像同步
 * 所有响应携带 aiGenerated: true（AI 生成或 AI 评估内容）
 * 学生姓名一律脱敏为 anonymousName
 * ============================================================ */

/**
 * 自学阶段（Phase 2 升级：新增 learn/dictation 两阶段）
 *
 * 完整学习闭环：登录 → 前置诊断 → 识记闯关 → **识字学诗** → **默写检测** → 朗读跟读 → 完成
 *
 * Phase 2 新增阶段的设计依据：
 * - learn（识字学诗）：诊断/闯关后学生已知薄弱点，此时展示带拼音原文+逐句译文+生字详解，
 *   实现"先测后教"的精准教学。此阶段是学生真正"学"内容的核心环节。
 * - dictation（默写检测）：默写是古诗教学的核心评估手段，区别于闯关的选择题，
 *   默写要求学生逐字回忆，检验记忆深度，并生成错字清单供后续间隔重复。
 */
export type SelfStudyStage =
    | 'login'
    | 'diagnose'
    | 'quest'
    | 'learn'
    | 'dictation'
    | 'recite'
    | 'appreciate'
    | 'completed'

/** 闯关题型分类 */
export type QuestType = 'pinyin' | 'fill-blank' | 'image-match'

/** 闯关题型中文标签 */
export const QUEST_TYPE_LABELS: Record<QuestType, string> = {
    pinyin: '字词注音',
    'fill-blank': '诗句填空',
    'image-match': '配图选择',
}

/** 学生登录请求体 */
export interface SelfStudyLoginRequest {
    studentId: string
    classCode: string
}

/** 学生登录响应 */
export interface SelfStudyLoginResponse {
    studentId: string
    anonymousName: string
    classId: string
    className: string
    sessionToken: string
}

/** 自学任务项 */
export interface SelfStudyTask {
    taskId: string
    poemId: string
    poemTitle: string
    poet: string
    dynasty: string
    status: 'pending' | 'ongoing' | 'completed'
    currentStage: SelfStudyStage
    masteryAvg?: number
    dueAt?: number
}

/** 任务列表响应 */
export interface SelfStudyTasksResponse {
    tasks: SelfStudyTask[]
}

/** 诊断题目（脱敏后，不含答案） */
export interface SelfStudyDiagnoseQuestion {
    id: string
    bloomLevel: BloomLevel
    type: string
    stem: string
    options?: string[]
    estimatedTimeSec: number
    difficulty: 1 | 2 | 3 | 4 | 5
    aiGenerated: true
}

/** 闯关题目（脱敏后，不含答案） */
export interface SelfStudyQuestQuestion extends SelfStudyDiagnoseQuestion {
    questType: QuestType
}

/* ============================================================
 * Phase 2：诗内容教学类型（识字 / 译文 / 默写）
 *
 * 设计依据（回应"我是学生，我需要什么才能深刻学会"的核心追问）：
 * 1. 汉字信息（CharacterInfo）：小学古诗含大量生僻字/多音字，学生需要拼音、释义、
 *    笔顺才能正确认读和书写。这是古诗学习的最基础层。
 * 2. 逐句译文（LineTranslation）：古诗语言精炼含蓄，学生需要逐句对照现代汉语才能
 *    理解诗意，而非死记硬背。理解是记忆的前提。
 * 3. 诗内容聚合（PoemContent）：将原文、拼音、译文、生字详解聚合为一体，
 *    供"识字学诗"阶段使用。
 * 4. 默写题（DictationQuestion）：区别于选择题的闯关，默写要求逐字回忆，
 *    是检验记忆深度的核心手段，生成错字清单供间隔重复。
 * ============================================================ */

/** 汉字难度分级（依据《义务教育语文课程标准》识字要求） */
export type CharacterDifficulty = 'common' | 'uncommon' | 'rare'

/** 单个汉字详细信息 */
export interface CharacterInfo {
    /** 汉字本身（单个字符） */
    char: string
    /** 拼音（含声调标记，如 "chuáng"） */
    pinyin: string
    /** 在该诗此语境下的释义 */
    meaning: string
    /** 词性（名/动/形/副/介/连/助/叹/数/量） */
    partOfSpeech: string
    /** 例词或该诗中的用法说明 */
    usage: string
    /** 难度分级 */
    difficulty: CharacterDifficulty
    /** 是否为多音字 */
    isPolyphone: boolean
    /** 多音字的其他读音（isPolyphone=true 时有效） */
    otherReadings?: string[]
    /** 笔顺动画 SVG 路径（可选，后端按需生成） */
    strokeOrderSvg?: string
    /** 是否为生字（小学阶段需重点识记） */
    isNew: boolean
}

/** 诗句逐行内容（原文 + 拼音 + 译文） */
export interface LineContent {
    /** 行号（从 0 开始） */
    lineIndex: number
    /** 原文诗句（如 "床前明月光"） */
    original: string
    /** 逐字拼音数组（与 original 等长，每个元素对应一个字的拼音） */
    pinyin: string[]
    /** 现代汉语译文（如 "床前洒满明月的光辉"） */
    translation: string
    /** 注释（该句中的关键词解释） */
    annotations?: Array<{
        word: string
        explanation: string
    }>
}

/** 诗内容聚合（识字学诗阶段使用） */
export interface PoemContent {
    poemId: string
    poemTitle: string
    poet: string
    dynasty: string
    /** 逐行内容（原文+拼音+译文） */
    lines: LineContent[]
    /** 生字/难字详细信息 */
    characters: CharacterInfo[]
    /** 全诗大意（整体翻译） */
    overallTranslation: string
    /** 主题思想 */
    theme: string
    /** 修辞手法分析 */
    rhetoricAnalysis?: Array<{
        type: string
        example: string
        effect: string
    }>
    /** AI 生成标记 */
    aiGenerated: boolean
    /** 原文是否完成逐首双信源与语文教师验收 */
    sourceVerification: {
        status: 'VERIFIED' | 'UNVERIFIED' | 'INCOMPLETE' | 'STALE'
        catalogScope: 'TEXTBOOK_CORE' | 'EXTENDED' | 'UNCLASSIFIED'
        contentSha256: string
        reviewedAt: string | null
        sourceTitles: string[]
        message: string
    }
    /** 拼音、译文和生字等教学内容的人工复核状态 */
    teachingContentReviewStatus: 'NOT_GENERATED' | 'AI_UNVERIFIED'
}

/** 脱敏运行证据：只含模型/Agent/版本/耗时/费用等白名单元数据。 */
export interface OrchestratorTraceEvent {
    id: string
    traceId: string
    sessionId: string
    type: string
    layer: 'orchestrator' | 'agent' | 'llm' | 'billing' | 'evaluation'
    phase: 'created' | 'approved' | 'start' | 'success' | 'retry' | 'error' |
        'fallback' | 'paused' | 'resumed' | 'aborted' | 'modified' | 'verified'
    timestamp: number
    agentId?: string
    taskId?: string
    domain?: string
    function?: string
    provider?: string
    model?: string
    thinking?: string
    promptVersion?: string
    latencyMs?: number
    costYuan?: number
    usage?: { promptTokens: number; completionTokens: number; cachedTokens: number }
    fallback?: boolean
    errorCategory?: string
    verdict?: 'pass' | 'revise' | 'reject'
    score?: number
}

export interface OrchestratorTraceResponse {
    status: 'ok'
    trace: {
        summary: {
            traceId: string
            sessionId: string
            status: 'planning' | 'running' | 'success' | 'error' | 'aborted'
            startedAt?: number
            lastEventAt?: number
            durationMs: number
            eventCount: number
            llmCalls: number
            agentCalls: number
            retries: number
            errors: number
            fallbacks: number
            evaluations: number
            totalTokens: number
            costYuan: number
            promptVersions: string[]
            models: string[]
        }
        events: OrchestratorTraceEvent[]
        privacy: {
            rawPromptsStored: false
            rawOutputsStored: false
            studentIdentityStored: false
            policy: string
        }
        truncated: boolean
    }
}

/* ============================================================
 * Phase 4.3：课堂讲解工具类型（逐句讲解 + 正音）
 * 回应"我是老师，这篇诗课堂上如何逐句讲"的核心追问
 * ============================================================ */

/** 正音要点（单个字的发音指导） */
export interface PronunciationNote {
    /** 需要注意的字 */
    char: string
    /** 正确拼音（含声调） */
    correctPinyin: string
    /** 常见错误读音 */
    commonError: string
    /** 正音说明（为什么容易读错、如何纠正） */
    note: string
}

/** 单句讲解数据 */
export interface ExplainLine {
    /** 行号（与 LineContent.lineIndex 对齐） */
    lineIndex: number
    /** 教学要点（教师讲解时需重点强调的内容） */
    teachingPoints: string[]
    /** 正音要点（本句中需要特别注意发音的字） */
    pronunciationNotes: PronunciationNote[]
    /** 讨论提示（引导学生思考的问题） */
    discussionPrompts: string[]
    /** 意象分析（本句中的关键意象及其文化内涵） */
    imageryAnalysis?: string
}

/** 课堂讲解响应 */
export interface ExplainResponse {
    poemId: string
    poemTitle: string
    poet: string
    /** 逐句讲解数据 */
    lines: ExplainLine[]
    /** 全诗教学建议（整体讲解策略） */
    overallTeachingAdvice: string
    /** 建议讲解时长（分钟） */
    suggestedDurationMin: number
    /** AI 生成标记 */
    aiGenerated: boolean
}

/* ============================================================
 * Phase 4.4：鉴赏指导类型（学生闭环 S5 —— 运用）
 * 回应"我是学生，我该如何学会鉴赏古诗"的核心追问
 * 依据《义务教育语文课程标准(2022年版)》古诗词鉴赏要求：
 *   感受形象 / 品味语言 / 体验情感 / 领悟意蕴
 * ============================================================ */

/** 鉴赏角度（四步鉴赏法） */
export type AppreciationAngle = 'imagery' | 'language' | 'emotion' | 'culture'

/** 关键字词品味（炼字分析） */
export interface AppreciationKeyWord {
    /** 字词 */
    word: string
    /** 所在诗句（可选，用于定位） */
    line?: string
    /** 这个字为什么用得好（炼字赏析） */
    why: string
}

/** 单个鉴赏引导项 */
export interface AppreciationGuideItem {
    /** 鉴赏角度 */
    angle: AppreciationAngle
    /** 角度中文标签 */
    angleLabel: string
    /** 引导问题（激发学生思考，不给答案） */
    guidingQuestion: string
    /** 鉴赏提示（如何思考这个问题） */
    hints: string[]
    /** 范例鉴赏（学生参考，培养鉴赏语言） */
    sampleAppreciation: string
    /** 关键字词品味（仅 language 角度有值） */
    keyWords?: AppreciationKeyWord[]
}

/** 鉴赏指导响应 */
export interface AppreciationGuideResponse {
    poemId: string
    poemTitle: string
    poet: string
    /** 四步鉴赏引导（imagery/language/emotion/culture） */
    guides: AppreciationGuideItem[]
    /** 整体鉴赏总结 */
    overallAppreciation: string
    /** 鉴赏方法口诀（便于小学生记忆） */
    methodRhyme: string
    /** AI 生成标记 */
    aiGenerated: boolean
}

/** 默写题型 */
export type DictationType = 'fill-line' | 'fill-char' | 'full-recall'

/** 默写题目 */
export interface DictationQuestion {
    id: string
    /** 默写类型：fill-line=填句（给上句写下句）/ fill-char=填字（给句子挖空填字）/ full-recall=全诗默写 */
    type: DictationType
    /** 题干（如 "请写出'床前明月光'的下一句" 或 "请补全：床前明__光"） */
    stem: string
    /** 标准答案（如 "疑是地上霜" 或 "月"） */
    answer: string
    /** 上下文提示（如该句的前一句） */
    hint?: string
    /** 该题对应的行号 */
    lineIndex: number
    /** 估计用时（秒） */
    estimatedTimeSec: number
}

/** 默写单题结果 */
export interface DictationQuestionResult {
    questionId: string
    /** 学生答案 */
    studentAnswer: string
    /** 是否正确 */
    correct: boolean
    /** 正确答案 */
    correctAnswer: string
    /** 错字清单（每个错字的位置和正确字） */
    wrongChars?: Array<{
        position: number
        studentChar: string
        correctChar: string
    }>
    /** AI 生成标记 */
    aiGenerated: boolean
}

/** 默写启动响应 */
export interface DictationStartResponse {
    sessionId: string
    poemId: string
    poemTitle: string
    questions: DictationQuestion[]
    aiGenerated: boolean
}

/** 默写提交响应 */
export interface DictationSubmitResponse {
    sessionId: string
    /** 总题数 */
    totalCount: number
    /** 正确数 */
    correctCount: number
    /** 默写得分（0-100） */
    score: number
    /** 逐题结果 */
    results: DictationQuestionResult[]
    /** 错字汇总（所有题的错字去重后，供间隔重复使用） */
    wrongCharsSummary: Array<{
        char: string
        correctCount: number
        wrongCount: number
    }>
    /** AI 生成标记 */
    aiGenerated: boolean
}

/** 诊断启动响应 */
export interface DiagnoseStartResponse {
    sessionId: string
    poemId: string
    poemTitle: string
    poet: string
    questions: SelfStudyDiagnoseQuestion[]
    aiGenerated: true
}

/** 诊断单题结果 */
export interface DiagnoseQuestionResult {
    questionId: string
    bloomLevel: BloomLevel
    correct: boolean
    feedback: string
}

/** 起点画像（六阶掌握度初值） */
export interface StartProfile {
    记忆: number
    理解: number
    应用: number
    分析: number
    评价: number
    创造: number
}

/** 诊断提交响应 */
export interface DiagnoseSubmitResponse {
    startProfile: StartProfile
    results: DiagnoseQuestionResult[]
    aiGenerated: true
}

/** 闯关启动响应 */
export interface QuestStartResponse {
    sessionId: string
    poemId: string
    poemTitle: string
    poet: string
    questions: SelfStudyQuestQuestion[]
    aiGenerated: true
}

/** 闯关单题结果 */
export interface QuestQuestionResult {
    questionId: string
    bloomLevel: BloomLevel
    questType: QuestType
    correct: boolean
    score: number
    feedback: string
    analysis: string
}

/** 闯关提交响应 */
export interface QuestSubmitResponse {
    correctCount: number
    totalCount: number
    stars: number
    results: QuestQuestionResult[]
    aiGenerated: true
}

/** 朗读启动响应 */
export interface ReciteStartResponse {
    sessionId: string
    poemId: string
    poemTitle: string
    poet: string
    poemContent: string
    ttsAudioUrl: string
    ttsDurationMs: number
    aiGenerated: true
}

/** 朗读错误信息 */
export interface ReciteMistake {
    type: string
    position: number
    detail: string
}

/** 朗读提交响应 */
export interface ReciteSubmitResponse {
    transcript: string
    pronunciation: number
    rhythm: number
    emotion: number
    mistakes: ReciteMistake[]
    suggestion: string
    audioDurationSec: number
    aiGenerated: true
}

/** 成就徽章 */
export interface SelfStudyBadge {
    id: string
    label: string
    icon: string
    earnedAt: number
}

/** 最近学习事件 */
export interface SelfStudyEvent {
    type: string
    poemTitle: string
    at: number
    detail: string
}

/** 学生自学画像 */
export interface SelfStudyProfile {
    studentId: string
    anonymousName: string
    classId: string
    learnedPoems: number
    questCount: number
    reciteCount: number
    totalStars: number
    bloomRadar: StartProfile
    badges: SelfStudyBadge[]
    recentEvents: SelfStudyEvent[]
    aiGenerated: true
}

/** 画像响应 */
export interface SelfStudyProfileResponse {
    profile: SelfStudyProfile
    aiGenerated: true
}

/** 画像同步响应 */
export interface SelfStudyProfileSyncResponse {
    studentId: string
    syncedAt: number
    profile: SelfStudyProfile
    aiGenerated: true
}

/** 自学舱加载态键名联合类型（Phase 2 新增 learn/dictation 相关） */
export type SelfStudyLoadingKey =
    | 'login'
    | 'tasks'
    | 'diagnoseStart'
    | 'diagnoseSubmit'
    | 'questStart'
    | 'questSubmit'
    | 'poemContent'
    | 'dictationStart'
    | 'dictationSubmit'
    | 'reciteStart'
    | 'reciteSubmit'
    | 'profile'
    | 'profileSync'

// ============================================================
// 文化语境还原（Task 20）
// ============================================================

/** 文化背景包分区键 */
export type BackgroundSectionKey = 'historical' | 'poet' | 'creation' | 'cultural'

/** 文化背景包（brush.creative 生成，四区结构） */
export interface CultureBackground {
    poemId: string
    /** 历史背景 */
    historical: string
    /** 诗人境遇 */
    poet: string
    /** 创作情境 */
    creation: string
    /** 文化常识 */
    cultural: string
    /** 文生图提示词（综合四区意境） */
    suggestedImagePrompt: string
    aiGenerated: boolean
    /** 生成时间戳 */
    generatedAt: number
}

/** 文化视觉素材：可来自 Wan2.7，也可明确降级为本地教学插画 */
export interface CultureImage {
    id: string
    poemId: string
    /** 图片标题（如"唐代长安城元宵夜"） */
    title: string
    /** 图片 URL（来自文生图 API） */
    imageUrl: string
    /** 视觉描述（eye.vision-annotate 生成） */
    description: string
    /** 文化内涵解读 */
    culturalMeaning: string
    /** 三视角标注 */
    perspectives?: {
        color_composition: string
        emotion_atmosphere: string
        cultural_symbols: string
    }
    /** 关联诗句 */
    relatedVerse?: string
    /** 图片方向 */
    orientation: 'landscape' | 'portrait'
    aiGenerated: boolean
    source: 'wan2.7' | 'wan2.7-packaged'
    model?: string
    generationRequestId?: string
    createdAt: number
}

/** 图片库响应 */
export interface ImageGalleryResponse {
    poemId: string
    images: CultureImage[]
    aiGenerated: boolean
}

/** 意象文化内涵解读（seed-data 聚合 + brush.creative 深度解读） */
export interface ImageryInterpretation {
    imageName: string
    /** 来自 seed-data 的基础含义 */
    baseMeaning: string
    /** AI 深度解读（Markdown） */
    deepInterpretation: string
    /** 文化符号维度（如"思乡""团圆""高洁"） */
    culturalDimensions: string[]
    /** 关联诗列表 */
    relatedPoems: Array<{ poemId: string; title: string; poet: string; dynasty: string }>
    aiGenerated: boolean
    generatedAt: number
}

/** 投屏状态 */
export type ImmersiveStatus = 'idle' | 'running' | 'paused' | 'stopped'

/** 投屏会话状态 */
export interface ImmersiveState {
    poemId: string
    status: ImmersiveStatus
    /** 当前展示的图片索引 */
    currentImageIndex: number
    /** 图片切换间隔（ms） */
    slideIntervalMs: number
    /** 是否播放朗读音频 */
    narrationEnabled: boolean
    /** 是否播放背景音 */
    bgmEnabled: boolean
    /** 投屏开始时间 */
    startedAt: number
    /** 最后更新时间 */
    updatedAt: number
}

/** 启动投屏请求体 */
export interface StartImmersiveBody {
    poemId: string
    /** 图片切换间隔（秒，默认 8） */
    slideIntervalSec?: number
    /** 是否播放朗读 */
    narrationEnabled?: boolean
    /** 是否播放背景音 */
    bgmEnabled?: boolean
}

/** 文化背景包响应 */
export interface CultureBackgroundResponse {
    background: CultureBackground
    cached: boolean
}

/** 图片库响应（含 poemId） */
export interface CultureImagesResponse extends ImageGalleryResponse {
    cached: boolean
}

/** 单图详情响应 */
export interface CultureImageDetailResponse {
    image: CultureImage
    cached: boolean
}

/** 意象解读响应 */
export interface CultureImageryResponse {
    interpretation: ImageryInterpretation
    cached: boolean
}

/** 启动投屏响应 */
export interface ImmersiveStartResponse {
    state: ImmersiveState
    aiGenerated: true
}

/** 投屏状态查询响应 */
export interface ImmersiveStatusResponse {
    state: ImmersiveState
}

/** 停止投屏响应 */
export interface ImmersiveStopResponse {
    state?: ImmersiveState
    stoppedCount?: number
    aiGenerated: true
}

/** 文化页古诗列表条目（复用 recitation 诗列表数据） */
export interface CulturePoem {
    id: string
    title: string
    poet: string
    dynasty: string
    content: string
    /** 题材标签（教材人工校订）——体裁徽章文案与配色的权威来源 */
    theme?: string[]
    /** 修辞手法（教材人工校订） */
    rhetoric?: string[]
    /** 学段 */
    gradeLevel?: string
}

/** 文化语境还原加载态键名联合类型 */
export type CultureLoadingKey =
    | 'poems'
    | 'background'
    | 'images'
    | 'imageDetail'
    | 'imagery'
    | 'immersiveStart'
    | 'immersiveStatus'
    | 'immersiveStop'

// ─────────────────────────────────────────────────────────────
// 课后创造工坊（Task 16）—— 创造级培养
// ─────────────────────────────────────────────────────────────

/** 创造工坊任务类型 —— 四类创造级任务 */
export type CreationTaskType = 'illustration' | 'rewrite' | 'video-script' | 'appreciation'

/** 任务类型中文标签映射 */
export const CREATION_TASK_TYPE_LABEL: Record<CreationTaskType, string> = {
    illustration: '配画',
    rewrite: '改写',
    'video-script': '视频脚本',
    appreciation: '鉴赏文',
}

/** 创造工坊任务类型视觉图标名称（与 Icon 注册表对齐） */
export const CREATION_TASK_TYPE_ICON: Record<CreationTaskType, string> = {
    illustration: 'paint-brush',
    rewrite: 'feather',
    'video-script': 'camera',
    appreciation: 'book-open',
}

/** 目标年级（与后端 brush.creative.CreativeGradeLevel 对齐） */
export type CreationGradeLevel = '1-2年级' | '3-4年级' | '5-6年级'

/** 创造级任务实体（与后端 CreationTask 对齐） */
export interface CreationTask {
    id: string
    poemId: string
    poemTitle: string
    poet: string
    dynasty: string
    type: CreationTaskType
    typeLabel: string
    requirements: string
    gradeLevel: CreationGradeLevel
    teacherId: string
    classId: string | null
    createdAt: number
    dueAt: number | null
    status: 'open' | 'closed'
    demoSample?: boolean
}

/** 协作对话条目（与后端 CollaborationTurn 对齐） */
export interface CollaborationTurn {
    round: number
    role: 'ai' | 'teacher' | 'student'
    content: string
    suggestedImagePrompt?: string
    at: number
    aiGenerated: boolean
}

/** 学生作品实体（与后端 CreationWork 对齐） */
export interface CreationWork {
    id: string
    taskId: string
    poemId: string
    poemTitle: string
    poet: string
    type: CreationTaskType
    typeLabel: string
    studentId: string
    anonymousName: string
    classId: string | null
    title: string
    content: string
    imageUrl: string | null
    likeCount: number
    aiAssisted: boolean
    collaborationSessionId: string | null
    submittedAt: number
    demoSample?: boolean
}

/** 任务列表响应 */
export interface CreationTasksResponse {
    tasks: CreationTask[]
}

/** 创建任务请求 */
export interface CreationTaskCreateRequest {
    poemId: string
    type: CreationTaskType
    requirements: string
    gradeLevel?: CreationGradeLevel
    teacherId: string
    classId?: string
    dueAt?: number
    /** 诗信息兜底（数据库无此诗时使用） */
    poemTitle?: string
    poet?: string
    dynasty?: string
}

/** 创建任务响应 */
export interface CreationTaskCreateResponse {
    task: CreationTask
    aiGenerated: false
}

/** 启动协作请求 */
export interface CollaborateStartRequest {
    taskId: string
    studentId?: string
    teacherId?: string
    topic?: string
    constraints?: string[]
}

/** 协作响应（start 与 iterate 共用） */
export interface CollaborationResponse {
    sessionId: string
    history: CollaborationTurn[]
    aiGenerated: true
}

/** 协作迭代请求 */
export interface CollaborateIterateRequest {
    sessionId: string
    feedback: string
    role?: 'teacher' | 'student'
}

/** 配图描述请求 */
export interface VisionDescribeRequest {
    poemId: string
    gradeLevel?: CreationGradeLevel
    topic?: string
    constraints?: string[]
}

/** 配图描述响应 */
export interface VisionDescribeResponse {
    description: string
    suggestedImagePrompt: string
    poemId: string
    aiGenerated: true
}

/** 改写请求 */
export interface RewriteRequest {
    poemId: string
    direction: string
    gradeLevel?: CreationGradeLevel
    constraints?: string[]
}

/** 改写响应 */
export interface RewriteResponse {
    original: string
    rewrite: string
    suggestedImagePrompt: string
    direction: string
    poemId: string
    aiGenerated: true
}

/** 作品列表响应 */
export interface CreationWorksResponse {
    works: CreationWork[]
    total: number
}

/** 提交作品请求 */
export interface WorkSubmitRequest {
    taskId: string
    studentId: string
    title: string
    content: string
    imageUrl?: string
    aiAssisted?: boolean
    collaborationSessionId?: string
}

/** 提交作品响应 */
export interface WorkSubmitResponse {
    work: CreationWork
    aiGenerated: false
}

/** 点赞响应 */
export interface WorkLikeResponse {
    workId: string
    likeCount: number
}

/** 创造作品 AI 批改请求 */
export interface CreationGradeRequest {
    teacherComment?: string
    focus?: 'creativity' | 'accuracy' | 'expression' | 'overall'
}

/** 创造作品结构化批改结果 */
export interface CreationGrading {
    score: number
    level: string
    strengths: string[]
    improvements: string[]
    overallComment: string
}

export interface CreationGradeResponse {
    workId: string
    grading: CreationGrading
    aiGenerated: boolean
    demoSample?: boolean
}

/** 基于批改意见再创作请求 */
export interface CreationRecreateRequest {
    feedback: string
    direction?: string
}

export interface CreationRecreateResponse {
    workId: string
    recreatedContent: string
    suggestedImagePrompt?: string
    aiGenerated: boolean
    demoSample?: boolean
}

/** 作品墙分页响应 */
export interface WorksWallResponse {
    works: CreationWork[]
    total: number
    page: number
    pageSize: number
    totalPages: number
}

/** 创造工坊加载态键名联合类型 */
export type CreationLoadingKey =
    | 'tasks'
    | 'taskCreate'
    | 'collaborateStart'
    | 'collaborateIterate'
    | 'visionDescribe'
    | 'rewrite'
    | 'works'
    | 'workSubmit'
    | 'workLike'
    | 'wall'

/** 创造工坊视图模式 */
export type CreationViewMode = 'tasks' | 'collaborate' | 'vision' | 'rewrite' | 'wall' | 'submit'

// ─────────────────────────────────────────────────────────────
// Phase 3 · 教师教学流程闭环 —— 教案工坊（LessonPlan）
// ─────────────────────────────────────────────────────────────
//
// 设计依据：
// 1. 《义务教育语文课程标准》第一学段（1-2年级）古诗词教学要求：
//    "诵读古诗，展开想象，获得初步的情感体验，感受语言的优美"
// 2. 《教师教育课程标准》:备课环节应包含"教学目标设计、教学内容分析、
//    学情分析、教学过程设计、教学评价设计、教学反思"
// 3. 人教版小学语文教师教学用书：每课应含"教学目标（三维）、教学重难点、
//    教学准备、教学过程（导入/新授/练习/总结）、板书设计、作业布置"
// 4. Bloom认知六阶：教学目标应贯穿记忆/理解/应用/分析/评价/创造
//
// 数据闭环：
// - 教案生成时基于班级诊断数据（diagnosis store），实现"数据驱动备课"
// - 教案生成完成后 emit 'lesson-plan:generated' 事件
// - dashboard store 订阅此事件，刷新"已备课"统计
// - classroom store 订阅此事件，提示教师可基于此教案开课

/** 教学三维目标类别 —— 知识与能力 / 过程与方法 / 情感态度与价值观 */
export type TeachingGoalCategory = 'knowledge' | 'ability' | 'emotion'

/** 三维目标中文标签映射 */
export const TEACHING_GOAL_CATEGORY_LABEL: Record<TeachingGoalCategory, string> = {
    knowledge: '知识与能力',
    ability: '过程与方法',
    emotion: '情感态度与价值观',
}

/**
 * 单条教学目标
 *
 * 与 Bloom 认知六阶关联：每条目标应标注其对应的认知层级
 * 例："学生能正确读写'霜、疑、举、低'4个生字" → 记忆层
 *     "学生能感受诗人思乡之情" → 评价层
 */
export interface TeachingGoal {
    /** 目标类别（三维） */
    category: TeachingGoalCategory
    /** 对应 Bloom 认知层级 */
    bloomLevel: BloomLevel
    /** 目标描述（行为动词 + 内容 + 标准） */
    description: string
    /** 评估方式（如何检测此目标是否达成） */
    assessment: string
}

/** 教学环节类型 —— 完整课堂教学的6个标准环节 */
export type TeachingPhaseType =
    | 'introduction'    // 导入新课
    | 'literacy'        // 识字正音
    | 'interpretation'  // 逐句释义
    | 'appreciation'    // 整体感悟
    | 'extension'       // 拓展延伸
    | 'practice'        // 课堂练习
    | 'homework'        // 作业布置

/** 教学环节中文标签映射 */
export const TEACHING_PHASE_LABEL: Record<TeachingPhaseType, string> = {
    introduction: '导入新课',
    literacy: '识字正音',
    interpretation: '逐句释义',
    appreciation: '整体感悟',
    extension: '拓展延伸',
    practice: '课堂练习',
    homework: '作业布置',
}

/**
 * 教学过程单步骤 —— 完整描述一个教学环节
 *
 * 设计依据：人教版教师用书"教学过程"格式
 * 每个环节包含：教师活动 / 学生活动 / 设计意图 / 预设时长
 */
export interface TeachingProcessStep {
    /** 环节类型 */
    phase: TeachingPhaseType
    /** 环节名称（如"激趣导入：月夜图景"） */
    title: string
    /** 预设时长（分钟） */
    durationMin: number
    /** 教师活动（Markdown，含提问、示范、引导） */
    teacherActivity: string
    /** 学生活动（Markdown，含听、说、读、写、思） */
    studentActivity: string
    /** 设计意图（此环节对应的教学目标和认知层级） */
    designIntent: string
    /** 关联的 Bloom 认知层级（可多个） */
    bloomLevels: BloomLevel[]
    /** 关联教学目标索引（指向 LessonPlan.goals 数组） */
    goalIndices?: number[]
    /** AI 生成标记 */
    aiGenerated: boolean
}

/** 板书设计类型 */
export interface BoardDesign {
    /** 板书标题 */
    title: string
    /** 板书内容（Markdown 文本，描述板书布局） */
    content: string
    /** 板书示意图（可选，SVG 或图片 URL） */
    diagramUrl?: string
    /** 设计意图 */
    intent: string
}

/** 作业类型 */
export type HomeworkType =
    | 'dictation'     // 默写
    | 'recitation'    // 朗读背诵
    | 'creation'      // 创作改写
    | 'investigation' // 探究
    | 'reading'       // 拓展阅读

/** 作业条目 */
export interface HomeworkItem {
    /** 作业类型 */
    type: HomeworkType
    /** 作业描述 */
    description: string
    /** 预计完成时长（分钟） */
    estimatedMin: number
    /** 对应 Bloom 认知层级 */
    bloomLevel: BloomLevel
    /** 是否为选做题 */
    optional: boolean
}

/**
 * 教学反思建议 —— 基于学生诊断数据生成
 *
 * 数据来源：
 * - diagnosis store 的班级共性薄弱点（dark-matter）
 * - self-study store 的学生闯关错误率
 * - grading store 的批改正确率
 * - classroom store 的课堂参与度
 */
export interface TeachingReflection {
    /** 班级整体表现概述 */
    classOverview: string
    /** 教学亮点（哪些目标达成度高） */
    highlights: string[]
    /** 待改进点（哪些目标达成度低） */
    improvements: string[]
    /** 下次教学调整建议 */
    adjustments: string[]
    /** 共性错题分析（基于诊断数据） */
    commonMistakes: string[]
    /** AI 生成标记 */
    aiGenerated: boolean
    /** 生成时间戳 */
    generatedAt: number
}

/** 教案状态 */
export type LessonPlanStatus = 'draft' | 'published' | 'archived'

/**
 * 完整教案实体 —— 教师备课核心产物
 *
 * 与现有 PoemContent（学生识字学诗）的区别：
 * - PoemContent 面向学生：拼音/译文/生字/默写
 * - LessonPlan 面向教师：教学目标/过程/板书/作业/反思
 *
 * 数据关联：
 * - poemId → 关联 PoemContent、Recitation、Creation
 * - classId → 关联班级诊断数据
 * - goals[].bloomLevel → 关联 Bloom 六阶
 * - process[].bloomLevels → 关联 Bloom 六阶
 * - reflection → 关联 diagnosis store 的 dark-matter
 */
export interface LessonPlan {
    /** 教案 ID */
    id: string
    /** 服务端签名会话绑定的教师主体 */
    teacherId?: string
    /** 关联诗篇 ID */
    poemId: string
    /** 诗篇标题 */
    poemTitle: string
    /** 诗人 */
    poet: string
    /** 朝代 */
    dynasty: string
    /** 适用年级（与 CreationGradeLevel 对齐） */
    gradeLevel: CreationGradeLevel
    /** 关联班级 ID（可选，null 表示通用教案） */
    classId: string | null
    /** 班级名称（展示用） */
    className?: string
    /** 教师姓名 */
    teacherName: string
    /** 教案标题（如"静夜思·一年级上册·第1课时"） */
    title: string
    /** 课时数（1-3） */
    lessonCount: 1 | 2 | 3
    /** 三维教学目标 */
    goals: TeachingGoal[]
    /** 教学重点 */
    keyPoints: string[]
    /** 教学难点 */
    difficultPoints: string[]
    /** 教学准备（教具、多媒体、前置知识） */
    preparations: string[]
    /** 完整教学过程 */
    teachingProcess: TeachingProcessStep[]
    /** 板书设计 */
    boardDesign: BoardDesign
    /** 作业布置 */
    homework: HomeworkItem[]
    /** 教学反思建议（基于诊断数据，可选） */
    reflection?: TeachingReflection
    /** 教案状态 */
    status: LessonPlanStatus
    /** 创建时间 */
    createdAt: number
    /** 最后更新时间 */
    updatedAt: number
    /** AI 生成标记 */
    aiGenerated: boolean
}

/** 教案列表条目（精简版） */
export interface LessonPlanListItem {
    id: string
    poemId: string
    poemTitle: string
    poet: string
    dynasty: string
    gradeLevel: CreationGradeLevel
    title: string
    lessonCount: 1 | 2 | 3
    status: LessonPlanStatus
    classId: string | null
    className?: string
    updatedAt: number
    aiGenerated: boolean
}

/** 教案生成请求 */
export interface LessonPlanGenerateRequest {
    poemId: string
    gradeLevel: CreationGradeLevel
    classId?: string
    /** 是否包含教学反思建议（需要班级诊断数据） */
    includeReflection?: boolean
    /** 课时数 */
    lessonCount?: 1 | 2 | 3
}

/** 教案生成响应 */
export interface LessonPlanGenerateResponse {
    lessonPlan: LessonPlan
    /** 生成依据（基于的学情数据摘要） */
    basis: {
        /** 班级共性薄弱点（dark-matter） */
        weakBloomLevels: BloomLevel[]
        /** 班级平均掌握度 */
        classAvgMastery: number
        /** 学生人数 */
        studentCount: number
        /** 数据来源说明 */
        dataSource: string
    }
    aiGenerated: true
}

/** 教案保存响应 */
export interface LessonPlanSaveResponse {
    lessonPlan: LessonPlan
    saved: boolean
    aiGenerated: false
}

/** 教案列表响应 */
export interface LessonPlanListResponse {
    lessonPlans: LessonPlanListItem[]
    total: number
}

/* ============================================================
 * 教案模板（Phase 3 SubTask 25.5：教案模板真实化）
 * ============================================================ */

/** 学段（按年级分组） */
export type LessonPlanTemplateGrade = 'low' | 'middle' | 'high'

/** 课型 */
export type LessonPlanTemplateType = 'new' | 'review' | 'extension'

/** 难度等级 */
export type LessonPlanTemplateDifficulty = 'basic' | 'advanced' | 'challenge'

/** 学段中文标签映射 */
export const LESSON_TEMPLATE_GRADE_LABEL: Record<LessonPlanTemplateGrade, string> = {
    low: '低年级',
    middle: '中年级',
    high: '高年级',
}

/** 课型中文标签映射 */
export const LESSON_TEMPLATE_TYPE_LABEL: Record<LessonPlanTemplateType, string> = {
    new: '新授课',
    review: '复习课',
    extension: '拓展课',
}

/** 难度中文标签映射 */
export const LESSON_TEMPLATE_DIFFICULTY_LABEL: Record<LessonPlanTemplateDifficulty, string> = {
    basic: '基础',
    advanced: '进阶',
    challenge: '挑战',
}

/**
 * 教案模板实体 —— 标准化教案骨架，供教师快速套用
 *
 * 与 LessonPlan 的区别：
 * - LessonPlanTemplate 是骨架模板（无具体诗篇绑定）
 * - LessonPlan 是基于模板或 AI 生成的具体教案（含诗篇、班级、反思等）
 *
 * 字段对齐：任务要求 id/标题/学段/课型/难度/时长/内容简介/缩略图/章节
 */
export interface LessonPlanTemplate {
    /** 模板 ID */
    id: string
    /** 模板标题 */
    title: string
    /** 学段 */
    grade: LessonPlanTemplateGrade
    /** 课型 */
    type: LessonPlanTemplateType
    /** 难度 */
    difficulty: LessonPlanTemplateDifficulty
    /** 建议时长（分钟） */
    duration: number
    /** 内容简介 */
    description: string
    /** 缩略图 URL（可选，未提供时使用首图占位） */
    thumbnail?: string
    /** 模板章节（教学环节骨架） */
    sections: Array<{
        /** 章节标题 */
        title: string
        /** 章节内容（教学活动指引） */
        content: string
    }>
    /** 适用诗篇关键词（可选，用于推荐匹配） */
    applicableKeywords?: string[]
    /** 创建时间 */
    createdAt: number
    /** 最后更新时间 */
    updatedAt: number
}

/** 教案模板列表响应 */
export interface LessonPlanTemplateListResponse {
    templates: LessonPlanTemplate[]
    total: number
}

/** 教案模板筛选条件 */
export interface LessonPlanTemplateFilter {
    /** 关键词搜索（标题/描述） */
    keyword?: string
    /** 学段筛选 */
    grade?: LessonPlanTemplateGrade
    /** 课型筛选 */
    type?: LessonPlanTemplateType
    /** 难度筛选 */
    difficulty?: LessonPlanTemplateDifficulty
}

/** 教案模板排序方式 */
export type LessonPlanTemplateSort = 'newest' | 'popular' | 'duration-asc' | 'duration-desc'

/**
 * AI 生成教案请求（SubTask 25.6：基于模板 + 班级诊断的 AI 生成）
 *
 * 与 LessonPlanGenerateRequest 的区别：
 * - 新版基于 deepseek-v4-pro 模型，支持流式输出
 * - 支持基于模板 ID 生成（套用骨架）
 * - 支持自定义重点知识点
 */
export interface LessonPlanAIGenerateRequest {
    /** 关联诗篇 ID（可选，主题模式可省略） */
    poemId?: string
    /** 主题（无诗篇 ID 时使用，如"思乡诗"、"山水诗"） */
    topic?: string
    /** 学段 */
    grade: LessonPlanTemplateGrade
    /** 课型 */
    type: LessonPlanTemplateType
    /** 时长（分钟） */
    duration: number
    /** 重点知识点（教师自定义输入） */
    keyPoints?: string[]
    /** 关联模板 ID（套用骨架，可选） */
    templateId?: string
    /** 关联班级 ID（用于数据驱动备课） */
    classId?: string
    /** 是否启用流式输出 */
    stream?: boolean
}

/** AI 生成教案的流式 chunk 类型 */
export type LessonAIGenerateStreamChunk =
    | { type: 'chunk'; content: string }
    | { type: 'reasoning'; content: string }
    | { type: 'done'; lessonPlan: LessonPlan }
    | { type: 'aborted' }

/** AI 生成教案的流式控制器 */
export interface LessonAIGenerateStreamController {
    /** 是否仍在流式输出 */
    streaming: boolean
    /** 中止流式输出 */
    abort: () => void
}

/** AI 生成教案的流式回调 */
export interface LessonAIGenerateStreamCallbacks<T = LessonAIGenerateStreamChunk> {
    onChunk?: (chunk: T) => void
    onError?: (err: Error) => void
}

/** 教案加载态键名联合类型 */
export type LessonPlanLoadingKey =
    | 'list'
    | 'detail'
    | 'generate'
    | 'save'
    | 'searchPoems'
    | 'poemDetail'
    | 'objectives'
    | 'layeredDesign'
    | 'lessonGenerate'
    | 'lessonRefine'
    | 'resources'
    | 'templates'
    | 'aiGenerate'

/* ============================================================
 * 智能备课 5 大能力类型（与后端 services/lesson-plan/* 对齐）
 * ============================================================ */

/** 诗歌实体（前端镜像，与后端 PoemEntity 对齐） */
export interface PoemEntity {
    id: string
    title: string
    poet: string
    dynasty: string
    content: string
    annotation: Record<string, string> | null
    theme: string[]
    images: string[]
    rhetoric: string[]
    gradeLevel: string | null
    textbookEdition: string
    difficulty: number
    createdAt: number
    metadata: Record<string, unknown> | null
}

/** 多维检索查询参数 */
export interface PoemSearchQuery {
    keyword?: string
    dynasty?: string
    poet?: string
    genre?: string
    subject?: string
    imagery?: string
    gradeLevel?: string
    difficulty?: number
    semanticQuery?: string
    limit?: number
    offset?: number
}

/** 检索结果项 */
export interface PoemSearchResult {
    poem: PoemEntity
    matchScore: number
    matchedDimensions: string[]
    genre: string
    subject: string
}

/** 诗歌详情（含 AI 生成的意象分析、典故、文化背景） */
export interface PoemDetail {
    poem: PoemEntity
    genre: string
    subject: string
    imageryAnalysis: Array<{
        name: string
        meaning: string
        culturalConnotation: string
    }>
    allusions: Array<{
        allusion: string
        explanation: string
        relatedText: string
    }>
    culturalBackground: {
        poetBackground: string
        eraBackground: string
        creationContext: string
    }
    aiGenerated: boolean
}

/** 检索响应 */
export interface PoemSearchResponse {
    results: PoemSearchResult[]
    total: number
}

/** 教学目标（单条，含 Bloom 层级与课时归属） */
export interface TeachingObjective {
    bloomLevel: BloomLevel
    category: TeachingGoalCategory
    description: string
    assessment: string
    lessonIndex: number
}

/** 教学目标生成请求 */
export interface ObjectiveGenerateRequest {
    poemId: string
    gradeLevel: CreationGradeLevel
    lessonCount: 1 | 2 | 3
    weakBloomLevels?: BloomLevel[]
    teacherPreference?: string
}

/** 教学目标生成响应 */
export interface ObjectiveGenerateResponse {
    objectives: TeachingObjective[]
    designNotes: string
    bloomCoverage: Record<BloomLevel, number>
    aiGenerated: boolean
    generatedAt: number
}

/** 分层层级 */
export type LayerTier = 'basic' | 'intermediate' | 'advanced'

/** 分层教学设计单层 */
export interface LayerDesign {
    tier: LayerTier
    tierName: string
    studentRatio: number
    targetStudents: string
    focusBloomLevels: BloomLevel[]
    questionChain: Array<{
        order: number
        bloomLevel: BloomLevel
        question: string
        expectedAnswer: string
        scaffold: string
    }>
    activities: Array<{
        name: string
        type: 'individual' | 'pair' | 'group' | 'whole-class'
        durationMin: number
        description: string
        teacherRole: string
        aiSynergy?: string
    }>
    homework: Array<{
        type: HomeworkType
        description: string
        estimatedMin: number
        bloomLevel: BloomLevel
        optional: boolean
    }>
    scaffolds: string[]
}

/** 分层教学设计请求 */
export interface LayeredDesignRequest {
    poemId: string
    classId?: string
    objectiveIds?: string[]
    layerRatio?: {
        basic: number
        intermediate: number
        advanced: number
    }
}

/** 分层教学设计响应 */
export interface LayeredDesignResponse {
    layers: LayerDesign[]
    basis: {
        studentCount: number
        classAvgMastery: number
        layerDistribution: Record<LayerTier, number>
        dataSource: string
    }
    designNotes: string
    aiGenerated: boolean
    generatedAt: number
}

/** 教案环节类型（深化版，含 AI 协同点） */
export type LessonPhaseType =
    | 'introduction'
    | 'literacy'
    | 'interpretation'
    | 'appreciation'
    | 'extension'
    | 'practice'
    | 'homework'

/** 教案教学环节（深化版） */
export interface LessonPhase {
    phase: LessonPhaseType
    title: string
    durationMin: number
    teacherScript: string
    studentScript: string
    presetQuestions: Array<{
        question: string
        expectedAnswer: string
        followUp?: string
        bloomLevel: BloomLevel
    }>
    aiSynergyPoints: Array<{
        scenario: string
        aiAction: string
        benefit: string
    }>
    designIntent: string
    goalIndices: number[]
    layerTips?: {
        basic?: string
        intermediate?: string
        advanced?: string
    }
}

/** AI 生成的完整教案（深化版，区别于 LessonPlan） */
export interface GeneratedLesson {
    poemId: string
    poemTitle: string
    poet: string
    dynasty: string
    gradeLevel: CreationGradeLevel
    lessonCount: 1 | 2 | 3
    title: string
    goals: Array<{
        bloomLevel: BloomLevel
        category: TeachingGoalCategory
        description: string
        assessment: string
    }>
    keyPoints: string[]
    difficultPoints: string[]
    preparations: string[]
    teachingProcess: LessonPhase[]
    boardDesign: {
        title: string
        content: string
        structure: 'linear' | 'radial' | 'tree' | 'matrix'
        intent: string
    }
    homework: Array<{
        tier: 'basic' | 'intermediate' | 'advanced' | 'common'
        type: HomeworkType
        description: string
        estimatedMin: number
        bloomLevel: BloomLevel
        optional: boolean
    }>
    anticipatedReflections: Array<{
        scenario: string
        countermeasure: string
    }>
    totalDurationMin: number
    designNotes: string
    aiGenerated: boolean
    generatedAt: number
}

/** 教案生成请求（深化版） */
export interface LessonGenerateRequest {
    poemId: string
    gradeLevel: CreationGradeLevel
    lessonCount: 1 | 2 | 3
    objectives: Array<{
        bloomLevel: BloomLevel
        category: TeachingGoalCategory
        description: string
        assessment: string
    }>
    layeredDesignSummary?: {
        basicCount: number
        intermediateCount: number
        advancedCount: number
        focusAreas: string[]
    }
    teacherPreference?: {
        teachingStyle?: string
        timeAllocation?: string
        specialRequirements?: string
    }
    classId?: string
}

/** 教案生成响应（深化版） */
export interface LessonGenerateResponse {
    lesson: GeneratedLesson
    aiGenerated: boolean
    generatedAt: number
}

/** 教案流式 chunk */
export type LessonStreamChunk =
    | { type: 'chunk'; content: string }
    | { type: 'reasoning'; content: string }
    | { type: 'done'; lesson: GeneratedLesson }
    | { type: 'aborted' }

/** 教案选段精修请求 */
export interface LessonRefineRequest {
    lessonId: string
    targetSection: {
        type: 'phase' | 'board' | 'homework' | 'goals' | 'keyPoints' | 'difficultPoints'
        phaseIndex?: number
        field?: 'teacherScript' | 'studentScript' | 'presetQuestions' | 'aiSynergyPoints' | 'designIntent' | 'layerTips'
    }
    originalContent: string
    refineInstruction: string
    context?: {
        poemTitle?: string
        gradeLevel?: CreationGradeLevel
    }
}

/** 教案选段精修响应 */
export interface LessonRefineResponse {
    refinedContent: string
    changeSummary: string
    aiGenerated: boolean
}

/** 精修流式 chunk */
export type RefineStreamChunk =
    | { type: 'chunk'; content: string }
    | { type: 'reasoning'; content: string }
    | { type: 'done'; refinedContent: string; changeSummary: string }
    | { type: 'aborted' }

/** 流式控制器（教案生成/精修共用） */
export interface LessonStreamController {
    abort: () => void
    readonly streaming: boolean
}

/** 流式回调配置（教案生成/精修共用） */
export interface LessonStreamCallbacks<T = LessonStreamChunk> {
    onChunk: (chunk: T) => void
    onDone?: () => void
    onError?: (err: Error) => void
}

/** 资源类型 */
export type ResourceType =
    | 'related-poem'
    | 'cultural-background'
    | 'imagery-graph'
    | 'classroom-recording'
    | 'preview-material'

/** 资源项 */
export interface ResourceItem {
    id: string
    type: ResourceType
    title: string
    description: string
    relevanceScore: number
    relevanceReason: string
    metadata: {
        source?: string
        dynasty?: string
        url?: string
        duration?: string
        bloomLevels?: BloomLevel[]
        gradeLevel?: string
    }
}

/** 资源调度响应 */
export interface LessonResourcesResponse {
    lessonId: string
    poemId: string
    resources: ResourceItem[]
    stats: Record<ResourceType, number>
    generatedAt: number
}

/* ============================================================
 * Phase 4.1：学生错题本 + 间隔重复（SM-2 算法）
 *
 * 设计依据（回应"我是学生，我需要什么才能深刻学会并理解记忆"的核心追问）：
 *
 * 数据闭环定位：
 *   诊断 → 闯关 → 错题收集 → SM-2 间隔重复 → 再诊断
 *                                    ↑
 *                          补全"测-学-练-复"中的"复"环节
 *
 * SM-2 算法（SuperMemo 2）：
 * - 经典间隔重复算法，Anki 等主流记忆软件的核心算法
 * - 核心参数：易度因子(EF)、间隔天数、重复次数
 * - 复习质量评分 0-5 分制（0=完全遗忘，5=完美记忆）
 * - EF 范围 1.3-3.0，初始 2.5，根据复习质量动态调整
 * - 算法公式：
 *   - quality ≥ 3：repetitions++, interval = 1/6/EF^repetitions
 *   - quality < 3：repetitions = 0, interval = 1
 *   - EF' = EF + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))，下限 1.3
 *
 * 数据来源：
 * 1. DiagnoseQuestionResult（诊断错题）→ source = 'diagnose'
 * 2. QuestQuestionResult（闯关错题）→ source = 'quest'
 * 3. DictationSubmitResponse（默写错题）→ source = 'dictation'
 * 4. ReciteSubmitResponse（朗读问题）→ source = 'recitation'
 *
 * 与现有 DarkMatter（班级共性）的区别：
 * - DarkMatter：班级层面的共性卡顿模式，面向教师
 * - ErrorNotebook：学生个体的错题记录，面向学生本人
 * ============================================================ */

/** 错题来源类型 —— 标记错题来自哪个学习环节 */
export type ErrorSourceType = 'diagnose' | 'quest' | 'dictation' | 'recitation'

/** 错题来源中文标签映射 */
export const ERROR_SOURCE_LABEL: Record<ErrorSourceType, string> = {
    diagnose: '认知诊断',
    quest: '诗脉闯关',
    dictation: '默写检测',
    recitation: '朗读评测',
}

/**
 * SM-2 间隔重复状态
 *
 * 持久化在每个错题条目中，记录该知识点的记忆状态。
 * 每次复习后根据质量评分(0-5)动态更新。
 */
export interface SpacedRepetitionState {
    /** 易度因子(EF)，初始 2.5，范围 1.3-3.0 —— 反映该知识点的记忆难度 */
    easeFactor: number
    /** 当前间隔天数 —— 下次复习距上次的间隔 */
    intervalDays: number
    /** 连续正确重复次数 —— 用于决定下次间隔（0→1天, 1→6天, ≥2→interval*EF天） */
    repetitions: number
    /** 下次复习日期时间戳（ms）—— 到期则需复习 */
    nextReviewDate: number
    /** 上次复习日期时间戳（ms），null 表示从未复习 */
    lastReviewDate: number | null
}

/**
 * SM-2 复习质量评分（0-5 分制）
 *
 * 评分标准：
 * 0 —— 完全遗忘，毫无印象
 * 1 —— 完全遗忘，但看到答案后能想起来
 * 2 —— 部分遗忘，回忆困难但有模糊印象
 * 3 —— 勉强回忆，付出很大努力才想起（及格线）
 * 4 —— 正确回忆，有少许迟疑
 * 5 —— 完美记忆，瞬间正确回忆
 */
export type ReviewQuality = 0 | 1 | 2 | 3 | 4 | 5

/**
 * 单条错题条目 —— 学生错题本的核心实体
 *
 * 一个错题条目代表学生在某个知识点（Bloom层级 × 诗篇）上的一次持续性错误。
 * 同一知识点多次错误会增加 errorCount，但只保留一条记录（合并去重）。
 */
export interface ErrorNotebookItem {
    /** 错题条目 ID */
    id: string
    /** 学生 ID（脱敏） */
    studentId: string
    /** 关联诗篇 ID */
    poemId: string
    /** 诗篇标题 */
    poemTitle: string
    /** 诗人 */
    poet: string
    /** Bloom 认知层级 */
    bloomLevel: BloomLevel
    /** 错题来源 */
    source: ErrorSourceType
    /** 题目题干 */
    questionStem: string
    /** 学生错误答案 */
    studentAnswer: string
    /** 正确答案 */
    correctAnswer: string
    /** AI 解析（为什么错 + 如何纠正 + 记忆策略） */
    analysis: string
    /** 累计错误次数（同一知识点重复错误时累加） */
    errorCount: number
    /** 首次错误时间戳 */
    firstErrorAt: number
    /** 最近错误时间戳 */
    lastErrorAt: number
    /** SM-2 间隔重复状态 */
    repetition: SpacedRepetitionState
    /** 是否已掌握（连续答对足够次数后标记为已掌握） */
    mastered: boolean
    /** AI 生成标记 */
    aiGenerated: boolean
}

/** 错题本列表条目（精简版，用于列表展示） */
export interface ErrorNotebookListItem {
    id: string
    poemId: string
    poemTitle: string
    poet: string
    bloomLevel: BloomLevel
    source: ErrorSourceType
    errorCount: number
    lastErrorAt: number
    /** 下次复习日期时间戳 */
    nextReviewDate: number
    /** 是否今日到期待复习 */
    dueToday: boolean
    mastered: boolean
}

/** 错题本列表响应 */
export interface ErrorNotebookListResponse {
    items: ErrorNotebookListItem[]
    total: number
    /** 今日待复习数量 */
    dueToday: number
    /** 已掌握数量 */
    masteredCount: number
}

/** 复习提交请求 */
export interface ReviewSubmitRequest {
    /** 错题条目 ID */
    itemId: string
    /** 复习质量评分（0-5） */
    quality: ReviewQuality
}

/** 复习提交响应 */
export interface ReviewSubmitResponse {
    /** 更新后的错题条目 */
    item: ErrorNotebookItem
    /** 更新后的间隔重复状态 */
    updatedRepetition: SpacedRepetitionState
    /** 是否新掌握（本次复习后达到掌握标准） */
    newlyMastered: boolean
    aiGenerated: boolean
}

/** 单条复习记录（用于复习历史曲线） */
export interface ReviewRecord {
    errorNotebookItemId: string
    reviewedAt: number
    quality: ReviewQuality
    /** 复习前间隔天数 */
    previousInterval: number
    /** 复习后间隔天数 */
    newInterval: number
    /** 是否答对（quality ≥ 3） */
    correct: boolean
}

/** 错题本统计响应 */
export interface ReviewStatsResponse {
    /** 总错题数 */
    totalItems: number
    /** 今日待复习数 */
    dueToday: number
    /** 已掌握数 */
    masteredCount: number
    /** 平均掌握度（0-100，已掌握占比加权） */
    averageMastery: number
    /** 近7天复习曲线 */
    reviewCurve: Array<{ date: string; count: number; correctCount: number }>
    /** 按 Bloom 层级分布 */
    byBloomLevel: Partial<Record<BloomLevel, number>>
    /** 按来源分布 */
    bySource: Partial<Record<ErrorSourceType, number>>
    aiGenerated: false
}

/** 错题本加载态键名联合类型 */
export type ErrorNotebookLoadingKey = 'list' | 'detail' | 'review' | 'stats'

/* ============================================================
 * Phase 4.2：教学调整建议类型（基于诊断数据 + 错题本数据）
 *
 * 教学逻辑：诊断→建议→教案调整→再诊断
 * 回应"我是老师，这篇诗我应该如何教"的核心追问
 * ============================================================ */

/** 教学建议类型 */
export type TeachingSuggestionType =
    | 'weakness'      // 薄弱点强化
    | 'method'        // 教学方法调整
    | 'material'      // 教学素材补充
    | 'progress'      // 进度跟进
    | 'differentiate' // 分层教学

/** 建议优先级 */
export type SuggestionPriority = 'high' | 'medium' | 'low'

/** 教学建议单条 */
export interface TeachingSuggestion {
    /** 建议 ID */
    id: string
    /** 建议类型 */
    type: TeachingSuggestionType
    /** 建议标题 */
    title: string
    /** 建议详细描述 */
    description: string
    /** 优先级 */
    priority: SuggestionPriority
    /** 关联 Bloom 层级（可选） */
    bloomLevel?: BloomLevel
    /** 关联诗篇 ID（可选） */
    poemId?: string
    /** 关联诗篇标题（可选） */
    poemTitle?: string
    /** 受影响学生 ID 列表（可选，用于分层教学） */
    studentIds?: string[]
    /** 受影响学生数 */
    affectedStudentCount?: number
    /** 数据证据（基于什么数据生成的建议） */
    evidence: string
    /** 建议的具体行动 */
    suggestedAction: string
    /** 生成时间戳 */
    generatedAt: number
    /** 是否 AI 生成 */
    aiGenerated: boolean
}

/** 教学建议响应 */
export interface TeachingSuggestionResponse {
    /** 班级 ID */
    classId: string
    /** 建议列表 */
    suggestions: TeachingSuggestion[]
    /** 生成时间戳 */
    generatedAt: number
    /** 建议基于的数据摘要 */
    dataSummary: {
        /** 班级平均掌握度 */
        classMasteryAvg: number
        /** 暗物质总数 */
        darkMatterCount: number
        /** 最薄弱 Bloom 层级 */
        weakestBloomLevel: BloomLevel
        /** 错题本今日待复习数 */
        dueTodayCount: number
    }
    aiGenerated: boolean
}

/* ============================================================
 * 主动智能事件（P0-4）
 * 与后端 backend/src/services/proactive-intelligence.ts 对齐
 *
 * 4 大主动智能场景通过 WS 推送 proactive:* 事件：
 * 1. proactive:alert:mastery     学情暗物质预警（severity: warning/critical）
 * 2. proactive:alert:blindspot   知识图谱盲区预警（severity: warning/critical）
 * 3. proactive:suggestion         教学节奏建议（severity: info）
 * 4. proactive:evolution          Agent 自我进化通知（severity: info/warning）
 * ============================================================ */

/** 主动预警严重程度（与后端 ProactiveSeverity 对齐） */
export type ProactiveSeverity = 'info' | 'warning' | 'critical'

/** 主动预警目标类型 */
export type ProactiveTargetType = 'student' | 'class' | 'agent'

/** ProactiveAlert payload 结构（与后端 ProactiveAlert 对齐） */
export interface ProactiveAlert {
    /** 事件类型（proactive:alert:mastery / proactive:alert:blindspot / proactive:suggestion / proactive:evolution） */
    type: string
    /** 严重程度 */
    severity: ProactiveSeverity
    /** 标题 */
    title: string
    /** 描述 */
    description: string
    /** 推荐动作 */
    recommendedAction: string
    /** 目标 ID（学生 ID / 班级 ID / Agent ID） */
    targetId: string
    /** 目标类型 */
    targetType: ProactiveTargetType
    /** 时间戳 */
    timestamp: number
    /** 元数据（可选，扩展信息） */
    metadata?: Record<string, unknown>
}

/** 周报数据（copilot store 持有，由后端定期推送） */
export interface WeeklyReport {
    /** 报告 ID */
    id: string
    /** 报告标题 */
    title: string
    /** 报告周期起始时间戳 */
    periodFrom: number
    /** 报告周期结束时间戳 */
    periodTo: number
    /** 报告摘要 */
    summary: string
    /** 关键发现 */
    keyFindings: string[]
    /** 教学建议 */
    recommendations: string[]
    /** 生成时间戳 */
    generatedAt: number
}

// ─────────────────────────────────────────────────────────────
// 进化之眼基因谱（Evolution Eye）类型定义
// 对应后端 backend/src/agents/base/evolution-engine.ts
// ─────────────────────────────────────────────────────────────

/** 进化模式来源 */
export type EvolutionSource = 'teacher-correction' | 'agent-error' | 'verify-reject'

/** 版本谱系节点 —— 决定 3D 球体的大小与颜色 */
export interface GenealogyNode {
    id: string
    agentId: string
    version: string
    isActive: boolean
    isCandidate: boolean
    createdAt: number
    changelog: string
    /** 质量分 0-1，决定 3D 球体大小 */
    quality: number
    improvementReward: number | null
    triggerPattern: string | null
    appliedAt: number | null
    /** 候选版本的成功次数（仅 isCandidate 时有值） */
    successCount: number | null
    /** 候选版本的失败次数（仅 isCandidate 时有值） */
    failureCount: number | null
}

/** 版本谱系边（进化关系） */
export interface GenealogyEdge {
    from: string
    to: string
    agentId: string
    pattern: string
    improvementReward: number | null
    createdAt: number
}

/** 版本谱系完整数据 */
export interface GenealogyData {
    nodes: GenealogyNode[]
    edges: GenealogyEdge[]
    agentIds: string[]
}

/** 进化模式列表项 */
export interface PatternItem {
    id: string
    agentId: string
    pattern: string
    source: EvolutionSource
    contextSnippet: string
    timestamp: number
    createdAt: number
}

/** A/B 测试候选信息（当前活跃测试） */
export interface ABTestCandidateInfo {
    agentId: string
    version: string
    startedAt: number
    samples: number
    candidateSuccessCount: number
    candidateFailureCount: number
    activeSuccessCount: number
    activeFailureCount: number
    candidateSuccessRate: number
    activeSuccessRate: number
    /** 候选成功率超出活跃的幅度 */
    margin: number
    minSamplesReached: boolean
}

/** A/B 测试历史项（已完成测试） */
export interface ABTestHistoryItem {
    agentId: string
    winningVersion: string
    candidateSuccessRate: number
    activeSuccessRate: number
    activatedAt: number
    pattern: string
}

/** A/B 测试结果数据 */
export interface ABTestResultData {
    active: ABTestCandidateInfo[]
    history: ABTestHistoryItem[]
    threshold: number
    minSamples: number
}

// ─────────────────────────────────────────────────────────────
// 进化预测（Evolution Predict）类型定义
// 对应后端 backend/src/routes/evolution.ts POST /predict
// ─────────────────────────────────────────────────────────────

/** 单条预测方向（由 LLM 流式输出后聚合） */
export interface EvolutionPredictionDirection {
    /** 进化方向标题 */
    direction: string
    /** 具体优化建议 */
    suggestion: string
    /** 预期提升 0-1 */
    expectedImprovement: number
    /** 置信度 0-1 */
    confidence: number
}

/** 完整预测结果（流式结束后聚合） */
export interface EvolutionPredictionResult {
    /** 预测方向列表（1-5 条；数据不足时也必须给出可解释的非空本地预测） */
    predictions: EvolutionPredictionDirection[]
    /** 整体置信度 0-1 */
    confidence: number
    /** 数据来源：ai（LLM 生成） / template（模板降级） */
    aiGenerated: boolean
    /** 预测时间戳 */
    generatedAt: number
}

/** POST /evolution/predict 请求体 */
export interface EvolutionPredictRequest {
    /** 历史进化模式（简化版 PatternItem[]） */
    historicalPatterns: Array<{
        pattern: string
        source?: string
        timestamp?: number
    }>
    /** 当前版本节点（简化版 GenealogyNode[]） */
    currentVersions: Array<{
        version: string
        agentId?: string
        isActive?: boolean
        quality?: number
        createdAt?: number
    }>
    /** 预测步长（天），默认 7 */
    horizon?: number
}

/** SSE 流式 chunk 类型 */
export type EvolutionPredictStreamChunk =
    | { type: 'token'; token: string }
    | { type: 'done'; result: EvolutionPredictionResult }
    | { type: 'error'; code: string; message: string }

// ─────────────────────────────────────────────────────────────
// 思考宫殿 3D 链（Thinking Palace）类型定义
// 对应后端 backend/src/db/types.ts ThinkingChainEntity
// ─────────────────────────────────────────────────────────────

/** 思考节点类型 —— 决定 3D 几何体形状与色相 */
export type ThinkingNodeType = 'hypothesis' | 'reasoning' | 'evidence' | 'question' | 'conclusion'

/** 深度思考模式 */
export type ThinkingMode = 'low' | 'medium' | 'high' | 'max'

/** 思考链节点 */
export interface ThinkingNode {
    index: number
    type: ThinkingNodeType
    content: string
    startOffset: number
    endOffset: number
    durationMs?: number
}

/** 思考链实体 */
export interface ThinkingChain {
    id: string
    agentId: string
    sessionId: string
    question: string
    reasoning: string
    answer: string | null
    nodes: ThinkingNode[]
    thinkingMode: ThinkingMode
    durationMs: number
    model: string
    promptTokens: number
    completionTokens: number
    createdAt: number
    metadata: Record<string, unknown> | null
}

/** 思考链列表响应 */
export interface ThinkingChainsResponse {
    chains: ThinkingChain[]
    total: number
}

/** 思考链详情响应 */
export interface ThinkingChainDetailResponse {
    chain: ThinkingChain
}

/* ============================================================
 * 画像报告模块类型定义（能力 1-5）
 *
 * 能力 1：学生立体画像（StudentProfile3D）
 * 能力 2：班级热点画像（ClassHotspot）
 * 能力 3：趋势预警（TrendAlert）
 * 能力 4：多格式导出与分享链接（Export / Share）
 * 能力 5：家校沟通活页（HomeSchoolBook）
 *
 * 与后端 backend/src/services/profile/*.ts 对齐
 * ============================================================ */

// ─────────────────────────────────────────────────────────────
// 能力 1：学生立体画像
// ─────────────────────────────────────────────────────────────

/** 知识维度 */
export interface ProfileKnowledgeDimension {
    learnedPoemCount: number
    avgMastery: number
    masteredCount: number
    weakCount: number
    coverage: number
}

/** 能力维度 */
export interface ProfileAbilityDimension {
    radar: Record<BloomLevel, number>
    strongest: BloomLevel
    weakest: BloomLevel
    balance: number
}

/** 行为维度 */
export interface ProfileBehaviorDimension {
    engagement: number
    totalAttempts: number
    correctRate: number
    recitationCount: number
    lastActiveAt: number | null
    activityLevel: 'active' | 'normal' | 'quiet'
}

/** 兴趣维度 */
export interface ProfileInterestDimension {
    topDynasties: Array<{ dynasty: string; count: number }>
    topThemes: Array<{ theme: string; count: number }>
    topRhetoric: Array<{ rhetoric: string; count: number }>
    concentration: number
}

/** 成长维度 */
export interface ProfileGrowthDimension {
    masteryTrend: Array<{ date: number; mastery: number }>
    delta: number
    trend: 'rising' | 'stable' | 'declining'
    momentum: number
    classPercentile: number
}

/** 学生立体画像完整结构 */
export interface StudentProfile3D {
    studentId: string
    anonymousName: string
    generatedAt: number
    aiGenerated: boolean
    dimensions: {
        knowledge: ProfileKnowledgeDimension
        ability: ProfileAbilityDimension
        behavior: ProfileBehaviorDimension
        interest: ProfileInterestDimension
        growth: ProfileGrowthDimension
    }
    tags: string[]
    description: string
    confidence: number
}

/** 立体画像响应 */
export interface StudentProfile3DResponse {
    profile: StudentProfile3D
    cached: boolean
}

// ─────────────────────────────────────────────────────────────
// 能力 2：班级热点画像
// ─────────────────────────────────────────────────────────────

export type HotspotType =
    | 'common-strength'
    | 'common-weakness'
    | 'anomaly'
    | 'interest-trend'
    | 'engagement-hotspot'

export interface CommonStrength {
    type: 'common-strength'
    dimension: string
    description: string
    avgScore: number
    excellentRatio: number
}

export interface CommonWeakness {
    type: 'common-weakness'
    dimension: string
    description: string
    avgScore: number
    weakRatio: number
    affectedCount: number
}

export interface AnomalyItem {
    type: 'anomaly'
    studentId: string
    anonymousName: string
    anomalyType: 'outperform' | 'underperform'
    dimension: string
    studentScore: number
    classAvg: number
    deviation: number
}

export interface InterestTrend {
    type: 'interest-trend'
    dynastyDistribution: Array<{ dynasty: string; count: number; ratio: number }>
    themeDistribution: Array<{ theme: string; count: number }>
    hotPoems: Array<{ poemId: string; title: string; poet: string; learnedCount: number }>
}

export interface EngagementHotspot {
    type: 'engagement-hotspot'
    highEngagement: Array<{ studentId: string; anonymousName: string; engagement: number }>
    lowEngagement: Array<{ studentId: string; anonymousName: string; engagement: number }>
    classAvgEngagement: number
    activityLevel: 'high' | 'medium' | 'low'
}

export interface ClassHotspot {
    classId: string
    className: string
    generatedAt: number
    aiGenerated: boolean
    hotspots: {
        strengths: CommonStrength[]
        weaknesses: CommonWeakness[]
        anomalies: AnomalyItem[]
        interestTrend: InterestTrend
        engagement: EngagementHotspot
    }
    description: string
}

export interface ClassHotspotResponse {
    hotspot: ClassHotspot
    cached: boolean
}

// ─────────────────────────────────────────────────────────────
// 能力 3：趋势预警
// ─────────────────────────────────────────────────────────────

export type TrendAlertRule =
    | 'academic-decline'
    | 'engagement-drop'
    | 'knowledge-gap'
    | 'behavior-anomaly'
    | 'personalized'

export type TrendAlertSeverity = 'info' | 'warning' | 'critical'

export interface TrendAlert {
    id: string
    rule: TrendAlertRule
    severity: TrendAlertSeverity
    title: string
    description: string
    studentId?: string
    anonymousName?: string
    classId: string
    bloomLevel?: BloomLevel
    poemId?: string
    suggestedAction: string
    resolved: boolean
    resolvedAt?: number
    createdAt: number
    aiAnalyzed: boolean
}

export interface TrendAlertsResponse {
    alerts: TrendAlert[]
    total: number
    severityStats: {
        critical: number
        warning: number
        info: number
    }
}

// ─────────────────────────────────────────────────────────────
// 能力 4：多格式导出与分享链接
// ─────────────────────────────────────────────────────────────

export type ProfileExportFormat = 'pdf' | 'image' | 'excel' | 'markdown' | 'word'

export interface ProfileExportRequest {
    reportId: string
    format: ProfileExportFormat
    includeSections?: string[]
    includeCharts?: boolean
    includeVerification?: boolean
}

export interface ProfileExportResult {
    exportId: string
    reportId: string
    format: ProfileExportFormat
    fileName: string
    mimeType: string
    content?: string
    generatedAt: number
    success: boolean
    error?: string
}

export interface ProfileExportResponse {
    result: ProfileExportResult
    aiGenerated: boolean
}

export interface SharedReport {
    shareId: string
    reportId: string
    className: string
    title: string
    createdAt: number
    expireAt: number
    viewCount: number
    lastViewedAt: number | null
}

/** bearer token 只在创建响应中返回一次，列表不会再次下发。 */
export interface CreatedSharedReport extends SharedReport {
    token: string
}

/** 匿名分享读取的最小载荷；管理面标识和访问统计不得公开。 */
export interface PublicSharedReport {
    className: string
    title: string
    contentHtml: string
    createdAt: number
    expireAt: number
}

export interface PublicSharePreview {
    className: string
    title: string
    contentHtml: string
}

export interface PreviewShareRequest {
    reportId: string
}

export interface PreviewShareResponse {
    preview: PublicSharePreview
    /** 只用于将人工确认的快照绑定到创建请求，不是公开访问凭据。 */
    previewFingerprint: string
    aiGenerated: boolean
}

export interface CreateShareRequest {
    reportId: string
    expireDays?: number
    /** 必须来自刚刚完成的服务端脱敏预览。 */
    previewFingerprint: string
}

export interface CreateShareResponse {
    shared: CreatedSharedReport
    aiGenerated: boolean
}

export interface GetSharedReportResponse {
    shared: PublicSharedReport
    aiGenerated: boolean
}

export interface ListSharedReportsResponse {
    shares: SharedReport[]
    total: number
}

// ─────────────────────────────────────────────────────────────
// 能力 5：家校沟通活页
// ─────────────────────────────────────────────────────────────

export type WeeklyReportStatus = 'draft' | 'published' | 'archived'
export type ActivityType = 'recitation' | 'discussion' | 'creation' | 'review' | 'appreciation'
export type GoalStatus = 'active' | 'completed' | 'overdue' | 'abandoned'

export interface WeeklyLearningSummary {
    learnedPoemCount: number
    attemptCount: number
    correctRate: number
    recitationCount: number
    studyMinutes: number
    activeDays: number
    masteryDelta: number
    newWeakPoints: string[]
    newlyMastered: string[]
}

export interface TeacherNote {
    content: string
    teacherName: string
    notedAt: number
}

export interface ParentFeedback {
    content: string
    feedbackType: 'praise' | 'concern' | 'question' | 'suggestion'
    submittedAt: number
    read: boolean
}

export interface RecommendedActivity {
    id: string
    type: ActivityType
    title: string
    description: string
    poemId?: string
    estimatedMinutes: number
    difficulty: 'easy' | 'medium' | 'hard'
    completed: boolean
    completedAt?: number
}

export interface LearningGoal {
    id: string
    title: string
    description: string
    goalType: 'mastery' | 'engagement' | 'recitation' | 'creation'
    targetValue: number
    currentValue: number
    progress: number
    deadline: number
    status: GoalStatus
    createdAt: number
}

export interface HomeSchoolWeekly {
    id: string
    studentId: string
    anonymousName: string
    classId: string
    weekKey: string
    period: { from: number; to: number }
    status: WeeklyReportStatus
    summary: WeeklyLearningSummary
    content: string
    aiGenerated: boolean
    teacherNotes: TeacherNote[]
    parentFeedbacks: ParentFeedback[]
    recommendedActivities: RecommendedActivity[]
    goals: LearningGoal[]
    createdAt: number
    updatedAt: number
    publishedAt?: number
}

export interface WeeklyReportCreateRequest {
    studentId: string
    classId: string
    weekKey?: string
}

export interface WeeklyReportCreateResponse {
    report: HomeSchoolWeekly
    cached: boolean
    aiGenerated: boolean
}

export interface WeeklyReportGetResponse {
    report: HomeSchoolWeekly
    aiGenerated: boolean
}

/** 花名册条目：学生 + 其最新周报的状态摘要 */
export interface HomeSchoolRosterEntry {
    studentId: string
    anonymousName: string
    /** 最新周报 id；从未生成过时为 null */
    reportId: string | null
    weekKey: string | null
    status: WeeklyReportStatus | null
    masteryDelta: number | null
    /** 未读家长反馈数 */
    unreadFeedbackCount: number
    hasTeacherNote: boolean
}

/** GET /report/home-school/class/:classId 响应 */
export interface HomeSchoolRosterResponse {
    classId: string
    className: string
    roster: HomeSchoolRosterEntry[]
}

export interface SubmitFeedbackRequest {
    feedbackType: 'praise' | 'concern' | 'question' | 'suggestion'
    content: string
}

export interface AddTeacherNoteRequest {
    content: string
    teacherName: string
}

/* ============================================================
 * v5.0 Dashboard 数据真实化（Task：Dashboard 面板数据真实化）
 *
 * 与后端契约对齐，6 个独立端点 + TanStack Query 直接消费
 * ============================================================ */

/** 顶部统计卡片 —— 全局聚合数据 */
export interface DashboardStatsV2 {
    /** 学生总数 */
    totalStudents: number
    /** 本周新增学生数 */
    newStudentsThisWeek: number
    /** 班级总数 */
    totalClasses: number
    /** 诗词库存数 */
    totalPoems: number
    /** 本周新增诗词数 */
    newPoemsThisWeek: number
    /** 今日学习总时长（小时） */
    todayStudyTimeHours: number
    /** 同比/环比变化（百分比，正数为增长） */
    weekOverWeekChange: {
        /** 学生数周环比变化 */
        students: number
        /** 学习时长周环比变化 */
        studyTime: number
    }
    /** 数据来源披露：用于区分演示种子与真实课堂数据 */
    dataProvenance?: {
        containsSyntheticData: boolean
        seedSource: string | null
        syntheticAnswerCount: number
        syntheticStudentCount: number
    }
}

/** 告警等级 */
export type DashboardAlertLevel = 'info' | 'warning' | 'error'

/** 单条告警 —— 前端期望契约 */
export interface DashboardAlertV2 {
    id: string
    level: DashboardAlertLevel
    title: string
    detail: string
    /** ISO 8601 时间戳字符串，或 ms 时间戳数字（兼容两种后端实现） */
    timestamp: string | number
    /** 跳转链接（可选） */
    actionUrl?: string
    /** 操作按钮文案（可选） */
    actionLabel?: string
}

/** 告警列表响应 */
export interface DashboardAlertsResponse {
    alerts: DashboardAlertV2[]
}

/** 雷达图单维度数据点 */
export interface BloomRadarDimension {
    /** 维度名称（记忆/理解/应用/分析/评价/创造） */
    name: string
    /** 数值 0-100 */
    value: number
}

/** 六阶能力雷达数据 —— 新契约 */
export interface BloomRadarDataV2 {
    /** 本班六维度数值 */
    levels: BloomRadarDimension[]
    /** 对比基线（年级/全校均值） */
    classAverage: BloomRadarDimension[]
}

/** 班级热点画像 —— 活跃度 + 薄弱知识点排行 */
export interface ClassHotspotDataV2 {
    /** 班级活跃度排行（前 5） */
    activityRanking: Array<{
        className: string
        activityScore: number
    }>
    /** 薄弱知识点排行（前 5） */
    weakKnowledgeRanking: Array<{
        knowledge: string
        weaknessScore: number
    }>
}

/** 创新指标卡片数据 */
export interface InnovationData {
    /** 本周 AI 调用次数 */
    aiUsageCount: number
    /** 本周教案生成数 */
    lessonPlansGenerated: number
    /** 本周智能批改次数 */
    gradingCount: number
    /** 进化之眼触发次数 */
    evolutionTriggers: number
}

/** 周学习进度 —— 学生 × 天矩阵 */
export interface WeeklyProgressData {
    /** 学生列表（按本周总时长降序取前 20） */
    students: Array<{ id: string; name: string }>
    /**
     * 本周 7 天日期（ISO 字符串，['2026-07-19', ..., '2026-07-25']）
     *
     * 键名是 matrixDays 而非 days：同一个端点里 `days` 已被 v1 的
     * 「按天分组的课程列表」占用（WeeklyDay[]），两者结构完全不同，
     * 共用键名会让其中一方静默拿到错误类型。
     */
    matrixDays: string[]
    /** 学习时长矩阵（分钟），matrix[studentIndex][dayIndex] */
    matrix: number[][]
}

/* ============================================================
 * 系统设置 —— 模型凭据
 * ============================================================ */

/** 单个模型供应商的配置状态（后端只回传掩码，永不回传明文） */
export interface ModelCredentialStatus {
    provider: 'deepseek' | 'mimo' | 'dashscope' | 'wanBaseUrl'
    label: string
    /** 该密钥驱动的能力说明 */
    powers: string
    /** 申请密钥的控制台地址 */
    console: string
    configured: boolean
    /** 掩码，如 sk-****3f2a；未配置时为空串 */
    masked: string
    inputKind?: 'secret' | 'url'
}

/** 模型凭据由哪里管理；Render 使用持久盘加密保险柜。 */
export interface ModelCredentialManagement {
    mutable: boolean
    managedBy: 'encrypted-vault' | 'local-env'
}

/** 模型凭据列表的完整服务端契约。 */
export interface ModelCredentialSettings {
    providers: ModelCredentialStatus[]
    management: ModelCredentialManagement
}

/** 连通性检测结果 */
export interface CredentialTestResult {
    ok: boolean
    /** 面向教师的结论文案 */
    message: string
    /** 供应商返回的原始错误，便于排查 */
    detail?: string
    latencyMs: number
}

/**
 * 从对话消息中取出纯文本
 *
 * 自 content 支持「文本 + 图片」的片段数组之后，任何把 content 直接当
 * string 用的地方（渲染、拼 prompt、统计字数）都必须先归一化。
 * 图片片段在纯文本语境下折算成一个占位标记，而不是被静默丢掉——
 * 否则「我发过一张图」这件事会从上下文里凭空消失。
 */
export function aiMessageText(content: string | AiContentPart[]): string {
    if (typeof content === 'string') return content
    return content
        .map((part) => (part.type === 'text' ? part.text : '［图片］'))
        .join('')
}

/* ============================================================
 * 课堂闯关（导播台七模式共用）
 *
 * 关卡按布鲁姆六阶划分：闯关记录因此能直接回流成掌握度，
 * 与诊断/命题/雷达图共用同一套学情模型，而不是另起一套对不上的数据。
 * ============================================================ */

/** 单个关卡在关卡链上的状态 */
export interface QuestLevelNode {
    level: string
    title: string
    goal: string
    /** 本堂课这一关有几道题（0 表示本课不涉及该关） */
    questionCount: number
    cleared: boolean
    current: boolean
}

/** 闯关快照 —— 由服务端算好整份下发 */
export interface QuestSnapshot {
    currentLevel: string
    levelTitle: string
    levelGoal: string
    clearedLevels: string[]
    levels: QuestLevelNode[]
    /** 全班合作累计的诗力值 */
    classPower: number
    /** 本关已累计 / 通关所需 */
    levelPower: number
    levelTarget: number
    /** 本关进度百分比 0-100 */
    levelProgress: number
    /** 当前连对数与历史最高 */
    combo: number
    maxCombo: number
    /** AI 虚拟对手累计分（全班的追赶目标） */
    aiOpponentScore: number
    leaderboard: {
        personal: Array<{ studentId: string; name: string; score: number }>
        teams: Array<{ id: string; name: string; score: number; members: number }>
    }
    hasTeams: boolean
}

/** 通关事件（服务端单独广播一帧，前端据此播放通关动画） */
export interface LevelClearedEvent {
    clearedLevel: string
    nextLevel: string | null
    allCleared: boolean
}

// ============================================================
// 长期记忆治理（教师显式管理；服务端签名会话 + 单教师本地租户边界）
// ============================================================

export type MemoryGovernanceKind = 'student' | 'teacher'

export interface MemoryGovernanceItem {
    id: string
    kind: MemoryGovernanceKind
    userId: string
    classId?: string
    content: string
    tags: string[]
    createdAt: number
    lastAccessedAt: number
    accessCount: number
    expiresAt: number
}

export interface MemoryGovernanceListResponse {
    memories: MemoryGovernanceItem[]
    total: number
    governance: {
        authenticated: false
        policy: string
    }
}

export interface MemoryGovernanceCreateRequest {
    teacherId: string
    kind: MemoryGovernanceKind
    studentId?: string
    classId?: string
    content: string
    tags?: string[]
    retentionDays?: number
}

export interface MemoryGovernanceUpdateRequest {
    teacherId: string
    content: string
}
