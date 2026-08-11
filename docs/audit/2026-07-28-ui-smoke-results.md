# 全界面冒烟与视觉巡检（2026-07-28）

## 自动化结果

- 生产集成地址：`http://127.0.0.1:3001`
- 视口：桌面 1440×900、移动 390×844
- 路由：15 个
- 组合：30 个
- 警告：0
- 失败：0

机器可读结果：`frontend/e2e-screenshots/regression/results.json`

回归脚本：`frontend/e2e-regression.mjs`

## 每个组合的硬断言

- 未登录访问受保护路由会进入登录页。
- 演示教师账号可完成登录。
- 页面标题与目标业务标记存在。
- `<main>` 可见且文本非空。
- 页面级横向溢出为 0。
- 无 `console.error`、`pageerror`、请求失败。
- 无未预期 HTTP 4xx/5xx。
- 生产深层路由可直接刷新。
- 登录会话刷新后仍可恢复。
- 桌面和移动截图均落盘。

## 覆盖路由

`/dashboard`、`/starmap`、`/diagnosis`、`/lesson-plan`、`/workbench`、`/classroom`、`/grading`、`/ai-copilot`、`/evolution-eye`、`/thinking-palace`、`/culture`、`/report`、`/privacy`、`/forbidden`、未知路由。

`/diagnosis` 按产品设计重定向到驾驶舱诊断页签，因此验证最终路径 `/dashboard`。

## 视觉巡检结论

### 通过项

- 桌面端整体视觉语言一致：暖色纸张质感、铜金强调色、无明显组件漂移。
- 移动端各核心页面可形成单列阅读流，无页面级横向溢出。
- 403/404 页面具有明确恢复路径。
- 课堂、文化、星图、驾驶舱首屏具有强识别度，适合演示视频。
- 批改页空状态明确说明“上传答题图片后显示统计”，不是无反馈白屏。

### 需要继续关注

- 移动端顶部品牌文字会截断，但未与操作图标重叠；需在真机上确认可接受。
- 教案桌面首屏右侧留白较大，属于编辑工作区布局；需要用真实生成流程截图验证信息平衡。
- 星图、进化之眼、思考宫殿依赖 WebGL/动画；本轮只在 Chromium 软件环境验证，未覆盖低端安卓、Safari 与无 WebGL。
- 后续生产 E2E 已补充首焦点跳转主内容，以及设置对话框的初始焦点、正反向焦点循环、Escape 关闭和焦点归还；仍未完成全站完整 Tab 顺序、屏幕阅读器实机朗读与键盘拖拽审计。
- 截图只覆盖各页稳定首屏，没有穷举所有弹窗、错误态、加载态、编辑态与长列表极限态。

## 截图

- 桌面总览：`frontend/e2e-screenshots/regression/desktop-montage.jpg`
- 移动总览：`frontend/e2e-screenshots/regression/mobile-montage.jpg`
- 30 张原图：`frontend/e2e-screenshots/regression/`

## 本轮发现并修复

1. 课堂首屏先用 `poem-jingyesi` 演示主键请求真实题库，造成必现瞬时 404；改为等待后端规范诗目 ID。
2. 页面无 favicon，浏览器产生静态资源 404；新增 SVG favicon。
3. 生产刷新 `/dashboard` 等深层路由原先 404；增加只对 HTML GET/HEAD 生效的 SPA fallback，未知 API 与 uploads 仍真实返回 404。
4. 原 `e2e-verify.mjs` 不登录、包含不存在的 `/self-study`，并会把功能失败打印后仍以 0 退出；已删除并由严格回归替代。
