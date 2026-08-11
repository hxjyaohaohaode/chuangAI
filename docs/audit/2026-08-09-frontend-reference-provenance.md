# 前端参考组件来源与发布边界复核（2026-08-09）

> 范围：`C:\Users\LENOVO\Nutstore\1\创AI\优质前端部件组` 与当前
> `frontend/src/components/ui`。这是工程和证据审计，不是法律意见；它禁止将
> 缺失证据包装为“已获许可”。

## 结论

此前“本地参考目录等同于 React Bits、统一适用 MIT + Commons Clause”的叙述
**没有充分证据支持，已撤销**。本地目录只有 45 个 Markdown 文档，根目录未见
`LICENSE`、`NOTICE` 或不可变上游提交号；抽样和逐文件头部核验显示它混合引用了
CodePen、Animate UI、GitHub、图片服务和未署名示例。公开可见不等于获得可再分发
代码的许可证。

经本轮独立重写与删除，当前 `frontend/src/components/ui` 对照该本地混合参考目录的
**来源待闭合项为 0**。这只闭合当前已识别的生产组件，不为本地参考目录建立统一
许可证，也不授权未来复制或改编其中代码。后续如新增来自该目录的代码，提交源代码、
公开仓库或扩展为收费/面向更广范围的发布前，必须针对每一项选择：

1. 固定上游 URL、提交哈希、完整许可证和必要署名，并验证使用与分发方式相容；
2. 取得权利人的明确书面许可；或
3. 删除或以独立设计、独立代码重写该组件，并进行功能和无障碍回归。

## 已完成的风险削减

评分页实际可见的 `CardSwap`、`PixelTransition`、`StackGallery`、`GlowBorder`、驾驶舱的 `TextPressure`、多个 AI 页面共享的 `StreamText`、多页标题的 `VariableProximity`、报告页的 `ScrollReveal` 与报告预览边缘的 `GradualBlur` 已在 2026-08-09
改为独立 React/CSS 实现：不再导入 GSAP，不再使用本地参考实现，只保留本项目
自己的产品行为契约。生产 E2E 已在受控“上传→识别→批改”流中验证 CardSwap 的
具名暂停、Space 恢复、暂停位姿冻结、减弱动态静止和 390×844 窄屏几何；验证
PixelTransition 的具名切换、Enter/Space 与悬停渐进增强；验证 StackGallery 的原生
按钮、自动轮换暂停、拖拽后点击抑制、大图焦点闭环、媒体失败非空终态和窄屏几何；
验证 GlowBorder 在评分结果、错误说明和星图详情的保留内容层、令牌化色调与减弱动态
静态降级；验证 TextPressure 不再注册全局输入监听或加载外部字体，且驾驶舱生产
页面继续在 32 组生产同源回归中无警告、无失败地渲染；验证 StreamText 用本地 React
状态游标保留真实增量内容、暂停/继续、一次性完成回调、结构化文本与减弱动态全文显示，
不再使用 GSAP、DOM 查询或全局输入监听；验证 VariableProximity 不再注册全局鼠标/触摸监听或永久 RAF 循环，仅在本组件有鼠标/笔指针悬停时计算文字距离，触摸与减弱动态维持静态，同时保留可点击实例的键盘激活语义；验证 ScrollReveal 不再绑定 GSAP ScrollTrigger，使用一次性、可清理的 IntersectionObserver，且浏览器不能增强时默认保留全文可见；验证 GradualBlur 仅作为 `aria-hidden` 的非拦截遮罩，移除全局 resize/debounce 路径，并在不支持 backdrop-filter 时改为低对比度渐变；验证 ElectricBorder 不再保留 Canvas、噪声算法、全局监听或逐帧 JavaScript 绘制，空实例为不拦截交互的装饰层，触屏与减弱动态均退化为静态轮廓；验证 FallingText 不再写入 `innerHTML` 或加载 Matter.js/Canvas/持续物理循环，文本先以 React 词级内容呈现，自动、滚动、悬停和点击只触发有限 CSS 入场，点击实例保留键盘 Enter/Space，减弱动态、触屏和强制配色保留完整静态标题；验证 MasonryGrid 不再加载 GSAP、不再随机动画方向或向 `document.head` 注入样式，首屏直接使用确定性 CSS Grid，`columns` 作为桌面最大列数并在 390px 自动退为完整单列，卡片保留 `list/listitem` 语义，减弱动态与不支持观察器时均保持内容可见；验证 StarfieldBackground 不再加载 OGL/WebGL、不生成 Canvas、不绑定全局事件或持续 RAF，403/404 仅使用 `aria-hidden`、不接收指针的有限 CSS 星野，桌面和手机均覆盖所属错误页，减弱动态与强制配色保留静态/隐藏兜底；验证 MagicRings 不再使用 ResizeObserver、尺寸状态或运行时 path 拼装，百分比 SVG `rect` 自动适应容器并转发 HTML/ARIA 属性，减弱动态、触屏和强制配色使用完整静态轮廓；验证 Radar 不再加载 OGL/WebGL、不创建 Canvas、不注入运行时样式、不注册 resize/指针监听或执行 RAF，诊断页只保留四层确定性 CSS 装饰，纯黑背景继续兼容透明语义，`color-mix()` 失败时回退为 `currentColor` 静态图形，非减弱动态仅扫描两轮，减弱动态、粗指针、打印与强制配色均有静态兜底。生产浏览器回归已验证 240px 桌面与 160px 手机几何、装饰语义、无横向溢出和无 OGL 资源；
验证 MagicBento 以确定性的 React/CSS 卡片、装饰星点和原生链接替代运行时粒子，不再使用 GSAP、Canvas/WebGL、RAF 或全局 DOM 变更，并覆盖键盘、新标签页、图片失败、减弱动态、触屏、强制配色与打印契约；验证 PixelSnow 以有数量上限的确定性 CSS 雪景装饰替代 Three.js/Shader/Canvas/WebGL，不再使用 RAF、观察器或随机运行时，非冬景不挂载，减弱动态与粗指针保持静态，强制配色和打印隐藏纯装饰层；验证 TextSwitch 使用整段文本 React/CSS 状态机，不再使用 GSAP、Canvas、RAF、`setInterval` 或逐字符 DOM，仅保留一个可清理的轮换超时，并覆盖原生按钮、方向键/Home/End、焦点/悬停/显式暂停、真实离屏暂停、减弱动态、强制配色与打印契约。上述三项专项回归只证明受控前端行为、资源和降级契约，不证明教学效果、内容真实性或比赛结果；
SphereGallery 已在 2026-08-10 改为独立的原生 DOM/CSS `scroll-snap` 图片画廊，以 React Portal 提供模态预览，不再使用 Three.js、WebGL、Canvas、RAF、定时器或随机运行时。`docs/audit/production-e2e-latest.json` 已记录 LessonPlan 图片模板与 StarMap 诗歌节点两条业务专项为 `checked: true`，同时记录 SphereGallery 与项目专用 StarMapDome 消费层没有 Three.js/WebGL/Canvas/RAF 路径或 `three-vendor` 资源请求。该生成物的 32 个路由/视口组合、0 warnings、0 failures 只证明文件中逐项列出的受控前端行为、无障碍、几何、失败恢复和资源边界，不证明图片或知识图谱来源真实性、教学效果、真实后端可用性、未测浏览器 GPU 行为或比赛结果。StarMapDome 不属于本地混合参考目录的来源索引，因此不虚构为第二十项外部来源组件；
PixelCard 经全仓调用检索确认没有任何生产 JSX 实例，却会因 barrel 导出在入口启动时注入全局 CSS，并保留 Canvas/RAF、无动作焦点和非法 gap 死循环风险，已连同导出与 Report 页无消费者死样式删除；ShapeBlur 同样没有生产 JSX 实例，却从 barrel 暴露并保留 Three/WebGL、全局指针监听与减弱动态下持续 RAF，已连同导出、组件样式和 StarMap 孤儿样式删除。十九项独立重写与两项无使用删除，共二十一项已从待核验列表移除；
这**不会**为本地参考目录建立统一许可证，也不会替未来新增或未列入本索引的组件自动消除来源风险。

## 本地参考文件证据索引

下表的“关联”只说明当前组件注释或名称与本地资料的对应关系；它**不是**对
最初作者、上游仓库或许可证的推定。SHA-256 固定的是本机参考文件内容，便于
后续复核是否发生静默替换。

| 当前组件 | 本地参考文档 | SHA-256 | 当前状态 |
|---|---|---|---|
| `ElectricBorder` | `8_卡片周边特效.md` | `1b28de2d5e87991d6ca7d8bf95d187372c837873d685c1a9e38d40b634eeb970` | 已独立重写（2026-08-09）：原生 CSS 装饰层，不纳入待核验项 |
| `FallingText` | `3_重力文字.md` | `72cf5e430b14540a3bdd01c0adb62c87891b6fa61714a87a37a3adf6a63bbd45` | 已独立重写（2026-08-09）：React 词级内容 + 有限 CSS 入场，不纳入待核验项 |
| `GlowBorder` | `32_组件边框光韵.md` | `8823f8d4ce73651650decc9f78cbae1328d74905ffac5ee4a94019b250ad26cd` | 已独立重写（2026-08-09），不纳入待核验项 |
| `GradualBlur` | `13_模糊边界显示.md` | `1ad3899cbe2255d31158b34c848ad7a80799ccd05c02b4ebdf7ab333701dc4f4` | 已独立重写（2026-08-09），不纳入待核验项 |
| `MagicBento` | `21_选项显示光韵.md` | `5854bbad7459df594290c858a08ec53235cec87c46099d05dd0e59e55dc122bd` | 已独立重写（2026-08-10）：确定性 React/CSS 卡片 + 原生链接，无 GSAP、Canvas/WebGL、RAF 或全局 DOM 变更，不纳入待核验项 |
| `MagicRings` | `11_神奇圆圈环.md` | `86dbbc000953a649e7f515df4c059f3445d8e25c251a26946ccb248c434908e2` | 已独立重写（2026-08-10）：零测量 SVG rect 装饰轮廓，不纳入待核验项 |
| `MasonryGrid` | `25_瀑布流展示图片.md` | `5db12b187a8c9812cd909a221687a0431d206d99c24761f8abf6ac489367b0fe` | 已独立重写（2026-08-10）：确定性 CSS Grid + 有限入场增强，不纳入待核验项 |
| `PixelCard` | `30_卡片的白色福彩.md` | `8e6f8fd25702fb7e10d70950463de9da454fe9507ff9a0524c0e0e117a5b328d` | 已删除（2026-08-10）：无生产调用，连同 barrel 导出及 Report 页死样式移除 |
| `PixelSnow` | `41_落雪一样的背景.md` | `6e47b8153f8c13f7539c885d14aea0c97bc41e68a406273698556a35c3cef19b` | 已独立重写（2026-08-10）：有上限的确定性 CSS 装饰，无 Three.js/Shader/Canvas/WebGL、RAF、观察器或随机运行时，不纳入待核验项 |
| `PixelTransition` | `10_图片蒙版显示.md` | `176b454865daff0d826e6c997020a877f8cc3ee9252af70965183b5bf7319416` | 已独立重写（2026-08-09），不纳入待核验项 |
| `Radar` | `39_雷达.md` | `2177ad2d753f653ca7cc9b078d1ed7398195fd2d5a74a4877c24a04621ec4afc` | 已独立重写（2026-08-10）：无 Canvas/WebGL/RAF 的有限 CSS 扫描装饰，不纳入待核验项 |
| `ScrollReveal` | `5_文本旋转显示.md` | `53d364203c4438205ebdbbde296c7f8094742af7d9b46af54d4a4abe8a633bc3` | 已独立重写（2026-08-09），不纳入待核验项 |
| `ShapeBlur` | `15_涣散组件.md` | `d64cd84d01d8aa0b8079ce91f853af743492fb1183e6bbe6303cab1a3ac37834` | 已删除（2026-08-10）：无生产调用，连同 barrel 导出、组件 CSS 与 StarMap 孤儿样式移除 |
| `SphereGallery` | `26_球面展示图像.md` | `f57cfab136ed73fb2f79aa92b6730f42538fcdd8a3601fa4b900bdb48fe54e6f` | 已独立重写（2026-08-10）：原生 DOM/CSS `scroll-snap` + React Portal 模态预览，无 Three.js/WebGL/Canvas、RAF、定时器或随机运行时；LessonPlan 与 StarMapDome 两条受控业务专项及轻量资源边界在最新生产 E2E 证据中为 `checked: true`；不纳入待核验项 |
| `StackGallery` | `23_类微信图像重叠显示.md` | `02c46750758166c0195a6ac0b836fff99ca7149ebbef9fa1cf4d865ff69be350` | 已独立重写（2026-08-09），不纳入待核验项 |
| `StarfieldBackground` | `40_星空背景.md` | `d82b1b7924140f4b2928abbc21ee4a24411c8a55b5e68bde7d86859011b2e5e6` | 已独立重写（2026-08-10）：无 Canvas/WebGL 的有限 CSS 星野，不纳入待核验项 |
| `StreamText` | `4_文本流式显示.md` | `966de9c2b3eebb71ab67283eb47f9038c67435e71dcbbbc1c879a06b7f0fcd80` | 已独立重写（2026-08-09），不纳入待核验项 |
| `TextPressure` | `2_文本压力.md` | `1d4b81ba0df73972c55d427db222560074eb3057deb64ec70a16934182cb2f26` | 已独立重写（2026-08-09），不纳入待核验项 |
| `TextSwitch` | `6_文本切换.md` | `8ee22f2245b21c5ea0436fe6a26952a48728e7cd54bfefe7bf76ec58f932b1ee` | 已独立重写（2026-08-10）：整段文本 React/CSS 状态机，无 GSAP、Canvas、RAF、`setInterval` 或逐字符 DOM，不纳入待核验项 |
| `VariableProximity` | `7_文本显示粗化.md` | `be8e1b7093f576e269fa01e2cba69d6f6f99704f67f105fc327a243267854635` | 已独立重写（2026-08-09），不纳入待核验项 |

## 已核验的外部条款与其边界

- GSAP 3.15 的已安装包和官方 Standard License 页面均指向同一条款。该条款
  允许网站、Web 应用与商业项目使用；禁止边界集中在利用 GSAP 构建与 Webflow
  视觉动画能力竞争的无代码可视化动画工具，以及移除专有声明等行为。本项目只在
  `import.meta.env.DEV` 保护的视觉组件演示页使用 GSAP，不提供动画创作器；因此
  GSAP 已移至 `devDependencies`，不会进入生产依赖许可证清单。条款来源、适用
  范围和仍需负责人确认的边界见 `docs/audit/2026-08-11-package-license-review.md`。
- Sharp 在本机 Windows x64 安装树中出现 `@img/sharp-win32-x64@0.35.3`，npm
  元数据声明 `Apache-2.0 AND LGPL-3.0-or-later`。Docker 编排使用 Alpine，实际
  目标安装会选择不同平台二进制；因此必须在目标镜像中重新生成许可证清单，不能
  用本机 Windows 结果替代。
- React Bits 的当前公开许可证确为“MIT + Commons Clause”，但这只能证明其
  当前上游条款，**不能反向证明**本地混合资料中的每个样例都来自 React Bits。

## 发布门槛与回退

| 场景 | 必须满足 | 不满足时的回退 |
|---|---|---|
| 本机比赛演示 | 仅展示 `docs/audit/production-e2e-latest.json` 中仍为 `checked: true` 且聚合结果保持 0 warnings、0 failures 的受控功能；保留 NOTICE、本审计记录及每项 `testDataBoundary`，不得把受控前端回归包装成真实教学、内容来源或比赛结果证据 | 证据缺失、过期或失败时隐藏非核心画廊增强，退回静态、普通 CSS 图片列表，并重新执行正式生产回归 |
| 提交源代码/公开仓库 | 当前来源待闭合项维持为 0；目标平台重跑生产许可证与 Sharp 审计；任何新增参考代码逐件闭合来源或独立重写/删除 | 仅提交经许可或独立实现的最小代码包，暂不公开新增的未闭合组件 |
| 收费、SaaS 或大范围分发 | 上述所有条件；若产品未来提供可视化无代码动画构建能力，必须重新核对 GSAP 与 Webflow 竞争边界并由负责人签署 | 移除相关开发演示依赖、改用许可边界明确的实现，或取得书面许可 |

该记录将由 `scripts/audit-production-licenses.mjs` 写入 JSON 的
`sourceReviewGuidance` 字段并由 `THIRD_PARTY_NOTICES.md` 链接。当前
`sourceAttributions` 为空，因此生产许可证审计不再因本地混合来源组件强制加入
`sourceLicenseReview`；但依赖许可证、缺失声明或其他人工复核项仍可使结果保持
`passed_with_review`，来源项归零不得被包装为整体许可证审计完全通过。
