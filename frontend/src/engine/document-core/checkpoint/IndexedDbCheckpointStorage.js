import { PdfEngineError } from '../../engineErrors.js'

const DATABASE_VERSION = 1
const DEFAULT_DATABASE_NAME = 'earthix-pdf-studio'
const DEFAULT_STORE_NAME = 'document-checkpoints'

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'))
  })
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed.'))
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction was aborted.'))
  })
}

export class IndexedDbCheckpointStorage {
  #databaseName
  #storeName
  #indexedDB
  #databasePromise = null

  constructor({ databaseName = DEFAULT_DATABASE_NAME, storeName = DEFAULT_STORE_NAME, indexedDBRef = globalThis.indexedDB } = {}) {
    this.#databaseName = databaseName
    this.#storeName = storeName
    this.#indexedDB = indexedDBRef
  }

  async #database() {
    if (!this.#indexedDB) {
      throw new PdfEngineError('Local autosave is unavailable because IndexedDB is not supported.', { code: 'CHECKPOINT_STORAGE_UNAVAILABLE' })
    }
    if (!this.#databasePromise) {
      this.#databasePromise = new Promise((resolve, reject) => {
        const request = this.#indexedDB.open(this.#databaseName, DATABASE_VERSION)
        request.onupgradeneeded = () => {
          const database = request.result
          if (!database.objectStoreNames.contains(this.#storeName)) {
            database.createObjectStore(this.#storeName, { keyPath: 'documentId' })
          }
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error || new Error('Could not open local autosave storage.'))
        request.onblocked = () => reject(new Error('Local autosave database upgrade is blocked by another tab.'))
      }).catch((error) => {
        this.#databasePromise = null
        throw error
      })
    }
    return this.#databasePromise
  }

  async save(checkpoint) {
    const database = await this.#database()
    const transaction = database.transaction(this.#storeName, 'readwrite')
    transaction.objectStore(this.#storeName).put(checkpoint)
    await transactionDone(transaction)
    return checkpoint.documentId
  }

  async load(documentId) {
    const database = await this.#database()
    const transaction = database.transaction(this.#storeName, 'readonly')
    const request = transaction.objectStore(this.#storeName).get(documentId)
    const [record] = await Promise.all([requestResult(request), transactionDone(transaction)])
    return record || null
  }

  async delete(documentId) {
    const database = await this.#database()
    const transaction = database.transaction(this.#storeName, 'readwrite')
    transaction.objectStore(this.#storeName).delete(documentId)
    await transactionDone(transaction)
  }

  async list() {
    const database = await this.#database()
    const transaction = database.transaction(this.#storeName, 'readonly')
    const request = transaction.objectStore(this.#storeName).getAll()
    const [records] = await Promise.all([requestResult(request), transactionDone(transaction)])
    return records || []
  }

  async close() {
    if (!this.#databasePromise) return
    const database = await this.#databasePromise.catch(() => null)
    database?.close()
    this.#databasePromise = null
  }
}
