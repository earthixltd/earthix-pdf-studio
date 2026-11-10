// Where the editor's fonts come from: files the user added, fonts on this
// computer and the free library. Added fonts stay in this browser.

import { openFontProgram } from '../../engine/font-engine/fontEmbedder.js'
import { createLocalFontProvider } from '../../engine/font-engine/fallbackFonts.js'
import { FREE_FONT_FAMILIES, createCombinedFontProvider, createFontLibrary, fontFileUrl } from '../../engine/font-engine/fontLibrary.js'
import { weightFromStyle } from '../../engine/font-engine/pdfFontLoader.js'

const DB_NAME = 'earthix-uploaded-fonts'
const STORE = 'fonts'

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('Browser storage is unavailable.')); return }
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'postscriptName' })
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

const registered = new Set()

/** Lets the browser draw an added font on screen too. */
async function registerFace(record) {
  if (registered.has(record.postscriptName) || typeof FontFace === 'undefined') return
  registered.add(record.postscriptName)
  const face = new FontFace(record.family, record.bytes, {
    weight: String(weightFromStyle(record.style) ?? 400),
    style: /italic|oblique/i.test(record.style || '') ? 'italic' : 'normal',
  })
  document.fonts.add(await face.load().catch(() => face))
}

let uploadsPromise = null

function loadUploads() {
  if (!uploadsPromise) {
    uploadsPromise = run('readonly', (store) => store.getAll()).then((records) => (records || []).map((record) => {
      void registerFace(record)
      return { ...record, source: 'uploaded', load: async () => record.bytes }
    }))
    uploadsPromise.catch(() => { uploadsPromise = null })
  }
  return uploadsPromise
}

export const listUploadedFonts = loadUploads

/** Read a .ttf or .otf file and keep it. Throws when it isn't a usable font. */
export async function addUploadedFont(file) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const program = await openFontProgram(bytes)
  if (!program.familyName || !program.numGlyphs) throw new Error('This file has no usable letters.')
  const record = {
    postscriptName: program.postscriptName || `${program.familyName}-${program.subfamilyName || 'Regular'}`,
    fullName: program.fullName || program.familyName,
    family: program.familyName,
    style: program.subfamilyName || 'Regular',
    bytes,
  }
  await run('readwrite', (store) => store.put(record))
  uploadsPromise = null
  return record
}

let freeFacesDeclared = false

/** Tells the browser where the listed free fonts live; each downloads only when first drawn. */
export function declareFreeFontFaces(rows) {
  if (freeFacesDeclared || typeof FontFace === 'undefined') return
  freeFacesDeclared = true
  for (const row of rows) {
    if (!FREE_FONT_FAMILIES.includes(row.f) || !row.s.includes('latin')) continue
    const styles = [...(row.n === 0 ? [] : ['normal']), ...(row.t ? ['italic'] : [])]
    for (const weight of row.w) {
      for (const style of styles) {
        document.fonts.add(new FontFace(row.f, `url("${fontFileUrl(row.i, 'latin', weight, style)}") format("truetype")`, { weight: String(weight), style }))
      }
    }
  }
}

const asset = (path) => `${import.meta.env?.BASE_URL || '/'}${path}`

export function createAppFontProvider() {
  const library = createFontLibrary({
    catalog: async () => {
      const response = await fetch(asset('fonts/catalog.json'), { signal: AbortSignal.timeout(10000) })
      if (!response.ok) throw new Error('The font list could not be read.')
      return response.json()
    },
    download: async (url) => {
      const response = await fetch(url, { signal: AbortSignal.timeout(10000) })
      if (!response.ok) throw new Error('This font could not be downloaded.')
      return new Uint8Array(await response.arrayBuffer())
    },
  })
  return createCombinedFontProvider(createLocalFontProvider(), library, { list: loadUploads })
}
