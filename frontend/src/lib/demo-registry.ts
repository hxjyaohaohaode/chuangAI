/**
 * DEMO 数据惰性装载器
 *
 * ─────────────────────────────────────────────────────────────
 * 为什么需要它
 * ─────────────────────────────────────────────────────────────
 * `lib/api.ts` 原先**静态** import 了 8 个 demo-*.ts 模块（合计约 180KB 源码：
 * 整本教案模板、诗内容、文化背景包、朗读评估、错题本…）。api.ts 被各 store
 * 直接引用，于是这些数据全部进了首屏 index chunk——**每一个用户、每一次首屏
 * 都要下载一整套"后端挂了才会用到"的兜底数据**。
 *
 * 这些数据只在 DEMO 模式（后端不可达）下才被读取，属于典型的异常路径资源，
 * 因此改为按需 dynamic import，并在模块级缓存 Promise，保证：
 *   - 正常有后端时：一个字节都不加载；
 *   - 进入 DEMO 模式后：只在首次访问时加载一次，后续命中缓存。
 *
 * 用法：
 *   if (isDemoMode()) {
 *       const demo = await loadDemo()
 *       return demo.getDemoPoemContent(poemId)
 *   }
 */

/** 合并后的 DEMO 数据命名空间 */
export type DemoModules =
    & typeof import('./demo-poem-content')
    & typeof import('./demo-lesson-plan')
    & typeof import('./demo-error-notebook')
    & typeof import('./demo-teaching-suggestion')
    & typeof import('./demo-classroom-explain')
    & typeof import('./demo-appreciation-guide')
    & typeof import('./demo-recitation')
    & typeof import('./demo-culture')

/**
 * 缓存的加载 Promise
 *
 * 缓存的是 Promise 而不是结果：并发调用时只会触发一次网络加载，
 * 后续调用直接复用同一个 Promise，避免 DEMO 模式下多个面板同时初始化
 * 造成重复请求同一批 chunk。
 */
let cached: Promise<DemoModules> | null = null

/**
 * 加载全部 DEMO 数据模块
 *
 * 注意这里刻意一次性加载全部 8 个模块而非按需细分：进入 DEMO 模式意味着
 * 用户即将在多个页面间浏览兜底内容，逐个模块懒加载只会把一次等待拆成八次；
 * 而它们合计 gzip 后仅数十 KB，一次装载体验更连贯。
 */
export function loadDemo(): Promise<DemoModules> {
    if (!cached) {
        cached = Promise.all([
            import('./demo-poem-content'),
            import('./demo-lesson-plan'),
            import('./demo-error-notebook'),
            import('./demo-teaching-suggestion'),
            import('./demo-classroom-explain'),
            import('./demo-appreciation-guide'),
            import('./demo-recitation'),
            import('./demo-culture'),
        ]).then((mods) => Object.assign({}, ...mods) as DemoModules)
    }
    return cached
}
