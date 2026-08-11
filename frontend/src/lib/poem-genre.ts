/**
 * 诗词题材解析工具
 * ------------------------------------------------------------
 * 职责：把一首诗归入 6 个「体裁色系」之一，并给出可展示给师生的题材标签。
 *
 * 【为什么重写】
 * 旧实现用标题/正文的关键字**子串匹配**来猜体裁，实测产出大量错误标签：
 *   《元日》     → 送别（因正文含"春风**送**暖"）
 *   《暮江吟》   → 边塞（因正文含"月似**弓**"）
 *   《望天门山》 → 边塞（因正文含"日**边**来"）
 *   《闻官军收河南河北》→ 边塞（因正文含"**剑**外"）
 * 这是直接展示给小学师生的知识性内容，错标不可接受。
 *
 * 【现在的口径】
 * 数据库 poems.theme 存有教材人工校订的题材标签（64 个受控词表，如
 * "节庆"/"春景"/"咏物"/"边塞"），后端已随诗篇列表下发。因此：
 *   1. 徽章文案 = 该诗的**权威题材标签原文**（不再是被压扁的 6 选 1）；
 *   2. 徽章配色 = 题材标签按下表映射到 6 个色系 token（色系只是视觉分组）；
 *   3. 仅当某首诗确实没有题材数据时，才退回关键字启发式，并且该启发式
 *      只作用于色系（不产出文字标签），避免再次把猜测当作事实展示。
 *
 * 6 个色系 token：
 *   - landscape  山水  →  --c-genre-landscape  雾蓝  #5A8AA8
 *   - pastoral   田园  →  --c-genre-pastoral   苔绿  #5B8C5A
 *   - frontier   边塞  →  --c-genre-frontier   深赤陶 #C1554F
 *   - imagery    咏物  →  --c-genre-imagery    暖紫  #8B6FA8
 *   - farewell   送别  →  --c-genre-farewell   琥珀铜 #C5853B
 *   - nostalgia  抒怀  →  --c-genre-nostalgia  暖褐  #8B7355
 * ============================================================ */

/** 体裁色系联合类型 */
export type PoemGenre =
    | 'landscape'
    | 'pastoral'
    | 'frontier'
    | 'imagery'
    | 'farewell'
    | 'nostalgia'

/**
 * 色系中文标签
 *
 * 用于筛选下拉框与无题材数据时的兜底显示。
 * 注意 nostalgia 标为"抒怀"而非"思乡"——该色系聚合了思乡/怀人/咏怀/愁绪
 * 等一大类抒情题材，叫"思乡"会以偏概全。
 */
export const POEM_GENRE_LABEL: Record<PoemGenre, string> = {
    landscape: '山水',
    pastoral: '田园',
    frontier: '边塞',
    imagery: '咏物',
    farewell: '送别',
    nostalgia: '抒怀',
}

/**
 * 权威题材标签 → 色系映射表
 *
 * 覆盖 poems.theme 出现过的全部 64 个受控词。新增题材词时必须在此登记，
 * 未登记的词会落到 `nostalgia`（抒怀）这一最宽泛的抒情色系，并在 DEV 环境告警。
 */
const THEME_TO_GENRE: Readonly<Record<string, PoemGenre>> = {
    // ── 边塞：战事、戍边 ──
    边塞: 'frontier',
    征战: 'frontier',
    豪情: 'frontier',
    革命: 'frontier',

    // ── 送别：赠别、友朋 ──
    送别: 'farewell',
    友情: 'farewell',
    感恩: 'farewell',
    干谒: 'farewell',

    // ── 山水：自然景致、行旅、隐逸 ──
    山水: 'landscape',
    咏景: 'landscape',
    壮美: 'landscape',
    春景: 'landscape',
    夏景: 'landscape',
    秋景: 'landscape',
    冬景: 'landscape',
    晚景: 'landscape',
    西湖: 'landscape',
    登高: 'landscape',
    纪行: 'landscape',
    隐逸: 'landscape',
    禅意: 'landscape',

    // ── 田园：农事、民俗、童趣、时令 ──
    田园: 'pastoral',
    劳作: 'pastoral',
    悯农: 'pastoral',
    忧民: 'pastoral',
    童趣: 'pastoral',
    生活: 'pastoral',
    节令: 'pastoral',
    节庆: 'pastoral',
    春节: 'pastoral',
    清明: 'pastoral',
    重阳: 'pastoral',
    七夕: 'pastoral',

    // ── 咏物：托物言志、说理、讽喻、咏史 ──
    咏物: 'imagery',
    言志: 'imagery',
    哲理: 'imagery',
    劝勉: 'imagery',
    劝诫: 'imagery',
    读书: 'imagery',
    惜时: 'imagery',
    惜春: 'imagery',
    讽刺: 'imagery',
    讽谏: 'imagery',
    咏史: 'imagery',
    怀古: 'imagery',

    // ── 抒怀：乡思、亲情、愁绪、家国之感 ──
    思乡: 'nostalgia',
    思亲: 'nostalgia',
    思念: 'nostalgia',
    怀人: 'nostalgia',
    羁旅: 'nostalgia',
    孤寂: 'nostalgia',
    孤独: 'nostalgia',
    愁思: 'nostalgia',
    悲秋: 'nostalgia',
    感怀: 'nostalgia',
    咏怀: 'nostalgia',
    怀才不遇: 'nostalgia',
    宫怨: 'nostalgia',
    爱情: 'nostalgia',
    母爱: 'nostalgia',
    喜悦: 'nostalgia',
    爱国: 'nostalgia',
    忧国: 'nostalgia',
    临终: 'nostalgia',
}

/**
 * 关键字启发式（**仅在无题材数据时**用于推断色系）
 *
 * 相比旧实现有两点关键收敛：
 *   1. 只匹配**标题**，不再匹配正文——正文匹配正是错标的根源
 *      （"春风送暖"里的"送"、"月似弓"里的"弓"都出现在正文）；
 *   2. 结果只用于选色，不产出展示文案，绝不冒充权威题材标签。
 */
const TITLE_HINTS: ReadonlyArray<{ genre: PoemGenre; words: readonly string[] }> = [
    { genre: 'frontier', words: ['出塞', '从军', '凉州', '塞下', '军行', '战城南'] },
    { genre: 'farewell', words: ['送', '别', '赠', '留别', '饯'] },
    { genre: 'imagery', words: ['咏', '题', '画'] },
    { genre: 'landscape', words: ['望', '登', '游', '行', '宿', '泊'] },
]

/**
 * 由权威题材标签解析色系
 *
 * @param themes poems.theme 数组（可能为空）
 * @returns 命中的色系；无任何可识别标签时返回 null
 */
export function genreFromThemes(themes: readonly string[] | undefined | null): PoemGenre | null {
    if (!themes || themes.length === 0) return null
    for (const t of themes) {
        const hit = THEME_TO_GENRE[t]
        if (hit) return hit
    }
    // 有题材数据但词表未登记：归入最宽泛的抒怀色系，并在开发期提示补表
    if (import.meta.env.DEV) {
        console.warn(
            `[poem-genre] 题材词未登记到 THEME_TO_GENRE，已按「抒怀」着色：${themes.join('、')}。` +
            `请在 lib/poem-genre.ts 的映射表中补充。`,
        )
    }
    return 'nostalgia'
}

/**
 * 解析一首诗的题材展示信息
 *
 * @param poem 诗篇（theme 为后端下发的权威题材标签）
 * @returns genre 用于着色与筛选；label 用于徽章文案；authoritative 表示 label 是否来自权威数据
 */
export function resolvePoemTheme(poem: {
    title: string
    theme?: readonly string[] | null
}): { genre: PoemGenre; label: string; authoritative: boolean } {
    const fromTheme = genreFromThemes(poem.theme)
    if (fromTheme && poem.theme && poem.theme.length > 0) {
        return {
            genre: fromTheme,
            // 展示第一个题材标签原文——这是教材校订过的说法，不做二次加工
            label: poem.theme[0] as string,
            authoritative: true,
        }
    }

    // 无题材数据：只按标题线索选一个色系，文案退回宽泛的色系名
    const title = poem.title ?? ''
    for (const { genre, words } of TITLE_HINTS) {
        if (words.some((w) => title.includes(w))) {
            return { genre, label: POEM_GENRE_LABEL[genre], authoritative: false }
        }
    }
    return { genre: 'imagery', label: POEM_GENRE_LABEL.imagery, authoritative: false }
}

/**
 * 体裁 Tailwind 工具类静态映射
 * ------------------------------------------------------------
 * 关键约束：Tailwind JIT 扫描器只能识别源代码中作为字符串字面量出现的类名，
 * 完全动态的 `bg-${genre}/10` 不会被编译。
 * 因此这里将所有 6 个体裁 × 3 个透明度阶位的工具类以字面量形式列出，
 * 确保扫描器能识别并生成对应 CSS。
 */
export interface GenreBadgeClass {
    /** 标签常态：10% alpha 背景 + 100% 实色文字 */
    badge: string
    /** 选中态：20% alpha 背景 + 100% 实色文字 + 0.5px 内阴影 */
    selected: string
    /** 左侧竖线：100% 实色背景 */
    stripe: string
}

export const GENRE_BADGE_CLASS: Record<PoemGenre, GenreBadgeClass> = {
    landscape: {
        badge: 'bg-genre-landscape/10 text-genre-landscape',
        selected: 'bg-genre-landscape/20 text-genre-landscape',
        stripe: 'bg-genre-landscape',
    },
    pastoral: {
        badge: 'bg-genre-pastoral/10 text-genre-pastoral',
        selected: 'bg-genre-pastoral/20 text-genre-pastoral',
        stripe: 'bg-genre-pastoral',
    },
    frontier: {
        badge: 'bg-genre-frontier/10 text-genre-frontier',
        selected: 'bg-genre-frontier/20 text-genre-frontier',
        stripe: 'bg-genre-frontier',
    },
    imagery: {
        badge: 'bg-genre-imagery/10 text-genre-imagery',
        selected: 'bg-genre-imagery/20 text-genre-imagery',
        stripe: 'bg-genre-imagery',
    },
    farewell: {
        badge: 'bg-genre-farewell/10 text-genre-farewell',
        selected: 'bg-genre-farewell/20 text-genre-farewell',
        stripe: 'bg-genre-farewell',
    },
    nostalgia: {
        badge: 'bg-genre-nostalgia/10 text-genre-nostalgia',
        selected: 'bg-genre-nostalgia/20 text-genre-nostalgia',
        stripe: 'bg-genre-nostalgia',
    },
}
