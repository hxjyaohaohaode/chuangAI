# 业务闭环回归（2026-07-28）

## 已固化的主闭环

`健康检查 → 解析班级/脱敏学生 → 解析真实诗目 → 六阶就绪校验 → 创建课堂 → 获取脱敏题目 → 提交作答 → 更新参与状态 → 下一题 → 结束课堂 → 生成报告 → 再次读取报告`

运行命令：

```powershell
cd backend
pnpm run test:closed-loop
```

默认目标：`http://127.0.0.1:3001`。可用 `CLOSED_LOOP_BASE_URL` 覆盖。

## 最后一次结果

- 状态：passed
- 课堂：每次运行生成新 ID；最后结果以 `closed-loop-latest.json` 为准
- 班级：`class-001`
- 脱敏学生：`class001-student-S01`
- 诗目：`tongbian-001`
- 六阶覆盖：记忆/理解/应用/分析/评价/创造各 1 题
- 课堂报告：结束后可重复读取
- SPA 深链：通过
- CSP：存在
- 未知 API：404

机器证据：`docs/audit/closed-loop-latest.json`

## 隐私与契约断言

- 发给前端的课堂题目不得包含 `answer`。
- 前端传入伪造真实姓名时，课堂状态响应不得出现该姓名。
- 学生从后端脱敏学生列表解析，不使用任意前端字符串作为广播名。
- `/api/...` 未知路径不能被生产 SPA fallback 掩盖。

## 人工补充复核

另一次《静夜思》闭环已直接查询 SQLite：

- lesson 状态为 `completed`。
- `started_at`、`ended_at`、`classroomReport` 已持久化。
- answer 从 `needs_human_review=1` 经异步讲评回填为 `graded_by=ai`、`needs_human_review=0`。
- 课堂报告记录参与度、掌握度前后值、亮点与改进项。

## 尚未闭合的链路

- OCR 图片上传 → 识别 → 批改 → 教师复核 → 错题本 → 诊断的真实图片全链路。
- 麦克风录音 → MiMo ASR/TTS → 评分 → 删除与保留期限。
- Wan 在线生图 → 下载落盘 → AI 标识 → 失败重试。
- Neo4j 在线模式与 SQLite 降级模式的一致性。
- 30–40 人并发 WebSocket、断线重连、顺序保证与背压。
- DeepSeek/MiMo/Wan 真实密钥、配额、超时、费用和服务协议。

这些依赖外部账号、硬件、真实样本或负载环境，当前不能以 DEMO_MODE 的模板降级替代真实验收。
