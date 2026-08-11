/**
 * 教案模板库路由 —— GET /api/lesson-plans/templates
 *
 * 背景（v5.1 接口打通）：
 * 前端 `api.lessonPlan.templates()` / `getTemplate()` 契约声明的端点是
 * `/api/lesson-plans/templates`（复数），返回 `{ id, title, grade, type,
 * difficulty, duration, description, thumbnail, sections[], ... }` 结构；
 * 而已有的 `/api/lesson-plan/templates`（单数）服务的是另一个概念
 * （`{ name, gradeLevel, lessonCount, keyPhases, recommendedGoals }` 骨架模板），
 * 两者字段完全不同，不能互相顶替。此前该端点缺失，教案工坊默认「模板」Tab
 * 恒为空列表。本模块补齐该资源。
 *
 * 与单数版的分工：
 * - `/api/lesson-plan/templates`   → 教学阶段骨架（供 AI 生成教案时套用节奏）
 * - `/api/lesson-plans/templates`  → 教师可浏览/套用的成品教案模板库（本模块）
 *
 * 数据来源：内置 12 套教案模板，覆盖 低/中/高 三学段 × 新授/复习/拓展 三课型
 * × 基础/进阶/挑战 三难度。与前端 DEMO 模式内置目录保持同一份内容，
 * 确保「有后端」与「DEMO 降级」两条路径下教师看到的模板完全一致。
 */

import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { validateQuery, validateParams } from '../lib/validation.js'
import { handleRouteError } from './_helpers.js'

// ─────────────────────────────────────────────────────────────
// 类型（与前端 lib/types.ts 的 LessonPlanTemplate 严格对齐）
// ─────────────────────────────────────────────────────────────

export type LessonPlanTemplateGrade = 'low' | 'middle' | 'high'
export type LessonPlanTemplateType = 'new' | 'review' | 'extension'
export type LessonPlanTemplateDifficulty = 'basic' | 'advanced' | 'challenge'

export interface LessonPlanTemplateSection {
    title: string
    content: string
}

export interface LessonPlanTemplate {
    id: string
    title: string
    grade: LessonPlanTemplateGrade
    type: LessonPlanTemplateType
    difficulty: LessonPlanTemplateDifficulty
    /** 建议时长（分钟） */
    duration: number
    description: string
    /** 缩略图（前端 public/images 下的静态资源路径） */
    thumbnail?: string
    sections: LessonPlanTemplateSection[]
    /** 适用诗篇关键词，用于推荐匹配与关键词搜索 */
    applicableKeywords?: string[]
    createdAt: number
    updatedAt: number
}

/** 模板基准时间（固定值，保证列表排序结果稳定可复现） */
const BASE_TIME = 1700000000000

const DAY = 86_400_000

// ─────────────────────────────────────────────────────────────
// 内置模板目录（12 套）
// ─────────────────────────────────────────────────────────────

export const LESSON_PLAN_TEMPLATE_CATALOG: readonly LessonPlanTemplate[] = [
    {
        id: 'tpl-low-new-basic-jingyesi',
        title: '低年级·静夜思·新授课（基础）',
        grade: 'low',
        type: 'new',
        difficulty: 'basic',
        duration: 40,
        description: '面向 1-2 年级学生，通过朗读感悟李白思乡之情。重点识字正音，借助插图理解诗意，配画创作延伸。',
        thumbnail: '/images/generated/starmap/tongbian-003.webp',
        sections: [
            { title: '激趣导入', content: '出示月夜图景，提问“夜晚看到月亮会想到什么”，激发学生兴趣，引出诗题。' },
            { title: '识字正音', content: '认读“床、前、明、月、光、疑、举、低”8 个生字，重点关注“疑”的读音和“低”的笔顺。' },
            { title: '逐句释义', content: '借助插图和动作演示，逐句理解诗意，体会“疑是地上霜”的比喻妙处。' },
            { title: '整体感悟', content: '指导有感情朗读，体会诗人由“望月”到“思乡”的情感变化，尝试背诵。' },
            { title: '拓展延伸', content: '结合生活经验，为古诗配画，分享自己的思乡故事。' },
            { title: '作业布置', content: '基础：背诵全诗 + 默写生字；选做：配画创作。' },
        ],
        applicableKeywords: ['思乡', '月亮', '李白', '唐诗', '低年级'],
        createdAt: BASE_TIME,
        updatedAt: BASE_TIME,
    },
    {
        id: 'tpl-low-new-advanced-chunxiao',
        title: '低年级·春晓·新授课（进阶）',
        grade: 'low',
        type: 'new',
        difficulty: 'advanced',
        duration: 40,
        description: '面向 1-2 年级学生，深化“知诗人/解诗题/明诗意/悟诗情”四步教学法，融入角色扮演与情境体验。',
        thumbnail: '/images/generated/starmap/tongbian-002.webp',
        sections: [
            { title: '情境导入', content: '播放春日鸟鸣音频，营造春晨氛围，引导学生想象“春眠不觉晓”的意境。' },
            { title: '识字正音', content: '认读“晓、眠、闻、啼、落、知”等生字，重点正音“眠(mián)”和“啼(tí)”。' },
            { title: '逐句感悟', content: '通过角色扮演（诗人/鸟儿/落花），体会诗歌的视听对比与惜春之情。' },
            { title: '想象拓展', content: '绘画“落花图”，描述自己想象中的春日早晨，培养想象力与表达能力。' },
            { title: '朗读背诵', content: '配乐朗读，尝试当堂背诵，鼓励个性化语调处理。' },
            { title: '作业布置', content: '基础：背诵 + 默写；拓展：续写“春晓之后”的小故事。' },
        ],
        applicableKeywords: ['春天', '孟浩然', '惜春', '唐诗', '低年级'],
        createdAt: BASE_TIME - DAY,
        updatedAt: BASE_TIME - DAY,
    },
    {
        id: 'tpl-middle-new-basic-denguanguilou',
        title: '中年级·登鹳雀楼·新授课（基础）',
        grade: 'middle',
        type: 'new',
        difficulty: 'basic',
        duration: 40,
        description: '面向 3-4 年级学生，理解“白日依山尽，黄河入海流”的壮阔意境，培养登高望远的胸怀。',
        thumbnail: '/images/generated/starmap/tongbian-005.webp',
        sections: [
            { title: '解题导入', content: '介绍鹳雀楼地理位置与历史背景，提问“为什么古人喜欢登楼写诗”。' },
            { title: '初读感知', content: '自由朗读，认读生字“鹳、雀、依、尽、欲、穷、目”，整体把握诗意。' },
            { title: '逐句品析', content: '前两句写景（白日/黄河），后两句抒情（更上一层楼），体会景情交融的手法。' },
            { title: '哲理感悟', content: '讨论“欲穷千里目，更上一层楼”的哲理内涵，联系生活实际谈体会。' },
            { title: '拓展延伸', content: '比较阅读王之涣《凉州词》，感受边塞诗的不同风格。' },
            { title: '作业布置', content: '基础：背诵默写；拓展：写一段“登高望远”的感悟。' },
        ],
        applicableKeywords: ['登高', '哲理', '王之涣', '盛唐', '中年级'],
        createdAt: BASE_TIME - 2 * DAY,
        updatedAt: BASE_TIME - 2 * DAY,
    },
    {
        id: 'tpl-middle-review-advanced-wanglushan',
        title: '中年级·望庐山瀑布·复习课（进阶）',
        grade: 'middle',
        type: 'review',
        difficulty: 'advanced',
        duration: 35,
        description: '面向 3-4 年级学生，复习李白《望庐山瀑布》，深化夸张与比喻修辞手法的理解。',
        thumbnail: '/images/generated/starmap/tongbian-006.webp',
        sections: [
            { title: '温故知新', content: '回顾李白生平与已学诗篇，引出《望庐山瀑布》，建立知识网络。' },
            { title: '修辞品析', content: '重点品析“飞流直下三千尺，疑是银河落九天”中的夸张与比喻，体会李白豪放风格。' },
            { title: '比较阅读', content: '比较《静夜思》与《望庐山瀑布》中“疑”字的不同用法与意境。' },
            { title: '归纳总结', content: '总结李白诗歌的浪漫主义特征：想象奇崛、夸张大胆、感情奔放。' },
            { title: '应用迁移', content: '仿写一句含有夸张修辞的诗句，描述自然景观。' },
            { title: '作业布置', content: '基础：默写全诗；拓展：搜集 2 首李白其他诗作并分析修辞。' },
        ],
        applicableKeywords: ['李白', '瀑布', '夸张', '比喻', '中年级'],
        createdAt: BASE_TIME - 3 * DAY,
        updatedAt: BASE_TIME - 3 * DAY,
    },
    {
        id: 'tpl-high-extension-challenge-shanshui',
        title: '高年级·山水诗·拓展课（挑战）',
        grade: 'high',
        type: 'extension',
        difficulty: 'challenge',
        duration: 45,
        description: '面向 5-6 年级学生，专题拓展山水田园诗，比较王维、孟浩然诗歌意境，培养文学鉴赏力。',
        thumbnail: '/images/generated/starmap/tongbian-s33.webp',
        sections: [
            { title: '专题导入', content: '出示王维《山居秋暝》与孟浩然《过故人庄》，引出“山水田园诗派”概念。' },
            { title: '群文阅读', content: '选读 4 首山水田园诗代表作，从意象、语言、情感三个维度进行比较分析。' },
            { title: '意境鉴赏', content: '深度品析“明月松间照，清泉石上流”的诗画一体境界，体会“诗中有画”的艺术。' },
            { title: '流派特征', content: '归纳山水田园诗的共同特征：寄情山水、淡泊名利、语言清新、意境悠远。' },
            { title: '创作实践', content: '模仿山水田园诗风格，写一首描写家乡自然风光的小诗。' },
            { title: '作业布置', content: '基础：背诵《山居秋暝》；挑战：写一篇 300 字的山水诗鉴赏短文。' },
        ],
        applicableKeywords: ['山水', '田园', '王维', '孟浩然', '高年级', '群文阅读'],
        createdAt: BASE_TIME - 4 * DAY,
        updatedAt: BASE_TIME - 4 * DAY,
    },
    {
        id: 'tpl-high-new-basic-wangwei',
        title: '高年级·山居秋暝·新授课（基础）',
        grade: 'high',
        type: 'new',
        difficulty: 'basic',
        duration: 40,
        description: '面向 5-6 年级学生，理解王维《山居秋暝》“诗中有画”的艺术特色，体会归隐情怀。',
        thumbnail: '/images/generated/starmap/tongbian-s33.webp',
        sections: [
            { title: '知人论世', content: '介绍王维生平与“诗佛”称号，理解其“晚年惟好静，万事不关心”的心境。' },
            { title: '初读感知', content: '朗读全诗，把握“首联-颔联-颈联-尾联”的律诗结构。' },
            { title: '诗画品析', content: '重点品析“明月松间照，清泉石上流”的动静结合与色彩对比。' },
            { title: '情感体悟', content: '理解尾联“随意春芳歇，王孙自可留”的归隐情怀与反用《楚辞》典故。' },
            { title: '背诵积累', content: '当堂背诵，鼓励个性化朗读节奏处理。' },
            { title: '作业布置', content: '基础：默写全诗；拓展：搜集王维其他山水诗一首。' },
        ],
        applicableKeywords: ['王维', '山水', '律诗', '隐逸', '高年级'],
        createdAt: BASE_TIME - 5 * DAY,
        updatedAt: BASE_TIME - 5 * DAY,
    },
    {
        id: 'tpl-low-review-basic-jingyesi',
        title: '低年级·静夜思·复习课（基础）',
        grade: 'low',
        type: 'review',
        difficulty: 'basic',
        duration: 30,
        description: '面向 1-2 年级学生，复习《静夜思》生字与朗读，通过游戏化检测学习效果。',
        thumbnail: '/images/generated/starmap/tongbian-003.webp',
        sections: [
            { title: '生字复习', content: '通过“摘月亮”游戏复习 8 个生字，重点关注易错字“疑”和“低”。' },
            { title: '朗读巩固', content: '配乐朗读，分组比赛，评选“最佳朗读者”。' },
            { title: '诗意回顾', content: '看图说诗意，巩固对“疑/举/低”等关键词的理解。' },
            { title: '检测反馈', content: '随堂小测：默写生字 + 选择题检测诗意理解，即时反馈。' },
            { title: '查漏补缺', content: '针对错误较多的字词进行针对性强化训练。' },
            { title: '作业布置', content: '基础：改正错字 3 遍；拓展：与家人分享这首诗。' },
        ],
        applicableKeywords: ['静夜思', '复习', '游戏化', '低年级'],
        createdAt: BASE_TIME - 6 * DAY,
        updatedAt: BASE_TIME - 6 * DAY,
    },
    {
        id: 'tpl-middle-extension-advance-song',
        title: '中年级·宋词启蒙·拓展课（进阶）',
        grade: 'middle',
        type: 'extension',
        difficulty: 'advanced',
        duration: 45,
        description: '面向 3-4 年级学生，拓展接触宋词，比较唐诗与宋词的形式差异，启蒙词学兴趣。',
        thumbnail: '/images/generated/starmap/tongbian-002.webp',
        sections: [
            { title: '形式比较', content: '比较《静夜思》（五言绝句）与《水调歌头》（词）的形式差异，引出“词”的概念。' },
            { title: '名篇欣赏', content: '欣赏苏轼《水调歌头·明月几时有》片段，感受词的婉转节奏。' },
            { title: '词牌认知', content: '认识常见词牌（水调歌头/如梦令/渔歌子），了解词牌与内容的关系。' },
            { title: '意境感悟', content: '通过吟唱方式体验词的韵律美，比较“诗吟”与“词唱”的不同。' },
            { title: '创意表达', content: '尝试用自己喜欢的曲调吟唱一首学过的古诗。' },
            { title: '作业布置', content: '基础：背诵《渔歌子》；拓展：搜集一首喜欢的宋词。' },
        ],
        applicableKeywords: ['宋词', '苏轼', '词牌', '中年级', '拓展'],
        createdAt: BASE_TIME - 7 * DAY,
        updatedAt: BASE_TIME - 7 * DAY,
    },
    {
        id: 'tpl-high-new-challenge-libai',
        title: '高年级·将进酒·新授课（挑战）',
        grade: 'high',
        type: 'new',
        difficulty: 'challenge',
        duration: 50,
        description: '面向 5-6 年级学有余力学生，挑战李白《将进酒》节选，深度理解浪漫主义诗歌巅峰之作。',
        thumbnail: '/images/generated/starmap/tongbian-s09.webp',
        sections: [
            { title: '背景导入', content: '介绍李白创作《将进酒》的历史背景与人生境遇，理解“天生我材必有用”的豪情。' },
            { title: '古体诗认知', content: '认知古体诗（乐府诗）与近体诗的差异，把握《将进酒》的句式自由特点。' },
            { title: '情感脉络', content: '梳理“悲-欢-愤-狂”的情感变化脉络，体会李白复杂的内心世界。' },
            { title: '名句品析', content: '深度品析“天生我材必有用，千金散尽还复来”的自信与“钟鼓馔玉不足贵”的愤激。' },
            { title: '比较阅读', content: '比较《将进酒》与《静夜思》中李白的两种截然不同的情感表达。' },
            { title: '作业布置', content: '基础：背诵节选；挑战：写一段 200 字的“我眼中的李白”。' },
        ],
        applicableKeywords: ['李白', '将进酒', '浪漫主义', '高年级', '挑战'],
        createdAt: BASE_TIME - 8 * DAY,
        updatedAt: BASE_TIME - 8 * DAY,
    },
    {
        id: 'tpl-low-extension-basic-minyue',
        title: '低年级·民谣童谣·拓展课（基础）',
        grade: 'low',
        type: 'extension',
        difficulty: 'basic',
        duration: 35,
        description: '面向 1-2 年级学生，拓展接触民谣童谣，培养语感与节奏感，激发诗歌学习兴趣。',
        thumbnail: '/images/generated/starmap/tongbian-035.webp',
        sections: [
            { title: '童谣导入', content: '朗诵《摇啊摇，摇到外婆桥》等熟悉童谣，激发兴趣。' },
            { title: '形式认知', content: '比较童谣与古诗的不同（口语化/节奏感/押韵方式）。' },
            { title: '节奏体验', content: '通过拍手、踏脚等方式体验童谣的节奏感。' },
            { title: '创作尝试', content: '模仿童谣形式，创作一首关于“上学”的小童谣。' },
            { title: '分享展示', content: '小组展示创作成果，互相点评鼓励。' },
            { title: '作业布置', content: '基础：把创作的童谣读给家人听；拓展：搜集家乡方言童谣。' },
        ],
        applicableKeywords: ['童谣', '民谣', '节奏', '低年级', '创作'],
        createdAt: BASE_TIME - 9 * DAY,
        updatedAt: BASE_TIME - 9 * DAY,
    },
    {
        id: 'tpl-middle-new-challenge-dufu',
        title: '中年级·春望·新授课（挑战）',
        grade: 'middle',
        type: 'new',
        difficulty: 'challenge',
        duration: 45,
        description: '面向 3-4 年级学有余力学生，挑战杜甫《春望》，初步接触现实主义诗歌与家国情怀。',
        thumbnail: '/images/generated/starmap/tongbian-078-v2.webp',
        sections: [
            { title: '知人论世', content: '介绍杜甫“诗圣”称号与安史之乱背景，理解“国破山河在”的时代悲哀。' },
            { title: '初读感知', content: '朗读全诗，把握五言律诗的节奏与对仗。' },
            { title: '炼字品析', content: '重点品析“破/深/感/恨”等字的炼字之妙，体会杜甫沉郁顿挫的风格。' },
            { title: '情感体悟', content: '理解“烽火连三月，家书抵万金”中思家忧国的复杂情感。' },
            { title: '比较阅读', content: '比较杜甫《春望》与李白《静夜思》中“思”的不同内涵。' },
            { title: '作业布置', content: '基础：背诵全诗；挑战：用 200 字描述“国破山河在”的画面。' },
        ],
        applicableKeywords: ['杜甫', '春望', '现实主义', '家国', '中年级'],
        createdAt: BASE_TIME - 10 * DAY,
        updatedAt: BASE_TIME - 10 * DAY,
    },
    {
        id: 'tpl-high-review-challenge-qinghuai',
        title: '高年级·怀古咏史诗·复习课（挑战）',
        grade: 'high',
        type: 'review',
        difficulty: 'challenge',
        duration: 50,
        description: '面向 5-6 年级学生，专题复习怀古咏史诗，比较唐宋怀古诗的不同风格，深化文学史认知。',
        thumbnail: '/images/generated/starmap/tongbian-005.webp',
        sections: [
            { title: '专题回顾', content: '回顾已学怀古诗：《登鹳雀楼》《乌衣巷》《赤壁》等，建立怀古诗知识图谱。' },
            { title: '特征归纳', content: '归纳怀古诗的四大特征：借古讽今/借古喻今/感慨兴衰/怀古伤己。' },
            { title: '群文比较', content: '比较刘禹锡《乌衣巷》与杜牧《赤壁》的怀古角度与表达技巧。' },
            { title: '艺术手法', content: '重点复习“用典/对比/借景抒情”三种怀古诗常用手法。' },
            { title: '综合应用', content: '完成怀古诗鉴赏题（诗歌 + 选择题 + 简答题），检测学习成果。' },
            { title: '作业布置', content: '基础：默写 3 首怀古诗；挑战：写一篇 400 字怀古诗鉴赏短文。' },
        ],
        applicableKeywords: ['怀古', '咏史', '刘禹锡', '杜牧', '高年级', '群文阅读'],
        createdAt: BASE_TIME - 11 * DAY,
        updatedAt: BASE_TIME - 11 * DAY,
    },
]

// ─────────────────────────────────────────────────────────────
// Zod schemas
// ─────────────────────────────────────────────────────────────

const templateQuerySchema = z.object({
    keyword: z.string().trim().max(64).optional(),
    grade: z.enum(['low', 'middle', 'high']).optional(),
    type: z.enum(['new', 'review', 'extension']).optional(),
    difficulty: z.enum(['basic', 'advanced', 'challenge']).optional(),
    sort: z.enum(['newest', 'popular', 'duration-asc', 'duration-desc']).default('newest'),
})

const templateIdParamsSchema = z.object({
    id: z.string().trim().min(1).max(80),
})

/**
 * “热度”排序权重
 *
 * 模板目录是静态资源，没有真实浏览量埋点。此处不伪造随机热度，
 * 而是按「基础难度 + 新授课 + 低学段」这一真实使用频次规律给出确定性权重，
 * 并在响应中不暴露该分值，仅用于排序，避免向教师传递虚假的统计数字。
 */
function popularityWeight(t: LessonPlanTemplate): number {
    const difficultyWeight = { basic: 3, advanced: 2, challenge: 1 }[t.difficulty]
    const typeWeight = { new: 3, review: 2, extension: 1 }[t.type]
    const gradeWeight = { low: 3, middle: 2, high: 1 }[t.grade]
    return difficultyWeight * 100 + typeWeight * 10 + gradeWeight
}

// ─────────────────────────────────────────────────────────────
// 路由
// ─────────────────────────────────────────────────────────────

export const lessonPlanTemplateRoutes: FastifyPluginAsync = async (app) => {
    /**
     * GET /templates —— 教案模板列表
     *
     * Query: keyword / grade / type / difficulty / sort
     * 返回 `{ status, templates, total }`（前端 unwrap 后取 templates + total）
     */
    app.get('/templates', async (req: FastifyRequest, reply) => {
        const query = validateQuery(templateQuerySchema, req, reply)
        if (!query) return

        try {
            let list = [...LESSON_PLAN_TEMPLATE_CATALOG]

            if (query.keyword) {
                const q = query.keyword.toLowerCase()
                list = list.filter(
                    (t) =>
                        t.title.toLowerCase().includes(q) ||
                        t.description.toLowerCase().includes(q) ||
                        (t.applicableKeywords ?? []).some((k) => k.toLowerCase().includes(q)),
                )
            }
            if (query.grade) list = list.filter((t) => t.grade === query.grade)
            if (query.type) list = list.filter((t) => t.type === query.type)
            if (query.difficulty) list = list.filter((t) => t.difficulty === query.difficulty)

            switch (query.sort) {
                case 'newest':
                    list.sort((a, b) => b.createdAt - a.createdAt)
                    break
                case 'popular':
                    list.sort((a, b) => popularityWeight(b) - popularityWeight(a))
                    break
                case 'duration-asc':
                    list.sort((a, b) => a.duration - b.duration)
                    break
                case 'duration-desc':
                    list.sort((a, b) => b.duration - a.duration)
                    break
            }

            return reply.send({ status: 'ok', templates: list, total: list.length })
        } catch (err) {
            handleRouteError(err, req, reply, '教案模板加载失败')
            return
        }
    })

    /**
     * GET /templates/:id —— 单个教案模板详情
     */
    app.get('/templates/:id', async (req: FastifyRequest, reply) => {
        const params = validateParams(templateIdParamsSchema, req, reply)
        if (!params) return

        const tpl = LESSON_PLAN_TEMPLATE_CATALOG.find((t) => t.id === params.id)
        if (!tpl) {
            return reply.code(404).send({
                status: 'error',
                error: 'NOT_FOUND',
                message: '教案模板不存在',
            })
        }
        return reply.send({ status: 'ok', ...tpl })
    })
}

export default lessonPlanTemplateRoutes
