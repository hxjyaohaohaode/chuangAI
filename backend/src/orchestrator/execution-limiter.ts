/** FIFO, abortable admission control for shared Agent instances. */
interface Ticket {
    key: string
    signal: AbortSignal
    resolve: (release: () => void) => void
    reject: (error: Error) => void
    onAbort: () => void
}
export class ExecutionLimiter {
    private active = 0
    private readonly busy = new Set<string>()
    private readonly queue: Ticket[] = []
    constructor(private readonly limit = 8, private readonly maxQueue = 256) {
        if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(maxQueue) || maxQueue < 1) throw new Error('Invalid execution limits')
    }
    acquire(key: string, signal: AbortSignal): Promise<() => void> {
        if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
        if (this.queue.length >= this.maxQueue) return Promise.reject(new Error('执行队列已满，请稍后重试'))
        return new Promise((resolve, reject) => {
            const ticket: Ticket = { key, signal, resolve, reject, onAbort: () => {
                const index = this.queue.indexOf(ticket)
                if (index !== -1) {
                    this.queue.splice(index, 1)
                    reject(new DOMException('Aborted', 'AbortError'))
                    this.drain()
                }
            } }
            signal.addEventListener('abort', ticket.onAbort, { once: true })
            this.queue.push(ticket)
            this.drain()
        })
    }
    private drain(): void {
        for (let i = 0; i < this.queue.length && this.active < this.limit;) {
            const ticket = this.queue[i]!
            if (this.busy.has(ticket.key)) { i++; continue }
            this.queue.splice(i, 1)
            ticket.signal.removeEventListener('abort', ticket.onAbort)
            if (ticket.signal.aborted) { ticket.reject(new DOMException('Aborted', 'AbortError')); continue }
            this.active++
            this.busy.add(ticket.key)
            let released = false
            ticket.resolve(() => {
                if (released) return
                released = true
                this.active--
                this.busy.delete(ticket.key)
                this.drain()
            })
        }
    }
    snapshot(): { active: number; queued: number } {
        return { active: this.active, queued: this.queue.length }
    }
}
