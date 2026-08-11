# 服务端教师认证边界审查与验证

生成日期：2026-08-04

## 结论

原有 `localStorage.isAuthenticated` 只属于界面状态，不能构成身份认证。现已把在线
身份真相源迁移到 Fastify：218 条 HTTP 端点与 1 条 WebSocket 声明均处在服务器
会话边界内，只有健康摘要、认证状态和登录端点公开。默认 demo 模式仍是竞赛公开
演示档案，不应被表述为现实学校教师身份认证。

## 已落地控制

1. HMAC-SHA256 签名会话，`pr_session` 使用 HttpOnly、SameSite=Strict、Path=/；
   `AUTH_COOKIE_SECURE=true` 支持 HTTPS 反代。
2. demo 模式只接受一个服务器白名单档案；password 模式使用 scrypt 摘要，禁止
   仓库保存明文密码。
3. 写请求要求签名会话内 CSRF、可读 CSRF Cookie 和 `X-CSRF-Token` 三者相同；
   显式 Origin 不在同源/CORS 白名单时直接 403。
   允许 Origin 只在启动时由配置固定，客户端可控的 `Host` 和
   `X-Forwarded-Proto` 绝不能扩大此集合。
4. 请求查询或 JSON 顶层的 `teacherId` 与会话主体不一致时 403；请求处理器不再能
   仅凭浏览器 localStorage 切换在线主体。
5. 密码失败按来源 IP 进程内限速；注销记录当前进程撤销；会话过期、签名篡改、
   服务临时密钥重启全部失败关闭。
6. 非回环监听只有“密码认证 + Secure Cookie”或显式受控容器内边界两条路径；
   其他配置在数据库初始化前拒绝启动。
7. 前端启动时必须调用 `/api/auth/status` 验证 HttpOnly 会话；验证失败清除本地
   缓存。401 回登录页，403 才进入权限说明页；权限页不能再任意修改教师工号。
8. SSE、上传、二进制下载和普通 JSON 调用统一经过会话/CSRF fetch 边界；浏览器
   WebSocket 自动携带同源 Cookie。
9. 数据模型明确收敛为单教师本地租户：所有 `teacher_id/owner_id` 表启动扫描，
   第二主体失败关闭；编排/副驾会话控制在副作用前回查签名会话主体。

## 当前验证证据

| 层级 | 当前结果 | 证据 |
| --- | --- | --- |
| 认证单元/注入测试 | demo 白名单、密码 scrypt、伪造签名、过期、临时密钥重启、CSRF、Origin、伪造 Host/X-Forwarded-Proto、teacherId 错配、限速、注销全部通过 | `backend/src/security/auth.test.ts` |
| 全后端测试 | 50 文件、612/612 通过 | 本轮 `pnpm test` 输出 |
| 覆盖率 | 已配置关键范围：语句 97.04%、分支 76.70%、函数 97.32%、行 97.49% | 本轮 `pnpm test:coverage` 输出 |
| HTTP | 218 条声明分层验证：210 主业务、5 长期记忆、3 认证；0 运行时失败 | `runtime-endpoint-verification-latest.json` |
| WebSocket | 无会话 401；有效会话握手、session:start、ping/pong 通过 | `websocket-smoke-latest.json` |
| 业务闭环 | 签名会话下课堂创建、作答、事件、热点、趋势、结束、报告、SPA/CSP/404 通过 | `closed-loop-latest.json` |
| 浏览器 | 运行期随机一次性密码/scrypt 登录、刷新恢复、认证状态 503 失败关闭、生成 WebP 与 TTS 未认证 401；认证 TTS 返回私密非空 RIFF/WAV 并转成播放器 Blob URL；32 页面/视口组合 0 警告/0 失败 | `production-e2e-latest.json` |
| API 契约 | 前端 210、后端 219、匹配 210、缺失 0、方法错配 0 | `api-contract-latest.json` |

## 不能夸大的剩余边界

- demo 登录只证明“服务器允许了一个公开演示主体”，不能证明操作者是王雅琴等
  现实个人；正式部署必须使用密码模式或学校 OIDC/统一身份源。
- 当前正式密码模式是单教师配置，混租户数据库会拒绝启动。这能阻断当前构建的
  横向数据暴露，但不是完整多租户 RBAC；学校多教师上线前仍须引入 tenant 主数据、
  每类资源的对象授权与迁移/渗透测试，不能简单关闭单租户门禁。
- 注销撤销与登录限速是单进程内存状态。多实例部署需要 Redis/数据库会话撤销、
  集中限速、审计告警和密钥轮换机制。
- CSRF 不能抵御同源 XSS。现有 CSP、输入验证和无 `dangerouslySetInnerHTML` 约束仍
  必须持续；任何新增富文本/第三方脚本都要重做威胁审查。
- TLS、反向代理头可信范围、WAF、学校数据处理协议、备份加密和渗透测试属于外部
  部署控制，不能由当前单机自动化结果替代。

上述边界保持明确，能够避免把“新增了登录页”或“测试全绿”误表述成完整学校级
零信任安全。架构决策与故障模式详见 `docs/adr/0001-server-authentication-boundary.md`。
