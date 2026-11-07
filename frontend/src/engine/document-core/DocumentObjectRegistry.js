import { PdfEngineError } from '../engineErrors.js'

function clone(value) {
  try {
    return value == null ? value : structuredClone(value)
  } catch (error) {
    throw new PdfEngineError('Document objects must contain structured-cloneable data only.', {
      code: 'NON_SERIALIZABLE_DOCUMENT_OBJECT',
      cause: error,
    })
  }
}

function normalizeObject(object, pageCount) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) {
    throw new PdfEngineError('A document object must be a plain object.', { code: 'INVALID_DOCUMENT_OBJECT' })
  }
  if (typeof object.id !== 'string' || !object.id.trim()) {
    throw new PdfEngineError('A document object requires a stable non-empty id.', { code: 'INVALID_DOCUMENT_OBJECT' })
  }
  if (typeof object.type !== 'string' || !object.type.trim()) {
    throw new PdfEngineError('A document object requires a type.', { code: 'INVALID_DOCUMENT_OBJECT_TYPE' })
  }
  if (!Number.isInteger(object.pageIndex) || object.pageIndex < 0 || object.pageIndex >= pageCount) {
    throw new PdfEngineError('A document object references an invalid page.', { code: 'INVALID_OBJECT_PAGE' })
  }
  if (object.bounds !== undefined && object.bounds !== null) {
    const { x, y, width, height } = object.bounds
    if (![x, y, width, height].every(Number.isFinite) || width < 0 || height < 0) {
      throw new PdfEngineError('Document object bounds must contain finite coordinates and non-negative dimensions.', {
        code: 'INVALID_DOCUMENT_OBJECT_BOUNDS',
      })
    }
  }
  return clone({ ...object, id: object.id.trim(), type: object.type.trim() })
}

export class DocumentObjectRegistry {
  #objects = new Map()
  #pageCount = 0

  constructor(pageCount = 0, objects = []) {
    if (!Number.isInteger(pageCount) || pageCount < 0) {
      throw new PdfEngineError('Object registry page count must be non-negative.', { code: 'INVALID_PAGE_COUNT' })
    }
    this.#pageCount = pageCount
    this.restore(objects, pageCount)
  }

  get count() {
    return this.#objects.size
  }

  has(id) {
    return this.#objects.has(id)
  }

  upsert(object) {
    const normalized = normalizeObject(object, this.#pageCount)
    this.#objects.set(normalized.id, normalized)
    return this.get(normalized.id)
  }

  update(id, patch) {
    const existing = this.#objects.get(id)
    if (!existing) throw new PdfEngineError(`Document object "${id}" does not exist.`, { code: 'DOCUMENT_OBJECT_NOT_FOUND' })
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new PdfEngineError('Document object updates must be an object.', { code: 'INVALID_DOCUMENT_OBJECT_PATCH' })
    }
    return this.upsert({ ...existing, ...patch, id: existing.id })
  }

  get(id) {
    return clone(this.#objects.get(id) || null)
  }

  remove(id) {
    const existing = this.#objects.get(id)
    if (!existing) return null
    this.#objects.delete(id)
    return clone(existing)
  }

  list() {
    return clone([...this.#objects.values()])
  }

  listByPage(pageIndex) {
    return clone([...this.#objects.values()].filter((object) => object.pageIndex === pageIndex))
  }

  snapshot() {
    return this.list()
  }

  restore(objects = [], pageCount = this.#pageCount) {
    if (!Number.isInteger(pageCount) || pageCount < 0 || !Array.isArray(objects)) {
      throw new PdfEngineError('Object registry snapshot is invalid.', { code: 'INVALID_OBJECT_REGISTRY_SNAPSHOT' })
    }
    const nextObjects = new Map()
    for (const object of objects) {
      const normalized = normalizeObject(object, pageCount)
      if (nextObjects.has(normalized.id)) {
        throw new PdfEngineError(`Document object id "${normalized.id}" is duplicated.`, { code: 'DUPLICATE_DOCUMENT_OBJECT_ID' })
      }
      nextObjects.set(normalized.id, normalized)
    }
    this.#pageCount = pageCount
    this.#objects = nextObjects
  }
}
