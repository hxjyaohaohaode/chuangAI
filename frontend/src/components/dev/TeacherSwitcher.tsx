/**
 * 教师身份切换器（P1-B：让 useAuthStore.setTeacher 有调用入口）
 *
 * 用途：开发环境切换教师身份用于演示，生产环境不展示。
 *
 * 设计：
 * - 显示当前教师名（从 useAuthStore 读取）
 * - 点击展开下拉，输入新教师 ID + 名称
 * - 提交后调用 setTeacher，全局切换身份
 * - 用 CSS 变量 + className，无硬编码样式
 * - 完整焦点管理：ESC 关闭 + Tab 焦点陷阱 + 初始焦点 + 焦点恢复（规范 14.4 / WCAG 2.4.3）
 */

import { useState, useRef, useEffect } from 'react'
import { Button, Icon } from '@/components/ui'
import { useAuthStore } from '@/stores/auth'
import { loginSession } from '@/lib/auth-session'
import { toast } from '@/stores/toast'

export function TeacherSwitcher() {
    const teacherName = useAuthStore((s) => s.teacherName)
    const setTeacher = useAuthStore((s) => s.setTeacher)
    const [open, setOpen] = useState(false)
    const [inputPhone, setInputPhone] = useState('')
    const [inputPassword, setInputPassword] = useState('')
    const buttonRef = useRef<HTMLButtonElement | null>(null)
    const panelRef = useRef<HTMLFormElement | null>(null)
    const lastFocused = useRef<HTMLElement | null>(null)

    const handleSubmit = async () => {
        const phone = inputPhone.trim()
        if (!phone || !inputPassword) return
        try {
            const session = await loginSession({ phone, password: inputPassword })
            setTeacher(session.user.id, session.user.name)
            setOpen(false)
            setInputPhone('')
            setInputPassword('')
        } catch (error) {
            toast.error({
                title: '身份切换失败',
                message: error instanceof Error ? error.message : '服务器拒绝了该教师身份',
            })
        }
    }

    // ESC 关闭 + 点击外部关闭 + 焦点陷阱 + 初始焦点（规范 14.4 / WCAG 2.4.3）
    useEffect(() => {
        if (!open) return

        lastFocused.current = document.activeElement as HTMLElement | null

        const onClickOutside = (e: MouseEvent) => {
            const target = e.target as Node
            if (
                panelRef.current && !panelRef.current.contains(target) &&
                buttonRef.current && !buttonRef.current.contains(target)
            ) {
                setOpen(false)
            }
        }
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation()
                setOpen(false)
                return
            }
            // 焦点陷阱：Tab/Shift+Tab 循环约束在面板内
            if (e.key === 'Tab' && panelRef.current) {
                const focusables = panelRef.current.querySelectorAll<HTMLElement>(
                    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
                )
                if (focusables.length === 0) {
                    e.preventDefault()
                    panelRef.current.focus()
                    return
                }
                const first = focusables[0]
                const last = focusables[focusables.length - 1]
                if (!first || !last) {
                    e.preventDefault()
                    panelRef.current.focus()
                    return
                }
                const active = document.activeElement as HTMLElement | null
                if (e.shiftKey) {
                    if (active === first || !panelRef.current.contains(active)) {
                        e.preventDefault()
                        last.focus()
                    }
                } else {
                    if (active === last || !panelRef.current.contains(active)) {
                        e.preventDefault()
                        first.focus()
                    }
                }
            }
        }
        document.addEventListener('mousedown', onClickOutside)
        document.addEventListener('keydown', onKey)

        // 初始焦点：打开时聚焦到首个输入框
        const t = window.setTimeout(() => {
            const focusable = panelRef.current?.querySelector<HTMLElement>(
                'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
            )
                ; (focusable ?? panelRef.current)?.focus()
        }, 0)

        return () => {
            document.removeEventListener('mousedown', onClickOutside)
            document.removeEventListener('keydown', onKey)
            window.clearTimeout(t)
        }
    }, [open])

    // 焦点恢复：关闭时还原到触发按钮（规范 14.4 / WCAG 2.4.3）
    useEffect(() => {
        if (open) return
        const prev = lastFocused.current
        if (prev && typeof prev.focus === 'function') {
            prev.focus()
            lastFocused.current = null
        }
    }, [open])

    return (
        <div className="pr-teacher-switcher">
            <Button
                ref={buttonRef}
                variant="ghost"
                size="sm"
                leftIcon={<Icon name="user-circle" size={16} />}
                onClick={() => setOpen((v) => !v)}
                aria-label="切换教师身份"
                aria-expanded={open}
                aria-haspopup="dialog"
            >
                <span>{teacherName}</span>
            </Button>
            {open && (
                <form
                    ref={panelRef}
                    className="pr-teacher-switcher-panel"
                    role="dialog"
                    aria-modal="true"
                    aria-label="教师身份切换"
                    tabIndex={-1}
                    onSubmit={(e) => {
                        e.preventDefault()
                        void handleSubmit()
                    }}
                >
                    <div className="pr-teacher-switcher-row">
                        <label className="pr-teacher-switcher-label">当前教师</label>
                        <span className="pr-teacher-switcher-value">{teacherName}</span>
                    </div>
                    <input
                        className="pr-teacher-switcher-input"
                        type="text"
                        inputMode="numeric"
                        placeholder="教师手机号"
                        value={inputPhone}
                        onChange={(e) => setInputPhone(e.target.value.replace(/\D/gu, '').slice(0, 11))}
                        aria-label="教师手机号"
                    />
                    <input
                        className="pr-teacher-switcher-input"
                        type="password"
                        placeholder="登录密码"
                        value={inputPassword}
                        onChange={(e) => setInputPassword(e.target.value)}
                        aria-label="登录密码"
                    />
                    <Button type="submit" size="sm" disabled={inputPhone.length !== 11 || !inputPassword}>
                        <Icon name="check" size={14} />
                        <span>切换</span>
                    </Button>
                </form>
            )}
        </div>
    )
}
