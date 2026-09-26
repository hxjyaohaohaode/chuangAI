"""Finalize the inspected source migration; all edits are deterministic and local."""
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
p = ROOT / 'backend/src/orchestrator/Orchestrator.ts'
s = p.read_text()
start = '    /**\n     * 等待所有运行中任务完成'
end = '    /**\n     * 中止所有运行中任务'
if start in s:
    a = s.index(start); b = s.index(end, a)
    s = s[:a] + s[b:]
    p.write_text(s)
    print('SOURCE_UPDATED backend/src/orchestrator/Orchestrator.ts (removed obsolete polling)')
p = ROOT / 'backend/src/orchestrator/dag-scheduler.ts'
s = p.read_text()
s = s.replace('if (!VALID_TRANSITIONS[node.status])', 'if (!Object.hasOwn(VALID_TRANSITIONS, node.status))')
p.write_text(s)
