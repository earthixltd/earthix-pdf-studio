// Keeps the open PDF, every edit and the reading position in this browser, so
// a refresh brings the user back exactly where they were. Nothing is uploaded.

const DB_NAME = 'earthix-working-session'
const STORE = 'session'
const CONTENT_KEY = 'content'
const VIEW_KEY = 'view'

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('Browser storage is unavailable.')); return }
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function withStore(mode, action) {
  const database = await openDatabase()
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE, mode)
      const store = transaction.objectStore(STORE)
      let result
      Promise.resolve(action(store)).then((value) => { result = value }, reject)
      transaction.oncomplete = () => resolve(result)
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    database.close()
  }
}

const put = (key, value) => withStore('readwrite', (store) => { store.put(value, key) })

export async function saveSessionContent(content) {
  try {
    await put(CONTENT_KEY, content)
  } catch (error) {
    // A file handle cannot be stored in every browser; the PDF itself still can.
    if (error?.name !== 'DataCloneError' || !content.fileHandle) throw error
    await put(CONTENT_KEY, { ...content, fileHandle: null })
  }
}

export function saveSessionView(view) {
  return put(VIEW_KEY, view)
}

export async function loadSavedSession() {
  try {
    const database = await openDatabase()
    try {
      const read = (key) => new Promise((resolve, reject) => {
        const request = database.transaction(STORE).objectStore(STORE).get(key)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const [content, view] = await Promise.all([read(CONTENT_KEY), read(VIEW_KEY)])
      return content ? { content, view: view || {} } : null
    } finally {
      database.close()
    }
  } catch {
    return null
  }
}

export function clearSavedSession() {
  return withStore('readwrite', (store) => { store.clear() }).catch(() => undefined)
}
