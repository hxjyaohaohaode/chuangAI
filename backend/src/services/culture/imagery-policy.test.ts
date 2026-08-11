import { describe, expect, it } from 'vitest'
import { isKnownImagery } from './imagery-policy.js'

describe('isKnownImagery', () => {
    it('接受词典中的精确意象', () => {
        expect(isKnownImagery('明月')).toBe(true)
    })

    it('接受可追溯的包含关系别名', () => {
        expect(isKnownImagery('月')).toBe(true)
        expect(isKnownImagery('明月意象')).toBe(true)
    })

    it('接受仅由诗词种子数据收录的意象', () => {
        expect(isKnownImagery('绿水')).toBe(true)
    })

    it('拒绝空白与未知路径参数', () => {
        expect(isKnownImagery('   ')).toBe(false)
        expect(isKnownImagery('audit-invalid-imageName')).toBe(false)
    })
})
