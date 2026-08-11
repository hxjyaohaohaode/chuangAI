import type { UserRole } from '@/stores/auth'

const CSRF_COOKIE = 'pr_csrf'
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const AUTH_REQUEST_TIMEOUT_MS = 10_000
const AUTH_TIMEOUT_REASON = 'auth-request-timeout'

export interface SessionUser {
    id: string
    name: string
    role: UserRole
}

export interface DemoTeacher extends SessionUser {
    role: 'teacher'
    classLabel: string
}

export interface AuthStatusResponse {
    status: 'ok'
    mode: 'demo' | 'password'
    authenticated: boolean
    user: SessionUser | null
    expiresAt: number | null
    demoTeachers: DemoTeacher[]
}

export interface LoginResponse {
    status: 'ok'
    authenticated: true
    user: SessionUser
    expiresAt: number
    csrfToken: string
}

export class AuthSessionError extends Error {
    constructor(
        public readonly statusCode: number,
        message: string,
        public readonly errorCode?: string,
    ) {
        super(message)
        this.name = 'AuthSessionError'
    }
}

function linkAbortSignal(externalSignal: AbortSignal | undefined, controller: AbortController): () => void {
    if (!externalSignal) return () => undefined
    if (externalSignal.aborted) {
        controller.abort(externalSignal.reason)
        return () => undefined
    }
    const onAbort = () => controller.abort(externalSignal.reason)
    externalSignal.addEventListener('abort', onAbort, { once: true })
    return () => externalSignal.removeEventListener('abort', onAbort)
}

/**
 * 认证端点必须有独立的总体时限，且时限要覆盖 JSON 正文消费。
 * 业务 API 的超时由 api.ts 的 fetchJSON/fetchBlob 管理；这里仅包住
 * /api/auth/* 的 fetch + parse，避免登录页或应用启动因半截响应永久等待。
 */
async function withAuthTimeout<T>(externalSignal: AbortSignal | undefined, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    const unlink = linkAbortSignal(externalSignal, controller)
    const timeoutId = window.setTimeout(() => controller.abort(AUTH_TIMEOUT_REASON), AUTH_REQUEST_TIMEOUT_MS)
    try {
        return await task(controller.signal)
    } catch (error) {
        if (controller.signal.reason === AUTH_TIMEOUT_REASON) {
            throw new AuthSessionError(408, '认证请求超时，请稍后重试', 'AUTH_TIMEOUT')
        }
        throw error
    } finally {
        window.clearTimeout(timeoutId)
        unlink()
    }
}

function readCookie(name: string): string | undefined {
    if (typeof document === 'undefined') return undefined
    for (const item of document.cookie.split(';')) {
        const separator = item.indexOf('=')
        if (separator <= 0 || item.slice(0, separator).trim() !== name) continue
        try {
            return decodeURIComponent(item.slice(separator + 1).trim())
        } catch {
            return undefined
        }
    }
    return undefined
}

function methodOf(init?: RequestInit): string {
    return (init?.method ?? 'GET').toUpperCase()
}

/**
 * 所有业务请求的唯一传输边界：同源 Cookie 自动携带，写请求附加双提交 CSRF。
 * 401 只广播“会话失效”，由应用根组件统一清理状态，避免各业务模块循环依赖 auth store。
 */
export async function authenticatedFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    if (MUTATING_METHODS.has(methodOf(init))) {
        const csrf = readCookie(CSRF_COOKIE)
        if (csrf) headers.set('X-CSRF-Token', csrf)
    }
    const response = await fetch(input, {
        ...init,
        headers,
        credentials: 'same-origin',
    })
    if (response.status === 401 && typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('pr:auth-expired'))
    }
    return response
}

async function parseAuthResponse<T>(response: Response, signal: AbortSignal): Promise<T> {
    let body: null | {
        message?: string
        error?: string
    } = null
    try {
        // 调用方的认证超时信号保持到正文消费结束；不要把 AbortError
        // catch 成空对象，否则 200 半截正文会被误判成成功或 401 超时。
        body = await response.json() as null | {
            message?: string
            error?: string
        }
    } catch (error) {
        if (signal.aborted) throw error
    }
    if (!response.ok) {
        throw new AuthSessionError(
            response.status,
            body?.message ?? '登录服务暂时不可用',
            body?.error,
        )
    }
    return body as T
}

export async function getAuthStatus(signal?: AbortSignal): Promise<AuthStatusResponse> {
    return withAuthTimeout(signal, async (requestSignal) => {
        const response = await authenticatedFetch('/api/auth/status', { signal: requestSignal })
        return parseAuthResponse<AuthStatusResponse>(response, requestSignal)
    })
}

export async function loginSession(input: {
    teacherId: string
    name?: string
    password?: string
}): Promise<LoginResponse> {
    return withAuthTimeout(undefined, async (requestSignal) => {
        const response = await authenticatedFetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(input),
            signal: requestSignal,
        })
        return parseAuthResponse<LoginResponse>(response, requestSignal)
    })
}

export async function logoutSession(): Promise<void> {
    await withAuthTimeout(undefined, async (requestSignal) => {
        const response = await authenticatedFetch('/api/auth/logout', { method: 'POST', signal: requestSignal })
        if (response.status === 401) return
        await parseAuthResponse<{ status: 'ok'; authenticated: false }>(response, requestSignal)
    })
}
