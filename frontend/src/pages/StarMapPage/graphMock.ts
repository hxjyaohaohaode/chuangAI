/**
 * 诗脉星图 · 降级 Mock 数据（DEV-only）
 *
 * [注意] 此文件为开发期降级数据，禁止进入生产包：
 *  - buildMockGraph() 在生产环境（import.meta.env.DEV === false）返回空图谱
 *  - 节点/边常量仅在 DEV 模式下被引用，Vite 生产构建会 tree-shake 掉
 *
 * 用途：当后端 /api/knowledge-graph/* 不可达时，前端仍可独立展示星图，
 *      便于开发期验收与演示。数据选取小学语文教材经典篇目。
 *
 * 数据自洽性：
 *  - 节点 id 全局唯一，前缀按类型区分（poet-/poem-/img-/thm-/era-/rht-）
 *  - 边的 source/target 必须指向已存在节点
 *  - degree 字段留空，由 StarMapCanvas 在运行时根据边数计算
 */

import type { GraphData, GraphNode, GraphEdge } from '@/lib/types'

const nodes: GraphNode[] = [
    /* ---------- 诗人 ---------- */
    {
        id: 'poet-libai',
        type: 'Poet',
        label: '李白',
        dynasty: '唐',
        bio: '字太白，号青莲居士，唐代浪漫主义诗人，被后世尊为"诗仙"。其诗风豪放飘逸，想象奇特，善用夸张与神话意象。',
        works: ['poem-jingyesi', 'poem-wanglushanpubu'],
        mentors: [],
    },
    {
        id: 'poet-menghaoran',
        type: 'Poet',
        label: '孟浩然',
        dynasty: '唐',
        bio: '唐代山水田园派诗人，与王维并称"王孟"。诗风清淡自然，长于写景，多写隐逸生活与山水之趣。',
        works: ['poem-chunxiao'],
        mentors: ['poet-libai'],
    },
    {
        id: 'poet-wangzhihuan',
        type: 'Poet',
        label: '王之涣',
        dynasty: '唐',
        bio: '唐代边塞诗人，性情豪放，常击剑悲歌。其诗意境壮阔，仅存六首却名传千古。',
        works: ['poem-dengguanquelou'],
        mentors: [],
    },
    {
        id: 'poet-baijuyi',
        type: 'Poet',
        label: '白居易',
        dynasty: '唐',
        bio: '字乐天，号香山居士，唐代现实主义诗人。主张"文章合为时而著，歌诗合为事而作"，语言平易近人。',
        works: ['poem-cuncao'],
        mentors: ['poet-libai'],
    },
    {
        id: 'poet-liuzongyuan',
        type: 'Poet',
        label: '柳宗元',
        dynasty: '唐',
        bio: '唐代文学家、"唐宋八大家"之一，与韩愈并称"韩柳"。诗风清冷峻拔，长于借景抒怀。',
        works: ['poem-jiangxue'],
        mentors: [],
    },

    /* ---------- 诗篇 ---------- */
    {
        id: 'poem-jingyesi',
        type: 'Poem',
        label: '静夜思',
        poet: '李白',
        poetId: 'poet-libai',
        dynasty: '唐',
        content: '## 静夜思\n\n> 床前明月光，疑是地上霜。\n>\n> 举头望明月，低头思故乡。\n\n**体裁**：五言绝句\n\n**意象**：以"月"寄托思乡之情，"霜"暗示夜寒与孤寂。',
        mastery: { remember: 92, understand: 88, apply: 85, analyze: 78, evaluate: 72, create: 68 },
        darkMatter: ['创造'],
    },
    {
        id: 'poem-wanglushanpubu',
        type: 'Poem',
        label: '望庐山瀑布',
        poet: '李白',
        poetId: 'poet-libai',
        dynasty: '唐',
        content: '## 望庐山瀑布\n\n> 日照香炉生紫烟，遥看瀑布挂前川。\n>\n> 飞流直下三千尺，疑是银河落九天。\n\n**修辞**：夸张（"三千尺""银河落九天"）',
        mastery: { remember: 85, understand: 80, apply: 72, analyze: 55, evaluate: 50, create: 45 },
        darkMatter: ['分析', '评价', '创造'],
    },
    {
        id: 'poem-chunxiao',
        type: 'Poem',
        label: '春晓',
        poet: '孟浩然',
        poetId: 'poet-menghaoran',
        dynasty: '唐',
        content: '## 春晓\n\n> 春眠不觉晓，处处闻啼鸟。\n>\n> 夜来风雨声，花落知多少。\n\n**主题**：惜春、自然。语言平易，意味深长。',
        mastery: { remember: 95, understand: 92, apply: 88, analyze: 85, evaluate: 82, create: 80 },
    },
    {
        id: 'poem-dengguanquelou',
        type: 'Poem',
        label: '登鹳雀楼',
        poet: '王之涣',
        poetId: 'poet-wangzhihuan',
        dynasty: '唐',
        content: '## 登鹳雀楼\n\n> 白日依山尽，黄河入海流。\n>\n> 欲穷千里目，更上一层楼。\n\n**哲理**：登高望远的进取精神。',
        mastery: { remember: 88, understand: 70, apply: 65, analyze: 60, evaluate: 58, create: 50 },
        darkMatter: ['理解', '创造'],
    },
    {
        id: 'poem-cuncao',
        type: 'Poem',
        label: '赋得古原草送别',
        poet: '白居易',
        poetId: 'poet-baijuyi',
        dynasty: '唐',
        content: '## 赋得古原草送别（节选）\n\n> 离离原上草，一岁一枯荣。\n>\n> 野火烧不尽，春风吹又生。\n\n**主题**：生命力的顽强；借草喻别。',
        mastery: { remember: 90, understand: 86, apply: 80, analyze: 75, evaluate: 70, create: 65 },
    },
    {
        id: 'poem-jiangxue',
        type: 'Poem',
        label: '江雪',
        poet: '柳宗元',
        poetId: 'poet-liuzongyuan',
        dynasty: '唐',
        content: '## 江雪\n\n> 千山鸟飞绝，万径人踪灭。\n>\n> 孤舟蓑笠翁，独钓寒江雪。\n\n**意境**：天地寂寥中的孤高人格。',
        mastery: { remember: 70, understand: 55, apply: 50, analyze: 48, evaluate: 45, create: 40 },
        darkMatter: ['理解', '运用', '分析', '评价', '创造'],
        isDarkMatter: true,
    },

    /* ---------- 意象 ---------- */
    { id: 'img-moon', type: 'Image', label: '月', description: '中华文化核心意象。象征思乡、团圆、孤独与永恒。李白诗中"月"出现三百余次。' },
    { id: 'img-bird', type: 'Image', label: '鸟', description: '常以啼鸟烘托春意或反衬空寂，是动静对比的典型意象。' },
    { id: 'img-grass', type: 'Image', label: '草', description: '象征生命循环与顽强，亦用于离别的"芳草天涯"母题。' },
    { id: 'img-snow', type: 'Image', label: '雪', description: '象征高洁、寂寥与严寒，多见于边塞与咏怀诗。' },
    { id: 'img-waterfall', type: 'Image', label: '瀑布', description: '象征气势磅礴与自然伟力，常配合夸张修辞。' },

    /* ---------- 主题 ---------- */
    { id: 'thm-homesick', type: 'Theme', label: '思乡', description: '羁旅诗的核心主题，借月、雁、笛等意象抒发故园之思。' },
    { id: 'thm-nature', type: 'Theme', label: '自然', description: '山水田园诗的主题，表现自然之美与天人合一。' },
    { id: 'thm-parting', type: 'Theme', label: '送别', description: '借草木荣枯、长亭古道抒发离情。' },
    { id: 'thm-perseverance', type: 'Theme', label: '进取', description: '登高望远、自强不息的哲理主题。' },

    /* ---------- 朝代 ---------- */
    { id: 'era-tang', type: 'Era', label: '唐', description: '公元 618—907 年，中国古典诗歌的黄金时代，存诗近五万首。' },

    /* ---------- 修辞 ---------- */
    { id: 'rht-exaggeration', type: 'Rhetoric', label: '夸张', description: '刻意放大或缩小事物特征，以突出本质、强化情感。' },
    { id: 'rht-parallelism', type: 'Rhetoric', label: '对偶', description: '上下句结构对称、词性相应，形成音韵与意义的呼应。' },
    { id: 'rht-personification', type: 'Rhetoric', label: '拟人', description: '赋予自然物以人的情感行为，增强亲和力。' },
]

const edges: GraphEdge[] = [
    /* 诗人 → 朝代 */
    { source: 'poet-libai', target: 'era-tang', type: 'BELONGS_TO_ERA' },
    { source: 'poet-menghaoran', target: 'era-tang', type: 'BELONGS_TO_ERA' },
    { source: 'poet-wangzhihuan', target: 'era-tang', type: 'BELONGS_TO_ERA' },
    { source: 'poet-baijuyi', target: 'era-tang', type: 'BELONGS_TO_ERA' },
    { source: 'poet-liuzongyuan', target: 'era-tang', type: 'BELONGS_TO_ERA' },

    /* 师承 */
    { source: 'poet-menghaoran', target: 'poet-libai', type: 'MENTORS' },
    { source: 'poet-baijuyi', target: 'poet-libai', type: 'MENTORS' },

    /* 诗 → 诗人 */
    { source: 'poem-jingyesi', target: 'poet-libai', type: 'AUTHORED_BY' },
    { source: 'poem-wanglushanpubu', target: 'poet-libai', type: 'AUTHORED_BY' },
    { source: 'poem-chunxiao', target: 'poet-menghaoran', type: 'AUTHORED_BY' },
    { source: 'poem-dengguanquelou', target: 'poet-wangzhihuan', type: 'AUTHORED_BY' },
    { source: 'poem-cuncao', target: 'poet-baijuyi', type: 'AUTHORED_BY' },
    { source: 'poem-jiangxue', target: 'poet-liuzongyuan', type: 'AUTHORED_BY' },

    /* 诗 → 意象 */
    { source: 'poem-jingyesi', target: 'img-moon', type: 'USES_IMAGE' },
    { source: 'poem-chunxiao', target: 'img-bird', type: 'USES_IMAGE' },
    { source: 'poem-cuncao', target: 'img-grass', type: 'USES_IMAGE' },
    { source: 'poem-jiangxue', target: 'img-snow', type: 'USES_IMAGE' },
    { source: 'poem-wanglushanpubu', target: 'img-waterfall', type: 'USES_IMAGE' },

    /* 诗 → 主题 */
    { source: 'poem-jingyesi', target: 'thm-homesick', type: 'USES_THEME' },
    { source: 'poem-chunxiao', target: 'thm-nature', type: 'USES_THEME' },
    { source: 'poem-cuncao', target: 'thm-parting', type: 'USES_THEME' },
    { source: 'poem-cuncao', target: 'thm-nature', type: 'USES_THEME' },
    { source: 'poem-dengguanquelou', target: 'thm-perseverance', type: 'USES_THEME' },
    { source: 'poem-jiangxue', target: 'thm-nature', type: 'USES_THEME' },

    /* 诗 → 修辞 */
    { source: 'poem-wanglushanpubu', target: 'rht-exaggeration', type: 'USES_RHETORIC' },
    { source: 'poem-dengguanquelou', target: 'rht-parallelism', type: 'USES_RHETORIC' },
    { source: 'poem-chunxiao', target: 'rht-personification', type: 'USES_RHETORIC' },

    /* 同意象（诗↔诗） */
    { source: 'poem-jingyesi', target: 'poem-chunxiao', type: 'SHARES_IMAGE' },
    { source: 'poem-cuncao', target: 'poem-jiangxue', type: 'SHARES_IMAGE' },

    /* 同主题 */
    { source: 'poem-chunxiao', target: 'poem-cuncao', type: 'SHARES_THEME' },
    { source: 'poem-chunxiao', target: 'poem-jiangxue', type: 'SHARES_THEME' },

    /* 同修辞 */
    { source: 'poem-wanglushanpubu', target: 'poem-dengguanquelou', type: 'SHARES_RHETORIC' },
]

/** 计算 degree（连接数）并返回完整 mock 图谱 */
export function buildMockGraph(): GraphData {
    // 接口不可达时仍返回明确标识的演示图谱。
    // 是否为演示数据由 StarMapPage 的 usingMock 状态与页面提示负责，
    // 不能在生产构建里返回空图，否则“已降级”会变成不可用的白屏。
    const degreeMap = new Map<string, number>()
    for (const e of edges) {
        degreeMap.set(e.source, (degreeMap.get(e.source) ?? 0) + 1)
        degreeMap.set(e.target, (degreeMap.get(e.target) ?? 0) + 1)
    }
    const nodesWithDegree = nodes.map((n) => ({
        ...n,
        degree: degreeMap.get(n.id) ?? 0,
    }))
    return { nodes: nodesWithDegree, edges }
}
