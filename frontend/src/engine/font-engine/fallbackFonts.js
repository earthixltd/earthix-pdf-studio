import { createEmbeddedFontEncoder, createStandardFontEncoder, fontCoversText, openFontProgram } from './fontEmbedder.js'
import { normalizeFontKey } from './pdfFontLoader.js'
import { standardFamilyFor, standardFontName } from './standardFonts.js'

const SANS = ['Arial', 'Helvetica', 'Liberation Sans', 'Arimo', 'Segoe UI', 'DejaVu Sans', 'Noto Sans']
const SERIF = ['Times New Roman', 'Times', 'Liberation Serif', 'Tinos', 'Georgia', 'DejaVu Serif', 'Noto Serif']
const MONO = ['Courier New', 'Courier', 'Liberation Mono', 'Cousine', 'Consolas', 'DejaVu Sans Mono']

const SUBSTITUTES = {
  helvetica: ['Helvetica', 'Arial', 'Liberation Sans', 'Arimo', 'Nimbus Sans'],
  helveticaneue: ['Helvetica Neue', 'Helvetica', 'Arial'],
  arial: ['Arial', 'Liberation Sans', 'Arimo', 'Helvetica'],
  arialnarrow: ['Arial Narrow', 'Liberation Sans Narrow', 'Arial'],
  timesnewroman: ['Times New Roman', 'Liberation Serif', 'Tinos', 'Times'],
  times: ['Times New Roman', 'Times', 'Liberation Serif', 'Tinos'],
  timesroman: ['Times New Roman', 'Times', 'Liberation Serif', 'Tinos'],
  couriernew: ['Courier New', 'Liberation Mono', 'Cousine', 'Courier'],
  courier: ['Courier New', 'Courier', 'Liberation Mono', 'Cousine'],
  calibri: ['Calibri', 'Carlito', 'Segoe UI', 'Arial'],
  calibrilight: ['Calibri Light', 'Calibri', 'Carlito', 'Segoe UI'],
  cambria: ['Cambria', 'Caladea', 'Georgia', 'Times New Roman'],
  candara: ['Candara', 'Segoe UI', 'Arial'],
  verdana: ['Verdana', 'DejaVu Sans', 'Tahoma', 'Arial'],
  tahoma: ['Tahoma', 'Verdana', 'Segoe UI', 'Arial'],
  segoeui: ['Segoe UI', 'Arial'],
  georgia: ['Georgia', 'Times New Roman'],
  garamond: ['Garamond', 'EB Garamond', 'Georgia', 'Times New Roman'],
  bookantiqua: ['Book Antiqua', 'Palatino Linotype', 'Palatino', 'Georgia'],
  palatinolinotype: ['Palatino Linotype', 'Book Antiqua', 'Palatino', 'Georgia'],
  centurygothic: ['Century Gothic', 'Arial'],
  trebuchetms: ['Trebuchet MS', 'Segoe UI', 'Arial'],
  roboto: ['Roboto', 'Segoe UI', 'Arial'],
  opensans: ['Open Sans', 'Segoe UI', 'Arial'],
  lato: ['Lato', 'Segoe UI', 'Arial'],
  montserrat: ['Montserrat', 'Segoe UI', 'Arial'],
  poppins: ['Poppins', 'Segoe UI', 'Arial'],
  sourcesanspro: ['Source Sans Pro', 'Source Sans 3', 'Segoe UI', 'Arial'],
}

const SCRIPT_FALLBACKS = [
  [/[ऀ-ॿ]/, ['Nirmala UI', 'Mangal', 'Kokila', 'Aparajita', 'Noto Sans Devanagari', 'Lohit Devanagari']],
  [/[ঀ-৿]/, ['Nirmala UI', 'Vrinda', 'Noto Sans Bengali']],
  [/[਀-੿]/, ['Nirmala UI', 'Raavi', 'Noto Sans Gurmukhi']],
  [/[઀-૿]/, ['Nirmala UI', 'Shruti', 'Noto Sans Gujarati']],
  [/[஀-௿]/, ['Nirmala UI', 'Latha', 'Noto Sans Tamil']],
  [/[ఀ-౿]/, ['Nirmala UI', 'Gautami', 'Noto Sans Telugu']],
  [/[؀-ۿ]/, ['Segoe UI', 'Arial', 'Tahoma', 'Noto Naskh Arabic']],
  [/[一-鿿぀-ヿ]/, ['Microsoft YaHei', 'SimSun', 'Yu Gothic', 'MS Gothic', 'Noto Sans CJK SC']],
  [/[Ѐ-ӿͰ-Ͽ]/, ['Arial', 'Times New Roman', 'Segoe UI']],
  [/[₹]/, ['Nirmala UI', 'Segoe UI', 'Arial']],
]

const isBoldStyle = (style) => /bold|black|heavy|semibold|demi/i.test(style || '')
const isItalicStyle = (style) => /italic|oblique/i.test(style || '')
const isUnusualStyle = (style) => /light|thin|narrow|condensed|extended|medium|semilight|extra|ultra/i.test(style || '')

function styleScore(entry, request) {
  return (isBoldStyle(entry.style) !== Boolean(request.bold) ? 4 : 0) +
    (isItalicStyle(entry.style) !== Boolean(request.italic) ? 2 : 0) +
    (isUnusualStyle(entry.style) ? 1 : 0)
}

/**
 * A font provider returns font files that can be embedded. Entries look like
 * { postscriptName, fullName, family, style, load(): Promise<Uint8Array> }.
 */
export function createStaticFontProvider(entries) {
  return {
    supported: true,
    async listFonts() { return entries },
    async prepare() { return entries },
  }
}

/** Local Font Access (Chrome/Edge): reads the user's installed fonts after permission. */
export function createLocalFontProvider() {
  const supported = typeof globalThis.queryLocalFonts === 'function'
  let listPromise = null
  let denied = false
  let status = supported ? 'unknown' : 'unsupported'
  const toEntries = (fonts) => fonts.map((font) => ({
    postscriptName: font.postscriptName,
    fullName: font.fullName,
    family: font.family,
    style: font.style,
    async load() { return new Uint8Array(await (await font.blob()).arrayBuffer()) },
  }))
  const list = async () => {
    if (!supported || denied) return []
    if (!listPromise) {
      listPromise = globalThis.queryLocalFonts()
        .then((fonts) => {
          // An empty list means the browser (or the user) did not grant font access.
          status = fonts.length ? 'granted' : 'denied'
          if (!fonts.length) listPromise = null
          return toEntries(fonts)
        })
        .catch((error) => {
          if (error?.name === 'NotAllowedError') { denied = true; status = 'denied' }
          listPromise = null
          return []
        })
    }
    return listPromise
  }
  return {
    supported,
    get denied() { return denied },
    get status() { return status },
    listFonts: list,
    // Call from a user gesture (click/key) so the browser can show its permission prompt.
    prepare: list,
  }
}

function candidateFamilies(request, text) {
  const familyKey = normalizeFontKey(request.family)
  const families = []
  const push = (value) => { if (value && !families.some((existing) => normalizeFontKey(existing) === normalizeFontKey(value))) families.push(value) }
  for (const [key, list] of Object.entries(SUBSTITUTES)) {
    if (familyKey === key || familyKey.startsWith(key)) list.forEach(push)
  }
  for (const [pattern, list] of SCRIPT_FALLBACKS) if (pattern.test(text)) list.forEach(push)
  const base = request.fixedPitch ? MONO : request.serif ? SERIF : SANS
  base.forEach(push)
  ;['Segoe UI', 'Arial Unicode MS', 'Noto Sans', 'Nirmala UI'].forEach(push)
  return families
}

/**
 * Choose a font for replacement text that the original (subset) font cannot
 * draw. Order: the same font installed on this computer, a similar installed
 * font, then a standard PDF font. Returns { encoder, match, label } or null.
 */
export async function resolveFallbackFont(request, text, fontProvider) {
  const entries = fontProvider ? await fontProvider.listFonts().catch(() => []) : []
  const tried = new Set()
  const tryEntry = async (entry, match) => {
    if (!entry || tried.has(entry.postscriptName + '|' + entry.fullName)) return null
    tried.add(entry.postscriptName + '|' + entry.fullName)
    try {
      const bytes = await entry.load()
      const program = await openFontProgram(bytes, entry.postscriptName)
      if (!fontCoversText(program, text)) return null
      const encoder = await createEmbeddedFontEncoder(bytes, entry.postscriptName, entry.fullName)
      return { encoder, match, label: entry.fullName || entry.postscriptName }
    } catch {
      return null
    }
  }

  if (entries.length) {
    const wantPostscript = normalizeFontKey(request.postscriptName)
    const wantFamily = normalizeFontKey(request.family)
    // 1. Exact PostScript name.
    for (const entry of entries.filter((item) => normalizeFontKey(item.postscriptName) === wantPostscript)) {
      const result = await tryEntry(entry, 'exact')
      if (result) return result
    }
    // 2. Same family, best matching style.
    const sameFamily = entries
      .filter((item) => normalizeFontKey(item.family) === wantFamily || normalizeFontKey(item.fullName) === wantFamily)
      .sort((a, b) => styleScore(a, request) - styleScore(b, request))
    for (const entry of sameFamily) {
      const result = await tryEntry(entry, styleScore(entry, request) === 0 ? 'exact' : 'similar')
      if (result) return result
    }
    // 3. Similar families.
    for (const family of candidateFamilies(request, text)) {
      const familyKey = normalizeFontKey(family)
      const matches = entries
        .filter((item) => normalizeFontKey(item.family) === familyKey)
        .sort((a, b) => styleScore(a, request) - styleScore(b, request))
      for (const entry of matches) {
        const result = await tryEntry(entry, 'similar')
        if (result) return result
      }
    }
  }

  // 4. Standard PDF fonts (no embedding needed, Latin text only).
  const family = standardFamilyFor(normalizeFontKey(request.family), { serif: request.serif, fixedPitch: request.fixedPitch })
  const standardName = standardFontName(family === 'Symbol' || family === 'ZapfDingbats' ? 'Helvetica' : family, request.bold, request.italic)
  const encoder = createStandardFontEncoder(standardName)
  if (encoder.canEncode(text)) return { encoder, match: 'standard', label: standardName }
  return null
}
