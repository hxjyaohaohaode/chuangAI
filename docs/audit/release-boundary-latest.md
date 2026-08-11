# 发布边界与敏感文件审计

- 状态：**passed_with_local_sensitive_exclusions**
- 可进入发布候选：1472 个文件
- 必须排除：44 个文件
- 发布候选密钥命中：0
- 本地排除文件中的敏感命中：3
- 符号链接/重解析链接：0

> 本报告只记录文件路径、行号和检测器名称，绝不写出密钥值。被排除的本地 `.env`、日志和数据库可以用于开发，但不得复制进参赛包或开源包。

## 发布候选命中

- 无

## 必须排除的本地文件

- backend/.env — environment-secret-file — 651B
- backend/.runtime/backend.err.log — runtime-log — 0B
- backend/.runtime/backend.out.log — runtime-log — 984930B
- backend/backend-runtime-error.log — runtime-log — 113B
- backend/backend-runtime.err.log — runtime-log — 0B
- backend/backend-runtime.log — runtime-log — 117176B
- backend/backend-runtime.out.log — runtime-log — 650047B
- backend/clean-audit.err.log — runtime-log — 1134B
- backend/clean-audit.out.log — runtime-log — 0B
- backend/extreme-audit-fixed.err.log — runtime-log — 0B
- backend/extreme-audit-fixed.out.log — runtime-log — 11871B
- backend/extreme-audit-fixed2.err.log — runtime-log — 0B
- backend/extreme-audit-fixed2.out.log — runtime-log — 863117B
- backend/extreme-audit.err.log — runtime-log — 22B
- backend/extreme-audit.out.log — runtime-log — 123630B
- backend/extreme-clean-b.err.log — runtime-log — 113B
- backend/extreme-clean-b.out.log — runtime-log — 1087B
- backend/extreme-clean-c.err.log — runtime-log — 113B
- backend/extreme-clean-c.out.log — runtime-log — 5324B
- backend/extreme-clean-d.err.log — runtime-log — 113B
- backend/extreme-clean-d.out.log — runtime-log — 4085B
- backend/extreme-clean-d2.err.log — runtime-log — 113B
- backend/extreme-clean-d2.out.log — runtime-log — 2418B
- backend/extreme-clean-d3.err.log — runtime-log — 113B
- backend/extreme-clean-d3.out.log — runtime-log — 11104B
- backend/extreme-clean-d4.err.log — runtime-log — 113B
- backend/extreme-clean-d4.out.log — runtime-log — 16034B
- backend/extreme-clean-d5.err.log — runtime-log — 113B
- backend/extreme-clean-d5.out.log — runtime-log — 1697053B
- backend/extreme-clean-d6.err.log — runtime-log — 113B
- backend/extreme-clean-d6.out.log — runtime-log — 25398B
- backend/extreme-clean-d7.err.log — runtime-log — 113B
- backend/extreme-clean-d7.out.log — runtime-log — 6409B
- backend/starmap-image-generation.err.log — runtime-log — 0B
- backend/starmap-image-generation.out.log — runtime-log — 633B
- frontend/.runtime/frontend.err.log — runtime-log — 1920B
- frontend/.runtime/frontend.out.log — runtime-log — 451B
- frontend/.runtime/vite-direct.err.log — runtime-log — 7624B
- frontend/.runtime/vite-direct.out.log — runtime-log — 20103B
- frontend/e2e-preview-2.stderr.log — runtime-log — 662B
- frontend/e2e-preview-2.stdout.log — runtime-log — 77B
- frontend/e2e-preview.stderr.log — runtime-log — 657B
- frontend/e2e-preview.stdout.log — runtime-log — 77B
- frontend/tsc_out.log — runtime-log — 504B

