import { z } from 'zod'
import { isTrustedProviderEndpoint } from './security/provider-endpoint-policy.js'
import {
    parsePublicAppOrigins,
    parseRenderExternalOrigin,
} from './security/public-origin-policy.js'

/** 进程环境变量的唯一解析入口。 */
export const environmentSchema = z.object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
    HOST: z.string().trim().min(1).default('127.0.0.1'),

    DEEPSEEK_API_KEY: z.string().trim().default(''),
    DEEPSEEK_BASE_URL: z.string().url().refine(
        (value) => isTrustedProviderEndpoint('deepseek', value),
        '必须是官方 DeepSeek HTTPS 端点',
    ).default('https://api.deepseek.com'),
    MIMO_API_KEY: z.string().trim().default(''),
    MIMO_BASE_URL: z.string().url().refine(
        (value) => isTrustedProviderEndpoint('mimo', value),
        '必须是官方 MiMo HTTPS /v1 端点',
    ).default('https://api.xiaomimimo.com/v1'),

    DASHSCOPE_API_KEY: z.string().trim().default(''),
    // 项目官方文件固定使用标准版 wan2.7-image，pro 不能被环境变量悄悄替换。
    WAN_IMAGE_MODEL: z.literal('wan2.7-image').default('wan2.7-image'),
    // WorkspaceId 无法安全猜测；未配置时保持空并由路由诚实降级。配置后必须是
    // 北京 Workspace MaaS 的同步 multimodal-generation 端点，绝不回退旧全局域名。
    WAN_IMAGE_BASE_URL: z.string().trim().refine(
        (value) => value === '' || isTrustedProviderEndpoint('wan-image', value),
        '必须是官方 {WorkspaceId}.cn-beijing.maas.aliyuncs.com 同步文生图 HTTPS 端点',
    ).default(''),

    NEO4J_URI: z.string().trim().min(1).default('bolt://localhost:7687'),
    NEO4J_USER: z.string().trim().min(1).default('neo4j'),
    // 未显式配置时保持为空：知识图谱会按既有逻辑失败降级，避免示例弱口令被误用于部署。
    NEO4J_PASSWORD: z.string().default(''),
    SQLITE_PATH: z.string().trim().default(''),
    APP_DATA_DIR: z.string().trim().max(4_096).refine(
        (value) => !value.includes('\0'),
        '不得包含空字节',
    ).default(''),
    CREDENTIAL_VAULT_MASTER_KEY: z.string().default(''),
    DEMO_MODE: z.enum(['true', 'false']).default('false'),
    ALLOW_UNAUTHENTICATED_NON_LOOPBACK: z.enum(['true', 'false']).default('false'),

    // 公网同源服务使用 Render 自动注入地址；自定义域名必须显式列出精确 Origin。
    PUBLIC_APP_ORIGINS: z.string().trim().max(4_096).refine(
        (value) => {
            try {
                parsePublicAppOrigins(value)
                return true
            } catch {
                return false
            }
        },
        '必须是逗号分隔的精确 HTTPS Origin；HTTP 只允许回环地址，且不得含路径、凭据或通配符',
    ).default(''),
    RENDER_EXTERNAL_URL: z.string().trim().max(2_048).refine(
        (value) => {
            try {
                parseRenderExternalOrigin(value)
                return true
            } catch {
                return false
            }
        },
        '必须是精确的 HTTPS Origin，且不得含路径、凭据或通配符',
    ).default(''),
    // Render 自动注入 RENDER=true。该标志用于把运行时凭据管理切换为
    // Dashboard 托管且不可变，避免把明文密钥写入短暂的项目根 .env。
    RENDER: z.enum(['true', 'false']).default('false'),

    // 教师认证与会话。demo 只允许内置演示档案；password 使用 scrypt 摘要。
    AUTH_MODE: z.enum(['demo', 'password']).default('demo'),
    AUTH_SESSION_SECRET: z.string().default(''),
    AUTH_SESSION_TTL_MINUTES: z.coerce.number().int().min(5).max(1_440).default(480),
    AUTH_COOKIE_SECURE: z.enum(['auto', 'true', 'false']).default('auto'),
    AUTH_TEACHER_ID: z.string().trim().min(1).max(128).default('teacher-001'),
    AUTH_TEACHER_NAME: z.string().trim().min(1).max(80).default('王雅琴'),
    AUTH_TEACHER_PHONE: z.string().trim().regex(/^1[3-9]\d{9}$/u).default('13100000000'),
    AUTH_PASSWORD_SCRYPT: z.string().default(''),
})

export type Environment = z.infer<typeof environmentSchema>

/**
 * 严格解析配置，错误时只报告字段和原因，不回显密钥值。
 *
 * 旧实现只要任一字段无效，就悄悄丢弃全部有效配置并改用默认值；这会让
 * DEMO_MODE、数据库路径和服务地址同时失效。启动期明确失败更可诊断、更安全。
 */
export function parseEnvironment(input: Record<string, unknown>): Environment {
    const parsed = environmentSchema.safeParse(input)
    if (parsed.success) return parsed.data

    const details = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`)
        .join('；')
    throw new Error(`环境变量配置无效：${details}`)
}
