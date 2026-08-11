#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const areas = ['frontend', 'backend']
const forbiddenCopyleft = /(?:^|[^A-Z])(?:AGPL|GPL)-/u
const reviewLicense = /LGPL|no charge|Commons Clause|SSPL|BUSL|BSL|Elastic License/iu
const sourceAttributions = []
const sourceLicenseReview = {
    name: 'Local mixed-origin UI reference-derived components',
    version: 'unversioned local reference bundle',
    license: 'Provenance unverified; no single license grant established',
    kind: 'source',
}
const sourceReviewGuidance = {
    evidenceRecord: 'docs/audit/2026-08-09-frontend-reference-provenance.md',
    releaseRule: 'No current component remains in this source-attribution review list. If future code reuses the mixed-origin local reference bundle, do not treat it as project-MIT or as a single upstream library: verify an immutable upstream source and license for each reused component, obtain written permission, or independently replace/remove it before public-source or wider distribution.',
    resolvedInThisPass: [
        'frontend/src/components/ui/CardSwap.tsx is a 2026-08-09 independent implementation and is excluded from this source-review list.',
        'frontend/src/components/ui/PixelTransition.tsx is a 2026-08-09 independent implementation and is excluded from this source-review list.',
        'frontend/src/components/ui/StackGallery.tsx is a 2026-08-09 independent implementation and is excluded from this source-review list.',
        'frontend/src/components/ui/GlowBorder.tsx is a 2026-08-09 independent implementation and is excluded from this source-review list.',
        'frontend/src/components/ui/TextPressure.tsx is a 2026-08-09 independent implementation and is excluded from this source-review list.',
        'frontend/src/components/ui/StreamText.tsx is a 2026-08-09 independent implementation and is excluded from this source-review list.',
        'frontend/src/components/ui/VariableProximity.tsx is a 2026-08-09 independent implementation and is excluded from this source-review list.',
        'frontend/src/components/ui/ScrollReveal.tsx is a 2026-08-09 independent implementation and is excluded from this source-review list.',
        'frontend/src/components/ui/GradualBlur.tsx is a 2026-08-09 independent implementation and is excluded from this source-review list.',
        'frontend/src/components/ui/ElectricBorder.tsx is a 2026-08-09 independent implementation and is excluded from this source-review list.',
        'frontend/src/components/ui/FallingText.tsx is a 2026-08-09 independent implementation and is excluded from this source-review list.',
        'frontend/src/components/ui/MasonryGrid.tsx is a 2026-08-10 independent implementation and is excluded from this source-review list.',
        'frontend/src/components/ui/StarfieldBackground.tsx is a 2026-08-10 independent implementation and is excluded from this source-review list.',
        'frontend/src/components/ui/MagicRings.tsx is a 2026-08-10 independent implementation and is excluded from this source-review list.',
        'frontend/src/components/ui/Radar.tsx is a 2026-08-10 independent CSS implementation and is excluded from this source-review list.',
        'frontend/src/components/ui/MagicBento.tsx is a 2026-08-10 independent React/CSS implementation with deterministic decorative stars, native links, and no GSAP, Canvas/WebGL, requestAnimationFrame, or global DOM mutation; it is excluded from this source-review list.',
        'frontend/src/components/ui/PixelSnow.tsx is a 2026-08-10 independent, bounded deterministic CSS decoration with no Three.js, shader, Canvas/WebGL, requestAnimationFrame, observer, or random runtime; it is excluded from this source-review list.',
        'frontend/src/components/ui/TextSwitch.tsx is a 2026-08-10 independent whole-text React/CSS state machine with no GSAP, Canvas, requestAnimationFrame, setInterval, or per-character DOM; it uses one cleanup-bound timeout and is excluded from this source-review list.',
        'frontend/src/components/ui/SphereGallery.tsx is a 2026-08-10 independent native DOM/CSS scroll-snap gallery with a React Portal dialog and no Three.js, WebGL, Canvas, requestAnimationFrame, timer, or random runtime; its LessonPlan and project-specific StarMapDome consumer contracts are checked in the controlled frontend evidence record, and it is excluded from this source-review list.',
        'frontend/src/components/ui/PixelCard.tsx had no production consumer and was removed on 2026-08-10 together with its barrel export and dead Report styles.',
        'frontend/src/components/ui/ShapeBlur.tsx had no production consumer and was removed on 2026-08-10 together with its barrel export and orphaned StarMap styles.',
    ],
}
const packageReviewGuidance = {
    evidenceRecord: 'docs/audit/2026-08-11-package-license-review.md',
    boundary: 'This is an engineering distribution review, not legal advice or a substitute for the release owner\'s sign-off. Re-run the audit inside the actual Render/Linux build image because platform-specific Sharp/libvips packages differ from the Windows development tree.',
}

async function readControlledFrontendEvidence() {
    const evidenceRecord = 'docs/audit/production-e2e-latest.json'
    try {
        const evidence = JSON.parse(await readFile(path.join(root, ...evidenceRecord.split('/')), 'utf8'))
        return {
            evidenceRecord,
            available: true,
            generatedAt: evidence.generatedAt ?? null,
            routeViewportCombinations: evidence.routeViewportCombinations ?? null,
            warnings: evidence.warnings ?? null,
            failures: evidence.failures ?? null,
            contracts: {
                radarDecoration: evidence.radarDecoration?.checked === true,
                pixelSnowDecoration: evidence.pixelSnowDecorationContract?.checked === true,
                classroomTextSwitch: evidence.classroomTextSwitchContract?.checked === true,
                dashboardMagicBento: evidence.dashboardMagicBentoContract?.checked === true,
                lessonPlanImageGallery: evidence.lessonPlanImageGallery?.checked === true,
                starMapPoetryGallery: evidence.starMapPoetryGallery?.checked === true,
                sphereGalleryLightweightResourceBoundary: evidence.sphereGalleryLightweightResourceBoundary?.checked === true,
            },
            boundary: 'This aggregate and its checked contracts prove only the controlled frontend behavior, accessibility, geometry, fallback and resource boundaries named in that evidence file. They do not prove image or knowledge-graph provenance, teaching outcomes, production backend availability, untested-browser GPU behavior or competition results.',
        }
    } catch (error) {
        return {
            evidenceRecord,
            available: false,
            error: error instanceof Error ? error.message : String(error),
            boundary: 'No controlled frontend result may be inferred when the referenced evidence file is unavailable or invalid.',
        }
    }
}

function runPnpmLicenses(area) {
    // 许可证结果属于提交物证据，必须与 package.json 的 Node 20 兼容 pnpm 锁定值一致。
    // 不使用机器缓存的默认 pnpm，避免 pnpm 11 在 Node 20 上因 node:sqlite 而不可复现。
    const args = ['pnpm@10.34.5', 'licenses', 'list', '--prod', '--json']
    const result = process.platform === 'win32'
        ? spawnSync(process.execPath, [
            path.join(path.dirname(process.execPath), 'node_modules', 'corepack', 'dist', 'corepack.js'),
            ...args,
        ], { cwd: path.join(root, area), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
        : spawnSync('corepack', args, { cwd: path.join(root, area), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    if (result.status !== 0) throw new Error(`${area} 许可证清单失败：${result.stderr.trim() || `exit=${result.status}`}`)
    try { return JSON.parse(result.stdout) } catch { throw new Error(`${area} 许可证 JSON 无法解析`) }
}

async function directNames(area) {
    const manifest = JSON.parse(await readFile(path.join(root, area, 'package.json'), 'utf8'))
    return new Set(Object.keys(manifest.dependencies ?? {}))
}

async function findLicenseFiles(packagePath) {
    let entries
    try { entries = await readdir(packagePath, { withFileTypes: true }) } catch { return [] }
    const candidates = entries
        .filter((entry) => entry.isFile() && /^(?:licen[cs]e|copying|notice)(?:\..*)?$/iu.test(entry.name))
        .map((entry) => path.join(packagePath, entry.name))
        .sort()
    const files = []
    for (const file of candidates) {
        const info = await stat(file)
        if (info.size > 512_000) continue
        const content = await readFile(file, 'utf8')
        files.push({
            name: path.basename(file),
            sha256: createHash('sha256').update(content).digest('hex'),
            content: content.trim(),
        })
    }
    return files
}

async function collect() {
    const packages = new Map()
    for (const area of areas) {
        const [inventory, direct] = [runPnpmLicenses(area), await directNames(area)]
        for (const [license, rawItems] of Object.entries(inventory)) {
            for (const item of Array.isArray(rawItems) ? rawItems : [rawItems]) {
                const versions = item.versions?.length ? item.versions : ['unknown']
                for (let index = 0; index < versions.length; index++) {
                    const version = versions[index]
                    const packagePath = item.paths?.[index] ?? item.paths?.[0] ?? ''
                    const key = `${item.name}@${version}`
                    const existing = packages.get(key)
                    if (existing) {
                        if (!existing.areas.includes(area)) existing.areas.push(area)
                        existing.direct ||= direct.has(item.name)
                        continue
                    }
                    packages.set(key, {
                        name: item.name,
                        version,
                        license,
                        author: item.author ?? null,
                        homepage: item.homepage ?? null,
                        description: item.description ?? null,
                        areas: [area],
                        direct: direct.has(item.name),
                        licenseFiles: packagePath ? await findLicenseFiles(packagePath) : [],
                    })
                }
            }
        }
    }
    return [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
}

function renderNotice(report) {
    const lines = [
        '# Third-Party Notices / 第三方软件声明',
        '',
        `生成时间：${report.generatedAt}`,
        '',
        '本项目原创部分采用根目录 `LICENSE` 中的 MIT License。该许可不覆盖下列第三方依赖、上游改编组件、字体、模型或外部服务；它们继续受各自条款约束。本文件由已安装且锁定的生产依赖树生成，不是法律意见。更换平台、依赖版本或发布形态后必须重新生成并复核。',
        '',
        '## 本地混合来源组件审查状态',
        '',
        sourceAttributions.length > 0
            ? '以下前端组件的源码头明确记录了来自本地《优质前端部件组》的移植或概念借鉴。审计发现该本地目录没有统一 LICENSE/NOTICE，且其文档混合出现 CodePen、Animate UI、GitHub 等来源；因此不能将它们统称为 React Bits 或推定为同一许可证。它们不得被解释为仅受本项目 MIT 覆盖，也不得在来源、版本和许可证逐项闭合前作为可公开再分发的组件资产：'
            : '当前 `sourceAttributions` 待闭合列表为空。该结论只表示本轮已识别的相关生产组件均已独立重写或删除；它不为本地《优质前端部件组》建立统一许可证，也不授权未来复制或改编其中代码。',
        '',
        ...sourceAttributions.map((name) => `- \`frontend/src/components/ui/${name}.tsx\``),
        '',
        '逐组件来源证据、闭合状态和重新触发规则见 `docs/audit/2026-08-09-frontend-reference-provenance.md`；参考采用范围、排除的 GPL/AGPL 项目和独立实现决策见 `docs/audit/2026-08-01-reference-adoption-matrix.md`。CardSwap、PixelTransition、StackGallery、GlowBorder、TextPressure、StreamText、VariableProximity、ScrollReveal、GradualBlur、ElectricBorder、FallingText、MasonryGrid、StarfieldBackground、MagicRings、Radar、MagicBento、PixelSnow、TextSwitch 与 SphereGallery 共十九项已改为独立实现；无生产调用的 PixelCard、ShapeBlur 两项已删除。上述二十一项已从来源待闭合列表移除。StarMapDome 是项目专用的 SphereGallery 业务消费层，不属于本地混合来源索引，不能虚构为第二十项外部来源组件。最新受控前端结果及其边界见下节；独立实现与回归结论不证明教学效果、内容真实性、外部服务可用性或比赛结果。Postiz、BettaFish 等仅用于研究通用机制，其代码不得进入当前 MIT 主体。',
        '',
        '## 受控前端回归证据',
        '',
        report.controlledFrontendEvidence.available
            ? `- 证据：\`${report.controlledFrontendEvidence.evidenceRecord}\`；生成时间 ${report.controlledFrontendEvidence.generatedAt ?? '未记录'}；路由/视口组合 ${report.controlledFrontendEvidence.routeViewportCombinations ?? '未记录'}；warnings=${report.controlledFrontendEvidence.warnings ?? '未记录'}；failures=${report.controlledFrontendEvidence.failures ?? '未记录'}。`
            : `- 证据不可用：\`${report.controlledFrontendEvidence.evidenceRecord}\`；${report.controlledFrontendEvidence.error ?? '无法解析'}。`,
        `- Radar、PixelSnow、TextSwitch、MagicBento、LessonPlan SphereGallery、StarMapDome 诗篇画廊及 SphereGallery 轻量资源边界的 checked 状态：${report.controlledFrontendEvidence.available ? JSON.stringify(report.controlledFrontendEvidence.contracts) : '不可推断'}。`,
        `- 边界：${report.controlledFrontendEvidence.boundary}`,
        '',
        '## 生产依赖摘要',
        '',
        `- 唯一包版本：${report.summary.uniquePackages}`,
        `- 直接依赖：${report.summary.directPackages}`,
        `- 未发现 GPL/AGPL 生产包：${report.summary.forbiddenCopyleft === 0 ? '是' : '否'}`,
        `- 本地混合来源组件待人工闭合：${report.summary.sourceReviewRequired}`,
        `- 需人工复核的生产依赖条款：${report.summary.packageReviewRequired}`,
        `- 安装包根目录含 LICENSE/COPYING/NOTICE 文本：${report.summary.packageRootLicenseFilesPresent}`,
        `- 安装包根目录未含上述文本、但保留 npm 元数据许可声明：${report.summary.packageRootLicenseFilesAbsent}`,
        `- npm 元数据未声明许可证：${report.summary.packagesWithoutDeclaredLicense}`,
        '',
        '> “安装包根目录未含文本”仅表示本审计器未能从该目录摘取可随包保留的 LICENSE/COPYING/NOTICE；它不等同于“该包未声明许可证”，也不等同于许可合规结论。上方 npm 元数据仍须与实际分发形态一并人工复核。生产依赖中的 Sharp 平台预编译包可能同时涉及 Apache-2.0 与 LGPL-3.0-or-later，均不得归并成 MIT；工程复核记录见 `docs/audit/2026-08-11-package-license-review.md`。来源未闭合的 UI 组件是独立的发布阻断项，不能由本 NOTICE 替代权利确认。',
        '',
        '## 逐包清单与许可证文本',
        '',
    ]
    for (const item of report.packages) {
        lines.push(`### ${item.name}@${item.version}`, '')
        lines.push(`- License：${item.license}`)
        lines.push(`- 区域：${item.areas.join(', ')}${item.direct ? '；直接依赖' : '；传递依赖'}`)
        if (item.author) lines.push(`- Author：${item.author}`)
        if (item.homepage) lines.push(`- Homepage：${item.homepage}`)
        if (item.licenseFiles.length === 0) {
            lines.push('- 包根目录许可文本：未发现；npm 元数据已如上记录。此为文本收集证据缺口，不等同于无许可证；发布前须按实际分发形态人工复核。', '')
            continue
        }
        for (const file of item.licenseFiles) {
            lines.push(`- 包内文件：${file.name}；SHA-256 \`${file.sha256}\``, '', '```text', file.content, '```', '')
        }
    }
    return `${lines.join('\n')}\n`
}

async function atomicWrite(target, content) {
    await mkdir(path.dirname(target), { recursive: true })
    const temporary = `${target}.${process.pid}.tmp`
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, target)
}

async function main() {
    const [packages, controlledFrontendEvidence] = await Promise.all([
        collect(),
        readControlledFrontendEvidence(),
    ])
    const forbidden = packages.filter((item) => forbiddenCopyleft.test(item.license))
    const review = packages.filter((item) => reviewLicense.test(item.license))
    const reviewItems = [
        ...review.map(({ name, version, license }) => ({ name, version, license, kind: 'package' })),
        ...(sourceAttributions.length > 0 ? [sourceLicenseReview] : []),
    ]
    const missingRootLicenseFiles = packages.filter((item) => item.licenseFiles.length === 0)
    const undeclaredLicense = packages.filter((item) => !item.license || item.license === 'unknown')
    const report = {
        generatedAt: new Date().toISOString(),
        status: forbidden.length > 0 ? 'failed' : reviewItems.length > 0 || undeclaredLicense.length > 0 ? 'passed_with_review' : 'passed',
        summary: {
            uniquePackages: packages.length,
            directPackages: packages.filter((item) => item.direct).length,
            forbiddenCopyleft: forbidden.length,
            reviewRequired: reviewItems.length,
            sourceReviewRequired: sourceAttributions.length,
            packageReviewRequired: review.length,
            packageRootLicenseFilesPresent: packages.length - missingRootLicenseFiles.length,
            packageRootLicenseFilesAbsent: missingRootLicenseFiles.length,
            packagesWithoutDeclaredLicense: undeclaredLicense.length,
        },
        forbidden: forbidden.map(({ name, version, license }) => ({ name, version, license })),
        review: reviewItems,
        packageReviewGuidance,
        sourceReviewGuidance,
        controlledFrontendEvidence,
        packageRootLicenseFilesAbsent: missingRootLicenseFiles.map(({ name, version, license }) => ({ name, version, license })),
        packagesWithoutDeclaredLicense: undeclaredLicense.map(({ name, version, license }) => ({ name, version, license })),
        sourceAttributions,
        packages,
    }
    await Promise.all([
        atomicWrite(path.join(root, 'docs', 'audit', 'production-licenses-latest.json'), `${JSON.stringify(report, null, 2)}\n`),
        atomicWrite(path.join(root, 'THIRD_PARTY_NOTICES.md'), renderNotice(report)),
    ])
    console.log(`Production licenses: ${report.status}; packages=${packages.length}; forbidden=${forbidden.length}; review=${reviewItems.length}; rootTextAbsent=${missingRootLicenseFiles.length}; metadataUndeclared=${undeclaredLicense.length}`)
    process.exitCode = forbidden.length > 0 ? 1 : 0
}

main().catch((error) => {
    console.error(`Production license audit failed: ${error.message}`)
    process.exitCode = 1
})
