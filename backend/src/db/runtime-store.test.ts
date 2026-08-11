import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from './index.js'
import { SqliteMap } from './runtime-store.js'

interface RuntimeValue {
    ownerId: string
    payload: string
}

// The test table is deterministic for this worker and is removed explicitly
// below. It never overlaps a production table or another test schema.
const TABLE = `runtime_store_contract_${process.pid}_${Date.now()}`

describe('SqliteMap durability and identifier boundaries', () => {
    beforeAll(() => {
        // Constructing the store exercises self-migration and index creation.
        new SqliteMap<string, RuntimeValue>({
            table: TABLE,
            indexes: [{ name: 'owner_id', extract: (value) => value.ownerId }],
        })
    })

    afterAll(() => {
        db.prepare(`DROP TABLE IF EXISTS "${TABLE}"`).run()
    })

    it('rejects invalid capacity values before creating a store', () => {
        expect(() => new SqliteMap<string, RuntimeValue>({ table: `${TABLE}_zero`, maxSize: 0 }))
            .toThrow(/maxSize must be a positive safe integer/u)
        expect(() => new SqliteMap<string, RuntimeValue>({ table: `${TABLE}_fraction`, maxSize: 1.5 }))
            .toThrow(/maxSize must be a positive safe integer/u)
        expect(() => new SqliteMap<string, RuntimeValue>({ table: `${TABLE}_infinity`, maxSize: Infinity }))
            .toThrow(/maxSize must be a positive safe integer/u)
    })

    it('allows lookup only through configured index columns', () => {
        const store = new SqliteMap<string, RuntimeValue>({
            table: TABLE,
            indexes: [{ name: 'owner_id', extract: (value) => value.ownerId }],
        })
        store.set('one', { ownerId: 'teacher-1', payload: 'safe' })

        expect(store.findByIndex('owner_id', 'teacher-1')).toEqual([
            { key: 'one', value: { ownerId: 'teacher-1', payload: 'safe' } },
        ])
        expect(() => store.findByIndex('value', 'teacher-1')).toThrow(/Unknown SqliteMap index column/u)
        expect(() => store.findByIndex('owner_id" OR 1=1 --', 'teacher-1'))
            .toThrow(/Unknown SqliteMap index column/u)
    })

    it('keeps upsert and LRU eviction within the declared capacity', () => {
        const table = `${TABLE}_bounded`
        const store = new SqliteMap<string, RuntimeValue>({
            table,
            maxSize: 2,
        })

        try {
            store.set('one', { ownerId: 'teacher-1', payload: '1' })
            store.set('two', { ownerId: 'teacher-1', payload: '2' })
            store.set('three', { ownerId: 'teacher-1', payload: '3' })
            expect(store.size).toBe(2)
            expect(store.get('three')).toEqual({ ownerId: 'teacher-1', payload: '3' })
            expect(store.get('one')).toBeUndefined()
        } finally {
            db.prepare(`DROP TABLE IF EXISTS "${table}"`).run()
        }
    })
})

