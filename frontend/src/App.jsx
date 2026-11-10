import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { PDFDocument } from 'pdf-lib'
import {
  FaBars, FaCheckCircle, FaChevronDown, FaChevronLeft, FaChevronRight, FaColumns, FaCompress, FaDownload, FaEdit,
  FaExclamationCircle, FaExclamationTriangle, FaExpand, FaFileAlt, FaFilePdf, FaHome, FaLayerGroup, FaList, FaMinus,
  FaPlus, FaSave, FaPrint, FaRedo, FaSearch, FaSlidersH, FaSpinner, FaTh, FaTimes, FaTools, FaUndo, FaUpload,
} from 'react-icons/fa'
import { createPdfEngine } from './engine/index.js'
import {
  createDocumentCore, DocumentCore, ReplacePdfBytesCommand, ReplaceNativeTextBlockCommand,
  SetPageObjectsCommand, TransformPdfBytesCommand,
} from './engine/document-core/index.js'
import { PdfPageThumbnail } from './features/pdf-viewer/PdfPageThumbnail.jsx'
import { PdfPageViewer } from './features/pdf-viewer/PdfPageViewer.jsx'
import { searchPdfDocument } from './features/pdf-viewer/searchPdfDocument.js'
import { editPageImage, inspectNativePdfText, restyleNativeTextBlock } from './services/nativePdfTextEditor.js'
import { addUploadedFont, createAppFontProvider, declareFreeFontFaces, listUploadedFonts } from './features/editor/fontServices.js'
import { FREE_FONT_FAMILIES } from './engine/font-engine/fontLibrary.js'
import { glyphShapes } from './engine/font-engine/previewFonts.js'
import { normalizeFontKey, weightFromStyle } from './engine/font-engine/pdfFontLoader.js'
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
import { prepareImageTextEdit, readTextInArea } from './features/editor/imageText.js'
import { SweetDialogHost, showDialog } from './components/SweetDialog.jsx'
import { listRecentFiles, rememberRecentFile, removeRecentFile } from './features/editor/recentFiles.js'
import { clearSavedSession, loadSavedSession, saveSessionContent, saveSessionView } from './features/editor/sessionStore.js'
import './studio.css'
import './features/editor/editor.css'

const NAV_ITEMS = [
  { id: 'home', label: 'Home', icon: FaHome },
  { id: 'edit', label: 'Edit', icon: FaEdit },
  { id: 'merge', label: 'Merge', icon: FaFileAlt },
  { id: 'split', label: 'Split', icon: FaColumns },
  { id: 'organize', label: 'Pages', icon: FaTh },
  { id: 'compress', label: 'Compress', icon: FaCompress, hint: 'Compress PDF: download a smaller copy that is quicker to share' },
]
const ONE_SHOT_TOOLS = new Set(['text', 'shape', 'note', 'signature', 'image', 'whiteout'])
const SETTINGS_KEY = 'earthix.toolSettings.v1'
const SEEN_HINTS_KEY = 'earthix.seenHints.v1'

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
      const answer = await showDialog({
        icon: 'lock',
        title: attempt ? 'That password didn’t work' : 'This PDF is locked',
        text: attempt ? 'Please try again.' : `Enter the password for ${fileName}.`,
        input: { type: 'password', placeholder: 'Password', required: true },
        confirmText: 'Open',
      })
      if (!answer.confirmed) throw new Error('Opening was cancelled.', { cause: error })
      password = answer.value
    }
  }
  throw new Error('Wrong password.')
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
    fontProviderRef.current = createAppFontProvider()
    setMeasureFontProvider(fontProviderRef.current)
  }
  const pendingActivationRef = useRef(null)
  const drawSessionRef = useRef(null)
  const clipboardRef = useRef(null)
  const signaturePointRef = useRef(null)
  const fileHandleRef = useRef(null)

  const isMobile = useMediaQuery('(max-width: 767px)')
  const isCompact = useMediaQuery('(max-width: 1023px)')

  const [documentSession, setDocumentSession] = useState(null)
  const [documentCoreState, setDocumentCoreState] = useState(null)
  const [engineError, setEngineError] = useState('')
  const [fileName, setFileName] = useState('No document open')
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
  const [nativeSearchTerm, setNativeSearchTerm] = useState('')
  const [pdfSearchResults, setPdfSearchResults] = useState([])
  const [pdfSearchBusy, setPdfSearchBusy] = useState(false)
  const [nativeBlocks, setNativeBlocks] = useState([])
  const [pageImages, setPageImages] = useState([])
  const [activeBlock, setActiveBlock] = useState(null)
  const [activeClickPoint, setActiveClickPoint] = useState(null)
  const [selectedBlockKey, setSelectedBlockKey] = useState(null)
  const [selectedImageKey, setSelectedImageKey] = useState(null)
  const [pdfBusy, setPdfBusy] = useState(false)
  const [recentFiles, setRecentFiles] = useState([])
  const recentIdRef = useRef(null)
  const refreshRecentFiles = useCallback(async () => {
    setRecentFiles((await listRecentFiles()).map((item) => ({ ...item, sizeLabel: formatBytes(item.size) })))
  }, [])
  useEffect(() => { void refreshRecentFiles() }, [refreshRecentFiles])
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
  const [imageReading, setImageReading] = useState(null)
  const [pendingPatch, setPendingPatch] = useState(null)
  const pendingPatchRef = useRef(null)
  pendingPatchRef.current = pendingPatch
  const [leftTab, setLeftTab] = useState('pages')
  const [showLeft, setShowLeft] = useState(() => typeof window === 'undefined' || window.innerWidth >= 1024)
  const [showRight, setShowRight] = useState(() => typeof window === 'undefined' || window.innerWidth >= 1024)
  const [navOpen, setNavOpen] = useState(false)
  const [exportMenu, setExportMenu] = useState(false)
  const [restoring, setRestoring] = useState(true)
  const [paintedSession, setPaintedSession] = useState(null)
  const scrollRestoreRef = useRef(null)
  const viewScrollRef = useRef({ top: 0, left: 0 })
  const viewSaveTimerRef = useRef(null)
  const [sheetExpanded, setSheetExpanded] = useState(false)
  const [signatureOpen, setSignatureOpen] = useState(false)
  const [hintTool, setHintTool] = useState(null)
  const [localFamilies, setLocalFamilies] = useState([])
  const [localWeights, setLocalWeights] = useState(() => new Map())
  const [uploadedFonts, setUploadedFonts] = useState([])
  const fontFileInputRef = useRef(null)
  const [localFontStatus, setLocalFontStatus] = useState(fontProviderRef.current.status)
  const [fontVersion, bumpFontVersion] = useReducer((value) => value + 1, 0)

  const showToast = useCallback((message, type = '') => setToast({ message, type }), [])
  const closeToast = useCallback(() => setToast({ message: '', type: '' }), [])

  useEffect(() => subscribeFontLoads(bumpFontVersion), [])
  // If the browser itself is zoomed (pinch on the toolbar etc.), keep handles at their normal size.
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return undefined
    const update = () => document.documentElement.style.setProperty('--ui-scale', String(1 / Math.max(0.5, viewport.scale || 1)))
    update()
    viewport.addEventListener('resize', update)
    return () => viewport.removeEventListener('resize', update)
  }, [])
  useEffect(() => {
    try { globalThis.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(toolSettings)) } catch { /* storage unavailable */ }
  }, [toolSettings])

  // Panels are drawers on small screens: start closed there.
  useEffect(() => {
    if (isCompact) { setShowLeft(false); setShowRight(false) } else { setShowLeft(true); setShowRight(true) }
  }, [isCompact])

  /** Analyses read unlabelled Hindi letters from installed fonts once font access is allowed. */
  const inspectionOptions = useCallback(() => (fontProviderRef.current?.status === 'granted' ? { fontProvider: fontProviderRef.current } : {}), [])

  // Everything needed to come back after a refresh: the PDF, edits and position.
  const persistTimerRef = useRef(null)
  const persistedKeyRef = useRef('')
  const persistNow = useCallback(() => {
    window.clearTimeout(persistTimerRef.current)
    persistTimerRef.current = null
    const core = documentCoreRef.current
    if (!core || core.closed) return
    const key = `${core.documentId}|${core.currentStateId}|${core.isDirty}|${fileHandleRef.current?.name || ''}`
    if (key === persistedKeyRef.current) return
    persistedKeyRef.current = key
    void saveSessionContent({
      documentId: core.documentId,
      fileName: core.fileName,
      originalFileName: core.originalFileName,
      bytes: core.getWorkingBytes(),
      originalBytes: core.getOriginalBytes(),
      pageCount: core.pageCount,
      objects: core.objects.list(),
      dirty: core.isDirty,
      fileHandle: fileHandleRef.current,
    }).catch(() => { persistedKeyRef.current = '' })
  }, [])
  const schedulePersist = useCallback(() => {
    window.clearTimeout(persistTimerRef.current)
    persistTimerRef.current = window.setTimeout(persistNow, 120)
  }, [persistNow])
  const firstPaintRef = useRef(null)
  const firstPaintPromiseRef = useRef(Promise.resolve())
  /** Call before showing a new document; its promise resolves once the first page is on screen. */
  const armFirstPaint = useCallback(() => {
    firstPaintPromiseRef.current = new Promise((resolve) => {
      const timer = window.setTimeout(resolve, 2500)
      firstPaintRef.current = () => { window.clearTimeout(timer); resolve() }
    })
  }, [])

  const installDocumentCore = useCallback((nextCore) => {
    const previousCore = documentCoreRef.current
    documentCoreUnsubscribeRef.current?.()
    documentCoreUnsubscribeRef.current = null
    documentCoreRef.current = nextCore
    if (nextCore) {
      documentCoreUnsubscribeRef.current = nextCore.subscribe((snapshot, event) => {
        setDocumentCoreState(snapshot)
        if (event?.type !== 'autosave') setObjects(nextCore.objects.list())
        schedulePersist()
      })
    } else {
      setDocumentCoreState(null)
      setObjects([])
    }
    if (previousCore && previousCore !== nextCore) void previousCore.close({ flushAutosave: true }).catch(() => undefined)
  }, [schedulePersist])

  const applyInspection = useCallback((inspection) => {
    setNativeRuns(inspection?.runs || [])
    setNativeBlocks(inspection?.blocks || [])
    setPageImages(inspection?.images || [])
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
          showToast('Search didn’t work. Try again.', 'error')
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
    void engine.warmUp()
    void restoreRef.current?.(engine)
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
    setImageReading(null)
    setPendingPatch(null)
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
      const core = createDocumentCore({ fileName: nextFileName, bytes, pageCount: nextSession.pageCount })
      core.objects.restore(extracted, nextSession.pageCount)
      installDocumentCore(core)
      setObjects(core.objects.list())
    }
    setFileName(nextFileName)
    const page = Math.max(0, Math.min(nextPage, nextSession.pageCount - 1))
    setCurrentPage(page)
    documentCoreRef.current?.setActivePage(page)
    applyInspection(await inspectNativePdfText(bytes, inspectionOptions()).catch(() => ({ runs: [], fonts: [] })))
    clearSelections()
    return nextSession
  }, [applyInspection, clearSelections, installDocumentCore, replaceDocumentSession])

  const openPdf = useCallback(async (file, handle = null) => {
    if (!file) return
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
    if (!isPdf) { showToast('Please choose a PDF file.', 'error'); return }
    if (!engineRef.current) { showToast('Still getting ready — try again in a second.', 'error'); return }
    const operationId = ++openSequenceRef.current
    setProcessing(true)
    setProcessingProgress(0)
    setEngineError('')
    try {
      const fileBytes = new Uint8Array(await file.arrayBuffer())
      const { bytes, objects: extracted, found } = await splitEditableObjects(fileBytes)
      if (operationId !== openSequenceRef.current) return
      const nextSession = await openWithPassword(engineRef.current, bytes, file.name, ({ loaded, total }) => {
        if (operationId !== openSequenceRef.current) return
        if (Number.isFinite(total) && total > 0) setProcessingProgress(Math.min(100, Math.round((loaded / total) * 100)))
      })
      if (operationId !== openSequenceRef.current) { await nextSession.close(); return }
      const previousSession = documentSessionRef.current
      documentSessionRef.current = nextSession
      originalPdfBytesRef.current = bytes.slice()
      const core = createDocumentCore({ fileName: file.name, bytes, pageCount: nextSession.pageCount })
      core.objects.restore(extracted, nextSession.pageCount)
      installDocumentCore(core)
      setObjects(core.objects.list())
      armFirstPaint()
      setDocumentSession(nextSession)
      setPages(createPages(nextSession))
      setCurrentPage(0)
      setZoom(1)
      setZoomMode('width')
      setFileName(file.name)
      fileHandleRef.current = handle
      setActiveWorkspace('edit')
      setNativeSearchTerm('')
      setPdfSearchResults([])
      clearSelections()
      setToolState('select')
      await previousSession?.close?.()
      setProcessing(false)
      await firstPaintPromiseRef.current
      if (operationId !== openSequenceRef.current) return
      const inspection = await inspectNativePdfText(bytes, inspectionOptions()).catch((error) => ({ runs: [], error }))
      if (operationId !== openSequenceRef.current) return
      applyInspection(inspection)
      recentIdRef.current = await rememberRecentFile(file, handle)
      void refreshRecentFiles()
      if (inspection.error) showToast('Opened. The text in this PDF can’t be edited, but you can add to it.', 'warning')
      else if (!inspection.blocks?.length) showToast('Opened. This looks scanned, so its text can’t be edited — you can still add to it.', 'warning')
      else if (found) showToast(`Opened. ${extracted.length} item${extracted.length === 1 ? '' : 's'} you added can be edited again.`)
      else showToast('PDF opened.')
    } catch (error) {
      if (operationId === openSequenceRef.current) {
        setEngineError(error?.message || 'The selected PDF could not be opened.')
        showToast('Couldn’t open this PDF.', 'error')
      }
    } finally {
      if (operationId === openSequenceRef.current) {
        setProcessing(false)
        setProcessingProgress(0)
      }
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }, [applyInspection, clearSelections, installDocumentCore, showToast])

  /** Prefer the file on disk when the browser still allows it; otherwise the copy kept here. */
  const openRecentFile = useCallback(async (item) => {
    let file = item.file
    try {
      if (item.handle && (await item.handle.queryPermission?.({ mode: 'read' })) === 'granted') file = await item.handle.getFile()
    } catch {
      // Moved or deleted on disk: the copy kept here still opens.
    }
    if (file) void openPdf(file, item.handle || null)
    else showToast('That file isn’t available any more. Please open it again.', 'error')
  }, [openPdf, showToast])

  /** Open with the system file picker when available so Save can write back to the same file. */
  const openFromPicker = useCallback(async () => {
    if (typeof window.showOpenFilePicker !== 'function') { fileInputRef.current?.click(); return }
    try {
      const [handle] = await window.showOpenFilePicker({ types: [{ description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } }], multiple: false })
      if (handle) await openPdf(await handle.getFile(), handle)
    } catch (error) {
      if (error?.name !== 'AbortError') fileInputRef.current?.click()
    }
  }, [openPdf])

  /** Bring back the PDF, edits and position after a browser refresh. */
  const restoreLastSession = async (engine) => {
    const saved = await loadSavedSession()
    if (engineRef.current !== engine) return
    if (!saved?.content?.bytes) { setRestoring(false); return }
    const { content, view } = saved
    try {
      const nextSession = await openWithPassword(engine, content.bytes.slice(), content.fileName)
      if (engineRef.current !== engine) { await nextSession.close().catch(() => undefined); return }
      documentSessionRef.current = nextSession
      originalPdfBytesRef.current = content.bytes.slice()
      fileHandleRef.current = content.fileHandle || null
      const pageCountNow = nextSession.pageCount
      const details = { documentId: content.documentId, fileName: content.fileName, originalFileName: content.originalFileName, bytes: content.bytes, originalBytes: content.originalBytes, pageCount: pageCountNow }
      const core = content.dirty ? DocumentCore.recoverCheckpoint({ schemaVersion: 2, ...details, objects: content.objects || [] }) : createDocumentCore(details)
      if (!content.dirty) core.objects.restore(content.objects || [], pageCountNow)
      const page = Math.max(0, Math.min(Number(view.page) || 0, pageCountNow - 1))
      persistedKeyRef.current = `${core.documentId}|${core.currentStateId}|${core.isDirty}|${fileHandleRef.current?.name || ''}`
      scrollRestoreRef.current = view.scroll || null
      viewScrollRef.current = view.scroll || { top: 0, left: 0 }
      installDocumentCore(core)
      core.setActivePage(page)
      setObjects(core.objects.list())
      armFirstPaint()
      setDocumentSession(nextSession)
      setPages(createPages(nextSession))
      setCurrentPage(page)
      setZoom(Number(view.zoom) || 1)
      setZoomMode(view.zoomMode || 'width')
      setFileName(content.fileName)
      setActiveWorkspace(view.workspace || 'edit')
      setRestoring(false)
      await firstPaintPromiseRef.current
      applyInspection(await inspectNativePdfText(content.bytes, inspectionOptions()).catch(() => ({ runs: [], fonts: [] })))
    } catch {
      await clearSavedSession()
    } finally {
      setRestoring(false)
    }
  }
  const restoreRef = useRef(null)
  restoreRef.current = restoreLastSession

  const closeDocument = async () => {
    if (documentCoreRef.current?.isDirty) {
      const answer = await showDialog({ icon: 'warning', title: 'Close without saving?', text: 'Your unsaved changes will be lost.', confirmText: 'Close', cancelText: 'Keep editing' })
      if (!answer.confirmed) return
    }
    const session = documentSessionRef.current
    documentSessionRef.current = null
    originalPdfBytesRef.current = null
    fileHandleRef.current = null
    persistedKeyRef.current = ''
    installDocumentCore(null)
    setDocumentSession(null)
    setPages([])
    setCurrentPage(0)
    setFileName('No document open')
    setNativeSearchTerm('')
    applyInspection(null)
    clearSelections()
    setToolState('select')
    await session?.close?.()
    await clearSavedSession()
  }

  const requireDocument = useCallback(() => {
    if (!documentSessionRef.current || !documentCoreRef.current) {
      showToast('Open a PDF first.', 'error')
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
    try {
      const seen = new Set(JSON.parse(globalThis.localStorage?.getItem(SEEN_HINTS_KEY) || '[]'))
      if (!seen.has(next)) {
        setHintTool(next)
        seen.add(next)
        globalThis.localStorage?.setItem(SEEN_HINTS_KEY, JSON.stringify([...seen]))
      }
    } catch { /* storage unavailable */ }
    globalThis.getSelection?.()?.removeAllRanges()
  }, [])

  useEffect(() => {
    if (!hintTool) return undefined
    const timer = window.setTimeout(() => setHintTool(null), 4500)
    return () => window.clearTimeout(timer)
  }, [hintTool])

  const imageReadingRef = useRef(null)
  imageReadingRef.current = imageReading
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
      showToast(error?.message || 'That didn’t work. Please try again.', 'error')
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
    // Removing edited image text also removes its cover, so the original shows again.
    const ids = [object.id, ...(object.imageTextPatchId && objectsRef.current.some((item) => item.id === object.imageTextPatchId) ? [object.imageTextPatchId] : [])]
    if (await runObjectCommand(new SetPageObjectsCommand({ remove: ids }, { label: `Delete ${objectLabel(object).toLowerCase()}` }))) {
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
    if (object.isNew && object.imageTextPatchId) {
      const patch = pendingPatchRef.current
      setPendingPatch(null)
      if (!patch || text === object.originalText) return
      const z = objectsRef.current.reduce((max, item) => Math.max(max, item.z ?? 0), 0)
      const upsert = [{ ...patch, z: z + 1 }]
      let created = null
      if (text.trim()) {
        created = fitTextObject({ ...object, text, z: z + 2 })
        delete created.isNew
        upsert.push(created)
      }
      if (await runObjectCommand(new SetPageObjectsCommand({ upsert }, { label: text.trim() ? 'Edit text in image' : 'Remove text from image' }))) {
        if (created) setSelectedObjectId(created.id)
        setImageReading((reading) => (reading ? { ...reading, lines: reading.lines.filter((line) => line.text !== object.originalText || line.used) } : reading))
        showToast(text.trim() ? 'Image text updated.' : 'Text removed from the image.')
      }
      return
    }
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
  }, [createObject, removeObject, runObjectCommand, showToast, tool, updateObject])

  /** Read the text inside a picture so it can be edited in place. */
  const readImageText = useCallback(async ({ pageIndex, rect, key, overlayImage = null }) => {
    const session = documentSessionRef.current
    if (!session) return
    setImageReading({ key, pageIndex, status: 'reading', lines: [] })
    try {
      const reading = await readTextInArea(session, pageIndex, rect, overlayImage)
      if (!reading.lines.length) {
        setImageReading(null)
        showToast('No text found in this image.', 'warning')
        return
      }
      setImageReading({ key, pageIndex, status: 'ready', lines: reading.lines, reading })
      showToast('Tap the text you want to change.')
    } catch {
      setImageReading(null)
      showToast('Couldn’t read the text in this image.', 'error')
    }
  }, [showToast])

  const startImageTextEdit = useCallback(async (line) => {
    const current = imageReadingRef.current
    if (!current?.reading) return
    try {
      const { patch, text } = await prepareImageTextEdit(current.reading, line, current.pageIndex)
      setSelectedObjectId(null)
      setSelectedImageKey(null)
      setPendingPatch(patch)
      setEditingText(text)
    } catch {
      showToast('Couldn’t prepare this text for editing.', 'error')
    }
  }, [showToast])

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

  const activateBlockRef = useRef(null)
  /** Hindi text with unlabelled letters: read them from the installed font, then edit. */
  const unlockIndicBlock = async (block, clickPoint) => {
    const provider = fontProviderRef.current
    if (provider.status !== 'granted') {
      const answer = await showDialog({
        icon: 'font',
        title: 'Read this Hindi text?',
        text: 'Earthix needs your computer’s fonts to read and edit it. Nothing leaves your device.',
        confirmText: 'Use my fonts',
        cancelText: 'Not now',
      })
      if (!answer.confirmed) return
    }
    const entries = await provider.prepare()
    setLocalFontStatus(provider.status)
    if (!entries.length) {
      showToast('Font access is off, so this Hindi text can’t be read.', 'warning')
      return
    }
    const core = documentCoreRef.current
    if (!core) return
    const inspection = await inspectNativePdfText(core.getWorkingBytes(), { fontProvider: provider }).catch(() => null)
    if (!inspection) return
    applyInspection(inspection)
    nativeBlocksRef.current = inspection.blocks || []
    const next = findBlockNearPoint(inspection.blocks || [], block.pageIndex, block.startPoint, 2)
    if (next?.editable) activateBlockRef.current?.(next, clickPoint)
    else showToast(next?.reason || 'Couldn’t read this Hindi text with your fonts.', 'warning')
  }

  const activateBlock = useCallback((block, clickPoint = null) => {
    if (!block) return
    setSelectedBlockKey(block.key)
    setSelectedImageKey(null)
    setSelectedObjectId(null)
    if (!block.editable) {
      if (block.reasonCode === 'needs-installed-font' && fontProviderRef.current?.supported) { void unlockIndicBlock(block, clickPoint); return }
      showToast(block.reason || 'This text can’t be edited.', 'warning')
      return
    }
    setCurrentPage(block.pageIndex)
    setActiveClickPoint(clickPoint)
    setActiveBlock(block)
    if (isCompact) setShowRight(true)
  }, [isCompact, showToast])

  activateBlockRef.current = activateBlock

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
    runPendingActivation(nativeBlocksRef.current)
  }, [runPendingActivation])

  const handlePageRendered = useCallback(() => {
    firstPaintRef.current?.()
    firstPaintRef.current = null
    setPaintedSession(documentSessionRef.current)
    if (!awaitingRenderRef.current) return
    awaitingRenderRef.current = false
    setActiveBlock(null)
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
      showToast(error?.message || 'That didn’t work. Please try again.', 'error')
      pdfBusyRef.current = false
      setPdfBusy(false)
      return null
    }
  }, [applyInspection, replaceDocumentSession, showToast])

  const fontToast = useCallback((plan, warnings = [], base) => {
    const fontAccess = fontProviderRef.current?.status
    const message = plan?.kind !== 'fallback' || plan.match === 'exact' || warnings.some((warning) => warning.startsWith('Used '))
      ? base
      : plan.letters?.length
        ? `${base} “${plan.letters.slice(0, 4).join(' ')}” isn’t in this font, so it uses ${plan.label}.`
      : fontAccess === 'unsupported' || fontAccess === 'denied'
        ? `${base} Used ${plan.label} — allow font access for an exact match.`
        : `${base} Used ${plan.label}, the closest match.`
    showToast([message, ...warnings].join(' '), (plan?.kind === 'fallback' && plan.match !== 'exact') || warnings.length ? 'warning' : '')
  }, [showToast])

  const commitBlockEdit = useCallback(async (block, text) => {
    const fontProvider = fontProviderRef.current.withShapes(() => glyphShapes(documentSessionRef.current, block))
    const supported = new Set(block.fontMetadata?.supportedCharacters || [])
    if ([...text].some((character) => !/\s/.test(character) && !supported.has(character)) && fontProvider?.supported) void fontProvider.prepare()
    await runPdfCommand(new ReplaceNativeTextBlockCommand(block, text, { fontProvider }), {
      onResult: (result) => {
        if (result.block) setSelectedBlockKey(result.block.key)
        fontToast(result.fontPlan, result.warnings, 'Text updated.')
      },
    })
  }, [fontToast, runPdfCommand])

  const restyleBlock = useCallback(async (block, style) => {
    const fontProvider = fontProviderRef.current.withShapes(() => glyphShapes(documentSessionRef.current, block))
    const pickedFreeFont = FREE_FONT_FAMILIES.includes(style.fontFamily) || uploadedFonts.some((font) => font.family === style.fontFamily)
    if (!pickedFreeFont && (style.fontSource === 'local' || (style.fontFamily && !isStandardFamily(style.fontFamily)) || style.bold !== undefined || style.italic !== undefined || style.weight !== undefined) && fontProvider?.supported) void fontProvider.prepare()
    const reference = { key: block.key, pageIndex: block.pageIndex, runKeys: [...block.runKeys], text: block.text }
    await runPdfCommand(new TransformPdfBytesCommand((bytes) => restyleNativeTextBlock(bytes, reference, style, { fontProvider }), { label: 'Change text style', pageIndex: block.pageIndex }), {
      onResult: (result) => {
        if (result.block) setSelectedBlockKey(result.block.key)
        fontToast(result.fontPlan, result.warnings, 'Style updated.')
      },
    })
  }, [fontToast, runPdfCommand, uploadedFonts])

  const editImage = useCallback(async (image, operation, label) => {
    await runPdfCommand(new TransformPdfBytesCommand((bytes) => editPageImage(bytes, image, operation, inspectionOptions()), { label, pageIndex: image.pageIndex }), {
      onResult: (result) => {
        setSelectedImageKey(result.image?.key || null)
        showToast(operation.type === 'delete' ? 'Image removed.' : 'Image updated.')
      },
    })
  }, [runPdfCommand, showToast])

  const handlePageImageAction = useCallback((image, operation) => {
    if (operation.type === 'replace' && !operation.data) { chooseImage({ kind: 'page', image }); return }
    if (operation.type === 'read-text') { void readImageText({ pageIndex: image.pageIndex, rect: image.viewRect, key: image.key }); return }
    const labels = { transform: 'Move image', delete: 'Delete image', opacity: 'Change image opacity', replace: 'Replace image' }
    if (operation.type === 'delete') {
      void showDialog({ icon: 'delete', title: 'Delete this image?', text: 'You can bring it back with Undo.', confirmText: 'Delete' })
        .then((answer) => { if (answer.confirmed) void editImage(image, operation, labels.delete) })
      return
    }
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
      showToast(error?.message || 'Couldn’t add that picture.', 'error')
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
    if (flatten) {
      const answer = await showDialog({
        icon: 'layers',
        title: 'Download a flattened copy?',
        text: 'Everything you added becomes part of the page and can’t be edited later.',
        confirmText: 'Download',
      })
      if (!answer.confirmed) return
    }
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
      showToast([flatten ? 'Flattened copy downloaded.' : 'Copy downloaded.', ...warnings].join(' '), warnings.length ? 'warning' : '')
    } catch {
      showToast('Couldn’t download the PDF. Please try again.', 'error')
    } finally {
      setSaving(false)
    }
  }

  /** Save the edits into the opened file itself (Chrome/Edge), or ask where to save. */
  const saveChanges = async () => {
    if (!requireDocument()) return
    setExportMenu(false)
    setSaving(true)
    try {
      const core = documentCoreRef.current
      await core.validateForExport({ expectedPageCount: documentSession?.pageCount })
      let handle = fileHandleRef.current
      if (!handle && typeof window.showSaveFilePicker === 'function') {
        handle = await window.showSaveFilePicker({ suggestedName: fileName.toLowerCase().endsWith('.pdf') ? fileName : `${fileName}.pdf`, types: [{ description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } }] })
      }
      if (handle?.queryPermission && (await handle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
        // First save into this file: explain in our own popup; the browser then confirms once.
        if (fileHandleRef.current === handle) {
          const answer = await showDialog({
            icon: 'save',
            title: `Save changes to ${handle.name || fileName}?`,
            text: 'Your edits will be saved into this file. Your browser asks for permission just once.',
            confirmText: 'Save changes',
          })
          if (!answer.confirmed) return
        }
        if ((await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') throw new Error('Saving was not allowed.')
      }
      const { bytes, warnings } = await buildOutputBytes()
      await PDFDocument.load(bytes, { updateMetadata: false })
      if (handle?.createWritable) {
        const writable = await handle.createWritable()
        await writable.write(bytes)
        await writable.close()
        fileHandleRef.current = handle
        if (handle.name && handle.name !== fileName) setFileName(handle.name)
        await core.markSaved()
        // Reopening from Home must bring back what was just saved.
        recentIdRef.current = await rememberRecentFile(new File([bytes], handle.name || fileName, { type: 'application/pdf' }), handle, recentIdRef.current)
        void refreshRecentFiles()
        showToast([`Saved to ${handle.name || fileName}.`, ...warnings].join(' '), warnings.length ? 'warning' : '')
      } else {
        downloadPdf(bytes, fileName.toLowerCase().endsWith('.pdf') ? fileName : `${fileName}.pdf`)
        await core.markSaved()
        showToast(['Saved as a download.', ...warnings].join(' '), warnings.length ? 'warning' : '')
      }
    } catch (error) {
      if (error?.name !== 'AbortError') showToast('Couldn’t save. Please try again.', 'error')
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
    const inspectionPromise = inspectNativePdfText(bytes, inspectionOptions()).catch((error) => ({ runs: [], error }))
    await replaceDocumentSession(bytes, snapshot.fileName)
    originalPdfBytesRef.current = bytes.slice()
    setFileName(snapshot.fileName)
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
    } catch {
      try {
        await core[action === 'undo' ? 'redo' : 'undo']()
        await refreshViewerFromDocumentCore()
      } catch {
        showToast('Something went wrong with undo. Please reopen the file.', 'error')
      }
      showToast(action === 'undo' ? 'Couldn’t undo that.' : 'Couldn’t redo that.', 'error')
    }
  }, [refreshViewerFromDocumentCore, showToast])

  const mergePdfs = async (files) => {
    if (!files?.length) return
    if (files.length < 2) { showToast('Pick at least two PDFs to merge.', 'error'); return }
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
      fileHandleRef.current = null
      await commitPdfBytes(bytes, 'Merged-Document.pdf', 0)
      setActiveWorkspace('edit')
      showToast(files.length + ' PDFs merged.')
    } catch {
      showToast('Couldn’t merge these files.', 'error')
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
      showToast('Pick pages between 1 and ' + pageCount + '.', 'error')
      return
    }
    setProcessing(true)
    try {
      const source = await PDFDocument.load((await buildOutputBytes()).bytes)
      const output = await PDFDocument.create()
      const copied = await output.copyPages(source, Array.from({ length: to - from + 1 }, (_, index) => from - 1 + index))
      copied.forEach((page) => output.addPage(page))
      downloadPdf(await output.save({ useObjectStreams: true }), fileName.replace(/\.pdf$/i, '') + '-pages-' + from + '-' + to + '.pdf')
      showToast('Pages ' + from + '–' + to + ' downloaded.')
    } catch {
      showToast('Couldn’t split the PDF.', 'error')
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
      showToast('Pages updated.')
    } catch {
      showToast('Couldn’t update the pages.', 'error')
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
      downloadPdf(bytes, fileName.replace(/\.pdf$/i, '') + '-compressed.pdf')
      const reduction = Math.round((1 - bytes.byteLength / input.byteLength) * 100)
      showToast(reduction > 0 ? 'Smaller copy downloaded — ' + reduction + '% lighter.' : 'Copy downloaded. It was already small.')
    } catch {
      showToast('Couldn’t compress this PDF.', 'error')
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

  const saveViewSoon = useCallback(() => {
    window.clearTimeout(viewSaveTimerRef.current)
    viewSaveTimerRef.current = window.setTimeout(() => {
      if (!documentSessionRef.current) return
      void saveSessionView(viewStateRef.current()).catch(() => undefined)
    }, 200)
  }, [])
  const viewStateRef = useRef(() => ({}))
  viewStateRef.current = () => ({ page: currentPage, zoom, zoomMode, workspace: activeWorkspace, scroll: viewScrollRef.current })
  const handleViewerScroll = useCallback((scroll) => { viewScrollRef.current = scroll; saveViewSoon() }, [saveViewSoon])
  useEffect(() => { if (documentSession) saveViewSoon() }, [documentSession, currentPage, zoom, zoomMode, activeWorkspace, saveViewSoon])
  useEffect(() => {
    // A refresh right after an edit must not lose it.
    const flush = () => {
      if (persistTimerRef.current) persistNow()
      if (documentSessionRef.current) void saveSessionView(viewStateRef.current()).catch(() => undefined)
    }
    window.addEventListener('pagehide', flush)
    return () => window.removeEventListener('pagehide', flush)
  }, [persistNow])

  const handleViewerError = useCallback(() => {
    if (awaitingRenderRef.current) {
      awaitingRenderRef.current = false
      setActiveBlock(null)
      setPdfBusy(false)
    }
    showToast('This page couldn’t be shown.', 'error')
  }, [showToast])

  const changeZoom = (amount) => {
    setZoomMode('manual')
    setZoom((value) => Math.max(0.25, Math.min(4, Number((value + amount).toFixed(2)))))
  }

  const onDrop = (event) => {
    event.preventDefault()
    setDragging(false)
    const files = Array.from(event.dataTransfer?.files || [])
    const pdfItem = [...(event.dataTransfer?.items || [])].find((item) => item.kind === 'file' && item.type === 'application/pdf')
    const handlePromise = pdfItem?.getAsFileSystemHandle ? pdfItem.getAsFileSystemHandle().catch(() => null) : Promise.resolve(null)
    const pdf = files.find((item) => item.type === 'application/pdf' || item.name.toLowerCase().endsWith('.pdf'))
    const picture = files.find((item) => item.type.startsWith('image/'))
    if (pdf) void handlePromise.then((handle) => openPdf(pdf, handle?.kind === 'file' ? handle : null))
    else if (picture && documentSession) { imageTargetRef.current = { kind: 'new' }; void handleImageFile(picture) }
    else showToast('Drop a PDF or a picture here.', 'error')
  }

  const loadLocalFonts = useCallback(async () => {
    const provider = fontProviderRef.current
    if (!provider?.supported) { showToast('Your fonts work in Chrome or Edge.', 'warning'); return }
    const entries = await provider.prepare()
    setLocalFontStatus(provider.status)
    if (!entries.length) { showToast('Font access is off, so only the standard fonts are listed.', 'warning'); return }
    setLocalFamilies([...new Set(entries.map((entry) => entry.family).filter(Boolean))].sort((a, b) => a.localeCompare(b)))
    const weights = new Map()
    for (const entry of entries) {
      const key = normalizeFontKey(entry.family)
      if (!weights.has(key)) weights.set(key, new Set())
      weights.get(key).add(weightFromStyle(entry.style) ?? 400)
    }
    setLocalWeights(weights)
  }, [showToast])

  useEffect(() => { void listUploadedFonts().then(setUploadedFonts).catch(() => undefined) }, [])

  // The free font list is only needed once a PDF is open.
  useEffect(() => {
    if (!documentSession) return
    void fontProviderRef.current.prepareLibrary().then((rows) => { declareFreeFontFaces(rows); bumpFontVersion() }).catch(() => undefined)
  }, [documentSession])

  const uploadFont = useCallback(async (file) => {
    if (!file) return
    try {
      const font = await addUploadedFont(file)
      setUploadedFonts(await listUploadedFonts())
      showToast(`${font.family} added.`)
    } catch {
      showToast('That file isn’t a font we can use.', 'error')
    } finally {
      if (fontFileInputRef.current) fontFileInputRef.current.value = ''
    }
  }, [showToast])

  // Font access stays allowed between visits, so the full list can load by itself.
  useEffect(() => {
    let active = true
    navigator.permissions?.query({ name: 'local-fonts' })
      .then((state) => { if (active && state.state === 'granted') void loadLocalFonts() })
      .catch(() => undefined)
    return () => { active = false }
  }, [loadLocalFonts])

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
      if (mod && key === 's') { event.preventDefault(); if (documentSessionRef.current) void savePdfRef.current(); return }
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

  const savePdfRef = useRef(saveChanges)
  savePdfRef.current = saveChanges
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
    setSheetExpanded(false)
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
    : documentCoreState.isDirty
      ? { label: 'Not saved', tone: 'dirty' }
      : { label: 'Saved', tone: '' }

  const objectActions = useMemo(() => ({
    update: (object, label) => void updateObject(object, label),
    preview: (object) => setPreviewObject(object),
    remove: (object) => void removeObject(object),
    duplicate: (object) => void duplicateObject(object),
    arrange: (object, direction) => void arrangeObject(object, direction),
    replaceImage: (object) => chooseImage({ kind: 'object', object }),
    readImageText: (object) => void readImageText({ pageIndex: object.pageIndex, rect: { x: object.x, y: object.y, width: object.width, height: object.height }, key: object.id, overlayImage: object }),
  }), [arrangeObject, chooseImage, duplicateObject, removeObject, updateObject])

  const localFonts = {
    families: localFamilies,
    supported: fontProviderRef.current?.supported,
    status: localFontStatus,
    onLoad: () => void loadLocalFonts(),
    uploaded: [...new Set(uploadedFonts.map((font) => font.family))].sort((a, b) => a.localeCompare(b)),
    free: FREE_FONT_FAMILIES,
    onUpload: () => fontFileInputRef.current?.click(),
    weightsFor: (family) => {
      const key = normalizeFontKey(family)
      return [...new Set([
        ...(localWeights.get(key) || []),
        ...uploadedFonts.filter((font) => normalizeFontKey(font.family) === key).map((font) => weightFromStyle(font.style) ?? 400),
        ...fontProviderRef.current.weightsFor(family),
      ])]
    },
  }

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
      {imageReading && imageReading.pageIndex === pageIndex && (
        <div className="image-text-layer">
          {imageReading.status === 'reading' && <div className="image-text-status"><FaSpinner className="spin" /> Reading text in the image…</div>}
          {imageReading.status === 'ready' && imageReading.lines.map((line) => (
            <button
              key={line.id}
              type="button"
              className="image-text-line"
              title={`Edit “${line.text}”`}
              style={{ left: `${line.rect.x * scale - 2}px`, top: `${line.rect.y * scale - 2}px`, width: `${line.rect.width * scale + 4}px`, height: `${line.rect.height * scale + 4}px` }}
              onPointerDown={(event) => { event.stopPropagation(); event.preventDefault(); void startImageTextEdit(line) }}
            />
          ))}
          {imageReading.status === 'ready' && <button type="button" className="image-text-done" onClick={() => { setImageReading(null); setPendingPatch(null) }}>Done</button>}
        </div>
      )}
      <ObjectLayer
        pageIndex={pageIndex}
        scale={scale}
        pageWidth={viewport.width / scale}
        pageHeight={viewport.height / scale}
        objects={pendingPatch && pendingPatch.pageIndex === pageIndex ? [...pageObjects, { ...pendingPatch, z: 1e9 }] : pageObjects}
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
      <input ref={fontFileInputRef} type="file" accept=".ttf,.otf,font/ttf,font/otf" hidden onChange={(event) => void uploadFont(event.target.files?.[0])} />
      <input ref={imageInputRef} type="file" accept="image/*" hidden onChange={(event) => void handleImageFile(event.target.files?.[0])} />

      {isMobile && navOpen && <div className="backdrop" onClick={() => setNavOpen(false)} />}
      <aside className={`app-rail ${navOpen ? 'open' : ''}`} aria-label="Main navigation">
        <img className="rail-brand" src="/earthix-logo.png" alt="Earthix" />
        <nav className="rail-nav">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon
            return (
              <button key={item.id} type="button" className={`rail-item ${item.id === activeWorkspace ? 'active' : ''}`} title={item.hint || item.label} onClick={() => void handleNav(item.id)}>
                <Icon /><span>{item.label}</span>
              </button>
            )
          })}
        </nav>
        <div className="rail-bottom">
          <button type="button" className="rail-item" onClick={() => { setNavOpen(false); void openFromPicker() }}><FaUpload /><span>Upload</span></button>
        </div>
      </aside>

      <section className="app-main">
        <header className="app-header">
          <div className="header-left">
            <button type="button" className="icon-btn only-mobile" onClick={() => setNavOpen(true)} aria-label="Open menu"><FaBars /></button>
            <div className="doc-chip" title={fileName}>
              <FaFilePdf />
              <span>{fileName}</span>
              <button type="button" className="icon-btn sm" onClick={() => void openFromPicker()} title="Open another PDF" aria-label="Open another PDF"><FaPlus /></button>
              {documentSession && <button type="button" className="icon-btn sm" onClick={() => void closeDocument()} title="Close this PDF" aria-label="Close this PDF"><FaTimes /></button>}
            </div>
          </div>
          <div className="header-right">
            {saveStatus && <span className={`save-pill ${saveStatus.tone}`}><i />{saveStatus.label}</span>}
            {editingWorkspace && <button type="button" className="icon-btn only-mobile" title="Undo" onClick={() => void runHistoryAction('undo')} disabled={!documentCoreState?.canUndo || pdfBusy}><FaUndo /></button>}
            {editingWorkspace && <button type="button" className="icon-btn only-mobile" title="Redo" onClick={() => void runHistoryAction('redo')} disabled={!documentCoreState?.canRedo || pdfBusy}><FaRedo /></button>}
            <div className="menu-wrap">
              <div className="save-group">
                <button className="btn btn-primary" type="button" onClick={() => void saveChanges()} disabled={!documentSession || saving || processing} title="Save the changes into the PDF file (Ctrl+S)">
                  {saving ? <FaSpinner className="spin" /> : <FaSave />}<span>{saving ? 'Saving…' : 'Save'}</span>
                </button>
                <button className="btn btn-secondary" type="button" onClick={() => void savePdf()} disabled={!documentSession || saving || processing} title="Download a copy of the edited PDF">
                  <FaDownload /><span>Export</span>
                </button>
                <button className="btn btn-secondary menu-toggle" type="button" onClick={() => setExportMenu((value) => !value)} disabled={!documentSession} aria-label="More save and export options"><FaChevronDown /></button>
              </div>
              {exportMenu && (
                <>
                  <div style={{ position: 'fixed', inset: 0, zIndex: 50 }} onClick={() => setExportMenu(false)} />
                  <div className="menu">
                    <button type="button" onClick={() => void saveChanges()}><FaSave /><div>Save<small>Write the changes into the PDF file</small></div></button>
                    <button type="button" onClick={() => void savePdf()}><FaDownload /><div>Download a copy<small>Added items stay adjustable in Earthix</small></div></button>
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

        <section className={`workspace ${showRight ? 'right-open' : ''}`}>
          {activeWorkspace === 'home' ? (
            <HomeWorkspace
              onOpenPdf={() => void openFromPicker()}
              onMerge={() => mergeInputRef.current?.click()}
              recentFiles={recentFiles}
              onOpenRecent={(item) => void openRecentFile(item)}
              onRemoveRecent={(item) => void removeRecentFile(item.id).then(refreshRecentFiles)}
            />
          ) : activeWorkspace === 'split' ? (
            <SplitWorkspace pageCount={pageCount} fileName={fileName} fromPage={splitFrom} toPage={splitTo} setFromPage={setSplitFrom} setToPage={setSplitTo} onSplit={() => void splitPdf()} processing={processing} onOpenPdf={() => void openFromPicker()} />
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
              onOpenPdf={() => void openFromPicker()}
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
                            <PdfPageThumbnail session={documentSession} pageIndex={page.index} active={page.index === currentPage} enabled={paintedSession === documentSession} onClick={() => { setPage(page.index); if (isCompact) setShowLeft(false) }} />
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
                              {objects.filter((object) => object.pageIndex === pageIndex && !object.imageTextPatch).sort((a, b) => (b.z ?? 0) - (a.z ?? 0)).map((object) => (
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
                  {!documentSession && !engineError && !restoring && (
                    <div className="welcome">
                      <div className="welcome-card">
                        <span className="welcome-icon"><FaFilePdf /></span>
                        <h1>Open a PDF to get started</h1>
                        <div className="welcome-features">
                          {TOOLS.slice(1, 9).map((item) => { const Icon = item.icon; return <span key={item.id}><Icon />{item.label}</span> })}
                        </div>
                        <button type="button" className="btn btn-primary" onClick={() => void openFromPicker()}><FaUpload /> Choose PDF</button>
                        <small>Or drop it here — your file stays on this device.</small>
                      </div>
                    </div>
                  )}
                  {engineError && <div className="engine-error"><FaTools /><h2>This PDF could not be opened</h2><p>{engineError}</p><button type="button" className="btn btn-secondary" onClick={() => void openFromPicker()}>Choose another PDF</button></div>}
                  {documentSession && (
                    <PdfPageViewer
                      session={documentSession}
                      pageIndex={currentPage}
                      zoomMode={zoomMode}
                      zoom={zoom}
                      searchQuery={nativeSearchTerm}
                      searchItemIndexes={currentSearchItemIndexes}
                     
                      editMode={tool === 'edit'}
                      textBlocks={nativeBlocks}
                      activeBlock={activeBlock}
                      activeClickPoint={activeClickPoint}
                      editBusy={pdfBusy}
                      onBlockActivate={requestBlockEdit}
                      onBlockCommit={commitBlockEdit}
                      onBlockCancel={cancelBlockEdit}
                      onPageRendered={handlePageRendered}
                      onZoomChange={setZoom}
                      onPinchZoom={(factor) => { setZoomMode('manual'); setZoom((value) => Math.max(0.25, Math.min(4, Number((value * factor).toFixed(2))))) }}
                      onTextSelected={() => undefined}
                      onRenderError={handleViewerError}
                      renderOverlay={renderOverlay}
                      textLayerActive={tool === 'select' || tool === 'highlight'}
                      selectedBlockKey={selectedBlockKey}
                      scrollRestoreRef={scrollRestoreRef}
                      onScrollChange={handleViewerScroll}
                    />
                  )}
                  {documentSession && activeToolInfo && activeToolInfo.id !== 'select' && <div className="tool-hint"><activeToolInfo.icon />{activeToolInfo.hint}</div>}
                  {restoring && <div className="processing-mask"><FaSpinner className="spin" /></div>}
                  {processing && <div className="processing-mask"><FaSpinner className="spin" /><span>{processingProgress ? `Processing PDF… ${processingProgress}%` : 'Processing PDF…'}</span></div>}
                </div>
                {documentSession && <footer className="stage-footer">
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
                  <button type="button" className={`icon-btn sm fit-width ${zoomMode === 'width' ? 'active' : ''}`} title="Fit width" onClick={() => setZoomMode('width')} disabled={!documentSession}><FaExpand /></button>
                  <button type="button" className={`icon-btn sm hide-compact ${zoomMode === 'page' ? 'active' : ''}`} title="Fit page" onClick={() => setZoomMode('page')} disabled={!documentSession}><FaCompress /></button>
                  {(selection || ['text', 'highlight', 'draw', 'shape', 'note'].includes(tool)) && <button type="button" className="icon-btn sm only-mobile" onClick={() => { setShowRight(true); setSheetExpanded(true) }} title="Options"><FaSlidersH /></button>}
                </footer>}
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
                  onClose={() => setShowRight(false)}
                  collapsible={isMobile}
                  collapsed={!sheetExpanded}
                  onToggleCollapsed={() => setSheetExpanded((value) => !value)}
                />
              )}
              {isCompact && !isMobile && showLeft && <div className="backdrop" style={{ position: 'absolute', zIndex: 75 }} onClick={() => setShowLeft(false)} />}
            </>
          )}
        </section>
      </section>

      {isMobile && editingWorkspace && documentSession && <nav className="mobile-dock" aria-label="Editing tools">{toolButtons}</nav>}
      {signatureOpen && <SignatureDialog onCancel={() => { setSignatureOpen(false); signaturePointRef.current = null }} onConfirm={(result) => void placeSignature(result)} />}
      <Toast message={toast.message} type={toast.type} onClose={closeToast} />
      <SweetDialogHost />
    </main>
  )
}

export default App
