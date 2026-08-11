import { createHash } from 'node:crypto'

import registryJson from '../../data/poem-provenance.json' with { type: 'json' }

export type PoemCatalogScope = 'TEXTBOOK_CORE' | 'EXTENDED'
export type PoemSourceVerificationStatus = 'VERIFIED' | 'UNVERIFIED' | 'INCOMPLETE' | 'STALE'

interface VerifiablePoem {
    id: string
    title: string
    poet: string
    dynasty: string
    content: string
}

interface SourceReference {
    title: string
    url: string
    authorityLevel: 'L1' | 'L2'
    accessedAt: string
}

export interface PoemProvenanceRecord {
    poemId: string
    contentSha256: string
    catalogScope: PoemCatalogScope
    sources: SourceReference[]
    teacherReview: {
        decision: 'PASS' | 'REJECT'
        reviewerId: string
        reviewedAt: string
        evidenceLocation: string
    }
}

export interface PoemSourceVerification {
    status: PoemSourceVerificationStatus
    catalogScope: PoemCatalogScope | 'UNCLASSIFIED'
    contentSha256: string
    reviewedAt: string | null
    sourceTitles: string[]
    message: string
}

const registry = registryJson as unknown as { version: number; records: PoemProvenanceRecord[] }

/**
 * 常见的二级公共后缀。这里的目标不是实现完整 PSL，而是避免把
 * `archive.publisher.edu.cn` 与 `www.publisher.edu.cn` 误判为两个独立机构。
 * 不确定的域名宁可由教师在工作表中更换为机构首页/权威落地页，也不放宽验收门。
 */
const ORGANIZATION_SECOND_LEVEL_SUFFIXES = new Set([
    'ac.cn', 'com.cn', 'edu.cn', 'gov.cn', 'net.cn', 'org.cn',
    'com.hk', 'edu.hk', 'gov.hk', 'net.hk', 'org.hk',
    'com.mo', 'edu.mo', 'gov.mo', 'net.mo', 'org.mo',
    'com.tw', 'edu.tw', 'gov.tw', 'idv.tw', 'net.tw', 'org.tw',
])

export function computePoemContentSha256(poem: VerifiablePoem): string {
    const canonical = [poem.id, poem.title, poem.poet, poem.dynasty, poem.content].join('\u001f')
    return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

function isIsoDate(value: unknown): value is string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false
    const parts = value.split('-')
    const year = Number(parts[0])
    const month = Number(parts[1])
    const day = Number(parts[2])
    const date = new Date(Date.UTC(year, month - 1, day))
    return date.getUTCFullYear() === year
        && date.getUTCMonth() === month - 1
        && date.getUTCDate() === day
        // 按 UTC 对齐，允许本地时区已跨到次日时完成当天登记；不接受更远的未来日期。
        && date.getTime() <= Date.now() + 86_400_000
}

function organizationDomain(hostname: string): string | null {
    const normalized = hostname.toLowerCase().replace(/\.$/u, '')
    const labels = normalized.split('.')
    if (labels.length < 2 || labels.some((label) => !/^[a-z0-9-]+$/u.test(label))) return null
    const suffix = labels.slice(-2).join('.')
    const requiredLabels = ORGANIZATION_SECOND_LEVEL_SUFFIXES.has(suffix) ? 3 : 2
    return labels.length >= requiredLabels ? labels.slice(-requiredLabels).join('.') : null
}

function publicHttpsOrganizationDomain(value: unknown): string | null {
    if (typeof value !== 'string' || value.trim() === '') return null
    try {
        const url = new URL(value)
        if (url.protocol !== 'https:' || url.username || url.password || url.port) return null
        const hostname = url.hostname.toLowerCase().replace(/\.$/u, '')
        if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) return null
        // IP 地址和单标签主机不能证明其归属的权威机构，不能作为公开验收信源。
        if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(hostname) || hostname.includes(':')) return null
        return organizationDomain(hostname)
    } catch {
        return null
    }
}

function hasSafeEvidenceLocation(value: unknown): value is string {
    return typeof value === 'string'
        && /^offline-vault\/[A-Za-z0-9][A-Za-z0-9._/-]{2,180}$/u.test(value)
        && !value.includes('..')
}

export function evaluatePoemVerification(
    poem: VerifiablePoem,
    records: readonly PoemProvenanceRecord[],
): PoemSourceVerification {
    const contentSha256 = computePoemContentSha256(poem)
    const matchingRecords = records.filter((candidate) => candidate && candidate.poemId === poem.id)
    if (matchingRecords.length === 0) {
        return {
            status: 'UNVERIFIED',
            catalogScope: 'UNCLASSIFIED',
            contentSha256,
            reviewedAt: null,
            sourceTitles: [],
            message: '该诗尚未完成逐首双信源与语文教师复核，不得标注为教材已验证内容。',
        }
    }

    if (matchingRecords.length !== 1) {
        return {
            status: 'INCOMPLETE',
            catalogScope: 'UNCLASSIFIED',
            contentSha256,
            reviewedAt: null,
            sourceTitles: [],
            message: '复核登记存在重复诗篇记录，已停止放行；必须由验收负责人去重后重新编译。',
        }
    }
    const record = matchingRecords[0]
    // noUncheckedIndexedAccess 下保留显式保护：即使未来重构了上面的计数分支，
    // 损坏的运行时 JSON 也不会在这里变成未捕获异常。
    if (!record) {
        return {
            status: 'INCOMPLETE',
            catalogScope: 'UNCLASSIFIED',
            contentSha256,
            reviewedAt: null,
            sourceTitles: [],
            message: '复核登记无法读取，已停止放行；请重新编译验收记录。',
        }
    }

    const sourceTitles = Array.isArray(record.sources)
        ? record.sources
            .filter((source): source is SourceReference => Boolean(source) && typeof source.title === 'string')
            .map((source) => source.title)
            .filter(Boolean)
        : []
    if (record.contentSha256 !== contentSha256) {
        return {
            status: 'STALE',
            catalogScope: record.catalogScope ?? 'UNCLASSIFIED',
            contentSha256,
            reviewedAt: record.teacherReview?.reviewedAt ?? null,
            sourceTitles,
            message: '诗文内容在复核后发生变化，原复核结论已失效，必须重新验收。',
        }
    }

    const sources = Array.isArray(record.sources) ? record.sources : []
    const sourceDomains = sources.map((source) => publicHttpsOrganizationDomain(source?.url))
    const distinctSourceUrls = new Set(
        sources
            .map((source) => typeof source?.url === 'string' ? source.url.trim() : '')
            .filter(Boolean),
    )
    const distinctOrganizationDomains = new Set(sourceDomains.filter((domain): domain is string => domain !== null))
    const sourcesValid = sources.length >= 2
        && distinctSourceUrls.size >= 2
        && distinctOrganizationDomains.size >= 2
        && sources.some((source) => source?.authorityLevel === 'L1')
        && sources.every((source) => (
            typeof source?.title === 'string'
            && source.title.trim() !== ''
            && publicHttpsOrganizationDomain(source.url) !== null
            && ['L1', 'L2'].includes(source.authorityLevel)
            && isIsoDate(source.accessedAt)
        ))
    const review = record.teacherReview
    const reviewValid = review?.decision === 'PASS'
        && typeof review.reviewerId === 'string'
        && /^T-[A-Z0-9-]{2,30}$/u.test(review.reviewerId)
        && isIsoDate(review.reviewedAt)
        && hasSafeEvidenceLocation(review.evidenceLocation)
        && sources.every((source) => isIsoDate(source.accessedAt) && review.reviewedAt >= source.accessedAt)
    const scopeValid = ['TEXTBOOK_CORE', 'EXTENDED'].includes(record.catalogScope)
    if (!sourcesValid || !reviewValid || !scopeValid) {
        return {
            status: 'INCOMPLETE',
            catalogScope: scopeValid ? record.catalogScope : 'UNCLASSIFIED',
            contentSha256,
            reviewedAt: review?.reviewedAt ?? null,
            sourceTitles,
            message: '复核记录不完整：需两个独立机构信源（至少一个 L1）、明确篇目范围、有效日期与教师 PASS 证据。',
        }
    }

    return {
        status: 'VERIFIED',
        catalogScope: record.catalogScope,
        contentSha256,
        reviewedAt: review.reviewedAt,
        sourceTitles,
        message: record.catalogScope === 'TEXTBOOK_CORE'
            ? '已完成教材核心篇目双信源与语文教师复核。'
            : '已完成拓展篇目双信源与语文教师复核。',
    }
}

export function getPoemVerification(poem: VerifiablePoem): PoemSourceVerification {
    return evaluatePoemVerification(poem, registry.records)
}

export function getPoemProvenanceRegistry(): readonly PoemProvenanceRecord[] {
    return registry.records
}
