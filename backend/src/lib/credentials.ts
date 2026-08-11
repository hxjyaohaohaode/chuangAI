/**
 * 模型凭据运行时管理
 *
 * ─────────────────────────────────────────────────────────────
 * 为什么需要它
 * ─────────────────────────────────────────────────────────────
 * `config.ts` 导出的是 `as const` 冻结字面量，密钥只能在进程启动时从 .env 读一次。
 * 但教师需要能在界面上换成自己的密钥（换账号、额度用尽、换供应商），
 * 不应该被迫去改服务器文件再重启。
 *
 * 本模块把三组密钥抽出来做成**运行时可变 + 落盘持久化**的一层：
 *   - 进程内：改完立即生效，LLM 客户端会重建连接实例
 *   - 磁盘上：写回 .env，重启后依然生效
 *
 * ─────────────────────────────────────────────────────────────
 * 安全约定（重要）
 * ─────────────────────────────────────────────────────────────
 * 1. 密钥**只出不进**是禁止的方向——对外任何读取接口一律只返回掩码
 *    （`sk-****3f2a`），完整明文永远不离开服务端；
 * 2. 写入 .env 时只替换对应行，不重排、不丢注释，避免破坏运维手写的配置；
 * 3. 掩码保留首 3 位与末 4 位，长度不足 8 位时整串打码，避免短密钥被反推。
 */

import { resolve } from 'node:path'
import { config } from '../config.js'
import { normalizeCredentialKey, persistCredentialAtomically } from '../security/credential-file.js'

/** 可在运行时配置的模型供应商 */
export type CredentialProvider = 'deepseek' | 'mimo' | 'dashscope'

/** 各供应商对应的 .env 变量名 */
const ENV_KEY: Record<CredentialProvider, string> = {
    deepseek: 'DEEPSEEK_API_KEY',
    mimo: 'MIMO_API_KEY',
    dashscope: 'DASHSCOPE_API_KEY',
}

/** 供应商展示信息（前端设置面板直接消费，避免两端各维护一份文案） */
export const PROVIDER_META: Record<CredentialProvider, {
    label: string
    /** 该密钥驱动的能力 */
    powers: string
    /** 申请地址 */
    console: string
}> = {
    deepseek: {
        label: 'DeepSeek',
        powers: '命题 / 诊断 / 批改 / 报告 / 副驾对话',
        console: 'https://platform.deepseek.com',
    },
    mimo: {
        label: 'MiMo（小米）',
        powers: '语音合成范读 / 朗读转写 / 多模态图像识别',
        console: 'https://api.xiaomimimo.com',
    },
    dashscope: {
        label: '阿里云百炼',
        powers: '诗境插画生成（wan2.7-image）',
        console: 'https://bailian.console.aliyun.com',
    },
}

/** 运行时密钥表，初值取自 .env */
const runtimeKeys: Record<CredentialProvider, string> = {
    deepseek: config.deepseek.apiKey,
    mimo: config.mimo.apiKey,
    dashscope: config.wanImage.apiKey,
}

/** 密钥变更订阅者（LLM 客户端据此重建连接） */
type Listener = (provider: CredentialProvider, key: string) => void
const listeners: Listener[] = []

/** 订阅密钥变更 */
export function onCredentialChange(fn: Listener): void {
    listeners.push(fn)
}

/** 读取当前生效的密钥（仅供服务端内部调用，切勿直接返回给前端） */
export function getKey(provider: CredentialProvider): string {
    return runtimeKeys[provider]
}

/**
 * 掩码化
 *
 * @example maskKey('sk-abcdef1234567890') → 'sk-****7890'
 */
export function maskKey(key: string): string {
    if (!key) return ''
    if (key.length < 8) return '****'
    return `${key.slice(0, 3)}****${key.slice(-4)}`
}

/** 对外可见的凭据状态（不含明文） */
export interface CredentialStatus {
    provider: CredentialProvider
    label: string
    powers: string
    console: string
    /** 是否已配置 */
    configured: boolean
    /** 掩码后的密钥，未配置时为空串 */
    masked: string
}

/** 列出全部供应商的配置状态 */
export function listCredentialStatus(): CredentialStatus[] {
    return (Object.keys(ENV_KEY) as CredentialProvider[]).map((provider) => {
        const key = runtimeKeys[provider]
        return {
            provider,
            label: PROVIDER_META[provider].label,
            powers: PROVIDER_META[provider].powers,
            console: PROVIDER_META[provider].console,
            configured: key.length > 0,
            masked: maskKey(key),
        }
    })
}

/**
 * 定位 .env 文件
 *
 * dotenv 在 config.ts 中以进程工作目录为基准加载，这里保持一致。
 */
function envPath(): string {
    return resolve(process.cwd(), '.env')
}

/**
 * 将密钥写回 .env
 *
 * 逐行替换目标变量，其余行原样保留；变量不存在时追加到文件末尾。
 * 不使用「整体序列化重写」的做法——那会丢掉运维手写的注释与分组。
 */
function persistToEnv(provider: CredentialProvider, key: string): void {
    persistCredentialAtomically(envPath(), ENV_KEY[provider], key)
}

/**
 * 更新密钥
 *
 * @param persist 是否写回 .env（默认 true）。传 false 可做「仅本次进程生效」的临时切换。
 */
export function setKey(provider: CredentialProvider, key: string, persist = true): void {
    // Render 的环境变量由 Dashboard 注入；容器文件系统不是凭据真源。
    // 即使未来出现绕过 settings 路由的新调用点，也必须在任何规范化、
    // 运行时切换或落盘之前拒绝修改，保持纵深防御。
    if (config.isRender) {
        throw new Error('SETTINGS_MANAGED_EXTERNALLY: Render 模型凭据必须在 Dashboard Environment 中管理')
    }
    const trimmed = normalizeCredentialKey(key)
    // 先持久化、后切换运行时状态；落盘失败时不允许出现“接口报错但进程已换 Key”的半成功。
    if (persist) {
        persistToEnv(provider, trimmed)
    }
    runtimeKeys[provider] = trimmed
    for (const fn of listeners) {
        try {
            fn(provider, trimmed)
        } catch {
            // 单个订阅者失败不影响其他订阅者
        }
    }
}
