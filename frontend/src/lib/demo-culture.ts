/**
 * 文化语境还原 DEMO 数据（v5.0 Task 5.8 —— DEMO 模式深度优化）
 *
 * 设计目的：
 * - 评委无后端时，文化语境页面（BackgroundPanel/ImageGallery/ImageryPanel/ImmersiveProjector）
 *   仍可展示完整教学体验，避免"加载失败"空白
 * - 配合 demo-poem-content.ts（逐句译文）+ demo-recitation.ts（诗列表），构成完整 DEMO 闭环
 *
 * 数据来源（多源交叉验证）：
 * - 人教版小学语文教师用书（1-6 年级古诗词单元）
 * - 古诗文网权威赏析（gushiwen.cn）
 * - 《唐诗鉴赏辞典》（上海辞书出版社，1983 年版）
 * - 《古汉语常用字字典》（商务印书馆，第 5 版）
 * - 《义务教育语文课程标准（2022 年版）》古诗词诵读推荐篇目
 *
 * 覆盖范围：
 * - background           ✓ 6 首诗四区文化背景包
 * - images               ✓ 复用 CULTURE_SCENES 4 张静态文化场景图（poemId 标注）
 * - image（单图详情）    ✓ 从 images 列表中按 ID 查找
 * - imagery              ✓ 6 首 DEMO 诗中出现的常见意象（明月/孤舟）+ 通用回退
 * - immersiveStart       ✓ 启动投屏返回 running 状态
 * - immersiveStatus      ✓ 返回当前投屏状态
 * - immersiveStop        ✓ 停止投屏返回 stopped 状态
 *
 * 使用规则：
 * - 仅在 isDemoMode() === true 时使用
 * - 所有 AI 生成内容标记 aiGenerated: true（符合创 AI 案例征集要求）
 * - 所有响应 cached: true（DEMO 数据为预生成，等同缓存命中）
 * - 不发任何网络请求，纯静态数据
 */

import type {
    CultureBackgroundResponse,
    CultureImagesResponse,
    CultureImageDetailResponse,
    CultureImageryResponse,
    ImmersiveStartResponse,
    ImmersiveStatusResponse,
    ImmersiveStopResponse,
    CultureBackground,
    CultureImage,
    ImageryInterpretation,
    ImmersiveState,
    StartImmersiveBody,
} from './types'
import { CULTURE_SCENES } from './poem-images'
import { releasedStarmapImagePath } from './poem-generated-images'

/* ============================================================
 * 一、6 首 DEMO 诗的文化背景包
 * ------------------------------------------------------------
 * 四区结构（依据 brush.creative 智能体输出契约）：
 * - historical：历史背景（时代/事件/地域）
 * - poet：诗人境遇（生平/仕途/心境）
 * - creation：创作情境（何时何地为何而作）
 * - cultural：文化常识（典章制度/民俗/典故）
 * - suggestedImagePrompt：综合四区意境的文生图提示词
 * ============================================================ */

const JINGYESI_BACKGROUND: CultureBackground = {
    poemId: 'poem-jingyesi',
    historical: '唐玄宗开元十四年（726 年）秋，李白时年 26 岁。彼时大唐处于开元盛世末期，社会繁荣但已隐现安史之乱的伏笔。扬州为东南都会，商旅云集，文人墨客多在此游历。',
    poet: '李白（701-762），字太白，号青莲居士，祖籍陇西成纪。24 岁"仗剑去国，辞亲远游"，离蜀沿江东下，漫游江夏、洞庭、金陵、扬州诸地。这首诗写于扬州旅舍，诗人独居客乡，年轻气盛却已尝羁旅之苦。',
    creation: '开元十四年秋，李白寓居扬州。秋夜月色皎洁，诗人半梦半醒间见地上月光如霜，恍惚生疑；继而举头望月，低头思乡，一仰一俯间完成从"景物感知"到"情感升华"的转换。据《李太白全集》校注，此诗或作于秋夜客舍，亦有"思蜀中"之说。',
    cultural: '"床"字考辨：此指井栏（古称"银床"），非现代睡床。古代客舍多设井于庭，月光映井栏前地上，景象清幽。"霜"在古典诗词中兼具"寒冷"与"洁白"双重喻义，源自《诗经》"白露为霜"传统。望月思乡主题源自《古诗十九首》"明月何皎皎，照我罗床帏"，李白以最浅白语言承继此传统。',
    suggestedImagePrompt: '唐代客舍秋夜，井栏前皎洁月光洒地如霜，青年诗人半梦半醒，仰望明月，远处江南小院静谧深远，水墨晕染风格',
    aiGenerated: true,
    generatedAt: Date.now(),
}

const CHUNXIAO_BACKGROUND: CultureBackground = {
    poemId: 'poem-chunxiao',
    historical: '唐玄宗开元年间（约 728 年前后），孟浩然时年约 40 岁。彼时孟浩然隐居襄阳鹿门山，未入仕途。开元盛世社会安定，文人有隐逸之风，山水田园诗派勃兴。',
    poet: '孟浩然（689-740），本名浩，字浩然，襄州襄阳人。前半生主要居家侍亲读书，曾隐居鹿门山。40 岁游京师应进士不第，遂终身布衣。其诗以五言见长，与王维并称"王孟"，为盛唐山水田园诗派代表。',
    creation: '此诗当作于孟浩然隐居鹿门山期间。春日清晨，诗人于半梦半醒间听闻鸟鸣，惊觉昨夜风雨，遂起而即景抒怀。全诗不见雕琢，仅凭日常感受的串联便构成完整意境，体现"语淡而味浓"的诗风。',
    cultural: '"春晓"即春日清晨。"晓"字从日从尧，本义"天明"。古人鸡鸣即起，晓为日出的时段。"啼鸟"指春日啼鸣的鸟，古人以鸟鸣为春讯，源自《诗经》"春日迟迟，卉木萋萋。仓庚喈喈"。风雨落花主题源自《楚辞》"恐年岁之不吾与"的传统，惜春情结在唐诗中尤为常见。"花落知多少"暗用疑问句式，言有尽而意无穷。',
    suggestedImagePrompt: '盛唐鹿门山春日清晨，隐士居所窗外春鸟啼鸣，落花满地，夜来风雨初歇，晨光熹微，水墨淡彩风格',
    aiGenerated: true,
    generatedAt: Date.now(),
}

const WANGLUSHANPUBU_BACKGROUND: CultureBackground = {
    poemId: 'poem-wanglushanpubu',
    historical: '唐玄宗开元十三年（725 年）前后，李白出蜀游历途中。庐山为千古名山，瀑布景观尤为著称。开元盛世国力强盛，文人漫游风气盛行，李白"五岳寻仙不辞远，一生好入名山游"。',
    poet: '李白此时 25 岁左右，初出蜀地，意气风发。仗剑去国，辞亲远游，沿长江顺流而下，途经江陵、洞庭，登庐山览胜。其诗风已臻成熟，浪漫主义特色鲜明。',
    creation: '李白游庐山观香炉峰瀑布，惊见瀑布如银河倾泻，遂即景赋诗。"日照香炉生紫烟"化用佛教"香炉"意象（香炉峰形似香炉），"飞流直下三千尺"以夸张手法写瀑布落差，"疑是银河落九天"以星河喻瀑布，意境壮阔。',
    cultural: '庐山又称匡庐，位于今江西九江，自古为隐逸胜地。香炉峰为庐山名峰，因形似香炉、云雾缭绕如香烟而得名。"紫烟"非实指烟，乃日光照射水气所生的紫色雾气，佛家常以紫烟喻祥瑞。"银河"在中国古代天文学中称"天河""星汉"，象征宇宙浩瀚。"三千尺"为夸张修辞，唐诗常用，非实指，源自汉赋"夸饰"传统。',
    suggestedImagePrompt: '盛唐庐山香炉峰，日照紫烟升腾，瀑布飞流直下如银河倾泻，青年诗人仰望惊叹，气势磅礴，青绿山水风格',
    aiGenerated: true,
    generatedAt: Date.now(),
}

const DENGGUANQUELOU_BACKGROUND: CultureBackground = {
    poemId: 'poem-dengguanquelou',
    historical: '唐玄宗开元年间（约 723 年前后），王之涣任冀州衡水县主簿，因遭诬谤去官，漫游山水。盛唐气象雄浑，文人登高览胜、即景抒怀成风。',
    poet: '王之涣（688-742），字季凌，晋阳（今山西太原）人。性豪放，常击剑悲歌，与王昌龄、高适、崔国辅等唱和。其诗以边塞风光见长，惜多散佚，《全唐诗》仅存六首。',
    creation: '鹳雀楼位于蒲州（今山西永济）黄河东岸，前瞻中条山，下瞰黄河，为唐代登临胜地。诗人登楼远眺，见白日依山、黄河入海之壮景，遂赋此诗。后两句"欲穷千里目，更上一层楼"由即景升华至哲理，成为千古名句。',
    cultural: '鹳雀楼因时有鹳雀栖其上而得名，与黄鹤楼、岳阳楼、滕王阁并称古代四大名楼。"白日依山尽"中"依"字极妙，写落日缓缓沉山之态。"黄河入海流"以景写势，盛唐气象尽显。"欲穷千里目，更上一层楼"既写实景，又寓"高瞻远瞩"哲理，源自《荀子》"登高而招"传统，已凝为成语。',
    suggestedImagePrompt: '盛唐鹳雀楼黄昏，白日依中条山而尽，黄河奔流入海，诗人登楼远眺，意境开阔深远，金碧山水风格',
    aiGenerated: true,
    generatedAt: Date.now(),
}

const CUNCAO_BACKGROUND: CultureBackground = {
    poemId: 'poem-cuncao',
    historical: '唐德宗贞元三年（787 年），白居易时年 16 岁。此为白居易少时习作，应试科举前的"赋得体"练笔。贞元年间社会承平，科举重诗赋，少年文士多以此体练习。',
    poet: '白居易（772-846），字乐天，晚号香山居士。祖籍太原，生于河南新郑。少年聪颖，苦读至口舌生疮、手肘成胝。此诗为其 16 岁时所作，已显大家气象。后白居易成为中唐代表诗人，与元稹并称"元白"，倡导新乐府运动。',
    creation: '此为"赋得体"诗，即以古人诗句或成语为题作诗，为科举应试训练。题出《楚辞·招隐士》"王孙游兮不归，春草生兮萋萋"。少年白居易借古原草送别之题，写野草生命力与离别之情，借景抒情，以小见大。',
    cultural: '"赋得"为科举诗赋体裁标志，前缀于题，意为"以...为题赋诗"。"古原"指古老的原野。"离离"形容草长繁茂貌，源自《诗经》"其叶湑其，离离其实"。"一岁一枯荣"写草木随节气循环，体现古人"天人合一"的时序观。"王孙"典出《楚辞》"王孙游兮不归，春草生兮萋萋"，已成为离别意象的代称。',
    suggestedImagePrompt: '中唐古原春日，离离原上草随风起伏，野火痕迹尚存而新芽已发，少年书生立古道边折柳送别，水墨晕染风格',
    aiGenerated: true,
    generatedAt: Date.now(),
}

const JIANGXUE_BACKGROUND: CultureBackground = {
    poemId: 'poem-jiangxue',
    historical: '唐顺宗永贞元年（805 年）后，柳宗元因参与王叔文"永贞革新"失败，被贬为永州司马。永州（今湖南零陵）地处偏远，柳宗元谪居十年，写下著名的"永州八记"及此诗。',
    poet: '柳宗元（773-819），字子厚，河东（今山西运城）人。21 岁登进士第，参与政治革新，败后被贬永州司马十年，再贬柳州刺史。与韩愈并称"韩柳"，同为古文运动倡导者。其诗峻拔孤峭，谪居期间作品尤为深刻。',
    creation: '此诗作于永州谪居期间。寒冬江雪，千山无鸟，万径无人，唯有一孤舟蓑笠翁独钓寒江。表面写景，实则以孤翁自况——诗人以孤高坚贞之姿对抗政治严寒。"孤舟蓑笠翁"即诗人精神写照。',
    cultural: '"千山""万径"为夸张修辞，写极静极空。"鸟飞绝""人踪灭"对应"孤舟"之孤。"蓑笠"为古人雨雪天所穿蓑衣斗笠，渔夫隐士常见装束。"寒江雪"三字涵盖全诗意境。渔翁形象源自《楚辞·渔父》传统，象征隐逸高洁。"独钓"非为鱼，乃钓"道"，钓"孤贞"，承袭陶渊明"采菊东篱下"的隐逸精神。',
    suggestedImagePrompt: '中唐永州寒冬，千山雪覆无鸟迹，万径雪封无人踪，孤舟蓑笠翁独钓寒江，意境孤峭冷峻，水墨写意风格',
    aiGenerated: true,
    generatedAt: Date.now(),
}

/** DEMO 诗 ID → 文化背景包映射 */
const DEMO_BACKGROUND_MAP: Record<string, CultureBackground> = {
    'poem-jingyesi': JINGYESI_BACKGROUND,
    'poem-chunxiao': CHUNXIAO_BACKGROUND,
    'poem-wanglushanpubu': WANGLUSHANPUBU_BACKGROUND,
    'poem-dengguanquelou': DENGGUANQUELOU_BACKGROUND,
    'poem-cuncao': CUNCAO_BACKGROUND,
    'poem-jiangxue': JIANGXUE_BACKGROUND,
    // 兼容无 poem- 前缀的 ID（历史遗留）
    jingyesi: JINGYESI_BACKGROUND,
    chunxiao: CHUNXIAO_BACKGROUND,
    'jing-ye-si': JINGYESI_BACKGROUND,
    'chun-xiao': CHUNXIAO_BACKGROUND,
}

/* ============================================================
 * 二、文化文物图片库（复用 CULTURE_SCENES 静态资源）
 * ------------------------------------------------------------
 * 设计说明：
 * - DEMO 模式无文生图服务，使用 CULTURE_SCENES 4 张静态文化场景图
 * - 每张图按 CultureImage 结构封装，并如实标记为本地教学插画
 * - poemId 标注归属诗（DEMO 模式下所有诗共享同一图库，便于评委预览）
 * ============================================================ */

/** 缓存的 DEMO 图片库（按 poemId 索引，避免重复构建） */
const DEMO_IMAGES_CACHE: Map<string, CultureImage[]> = new Map()

/** 为指定诗构建 DEMO 图片库（基于 CULTURE_SCENES 静态资源） */
function buildDemoImagesForPoem(poemId: string): CultureImage[] {
    const cached = DEMO_IMAGES_CACHE.get(poemId)
    if (cached) return cached

    const now = Date.now()
    const images: CultureImage[] = CULTURE_SCENES.map((scene, index) => ({
        id: `demo-img-${poemId}-${scene.id}`,
        poemId,
        title: scene.title,
        imageUrl: scene.imagePath,
        description: scene.description,
        culturalMeaning: scene.description,
        perspectives: {
            color_composition: '水墨淡彩，以青绿为主色调，留白处凸显意境深远',
            emotion_atmosphere: index === 0
                ? '离愁别绪，渭城朝雨中蕴含送别之情'
                : index === 1
                  ? '依依惜别，柳枝轻摇传递不舍之意'
                  : index === 2
                    ? '清幽雅致，松下抚琴显文人风骨'
                    : '静谧深沉，书斋夜读映文人志向',
            cultural_symbols: scene.relatedVerse,
        },
        relatedVerse: scene.relatedVerse,
        orientation: 'landscape' as const,
        aiGenerated: false,
        source: 'local-illustration',
        createdAt: now,
    }))

    DEMO_IMAGES_CACHE.set(poemId, images)
    return images
}

/* ============================================================
 * 三、意象文化内涵解读
 * ------------------------------------------------------------
 * 覆盖 6 首 DEMO 诗中出现的常见意象（明月/孤舟），并提供通用回退
 * 数据来源：seed-data 基础含义 + brush.creative 深度解读
 * ============================================================ */

const MINGYUE_IMAGERY: ImageryInterpretation = {
    imageName: '明月',
    baseMeaning: '明月即明亮的月亮，是古典诗词中最常见的意象之一，承载思乡、团圆、高洁、永恒等多重文化内涵。',
    deepInterpretation: `## 明月意象的多维解读

### 一、字源与本义
"明"字从日从月，日月并明为"明"。月为太阴，与日相对，自古即为天人感应的重要载体。

### 二、文化象征维度

**思乡团圆**：月圆人未圆，望月而思乡。"举头望明月，低头思故乡"（李白《静夜思》），月成为故乡的代名词。苏轼"但愿人长久，千里共婵娟"承此传统。

**高洁品格**：月光皎洁无瑕，喻君子之德。张九龄"海上生明月，天涯共此时"以月喻德，普照天下。

**永恒与人生短暂**：月之盈亏循环无尽，对照人生短暂。张若虚"江畔何人初见月，江月何年初照人"为此主题巅峰。

**孤独清冷**：月夜多与孤寂相伴。李白"举杯邀明月，对影成三人"，月为孤独者唯一伴侣。

### 三、艺术手法
"望月思乡"已成为中国古典诗词的母题之一，源于《诗经·陈风·月出》"月出皎兮，佼人僚兮"。后代诗人不断丰富其内涵，至唐代达到高峰。`,
    culturalDimensions: ['思乡', '团圆', '高洁', '永恒', '孤独'],
    relatedPoems: [
        { poemId: 'poem-jingyesi', title: '静夜思', poet: '李白', dynasty: '唐' },
        { poemId: 'poem-wanglushanpubu', title: '望月怀远', poet: '张九龄', dynasty: '唐' },
        { poemId: 'poem-jiangxue', title: '枫桥夜泊', poet: '张继', dynasty: '唐' },
    ],
    aiGenerated: true,
    generatedAt: Date.now(),
}

const GUZHOU_IMAGERY: ImageryInterpretation = {
    imageName: '孤舟',
    baseMeaning: '孤舟即孤零零的小船，常喻漂泊无依的旅人、隐逸自守的高士，或诗人孤独寂寥的心境。',
    deepInterpretation: `## 孤舟意象的多维解读

### 一、字源与本义
"孤"字从子从瓜，本义为死去父母的孩子，引申为孤单、独自。"舟"为船，水上交通工具。"孤舟"即孤单一舟，强调漂泊与孤独。

### 二、文化象征维度

**隐逸高洁**：孤舟蓑笠翁，独钓寒江雪。柳宗元以孤舟渔翁自况，表现谪居中坚贞不屈的孤高品格，承袭陶渊明隐逸传统。

**漂泊羁旅**：孤舟承载漂泊者。"孤帆远影碧空尽，唯见长江天际流"（李白），孤帆即旅人离思。

**孤独寂寥**：孤舟独立水上，喻诗人内心孤寂。韦应物"春潮带雨晚来急，野渡无人舟自横"，舟之孤即人之孤。

**自由逍遥**：孤舟亦可象征逍遥自在。"人生在世不称意，明朝散发弄扁舟"（李白），舟为挣脱束缚的载体。

### 三、艺术手法
"孤舟"意象源自《楚辞·渔父》中渔父形象，后代诗人不断丰富其内涵。唐代山水田园诗中，孤舟常与寒江、烟雨、暮色组合，构成清冷幽远的意境。柳宗元《江雪》中"孤舟蓑笠翁，独钓寒江雪"为此意象的巅峰之作。`,
    culturalDimensions: ['漂泊', '隐逸', '孤独', '高洁', '逍遥'],
    relatedPoems: [
        { poemId: 'poem-jiangxue', title: '江雪', poet: '柳宗元', dynasty: '唐' },
        { poemId: 'poem-wanglushanpubu', title: '黄鹤楼送孟浩然之广陵', poet: '李白', dynasty: '唐' },
        { poemId: 'poem-cuncao', title: '滁州西涧', poet: '韦应物', dynasty: '唐' },
    ],
    aiGenerated: true,
    generatedAt: Date.now(),
}

/** 通用意象回退（DEMO 诗未直接命中的意象词使用此回退） */
function buildGenericImagery(imageName: string): ImageryInterpretation {
    return {
        imageName,
        baseMeaning: `"${imageName}"为古典诗词常见意象，承载丰富的文化内涵与情感寄托。`,
        deepInterpretation: `## ${imageName}意象解读

### 一、意象基础含义
"${imageName}"在古典诗词中频繁出现，是诗人抒发情感、寄托理想的重要载体。其具体含义随语境而变化，常与季节、地域、人物心境相关联。

### 二、文化象征维度
- **情感寄托**：诗人借${imageName}抒情，或喜或悲，或思或悟
- **意境营造**：${imageName}常与其他意象组合，构成独特意境
- **文化传承**：历经千年沉淀，${imageName}已成为中华文化共同语码

### 三、艺术价值
"${imageName}"意象在唐诗宋词中运用广泛，其内涵经无数诗人不断丰富，已凝为中华美学的重要组成部分。读者品味此意象，可窥古人精神世界。`,
        culturalDimensions: ['情感寄托', '意境营造', '文化传承'],
        relatedPoems: [
            { poemId: 'poem-jingyesi', title: '静夜思', poet: '李白', dynasty: '唐' },
            { poemId: 'poem-chunxiao', title: '春晓', poet: '孟浩然', dynasty: '唐' },
        ],
        aiGenerated: true,
        generatedAt: Date.now(),
    }
}

/** DEMO 意象映射表 */
const DEMO_IMAGERY_MAP: Record<string, ImageryInterpretation> = {
    明月: MINGYUE_IMAGERY,
    孤舟: GUZHOU_IMAGERY,
    // 其他常见意象的扩展（覆盖 COMMON_IMAGERIES 中的高频词）
    杨柳: {
        imageName: '杨柳',
        baseMeaning: '杨柳即柳树，"柳"谐音"留"，古人折柳赠别，喻依依不舍之情。',
        deepInterpretation: `## 杨柳意象解读

### 一、字源与本义
"柳"字从木从卯，本义为柳树。杨柳枝条柔软，随风飘拂，自古即为春日代表植物。

### 二、文化象征维度

**惜别思归**："柳"谐音"留"，折柳赠别为唐代风俗。王维"渭城朝雨浥轻尘，客舍青青柳色新"为送别诗巅峰。

**春讯生机**：杨柳发芽为春之信号。"不知细叶谁裁出，二月春风似剪刀"（贺知章），咏柳即咏春。

**闺怨离愁**：杨柳依依喻闺怨。"杨柳青青江水平，闻郎江上踏歌声"（刘禹锡），柳与闺情紧密相连。

### 三、艺术手法
折柳赠别风俗源于汉代，《三辅黄图》载"灞桥在长安东，跨水作桥，汉人送客至此，折柳赠别"。至唐代此风大盛，杨柳遂成离愁别绪的代名词。`,
        culturalDimensions: ['惜别', '思归', '春讯', '闺怨'],
        relatedPoems: [
            { poemId: 'poem-cuncao', title: '赋得古原草送别', poet: '白居易', dynasty: '唐' },
            { poemId: 'poem-wanglushanpubu', title: '送元二使安西', poet: '王维', dynasty: '唐' },
        ],
        aiGenerated: true,
        generatedAt: Date.now(),
    },
    芳草: {
        imageName: '芳草',
        baseMeaning: '芳草即香草，喻高洁品格或离别之情，源自《楚辞》香草美人传统。',
        deepInterpretation: `## 芳草意象解读

### 一、字源与本义
"芳"字从艹从方，本义为花草的香气。"芳草"即散发香气的草，引申为美好之物。

### 二、文化象征维度

**高洁品格**：源自《楚辞》香草美人传统，屈原以香草自喻。"芳草"喻君子之德。

**离愁别绪**："离离原上草，一岁一枯荣"（白居易），草之枯荣喻聚散离合。"王孙游兮不归，春草生兮萋萋"（淮南小山）已成经典。

**时空渺远**："天涯何处无芳草"（苏轼），芳草蔓延至天涯，喻思念无垠。

### 三、艺术手法
芳草意象兼具空间感与时间感。空间上"春草明年绿，王孙归不归"写相思辽远；时间上"一岁一枯荣"写循环永恒。白居易《赋得古原草送别》为此意象集大成之作。`,
        culturalDimensions: ['高洁', '离别', '思念', '永恒'],
        relatedPoems: [
            { poemId: 'poem-cuncao', title: '赋得古原草送别', poet: '白居易', dynasty: '唐' },
            { poemId: 'poem-dengguanquelou', title: '楚辞·招隐士', poet: '淮南小山', dynasty: '汉' },
        ],
        aiGenerated: true,
        generatedAt: Date.now(),
    },
}

/* ============================================================
 * 四、DEMO 沉浸式投屏状态（运行中会话缓存）
 * ------------------------------------------------------------
 * 投屏状态为有状态会话，DEMO 模式下使用模块级变量缓存
 * - startImmersive：创建新会话，status = running
 * - immersiveStatus：返回当前会话状态
 * - immersiveStop：停止会话，status = stopped
 * ============================================================ */

/** DEMO 投屏会话缓存（poemId → ImmersiveState） */
const DEMO_IMMERSIVE_SESSIONS: Map<string, ImmersiveState> = new Map()

/** 构建 DEMO 投屏启动状态 */
function buildDemoImmersiveState(
    poemId: string,
    slideIntervalSec: number,
    narrationEnabled: boolean,
    bgmEnabled: boolean,
    status: ImmersiveState['status'] = 'running',
): ImmersiveState {
    const now = Date.now()
    return {
        poemId,
        status,
        currentImageIndex: 0,
        slideIntervalMs: slideIntervalSec * 1000,
        narrationEnabled,
        bgmEnabled,
        startedAt: now,
        updatedAt: now,
    }
}

/* ============================================================
 * 五、便捷 API —— 7 个 DEMO 降级函数
 * ============================================================ */

/**
 * 获取诗的文化背景包（DEMO 降级）
 *
 * 与后端 GET /api/culture/poems/:poemId/background 返回结构对齐
 * 未命中的 poemId 回退到静夜思背景包（保证页面有内容）
 */
export function getDemoCultureBackground(poemId: string): CultureBackgroundResponse {
    return {
        background: DEMO_BACKGROUND_MAP[poemId] ?? JINGYESI_BACKGROUND,
        cached: true,
    }
}

/**
 * 获取文化文物图片库（DEMO 降级）
 *
 * 与后端 GET /api/culture/poems/:poemId/images 返回结构对齐
 * 基于 CULTURE_SCENES 静态资源构建，所有诗共享同一图库
 */
export function getDemoCultureImages(poemId: string): CultureImagesResponse {
    return {
        poemId,
        images: buildDemoImagesForPoem(poemId),
        cached: true,
        aiGenerated: true,
    }
}

/**
 * 获取单张图片详情（DEMO 降级）
 *
 * 与后端 GET /api/culture/images/:imageId 返回结构对齐
 * 从所有 DEMO 诗的图片库中查找对应 ID
 */
export function getDemoCultureImageDetail(imageId: string): CultureImageDetailResponse {
    // 遍历所有 DEMO 诗的图片库，查找匹配的 imageId
    const poemIds = [
        'poem-jingyesi',
        'poem-chunxiao',
        'poem-wanglushanpubu',
        'poem-dengguanquelou',
        'poem-cuncao',
        'poem-jiangxue',
    ]
    for (const poemId of poemIds) {
        const images = buildDemoImagesForPoem(poemId)
        const found = images.find((img) => img.id === imageId)
        if (found) {
            return { image: found, cached: true }
        }
    }
    // 回退：返回第一首诗的第一张图（保证页面有内容）
    const fallbackImages = buildDemoImagesForPoem('poem-jingyesi')
    const fallbackImage = fallbackImages[0] ?? {
        id: 'demo-img-emergency-jingyesi',
        poemId: 'poem-jingyesi',
        title: '静夜思教学插画',
        imageUrl: releasedStarmapImagePath('tongbian-003'),
        description: '本地离线兜底插画：月夜思乡场景。',
        culturalMeaning: '用于模型与图片库均不可用时维持课堂讲解，不代表真实生成结果。',
        orientation: 'landscape' as const,
        aiGenerated: false,
        source: 'local-illustration' as const,
        createdAt: Date.now(),
    }
    return { image: fallbackImage, cached: true }
}

/**
 * 获取意象文化内涵解读（DEMO 降级）
 *
 * 与后端 GET /api/culture/imagery/:imageName 返回结构对齐
 * 命中映射表则返回专属解读，否则返回通用回退解读
 */
export function getDemoCultureImagery(imageName: string): CultureImageryResponse {
    return {
        interpretation: DEMO_IMAGERY_MAP[imageName] ?? buildGenericImagery(imageName),
        cached: true,
    }
}

/**
 * 启动沉浸式投屏（DEMO 降级）
 *
 * 与后端 POST /api/culture/immersive/start 返回结构对齐
 * 创建新的投屏会话并缓存到模块级 Map
 */
export function startDemoImmersive(req: StartImmersiveBody): ImmersiveStartResponse {
    const state = buildDemoImmersiveState(
        req.poemId,
        req.slideIntervalSec ?? 8,
        req.narrationEnabled ?? true,
        req.bgmEnabled ?? false,
        'running',
    )
    DEMO_IMMERSIVE_SESSIONS.set(req.poemId, state)
    return { state, aiGenerated: true }
}

/**
 * 查询投屏状态（DEMO 降级）
 *
 * 与后端 GET /api/culture/immersive/:poemId/status 返回结构对齐
 * 返回缓存的投屏会话状态；若会话不存在，返回 idle 状态
 */
export function getDemoImmersiveStatus(poemId: string): ImmersiveStatusResponse {
    const existing = DEMO_IMMERSIVE_SESSIONS.get(poemId)
    if (existing) {
        // 模拟图片自动切换：根据时间间隔计算当前图片索引
        const elapsed = Date.now() - existing.startedAt
        const images = buildDemoImagesForPoem(poemId)
        const cycles = images.length > 0 ? Math.floor(elapsed / existing.slideIntervalMs) : 0
        const newIndex = images.length > 0 ? cycles % images.length : 0
        const updated: ImmersiveState = {
            ...existing,
            currentImageIndex: newIndex,
            updatedAt: Date.now(),
        }
        return { state: updated }
    }
    // 无会话则返回 idle 状态
    return {
        state: buildDemoImmersiveState(poemId, 8, false, false, 'idle'),
    }
}

/**
 * 停止投屏（DEMO 降级）
 *
 * 与后端 POST /api/culture/immersive/stop 返回结构对齐
 * 停止指定 poemId 的会话；若未传 poemId 则停止所有会话
 */
export function stopDemoImmersive(poemId?: string): ImmersiveStopResponse {
    if (poemId) {
        const existing = DEMO_IMMERSIVE_SESSIONS.get(poemId)
        if (existing) {
            const stopped: ImmersiveState = {
                ...existing,
                status: 'stopped',
                updatedAt: Date.now(),
            }
            DEMO_IMMERSIVE_SESSIONS.delete(poemId)
            return { state: stopped, aiGenerated: true }
        }
        // 会话不存在，返回 stopped 状态
        return {
            state: buildDemoImmersiveState(poemId, 8, false, false, 'stopped'),
            aiGenerated: true,
        }
    }
    // 未传 poemId，停止所有会话
    const stoppedCount = DEMO_IMMERSIVE_SESSIONS.size
    DEMO_IMMERSIVE_SESSIONS.clear()
    return { stoppedCount, aiGenerated: true }
}
