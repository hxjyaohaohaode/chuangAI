# 古诗内容逐首验收

`poem-review-register-latest.csv` 由 `node scripts/audit-poem-provenance.mjs` 按当前运行时 148 首诗自动生成。它是待填写的审核工作表，不是“已经验证”的证明。

每首诗的放行要求：

1. `catalog_scope` 明确填写 `TEXTBOOK_CORE` 或 `EXTENDED`，不能用收录总量替代教材口径；
2. 两个彼此独立的 HTTPS 机构信源，至少一个为 L1 最高权威来源；不得把同一机构的不同页面或子域名当作两个来源，且 URL 不得带账号、密码或异常端口；
3. 具备小学语文教学经验的匿名验收人给出 `PASS`，验收日期不得早于两个信源的访问日期；线下证据位置必须使用不含个人信息的 `offline-vault/<编号>`；
4. `content_sha256` 必须与当前代码一致，任何原文、作者或朝代变化都会令旧复核自动变为 `STALE`；
5. 教师逐首复核后运行以下命令；只有 148 行全部匹配当前代码哈希并达到 VERIFIED，才会生成运行时登记。已有文件必须显式加 `--replace`，避免误覆盖：

   ```powershell
   node scripts/compile-poem-provenance.mjs --input evidence/content/poem-review-register-latest.csv --out backend/src/data/poem-provenance.json --replace
   corepack pnpm --dir backend run build
   node scripts/audit-poem-provenance.mjs
   ```

   编译器还会拒绝不存在的日历日期、重复诗篇登记、过期内容哈希、同一机构的“伪双信源”和未含 L1 的双 L2 记录。不得批量伪造相同证据或用内部研究笔记代替外部信源。

未完成前，API 与前端会显示“原文待逐首复核”，LIVE 赛前门应保持失败。
