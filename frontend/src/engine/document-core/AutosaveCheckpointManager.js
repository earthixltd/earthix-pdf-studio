export class AutosaveCheckpointManager {
  #storage
  #delayMs
  #timer = null
  #pendingCore = null
  #onStatus
  #flushPromise = null

  constructor({ storage, delayMs = 900, onStatus = () => {} } = {}) {
    this.#storage = storage
    this.#delayMs = delayMs
    this.#onStatus = onStatus
  }

  schedule(core) {
    if (!this.#storage || !core) return
    this.#pendingCore = core
    if (this.#timer) clearTimeout(this.#timer)
    this.#onStatus('pending')
    this.#timer = setTimeout(() => {
      this.#timer = null
      void this.flush().catch(() => undefined)
    }, this.#delayMs)
  }

  async flush() {
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    if (this.#flushPromise) {
      await this.#flushPromise
      return this.#pendingCore ? this.flush() : null
    }
    if (!this.#pendingCore || !this.#storage) return null
    this.#flushPromise = (async () => {
      let lastResult = null
      while (this.#pendingCore) {
        const core = this.#pendingCore
        this.#pendingCore = null
        this.#onStatus('saving')
        try {
          lastResult = await this.#storage.save(core.createCheckpoint())
          this.#onStatus('saved')
        } catch (error) {
          this.#onStatus('error', error)
          throw error
        }
      }
      return lastResult
    })().finally(() => {
      this.#flushPromise = null
      // A change can arrive while an IndexedDB write is in flight. Do not
      // lose that checkpoint if its debounce timer fired during the write.
      if (this.#pendingCore && !this.#timer) {
        this.#timer = setTimeout(() => {
          this.#timer = null
          void this.flush().catch(() => undefined)
        }, this.#delayMs)
      }
    })
    return this.#flushPromise
  }

  async clear(documentId) {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
    this.#pendingCore = null
    if (this.#flushPromise) await this.#flushPromise.catch(() => undefined)
    if (this.#storage && documentId) await this.#storage.delete(documentId)
    this.#onStatus('idle')
  }

  async close({ flush = true, documentId } = {}) {
    if (flush) await this.flush().catch(() => undefined)
    else if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
    this.#pendingCore = null
    if (documentId && !flush) await this.#storage?.delete?.(documentId)
  }
}
