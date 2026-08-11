/**
 * 5+ 剧本矩阵（工程保障层 / 一键演示）
 *
 * 设计目的：
 * - 预置至少 6 个可一键播放的演示剧本
 * - 每个剧本由场景序列构成，每步定义：
 *   · 目标页面（路由跳转）
 *   · 预置数据（store 预填）
 *   · 自动操作（模拟用户点击/输入）
 *   · 停留时长（自动进入下一步）
 *   · 解说文案（播放器显示）
 * - 剧本可组合（一个剧本可调用另一个剧本的子段）
 *
 * 6 大剧本：
 * 1. classroom-immersive   - 沉浸式 6 级教学（2 分钟）
 * 2. diagnosis-persona     - AI 诊断与画像（2 分钟）
 * 3. creation-flow         - AI 创作与批改（2 分钟）
 * 4. starmap-tour          - 知识星图漫游（2 分钟）
 * 5. evolution-showcase    - 自进化演示（2 分钟）
 * 6. full-journey          - 全流程贯通（5 分钟）
 *
 * 严格遵循：
 * - TypeScript 类型完整
 * - 仅描述剧本数据，不调用任何 LLM / API
 * - 路由路径与 NAV 真相对齐
 */

// ─────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────

/** 剧本步骤：单步操作 */
export interface ScriptStep {
  /** 步骤序号（从 1 开始） */
  index: number
  /** 步骤标题 */
  title: string
  /** 目标页面路由（与 NAV 对齐） */
  route: string
  /** 预置数据：要写入 store 的部分状态 */
  preset?: ScriptPreset
  /** 模拟操作：要触发的事件 */
  actions?: ScriptAction[]
  /** 停留时长（ms） */
  durationMs: number
  /** 解说文案（播放器显示） */
  narration: string
}

/** 预置数据 */
export interface ScriptPreset {
  /** 选中班级 ID */
  classId?: string
  /** 选中古诗 ID */
  poemId?: string
  /** 选中学生 ID */
  studentId?: string
  /** 课堂模式（classroom 专用） */
  classroomMode?: 'six-level' | 'flying-flower' | 'speed-pk' | 'collective-race'
  /** 教学主题 */
  topic?: string
}

/** 模拟操作 */
export interface ScriptAction {
  /** 操作类型 */
  type: 'click' | 'input' | 'scroll' | 'toggle' | 'wait'
  /** 目标元素 selector（click/input/scroll） */
  selector?: string
  /** 输入值（input） */
  value?: string
  /** 滚动位置（scroll） */
  scrollY?: number
  /** 切换状态（toggle） */
  toggleValue?: boolean
  /** 等待时长（wait） */
  waitMs?: number
  /** 操作描述（用于解说） */
  description?: string
}

/** 完整剧本 */
export interface DemoScript {
  /** 剧本 ID */
  id: string
  /** 剧本标题 */
  title: string
  /** 剧本简介 */
  description: string
  /** 预计时长（秒） */
  estimatedDurationSec: number
  /** 适用场景标签 */
  tags: string[]
  /** 步骤序列 */
  steps: ScriptStep[]
  /** 可调用的子剧本 ID（用于组合） */
  composedFrom?: string[]
}

// ─────────────────────────────────────────────────────────────
// 6 大剧本定义
// ─────────────────────────────────────────────────────────────

export const DEMO_SCRIPTS: DemoScript[] = [
  // ========== 1. classroom-immersive —— 沉浸式 6 级教学 ==========
  {
    id: 'classroom-immersive',
    title: '沉浸式 6 级教学',
    description: '演示课堂导播台的 6 级 Bloom 沉浸教学模式，从识记到创造的全链路教学闭环。',
    estimatedDurationSec: 120,
    tags: ['课堂导播', 'Bloom 六级', '沉浸模式'],
    steps: [
      {
        index: 1,
        title: '进入课堂导播台',
        route: '/classroom',
        preset: {
          classId: 'class-3-1',
          poemId: 'poem-jingyesi',
          classroomMode: 'six-level',
          topic: '《静夜思》李白',
        },
        durationMs: 8000,
        narration:
          '教师从驾驶舱进入课堂导播台，选择三年级（1）班，进入《静夜思》沉浸式 6 级教学。系统已根据学生画像预生成 6 级教学节点。',
      },
      {
        index: 2,
        title: '第 1 级 · 识记',
        route: '/classroom',
        actions: [
          {
            type: 'click',
            selector: '[data-bloom-level="1"]',
            description: '点击第 1 级教学节点',
          },
        ],
        durationMs: 12000,
        narration:
          '第 1 级"识记"：学生跟读"床前明月光，疑是地上霜"。系统通过 mimo-v2.5-asr 实时识别朗读，节奏分 78。',
      },
      {
        index: 3,
        title: '第 3 级 · 应用',
        route: '/classroom',
        actions: [
          {
            type: 'click',
            selector: '[data-bloom-level="3"]',
            description: '跳转到第 3 级教学节点',
          },
        ],
        durationMs: 12000,
        narration:
          '第 3 级"应用"：命题工坊自动生成"为诗句配画"任务，学生提交作品后由 vision-annotate 识别评分。',
      },
      {
        index: 4,
        title: '第 6 级 · 创造',
        route: '/classroom',
        actions: [
          {
            type: 'click',
            selector: '[data-bloom-level="6"]',
            description: '跳转到第 6 级创造节点',
          },
        ],
        durationMs: 15000,
        narration:
          '第 6 级"创造"：学生以"我与月亮"为题仿写四句小诗。AI 副驾实时点评，3 篇优秀作品上墙。',
      },
      {
        index: 5,
        title: '课堂报告生成',
        route: '/classroom',
        actions: [
          { type: 'click', selector: '[data-action="generate-report"]', description: '生成课堂报告' },
        ],
        durationMs: 10000,
        narration:
          '课堂结束，系统自动汇总 6 级教学数据，生成课堂报告并推送至教研沉淀层。',
      },
    ],
  },

  // ========== 2. diagnosis-persona —— AI 诊断与画像 ==========
  {
    id: 'diagnosis-persona',
    title: 'AI 诊断与画像',
    description: '演示认知诊断 Agent 与学情画像 Agent 的协作流程，从班级到个体的多维度画像生成。',
    estimatedDurationSec: 120,
    tags: ['认知诊断', '学情画像', 'AI 协作'],
    steps: [
      {
        index: 1,
        title: '进入教学驾驶舱',
        route: '/dashboard',
        preset: { classId: 'class-4-2' },
        durationMs: 8000,
        narration: '教师打开教学驾驶舱，选择四年级（2）班，点击"诊断"Tab 进入诊断面板。',
      },
      {
        index: 2,
        title: '触发班级诊断',
        route: '/dashboard',
        actions: [
          { type: 'click', selector: '[data-action="trigger-diagnosis"]', description: '触发班级认知诊断' },
        ],
        durationMs: 15000,
        narration:
          'mind:diagnose Agent 启动（deepseek-v4-pro + max 思考模式），分析班级 Bloom 六维掌握度。预计 12 秒。',
      },
      {
        index: 3,
        title: '查看诊断结论',
        route: '/dashboard',
        durationMs: 12000,
        narration:
          '诊断完成：分析维度 61%，评价维度 52% 为主要盲点。《江雪》"千山鸟飞绝"对仗识别率仅 47%。',
      },
      {
        index: 4,
        title: '深入学生画像',
        route: '/grading',
        preset: { studentId: 'S024', poemId: 'poem-jiangxue' },
        durationMs: 12000,
        narration:
          '进入智能批改台，选择学生张华（S024）。mind:profile Agent 生成多维度雷达，分析维度仅 0.41，触发预警。',
      },
      {
        index: 5,
        title: '推荐路径生成',
        route: '/dashboard',
        actions: [
          { type: 'click', selector: '[data-action="recommend-path"]', description: '生成个性化推荐路径' },
        ],
        durationMs: 10000,
        narration:
          'mind:recommend Agent 基于画像生成 4 步学习路径，预计分析维度 +8%。教师一键派发至学生。',
      },
    ],
  },

  // ========== 3. creation-flow —— AI 创作与批改 ==========
  {
    id: 'creation-flow',
    title: 'AI 创作与批改',
    description: '演示命题工坊、学生答题、智能批改的完整创作闭环，含验收 Agent 二审。',
    estimatedDurationSec: 120,
    tags: ['命题工坊', '智能批改', '验收'],
    steps: [
      {
        index: 1,
        title: '进入命题工坊',
        route: '/workbench',
        preset: { poemId: 'poem-dengguanquelou' },
        durationMs: 8000,
        narration: '教师进入命题工坊，选择《登鹳雀楼》。命题 Agent 启动（deepseek-v4-pro + max）。',
      },
      {
        index: 2,
        title: 'AI 生成题目',
        route: '/workbench',
        actions: [
          { type: 'click', selector: '[data-action="generate-question"]', description: '触发命题' },
        ],
        durationMs: 15000,
        narration:
          '命题 Agent 生成"欲穷千里目，更上一层楼引申义"分析题，含评分标准与参考答案。教师审核后派发。',
      },
      {
        index: 3,
        title: '学生提交答题',
        route: '/grading',
        preset: { studentId: 'S042', poemId: 'poem-dengguanquelou' },
        durationMs: 10000,
        narration: '学生陈静（S042）提交答题，eye:vision-annotate 识别手写内容。',
      },
      {
        index: 4,
        title: '智能批改',
        route: '/grading',
        actions: [
          { type: 'click', selector: '[data-action="auto-grade"]', description: '触发自动批改' },
        ],
        durationMs: 12000,
        narration:
          'brush:grade Agent 批改：得分 7.5/10，引申义表述偏浅。生成改进建议与可视化批注。',
      },
      {
        index: 5,
        title: '验收 Agent 二审',
        route: '/grading',
        actions: [
          { type: 'click', selector: '[data-action="verify"]', description: '触发独立验收' },
        ],
        durationMs: 10000,
        narration:
          'mind:verify Agent 二审判定 pass，综合 8.7/10。优秀作品自动推送至教研沉淀层。',
      },
    ],
  },

  // ========== 4. starmap-tour —— 知识星图漫游 ==========
  {
    id: 'starmap-tour',
    title: '知识星图漫游',
    description: '演示诗脉星图的 3D 力导向可视化，展示诗人/诗篇/意象/主题的知识图谱网络。',
    estimatedDurationSec: 120,
    tags: ['知识星图', '3D 可视化', '力导向图'],
    steps: [
      {
        index: 1,
        title: '进入诗脉星图',
        route: '/starmap',
        durationMs: 8000,
        narration: '教师进入诗脉星图，3D 力导向图渲染 86 个节点、142 条边，按诗人/诗/意象/主题分色。',
      },
      {
        index: 2,
        title: '聚焦李白诗群',
        route: '/starmap',
        actions: [
          { type: 'click', selector: '[data-node-id="poet-libai"]', description: '点击李白节点' },
        ],
        durationMs: 12000,
        narration:
          '点击"李白"节点，相机平滑聚焦。展示李白创作的 5 首诗及其共享意象（月、酒、山）。',
      },
      {
        index: 3,
        title: '查看诗篇详情',
        route: '/starmap',
        actions: [
          { type: 'click', selector: '[data-node-id="poem-wanglushanpuba"]', description: '点击《望庐山瀑布》节点' },
        ],
        durationMs: 12000,
        narration:
          '点击《望庐山瀑布》节点，右侧面板展示全文、作者、朝代、修辞（夸张）、共享意象（瀑布、山）。',
      },
      {
        index: 4,
        title: '探索同修辞关联',
        route: '/starmap',
        actions: [
          { type: 'click', selector: '[data-action="filter-by-rhetoric"]', description: '按修辞"夸张"过滤' },
        ],
        durationMs: 12000,
        narration:
          '按修辞"夸张"过滤，高亮 8 首同修辞诗篇，形成跨朝代、跨作者的修辞主题网络。',
      },
      {
        index: 5,
        title: '查看掌握度着色',
        route: '/starmap',
        actions: [
          { type: 'click', selector: '[data-action="toggle-mastery"]', description: '切换掌握度着色' },
        ],
        durationMs: 10000,
        narration:
          '切换掌握度着色，已掌握（绿）/ 高阶薄弱（琥珀）/ 记忆层卡顿（赤陶）/ 未学习（灰）。',
      },
    ],
  },

  // ========== 5. evolution-showcase —— 自进化演示 ==========
  {
    id: 'evolution-showcase',
    title: '自进化演示',
    description: '演示系统的自我进化能力：A/B 测试、reward 计算、策略记忆、prompt 版本管理。',
    estimatedDurationSec: 120,
    tags: ['自我进化', 'A/B 测试', 'Prompt 版本'],
    steps: [
      {
        index: 1,
        title: '进入 AI 副驾',
        route: '/ai-copilot',
        durationMs: 8000,
        narration: '教师进入 AI 副驾，查看进化引擎后台面板。',
      },
      {
        index: 2,
        title: '查看 A/B 测试',
        route: '/ai-copilot',
        actions: [
          { type: 'click', selector: '[data-tab="ab-tests"]', description: '切换到 A/B 测试 Tab' },
        ],
        durationMs: 12000,
        narration:
          '当前运行 3 个 A/B 测试：命题 prompt v2.1 vs v2.2，批改 prompt v1.8 vs v1.9，诊断 prompt v3.0 vs v3.1。',
      },
      {
        index: 3,
        title: '查看 reward 计算',
        route: '/ai-copilot',
        actions: [
          { type: 'click', selector: '[data-tab="reward"]', description: '切换到 reward Tab' },
        ],
        durationMs: 12000,
        narration:
          'reward 计算器综合 3 维度：教师反馈（good/bad/correction）40%、验收通过率 35%、学生掌握度提升 25%。',
      },
      {
        index: 4,
        title: '策略记忆',
        route: '/ai-copilot',
        actions: [
          { type: 'click', selector: '[data-tab="strategic-memory"]', description: '切换到策略记忆' },
        ],
        durationMs: 12000,
        narration:
          '策略记忆 Agent 记录"在三年级使用「羁旅之愁」类抽象词时通过率仅 62%"，自动生成改进建议。',
      },
      {
        index: 5,
        title: 'Prompt 版本发布',
        route: '/ai-copilot',
        actions: [
          { type: 'click', selector: '[data-action="publish-prompt"]', description: '发布新版本 prompt' },
        ],
        durationMs: 10000,
        narration:
          'supervisor-verifier Agent 二审通过后，命题 prompt v2.3 发布到灰度（10% 流量），观察 7 日后全量。',
      },
    ],
  },

  // ========== 6. full-journey —— 全流程贯通 ==========
  {
    id: 'full-journey',
    title: '全流程贯通',
    description: '5 分钟完整演示从备课到教研沉淀的全链路，覆盖所有核心功能。',
    estimatedDurationSec: 300,
    tags: ['全流程', '备课', '授课', '批改', '教研'],
    composedFrom: ['classroom-immersive', 'diagnosis-persona', 'creation-flow'],
    steps: [
      {
        index: 1,
        title: '驾驶舱总览',
        route: '/dashboard',
        preset: { classId: 'class-3-1' },
        durationMs: 12000,
        narration: '从教学驾驶舱开始，总览本周教学概况：完成 5 节课、累计学生互动 216 次、AI 辅助调用 47 次。',
      },
      {
        index: 2,
        title: '教案工坊',
        route: '/lesson-plan',
        preset: { poemId: 'poem-jiangxue', classId: 'class-3-1' },
        durationMs: 15000,
        narration: '进入教案工坊，AI 辅助生成《江雪》教案：教学目标、重难点、6 级活动设计、资源推荐。',
      },
      {
        index: 3,
        title: '命题工坊',
        route: '/workbench',
        preset: { poemId: 'poem-jiangxue' },
        durationMs: 15000,
        narration: '进入命题工坊，AI 生成《江雪》意象分析题 6 道，覆盖识记/理解/分析/创造四个维度。',
      },
      {
        index: 4,
        title: '课堂导播',
        route: '/classroom',
        preset: { classId: 'class-3-1', poemId: 'poem-jiangxue', classroomMode: 'six-level' },
        durationMs: 20000,
        narration: '进入课堂导播，启动 6 级沉浸模式。学生朗读、AI 识别、即时反馈、创造输出全流程可视化。',
      },
      {
        index: 5,
        title: '智能批改',
        route: '/grading',
        preset: { classId: 'class-3-1' },
        durationMs: 15000,
        narration: '进入智能批改台，36 份学生作业自动批改，含 OCR 识别 + 智能评分 + 批注生成。',
      },
      {
        index: 6,
        title: '诗脉星图',
        route: '/starmap',
        durationMs: 12000,
        narration: '进入诗脉星图，查看《江雪》在知识图谱中的位置：柳宗元 → 唐 → 雪/孤独 → 五言绝句。',
      },
      {
        index: 7,
        title: '文化语境',
        route: '/culture',
        preset: { poemId: 'poem-jiangxue' },
        durationMs: 12000,
        narration: '进入文化语境，展示《江雪》的沉浸式场景：群山覆雪、孤舟独钓、配乐古琴曲。',
      },
      {
        index: 8,
        title: '教研报告',
        route: '/report',
        actions: [
          { type: 'click', selector: '[data-action="generate-report"]', description: '生成教研周报' },
        ],
        durationMs: 15000,
        narration: '进入教研报告，AI 自动生成周报：完成课时、班级进步、亮点案例、待改进项。',
      },
      {
        index: 9,
        title: 'AI 副驾',
        route: '/ai-copilot',
        durationMs: 12000,
        narration: '最后进入 AI 副驾，查看本周 Agent 健康度、自进化进展、A/B 测试结果。完成全流程贯通。',
      },
    ],
  },
]

// ─────────────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────────────

/** 按 ID 查找剧本 */
export function findScript(id: string): DemoScript | undefined {
  return DEMO_SCRIPTS.find((s) => s.id === id)
}

/** 获取所有剧本 ID */
export function getScriptIds(): string[] {
  return DEMO_SCRIPTS.map((s) => s.id)
}

/** 计算剧本总时长（ms） */
export function getTotalDurationMs(script: DemoScript): number {
  return script.steps.reduce((sum, step) => sum + step.durationMs, 0)
}

/** 格式化时长（秒 → mm:ss） */
export function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
