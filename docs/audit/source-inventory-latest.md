# 当前源码资产台账

> 本文件由 `scripts/audit-source-inventory.mjs` 从当前工作区生成。JSON 明细包含每个文件的 SHA-256、行数、每个函数位置、每个后端端点、前端路由、API 字符串与静态风险标记。

## 汇总

| 指标 | 数量 |
|---|---:|
| sourceFiles | 643 |
| totalLines | 256308 |
| totalNonBlankLines | 230979 |
| typescriptFiles | 548 |
| cssFiles | 94 |
| sqlFiles | 1 |
| functions | 10317 |
| backendEndpoints | 220 |
| frontendRoutes | 25 |
| frontendProductionRoutes | 23 |
| frontendDevelopmentRoutes | 2 |
| frontendApiReferences | 222 |
| testDeclarations | 869 |
| findings | 552 |

生成时间：2026-09-26T19:51:39.186Z

## 后端端点（完整）

| 方法 | 完整路径 | 文件 | 行 |
|---|---|---|---:|
| POST | `/api/orchestrator/parse` | `backend/src/orchestrator/routes.ts` | 147 |
| POST | `/api/orchestrator/execute` | `backend/src/orchestrator/routes.ts` | 185 |
| POST | `/api/orchestrator/pause` | `backend/src/orchestrator/routes.ts` | 285 |
| POST | `/api/orchestrator/resume` | `backend/src/orchestrator/routes.ts` | 306 |
| POST | `/api/orchestrator/abort` | `backend/src/orchestrator/routes.ts` | 327 |
| POST | `/api/orchestrator/modify` | `backend/src/orchestrator/routes.ts` | 348 |
| GET | `/api/orchestrator/sessions/:id` | `backend/src/orchestrator/routes.ts` | 374 |
| GET | `/api/orchestrator/sessions/:id/trace` | `backend/src/orchestrator/routes.ts` | 411 |
| GET | `/api/orchestrator/sessions` | `backend/src/orchestrator/routes.ts` | 432 |
| GET | `/ws/orchestrator` | `backend/src/orchestrator/websocket/handlers.ts` | 66 |
| POST | `/api/ai/image-generate` | `backend/src/routes/ai.ts` | 276 |
| POST | `/api/ai/tts` | `backend/src/routes/ai.ts` | 358 |
| POST | `/api/ai/asr` | `backend/src/routes/ai.ts` | 399 |
| POST | `/api/ai/chat` | `backend/src/routes/ai.ts` | 566 |
| GET | `/api/appreciation/:poemId` | `backend/src/routes/appreciation.ts` | 251 |
| GET | `/api/classroom/classes` | `backend/src/routes/classroom.ts` | 625 |
| GET | `/api/classroom/readiness` | `backend/src/routes/classroom.ts` | 634 |
| POST | `/api/classroom/start` | `backend/src/routes/classroom.ts` | 659 |
| GET | `/api/classroom/:lessonId/status` | `backend/src/routes/classroom.ts` | 780 |
| PATCH | `/api/classroom/:lessonId/mode` | `backend/src/routes/classroom.ts` | 826 |
| POST | `/api/classroom/:lessonId/next` | `backend/src/routes/classroom.ts` | 863 |
| POST | `/api/classroom/:lessonId/submit` | `backend/src/routes/classroom.ts` | 907 |
| POST | `/api/classroom/:lessonId/hint` | `backend/src/routes/classroom.ts` | 1171 |
| POST | `/api/classroom/:lessonId/discuss` | `backend/src/routes/classroom.ts` | 1221 |
| GET | `/api/classroom/:lessonId/quest` | `backend/src/routes/classroom.ts` | 1280 |
| POST | `/api/classroom/:lessonId/quest/teams` | `backend/src/routes/classroom.ts` | 1294 |
| POST | `/api/classroom/:lessonId/quest/ai-turn` | `backend/src/routes/classroom.ts` | 1333 |
| POST | `/api/classroom/:lessonId/question/flag` | `backend/src/routes/classroom.ts` | 1372 |
| POST | `/api/classroom/:lessonId/question/replace` | `backend/src/routes/classroom.ts` | 1403 |
| POST | `/api/classroom/:lessonId/end` | `backend/src/routes/classroom.ts` | 1453 |
| GET | `/api/classroom/:lessonId/report` | `backend/src/routes/classroom.ts` | 1545 |
| GET | `/api/classroom/join/:joinCode` | `backend/src/routes/classroom.ts` | 1584 |
| GET | `/api/classroom/explain/:poemId` | `backend/src/routes/classroom.ts` | 1613 |
| POST | `/api/classroom/:lessonId/schedule/next` | `backend/src/routes/classroom.ts` | 1674 |
| POST | `/api/classroom/:lessonId/schedule/override` | `backend/src/routes/classroom.ts` | 1710 |
| GET | `/api/classroom/:lessonId/schedule/status` | `backend/src/routes/classroom.ts` | 1743 |
| POST | `/api/classroom/:lessonId/ai/suggest` | `backend/src/routes/classroom.ts` | 1765 |
| POST | `/api/classroom/:lessonId/ai/supplement` | `backend/src/routes/classroom.ts` | 1852 |
| POST | `/api/classroom/:lessonId/ai/followup` | `backend/src/routes/classroom.ts` | 1925 |
| POST | `/api/classroom/:lessonId/ai/intervention` | `backend/src/routes/classroom.ts` | 2007 |
| POST | `/api/classroom/:lessonId/after-action-report/generate` | `backend/src/routes/classroom.ts` | 2048 |
| GET | `/api/classroom/:lessonId/after-action-report` | `backend/src/routes/classroom.ts` | 2112 |
| POST | `/api/classroom/:lessonId/ai/mark-adopted` | `backend/src/routes/classroom.ts` | 2155 |
| POST | `/api/classroom/:lessonId/dance/start` | `backend/src/routes/classroom.ts` | 2184 |
| GET | `/api/classroom/:lessonId/dance/timeline` | `backend/src/routes/classroom.ts` | 2218 |
| POST | `/api/classroom/:lessonId/dance/event` | `backend/src/routes/classroom.ts` | 2241 |
| POST | `/api/classroom/sessions` | `backend/src/routes/classroom.ts` | 2286 |
| GET | `/api/classroom/sessions/:sessionId` | `backend/src/routes/classroom.ts` | 2399 |
| POST | `/api/classroom/sessions/:sessionId/score` | `backend/src/routes/classroom.ts` | 2441 |
| POST | `/api/classroom/sessions/:sessionId/smart-score` | `backend/src/routes/classroom.ts` | 2518 |
| POST | `/api/classroom/sessions/:sessionId/comment` | `backend/src/routes/classroom.ts` | 2749 |
| POST | `/api/classroom/sessions/:sessionId/virtual-opponent` | `backend/src/routes/classroom.ts` | 2868 |
| POST | `/api/copilot/chat` | `backend/src/routes/copilot.ts` | 361 |
| GET | `/api/copilot/sessions` | `backend/src/routes/copilot.ts` | 481 |
| GET | `/api/copilot/sessions/:id` | `backend/src/routes/copilot.ts` | 504 |
| DELETE | `/api/copilot/sessions/:id` | `backend/src/routes/copilot.ts` | 537 |
| POST | `/api/copilot/quick-action` | `backend/src/routes/copilot.ts` | 554 |
| POST | `/api/copilot/feedback` | `backend/src/routes/copilot.ts` | 584 |
| GET | `/api/copilot/agent-labels` | `backend/src/routes/copilot.ts` | 621 |
| POST | `/api/copilot/stream-chat` | `backend/src/routes/copilot.ts` | 643 |
| GET | `/api/copilot/thinking-chains` | `backend/src/routes/copilot.ts` | 805 |
| GET | `/api/copilot/thinking-chains/:id` | `backend/src/routes/copilot.ts` | 835 |
| GET | `/api/copilot/thinking-mode` | `backend/src/routes/copilot.ts` | 880 |
| POST | `/api/copilot/thinking-mode` | `backend/src/routes/copilot.ts` | 890 |
| GET | `/api/creation/tasks` | `backend/src/routes/creation.ts` | 431 |
| POST | `/api/creation/tasks/create` | `backend/src/routes/creation.ts` | 451 |
| POST | `/api/creation/collaborate/start` | `backend/src/routes/creation.ts` | 485 |
| POST | `/api/creation/collaborate/iterate` | `backend/src/routes/creation.ts` | 560 |
| POST | `/api/creation/vision-describe` | `backend/src/routes/creation.ts` | 643 |
| POST | `/api/creation/rewrite` | `backend/src/routes/creation.ts` | 689 |
| GET | `/api/creation/works` | `backend/src/routes/creation.ts` | 735 |
| POST | `/api/creation/works/submit` | `backend/src/routes/creation.ts` | 755 |
| POST | `/api/creation/works/:id/like` | `backend/src/routes/creation.ts` | 852 |
| GET | `/api/creation/works/wall` | `backend/src/routes/creation.ts` | 880 |
| POST | `/api/creation/works/:id/grade` | `backend/src/routes/creation.ts` | 912 |
| POST | `/api/creation/works/:id/recreate` | `backend/src/routes/creation.ts` | 1031 |
| GET | `/api/culture/poems/:poemId/background` | `backend/src/routes/culture.ts` | 256 |
| GET | `/api/culture/poems/:poemId/images` | `backend/src/routes/culture.ts` | 295 |
| GET | `/api/culture/images/:imageId` | `backend/src/routes/culture.ts` | 339 |
| GET | `/api/culture/imagery/:imageName` | `backend/src/routes/culture.ts` | 361 |
| POST | `/api/culture/imagery/:imageName/refresh` | `backend/src/routes/culture.ts` | 389 |
| POST | `/api/culture/immersive/start` | `backend/src/routes/culture.ts` | 443 |
| GET | `/api/culture/immersive/:poemId/status` | `backend/src/routes/culture.ts` | 471 |
| POST | `/api/culture/immersive/stop` | `backend/src/routes/culture.ts` | 495 |
| GET | `/api/dashboard/stats` | `backend/src/routes/dashboard.ts` | 349 |
| GET | `/api/dashboard/bloom-radar` | `backend/src/routes/dashboard.ts` | 388 |
| GET | `/api/dashboard/alerts` | `backend/src/routes/dashboard.ts` | 422 |
| GET | `/api/dashboard/weekly-progress` | `backend/src/routes/dashboard.ts` | 441 |
| GET | `/api/dashboard/alerts/trend` | `backend/src/routes/dashboard.ts` | 474 |
| POST | `/api/dashboard/alerts/trend/refresh` | `backend/src/routes/dashboard.ts` | 508 |
| POST | `/api/dashboard/alerts/:alertId/resolve` | `backend/src/routes/dashboard.ts` | 530 |
| POST | `/api/dashboard/alerts/batch-resolve` | `backend/src/routes/dashboard.ts` | 556 |
| GET | `/api/dashboard/class-hotspot` | `backend/src/routes/dashboard.ts` | 581 |
| GET | `/api/dashboard/class/:classId/hotspot` | `backend/src/routes/dashboard.ts` | 627 |
| POST | `/api/dashboard/class/:classId/hotspot/refresh` | `backend/src/routes/dashboard.ts` | 650 |
| GET | `/api/dashboard/innovation` | `backend/src/routes/dashboard.ts` | 676 |
| GET | `/api/diagnosis/classes/:classId/bloom-distribution` | `backend/src/routes/diagnosis.ts` | 413 |
| GET | `/api/diagnosis/classes/:classId/heatmap` | `backend/src/routes/diagnosis.ts` | 447 |
| GET | `/api/diagnosis/students/:studentId/profile` | `backend/src/routes/diagnosis.ts` | 480 |
| GET | `/api/diagnosis/classes/:classId/dark-matter` | `backend/src/routes/diagnosis.ts` | 515 |
| GET | `/api/diagnosis/classes/:classId/dark-matter/report` | `backend/src/routes/diagnosis.ts` | 549 |
| GET | `/api/diagnosis/students/:studentId/gaps` | `backend/src/routes/diagnosis.ts` | 593 |
| GET | `/api/diagnosis/students/:studentId/learning-path` | `backend/src/routes/diagnosis.ts` | 632 |
| GET | `/api/diagnosis/classes/:classId/prescription/:patternId` | `backend/src/routes/diagnosis.ts` | 666 |
| GET | `/api/diagnosis/classes/:classId/suggestions` | `backend/src/routes/diagnosis.ts` | 700 |
| GET | `/api/diagnosis/students/:studentId/profile-3d` | `backend/src/routes/diagnosis.ts` | 733 |
| POST | `/api/diagnosis/students/:studentId/profile-3d/refresh` | `backend/src/routes/diagnosis.ts` | 776 |
| POST | `/api/diagnosis/students/:studentId/learning-path` | `backend/src/routes/diagnosis.ts` | 821 |
| GET | `/api/diagnosis/students/:studentId/prescription` | `backend/src/routes/diagnosis.ts` | 918 |
| POST | `/api/diagnosis/students/:studentId/prescription` | `backend/src/routes/diagnosis.ts` | 965 |
| GET | `/api/diagnosis/students/:studentId/radar` | `backend/src/routes/diagnosis.ts` | 1058 |
| GET | `/api/diagnosis/classes/:classId/radar` | `backend/src/routes/diagnosis.ts` | 1099 |
| GET | `/api/error-notebook/list` | `backend/src/routes/error-notebook.ts` | 208 |
| GET | `/api/error-notebook/:id` | `backend/src/routes/error-notebook.ts` | 259 |
| POST | `/api/error-notebook/review` | `backend/src/routes/error-notebook.ts` | 278 |
| GET | `/api/error-notebook/stats` | `backend/src/routes/error-notebook.ts` | 363 |
| GET | `/api/evolution/genealogy` | `backend/src/routes/evolution.ts` | 178 |
| GET | `/api/evolution/patterns` | `backend/src/routes/evolution.ts` | 198 |
| GET | `/api/evolution/ab-tests` | `backend/src/routes/evolution.ts` | 220 |
| GET | `/api/evolution/ab-test` | `backend/src/routes/evolution.ts` | 241 |
| GET | `/api/evolution/predict` | `backend/src/routes/evolution.ts` | 274 |
| POST | `/api/evolution/predict` | `backend/src/routes/evolution.ts` | 402 |
| GET | `/api/grading/students` | `backend/src/routes/grading.ts` | 653 |
| GET | `/api/grading/questions` | `backend/src/routes/grading.ts` | 668 |
| GET | `/api/grading/history` | `backend/src/routes/grading.ts` | 689 |
| POST | `/api/grading/upload` | `backend/src/routes/grading.ts` | 721 |
| POST | `/api/grading/recognize` | `backend/src/routes/grading.ts` | 876 |
| POST | `/api/grading/grade` | `backend/src/routes/grading.ts` | 979 |
| POST | `/api/grading/review` | `backend/src/routes/grading.ts` | 1174 |
| GET | `/api/grading/batch/:batchId` | `backend/src/routes/grading.ts` | 1322 |
| GET | `/api/grading/files/:fileId` | `backend/src/routes/grading.ts` | 1357 |
| DELETE | `/api/grading/batch/:batchId` | `backend/src/routes/grading.ts` | 1401 |
| POST | `/api/grading/:id/score-multi-dim` | `backend/src/routes/grading.ts` | 1436 |
| POST | `/api/grading/batch-score` | `backend/src/routes/grading.ts` | 1484 |
| POST | `/api/grading/ocr` | `backend/src/routes/grading.ts` | 1534 |
| POST | `/api/grading/ocr-batch` | `backend/src/routes/grading.ts` | 1564 |
| POST | `/api/grading/:id/attribute` | `backend/src/routes/grading.ts` | 1592 |
| GET | `/api/health` | `backend/src/routes/health.ts` | 10 |
| GET | `/api/health/db` | `backend/src/routes/health.ts` | 20 |
| GET | `/api/illustration/scene/:sceneId` | `backend/src/routes/illustration.ts` | 123 |
| GET | `/api/illustration/scenes` | `backend/src/routes/illustration.ts` | 149 |
| GET | `/api/knowledge-graph/full` | `backend/src/routes/knowledge-graph.ts` | 124 |
| GET | `/api/knowledge-graph/mastery-colored` | `backend/src/routes/knowledge-graph.ts` | 135 |
| GET | `/api/knowledge-graph/dark-matter/:classId` | `backend/src/routes/knowledge-graph.ts` | 175 |
| GET | `/api/knowledge-graph/student/:studentId/gaps` | `backend/src/routes/knowledge-graph.ts` | 210 |
| GET | `/api/knowledge-graph/poem/:poemId/related` | `backend/src/routes/knowledge-graph.ts` | 245 |
| GET | `/api/lesson-plans/templates` | `backend/src/routes/lesson-plan-templates.ts` | 363 |
| GET | `/api/lesson-plans/templates/:id` | `backend/src/routes/lesson-plan-templates.ts` | 408 |
| GET | `/api/lesson-plan/templates` | `backend/src/routes/lesson-plan.ts` | 450 |
| GET | `/api/lesson-plan/list` | `backend/src/routes/lesson-plan.ts` | 479 |
| GET | `/api/lesson-plan/:id` | `backend/src/routes/lesson-plan.ts` | 515 |
| POST | `/api/lesson-plan/generate` | `backend/src/routes/lesson-plan.ts` | 536 |
| POST | `/api/lesson-plan/save` | `backend/src/routes/lesson-plan.ts` | 625 |
| GET | `/api/lesson-plan/poems/search` | `backend/src/routes/lesson-plan.ts` | 664 |
| GET | `/api/lesson-plan/poems/:id/detail` | `backend/src/routes/lesson-plan.ts` | 694 |
| POST | `/api/lesson-plan/objectives/generate` | `backend/src/routes/lesson-plan.ts` | 712 |
| POST | `/api/lesson-plan/layered-design/generate` | `backend/src/routes/lesson-plan.ts` | 740 |
| POST | `/api/lesson-plan/lessons/generate` | `backend/src/routes/lesson-plan.ts` | 767 |
| POST | `/api/lesson-plan/lessons/:id/refine` | `backend/src/routes/lesson-plan.ts` | 842 |
| GET | `/api/lesson-plan/lessons/:id/resources` | `backend/src/routes/lesson-plan.ts` | 903 |
| POST | `/api/lesson-plan/:id/export` | `backend/src/routes/lesson-plan.ts` | 922 |
| GET | `/api/memory` | `backend/src/routes/memory.ts` | 94 |
| POST | `/api/memory` | `backend/src/routes/memory.ts` | 135 |
| PATCH | `/api/memory/:id` | `backend/src/routes/memory.ts` | 165 |
| DELETE | `/api/memory/:id` | `backend/src/routes/memory.ts` | 191 |
| DELETE | `/api/memory` | `backend/src/routes/memory.ts` | 202 |
| GET | `/api/poem-content/:poemId` | `backend/src/routes/poem-content.ts` | 202 |
| GET | `/api/recitation/poems` | `backend/src/routes/recitation.ts` | 360 |
| POST | `/api/recitation/tts/generate` | `backend/src/routes/recitation.ts` | 414 |
| POST | `/api/recitation/asr/transcribe` | `backend/src/routes/recitation.ts` | 493 |
| POST | `/api/recitation/evaluate` | `backend/src/routes/recitation.ts` | 712 |
| GET | `/api/recitation/history/:studentId` | `backend/src/routes/recitation.ts` | 913 |
| GET | `/api/recitation/leaderboard/:classId` | `backend/src/routes/recitation.ts` | 933 |
| GET | `/api/recitation/audio/:recitationId` | `backend/src/routes/recitation.ts` | 1012 |
| DELETE | `/api/recitation/:recitationId` | `backend/src/routes/recitation.ts` | 1042 |
| GET | `/api/recitation/audio/*` | `backend/src/routes/recitation.ts` | 1091 |
| POST | `/api/report/share/preview` | `backend/src/routes/report-sharing.ts` | 84 |
| POST | `/api/report/share` | `backend/src/routes/report-sharing.ts` | 130 |
| GET | `/api/report/shared/:token` | `backend/src/routes/report-sharing.ts` | 195 |
| GET | `/api/report/shared` | `backend/src/routes/report-sharing.ts` | 212 |
| DELETE | `/api/report/shared/:token` | `backend/src/routes/report-sharing.ts` | 224 |
| GET | `/api/report/templates` | `backend/src/routes/report.ts` | 432 |
| POST | `/api/report/generate` | `backend/src/routes/report.ts` | 451 |
| GET | `/api/report/history` | `backend/src/routes/report.ts` | 613 |
| GET | `/api/report/:reportId` | `backend/src/routes/report.ts` | 684 |
| GET | `/api/report/:reportId/export` | `backend/src/routes/report.ts` | 714 |
| GET | `/api/report/:reportId/charts` | `backend/src/routes/report.ts` | 778 |
| GET | `/api/report/:reportId/preview` | `backend/src/routes/report.ts` | 827 |
| GET | `/api/report` | `backend/src/routes/report.ts` | 955 |
| DELETE | `/api/report/:reportId` | `backend/src/routes/report.ts` | 1026 |
| POST | `/api/report/export/:reportId` | `backend/src/routes/report.ts` | 1068 |
| GET | `/api/report/home-school/class/:classId` | `backend/src/routes/report.ts` | 1154 |
| POST | `/api/report/home-school/weekly` | `backend/src/routes/report.ts` | 1183 |
| GET | `/api/report/home-school/:studentId/latest` | `backend/src/routes/report.ts` | 1235 |
| POST | `/api/report/home-school/:reportId/feedback` | `backend/src/routes/report.ts` | 1259 |
| POST | `/api/report/home-school/:reportId/note` | `backend/src/routes/report.ts` | 1290 |
| POST | `/api/report/home-school/:reportId/publish` | `backend/src/routes/report.ts` | 1322 |
| POST | `/api/report/home-school/:reportId/feedback/read` | `backend/src/routes/report.ts` | 1345 |
| POST | `/api/report/home-school/:reportId/activity/:activityId/complete` | `backend/src/routes/report.ts` | 1368 |
| GET | `/api/settings/credentials` | `backend/src/routes/settings.ts` | 246 |
| PUT | `/api/settings/credentials/:id` | `backend/src/routes/settings.ts` | 259 |
| POST | `/api/settings/credentials/:id/test` | `backend/src/routes/settings.ts` | 300 |
| GET | `/api/students` | `backend/src/routes/students.ts` | 49 |
| GET | `/api/students/:id/weak-points` | `backend/src/routes/students.ts` | 98 |
| GET | `/api/agents/poems` | `backend/src/routes/workbench.ts` | 352 |
| POST | `/api/agents/generate` | `backend/src/routes/workbench.ts` | 377 |
| POST | `/api/agents/refine` | `backend/src/routes/workbench.ts` | 446 |
| GET | `/api/agents/questions` | `backend/src/routes/workbench.ts` | 575 |
| POST | `/api/agents/questions/:id/favorite` | `backend/src/routes/workbench.ts` | 676 |
| POST | `/api/agents/questions/:id/duplicate` | `backend/src/routes/workbench.ts` | 711 |
| PATCH | `/api/agents/questions/:id` | `backend/src/routes/workbench.ts` | 750 |
| DELETE | `/api/agents/questions/:id` | `backend/src/routes/workbench.ts` | 794 |
| GET | `/api/agents/questions/:id/verification` | `backend/src/routes/workbench.ts` | 825 |
| POST | `/api/agents/smart-compose` | `backend/src/routes/workbench.ts` | 906 |
| POST | `/api/agents/export` | `backend/src/routes/workbench.ts` | 1012 |
| POST | `/api/agents/publish` | `backend/src/routes/workbench.ts` | 1066 |
| POST | `/api/agents/orchestrate` | `backend/src/routes/workbench.ts` | 1362 |
| GET | `/api/auth/status` | `backend/src/security/auth.ts` | 516 |
| POST | `/api/auth/login` | `backend/src/security/auth.ts` | 531 |
| POST | `/api/auth/logout` | `backend/src/security/auth.ts` | 566 |

## 前端路由（完整）

> 静态声明总数保留开发路由；生产口径排除仅在 `import.meta.env.DEV` 下注册的 `/dev/visual` 与 `/dev/scripts`。

| 路由 | 范围 | 文件 | 行 |
|---|---|---|---:|
| `/login` | 生产 | `frontend/src/App.tsx` | 387 |
| `*` | 生产 | `frontend/src/App.tsx` | 388 |
| `/` | 生产 | `frontend/src/App.tsx` | 426 |
| `/dashboard` | 生产 | `frontend/src/App.tsx` | 428 |
| `/starmap` | 生产 | `frontend/src/App.tsx` | 430 |
| `/diagnosis-report` | 生产 | `frontend/src/App.tsx` | 432 |
| `/diagnosis` | 生产 | `frontend/src/App.tsx` | 433 |
| `/lesson-plan` | 生产 | `frontend/src/App.tsx` | 435 |
| `/workbench` | 生产 | `frontend/src/App.tsx` | 436 |
| `/classroom` | 生产 | `frontend/src/App.tsx` | 437 |
| `/classroom/:lessonId` | 生产 | `frontend/src/App.tsx` | 438 |
| `/grading` | 生产 | `frontend/src/App.tsx` | 439 |
| `/creation-studio` | 生产 | `frontend/src/App.tsx` | 440 |
| `/ai-copilot` | 生产 | `frontend/src/App.tsx` | 442 |
| `/evolution-eye` | 生产 | `frontend/src/App.tsx` | 444 |
| `/thinking-palace` | 生产 | `frontend/src/App.tsx` | 445 |
| `/culture` | 生产 | `frontend/src/App.tsx` | 447 |
| `/report` | 生产 | `frontend/src/App.tsx` | 449 |
| `/privacy` | 生产 | `frontend/src/App.tsx` | 451 |
| `/forbidden` | 生产 | `frontend/src/App.tsx` | 453 |
| `/dev/visual` | 仅开发 | `frontend/src/App.tsx` | 456 |
| `/dev/scripts` | 仅开发 | `frontend/src/App.tsx` | 460 |
| `*` | 生产 | `frontend/src/App.tsx` | 463 |
| `/shared/report/:token` | 生产 | `frontend/src/App.tsx` | 500 |
| `*` | 生产 | `frontend/src/App.tsx` | 509 |

## 最大文件

| 行数 | 函数 | 端点 | 文件 |
|---:|---:|---:|---|
| 6382 | 8 | 0 | `frontend/src/lib/types.ts` |
| 5620 | 0 | 0 | `frontend/src/pages/StarMapPage/StarMapPage.css` |
| 4915 | 325 | 0 | `frontend/src/lib/api.ts` |
| 3965 | 0 | 0 | `frontend/src/pages/LessonPlanPage/LessonPlanPage.css` |
| 3835 | 129 | 37 | `backend/src/routes/classroom.ts` |
| 3756 | 0 | 0 | `frontend/src/pages/ThinkingPalacePage/ThinkingPalacePage.css` |
| 3397 | 0 | 0 | `frontend/src/pages/WorkbenchPage/WorkbenchPage.css` |
| 3385 | 0 | 0 | `frontend/src/pages/DashboardPage/DashboardPage.css` |
| 3182 | 0 | 0 | `frontend/src/pages/ClassroomPage/ClassroomPage.css` |
| 3043 | 0 | 0 | `frontend/src/pages/AICopilotPage/AICopilotPage.css` |
| 2951 | 0 | 0 | `frontend/src/pages/DiagnosisPage/DiagnosisPage.css` |
| 2611 | 88 | 18 | `backend/src/routes/report.ts` |
| 2581 | 0 | 0 | `frontend/src/pages/GradingPage/GradingPage.css` |
| 2305 | 0 | 0 | `frontend/src/pages/CultureContextPage/CultureContextPage.css` |
| 2298 | 0 | 0 | `frontend/src/pages/EvolutionEyePage/EvolutionEyePage.css` |
| 2289 | 69 | 16 | `backend/src/routes/diagnosis.ts` |
| 2225 | 0 | 0 | `frontend/src/components/layout/AppShell.css` |
| 1899 | 0 | 0 | `frontend/src/pages/ReportPage/ReportPage.css` |
| 1833 | 57 | 13 | `backend/src/routes/lesson-plan.ts` |
| 1795 | 68 | 12 | `backend/src/routes/dashboard.ts` |
| 1777 | 68 | 13 | `backend/src/routes/workbench.ts` |
| 1754 | 81 | 0 | `frontend/src/pages/ReportPage/ReportCharts.tsx` |
| 1727 | 63 | 15 | `backend/src/routes/grading.ts` |
| 1573 | 78 | 0 | `backend/src/services/knowledge-graph/knowledge-graph-service.ts` |
| 1501 | 96 | 0 | `frontend/src/pages/LessonPlanPage/LessonPlanPage.tsx` |
| 1349 | 0 | 0 | `frontend/src/styles/tokens.css` |
| 1337 | 0 | 0 | `frontend/src/pages/DiagnosisPage/SuggestionPanel.css` |
| 1334 | 0 | 0 | `frontend/src/pages/ClassroomPage/ModesEnhanced.css` |
| 1265 | 43 | 0 | `frontend/src/stores/classroom.ts` |
| 1251 | 87 | 0 | `frontend/src/pages/EvolutionEyePage/Genealogy3D.tsx` |

## 高复杂度函数候选

> complexity 为静态分支计数启发式，只用于排序人工审查优先级，不等同于正式圈复杂度结论。

| 复杂度 | 行数 | 函数 | 文件:行 |
|---:|---:|---|---|
| 369 | 2433 | `classroomRoutes` | `backend/src/routes/classroom.ts:602` |
| 155 | 690 | `<callback>` | `frontend/src/stores/grading.ts:343` |
| 135 | 985 | `gradingRoutes` | `backend/src/routes/grading.ts:645` |
| 125 | 929 | `ClassroomPage` | `frontend/src/pages/ClassroomPage/ClassroomPage.tsx:105` |
| 124 | 767 | `workbenchRoutes` | `backend/src/routes/workbench.ts:344` |
| 118 | 865 | `RefineModal` | `frontend/src/pages/WorkbenchPage/RefineModal.tsx:217` |
| 116 | 775 | `recitationRoutes` | `backend/src/routes/recitation.ts:356` |
| 105 | 921 | `<callback>` | `frontend/src/stores/classroom.ts:323` |
| 100 | 708 | `creationRoutes` | `backend/src/routes/creation.ts:424` |
| 99 | 390 | `VoiceInputImpl` | `frontend/src/pages/ThinkingPalacePage/VoiceInput.tsx:82` |
| 97 | 962 | `reportRoutes` | `backend/src/routes/report.ts:424` |
| 92 | 504 | `SphereGallery` | `frontend/src/components/ui/SphereGallery.tsx:105` |
| 91 | 692 | `<callback>` | `frontend/src/stores/diagnosis.ts:295` |
| 90 | 621 | `<callback>` | `frontend/src/stores/workbench.ts:269` |
| 90 | 442 | `Combobox` | `frontend/src/components/ui/Combobox.tsx:74` |
| 86 | 583 | `ReportSharePanel` | `frontend/src/pages/ReportPage/ReportSharePanel.tsx:32` |
| 86 | 567 | `<callback>` | `frontend/src/stores/report.ts:209` |
| 85 | 776 | `<callback>` | `frontend/src/stores/copilot.ts:215` |
| 84 | 339 | `StackGallery` | `frontend/src/components/ui/StackGallery.tsx:99` |
| 83 | 418 | `TextSwitch` | `frontend/src/components/ui/TextSwitch.tsx:261` |
| 80 | 440 | `UploadZone` | `frontend/src/pages/GradingPage/UploadZone.tsx:69` |
| 78 | 734 | `diagnosisRoutes` | `backend/src/routes/diagnosis.ts:404` |
| 77 | 474 | `ClassHeatmap` | `frontend/src/pages/DiagnosisPage/ClassHeatmap.tsx:80` |
| 75 | 392 | `QuickActions` | `frontend/src/pages/AICopilotPage/QuickActions.tsx:212` |
| 73 | 581 | `copilotRoutes` | `backend/src/routes/copilot.ts:353` |
| 71 | 280 | `VoiceCaptureButton` | `frontend/src/components/ui/QuickVoiceAssist.tsx:65` |
| 71 | 88 | `parseGradingBatch` | `frontend/src/stores/grading.ts:157` |
| 69 | 547 | `lessonPlanRoutes` | `backend/src/routes/lesson-plan.ts:430` |
| 69 | 445 | `GradingPage` | `frontend/src/pages/GradingPage/GradingPage.tsx:65` |
| 66 | 529 | `PoemRecitationPlayer` | `frontend/src/pages/ThinkingPalacePage/PoemRecitationPlayer.tsx:163` |
| 66 | 419 | `aiRoutes` | `backend/src/routes/ai.ts:274` |
| 64 | 344 | `StarMapDome` | `frontend/src/pages/StarMapPage/StarMapDome.tsx:55` |
| 63 | 321 | `StudentInputPanel` | `frontend/src/pages/ClassroomPage/shared/StudentInputPanel.tsx:72` |
| 62 | 423 | `ScriptPlayer` | `frontend/src/components/dev/ScriptPlayer.tsx:70` |
| 62 | 375 | `RadarCanvas` | `frontend/src/pages/DashboardPage/BloomRadarChart.tsx:161` |
| 61 | 539 | `LearningPathViz` | `frontend/src/pages/DiagnosisPage/LearningPathViz.tsx:144` |
| 61 | 478 | `QuestionCardList` | `frontend/src/pages/WorkbenchPage/QuestionCardList.tsx:165` |
| 59 | 387 | `FlyingPosters` | `frontend/src/components/ui/FlyingPosters.tsx:113` |
| 59 | 382 | `PoemImageGenerator` | `frontend/src/pages/ThinkingPalacePage/PoemImageGenerator.tsx:399` |
| 59 | 365 | `evolutionRoutes` | `backend/src/routes/evolution.ts:176` |
| 58 | 434 | `CreationStudioPage` | `frontend/src/pages/CreationStudioPage/CreationStudioPage.tsx:49` |
| 57 | 410 | `DanceStage` | `frontend/src/pages/ClassroomPage/DanceStage.tsx:85` |
| 56 | 483 | `ChatInterface` | `frontend/src/pages/AICopilotPage/ChatInterface.tsx:358` |
| 56 | 405 | `PoemRelayMode` | `frontend/src/pages/ClassroomPage/modes/PoemRelayMode.tsx:84` |
| 55 | 184 | `AnimatedList` | `frontend/src/components/ui/AnimatedList.tsx:57` |
| 53 | 396 | `CommandPalette` | `frontend/src/components/ui/CommandPalette.tsx:191` |
| 53 | 312 | `<callback>` | `frontend/src/components/ui/FlyingPosters.tsx:138` |
| 52 | 381 | `AIAssistant` | `frontend/src/pages/ClassroomPage/AIAssistant.tsx:105` |
| 52 | 216 | `<callback>` | `frontend/src/stores/agent-runtime.ts:163` |
| 52 | 188 | `CardSwap` | `frontend/src/components/ui/CardSwap.tsx:112` |

## 静态风险标记汇总

| 类型 | 命中 |
|---|---:|
| css-important | 220 |
| non-null-assertion | 208 |
| console | 74 |
| hardcoded-localhost | 29 |
| possible-secret | 9 |
| todo | 9 |
| dangerous-html | 2 |
| explicit-any | 1 |

## 解释边界

- 文件哈希与 AST 台账证明当前版本的每个产品源文件均被机器读取和登记，不证明每一行都不存在语义缺陷。
- 端点解析覆盖 Fastify 常见的 `app.get/post/put/patch/delete/options/head` 声明；动态注册、运行时拼接与 WebSocket 事件需另行审查。
- 静态标记是审查入口，不是漏洞定论；每个高风险命中仍需结合数据流、可达性与测试证据判断。
- 完整函数、文件、API 引用与风险明细见同名 JSON。
