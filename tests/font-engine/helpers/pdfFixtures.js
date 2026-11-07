import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { deflateSync } from 'node:zlib'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import fontkitModule from '@pdf-lib/fontkit'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { createStaticFontProvider } from '../../../frontend/src/engine/font-engine/fallbackFonts.js'

const fontkit = fontkitModule.default ?? fontkitModule

const FONT_DIRECTORIES = ['C:/Windows/Fonts', '/usr/share/fonts/truetype/msttcorefonts', '/Library/Fonts', '/System/Library/Fonts/Supplemental']

export function findSystemFont(fileNames) {
  for (const directory of FONT_DIRECTORIES) {
    for (const fileName of fileNames) {
      const candidate = path.join(directory, fileName)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/** Font provider backed by font files on disk (stands in for Local Font Access in Node). */
export function createFileFontProvider(filePaths) {
  const entries = []
  for (const filePath of filePaths.filter(Boolean)) {
    const bytes = new Uint8Array(readFileSync(filePath))
    const font = fontkit.create(bytes)
    const fonts = Array.isArray(font.fonts) ? font.fonts : [font]
    for (const item of fonts) {
      entries.push({
        postscriptName: item.postscriptName,
        fullName: item.fullName,
        family: item.familyName,
        style: item.subfamilyName,
        async load() { return bytes },
      })
    }
  }
  return createStaticFontProvider(entries)
}

/** Text extracted by PDF.js, joined per page. */
export async function extractTextWithPdfJs(bytes) {
  const loadingTask = getDocument({ data: bytes.slice(), useSystemFonts: false, isEvalSupported: false, disableFontFace: true, verbosity: 0 })
  const document = await loadingTask.promise
  const pages = []
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber)
    const content = await page.getTextContent()
    pages.push(content.items.map((item) => item.str).join(' '))
  }
  await loadingTask.destroy()
  return pages
}

/** pdf-lib document using the standard Helvetica font (WinAnsi, not embedded). */
export async function createStandardFontPdf(lines, { useObjectStreams = true } = {}) {
  const document = await PDFDocument.create()
  const page = document.addPage([612, 792])
  const helvetica = await document.embedFont(StandardFonts.Helvetica)
  const bold = await document.embedFont(StandardFonts.HelveticaBold)
  for (const line of lines) {
    let x = line.x ?? 72
    for (const part of line.parts) {
      const font = part.bold ? bold : helvetica
      page.drawText(part.text, { x, y: line.y, size: line.size ?? 12, font, color: part.color ? rgb(...part.color) : rgb(0, 0, 0) })
      x += font.widthOfTextAtSize(part.text, line.size ?? 12) + (part.gapAfter ?? font.widthOfTextAtSize(' ', line.size ?? 12))
    }
  }
  return new Uint8Array(await document.save({ useObjectStreams }))
}

/** pdf-lib document with an embedded *subset* TrueType font (Identity-H, like Word/Chrome exports). */
export async function createSubsetFontPdf(fontPath, text, { size = 14 } = {}) {
  const document = await PDFDocument.create()
  document.registerFontkit(fontkit)
  const font = await document.embedFont(readFileSync(fontPath), { subset: true })
  const page = document.addPage([612, 792])
  page.drawText(text, { x: 72, y: 700, size, font, color: rgb(0.8, 0.1, 0.1) })
  page.drawText('Tail', { x: 72 + font.widthOfTextAtSize(text + ' ', size), y: 700, size, font, color: rgb(0.1, 0.1, 0.8) })
  return new Uint8Array(await document.save({ useObjectStreams: false }))
}

/** Hand-written single-page PDF with a classic xref table and the given content stream. */
export function createRawPdf(content, { compress = true, fonts = null } = {}) {
  const objects = []
  const fontDict = fonts || '<< /F1 5 0 R >>'
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 /Resources << /Font ' + fontDict + ' >> >>'
  objects[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>'
  const streamBytes = compress ? deflateSync(Buffer.from(content, 'latin1')) : Buffer.from(content, 'latin1')
  objects[4] = { dict: `<< /Length ${streamBytes.length}${compress ? ' /Filter /FlateDecode' : ''} >>`, stream: streamBytes }
  objects[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
  objects[6] = '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold /Encoding /WinAnsiEncoding >>'
  const parts = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')]
  const offsets = []
  let length = parts[0].length
  for (let number = 1; number < objects.length; number += 1) {
    offsets[number] = length
    const object = objects[number]
    const chunk = typeof object === 'string'
      ? Buffer.from(`${number} 0 obj\n${object}\nendobj\n`, 'latin1')
      : Buffer.concat([Buffer.from(`${number} 0 obj\n${object.dict}\nstream\n`, 'latin1'), object.stream, Buffer.from('\nendstream\nendobj\n', 'latin1')])
    parts.push(chunk)
    length += chunk.length
  }
  let xref = `xref\n0 ${objects.length}\n0000000000 65535 f\r\n`
  for (let number = 1; number < objects.length; number += 1) xref += `${String(offsets[number]).padStart(10, '0')} 00000 n\r\n`
  xref += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`
  parts.push(Buffer.from(xref, 'latin1'))
  return new Uint8Array(Buffer.concat(parts))
}
