"""Run actual regression commands; retain raw evidence and never infer a pass from a skipped check."""
from pathlib import Path
import hashlib, json, os, signal, subprocess, sys, time
ROOT = Path(__file__).resolve().parents[1]
os.chdir(ROOT)
OUT = Path(os.environ.get('RUNNER_TEMP', '/tmp')) / 'poetic-evidence'
OUT.mkdir(parents=True, exist_ok=True)
checks = []
def manifest():
    paths = subprocess.check_output(['git', 'ls-files', '-z']).decode().split('\0')
    return {name: hashlib.sha256(Path(name).read_bytes()).hexdigest() for name in paths if name and Path(name).is_file() and (name.startswith('backend/src/') or name.startswith('frontend/src/') or name.endswith(('package.json', 'pnpm-lock.yaml')))}
def run(name, command, timeout=600):
    started = time.monotonic()
    log = OUT / (name + '.log')
    with log.open('wb') as stream:
        process = subprocess.Popen(command, stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
        try: code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL); process.wait(); code = 124
    result = {'name': name, 'exitCode': code, 'seconds': round(time.monotonic()-started, 3), 'log': log.name, 'command': command}
    checks.append(result)
    print('CHECK ' + json.dumps(result, ensure_ascii=False), flush=True)
    if code:
        for line in log.read_text(errors='replace').splitlines()[-24:]: print('FAILURE_DETAIL ' + line[:600], flush=True)
    return code == 0

before = manifest()
(OUT / 'source-manifest.json').write_text(json.dumps(before, indent=2))
run('backend-install', ['pnpm', '--dir', 'backend', 'install', '--frozen-lockfile'])
run('frontend-install', ['pnpm', '--dir', 'frontend', 'install', '--frozen-lockfile'])
run('backend-build', ['pnpm', '--dir', 'backend', 'build'])
run('backend-tests', ['pnpm', '--dir', 'backend', 'test', '--reporter=json', '--outputFile=' + str(OUT / 'backend-vitest.json')])
run('frontend-tests', ['pnpm', '--dir', 'frontend', 'test', '--reporter=json', '--outputFile=' + str(OUT / 'frontend-vitest.json')])
run('frontend-build', ['pnpm', '--dir', 'frontend', 'build'])
run('http-routes', ['pnpm', '--dir', 'backend', 'test:routes'])
run('teaching-loop', ['pnpm', '--dir', 'backend', 'test:closed-loop'])
run('browser-install', ['pnpm', '--dir', 'frontend', 'exec', 'playwright', 'install', '--with-deps', 'chromium'])
run('password-browser', ['pnpm', '--dir', 'frontend', 'e2e:password'], 900)
after = manifest()
intact = before == after
checks.append({'name': 'source-integrity', 'exitCode': 0 if intact else 1, 'changedDuringTests': [name for name in before if before[name] != after.get(name)]})
tests = {}
for name in ['backend', 'frontend']:
    p = OUT / (name + '-vitest.json')
    if p.exists():
        report = json.loads(p.read_text())
        tests[name] = {key: report.get(key) for key in ['numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests', 'numTotalTestSuites', 'success']}
        failures = []
        for suite in report.get('testResults', []):
            for case in suite.get('assertionResults', []):
                if case.get('status') == 'failed': failures.append({'file': suite.get('name'), 'test': case.get('fullName'), 'message': '\n'.join(case.get('failureMessages', []))[:1500]})
        for failure in failures[:20]: print('TEST_FAILURE ' + json.dumps(failure, ensure_ascii=False), flush=True)
result = {
    'sourceCommit': os.environ.get('GITHUB_SHA'),
    'runId': os.environ.get('GITHUB_RUN_ID'),
    'runUrl': 'https://github.com/' + os.environ.get('GITHUB_REPOSITORY', 'hxjyaohaohaode/chuangAI') + '/actions/runs/' + os.environ.get('GITHUB_RUN_ID', ''),
    'node': subprocess.check_output(['node', '--version']).decode().strip(),
    'checks': checks, 'tests': tests, 'allPassed': all(check['exitCode'] == 0 for check in checks),
    'sourceManifestSha256': hashlib.sha256(json.dumps(before, sort_keys=True).encode()).hexdigest(),
    'limitations': ['No live model-provider credentials or real classroom data were used.', 'Automated Chromium regression is not a complete visual or pedagogical audit.', 'Windows hardware, production multi-process operation, long-duration load and software copyright ownership were not verified.', 'This is a runtime-kernel refactor, not an all-feature whole-project redesign.'],
}
(OUT / 'summary.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
print('REGRESSION_SUMMARY ' + json.dumps(result, ensure_ascii=False), flush=True)
if os.environ.get('GITHUB_STEP_SUMMARY'):
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as stream: stream.write('## Actual regression evidence\n```json\n' + json.dumps(result, ensure_ascii=False, indent=2) + '\n```\n')
if result['allPassed']:
    Path('docs').mkdir(exist_ok=True)
    Path('docs/runtime-verification.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
sys.exit(0 if result['allPassed'] else 1)
