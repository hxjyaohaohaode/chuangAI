/**
 * DEMO 模式错题本数据（Phase 4.1 —— 学生错题本 + 间隔重复）
 *
 * 设计依据：评委无后端时仍可预览完整学生复习体验。
 *
 * 数据来源（多源交叉验证）：
 * 1. 《义务教育语文课程标准》第一学段古诗词教学要求
 * 2. 人教版小学语文教师教学用书（一年级上册/下册）
 * 3. 古诗文网（gushiwen.org）诗文原文与赏析
 * 4. SuperMemo 2 算法论文（Piotr Wozniak, 1990）
 * 5. Anki 间隔重复软件的算法实现参考
 *
 * SM-2 算法实现：
 * - 经典间隔重复算法，经数十年验证的科学记忆模型
 * - 根据复习质量评分(0-5)动态调整易度因子(EF)和复习间隔
 * - 答对(quality≥3)：间隔增长，EF 可能上升
 * - 答错(quality<3)：间隔重置为1天，EF 下降
 *
 * 掌握标准：
 * - 连续正确重复次数(repetitions) ≥ 3 且 EF ≥ 2.5
 * - 标记为 mastered 后不再出现在待复习列表中
 */

import type {
    ErrorNotebookItem,
    ErrorNotebookListItem,
    ErrorNotebookListResponse,
    ReviewSubmitRequest,
    ReviewSubmitResponse,
    ReviewStatsResponse,
    SpacedRepetitionState,
    ReviewQuality,
    BloomLevel,
} from './types'

/* ============================================================
 * SM-2 算法核心实现
 * ============================================================ */

/**
 * SM-2 间隔重复算法 —— 根据复习质量更新记忆状态
 *
 * 算法公式（SuperMemo 2）：
 * - quality ≥ 3（答对）：
 *   - repetitions = 0 → interval = 1 天
 *   - repetitions = 1 → interval = 6 天
 *   - repetitions ≥ 2 → interval = interval × EF 天
 *   - repetitions++
 * - quality < 3（答错）：
 *   - interval = 1 天，repetitions = 0
 * - EF 调整：EF' = EF + (0.1 - (5-q)×(0.08 + (5-q)×0.02))，下限 1.3
 *
 * @param state 当前间隔重复状态
 * @param quality 复习质量评分（0-5）
 * @returns 更新后的间隔重复状态
 */
export function sm2Algorithm(
    state: SpacedRepetitionState,
    quality: ReviewQuality,
): SpacedRepetitionState {
    const { easeFactor, intervalDays, repetitions } = state
    const now = Date.now()
    const DAY_MS = 24 * 60 * 60 * 1000

    let newRepetitions: number
    let newInterval: number

    if (quality >= 3) {
        // 答对：间隔递增
        if (repetitions === 0) {
            newInterval = 1
        } else if (repetitions === 1) {
            newInterval = 6
        } else {
            newInterval = Math.max(1, Math.round(intervalDays * easeFactor))
        }
        newRepetitions = repetitions + 1
    } else {
        // 答错：间隔重置
        newInterval = 1
        newRepetitions = 0
    }

    // 更新易度因子 EF
    const q = quality
    let newEF = easeFactor + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))
    if (newEF < 1.3) newEF = 1.3
    if (newEF > 3.0) newEF = 3.0
    // 保留两位小数
    newEF = Math.round(newEF * 100) / 100

    return {
        easeFactor: newEF,
        intervalDays: newInterval,
        repetitions: newRepetitions,
        nextReviewDate: now + newInterval * DAY_MS,
        lastReviewDate: now,
    }
}

/**
 * 判断错题是否已掌握
 *
 * 掌握标准：连续正确重复次数 ≥ 3 且 EF ≥ 2.5
 */
export function isMastered(state: SpacedRepetitionState): boolean {
    return state.repetitions >= 3 && state.easeFactor >= 2.5
}

/* ============================================================
 * DEMO 错题数据
 * ============================================================ */

const DAY_MS = 24 * 60 * 60 * 1000
const now = Date.now()

/** 静夜思错题：5条（覆盖4种来源、5个 Bloom 层级） */
const JINGYESI_ERRORS: ErrorNotebookItem[] = [
    {
        id: 'demo-err-001',
        studentId: 'demo-student-001',
        poemId: 'jingyesi',
        poemTitle: '静夜思',
        poet: '李白',
        bloomLevel: '理解',
        source: 'diagnose',
        questionStem: '"床前明月光"中的"床"指的是什么？',
        studentAnswer: '睡觉的床铺',
        correctAnswer: '井栏（古称"床"为井上围栏）',
        analysis: '此处的"床"是古代井栏的称呼，而非睡觉的床铺。李白站在井边望月思乡，这是古代文人常见的思乡意象。记忆策略：联想"井栏→井水→故乡"的意象链。',
        errorCount: 2,
        firstErrorAt: now - 7 * DAY_MS,
        lastErrorAt: now - 3 * DAY_MS,
        repetition: {
            easeFactor: 2.36,
            intervalDays: 1,
            repetitions: 0,
            nextReviewDate: now - 2 * 3600 * 1000, // 2小时前到期（待复习）
            lastReviewDate: now - 3 * DAY_MS,
        },
        mastered: false,
        aiGenerated: true,
    },
    {
        id: 'demo-err-002',
        studentId: 'demo-student-001',
        poemId: 'jingyesi',
        poemTitle: '静夜思',
        poet: '李白',
        bloomLevel: '记忆',
        source: 'dictation',
        questionStem: '默写："疑是地上霜"中的"疑"字',
        studentAnswer: '凝（写成"凝是地上霜"）',
        correctAnswer: '疑（疑是地上霜）',
        analysis: '"疑"字意为"怀疑、以为"，诗人将月光误认为白霜，营造清冷意境。形近字辨析：疑（怀疑）vs 凝（凝聚）。记忆策略：疑=匕+矢+矛+疋，想象"用匕首、箭矢、长矛去质疑"的画面。',
        errorCount: 3,
        firstErrorAt: now - 10 * DAY_MS,
        lastErrorAt: now - 1 * DAY_MS,
        repetition: {
            easeFactor: 2.2,
            intervalDays: 1,
            repetitions: 0,
            nextReviewDate: now + 2 * 3600 * 1000, // 2小时后到期
            lastReviewDate: now - 1 * DAY_MS,
        },
        mastered: false,
        aiGenerated: true,
    },
    {
        id: 'demo-err-003',
        studentId: 'demo-student-001',
        poemId: 'jingyesi',
        poemTitle: '静夜思',
        poet: '李白',
        bloomLevel: '评价',
        source: 'recitation',
        questionStem: '朗读评测：评价《静夜思》的情感表达',
        studentAnswer: '读得平淡，缺乏思乡之情',
        correctAnswer: '应在前两句用舒缓语调营造静谧氛围，后两句用略带忧伤的语调表达思乡之情',
        analysis: '《静夜思》的情感层次：前两句写景（客观）→ 后两句抒情（主观）。朗读时需通过语速和语调的变化体现情感递进。前两句语速稍慢，"疑"字轻读；后两句"举头""低头"形成动作对比，语调由轻快转沉重。',
        errorCount: 1,
        firstErrorAt: now - 5 * DAY_MS,
        lastErrorAt: now - 5 * DAY_MS,
        repetition: {
            easeFactor: 2.5,
            intervalDays: 1,
            repetitions: 0,
            nextReviewDate: now + 6 * 3600 * 1000, // 6小时后到期
            lastReviewDate: null,
        },
        mastered: false,
        aiGenerated: true,
    },
    {
        id: 'demo-err-004',
        studentId: 'demo-student-001',
        poemId: 'jingyesi',
        poemTitle: '静夜思',
        poet: '李白',
        bloomLevel: '应用',
        source: 'quest',
        questionStem: '《静夜思》中"举头望明月"使用了什么动作描写？这一动作反映了诗人怎样的心理？',
        studentAnswer: '只是抬头看月亮，没有特别含义',
        correctAnswer: '"举头"是仰视动作，反映诗人从沉思中被月光吸引，抬头寻月的心理变化，暗示从恍惚到清醒的过程',
        analysis: '动作描写是古诗常用的表现手法。"举头"与下句"低头"形成对比：举头→望月（思乡触发），低头→思乡（情感深化）。两个动作构成完整的情感逻辑链。记忆策略：举头（外向观察）→ 低头（内省沉思）。',
        errorCount: 1,
        firstErrorAt: now - 2 * DAY_MS,
        lastErrorAt: now - 2 * DAY_MS,
        repetition: {
            easeFactor: 2.5,
            intervalDays: 6,
            repetitions: 1,
            nextReviewDate: now + 4 * DAY_MS, // 4天后到期
            lastReviewDate: now - 2 * DAY_MS,
        },
        mastered: false,
        aiGenerated: true,
    },
    {
        id: 'demo-err-005',
        studentId: 'demo-student-001',
        poemId: 'jingyesi',
        poemTitle: '静夜思',
        poet: '李白',
        bloomLevel: '分析',
        source: 'diagnose',
        questionStem: '分析《静夜思》中"霜"这一意象的作用',
        studentAnswer: '只是描写地上的白色',
        correctAnswer: '"霜"是核心意象，具有三重作用：① 视觉上比喻月光的洁白；② 触觉上暗示夜的寒冷；③ 情感上暗示思乡的凄凉。三者叠加营造清冷孤寂的意境',
        analysis: '意象分析需要从多感官维度切入。"霜"不仅是一种视觉比喻（月光如霜），更承载了触觉（冷）和情感（凄凉）的多重含义。这是古诗意象"一物多义"的典型范例。记忆策略：霜=视觉（白）+触觉（冷）+情感（孤）。',
        errorCount: 2,
        firstErrorAt: now - 8 * DAY_MS,
        lastErrorAt: now - 4 * DAY_MS,
        repetition: {
            easeFactor: 2.8,
            intervalDays: 6,
            repetitions: 1,
            nextReviewDate: now + 2 * DAY_MS, // 2天后到期
            lastReviewDate: now - 4 * DAY_MS,
        },
        mastered: false,
        aiGenerated: true,
    },
]

/** 春晓错题：3条（覆盖3个 Bloom 层级） */
const CHUNXIAO_ERRORS: ErrorNotebookItem[] = [
    {
        id: 'demo-err-006',
        studentId: 'demo-student-001',
        poemId: 'chunxiao',
        poemTitle: '春晓',
        poet: '孟浩然',
        bloomLevel: '应用',
        source: 'quest',
        questionStem: '"处处闻啼鸟"中的"处处"和"闻"分别强调了什么？',
        studentAnswer: '到处都能听到鸟叫',
        correctAnswer: '"处处"强调鸟鸣的普遍性（空间维度），"闻"强调听觉感知（感官维度），二者结合渲染春日清晨生机盎然的氛围',
        analysis: '词语赏析需要从修饰范围和感官角度分析。"处处"是空间副词，强调范围之广；"闻"是听觉动词，突出以听觉感知春天。这种"以声写静"的手法是中国古典诗词的常见技巧。记忆策略：处处（空间广）+ 闻（听觉）= 春意盎然。',
        errorCount: 1,
        firstErrorAt: now - 6 * DAY_MS,
        lastErrorAt: now - 6 * DAY_MS,
        repetition: {
            easeFactor: 2.5,
            intervalDays: 1,
            repetitions: 0,
            nextReviewDate: now - 3600 * 1000, // 1小时前到期（待复习）
            lastReviewDate: null,
        },
        mastered: false,
        aiGenerated: true,
    },
    {
        id: 'demo-err-007',
        studentId: 'demo-student-001',
        poemId: 'chunxiao',
        poemTitle: '春晓',
        poet: '孟浩然',
        bloomLevel: '分析',
        source: 'diagnose',
        questionStem: '"花落知多少"用了什么修辞手法？表达了怎样的情感？',
        studentAnswer: '用了比喻，表达喜欢花',
        correctAnswer: '用了设问（自问自答）和借代（花落代指春逝），表达惜春之情和对春光易逝的惆怅',
        analysis: '此句的关键在于"知多少"——这是一个反问/设问，暗示诗人也不知道落了多少花。修辞判断：① 设问（知多少？）；② 借代（花落代春光消逝）。情感分析：由"喜春"（处处闻啼鸟）转向"惜春"（花落知多少），情感层次丰富。记忆策略：问句+花落=惜春惆怅。',
        errorCount: 2,
        firstErrorAt: now - 9 * DAY_MS,
        lastErrorAt: now - 5 * DAY_MS,
        repetition: {
            easeFactor: 2.6,
            intervalDays: 15,
            repetitions: 2,
            nextReviewDate: now + 10 * DAY_MS, // 10天后到期
            lastReviewDate: now - 5 * DAY_MS,
        },
        mastered: false,
        aiGenerated: true,
    },
    {
        id: 'demo-err-008',
        studentId: 'demo-student-001',
        poemId: 'chunxiao',
        poemTitle: '春晓',
        poet: '孟浩然',
        bloomLevel: '记忆',
        source: 'dictation',
        questionStem: '默写："春眠不觉晓"的完整诗句',
        studentAnswer: '春眠不觉晓，处处闻啼鸟（漏写后两句）',
        correctAnswer: '春眠不觉晓，处处闻啼鸟。夜来风雨声，花落知多少。',
        analysis: '《春晓》全诗四句，需完整记忆。记忆策略：前两句写"晓"（春晨）→ 后两句写"夜"（昨夜风雨）。时间线索：昨夜→今晨。内容对照：听觉（鸟鸣）vs 听觉（风雨），喜悦（鸟鸣）vs 惆怅（花落）。',
        errorCount: 1,
        firstErrorAt: now - 3 * DAY_MS,
        lastErrorAt: now - 3 * DAY_MS,
        repetition: {
            easeFactor: 2.5,
            intervalDays: 1,
            repetitions: 0,
            nextReviewDate: now + 4 * 3600 * 1000, // 4小时后到期
            lastReviewDate: null,
        },
        mastered: false,
        aiGenerated: true,
    },
]

/** 已掌握的错题：1条（展示已掌握状态） */
const MASTERED_ERRORS: ErrorNotebookItem[] = [
    {
        id: 'demo-err-009',
        studentId: 'demo-student-001',
        poemId: 'jingyesi',
        poemTitle: '静夜思',
        poet: '李白',
        bloomLevel: '记忆',
        source: 'dictation',
        questionStem: '默写《静夜思》全诗',
        studentAnswer: '床前明月光，疑是地上霜。举头望明月，低头思故乡。（最初遗漏"低"字）',
        correctAnswer: '床前明月光，疑是地上霜。举头望明月，低头思故乡。',
        analysis: '全诗四句二十字，需逐字准确默写。关键易错字：疑（非"凝"）、霜（非"双"）、故（非"固"）。',
        errorCount: 3,
        firstErrorAt: now - 20 * DAY_MS,
        lastErrorAt: now - 14 * DAY_MS,
        repetition: {
            easeFactor: 2.7,
            intervalDays: 30,
            repetitions: 4,
            nextReviewDate: now + 22 * DAY_MS,
            lastReviewDate: now - 8 * DAY_MS,
        },
        mastered: true,
        aiGenerated: true,
    },
]

/** 全部错题（合并） */
const ALL_ERRORS: ErrorNotebookItem[] = [
    ...JINGYESI_ERRORS,
    ...CHUNXIAO_ERRORS,
    ...MASTERED_ERRORS,
]

/** 内存中的错题状态（DEMO 模式下模拟持久化） */
let demoErrorStore: ErrorNotebookItem[] = [...ALL_ERRORS]

/* ============================================================
 * DEMO 数据访问函数
 * ============================================================ */

/** 判断错题是否今日到期 */
function isDueToday(item: ErrorNotebookItem): boolean {
    if (item.mastered) return false
    return item.repetition.nextReviewDate <= now + DAY_MS
}

/** 转换为列表条目 */
function toListItem(item: ErrorNotebookItem): ErrorNotebookListItem {
    return {
        id: item.id,
        poemId: item.poemId,
        poemTitle: item.poemTitle,
        poet: item.poet,
        bloomLevel: item.bloomLevel,
        source: item.source,
        errorCount: item.errorCount,
        lastErrorAt: item.lastErrorAt,
        nextReviewDate: item.repetition.nextReviewDate,
        dueToday: isDueToday(item),
        mastered: item.mastered,
    }
}

/**
 * 获取错题本列表（DEMO）
 */
export function getDemoErrorNotebookList(): ErrorNotebookListResponse {
    const items = demoErrorStore.map(toListItem)
    const dueToday = items.filter((i) => i.dueToday).length
    const masteredCount = items.filter((i) => i.mastered).length
    return {
        items,
        total: items.length,
        dueToday,
        masteredCount,
    }
}

/**
 * 获取单个错题详情（DEMO）
 */
export function getDemoErrorNotebookItem(itemId: string): ErrorNotebookItem | null {
    return demoErrorStore.find((i) => i.id === itemId) ?? null
}

/**
 * 提交复习（DEMO）—— 执行 SM-2 算法更新间隔重复状态
 */
export function submitDemoReview(req: ReviewSubmitRequest): ReviewSubmitResponse {
    const item = demoErrorStore.find((i) => i.id === req.itemId)
    if (!item) {
        throw new Error(`DEMO 错题条目不存在: ${req.itemId}`)
    }

    const previousMastered = item.mastered
    const updatedRepetition = sm2Algorithm(item.repetition, req.quality)
    const newMastered = isMastered(updatedRepetition)

    // 更新内存中的错题
    const updatedItem: ErrorNotebookItem = {
        ...item,
        repetition: updatedRepetition,
        mastered: newMastered,
        // 答对(quality>=3)不增加 errorCount，答错才说明还没掌握
        errorCount: req.quality < 3 ? item.errorCount + 1 : item.errorCount,
        lastErrorAt: req.quality < 3 ? Date.now() : item.lastErrorAt,
    }

    demoErrorStore = demoErrorStore.map((i) => (i.id === req.itemId ? updatedItem : i))

    return {
        item: updatedItem,
        updatedRepetition,
        newlyMastered: !previousMastered && newMastered,
        aiGenerated: true,
    }
}

/**
 * 获取复习统计（DEMO）
 */
export function getDemoReviewStats(): ReviewStatsResponse {
    const total = demoErrorStore.length
    const dueToday = demoErrorStore.filter(isDueToday).length
    const masteredCount = demoErrorStore.filter((i) => i.mastered).length
    const averageMastery = total > 0 ? Math.round((masteredCount / total) * 100) : 0

    // 近7天复习曲线（模拟数据）
    const reviewCurve: Array<{ date: string; count: number; correctCount: number }> = []
    for (let i = 6; i >= 0; i--) {
        const date = new Date(now - i * DAY_MS)
        const dateStr = `${date.getMonth() + 1}/${date.getDate()}`
        // 模拟数据：前几天有复习记录
        const count = i > 3 ? Math.floor(Math.random() * 3) + 1 : Math.floor(Math.random() * 2)
        const correctCount = Math.floor(count * 0.7)
        reviewCurve.push({ date: dateStr, count, correctCount })
    }

    // 按 Bloom 层级分布
    const byBloomLevel: Partial<Record<BloomLevel, number>> = {}
    for (const item of demoErrorStore) {
        byBloomLevel[item.bloomLevel] = (byBloomLevel[item.bloomLevel] ?? 0) + 1
    }

    // 按来源分布
    const bySource: Partial<Record<ErrorNotebookItem['source'], number>> = {}
    for (const item of demoErrorStore) {
        bySource[item.source] = (bySource[item.source] ?? 0) + 1
    }

    return {
        totalItems: total,
        dueToday,
        masteredCount,
        averageMastery,
        reviewCurve,
        byBloomLevel,
        bySource,
        aiGenerated: false,
    }
}

