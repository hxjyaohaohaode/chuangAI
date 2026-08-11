/**
 * AI 副驾附件处理
 *
 * ─────────────────────────────────────────────────────────────
 * 支持哪些文件，以及为什么只支持这些
 * ─────────────────────────────────────────────────────────────
 * 附件能做什么，完全由**可用模型的能力**决定，不由界面想象力决定。
 * 依据《大模型API文档.md》：
 *
 * - 图片 → mimo-v2.5（文档明确：唯一的多模态模型）
 *          本地压缩为 data URL 直接随对话发出，由服务端强制路由到该模型。
 * - 音频 → mimo-v2.5-asr 先转写成文字，再进入正常对话。
 *          转写结果对用户可见可编辑，不做"黑箱塞进上下文"。
 * - 纯文本类文件（txt/md/csv/json/log）→ 直接读成文本内容附在消息里。
 *
 * - **视频不支持**。deepseek 全系与 mimo 全系都没有视频理解能力，
 *   wan2.7 只做生图。与其假装能收视频、再悄悄丢掉，不如明确拒绝并说明原因。
 * - PDF / Word 等二进制文档同理：没有可用的解析模型，不做假支持。
 *
 * ─────────────────────────────────────────────────────────────
 * 图片为什么要在前端压缩
 * ─────────────────────────────────────────────────────────────
 * 手机拍的照片动辄 4000×3000、5MB 以上，base64 后膨胀 33%。
 * 直接发出去既会撞上请求体上限，也会让首字延迟高得离谱。
 * 视觉模型对 1600px 以上的边长几乎没有额外收益，因此统一缩到长边 1600
 * 并转 JPEG（质量 0.82）——实测 5MB 的照片能压到 200KB 上下。
 */

import { useCallback, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { getDisplayError } from '@/lib/errors'
import type { AiContentPart } from '@/lib/types'

/** 图片长边上限（px）。视觉模型再大也基本无增益，纯属浪费带宽与延迟 */
const MAX_IMAGE_EDGE = 1600
/** JPEG 压缩质量 */
const IMAGE_QUALITY = 0.82
/** 单次对话最多带几个附件（后端 schema 限制 12 个片段，留出文本片段余量） */
export const MAX_ATTACHMENTS = 6
/** 文本类文件的读取上限，超出截断（避免一个日志文件吃满上下文） */
const MAX_TEXT_CHARS = 20_000

export type AttachmentKind = 'image' | 'audio' | 'text'
export type AttachmentStatus = 'processing' | 'ready' | 'failed'

export interface Attachment {
    id: string
    kind: AttachmentKind
    name: string
    /** 原始文件字节数（展示用） */
    size: number
    status: AttachmentStatus
    /** 失败原因（status='failed' 时有值） */
    error?: string
    /** 图片：压缩后的 data URL，同时用作缩略图与发给模型的内容 */
    dataUrl?: string
    /** 音频：ASR 转写结果；文本文件：文件内容 */
    text?: string
    /** 音频时长（秒），由 ASR 返回 */
    durationSec?: number
}

/** 判定文件属于哪一类，不认识的返回 null 并由调用方给出明确拒绝理由 */
function classify(file: File): AttachmentKind | null {
    const type = file.type.toLowerCase()
    const name = file.name.toLowerCase()
    if (type.startsWith('image/')) return 'image'
    if (type.startsWith('audio/')) return 'audio'
    if (
        type.startsWith('text/') ||
        type === 'application/json' ||
        /\.(txt|md|markdown|csv|json|log|ya?ml)$/.test(name)
    ) {
        return 'text'
    }
    return null
}

/** 不受支持的文件：给出**具体**原因，而不是一句"不支持" */
function rejectReason(file: File): string {
    const type = file.type.toLowerCase()
    if (type.startsWith('video/')) {
        return '当前可用的 deepseek 与 mimo 系列模型都不具备视频理解能力，无法处理视频文件'
    }
    if (type === 'application/pdf') {
        return 'PDF 需要文档解析能力，当前模型集合中没有可用的解析模型；可先复制文字内容再发送'
    }
    if (/officedocument|msword|ms-excel/.test(type)) {
        return 'Office 文档需要文档解析能力，当前模型集合中没有可用的解析模型；可先复制文字内容再发送'
    }
    return `不支持的文件类型（${file.type || '未知'}）。可发送图片、音频，或 txt/md/csv/json 等纯文本文件`
}

/**
 * 图片压缩为 data URL
 *
 * 用 canvas 重绘而不是直接 FileReader：后者只会把原始大图原样 base64，
 * 体积和延迟都无法接受。
 */
async function compressImage(file: File): Promise<string> {
    const bitmap = await createImageBitmap(file)
    try {
        const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height))
        const w = Math.max(1, Math.round(bitmap.width * scale))
        const h = Math.max(1, Math.round(bitmap.height * scale))

        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('浏览器不支持 canvas 2D，无法压缩图片')
        // 透明 PNG 转 JPEG 会变黑底，先铺白底
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, w, h)
        ctx.drawImage(bitmap, 0, 0, w, h)
        return canvas.toDataURL('image/jpeg', IMAGE_QUALITY)
    } finally {
        bitmap.close()
    }
}

export interface UseAttachmentsResult {
    attachments: Attachment[]
    /** 是否还有附件在处理中（转写/压缩），此时不应允许发送 */
    processing: boolean
    addFiles: (files: FileList | File[]) => void
    /** 缩略图实际解码失败时失败关闭，避免把无法在当前浏览器呈现的同一附件静默交给模型。 */
    markImagePreviewFailed: (id: string) => void
    remove: (id: string) => void
    clear: () => void
    /**
     * 构造发送用的多模态内容
     *
     * 返回 null 表示「没有附件」，调用方直接发纯字符串即可——
     * 纯文本对话没必要退化成片段数组，那会让后端多走一遍多模态判定。
     */
    buildContent: (text: string) => string | AiContentPart[]
}

export function useAttachments(
    onError?: (title: string, message: string) => void,
): UseAttachmentsResult {
    const [attachments, setAttachments] = useState<Attachment[]>([])
    const seq = useRef(0)

    const update = useCallback((id: string, patch: Partial<Attachment>) => {
        setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)))
    }, [])

    const addFiles = useCallback(
        (files: FileList | File[]) => {
            const list = Array.from(files)
            setAttachments((prev) => {
                const room = MAX_ATTACHMENTS - prev.length
                if (room <= 0) {
                    onError?.('附件数量已达上限', `单次最多携带 ${MAX_ATTACHMENTS} 个附件`)
                    return prev
                }
                const accepted: Attachment[] = []
                for (const file of list.slice(0, room)) {
                    const kind = classify(file)
                    if (!kind) {
                        onError?.(`无法添加「${file.name}」`, rejectReason(file))
                        continue
                    }
                    const id = `att-${Date.now()}-${seq.current++}`
                    accepted.push({
                        id,
                        kind,
                        name: file.name,
                        size: file.size,
                        status: 'processing',
                    })

                    // 处理放在微任务里，先让占位 chip 立刻出现，避免"点了没反应"
                    void (async () => {
                        try {
                            if (kind === 'image') {
                                const dataUrl = await compressImage(file)
                                update(id, { status: 'ready', dataUrl })
                            } else if (kind === 'audio') {
                                const res = await api.ai.asr(file, {}, file.name)
                                if (res.degraded) {
                                    update(id, {
                                        status: 'failed',
                                        error: `当前未调用 ${res.requestedModel}，演示/降级状态不会伪造语音转写`,
                                    })
                                    return
                                }
                                const text = (res.transcript ?? '').trim()
                                if (!text) {
                                    update(id, {
                                        status: 'failed',
                                        error: '未能从音频中识别出文字，请确认音频清晰且为中文/英文语音',
                                    })
                                    return
                                }
                                update(id, {
                                    status: 'ready',
                                    text,
                                    durationSec: res.audioDurationSec,
                                })
                            } else {
                                const raw = await file.text()
                                const text = raw.length > MAX_TEXT_CHARS
                                    ? `${raw.slice(0, MAX_TEXT_CHARS)}\n…（文件过长，已截断至前 ${MAX_TEXT_CHARS} 字）`
                                    : raw
                                update(id, { status: 'ready', text })
                            }
                        } catch (err) {
                            update(id, {
                                status: 'failed',
                                error: getDisplayError(err, '处理失败'),
                            })
                        }
                    })()
                }
                return [...prev, ...accepted]
            })
        },
        [onError, update],
    )

    const remove = useCallback((id: string) => {
        setAttachments((prev) => prev.filter((a) => a.id !== id))
    }, [])

    const markImagePreviewFailed = useCallback((id: string) => {
        setAttachments((prev) => prev.map((attachment) => {
            // 只允许已就绪的图片进入该失败路径，避免覆盖压缩/转写中的真实状态，
            // 也避免同一个 onError 重复触发时制造无意义的重新渲染。
            if (attachment.id !== id || attachment.kind !== 'image' || attachment.status !== 'ready') {
                return attachment
            }
            return {
                ...attachment,
                status: 'failed',
                error: '图片预览不可用，附件不会发送给模型。请移除后重新选择文件。',
            }
        }))
    }, [])

    const clear = useCallback(() => setAttachments([]), [])

    const buildContent = useCallback(
        (text: string): string | AiContentPart[] => {
            const ready = attachments.filter((a) => a.status === 'ready')
            if (ready.length === 0) return text

            const parts: AiContentPart[] = []

            // 文本类与音频转写并入正文，并标注来源——
            // 让模型和用户都清楚"这段话是从哪来的"
            const textBlocks = ready
                .filter((a) => a.kind !== 'image' && a.text)
                .map((a) =>
                    a.kind === 'audio'
                        ? `［语音转写 · ${a.name}］\n${a.text}`
                        : `［文件 · ${a.name}］\n${a.text}`,
                )

            const merged = [text.trim(), ...textBlocks].filter(Boolean).join('\n\n')
            if (merged) parts.push({ type: 'text', text: merged })

            for (const img of ready.filter((a) => a.kind === 'image' && a.dataUrl)) {
                parts.push({ type: 'image_url', image_url: { url: img.dataUrl as string } })
            }

            return parts.length > 0 ? parts : text
        },
        [attachments],
    )

    return {
        attachments,
        processing: attachments.some((a) => a.status === 'processing'),
        addFiles,
        markImagePreviewFailed,
        remove,
        clear,
        buildContent,
    }
}
