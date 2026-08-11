/**
 * 文化语境还原全局状态（Task 20，规范第 12 章 —— 实时数据同步）
 *
 * 职责：
 * 1. 持有诗列表 / 当前选中诗 / 文化背景包 / 图片库 / 意象解读 / 投屏状态
 * 2. 编排"选诗 → 背景包生成 → 图片库生成 → 意象解读 → 沉浸式投屏"完整流程
 * 3. 数据同步：选诗后并行拉取背景包与图片库，任一失败不影响其他
 * 4. 失败降级：生成失败时保留旧数据并 toast 提示，不空白
 *
 * 设计要点：
 * - 乐观更新：投屏启动/停止立即反映在 UI
 * - 缓存感知：后端缓存命中时静默确认，未命中时显示生成进度
 * - 并行拉取：选诗后 background 与 images 并行请求，降低等待时间
 * - 意象提取：从诗文中检测常见意象词，供 ImageryPanel 展示
 */

import { getDisplayError } from '@/lib/errors'
import { create } from 'zustand'
import { api } from '@/lib/api'
import { toast } from '@/stores/toast'
import type {
    CulturePoem,
    CultureBackground,
    CultureImage,
    ImageryInterpretation,
    ImmersiveState,
    StartImmersiveBody,
    WSStatus,
    WSEvent,
} from '@/lib/types'

let immersiveStatusGeneration = 0

/** 常见古诗意象词表（用于从诗文中提取可解读的意象） */
export const COMMON_IMAGERIES = [
    '明月', '清风', '落花', '流水', '青山', '白云', '孤舟', '飞鸟',
    '杨柳', '芳草', '夕阳', '秋风', '春雨', '寒霜', '孤月', '残阳',
    '梅花', '兰花', '翠竹', '菊花', '松柏', '荷花', '桃花', '杏花',
    '大雁', '杜鹃', '黄鹂', '燕子', '鸳鸯', '蝉', '萤火',
    '酒', '茶', '琴', '棋', '书', '画', '剑',
    '长安', '江南', '塞北', '故园', '边关', '楼台',
    '烛', '砧', '笛', '箫', '钟', '鼓',
    '霜鬓', '白发', '红颜', '故人', '游子',
] as const

interface CultureState {
    // ── 诗列表 ──
    poems: CulturePoem[]
    selectedPoemId: string | null
    poemsLoading: boolean

    // ── 文化背景包 ──
    background: CultureBackground | null
    backgroundLoading: boolean
    backgroundCached: boolean

    // ── 图片库 ──
    images: CultureImage[]
    imagesLoading: boolean
    imagesCached: boolean
    selectedImage: CultureImage | null

    // ── 意象解读 ──
    imagery: ImageryInterpretation | null
    imageryLoading: boolean
    selectedImageryName: string | null

    // ── 沉浸式投屏 ──
    immersiveState: ImmersiveState | null
    immersiveLoading: boolean

    // ── 全局错误 ──
    error: string | null

    // ── 动作 ──
    /** 加载古诗列表（复用 recitation 诗列表接口） */
    loadPoems: () => Promise<void>
    /**
     * TanStack Query 同步入口：将查询结果写入 store 并自动选中首诗。
     * 与 loadPoems 不同，此方法不做网络请求，仅用于 store 与 query 缓存同步。
     */
    setPoemsFromQuery: (poems: CulturePoem[]) => void
    /** 选择古诗（清空旧数据并并行拉取背景包 + 图片库） */
    selectPoem: (poemId: string) => void
    /** 拉取文化背景包 */
    fetchBackground: (poemId: string) => Promise<void>
    /** 拉取图片库 */
    fetchImages: (poemId: string) => Promise<void>
    /** 查看单张图片详情 */
    selectImage: (imageId: string) => Promise<void>
    /** 拉取意象文化内涵解读 */
    fetchImagery: (imageName: string) => Promise<void>
    /** 显式请求 AI 深度刷新；失败时保留当前本地解读 */
    refreshImagery: (imageName: string) => Promise<void>
    /** 启动沉浸式投屏 */
    startImmersive: (req: StartImmersiveBody) => Promise<void>
    /** 查询投屏状态 */
    fetchImmersiveStatus: (poemId: string, signal?: AbortSignal) => Promise<void>
    /** 停止投屏 */
    stopImmersive: (poemId?: string) => Promise<void>
    /** 重置 store */
    reset: () => void

    // ── WebSocket（v5.0 Task 3.5）──
    /** WebSocket 连接状态 */
    wsStatus: WSStatus
    /** 设置 WS 连接状态 */
    setWsStatus: (status: WSStatus) => void
    /** 处理 WS 事件（orch:session:end 刷新投屏 / orch:task:failed 设置错误态） */
    handleWSEvent: (event: WSEvent) => void
}

/**
 * 从诗文中提取常见意象词列表
 *
 * 遍历 COMMON_IMAGERIES，返回出现在 content 中的意象名。
 * 用于 ImageryPanel 展示可解读的意象列表。
 */
export function extractImageriesFromContent(content: string): string[] {
    return COMMON_IMAGERIES.filter((name) => content.includes(name))
}

/**
 * Culture Zustand store
 *
 * 用法：
 *   const { poems, selectedPoemId, selectPoem } = useCultureStore()
 *   useCultureStore.getState().loadPoems()
 */
export const useCultureStore = create<CultureState>((set, get) => ({
    // ── WebSocket（v5.0 Task 3.5）──
    wsStatus: 'idle',
    setWsStatus: (status) => set({ wsStatus: status }),
    handleWSEvent: (event) => {
        const state = get()
        const payload = event.payload as {
            taskId?: string
            sessionId?: string
            error?: string
            endedAt?: number
        }

        switch (event.type) {
            case 'orch:session:end': {
                // 文化生成会话结束：若当前有沉浸式投屏，刷新投屏状态
                // fetchImmersiveStatus 为静默失败，不会干扰用户
                if (state.selectedPoemId && state.immersiveState) {
                    void state.fetchImmersiveStatus(state.selectedPoemId)
                }
                break
            }
            case 'orch:task:failed': {
                if (payload.error) {
                    set({ error: getDisplayError(payload.error, '文化内容生成失败') })
                    if (import.meta.env.DEV) {
                        console.warn('[culture] 文化生成任务失败:', payload.error)
                    }
                }
                break
            }
            default:
                break
        }
    },

    poems: [],
    selectedPoemId: null,
    poemsLoading: false,

    background: null,
    backgroundLoading: false,
    backgroundCached: false,

    images: [],
    imagesLoading: false,
    imagesCached: false,
    selectedImage: null,

    imagery: null,
    imageryLoading: false,
    selectedImageryName: null,

    immersiveState: null,
    immersiveLoading: false,

    error: null,

    loadPoems: async () => {
        set({ poemsLoading: true, error: null })
        try {
            const res = await api.recitation.listPoems()
            // 防御性校验：res.poems 可能为 undefined/null（后端契约漂移），降级为空数组
            const rawPoems = Array.isArray(res.poems) ? res.poems : []
            const poems: CulturePoem[] = rawPoems.map((p) => ({
                id: p.id,
                title: p.title,
                poet: p.poet,
                dynasty: p.dynasty,
                content: p.content,
            }))
            set({ poems, poemsLoading: false, error: null })

            // 自动选中第一首诗
            if (poems.length > 0 && !get().selectedPoemId) {
                const first = poems[0]
                if (first) get().selectPoem(first.id)
            }
        } catch (err) {
            set({
                poemsLoading: false,
                error: getDisplayError(err, '诗列表加载失败'),
            })
            toast.error({ message: '诗列表加载失败，请稍后重试' })
        }
    },

    setPoemsFromQuery: (poems) => {
        // 由 TanStack Query 在 onSuccess 调用：仅同步缓存数据，不发请求
        set({ poems, poemsLoading: false, error: null })
        // 自动选中第一首诗（保留 CultureContextPage 的 winter poem 检测能力）
        if (poems.length > 0 && !get().selectedPoemId) {
            const first = poems[0]
            if (first) get().selectPoem(first.id)
        }
    },

    selectPoem: (poemId) => {
        immersiveStatusGeneration += 1
        // 清空旧数据，立即反映选中态（乐观更新）
        set({
            selectedPoemId: poemId,
            background: null,
            backgroundLoading: true,
            backgroundCached: false,
            images: [],
            imagesLoading: true,
            imagesCached: false,
            selectedImage: null,
            imagery: null,
            selectedImageryName: null,
            immersiveState: null,
            error: null,
        })

        // 并行拉取背景包与图片库，任一失败不影响其他
        void get().fetchBackground(poemId)
        void get().fetchImages(poemId)
    },

    fetchBackground: async (poemId) => {
        try {
            const res = await api.culture.background(poemId)
            set({
                background: res.background,
                backgroundCached: res.cached,
                backgroundLoading: false,
            })
        } catch (err) {
            set({
                backgroundLoading: false,
                error: getDisplayError(err, '文化背景包生成失败'),
            })
            toast.warning({ message: '文化背景包生成失败，请稍后重试' })
        }
    },

    fetchImages: async (poemId) => {
        try {
            const res = await api.culture.images(poemId)
            // 后端返回空图片列表时保持真实空态，禁止跨诗篇套用无关图片
            if (!res.images || res.images.length === 0) {
                set({
                    images: [],
                    imagesCached: false,
                    imagesLoading: false,
                })
                toast.info({ message: '该诗篇的专属诗境图尚未生成' })
                return
            }
            set({
                images: res.images,
                imagesCached: res.cached,
                imagesLoading: false,
            })
        } catch (err) {
            // 服务失败时保留真实空态；错误配图比无图更会误导教学
            set({
                images: [],
                imagesCached: false,
                imagesLoading: false,
                error: getDisplayError(err, '图片库生成失败'),
            })
            toast.warning({ message: '诗境图生成服务暂不可达，未使用无关图片替代' })
        }
    },

    selectImage: async (imageId) => {
        // 优先从本地图片库查找（乐观更新）
        const local = get().images.find((i) => i.id === imageId)
        if (local) {
            set({ selectedImage: local })
        }

        // 后台拉取最新详情（可能含额外字段）
        try {
            const res = await api.culture.image(imageId)
            set({ selectedImage: res.image })
        } catch {
            // 静默失败，保留本地数据
        }
    },

    fetchImagery: async (imageName) => {
        set({ imageryLoading: true, selectedImageryName: imageName, error: null })
        try {
            const res = await api.culture.imagery(imageName)
            set({
                imagery: res.interpretation,
                imageryLoading: false,
            })
        } catch (err) {
            set({
                imageryLoading: false,
                error: getDisplayError(err, '意象解读生成失败'),
            })
            toast.warning({ message: `"${imageName}" 意象解读生成失败` })
        }
    },

    refreshImagery: async (imageName) => {
        set({ imageryLoading: true, error: null })
        try {
            const res = await api.culture.refreshImagery(imageName)
            set({ imagery: res.interpretation, imageryLoading: false })
            toast.success({ message: `"${imageName}" AI 深度解读已更新` })
        } catch (err) {
            set({
                imageryLoading: false,
                error: getDisplayError(err, 'AI 深度解读暂不可用'),
            })
            toast.warning({ message: 'AI 刷新未完成，已保留可追溯的本地目录解读' })
        }
    },

    startImmersive: async (req) => {
        set({ immersiveLoading: true, error: null })
        try {
            const res = await api.culture.immersiveStart(req)
            set({
                immersiveState: res.state,
                immersiveLoading: false,
            })
            toast.success({ message: '沉浸式投屏已启动' })
        } catch (err) {
            set({
                immersiveLoading: false,
                error: getDisplayError(err, '投屏启动失败'),
            })
            toast.error({ message: '投屏启动失败，请稍后重试' })
        }
    },

    fetchImmersiveStatus: async (poemId, signal) => {
        const generation = ++immersiveStatusGeneration
        try {
            const res = await api.culture.immersiveStatus(poemId, signal)
            if (
                generation === immersiveStatusGeneration
                && get().selectedPoemId === poemId
            ) set({ immersiveState: res.state })
        } catch {
            // 静默失败
        }
    },

    stopImmersive: async (poemId) => {
        set({ immersiveLoading: true })
        try {
            const res = await api.culture.immersiveStop(poemId)
            if (res.state) {
                set({ immersiveState: res.state, immersiveLoading: false })
            } else {
                // 停止所有投屏，清空状态
                set({ immersiveState: null, immersiveLoading: false })
            }
            toast.info({ message: '投屏已停止' })
        } catch (err) {
            set({ immersiveLoading: false })
            toast.warning({ message: '停止投屏失败' })
        }
    },

    reset: () => {
        immersiveStatusGeneration += 1
        set({
            poems: [],
            selectedPoemId: null,
            poemsLoading: false,
            background: null,
            backgroundLoading: false,
            backgroundCached: false,
            images: [],
            imagesLoading: false,
            imagesCached: false,
            selectedImage: null,
            imagery: null,
            imageryLoading: false,
            selectedImageryName: null,
            immersiveState: null,
            immersiveLoading: false,
            error: null,
        })
    },
}))
