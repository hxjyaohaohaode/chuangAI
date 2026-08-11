/**
 * 附件托盘 —— 输入框上方的已选附件条
 *
 * 三种状态都必须可辨（规范 12：颜色不能是唯一信息载体）：
 * - 处理中：旋转指示 + "处理中"文字
 * - 就绪：图片显缩略图，音频/文本显解析出的文字摘要
 * - 失败：明确写出失败原因，而不是一个红点
 *
 * 音频转写结果**必须可见**：把语音悄悄塞进上下文，用户无从核对
 * 转写是否准确，出了错也不知道错在哪一步。
 */

import { memo } from 'react'
import { Icon } from '@/components/ui'
import type { Attachment } from './useAttachments'

const KIND_ICON: Record<Attachment['kind'], string> = {
    image: 'image',
    audio: 'microphone',
    text: 'file-text',
}

const KIND_LABEL: Record<Attachment['kind'], string> = {
    image: '图片',
    audio: '语音',
    text: '文本',
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export const AttachmentTray = memo(function AttachmentTray({
    attachments,
    onRemove,
    onImagePreviewFailed,
}: {
    attachments: Attachment[]
    onRemove: (id: string) => void
    onImagePreviewFailed: (id: string) => void
}) {
    if (attachments.length === 0) return null

    return (
        <ul className="pr-copilot-attach-tray" aria-label="已添加的附件">
            {attachments.map((a) => (
                <li
                    key={a.id}
                    className={`pr-copilot-attach pr-copilot-attach--${a.status}`}
                >
                    {a.kind === 'image' && a.dataUrl && a.status !== 'failed' ? (
                        <img
                            className="pr-copilot-attach-thumb"
                            src={a.dataUrl}
                            alt=""
                            onError={() => onImagePreviewFailed(a.id)}
                        />
                    ) : (
                        <span
                            className={`pr-copilot-attach-icon${a.status === 'failed' ? ' pr-copilot-attach-icon--error' : ''}`}
                            {...(a.kind === 'image' && a.status === 'failed'
                                ? {
                                    role: 'status',
                                    'aria-live': 'polite' as const,
                                    'aria-label': `图片预览不可用：${a.name}`,
                                    title: '图片预览不可用，请移除后重新选择文件。',
                                }
                                : {})}
                        >
                            <Icon name={a.kind === 'image' && a.status === 'failed' ? 'warning-circle' : KIND_ICON[a.kind]} size={14} weight="duotone" />
                        </span>
                    )}

                    <span className="pr-copilot-attach-body">
                        <span className="pr-copilot-attach-name" title={a.name}>
                            {a.name}
                        </span>
                        <span className="pr-copilot-attach-meta">
                            {a.status === 'processing' && (
                                <>
                                    <Icon name="spinner" size={10} />
                                    {a.kind === 'audio' ? '转写中…' : '处理中…'}
                                </>
                            )}
                            {a.status === 'failed' && (
                                <span className="pr-copilot-attach-error">{a.error}</span>
                            )}
                            {a.status === 'ready' && (
                                <>
                                    {KIND_LABEL[a.kind]} · {formatSize(a.size)}
                                    {a.durationSec ? ` · ${Math.round(a.durationSec)}s` : ''}
                                </>
                            )}
                        </span>
                        {/* 语音/文本解析结果给出可核对的摘要——不做黑箱 */}
                        {a.status === 'ready' && a.kind !== 'image' && a.text && (
                            <span className="pr-copilot-attach-preview" title={a.text}>
                                {a.text.slice(0, 90)}
                                {a.text.length > 90 ? '…' : ''}
                            </span>
                        )}
                    </span>

                    <button
                        type="button"
                        className="pr-copilot-attach-remove"
                        onClick={() => onRemove(a.id)}
                        aria-label={`移除附件 ${a.name}`}
                    >
                        <Icon name="x" size={12} />
                    </button>
                </li>
            ))}
        </ul>
    )
})

export default AttachmentTray
