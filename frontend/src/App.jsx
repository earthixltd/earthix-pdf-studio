import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { PDFDocument } from 'pdf-lib'
import {
  FaBars, FaCheckCircle, FaChevronDown, FaChevronLeft, FaChevronRight, FaColumns, FaCompress, FaDownload, FaEdit,
  FaExclamationCircle, FaExclamationTriangle, FaExpand, FaFileAlt, FaFilePdf, FaHome, FaLayerGroup, FaList, FaMinus,
  FaMoon, FaPlus, FaPrint, FaRedo, FaSearch, FaSlidersH, FaSpinner, FaSun, FaTh, FaTimes, FaTools, FaUndo, FaUpload,
} from 'react-icons/fa'
import { createPdfEngine } from './engine/index.js'
import {
  createDocumentCore, IndexedDbCheckpointStorage, ReplacePdfBytesCommand, ReplaceNativeTextBlockCommand,
  SetPageObjectsCommand, TransformPdfBytesCommand,
} from './engine/document-core/index.js'
import { PdfPageThumbnail } from './features/pdf-viewer/PdfPageThumbnail.jsx'
import { PdfPageViewer } from './features/pdf-viewer/PdfPageViewer.jsx'
import { searchPdfDocument } from './features/pdf-viewer/searchPdfDocument.js'
import { editPageImage, inspectNativePdfText, restyleNativeTextBlock } from './services/nativePdfTextEditor.js'
import { createLocalFontProvider } from './engine/font-engine/fallbackFonts.js'
import { findBlockNearPoint } from './features/text-editor/blockGeometry.js'
import { HomeWorkspace, SplitWorkspace, OrganizeWorkspace } from './features/page-manager/WorkspacePanels.jsx'
import { createPagePlan, movePage as movePageInPlan, rotatePage as rotatePageInPlan, removePage as removePageFromPlan, addBlankPage, isPagePlanChanged } from './features/page-manager/pagePlan.js'
import { applyPagePlanToPdf } from './features/page-manager/applyPagePlan.js'
import { writePageObjects } from './engine/page-objects/objectWriter.js'
import { extractPageObjects } from './engine/page-objects/objectReader.js'
import { isStandardFamily } from './engine/page-objects/textLayout.js'
import { TOOLS, TOOL_BY_ID } from './features/editor/editorTools.js'
import { ObjectLayer } from './features/editor/ObjectLayer.jsx'
import { PageImageLayer } from './features/editor/PageImageLayer.jsx'
import { PropertiesPanel } from './features/editor/PropertiesPanel.jsx'
import { SignatureDialog } from './features/editor/SignatureDialog.jsx'
import { DEFAULT_TOOL_SETTINGS, inkBounds, moveObject, newId, objectLabel } from './features/editor/objectFactory.js'
import { fitTextObject, setMeasureFontProvider, subscribeFontLoads } from './features/editor/textMeasure.js'
import { importImageFile } from './features/editor/imageImport.js'
import './studio.css'
import './features/editor/editor.css'

const NAV_ITEMS = [
  { id: 'home', label: 'Home', icon: FaHome },
  { id: 'edit', label: 'Edit', icon: FaEdit },
  { id: 'merge', label: 'Merge', icon: FaFileAlt },
  { id: 'split', label: 'Split', icon: FaColumns },
  { id: 'organize', label: 'Pages', icon: FaTh },
  { id: 'compress', label: 'Optimize', icon: FaCompress },
]
const ONE_SHOT_TOOLS = new Set(['text', 'shape', 'note', 'signature', 'image', 'whiteout'])
const SETTINGS_KEY = 'earthix.toolSettings.v1'
const THEME_KEY = 'earthix.theme'

function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => (typeof window !== 'undefined' ? window.matchMedia(query).matches : false))
  useEffect(() => {
    const media = window.matchMedia(query)
    const update = () => setMatches(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [query])
  return matches
}

function readStoredSettings() {
  try {
    const stored = JSON.parse(globalThis.localStorage?.getItem(SETTINGS_KEY) || 'null')
    if (!stored) return DEFAULT_TOOL_SETTINGS
    return Object.fromEntries(Object.entries(DEFAULT_TOOL_SETTINGS).map(([key, value]) => [key, { ...value, ...(stored[key] || {}) }]))
  } catch {
    return DEFAULT_TOOL_SETTINGS
  }
}

function Toast({ message, type, onClose }) {
  useEffect(() => {
    if (!message) return undefined
    const timer = window.setTimeout(onClose, type === 'error' || type === 'warning' ? 7000 : 4200)
    return () => window.clearTimeout(timer)
  }, [message, type, onClose])
  if (!message) return null
  const Icon = type === 'error' ? FaExclamationCircle : type === 'warning' ? FaExclamationTriangle : FaCheckCircle
  return (
    <div className={`toast ${type || ''}`} role="status">
      <Icon />
      <span>{message}</span>
      <button type="button" onClick={onClose} aria-label="Close notification"><FaTimes /></button>
    </div>
  )
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function createPages(session) {
  return Array.from({ length: session.pageCount }, (_, index) => ({ id: `${index}-${session.pageCount}`, index, pageNumber: index + 1 }))
}

function downloadPdf(bytes, fileName) {
  const blob = new Blob([bytes], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1500)
}

async function openWithPassword(engine, bytes, fileName, onProgress) {
  let password
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await engine.openDocument(bytes, { fileName, password, onProgress })
    } catch (error) {
      if (error?.code !== 'PASSWORD_REQUIRED') throw error
      const enteredPassword = window.prompt(`Enter the password for ${fileName}`)
      if (enteredPassword === null) throw new Error('PDF opening was cancelled because no password was provided.', { cause: error })
      password = enteredPassword
    }
  }
  throw new Error('The PDF password was not accepted after three attempts.')
}

async function splitEditableObjects(bytes) {
  try {
    return await extractPageObjects(bytes)
  } catch {
    return { bytes, objects: [], found: false }
  }
}

const sameBytes = (a, b) => {
  if (!a || !b || a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false
  return true
}

function App() {
  const fileInputRef = useRef(null)
  const mergeInputRef = useRef(null)
  const imageInputRef = useRef(null)
  const imageTargetRef = useRef(null)
  const engineRef = useRef(null)
  const documentSessionRef = useRef(null)
  const documentCoreRef = useRef(null)
  const documentCoreUnsubscribeRef = useRef(null)
  const originalPdfBytesRef = useRef(null)
  const openSequenceRef = useRef(0)
  const fontProviderRef = useRef(null)
  if (!fontProviderRef.current) {
    fontProviderRef.current = createLocalFontProvider()
    setMeasureFontProvider(fontProviderRef.current)
  }
  const pendingActivationRef = useRef(null)
  const drawSessionRef = useRef(null)
  const clipboardRef = useRef(null)
  const signaturePointRef = useRef(null)

  const isMobile = useMediaQuery('(max-width: 767px)')
  const isCompact = useMediaQuery('(max-width: 1023px)')

  const [documentSession, setDocumentSession] = useState(null)
  const [documentCoreState, setDocumentCoreState] = useState(null)
  const [engineError, setEngineError] = useState('')
  const [engineStatus, setEngineStatus] = useState('idle')
  const [fileName, setFileName] = useState('No document open')
  const [fileSize, setFileSize] = useState(0)
  const [pages, setPages] = useState([])
  const [currentPage, setCurrentPage] = useState(0)
  const [pageInput, setPageInput] = useState('1')
  const [zoom, setZoom] = useState(1)
  const [zoomMode, setZoomMode] = useState('width')
  const [processing, setProcessing] = useState(false)
  const [processingProgress, setProcessingProgress] = useState(0)
  const [saving, setSaving] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [toast, setToast] = useState({ message: '', type: '' })
  const [nativeRuns, setNativeRuns] = useState([])
  const [fontInspection, setFontInspection] = useState([])
  const [nativeSearchTerm, setNativeSearchTerm] = useState('')
  const [pdfSearchResults, setPdfSearchResults] = useState([])
  const [pdfSearchBusy, setPdfSearchBusy] = useState(false)
  const [nativeBlocks, setNativeBlocks] = useState([])
  const [pageImages, setPageImages] = useState([])
  const [activeBlock, setActiveBlock] = useState(null)
  const [activeClickPoint, setActiveClickPoint] = useState(null)
  const [selectedBlockKey, setSelectedBlockKey] = useState(null)
  const [selectedImageKey, setSelectedImageKey] = useState(null)
  const [editorDraft, setEditorDraft] = useState('')
  const [pdfBusy, setPdfBusy] = useState(false)
  const [recentFiles, setRecentFiles] = useState([])
  const [activeWorkspace, setActiveWorkspace] = useState('edit')
  const [splitFrom, setSplitFrom] = useState('1')
  const [splitTo, setSplitTo] = useState('1')
  const [pagePlan, setPagePlan] = useState([])

  const [objects, setObjects] = useState([])
  const [previewObject, setPreviewObject] = useState(null)
  const [tool, setToolState] = useState('select')
  const [toolSettings, setToolSettings] = useState(readStoredSettings)
  const [selectedObjectId, setSelectedObjectId] = useState(null)
  const [editingText, setEditingText] = useState(null)
  const [leftTab, setLeftTab] = useState('pages')
  const [showLeft, setShowLeft] = useState(() => typeof window === 'undefined' || window.innerWidth >= 1024)
  const [showRight, setShowRight] = useState(() => typeof window === 'undefined' || window.innerWidth >= 1024)
  const [navOpen, setNavOpen] = useState(false)
  const [exportMenu, setExportMenu] = useState(false)
  const [signatureOpen, setSignatureOpen] = useState(false)
  const [hintTool, setHintTool] = useState(null)
  const [localFamilies, setLocalFamilies] = useState([])
  const [localFontStatus, setLocalFontStatus] = useState(fontProviderRef.current.status)
  const [theme, setTheme] = useState(() => globalThis.localStorage?.getItem(THEME_KEY) || 'system')
  const [fontVersion, bumpFontVersion] = useReducer((value) => value + 1, 0)

  const showToast = useCallback((message, type = '') => setToast({ message, type }), [])
  const closeToast = useCallback(() => setToast({ message: '', type: '' }), [])

  useEffect(() => subscribeFontLoads(bumpFontVersion), [])
  useEffect(() => {
    try { globalThis.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(toolSettings)) } catch { /* storage unavailable */ }
  }, [toolSettings])
  useEffect(() => {
    const root = document.documentElement
    if (theme === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', theme)
    try { globalThis.localStorage?.setItem(THEME_KEY, theme) } catch { /* storage unavailable */ }
  }, [theme])
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)')
  const effectiveTheme = theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme
  const toggleTheme = () => setTheme(effectiveTheme === 'dark' ? 'light' : 'dark')

  // Panels are drawers on small screens: start closed there.
  useEffect(() => {
    if (isCompact) { setShowLeft(false); setShowRight(false) } else { setShowLeft(true); setShowRight(true) }
  }, [isCompact])

  const installDocumentCore = useCallback((nextCore) => {
    const previousCore = documentCoreRef.current
    documentCoreUnsubscribeRef.current?.()
    documentCoreUnsubscribeRef.current = null
    documentCoreRef.current = nextCore
    if (nextCore) {
      documentCoreUnsubscribeRef.current = nextCore.subscribe((snapshot, event) => {
        setDocumentCoreState(snapshot)
        if (event?.type !== 'autosave') setObjects(nextCore.objects.list())
      })
    } else {
      setDocumentCoreState(null)
      setObjects([])
    }
    if (previousCore && previousCore !== nextCore) void previousCore.close({ flushAutosave: true }).catch(() => undefined)
  }, [])

  const applyInspection = useCallback((inspection) => {
    setNativeRuns(inspection?.runs || [])
    setNativeBlocks(inspection?.blocks || [])
    setPageImages(inspection?.images || [])
    setFontInspection(inspection?.fonts || [])
  }, [])

  const pageCount = pages.length
  const pagePlanChanged = useMemo(() => isPagePlanChanged(pagePlan, pageCount), [pagePlan, pageCount])

  useEffect(() => {
    if (documentSession) {
      setPagePlan(createPagePlan(documentSession.pageCount))
      setSplitFrom('1')
      setSplitTo(String(documentSession.pageCount))
    } else {
      setPagePlan([])
    }
  }, [documentSession])
  useEffect(() => { setPageInput(String(currentPage + 1)) }, [currentPage])

  const currentSearchItemIndexes = useMemo(() => (
    [...new Set(pdfSearchResults.filter((result) => result.pageIndex === currentPage).flatMap((result) => result.itemIndexes || []))]
  ), [pdfSearchResults, currentPage])

  useEffect(() => {
    const query = nativeSearchTerm.trim()
    if (!documentSession || !query) {
      setPdfSearchResults([])
      setPdfSearchBusy(false)
      return undefined
    }
    let cancelled = false
    const controller = new AbortController()
    setPdfSearchBusy(true)
    const timer = window.setTimeout(async () => {
      try {
        const results = await searchPdfDocument(documentSession, query, { signal: controller.signal, maxMatches: 80 })
        if (!cancelled) setPdfSearchResults(results)
      } catch (error) {
        if (!cancelled && error?.code !== 'SEARCH_CANCELLED') {
          setPdfSearchResults([])
          showToast(error?.message || 'PDF text search failed.', 'error')
        }
      } finally {
        if (!cancelled) setPdfSearchBusy(false)
      }
    }, 220)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [documentSession, nativeSearchTerm, showToast])

  useEffect(() => {
    const engine = createPdfEngine()
    engineRef.current = engine
    return () => {
      const session = documentSessionRef.current
      const core = documentCoreRef.current
      documentSessionRef.current = null
      documentCoreRef.current = null
      documentCoreUnsubscribeRef.current?.()
      documentCoreUnsubscribeRef.current = null
      void core?.close({ flushAutosave: true })
      void session?.close?.()
      void engine.dispose()
      if (engineRef.current === engine) engineRef.current = null
    }
  }, [])

  const replaceDocumentSession = useCallback(async (bytes, nextFileName, onProgress) => {
    if (!engineRef.current) throw new Error('The PDF engine is not ready. Refresh the page and try again.')
    const nextSession = await engineRef.current.openDocument(bytes, { fileName: nextFileName, onProgress })
    const previousSession = documentSessionRef.current
    documentSessionRef.current = nextSession
    setDocumentSession(nextSession)
    setPages(createPages(nextSession))
    setEngineStatus(nextSession.engineStatus)
    void nextSession.pdfiumReady.then(() => {
      if (documentSessionRef.current === nextSession) setEngineStatus(nextSession.engineStatus)
    })
    await previousSession?.close?.()
    return nextSession
  }, [])

  const clearSelections = useCallback(() => {
    setSelectedObjectId(null)
    setSelectedImageKey(null)
    setSelectedBlockKey(null)
    setActiveBlock(null)
    setEditingText(null)
    setPreviewObject(null)
  }, [])

  /** Replace the whole document (merge, page changes); Earthix items in the file become editable again. */
  const commitPdfBytes = useCallback(async (fullBytes, nextFileName, nextPage = 0) => {
    const { bytes, objects: extracted } = await splitEditableObjects(fullBytes)
    originalPdfBytesRef.current = bytes.slice()
    const nextSession = await replaceDocumentSession(bytes, nextFileName)
    const documentCore = documentCoreRef.current
    if (documentCore) {
      await documentCore.execute(new ReplacePdfBytesCommand(bytes, { fileName: nextFileName, pageCount: nextSession.pageCount, label: 'Replace document content', objects: extracted }))
    } else {
      const core = createDocumentCore({ fileName: nextFileName, bytes, pageCount: nextSession.pageCount, checkpointStorage: new IndexedDbCheckpointStorage(), autosave: true })
      core.objects.restore(extracted, nextSession.pageCount)
      installDocumentCore(core)
      setObjects(core.objects.list())
    }
    setFileName(nextFileName)
    setFileSize(fullBytes.byteLength)
    const page = Math.max(0, Math.min(nextPage, nextSession.pageCount - 1))
    setCurrentPage(page)
    documentCoreRef.current?.setActivePage(page)
    applyInspection(await inspectNativePdfText(bytes).catch(() => ({ runs: [], fonts: [] })))
    clearSelections()
    return nextSession
  }, [applyInspection, clearSelections, installDocumentCore, replaceDocumentSession])

  const openPdf = useCallback(async (file) => {
    if (!file) return
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
    if (!isPdf) { showToast('Please choose a PDF document.', 'error'); return }
    if (!engineRef.current) { showToast('The PDF engine is still starting. Try again in a moment.', 'error'); return }
    const operationId = ++openSequenceRef.current
    setProcessing(true)
    setProcessingProgress(0)
    setEngineError('')
    try {
      const fileBytes = new Uint8Array(await file.arrayBuffer())
      const { bytes, objects: extracted, found } = await splitEditableObjects(fileBytes)
      if (operationId !== openSequenceRef.current) return
      const inspectionPromise = inspectNativePdfText(bytes).catch((error) => ({ runs: [], error }))
      const nextSession = await openWithPassword(engineRef.current, bytes, file.name, ({ loaded, total }) => {
        if (operationId !== openSequenceRef.current) return
        if (Number.isFinite(total) && total > 0) setProcessingProgress(Math.min(100, Math.round((loaded / total) * 100)))
      })
      if (operationId !== openSequenceRef.current) { await nextSession.close(); return }
      const previousSession = documentSessionRef.current
      documentSessionRef.current = nextSession
      originalPdfBytesRef.current = bytes.slice()
      const core = createDocumentCore({ fileName: file.name, bytes, pageCount: nextSession.pageCount, checkpointStorage: new IndexedDbCheckpointStorage(), autosave: true })
      core.objects.restore(extracted, nextSession.pageCount)
      installDocumentCore(core)
      setObjects(core.objects.list())
      setDocumentSession(nextSession)
      setPages(createPages(nextSession))
      setCurrentPage(0)
      setZoom(1)
      setZoomMode('width')
      setFileName(file.name)
      setFileSize(file.size)
      setEngineStatus(nextSession.engineStatus)
      setActiveWorkspace('edit')
      setNativeSearchTerm('')
      setPdfSearchResults([])
      clearSelections()
      setToolState('select')
      const inspection = await inspectionPromise
      applyInspection(inspection)
      await previousSession?.close?.()
      void nextSession.pdfiumReady.then(() => {
        if (documentSessionRef.current === nextSession) setEngineStatus(nextSession.engineStatus)
      })
      setRecentFiles((previous) => [
        { name: file.name, size: file.size, sizeLabel: formatBytes(file.size), file, openedAt: new Date().toISOString() },
        ...previous.filter((item) => item.name !== file.name),
      ].slice(0, 10))
      if (inspection.error) showToast(`${file.name} opened, but its text cannot be edited: ${inspection.error.message}`, 'warning')
      else if (!inspection.blocks?.length) showToast(`${file.name} opened. No editable text was found — the pages may be scanned images. You can still add text, images and markup.`, 'warning')
      else if (found) showToast(`${file.name} opened. ${extracted.length} item${extracted.length === 1 ? '' : 's'} added earlier in Earthix can be adjusted again.`)
      else showToast(`${file.name} opened.`)
    } catch (error) {
      if (operationId === openSequenceRef.current) {
        setEngineError(error?.message || 'The selected PDF could not be opened.')
        showToast(`Could not open PDF: ${error?.message || 'Unknown error'}`, 'error')
      }
    } finally {
      if (operationId === openSequenceRef.current) {
        setProcessing(false)
        setProcessingProgress(0)
      }
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }, [applyInspection, clearSelections, installDocumentCore, showToast])

  const requireDocument = useCallback(() => {
    if (!documentSessionRef.current || !documentCoreRef.current) {
      showToast('Open a PDF document first.', 'error')
      return false
    }
    return true
  }, [showToast])

  const setPage = useCallback((index) => {
    if (!pageCount) return
    const next = Math.max(0, Math.min(index, pageCount - 1))
    setCurrentPage(next)
    documentCoreRef.current?.setActivePage(next)
    setActiveBlock((block) => (block && block.pageIndex !== next ? null : block))
    setEditingText(null)
  }, [pageCount])

  // ---------------------------------------------------------------------------
  // Tools and selection
  // ---------------------------------------------------------------------------

  const setTool = useCallback((next) => {
    setToolState(next)
    drawSessionRef.current = null
    setEditingText(null)
    setPreviewObject(null)
    if (next !== 'select' && next !== 'edit') setSelectedObjectId(null)
    if (next !== 'edit') { setSelectedImageKey(null); setSelectedBlockKey(null); setActiveBlock(null) }
    setHintTool(next)
    globalThis.getSelection?.()?.removeAllRanges()
  }, [])

  useEffect(() => {
    if (!hintTool) return undefined
    const timer = window.setTimeout(() => setHintTool(null), 4500)
    return () => window.clearTimeout(timer)
  }, [hintTool])

  const objectsRef = useRef(objects)
  objectsRef.current = objects
  const maxZ = () => objectsRef.current.reduce((max, object) => Math.max(max, object.z ?? 0), 0)

  const runObjectCommand = useCallback(async (command) => {
    const core = documentCoreRef.current
    if (!core) return false
    try {
      await core.execute(command)
      return true
    } catch (error) {
      showToast(error?.message || 'The change could not be applied.', 'error')
      return false
    }
  }, [showToast])

  const createObject = useCallback(async (object, label = 'Add item', { select = true } = {}) => {
    const next = { rotation: 0, opacity: 1, ...object, z: maxZ() + 1 }
    delete next.isNew
    if (await runObjectCommand(new SetPageObjectsCommand({ upsert: [next] }, { label }))) {
      if (select) setSelectedObjectId(next.id)
      if (ONE_SHOT_TOOLS.has(tool)) setToolState('select')
    }
    return next
  }, [runObjectCommand, tool])

  const updateObject = useCallback(async (object, label = 'Change item') => {
    setPreviewObject(null)
    const next = object.type === 'text' ? fitTextObject(object) : object
    await runObjectCommand(new SetPageObjectsCommand({ upsert: [next] }, { label }))
  }, [runObjectCommand])

  const removeObject = useCallback(async (object) => {
    if (!object) return
    if (await runObjectCommand(new SetPageObjectsCommand({ remove: [object.id] }, { label: `Delete ${objectLabel(object).toLowerCase()}` }))) {
      setSelectedObjectId((id) => (id === object.id ? null : id))
    }
  }, [runObjectCommand])

  const duplicateObject = useCallback(async (object) => {
    if (!object) return
    const copy = { ...moveObject(object, 14, 14), id: newId(object.type) }
    await createObject(copy, `Duplicate ${objectLabel(object).toLowerCase()}`)
  }, [createObject])

  const arrangeObject = useCallback(async (object, direction) => {
    const zs = objectsRef.current.filter((item) => item.pageIndex === object.pageIndex).map((item) => item.z ?? 0)
    const z = direction > 0 ? Math.max(...zs) + 1 : Math.min(...zs) - 1
    await updateObject({ ...object, z }, direction > 0 ? 'Bring to front' : 'Send to back')
  }, [updateObject])

  const handleInkStroke = useCallback(async (pageIndex, points) => {
    const settings = toolSettings.draw
    const session = drawSessionRef.current
    const now = Date.now()
    const existing = session && session.pageIndex === pageIndex && now - session.time < 4000
      ? objectsRef.current.find((object) => object.id === session.id && object.color === settings.color && object.strokeWidth === settings.width)
      : null
    if (existing) {
      const strokes = [...existing.strokes, points]
      drawSessionRef.current = { ...session, time: now }
      await runObjectCommand(new SetPageObjectsCommand({ upsert: [{ ...existing, strokes, ...inkBounds(strokes, existing.strokeWidth) }] }, { label: 'Draw' }))
    } else {
      const object = { id: newId('ink'), type: 'ink', pageIndex, strokes: [points], color: settings.color, strokeWidth: settings.width, opacity: settings.opacity, ...inkBounds([points], settings.width) }
      drawSessionRef.current = { id: object.id, pageIndex, time: now }
      await createObject(object, 'Draw', { select: false })
    }
  }, [createObject, runObjectCommand, toolSettings.draw])

  const startTextEdit = useCallback((object) => {
    if (object.isNew) {
      setSelectedObjectId(null)
      setEditingText(object)
      return
    }
    const stored = objectsRef.current.find((item) => item.id === object.id) || object
    setSelectedObjectId(stored.id)
    setEditingText(stored)
  }, [])

  const commitTextEdit = useCallback(async (object, text) => {
    setEditingText(null)
    if (object.isNew) {
      if (text.trim()) {
        const created = fitTextObject({ ...object, text })
        delete created.isNew
        await createObject(created, 'Add text')
      } else if (ONE_SHOT_TOOLS.has(tool)) {
        setToolState('select')
      }
      return
    }
    if (text === object.text) return
    if (!text.trim()) { await removeObject(object); return }
    await updateObject({ ...object, text }, 'Edit text')
  }, [createObject, removeObject, tool, updateObject])

  const placeImageObject = useCallback(async (image, { point = null, pageIndex = currentPage, label = 'Add image', signature = false } = {}) => {
    const info = await documentSessionRef.current?.getPageInfo?.(pageIndex).catch(() => null)
    const pageWidth = info?.width || 612
    const pageHeight = info?.height || 792
    const maxWidth = pageWidth * (signature ? 0.3 : 0.5)
    const naturalWidth = (image.pixelWidth || 400) * 0.75
    const width = Math.min(maxWidth, naturalWidth)
    const height = width * ((image.pixelHeight || 300) / (image.pixelWidth || 400))
    const x = point ? point.x - width / 2 : (pageWidth - width) / 2
    const y = point ? point.y - height / 2 : (pageHeight - height) / 3
    await createObject({ id: newId('image'), type: 'image', pageIndex, assetId: newId('asset'), signature, ...image, x, y, width, height }, label)
  }, [createObject, currentPage])

  const chooseImage = useCallback((target = { kind: 'new' }) => {
    imageTargetRef.current = target
    imageInputRef.current?.click()
  }, [])

  // ---------------------------------------------------------------------------
  // Original PDF text and images (rewritten inside the PDF)
  // ---------------------------------------------------------------------------

  const activeBlockRef = useRef(null)
  const pdfBusyRef = useRef(false)
  const nativeBlocksRef = useRef([])
  const awaitingRenderRef = useRef(false)
  activeBlockRef.current = activeBlock
  pdfBusyRef.current = pdfBusy
  nativeBlocksRef.current = nativeBlocks

  const activateBlock = useCallback((block, clickPoint = null) => {
    if (!block) return
    setSelectedBlockKey(block.key)
    setSelectedImageKey(null)
    setSelectedObjectId(null)
    if (!block.editable) { showToast(block.reason || 'This text cannot be edited.', 'warning'); return }
    setCurrentPage(block.pageIndex)
    setActiveClickPoint(clickPoint)
    setEditorDraft(block.text)
    setActiveBlock(block)
    if (isCompact) setShowRight(true)
  }, [isCompact, showToast])

  const runPendingActivation = useCallback((blocks) => {
    const pending = pendingActivationRef.current
    pendingActivationRef.current = null
    if (!pending) return
    const next = blocks.find((block) => block.key === pending.block.key && block.text === pending.block.text) ||
      findBlockNearPoint(blocks, pending.block.pageIndex, pending.block.startPoint, 1.5)
    if (next) activateBlock(next, pending.clickPoint)
  }, [activateBlock])

  const requestBlockEdit = useCallback((block, clickPoint = null, event = null) => {
    if (activeBlockRef.current || pdfBusyRef.current) {
      pendingActivationRef.current = { block, clickPoint }
      return
    }
    event?.preventDefault()
    activateBlock(block, clickPoint)
  }, [activateBlock])

  const cancelBlockEdit = useCallback(() => {
    setActiveBlock(null)
    setEditorDraft('')
    runPendingActivation(nativeBlocksRef.current)
  }, [runPendingActivation])

  const handlePageRendered = useCallback(() => {
    if (!awaitingRenderRef.current) return
    awaitingRenderRef.current = false
    setActiveBlock(null)
    setEditorDraft('')
    setPdfBusy(false)
    runPendingActivation(nativeBlocksRef.current)
  }, [runPendingActivation])

  /** Run a command that rewrites the PDF bytes, then show the new rendering. */
  const runPdfCommand = useCallback(async (command, { onResult } = {}) => {
    const core = documentCoreRef.current
    if (!core || pdfBusyRef.current) return null
    let applied = false
    pdfBusyRef.current = true
    setPdfBusy(true)
    try {
      await core.execute(command)
      applied = true
      const result = command.getResult()
      if (!result) throw new Error('The change did not return a verified result.')
      const bytes = core.getWorkingBytes()
      try {
        await replaceDocumentSession(bytes, core.fileName)
      } catch (openError) {
        await core.undo()
        applied = false
        throw openError
      }
      originalPdfBytesRef.current = bytes.slice()
      setFileSize(bytes.byteLength)
      applyInspection(result.inspection)
      nativeBlocksRef.current = result.inspection?.blocks || []
      onResult?.(result)
      awaitingRenderRef.current = true
      return result
    } catch (error) {
      if (applied) {
        try { await core.undo() } catch { /* already reported */ }
      }
      pendingActivationRef.current = null
      showToast(error?.message || 'The change could not be applied.', 'error')
      pdfBusyRef.current = false
      setPdfBusy(false)
      return null
    }
  }, [applyInspection, replaceDocumentSession, showToast])

  const fontToast = useCallback((plan, warnings = [], base) => {
    const fontAccess = fontProviderRef.current?.status
    const message = plan?.kind !== 'fallback'
      ? base
      : plan.match === 'exact'
        ? `${base} New letters use ${plan.label} from this computer — the same font as the PDF.`
        : fontAccess === 'unsupported' || fontAccess === 'denied'
          ? `${base} ${plan.label} was used as the closest match. Open this editor in Chrome or Edge and allow font access to use the exact font.`
          : `${base} ${plan.label} was used because the original font is not installed.`
    showToast([message, ...warnings].join(' '), (plan?.kind === 'fallback' && plan.match !== 'exact') || warnings.length ? 'warning' : '')
  }, [showToast])

  const commitBlockEdit = useCallback(async (block, text) => {
    const fontProvider = fontProviderRef.current
    const supported = new Set(block.fontMetadata?.supportedCharacters || [])
    if ([...text].some((character) => !/\s/.test(character) && !supported.has(character)) && fontProvider?.supported) void fontProvider.prepare()
    await runPdfCommand(new ReplaceNativeTextBlockCommand(block, text, { fontProvider }), {
      onResult: (result) => {
        if (result.block) setSelectedBlockKey(result.block.key)
        fontToast(result.fontPlan, result.warnings, 'Text updated in its original font, size and colour.')
      },
    })
  }, [fontToast, runPdfCommand])

  const restyleBlock = useCallback(async (block, style) => {
    const fontProvider = fontProviderRef.current
    if ((style.fontSource === 'local' || (style.fontFamily && !isStandardFamily(style.fontFamily)) || style.bold !== undefined || style.italic !== undefined) && fontProvider?.supported) void fontProvider.prepare()
    const reference = { key: block.key, pageIndex: block.pageIndex, runKeys: [...block.runKeys], text: block.text }
    await runPdfCommand(new TransformPdfBytesCommand((bytes) => restyleNativeTextBlock(bytes, reference, style, { fontProvider }), { label: 'Change text style', pageIndex: block.pageIndex }), {
      onResult: (result) => {
        if (result.block) setSelectedBlockKey(result.block.key)
        fontToast(result.fontPlan, result.warnings, 'Text style updated.')
      },
    })
  }, [fontToast, runPdfCommand])

  const editImage = useCallback(async (image, operation, label) => {
    await runPdfCommand(new TransformPdfBytesCommand((bytes) => editPageImage(bytes, image, operation), { label, pageIndex: image.pageIndex }), {
      onResult: (result) => {
        setSelectedImageKey(result.image?.key || null)
        showToast(operation.type === 'delete' ? 'Image removed from the page.' : 'Image updated in the PDF.')
      },
    })
  }, [runPdfCommand, showToast])

  const handlePageImageAction = useCallback((image, operation) => {
    if (operation.type === 'replace' && !operation.data) { chooseImage({ kind: 'page', image }); return }
    const labels = { transform: 'Move image', delete: 'Delete image', opacity: 'Change image opacity', replace: 'Replace image' }
    void editImage(image, operation, labels[operation.type])
  }, [chooseImage, editImage])

  const handleImageFile = useCallback(async (file) => {
    const target = imageTargetRef.current || { kind: 'new' }
    imageTargetRef.current = null
    if (!file) return
    try {
      const image = await importImageFile(file)
      if (target.kind === 'page') {
        await editImage(target.image, { type: 'replace', data: image.data }, 'Replace image')
      } else if (target.kind === 'object') {
        const object = target.object
        const height = object.width * (image.pixelHeight / image.pixelWidth)
        await updateObject({ ...object, ...image, assetId: newId('asset'), height }, 'Replace image')
      } else {
        await placeImageObject(image)
      }
    } catch (error) {
      showToast(error?.message || 'The picture could not be added.', 'error')
    } finally {
      if (imageInputRef.current) imageInputRef.current.value = ''
    }
  }, [editImage, placeImageObject, showToast, updateObject])

  // ---------------------------------------------------------------------------
  // Export and document-level operations
  // ---------------------------------------------------------------------------

  /** Working PDF plus every added item (text, images, markup…). */
  const buildOutputBytes = useCallback(async ({ flatten = false } = {}) => {
    const core = documentCoreRef.current
    const bytes = core.getWorkingBytes()
    const list = core.objects.list()
    if (!list.length) return { bytes, warnings: [] }
    if (list.some((object) => object.type === 'text' && object.fontSource === 'local') && fontProviderRef.current?.supported) {
      await fontProviderRef.current.prepare()
    }
    return writePageObjects(bytes, list, { fontProvider: fontProviderRef.current, flatten })
  }, [])

  const savePdf = async ({ flatten = false } = {}) => {
    if (!requireDocument()) return
    setExportMenu(false)
    setSaving(true)
    try {
      const core = documentCoreRef.current
      const wasDirty = core.isDirty
      await core.validateForExport({ expectedPageCount: documentSession?.pageCount })
      const { bytes, warnings } = await buildOutputBytes({ flatten })
      await PDFDocument.load(bytes, { updateMetadata: false })
      const outputName = `${fileName.replace(/\.pdf$/i, '')}${wasDirty || flatten ? '-edited' : ''}.pdf`
      downloadPdf(bytes, outputName)
      await core.markSaved()
      showToast([flatten ? 'Flattened PDF downloaded. Added items are now part of the pages.' : 'PDF downloaded. Added items stay adjustable when you open it in Earthix again.', ...warnings].join(' '), warnings.length ? 'warning' : '')
    } catch (error) {
      showToast(`Could not export PDF: ${error?.message || 'Unknown error'}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  const refreshViewerFromDocumentCore = useCallback(async () => {
    const core = documentCoreRef.current
    if (!core) throw new Error('The document state is unavailable.')
    const snapshot = core.getSnapshot()
    const bytes = core.getWorkingBytes()
    if (sameBytes(bytes, originalPdfBytesRef.current) && snapshot.pageCount === documentSessionRef.current?.pageCount) return snapshot
    const inspectionPromise = inspectNativePdfText(bytes).catch((error) => ({ runs: [], error }))
    await replaceDocumentSession(bytes, snapshot.fileName)
    originalPdfBytesRef.current = bytes.slice()
    setFileName(snapshot.fileName)
    setFileSize(bytes.byteLength)
    setCurrentPage(snapshot.currentPageIndex)
    setActiveBlock(null)
    setSelectedImageKey(null)
    applyInspection(await inspectionPromise)
    return snapshot
  }, [applyInspection, replaceDocumentSession])

  const runHistoryAction = useCallback(async (action) => {
    const core = documentCoreRef.current
    if (!core || !['undo', 'redo'].includes(action) || pdfBusyRef.current) return
    setEditingText(null)
    setPreviewObject(null)
    try {
      const changed = await core[action]()
      if (!changed) return
      await refreshViewerFromDocumentCore()
      const ids = new Set(core.objects.list().map((object) => object.id))
      setSelectedObjectId((id) => (id && ids.has(id) ? id : null))
    } catch (error) {
      try {
        await core[action === 'undo' ? 'redo' : 'undo']()
        await refreshViewerFromDocumentCore()
      } catch (restoreError) {
        showToast(`History recovery failed: ${restoreError.message}`, 'error')
      }
      showToast(`Could not ${action} the change: ${error.message}`, 'error')
    }
  }, [refreshViewerFromDocumentCore, showToast])

  const mergePdfs = async (files) => {
    if (!files?.length) return
    if (files.length < 2) { showToast('Select at least two PDF files to merge.', 'error'); return }
    setProcessing(true)
    try {
      const output = await PDFDocument.create()
      for (const file of files) {
        const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
        if (!isPdf) throw new Error(file.name + ' is not a PDF file.')
        const source = await PDFDocument.load(await file.arrayBuffer())
        const copied = await output.copyPages(source, source.getPageIndices())
        copied.forEach((page) => output.addPage(page))
      }
      const bytes = new Uint8Array(await output.save({ useObjectStreams: true }))
      await commitPdfBytes(bytes, 'Merged-Document.pdf', 0)
      setActiveWorkspace('edit')
      showToast('Merged ' + files.length + ' PDF documents into one file.')
    } catch (error) {
      showToast('Merge failed: ' + (error?.message || 'Unknown error'), 'error')
    } finally {
      setProcessing(false)
      if (mergeInputRef.current) mergeInputRef.current.value = ''
    }
  }

  const splitPdf = async () => {
    if (!requireDocument()) return
    const from = Number(splitFrom)
    const to = Number(splitTo)
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > pageCount) {
      showToast('Enter a valid page range between 1 and ' + pageCount + '.', 'error')
      return
    }
    setProcessing(true)
    try {
      const source = await PDFDocument.load((await buildOutputBytes()).bytes)
      const output = await PDFDocument.create()
      const copied = await output.copyPages(source, Array.from({ length: to - from + 1 }, (_, index) => from - 1 + index))
      copied.forEach((page) => output.addPage(page))
      downloadPdf(await output.save({ useObjectStreams: true }), fileName.replace(/\.pdf$/i, '') + '-pages-' + from + '-' + to + '.pdf')
      showToast('Pages ' + from + '–' + to + ' exported as a separate PDF.')
    } catch (error) {
      showToast('Split failed: ' + (error?.message || 'Unknown error'), 'error')
    } finally {
      setProcessing(false)
    }
  }

  const applyOrganizeChanges = async () => {
    if (!requireDocument() || !pagePlanChanged) return
    setProcessing(true)
    try {
      const bytes = await applyPagePlanToPdf((await buildOutputBytes()).bytes, pagePlan)
      await commitPdfBytes(bytes, fileName, 0)
      setActiveWorkspace('organize')
      showToast('Page changes applied to the PDF.')
    } catch (error) {
      showToast('Could not apply page changes: ' + (error?.message || 'Unknown error'), 'error')
    } finally {
      setProcessing(false)
    }
  }

  const optimizePdf = async () => {
    if (!requireDocument()) return
    setProcessing(true)
    try {
      const input = (await buildOutputBytes()).bytes
      const source = await PDFDocument.load(input)
      const bytes = await source.save({ useObjectStreams: true, addDefaultPage: false })
      downloadPdf(bytes, fileName.replace(/\.pdf$/i, '') + '-optimized.pdf')
      const reduction = Math.round((1 - bytes.byteLength / input.byteLength) * 100)
      showToast(reduction > 0 ? 'Optimized copy downloaded (' + reduction + '% smaller).' : 'Optimized copy downloaded. The file was already compact.')
    } catch (error) {
      showToast('Optimization failed: ' + (error?.message || 'Unknown error'), 'error')
    } finally {
      setProcessing(false)
    }
  }

  const handleNav = async (id) => {
    setNavOpen(false)
    if (id === 'merge') { setActiveWorkspace('home'); mergeInputRef.current?.click(); return }
    if (id === 'compress') { setActiveWorkspace('edit'); await optimizePdf(); return }
    setActiveWorkspace(id)
  }

  const handleViewerError = useCallback((error) => {
    if (awaitingRenderRef.current) {
      awaitingRenderRef.current = false
      setActiveBlock(null)
      setPdfBusy(false)
    }
    showToast(error?.message || 'This page could not be shown.', 'error')
  }, [showToast])

  const changeZoom = (amount) => {
    setZoomMode('manual')
    setZoom((value) => Math.max(0.25, Math.min(4, Number((value + amount).toFixed(2)))))
  }

  const onDrop = (event) => {
    event.preventDefault()
    setDragging(false)
    const files = Array.from(event.dataTransfer?.files || [])
    const pdf = files.find((item) => item.type === 'application/pdf' || item.name.toLowerCase().endsWith('.pdf'))
    const picture = files.find((item) => item.type.startsWith('image/'))
    if (pdf) void openPdf(pdf)
    else if (picture && documentSession) { imageTargetRef.current = { kind: 'new' }; void handleImageFile(picture) }
    else showToast('Drop a PDF to open it, or a picture to add it to the page.', 'error')
  }

  const loadLocalFonts = useCallback(async () => {
    const provider = fontProviderRef.current
    if (!provider?.supported) { showToast('This browser cannot list installed fonts. Open Earthix in Chrome or Edge to use your computer’s fonts.', 'warning'); return }
    const entries = await provider.prepare()
    setLocalFontStatus(provider.status)
    if (!entries.length) { showToast('Font access was not allowed. Only standard PDF fonts can be used.', 'warning'); return }
    setLocalFamilies([...new Set(entries.map((entry) => entry.family).filter(Boolean))].sort((a, b) => a.localeCompare(b)))
  }, [showToast])

  const updateToolSettings = useCallback((name, patch) => {
    setToolSettings((current) => ({ ...current, [name]: { ...current[name], ...patch } }))
    drawSessionRef.current = null
  }, [])

  // ---------------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------------

  const selectedObject = useMemo(() => {
    const object = objects.find((item) => item.id === selectedObjectId) || null
    return object && previewObject?.id === object.id ? previewObject : object
  }, [objects, selectedObjectId, previewObject])

  useEffect(() => {
    const onKeyDown = (event) => {
      const target = event.target
      const typing = target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      const mod = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()
      if (mod && key === 's') { event.preventDefault(); if (documentSessionRef.current) void savePdfRef.current() ; return }
      if (typing) return
      if (mod && key === 'z') { event.preventDefault(); void runHistoryAction(event.shiftKey ? 'redo' : 'undo'); return }
      if (mod && key === 'y') { event.preventDefault(); void runHistoryAction('redo'); return }
      if (mod && (key === '=' || key === '+')) { event.preventDefault(); changeZoomRef.current(0.1); return }
      if (mod && key === '-') { event.preventDefault(); changeZoomRef.current(-0.1); return }
      if (activeWorkspace !== 'edit' || !documentSessionRef.current) return
      const object = selectedObjectRef.current
      if (mod && key === 'd' && object) { event.preventDefault(); void duplicateObject(object); return }
      if (mod && key === 'c' && object) { clipboardRef.current = object; return }
      if (mod && key === 'v' && clipboardRef.current) {
        event.preventDefault()
        const source = clipboardRef.current
        void createObject({ ...moveObject(source, 16, 16), id: newId(source.type), pageIndex: currentPageRef.current }, 'Paste')
        return
      }
      if ((key === 'delete' || key === 'backspace') && object) { event.preventDefault(); void removeObject(object); return }
      if (key.startsWith('arrow') && object && !object.locked) {
        event.preventDefault()
        const step = event.shiftKey ? 10 : 1
        const dx = key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0
        const dy = key === 'arrowup' ? -step : key === 'arrowdown' ? step : 0
        void updateObject(moveObject(object, dx, dy), 'Nudge')
        return
      }
      if (key === 'escape') {
        if (selectedObjectRef.current || selectedImageKeyRef.current || selectedBlockKeyRef.current) clearSelections()
        else setTool('select')
        return
      }
      if (!mod && !event.altKey) {
        const match = TOOLS.find((item) => item.key === key)
        if (match) {
          event.preventDefault()
          if (match.id === 'image') chooseImage()
          else if (match.id === 'signature') { signaturePointRef.current = null; setSignatureOpen(true) }
          else setTool(match.id)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeWorkspace, chooseImage, clearSelections, createObject, duplicateObject, removeObject, runHistoryAction, setTool, updateObject])

  const savePdfRef = useRef(savePdf)
  savePdfRef.current = savePdf
  const changeZoomRef = useRef(changeZoom)
  changeZoomRef.current = changeZoom
  const selectedObjectRef = useRef(null)
  selectedObjectRef.current = selectedObject
  const selectedImageKeyRef = useRef(null)
  selectedImageKeyRef.current = selectedImageKey
  const selectedBlockKeyRef = useRef(null)
  selectedBlockKeyRef.current = selectedBlockKey
  const currentPageRef = useRef(0)
  currentPageRef.current = currentPage

  // ---------------------------------------------------------------------------
  // Derived view state
  // ---------------------------------------------------------------------------

  const selectedBlock = useMemo(() => {
    const block = activeBlock || nativeBlocks.find((item) => item.key === selectedBlockKey) || null
    if (!block) return null
    return { ...block, firstRun: nativeRuns.find((run) => run.key === block.runKeys[0]) || null }
  }, [activeBlock, nativeBlocks, selectedBlockKey, nativeRuns])
  const selectedImage = useMemo(() => pageImages.find((image) => image.key === selectedImageKey) || null, [pageImages, selectedImageKey])

  const selection = selectedObject
    ? { kind: 'object', object: selectedObject }
    : tool === 'edit' && selectedBlock
      ? { kind: 'block', block: selectedBlock, editing: Boolean(activeBlock) }
      : tool === 'edit' && selectedImage
        ? { kind: 'image', image: selectedImage }
        : null

  useEffect(() => {
    if (!isMobile) return
    setShowRight(Boolean(selection))
  }, [isMobile, selectedObjectId, selectedBlockKey, selectedImageKey])

  const objectCountByPage = useMemo(() => {
    const counts = new Map()
    for (const object of objects) counts.set(object.pageIndex, (counts.get(object.pageIndex) || 0) + 1)
    return counts
  }, [objects])

  const pageObjects = useMemo(() => objects
    .filter((object) => object.pageIndex === currentPage)
    .map((object) => (previewObject?.id === object.id ? previewObject : object)), [objects, currentPage, previewObject])

  const saveStatus = !documentCoreState
    ? null
    : documentCoreState.autosaveStatus === 'error'
      ? { label: 'Autosave unavailable', tone: 'error' }
      : documentCoreState.isDirty
        ? { label: documentCoreState.autosaveStatus === 'saving' ? 'Saving locally…' : 'Edited · not exported', tone: 'dirty' }
        : { label: 'No unsaved changes', tone: '' }

  const objectActions = useMemo(() => ({
    update: (object, label) => void updateObject(object, label),
    preview: (object) => setPreviewObject(object),
    remove: (object) => void removeObject(object),
    duplicate: (object) => void duplicateObject(object),
    arrange: (object, direction) => void arrangeObject(object, direction),
    replaceImage: (object) => chooseImage({ kind: 'object', object }),
  }), [arrangeObject, chooseImage, duplicateObject, removeObject, updateObject])

  const localFonts = { families: localFamilies, supported: fontProviderRef.current?.supported, status: localFontStatus, onLoad: () => void loadLocalFonts() }

  const selectTool = (id) => {
    if (id === 'image') { chooseImage(); return }
    if (id === 'signature') { signaturePointRef.current = null; setSignatureOpen(true); return }
    setTool(id)
  }

  const placeSignature = async (result) => {
    setSignatureOpen(false)
    const point = signaturePointRef.current
    signaturePointRef.current = null
    if (result.kind === 'image') {
      await placeImageObject(result, { point, label: 'Add signature', signature: true })
      return
    }
    const info = await documentSessionRef.current?.getPageInfo?.(currentPage).catch(() => null)
    const pageWidth = info?.width || 612
    const pageHeight = info?.height || 792
    const width = Math.min(170, pageWidth * 0.35)
    const scale = width / result.width
    const height = result.height * scale
    const x = point ? point.x - width / 2 : (pageWidth - width) / 2
    const y = point ? point.y - height / 2 : pageHeight * 0.6
    const strokes = result.strokes.map((stroke) => stroke.map((item) => ({ x: x + item.x * scale, y: y + item.y * scale })))
    const strokeWidth = 1.6
    await createObject({ id: newId('signature'), type: 'ink', signature: true, pageIndex: currentPage, strokes, color: result.color, strokeWidth, opacity: 1, ...inkBounds(strokes, strokeWidth) }, 'Add signature')
    setToolState('select')
  }

  const onStagePointerDown = (event) => {
    if (event.target.closest?.('.object-node, .selection-frame, .endpoint-handle, .earthix-text-hit, .earthix-inline-editor, .page-image-hit, .text-object-editor, .object-drag-proxy, .create-surface')) return
    setSelectedObjectId(null)
    setSelectedImageKey(null)
    if (!activeBlockRef.current) setSelectedBlockKey(null)
  }

  const renderOverlay = ({ viewport, scale, canvas, pageIndex }) => (
    <>
      {tool === 'edit' && (
        <PageImageLayer
          images={pageImages.filter((image) => image.pageIndex === pageIndex)}
          scale={scale}
          canvas={canvas}
          selectedKey={selectedImageKey}
          busy={pdfBusy}
          onSelect={(image) => { setSelectedImageKey(image.key); setSelectedBlockKey(null); setSelectedObjectId(null); if (!image.editable) showToast(image.reason, 'warning') }}
          onTransform={(image, to) => void editImage(image, { type: 'transform', from: image.viewRect, to }, 'Move image')}
        />
      )}
      <ObjectLayer
        pageIndex={pageIndex}
        scale={scale}
        pageWidth={viewport.width / scale}
        pageHeight={viewport.height / scale}
        objects={pageObjects}
        tool={tool}
        settings={toolSettings}
        selectedId={selectedObjectId}
        editingObject={editingText}
        busy={pdfBusy}
        fontVersion={fontVersion}
        onSelect={(id) => { setSelectedObjectId(id); setSelectedImageKey(null); if (id) setSelectedBlockKey(null) }}
        onChange={(object, label) => void updateObject(object, label)}
        onCreate={(object, label) => void createObject(object, label, { select: object.type !== 'highlight' })}
        onInkStroke={(points) => void handleInkStroke(pageIndex, points)}
        onStartText={startTextEdit}
        onTextCommit={(object, text) => void commitTextEdit(object, text)}
        onPlaceSignature={(point) => { signaturePointRef.current = point; setSignatureOpen(true) }}
      />
    </>
  )

  const documentInfo = {
    fileName, fileSize: formatBytes(fileSize), pageCount, currentPage, objectCount: objects.length,
    editableBlocks: nativeBlocks.filter((block) => block.editable).length,
  }
  const activeToolInfo = TOOL_BY_ID.get(hintTool)
  const editingWorkspace = activeWorkspace === 'edit'

  const toolButtons = (
    TOOLS.map((item) => {
      const Icon = item.icon
      return (
        <button
          key={item.id}
          type="button"
          className={`tool-btn ${tool === item.id ? 'active' : ''}`}
          title={`${item.label} (${item.key.toUpperCase()}) — ${item.hint}`}
          aria-pressed={tool === item.id}
          disabled={!documentSession}
          onClick={() => selectTool(item.id)}
        >
          <Icon /><span>{item.label}</span>
        </button>
      )
    })
  )

  return (
    <main className="app-shell">
      <input ref={fileInputRef} type="file" accept="application/pdf,.pdf" hidden onChange={(event) => void openPdf(event.target.files?.[0])} />
      <input ref={mergeInputRef} type="file" accept="application/pdf,.pdf" multiple hidden onChange={(event) => void mergePdfs(Array.from(event.target.files || []))} />
      <input ref={imageInputRef} type="file" accept="image/*" hidden onChange={(event) => void handleImageFile(event.target.files?.[0])} />

      {isMobile && navOpen && <div className="backdrop" onClick={() => setNavOpen(false)} />}
      <aside className={`app-rail ${navOpen ? 'open' : ''}`} aria-label="Main navigation">
        <div className="rail-brand" title="Earthix PDF Studio">e</div>
        <nav className="rail-nav">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon
            return (
              <button key={item.id} type="button" className={`rail-item ${item.id === activeWorkspace ? 'active' : ''}`} onClick={() => void handleNav(item.id)}>
                <Icon /><span>{item.label}</span>
              </button>
            )
          })}
        </nav>
        <div className="rail-bottom">
          <button type="button" className="rail-item" onClick={() => { setNavOpen(false); fileInputRef.current?.click() }}><FaUpload /><span>Open</span></button>
          <button type="button" className="rail-item" onClick={toggleTheme} title="Switch light / dark theme">{effectiveTheme === 'dark' ? <FaSun /> : <FaMoon />}<span>{effectiveTheme === 'dark' ? 'Light' : 'Dark'}</span></button>
        </div>
      </aside>

      <section className="app-main">
        <header className="app-header">
          <div className="header-left">
            <button type="button" className="icon-btn only-mobile" onClick={() => setNavOpen(true)} aria-label="Open menu"><FaBars /></button>
            <div className="brand-text"><strong>Earthix</strong><span>PDF Studio</span></div>
            <div className="doc-chip" title={fileName}>
              <FaFilePdf />
              <span>{fileName}</span>
              <button type="button" className="icon-btn sm" onClick={() => fileInputRef.current?.click()} title="Open another PDF" aria-label="Open another PDF"><FaPlus /></button>
            </div>
          </div>
          <div className="header-right">
            {saveStatus && <span className={`save-pill ${saveStatus.tone}`} title={documentCoreState?.autosaveError || 'Edits are kept in this browser until you export.'}><i />{saveStatus.label}</span>}
            {editingWorkspace && <button type="button" className="icon-btn only-mobile" title="Undo" onClick={() => void runHistoryAction('undo')} disabled={!documentCoreState?.canUndo || pdfBusy}><FaUndo /></button>}
            {editingWorkspace && <button type="button" className="icon-btn only-mobile" title="Redo" onClick={() => void runHistoryAction('redo')} disabled={!documentCoreState?.canRedo || pdfBusy}><FaRedo /></button>}
            <div className="menu-wrap">
              <div style={{ display: 'flex', gap: 2 }}>
                <button className="btn btn-primary" type="button" onClick={() => void savePdf()} disabled={!documentSession || saving || processing} title="Download the edited PDF (Ctrl+S)">
                  {saving ? <FaSpinner className="spin" /> : <FaDownload />}<span>{saving ? 'Exporting…' : 'Export PDF'}</span>
                </button>
                <button className="btn btn-secondary hide-mobile" type="button" style={{ width: 34, padding: 0 }} onClick={() => setExportMenu((value) => !value)} disabled={!documentSession} aria-label="More export options"><FaChevronDown /></button>
              </div>
              {exportMenu && (
                <>
                  <div style={{ position: 'fixed', inset: 0, zIndex: 50 }} onClick={() => setExportMenu(false)} />
                  <div className="menu">
                    <button type="button" onClick={() => void savePdf()}><FaDownload /><div>Download PDF<small>Added items stay adjustable in Earthix</small></div></button>
                    <button type="button" onClick={() => void savePdf({ flatten: true })}><FaLayerGroup /><div>Download flattened PDF<small>Merge every added item into the pages</small></div></button>
                    <hr />
                    <button type="button" onClick={() => { setExportMenu(false); window.print() }}><FaPrint /><div>Print</div></button>
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        {editingWorkspace && (
          <section className="editor-toolbar" aria-label="Editing tools">
            <div className="toolbar-group">
              <button type="button" className="icon-btn" title="Undo (Ctrl+Z)" onClick={() => void runHistoryAction('undo')} disabled={!documentCoreState?.canUndo || processing || saving || pdfBusy}><FaUndo /></button>
              <button type="button" className="icon-btn" title="Redo (Ctrl+Y)" onClick={() => void runHistoryAction('redo')} disabled={!documentCoreState?.canRedo || processing || saving || pdfBusy}><FaRedo /></button>
            </div>
            <span className="toolbar-sep" />
            <div className="tool-strip">{toolButtons}</div>
            <span className="toolbar-sep" />
            <div className="toolbar-group">
              <button type="button" className={`icon-btn ${showLeft ? 'active' : ''}`} title="Pages, search and items" onClick={() => setShowLeft((value) => !value)}><FaList /></button>
              <button type="button" className={`icon-btn ${showRight ? 'active' : ''}`} title="Properties" onClick={() => setShowRight((value) => !value)}><FaSlidersH /></button>
            </div>
          </section>
        )}

        <section className="workspace">
          {activeWorkspace === 'home' ? (
            <HomeWorkspace
              onOpenPdf={() => fileInputRef.current?.click()}
              onMerge={() => mergeInputRef.current?.click()}
              recentFiles={recentFiles}
              onOpenRecent={(item) => (item.file ? void openPdf(item.file) : showToast('This recent file is no longer available in this browser session.', 'error'))}
              pageCount={pageCount}
              fileName={documentSession ? fileName : ''}
            />
          ) : activeWorkspace === 'split' ? (
            <SplitWorkspace pageCount={pageCount} fileName={fileName} fromPage={splitFrom} toPage={splitTo} setFromPage={setSplitFrom} setToPage={setSplitTo} onSplit={() => void splitPdf()} processing={processing} onOpenPdf={() => fileInputRef.current?.click()} />
          ) : activeWorkspace === 'organize' ? (
            <OrganizeWorkspace
              session={documentSession}
              plan={pagePlan}
              onMove={(from, to) => setPagePlan((current) => movePageInPlan(current, from, to))}
              onRotate={(index, amount) => setPagePlan((current) => rotatePageInPlan(current, index, amount))}
              onRemove={(index) => setPagePlan((current) => removePageFromPlan(current, index))}
              onAddBlank={() => setPagePlan((current) => addBlankPage(current))}
              onApply={() => void applyOrganizeChanges()}
              onReset={() => setPagePlan(createPagePlan(pageCount))}
              changed={pagePlanChanged}
              processing={processing}
              onOpenPdf={() => fileInputRef.current?.click()}
            />
          ) : (
            <>
              {showLeft && (
                <aside className="side-panel left" aria-label="Document panel">
                  <div className="panel-tabs" role="tablist">
                    <button type="button" className={leftTab === 'pages' ? 'active' : ''} onClick={() => setLeftTab('pages')}>Pages</button>
                    <button type="button" className={leftTab === 'search' ? 'active' : ''} onClick={() => setLeftTab('search')}>Search</button>
                    <button type="button" className={leftTab === 'items' ? 'active' : ''} onClick={() => setLeftTab('items')}>Items{objects.length ? ` (${objects.length})` : ''}</button>
                    {isCompact && <button type="button" style={{ flex: 'none', width: 30 }} onClick={() => setShowLeft(false)} aria-label="Close panel"><FaTimes /></button>}
                  </div>
                  <div className="panel-body">
                    {leftTab === 'pages' && (
                      <div className="pages-grid">
                        {pages.map((page) => (
                          <div key={`${documentSession?.fileName || 'document'}-${page.id}`} className="thumb-wrap">
                            <PdfPageThumbnail session={documentSession} pageIndex={page.index} active={page.index === currentPage} engineStatus={engineStatus} onClick={() => { setPage(page.index); if (isCompact) setShowLeft(false) }} />
                            {objectCountByPage.get(page.index) > 0 && <span className="thumb-badge" title="Added items on this page">{objectCountByPage.get(page.index)}</span>}
                          </div>
                        ))}
                        {!pageCount && <p className="empty-note">Page previews appear here when a PDF is open.</p>}
                      </div>
                    )}
                    {leftTab === 'search' && (
                      <>
                        <div className="search-field"><FaSearch /><input value={nativeSearchTerm} onChange={(event) => setNativeSearchTerm(event.target.value)} placeholder="Search in this PDF" disabled={!documentSession} autoFocus /></div>
                        {nativeSearchTerm.trim() && <p className="list-heading" style={{ marginTop: 14 }}><span>Results</span><span>{pdfSearchBusy ? 'Searching…' : `${pdfSearchResults.length}${pdfSearchResults.length >= 80 ? '+' : ''}`}</span></p>}
                        <div className="list-stack">
                          {pdfSearchResults.map((result) => (
                            <button type="button" key={result.id} className={`list-item ${result.pageIndex === currentPage ? 'active' : ''}`} onClick={() => { setPage(result.pageIndex); if (isCompact) setShowLeft(false) }}>
                              <span className="li-text"><strong>{result.text}</strong><small>Page {result.pageNumber}</small></span>
                            </button>
                          ))}
                        </div>
                        {nativeSearchTerm.trim() && !pdfSearchBusy && !pdfSearchResults.length && <p className="empty-note">No matches found.</p>}
                        {!nativeSearchTerm.trim() && <p className="empty-note">Type a word to find it on every page.</p>}
                      </>
                    )}
                    {leftTab === 'items' && (
                      <>
                        {!objects.length && <p className="empty-note">Text, images, highlights, drawings and comments you add appear here.</p>}
                        {[...new Set(objects.map((object) => object.pageIndex))].sort((a, b) => a - b).map((pageIndex) => (
                          <div key={pageIndex}>
                            <p className="list-heading"><span>Page {pageIndex + 1}</span></p>
                            <div className="list-stack">
                              {objects.filter((object) => object.pageIndex === pageIndex).sort((a, b) => (b.z ?? 0) - (a.z ?? 0)).map((object) => (
                                <button type="button" key={object.id} className={`list-item ${object.id === selectedObjectId ? 'active' : ''}`} onClick={() => { setPage(pageIndex); setTool('select'); setSelectedObjectId(object.id); if (isCompact) setShowLeft(false) }}>
                                  <span className="li-text">
                                    <strong>{object.type === 'text' ? object.text.split('\n')[0] || 'Text' : object.type === 'note' ? object.text || 'Comment' : object.type === 'highlight' && object.text ? object.text : objectLabel(object)}</strong>
                                    <small>{objectLabel(object)}</small>
                                  </span>
                                </button>
                              ))}
                            </div>
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                </aside>
              )}

              <section className="stage">
                <div
                  className={`stage-viewport ${dragging ? 'dragging' : ''}`}
                  onPointerDown={onStagePointerDown}
                  onDragOver={(event) => { event.preventDefault(); setDragging(true) }}
                  onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false) }}
                  onDrop={onDrop}
                >
                  {!documentSession && !engineError && (
                    <div className="welcome">
                      <div className="welcome-card">
                        <span className="welcome-icon"><FaFilePdf /></span>
                        <h1>Open a PDF to start editing</h1>
                        <p>Edit existing text in its own font, add text, images and signatures, highlight, draw and comment.</p>
                        <button type="button" className="btn btn-primary" onClick={() => fileInputRef.current?.click()}><FaUpload /> Choose PDF</button>
                        <small>or drop a file here · it never leaves this device</small>
                        <div className="welcome-features">
                          {TOOLS.slice(1, 9).map((item) => { const Icon = item.icon; return <span key={item.id}><Icon />{item.label}</span> })}
                        </div>
                      </div>
                    </div>
                  )}
                  {engineError && <div className="engine-error"><FaTools /><h2>This PDF could not be opened</h2><p>{engineError}</p><button type="button" className="btn btn-secondary" onClick={() => fileInputRef.current?.click()}>Choose another PDF</button></div>}
                  {documentSession && (
                    <PdfPageViewer
                      session={documentSession}
                      pageIndex={currentPage}
                      zoomMode={zoomMode}
                      zoom={zoom}
                      searchQuery={nativeSearchTerm}
                      searchItemIndexes={currentSearchItemIndexes}
                      engineStatus={engineStatus}
                      editMode={tool === 'edit'}
                      textBlocks={nativeBlocks}
                      activeBlock={activeBlock}
                      activeClickPoint={activeClickPoint}
                      editBusy={pdfBusy}
                      onBlockActivate={requestBlockEdit}
                      onBlockCommit={commitBlockEdit}
                      onBlockCancel={cancelBlockEdit}
                      onDraftChange={setEditorDraft}
                      onPageRendered={handlePageRendered}
                      onZoomChange={setZoom}
                      onTextSelected={() => undefined}
                      onRenderError={handleViewerError}
                      renderOverlay={renderOverlay}
                      textLayerActive={tool === 'select' || tool === 'highlight'}
                      selectedBlockKey={selectedBlockKey}
                    />
                  )}
                  {documentSession && activeToolInfo && activeToolInfo.id !== 'select' && <div className="tool-hint"><activeToolInfo.icon />{activeToolInfo.hint}</div>}
                  {processing && <div className="processing-mask"><FaSpinner className="spin" /><span>{processingProgress ? `Processing PDF… ${processingProgress}%` : 'Processing PDF…'}</span></div>}
                </div>
                <footer className="stage-footer">
                  <button type="button" className="icon-btn sm only-mobile" onClick={() => setShowLeft(true)} title="Pages"><FaList /></button>
                  <div className="page-nav">
                    <button type="button" className="icon-btn sm" onClick={() => setPage(currentPage - 1)} disabled={!pageCount || currentPage <= 0} aria-label="Previous page"><FaChevronLeft /></button>
                    <input value={pageInput} inputMode="numeric" aria-label="Page number" disabled={!pageCount}
                      onChange={(event) => setPageInput(event.target.value.replace(/\D/g, ''))}
                      onBlur={() => { const value = Number(pageInput); if (value >= 1 && value <= pageCount) setPage(value - 1); else setPageInput(String(currentPage + 1)) }}
                      onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} />
                    <span>/ {pageCount || 0}</span>
                    <button type="button" className="icon-btn sm" onClick={() => setPage(currentPage + 1)} disabled={!pageCount || currentPage >= pageCount - 1} aria-label="Next page"><FaChevronRight /></button>
                  </div>
                  <span className="footer-sep" />
                  <div className="zoom-box">
                    <button type="button" className="icon-btn sm" onClick={() => changeZoom(-0.1)} disabled={!documentSession} title="Zoom out (Ctrl −)"><FaMinus /></button>
                    <span>{Math.round(zoom * 100)}%</span>
                    <button type="button" className="icon-btn sm" onClick={() => changeZoom(0.1)} disabled={!documentSession} title="Zoom in (Ctrl +)"><FaPlus /></button>
                  </div>
                  <button type="button" className={`icon-btn sm ${zoomMode === 'width' ? 'active' : ''}`} title="Fit width" onClick={() => setZoomMode('width')} disabled={!documentSession}><FaExpand /></button>
                  <button type="button" className={`icon-btn sm hide-compact ${zoomMode === 'page' ? 'active' : ''}`} title="Fit page" onClick={() => setZoomMode('page')} disabled={!documentSession}><FaCompress /></button>
                  <button type="button" className="icon-btn sm only-mobile" onClick={() => setShowRight((value) => !value)} title="Properties"><FaSlidersH /></button>
                </footer>
              </section>

              {showRight && (
                <PropertiesPanel
                  selection={selection}
                  tool={tool}
                  toolSettings={toolSettings}
                  onToolSettings={updateToolSettings}
                  objectActions={objectActions}
                  blockBusy={pdfBusy}
                  imageBusy={pdfBusy}
                  onBlockStyle={(block, style) => void restyleBlock(block, style)}
                  onImage={handlePageImageAction}
                  localFonts={localFonts}
                  fonts={fontInspection}
                  editorDraft={editorDraft}
                  documentInfo={documentInfo}
                  onClose={() => setShowRight(false)}
                  onChooseImage={() => chooseImage()}
                  onSignature={() => { signaturePointRef.current = null; setSignatureOpen(true) }}
                />
              )}
              {isCompact && !isMobile && (showLeft || showRight) && <div className="backdrop" style={{ position: 'absolute', zIndex: 75 }} onClick={() => { setShowLeft(false); setShowRight(false) }} />}
            </>
          )}
        </section>
      </section>

      {isMobile && editingWorkspace && documentSession && <nav className="mobile-dock" aria-label="Editing tools">{toolButtons}</nav>}
      {signatureOpen && <SignatureDialog onCancel={() => { setSignatureOpen(false); signaturePointRef.current = null }} onConfirm={(result) => void placeSignature(result)} />}
      <Toast message={toast.message} type={toast.type} onClose={closeToast} />
    </main>
  )
}

export default App
