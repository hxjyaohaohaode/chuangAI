/**
 * Error Boundary 错误边界（规范第 7 章 交互模式 + v5.0 Task C.1.1）
 *
 * 组件级错误捕获 + 优雅降级。
 * - 友好的错误信息 + 重试按钮
 * - 不暴露技术细节给用户
 * - 开发环境展示堆栈（便于调试），生产环境仅展示友好提示
 * - v5.0：新增 SectionErrorBoundary 便捷包装 + SectionFallback 紧凑型兜底，
 *   专为局部组件级场景（图表 / AI 输出 / 表单 / 面板）设计，撑场不空白
 *
 * 用法：
 *   <ErrorBoundary>
 *     <MyComponent />
 *   </ErrorBoundary>
 *
 *   <ErrorBoundary fallback={<CustomFallback />}>
 *     <FlakyChart />
 *   </ErrorBoundary>
 *
 *   // 局部场景便捷用法（紧凑兜底 UI，适合嵌入卡片/面板内部）
 *   <SectionErrorBoundary>
 *     <BloomRadarChart />
 *   </SectionErrorBoundary>
 */

import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { Icon } from './Icon'

export interface ErrorBoundaryProps {
    children: ReactNode
    /** 自定义降级 UI */
    fallback?: (error: Error, retry: () => void) => ReactNode
    /** 错误回调（上报 / 日志） */
    onError?: (error: Error, info: ErrorInfo) => void
    /** 重置 keys（变化时自动重置），例如路由切换时恢复 */
    resetKeys?: Array<unknown>
}

interface ErrorBoundaryState {
    error: Error | null
}

function didResetKeysChange(previous: Array<unknown> | undefined, next: Array<unknown> | undefined): boolean {
    const previousKeys = previous ?? []
    const nextKeys = next ?? []
    return previousKeys.length !== nextKeys.length
        || previousKeys.some((key, index) => !Object.is(key, nextKeys[index]))
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
    state: ErrorBoundaryState = { error: null }

    static getDerivedStateFromError(error: Error): ErrorBoundaryState {
        return { error }
    }

    override componentDidCatch(error: Error, info: ErrorInfo): void {
        if (this.props.onError) {
            this.props.onError(error, info)
        }
        // 开发环境控制台输出，便于调试
        if (import.meta.env.DEV) {
            console.error('[ErrorBoundary] 捕获错误:', error, info)
        }
    }

    override componentDidUpdate(prevProps: ErrorBoundaryProps): void {
        // resetKeys 变化时清除错误态（例如路由切换）
        if (this.state.error && didResetKeysChange(prevProps.resetKeys, this.props.resetKeys)) {
            this.setState({ error: null })
        }
    }

    retry = (): void => {
        this.setState({ error: null })
    }

    override render(): ReactNode {
        const { error } = this.state
        if (!error) return this.props.children

        if (this.props.fallback) {
            return this.props.fallback(error, this.retry)
        }

        return <DefaultFallback onRetry={this.retry} />
    }
}

/* ============================================================
 * 默认降级 UI（页面级 —— 撑满整屏，适合整页崩溃）
 * ============================================================ */

function DefaultFallback({ onRetry }: { onRetry: () => void }) {
    return (
        <div className="pr-error-boundary" role="alert">
            <div className="pr-error-boundary-icon">
                <Icon name="warning-circle" size={32} weight="bold" />
            </div>
            <div className="pr-error-boundary-title">这块内容暂时无法显示</div>
            <div className="pr-error-boundary-desc">
                可能是网络波动或数据加载异常，请稍后重试
            </div>
            <button
                type="button"
                className="pr-error-boundary-retry"
                onClick={onRetry}
            >
                <Icon name="arrows-clockwise" size={14} />
                <span>重新加载</span>
            </button>
        </div>
    )
}

/* ============================================================
 * 局部降级 UI（v5.0 Task C.1.1 —— 紧凑型，撑场不空白）
 *
 * 设计要点：
 *  - 紧凑布局（min-height 160px），适合嵌入卡片 / 面板 / 列内部
 *  - 不使用大圆背景，使用 inline 图标 + 文案 + 重试链接
 *  - 暖调色板，零 emoji，零硬边框
 *  - 图标使用 warning-circle（与页面级一致，但尺寸更小）
 *  - 重试以"链接"形式呈现（更轻量），避免在卡片内抢占视觉重量
 * ============================================================ */

export interface SectionFallbackProps {
    /** 重试回调 */
    onRetry: () => void
    /** 自定义标题（如"图表加载失败"/"AI 响应异常"），缺省"局部内容加载失败" */
    title?: string
    /** 自定义描述文案 */
    description?: string
}

export function SectionFallback({
    onRetry,
    title = '局部内容加载失败',
    description = '该模块暂不可用，可尝试重新加载',
}: SectionFallbackProps) {
    return (
        <div className="pr-error-section" role="alert">
            <Icon name="warning-circle" size={20} weight="bold" className="pr-error-section-icon" />
            <div className="pr-error-section-body">
                <div className="pr-error-section-title">{title}</div>
                <div className="pr-error-section-desc">{description}</div>
            </div>
            <button
                type="button"
                className="pr-error-section-retry"
                onClick={onRetry}
            >
                <Icon name="arrows-clockwise" size={12} />
                <span>重试</span>
            </button>
        </div>
    )
}

/* ============================================================
 * SectionErrorBoundary —— 局部组件级错误边界便捷包装
 *
 * 预设使用 SectionFallback，仍支持 onError / resetKeys / 自定义 fallback。
 * 专为图表 / AI 输出 / 表单 / 面板等局部场景设计。
 *
 * 用法：
 *   <SectionErrorBoundary title="六阶能力雷达加载失败">
 *     <BloomRadarChart />
 *   </SectionErrorBoundary>
 * ============================================================ */

export interface SectionErrorBoundaryProps {
    children: ReactNode
    /** 错误回调（上报 / 日志） */
    onError?: (error: Error, info: ErrorInfo) => void
    /** 重置 keys（变化时自动重置），例如班级切换时恢复 */
    resetKeys?: Array<unknown>
    /** 传给 SectionFallback 的标题 */
    title?: string
    /** 传给 SectionFallback 的描述 */
    description?: string
    /** 完全自定义兜底 UI（覆盖 SectionFallback） */
    fallback?: (error: Error, retry: () => void) => ReactNode
}

export class SectionErrorBoundary extends Component<SectionErrorBoundaryProps, ErrorBoundaryState> {
    state: ErrorBoundaryState = { error: null }

    static getDerivedStateFromError(error: Error): ErrorBoundaryState {
        return { error }
    }

    override componentDidCatch(error: Error, info: ErrorInfo): void {
        if (this.props.onError) {
            this.props.onError(error, info)
        }
        if (import.meta.env.DEV) {
            // eslint-disable-next-line no-console
            console.error('[SectionErrorBoundary] 捕获错误:', error, info)
        }
    }

    override componentDidUpdate(prevProps: SectionErrorBoundaryProps): void {
        if (this.state.error && didResetKeysChange(prevProps.resetKeys, this.props.resetKeys)) {
            this.setState({ error: null })
        }
    }

    retry = (): void => {
        this.setState({ error: null })
    }

    override render(): ReactNode {
        const { error } = this.state
        if (!error) return this.props.children

        if (this.props.fallback) {
            return this.props.fallback(error, this.retry)
        }

        return (
            <SectionFallback
                onRetry={this.retry}
                title={this.props.title}
                description={this.props.description}
            />
        )
    }
}
