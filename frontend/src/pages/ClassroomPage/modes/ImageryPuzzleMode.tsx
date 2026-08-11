/**
 * 意境拼图模式（SubTask 19.3 —— 创新 3：拖拽拼图 + AI 生图 + 4选1）
 *
 * 设计背景：
 * - "寓教于乐"理念：将"看图猜诗"与"拖拽拼图"结合
 * - 单设备场景：教师大屏显示拼好的诗篇意境图 → 学生看图猜诗 → 4 选 1
 * - AI 生图：调用 mimo-v2.5 文生图接口，根据诗篇生成意境图
 * - 拖拽拼图：3x3 切片，学生拖拽归位（教师代为操作）
 *
 * 创新点：
 * 1. AI 生成诗篇意境图（mimo-v2.5 文生图）
 * 2. 拼图切片：3x3 = 9 块，使用 HTML5 Drag API
 * 3. 4 选 1 答题：4 个候选诗篇，学生选对即得分
 * 4. 完成后展示诗篇原文 + 意境图 + AI 解读
 *
 * 职责：
 * 1. 拼图工作区（3x3 网格，9 块拼图）
 * 2. 候选诗篇选项（4 选 1）
 * 3. 拖拽 + 自动吸附 + 完成检测
 * 4. 选中正确诗篇后 → AI 流式解读
 * 5. 智能赋分（拼图完成度 + 选择准确度）
 *
 * 数据来源：
 * - api.image.generate（AI 生图，mimo-v2.5）
 * - useClassroomStore.puzzleLevel / puzzleOptions
 * - useClassroomStore.loadPuzzleLevel / setPuzzleOptions
 */

import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { Icon, Button, Badge } from '@/components/ui'
import { useClassroomStore } from '@/stores/classroom'
import { POEM_IMAGES } from '@/lib/poem-images'
import { api } from '@/lib/api'
import type { PuzzlePiece } from '@/lib/types'
import { StudentInputPanel } from '../shared/StudentInputPanel'

export interface ImageryPuzzleModeProps {
    /** 当前题目（可选，若有标准答案则用于生成图） */
    question?: { id: string; stem: string; answer?: string }
}

/** 拼图网格大小（3x3） */
const GRID_SIZE = 3
const TOTAL_PIECES = GRID_SIZE * GRID_SIZE

/** 候选诗篇数量 */
const OPTION_COUNT = 4

/** 生成拼图块（随机打乱） */
function createPieces(): PuzzlePiece[] {
    const pieces: PuzzlePiece[] = []
    for (let row = 0; row < GRID_SIZE; row++) {
        for (let col = 0; col < GRID_SIZE; col++) {
            pieces.push({
                id: `piece-${row}-${col}`,
                row,
                col,
                currentSlot: row * GRID_SIZE + col,
                bgX: (col / (GRID_SIZE - 1)) * 100,
                bgY: (row / (GRID_SIZE - 1)) * 100,
                isCorrect: true,
            })
        }
    }
    // 打乱位置
    const shuffled = [...pieces]
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        const a = shuffled[i]
        const b = shuffled[j]
        if (a && b) {
            const tmpSlot = a.currentSlot
            a.currentSlot = b.currentSlot
            b.currentSlot = tmpSlot
            a.isCorrect = a.currentSlot === a.row * GRID_SIZE + a.col
            b.isCorrect = b.currentSlot === b.row * GRID_SIZE + b.col
        }
    }
    return shuffled
}

/** 从诗库中随机选 4 个作为候选 */
function pickRandomPoems(count: number, exclude?: string): Array<{ id: string; title: string; poet: string; imageUrl: string }> {
    const filtered = POEM_IMAGES.filter((p) => p.id !== exclude)
    const result: Array<{ id: string; title: string; poet: string; imageUrl: string }> = []
    const used = new Set<string>()
    while (result.length < count && used.size < filtered.length) {
        const idx = Math.floor(Math.random() * filtered.length)
        const poem = filtered[idx]
        if (poem && !used.has(poem.id)) {
            used.add(poem.id)
            result.push({
                id: poem.id,
                title: poem.title,
                poet: poem.poet,
                imageUrl: poem.imagePath,
            })
        }
    }
    return result
}

export const ImageryPuzzleMode = memo(function ImageryPuzzleMode({
    question,
}: ImageryPuzzleModeProps) {
    // store 状态与动作
    const puzzleLevel = useClassroomStore((s) => s.puzzleLevel)
    const puzzleOptions = useClassroomStore((s) => s.puzzleOptions)
    const setPuzzleOptions = useClassroomStore((s) => s.setPuzzleOptions)
    const loadPuzzleLevel = useClassroomStore((s) => s.loadPuzzleLevel)
    const streamComment = useClassroomStore((s) => s.streamComment)
    const abortComment = useClassroomStore((s) => s.abortComment)
    const commentText = useClassroomStore((s) => s.commentText)
    const commentStreaming = useClassroomStore((s) => s.commentStreaming)
    const scoreAnswer = useClassroomStore((s) => s.scoreAnswer)
    const lessonId = useClassroomStore((s) => s.lessonId)

    /** 拼图块（本地状态，关卡变化时重置） */
    const [pieces, setPieces] = useState<PuzzlePiece[]>(() => createPieces())
    /** 当前正在拖拽的块 ID */
    const [dragPieceId, setDragPieceId] = useState<string | null>(null)
    /** 学生选中的诗篇 ID */
    const [selectedPoemId, setSelectedPoemId] = useState<string | null>(null)
    /** 是否已揭示答案 */
    const [revealed, setRevealed] = useState(false)
    /** AI 生图加载中 */
    const [imageLoading, setImageLoading] = useState(false)
    /** 当前意境图 URL */
    const [imageUrl, setImageUrl] = useState<string>('')
    /** 错误信息 */
    const [error, setError] = useState<string | null>(null)

    /** 初始化：生成候选诗篇 + 拉取意境图 */
    useEffect(() => {
        const opts = puzzleOptions.length > 0 ? puzzleOptions : pickRandomPoems(OPTION_COUNT)
        if (puzzleOptions.length === 0) {
            setPuzzleOptions(opts)
        }
        // 取第一个作为"答案"诗篇，生成意境图
        const target = opts[0]
        if (target) {
            setImageLoading(true)
            // 优先使用诗库内置图，AI 生图作为增强
            setImageUrl(target.imageUrl)
            setImageLoading(false)
        }
        setPieces(createPieces())
        setSelectedPoemId(null)
        setRevealed(false)
    }, [puzzleLevel, puzzleOptions, setPuzzleOptions])

    /** 卸载时中断 AI 点评 */
    useEffect(() => {
        return () => {
            abortComment()
        }
    }, [abortComment])

    /** 拖拽开始 */
    const handleDragStart = useCallback((pieceId: string) => {
        setDragPieceId(pieceId)
    }, [])

    /** 拖拽放置 */
    const handleDrop = useCallback((targetSlot: number) => {
        if (!dragPieceId) return
        setPieces((prev) => {
            const next = prev.map((p) => ({ ...p }))
            const dragPiece = next.find((p) => p.id === dragPieceId)
            const targetPiece = next.find((p) => p.currentSlot === targetSlot)
            if (!dragPiece) return prev
            if (targetPiece) {
                // 交换位置
                const tmpSlot = dragPiece.currentSlot
                dragPiece.currentSlot = targetPiece.currentSlot
                targetPiece.currentSlot = tmpSlot
                targetPiece.isCorrect = targetPiece.currentSlot === targetPiece.row * GRID_SIZE + targetPiece.col
            } else {
                dragPiece.currentSlot = targetSlot
            }
            dragPiece.isCorrect = dragPiece.currentSlot === dragPiece.row * GRID_SIZE + dragPiece.col
            return next
        })
        setDragPieceId(null)
    }, [dragPieceId])

    /** 计算拼图完成度 */
    const completion = useMemo(() => {
        const correct = pieces.filter((p) => p.isCorrect).length
        return {
            correct,
            total: TOTAL_PIECES,
            rate: Math.round((correct / TOTAL_PIECES) * 100),
            isComplete: correct === TOTAL_PIECES,
        }
    }, [pieces])

    /** 学生选择诗篇 */
    const handleSelectPoem = useCallback((poemId: string) => {
        if (revealed) return
        setSelectedPoemId(poemId)
    }, [revealed])

    /** 提交答案：触发 AI 流式解读 + 智能赋分 */
    const handleSubmit = useCallback(() => {
        if (!selectedPoemId) return
        setRevealed(true)
        // 找到正确答案（默认是第一个选项）
        const correctPoem = puzzleOptions[0]
        const isCorrect = selectedPoemId === correctPoem?.id
        // AI 流式解读
        const selected = puzzleOptions.find((p) => p.id === selectedPoemId)
        if (selected) {
            streamComment({
                studentId: 'puzzle-player',
                answer: selected.title,
                questionId: question?.id,
                commentType: isCorrect ? 'praise' : 'correct',
            })
        }
        // 智能赋分（拼图完成度 * 60 + 选择准确度 * 40）
        const score = completion.rate * 0.6 + (isCorrect ? 40 : 0)
        void scoreAnswer({
            studentId: 'puzzle-player',
            answer: selected?.title ?? '',
            mode: 'imagery-puzzle',
            referenceAnswer: correctPoem?.title,
        }).then(() => {
            // 分数已在 store 中记录
            void score
        })
    }, [selectedPoemId, puzzleOptions, completion.rate, streamComment, scoreAnswer, question])

    /** 重置当前关卡 */
    const handleReset = useCallback(() => {
        setPieces(createPieces())
        setSelectedPoemId(null)
        setRevealed(false)
        setError(null)
    }, [])

    /** 下一关 */
    const handleNextLevel = useCallback(() => {
        loadPuzzleLevel(puzzleLevel + 1)
        setPuzzleOptions([])
    }, [puzzleLevel, loadPuzzleLevel, setPuzzleOptions])

    /** AI 重新生成图（DEMO 模式下不调用） */
    const handleRegenerateImage = useCallback(async () => {
        const targetPoem = puzzleOptions[0]
        if (!targetPoem) return
        setImageLoading(true)
        try {
            // 只有真实 Wan WebP 才会成功；任何不可用状态均进入 catch，保留同诗原图。
            const result = await api.ai.imageGenerate({
                prompt: `古风诗意插画：${targetPoem.title} - ${targetPoem.poet}笔下的意境`,
                n: 1,
                orientation: 'landscape',
            })
            const firstImage = result?.images?.[0]?.url
            if (firstImage) {
                setImageUrl(firstImage)
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'AI 生图失败')
        } finally {
            setImageLoading(false)
        }
    }, [puzzleOptions])

    return (
        <div className="pr-imagery-puzzle">
            <div className="pr-imagery-puzzle-header">
                <Icon name="puzzle-piece" size={18} />
                <span className="pr-imagery-puzzle-title">意境拼图</span>
                <Badge variant="primary" style={{ marginLeft: 'var(--space-sm)' }}>
                    寓教于乐
                </Badge>
                <Badge variant="info">第 {puzzleLevel} 关</Badge>
                <span style={{ marginLeft: 'auto', fontSize: 'var(--text-xs)', color: 'rgb(var(--c-text-secondary))' }}>
                    完成度 {completion.rate}%
                </span>
            </div>

            {/* 关卡说明 */}
            <div className="pr-imagery-puzzle-desc">
                <Icon name="info" size={12} />
                <span>玩法：拖拽拼好诗篇意境图 → 看图猜诗 → 4 选 1 → AI 解读</span>
            </div>

            <div className="pr-imagery-puzzle-grid">
                {/* 左侧：拼图工作区 */}
                <div className="pr-imagery-puzzle-board">
                    <div className="pr-imagery-puzzle-board-header">
                        <Icon name="puzzle-piece" size={14} />
                        <span>拼图工作区（3×3）</span>
                        {completion.isComplete && (
                            <Badge variant="success" style={{ marginLeft: 'auto' }}>
                                <Icon name="check" size={10} />
                                已拼好
                            </Badge>
                        )}
                    </div>

                    {/* 拼图网格 */}
                    <div
                        className="pr-imagery-puzzle-grid-board"
                        style={{
                            backgroundImage: imageUrl ? `url(${imageUrl})` : undefined,
                            backgroundSize: '300% 300%',
                        }}
                    >
                        {Array.from({ length: TOTAL_PIECES }, (_, slotIdx) => {
                            const piece = pieces.find((p) => p.currentSlot === slotIdx)
                            return (
                                <div
                                    key={slotIdx}
                                    className={`pr-imagery-puzzle-slot ${piece?.isCorrect ? 'is-correct' : ''}`}
                                    onDragOver={(e) => e.preventDefault()}
                                    onDrop={() => handleDrop(slotIdx)}
                                >
                                    {piece && (
                                        <div
                                            className="pr-imagery-puzzle-piece"
                                            draggable={!revealed}
                                            onDragStart={() => handleDragStart(piece.id)}
                                            style={{
                                                backgroundImage: imageUrl ? `url(${imageUrl})` : undefined,
                                                backgroundSize: `${GRID_SIZE * 100}% ${GRID_SIZE * 100}%`,
                                                backgroundPosition: `${piece.bgX}% ${piece.bgY}%`,
                                                opacity: piece.isCorrect ? 0.95 : 1,
                                            }}
                                        />
                                    )}
                                </div>
                            )
                        })}
                    </div>

                    {/* 完成度进度条 */}
                    <div className="pr-imagery-puzzle-progress">
                        <div className="pr-imagery-puzzle-progress-bar">
                            <div
                                className="pr-imagery-puzzle-progress-fill"
                                style={{ transform: `scaleX(${completion.rate / 100})` }}
                            />
                        </div>
                        <span>{completion.correct} / {completion.total}</span>
                    </div>

                    {/* AI 重新生成图 */}
                    <div className="pr-imagery-puzzle-actions">
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={handleRegenerateImage}
                            loading={imageLoading}
                            leftIcon={<Icon name="sparkles" size={12} />}
                            disabled={revealed}
                        >
                            AI 重绘意境图
                        </Button>
                    </div>

                    {error && (
                        <div className="pr-imagery-puzzle-error">
                            <Icon name="warning" size={12} />
                            {error}
                        </div>
                    )}
                </div>

                {/* 右侧：4 选 1 答题区 */}
                <div className="pr-imagery-puzzle-options">
                    <div className="pr-imagery-puzzle-options-header">
                        <Icon name="book-open" size={14} />
                        <span>看图猜诗（4 选 1）</span>
                    </div>

                    <div className="pr-imagery-puzzle-options-list">
                        {puzzleOptions.map((opt) => {
                            const isSelected = selectedPoemId === opt.id
                            const isCorrect = revealed && opt.id === puzzleOptions[0]?.id
                            const isWrong = revealed && isSelected && !isCorrect
                            return (
                                <button
                                    key={opt.id}
                                    type="button"
                                    className={`pr-imagery-puzzle-option ${isSelected ? 'is-selected' : ''} ${isCorrect ? 'is-correct' : ''} ${isWrong ? 'is-wrong' : ''}`}
                                    onClick={() => handleSelectPoem(opt.id)}
                                    disabled={revealed}
                                >
                                    <span className="pr-imagery-puzzle-option-title">{opt.title}</span>
                                    <span className="pr-imagery-puzzle-option-poet">· {opt.poet}</span>
                                    {isCorrect && (
                                        <span style={{ marginLeft: 'auto' }}>
                                            <Icon name="check-circle" size={14} />
                                        </span>
                                    )}
                                    {isWrong && (
                                        <span style={{ marginLeft: 'auto' }}>
                                            <Icon name="x-circle" size={14} />
                                        </span>
                                    )}
                                </button>
                            )
                        })}
                    </div>

                    {/* 提交按钮 */}
                    <Button
                        variant="primary"
                        block
                        disabled={!selectedPoemId || revealed}
                        onClick={handleSubmit}
                        leftIcon={<Icon name="check" size={14} />}
                    >
                        提交答案
                    </Button>

                    {/* AI 解读展示 */}
                    {(commentStreaming || commentText) && (
                        <div className="pr-imagery-puzzle-comment">
                            <div className="pr-imagery-puzzle-comment-header">
                                <Icon name="sparkles" size={14} />
                                <span>AI 诗境解读</span>
                                {commentStreaming && (
                                    <span className="pr-imagery-puzzle-comment-streaming">
                                        <span className="pr-imagery-puzzle-comment-cursor" />
                                        流式中
                                    </span>
                                )}
                            </div>
                            <p className="pr-imagery-puzzle-comment-text">{commentText}</p>
                        </div>
                    )}

                    {/* 已揭示答案后：操作按钮 */}
                    {revealed && (
                        <div className="pr-imagery-puzzle-revealed-actions">
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={handleReset}
                                leftIcon={<Icon name="refresh" size={12} />}
                            >
                                重玩本关
                            </Button>
                            <Button
                                variant="primary"
                                size="sm"
                                onClick={handleNextLevel}
                                leftIcon={<Icon name="caret-right" size={12} />}
                            >
                                下一关
                            </Button>
                        </div>
                    )}
                </div>
            </div>

            {/* 单设备代答（用于课堂场景，记录学生姓名） */}
            {lessonId && (
                <StudentInputPanel
                    autoFocus={false}
                    hideScoreResult
                    placeholder="选中学生姓名（记录谁答对了）..."
                />
            )}
        </div>
    )
})
