import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { getDisplayError } from '@/lib/errors'
import type { MemoryGovernanceItem, MemoryGovernanceKind } from '@/lib/types'
import { useAuthStore } from '@/stores/auth'
import { toast } from '@/stores/toast'
import { Icon } from '@/components/ui/Icon'
import { useClasses } from '@/hooks/useClasses'

/**
 * 教师长期记忆治理面板。
 *
 * 重要边界：teacherId 由服务端签名会话约束，前端值只用于请求作用域与界面展示；
 * 所以 UI 明示“本机治理”，并要求教师主动勾选脱敏确认后才允许写入。
 */
export function MemoryGovernancePanel() {
    const teacherId = useAuthStore((state) => state.teacherId)
    const selectedClassId = useAuthStore((state) => state.classId)
    const setClass = useAuthStore((state) => state.setClass)
    const { classes, loading: classesLoading } = useClasses()
    const [open, setOpen] = useState(false)
    const [items, setItems] = useState<MemoryGovernanceItem[]>([])
    const [loading, setLoading] = useState(false)
    const [saving, setSaving] = useState(false)
    const [kind, setKind] = useState<MemoryGovernanceKind>('teacher')
    const [studentId, setStudentId] = useState('')
    const [content, setContent] = useState('')
    const [consent, setConsent] = useState(false)
    const [editingId, setEditingId] = useState<string | null>(null)
    const [editingContent, setEditingContent] = useState('')
    const [confirmingId, setConfirmingId] = useState<string | null>(null)
    const [clearConfirmationOpen, setClearConfirmationOpen] = useState(false)
    const memoryRequestVersion = useRef(0)
    const clearConfirmationRef = useRef<HTMLDivElement>(null)

    const load = useCallback(async () => {
        const requestVersion = ++memoryRequestVersion.current
        // 未选择班级时只能列出教师偏好；禁止无范围枚举学生记忆。
        if (kind === 'student' && !selectedClassId) {
            if (requestVersion === memoryRequestVersion.current) {
                setItems([])
                setLoading(false)
            }
            return
        }
        setLoading(true)
        try {
            const response = await api.memory.list({
                teacherId,
                kind,
                classId: kind === 'student' ? selectedClassId : undefined,
                limit: 100,
            })
            if (requestVersion === memoryRequestVersion.current) {
                setItems(response.memories)
            }
        } catch (error) {
            if (requestVersion === memoryRequestVersion.current) {
                toast.error({ title: '记忆列表加载失败', message: getDisplayError(error, '请检查后端服务') })
            }
        } finally {
            if (requestVersion === memoryRequestVersion.current) {
                setLoading(false)
            }
        }
    }, [kind, selectedClassId, teacherId])

    useEffect(() => {
        if (open) void load()
    }, [load, open])

    useEffect(() => {
        if (!clearConfirmationOpen) return
        const frame = window.requestAnimationFrame(() => {
            clearConfirmationRef.current?.scrollIntoView({ block: 'center', behavior: 'auto' })
        })
        return () => window.cancelAnimationFrame(frame)
    }, [clearConfirmationOpen])

    const resetDraft = () => {
        setContent('')
        setStudentId('')
        setConsent(false)
    }

    const createMemory = async () => {
        if (!consent) {
            toast.warning({ title: '请先确认脱敏', message: '长期记忆只允许写入不含姓名、手机号、身份证号和密钥的教学摘要' })
            return
        }
        if (!content.trim()) {
            toast.warning({ title: '内容不能为空', message: '请填写一条可复核的教学摘要' })
            return
        }
        if (kind === 'student' && (!studentId.trim() || !selectedClassId)) {
            toast.warning({ title: '缺少学生范围', message: '学生记忆需要先选择班级并填写脱敏 studentId' })
            return
        }
        setSaving(true)
        try {
            await api.memory.create({
                teacherId,
                kind,
                content: content.trim(),
                ...(kind === 'student' ? { studentId: studentId.trim(), classId: selectedClassId } : {}),
                tags: [kind === 'student' ? 'student' : 'teacher'],
            })
            // 治理写入会改变后续 AI 可见上下文；比普通短时提示多停留一会儿，
            // 让教师有足够时间确认对象和保留策略，避免反馈在设置面板内一闪而过。
            toast.success({
                title: '记忆已保存',
                message: '已写入教师可治理范围，并按保留期限自动清理',
                duration: 6000,
            })
            resetDraft()
            await load()
        } catch (error) {
            toast.error({ title: '记忆保存失败', message: getDisplayError(error, '请检查内容是否包含直接身份标识') })
        } finally {
            setSaving(false)
        }
    }

    const updateMemory = async (id: string) => {
        if (!editingContent.trim()) return
        setSaving(true)
        try {
            await api.memory.update(id, { teacherId, content: editingContent.trim() })
            toast.success({
                title: '记忆已更新',
                message: '修改已记录，原内容不会再次注入上下文',
                duration: 6000,
            })
            setEditingId(null)
            setEditingContent('')
            await load()
        } catch (error) {
            toast.error({ title: '记忆更新失败', message: getDisplayError(error, '请稍后重试') })
        } finally {
            setSaving(false)
        }
    }

    const deleteMemory = async (id: string) => {
        if (confirmingId !== id) {
            setConfirmingId(id)
            return
        }
        setSaving(true)
        try {
            await api.memory.delete(id, teacherId)
            toast.success({
                title: '记忆已删除',
                message: '该条内容已从可检索范围移除',
                duration: 6000,
            })
            setConfirmingId(null)
            await load()
        } catch (error) {
            toast.error({ title: '记忆删除失败', message: getDisplayError(error, '请稍后重试') })
        } finally {
            setSaving(false)
        }
    }

    const clearClassMemories = async () => {
        if (!selectedClassId || kind !== 'student') return
        setSaving(true)
        try {
            await api.memory.clear({ teacherId, kind: 'student', classId: selectedClassId })
            toast.success({
                title: '班级记忆已清空',
                message: '教师偏好记忆不会受影响',
                duration: 6000,
            })
            setClearConfirmationOpen(false)
            await load()
        } catch (error) {
            toast.error({ title: '批量删除失败', message: getDisplayError(error, '请稍后重试') })
        } finally {
            setSaving(false)
        }
    }

    return (
        <section className="pr-memory-governance" aria-labelledby="pr-memory-governance-title">
            <button
                type="button"
                className="pr-memory-governance-toggle"
                aria-expanded={open}
                onClick={() => setOpen((value) => !value)}
            >
                <span className="pr-settings-row-label">
                    <Icon name="brain" size={14} />
                    <span id="pr-memory-governance-title">长期记忆治理</span>
                </span>
                <span className="pr-memory-governance-toggle-meta">{open ? '收起' : '查看与删除'}</span>
            </button>

            {open && (
                <div className="pr-memory-governance-body">
                    <p className="pr-memory-governance-notice">
                        单教师本地治理面：服务端会话绑定教师主体；学生记忆必须绑定当前班级，内容默认 180 天后过期。
                    </p>

                    <div className="pr-memory-governance-form" aria-label="新增长期记忆">
                        <div className="pr-memory-governance-form-row">
                            <label>
                                <span>班级范围{kind === 'student' ? '（必选）' : ''}</span>
                                <select
                                    value={selectedClassId}
                                    onChange={(event) => {
                                        setClass(event.target.value)
                                        setClearConfirmationOpen(false)
                                    }}
                                    disabled={classesLoading || saving}
                                >
                                    <option value="">未选择班级</option>
                                    {classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                                </select>
                            </label>
                            <label>
                                <span>类型</span>
                                <select
                                    value={kind}
                                    onChange={(event) => {
                                        setKind(event.target.value as MemoryGovernanceKind)
                                        setClearConfirmationOpen(false)
                                    }}
                                >
                                    <option value="teacher">教师偏好</option>
                                    <option value="student">学生学情摘要</option>
                                </select>
                            </label>
                            {kind === 'student' && (
                                <label>
                                    <span>脱敏 studentId</span>
                                    <input value={studentId} onChange={(event) => setStudentId(event.target.value)} placeholder="如 student-01" maxLength={128} />
                                </label>
                            )}
                        </div>
                        <label>
                            <span>内容</span>
                            <textarea value={content} onChange={(event) => setContent(event.target.value)} maxLength={4_000} rows={3} placeholder="只写可复核的教学摘要，不写姓名、手机号或原始答题全文" />
                        </label>
                        <label className="pr-memory-governance-check">
                            <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
                            <span>我确认内容已脱敏，且仅用于当前教师的教学辅助</span>
                        </label>
                        <button type="button" className="pr-memory-governance-primary" disabled={saving || !consent} onClick={() => void createMemory()}>
                            <Icon name="plus" size={14} />
                            {saving ? '保存中…' : '保存记忆'}
                        </button>
                    </div>

                    <div className="pr-memory-governance-list" aria-live="polite">
                            <div className="pr-memory-governance-list-header">
                                <span>{loading ? '读取中…' : `当前范围 ${items.length} 条`}</span>
                                {kind === 'student' && selectedClassId && (
                                    <button
                                        type="button"
                                        className="pr-memory-governance-clear"
                                        disabled={saving || loading}
                                        onClick={() => setClearConfirmationOpen(true)}
                                    >
                                        清空本班学生记忆
                                    </button>
                                )}
                            </div>
                            {clearConfirmationOpen && kind === 'student' && selectedClassId && (
                                <div
                                    ref={clearConfirmationRef}
                                    className="pr-memory-governance-clear-confirmation"
                                    role="alert"
                                    data-testid="memory-clear-confirmation"
                                >
                                    <p id="memory-clear-confirmation-title">
                                        确认清空当前班级的学生长期记忆？此操作不可撤销，教师偏好记忆不会受影响。
                                    </p>
                                    <div className="pr-memory-governance-clear-confirmation-actions" aria-labelledby="memory-clear-confirmation-title">
                                        <button
                                            type="button"
                                            className="pr-memory-governance-clear-confirmation-cancel"
                                            disabled={saving}
                                            onClick={() => setClearConfirmationOpen(false)}
                                        >
                                            取消
                                        </button>
                                        <button
                                            type="button"
                                            className="pr-memory-governance-clear pr-memory-governance-clear-confirmation-submit"
                                            disabled={saving}
                                            onClick={() => void clearClassMemories()}
                                        >
                                            {saving ? '清空中…' : '确认清空学生记忆'}
                                        </button>
                                    </div>
                                </div>
                            )}
                            {kind === 'student' && !selectedClassId && <p className="pr-memory-governance-empty">请先选择班级，学生记忆不会在无班级范围时列出。</p>}
                    {!loading && items.length === 0 && !(kind === 'student' && !selectedClassId) && <p className="pr-memory-governance-empty">暂无记忆。只有教师主动确认并保存后，内容才会进入长期记忆。</p>}
                    {items.map((item) => (
                            <article key={item.id} className="pr-memory-governance-item">
                                <div className="pr-memory-governance-item-meta">
                                    <span>{item.kind === 'student' ? `学生 · ${item.userId}` : '教师偏好'}</span>
                                    <span>到期：{new Date(item.expiresAt).toLocaleDateString('zh-CN')}</span>
                                </div>
                                {editingId === item.id ? (
                                    <textarea value={editingContent} onChange={(event) => setEditingContent(event.target.value)} maxLength={4_000} rows={2} />
                                ) : (
                                    <p>{item.content}</p>
                                )}
                                <div className="pr-memory-governance-item-actions">
                                    {editingId === item.id ? (
                                        <button type="button" disabled={saving} onClick={() => void updateMemory(item.id)}>保存修改</button>
                                    ) : (
                                        <button type="button" disabled={saving} onClick={() => { setEditingId(item.id); setEditingContent(item.content) }}>编辑</button>
                                    )}
                                    <button type="button" disabled={saving} onClick={() => void deleteMemory(item.id)}>{confirmingId === item.id ? '再次确认删除' : '删除'}</button>
                                </div>
                            </article>
                    ))}
                    </div>
                </div>
            )}
        </section>
    )
}
