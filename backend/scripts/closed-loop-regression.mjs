/**
 * 生产集成闭环回归
 *
 * 前提：先以 NODE_ENV=production、DEMO_MODE=true 启动后端。
 * 本脚本会创建并结束一堂测试课堂，向 SQLite 写入一条测试作答和课堂报告。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const BASE_URL = process.env.CLOSED_LOOP_BASE_URL ?? 'http://127.0.0.1:3001'
const OUTPUT_PATH = path.resolve('..', 'docs', 'audit', 'closed-loop-latest.json')
const startedAt = new Date().toISOString()
let authCookie = ''
let csrfToken = ''

function assert(condition, message) {
    if (!condition) throw new Error(message)
}

async function request(pathname, init = {}) {
    const mutating = init.method && !['GET', 'HEAD', 'OPTIONS'].includes(String(init.method).toUpperCase())
    const response = await fetch(`${BASE_URL}${pathname}`, {
        ...init,
        headers: {
            accept: 'application/json',
            ...(authCookie ? { cookie: authCookie } : {}),
            ...(mutating && csrfToken ? { 'x-csrf-token': csrfToken } : {}),
            ...(init.body ? { 'content-type': 'application/json' } : {}),
            ...init.headers,
        },
    })
    const contentType = response.headers.get('content-type') ?? ''
    const body = contentType.includes('application/json')
        ? await response.json()
        : await response.text()
    return { response, body }
}

async function authenticate() {
    const response = await fetch(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '13177091153', password: 'Chy101713' }),
    })
    assert(response.status === 200, `闭环认证失败：HTTP ${response.status}`)
    const body = await response.json()
    const setCookies = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie') ?? '']
    const pairs = setCookies
        .flatMap((value) => [...value.matchAll(/\b(pr_(?:session|csrf)=[^;,]+)/gu)].map((match) => match[1]))
        .filter(Boolean)
    assert(pairs.length === 2 && typeof body?.csrfToken === 'string', '闭环认证响应不完整')
    authCookie = pairs.join('; ')
    csrfToken = body.csrfToken
}

async function main() {
    const health = await request('/api/health')
    assert(health.response.ok && health.body.status === 'ok', '健康检查失败')
    await authenticate()

    const classesResult = await request('/api/classroom/classes')
    assert(classesResult.response.ok, '班级列表接口失败')
    const selectedClass = classesResult.body.classes?.[0]
    assert(selectedClass?.id, '没有可用于闭环测试的班级')

    const studentsResult = await request(`/api/students?classId=${encodeURIComponent(selectedClass.id)}`)
    assert(studentsResult.response.ok, '学生列表接口失败')
    const selectedStudent = studentsResult.body.students?.[0]
    assert(selectedStudent?.id, '没有可用于闭环测试的脱敏学生')

    const poemsResult = await request('/api/workbench/poems')
    assert(poemsResult.response.ok, '诗目列表接口失败')

    let selectedPoem
    let readiness
    for (const poem of poemsResult.body.poems ?? []) {
        const candidate = await request(
            `/api/classroom/readiness?poemId=${encodeURIComponent(poem.id)}&mode=collective-race`,
        )
        if (candidate.response.ok && candidate.body.ready) {
            selectedPoem = poem
            readiness = candidate.body
            break
        }
    }
    assert(selectedPoem?.id && readiness?.ready, '没有六阶题库已就绪的诗目')
    const bloomLevels = ['记忆', '理解', '应用', '分析', '评价', '创造']
    assert(
        bloomLevels.every((level) => Number(readiness.bloomCoverage?.[level]) > 0),
        '就绪诗目没有覆盖完整六阶认知层级',
    )

    const start = await request('/api/classroom/start', {
        method: 'POST',
        body: JSON.stringify({
            classId: selectedClass.id,
            poemId: selectedPoem.id,
            mode: 'collective-race',
        }),
    })
    assert(start.response.ok && start.body.lessonId && start.body.joinCode, '课堂创建失败')
    const lessonId = start.body.lessonId

    const initialStatus = await request(`/api/classroom/${encodeURIComponent(lessonId)}/status`)
    assert(initialStatus.response.ok, '课堂状态读取失败')
    const question = initialStatus.body.currentQuestion
    assert(question?.id, '课堂没有下发首题')
    assert(!Object.hasOwn(question, 'answer'), '学生端题目响应泄露了标准答案')

    const untrustedName = '不应出现在响应中的真实姓名'
    const submittedAnswer = Array.isArray(question.options) && question.options.length > 0
        ? String(question.options[0])
        : '床前明月光'
    const submit = await request(`/api/classroom/${encodeURIComponent(lessonId)}/submit`, {
        method: 'POST',
        body: JSON.stringify({
            studentId: selectedStudent.id,
            studentName: untrustedName,
            questionId: question.id,
            answer: submittedAnswer,
            latencyMs: 1250,
        }),
    })
    assert(submit.response.ok, '课堂作答提交失败')

    const afterSubmit = await request(`/api/classroom/${encodeURIComponent(lessonId)}/status`)
    assert(afterSubmit.response.ok && afterSubmit.body.activeStudents === 1, '课堂参与状态没有更新')
    assert(!JSON.stringify(afterSubmit.body).includes(untrustedName), '课堂状态泄露了前端伪造姓名')

    const hotspot = await request(
        `/api/dashboard/class-hotspot?classId=${encodeURIComponent(selectedClass.id)}`,
    )
    assert(hotspot.response.ok, '课堂作答后班级热点接口失败')
    assert(
        hotspot.body.hotspot?.hotspots?.engagement?.hasObservedData === true,
        '课堂作答没有进入事件溯源，班级画像仍判定为无观察数据',
    )
    assert(
        Array.isArray(hotspot.body.activityRanking) && hotspot.body.activityRanking.length === 1,
        '有真实课堂事件后活跃度排行没有形成',
    )

    const refreshTrend = await request(
        `/api/dashboard/alerts/trend/refresh?classId=${encodeURIComponent(selectedClass.id)}`,
        { method: 'POST', body: '{}' },
    )
    assert(refreshTrend.response.ok && refreshTrend.body.generationTriggered === true, '趋势预警显式刷新失败')
    const persistedTrend = await request(
        `/api/dashboard/alerts/trend?classId=${encodeURIComponent(selectedClass.id)}`,
    )
    assert(persistedTrend.response.ok, '趋势预警持久化读取失败')
    assert(
        persistedTrend.body.total === refreshTrend.body.total,
        '趋势预警刷新结果未持久化或读取数量不一致',
    )

    let nextQuestionIndex = null
    if (initialStatus.body.totalQuestions > 1) {
        const next = await request(`/api/classroom/${encodeURIComponent(lessonId)}/next`, {
            method: 'POST',
            body: '{}',
        })
        assert(next.response.ok && next.body.currentQuestionIndex === 1, '课堂切换下一题失败')
        nextQuestionIndex = next.body.currentQuestionIndex
    }

    const end = await request(`/api/classroom/${encodeURIComponent(lessonId)}/end`, {
        method: 'POST',
        body: '{}',
    })
    assert(end.response.ok && end.body.report?.summary, '课堂结束或报告生成失败')

    const report = await request(`/api/classroom/${encodeURIComponent(lessonId)}/report`)
    assert(report.response.ok && report.body.report?.summary, '结束后报告不可重复读取')

    const spaResponse = await fetch(`${BASE_URL}/dashboard`, {
        headers: { accept: 'text/html' },
    })
    assert(spaResponse.ok && (spaResponse.headers.get('content-type') ?? '').includes('text/html'), 'SPA 深层路由刷新失败')
    assert(spaResponse.headers.has('content-security-policy'), '生产响应缺少 Content-Security-Policy')

    const missingApi = await request('/api/route-that-must-not-exist')
    assert(missingApi.response.status === 404, '未知 API 被 SPA fallback 错误吞掉')

    const evidence = {
        startedAt,
        finishedAt: new Date().toISOString(),
        baseUrl: BASE_URL,
        status: 'passed',
        checks: {
            health: true,
            signedSession: true,
            classAndStudentResolved: true,
            sixBloomLevelsCovered: true,
            classroomStarted: true,
            answerNotExposed: true,
            untrustedStudentNameNotExposed: true,
            answerSubmitted: true,
            learningEventObservedByHotspot: true,
            trendAlertsExplicitlyRefreshed: true,
            trendAlertsPersistentlyReadable: true,
            nextQuestionIndex,
            classroomEnded: true,
            reportPersistentlyReadable: true,
            spaDeepLink: true,
            contentSecurityPolicy: true,
            unknownApiReturns404: true,
        },
        entities: {
            classId: selectedClass.id,
            studentId: selectedStudent.id,
            poemId: selectedPoem.id,
            lessonId,
            questionId: question.id,
            joinCode: start.body.joinCode,
            questionCount: readiness.questionCount,
            bloomCoverage: readiness.bloomCoverage,
        },
        report: {
            summary: report.body.report.summary,
            aiGenerated: report.body.report.aiGenerated,
        },
    }

    await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true })
    await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
    console.log(`闭环回归通过：${lessonId}`)
    console.log(`证据：${OUTPUT_PATH}`)
}

main().catch(async (error) => {
    const failure = {
        startedAt,
        finishedAt: new Date().toISOString(),
        baseUrl: BASE_URL,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
    }
    await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true })
    await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(failure, null, 2)}\n`, 'utf8')
    console.error(`闭环回归失败：${failure.error}`)
    process.exitCode = 1
})
