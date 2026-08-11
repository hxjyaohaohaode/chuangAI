import dotenv from 'dotenv'
import { parseEnvironment } from './environment.js'
import { assertSafeNetworkBoundary } from './security/network-boundary.js'
import { isSupportedScryptHash } from './security/scrypt-password.js'
import { parseTrustedDeploymentOrigins } from './security/public-origin-policy.js'
import { resolveRuntimePaths } from './runtime-paths.js'

// 加载 .env 环境变量
dotenv.config()

const env = parseEnvironment(process.env)

/**
 * 认证的 Origin 白名单必须在进程启动时固定，不能从单次请求的 Host 推导。
 * 开发服务器固定在 5173；生产同源静态服务使用 Render 自动外部地址或
 * PUBLIC_APP_ORIGINS 中经过严格解析的自定义 HTTPS Origin。
 */
export function buildLoopbackCorsOrigins(port: number): readonly string[] {
    return [...new Set([
        'http://localhost:5173',
        'http://127.0.0.1:5173',
        `http://localhost:${port}`,
        `http://127.0.0.1:${port}`,
    ])]
}

export function buildCorsOrigins(
    port: number,
    publicAppOrigins: string,
    renderExternalUrl: string,
    nodeEnv: 'development' | 'production' | 'test' = 'development',
): readonly string[] {
    const deploymentOrigins = parseTrustedDeploymentOrigins(publicAppOrigins, renderExternalUrl)
    // 一旦生产公网 Origin 已明确，移除开发回环来源，进一步缩小 CSRF/WS 信任面。
    // 无公网 Origin 的本机 production build 仍保留回环端，便于受控离线验收。
    const loopbackOrigins = nodeEnv === 'production' && deploymentOrigins.length > 0
        ? []
        : buildLoopbackCorsOrigins(port)
    return [...new Set([
        ...loopbackOrigins,
        ...deploymentOrigins,
    ])]
}

// 全局配置对象
export const config = {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    host: env.HOST,
    isDev: env.NODE_ENV === 'development',
    isRender: env.RENDER === 'true',

    deepseek: {
        apiKey: env.DEEPSEEK_API_KEY,
        baseUrl: env.DEEPSEEK_BASE_URL,
    },

    mimo: {
        apiKey: env.MIMO_API_KEY,
        baseUrl: env.MIMO_BASE_URL,
    },

    wanImage: {
        apiKey: env.DASHSCOPE_API_KEY,
        model: env.WAN_IMAGE_MODEL,
        baseUrl: env.WAN_IMAGE_BASE_URL,
        enabled: env.DASHSCOPE_API_KEY.length > 0 && env.WAN_IMAGE_BASE_URL.length > 0,
    },

    neo4j: {
        uri: env.NEO4J_URI,
        user: env.NEO4J_USER,
        password: env.NEO4J_PASSWORD,
    },

    // SQLite 学情数据库（空值时使用默认路径 ./data/poetic-realm.db）
    sqlite: {
        path: env.SQLITE_PATH,
    },

    // SQLite、批改上传、生成 WebP、朗诵录音与 TTS 缓存共享同一数据根。
    runtimePaths: resolveRuntimePaths(env.APP_DATA_DIR),
    credentialVaultMasterKey: env.CREDENTIAL_VAULT_MASTER_KEY,

    // 演示模式：跳过 API 密钥校验
    demoMode: env.DEMO_MODE === 'true',

    // 仅供“容器内部非回环监听 + 宿主机回环端口映射”的受控场景使用。
    // 它允许 demo 认证模式存在于受控容器网络内，裸机/公网部署不得开启。
    allowUnauthenticatedNonLoopback: env.ALLOW_UNAUTHENTICATED_NON_LOOPBACK === 'true',

    auth: {
        mode: env.AUTH_MODE,
        sessionSecret: env.AUTH_SESSION_SECRET,
        sessionTtlSeconds: env.AUTH_SESSION_TTL_MINUTES * 60,
        cookieSecure: env.AUTH_COOKIE_SECURE,
        teacherId: env.AUTH_TEACHER_ID,
        teacherName: env.AUTH_TEACHER_NAME,
        teacherPhone: env.AUTH_TEACHER_PHONE,
        passwordScrypt: env.AUTH_PASSWORD_SCRYPT,
    },

    // 前端来源（CORS/CSRF Origin 白名单）。启动时固定，绝不根据请求 Host 扩容。
    corsOrigins: buildCorsOrigins(
        env.PORT,
        env.PUBLIC_APP_ORIGINS,
        env.RENDER_EXTERNAL_URL,
        env.NODE_ENV,
    ),
} as const

export type AppConfig = typeof config

/** 在数据库、密钥客户端等有副作用资源初始化前，先阻断危险监听配置。 */
export function validateNetworkBoundary(): void {
    assertSafeNetworkBoundary({
        host: config.host,
        allowUnauthenticatedNonLoopback: config.allowUnauthenticatedNonLoopback,
        passwordAuthenticationEnabled: config.auth.mode === 'password',
        secureCookieConfigured: config.auth.cookieSecure === 'true',
    })
}

export interface AuthConfigurationInput {
    mode: 'demo' | 'password'
    sessionSecret: string
    passwordScrypt: string
}

/** 纯校验入口便于验证所有危险配置分支，不依赖进程环境。 */
export function assertValidAuthConfiguration(auth: AuthConfigurationInput): void {
    if (auth.sessionSecret.length > 0 && Buffer.byteLength(auth.sessionSecret, 'utf8') < 32) {
        throw new Error('启动失败：显式 AUTH_SESSION_SECRET 必须至少 32 字节。')
    }
    if (auth.mode === 'demo') return

    if (Buffer.byteLength(auth.sessionSecret, 'utf8') < 32) {
        throw new Error('启动失败：AUTH_MODE=password 时必须配置至少 32 字节的 AUTH_SESSION_SECRET。')
    }
    if (!isSupportedScryptHash(auth.passwordScrypt)) {
        throw new Error('启动失败：AUTH_PASSWORD_SCRYPT 不是受支持且可执行的 scrypt 摘要。')
    }
}

/** 在数据库初始化前阻断会导致伪认证或不可恢复登录的配置。 */
export function validateAuthConfiguration(): void {
    assertValidAuthConfiguration(config.auth)
}

// ─────────────────────────────────────────────────────────────
// 启动期 API 密钥校验
// ─────────────────────────────────────────────────────────────

/**
 * 启动期校验 DeepSeek / MiMo API 密钥是否已配置
 *
 * 在 server.ts 的 listen 之前调用。若任一密钥为空且未开启演示模式，
 * 抛出明确错误以避免服务启动后首次调用 AI 即 401。
 *
 * 演示模式（DEMO_MODE=true）下跳过校验，便于无密钥环境联调。
 */
export function validateApiKeys(): void {
    // Render 的模型凭据由登录后的所有者写入持久盘加密保险柜；首次部署必须先能
    // 启动，才能完成这一步。具体 AI 路由在未配置时已有明确降级响应。
    if (config.isRender) return
    if (config.demoMode) {
        console.warn('[config] 演示模式已开启（DEMO_MODE=true），跳过 API 密钥校验。AI 调用将无法正常工作。')
        return
    }

    const missing: string[] = []
    if (!config.deepseek.apiKey) {
        missing.push('DEEPSEEK_API_KEY')
    }
    if (!config.mimo.apiKey) {
        missing.push('MIMO_API_KEY')
    }

    if (missing.length > 0) {
        throw new Error(
            `启动失败：缺少 API 密钥 [${missing.join(', ')}]。` +
            '请检查 .env 文件，或设置 DEMO_MODE=true 以演示模式启动。',
        )
    }
}
