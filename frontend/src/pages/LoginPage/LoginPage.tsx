import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from '@/components/ui'
import { useAuthStore } from '@/stores/auth'
import { getDefaultRoute } from '@/config/nav'
import { toast } from '@/stores/toast'
import {
    AuthSessionError,
    getAuthStatus,
    loginSession,
    type DemoTeacher,
} from '@/lib/auth-session'
import './LoginPage.css'

const METEORS = [
    [7, 8, 10, -1], [18, 22, 14, -6], [33, 6, 11, -3], [47, 18, 16, -10],
    [62, 4, 13, -8], [77, 26, 15, -4], [88, 10, 12, -11], [12, 54, 17, -9],
    [29, 68, 12, -2], [52, 58, 18, -13], [70, 72, 14, -7], [91, 61, 16, -5],
] as const

function MeteorField() {
    return (
        <div className="pr-login-lightfall" data-login-decoration="meteor-css" aria-hidden="true">
            <span className="pr-login-lightfall__beam pr-login-lightfall__beam--a" />
            <span className="pr-login-lightfall__beam pr-login-lightfall__beam--b" />
            {METEORS.map(([left, top, duration, delay], index) => (
                <span
                    key={`${left}-${top}`}
                    className="pr-login-meteor"
                    style={{
                        '--meteor-left': `${left}%`,
                        '--meteor-top': `${top}%`,
                        '--meteor-duration': `${duration}s`,
                        '--meteor-delay': `${delay}s`,
                        '--meteor-depth': `${0.58 + (index % 4) * 0.12}`,
                    } as CSSProperties}
                />
            ))}
        </div>
    )
}

export default function LoginPage() {
    const navigate = useNavigate()
    const login = useAuthStore((state) => state.login)
    const [phone, setPhone] = useState('')
    const [password, setPassword] = useState('')
    const [demoAccounts, setDemoAccounts] = useState<DemoTeacher[]>([])
    const [authReady, setAuthReady] = useState<'loading' | 'ready' | 'unavailable'>('loading')
    const [statusAttempt, setStatusAttempt] = useState(0)
    const [submitting, setSubmitting] = useState(false)

    useEffect(() => {
        const controller = new AbortController()
        let active = true
        setAuthReady('loading')
        void getAuthStatus(controller.signal)
            .then((status) => {
                if (!active) return
                setDemoAccounts(status.demoTeachers)
                setAuthReady('ready')
            })
            .catch(() => {
                if (active) setAuthReady('unavailable')
            })
        return () => {
            active = false
            controller.abort()
        }
    }, [statusAttempt])

    const handleSubmit = useCallback(async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        const normalizedPhone = phone.trim()
        if (authReady !== 'ready') {
            toast.error({ title: '认证服务尚未就绪', message: '请恢复服务器连接并重新核验' })
            return
        }
        if (!/^1[3-9]\d{9}$/u.test(normalizedPhone) || !password) {
            toast.warning({ title: '请检查登录信息', message: '请输入正确的 11 位手机号和密码' })
            return
        }
        setSubmitting(true)
        try {
            const session = await loginSession({ phone: normalizedPhone, password })
            login({ id: session.user.id, name: session.user.name, role: session.user.role })
            toast.success({
                title: `欢迎，${session.user.name}`,
                message: session.user.accountType === 'demo'
                    ? '已进入只读凭据边界下的合成演示空间'
                    : '安全会话已建立，模型凭据可在系统设置中管理',
            })
            navigate(getDefaultRoute(session.user.role), { replace: true })
        } catch (error) {
            if (error instanceof AuthSessionError) {
                toast.error({
                    title: error.statusCode === 429 ? '登录尝试过多' : '手机号或密码错误',
                    message: error.message,
                })
            } else {
                toast.error({ title: '认证服务不可达', message: '系统已阻止本地身份绕过，请稍后重试' })
            }
        } finally {
            setSubmitting(false)
        }
    }, [authReady, login, navigate, password, phone])

    const demoAccount = demoAccounts[0]

    return (
        <div className="pr-login">
            <MeteorField />
            <div className="pr-login-grain" aria-hidden="true" />

            <main className="pr-login-layout">
                <section className="pr-login-story" aria-labelledby="login-story-title">
                    <p className="pr-login-kicker">POETIC REALM · AI TEACHING</p>
                    <h1 id="login-story-title">让每一次课堂洞察，<br />都有清晰的来处。</h1>
                    <p className="pr-login-story-copy">
                        从学情诊断到课堂共舞，把古诗词教学中的证据、判断与行动连接成可追溯的闭环。
                    </p>
                    <div className="pr-login-story-mark" aria-hidden="true">
                        <span>诗</span><i /> <span>教</span><i /> <span>智</span>
                    </div>
                </section>

                <section className="pr-login-card" aria-labelledby="login-title">
                    <header className="pr-login-brand">
                        <span className="pr-login-seal" aria-hidden="true">启明</span>
                        <div>
                            <p className="pr-login-eyebrow">教师安全入口</p>
                            <h2 id="login-title">登录诗脉·启明</h2>
                        </div>
                    </header>

                    <form className="pr-login-form" onSubmit={(event) => void handleSubmit(event)}>
                        {authReady === 'loading' && (
                            <div className="pr-login-auth-state" role="status">
                                <Icon name="circle-notch" size={16} className="pr-app-spin" />
                                <span>正在核验安全登录服务…</span>
                            </div>
                        )}
                        {authReady === 'unavailable' && (
                            <div className="pr-login-auth-state pr-login-auth-state--error" role="alert">
                                <Icon name="warning" size={16} />
                                <span>认证服务暂时不可用，已禁止本地绕过。</span>
                                <button type="button" onClick={() => setStatusAttempt((value) => value + 1)}>重新核验</button>
                            </div>
                        )}

                        <label className="pr-login-field" htmlFor="login-phone">
                            <span>手机号</span>
                            <span className="pr-login-input-wrap">
                                <Icon name="phone" size={17} aria-hidden={true} />
                                <input
                                    id="login-phone"
                                    value={phone}
                                    onChange={(event) => setPhone(event.target.value.replace(/\D/gu, '').slice(0, 11))}
                                    type="tel"
                                    inputMode="numeric"
                                    autoComplete="username"
                                    placeholder="请输入 11 位手机号"
                                    maxLength={11}
                                    required
                                />
                            </span>
                        </label>

                        <label className="pr-login-field" htmlFor="login-password">
                            <span>密码</span>
                            <span className="pr-login-input-wrap">
                                <Icon name="shield-check" size={17} aria-hidden={true} />
                                <input
                                    id="login-password"
                                    value={password}
                                    onChange={(event) => setPassword(event.target.value)}
                                    type="password"
                                    autoComplete="current-password"
                                    placeholder="请输入登录密码"
                                    maxLength={512}
                                    required
                                />
                            </span>
                        </label>

                        <button
                            className="pr-login-submit"
                            type="submit"
                            disabled={authReady !== 'ready' || submitting || phone.length !== 11 || !password}
                        >
                            <span>{submitting ? '正在建立安全会话…' : '进入教学驾驶舱'}</span>
                            <Icon name={submitting ? 'circle-notch' : 'arrow-right'} size={17} />
                        </button>
                    </form>

                    {demoAccount && (
                        <aside className="pr-login-demo" aria-label="演示账号提示">
                            <div>
                                <strong>演示部署快捷入口</strong>
                                <span>输入对应密码后进入；权限由部署配置决定</span>
                            </div>
                            <button type="button" onClick={() => setPhone(demoAccount.phone)}>
                                填入演示手机号
                            </button>
                        </aside>
                    )}

                    <p className="pr-login-security-note">
                        <Icon name="lock" size={13} aria-hidden={true} />
                        密码仅用于服务端单向校验；会话使用 HttpOnly 安全 Cookie。
                    </p>
                </section>
            </main>
        </div>
    )
}
