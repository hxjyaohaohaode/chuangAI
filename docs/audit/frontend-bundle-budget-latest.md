# 前端首包 JS 预算审计

- 结论：**通过**
- 预算：120.00 KB gzip（十进制，严格于 120 KiB）
- 实测：95.023 KB gzip
- 余量：24.977 KB
- 口径：dist/index.html 中 module script 与 modulepreload 的真实文件，逐文件 gzip level 9 后求和
- 禁止首屏预载的重依赖：无
- 禁止进入生产包的开发资源：无

| 静态 JS | 原始 KB | gzip KB |
|---|---:|---:|
| `/assets/index-82liDysJ.js` | 100.20 | 32.68 |
| `/assets/app-runtime-reErVGuh.js` | 188.51 | 62.35 |

| 延迟能力 | 文件 | gzip KB | 预算 KB | 结论 |
|---|---|---:|---:|---|
| 可选 Three.js 3D 运行时 | `three-vendor-fus_J0BD.js` | 224.976 | 240.000 | 通过 |
| 富 Markdown 渲染器 | `Markdown-D19lfhyo.js` | 101.531 | 110.000 | 通过 |
