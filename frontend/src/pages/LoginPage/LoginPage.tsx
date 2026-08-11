/**
 * 登录页（v8 角色分离）
 *
 * 职责：
 * 1. 单一教师入口：工号 + 服务端认证模式要求的凭据
 * 2. 登录成功后进入教学驾驶舱
 * 3. demo 模式提供唯一公开演示主体的快捷登录
 * 4. password 模式失败关闭，不提供本地绕过
 *
 * 设计要点（规范第 2、4、5、6、7、14 章）：
 * - 暖调半透明背景 + 噪点纹理（非纯色）
 * - 玻璃态登录卡片（surface-elevated + backdrop-blur 20px）
 * - 无硬边框，透明度分层分隔区域
 * - 完整三态：hover/active/focus-visible
 * - 流体 clamp() 尺寸，600-2400px 视口无断裂
 * - 零 emoji，SVG 图标（Phosphor）
 * - 入场动画：淡入 + 上移（transform + opacity，GPU 加速）
 */

import { useState, useCallback, useEffect, useRef, type KeyboardEvent, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon, VariableProximity } from '@/components/ui'
import { useAuthStore } from '@/stores/auth'
import { getDefaultRoute } from '@/config/nav'
import { toast } from '@/stores/toast'
import { AuthSessionError, getAuthStatus, loginSession } from '@/lib/auth-session'
import './LoginPage.css'

/** 演示教师账号（点击即登录，免去演示时逐字输入） */
const DEMO_TEACHERS: ReadonlyArray<{ id: string; name: string; classLabel: string }> = [
    { id: 'teacher-001', name: '王雅琴', classLabel: '三年二班' },
]

/**
 * 诗雨氛围层 —— 垂直缓升的诗句列（内容即设计：背景装饰本身就是产品内容）
 * 极低透明度（3-5%），不干扰前景表单，仅在余光中可辨
 * 两列不同速度/相位，营造"异步呼吸"的纵深
 */
const POEM_RAIN_COLUMNS: ReadonlyArray<{ lines: readonly string[]; duration: number; delay: number; left: string }> = [
    {
        lines: ['床前明月光', '疑是地上霜', '举头望明月', '低头思故乡', '春眠不觉晓', '处处闻啼鸟'],
        duration: 56,
        delay: 0,
        left: '6%',
    },
    {
        lines: ['鹅，鹅，鹅', '曲项向天歌', '白毛浮绿水', '红掌拨清波', '锄禾日当午', '汗滴禾下土'],
        duration: 72,
        delay: -28,
        left: '88%',
    },
    {
        lines: ['白日依山尽', '黄河入海流', '欲穷千里目', '更上一层楼'],
        duration: 64,
        delay: -44,
        left: '16%',
    },
]

export default function LoginPage() {
    const navigate = useNavigate()
    const login = useAuthStore((s) => s.login)
    /** P6 融合：VariableProximity 容器 ref，标题字重随鼠标距离变化 */
    const cardRef = useRef<HTMLDivElement>(null)

    const [name, setName] = useState('')
    const [idNumber, setIdNumber] = useState('')
    const [password, setPassword] = useState('')
    const [authMode, setAuthMode] = useState<'loading' | 'unavailable' | 'demo' | 'password'>('loading')
    const [authStatusAttempt, setAuthStatusAttempt] = useState(0)
    const [submitting, setSubmitting] = useState(false)

    useEffect(() => {
        const controller = new AbortController()
        let active = true
        const timeout = window.setTimeout(() => controller.abort(), 8_000)
        setAuthMode('loading')
        void getAuthStatus(controller.signal)
            .then((status) => {
                if (active) setAuthMode(status.mode)
            })
            .catch(() => {
                if (active) setAuthMode('unavailable')
            })
            .finally(() => window.clearTimeout(timeout))
        return () => {
            active = false
            window.clearTimeout(timeout)
            controller.abort()
        }
    }, [authStatusAttempt])

    const handleLogin = useCallback(
        async (id: string, userName: string) => {
            if (authMode !== 'demo' && authMode !== 'password') {
                toast.error({
                    title: '尚未核验认证服务',
                    message: '为防止绕过服务器身份边界，请恢复服务并重新核验后再登录',
                })
                return
            }
            if (!id.trim() || (authMode === 'demo' && !userName.trim())) {
                toast.warning({
                    title: '请填写完整信息',
                    message: authMode === 'password' ? '教师工号为必填项' : '工号和姓名均为必填项',
                })
                return
            }
            if (authMode === 'password' && !password) {
                toast.warning({ title: '请输入密码', message: '当前部署已启用教师密码认证' })
                return
            }
            setSubmitting(true)
            try {
                const session = await loginSession({
                    teacherId: id.trim(),
                    name: userName.trim() || undefined,
                    password: authMode === 'password' ? password : undefined,
                })
                login({ id: session.user.id, name: session.user.name, role: session.user.role })
                toast.success({
                    title: `欢迎，${session.user.name}`,
                    message: '服务端会话已建立，正在进入教学驾驶舱',
                })
                navigate(getDefaultRoute(session.user.role), { replace: true })
            } catch (error) {
                if (error instanceof AuthSessionError) {
                    toast.error({
                        title: error.statusCode === 429 ? '登录尝试过多' : '登录失败',
                        message: error.message,
                    })
                    return
                }
                toast.error({
                    title: '认证服务不可达',
                    message: '登录默认失败关闭；请恢复服务器连接并重试，不能用本地状态绕过服务端会话',
                })
            } finally {
                setSubmitting(false)
            }
        },
        [authMode, login, navigate, password],
    )

    const handleSubmit = useCallback(() => {
        void handleLogin(idNumber, name)
    }, [idNumber, name, handleLogin])

    const handleKeyDown = useCallback(
        (e: KeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Enter') {
                handleSubmit()
            }
        },
        [handleSubmit],
    )

    const handleDemoLogin = useCallback(
        (demoId: string, demoName: string) => {
            void handleLogin(demoId, demoName)
        },
        [handleLogin],
    )

    /** 卡片光标聚光灯：跟随鼠标更新 CSS 变量，驱动 ::before 光韵与边框光 */
    const handleCardMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        const card = cardRef.current
        if (!card) return
        const rect = card.getBoundingClientRect()
        card.style.setProperty('--spot-x', `${(((e.clientX - rect.left) / rect.width) * 100).toFixed(2)}%`)
        card.style.setProperty('--spot-y', `${(((e.clientY - rect.top) / rect.height) * 100).toFixed(2)}%`)
    }, [])

    const handleCardMouseLeave = useCallback(() => {
        const card = cardRef.current
        if (!card) return
        card.style.setProperty('--spot-x', '50%')
        card.style.setProperty('--spot-y', '-20%')
    }, [])

    return (
        <div className="pr-login">
            {/* 背景装饰层 —— 暖调渐变光晕（缓慢漂移呼吸） */}
            <div className="pr-login-bg" aria-hidden="true">
                <div className="pr-login-bg-glow pr-login-bg-glow--primary" />
                <div className="pr-login-bg-glow pr-login-bg-glow--secondary" />
            </div>

            {/* 诗雨氛围层 —— 垂直缓升的诗句列（内容即设计，极低透明度） */}
            <div className="pr-login-poem-rain" aria-hidden="true">
                {POEM_RAIN_COLUMNS.map((col, ci) => (
                    <div
                        key={ci}
                        className="pr-login-poem-col"
                        style={
                            {
                                left: col.left,
                                '--rain-duration': `${col.duration}s`,
                                '--rain-delay': `${col.delay}s`,
                            } as CSSProperties
                        }
                    >
                        <div className="pr-login-poem-track">
                            {/* 双份内容实现无缝循环 */}
                            {[0, 1].map((copy) => (
                                <div key={copy} className="pr-login-poem-set">
                                    {col.lines.map((line, li) => (
                                        <span key={li} className="pr-login-poem-line">
                                            {line}
                                        </span>
                                    ))}
                                </div>
                            ))}
                        </div>
                    </div>
                ))}
            </div>

            <main className="pr-login-main">
                <div
                    ref={cardRef}
                    className="pr-login-card pr-login-enter"
                    onMouseMove={handleCardMouseMove}
                    onMouseLeave={handleCardMouseLeave}
                >
                    {/* 品牌区 */}
                    <header className="pr-login-brand">
                        <div className="pr-login-logo" aria-hidden="true">
                            <Icon name="graduation" size={32} weight="bold" />
                        </div>
                        <h1 className="pr-login-title">
                            <VariableProximity
                                label="诗脉·启明"
                                fromFontVariationSettings="'wght' 400, 'opsz' 14"
                                toFontVariationSettings="'wght' 700, 'opsz' 36"
                                containerRef={cardRef}
                                radius={140}
                                falloff="gaussian"
                            />
                        </h1>
                        <p className="pr-login-tagline">
                            PoeticRealm AI · 古诗词智能教学系统
                        </p>
                    </header>

                    {/* 身份说明：单一教师端，不再提供角色切换 */}
                    <div className="pr-login-identity">
                        <Icon name="graduation" size={14} />
                        <span>教师工作台</span>
                    </div>

                    {/* 表单区 */}
                    <div className="pr-login-form">
                        {authMode === 'loading' && (
                            <div className="pr-login-auth-state" role="status" aria-live="polite">
                                <Icon name="circle-notch" size={16} />
                                <span>正在核验服务器认证模式…</span>
                            </div>
                        )}

                        {authMode === 'unavailable' && (
                            <div className="pr-login-auth-state pr-login-auth-state--error" role="alert">
                                <Icon name="warning" size={16} />
                                <span>认证服务暂时不可用。系统已阻止本地身份绕过。</span>
                                <button type="button" onClick={() => setAuthStatusAttempt((value) => value + 1)}>
                                    重新核验
                                </button>
                            </div>
                        )}

                        {authMode === 'demo' && (
                            <div className="pr-login-field">
                                <label className="pr-login-label" htmlFor="login-name">
                                    教师姓名
                                </label>
                                <div className="pr-login-input-wrap">
                                    <Icon name="user" size={16} className="pr-login-input-icon" />
                                    <input
                                        id="login-name"
                                        className="pr-login-input"
                                        type="text"
                                        value={name}
                                        onChange={(e) => setName(e.target.value)}
                                        onKeyDown={handleKeyDown}
                                        placeholder="请输入您的姓名"
                                        autoComplete="off"
                                        spellCheck={false}
                                    />
                                </div>
                            </div>
                        )}

                        <div className="pr-login-field">
                            <label className="pr-login-label" htmlFor="login-id">
                                教师工号
                            </label>
                            <div className="pr-login-input-wrap">
                                <Icon name="identification-card" size={16} className="pr-login-input-icon" />
                                <input
                                    id="login-id"
                                    className="pr-login-input"
                                    type="text"
                                    value={idNumber}
                                    onChange={(e) => setIdNumber(e.target.value)}
                                    onKeyDown={handleKeyDown}
                                    placeholder="请输入您的工号"
                                    autoComplete="off"
                                    spellCheck={false}
                                />
                            </div>
                        </div>

                        {authMode === 'password' && (
                            <div className="pr-login-field">
                                <label className="pr-login-label" htmlFor="login-password">
                                    教师密码
                                </label>
                                <div className="pr-login-input-wrap">
                                    <Icon name="shield-check" size={16} className="pr-login-input-icon" />
                                    <input
                                        id="login-password"
                                        className="pr-login-input"
                                        type="password"
                                        value={password}
                                        onChange={(e) => setPassword(e.target.value)}
                                        onKeyDown={handleKeyDown}
                                        placeholder="请输入教师密码"
                                        autoComplete="current-password"
                                    />
                                </div>
                            </div>
                        )}

                        <button
                            type="button"
                            className="pr-login-submit"
                            onClick={handleSubmit}
                            disabled={authMode === 'loading' || authMode === 'unavailable' || submitting || !idNumber.trim() || (authMode === 'demo' && !name.trim()) || (authMode === 'password' && !password)}
                        >
                            <span>{submitting ? '正在建立安全会话…' : '进入教学驾驶舱'}</span>
                            <Icon name={submitting ? 'circle-notch' : 'arrow-right'} size={16} />
                        </button>
                    </div>

                    {/* 分隔线 */}
                    {authMode === 'demo' && (
                        <>
                            <div className="pr-login-divider">
                                <span className="pr-login-divider-text">或选择服务器允许的演示账号</span>
                            </div>

                            {/* 演示账号快捷区：服务器仍会校验白名单并签发 HttpOnly 会话。 */}
                            <div className="pr-login-demo">
                                {DEMO_TEACHERS.map((item) => (
                                    <button
                                        key={item.id}
                                        type="button"
                                        className="pr-login-demo-btn"
                                        onClick={() => handleDemoLogin(item.id, item.name)}
                                        disabled={submitting}
                                    >
                                        <span className="pr-login-demo-avatar">
                                            {item.name.charAt(0)}
                                        </span>
                                        <span className="pr-login-demo-info">
                                            <span className="pr-login-demo-name">{item.name}</span>
                                            <span className="pr-login-demo-class">{item.classLabel}</span>
                                        </span>
                                        <Icon name="caret-right" size={14} className="pr-login-demo-arrow" />
                                    </button>
                                ))}
                            </div>
                        </>
                    )}
                </div>

                <footer className="pr-login-footer">
                    <span>诗脉·启明 PoeticRealm AI v5.0</span>
                </footer>
            </main>
        </div>
    )
}
