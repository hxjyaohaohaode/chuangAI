# 赛场运行 SOP 与故障兜底

## T-1 天

1. 轮换所有曾出现在日志/终端的 API Key，重新测试但不截图 Key；在 `backend/.env` 写入 `CREDENTIALS_ROTATED_AFTER_AUDIT=true` 作为轮换声明。
2. 运行 `node scripts/audit-poem-provenance.mjs`，确认逐首双信源、篇目范围与教师复核均已登记；运行真实试点分析器生成 `docs/audit/pilot-evidence-latest.json`。不得手改结果文件冒充通过。
3. 依次执行 `node scripts/audit-production-dependencies.mjs`、`node scripts/audit-release-boundary.mjs` 与 `node scripts/competition-preflight.mjs --mode live --deployment local --write`；Docker 方案将 `local` 改为 `docker`，任何 FAIL 均阻断放行。
4. 在比赛机锁定文档化的 Node.js `>=20.19 <21` 与 pnpm 10.34.5 环境执行后端覆盖率、`pnpm run test:routes`、前端 lint/build/E2E；保存最新 JSON 证据。构建与 E2E 必须串行，禁止并发清理 `backend/dist`。若 E2E 启动器无日志异常退出，不得判为通过：确认 3001/5173 无残留监听和无孤儿项目进程后只重跑一次；再次异常立即切备用机，不在赛场临时修运行时。
5. 运行 `node scripts/prepare-competition-release.mjs --verify-only`，再用 `--out <项目外的 poetic-realm-release-日期目录>` 生成唯一发布包；禁止复制整个工作区，禁止把 `.env`、日志、数据库或旧包混入。
6. 在参赛电脑和一台普通备用电脑各验证一次发布包，并核对 `RELEASE-MANIFEST.sha256.json`。
7. 准备两个演示方案：A 为真实模型在线；B 为 `DEMO_MODE=true` 本地完整闭环。
8. 分开备份数据库只读副本、PPT、MP4、申报文本；校验 MP4 可离线播放和提交物 SHA-256。数据库副本不得放进公开/参赛源码包。

## T-30 分钟

1. 关闭同步盘大文件同步、系统更新、构建进程与扫描工具。
2. 启动生产后端，检查 `/api/health` 与 `/api/health/db`。
3. 按演示顺序预热：驾驶舱→教案→课堂→批改→诊断→创作→进化。
4. 打开浏览器全屏，关闭个人账号、通知和自动填充；确认无姓名/Key。
5. 网络不稳定时直接选择 B，不在台上反复赌在线模型。

## 现场切换规则

- 单次 AI 等待 8 秒无结果：口头说明“模型超时，系统保留当前内容”，切 DEMO/本地结果。
- 页面空壳超过 3 秒：刷新一次；仍失败则切到已预热标签页或 MP4 对应片段。
- WebSocket 断开：说明 REST 数据仍可查询，展示最后快照，不重复点击控制按钮。
- 数据库写失败：不继续写入；展示只读历史/导出，使用备用数据库副本重启。
- 3D 卡顿：开启 reduced motion 或切 2D 列表；核心教学解释不依赖特效。
- 跟读录音授权迟到、切换模块或关闭朗诵页：不等待后台录音；返回朗诵模块重新开始。前端会取消本次交付并回收麦克风轨道，现场只展示新的完整录音，不把半段音频反复提交识别。
- 本地图片附件缩略图失败：移除该附件后重新选择；界面已失败关闭且不会把该附件交给模型，仍可发送纯文字，不在台上反复上传同一损坏文件。
- 在线模型输出不当：立即停止生成，保留原始内容，使用教师复核/规则化样例。

## 禁止事项

- 不口述或展示未经授权的学生数据、提分率、学校名称、教师原话。
- 不把 DEMO、规则结果或模板说成“AI 实时生成”。
- 不把 148 首运行时收录量说成 148 首统编版必背；只报告逐首登记为 `TEXTBOOK_CORE` 且验收通过的数量。
- 不在现场执行安装、全量构建、覆盖率、依赖更新或密钥配置。
- 不从日常开发目录直接演示或打包；只使用受控发布包，且不覆盖旧包以免证据串包。
- 不因联网失败连续重试同一请求；这会放大限流和演示时间风险。
