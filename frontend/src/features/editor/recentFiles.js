// Every PDF opened in this browser, kept here so Home can list and reopen them.
// The files stay on this device; nothing is uploaded.

const DB_NAME = 'earthix-recent-files'
const STORE = 'files'

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('Browser storage is unavailable.')); return }
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function run(mode, action) {
  const database = await openDatabase()
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE, mode)
      const request = action(transaction.objectStore(STORE))
      transaction.oncomplete = () => resolve(request?.result)
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    database.close()
  }
}

/** Newest first. */
export async function listRecentFiles() {
  try {
    const records = await run('readonly', (store) => store.getAll())
    return (records || []).sort((a, b) => String(b.openedAt).localeCompare(String(a.openedAt)))
  } catch {
    return []
  }
}

export const removeRecentFile = (id) => run('readwrite', (store) => store.delete(id)).catch(() => undefined)

async function store(record) {
  try {
    await run('readwrite', (objects) => objects.put(record))
    return true
  } catch (error) {
    // A file handle can't be stored in every browser; the PDF itself still can.
    if (error?.name === 'DataCloneError' && record.handle) return store({ ...record, handle: null })
    if (error?.name !== 'QuotaExceededError') return false
    // Out of browser space: make room by dropping the oldest file.
    const oldest = (await listRecentFiles()).filter((item) => item.id !== record.id).at(-1)
    if (!oldest) return false
    await removeRecentFile(oldest.id)
    return store(record)
  }
}

/** Add or refresh a file; `replacesId` is its entry from before it was saved. Returns the id. */
export async function rememberRecentFile(file, handle = null, replacesId = null) {
  const id = `${file.name}|${file.size}`
  const saved = await store({ id, name: file.name, size: file.size, file, handle, openedAt: new Date().toISOString() })
  if (saved && replacesId && replacesId !== id) await removeRecentFile(replacesId)
  return saved ? id : null
}
