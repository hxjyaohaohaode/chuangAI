import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import helmet from '@fastify/helmet'
import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
    config,
    validateApiKeys,
    validateAuthConfiguration,
    validateNetworkBoundary,
} from './config.js'
import {
    logger,
    fastifyLoggerPlugin,
    attachLlmEventLoggers,
    attachAgentEventLoggers,
} from './lib/logger/index.js'
import { router as llmRouter } from './llm/index.js'
import { agentEvents } from './agents/base/events.js'
import { healthRoutes } from './routes/health.js'
import { dashboardRoutes } from './routes/dashboard.js'
import { classroomRoutes } from './routes/classroom.js'
import { gradingRoutes } from './routes/grading.js'
import { workbenchRoutes } from './routes/workbench.js'
import { reportRoutes } from './routes/report.js'
import { copilotRoutes } from './routes/copilot.js'
import { recitationRoutes } from './routes/recitation.js'
import { diagnosisRoutes } from './routes/diagnosis.js'
import { creationRoutes } from './routes/creation.js'
import { cultureRoutes } from './routes/culture.js'
import { knowledgeGraphRoutes } from './routes/knowledge-graph.js'
import { appreciationRoutes } from './routes/appreciation.js'
import { lessonPlanRoutes } from './routes/lesson-plan.js'
import { lessonPlanTemplateRoutes } from './routes/lesson-plan-templates.js'
import { studentRoutes } from './routes/students.js'
import { agentOrchestrateRoutes } from './routes/workbench.js'
import { poemContentRoutes } from './routes/poem-content.js'
import { settingsRoutes } from './routes/settings.js'
import { memoryRoutes } from './routes/memory.js'
import { illustrationRoutes } from './routes/illustration.js'
import { errorNotebookRoutes } from './routes/error-notebook.js'
import { evolutionRoutes } from './routes/evolution.js'
import { aiRoutes } from './routes/ai.js'
import { normalizeHttpError } from './routes/_helpers.js'
import { isPublicSharedReportPage, shouldServeSpaFallback } from './lib/spa-fallback.js'
import { AuthService, authRoutes, installAuthBoundary } from './security/auth.js'
import { db, initDatabase, closeDatabase, seedDatabase } from './db/index.js'
import { enforceSingleTenantDataBoundary } from './security/single-tenant-data-boundary.js'
import {
    initOrchestrator,
    orchestratorRoutes,
    orchestratorWSPlugin,
} from './orchestrator/index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/**
 * 受控启动画像。仅在 BOOT_PROFILE=1 时写 stderr，避免正常生产日志噪声；
 * 用于定位演示现场或隔离回归环境中的冷启动退化，而不是把超时简单放宽。
 */
function logBootProfile(stage: string): void {
    if (process.env.BOOT_PROFILE !== '1') return
    process.stderr.write(`[boot-profile] stage=${stage} elapsedMs=${Math.round(process.uptime() * 1000)}\n`)
}

/**
 * 创建并启动 Fastify 服务
 * 端口 3001，CORS 允许前端 5173，注册健康检查路由
 */
async function startServer() {
    logBootProfile('start-server-entered')
    // 网络、认证配置校验必须早于数据库初始化，避免危险配置下产生“启动了一半”的副作用。
    validateNetworkBoundary()
    validateAuthConfiguration()

    // 启动期校验 API 密钥（DEMO_MODE=true 时跳过）
    validateApiKeys()

    // 初始化 SQLite 学情数据库（幂等）
    initDatabase()
    // 写入种子数据（幂等）—— 根因修复：此前从未调用，导致所有表为空
    seedDatabase()
    logBootProfile('database-ready')
    const tenantBoundary = enforceSingleTenantDataBoundary(db, config.auth.teacherId)

    // 订阅 LLM / Agent 事件总线，输出结构化日志
    // 在 Fastify 实例化之前完成订阅，确保所有 LLM/Agent 调用都被记录
    const detachLlmEventLoggers = attachLlmEventLoggers(llmRouter)
    const detachAgentEventLoggers = attachAgentEventLoggers(agentEvents)

    // 复用全局 logger 单例作为 Fastify 的 logger，使 req.log / app.log 与
    // 非请求代码（DB / LLM / 服务层）共享同一日志管线与 redact 配置
    const app = Fastify({
        loggerInstance: logger,
        // 内置请求日志会在自定义脱敏插件之前记录原始 URL；关闭它，统一由
        // fastifyLoggerPlugin 输出，避免公开分享 bearer token 落盘。
        disableRequestLogging: true,
    })
    logBootProfile('fastify-created')
    app.addHook('onClose', async () => {
        // 兼容测试/宿主直接调用 app.close() 而未发送 SIGINT/SIGTERM 的路径。
        detachLlmEventLoggers()
        detachAgentEventLoggers()
    })
    app.log.info(tenantBoundary, '单教师数据所有权边界已验证')

    const authService = new AuthService({
        ...config.auth,
        corsOrigins: config.corsOrigins,
    })
    if (authService.ephemeralSecret) {
        app.log.warn('未配置 AUTH_SESSION_SECRET：本次进程使用随机临时会话密钥，服务重启后需重新登录')
    }

    // 注册日志插件：requestId 注入 + 请求/响应/错误日志
    // 必须在所有业务路由注册之前注册
    await app.register(fastifyLoggerPlugin)

    // 注册 CORS 插件 - 允许前端开发服务器
    await app.register(cors, {
        origin: [...config.corsOrigins],
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    })

    // 安全响应头。生产 CSP 允许本系统使用的本地资源、WebSocket、Blob Worker、
    // 受控 Blob/Data 音频与 HTTPS 图片；禁止插件对象、跨站表单和非同源脚本。
    await app.register(helmet, {
        crossOriginEmbedderPolicy: false,
        contentSecurityPolicy: config.isDev
            ? false
            : {
                directives: {
                    defaultSrc: ["'self'"],
                    baseUri: ["'self'"],
                    connectSrc: ["'self'", 'ws:', 'wss:'],
                    fontSrc: ["'self'", 'data:'],
                    formAction: ["'self'"],
                    frameAncestors: ["'self'"],
                    imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
                    mediaSrc: ["'self'", 'blob:', 'data:'],
                    objectSrc: ["'none'"],
                    scriptSrc: ["'self'"],
                    styleSrc: ["'self'", "'unsafe-inline'"],
                    workerSrc: ["'self'", 'blob:'],
                },
            },
        strictTransportSecurity: config.isDev
            ? false
            : { maxAge: 15552000, includeSubDomains: true },
    })

    // 产品态只需要同源麦克风完成朗读/语音输入。屏幕录制属于已从生产包移除的
    // 开发工具；摄像头、定位、支付、硬件总线与运动传感器均无业务用途。
    if (!config.isDev) {
        app.addHook('onRequest', async (_request, reply) => {
            reply.header('Permissions-Policy', [
                'microphone=(self)',
                'camera=()',
                'display-capture=()',
                'geolocation=()',
                'payment=()',
                'usb=()',
                'serial=()',
                'bluetooth=()',
                'accelerometer=()',
                'gyroscope=()',
            ].join(', '))
        })
    }

    // 注册 WebSocket 插件（多智能体流式输出使用）
    await app.register(websocket, {
        options: { maxPayload: 1048576 },
    })

    // 注册 Multipart 插件（文件上传：语音、图片）
    await app.register(multipart, {
        limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    })
    logBootProfile('platform-plugins-registered')

    // 服务端身份是所有 API、WebSocket 与生成媒体的统一真相源。钩子必须先于静态和
    // 业务路由注册；SPA 外壳仍可公开加载，但生成内容必须持有有效教师会话。
    installAuthBoundary(app as unknown as FastifyInstance, authService)

    await app.register(authRoutes, {
        prefix: '/api/auth',
        service: authService,
    })

    // 仅挂载生成图片目录，访问仍由根认证钩子保护。学生作业、朗诵音频等私有上传
    // 必须通过受控 API 读取，不能因为同处 data/uploads 就绕过接口直接访问。
    //
    // 生图结果必须落盘（wan2.7 返回的签名 URL 会过期），落盘后需要一个稳定
    // 的地址供前端 <img src> 引用，因此开发与生产环境都要挂载这个目录。
    await mkdir(config.runtimePaths.generatedUploadsDir, { recursive: true })
    await app.register(fastifyStatic, {
        root: config.runtimePaths.generatedUploadsDir,
        prefix: '/uploads/generated/',
        decorateReply: false,
    })

    // 注册静态文件服务（生产环境托管前端构建产物）
    if (!config.isDev) {
        await app.register(fastifyStatic, {
            root: path.resolve(__dirname, '../../frontend/dist'),
            prefix: '/',
        })
    }

    // 注册路由 - 统一 /api 前缀
    await app.register(healthRoutes, { prefix: '/api' })

    // 教学驾驶舱路由（Task 9）
    await app.register(dashboardRoutes, { prefix: '/api/dashboard' })
    logBootProfile('foundation-routes-registered')

    // ── 编排官初始化（必须在 websocket 插件注册后调用） ──
    // 注：传入自定义 pino logger 会让 Fastify 推断出更具体的 Logger 类型，
    // 此处通过 unknown 中转换断言回默认 FastifyInstance，
    // 使 initOrchestrator 等下游函数签名兼容（运行时仍是同一个实例）。
    const orch = initOrchestrator(app as unknown as FastifyInstance)
    logBootProfile('orchestrator-initialized')

    // 注册编排官 REST API 路由
    await app.register(orchestratorRoutes, {
        prefix: '/api/orchestrator',
        orchestrator: orch.orchestrator,
        intervention: orch.intervention,
        sessionStore: orch.sessionStore,
        traceStore: orch.traceStore,
    })

    // 注册编排官 WebSocket 路由（/ws/orchestrator）
    await app.register(orchestratorWSPlugin, {
        prefix: '/ws',
        broadcaster: orch.broadcaster,
        intervention: orch.intervention,
    })

    // 课堂导播台路由（Task 11）—— 复用编排官的 WebSocket 广播器
    await app.register(classroomRoutes, {
        prefix: '/api/classroom',
        broadcaster: orch.broadcaster,
    })

    // 智能批改台路由（Task 12）—— 多模态手写答题批改
    // 闭环2补全：注入 broadcaster，批改完成后推送 WS 事件通知前端刷新错题本/诊断
    await app.register(gradingRoutes, {
        prefix: '/api/grading',
        broadcaster: orch.broadcaster,
    })

    // 六阶命题工坊路由（Task 10）—— 真实多智能体命题闭环
    await app.register(workbenchRoutes, {
        prefix: '/api/workbench',
        orchestrator: orch.orchestrator,
        sessionStore: orch.sessionStore,
        broadcaster: orch.broadcaster,
    })

    // 多智能体编排 SSE 路由 —— 命题工坊「多智能体协作」面板的进度流
    // 与 /api/workbench/generate（fire-and-forget + WS）互补：
    // 前者面向多端同步观察，本端点面向发起命题的那一个页面做逐帧渲染。
    await app.register(agentOrchestrateRoutes, {
        prefix: '/api/agents',
        orchestrator: orch.orchestrator,
        sessionStore: orch.sessionStore,
        broadcaster: orch.broadcaster,
    })

    // AI 副驾路由（Task 13）—— 教师与系统对话的统一入口
    await app.register(copilotRoutes, {
        prefix: '/api/copilot',
        orchestrator: orch.orchestrator,
        sessionStore: orch.sessionStore,
        intervention: orch.intervention,
        broadcaster: orch.broadcaster,
        traceStore: orch.traceStore,
    })

    // 教研报告自动生成路由（Task 14）—— 真实多智能体协作生成教研报告
    await app.register(reportRoutes, {
        prefix: '/api/report',
        orchestrator: orch.orchestrator,
        sessionStore: orch.sessionStore,
        broadcaster: orch.broadcaster,
    })

    // 诗音阁路由（Task 19）—— mimo-v2.5-asr 朗读转写 + 诗心评估 + mimo-v2.5-tts 范读 + 排行榜
    await app.register(recitationRoutes, { prefix: '/api/recitation' })

    // 认知诊断中心路由（Task 17）—— 暗物质算法 + 知识图谱深度查询可视化
    // 批改诊断深化：注入 broadcaster，处方/路径生成完成后推送 WS 事件
    await app.register(diagnosisRoutes, {
        prefix: '/api/diagnosis',
        broadcaster: orch.broadcaster,
    })

    // 课后创造工坊路由（Task 16）—— 创造级培养：配画/改写/视频脚本/鉴赏文 + AI 协作共创 + 作品墙
    // 闭环3补全：注入 broadcaster，作品提交/批改/再创作完成后推送 WS 事件
    await app.register(creationRoutes, {
        prefix: '/api/creation',
        broadcaster: orch.broadcaster,
    })

    // 文化语境还原路由（Task 20）—— 文化背景包 + 文物图片库 + 意象解读 + 沉浸式投屏
    await app.register(cultureRoutes, { prefix: '/api/culture' })

    // 知识图谱路由 —— StarMap 页面核心数据源：完整图谱 / 掌握度着色 / 暗物质 / 学生漏洞 / 关联诗
    await app.register(knowledgeGraphRoutes, { prefix: '/api/knowledge-graph' })

    // 鉴赏指导路由（Phase 4.4）—— 学生闭环 S5 运用：四步鉴赏法 + 炼字赏析
    await app.register(appreciationRoutes, { prefix: '/api/appreciation' })

    // 教案工坊路由 —— AI 生成教案 + 教案列表/详情/保存
    await app.register(lessonPlanRoutes, {
        prefix: '/api/lesson-plan',
        orchestrator: orch.orchestrator,
        sessionStore: orch.sessionStore,
        broadcaster: orch.broadcaster,
    })

    // 教学场景插画路由 —— 受控 prompt 生图 + 落盘缓存（驾驶舱闭环卡片等使用）
    await app.register(illustrationRoutes, { prefix: '/api/illustration' })

    // 系统设置路由：本地可更新 .env；Render 必须由 Dashboard Environment
    // 托管并保持只读，绝不把明文密钥写入项目根或持久盘。
    await app.register(settingsRoutes, {
        prefix: '/api/settings',
        externallyManagedCredentials: config.isRender,
    })

    // 长期记忆治理路由 —— 教师显式查看/新增/修改/删除，默认按 TTL 自动清理
    await app.register(memoryRoutes, { prefix: '/api/memory' })

    // 诗内容教学路由 —— 原文/拼音/译文/生字/修辞（课堂逐句讲解面板数据源）
    await app.register(poemContentRoutes, { prefix: '/api/poem-content' })

    // 学生资源路由 —— 学生列表（命题推荐/批改筛选用）+ 薄弱知识点聚合
    await app.register(studentRoutes, { prefix: '/api/students' })

    // 教案模板库路由 —— 教师可浏览/套用的 12 套成品教案模板
    // 注意前缀是复数 /api/lesson-plans，与上面单数的 /api/lesson-plan 是两个不同资源：
    //   单数 → 教学阶段骨架（AI 生成教案时套用节奏）
    //   复数 → 教案模板库（教案工坊「模板」Tab 的数据源）
    await app.register(lessonPlanTemplateRoutes, { prefix: '/api/lesson-plans' })

    // 错题本路由 —— 错题列表/详情/复习/统计
    // 闭环2补全：注入 broadcaster，复习完成后推送 WS 事件通知前端刷新诊断/教学建议
    await app.register(errorNotebookRoutes, {
        prefix: '/api/error-notebook',
        broadcaster: orch.broadcaster,
    })

    // 进化之眼基因谱路由 —— 自我进化引擎可视化：版本谱系/模式列表/A/B测试
    await app.register(evolutionRoutes, { prefix: '/api/evolution' })

    // 统一 AI 能力路由 —— 文生图 / TTS / ASR / 文本对话（SubTask 14.2）
    await app.register(aiRoutes, { prefix: '/api/ai' })
    logBootProfile('business-routes-registered')

    // 部分 SqliteMap 表在插件注册时才建立；监听端口前再次扫描，确保晚创建的
    // 会话/报告/教案表也没有绕过单租户所有权边界。
    const postRegistrationTenantBoundary = enforceSingleTenantDataBoundary(db, config.auth.teacherId)
    app.log.info(postRegistrationTenantBoundary, '插件注册后的单教师数据边界已复验')

    // 生产环境的 History API fallback：
    // 浏览器直接访问/刷新前端深层路由时返回 index.html；
    // 未知 API、上传资源和静态资源仍保留真实 404，避免掩盖接口/资源断链。
    if (!config.isDev) {
        app.setNotFoundHandler((request, reply) => {
            if (shouldServeSpaFallback({
                method: request.method,
                url: request.url,
                accept: request.headers.accept,
            })) {
                if (isPublicSharedReportPage(request.url)) {
                    reply.header('Cache-Control', 'no-store')
                    reply.header('Pragma', 'no-cache')
                    reply.header('Referrer-Policy', 'no-referrer')
                    reply.header('X-Robots-Tag', 'noindex, nofollow, noarchive')
                    // @fastify/static 默认会在 sendFile 阶段写回 public,max-age=0，
                    // 覆盖上方隐私策略；按单次发送关闭其 Cache-Control 生成，
                    // 让显式 no-store 成为最终线上响应头。
                    return reply.type('text/html; charset=utf-8').sendFile('index.html', {
                        cacheControl: false,
                    })
                }
                return reply.type('text/html; charset=utf-8').sendFile('index.html')
            }

            return reply.code(404).send({
                status: 'error',
                error: 'NOT_FOUND',
                message: '请求的资源不存在',
                statusCode: 404,
            })
        })
    }

    // 全局错误处理（与 fastifyLoggerPlugin 的 onError 钩子互补：
    // setErrorHandler 决定响应体，onError 钩子负责日志记录）
    app.setErrorHandler((error, request, reply) => {
        const normalized = normalizeHttpError(error, !config.isDev)
        request.log.error(
            {
                err: error,
                statusCode: normalized.statusCode,
                errorCode: normalized.errorCode,
            },
            '请求处理出错',
        )
        reply.status(normalized.statusCode).send({
            status: 'error',
            error: normalized.errorCode,
            message: normalized.message,
            statusCode: normalized.statusCode,
        })
    })

    // 启动服务
    try {
        logBootProfile('before-listen')
        await app.listen({ port: config.port, host: config.host })
        logBootProfile('listen-ready')
        app.log.info({ port: config.port, host: config.host }, '诗脉·启明后端服务已启动')
        app.log.info({ url: `http://localhost:${config.port}/api/health` }, '路由: 健康检查')
        app.log.info({ url: `http://localhost:${config.port}/api/orchestrator` }, '路由: 编排官 REST API')
        app.log.info({ url: `ws://localhost:${config.port}/ws/orchestrator` }, '路由: 编排官 WebSocket')
        app.log.info({ url: `http://localhost:${config.port}/api/dashboard` }, '路由: 教学驾驶舱')
        app.log.info({ url: `http://localhost:${config.port}/api/classroom` }, '路由: 课堂导播台')
        app.log.info({ url: `http://localhost:${config.port}/api/grading` }, '路由: 智能批改台')
        app.log.info({ url: `http://localhost:${config.port}/api/workbench` }, '路由: 六阶命题工坊')
        app.log.info({ url: `http://localhost:${config.port}/api/report` }, '路由: 教研报告自动生成')
        app.log.info({ url: `http://localhost:${config.port}/api/copilot` }, '路由: AI 副驾')
        app.log.info({ url: `http://localhost:${config.port}/api/recitation` }, '路由: 诗音阁')
        app.log.info({ url: `http://localhost:${config.port}/api/culture` }, '路由: 文化语境还原')
        app.log.info({ url: `http://localhost:${config.port}/api/creation` }, '路由: 课后创造工坊')
        app.log.info({ url: `http://localhost:${config.port}/api/knowledge-graph` }, '路由: 知识图谱')
    } catch (err) {
        app.log.fatal({ err }, '服务启动失败')
        process.exit(1)
    }

    // 优雅关闭。信号可能在退出窗口内重复到达；幂等门避免并发 app.close()/db.close()
    // 交错，确保所有清理步骤只执行一次。
    let shuttingDown = false
    const shutdown = async (signal: string) => {
        if (shuttingDown) return
        shuttingDown = true
        app.log.info({ signal }, '收到关闭信号，正在关闭服务...')
        // logger 订阅器本身持有事件总线与短期缓存；先解绑，避免热重载/多次
        // 启停时重复记录同一事件或把旧进程对象留在全局 EventEmitter 上。
        detachLlmEventLoggers()
        detachAgentEventLoggers()
        // 清理编排官事件桥接器与 WebSocket 连接
        orch.eventBridge.destroy()
        orch.broadcaster.closeAll()
        await app.close()
        closeDatabase()
        process.exit(0)
    }
    process.on('SIGINT', () => void shutdown('SIGINT'))
    process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

// 启动失败的最后兜底：此时 logger 可能尚未初始化，使用 console.error 是允许的
startServer().catch((err) => {
    // 尝试用 logger 输出，若失败则回退到 stderr
    try {
        logger.fatal({ err }, '启动异常')
    } catch {
        // eslint-disable-next-line no-console
        console.error('启动异常:', err)
    }
    process.exit(1)
})
