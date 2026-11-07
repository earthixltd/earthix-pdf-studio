export class MemoryCheckpointStorage {
  #records = new Map()

  async save(checkpoint) {
    this.#records.set(checkpoint.documentId, structuredClone(checkpoint))
    return checkpoint.documentId
  }

  async load(documentId) {
    const record = this.#records.get(documentId)
    return record ? structuredClone(record) : null
  }

  async delete(documentId) {
    return this.#records.delete(documentId)
  }

  async list() {
    return [...this.#records.values()].map((record) => structuredClone(record))
  }
}
