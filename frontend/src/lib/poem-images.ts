import { releasedStarmapImagePath } from './poem-generated-images'

/**
 * 古诗配图与文化场景图清单（SubTask 5.2 / 5.4）
 *
 * 20 首核心古诗的专属配图路径 + 4 个文化场景图路径。
 * 22 张经来源、原尺寸内容与解码复核通过的 WebP 已固化到 frontend/public；
 * 其中 16 张复用既有合格资源，6 张替换已知错字/提示残留/语义错配候选。
 * 正式内容不使用低细节 SVG，也不依赖 data/ 运行时缓存。
 *
 * WebP 来源：Wan2.7 诗篇唯一图像批次（精选副本）
 * 发布位置：frontend/public/images/generated/starmap/
 */

/** 20 首核心古诗配图清单 */
export interface PoemImageInfo {
    /** 诗 ID（与知识图谱一致） */
    id: string
    /** 诗名 */
    title: string
    /** 诗人 */
    poet: string
    /** 朝代 */
    dynasty: string
    /** 配图路径（public 目录相对路径） */
    imagePath: string
    /** 场景类型（对应 PoemIllustration 的场景） */
    scene: string
    /** 图片描述（alt 文本） */
    alt: string
    /** 核心意象 */
    imagery: string
}

/** 20 首核心古诗配图列表 */
export const POEM_IMAGES: readonly PoemImageInfo[] = [
    {
        id: 'poem-jingyesi',
        title: '静夜思',
        poet: '李白',
        dynasty: '唐',
        imagePath: releasedStarmapImagePath('tongbian-003'),
        scene: 'moon-night',
        alt: '静夜思配图：明月光透过窗户照在床前，诗人抬头望月低头思乡',
        imagery: '明月、思乡',
    },
    {
        id: 'poem-yongliu',
        title: '咏柳',
        poet: '贺知章',
        dynasty: '唐',
        imagePath: releasedStarmapImagePath('tongbian-035'),
        scene: 'spring-willow',
        alt: '咏柳配图：春风中柳树抽出新枝，碧玉妆成，绿丝绦垂',
        imagery: '柳树、春风',
    },
    {
        id: 'poem-chunxiao',
        title: '春晓',
        poet: '孟浩然',
        dynasty: '唐',
        imagePath: releasedStarmapImagePath('tongbian-002'),
        scene: 'birds-spring',
        alt: '春晓配图：春日清晨鸟鸣处处，夜来风雨花落知多少',
        imagery: '春雨、鸟鸣、落花',
    },
    {
        id: 'poem-wanglushanpubu',
        title: '望庐山瀑布',
        poet: '李白',
        dynasty: '唐',
        imagePath: releasedStarmapImagePath('tongbian-006'),
        scene: 'waterfall',
        alt: '望庐山瀑布配图：庐山瀑布飞流直下三千尺，疑是银河落九天',
        imagery: '瀑布、高山',
    },
    {
        id: 'poem-dengguanquelou',
        title: '登鹳雀楼',
        poet: '王之涣',
        dynasty: '唐',
        imagePath: releasedStarmapImagePath('tongbian-005'),
        scene: 'waterfall',
        alt: '登鹳雀楼配图：白日依山尽，黄河入海流，欲穷千里目更上一层楼',
        imagery: '登高、远眺',
    },
    {
        id: 'poem-jueju',
        title: '绝句',
        poet: '杜甫',
        dynasty: '唐',
        imagePath: releasedStarmapImagePath('tongbian-036'),
        scene: 'birds-spring',
        alt: '绝句配图：两个黄鹂鸣翠柳，一行白鹭上青天',
        imagery: '黄鹂、白鹭、翠柳',
    },
    {
        id: 'poem-jiangxue',
        title: '江雪',
        poet: '柳宗元',
        dynasty: '唐',
        imagePath: releasedStarmapImagePath('tongbian-007'),
        scene: 'snow',
        alt: '江雪配图：千山鸟飞绝万径人踪灭，孤舟蓑笠翁独钓寒江雪',
        imagery: '雪、孤舟、寒江',
    },
    {
        id: 'poem-xunyinzhebuyu',
        title: '寻隐者不遇',
        poet: '贾岛',
        dynasty: '唐',
        imagePath: releasedStarmapImagePath('tongbian-025'),
        scene: 'forest-mountain',
        alt: '寻隐者不遇配图：松下问童子，言师采药去，只在此山中',
        imagery: '松山、隐者',
    },
    {
        id: 'poem-fengqiaoyebo',
        title: '枫桥夜泊',
        poet: '张继',
        dynasty: '唐',
        imagePath: releasedStarmapImagePath('tongbian-014'),
        scene: 'moon-night',
        alt: '枫桥夜泊配图：月落乌啼霜满天，江枫渔火对愁眠，夜半钟声到客船',
        imagery: '月落、渔火、钟声',
    },
    {
        id: 'poem-qingming',
        title: '清明',
        poet: '杜牧',
        dynasty: '唐',
        imagePath: releasedStarmapImagePath('tongbian-061'),
        scene: 'spring-willow',
        alt: '清明配图：清明时节雨纷纷，路上行人欲断魂，牧童遥指杏花村',
        imagery: '春雨、行人、杏花',
    },
    {
        id: 'poem-jiuyuejiuyi',
        title: '九月九日忆山东兄弟',
        poet: '王维',
        dynasty: '唐',
        imagePath: releasedStarmapImagePath('tongbian-011'),
        scene: 'festival',
        alt: '九月九日忆山东兄弟配图：独在异乡为异客，每逢佳节倍思亲，登高插茱萸',
        imagery: '登高、茱萸、思乡',
    },
    {
        id: 'poem-songyuanershianxi',
        title: '送元二使安西',
        poet: '王维',
        dynasty: '唐',
        imagePath: releasedStarmapImagePath('tongbian-066'),
        scene: 'river-boat',
        alt: '送元二使安西配图：渭城朝雨浥轻尘，客舍青青柳色新，劝君更尽一杯酒',
        imagery: '送别、柳色、酒',
    },
    {
        id: 'poem-chusai',
        title: '出塞',
        poet: '王昌龄',
        dynasty: '唐',
        imagePath: releasedStarmapImagePath('tongbian-078'),
        scene: 'frontier',
        alt: '出塞配图：秦时明月汉时关，万里长征人未还，边塞苍凉',
        imagery: '明月、边关、长征',
    },
    {
        id: 'poem-furonglousongxinjian',
        title: '芙蓉楼送辛渐',
        poet: '王昌龄',
        dynasty: '唐',
        imagePath: releasedStarmapImagePath('tongbian-067'),
        scene: 'frontier',
        alt: '芙蓉楼送辛渐配图：寒雨连江夜入吴，平明送客楚山孤，一片冰心在玉壶',
        imagery: '寒雨、楚山、冰心',
    },
    {
        id: 'poem-luzhai',
        title: '鹿柴',
        poet: '王维',
        dynasty: '唐',
        imagePath: releasedStarmapImagePath('tongbian-041'),
        scene: 'forest-mountain',
        alt: '鹿柴配图：空山不见人，但闻人语响，返景入深林复照青苔上',
        imagery: '空山、深林、青苔',
    },
    {
        id: 'poem-shanjuqiuming',
        title: '山居秋暝',
        poet: '王维',
        dynasty: '唐',
        imagePath: releasedStarmapImagePath('tongbian-s33'),
        scene: 'forest-mountain',
        alt: '山居秋暝配图：空山新雨后天气晚来秋，明月松间照清泉石上流',
        imagery: '空山、明月、清泉',
    },
    {
        id: 'poem-wangtianmenshan',
        title: '望天门山',
        poet: '李白',
        dynasty: '唐',
        imagePath: releasedStarmapImagePath('tongbian-008'),
        scene: 'river-gate',
        alt: '望天门山配图：天门中断楚江开，碧水东流至此回，两岸青山相对出',
        imagery: '天门山、楚江、孤帆',
    },
    {
        id: 'poem-zaofabaidicheng',
        title: '早发白帝城',
        poet: '李白',
        dynasty: '唐',
        imagePath: releasedStarmapImagePath('tongbian-s09'),
        scene: 'river-boat',
        alt: '早发白帝城配图：朝辞白帝彩云间，千里江陵一日还，轻舟已过万重山',
        imagery: '白帝城、江陵、轻舟',
    },
    {
        id: 'poem-zengwanglun',
        title: '赠汪伦',
        poet: '李白',
        dynasty: '唐',
        imagePath: releasedStarmapImagePath('tongbian-027'),
        scene: 'river-boat',
        alt: '赠汪伦配图：李白乘舟将欲行，忽闻岸上踏歌声，桃花潭水深千尺',
        imagery: '乘舟、踏歌、桃花潭',
    },
    {
        id: 'poem-huanghelousongmenghaoran',
        title: '黄鹤楼送孟浩然之广陵',
        poet: '李白',
        dynasty: '唐',
        imagePath: releasedStarmapImagePath('tongbian-017'),
        scene: 'river-boat',
        alt: '黄鹤楼送孟浩然之广陵配图：故人西辞黄鹤楼，烟花三月下扬州，孤帆远影碧空尽',
        imagery: '黄鹤楼、孤帆、长江',
    },
] as const

/** 根据诗 ID 获取配图信息 */
export function getPoemImage(poemId: string): PoemImageInfo | undefined {
    return POEM_IMAGES.find((p) => p.id === poemId)
}

/* ============================================================
 * 文化场景图清单（SubTask 5.4）
 * ============================================================ */

/** 4 个核心文化场景图清单 */
export interface CultureSceneInfo {
    /** 场景 ID */
    id: string
    /** 场景标题 */
    title: string
    /** 图片路径 */
    imagePath: string
    /** 场景描述 */
    description: string
    /** alt 文本 */
    alt: string
    /** 关联诗句 */
    relatedVerse: string
}

/** 4 个核心文化场景图列表 */
export const CULTURE_SCENES: readonly CultureSceneInfo[] = [
    {
        id: 'yangguan-farewell',
        title: '阳关送别',
        imagePath: releasedStarmapImagePath('tongbian-066'),
        description: '渭城朝雨浥轻尘，客舍青青柳色新。劝君更尽一杯酒，西出阳关无故人。',
        alt: '阳关送别场景：大漠黄沙中的渭城朝雨，王维送别元二，客舍柳色青青',
        relatedVerse: '劝君更尽一杯酒，西出阳关无故人。',
    },
    {
        id: 'willow-farewell',
        title: '折柳赠别',
        imagePath: releasedStarmapImagePath('tongbian-035'),
        description: '古人折柳赠别，柳谐音"留"，表达依依不舍之情。驿站折柳，离愁别绪。',
        alt: '折柳赠别场景：古人驿站折柳枝赠别，柳条依依，春风拂面',
        relatedVerse: '昔我往矣，杨柳依依。',
    },
    {
        id: 'guqin-playing',
        title: '古琴演奏',
        imagePath: releasedStarmapImagePath('tongbian-043'),
        description: '松下抚琴，焚香品茗，高山流水觅知音。古琴为文人四艺之首。',
        alt: '古琴演奏场景：唐代文人雅集，松下抚琴，焚香品茗，高山流水',
        relatedVerse: '独坐幽篁里，弹琴复长啸。',
    },
    {
        id: 'tang-study',
        title: '唐代书斋',
        imagePath: releasedStarmapImagePath('tongbian-s36'),
        description: '古籍卷轴，笔墨纸砚，油灯竹简，文人夜读苦学。唐代书斋陈设古朴典雅。',
        alt: '唐代书斋场景：古籍卷轴笔墨纸砚，油灯竹简，文人夜读',
        relatedVerse: '三更灯火五更鸡，正是男儿读书时。',
    },
] as const

/**
 * 旧版插画 URL 升级表。后端缓存或历史记录仍可能返回 SVG 路径，
 * 展示层只替换为已随发布包固化、且通过内容抽检的 WebP。
 * 历史 SVG 地址只作为兼容输入；展示层统一升级为已随包审计的 WebP。
 */
const LEGACY_IMAGE_UPGRADES: Readonly<Record<string, string>> = {
    '/images/poems/jingyesi.svg': releasedStarmapImagePath('tongbian-003'),
    '/images/poems/yongliu.svg': releasedStarmapImagePath('tongbian-035'),
    '/images/poems/chunxiao.svg': releasedStarmapImagePath('tongbian-002'),
    '/images/poems/wanglushanpuba.svg': releasedStarmapImagePath('tongbian-006'),
    '/images/poems/dengguanquelou.svg': releasedStarmapImagePath('tongbian-005'),
    '/images/poems/jueju.svg': releasedStarmapImagePath('tongbian-036'),
    '/images/poems/jiangxue.svg': releasedStarmapImagePath('tongbian-007'),
    '/images/poems/xunyinzhebuyu.svg': releasedStarmapImagePath('tongbian-025'),
    '/images/poems/fengqiaoyebo.svg': releasedStarmapImagePath('tongbian-014'),
    '/images/poems/qingming.svg': releasedStarmapImagePath('tongbian-061'),
    '/images/poems/jiuyuejiuyi.svg': releasedStarmapImagePath('tongbian-011'),
    '/images/poems/songyuanershianxi.svg': releasedStarmapImagePath('tongbian-066'),
    '/images/poems/furonglousongxinjian.svg': releasedStarmapImagePath('tongbian-067'),
    '/images/poems/chusai.svg': releasedStarmapImagePath('tongbian-078'),
    '/images/poems/luzhai.svg': releasedStarmapImagePath('tongbian-041'),
    '/images/poems/shanjuqiuming.svg': releasedStarmapImagePath('tongbian-s33'),
    '/images/poems/wangtianmenshan.svg': releasedStarmapImagePath('tongbian-008'),
    '/images/poems/zaofabaidicheng.svg': releasedStarmapImagePath('tongbian-s09'),
    '/images/poems/zengwanglun.svg': releasedStarmapImagePath('tongbian-027'),
    '/images/poems/huanghelousongmenghaoran.svg': releasedStarmapImagePath('tongbian-017'),
    '/images/culture/yangguan_farewell.svg': releasedStarmapImagePath('tongbian-066'),
    '/images/culture/zhe-liu-farewell.svg': releasedStarmapImagePath('tongbian-035'),
    '/images/culture/guqin-playing.svg': releasedStarmapImagePath('tongbian-043'),
    '/images/culture/tang-study.svg': releasedStarmapImagePath('tongbian-s36'),
}

export function getPreferredPoeticImageUrl(src: string): string {
    try {
        const path = new URL(src, 'http://poetic-realm.local').pathname
        return LEGACY_IMAGE_UPGRADES[path] ?? src
    } catch {
        return LEGACY_IMAGE_UPGRADES[src] ?? src
    }
}

