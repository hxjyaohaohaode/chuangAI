/**
 * 示例班级种子数据 —— 三（2）班 40 学生 + 8 周教学进度 + 历史答题数据
 *
 * 全部数据已脱敏，无真实学生信息。
 * 用于演示系统功能与冷启动。
 *
 * 数据规模：
 * - 1 个示例班级（三（2）班，40 学生）
 * - 40 个固定生成的虚构中文姓名；内部学生 ID 与界面显示名严格分离
 * - 8 周教学进度（每周 2 首古诗，共 16 首，引用 tongbian-001 到 tongbian-016）
 * - 1600 条答题记录（40 学生 × 40 题）
 * - 3840 条布鲁姆六阶掌握度（16 首 × 6 阶 × 40 学生）
 * - 240 条学情事件流（登录/答题/朗读/课堂互动/创造工坊提交）
 *
 * 数据生成策略：
 * - 固定种子伪随机（mulberry32），保证可复现
 * - 学生能力分布：正态分布，均值 65，标准差 15
 * - 布鲁姆六阶掌握度按难度递减：识记 > 理解 > 应用 > 分析 > 评价 > 创造
 * - 答题正确率与掌握度正相关
 */

import { syntheticStudentName } from './synthetic-roster.js'

// ─────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────

/** 布鲁姆认知六阶（英文键，便于程序处理；与项目中文层级一一对应） */
type SeedBloomLevel = 'remember' | 'understand' | 'apply' | 'analyze' | 'evaluate' | 'create'

/** 认知风格 */
type SeedCognitiveStyle = 'visual' | 'auditory' | 'kinesthetic'

/** 事件类型 */
type SeedEventType = 'login' | 'answer' | 'recite' | 'interact' | 'create'

export interface SeedClassData {
    classInfo: {
        id: string
        name: string
        grade: string
        teacherId: string
        studentCount: number
    }
    students: Array<{
        id: string
        classId: string
        name: string
        anonymousName: string
        grade: string
        cognitiveStyle: SeedCognitiveStyle
        engagementScore: number
    }>
    lessons: Array<{
        id: string
        classId: string
        week: number
        poemIds: string[]
        startDate: string
        endDate: string
    }>
    answers: Array<{
        id: string
        studentId: string
        questionId: string
        poemId: string
        bloomLevel: SeedBloomLevel
        score: number
        submittedAt: number
    }>
    mastery: Array<{
        studentId: string
        poemId: string
        bloomLevel: SeedBloomLevel
        mastery: number
    }>
    events: Array<{
        id: string
        studentId: string
        type: SeedEventType
        payload: Record<string, unknown>
        timestamp: number
    }>
}

// ─────────────────────────────────────────────────────────────
// 伪随机工具（固定种子，可复现）
// ─────────────────────────────────────────────────────────────

/** mulberry32 伪随机生成器 —— 轻量、快速、可复现 */
function mulberry32(seed: number): () => number {
    let state = seed
    return function () {
        state = (state + 0x6d2b79f5) | 0
        let t = state
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

/** Box-Muller 正态分布随机数 */
function gaussianRandom(rng: () => number, mean: number, std: number): number {
    const u = Math.max(rng(), 1e-10)
    const v = rng()
    return Math.round(mean + std * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v))
}

/** 将数值限制在 [lo, hi] 区间 */
function clamp(x: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, x))
}

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

/** 布鲁姆六阶层级（由易到难） */
const BLOOM_LEVELS: readonly SeedBloomLevel[] = [
    'remember',
    'understand',
    'apply',
    'analyze',
    'evaluate',
    'create',
] as const

/** 布鲁姆六阶难度惩罚（越高阶，掌握度越低） */
const BLOOM_PENALTY: Record<SeedBloomLevel, number> = {
    remember: 0,
    understand: 5,
    apply: 10,
    analyze: 15,
    evaluate: 20,
    create: 25,
}

/** 认知风格（循环分配） */
const COGNITIVE_STYLES: readonly SeedCognitiveStyle[] = [
    'visual',
    'auditory',
    'kinesthetic',
] as const

/** 8 周教学进度，每周 2 首古诗（引用统编版 tongbian-001 到 tongbian-016） */
const LESSON_POEMS: readonly (readonly string[])[] = [
    ['tongbian-001', 'tongbian-002'], // W1: 咏鹅 + 春晓
    ['tongbian-003', 'tongbian-004'], // W2: 静夜思 + 悯农
    ['tongbian-005', 'tongbian-006'], // W3: 登鹳雀楼 + 望庐山瀑布
    ['tongbian-007', 'tongbian-008'], // W4: 江雪 + 望天门山
    ['tongbian-009', 'tongbian-010'], // W5: 饮湖上初晴后雨 + 元日
    ['tongbian-011', 'tongbian-012'], // W6: 九月九日忆山东兄弟 + 暮江吟
    ['tongbian-013', 'tongbian-014'], // W7: 题西林壁 + 枫桥夜泊
    ['tongbian-015', 'tongbian-016'], // W8: 示儿 + 闻官军收河南河北
] as const

/** 事件类型分布（加权，login 最多，create 最少） */
const EVENT_PATTERN: readonly SeedEventType[] = [
    'login',
    'login',
    'login',
    'login',
    'answer',
    'answer',
    'answer',
    'recite',
    'recite',
    'interact',
    'interact',
    'create',
] as const

/** 学期开始时间：2025-09-01 00:00:00 UTC+8 */
const SEMESTER_START = new Date('2025-09-01T00:00:00+08:00').getTime()

/** 一天的毫秒数 */
const DAY_MS = 86400000

// ─────────────────────────────────────────────────────────────
// 数据生成主函数
// ─────────────────────────────────────────────────────────────

function generateSeedClassData(): SeedClassData {
    const rng = mulberry32(42)
    const classId = 'class-demo-302'
    const teacherId = 'teacher-001'

    const students: SeedClassData['students'] = []
    const lessons: SeedClassData['lessons'] = []
    const answers: SeedClassData['answers'] = []
    const mastery: SeedClassData['mastery'] = []
    const events: SeedClassData['events'] = []

    // ── 1. 生成 40 个固定虚构学生 ──
    for (let i = 0; i < 40; i++) {
        const sid = `S${String(i + 1).padStart(2, '0')}`
        const style = COGNITIVE_STYLES[i % COGNITIVE_STYLES.length] ?? 'visual'
        const displayName = syntheticStudentName(i)
        students.push({
            id: `student-${sid}`,
            classId,
            name: displayName,
            anonymousName: displayName,
            grade: '三年级',
            cognitiveStyle: style,
            engagementScore: clamp(gaussianRandom(rng, 75, 15), 30, 98),
        })
    }

    // ── 2. 生成 8 周教学进度 ──
    for (let w = 0; w < 8; w++) {
        const poems = LESSON_POEMS[w]
        if (!poems) continue
        const weekStartTs = SEMESTER_START + w * 7 * DAY_MS
        const weekEndTs = weekStartTs + 6 * DAY_MS
        lessons.push({
            id: `lesson-w${w + 1}`,
            classId,
            week: w + 1,
            poemIds: [...poems],
            startDate: new Date(weekStartTs).toISOString().slice(0, 10),
            endDate: new Date(weekEndTs).toISOString().slice(0, 10),
        })
    }

    // ── 3. 生成答题数据（每学生每周 5 题 × 8 周 = 40 题） ──
    // 学生能力值（正态分布 N(65, 15)，作为答题与掌握度的基础）
    const studentAbilities: number[] = []
    for (let s = 0; s < 40; s++) {
        studentAbilities.push(clamp(gaussianRandom(rng, 65, 15), 20, 95))
    }

    let answerCounter = 0
    for (let s = 0; s < 40; s++) {
        const student = students[s]
        if (!student) continue
        const ability = studentAbilities[s] ?? 65

        for (let w = 0; w < 8; w++) {
            const lesson = lessons[w]
            if (!lesson) continue
            const weekStartTs = SEMESTER_START + w * 7 * DAY_MS

            for (let q = 0; q < 5; q++) {
                const poemIndex = q % 2
                const poemId = lesson.poemIds[poemIndex] ?? lesson.poemIds[0] ?? 'tongbian-001'
                const bloomLevel = BLOOM_LEVELS[q % BLOOM_LEVELS.length] ?? 'remember'
                const penalty = BLOOM_PENALTY[bloomLevel] ?? 0
                const score = clamp(
                    Math.round(ability - penalty + gaussianRandom(rng, 0, 10)),
                    0,
                    100,
                )
                const submittedAt = weekStartTs + q * DAY_MS + Math.floor(rng() * 28800000) // 当天 0-8 小时内随机

                answers.push({
                    id: `answer-${String(++answerCounter).padStart(5, '0')}`,
                    studentId: student.id,
                    questionId: `q-${poemId}-${bloomLevel}-${w + 1}-${q + 1}`,
                    poemId,
                    bloomLevel,
                    score,
                    submittedAt,
                })
            }
        }
    }

    // ── 4. 生成布鲁姆六阶掌握度（16 首 × 6 阶 × 40 学生 = 3840 条） ──
    for (let s = 0; s < 40; s++) {
        const student = students[s]
        if (!student) continue
        const ability = studentAbilities[s] ?? 65

        for (let p = 0; p < 16; p++) {
            const poemId = `tongbian-${String(p + 1).padStart(3, '0')}`

            for (let b = 0; b < 6; b++) {
                const bloomLevel = BLOOM_LEVELS[b] ?? 'remember'
                const penalty = BLOOM_PENALTY[bloomLevel] ?? 0
                // 掌握度为 EMA 平滑值，噪声比答题更小（std=8）
                const masteryScore = clamp(
                    Math.round(ability - penalty + gaussianRandom(rng, 0, 8)),
                    0,
                    100,
                )
                mastery.push({
                    studentId: student.id,
                    poemId,
                    bloomLevel,
                    mastery: masteryScore,
                })
            }
        }
    }

    // ── 5. 生成学情事件流（240 条，覆盖 5 类行为） ──
    let eventCounter = 0
    const totalEvents = 240

    for (let e = 0; e < totalEvents; e++) {
        const student = students[e % 40]
        if (!student) continue
        const type = EVENT_PATTERN[e % EVENT_PATTERN.length] ?? 'login'
        const week = Math.floor(e / 30) % 8 // 每 30 条事件推进一周
        const dayInWeek = e % 7
        const ts = SEMESTER_START + week * 7 * DAY_MS + dayInWeek * DAY_MS + Math.floor(rng() * 32400000) // 当天 0-9 小时内随机

        const payload: Record<string, unknown> = {}

        if (type === 'answer') {
            const poemIdx = e % 16
            const bloomIdx = e % 6
            payload['questionId'] = `q-tongbian-${String(poemIdx + 1).padStart(3, '0')}-${BLOOM_LEVELS[bloomIdx] ?? 'remember'}-1-1`
            payload['poemId'] = `tongbian-${String(poemIdx + 1).padStart(3, '0')}`
            payload['score'] = clamp(gaussianRandom(rng, 65, 15), 0, 100)
            payload['correct'] = (payload['score'] as number) >= 60
        } else if (type === 'recite') {
            const poemIdx = e % 16
            payload['poemId'] = `tongbian-${String(poemIdx + 1).padStart(3, '0')}`
            payload['durationSec'] = Math.floor(rng() * 60) + 30
            payload['pronunciationScore'] = clamp(gaussianRandom(rng, 70, 12), 30, 98)
        } else if (type === 'interact') {
            const actions = ['raise_hand', 'answer_question', 'group_discussion', 'volunteer_recite']
            payload['action'] = actions[e % actions.length] ?? 'raise_hand'
            payload['lessonId'] = `lesson-w${week + 1}`
            payload['durationSec'] = Math.floor(rng() * 120) + 15
        } else if (type === 'create') {
            const poemIdx = e % 16
            const workTypes = ['rewrite', 'illustration', 'continuation', 'appreciation']
            payload['workType'] = workTypes[e % workTypes.length] ?? 'rewrite'
            payload['poemId'] = `tongbian-${String(poemIdx + 1).padStart(3, '0')}`
            payload['wordCount'] = Math.floor(rng() * 200) + 50
        } else {
            // login
            const devices = ['desktop', 'tablet', 'mobile']
            payload['device'] = devices[e % devices.length] ?? 'desktop'
            payload['sessionDurationMin'] = Math.floor(rng() * 45) + 10
        }

        events.push({
            id: `event-${String(++eventCounter).padStart(4, '0')}`,
            studentId: student.id,
            type,
            payload,
            timestamp: ts,
        })
    }

    return {
        classInfo: {
            id: classId,
            name: '三（2）班',
            grade: '三年级',
            teacherId,
            studentCount: 40,
        },
        students,
        lessons,
        answers,
        mastery,
        events,
    }
}

// ─────────────────────────────────────────────────────────────
// 导出
// ─────────────────────────────────────────────────────────────

export const SEED_CLASS_DEMO: SeedClassData = generateSeedClassData()
