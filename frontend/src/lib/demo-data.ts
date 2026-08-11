/**
 * 演示数据集（v5.0 Task 5.8 —— DEMO 模式深度优化）
 *
 * 设计目的：
 * - 当后端服务不可达时，前端各页面降级到演示数据，保证评委预览体验
 * - 演示数据与 graphMock.ts 中的经典篇目保持一致，确保跨页面数据自洽
 * - 所有数据严格类型对齐 lib/types.ts，避免运行时 shape 校验失败
 *
 * 使用规则：
 * - 仅在 useDemoModeStore.getState().isDemoMode === true 时使用
 * - 演示数据为静态常量；预警时间使用 Date.now() - N 相对偏移，
 *   模块加载时计算一次，让"1 小时前"等相对时间显示真实自然
 * - 演示数据不写入 localStorage（避免污染真实数据）
 * - 数据选取小学语文教材经典篇目，覆盖 1-6 年级
 *
 * 数据自洽性：
 * - 班级 ID（class-3-1 等）跨页面一致
 * - 古诗 ID（poem-jingyesi 等）与 graphMock.ts 完全对齐
 * - 教师 ID（teacher-001）与唯一公开演示主体一致
 * - 学生 ID（student-demo-*）仅用于演示，不会写入后端
 */

import type {
    DashboardStats,
    BloomRadar,
    AlertsResponse,
    WeeklyProgressResponse,
    WeeklyLesson,
    WorkbenchPoemOption,
} from './types'

/* ============================================================
 * 一、班级列表（与 useClasses 返回类型对齐）
 * ============================================================ */

export interface DemoClass {
    id: string
    name: string
}

export const DEMO_CLASSES: DemoClass[] = [
    { id: 'class-3-1', name: '三年级（1）班' },
    { id: 'class-4-2', name: '四年级（2）班' },
    { id: 'class-5-1', name: '五年级（1）班' },
]

/* ============================================================
 * 二、古诗列表（命题工坊 / 课堂 / 朗读 / 文化等页面共享）
 * 与 graphMock.ts 中的 6 首诗对齐 + 补充 4 首教材经典
 * ============================================================ */

export const DEMO_POEMS: WorkbenchPoemOption[] = [
    { id: 'poem-jingyesi', title: '静夜思', poet: '李白', dynasty: '唐' },
    { id: 'poem-wanglushanpubu', title: '望庐山瀑布', poet: '李白', dynasty: '唐' },
    { id: 'poem-chunxiao', title: '春晓', poet: '孟浩然', dynasty: '唐' },
    { id: 'poem-dengguanquelou', title: '登鹳雀楼', poet: '王之涣', dynasty: '唐' },
    { id: 'poem-cuncao', title: '赋得古原草送别', poet: '白居易', dynasty: '唐' },
    { id: 'poem-jiangxue', title: '江雪', poet: '柳宗元', dynasty: '唐' },
    { id: 'poem-yongxe', title: '咏雪', poet: '白居易', dynasty: '唐' },
    { id: 'poem-yongliu', title: '咏柳', poet: '贺知章', dynasty: '唐' },
    { id: 'poem-chunrixi', title: '春日', poet: '朱熹', dynasty: '宋' },
    { id: 'poem-xiaochi', title: '小池', poet: '杨万里', dynasty: '宋' },
]

/* ============================================================
 * 三、仪表盘统计（DashboardPage 顶部卡片）
 * ============================================================ */

export const DEMO_DASHBOARD_STATS: Record<string, DashboardStats> = {
    'class-3-1': {
        classId: 'class-3-1',
        className: '三年级（1）班',
        studentCount: 42,
        weekLearnedPoems: 3,
        classMasteryAvg: 78,
        masteryRecordCount: 216,
        pendingAlerts: 4,
        weekProgress: { learned: 3, total: 5 },
    },
    'class-4-2': {
        classId: 'class-4-2',
        className: '四年级（2）班',
        studentCount: 45,
        weekLearnedPoems: 2,
        classMasteryAvg: 82,
        masteryRecordCount: 204,
        pendingAlerts: 2,
        weekProgress: { learned: 2, total: 4 },
    },
    'class-5-1': {
        classId: 'class-5-1',
        className: '五年级（1）班',
        studentCount: 40,
        weekLearnedPoems: 4,
        classMasteryAvg: 85,
        masteryRecordCount: 228,
        pendingAlerts: 1,
        weekProgress: { learned: 4, total: 5 },
    },
}

/** 默认班级的仪表盘统计（未匹配 classId 时使用） */
export const DEMO_DASHBOARD_STATS_DEFAULT: DashboardStats = {
    classId: '',
    className: '演示班级',
    studentCount: 42,
    weekLearnedPoems: 3,
    classMasteryAvg: 78,
    masteryRecordCount: 216,
    pendingAlerts: 4,
    weekProgress: { learned: 3, total: 5 },
}

/* ============================================================
 * 四、六阶能力雷达（DashboardPage / DiagnosisPage 共享）
 * 数值与 graphMock.ts 中各诗的 mastery 均值对齐
 * ============================================================ */

const avg = (nums: number[]): number =>
    Math.round(nums.reduce((a, b) => a + b, 0) / nums.length)

export const DEMO_BLOOM_RADAR: Record<string, BloomRadar> = {
    'class-3-1': {
        classId: 'class-3-1',
        sampleSize: 216,
        radar: {
            记忆: avg([92, 85, 95, 88, 90, 70]),
            理解: avg([88, 80, 92, 70, 86, 55]),
            应用: avg([85, 72, 88, 65, 80, 50]),
            分析: avg([78, 55, 85, 60, 75, 48]),
            评价: avg([72, 50, 82, 58, 70, 45]),
            创造: avg([68, 45, 80, 50, 65, 40]),
        },
        comparison: {
            记忆: 80,
            理解: 75,
            应用: 70,
            分析: 65,
            评价: 60,
            创造: 55,
        },
    },
}

export const DEMO_BLOOM_RADAR_DEFAULT: BloomRadar = {
    classId: '',
    sampleSize: 216,
    radar: {
        记忆: 85,
        理解: 78,
        应用: 73,
        分析: 65,
        评价: 60,
        创造: 55,
    },
    comparison: {
        记忆: 80,
        理解: 75,
        应用: 70,
        分析: 65,
        评价: 60,
        创造: 55,
    },
}

/* ============================================================
 * 五、预警列表（DashboardPage 实时预警面板）
 * ============================================================ */

export const DEMO_ALERTS: AlertsResponse = {
    alerts: [
        {
            id: 'alert-demo-1',
            type: 'cognitive-dark-matter',
            severity: 'high',
            title: '江雪 · 创造层薄弱点',
            description: '五年级（1）班 38% 学生在"江雪"的创造层（改写/续写）掌握度低于 40%，存在显著认知薄弱。',
            affectedStudents: ['student-demo-1', 'student-demo-2', 'student-demo-3'],
            suggestedAction: '推荐使用"意象替换"教学策略，引导学生将"孤舟蓑笠翁"改写为现代场景',
            createdAt: Date.now() - 3600_000,
        },
        {
            id: 'alert-demo-2',
            type: 'student-drop',
            severity: 'medium',
            title: '李明 · 掌握度连续下滑',
            description: '李明同学在"登鹳雀楼"专题中，理解层掌握度从 75% 下滑至 55%，需关注。',
            affectedStudents: ['student-demo-1'],
            suggestedAction: '建议安排课后辅导，重点讲解"欲穷千里目"的哲理含义',
            createdAt: Date.now() - 7200_000,
        },
        {
            id: 'alert-demo-3',
            type: 'lesson-delay',
            severity: 'low',
            title: '《望庐山瀑布》课时延期',
            description: '原计划周三的《望庐山瀑布》第二课时延期至周五，请调整备课节奏。',
            suggestedAction: '在备课工坊中调整课时安排，确保周五前完成微调',
            createdAt: Date.now() - 86400_000,
        },
        {
            id: 'alert-demo-4',
            type: 'mastery-warning',
            severity: 'medium',
            title: '《春晓》整体掌握度偏低',
            description: '三年级（1）班在《春晓》的创造层掌握度仅 65%，低于年级均值 80%。',
            affectedStudents: ['student-demo-4', 'student-demo-5'],
            suggestedAction: '增加"春晓"的仿写练习，引导学生创作"夏晓""秋晓"',
            createdAt: Date.now() - 172800_000,
        },
    ],
}

/* ============================================================
 * 六、本周教学进度（DashboardPage 周进度表）
 * ============================================================ */

/** 生成本周 5 个工作日的演示进度（周一至周五，每天一节课） */
function buildDemoWeeklyProgress(): WeeklyProgressResponse {
    const lessons: Array<{
        date: string
        lesson: WeeklyLesson
    }> = [
            {
                date: '周一',
                lesson: {
                    id: 'lesson-demo-1',
                    poemTitle: '静夜思',
                    poet: '李白',
                    status: 'completed',
                    masteryBefore: 75,
                    masteryAfter: 88,
                    studentCount: 42,
                },
            },
            {
                date: '周二',
                lesson: {
                    id: 'lesson-demo-2',
                    poemTitle: '望庐山瀑布',
                    poet: '李白',
                    status: 'completed',
                    masteryBefore: 60,
                    masteryAfter: 72,
                    studentCount: 42,
                },
            },
            {
                date: '周三',
                lesson: {
                    id: 'lesson-demo-3',
                    poemTitle: '春晓',
                    poet: '孟浩然',
                    status: 'completed',
                    masteryBefore: 80,
                    masteryAfter: 90,
                    studentCount: 42,
                },
            },
            {
                date: '周四',
                lesson: {
                    id: 'lesson-demo-4',
                    poemTitle: '登鹳雀楼',
                    poet: '王之涣',
                    status: 'ongoing',
                    masteryBefore: 65,
                    studentCount: 42,
                },
            },
            {
                date: '周五',
                lesson: {
                    id: 'lesson-demo-5',
                    poemTitle: '江雪',
                    poet: '柳宗元',
                    status: 'planned',
                    masteryBefore: 50,
                    studentCount: 42,
                },
            },
        ]

    return {
        days: lessons.map(({ date, lesson }) => ({ date, lessons: [lesson] })),
    }
}

export const DEMO_WEEKLY_PROGRESS: WeeklyProgressResponse = buildDemoWeeklyProgress()

/* ============================================================
 * 七、默认演示班级 ID（供 useClasses 降级后默认选中）
 * ============================================================ */

export const DEMO_DEFAULT_CLASS_ID = 'class-3-1'

/* ============================================================
 * 八、辅助工具：按 classId 查询演示数据
 * ============================================================ */

/** 查询指定班级的演示仪表盘统计（无匹配时返回默认） */
export function getDemoDashboardStats(classId: string): DashboardStats {
    return DEMO_DASHBOARD_STATS[classId] ?? DEMO_DASHBOARD_STATS_DEFAULT
}

/** 查询指定班级的演示六阶雷达（无匹配时返回默认） */
export function getDemoBloomRadar(classId: string): BloomRadar {
    return DEMO_BLOOM_RADAR[classId] ?? DEMO_BLOOM_RADAR_DEFAULT
}
