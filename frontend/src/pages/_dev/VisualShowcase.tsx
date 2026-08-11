/**
 * VisualShowcase —— 视觉创新层组件集中演示页（仅开发环境）
 *
 * 路由：/dev/visual（由 App.tsx 在 import.meta.env.DEV 下注册）
 * 集中展示 4 大视觉组件体系的全部子组件，供开发期调校与验收。
 *
 * 设计规范合规：暖调色板、无边框、流体间距、卡片用 surface-secondary + 圆角
 */

import { type CSSProperties } from 'react'
import {
    InkBrush,
    InkDivider,
    InkSplash,
    Seal,
    ScrollExpand,
    BambooSlip,
    FolioPage,
    CloudPattern,
    PoemScene,
    PoetryParticles,
    type InkBrushStyle,
    type PoetryParticleVariant,
} from '@/components/visual'

const POEMS = ['静夜思', '望庐山瀑布', '春晓', '使至塞上', '江雪', '相思', '登鹳雀楼', '敕勒歌'] as const
const BRUSH_STYLES: InkBrushStyle[] = ['zao', 'yun', 'ku', 'fei']
const BRUSH_LABELS: Record<InkBrushStyle, string> = {
    zao: '造笔（起笔）',
    yun: '晕染（浓淡）',
    ku: '枯笔（飞白）',
    fei: '飞白（收笔）',
}
const PARTICLE_VARIANTS: PoetryParticleVariant[] = ['petals', 'snow', 'fireflies', 'ink']
const PARTICLE_LABELS: Record<PoetryParticleVariant, string> = {
    petals: '花瓣飘落',
    snow: '雪花纷飞',
    fireflies: '萤火虫光点',
    ink: '墨点扩散',
}

const sectionStyle: CSSProperties = {
    position: 'relative',
    background: 'rgb(var(--c-surface-secondary) / 0.5)',
    backgroundImage: 'var(--noise-texture)',
    backgroundSize: '160px 160px',
    borderRadius: 'var(--radius-lg)',
    padding: 'var(--space-xl)',
    marginBottom: 'var(--space-xl)',
    overflow: 'hidden',
}

const sectionTitleStyle: CSSProperties = {
    fontFamily: 'var(--font-display)',
    fontSize: 'var(--text-2xl)',
    fontWeight: 600,
    color: 'rgb(var(--c-text-primary))',
    marginBottom: 'var(--space-lg)',
    fontVariationSettings: 'var(--font-display-variation)',
}

const labelStyle: CSSProperties = {
    fontSize: 'var(--text-sm)',
    color: 'rgb(var(--c-text-secondary))',
    marginBottom: 'var(--space-sm)',
    fontWeight: 500,
}

const rowStyle: CSSProperties = {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 'var(--space-lg)',
    alignItems: 'flex-start',
}

const itemStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-sm)',
}

const gridStyle: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
    gap: 'var(--space-lg)',
}

const stageStyle: CSSProperties = {
    position: 'relative',
    height: 200,
    borderRadius: 'var(--radius-md)',
    background: 'rgb(var(--c-surface-tertiary) / 0.4)',
    overflow: 'hidden',
}

export default function VisualShowcase() {
    return (
        <div
            style={{
                maxWidth: 'var(--app-max-width)',
                margin: '0 auto',
                padding: 'var(--space-2xl) var(--space-lg)',
            }}
        >
            <header style={{ marginBottom: 'var(--space-2xl)' }}>
                <h1
                    style={{
                        fontFamily: 'var(--font-display)',
                        fontSize: 'var(--text-3xl)',
                        fontWeight: 700,
                        color: 'rgb(var(--c-text-primary))',
                        fontVariationSettings: 'var(--font-display-variation)',
                        margin: 0,
                    }}
                >
                    视觉创新层组件展示
                </h1>
                <p style={{ color: 'rgb(var(--c-text-secondary))', fontSize: 'var(--text-base)', marginTop: 'var(--space-sm)' }}>
                    水墨笔触 · 古典符号 · 诗意境插画 · 流体粒子
                </p>
                <div style={{ marginTop: 'var(--space-lg)' }}>
                    <InkDivider center animated />
                </div>
            </header>

            {/* ============ 1. 水墨笔触 ============ */}
            <section style={sectionStyle}>
                <InkSplash blobs={3} dots={10} />
                <h2 style={{ ...sectionTitleStyle, position: 'relative', zIndex: 1 }}>一、水墨笔触动画</h2>

                <div style={{ ...rowStyle, position: 'relative', zIndex: 1, marginBottom: 'var(--space-xl)' }}>
                    {BRUSH_STYLES.map((s) => (
                        <div style={itemStyle} key={s}>
                            <span style={labelStyle}>{BRUSH_LABELS[s]}</span>
                            <InkBrush text="诗韵" brushStyle={s} fontSize={40} duration={600} />
                        </div>
                    ))}
                </div>

                <div style={{ ...itemStyle, position: 'relative', zIndex: 1, marginBottom: 'var(--space-xl)' }}>
                    <span style={labelStyle}>长句书写 · 床前明月光</span>
                    <InkBrush text="床前明月光，疑是地上霜。" fontSize={28} duration={420} stagger={80} />
                </div>

                <div style={{ ...itemStyle, position: 'relative', zIndex: 1 }}>
                    <span style={labelStyle}>水墨分割线（居中收束）</span>
                    <InkDivider center animated />
                </div>
            </section>

            {/* ============ 2. 古典文化符号 ============ */}
            <section style={sectionStyle}>
                <h2 style={sectionTitleStyle}>二、古典文化符号</h2>

                <div style={{ ...rowStyle, marginBottom: 'var(--space-xl)' }}>
                    <div style={itemStyle}>
                        <span style={labelStyle}>朱砂印章 · 方形</span>
                        <div style={rowStyle}>
                            <Seal stamp="已阅" shape="square" size={56} />
                            <Seal stamp="诗韵" shape="square" size={56} />
                            <Seal stamp="甲等" shape="square" size={56} />
                        </div>
                    </div>
                    <div style={itemStyle}>
                        <span style={labelStyle}>朱砂印章 · 圆形</span>
                        <div style={rowStyle}>
                            <Seal stamp="阅" shape="round" size={56} />
                            <Seal stamp="优" shape="round" size={56} />
                        </div>
                    </div>
                </div>

                <div style={{ ...itemStyle, marginBottom: 'var(--space-xl)' }}>
                    <span style={labelStyle}>折扇展开容器</span>
                    <ScrollExpand duration={500}>
                        <div
                            style={{
                                padding: 'var(--space-lg)',
                                background: 'rgb(var(--c-accent-primary) / 0.06)',
                                borderRadius: 'var(--radius-sm)',
                                color: 'rgb(var(--c-text-primary))',
                                fontSize: 'var(--text-lg)',
                                fontFamily: 'var(--font-serif-italic)',
                            }}
                        >
                            折扇展开 —— 内容从中心向两侧铺陈
                        </div>
                    </ScrollExpand>
                </div>

                <div style={{ ...itemStyle, marginBottom: 'var(--space-xl)' }}>
                    <span style={labelStyle}>竹简表序容器</span>
                    <BambooSlip lines={['床前明月光', '疑是地上霜', '举头望明月', '低头思故乡']} />
                </div>

                <div style={{ ...itemStyle, marginBottom: 'var(--space-xl)' }}>
                    <span style={labelStyle}>册页卷帙容器（带装订线）</span>
                    <FolioPage>
                        <p style={{ color: 'rgb(var(--c-text-primary))', fontSize: 'var(--text-base)', lineHeight: 'var(--leading-lg)' }}>
                            册页装帧 —— 左侧打孔穿线，模拟古籍册页形制，适用于长文阅读与报告呈现。
                        </p>
                    </FolioPage>
                </div>

                <div style={itemStyle}>
                    <span style={labelStyle}>云纹装饰边框</span>
                    <CloudPattern>
                        <div
                            style={{
                                padding: 'var(--space-xl)',
                                color: 'rgb(var(--c-text-secondary))',
                                fontSize: 'var(--text-base)',
                                textAlign: 'center' as const,
                            }}
                        >
                            如意云纹环绕 —— 上下云纹带 + 左右点缀
                        </div>
                    </CloudPattern>
                </div>
            </section>

            {/* ============ 3. 诗意境插画 ============ */}
            <section style={sectionStyle}>
                <h2 style={sectionTitleStyle}>三、诗词意境 SVG 插画</h2>
                <div style={gridStyle}>
                    {POEMS.map((poem) => (
                        <div style={itemStyle} key={poem}>
                            <PoemScene poem={poem} size="md" />
                            <span style={{ ...labelStyle, textAlign: 'center' as const }}>《{poem}》</span>
                        </div>
                    ))}
                </div>

                <div style={{ ...itemStyle, marginTop: 'var(--space-xl)' }}>
                    <span style={labelStyle}>三档尺寸 · sm(64) / md(128) / lg(256)</span>
                    <div style={{ ...rowStyle, alignItems: 'flex-end' }}>
                        <PoemScene poem="江雪" size="sm" />
                        <PoemScene poem="江雪" size="md" />
                        <PoemScene poem="江雪" size="lg" />
                    </div>
                </div>
            </section>

            {/* ============ 4. 流体诗意粒子 ============ */}
            <section style={sectionStyle}>
                <h2 style={sectionTitleStyle}>四、流体诗意粒子</h2>
                <div style={gridStyle}>
                    {PARTICLE_VARIANTS.map((v) => (
                        <div style={itemStyle} key={v}>
                            <span style={labelStyle}>{PARTICLE_LABELS[v]}</span>
                            <div style={stageStyle}>
                                <PoetryParticles variant={v} count={18} />
                            </div>
                        </div>
                    ))}
                </div>
            </section>
        </div>
    )
}
