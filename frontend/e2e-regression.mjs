/**
 * 诗脉·启明严格 E2E 回归
 *
 * 与历史 e2e-verify.mjs 的区别：
 * - 先验证认证守卫并完成真实演示账号登录；
 * - 每个公开界面都有可见内容、标题、加载完成与横向溢出断言；
 * - 未预期的 console.error、pageerror、请求失败和 5xx 会让进程失败；
 * - 同时覆盖桌面与移动视口；
 * - 任何功能断言失败都会返回非零退出码。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { chromium } from 'playwright'

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:4173'
const AUTH_MODE = process.env.E2E_AUTH_MODE ?? 'demo'
const AUTH_PASSWORD = process.env.E2E_AUTH_PASSWORD ?? ''
const AUTH_PHONE = process.env.E2E_AUTH_PHONE ?? ''
const E2E_SCOPE = process.env.E2E_SCOPE ?? 'full'
if (!['demo', 'password'].includes(AUTH_MODE)) {
    throw new Error(`E2E_AUTH_MODE 不受支持：${AUTH_MODE}`)
}
if (!AUTH_PASSWORD || !/^1[3-9]\d{9}$/u.test(AUTH_PHONE)) {
    throw new Error('手机号密码认证 E2E 缺少有效的 E2E_AUTH_PHONE / E2E_AUTH_PASSWORD')
}
if (!['full', 'report-sharing'].includes(E2E_SCOPE)) {
    throw new Error(`E2E_SCOPE 不受支持：${E2E_SCOPE}`)
}
const OUTPUT_DIR = path.resolve('e2e-screenshots', 'regression')
const RESULTS_FILE = E2E_SCOPE === 'full' ? 'results.json' : 'report-sharing-results.json'

const ROUTES = [
    { path: '/dashboard', title: '教学驾驶舱', marker: '教学驾驶舱' },
    { path: '/starmap', title: '诗词星图', marker: '诗' },
    { path: '/diagnosis', title: '教学驾驶舱', marker: '诊断', expectedPath: '/dashboard' },
    { path: '/lesson-plan', title: '教案工坊', marker: '教案' },
    { path: '/workbench', title: '命题工坊', marker: '命题' },
    { path: '/classroom', title: '课堂导播', marker: '课堂' },
    { path: '/grading', title: '智能批改', marker: '批改' },
    { path: '/creation-studio', title: '创作迭代台', marker: '创造闭环' },
    { path: '/ai-copilot', title: 'AI 副驾', marker: 'AI' },
    { path: '/evolution-eye', title: '进化之眼', marker: '进化' },
    { path: '/thinking-palace', title: '思考宫殿', marker: '思考宫殿' },
    { path: '/culture', title: '文化语境', marker: '文化' },
    { path: '/report', title: '教研报告', marker: '报告' },
    { path: '/privacy', title: '隐私政策', marker: '隐私' },
    { path: '/forbidden', title: '无权访问', marker: '权限' },
    { path: '/route-that-must-not-exist', marker: '页面' },
]

const failures = []
const warnings = []
const routeResults = []
let activeRoute = 'bootstrap'
let memoryGovernanceChecked = false
let offlineDisclosureChecked = false
let keyboardNavigationChecked = false
let authFailureClosedChecked = false
let modalFocusManagementChecked = false
let notificationEmptyDialogFocusChecked = false
let commandPaletteMobileChecked = false
let sidebarResizerKeyboardChecked = false
let ttsBinaryPlaybackChecked = false
let voiceInputLifecycleChecked = false
let quickVoiceCaptureLifecycleChecked = false
let lessonPlanStartChecked = false
let toastOverflowChecked = false
let gradingInitialActionChecked = false
let gradingResultTableKeyboardChecked = false
let gradingProgressTransitionKeyboardChecked = false
let gradingStackGalleryAccessibilityChecked = false
let gradingCardSwapMotionControlChecked = false
let classroomMobileLaunchChecked = false
let classroomLaunchBriefFullTextChecked = false
let classroomTextSwitchContractChecked = false
let electricBorderDecorationChecked = false
let classroomStartFailureClosureChecked = false
let reducedMotionComplianceChecked = false
let mobileBrandHierarchyChecked = false
let dashboardTabKeyboardChecked = false
let dashboardMagicBentoContractChecked = false
let chapterNavigationRemovedChecked = false
let dashboardAsyncContentVisibilityChecked = false
let dashboardAlertActionSemanticsChecked = false
let reportHistoryActionSemanticsChecked = false
let publicReportSharingChecked = false
let reportShareManagementChecked = false
let diagnosisStudentListKeyboardChecked = false
let radarDecorationContractChecked = false
let aiCopilotMobileInitialActionChecked = false
let creationTaskPublishingChecked = false
let creationTaskMobileComposerChecked = false
let workbenchPoemFallbackTruthChecked = false
let workbenchPrimaryStartPathChecked = false
let workbenchRefineModalKeyboardChecked = false
let workbenchRefineModalMobileChecked = false
let workbenchRichMarkdownDetailAccessibilityChecked = false
let copilotMaterialTruthBoundaryChecked = false
let copilotMarkdownImageRecoveryChecked = false
let copilotAttachmentPreviewRecoveryChecked = false
let classroomPoemTruthAndInnovativeModeChecked = false
let culturePoemVerificationDisclosureChecked = false
let pixelSnowDecorationContractChecked = false
let fallingTextTitleContractChecked = false
let masonryGridContractChecked = false
let thinkingPalaceLightweightAuditChecked = false
let poemImageCardAccessibilityChecked = false
let evolutionPatternLinkedNavigationChecked = false
let starMapLightweightViewChecked = false
let immersiveDrawerAccessibilityChecked = false
let evolutionEmptyEvidenceChecked = false
let lessonPlanImageGalleryContractChecked = false
let starMapPoetryGalleryContractChecked = false
let sphereGalleryLightweightResourceBoundaryChecked = false
let starfieldBackgroundFallbackChecked = false
const starfieldFallbackRoutes = new Set()
let magicRingsDecorationChecked = false
let expectedAuthStatusFailure = false

function fail(message) {
    failures.push(`[${activeRoute}] ${message}`)
}

/**
 * 所有同级视图切换都遵循同一条可访问性底线：控制器与面板双向关联、
 * 唯一 roving tabindex，以及在真实浏览器中可用的 Home / End 键漫游。
 * 这里不以源码存在某段处理函数作为证据，必须看到实际焦点、激活状态和面板
 * 关系一起变更，才能算作通过。
 */
async function verifyRovingTablist(page, {
    tablistName,
    dataAttribute,
    expectedValues,
    boundary,
}) {
    const tablist = page.getByRole('tablist', { name: tablistName, exact: true })
    const tabs = tablist.getByRole('tab')
    await Promise.all([
        tablist.waitFor({ state: 'visible', timeout: 10_000 }),
        page.waitForFunction(
            ({ attribute, expectedCount }) => document.querySelectorAll(`[${attribute}]`).length === expectedCount,
            { attribute: dataAttribute, expectedCount: expectedValues.length },
            { timeout: 10_000 },
        ),
    ])

    const structure = await tablist.evaluate((node) => {
        const controls = Array.from(node.querySelectorAll('[role="tab"]'))
        const selected = controls.filter((tab) => tab.getAttribute('aria-selected') === 'true')
        const focusable = controls.filter((tab) => tab.getAttribute('tabindex') === '0')
        const active = selected[0]
        const panelId = active?.getAttribute('aria-controls') ?? ''
        const panel = panelId ? document.getElementById(panelId) : null
        return {
            tabCount: controls.length,
            selectedCount: selected.length,
            focusableCount: focusable.length,
            everyTabHasIdAndPanel: controls.every((tab) => Boolean(tab.id && tab.getAttribute('aria-controls'))),
            panelRole: panel?.getAttribute('role') ?? null,
            panelLabelledBy: panel?.getAttribute('aria-labelledby') ?? null,
            activeId: active?.id ?? null,
        }
    })
    if (structure.tabCount !== expectedValues.length
        || structure.selectedCount !== 1
        || structure.focusableCount !== 1
        || !structure.everyTabHasIdAndPanel
        || structure.panelRole !== 'tabpanel'
        || structure.panelLabelledBy !== structure.activeId) {
        fail(`${boundary} Tab 与面板的结构、唯一选中状态或 roving tabindex 不完整：${JSON.stringify(structure)}`)
    }

    const assertKeyboardSelection = async (key, expectedValue) => {
        await page.keyboard.press(key)
        try {
            await page.waitForFunction(
                ({ attribute, expected }) => {
                    const tab = document.querySelector(`[${attribute}="${expected}"]`)
                    const panel = document.getElementById(tab?.getAttribute('aria-controls') ?? '')
                    return tab?.getAttribute('aria-selected') === 'true'
                        && tab.getAttribute('tabindex') === '0'
                        && document.activeElement === tab
                        && panel?.getAttribute('role') === 'tabpanel'
                        && panel.getAttribute('aria-labelledby') === tab.id
                },
                { attribute: dataAttribute, expected: expectedValue },
                { timeout: 5_000 },
            )
        } catch (error) {
            const actual = await page.evaluate(({ attribute }) => {
                const controls = [...document.querySelectorAll(`[${attribute}]`)]
                // React 已由错误边界接管时，浏览器不会派发 pageerror。仅在失败快照
                // 中遍历根 Fiber，读取边界已持有的错误消息；该分支不参与任何产品
                // 断言或成功路径，避免把内部实现误当成业务证据。
                const root = document.getElementById('root')
                const containerKey = root
                    ? Object.keys(root).find((key) => key.startsWith('__reactContainer$'))
                    : undefined
                const rootFiber = root && containerKey ? root[containerKey] : null
                const boundaryErrors = []
                const pending = rootFiber ? [rootFiber] : []
                const visited = new Set()
                while (pending.length > 0 && visited.size < 20_000) {
                    const fiber = pending.pop()
                    if (!fiber || visited.has(fiber)) continue
                    visited.add(fiber)
                    const error = fiber.stateNode?.state?.error
                    if (error instanceof Error) {
                        boundaryErrors.push({
                            name: fiber.stateNode?.constructor?.name ?? 'UnknownBoundary',
                            message: error.message,
                            stack: error.stack?.slice(0, 1_200) ?? null,
                        })
                    }
                    if (fiber.child) pending.push(fiber.child)
                    if (fiber.sibling) pending.push(fiber.sibling)
                }
                return {
                    href: window.location.href,
                    activeElement: document.activeElement instanceof HTMLElement
                        ? {
                            tag: document.activeElement.tagName,
                            id: document.activeElement.id,
                            dashboardTab: document.activeElement.getAttribute('data-dashboard-tab'),
                            localTab: document.activeElement.getAttribute(attribute),
                        }
                        : null,
                    localTabs: controls.map((tab) => ({
                        value: tab.getAttribute(attribute),
                        selected: tab.getAttribute('aria-selected'),
                        tabIndex: tab.getAttribute('tabindex'),
                        focused: document.activeElement === tab,
                        controls: tab.getAttribute('aria-controls'),
                    })),
                    dashboardTabs: [...document.querySelectorAll('[data-dashboard-tab]')].map((tab) => ({
                        value: tab.getAttribute('data-dashboard-tab'),
                        selected: tab.getAttribute('aria-selected'),
                        focused: document.activeElement === tab,
                    })),
                    bodyText: document.body.innerText.slice(0, 1_200),
                    bodyHtml: document.body.innerHTML.slice(0, 1_200),
                    boundaryErrors,
                }
            }, { attribute: dataAttribute })
            throw new Error(`${boundary} 按下 ${key} 后未同步到 ${expectedValue}：${JSON.stringify(actual)}`, { cause: error })
        }
    }

    // Tab 状态可能由 URL 或同页其他教师操作恢复；显式从首项开始，避免把
    // “当前选中项”误当作“DOM 第一项”，同时仍通过真实点击和键盘验证契约。
    const firstTab = tablist.locator(`[${dataAttribute}="${expectedValues[0]}"]`)
    await firstTab.click()
    await firstTab.focus()
    if (expectedValues.length > 1) {
        await assertKeyboardSelection('ArrowRight', expectedValues[1])
        await assertKeyboardSelection('ArrowLeft', expectedValues[0])
    }
    await assertKeyboardSelection('End', expectedValues.at(-1))
    await assertKeyboardSelection('Home', expectedValues[0])
}

function isIgnorableNetworkFailure(url, errorText = '') {
    return url.startsWith('ws://') ||
        url.startsWith('wss://') ||
        errorText.includes('ERR_ABORTED')
}

async function checkMemoryGovernance(page) {
    const trigger = page.getByRole('button', { name: '打开设置面板' })
    await trigger.waitFor({ state: 'visible', timeout: 10_000 })
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: '系统设置' })
    await dialog.waitFor({ state: 'visible', timeout: 10_000 })
    const visualContract = await dialog.evaluate((node) => {
        const style = getComputedStyle(node)
        const rect = node.getBoundingClientRect()
        return {
            opacity: style.opacity,
            backgroundColor: style.backgroundColor,
            backgroundImage: style.backgroundImage,
            filter: style.filter,
            backdropFilter: style.backdropFilter,
            animationName: style.animationName,
            transform: style.transform,
            mixBlendMode: style.mixBlendMode,
            rect: { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left },
            viewport: { width: innerWidth, height: innerHeight },
            pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        }
    })
    if (visualContract.opacity !== '1'
        || !/^rgb\(\d+(?:,?\s+)\d+(?:,?\s+)\d+\)$/u.test(visualContract.backgroundColor)
        || visualContract.backgroundImage !== 'none'
        || visualContract.filter !== 'none'
        || visualContract.backdropFilter !== 'none'
        || visualContract.animationName !== 'none'
        || visualContract.transform !== 'none'
        || visualContract.mixBlendMode !== 'normal'
        || visualContract.rect.top < 0
        || visualContract.rect.left < 0
        || visualContract.rect.right > visualContract.viewport.width + 1
        || visualContract.rect.bottom > visualContract.viewport.height + 1
        || visualContract.pageOverflow) {
        fail(`设置面板实色与视口稳定契约不合格：${JSON.stringify(visualContract)}`)
    }
    await page.screenshot({
        path: path.join(OUTPUT_DIR, 'desktop-settings-panel-opaque.png'),
        fullPage: false,
    })
    if (await dialog.getAttribute('tabindex') !== '-1') {
        fail('设置对话框未提供可编程焦点目标')
    }
    try {
        await page.waitForFunction(() => {
            const panel = document.querySelector('[role="dialog"][aria-label="系统设置"]')
            return panel?.contains(document.activeElement) === true
        }, undefined, { timeout: 2_000 })
    } catch {
        fail('设置对话框打开后焦点未进入面板')
    }

    const memoryToggle = dialog.getByRole('button', { name: /长期记忆治理/ }).first()
    await memoryToggle.click()
    await dialog.getByText('记忆治理演示', { exact: true }).waitFor({ timeout: 10_000 })

    const classScopeSelect = dialog.getByRole('combobox', { name: /班级范围/ })
    await classScopeSelect.waitFor({ state: 'visible', timeout: 10_000 })
    if (!await classScopeSelect.inputValue()) {
        const firstClassId = await classScopeSelect.locator('option').evaluateAll((options) => (
            options.find((option) => option.value)?.value ?? ''
        ))
        if (!firstClassId) {
            throw new Error('长期记忆治理 E2E 缺少可选择的真实班级，无法验证学生范围清空回执')
        }
        await classScopeSelect.selectOption(firstClassId)
    }

    const editButton = dialog.getByRole('button', { name: '编辑', exact: true }).first()
    await editButton.click()
    const editor = dialog.locator('.pr-memory-governance-item textarea').first()
    await editor.fill('记忆治理演示已修改')
    await dialog.getByRole('button', { name: '保存修改', exact: true }).click()
    await dialog.getByText('记忆治理演示已修改', { exact: true }).waitFor({ timeout: 10_000 })

    const deleteButton = dialog.getByRole('button', { name: '删除', exact: true }).first()
    await deleteButton.click()
    await dialog.getByRole('button', { name: '再次确认删除', exact: true }).click()
    await dialog.getByText(/暂无记忆/).waitFor({ timeout: 10_000 })

    const contentInput = dialog.getByRole('textbox', { name: '内容' })
    const consent = dialog.getByRole('checkbox', { name: /我确认内容已脱敏/ })
    const saveButton = dialog.getByRole('button', { name: '保存记忆', exact: true })
    if (await saveButton.isEnabled()) fail('长期记忆未在脱敏确认前保持禁用')
    await contentInput.fill('新增的脱敏教学摘要')
    await consent.check()
    await saveButton.click()
    await dialog.getByText('新增的脱敏教学摘要', { exact: true }).waitFor({ timeout: 10_000 })

    const kindSelect = dialog.getByRole('combobox', { name: '类型' })
    await kindSelect.selectOption('student')
    const studentIdInput = dialog.getByRole('textbox', { name: '脱敏 studentId' })
    await studentIdInput.fill('memory-e2e-student')
    await contentInput.fill('待清空的脱敏学生教学摘要')
    await consent.check()
    await saveButton.click()
    await dialog.getByText('待清空的脱敏学生教学摘要', { exact: true }).waitFor({ timeout: 10_000 })

    const clearButton = dialog.getByRole('button', { name: '清空本班学生记忆', exact: true })
    await clearButton.waitFor({ state: 'visible', timeout: 10_000 })
    await clearButton.click()
    const clearConfirmation = dialog.getByTestId('memory-clear-confirmation')
    await clearConfirmation.waitFor({ state: 'visible', timeout: 5_000 })
    await page.waitForFunction(() => {
        const confirmation = document.querySelector('[data-testid="memory-clear-confirmation"]')
        const confirmButton = confirmation?.querySelector('button:last-child')
        if (!(confirmation instanceof HTMLElement) || !(confirmButton instanceof HTMLElement)) return false
        const confirmationRect = confirmation.getBoundingClientRect()
        const buttonRect = confirmButton.getBoundingClientRect()
        return confirmationRect.top >= 0 && confirmationRect.bottom <= window.innerHeight
            && buttonRect.top >= 0 && buttonRect.bottom <= window.innerHeight
    }, undefined, { timeout: 5_000 })
    await page.screenshot({
        path: path.join(OUTPUT_DIR, 'desktop-memory-clear-confirmation.png'),
        fullPage: false,
    })
    await clearConfirmation.getByRole('button', { name: '取消', exact: true }).click()
    await clearConfirmation.waitFor({ state: 'hidden', timeout: 5_000 })
    await clearButton.click()
    await clearConfirmation.getByRole('button', { name: '确认清空学生记忆', exact: true }).click()
    await clearConfirmation.waitFor({ state: 'hidden', timeout: 10_000 })
    await dialog.getByText('待清空的脱敏学生教学摘要', { exact: true }).waitFor({ state: 'hidden', timeout: 10_000 })

    const focusableSelector = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
    await dialog.evaluate((node, selector) => {
        const focusables = Array.from(node.querySelectorAll(selector)).filter((element) => (
            element instanceof HTMLElement && element.getClientRects().length > 0
        ))
        const last = focusables.at(-1)
        if (last instanceof HTMLElement) last.focus()
    }, focusableSelector)
    await page.keyboard.press('Tab')
    if (!await dialog.evaluate((node) => node.contains(document.activeElement))) {
        fail('设置对话框从末项 Tab 后焦点逃出面板')
    }
    await dialog.evaluate((node, selector) => {
        const focusables = Array.from(node.querySelectorAll(selector)).filter((element) => (
            element instanceof HTMLElement && element.getClientRects().length > 0
        ))
        const first = focusables[0]
        if (first instanceof HTMLElement) first.focus()
    }, focusableSelector)
    await page.keyboard.press('Shift+Tab')
    if (!await dialog.evaluate((node) => node.contains(document.activeElement))) {
        fail('设置对话框从首项 Shift+Tab 后焦点逃出面板')
    }
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden', timeout: 5_000 })
    try {
        await page.waitForFunction(() => (
            document.activeElement?.getAttribute('aria-label') === '打开设置面板'
        ), undefined, { timeout: 2_000 })
    } catch {
        fail('设置对话框关闭后焦点未返回触发按钮')
    }

    // 窄屏设置面板不是把桌面弹层机械缩小：必须在安全区内完整铺开、保持
    // 实色且仅面板自身纵向滚动。完成后恢复桌面视口，避免污染后续路由证据。
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: '打开设置面板' }).click()
    const mobileDialog = page.getByRole('dialog', { name: '系统设置' })
    await mobileDialog.waitFor({ state: 'visible', timeout: 5_000 })
    const mobileVisualContract = await mobileDialog.evaluate((node) => {
        const style = getComputedStyle(node)
        const rect = node.getBoundingClientRect()
        const centerElement = document.elementFromPoint(
            Math.min(innerWidth - 1, Math.max(0, rect.left + rect.width / 2)),
            Math.min(innerHeight - 1, Math.max(0, rect.top + 72)),
        )
        return {
            opacity: style.opacity,
            backgroundColor: style.backgroundColor,
            backdropFilter: style.backdropFilter,
            filter: style.filter,
            animationName: style.animationName,
            transform: style.transform,
            overflowY: style.overflowY,
            rect: { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width },
            viewport: { width: innerWidth, height: innerHeight },
            pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
            panelOwnsHitTarget: centerElement === node || node.contains(centerElement),
        }
    })
    if (mobileVisualContract.opacity !== '1'
        || !/^rgb\(\d+(?:,?\s+)\d+(?:,?\s+)\d+\)$/u.test(mobileVisualContract.backgroundColor)
        || mobileVisualContract.backdropFilter !== 'none'
        || mobileVisualContract.filter !== 'none'
        || mobileVisualContract.animationName !== 'none'
        || mobileVisualContract.transform !== 'none'
        || !['auto', 'scroll'].includes(mobileVisualContract.overflowY)
        || mobileVisualContract.rect.top < 60
        || mobileVisualContract.rect.left < 11
        || mobileVisualContract.rect.right > mobileVisualContract.viewport.width - 11
        || mobileVisualContract.rect.bottom > mobileVisualContract.viewport.height + 1
        || mobileVisualContract.rect.width < 360
        || mobileVisualContract.pageOverflow
        || !mobileVisualContract.panelOwnsHitTarget) {
        fail(`移动设置面板实色与安全区契约不合格：${JSON.stringify(mobileVisualContract)}`)
    }
    await page.screenshot({
        path: path.join(OUTPUT_DIR, 'mobile-settings-panel-opaque.png'),
        fullPage: false,
    })
    await page.keyboard.press('Escape')
    await mobileDialog.waitFor({ state: 'hidden', timeout: 5_000 })
    await page.setViewportSize({ width: 1440, height: 900 })

    // 通知层位于模态框之后：先完成模态内焦点闭环并关闭模态，才按照真实教师
    // 路径验证刚刚产生的治理回执。测试结束时逐条关闭，以免回执遮挡后续页面截图。
    if (!toastOverflowChecked) {
        await checkToastOverflow(page)
        const toastCloseButtons = page.locator('.pr-toast-close')
        while (await toastCloseButtons.count() > 0) {
            await toastCloseButtons.first().click()
            await page.waitForTimeout(220)
        }
    }

    modalFocusManagementChecked = true
    memoryGovernanceChecked = true
}

async function waitForSettledPage(page) {
    await page.waitForLoadState('domcontentloaded')
    await page.locator('#root').waitFor({ state: 'visible', timeout: 20_000 })
    await page.waitForFunction(() => {
        const root = document.querySelector('#root')
        if (!root) return false
        const text = root.textContent ?? ''
        return text.trim().length > 40 && !text.includes('页面加载中…')
    }, undefined, { timeout: 30_000 })
    await page.waitForTimeout(350)
}

async function checkOfflineDisclosure(page) {
    activeRoute = 'offline-disclosure'
    const truthfulMessage = '当前网络不可用；未成功提交的修改不会保存，请恢复连接后重新操作'
    await page.evaluate(() => window.dispatchEvent(new Event('offline')))
    const banner = page.getByText(truthfulMessage, { exact: true })
    await banner.waitFor({ state: 'visible', timeout: 5_000 })
    if (await page.getByText('修改将在恢复连接后自动同步', { exact: false }).count() > 0) {
        fail('离线提示仍承诺不存在的自动同步能力')
    }
    offlineDisclosureChecked = true
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await banner.waitFor({ state: 'hidden', timeout: 5_000 })
}

async function checkKeyboardNavigation(page) {
    activeRoute = 'keyboard-navigation'
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded' })
    await waitForSettledPage(page)
    await page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    })
    await page.keyboard.press('Tab')
    const firstFocused = await page.evaluate(() => ({
        className: document.activeElement instanceof HTMLElement ? document.activeElement.className : '',
        text: document.activeElement?.textContent?.trim() ?? '',
    }))
    if (!String(firstFocused.className).split(/\s+/u).includes('pr-skip-link')) {
        fail(`首个键盘焦点不是跳到主内容链接：${JSON.stringify(firstFocused)}`)
        return
    }
    const skipLink = page.locator('.pr-skip-link')
    if (!await skipLink.isVisible()) {
        fail('跳到主内容链接获得焦点后仍不可见')
        return
    }
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => document.activeElement?.id === 'pr-main-content', undefined, { timeout: 5_000 })
    keyboardNavigationChecked = true
}

/**
 * 桌面侧栏宽度是教师在投影、双屏或低视力放大场景下的实际布局控制器，不能
 * 只让鼠标拖拽可用。该检查在继承认证态的独立 Context 内进行：既验证真实
 * AppShell，又不把 Home/End 产生的本地偏好写回主回归页面。
 */
async function checkSidebarResizerKeyboard(context) {
    activeRoute = 'sidebar-resizer-keyboard'
    const isolatedContext = await context.browser().newContext({
        storageState: await context.storageState(),
    })
    const page = await isolatedContext.newPage()
    try {
        await page.setViewportSize({ width: 1440, height: 900 })
        await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded' })
        await waitForSettledPage(page)
        const resizer = page.getByRole('separator', { name: '侧边栏宽度', exact: true })
        await resizer.waitFor({ state: 'visible', timeout: 10_000 })
        await resizer.focus()
        const focused = await resizer.evaluate((node) => document.activeElement === node)
        if (!focused) {
            fail('侧边栏宽度 separator 无法获得键盘焦点')
        }

        const waitForWidth = async (expected) => {
            try {
                await page.waitForFunction((value) => (
                    document.querySelector('[role="separator"][aria-label="侧边栏宽度"]')
                        ?.getAttribute('aria-valuenow') === String(value)
                ), expected, { timeout: 5_000 })
            } catch {
                const actual = await resizer.evaluate((node) => ({
                    valueNow: node.getAttribute('aria-valuenow'),
                    valueText: node.getAttribute('aria-valuetext'),
                    description: node.getAttribute('aria-description'),
                }))
                fail(`侧边栏键盘宽度未更新到 ${expected}px：${JSON.stringify(actual)}`)
            }
        }

        await page.keyboard.press('Home')
        await waitForWidth(200)
        await page.keyboard.press('ArrowRight')
        await waitForWidth(208)
        await page.keyboard.press('PageUp')
        await waitForWidth(240)
        await page.keyboard.press('End')
        await waitForWidth(640)
        await page.keyboard.press('ArrowLeft')
        await waitForWidth(632)

        const keyboardContract = await resizer.evaluate((node) => ({
            minimum: node.getAttribute('aria-valuemin'),
            maximum: node.getAttribute('aria-valuemax'),
            valueNow: node.getAttribute('aria-valuenow'),
            valueText: node.getAttribute('aria-valuetext'),
            description: node.getAttribute('aria-description'),
            focused: document.activeElement === node,
        }))
        if (keyboardContract.minimum !== '200'
            || keyboardContract.maximum !== '640'
            || keyboardContract.valueNow !== '632'
            || keyboardContract.valueText !== '当前侧边栏宽度 632 像素'
            || !keyboardContract.description?.includes('Home 和 End')
            || !keyboardContract.focused) {
            fail(`侧边栏 separator 缺少完整的值语义或键盘焦点：${JSON.stringify(keyboardContract)}`)
        }

        // 若拖拽时窗口进入移动断点，手柄本身会隐藏；全局拖拽状态必须同步
        // 释放，避免异常光标、禁选正文或遗留 document 级移动监听器。
        await resizer.dispatchEvent('mousedown', { button: 0, clientX: 632 })
        await page.waitForFunction(() => document.body.classList.contains('sidebar-resizing'), undefined, { timeout: 5_000 })
        await page.setViewportSize({ width: 390, height: 844 })
        const mobileCleanup = await page.waitForFunction(() => (
            !document.body.classList.contains('sidebar-resizing')
            && document.querySelector('[role="separator"][aria-label="侧边栏宽度"]') === null
        ), undefined, { timeout: 5_000 }).then(() => true).catch(() => false)
        if (!mobileCleanup) {
            const actual = await page.evaluate(() => ({
                bodyResizing: document.body.classList.contains('sidebar-resizing'),
                resizerCount: document.querySelectorAll('[role="separator"][aria-label="侧边栏宽度"]').length,
            }))
            fail(`侧边栏在移动断点未释放拖拽副作用：${JSON.stringify(actual)}`)
        }
        const mobileGeometry = await page.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            viewportWidth: window.innerWidth,
        }))
        if (mobileGeometry.scrollWidth > mobileGeometry.viewportWidth) {
            fail(`侧边栏调节器切换移动端后引发页面横向溢出：${JSON.stringify(mobileGeometry)}`)
        }
        sidebarResizerKeyboardChecked = true
    } finally {
        await isolatedContext.close()
    }
}

/**
 * 验证连续通知在不丢失反馈的前提下保持克制：折叠态不遮挡首屏，
 * 展开后仍可读到其余通知，并可收回到紧凑状态。
 */
async function checkToastOverflow(page) {
    const expand = page.locator('.pr-toast-overflow-toggle').filter({ hasText: '还有' }).first()
    await expand.waitFor({ state: 'visible', timeout: 5_000 })
    const collapsedCount = await page.locator('.pr-toast').count()
    if (collapsedCount > 2) {
        fail(`通知折叠态仍显示 ${collapsedCount} 条，超过课堂首屏上限`)
    }
    if (await expand.getAttribute('aria-expanded') !== 'false') {
        fail('通知折叠入口未暴露 aria-expanded=false')
    }

    await expand.click()
    await page.waitForFunction((before) => document.querySelectorAll('.pr-toast').length > before, collapsedCount, { timeout: 5_000 })
    const expandedCount = await page.locator('.pr-toast').count()
    if (expandedCount <= collapsedCount) {
        fail('通知展开后未显示被折叠的反馈')
    }

    const collapse = page.locator('.pr-toast-overflow-toggle--collapse')
    await collapse.click()
    await page.waitForFunction(() => document.querySelectorAll('.pr-toast').length <= 2, undefined, { timeout: 5_000 })
    toastOverflowChecked = true
}

/**
 * 通知中心在空列表时没有内部按钮。这个状态不能让 aria-modal 对话框的焦点
 * 停在外部触发器，或在 Tab 时漏出对话框；本检查固定 localStorage 为空，只验证
 * 前端焦点与小屏几何，不制造或解释任何课堂通知。
 */
async function checkNotificationEmptyDialogFocus(context) {
    activeRoute = 'notification-empty-dialog-focus'
    // 通知中心支持跨 Tab 同步；复用主回归页的 Context 会让该页稍后产生的真实
    // 业务反馈注入“空通知”夹具，破坏测试前提。保留认证 storageState，但在独立
    // Context 中运行，才能同时验证生产认证和真正无并发通知的空态焦点边界。
    const isolatedContext = await context.browser().newContext({
        storageState: await context.storageState(),
    })
    const page = await isolatedContext.newPage()
    try {
        await page.addInitScript(() => {
            window.localStorage.setItem('pr-notifications', '[]')
            // 此夹具只审计真正“空通知”的对话框焦点边界。主回归页会按产品
            // 设计经 BroadcastChannel 广播真实业务反馈；让这些异步消息进入
            // 此独立页面会把空态改造成带三项操作的非空态。用同接口、无跨页
            // 派发能力的测试通道隔离它，既不改产品逻辑，也不把通知送达能力
            // 误报为已经测试。
            class IsolatedBroadcastChannel {
                onmessage = null
                onmessageerror = null
                constructor(_name) {}
                postMessage() {}
                close() {}
            }
            Object.defineProperty(window, 'BroadcastChannel', {
                configurable: true,
                writable: true,
                value: IsolatedBroadcastChannel,
            })
            // 通知还有一条主动式 WebSocket 来源。空态夹具不评估推送送达，因此在
            // 应用模块加载前拒绝建连；否则该页自身也可能收到真实 proactive 事件。
            class DisabledWebSocket {
                constructor() {
                    throw new Error('isolated empty-notification fixture disables WebSocket')
                }
            }
            Object.defineProperty(window, 'WebSocket', {
                configurable: true,
                writable: true,
                value: DisabledWebSocket,
            })
        })
        await page.setViewportSize({ width: 1440, height: 900 })
        await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded' })
        await waitForSettledPage(page)

        const isolationContract = await page.evaluate(() => ({
            notificationStorage: window.localStorage.getItem('pr-notifications'),
            broadcastChannel: window.BroadcastChannel.name,
            webSocket: window.WebSocket.name,
        }))
        if (isolationContract.notificationStorage !== '[]'
            || isolationContract.broadcastChannel !== 'IsolatedBroadcastChannel'
            || isolationContract.webSocket !== 'DisabledWebSocket') {
            fail(`空通知夹具未在应用执行前隔离通知来源：${JSON.stringify(isolationContract)}`)
        }

        // HeaderTools 是非首屏懒加载模块。先等待固定占位被真实工具替换，避免把
        // 慢速冷启动误判为通知交互故障；超时仍会失败，并保留明确的定位信息。
        await page.waitForFunction(() => (
            document.querySelector('.pr-header-tools-placeholder') === null
            || document.querySelector('button[aria-label^="通知中心"]') !== null
        ), undefined, { timeout: 30_000 })
        const trigger = page.getByRole('button', { name: /^通知中心/u })
        await trigger.waitFor({ state: 'visible', timeout: 30_000 })
        if (await trigger.getAttribute('aria-label') !== '通知中心') {
            fail('空通知夹具加载后仍出现未读计数，无法证明空面板焦点行为')
        }
        await trigger.focus()
        await trigger.press('Enter')
        const dialog = page.getByRole('dialog', { name: '通知中心', exact: true })
        await dialog.waitFor({ state: 'visible', timeout: 5_000 })
        const emptyDialogContract = await dialog.evaluate((node) => ({
            tabIndex: node.getAttribute('tabindex'),
            empty: node.querySelectorAll('[data-notification-item], .pr-notification-action').length === 0,
            focused: document.activeElement === node,
        }))
        if (emptyDialogContract.tabIndex !== '-1' || !emptyDialogContract.empty || !emptyDialogContract.focused) {
            fail(`空通知对话框未提供可编程焦点或初始焦点未进入面板：${JSON.stringify(emptyDialogContract)}`)
        }
        await page.keyboard.press('Tab')
        const tabForwardFocus = await dialog.evaluate((node) => ({
            retained: document.activeElement === node,
            activeTag: document.activeElement?.tagName ?? null,
            activeClass: document.activeElement?.className ?? null,
        }))
        if (!tabForwardFocus.retained) {
            fail(`空通知对话框在首次 Tab 后让焦点泄漏：${JSON.stringify(tabForwardFocus)}`)
        }
        await page.keyboard.press('Shift+Tab')
        const tabBackwardFocus = await dialog.evaluate((node) => ({
            retained: document.activeElement === node,
            activeTag: document.activeElement?.tagName ?? null,
            activeClass: document.activeElement?.className ?? null,
        }))
        if (!tabBackwardFocus.retained) {
            fail(`空通知对话框在首次 Shift+Tab 后让焦点泄漏：${JSON.stringify(tabBackwardFocus)}`)
        }
        await dialog.screenshot({
            path: path.join(OUTPUT_DIR, 'desktop-notification-empty-dialog-focus.png'),
        })
        await page.keyboard.press('Escape')
        await dialog.waitFor({ state: 'hidden', timeout: 5_000 })
        const restoredTriggerFocus = await page.waitForFunction(
            () => document.activeElement?.getAttribute('aria-label') === '通知中心',
            undefined,
            { timeout: 5_000 },
        ).then(() => true).catch(() => false)
        if (!restoredTriggerFocus) {
            const actualFocus = await page.evaluate(() => {
                const active = document.activeElement
                return {
                    tag: active?.tagName ?? null,
                    ariaLabel: active?.getAttribute('aria-label') ?? null,
                    className: active?.getAttribute('class') ?? null,
                    connected: active?.isConnected ?? false,
                }
            })
            fail(`空通知对话框 Escape 后未将焦点还原至触发器：${JSON.stringify(actualFocus)}`)
        }

        await page.setViewportSize({ width: 390, height: 844 })
        await trigger.click()
        await dialog.waitFor({ state: 'visible', timeout: 5_000 })
        const mobileDialogGeometry = await dialog.evaluate((node) => {
            const rect = node.getBoundingClientRect()
            return {
                pageWidth: document.documentElement.scrollWidth,
                viewportWidth: window.innerWidth,
                left: rect.left,
                right: rect.right,
                width: rect.width,
            }
        })
        if (mobileDialogGeometry.pageWidth > mobileDialogGeometry.viewportWidth + 1
            || mobileDialogGeometry.left < -1
            || mobileDialogGeometry.right > mobileDialogGeometry.viewportWidth + 1
            || mobileDialogGeometry.width <= 0) {
            fail(`空通知对话框移动端出现裁切或页面横向溢出：${JSON.stringify(mobileDialogGeometry)}`)
        }
        await dialog.screenshot({
            path: path.join(OUTPUT_DIR, 'mobile-notification-empty-dialog-focus.png'),
        })
        await page.keyboard.press('Escape')
        await dialog.waitFor({ state: 'hidden', timeout: 5_000 })
        notificationEmptyDialogFocusChecked = true
    } finally {
        await isolatedContext.close()
    }
}

/**
 * Ctrl/Cmd+K 是命令面板唯一的全局唤起入口。窄屏不能因为桌面最小宽度
 * 让面板越界；同时必须保留输入框初始焦点、Tab 边界和回到原触发点的闭环。
 */
async function checkCommandPaletteMobile(context) {
    activeRoute = 'command-palette-mobile'
    const page = await context.newPage()
    try {
        await page.setViewportSize({ width: 390, height: 844 })
        await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded' })
        await waitForSettledPage(page)
        await page.waitForFunction(() => (
            document.querySelector('.pr-header-tools-placeholder') === null
            || document.querySelector('button[aria-label^="通知中心"]') !== null
        ), undefined, { timeout: 30_000 })
        const returnTrigger = page.getByRole('button', { name: /^通知中心/u })
        await returnTrigger.waitFor({ state: 'visible', timeout: 30_000 })
        await returnTrigger.focus()
        await page.keyboard.press('Control+K')

        const dialog = page.getByRole('dialog', { name: '全局命令面板', exact: true })
        await dialog.waitFor({ state: 'visible', timeout: 20_000 })
        const input = dialog.getByRole('combobox', { name: '搜索命令', exact: true })
        await input.waitFor({ state: 'visible', timeout: 10_000 })
        await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '搜索命令', undefined, { timeout: 5_000 })
        const comboContract = await input.evaluate((node) => {
            const activeId = node.getAttribute('aria-activedescendant')
            const active = activeId ? document.getElementById(activeId) : null
            const listbox = document.getElementById(node.getAttribute('aria-controls') ?? '')
            const roving = Array.from(document.querySelectorAll('[role="option"][tabindex="0"]'))
            return {
                role: node.getAttribute('role'),
                expanded: node.getAttribute('aria-expanded'),
                controls: node.getAttribute('aria-controls'),
                activeId,
                activeRole: active?.getAttribute('role'),
                activeSelected: active?.getAttribute('aria-selected'),
                listboxRole: listbox?.getAttribute('role'),
                rovingCount: roving.length,
                rovingId: roving[0]?.id ?? null,
            }
        })
        if (comboContract.role !== 'combobox'
            || comboContract.expanded !== 'true'
            || comboContract.controls !== 'pr-command-results'
            || !comboContract.activeId
            || comboContract.activeRole !== 'option'
            || comboContract.activeSelected !== 'true'
            || comboContract.listboxRole !== 'listbox'
            || comboContract.rovingCount !== 1
            || comboContract.rovingId !== comboContract.activeId) {
            fail(`命令面板搜索框未建立组合框、活动项与结果列表关联：${JSON.stringify(comboContract)}`)
        }
        const initialActiveId = comboContract.activeId
        await page.keyboard.press('ArrowDown')
        await page.waitForFunction((previousId) => {
            const input = document.querySelector('[aria-label="搜索命令"]')
            const activeId = input?.getAttribute('aria-activedescendant')
            const active = activeId ? document.getElementById(activeId) : null
            return Boolean(activeId && activeId !== previousId
                && active?.getAttribute('role') === 'option'
                && active?.getAttribute('aria-selected') === 'true'
                && active?.getAttribute('tabindex') === '0'
                && document.querySelectorAll('[role="option"][tabindex="0"]').length === 1)
        }, initialActiveId, { timeout: 5_000 })

        const panel = page.locator('.pr-cmd-panel')
        const geometry = await panel.evaluate((node) => {
            const rect = node.getBoundingClientRect()
            return {
                pageWidth: document.documentElement.scrollWidth,
                viewportWidth: window.innerWidth,
                left: rect.left,
                right: rect.right,
                width: rect.width,
            }
        })
        if (geometry.pageWidth > geometry.viewportWidth + 1
            || geometry.left < -1
            || geometry.right > geometry.viewportWidth + 1
            || geometry.width <= 0) {
            fail(`命令面板移动端出现裁切或页面横向溢出：${JSON.stringify(geometry)}`)
        }
        await page.keyboard.press('Tab')
        const tabContract = await dialog.evaluate((node) => ({
            withinDialog: node.contains(document.activeElement),
            activeRole: document.activeElement?.getAttribute('role'),
            activeSelected: document.activeElement?.getAttribute('aria-selected'),
        }))
        if (!tabContract.withinDialog || tabContract.activeRole !== 'option' || tabContract.activeSelected !== 'true') {
            fail(`命令面板从输入框 Tab 后没有进入唯一活动选项：${JSON.stringify(tabContract)}`)
        }
        await dialog.screenshot({
            path: path.join(OUTPUT_DIR, 'mobile-command-palette-accessibility.png'),
        })
        await page.keyboard.press('Escape')
        await dialog.waitFor({ state: 'hidden', timeout: 5_000 })
        await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label')?.startsWith('通知中心') === true, undefined, { timeout: 5_000 })
        commandPaletteMobileChecked = true
    } finally {
        await page.close()
    }
}

/**
 * 教案工坊的空白起始页必须是可执行入口，而非只展示文案。
 * 独立页面避免影响主路由截图和后续移动端状态。
 */
async function checkLessonPlanStartExperience(context) {
    activeRoute = 'lesson-plan-start-experience'
    const page = await context.newPage()
    try {
        await page.goto(`${BASE_URL}/lesson-plan`, { waitUntil: 'domcontentloaded' })
        await waitForSettledPage(page)
        const tablist = page.getByRole('tablist', { name: '教案工坊功能区', exact: true })
        const tabs = tablist.getByRole('tab')
        await page.waitForFunction(() => document.querySelectorAll('[data-lesson-plan-tab]').length === 4, undefined, { timeout: 10_000 })
        const tabContract = await tabs.evaluateAll((buttons) => buttons.map((button) => ({
            id: button.id,
            controls: button.getAttribute('aria-controls'),
            selected: button.getAttribute('aria-selected'),
            tabIndex: button.getAttribute('tabindex'),
        })))
        const invalidPanelReference = await tabs.evaluateAll((buttons) => buttons.some((button) => {
            const controls = button.getAttribute('aria-controls')
            const panel = controls ? document.getElementById(controls) : null
            return !panel || panel.getAttribute('aria-labelledby') !== button.id
        }))
        if (tabContract.length !== 4
            || tabContract.some((tab) => !tab.id || !tab.controls)
            || tabContract.filter((tab) => tab.selected === 'true' && tab.tabIndex === '0').length !== 1
            || invalidPanelReference) {
            fail('教案工坊标签缺少唯一选中项、roving tabindex 或双向面板关联')
        }
        await tabs.nth(0).focus()
        await page.keyboard.press('End')
        await page.waitForFunction(() => {
            const tab = document.querySelector('[data-lesson-plan-tab="export"]')
            const panel = tab?.getAttribute('aria-controls') ? document.getElementById(tab.getAttribute('aria-controls')) : null
            return tab?.getAttribute('aria-selected') === 'true'
                && document.activeElement === tab
                && panel?.getAttribute('aria-labelledby') === tab.id
        }, undefined, { timeout: 5_000 })
        await page.keyboard.press('Home')
        await page.waitForFunction(() => {
            const tab = document.querySelector('[data-lesson-plan-tab="templates"]')
            return tab?.getAttribute('aria-selected') === 'true' && document.activeElement === tab
        }, undefined, { timeout: 5_000 })
        const startPanel = page.locator('.pr-lp-tpl-start')
        await startPanel.waitFor({ state: 'visible', timeout: 10_000 })
        if (!await startPanel.getByText('选择模板', { exact: true }).isVisible()
            || !await startPanel.getByText('按需导出', { exact: true }).isVisible()) {
            fail('教案工坊起始页缺少可读的完整备课路径')
        }
        const action = startPanel.getByRole('button', { name: /查看「/ })
        await action.waitFor({ state: 'visible', timeout: 10_000 })
        await action.click()
        await page.locator('.pr-lp-tpl-detail').waitFor({ state: 'visible', timeout: 10_000 })
        await page.getByText('教学环节', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
        lessonPlanStartChecked = true
    } finally {
        await page.close()
    }
}

/**
 * 批改台初始页的真实主任务必须先于空统计/展示内容出现。
 * 验证工作区紧跟流程条、上传区在桌面首屏可见，且尚未选择批改对象时
 * 文件控件仍保持关闭，防止没有归档上下文的作业进入流程。
 */
async function checkGradingInitialAction(page) {
    const stepper = page.locator('.pr-grading-stepper')
    const workspace = page.locator('.pr-grading-body')
    const uploadZone = page.locator('#pr-grading-upload-zone')
    const uploadInput = page.locator('#pr-grading-upload-input')
    await Promise.all([
        stepper.waitFor({ state: 'visible', timeout: 10_000 }),
        workspace.waitFor({ state: 'visible', timeout: 10_000 }),
        uploadZone.waitFor({ state: 'visible', timeout: 10_000 }),
    ])

    const placement = await page.evaluate(() => {
        const stepperNode = document.querySelector('.pr-grading-stepper')
        const workspaceNode = document.querySelector('.pr-grading-body')
        const uploadNode = document.querySelector('#pr-grading-upload-zone')
        if (!(stepperNode instanceof HTMLElement)
            || !(workspaceNode instanceof HTMLElement)
            || !(uploadNode instanceof HTMLElement)) return null
        return {
            workspaceFollowsStepper: Boolean(
                stepperNode.compareDocumentPosition(workspaceNode) & Node.DOCUMENT_POSITION_FOLLOWING,
            ),
            uploadTop: uploadNode.getBoundingClientRect().top,
            viewportHeight: window.innerHeight,
        }
    })
    if (!placement?.workspaceFollowsStepper) {
        fail('批改工作区未紧跟批改流程，初始主任务仍被次要内容打断')
    }
    if (placement && placement.uploadTop >= placement.viewportHeight) {
        fail(`批改上传区未进入桌面首屏（top=${Math.round(placement.uploadTop)}，height=${placement.viewportHeight}）`)
    }
    if (!await uploadInput.isDisabled()) {
        fail('未选择批改对象时上传控件不应开放，可能导致无法归档的作业进入流程')
    }
    gradingInitialActionChecked = true
}

/**
 * 批改结果表由教师的上传→识别→批改流程产生。为了只验证前端的交互/ARIA
 * 契约而不把测试样本宣称为真实学生或模型成效，本检查在独立页面中拦截该
 * 三步 API 并返回显式的 E2E 控制响应；班级、诗篇和题目选择仍经过真实 UI。
 * 它验证：结果区是完整 table/rowgroup 结构，结果行可获得焦点并由 Enter
 * 展开详情，并且动画包装层不再同时处理同一次行点击。
 */
async function checkGradingResultTableKeyboard(context) {
    activeRoute = 'grading-result-table-keyboard'
    const page = await context.newPage()
    // finally 必须在路由尚未完成或前置断言失败时也能释放门闩；声明在 try
    // 外部，避免块级作用域令清理路径本身抛出 ReferenceError 并掩盖原始失败。
    let releaseUploadResponse = () => undefined
    try {
        await page.setViewportSize({ width: 1440, height: 900 })
        // 此段先验证“无减弱动态偏好”下的显式暂停/恢复；不能把执行机器的
        // 系统偏好偷偷当成测试前提。后文会显式切换到 reduce，再验证静态兜底。
        await page.emulateMedia({ reducedMotion: 'no-preference' })
        let classRouteHits = 0
        let failedGradingImageRequests = 0
        const uploadResponseGate = new Promise((resolve) => { releaseUploadResponse = resolve })
        // 测试样本只承担预览布局与交互契约，使用低对比度示意图而非放大的
        // 单像素纯色块，确保回归截图可供人工审阅且不会暗示真实学生作品。
        const controlledPreviewSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="640" viewBox="0 0 960 640" role="img" aria-label="E2E 受控界面预览样本"><defs><linearGradient id="surface" x1="0" x2="1" y1="0" y2="1"><stop stop-color="#f4eee2"/><stop offset="1" stop-color="#e8ddca"/></linearGradient></defs><rect width="960" height="640" fill="url(#surface)"/><path d="M0 470 C170 380 300 520 470 430 S720 370 960 470 V640 H0Z" fill="#b59a71" opacity=".28"/><path d="M0 500 C190 450 350 570 560 470 S790 445 960 500" fill="none" stroke="#8a7254" stroke-width="3" opacity=".38"/><text x="480" y="295" text-anchor="middle" font-family="sans-serif" font-size="32" fill="#665847">E2E 受控预览样本</text><text x="480" y="340" text-anchor="middle" font-family="sans-serif" font-size="18" fill="#8a7254">仅验证前端识别与批改交互</text></svg>`
        await page.route('**/api/classroom/classes', (route) => {
            classRouteHits += 1
            return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ status: 'ok', classes: [{ id: 'E2E-GRADING-CLASS', name: 'E2E 批改班' }] }),
            })
        })
        await page.route('**/api/workbench/poems', (route) => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ status: 'ok', poems: [{ id: 'E2E-GRADING-POEM', title: 'E2E 题源诗', poet: '测试诗人' }] }),
        }))
        await page.route('**/api/grading/students?*', (route) => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ status: 'ok', students: [{ id: 'E2E-GRADING-STUDENT', name: '匿名学生 E2E' }] }),
        }))
        await page.route('**/api/grading/history?*', (route) => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ status: 'ok', batches: [] }),
        }))
        await page.route('**/api/grading/questions?*', (route) => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                status: 'ok',
                questions: [{
                    id: 'E2E-GRADING-QUESTION',
                    stem: 'E2E 题目：请解释意象。',
                    bloomLevel: '理解',
                    type: 'short-answer',
                }],
            }),
        }))
        await page.route('**/api/grading/upload', async (route) => {
            await uploadResponseGate
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    status: 'ok',
                    batchId: 'E2E-GRADING-BATCH',
                    uploadedFiles: [
                        { id: 'E2E-GRADING-FILE-1', url: '/api/grading/files/E2E-GRADING-FILE-1' },
                        { id: 'E2E-GRADING-FILE-2', url: '/api/grading/files/E2E-GRADING-FILE-2' },
                    ],
                    pendingRecognition: 2,
                }),
            })
        })
        await page.route('**/api/grading/recognize', (route) => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                status: 'ok',
                aiGenerated: true,
                recognized: [
                    {
                        fileId: 'E2E-GRADING-FILE-1',
                        studentId: 'E2E-GRADING-STUDENT',
                        questionId: 'E2E-GRADING-QUESTION',
                        studentAnswer: 'E2E 控制识别文本一',
                        confidence: 0.82,
                        needsManualMatch: false,
                    },
                    {
                        fileId: 'E2E-GRADING-FILE-2',
                        studentId: 'E2E-GRADING-STUDENT',
                        questionId: 'E2E-GRADING-QUESTION',
                        studentAnswer: 'E2E 控制识别文本二',
                        confidence: 0.76,
                        needsManualMatch: false,
                    },
                ],
            }),
        }))
        await page.route('**/api/grading/grade', (route) => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                status: 'ok',
                results: [
                    {
                        fileId: 'E2E-GRADING-FILE-1',
                        studentId: 'E2E-GRADING-STUDENT',
                        questionId: 'E2E-GRADING-QUESTION',
                        correct: false,
                        partialScore: 0.5,
                        cognitiveAttribution: 'E2E 控制归因一',
                        feedback: 'E2E 控制反馈一',
                        teacherHint: 'E2E 控制教学提示一',
                        confidence: 0.82,
                        needsHumanReview: true,
                        aiGenerated: true,
                    },
                    {
                        fileId: 'E2E-GRADING-FILE-2',
                        studentId: 'E2E-GRADING-STUDENT',
                        questionId: 'E2E-GRADING-QUESTION',
                        correct: true,
                        partialScore: 1,
                        cognitiveAttribution: 'E2E 控制归因二',
                        feedback: 'E2E 控制反馈二',
                        teacherHint: 'E2E 控制教学提示二',
                        confidence: 0.76,
                        needsHumanReview: false,
                        aiGenerated: true,
                    },
                ],
                summary: { total: 2, correct: 1, partial: 1, wrong: 0, needsReview: 1, avgConfidence: 0.79 },
            }),
        }))
        await page.route('**/api/grading/files/E2E-GRADING-FILE-*', (route) => {
            // FILE-2 的媒体请求被刻意中止，覆盖对象 URL 之外更常见的受保护资源
            // 过期、离线和 CDN 失败路径；样本只证明 UI 恢复行为，不证明学生作业或
            // 批改模型效果。FILE-1 保持可解码，保留正常预览路径的回归覆盖。
            if (route.request().url().includes('E2E-GRADING-FILE-2')) {
                failedGradingImageRequests += 1
                return route.abort('failed')
            }
            return route.fulfill({
                status: 200,
                contentType: 'image/svg+xml',
                body: controlledPreviewSvg,
            })
        })
        await page.goto(`${BASE_URL}/grading`, { waitUntil: 'domcontentloaded' })
        await waitForSettledPage(page)

        const classSelect = page.getByRole('combobox', { name: '班级', exact: true })
        await classSelect.click()
        // 隔离后端以 DEMO_MODE 启动，但这不等同于前端“后端不可达”的本地演示态；
        // 健康检查成功时前端仍走真实上传请求。本检查选择当前数据源中的首个非空
        // 班级，并显式控制 students/history/upload 响应，只证明 UI 状态机与恢复契约，
        // 不把受控夹具冒充为真实课堂、学生或模型效果证据。
        const classListbox = page.getByRole('listbox')
        await classListbox.waitFor({ state: 'visible', timeout: 10_000 })
        const classOptions = classListbox.getByRole('option')
        const classOptionTexts = await classOptions.allTextContents()
        if (classOptionTexts.length < 2) {
            const controlState = await classSelect.evaluate((control) => ({
                expanded: control.getAttribute('aria-expanded'),
                value: control instanceof HTMLInputElement ? control.value : null,
            }))
            fail(
                `批改结果契约测试未取得可选班级：routeHits=${classRouteHits}，`
                + `expanded=${controlState.expanded}，value=${controlState.value ?? 'null'}，`
                + `options=${JSON.stringify(classOptionTexts)}`,
            )
            return
        }
        await classOptions.nth(1).click()
        await page.waitForFunction(() => {
            const control = document.querySelector('input[role="combobox"][aria-label="目标题目"]')
            return control instanceof HTMLInputElement && control.value.includes('E2E 题目')
        }, undefined, { timeout: 10_000 })
        const uploadInput = page.locator('#pr-grading-upload-input')
        await uploadInput.waitFor({ state: 'attached', timeout: 10_000 })
        if (!await uploadInput.isEnabled()) {
            fail('批改结果契约测试中，已选择受控班级/题目后上传控件仍未开启')
            return
        }
        const uploadKeyboardContract = await uploadInput.evaluate((input) => {
            input.focus()
            const style = getComputedStyle(input)
            return {
                focused: document.activeElement === input,
                dropzoneFocused: input.closest('.pr-grading-upload-dropzone')?.matches(':focus-within') ?? false,
                display: style.display,
                visibility: style.visibility,
                tabIndex: input.tabIndex,
            }
        })
        if (!uploadKeyboardContract.focused
            || !uploadKeyboardContract.dropzoneFocused
            || uploadKeyboardContract.display === 'none'
            || uploadKeyboardContract.visibility === 'hidden'
            || uploadKeyboardContract.tabIndex < 0) {
            fail(`批改上传入口仍不可由键盘/读屏到达：${JSON.stringify(uploadKeyboardContract)}`)
        }
        const uploadFixtures = [
            {
                name: 'e2e-grading-1.png',
                mimeType: 'image/png',
                buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL5YQAAAABJRU5ErkJggg==', 'base64'),
            },
            {
                name: 'e2e-grading-2.png',
                mimeType: 'image/png',
                buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL5YQAAAABJRU5ErkJggg==', 'base64'),
            },
        ]
        const [fileChooser] = await Promise.all([
            page.waitForEvent('filechooser', { timeout: 5_000 }),
            uploadInput.press('Enter'),
        ])
        await fileChooser.setFiles(uploadFixtures)
        const uploadProgress = page.locator('.pr-grading-upload-thumb-progress')
        await page.waitForFunction(() => (
            document.querySelectorAll('.pr-grading-upload-thumb-progress').length === 2
        ), undefined, { timeout: 5_000 })
        const uploadTruthContract = await uploadProgress.evaluateAll((nodes) => ({
            count: nodes.length,
            values: nodes.map((node) => node.getAttribute('aria-valuenow')),
            minimums: nodes.map((node) => node.getAttribute('aria-valuemin')),
            maximums: nodes.map((node) => node.getAttribute('aria-valuemax')),
            labels: nodes.map((node) => node.getAttribute('aria-label')),
            fillStyles: nodes.map((node) => {
                const fill = node.querySelector('.pr-grading-upload-thumb-progress-fill')
                const style = fill ? getComputedStyle(fill) : null
                return {
                    animationName: style?.animationName ?? null,
                    transitionDuration: style?.transitionDuration ?? null,
                    transform: style?.transform ?? null,
                    backgroundImage: style?.backgroundImage ?? null,
                }
            }),
            disabledRemoveCount: document.querySelectorAll('.pr-grading-upload-thumb-remove:disabled').length,
            inputDisabled: document.querySelector('#pr-grading-upload-input')?.matches(':disabled') ?? false,
        }))
        if (uploadTruthContract.count !== 2
            || uploadTruthContract.values.some((value) => value !== null)
            || uploadTruthContract.minimums.some((value) => value !== '0')
            || uploadTruthContract.maximums.some((value) => value !== '100')
            || uploadTruthContract.labels.some((label) => !label?.includes('服务端未提供单文件百分比'))
            || uploadTruthContract.fillStyles.some((style) => (
                style.animationName !== 'none'
                || style.transitionDuration !== '0s'
                || style.transform !== 'none'
                || style.backgroundImage === 'none'
            ))
            || uploadTruthContract.disabledRemoveCount !== 2
            || !uploadTruthContract.inputDisabled) {
            fail(`批量上传仍伪造百分比、制造每文件动画或允许并发改批次：${JSON.stringify(uploadTruthContract)}`)
        }
        const uploadSource = await fs.readFile(
            path.resolve('src/pages/GradingPage/UploadZone.tsx'),
            'utf8',
        )
        const forbiddenUploadProgressSource = [
            /setInterval\s*\(/,
            /progressTimers/,
            /p\.progress/,
            /aria-valuenow\s*=/,
            /style\s*=\s*\{\{\s*display:\s*['"]none['"]/,
        ].filter((pattern) => pattern.test(uploadSource)).map((pattern) => pattern.source)
        if (forbiddenUploadProgressSource.length > 0) {
            fail(`批量上传源码重新引入伪百分比或每文件定时器：${forbiddenUploadProgressSource.join(', ')}`)
        }
        releaseUploadResponse()
        const recognizeAction = page.getByRole('button', { name: '开始识别', exact: true })
        await recognizeAction.waitFor({ state: 'visible', timeout: 10_000 })
        if (!await classSelect.isDisabled()) {
            fail('批次已建立后仍允许切换班级，可能把旧批次挂入新班级上下文')
        }
        const uploadedPreviewContract = await page.locator('.pr-grading-upload-grid').evaluate((grid) => ({
            doneCount: grid.querySelectorAll('.pr-grading-upload-thumb.is-done').length,
            previewCount: grid.querySelectorAll('.pr-grading-upload-thumb').length,
            removeCount: grid.querySelectorAll('.pr-grading-upload-thumb-remove').length,
            lockText: grid.closest('.pr-grading-upload-previews')
                ?.querySelector('.pr-grading-upload-previews-lock')?.textContent?.trim() ?? null,
        }))
        if (uploadedPreviewContract.doneCount !== 2
            || uploadedPreviewContract.previewCount !== 2
            || uploadedPreviewContract.removeCount !== 0
            || !uploadedPreviewContract.lockText?.includes('批次已锁定')) {
            fail(`上传成功后批次未锁定、预览状态不完整或仍暴露只删 UI 的假删除入口：${JSON.stringify(uploadedPreviewContract)}`)
        }

        await page.getByRole('button', { name: '新建批次', exact: true }).click()
        await page.waitForFunction(() => (
            document.querySelectorAll('.pr-grading-upload-thumb').length === 0
            && document.querySelector('#pr-grading-upload-input')?.matches(':enabled')
        ), undefined, { timeout: 5_000 })
        if (await classSelect.isDisabled()) {
            fail('新建批次后班级选择仍被错误锁定')
        }
        await uploadInput.setInputFiles(uploadFixtures)
        await recognizeAction.waitFor({ state: 'visible', timeout: 10_000 })
        await page.waitForFunction(() => (
            document.querySelectorAll('.pr-grading-upload-thumb.is-done').length === 2
            && document.querySelectorAll('.pr-grading-upload-thumb.is-uploading').length === 0
            && document.querySelectorAll('.pr-grading-upload-thumb-remove').length === 0
        ), undefined, { timeout: 5_000 })
        await recognizeAction.click()
        const gradeAction = page.getByRole('button', { name: '开始批改', exact: true })
        await gradeAction.waitFor({ state: 'visible', timeout: 10_000 })
        await verifyRovingTablist(page, {
            tablistName: '逐张作业',
            dataAttribute: 'data-grading-recognition-tab',
            expectedValues: ['E2E-GRADING-FILE-1', 'E2E-GRADING-FILE-2'],
            boundary: '智能批改逐张作业',
        })
        await gradeAction.click()

        const table = page.getByRole('table', { name: '批改结果', exact: true })
        const row = table.locator('.pr-grading-table-row').first()
        const animationWrapper = table.locator('.pr-animated-list__item').first()
        await Promise.all([
            table.waitFor({ state: 'visible', timeout: 10_000 }),
            row.waitFor({ state: 'visible', timeout: 10_000 }),
        ])
        await row.click()
        await page.locator('#grading-detail-E2E-GRADING-FILE-1').waitFor({ state: 'visible', timeout: 10_000 })
        await row.focus()
        await row.press('Enter')
        await page.locator('#grading-detail-E2E-GRADING-FILE-1').waitFor({ state: 'hidden', timeout: 10_000 })
        await row.press('Enter')
        await page.locator('#grading-detail-E2E-GRADING-FILE-1').waitFor({ state: 'visible', timeout: 10_000 })

        const contract = await table.evaluate((node) => {
            const headerGroup = node.querySelector(':scope > [role="rowgroup"]')
            const bodyGroup = node.querySelector('.pr-animated-list')
            const wrapper = bodyGroup?.querySelector(':scope > .pr-animated-list__item')
            const resultRow = wrapper?.querySelector('.pr-grading-table-row')
            const detail = wrapper?.querySelector('#grading-detail-E2E-GRADING-FILE-1')
            return {
                headerGroupRole: headerGroup?.getAttribute('role'),
                bodyGroupRole: bodyGroup?.getAttribute('role'),
                wrapperRole: wrapper?.getAttribute('role'),
                wrapperSelected: wrapper?.classList.contains('pr-animated-list__item--selected') ?? null,
                rowRole: resultRow?.getAttribute('role'),
                rowExpanded: resultRow?.getAttribute('aria-expanded'),
                focusedRow: document.activeElement === resultRow,
                cellCount: resultRow?.querySelectorAll(':scope > [role="cell"]').length ?? 0,
                detailRole: detail?.getAttribute('role'),
                detailCellColspan: detail?.querySelector('[role="cell"]')?.getAttribute('aria-colspan'),
            }
        })
        if (contract.headerGroupRole !== 'rowgroup'
            || contract.bodyGroupRole !== 'rowgroup'
            || contract.wrapperRole !== 'presentation'
            || contract.wrapperSelected !== false
            || contract.rowRole !== 'row'
            || contract.rowExpanded !== 'true'
            || !contract.focusedRow
            || contract.cellCount !== 5
            || contract.detailRole !== 'row'
            || contract.detailCellColspan !== '5') {
            fail(`批改结果表格的语义/单次触发/键盘展开契约不完整：${JSON.stringify(contract)}`)
        }
        const progressToggle = page.getByRole('button', { name: '切换批改进度概览', exact: true })
        await progressToggle.waitFor({ state: 'visible', timeout: 10_000 })
        const toggleContractBefore = await progressToggle.evaluate((toggle) => ({
            role: toggle.getAttribute('role'),
            pressed: toggle.getAttribute('aria-pressed'),
            tabIndex: toggle.getAttribute('tabindex'),
        }))
        if (toggleContractBefore.role !== 'button'
            || toggleContractBefore.pressed !== 'false'
            || toggleContractBefore.tabIndex !== '0') {
            fail(`批改进度切换器未提供可识别的初始键盘语义：${JSON.stringify(toggleContractBefore)}`)
        }
        await progressToggle.focus()
        await progressToggle.press('Space')
        await page.waitForFunction(() => {
            const toggle = document.querySelector('[aria-label="切换批改进度概览"]')
            return toggle?.getAttribute('aria-pressed') === 'true' && document.activeElement === toggle
        }, undefined, { timeout: 5_000 })
        await progressToggle.press('Enter')
        await page.waitForFunction(() => {
            const toggle = document.querySelector('[aria-label="切换批改进度概览"]')
            return toggle?.getAttribute('aria-pressed') === 'false' && document.activeElement === toggle
        }, undefined, { timeout: 5_000 })
        gradingProgressTransitionKeyboardChecked = true

        // 与图片堆不同，前后对比卡是自动轮播的信息展示；它不能把“有动画”
        // 当作唯一交互。这里以真实批改流派生的数据验证显式暂停、键盘恢复、
        // 悬停冻结、减弱动态静态化与窄屏命中区。受控样本仅证明 UI 行为。
        const cardSwap = page.locator('.pr-grading-showcase-card--swap .pr-card-swap-container')
        await cardSwap.waitFor({ state: 'visible', timeout: 10_000 })
        await cardSwap.getByRole('button', { name: '暂停自动轮播', exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
        // 名称会在暂停后从“暂停自动轮播”切换为“继续自动轮播”。先用可访问
        // 名称确认初始语义，再以稳定 class 指向同一个原生按钮进行状态迁移。
        const motionControl = cardSwap.locator('.pr-card-swap__motion-control')
        await motionControl.waitFor({ state: 'visible', timeout: 10_000 })
        const initialSwapContract = await cardSwap.evaluate((node) => {
            const control = node.querySelector('.pr-card-swap__motion-control')
            const cards = Array.from(node.querySelectorAll('.pr-card-swap__card'))
            return {
                motion: node.getAttribute('data-card-swap-motion'),
                controlTag: control?.tagName,
                controlPressed: control?.getAttribute('aria-pressed'),
                controlLabel: control?.getAttribute('aria-label'),
                controlDisabled: control instanceof HTMLButtonElement ? control.disabled : null,
                cardLabels: cards.map((card) => card.querySelector('.pr-grading-showcase-card-tag')?.textContent?.trim() ?? ''),
                cardsInteractive: cards.map((card) => ({
                    role: card.getAttribute('role'),
                    tabIndex: card.getAttribute('tabindex'),
                    cursor: window.getComputedStyle(card).cursor,
                })),
            }
        })
        if (initialSwapContract.motion !== 'running'
            || initialSwapContract.controlTag !== 'BUTTON'
            || initialSwapContract.controlPressed !== 'false'
            || initialSwapContract.controlLabel !== '暂停自动轮播'
            || initialSwapContract.controlDisabled !== false
            || !initialSwapContract.cardLabels.includes('批改结果 · 第 1 组')
            || !initialSwapContract.cardLabels.includes('批改结果 · 第 2 组')
            || initialSwapContract.cardsInteractive.some((card) => card.role !== null || card.tabIndex !== null || card.cursor === 'pointer')) {
            fail(`前后对比轮播缺少诚实的初始动态/交互语义：${JSON.stringify(initialSwapContract)}`)
        }
        await cardSwap.hover()
        await page.waitForFunction(() => (
            document.querySelector('.pr-grading-showcase-card--swap .pr-card-swap-container')
                ?.getAttribute('data-card-swap-motion') === 'paused-by-interaction'
        ), undefined, { timeout: 5_000 })
        await motionControl.click()
        await page.waitForFunction(() => {
            const node = document.querySelector('.pr-grading-showcase-card--swap .pr-card-swap-container')
            const control = node?.querySelector('.pr-card-swap__motion-control')
            return node?.getAttribute('data-card-swap-motion') === 'paused-by-user'
                && control?.getAttribute('aria-pressed') === 'true'
        }, undefined, { timeout: 5_000 })
        await page.waitForTimeout(100)
        const pausedTransforms = await cardSwap.locator('.pr-card-swap__card').evaluateAll((cards) => (
            cards.map((card) => window.getComputedStyle(card).transform)
        ))
        await page.waitForTimeout(550)
        const laterPausedTransforms = await cardSwap.locator('.pr-card-swap__card').evaluateAll((cards) => (
            cards.map((card) => window.getComputedStyle(card).transform)
        ))
        if (JSON.stringify(pausedTransforms) !== JSON.stringify(laterPausedTransforms)) {
            fail(`前后对比轮播在教师明确暂停后仍持续改变：before=${JSON.stringify(pausedTransforms)} after=${JSON.stringify(laterPausedTransforms)}`)
        }
        // 用户暂停优先于悬停暂停；先离开悬停区，再通过键盘恢复，避免鼠标
        // 位置成为“恢复后是否运行”的隐藏前提。
        await page.mouse.move(0, 0)
        await motionControl.press('Space')
        await page.waitForFunction(() => {
            const node = document.querySelector('.pr-grading-showcase-card--swap .pr-card-swap-container')
            const control = node?.querySelector('.pr-card-swap__motion-control')
            return node?.getAttribute('data-card-swap-motion') === 'running'
                && control?.getAttribute('aria-pressed') === 'false'
                && control?.getAttribute('aria-label') === '暂停自动轮播'
        }, undefined, { timeout: 5_000 })
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await page.waitForFunction(() => {
            const node = document.querySelector('.pr-grading-showcase-card--swap .pr-card-swap-container')
            const control = node?.querySelector('.pr-card-swap__motion-control')
            return node?.getAttribute('data-card-swap-motion') === 'reduced-motion'
                && control instanceof HTMLButtonElement
                && control.disabled
                && control.getAttribute('aria-label') === '已按系统减弱动态偏好静止显示'
        }, undefined, { timeout: 5_000 })
        const reducedMotionTransforms = await cardSwap.locator('.pr-card-swap__card').evaluateAll((cards) => (
            cards.map((card) => window.getComputedStyle(card).transform)
        ))
        await page.waitForTimeout(550)
        const laterReducedMotionTransforms = await cardSwap.locator('.pr-card-swap__card').evaluateAll((cards) => (
            cards.map((card) => window.getComputedStyle(card).transform)
        ))
        if (JSON.stringify(reducedMotionTransforms) !== JSON.stringify(laterReducedMotionTransforms)) {
            fail(`减弱动态偏好下前后对比轮播仍发生变换：before=${JSON.stringify(reducedMotionTransforms)} after=${JSON.stringify(laterReducedMotionTransforms)}`)
        }
        await page.emulateMedia({ reducedMotion: 'no-preference' })
        await page.waitForFunction(() => (
            document.querySelector('.pr-grading-showcase-card--swap .pr-card-swap-container')
                ?.getAttribute('data-card-swap-motion') === 'running'
        ), undefined, { timeout: 5_000 })
        await page.setViewportSize({ width: 390, height: 844 })
        await cardSwap.scrollIntoViewIfNeeded()
        const mobileSwapGeometry = await cardSwap.evaluate((node) => {
            const control = node.querySelector('.pr-card-swap__motion-control')
            const rect = control?.getBoundingClientRect()
            return {
                pageWidth: document.documentElement.scrollWidth,
                viewportWidth: window.innerWidth,
                control: rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height } : null,
            }
        })
        if (mobileSwapGeometry.pageWidth > mobileSwapGeometry.viewportWidth + 1
            || !mobileSwapGeometry.control
            || mobileSwapGeometry.control.left < -1
            || mobileSwapGeometry.control.right > mobileSwapGeometry.viewportWidth + 1
            || mobileSwapGeometry.control.top < -1
            || mobileSwapGeometry.control.bottom > 844 + 1
            || mobileSwapGeometry.control.width < 24
            || mobileSwapGeometry.control.height < 24) {
            fail(`前后对比轮播移动端控制器存在裁切、横向溢出或命中区不足：${JSON.stringify(mobileSwapGeometry)}`)
        }
        await cardSwap.screenshot({ path: path.join(OUTPUT_DIR, 'mobile-grading-card-swap-motion-control.png') })
        await page.setViewportSize({ width: 1440, height: 900 })
        gradingCardSwapMotionControlChecked = true

        // 同一份受控批改流会派生出答题图片堆。这里不把图片或批改结果当成教学成效，
        // 只核验可见卡片的原生语义、键盘进入预览、焦点闭环与小屏几何。
        const gallery = page.getByRole('group', { name: '学生答题图片堆，可点击查看大图', exact: true })
        await gallery.waitFor({ state: 'visible', timeout: 10_000 })
        const visibleGalleryCards = gallery.locator('.pr-stack-gallery__card:not([aria-hidden="true"])')
        await page.waitForFunction(() => document.querySelectorAll('.pr-stack-gallery__card:not([aria-hidden="true"])').length === 2, undefined, { timeout: 10_000 })
        const galleryContract = await gallery.evaluate((node) => {
            const cards = Array.from(node.querySelectorAll('.pr-stack-gallery__card'))
            const visible = cards.filter((card) => card.getAttribute('aria-hidden') !== 'true')
            return {
                role: node.getAttribute('role'),
                cardTags: cards.map((card) => card.tagName),
                fauxRoles: cards.map((card) => card.getAttribute('role')),
                visibleTabIndexes: visible.map((card) => card.getAttribute('tabindex')),
                visibleLabels: visible.map((card) => card.getAttribute('aria-label')),
                currentCount: visible.filter((card) => card.getAttribute('aria-current') === 'true').length,
            }
        })
        if (galleryContract.role !== 'group'
            || galleryContract.cardTags.length !== 2
            || galleryContract.cardTags.some((tag) => tag !== 'BUTTON')
            || galleryContract.fauxRoles.some((role) => role !== null)
            || galleryContract.visibleTabIndexes.some((tabIndex) => tabIndex !== '0')
            || galleryContract.visibleLabels.some((label) => !label?.startsWith('查看答题图片：'))
            || galleryContract.currentCount !== 1) {
            fail(`答题图片堆未满足原生操作语义或可见卡片焦点契约：${JSON.stringify(galleryContract)}`)
        }

        const topGalleryCard = gallery.locator('.pr-stack-gallery__card[aria-current="true"]')
        const topGalleryCardLabel = await topGalleryCard.getAttribute('aria-label')
        if (!topGalleryCardLabel) {
            fail('答题图片堆未暴露当前卡片的具名操作入口')
        } else {
            await topGalleryCard.focus()
            await page.waitForFunction((label) => document.activeElement?.getAttribute('aria-label') === label, topGalleryCardLabel, { timeout: 5_000 })
            // autoplay 间隔为 4s；保持焦点超过一个完整周期，证实键盘操作时不会让当前卡片悄然换位。
            await page.waitForTimeout(4_250)
            const pausedCardLabel = await gallery.locator('.pr-stack-gallery__card[aria-current="true"]').getAttribute('aria-label')
            if (pausedCardLabel !== topGalleryCardLabel) {
                fail(`答题图片堆在键盘焦点期间仍自动换位：before=${topGalleryCardLabel} after=${pausedCardLabel ?? 'null'}`)
            }

            await topGalleryCard.press('Enter')
            const lightbox = page.getByRole('dialog', { name: topGalleryCardLabel.replace('查看答题图片：', ''), exact: true })
            await lightbox.waitFor({ state: 'visible', timeout: 5_000 })
            const closeAction = lightbox.getByRole('button', { name: '关闭', exact: true })
            await page.waitForFunction(() => document.activeElement?.classList.contains('pr-stack-gallery-lightbox__close') === true, undefined, { timeout: 5_000 })
            const lightboxActions = lightbox.getByRole('button')
            const lightboxActionCount = await lightboxActions.count()
            if (lightboxActionCount < 2) {
                fail(`答题图片预览缺少可验证的导航焦点边界：buttonCount=${lightboxActionCount}`)
            } else {
                const lastLightboxAction = lightboxActions.nth(lightboxActionCount - 1)
                await closeAction.press('Tab')
                await page.waitForFunction((label) => document.activeElement?.getAttribute('aria-label') === label, await lastLightboxAction.getAttribute('aria-label'), { timeout: 5_000 })
                await lastLightboxAction.press('Tab')
                await page.waitForFunction(() => document.activeElement?.classList.contains('pr-stack-gallery-lightbox__close') === true, undefined, { timeout: 5_000 })
                await closeAction.press('Shift+Tab')
                await page.waitForFunction((label) => document.activeElement?.getAttribute('aria-label') === label, await lastLightboxAction.getAttribute('aria-label'), { timeout: 5_000 })
            }
            await page.keyboard.press('Escape')
            await lightbox.waitFor({ state: 'hidden', timeout: 5_000 })
            await page.waitForFunction((label) => document.activeElement?.getAttribute('aria-label') === label, topGalleryCardLabel, { timeout: 5_000 })
        }

        // 资源失败不得把卡片堆或放大预览留成无语义的空白。这里直接检查被中止的
        // 第二张受控图片在两层 UI 均替换为可被读屏宣布的明确状态；它仍可被打开，
        // 让教师知道是媒体不可用，而非误以为点击操作失效。
        const failedCard = gallery.locator('.pr-stack-gallery__card:has([role="status"][aria-label^="图片暂不可用："])')
        const failedCardStatus = failedCard.getByRole('status')
        await Promise.all([
            failedCard.waitFor({ state: 'visible', timeout: 10_000 }),
            failedCardStatus.waitFor({ state: 'visible', timeout: 10_000 }),
        ])
        const failedCardCount = await failedCard.count()
        const failedCardLabel = await failedCard.getAttribute('aria-label')
        const failedStatusLabel = await failedCardStatus.getAttribute('aria-label')
        const failedCaption = failedCardLabel?.replace(/^查看答题图片：/, '') ?? ''
        const failedCardContract = await failedCardStatus.evaluate((node) => ({
            role: node.getAttribute('role'),
            live: node.getAttribute('aria-live'),
            text: node.textContent?.replace(/\s+/g, ' ').trim() ?? '',
            brokenImages: node.querySelectorAll('img').length,
        }))
        if (failedCardCount !== 1
            || !failedCardLabel?.startsWith('查看答题图片：')
            || !failedStatusLabel?.startsWith('图片暂不可用：')
            || !failedStatusLabel.includes(failedCaption)
            || failedGradingImageRequests < 1
            || failedCardContract.role !== 'status'
            || failedCardContract.live !== 'polite'
            || !failedCardContract.text.includes('图片暂不可用')
            || failedCardContract.brokenImages !== 0) {
            fail(`答题图片堆资源失败未替换为可读卡片终态：${JSON.stringify({ failedGradingImageRequests, failedCardCount, failedCardLabel, failedStatusLabel, failedCardContract })}`)
        }

        await failedCard.focus()
        await failedCard.press('Enter')
        const failedLightbox = page.getByRole('dialog', { name: failedCaption, exact: true })
        const failedLightboxStatus = failedLightbox.getByRole('status', { name: failedStatusLabel ?? '', exact: true })
        await Promise.all([
            failedLightbox.waitFor({ state: 'visible', timeout: 5_000 }),
            failedLightboxStatus.waitFor({ state: 'visible', timeout: 5_000 }),
        ])
        const failedLightboxContract = await failedLightboxStatus.evaluate((node) => ({
            role: node.getAttribute('role'),
            live: node.getAttribute('aria-live'),
            text: node.textContent?.replace(/\s+/g, ' ').trim() ?? '',
            brokenImages: node.querySelectorAll('img').length,
        }))
        if (failedLightboxContract.role !== 'status'
            || failedLightboxContract.live !== 'polite'
            || !failedLightboxContract.text.includes('图片暂不可用')
            || failedLightboxContract.brokenImages !== 0) {
            fail(`答题图片堆资源失败仍打开空白预览：${JSON.stringify(failedLightboxContract)}`)
        }
        await page.keyboard.press('Escape')
        await failedLightbox.waitFor({ state: 'hidden', timeout: 5_000 })
        await page.waitForFunction((label) => document.activeElement?.getAttribute('aria-label') === label, failedCardLabel, { timeout: 5_000 })
        await gallery.screenshot({
            path: path.join(OUTPUT_DIR, 'desktop-grading-stack-gallery-accessibility.png'),
        })
        await page.setViewportSize({ width: 390, height: 844 })
        await gallery.scrollIntoViewIfNeeded()
        const mobileGalleryGeometry = await gallery.evaluate((node) => {
            const viewportWidth = window.innerWidth
            const visibleCards = Array.from(node.querySelectorAll('.pr-stack-gallery__card:not([aria-hidden="true"])'))
            const bounds = visibleCards.map((card) => {
                const rect = card.getBoundingClientRect()
                return { left: rect.left, right: rect.right, height: rect.height }
            })
            return {
                pageWidth: document.documentElement.scrollWidth,
                viewportWidth,
                bounds,
            }
        })
        if (mobileGalleryGeometry.pageWidth > mobileGalleryGeometry.viewportWidth + 1
            || mobileGalleryGeometry.bounds.length !== 2
            || mobileGalleryGeometry.bounds.some((bound) => bound.left < -1 || bound.right > mobileGalleryGeometry.viewportWidth + 1 || bound.height < 40)) {
            fail(`答题图片堆移动端出现裁切、无效触控尺寸或页面横向溢出：${JSON.stringify(mobileGalleryGeometry)}`)
        }
        await gallery.screenshot({
            path: path.join(OUTPUT_DIR, 'mobile-grading-stack-gallery-accessibility.png'),
        })
        gradingStackGalleryAccessibilityChecked = true
        await page.screenshot({
            path: path.join(OUTPUT_DIR, 'desktop-grading-result-table-keyboard.png'),
            fullPage: false,
        })
        gradingResultTableKeyboardChecked = true
    } finally {
        releaseUploadResponse()
        await page.close()
    }
}

/**
 * 小屏开课页不能让七张模式卡把班级、诗篇与开课核验完全推离首屏。
 * 默认仅保留当前模式，教师可显式展开和收起全部真实模式；该测试不启动课堂，
 * 只验证信息层级与可逆的选择入口。
 */
async function checkClassroomMobileLaunch(page) {
    const modeCards = page.locator('.pr-classroom-hero-modes .pr-classroom-mode-card')
    const toggle = page.getByRole('button', { name: '展开其余 6 种教学模式' })
    const setup = page.locator('.pr-classroom-setup')
    // 当前选择必须始终成为唯一主卡；主卡只呈现该模式已定义的组织方式与建议节奏，
    // 不以预测性的学生人数、学情或课堂结果填充空间。
    const assertFeatureMatchesSelection = async (stage) => {
        const selected = page.locator('.pr-classroom-hero-modes .pr-classroom-mode-card[aria-pressed="true"]')
        const feature = page.locator('.pr-classroom-hero-modes .pr-classroom-mode-card--feature')
        await Promise.all([
            selected.waitFor({ state: 'visible', timeout: 5_000 }),
            feature.waitFor({ state: 'visible', timeout: 5_000 }),
        ])
        const [selectedText, featureText] = await Promise.all([selected.innerText(), feature.innerText()])
        if (!featureText.includes(selectedText.split('\n')[0] ?? '')
            || !featureText.includes('课堂组织')
            || !featureText.includes('建议节奏')) {
            fail(`课堂主卡未跟随当前选择或缺少真实模式元信息（${stage}）：${JSON.stringify({ selectedText, featureText })}`)
        }
    }
    await Promise.all([
        toggle.waitFor({ state: 'visible', timeout: 10_000 }),
        setup.waitFor({ state: 'visible', timeout: 10_000 }),
    ])

    const initialVisible = await modeCards.evaluateAll((nodes) => nodes.filter((node) => {
        const element = node instanceof HTMLElement ? node : null
        return Boolean(element && element.getClientRects().length > 0)
    }).length)
    if (initialVisible !== 1) {
        fail(`移动端开课页初始可见模式应为 1 张，实际为 ${initialVisible} 张`)
    }
    const setupTop = await setup.evaluate((node) => node.getBoundingClientRect().top)
    const viewportHeight = await page.evaluate(() => window.innerHeight)
    if (setupTop >= viewportHeight) {
        fail(`移动端班级/诗篇配置仍被推离首屏（top=${Math.round(setupTop)}，height=${viewportHeight}）`)
    }
    if (await toggle.getAttribute('aria-expanded') !== 'false') {
        fail('移动端模式展开入口未暴露 aria-expanded=false')
    }
    await assertFeatureMatchesSelection('初始状态')

    await toggle.click()
    const collapse = page.getByRole('button', { name: '收起其余教学模式' })
    await collapse.waitFor({ state: 'visible', timeout: 5_000 })
    const expandedVisible = await modeCards.evaluateAll((nodes) => nodes.filter((node) => {
        const element = node instanceof HTMLElement ? node : null
        return Boolean(element && element.getClientRects().length > 0)
    }).length)
    if (expandedVisible !== 7) {
        fail(`移动端展开后应可选择全部 7 种模式，实际为 ${expandedVisible} 张`)
    }
    if (await collapse.getAttribute('aria-expanded') !== 'true') {
        fail('移动端模式展开后未暴露 aria-expanded=true')
    }
    // TextSwitch 也会正确暴露七个真实模式名；这里验证的是模式卡选择，必须
    // 限定在模式卡容器内，不能依赖全页面模糊名称恰好唯一。
    const flyingFlower = page
        .locator('.pr-classroom-hero-modes')
        .getByRole('button', { name: /飞花令擂台/u })
    await flyingFlower.click()
    await page.waitForFunction(() => {
        const feature = document.querySelector('.pr-classroom-hero-modes .pr-classroom-mode-card--feature')
        return feature?.textContent?.includes('飞花令擂台')
            && feature.textContent.includes('关键字飞花接花')
            && feature.textContent.includes('约 12 分钟')
    }, undefined, { timeout: 5_000 })
    await assertFeatureMatchesSelection('切换飞花令擂台后')
    await collapse.click()
    await page.waitForFunction(() => {
        const nodes = Array.from(document.querySelectorAll('.pr-classroom-hero-modes .pr-classroom-mode-card'))
        return nodes.filter((node) => node instanceof HTMLElement && node.getClientRects().length > 0).length === 1
    }, undefined, { timeout: 5_000 })
    await assertFeatureMatchesSelection('收起其余模式后')
    classroomMobileLaunchChecked = true
}

/**
 * 桌面端右侧摘要与左侧主卡是教师开课前的最后核对点。
 * 关键课堂组织信息若用省略号截断，视觉上虽“整齐”，实际会隐藏开课决策依据；
 * 该检查要求其自然换行且不存在水平或垂直裁切。
 */
async function checkClassroomLaunchBriefFullText(page) {
    const inspection = await page.locator('.pr-classroom-launch-brief-facts > div').evaluateAll((nodes) => {
        const fact = nodes.find((node) => node.querySelector('dt')?.textContent?.trim() === '课堂节奏')
        const value = fact?.querySelector('dd')
        if (!(value instanceof HTMLElement)) return null
        const style = window.getComputedStyle(value)
        return {
            text: value.textContent?.trim() ?? '',
            whiteSpace: style.whiteSpace,
            textOverflow: style.textOverflow,
            overflowX: style.overflowX,
            overflowY: style.overflowY,
            clientWidth: value.clientWidth,
            scrollWidth: value.scrollWidth,
            clientHeight: value.clientHeight,
            scrollHeight: value.scrollHeight,
        }
    })
    if (!inspection
        || !inspection.text.includes('全班协作闯关')
        || !inspection.text.includes('约 15 分钟')
        || inspection.whiteSpace !== 'normal'
        || inspection.textOverflow !== 'clip'
        || inspection.overflowX !== 'visible'
        || inspection.overflowY !== 'visible'
        || inspection.scrollWidth > inspection.clientWidth + 1
        || inspection.scrollHeight > inspection.clientHeight + 1) {
        fail(`课堂摘要中的关键节奏信息被裁切或未完整呈现：${JSON.stringify(inspection)}`)
        return
    }
    classroomLaunchBriefFullTextChecked = true
}

/**
 * ElectricBorder 只服务于模式卡已选中态，绝不能成为额外的交互目标、Canvas
 * 绘制循环或减少动态偏好下的持续动画。本检查运行在主生产 E2E 的
 * reduced-motion 浏览器上下文中，只证明前端 DOM/CSS 契约，不把它延伸为
 * 课堂成效或设备性能结论。
 */
async function checkElectricBorderDecoration(page) {
    const selected = page.locator('.pr-classroom-hero-modes .pr-classroom-mode-card[aria-pressed="true"]')
    await selected.waitFor({ state: 'visible', timeout: 5_000 })
    const contract = await selected.evaluate((card) => {
        const decoration = card.querySelector(':scope > .pr-electric-border[data-electric-decoration="true"]')
        if (!(decoration instanceof HTMLElement)) return null
        const style = window.getComputedStyle(decoration)
        const before = window.getComputedStyle(decoration, '::before')
        const after = window.getComputedStyle(decoration, '::after')
        return {
            ariaHidden: decoration.getAttribute('aria-hidden'),
            dataDecoration: decoration.getAttribute('data-electric-decoration'),
            pointerEvents: style.pointerEvents,
            position: style.position,
            top: style.top,
            right: style.right,
            bottom: style.bottom,
            left: style.left,
            canvasCount: decoration.querySelectorAll('canvas').length,
            descendantElementCount: decoration.querySelectorAll('*').length,
            beforeAnimation: before.animationName,
            afterAnimation: after.animationName,
            mediaReduced: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        }
    })

    if (!contract
        || contract.ariaHidden !== 'true'
        || contract.dataDecoration !== 'true'
        || contract.pointerEvents !== 'none'
        || contract.position !== 'absolute'
        || [contract.top, contract.right, contract.bottom, contract.left].some((value) => value !== '0px')
        || contract.canvasCount !== 0
        || contract.descendantElementCount !== 0
        || !contract.mediaReduced
        || contract.beforeAnimation !== 'none'
        || contract.afterAnimation !== 'none') {
        fail(`课堂模式选中装饰未保持 CSS 静态降级与非交互契约：${JSON.stringify(contract)}`)
        return
    }

    electricBorderDecorationChecked = true
}

/**
 * 教学闭环是驾驶舱六个真实业务入口，不是装饰卡片样例。本检查使用生产构建，
 * 验证六张随包 WebP 与业务入口一一对应、不会再请求运行时插画 API，同时覆盖
 * 原生链接、媒体查询以及桌面/触控布局；它不评价教学质量或比赛结果。
 */
async function checkDashboardMagicBentoContract(context) {
    activeRoute = 'dashboard-magic-bento-contract'
    const page = await context.newPage()
    const runtimeErrors = []
    const expectedHrefs = [
        '/dashboard?tab=diagnosis',
        '/workbench',
        '/lesson-plan',
        '/classroom',
        '/grading',
        '/report',
    ]
    const expectedTitles = ['学情诊断', '智能命题', '教案工坊', '课堂导播', '智能批改', '教研报告']
    const expectedImagePaths = [
        '/images/teaching-loop/diagnose.webp',
        '/images/teaching-loop/workbench.webp',
        '/images/teaching-loop/lesson-plan.webp',
        '/images/teaching-loop/classroom.webp',
        '/images/teaching-loop/grading.webp',
        '/images/teaching-loop/report.webp',
    ]

    page.on('pageerror', (error) => runtimeErrors.push(error.message))

    try {
        await page.setViewportSize({ width: 1440, height: 900 })
        await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded' })
        await waitForSettledPage(page)

        const section = page.locator('section.pr-dashboard-magic-bento[aria-label="教学闭环六大环节"]')
        const grid = section.locator('.pr-dashboard-magic-bento-grid.pr-magic-bento-grid')
        const links = grid.locator('.pr-magic-bento-card--interactive')
        await section.waitFor({ state: 'visible', timeout: 10_000 })
        await section.scrollIntoViewIfNeeded()
        await grid.waitFor({ state: 'visible', timeout: 10_000 })

        await page.waitForFunction(() => Array.from(document.querySelectorAll(
            '.pr-dashboard-magic-bento .pr-magic-bento-card__image',
        )).length === 6 && Array.from(document.querySelectorAll(
            '.pr-dashboard-magic-bento .pr-magic-bento-card__image',
        )).every((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0), undefined, { timeout: 10_000 })

        const desktopContract = await grid.evaluate((root, { expectedHrefs: hrefs, expectedTitles: titles, expectedImagePaths: imagePaths }) => {
            const cells = Array.from(root.querySelectorAll(':scope > .pr-magic-bento-cell'))
            const cards = cells.map((cell) => cell.querySelector('.pr-magic-bento-card'))
            const cardRects = cards.map((card) => card?.getBoundingClientRect())
            const focusableSelector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
            const longAnimations = root.getAnimations({ subtree: true }).filter((animation) => {
                const timing = animation.effect?.getComputedTiming()
                return animation.playState === 'running'
                    && (timing?.iterations === Infinity || Number(timing?.duration ?? 0) > 20)
            })
            const resourceNames = performance.getEntriesByType('resource').map((entry) => entry.name.toLowerCase())
            const normalizeHref = (value) => {
                const url = new URL(value, window.location.href)
                return `${url.pathname}${url.search}`
            }
            const durationsAreZero = (value) => value
                .split(',')
                .every((duration) => Number.parseFloat(duration) === 0)

            return {
                sectionCount: document.querySelectorAll('section.pr-dashboard-magic-bento[aria-label="教学闭环六大环节"]').length,
                renderer: root.getAttribute('data-magic-bento-renderer'),
                declaredCount: Number(root.getAttribute('data-magic-bento-card-count')),
                motion: root.getAttribute('data-magic-bento-motion'),
                starsEnabled: root.getAttribute('data-magic-bento-stars'),
                spotlightEnabled: root.getAttribute('data-magic-bento-spotlight'),
                role: root.getAttribute('role'),
                cellCount: cells.length,
                cellRoles: cells.map((cell) => cell.getAttribute('role')),
                cardTags: cards.map((card) => card?.tagName ?? null),
                explicitRoles: cards.map((card) => card?.getAttribute('role') ?? null),
                explicitTabIndexes: cards.map((card) => card?.getAttribute('tabindex') ?? null),
                hrefs: cards.map((card) => normalizeHref(card?.getAttribute('href') ?? '')),
                hrefsMatch: cards.every((card, index) => normalizeHref(card?.getAttribute('href') ?? '') === hrefs[index]),
                titlesMatch: cards.every((card, index) => card?.querySelector('h3')?.textContent?.trim() === titles[index]),
                descriptionsPresent: cards.every((card) => Boolean(card?.querySelector('.pr-magic-bento-card__description')?.textContent?.trim())),
                focusableCounts: cells.map((cell) => cell.querySelectorAll(focusableSelector).length),
                mediaAriaHidden: cards.map((card) => card?.querySelector('.pr-magic-bento-card__media')?.getAttribute('aria-hidden') ?? null),
                imageContracts: cards.map((card) => {
                    const image = card?.querySelector('.pr-magic-bento-card__image')
                    if (!(image instanceof HTMLImageElement)) return null
                    return {
                        src: new URL(image.currentSrc || image.src, window.location.href).pathname,
                        alt: image.getAttribute('alt'),
                        complete: image.complete,
                        naturalWidth: image.naturalWidth,
                        naturalHeight: image.naturalHeight,
                        state: image.closest('[data-image-state]')?.getAttribute('data-image-state') ?? null,
                    }
                }),
                imagesMatch: cards.every((card, index) => {
                    const image = card?.querySelector('.pr-magic-bento-card__image')
                    return image instanceof HTMLImageElement
                        && new URL(image.currentSrc || image.src, window.location.href).pathname === imagePaths[index]
                }),
                canvasCount: root.querySelectorAll('canvas').length,
                svgCount: root.querySelectorAll('svg').length,
                oldEffectCount: document.querySelectorAll('.pr-magic-bento-particle, .pr-magic-bento-ripple, body > .pr-magic-bento-global-spotlight').length,
                runtimeStyleCount: document.querySelectorAll('#pr-magic-bento-styles').length,
                staticStarCount: root.querySelectorAll('.pr-magic-bento-card__star').length,
                columnCount: window.getComputedStyle(root).gridTemplateColumns.split(/\s+/).filter(Boolean).length,
                cardsContained: cards.every((card, index) => {
                    const rect = cardRects[index]
                    const titleRect = card?.querySelector('.pr-magic-bento-card__title')?.getBoundingClientRect()
                    const descriptionRect = card?.querySelector('.pr-magic-bento-card__description')?.getBoundingClientRect()
                    return Boolean(rect && titleRect && descriptionRect)
                        && titleRect.left >= rect.left - 1
                        && titleRect.right <= rect.right + 1
                        && descriptionRect.left >= rect.left - 1
                        && descriptionRect.right <= rect.right + 1
                        && descriptionRect.bottom <= rect.bottom + 1
                        && card.scrollWidth <= card.clientWidth + 1
                        && card.scrollHeight <= card.clientHeight + 1
                }),
                pageHasHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
                reducedMotionMatches: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
                cardsStatic: cards.every((card) => card && window.getComputedStyle(card).transform === 'none'),
                transitionsDisabled: cards.every((card) => {
                    if (!card) return false
                    return durationsAreZero(window.getComputedStyle(card).transitionDuration)
                        && durationsAreZero(window.getComputedStyle(card, '::before').transitionDuration)
                        && durationsAreZero(window.getComputedStyle(card, '::after').transitionDuration)
                }),
                starLayersHidden: cards.every((card) => {
                    const layer = card?.querySelector('.pr-magic-bento-card__stars')
                    return layer ? window.getComputedStyle(layer).display === 'none' : true
                }),
                longAnimationCount: longAnimations.length,
                gsapResources: resourceNames.filter((name) => name.includes('gsap-vendor')).length,
                illustrationApiResources: resourceNames.filter((name) => name.includes('/api/illustration/scene/')).length,
            }
        }, { expectedHrefs, expectedTitles, expectedImagePaths })
        if (desktopContract.sectionCount !== 1
            || desktopContract.renderer !== 'css'
            || desktopContract.declaredCount !== 6
            || desktopContract.motion !== 'system'
            || desktopContract.starsEnabled !== 'on'
            || desktopContract.spotlightEnabled !== 'on'
            || desktopContract.role !== 'list'
            || desktopContract.cellCount !== 6
            || desktopContract.cellRoles.some((role) => role !== 'listitem')
            || desktopContract.cardTags.some((tag) => tag !== 'A')
            || desktopContract.explicitRoles.some((role) => role !== null)
            || desktopContract.explicitTabIndexes.some((tabIndex) => tabIndex !== null)
            || !desktopContract.hrefsMatch
            || !desktopContract.titlesMatch
            || !desktopContract.descriptionsPresent
            || desktopContract.focusableCounts.some((count) => count !== 1)
            || desktopContract.mediaAriaHidden.some((value) => value !== 'true')
            || !desktopContract.imagesMatch
            || desktopContract.imageContracts.some((image) => !image
                || image.alt !== ''
                || !image.complete
                || image.naturalWidth !== 1280
                || image.naturalHeight !== 720
                || image.state !== 'loaded')
            || desktopContract.illustrationApiResources !== 0
            || desktopContract.canvasCount !== 0
            || desktopContract.svgCount !== 0
            || desktopContract.oldEffectCount !== 0
            || desktopContract.runtimeStyleCount !== 0
            || desktopContract.staticStarCount !== 60
            || desktopContract.columnCount !== 3
            || !desktopContract.cardsContained
            || desktopContract.pageHasHorizontalOverflow
            || !desktopContract.reducedMotionMatches
            || !desktopContract.cardsStatic
            || !desktopContract.transitionsDisabled
            || !desktopContract.starLayersHidden
            || desktopContract.longAnimationCount !== 0) {
            fail(`教学闭环桌面 CSS/语义/静态契约不合格：${JSON.stringify(desktopContract)}`)
        }

        for (const title of expectedTitles) {
            // 页面侧栏可能同时存在“教案工坊 / 课堂导播”等同名导航。
            // 此处验证的是教学闭环自身的可访问树，必须限定在网格内。
            const accessibleLink = grid.getByRole('link', { name: new RegExp(title) })
            if (await accessibleLink.count() !== 1) {
                fail(`教学闭环链接缺少唯一可访问名称：${title}`)
            }
        }

        await links.nth(0).focus()
        for (let index = 1; index < expectedHrefs.length; index += 1) {
            await page.keyboard.press('Tab')
            const focusedHref = await page.evaluate(() => {
                const active = document.activeElement
                if (!(active instanceof HTMLAnchorElement)) return null
                const url = new URL(active.href)
                return `${url.pathname}${url.search}`
            })
            if (focusedHref !== expectedHrefs[index]) {
                fail(`教学闭环 Tab 顺序错误：期望 ${expectedHrefs[index]}，实际 ${focusedHref}`)
                break
            }
        }
        await page.keyboard.press('Tab')
        const focusTrapped = await page.evaluate(() => Boolean(document.activeElement?.closest('.pr-magic-bento-grid')))
        if (focusTrapped) fail('教学闭环卡片把 Tab 焦点困在网格内')

        await links.nth(0).focus()
        const focusRing = await links.nth(0).evaluate((link) => {
            const style = window.getComputedStyle(link)
            return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) }
        })
        if (focusRing.style === 'none' || focusRing.width < 2) {
            fail(`教学闭环链接缺少清晰键盘焦点环：${JSON.stringify(focusRing)}`)
        }
        const urlBeforeSpace = page.url()
        await page.keyboard.press('Space')
        await page.waitForTimeout(100)
        if (page.url() !== urlBeforeSpace) fail('原生链接被错误赋予 Space 按钮激活语义')

        await page.evaluate(() => {
            window.__e2eMagicBentoMutationCount = 0
            window.__e2eMagicBentoObserver = new MutationObserver((records) => {
                for (const record of records) {
                    for (const node of record.addedNodes) {
                        if (!(node instanceof Element)) continue
                        if (node.matches('.pr-magic-bento-particle, .pr-magic-bento-ripple, .pr-magic-bento-global-spotlight')
                            || node.querySelector('.pr-magic-bento-particle, .pr-magic-bento-ripple, .pr-magic-bento-global-spotlight')) {
                            window.__e2eMagicBentoMutationCount += 1
                        }
                    }
                }
            })
            window.__e2eMagicBentoObserver.observe(document.body, { childList: true, subtree: true })
        })
        await links.nth(0).hover()
        await page.mouse.move(400, 420)
        await links.nth(0).evaluate((link) => {
            document.addEventListener('click', (event) => event.preventDefault(), { capture: true, once: true })
            link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
        })
        await page.waitForTimeout(300)
        const legacyEffectContract = await page.evaluate(() => ({
            mutationCount: window.__e2eMagicBentoMutationCount,
            currentCount: document.querySelectorAll('.pr-magic-bento-particle, .pr-magic-bento-ripple, body > .pr-magic-bento-global-spotlight').length,
            staticStarCount: document.querySelectorAll('.pr-magic-bento-grid .pr-magic-bento-card__star').length,
            runtimeStyleCount: document.querySelectorAll('#pr-magic-bento-styles').length,
        }))
        if (legacyEffectContract.mutationCount !== 0
            || legacyEffectContract.currentCount !== 0
            || legacyEffectContract.staticStarCount !== 60
            || legacyEffectContract.runtimeStyleCount !== 0) {
            fail(`教学闭环交互仍产生旧粒子/涟漪/全局聚光灯副作用：${JSON.stringify(legacyEffectContract)}`)
        }

        const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
        const sourceUrl = page.url()
        const ctrlPopupPromise = context.waitForEvent('page', { timeout: 8_000 })
        await links.nth(1).click({ modifiers: [modifier] })
        const ctrlPopup = await ctrlPopupPromise
        await ctrlPopup.waitForURL((url) => url.pathname === '/workbench', { timeout: 8_000 })
        if (page.url() !== sourceUrl) fail('Ctrl/Cmd 点击教学入口错误改变了源页面')
        await ctrlPopup.close()

        const middlePopupPromise = context.waitForEvent('page', { timeout: 8_000 })
        await links.nth(2).click({ button: 'middle' })
        const middlePopup = await middlePopupPromise
        await middlePopup.waitForURL((url) => url.pathname === '/lesson-plan', { timeout: 8_000 })
        if (page.url() !== sourceUrl) fail('中键点击教学入口错误改变了源页面')
        await middlePopup.close()

        await page.evaluate(() => {
            document.documentElement.dataset.e2eMagicBentoDocument = 'alive'
            window.__e2eMagicBentoNavigationEntries = performance.getEntriesByType('navigation').length
        })
        await links.nth(0).focus()
        await page.keyboard.press('Enter')
        await page.waitForURL((url) => url.pathname === '/dashboard' && url.searchParams.get('tab') === 'diagnosis', { timeout: 8_000 })
        const spaContract = await page.evaluate(() => ({
            marker: document.documentElement.dataset.e2eMagicBentoDocument,
            before: window.__e2eMagicBentoNavigationEntries,
            after: performance.getEntriesByType('navigation').length,
        }))
        if (spaContract.marker !== 'alive' || spaContract.before !== spaContract.after) {
            fail(`普通 Enter 激活没有保持 SPA 文档：${JSON.stringify(spaContract)}`)
        }
        await page.goBack()
        await page.waitForURL((url) => url.pathname === '/dashboard' && !url.searchParams.has('tab'), { timeout: 8_000 })
        await grid.waitFor({ state: 'visible', timeout: 8_000 })

        // 历史返回会重新挂载 Dashboard。即使命中浏览器内存缓存，React 的
        // onLoad 状态也要在后续任务中提交；立即截图会把 loading 纸色骨架
        // 误当成真实空图。证据必须等待六张随包 WebP 全部完成解码。
        await page.waitForFunction(() => {
            const images = Array.from(document.querySelectorAll(
                '.pr-dashboard-magic-bento .pr-magic-bento-card__image',
            ))
            return images.length === 6 && images.every((image) => (
                image instanceof HTMLImageElement
                && image.complete
                && image.naturalWidth === 1280
                && image.naturalHeight === 720
                && image.closest('[data-image-state]')?.getAttribute('data-image-state') === 'loaded'
                && Number.parseFloat(window.getComputedStyle(image).opacity) >= 0.9
            ))
        }, undefined, { timeout: 10_000 })

        // decode() + 双 rAF 把断言从“DOM 状态已提交”推进到“像素可绘制”。
        await page.evaluate(async () => {
            const images = Array.from(document.querySelectorAll(
                '.pr-dashboard-magic-bento .pr-magic-bento-card__image',
            )).filter((image) => image instanceof HTMLImageElement)
            await Promise.all(images.map((image) => image.decode()))
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        })

        await section.screenshot({ path: path.join(OUTPUT_DIR, 'desktop-dashboard-magic-bento.png') })

        await page.emulateMedia({ media: 'screen', reducedMotion: 'reduce', forcedColors: 'active' })
        await links.nth(0).focus()
        const forcedColorsContract = await grid.evaluate((root) => {
            const cards = Array.from(root.querySelectorAll('.pr-magic-bento-card'))
            const first = cards[0]
            const focusStyle = first ? window.getComputedStyle(first) : null
            return {
                matches: window.matchMedia('(forced-colors: active)').matches,
                cardCount: cards.length,
                bordersVisible: cards.every((card) => {
                    const style = window.getComputedStyle(card)
                    return style.borderStyle === 'solid' && Number.parseFloat(style.borderWidth) >= 1
                }),
                shadowsRemoved: cards.every((card) => window.getComputedStyle(card).boxShadow === 'none'),
                focusOutlineStyle: focusStyle?.outlineStyle ?? 'none',
                focusOutlineWidth: Number.parseFloat(focusStyle?.outlineWidth ?? '0'),
                decorationHidden: cards.every((card) => (
                    window.getComputedStyle(card, '::before').display === 'none'
                    && window.getComputedStyle(card, '::after').display === 'none'
                    && window.getComputedStyle(card.querySelector('.pr-magic-bento-card__wash')).display === 'none'
                    && window.getComputedStyle(card.querySelector('.pr-magic-bento-card__media'), '::before').display === 'none'
                    && window.getComputedStyle(card.querySelector('.pr-magic-bento-card__media'), '::after').display === 'none'
                )),
                imageHidden: cards.every((card) => {
                    const image = card.querySelector('.pr-magic-bento-card__image')
                    return image ? window.getComputedStyle(image).display === 'none' : true
                }),
                pageHasHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
            }
        })
        if (!forcedColorsContract.matches
            || forcedColorsContract.cardCount !== 6
            || !forcedColorsContract.bordersVisible
            || !forcedColorsContract.shadowsRemoved
            || forcedColorsContract.focusOutlineStyle === 'none'
            || forcedColorsContract.focusOutlineWidth < 3
            || !forcedColorsContract.decorationHidden
            || !forcedColorsContract.imageHidden
            || forcedColorsContract.pageHasHorizontalOverflow) {
            fail(`教学闭环 forced-colors 兜底不合格：${JSON.stringify(forcedColorsContract)}`)
        }
        await section.screenshot({ path: path.join(OUTPUT_DIR, 'desktop-dashboard-magic-bento-forced-colors.png') })

        await page.emulateMedia({ media: 'print', reducedMotion: 'reduce', forcedColors: 'none' })
        const printContract = await grid.evaluate((root) => {
            const cards = Array.from(root.querySelectorAll('.pr-magic-bento-card'))
            const textSelector = '.pr-magic-bento-card__label, .pr-magic-bento-card__title, .pr-magic-bento-card__description, .pr-magic-bento-card__go'
            return {
                matches: window.matchMedia('print').matches,
                columnCount: window.getComputedStyle(root).gridTemplateColumns.split(/\s+/).filter(Boolean).length,
                cardsAvoidBreak: cards.every((card) => window.getComputedStyle(card).breakInside === 'avoid'),
                minHeightsRemoved: cards.every((card) => Number.parseFloat(window.getComputedStyle(card).minHeight) === 0),
                transformsRemoved: cards.every((card) => window.getComputedStyle(card).transform === 'none'),
                shadowsRemoved: cards.every((card) => window.getComputedStyle(card).boxShadow === 'none'),
                bordersVisible: cards.every((card) => window.getComputedStyle(card).borderStyle === 'solid'),
                textIsBlack: Array.from(root.querySelectorAll(textSelector)).every((node) => window.getComputedStyle(node).color === 'rgb(0, 0, 0)'),
                pageHasHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
            }
        })
        if (!printContract.matches
            || printContract.columnCount !== 2
            || !printContract.cardsAvoidBreak
            || !printContract.minHeightsRemoved
            || !printContract.transformsRemoved
            || !printContract.shadowsRemoved
            || !printContract.bordersVisible
            || !printContract.textIsBlack
            || printContract.pageHasHorizontalOverflow) {
            fail(`教学闭环打印兜底不合格：${JSON.stringify(printContract)}`)
        }
        await page.emulateMedia({ media: 'screen', reducedMotion: 'reduce', forcedColors: 'none' })

        const touchContext = await context.browser().newContext({
            storageState: await context.storageState(),
            viewport: { width: 390, height: 844 },
            locale: 'zh-CN',
            reducedMotion: 'reduce',
            hasTouch: true,
            isMobile: true,
        })
        try {
            const touchPage = await touchContext.newPage()
            await touchPage.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded' })
            await waitForSettledPage(touchPage)
            const touchSection = touchPage.locator('section.pr-dashboard-magic-bento[aria-label="教学闭环六大环节"]')
            const touchGrid = touchSection.locator('.pr-magic-bento-grid')
            await touchSection.scrollIntoViewIfNeeded()
            const touchContract = await touchGrid.evaluate((root) => {
                const cards = Array.from(root.querySelectorAll('.pr-magic-bento-card'))
                const rects = cards.map((card) => card.getBoundingClientRect())
                const left = rects[0]?.left ?? 0
                return {
                    hoverNone: window.matchMedia('(hover: none)').matches,
                    pointerCoarse: window.matchMedia('(pointer: coarse)').matches,
                    columnCount: window.getComputedStyle(root).gridTemplateColumns.split(/\s+/).filter(Boolean).length,
                    cardCount: cards.length,
                    sameLeft: rects.every((rect) => Math.abs(rect.left - left) <= 1),
                    cardsInViewport: rects.every((rect) => rect.left >= -1 && rect.right <= window.innerWidth + 1),
                    minCardHeight: Math.min(...rects.map((rect) => rect.height)),
                    transformsStatic: cards.every((card) => window.getComputedStyle(card).transform === 'none'),
                    starLayersHidden: cards.every((card) => {
                        const stars = card.querySelector('.pr-magic-bento-card__stars')
                        return stars ? window.getComputedStyle(stars).display === 'none' : true
                    }),
                    imagesLoaded: cards.every((card) => {
                        const image = card.querySelector('.pr-magic-bento-card__image')
                        return image instanceof HTMLImageElement
                            && image.complete
                            && image.naturalWidth === 1280
                            && image.naturalHeight === 720
                    }),
                    pageHasHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
                }
            })
            if ((!touchContract.hoverNone && !touchContract.pointerCoarse)
                || touchContract.columnCount !== 1
                || touchContract.cardCount !== 6
                || !touchContract.sameLeft
                || !touchContract.cardsInViewport
                || touchContract.minCardHeight < 250
                || !touchContract.transformsStatic
                || !touchContract.starLayersHidden
                || !touchContract.imagesLoaded
                || touchContract.pageHasHorizontalOverflow) {
                fail(`教学闭环真实触控/粗指针布局不合格：${JSON.stringify(touchContract)}`)
            }
            await touchSection.screenshot({ path: path.join(OUTPUT_DIR, 'mobile-dashboard-magic-bento.png') })
        } finally {
            await touchContext.close()
        }

        const sourceBoundary = await fs.readFile(path.resolve('src/components/ui/MagicBento.tsx'), 'utf8')
        const forbiddenSourcePatterns = [
            /from\s+['"]gsap['"]/,
            /requestAnimationFrame\s*\(/,
            /set(?:Timeout|Interval)\s*\(/,
            /addEventListener\s*\(/,
            /(?:document|window)\s*\./,
            /Math\.random\s*\(/,
            /createElement\s*\(/,
            /<canvas\b/i,
            /new\s+WebGL/i,
        ]
        const matchedForbiddenPatterns = forbiddenSourcePatterns
            .filter((pattern) => pattern.test(sourceBoundary))
            .map((pattern) => pattern.source)
        if (matchedForbiddenPatterns.length > 0) {
            fail(`MagicBento 源码重新引入运行时动效副作用：${matchedForbiddenPatterns.join(', ')}`)
        }
        if (runtimeErrors.length > 0) {
            fail(`教学闭环专项出现浏览器运行时异常：${runtimeErrors.join(' | ')}`)
        }

        await page.evaluate(() => window.__e2eMagicBentoObserver?.disconnect())
        dashboardMagicBentoContractChecked = true
    } finally {
        await page.close()
    }
}

/**
 * 异步列表是跨页面基础设施。本门禁先故意扣住告警响应，证明 query pending
 * 时 ref 尚未挂载；释放后再验证列表不透明、PRM 无位移。随后硬断言旧的右侧
 * 章节导航及其持久化状态均已删除，并复验页面吸顶标题与无横向溢出。
 */
async function checkDashboardNavigationPrimitives(context) {
    activeRoute = 'dashboard-navigation-primitives'
    const page = await context.newPage()
    let releaseAlerts = () => undefined
    const alertsGate = new Promise((resolve) => { releaseAlerts = resolve })
    let alertRequestCount = 0
    page.on('pageerror', (error) => fail(`导航基础设施页面运行时错误：${error.message}`))

    try {
        await page.addInitScript(() => {
            window.localStorage.removeItem('pr-demo-mode')
            if (!window.sessionStorage.getItem('e2e-anchor-storage-initialized')) {
                window.localStorage.removeItem('poetic-realm.anchormap-expanded')
                window.sessionStorage.setItem('e2e-anchor-storage-initialized', '1')
            }
        })
        await page.setViewportSize({ width: 1440, height: 900 })
        await page.route('**/api/dashboard/alerts?**', async (route) => {
            alertRequestCount += 1
            await alertsGate
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    status: 'ok',
                    alerts: [{
                        id: 'E2E-ASYNC-ALERT',
                        level: 'warning',
                        title: 'E2E 异步挂载可见性',
                        detail: '仅验证 query pending 后挂载的列表不会永久透明。',
                        timestamp: '2026-08-10T00:00:00.000Z',
                    }],
                }),
            })
        })

        await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded' })
        await page.locator('.pr-alerts-list .pr-skeleton').first().waitFor({ state: 'visible', timeout: 10_000 })
        releaseAlerts()
        const asyncAlert = page.getByText('E2E 异步挂载可见性', { exact: true })
            .locator('xpath=ancestor::article[@role="listitem"]')
        await asyncAlert.waitFor({ state: 'attached', timeout: 10_000 })
        await page.waitForFunction(() => {
            const item = Array.from(document.querySelectorAll('.pr-alert-item'))
                .find((candidate) => candidate.textContent?.includes('E2E 异步挂载可见性'))
            return item ? Number.parseFloat(getComputedStyle(item).opacity) >= 0.99 : false
        }, undefined, { timeout: 10_000 })
        const asyncContract = await asyncAlert.evaluate((item) => {
            const style = getComputedStyle(item)
            return {
                opacity: Number.parseFloat(style.opacity),
                transform: style.transform,
                transitionDuration: style.transitionDuration,
                transitionProperty: style.transitionProperty,
                reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
            }
        })
        if (alertRequestCount < 1
            || asyncContract.opacity < 0.99
            || asyncContract.transform !== 'none'
            || !asyncContract.reducedMotion
            || (asyncContract.transitionDuration !== '0s'
                && asyncContract.transitionProperty !== 'none')) {
            fail(`异步挂载列表未保持可见或未遵守动态效果偏好：${JSON.stringify({ alertRequestCount, ...asyncContract })}`)
        }
        dashboardAsyncContentVisibilityChecked = true

        const removedNavigationContract = await page.evaluate(() => ({
            navigationCount: document.querySelectorAll('[data-anchor-map="navigation"], .pr-anchor-map').length,
            chapterButtonCount: Array.from(document.querySelectorAll('button')).filter((button) => (
                button.textContent?.trim() === '章节导航'
                || button.getAttribute('aria-label') === '章节导航'
            )).length,
            persistedState: localStorage.getItem('poetic-realm.anchormap-expanded'),
            pageHasHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        }))
        if (removedNavigationContract.navigationCount !== 0
            || removedNavigationContract.chapterButtonCount !== 0
            || removedNavigationContract.persistedState !== null
            || removedNavigationContract.pageHasHorizontalOverflow) {
            fail(`右侧章节导航或其持久化残留仍存在：${JSON.stringify(removedNavigationContract)}`)
        }
        const [reportPageSource, reportPreviewSource] = await Promise.all([
            fs.readFile(path.resolve('src/pages/ReportPage/ReportPage.tsx'), 'utf8'),
            fs.readFile(path.resolve('src/pages/ReportPage/ReportPreview.tsx'), 'utf8'),
        ])
        const removedReportChromeContract = {
            gradualBlurImportOrRender: /GradualBlur|pr-gradual-blur/u.test(reportPageSource),
            reportTocDom: /pr-rpt-preview-toc|handleTocClick|activeSection/u.test(reportPreviewSource),
        }
        if (removedReportChromeContract.gradualBlurImportOrRender
            || removedReportChromeContract.reportTocDom) {
            fail(`报告页重新引入底部虚化或章节目录：${JSON.stringify(removedReportChromeContract)}`)
        }

        await page.evaluate(() => window.scrollTo({ top: 640, behavior: 'instant' }))
        await page.waitForFunction(() => window.scrollY > 48
            && document.querySelector('.pr-header')?.classList.contains('is-scrolled'))
        const stickyHeaderContract = await page.locator('.pr-header').evaluate((header) => {
            const style = getComputedStyle(header)
            const rect = header.getBoundingClientRect()
            return {
                position: style.position,
                top: style.top,
                rectTop: rect.top,
                height: rect.height,
            }
        })
        if (stickyHeaderContract.position !== 'sticky'
            || Number.parseFloat(stickyHeaderContract.top) !== 0
            || Math.abs(stickyHeaderContract.rectTop) > 1
            || stickyHeaderContract.height < 44) {
            fail(`删除章节导航后页头未保持吸顶：${JSON.stringify(stickyHeaderContract)}`)
        }
        chapterNavigationRemovedChecked = true
    } finally {
        releaseAlerts()
        if (!page.isClosed()) {
            await page.evaluate(() => localStorage.removeItem('poetic-realm.anchormap-expanded')).catch(() => undefined)
        }
        await page.close()
    }
}

/**
 * 驾驶舱是教师端的高频入口。此检查使用真实认证会话与生产页面，专门验证
 * 顶层四项功能切换在方向键和 Home/End 下同步更新选中状态、动态面板及焦点。
 * 它不对任何教学数据写入或下结论。
 */
async function checkDashboardTabKeyboard(context) {
    activeRoute = 'dashboard-tab-keyboard'
    const page = await context.newPage()
    const runtimeErrors = []
    page.on('pageerror', (error) => runtimeErrors.push(error.message))
    try {
        // 新页沿用同一浏览器上下文；清除先前页面留下的 DEMO 缓存，才能让诊断
        // 学生列表走隔离生产服务的真实临时数据，而不是被 DEMO 短路为空列表。
        await page.addInitScript(() => window.localStorage.removeItem('pr-demo-mode'))
        await page.setViewportSize({ width: 1440, height: 900 })
        // 受控告警只验证前端的单操作入口、命名与导航，不代表真实学生风险或教学成效。
        await page.route('**/api/dashboard/alerts?**', (route) => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                status: 'ok',
                alerts: [{
                    id: 'E2E-DASHBOARD-ALERT-ACTION',
                    level: 'error',
                    title: 'E2E 告警交互检查',
                    detail: '仅验证告警卡片的语义、焦点和导航，不表示真实学生风险。',
                    timestamp: '2026-08-08T00:00:00.000Z',
                    actionUrl: '/dashboard?tab=diagnosis',
                    actionLabel: '进入诊断',
                }],
            }),
        }))
        await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded' })
        await waitForSettledPage(page)
        await verifyRovingTablist(page, {
            tablistName: '教学驾驶舱功能切换',
            dataAttribute: 'data-dashboard-tab',
            expectedValues: ['dashboard', 'diagnosis', 'suggestion', 'alerts'],
            boundary: '教学驾驶舱顶层功能切换',
        })
        const action = page.getByRole('button', { name: '进入诊断：E2E 告警交互检查', exact: true })
        await action.waitFor({ state: 'visible', timeout: 10_000 })
        const alertContract = await action.locator('xpath=ancestor::article[@role="listitem"]').evaluate((item) => {
            const focusable = Array.from(item.querySelectorAll(
                'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ))
            const actionButton = item.querySelector('.pr-alert-item-action-btn')
            const badge = item.querySelector('.pr-alert-item-severity')
            const detail = item.querySelector('.pr-alert-item-desc')
            return {
                articleTabIndex: item.getAttribute('tabindex'),
                focusableCount: focusable.length,
                focusableTags: focusable.map((element) => element.tagName),
                actionButtonName: actionButton?.getAttribute('aria-label') ?? null,
                hasStyledBadge: Boolean(badge),
                hasStyledDetail: Boolean(detail),
            }
        })
        if (alertContract.articleTabIndex !== null
            || alertContract.focusableCount !== 1
            || alertContract.focusableTags[0] !== 'BUTTON'
            || alertContract.actionButtonName !== '进入诊断：E2E 告警交互检查'
            || !alertContract.hasStyledBadge
            || !alertContract.hasStyledDetail) {
            fail(`告警卡片未保持单一、命名明确的键盘操作入口：${JSON.stringify(alertContract)}`)
        }
        await action.focus()
        await action.press('Enter')
        await page.waitForURL('**/dashboard?tab=diagnosis', { timeout: 5_000 })
        dashboardAlertActionSemanticsChecked = true
        try {
            await verifyRovingTablist(page, {
                tablistName: '诊断中心功能切换',
                dataAttribute: 'data-diagnosis-tab',
                expectedValues: ['class', 'student', 'learning-path'],
                boundary: '教学驾驶舱内嵌诊断功能切换',
            })
        } catch (error) {
            throw new Error(`教学驾驶舱诊断键盘回归失败；浏览器运行时错误：${JSON.stringify(runtimeErrors)}`, { cause: error })
        }

        const radar = page.locator('.pr-diagnosis-hero-radar .pr-radar-container')
        await radar.waitFor({ state: 'visible', timeout: 10_000 })
        const radarContract = await radar.evaluate((root) => {
            const host = root.closest('.pr-diagnosis-hero-radar')
            const field = root.querySelector('.pr-radar-field')
            const sweep = root.querySelector('.pr-radar-sweep')
            const rootRect = root.getBoundingClientRect()
            const hostRect = host?.getBoundingClientRect()
            const containsRoot = Boolean(hostRect)
                && rootRect.left >= hostRect.left - 1
                && rootRect.top >= hostRect.top - 1
                && rootRect.right <= hostRect.right + 1
                && rootRect.bottom <= hostRect.bottom + 1
            const resourceNames = performance.getEntriesByType('resource').map((entry) => entry.name.toLowerCase())
            return {
                rootCount: document.querySelectorAll('.pr-diagnosis-hero-radar .pr-radar-container').length,
                renderer: root.getAttribute('data-radar-renderer'),
                rootAriaHidden: root.getAttribute('aria-hidden'),
                hostAriaHidden: host?.getAttribute('aria-hidden') ?? null,
                layerCount: root.querySelectorAll(':scope > span').length,
                sweepCount: root.querySelectorAll(':scope > .pr-radar-sweep').length,
                canvasCount: root.querySelectorAll('canvas').length,
                svgCount: root.querySelectorAll('svg').length,
                runtimeStyleCount: document.querySelectorAll('#pr-radar-styles').length,
                pointerEvents: window.getComputedStyle(root).pointerEvents,
                fieldBackgroundImage: field ? window.getComputedStyle(field).backgroundImage : 'none',
                sweepAnimationName: sweep ? window.getComputedStyle(sweep).animationName : null,
                containsRoot,
                width: rootRect.width,
                height: rootRect.height,
                oglResourceCount: resourceNames.filter((name) => name.includes('ogl-vendor')).length,
            }
        })
        if (radarContract.rootCount !== 1
            || radarContract.renderer !== 'css'
            || radarContract.rootAriaHidden !== 'true'
            || radarContract.hostAriaHidden !== 'true'
            || radarContract.layerCount !== 4
            || radarContract.sweepCount !== 1
            || radarContract.canvasCount !== 0
            || radarContract.svgCount !== 0
            || radarContract.runtimeStyleCount !== 0
            || radarContract.pointerEvents !== 'none'
            || radarContract.fieldBackgroundImage === 'none'
            || radarContract.sweepAnimationName !== 'none'
            || !radarContract.containsRoot
            || radarContract.width < 180
            || radarContract.height < 180
            || radarContract.oglResourceCount !== 0) {
            fail(`诊断雷达未满足 CSS 装饰、减弱动态与无 WebGL 契约：${JSON.stringify(radarContract)}`)
        }
        await radar.screenshot({
            path: path.join(OUTPUT_DIR, 'desktop-dashboard-diagnosis-radar.png'),
        })

        await page.setViewportSize({ width: 390, height: 844 })
        await radar.scrollIntoViewIfNeeded()
        const mobileRadarContract = await radar.evaluate((root) => {
            const host = root.closest('.pr-diagnosis-hero-radar')
            const rootRect = root.getBoundingClientRect()
            const hostRect = host?.getBoundingClientRect()
            return {
                width: rootRect.width,
                height: rootRect.height,
                withinHost: Boolean(hostRect)
                    && rootRect.left >= hostRect.left - 1
                    && rootRect.top >= hostRect.top - 1
                    && rootRect.right <= hostRect.right + 1
                    && rootRect.bottom <= hostRect.bottom + 1,
                withinViewport: rootRect.left >= -1 && rootRect.right <= window.innerWidth + 1,
                pageHasHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
                sweepAnimationName: window.getComputedStyle(root.querySelector('.pr-radar-sweep')).animationName,
            }
        })
        if (mobileRadarContract.width < 150
            || mobileRadarContract.height < 150
            || !mobileRadarContract.withinHost
            || !mobileRadarContract.withinViewport
            || mobileRadarContract.pageHasHorizontalOverflow
            || mobileRadarContract.sweepAnimationName !== 'none') {
            fail(`诊断雷达移动端几何或静态降级不合格：${JSON.stringify(mobileRadarContract)}`)
        }
        await radar.screenshot({
            path: path.join(OUTPUT_DIR, 'mobile-dashboard-diagnosis-radar.png'),
        })
        await page.setViewportSize({ width: 1440, height: 900 })
        radarDecorationContractChecked = true

        await page.locator('[data-diagnosis-tab="student"]').click()
        const studentList = page.getByRole('group', { name: '学生列表', exact: true })
        await studentList.waitFor({ state: 'visible', timeout: 10_000 })
        const studentItems = studentList.locator('[data-student-list-item]')
        await page.waitForFunction(
            () => document.querySelectorAll('[data-student-list-item]').length >= 2,
            undefined,
            { timeout: 10_000 },
        )
        const studentContract = await studentList.evaluate((list) => {
            const items = Array.from(list.querySelectorAll('[data-student-list-item]'))
            const tabStops = items.filter((item) => item.getAttribute('tabindex') === '0')
            const selected = items.filter((item) => item.getAttribute('aria-pressed') === 'true')
            return {
                itemCount: items.length,
                listTabIndex: list.getAttribute('tabindex'),
                tabStopCount: tabStops.length,
                selectedCount: selected.length,
                tabStopId: tabStops[0]?.dataset.studentListItem ?? null,
                selectedId: selected[0]?.dataset.studentListItem ?? null,
                itemRoles: items.map((item) => item.getAttribute('role')),
            }
        })
        if (studentContract.listTabIndex !== null
            || studentContract.itemCount < 2
            || studentContract.tabStopCount !== 1
            || studentContract.selectedCount !== 1
            || studentContract.tabStopId !== studentContract.selectedId
            || studentContract.itemRoles.some((role) => role !== null)) {
            fail(`诊断学生选择器未保持单一 roving 焦点与按钮语义：${JSON.stringify(studentContract)}`)
        }
        const studentIds = await studentItems.evaluateAll((items) => items.map((item) => item.getAttribute('data-student-list-item') ?? ''))
        const assertStudentFocus = async (studentId, key) => {
            try {
                await page.waitForFunction((expectedId) => {
                    const target = Array.from(document.querySelectorAll('[data-student-list-item]'))
                        .find((item) => item.dataset.studentListItem === expectedId)
                    return target?.getAttribute('aria-pressed') === 'true'
                        && target.getAttribute('tabindex') === '0'
                        && document.activeElement === target
                }, studentId, { timeout: 5_000 })
            } catch (error) {
                const actual = await studentList.evaluate((list) => {
                    const items = Array.from(list.querySelectorAll('[data-student-list-item]'))
                    const active = document.activeElement
                    return {
                        activeStudentId: active?.dataset.studentListItem ?? null,
                        activeTag: active?.tagName ?? null,
                        selectedIds: items
                            .filter((item) => item.getAttribute('aria-pressed') === 'true')
                            .map((item) => item.dataset.studentListItem ?? null),
                        tabStopIds: items
                            .filter((item) => item.getAttribute('tabindex') === '0')
                            .map((item) => item.dataset.studentListItem ?? null),
                    }
                })
                throw new Error(
                    `诊断学生选择器按下 ${key} 后未同时更新选中态、roving Tab 停靠点与 DOM 焦点：${JSON.stringify(actual)}`,
                    { cause: error },
                )
            }
            if (await page.locator('[data-student-list-item][tabindex="0"]').count() !== 1) {
                fail(`诊断学生选择器按下 ${key} 后出现多个 Tab 停靠点`)
            }
        }
        const firstStudentId = studentIds[0]
        const secondStudentId = studentIds[1]
        const lastStudentId = studentIds.at(-1)
        if (!firstStudentId || !secondStudentId || !lastStudentId) {
            fail('诊断学生选择器缺少用于键盘回归的至少两名学生')
        } else {
            await studentItems.nth(0).focus()
            // 起点可能由 URL 或此前页面状态选定；先以 Home 固定到首项，再验证方向/端点键。
            await page.keyboard.press('Home')
            await assertStudentFocus(firstStudentId, 'Home')
            await page.keyboard.press('ArrowDown')
            await assertStudentFocus(secondStudentId, 'ArrowDown')
            await page.keyboard.press('End')
            await assertStudentFocus(lastStudentId, 'End')
            await page.keyboard.press('Home')
            await assertStudentFocus(firstStudentId, 'Home')
        }
        diagnosisStudentListKeyboardChecked = true
        await page.locator('[data-dashboard-tab="dashboard"]').click()
        await page.screenshot({
            path: path.join(OUTPUT_DIR, 'desktop-dashboard-tab-keyboard.png'),
            fullPage: false,
        })
        dashboardTabKeyboardChecked = true
    } finally {
        await page.close()
    }
}

/**
 * AI 副驾的移动端首屏应先给出真实的教学输入入口，而不是先要求教师处理
 * 模型、温度等次级配置。这里必须用独立新页面：主路由回归会完成任务编排，
 * 其 Zustand 内存状态不代表新教师第一次进入页面时的状态。
 */
async function checkAICopilotMobileInitialAction(context) {
    activeRoute = 'ai-copilot-mobile-initial-action'
    const page = await context.newPage()
    try {
        // 与已恢复的教师会话分开验证“第一次进入”状态；只清除副驾自己的
        // 可恢复草稿，不触碰认证状态或任何服务端会话记录。
        await page.addInitScript(() => window.localStorage.removeItem('pr-copilot-state'))
        await page.setViewportSize({ width: 390, height: 844 })
        await page.goto(`${BASE_URL}/ai-copilot`, { waitUntil: 'domcontentloaded' })
        await waitForSettledPage(page)
        await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }))
        await page.waitForTimeout(100)

        const chatColumn = page.locator('.pr-copilot-col--center')
        const input = page.getByRole('textbox', { name: '消息输入框' })
        const controls = page.locator('.pr-copilot-intervene.pr-copilot-intervene-v6')
        const quickAction = page.getByRole('button', { name: '快捷指令：教学设计' })
        await Promise.all([
            chatColumn.waitFor({ state: 'visible', timeout: 10_000 }),
            input.waitFor({ state: 'visible', timeout: 10_000 }),
            controls.waitFor({ state: 'visible', timeout: 10_000 }),
            quickAction.waitFor({ state: 'visible', timeout: 10_000 }),
        ])

        const placement = await page.evaluate(() => {
            const chat = document.querySelector('.pr-copilot-col--center')
            const controls = document.querySelector('.pr-copilot-intervene.pr-copilot-intervene-v6')
            const input = document.querySelector('textarea[aria-label="消息输入框"]')
            if (!(chat instanceof HTMLElement)
                || !(controls instanceof HTMLElement)
                || !(input instanceof HTMLTextAreaElement)) return null
            return {
                chatTop: chat.getBoundingClientRect().top,
                controlsTop: controls.getBoundingClientRect().top,
                inputTop: input.getBoundingClientRect().top,
                viewportHeight: window.innerHeight,
                inputDisabled: input.disabled,
            }
        })
        if (!placement) {
            fail('AI 副驾移动端无法读取首屏主任务与配置栏的位置')
            return
        }
        if (placement.chatTop >= placement.controlsTop) {
            fail(
                `AI 副驾移动端将次级配置栏置于主任务之前（对话 top=${Math.round(placement.chatTop)}，配置 top=${Math.round(placement.controlsTop)}）`,
            )
        }
        if (placement.inputTop >= placement.viewportHeight) {
            fail(
                `AI 副驾移动端输入入口未进入初始视口（top=${Math.round(placement.inputTop)}，height=${placement.viewportHeight}）`,
            )
        }
        if (placement.inputDisabled) {
            fail('AI 副驾移动端初始输入框不应被禁用')
        }
        await page.screenshot({
            path: path.join(OUTPUT_DIR, 'mobile-ai-copilot-initial.png'),
            fullPage: false,
        })
        aiCopilotMobileInitialActionChecked = true
    } finally {
        await page.close()
    }
}

/**
 * 任务发布不是只在桌面大屏可用的演示功能。小屏教师点击主入口后，应立即看到
 * “目标诗篇”这一不可替代的第一项业务选择，表单也不能撑破视口。这里不提交
 * 第二次任务，避免污染已由桌面链路验证过的隔离数据；只验证移动端发布起始态。
 */
async function checkCreationTaskMobileComposer(context) {
    activeRoute = 'creation-task-mobile-composer'
    const page = await context.newPage()
    try {
        await page.setViewportSize({ width: 390, height: 844 })
        await page.goto(`${BASE_URL}/creation-studio`, { waitUntil: 'domcontentloaded' })
        await waitForSettledPage(page)
        await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }))

        const openTaskComposer = page.getByRole('button', { name: '布置创造任务', exact: true })
        await openTaskComposer.waitFor({ state: 'visible', timeout: 10_000 })
        await openTaskComposer.click()
        const composer = page.locator('#pr-creation-task-composer')
        const poemSelect = composer.getByRole('combobox', { name: '目标诗篇' })
        const requirements = composer.getByRole('textbox', { name: '任务要求' })
        await Promise.all([
            composer.waitFor({ state: 'visible', timeout: 10_000 }),
            poemSelect.waitFor({ state: 'visible', timeout: 10_000 }),
            requirements.waitFor({ state: 'visible', timeout: 10_000 }),
        ])
        await page.waitForFunction(() => {
            const select = document.querySelector('#pr-creation-task-poem')
            return select instanceof HTMLSelectElement && select.options.length > 0 && !select.disabled
        }, undefined, { timeout: 10_000 })

        const placement = await page.evaluate(() => {
            const composer = document.querySelector('#pr-creation-task-composer')
            const poem = document.querySelector('#pr-creation-task-poem')
            const requirements = document.querySelector('#pr-creation-task-requirements')
            const submit = [...document.querySelectorAll('button')]
                .find((button) => button.textContent?.trim() === '确认发布任务')
            if (!(composer instanceof HTMLElement)
                || !(poem instanceof HTMLSelectElement)
                || !(requirements instanceof HTMLTextAreaElement)
                || !(submit instanceof HTMLButtonElement)) return null
            const composerRect = composer.getBoundingClientRect()
            const poemRect = poem.getBoundingClientRect()
            const requirementsRect = requirements.getBoundingClientRect()
            const submitRect = submit.getBoundingClientRect()
            return {
                composerTop: composerRect.top,
                poemTop: poemRect.top,
                poemLeft: poemRect.left,
                poemRight: poemRect.right,
                requirementsLeft: requirementsRect.left,
                requirementsRight: requirementsRect.right,
                submitWidth: submitRect.width,
                submitHeight: submitRect.height,
                viewportWidth: window.innerWidth,
                viewportHeight: window.innerHeight,
                poemDisabled: poem.disabled,
            }
        })
        if (!placement) {
            fail('移动端创造任务发布面板缺少表单关键控件')
            return
        }
        if (placement.composerTop >= placement.viewportHeight || placement.poemTop >= placement.viewportHeight) {
            fail(
                `移动端发布任务后未将任务入口置于首屏（面板 top=${Math.round(placement.composerTop)}，诗篇 top=${Math.round(placement.poemTop)}，height=${placement.viewportHeight}）`,
            )
        }
        if (placement.poemLeft < -2 || placement.poemRight > placement.viewportWidth + 2
            || placement.requirementsLeft < -2 || placement.requirementsRight > placement.viewportWidth + 2) {
            fail(
                `移动端发布表单发生横向裁切（诗篇 ${Math.round(placement.poemLeft)}-${Math.round(placement.poemRight)}，要求 ${Math.round(placement.requirementsLeft)}-${Math.round(placement.requirementsRight)}，width=${placement.viewportWidth}）`,
            )
        }
        if (placement.poemDisabled) {
            fail('移动端诗篇加载完成后目标诗篇选择仍不可用')
        }
        if (placement.submitWidth < 24 || placement.submitHeight < 24) {
            fail(`移动端确认发布按钮点击目标过小（${Math.round(placement.submitWidth)}x${Math.round(placement.submitHeight)}）`)
        }
        await page.screenshot({
            path: path.join(OUTPUT_DIR, 'mobile-creation-task-composer-initial.png'),
            fullPage: false,
        })
        creationTaskMobileComposerChecked = true
    } finally {
        await page.close()
    }
}

/**
 * 命题的目标诗篇决定后续产出归属。诗库接口单点失败时，不能只短暂 Toast 后
 * 把内置诗篇伪装成当前诗库；必须持续披露来源、阻断命题，并允许恢复后重新加载。
 */
async function checkWorkbenchPoemFallbackTruth(context) {
    activeRoute = 'workbench-poem-fallback-truth'
    const page = await context.newPage()
    try {
        await page.addInitScript(() => window.localStorage.removeItem('pr-demo-mode'))
        await page.route('**/api/workbench/poems', (route) => route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'SERVICE_UNAVAILABLE', message: 'intentional poem source outage' }),
        }))
        await page.setViewportSize({ width: 1440, height: 900 })
        await page.goto(`${BASE_URL}/workbench`, { waitUntil: 'domcontentloaded' })
        await waitForSettledPage(page)
        const sourceDisclosure = page.getByText('当前诗篇来自内置演示数据', { exact: true })
        const retry = page.getByRole('button', { name: '重试真实诗库', exact: true })
        const blockedStart = page.getByRole('button', { name: '等待真实诗库恢复', exact: true })
        await Promise.all([
            sourceDisclosure.waitFor({ state: 'visible', timeout: 10_000 }),
            retry.waitFor({ state: 'visible', timeout: 10_000 }),
            blockedStart.waitFor({ state: 'visible', timeout: 10_000 }),
        ])
        if (await blockedStart.isEnabled()) {
            fail('诗库局部降级时仍允许使用内置演示诗篇启动真实命题')
        }
        if (!await retry.isEnabled()) {
            fail('诗库局部降级时没有可用的真实诗库重试入口')
        }
        await page.screenshot({
            path: path.join(OUTPUT_DIR, 'desktop-workbench-poem-fallback.png'),
            fullPage: false,
        })

        await page.unroute('**/api/workbench/poems')
        await retry.click()
        await page.waitForFunction(() => !document.querySelector('.pr-wb-poem-source--fallback'), undefined, { timeout: 10_000 })
        const restoredStart = page.getByRole('button', { name: '启动六阶命题', exact: true })
        await restoredStart.waitFor({ state: 'visible', timeout: 10_000 })
        workbenchPoemFallbackTruthChecked = true
    } finally {
        await page.close()
    }
}

/**
 * 命题精修是教师审题时的高频、可逆操作，不能只留下视觉上的两个模式按钮。
 * 本检查经过真实题卡入口打开弹窗，验证模式 Tab 的双向面板关联与键盘漫游，
 * 再填写一项手动修订并确认差异视图/部分采纳随之真实出现。最后用 Escape
 * 关闭并重开，确认焦点归还且未保存内容不会泄漏到下一次精修会话。
 *
 * 这里仅拦截题卡查询并注入一条显式标识的受控题卡；页面、弹窗、键盘与焦点
 * 均由生产前端真实执行，且测试不调用保存或模型接口。该题卡不被作为真实学生、
 * 真实题目质量或模型效果的证据。
 */
async function checkWorkbenchRefineModalKeyboard(context) {
    activeRoute = 'workbench-refine-modal-keyboard'
    const page = await context.newPage()
    try {
        // 专项验证使用常见桌面全高视口，使虚拟题卡的完整操作栏处于可见区；
        // 1440×900 的首屏层级与横向溢出仍由主路由回归单独覆盖。
        await page.setViewportSize({ width: 1440, height: 1200 })
        let questionRouteHits = 0
        const questionRequestUrls = []
        page.on('request', (request) => {
            if (request.url().includes('/workbench/questions')) questionRequestUrls.push(request.url())
        })
        await page.route('**/workbench/questions**', (route) => {
            questionRouteHits += 1
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    status: 'ok',
                    questions: [{
                        id: 'E2E-REFINE-QUESTION',
                        poemId: 'E2E-REFINE-POEM',
                        bloomLevel: '理解',
                        type: '选择',
                        stem: 'E2E 受控题卡：请说明“明月”意象在诗中的作用。 [受控来源链接](https://example.test/e2e-source)',
                        options: ['A. 只交代时间', 'B. 烘托思乡情绪', 'C. 表示天气', 'D. 无实际含义'],
                        answer: 'B',
                        analysis: 'E2E 受控解析：仅用于验证命题精修交互，不构成教学结论。',
                        distractorsAnalysis: ['A：缩小了意象作用', 'C：误把意象等同天气', 'D：否认语境意义'],
                        difficulty: 3,
                        estimatedTimeSec: 90,
                        aiGenerated: true,
                        knowledgePoints: ['E2E 受控知识点'],
                        score: 5,
                        favorited: false,
                        createdAt: 1_700_000_000_000,
                        updatedAt: 1_700_000_000_000,
                    }],
                    total: 1,
                    page: 1,
                    pageSize: 20,
                }),
            })
        })
        await page.goto(`${BASE_URL}/workbench`, { waitUntil: 'domcontentloaded' })
        await waitForSettledPage(page)

        // 题卡工作区位于配置 Hero 之后。先通过真实容器定位，而不是对首屏外
        // 的隐藏 DOM 强行点击，保证后续断言代表教师可以实际抵达的操作路径。
        const questionWorkspace = page.locator('.pr-wb-list-card').first()
        await questionWorkspace.scrollIntoViewIfNeeded()
        const refineTriggers = page.locator('button.pr-wb-q-action[aria-label="微调此题"]')
        const triggerReady = await page
            .waitForFunction(() => document.querySelectorAll('button[aria-label="微调此题"]').length > 0, undefined, { timeout: 10_000 })
            .then(() => true)
            .catch(() => false)
        if (!triggerReady) {
            const listState = await page.evaluate(() => {
                const list = document.querySelector('.pr-wb-q-list')
                return {
                    listText: list?.textContent?.trim().slice(0, 400) ?? null,
                    listClass: list?.className ?? null,
                    cardCount: document.querySelectorAll('.pr-wb-q-card').length,
                    actionCount: document.querySelectorAll('button[aria-label="微调此题"]').length,
                }
            })
            fail(`命题精修受控题卡未渲染：${JSON.stringify({ questionRouteHits, questionRequestUrls, listState })}`)
            return
        }
        const questionCard = questionWorkspace.locator('.pr-wb-q-card').first()
        const stemContract = await questionCard.locator('.pr-wb-q-stem').evaluate((stem) => ({
            role: stem.getAttribute('role'),
            tabIndex: stem.getAttribute('tabindex'),
            markdownLinks: stem.querySelectorAll('a[href]').length,
            nestedButtons: stem.querySelectorAll('button').length,
        }))
        if (stemContract.role !== null
            || stemContract.tabIndex !== null
            || stemContract.markdownLinks !== 1
            || stemContract.nestedButtons !== 0) {
            fail(`命题题干不应把富 Markdown 嵌入伪按钮，且受控链接必须保留：${JSON.stringify(stemContract)}`)
        }
        // 虚拟列表的序号由当前分页和筛选结果决定，不能把首张可见题卡武断地
        // 假设为“第 1 题”。读取卡头真实序号，再要求详情按钮与之严格对应，
        // 才能同时发现「题号/动作错位」和「按钮不可达」两类回归。
        const cardIndexText = (await questionCard.locator('.pr-wb-q-index').innerText()).trim()
        const expectedDetailLabel = `查看${cardIndexText}完整详情`
        const detailTriggers = questionCard.locator('button.pr-wb-q-action[aria-haspopup="dialog"]')
        if (await detailTriggers.count() !== 1) {
            fail(`每张题卡必须恰有一个原生详情入口，当前序号=${cardIndexText}，数量=${await detailTriggers.count()}`)
        }
        const detailTrigger = detailTriggers.first()
        const detailLabel = await detailTrigger.getAttribute('aria-label')
        if (detailLabel !== expectedDetailLabel) {
            fail(`题卡详情入口名称必须与真实题号一致：期望 ${expectedDetailLabel}，实际 ${detailLabel ?? '缺失'}`)
        }
        await detailTrigger.waitFor({ state: 'visible', timeout: 10_000 })
        await detailTrigger.focus()
        await detailTrigger.press('Enter')
        const detailDialog = page.getByRole('dialog', { name: '题卡详情', exact: true })
        await detailDialog.waitFor({ state: 'visible', timeout: 10_000 })
        await detailDialog.getByRole('link', { name: '受控来源链接', exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
        await page.keyboard.press('Escape')
        await detailDialog.waitFor({ state: 'hidden', timeout: 10_000 })
        await page.waitForFunction(
            (expectedLabel) => document.activeElement?.getAttribute('aria-label') === expectedLabel,
            expectedDetailLabel,
            { timeout: 5_000 },
        )
        workbenchRichMarkdownDetailAccessibilityChecked = true
        const triggerGeometry = await refineTriggers.evaluateAll((buttons) => buttons.map((button) => {
            const rect = button.getBoundingClientRect()
            const ancestors = []
            let current = button.parentElement
            while (current && ancestors.length < 8) {
                const style = window.getComputedStyle(current)
                const ancestorRect = current.getBoundingClientRect()
                ancestors.push({
                    tag: current.tagName,
                    className: current.className,
                    display: style.display,
                    visibility: style.visibility,
                    opacity: style.opacity,
                    overflow: `${style.overflowX}/${style.overflowY}`,
                    rect: [Math.round(ancestorRect.x), Math.round(ancestorRect.y), Math.round(ancestorRect.width), Math.round(ancestorRect.height)],
                })
                current = current.parentElement
            }
            const style = window.getComputedStyle(button)
            return {
                rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
                display: style.display,
                visibility: style.visibility,
                opacity: style.opacity,
                clientRects: button.getClientRects().length,
                ancestors,
            }
        }))
        const visibleTriggerIndex = triggerGeometry.findIndex((trigger) => (
            trigger.clientRects > 0
            && trigger.rect[2] > 0
            && trigger.rect[3] > 0
            && trigger.display !== 'none'
            && trigger.visibility !== 'hidden'
        ))
        if (visibleTriggerIndex < 0) {
            await page.screenshot({
                path: path.join(OUTPUT_DIR, 'desktop-workbench-refine-modal-precondition.png'),
                fullPage: false,
            })
            fail(`命题精修入口存在但不可交互：${JSON.stringify({ questionRouteHits, questionRequestUrls, triggerGeometry })}`)
            return
        }
        const refineTrigger = refineTriggers.nth(visibleTriggerIndex)
        await refineTrigger.waitFor({ state: 'visible', timeout: 10_000 })
        await refineTrigger.click()

        const dialog = page.getByRole('dialog', { name: '诗笔·微调', exact: true })
        await dialog.waitFor({ state: 'visible', timeout: 10_000 })
        const dialogNaming = await dialog.evaluate((node) => {
            const labelledBy = node.getAttribute('aria-labelledby')
            const title = labelledBy ? document.getElementById(labelledBy) : null
            return {
                ariaLabel: node.getAttribute('aria-label'),
                labelledBy,
                titleId: title?.id ?? null,
                titleText: title?.textContent?.trim() ?? null,
            }
        })
        if (dialogNaming.ariaLabel !== null
            || dialogNaming.labelledBy === null
            || dialogNaming.titleId !== dialogNaming.labelledBy
            || dialogNaming.titleText !== '诗笔·微调') {
            fail(`命题精修对话框必须由可见标题命名：${JSON.stringify(dialogNaming)}`)
        }
        await verifyRovingTablist(page, {
            tablistName: '微调模式',
            dataAttribute: 'data-refine-mode-tab',
            expectedValues: ['ai', 'manual'],
            boundary: '命题精修模式',
        })

        const manualTab = dialog.locator('[data-refine-mode-tab="manual"]')
        await manualTab.click()
        const manualPanel = dialog.locator('#wb-refine-mode-panel[role="tabpanel"]')
        const stemInput = dialog.locator('#wb-refine-stem')
        await Promise.all([
            manualPanel.waitFor({ state: 'visible', timeout: 10_000 }),
            stemInput.waitFor({ state: 'visible', timeout: 10_000 }),
        ])
        const originalStem = await stemInput.inputValue()
        const controlledStem = 'E2E 未保存命题精修：仅验证手动差异与可逆退出。'
        await stemInput.fill(controlledStem)

        const partialAdopt = dialog.getByRole('button', { name: '部分采纳 (1)', exact: true })
        const comparison = dialog.getByText('前后对比', { exact: true })
        const modalFooter = dialog.locator('.pr-modal-footer')
        await Promise.all([
            partialAdopt.waitFor({ state: 'visible', timeout: 10_000 }),
            comparison.waitFor({ state: 'visible', timeout: 10_000 }),
            modalFooter.waitFor({ state: 'visible', timeout: 10_000 }),
        ])
        if (!await partialAdopt.isEnabled()) {
            fail('命题精修手动修改已产生差异，但“部分采纳”仍不可用')
        }
        const footerGeometry = await modalFooter.evaluate((footer) => {
            const rect = footer.getBoundingClientRect()
            return { top: rect.top, bottom: rect.bottom, height: rect.height, viewportHeight: window.innerHeight }
        })
        if (footerGeometry.height <= 0 || footerGeometry.top < 0 || footerGeometry.bottom > footerGeometry.viewportHeight) {
            fail(`命题精修长内容下的操作栏未稳定留在可见区：${JSON.stringify(footerGeometry)}`)
        }
        const manualContract = await manualPanel.evaluate((panel) => ({
            labelledBy: panel.getAttribute('aria-labelledby'),
            busy: panel.getAttribute('aria-busy'),
            activeTab: document.querySelector('[data-refine-mode-tab="manual"]')?.getAttribute('aria-selected'),
            focusedTab: document.activeElement?.getAttribute('data-refine-mode-tab') ?? null,
        }))
        if (manualContract.labelledBy !== 'wb-refine-mode-tab-manual'
            || manualContract.busy !== 'false'
            || manualContract.activeTab !== 'true') {
            fail(`命题精修手动模式的面板状态未与控制器同步：${JSON.stringify(manualContract)}`)
        }
        await page.screenshot({
            path: path.join(OUTPUT_DIR, 'desktop-workbench-refine-modal-keyboard.png'),
            fullPage: false,
        })

        const reducedMotion = await page.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
        await page.keyboard.press('Escape')
        if (!reducedMotion) {
            await page.waitForTimeout(80)
            const leavingFocusRemainsInDialog = await dialog.evaluate((node) => node.contains(document.activeElement))
            if (!leavingFocusRemainsInDialog) {
                fail('命题精修关闭动画仍显示模态框时，焦点不应提前泄漏到背景页面')
            }
        }
        await dialog.waitFor({ state: 'hidden', timeout: 10_000 })
        await page.waitForFunction((trigger) => document.activeElement === document.querySelector(trigger), '.pr-wb-q-action[aria-label="微调此题"]', { timeout: 5_000 })

        // 重开并再次进入手动模式：未保存的局部编辑必须被重置，避免跨题泄漏。
        await refineTrigger.click()
        await dialog.waitFor({ state: 'visible', timeout: 10_000 })
        await dialog.locator('[data-refine-mode-tab="manual"]').click()
        await stemInput.waitFor({ state: 'visible', timeout: 10_000 })
        const reopenedStem = await stemInput.inputValue()
        if (reopenedStem !== originalStem || reopenedStem === controlledStem) {
            fail(`命题精修未保存编辑在重开后未被丢弃：${JSON.stringify({ originalStem, reopenedStem })}`)
        }
        await page.keyboard.press('Escape')
        await dialog.waitFor({ state: 'hidden', timeout: 10_000 })
        if (await page.evaluate(() => document.body.style.overflow === 'hidden')) {
            fail('诗境大图关闭后没有恢复页面滚动')
        }

        // 同一条受控题卡路径在窄屏下复验：不能只因 desktop 的长表单可用就假定
        // 移动端也保留决策区。这里使用生产 Modal 与真实响应式 CSS，不写入题目。
        await page.setViewportSize({ width: 390, height: 844 })
        await refineTrigger.scrollIntoViewIfNeeded()
        await refineTrigger.click()
        await dialog.waitFor({ state: 'visible', timeout: 10_000 })
        await dialog.locator('[data-refine-mode-tab="manual"]').click()
        await stemInput.waitFor({ state: 'visible', timeout: 10_000 })
        const mobileModalGeometry = await dialog.evaluate((node) => {
            const panel = node.getBoundingClientRect()
            const body = node.querySelector('.pr-modal-body')
            const footer = node.querySelector('.pr-modal-footer')
            const bodyRect = body?.getBoundingClientRect()
            const footerRect = footer?.getBoundingClientRect()
            const footerButtons = Array.from(node.querySelectorAll('.pr-wb-refine-footer button')).map((button) => {
                const rect = button.getBoundingClientRect()
                return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, height: rect.height }
            })
            return {
                panel: { left: panel.left, right: panel.right, top: panel.top, bottom: panel.bottom, height: panel.height },
                body: body && bodyRect ? {
                    top: bodyRect.top,
                    bottom: bodyRect.bottom,
                    clientHeight: body.clientHeight,
                    scrollHeight: body.scrollHeight,
                    overflowY: window.getComputedStyle(body).overflowY,
                } : null,
                footer: footerRect ? { left: footerRect.left, right: footerRect.right, top: footerRect.top, bottom: footerRect.bottom, height: footerRect.height } : null,
                footerButtons,
                viewport: { width: window.innerWidth, height: window.innerHeight },
                pageScrollWidth: document.documentElement.scrollWidth,
            }
        })
        const mobilePanelVisible = mobileModalGeometry.panel.left >= 0
            && mobileModalGeometry.panel.right <= mobileModalGeometry.viewport.width
            && mobileModalGeometry.panel.top >= 0
            && mobileModalGeometry.panel.bottom <= mobileModalGeometry.viewport.height
        const mobileBodyContract = mobileModalGeometry.body !== null
            && mobileModalGeometry.body.clientHeight > 0
            && mobileModalGeometry.body.overflowY === 'auto'
            && mobileModalGeometry.body.scrollHeight >= mobileModalGeometry.body.clientHeight
        const mobileFooterVisible = mobileModalGeometry.footer !== null
            && mobileModalGeometry.footer.left >= 0
            && mobileModalGeometry.footer.right <= mobileModalGeometry.viewport.width
            && mobileModalGeometry.footer.top >= 0
            && mobileModalGeometry.footer.bottom <= mobileModalGeometry.viewport.height
            && mobileModalGeometry.footerButtons.length === 3
            && mobileModalGeometry.footerButtons.every((button) => (
                button.left >= 0
                && button.right <= mobileModalGeometry.viewport.width
                && button.top >= 0
                && button.bottom <= mobileModalGeometry.viewport.height
                && button.height >= 32
            ))
        if (!mobilePanelVisible
            || mobileModalGeometry.pageScrollWidth > mobileModalGeometry.viewport.width
            || !mobileBodyContract
            || !mobileFooterVisible) {
            fail(`命题精修移动端模态框出现裁切、横向溢出或决策区不可达：${JSON.stringify(mobileModalGeometry)}`)
        }
        await page.screenshot({
            path: path.join(OUTPUT_DIR, 'mobile-workbench-refine-modal-geometry.png'),
            fullPage: false,
        })
        await page.keyboard.press('Escape')
        await dialog.waitFor({ state: 'hidden', timeout: 10_000 })
        await page.waitForFunction((trigger) => document.activeElement === document.querySelector(trigger), '.pr-wb-q-action[aria-label="微调此题"]', { timeout: 5_000 })
        workbenchRefineModalMobileChecked = true
        workbenchRefineModalKeyboardChecked = true
    } finally {
        await page.close()
    }
}

/**
 * AI 副驾会把物料引用带入后续生成，因而学生名册/诗库的来源不能只靠全局横幅
 * 间接说明：任一单接口故障都必须留在当前标签页可见，且不能自动换成示例数据。
 * 恢复后还要验证插入的是接口返回的脱敏 ID，而不是本地伪造标识。
 */
async function checkCopilotMaterialTruthBoundary(context) {
    activeRoute = 'ai-copilot-material-truth-boundary'
    const page = await context.newPage()
    let studentsAvailable = false
    let poemsAvailable = false
    try {
        await page.addInitScript(() => {
            window.localStorage.removeItem('pr-demo-mode')
            window.localStorage.removeItem('pr-copilot-state')
        })
        await page.route('**/api/students**', (route) => {
            if (!studentsAvailable) {
                return route.fulfill({
                    status: 503,
                    contentType: 'application/json',
                    body: JSON.stringify({ error: 'SERVICE_UNAVAILABLE', message: 'intentional student source outage' }),
                })
            }
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    status: 'ok',
                    students: [{
                        id: 'e2e-anon-student-001',
                        name: 'S-E2E-001',
                        classId: 'e2e-class-001',
                        className: 'E2E 验证班',
                    }],
                }),
            })
        })
        await page.route('**/api/workbench/poems', (route) => {
            if (!poemsAvailable) {
                return route.fulfill({
                    status: 503,
                    contentType: 'application/json',
                    body: JSON.stringify({ error: 'SERVICE_UNAVAILABLE', message: 'intentional copilot poem source outage' }),
                })
            }
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    status: 'ok',
                    poems: [{
                        id: 'e2e-live-poem-001',
                        title: 'E2E 真源诗篇',
                        dynasty: '唐',
                        poet: '验证者',
                    }],
                }),
            })
        })
        await page.setViewportSize({ width: 1440, height: 900 })
        await page.goto(`${BASE_URL}/ai-copilot`, { waitUntil: 'domcontentloaded' })
        await waitForSettledPage(page)
        await verifyRovingTablist(page, {
            tablistName: '上下文物料分类',
            dataAttribute: 'data-copilot-material-tab',
            expectedValues: ['student', 'poem', 'class', 'knowledge'],
            boundary: 'AI 副驾上下文物料',
        })

        const studentOutage = page.getByText('真实学生名册暂不可用', { exact: true })
        const retryStudents = page.getByRole('button', { name: '重试学生名册', exact: true })
        await Promise.all([
            studentOutage.waitFor({ state: 'visible', timeout: 10_000 }),
            retryStudents.waitFor({ state: 'visible', timeout: 10_000 }),
        ])
        if (await page.getByText('演示学生 01', { exact: true }).count() > 0) {
            fail('真实学生名册单点故障时仍将演示学生呈现为可引用物料')
        }

        studentsAvailable = true
        await retryStudents.click()
        const liveStudent = page.getByRole('button', { name: /插入学生引用：S-E2E-001/ })
        await liveStudent.waitFor({ state: 'visible', timeout: 10_000 })
        await liveStudent.click()
        await page.waitForFunction(
            () => document.querySelector('textarea[aria-label="消息输入框"]')?.value
                .includes('@[学生:e2e-anon-student-001:S-E2E-001]') === true,
            undefined,
            { timeout: 10_000 },
        )

        await page.getByRole('tab', { name: '诗词', exact: true }).click()
        const poemOutage = page.getByText('真实诗库暂不可用', { exact: true })
        const retryPoems = page.getByRole('button', { name: '重试真实诗库', exact: true })
        await Promise.all([
            poemOutage.waitFor({ state: 'visible', timeout: 10_000 }),
            retryPoems.waitFor({ state: 'visible', timeout: 10_000 }),
        ])
        if (await page.getByText('E2E 真源诗篇', { exact: true }).count() > 0) {
            fail('诗库故障态残留了未确认来源的诗篇物料')
        }
        await page.screenshot({
            path: path.join(OUTPUT_DIR, 'desktop-ai-copilot-material-truth-boundary.png'),
            fullPage: false,
        })

        poemsAvailable = true
        await retryPoems.click()
        const livePoem = page.getByRole('button', { name: /插入诗词引用：E2E 真源诗篇/ })
        await livePoem.waitFor({ state: 'visible', timeout: 10_000 })
        await livePoem.click()
        await page.waitForFunction(
            () => document.querySelector('textarea[aria-label="消息输入框"]')?.value
                .includes('@[诗词:e2e-live-poem-001:E2E 真源诗篇]') === true,
            undefined,
            { timeout: 10_000 },
        )
        copilotMaterialTruthBoundaryChecked = true
    } finally {
        await page.close()
    }
}

/**
 * AI 副驾、报告与命题复用同一 Markdown 图片渲染器。这里以受控 SSE 回复写入一张
 * 会在资源层中止的 HTTP(S) 图片，确认失败不会伪装为永久加载态，且重试确实产生
 * 新请求。样本仅验证前端失败恢复，不构成 AI 回复、图片模型或外部服务可用性证据。
 */
async function checkCopilotMarkdownImageRecovery(context) {
    activeRoute = 'ai-copilot-markdown-image-recovery'
    const page = await context.newPage()
    let aiChatRequests = 0
    let failedImageRequests = 0
    const brokenImageUrl = `${BASE_URL}/e2e-fixtures/markdown-failed-image.png`
    try {
        await page.addInitScript(() => {
            window.localStorage.removeItem('pr-demo-mode')
            window.localStorage.removeItem('pr-copilot-state')
        })
        await page.route('**/api/ai/chat', (route) => {
            aiChatRequests += 1
            const content = [
                'E2E 富文本图片资源恢复',
                '',
                `![E2E 受控失败图片](${brokenImageUrl})`,
                '',
                '仅验证前端错误状态与重试请求，不代表 AI 输出或图片服务结果。',
            ].join('\n')
            return route.fulfill({
                status: 200,
                contentType: 'text/event-stream; charset=utf-8',
                body: `data: ${JSON.stringify({ content, done: true })}\n\n`,
            })
        })
        await page.route('**/e2e-fixtures/markdown-failed-image.png**', (route) => {
            failedImageRequests += 1
            // 直接中止而不是返回可解码的错误页，确保触发真实 img.onerror 路径。
            return route.abort('failed')
        })
        await page.setViewportSize({ width: 1440, height: 900 })
        await page.goto(`${BASE_URL}/ai-copilot`, { waitUntil: 'domcontentloaded' })
        await waitForSettledPage(page)

        const input = page.getByRole('textbox', { name: '消息输入框', exact: true })
        const send = page.getByRole('button', { name: '发送消息', exact: true })
        await input.fill('请返回 E2E 富文本图片样本。')
        await send.click()

        const fallback = page.locator('.pr-md-image-fallback')
        const failureStatus = fallback.getByRole('status')
        const retry = fallback.getByRole('button', { name: '重新加载图片：E2E 受控失败图片', exact: true })
        await Promise.all([
            fallback.waitFor({ state: 'visible', timeout: 10_000 }),
            failureStatus.waitFor({ state: 'visible', timeout: 10_000 }),
            retry.waitFor({ state: 'visible', timeout: 10_000 }),
        ])
        const initialContract = await fallback.evaluate((node) => ({
            tag: node.tagName,
            figureRole: node.getAttribute('role'),
            statusRole: node.querySelector('[role="status"]')?.getAttribute('role') ?? null,
            statusLive: node.querySelector('[role="status"]')?.getAttribute('aria-live') ?? null,
            text: node.textContent?.replace(/\s+/g, ' ').trim() ?? '',
            visibleImageCount: node.parentElement?.querySelectorAll('img').length ?? -1,
        }))
        if (aiChatRequests !== 1
            || failedImageRequests < 1
            || initialContract.tag !== 'FIGURE'
            || initialContract.figureRole !== null
            || initialContract.statusRole !== 'status'
            || initialContract.statusLive !== 'polite'
            || initialContract.visibleImageCount !== 0
            || !initialContract.text.includes('图片加载失败')
            || !initialContract.text.includes('E2E 受控失败图片')) {
            fail(`AI 副驾富文本图片失败时未显示明确且无误导的可恢复状态：${JSON.stringify({ aiChatRequests, failedImageRequests, initialContract })}`)
        }

        const retryRequest = page.waitForRequest((request) => request.url().includes('markdown-failed-image.png')
            && request.url().includes('_prMarkdownImageRetry=1'), { timeout: 10_000 })
        await Promise.all([
            retryRequest,
            retry.click(),
        ])
        await fallback.waitFor({ state: 'visible', timeout: 10_000 })
        if (failedImageRequests < 2) {
            fail(`AI 副驾富文本图片失败后的“重新加载”没有发起新 HTTP(S) 请求：${JSON.stringify({ failedImageRequests })}`)
        }
        await fallback.scrollIntoViewIfNeeded()
        await page.screenshot({
            path: path.join(OUTPUT_DIR, 'desktop-ai-copilot-markdown-image-load-failure.png'),
            fullPage: false,
        })
        copilotMarkdownImageRecoveryChecked = true
    } finally {
        await page.close()
    }
}

/**
 * 本地图片附件先在浏览器压缩为 data URL，再作为多模态内容发送，无法像 HTTP 图片
 * 那样通过路由中止来触发解码失败。这里先走真实的文件选择/压缩/缩略图路径，再对
 * 已挂载的浏览器图片元素派发受控 error，以验证 React 的真实 onError 处理、附件
 * 状态失败关闭与后续请求载荷三者一致。夹具不评价图片或模型输出质量。
 */
async function checkCopilotAttachmentPreviewRecovery(context) {
    activeRoute = 'ai-copilot-attachment-preview-recovery'
    const page = await context.newPage()
    let chatRequests = 0
    let outboundPayload = ''
    try {
        await page.addInitScript(() => window.localStorage.removeItem('pr-copilot-state'))
        await page.route('**/api/ai/chat', (route) => {
            chatRequests += 1
            outboundPayload = route.request().postData() ?? ''
            return route.fulfill({
                status: 200,
                contentType: 'text/event-stream; charset=utf-8',
                body: `data: ${JSON.stringify({ content: 'E2E 仅文字附件失败恢复响应。', done: true })}\n\n`,
            })
        })
        await page.setViewportSize({ width: 1440, height: 900 })
        await page.goto(`${BASE_URL}/ai-copilot`, { waitUntil: 'domcontentloaded' })
        await waitForSettledPage(page)

        const uploadInput = page.getByRole('button', { name: '添加附件', exact: true })
        const fileInput = page.locator('input[type="file"][aria-label="选择附件文件"]')
        await Promise.all([
            uploadInput.waitFor({ state: 'visible', timeout: 10_000 }),
            fileInput.waitFor({ state: 'attached', timeout: 10_000 }),
        ])
        // 采用项目内真实 PNG，而不是极小的手写 Base64。该文件已被生产页面使用，
        // 可稳定经过 createImageBitmap/canvas 压缩链路；文件名仍保持为独立的 E2E
        // 标识，以免和业务素材或持久化状态混淆。
        const imageFixture = await fs.readFile(path.resolve('public', 'images', 'generated', 'workbench-bloom-hero-v1.png'))
        await fileInput.setInputFiles({
            name: 'e2e-copilot-preview.png',
            mimeType: 'image/png',
            buffer: imageFixture,
        })

        const attachment = page.locator('.pr-copilot-attach').filter({ hasText: 'e2e-copilot-preview.png' })
        const thumbnail = attachment.locator('img.pr-copilot-attach-thumb')
        await thumbnail.waitFor({ state: 'visible', timeout: 10_000 })
        // 派发到真实 img 节点，触发组件已注册的 React onError，而非直接改写状态。
        await thumbnail.evaluate((node) => node.dispatchEvent(new Event('error')))

        const previewFailure = attachment.getByRole('status', { name: '图片预览不可用：e2e-copilot-preview.png', exact: true })
        const failureCopy = attachment.getByText('图片预览不可用，附件不会发送给模型。请移除后重新选择文件。', { exact: true })
        await Promise.all([
            previewFailure.waitFor({ state: 'visible', timeout: 10_000 }),
            failureCopy.waitFor({ state: 'visible', timeout: 10_000 }),
            thumbnail.waitFor({ state: 'hidden', timeout: 10_000 }),
        ])
        const failureContract = await attachment.evaluate((node) => ({
            imageCount: node.querySelectorAll('img.pr-copilot-attach-thumb').length,
            statusRole: node.querySelector('[role="status"]')?.getAttribute('role') ?? null,
            statusLive: node.querySelector('[role="status"]')?.getAttribute('aria-live') ?? null,
            statusName: node.querySelector('[role="status"]')?.getAttribute('aria-label') ?? null,
            text: node.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        }))
        const input = page.getByRole('textbox', { name: '消息输入框', exact: true })
        const send = page.getByRole('button', { name: '发送消息', exact: true })
        if (failureContract.imageCount !== 0
            || failureContract.statusRole !== 'status'
            || failureContract.statusLive !== 'polite'
            || failureContract.statusName !== '图片预览不可用：e2e-copilot-preview.png'
            || !failureContract.text.includes('附件不会发送给模型')
            || !await send.isDisabled()) {
            fail(`AI 副驾附件预览失败没有转为失败关闭状态：${JSON.stringify(failureContract)}`)
        }
        await attachment.scrollIntoViewIfNeeded()
        await page.screenshot({
            path: path.join(OUTPUT_DIR, 'desktop-ai-copilot-attachment-preview-failure.png'),
            fullPage: false,
        })

        // 失败文案比常规文件元数据更长，单独以手机宽度检查它不能撑破输入区，
        // 同时保证唯一的恢复动作（移除后重选）仍保有最低触控尺寸。
        await page.setViewportSize({ width: 390, height: 844 })
        await attachment.waitFor({ state: 'visible', timeout: 10_000 })
        await attachment.scrollIntoViewIfNeeded()
        const mobileFailureGeometry = await attachment.evaluate((node) => {
            const remove = node.querySelector('.pr-copilot-attach-remove')
            const removeRect = remove?.getBoundingClientRect()
            return {
                viewportWidth: document.documentElement.clientWidth,
                pageWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
                attachmentRight: Math.round(node.getBoundingClientRect().right),
                removeWidth: Math.round(removeRect?.width ?? 0),
                removeHeight: Math.round(removeRect?.height ?? 0),
            }
        })
        if (mobileFailureGeometry.pageWidth > mobileFailureGeometry.viewportWidth + 2
            || mobileFailureGeometry.attachmentRight > mobileFailureGeometry.viewportWidth + 2
            || mobileFailureGeometry.removeWidth < 24
            || mobileFailureGeometry.removeHeight < 24) {
            fail(`AI 副驾失败附件在移动端溢出或不可可靠移除：${JSON.stringify(mobileFailureGeometry)}`)
        }
        await page.screenshot({
            path: path.join(OUTPUT_DIR, 'mobile-ai-copilot-attachment-preview-failure.png'),
            fullPage: false,
        })

        await input.fill('E2E 仅发送文字。')
        if (await send.isDisabled()) {
            fail('图片附件预览失败后，纯文字消息不应被无条件阻断')
        }
        await Promise.all([
            page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/ai/chat', { timeout: 10_000 }),
            send.click(),
        ])
        if (chatRequests !== 1 || /"image_url"|data:image\//.test(outboundPayload)) {
            fail(`AI 副驾仍将无法预览的图片附件发送给模型：${JSON.stringify({ chatRequests, hasImagePayload: /"image_url"|data:image\//.test(outboundPayload) })}`)
        }
        copilotAttachmentPreviewRecoveryChecked = true
    } finally {
        await page.close()
    }
}

/**
 * 跟读录音不是纯视觉控件：getUserMedia 的授权兑现、MediaRecorder 的最终 chunk、
 * tab 卸载和禁用态可能彼此交错。该夹具替换浏览器媒体设备为可观测的最小实现，
 * 仍通过真实的诗篇模块、按钮、VoiceInput 和 ASR 请求路径验证“正常交付一次”
 * 以及两种取消路径都不会把无归属录音送往模型。它不调用真实麦克风，也不评价 ASR。
 */
async function checkVoiceInputRecordingLifecycle(context) {
    activeRoute = 'thinking-palace-voice-input-lifecycle'
    const page = await context.newPage()
    let asrRequests = 0
    let lastAsrContentType = ''
    try {
        await page.addInitScript(() => {
            const stats = {
                getUserMediaCalls: 0,
                recorderStarts: 0,
                recorderStops: 0,
                trackStops: 0,
                delayMs: 0,
            }
            Object.defineProperty(window, '__e2eVoiceRecordingStats', {
                value: stats,
                configurable: true,
            })

            class ControlledMediaRecorder {
                static isTypeSupported() {
                    return true
                }

                constructor(stream, options = {}) {
                    this.stream = stream
                    this.mimeType = options.mimeType ?? 'audio/webm'
                    this.state = 'inactive'
                    this.ondataavailable = null
                    this.onstop = null
                    this.onerror = null
                }

                start() {
                    this.state = 'recording'
                    stats.recorderStarts += 1
                }

                stop() {
                    if (this.state === 'inactive') return
                    this.state = 'inactive'
                    stats.recorderStops += 1
                    window.setTimeout(() => {
                        this.ondataavailable?.({
                            data: new Blob(['controlled-recording'], { type: this.mimeType }),
                        })
                        this.onstop?.()
                    }, 0)
                }
            }

            const mediaDevices = {
                getUserMedia: () => {
                    stats.getUserMediaCalls += 1
                    return new Promise((resolve) => {
                        window.setTimeout(() => {
                            let stopped = false
                            const track = {
                                kind: 'audio',
                                stop: () => {
                                    if (stopped) return
                                    stopped = true
                                    stats.trackStops += 1
                                },
                            }
                            resolve({ getTracks: () => [track] })
                        }, stats.delayMs)
                    })
                },
            }
            Object.defineProperty(navigator, 'mediaDevices', {
                value: mediaDevices,
                configurable: true,
            })
            Object.defineProperty(window, 'MediaRecorder', {
                value: ControlledMediaRecorder,
                configurable: true,
            })
        })
        await page.addInitScript(() => window.localStorage.removeItem('pr-demo-mode'))
        await page.route('**/api/ai/asr', async (route) => {
            asrRequests += 1
            lastAsrContentType = route.request().headers()['content-type'] ?? ''
            await route.fulfill({
                status: 200,
                contentType: 'application/json; charset=utf-8',
                body: JSON.stringify({
                    status: 'ok',
                    transcript: 'E2E 受控跟读转写',
                    audioDurationSec: 1.2,
                    confidence: 0.94,
                    similarityScore: 96,
                    model: 'mimo-v2.5-asr',
                    requestedModel: 'mimo-v2.5-asr',
                    aiGenerated: true,
                    demo: false,
                    degraded: false,
                }),
            })
        })
        await page.setViewportSize({ width: 1440, height: 900 })
        await page.goto(`${BASE_URL}/thinking-palace`, { waitUntil: 'domcontentloaded' })
        await waitForSettledPage(page)

        const recitationTab = page.getByRole('tab', { name: /AI 朗诵评分/ })
        const routeTab = page.getByRole('tab', { name: /诗篇思考路线/ })
        await recitationTab.click()
        await page.getByRole('heading', { name: /朗诵范读/ }).waitFor({ state: 'visible', timeout: 10_000 })

        // 1) 正常录制：最终 dataavailable 在 stop 之后才到达，仍应恰好形成一份 ASR 请求。
        const start = page.getByRole('button', { name: '开始录音', exact: true })
        await start.click()
        const stop = page.getByRole('button', { name: '停止录音', exact: true })
        await stop.waitFor({ state: 'visible', timeout: 10_000 })
        await stop.click()
        const transcript = page.getByRole('textbox', { name: '识别结果（可编辑）', exact: true })
        await page.waitForFunction(() => {
            const input = document.querySelector('textarea[aria-label="识别结果（可编辑）"]')
            return input?.value === 'E2E 受控跟读转写'
        }, { timeout: 10_000 })
        if (asrRequests !== 1 || !lastAsrContentType.toLowerCase().includes('multipart/form-data')) {
            fail(`正常停止录音没有形成唯一的 multipart ASR 请求：${JSON.stringify({ asrRequests, lastAsrContentType })}`)
        }
        await transcript.scrollIntoViewIfNeeded()
        await page.screenshot({
            path: path.join(OUTPUT_DIR, 'desktop-thinking-palace-voice-input-lifecycle.png'),
            fullPage: false,
        })

        // 2) 用户在授权兑现前再次点击：这代表取消，不能把用户已经放弃的录音
        // 悄悄启动到后台；迟到的 stream 只允许被释放。
        const beforeExplicitCancel = await page.evaluate(() => ({ ...window.__e2eVoiceRecordingStats }))
        await page.evaluate(() => { window.__e2eVoiceRecordingStats.delayMs = 120 })
        await start.click()
        const cancelAuthorization = page.getByRole('button', { name: '取消录音授权', exact: true })
        await cancelAuthorization.waitFor({ state: 'visible', timeout: 10_000 })
        await cancelAuthorization.click()
        await page.waitForTimeout(180)
        const afterExplicitCancel = await page.evaluate(() => ({ ...window.__e2eVoiceRecordingStats }))
        if (asrRequests !== 1
            || afterExplicitCancel.recorderStarts !== beforeExplicitCancel.recorderStarts
            || afterExplicitCancel.trackStops !== beforeExplicitCancel.trackStops + 1) {
            fail(`用户取消迟到麦克风授权后仍启动录音或提交 ASR：${JSON.stringify({ beforeExplicitCancel, afterExplicitCancel, asrRequests })}`)
        }

        // 3) 授权结果迟到后切走模块：迟到的 stream 必须自行 stop，不能启动录音或发 ASR。
        const beforePendingCancel = await page.evaluate(() => ({ ...window.__e2eVoiceRecordingStats }))
        await start.click()
        await routeTab.click()
        await page.waitForTimeout(180)
        const afterPendingCancel = await page.evaluate(() => ({ ...window.__e2eVoiceRecordingStats }))
        if (asrRequests !== 1
            || afterPendingCancel.recorderStarts !== beforePendingCancel.recorderStarts
            || afterPendingCancel.trackStops !== beforePendingCancel.trackStops + 1) {
            fail(`迟到麦克风授权在模块卸载后没有失败关闭：${JSON.stringify({ beforePendingCancel, afterPendingCancel, asrRequests })}`)
        }

        // 4) 已在录制时切走模块：停止设备并取消最终 onstop 交付，不能让半段录音进入 ASR。
        await page.evaluate(() => { window.__e2eVoiceRecordingStats.delayMs = 0 })
        await recitationTab.click()
        await start.waitFor({ state: 'visible', timeout: 10_000 })
        await start.click()
        await stop.waitFor({ state: 'visible', timeout: 10_000 })
        const beforeActiveCancel = await page.evaluate(() => ({ ...window.__e2eVoiceRecordingStats }))
        await routeTab.click()
        await page.waitForTimeout(80)
        const afterActiveCancel = await page.evaluate(() => ({ ...window.__e2eVoiceRecordingStats }))
        if (asrRequests !== 1
            || afterActiveCancel.recorderStops !== beforeActiveCancel.recorderStops + 1
            || afterActiveCancel.trackStops !== beforeActiveCancel.trackStops + 1) {
            fail(`录制中的模块卸载没有停止设备或仍提交 ASR：${JSON.stringify({ beforeActiveCancel, afterActiveCancel, asrRequests })}`)
        }
        voiceInputLifecycleChecked = true
    } finally {
        await page.close()
    }
}

/**
 * QuickVoiceAssist 是课堂、备课、诊断、批改和 AI 副驾共用的语音入口，不能只因
 * 跟读模块具备媒体回收就默认它安全。本夹具在真实 AI 副驾输入区替换浏览器媒体设备
 * 与 ASR 响应，验证最终 chunk 的正常转写、授权等待中的显式撤销、页面离开后的迟到
 * 授权回收以及正在录制时的卸载取消；不使用真实麦克风，也不评价语音或模型质量。
 */
async function checkQuickVoiceCaptureLifecycle(context) {
    activeRoute = 'ai-copilot-quick-voice-lifecycle'
    const page = await context.newPage()
    let asrRequests = 0
    let lastAsrContentType = ''
    try {
        await page.addInitScript(() => {
            const stats = {
                getUserMediaCalls: 0,
                recorderStarts: 0,
                recorderStops: 0,
                trackStops: 0,
                pendingPermissionCount: 0,
                releasePendingPermissions: () => {},
            }
            const pendingPermissionResolvers = []
            stats.releasePendingPermissions = () => {
                const resolvers = pendingPermissionResolvers.splice(0)
                resolvers.forEach((resolve) => resolve())
            }
            Object.defineProperty(window, '__e2eQuickVoiceCaptureStats', {
                value: stats,
                configurable: true,
            })

            class ControlledMediaRecorder {
                static isTypeSupported() {
                    return true
                }

                constructor(stream, options = {}) {
                    this.stream = stream
                    this.mimeType = options.mimeType ?? 'audio/webm'
                    this.state = 'inactive'
                    this.ondataavailable = null
                    this.onstop = null
                    this.onerror = null
                }

                start() {
                    this.state = 'recording'
                    stats.recorderStarts += 1
                }

                stop() {
                    if (this.state === 'inactive') return
                    this.state = 'inactive'
                    stats.recorderStops += 1
                    window.setTimeout(() => {
                        this.ondataavailable?.({
                            data: new Blob(['controlled-quick-voice-recording'], { type: this.mimeType }),
                        })
                        this.onstop?.()
                    }, 0)
                }
            }

            Object.defineProperty(navigator, 'mediaDevices', {
                value: {
                    getUserMedia: () => {
                        stats.getUserMediaCalls += 1
                        return new Promise((resolve) => {
                            const resolveWithControlledStream = () => {
                                let stopped = false
                                const track = {
                                    kind: 'audio',
                                    stop: () => {
                                        if (stopped) return
                                        stopped = true
                                        stats.trackStops += 1
                                    },
                                }
                                resolve({ getTracks: () => [track] })
                            }
                            if (stats.pendingPermissionCount > 0) {
                                stats.pendingPermissionCount -= 1
                                pendingPermissionResolvers.push(resolveWithControlledStream)
                            } else {
                                window.setTimeout(resolveWithControlledStream, 0)
                            }
                        })
                    },
                },
                configurable: true,
            })
            Object.defineProperty(window, 'MediaRecorder', {
                value: ControlledMediaRecorder,
                configurable: true,
            })
        })
        await page.addInitScript(() => window.localStorage.removeItem('pr-demo-mode'))
        await page.route('**/api/ai/asr', async (route) => {
            asrRequests += 1
            lastAsrContentType = route.request().headers()['content-type'] ?? ''
            await route.fulfill({
                status: 200,
                contentType: 'application/json; charset=utf-8',
                body: JSON.stringify({
                    status: 'ok',
                    transcript: 'E2E 受控快捷语音转写',
                    audioDurationSec: 1.2,
                    confidence: 0.94,
                    similarityScore: 96,
                    model: 'mimo-v2.5-asr',
                    requestedModel: 'mimo-v2.5-asr',
                    aiGenerated: true,
                    demo: false,
                    degraded: false,
                }),
            })
        })
        await page.setViewportSize({ width: 1440, height: 900 })
        await page.goto(`${BASE_URL}/ai-copilot`, { waitUntil: 'domcontentloaded' })
        await waitForSettledPage(page)

        const quickVoiceButton = () => page.getByRole('button', { name: /语音提问|正在请求麦克风权限|说完点这里|AI 识别中/ }).first()
        const messageInput = page.getByRole('textbox', { name: '消息输入框', exact: true })
        // 这里不能用 page.goto：它会重置受控媒体替身统计。直接驱动 BrowserRouter
        // 监听的 popstate 会真实卸载 AI 副驾模块，同时保留同一份浏览器上下文中的
        // 统计；本用例验证的是组件卸载下的媒体回收，而非侧栏的嵌套滚动坐标。
        const navigateWithinShell = async (pathname) => {
            await page.evaluate((nextPathname) => {
                window.history.pushState(null, '', nextPathname)
                window.dispatchEvent(new PopStateEvent('popstate'))
            }, pathname)
            await page.waitForFunction((expectedPathname) => window.location.pathname === expectedPathname, pathname, {
                timeout: 10_000,
            })
            await waitForSettledPage(page)
        }

        // 1) 正常停止：ondataavailable 晚于 stop，仍只能提交一份 multipart ASR 请求，
        // 且结果只能回填到可编辑输入框，绝不能自动代替教师发送。
        await quickVoiceButton().click()
        await page.getByRole('button', { name: /说完点这里/ }).waitFor({ state: 'visible', timeout: 10_000 })
        await quickVoiceButton().click()
        await page.waitForFunction(() => {
            const input = document.querySelector('textarea[aria-label="消息输入框"]')
            return input?.value === 'E2E 受控快捷语音转写'
        }, { timeout: 10_000 })
        if (asrRequests !== 1 || !lastAsrContentType.toLowerCase().includes('multipart/form-data')) {
            fail(`快捷语音正常停止没有形成唯一的 multipart ASR 回填：${JSON.stringify({ asrRequests, lastAsrContentType })}`)
        }
        await messageInput.scrollIntoViewIfNeeded()
        await page.screenshot({
            path: path.join(OUTPUT_DIR, 'desktop-ai-copilot-quick-voice-lifecycle.png'),
            fullPage: false,
        })

        // 2) 权限尚未兑现时，按钮必须保持可达且第二次点击明确取消；迟到 stream 只允许
        // 停止轨道，不能创建 Recorder，更不能把用户已放弃的音频送往 ASR。
        const beforeExplicitCancel = await page.evaluate(() => ({ ...window.__e2eQuickVoiceCaptureStats }))
        await page.evaluate(() => { window.__e2eQuickVoiceCaptureStats.pendingPermissionCount = 1 })
        await quickVoiceButton().click()
        await page.waitForTimeout(20)
        const pendingAuthorizationState = await page.locator('.pr-copilot-input-assist .pr-voice-capture').evaluate((node) => ({
            ariaLabel: node.getAttribute('aria-label'),
            ariaBusy: node.getAttribute('aria-busy'),
            disabled: node.hasAttribute('disabled'),
        }))
        if (pendingAuthorizationState.ariaBusy !== 'true') {
            const stats = await page.evaluate(() => ({ ...window.__e2eQuickVoiceCaptureStats }))
            throw new Error(`快捷语音点击后未进入可取消授权态：${JSON.stringify({ pendingAuthorizationState, stats })}`)
        }
        const cancelAuthorization = page.getByRole('button', { name: /正在请求麦克风权限，再次点击取消/ })
        await cancelAuthorization.waitFor({ state: 'visible', timeout: 10_000 })
        if (await cancelAuthorization.isDisabled()) {
            fail('快捷语音等待授权时错误禁用取消按钮')
        }
        await cancelAuthorization.click()
        await page.evaluate(() => window.__e2eQuickVoiceCaptureStats.releasePendingPermissions())
        await page.waitForTimeout(40)
        const afterExplicitCancel = await page.evaluate(() => ({ ...window.__e2eQuickVoiceCaptureStats }))
        if (asrRequests !== 1
            || afterExplicitCancel.recorderStarts !== beforeExplicitCancel.recorderStarts
            || afterExplicitCancel.trackStops !== beforeExplicitCancel.trackStops + 1) {
            fail(`快捷语音取消迟到授权后仍启动录音或提交 ASR：${JSON.stringify({ beforeExplicitCancel, afterExplicitCancel, asrRequests })}`)
        }

        // 3) 等待授权时离开 AI 副驾：已失去页面归属的 stream 必须立即关闭，不能在后台录音。
        const beforeUnmountWhilePending = await page.evaluate(() => ({ ...window.__e2eQuickVoiceCaptureStats }))
        await page.evaluate(() => { window.__e2eQuickVoiceCaptureStats.pendingPermissionCount = 1 })
        await quickVoiceButton().click()
        await navigateWithinShell('/dashboard')
        await page.evaluate(() => window.__e2eQuickVoiceCaptureStats.releasePendingPermissions())
        await page.waitForTimeout(40)
        const afterUnmountWhilePending = await page.evaluate(() => ({ ...window.__e2eQuickVoiceCaptureStats }))
        if (asrRequests !== 1
            || afterUnmountWhilePending.recorderStarts !== beforeUnmountWhilePending.recorderStarts
            || afterUnmountWhilePending.trackStops !== beforeUnmountWhilePending.trackStops + 1) {
            fail(`快捷语音页面离开后迟到授权没有失败关闭：${JSON.stringify({ beforeUnmountWhilePending, afterUnmountWhilePending, asrRequests })}`)
        }

        // 4) 录音已经开始时离开：主动停止设备并取消最终 onstop 的 ASR 交付。
        await navigateWithinShell('/ai-copilot')
        await quickVoiceButton().click()
        await page.getByRole('button', { name: /说完点这里/ }).waitFor({ state: 'visible', timeout: 10_000 })
        const beforeActiveUnmount = await page.evaluate(() => ({ ...window.__e2eQuickVoiceCaptureStats }))
        await navigateWithinShell('/dashboard')
        await page.waitForTimeout(80)
        const afterActiveUnmount = await page.evaluate(() => ({ ...window.__e2eQuickVoiceCaptureStats }))
        if (asrRequests !== 1
            || afterActiveUnmount.recorderStops !== beforeActiveUnmount.recorderStops + 1
            || afterActiveUnmount.trackStops !== beforeActiveUnmount.trackStops + 1) {
            fail(`快捷语音录制中离开页面没有停止设备或仍提交 ASR：${JSON.stringify({ beforeActiveUnmount, afterActiveUnmount, asrRequests })}`)
        }

        // 5) 与桌面相同的取消意图在移动端必须可见、可点且不能撑破页面。
        await page.setViewportSize({ width: 390, height: 844 })
        await navigateWithinShell('/ai-copilot')
        const mobileQuickVoice = quickVoiceButton()
        await mobileQuickVoice.scrollIntoViewIfNeeded()
        const mobileGeometry = await mobileQuickVoice.evaluate((node) => {
            const rect = node.getBoundingClientRect()
            return {
                viewportWidth: document.documentElement.clientWidth,
                pageWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
                right: Math.round(rect.right),
                height: Math.round(rect.height),
            }
        })
        if (mobileGeometry.pageWidth > mobileGeometry.viewportWidth + 2
            || mobileGeometry.right > mobileGeometry.viewportWidth + 2
            || mobileGeometry.height < 44) {
            fail(`快捷语音移动端操作区溢出或触控高度不足：${JSON.stringify(mobileGeometry)}`)
        }
        await page.screenshot({
            path: path.join(OUTPUT_DIR, 'mobile-ai-copilot-quick-voice-lifecycle.png'),
            fullPage: false,
        })
        quickVoiceCaptureLifecycleChecked = true
    } finally {
        await page.close()
    }
}

/**
 * 开课页和创新模式不能在数据源失联时展示图谱样例、也不能让前端列出的
 * "诗词接龙"在后端被拒绝。该回归先验证开课页的失败关闭和人工恢复，再
 * 真正以创新模式开课，并验证运行态接龙组件同样保持来源边界。
 */
/**
 * 课堂 Hero 的七模式文字不是纯装饰：教师必须能暂停、逐项选择，并且在
 * 减弱动态或组件离屏时不会继续后台轮播。本检查使用生产 Classroom 调用的
 * 真实 3000ms 间隔，因此等待时间刻意超过一个完整周期；不使用假时钟伪造结果。
 */
async function checkClassroomTextSwitchContract(context) {
    activeRoute = 'classroom-text-switch-contract'
    const expectedTexts = [
        '集体闯关',
        '速答 PK',
        '飞花令擂台',
        '六阶沉浸课',
        '诗词大转盘',
        '诗词接龙',
        '意境拼图',
    ]
    const browser = context.browser()
    if (!browser) {
        fail('课堂 TextSwitch 专项无法取得浏览器实例')
        return
    }

    const textSwitchContext = await browser.newContext({
        storageState: await context.storageState(),
        viewport: { width: 1440, height: 900 },
        locale: 'zh-CN',
        reducedMotion: 'no-preference',
    })
    const page = await textSwitchContext.newPage()
    const runtimeErrors = []
    page.on('pageerror', (error) => runtimeErrors.push(error.message))

    try {
        await page.goto(`${BASE_URL}/classroom`, { waitUntil: 'domcontentloaded' })
        await waitForSettledPage(page)

        const root = page.locator('[data-textswitch-root="true"]')
        const group = root.getByRole('group', { name: '切换展示文本', exact: true })
        const buttons = group.locator('button[data-textswitch-index]')
        const pauseControl = root.locator('button[data-textswitch-pause-control="true"]')
        const content = root.locator('[data-textswitch-content]')
        const live = root.locator('[data-textswitch-live]')
        const stage = root.locator('.pr-textswitch-stage')

        await Promise.all([
            root.waitFor({ state: 'visible', timeout: 10_000 }),
            group.waitFor({ state: 'visible', timeout: 10_000 }),
            pauseControl.waitFor({ state: 'visible', timeout: 10_000 }),
            page.waitForFunction(() => (
                document.querySelector('[data-textswitch-root="true"]')
                    ?.getAttribute('data-textswitch-playback') === 'playing'
            ), undefined, { timeout: 10_000 }),
        ])

        const initialContract = await root.evaluate((node, texts) => {
            const modeButtons = Array.from(node.querySelectorAll('button[data-textswitch-index]'))
            const pause = node.querySelector('button[data-textswitch-pause-control="true"]')
            const indicatorGroup = node.querySelector('[role="group"][aria-label="切换展示文本"]')
            const currentIndex = Number(node.getAttribute('data-textswitch-active-index'))
            const currentText = texts[currentIndex] ?? ''
            const contentNode = node.querySelector('[data-textswitch-content]')
            const liveNode = node.querySelector('[data-textswitch-live]')
            const controlRects = [...modeButtons, pause].filter(Boolean).map((control) => {
                const rect = control.getBoundingClientRect()
                return { width: rect.width, height: rect.height }
            })
            const resourceNames = performance.getEntriesByType('resource').map((entry) => entry.name.toLowerCase())
            const longAnimations = node.getAnimations({ subtree: true }).filter((animation) => {
                const timing = animation.effect?.getComputedTiming()
                return animation.playState === 'running'
                    && (timing?.iterations === Infinity || Number(timing?.duration ?? 0) > 600)
            })
            return {
                rootCount: document.querySelectorAll('[data-textswitch-root="true"]').length,
                activeIndex: currentIndex,
                playback: node.getAttribute('data-textswitch-playback'),
                pauseReasons: node.getAttribute('data-textswitch-pause-reasons'),
                motion: node.getAttribute('data-textswitch-motion'),
                buttonCount: modeButtons.length,
                labelsMatch: modeButtons.every((button, index) => (
                    button.getAttribute('aria-label')?.includes(texts[index])
                )),
                currentCount: modeButtons.filter((button) => button.getAttribute('aria-pressed') === 'true').length,
                focusableCount: modeButtons.filter((button) => button.getAttribute('tabindex') === '0').length,
                activeClassCount: modeButtons.filter((button) => button.classList.contains('is-active')).length,
                idsUnique: new Set(modeButtons.map((button) => button.id)).size === modeButtons.length
                    && modeButtons.every((button) => Boolean(button.id)),
                groupContainsPause: Boolean(indicatorGroup?.contains(pause)),
                pauseLabel: pause?.getAttribute('aria-label') ?? null,
                pausePressed: pause?.getAttribute('aria-pressed') ?? null,
                controlsAtLeast44: controlRects.every((rect) => rect.width >= 44 && rect.height >= 44),
                contentText: contentNode?.textContent?.trim() ?? null,
                contentAriaHidden: contentNode?.getAttribute('aria-hidden') ?? null,
                liveCount: node.querySelectorAll('[data-textswitch-live]').length,
                liveText: liveNode?.textContent?.trim() ?? null,
                liveMode: liveNode?.getAttribute('aria-live') ?? null,
                liveAtomic: liveNode?.getAttribute('aria-atomic') ?? null,
                measureItemCount: node.querySelectorAll('.pr-textswitch-measure-item').length,
                legacySplitCount: node.querySelectorAll('.pr-textswitch-word, .pr-textswitch-element, .pr-textswitch-exit-layer').length,
                canvasCount: node.querySelectorAll('canvas').length,
                svgCount: node.querySelectorAll('svg').length,
                longAnimationCount: longAnimations.length,
                gsapResourceCount: resourceNames.filter((name) => name.includes('gsap-vendor')).length,
                currentText,
                pageHasHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
            }
        }, expectedTexts)
        if (initialContract.rootCount !== 1
            || !Number.isInteger(initialContract.activeIndex)
            || initialContract.activeIndex < 0
            || initialContract.activeIndex >= expectedTexts.length
            || initialContract.playback !== 'playing'
            || initialContract.pauseReasons !== 'none'
            || initialContract.motion !== 'full'
            || initialContract.buttonCount !== expectedTexts.length
            || !initialContract.labelsMatch
            || initialContract.currentCount !== 1
            || initialContract.focusableCount !== 1
            || initialContract.activeClassCount !== 1
            || !initialContract.idsUnique
            || initialContract.groupContainsPause
            || initialContract.pauseLabel !== '暂停自动切换'
            || initialContract.pausePressed !== 'false'
            || !initialContract.controlsAtLeast44
            || initialContract.contentText !== initialContract.currentText
            || initialContract.contentAriaHidden !== 'true'
            || initialContract.liveCount !== 1
            || initialContract.liveText !== initialContract.currentText
            || initialContract.liveMode !== 'polite'
            || initialContract.liveAtomic !== 'true'
            || initialContract.measureItemCount !== expectedTexts.length
            || initialContract.legacySplitCount !== 0
            || initialContract.canvasCount !== 0
            || initialContract.svgCount !== 0
            || initialContract.longAnimationCount !== 0
            || initialContract.gsapResourceCount !== 0
            || initialContract.pageHasHorizontalOverflow) {
            fail(`课堂 TextSwitch 初始语义/资源契约不合格：${JSON.stringify(initialContract)}`)
        }

        const assertSelection = async (index, boundary) => {
            await page.waitForFunction(({ expectedIndex, expectedText }) => {
                const rootNode = document.querySelector('[data-textswitch-root="true"]')
                const button = rootNode?.querySelector(`[data-textswitch-index="${expectedIndex}"]`)
                const contentNode = rootNode?.querySelector('[data-textswitch-content]')
                const liveNode = rootNode?.querySelector('[data-textswitch-live]')
                const buttonsInRoot = Array.from(rootNode?.querySelectorAll('[data-textswitch-index]') ?? [])
                return rootNode?.getAttribute('data-textswitch-active-index') === String(expectedIndex)
                    && button?.getAttribute('aria-pressed') === 'true'
                    && button?.getAttribute('tabindex') === '0'
                    && button.classList.contains('is-active')
                    && document.activeElement === button
                    && buttonsInRoot.filter((candidate) => candidate.getAttribute('aria-pressed') === 'true').length === 1
                    && buttonsInRoot.filter((candidate) => candidate.getAttribute('tabindex') === '0').length === 1
                    && contentNode?.textContent?.trim() === expectedText
                    && liveNode?.textContent?.trim() === expectedText
            }, { expectedIndex: index, expectedText: expectedTexts[index] }, { timeout: 5_000 })

            const activeName = await buttons.nth(index).getAttribute('aria-label')
            if (!activeName?.includes(expectedTexts[index]) || !activeName.includes('当前展示')) {
                fail(`${boundary} 后当前模式缺少完整可访问名称：${activeName ?? 'null'}`)
            }
        }

        const stableRectBefore = await stage.boundingBox()
        await buttons.nth(0).focus()
        await page.keyboard.press('Home')
        await assertSelection(0, 'Home')
        await page.keyboard.press('ArrowRight')
        await assertSelection(1, 'ArrowRight')
        await page.keyboard.press('ArrowLeft')
        await assertSelection(0, 'ArrowLeft')
        await page.keyboard.press('ArrowUp')
        await assertSelection(6, 'ArrowUp')
        await page.keyboard.press('ArrowDown')
        await assertSelection(0, 'ArrowDown')
        await page.keyboard.press('End')
        await assertSelection(6, 'End')
        await page.keyboard.press('Home')
        await assertSelection(0, 'Home 回归')
        const stableRectAfter = await stage.boundingBox()
        if (!stableRectBefore || !stableRectAfter
            || Math.abs(stableRectBefore.width - stableRectAfter.width) > 1
            || Math.abs(stableRectBefore.height - stableRectAfter.height) > 1) {
            fail(`课堂 TextSwitch 切换后尺寸不稳定：before=${JSON.stringify(stableRectBefore)} after=${JSON.stringify(stableRectAfter)}`)
        }

        await page.waitForFunction(() => (
            document.querySelector('[data-textswitch-root="true"]')
                ?.getAttribute('data-textswitch-pause-reasons')
                ?.split(/\s+/).includes('focus-within')
        ))
        const focusPausedIndex = Number(await root.getAttribute('data-textswitch-active-index'))
        const focusPausedElementId = await page.evaluate(() => document.activeElement?.id ?? null)
        await page.waitForTimeout(3_250)
        const afterFocusPause = await root.evaluate((node) => ({
            index: Number(node.getAttribute('data-textswitch-active-index')),
            focusedId: document.activeElement?.id ?? null,
        }))
        if (afterFocusPause.index !== focusPausedIndex || afterFocusPause.focusedId !== focusPausedElementId) {
            fail(`TextSwitch 聚焦超过生产轮播周期后仍自行切换或丢焦：${JSON.stringify(afterFocusPause)}`)
        }

        await page.evaluate(() => {
            if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
        })
        await root.hover()
        await page.waitForFunction(() => (
            document.querySelector('[data-textswitch-root="true"]')
                ?.getAttribute('data-textswitch-pause-reasons')
                ?.split(/\s+/).includes('hover')
        ))
        const hoverPausedIndex = Number(await root.getAttribute('data-textswitch-active-index'))
        await page.waitForTimeout(3_250)
        if (Number(await root.getAttribute('data-textswitch-active-index')) !== hoverPausedIndex) {
            fail('TextSwitch 悬停超过生产轮播周期后仍自行切换')
        }

        await page.mouse.move(1435, 895)
        await page.evaluate(() => {
            if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
        })
        await page.waitForFunction(() => (
            document.querySelector('[data-textswitch-root="true"]')
                ?.getAttribute('data-textswitch-pause-reasons') === 'none'
        ), undefined, { timeout: 5_000 })

        await pauseControl.click()
        await page.mouse.move(1435, 895)
        await page.evaluate(() => {
            if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
        })
        await page.waitForFunction(() => {
            const rootNode = document.querySelector('[data-textswitch-root="true"]')
            const reasons = rootNode?.getAttribute('data-textswitch-pause-reasons')?.split(/\s+/) ?? []
            return rootNode?.getAttribute('data-textswitch-playback') === 'paused'
                && reasons.includes('manual')
                && !reasons.includes('focus-within')
                && !reasons.includes('hover')
        }, undefined, { timeout: 5_000 })
        const manualPausedIndex = Number(await root.getAttribute('data-textswitch-active-index'))
        await page.waitForTimeout(3_250)
        if (Number(await root.getAttribute('data-textswitch-active-index')) !== manualPausedIndex) {
            fail('TextSwitch 显式暂停超过生产轮播周期后仍自行切换')
        }

        await pauseControl.click()
        await page.mouse.move(1435, 895)
        await page.evaluate(() => {
            if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
        })
        await page.waitForFunction(() => {
            const rootNode = document.querySelector('[data-textswitch-root="true"]')
            return rootNode?.getAttribute('data-textswitch-playback') === 'playing'
                && rootNode.getAttribute('data-textswitch-pause-reasons') === 'none'
        }, undefined, { timeout: 5_000 })
        const resumedIndex = Number(await root.getAttribute('data-textswitch-active-index'))
        await page.waitForFunction((previousIndex) => (
            Number(document.querySelector('[data-textswitch-root="true"]')
                ?.getAttribute('data-textswitch-active-index')) !== previousIndex
        ), resumedIndex, { timeout: 4_500 })

        // Classroom 的生产壳层锁定主文档滚动，不能用 window.scrollTo 伪造离屏。
        // 收窄真实浏览器视口，使位于约 195px 处的组件完整落到视口之外，
        // 由真实 IntersectionObserver 产生 offscreen；随后恢复正式桌面视口。
        await page.setViewportSize({ width: 1440, height: 120 })
        try {
            await page.waitForFunction(() => (
                document.querySelector('[data-textswitch-root="true"]')
                    ?.getAttribute('data-textswitch-pause-reasons')
                    ?.split(/\s+/).includes('offscreen')
            ), undefined, { timeout: 5_000 })
        } catch {
            const offscreenDebug = await root.evaluate((node) => {
                const rect = node.getBoundingClientRect()
                return {
                    reasons: node.getAttribute('data-textswitch-pause-reasons'),
                    playback: node.getAttribute('data-textswitch-playback'),
                    rect: { top: rect.top, bottom: rect.bottom, height: rect.height },
                    viewportHeight: window.innerHeight,
                }
            })
            fail(`TextSwitch 未在真实窄高视口中进入 offscreen：${JSON.stringify(offscreenDebug)}`)
            return
        }
        const offscreenIndex = Number(await root.getAttribute('data-textswitch-active-index'))
        await page.waitForTimeout(3_250)
        if (Number(await root.getAttribute('data-textswitch-active-index')) !== offscreenIndex) {
            fail('TextSwitch 离屏超过生产轮播周期后仍在后台切换')
        }
        await page.setViewportSize({ width: 1440, height: 900 })
        await root.scrollIntoViewIfNeeded()
        await page.waitForFunction(() => (
            document.querySelector('[data-textswitch-root="true"]')
                ?.getAttribute('data-textswitch-playback') === 'playing'
        ), undefined, { timeout: 5_000 })
        const visibleAgainIndex = Number(await root.getAttribute('data-textswitch-active-index'))
        await page.waitForTimeout(1_000)
        if (Number(await root.getAttribute('data-textswitch-active-index')) !== visibleAgainIndex) {
            fail('TextSwitch 从离屏恢复后没有从一个完整轮播周期重新计时')
        }
        await page.waitForFunction((previousIndex) => (
            Number(document.querySelector('[data-textswitch-root="true"]')
                ?.getAttribute('data-textswitch-active-index')) !== previousIndex
        ), visibleAgainIndex, { timeout: 3_500 })

        await root.screenshot({ path: path.join(OUTPUT_DIR, 'desktop-classroom-text-switch.png') })

        await page.emulateMedia({ media: 'screen', reducedMotion: 'reduce', forcedColors: 'none' })
        await page.mouse.move(1435, 895)
        await page.evaluate(() => {
            if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
        })
        await page.waitForFunction(() => {
            const rootNode = document.querySelector('[data-textswitch-root="true"]')
            const reasons = rootNode?.getAttribute('data-textswitch-pause-reasons')?.split(/\s+/) ?? []
            return rootNode?.getAttribute('data-textswitch-motion') === 'reduced'
                && rootNode.getAttribute('data-textswitch-playback') === 'paused'
                && reasons.includes('reduced-motion')
        }, undefined, { timeout: 5_000 })
        const reducedIndex = Number(await root.getAttribute('data-textswitch-active-index'))
        await page.waitForTimeout(3_250)
        if (Number(await root.getAttribute('data-textswitch-active-index')) !== reducedIndex) {
            fail('TextSwitch 在 prefers-reduced-motion 下仍自动切换')
        }
        const reducedContract = await root.evaluate((node) => {
            const controls = Array.from(node.querySelectorAll('button'))
            const contentNode = node.querySelector('[data-textswitch-content]')
            const durationsAreZero = (value) => value
                .split(',')
                .every((duration) => Number.parseFloat(duration) === 0)
            return {
                mediaMatches: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
                contentAnimationName: contentNode ? window.getComputedStyle(contentNode).animationName : null,
                transitionsDisabled: controls.every((control) => (
                    durationsAreZero(window.getComputedStyle(control).transitionDuration)
                    && durationsAreZero(window.getComputedStyle(control, '::before').transitionDuration)
                )),
                runningAnimations: node.getAnimations({ subtree: true }).filter((animation) => animation.playState === 'running').length,
            }
        })
        if (!reducedContract.mediaMatches
            || !['none', null].includes(reducedContract.contentAnimationName)
            || !reducedContract.transitionsDisabled
            || reducedContract.runningAnimations !== 0) {
            fail(`TextSwitch 减弱动态 CSS 兜底不完整：${JSON.stringify(reducedContract)}`)
        }
        const reducedTarget = (reducedIndex + 1) % expectedTexts.length
        await buttons.nth(reducedTarget).click()
        await assertSelection(reducedTarget, '减弱动态手动选择')
        await root.screenshot({ path: path.join(OUTPUT_DIR, 'desktop-classroom-text-switch-reduced-motion.png') })

        await page.emulateMedia({ media: 'screen', reducedMotion: 'reduce', forcedColors: 'active' })
        await buttons.nth(reducedTarget).focus()
        const forcedColorsContract = await root.evaluate((node) => {
            const controls = Array.from(node.querySelectorAll('button'))
            const focused = document.activeElement
            const focusedStyle = focused instanceof HTMLElement ? window.getComputedStyle(focused) : null
            return {
                mediaMatches: window.matchMedia('(forced-colors: active)').matches,
                controlsHaveBorders: controls.every((control) => {
                    const style = window.getComputedStyle(control)
                    return style.borderStyle === 'solid' && Number.parseFloat(style.borderWidth) >= 1
                }),
                outlineStyle: focusedStyle?.outlineStyle ?? 'none',
                outlineWidth: Number.parseFloat(focusedStyle?.outlineWidth ?? '0'),
                pageHasHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
            }
        })
        if (!forcedColorsContract.mediaMatches
            || !forcedColorsContract.controlsHaveBorders
            || forcedColorsContract.outlineStyle === 'none'
            || forcedColorsContract.outlineWidth < 2
            || forcedColorsContract.pageHasHorizontalOverflow) {
            fail(`TextSwitch 强制色兜底不完整：${JSON.stringify(forcedColorsContract)}`)
        }
        await root.screenshot({ path: path.join(OUTPUT_DIR, 'desktop-classroom-text-switch-forced-colors.png') })

        await page.emulateMedia({ media: 'print', reducedMotion: 'reduce', forcedColors: 'none' })
        const printContract = await root.evaluate((node) => {
            const controls = node.querySelector('.pr-textswitch-controls')
            const contentNode = node.querySelector('[data-textswitch-content]')
            return {
                mediaMatches: window.matchMedia('print').matches,
                controlsHidden: controls ? window.getComputedStyle(controls).display === 'none' : false,
                contentVisible: contentNode ? window.getComputedStyle(contentNode).display !== 'none' : false,
                contentAnimationName: contentNode ? window.getComputedStyle(contentNode).animationName : null,
            }
        })
        if (!printContract.mediaMatches
            || !printContract.controlsHidden
            || !printContract.contentVisible
            || !['none', null].includes(printContract.contentAnimationName)) {
            fail(`TextSwitch 打印兜底不完整：${JSON.stringify(printContract)}`)
        }
        await page.emulateMedia({ media: 'screen', reducedMotion: 'no-preference', forcedColors: 'none' })

        const sourceBoundary = await fs.readFile(path.resolve('src/components/ui/TextSwitch.tsx'), 'utf8')
        const forbiddenSourcePatterns = [
            /from\s+['"]gsap['"]/,
            /Intl\.Segmenter/,
            /pr-textswitch-(?:word|element|exit-layer)/,
            /setInterval\s*\(/,
            /requestAnimationFrame\s*\(/,
            /innerHTML\s*=/,
            /<canvas\b/i,
        ]
        const matchedForbiddenPatterns = forbiddenSourcePatterns
            .filter((pattern) => pattern.test(sourceBoundary))
            .map((pattern) => pattern.source)
        const timeoutCount = (sourceBoundary.match(/window\.setTimeout\s*\(/g) ?? []).length
        const clearTimeoutCount = (sourceBoundary.match(/window\.clearTimeout\s*\(/g) ?? []).length
        if (matchedForbiddenPatterns.length > 0 || timeoutCount !== 1 || clearTimeoutCount !== 1) {
            fail(`TextSwitch 源码重新引入逐字符/重动画副作用或计时器不唯一：patterns=${matchedForbiddenPatterns.join(',')} setTimeout=${timeoutCount} clearTimeout=${clearTimeoutCount}`)
        }
        if (runtimeErrors.length > 0) {
            fail(`TextSwitch 专项出现浏览器运行时异常：${runtimeErrors.join(' | ')}`)
        }

        classroomTextSwitchContractChecked = true
    } finally {
        await textSwitchContext.close()
    }
}

async function checkClassroomPoemTruthAndInnovativeMode(context) {
    activeRoute = 'classroom-poem-truth-and-innovative-mode'
    const page = await context.newPage()
    let workbenchPoemsAvailable = false
    let recitationPoemsAvailable = false
    let controlledStartFailuresRemaining = 1
    let classroomStartRequests = 0
    // 讲解模式的 UI 契约不应由真实讲解服务的生成耗时决定。此样本仅覆盖
    // 面板关联、键盘与输入保护，不代表教材内容、教学质量或 AI 讲解效果。
    const controlledExplainPoem = {
        poemId: 'E2E-EXPLAIN-POEM',
        poemTitle: 'E2E 受控讲解样本',
        poet: '仅用于界面回归',
        dynasty: '测试',
        lines: [{
            lineIndex: 0,
            original: '受控界面样本',
            pinyin: ['shòu', 'kòng', 'jiè', 'miàn', 'yàng', 'běn'],
            translation: '仅验证讲解视图的前端结构与交互。',
            annotations: [],
        }],
        characters: [],
        overallTranslation: '仅用于生产前端 UI 回归。',
        theme: '不构成教材、学生或教学质量证据。',
        aiGenerated: false,
        sourceVerification: {
            status: 'INCOMPLETE',
            catalogScope: 'UNCLASSIFIED',
            contentSha256: 'E2E-UI-CONTRACT-ONLY',
            reviewedAt: null,
            sourceTitles: [],
            message: 'E2E 受控界面样本，不构成教材内容证据。',
        },
        teachingContentReviewStatus: 'NOT_GENERATED',
    }
    const controlledExplain = {
        poemId: 'E2E-EXPLAIN-POEM',
        poemTitle: 'E2E 受控讲解样本',
        poet: '仅用于界面回归',
        lines: [{
            lineIndex: 0,
            teachingPoints: ['仅验证模式切换后的内容面板。'],
            pronunciationNotes: [{
                char: '样本',
                correctPinyin: 'yàng běn',
                commonError: '无',
                note: '仅用于前端正音卡片布局回归。',
            }],
            discussionPrompts: ['此处只验证界面状态，不评价教学内容。'],
            imageryAnalysis: '仅验证受控内容在正确面板内呈现。',
        }],
        overallTeachingAdvice: '仅验证讲解模式的前端状态、可访问性与键盘行为。',
        suggestedDurationMin: 1,
        aiGenerated: false,
    }
    try {
        await page.addInitScript(() => window.localStorage.removeItem('pr-demo-mode'))
        await page.route('**/api/workbench/poems', (route) => {
            if (!workbenchPoemsAvailable) {
                return route.fulfill({
                    status: 503,
                    contentType: 'application/json',
                    body: JSON.stringify({ error: 'SERVICE_UNAVAILABLE', message: 'intentional classroom poem outage' }),
                })
            }
            return route.continue()
        })
        await page.route('**/api/recitation/poems**', (route) => {
            if (!recitationPoemsAvailable) {
                return route.fulfill({
                    status: 503,
                    contentType: 'application/json',
                    body: JSON.stringify({ error: 'SERVICE_UNAVAILABLE', message: 'intentional relay poem outage' }),
                })
            }
            return route.continue()
        })
        await page.route('**/api/classroom/start', (route) => {
            classroomStartRequests += 1
            if (controlledStartFailuresRemaining > 0) {
                controlledStartFailuresRemaining -= 1
                return route.fulfill({
                    status: 503,
                    contentType: 'application/json',
                    body: JSON.stringify({
                        status: 'error',
                        error: 'CLASSROOM_RUNTIME_UNAVAILABLE',
                        message: '受控运行时持久化失败；仅用于前端失败关闭回归。',
                    }),
                })
            }
            return route.continue()
        })
        await page.route('**/api/poem-content/**', (route) => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(controlledExplainPoem),
        }))
        await page.route('**/api/classroom/explain/**', (route) => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(controlledExplain),
        }))
        await page.setViewportSize({ width: 1440, height: 900 })
        await page.goto(`${BASE_URL}/classroom`, { waitUntil: 'domcontentloaded' })
        await waitForSettledPage(page)

        // 课堂启动页的七模式文本轮播采用 button group，而非没有面板的伪 Tab。
        // 此处验证其唯一当前项、roving tabindex、方向键/Home/End 以及焦点同步；
        // 焦点进入后自动轮播必须暂停，避免教师选择时状态自行跳变。
        const textSwitchIndicators = page.getByRole('group', { name: '切换展示文本', exact: true })
        const textSwitchButtons = textSwitchIndicators.getByRole('button')
        await Promise.all([
            textSwitchIndicators.waitFor({ state: 'visible', timeout: 10_000 }),
            page.waitForFunction(
                () => document.querySelectorAll('[data-textswitch-index]').length === 7,
                undefined,
                { timeout: 10_000 },
            ),
        ])
        const textSwitchContract = await textSwitchButtons.evaluateAll((buttons) => ({
            count: buttons.length,
            currentCount: buttons.filter((button) => button.getAttribute('aria-pressed') === 'true').length,
            focusableCount: buttons.filter((button) => button.getAttribute('tabindex') === '0').length,
            idsPresent: buttons.every((button) => Boolean(button.id)),
        }))
        if (textSwitchContract.count !== 7
            || textSwitchContract.currentCount !== 1
            || textSwitchContract.focusableCount !== 1
            || !textSwitchContract.idsPresent) {
            fail(`课堂启动页文本轮播指示器契约不完整：${JSON.stringify(textSwitchContract)}`)
        }
        await textSwitchButtons.nth(0).focus()
        await page.keyboard.press('End')
        await page.waitForFunction(() => {
            const button = document.querySelector('[data-textswitch-index="6"]')
            return button?.getAttribute('aria-pressed') === 'true'
                && button.getAttribute('tabindex') === '0'
                && document.activeElement === button
        }, undefined, { timeout: 5_000 })
        await page.keyboard.press('Home')
        await page.waitForFunction(() => {
            const button = document.querySelector('[data-textswitch-index="0"]')
            return button?.getAttribute('aria-pressed') === 'true'
                && button.getAttribute('tabindex') === '0'
                && document.activeElement === button
        }, undefined, { timeout: 5_000 })

        const outage = page.getByText('真实诗库暂不可用', { exact: true })
        const retry = page.getByRole('button', { name: '重试真实诗库', exact: true })
        const poemSelect = page.getByRole('combobox', { name: '诗篇' })
        const launch = page.getByRole('button', { name: '开始课堂', exact: true })
        await Promise.all([
            outage.waitFor({ state: 'visible', timeout: 10_000 }),
            retry.waitFor({ state: 'visible', timeout: 10_000 }),
            poemSelect.waitFor({ state: 'visible', timeout: 10_000 }),
        ])
        if (!await poemSelect.isDisabled()) {
            fail('开课页真实诗库单点故障时仍允许选择未知来源的本地诗篇')
        }
        if (!await launch.isDisabled()) {
            fail('开课页真实诗库单点故障时仍允许启动课堂')
        }
        await page.screenshot({
            path: path.join(OUTPUT_DIR, 'desktop-classroom-poem-source-outage.png'),
            fullPage: false,
        })

        workbenchPoemsAvailable = true
        await retry.click()
        await outage.waitFor({ state: 'hidden', timeout: 10_000 })
        await page.waitForFunction(() => {
            const trigger = document.querySelector('[aria-label="诗篇"]')
            return trigger instanceof HTMLInputElement && !trigger.disabled
        }, undefined, { timeout: 10_000 })

        const relayMode = page.locator('.pr-classroom-mode-card--hero').filter({ hasText: '诗词接龙' })
        await relayMode.waitFor({ state: 'visible', timeout: 10_000 })
        await relayMode.click()
        await page.waitForFunction(() => {
            const card = Array.from(document.querySelectorAll('.pr-classroom-mode-card--hero'))
                .find((node) => node.textContent?.includes('诗词接龙'))
            return card?.getAttribute('aria-pressed') === 'true'
        }, undefined, { timeout: 10_000 })

        const readyText = page.locator('.pr-classroom-readiness').getByText(/道真实题目已就绪/)
        await readyText.waitFor({ state: 'visible', timeout: 15_000 })
        try {
            await page.waitForFunction(() => {
                const button = Array.from(document.querySelectorAll('button'))
                    .find((node) => node.textContent?.trim() === '开始课堂')
                return button instanceof HTMLButtonElement && !button.disabled
            }, undefined, { timeout: 15_000 })
        } catch {
            const launchState = await page.evaluate(() => {
                const button = Array.from(document.querySelectorAll('button'))
                    .find((node) => node.textContent?.trim() === '开始课堂')
                const selects = Array.from(document.querySelectorAll('select')).map((select) => ({
                    label: select.closest('label')?.textContent?.trim() ?? '',
                    value: select.value,
                    disabled: select.disabled,
                }))
                return { disabled: button instanceof HTMLButtonElement ? button.disabled : null, selects }
            })
            fail(`诗词接龙已通过题库核验但开始课堂仍不可用：${JSON.stringify(launchState)}`)
            return
        }
        // 先注入一次具名 503，验证前端不会把失败写成“课堂已开始”、不会导航到
        // 伪 lessonId，并把可恢复状态留在同一份教师配置上。此响应仅测试 UI
        // 失败关闭；不代表真实学校数据库或课堂成效。
        await launch.click()
        const startFailure = page.locator('[data-classroom-launch-failure="true"]')
        const retryLaunch = page.getByRole('button', { name: '重新尝试启动', exact: true })
        await Promise.all([
            startFailure.waitFor({ state: 'visible', timeout: 10_000 }),
            retryLaunch.waitFor({ state: 'visible', timeout: 10_000 }),
        ])
        const failureContract = await startFailure.evaluate((node) => {
            const button = document.querySelector('[data-classroom-launch-action="true"]')
            return {
                role: node.getAttribute('role'),
                text: node.textContent?.replace(/\s+/gu, ' ').trim() ?? '',
                retryEnabled: button instanceof HTMLButtonElement ? !button.disabled : null,
                describedBy: button?.getAttribute('aria-describedby') ?? null,
                currentPath: window.location.pathname,
            }
        })
        if (failureContract.role !== 'alert'
            || !failureContract.text.includes('课堂尚未启动')
            || !failureContract.text.includes('未生成加入码或开放实时通道')
            || failureContract.retryEnabled !== true
            || failureContract.describedBy !== 'pr-classroom-launch-failure'
            || failureContract.currentPath !== '/classroom') {
            fail(`课堂启动 503 未完成页面失败关闭或安全重试契约：${JSON.stringify(failureContract)}`)
            return
        }
        await page.screenshot({
            path: path.join(OUTPUT_DIR, 'desktop-classroom-start-failure-closure.png'),
            fullPage: false,
        })
        // 同一故障态必须能在手机上完整解释并保留安全重试，不能因为桌面侧栏
        // 收窄后让教师只看见泛化 Toast 或被裁切的主操作。复用同一次受控 503，
        // 再切换回桌面完成真实重试，避免把第二次开课写成独立的模拟结果。
        await page.setViewportSize({ width: 390, height: 844 })
        await startFailure.scrollIntoViewIfNeeded()
        const mobileFailureContract = await startFailure.evaluate((node) => {
            const button = document.querySelector('[data-classroom-launch-action="true"]')
            if (!(node instanceof HTMLElement) || !(button instanceof HTMLButtonElement)) return null
            const failureRect = node.getBoundingClientRect()
            const buttonRect = button.getBoundingClientRect()
            return {
                failureLeft: failureRect.left,
                failureRight: failureRect.right,
                failureTop: failureRect.top,
                failureBottom: failureRect.bottom,
                buttonLeft: buttonRect.left,
                buttonRight: buttonRect.right,
                buttonWidth: buttonRect.width,
                buttonHeight: buttonRect.height,
                buttonEnabled: !button.disabled,
                duplicateStartFailureToastCount: Array.from(document.querySelectorAll('.pr-toast')).filter((toast) =>
                    toast.textContent?.replace(/\s+/gu, ' ').includes('开始失败'),
                ).length,
                viewportWidth: window.innerWidth,
                viewportHeight: window.innerHeight,
                pageOverflowX: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0) > window.innerWidth + 1,
                currentPath: window.location.pathname,
            }
        })
        if (!mobileFailureContract
            || mobileFailureContract.failureLeft < -2
            || mobileFailureContract.failureRight > mobileFailureContract.viewportWidth + 2
            || mobileFailureContract.failureTop < -2
            || mobileFailureContract.failureBottom > mobileFailureContract.viewportHeight + 2
            || mobileFailureContract.buttonLeft < -2
            || mobileFailureContract.buttonRight > mobileFailureContract.viewportWidth + 2
            || mobileFailureContract.buttonWidth < 24
            || mobileFailureContract.buttonHeight < 32
            || mobileFailureContract.buttonEnabled !== true
            || mobileFailureContract.duplicateStartFailureToastCount !== 0
            || mobileFailureContract.pageOverflowX
            || mobileFailureContract.currentPath !== '/classroom') {
            fail(`课堂启动 503 的移动端失败提示发生裁切、溢出或失去安全重试：${JSON.stringify(mobileFailureContract)}`)
            return
        }
        await page.screenshot({
            path: path.join(OUTPUT_DIR, 'mobile-classroom-start-failure-closure.png'),
            fullPage: false,
        })
        await page.setViewportSize({ width: 1440, height: 900 })
        await retryLaunch.click()
        await page.waitForURL(/\/classroom\/[^/]+$/u, { timeout: 15_000 })
        await waitForSettledPage(page)
        if (classroomStartRequests !== 2 || controlledStartFailuresRemaining !== 0) {
            fail(`课堂启动重试未按受控 503 → 真正开课顺序执行：${JSON.stringify({ classroomStartRequests, controlledStartFailuresRemaining })}`)
            return
        }
        classroomStartFailureClosureChecked = true
        await verifyRovingTablist(page, {
            tablistName: '课堂视图模式',
            dataAttribute: 'data-classroom-view-tab',
            expectedValues: ['quiz', 'explain', 'dance'],
            boundary: '课堂导播运行视图',
        })

        const relayOutage = page.locator('.pr-poem-relay-source').getByText('真实诗库暂不可用', { exact: true })
        const relayRetry = page.locator('.pr-poem-relay-setup').getByRole('button', { name: '重试真实诗库', exact: true })
        const relayStart = page.getByRole('button', { name: '启动接龙', exact: true })
        await Promise.all([
            relayOutage.waitFor({ state: 'visible', timeout: 10_000 }),
            relayRetry.waitFor({ state: 'visible', timeout: 10_000 }),
            relayStart.waitFor({ state: 'visible', timeout: 10_000 }),
        ])
        if (!await relayStart.isDisabled()) {
            fail('接龙真实诗库单点故障时仍允许用未知来源内容启动活动')
        }
        await page.screenshot({
            path: path.join(OUTPUT_DIR, 'desktop-classroom-poem-relay-source-outage.png'),
            fullPage: false,
        })

        recitationPoemsAvailable = true
        await relayRetry.click()
        await relayOutage.waitFor({ state: 'hidden', timeout: 10_000 })
        const relayPoemSelect = page.getByRole('combobox', { name: '起始诗篇', exact: true })
        await relayPoemSelect.waitFor({ state: 'visible', timeout: 10_000 })
        const relayPoemSelectState = await relayPoemSelect.evaluate((node) => ({
            disabled: node instanceof HTMLInputElement ? node.disabled : null,
            hasPopup: node.getAttribute('aria-haspopup'),
            controls: node.getAttribute('aria-controls'),
        }))
        if (relayPoemSelectState.disabled !== false
            || relayPoemSelectState.hasPopup !== 'listbox'
            || !relayPoemSelectState.controls) {
            fail(`接龙起始诗篇控件在真实诗库恢复后缺少可访问名称或可用的组合框契约：${JSON.stringify(relayPoemSelectState)}`)
        }

        // 内嵌讲解与共舞不是只靠外层课堂视图 Tab 的视觉切换：两处自身也要
        // 保持控制器、动态面板与键盘焦点的闭环。这里不启动共舞会话、不提交
        // 指令，仅验证生产前端已正确暴露教师可达的模式入口。
        const explainView = page.locator('[data-classroom-view-tab="explain"]')
        await explainView.click()
        await verifyRovingTablist(page, {
            tablistName: '讲解视图模式',
            dataAttribute: 'data-explain-view-tab',
            expectedValues: ['explain', 'pronunciation'],
            boundary: '课堂讲解内嵌视图',
        })
        const verificationBadge = page.getByLabel(
            /原文验收状态：原文复核记录不完整。E2E 受控界面样本，不构成教材内容证据。/u,
        )
        await verificationBadge.waitFor({ state: 'visible', timeout: 10_000 })
        const verificationBadgeContract = await verificationBadge.evaluate((node) => ({
            text: node.textContent?.trim() ?? '',
            title: node.getAttribute('title'),
            accessibleName: node.getAttribute('aria-label'),
        }))
        if (verificationBadgeContract.text !== '原文复核记录不完整'
            || verificationBadgeContract.title !== 'E2E 受控界面样本，不构成教材内容证据。'
            || !verificationBadgeContract.accessibleName?.includes('原文复核记录不完整')) {
            fail(`课堂紧凑原文验收状态未保留完整可访问说明：${JSON.stringify(verificationBadgeContract)}`)
        }
        const verificationDisclosure = page.locator('[data-poem-verification-state="INCOMPLETE"]')
        await Promise.all([
            verificationDisclosure.waitFor({ state: 'visible', timeout: 10_000 }),
            page.getByText('当前内容可用于系统体验与教师预览，不得作为已验证教材原文、教材核心覆盖或真实教学成效的依据。', { exact: true })
                .waitFor({ state: 'visible', timeout: 10_000 }),
        ])
        const verificationDisclosureContract = await verificationDisclosure.evaluate((node) => ({
            open: node instanceof HTMLDetailsElement ? node.open : null,
            sourceText: node.textContent?.includes('尚未登记独立信源') === true,
            scopeText: node.textContent?.includes('尚未分类，不能按教材核心篇目使用') === true,
            reviewText: node.textContent?.includes('尚未完成教师验收') === true,
        }))
        if (verificationDisclosureContract.open !== true
            || !verificationDisclosureContract.sourceText
            || !verificationDisclosureContract.scopeText
            || !verificationDisclosureContract.reviewText) {
            fail(`课堂完整原文验收披露缺少默认展开或事实边界：${JSON.stringify(verificationDisclosureContract)}`)
        }
        await verificationDisclosure.scrollIntoViewIfNeeded()
        await page.screenshot({
            path: path.join(OUTPUT_DIR, 'desktop-classroom-poem-verification-disclosure.png'),
            fullPage: false,
        })

        const danceView = page.locator('[data-classroom-view-tab="dance"]')
        await danceView.click()
        await verifyRovingTablist(page, {
            tablistName: '教师指令类型',
            dataAttribute: 'data-dance-directive-tab',
            expectedValues: ['assign', 'guide', 'feedback'],
            boundary: 'AI 诗教共舞指令台',
        })
        const guideDirective = page.locator('[data-dance-directive-tab="guide"]')
        await guideDirective.click()
        const directiveState = await page.locator('#pr-dance-directive-panel').evaluate((panel) => {
            const textarea = document.querySelector('[aria-label="教师引导启发输入"]')
            return {
                labelledBy: panel.getAttribute('aria-labelledby'),
                busy: panel.getAttribute('aria-busy'),
                hasGuideInput: textarea instanceof HTMLTextAreaElement,
                guideInputDisabled: textarea instanceof HTMLTextAreaElement ? textarea.disabled : null,
            }
        })
        if (directiveState.labelledBy !== 'pr-dance-directive-tab-guide'
            || directiveState.busy !== 'false'
            || !directiveState.hasGuideInput
            || directiveState.guideInputDisabled !== true) {
            fail(`共舞指令切换未同步到受控面板或未在会话前保持输入保护：${JSON.stringify(directiveState)}`)
        }
        await page.locator('#pr-dance-directive-panel').scrollIntoViewIfNeeded()
        await page.screenshot({
            path: path.join(OUTPUT_DIR, 'desktop-classroom-dance-directives-keyboard.png'),
            fullPage: false,
        })

        await page.locator('[data-classroom-view-tab="quiz"]').click()

        const intervention = page.getByRole('button', { name: '干预建议', exact: true })
        await intervention.waitFor({ state: 'visible', timeout: 10_000 })
        await intervention.click()
        const interventionPanel = page.locator('.pr-ai-assistant-streaming--intervention')
        await interventionPanel.getByText('基于本节课已提交作答的规则化分析', { exact: false }).waitFor({
            state: 'visible',
            timeout: 10_000,
        })
        await page.screenshot({
            path: path.join(OUTPUT_DIR, 'desktop-classroom-intervention-analysis.png'),
            fullPage: false,
        })
        const adopt = interventionPanel.getByRole('button', { name: '采纳', exact: true })
        await adopt.click()
        await page.locator('.pr-ai-suggestion-btn--adopted').filter({ hasText: '干预建议' }).waitFor({
            state: 'visible',
            timeout: 10_000,
        })
        classroomPoemTruthAndInnovativeModeChecked = true
    } finally {
        await page.close()
    }
}

/**
 * 文化语境页不能把“原文待验收”藏进 hover。此检查使用明确标注的受控 UI 数据，
 * 只验证披露的渲染、原生 details 键盘开合和移动端几何，不代表教材或教学成效证据。
 */
async function checkCulturePoemVerificationDisclosure(context) {
    activeRoute = 'culture-poem-verification-disclosure'
    const page = await context.newPage()
    const controlledPoem = {
        id: 'E2E-CULTURE-POEM-VERIFICATION',
        title: 'E2E 内容边界样本',
        poet: '仅用于界面回归',
        dynasty: '测试',
        content: '界面数据必须明确来源边界。',
        theme: ['测试'],
        rhetoric: [],
        gradeLevel: '三年级',
    }
    const controlledContent = {
        poemId: controlledPoem.id,
        poemTitle: controlledPoem.title,
        poet: controlledPoem.poet,
        dynasty: controlledPoem.dynasty,
        lines: [{
            lineIndex: 0,
            original: '界面数据必须明确来源边界。',
            pinyin: [],
            translation: '仅用于验证内容验收披露的前端结构。',
            annotations: [],
        }],
        characters: [],
        overallTranslation: '这是生产前端的受控回归样本，不构成教材或教学质量证据。',
        theme: '仅验证内容边界展示。',
        aiGenerated: false,
        sourceVerification: {
            status: 'INCOMPLETE',
            catalogScope: 'UNCLASSIFIED',
            contentSha256: 'E2E-UI-CONTRACT-ONLY',
            reviewedAt: null,
            sourceTitles: [],
            message: 'E2E 受控界面样本，尚未完成独立信源与教师验收。',
        },
        teachingContentReviewStatus: 'NOT_GENERATED',
    }
    const controlledBackground = {
        poemId: controlledPoem.id,
        historical: '受控历史背景，仅用于瀑布流界面回归。',
        poet: '受控诗人信息，仅用于验证卡片语义与布局。',
        creation: '受控创作语境，仅用于验证响应式列数。',
        cultural: '受控文化内涵，仅用于验证移动端无溢出。',
        suggestedImagePrompt: 'E2E UI contract only',
        aiGenerated: true,
        generatedAt: 1_700_000_000_000,
    }
    try {
        await page.addInitScript(() => window.localStorage.removeItem('pr-demo-mode'))
        await page.route('**/api/recitation/poems**', (route) => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ status: 'ok', poems: [controlledPoem] }),
        }))
        await page.route(`**/api/poem-content/${controlledPoem.id}`, (route) => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ status: 'ok', ...controlledContent }),
        }))
        await page.route(`**/api/culture/poems/${controlledPoem.id}/background`, (route) => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ status: 'ok', background: controlledBackground, cached: true }),
        }))
        await page.route(`**/api/culture/poems/${controlledPoem.id}/images`, (route) => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                status: 'ok',
                poemId: controlledPoem.id,
                images: [],
                aiGenerated: false,
                cached: true,
            }),
        }))
        await page.setViewportSize({ width: 1440, height: 900 })
        await page.goto(`${BASE_URL}/culture`, { waitUntil: 'domcontentloaded' })
        const disclosure = page.locator('[data-poem-verification-state="INCOMPLETE"]')
        const summary = disclosure.locator('summary')
        await Promise.all([
            disclosure.waitFor({ state: 'visible', timeout: 15_000 }),
            page.getByText('当前内容可用于系统体验与教师预览，不得作为已验证教材原文、教材核心覆盖或真实教学成效的依据。', { exact: true })
                .waitFor({ state: 'visible', timeout: 15_000 }),
        ])
        const fallingTitle = page.locator('.pr-culture-falling-title-wrap .pr-falling-text-container')
        await fallingTitle.waitFor({ state: 'visible', timeout: 15_000 })
        const fallingTitleContract = await fallingTitle.evaluate((node) => {
            const target = node.querySelector('.pr-falling-text-target')
            const words = Array.from(node.querySelectorAll('.pr-falling-text__word'))
            const wordStyle = words[0] ? window.getComputedStyle(words[0]) : null
            const style = window.getComputedStyle(node)
            return {
                trigger: node.getAttribute('data-falling-trigger'),
                role: node.getAttribute('role'),
                tabIndex: node.getAttribute('tabindex'),
                hasCanvas: node.querySelectorAll('canvas').length,
                hasImage: node.querySelectorAll('img').length,
                wordTexts: words.map((word) => word.textContent ?? ''),
                targetText: target?.textContent ?? '',
                animation: wordStyle?.animationName ?? null,
                mediaReduced: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
                scrollWidth: node.scrollWidth,
                clientWidth: node.clientWidth,
                display: style.display,
            }
        })
        const expectedTitleTokens = [
            controlledPoem.title,
            '·',
            controlledPoem.poet,
            '·',
            controlledPoem.dynasty,
        ]
        if (fallingTitleContract.trigger !== 'auto'
            || fallingTitleContract.role !== null
            || fallingTitleContract.tabIndex !== null
            || fallingTitleContract.hasCanvas !== 0
            || fallingTitleContract.hasImage !== 0
            || fallingTitleContract.wordTexts.join(' ') !== expectedTitleTokens.join(' ')
            || fallingTitleContract.targetText.replace(/\s+/gu, '') !== expectedTitleTokens.join('').replace(/\s+/gu, '')
            || fallingTitleContract.animation !== 'none'
            || !fallingTitleContract.mediaReduced
            || fallingTitleContract.scrollWidth > fallingTitleContract.clientWidth + 1
            || fallingTitleContract.display !== 'grid') {
            fail(`文化页标题未保持 React 静态可读、无 Canvas 与减少动态契约：${JSON.stringify(fallingTitleContract)}`)
        } else {
            fallingTextTitleContractChecked = true
        }
        const masonry = page.locator('.pr-culture-cards-section .pr-masonry')
        await masonry.waitFor({ state: 'visible', timeout: 15_000 })
        await masonry.scrollIntoViewIfNeeded()
        const desktopMasonryContract = await masonry.evaluate((node) => {
            const items = Array.from(node.querySelectorAll(':scope > .pr-masonry-item'))
            const itemStyles = items.map((item) => window.getComputedStyle(item))
            const itemRects = items.map((item) => item.getBoundingClientRect())
            return {
                role: node.getAttribute('role'),
                display: window.getComputedStyle(node).display,
                columns: window.getComputedStyle(node).gridTemplateColumns.split(/\s+/u).filter(Boolean).length,
                visibleColumnLefts: [...new Set(itemRects.map((rect) => Math.round(rect.left)))],
                maxColumns: node.getAttribute('data-masonry-columns'),
                itemCount: items.length,
                itemRoles: items.map((item) => item.getAttribute('role')),
                headings: items.map((item) => item.querySelector('h3')?.textContent?.trim() ?? ''),
                animations: itemStyles.map((itemStyle) => itemStyle.animationName),
                inlineMotionStyles: items.filter((item) => /(?:^|;)\s*(?:opacity|filter|transform)\s*:/u.test(item.getAttribute('style') ?? '')).length,
                injectedStyles: Array.from(document.head.querySelectorAll('style')).filter((style) => style.textContent?.includes('.pr-masonry')).length,
                legacyStyleNode: document.querySelectorAll('#pr-masonry-styles, #masonry-grid-styles').length,
                mediaReduced: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
                scrollWidth: node.scrollWidth,
                clientWidth: node.clientWidth,
            }
        })
        const expectedCardHeadings = ['历史背景', '诗人小传', '创作语境', '文化内涵']
        if (desktopMasonryContract.role !== 'list'
            || desktopMasonryContract.display !== 'grid'
            || desktopMasonryContract.columns !== 3
            || desktopMasonryContract.visibleColumnLefts.length !== 3
            || desktopMasonryContract.maxColumns !== '3'
            || desktopMasonryContract.itemCount !== 4
            || desktopMasonryContract.itemRoles.some((role) => role !== 'listitem')
            || desktopMasonryContract.headings.join('|') !== expectedCardHeadings.join('|')
            || desktopMasonryContract.animations.some((animation) => animation !== 'none')
            || desktopMasonryContract.inlineMotionStyles !== 0
            || desktopMasonryContract.injectedStyles !== 0
            || desktopMasonryContract.legacyStyleNode !== 0
            || !desktopMasonryContract.mediaReduced
            || desktopMasonryContract.scrollWidth > desktopMasonryContract.clientWidth + 1) {
            fail(`文化卡片瀑布流未满足桌面语义、三列、无运行时样式注入与减少动态契约：${JSON.stringify(desktopMasonryContract)}`)
        }
        await masonry.screenshot({
            path: path.join(OUTPUT_DIR, 'desktop-culture-masonry-grid.png'),
        })
        const disclosureContract = await disclosure.evaluate((node) => ({
            open: node instanceof HTMLDetailsElement ? node.open : null,
            summaryText: node.querySelector('summary')?.textContent?.replace(/\s+/gu, ' ').trim() ?? '',
            sourceText: node.textContent?.includes('尚未登记独立信源') === true,
            scopeText: node.textContent?.includes('尚未分类，不能按教材核心篇目使用') === true,
        }))
        if (disclosureContract.open !== true
            || !disclosureContract.summaryText.includes('原文复核记录不完整')
            || !disclosureContract.sourceText
            || !disclosureContract.scopeText) {
            fail(`文化语境内容验收披露没有默认展开或缺失事实边界：${JSON.stringify(disclosureContract)}`)
        }

        await summary.focus()
        await page.keyboard.press('Enter')
        await page.waitForFunction(
            () => (document.querySelector('[data-poem-verification-state="INCOMPLETE"]') instanceof HTMLDetailsElement)
                && !document.querySelector('[data-poem-verification-state="INCOMPLETE"]').open,
            undefined,
            { timeout: 5_000 },
        )
        await page.keyboard.press('Space')
        await page.waitForFunction(
            () => (document.querySelector('[data-poem-verification-state="INCOMPLETE"]') instanceof HTMLDetailsElement)
                && document.querySelector('[data-poem-verification-state="INCOMPLETE"]').open,
            undefined,
            { timeout: 5_000 },
        )
        await disclosure.scrollIntoViewIfNeeded()
        await page.screenshot({
            path: path.join(OUTPUT_DIR, 'desktop-culture-poem-verification-disclosure.png'),
            fullPage: false,
        })

        await page.setViewportSize({ width: 390, height: 844 })
        await masonry.scrollIntoViewIfNeeded()
        const mobileMasonryContract = await masonry.evaluate((node) => ({
            display: window.getComputedStyle(node).display,
            columns: window.getComputedStyle(node).gridTemplateColumns.split(/\s+/u).filter(Boolean).length,
            scrollWidth: node.scrollWidth,
            clientWidth: node.clientWidth,
            itemWidths: Array.from(node.querySelectorAll(':scope > .pr-masonry-item'))
                .map((item) => item.getBoundingClientRect().width),
            containerWidth: node.getBoundingClientRect().width,
        }))
        if (mobileMasonryContract.display !== 'grid'
            || mobileMasonryContract.columns !== 1
            || mobileMasonryContract.scrollWidth > mobileMasonryContract.clientWidth + 1
            || mobileMasonryContract.itemWidths.length !== 4
            || mobileMasonryContract.itemWidths.some((width) => width < mobileMasonryContract.containerWidth - 1)) {
            fail(`文化卡片瀑布流未在 390px 降为完整单列或发生横向溢出：${JSON.stringify(mobileMasonryContract)}`)
        } else {
            masonryGridContractChecked = true
        }
        await masonry.screenshot({
            path: path.join(OUTPUT_DIR, 'mobile-culture-masonry-grid.png'),
        })
        await disclosure.scrollIntoViewIfNeeded()
        const mobileGeometry = await page.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            viewportWidth: window.innerWidth,
            summaryRect: document.querySelector('[data-poem-verification-state="INCOMPLETE"] summary')?.getBoundingClientRect().toJSON() ?? null,
        }))
        if (mobileGeometry.scrollWidth > mobileGeometry.viewportWidth
            || !mobileGeometry.summaryRect
            || mobileGeometry.summaryRect.width > mobileGeometry.viewportWidth) {
            fail(`文化语境内容验收披露在移动端溢出：${JSON.stringify(mobileGeometry)}`)
        }
        await page.screenshot({
            path: path.join(OUTPUT_DIR, 'mobile-culture-poem-verification-disclosure.png'),
            fullPage: false,
        })
        culturePoemVerificationDisclosureChecked = true
    } finally {
        await page.close()
    }
}

/**
 * PixelSnow 只表达冬景氛围。本检查使用两首明确标为 E2E 的合成诗，经过真实
 * PoemList → Culture store → CultureContextPage 触发链验证装饰挂载与卸载；
 * 合成诗不构成诗词来源、教材分类、季节判断或教学效果证据。
 */
async function checkPixelSnowDecorationContract(context) {
    activeRoute = 'pixel-snow-decoration-contract'
    const page = await context.newPage()
    const runtimeErrors = []
    const nonWinterPoem = {
        id: 'E2E-CULTURE-NON-WINTER',
        title: 'E2E 清风样本',
        poet: '仅用于界面回归',
        dynasty: '测试',
        content: '界面回归只验证清风与远山。',
        theme: ['测试'],
        rhetoric: [],
        gradeLevel: '三年级',
    }
    const winterPoem = {
        id: 'E2E-CULTURE-WINTER',
        title: 'E2E 雪境样本',
        poet: '仅用于界面回归',
        dynasty: '测试',
        content: '此处含雪字，仅用于验证雪境装饰触发。',
        theme: ['测试'],
        rhetoric: [],
        gradeLevel: '三年级',
    }
    const poems = [nonWinterPoem, winterPoem]

    const installControlledRoutes = async (target) => {
        await target.route('**/api/recitation/poems**', (route) => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ status: 'ok', poems }),
        }))
        await target.route('**/api/poem-content/E2E-CULTURE-*', (route) => {
            const poemId = new URL(route.request().url()).pathname.split('/').pop()
            const poem = poems.find((candidate) => candidate.id === poemId) ?? nonWinterPoem
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    status: 'ok',
                    poemId: poem.id,
                    poemTitle: poem.title,
                    poet: poem.poet,
                    dynasty: poem.dynasty,
                    lines: [{
                        lineIndex: 0,
                        original: poem.content,
                        pinyin: [],
                        translation: '仅用于 PixelSnow 前端触发链回归。',
                        annotations: [],
                    }],
                    characters: [],
                    overallTranslation: 'E2E 受控界面样本，不构成教材内容。',
                    theme: '仅验证装饰触发。',
                    aiGenerated: false,
                    sourceVerification: {
                        status: 'INCOMPLETE',
                        catalogScope: 'UNCLASSIFIED',
                        contentSha256: `E2E-${poem.id}`,
                        reviewedAt: null,
                        sourceTitles: [],
                        message: 'E2E 受控界面样本，未完成教材验收。',
                    },
                    teachingContentReviewStatus: 'NOT_GENERATED',
                }),
            })
        })
        await target.route('**/api/culture/poems/E2E-CULTURE-*/background', (route) => {
            const pathParts = new URL(route.request().url()).pathname.split('/')
            const poemId = pathParts[pathParts.length - 2] ?? nonWinterPoem.id
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    status: 'ok',
                    cached: true,
                    background: {
                        poemId,
                        historical: 'E2E 受控背景。',
                        poet: 'E2E 受控诗人信息。',
                        creation: 'E2E 受控创作语境。',
                        cultural: 'E2E 受控文化内涵。',
                        suggestedImagePrompt: 'E2E UI contract only',
                        aiGenerated: false,
                        generatedAt: 1_700_000_000_000,
                    },
                }),
            })
        })
        await target.route('**/api/culture/poems/E2E-CULTURE-*/images', (route) => {
            const pathParts = new URL(route.request().url()).pathname.split('/')
            const poemId = pathParts[pathParts.length - 2] ?? nonWinterPoem.id
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    status: 'ok',
                    poemId,
                    images: [],
                    aiGenerated: false,
                    cached: true,
                }),
            })
        })
    }

    page.on('pageerror', (error) => runtimeErrors.push(error.message))
    try {
        await page.addInitScript(() => window.localStorage.removeItem('pr-demo-mode'))
        await installControlledRoutes(page)
        await page.setViewportSize({ width: 1440, height: 900 })
        await page.goto(`${BASE_URL}/culture`, { waitUntil: 'domcontentloaded' })
        await waitForSettledPage(page)

        const nonWinterButton = page.getByRole('button', { name: /^E2E 清风样本 / })
        const winterButton = page.getByRole('button', { name: /^E2E 雪境样本 / })
        const snowRoot = page.locator('.pr-culture-main-snow [data-pixel-snow="decorative"]')
        await Promise.all([
            nonWinterButton.waitFor({ state: 'visible', timeout: 15_000 }),
            winterButton.waitFor({ state: 'visible', timeout: 15_000 }),
        ])
        if (await snowRoot.count() !== 0) {
            fail('非冬景受控诗篇错误挂载 PixelSnow')
        }

        await winterButton.click()
        await snowRoot.waitFor({ state: 'visible', timeout: 10_000 })
        await snowRoot.scrollIntoViewIfNeeded()
        const reducedContract = await snowRoot.evaluate((root) => {
            const outer = root.closest('.pr-culture-main-snow')
            const flakes = Array.from(root.querySelectorAll(':scope > [data-snow-flake]'))
            const flakeStyles = flakes.map((flake) => window.getComputedStyle(flake))
            const xValues = new Set(flakes.map((flake) => flake.style.getPropertyValue('--pr-snow-x')))
            const yValues = new Set(flakes.map((flake) => flake.style.getPropertyValue('--pr-snow-y')))
            const resourceNames = performance.getEntriesByType('resource').map((entry) => entry.name.toLowerCase())
            const rect = root.getBoundingClientRect()
            return {
                rootCount: document.querySelectorAll('.pr-culture-main-snow [data-pixel-snow="decorative"]').length,
                renderer: root.getAttribute('data-pixel-snow'),
                variant: root.getAttribute('data-snow-variant'),
                declaredCount: Number(root.getAttribute('data-snow-count')),
                motion: root.getAttribute('data-snow-motion'),
                ariaHidden: root.getAttribute('aria-hidden'),
                outerAriaHidden: outer?.getAttribute('aria-hidden') ?? null,
                role: root.getAttribute('role'),
                tabIndex: root.getAttribute('tabindex'),
                tagNames: flakes.map((flake) => flake.tagName),
                flakeCount: flakes.length,
                distinctX: xValues.size,
                distinctY: yValues.size,
                canvasCount: root.querySelectorAll('canvas').length,
                svgCount: root.querySelectorAll('svg').length,
                interactiveCount: root.querySelectorAll('a, button, input, select, textarea, [tabindex]').length,
                pointerEvents: window.getComputedStyle(root).pointerEvents,
                outerPointerEvents: outer ? window.getComputedStyle(outer).pointerEvents : null,
                display: window.getComputedStyle(root).display,
                outerOpacity: outer ? Number.parseFloat(window.getComputedStyle(outer).opacity) : null,
                animationNames: flakeStyles.map((style) => style.animationName),
                longAnimationCount: root.getAnimations({ subtree: true }).filter((animation) => animation.playState === 'running').length,
                runtimeStyleCount: Array.from(document.head.querySelectorAll('style')).filter((style) => style.textContent?.includes('.pr-pixel-snow')).length,
                threeResourceCount: resourceNames.filter((name) => name.includes('three-vendor')).length,
                width: rect.width,
                height: rect.height,
                rootOverflow: root.scrollWidth > root.clientWidth + 1,
                pageHasHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
                reducedMotionMatches: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
            }
        })
        if (reducedContract.rootCount !== 1
            || reducedContract.renderer !== 'decorative'
            || reducedContract.variant !== 'snowflake'
            || reducedContract.declaredCount !== 29
            || reducedContract.motion !== 'enabled'
            || reducedContract.ariaHidden !== 'true'
            || reducedContract.outerAriaHidden !== 'true'
            || reducedContract.role !== null
            || reducedContract.tabIndex !== null
            || reducedContract.flakeCount !== reducedContract.declaredCount
            || reducedContract.tagNames.some((tag) => tag !== 'SPAN')
            || reducedContract.distinctX < 20
            || reducedContract.distinctY < 20
            || reducedContract.canvasCount !== 0
            || reducedContract.svgCount !== 0
            || reducedContract.interactiveCount !== 0
            || reducedContract.pointerEvents !== 'none'
            || reducedContract.outerPointerEvents !== 'none'
            || reducedContract.display === 'none'
            || reducedContract.outerOpacity !== 0.18
            || reducedContract.animationNames.some((name) => name !== 'none')
            || reducedContract.longAnimationCount !== 0
            || reducedContract.runtimeStyleCount !== 0
            || reducedContract.threeResourceCount !== 0
            || reducedContract.width < 200
            || reducedContract.height < 200
            || reducedContract.rootOverflow
            || reducedContract.pageHasHorizontalOverflow
            || !reducedContract.reducedMotionMatches) {
            fail(`PixelSnow 减弱动态/装饰/几何契约不合格：${JSON.stringify(reducedContract)}`)
        }

        const firstRects = await snowRoot.locator(':scope > [data-snow-flake]').evaluateAll((flakes) => (
            flakes.map((flake) => {
                const rect = flake.getBoundingClientRect()
                return [rect.x, rect.y, rect.width, rect.height]
            })
        ))
        await page.waitForTimeout(400)
        const secondRects = await snowRoot.locator(':scope > [data-snow-flake]').evaluateAll((flakes) => (
            flakes.map((flake) => {
                const rect = flake.getBoundingClientRect()
                return [rect.x, rect.y, rect.width, rect.height]
            })
        ))
        if (JSON.stringify(firstRects) !== JSON.stringify(secondRects)) {
            fail('PixelSnow 在 prefers-reduced-motion: reduce 下仍发生位置变化')
        }
        await snowRoot.screenshot({ path: path.join(OUTPUT_DIR, 'desktop-culture-pixel-snow.png') })

        await page.emulateMedia({ media: 'screen', reducedMotion: 'no-preference', forcedColors: 'none' })
        const motionContract = await snowRoot.evaluate((root) => {
            const flakes = Array.from(root.querySelectorAll(':scope > [data-snow-flake]'))
            const enhancementSupported = CSS.supports('height', '1cqh')
                && window.matchMedia('(hover: hover)').matches
                && window.matchMedia('(pointer: fine)').matches
            return {
                enhancementSupported,
                animationNames: flakes.map((flake) => window.getComputedStyle(flake).animationName),
                durations: flakes.map((flake) => Number.parseFloat(window.getComputedStyle(flake).animationDuration)),
            }
        })
        if (motionContract.enhancementSupported
            && (motionContract.animationNames.every((name) => name !== 'pr-pixel-snow-fall')
                || motionContract.durations.some((duration) => !Number.isFinite(duration) || duration <= 0))) {
            fail(`PixelSnow 桌面渐进动画未按能力门禁启用：${JSON.stringify(motionContract)}`)
        }

        await page.emulateMedia({ media: 'screen', reducedMotion: 'reduce', forcedColors: 'active' })
        if (!await snowRoot.evaluate((root) => (
            window.matchMedia('(forced-colors: active)').matches
            && window.getComputedStyle(root).display === 'none'
        ))) {
            fail('PixelSnow 在 forced-colors 下未隐藏纯装饰层')
        }
        await page.emulateMedia({ media: 'print', reducedMotion: 'reduce', forcedColors: 'none' })
        if (!await snowRoot.evaluate((root) => (
            window.matchMedia('print').matches && window.getComputedStyle(root).display === 'none'
        ))) {
            fail('PixelSnow 在打印媒体下未隐藏纯装饰层')
        }
        await page.emulateMedia({ media: 'screen', reducedMotion: 'reduce', forcedColors: 'none' })

        const touchContext = await context.browser().newContext({
            storageState: await context.storageState(),
            viewport: { width: 390, height: 844 },
            locale: 'zh-CN',
            reducedMotion: 'no-preference',
            hasTouch: true,
            isMobile: true,
        })
        try {
            await installControlledRoutes(touchContext)
            const touchPage = await touchContext.newPage()
            await touchPage.goto(`${BASE_URL}/culture`, { waitUntil: 'domcontentloaded' })
            await waitForSettledPage(touchPage)
            await touchPage.getByRole('button', { name: /^E2E 雪境样本 / }).click()
            const touchSnow = touchPage.locator('.pr-culture-main-snow [data-pixel-snow="decorative"]')
            await touchSnow.waitFor({ state: 'visible', timeout: 10_000 })
            await touchSnow.scrollIntoViewIfNeeded()
            const touchContract = await touchSnow.evaluate((root) => {
                const flakes = Array.from(root.querySelectorAll(':scope > [data-snow-flake]'))
                return {
                    hoverNone: window.matchMedia('(hover: none)').matches,
                    pointerCoarse: window.matchMedia('(pointer: coarse)').matches,
                    animationNames: flakes.map((flake) => window.getComputedStyle(flake).animationName),
                    pointerEvents: window.getComputedStyle(root).pointerEvents,
                    width: root.getBoundingClientRect().width,
                    pageHasHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
                }
            })
            if ((!touchContract.hoverNone && !touchContract.pointerCoarse)
                || touchContract.animationNames.some((name) => name !== 'none')
                || touchContract.pointerEvents !== 'none'
                || touchContract.width > 390
                || touchContract.pageHasHorizontalOverflow) {
                fail(`PixelSnow 真实触控/粗指针静态兜底不合格：${JSON.stringify(touchContract)}`)
            }
            await touchSnow.screenshot({ path: path.join(OUTPUT_DIR, 'mobile-culture-pixel-snow.png') })
        } finally {
            await touchContext.close()
        }

        await nonWinterButton.click()
        await snowRoot.waitFor({ state: 'detached', timeout: 8_000 })

        const sourceBoundary = await fs.readFile(path.resolve('src/components/ui/PixelSnow.tsx'), 'utf8')
        const forbiddenSourcePatterns = [
            /from\s+['"]three['"]/,
            /WebGLRenderer\s*\(/,
            /requestAnimationFrame\s*\(/,
            /IntersectionObserver\s*\(/,
            /ResizeObserver\s*\(/,
            /addEventListener\s*\(/,
            /Math\.random\s*\(/,
            /<canvas\b/i,
            /use(?:Effect|Ref)\s*\(/,
        ]
        const forbiddenMatches = forbiddenSourcePatterns
            .filter((pattern) => pattern.test(sourceBoundary))
            .map((pattern) => pattern.source)
        if (forbiddenMatches.length > 0) {
            fail(`PixelSnow 源码重新引入重图形或运行时副作用：${forbiddenMatches.join(', ')}`)
        }
        if (runtimeErrors.length > 0) {
            fail(`PixelSnow 专项出现浏览器运行时异常：${runtimeErrors.join(' | ')}`)
        }
        pixelSnowDecorationContractChecked = true
    } finally {
        await page.close()
    }
}

/**
 * “减少动态效果”不是仅关闭 CSS 动画：思考宫殿必须在下载 Three.js 之前切换到
 * 完整、可点选的二维审计路径。教师主动开启 3D 后，才允许加载对应的重型渲染包。
 */
async function checkThinkingPalaceLightweightAudit(context) {
    activeRoute = 'thinking-palace-lightweight-audit'
    const page = await context.newPage()
    try {
        const longThinkingQuestion = '比较诗中意象的情感张力，并说明为什么同一前缀的两条推理链不能只由前四十个字符区分。'
        await page.route('**/api/copilot/thinking-chains**', (route) => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                status: 'ok',
                chains: [{
                    id: 'E2E-THINKING-CHAIN-ACCESSIBLE-NAME',
                    agentId: 'copilot',
                    sessionId: 'E2E-THINKING-SESSION',
                    question: longThinkingQuestion,
                    reasoning: '仅用于验证思考链按钮的完整可访问名称。',
                    answer: null,
                    nodes: [{ index: 0, type: 'reasoning', content: '验证完整问题文本。', startOffset: 0, endOffset: 9 }],
                    thinkingMode: 'high',
                    durationMs: 1200,
                    model: 'e2e-controlled-model',
                    promptTokens: 12,
                    completionTokens: 16,
                    createdAt: 1_700_000_000_000,
                    metadata: null,
                }],
                total: 1,
                aiGenerated: false,
            }),
        }))
        await page.setViewportSize({ width: 1440, height: 900 })
        await page.goto(`${BASE_URL}/thinking-palace`, { waitUntil: 'domcontentloaded' })
        await waitForSettledPage(page)
        await page.getByRole('tab', { name: 'AI 推理审计', exact: true }).click()

        const thinkingChainButton = page.getByRole('button', { name: `思考链：${longThinkingQuestion}`, exact: true })
        await thinkingChainButton.waitFor({ state: 'visible', timeout: 10_000 })
        if (await thinkingChainButton.count() !== 1) {
            fail(`思考链按钮必须保留完整且唯一的可访问问题名称，实际数量=${await thinkingChainButton.count()}`)
        }

        const lightView = page.getByTestId('thinking-palace-static-view')
        await lightView.waitFor({ state: 'visible', timeout: 10_000 })
        if (await page.locator('.scene3d-container').count() !== 0) {
            fail('减少动态效果时思考宫殿仍渲染 3D 画布')
        }
        const loadedThreeBeforeOptIn = await page.evaluate(() => performance
            .getEntriesByType('resource')
            .some((entry) => entry.name.includes('three-vendor-')))
        if (loadedThreeBeforeOptIn) {
            fail('轻量二维审计视图在教师主动开启前仍下载了 Three.js 包')
        }
        const enable3D = page.getByTestId('thinking-palace-enable-3d')
        await enable3D.waitFor({ state: 'visible', timeout: 10_000 })
        await page.screenshot({
            path: path.join(OUTPUT_DIR, 'desktop-thinking-palace-lightweight-audit.png'),
            fullPage: false,
        })
        await enable3D.click()
        await lightView.waitFor({ state: 'hidden', timeout: 10_000 })
        await page.waitForFunction(
            () => performance
                .getEntriesByType('resource')
                .some((entry) => entry.name.includes('three-vendor-')),
            undefined,
            { timeout: 10_000 },
        )
        thinkingPalaceLightweightAuditChecked = true
    } finally {
        await page.close()
    }
}

/**
 * 诗境图像是“查看大图”和“下载图片”两个独立操作，不能将链接嵌在 button
 * 语义卡片中。测试以受控图片 API 响应验证卡片的原生控件层级、模块 tab
 * 键盘导航和大图对话框的焦点闭环，并故意注入一张不可用资源验证失败态、重载与
 * 防误导控件。样本只用于 UI 契约，绝不作为生图效果或资源可用性的证据。
 */
async function checkPoemImageCardAccessibility(context) {
    activeRoute = 'poem-image-card-accessibility'
    const page = await context.newPage()
    try {
        await page.setViewportSize({ width: 1440, height: 900 })
        await page.emulateMedia({ reducedMotion: 'reduce' })
        // 复用随包且已通过图像审计的真实 WebP 字节，避免用 SVG 冒充生成图片。
        // 路由仍是完全受控的前端契约夹具，不作为本轮真实 Wan 调用证据。
        const e2eImageBytes = await fs.readFile(
            path.resolve('public', 'images', 'generated', 'starmap', 'tongbian-002.webp'),
        )
        const e2eImageUrl = '/uploads/generated/e2e/controlled-poem-image.webp'
        const e2eBrokenImageUrl = '/uploads/generated/e2e/broken-poem-image.webp'
        let generatedImageRequests = 0
        let brokenImageRequests = 0
        await page.route('**/uploads/generated/e2e/controlled-poem-image.webp**', (route) => route.fulfill({
            status: 200,
            contentType: 'image/webp',
            body: e2eImageBytes,
        }))
        await page.route('**/uploads/generated/e2e/broken-poem-image.webp**', (route) => {
            brokenImageRequests += 1
            // 不能用“503 + 可解码 SVG”：浏览器仍会成功显示 SVG，无法覆盖 img.onerror。
            // 直接中止请求，模拟离线、DNS/CDN 中断等资源层真实失败。
            return route.abort('failed')
        })
        await page.route('**/api/ai/image-generate', (route) => {
            generatedImageRequests += 1
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    status: 'ok',
                    images: [{
                        id: `E2E-POEM-IMAGE-${generatedImageRequests}`,
                        url: generatedImageRequests === 1 ? e2eImageUrl : e2eBrokenImageUrl,
                        prompt: 'E2E controlled image prompt',
                        verse: 'E2E 图像交互契约',
                        orientation: 'landscape',
                        model: 'wan2.7-image',
                        requestedModel: 'wan2.7-image',
                        createdAt: Date.now(),
                        cached: false,
                        aiGenerated: true,
                        demo: false,
                        degraded: false,
                    }],
                    model: 'wan2.7-image',
                    requestedModel: 'wan2.7-image',
                    aiGenerated: true,
                    demo: false,
                    degraded: false,
                }),
            })
        })
        await page.goto(`${BASE_URL}/thinking-palace`, { waitUntil: 'domcontentloaded' })
        await waitForSettledPage(page)

        const topViewTablist = page.getByRole('tablist', { name: '思考宫殿视图', exact: true })
        await topViewTablist.waitFor({ state: 'visible', timeout: 10_000 })
        const poemViewTab = topViewTablist.getByRole('tab', { name: '诗篇重构', exact: true })
        const aiViewTab = topViewTablist.getByRole('tab', { name: 'AI 推理审计', exact: true })
        const topViewContract = await topViewTablist.evaluate((tablist) => {
            const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'))
            const selected = tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true')
            const focusable = tabs.filter((tab) => tab.getAttribute('tabindex') === '0')
            const active = selected[0]
            const panelId = active?.getAttribute('aria-controls')
            const panel = panelId ? document.getElementById(panelId) : null
            return {
                tabCount: tabs.length,
                selectedCount: selected.length,
                focusableCount: focusable.length,
                activeId: active?.id ?? null,
                activeControl: active?.getAttribute('aria-controls') ?? null,
                panelRole: panel?.getAttribute('role') ?? null,
                panelLabelledBy: panel?.getAttribute('aria-labelledby') ?? null,
            }
        })
        if (topViewContract.tabCount !== 2
            || topViewContract.selectedCount !== 1
            || topViewContract.focusableCount !== 1
            || !topViewContract.activeControl
            || topViewContract.panelRole !== 'tabpanel'
            || topViewContract.panelLabelledBy !== topViewContract.activeId) {
            fail(`思考宫殿顶层视图 Tab 与面板的可访问性关联不完整：${JSON.stringify(topViewContract)}`)
        }
        await poemViewTab.focus()
        await poemViewTab.press('ArrowRight')
        await page.waitForFunction(() => {
            const tab = document.querySelector('[data-thinking-palace-view-tab="ai"]')
            const panel = document.getElementById(tab?.getAttribute('aria-controls') ?? '')
            return tab?.getAttribute('aria-selected') === 'true' && panel?.getAttribute('aria-labelledby') === tab.id
        })
        await aiViewTab.press('Home')
        await page.waitForFunction(() => document.querySelector('[data-thinking-palace-view-tab="poem"]')?.getAttribute('aria-selected') === 'true')

        const moduleTablist = page.getByRole('tablist', { name: '诗篇重构 AI 模块', exact: true })
        await moduleTablist.waitFor({ state: 'visible', timeout: 10_000 })
        const routeTab = moduleTablist.getByRole('tab', { name: /诗篇思考路线/ })
        const advisorTab = moduleTablist.getByRole('tab', { name: /AI 重构顾问/ })
        const imageTab = moduleTablist.getByRole('tab', { name: /AI 诗境生图/ })
        const recitationTab = moduleTablist.getByRole('tab', { name: /AI 朗诵评分/ })
        const tabContract = await moduleTablist.evaluate((tablist) => {
            const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'))
            const selected = tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true')
            const focusable = tabs.filter((tab) => tab.getAttribute('tabindex') === '0')
            const active = selected[0]
            const panelId = active?.getAttribute('aria-controls')
            const panel = panelId ? document.getElementById(panelId) : null
            return {
                tabCount: tabs.length,
                selectedCount: selected.length,
                focusableCount: focusable.length,
                activeId: active?.id ?? null,
                panelRole: panel?.getAttribute('role') ?? null,
                panelLabelledBy: panel?.getAttribute('aria-labelledby') ?? null,
            }
        })
        if (tabContract.tabCount !== 4
            || tabContract.selectedCount !== 1
            || tabContract.focusableCount !== 1
            || tabContract.panelRole !== 'tabpanel'
            || tabContract.panelLabelledBy !== tabContract.activeId) {
            fail(`诗篇模块 Tab 与面板的可访问性关联不完整：${JSON.stringify(tabContract)}`)
        }
        const routeList = page.getByRole('list', { name: '诗篇思考路线', exact: true })
        await routeList.waitFor({ state: 'visible', timeout: 10_000 })
        const routeContract = await routeList.evaluate((list) => {
            const entries = Array.from(list.children)
            return {
                listTag: list.tagName,
                itemCount: entries.length,
                itemTags: entries.map((item) => item.tagName),
                everyItemContainsNativeButton: entries.every((item) => item.querySelector(':scope > button[type="button"]')?.tagName === 'BUTTON'),
                overriddenButtonRoles: list.querySelectorAll('button[role="listitem"]').length,
            }
        })
        if (routeContract.listTag !== 'OL'
            || routeContract.itemCount < 1
            || routeContract.itemTags.some((tag) => tag !== 'LI')
            || !routeContract.everyItemContainsNativeButton
            || routeContract.overriddenButtonRoles !== 0) {
            fail(`诗篇思考路线没有保留原生列表与按钮语义：${JSON.stringify(routeContract)}`)
        }
        await routeTab.focus()
        await routeTab.press('ArrowRight')
        await page.waitForFunction(() => document.querySelector('[data-poem-module-tab="advisor"]')?.getAttribute('aria-selected') === 'true')
        await advisorTab.press('End')
        await page.waitForFunction(() => document.querySelector('[data-poem-module-tab="recitation"]')?.getAttribute('aria-selected') === 'true')
        await recitationTab.press('Home')
        await page.waitForFunction(() => document.querySelector('[data-poem-module-tab="route"]')?.getAttribute('aria-selected') === 'true')
        await imageTab.click()

        const imageGenerator = page.locator('section[aria-label="AI 诗境生图"]')
        await imageGenerator.waitFor({ state: 'visible', timeout: 10_000 })
        await imageGenerator.getByRole('button', { name: '生成插画', exact: true }).click()
        const imageList = imageGenerator.getByRole('list')
        await imageList.waitFor({ state: 'visible', timeout: 10_000 })
        const imageCard = imageList.getByRole('listitem').first()
        const openButton = imageCard.getByRole('button', { name: /查看大图 1/ })
        const downloadLink = imageCard.getByRole('link', { name: '下载图片', exact: true })
        await Promise.all([
            openButton.waitFor({ state: 'visible', timeout: 10_000 }),
            downloadLink.waitFor({ state: 'visible', timeout: 10_000 }),
        ])
        const cardContract = await imageCard.evaluate((card) => {
            const previewControl = card.querySelector('.poem-image-card__open')
            const downloadControl = card.querySelector('.poem-image-card__action')
            return {
                itemRole: card.getAttribute('role'),
                visualOpacity: Number.parseFloat(getComputedStyle(card).opacity),
                previewIsNativeButton: previewControl?.tagName === 'BUTTON',
                previewContainsLink: card.querySelector('.poem-image-card__open a') !== null,
                downloadIsSibling: Boolean(previewControl && downloadControl && previewControl.parentElement === downloadControl.parentElement?.parentElement),
            }
        })
        if (generatedImageRequests < 1
            || cardContract.itemRole !== 'listitem'
            || cardContract.visualOpacity < 0.99
            || !cardContract.previewIsNativeButton
            || cardContract.previewContainsLink
            || !cardContract.downloadIsSibling) {
            fail(`诗境图片卡片没有在减少动态下保持可见的独立查看/下载控件语义：${JSON.stringify({ generatedImageRequests, cardContract })}`)
        }

        await openButton.focus()
        await openButton.press('Enter')
        const dialog = page.getByRole('dialog', { name: '图片大图查看', exact: true })
        const closeButton = dialog.getByRole('button', { name: '关闭', exact: true })
        const dialogDownload = dialog.getByRole('link', { name: '下载图片', exact: true })
        await Promise.all([
            dialog.waitFor({ state: 'visible', timeout: 10_000 }),
            closeButton.waitFor({ state: 'visible', timeout: 10_000 }),
            dialogDownload.waitFor({ state: 'visible', timeout: 10_000 }),
        ])
        const lightboxViewportContract = await dialog.evaluate((node) => {
            const rect = node.getBoundingClientRect()
            const topLeft = document.elementFromPoint(2, 2)
            return {
                parentIsBody: node.parentElement === document.body,
                position: getComputedStyle(node).position,
                left: rect.left,
                top: rect.top,
                right: rect.right,
                bottom: rect.bottom,
                viewportWidth: window.innerWidth,
                viewportHeight: window.innerHeight,
                topLeftBlockedByDialog: topLeft === node || Boolean(topLeft?.closest('.poem-image-lightbox')),
                bodyOverflow: document.body.style.overflow,
            }
        })
        if (!lightboxViewportContract.parentIsBody
            || lightboxViewportContract.position !== 'fixed'
            || Math.abs(lightboxViewportContract.left) > 1
            || Math.abs(lightboxViewportContract.top) > 1
            || Math.abs(lightboxViewportContract.right - lightboxViewportContract.viewportWidth) > 1
            || Math.abs(lightboxViewportContract.bottom - lightboxViewportContract.viewportHeight) > 1
            || !lightboxViewportContract.topLeftBlockedByDialog
            || lightboxViewportContract.bodyOverflow !== 'hidden') {
            fail(`诗境大图未通过 Portal 覆盖完整视口或未锁定背景：${JSON.stringify(lightboxViewportContract)}`)
        }
        await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '关闭', undefined, { timeout: 3_000 })
        await closeButton.press('Shift+Tab')
        if (!await dialogDownload.evaluate((element) => document.activeElement === element)) {
            fail('诗境大图对话框 Shift+Tab 未被限制在对话框的最后一个控件')
        }
        await dialogDownload.press('Tab')
        if (!await closeButton.evaluate((element) => document.activeElement === element)) {
            fail('诗境大图对话框 Tab 未回到第一个控件')
        }
        await page.screenshot({
            path: path.join(OUTPUT_DIR, 'desktop-thinking-palace-image-card-accessibility.png'),
            fullPage: false,
        })
        await page.keyboard.press('Escape')
        await dialog.waitFor({ state: 'hidden', timeout: 10_000 })
        await page.waitForFunction(
            () => document.activeElement?.getAttribute('aria-label')?.startsWith('查看大图 1：') === true,
            undefined,
            { timeout: 3_000 },
        )
        if (!await openButton.evaluate((element) => document.activeElement === element)) {
            fail('诗境大图关闭后焦点未回到原图片查看按钮')
        }

        // 第二次受控生成返回一个契约合法但资源层中断的 WebP 路径：接口成功不能掩盖
        // 资源失败，卡片必须终止骨架、
        // 禁止继续打开/下载失效资源，并提供真实的 HTTP(S) 重载请求。
        await imageGenerator.getByRole('button', { name: '重新生成', exact: true }).click()
        const failedCard = imageList.getByRole('listitem').first()
        const failureStatus = failedCard.getByRole('status')
        await failureStatus.waitFor({ state: 'visible', timeout: 10_000 })
        const failedOpenButton = failedCard.getByRole('button', { name: /插画 1 加载失败/ })
        const reloadButton = failedCard.getByRole('button', { name: '重新加载图片', exact: true })
        const failedDownload = failedCard.getByRole('link', { name: '下载图片', exact: true })
        const failedCardContract = {
            generatedImageRequests,
            brokenImageRequests,
            previewDisabled: await failedOpenButton.isDisabled(),
            reloadVisible: await reloadButton.isVisible(),
            downloadCount: await failedDownload.count(),
            failureMessage: await failureStatus.textContent(),
            visualOpacity: await failedCard.evaluate((card) => Number.parseFloat(getComputedStyle(card).opacity)),
        }
        if (failedCardContract.generatedImageRequests < 2
            || failedCardContract.brokenImageRequests < 1
            || !failedCardContract.previewDisabled
            || !failedCardContract.reloadVisible
            || failedCardContract.downloadCount !== 0
            || failedCardContract.visualOpacity < 0.99
            || !failedCardContract.failureMessage?.includes('插画加载失败')) {
            fail(`诗境图片资源失败时没有在减少动态下保持可见的可恢复、无误导失败态：${JSON.stringify(failedCardContract)}`)
        }
        const retryRequest = page.waitForRequest((request) => request.url().includes('broken-poem-image.webp')
            && request.url().includes('_prImageRetry=1'), { timeout: 10_000 })
        await Promise.all([
            retryRequest,
            reloadButton.click(),
        ])
        await failureStatus.waitFor({ state: 'visible', timeout: 10_000 })
        if (brokenImageRequests < 2) {
            fail(`诗境图片失败态的“重新加载”没有发起新的 HTTP(S) 资源请求：${JSON.stringify({ brokenImageRequests })}`)
        }
        await failedCard.scrollIntoViewIfNeeded()
        await page.screenshot({
            path: path.join(OUTPUT_DIR, 'desktop-thinking-palace-image-load-failure.png'),
            fullPage: false,
        })
        poemImageCardAccessibilityChecked = true
    } finally {
        await page.close()
    }
}

/**
 * 诗脉星图的默认主界面必须始终是 33 号参考对应的受控 OGL 旋转画廊。
 * 减少动态效果只允许停止自动动画，不能擅自把产品切成目录、替换布局或更换图片。
 * 可访问目录仍作为教师主动选择的辅助视图保留；该检查同时覆盖导航抽屉、
 * 观星舱隔离、单 Canvas、零 Three.js 与目录往返不丢失主界面的资源边界。
 */
async function checkStarMapLightweightView(context) {
    activeRoute = 'starmap-default-reference-33-view'
    const page = await context.newPage()
    try {
        await page.setViewportSize({ width: 1440, height: 900 })
        await page.goto(`${BASE_URL}/starmap`, { waitUntil: 'domcontentloaded' })
        await waitForSettledPage(page)

        // 星图采用沉浸式壳层。离屏抽屉若只做 transform，会残留 dialog 语义与 Tab 停靠；
        // 因此先在真实路由验证关闭态隔离、打开后的焦点边界，以及遮罩关闭的回焦。
        const navigationMenu = page.getByRole('button', { name: '打开导航菜单', exact: true })
        const closedDrawer = page.locator('#pr-immersive-drawer')
        await navigationMenu.waitFor({ state: 'visible', timeout: 10_000 })
        const closedDrawerContract = await closedDrawer.evaluate((drawer) => ({
            role: drawer.getAttribute('role'),
            ariaModal: drawer.getAttribute('aria-modal'),
            ariaHidden: drawer.getAttribute('aria-hidden'),
            visibility: window.getComputedStyle(drawer).visibility,
        }))
        if (closedDrawerContract.role !== null
            || closedDrawerContract.ariaModal !== null
            || closedDrawerContract.ariaHidden !== 'true'
            || closedDrawerContract.visibility !== 'hidden') {
            fail(`沉浸导航关闭态仍暴露对话框或焦点入口：${JSON.stringify(closedDrawerContract)}`)
        }
        await navigationMenu.focus()
        await navigationMenu.press('Enter')
        const navigationDrawer = page.getByRole('dialog', { name: '页面导航', exact: true })
        await navigationDrawer.waitFor({ state: 'visible', timeout: 5_000 })
        const drawerClose = navigationDrawer.getByRole('button', { name: '关闭导航菜单', exact: true })
        await page.waitForFunction(() => document.activeElement?.classList.contains('pr-immersive-drawer-close') === true, undefined, { timeout: 5_000 })
        const drawerLinks = navigationDrawer.locator('a')
        const lastDrawerLink = drawerLinks.last()
        const lastDrawerHref = await lastDrawerLink.getAttribute('href')
        if (!lastDrawerHref) {
            fail('沉浸导航抽屉缺少可验证的末尾导航链接')
        } else {
            await drawerClose.press('Shift+Tab')
            await page.waitForFunction((href) => document.activeElement?.getAttribute('href') === href, lastDrawerHref, { timeout: 5_000 })
            await lastDrawerLink.press('Tab')
            await page.waitForFunction(() => document.activeElement?.classList.contains('pr-immersive-drawer-close') === true, undefined, { timeout: 5_000 })
        }
        await navigationDrawer.screenshot({
            path: path.join(OUTPUT_DIR, 'desktop-immersive-navigation-drawer-accessibility.png'),
        })
        await page.locator('.pr-immersive-drawer-overlay').click({ position: { x: 1_400, y: 8 } })
        await page.waitForFunction(() => document.querySelector('#pr-immersive-drawer')?.getAttribute('role') === null, undefined, { timeout: 5_000 })
        await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '打开导航菜单', undefined, { timeout: 5_000 })

        await page.setViewportSize({ width: 390, height: 844 })
        await navigationMenu.click()
        await navigationDrawer.waitFor({ state: 'visible', timeout: 5_000 })
        const mobileDrawerGeometry = await navigationDrawer.evaluate((drawer) => {
            const drawerRect = drawer.getBoundingClientRect()
            const closeRect = drawer.querySelector('.pr-immersive-drawer-close')?.getBoundingClientRect()
            return {
                pageWidth: document.documentElement.scrollWidth,
                viewportWidth: window.innerWidth,
                drawerWidth: drawerRect.width,
                closeWidth: closeRect?.width ?? 0,
                closeHeight: closeRect?.height ?? 0,
            }
        })
        if (mobileDrawerGeometry.pageWidth > mobileDrawerGeometry.viewportWidth + 1
            || mobileDrawerGeometry.drawerWidth > mobileDrawerGeometry.viewportWidth * 0.8 + 1
            || mobileDrawerGeometry.closeWidth < 40
            || mobileDrawerGeometry.closeHeight < 40) {
            fail(`沉浸导航抽屉移动端出现横向溢出、超宽或关闭控件过小：${JSON.stringify(mobileDrawerGeometry)}`)
        }
        await navigationDrawer.screenshot({
            path: path.join(OUTPUT_DIR, 'mobile-immersive-navigation-drawer-accessibility.png'),
        })
        await page.locator('.pr-immersive-drawer-overlay').click({ position: { x: 380, y: 8 } })
        await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '打开导航菜单', undefined, { timeout: 5_000 })
        await page.setViewportSize({ width: 1440, height: 900 })
        immersiveDrawerAccessibilityChecked = true

        const flyingPosters = page.locator(
            '.pr-sm-dome .pr-flying-posters[data-flying-posters="ogl"]',
        )
        await flyingPosters.waitFor({ state: 'visible', timeout: 10_000 })
        await page.waitForFunction(() => {
            const root = document.querySelector('.pr-sm-dome .pr-flying-posters[data-flying-posters="ogl"]')
            return ['ready', 'fallback'].includes(root?.getAttribute('data-renderer-state') ?? '')
        }, undefined, { timeout: 10_000 })
        const defaultViewAction = page.getByTestId('starmap-toggle-immersive-view')
        await defaultViewAction.waitFor({ state: 'visible', timeout: 10_000 })
        const defaultGalleryContract = await flyingPosters.evaluate((root) => ({
            reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
            actionLabel: document.querySelector('[data-testid="starmap-toggle-immersive-view"]')
                ?.getAttribute('aria-label') ?? null,
            canvasCount: root.querySelectorAll('canvas').length,
            renderer: root.getAttribute('data-renderer-state'),
            runningAnimations: root.getAnimations({ subtree: true })
                .filter((animation) => animation.playState === 'running').length,
            lightweightNoteCount: document.querySelectorAll('[data-testid="starmap-lightweight-view-note"]').length,
        }))
        if (!defaultGalleryContract.reducedMotion
            || defaultGalleryContract.actionLabel !== '打开星体目录'
            || defaultGalleryContract.canvasCount !== 1
            || !['ready', 'fallback'].includes(defaultGalleryContract.renderer)
            || defaultGalleryContract.runningAnimations !== 0
            || defaultGalleryContract.lightweightNoteCount !== 0) {
            fail(`33号诗脉星图没有作为减少动态环境的稳定默认主界面：${JSON.stringify(defaultGalleryContract)}`)
        }
        // 观星舱在桌面和移动端都采用按需抽屉，避免覆盖 33 号画廊。关闭态必须
        // aria-hidden + inert，打开后才可见可聚焦，关闭后焦点回到原触发按钮。
        const openSidebar = page.getByRole('button', { name: '打开观星舱', exact: true })
        const sidebarNode = page.locator('#pr-sm-sidebar')
        const closedSidebarContract = await sidebarNode.evaluate((sidebar) => ({
            ariaHidden: sidebar.getAttribute('aria-hidden'),
            inert: sidebar.hasAttribute('inert'),
            visibility: getComputedStyle(sidebar).visibility,
        }))
        if (closedSidebarContract.ariaHidden !== 'true'
            || !closedSidebarContract.inert
            || closedSidebarContract.visibility !== 'hidden') {
            fail(`观星舱关闭态没有完整隔离：${JSON.stringify(closedSidebarContract)}`)
        }
        await openSidebar.click()
        await page.waitForFunction(() => {
            const sidebar = document.querySelector('#pr-sm-sidebar')
            return sidebar?.getAttribute('aria-hidden') === 'false'
                && !sidebar.hasAttribute('inert')
                && getComputedStyle(sidebar).visibility === 'visible'
        }, undefined, { timeout: 5_000 })
        const desktopSidebarContract = await sidebarNode.evaluate((sidebar) => ({
            ariaHidden: sidebar.getAttribute('aria-hidden'),
            inert: sidebar.hasAttribute('inert'),
            focusables: sidebar.querySelectorAll('button, input, a[href], [tabindex]:not([tabindex="-1"])').length,
            visibility: getComputedStyle(sidebar).visibility,
            width: sidebar.getBoundingClientRect().width,
        }))
        if (desktopSidebarContract.ariaHidden !== 'false'
            || desktopSidebarContract.inert
            || desktopSidebarContract.focusables === 0
            || desktopSidebarContract.visibility !== 'visible'
            || desktopSidebarContract.width < 240) {
            fail(`桌面观星舱被错误隐藏或隔离：${JSON.stringify(desktopSidebarContract)}`)
        }
        await verifyRovingTablist(page, {
            tablistName: '节点分类浏览',
            dataAttribute: 'data-starmap-sidebar-tab',
            expectedValues: ['poems', 'images', 'relations'],
            boundary: '诗脉星图目录分类',
        })
        const closeSidebar = page
            .getByRole('complementary', { name: '星图导航侧边栏', exact: true })
            .getByRole('button', { name: '关闭观星舱', exact: true })
        await closeSidebar.click()
        await page.waitForFunction(() => (
            document.querySelector('#pr-sm-sidebar')?.getAttribute('aria-hidden') === 'true'
            && document.querySelector('#pr-sm-sidebar')?.hasAttribute('inert')
            && document.activeElement?.getAttribute('aria-label') === '打开观星舱'
        ), undefined, { timeout: 5_000 })
        if (await page.locator('.scene3d-container').count() !== 0) {
            fail('33号诗脉星图重新引入了旧 Three.js 场景容器')
        }
        const loadedThreeOnDefaultView = await page.evaluate(() => performance
            .getEntriesByType('resource')
            .some((entry) => entry.name.includes('three-vendor-')))
        if (loadedThreeOnDefaultView) {
            fail('33号诗脉星图默认主界面下载了 Three.js 包')
        }
        await page.screenshot({
            path: path.join(OUTPUT_DIR, 'desktop-starmap-default-reference-33.png'),
            fullPage: false,
        })

        await defaultViewAction.click()
        const listView = page.locator('.pr-sm-universe .pr-sm-list')
        await listView.waitFor({ state: 'visible', timeout: 10_000 })
        await flyingPosters.waitFor({ state: 'hidden', timeout: 10_000 })
        if (await defaultViewAction.getAttribute('aria-label') !== '返回诗境穹顶') {
            fail('星体目录没有提供返回 33 号诗境穹顶的明确入口')
        }
        await defaultViewAction.click()
        await flyingPosters.waitFor({ state: 'visible', timeout: 10_000 })
        await page.waitForTimeout(300)
        const restoredResourceBoundary = await page.evaluate(() => ({
            loadedThree: performance
                .getEntriesByType('resource')
                .some((entry) => entry.name.includes('three-vendor-')),
            canvasCount: document.querySelectorAll('.pr-sm-dome canvas').length,
            renderer: document.querySelector('.pr-sm-dome .pr-flying-posters')
                ?.getAttribute('data-renderer-state') ?? null,
            actionLabel: document.querySelector('[data-testid="starmap-toggle-immersive-view"]')
                ?.getAttribute('aria-label') ?? null,
        }))
        if (restoredResourceBoundary.loadedThree
            || restoredResourceBoundary.canvasCount !== 1
            || !['ready', 'fallback'].includes(restoredResourceBoundary.renderer)
            || restoredResourceBoundary.actionLabel !== '打开星体目录') {
            fail(`星图目录往返后没有稳定恢复 33 号主界面：${JSON.stringify(restoredResourceBoundary)}`)
        }
        starMapLightweightViewChecked = true
    } finally {
        await page.close()
    }
}

/**
 * 空版本谱系是没有持久化版本的真实状态，不应启动无意义的 Three.js 画布，
 * 更不能用看似丰富的伪节点填充。此检查固定三个真实数据端点为合法空集合，
 * 验证页面给出可执行的证据路径且不会下载重型 3D 分包。
 */
async function checkEvolutionEmptyEvidence(context) {
    activeRoute = 'evolution-empty-evidence'
    const page = await context.newPage()
    try {
        await page.setViewportSize({ width: 1440, height: 900 })
        await page.route('**/api/evolution/genealogy', (route) => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ nodes: [], edges: [], agentIds: [], aiGenerated: false }),
        }))
        await page.route('**/api/evolution/patterns?*', (route) => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ patterns: [], aiGenerated: false }),
        }))
        await page.route('**/api/evolution/ab-tests', (route) => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ active: [], history: [], threshold: 0.05, minSamples: 8, aiGenerated: false }),
        }))
        await page.goto(`${BASE_URL}/evolution-eye`, { waitUntil: 'domcontentloaded' })
        await waitForSettledPage(page)

        // 顶层“学生成长 / AI 进化”即使数据为空也必须保持完整 tab 契约；
        // 内层四个 AI Tab 同样需要可关联的面板、roving tabindex 和键盘漫游。
        const objectTabs = page.getByRole('tablist', { name: '进化对象', exact: true })
        const objectTabButtons = objectTabs.getByRole('tab')
        await page.waitForFunction(() => document.querySelectorAll('[data-evolution-eye-view-tab]').length === 2, undefined, { timeout: 10_000 })
        const objectTabContract = await objectTabButtons.evaluateAll((tabs) => tabs.map((tab) => ({
            id: tab.id,
            controls: tab.getAttribute('aria-controls'),
            selected: tab.getAttribute('aria-selected'),
            tabIndex: tab.getAttribute('tabindex'),
        })))
        if (objectTabContract.length !== 2
            || objectTabContract.some((tab) => !tab.id || !tab.controls)
            || objectTabContract.filter((tab) => tab.selected === 'true' && tab.tabIndex === '0').length !== 1) {
            fail('进化之眼顶层视图切换缺少唯一选中项、roving tabindex 或面板关联')
        }
        await objectTabButtons.nth(1).focus()
        await page.keyboard.press('Home')
        await page.waitForFunction(() => {
            const tab = document.querySelector('[data-evolution-eye-view-tab="student"]')
            const panel = tab?.getAttribute('aria-controls') ? document.getElementById(tab.getAttribute('aria-controls')) : null
            return tab?.getAttribute('aria-selected') === 'true'
                && document.activeElement === tab
                && panel?.getAttribute('aria-labelledby') === tab.id
        }, undefined, { timeout: 5_000 })
        await page.keyboard.press('End')
        await page.waitForFunction(() => {
            const tab = document.querySelector('[data-evolution-eye-view-tab="ai"]')
            const panel = tab?.getAttribute('aria-controls') ? document.getElementById(tab.getAttribute('aria-controls')) : null
            return tab?.getAttribute('aria-selected') === 'true'
                && document.activeElement === tab
                && panel?.getAttribute('aria-labelledby') === tab.id
        }, undefined, { timeout: 5_000 })

        const aiTabs = page.getByRole('tablist', { name: 'AI 进化视图 Tab', exact: true })
        const aiTabButtons = aiTabs.getByRole('tab')
        await page.waitForFunction(() => document.querySelectorAll('[data-ai-evolution-tab]').length === 4, undefined, { timeout: 10_000 })
        const aiTabContract = await aiTabButtons.evaluateAll((tabs) => tabs.map((tab) => ({
            id: tab.id,
            controls: tab.getAttribute('aria-controls'),
            selected: tab.getAttribute('aria-selected'),
            tabIndex: tab.getAttribute('tabindex'),
        })))
        if (aiTabContract.length !== 4
            || aiTabContract.some((tab) => !tab.id || !tab.controls)
            || aiTabContract.filter((tab) => tab.selected === 'true' && tab.tabIndex === '0').length !== 1) {
            fail('AI 进化侧栏标签缺少唯一选中项、roving tabindex 或面板关联')
        }
        await aiTabButtons.nth(0).focus()
        await page.keyboard.press('End')
        await page.waitForFunction(() => {
            const tab = document.querySelector('[data-ai-evolution-tab="predict"]')
            const panel = tab?.getAttribute('aria-controls') ? document.getElementById(tab.getAttribute('aria-controls')) : null
            return tab?.getAttribute('aria-selected') === 'true'
                && document.activeElement === tab
                && panel?.getAttribute('aria-labelledby') === tab.id
        }, undefined, { timeout: 5_000 })
        await page.keyboard.press('Home')
        await page.waitForFunction(() => {
            const tab = document.querySelector('[data-ai-evolution-tab="genealogy"]')
            return tab?.getAttribute('aria-selected') === 'true' && document.activeElement === tab
        }, undefined, { timeout: 5_000 })

        const emptyState = page.getByRole('region', { name: '进化之眼基因谱' })
        const title = page.getByRole('heading', { name: '尚未形成可审计的 AI 版本谱系', exact: true })
        const evidenceAction = page.getByRole('button', { name: '查看 AI 运行证据', exact: true })
        const refreshAction = page.getByRole('button', { name: '刷新已保存证据', exact: true })
        const patternsAction = page.getByRole('button', { name: '查看模式采集条件', exact: true })
        await Promise.all([
            emptyState.waitFor({ state: 'visible', timeout: 10_000 }),
            title.waitFor({ state: 'visible', timeout: 10_000 }),
            evidenceAction.waitFor({ state: 'visible', timeout: 10_000 }),
            refreshAction.waitFor({ state: 'visible', timeout: 10_000 }),
            patternsAction.waitFor({ state: 'visible', timeout: 10_000 }),
        ])
        const stateText = await emptyState.innerText()
        if (!stateText.includes('不会因为访问页面、单次任务或演示模式而虚构候选')
            || !stateText.includes('达到触发条件才生成候选')) {
            fail('进化之眼空态未披露禁止伪造、条件触发的真实证据边界')
        }
        const threeBefore = await page.evaluate(() => performance.getEntriesByType('resource')
            .map((entry) => entry.name)
            .filter((url) => /three-vendor|Genealogy3D/u.test(url)))
        if (threeBefore.length > 0) {
            fail(`空版本谱系仍下载了无意义的 3D 资源：${threeBefore.join(', ')}`)
        }

        const refreshResponses = Promise.all([
            page.waitForResponse((response) => new URL(response.url()).pathname === '/api/evolution/genealogy', { timeout: 10_000 }),
            page.waitForResponse((response) => new URL(response.url()).pathname === '/api/evolution/patterns', { timeout: 10_000 }),
            page.waitForResponse((response) => new URL(response.url()).pathname === '/api/evolution/ab-tests', { timeout: 10_000 }),
        ])
        await refreshAction.click()
        const refreshed = await refreshResponses
        if (refreshed.some((response) => response.status() !== 200)) {
            fail('进化之眼刷新已保存证据未完成三个数据源的成功重读')
        }
        await title.waitFor({ state: 'visible', timeout: 10_000 })

        await patternsAction.click()
        const patternPanel = page.getByRole('region', { name: '进化模式列表' })
        await page.getByRole('heading', { name: '进化模式', exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
        await page.getByText('暂无进化模式', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
        const patternPanelText = await patternPanel.innerText()
        if (!patternPanelText.includes('浏览页面、单次任务或演示模式不会新增记录。')
            || !patternPanelText.includes('教师纠正被确认')
            || !patternPanelText.includes('验证结果明确否决')) {
            fail('进化模式空态未说明持久化信号边界和三个真实采集来源')
        }
        const patternRefreshAction = patternPanel.getByRole('button', { name: '刷新已保存证据', exact: true })
        const patternEvidenceAction = patternPanel.getByRole('button', { name: '查看 AI 运行证据', exact: true })
        await Promise.all([
            patternRefreshAction.waitFor({ state: 'visible', timeout: 10_000 }),
            patternEvidenceAction.waitFor({ state: 'visible', timeout: 10_000 }),
        ])
        await page.screenshot({
            path: path.join(OUTPUT_DIR, 'desktop-evolution-eye-empty-evidence.png'),
            fullPage: false,
        })
        const patternRefreshResponses = Promise.all([
            page.waitForResponse((response) => new URL(response.url()).pathname === '/api/evolution/genealogy', { timeout: 10_000 }),
            page.waitForResponse((response) => new URL(response.url()).pathname === '/api/evolution/patterns', { timeout: 10_000 }),
            page.waitForResponse((response) => new URL(response.url()).pathname === '/api/evolution/ab-tests', { timeout: 10_000 }),
        ])
        await patternRefreshAction.click()
        const patternRefreshed = await patternRefreshResponses
        if (patternRefreshed.some((response) => response.status() !== 200)) {
            fail('进化模式空态的刷新已保存证据未重读全部三个数据源')
        }
        await Promise.all([
            page.waitForURL('**/ai-copilot', { timeout: 10_000 }),
            patternEvidenceAction.click(),
        ])
        evolutionEmptyEvidenceChecked = true
    } finally {
        await page.close()
    }
}

/**
 * 匿名分享必须从生产同源 URL 直接进入，且不触发认证树、Cookie、Referer、
 * 本地 token 持久化或主 DOM HTML 注入。受控公开报告只验证前端隐私、安全、
 * 响应式与媒体降级契约，不代表报告内容、脱敏质量或公网 TLS 已经通过验收。
 */
async function checkPublicReportSharingContract(browser) {
    activeRoute = 'public-report-sharing-contract'
    const validToken = 'E2E_public_share_token_20260810_abcdefghijkl'
    const unavailableToken = 'E2E_unavailable_share_token_20260810_abcdef'
    const networkToken = 'E2E_network_retry_share_token_20260810_abcdef'
    const invalidToken = 'E2E_invalid_payload_share_token_20260810_abcdef'
    const expiredToken = 'E2E_expired_share_token_20260810_abcdefgh'
    const allTokens = [validToken, unavailableToken, networkToken, invalidToken, expiredToken]
    const now = Date.now()
    const controlledPhrase = 'E2E 公开正文只允许出现在隔离文档中。'
    const publicPayload = {
        status: 'ok',
        shared: {
            className: 'E2E 脱敏教研班',
            title: 'E2E 匿名公开报告',
            contentHtml: `<h1>公开内容验收</h1><p>${controlledPhrase}</p><blockquote>不含学生身份字段</blockquote><ul><li>聚合结论</li></ul>`,
            createdAt: now - 3_600_000,
            expireAt: now + 86_400_000,
        },
        aiGenerated: true,
    }
    const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        locale: 'zh-CN',
        reducedMotion: 'reduce',
    })
    const page = await context.newPage()
    const authSideEffectRequests = []
    const publicRequestHeaders = []
    const consoleMessages = []
    const runtimeErrors = []
    let networkAttempts = 0

    page.on('request', (request) => {
        const url = new URL(request.url())
        if (url.pathname === '/api/auth/status'
            || url.pathname === '/api/health'
            || url.pathname.startsWith('/api/auth/')) {
            authSideEffectRequests.push(url.pathname)
        }
    })
    page.on('console', (message) => consoleMessages.push(message.text()))
    page.on('pageerror', (error) => runtimeErrors.push(error.message))

    await page.route('**/api/report/shared/*', async (route) => {
        const request = route.request()
        const pathname = new URL(request.url()).pathname
        const token = decodeURIComponent(pathname.split('/').at(-1) ?? '')
        publicRequestHeaders.push({ token, headers: request.headers() })
        if (token === unavailableToken) {
            await route.fulfill({
                status: 404,
                contentType: 'application/json',
                headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
                body: JSON.stringify({ error: 'NOT_FOUND' }),
            })
            return
        }
        if (token === networkToken && networkAttempts++ === 0) {
            await route.abort('failed')
            return
        }
        if (token === invalidToken) {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    ...publicPayload,
                    shared: { ...publicPayload.shared, contentHtml: '<img src="https://tracker.invalid/pixel">' },
                }),
            })
            return
        }
        if (token === expiredToken) {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    ...publicPayload,
                    shared: { ...publicPayload.shared, createdAt: now - 20_000, expireAt: now - 1_000 },
                }),
            })
            return
        }
        if (token === validToken) {
            // 留出确定窗口，证明真实加载态存在，而不是只验证最终静态画面。
            await new Promise((resolve) => setTimeout(resolve, 350))
        }
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
            body: JSON.stringify(publicPayload),
        })
    })

    try {
        const documentResponse = await page.goto(`${BASE_URL}/shared/report/${validToken}`, {
            waitUntil: 'domcontentloaded',
        })
        await page.getByTestId('shared-report-loading').waitFor({ state: 'visible', timeout: 10_000 })
        await page.getByTestId('shared-report-ready').waitFor({ state: 'visible', timeout: 10_000 })

        const documentHeaders = documentResponse?.headers() ?? {}
        const cacheControl = (documentHeaders['cache-control'] ?? '').toLowerCase()
        const robotsHeader = (documentHeaders['x-robots-tag'] ?? '').toLowerCase()
        const referrerHeader = (documentHeaders['referrer-policy'] ?? '').toLowerCase()
        if (!cacheControl.includes('no-store')
            || !robotsHeader.includes('noindex')
            || referrerHeader !== 'no-referrer') {
            fail(`匿名直达 HTML 缺少生产隐私响应头：${JSON.stringify({ cacheControl, robotsHeader, referrerHeader })}`)
        }
        if (new URL(page.url()).search || new URL(page.url()).hash) {
            fail('匿名分享 token 被转写进 query/hash，而不是保留在受控 path 中')
        }
        if (authSideEffectRequests.length > 0) {
            fail(`匿名公开页错误触发认证/心跳副作用：${authSideEffectRequests.join(', ')}`)
        }

        const publicGet = publicRequestHeaders.find((item) => item.token === validToken)
        if (!publicGet
            || publicGet.headers.cookie
            || publicGet.headers.referer
            || publicGet.headers['x-csrf-token']) {
            fail(`匿名报告请求携带了 Cookie、Referer、CSRF 或未发起：${JSON.stringify({
                found: Boolean(publicGet),
                cookie: Boolean(publicGet?.headers.cookie),
                referer: Boolean(publicGet?.headers.referer),
                csrf: Boolean(publicGet?.headers['x-csrf-token']),
            })}`)
        }

        const privacyMeta = await page.evaluate(() => ({
            robots: document.querySelector('meta[name="robots"]')?.getAttribute('content') ?? '',
            referrer: document.querySelector('meta[name="referrer"]')?.getAttribute('content') ?? '',
            activeTag: document.activeElement?.tagName ?? '',
            activeId: document.activeElement?.id ?? '',
            controlledTextInMainDom: document.body.innerText.includes('E2E 公开正文只允许出现在隔离文档中。'),
        }))
        if (!privacyMeta.robots.includes('noindex')
            || privacyMeta.referrer !== 'no-referrer'
            || privacyMeta.controlledTextInMainDom
            || privacyMeta.activeTag !== 'H1'
            || privacyMeta.activeId !== 'shared-report-title') {
            fail(`匿名页隐私 meta、主 DOM 隔离或动态焦点不完整：${JSON.stringify(privacyMeta)}`)
        }

        const frame = page.getByTestId('shared-report-frame')
        const frameContract = await frame.evaluate((element) => ({
            sandbox: element.getAttribute('sandbox'),
            referrerPolicy: element.getAttribute('referrerpolicy'),
            hasSrc: element.hasAttribute('src'),
            hasSrcDoc: element.hasAttribute('srcdoc'),
            title: element.getAttribute('title'),
        }))
        if (frameContract.sandbox !== 'allow-same-origin'
            || frameContract.referrerPolicy !== 'no-referrer'
            || frameContract.hasSrc
            || !frameContract.hasSrcDoc
            || !frameContract.title?.startsWith('报告正文：')) {
            fail(`匿名正文 iframe 能力边界不正确：${JSON.stringify(frameContract)}`)
        }
        const isolatedDocument = page.frameLocator('[data-testid="shared-report-frame"]')
        await isolatedDocument.getByRole('heading', { name: '公开内容验收', exact: true }).waitFor({ state: 'visible' })
        const isolatedSecurity = {
            csp: await isolatedDocument.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'),
            referrer: await isolatedDocument.locator('meta[name="referrer"]').getAttribute('content'),
            robots: await isolatedDocument.locator('meta[name="robots"]').getAttribute('content'),
            activeContentCount: await isolatedDocument.locator('script,style[src],link,img,video,audio,form,a').count(),
        }
        if (!isolatedSecurity.csp?.includes("default-src 'none'")
            || !isolatedSecurity.csp.includes("connect-src 'none'")
            || isolatedSecurity.referrer !== 'no-referrer'
            || !isolatedSecurity.robots?.includes('noindex')
            || isolatedSecurity.activeContentCount !== 0) {
            fail(`匿名 iframe 缺少 CSP/no-referrer/noindex 或包含主动内容：${JSON.stringify(isolatedSecurity)}`)
        }

        const persisted = await page.evaluate((tokens) => {
            const values = [...Object.values(localStorage), ...Object.values(sessionStorage)]
            return tokens.some((token) => values.some((value) => value.includes(token)))
        }, allTokens)
        if (persisted) fail('匿名 bearer token 被写入 localStorage/sessionStorage')

        const desktopMotion = await page.evaluate(() => {
            const durations = [...document.querySelectorAll('.pr-shared-report-page *')]
                .flatMap((element) => {
                    const style = getComputedStyle(element)
                    return `${style.animationDuration},${style.transitionDuration}`.split(',')
                })
                .map((value) => value.trim())
            return {
                reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
                hasUnexpectedMotion: durations.some((duration) => duration !== '0s' && duration !== '0ms'),
            }
        })
        if (!desktopMotion.reducedMotion || desktopMotion.hasUnexpectedMotion) {
            fail(`匿名页减弱动效兜底不完整：${JSON.stringify(desktopMotion)}`)
        }

        await page.screenshot({
            path: path.join(OUTPUT_DIR, 'desktop-public-report-sharing.png'),
            fullPage: false,
        })
        await page.emulateMedia({ forcedColors: 'active' })
        const forcedColorsContract = await page.evaluate(() => ({
            matches: matchMedia('(forced-colors: active)').matches,
            sheetBorder: getComputedStyle(document.querySelector('.pr-shared-report-sheet')).borderStyle,
            disclosureBorder: getComputedStyle(document.querySelector('.pr-shared-report-disclosure')).borderStyle,
        }))
        if (!forcedColorsContract.matches
            || forcedColorsContract.sheetBorder === 'none'
            || forcedColorsContract.disclosureBorder === 'none') {
            fail(`匿名页强制配色兜底不完整：${JSON.stringify(forcedColorsContract)}`)
        }
        await page.emulateMedia({ forcedColors: 'none' })
        await page.setViewportSize({ width: 390, height: 844 })
        const mobileGeometry = await page.evaluate(() => {
            const frameElement = document.querySelector('[data-testid="shared-report-frame"]')
            const printButton = document.querySelector('[data-testid="shared-report-print"]')
            const frameRect = frameElement?.getBoundingClientRect()
            const printRect = printButton?.getBoundingClientRect()
            return {
                viewportWidth: innerWidth,
                documentWidth: document.documentElement.scrollWidth,
                frameLeft: frameRect?.left ?? -1,
                frameRight: frameRect?.right ?? -1,
                printHeight: printRect?.height ?? 0,
                printLeft: printRect?.left ?? -1,
                printRight: printRect?.right ?? -1,
            }
        })
        if (mobileGeometry.documentWidth > mobileGeometry.viewportWidth + 1
            || mobileGeometry.frameLeft < 0
            || mobileGeometry.frameRight > mobileGeometry.viewportWidth + 1
            || mobileGeometry.printHeight < 44
            || mobileGeometry.printLeft < 0
            || mobileGeometry.printRight > mobileGeometry.viewportWidth + 1) {
            fail(`匿名分享移动端存在溢出、裁切或不足 44px 的主操作：${JSON.stringify(mobileGeometry)}`)
        }
        await page.screenshot({
            path: path.join(OUTPUT_DIR, 'mobile-public-report-sharing.png'),
            fullPage: false,
        })

        await page.evaluate(() => {
            window.__e2ePrintCalled = false
            window.print = () => { window.__e2ePrintCalled = true }
        })
        await page.getByTestId('shared-report-print').focus()
        await page.getByTestId('shared-report-print').press('Enter')
        if (!await page.evaluate(() => window.__e2ePrintCalled === true)) {
            fail('匿名公开页打印按钮不能通过键盘触发')
        }
        await page.emulateMedia({ media: 'print' })
        const printContract = await page.evaluate(() => ({
            headerDisplay: getComputedStyle(document.querySelector('.pr-shared-report-header')).display,
            disclosureDisplay: getComputedStyle(document.querySelector('.pr-shared-report-disclosure')).display,
            frameDisplay: getComputedStyle(document.querySelector('[data-testid="shared-report-frame"]')).display,
            sheetShadow: getComputedStyle(document.querySelector('.pr-shared-report-sheet')).boxShadow,
        }))
        if (printContract.headerDisplay !== 'none'
            || printContract.disclosureDisplay !== 'none'
            || printContract.frameDisplay === 'none'
            || printContract.sheetShadow !== 'none') {
            fail(`匿名报告打印兜底不完整：${JSON.stringify(printContract)}`)
        }
        await page.emulateMedia({ media: 'screen' })

        await page.goto(`${BASE_URL}/shared/report/${unavailableToken}`, { waitUntil: 'domcontentloaded' })
        await page.getByTestId('shared-report-error-unavailable').waitFor({ state: 'visible', timeout: 10_000 })
        const unavailableCopy = await page.getByTestId('shared-report-error-unavailable').innerText()
        if (!unavailableCopy.includes('过期') || !unavailableCopy.includes('撤销')) {
            fail('404 未以隐私优先方式合并呈现过期/撤销/无效状态')
        }

        await page.goto(`${BASE_URL}/shared/report/${expiredToken}`, { waitUntil: 'domcontentloaded' })
        await page.getByTestId('shared-report-error-unavailable').waitFor({ state: 'visible', timeout: 10_000 })

        await page.goto(`${BASE_URL}/shared/report/${invalidToken}`, { waitUntil: 'domcontentloaded' })
        await page.getByTestId('shared-report-error-invalid-response').waitFor({ state: 'visible', timeout: 10_000 })
        if (await page.locator('img[src="https://tracker.invalid/pixel"]').count() !== 0) {
            fail('不安全公开响应在契约校验失败后仍进入了主 DOM')
        }

        await page.goto(`${BASE_URL}/shared/report/${networkToken}`, { waitUntil: 'domcontentloaded' })
        const networkError = page.getByTestId('shared-report-error-network')
        await networkError.waitFor({ state: 'visible', timeout: 10_000 })
        await page.getByTestId('shared-report-retry').focus()
        await page.getByTestId('shared-report-retry').press('Enter')
        await page.getByTestId('shared-report-ready').waitFor({ state: 'visible', timeout: 10_000 })

        const leakedToConsole = consoleMessages.some((message) => allTokens.some((token) => message.includes(token)))
        if (leakedToConsole) fail('匿名 bearer token 出现在浏览器 console 文本中')
        if (runtimeErrors.length > 0) {
            fail(`匿名分享交互出现未处理页面错误：${runtimeErrors.join(' | ')}`)
        }
        publicReportSharingChecked = true
    } finally {
        await context.close()
    }
}

/**
 * 教师管理流必须先获得服务端脱敏预览和人工确认，再创建一次性 token；随后只
 * 保留无 token 摘要并可撤销。受控夹具验证 UI/请求契约，不代表公网分发已完成。
 */
async function checkReportShareManagementContract(context) {
    activeRoute = 'report-share-management-contract'
    const page = await context.newPage()
    const runtimeErrors = []
    const now = Date.now()
    const completedTitle = 'E2E 分享管理报告'
    const previewFingerprint = 'f'.repeat(64)
    const createdToken = 'E2E_management_created_token_20260810_abcdef'
    const existingShareId = `shr_${'1'.repeat(32)}`
    const createdShareId = `shr_${'2'.repeat(32)}`
    const reportItem = {
        id: 'E2E-REPORT-SHARING',
        teacherId: 'teacher-001',
        classId: 'E2E-REPORT-SHARING-CLASS',
        className: 'E2E 分享教研班',
        template: 'standard',
        status: 'completed',
        progress: 1,
        title: completedTitle,
        period: { from: now - 172_800_000, to: now - 86_400_000 },
        createdAt: now - 72_000_000,
        updatedAt: now - 36_000_000,
    }
    const completedReport = {
        ...reportItem,
        includeSections: [],
        output: {
            title: completedTitle,
            sections: [],
            keyFindings: [],
            recommendations: [],
            dataAnonymized: true,
            aiGenerated: true,
        },
    }
    let managedShares = [{
        shareId: existingShareId,
        reportId: reportItem.id,
        className: 'E2E 分享教研班',
        title: 'E2E 既有分享',
        createdAt: now - 86_400_000,
        expireAt: now + 86_400_000,
        viewCount: 3,
        lastViewedAt: now - 3_600_000,
    }]
    let previewCalls = 0
    let createCalls = 0
    let revokeCalls = 0
    let capturedCreateBody = null

    const send = (route, payload, status = 200) => route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ok', ...payload }),
    })
    page.on('pageerror', (error) => runtimeErrors.push(error.message))
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(BASE_URL).origin })
    await page.addInitScript(() => window.localStorage.removeItem('pr-demo-mode'))
    await page.route('**/api/report**', async (route) => {
        const request = route.request()
        const url = new URL(request.url())
        const method = request.method()
        const pathname = url.pathname
        let body = {}
        if (['POST', 'PATCH', 'PUT'].includes(method)) {
            try {
                body = request.postDataJSON() ?? {}
            } catch {
                body = {}
            }
        }

        if (method === 'GET' && pathname === '/api/report/templates') {
            await send(route, { templates: [], sections: [] })
            return
        }
        if (method === 'GET' && pathname === '/api/report') {
            await send(route, {
                total: 1,
                limit: 20,
                offset: 0,
                items: [reportItem],
                aiGenerated: true,
            })
            return
        }
        if (method === 'GET' && pathname === `/api/report/${reportItem.id}`) {
            await send(route, { report: completedReport, aiGenerated: true })
            return
        }
        if (method === 'GET' && pathname === `/api/report/${reportItem.id}/charts`) {
            await send(route, {
                reportId: reportItem.id,
                classId: reportItem.classId,
                className: reportItem.className,
                scoreDistribution: [],
                knowledgeMastery: [],
                bloomDistribution: [],
                weeklyComparison: [],
                generatedAt: reportItem.updatedAt,
                aiGenerated: true,
            })
            return
        }
        if (method === 'GET' && pathname === '/api/report/shared') {
            await send(route, { shares: managedShares, total: managedShares.length })
            return
        }
        if (method === 'POST' && pathname === '/api/report/share/preview') {
            previewCalls++
            if (body.reportId !== reportItem.id
                || 'teacherId' in body
                || 'expireDays' in body
                || 'contentHtml' in body) {
                fail(`脱敏预览请求越过最小 DTO 边界：${JSON.stringify(Object.keys(body))}`)
            }
            await send(route, {
                preview: {
                    className: 'E2E 脱敏教研班',
                    title: 'E2E 脱敏公开版',
                    contentHtml: '<h1>脱敏公开版</h1><p>仅含班级聚合结论。</p><blockquote>人工复核夹具</blockquote>',
                },
                previewFingerprint,
                aiGenerated: true,
            })
            return
        }
        if (method === 'POST' && pathname === '/api/report/share') {
            createCalls++
            capturedCreateBody = body
            if (previewCalls < 1
                || body.previewFingerprint !== previewFingerprint
                || body.expireDays !== 17
                || 'contentHtml' in body
                || 'token' in body
                || 'teacherId' in body) {
                fail(`创建请求未绑定预览指纹、17 天有效期或携带了越界字段：${JSON.stringify(Object.keys(body))}`)
            }
            const created = {
                shareId: createdShareId,
                reportId: reportItem.id,
                className: 'E2E 脱敏教研班',
                title: 'E2E 脱敏公开版',
                createdAt: now,
                expireAt: now + 17 * 86_400_000,
                viewCount: 0,
                lastViewedAt: null,
            }
            managedShares = [...managedShares, created]
            await send(route, { shared: { ...created, token: createdToken }, aiGenerated: true }, 201)
            return
        }
        if (method === 'DELETE' && pathname === `/api/report/shared/${existingShareId}`) {
            revokeCalls++
            managedShares = managedShares.filter((share) => share.shareId !== existingShareId)
            await send(route, { revoked: true })
            return
        }
        await route.fulfill({
            status: 404,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'E2E_ROUTE_NOT_FOUND', method, pathname }),
        })
    })

    try {
        await page.setViewportSize({ width: 1440, height: 900 })
        await page.goto(`${BASE_URL}/report`, { waitUntil: 'domcontentloaded' })
        await waitForSettledPage(page)
        const completedRow = page.locator('.pr-rpt-history table.pr-table tbody > tr').filter({ hasText: completedTitle })
        const viewButton = completedRow.getByRole('button', { name: `查看报告「${completedTitle}」`, exact: true })
        await viewButton.waitFor({ state: 'visible', timeout: 10_000 })
        await viewButton.focus()
        await viewButton.press('Enter')
        await page.getByTestId('report-share-open').waitFor({ state: 'visible', timeout: 10_000 })
        await page.waitForFunction(() => {
            const trigger = document.querySelector('[data-testid="report-share-open"]')
            return trigger instanceof HTMLButtonElement && !trigger.disabled
        }, undefined, { timeout: 10_000 })
        await page.waitForFunction(() => document.querySelectorAll('[data-testid="report-share-summary"]').length === 1)
        if (await page.getByTestId('report-share-summary').count() !== 1) {
            fail('分享管理初始无 token 摘要列表未显示唯一受控记录')
        }

        const shareTrigger = page.getByTestId('report-share-open')
        await shareTrigger.focus()
        await shareTrigger.press('Enter')
        const dialog = page.getByRole('dialog')
        await dialog.waitFor({ state: 'visible', timeout: 10_000 })
        const expireInput = page.getByTestId('report-share-expire-days')
        await expireInput.fill('91')
        if (await expireInput.getAttribute('aria-invalid') !== 'true') {
            fail('有效期 91 天未在创建前被前端明确判为非法')
        }

        await page.getByTestId('report-share-preview').focus()
        await page.getByTestId('report-share-preview').press('Enter')
        const previewFrame = page.getByTestId('report-share-preview-frame')
        await previewFrame.waitFor({ state: 'visible', timeout: 10_000 })
        if (previewCalls !== 1 || createCalls !== 0) {
            fail(`生成脱敏预览错误地创建了分享：preview=${previewCalls}, create=${createCalls}`)
        }
        const previewSandbox = await previewFrame.getAttribute('sandbox')
        if (previewSandbox !== 'allow-same-origin'
            || await page.frameLocator('[data-testid="report-share-preview-frame"]').locator('script,form,img,a').count() !== 0) {
            fail('教师侧脱敏预览未进入无脚本、无表单、无外链的 sandbox iframe')
        }
        await page.screenshot({
            path: path.join(OUTPUT_DIR, 'desktop-report-share-preview-confirmation.png'),
            fullPage: false,
        })

        const confirm = page.getByTestId('report-share-confirm')
        await confirm.focus()
        await confirm.press('Space')
        if (await page.getByTestId('report-share-create').isEnabled()) {
            fail('非法 91 天有效期下人工确认仍错误启用了创建按钮')
        }
        await expireInput.fill('17')
        await confirm.focus()
        await confirm.press('Space')
        const createButton = page.getByTestId('report-share-create')
        if (!await createButton.isEnabled()) {
            fail('有效 17 天与人工复核完成后创建按钮仍不可用')
        }
        await createButton.focus()
        await createButton.press('Enter')

        const createdInput = page.getByTestId('report-share-created-url')
        await createdInput.waitFor({ state: 'visible', timeout: 10_000 })
        const createdUrl = await createdInput.inputValue()
        const parsedCreatedUrl = new URL(createdUrl)
        if (!parsedCreatedUrl.pathname.endsWith(`/${createdToken}`)
            || parsedCreatedUrl.search
            || parsedCreatedUrl.hash
            || createCalls !== 1
            || capturedCreateBody?.expireDays !== 17) {
            fail('一次性链接未保持 path-only 或创建请求次数/有效期不正确')
        }
        const tokenPersisted = await page.evaluate((token) => (
            [...Object.values(localStorage), ...Object.values(sessionStorage)]
                .some((value) => value.includes(token))
        ), createdToken)
        if (tokenPersisted) fail('教师侧创建后的 bearer token 被持久化到 localStorage/sessionStorage')

        await page.keyboard.press('Escape')
        if (!await createdInput.isVisible()) {
            fail('一次性链接显示期间 Escape 错误关闭弹窗并丢失 token')
        }

        const copyButton = page.getByTestId('report-share-copy')
        await copyButton.click()
        const copiedText = await page.evaluate(() => navigator.clipboard.readText())
        if (copiedText !== createdUrl) fail('允许剪贴板写入时未复制完整 path-only 一次性链接')

        await page.evaluate(() => {
            Object.defineProperty(navigator, 'clipboard', {
                configurable: true,
                value: { writeText: () => Promise.reject(new Error('intentional-e2e-denial')) },
            })
        })
        await copyButton.click()
        await page.getByText('剪贴板权限不可用。链接已全选', { exact: false }).waitFor({ state: 'visible' })
        const manualSelection = await createdInput.evaluate((input) => ({
            focused: document.activeElement === input,
            start: input.selectionStart,
            end: input.selectionEnd,
            length: input.value.length,
        }))
        if (!manualSelection.focused
            || manualSelection.start !== 0
            || manualSelection.end !== manualSelection.length) {
            fail(`剪贴板失败后没有聚焦并全选手动复制字段：${JSON.stringify(manualSelection)}`)
        }

        await page.getByTestId('report-share-saved-close').click()
        await dialog.waitFor({ state: 'hidden', timeout: 10_000 })
        if ((await page.locator('body').innerText()).includes(createdToken)) {
            fail('关闭一次性弹窗后 bearer token 仍残留在教师页面可见 DOM')
        }
        await page.waitForFunction(() => document.querySelectorAll('[data-testid="report-share-summary"]').length === 2)

        const existingSummary = page.getByTestId('report-share-summary').filter({ hasText: 'E2E 既有分享' })
        await existingSummary.getByTestId('report-share-revoke').focus()
        await existingSummary.getByTestId('report-share-revoke').press('Enter')
        await existingSummary.getByTestId('report-share-revoke-confirm').press('Enter')
        await existingSummary.waitFor({ state: 'hidden', timeout: 10_000 })
        await page.getByTestId('report-share-feedback').filter({ hasText: '原链接立即失效' }).waitFor({ state: 'visible' })
        if (revokeCalls !== 1) fail(`撤销操作请求次数错误：${revokeCalls}`)

        await page.screenshot({
            path: path.join(OUTPUT_DIR, 'desktop-report-share-management.png'),
            fullPage: false,
        })

        await page.setViewportSize({ width: 390, height: 844 })
        await shareTrigger.scrollIntoViewIfNeeded()
        await shareTrigger.focus()
        await shareTrigger.press('Enter')
        await dialog.waitFor({ state: 'visible', timeout: 10_000 })
        const mobileContract = await dialog.evaluate((element) => {
            const rect = element.getBoundingClientRect()
            const interactive = [...element.querySelectorAll('button,input:not([type="checkbox"]),a')]
                .filter((node) => getComputedStyle(node).display !== 'none' && !node.hasAttribute('disabled'))
                .map((node) => ({ height: node.getBoundingClientRect().height, width: node.getBoundingClientRect().width }))
            const confirmationTarget = element.querySelector('.pr-rpt-share-modal__confirm')?.getBoundingClientRect()
            return {
                viewportWidth: innerWidth,
                documentWidth: document.documentElement.scrollWidth,
                left: rect.left,
                right: rect.right,
                top: rect.top,
                bottom: rect.bottom,
                minInteractiveHeight: Math.min(...interactive.map((item) => item.height)),
                minInteractiveWidth: Math.min(...interactive.map((item) => item.width)),
                confirmationTargetHeight: confirmationTarget?.height ?? 0,
                confirmationTargetWidth: confirmationTarget?.width ?? 0,
                reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
            }
        })
        if (mobileContract.documentWidth > mobileContract.viewportWidth + 1
            || mobileContract.left < 0
            || mobileContract.right > mobileContract.viewportWidth + 1
            || mobileContract.top < 0
            || mobileContract.bottom > 844 + 1
            || mobileContract.minInteractiveHeight < 44
            || mobileContract.minInteractiveWidth < 44
            || (mobileContract.confirmationTargetHeight > 0 && mobileContract.confirmationTargetHeight < 44)
            || (mobileContract.confirmationTargetWidth > 0 && mobileContract.confirmationTargetWidth < 44)
            || !mobileContract.reducedMotion) {
            fail(`分享管理移动端/44px/减弱动态契约失败：${JSON.stringify(mobileContract)}`)
        }
        await page.screenshot({
            path: path.join(OUTPUT_DIR, 'mobile-report-share-management.png'),
            fullPage: false,
        })
        await page.keyboard.press('Escape')
        await dialog.waitFor({ state: 'hidden', timeout: 10_000 })
        if (!await shareTrigger.evaluate((button) => document.activeElement === button)) {
            fail('移动端通过 Escape 关闭分享弹窗后未把焦点归还触发按钮')
        }

        if (runtimeErrors.length > 0) {
            fail(`分享管理交互出现未处理页面错误：${runtimeErrors.join(' | ')}`)
        }
        reportShareManagementChecked = true
    } finally {
        await page.close()
    }
}

/**
 * 报告历史必须保留原生表格语义：行不是额外的伪按钮，读取行为只从唯一、具名的
 * 原生操作按钮发起。受控夹具覆盖已完成、失败和生成中三态；它仅检验前端的交互
 * 契约、以及查看后焦点交接，不表示任何报告内容、教学质量或模型结果。
 */
async function checkReportHistoryActionSemantics(context) {
    activeRoute = 'report-history-action-semantics'
    const page = await context.newPage()
    const runtimeErrors = []
    const completedTitle = 'E2E 已完成报告'
    const failedTitle = 'E2E 失败报告'
    const generatingTitle = 'E2E 生成中报告'
    const reportItems = [{
        id: 'E2E-REPORT-COMPLETED',
        teacherId: 'teacher-001',
        classId: 'E2E-REPORT-CLASS',
        className: 'E2E 教研班',
        template: 'standard',
        status: 'completed',
        progress: 1,
        title: completedTitle,
        period: { from: 1_700_000_000_000, to: 1_700_086_400_000 },
        createdAt: 1_700_172_800_000,
        updatedAt: 1_700_172_800_000,
    }, {
        id: 'E2E-REPORT-FAILED',
        teacherId: 'teacher-001',
        classId: 'E2E-REPORT-CLASS',
        className: 'E2E 教研班',
        template: 'narrative',
        status: 'failed',
        progress: 1,
        title: failedTitle,
        period: { from: 1_700_000_000_000, to: 1_700_086_400_000 },
        createdAt: 1_700_086_400_000,
        updatedAt: 1_700_086_400_000,
        error: '仅用于受控交互检查的失败状态。',
    }, {
        id: 'E2E-REPORT-GENERATING',
        teacherId: 'teacher-001',
        classId: 'E2E-REPORT-CLASS',
        className: 'E2E 教研班',
        template: 'executive',
        status: 'generating',
        progress: 0.4,
        title: generatingTitle,
        period: { from: 1_700_000_000_000, to: 1_700_086_400_000 },
        createdAt: 1_700_000_050_000,
        updatedAt: 1_700_000_060_000,
    }]
    const completedReport = {
        ...reportItems[0],
        includeSections: [],
        output: {
            title: completedTitle,
            sections: [],
            keyFindings: [],
            recommendations: [],
            dataAnonymized: true,
            aiGenerated: true,
        },
    }
    let completedDetailRequests = 0
    page.on('pageerror', (error) => runtimeErrors.push(error.message))
    page.on('request', (request) => {
        try {
            const url = new URL(request.url())
            if (request.method() === 'GET' && url.pathname === '/api/report/E2E-REPORT-COMPLETED') {
                completedDetailRequests++
            }
        } catch {
            // 非 HTTP(S) 内部请求不属于本检查的报告契约范围。
        }
    })
    try {
        // 专用页面沿用认证 Cookie，但移除 DEMO 空列表短路，确保夹具真正经过历史表格。
        await page.addInitScript(() => window.localStorage.removeItem('pr-demo-mode'))
        await page.setViewportSize({ width: 1440, height: 900 })
        await page.route('**/api/report/templates', (route) => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ status: 'ok', templates: [], sections: [] }),
        }))
        await page.route('**/api/report?*', (route) => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                status: 'ok',
                total: reportItems.length,
                limit: 20,
                offset: 0,
                items: reportItems,
                aiGenerated: true,
            }),
        }))
        await page.route('**/api/report/E2E-REPORT-COMPLETED/charts', (route) => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                status: 'ok',
                reportId: completedReport.id,
                classId: completedReport.classId,
                className: completedReport.className,
                scoreDistribution: [],
                knowledgeMastery: [],
                bloomDistribution: [],
                weeklyComparison: [],
                generatedAt: completedReport.updatedAt,
                aiGenerated: true,
            }),
        }))
        await page.route('**/api/report/E2E-REPORT-COMPLETED', (route) => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ status: 'ok', report: completedReport, aiGenerated: true }),
        }))

        await page.goto(`${BASE_URL}/report`, { waitUntil: 'domcontentloaded' })
        await waitForSettledPage(page)

        const historyTable = page.locator('.pr-rpt-history table.pr-table')
        await historyTable.waitFor({ state: 'visible', timeout: 10_000 })
        const completedRow = historyTable.locator('tbody > tr').filter({ hasText: completedTitle })
        const failedRow = historyTable.locator('tbody > tr').filter({ hasText: failedTitle })
        const generatingRow = historyTable.locator('tbody > tr').filter({ hasText: generatingTitle })
        await Promise.all([
            completedRow.waitFor({ state: 'visible', timeout: 10_000 }),
            failedRow.waitFor({ state: 'visible', timeout: 10_000 }),
            generatingRow.waitFor({ state: 'visible', timeout: 10_000 }),
        ])
        const rows = historyTable.locator('tbody > tr')
        if (await rows.count() !== reportItems.length) {
            fail(`报告历史受控列表行数不完整，期望 ${reportItems.length}，实际 ${await rows.count()}`)
        }
        const completedRowContract = await completedRow.evaluate((row) => ({
            role: row.getAttribute('role'),
            tabIndex: row.getAttribute('tabindex'),
            cursor: window.getComputedStyle(row).cursor,
            nestedButtonRoleCount: row.querySelectorAll('[role="button"]').length,
            nativeButtonCount: row.querySelectorAll('button').length,
        }))
        if (completedRowContract.role !== null
            || completedRowContract.tabIndex !== null
            || completedRowContract.cursor !== 'auto'
            || completedRowContract.nestedButtonRoleCount !== 0
            || completedRowContract.nativeButtonCount !== 2) {
            fail(`报告历史行不应伪装为可点击按钮或嵌套非原生操作：${JSON.stringify(completedRowContract)}`)
        }

        const completedView = completedRow.getByRole('button', { name: `查看报告「${completedTitle}」`, exact: true })
        const completedDelete = completedRow.getByRole('button', { name: `删除报告「${completedTitle}」`, exact: true })
        const failedView = failedRow.getByRole('button', { name: `查看报告「${failedTitle}」`, exact: true })
        const failedDelete = failedRow.getByRole('button', { name: `删除报告「${failedTitle}」`, exact: true })
        if (await completedView.count() !== 1 || await completedDelete.count() !== 1
            || await failedView.count() !== 1 || await failedDelete.count() !== 1) {
            fail('完成或失败报告缺少唯一、按标题区分的查看/删除原生操作')
        }
        if (await generatingRow.getByRole('button', { name: `查看报告「${generatingTitle}」`, exact: true }).count() !== 0
            || await generatingRow.getByRole('button', { name: `删除报告「${generatingTitle}」`, exact: true }).count() !== 1) {
            fail('生成中报告错误地暴露了读取动作，或丢失了具名删除操作')
        }

        // 中性单元格不应有任何隐式查看行为；先验证该负路径，再验证唯一声明动作。
        await completedRow.locator('td').first().click()
        await page.waitForTimeout(260)
        if (completedDetailRequests !== 0) {
            fail(`点击报告标题单元格错误触发了详情读取，次数=${completedDetailRequests}`)
        }

        await completedView.focus()
        const detailRequest = page.waitForRequest((request) => {
            const url = new URL(request.url())
            return request.method() === 'GET' && url.pathname === '/api/report/E2E-REPORT-COMPLETED'
        }, { timeout: 10_000 })
        await completedView.press('Enter')
        await detailRequest
        await Promise.all([
            page.locator('.pr-rpt-preview-title').filter({ hasText: completedTitle }).waitFor({ state: 'visible', timeout: 10_000 }),
            page.waitForFunction((title) => {
                const current = [...document.querySelectorAll('.pr-rpt-history-actions button')]
                    .find((button) => button.getAttribute('aria-label') === `当前报告「${title}」`)
                const previewTitle = document.querySelector('.pr-rpt-preview-title')
                return Boolean(current?.hasAttribute('disabled') && document.activeElement === previewTitle)
            }, completedTitle, { timeout: 10_000 }),
        ])
        if (completedDetailRequests !== 1) {
            fail(`查看操作必须只请求其声明的单份报告，实际详情请求次数=${completedDetailRequests}`)
        }
        await page.screenshot({
            path: path.join(OUTPUT_DIR, 'desktop-report-history-action-semantics.png'),
            fullPage: false,
        })

        // 移动端既要保持原生操作，也不能把唯一行动裁切到视口或制造页面级横向滚动。
        await page.setViewportSize({ width: 390, height: 844 })
        await page.goto(`${BASE_URL}/report`, { waitUntil: 'domcontentloaded' })
        await waitForSettledPage(page)
        const mobileHistoryTable = page.locator('.pr-rpt-history table.pr-table')
        const mobileCompletedRow = mobileHistoryTable.locator('tbody > tr').filter({ hasText: completedTitle })
        const mobileView = mobileCompletedRow.getByRole('button', { name: `查看报告「${completedTitle}」`, exact: true })
        await mobileView.waitFor({ state: 'visible', timeout: 10_000 })
        await mobileView.scrollIntoViewIfNeeded()
        const mobileGeometry = await mobileView.evaluate((button) => {
            const rect = button.getBoundingClientRect()
            return {
                viewportWidth: window.innerWidth,
                documentScrollWidth: document.documentElement.scrollWidth,
                tableScrollWidth: button.closest('.pr-table-wrapper')?.scrollWidth ?? 0,
                tableClientWidth: button.closest('.pr-table-wrapper')?.clientWidth ?? 0,
                left: rect.left,
                right: rect.right,
                height: rect.height,
                titleVisible: Boolean(button.closest('tr')?.querySelector('.pr-rpt-history-title-text')?.getClientRects().length),
                rowRole: button.closest('tr')?.getAttribute('role') ?? null,
                rowTabIndex: button.closest('tr')?.getAttribute('tabindex') ?? null,
            }
        })
        if (mobileGeometry.documentScrollWidth > mobileGeometry.viewportWidth + 1
            || mobileGeometry.tableScrollWidth > mobileGeometry.tableClientWidth + 1
            || mobileGeometry.left < 0
            || mobileGeometry.right > mobileGeometry.viewportWidth
            || mobileGeometry.height < 40
            || !mobileGeometry.titleVisible
            || mobileGeometry.rowRole !== null
            || mobileGeometry.rowTabIndex !== null) {
            fail(`移动端报告历史操作存在裁切、横向溢出或伪按钮行语义：${JSON.stringify(mobileGeometry)}`)
        }
        await page.screenshot({
            path: path.join(OUTPUT_DIR, 'mobile-report-history-action-semantics.png'),
            fullPage: false,
        })
        if (runtimeErrors.length > 0) {
            fail(`报告历史交互过程出现未处理页面错误：${runtimeErrors.join(' | ')}`)
        }
        reportHistoryActionSemanticsChecked = true
    } finally {
        await page.close()
    }
}

/**
 * 进化模式存在时，卡片必须只在持久化边能定位到真实版本时才给出导航动作。
 * 该检查注入一条模式、一条关联边和目标节点，验证 list/listitem 结构、原生
 * 按钮、Enter 跳转、目标节点选择以及源按钮卸载后的焦点交接。夹具不代表任何
 * 智能体表现或真实进化结果。
 */
async function checkEvolutionPatternLinkedNavigation(context) {
    activeRoute = 'evolution-pattern-linked-navigation'
    const page = await context.newPage()
    const patternText = 'E2E 受控模式：补充典故溯源约束，并要求关联版本提供出处、释义、语境与可审计的校验线索。'
    const unlinkedPatternText = 'E2E 受控模式：尚无关联版本'
    const stalePatternText = 'E2E 受控模式：关联边目标已失效'
    const targetNode = {
        id: 'E2E-PATTERN-NODE-V3',
        agentId: 'brush.creative',
        version: 'e2e-pattern-v3',
        isActive: true,
        isCandidate: false,
        createdAt: 1_700_000_000_400,
        changelog: 'E2E 受控最新关联版本，仅验证模式到谱系的前端定位。',
        quality: 0.88,
        improvementReward: 0.12,
        triggerPattern: patternText,
        appliedAt: 1_700_000_000_450,
        successCount: 8,
        failureCount: 1,
    }
    const olderTargetNode = {
        ...targetNode,
        id: 'E2E-PATTERN-NODE-V2',
        version: 'e2e-pattern-v2',
        isActive: false,
        createdAt: 1_700_000_000_200,
        changelog: 'E2E 受控旧关联版本，用于验证最新证据优先。',
        appliedAt: 1_700_000_000_250,
    }
    try {
        await page.setViewportSize({ width: 1440, height: 900 })
        await page.route('**/api/evolution/genealogy', (route) => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                nodes: [olderTargetNode, targetNode],
                edges: [{
                    from: 'E2E-PATTERN-NODE-V1',
                    to: olderTargetNode.id,
                    agentId: targetNode.agentId,
                    pattern: patternText,
                    improvementReward: 0.08,
                    createdAt: 1_700_000_000_200,
                }, {
                    from: olderTargetNode.id,
                    to: targetNode.id,
                    agentId: targetNode.agentId,
                    pattern: patternText,
                    improvementReward: 0.12,
                    createdAt: 1_700_000_000_400,
                }, {
                    from: 'E2E-PATTERN-NODE-STALE-FROM',
                    to: 'E2E-PATTERN-NODE-MISSING',
                    agentId: 'verify.guard',
                    pattern: stalePatternText,
                    improvementReward: -0.04,
                    createdAt: 1_700_000_000_350,
                }],
                agentIds: [targetNode.agentId],
                aiGenerated: false,
            }),
        }))
        await page.route('**/api/evolution/patterns?*', (route) => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                patterns: [{
                    id: 'E2E-PATTERN-001',
                    agentId: targetNode.agentId,
                    pattern: patternText,
                    source: 'teacher-correction',
                    contextSnippet: '仅用于验证模式到关联版本的前端交接。',
                    timestamp: 1_700_000_000_100,
                    createdAt: 1_700_000_000_100,
                }, {
                    id: 'E2E-PATTERN-CROSS-AGENT',
                    agentId: 'verify.guard',
                    pattern: patternText,
                    source: 'verify-reject',
                    contextSnippet: '仅用于验证不同 Agent 的同名模式不能借用其他 Agent 的谱系边。',
                    timestamp: 1_700_000_000_090,
                    createdAt: 1_700_000_000_090,
                }, {
                    id: 'E2E-PATTERN-UNLINKED',
                    agentId: 'verify.guard',
                    pattern: unlinkedPatternText,
                    source: 'verify-reject',
                    contextSnippet: '仅用于验证无关联证据时不会伪造可点击跳转。',
                    timestamp: 1_700_000_000_050,
                    createdAt: 1_700_000_000_050,
                }, {
                    id: 'E2E-PATTERN-STALE-EDGE',
                    agentId: 'verify.guard',
                    pattern: stalePatternText,
                    source: 'verify-reject',
                    contextSnippet: '仅用于验证陈旧边目标不存在时不展示虚假的谱系跳转。',
                    timestamp: 1_700_000_000_075,
                    createdAt: 1_700_000_000_075,
                }],
                aiGenerated: false,
            }),
        }))
        await page.route('**/api/evolution/ab-tests', (route) => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ active: [], history: [], threshold: 0.05, minSamples: 8, aiGenerated: false }),
        }))
        await page.goto(`${BASE_URL}/evolution-eye`, { waitUntil: 'domcontentloaded' })
        await waitForSettledPage(page)

        const patternsTab = page.locator('[data-ai-evolution-tab="patterns"]')
        await patternsTab.waitFor({ state: 'visible', timeout: 10_000 })
        await patternsTab.click()
        const patternPanel = page.getByRole('region', { name: '进化模式列表', exact: true })
        await patternPanel.waitFor({ state: 'visible', timeout: 10_000 })
        const items = patternPanel.getByRole('listitem')
        if (await items.count() !== 4 || await patternPanel.locator('.pattern-item[role="button"]').count() !== 0) {
            fail(`进化模式列表必须使用 list/listitem 而非整卡伪按钮：${JSON.stringify({ items: await items.count(), fakeButtons: await patternPanel.locator('.pattern-item[role="button"]').count() })}`)
        }
        const sourceFilter = patternPanel.getByRole('combobox', { name: '按来源筛选', exact: true })
        await sourceFilter.focus()
        await sourceFilter.press('ArrowDown')
        const sourceFilterListId = await sourceFilter.getAttribute('aria-controls')
        const sourceFilterList = sourceFilterListId
            ? page.locator(`[id="${sourceFilterListId}"]`)
            : page.locator('not-a-real-source-filter-list')
        await sourceFilterList.waitFor({ state: 'visible', timeout: 5_000 })
        if (await sourceFilterList.getAttribute('role') !== 'listbox'
            || await sourceFilterList.getAttribute('aria-multiselectable') !== 'true') {
            fail('进化模式来源筛选未暴露多选组合框—listbox 契约')
        }
        await sourceFilterList.getByRole('option', { name: '教师纠正', exact: true }).waitFor({ state: 'visible', timeout: 5_000 })
        await sourceFilter.press('Home')
        await sourceFilter.press(' ')
        await page.waitForTimeout(100)
        const selectedSourceFilterState = await patternPanel.evaluate((panel) => {
            const input = panel.querySelector('input[aria-label="按来源筛选"]')
            const listId = input?.getAttribute('aria-controls')
            const list = listId ? document.getElementById(listId) : null
            return {
                itemCount: panel.querySelectorAll('.pattern-item').length,
                inputValue: input instanceof HTMLInputElement ? input.value : null,
                expanded: input?.getAttribute('aria-expanded') ?? null,
                activeDescendant: input?.getAttribute('aria-activedescendant') ?? null,
                chips: Array.from(panel.querySelectorAll('.pr-combobox-chip')).map((chip) => chip.textContent?.trim() ?? ''),
                options: Array.from(list?.querySelectorAll('[role="option"]') ?? []).map((option) => ({
                    label: option.textContent?.trim() ?? '',
                    selected: option.getAttribute('aria-selected'),
                    disabled: option.getAttribute('aria-disabled'),
                })),
            }
        })
        if (selectedSourceFilterState.itemCount !== 1) {
            throw new Error(`进化模式来源筛选未在键盘选择后收敛：${JSON.stringify(selectedSourceFilterState)}`)
        }
        if (await items.first().locator('.pattern-item__badge--teacher-correction').count() !== 1) {
            fail('进化模式来源筛选未只保留所选来源的真实模式')
        }
        await sourceFilter.focus()
        await sourceFilter.press('Escape')
        await sourceFilterList.waitFor({ state: 'hidden', timeout: 5_000 })
        const removeTeacherFilter = patternPanel.getByRole('button', { name: '移除 教师纠正', exact: true })
        await removeTeacherFilter.focus()
        const removeTeacherFilterContract = await removeTeacherFilter.evaluate((button) => {
            const rect = button.getBoundingClientRect()
            return { tabIndex: button.tabIndex, width: rect.width, height: rect.height, focused: document.activeElement === button }
        })
        if (removeTeacherFilterContract.tabIndex !== 0
            || removeTeacherFilterContract.width < 24
            || removeTeacherFilterContract.height < 24
            || !removeTeacherFilterContract.focused) {
            fail(`进化模式筛选 chip 删除入口缺少可达的最小键盘/触控目标：${JSON.stringify(removeTeacherFilterContract)}`)
        }
        await removeTeacherFilter.press('Enter')
        await page.waitForFunction(() => document.querySelectorAll('.pattern-panel .pattern-item').length === 4, undefined, { timeout: 5_000 })
        await sourceFilter.focus()
        await sourceFilter.press('End')
        await page.waitForFunction((inputId) => {
            const input = document.getElementById(inputId)
            return input?.getAttribute('aria-activedescendant')?.endsWith('-option-2') === true
        }, await sourceFilter.getAttribute('id'), { timeout: 5_000 })
        await sourceFilter.press('Escape')
        await sourceFilterList.waitFor({ state: 'hidden', timeout: 5_000 })
        const linkedItem = patternPanel.locator('.pattern-item:has(.pattern-item__agent[title="brush.creative"])')
        const linkedPatternAgentLabel = linkedItem.locator('.pattern-item__agent')
        const linkedPatternAgentContract = await linkedPatternAgentLabel.evaluate((label) => ({
            text: label.textContent?.trim() ?? '',
            title: label.getAttribute('title'),
        }))
        if (linkedPatternAgentContract.title !== 'brush.creative' || linkedPatternAgentContract.text !== 'brush.c…') {
            fail(`进化模式卡的紧凑 Agent 标识未明确省略或未保留完整值：${JSON.stringify(linkedPatternAgentContract)}`)
        }
        const linkedVersionLabels = await linkedItem.locator('.pattern-item__version-chip').allTextContents()
        if (!linkedVersionLabels.includes(olderTargetNode.version) || !linkedVersionLabels.includes(targetNode.version)) {
            fail(`关联版本未显示可区分的真实版本标签：${JSON.stringify(linkedVersionLabels)}`)
        }
        const crossAgentItem = patternPanel
            .locator('.pattern-item:has(.pattern-item__agent[title="verify.guard"])')
            .filter({ hasText: patternText })
        if (await crossAgentItem.count() !== 1 || await crossAgentItem.getByRole('button').count() !== 0) {
            fail('跨 Agent 同名模式错误合并或借用了其他 Agent 的谱系跳转动作')
        }
        if (await crossAgentItem.evaluate((item) => window.getComputedStyle(item).cursor) !== 'auto') {
            fail('跨 Agent 同名模式仍以鼠标指针伪装成可点击入口')
        }
        const unlinkedItem = items.filter({ hasText: unlinkedPatternText })
        if (await unlinkedItem.count() !== 1 || await unlinkedItem.getByRole('button').count() !== 0) {
            fail('没有真实关联边的模式仍渲染了可点击的谱系跳转动作')
        }
        if (await unlinkedItem.evaluate((item) => window.getComputedStyle(item).cursor) !== 'auto') {
            fail('没有关联版本的模式卡仍以鼠标指针伪装成可点击入口')
        }
        const staleItem = items.filter({ hasText: stalePatternText })
        if (await staleItem.count() !== 1 || await staleItem.getByRole('button').count() !== 0) {
            fail('关联边的目标节点不存在时仍渲染了不可兑现的谱系跳转动作')
        }
        const staleChip = staleItem.locator('.pattern-item__version-chip--stale')
        if (await staleChip.count() !== 1
            || (await staleChip.textContent())?.trim() !== '关联节点已失效'
            || !(await staleChip.getAttribute('title'))?.includes('E2E-PATTERN-NODE-MISSING')) {
            fail('关联目标失效时未明确披露失效状态并保留可追溯节点说明')
        }
        if (await staleItem.evaluate((item) => window.getComputedStyle(item).cursor) !== 'auto') {
            fail('关联目标失效的模式卡仍以鼠标指针伪装成可点击入口')
        }
        const openRelated = patternPanel.getByRole('button', {
            name: `在族谱中查看模式“${patternText}”的关联版本`,
            exact: true,
        })
        if (await openRelated.count() !== 1) {
            fail(`有真实关联边的模式必须恰有一个原生定位动作，实际数量=${await openRelated.count()}`)
        }
        await openRelated.waitFor({ state: 'visible', timeout: 10_000 })
        await openRelated.focus()
        await openRelated.press('Enter')
        const genealogyTab = page.locator('[data-ai-evolution-tab="genealogy"]')
        const genealogyPanel = page.locator('main.ai-evolution__main[role="tabpanel"]')
        const nodeDetail = page.locator('.evolution-detail-panel')
        await nodeDetail.waitFor({ state: 'visible', timeout: 15_000 })
        await page.waitForFunction((expectedVersion) => {
            const tab = document.querySelector('[data-ai-evolution-tab="genealogy"]')
            const panel = document.querySelector('main.ai-evolution__main[role="tabpanel"]')
            const detail = document.querySelector('.evolution-detail-panel')
            return tab?.getAttribute('aria-selected') === 'true'
                && document.activeElement === panel
                && detail?.textContent?.includes(expectedVersion)
        }, targetNode.version, { timeout: 10_000 })
        if (await genealogyTab.getAttribute('aria-selected') !== 'true'
            || await genealogyPanel.getAttribute('tabindex') !== '-1') {
            fail('模式关联版本跳转后未切到族谱面板或面板不可程序化聚焦')
        }
        const selectedNodeAgent = nodeDetail.locator(`.evolution-detail-panel__value[title="${targetNode.agentId}"]`)
        const selectedNodeAgentContract = await selectedNodeAgent.evaluate((value) => ({
            text: value.textContent?.trim() ?? '',
            clientWidth: value.clientWidth,
            scrollWidth: value.scrollWidth,
        }))
        if (selectedNodeAgentContract.text !== targetNode.agentId
            || selectedNodeAgentContract.scrollWidth > selectedNodeAgentContract.clientWidth) {
            fail(`关联节点详情将可容纳的 Agent 标识静默截断或裁切：${JSON.stringify(selectedNodeAgentContract)}`)
        }
        await page.screenshot({
            path: path.join(OUTPUT_DIR, 'desktop-evolution-pattern-linked-navigation.png'),
            fullPage: false,
        })

        // 窄屏不能因侧栏重排、卡片信息密度或滚动容器而把唯一真实入口裁切掉。
        await page.setViewportSize({ width: 390, height: 844 })
        await page.goto(`${BASE_URL}/evolution-eye`, { waitUntil: 'domcontentloaded' })
        await waitForSettledPage(page)
        const mobilePatternsTab = page.locator('[data-ai-evolution-tab="patterns"]')
        await mobilePatternsTab.waitFor({ state: 'visible', timeout: 10_000 })
        await mobilePatternsTab.click()
        const mobilePatternPanel = page.getByRole('region', { name: '进化模式列表', exact: true })
        await mobilePatternPanel.waitFor({ state: 'visible', timeout: 10_000 })
        const mobileItems = mobilePatternPanel.getByRole('listitem')
        if (await mobileItems.count() !== 4) {
            fail(`窄屏进化模式列表意外丢失条目，实际数量=${await mobileItems.count()}`)
        }
        const mobileUnlinked = mobileItems.filter({ hasText: unlinkedPatternText })
        const mobileStale = mobileItems.filter({ hasText: stalePatternText })
        const mobileCrossAgent = mobilePatternPanel
            .locator('.pattern-item:has(.pattern-item__agent[title="verify.guard"])')
            .filter({ hasText: patternText })
        if (await mobileUnlinked.getByRole('button').count() !== 0
            || await mobileStale.getByRole('button').count() !== 0
            || await mobileCrossAgent.getByRole('button').count() !== 0) {
            fail('窄屏下无关联、失效关联或跨 Agent 同名模式重新出现了虚假跳转动作')
        }
        if (await mobileUnlinked.evaluate((item) => window.getComputedStyle(item).cursor) !== 'auto'
            || await mobileStale.evaluate((item) => window.getComputedStyle(item).cursor) !== 'auto'
            || await mobileCrossAgent.evaluate((item) => window.getComputedStyle(item).cursor) !== 'auto') {
            fail('窄屏下无关联、失效关联或跨 Agent 同名模式重新以鼠标指针暗示可点击')
        }
        const mobileOpenRelated = mobilePatternPanel.getByRole('button', {
            name: `在族谱中查看模式“${patternText}”的关联版本`,
            exact: true,
        })
        if (await mobileOpenRelated.count() !== 1) {
            fail(`窄屏下有可核验关联版本的模式必须保留唯一原生动作，实际数量=${await mobileOpenRelated.count()}`)
        }
        await mobileOpenRelated.scrollIntoViewIfNeeded()
        const mobileGeometry = await mobileOpenRelated.evaluate((button) => {
            const rect = button.getBoundingClientRect()
            return {
                viewportWidth: window.innerWidth,
                documentScrollWidth: document.documentElement.scrollWidth,
                left: rect.left,
                right: rect.right,
                height: rect.height,
            }
        })
        if (mobileGeometry.documentScrollWidth > mobileGeometry.viewportWidth + 1
            || mobileGeometry.left < 0
            || mobileGeometry.right > mobileGeometry.viewportWidth
            || mobileGeometry.height < 32) {
            fail(`窄屏模式关联入口存在溢出、裁切或触控高度不足：${JSON.stringify(mobileGeometry)}`)
        }
        // 不把桌面端的组合框结论外推到窄屏：在真实移动视口重新走一遍“键盘定位—筛选—
        // chip 删除—列表恢复”，并检查删除目标本身不会制造横向滚动或被裁切。
        const mobileSourceFilter = mobilePatternPanel.getByRole('combobox', { name: '按来源筛选', exact: true })
        await mobileSourceFilter.focus()
        await mobileSourceFilter.press('Home')
        await mobileSourceFilter.press(' ')
        await page.waitForFunction(() => document.querySelectorAll('.pattern-panel .pattern-item').length === 1, undefined, { timeout: 5_000 })
        if (await mobileItems.first().locator('.pattern-item__badge--teacher-correction').count() !== 1) {
            fail('窄屏进化模式来源筛选未只保留所选来源的真实模式')
        }
        await mobileSourceFilter.press('Escape')
        const mobileRemoveTeacherFilter = mobilePatternPanel.getByRole('button', { name: '移除 教师纠正', exact: true })
        await mobileRemoveTeacherFilter.scrollIntoViewIfNeeded()
        const mobileChipGeometry = await mobileRemoveTeacherFilter.evaluate((button) => {
            const rect = button.getBoundingClientRect()
            return {
                viewportWidth: window.innerWidth,
                documentScrollWidth: document.documentElement.scrollWidth,
                left: rect.left,
                right: rect.right,
                width: rect.width,
                height: rect.height,
                focused: document.activeElement === button,
            }
        })
        if (mobileChipGeometry.documentScrollWidth > mobileChipGeometry.viewportWidth + 1
            || mobileChipGeometry.left < 0
            || mobileChipGeometry.right > mobileChipGeometry.viewportWidth
            || mobileChipGeometry.width < 24
            || mobileChipGeometry.height < 24) {
            fail(`窄屏进化模式筛选 chip 删除入口存在溢出、裁切或触控目标不足：${JSON.stringify(mobileChipGeometry)}`)
        }
        await mobileRemoveTeacherFilter.press('Enter')
        await page.waitForFunction(() => document.querySelectorAll('.pattern-panel .pattern-item').length === 4, undefined, { timeout: 5_000 })
        await page.screenshot({
            path: path.join(OUTPUT_DIR, 'mobile-evolution-pattern-linked-navigation.png'),
            fullPage: false,
        })
        evolutionPatternLinkedNavigationChecked = true
    } finally {
        await page.close()
    }
}

async function installLessonPlanGalleryFixture(page, { gateBrokenImage = false } = {}) {
    const imageA = `${BASE_URL}/images/generated/starmap/tongbian-036-v2.webp`
    const imageBroken = `${BASE_URL}/e2e-fixtures/gallery/lesson-broken.webp`
    const imageC = `${BASE_URL}/images/generated/starmap/tongbian-043-v2.webp`
    const templates = [
        {
            id: 'E2E-TEMPLATE-01',
            title: 'E2E 山水导入',
            grade: 'low',
            type: 'new',
            difficulty: 'basic',
            duration: 40,
            description: '仅用于轻量图库前端契约。',
            thumbnail: imageA,
            sections: [{ title: '导入', content: 'E2E 受控教学环节。' }],
            applicableKeywords: ['E2E'],
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_000,
        },
        {
            id: 'E2E-TEMPLATE-02',
            title: 'E2E 失效图片样本',
            grade: 'middle',
            type: 'review',
            difficulty: 'advanced',
            duration: 35,
            description: '仅用于图片失败恢复契约。',
            thumbnail: imageBroken,
            sections: [{ title: '复习', content: 'E2E 受控教学环节。' }],
            applicableKeywords: ['E2E'],
            createdAt: 1_700_000_000_001,
            updatedAt: 1_700_000_000_001,
        },
        {
            id: 'E2E-TEMPLATE-03',
            title: 'E2E 诗意拓展',
            grade: 'high',
            type: 'extension',
            difficulty: 'challenge',
            duration: 45,
            description: '仅用于顺序、键盘和触控边界。',
            thumbnail: imageC,
            sections: [{ title: '拓展', content: 'E2E 受控教学环节。' }],
            applicableKeywords: ['E2E'],
            createdAt: 1_700_000_000_002,
            updatedAt: 1_700_000_000_002,
        },
    ]

    let releaseBrokenRoute = () => {}
    const brokenGate = gateBrokenImage
        ? new Promise((resolve) => { releaseBrokenRoute = resolve })
        : Promise.resolve()
    let brokenRequestCount = 0

    await page.addInitScript(() => localStorage.removeItem('pr-demo-mode'))
    await page.route('**/api/lesson-plans/templates?*', (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ok', templates, total: templates.length }),
    }))
    await page.route('**/e2e-fixtures/gallery/lesson-broken.webp', async (route) => {
        brokenRequestCount += 1
        await brokenGate
        await route.abort('failed')
    })

    return {
        templates,
        releaseBroken: () => releaseBrokenRoute(),
        brokenRequests: () => brokenRequestCount,
    }
}

async function openControlledLessonPlanGallery(page) {
    await page.goto(`${BASE_URL}/lesson-plan`, { waitUntil: 'domcontentloaded' })
    await waitForSettledPage(page)
    const startPanel = page.locator('.pr-lp-tpl-start')
    await startPanel.waitFor({ state: 'visible', timeout: 10_000 })
    await startPanel.getByRole('button', { name: /查看「E2E 山水导入」/ }).click()
    await page.locator('.pr-lp-tpl-detail').waitFor({ state: 'visible', timeout: 10_000 })
    const gallery = page.locator('.pr-lp-tpl-sphere [data-sphere-gallery="lightweight"]')
    await gallery.waitFor({ state: 'visible', timeout: 10_000 })
    return gallery
}

async function dispatchHorizontalTouchSwipe(browserContext, page, track) {
    await track.scrollIntoViewIfNeeded()
    const box = await track.boundingBox()
    if (!box) throw new Error('触控画廊轨道没有可用几何')
    const viewport = page.viewportSize()
    const viewportWidth = viewport?.width ?? 390
    const viewportHeight = viewport?.height ?? 844
    const startX = Math.min(viewportWidth - 24, box.x + box.width - 24)
    const endX = Math.max(24, box.x + 28)
    const y = Math.max(24, Math.min(viewportHeight - 24, box.y + box.height / 2))
    const cdp = await browserContext.newCDPSession(page)
    await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: startX, y }],
    })
    for (const ratio of [0.18, 0.36, 0.54, 0.72, 0.88, 1]) {
        await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{ x: startX + (endX - startX) * ratio, y }],
        })
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await page.waitForTimeout(700)
}

/**
 * 教案模板图片画廊必须证明业务语义、失败恢复和真全屏预览，而不是继续测试
 * WebGL/CSS 两条渲染技术分支。夹具只控制模板目录和三张前端图片，其中一张
 * 故意中止；它不代表模板教学质量、图片来源或后端持久化。
 */
async function checkLessonPlanImageGalleryContract(context) {
    activeRoute = 'lesson-plan-image-gallery-contract'
    const page = await context.newPage()
    const fixture = await installLessonPlanGalleryFixture(page, { gateBrokenImage: true })
    try {
        await page.setViewportSize({ width: 1440, height: 900 })
        const gallery = await openControlledLessonPlanGallery(page)
        const track = gallery.locator('[data-gallery-track="true"]')
        const cards = gallery.locator('.pr-sphere-gallery-card[data-gallery-index]')
        await page.waitForFunction(() => (
            document.querySelectorAll('.pr-lp-tpl-sphere .pr-sphere-gallery-card[data-gallery-index]').length === 3
        ), undefined, { timeout: 10_000 })

        const staticAssets = [
            ['/images/generated/starmap/tongbian-003.webp', 640, 360],
            ['/images/generated/starmap/tongbian-007-v2.webp', 1280, 720],
            ['/images/generated/starmap/tongbian-011-v2.webp', 1280, 720],
            ['/images/generated/starmap/tongbian-036-v2.webp', 1280, 720],
            ['/images/generated/starmap/tongbian-043-v2.webp', 1280, 720],
            ['/images/generated/starmap/tongbian-078-v2.webp', 1280, 720],
            ['/images/generated/starmap/tongbian-s36-v2.webp', 1280, 720],
        ]
        for (const [assetPath] of staticAssets) {
            const response = await context.request.get(`${BASE_URL}${assetPath}`)
            const bytes = await response.body()
            const webpMagic = bytes.length >= 12
                && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
                && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
            if (!response.ok()
                || response.headers()['content-type']?.split(';')[0] !== 'image/webp'
                || !webpMagic) {
                fail(`随包 WebP 静态响应不合格：${assetPath} status=${response.status()} type=${response.headers()['content-type']} magic=${webpMagic}`)
            }
        }
        const decodedAssets = await page.evaluate(async (assets) => Promise.all(assets.map(([src, expectedWidth, expectedHeight]) => new Promise((resolve) => {
            const image = new Image()
            image.onload = () => resolve({ src, complete: image.complete, width: image.naturalWidth, height: image.naturalHeight, expectedWidth, expectedHeight })
            image.onerror = () => resolve({ src, complete: false, width: 0, height: 0, expectedWidth, expectedHeight })
            image.src = src
        }))), staticAssets)
        const invalidDecodedAsset = decodedAssets.find((asset) => !asset.complete
            || asset.width !== asset.expectedWidth || asset.height !== asset.expectedHeight)
        if (invalidDecodedAsset) {
            fail(`随包 WebP 浏览器解码或自然尺寸不合格：${JSON.stringify(invalidDecodedAsset)}`)
        }

        const initialContract = await gallery.evaluate((root, expectedTitles) => {
            const trackNode = root.querySelector('[data-gallery-track="true"]')
            const items = trackNode ? Array.from(trackNode.children) : []
            const cardsInRoot = Array.from(root.querySelectorAll('.pr-sphere-gallery-card[data-gallery-index]'))
            const focusableSelector = 'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
            const resourceNames = performance.getEntriesByType('resource').map((entry) => entry.name.toLowerCase())
            return {
                rootCount: document.querySelectorAll('.pr-lp-tpl-sphere [data-sphere-gallery="lightweight"]').length,
                role: root.getAttribute('role'),
                roledescription: root.getAttribute('aria-roledescription'),
                ariaLabel: root.getAttribute('aria-label'),
                count: root.getAttribute('data-gallery-count'),
                activeIndex: root.getAttribute('data-gallery-active-index'),
                selectedIndex: root.getAttribute('data-gallery-selected-index'),
                motion: root.getAttribute('data-gallery-motion'),
                activation: root.getAttribute('data-gallery-activation'),
                trackTag: trackNode?.tagName ?? null,
                itemCount: items.length,
                allItemsAreLi: items.every((item) => item.tagName === 'LI'),
                buttonCount: cardsInRoot.length,
                buttonTagsNative: cardsInRoot.every((card) => card.tagName === 'BUTTON' && card.getAttribute('role') === null),
                indices: cardsInRoot.map((card) => card.getAttribute('data-gallery-index')),
                ids: cardsInRoot.map((card) => card.getAttribute('data-gallery-id')),
                captionsMatch: cardsInRoot.every((card, index) => card.textContent?.includes(expectedTitles[index])),
                oneFocusablePerItem: items.every((item) => item.querySelectorAll(focusableSelector).length === 1),
                rovingCount: cardsInRoot.filter((card) => card.getAttribute('tabindex') === '0').length,
                currentCount: cardsInRoot.filter((card) => card.getAttribute('aria-current') === 'true').length,
                emptyImageAlt: cardsInRoot.every((card) => Array.from(card.querySelectorAll('img')).every((image) => image.getAttribute('alt') === '')),
                canvasCount: root.querySelectorAll('canvas').length,
                runtimeStyleCount: document.querySelectorAll('#pr-sphere-gallery-styles, style[data-sphere-gallery]').length,
                threeResourceCount: resourceNames.filter((name) => name.includes('three-vendor')).length,
                pageHasHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
            }
        }, fixture.templates.map((template) => template.title))
        if (initialContract.rootCount !== 1
            || initialContract.role !== 'region'
            || initialContract.roledescription !== '轮播图'
            || initialContract.ariaLabel !== '教案模板图片预览'
            || initialContract.count !== '3'
            || initialContract.activeIndex !== '0'
            || initialContract.selectedIndex !== '0'
            || initialContract.motion !== 'manual-only'
            || initialContract.activation !== 'preview'
            || initialContract.trackTag !== 'UL'
            || initialContract.itemCount !== 3
            || !initialContract.allItemsAreLi
            || initialContract.buttonCount !== 3
            || !initialContract.buttonTagsNative
            || JSON.stringify(initialContract.indices) !== JSON.stringify(['0', '1', '2'])
            || JSON.stringify(initialContract.ids) !== JSON.stringify(fixture.templates.map((template) => template.id))
            || !initialContract.captionsMatch
            || !initialContract.oneFocusablePerItem
            || initialContract.rovingCount !== 1
            || initialContract.currentCount !== 1
            || !initialContract.emptyImageAlt
            || initialContract.canvasCount !== 0
            || initialContract.runtimeStyleCount !== 0
            || initialContract.threeResourceCount !== 0
            || initialContract.pageHasHorizontalOverflow) {
            fail(`教案模板轻量画廊初始契约不合格：${JSON.stringify(initialContract)}`)
        }

        const failedCard = cards.nth(1)
        await failedCard.scrollIntoViewIfNeeded()
        await page.waitForFunction(() => (
            document.querySelector('.pr-sphere-gallery-card[data-gallery-index="1"]')
                ?.getAttribute('data-image-state') === 'loading'
        ), undefined, { timeout: 5_000 })
        const beforeFailure = await failedCard.evaluate((card) => {
            const cardRect = card.getBoundingClientRect()
            const mediaRect = card.querySelector('.pr-sphere-gallery-card__media')?.getBoundingClientRect()
            return {
                card: { width: cardRect.width, height: cardRect.height },
                media: mediaRect ? { width: mediaRect.width, height: mediaRect.height } : null,
            }
        })
        fixture.releaseBroken()
        await page.waitForFunction(() => (
            document.querySelector('.pr-sphere-gallery-card[data-gallery-index="1"]')
                ?.getAttribute('data-image-state') === 'failed'
        ), undefined, { timeout: 10_000 })
        const afterFailure = await failedCard.evaluate((card) => {
            const cardRect = card.getBoundingClientRect()
            const mediaRect = card.querySelector('.pr-sphere-gallery-card__media')?.getBoundingClientRect()
            return {
                card: { width: cardRect.width, height: cardRect.height },
                media: mediaRect ? { width: mediaRect.width, height: mediaRect.height } : null,
                imageCount: card.querySelectorAll('img').length,
                fallbackVisible: Boolean(card.querySelector('.pr-sphere-gallery-card__fallback')),
                label: card.getAttribute('aria-label'),
                disabled: card.hasAttribute('disabled'),
            }
        })
        const failureGeometryStable = beforeFailure.media && afterFailure.media
            && Math.abs(beforeFailure.card.width - afterFailure.card.width) <= 1
            && Math.abs(beforeFailure.card.height - afterFailure.card.height) <= 1
            && Math.abs(beforeFailure.media.width - afterFailure.media.width) <= 1
            && Math.abs(beforeFailure.media.height - afterFailure.media.height) <= 1
        if (fixture.brokenRequests() < 1
            || !failureGeometryStable
            || afterFailure.imageCount !== 0
            || !afterFailure.fallbackVisible
            || !afterFailure.label?.includes('图像暂不可用')
            || afterFailure.disabled) {
            fail(`教案模板失败图未保持稳定、可读且可激活：${JSON.stringify({ beforeFailure, afterFailure, brokenRequests: fixture.brokenRequests() })}`)
        }

        const assertActive = async (expectedIndex, boundary) => {
            try {
                await page.waitForFunction((index) => {
                    const root = document.querySelector('.pr-lp-tpl-sphere [data-sphere-gallery="lightweight"]')
                    const cardsInRoot = Array.from(root?.querySelectorAll('.pr-sphere-gallery-card[data-gallery-index]') ?? [])
                    const expected = root?.querySelector(`.pr-sphere-gallery-card[data-gallery-index="${index}"]`)
                    return root?.getAttribute('data-gallery-active-index') === String(index)
                        && document.activeElement === expected
                        && expected?.getAttribute('tabindex') === '0'
                        && expected?.getAttribute('aria-current') === 'true'
                        && cardsInRoot.filter((card) => card.getAttribute('tabindex') === '0').length === 1
                        && cardsInRoot.filter((card) => card.getAttribute('aria-current') === 'true').length === 1
                }, expectedIndex, { timeout: 5_000 })
            } catch (error) {
                const diagnostic = await gallery.evaluate((root) => {
                    const trackNode = root.querySelector('[data-gallery-track="true"]')
                    const cardsInRoot = Array.from(root.querySelectorAll('.pr-sphere-gallery-card[data-gallery-index]'))
                    return {
                        activeIndex: root.getAttribute('data-gallery-active-index'),
                        focusedIndex: document.activeElement?.getAttribute('data-gallery-index') ?? null,
                        focusedTag: document.activeElement?.tagName ?? null,
                        trackScrollLeft: trackNode?.scrollLeft ?? null,
                        trackClientWidth: trackNode?.clientWidth ?? null,
                        trackScrollWidth: trackNode?.scrollWidth ?? null,
                        cards: cardsInRoot.map((card) => ({
                            index: card.getAttribute('data-gallery-index'),
                            tabIndex: card.getAttribute('tabindex'),
                            current: card.getAttribute('aria-current'),
                            left: Math.round(card.getBoundingClientRect().left),
                            width: Math.round(card.getBoundingClientRect().width),
                        })),
                    }
                })
                throw new Error(`${boundary} 活动项、roving tabindex 或焦点未同步：${JSON.stringify(diagnostic)}`, { cause: error })
            }
            if (await page.locator('body > .pr-sphere-gallery-dialog-backdrop').count() !== 0) {
                fail(`${boundary} 漫游时提前打开了大图预览`)
            }
        }

        await cards.nth(0).focus()
        await cards.nth(0).press('ArrowLeft')
        await assertActive(2, '首项 ArrowLeft 循环')
        await cards.nth(2).press('ArrowRight')
        await assertActive(0, '末项 ArrowRight 循环')
        await cards.nth(0).press('ArrowRight')
        await assertActive(1, 'ArrowRight')
        await cards.nth(1).press('End')
        await assertActive(2, 'End')
        await cards.nth(2).press('Home')
        await assertActive(0, 'Home')

        await gallery.screenshot({ path: path.join(OUTPUT_DIR, 'desktop-lesson-plan-image-gallery.png') })
        await cards.nth(0).press('Space')
        const dialog = page.getByRole('dialog', { name: 'E2E 山水导入', exact: true })
        const backdrop = page.locator('body > .pr-sphere-gallery-dialog-backdrop')
        await dialog.waitFor({ state: 'visible', timeout: 5_000 })
        const close = dialog.getByRole('button', { name: '关闭图片预览', exact: true })
        await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '关闭图片预览')
        await page.waitForFunction(() => {
            const media = document.querySelector('body > .pr-sphere-gallery-dialog-backdrop .pr-sphere-gallery-dialog__media')
            const image = media?.querySelector('img')
            return media?.getAttribute('data-image-state') === 'loaded'
                && image instanceof HTMLImageElement
                && image.complete
                && image.naturalWidth === 1280
                && image.naturalHeight === 720
                && image.getBoundingClientRect().width > 0
                && image.getBoundingClientRect().height > 0
        }, undefined, { timeout: 10_000 })
        const dialogImage = dialog.locator('.pr-sphere-gallery-dialog__media img')
        await dialogImage.evaluate(async (image) => {
            if (!(image instanceof HTMLImageElement)) throw new Error('灯箱图片节点不存在')
            await image.decode()
            await new Promise((resolve) => requestAnimationFrame(() => resolve()))
            await new Promise((resolve) => requestAnimationFrame(() => resolve()))
        })
        const dialogContract = await backdrop.evaluate((overlay) => {
            const rect = overlay.getBoundingClientRect()
            const dialogNode = overlay.querySelector('[role="dialog"]')
            const image = dialogNode?.querySelector('img')
            const imageRect = image?.getBoundingClientRect()
            const imageStyle = image ? getComputedStyle(image) : null
            return {
                top: rect.top,
                left: rect.left,
                right: rect.right,
                bottom: rect.bottom,
                viewportWidth: window.innerWidth,
                viewportHeight: window.innerHeight,
                ariaModal: dialogNode?.getAttribute('aria-modal'),
                imageAlt: image?.getAttribute('alt') ?? null,
                imageComplete: image instanceof HTMLImageElement ? image.complete : false,
                imageNaturalWidth: image instanceof HTMLImageElement ? image.naturalWidth : 0,
                imageNaturalHeight: image instanceof HTMLImageElement ? image.naturalHeight : 0,
                imageRenderWidth: imageRect?.width ?? 0,
                imageRenderHeight: imageRect?.height ?? 0,
                imageOpacity: imageStyle?.opacity ?? null,
                imageObjectFit: imageStyle?.objectFit ?? null,
                imageState: image?.closest('.pr-sphere-gallery-dialog__media')?.getAttribute('data-image-state') ?? null,
                bodyChild: overlay.parentElement === document.body,
            }
        })
        if (dialogContract.top > 1
            || dialogContract.left > 1
            || dialogContract.right < dialogContract.viewportWidth - 1
            || dialogContract.bottom < dialogContract.viewportHeight - 1
            || dialogContract.ariaModal !== 'true'
            || dialogContract.imageAlt !== 'E2E 山水导入'
            || !dialogContract.imageComplete
            || dialogContract.imageNaturalWidth !== 1280
            || dialogContract.imageNaturalHeight !== 720
            || dialogContract.imageRenderWidth <= 0
            || dialogContract.imageRenderHeight <= 0
            || Number.parseFloat(dialogContract.imageOpacity ?? '0') < 0.99
            || dialogContract.imageObjectFit !== 'contain'
            || dialogContract.imageState !== 'loaded'
            || !dialogContract.bodyChild) {
            fail(`教案模板预览不是真全视口 Portal、未完成真实 WebP 解码或缺少完整语义：${JSON.stringify(dialogContract)}`)
        }
        await close.press('Shift+Tab')
        await page.waitForFunction(() => document.activeElement?.textContent?.includes('下一张') === true)
        await page.keyboard.press('Tab')
        await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '关闭图片预览')
        await page.screenshot({ path: path.join(OUTPUT_DIR, 'desktop-lesson-plan-image-gallery-lightbox.png'), fullPage: false })
        await page.keyboard.press('Escape')
        await dialog.waitFor({ state: 'hidden', timeout: 5_000 })
        await page.waitForFunction(() => document.activeElement?.getAttribute('data-gallery-index') === '0')

        await cards.nth(0).press('Enter')
        await dialog.waitFor({ state: 'visible', timeout: 5_000 })
        await close.click()
        await dialog.waitFor({ state: 'hidden', timeout: 5_000 })
        await page.waitForFunction(() => document.activeElement?.getAttribute('data-gallery-index') === '0')
        await cards.nth(0).press('Enter')
        await dialog.waitFor({ state: 'visible', timeout: 5_000 })
        await backdrop.click({ position: { x: 6, y: 6 } })
        await dialog.waitFor({ state: 'hidden', timeout: 5_000 })
        await page.waitForFunction(() => document.activeElement?.getAttribute('data-gallery-index') === '0')

        await failedCard.focus()
        await failedCard.press('Enter')
        const failedDialog = page.getByRole('dialog', { name: 'E2E 失效图片样本', exact: true })
        await failedDialog.waitFor({ state: 'visible', timeout: 5_000 })
        const failedDialogContract = await failedDialog.evaluate((node) => ({
            imageCount: node.querySelectorAll('img').length,
            statusCount: node.querySelectorAll('[role="status"][aria-live]').length,
            text: node.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        }))
        if (failedDialogContract.imageCount !== 0
            || failedDialogContract.statusCount !== 1
            || !failedDialogContract.text.includes('图像暂时无法显示')) {
            fail(`教案模板失败图预览仍有破图或缺少可读状态：${JSON.stringify(failedDialogContract)}`)
        }
        await page.screenshot({ path: path.join(OUTPUT_DIR, 'desktop-lesson-plan-image-gallery-failure.png'), fullPage: false })
        await page.keyboard.press('Escape')
        await failedDialog.waitFor({ state: 'hidden', timeout: 5_000 })

        const reducedIndex = await gallery.getAttribute('data-gallery-active-index')
        await page.waitForTimeout(450)
        const reducedContract = await gallery.evaluate((root) => {
            const durationsAreZero = (value) => value.split(',').every((part) => Number.parseFloat(part) === 0)
            const nodes = Array.from(root.querySelectorAll('.pr-sphere-gallery-card, .pr-sphere-gallery__nav'))
            return {
                mediaMatches: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
                motion: root.getAttribute('data-gallery-motion'),
                activeIndex: root.getAttribute('data-gallery-active-index'),
                transitionsZero: nodes.every((node) => durationsAreZero(window.getComputedStyle(node).transitionDuration)),
                runningAnimations: root.getAnimations({ subtree: true }).filter((animation) => animation.playState === 'running').length,
            }
        })
        if (!reducedContract.mediaMatches
            || reducedContract.motion !== 'manual-only'
            || reducedContract.activeIndex !== reducedIndex
            || !reducedContract.transitionsZero
            || reducedContract.runningAnimations !== 0) {
            fail(`教案模板画廊减弱动态仍存在自动推进或过渡：${JSON.stringify(reducedContract)}`)
        }

        await page.emulateMedia({ media: 'screen', reducedMotion: 'reduce', forcedColors: 'active' })
        await failedCard.focus()
        const forcedColorsContract = await failedCard.evaluate((card) => {
            const style = window.getComputedStyle(card)
            const fallback = card.querySelector('.pr-sphere-gallery-card__fallback')
            return {
                mediaMatches: window.matchMedia('(forced-colors: active)').matches,
                borderStyle: style.borderStyle,
                borderWidth: Number.parseFloat(style.borderWidth),
                outlineStyle: style.outlineStyle,
                outlineWidth: Number.parseFloat(style.outlineWidth),
                fallbackVisible: fallback ? window.getComputedStyle(fallback).display !== 'none' : false,
                pageHasHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
            }
        })
        if (!forcedColorsContract.mediaMatches
            || forcedColorsContract.borderStyle !== 'solid'
            || forcedColorsContract.borderWidth < 1
            || forcedColorsContract.outlineStyle === 'none'
            || forcedColorsContract.outlineWidth < 2
            || !forcedColorsContract.fallbackVisible
            || forcedColorsContract.pageHasHorizontalOverflow) {
            fail(`教案模板画廊强制色边界不完整：${JSON.stringify(forcedColorsContract)}`)
        }
        await gallery.screenshot({ path: path.join(OUTPUT_DIR, 'desktop-lesson-plan-image-gallery-forced-colors.png') })

        await page.emulateMedia({ media: 'print', reducedMotion: 'reduce', forcedColors: 'none' })
        const printContract = await gallery.evaluate((root) => {
            const trackNode = root.querySelector('[data-gallery-track="true"]')
            const nav = root.querySelector('.pr-sphere-gallery__nav')
            const item = root.querySelector('.pr-sphere-gallery__item')
            const card = root.querySelector('.pr-sphere-gallery-card')
            return {
                mediaMatches: window.matchMedia('print').matches,
                trackDisplay: trackNode ? window.getComputedStyle(trackNode).display : null,
                trackOverflowX: trackNode ? window.getComputedStyle(trackNode).overflowX : null,
                navDisplay: nav ? window.getComputedStyle(nav).display : null,
                itemBreakInside: item ? window.getComputedStyle(item).breakInside : null,
                cardTransform: card ? window.getComputedStyle(card).transform : null,
                cardCount: root.querySelectorAll('.pr-sphere-gallery-card').length,
            }
        })
        if (!printContract.mediaMatches
            || printContract.trackDisplay !== 'grid'
            || printContract.trackOverflowX !== 'visible'
            || printContract.navDisplay !== 'none'
            || printContract.itemBreakInside !== 'avoid'
            || printContract.cardTransform !== 'none'
            || printContract.cardCount !== 3) {
            fail(`教案模板画廊打印兜底不完整：${JSON.stringify(printContract)}`)
        }
        await gallery.screenshot({ path: path.join(OUTPUT_DIR, 'desktop-lesson-plan-image-gallery-print.png') })
        await page.emulateMedia({ media: 'screen', reducedMotion: 'reduce', forcedColors: 'none' })
        lessonPlanImageGalleryContractChecked = true
    } finally {
        fixture.releaseBroken()
        await page.close()
    }

    const browser = context.browser()
    if (!browser) {
        fail('教案模板画廊触控专项无法取得浏览器实例')
        return
    }
    const touchContext = await browser.newContext({
        storageState: await context.storageState(),
        viewport: { width: 390, height: 844 },
        locale: 'zh-CN',
        reducedMotion: 'no-preference',
        hasTouch: true,
        isMobile: true,
    })
    const touchPage = await touchContext.newPage()
    const touchFixture = await installLessonPlanGalleryFixture(touchPage)
    try {
        const gallery = await openControlledLessonPlanGallery(touchPage)
        const track = gallery.locator('[data-gallery-track="true"]')
        await touchPage.waitForFunction(() => {
            const firstCard = document.querySelector('.pr-lp-tpl-sphere .pr-sphere-gallery-card[data-gallery-index="0"]')
            const image = firstCard?.querySelector('img')
            return firstCard?.getAttribute('data-image-state') === 'loaded'
                && image instanceof HTMLImageElement
                && image.complete
                && image.naturalWidth === 1280
                && image.naturalHeight === 720
                && image.getBoundingClientRect().width > 0
                && image.getBoundingClientRect().height > 0
        }, undefined, { timeout: 10_000 })
        await gallery.screenshot({ path: path.join(OUTPUT_DIR, 'mobile-lesson-plan-image-gallery-loaded.png') })
        const before = await track.evaluate((node) => ({
            scrollLeft: node.scrollLeft,
            scrollWidth: node.scrollWidth,
            clientWidth: node.clientWidth,
            touchAction: window.getComputedStyle(node).touchAction,
            coarse: window.matchMedia('(pointer: coarse)').matches,
            noHover: window.matchMedia('(hover: none)').matches,
        }))
        await dispatchHorizontalTouchSwipe(touchContext, touchPage, track)
        const after = await track.evaluate((node) => ({
            scrollLeft: node.scrollLeft,
            activeIndex: node.closest('[data-sphere-gallery]')?.getAttribute('data-gallery-active-index'),
            dialogCount: document.querySelectorAll('body > .pr-sphere-gallery-dialog-backdrop').length,
            pageHasHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        }))
        const nativePanEnabled = before.touchAction === 'manipulation'
            || (before.touchAction.includes('pan-x') && before.touchAction.includes('pan-y'))
        if (before.scrollWidth <= before.clientWidth
            || before.touchAction === 'none'
            || !nativePanEnabled
            || (!before.coarse && !before.noHover)
            || after.scrollLeft <= before.scrollLeft + 5
            || Number(after.activeIndex) <= 0
            || after.dialogCount !== 0
            || after.pageHasHorizontalOverflow) {
            fail(`教案模板画廊真实触控横滑或页面边界不合格：${JSON.stringify({ before, after })}`)
        }
        await gallery.screenshot({ path: path.join(OUTPUT_DIR, 'mobile-lesson-plan-image-gallery-touch.png') })
        // SphereGallery 现在只服务教案模板；诗脉星图已按 33 号参考迁移为
        // 有边界的 OGL 旋转画廊，不能再把两种不同组件混成同一资源契约。
        sphereGalleryLightweightResourceBoundaryChecked = true
    } finally {
        touchFixture.releaseBroken()
        await touchContext.close()
    }
}

async function installStarMapGalleryFixture(page) {
    const graph = {
        nodes: [
            { id: 'E2E-STARMAP-01-JINGYESI', type: 'Poem', label: '静夜思', poet: '李白', dynasty: '唐', content: 'E2E 受控诗篇内容。' },
            { id: 'E2E-STARMAP-02-CHUNXIAO', type: 'Poem', label: '春晓', poet: '孟浩然', dynasty: '唐', content: 'E2E 受控诗篇内容。' },
            { id: 'E2E-STARMAP-03-DENGGUANQUELOU', type: 'Poem', label: '登鹳雀楼', poet: '王之涣', dynasty: '唐', content: 'E2E 受控诗篇内容。' },
        ],
        edges: [
            { source: 'E2E-STARMAP-01-JINGYESI', target: 'E2E-STARMAP-02-CHUNXIAO', type: 'SHARES_THEME', weight: 0.7, evidence: ['E2E 受控前端关系样本'], confidence: 'EXTRACTED' },
            { source: 'E2E-STARMAP-02-CHUNXIAO', target: 'E2E-STARMAP-03-DENGGUANQUELOU', type: 'SHARES_THEME', weight: 0.6, evidence: ['E2E 受控前端关系样本'], confidence: 'EXTRACTED' },
        ],
    }
    let successfulImageRequests = 0
    await page.addInitScript(() => localStorage.removeItem('pr-demo-mode'))
    await page.route('**/api/knowledge-graph/full', (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(graph),
    }))
    await page.route('**/api/knowledge-graph/mastery-colored?*', (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(graph),
    }))
    // 发布边界已经把同诗 WebP 固化到 public；这里让三张受控诗图全部走真实
    // 静态服务与浏览器解码。发布截图不得再故意制造缺图或用 SVG 冒充恢复态。
    await page.route('**/images/generated/starmap/**', async (route) => {
        successfulImageRequests += 1
        await route.continue()
    })
    return {
        graph,
        successfulImageRequests: () => successfulImageRequests,
    }
}

/**
 * 诗脉星图的目标形态来自 33 号“3D 旋转展示图像”参考：桌面、移动端和
 * 减少动态环境都默认使用一个有边界的 OGL 画布承载同诗位图。这里明确拒绝旧版
 * SphereGallery 契约、Three.js、SVG 占位、边缘模糊和无休止的自动轮播。
 */
async function checkStarMapFlyingPostersContract(context) {
    activeRoute = 'starmap-flying-posters-contract'
    const browser = context.browser()
    if (!browser) {
        fail('诗脉 3D 旋转画廊专项无法取得浏览器实例')
        return
    }

    const desktopContext = await browser.newContext({
        storageState: await context.storageState(),
        viewport: { width: 1440, height: 900 },
        locale: 'zh-CN',
        reducedMotion: 'no-preference',
    })
    const page = await desktopContext.newPage()
    const fixture = await installStarMapGalleryFixture(page)
    try {
        await page.goto(`${BASE_URL}/starmap`, { waitUntil: 'domcontentloaded' })
        await waitForSettledPage(page)
        const enableImmersive = page.getByTestId('starmap-toggle-immersive-view')
        const desktopViewAction = await enableImmersive.getAttribute('aria-label')
        if (desktopViewAction === '开启沉浸星图' || desktopViewAction === '返回诗境穹顶') {
            await enableImmersive.click()
        }

        const gallery = page.locator('.pr-sm-dome .pr-flying-posters[data-flying-posters="ogl"]')
        await gallery.waitFor({ state: 'visible', timeout: 10_000 })
        await page.waitForFunction(() => {
            const root = document.querySelector('.pr-sm-dome .pr-flying-posters[data-flying-posters="ogl"]')
            const state = root?.getAttribute('data-renderer-state')
            return state === 'ready' || state === 'fallback'
        }, undefined, { timeout: 10_000 })
        await page.waitForTimeout(500)

        const initial = await gallery.evaluate((root) => {
            const canvas = root.querySelector('.pr-flying-posters__canvas')
            const controls = root.querySelector('.pr-flying-posters__controls')
            const current = root.querySelector('.pr-flying-posters__current')
            const galleryRegion = root.closest('.pr-sm-dome-gallery-region')
            const relationLens = document.querySelector('.pr-sm-universe-lens > .pr-sm-relation-lens')
            const inactiveRelationChip = document.querySelector('.pr-sm-universe-lens .pr-sm-relation-chip:not(.is-active)')
            const resources = performance.getEntriesByType('resource').map((entry) => entry.name.toLowerCase())
            const rootStyle = getComputedStyle(root)
            const canvasStyle = canvas instanceof HTMLElement ? getComputedStyle(canvas) : null
            const controlsStyle = controls instanceof HTMLElement ? getComputedStyle(controls) : null
            const currentStyle = current instanceof HTMLElement ? getComputedStyle(current) : null
            const galleryRegionStyle = galleryRegion instanceof HTMLElement ? getComputedStyle(galleryRegion) : null
            const relationLensStyle = relationLens instanceof HTMLElement ? getComputedStyle(relationLens) : null
            const inactiveRelationChipStyle = inactiveRelationChip instanceof HTMLElement
                ? getComputedStyle(inactiveRelationChip)
                : null
            const rect = root.getBoundingClientRect()
            return {
                renderer: root.getAttribute('data-renderer-state'),
                canvasCount: root.querySelectorAll('canvas').length,
                canvasRole: canvas?.getAttribute('role'),
                canvasTabIndex: canvas instanceof HTMLElement ? canvas.tabIndex : null,
                controlsRole: controls?.getAttribute('role'),
                controlButtons: controls?.querySelectorAll(':scope > button').length ?? 0,
                currentText: current?.textContent?.replace(/\s+/gu, ' ').trim() ?? '',
                width: rect.width,
                height: rect.height,
                rootFilter: rootStyle.filter,
                rootBackdrop: rootStyle.backdropFilter,
                canvasFilter: canvasStyle?.filter ?? null,
                canvasBackdrop: canvasStyle?.backdropFilter ?? null,
                galleryRegionBorderWidth: galleryRegionStyle?.borderTopWidth ?? null,
                galleryRegionBorderRadius: galleryRegionStyle?.borderTopLeftRadius ?? null,
                galleryRegionBackground: galleryRegionStyle?.backgroundColor ?? null,
                galleryRegionShadow: galleryRegionStyle?.boxShadow ?? null,
                controlsBorderWidth: controlsStyle?.borderTopWidth ?? null,
                controlsBackground: controlsStyle?.backgroundColor ?? null,
                controlsShadow: controlsStyle?.boxShadow ?? null,
                currentBorderRadius: currentStyle?.borderTopLeftRadius ?? null,
                relationLensBackground: relationLensStyle?.backgroundColor ?? null,
                relationLensShadow: relationLensStyle?.boxShadow ?? null,
                inactiveRelationChipBackground: inactiveRelationChipStyle?.backgroundColor ?? null,
                inactiveRelationChipBorderRadius: inactiveRelationChipStyle?.borderTopLeftRadius ?? null,
                threeResources: resources.filter((name) => name.includes('three-vendor')).length,
                svgImageResources: resources.filter((name) => /\/images\/.*\.svg(?:\?|$)/u.test(name)).length,
                pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
            }
        })
        if (!['ready', 'fallback'].includes(initial.renderer)
            || initial.canvasCount !== 1
            || initial.canvasRole !== 'img'
            || initial.canvasTabIndex !== 0
            || initial.controlsRole !== 'group'
            || initial.controlButtons !== 3
            || !initial.currentText.includes('静夜思')
            || !initial.currentText.includes('1 / 3')
            || initial.width < 480
            || initial.height < 300
            || initial.rootFilter !== 'none'
            || initial.rootBackdrop !== 'none'
            || initial.canvasFilter !== 'none'
            || initial.canvasBackdrop !== 'none'
            || initial.galleryRegionBorderWidth !== '0px'
            || initial.galleryRegionBorderRadius !== '0px'
            || initial.galleryRegionBackground !== 'rgba(0, 0, 0, 0)'
            || initial.galleryRegionShadow !== 'none'
            || initial.controlsBorderWidth !== '0px'
            || initial.controlsBackground !== 'rgba(0, 0, 0, 0)'
            || initial.controlsShadow !== 'none'
            || initial.currentBorderRadius !== '0px'
            || initial.relationLensBackground !== 'rgba(0, 0, 0, 0)'
            || initial.relationLensShadow !== 'none'
            || initial.inactiveRelationChipBackground !== 'rgba(0, 0, 0, 0)'
            || initial.inactiveRelationChipBorderRadius !== '0px'
            || initial.threeResources !== 0
            || initial.svgImageResources !== 0
            || initial.pageOverflow
            || fixture.successfulImageRequests() < 3) {
            fail(`33号诗脉旋转画廊初始契约不合格：${JSON.stringify({ initial, successfulImages: fixture.successfulImageRequests() })}`)
        }

        const canvas = gallery.locator('.pr-flying-posters__canvas')
        await canvas.focus()
        await canvas.press('ArrowRight')
        await page.waitForFunction(() => (
            document.querySelector('.pr-sm-dome .pr-flying-posters__current strong')
                ?.textContent?.includes('春晓') === true
        ), undefined, { timeout: 5_000 })
        await canvas.press('Enter')
        const detailPanel = page.locator('.pr-sm-floating-panel')
        await page.waitForFunction(() => (
            document.querySelector('.pr-sm-floating-panel')?.getAttribute('aria-hidden') === 'false'
            && document.querySelector('.pr-sm-floating-panel .pr-sm-panel-title')?.textContent?.trim() === '春晓'
        ), undefined, { timeout: 10_000 })

        const resonanceLens = page.getByRole('button', { name: /诗篇共鸣/ })
        await resonanceLens.click()
        await page.waitForFunction(() => (
            document.querySelector('.pr-sm-dome')?.getAttribute('data-relation-lens') === 'resonance'
        ), undefined, { timeout: 5_000 })
        const relationText = await page.locator('.pr-sm-dome-poem-relations').textContent()
        if (!relationText?.includes('静夜思') || !relationText.includes('登鹳雀楼')) {
            fail(`3D 前景节点与真实关系证据未同步：${JSON.stringify({ relationText })}`)
        }

        await page.screenshot({ path: path.join(OUTPUT_DIR, 'desktop-starmap-33-flying-posters.png'), fullPage: false })
        await detailPanel.getByRole('button', { name: '关闭详情面板', exact: true }).press('Enter')
        await page.waitForFunction(() => (
            document.querySelector('.pr-sm-floating-panel')?.getAttribute('aria-hidden') === 'true'
            && document.activeElement?.classList.contains('pr-flying-posters__canvas') === true
        ), undefined, { timeout: 5_000 })

        const stableLabel = await gallery.locator('.pr-flying-posters__current').textContent()
        await page.waitForTimeout(700)
        if (await gallery.locator('.pr-flying-posters__current').textContent() !== stableLabel) {
            fail('33号诗脉旋转画廊空闲时仍自动换图')
        }

        const sourceFiles = [
            'src/components/ui/FlyingPosters.tsx',
            'src/pages/StarMapPage/StarMapDome.tsx',
        ]
        const sourceContents = await Promise.all(sourceFiles.map((file) => fs.readFile(path.resolve(file), 'utf8')))
        const sourceViolations = sourceFiles.flatMap((file, index) => [
            /from\s+['"]three['"]/u,
            /@react-three\//u,
            /\.svg(?:['"`?])/u,
            /setInterval\s*\(/u,
        ].filter((pattern) => pattern.test(sourceContents[index])).map((pattern) => `${file}:${pattern}`))
        if (!/distortion=\{3\}/u.test(sourceContents[1])) {
            sourceViolations.push('src/pages/StarMapPage/StarMapDome.tsx:distortion-must-match-reference-3')
        }
        const cssContents = await Promise.all([
            fs.readFile(path.resolve('src/components/ui/FlyingPosters.css'), 'utf8'),
            fs.readFile(path.resolve('src/pages/StarMapPage/StarMapDome.css'), 'utf8'),
        ])
        const hasNonNoneBackdrop = cssContents.some((source) => (
            [...source.matchAll(/(?:-webkit-)?backdrop-filter\s*:\s*([^;{}]+)/giu)]
                .some((match) => match[1]?.replace(/!important/giu, '').trim() !== 'none')
        ))
        if (cssContents.some((source) => /(?:^|[;{]\s*)filter\s*:\s*blur\s*\(/imu.test(source))
            || hasNonNoneBackdrop) {
            sourceViolations.push('FlyingPosters/StarMapDome.css:blur-or-backdrop-filter')
        }
        if (sourceViolations.length > 0) {
            fail(`33号诗脉旋转画廊源码边界回退：${sourceViolations.join(', ')}`)
        }
        starMapPoetryGalleryContractChecked = true
    } finally {
        await desktopContext.close()
    }

    const touchContext = await browser.newContext({
        storageState: await context.storageState(),
        viewport: { width: 390, height: 844 },
        locale: 'zh-CN',
        reducedMotion: 'reduce',
        hasTouch: true,
        isMobile: true,
    })
    const touchPage = await touchContext.newPage()
    await installStarMapGalleryFixture(touchPage)
    try {
        await touchPage.goto(`${BASE_URL}/starmap`, { waitUntil: 'domcontentloaded' })
        await waitForSettledPage(touchPage)
        const enableImmersive = touchPage.getByTestId('starmap-toggle-immersive-view')
        const mobileViewAction = await enableImmersive.getAttribute('aria-label')
        if (mobileViewAction === '开启沉浸星图' || mobileViewAction === '返回诗境穹顶') {
            await enableImmersive.click()
        }
        const gallery = touchPage.locator('.pr-sm-dome .pr-flying-posters[data-flying-posters="ogl"]')
        await gallery.waitFor({ state: 'visible', timeout: 10_000 })
        const next = gallery.getByRole('button', { name: '下一幅诗境图', exact: true })
        const current = gallery.locator('.pr-flying-posters__current')
        const mobile = await gallery.evaluate((root) => {
            const rect = root.getBoundingClientRect()
            const controls = Array.from(root.querySelectorAll('.pr-flying-posters__controls > button'))
            return {
                canvasCount: root.querySelectorAll('canvas').length,
                width: rect.width,
                viewportWidth: innerWidth,
                minControlWidth: Math.min(...controls.map((item) => item.getBoundingClientRect().width)),
                minControlHeight: Math.min(...controls.map((item) => item.getBoundingClientRect().height)),
                reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
                pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
                activeAnimations: root.getAnimations({ subtree: true })
                    .filter((animation) => animation.playState === 'running').length,
            }
        })
        if (mobile.canvasCount !== 1
            || mobile.width > mobile.viewportWidth + 1
            || mobile.minControlWidth < 44
            || mobile.minControlHeight < 44
            || !mobile.reduced
            || mobile.pageOverflow
            || mobile.activeAnimations !== 0) {
            fail(`33号诗脉旋转画廊移动端或减少动态契约不合格：${JSON.stringify(mobile)}`)
        }
        await next.click()
        await touchPage.waitForFunction(() => (
            document.querySelector('.pr-sm-dome .pr-flying-posters__current strong')
                ?.textContent?.includes('春晓') === true
        ), undefined, { timeout: 5_000 })
        await touchPage.screenshot({ path: path.join(OUTPUT_DIR, 'mobile-starmap-33-flying-posters.png'), fullPage: false })
        await current.click()
        await touchPage.waitForFunction(() => (
            document.querySelector('.pr-sm-floating-panel')?.getAttribute('aria-hidden') === 'false'
            && document.querySelector('.pr-sm-floating-panel .pr-sm-panel-title')?.textContent?.trim() === '春晓'
        ), undefined, { timeout: 10_000 })
        await touchPage.screenshot({ path: path.join(OUTPUT_DIR, 'mobile-starmap-detail-panel.png'), fullPage: false })
    } finally {
        await touchContext.close()
    }
}

/**
 * 不依赖在线服务的基础可访问性门禁。
 *
 * 这里不宣称替代 WCAG 专家审计或完整屏幕阅读器测试；它负责阻断最容易
 * 在组件迭代中回归、且能由浏览器 DOM 直接证明的缺陷：重复 id、无名称的
 * 可交互控件、缺少替代文本的图片，以及小于 WCAG 2.5.8 下限的点击目标。
 */
async function auditAccessibilityBasics(page) {
    return page.evaluate(() => {
        const isVisible = (element) => {
            const style = window.getComputedStyle(element)
            const rect = element.getBoundingClientRect()
            // 屏幕阅读器专用内容保留在可访问树中，但按定义不是视觉点击目标。
            if (element.classList.contains('pr-sr-only') || style.clipPath === 'inset(50%)') return false
            return style.display !== 'none' && style.visibility !== 'hidden' &&
                Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0
        }
        const describe = (element) => {
            const id = element.id ? `#${element.id}` : ''
            const className = typeof element.className === 'string' && element.className.trim()
                ? `.${element.className.trim().split(/\s+/u).slice(0, 3).join('.')}`
                : ''
            return `${element.tagName.toLowerCase()}${id}${className}`.slice(0, 180)
        }
        const textFromIds = (ids) => ids
            .split(/\s+/u)
            .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
            .filter(Boolean)
            .join(' ')
        const accessibleName = (element) => {
            const ariaLabel = element.getAttribute('aria-label')?.trim()
            if (ariaLabel) return ariaLabel
            const labelledBy = element.getAttribute('aria-labelledby')?.trim()
            if (labelledBy) {
                const text = textFromIds(labelledBy)
                if (text) return text
            }
            if (element instanceof HTMLInputElement ||
                element instanceof HTMLSelectElement ||
                element instanceof HTMLTextAreaElement) {
                if (element.labels && element.labels.length > 0) {
                    const text = [...element.labels].map((label) => label.textContent?.trim() ?? '').join(' ').trim()
                    if (text) return text
                }
            }
            const title = element.getAttribute('title')?.trim()
            if (title) return title
            const alt = element.getAttribute('alt')?.trim()
            if (alt) return alt
            return element.textContent?.trim() ?? ''
        }

        const duplicateIds = [...document.querySelectorAll('[id]')]
            .map((element) => element.id)
            .filter((id, index, ids) => id && ids.indexOf(id) !== index)
            .filter((id, index, ids) => ids.indexOf(id) === index)
            .slice(0, 12)

        const interactiveSelector = [
            'button:not([disabled])',
            'a[href]',
            'input:not([type="hidden"]):not([disabled])',
            'select:not([disabled])',
            'textarea:not([disabled])',
            '[role="button"]:not([aria-disabled="true"])',
            '[role="link"]:not([aria-disabled="true"])',
            '[role="checkbox"]:not([aria-disabled="true"])',
            '[role="combobox"]:not([aria-disabled="true"])',
            '[role="menuitem"]:not([aria-disabled="true"])',
            '[role="menuitemcheckbox"]:not([aria-disabled="true"])',
            '[role="menuitemradio"]:not([aria-disabled="true"])',
            '[role="option"]:not([aria-disabled="true"])',
            '[role="radio"]:not([aria-disabled="true"])',
            '[role="slider"]:not([aria-disabled="true"])',
            '[role="spinbutton"]:not([aria-disabled="true"])',
            '[role="switch"]:not([aria-disabled="true"])',
            '[role="tab"]:not([aria-disabled="true"])',
        ].join(',')
        const interactives = [...document.querySelectorAll(interactiveSelector)].filter(isVisible)
        const unnamed = interactives
            .filter((element) => accessibleName(element).length === 0)
            .map(describe)
            .slice(0, 12)
        const undersized = interactives
            .filter((element) => {
                if (element instanceof HTMLAnchorElement && element.textContent?.trim()) return false
                const rect = element.getBoundingClientRect()
                return rect.width < 24 || rect.height < 24
            })
            .map((element) => {
                const rect = element.getBoundingClientRect()
                return `${describe(element)}(${Math.round(rect.width)}x${Math.round(rect.height)})`
            })
            .slice(0, 12)
        const imagesWithoutAlt = [...document.querySelectorAll('img')]
            .filter(isVisible)
            .filter((image) => !image.hasAttribute('alt') && image.getAttribute('aria-hidden') !== 'true')
            .map(describe)
            .slice(0, 12)

        return {
            lang: document.documentElement.lang,
            duplicateIds,
            unnamed,
            undersized,
            imagesWithoutAlt,
            interactiveCount: interactives.length,
        }
    })
}

/**
 * 运行时校验“减少动态效果”偏好，而非只依赖样式表中存在媒体查询。
 *
 * 严格 E2E 固定以 reducedMotion: 'reduce' 建立浏览器上下文。这里检查两层
 * 可由 DOM 和 Web Animations API 直接证明的契约：CSS 动效/过渡必须已缩短为
 * 20ms 以内，且页面稳定后不得遗留长时运行中的 Web Animation。Three/WebGL
 * 等非 DOM 动效另由对应轻量视图专项回归覆盖，避免虚构浏览器无法观察的结论。
 */
async function auditReducedMotion(page) {
    return page.evaluate(() => {
        const MAX_REDUCED_MOTION_MS = 20
        const isVisible = (element) => {
            const style = window.getComputedStyle(element)
            const rect = element.getBoundingClientRect()
            return style.display !== 'none' && style.visibility !== 'hidden' &&
                Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0
        }
        const describe = (element) => {
            const id = element.id ? `#${element.id}` : ''
            const className = typeof element.className === 'string' && element.className.trim()
                ? `.${element.className.trim().split(/\s+/u).slice(0, 3).join('.')}`
                : ''
            return `${element.tagName.toLowerCase()}${id}${className}`.slice(0, 180)
        }
        const maxTimeMs = (rawValue) => Math.max(0, ...rawValue
            .split(',')
            .map((value) => value.trim())
            .map((value) => {
                const numeric = Number.parseFloat(value)
                if (!Number.isFinite(numeric)) return 0
                return value.endsWith('ms') ? numeric : numeric * 1000
            }))

        const cssDurationViolations = [...document.querySelectorAll('body *')]
            .filter(isVisible)
            .filter((element) => {
                const style = window.getComputedStyle(element)
                const animationTooLong = style.animationName !== 'none' &&
                    maxTimeMs(style.animationDuration) > MAX_REDUCED_MOTION_MS
                const transitionTooLong = style.transitionProperty !== 'none' &&
                    maxTimeMs(style.transitionDuration) > MAX_REDUCED_MOTION_MS
                return animationTooLong || transitionTooLong
            })
            .map(describe)
            .slice(0, 12)

        const activeLongRunningAnimations = document.getAnimations()
            .filter((animation) => {
                const activeDuration = animation.effect?.getComputedTiming().activeDuration
                return animation.playState === 'running' &&
                    typeof activeDuration === 'number' &&
                    activeDuration > MAX_REDUCED_MOTION_MS
            })
            .map((animation) => {
                const target = animation.effect?.target
                return target instanceof Element ? describe(target) : 'unknown-animation-target'
            })
            .slice(0, 12)

        return {
            mediaQueryMatches: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
            maxDurationMs: MAX_REDUCED_MOTION_MS,
            cssDurationViolations,
            activeLongRunningAnimations,
        }
    })
}

/**
 * 顶栏的移动品牌不应以半截英文省略号充当产品识别。
 *
 * 视觉上窄屏仅显示完整中文主品牌，桌面保留中英全称；完整名称由 sr-only
 * 文本提供给辅助技术。此处验证实际计算样式和 DOM 语义，防止后续样式回归。
 */
async function checkMobileBrandHierarchy(page) {
    const contract = await page.locator('.pr-header-brand-title:visible').evaluate((node) => {
        const visible = node.querySelector('.pr-header-brand-title__visible')
        const primary = node.querySelector('.pr-header-brand-title__primary')
        const secondary = node.querySelector('.pr-header-brand-title__secondary')
        const accessible = node.querySelector('.pr-sr-only')
        const rect = node.getBoundingClientRect()
        return {
            visibleText: visible?.innerText?.trim() ?? '',
            primaryText: primary?.textContent?.trim() ?? '',
            secondaryDisplay: secondary ? window.getComputedStyle(secondary).display : null,
            visibleAriaHidden: visible?.getAttribute('aria-hidden') ?? null,
            accessibleText: accessible?.textContent?.trim() ?? '',
            scrollWidth: Math.round(node.scrollWidth),
            clientWidth: Math.round(node.clientWidth),
            width: Math.round(rect.width),
        }
    })
    if (contract.primaryText !== '诗脉·启明'
        || contract.visibleText !== '诗脉·启明'
        || contract.secondaryDisplay !== 'none'
        || contract.visibleAriaHidden !== 'true'
        || contract.accessibleText !== '诗脉·启明 PoeticRealm AI v5.0'
        || contract.scrollWidth > contract.clientWidth + 1
        || contract.width <= 0) {
        fail(`移动端品牌层级或完整名称不符合契约：${JSON.stringify(contract)}`)
    }
    mobileBrandHierarchyChecked = true
}

async function checkRoute(page, route, viewportName) {
    activeRoute = `${viewportName}:${route.path}`
    const startedAt = Date.now()

    await page.goto(`${BASE_URL}${route.path}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
    })
    await waitForSettledPage(page)

    // 星图包含按需加载的 33 号 OGL 画廊与图谱接口。画廊是视觉主界面，尤其
    // 移动端不应为了满足任意“正文长度”而堆叠文案；因此用业务统计与真实 renderer
    // 终态判断加载完成，不能再以旧目录模式的文字量替代产品可用性证据。
    if (route.path === '/starmap') {
        await page.waitForFunction(() => {
            const marker = document.querySelector('[data-testid="starmap-library-nodes"] strong')
            const gallery = document.querySelector('.pr-sm-dome .pr-flying-posters[data-flying-posters="ogl"]')
            return Number(marker?.textContent?.trim()) > 0
                && ['ready', 'fallback'].includes(gallery?.getAttribute('data-renderer-state') ?? '')
                && gallery?.querySelectorAll('canvas').length === 1
        }, undefined, { timeout: 30_000 })
    }

    const currentUrl = new URL(page.url())
    const expectedPath = route.expectedPath ?? route.path
    if (currentUrl.pathname !== expectedPath) {
        fail(`路由落点错误：期望 ${expectedPath}，实际 ${currentUrl.pathname}`)
    }

    // 客户端重定向（例如 /diagnosis -> /dashboard）可能已改变 pathname，
    // 但标题和页面主体仍在从壳文本切换到业务内容。统一等待目标标题、
    // 业务标记与原有文本下限同时成立，避免把过渡态误判为最终页面。
    await page.waitForFunction(({ title, marker, visualRoute }) => {
        const text = (document.body.innerText ?? '').trim()
        return (!title || document.title.includes(title)) &&
            (!marker || text.includes(marker)) &&
            (visualRoute || text.length >= 120)
    }, {
        title: route.title ?? '',
        marker: route.marker ?? '',
        visualRoute: route.path === '/starmap',
    }, { timeout: 30_000 })

    const title = await page.title()
    if (route.title && !title.includes(route.title)) {
        fail(`页面标题错误：期望包含“${route.title}”，实际“${title}”`)
    }

    const bodyText = await page.locator('body').innerText()
    if (!bodyText.includes(route.marker)) {
        fail(`页面未出现业务标记“${route.marker}”`)
    }
    if (route.path !== '/starmap' && bodyText.trim().length < 120) {
        fail(`页面文本过少（${bodyText.trim().length} 字符），疑似空壳或加载失败`)
    }
    const fatalVisibleMarkers = [
        'undefined：',
        '[object Object]',
        '请求超时，请检查网络或稍后重试',
        '网络请求失败，请检查网络或稍后重试',
        '热点画像加载失败',
    ]
    for (const marker of fatalVisibleMarkers) {
        if (bodyText.includes(marker)) {
            fail(`页面出现未处理的运行故障文案：“${marker}”`)
        }
    }
    if (/(^|[^\p{L}])NaN([^\p{L}]|$)/u.test(bodyText)) {
        fail('页面出现 NaN 数值')
    }

    if (await page.locator('.pr-perf-monitor:visible, .pr-performance-monitor:visible').count() > 0) {
        fail('生产页面泄露了开发性能监控器')
    }

    // 可读内容绝不能依赖 CSS filter 模糊。装饰光晕可以在自己的无语义兄弟层上
    // 使用 blur，但任何可见文本或交互控件自身及其祖先一旦被模糊，就会同时损害
    // 可读性、命中感知与滚动合成性能。这里按真实 computed style 审计全部路由，
    // 避免把已被全局禁用的陈旧 backdrop 声明误报为运行时问题。
    const blurredReadableContent = await page.evaluate(() => {
        const candidates = new Set()
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
        while (walker.nextNode()) {
            const text = walker.currentNode.textContent?.trim() ?? ''
            const parent = walker.currentNode.parentElement
            if (text && parent) candidates.add(parent)
        }
        document.querySelectorAll('button, a[href], input, select, textarea, [role="dialog"]')
            .forEach((element) => candidates.add(element))
        const violations = []
        for (const candidate of candidates) {
            const rect = candidate.getBoundingClientRect()
            const ownStyle = getComputedStyle(candidate)
            if (rect.width <= 0 || rect.height <= 0
                || ownStyle.display === 'none'
                || ownStyle.visibility === 'hidden'
                || Number.parseFloat(ownStyle.opacity) <= 0) continue
            let current = candidate
            while (current && current !== document.documentElement) {
                const filter = getComputedStyle(current).filter
                if (/blur\(/u.test(filter)) {
                    violations.push({
                        candidate: `${candidate.tagName.toLowerCase()}${candidate.id ? `#${candidate.id}` : ''}${candidate.classList.length ? `.${[...candidate.classList].slice(0, 2).join('.')}` : ''}`,
                        blurredAncestor: `${current.tagName.toLowerCase()}${current.id ? `#${current.id}` : ''}${current.classList.length ? `.${[...current.classList].slice(0, 2).join('.')}` : ''}`,
                        filter,
                        text: candidate.textContent?.replace(/\s+/gu, ' ').trim().slice(0, 80) ?? '',
                    })
                    break
                }
                current = current.parentElement
            }
            if (violations.length >= 12) break
        }
        return violations
    })
    if (blurredReadableContent.length > 0) {
        fail(`可读内容或交互控件仍被 CSS filter 模糊：${JSON.stringify(blurredReadableContent)}`)
    }

    if (route.path === '/forbidden' || route.path === '/route-that-must-not-exist') {
        const starfield = page.locator('.pr-starfield')
        if (await starfield.count() !== 1) {
            fail('403/404 兜底页缺少唯一的轻量星空装饰层')
        } else {
            const contract = await starfield.evaluate((node) => {
                const layers = Array.from(node.querySelectorAll('.pr-starfield__layer'))
                const rect = node.getBoundingClientRect()
                const pageRoot = node.closest('.pr-forbidden, .pr-notfound')
                const pageRect = pageRoot?.getBoundingClientRect() ?? null
                return {
                    ariaHidden: node.getAttribute('aria-hidden'),
                    pointerEvents: window.getComputedStyle(node).pointerEvents,
                    position: window.getComputedStyle(node).position,
                    canvases: node.querySelectorAll('canvas').length,
                    layers: layers.length,
                    glows: node.querySelectorAll('.pr-starfield__glow').length,
                    animations: layers.map((layer) => window.getComputedStyle(layer).animationName),
                    mediaReduced: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
                    coversPage: pageRect !== null
                        && rect.left <= pageRect.left + 1
                        && rect.top <= pageRect.top + 1
                        && rect.right >= pageRect.right - 1
                        && rect.bottom >= pageRect.bottom - 1,
                    oglResources: performance.getEntriesByType('resource')
                        .filter((entry) => entry.name.includes('ogl-vendor')).length,
                }
            })
            if (contract.ariaHidden !== 'true'
                || contract.pointerEvents !== 'none'
                || !['fixed', 'absolute'].includes(contract.position)
                || contract.canvases !== 0
                || contract.layers !== 2
                || contract.glows !== 1
                || contract.animations.some((animation) => animation !== 'none')
                || !contract.mediaReduced
                || !contract.coversPage
                || contract.oglResources !== 0) {
                fail(`403/404 星空背景未保持无 Canvas/OGL、非交互、减弱动态静止与完整覆盖契约：${JSON.stringify(contract)}`)
            } else {
                starfieldFallbackRoutes.add(`${viewportName}:${route.path}`)
                starfieldBackgroundFallbackChecked = starfieldFallbackRoutes.size === 4
            }
        }
    }

    if (route.path === '/dashboard') {
        if (!bodyText.includes('当前展示内置演示学情，不代表真实教学成效')) {
            fail('演示种子数据未在驾驶舱显式披露')
        }
        const consistency = await page.evaluate(async () => {
            const [classesResponse, statsResponse] = await Promise.all([
                fetch('/api/classroom/classes'),
                fetch('/api/dashboard/stats?classId=class-001'),
            ])
            const classes = await classesResponse.json()
            const stats = await statsResponse.json()
            return {
                classCount: Array.isArray(classes.classes) ? classes.classes.length : -1,
                statsTotalClasses: stats.totalClasses,
                statsTotalStudents: stats.totalStudents,
            }
        })
        if (consistency.classCount !== consistency.statsTotalClasses) {
            fail(
                `班级统计不一致：列表 ${consistency.classCount}，驾驶舱 ${consistency.statsTotalClasses}`,
            )
        }
        if (consistency.statsTotalStudents !== 113) {
            fail(`空环境标准名册应为 113 人，实际 ${consistency.statsTotalStudents}`)
        }
        if (viewportName === 'desktop' && !memoryGovernanceChecked) {
            await checkMemoryGovernance(page)
        }
        if (viewportName === 'desktop' && !magicRingsDecorationChecked) {
            const rings = page.locator('.pr-innovation-card .pr-innovation-rings')
            await rings.waitFor({ state: 'visible', timeout: 10_000 })
            const contract = await rings.evaluate((node) => {
                const tracks = Array.from(node.querySelectorAll('.pr-magic-rings-track'))
                return {
                    ariaHidden: node.getAttribute('aria-hidden'),
                    svgs: node.querySelectorAll(':scope > svg').length,
                    tracks: tracks.length,
                    paths: node.querySelectorAll('path').length,
                    canvases: node.querySelectorAll('canvas').length,
                    pointerEvents: node.querySelector('svg')
                        ? window.getComputedStyle(node.querySelector('svg')).pointerEvents
                        : null,
                    animations: tracks.map((track) => window.getComputedStyle(track).animationName),
                    dashArrays: tracks.map((track) => window.getComputedStyle(track).strokeDasharray),
                    mediaReduced: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
                }
            })
            if (contract.ariaHidden !== 'true'
                || contract.svgs !== 1
                || contract.tracks !== 2
                || contract.paths !== 0
                || contract.canvases !== 0
                || contract.pointerEvents !== 'none'
                || contract.animations.some((animation) => animation !== 'none')
                || contract.dashArrays.some((dash) => dash !== 'none')
                || !contract.mediaReduced) {
                fail(`创新卡片光韵未保持零测量 SVG rect、装饰语义与减少动态静态轮廓契约：${JSON.stringify(contract)}`)
            } else {
                magicRingsDecorationChecked = true
            }
            await page.locator('.pr-innovation-card').screenshot({
                path: path.join(OUTPUT_DIR, 'desktop-dashboard-magic-rings.png'),
            })
        }
    }

    if (route.path === '/grading' && viewportName === 'desktop' && !gradingInitialActionChecked) {
        await checkGradingInitialAction(page)
    }

    // 命题工坊首屏不能让装饰图片把真实工作流压出评委视野：
    // 入口必须首屏可见，且点击后聚焦唯一的诗篇控件并打开其真实选择状态。
    if (route.path === '/workbench' && viewportName === 'desktop' && !workbenchPrimaryStartPathChecked) {
        const startButton = page.getByRole('button', { name: '选择目标诗篇，开始配置', exact: true })
        const poemSelect = page.getByRole('combobox', { name: '选择目标诗篇', exact: true })
        if (await startButton.count() !== 1) {
            fail('命题工坊首屏缺少唯一、明确的目标诗篇主行动入口')
        } else {
            const buttonBox = await startButton.boundingBox()
            if (!buttonBox || buttonBox.y < 0 || buttonBox.y + buttonBox.height > 900) {
                fail('命题工坊首屏主行动未完整出现在 1440×900 评审视口')
            }
            await page.waitForFunction(() => {
                const target = document.getElementById('wb-poem-select')
                return target instanceof HTMLInputElement && !target.disabled
            }, undefined, { timeout: 10_000 })
            await startButton.click()
            const focusResult = await page.waitForFunction(() => {
                const target = document.getElementById('wb-poem-select')
                if (!(target instanceof HTMLInputElement)) return null
                const rect = target.getBoundingClientRect()
                return document.activeElement === target
                    && target.getAttribute('aria-expanded') === 'true'
                    && rect.top >= 0
                    && rect.bottom <= window.innerHeight
                    && document.querySelectorAll('#wb-poem-select').length === 1
                    ? {
                        focused: true,
                        expanded: true,
                        visibleInViewport: true,
                        uniqueControl: true,
                    }
                    : null
            }, undefined, { timeout: 10_000 })
            if (!focusResult) {
                fail('命题工坊首屏主行动未将焦点带到可用的唯一诗篇选择控件')
            } else {
                workbenchPrimaryStartPathChecked = true
            }
            // 截图和后续通用布局检测应回到评审进入页面时的首屏，而不是打开的选项面板。
            await page.keyboard.press('Escape')
            await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'auto' }))
        }
    }

    if (route.path === '/classroom') {
        if (viewportName === 'desktop' && !classroomLaunchBriefFullTextChecked) {
            await checkClassroomLaunchBriefFullText(page)
        }
        if (viewportName === 'desktop' && !electricBorderDecorationChecked) {
            await checkElectricBorderDecoration(page)
        }
        if (viewportName === 'mobile' && !classroomMobileLaunchChecked) {
            await checkClassroomMobileLaunch(page)
        }
    }

    if (route.path === '/creation-studio') {
        if (!bodyText.includes('不代表真实学生数据、AI 结果或教学成效')) {
            fail('创作空库演示样例未显式披露数据性质')
        }
        if (!creationTaskPublishingChecked) {
            const openTaskComposer = page.getByRole('button', { name: '布置创造任务', exact: true })
            if (await openTaskComposer.count() !== 1) {
                fail('创作迭代台缺少真实创造任务发布入口')
            } else {
                await openTaskComposer.click()
                const composer = page.locator('#pr-creation-task-composer')
                await composer.waitFor({ state: 'visible', timeout: 10_000 })
                const poemSelect = composer.getByRole('combobox', { name: '目标诗篇' })
                await page.waitForFunction(() => {
                    const select = document.querySelector('#pr-creation-task-poem')
                    return select instanceof HTMLSelectElement && select.options.length > 0 && !select.disabled
                }, undefined, { timeout: 10_000 })
                const firstPoemId = await poemSelect.locator('option').first().getAttribute('value')
                if (!firstPoemId) {
                    fail('创造任务发布面板未提供可选诗篇')
                } else {
                    await poemSelect.selectOption(firstPoemId)
                    await composer.getByRole('textbox', { name: '任务要求' }).fill('请任选一句诗意象完成一段改写，并写明保留与改变的理由。')
                    await composer.getByRole('button', { name: '确认发布任务' }).click()
                    await page.getByRole('status').filter({ hasText: '已发布《' }).waitFor({ timeout: 10_000 })
                    if (await page.getByText('开放中', { exact: true }).count() === 0) {
                        fail('创造任务发布成功后未在任务看板回显开放状态')
                    } else {
                        creationTaskPublishingChecked = true
                    }
                }
            }
        }
        const gradeButton = page.getByRole('button', { name: 'AI 多维批改' }).first()
        if (await gradeButton.count() === 0) {
            fail('创作闭环缺少可操作的批改入口')
        } else {
            await gradeButton.click()
            await page.getByText('规则化演示', { exact: true }).first().waitFor({ timeout: 10_000 })
            const recreateButton = page.getByRole('button', { name: '应用反馈再创作' }).first()
            await recreateButton.click()
            await page.getByText(/\u89c4\u5219\u5316\u6f14\u793a\u5efa\u8bae/).first().waitFor({ timeout: 10_000 })
        }
    }

    if (route.path === '/ai-copilot') {
        const taskModeButton = page.getByRole('button', { name: '任务编排', exact: true })
        if (await taskModeButton.count() === 0) {
            fail('AI 副驾缺少从问答切换到任务编排的入口')
        } else {
            await taskModeButton.click()
            await page.getByText('编排官自动路由', { exact: true }).waitFor({ timeout: 5_000 })
            const pressed = await taskModeButton.getAttribute('aria-pressed')
            if (pressed !== 'true') fail(`任务编排模式未暴露选中状态：aria-pressed=${pressed}`)
            const input = page.getByRole('textbox', { name: '消息输入框' })
            const placeholder = await input.getAttribute('placeholder')
            if (!placeholder?.includes('先生成计划等待审批')) {
                fail(`任务编排输入框未披露审批前置条件：${placeholder ?? 'missing'}`)
            }
            await input.fill('分析三年级古诗学情并生成分层练习')
            await page.getByRole('button', { name: '生成待审批计划' }).click()
            await page.getByRole('heading', { name: '执行计划待确认' }).waitFor({ timeout: 5_000 })
            if (await page.getByRole('button', { name: /教师批准并执行/ }).count() !== 1) {
                fail('任务计划没有唯一、明确的教师批准入口')
            }
            await page.getByRole('button', { name: /修改输入/ }).first().click()
            const taskEditor = page.getByRole('textbox', { name: '任务输入 JSON' })
            await taskEditor.fill('{"classId":"class-001","focus":"意象理解"}')
            await page.getByRole('button', { name: '保存修改' }).click()
            if (!await page.getByText(/意象理解/).first().isVisible()) {
                fail('教师修改计划输入后未在审批面板中回显')
            }
            await page.getByRole('button', { name: /教师批准并执行/ }).click()
            await page.getByRole('heading', { name: '多智能体执行进度' }).waitFor({ timeout: 5_000 })
            const evidence = page.getByText('可验真运行证据', { exact: true })
            await evidence.waitFor({ timeout: 5_000 })
            await evidence.click()
            await page.getByText(/不保存完整提示词、学生姓名或模型原始输出/).waitFor({ timeout: 5_000 })
            if (await page.getByText('2', { exact: true }).count() === 0) {
                fail('运行证据未展示模型或 Agent 调用计数')
            }
        }
    }

    if (route.path === '/thinking-palace' && viewportName === 'desktop' && !ttsBinaryPlaybackChecked) {
        const recitationTab = page.getByRole('tab', { name: /AI 朗诵评分/ })
        await recitationTab.click()
        await page.getByRole('heading', { name: /朗诵范读/ }).waitFor({ timeout: 10_000 })
        const responsePromise = page.waitForResponse((response) => (
            new URL(response.url()).pathname === '/api/ai/tts'
            && response.request().method() === 'POST'
        ), { timeout: 15_000 })
        await page.getByRole('button', { name: '生成朗诵范读' }).click()
        const ttsResponse = await responsePromise
        const contentType = (ttsResponse.headers()['content-type'] ?? '').toLowerCase()
        if (ttsResponse.status() !== 200 || !contentType.startsWith('audio/')) {
            fail(`TTS 二进制响应契约异常：HTTP ${ttsResponse.status()}，Content-Type=${contentType || 'missing'}`)
        }
        const audio = page.locator('.poem-recitation__player audio')
        await audio.waitFor({ state: 'attached', timeout: 10_000 })
        const source = await audio.getAttribute('src')
        if (!source?.startsWith('blob:')) {
            fail(`TTS 二进制响应未转换为可播放 Blob URL：${source ?? 'missing'}`)
        }
        ttsBinaryPlaybackChecked = true
    }

    const visibleMainCount = await page
        .locator('main:visible, [role="main"]:visible, #pr-main-content:visible')
        .count()
    if (visibleMainCount === 0) {
        fail('没有可见的主内容区域')
    }

    const accessibility = await auditAccessibilityBasics(page)
    if (!accessibility.lang.toLowerCase().startsWith('zh')) {
        fail(`页面语言声明错误：${accessibility.lang || 'missing'}`)
    }
    if (accessibility.duplicateIds.length > 0) {
        fail(`存在重复 id：${accessibility.duplicateIds.join(', ')}`)
    }
    if (accessibility.unnamed.length > 0) {
        fail(`存在无可访问名称的交互控件：${accessibility.unnamed.join(', ')}`)
    }
    if (accessibility.undersized.length > 0) {
        fail(`存在小于 24px 的非文本点击目标：${accessibility.undersized.join(', ')}`)
    }
    if (accessibility.imagesWithoutAlt.length > 0) {
        fail(`存在缺少 alt/aria-hidden 的可见图片：${accessibility.imagesWithoutAlt.join(', ')}`)
    }

    // 星图路由使用独立的沉浸式 Shell，常规顶栏会保留在 DOM 中但不参与渲染；
    // 该 Shell 的抽屉/焦点契约由 checkImmersiveDrawerAccessibility 专项覆盖。
    // 仪表盘代表共享的常规 AppShell，适合作为此品牌层级的单一真实入口。
    if (viewportName === 'mobile' && route.path === '/dashboard') {
        await checkMobileBrandHierarchy(page)
    }

    const reducedMotion = await auditReducedMotion(page)
    if (!reducedMotion.mediaQueryMatches) {
        fail('浏览器上下文未启用 prefers-reduced-motion: reduce')
    }
    if (reducedMotion.cssDurationViolations.length > 0) {
        fail(`减少动态下存在超过 ${reducedMotion.maxDurationMs}ms 的 CSS 动效或过渡：${reducedMotion.cssDurationViolations.join(', ')}`)
    }
    if (reducedMotion.activeLongRunningAnimations.length > 0) {
        fail(`减少动态下页面稳定后仍存在长时运行中的 Web Animation：${reducedMotion.activeLongRunningAnimations.join(', ')}`)
    }
    reducedMotionComplianceChecked = true

    const layout = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
    }))
    const overflow = Math.max(layout.scrollWidth, layout.bodyScrollWidth) - layout.clientWidth
    if (overflow > 2) {
        const offenders = await page.evaluate(() => {
            const viewportWidth = document.documentElement.clientWidth
            return [...document.querySelectorAll('body *')]
                .map((element) => {
                    const rect = element.getBoundingClientRect()
                    return {
                        tag: element.tagName.toLowerCase(),
                        className: typeof element.className === 'string' ? element.className : '',
                        left: Math.round(rect.left),
                        right: Math.round(rect.right),
                        width: Math.round(rect.width),
                    }
                })
                .filter((item) => item.right > viewportWidth + 2 || item.left < -2)
                .sort((a, b) => b.right - a.right)
                .slice(0, 5)
        })
        fail(`存在 ${overflow}px 页面级横向溢出：${JSON.stringify(offenders)}`)
    }

    const safeName = route.path === '/'
        ? 'root'
        : route.path.replace(/^\//, '').replaceAll('/', '-')
    await page.screenshot({
        path: path.join(OUTPUT_DIR, `${viewportName}-${safeName}.png`),
        fullPage: false,
    })

    routeResults.push({
        viewport: viewportName,
        route: route.path,
        finalPath: currentUrl.pathname,
        title,
        textLength: bodyText.trim().length,
        overflow,
        accessibility,
        reducedMotion,
        durationMs: Date.now() - startedAt,
    })
}

async function run() {
    await fs.mkdir(OUTPUT_DIR, { recursive: true })

    const browser = await chromium.launch({
        headless: true,
        channel: 'chrome',
    })
    const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        locale: 'zh-CN',
        reducedMotion: 'reduce',
    })
    await context.route('**/api/copilot/chat', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                status: 'ok',
                sessionId: 'e2e-copilot-session',
                copilotStatus: 'planning',
                parsedInstruction: {
                    intent: 'composite',
                    subTasks: [
                        {
                            id: 'diagnose-class',
                            agentId: 'mind.diagnose',
                            input: { classId: 'class-001', focus: '古诗学情' },
                            dependencies: [],
                            status: 'pending',
                        },
                        {
                            id: 'generate-practice',
                            agentId: 'brush.question',
                            input: { classId: 'class-001', level: '分层' },
                            dependencies: ['diagnose-class'],
                            status: 'pending',
                        },
                    ],
                    executionPlan: {
                        nodes: [
                            {
                                id: 'diagnose-class', agentId: 'mind.diagnose',
                                input: { classId: 'class-001', focus: '古诗学情' },
                                dependencies: [], status: 'pending',
                            },
                            {
                                id: 'generate-practice', agentId: 'brush.question',
                                input: { classId: 'class-001', level: '分层' },
                                dependencies: ['diagnose-class'], status: 'pending',
                            },
                        ],
                        edges: [{ from: 'diagnose-class', to: 'generate-practice' }],
                    },
                    estimatedAgents: ['mind.diagnose', 'brush.question'],
                    estimatedDurationMs: 12_000,
                    confidence: 0.92,
                },
            }),
        })
    })
    await context.route('**/api/orchestrator/execute', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                status: 'ok',
                message: 'E2E 模拟执行已启动',
                sessionId: 'e2e-copilot-session',
            }),
        })
    })
    await context.route('**/api/orchestrator/sessions/*/trace?*', async (route) => {
        const now = Date.now()
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                status: 'ok',
                trace: {
                    summary: {
                        traceId: 'e2e-copilot-session',
                        sessionId: 'e2e-copilot-session',
                        status: 'running',
                        startedAt: now - 1200,
                        lastEventAt: now,
                        durationMs: 1200,
                        eventCount: 6,
                        llmCalls: 2,
                        agentCalls: 2,
                        retries: 0,
                        errors: 0,
                        fallbacks: 0,
                        evaluations: 1,
                        totalTokens: 860,
                        costYuan: 0.0186,
                        promptVersions: ['v2.0.0'],
                        models: ['deepseek-v4-pro'],
                    },
                    events: [
                        {
                            id: 'evidence-1', traceId: 'e2e-copilot-session',
                            sessionId: 'e2e-copilot-session', type: 'orchestrator:plan:approved',
                            layer: 'orchestrator', phase: 'approved', timestamp: now - 1200,
                        },
                        {
                            id: 'evidence-2', traceId: 'e2e-copilot-session',
                            sessionId: 'e2e-copilot-session', type: 'agent:call:start',
                            layer: 'agent', phase: 'start', timestamp: now - 900,
                            agentId: 'mind.diagnose', promptVersion: 'v2.0.0',
                        },
                    ],
                    privacy: {
                        rawPromptsStored: false,
                        rawOutputsStored: false,
                        studentIdentityStored: false,
                        policy: '仅保存模型、Agent、版本、耗时、Token、费用、降级与验收等白名单元数据',
                    },
                    truncated: false,
                },
            }),
        })
    })
    let memoryItems = [{
        id: 'memory-e2e-1',
        kind: 'teacher',
        userId: 'teacher-demo',
        content: '记忆治理演示',
        tags: ['teacher'],
        createdAt: Date.now() - 5_000,
        lastAccessedAt: Date.now() - 1_000,
        accessCount: 1,
        expiresAt: Date.now() + 86_400_000,
    }]
    await context.route('**/api/memory**', async (route) => {
        const request = route.request()
        const url = new URL(request.url())
        const body = ['POST', 'PATCH'].includes(request.method())
            ? (request.postDataJSON?.() ?? {})
            : {}
        const send = async (payload, status = 200) => route.fulfill({
            status,
            contentType: 'application/json',
            body: JSON.stringify({ status: 'ok', ...payload }),
        })
        if (request.method() === 'GET' && url.pathname === '/api/memory') {
            await send({ memories: memoryItems, total: memoryItems.length, governance: { authenticated: false, policy: 'e2e mock' } })
            return
        }
        if (request.method() === 'POST' && url.pathname === '/api/memory') {
            const item = {
                id: `memory-e2e-${memoryItems.length + 1}`,
                kind: body.kind ?? 'teacher',
                userId: body.teacherId,
                classId: body.classId,
                content: body.content,
                tags: body.tags ?? [],
                createdAt: Date.now(),
                lastAccessedAt: Date.now(),
                accessCount: 0,
                expiresAt: Date.now() + 86_400_000,
            }
            memoryItems = [...memoryItems, item]
            await send({ memory: item }, 201)
            return
        }
        if (request.method() === 'DELETE' && url.pathname === '/api/memory') {
            const before = memoryItems.length
            memoryItems = memoryItems.filter((item) => item.kind !== 'student')
            await send({ deleted: before - memoryItems.length })
            return
        }
        const id = url.pathname.split('/').filter(Boolean).at(-1)
        const existing = memoryItems.find((item) => item.id === id)
        if (request.method() === 'PATCH' && existing) {
            existing.content = body.content
            existing.lastAccessedAt = Date.now()
            await send({ memory: existing })
            return
        }
        if (request.method() === 'DELETE' && existing) {
            memoryItems = memoryItems.filter((item) => item.id !== id)
            await send({ deleted: 1 })
            return
        }
        await send({ error: 'NOT_FOUND', message: 'e2e memory mock route not found' }, 404)
    })
    const page = await context.newPage()

    page.on('console', (message) => {
        const text = message.text()
        if (message.type() === 'error') {
            if (expectedAuthStatusFailure
                && text.includes('Failed to load resource')
                && text.includes('503')) return
            fail(`console.error: ${text}`)
        } else if (message.type() === 'warning') {
            warnings.push(`[${activeRoute}] ${text}`)
        }
    })
    page.on('pageerror', (error) => {
        fail(`pageerror: ${error.message}`)
    })
    page.on('requestfailed', (request) => {
        const failure = request.failure()?.errorText ?? ''
        if (!isIgnorableNetworkFailure(request.url(), failure)) {
            fail(`请求失败：${request.method()} ${request.url()} (${failure})`)
        }
    })
    page.on('response', (response) => {
        if (response.status() >= 400) {
            if (expectedAuthStatusFailure
                && response.status() === 503
                && new URL(response.url()).pathname === '/api/auth/status') return
            fail(`HTTP ${response.status()}：${response.request().method()} ${response.url()}`)
        }
    })

    try {
        await checkPublicReportSharingContract(browser)

        // 聚焦门禁用于开发期快速复验本能力；正式 run-e2e-isolated 不设置该值，
        // 仍会执行下方完整竞赛回归并把两项结果写入统一证据。
        if (E2E_SCOPE === 'report-sharing') {
            activeRoute = `${AUTH_MODE}-login-for-report-sharing`
            await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded' })
            await page.locator('#login-password').waitFor({ state: 'visible', timeout: 10_000 })
            await page.locator('#login-phone').fill(AUTH_PHONE)
            await page.locator('#login-password').fill(AUTH_PASSWORD)
            await page.locator('.pr-login-submit').click()
            await page.waitForURL((url) => url.pathname === '/dashboard', { timeout: 15_000 })
            await waitForSettledPage(page)
            await checkReportShareManagementContract(context)
            if (failures.length > 0) {
                throw new Error(`报告分享聚焦 E2E 失败：${failures.join(' | ')}`)
            }
            console.log('报告分享聚焦 E2E 通过')
            return
        }

        activeRoute = 'auth-fail-closed'
        expectedAuthStatusFailure = true
        await page.route('**/api/auth/status', (route) => route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'SERVICE_UNAVAILABLE', message: 'intentional e2e outage' }),
        }))
        await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded' })
        await page.evaluate(() => localStorage.clear())
        await page.reload({ waitUntil: 'domcontentloaded' })
        const unavailable = page.locator('.pr-login-auth-state--error')
        await unavailable.waitFor({ state: 'visible', timeout: 15_000 })
        if (await page.locator('.pr-login-demo-btn').count() !== 0) {
            fail('认证状态不可用时仍暴露免密码 DEMO 快捷入口')
        }
        if (await page.locator('.pr-login-submit').isEnabled()) {
            fail('认证状态不可用时登录提交按钮未禁用')
        }
        authFailureClosedChecked = true
        await page.unroute('**/api/auth/status')
        expectedAuthStatusFailure = false

        activeRoute = 'auth-guard'
        await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded' })
        await page.evaluate(() => localStorage.clear())
        await page.reload({ waitUntil: 'domcontentloaded' })
        await page.locator('.pr-login').waitFor({ state: 'visible', timeout: 15_000 })
        if (new URL(page.url()).pathname !== '/login') {
            fail(`未登录访问受保护路由没有跳转 /login，实际 ${page.url()}`)
        }

        activeRoute = `${AUTH_MODE}-login`
        const passwordInput = page.locator('#login-password')
        await passwordInput.waitFor({ state: 'visible', timeout: 10_000 })
        if (await page.locator('.pr-login-demo-btn').count() !== 0) {
            fail('登录页仍暴露免密码 DEMO 快捷入口')
        }
        await page.locator('#login-phone').fill(AUTH_PHONE)
        await passwordInput.fill(AUTH_PASSWORD)
        await page.locator('.pr-login-submit').click()
        await page.waitForURL((url) => url.pathname === '/dashboard', { timeout: 15_000 })
        await waitForSettledPage(page)

        await checkKeyboardNavigation(page)

        for (const route of ROUTES) {
            await checkRoute(page, route, 'desktop')
        }

        await checkOfflineDisclosure(page)

        await page.setViewportSize({ width: 390, height: 844 })
        for (const route of ROUTES) {
            await checkRoute(page, route, 'mobile')
        }

        await page.setViewportSize({ width: 1440, height: 900 })
        await checkDashboardMagicBentoContract(context)
        await checkDashboardNavigationPrimitives(context)
        await checkDashboardTabKeyboard(context)
        await checkSidebarResizerKeyboard(context)
        await checkNotificationEmptyDialogFocus(context)
        await checkCommandPaletteMobile(context)
        await checkReportHistoryActionSemantics(context)
        await checkReportShareManagementContract(context)
        await checkLessonPlanStartExperience(context)
        await checkAICopilotMobileInitialAction(context)
        await checkCreationTaskMobileComposer(context)
        await checkGradingResultTableKeyboard(context)
        await checkWorkbenchPoemFallbackTruth(context)
        await checkWorkbenchRefineModalKeyboard(context)
        await checkCopilotMaterialTruthBoundary(context)
        await checkCopilotMarkdownImageRecovery(context)
        await checkCopilotAttachmentPreviewRecovery(context)
        await checkVoiceInputRecordingLifecycle(context)
        await checkQuickVoiceCaptureLifecycle(context)
        await checkClassroomTextSwitchContract(context)
        await checkClassroomPoemTruthAndInnovativeMode(context)
        await checkCulturePoemVerificationDisclosure(context)
        await checkPixelSnowDecorationContract(context)
        await checkThinkingPalaceLightweightAudit(context)
        await checkPoemImageCardAccessibility(context)
        await checkStarMapLightweightView(context)
        await checkEvolutionEmptyEvidence(context)
        await checkEvolutionPatternLinkedNavigation(context)
        await checkLessonPlanImageGalleryContract(context)
        await checkStarMapFlyingPostersContract(context)

        activeRoute = 'refresh-session'
        await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded' })
        await page.reload({ waitUntil: 'domcontentloaded' })
        await waitForSettledPage(page)
        if (new URL(page.url()).pathname !== '/dashboard') {
            fail('刷新后登录会话未恢复')
        }
    } finally {
        await fs.writeFile(
            path.join(OUTPUT_DIR, RESULTS_FILE),
            JSON.stringify({
                baseUrl: BASE_URL,
                routeResults,
                warnings,
                failures,
                memoryGovernanceChecked,
                offlineDisclosureChecked,
                keyboardNavigationChecked,
                authFailureClosedChecked,
                modalFocusManagementChecked,
                notificationEmptyDialogFocusChecked,
                commandPaletteMobileChecked,
                sidebarResizerKeyboardChecked,
                ttsBinaryPlaybackChecked,
                voiceInputLifecycleChecked,
                quickVoiceCaptureLifecycleChecked,
                lessonPlanStartChecked,
                toastOverflowChecked,
                gradingInitialActionChecked,
                gradingResultTableKeyboardChecked,
                gradingProgressTransitionKeyboardChecked,
                gradingStackGalleryAccessibilityChecked,
                gradingCardSwapMotionControlChecked,
                classroomMobileLaunchChecked,
                classroomLaunchBriefFullTextChecked,
                classroomTextSwitchContractChecked,
                electricBorderDecorationChecked,
                classroomStartFailureClosureChecked,
                reducedMotionComplianceChecked,
                mobileBrandHierarchyChecked,
                dashboardMagicBentoContractChecked,
                chapterNavigationRemovedChecked,
                dashboardAsyncContentVisibilityChecked,
                dashboardTabKeyboardChecked,
                dashboardAlertActionSemanticsChecked,
                reportHistoryActionSemanticsChecked,
                publicReportSharingChecked,
                reportShareManagementChecked,
                diagnosisStudentListKeyboardChecked,
                radarDecorationContractChecked,
                aiCopilotMobileInitialActionChecked,
                creationTaskPublishingChecked,
                creationTaskMobileComposerChecked,
                workbenchPoemFallbackTruthChecked,
                workbenchPrimaryStartPathChecked,
                workbenchRefineModalKeyboardChecked,
                workbenchRefineModalMobileChecked,
                workbenchRichMarkdownDetailAccessibilityChecked,
                copilotMaterialTruthBoundaryChecked,
                copilotMarkdownImageRecoveryChecked,
                copilotAttachmentPreviewRecoveryChecked,
                classroomPoemTruthAndInnovativeModeChecked,
                culturePoemVerificationDisclosureChecked,
                pixelSnowDecorationContractChecked,
                fallingTextTitleContractChecked,
                masonryGridContractChecked,
                thinkingPalaceLightweightAuditChecked,
            poemImageCardAccessibilityChecked,
            evolutionPatternLinkedNavigationChecked,
            starMapLightweightViewChecked,
            immersiveDrawerAccessibilityChecked,
                evolutionEmptyEvidenceChecked,
                lessonPlanImageGalleryContractChecked,
                starMapPoetryGalleryContractChecked,
                sphereGalleryLightweightResourceBoundaryChecked,
                starfieldBackgroundFallbackChecked,
                magicRingsDecorationChecked,
            }, null, 2),
            'utf8',
        )
        await context.close()
        await browser.close()
    }

    console.log(`严格回归：${routeResults.length} 个界面-视口组合`)
    console.log(`警告：${warnings.length}`)
    console.log(`失败：${failures.length}`)
    for (const item of failures) {
        console.error(`- ${item}`)
    }

    if (failures.length > 0) {
        process.exitCode = 1
    }
}

run().catch((error) => {
    console.error('严格 E2E 脚本异常：', error)
    process.exitCode = 1
})
