"""Idempotent, anchor-checked source integration. No runtime database or credentials are read."""
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
changes = {}
def replace_once(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError('Source anchor mismatch: ' + old[:100])
    return text.replace(old, new, 1)
def replace_section(text, start, end, new):
    a = text.index(start); b = text.index(end, a)
    return text[:a] + new + '\n\n' + text[b:]

p = ROOT / 'backend/src/orchestrator/Orchestrator.ts'
s = p.read_text()
start = '    /**\n     * 等待所有运行中任务完成'
end = '    /**\n     * 中止所有运行中任务'
if start in s:
    s = replace_section(s, start, end, '')
    changes[p] = s
p = ROOT / 'backend/src/orchestrator/dag-scheduler.ts'
s = p.read_text()
s = s.replace('if (!VALID_TRANSITIONS[node.status])', 'if (!Object.hasOwn(VALID_TRANSITIONS, node.status))')
changes[p] = s

p = ROOT / 'scripts/render-build.mjs'
s = p.read_text()
if "from './runtime-policy.mjs'" not in s:
    s = "import { assertSupportedRuntime } from './runtime-policy.mjs'\n" + s
    s = replace_section(s, 'function assertSupportedNode() {', 'function runPnpm(', "function assertSupportedNode() { assertSupportedRuntime('Render 构建') }")
    s = s.replace('Node 20 启动', '旧 Node 启动')
    changes[p] = s
p = ROOT / 'scripts/render-start.mjs'
s = p.read_text()
if "from './runtime-policy.mjs'" not in s:
    s = "import { assertSupportedRuntime } from './runtime-policy.mjs'\n" + s
    s = replace_section(s, 'const [nodeMajor, nodeMinor]', 'if (!existsSync(serverEntry)', "assertSupportedRuntime('生产运行时')")
    changes[p] = s
p = ROOT / 'frontend/scripts/run-e2e-isolated.mjs'
s = p.read_text()
if "from '../../scripts/runtime-policy.mjs'" not in s:
    # Place imports after an optional hashbang rather than invalidating executable scripts.
    line = "import { assertSupportedRuntime } from '../../scripts/runtime-policy.mjs'\n"
    if s.startswith('#!'):
        first, rest = s.split('\n', 1); s = first + '\n' + line + rest
    else:
        s = line + s
    s = replace_section(s, 'function assertCompetitionNodeRuntime() {', 'assertCompetitionNodeRuntime()', "function assertCompetitionNodeRuntime() { assertSupportedRuntime('生产同源 E2E') }")
    changes[p] = s
p = ROOT / 'scripts/competition-preflight.mjs'
s = p.read_text()
if "from './runtime-policy.mjs'" not in s:
    s = replace_once(s, "import net from 'node:net'", "import net from 'node:net'\nimport { isSupportedNode, NODE_ENGINE } from './runtime-policy.mjs'")
    s = replace_section(s, 'const nodeVersion = process.versions.node', 'const corepackEntry', "const nodeVersion = process.versions.node\nrecord('runtime.node', isSupportedNode(nodeVersion) ? 'PASS' : 'FAIL', `Node.js ${nodeVersion}；当前统一运行时要求 ${NODE_ENGINE}`)")
    s = replace_once(s, "packageJson?.engines?.node === '>=20.19 <21'", "packageJson?.engines?.node === NODE_ENGINE")
    s = s.replace('>=20.19 <21', '>=24.0.0 <25').replace('Node 20', 'Node 24')
    changes[p] = s

# Current prose guides are updated, while dated audit evidence is deliberately left untouched.
for filename in ['README.md', 'INSTALL.md', 'DEVELOPMENT.md', 'DEPLOY_RENDER.md', 'USAGE.md']:
    p = ROOT / filename
    if not p.exists(): continue
    s = p.read_text()
    s = s.replace('>=20.19 <21', '>=24.0.0 <25').replace('20.19.x LTS', '24.x LTS').replace('20.19.0', '24.21.0')
    s = s.replace('Node 20', 'Node 24').replace('Node.js 20', 'Node.js 24')
    if filename == 'README.md' and '运行内核重构候选分支' not in s:
        first, rest = s.split('\n', 1)
        s = first + '\n\n> **运行内核重构候选分支（2026-09-26）**：新的执行状态机、依赖数据交接、取消/修订隔离、前端身份缓存边界和运行时配置已改写；这不是全站全功能重建的完成声明。实际验收记录见 `docs/runtime-verification.json`（仅全部门禁成功后生成），范围、缺口与运行方式见 `docs/runtime-reconstruction.md`。此前文档中的历史测试数字不代表本次测试结果。\n' + rest
    changes[p] = s

for p, content in changes.items():
    if p.read_text() != content:
        p.write_text(content)
        print('SOURCE_UPDATED ' + str(p.relative_to(ROOT)))
