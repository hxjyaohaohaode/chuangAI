/// <reference types="vitest" />
import { defineConfig } from 'vitest/config'

/**
 * Vitest 配置
 *
 * - environment: node（后端纯 Node 环境）
 * - include: 仅匹配 src 下的 *.test.ts，避免与 __sanity__ 冒烟脚本冲突
 * - coverage: 关注核心模块（llm/db/routes/services/utils），阈值 80% 行覆盖
 * - server.deps.inline: 内联 better-sqlite3 等 CJS 原生模块
 */
export default defineConfig({
    test: {
        environment: 'node',
        include: ['src/**/*.test.ts'],
        exclude: ['node_modules/**', 'dist/**', 'src/**/__sanity__/**'],
        globals: false,
        // 单测默认超时 10s（限流超时等用例需要更久）
        testTimeout: 15_000,
        hookTimeout: 15_000,
        // 每个 Vitest worker 使用独立内存库，避免并发测试争用仓库/Nutstore 中的
        // SQLite WAL 文件，也确保 CI 和 GitHub 构建不会改写开发者真实数据。
        env: {
            SQLITE_PATH: ':memory:',
        },
        coverage: {
            provider: 'v8',
            reporter: ['text', 'html', 'json-summary'],
            include: [
                'src/llm/**/*.ts',
                'src/db/utils/**/*.ts',
                'src/db/repositories/**/*.ts',
                'src/routes/_helpers.ts',
                'src/routes/health.ts',
                'src/services/culture/local-scene-generator.ts',
            ],
            exclude: [
                'src/**/__sanity__/**',
                'src/**/*.test.ts',
                'src/**/types.ts',
                'src/**/index.ts',
                'src/**/seed-*.ts',
                'src/db/runtime-store.ts',
            ],
            thresholds: {
                lines: 80,
                functions: 80,
                statements: 80,
            },
        },
        server: {
            deps: {
                inline: [/better-sqlite3/, /openai/],
            },
        },
    },
})
