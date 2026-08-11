/**
 * 教学场景插画路由 —— GET /api/illustration/scene/:sceneId
 *
 * 服务对象：驾驶舱「教学闭环六大环节」卡片、思考宫殿演示配图等
 * 需要一张「与该场景语义相符的美观配图」的位置。
 *
 * 设计要点：
 * 1. **场景是受控枚举，不接受任意 prompt**。开放 prompt 会让前端变成
 *    一个可被滥用的生图代理（任何人都能拿服务端的密钥生成任意图片）。
 * 2. prompt 在服务端按场景固定编写，风格统一（暖调、工笔与水墨结合、
 *    无文字水印），保证六张卡片放在一起是一套而不是六个风格。
 * 3. 生成结果经 image-cache 落盘，返回本地地址；失败返回 null 让前端
 *    退回既有的 SVG 插画，绝不阻塞页面。
 */

import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { validateParams } from '../lib/validation.js'
import { handleRouteError } from './_helpers.js'
import { getOrCreateImage } from '../services/culture/image-cache.js'

/**
 * 受控场景表
 *
 * 每条 prompt 都刻意收敛到「暖调、浅色、留白充足」的同一视觉语言，
 * 与界面的米白基底和琥珀铜强调色相协调——生成图的色彩若与界面冲突，
 * 再精美也会让整版失衡（规范 2.5 / 5.1）。
 */
/**
 * 共用风格与构图后缀
 *
 * ── 为什么要有「禁字」这一段 ──
 * 首轮实测（wan2.7-image）发现：只要画面里出现**可书写的面**——摊开的册页、
 * 纸条、竹简——模型就会自动"写"上汉字，而写出来的是**伪汉字**：
 * 「杠晓·孟浩然」「莱枕高子不传来之伴」这类字形正确但组合错误的字。
 * 这在给小学生看的古诗产品里是硬伤：孩子会把错字当范字。
 * 因此策略是**双保险**——正面选题避开书写面，同时负面提示显式禁字。
 *
 * ── 为什么要规定构图 ──
 * 这些图要作为卡片的通栏底图，文案压在上半部。所以必须要求
 * 「上半部留白、主体居中偏下」，否则文字会压在主体上导致对比度不足。
 *
 * 注：DashScope 会在成图右下角强制加「AI 生成」标识（生成式 AI 服务
 * 管理办法要求的显式标识），这是**不可通过 prompt 去除**的，也不应去除。
 * 卡片底图会把该角落压在低透明度区域，不影响可读性。
 */
const STYLE_SUFFIX =
    '；暖米白背景，浅赭石与淡墨的柔和配色，工笔线条与水墨晕染结合，大量留白，构图安静克制；' +
    '画面上半部大面积留白，主体位于下半部居中；' +
    '画面中不得出现任何文字、汉字、书法、题款或标签'

const SCENES: Record<string, { prompt: string; alt: string }> = {
    diagnose: {
        prompt:
            '中国风教学场景插画：原木书案上，一枚铜柄放大镜斜倚在一卷扎紧未展开的空白卷轴旁，' +
            '案角置一方小砚台' + STYLE_SUFFIX,
        alt: '学情诊断场景：书案上的卷轴与放大镜',
    },
    classroom: {
        prompt:
            '中国风教学场景插画：小学教室的木质讲台与几排空课桌，讲台正面为素净木板、' +
            '不带黑板也不带任何板书，窗外有一株探入的春枝，晨光斜照' + STYLE_SUFFIX,
        alt: '课堂导播场景：晨光中的教室讲台',
    },
    grading: {
        prompt:
            '中国风教学场景插画：青瓷笔架上横搁一支毛笔，笔尖下方是一方打开的朱砂印泥盒，' +
            '旁边一摞纸只以侧面示人、只看得见层层纸边（看不到任何纸面）' + STYLE_SUFFIX,
        alt: '智能批改场景：笔架毛笔与朱砂印泥',
    },
    selfstudy: {
        prompt:
            '中国风教学场景插画：窗边小书桌，桌上一摞合着的线装书（不得翻开、不得露出书页）、' +
            '一盏温暖台灯与一杯清茶' + STYLE_SUFFIX,
        alt: '自学舱场景：窗边书桌与合起的书',
    },
    recitation: {
        prompt:
            '中国风教学场景插画：一张古琴的四分之三侧视特写，琴身周围荡开数圈淡青与浅赭的' +
            '同心声波涟漪，如水面波纹般向外扩散' + STYLE_SUFFIX,
        alt: '诗音阁场景：古琴与扩散的声韵涟漪',
    },
    culture: {
        prompt:
            '中国风教学场景插画：远山与孤舟的写意山水，近景横斜一枝梅' + STYLE_SUFFIX,
        alt: '文化语境场景：远山孤舟的写意山水',
    },
    workbench: {
        prompt:
            '中国风教学场景插画：一只竹制签筒斜倚在原木案面上，数支未刻字的空白竹签' +
            '自筒口散落成扇形' + STYLE_SUFFIX,
        alt: '智能命题场景：竹签筒与散落的空白竹签',
    },
    lessonplan: {
        prompt:
            '中国风教学场景插画：夜色书案上一盏温暖的油灯亮着，灯下并置一方青玉镇纸' +
            '与一支搁在笔山上的毛笔' + STYLE_SUFFIX,
        alt: '教案工坊场景：灯下的镇纸与毛笔',
    },
    report: {
        prompt:
            '中国风教学场景插画：案面上五卷扎好的空白卷轴横向并排平放，卷轴一律水平横卧、' +
            '不得竖立，旁边横放一枝干莲蓬' + STYLE_SUFFIX,
        alt: '教研报告场景：并排横卧的卷轴',
    },
}

const sceneParamsSchema = z.object({
    sceneId: z.enum([
        'diagnose', 'classroom', 'grading', 'selfstudy', 'recitation', 'culture',
        'workbench', 'lessonplan', 'report',
    ]),
})

export const illustrationRoutes: FastifyPluginAsync = async (app) => {
    /**
     * GET /scene/:sceneId
     *
     * 返回 `{ url, cached, alt }`；生成不可用时返回 `{ url: null }`，
     * 前端据此退回本地 SVG 插画。**不返回 5xx**——一张配图取不到
     * 不应该让整个驾驶舱区块进错误态。
     */
    app.get('/scene/:sceneId', async (req: FastifyRequest, reply) => {
        const params = validateParams(sceneParamsSchema, req, reply)
        if (!params) return

        const scene = SCENES[params.sceneId]
        if (!scene) {
            return reply.code(404).send({ status: 'error', message: '未知场景' })
        }

        try {
            const img = await getOrCreateImage(scene.prompt, 'landscape')
            return reply.send({
                status: 'ok',
                sceneId: params.sceneId,
                url: img?.url ?? null,
                cached: img?.cached ?? false,
                alt: scene.alt,
                aiGenerated: img !== null,
            })
        } catch (err) {
            handleRouteError(err, req, reply, '插画获取失败')
            return
        }
    })

    /** GET /scenes —— 列出全部受控场景（前端可一次性预取） */
    app.get('/scenes', async (_req, reply) => {
        return reply.send({
            status: 'ok',
            scenes: Object.keys(SCENES).map((id) => ({ id, alt: SCENES[id]?.alt ?? '' })),
        })
    })
}

export default illustrationRoutes
