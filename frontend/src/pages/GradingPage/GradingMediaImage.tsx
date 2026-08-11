/**
 * GradingMediaImage —— 评分工作流的可恢复图片渲染器
 *
 * 上传预览、识别结果、批改详情和答题图片堆都依赖同一类用户图片资源。
 * 浏览器原生 <img> 在对象 URL 被回收、鉴权过期、网络中断或媒体损坏时只会留下
 * 空白/破图；这里统一把该失败转换为可见、可被读屏识别的非空终态。
 *
 * 这不是重试或数据修复机制：它不伪造原图可用，也不把图片内容当作已验证事实。
 * 用户仍可使用页面既有删除、重新上传或重新进入详情路径恢复业务流程。
 */

import { useState } from 'react'
import { Icon } from '@/components/ui'

interface GradingMediaImageProps {
    /** 图片资源地址：对象 URL、受保护接口地址或已持久化媒体地址。 */
    src: string
    /** 必须提供语义化替代文本，失败态会将其保留在无障碍名称中。 */
    alt: string
    /** 沿用原 <img> 的样式钩子。 */
    className?: string
    /** 原生图片加载优先级。 */
    loading?: 'eager' | 'lazy'
    /** 可选、场景化的恢复提示；只解释下一步，不声称图片已恢复。 */
    fallbackHint?: string
}

export function GradingMediaImage({
    src,
    alt,
    className,
    loading = 'lazy',
    fallbackHint,
}: GradingMediaImageProps) {
    // 将失败与资源 URL 绑定。资源地址变化时，新资源立即获得一次独立加载机会，
    // 不会被上一张图的失败状态永久污染。
    const [failedSource, setFailedSource] = useState<string | null>(null)
    const isFailed = failedSource === src
    const accessibleAlt = alt.trim() || '未命名图片'

    if (isFailed) {
        return (
            <span
                className={`pr-grading-media-image-fallback${className ? ` ${className}` : ''}`}
                role="status"
                aria-live="polite"
                aria-label={`图片暂不可用：${accessibleAlt}`}
            >
                <Icon name="warning-circle" size={20} aria-hidden={true} />
                <span className="pr-grading-media-image-fallback__message" aria-hidden="true">图片暂不可用</span>
                {fallbackHint && <span className="pr-grading-media-image-fallback__hint" aria-hidden="true">{fallbackHint}</span>}
            </span>
        )
    }

    return (
        <img
            className={className}
            src={src}
            alt={alt}
            loading={loading}
            onError={() => setFailedSource(src)}
        />
    )
}
