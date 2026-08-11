/**
 * 模型凭据运行时管理
 *
 * ─────────────────────────────────────────────────────────────
 * 为什么需要它
 * ─────────────────────────────────────────────────────────────
 * `config.ts` 导出的是 `as const` 冻结字面量，启动配置本身不能承担运行期轮换。
 * 但教师需要能在界面上换成自己的密钥（换账号、额度用尽、换供应商），
 * 不应该被迫去改服务器文件再重启。
 *
 * 本模块把三组密钥抽出来做成**运行时可变 + 落盘持久化**的一层：
 *   - 进程内：改完立即生效，LLM 客户端会重建连接实例
 *   - 本地磁盘：原子写回 .env，重启后依然生效
 *   - Render 持久盘：写入 AES-256-GCM 加密保险柜，避免把供应商密钥交给浏览器
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
import { isTrustedProviderEndpoint } from '../security/provider-endpoint-policy.js'
import { readCredentialVault, writeCredentialVault, type VaultValues } from '../security/credential-vault.js'

/** 可在运行时配置的模型供应商 */
export type CredentialProvider = 'deepseek' | 'mimo' | 'dashscope' | 'wanBaseUrl'

/** 各供应商对应的 .env 变量名 */
const ENV_KEY: Record<CredentialProvider, string> = {
    deepseek: 'DEEPSEEK_API_KEY',
    mimo: 'MIMO_API_KEY',
    dashscope: 'DASHSCOPE_API_KEY',
    wanBaseUrl: 'WAN_IMAGE_BASE_URL',
}

/** 供应商展示信息（前端设置面板直接消费，避免两端各维护一份文案） */
export const PROVIDER_META: Record<CredentialProvider, {
    label: string
    /** 该密钥驱动的能力 */
    powers: string
    /** 申请地址 */
    console: string
    inputKind: 'secret' | 'url'
}> = {
    deepseek: {
        label: 'DeepSeek',
        powers: '命题 / 诊断 / 批改 / 报告 / 副驾对话',
        console: 'https://platform.deepseek.com',
        inputKind: 'secret',
    },
    mimo: {
        label: 'MiMo（小米）',
        powers: '语音合成范读 / 朗读转写 / 多模态图像识别',
        console: 'https://api.xiaomimimo.com',
        inputKind: 'secret',
    },
    dashscope: {
        label: '阿里云百炼',
        powers: '诗境插画生成（wan2.7-image）',
        console: 'https://bailian.console.aliyun.com',
        inputKind: 'secret',
    },
    wanBaseUrl: {
        label: 'Wan 2.7 Workspace 地址',
        powers: '阿里云百炼北京地域 Workspace 同步生图端点',
        console: 'https://bailian.console.aliyun.com',
        inputKind: 'url',
    },
}

/** 运行时密钥表，初值取自 .env */
const runtimeKeys: Record<CredentialProvider, string> = {
    deepseek: config.deepseek.apiKey,
    mimo: config.mimo.apiKey,
    dashscope: config.wanImage.apiKey,
    wanBaseUrl: config.wanImage.baseUrl,
}

let vaultValues: VaultValues = {}

export function initializeCredentialStore(): void {
    if (!config.isRender) return
    if (Buffer.byteLength(config.credentialVaultMasterKey, 'utf8') < 32) {
        throw new Error('Render 部署必须配置至少 32 字节的 CREDENTIAL_VAULT_MASTER_KEY')
    }
    vaultValues = readCredentialVault(config.runtimePaths.dataDir, config.credentialVaultMasterKey)
    for (const provider of Object.keys(runtimeKeys) as CredentialProvider[]) {
        const value = vaultValues[provider]
        if (typeof value === 'string') runtimeKeys[provider] = value
    }
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

export function getWanImageBaseUrl(): string {
    return runtimeKeys.wanBaseUrl
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
    inputKind: 'secret' | 'url'
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
            masked: provider === 'wanBaseUrl' && key
                ? new URL(key).host
                : maskKey(key),
            inputKind: PROVIDER_META[provider].inputKind,
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

function normalizeValue(provider: CredentialProvider, value: string): string {
    const trimmed = value.trim()
    if (provider === 'wanBaseUrl') {
        if (!trimmed) return ''
        if (!isTrustedProviderEndpoint('wan-image', trimmed)) {
            throw new Error('Wan Workspace 地址必须是官方北京地域同步生图 HTTPS 端点')
        }
        return trimmed
    }
    return normalizeCredentialKey(trimmed)
}

/**
 * 更新密钥
 *
 * @param persist 是否写回 .env（默认 true）。传 false 可做「仅本次进程生效」的临时切换。
 */
export function setKey(provider: CredentialProvider, key: string, persist = true): void {
    const trimmed = normalizeValue(provider, key)
    // 先持久化、后切换运行时状态；落盘失败时不允许出现“接口报错但进程已换 Key”的半成功。
    if (persist) {
        if (config.isRender) {
            vaultValues = { ...vaultValues, [provider]: trimmed }
            writeCredentialVault(config.runtimePaths.dataDir, config.credentialVaultMasterKey, vaultValues)
        } else {
            persistToEnv(provider, trimmed)
        }
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
