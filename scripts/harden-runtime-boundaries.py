"""Apply inspected authentication, vault and regression-fixture corrections without touching real data."""
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
changes = {}
def one(text, old, new):
    if text.count(old) != 1: raise RuntimeError('Source anchor mismatch: ' + old[:100])
    return text.replace(old, new, 1)
def section(text, start, end, new):
    a = text.index(start); b = text.index(end, a + len(start))
    return text[:a] + new + '\n\n' + text[b:]

p = ROOT / 'backend/src/security/auth.ts'
s = p.read_text()
if '// PASSWORD_MODE_ISOLATION_V1' not in s:
    s = '// PASSWORD_MODE_ISOLATION_V1\n' + s
    s = one(s, '    readonly demoTeachers = DEMO_TEACHERS', "    get demoTeachers() { return this.mode === 'demo' ? DEMO_TEACHERS : [] }")
    s = one(s, "        const demoAccount = DEMO_TEACHERS.find((item) => safeEqual(item.phone, input.phone))", "        // Production authentication has no fallback to a public demonstration identity.\n        const demoAccount = this.mode === 'demo'\n            ? DEMO_TEACHERS.find((item) => safeEqual(item.phone, input.phone))\n            : undefined")
    s = one(s, "        if (payload.accountType !== 'owner' && payload.accountType !== 'demo') return null", "        if (payload.accountType !== 'owner' && payload.accountType !== 'demo') return null\n        // Reject previously signed demo cookies after switching to password mode.\n        if (this.mode === 'password' && (payload.accountType !== 'owner' || payload.sub !== this.options.teacherId)) return null")
    changes[p] = s

p = ROOT / 'backend/src/security/credential-vault.ts'
s = p.read_text()
if '// CANONICAL_VAULT_V1' not in s:
    s = '// CANONICAL_VAULT_V1\n' + s
    s = one(s, 'function deriveKey(masterKey: string): Buffer {', '''/** Reject ignored padding, whitespace, alternate alphabets and non-zero unused bits. */
function decodeCanonical(value: string): Buffer {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('凭据保险柜格式无效')
    const bytes = Buffer.from(value, 'base64url')
    if (bytes.toString('base64url') !== value) throw new Error('凭据保险柜格式无效')
    return bytes
}

function deriveKey(masterKey: string): Buffer {''')
    s = section(s, 'function parseEnvelope(raw: string): VaultEnvelope {', 'function parseValues(raw: string): VaultValues {', '''function parseEnvelope(raw: string): VaultEnvelope {
    const parsed = JSON.parse(raw) as Partial<VaultEnvelope>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || Object.keys(parsed).some(key => !['v', 'iv', 'tag', 'ciphertext'].includes(key))
        || parsed.v !== 1 || typeof parsed.iv !== 'string'
        || typeof parsed.tag !== 'string' || typeof parsed.ciphertext !== 'string') {
        throw new Error('凭据保险柜格式无效')
    }
    return parsed as VaultEnvelope
}''')
    for key in ['iv', 'tag', 'ciphertext']:
        s = one(s, f"Buffer.from(envelope.{key}, 'base64url')", f'decodeCanonical(envelope.{key})')
    s = one(s, '    const target = vaultPath(dataDir)\n    mkdirSync', "    parseValues(JSON.stringify(values))\n    const target = vaultPath(dataDir)\n    mkdirSync")
    s = one(s, "    const temporary = join(dirname(target),", "    const serialized = `${JSON.stringify(envelope)}\\n`\n    if (Buffer.byteLength(serialized, 'utf8') > MAX_VAULT_BYTES) throw new Error('凭据保险柜异常过大')\n    const temporary = join(dirname(target),")
    s = one(s, "writeFileSync(temporary, `${JSON.stringify(envelope)}\\n`,", 'writeFileSync(temporary, serialized,')
    changes[p] = s

p = ROOT / 'backend/scripts/run-route-smoke-isolated.mjs'
s = p.read_text()
if "from '../../scripts/test-auth.mjs'" not in s:
    s = one(s, "import WebSocket from 'ws'", "import WebSocket from 'ws'\nimport { createIsolatedAuth } from '../../scripts/test-auth.mjs'\nconst testAuth = createIsolatedAuth()")
    s = one(s, "JSON.stringify({ teacherId: 'teacher-001', name: '王雅琴' })", 'JSON.stringify(testAuth.login)')
    s = one(s, "JSON.stringify({ teacherId: 'teacher-not-allowed', name: '越权账号' })", "JSON.stringify({ phone: '13900000001', password: testAuth.login.password })")
    s = one(s, "            SQLITE_PATH: databasePath,", "            SQLITE_PATH: databasePath,\n            APP_DATA_DIR: temporaryRoot,\n            ...testAuth.environment,")
    changes[p] = s
p = ROOT / 'backend/scripts/run-closed-loop-isolated.mjs'
s = p.read_text()
if "from '../../scripts/test-auth.mjs'" not in s:
    s = one(s, "import process from 'node:process'", "import process from 'node:process'\nimport { createIsolatedAuth } from '../../scripts/test-auth.mjs'\nconst testAuth = createIsolatedAuth()")
    s = one(s, 'env: { ...process.env, CLOSED_LOOP_BASE_URL: baseUrl }', 'env: { ...process.env, ...testAuth.environment, CLOSED_LOOP_BASE_URL: baseUrl }')
    s = one(s, "            SQLITE_PATH: databasePath,", "            SQLITE_PATH: databasePath,\n            APP_DATA_DIR: temporaryRoot,\n            ...testAuth.environment,")
    changes[p] = s
p = ROOT / 'backend/scripts/closed-loop-regression.mjs'
s = p.read_text()
if "from '../../scripts/test-auth.mjs'" not in s:
    s = one(s, "import process from 'node:process'", "import process from 'node:process'\nimport { isolatedLogin } from '../../scripts/test-auth.mjs'\nconst testLogin = isolatedLogin()")
    s = one(s, "JSON.stringify({ teacherId: 'teacher-001', name: '王雅琴' })", 'JSON.stringify(testLogin)')
    changes[p] = s

p = ROOT / 'frontend/scripts/run-e2e-isolated.mjs'
s = p.read_text()
if '// ISOLATED_WEBP_FIXTURE_V1' not in s:
    s = one(s, "import { fileURLToPath } from 'node:url'", "import { fileURLToPath } from 'node:url'\nimport { createRequire } from 'node:module'")
    s = section(s, '    const sourceDirectory = path.join(projectRoot,', '    const mediaUrl =', '''    // ISOLATED_WEBP_FIXTURE_V1: a real deterministic WebP, not a user's generated media.
    const generatedDirectory = path.join(runtimeRoot, 'uploads', 'generated')
    await fs.mkdir(generatedDirectory, { recursive: true })
    const mediaFile = 'security-fixture.webp'
    const sharp = createRequire(path.join(backendRoot, 'package.json'))('sharp')
    await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } })
        .webp().toFile(path.join(generatedDirectory, mediaFile))''')
    changes[p] = s

for p, content in changes.items():
    if p.read_text() != content:
        p.write_text(content)
        print('SOURCE_UPDATED ' + str(p.relative_to(ROOT)))
