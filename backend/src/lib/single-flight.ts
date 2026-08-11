/** 同一 key 的并发异步任务共享一个 Promise；完成或失败后自动释放，允许后续重试。 */
export class SingleFlight<K, V> {
    private readonly active = new Map<K, Promise<V>>()

    run(key: K, task: () => Promise<V>): Promise<V> {
        const existing = this.active.get(key)
        if (existing) return existing

        const operation = Promise.resolve().then(task)
        const tracked = operation.finally(() => {
            if (this.active.get(key) === tracked) this.active.delete(key)
        })
        this.active.set(key, tracked)
        return tracked
    }
}
