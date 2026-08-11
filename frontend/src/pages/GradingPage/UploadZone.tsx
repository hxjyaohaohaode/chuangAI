/**
 * UploadZone 上传区（SubTask 12.2）
 *
 * 三种上传方式：
 * 1. 拖拽上传 —— dragover/drop 事件，悬浮态高亮
 * 2. 点击上传 —— 隐藏 input + label 触发
 * 3. 粘贴上传 —— Ctrl+V 监听 paste 事件，提取剪贴板图片
 *
 * 文件限制：
 * - 类型：jpg/png/webp
 * - 单文件：≤10MB
 * - 单批次：≤30 张
 * - 单批次总量：≤80MB
 *
 * 设计要点：
 * - 上传后立即用 URL.createObjectURL 生成预览缩略图（120x120 网格）
 * - 未上传成功的本地预览可移除；后端批次建立后图片锁定，避免“只删 UI 不删业务数据”
 * - 上传中显示不确定态；后端未提供单文件字节进度时不伪造百分比
 * - "开始识别"主按钮（上传后才出现）
 */

import { memo, useCallback, useRef, useState, useEffect } from 'react'
import { Button, Icon } from '@/components/ui'
import { useGradingStore } from '@/stores/grading'
import { toast } from '@/stores/toast'
import { GradingMediaImage } from './GradingMediaImage'

/** 允许的图片 MIME 类型 */
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

/** 单文件最大 10MB */
const MAX_FILE_SIZE = 10 * 1024 * 1024

/** 单批次最大 30 张 */
const MAX_FILES_PER_BATCH = 30

/** 与后端一致的批次总量上限，前端先行提示，后端仍做最终校验。 */
const MAX_TOTAL_UPLOAD_SIZE = 80 * 1024 * 1024

/** 单文件上传状态 */
type FileUploadStatus = 'pending' | 'uploading' | 'done' | 'error'

/** 单文件预览项 */
interface PreviewItem {
    /** 本地预览 URL（URL.createObjectURL） */
    url: string
    /** 文件名 */
    name: string
    /** 文件大小（字节） */
    size: number
    /** 上传状态 */
    status: FileUploadStatus
    /** 唯一标识，用于 stable key */
    id: string
}

interface UploadZoneProps {
    /** 上传完成回调（可选） */
    onUploaded?: () => void
}

/** 生成稳定的 preview id（避免使用 index 作为 key） */
let previewIdCounter = 0
function nextPreviewId(): string {
    previewIdCounter += 1
    return `preview-${Date.now()}-${previewIdCounter}`
}

export const UploadZone = memo(function UploadZone({ onUploaded }: UploadZoneProps) {
    const inputRef = useRef<HTMLInputElement>(null)
    const [isDragging, setIsDragging] = useState(false)
    const [isUploading, setIsUploading] = useState(false)
    const [previews, setPreviews] = useState<PreviewItem[]>([])
    // 卸载清理必须读取最新预览集合。不能把 `previews` 放进仅执行一次的 effect
    // 闭包，否则首次渲染的空数组会导致遗留 blob: URL 在离开页面时无法回收。
    const previewsRef = useRef<PreviewItem[]>([])
    const mountedRef = useRef(true)
    const uploadInFlightRef = useRef(false)
    const uploadGenerationRef = useRef(0)
    const dragCounter = useRef(0)

    // 逐字段 selector：避免无关字段变化触发本组件重渲染（B3.2 优化）
    const files = useGradingStore((s) => s.files)
    const stage = useGradingStore((s) => s.stage)
    const loading = useGradingStore((s) => s.loading)
    const batchId = useGradingStore((s) => s.batchId)
    const resetEpoch = useGradingStore((s) => s.resetEpoch)
    const uploadFiles = useGradingStore((s) => s.uploadFiles)
    const recognize = useGradingStore((s) => s.recognize)
    const classId = useGradingStore((s) => s.classId)
    const questionId = useGradingStore((s) => s.questionId)
    const seenResetEpochRef = useRef(resetEpoch)

    useEffect(() => {
        previewsRef.current = previews
    }, [previews])

    /** 校验文件类型与大小 */
    const validateFile = useCallback((file: File): string | null => {
        if (!ALLOWED_TYPES.has(file.type)) {
            return `${file.name}：不支持的类型，仅允许 jpg/png/webp`
        }
        if (file.size > MAX_FILE_SIZE) {
            return `${file.name}：超过 10MB 限制`
        }
        return null
    }, [])

    /** 处理文件列表：校验 → 生成本地预览 → 上传（per-file 独立进度） */
    const handleFiles = useCallback(
        async (fileList: FileList | File[]) => {
            const incomingFiles = Array.from(fileList)

            if (incomingFiles.length === 0) return
            if (loading || uploadInFlightRef.current) {
                toast.warning({
                    title: '当前任务仍在处理',
                    message: '请等待本批上传或识别完成后再添加新图片，避免批次内容交叉。',
                })
                return
            }
            if (batchId || stage !== 'idle' || files.length > 0) {
                toast.warning({
                    title: '当前批次已锁定',
                    message: '已上传图片不能追加到另一批次；如需更换，请先点击“新建批次”。',
                })
                return
            }
            if (!classId || !questionId) {
                toast.warning({
                    title: '先确认批改对象',
                    message: '请选择班级、诗篇和题目后再上传，避免作业无法归档。',
                })
                return
            }

            // 校验
            const errors: string[] = []
            const valid: File[] = []
            for (const f of incomingFiles) {
                const err = validateFile(f)
                if (err) {
                    errors.push(err)
                } else {
                    valid.push(f)
                }
            }

            if (errors.length > 0) {
                toast.warning({
                    title: `${errors.length} 个文件被拒绝`,
                    message: errors.slice(0, 2).join('；') + (errors.length > 2 ? '...' : ''),
                })
            }

            if (valid.length === 0) return

            // 检查批次总数
            const totalAfter = valid.length + previews.length
            if (totalAfter > MAX_FILES_PER_BATCH) {
                toast.error({
                    title: '超过批次限制',
                    message: `单批次最多 ${MAX_FILES_PER_BATCH} 张，当前已有 ${previews.length} 张`,
                })
                return
            }

            const currentBytes = previews.reduce((sum, item) => sum + item.size, 0)
            const incomingBytes = valid.reduce((sum, file) => sum + file.size, 0)
            if (currentBytes + incomingBytes > MAX_TOTAL_UPLOAD_SIZE) {
                toast.error({
                    title: '超过批次容量',
                    message: '单批次图片总量最多 80MB，请删除部分图片或压缩后重试',
                })
                return
            }

            // 生成本地预览；服务端没有单文件字节进度协议，因此只公开不确定态。
            const newPreviews: PreviewItem[] = []
            try {
                for (const file of valid) {
                    newPreviews.push({
                        id: nextPreviewId(),
                        url: URL.createObjectURL(file),
                        name: file.name,
                        size: file.size,
                        status: 'uploading',
                    })
                }
            } catch {
                newPreviews.forEach((preview) => URL.revokeObjectURL(preview.url))
                toast.error({
                    title: '本地预览创建失败',
                    message: '浏览器未能安全读取所选图片，请刷新后分批重试。',
                })
                return
            }

            uploadInFlightRef.current = true
            uploadGenerationRef.current += 1
            const uploadGeneration = uploadGenerationRef.current
            const previewIds = new Set(newPreviews.map((preview) => preview.id))
            setIsUploading(true)
            setPreviews((prev) => [...prev, ...newPreviews])

            try {
                const uploaded = await uploadFiles(valid)
                if (!mountedRef.current || uploadGenerationRef.current !== uploadGeneration) return
                // Store 必须显式确认成功；演示模式、校验拒绝与网络错误都不能伪装完成。
                setPreviews((prev) =>
                    prev.map((p) => {
                        if (!previewIds.has(p.id) || p.status !== 'uploading') return p
                        return { ...p, status: uploaded ? 'done' : 'error' }
                    }),
                )
                if (uploaded) onUploaded?.()
            } catch (err) {
                if (!mountedRef.current || uploadGenerationRef.current !== uploadGeneration) return
                // 上传失败：所有 uploading 态 preview 切换为 error
                setPreviews((prev) =>
                    prev.map((p) => {
                        if (!previewIds.has(p.id) || p.status !== 'uploading') return p
                        return { ...p, status: 'error' }
                    }),
                )
                // 不再重复 toast，uploadFiles store 内部已 toast.error
                if (import.meta.env.DEV) {
                    console.warn('[UploadZone] upload failed:', err)
                }
            } finally {
                if (uploadGenerationRef.current === uploadGeneration) {
                    uploadInFlightRef.current = false
                    if (mountedRef.current) setIsUploading(false)
                }
            }
        },
        [batchId, classId, files.length, loading, questionId, previews.length, stage, uploadFiles, onUploaded, validateFile],
    )

    /** 拖拽事件处理 */
    const handleDragEnter = useCallback((e: React.DragEvent) => {
        e.preventDefault()
        e.stopPropagation()
        dragCounter.current += 1
        if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
            setIsDragging(true)
        }
    }, [])

    const handleDragLeave = useCallback((e: React.DragEvent) => {
        e.preventDefault()
        e.stopPropagation()
        dragCounter.current -= 1
        if (dragCounter.current === 0) {
            setIsDragging(false)
        }
    }, [])

    const handleDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault()
        e.stopPropagation()
    }, [])

    const handleDrop = useCallback(
        async (e: React.DragEvent) => {
            e.preventDefault()
            e.stopPropagation()
            dragCounter.current = 0
            setIsDragging(false)

            const droppedFiles = e.dataTransfer.files
            if (droppedFiles && droppedFiles.length > 0) {
                await handleFiles(droppedFiles)
            }
        },
        [handleFiles],
    )

    /** 点击 input 变化 */
    const handleInputChange = useCallback(
        async (e: React.ChangeEvent<HTMLInputElement>) => {
            const selected = e.target.files
            if (selected && selected.length > 0) {
                await handleFiles(selected)
            }
            // 重置 input value 以便重复选择同一文件
            if (inputRef.current) {
                inputRef.current.value = ''
            }
        },
        [handleFiles],
    )

    /** 粘贴上传（Ctrl+V）—— 监听 paste 事件提取剪贴板图片 */
    useEffect(() => {
        const handlePaste = (e: ClipboardEvent) => {
            if (!e.clipboardData) return
            const items = e.clipboardData.items
            const imageFiles: File[] = []
            for (let i = 0; i < items.length; i++) {
                const item = items[i]
                if (item && item.kind === 'file' && ALLOWED_TYPES.has(item.type)) {
                    const file = item.getAsFile()
                    if (file) {
                        // 粘贴的图片无文件名，生成默认名
                        const ext = file.type.split('/')[1] ?? 'png'
                        const named = new File([file], `paste-${Date.now()}.${ext}`, { type: file.type })
                        imageFiles.push(named)
                    }
                }
            }
            if (imageFiles.length > 0) {
                e.preventDefault()
                void handleFiles(imageFiles)
            }
        }

        window.addEventListener('paste', handlePaste)
        return () => window.removeEventListener('paste', handlePaste)
    }, [handleFiles])

    /** 删除预览项 */
    const handleRemovePreview = useCallback((id: string) => {
        setPreviews((prev) => {
            const target = prev.find((p) => p.id === id)
            if (target) {
                URL.revokeObjectURL(target.url)
            }
            return prev.filter((p) => p.id !== id)
        })
    }, [])

    /** 组件卸载时清理预览 URL，并让晚到上传响应失去 UI 写权限。 */
    useEffect(() => {
        mountedRef.current = true
        return () => {
            mountedRef.current = false
            uploadGenerationRef.current += 1
            uploadInFlightRef.current = false
            for (const p of previewsRef.current) {
                URL.revokeObjectURL(p.url)
            }
        }
    }, [])

    /** 新建批次时同步清除组件本地状态与 blob URL，避免旧缩略图污染新批次。 */
    useEffect(() => {
        if (seenResetEpochRef.current === resetEpoch) return
        seenResetEpochRef.current = resetEpoch
        uploadGenerationRef.current += 1
        const stalePreviews = previewsRef.current
        previewsRef.current = []
        setPreviews([])
        setIsUploading(false)
        uploadInFlightRef.current = false
        dragCounter.current = 0
        setIsDragging(false)
        for (const preview of stalePreviews) {
            URL.revokeObjectURL(preview.url)
        }
    }, [resetEpoch])

    /**
     * 后端只要已经分配 batchId，批次就必须保持不可变。
     * 即使历史响应损坏、文件数组被安全归零，也要显示锁定说明，不能留下“入口被禁用但原因不可见”的灰态。
     */
    const hasBatch = batchId !== null

    return (
        <section id="pr-grading-upload-zone" className="pr-grading-upload" aria-label="上传作业">
            <div
                className={`pr-grading-upload-dropzone ${isDragging ? 'is-dragging' : ''} ${hasBatch ? 'has-batch' : ''}`}
                aria-disabled={batchId !== null || stage !== 'idle' || files.length > 0 || undefined}
                onDragEnter={handleDragEnter}
                onDragLeave={handleDragLeave}
                onDragOver={handleDragOver}
                onDrop={handleDrop}
            >
                <input
                    ref={inputRef}
                    type="file"
                    multiple
                    accept="image/jpeg,image/png,image/webp"
                    onChange={handleInputChange}
                    className="pr-grading-upload-input"
                    id="pr-grading-upload-input"
                    disabled={!classId || !questionId || loading || isUploading || batchId !== null || stage !== 'idle' || files.length > 0}
                />
                <label htmlFor="pr-grading-upload-input" className="pr-grading-upload-label">
                    <div className="pr-grading-upload-icon">
                        <Icon name={isDragging ? 'paper-plane' : 'upload'} size={32} />
                    </div>
                    <div className="pr-grading-upload-text">
                        <span className="pr-grading-upload-title">
                            {isDragging ? '释放以上传' : '拖拽图片到此处'}
                        </span>
                        <span className="pr-grading-upload-hint">
                            或点击选择 · 支持 Ctrl+V 粘贴 · jpg/png/webp · 单文件 ≤10MB
                        </span>
                    </div>
                </label>
            </div>

            {/* 本地预览缩略图网格 —— 上传中为诚实的不确定态 */}
            {previews.length > 0 && (
                <div className="pr-grading-upload-previews">
                    <div className="pr-grading-upload-previews-header">
                        <span className="pr-grading-upload-previews-title">
                            待上传 / 已上传 {previews.length} 张
                        </span>
                        {hasBatch && (
                            <span className="pr-grading-upload-previews-lock" role="status">
                                批次已锁定；如需更换图片，请新建批次
                            </span>
                        )}
                    </div>
                    <div className="pr-grading-upload-grid">
                        {previews.map((p) => (
                            <div
                                key={p.id}
                                className={`pr-grading-upload-thumb is-${p.status}`}
                            >
                                <GradingMediaImage src={p.url} alt={p.name} />
                                {p.status !== 'done' && (
                                    <button
                                        type="button"
                                        className="pr-grading-upload-thumb-remove"
                                        onClick={() => handleRemovePreview(p.id)}
                                        aria-label={`移除未成功上传的本地预览 ${p.name}`}
                                        disabled={p.status === 'uploading'}
                                    >
                                        <Icon name="x" size={14} />
                                    </button>
                                )}
                                <div className="pr-grading-upload-thumb-name" title={p.name}>
                                    {p.name}
                                </div>
                                {/* 后端没有逐文件字节进度；不提供 aria-valuenow，表示不确定态。 */}
                                {p.status === 'uploading' && (
                                    <div
                                        className="pr-grading-upload-thumb-progress"
                                        role="progressbar"
                                        aria-valuemin={0}
                                        aria-valuemax={100}
                                        aria-label={`${p.name} 正在上传，服务端未提供单文件百分比`}
                                    >
                                        <div className="pr-grading-upload-thumb-progress-fill" />
                                    </div>
                                )}
                                {p.status === 'done' && (
                                    <div className="pr-grading-upload-thumb-status pr-grading-upload-thumb-status--done">
                                        <Icon name="check" size={12} />
                                    </div>
                                )}
                                {p.status === 'error' && (
                                    <div className="pr-grading-upload-thumb-status pr-grading-upload-thumb-status--error">
                                        <Icon name="warning" size={12} />
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* 加载进度条 */}
            {loading && (
                <div className="pr-grading-upload-progress" role="status" aria-live="polite">
                    <div className="pr-grading-upload-progress-bar" />
                    <span className="pr-grading-upload-progress-text">
                        {stage === 'recognizing' ? '诗眼 Agent 识别中...' : '上传中...'}
                    </span>
                </div>
            )}

            {/* 操作按钮 */}
            {hasBatch && stage === 'uploaded' && (
                <div className="pr-grading-upload-actions">
                    <Button
                        variant="primary"
                        size="lg"
                        leftIcon={<Icon name="eye" size={18} />}
                        onClick={() => void recognize()}
                        loading={loading}
                    >
                        开始识别
                    </Button>
                    <span className="pr-grading-upload-actions-hint">
                        将调用诗眼 Agent（mimo-v2.5）识别手写内容
                    </span>
                </div>
            )}

            {!classId && (
                <div className="pr-grading-upload-warning">
                    <Icon name="warning-circle" size={16} />
                    <span>请先在页面顶部选择班级</span>
                </div>
            )}
            {classId && !questionId && (
                <div className="pr-grading-upload-warning">
                    <Icon name="warning-circle" size={16} />
                    <span>请先在页面顶部选择诗篇与题目</span>
                </div>
            )}
        </section>
    )
})
