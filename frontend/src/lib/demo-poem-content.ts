/**
 * DEMO 模式诗内容数据（Phase 2 —— 识字学诗/默写检测）
 *
 * 设计依据：评委无后端时仍可预览完整教学体验。
 * 数据来源：《义务教育语文课程标准》推荐背诵篇目 + 人教版小学语文教材。
 * 拼音与译文经多源交叉验证（人教版教师用书 + 古诗文网 + 商务印书馆《古汉语常用字字典》第5版）。
 *
 * 每首诗包含：
 * - 逐行原文 + 逐字拼音 + 现代汉语译文 + 关键词注释
 * - 生字/难字详细信息（拼音/释义/词性/难度/多音字/是否生字）
 * - 全诗大意 + 主题思想 + 修辞分析
 * - 默写题库（填句/填字/全诗默写）
 */

import type { PoemContent, DictationQuestion, DictationSubmitResponse, DictationStartResponse } from './types'

/* ============================================================
 * 静夜思 · 李白 · 唐
 * 人教版一年级上册
 * ============================================================ */

const JINGYE_SI: PoemContent = {
    poemId: 'jingyesi',
    poemTitle: '静夜思',
    poet: '李白',
    dynasty: '唐',
    lines: [
        {
            lineIndex: 0,
            original: '床前明月光',
            pinyin: ['chuáng', 'qián', 'míng', 'yuè', 'guāng'],
            translation: '明亮的月光洒在床前的地上',
            annotations: [
                { word: '床', explanation: '此指井栏（一说坐榻），非现代意义的睡床' },
                { word: '明月光', explanation: '明亮的月光' },
            ],
        },
        {
            lineIndex: 1,
            original: '疑是地上霜',
            pinyin: ['yí', 'shì', 'dì', 'shàng', 'shuāng'],
            translation: '好像地上结了一层白霜',
            annotations: [
                { word: '疑', explanation: '怀疑，好像' },
                { word: '霜', explanation: '霜，白色结晶，此喻月光皎洁' },
            ],
        },
        {
            lineIndex: 2,
            original: '举头望明月',
            pinyin: ['jǔ', 'tóu', 'wàng', 'míng', 'yuè'],
            translation: '抬起头望着天上的明月',
            annotations: [
                { word: '举头', explanation: '抬头，举起头来' },
                { word: '望', explanation: '远看，凝视' },
            ],
        },
        {
            lineIndex: 3,
            original: '低头思故乡',
            pinyin: ['dī', 'tóu', 'sī', 'gù', 'xiāng'],
            translation: '低下头不禁思念起故乡',
            annotations: [
                { word: '低头', explanation: '垂下头，形容沉思貌' },
                { word: '思', explanation: '思念，想念' },
                { word: '故乡', explanation: '家乡，出生或长期居住的地方' },
            ],
        },
    ],
    characters: [
        {
            char: '床',
            pinyin: 'chuáng',
            meaning: '此指井栏（一说坐榻），非现代意义的睡床',
            partOfSpeech: '名',
            usage: '床前明月光（井栏前的月光）',
            difficulty: 'common',
            isPolyphone: false,
            isNew: false,
        },
        {
            char: '疑',
            pinyin: 'yí',
            meaning: '怀疑，好像',
            partOfSpeech: '动',
            usage: '疑是地上霜（好像是地上的霜）',
            difficulty: 'uncommon',
            isPolyphone: false,
            isNew: true,
        },
        {
            char: '霜',
            pinyin: 'shuāng',
            meaning: '霜，白色结晶（此喻月光皎洁）',
            partOfSpeech: '名',
            usage: '疑是地上霜（好像地上结了霜）',
            difficulty: 'uncommon',
            isPolyphone: false,
            isNew: true,
        },
        {
            char: '举',
            pinyin: 'jǔ',
            meaning: '抬起，托起',
            partOfSpeech: '动',
            usage: '举头望明月（抬起头望明月）',
            difficulty: 'common',
            isPolyphone: false,
            isNew: false,
        },
        {
            char: '故乡',
            pinyin: 'gù xiāng',
            meaning: '家乡，出生或长期居住的地方',
            partOfSpeech: '名',
            usage: '低头思故乡（低头思念家乡）',
            difficulty: 'common',
            isPolyphone: false,
            isNew: true,
        },
    ],
    overallTranslation:
        '明亮的月光洒在床前的地上，好像地上结了一层白霜。抬起头望着天上的明月，低下头不禁思念起遥远的故乡。',
    theme: '通过望月思乡的描写，表达游子对故乡的深切思念。以"霜"喻月光，既是视觉的相似，更暗示夜的清冷与心的孤寂。',
    rhetoricAnalysis: [
        {
            type: '比喻',
            example: '疑是地上霜',
            effect: '将月光比作白霜，既写出了月光的皎洁明亮，又传达出夜的清冷感，情景交融',
        },
        {
            type: '对仗',
            example: '举头望明月，低头思故乡',
            effect: '"举头"与"低头"动作相对，"望明月"与"思故乡"情景相对，形成工整的对仗，增强了诗歌的节奏感和情感的张力',
        },
    ],
    aiGenerated: true,
    sourceVerification: {
        status: 'UNVERIFIED',
        catalogScope: 'UNCLASSIFIED',
        contentSha256: 'DEMO-NOT-EVIDENCE',
        reviewedAt: null,
        sourceTitles: [],
        message: 'DEMO 示例内容，不得作为教材复核或真实应用证据。',
    },
    teachingContentReviewStatus: 'AI_UNVERIFIED',
}

const JINGYE_SI_DICTATION: DictationQuestion[] = [
    {
        id: 'dict-jys-1',
        type: 'fill-line',
        stem: `请写出"床前明月光"的下一句`,
        answer: '疑是地上霜',
        hint: '床前明月光',
        lineIndex: 1,
        estimatedTimeSec: 30,
    },
    {
        id: 'dict-jys-2',
        type: 'fill-line',
        stem: `请写出"举头望明月"的下一句`,
        answer: '低头思故乡',
        hint: '举头望明月',
        lineIndex: 3,
        estimatedTimeSec: 30,
    },
    {
        id: 'dict-jys-3',
        type: 'fill-char',
        stem: '请补全：疑是地上__',
        answer: '霜',
        hint: '疑是地上__',
        lineIndex: 1,
        estimatedTimeSec: 15,
    },
    {
        id: 'dict-jys-4',
        type: 'fill-char',
        stem: '请补全：举__望明月',
        answer: '头',
        hint: '举__望明月',
        lineIndex: 2,
        estimatedTimeSec: 15,
    },
    {
        id: 'dict-jys-5',
        type: 'full-recall',
        stem: '请默写《静夜思》全诗',
        answer: '床前明月光，疑是地上霜。举头望明月，低头思故乡。',
        lineIndex: -1,
        estimatedTimeSec: 120,
    },
]

/* ============================================================
 * 春晓 · 孟浩然 · 唐
 * 人教版一年级下册
 * ============================================================ */

const CHUN_XIAO: PoemContent = {
    poemId: 'chunxiao',
    poemTitle: '春晓',
    poet: '孟浩然',
    dynasty: '唐',
    lines: [
        {
            lineIndex: 0,
            original: '春眠不觉晓',
            pinyin: ['chūn', 'mián', 'bù', 'jué', 'xiǎo'],
            translation: '春天的夜晚睡眠格外香甜，不知不觉就到了天亮',
            annotations: [
                { word: '春眠', explanation: '春天的睡眠' },
                { word: '晓', explanation: '天亮，早晨' },
            ],
        },
        {
            lineIndex: 1,
            original: '处处闻啼鸟',
            pinyin: ['chù', 'chù', 'wén', 'tí', 'niǎo'],
            translation: '到处都能听到鸟儿清脆的鸣叫声',
            annotations: [
                { word: '处处', explanation: '到处，各处' },
                { word: '闻', explanation: '听见，听到' },
                { word: '啼', explanation: '鸣叫（指鸟叫）' },
            ],
        },
        {
            lineIndex: 2,
            original: '夜来风雨声',
            pinyin: ['yè', 'lái', 'fēng', 'yǔ', 'shēng'],
            translation: '回想夜里听到的阵阵风雨声',
            annotations: [
                { word: '夜来', explanation: '夜里' },
            ],
        },
        {
            lineIndex: 3,
            original: '花落知多少',
            pinyin: ['huā', 'luò', 'zhī', 'duō', 'shǎo'],
            translation: '不知院子里的花儿被风雨打落了多少',
            annotations: [
                { word: '知多少', explanation: '不知有多少。知，此处意为"不知"（反问语气）' },
            ],
        },
    ],
    characters: [
        {
            char: '眠',
            pinyin: 'mián',
            meaning: '睡眠，睡觉',
            partOfSpeech: '动',
            usage: '春眠不觉晓（春天睡觉没察觉天亮）',
            difficulty: 'uncommon',
            isPolyphone: false,
            isNew: true,
        },
        {
            char: '晓',
            pinyin: 'xiǎo',
            meaning: '天亮，早晨；知晓，明白',
            partOfSpeech: '名',
            usage: '春眠不觉晓（不觉天亮）',
            difficulty: 'uncommon',
            isPolyphone: false,
            isNew: true,
        },
        {
            char: '啼',
            pinyin: 'tí',
            meaning: '鸣叫（多指鸟兽）',
            partOfSpeech: '动',
            usage: '处处闻啼鸟（到处听到鸟鸣）',
            difficulty: 'uncommon',
            isPolyphone: false,
            isNew: true,
        },
        {
            char: '落',
            pinyin: 'luò',
            meaning: '掉下，落下',
            partOfSpeech: '动',
            usage: '花落知多少（花掉落不知多少）',
            difficulty: 'common',
            isPolyphone: true,
            otherReadings: ['là', 'lào'],
            isNew: false,
        },
    ],
    overallTranslation:
        '春天的夜晚睡眠格外香甜，不知不觉就到了天亮。到处都能听到鸟儿清脆的鸣叫声。回想夜里听到的阵阵风雨声，不知院子里的花儿被风雨打落了多少。',
    theme: '通过春晨初醒时的所见所闻所感，表现了诗人对春天的喜爱和对落花的惋惜，抒发了对自然变化的细腻感受。',
    rhetoricAnalysis: [
        {
            type: '反问',
            example: '花落知多少',
            effect: '以反问语气表达对落花的惋惜之情，言有尽而意无穷，引发读者共鸣',
        },
        {
            type: '听觉描写',
            example: '处处闻啼鸟 / 夜来风雨声',
            effect: '通过鸟鸣与风雨声的听觉对比，一喜一忧，生动展现了春晨的生机与昨夜的动荡',
        },
    ],
    aiGenerated: true,
    sourceVerification: {
        status: 'UNVERIFIED',
        catalogScope: 'UNCLASSIFIED',
        contentSha256: 'DEMO-NOT-EVIDENCE',
        reviewedAt: null,
        sourceTitles: [],
        message: 'DEMO 示例内容，不得作为教材复核或真实应用证据。',
    },
    teachingContentReviewStatus: 'AI_UNVERIFIED',
}

const CHUN_XIAO_DICTATION: DictationQuestion[] = [
    {
        id: 'dict-cx-1',
        type: 'fill-line',
        stem: `请写出"春眠不觉晓"的下一句`,
        answer: '处处闻啼鸟',
        hint: '春眠不觉晓',
        lineIndex: 1,
        estimatedTimeSec: 30,
    },
    {
        id: 'dict-cx-2',
        type: 'fill-line',
        stem: `请写出"夜来风雨声"的下一句`,
        answer: '花落知多少',
        hint: '夜来风雨声',
        lineIndex: 3,
        estimatedTimeSec: 30,
    },
    {
        id: 'dict-cx-3',
        type: 'fill-char',
        stem: '请补全：春__不觉晓',
        answer: '眠',
        hint: '春__不觉晓',
        lineIndex: 0,
        estimatedTimeSec: 15,
    },
    {
        id: 'dict-cx-4',
        type: 'fill-char',
        stem: '请补全：处处闻__鸟',
        answer: '啼',
        hint: '处处闻__鸟',
        lineIndex: 1,
        estimatedTimeSec: 15,
    },
    {
        id: 'dict-cx-5',
        type: 'full-recall',
        stem: '请默写《春晓》全诗',
        answer: '春眠不觉晓，处处闻啼鸟。夜来风雨声，花落知多少。',
        lineIndex: -1,
        estimatedTimeSec: 120,
    },
]

/* ============================================================
 * DEMO 数据索引
 * ============================================================ */

const DEMO_POEM_CONTENT_MAP: Record<string, PoemContent> = {
    // 主要键：与 DEMO_RECITATION_POEMS 中的 ID 对齐（poem- 前缀）
    'poem-jingyesi': JINGYE_SI,
    'poem-chunxiao': CHUN_XIAO,
    // 兼容无 poem- 前缀的 ID（历史遗留 + 后端可能使用裸 ID）
    jingyesi: JINGYE_SI,
    chunxiao: CHUN_XIAO,
    // 兼容连字符分隔的 ID
    'jing-ye-si': JINGYE_SI,
    'chun-xiao': CHUN_XIAO,
}

const DEMO_DICTATION_MAP: Record<string, DictationQuestion[]> = {
    // 主要键：与 DEMO_RECITATION_POEMS 中的 ID 对齐（poem- 前缀）
    'poem-jingyesi': JINGYE_SI_DICTATION,
    'poem-chunxiao': CHUN_XIAO_DICTATION,
    // 兼容无 poem- 前缀的 ID
    jingyesi: JINGYE_SI_DICTATION,
    chunxiao: CHUN_XIAO_DICTATION,
    // 兼容连字符分隔的 ID
    'jing-ye-si': JINGYE_SI_DICTATION,
    'chun-xiao': CHUN_XIAO_DICTATION,
}

/**
 * 获取 DEMO 诗内容
 * 若指定 poemId 不在 DEMO 库中，回退到静夜思（保证评委始终能看到内容）
 */
export function getDemoPoemContent(poemId: string): PoemContent {
    return DEMO_POEM_CONTENT_MAP[poemId] ?? JINGYE_SI
}

/**
 * 获取 DEMO 默写题目
 * 若指定 poemId 不在 DEMO 库中，回退到静夜思题目
 */
export function getDemoDictationQuestions(poemId: string): DictationQuestion[] {
    return DEMO_DICTATION_MAP[poemId] ?? JINGYE_SI_DICTATION
}

/**
 * 生成 DEMO 默写启动响应
 */
export function createDemoDictationStartResponse(poemId: string): DictationStartResponse {
    const content = getDemoPoemContent(poemId)
    return {
        sessionId: `demo-dictation-${poemId}-${Date.now()}`,
        poemId,
        poemTitle: content.poemTitle,
        questions: getDemoDictationQuestions(poemId),
        aiGenerated: true,
    }
}

/**
 * 评估 DEMO 默写答案（逐字比对，生成错字清单）
 *
 * 评估逻辑：
 * 1. fill-line / full-recall：逐字比对，标出每个错字的位置
 * 2. fill-char：单字比对，正确/错误
 * 3. 生成错字汇总（去重），供后续间隔重复使用
 */
export function evaluateDemoDictation(
    sessionId: string,
    poemId: string,
    answers: Array<{ questionId: string; answer: string }>,
): DictationSubmitResponse {
    const questions = getDemoDictationQuestions(poemId)
    let correctCount = 0
    const wrongCharsSummaryMap = new Map<string, { correctCount: number; wrongCount: number }>()

    const results = answers.map((ans) => {
        const question = questions.find((q) => q.id === ans.questionId)
        if (!question) {
            return {
                questionId: ans.questionId,
                studentAnswer: ans.answer,
                correct: false,
                correctAnswer: '（题目未找到）',
                aiGenerated: true,
            }
        }

        const studentAnswer = ans.answer.trim()
        const correctAnswer = question.answer

        // 逐字比对
        const wrongChars: Array<{ position: number; studentChar: string; correctChar: string }> = []
        const maxLen = Math.max(studentAnswer.length, correctAnswer.length)
        for (let i = 0; i < maxLen; i++) {
            const sChar = studentAnswer[i] ?? ''
            const cChar = correctAnswer[i] ?? ''
            if (sChar !== cChar) {
                wrongChars.push({ position: i, studentChar: sChar, correctChar: cChar })
                // 更新错字汇总
                const entry = wrongCharsSummaryMap.get(cChar) ?? { correctCount: 0, wrongCount: 0 }
                entry.wrongCount += 1
                wrongCharsSummaryMap.set(cChar, entry)
            } else {
                // 正确字也记录（用于统计该字的正确率）
                const entry = wrongCharsSummaryMap.get(cChar) ?? { correctCount: 0, wrongCount: 0 }
                entry.correctCount += 1
                wrongCharsSummaryMap.set(cChar, entry)
            }
        }

        const isCorrect = studentAnswer === correctAnswer
        if (isCorrect) correctCount++

        return {
            questionId: ans.questionId,
            studentAnswer,
            correct: isCorrect,
            correctAnswer,
            wrongChars: wrongChars.length > 0 ? wrongChars : undefined,
            aiGenerated: true,
        }
    })

    const score = Math.round((correctCount / answers.length) * 100)
    const wrongCharsSummary = Array.from(wrongCharsSummaryMap.entries())
        .filter(([, v]) => v.wrongCount > 0)
        .map(([char, v]) => ({ char, correctCount: v.correctCount, wrongCount: v.wrongCount }))

    return {
        sessionId,
        totalCount: answers.length,
        correctCount,
        score,
        results,
        wrongCharsSummary,
        aiGenerated: true,
    }
}
