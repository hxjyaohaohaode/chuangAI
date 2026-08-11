# 生产依赖人工复核记录（工程证据）

复核日期：2026-08-11

> 本记录用于证明项目团队核对了实际依赖、官方条款与当前分发形态。它不是法律意见，不能替代发布负责人或法律顾问签署。依赖版本、目标平台、商业模式或分发方式变化后必须重新复核。

## GSAP 3.15.0

- 当前源码用途：仅 `frontend/src/components/visual/` 下的开发视觉演示组件使用；唯一消费者为 `frontend/src/pages/_dev/VisualShowcase.tsx`，路由由 `import.meta.env.DEV` 保护。
- 生产边界：GSAP 已从 `dependencies` 移至 `devDependencies`；生产许可证清单与生产运行时不得再包含 GSAP。
- 官方条款：[Standard "No Charge" GSAP License](https://gsap.com/community/standard-license/)，页面标记生效日期 2025-04-30、最后修改日期 2025-05-30。
- 条款核对：官方许可将网站、Web 应用和数字界面的实现/使用列为允许用途，并在 FAQ 明确商业项目可免费使用；禁止项集中于构建与 Webflow 视觉动画能力竞争的无代码可视化动画工具、为竞争产品反向工程以及移除专有声明。
- 当前结论：项目不提供动画创建器，开发演示用途与上述允许用途一致。若未来新增可视化无代码动画搭建、修改 GSAP 版本或改变分发方式，必须重新审查。

## Sharp 与平台预编译 libvips

- 当前直接依赖：`sharp@0.35.3`，用于后端图像检查、解码与 WebP 处理。
- 上游 Sharp 许可：[lovell/sharp](https://github.com/lovell/sharp) 声明 Apache-2.0。
- Windows x64 平台包：[`@img/sharp-win32-x64@0.35.3` 元数据](https://github.com/lovell/sharp/blob/v0.35.3/npm/win32-x64/package.json) 明确声明 `Apache-2.0 AND LGPL-3.0-or-later`。
- libvips 许可：[libvips 官方仓库](https://github.com/libvips/libvips) 声明 LGPL-2.1-or-later。平台包元数据与当前生产审计结果使用 `LGPL-3.0-or-later`，两者不能被简化为 MIT 或仅写 Apache-2.0。
- 平台差异：本机审计看到的是 Windows x64 预编译包；Render 使用 Linux。最终镜像会安装不同的 `@img/sharp-*`/libvips 包，因此必须在实际 Render/Linux 构建产物中重新生成许可证清单，并随分发物保留适用的 LICENSE/NOTICE、组件版本与替换/重新链接所需信息。
- 当前结论：本地发布包继续保持 `passed_with_review`，直到目标 Render/Linux 镜像完成同版本依赖审计并由发布负责人确认 LGPL 与 Apache-2.0 的分发义务。若无法完成，回退为不分发平台二进制、在目标环境使用合规系统 libvips，或替换图像处理方案。

## 发布检查清单

- [x] 当前生产依赖清单由锁文件和已安装生产树生成。
- [x] `THIRD_PARTY_NOTICES.md` 保留第三方包名、版本、许可声明和可采集的根目录文本。
- [x] GSAP 已限定为开发依赖，生产构建不得加载其资源。
- [ ] 在实际 Render/Linux 镜像重跑 `node scripts/audit-production-licenses.mjs`。
- [ ] 发布负责人复核 Sharp/libvips 的目标平台许可证文本和分发义务并签字留档。
- [ ] 若商业模式或动画产品能力变化，重新复核 GSAP 许可边界。
