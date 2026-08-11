import type { PoemContent } from '@/lib/types'
import { cn } from '@/lib/cn'
import { Icon } from './Icon'
import './PoemVerification.css'

type SourceVerification = PoemContent['sourceVerification']

function statusLabel(verification: SourceVerification): string {
    switch (verification.status) {
        case 'VERIFIED':
            return '原文已完成逐首验收'
        case 'STALE':
            return '原文复核已失效'
        case 'INCOMPLETE':
            return '原文复核记录不完整'
        default:
            return '原文待逐首复核'
    }
}

function scopeLabel(scope: SourceVerification['catalogScope']): string | null {
    if (scope === 'TEXTBOOK_CORE') return '教材核心篇目'
    if (scope === 'EXTENDED') return '拓展篇目'
    return null
}

interface PoemVerificationStatusBadgeProps {
    verification: SourceVerification
    className?: string
}

/**
 * 用于空间受限的课堂头部。完整的验收依据由 PoemVerificationDisclosure 展示；
 * 此处仍把完整状态说明写入可访问名称，避免视觉压缩后丢失事实边界。
 */
export function PoemVerificationStatusBadge({
    verification,
    className,
}: PoemVerificationStatusBadgeProps) {
    const verified = verification.status === 'VERIFIED'
    return (
        <span
            className={cn(
                'pr-poem-verification-badge',
                verified ? 'pr-poem-verification-badge--verified' : 'pr-poem-verification-badge--pending',
                className,
            )}
            title={verification.message}
            aria-label={`原文验收状态：${statusLabel(verification)}。${verification.message}`}
        >
            <Icon name={verified ? 'shield-check' : 'warning-circle'} size={12} />
            {statusLabel(verification)}
        </span>
    )
}

interface PoemVerificationDisclosureProps {
    verification: SourceVerification
    className?: string
}

/**
 * 逐首内容证据的可展开说明。
 *
 * 非 VERIFIED 记录默认展开，确保用户不需要悬停或猜测即可得知内容边界；
 * 不展示验收人的线下证据位置，防止把匿名验收资料带入学生端页面。
 */
export function PoemVerificationDisclosure({
    verification,
    className,
}: PoemVerificationDisclosureProps) {
    const verified = verification.status === 'VERIFIED'
    const scope = scopeLabel(verification.catalogScope)

    return (
        <details
            className={cn(
                'pr-poem-verification',
                verified ? 'pr-poem-verification--verified' : 'pr-poem-verification--pending',
                className,
            )}
            data-poem-verification-state={verification.status}
            open={!verified}
        >
            <summary className="pr-poem-verification-summary">
                <span className="pr-poem-verification-summary-icon" aria-hidden>
                    <Icon name={verified ? 'shield-check' : 'warning-circle'} size={16} />
                </span>
                <span className="pr-poem-verification-summary-copy">
                    <span className="pr-poem-verification-eyebrow">内容验收与来源</span>
                    <span className="pr-poem-verification-title">{statusLabel(verification)}</span>
                </span>
                <Icon name="caret-down" size={16} className="pr-poem-verification-caret" aria-hidden />
            </summary>

            <div className="pr-poem-verification-body">
                <p className="pr-poem-verification-message">{verification.message}</p>
                <dl className="pr-poem-verification-facts">
                    <div>
                        <dt>篇目范围</dt>
                        <dd>{scope ?? '尚未分类，不能按教材核心篇目使用'}</dd>
                    </div>
                    <div>
                        <dt>原文复核</dt>
                        <dd>{verification.reviewedAt ? `已登记于 ${verification.reviewedAt}` : '尚未完成教师验收'}</dd>
                    </div>
                    <div>
                        <dt>来源登记</dt>
                        <dd>
                            {verification.sourceTitles.length > 0 ? (
                                <ul>
                                    {verification.sourceTitles.map((title, index) => <li key={`${title}-${index}`}>{title}</li>)}
                                </ul>
                            ) : '尚未登记独立信源'}
                        </dd>
                    </div>
                </dl>
                <p className="pr-poem-verification-boundary">
                    {verified
                        ? '本状态仅说明诗文原文已经验收；拼音、译文、生字与讲解等 AI 教学内容仍需教师结合课堂实际复核。'
                        : '当前内容可用于系统体验与教师预览，不得作为已验证教材原文、教材核心覆盖或真实教学成效的依据。'}
                </p>
            </div>
        </details>
    )
}
