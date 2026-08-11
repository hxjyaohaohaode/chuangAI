﻿/**
* 统一 API 客户端 —— 知识图谱模块
*
* 设计要点：
*  - 所有请求走 Vite 代理 /api（开发期转发至后端 3001）
*  - 统一 JSON 错误抛出，调用方 try/catch 即可
*  - 类型安全：每个方法的返回类型与 lib/types.ts 对齐
*  - 网络失败时由调用方降级至 mock 数据，保证页面可用
*  - v5.0 Task C.1.2：关键 API 响应添加运行时 shape 校验，
*    校验失败返回安全 fallback（防后端契约漂移导致前端崩溃）
*/

import { ApiError } from './errors'
import { isDemoMode } from './demo-mode'
import { v, validateOr, type Validator } from './validate'
// 本模块内所有 fetch（含 SSE、上传与二进制下载）统一携带同源会话与写请求 CSRF。
import { authenticatedFetch as fetch } from './auth-session'
import { consumeEvolutionPredictionStream } from './evolution-predict-stream'
import { parseAiAsrResponse, parseAiImageGenerateResponse } from './ai-contract'
import { errorFromSseFrame, requireExplicitSseTerminal } from './sse-protocol'
import {
    parseCreateShareResponse,
    parseListSharedReportsResponse,
    parsePreviewShareResponse,
} from './report-share-contract'
import { fetchPublicSharedReport } from './public-report-client'
import type {
    GraphData,
    GraphNode,
    GraphEdge,
    DashboardStats,
    BloomRadar,
    AlertsResponse,
    WeeklyProgressResponse,
    ClassroomMode,
    ClassroomReadiness,
    StartClassroomResponse,
    ClassroomStatus,
    SubmitResponse,
    HintResponse,
    DiscussResponse,
    ClassroomReport,
    Mastery,
    UploadResponse,
    RecognizeResponse,
    GradeRequestItem,
    GradeResponse,
    ReviewRequest,
    ReviewResponse,
    GradingBatch,
    GradingStudentOption,
    GradingQuestionOption,
    GradingBatchHistoryItem,
    WorkbenchGenerateRequest,
    WorkbenchGenerateResponse,
    WorkbenchRefineRequest,
    WorkbenchRefineResponse,
    WorkbenchQuestionsResponse,
    WorkbenchExportRequest,
    WorkbenchExportResponse,
    WorkbenchPublishRequest,
    WorkbenchPublishResponse,
    WorkbenchPoemOption,
    WorkbenchQuestionMeta,
    WorkbenchQuestionQuery,
    WorkbenchQuestionListResponse,
    WorkbenchFavoriteRequest,
    WorkbenchFavoriteResponse,
    WorkbenchQuestionVerification,
    WorkbenchDocExportRequest,
    WorkbenchDocExportResponse,
    WorkbenchSmartComposeRequest,
    WorkbenchSmartComposeResponse,
    WorkbenchAgentOrchestrateRequest,
    WorkbenchAgentEvent,
    WorkbenchAgentStreamCallbacks,
    WorkbenchAgentStreamController,
    StudentWeakPointsResponse,
    StudentOption,
    MemoryGovernanceListResponse,
    MemoryGovernanceItem,
    MemoryGovernanceCreateRequest,
    MemoryGovernanceUpdateRequest,
    CopilotChatRequest,
    CopilotChatResponse,
    CopilotSessionsResponse,
    CopilotSessionDetailResponse,
    CopilotQuickActionRequest,
    CopilotQuickActionResponse,
    CopilotFeedbackRequest,
    CopilotAgentLabelsResponse,
    CopilotStreamChatRequest,
    CopilotStreamChunk,
    CopilotStreamController,
    CopilotStreamCallbacks,
    OrchestratorExecuteRequest,
    OrchestratorExecuteResponse,
    OrchestratorTaskControlRequest,
    OrchestratorAbortRequest,
    OrchestratorModifyRequest,
    OrchestratorSessionResponse,
    OrchestratorTraceResponse,
    ReportGenerateRequest,
    ReportGenerateResponse,
    ReportGetResponse,
    ReportTemplatesResponse,
    ReportListResponse,
    ReportExportFormat,
    ReportChartsData,
    ReportPreviewData,
    ReportHistoryQuery,
    ReportHistoryResponse,
    ReportExportRequest,
    BloomDistributionResponse,
    HeatmapResponse,
    StudentProfileResponse,
    LearningPathResponse,
    DarkMatterListResponse,
    DarkMatterReportResponse,
    StudentGapsResponse,
    PrescriptionResponse,
    RecitationPoemsResponse,
    RecitationTtsRequest,
    RecitationTtsResponse,
    RecitationAsrResponse,
    RecitationEvaluateRequest,
    RecitationEvaluateResponse,
    RecitationHistoryResponse,
    RecitationLeaderboardResponse,
    RecitationAudioResponse,
    RecitationDeleteResponse,
    CreationTasksResponse,
    CreationTaskCreateRequest,
    CreationTaskCreateResponse,
    CollaborateStartRequest,
    CollaborateIterateRequest,
    CollaborationResponse,
    VisionDescribeRequest,
    VisionDescribeResponse,
    RewriteRequest,
    RewriteResponse,
    CreationWorksResponse,
    WorkSubmitRequest,
    WorkSubmitResponse,
    WorkLikeResponse,
    WorksWallResponse,
    CreationTaskType,
    CreationGradeRequest,
    CreationGradeResponse,
    CreationRecreateRequest,
    CreationRecreateResponse,
    CultureBackgroundResponse,
    CultureImagesResponse,
    CultureImageDetailResponse,
    CultureImageryResponse,
    ImmersiveStartResponse,
    ImmersiveStatusResponse,
    ImmersiveStopResponse,
    StartImmersiveBody,
    // Phase 2：诗内容教学类型（识字/译文/默写）
    PoemContent,
    // Phase 3：教师教学流程闭环类型（教案工坊）
    LessonPlan,
    LessonPlanGenerateRequest,
    LessonPlanGenerateResponse,
    LessonPlanSaveResponse,
    LessonPlanListResponse,
    // 智能备课 5 大能力类型
    PoemSearchQuery,
    PoemSearchResponse,
    PoemDetail,
    ObjectiveGenerateRequest,
    ObjectiveGenerateResponse,
    LayeredDesignRequest,
    LayeredDesignResponse,
    LessonGenerateRequest,
    LessonGenerateResponse,
    LessonStreamChunk,
    LessonStreamController,
    LessonStreamCallbacks,
    LessonRefineRequest,
    LessonRefineResponse,
    RefineStreamChunk,
    LessonResourcesResponse,
    // SubTask 25.5/25.6：教案模板 + AI 流式生成类型
    LessonPlanTemplate,
    LessonPlanTemplateListResponse,
    LessonPlanTemplateFilter,
    LessonPlanTemplateSort,
    LessonPlanAIGenerateRequest,
    LessonAIGenerateStreamChunk,
    LessonAIGenerateStreamController,
    LessonAIGenerateStreamCallbacks,
    // Phase 4.1：学生错题本 + 间隔重复类型（SM-2 算法）
    ErrorNotebookItem,
    ErrorNotebookListResponse,
    ReviewSubmitRequest,
    ReviewSubmitResponse,
    ReviewStatsResponse,
    // Phase 4.2：教学调整建议类型
    TeachingSuggestionResponse,
    // Phase 4.3：课堂讲解工具类型（逐句讲解 + 正音）
    ExplainResponse,
    // Phase 4.4：鉴赏指导类型（学生闭环 S5 运用）
    AppreciationGuideResponse,
    // 课堂指挥深化类型（Task 2/3/5）
    ScheduleStrategy,
    ScheduleNextResponse,
    ScheduleOverrideResponse,
    ScheduleStatusResponse,
    AISuggestionCategory,
    AISuggestionChunk,
    AfterActionReportGenerateResponse,
    AfterActionReportGetResponse,
    // 进化之眼基因谱类型
    GenealogyData,
    PatternItem,
    ABTestResultData,
    EvolutionPredictionDirection,
    EvolutionPredictRequest,
    EvolutionPredictionResult,
    // 思考宫殿 3D 链类型
    ThinkingChainsResponse,
    ThinkingChainDetailResponse,
    // 画像报告模块类型（能力 1-5）
    StudentProfile3DResponse,
    ClassHotspotResponse,
    TrendAlertsResponse,
    TrendAlertSeverity,
    TrendAlertRule,
    ProfileExportRequest,
    ProfileExportResponse,
    PreviewShareRequest,
    PreviewShareResponse,
    CreateShareRequest,
    CreateShareResponse,
    GetSharedReportResponse,
    ListSharedReportsResponse,
    WeeklyReportCreateRequest,
    WeeklyReportCreateResponse,
    WeeklyReportGetResponse,
    HomeSchoolRosterResponse,
    QuestSnapshot,
    SubmitFeedbackRequest,
    AddTeacherNoteRequest,
    // v5.0 Dashboard 数据真实化（Task：Dashboard 面板数据真实化）
    DashboardStatsV2,
    DashboardAlertV2,
    DashboardAlertsResponse,
    BloomRadarDataV2,
    ClassHotspotDataV2,
    InnovationData,
    WeeklyProgressData,
    // 批改诊断深化能力 1-5 类型
    MultiDimScoreRequest,
    MultiDimScoreOutput,
    BatchScoreRequest,
    BatchScoreResponse,
    HandwritingOcrRequest,
    HandwritingOcrOutput,
    BatchOcrRequest,
    BatchOcrResponse,
    ErrorAttributionRequest,
    ErrorAttributionOutput,
    LearningPathGenerateRequest,
    LearningPathOutput,
    PrescriptionGenerateRequest,
    PrescriptionOutput,
    AiChatStreamRequest,
    AiChatStreamChunk,
    AiChatStreamController,
    AiChatStreamCallbacks,
    // SubTask 27：诗篇重构 AI 能力扩展类型
    AiImageGenerateRequest,
    AiImageGenerateResponse,
    AiTtsRequest,
    AiTtsResponse,
    AiAsrRequest,
    AiAsrResponse,
    // v5.0 Task 18-20：单设备场景 + AI 虚拟对手 + 智能赋分 + AI 点评
    SmartScoreRequest,
    SmartScoreResult,
    ClassroomCommentChunk,
    AIOpponentAnswerRequest,
    AIOpponentAnswerResult,
    AIOpponentLevel,
    ModelCredentialSettings,
    CredentialTestResult,
} from './types'

// DEMO 兜底数据改为惰性加载（见 demo-registry 说明）：
// 这些模块合计约 180KB 源码，只在后端不可达时才会用到，
// 静态 import 会让每个用户的首屏都白白下载一遍。
import { loadDemo } from './demo-registry'

const API_BASE = '/api'

/** 默认请求超时时间（SubTask 3.5.1：fetch 请求超时兜底） */
const FETCH_TIMEOUT_MS = 15_000
const STREAM_HEADER_TIMEOUT_MS = 30_000
/** SSE/ReadableStream 两个数据帧之间的最大静默时间，防止流式接口无界挂起。 */
const STREAM_IDLE_TIMEOUT_MS = 120_000
const STREAM_IDLE_TIMEOUT_REASON = 'stream-idle-timeout'

/** 将外部取消信号联动到请求控制器，并提供确定性的监听器解绑。 */
function linkAbortSignal(
    externalSignal: AbortSignal | null | undefined,
    timeoutController: AbortController,
): () => void {
    if (!externalSignal) return () => { }
    if (externalSignal.aborted) {
        timeoutController.abort()
        return () => { }
    }
    const onAbort = () => timeoutController.abort()
    externalSignal.addEventListener('abort', onAbort, { once: true })
    return () => externalSignal.removeEventListener('abort', onAbort)
}

/**
 * 读取一个流式数据块并覆盖“正文已返回但后续永远没有数据”的边界。
 * 主动 abort 使用无 reason；只有本函数触发的静默超时携带专用 reason，
 * 调用方据此向教师显示可重试错误，而不会把用户主动中止误报成故障。
 */
async function readStreamChunk(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    controller: AbortController,
): Promise<ReadableStreamReadResult<Uint8Array>> {
    const timeoutId = window.setTimeout(
        () => controller.abort(STREAM_IDLE_TIMEOUT_REASON),
        STREAM_IDLE_TIMEOUT_MS,
    )
    try {
        return await reader.read()
    } finally {
        window.clearTimeout(timeoutId)
    }
}

/** 流式请求响应头也必须有上限；正文阶段另由 readStreamChunk 负责静默超时。 */
async function fetchStreamResponse(
    input: RequestInfo | URL,
    init: RequestInit,
    controller: AbortController,
): Promise<Response> {
    const timeoutId = window.setTimeout(
        () => controller.abort(STREAM_IDLE_TIMEOUT_REASON),
        STREAM_HEADER_TIMEOUT_MS,
    )
    try {
        return await fetch(input, { ...init, signal: controller.signal })
    } finally {
        window.clearTimeout(timeoutId)
    }
}

async function fetchJSON<T>(
    path: string,
    init?: RequestInit,
    timeoutMs = FETCH_TIMEOUT_MS,
): Promise<T> {
    // SubTask 3.5.1：fetch 请求超时兜底（AbortController + timeout）
    // 防止网络挂起时请求无限等待；AI 长任务可按端点覆盖超时。
    const timeoutController = new AbortController()
    const timeoutId = window.setTimeout(() => timeoutController.abort(), timeoutMs)

    // 如果调用方传入了 signal，联动 abort（外部 abort 同时触发 timeout abort）
    const externalSignal = init?.signal
    const unlinkExternalSignal = linkAbortSignal(externalSignal, timeoutController)

    let res: Response
    try {
        res = await fetch(`${API_BASE}${path}`, {
            ...init,
            headers: { 'Content-Type': 'application/json', ...init?.headers },
            signal: timeoutController.signal,
        })
    } catch (err) {
        window.clearTimeout(timeoutId)
        unlinkExternalSignal()
        // 网络错误：生产环境只抛静态文案，避免泄漏底层网络错误细节
        // 底层 API 函数不直接调用 toast，错误向上抛出由调用方决定是否提示用户
        if (import.meta.env.DEV) console.debug('[api] fetchJSON 网络错误:', err)
        // timeout 触发的 abort（非外部 signal 触发）
        if (timeoutController.signal.aborted && (!externalSignal || !externalSignal.aborted)) {
            if (import.meta.env.DEV) {
                throw new Error(`请求超时 (${path}, ${timeoutMs}ms)：请检查网络或稍后重试`)
            }
            throw new Error('请求超时，请检查网络或稍后重试')
        }
        if (import.meta.env.DEV) {
            const reason = err instanceof Error ? err.message : String(err)
            throw new Error(`网络请求失败 (${path}): ${reason}。请检查后端服务是否启动。`)
        }
        throw new Error('网络请求失败，请检查网络或稍后重试')
    }
    try {
        if (!res.ok) {
            // 401 是会话失效，必须重新登录；403 才是已认证但无权限。
            // 两者不能混到同一权限页，否则会把“身份不存在”误报为“权限不足”。
            if ((res.status === 401 || res.status === 403) && typeof window !== 'undefined') {
                const currentPath = window.location.pathname
                const target = res.status === 401 ? '/login' : '/forbidden'
                if (currentPath !== target) {
                    const from = encodeURIComponent(currentPath + window.location.search)
                    window.location.href = `${target}?from=${from}`
                    // 抛出错误以中断当前 Promise 链（跳转过程中后续代码不应继续执行）
                    throw new ApiError(
                        res.status,
                        res.statusText,
                        res.status === 401 ? '登录会话已失效，正在返回登录页' : '权限不足，正在跳转至 403 页面',
                    )
                }
            }
            if (import.meta.env.DEV) {
                const text = await res.text().catch((error) => {
                    // 错误响应的正文也受同一超时保护，不能用 catch 把 AbortError 吞掉。
                    if (timeoutController.signal.aborted && (!externalSignal || !externalSignal.aborted)) {
                        throw new Error(`请求超时 (${path}, ${timeoutMs}ms)：请检查网络或稍后重试`)
                    }
                    if (import.meta.env.DEV) console.debug('[api] fetchJSON 错误正文读取失败:', error)
                    return ''
                })
                throw new ApiError(res.status, res.statusText, text || undefined)
            }
            throw new ApiError(res.status, res.statusText)
        }

        try {
            // 超时必须覆盖正文消费，而不只是 fetch() 收到响应头之前。
            return await res.json() as T
        } catch (err) {
            if (timeoutController.signal.aborted && (!externalSignal || !externalSignal.aborted)) {
                throw new Error(`请求超时 (${path}, ${timeoutMs}ms)：请检查网络或稍后重试`)
            }
            // JSON 解析失败：生产环境只抛静态文案
            // 底层 API 函数不直接调用 toast，错误向上抛出由调用方决定是否提示用户
            if (import.meta.env.DEV) console.debug('[api] fetchJSON 响应解析失败:', err)
            if (import.meta.env.DEV) {
                const reason = err instanceof Error ? err.message : String(err)
                throw new Error(`响应解析失败 (${path}): ${reason}`)
            }
            throw new Error('响应解析失败，请稍后重试')
        }
    } finally {
        window.clearTimeout(timeoutId)
        unlinkExternalSignal()
    }
}

/**
 * fetchBlob —— 下载二进制文件（Word/Excel/PDF 等）
 *
 * 与 fetchJSON 相同的超时 / abort / 错误处理策略，
 * 但返回 Blob 而非 JSON，供前端触发浏览器下载。
 */
async function fetchBlob(path: string, init?: RequestInit): Promise<Blob> {
    if (isDemoMode()) {
        throw new Error('演示模式：后端服务未启动')
    }

    const timeoutController = new AbortController()
    const timeoutId = window.setTimeout(() => timeoutController.abort(), FETCH_TIMEOUT_MS)

    const externalSignal = init?.signal
    const unlinkExternalSignal = linkAbortSignal(externalSignal, timeoutController)

    let res: Response
    try {
        res = await fetch(`${API_BASE}${path}`, {
            ...init,
            signal: timeoutController.signal,
        })
    } catch (err) {
        window.clearTimeout(timeoutId)
        unlinkExternalSignal()
        if (import.meta.env.DEV) console.debug('[api] fetchBlob 网络错误:', err)
        if (timeoutController.signal.aborted && (!externalSignal || !externalSignal.aborted)) {
            throw new Error('请求超时，请检查网络或稍后重试')
        }
        throw new Error('网络请求失败，请检查网络或稍后重试')
    }
    try {
        // 超时保持到 Blob 正文完整读取结束，避免收到响应头后正文挂起导致无限等待。
        if (!res.ok) {
            if (import.meta.env.DEV) {
                const text = await res.text().catch((error) => {
                    if (timeoutController.signal.aborted && (!externalSignal || !externalSignal.aborted)) {
                        throw new Error('请求超时，请检查网络或稍后重试')
                    }
                    if (import.meta.env.DEV) console.debug('[api] fetchBlob 错误正文读取失败:', error)
                    return ''
                })
                throw new ApiError(res.status, res.statusText, text || undefined)
            }
            throw new ApiError(res.status, res.statusText)
        }
        return await res.blob()
    } catch (err) {
        if (import.meta.env.DEV) console.debug('[api] fetchBlob 响应解析失败:', err)
        if (err instanceof ApiError) throw err
        if (timeoutController.signal.aborted && (!externalSignal || !externalSignal.aborted)) {
            throw new Error('请求超时，请检查网络或稍后重试')
        }
        throw new Error('文件下载失败，请稍后重试')
    } finally {
        window.clearTimeout(timeoutId)
        unlinkExternalSignal()
    }
}

/**
 * POST /api/ai/tts 的协议是二进制音频，不是 JSON。
 *
 * 返回 Blob URL 供 <audio> 使用；调用组件必须在替换或卸载时 revoke。
 * 仅在明确的 DEMO 状态且网络层不可达时生成本地合法静音 WAV，响应 4xx/5xx、
 * MIME 错误或空音频仍失败关闭，避免把服务端契约回归伪装成降级成功。
 */
async function fetchTtsAudio(req: AiTtsRequest): Promise<AiTtsResponse> {
    const timeoutController = new AbortController()
    const timeoutMs = 60_000
    const timeoutId = window.setTimeout(() => timeoutController.abort(), timeoutMs)
    let res: Response
    try {
        res = await fetch(`${API_BASE}/ai/tts`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'audio/*',
            },
            body: JSON.stringify({
                text: req.text,
                voice: req.voice ?? 'mimo_default',
                speed: req.speed ?? 1.0,
                responseFormat: req.responseFormat ?? 'mp3',
                poemId: req.poemId,
            }),
            signal: timeoutController.signal,
        })
    } catch (error) {
        window.clearTimeout(timeoutId)
        if (isDemoMode()) {
            const sampleRate = 8_000
            const durationMs = 1_000
            const dataSize = sampleRate * 2
            const buffer = new ArrayBuffer(44 + dataSize)
            const view = new DataView(buffer)
            const writeAscii = (offset: number, value: string) => {
                for (let index = 0; index < value.length; index += 1) {
                    view.setUint8(offset + index, value.charCodeAt(index))
                }
            }
            writeAscii(0, 'RIFF')
            view.setUint32(4, 36 + dataSize, true)
            writeAscii(8, 'WAVE')
            writeAscii(12, 'fmt ')
            view.setUint32(16, 16, true)
            view.setUint16(20, 1, true)
            view.setUint16(22, 1, true)
            view.setUint32(24, sampleRate, true)
            view.setUint32(28, sampleRate * 2, true)
            view.setUint16(32, 2, true)
            view.setUint16(34, 16, true)
            writeAscii(36, 'data')
            view.setUint32(40, dataSize, true)
            return {
                status: 'ok',
                audioUrl: URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' })),
                durationMs,
                cached: false,
                model: 'demo-local-silence',
                aiGenerated: false,
            }
        }
        if (import.meta.env.DEV) console.debug('[api] TTS 网络错误:', error)
        if (timeoutController.signal.aborted) throw new Error('语音合成超时，请稍后重试')
        throw new Error('语音合成服务不可用，请检查网络或稍后重试')
    }
    try {
        if (!res.ok) {
            if (import.meta.env.DEV) {
                const text = await res.text().catch((error) => {
                    if (timeoutController.signal.aborted) throw new Error('语音合成超时，请稍后重试')
                    if (import.meta.env.DEV) console.debug('[api] TTS 错误正文读取失败:', error)
                    return ''
                })
                throw new ApiError(res.status, res.statusText, text || undefined)
            }
            throw new ApiError(res.status, res.statusText)
        }
        const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
        if (!contentType.startsWith('audio/')) {
            throw new Error('语音合成响应格式异常，请稍后重试')
        }
        // 超时保持到音频 Blob 正文读取完成，避免仅收到响应头后正文挂起。
        const blob = await res.blob()
        if (blob.size === 0) throw new Error('语音合成返回空音频，请稍后重试')
        const durationHeader = Number(res.headers.get('x-duration-ms'))
        return {
            status: 'ok',
            audioUrl: URL.createObjectURL(blob),
            durationMs: Number.isFinite(durationHeader) && durationHeader >= 0 ? durationHeader : 0,
            cached: false,
            model: res.headers.get('x-model') || 'mimo-v2.5-tts',
            aiGenerated: res.headers.get('x-demo-mode') !== 'true',
        }
    } catch (error) {
        if (error instanceof ApiError) throw error
        if (timeoutController.signal.aborted) throw new Error('语音合成超时，请稍后重试')
        if (error instanceof Error && (
            error.message === '语音合成响应格式异常，请稍后重试'
            || error.message === '语音合成返回空音频，请稍后重试'
        )) {
            throw error
        }
        if (import.meta.env.DEV) console.debug('[api] TTS 响应读取失败:', error)
        throw new Error('语音合成响应读取失败，请稍后重试')
    } finally {
        window.clearTimeout(timeoutId)
    }
}

/**
 * streamAgentOrchestrateSSE —— Agent 编排 SSE 流式接收
 *
 * 端点：POST /api/agents/orchestrate
 * 协议：SSE，每个 data: 帧为一个 WorkbenchAgentEvent JSON
 * 终止：收到 [DONE] 标记或 session:end 事件
 *
 * 复用 streamDiagnosisSSE 的帧解析模式：
 *   - 按 \n\n 切帧
 *   - 提取 data: 行 JSON
 *   - [DONE] 标记结束
 *   - event.error 触发 onError
 */
function streamAgentOrchestrateSSE(
    body: WorkbenchAgentOrchestrateRequest,
    callbacks: WorkbenchAgentStreamCallbacks,
): WorkbenchAgentStreamController {
    const controller = new AbortController()
    let streaming = true

    void (async () => {
        try {
            const res = await fetchStreamResponse(`${API_BASE}/agents/orchestrate`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'text/event-stream',
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            }, controller)

            if (!res.ok) {
                let errMsg = `HTTP ${res.status} ${res.statusText}`
                try {
                    const ct = res.headers.get('content-type') ?? ''
                    if (ct.includes('application/json')) {
                        const errJson = (await res.json()) as { message?: string; error?: string }
                        if (errJson.message) errMsg = errJson.message
                        else if (errJson.error) errMsg = errJson.error
                    } else {
                        const text = await res.text()
                        if (text) errMsg = text
                    }
                } catch {
                    // 响应体解析失败
                }
                throw new Error(errMsg)
            }

            if (!res.body) {
                throw new Error('响应体为空，无法消费 SSE 流')
            }

            const reader = res.body.getReader()
            const decoder = new TextDecoder('utf-8')
            let buffer = ''
            let terminalSeen = false

            // eslint-disable-next-line no-constant-condition
            while (true) {
                const { done, value } = await readStreamChunk(reader, controller)
                if (done) break

                buffer += decoder.decode(value, { stream: true })

                let frameEnd: number
                while ((frameEnd = buffer.indexOf('\n\n')) !== -1) {
                    const frameText = buffer.slice(0, frameEnd)
                    buffer = buffer.slice(frameEnd + 2)

                    const dataLines: string[] = []
                    for (const line of frameText.split('\n')) {
                        const trimmed = line.trim()
                        if (trimmed.startsWith('data: ')) {
                            dataLines.push(trimmed.slice(6))
                        } else if (trimmed === 'data') {
                            dataLines.push('')
                        }
                    }
                    if (dataLines.length === 0) continue
                    const data = dataLines.join('\n')

                    if (data === '[DONE]') {
                        terminalSeen = true
                        streaming = false
                        try {
                            await reader.cancel()
                        } catch {
                            // ignore
                        }
                        callbacks.onDone?.()
                        return
                    }

                    try {
                        const evt = JSON.parse(data) as WorkbenchAgentEvent
                        if (evt.type === 'session:error' && evt.error) {
                            streaming = false
                            callbacks.onError?.(errorFromSseFrame({
                                error: 'AGENT_ORCHESTRATION_FAILED',
                                message: evt.error,
                            }))
                            try {
                                await reader.cancel()
                            } catch {
                                // ignore
                            }
                            return
                        }
                        callbacks.onEvent(evt)
                        // 会话结束事件
                        if (evt.type === 'session:end') {
                            terminalSeen = true
                            streaming = false
                            try {
                                await reader.cancel()
                            } catch {
                                // ignore
                            }
                            callbacks.onDone?.()
                            return
                        }
                    } catch (parseErr) {
                        if (import.meta.env.DEV) {
                            console.warn('[api.streamAgentOrchestrateSSE] 帧解析失败，跳过:', data, parseErr)
                        }
                    }
                }
            }

            streaming = false
            if (!requireExplicitSseTerminal(terminalSeen, controller.signal)) return
            callbacks.onDone?.()
        } catch (err) {
            streaming = false
            if (controller.signal.aborted) {
                if (controller.signal.reason === STREAM_IDLE_TIMEOUT_REASON) {
                    callbacks.onError?.(new Error('流式响应超时，请稍后重试'))
                }
                return
            }
            if (err instanceof DOMException && err.name === 'AbortError') return
            const finalErr = err instanceof Error ? err : new Error(String(err))
            callbacks.onError?.(finalErr)
        }
    })()

    return {
        abort: () => {
            if (streaming) {
                streaming = false
                controller.abort()
            }
        },
        get streaming() {
            return streaming
        },
    }
}

/** 后端 GraphNode 可能用 connections / degree 等字段，统一归一化 */
interface RawNode extends GraphNode {
    connections?: number
    properties?: Record<string, unknown>
}

/** 后端 mastery 可能用中文 key（记忆/理解/...），前端用英文 key（remember/understand/...） */
const MASTERY_KEY_MAP: Record<string, keyof Mastery> = {
    '记忆': 'remember',
    '理解': 'understand',
    '运用': 'apply',
    '应用': 'apply', // 兼容"应用"写法
    '分析': 'analyze',
    '评价': 'evaluate',
    '创造': 'create',
}

/** 将后端 mastery（可能中文 key）归一化为前端 Mastery（英文 key）
 *  统一提取所有 6 个字段，缺失字段默认 0，确保返回类型完整的 Mastery */
function normalizeMastery(raw: unknown): Mastery | undefined {
    if (!raw || typeof raw !== 'object') return undefined
    const src = raw as Record<string, number>
    const out: Partial<Mastery> = {}
    let hasAny = false
    // 英文 key 直接提取
    for (const en of ['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create'] as const) {
        const v = src[en]
        if (typeof v === 'number') {
            out[en] = v
            hasAny = true
        }
    }
    // 中文 key 映射提取（兼容后端中文键）
    for (const [zh, en] of Object.entries(MASTERY_KEY_MAP)) {
        const v = src[zh]
        if (typeof v === 'number') {
            out[en] = v
            hasAny = true
        }
    }
    if (!hasAny) return undefined
    // 填充缺失字段为 0，确保类型完整（消费者期望 number 而非 undefined）
    return {
        remember: out.remember ?? 0,
        understand: out.understand ?? 0,
        apply: out.apply ?? 0,
        analyze: out.analyze ?? 0,
        evaluate: out.evaluate ?? 0,
        create: out.create ?? 0,
    }
}

function normalizeGraph(raw: { nodes: RawNode[]; edges: GraphEdge[] }): GraphData {
    const nodes: GraphNode[] = raw.nodes.map((n) => {
        // 后端可能把业务字段塞在 properties 里，需要提升到根（与 GraphNode 类型对齐）
        const p = (n.properties ?? {}) as Record<string, unknown>
        return {
            ...n,
            degree: n.degree ?? n.connections ?? Number(p.degree ?? 0),
            description: n.description ??
                (p.description as string | undefined) ??
                (p.culturalMeaning as string | undefined),
            dynasty: n.dynasty ?? (p.dynasty as string | undefined),
            content: n.content ?? (p.content as string | undefined),
            poetId: n.poetId ?? (p.poetId as string | undefined),
            poet: n.poet ?? (p.poet as string | undefined),
            bio: n.bio ??
                (p.bio as string | undefined) ??
                (p.brief as string | undefined),
            works: n.works ?? (p.works as string[] | undefined),
            mentors: n.mentors ?? (p.mentors as string[] | undefined),
            darkMatter: n.darkMatter ?? (p.darkMatter as string[] | undefined),
            isDarkMatter: n.isDarkMatter ?? (p.isDarkMatter as boolean | undefined),
            mastery: n.mastery ?? normalizeMastery(p.mastery),
        }
    })
    const edgeTypeMap: Record<string, GraphEdge['type']> = {
        WROTE: 'AUTHORED_BY',
        AUTHORED_BY: 'AUTHORED_BY',
        OF_ERA: 'BELONGS_TO_ERA',
        BELONGS_TO_ERA: 'BELONGS_TO_ERA',
        EXPRESSES_THEME: 'USES_THEME',
        USES_THEME: 'USES_THEME',
        SIMILAR_THEME: 'SHARES_THEME',
        SHARES_THEME: 'SHARES_THEME',
        BORROWS_RHETORIC: 'SHARES_RHETORIC',
        SHARES_RHETORIC: 'SHARES_RHETORIC',
        USES_IMAGE: 'USES_IMAGE',
        USES_RHETORIC: 'USES_RHETORIC',
        SHARES_IMAGE: 'SHARES_IMAGE',
        MENTORS: 'MENTORS',
        CONTEMPORARY: 'CONTEMPORARY',
        RELATED_TO: 'RELATED_TO',
    }
    const nodeTypeById = new Map(nodes.map((node) => [node.id, node.type]))
    const isSemanticallyValid = (edge: GraphEdge): boolean => {
        const source = nodeTypeById.get(edge.source)
        const target = nodeTypeById.get(edge.target)
        if (!source || !target || edge.source === edge.target) return false
        switch (edge.type) {
            case 'AUTHORED_BY':
                return source === 'Poem' && target === 'Poet'
            case 'BELONGS_TO_ERA':
                return (source === 'Poem' || source === 'Poet') && target === 'Era'
            case 'MENTORS':
            case 'CONTEMPORARY':
                return source === 'Poet' && target === 'Poet'
            case 'USES_IMAGE':
                return source === 'Poem' && target === 'Image'
            case 'USES_THEME':
                return source === 'Poem' && target === 'Theme'
            case 'USES_RHETORIC':
                return source === 'Poem' && target === 'Rhetoric'
            case 'SHARES_IMAGE':
            case 'SHARES_THEME':
            case 'SHARES_RHETORIC':
                return source === 'Poem' && target === 'Poem'
            default:
                return true
        }
    }
    const edges: GraphEdge[] = raw.edges
        .map((edge) => {
            const type = edgeTypeMap[String(edge.type)] ?? 'RELATED_TO'
            // 后端 WROTE 使用 Poet→Poem；前端统一为 Poem→Poet，便于方向箭头与教学解释一致。
            if (
                type === 'AUTHORED_BY' &&
                nodeTypeById.get(edge.source) === 'Poet' &&
                nodeTypeById.get(edge.target) === 'Poem'
            ) {
                return { ...edge, source: edge.target, target: edge.source, type }
            }
            return { ...edge, type }
        })
        .filter(isSemanticallyValid)
    return { nodes, edges }
}

/** 后端响应可能携带 status 字段，统一剥离后返回核心数据 */
interface ApiEnvelope {
    status?: 'ok' | 'degraded' | 'error'
    [key: string]: unknown
}

function unwrap<T>(envelope: ApiEnvelope & T): T {
    const { status: _status, ...rest } = envelope
    void _status
    return rest as T
}

/**
 * 个人处方 GET 接口使用 `{ status, output }` 信封，而不是平铺输出。
 * 不能把编译期断言当作运行时解包：否则 UI 会把整个信封误当处方，在任一
 * `weaknesses.slice()` 等访问点崩溃。此处在 API 边界显式解包并校验防崩溃的
 * 结构骨架；异常会由调用 store 转为当前模块可见、可重试的错误态。
 */
interface PrescriptionOutputEnvelope extends ApiEnvelope {
    output?: unknown
}

function unwrapPrescriptionOutput(envelope: PrescriptionOutputEnvelope): PrescriptionOutput {
    const output = envelope.output
    if (!output || typeof output !== 'object' || Array.isArray(output)) {
        throw new TypeError('个性化处方响应缺少 output 对象')
    }
    const candidate = output as Partial<PrescriptionOutput>
    const arrayFields: Array<keyof Pick<PrescriptionOutput,
        'strengths' | 'weaknesses' | 'suggestions' | 'recommendations' | 'activities' | 'smartGoals'
    >> = ['strengths', 'weaknesses', 'suggestions', 'recommendations', 'activities', 'smartGoals']
    if (typeof candidate.studentId !== 'string'
        || typeof candidate.anonymousName !== 'string'
        || typeof candidate.generatedAt !== 'number'
        || !candidate.portrait
        || arrayFields.some((field) => !Array.isArray(candidate[field]))) {
        throw new TypeError('个性化处方响应结构不完整')
    }
    return candidate as PrescriptionOutput
}

/* ============================================================
 * v5.0 Task C.1.2：关键 API 响应运行时 shape 校验器
 *
 * 设计原则：
 *  - 仅校验"防崩溃必需"的关键字段（id / type / 结构骨架），可选字段用 v.optional
 *  - 使用 v.passthrough 保留后端新增字段，避免校验过严导致频繁 fallback
 *  - 校验失败由 validateOr 静默降级到 fallback + logError 上报，不抛错中断流程
 *  - 校验器与 TypeScript 接口对齐，但只覆盖运行时易漂移的字段
 * ============================================================ */

/** DashboardStats shape 校验器（顶部统计卡片，防 NaN 崩溃雷达/进度） */
const dashboardStatsValidator: Validator<DashboardStats> = v.passthrough({
    classId: v.string(),
    className: v.string(),
    studentCount: v.number(),
    weekLearnedPoems: v.number(),
    classMasteryAvg: v.number(),
    masteryRecordCount: v.number(),
    pendingAlerts: v.number(),
    weekProgress: v.object({
        learned: v.number(),
        total: v.number(),
    }),
})

/** DashboardStats 安全 fallback（校验失败时撑场，避免页面空白） */
const dashboardStatsFallback: DashboardStats = {
    classId: '',
    className: '数据加载异常',
    studentCount: 0,
    weekLearnedPoems: 0,
    classMasteryAvg: 0,
    masteryRecordCount: 0,
    pendingAlerts: 0,
    weekProgress: { learned: 0, total: 0 },
}

/** 知识图谱基础 shape 校验器（仅校验 nodes/edges 数组结构，详细字段由 normalizeGraph 归一化） */
const graphDataShapeValidator: Validator<{ nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> }> = v.object({
    nodes: v.array(
        v.passthrough({
            id: v.string(),
            type: v.string(),
            label: v.string(),
        }),
    ),
    edges: v.array(
        v.passthrough({
            source: v.string(),
            target: v.string(),
        }),
    ),
})

/** 知识图谱安全 fallback（空图谱，触发上层 mock 降级） */
const graphDataFallback: { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> } = {
    nodes: [],
    edges: [],
}

const unknownValueValidator: Validator<unknown> = (data) => data
const enumStringValidator = (values: readonly string[]): Validator<string> => (data, path) => {
    if (typeof data !== 'string' || !values.includes(data)) {
        throw new TypeError(`${path}: 非法枚举值 ${JSON.stringify(data)}`)
    }
    return data
}
const boundedNumberValidator = (minimum: number, maximum: number): Validator<number> => (data, path) => {
    if (typeof data !== 'number' || !Number.isFinite(data) || data < minimum || data > maximum) {
        throw new TypeError(`${path}: 数值必须位于 ${minimum}..${maximum}`)
    }
    return data
}
const taskStatusValidator = enumStringValidator(['pending', 'running', 'paused', 'success', 'failed', 'skipped'])
const intentValidator = enumStringValidator([
    'generate-questions', 'grade-answers', 'diagnose-class', 'diagnose-student',
    'generate-report', 'recommend-path', 'vision-annotate', 'evaluate-recitation',
    'generate-tts', 'generate-creative', 'composite', 'unknown',
])
const orchestratorTaskValidator = v.passthrough({
    id: v.string(),
    agentId: v.string(),
    input: unknownValueValidator,
    dependencies: v.array(v.string()),
    status: taskStatusValidator,
})
const orchestratorEdgeValidator = v.passthrough({
    from: v.string(),
    to: v.string(),
})

/** AI 副驾核心响应的深层 shape 校验。
 *  计划会直接驱动审批面板与后续执行，不能只验证“parsedInstruction 是对象”后
 *  就把畸形 nodes/subTasks/confidence 交给界面；否则一次契约漂移即可造成白屏。 */
const copilotChatValidator = v.passthrough({
    status: v.literal('ok'),
    sessionId: v.string(),
    parsedInstruction: v.passthrough({
        intent: intentValidator,
        subTasks: v.array(orchestratorTaskValidator),
        executionPlan: v.passthrough({
            nodes: v.array(orchestratorTaskValidator),
            edges: v.array(orchestratorEdgeValidator),
        }),
        estimatedAgents: v.array(v.string()),
        estimatedDurationMs: boundedNumberValidator(0, 3_600_000),
        confidence: boundedNumberValidator(0, 1),
    }),
    copilotStatus: v.literal('planning'),
}) as unknown as Validator<CopilotChatResponse>

const traceLayerValidator = enumStringValidator(['orchestrator', 'agent', 'llm', 'billing', 'evaluation'])
const tracePhaseValidator = enumStringValidator([
    'created', 'approved', 'start', 'success', 'retry', 'error', 'fallback',
    'paused', 'resumed', 'aborted', 'modified', 'verified',
])
const traceStatusValidator = enumStringValidator(['planning', 'running', 'success', 'error', 'aborted'])
const traceEventValidator = v.passthrough({
    id: v.string(),
    traceId: v.string(),
    sessionId: v.string(),
    type: v.string(),
    layer: traceLayerValidator,
    phase: tracePhaseValidator,
    timestamp: v.number(),
})
const orchestratorTraceValidator = v.passthrough({
    status: v.literal('ok'),
    trace: v.passthrough({
        summary: v.passthrough({
            traceId: v.string(),
            sessionId: v.string(),
            status: traceStatusValidator,
            durationMs: boundedNumberValidator(0, Number.MAX_SAFE_INTEGER),
            eventCount: boundedNumberValidator(0, 50_000),
            llmCalls: boundedNumberValidator(0, 50_000),
            agentCalls: boundedNumberValidator(0, 50_000),
            retries: boundedNumberValidator(0, 50_000),
            errors: boundedNumberValidator(0, 50_000),
            fallbacks: boundedNumberValidator(0, 50_000),
            evaluations: boundedNumberValidator(0, 50_000),
            totalTokens: boundedNumberValidator(0, Number.MAX_SAFE_INTEGER),
            costYuan: boundedNumberValidator(0, 1_000_000),
            promptVersions: v.array(v.string()),
            models: v.array(v.string()),
        }),
        events: v.array(traceEventValidator),
        privacy: v.passthrough({
            rawPromptsStored: v.literal(false),
            rawOutputsStored: v.literal(false),
            studentIdentityStored: v.literal(false),
            policy: v.string(),
        }),
        truncated: v.boolean(),
    }),
}) as unknown as Validator<OrchestratorTraceResponse>

/** CopilotChatResponse 安全 fallback（校验失败时撑场）
 *  所有字段与 ParsedInstruction 类型完全对齐，无需 as never 逃逸 */
const copilotChatFallback: CopilotChatResponse = {
    status: 'ok',
    sessionId: '',
    parsedInstruction: {
        intent: 'unknown', // Intent 联合类型包含 'unknown'
        subTasks: [],
        executionPlan: { nodes: [], edges: [] }, // DAG: 空数组满足 SubTask[] / DAGEdge[]
        estimatedAgents: [],
        estimatedDurationMs: 0,
        confidence: 0, // 原代码遗漏此必填字段，导致需要 as never 逃逸
    },
    copilotStatus: 'planning',
}

/**
 * 通用 SSE 流式请求辅助函数
 *
 * 复用 copilot.streamChat 的 SSE 帧解析逻辑，供教案生成/精修等流式端点使用。
 *
 * @param path API 路径（不含 /api 前缀）
 * @param body POST 请求体
 * @param callbacks 流式回调
 * @returns 流式控制器（abort + streaming 状态）
 */
function streamSSE<T extends { type: string }>(
    path: string,
    body: unknown,
    callbacks: LessonStreamCallbacks<T>,
): LessonStreamController {
    const controller = new AbortController()
    let streaming = true

    void (async () => {
        try {
            const res = await fetchStreamResponse(`${API_BASE}${path}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'text/event-stream',
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            }, controller)

            if (!res.ok) {
                let errMsg = `HTTP ${res.status} ${res.statusText}`
                try {
                    const ct = res.headers.get('content-type') ?? ''
                    if (ct.includes('application/json')) {
                        const errJson = (await res.json()) as { message?: string; error?: string }
                        if (errJson.message) errMsg = errJson.message
                        else if (errJson.error) errMsg = errJson.error
                    } else {
                        const text = await res.text()
                        if (text) errMsg = text
                    }
                } catch {
                    // 响应体解析失败
                }
                throw new Error(errMsg)
            }

            if (!res.body) {
                throw new Error('响应体为空，无法消费 SSE 流')
            }

            const reader = res.body.getReader()
            const decoder = new TextDecoder('utf-8')
            let buffer = ''
            let terminalSeen = false

            // eslint-disable-next-line no-constant-condition
            while (true) {
                const { done, value } = await readStreamChunk(reader, controller)
                if (done) break

                buffer += decoder.decode(value, { stream: true })

                let frameEnd: number
                while ((frameEnd = buffer.indexOf('\n\n')) !== -1) {
                    const frameText = buffer.slice(0, frameEnd)
                    buffer = buffer.slice(frameEnd + 2)

                    const dataLines: string[] = []
                    for (const line of frameText.split('\n')) {
                        const trimmed = line.trim()
                        if (trimmed.startsWith('data: ')) {
                            dataLines.push(trimmed.slice(6))
                        } else if (trimmed === 'data') {
                            dataLines.push('')
                        }
                    }
                    if (dataLines.length === 0) continue
                    const data = dataLines.join('\n')

                    if (data === '[DONE]') {
                        terminalSeen = true
                        streaming = false
                        try {
                            await reader.cancel()
                        } catch {
                            // ignore
                        }
                        callbacks.onDone?.()
                        return
                    }

                    try {
                        const chunk = JSON.parse(data) as T & { error?: unknown; message?: unknown }
                        if (chunk.error) {
                            streaming = false
                            callbacks.onError?.(errorFromSseFrame(chunk))
                            try {
                                await reader.cancel()
                            } catch {
                                // ignore
                            }
                            return
                        }
                        callbacks.onChunk(chunk)
                    } catch {
                        console.warn('[api.streamSSE] 帧解析失败，跳过:', data)
                    }
                }
            }

            streaming = false
            if (!requireExplicitSseTerminal(terminalSeen, controller.signal)) return
            callbacks.onDone?.()
        } catch (err) {
            streaming = false
            if (controller.signal.aborted) {
                if (controller.signal.reason === STREAM_IDLE_TIMEOUT_REASON) {
                    callbacks.onError?.(new Error('流式响应超时，请稍后重试'))
                }
                return
            }
            if (err instanceof DOMException && err.name === 'AbortError') return
            const finalErr = err instanceof Error ? err : new Error(String(err))
            callbacks.onError?.(finalErr)
        }
    })()

    return {
        abort: () => {
            if (streaming) {
                streaming = false
                controller.abort()
            }
        },
        get streaming() {
            return streaming
        },
    }
}

/**
 * 诊断流式 chunk（学习路径/处方生成 SSE 共用）
 *
 * 后端发送格式：
 * - { delta: string }    → 文本增量
 * - { error, message }   → 错误
 * - [DONE]               → 流结束
 */
export type DiagnosisStreamChunk =
    | { type: 'delta'; content: string }
    | { type: 'error'; code: string; message: string }

/** 诊断流式回调配置 */
export interface DiagnosisStreamCallbacks {
    onDelta: (content: string) => void
    onDone?: () => void
    onError?: (err: Error) => void
}

/**
 * 诊断流式（delta 格式）SSE 辅助函数
 *
 * 复用 streamSSE 的 SSE 帧解析逻辑，但处理后端 { delta } / { error } 格式，
 * 转换为统一的 onDelta / onDone / onError 回调。
 */
function streamDiagnosisSSE(
    path: string,
    body: unknown,
    callbacks: DiagnosisStreamCallbacks,
): LessonStreamController {
    const controller = new AbortController()
    let streaming = true

    void (async () => {
        try {
            const res = await fetchStreamResponse(`${API_BASE}${path}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'text/event-stream',
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            }, controller)

            if (!res.ok) {
                let errMsg = `HTTP ${res.status} ${res.statusText}`
                try {
                    const ct = res.headers.get('content-type') ?? ''
                    if (ct.includes('application/json')) {
                        const errJson = (await res.json()) as { message?: string; error?: string }
                        if (errJson.message) errMsg = errJson.message
                        else if (errJson.error) errMsg = errJson.error
                    } else {
                        const text = await res.text()
                        if (text) errMsg = text
                    }
                } catch {
                    // 响应体解析失败
                }
                throw new Error(errMsg)
            }

            if (!res.body) {
                throw new Error('响应体为空，无法消费 SSE 流')
            }

            const reader = res.body.getReader()
            const decoder = new TextDecoder('utf-8')
            let buffer = ''
            let terminalSeen = false

            // eslint-disable-next-line no-constant-condition
            while (true) {
                const { done, value } = await readStreamChunk(reader, controller)
                if (done) break

                buffer += decoder.decode(value, { stream: true })

                let frameEnd: number
                while ((frameEnd = buffer.indexOf('\n\n')) !== -1) {
                    const frameText = buffer.slice(0, frameEnd)
                    buffer = buffer.slice(frameEnd + 2)

                    const dataLines: string[] = []
                    for (const line of frameText.split('\n')) {
                        const trimmed = line.trim()
                        if (trimmed.startsWith('data: ')) {
                            dataLines.push(trimmed.slice(6))
                        } else if (trimmed === 'data') {
                            dataLines.push('')
                        }
                    }
                    if (dataLines.length === 0) continue
                    const data = dataLines.join('\n')

                    if (data === '[DONE]') {
                        terminalSeen = true
                        streaming = false
                        try {
                            await reader.cancel()
                        } catch {
                            // ignore
                        }
                        callbacks.onDone?.()
                        return
                    }

                    try {
                        const parsed = JSON.parse(data) as { delta?: string; error?: string; message?: string }
                        if (parsed.error) {
                            streaming = false
                            callbacks.onError?.(errorFromSseFrame(parsed))
                            try {
                                await reader.cancel()
                            } catch {
                                // ignore
                            }
                            return
                        }
                        if (typeof parsed.delta === 'string') {
                            callbacks.onDelta(parsed.delta)
                        }
                    } catch {
                        console.warn('[api.streamDiagnosisSSE] 帧解析失败，跳过:', data)
                    }
                }
            }

            streaming = false
            if (!requireExplicitSseTerminal(terminalSeen, controller.signal)) return
            callbacks.onDone?.()
        } catch (err) {
            streaming = false
            if (controller.signal.aborted) {
                if (controller.signal.reason === STREAM_IDLE_TIMEOUT_REASON) {
                    callbacks.onError?.(new Error('流式响应超时，请稍后重试'))
                }
                return
            }
            if (err instanceof DOMException && err.name === 'AbortError') return
            const finalErr = err instanceof Error ? err : new Error(String(err))
            callbacks.onError?.(finalErr)
        }
    })()

    return {
        abort: () => {
            if (streaming) {
                streaming = false
                controller.abort()
            }
        },
        get streaming() {
            return streaming
        },
    }
}

export const api = {
    knowledgeGraph: {
        /** 完整图谱（不带掌握度） */
        full: () =>
            fetchJSON<{ nodes: RawNode[]; edges: GraphEdge[] }>('/knowledge-graph/full')
                .then((raw) => {
                    // v5.0 Task C.1.2：运行时 shape 校验，畸形数据降级为空图谱（触发上层 mock）
                    const safe = validateOr(raw, graphDataShapeValidator, graphDataFallback, 'api/knowledge-graph/full')
                    // 架构性桥接：validator 输出 Record<string,unknown>[]（passthrough 宽松校验），
                    // normalizeGraph 内部用 ?? 兜底所有可选字段，运行时安全
                    return normalizeGraph(safe as unknown as { nodes: RawNode[]; edges: GraphEdge[] })
                }),

        /** 带掌握度着色的图谱（按班级） */
        masteryColored: (classId: string) =>
            fetchJSON<{ nodes: RawNode[]; edges: GraphEdge[] }>(
                `/knowledge-graph/mastery-colored?classId=${encodeURIComponent(classId)}`,
            ).then((raw) => {
                // v5.0 Task C.1.2：运行时 shape 校验，畸形数据降级为空图谱（触发上层 mock）
                const safe = validateOr(
                    raw,
                    graphDataShapeValidator,
                    graphDataFallback,
                    'api/knowledge-graph/mastery-colored',
                )
                // 架构性桥接：同上，validator 宽松输出 → normalizeGraph 兜底归一化
                return normalizeGraph(safe as unknown as { nodes: RawNode[]; edges: GraphEdge[] })
            }),

        /** 班级认知暗物质 */
        darkMatter: (classId: string) =>
            fetchJSON<GraphData>(`/knowledge-graph/dark-matter/${encodeURIComponent(classId)}`),

        /** 学生知识漏洞 */
        studentGaps: (studentId: string) =>
            fetchJSON<GraphData>(`/knowledge-graph/student/${encodeURIComponent(studentId)}/gaps`),

        /** 查询诗的关联诗 */
        relatedPoems: (poemId: string) =>
            fetchJSON<GraphNode[]>(`/knowledge-graph/poem/${encodeURIComponent(poemId)}/related`),
    },

    dashboard: {
        /** 顶部统计卡片 */
        stats: (classId: string) =>
            fetchJSON<DashboardStats & ApiEnvelope>(
                `/dashboard/stats?classId=${encodeURIComponent(classId)}`,
            )
                .then(unwrap<DashboardStats>)
                .then((stats) =>
                    // v5.0 Task C.1.2：运行时 shape 校验，畸形数据降级为 fallback stats
                    validateOr(
                        stats,
                        dashboardStatsValidator,
                        dashboardStatsFallback,
                        'api/dashboard/stats',
                    ),
                ),

        /** 六阶能力雷达 */
        bloomRadar: (classId: string) =>
            fetchJSON<BloomRadar & ApiEnvelope>(
                `/dashboard/bloom-radar?classId=${encodeURIComponent(classId)}`,
            ).then(unwrap<BloomRadar>),

        /** 实时预警面板 */
        alerts: (classId: string, limit = 10) =>
            fetchJSON<AlertsResponse & ApiEnvelope>(
                `/dashboard/alerts?classId=${encodeURIComponent(classId)}&limit=${limit}`,
            ).then(unwrap<AlertsResponse>),

        /** 本周教学进度 */
        weeklyProgress: (classId: string) =>
            fetchJSON<WeeklyProgressResponse & ApiEnvelope>(
                `/dashboard/weekly-progress?classId=${encodeURIComponent(classId)}`,
            ).then(unwrap<WeeklyProgressResponse>),
    },

    classroom: {
        /** 班级列表（供下拉框动态加载） */
        listClasses: () =>
            fetchJSON<{ classes: Array<{ id: string; name: string }> } & ApiEnvelope>(
                '/classroom/classes',
            ).then(unwrap<{ classes: Array<{ id: string; name: string }> }>),

        /** 开课前校验真实题库与六阶覆盖 */
        readiness: (poemId: string, mode: ClassroomMode) =>
            fetchJSON<ClassroomReadiness & ApiEnvelope>(
                `/classroom/readiness?poemId=${encodeURIComponent(poemId)}&mode=${encodeURIComponent(mode)}`,
            ).then(unwrap<ClassroomReadiness>),

        /** 开始一堂课 */
        start: (classId: string, poemId: string, mode: ClassroomMode, questionIds?: string[]) =>
            fetchJSON<StartClassroomResponse & ApiEnvelope>('/classroom/start', {
                method: 'POST',
                body: JSON.stringify({ classId, poemId, mode, questionIds }),
            }).then(unwrap<StartClassroomResponse>),

        /** 查询课堂实时状态 */
        status: (lessonId: string) =>
            fetchJSON<ClassroomStatus & ApiEnvelope>(
                `/classroom/${encodeURIComponent(lessonId)}/status`,
            ).then(unwrap<ClassroomStatus>),

        /** 教师当场换一道同布鲁姆层级的题 */
        replaceQuestion: (
            lessonId: string,
        ): Promise<{ question: unknown; replacedFrom: string; remainingCandidates: number }> =>
            fetchJSON<{ question: unknown; replacedFrom: string; remainingCandidates: number } & ApiEnvelope>(
                `/classroom/${encodeURIComponent(lessonId)}/question/replace`,
                { method: 'POST', body: '{}' },
            ).then(unwrap),

        /**
         * 教师标记题目质量
         *
         * 教师是唯一见过这道题在真实课堂上落地效果的人，
         * 这个反馈会写回 questions.metadata 供命题工坊改进。
         */
        flagQuestion: (
            lessonId: string,
            questionId: string,
            reason: string,
            note?: string,
        ): Promise<{ questionId: string; flagCount: number }> =>
            fetchJSON<{ questionId: string; flagCount: number } & ApiEnvelope>(
                `/classroom/${encodeURIComponent(lessonId)}/question/flag`,
                { method: 'POST', body: JSON.stringify({ questionId, reason, note }) },
            ).then(unwrap),

        /** 持久化切换课堂模式，避免仅改变前端外观 */
        switchMode: (lessonId: string, mode: ClassroomMode) =>
            fetchJSON<{ lessonId: string; previousMode: ClassroomMode; mode: ClassroomMode; flyingFlowerKeyword?: string } & ApiEnvelope>(
                `/classroom/${encodeURIComponent(lessonId)}/mode`,
                { method: 'PATCH', body: JSON.stringify({ mode }) },
            ).then(unwrap<{ lessonId: string; previousMode: ClassroomMode; mode: ClassroomMode; flyingFlowerKeyword?: string }>),

        /** 进入下一题 */
        next: (lessonId: string) =>
            fetchJSON<{ currentQuestionIndex: number; currentQuestion: ClassroomStatus['currentQuestion'] } & ApiEnvelope>(
                `/classroom/${encodeURIComponent(lessonId)}/next`,
                { method: 'POST' },
            ).then(unwrap<{ currentQuestionIndex: number; currentQuestion: ClassroomStatus['currentQuestion'] }>),

        /** 学生提交答案（实时批改） */
        submit: (
            lessonId: string,
            studentId: string,
            answer: string,
            questionId: string,
            studentName?: string,
            latencyMs?: number,
        ) =>
            fetchJSON<SubmitResponse & ApiEnvelope>(
                `/classroom/${encodeURIComponent(lessonId)}/submit`,
                {
                    method: 'POST',
                    body: JSON.stringify({ studentId, answer, questionId, studentName, latencyMs }),
                },
            ).then(unwrap<SubmitResponse>),

        /** 诗心 Agent 推送启发提示 */
        hint: (lessonId: string, questionId: string, type?: 'nudge' | 'scaffold' | 'reframe') =>
            fetchJSON<HintResponse & ApiEnvelope>(
                `/classroom/${encodeURIComponent(lessonId)}/hint`,
                {
                    method: 'POST',
                    body: JSON.stringify({ questionId, type }),
                },
            ).then(unwrap<HintResponse>),

        /** 诗笔 Agent 实时生成讨论题 */
        discuss: (lessonId: string, questionId: string, angle?: 'cultural' | 'comparative' | 'creative') =>
            fetchJSON<DiscussResponse & ApiEnvelope>(
                `/classroom/${encodeURIComponent(lessonId)}/discuss`,
                {
                    method: 'POST',
                    body: JSON.stringify({ questionId, angle }),
                },
            ).then(unwrap<DiscussResponse>),

        /** 结束课堂并生成协奏报告（幂等：已结束课堂返回缓存/历史报告） */
        end: (lessonId: string) =>
            fetchJSON<ClassroomReport & ApiEnvelope>(
                `/classroom/${encodeURIComponent(lessonId)}/end`,
                { method: 'POST' },
            ).then(unwrap<ClassroomReport>),

        /** 拉取课堂协奏报告（支持历史课堂，幂等） */
        getReport: (lessonId: string) =>
            fetchJSON<ClassroomReport & ApiEnvelope>(
                `/classroom/${encodeURIComponent(lessonId)}/report`,
            ).then(unwrap<ClassroomReport>),

        /** 通过加入码查找课堂（学生端用） */
        join: (joinCode: string) =>
            fetchJSON<{ lessonId: string; mode: ClassroomMode; poemId: string } & ApiEnvelope>(
                `/classroom/join/${encodeURIComponent(joinCode.toUpperCase())}`,
            ).then(unwrap<{ lessonId: string; mode: ClassroomMode; poemId: string }>),

        /** Phase 4.3：课堂讲解工具（逐句讲解 + 正音要点 + 教学要点 + 讨论提示） */
        explain: (poemId: string): Promise<ExplainResponse> =>
            fetchJSON<ExplainResponse & ApiEnvelope>(
                `/classroom/explain/${encodeURIComponent(poemId)}`,
                {},
                60_000,
            ).then(unwrap<ExplainResponse>),

        // ── v5.0 创新点：AI 诗教共舞舞台 ──
        /** 启动共舞会话（教师发起，建立三方实时协作通道） */
        danceStart: (lessonId: string) =>
            fetchJSON<{ status: 'ok'; session: unknown } & ApiEnvelope>(
                `/classroom/${encodeURIComponent(lessonId)}/dance/start`,
                { method: 'POST' },
            ).then(unwrap<{ status: 'ok'; session: unknown }>),

        /** 拉取共舞时间线（支持增量拉取：from + limit） */
        danceTimeline: (lessonId: string, from?: number, limit?: number) =>
            fetchJSON<{ status: 'ok'; timeline: unknown[]; total: number } & ApiEnvelope>(
                `/classroom/${encodeURIComponent(lessonId)}/dance/timeline?from=${from ?? 0}&limit=${limit ?? 500}`,
            ).then(unwrap<{ status: 'ok'; timeline: unknown[]; total: number }>),

        /** 提交共舞事件（教师/AI/学生任一方提交） */
        danceSubmitEvent: (
            lessonId: string,
            payload: {
                actor: 'teacher' | 'ai' | 'student'
                subType: string
                content: string
                actorId?: string
                actorLabel?: string
                questionId?: string
                targetStudentId?: string
                aiGenerated?: boolean
            },
        ) =>
            fetchJSON<{ status: 'ok'; event: unknown } & ApiEnvelope>(
                `/classroom/${encodeURIComponent(lessonId)}/dance/event`,
                { method: 'POST', body: JSON.stringify(payload) },
            ).then(unwrap<{ status: 'ok'; event: unknown }>),

        // ── 课堂指挥深化：实时调度（Task 2） ──

        /** 实时调度：选取下一学生 */
        scheduleNext: (lessonId: string, preferredStrategy?: ScheduleStrategy, timeProgress?: number) =>
            fetchJSON<ScheduleNextResponse & ApiEnvelope>(
                `/classroom/${encodeURIComponent(lessonId)}/schedule/next`,
                {
                    method: 'POST',
                    body: JSON.stringify({ preferredStrategy, timeProgress }),
                },
            ).then(unwrap<ScheduleNextResponse>),

        /** 教师手动覆盖调度 */
        scheduleOverride: (lessonId: string, studentId: string, studentName?: string) =>
            fetchJSON<ScheduleOverrideResponse & ApiEnvelope>(
                `/classroom/${encodeURIComponent(lessonId)}/schedule/override`,
                {
                    method: 'POST',
                    body: JSON.stringify({ studentId, studentName }),
                },
            ).then(unwrap<ScheduleOverrideResponse>),

        /** 获取调度状态 */
        scheduleStatus: (lessonId: string) =>
            fetchJSON<ScheduleStatusResponse & ApiEnvelope>(
                `/classroom/${encodeURIComponent(lessonId)}/schedule/status`,
            ).then(unwrap<ScheduleStatusResponse>),

        // ── 课堂指挥深化：AI 协同教学（Task 3，SSE 流式） ──

        /** AI 实时反馈（SSE 流式） */
        aiSuggest: (
            lessonId: string,
            questionId: string,
            studentId: string,
            callbacks: {
                onChunk: (chunk: AISuggestionChunk) => void
                onDone?: () => void
                onError?: (err: Error) => void
            },
            classAccuracy?: number,
        ): { abort: () => void; streaming: boolean } => {
            const controller = new AbortController()
            let streaming = true

            void (async () => {
                try {
                    const res = await fetchStreamResponse(
                        `${API_BASE}/classroom/${encodeURIComponent(lessonId)}/ai/suggest`,
                        {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
                            body: JSON.stringify({ questionId, studentId, classAccuracy }),
                            signal: controller.signal,
                        },
                        controller,
                    )
                    if (!res.ok) throw new Error(`HTTP ${res.status}`)
                    if (!res.body) throw new Error('响应体为空')

                    const reader = res.body.getReader()
                    const decoder = new TextDecoder('utf-8')
                    let buffer = ''
                    let terminalSeen = false

                    while (true) {
                        const { done, value } = await readStreamChunk(reader, controller)
                        if (done) break
                        buffer += decoder.decode(value, { stream: true })
                        let frameEnd: number
                        while ((frameEnd = buffer.indexOf('\n\n')) !== -1) {
                            const frameText = buffer.slice(0, frameEnd)
                            buffer = buffer.slice(frameEnd + 2)
                            const dataLines: string[] = []
                            for (const line of frameText.split('\n')) {
                                const trimmed = line.trim()
                                if (trimmed.startsWith('data: ')) dataLines.push(trimmed.slice(6))
                            }
                            if (dataLines.length === 0) continue
                            const data = dataLines.join('\n')
                            if (data === '[DONE]') {
                                terminalSeen = true
                                streaming = false
                                try { await reader.cancel() } catch { /* ignore */ }
                                callbacks.onDone?.()
                                return
                            }
                            try {
                                const chunk = JSON.parse(data) as AISuggestionChunk & { error?: unknown; message?: unknown }
                                if (chunk.error) {
                                    streaming = false
                                    callbacks.onError?.(errorFromSseFrame(chunk))
                                    try { await reader.cancel() } catch { /* ignore */ }
                                    return
                                }
                                callbacks.onChunk(chunk)
                            } catch {
                                // malformed frame: skip; a valid terminal is still required
                            }
                        }
                    }
                    streaming = false
                    if (!requireExplicitSseTerminal(terminalSeen, controller.signal)) return
                    callbacks.onDone?.()
                } catch (err) {
                    streaming = false
                    if (controller.signal.aborted) {
                        if (controller.signal.reason === STREAM_IDLE_TIMEOUT_REASON) {
                            callbacks.onError?.(new Error('流式响应超时，请稍后重试'))
                        }
                        return
                    }
                    if (err instanceof DOMException && err.name === 'AbortError') return
                    callbacks.onError?.(err instanceof Error ? err : new Error(String(err)))
                }
            })()

            return {
                abort: () => controller.abort(),
                get streaming() { return streaming },
            }
        },

        /** AI 背景补充（SSE 流式） */
        aiSupplement: (
            lessonId: string,
            questionId: string,
            callbacks: {
                onChunk: (chunk: AISuggestionChunk) => void
                onDone?: () => void
                onError?: (err: Error) => void
            },
        ): { abort: () => void; streaming: boolean } => {
            const controller = new AbortController()
            let streaming = true

            void (async () => {
                try {
                    const res = await fetchStreamResponse(
                        `${API_BASE}/classroom/${encodeURIComponent(lessonId)}/ai/supplement`,
                        {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
                            body: JSON.stringify({ questionId }),
                            signal: controller.signal,
                        },
                        controller,
                    )
                    if (!res.ok) throw new Error(`HTTP ${res.status}`)
                    if (!res.body) throw new Error('响应体为空')

                    const reader = res.body.getReader()
                    const decoder = new TextDecoder('utf-8')
                    let buffer = ''
                    let terminalSeen = false

                    while (true) {
                        const { done, value } = await readStreamChunk(reader, controller)
                        if (done) break
                        buffer += decoder.decode(value, { stream: true })
                        let frameEnd: number
                        while ((frameEnd = buffer.indexOf('\n\n')) !== -1) {
                            const frameText = buffer.slice(0, frameEnd)
                            buffer = buffer.slice(frameEnd + 2)
                            const dataLines: string[] = []
                            for (const line of frameText.split('\n')) {
                                const trimmed = line.trim()
                                if (trimmed.startsWith('data: ')) dataLines.push(trimmed.slice(6))
                            }
                            if (dataLines.length === 0) continue
                            const data = dataLines.join('\n')
                            if (data === '[DONE]') {
                                terminalSeen = true
                                streaming = false
                                try { await reader.cancel() } catch { /* ignore */ }
                                callbacks.onDone?.()
                                return
                            }
                            try {
                                const chunk = JSON.parse(data) as AISuggestionChunk & { error?: unknown; message?: unknown }
                                if (chunk.error) {
                                    streaming = false
                                    callbacks.onError?.(errorFromSseFrame(chunk))
                                    try { await reader.cancel() } catch { /* ignore */ }
                                    return
                                }
                                callbacks.onChunk(chunk)
                            } catch {
                                // malformed frame: skip; a valid terminal is still required
                            }
                        }
                    }
                    streaming = false
                    if (!requireExplicitSseTerminal(terminalSeen, controller.signal)) return
                    callbacks.onDone?.()
                } catch (err) {
                    streaming = false
                    if (controller.signal.aborted) {
                        if (controller.signal.reason === STREAM_IDLE_TIMEOUT_REASON) {
                            callbacks.onError?.(new Error('流式响应超时，请稍后重试'))
                        }
                        return
                    }
                    if (err instanceof DOMException && err.name === 'AbortError') return
                    callbacks.onError?.(err instanceof Error ? err : new Error(String(err)))
                }
            })()

            return {
                abort: () => controller.abort(),
                get streaming() { return streaming },
            }
        },

        /** AI 追问生成（SSE 流式） */
        aiFollowup: (
            lessonId: string,
            questionId: string,
            callbacks: {
                onChunk: (chunk: AISuggestionChunk) => void
                onDone?: () => void
                onError?: (err: Error) => void
            },
            studentId?: string,
        ): { abort: () => void; streaming: boolean } => {
            const controller = new AbortController()
            let streaming = true

            void (async () => {
                try {
                    const res = await fetchStreamResponse(
                        `${API_BASE}/classroom/${encodeURIComponent(lessonId)}/ai/followup`,
                        {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
                            body: JSON.stringify({ questionId, studentId }),
                            signal: controller.signal,
                        },
                        controller,
                    )
                    if (!res.ok) throw new Error(`HTTP ${res.status}`)
                    if (!res.body) throw new Error('响应体为空')

                    const reader = res.body.getReader()
                    const decoder = new TextDecoder('utf-8')
                    let buffer = ''
                    let terminalSeen = false

                    while (true) {
                        const { done, value } = await readStreamChunk(reader, controller)
                        if (done) break
                        buffer += decoder.decode(value, { stream: true })
                        let frameEnd: number
                        while ((frameEnd = buffer.indexOf('\n\n')) !== -1) {
                            const frameText = buffer.slice(0, frameEnd)
                            buffer = buffer.slice(frameEnd + 2)
                            const dataLines: string[] = []
                            for (const line of frameText.split('\n')) {
                                const trimmed = line.trim()
                                if (trimmed.startsWith('data: ')) dataLines.push(trimmed.slice(6))
                            }
                            if (dataLines.length === 0) continue
                            const data = dataLines.join('\n')
                            if (data === '[DONE]') {
                                terminalSeen = true
                                streaming = false
                                try { await reader.cancel() } catch { /* ignore */ }
                                callbacks.onDone?.()
                                return
                            }
                            try {
                                const chunk = JSON.parse(data) as AISuggestionChunk & { error?: unknown; message?: unknown }
                                if (chunk.error) {
                                    streaming = false
                                    callbacks.onError?.(errorFromSseFrame(chunk))
                                    try { await reader.cancel() } catch { /* ignore */ }
                                    return
                                }
                                callbacks.onChunk(chunk)
                            } catch {
                                // malformed frame: skip; a valid terminal is still required
                            }
                        }
                    }
                    streaming = false
                    if (!requireExplicitSseTerminal(terminalSeen, controller.signal)) return
                    callbacks.onDone?.()
                } catch (err) {
                    streaming = false
                    if (controller.signal.aborted) {
                        if (controller.signal.reason === STREAM_IDLE_TIMEOUT_REASON) {
                            callbacks.onError?.(new Error('流式响应超时，请稍后重试'))
                        }
                        return
                    }
                    if (err instanceof DOMException && err.name === 'AbortError') return
                    callbacks.onError?.(err instanceof Error ? err : new Error(String(err)))
                }
            })()

            return {
                abort: () => controller.abort(),
                get streaming() { return streaming },
            }
        },

        /** 困难学生与全班干预建议（聚合课堂已发生作答，非流式） */
        aiIntervention: (lessonId: string) =>
            fetchJSON<import('./types').AIInterventionResponse & ApiEnvelope>(
                `/classroom/${encodeURIComponent(lessonId)}/ai/intervention`,
                // fetchJSON 会统一声明 application/json；Fastify 对该 MIME 的空 POST
                // 正文会失败关闭，因此明确发送空对象而不是依赖“无 body”语义。
                { method: 'POST', body: JSON.stringify({}) },
            ).then(unwrap<import('./types').AIInterventionResponse>),

        /** 标记 AI 建议被采纳（用于采纳率统计） */
        markAISuggestionAdopted: (lessonId: string, category: AISuggestionCategory) =>
            fetchJSON<{ status: 'ok'; lessonId: string; category: string; message: string } & ApiEnvelope>(
                `/classroom/${encodeURIComponent(lessonId)}/ai/mark-adopted`,
                {
                    method: 'POST',
                    body: JSON.stringify({ category }),
                },
            ).then(unwrap<{ status: 'ok'; lessonId: string; category: string; message: string }>),

        // ── 课堂指挥深化：复盘报告（Task 5） ──

        /** 生成复盘报告 */
        generateAfterActionReport: (lessonId: string) =>
            fetchJSON<AfterActionReportGenerateResponse & ApiEnvelope>(
                `/classroom/${encodeURIComponent(lessonId)}/after-action-report/generate`,
                { method: 'POST' },
            ).then(unwrap<AfterActionReportGenerateResponse>),

        /** 获取复盘报告 */
        getAfterActionReport: (lessonId: string) =>
            fetchJSON<AfterActionReportGetResponse & ApiEnvelope>(
                `/classroom/${encodeURIComponent(lessonId)}/after-action-report`,
            ).then(unwrap<AfterActionReportGetResponse>),

        // ── v5.0 Task 18-20：单设备 + AI 虚拟对手 + 智能赋分 + AI 流式点评 ──

        /** 智能赋分（0-100 + 个性化反馈），始终由后端真实模型适配层执行。 */
        score: (lessonId: string, req: SmartScoreRequest): Promise<SmartScoreResult> =>
            fetchJSON<SmartScoreResult & ApiEnvelope>(
                // 后端契约：POST /api/classroom/sessions/:sessionId/smart-score
                // 注意与 /sessions/:sessionId/score 的区别：后者是教师手动赋分（调用方给出分数），
                // 本端点是 AI 依据作答文本判分（调用方不给分数）。
                `/classroom/sessions/${encodeURIComponent(lessonId)}/smart-score`,
                {
                    method: 'POST',
                    body: JSON.stringify(req),
                },
                60_000,
            ).then(unwrap<SmartScoreResult>),

        /**
         * AI 实时点评（SSE 流式） —— deepseek-v4-pro 增量输出
         * @returns 控制器：{ abort, streaming }
         */
        comment: (
            lessonId: string,
            req: { studentId: string; answer: string; questionId?: string; commentType?: 'praise' | 'guide' | 'challenge' | 'correct' },
            callbacks: {
                onChunk: (chunk: ClassroomCommentChunk) => void
                onDone?: () => void
                onError?: (err: Error) => void
            },
        ): { abort: () => void; streaming: boolean } => {
            const controller = new AbortController()
            let streaming = true

            void (async () => {
                try {
                    const res = await fetchStreamResponse(
                        // 后端契约：POST /api/classroom/sessions/:sessionId/comment
                        // 课堂 runtime 由 lessonId 与 sessionId 共用同一 Map，二者是同一 ID 空间，
                        // 因此这里直接把 lessonId 作为 sessionId 传入。
                        `${API_BASE}/classroom/sessions/${encodeURIComponent(lessonId)}/comment`,
                        {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
                            body: JSON.stringify(req),
                            signal: controller.signal,
                        },
                        controller,
                    )
                    if (!res.ok) throw new Error(`HTTP ${res.status}`)
                    if (!res.body) throw new Error('响应体为空')

                    const reader = res.body.getReader()
                    const decoder = new TextDecoder('utf-8')
                    let buffer = ''
                    let terminalSeen = false

                    while (true) {
                        const { done, value } = await readStreamChunk(reader, controller)
                        if (done) break
                        buffer += decoder.decode(value, { stream: true })
                        let frameEnd: number
                        while ((frameEnd = buffer.indexOf('\n\n')) !== -1) {
                            const frameText = buffer.slice(0, frameEnd)
                            buffer = buffer.slice(frameEnd + 2)
                            const dataLines: string[] = []
                            for (const line of frameText.split('\n')) {
                                const trimmed = line.trim()
                                if (trimmed.startsWith('data: ')) dataLines.push(trimmed.slice(6))
                            }
                            if (dataLines.length === 0) continue
                            const data = dataLines.join('\n')
                            if (data === '[DONE]') {
                                terminalSeen = true
                                streaming = false
                                try { await reader.cancel() } catch { /* ignore */ }
                                callbacks.onChunk({ done: true, studentId: req.studentId, questionId: req.questionId, commentType: req.commentType })
                                callbacks.onDone?.()
                                return
                            }
                            try {
                                const chunk = JSON.parse(data) as ClassroomCommentChunk & { error?: unknown; message?: unknown }
                                if (chunk.error) {
                                    streaming = false
                                    callbacks.onError?.(errorFromSseFrame(chunk))
                                    try { await reader.cancel() } catch { /* ignore */ }
                                    return
                                }
                                callbacks.onChunk(chunk)
                            } catch {
                                // malformed frame: skip; a valid terminal is still required
                            }
                        }
                    }
                    streaming = false
                    if (!requireExplicitSseTerminal(terminalSeen, controller.signal)) return
                    callbacks.onChunk({ done: true, studentId: req.studentId, questionId: req.questionId, commentType: req.commentType })
                    callbacks.onDone?.()
                } catch (err) {
                    streaming = false
                    if (controller.signal.aborted) {
                        if (controller.signal.reason === STREAM_IDLE_TIMEOUT_REASON) {
                            callbacks.onError?.(new Error('流式响应超时，请稍后重试'))
                        }
                        return
                    }
                    if (err instanceof DOMException && err.name === 'AbortError') return
                    callbacks.onError?.(err instanceof Error ? err : new Error(String(err)))
                }
            })()

            return {
                abort: () => controller.abort(),
                get streaming() { return streaming },
            }
        },

        /**
         * AI 虚拟对手作答 —— deepseek-v4-pro 模拟"思考时延"与准确率
         * DEMO 模式下根据难度档位生成不同的响应时延和准确率
         */
        aiOpponentAnswer: async (lessonId: string, req: AIOpponentAnswerRequest): Promise<AIOpponentAnswerResult> => {
            // 难度对应的"思考时延"（ms）与准确率
            const levelConfig: Record<AIOpponentLevel, { latency: [number, number]; accuracy: number }> = {
                easy: { latency: [3500, 6000], accuracy: 0.55 },
                medium: { latency: [2000, 4000], accuracy: 0.75 },
                hard: { latency: [800, 2000], accuracy: 0.92 },
            }
            const cfg = levelConfig[req.level]
            const latency = Math.round(cfg.latency[0] + Math.random() * (cfg.latency[1] - cfg.latency[0]))
            // 模拟思考延迟
            await new Promise((resolve) => setTimeout(resolve, isDemoMode() ? Math.min(latency, 1500) : latency))

            if (isDemoMode()) {
                const correct = Math.random() < cfg.accuracy
                let answer = ''
                let reasoning = ''
                if (req.mode === 'flying-flower' && req.flyingFlowerKeyword) {
                    const kw = req.flyingFlowerKeyword
                    const samples = [
                        `${kw}色满园关不住，一枝红杏出墙来`,
                        `春风又绿江南岸，明月何时照我还${kw}`,
                        `${kw}花潭水深深千尺，不及汪伦送我情`,
                    ]
                    answer = correct ? samples[Math.floor(Math.random() * samples.length)] ?? samples[0] ?? '' : `无关${kw}字的诗句`
                    reasoning = correct ? `含"${kw}"字的诗句` : `未能在限定时间内匹配到含"${kw}"的诗句`
                } else if (req.mode === 'poem-relay' && req.relayPrevious) {
                    answer = correct ? '接下一句：上句已吟罢，下句续以情' : 'AI 一时语塞，未接上'
                    reasoning = correct ? `根据"${req.relayPrevious.slice(-12)}"的平仄与意境延续` : '未能匹配到合适的下句'
                } else if (req.options && req.options.length > 0) {
                    const idx = correct ? 0 : Math.floor(Math.random() * req.options.length)
                    answer = req.options[idx] ?? ''
                    reasoning = correct ? '选取最契合题意的选项' : '选项匹配失误'
                } else {
                    answer = correct ? '此句意境深远，作者借景抒情，托物言志。' : 'AI 思考中断，未给出完整答案'
                    reasoning = correct ? '综合题干信息作答' : '理解偏差'
                }
                return {
                    lessonId,
                    answer,
                    correct,
                    score: correct ? (req.level === 'hard' ? 95 : req.level === 'medium' ? 85 : 70) : 30,
                    latencyMs: latency,
                    reasoning,
                    model: 'deepseek-v4-pro',
                    answeredAt: Date.now(),
                    aiGenerated: true,
                }
            }
            return fetchJSON<AIOpponentAnswerResult & ApiEnvelope>(
                // 后端契约：POST /api/classroom/sessions/:sessionId/virtual-opponent
                // （lessonId 与 sessionId 共用同一 runtime Map，直接作为 sessionId 传入）
                `/classroom/sessions/${encodeURIComponent(lessonId)}/virtual-opponent`,
                {
                    method: 'POST',
                    body: JSON.stringify(req),
                },
            ).then(unwrap<AIOpponentAnswerResult>)
        },
    },

    // Phase 4.4：鉴赏指导（学生闭环 S5 运用）
    appreciation: {
        /** 获取诗篇鉴赏指导（四步鉴赏法 + 炼字赏析） */
        get: async (poemId: string): Promise<AppreciationGuideResponse> => {
            if (isDemoMode()) {
                return (await loadDemo()).getDemoAppreciationGuide(poemId)
            }
            return fetchJSON<AppreciationGuideResponse & ApiEnvelope>(
                `/appreciation/${encodeURIComponent(poemId)}`,
            ).then(unwrap<AppreciationGuideResponse>)
        },
    },

    grading: {
        /**
         * 上传答题图片（multipart/form-data）
         *
         * @param files 图片文件列表（jpg/png/webp，单文件 ≤10MB，单批次 ≤30 张）
         * @param classId 班级 ID（必填）
         * @param lessonId 课程 ID（可选）
         * @param questionId 题目 ID（可选，指定后跳过自动匹配）
         */
        upload: async (
            files: File[],
            classId: string,
            lessonId?: string,
            questionId?: string,
        ): Promise<UploadResponse> => {
            const form = new FormData()
            for (const f of files) {
                form.append('files', f, f.name)
            }
            form.append('classId', classId)
            if (lessonId) form.append('lessonId', lessonId)
            if (questionId) form.append('questionId', questionId)

            // 图片批次较大，使用独立 60 秒超时并覆盖 JSON 正文消费。
            const timeoutController = new AbortController()
            const timeoutId = window.setTimeout(() => timeoutController.abort(), 60_000)
            try {
                const res = await fetch(`${API_BASE}/grading/upload`, {
                    method: 'POST',
                    body: form,
                    // 注意：multipart 不可设置 Content-Type，浏览器自动添加 boundary
                    signal: timeoutController.signal,
                })
                if (!res.ok) {
                    if (import.meta.env.DEV) {
                        const text = await res.text().catch((error) => {
                            if (timeoutController.signal.aborted) throw new Error('批改图片上传超时，请稍后重试')
                            if (import.meta.env.DEV) console.debug('[api] grading.upload 错误正文读取失败:', error)
                            return ''
                        })
                        throw new ApiError(res.status, res.statusText, text || undefined)
                    }
                    throw new ApiError(res.status, res.statusText)
                }
                return await res.json() as UploadResponse
            } catch (err) {
                if (err instanceof ApiError) throw err
                if (timeoutController.signal.aborted) throw new Error('批改图片上传超时，请稍后重试')
                if (import.meta.env.DEV) console.debug('[api] grading.upload 失败:', err)
                throw new Error('批改图片上传失败，请稍后重试')
            } finally {
                window.clearTimeout(timeoutId)
            }
        },

        students: (classId: string) =>
            fetchJSON<{ students: GradingStudentOption[] } & ApiEnvelope>(
                `/grading/students?classId=${encodeURIComponent(classId)}`,
            ).then(unwrap<{ students: GradingStudentOption[] }>),

        questions: (poemId: string) =>
            fetchJSON<{ questions: GradingQuestionOption[] } & ApiEnvelope>(
                `/grading/questions?poemId=${encodeURIComponent(poemId)}`,
            ).then(unwrap<{ questions: GradingQuestionOption[] }>),

        history: (classId: string) =>
            fetchJSON<{ batches: GradingBatchHistoryItem[] } & ApiEnvelope>(
                `/grading/history?classId=${encodeURIComponent(classId)}`,
            ).then(unwrap<{ batches: GradingBatchHistoryItem[] }>),

        /** 调用诗眼 Agent 识别手写内容 */
        recognize: (batchId: string) =>
            fetchJSON<RecognizeResponse>('/grading/recognize', {
                method: 'POST',
                body: JSON.stringify({ batchId }),
            }),

        /** 调用诗笔 Agent 批改 */
        grade: (batchId: string, items: GradeRequestItem[]) =>
            fetchJSON<GradeResponse>('/grading/grade', {
                method: 'POST',
                body: JSON.stringify({ batchId, items }),
            }),

        /** 教师审核（确认/修正/标记为参考） */
        review: (req: ReviewRequest) =>
            fetchJSON<ReviewResponse>('/grading/review', {
                method: 'POST',
                body: JSON.stringify(req),
            }),

        /** 查询批次状态 */
        getBatch: (batchId: string) =>
            fetchJSON<GradingBatch>(`/grading/batch/${encodeURIComponent(batchId)}`),

        /** 删除批次（清理磁盘文件） */
        deleteBatch: (batchId: string) =>
            fetchJSON<{ status: 'ok'; success: true }>(
                `/grading/batch/${encodeURIComponent(batchId)}`,
                { method: 'DELETE' },
            ),

        // ── 批改诊断深化能力 1/5：多维度评分 ──

        /** 单条多维度评分（六维度 + 教师可调权重） */
        scoreMultiDim: (req: MultiDimScoreRequest) =>
            fetchJSON<MultiDimScoreOutput & ApiEnvelope>(
                `/grading/${encodeURIComponent(req.fileId)}/score-multi-dim`,
                {
                    method: 'POST',
                    body: JSON.stringify({
                        questionId: req.questionId,
                        studentAnswer: req.studentAnswer,
                        weights: req.weights,
                    }),
                },
            ).then(unwrap<MultiDimScoreOutput>),

        /** 批量多维度评分（控制并发避免限流） */
        batchScore: (req: BatchScoreRequest) =>
            fetchJSON<BatchScoreResponse & ApiEnvelope>(
                '/grading/batch-score',
                {
                    method: 'POST',
                    body: JSON.stringify(req),
                },
            ).then(unwrap<BatchScoreResponse>),

        // ── 批改诊断深化能力 2/5：手写识别 ──

        /** 单张手写识别（mimo-v2.5 多模态，含逐字置信度 + 可疑字标记） */
        ocr: (req: HandwritingOcrRequest) =>
            fetchJSON<HandwritingOcrOutput & ApiEnvelope>(
                '/grading/ocr',
                {
                    method: 'POST',
                    body: JSON.stringify(req),
                },
            ).then(unwrap<HandwritingOcrOutput>),

        /** 批量手写识别（多图并行，控制并发） */
        ocrBatch: (req: BatchOcrRequest) =>
            fetchJSON<BatchOcrResponse & ApiEnvelope>(
                '/grading/ocr-batch',
                {
                    method: 'POST',
                    body: JSON.stringify(req),
                },
            ).then(unwrap<BatchOcrResponse>),

        // ── 批改诊断深化能力 3/5：错题归因 ──

        /** 单条错题归因（五类错误 + 知识图谱关联 + 教学干预建议） */
        attribute: (req: ErrorAttributionRequest) =>
            fetchJSON<ErrorAttributionOutput & ApiEnvelope>(
                `/grading/${encodeURIComponent(req.fileId)}/attribute`,
                {
                    method: 'POST',
                    body: JSON.stringify({
                        questionId: req.questionId,
                        studentAnswer: req.studentAnswer,
                    }),
                },
            ).then(unwrap<ErrorAttributionOutput>),
    },

    workbench: {
        /** 拉取古诗列表（用于下拉选择） */
        listPoems: () =>
            fetchJSON<{ poems: WorkbenchPoemOption[] } & ApiEnvelope>(
                '/workbench/poems',
            ).then(unwrap<{ poems: WorkbenchPoemOption[] }>),

        /** 生成题目（异步，返回 sessionId） */
        generate: (req: WorkbenchGenerateRequest) =>
            fetchJSON<WorkbenchGenerateResponse & ApiEnvelope>('/workbench/generate', {
                method: 'POST',
                body: JSON.stringify(req),
            }).then(unwrap<WorkbenchGenerateResponse>),

        /** 微调单题（同步，返回精修后的题目） */
        refine: (req: WorkbenchRefineRequest) =>
            fetchJSON<WorkbenchRefineResponse & ApiEnvelope>('/workbench/refine', {
                method: 'POST',
                body: JSON.stringify(req),
            }).then(unwrap<WorkbenchRefineResponse>),

        /** 按 sessionId 拉取生成结果 */
        questions: (sessionId: string) =>
            fetchJSON<WorkbenchQuestionsResponse & ApiEnvelope>(
                `/workbench/questions?sessionId=${encodeURIComponent(sessionId)}`,
            ).then(unwrap<WorkbenchQuestionsResponse>),

        /** 导出题目为 JSON / CSV */
        export: (req: WorkbenchExportRequest) =>
            fetchJSON<WorkbenchExportResponse & ApiEnvelope>('/workbench/export', {
                method: 'POST',
                body: JSON.stringify(req),
            }).then(unwrap<WorkbenchExportResponse>),


        /** 发布为课堂闯关任务 */
        publish: (req: WorkbenchPublishRequest) =>
            fetchJSON<WorkbenchPublishResponse & ApiEnvelope>('/workbench/publish', {
                method: 'POST',
                body: JSON.stringify(req),
            }).then(unwrap<WorkbenchPublishResponse>),

        /* ============================================================
         * Task 21：命题工坊全链路打通扩展接口
         * ============================================================ */

        /**
         * Agent 编排 SSE 流式（SubTask 21.1）
         *
         * 端点：POST /api/agents/orchestrate
         * 协议：SSE，逐帧推送 WorkbenchAgentEvent
         * 任务：question_generate（命题工坊固定 4 Agent）
         *
         * 4 Agent 流程：
         *   1. question_generator（出题 Agent）
         *   2. verifier（验证 Agent）
         *   3. refiner（精修 Agent）
         *   4. accepter（验收 Agent）
         */
        orchestrateAgents: (
            req: WorkbenchAgentOrchestrateRequest,
            callbacks: WorkbenchAgentStreamCallbacks,
        ): WorkbenchAgentStreamController => streamAgentOrchestrateSSE(req, callbacks),

        /**
         * 题卡列表查询（SubTask 21.2）
         *
         * 端点：GET /api/workbench/questions
         * 支持分页 / 按类型·难度·知识点筛选 / 按难度·创建时间·分值排序
         */
        listQuestions: (query: WorkbenchQuestionQuery = {}): Promise<WorkbenchQuestionListResponse> => {
            const params = new URLSearchParams()
            if (query.page) params.set('page', String(query.page))
            if (query.pageSize) params.set('pageSize', String(query.pageSize))
            if (query.type) params.set('type', query.type)
            if (query.difficulty) params.set('difficulty', String(query.difficulty))
            if (query.knowledgePoint) params.set('knowledgePoint', query.knowledgePoint)
            if (query.sortBy) params.set('sortBy', query.sortBy)
            if (query.sortOrder) params.set('sortOrder', query.sortOrder)
            if (query.sessionId) params.set('sessionId', query.sessionId)
            const qs = params.toString()
            return fetchJSON<WorkbenchQuestionListResponse & ApiEnvelope>(
                `/workbench/questions${qs ? `?${qs}` : ''}`,
            ).then(unwrap<WorkbenchQuestionListResponse>)
        },

        /**
         * 题卡收藏目标态写入（SubTask 21.2）
         *
         * 端点：POST /api/workbench/questions/:id/favorite
         * 显式提交目标状态；请求超时后用相同参数重试仍保持幂等。
         */
        setFavorite: (questionId: string, favorited: boolean): Promise<WorkbenchFavoriteResponse> =>
            fetchJSON<WorkbenchFavoriteResponse & ApiEnvelope>(
                `/workbench/questions/${encodeURIComponent(questionId)}/favorite`,
                {
                    method: 'POST',
                    body: JSON.stringify({ favorited } satisfies WorkbenchFavoriteRequest),
                },
            ).then(unwrap<WorkbenchFavoriteResponse>),

        /**
         * 复制题卡（SubTask 21.2）
         *
         * 端点：POST /api/workbench/questions/:id/duplicate
         * 创建一道相同题卡（新 ID）
         */
        duplicateQuestion: (questionId: string): Promise<WorkbenchQuestionMeta> =>
            fetchJSON<WorkbenchQuestionMeta & ApiEnvelope>(
                `/workbench/questions/${encodeURIComponent(questionId)}/duplicate`,
                { method: 'POST' },
            ).then(unwrap<WorkbenchQuestionMeta>),

        /**
         * 删除题卡（SubTask 21.2）
         *
         * 端点：DELETE /api/workbench/questions/:id
         */
        deleteQuestion: (questionId: string): Promise<{ questionId: string; deleted: boolean }> =>
            fetchJSON<{ questionId: string; deleted: boolean; status: 'ok' } & ApiEnvelope>(
                `/workbench/questions/${encodeURIComponent(questionId)}`,
                { method: 'DELETE' },
            ).then(unwrap<{ questionId: string; deleted: boolean }>),

        /**
         * 更新题卡（SubTask 21.2 手动编辑）
         *
         * 端点：PATCH /api/workbench/questions/:id
         */
        updateQuestion: (questionId: string, patch: Partial<WorkbenchQuestionMeta>): Promise<WorkbenchQuestionMeta> =>
            fetchJSON<WorkbenchQuestionMeta & ApiEnvelope>(
                `/workbench/questions/${encodeURIComponent(questionId)}`,
                { method: 'PATCH', body: JSON.stringify(patch) },
            ).then(unwrap<WorkbenchQuestionMeta>),

        /**
         * 题卡质量验证（SubTask 21.3）
         *
         * 端点：GET /api/workbench/questions/:id/verification
         * 返回 5 维度质量数据：难度/区分度/覆盖率/答案正确性/清晰度
         */
        fetchVerification: (questionId: string): Promise<WorkbenchQuestionVerification> =>
            fetchJSON<WorkbenchQuestionVerification & ApiEnvelope>(
                `/workbench/questions/${encodeURIComponent(questionId)}/verification`,
            ).then(unwrap<WorkbenchQuestionVerification>),

        /**
         * 导出 Word 兼容文档 / Excel 兼容 CSV / PDF 打印版 HTML / JSON / CSV。
         *
         * 端点：POST /api/workbench/export
         * 返回 Blob 文件流，前端触发浏览器下载
         */
        exportDocument: async (req: WorkbenchDocExportRequest): Promise<WorkbenchDocExportResponse> => {
            const blob = await fetchBlob('/workbench/export', {
                method: 'POST',
                body: JSON.stringify(req),
                headers: { Accept: 'application/octet-stream' },
            })
            // 从 Content-Disposition 头解析文件名（fetchBlob 已剥离 envelope，这里用合成名）
            const ext = req.format === 'word'
                ? 'doc'
                : req.format === 'excel'
                    ? 'csv'
                    : req.format === 'pdf'
                        ? 'html'
                        : req.format
            const filename = `命题导出_${Date.now()}.${ext}`
            return { blob, filename, count: req.questionIds.length }
        },

        /**
         * 智能组卷（Task 22 SubTask 22.3）
         *
         * 端点：POST /api/workbench/smart-compose
         * 后端 AI 组卷：按难度分布 + 知识点覆盖 + 总分自动组卷
         */
        smartCompose: (req: WorkbenchSmartComposeRequest): Promise<WorkbenchSmartComposeResponse> =>
            fetchJSON<WorkbenchSmartComposeResponse & ApiEnvelope>('/workbench/smart-compose', {
                method: 'POST',
                body: JSON.stringify(req),
            }).then(unwrap<WorkbenchSmartComposeResponse>),
    },

    /* ============================================================
     * Task 22：学生薄弱点 API
     * ============================================================ */
    students: {
        /**
         * 学生列表（Combobox 用，按班级过滤）
         *
         * 端点：GET /api/students?classId=xxx
         */
        list: (classId?: string): Promise<{ students: StudentOption[] }> => {
            const qs = classId ? `?classId=${encodeURIComponent(classId)}` : ''
            return fetchJSON<{ students: StudentOption[] } & ApiEnvelope>(
                `/students${qs}`,
            ).then(unwrap<{ students: StudentOption[] }>)
        },

        /**
         * 学生薄弱知识点（SubTask 22.2）
         *
         * 端点：GET /api/students/:id/weak-points
         * 返回该生的薄弱知识点列表（带掌握度 level 0-100）
         */
        weakPoints: (studentId: string): Promise<StudentWeakPointsResponse> =>
            fetchJSON<StudentWeakPointsResponse & ApiEnvelope>(
                `/students/${encodeURIComponent(studentId)}/weak-points`,
            ).then(unwrap<StudentWeakPointsResponse>),
    },

    /* ============================================================
     * 长期记忆治理 —— 教师显式查看/新增/修改/删除
     * ============================================================ */
    memory: {
        list: (params: {
            teacherId: string
            kind?: 'student' | 'teacher'
            classId?: string
            studentId?: string
            limit?: number
        }): Promise<MemoryGovernanceListResponse> => {
            const qs = new URLSearchParams({ teacherId: params.teacherId })
            if (params.kind) qs.set('kind', params.kind)
            if (params.classId) qs.set('classId', params.classId)
            if (params.studentId) qs.set('studentId', params.studentId)
            if (params.limit !== undefined) qs.set('limit', String(params.limit))
            return fetchJSON<MemoryGovernanceListResponse & ApiEnvelope>(`/memory?${qs.toString()}`)
                .then(unwrap<MemoryGovernanceListResponse>)
        },

        create: (request: MemoryGovernanceCreateRequest): Promise<{ memory: MemoryGovernanceItem }> =>
            fetchJSON<{ memory: MemoryGovernanceItem } & ApiEnvelope>('/memory', {
                method: 'POST',
                body: JSON.stringify(request),
            }).then(unwrap<{ memory: MemoryGovernanceItem }>),

        update: (id: string, request: MemoryGovernanceUpdateRequest): Promise<{ memory: MemoryGovernanceItem }> =>
            fetchJSON<{ memory: MemoryGovernanceItem } & ApiEnvelope>(`/memory/${encodeURIComponent(id)}`, {
                method: 'PATCH',
                body: JSON.stringify(request),
            }).then(unwrap<{ memory: MemoryGovernanceItem }>),

        delete: (id: string, teacherId: string): Promise<{ deleted: number }> =>
            fetchJSON<{ deleted: number } & ApiEnvelope>(
                `/memory/${encodeURIComponent(id)}?teacherId=${encodeURIComponent(teacherId)}`,
                { method: 'DELETE' },
            ).then(unwrap<{ deleted: number }>),

        clear: (params: {
            teacherId: string
            kind?: 'student' | 'teacher'
            classId?: string
            studentId?: string
        }): Promise<{ deleted: number }> => {
            const qs = new URLSearchParams({ teacherId: params.teacherId })
            if (params.kind) qs.set('kind', params.kind)
            if (params.classId) qs.set('classId', params.classId)
            if (params.studentId) qs.set('studentId', params.studentId)
            return fetchJSON<{ deleted: number } & ApiEnvelope>(`/memory?${qs.toString()}`, {
                method: 'DELETE',
            }).then(unwrap<{ deleted: number }>)
        },
    },

    copilot: {
        /** 发送消息，编排官解析为 DAG 计划 */
        chat: (req: CopilotChatRequest) =>
            fetchJSON<CopilotChatResponse>('/copilot/chat', {
                method: 'POST',
                body: JSON.stringify(req),
            }).then((res) =>
                // v5.0 Task C.1.2：运行时 shape 校验，畸形响应降级为 fallback（防止 parsedInstruction 畸形导致编排崩溃）
                validateOr(res, copilotChatValidator, copilotChatFallback, 'api/copilot/chat'),
            ),

        /** 列出历史会话 */
        listSessions: (teacherId?: string) =>
            fetchJSON<CopilotSessionsResponse>(
                `/copilot/sessions${teacherId ? `?teacherId=${encodeURIComponent(teacherId)}` : ''}`,
            ),

        /** 查询会话详情 */
        getSession: (id: string) =>
            fetchJSON<CopilotSessionDetailResponse>(`/copilot/sessions/${encodeURIComponent(id)}`),

        /** 删除会话 */
        deleteSession: (id: string) =>
            fetchJSON<{ status: 'ok'; deleted: string }>(
                `/copilot/sessions/${encodeURIComponent(id)}`,
                { method: 'DELETE' },
            ),

        /** 快捷指令（预填消息模板，返回 sessionId） */
        quickAction: (req: CopilotQuickActionRequest) =>
            fetchJSON<CopilotQuickActionResponse>('/copilot/quick-action', {
                method: 'POST',
                body: JSON.stringify(req),
            }),

        /** 教师反馈（写入自我进化引擎） */
        feedback: (req: CopilotFeedbackRequest) =>
            fetchJSON<{ status: 'ok'; message: string; sessionId: string }>(
                '/copilot/feedback',
                {
                    method: 'POST',
                    body: JSON.stringify(req),
                },
            ),

        /** Agent 中文标签（前端水印用） */
        agentLabels: () =>
            fetchJSON<CopilotAgentLabelsResponse>('/copilot/agent-labels'),

        // ── v5.0 创新点：深度思考模式 UI 暴露 ──
        /** 获取当前全局思考模式（null 表示未覆盖，使用路由矩阵预设） */
        getThinkingMode: () =>
            fetchJSON<{ status: 'ok'; mode: 'low' | 'medium' | 'high' | 'max' | null }>(
                '/copilot/thinking-mode',
            ),

        /** 设置全局思考模式覆盖（null 清除覆盖，恢复路由矩阵预设） */
        setThinkingMode: (mode: 'low' | 'medium' | 'high' | 'max' | null) =>
            fetchJSON<{
                status: 'ok'
                mode: 'low' | 'medium' | 'high' | 'max' | null
                message: string
            }>('/copilot/thinking-mode', {
                method: 'POST',
                body: JSON.stringify({ mode }),
            }),

        /**
         * B2.1 真流式 SSE 调用（/copilot/stream-chat）
         *
         * 返回一个可取消的流式控制器。每个 ChatChunk 通过 onChunk 回调推送，
         * 仅收到 [DONE] 时触发 onDone；无终止帧的 EOF 视为截断错误。
         *
         * 与 useSSE hook 的区别：
         *   - useSSE 是 React Hook，绑定组件生命周期
         *   - streamChat 是命令式 API，可在非组件代码（store/vanilla JS）中使用
         *
         * 数据流：
         *   fetch POST → ReadableStream → 解析 SSE 帧 → onChunk(ChatChunk)
         *
         * 使用示例：
         * ``ts
         * const ctrl = api.copilot.streamChat(
         *   { messages: [{ role: 'user', content: '你好' }] },
         *   { onChunk: (c) => console.log(c.content), onDone: () => {} },
         * )
         * // 中止
         * ctrl.abort()
         * ``(end code fence)
         */
        streamChat: (
            req: CopilotStreamChatRequest,
            callbacks: CopilotStreamCallbacks,
        ): CopilotStreamController => {
            const controller = new AbortController()
            let streaming = true

            // 异步执行流式请求（不返回 Promise，通过回调驱动）
            void (async () => {
                try {
                    const res = await fetchStreamResponse(`${API_BASE}/copilot/stream-chat`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            Accept: 'text/event-stream',
                        },
                        body: JSON.stringify(req),
                        signal: controller.signal,
                    }, controller)

                    // HTTP 错误：尝试解析错误体
                    if (!res.ok) {
                        let errMsg = `HTTP ${res.status} ${res.statusText}`
                        try {
                            const ct = res.headers.get('content-type') ?? ''
                            if (ct.includes('application/json')) {
                                const errJson = (await res.json()) as { message?: string; error?: string }
                                if (errJson.message) errMsg = errJson.message
                                else if (errJson.error) errMsg = errJson.error
                            } else {
                                const text = await res.text()
                                if (text) errMsg = text
                            }
                        } catch {
                            // 响应体解析失败
                        }
                        throw new Error(errMsg)
                    }

                    if (!res.body) {
                        throw new Error('响应体为空，无法消费 SSE 流')
                    }

                    const reader = res.body.getReader()
                    const decoder = new TextDecoder('utf-8')
                    let buffer = ''
                    let terminalSeen = false

                    // eslint-disable-next-line no-constant-condition
                    while (true) {
                        const { done, value } = await readStreamChunk(reader, controller)
                        if (done) break

                        buffer += decoder.decode(value, { stream: true })

                        // 按 \n\n 切帧
                        let frameEnd: number
                        while ((frameEnd = buffer.indexOf('\n\n')) !== -1) {
                            const frameText = buffer.slice(0, frameEnd)
                            buffer = buffer.slice(frameEnd + 2)

                            // 提取 data: 行
                            const dataLines: string[] = []
                            for (const line of frameText.split('\n')) {
                                const trimmed = line.trim()
                                if (trimmed.startsWith('data: ')) {
                                    dataLines.push(trimmed.slice(6))
                                } else if (trimmed === 'data') {
                                    dataLines.push('')
                                }
                            }
                            if (dataLines.length === 0) continue
                            const data = dataLines.join('\n')

                            // [DONE] 标记
                            if (data === '[DONE]') {
                                terminalSeen = true
                                streaming = false
                                try {
                                    await reader.cancel()
                                } catch {
                                    // ignore
                                }
                                callbacks.onDone?.()
                                return
                            }

                            // JSON 解析
                            try {
                                const chunk = JSON.parse(data) as CopilotStreamChunk
                                // 错误帧特殊处理
                                if (chunk.error) {
                                    streaming = false
                                    callbacks.onError?.(errorFromSseFrame(chunk))
                                    try {
                                        await reader.cancel()
                                    } catch {
                                        // ignore
                                    }
                                    return
                                }
                                callbacks.onChunk(chunk)
                            } catch {
                                // 普通解析失败，跳过该帧
                                console.warn('[api.copilot.streamChat] 帧解析失败，跳过:', data)
                            }
                        }
                    }

                    // 流自然结束
                    streaming = false
                    if (!requireExplicitSseTerminal(terminalSeen, controller.signal)) return
                    callbacks.onDone?.()
                } catch (err) {
                    streaming = false
                    // 主动 abort 不算错误
                    if (controller.signal.aborted) {
                        if (controller.signal.reason === STREAM_IDLE_TIMEOUT_REASON) {
                            callbacks.onError?.(new Error('流式响应超时，请稍后重试'))
                        }
                        return
                    }
                    if (err instanceof DOMException && err.name === 'AbortError') return
                    const finalErr = err instanceof Error ? err : new Error(String(err))
                    callbacks.onError?.(finalErr)
                }
            })()

            return {
                abort: () => {
                    if (streaming) {
                        streaming = false
                        controller.abort()
                    }
                },
                get streaming() {
                    return streaming
                },
            }
        },
    },

    orchestrator: {
        /** 执行已解析的 plan（异步，立即返回 sessionId，结果通过 WS 推送） */
        execute: (req: OrchestratorExecuteRequest) =>
            fetchJSON<OrchestratorExecuteResponse>('/orchestrator/execute', {
                method: 'POST',
                body: JSON.stringify(req),
            }),

        /** 暂停任务 */
        pause: (req: OrchestratorTaskControlRequest) =>
            fetchJSON<{ status: 'ok'; message: string; sessionId: string; taskId: string }>(
                '/orchestrator/pause',
                { method: 'POST', body: JSON.stringify(req) },
            ),

        /** 恢复任务 */
        resume: (req: OrchestratorTaskControlRequest) =>
            fetchJSON<{ status: 'ok'; message: string; sessionId: string; taskId: string }>(
                '/orchestrator/resume',
                { method: 'POST', body: JSON.stringify(req) },
            ),

        /** 中止会话 */
        abort: (req: OrchestratorAbortRequest) =>
            fetchJSON<{ status: 'ok'; message: string; sessionId: string }>(
                '/orchestrator/abort',
                { method: 'POST', body: JSON.stringify(req) },
            ),

        /** 修正任务输入并重新执行 */
        modify: (req: OrchestratorModifyRequest) =>
            fetchJSON<{ status: 'ok'; message: string; sessionId: string; taskId: string }>(
                '/orchestrator/modify',
                { method: 'POST', body: JSON.stringify(req) },
            ),

        /** 查询会话状态 */
        getSession: (id: string) =>
            fetchJSON<OrchestratorSessionResponse>(`/orchestrator/sessions/${encodeURIComponent(id)}`),

        /** 查询当前教师名下会话的脱敏运行证据 */
        getTrace: (id: string, teacherId: string, limit = 200) =>
            fetchJSON<OrchestratorTraceResponse>(
                `/orchestrator/sessions/${encodeURIComponent(id)}/trace?teacherId=${encodeURIComponent(teacherId)}&limit=${limit}`,
            ).then((response) => orchestratorTraceValidator(response, 'api/orchestrator/trace')),
    },

    report: {
        /** 拉取报告模板与章节配置 */
        templates: () =>
            fetchJSON<ReportTemplatesResponse>('/report/templates'),

        /** 生成教研报告（异步，立即返回 reportId + sessionId，结果通过 WS 推送） */
        generate: (req: ReportGenerateRequest) =>
            fetchJSON<ReportGenerateResponse & ApiEnvelope>('/report/generate', {
                method: 'POST',
                body: JSON.stringify(req),
            }).then(unwrap<ReportGenerateResponse>),

        /** 查询报告内容（生成中返回进度，完成返回完整报告） */
        getReport: (reportId: string, signal?: AbortSignal) =>
            fetchJSON<ReportGetResponse & ApiEnvelope>(
                `/report/${encodeURIComponent(reportId)}`,
                { signal },
            ).then(unwrap<ReportGetResponse>),

        /** 查询历史报告列表（分页 + 搜索） */
        list: (params: {
            teacherId?: string
            classId?: string
            limit?: number
            offset?: number
            keyword?: string
        } = {}) => {
            const qs = new URLSearchParams()
            if (params.teacherId) qs.set('teacherId', params.teacherId)
            if (params.classId) qs.set('classId', params.classId)
            if (params.limit !== undefined) qs.set('limit', String(params.limit))
            if (params.offset !== undefined) qs.set('offset', String(params.offset))
            if (params.keyword) qs.set('keyword', params.keyword)
            const query = qs.toString()
            return fetchJSON<ReportListResponse & ApiEnvelope>(
                `/report${query ? `?${query}` : ''}`,
            ).then(unwrap<ReportListResponse>)
        },

        /** 删除报告 */
        delete: (reportId: string, teacherId?: string) => {
            const qs = teacherId ? `?teacherId=${encodeURIComponent(teacherId)}` : ''
            return fetchJSON<{ status: 'ok'; reportId: string; deleted: true }>(
                `/report/${encodeURIComponent(reportId)}${qs}`,
                { method: 'DELETE' },
            )
        },

        /** 导出报告为 Word 兼容 .doc / PDF 打印版 HTML / Markdown。 */
        exportReport: async (
            reportId: string,
            format: ReportExportFormat,
            fileName: string,
        ): Promise<void> => {
            const blob = await fetchBlob(
                `/report/${encodeURIComponent(reportId)}/export?format=${format}`,
            )
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            const ext = format === 'markdown' ? 'md' : format === 'word' ? 'doc' : 'html'
            a.download = `${fileName}.${ext}`
            a.click()
            URL.revokeObjectURL(url)
        },

        /** 预览报告打印版（PDF/打印友好 HTML，新窗口打开） */
        previewPrint: (reportId: string) => {
            window.open(
                `${API_BASE}/report/${encodeURIComponent(reportId)}/export?format=pdf`,
                '_blank',
                'noopener,noreferrer',
            )
        },

        // ── v5.0 ReportPage 数据真实化扩展方法 ──

        /** 拉取报告图表数据（4 类：成绩分布/知识点掌握度/Bloom 分布/周次对比） */
        charts: (reportId: string) =>
            fetchJSON<ReportChartsData & ApiEnvelope>(
                `/report/${encodeURIComponent(reportId)}/charts`,
            ).then(unwrap<ReportChartsData>),

        /** 拉取报告预览（Markdown 全文，一次性返回；流式生成时由 generate SSE 推送增量） */
        preview: (reportId: string) =>
            fetchJSON<ReportPreviewData & ApiEnvelope>(
                `/report/${encodeURIComponent(reportId)}/preview`,
            ).then(unwrap<ReportPreviewData>),

        /**
         * 高级导出（POST，支持选择模块 + 图表 + 验收信息）
         *
         * 与 exportReport 区别：
         *   - exportReport 是 GET 简单导出（向后兼容）
         *   - exportAdvanced 是 POST，支持 includeSections / includeCharts / includeVerification
         *
         * 后端返回结构化导出结果；前端按真实 MIME 与真实扩展名下载。
         */
        exportAdvanced: async (req: ReportExportRequest, fileName: string): Promise<void> => {
            const { reportId, ...options } = req
            const payload = await fetchJSON<{
                result?: {
                    success?: boolean
                    mimeType?: string
                    content?: string
                    error?: string
                }
            }>(`/report/export/${encodeURIComponent(reportId)}`, {
                method: 'POST',
                body: JSON.stringify(options),
            })
            const result = payload.result
            if (!result?.success || typeof result.content !== 'string' || !result.mimeType) {
                throw new ApiError(500, '导出失败', result?.error ?? '服务端未返回可下载内容')
            }

            const blob = new Blob([result.content], { type: `${result.mimeType};charset=utf-8` })
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            const ext =
                req.format === 'markdown' ? 'md'
                    : req.format === 'word' ? 'doc'
                        : req.format === 'excel' ? 'csv'
                            : 'html'
            const suffix = req.format === 'pdf' ? '-打印版' : ''
            a.download = `${fileName}${suffix}.${ext}`
            a.click()
            window.setTimeout(() => URL.revokeObjectURL(url), 1000)
        },

        // 说明：此处原有一个 `homeSchoolBook(classId, weekKey)`，请求
        // `GET /report/home-school-book?classId=...`。后端从来没有这条路由，
        // 请求会被 `GET /report/:reportId` 兜底吃掉并返回
        // 404「报告 home-school-book 不存在」——家校联系本因此**永远停在错误态**。
        // 真正可用的家校能力在下方的 `api.homeSchool`，已改为使用它。

        /** 历史报告（扩展 list，支持时间范围/模板/状态筛选） */
        history: (params: ReportHistoryQuery = {}) => {
            const qs = new URLSearchParams()
            if (params.teacherId) qs.set('teacherId', params.teacherId)
            if (params.classId) qs.set('classId', params.classId)
            if (params.from) qs.set('from', params.from)
            if (params.to) qs.set('to', params.to)
            if (params.template) qs.set('template', params.template)
            if (params.status) qs.set('status', params.status)
            if (params.keyword) qs.set('keyword', params.keyword)
            if (params.limit !== undefined) qs.set('limit', String(params.limit))
            if (params.offset !== undefined) qs.set('offset', String(params.offset))
            const query = qs.toString()
            return fetchJSON<ReportHistoryResponse & ApiEnvelope>(
                `/report/history${query ? `?${query}` : ''}`,
            ).then(unwrap<ReportHistoryResponse>)
        },

        /**
         * 流式生成报告（SSE）
         *
         * 后端推送两种帧：
         *   { type: 'progress', progress: number, agentId?: string, message?: string }
         *   { type: 'delta', content: string }              // Markdown 增量
         *   { type: 'done', reportId: string }              // 生成完成
         *   { type: 'error', message: string }              // 错误
         */
        streamGenerate: (
            req: ReportGenerateRequest,
            callbacks: {
                onProgress?: (progress: number, agentId: string | undefined, message: string | undefined) => void
                onDelta?: (content: string) => void
                onDone?: (reportId: string) => void
                onError?: (err: Error) => void
            },
        ): LessonStreamController => {
            type StreamChunk =
                | { type: 'progress'; progress: number; agentId?: string; message?: string }
                | { type: 'delta'; content: string }
                | { type: 'done'; reportId: string }
                | { type: 'error'; message: string }
            return streamSSE<StreamChunk>(
                '/report/generate-stream',
                req,
                {
                    onChunk: (chunk) => {
                        if (chunk.type === 'progress') {
                            callbacks.onProgress?.(chunk.progress, chunk.agentId, chunk.message)
                        } else if (chunk.type === 'delta') {
                            callbacks.onDelta?.(chunk.content)
                        } else if (chunk.type === 'done') {
                            callbacks.onDone?.(chunk.reportId)
                        } else if (chunk.type === 'error') {
                            callbacks.onError?.(new Error(chunk.message))
                        }
                    },
                    onDone: () => {
                        // SSE 流关闭，无显式 done 帧时也触发完成
                        callbacks.onDone?.('')
                    },
                    onError: (err) => callbacks.onError?.(err),
                },
            )
        },
    },

    diagnosis: {
        /** 班级六阶能力分布（均值 + 标准差 + 学生数） */
        bloomDistribution: (classId: string) =>
            fetchJSON<BloomDistributionResponse & ApiEnvelope>(
                `/diagnosis/classes/${encodeURIComponent(classId)}/bloom-distribution`,
            ).then(unwrap<BloomDistributionResponse>),

        /** 班级学生 × 诗 × 六阶掌握度热力图 */
        heatmap: (classId: string) =>
            fetchJSON<HeatmapResponse & ApiEnvelope>(
                `/diagnosis/classes/${encodeURIComponent(classId)}/heatmap`,
            ).then(unwrap<HeatmapResponse>),

        /** 学生个体认知画像（六阶雷达 + 漏洞 + 路径） */
        studentProfile: (studentId: string) =>
            fetchJSON<StudentProfileResponse & ApiEnvelope>(
                `/diagnosis/students/${encodeURIComponent(studentId)}/profile`,
            ).then(unwrap<StudentProfileResponse>),

        /** 班级认知暗物质列表 */
        darkMatter: (classId: string) =>
            fetchJSON<DarkMatterListResponse & ApiEnvelope>(
                `/diagnosis/classes/${encodeURIComponent(classId)}/dark-matter`,
            ).then(unwrap<DarkMatterListResponse>),

        /** 暗物质汇总报告（按维度统计 + Top 5 模式） */
        darkMatterReport: (classId: string) =>
            fetchJSON<DarkMatterReportResponse & ApiEnvelope>(
                `/diagnosis/classes/${encodeURIComponent(classId)}/dark-matter/report`,
            ).then(unwrap<DarkMatterReportResponse>),

        /** 学生知识漏洞 */
        studentGaps: (studentId: string) =>
            fetchJSON<StudentGapsResponse & ApiEnvelope>(
                `/diagnosis/students/${encodeURIComponent(studentId)}/gaps`,
            ).then(unwrap<StudentGapsResponse>),

        /** 推荐学习路径 */
        learningPath: (studentId: string) =>
            fetchJSON<LearningPathResponse & ApiEnvelope>(
                `/diagnosis/students/${encodeURIComponent(studentId)}/learning-path`,
            ).then(unwrap<LearningPathResponse>),

        /** 靶向处方详情（按 patternId 查询） */
        prescription: (classId: string, patternId: string) =>
            fetchJSON<PrescriptionResponse & ApiEnvelope>(
                `/diagnosis/classes/${encodeURIComponent(classId)}/prescription/${encodeURIComponent(patternId)}`,
            ).then(unwrap<PrescriptionResponse>),

        /** Phase 4.2：教学调整建议（基于诊断数据 + 错题本数据，AI 综合生成） */
        suggestions: async (classId: string): Promise<TeachingSuggestionResponse> => {
            if (isDemoMode()) {
                return (await loadDemo()).getDemoTeachingSuggestions()
            }
            return fetchJSON<TeachingSuggestionResponse & ApiEnvelope>(
                `/diagnosis/classes/${encodeURIComponent(classId)}/suggestions`,
            ).then(unwrap<TeachingSuggestionResponse>)
        },

        // ── 批改诊断深化能力 4/5：学习路径生成（AI 深度推理 + SSE 流式） ──

        /** 获取 AI 生成的学习路径（非流式，含起点测试 + 薄弱点 + 序列 + 检查点） */
        getAiLearningPath: (studentId: string) =>
            fetchJSON<LearningPathOutput & ApiEnvelope>(
                `/diagnosis/students/${encodeURIComponent(studentId)}/learning-path`,
            ).then(unwrap<LearningPathOutput>),

        /** 流式生成 AI 学习路径（SSE，逐字推送） */
        streamAiLearningPath: (
            studentId: string,
            req: LearningPathGenerateRequest,
            callbacks: DiagnosisStreamCallbacks,
        ): LessonStreamController => {
            return streamDiagnosisSSE(
                `/diagnosis/students/${encodeURIComponent(studentId)}/learning-path`,
                { ...req, stream: true },
                callbacks,
            )
        },

        // ── 批改诊断深化能力 5/5：个性化处方（thinking: max + SSE 流式） ──

        /** 获取个性化处方（非流式，七大模块完整输出） */
        getPrescription: (studentId: string) =>
            fetchJSON<PrescriptionOutputEnvelope>(
                `/diagnosis/students/${encodeURIComponent(studentId)}/prescription`,
            ).then(unwrapPrescriptionOutput),

        /** 流式生成个性化处方（SSE，逐字推送） */
        streamPrescription: (
            studentId: string,
            req: PrescriptionGenerateRequest,
            callbacks: DiagnosisStreamCallbacks,
        ): LessonStreamController => {
            return streamDiagnosisSSE(
                `/diagnosis/students/${encodeURIComponent(studentId)}/prescription`,
                { ...req, stream: true },
                callbacks,
            )
        },
    },

    recitation: {
        /**
         * 获取可朗读的诗列表（可按学生 ID 标注已朗读状态）。
         *
         * 只在已明确进入全局 DEMO 模式时返回内置诗篇。局部请求失败必须交给
         * 调用页面显示“真实诗库不可用”与重试入口，不能把演示诗篇伪装为当前教材。
         */
        listPoems: (studentId?: string): Promise<RecitationPoemsResponse> => {
            if (isDemoMode()) {
                return loadDemo().then((d) => d.getDemoRecitationPoems(studentId))
            }
            return fetchJSON<RecitationPoemsResponse & ApiEnvelope>(
                `/recitation/poems${studentId ? `?studentId=${encodeURIComponent(studentId)}` : ''}`,
            ).then(unwrap<RecitationPoemsResponse>)
        },

        /** 生成标准范读（同诗同 voice 命中缓存，不重复消耗 TTS 配额）
         *  v5.0 Task #137：DEMO 模式下返回静音 WAV 占位音频，保证 RecitationPage 流程完整 */
        generateTts: async (req: RecitationTtsRequest): Promise<RecitationTtsResponse> => {
            if (isDemoMode()) {
                return (await loadDemo()).generateDemoTts(req)
            }
            return fetchJSON<RecitationTtsResponse & ApiEnvelope>('/recitation/tts/generate', {
                method: 'POST',
                body: JSON.stringify(req),
            }).then(unwrap<RecitationTtsResponse>)
        },

        /**
         * 上传朗读音频并转写（multipart/form-data）
         *
         * @param audioBlob 录音 Blob（来自 MediaRecorder）
         * @param poemId 古诗 ID（必填）
         * @param studentId 学生 ID（可选）
         * @param fileName 文件名（默认 recitation.webm）
         *
         * v5.0 Task #137：DEMO 模式下跳过上传，直接返回诗原文作为 transcript
         */
        transcribe: async (
            audioBlob: Blob,
            poemId: string,
            studentId?: string,
            fileName = 'recitation.webm',
        ): Promise<RecitationAsrResponse> => {
            if (isDemoMode()) {
                return (await loadDemo()).transcribeDemoAudio(audioBlob, poemId)
            }
            const form = new FormData()
            form.append('file', audioBlob, fileName)
            form.append('poemId', poemId)
            if (studentId) form.append('studentId', studentId)

            // 录音上传/ASR 可耗时较长，超时必须覆盖上传、响应头和 JSON 正文。
            const timeoutController = new AbortController()
            const timeoutId = window.setTimeout(() => timeoutController.abort(), 60_000)
            try {
                const res = await fetch(`${API_BASE}/recitation/asr/transcribe`, {
                    method: 'POST',
                    body: form,
                    // multipart 不可设置 Content-Type，浏览器自动添加 boundary
                    signal: timeoutController.signal,
                })
                if (!res.ok) {
                    if (import.meta.env.DEV) {
                        const text = await res.text().catch((error) => {
                            if (timeoutController.signal.aborted) throw new Error('朗读转写超时，请稍后重试')
                            if (import.meta.env.DEV) console.debug('[api] recitation.transcribe 错误正文读取失败:', error)
                            return ''
                        })
                        throw new ApiError(res.status, res.statusText, text || undefined)
                    }
                    throw new ApiError(res.status, res.statusText)
                }
                return await res.json() as RecitationAsrResponse
            } catch (err) {
                if (err instanceof ApiError) throw err
                if (timeoutController.signal.aborted) throw new Error('朗读转写超时，请稍后重试')
                if (import.meta.env.DEV) console.debug('[api] recitation.transcribe 失败:', err)
                throw new Error('朗读转写失败，请稍后重试')
            } finally {
                window.clearTimeout(timeoutId)
            }
        },

        /** 评估朗读三维得分（发音/节奏/情感）
         *  v5.0 Task #137：DEMO 模式下返回确定性评分（基于 poemId 哈希） */
        evaluate: async (req: RecitationEvaluateRequest): Promise<RecitationEvaluateResponse> => {
            if (isDemoMode()) {
                return (await loadDemo()).evaluateDemoRecitation(req)
            }
            return fetchJSON<RecitationEvaluateResponse & ApiEnvelope>('/recitation/evaluate', {
                method: 'POST',
                body: JSON.stringify(req),
            }).then(unwrap<RecitationEvaluateResponse>)
        },

        /** 学生朗读历史
         *  v5.0 Task #137：DEMO 模式下返回内置 3 条历史记录 */
        history: async (studentId: string): Promise<RecitationHistoryResponse> => {
            if (isDemoMode()) {
                return (await loadDemo()).getDemoRecitationHistory(studentId)
            }
            return fetchJSON<RecitationHistoryResponse & ApiEnvelope>(
                `/recitation/history/${encodeURIComponent(studentId)}`,
            ).then(unwrap<RecitationHistoryResponse>)
        },

        /** 班级朗读排行榜（学生姓名已脱敏）
         *  v5.0 Task #137：DEMO 模式下返回内置 8 条脱敏排行榜 */
        leaderboard: async (classId: string, limit = 50): Promise<RecitationLeaderboardResponse> => {
            if (isDemoMode()) {
                return (await loadDemo()).getDemoRecitationLeaderboard(classId, limit)
            }
            return fetchJSON<RecitationLeaderboardResponse & ApiEnvelope>(
                `/recitation/leaderboard/${encodeURIComponent(classId)}?limit=${limit}`,
            ).then(unwrap<RecitationLeaderboardResponse>)
        },

        /** 获取指定朗读音频（学生原音 + 范读对比）
         *  v5.0 Task #137：DEMO 模式下返回占位音频对比数据 */
        audio: async (recitationId: string): Promise<RecitationAudioResponse> => {
            if (isDemoMode()) {
                return (await loadDemo()).getDemoRecitationAudio(recitationId)
            }
            return fetchJSON<RecitationAudioResponse & ApiEnvelope>(
                `/recitation/audio/${encodeURIComponent(recitationId)}`,
            ).then(unwrap<RecitationAudioResponse>)
        },

        /** 删除朗读记录（同时清理磁盘音频文件）
         *  v5.0 Task #137：DEMO 模式下直接返回成功响应 */
        delete: async (recitationId: string): Promise<RecitationDeleteResponse> => {
            if (isDemoMode()) {
                return (await loadDemo()).deleteDemoRecitation(recitationId)
            }
            return fetchJSON<RecitationDeleteResponse & ApiEnvelope>(
                `/recitation/${encodeURIComponent(recitationId)}`,
                { method: 'DELETE' },
            ).then(unwrap<RecitationDeleteResponse>)
        },

        /**
         * 构建音频文件的完整可访问 URL
         * 新后端直接返回受保护 API 路径；同时兼容升级前保存的 /audio/...。
         */
        buildAudioUrl: (relativeUrl: string): string => {
            if (!relativeUrl) return ''
            const normalized = relativeUrl.startsWith('/') ? relativeUrl : `/${relativeUrl}`
            if (normalized.startsWith(`${API_BASE}/recitation/audio/`)) return normalized
            if (normalized.startsWith('/audio/')) return `${API_BASE}/recitation${normalized}`
            if (normalized.startsWith('/blob:') || normalized.startsWith('/data:')) return relativeUrl
            return ''
        },
    },

    /* ── Phase 2：诗内容教学（识字/译文/赏析） ── */
    poemContent: {
        /** 获取诗的完整教学内容（原文+拼音+译文+生字+赏析，DEMO 模式返回内置数据） */
        get: async (poemId: string): Promise<PoemContent> => {
            if (isDemoMode()) {
                return (await loadDemo()).getDemoPoemContent(poemId)
            }
            return fetchJSON<PoemContent & ApiEnvelope>(
                `/poem-content/${encodeURIComponent(poemId)}`,
            ).then(unwrap<PoemContent>)
        },
    },

    // ============================================================
    // Phase 3：教师教学流程闭环 —— 教案工坊（LessonPlan）
    // ============================================================
    /* ============================================================
     * 系统设置 —— 模型凭据配置
     * ============================================================ */
    settings: {
        /** 列出三家供应商的配置状态（仅掩码，无明文） */
        listCredentials: (): Promise<ModelCredentialSettings> =>
            fetchJSON<ModelCredentialSettings & ApiEnvelope>(
                '/settings/credentials',
            ).then(unwrap<ModelCredentialSettings>),

        /** 保存某供应商密钥（明文只在此处单向发出，响应仅含掩码） */
        saveCredential: (provider: string, apiKey: string) =>
            fetchJSON<{ provider: string; configured: boolean; masked: string } & ApiEnvelope>(
                `/settings/credentials/${encodeURIComponent(provider)}`,
                { method: 'PUT', body: JSON.stringify({ apiKey }) },
            ).then(unwrap<{ provider: string; configured: boolean; masked: string }>),

        /** 用当前生效的密钥做一次最小连通性检测（由后端发起，密钥不出服务端） */
        testCredential: (provider: string): Promise<CredentialTestResult> =>
            fetchJSON<CredentialTestResult & ApiEnvelope>(
                `/settings/credentials/${encodeURIComponent(provider)}/test`,
                // 必须带上空 JSON 体：fetchJSON 默认发 Content-Type: application/json，
                // 而 Fastify 会按该头去解析请求体，空体直接抛 400 Bad Request。
                { method: 'POST', body: '{}' },
            ).then(unwrap<CredentialTestResult>),
    },

    /* ============================================================
     * 教学场景插画 —— 由 wan2.7-image 生成并落盘缓存
     * ============================================================ */
    illustration: {
        /**
         * 取某个受控场景的配图地址
         *
         * 场景是**服务端固定的枚举**，前端只能传 sceneId、不能传任意 prompt——
         * 否则这就成了一个用服务端密钥对外开放的生图代理。
         *
         * 首次调用会真实生成（实测约 6 秒），之后命中磁盘缓存（约 0.4 秒）。
         * 生成失败时后端返回 `url: null` 而不是 5xx，前端据此不渲染配图层，
         * 卡片退回纯文字形态——一张配图取不到不该让整个区块进错误态。
         */
        scene: (
            sceneId: string,
        ): Promise<{ sceneId: string; url: string | null; cached: boolean; alt: string }> =>
            fetchJSON<{
                sceneId: string
                url: string | null
                cached: boolean
                alt: string
            } & ApiEnvelope>(`/illustration/scene/${encodeURIComponent(sceneId)}`).then(
                unwrap<{ sceneId: string; url: string | null; cached: boolean; alt: string }>,
            ),
    },

    lessonPlan: {
        /**
         * 导出教案
         *
         * 端点：POST /api/lesson-plan/:id/export
         * 后端按格式渲染出完整文本（markdown / html / word 兼容 HTML / csv）并返回，
         * 由前端负责落盘。之前这里没有任何导出接口，页面用一段本地拼接的
         * 纯文本 Blob 冒充导出（源码注释自称「模拟导出」），
         * 导出的文件只有标题和几行教学目标，与真实教案内容不符。
         */
        exportPlan: (
            planId: string,
            format: 'markdown' | 'html' | 'word' | 'csv',
            options?: { includeReflection?: boolean; includeBoard?: boolean; includeHomework?: boolean },
        ): Promise<{
            fileName: string
            mimeType: string
            content: string
            format: string
            success: boolean
        }> =>
            fetchJSON<{
                fileName: string
                mimeType: string
                content: string
                format: string
                success: boolean
            } & ApiEnvelope>(
                `/lesson-plan/${encodeURIComponent(planId)}/export`,
                {
                    method: 'POST',
                    body: JSON.stringify({
                        format,
                        includeReflection: options?.includeReflection ?? true,
                        includeBoard: options?.includeBoard ?? true,
                        includeHomework: options?.includeHomework ?? true,
                    }),
                },
            ).then(unwrap),

        /** 获取教案列表（DEMO 模式返回内置列表） */
        list: async (): Promise<LessonPlanListResponse> => {
            if (isDemoMode()) {
                return (await loadDemo()).getDemoLessonPlanList()
            }
            return fetchJSON<LessonPlanListResponse & ApiEnvelope>(
                '/lesson-plan/list',
            ).then(unwrap<LessonPlanListResponse>)
        },

        /** 获取单个教案详情（DEMO 模式返回内置教案） */
        get: async (lessonPlanId: string, poemId?: string): Promise<LessonPlan> => {
            if (isDemoMode()) {
                // DEMO 模式下优先按 poemId 获取（更精确），fallback 到静夜思
                return (await loadDemo()).getDemoLessonPlan(poemId ?? lessonPlanId)
            }
            return fetchJSON<LessonPlan & ApiEnvelope>(
                `/lesson-plan/${encodeURIComponent(lessonPlanId)}`,
            ).then(unwrap<LessonPlan>)
        },

        /**
         * AI 生成教案（数据驱动备课）
         *
         * 后端会基于班级诊断数据（diagnosis store 的 dark-matter）生成针对性教案：
         * - 识别班级共性薄弱点 → 强化对应 Bloom 层级的教学环节
         * - 识别共性错题 → 在教学过程中加入针对性练习
         * - 生成教学反思建议 → 基于实际学情数据
         *
         * DEMO 模式下返回内置教案（附加 basis 字段说明生成依据）
         */
        generate: async (req: LessonPlanGenerateRequest): Promise<LessonPlanGenerateResponse> => {
            if (isDemoMode()) {
                return (await loadDemo()).generateDemoLessonPlan(req)
            }
            return fetchJSON<LessonPlanGenerateResponse & ApiEnvelope>(
                '/lesson-plan/generate',
                {
                    method: 'POST',
                    body: JSON.stringify(req),
                },
            ).then(unwrap<LessonPlanGenerateResponse>)
        },

        /** 保存教案（DEMO 模式下返回保存成功） */
        save: async (plan: LessonPlan): Promise<LessonPlanSaveResponse> => {
            if (isDemoMode()) {
                return (await loadDemo()).saveDemoLessonPlan(plan)
            }
            return fetchJSON<LessonPlanSaveResponse & ApiEnvelope>(
                '/lesson-plan/save',
                {
                    method: 'POST',
                    body: JSON.stringify(plan),
                },
            ).then(unwrap<LessonPlanSaveResponse>)
        },

        // ─── 智能备课 5 大能力 ───

        /** 能力1：诗歌库智能检索（多维+全文+语义相似） */
        searchPoems: async (query: PoemSearchQuery): Promise<PoemSearchResponse> => {
            const params = new URLSearchParams()
            if (query.keyword) params.set('keyword', query.keyword)
            if (query.dynasty) params.set('dynasty', query.dynasty)
            if (query.poet) params.set('poet', query.poet)
            if (query.genre) params.set('genre', query.genre)
            if (query.subject) params.set('subject', query.subject)
            if (query.imagery) params.set('imagery', query.imagery)
            if (query.gradeLevel) params.set('gradeLevel', query.gradeLevel)
            if (query.difficulty !== undefined) params.set('difficulty', String(query.difficulty))
            if (query.semanticQuery) params.set('semanticQuery', query.semanticQuery)
            if (query.limit !== undefined) params.set('limit', String(query.limit))
            if (query.offset !== undefined) params.set('offset', String(query.offset))
            return fetchJSON<PoemSearchResponse & ApiEnvelope>(
                `/lesson-plan/poems/search?${params.toString()}`,
            ).then(unwrap<PoemSearchResponse>)
        },

        /** 能力1：诗歌详情（含 AI 意象分析/典故/文化背景） */
        getPoemDetail: async (poemId: string): Promise<PoemDetail> => {
            return fetchJSON<PoemDetail & ApiEnvelope>(
                `/lesson-plan/poems/${encodeURIComponent(poemId)}/detail`,
            ).then(unwrap<PoemDetail>)
        },

        /** 能力2：教学目标智能生成（Bloom 六阶） */
        generateObjectives: async (req: ObjectiveGenerateRequest): Promise<ObjectiveGenerateResponse> => {
            return fetchJSON<ObjectiveGenerateResponse & ApiEnvelope>(
                '/lesson-plan/objectives/generate',
                {
                    method: 'POST',
                    body: JSON.stringify(req),
                },
            ).then(unwrap<ObjectiveGenerateResponse>)
        },

        /** 能力3：分层教学设计（基础/提高/挑战层） */
        generateLayeredDesign: async (req: LayeredDesignRequest): Promise<LayeredDesignResponse> => {
            return fetchJSON<LayeredDesignResponse & ApiEnvelope>(
                '/lesson-plan/layered-design/generate',
                {
                    method: 'POST',
                    body: JSON.stringify(req),
                },
            ).then(unwrap<LayeredDesignResponse>)
        },

        /** 能力4：教案 AI 生成（非流式） */
        generateLesson: async (req: LessonGenerateRequest): Promise<LessonGenerateResponse> => {
            return fetchJSON<LessonGenerateResponse & ApiEnvelope>(
                '/lesson-plan/lessons/generate',
                {
                    method: 'POST',
                    body: JSON.stringify({ ...req, stream: false }),
                },
            ).then(unwrap<LessonGenerateResponse>)
        },

        /** 能力4：教案 AI 流式生成（SSE） */
        streamGenerateLesson: (
            req: LessonGenerateRequest,
            callbacks: LessonStreamCallbacks<LessonStreamChunk>,
        ): LessonStreamController => {
            return streamSSE(
                '/lesson-plan/lessons/generate',
                { ...req, stream: true },
                callbacks,
            )
        },

        /** 能力4：教案选段精修（非流式） */
        refineLesson: async (req: LessonRefineRequest): Promise<LessonRefineResponse> => {
            return fetchJSON<LessonRefineResponse & ApiEnvelope>(
                `/lesson-plan/lessons/${encodeURIComponent(req.lessonId)}/refine`,
                {
                    method: 'POST',
                    body: JSON.stringify({ ...req, stream: false }),
                },
            ).then(unwrap<LessonRefineResponse>)
        },

        /** 能力4：教案选段精修（SSE 流式） */
        streamRefineLesson: (
            req: LessonRefineRequest,
            callbacks: LessonStreamCallbacks<RefineStreamChunk>,
        ): LessonStreamController => {
            return streamSSE(
                `/lesson-plan/lessons/${encodeURIComponent(req.lessonId)}/refine`,
                { ...req, stream: true },
                callbacks,
            )
        },

        /** 能力5：资源调度（按相关度排序推荐资源） */
        getResources: async (lessonId: string, poemId: string): Promise<LessonResourcesResponse> => {
            const params = new URLSearchParams({ poemId })
            return fetchJSON<LessonResourcesResponse & ApiEnvelope>(
                `/lesson-plan/lessons/${encodeURIComponent(lessonId)}/resources?${params.toString()}`,
            ).then(unwrap<LessonResourcesResponse>)
        },

        // ─── SubTask 25.5：教案模板真实化 ───

        /**
         * 获取教案模板列表（DEMO 模式下返回内置 12 个标准模板）
         *
         * 后端契约：GET /api/lesson-plans/templates
         * Query 参数：keyword / grade / type / difficulty / sort
         */
        templates: async (
            filter?: LessonPlanTemplateFilter,
            sort: LessonPlanTemplateSort = 'newest',
        ): Promise<LessonPlanTemplateListResponse> => {
            if (isDemoMode()) {
                return loadDemo().then((d) => d.getDemoLessonPlanTemplates(filter, sort))
            }
            const params = new URLSearchParams()
            if (filter?.keyword) params.set('keyword', filter.keyword)
            if (filter?.grade) params.set('grade', filter.grade)
            if (filter?.type) params.set('type', filter.type)
            if (filter?.difficulty) params.set('difficulty', filter.difficulty)
            params.set('sort', sort)
            return fetchJSON<LessonPlanTemplateListResponse & ApiEnvelope>(
                `/lesson-plans/templates?${params.toString()}`,
            ).then(unwrap<LessonPlanTemplateListResponse>)
        },

        /**
         * 获取单个教案模板详情（DEMO 模式下按 ID 查询内置模板）
         *
         * 后端契约：GET /api/lesson-plans/templates/:id
         */
        getTemplate: async (templateId: string): Promise<LessonPlanTemplate> => {
            if (isDemoMode()) {
                const t = (await loadDemo()).getDemoLessonPlanTemplate(templateId)
                if (!t) throw new Error(`教案模板不存在: ${templateId}`)
                return t
            }
            return fetchJSON<LessonPlanTemplate & ApiEnvelope>(
                `/lesson-plans/templates/${encodeURIComponent(templateId)}`,
            ).then(unwrap<LessonPlanTemplate>)
        },

        // ─── SubTask 25.6：AI 流式生成教案（deepseek-v4-pro + SSE） ───

        /**
         * AI 流式生成教案（基于 deepseek-v4-pro）
         *
         * 后端契约：POST /api/lesson-plans/generate（SSE 流式）
         * - 请求体：LessonPlanAIGenerateRequest
         * - 响应：text/event-stream，每帧为 LessonAIGenerateStreamChunk
         *   - 真实模式不传输供应商原始 reasoning；演示模式可使用公开进度文案
         *   - { type: 'chunk', content }     → 教案内容增量
         *   - { type: 'done', lessonPlan }   → 生成完成，返回完整教案对象
         *   - { type: 'aborted' }            → 中止
         *
         * DEMO 模式下调用 streamDemoAIGenerateLessonPlan 模拟流式输出
         *
         * @param req AI 生成请求
         * @param callbacks 流式回调（onChunk / onError）
         * @returns 流式控制器（abort + streaming 状态）
         */
        streamAIGenerateLessonPlan: (
            req: LessonPlanAIGenerateRequest,
            callbacks: LessonAIGenerateStreamCallbacks,
        ): LessonAIGenerateStreamController => {
            // DEMO 模式：使用本地模拟流式输出
            //
            // 这里不能 await：调用方要求**同步**拿到控制器以便随时 abort。
            // 因此先返回一个壳控制器，等 demo 模块异步到位后再真正启动流；
            // 若用户在装载期间就点了中止，aborted 标记会让流不再启动。
            if (isDemoMode()) {
                let inner: LessonAIGenerateStreamController | null = null
                let aborted = false
                void loadDemo().then((d) => {
                    if (aborted) return
                    inner = d.streamDemoAIGenerateLessonPlan(req, {
                        onChunk: (chunk) => callbacks.onChunk?.(chunk),
                        onError: (err) => callbacks.onError?.(err),
                    })
                })
                return {
                    abort: () => {
                        aborted = true
                        inner?.abort()
                    },
                    get streaming() {
                        // 模块装载期间视为「已在流式中」，避免 UI 误判为已结束
                        return aborted ? false : (inner?.streaming ?? true)
                    },
                }
            }

            // 真实模式：复用 streamSSE 走 fetch + ReadableStream
            const sseController = streamSSE<LessonAIGenerateStreamChunk>(
                '/lesson-plans/generate',
                { ...req, stream: true },
                {
                    onChunk: (chunk) => callbacks.onChunk?.(chunk),
                    onError: (err) => callbacks.onError?.(err),
                },
            )

            // 适配 LessonAIGenerateStreamController 接口（与 LessonStreamController 同构）
            return {
                abort: () => sseController.abort(),
                get streaming() {
                    return sseController.streaming
                },
            }
        },
    },

    // ============================================================
    // Phase 4.1：学生错题本 + 间隔重复（SM-2 算法）
    // ============================================================
    errorNotebook: {
        /** 获取错题本列表（DEMO 模式返回内置错题列表） */
        list: async (): Promise<ErrorNotebookListResponse> => {
            if (isDemoMode()) {
                return (await loadDemo()).getDemoErrorNotebookList()
            }
            return fetchJSON<ErrorNotebookListResponse & ApiEnvelope>(
                '/error-notebook/list',
            ).then(unwrap<ErrorNotebookListResponse>)
        },

        /** 获取单个错题详情 */
        get: async (itemId: string): Promise<ErrorNotebookItem> => {
            if (isDemoMode()) {
                const item = (await loadDemo()).getDemoErrorNotebookItem(itemId)
                if (!item) throw new Error(`错题条目不存在: ${itemId}`)
                return item
            }
            return fetchJSON<ErrorNotebookItem & ApiEnvelope>(
                `/error-notebook/${encodeURIComponent(itemId)}`,
            ).then(unwrap<ErrorNotebookItem>)
        },

        /** 提交复习评分（DEMO 模式下执行 SM-2 算法） */
        review: async (req: ReviewSubmitRequest): Promise<ReviewSubmitResponse> => {
            if (isDemoMode()) {
                return (await loadDemo()).submitDemoReview(req)
            }
            return fetchJSON<ReviewSubmitResponse & ApiEnvelope>(
                '/error-notebook/review',
                {
                    method: 'POST',
                    body: JSON.stringify(req),
                },
            ).then(unwrap<ReviewSubmitResponse>)
        },

        /** 获取复习统计 */
        stats: async (): Promise<ReviewStatsResponse> => {
            if (isDemoMode()) {
                return (await loadDemo()).getDemoReviewStats()
            }
            return fetchJSON<ReviewStatsResponse & ApiEnvelope>(
                '/error-notebook/stats',
            ).then(unwrap<ReviewStatsResponse>)
        },
    },

    creation: {
        /** 获取创造级任务列表（支持 teacherId / classId / type 筛选） */
        tasks: (params: { teacherId?: string; classId?: string; type?: CreationTaskType } = {}) => {
            const qs = new URLSearchParams()
            if (params.teacherId) qs.set('teacherId', params.teacherId)
            if (params.classId) qs.set('classId', params.classId)
            if (params.type) qs.set('type', params.type)
            const query = qs.toString()
            return fetchJSON<CreationTasksResponse & ApiEnvelope>(
                `/creation/tasks${query ? `?${query}` : ''}`,
            ).then(unwrap<CreationTasksResponse>)
        },

        /** 教师创建创造级任务 */
        createTask: (req: CreationTaskCreateRequest) =>
            fetchJSON<CreationTaskCreateResponse & ApiEnvelope>('/creation/tasks/create', {
                method: 'POST',
                body: JSON.stringify(req),
            }).then(unwrap<CreationTaskCreateResponse>),

        /** 启动 AI 协作共创（brush.creative 生成初稿） */
        collaborateStart: (req: CollaborateStartRequest) =>
            fetchJSON<CollaborationResponse & ApiEnvelope>('/creation/collaborate/start', {
                method: 'POST',
                body: JSON.stringify(req),
            }).then(unwrap<CollaborationResponse>),

        /** AI 协作迭代（教师/学生输入修改意见 → brush.creative 携带反馈再生成） */
        collaborateIterate: (req: CollaborateIterateRequest) =>
            fetchJSON<CollaborationResponse & ApiEnvelope>('/creation/collaborate/iterate', {
                method: 'POST',
                body: JSON.stringify(req),
            }).then(unwrap<CollaborationResponse>),

        /** 诗眼 Agent 生成配图描述（供学生临摹参考） */
        visionDescribe: (req: VisionDescribeRequest) =>
            fetchJSON<VisionDescribeResponse & ApiEnvelope>('/creation/vision-describe', {
                method: 'POST',
                body: JSON.stringify(req),
            }).then(unwrap<VisionDescribeResponse>),

        /** 诗笔 Agent 辅助改写（保留原意 + 创新表达） */
        rewrite: (req: RewriteRequest) =>
            fetchJSON<RewriteResponse & ApiEnvelope>('/creation/rewrite', {
                method: 'POST',
                body: JSON.stringify(req),
            }).then(unwrap<RewriteResponse>),

        /** 获取学生作品列表（支持班级/诗/类型/学生筛选） */
        works: (params: {
            classId?: string
            poemId?: string
            type?: CreationTaskType
            studentId?: string
            limit?: number
            offset?: number
        } = {}) => {
            const qs = new URLSearchParams()
            if (params.classId) qs.set('classId', params.classId)
            if (params.poemId) qs.set('poemId', params.poemId)
            if (params.type) qs.set('type', params.type)
            if (params.studentId) qs.set('studentId', params.studentId)
            if (params.limit !== undefined) qs.set('limit', String(params.limit))
            if (params.offset !== undefined) qs.set('offset', String(params.offset))
            const query = qs.toString()
            return fetchJSON<CreationWorksResponse & ApiEnvelope>(
                `/creation/works${query ? `?${query}` : ''}`,
            ).then(unwrap<CreationWorksResponse>)
        },

        /** 学生提交作品（自动脱敏） */
        submitWork: (req: WorkSubmitRequest) =>
            fetchJSON<WorkSubmitResponse & ApiEnvelope>('/creation/works/submit', {
                method: 'POST',
                body: JSON.stringify(req),
            }).then(unwrap<WorkSubmitResponse>),

        /** 点赞作品 */
        likeWork: (workId: string) =>
            fetchJSON<WorkLikeResponse & ApiEnvelope>(
                `/creation/works/${encodeURIComponent(workId)}/like`,
                { method: 'POST' },
            ).then(unwrap<WorkLikeResponse>),

        /** AI 多维批改学生创造作品 */
        gradeWork: (workId: string, req: CreationGradeRequest = {}) =>
            fetchJSON<CreationGradeResponse & ApiEnvelope>(
                `/creation/works/${encodeURIComponent(workId)}/grade`,
                { method: 'POST', body: JSON.stringify(req) },
            ).then(unwrap<CreationGradeResponse>),

        /** 将结构化批改反馈送回 brush.creative 完成再创作 */
        recreateWork: (workId: string, req: CreationRecreateRequest) =>
            fetchJSON<CreationRecreateResponse & ApiEnvelope>(
                `/creation/works/${encodeURIComponent(workId)}/recreate`,
                { method: 'POST', body: JSON.stringify(req) },
            ).then(unwrap<CreationRecreateResponse>),

        /** 作品展示墙（按点赞数排序，分页） */
        wall: (params: {
            classId?: string
            poemId?: string
            type?: CreationTaskType
            page?: number
            pageSize?: number
        } = {}) => {
            const qs = new URLSearchParams()
            if (params.classId) qs.set('classId', params.classId)
            if (params.poemId) qs.set('poemId', params.poemId)
            if (params.type) qs.set('type', params.type)
            if (params.page !== undefined) qs.set('page', String(params.page))
            if (params.pageSize !== undefined) qs.set('pageSize', String(params.pageSize))
            const query = qs.toString()
            return fetchJSON<WorksWallResponse & ApiEnvelope>(
                `/creation/works/wall${query ? `?${query}` : ''}`,
            ).then(unwrap<WorksWallResponse>)
        },
    },

    culture: {
        /** 获取诗的文化背景包（brush.creative 生成，缓存） */
        background: (poemId: string): Promise<CultureBackgroundResponse> => {
            if (isDemoMode()) {
                return loadDemo().then((d) => d.getDemoCultureBackground(poemId))
            }
            return fetchJSON<CultureBackgroundResponse & ApiEnvelope>(
                `/culture/poems/${encodeURIComponent(poemId)}/background`,
            ).then(unwrap<CultureBackgroundResponse>)
        },

        /** 获取文化文物图片库（eye.vision-annotate + 文生图 API） */
        images: (poemId: string): Promise<CultureImagesResponse> => {
            if (isDemoMode()) {
                return loadDemo().then((d) => d.getDemoCultureImages(poemId))
            }
            return fetchJSON<CultureImagesResponse & ApiEnvelope>(
                `/culture/poems/${encodeURIComponent(poemId)}/images`,
            ).then(unwrap<CultureImagesResponse>)
        },

        /** 获取单张图片详情 */
        image: (imageId: string): Promise<CultureImageDetailResponse> => {
            if (isDemoMode()) {
                return loadDemo().then((d) => d.getDemoCultureImageDetail(imageId))
            }
            return fetchJSON<CultureImageDetailResponse & ApiEnvelope>(
                `/culture/images/${encodeURIComponent(imageId)}`,
            ).then(unwrap<CultureImageDetailResponse>)
        },

        /** 获取意象文化内涵解读（seed-data 聚合 + brush.creative 深度解读） */
        imagery: (imageName: string): Promise<CultureImageryResponse> => {
            if (isDemoMode()) {
                return loadDemo().then((d) => d.getDemoCultureImagery(imageName))
            }
            return fetchJSON<CultureImageryResponse & ApiEnvelope>(
                `/culture/imagery/${encodeURIComponent(imageName)}`,
            ).then(unwrap<CultureImageryResponse>)
        },

        /** 显式请求 AI 刷新已收录意象；失败时调用方保留本地目录解读 */
        refreshImagery: (imageName: string): Promise<CultureImageryResponse> =>
            fetchJSON<CultureImageryResponse & ApiEnvelope>(
                `/culture/imagery/${encodeURIComponent(imageName)}/refresh`,
                { method: 'POST', body: '{}' },
            ).then(unwrap<CultureImageryResponse>),

        /** 启动沉浸式投屏 */
        immersiveStart: (req: StartImmersiveBody): Promise<ImmersiveStartResponse> => {
            if (isDemoMode()) {
                return loadDemo().then((d) => d.startDemoImmersive(req))
            }
            return fetchJSON<ImmersiveStartResponse & ApiEnvelope>('/culture/immersive/start', {
                method: 'POST',
                body: JSON.stringify(req),
            }).then(unwrap<ImmersiveStartResponse>)
        },

        /** 获取投屏状态 */
        immersiveStatus: (poemId: string, signal?: AbortSignal): Promise<ImmersiveStatusResponse> => {
            if (isDemoMode()) {
                return loadDemo().then((d) => d.getDemoImmersiveStatus(poemId))
            }
            return fetchJSON<ImmersiveStatusResponse & ApiEnvelope>(
                `/culture/immersive/${encodeURIComponent(poemId)}/status`,
                { signal },
            ).then(unwrap<ImmersiveStatusResponse>)
        },

        /** 停止投屏（不传 poemId 则停止所有投屏） */
        immersiveStop: (poemId?: string): Promise<ImmersiveStopResponse> => {
            if (isDemoMode()) {
                return loadDemo().then((d) => d.stopDemoImmersive(poemId))
            }
            return fetchJSON<ImmersiveStopResponse & ApiEnvelope>('/culture/immersive/stop', {
                method: 'POST',
                body: JSON.stringify(poemId ? { poemId } : {}),
            }).then(unwrap<ImmersiveStopResponse>)
        },
    },

    // ── 进化之眼基因谱（Evolution Eye）──
    evolution: {
        /** 版本谱系 3D 可视化数据（节点+边+agentIds） */
        getGenealogy: (): Promise<GenealogyData> => {
            if (isDemoMode()) {
                return Promise.resolve({ nodes: [], edges: [], agentIds: [] })
            }
            return fetchJSON<GenealogyData & { aiGenerated: false }>('/evolution/genealogy')
                .then(({ aiGenerated: _ai, ...data }) => {
                    void _ai
                    return data
                })
        },

        /** 进化模式列表（PatternPanel 数据源） */
        getPatterns: (limit?: number): Promise<PatternItem[]> => {
            if (isDemoMode()) {
                return Promise.resolve([])
            }
            const query = limit ? `?limit=${limit}` : ''
            return fetchJSON<{ patterns: PatternItem[]; aiGenerated: false }>(`/evolution/patterns${query}`)
                .then((res) => res.patterns)
        },

        /** A/B 测试结果（ABTestChart 数据源） */
        getABTests: (): Promise<ABTestResultData> => {
            if (isDemoMode()) {
                return Promise.resolve({ active: [], history: [], threshold: 0.05, minSamples: 8 })
            }
            return fetchJSON<ABTestResultData & { aiGenerated: false }>('/evolution/ab-tests')
                .then(({ aiGenerated: _ai, ...data }) => {
                    void _ai
                    return data
                })
        },

        /**
         * 进化预测（流式 SSE）—— SubTask 26.4
         *
         * POST /evolution/predict 走 SSE 流式输出，回调：
         *  - onToken：思考过程 token（deepseek-v4-pro thinking_mode=high）
         *  - onPredictions：严格终态校验通过后的预测方向数组
         *  - onDone：仅在收到合法 done(result) 后紧跟 [DONE] 时触发
         *  - onError：错误
         *
         * 后端 endpoint 不可用时（dist 未编译 /predict），onError 会接到 HTTP 404/500 错误。
         * 调用方应在 UI 中显示降级提示，不阻塞页面其他功能。
         */
        streamPredict: (
            request: EvolutionPredictRequest,
            callbacks: {
                onToken?: (token: string) => void
                onPredictions?: (predictions: EvolutionPredictionDirection[]) => void
                onDone?: (result: EvolutionPredictionResult) => void
                onError?: (err: Error) => void
            },
        ): LessonStreamController => {
            const controller = new AbortController()
            let streaming = true

            void (async () => {
                try {
                    if (isDemoMode()) {
                        throw new Error('演示模式：进化预测不可用')
                    }
                    const res = await fetchStreamResponse(`${API_BASE}/evolution/predict`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            Accept: 'text/event-stream',
                        },
                        body: JSON.stringify(request),
                        signal: controller.signal,
                    }, controller)

                    if (!res.ok) {
                        let errMsg = `进化预测请求失败（HTTP ${res.status}）`
                        try {
                            const ct = res.headers.get('content-type') ?? ''
                            if (ct.includes('application/json')) {
                                const errJson = (await res.json()) as { message?: string; error?: string }
                                if (typeof errJson.message === 'string' && errJson.message.length <= 500) {
                                    errMsg = errJson.message
                                }
                            }
                        } catch {
                            // 响应体解析失败
                        }
                        throw new Error(errMsg)
                    }

                    if (!res.body) {
                        throw new Error('响应体为空，无法消费 SSE 流')
                    }

                    const finalResult = await consumeEvolutionPredictionStream(res.body, {
                        signal: controller.signal,
                        readChunk: (reader) => readStreamChunk(reader, controller),
                        onToken: callbacks.onToken,
                    })
                    streaming = false
                    callbacks.onPredictions?.(finalResult.predictions)
                    callbacks.onDone?.(finalResult)
                } catch (err) {
                    streaming = false
                    if (controller.signal.aborted) {
                        if (controller.signal.reason === STREAM_IDLE_TIMEOUT_REASON) {
                            callbacks.onError?.(new Error('流式响应超时，请稍后重试'))
                        }
                        return
                    }
                    if (err instanceof DOMException && err.name === 'AbortError') return
                    const finalErr = err instanceof Error ? err : new Error(String(err))
                    callbacks.onError?.(finalErr)
                }
            })()

            return {
                abort: () => {
                    if (streaming) {
                        streaming = false
                        controller.abort()
                    }
                },
                get streaming() {
                    return streaming
                },
            }
        },

        /**
         * 进化预测（非流式 fallback）—— SubTask 26.4
         *
         * GET /evolution/predict 使用服务端已持久化的进化记忆做统计预测，
         * 不再错把 SSE POST 响应当作 JSON 解析。这条路径不消费请求中的
         * historicalPatterns/currentVersions，因此属于“服务端历史统计”降级，不会冒充流式 AI 结果。
         */
        getPredict: (request: EvolutionPredictRequest): Promise<EvolutionPredictionResult> => {
            if (isDemoMode()) {
                return Promise.reject(new Error('演示模式：进化预测不可用'))
            }
            const params = new URLSearchParams()
            if (request.horizon !== undefined) params.set('horizon', String(request.horizon))
            const query = params.toString()
            return fetchJSON<{
                predictedNextEvolution: string
                confidence: number
                aiGenerated: boolean
            }>(`/evolution/predict${query ? `?${query}` : ''}`).then((res) => ({
                predictions: res.predictedNextEvolution
                    ? [{
                        direction: '服务端历史统计预测',
                        suggestion: res.predictedNextEvolution,
                        expectedImprovement: 0,
                        confidence: res.confidence,
                    }]
                    : [],
                confidence: res.confidence,
                aiGenerated: res.aiGenerated,
                generatedAt: Date.now(),
            }))
        },
    },

    // ── 思考宫殿 3D 链（Thinking Palace）──
    thinkingChains: {
        /** 思考链列表（最近优先，可按 agentId/sessionId 过滤） */
        list: (params?: { limit?: number; agentId?: string; sessionId?: string }): Promise<ThinkingChainsResponse> => {
            if (isDemoMode()) {
                return Promise.resolve({ chains: [], total: 0 })
            }
            const searchParams = new URLSearchParams()
            if (params?.limit) searchParams.set('limit', String(params.limit))
            if (params?.agentId) searchParams.set('agentId', params.agentId)
            if (params?.sessionId) searchParams.set('sessionId', params.sessionId)
            const query = searchParams.toString() ? `?${searchParams.toString()}` : ''
            return fetchJSON<ThinkingChainsResponse & ApiEnvelope & { aiGenerated: false }>(`/copilot/thinking-chains${query}`)
                .then((res) => {
                    const { status: _s, aiGenerated: _a, ...rest } = res
                    void _s
                    void _a
                    return rest as ThinkingChainsResponse
                })
        },

        /** 思考链详情（含完整 reasoning + nodes 数组） */
        getById: (id: string): Promise<ThinkingChainDetailResponse> => {
            if (isDemoMode()) {
                return Promise.reject(new Error('演示模式：思考链详情不可用'))
            }
            return fetchJSON<ThinkingChainDetailResponse & ApiEnvelope & { aiGenerated: false }>(
                `/copilot/thinking-chains/${encodeURIComponent(id)}`,
            ).then((res) => {
                const { status: _s, aiGenerated: _a, ...rest } = res
                void _s
                void _a
                return rest as ThinkingChainDetailResponse
            })
        },
    },

    /* ============================================================
     * 画像报告模块 API（能力 1-5）
     * ============================================================ */

    /** 能力 1：学生立体画像 */
    profile3d: {
        /** 获取学生立体画像 */
        get: (studentId: string): Promise<StudentProfile3DResponse> => {
            return fetchJSON<StudentProfile3DResponse & ApiEnvelope>(
                `/diagnosis/students/${encodeURIComponent(studentId)}/profile-3d`,
            ).then(unwrap)
        },

        /** 强制刷新立体画像 */
        refresh: (studentId: string): Promise<StudentProfile3DResponse> => {
            return fetchJSON<StudentProfile3DResponse & ApiEnvelope>(
                `/diagnosis/students/${encodeURIComponent(studentId)}/profile-3d/refresh`,
                { method: 'POST' },
            ).then(unwrap)
        },
    },

    /** 能力 2：班级热点画像 */
    classHotspot: {
        /** 获取班级热点画像 */
        get: (classId: string): Promise<ClassHotspotResponse> => {
            return fetchJSON<ClassHotspotResponse & ApiEnvelope>(
                `/dashboard/class/${encodeURIComponent(classId)}/hotspot`,
            ).then(unwrap)
        },

        /** 强制刷新热点 */
        refresh: (classId: string): Promise<ClassHotspotResponse> => {
            return fetchJSON<ClassHotspotResponse & ApiEnvelope>(
                `/dashboard/class/${encodeURIComponent(classId)}/hotspot/refresh`,
                { method: 'POST' },
            ).then(unwrap)
        },
    },

    /** 能力 3：趋势预警 */
    trendAlerts: {
        /** 查询趋势预警 */
        query: (params: {
            classId: string
            severity?: TrendAlertSeverity
            rule?: TrendAlertRule
            resolved?: boolean
            limit?: number
        }): Promise<TrendAlertsResponse> => {
            const searchParams = new URLSearchParams()
            searchParams.set('classId', params.classId)
            if (params.severity) searchParams.set('severity', params.severity)
            if (params.rule) searchParams.set('rule', params.rule)
            if (params.resolved !== undefined) searchParams.set('resolved', String(params.resolved))
            if (params.limit) searchParams.set('limit', String(params.limit))
            return fetchJSON<TrendAlertsResponse & ApiEnvelope>(
                `/dashboard/alerts/trend?${searchParams.toString()}`,
            ).then(unwrap)
        },

        /** 标记单个预警已解决 */
        resolve: (alertId: string): Promise<{ status: string; alertId: string; resolved: boolean }> => {
            return fetchJSON<{ status: string; alertId: string; resolved: boolean } & ApiEnvelope>(
                `/dashboard/alerts/${encodeURIComponent(alertId)}/resolve`,
                { method: 'POST' },
            ).then(unwrap)
        },

        /** 批量解决预警 */
        batchResolve: (alertIds: string[]): Promise<{ status: string; resolvedCount: number }> => {
            return fetchJSON<{ status: string; resolvedCount: number } & ApiEnvelope>(
                `/dashboard/alerts/batch-resolve`,
                { method: 'POST', body: JSON.stringify({ alertIds }) },
            ).then(unwrap)
        },
    },

    /** 能力 4：多格式导出 */
    profileExport: {
        /** 导出报告为指定格式 */
        export: (request: ProfileExportRequest): Promise<ProfileExportResponse> => {
            return fetchJSON<ProfileExportResponse & ApiEnvelope>(
                `/report/export/${encodeURIComponent(request.reportId)}`,
                {
                    method: 'POST',
                    body: JSON.stringify({
                        format: request.format,
                        includeSections: request.includeSections,
                        includeCharts: request.includeCharts,
                        includeVerification: request.includeVerification,
                    }),
                },
            ).then(unwrap)
        },
    },

    /** 能力 4：分享链接 */
    share: {
        /** 在不创建链接的前提下生成服务端脱敏预览与确认指纹。 */
        preview: (request: PreviewShareRequest): Promise<PreviewShareResponse> => {
            return fetchJSON<PreviewShareResponse & ApiEnvelope>(
                `/report/share/preview`,
                {
                    method: 'POST',
                    body: JSON.stringify(request),
                },
            ).then(parsePreviewShareResponse)
        },

        /** 创建分享链接 */
        create: (request: CreateShareRequest): Promise<CreateShareResponse> => {
            return fetchJSON<CreateShareResponse & ApiEnvelope>(
                `/report/share`,
                {
                    method: 'POST',
                    body: JSON.stringify(request),
                },
            ).then(parseCreateShareResponse)
        },

        /** 通过 token 匿名获取分享报告；专用边界保证 token 不进日志或 Cookie。 */
        get: (token: string, signal?: AbortSignal): Promise<GetSharedReportResponse> => (
            fetchPublicSharedReport(token, signal)
        ),

        /** 查询教师创建的所有分享链接 */
        list: (): Promise<ListSharedReportsResponse> => {
            return fetchJSON<ListSharedReportsResponse & ApiEnvelope>(
                `/report/shared`,
            ).then(parseListSharedReportsResponse)
        },

        /** 撤销分享链接 */
        revoke: (shareId: string): Promise<{ status: string; revoked: boolean }> => {
            return fetchJSON<{ status: string; revoked: boolean } & ApiEnvelope>(
                `/report/shared/${encodeURIComponent(shareId)}`,
                { method: 'DELETE' },
            ).then(unwrap)
        },
    },

    /**
     * 课堂闯关 —— 关卡 / 诗力值 / 三榜
     *
     * 独立于 classroom.status：HUD 的刷新频率远高于整体课堂状态，
     * 拉这个轻量端点比反复拉整份 status 便宜得多。
     */
    quest: {
        /** 取当前闯关快照 */
        get: (lessonId: string): Promise<{ quest: QuestSnapshot }> =>
            fetchJSON<{ quest: QuestSnapshot } & ApiEnvelope>(
                `/classroom/${encodeURIComponent(lessonId)}/quest`,
            ).then(unwrap<{ quest: QuestSnapshot }>),

        /** 设置小组（课中重新分组不会清零已有积分） */
        setTeams: (
            lessonId: string,
            teams: Array<{ id?: string; name: string; members: string[] }>,
        ): Promise<{ quest: QuestSnapshot }> =>
            fetchJSON<{ quest: QuestSnapshot } & ApiEnvelope>(
                `/classroom/${encodeURIComponent(lessonId)}/quest/teams`,
                { method: 'POST', body: JSON.stringify({ teams }) },
            ).then(unwrap<{ quest: QuestSnapshot }>),

        /**
         * AI 虚拟对手出手一轮
         *
         * accuracy 刻意由调用方按关卡难度给：一个全对的对手只会让学生放弃，
         * 它的价值在于当一个「够得着的目标」。
         */
        aiTurn: (
            lessonId: string,
            params: { accuracy?: number; power?: number } = {},
        ): Promise<{ correct: boolean; gained: number; aiOpponentScore: number; quest: QuestSnapshot }> =>
            fetchJSON<{
                correct: boolean; gained: number; aiOpponentScore: number; quest: QuestSnapshot
            } & ApiEnvelope>(
                `/classroom/${encodeURIComponent(lessonId)}/quest/ai-turn`,
                { method: 'POST', body: JSON.stringify(params) },
            ).then(unwrap),
    },

    /** 能力 5：家校沟通活页 */
    homeSchool: {
        /** 生成（或获取缓存的）家校周报 */
        createWeekly: (request: WeeklyReportCreateRequest): Promise<WeeklyReportCreateResponse> => {
            return fetchJSON<WeeklyReportCreateResponse & ApiEnvelope>(
                `/report/home-school/weekly`,
                {
                    method: 'POST',
                    body: JSON.stringify(request),
                },
            ).then(unwrap)
        },

        /** 获取学生最新家校周报 */
        getLatest: (studentId: string): Promise<WeeklyReportGetResponse> => {
            return fetchJSON<WeeklyReportGetResponse & ApiEnvelope>(
                `/report/home-school/${encodeURIComponent(studentId)}/latest`,
            ).then(unwrap)
        },

        /** 提交家长反馈 */
        submitFeedback: (
            reportId: string,
            request: SubmitFeedbackRequest,
        ): Promise<WeeklyReportGetResponse> => {
            return fetchJSON<WeeklyReportGetResponse & ApiEnvelope>(
                `/report/home-school/${encodeURIComponent(reportId)}/feedback`,
                {
                    method: 'POST',
                    body: JSON.stringify(request),
                },
            ).then(unwrap)
        },

        /** 教师添加批注 */
        addNote: (
            reportId: string,
            request: AddTeacherNoteRequest,
        ): Promise<WeeklyReportGetResponse> => {
            return fetchJSON<WeeklyReportGetResponse & ApiEnvelope>(
                `/report/home-school/${encodeURIComponent(reportId)}/note`,
                {
                    method: 'POST',
                    body: JSON.stringify(request),
                },
            ).then(unwrap)
        },

        /**
         * 班级花名册（含每人最新周报状态）
         *
         * 一次请求拿到全班状态，避免为 40 名学生各打一次 `/latest`；
         * 也只有这样才能区分「尚未生成」与「请求失败」。
         */
        classRoster: (classId: string): Promise<HomeSchoolRosterResponse> =>
            fetchJSON<HomeSchoolRosterResponse & ApiEnvelope>(
                `/report/home-school/class/${encodeURIComponent(classId)}`,
            ).then(unwrap<HomeSchoolRosterResponse>),

        /** 发布周报（draft → published），发布后家长侧可见 */
        publish: (reportId: string): Promise<WeeklyReportGetResponse> =>
            fetchJSON<WeeklyReportGetResponse & ApiEnvelope>(
                `/report/home-school/${encodeURIComponent(reportId)}/publish`,
                { method: 'POST', body: '{}' },
            ).then(unwrap),

        /** 把该周报下的家长反馈全部标记为已读 */
        markFeedbackRead: (reportId: string): Promise<WeeklyReportGetResponse> =>
            fetchJSON<WeeklyReportGetResponse & ApiEnvelope>(
                `/report/home-school/${encodeURIComponent(reportId)}/feedback/read`,
                { method: 'POST', body: '{}' },
            ).then(unwrap),

        /** 勾选一项亲子活动为已完成 */
        completeActivity: (
            reportId: string,
            activityId: string,
        ): Promise<WeeklyReportGetResponse> =>
            fetchJSON<WeeklyReportGetResponse & ApiEnvelope>(
                `/report/home-school/${encodeURIComponent(reportId)}/activity/` +
                `${encodeURIComponent(activityId)}/complete`,
                { method: 'POST', body: '{}' },
            ).then(unwrap),
    },

    /* ============================================================
     * v5.0 Dashboard 数据真实化（Task：Dashboard 面板数据真实化）
     *
     * 6 个独立端点，TanStack Query 直接消费，staleTime: 30s
     * 响应包裹在 ApiEnvelope { code, message, data, status } 中，
     * 通过 unwrap 提取 data 字段。
     * 可选 classId 用于数据联动（班级切换时所有面板同步刷新）
     * ============================================================ */
    dashboardV2: {
        /** 顶部统计卡片 —— 全局聚合数据 */
        stats: (classId?: string): Promise<DashboardStatsV2> => {
            const qs = classId ? `?classId=${encodeURIComponent(classId)}` : ''
            return fetchJSON<DashboardStatsV2 & ApiEnvelope>(
                `/dashboard/stats${qs}`,
            ).then(unwrap)
        },

        /** 告警列表 —— 学情异常 / 落后知识点 / 系统告警 */
        alerts: (classId?: string): Promise<DashboardAlertV2[]> => {
            const qs = classId ? `?classId=${encodeURIComponent(classId)}` : ''
            return fetchJSON<DashboardAlertsResponse & ApiEnvelope>(
                `/dashboard/alerts${qs}`,
            )
                .then(unwrap<DashboardAlertsResponse>)
                .then((res) => res.alerts ?? [])
        },

        /** 六阶能力雷达 —— 6 维度 + 对比基线 */
        bloomRadar: (classId?: string): Promise<BloomRadarDataV2> => {
            const qs = classId ? `?classId=${encodeURIComponent(classId)}` : ''
            return fetchJSON<BloomRadarDataV2 & ApiEnvelope>(
                `/dashboard/bloom-radar${qs}`,
            ).then(unwrap)
        },

        /** 班级热点 —— 活跃度排行 + 薄弱知识点排行 */
        classHotspot: (classId?: string): Promise<ClassHotspotDataV2> => {
            const qs = classId ? `?classId=${encodeURIComponent(classId)}` : ''
            return fetchJSON<ClassHotspotDataV2 & ApiEnvelope>(
                `/dashboard/class-hotspot${qs}`,
            ).then(unwrap)
        },

        /** 创新指标 —— AI 使用率 / 教案生成 / 智能批改 / 进化之眼 */
        innovation: (classId?: string): Promise<InnovationData> => {
            const qs = classId ? `?classId=${encodeURIComponent(classId)}` : ''
            return fetchJSON<InnovationData & ApiEnvelope>(
                `/dashboard/innovation${qs}`,
            ).then(unwrap)
        },

        /** 周学习进度 —— 学生 × 天矩阵 */
        weeklyProgress: (classId?: string): Promise<WeeklyProgressData> => {
            const qs = classId ? `?classId=${encodeURIComponent(classId)}` : ''
            return fetchJSON<WeeklyProgressData & ApiEnvelope>(
                `/dashboard/weekly-progress${qs}`,
            ).then(unwrap)
        },
    },

    /* ============================================================
     * v5.0 AI 对话流式（Task：学情诊断 AI 真实调用）
     *
     * 端点：POST /api/ai/chat
     * 模型：deepseek-v4-pro（默认）
     * 思考模式：low / medium / high / max
     * 流式：SSE 逐字推送 content；供应商原始 reasoning 在服务端出站边界丢弃
     *
     * 复用 streamDiagnosisSSE / api.copilot.streamChat 的 SSE 帧解析模式：
     *   - 按 \n\n 切帧
     *   - data: 提取 JSON
     *   - [DONE] 标记结束
     *   - chunk.error 触发 onError
     *
     * Chunk 格式：
     *   { content?: string, reasoning?: string, done?: boolean,
     *     model?: string, usage?: {...}, error?: string, message?: string }
     *
     * 返回 AiChatStreamController（abort + streaming getter），
     * 通过 callbacks.onChunk / onDone / onError 驱动 UI
     * ============================================================ */
    ai: {
        /**
         * 流式 AI 对话（POST /api/ai/chat，SSE）
         *
         * 使用示例：
         * ```ts
         * const ctrl = api.ai.chatStream(
         *   {
         *     messages: [{ role: 'user', content: '请分析该学生的薄弱点' }],
         *     model: 'deepseek-v4-pro',
         *     thinking_mode: 'medium',
         *     stream: true,
         *   },
         *   {
         *     onChunk: (chunk) => {
         *       if (chunk.content) appendText(chunk.content)
         *     },
         *     onDone: () => setStreaming(false),
         *     onError: (err) => toast.error(err.message),
         *   },
         * )
         * // 中断
         * ctrl.abort()
         * ```
         */
        chatStream: (
            req: AiChatStreamRequest,
            callbacks: AiChatStreamCallbacks,
        ): AiChatStreamController => {
            const controller = new AbortController()
            let streaming = true

            // 异步执行流式请求（不返回 Promise，通过回调驱动）
            void (async () => {
                try {
                    // 字段映射：前端 AiChatStreamRequest 字段名 → 后端 /api/ai/chat schema 字段名
                    // 前端 thinking_mode → 后端 thinking；前端 max_tokens → 后端 maxTokens
                    const backendBody = {
                        messages: req.messages,
                        model: req.model,
                        thinking: req.thinking_mode ?? 'medium',
                        temperature: req.temperature,
                        maxTokens: req.max_tokens,
                        stream: true as const,
                    }
                    const res = await fetchStreamResponse(`${API_BASE}/ai/chat`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            Accept: 'text/event-stream',
                        },
                        body: JSON.stringify(backendBody),
                        signal: controller.signal,
                    }, controller)

                    // HTTP 错误：尝试解析错误体
                    if (!res.ok) {
                        let errMsg = `HTTP ${res.status} ${res.statusText}`
                        try {
                            const ct = res.headers.get('content-type') ?? ''
                            if (ct.includes('application/json')) {
                                const errJson = (await res.json()) as { message?: string; error?: string }
                                if (errJson.message) errMsg = errJson.message
                                else if (errJson.error) errMsg = errJson.error
                            } else {
                                const text = await res.text()
                                if (text) errMsg = text
                            }
                        } catch {
                            // 响应体解析失败
                        }
                        throw new Error(errMsg)
                    }

                    if (!res.body) {
                        throw new Error('响应体为空，无法消费 SSE 流')
                    }

                    const reader = res.body.getReader()
                    const decoder = new TextDecoder('utf-8')
                    let buffer = ''
                    let terminalSeen = false

                    // eslint-disable-next-line no-constant-condition
                    while (true) {
                        const { done, value } = await readStreamChunk(reader, controller)
                        if (done) break

                        buffer += decoder.decode(value, { stream: true })

                        // 按 \n\n 切帧
                        let frameEnd: number
                        while ((frameEnd = buffer.indexOf('\n\n')) !== -1) {
                            const frameText = buffer.slice(0, frameEnd)
                            buffer = buffer.slice(frameEnd + 2)

                            // 提取 data: 行
                            const dataLines: string[] = []
                            for (const line of frameText.split('\n')) {
                                const trimmed = line.trim()
                                if (trimmed.startsWith('data: ')) {
                                    dataLines.push(trimmed.slice(6))
                                } else if (trimmed === 'data') {
                                    dataLines.push('')
                                }
                            }
                            if (dataLines.length === 0) continue
                            const data = dataLines.join('\n')

                            // [DONE] 标记
                            if (data === '[DONE]') {
                                terminalSeen = true
                                streaming = false
                                try {
                                    await reader.cancel()
                                } catch {
                                    // ignore
                                }
                                callbacks.onDone?.()
                                return
                            }

                            // JSON 解析
                            try {
                                const chunk = JSON.parse(data) as AiChatStreamChunk
                                // 错误帧特殊处理
                                if (chunk.error) {
                                    streaming = false
                                    callbacks.onError?.(errorFromSseFrame(chunk))
                                    try {
                                        await reader.cancel()
                                    } catch {
                                        // ignore
                                    }
                                    return
                                }
                                // done 帧触发 onDone（后端可能在帧内标记 done: true）
                                if (chunk.done) {
                                    terminalSeen = true
                                    streaming = false
                                    callbacks.onChunk(chunk)
                                    try {
                                        await reader.cancel()
                                    } catch {
                                        // ignore
                                    }
                                    callbacks.onDone?.()
                                    return
                                }
                                callbacks.onChunk(chunk)
                            } catch {
                                // 普通解析失败，跳过该帧
                                if (import.meta.env.DEV) {
                                    console.warn('[api.ai.chatStream] 帧解析失败，跳过:', data)
                                }
                            }
                        }
                    }

                    // 流自然结束
                    streaming = false
                    if (!requireExplicitSseTerminal(terminalSeen, controller.signal)) return
                    callbacks.onDone?.()
                } catch (err) {
                    streaming = false
                    // 主动 abort 不算错误
                    if (controller.signal.aborted) {
                        if (controller.signal.reason === STREAM_IDLE_TIMEOUT_REASON) {
                            callbacks.onError?.(new Error('流式响应超时，请稍后重试'))
                        }
                        return
                    }
                    if (err instanceof DOMException && err.name === 'AbortError') return
                    const finalErr = err instanceof Error ? err : new Error(String(err))
                    callbacks.onError?.(finalErr)
                }
            })()

            return {
                abort: () => {
                    if (streaming) {
                        streaming = false
                        controller.abort()
                    }
                },
                get streaming() {
                    return streaming
                },
            }
        },

        /* ============================================================
         * v5.0 SubTask 27.1：AI 生图（wan2.7-image）
         *
         * 端点：POST /api/ai/image-generate
         * 模型：wan2.7-image（阿里云 Workspace MaaS 北京端点，由后端代理）
         * 用途：基于诗词内容生成诗境插画；单次一张，多图按诗句并发
         *
         * 设计要点：
         *  - 不走 fetchJSON（响应体含 URL 列表，需要严格类型）
         *  - 只有真实 Wan WebP 才成功；离线/演示/供应商失败明确报错并由界面保留原图
         *  - 超时 125s（覆盖后端 90s 推理 + 30s 安全下载及传输余量）
         * ============================================================ */
        imageGenerate: async (req: AiImageGenerateRequest): Promise<AiImageGenerateResponse> => {
            if (isDemoMode()) {
                throw new Error('当前离线演示未启用动态生图，已保留诗库中的同诗实图')
            }

            // 后端最长包含 90s 模型推理 + 30s 受控图片下载，前端需略留传输余量。
            const timeoutController = new AbortController()
            const timeoutId = window.setTimeout(() => timeoutController.abort(), 125_000)
            try {
                const res = await fetch(`${API_BASE}/ai/image-generate`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json',
                    },
                    body: JSON.stringify({
                        prompt: req.prompt,
                        orientation: req.orientation ?? 'landscape',
                        n: 1,
                        poemId: req.poemId,
                        verse: req.verse,
                    }),
                    signal: timeoutController.signal,
                })
                if (!res.ok) {
                    if (import.meta.env.DEV) {
                        const text = await res.text().catch(() => '')
                        throw new ApiError(res.status, res.statusText, text || undefined)
                    }
                    throw new ApiError(res.status, res.statusText)
                }
                return parseAiImageGenerateResponse(await res.json() as unknown)
            } catch (err) {
                if (err instanceof ApiError) throw err
                if (err instanceof DOMException && err.name === 'AbortError') {
                    throw new Error('生图请求超时（125s），请稍后重试或减少生成数量')
                }
                if (import.meta.env.DEV) {
                    const reason = err instanceof Error ? err.message : String(err)
                    throw new Error(`生图请求失败: ${reason}`)
                }
                throw new Error('生图请求失败，请稍后重试')
            } finally {
                window.clearTimeout(timeoutId)
            }
        },

        /* ============================================================
         * v5.0 SubTask 27.2：AI TTS（mimo-v2.5-tts）
         *
         * 端点：POST /api/ai/tts
         * 模型：mimo-v2.5-tts（限时免费）
         * 用途：诗词朗诵范读生成
         * ============================================================ */
        tts: async (req: AiTtsRequest): Promise<AiTtsResponse> => {
            if (isDemoMode() && !navigator.onLine) {
                // 浏览器已明确离线时不发起无意义请求，返回本地演示静音音频。
                const silenceMp3 =
                    'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQwAADB8AhSmxhIIEVCSiJrDCQBTcu3UrAIwUdkRgQbFAZC1CQEwTJ9mjRvBA4UOLD8nKVOWfh+UlK4E6mgBFq/WGQzAK6wMrAFTSuaLe6RCPnhqLBCvA5z2gYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGA'
                return {
                    status: 'ok',
                    audioUrl: silenceMp3,
                    durationMs: 1000,
                    cached: false,
                    model: 'mimo-v2.5-tts',
                    aiGenerated: false,
                }
            }

            return fetchTtsAudio(req)
        },

        /* ============================================================
         * v5.0 SubTask 27.3：AI ASR（mimo-v2.5-asr）
         *
         * 端点：POST /api/ai/asr
         * 模型：mimo-v2.5-asr（0.5元/小时）
         * 用途：录音转文字 + 与原文对比评分
         *
         * multipart/form-data 上传：
         *  - file: 录音 Blob
         *  - poemId: 关联诗 ID（可选）
         *  - referenceText: 对比原文（可选，服务端基于真实转写计算文本相似度）
         * ============================================================ */
        asr: async (
            audioBlob: Blob,
            meta: AiAsrRequest = {},
            fileName = 'recitation.webm',
        ): Promise<AiAsrResponse> => {
            if (isDemoMode()) {
                // 未调用模型就没有转写、置信度或评分；referenceText 绝不能回填成识别结果。
                return parseAiAsrResponse({
                    status: 'degraded',
                    transcript: '',
                    audioDurationSec: 0,
                    model: 'local-placeholder',
                    requestedModel: 'mimo-v2.5-asr',
                    aiGenerated: false,
                    demo: true,
                    degraded: true,
                    degradationReason: 'demo-mode',
                })
            }

            const form = new FormData()
            // 字段先于文件追加，既方便流式 multipart 服务读取，也与后端白名单严格对齐。
            if (meta.poemId) form.append('poemId', meta.poemId)
            if (meta.referenceText) form.append('referenceText', meta.referenceText)
            if (meta.language) form.append('language', meta.language)
            if (meta.prompt) form.append('prompt', meta.prompt)
            form.append('file', audioBlob, fileName)

            // ASR 耗时较长，30s 超时
            const timeoutController = new AbortController()
            const timeoutId = window.setTimeout(() => timeoutController.abort(), 30_000)
            try {
                const res = await fetch(`${API_BASE}/ai/asr`, {
                    method: 'POST',
                    headers: { Accept: 'application/json' },
                    body: form,
                    signal: timeoutController.signal,
                })
                if (!res.ok) {
                    if (import.meta.env.DEV) {
                        const text = await res.text().catch(() => '')
                        throw new ApiError(res.status, res.statusText, text || undefined)
                    }
                    throw new ApiError(res.status, res.statusText)
                }
                return parseAiAsrResponse(await res.json() as unknown)
            } catch (err) {
                if (err instanceof ApiError) throw err
                if (err instanceof DOMException && err.name === 'AbortError') {
                    throw new Error('语音识别超时（30s），请缩短录音时长后重试')
                }
                if (import.meta.env.DEV) {
                    const reason = err instanceof Error ? err.message : String(err)
                    throw new Error(`语音识别失败: ${reason}`)
                }
                throw new Error('语音识别失败，请稍后重试')
            } finally {
                window.clearTimeout(timeoutId)
            }
        },
    },
}
