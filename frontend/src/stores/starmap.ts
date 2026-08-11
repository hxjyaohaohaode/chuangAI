/**
 * 诗脉星图全局状态（规范第 8.4、12 章）
 *
 * 职责：选中节点 / 视图模式 / 类型筛选 / 搜索关键词 / 班级选择
 * 设计：纯 UI 状态，与图谱数据解耦 —— 数据由 StarMapPage 持有并传入 canvas，
 *      此 store 仅承载用户交互态，保证跨组件同步（≤50ms，规范 12.2）
 *
 * Phase 1.6：新增 refreshSignal 机制，业务事件触发时递增信号，
 * StarMapPage 监听信号变化重新拉取图谱数据，实现数据闭环
 */

import { create } from 'zustand'
import { businessEvents } from '@/lib/business-events'
import type { GraphNode, NodeType, ViewMode } from '@/lib/types'

/** 全部节点类型，用于筛选器初始化 */
export const ALL_NODE_TYPES: NodeType[] = ['Poet', 'Poem', 'Image', 'Theme', 'Era', 'Rhetoric']
/** 节点数据默认完整启用；视觉密度由“关系透镜”控制，不以删类型换整洁。 */
const DEFAULT_NODE_TYPES: NodeType[] = ALL_NODE_TYPES

interface StarMapState {
    /** 当前选中的节点（点击后触发右侧详情面板） */
    selectedNode: GraphNode | null
    /** 当前 hover 的节点（用于面板预览或外部联动） */
    hoveredNode: GraphNode | null
    /** 视图模式：type=按类型着色 / mastery=按掌握度着色 */
    viewMode: ViewMode
    /** 启用的节点类型集合（筛选器） */
    enabledTypes: Set<NodeType>
    /** 搜索关键词（高亮匹配节点） */
    searchQuery: string
    /** 掌握度视图所需的班级 id */
    classId: string
    /** 是否使用 mock 数据（后端不可达时） */
    usingMock: boolean
    /** 数据刷新信号（递增触发，StarMapPage 监听此字段变化重新拉取数据） */
    refreshSignal: number

    /** 选中节点 */
    selectNode: (node: GraphNode | null) => void
    /** 设置 hover 节点 */
    setHoveredNode: (node: GraphNode | null) => void
    /** 切换视图模式 */
    setViewMode: (mode: ViewMode) => void
    /** 切换某类型的启用状态 */
    toggleType: (type: NodeType) => void
    /** 全选 / 全不选类型 */
    setAllTypes: (enabled: boolean) => void
    /** 设置搜索关键词 */
    setSearchQuery: (q: string) => void
    /** 设置班级 id */
    setClassId: (id: string) => void
    /** 标记 mock 状态 */
    setUsingMock: (v: boolean) => void
    /** 触发数据刷新信号（业务事件调用） */
    triggerRefresh: () => void
}

export const useStarMapStore = create<StarMapState>((set) => ({
    selectedNode: null,
    hoveredNode: null,
    viewMode: 'type',
    enabledTypes: new Set(DEFAULT_NODE_TYPES),
    searchQuery: '',
    classId: '',
    usingMock: false,
    refreshSignal: 0,

    selectNode: (node) => set({ selectedNode: node }),
    setHoveredNode: (node) => set({ hoveredNode: node }),
    setViewMode: (mode) => set({ viewMode: mode }),
    toggleType: (type) =>
        set((s) => {
            const next = new Set(s.enabledTypes)
            if (next.has(type)) next.delete(type)
            else next.add(type)
            // 至少保留一个类型，避免空图
            if (next.size === 0) next.add(type)
            return { enabledTypes: next }
        }),
    setAllTypes: (enabled) =>
        set({ enabledTypes: enabled ? new Set(ALL_NODE_TYPES) : new Set([ALL_NODE_TYPES[0]!]) }),
    setSearchQuery: (q) => set({ searchQuery: q }),
    setClassId: (id) => set({ classId: id }),
    setUsingMock: (v) => set({ usingMock: v }),
    triggerRefresh: () => set((s) => ({ refreshSignal: s.refreshSignal + 1 })),
}))

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1.6：业务事件总线订阅 —— self-study/grading → starmap 数据断点修复
//
// 学生自学进度更新或教师批改完成时，诗脉星图的节点掌握度可能变化。
// starmap store 订阅这两类事件，递增 refreshSignal，StarMapPage 监听信号
// 变化后重新拉取图谱数据，确保星图展示最新掌握度。
//
// 断裂点修复：starmap 此前不订阅任何业务事件，星图数据无法实时同步
// ─────────────────────────────────────────────────────────────────────────────
businessEvents.on('self-study:progress', () => {
    useStarMapStore.getState().triggerRefresh()
})

businessEvents.on('grading:reviewed', () => {
    useStarMapStore.getState().triggerRefresh()
})

// Phase 1.5：作品提交 → 触发星图刷新（创造工坊作品可能关联诗节点）
businessEvents.on('creation:submitted', () => {
    useStarMapStore.getState().triggerRefresh()
})
