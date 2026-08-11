import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { atomicWriteFileSync } from './atomic-file.js'
import { SingleFlight } from './single-flight.js'

const testDirectory = join(tmpdir(), `poetic-realm-reliability-${process.pid}-${Date.now()}`)
mkdirSync(testDirectory, { recursive: false })

afterAll(() => {
    if (existsSync(testDirectory)) rmSync(testDirectory, { recursive: true })
})

describe('reliability primitives', () => {
    it('atomically creates and replaces a file without retaining temp siblings', () => {
        const target = join(testDirectory, 'index.json')
        atomicWriteFileSync(target, '{"version":1}')
        atomicWriteFileSync(target, '{"version":2}')
        expect(readFileSync(target, 'utf8')).toBe('{"version":2}')
        expect(readdirSync(testDirectory)).toEqual(['index.json'])
    })

    it('coalesces concurrent work for the same key but not different keys', async () => {
        const flight = new SingleFlight<string, string>()
        const task = vi.fn(async () => {
            await Promise.resolve()
            return 'done'
        })
        const first = flight.run('same', task)
        const second = flight.run('same', task)
        const other = flight.run('other', task)
        expect(first).toBe(second)
        await expect(Promise.all([first, second, other])).resolves.toEqual(['done', 'done', 'done'])
        expect(task).toHaveBeenCalledTimes(2)
    })

    it('evicts a rejected operation so the same key can be retried', async () => {
        const flight = new SingleFlight<string, string>()
        await expect(flight.run('retry', async () => { throw new Error('first failure') }))
            .rejects.toThrow('first failure')
        await expect(flight.run('retry', async () => 'recovered')).resolves.toBe('recovered')
    })
})
