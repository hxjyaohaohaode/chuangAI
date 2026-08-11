/**
 * 课堂闯关引擎
 *
 * ─────────────────────────────────────────────────────────────
 * 这个模块解决什么问题
 * ─────────────────────────────────────────────────────────────
 * 导播台的七个模式此前只是「一道题接一道题地播」：没有关的概念、
 * 没有共享的积分池、切个模式等于重开。而真正的课堂需要的是一条
 * 贯穿全程的推进线——学生知道自己在打第几关、还差多少通关、
 * 全班的努力有没有累积下来。
 *
 * 本引擎提供两样东西：
 * 1. **关卡**：按布鲁姆六阶（记忆→理解→应用→分析→评价→创造）划分，
 *    逐关解锁。之所以用六阶而不是自定关卡，是因为诊断、命题、雷达图
 *    整套学情体系都建立在六阶模型上——闯关按它划分，通关记录才能
 *    直接回流成掌握度，而不是又一套对不上的独立数据。
 * 2. **积分**：四种激励同时存在且共用一套状态，切模式不清零。
 *
 * ─────────────────────────────────────────────────────────────
 * 为什么判分要拆成"本地即时 + AI 补讲评"
 * ─────────────────────────────────────────────────────────────
 * 原实现里 submit 同步等 brush.grade Agent 返回，实测单次 7955ms。
 * 教室里只有一块大屏、全班一起看，教师点一下要等近 8 秒才知道对错，
 * 一节课二十道题就是两分半的冷场——这在统一授课下是致命的。
 *
 * 所以：本地规则先判对错（微秒级，当场亮灯、当场加分），
 * AI 只负责随后补一段讲评，通过 WebSocket 回填。
 * 对错这件事对客观题本来就是确定的，不需要大模型；
 * 大模型真正的价值在"为什么错、怎么改"，那部分晚一两秒毫无损失。
 */

import type { BloomLevel } from '../../agents/base/types.js'

/** 六阶关卡顺序 —— 与全系统的布鲁姆模型保持同一份定义 */
export const QUEST_LEVELS: readonly BloomLevel[] = [
    '记忆', '理解', '应用', '分析', '评价', '创造',
] as const

/** 每关的展示信息（给大屏用，教师不需要自己解释"这关考什么"） */
export const LEVEL_META: Record<string, { title: string; goal: string }> = {
    记忆: { title: '第一关 · 识记', goal: '把诗句准确地记住' },
    理解: { title: '第二关 · 通义', goal: '说清每句诗的意思' },
    应用: { title: '第三关 · 致用', goal: '在新情境里用上这首诗' },
    分析: { title: '第四关 · 探微', goal: '拆解写法与结构' },
    评价: { title: '第五关 · 品鉴', goal: '说出好在哪里' },
    创造: { title: '第六关 · 化用', goal: '仿写与再创作' },
}

/** 单个小组 */
export interface QuestTeam {
    id: string
    name: string
    /** 组员 studentId */
    members: string[]
    score: number
}

/** 闯关状态（挂在 ClassroomRuntime 上，随课堂一起持久化） */
export interface QuestState {
    /** 当前关（布鲁姆层级） */
    currentLevel: BloomLevel
    /** 已通关的层级 */
    clearedLevels: BloomLevel[]
    /**
     * 全班合作的「诗力值」
     *
     * 四种激励里唯一**不分你我**的一种：答对就往同一个池子里加。
     * 统一授课下这一条最重要——它让答错的孩子不会当众垫底，
     * 全班仍在同一条船上。
     */
    classPower: number
    /** 通关所需诗力值（按当前关的题量动态给出） */
    levelTarget: number
    /** 本关已累计的诗力值 */
    levelPower: number
    /** 个人积分（studentId -> 分） */
    personalScores: Record<string, number>
    /** 小组积分 */
    teams: QuestTeam[]
    /** AI 虚拟对手的累计分，作为全班的追赶目标 */
    aiOpponentScore: number
    /** 连对数（全班层面），用于连击加成 */
    combo: number
    /** 历史最高连击 */
    maxCombo: number
    /** 每关的开始时间戳，用于课后报告 */
    levelStartedAt: number
}

/** 基础分：答对一题的诗力值 */
const BASE_POWER = 10
/** 连击加成上限（第 5 连及以上封顶，避免一路滚雪球失去意义） */
const MAX_COMBO_BONUS = 5

/**
 * 建立初始闯关状态
 *
 * `levelTarget` 按本关真实题量推算：题量 × 基础分 × 0.7。
 * 取 0.7 是刻意留出容错——不要求全对才能过关，
 * 一节课里有两三道题卡住是常态，卡死在某一关对课堂节奏是灾难。
 */
export function createQuestState(questionsByLevel: Record<string, number>): QuestState {
    const firstLevel = QUEST_LEVELS.find((l) => (questionsByLevel[l] ?? 0) > 0) ?? '记忆'
    return {
        currentLevel: firstLevel,
        clearedLevels: [],
        classPower: 0,
        levelTarget: computeLevelTarget(questionsByLevel[firstLevel] ?? 1),
        levelPower: 0,
        personalScores: {},
        teams: [],
        aiOpponentScore: 0,
        combo: 0,
        maxCombo: 0,
        levelStartedAt: Date.now(),
    }
}

export function computeLevelTarget(questionCount: number): number {
    return Math.max(BASE_POWER, Math.round(questionCount * BASE_POWER * 0.7))
}

/** 一次作答对闯关状态的影响 */
export interface QuestDelta {
    /** 本次获得的诗力值 */
    power: number
    /** 连击数（本次之后） */
    combo: number
    /** 是否因此通关 */
    levelCleared: boolean
    /** 通关后进入的下一关；已是最后一关时为 null */
    nextLevel: BloomLevel | null
    /** 全部关卡是否已通关 */
    allCleared: boolean
}

/**
 * 结算一次作答
 *
 * @param teamId 学生所属小组；无分组时传 undefined
 */
export function applyAnswer(
    state: QuestState,
    params: {
        studentId: string
        correct: boolean
        /** 作答用时，用于速度加成 */
        latencyMs?: number
        teamId?: string
        questionsByLevel: Record<string, number>
    },
): QuestDelta {
    const { studentId, correct, latencyMs, teamId, questionsByLevel } = params

    if (!correct) {
        // 答错不扣分，只断连击。
        // 小学课堂上扣分带来的羞耻感远大于它的激励作用。
        state.combo = 0
        return {
            power: 0,
            combo: 0,
            levelCleared: false,
            nextLevel: null,
            allCleared: state.clearedLevels.length >= QUEST_LEVELS.length,
        }
    }

    state.combo += 1
    state.maxCombo = Math.max(state.maxCombo, state.combo)

    // 连击加成：第 n 连额外 +(n-1)，封顶 +5
    const comboBonus = Math.min(MAX_COMBO_BONUS, state.combo - 1)
    // 速度加成：10 秒内作答 +3，20 秒内 +1
    const speedBonus = latencyMs === undefined ? 0 : latencyMs <= 10_000 ? 3 : latencyMs <= 20_000 ? 1 : 0
    const power = BASE_POWER + comboBonus + speedBonus

    state.classPower += power
    state.levelPower += power
    state.personalScores[studentId] = (state.personalScores[studentId] ?? 0) + power

    if (teamId) {
        const team = state.teams.find((t) => t.id === teamId)
        if (team) team.score += power
    }

    // ── 通关判定 ──
    let levelCleared = false
    let nextLevel: BloomLevel | null = null
    if (state.levelPower >= state.levelTarget) {
        levelCleared = true
        if (!state.clearedLevels.includes(state.currentLevel)) {
            state.clearedLevels.push(state.currentLevel)
        }
        // 找下一关：跳过没有题目的层级，避免停在一个永远打不过的空关上
        const idx = QUEST_LEVELS.indexOf(state.currentLevel)
        for (let i = idx + 1; i < QUEST_LEVELS.length; i++) {
            const lv = QUEST_LEVELS[i]!
            if ((questionsByLevel[lv] ?? 0) > 0) {
                nextLevel = lv
                break
            }
        }
        if (nextLevel) {
            state.currentLevel = nextLevel
            state.levelPower = 0
            state.levelTarget = computeLevelTarget(questionsByLevel[nextLevel] ?? 1)
            state.levelStartedAt = Date.now()
        }
    }

    return {
        power,
        combo: state.combo,
        levelCleared,
        nextLevel,
        allCleared: levelCleared && nextLevel === null,
    }
}

/**
 * 本地即时判分
 *
 * 只处理**对错是客观确定的**那部分：选择题比选项、填空/默写比归一化后的文本。
 * 判不了的（简答、赏析、仿写）返回 null，交给 AI 异步判——
 * 与其瞎猜一个对错当场亮出来再被 AI 推翻，不如老实标记"待评"。
 */
export function localJudge(
    question: { type?: string; answer: string; options?: unknown },
    studentAnswer: string,
): boolean | null {
    const normalize = (s: string): string =>
        s
            .trim()
            .toLowerCase()
            // 去掉中英文标点与空白：学生写「鹅，鹅，鹅」和「鹅鹅鹅」应判同
            .replace(/[\s，。、；：！？,.;:!?"'「」『』（）()《》]/g, '')

    const expected = normalize(question.answer ?? '')
    const actual = normalize(studentAnswer)
    if (!expected || !actual) return null

    const type = question.type ?? ''

    // 选择题：答案通常是选项字母或选项原文，两者都允许
    if (type.includes('选择')) {
        return actual === expected || actual === expected.slice(0, 1)
    }

    // 填空 / 默写：要求逐字一致（归一化后）
    if (type.includes('填空') || type.includes('默写')) {
        return actual === expected
    }

    // 判断题
    if (type.includes('判断')) {
        const truthy = new Set(['对', '正确', '是', 'true', 't', 'y', '√'])
        const falsy = new Set(['错', '错误', '否', 'false', 'f', 'n', '×', 'x'])
        const e = truthy.has(expected) ? true : falsy.has(expected) ? false : null
        const a = truthy.has(actual) ? true : falsy.has(actual) ? false : null
        if (e === null || a === null) return null
        return e === a
    }

    // 其余题型（简答/赏析/仿写…）本地判不了
    return null
}

/** 排行榜视图（大屏直接用，不必前端再排一遍） */
export interface QuestLeaderboard {
    personal: Array<{ studentId: string; name: string; score: number }>
    teams: Array<{ id: string; name: string; score: number; members: number }>
}

export function buildLeaderboard(
    state: QuestState,
    studentNames: Map<string, string>,
): QuestLeaderboard {
    const personal = Object.entries(state.personalScores)
        .map(([studentId, score]) => ({
            studentId,
            name: studentNames.get(studentId) ?? studentId,
            score,
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 10)

    const teams = [...state.teams]
        .sort((a, b) => b.score - a.score)
        .map((t) => ({ id: t.id, name: t.name, score: t.score, members: t.members.length }))

    return { personal, teams }
}
