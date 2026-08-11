# 真实试点证据分析

- 结论门：**FAIL**
- 数据文件：`pilot-data-template.csv`
- 数据 SHA-256：`b3b6ed8e4f5cfeba484aa5563251bc3f4c294441cc0b276bad8029d25b2211ef`
- 清单文件：`pilot-manifest-template.json`
- 清单 SHA-256：`dba695d178d627a328a6f33136707b6ac7dfad4580c95a5854d685f3c4954bc4`
- 测量窗口：未填写 至 未填写；已验证日期的配对记录 0
- 生成时间：2026-08-09T06:17:10.135Z

> 统计边界：单组配对前后测仅能描述关联，不能单独证明因果；不得外推到未参与人群。

## 阻断问题

- manifest.pilotId 必须填写
- manifest.classId 必须填写
- manifest.systemVersion 必须填写
- manifest.pilotStartDate 必须填写
- manifest.pilotEndDate 必须填写
- manifest.independentReviewer 必须填写
- manifest.authorizationEvidenceLocation 必须填写
- manifest.dataKind 必须明确为 REAL；DEMO/UNVERIFIED 不得生成真实成效结论
- manifest.consentAndAuthorizationConfirmed 必须为 true
- manifest.piiRemoved 必须为 true
- manifest.expectedStudents 必须是大于 0 的整数
- manifest.pilotStartDate / pilotEndDate 必须使用 YYYY-MM-DD
- CSV 没有试点记录
- 指标 knowledge_accuracy 没有可分析的配对样本，不能形成完整试点评估
- 指标 poem_comprehension 没有可分析的配对样本，不能形成完整试点评估
- 指标 recitation 没有可分析的配对样本，不能形成完整试点评估
- 指标 transfer_creation 没有可分析的配对样本，不能形成完整试点评估
- 指标 task_completion 没有可分析的配对样本，不能形成完整试点评估

## 风险提示

- 样本量少于 20，不应作显著改善或推广性表述

## 指标结果

| 指标 | 配对/总数 | 缺失率 | 前测均值 | 后测均值 | 标准化变化百分点（95% CI） | 可声明等级 |
|---|---:|---:|---:|---:|---:|---|
| knowledge_accuracy | 0/0 | 0% | — | — | 样本不足 | 不可分析 |
| poem_comprehension | 0/0 | 0% | — | — | 样本不足 | 不可分析 |
| recitation | 0/0 | 0% | — | — | 样本不足 | 不可分析 |
| transfer_creation | 0/0 | 0% | — | — | 样本不足 | 不可分析 |
| task_completion | 0/0 | 0% | — | — | 样本不足 | 不可分析 |

声明等级解释：`POSITIVE_ASSOCIATION` 仅表示本试点配对样本呈正向关联；`NO_CLEAR_POSITIVE_ASSOCIATION` 不支持正向结论；`DESCRIPTIVE_ONLY` 只能报告原始描述值。

