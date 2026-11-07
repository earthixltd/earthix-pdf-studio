import { isDelimiter, isWhite, latin1, PdfDict, PdfName, PdfRef, readHexStringBytes, readLiteralStringBytes } from '../pdf-parser/pdfSyntax.js'
import { loadPdfFont } from '../font-engine/pdfFontLoader.js'

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/

function findInlineImageEnd(source, start) {
  // Binary data runs until whitespace + "EI" + (whitespace | EOF).
  let index = start
  for (;;) {
    const marker = source.indexOf('EI', index)
    if (marker < 0) return source.length
    const before = source.charCodeAt(marker - 1)
    const after = source[marker + 2]
    if (isWhite(before) && (after === undefined || isWhite(after.charCodeAt(0)))) return marker
    index = marker + 2
  }
}

export function tokenizeContent(source) {
  const tokens = []
  let index = 0
  const length = source.length
  while (index < length) {
    const code = source.charCodeAt(index)
    if (isWhite(code)) { index += 1; continue }
    const char = source[index]
    if (char === '%') {
      while (index < length && source[index] !== '\n' && source[index] !== '\r') index += 1
      continue
    }
    if (char === '(') {
      const { bytes, end } = readLiteralStringBytes(source, index)
      tokens.push({ type: 'string', bytes, start: index, end })
      index = end
      continue
    }
    if (char === '<' && source[index + 1] === '<') { tokens.push({ type: 'dictStart', start: index, end: index + 2 }); index += 2; continue }
    if (char === '>' && source[index + 1] === '>') { tokens.push({ type: 'dictEnd', start: index, end: index + 2 }); index += 2; continue }
    if (char === '<') {
      const { bytes, end } = readHexStringBytes(source, index)
      tokens.push({ type: 'string', bytes, hex: true, start: index, end })
      index = end
      continue
    }
    if (char === '[') { tokens.push({ type: 'arrayStart', start: index, end: index + 1 }); index += 1; continue }
    if (char === ']') { tokens.push({ type: 'arrayEnd', start: index, end: index + 1 }); index += 1; continue }
    if (char === '{' || char === '}' || char === ')' || char === '>') { index += 1; continue }
    if (char === '/') {
      const start = index++
      while (index < length && !isWhite(source.charCodeAt(index)) && !isDelimiter(source[index])) index += 1
      tokens.push({ type: 'name', value: source.slice(start + 1, index), start, end: index })
      continue
    }
    const start = index
    while (index < length && !isWhite(source.charCodeAt(index)) && !isDelimiter(source[index])) index += 1
    if (index === start) { index += 1; continue }
    const value = source.slice(start, index)
    if (NUMBER.test(value)) tokens.push({ type: 'number', value: Number(value), start, end: index })
    else if (value === 'true' || value === 'false' || value === 'null') tokens.push({ type: 'literal', value, start, end: index })
    else {
      tokens.push({ type: 'op', value, start, end: index })
      if (value === 'ID') {
        // Skip one whitespace byte then the binary inline image data.
        const dataEnd = findInlineImageEnd(source, index + 1)
        index = dataEnd
      }
    }
  }
  return tokens
}

// ---------------------------------------------------------------------------
// Matrices
// ---------------------------------------------------------------------------

export const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0])

export function multiply(m1, m2) {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ]
}

export function applyPoint(m, x, y) {
  return { x: x * m[0] + y * m[2] + m[4], y: x * m[1] + y * m[3] + m[5] }
}

export function applyVector(m, x, y) {
  return { x: x * m[0] + y * m[2], y: x * m[1] + y * m[3] }
}

const length = (vector) => Math.hypot(vector.x, vector.y)

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0))
function toHex(red, green, blue) {
  return '#' + [red, green, blue].map((value) => Math.round(clamp01(value) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()
}

function colorFromComponents(components) {
  if (components.length === 1) return toHex(components[0], components[0], components[0])
  if (components.length === 3) return toHex(...components)
  if (components.length === 4) {
    const [c, m, y, k] = components.map(clamp01)
    return toHex((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k))
  }
  return null
}

// ---------------------------------------------------------------------------
// Interpreter
// ---------------------------------------------------------------------------

function createGraphicsState() {
  return {
    ctm: [...IDENTITY],
    fontResource: null,
    font: null,
    fontSize: 0,
    charSpacing: 0,
    wordSpacing: 0,
    horizontalScaling: 100,
    leading: 0,
    rise: 0,
    renderMode: 0,
    fillColor: '#000000',
    strokeColor: '#000000',
    // Exact operators that re-establish the current colours (used to restore
    // the colour after a restyled text block).
    fillColorOps: '0 g',
    strokeColorOps: '0 G',
    fillSpaceOp: null,
    strokeSpaceOp: null,
    fontFromExtGState: false,
  }
}

function cloneGraphicsState(state) {
  return { ...state, ctm: [...state.ctm] }
}

function resolveDict(index, value) {
  const resolved = index.resolve(value)
  return resolved instanceof PdfDict ? resolved : null
}

/**
 * Interpret the content streams of one page and return every text-showing
 * operation with its decoded text, glyph metrics and geometry in PDF user space.
 */
export async function interpretPageText(index, page, pageIndex, context) {
  const { fontCache, streams, runs } = context
  // Painted line segments (table borders, box edges) used to keep columns apart.
  if (!context.rules) context.rules = new Map()
  if (!context.rules.has(pageIndex)) context.rules.set(pageIndex, [])
  const pageRules = context.rules.get(pageIndex)
  let path = []
  let currentPoint = null
  let subpathStart = null
  const pageResources = resolveDict(index, page.inherited.Resources?.value) || new PdfDict()
  const contents = index.resolve(page.dict.get('Contents'))
  const contentRefs = (contents instanceof PdfRef ? [contents] : Array.isArray(contents) ? contents : [page.dict.get('Contents')])
    .filter((item) => item instanceof PdfRef)

  let state = createGraphicsState()
  const stack = []
  const text = { matrix: [...IDENTITY], lineMatrix: [...IDENTITY], positioned: true, btId: 0, previousRunKey: null }
  let btCounter = 0
  let sequence = runs.length

  const getFont = async (resources, resourceName, streamKey) => {
    const fonts = resolveDict(index, resources.get('Font'))
    const fontValue = fonts?.get(resourceName)
    if (!fontValue) return null
    const cacheKey = fontValue instanceof PdfRef ? `ref:${fontValue.num}` : `inline:${streamKey}:${resourceName}`
    if (!fontCache.has(cacheKey)) {
      const font = await loadPdfFont(index, fontValue)
      font.cacheKey = cacheKey
      const recovered = context.recoveredGlyphs?.get(cacheKey)
      if (recovered) font.recoveredGlyphs = recovered
      fontCache.set(cacheKey, font)
    }
    return fontCache.get(cacheKey)
  }

  const runStream = async (streamRef, resources, depth, owner) => {
    if (depth > 8) return
    let decoded
    try {
      decoded = await index.getStreamBytes(streamRef.num)
    } catch {
      context.warnings.push(`Content stream ${streamRef.num} could not be decoded.`)
      return
    }
    if (!decoded) return
    const source = latin1(decoded)
    let tokens
    try {
      tokens = tokenizeContent(source)
    } catch {
      context.warnings.push(`Content stream ${streamRef.num} could not be tokenized.`)
      return
    }
    if (!streams.has(streamRef.num)) {
      streams.set(streamRef.num, { num: streamRef.num, gen: streamRef.gen, source, owner, resources, pageIndex })
    }

    const operands = []
    const arrayStack = []
    let dictDepth = 0
    for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
      const token = tokens[tokenIndex]
      if (token.type === 'dictStart') { dictDepth += 1; continue }
      if (token.type === 'dictEnd') { dictDepth = Math.max(0, dictDepth - 1); if (!dictDepth) operands.push({ type: 'dict', start: token.start, end: token.end }); continue }
      if (dictDepth) continue
      if (token.type === 'arrayStart') { arrayStack.push({ type: 'array', items: [], start: token.start, end: token.end }); continue }
      if (token.type === 'arrayEnd') {
        const array = arrayStack.pop()
        if (!array) continue
        array.end = token.end
        if (arrayStack.length) arrayStack.at(-1).items.push(array)
        else operands.push(array)
        continue
      }
      if (token.type !== 'op') {
        if (arrayStack.length) arrayStack.at(-1).items.push(token)
        else operands.push(token)
        continue
      }
      if (arrayStack.length) { arrayStack.length = 0 }
      const operator = token.value
      const numbers = () => operands.map((operand) => (operand.type === 'number' ? operand.value : NaN))
      const last = (count) => operands.slice(-count)

      switch (operator) {
        case 're': {
          const [x, y, width, height] = numbers().slice(-4)
          if ([x, y, width, height].every(Number.isFinite)) {
            const corners = [[x, y], [x + width, y], [x + width, y + height], [x, y + height]].map(([px, py]) => applyPoint(state.ctm, px, py))
            for (let corner = 0; corner < 4; corner += 1) path.push([corners[corner], corners[(corner + 1) % 4]])
            currentPoint = corners[0]
            subpathStart = corners[0]
          }
          break
        }
        case 'm': {
          const [x, y] = numbers().slice(-2)
          if (Number.isFinite(x) && Number.isFinite(y)) { currentPoint = applyPoint(state.ctm, x, y); subpathStart = currentPoint }
          break
        }
        case 'l': {
          const [x, y] = numbers().slice(-2)
          if (Number.isFinite(x) && Number.isFinite(y)) {
            const point = applyPoint(state.ctm, x, y)
            if (currentPoint) path.push([currentPoint, point])
            currentPoint = point
          }
          break
        }
        case 'c': case 'v': case 'y': {
          const values = numbers().filter(Number.isFinite)
          if (values.length >= 2) currentPoint = applyPoint(state.ctm, values.at(-2), values.at(-1))
          break
        }
        case 'h':
          if (currentPoint && subpathStart) path.push([currentPoint, subpathStart])
          currentPoint = subpathStart
          break
        case 'S': case 's': case 'f': case 'F': case 'f*': case 'B': case 'B*': case 'b': case 'b*':
          if ((operator === 's' || operator === 'b' || operator === 'b*') && currentPoint && subpathStart) path.push([currentPoint, subpathStart])
          for (const [from, to] of path) {
            if (pageRules.length < 20000 && Math.hypot(to.x - from.x, to.y - from.y) >= 2) pageRules.push({ x1: from.x, y1: from.y, x2: to.x, y2: to.y })
          }
          path = []
          currentPoint = null
          break
        case 'n':
          path = []
          currentPoint = null
          break
        case 'q':
          stack.push(cloneGraphicsState(state))
          break
        case 'Q':
          if (stack.length) state = stack.pop()
          break
        case 'cm': {
          const values = numbers().slice(-6)
          if (values.length === 6 && values.every(Number.isFinite)) state.ctm = multiply(values, state.ctm)
          break
        }
        case 'BT':
          text.matrix = [...IDENTITY]
          text.lineMatrix = [...IDENTITY]
          text.positioned = true
          text.btId = ++btCounter
          text.previousRunKey = null
          break
        case 'ET':
          text.previousRunKey = null
          break
        case 'Tf': {
          const [nameToken, sizeToken] = last(2)
          if (nameToken?.type === 'name') {
            state.fontResource = nameToken.value
            state.font = await getFont(resources, nameToken.value, streamRef.num)
            state.fontFromExtGState = false
          }
          if (sizeToken?.type === 'number') state.fontSize = sizeToken.value
          break
        }
        case 'Tc': if (operands.at(-1)?.type === 'number') state.charSpacing = operands.at(-1).value; break
        case 'Tw': if (operands.at(-1)?.type === 'number') state.wordSpacing = operands.at(-1).value; break
        case 'Tz': if (operands.at(-1)?.type === 'number') state.horizontalScaling = operands.at(-1).value; break
        case 'TL': if (operands.at(-1)?.type === 'number') state.leading = operands.at(-1).value; break
        case 'Ts': if (operands.at(-1)?.type === 'number') state.rise = operands.at(-1).value; break
        case 'Tr': if (operands.at(-1)?.type === 'number') state.renderMode = operands.at(-1).value; break
        case 'Td':
        case 'TD': {
          const [tx, ty] = numbers().slice(-2)
          if (Number.isFinite(tx) && Number.isFinite(ty)) {
            if (operator === 'TD') state.leading = -ty
            text.lineMatrix = multiply([1, 0, 0, 1, tx, ty], text.lineMatrix)
            text.matrix = [...text.lineMatrix]
            text.positioned = true
          }
          break
        }
        case 'Tm': {
          const values = numbers().slice(-6)
          if (values.length === 6 && values.every(Number.isFinite)) {
            text.matrix = [...values]
            text.lineMatrix = [...values]
            text.positioned = true
          }
          break
        }
        case 'T*':
          text.lineMatrix = multiply([1, 0, 0, 1, 0, -state.leading], text.lineMatrix)
          text.matrix = [...text.lineMatrix]
          text.positioned = true
          break
        case 'g': case 'rg': case 'k': case 'sc': case 'scn': {
          const values = numbers().filter(Number.isFinite)
          const expected = operator === 'g' ? 1 : operator === 'rg' ? 3 : operator === 'k' ? 4 : values.length
          const color = colorFromComponents(values.slice(-expected))
          if (color) state.fillColor = color
          const device = operator === 'g' || operator === 'rg' || operator === 'k'
          const first = device ? operands[operands.length - expected] : operands[0]
          const ops = source.slice(first?.start ?? token.start, token.end)
          if (device) state.fillSpaceOp = null
          state.fillColorOps = device || !state.fillSpaceOp ? ops : `${state.fillSpaceOp} ${ops}`
          break
        }
        case 'G': case 'RG': case 'K': case 'SC': case 'SCN': {
          const values = numbers().filter(Number.isFinite)
          const expected = operator === 'G' ? 1 : operator === 'RG' ? 3 : operator === 'K' ? 4 : values.length
          const color = colorFromComponents(values.slice(-expected))
          if (color) state.strokeColor = color
          const device = operator === 'G' || operator === 'RG' || operator === 'K'
          const first = device ? operands[operands.length - expected] : operands[0]
          const ops = source.slice(first?.start ?? token.start, token.end)
          if (device) state.strokeSpaceOp = null
          state.strokeColorOps = device || !state.strokeSpaceOp ? ops : `${state.strokeSpaceOp} ${ops}`
          break
        }
        case 'cs':
          state.fillColor = '#000000'
          if (operands.at(-1)?.type === 'name') {
            state.fillSpaceOp = `/${operands.at(-1).value} cs`
            state.fillColorOps = state.fillSpaceOp
          }
          break
        case 'CS':
          state.strokeColor = '#000000'
          if (operands.at(-1)?.type === 'name') {
            state.strokeSpaceOp = `/${operands.at(-1).value} CS`
            state.strokeColorOps = state.strokeSpaceOp
          }
          break
        case 'gs': {
          const nameToken = operands.at(-1)
          if (nameToken?.type === 'name') {
            const graphicsStates = resolveDict(index, resources.get('ExtGState'))
            const extGState = resolveDict(index, graphicsStates?.get(nameToken.value))
            const fontEntry = index.resolve(extGState?.get('Font'))
            if (Array.isArray(fontEntry) && fontEntry[0] instanceof PdfRef) {
              const cacheKey = `ref:${fontEntry[0].num}`
              if (!fontCache.has(cacheKey)) {
                const font = await loadPdfFont(index, fontEntry[0])
                font.cacheKey = cacheKey
                fontCache.set(cacheKey, font)
              }
              state.font = fontCache.get(cacheKey)
              state.fontSize = typeof fontEntry[1] === 'number' ? fontEntry[1] : state.fontSize
              state.fontResource = null
              state.fontFromExtGState = true
            }
          }
          break
        }
        case 'Do': {
          const nameToken = operands.at(-1)
          if (nameToken?.type !== 'name') break
          const xobjects = resolveDict(index, resources.get('XObject'))
          const reference = xobjects?.get(nameToken.value)
          if (!(reference instanceof PdfRef)) break
          const object = index.getObject(reference.num)
          const dict = object?.value
          if (dict instanceof PdfDict && dict.getName('Subtype') === 'Image') {
            recordImage({
              kind: 'xobject', name: nameToken.value, ref: reference.num, start: nameToken.start, end: token.end,
              pixelWidth: index.resolve(dict.get('Width')), pixelHeight: index.resolve(dict.get('Height')),
              filter: [index.resolve(dict.get('Filter'))].flat().map((item) => item?.name).filter(Boolean),
              hasSoftMask: Boolean(dict.get('SMask')), imageMask: index.resolve(dict.get('ImageMask')) === true,
            })
            break
          }
          if (!(dict instanceof PdfDict) || dict.getName('Subtype') !== 'Form' || !object.stream) break
          if (context.activeForms.has(reference.num)) break
          const matrix = index.resolve(dict.get('Matrix'))
          const formMatrix = Array.isArray(matrix) && matrix.length === 6 && matrix.every((value) => typeof value === 'number') ? matrix : [...IDENTITY]
          const formResources = resolveDict(index, dict.get('Resources')) || resources
          const saved = cloneGraphicsState(state)
          const savedText = { ...text, matrix: [...text.matrix], lineMatrix: [...text.lineMatrix] }
          const savedStackDepth = stack.length
          state.ctm = multiply(formMatrix, state.ctm)
          context.activeForms.add(reference.num)
          await runStream(reference, formResources, depth + 1, { kind: 'xobject', num: reference.num, resourcesInline: !(dict.get('Resources') instanceof PdfRef), resourcesRef: dict.get('Resources') instanceof PdfRef ? dict.get('Resources') : null })
          context.activeForms.delete(reference.num)
          stack.length = savedStackDepth
          state = saved
          Object.assign(text, savedText)
          break
        }
        case 'Tj': case 'TJ': case "'": case '"': {
          let wordSpacingOverride = null
          let charSpacingOverride = null
          if (operator === "'" || operator === '"') {
            if (operator === '"') {
              const [aw, ac] = numbers().slice(-3, -1)
              if (Number.isFinite(aw)) wordSpacingOverride = aw
              if (Number.isFinite(ac)) charSpacingOverride = ac
            }
            text.lineMatrix = multiply([1, 0, 0, 1, 0, -state.leading], text.lineMatrix)
            text.matrix = [...text.lineMatrix]
            text.positioned = true
          }
          if (wordSpacingOverride !== null) state.wordSpacing = wordSpacingOverride
          if (charSpacingOverride !== null) state.charSpacing = charSpacingOverride
          const operand = operands.at(-1)
          const items = operator === 'TJ'
            ? (operand?.type === 'array' ? operand.items.filter((item) => item.type === 'string' || item.type === 'number') : null)
            : (operand?.type === 'string' ? [operand] : null)
          if (!items) break
          const firstOperand = operator === '"' ? operands.at(-3) : operand
          const run = buildRun({
            items, operator, operand, operatorToken: token, firstOperand, state, text, streamRef, owner, pageIndex,
            sequence: sequence++, extraOperands: operator === '"' ? numbers().slice(-3, -1) : null,
          })
          if (run) {
            runs.push(run)
            text.previousRunKey = run.key
          }
          text.positioned = false
          break
        }
        case 'BI':
          inlineImage = { start: token.start, width: null, height: null }
          break
        case 'ID':
          if (inlineImage) {
            for (let position = 0; position < operands.length - 1; position += 1) {
              const key = operands[position]
              const value = operands[position + 1]
              if (key.type === 'name' && value.type === 'number' && (key.value === 'W' || key.value === 'Width')) inlineImage.width = value.value
              if (key.type === 'name' && value.type === 'number' && (key.value === 'H' || key.value === 'Height')) inlineImage.height = value.value
            }
          }
          break
        case 'EI':
          if (inlineImage) {
            recordImage({ kind: 'inline', name: null, ref: null, start: inlineImage.start, end: token.end, pixelWidth: inlineImage.width, pixelHeight: inlineImage.height, filter: [], hasSoftMask: false, imageMask: false })
            inlineImage = null
          }
          break
        default:
          break
      }
      operands.length = 0
    }

    function recordImage(info) {
      if (!context.images) context.images = []
      const corners = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => applyPoint(state.ctm, x, y))
      const xs = corners.map((point) => point.x)
      const ys = corners.map((point) => point.y)
      context.images.push({
        ...info,
        key: `${pageIndex}:img:${streamRef.num}:${info.start}`,
        pageIndex,
        streamObjectNumber: streamRef.num,
        owner,
        depth,
        ctm: [...state.ctm],
        corners,
        bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
        sequence: sequence++,
      })
    }
  }
  let inlineImage = null

  for (const reference of contentRefs) {
    await runStream(reference, pageResources, 0, { kind: 'page', pageNum: page.num })
  }
}

function buildRun({ items, operator, operand, operatorToken, firstOperand, state, text, streamRef, owner, pageIndex, sequence, extraOperands }) {
  const font = state.font
  const fontSize = state.fontSize
  const horizontalScale = state.horizontalScaling / 100
  const startMatrix = [...text.matrix]
  const glyphs = []
  let advance = 0
  let decodable = Boolean(font) && !font.unsupportedReason
  let textValue = ''
  let hasAdjustments = false
  let stringCount = 0

  for (const item of items) {
    if (item.type === 'number') {
      const delta = (-item.value / 1000) * fontSize * horizontalScale
      hasAdjustments = true
      glyphs.push({ adjust: item.value, x: advance, advance: delta, virtualSpace: false })
      advance += delta
      continue
    }
    stringCount += 1
    if (!font) { decodable = false; continue }
    for (const code of font.splitCodes(item.bytes)) {
      const unicode = font.decode(code)
      if (unicode === null) decodable = false
      const width = font.widthOf(code)
      const isSpace = font.codeBytes === 1 && code === 32
      const glyphAdvance = (width * fontSize + state.charSpacing + (isSpace ? state.wordSpacing : 0)) * horizontalScale
      glyphs.push({ code, unicode: unicode ?? '\ufffd', x: advance, advance: glyphAdvance, width })
      font.usedCodes.add(code)
      advance += glyphAdvance
    }
  }
  if (font) font.invalidateEncodingCache()
  // A large negative TJ adjustment between two glyphs is a word space drawn by positioning.
  let lastCharacter = ''
  for (let position = 0; position < glyphs.length; position += 1) {
    const glyph = glyphs[position]
    if (glyph.code !== undefined) {
      textValue += glyph.unicode
      lastCharacter = glyph.unicode.slice(-1)
      continue
    }
    const nextGlyph = glyphs.slice(position + 1).find((candidate) => candidate.code !== undefined)
    // [+a, mark, -a] positions a combining mark (Indic matras, accents); it is not a word gap.
    const markOffset = glyphs[position - 1]?.code !== undefined && glyphs[position - 2]?.adjust !== undefined && Math.abs(glyphs[position - 2].adjust + glyph.adjust) < 1
    if (!markOffset && glyph.adjust <= -180 && lastCharacter && lastCharacter !== ' ' && nextGlyph && nextGlyph.unicode[0] !== ' ') {
      glyph.virtualSpace = true
      textValue += ' '
      lastCharacter = ' '
    }
  }

  const renderMatrix = multiply(startMatrix, state.ctm)
  // Visual extent: from the first drawn glyph to the end of the last one
  // (leading/trailing TJ adjustments only move the pen).
  const drawn = glyphs.filter((glyph) => glyph.code !== undefined)
  const visualStart = drawn.length ? drawn[0].x : 0
  const visualEnd = drawn.length ? drawn.at(-1).x + drawn.at(-1).advance : advance
  const origin = applyPoint(renderMatrix, 0, state.rise)
  const advanceEnd = applyPoint(renderMatrix, advance, state.rise)
  const start = applyPoint(renderMatrix, visualStart, state.rise)
  const end = applyPoint(renderMatrix, visualEnd, state.rise)
  const xAxis = applyVector(renderMatrix, 1, 0)
  const yAxis = applyVector(renderMatrix, 0, 1)
  const scaleX = length(xAxis) || 1
  const scaleY = length(yAxis) || 1
  const direction = { x: xAxis.x / scaleX, y: xAxis.y / scaleX }
  const normal = { x: yAxis.x / scaleY, y: yAxis.y / scaleY }
  const ascent = ((font?.ascent ?? 800) / 1000) * fontSize
  const descent = ((font?.descent ?? -200) / 1000) * fontSize
  const corners = [
    applyPoint(renderMatrix, visualStart, state.rise + descent),
    applyPoint(renderMatrix, visualStart, state.rise + ascent),
    applyPoint(renderMatrix, visualEnd, state.rise + descent),
    applyPoint(renderMatrix, visualEnd, state.rise + ascent),
  ]
  const bbox = [
    Math.min(...corners.map((point) => point.x)), Math.min(...corners.map((point) => point.y)),
    Math.max(...corners.map((point) => point.x)), Math.max(...corners.map((point) => point.y)),
  ]

  // Advance the text matrix exactly like a PDF viewer does.
  text.matrix = multiply([1, 0, 0, 1, advance, 0], text.matrix)

  const startOffset = Math.min(firstOperand?.start ?? operand.start, operand.start)
  const key = `${pageIndex}:${streamRef.num}:${startOffset}:${operatorToken.end}`
  const glyphCount = glyphs.filter((glyph) => glyph.code !== undefined).length
  return {
    key,
    pageIndex,
    pageNumber: pageIndex + 1,
    streamObjectNumber: streamRef.num,
    streamOwner: owner.kind,
    operator,
    tokenType: operator === 'TJ' ? 'TJ' : 'Tj',
    start: startOffset,
    end: operatorToken.end,
    extraOperands,
    originalText: textValue,
    glyphs,
    glyphCount,
    stringCount,
    hasKerningAdjustments: hasAdjustments,
    decodable: decodable && glyphCount > 0,
    fontKey: font?.cacheKey ?? null,
    fontResource: state.fontResource,
    fontFromExtGState: state.fontFromExtGState,
    fontObjectNumber: font?.objectNumber ?? null,
    fontSize,
    characterSpacing: state.charSpacing,
    wordSpacing: state.wordSpacing,
    horizontalScaling: state.horizontalScaling,
    textRise: state.rise,
    textRenderingMode: state.renderMode,
    invisible: state.renderMode === 3 || state.renderMode === 7,
    fillColor: state.fillColor,
    strokeColor: state.strokeColor,
    fillColorOps: state.fillColorOps,
    strokeColorOps: state.strokeColorOps,
    textMatrix: startMatrix,
    ctm: [...state.ctm],
    renderMatrix,
    advance,
    scaleX,
    fontSizeUser: Math.abs(fontSize) * scaleY,
    originPoint: origin,
    advanceEndPoint: advanceEnd,
    startPoint: start,
    endPoint: end,
    direction,
    normal,
    bbox,
    position: { x: startMatrix[4], y: startMatrix[5] + state.rise },
    positioning: text.positioned ? 'absolute' : 'continuation',
    btId: text.btId,
    previousRunKey: text.positioned ? null : text.previousRunKey,
    sequence,
  }
}

export { PdfName }
