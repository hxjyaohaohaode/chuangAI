/**
 * 剧本播放页（仅开发环境）
 *
 * 路由：/dev/scripts（由 App.tsx 在 import.meta.env.DEV 下注册）
 * 集中展示剧本矩阵与播放器，供开发期与评委预览。
 *
 * 访问方式：
 * - 开发环境直接访问 /dev/scripts
 * - 生产环境通过 URL 参数 ?scripts=1 激活（需 DEV=true）
 *
 * 设计规范合规：暖调色板、无边框、流体间距
 */

import { type CSSProperties } from 'react'
import { ScriptPlayer } from '@/components/dev'

const pageStyle: CSSProperties = {
    minHeight: 'calc(100vh - 56px)',
    padding: 'clamp(var(--space-lg), 4vw, var(--space-3xl))',
    background: 'rgb(var(--c-surface-primary))',
    backgroundImage: 'var(--noise-texture)',
    backgroundSize: '200px 200px',
}

const headerStyle: CSSProperties = {
    maxWidth: '880px',
    margin: '0 auto var(--space-xl)',
    textAlign: 'center',
}

const titleStyle: CSSProperties = {
    fontSize: 'var(--text-3xl)',
    fontWeight: 650,
    fontVariationSettings: "'wght' 650",
    color: 'rgb(var(--c-text-primary))',
    letterSpacing: '-0.03em',
    margin: '0 0 var(--space-sm)',
}

const descStyle: CSSProperties = {
    fontSize: 'var(--text-sm)',
    color: 'rgb(var(--c-text-secondary))',
    lineHeight: 1.6,
    margin: 0,
}

export default function ScriptsPage() {
    return (
        <div style={pageStyle}>
            <header style={headerStyle}>
                <h1 style={titleStyle}>剧本矩阵 · 一键演示</h1>
                <p style={descStyle}>
                    预置 6 部可一键播放的演示剧本，覆盖课堂沉浸、AI 诊断、创作批改、星图漫游、自进化、全流程贯通场景。
                    播放器自动执行路由跳转、数据预填与操作模拟。
                </p>
            </header>
            <ScriptPlayer />
        </div>
    )
}
