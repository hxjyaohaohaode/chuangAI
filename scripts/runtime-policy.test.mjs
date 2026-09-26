import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { NODE_ENGINE, isSupportedNode, assertSupportedRuntime } from './runtime-policy.mjs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = name => readFileSync(resolve(root, name), 'utf8')
for (const version of ['24.0.0', '24.21.0', '24.99.99']) {
    test(`accepts supported version ${version}`, () => { assert.equal(isSupportedNode(version), true); assert.equal(assertSupportedRuntime('test', version), version) })
}
for (const version of ['20.19.0', '22.16.0', '25.0.0', '26.0.0', '', 'v24.21.0', '24.invalid.0']) {
    test(`rejects unsupported or malformed version ${JSON.stringify(version)}`, () => { assert.equal(isSupportedNode(version), false); assert.throws(() => assertSupportedRuntime('test', version)) })
}
test('all inspected entrypoints use one policy and parse successfully', () => {
    for (const name of ['scripts/render-build.mjs', 'scripts/render-start.mjs', 'scripts/competition-preflight.mjs', 'frontend/scripts/run-e2e-isolated.mjs']) {
        assert.match(read(name), /from ['"].*runtime-policy\.mjs['"]/)
        execFileSync(process.execPath, ['--check', resolve(root, name)], { stdio: 'pipe' })
    }
})
test('both package engines agree with the source-controlled policy', () => {
    for (const area of ['backend', 'frontend']) assert.equal(JSON.parse(read(`${area}/package.json`)).engines.node, NODE_ENGINE)
    assert.equal(read('.nvmrc').trim(), '24')
    assert.equal(read('.node-version').trim(), '24')
})
test('deployment template contains no published password verifier or personal phone', () => {
    const config = read('render.yaml')
    assert.doesNotMatch(config, /scrypt\$/)
    assert.doesNotMatch(config, /AUTH_TEACHER_PHONE/)
    assert.match(config, /key: AUTH_PASSWORD_SCRYPT\s+sync: false/)
    assert.match(config, /key: SEED_LEARNING_DEMO\s+value: "false"/)
    assert.match(config, /key: AUTH_MODE\s+value: password/)
})
