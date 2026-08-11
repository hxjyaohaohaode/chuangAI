/**
 * 视觉创新层统一出口（视觉创新层 4 大组件体系）
 *
 * 导出清单：
 * 1. InkBrush 水墨笔触动画 —— InkBrush / InkDivider / InkSplash
 * 2. ClassicalSymbols 古典文化符号 —— Seal / ScrollExpand / BambooSlip / FolioPage / CloudPattern
 * 3. PoemIllustrations 诗词意境插画 —— PoemScene（中文诗名直查 + 三档尺寸）
 * 4. PoetryParticles 流体诗意粒子 —— 4 主题（花瓣/雪花/萤火虫/墨点）
 *
 * 设计规范：全部 TypeScript + React 函数组件，严格遵守暖调色板/无边框/流体/动效规范
 */

// 1. 水墨笔触动画
export {
    InkBrush,
    InkDivider,
    InkSplash,
    type InkBrushProps,
    type InkDividerProps,
    type InkSplashProps,
    type InkBrushStyle,
} from './InkBrush'

// 2. 古典文化符号
export {
    Seal,
    ScrollExpand,
    BambooSlip,
    FolioPage,
    CloudPattern,
    type SealProps,
    type ScrollExpandProps,
    type BambooSlipProps,
    type FolioPageProps,
    type CloudPatternProps,
} from './ClassicalSymbols'

// 3. 诗词意境插画
export {
    PoemScene,
    getPoemSceneByName,
    POEM_NAME_SCENE_MAP,
    type PoemSceneProps,
    type PoemSceneSize,
    type PoemSceneType,
} from './PoemIllustrations'

// 4. 流体诗意粒子
export {
    PoetryParticles,
    type PoetryParticlesProps,
    type PoetryParticleVariant,
} from './PoetryParticles'
