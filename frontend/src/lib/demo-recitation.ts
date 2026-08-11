/**
 * DEMO 模式朗读模块降级数据（v5.0 Task 5.8 —— DEMO 模式深度优化 / Task #137 补全其他方法）
 *
 * 设计目的：
 * - 当后端服务不可达时，前端 CultureContextPage / RecitationPage / 课堂模式等
 *   依赖 api.recitation.* 的页面降级到演示数据，保证评委预览体验
 * - 数据与 graphMock.ts、demo-data.ts 中的诗 ID 完全对齐，确保跨页面数据自洽
 * - 诗 content 字段使用纯文本（与后端 repos.poems.findAll() 返回格式一致），
 *   非 Markdown 格式，确保 TranslationPanel 的逐行切分逻辑正常工作
 *
 * 数据来源：
 * - 诗 ID 与 graphMock.ts 完全对齐（poem-jingyesi 等）
 * - content 字段使用统编版小学语文教材原文（人教版教师用书 + 古诗文网交叉验证）
 * - 6 首诗覆盖 1-6 年级教学篇目，与 DEMO_POEMS / DEMO_DASHBOARD_STATS 联动
 *
 * 覆盖范围（Task #137）：
 * - listPoems              ✓ 已有
 * - generateTts            ✓ 本次新增（静音 WAV data URL 占位）
 * - transcribe             ✓ 本次新增（原文作为 transcript）
 * - evaluate               ✓ 本次新增（确定性三维评分 + 1 条改进建议）
 * - history                ✓ 本次新增（3 条历史记录）
 * - leaderboard            ✓ 本次新增（8 条脱敏排行榜）
 * - audio                  ✓ 本次新增（占位音频对比数据）
 * - delete                 ✓ 本次新增（删除成功响应）
 *
 * 使用规则：
 * - 仅在 isDemoMode() === true 时使用
 * - 演示数据为静态常量，不写入 localStorage
 * - recitedByStudent 默认 false（评委预览时不显示"已朗读"徽章）
 * - ttsAudioUrl 默认 undefined（DEMO 模式无 TTS 服务）
 * - 所有 AI 生成内容均标记 aiGenerated: true（符合创 AI 案例征集要求）
 */

import type {
    RecitationPoem,
    RecitationPoemsResponse,
    RecitationTtsRequest,
    RecitationTtsResponse,
    RecitationAsrResponse,
    RecitationEvaluateRequest,
    RecitationEvaluateResponse,
    RecitationMistake,
    RecitationHistoryEntry,
    RecitationHistoryResponse,
    RecitationLeaderboardEntry,
    RecitationLeaderboardResponse,
    RecitationAudioResponse,
    RecitationDeleteResponse,
} from './types'

/* ============================================================
 * 一、DEMO 朗读诗列表
 *
 * 6 首诗与 graphMock.ts 完全对齐：
 * - poem-jingyesi 静夜思（李白·唐）一年级上册
 * - poem-wanglushanpubu 望庐山瀑布（李白·唐）二年级下册
 * - poem-chunxiao 春晓（孟浩然·唐）一年级下册
 * - poem-dengguanquelou 登鹳雀楼（王之涣·唐）二年级上册
 * - poem-cuncao 赋得古原草送别（白居易·唐）二年级下册
 * - poem-jiangxue 江雪（柳宗元·唐）三年级上册
 *
 * content 格式说明：
 * - 纯文本，无 Markdown 标记
 * - 句间使用中文逗号"，"分隔
 * - 联句之间使用中文句号"。"分隔
 * - TranslationPanel 通过 content.split(/\n+/) 切分行，因此也可使用 \n 分隔
 * ============================================================ */

export const DEMO_RECITATION_POEMS: RecitationPoem[] = [
    {
        id: 'poem-jingyesi',
        title: '静夜思',
        poet: '李白',
        dynasty: '唐',
        content: '床前明月光，疑是地上霜。举头望明月，低头思故乡。',
        recitedByStudent: false,
    },
    {
        id: 'poem-chunxiao',
        title: '春晓',
        poet: '孟浩然',
        dynasty: '唐',
        content: '春眠不觉晓，处处闻啼鸟。夜来风雨声，花落知多少。',
        recitedByStudent: false,
    },
    {
        id: 'poem-wanglushanpubu',
        title: '望庐山瀑布',
        poet: '李白',
        dynasty: '唐',
        content: '日照香炉生紫烟，遥看瀑布挂前川。飞流直下三千尺，疑是银河落九天。',
        recitedByStudent: false,
    },
    {
        id: 'poem-dengguanquelou',
        title: '登鹳雀楼',
        poet: '王之涣',
        dynasty: '唐',
        content: '白日依山尽，黄河入海流。欲穷千里目，更上一层楼。',
        recitedByStudent: false,
    },
    {
        id: 'poem-cuncao',
        title: '赋得古原草送别',
        poet: '白居易',
        dynasty: '唐',
        content: '离离原上草，一岁一枯荣。野火烧不尽，春风吹又生。',
        recitedByStudent: false,
    },
    {
        id: 'poem-jiangxue',
        title: '江雪',
        poet: '柳宗元',
        dynasty: '唐',
        content: '千山鸟飞绝，万径人踪灭。孤舟蓑笠翁，独钓寒江雪。',
        recitedByStudent: false,
    },
]

/* ============================================================
 * 二、便捷查询函数
 * ============================================================ */

/**
 * 获取 DEMO 朗读诗列表响应（api.recitation.listPoems 的降级数据）
 *
 * 与后端 GET /api/recitation/poems 返回结构完全对齐：
 * { status: 'ok', poems: RecitationPoem[] }
 *
 * studentId 参数在 DEMO 模式下忽略（不标注 recitedByStudent）
 */
export function getDemoRecitationPoems(_studentId?: string): RecitationPoemsResponse {
    return {
        status: 'ok',
        poems: DEMO_RECITATION_POEMS,
    }
}

/**
 * 根据 poemId 获取单首 DEMO 诗
 *
 * 用于 api.recitation.ttsGenerate 等接口的降级数据查询
 * 找不到时返回 undefined
 */
export function findDemoPoemById(poemId: string): RecitationPoem | undefined {
    return DEMO_RECITATION_POEMS.find((p) => p.id === poemId)
}

/* ============================================================
 * 三、静音 WAV 占位音频生成器（Task #137）
 *
 * 设计目的：
 * - DEMO 模式下无 TTS 服务，但 AudioPlayer 需要有效 src 才能渲染
 * - 生成极低采样率（100 Hz）的静音 WAV data URL，体积小巧（~1.4KB/10s）
 * - 浏览器 <audio> 元素可正常加载，播放为静音，不影响评委预览流程
 * - 通过 cache 复用相同时长的 data URL，避免重复生成
 *
 * WAV 文件结构（PCM, 8-bit, mono, 100 Hz）：
 * - RIFF header: 12 bytes
 * - fmt chunk: 24 bytes
 * - data chunk header: 8 bytes
 * - audio data: numSamples bytes（全部 128 = 静音中点）
 * ============================================================ */

const silentWavCache = new Map<number, string>()

/** 向 DataView 写入 ASCII 字符串 */
function writeString(view: DataView, offset: number, str: string): void {
    for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i))
    }
}

/**
 * 生成指定时长的静音 WAV data URL
 *
 * @param durationSec 音频时长（秒），向上取整减少缓存条目
 * @returns data:audio/wav;base64,... 格式的 URL
 */
function getSilentWavDataUrl(durationSec: number): string {
    // 向上取整到最近的秒数，减少缓存条目
    const roundedSec = Math.max(1, Math.ceil(durationSec))
    const cached = silentWavCache.get(roundedSec)
    if (cached) return cached

    // 100 Hz 采样率，8-bit PCM，单声道 —— 极低比特率保持 data URL 小巧
    const sampleRate = 100
    const numSamples = roundedSec * sampleRate
    const buffer = new ArrayBuffer(44 + numSamples)
    const view = new DataView(buffer)

    // RIFF header
    writeString(view, 0, 'RIFF')
    view.setUint32(4, 36 + numSamples, true)
    writeString(view, 8, 'WAVE')

    // fmt chunk
    writeString(view, 12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true) // PCM 格式
    view.setUint16(22, 1, true) // 单声道
    view.setUint32(24, sampleRate, true)
    view.setUint32(28, sampleRate, true) // byte rate = sampleRate * channels * bitsPerSample/8
    view.setUint16(32, 1, true) // block align = channels * bitsPerSample/8
    view.setUint16(34, 8, true) // bitsPerSample

    // data chunk
    writeString(view, 36, 'data')
    view.setUint32(40, numSamples, true)

    // 静音数据（8-bit PCM 中点 128 表示静音）
    for (let i = 0; i < numSamples; i++) {
        view.setUint8(44 + i, 128)
    }

    // 转 base64（浏览器环境 btoa 可用）
    const bytes = new Uint8Array(buffer)
    let binary = ''
    for (let i = 0; i < bytes.length; i++) {
        const byte = bytes[i]
        if (byte !== undefined) {
            binary += String.fromCharCode(byte)
        }
    }
    const url = `data:audio/wav;base64,${btoa(binary)}`
    silentWavCache.set(roundedSec, url)
    return url
}

/* ============================================================
 * 四、字符串哈希函数（生成确定性评分）
 *
 * 基于 poemId 生成确定性哈希，确保同一首诗每次评估得分一致
 * 避免评委多次预览时分数抖动
 * ============================================================ */

function hashString(str: string): number {
    let hash = 0
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i)
        hash |= 0 // 转 32-bit 整数
    }
    return Math.abs(hash)
}

/* ============================================================
 * 五、TTS 范读 DEMO 数据（api.recitation.generateTts 降级）
 * ============================================================ */

/**
 * 估算诗的朗读时长（毫秒）
 *
 * 每字约 500ms（古诗朗读节奏，含停顿），
 * 标点符号不计入字数。
 */
function estimatePoemDurationMs(content: string): number {
    // 移除标点符号，只计汉字
    const charCount = content.replace(/[，。！？、；：\u201c\u201d\u2018\u2019（）《》]/g, '').length
    return Math.max(3000, charCount * 500)
}

/**
 * DEMO 模式下生成 TTS 范读响应
 *
 * - audioUrl: 静音 WAV data URL（占位，可被 <audio> 播放）
 * - durationMs: 基于诗字数估算
 * - cached: false（DEMO 模式无缓存）
 * - aiGenerated: true（标记 AI 生成内容）
 */
export function generateDemoTts(req: RecitationTtsRequest): RecitationTtsResponse {
    const poem = findDemoPoemById(req.poemId)
    const content = poem?.content ?? ''
    const durationMs = estimatePoemDurationMs(content)
    const durationSec = durationMs / 1000

    return {
        status: 'ok',
        audioUrl: getSilentWavDataUrl(durationSec),
        durationMs,
        cached: false,
        aiGenerated: true,
    }
}

/* ============================================================
 * 六、ASR 转写 DEMO 数据（api.recitation.transcribe 降级）
 * ============================================================ */

/**
 * DEMO 模式下模拟 ASR 转写响应
 *
 * - transcript: 返回诗的原文（假设学生朗读完美）
 * - audioUrl: 占位 URL（DEMO 模式无实际音频存储）
 * - audioDurationSec: 基于诗字数估算
 * - aiGenerated: true（标记 AI 生成内容）
 *
 * @param _audioBlob 学生录音 Blob（DEMO 模式下忽略）
 * @param poemId 古诗 ID
 */
export function transcribeDemoAudio(
    _audioBlob: Blob,
    poemId: string,
): RecitationAsrResponse {
    const poem = findDemoPoemById(poemId)
    const content = poem?.content ?? ''
    const durationMs = estimatePoemDurationMs(content)

    return {
        status: 'ok',
        // 占位 URL：DEMO 模式下无实际音频存储，使用 demo:// 协议标识
        audioUrl: `demo://recording/${encodeURIComponent(poemId)}`,
        transcript: content,
        audioDurationSec: durationMs / 1000,
        aiGenerated: true,
    }
}

/* ============================================================
 * 七、朗读评估 DEMO 数据（api.recitation.evaluate 降级）
 * ============================================================ */

/** 确定性生成 0-range 范围内的整数 */
function deterministicScore(hash: number, base: number, range: number): number {
    return base + (hash % range)
}

/**
 * DEMO 模式下生成朗读评估响应
 *
 * 评分策略（基于 poemId 哈希生成确定性分数）：
 * - pronunciation: 85-95（发音得分）
 * - rhythm: 82-92（节奏得分）
 * - emotion: 80-90（情感得分）
 * - overallScore: 三维加权 0.4/0.3/0.3
 * - mistakes: 1 条轻微节奏建议（使评估结果更真实）
 * - suggestion: 通用改进建议
 * - aiGenerated: true（标记 AI 生成内容）
 */
export function evaluateDemoRecitation(req: RecitationEvaluateRequest): RecitationEvaluateResponse {
    const poem = findDemoPoemById(req.poemId)
    const content = poem?.content ?? req.transcript ?? ''
    const hash = hashString(req.poemId)

    const pronunciation = deterministicScore(hash, 85, 11) // 85-95
    const rhythm = deterministicScore(hash >> 3, 82, 11)   // 82-92
    const emotion = deterministicScore(hash >> 6, 80, 11)  // 80-90
    const overallScore = Math.round(pronunciation * 0.4 + rhythm * 0.3 + emotion * 0.3)

    // 生成 1 条轻微节奏建议（使评估结果更真实，非满分才有改进空间）
    const mistakes: RecitationMistake[] = [
        {
            type: 'rhythm',
            position: '第二句',
            detail: '诗句节奏稍快，停顿不够明显',
            suggestion: '注意古诗词的"二二一"节奏，如"疑是/地上/霜"，在斜杠处适当停顿',
        },
    ]

    const suggestion = poem
        ? `《${poem.title}》朗读整体流畅，情感表达到位。建议在关键意象处加强停顿，让听众更好地感受"${poem.title}"的意境。`
        : '朗读整体流畅，情感表达到位。建议在关键意象处加强停顿，让听众更好地感受诗歌的意境。'

    return {
        status: 'ok',
        recitationId: `demo-rec-${req.poemId}-${Date.now()}`,
        transcript: req.transcript ?? content,
        pronunciation,
        rhythm,
        emotion,
        overallScore,
        mistakes,
        suggestion,
        audioDurationSec: req.audioDurationSec ?? estimatePoemDurationMs(content) / 1000,
        aiGenerated: true,
    }
}

/* ============================================================
 * 八、朗读历史 DEMO 数据（api.recitation.history 降级）
 * ============================================================ */

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * DEMO 模式下返回朗读历史记录
 *
 * 3 条历史记录覆盖最近两周：
 * - 3 天前：静夜思，综合 88 分
 * - 7 天前：春晓，综合 92 分
 * - 14 天前：登鹳雀楼，综合 85 分
 *
 * audioUrl 为 null（DEMO 模式无实际音频存储）
 * aiGenerated 标记为 true
 */
export function getDemoRecitationHistory(_studentId?: string): RecitationHistoryResponse {
    const now = Date.now()

    const history: RecitationHistoryEntry[] = [
        {
            id: `demo-rec-jingyesi-${now - 3 * DAY_MS}`,
            poemId: 'poem-jingyesi',
            poemTitle: '静夜思',
            poet: '李白',
            dynasty: '唐',
            audioUrl: null,
            transcript: '床前明月光，疑是地上霜。举头望明月，低头思故乡。',
            pronunciationScore: 88,
            rhythmScore: 85,
            emotionScore: 90,
            overallScore: 88,
            suggestion: '朗读整体流畅，情感表达到位。建议在"疑是地上霜"处加强停顿，让听众更好感受思乡之情。',
            audioDurationSec: 12,
            createdAt: now - 3 * DAY_MS,
            aiGenerated: true,
        },
        {
            id: `demo-rec-chunxiao-${now - 7 * DAY_MS}`,
            poemId: 'poem-chunxiao',
            poemTitle: '春晓',
            poet: '孟浩然',
            dynasty: '唐',
            audioUrl: null,
            transcript: '春眠不觉晓，处处闻啼鸟。夜来风雨声，花落知多少。',
            pronunciationScore: 92,
            rhythmScore: 93,
            emotionScore: 91,
            overallScore: 92,
            suggestion: '发音清晰，节奏把握准确，情感自然。继续保持对春天意象的细腻表达。',
            audioDurationSec: 10,
            createdAt: now - 7 * DAY_MS,
            aiGenerated: true,
        },
        {
            id: `demo-rec-dengguanquelou-${now - 14 * DAY_MS}`,
            poemId: 'poem-dengguanquelou',
            poemTitle: '登鹳雀楼',
            poet: '王之涣',
            dynasty: '唐',
            audioUrl: null,
            transcript: '白日依山尽，黄河入海流。欲穷千里目，更上一层楼。',
            pronunciationScore: 86,
            rhythmScore: 84,
            emotionScore: 85,
            overallScore: 85,
            suggestion: '"欲穷千里目"一句可加强气势，体现诗人登高望远的豪情。',
            audioDurationSec: 11,
            createdAt: now - 14 * DAY_MS,
            aiGenerated: true,
        },
    ]

    return {
        status: 'ok',
        history,
    }
}

/* ============================================================
 * 九、班级朗读排行榜 DEMO 数据（api.recitation.leaderboard 降级）
 * ============================================================ */

/**
 * DEMO 模式下返回班级朗读排行榜
 *
 * 8 条脱敏排行榜数据：
 * - 学生姓名使用"学生H01-H08"格式脱敏
 * - 覆盖 4 首诗，得分 83-95 分
 * - createdAt 使用相对时间戳（最近 5 天内）
 * - aiGenerated: true
 *
 * @param _classId 班级 ID（DEMO 模式下忽略）
 * @param limit 返回条数上限（默认 50，DEMO 数据固定 8 条）
 */
export function getDemoRecitationLeaderboard(
    _classId?: string,
    limit?: number,
): RecitationLeaderboardResponse {
    const now = Date.now()

    const allEntries: RecitationLeaderboardEntry[] = [
        {
            rank: 1,
            recitationId: `demo-rec-leader-001`,
            studentId: 'demo-stu-H01',
            anonymousName: '学生H01',
            poemId: 'poem-jingyesi',
            poemTitle: '静夜思',
            poet: '李白',
            overallScore: 95,
            pronunciationScore: 96,
            rhythmScore: 94,
            emotionScore: 95,
            createdAt: now - 1 * DAY_MS,
            aiGenerated: true,
        },
        {
            rank: 2,
            recitationId: `demo-rec-leader-002`,
            studentId: 'demo-stu-H02',
            anonymousName: '学生H02',
            poemId: 'poem-chunxiao',
            poemTitle: '春晓',
            poet: '孟浩然',
            overallScore: 93,
            pronunciationScore: 92,
            rhythmScore: 94,
            emotionScore: 93,
            createdAt: now - 1 * DAY_MS,
            aiGenerated: true,
        },
        {
            rank: 3,
            recitationId: `demo-rec-leader-003`,
            studentId: 'demo-stu-H03',
            anonymousName: '学生H03',
            poemId: 'poem-wanglushanpubu',
            poemTitle: '望庐山瀑布',
            poet: '李白',
            overallScore: 91,
            pronunciationScore: 90,
            rhythmScore: 92,
            emotionScore: 91,
            createdAt: now - 2 * DAY_MS,
            aiGenerated: true,
        },
        {
            rank: 4,
            recitationId: `demo-rec-leader-004`,
            studentId: 'demo-stu-H04',
            anonymousName: '学生H04',
            poemId: 'poem-dengguanquelou',
            poemTitle: '登鹳雀楼',
            poet: '王之涣',
            overallScore: 90,
            pronunciationScore: 91,
            rhythmScore: 89,
            emotionScore: 90,
            createdAt: now - 2 * DAY_MS,
            aiGenerated: true,
        },
        {
            rank: 5,
            recitationId: `demo-rec-leader-005`,
            studentId: 'demo-stu-H05',
            anonymousName: '学生H05',
            poemId: 'poem-jingyesi',
            poemTitle: '静夜思',
            poet: '李白',
            overallScore: 88,
            pronunciationScore: 87,
            rhythmScore: 88,
            emotionScore: 89,
            createdAt: now - 3 * DAY_MS,
            aiGenerated: true,
        },
        {
            rank: 6,
            recitationId: `demo-rec-leader-006`,
            studentId: 'demo-stu-H06',
            anonymousName: '学生H06',
            poemId: 'poem-jiangxue',
            poemTitle: '江雪',
            poet: '柳宗元',
            overallScore: 87,
            pronunciationScore: 86,
            rhythmScore: 88,
            emotionScore: 87,
            createdAt: now - 3 * DAY_MS,
            aiGenerated: true,
        },
        {
            rank: 7,
            recitationId: `demo-rec-leader-007`,
            studentId: 'demo-stu-H07',
            anonymousName: '学生H07',
            poemId: 'poem-chunxiao',
            poemTitle: '春晓',
            poet: '孟浩然',
            overallScore: 85,
            pronunciationScore: 84,
            rhythmScore: 86,
            emotionScore: 85,
            createdAt: now - 4 * DAY_MS,
            aiGenerated: true,
        },
        {
            rank: 8,
            recitationId: `demo-rec-leader-008`,
            studentId: 'demo-stu-H08',
            anonymousName: '学生H08',
            poemId: 'poem-cuncao',
            poemTitle: '赋得古原草送别',
            poet: '白居易',
            overallScore: 83,
            pronunciationScore: 82,
            rhythmScore: 84,
            emotionScore: 83,
            createdAt: now - 5 * DAY_MS,
            aiGenerated: true,
        },
    ]

    return {
        status: 'ok',
        leaderboard: limit ? allEntries.slice(0, limit) : allEntries,
        aiGenerated: true,
    }
}

/* ============================================================
 * 十、朗读音频对比 DEMO 数据（api.recitation.audio 降级）
 * ============================================================ */

/**
 * DEMO 模式下返回朗读音频对比数据
 *
 * - studentAudioUrl: null（DEMO 模式无实际音频存储）
 * - ttsAudioUrl: null（DEMO 模式无 TTS 范读）
 * - transcript: 诗的原文
 * - poemId: 从 recitationId 中提取或使用默认值
 *
 * @param recitationId 朗读记录 ID
 */
export function getDemoRecitationAudio(recitationId: string): RecitationAudioResponse {
    // 尝试从 recitationId 中提取 poemId（格式：demo-rec-{poemId}-{timestamp}）
    const match = recitationId.match(/^demo-rec-(poem-[a-z]+)-\d+$/)
    const poemId = match?.[1] ?? 'poem-jingyesi'
    const poem = findDemoPoemById(poemId)

    return {
        status: 'ok',
        recitationId,
        studentAudioUrl: null,
        ttsAudioUrl: null,
        transcript: poem?.content ?? null,
        poemId,
    }
}

/* ============================================================
 * 十一、删除朗读记录 DEMO 响应（api.recitation.delete 降级）
 * ============================================================ */

/**
 * DEMO 模式下模拟删除朗读记录
 *
 * 直接返回成功响应，前端 store 会乐观更新历史列表
 */
export function deleteDemoRecitation(recitationId: string): RecitationDeleteResponse {
    return {
        status: 'ok',
        recitationId,
        deleted: true,
    }
}
