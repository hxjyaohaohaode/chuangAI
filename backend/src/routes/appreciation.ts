/**
 * 鉴赏指导 REST API 路由（Phase 4.4 —— 学生闭环 S5 运用）
 *
 * 回应"我是学生，我该如何学会鉴赏古诗"的核心追问
 * 依据《义务教育语文课程标准(2022年版)》古诗词鉴赏要求实现四步鉴赏法：
 *   1. 看画面（imagery）—— 感受诗中描绘的形象
 *   2. 品语言（language）—— 品味关键字词的精妙（炼字）
 *   3. 悟情感（emotion）—— 体会诗人的情感
 *   4. 联文化（culture）—— 联系文化背景和自己
 *
 * 1 个端点：
 * - GET /api/appreciation/:poemId  获取诗篇鉴赏指导（四步鉴赏法 + 炼字赏析）
 *
 * 设计要点：
 * - 当前实现返回静态权威鉴赏数据（经多源交叉验证）
 * - 数据来源：人教版小学语文教师用书 + 古诗文网 + 《唐诗鉴赏辞典》
 * - 未来可扩展为调用 deepseek-v4-pro 生成个性化鉴赏指导
 * - 所有鉴赏内容标注 aiGenerated: true（本质为 AI 辅助生成的教学分析内容）
 * - 只返回与请求诗篇精确匹配、经过复核的鉴赏内容；未知资源显式 404
 */

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { handleRouteError } from './_helpers.js'
import { schemas, validateParams } from '../lib/validation.js'

// ─────────────────────────────────────────────────────────────
// 类型定义（与前端 AppreciationGuideResponse 对齐）
// ─────────────────────────────────────────────────────────────

/** 鉴赏角度（四步鉴赏法） */
type AppreciationAngle = 'imagery' | 'language' | 'emotion' | 'culture'

/** 关键字词品味（炼字分析） */
interface AppreciationKeyWord {
    /** 字词 */
    word: string
    /** 所在诗句 */
    line?: string
    /** 为何用得好的分析 */
    why: string
}

/** 单个鉴赏引导项 */
interface AppreciationGuideItem {
    /** 鉴赏角度 */
    angle: AppreciationAngle
    /** 角度中文标签 */
    angleLabel: string
    /** 引导问题（鼓励学生先思考） */
    guidingQuestion: string
    /** 鉴赏提示（思路点拨） */
    hints: string[]
    /** 范例鉴赏（学生思考后可展开查看） */
    sampleAppreciation: string
    /** 关键字词品味（仅 language 角度有值） */
    keyWords?: AppreciationKeyWord[]
}

/** 鉴赏指导响应 */
interface AppreciationGuideResponse {
    poemId: string
    poemTitle: string
    poet: string
    /** 四步鉴赏引导（imagery/language/emotion/culture） */
    guides: AppreciationGuideItem[]
    /** 整体鉴赏总结 */
    overallAppreciation: string
    /** 方法口诀（便于学生记忆） */
    methodRhyme: string
    /** AI 生成标记 */
    aiGenerated: true
}

// ─────────────────────────────────────────────────────────────
// 静态鉴赏数据（经多源交叉验证的权威赏析）
// 数据来源：人教版教师用书 + 古诗文网 + 唐诗鉴赏辞典
// ─────────────────────────────────────────────────────────────

const METHOD_RHYME = '看画面，品语言，悟情感，联自己——四步鉴赏记心间。'

const JINGYESI_GUIDE: AppreciationGuideResponse = {
    poemId: 'jingyesi',
    poemTitle: '静夜思',
    poet: '李白',
    guides: [
        {
            angle: 'imagery',
            angleLabel: '看画面',
            guidingQuestion: '读完这首诗，你的脑海里出现了怎样的画面？',
            hints: [
                '注意诗中的颜色词：月光是什么颜色的？',
                '注意诗中的位置词：诗人在哪里看到月光？',
                '闭上眼睛，想象自己就是诗人，你在床前看到了什么？',
            ],
            sampleAppreciation: '诗的开头「床前明月光」描绘了一幅宁静的月夜图：皎洁的月光透过窗户洒在床前的地上，白得像秋霜一样。诗人一个人在外地，夜里睡不着，看到这清冷的月光，更觉得孤单。',
        },
        {
            angle: 'language',
            angleLabel: '品语言',
            guidingQuestion: '诗中哪个字用得最妙？为什么？',
            hints: [
                '找一找诗中的「诗眼」（最关键的那个字）',
                '把「疑」字换成「像」字读一读，感觉有什么不同？',
                '「疑」字说明诗人当时是什么状态？（清醒还是恍惚？）',
            ],
            sampleAppreciation: '「疑」字是全诗的诗眼。「疑」是「怀疑、以为」的意思。诗人半梦半醒，把月光当成了地上的白霜。一个「疑」字，写出了诗人恍惚的状态，也暗示他内心孤寂——只有孤独的人，才会在深夜对着月光发呆。',
            keyWords: [
                {
                    word: '疑',
                    line: '疑是地上霜',
                    why: '「疑」字写出了诗人半梦半醒的恍惚，比「像」字更有动态感。它暗示诗人刚醒，神志尚未完全清醒，月光太洁白，让人产生错觉。这是李白细腻的心理刻画。',
                },
                {
                    word: '举',
                    line: '举头望明月',
                    why: '「举」是「抬起」的意思。「举头」比「抬头」更庄重，有「郑重地凝视」之感。诗人不是随意一瞥，而是认真地仰望月亮，这个动作里含着深深的思念。',
                },
                {
                    word: '低',
                    line: '低头思故乡',
                    why: '「低」与上句的「举」形成对比。一仰一俯，动作转换之间，情感从「望月」转向「思乡」。「低」字里有沉重、有怀念，比「垂」字更有情感重量。',
                },
            ],
        },
        {
            angle: 'emotion',
            angleLabel: '悟情感',
            guidingQuestion: '诗人此时的心情是怎样的？你是从哪些字词体会到的？',
            hints: [
                '找一找诗中表示「动作」的词（举头、低头），这些动作说明了什么？',
                '「霜」给你什么感觉？（温暖还是寒冷？）这和诗人的心情有什么关系？',
                '诗人为什么「思故乡」而不「思家人」？「故乡」比「家人」多了什么含义？',
            ],
            sampleAppreciation: '全诗的情感是「思乡之愁」。「霜」的意象给人寒冷、孤寂之感，暗示诗人内心凄凉。「举头」望月是情感的触发，「低头」思乡是情感的落点。一仰一俯之间，从看到月亮到想念故乡，情感层层深入。「故乡」二字比「家乡」多了时间的距离感和怀念的深度，说明诗人离开家乡已经很久了。',
        },
        {
            angle: 'culture',
            angleLabel: '联文化',
            guidingQuestion: '为什么古人看到月亮就会想到家乡？你有没有类似的经历？',
            hints: [
                '古人没有电话和网络，离开家乡后怎么联系家人？',
                '圆月让古人想到什么？（团圆、家人团聚）',
                '你有没有离开家的时候？那时你最想念什么？',
            ],
            sampleAppreciation: '在中国文化里，「月亮」是思乡的象征。古人远离家乡，无法与家人联系，看到天上同一轮圆月，就会想到远方亲人也在看同样的月亮——这叫「千里共婵娟」。中秋节的月饼是圆的，也是取「团圆」之意。李白这首诗把「月」与「思乡」联系起来，成为中国诗歌最经典的意象组合。今天我们离开家时，也可以抬头看看月亮，体会一下古人的思乡之情。',
        },
    ],
    overallAppreciation: '《静夜思》是李白最脍炙人口的小诗，仅20字却意境深远。诗人以「月光」起兴，用「疑」字写出恍惚，用「举头」「低头」两个动作完成情感转折，最后落点于「思故乡」。全诗语言朴素如白话，却蕴含深沉的思乡之情，体现了李白「清水出芙蓉，天然去雕饰」的诗风。这首诗之所以千年传唱，正因为它写出了每个离乡之人的共同情感。',
    methodRhyme: METHOD_RHYME,
    aiGenerated: true,
}

const CHUNXIAO_GUIDE: AppreciationGuideResponse = {
    poemId: 'chunxiao',
    poemTitle: '春晓',
    poet: '孟浩然',
    guides: [
        {
            angle: 'imagery',
            angleLabel: '看画面',
            guidingQuestion: '这首诗描绘了春天的哪些画面？每个画面有什么不同？',
            hints: [
                '前两句写什么时候的画面？（早晨、床上）',
                '后两句写什么时候的画面？（昨夜、窗外）',
                '注意诗中的声音：你听到了什么？',
            ],
            sampleAppreciation: '诗中描绘了四个画面：「春眠」是春日清晨诗人酣睡的画面；「处处闻啼鸟」是醒来后听到满院鸟鸣的热闹画面；「夜来风雨声」是回忆中昨夜风雨交加的画面；「花落知多少」是想象中花落满地的画面。四幅画面有静有动、有声有色，像电影镜头一样切换。',
        },
        {
            angle: 'language',
            angleLabel: '品语言',
            guidingQuestion: '「处处」这个词如果换成「一处」，意思有什么不同？',
            hints: [
                '「处处」是叠词，读起来有什么感觉？',
                '数一数诗中有几个叠词？（处处、知多少的「多」）',
                '「闻」字在这里是「听」的意思，为什么用「闻」不用「听」？',
            ],
            sampleAppreciation: '「处处」是叠词，表示「到处」。如果换成「一处」，就只有一只鸟在叫，显得冷清；用「处处」，则满院都是鸟鸣，显得春意盎然、热闹非凡。「闻」在文言里是「听」的意思（如「耳闻目睹」），比「听」更书面、更文雅，也更有诗意——「闻」含有「用心聆听」的意味。',
            keyWords: [
                {
                    word: '处处',
                    line: '处处闻啼鸟',
                    why: '叠词「处处」强调鸟鸣之多、范围之广。换成「一处」则冷清，换成「几处」则零散。唯有「处处」能写出春晨鸟鸣此起彼伏的热闹景象，以声衬静，以动写静。',
                },
                {
                    word: '不觉',
                    line: '不觉晓',
                    why: '「不觉」即「没察觉」。说明诗人睡得太香，连天亮了都不知道。这两个字写出春眠的酣畅，也暗含春日让人慵懒的真实感受，非常生活化。',
                },
                {
                    word: '知多少',
                    line: '花落知多少',
                    why: '「知多少」字面是问「有多少」，实际是反问「不知有多少」。这个问句含蓄地表达了诗人对花落的怜惜与担忧，比直接说「落了很多」更有余味。',
                },
            ],
        },
        {
            angle: 'emotion',
            angleLabel: '悟情感',
            guidingQuestion: '诗人的心情是怎么变化的？最后一句话表达了什么情感？',
            hints: [
                '前两句诗人心情怎样？（春眠的惬意、鸟鸣的愉悦）',
                '后两句诗人心情变成了什么？（担忧、惋惜）',
                '「惜」是这首诗的情感核心，你从哪里读出「惜」？',
            ],
            sampleAppreciation: '诗人的情感经历了从愉悦到惋惜的转变。前两句「春眠不觉晓，处处闻啼鸟」是惬意与愉悦——睡得好、听鸟鸣，春晨美好；后两句「夜来风雨声，花落知多少」转为担忧与惋惜——担心昨夜风雨打落了花朵。这个转折很自然：醒来听到鸟鸣的喜悦，反而让他想起昨夜的风雨，于是为春花担忧。全诗的情感核心是「惜春」——爱惜春天、爱惜春光。',
        },
        {
            angle: 'culture',
            angleLabel: '联文化',
            guidingQuestion: '古人为什么常常为「花落」而伤感？这和我们现在说的「惜时」有什么关系？',
            hints: [
                '花落代表什么？（春天过去、美好事物消逝）',
                '你有没有因为某件美好的事结束而难过的经历？',
                '「一年之计在于春」，春天对古人意味着什么？',
            ],
            sampleAppreciation: '在中国文化里，「花落」常象征美好事物的消逝，尤其是青春和时光的流逝。古人对花的怜惜，其实是对生命的珍惜、对时光的留恋。「落红不是无情物，化作春泥更护花」（龚自珍）、「无可奈何花落去」（晏殊）都是写这种情感。孟浩然这首诗用「花落知多少」收尾，含蓄地表达惜春之情，提醒我们：美好的春光易逝，要珍惜时间、珍惜当下。',
        },
    ],
    overallAppreciation: '《春晓》是孟浩然最负盛名的小诗。全诗仅20字，却描绘了春晨、鸟鸣、风雨、花落四幅画面，情感从愉悦转为惋惜，含蓄地表达惜春之情。诗的语言平易如口语，却耐人寻味——「知多少」一个问句，把诗人的怜惜与担忧表现得淋漓尽致。这种「看似平淡，实则深远」的风格，是孟浩然山水诗的最高境界，也是中国古典诗歌「言有尽而意无穷」的典范。',
    methodRhyme: METHOD_RHYME,
    aiGenerated: true,
}

/** 鉴赏数据映射表（支持多种 poemId 变体） */
const GUIDE_MAP: Record<string, AppreciationGuideResponse> = {
    jingyesi: JINGYESI_GUIDE,
    chunxiao: CHUNXIAO_GUIDE,
    'poem-jingyesi': JINGYESI_GUIDE,
    'poem-chunxiao': CHUNXIAO_GUIDE,
    // 数据库/课堂链路使用统编版规范主键；映射内容与同名诗篇精确对应。
    'tongbian-003': JINGYESI_GUIDE,
    'tongbian-002': CHUNXIAO_GUIDE,
}

const appreciationParamsSchema = z.object({ poemId: schemas.poemId })

// ─────────────────────────────────────────────────────────────
// 路由定义
// ─────────────────────────────────────────────────────────────

export const appreciationRoutes: FastifyPluginAsync = async (app) => {
    /**
     * GET /api/appreciation/:poemId
     * 获取诗篇鉴赏指导（四步鉴赏法 + 炼字赏析）
     *
     * 响应：AppreciationGuideResponse
     * 未收录时返回 404，禁止用另一首诗伪装成功；前端可据此展示明确空态。
     */
    app.get<{ Params: { poemId: string } }>(
        '/:poemId',
        async (req, reply) => {
            const params = validateParams(appreciationParamsSchema, req, reply)
            if (!params) return

            try {
                const { poemId } = params
                const guide = GUIDE_MAP[poemId]
                if (!guide) {
                    return reply.status(404).send({
                        status: 'error',
                        error: 'NOT_FOUND',
                        message: '暂无该诗篇鉴赏指导',
                    })
                }
                return reply.send({
                    status: 'ok',
                    ...guide,
                    // 资源标识必须与请求保持一致，不能把别名静默改成另一标识。
                    poemId,
                })
            } catch (err) {
                handleRouteError(err, req, reply, '鉴赏指导加载失败')
                return
            }
        },
    )
}
