import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PDFDocument } from 'pdf-lib'
import {
  FaCheck,
  FaChevronDown,
  FaChevronLeft,
  FaChevronRight,
  FaCompress,
  FaDownload,
  FaEdit,
  FaEllipsisH,
  FaExpand,
  FaFileAlt,
  FaFilePdf,
  FaHome,
  FaInfoCircle,
  FaList,
  FaLock,
  FaMinus,
  FaPlus,
  FaRedo,
  FaSearch,
  FaSlidersH,
  FaSpinner,
  FaTextHeight,
  FaTimes,
  FaTools,
  FaUndo,
  FaUpload,
  FaExchangeAlt,
} from 'react-icons/fa'
import { createPdfEngine } from './engine/index.js'
import {
  createDocumentCore,
  IndexedDbCheckpointStorage,
  ReplacePdfBytesCommand,
  ReplaceNativeTextRunCommand,
} from './engine/document-core/index.js'
import { PdfPageThumbnail } from './features/pdf-viewer/PdfPageThumbnail.jsx'
import { PdfPageViewer } from './features/pdf-viewer/PdfPageViewer.jsx'
import { searchPdfDocument } from './features/pdf-viewer/searchPdfDocument.js'
import { inspectNativePdfText } from './services/nativePdfTextEditor.js'
import { assessFontReplacement } from './engine/font-engine/fontCapabilities.js'
import { FontInspectorPanel } from './features/text-editor/FontInspectorPanel.jsx'
import { findNativeRunForText } from './features/text-editor/findNativeRunForText.js'
import { HomeWorkspace, SplitWorkspace, OrganizeWorkspace } from './features/page-manager/WorkspacePanels.jsx'
import { createPagePlan, movePage as movePageInPlan, rotatePage as rotatePageInPlan, removePage as removePageFromPlan, addBlankPage, isPagePlanChanged } from './features/page-manager/pagePlan.js'
import { applyPagePlanToPdf } from './features/page-manager/applyPagePlan.js'
import './studio.css'

const sidebarGroups = [{
  label: 'WORKSPACE',
  items: [
    { id: 'home', label: 'Home', icon: FaHome },
    { id: 'edit', label: 'Edit PDF', icon: FaEdit },
    { id: 'merge', label: 'Merge PDF', icon: FaFileAlt },
    { id: 'split', label: 'Split PDF', icon: FaList },
    { id: 'organize', label: 'Organize Pages', icon: FaSlidersH },
    { id: 'compress', label: 'Optimize PDF', icon: FaCompress },
  ],
}]

const viewerTools = [
  { id: 'select', label: 'Select text', icon: FaTextHeight, hint: 'Select and copy text in the PDF' },
  { id: 'text-edit', label: 'Edit Text', icon: FaEdit, hint: 'Find and replace supported original PDF text' },
]

function Brand() {
  return (
    <div className="brand-lockup">
      <div className="brand-mark"><span>E</span></div>
      <div className="brand-name"><strong>earthix</strong><small>PDF STUDIO</small></div>
    </div>
  )
}

function Toast({ message, type, onClose }) {
  useEffect(() => {
    if (!message) return undefined
    const timer = window.setTimeout(onClose, 4200)
    return () => window.clearTimeout(timer)
  }, [message, onClose])

  if (!message) return null
  return (
    <div className={`studio-toast ${type || ''}`} role="status">
      <FaCheck />
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
  return Array.from({ length: session.pageCount }, (_, index) => ({
    id: `${index}-${session.pageCount}`,
    index,
    pageNumber: index + 1,
  }))
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
  window.setTimeout(() => URL.revokeObjectURL(url), 1200)
}

async function openWithPassword(engine, bytes, fileName, onProgress) {
  let password
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await engine.openDocument(bytes, { fileName, password, onProgress })
    } catch (error) {
      if (error?.code !== 'PASSWORD_REQUIRED') throw error
      const enteredPassword = window.prompt(`Enter the password for ${fileName}`)
      if (enteredPassword === null) throw new Error('PDF opening was cancelled because no password was provided.')
      password = enteredPassword
    }
  }
  throw new Error('The PDF password was not accepted after three attempts.')
}

function App() {
  const fileInputRef = useRef(null)
  const mergeInputRef = useRef(null)
  const engineRef = useRef(null)
  const documentSessionRef = useRef(null)
  const documentCoreRef = useRef(null)
  const documentCoreUnsubscribeRef = useRef(null)
  const originalPdfBytesRef = useRef(null)
  const openSequenceRef = useRef(0)

  const [documentSession, setDocumentSession] = useState(null)
  const [documentCoreState, setDocumentCoreState] = useState(null)
  const [engineError, setEngineError] = useState('')
  const [engineStatus, setEngineStatus] = useState('idle')
  const [fileName, setFileName] = useState('No document opened')
  const [fileSize, setFileSize] = useState(0)
  const [pages, setPages] = useState([])
  const [currentPage, setCurrentPage] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [zoomMode, setZoomMode] = useState('width')
  const [processing, setProcessing] = useState(false)
  const [processingProgress, setProcessingProgress] = useState(0)
  const [saving, setSaving] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [toast, setToast] = useState({ message: '', type: '' })
  const [nativeRuns, setNativeRuns] = useState([])
  const [fontInspection, setFontInspection] = useState([])
  const [nativeEditorOpen, setNativeEditorOpen] = useState(true)
  const [nativeSearchTerm, setNativeSearchTerm] = useState('')
  const [pdfSearchResults, setPdfSearchResults] = useState([])
  const [pdfSearchBusy, setPdfSearchBusy] = useState(false)
  const [nativeSelectedRunKey, setNativeSelectedRunKey] = useState('')
  const [nativeReplacementText, setNativeReplacementText] = useState('')
  const [nativeEditError, setNativeEditError] = useState('')
  const [nativeEditBusy, setNativeEditBusy] = useState(false)
  const [hasNativeEdits, setHasNativeEdits] = useState(false)
  const [selectedViewerText, setSelectedViewerText] = useState('')
  const [showPages, setShowPages] = useState(true)
  const [showInspector, setShowInspector] = useState(true)
  const [showMore, setShowMore] = useState(false)
  const [recentFiles, setRecentFiles] = useState([])
  const [activeWorkspace, setActiveWorkspace] = useState('edit')
  const [splitFrom, setSplitFrom] = useState('1')
  const [splitTo, setSplitTo] = useState('1')
  const [pagePlan, setPagePlan] = useState([])

  const toastMessage = toast.message
  const showToast = useCallback((message, type = '') => setToast({ message, type }), [])
  const closeToast = useCallback(() => setToast({ message: '', type: '' }), [])
  const installDocumentCore = useCallback((nextCore) => {
    const previousCore = documentCoreRef.current
    documentCoreUnsubscribeRef.current?.()
    documentCoreUnsubscribeRef.current = null
    documentCoreRef.current = nextCore
    if (nextCore) {
      documentCoreUnsubscribeRef.current = nextCore.subscribe((snapshot) => {
        setDocumentCoreState(snapshot)
        setHasNativeEdits(snapshot.isDirty)
      })
    } else {
      setDocumentCoreState(null)
      setHasNativeEdits(false)
    }
    if (previousCore && previousCore !== nextCore) {
      void previousCore.close({ flushAutosave: true }).catch(() => undefined)
    }
  }, [])
  const nativeSelectedRun = nativeRuns.find((run) => run.key === nativeSelectedRunKey) || null
  const nativeReplacementCompatibility = useMemo(() => (
    nativeSelectedRun ? assessFontReplacement(nativeSelectedRun.fontMetadata, nativeReplacementText) : null
  ), [nativeSelectedRun, nativeReplacementText])
  const filteredNativeRuns = useMemo(() => {
    const term = nativeSearchTerm.trim().toLocaleLowerCase()
    if (!term) return nativeRuns.slice(0, 60)
    return nativeRuns.filter((run) => run.originalText.toLocaleLowerCase().includes(term)).slice(0, 100)
  }, [nativeRuns, nativeSearchTerm])
  const pageCount = pages.length
  const pagePlanChanged = useMemo(() => isPagePlanChanged(pagePlan, pageCount), [pagePlan, pageCount])

  useEffect(() => {
    if (documentSession) {
      setPagePlan(createPagePlan(documentSession.pageCount))
      setSplitFrom('1')
      setSplitTo(String(documentSession.pageCount))
    } else {
      setPagePlan([])
      setSplitFrom('1')
      setSplitTo('1')
    }
  }, [documentSession])
  const currentSearchItemIndexes = useMemo(() => (
    [...new Set(pdfSearchResults
      .filter((result) => result.pageIndex === currentPage)
      .flatMap((result) => result.itemIndexes || []))]
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
    setPdfSearchResults([])
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
    setEngineError('')
    return () => {
      const session = documentSessionRef.current
      const core = documentCoreRef.current
      documentSessionRef.current = null
      documentCoreRef.current = null
      documentCoreUnsubscribeRef.current?.()
      documentCoreUnsubscribeRef.current = null
      setDocumentSession(null)
      void core?.close({ flushAutosave: true })
      void session?.close?.()
      void engine.dispose()
      if (engineRef.current === engine) engineRef.current = null
    }
  }, [])

  const replaceDocumentSession = useCallback(async (bytes, nextFileName, onProgress) => {
    if (!engineRef.current) throw new Error('The PDF engine is not ready. Refresh the page and try again.')
    const nextSession = await engineRef.current.openDocument(bytes, {
      fileName: nextFileName,
      onProgress,
    })
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

  const commitPdfBytes = useCallback(async (bytes, nextFileName, nextPage = 0) => {
    originalPdfBytesRef.current = bytes.slice()
    const nextSession = await replaceDocumentSession(bytes, nextFileName)
    const documentCore = documentCoreRef.current
    if (documentCore) {
      await documentCore.execute(new ReplacePdfBytesCommand(bytes, {
        fileName: nextFileName,
        pageCount: nextSession.pageCount,
        label: 'Replace document content',
      }))
    } else {
      installDocumentCore(createDocumentCore({
        fileName: nextFileName,
        bytes,
        pageCount: nextSession.pageCount,
        checkpointStorage: new IndexedDbCheckpointStorage(),
        autosave: true,
      }))
    }
    setFileName(nextFileName)
    setFileSize(bytes.byteLength)
    setCurrentPage(Math.max(0, Math.min(nextPage, nextSession.pageCount - 1)))
    documentCoreRef.current?.setActivePage(Math.max(0, Math.min(nextPage, nextSession.pageCount - 1)))
    const inspection = await inspectNativePdfText(bytes).catch(() => ({ runs: [], fonts: [] }))
    setNativeRuns(inspection.runs || [])
    setFontInspection(inspection.fonts || [])
    setNativeSelectedRunKey('')
    setNativeReplacementText('')
    setNativeEditError('')
    return nextSession
  }, [installDocumentCore, replaceDocumentSession])

  const openPdf = useCallback(async (file) => {
    if (!file) return
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
    if (!isPdf) {
      showToast('Please choose a valid PDF document.', 'error')
      return
    }
    if (!engineRef.current) {
      showToast('PDF engine is still initializing. Please try again.', 'error')
      return
    }

    const operationId = ++openSequenceRef.current
    setProcessing(true)
    setProcessingProgress(0)
    setEngineError('')
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (operationId !== openSequenceRef.current) return
      const inspectionPromise = inspectNativePdfText(bytes).catch((error) => ({ runs: [], error }))
      const nextSession = await openWithPassword(engineRef.current, bytes, file.name, ({ loaded, total }) => {
        if (operationId !== openSequenceRef.current) return
        if (Number.isFinite(total) && total > 0) setProcessingProgress(Math.min(100, Math.round((loaded / total) * 100)))
      })
      if (operationId !== openSequenceRef.current) {
        await nextSession.close()
        return
      }

      const previousSession = documentSessionRef.current
      documentSessionRef.current = nextSession
      originalPdfBytesRef.current = bytes.slice()
      installDocumentCore(createDocumentCore({
        fileName: file.name,
        bytes,
        pageCount: nextSession.pageCount,
        checkpointStorage: new IndexedDbCheckpointStorage(),
        autosave: true,
      }))
      setDocumentSession(nextSession)
      setPages(createPages(nextSession))
      setCurrentPage(0)
      setZoom(1)
      setZoomMode('width')
      setFileName(file.name)
      setFileSize(file.size)
      setEngineStatus(nextSession.engineStatus)
      setHasNativeEdits(false)
      setNativeEditorOpen(true)
      setActiveWorkspace('edit')
      setNativeSearchTerm('')
      setPdfSearchResults([])
      setNativeSelectedRunKey('')
      setNativeReplacementText('')
      setSelectedViewerText('')
      const inspection = await inspectionPromise
      setNativeRuns(inspection.runs || [])
      setFontInspection(inspection.fonts || [])
      setNativeEditError(inspection.error
        ? `Native text search is unavailable for this PDF: ${inspection.error.message}`
        : inspection.runs?.length
          ? ''
          : 'PDF opened successfully. No supported native Tj/TJ text runs were found for direct replacement. The PDF text layer is still selectable and searchable in the viewer.')
      await previousSession?.close?.()
      void nextSession.pdfiumReady.then(() => {
        if (documentSessionRef.current === nextSession) setEngineStatus(nextSession.engineStatus)
      })
      setRecentFiles((previous) => [
        { name: file.name, size: file.size, sizeLabel: formatBytes(file.size), file, openedAt: new Date().toISOString() },
        ...previous.filter((item) => item.name !== file.name),
      ].slice(0, 10))
      showToast(nextSession.engineStatus === 'degraded'
        ? `${file.name} opened with PDF.js. PDFium is unavailable; viewer fallback is active.`
        : `${file.name} opened. PDFium is initializing in the background.`)
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
  }, [installDocumentCore, showToast])

  const requireDocument = useCallback(() => {
    if (!documentSessionRef.current || !originalPdfBytesRef.current) {
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
    setSelectedViewerText('')
  }, [pageCount])

  const chooseNativeRun = useCallback((run) => {
    setNativeSelectedRunKey(run.key)
    setNativeReplacementText(run.originalText)
    setNativeEditError('')
    setCurrentPage(run.pageIndex)
    documentCoreRef.current?.setActivePage(run.pageIndex)
    setNativeSearchTerm(run.originalText)
    setSelectedViewerText('')
  }, [])

  const applyNativeReplacement = async () => {
    if (!nativeSelectedRun || !documentCoreRef.current) {
      setNativeEditError('Choose a supported original PDF text run first.')
      return
    }
    const core = documentCoreRef.current
    const command = new ReplaceNativeTextRunCommand(nativeSelectedRun, nativeReplacementText)
    let commandApplied = false
    setNativeEditBusy(true)
    setNativeEditError('')
    try {
      await core.execute(command)
      commandApplied = true
      const result = command.getResult()
      if (!result) throw new Error('The native text command did not return a verified replacement result.')
      const bytes = core.getWorkingBytes()
      const inspection = await inspectNativePdfText(bytes).catch((error) => ({ runs: [], fonts: [], error }))
      let nextSession
      try {
        nextSession = await replaceDocumentSession(bytes, fileName)
      } catch (openError) {
        await core.undo()
        commandApplied = false
        throw openError
      }

      commandApplied = false
      originalPdfBytesRef.current = bytes.slice()
      setFileSize(bytes.byteLength)
      setNativeRuns(inspection.runs || [])
      setFontInspection(inspection.fonts || [])
      setNativeSelectedRunKey(result.run.key)
      setNativeReplacementText(result.replacementText)
      setNativeSearchTerm(result.replacementText)
      setHasNativeEdits(true)
      setCurrentPage(result.run.pageIndex)
      core.setActivePage(result.run.pageIndex)
      setPages(createPages(nextSession))
      setEngineStatus(nextSession.engineStatus)
      if (inspection.error) {
        setNativeEditError('Text was replaced, but font inspection needs to be refreshed: ' + inspection.error.message)
      }
      void nextSession.pdfiumReady.then(() => {
        if (documentSessionRef.current === nextSession) setEngineStatus(nextSession.engineStatus)
      })
      showToast('Original PDF text replaced and recorded in Document Core history.')
    } catch (error) {
      if (commandApplied) {
        try {
          await core.undo()
        } catch (rollbackError) {
          setNativeEditError('The PDF viewer could not reopen the replacement. Document rollback also failed: ' + rollbackError.message)
        }
      }
      setNativeEditError(error?.message || 'Native text replacement failed.')
      showToast(error?.message || 'Native text replacement failed.', 'error')
    } finally {
      setNativeEditBusy(false)
    }
  }

  const savePdf = async () => {
    if (!requireDocument()) return
    setSaving(true)
    try {
      const core = documentCoreRef.current
      if (!core) throw new Error('The document state is not initialized. Reopen the PDF and try again.')
      const wasDirty = core.isDirty
      const validated = await core.validateForExport({ expectedPageCount: documentSession?.pageCount })
      const bytes = validated.bytes
      const outputName = `${fileName.replace(/\.pdf$/i, '')}${wasDirty ? '-edited' : ''}.pdf`
      downloadPdf(bytes, outputName)
      await core.markSaved()
      originalPdfBytesRef.current = bytes.slice()
      setHasNativeEdits(false)
      showToast(wasDirty ? 'Updated PDF exported successfully.' : 'Original PDF exported successfully.')
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
    const inspectionPromise = inspectNativePdfText(bytes).catch((error) => ({ runs: [], error }))
    const nextSession = await replaceDocumentSession(bytes, snapshot.fileName)
    originalPdfBytesRef.current = bytes.slice()
    setFileName(snapshot.fileName)
    setFileSize(bytes.byteLength)
    setCurrentPage(snapshot.currentPageIndex)
    setHasNativeEdits(snapshot.isDirty)
    setNativeSelectedRunKey('')
    setNativeReplacementText('')
    setNativeEditError('')
    const inspection = await inspectionPromise
    setNativeRuns(inspection.runs || [])
    setFontInspection(inspection.fonts || [])
    if (inspection.error) setNativeEditError(`Native text inspection is unavailable: ${inspection.error.message}`)
    setEngineStatus(nextSession.engineStatus)
    void nextSession.pdfiumReady.then(() => {
      if (documentSessionRef.current === nextSession) setEngineStatus(nextSession.engineStatus)
    })
    return snapshot
  }, [replaceDocumentSession])

  const runHistoryAction = useCallback(async (action) => {
    const core = documentCoreRef.current
    if (!core || !['undo', 'redo'].includes(action)) return
    try {
      const changed = await core[action]()
      if (!changed) return
      await refreshViewerFromDocumentCore()
      showToast(action === 'undo' ? 'Last document change undone.' : 'Document change restored.')
    } catch (error) {
      // Keep the in-memory document and viewer aligned if re-opening the
      // historical PDF bytes fails after a command has moved the history cursor.
      try {
        await core[action === 'undo' ? 'redo' : 'undo']()
        await refreshViewerFromDocumentCore()
      } catch (restoreError) {
        showToast(`History recovery failed: ${restoreError.message}`, 'error')
      }
      showToast(`Could not ${action} the document change: ${error.message}`, 'error')
    }
  }, [refreshViewerFromDocumentCore, showToast])

  const mergePdfs = async (files) => {
    if (!files?.length) return
    if (files.length < 2) {
      showToast('Select at least two PDF files to merge.', 'error')
      return
    }
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
      const source = await PDFDocument.load(originalPdfBytesRef.current)
      const output = await PDFDocument.create()
      const copied = await output.copyPages(source, Array.from({ length: to - from + 1 }, (_, index) => from - 1 + index))
      copied.forEach((page) => output.addPage(page))
      const bytes = await output.save({ useObjectStreams: true })
      downloadPdf(bytes, fileName.replace(/\.pdf$/i, '') + '-pages-' + from + '-' + to + '.pdf')
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
      const bytes = await applyPagePlanToPdf(originalPdfBytesRef.current, pagePlan)
      await commitPdfBytes(bytes, fileName, 0)
      setActiveWorkspace('organize')
      showToast('Page order and page operations applied to the PDF.')
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
      const source = await PDFDocument.load(originalPdfBytesRef.current)
      const bytes = await source.save({ useObjectStreams: true, addDefaultPage: false })
      downloadPdf(bytes, fileName.replace(/\.pdf$/i, '') + '-optimized.pdf')
      const reduction = Math.round((1 - bytes.byteLength / originalPdfBytesRef.current.byteLength) * 100)
      showToast(reduction > 0 ? 'Optimized copy exported (' + reduction + '% smaller).' : 'Optimized copy exported. The source may already be compressed.')
    } catch (error) {
      showToast('Optimization failed: ' + (error?.message || 'Unknown error'), 'error')
    } finally {
      setProcessing(false)
    }
  }

  const handleSidebar = async (id) => {
    if (id === 'merge') { setActiveWorkspace('home'); mergeInputRef.current?.click(); return }
    if (id === 'split') { setActiveWorkspace('split'); return }
    if (id === 'organize') { setActiveWorkspace('organize'); setShowPages(false); return }
    if (id === 'compress') { setActiveWorkspace('edit'); await optimizePdf(); return }
    if (id === 'home') { setActiveWorkspace('home'); return }
    if (id === 'edit') { setActiveWorkspace('edit'); setNativeEditorOpen(true); setShowInspector(true); return }
  }

  const handleTextSelected = useCallback((text) => {
    setSelectedViewerText((previous) => previous === text ? previous : text)
  }, [])

  const handleTextObjectClick = useCallback(({ pageIndex, text }) => {
    setSelectedViewerText(text)
    setNativeEditorOpen(true)
    setShowInspector(true)
    const matchResult = findNativeRunForText(nativeRuns, pageIndex, text)
    if (matchResult.run) {
      chooseNativeRun(matchResult.run)
      return
    }
    setNativeSelectedRunKey('')
    setNativeReplacementText('')
    setNativeEditError(matchResult.reason)
  }, [nativeRuns, chooseNativeRun])

  const handleViewerError = useCallback((error) => {
    showToast(error?.message || 'PDF viewer could not render this page.', 'error')
  }, [showToast])

  const changeZoom = (amount) => {
    setZoomMode('manual')
    setZoom((value) => Math.max(0.25, Math.min(4, Number((value + amount).toFixed(2)))))
  }

  const onDrop = (event) => {
    event.preventDefault()
    setDragging(false)
    const file = Array.from(event.dataTransfer?.files || []).find((item) => item.type === 'application/pdf' || item.name.toLowerCase().endsWith('.pdf'))
    if (file) void openPdf(file)
    else showToast('Drop a PDF document to open it.', 'error')
  }

  const engineStatusLabel = !documentSession
    ? 'Waiting for PDF'
    : engineStatus === 'ready'
      ? 'PDF.js + PDFium ready'
      : engineStatus === 'loading'
        ? 'PDF.js ready · PDFium loading'
        : 'PDF.js fallback active'
  const documentSaveStatusLabel = !documentCoreState
    ? ''
    : documentCoreState.autosaveStatus === 'saving'
      ? 'Saving locally…'
      : documentCoreState.autosaveStatus === 'pending'
        ? 'Autosave pending'
        : documentCoreState.autosaveStatus === 'error'
          ? 'Local autosave unavailable'
          : documentCoreState.isDirty
            ? 'Unsaved changes'
            : 'All changes saved'

  useEffect(() => {
    const handleHistoryShortcut = (event) => {
      if (!(event.ctrlKey || event.metaKey)) return
      const target = event.target
      const isEditingField = target instanceof HTMLElement && (
        target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
      )
      if (isEditingField) return
      const key = event.key.toLowerCase()
      if (key === 'z') {
        event.preventDefault()
        void runHistoryAction(event.shiftKey ? 'redo' : 'undo')
      } else if (key === 'y') {
        event.preventDefault()
        void runHistoryAction('redo')
      }
    }
    window.addEventListener('keydown', handleHistoryShortcut)
    return () => window.removeEventListener('keydown', handleHistoryShortcut)
  }, [runHistoryAction])

  return (
    <main className="studio-shell">
      <input ref={fileInputRef} type="file" accept="application/pdf,.pdf" hidden onChange={(event) => void openPdf(event.target.files?.[0])} />
      <input ref={mergeInputRef} type="file" accept="application/pdf,.pdf" multiple hidden onChange={(event) => void mergePdfs(Array.from(event.target.files || []))} />

      <aside className="studio-sidebar">
        <Brand />
        <button className="sidebar-open" type="button" onClick={() => fileInputRef.current?.click()}><FaUpload /> Open PDF</button>
        <nav className="sidebar-nav" aria-label="Main navigation">
          {sidebarGroups.map((group) => (
            <section className="nav-group" key={group.label}>
              <h2>{group.label}</h2>
              {group.items.map((item) => {
                const Icon = item.icon
                const active = item.id === activeWorkspace
                return <button type="button" key={item.id} className={`nav-link ${active ? 'active' : ''}`} onClick={() => void handleSidebar(item.id)}><Icon /><span>{item.label}</span></button>
              })}
            </section>
          ))}
        </nav>
        <div className="sidebar-footer">EARTHIX TECHNOLOGIES · 2026</div>
      </aside>

      <section className="studio-main">
        <header className="studio-header">
          <div className="document-tab">
            <FaFilePdf />
            <span title={fileName}>{fileName}</span>
            <button type="button" onClick={() => fileInputRef.current?.click()} aria-label="Open another document"><FaPlus /></button>
          </div>
          <div className="header-right">
            <span className="local-status"><i /> Local & private</span>
            {documentSaveStatusLabel && <span className={`document-save-status ${documentCoreState?.autosaveStatus === 'error' ? 'error' : ''}`} title={documentCoreState?.autosaveError || 'Document changes are stored locally in this browser.'}>{documentSaveStatusLabel}</span>}
            <span className="profile-avatar">E</span>
          </div>
        </header>

        {activeWorkspace === 'edit' && <section className="studio-toolbar" aria-label="PDF viewer tools">
          <div className="history-buttons">
            <button type="button" title="Undo (Ctrl+Z)" onClick={() => void runHistoryAction('undo')} disabled={!documentCoreState?.canUndo || processing || saving}><FaUndo /></button>
            <button type="button" title="Redo (Ctrl+Shift+Z)" onClick={() => void runHistoryAction('redo')} disabled={!documentCoreState?.canRedo || processing || saving}><FaRedo /></button>
          </div>
          <span className="toolbar-divider" />
          <div className="toolbar-tools">
            {viewerTools.map((tool) => {
              const Icon = tool.icon
              const active = tool.id === 'text-edit' ? nativeEditorOpen : !nativeEditorOpen
              return (
                <button type="button" key={tool.id} title={tool.hint} className={`tool-choice ${active ? 'active' : ''}`} onClick={() => tool.id === 'text-edit' ? (setNativeEditorOpen(true), setShowInspector(true)) : setNativeEditorOpen(false)} disabled={!documentSession}>
                  <Icon /><span>{tool.label}</span>
                </button>
              )
            })}
            <div className="more-menu-wrap">
              <button type="button" className={`tool-choice ${showMore ? 'active' : ''}`} onClick={() => setShowMore((value) => !value)}><FaEllipsisH /><span>More</span><FaChevronDown className="tiny-chevron" /></button>
              {showMore && <div className="more-menu">
                <button type="button" onClick={() => { setShowMore(false); window.print() }}><FaFilePdf /> Print document</button>
                <button type="button" onClick={() => { setShowMore(false); setShowPages(true) }}><FaList /> Show page thumbnails</button>
                <button type="button" onClick={() => { setShowMore(false); setShowInspector(true) }}><FaSlidersH /> Show properties</button>
              </div>}
            </div>
          </div>
          <div className="toolbar-spacer" />
          <button className="save-action" type="button" onClick={() => void savePdf()} disabled={!documentSession || saving || processing}>
            {saving ? <FaSpinner className="spin" /> : <FaDownload />}
            <span>{saving ? 'Exporting…' : 'Export PDF'}</span>
          </button>
        </section>}

        <section className="studio-workspace">
          {activeWorkspace === 'home' ? <HomeWorkspace
            onOpenPdf={() => fileInputRef.current?.click()}
            onMerge={() => mergeInputRef.current?.click()}
            recentFiles={recentFiles}
            onOpenRecent={(item) => item.file ? void openPdf(item.file) : showToast('This recent file is no longer available in this browser session.', 'error')}
            pageCount={pageCount}
            fileName={documentSession ? fileName : ''}
          /> : activeWorkspace === 'split' ? <SplitWorkspace
            pageCount={pageCount}
            fileName={fileName}
            fromPage={splitFrom}
            toPage={splitTo}
            setFromPage={setSplitFrom}
            setToPage={setSplitTo}
            onSplit={() => void splitPdf()}
            processing={processing}
            onOpenPdf={() => fileInputRef.current?.click()}
          /> : activeWorkspace === 'organize' ? <OrganizeWorkspace
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
          /> : <>
          {showPages && <aside className="pages-sidebar">
            <div className="panel-heading"><div><strong>Pages</strong><small>{pageCount} total</small></div><button type="button" onClick={() => setShowPages(false)} title="Hide pages"><FaTimes /></button></div>
            <div className="pages-list">
              {pages.map((page) => (
                <PdfPageThumbnail
                  key={`${documentSession?.fileName || 'document'}-${page.id}`}
                  session={documentSession}
                  pageIndex={page.index}
                  active={page.index === currentPage}
                  engineStatus={engineStatus}
                  onClick={() => setPage(page.index)}
                />
              ))}
              {!pageCount && <div className="empty-pages"><FaFilePdf /><span>Pages will appear here</span></div>}
            </div>
            <div className="page-actions"><button type="button" onClick={() => setActiveWorkspace("organize")} disabled={!documentSession}><FaSlidersH /> Organize pages</button></div>
          </aside>}

          <section className="document-stage">
            <div className="stage-heading">
              <div><span>DOCUMENT</span><strong>{fileName}</strong></div>
              <div className="document-health"><i className={engineStatus === 'ready' ? 'ready' : ''} />{engineStatusLabel}</div>
            </div>
            <div
              className={`pdf-stage-viewport ${dragging ? 'dragging' : ''}`}
              onDragOver={(event) => { event.preventDefault(); setDragging(true) }}
              onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false) }}
              onDrop={onDrop}
            >
              {!documentSession && !engineError && (
                <div className="welcome-card">
                  <span className="welcome-icon"><FaFilePdf /></span>
                  <h1>Your PDF workspace</h1>
                  <p>Open or drop a PDF to view, search, select and navigate its original pages.</p>
                  <button type="button" onClick={() => fileInputRef.current?.click()}><FaUpload /> Choose a PDF</button>
                  <small>PDFs stay on this device. No document upload is performed.</small>
                </div>
              )}
              {engineError && <div className="engine-error"><FaTools /><h2>PDF could not be opened</h2><p>{engineError}</p><button type="button" onClick={() => fileInputRef.current?.click()}>Choose another PDF</button></div>}
              {dragging && <div className="pdf-drop-overlay"><FaUpload /><strong>Drop PDF to open</strong></div>}
              {documentSession && <PdfPageViewer
                session={documentSession}
                pageIndex={currentPage}
                zoomMode={zoomMode}
                zoom={zoom}
                searchQuery={nativeSearchTerm}
                searchItemIndexes={currentSearchItemIndexes}
                engineStatus={engineStatus}
                onZoomChange={setZoom}
                onTextSelected={handleTextSelected}
                onTextObjectClick={nativeEditorOpen ? handleTextObjectClick : undefined}
                onRenderError={handleViewerError}
              />}
              {processing && <div className="processing-mask"><FaSpinner className="spin" /><span>{processingProgress ? `Processing PDF… ${processingProgress}%` : 'Processing PDF…'}</span></div>}
            </div>
            <footer className="stage-footer">
              <div className="page-navigation">
                <button type="button" onClick={() => setPage(currentPage - 1)} disabled={!pageCount || currentPage <= 0} aria-label="Previous page"><FaChevronLeft /></button>
                <span>Page <b>{pageCount ? currentPage + 1 : 0}</b> of {pageCount}</span>
                <button type="button" onClick={() => setPage(currentPage + 1)} disabled={!pageCount || currentPage >= pageCount - 1} aria-label="Next page"><FaChevronRight /></button>
              </div>
              <span className="stage-footer-separator" />
              <div className="zoom-controls">
                <button type="button" onClick={() => changeZoom(-0.1)} disabled={!documentSession} title="Zoom out"><FaMinus /></button>
                <span>{Math.round(zoom * 100)}%</span>
                <button type="button" onClick={() => changeZoom(0.1)} disabled={!documentSession} title="Zoom in"><FaPlus /></button>
                <button type="button" className="fit-button" title="Fit width" onClick={() => setZoomMode('width')} disabled={!documentSession}><FaExpand /></button>
                <button type="button" className="fit-button" title="Fit page" onClick={() => setZoomMode('page')} disabled={!documentSession}><FaCompress /></button>
              </div>
            </footer>
          </section>

          {showInspector && <aside className="inspector-sidebar">
            <div className="panel-heading inspector-title"><div><strong>Properties</strong><small>{nativeSelectedRun ? `Page ${nativeSelectedRun.pageNumber} · Text selected` : selectedViewerText ? 'Viewer text selected' : 'Document information'}</small></div><button type="button" onClick={() => setShowInspector(false)} title="Hide properties"><FaTimes /></button></div>
            {nativeEditorOpen && documentSession ? (
              <div className="inspector-content native-editor-content">
                <div className="selection-indicator"><FaExchangeAlt /><div><strong>Native PDF text editor</strong><small>Find and replace supported original text runs</small></div></div>
                <div className="native-editor-note"><FaLock /><span>Text selection in the viewer is for reading and copying. Use this panel to replace supported original PDF text. Unsupported font encodings are rejected instead of creating duplicate overlays.</span></div>
                <label className="field-label" htmlFor="native-pdf-text-search">Search entire PDF</label>
                <div className="native-search-field"><FaSearch /><input id="native-pdf-text-search" value={nativeSearchTerm} onChange={(event) => setNativeSearchTerm(event.target.value)} placeholder="Find text anywhere in PDF" /></div>
                <small className="native-character-hint">Searches selectable text across the document and filters supported editable text runs below.</small>
                {nativeSearchTerm.trim() && <section className="pdf-search-results" aria-label="PDF search results">
                  <div className="pdf-search-results-heading"><strong>PDF search results</strong><small>{pdfSearchBusy ? 'Searching…' : `${pdfSearchResults.length}${pdfSearchResults.length >= 80 ? ' (limit reached)' : ''} match(es)`}</small></div>
                  <div className="pdf-search-results-list">
                    {pdfSearchResults.map((result) => (
                      <button type="button" key={result.id} onClick={() => setPage(result.pageIndex)} className={result.pageIndex === currentPage ? 'active' : ''} aria-label={`Go to page ${result.pageNumber}: ${result.text}`}>
                        <span>{result.text}</span><small>Page {result.pageNumber}</small>
                      </button>
                    ))}
                    {!pdfSearchBusy && !pdfSearchResults.length && <p className="native-empty-state">No text matches found in this PDF.</p>}
                  </div>
                </section>}
                <div className="native-run-heading"><strong>Editable native text runs</strong><small>{filteredNativeRuns.length} shown</small></div>
                <div className="native-run-list" role="listbox" aria-label="Supported original PDF text runs">
                  {filteredNativeRuns.map((run) => (
                    <button type="button" key={run.key} className={`native-run-option ${nativeSelectedRunKey === run.key ? 'active' : ''}`} onClick={() => chooseNativeRun(run)}>
                      <span>{run.originalText || '(empty text)'}</span>
                      <small>Page {run.pageNumber} · {run.fontResource} · {run.tokenType}{run.hasKerningAdjustments ? ' · fixed spacing' : ''}</small>
                    </button>
                  ))}
                  {!filteredNativeRuns.length && <p className="native-empty-state">No supported native text runs match this search. You can still select and copy visible text in the viewer.</p>}
                </div>
                {nativeSelectedRun && (
                  <div className="native-replacement-form">
                    <label className="field-label" htmlFor="native-original-text">Selected original text</label>
                    <textarea id="native-original-text" value={nativeSelectedRun.originalText} readOnly rows={3} />
                    <label className="field-label" htmlFor="native-replacement-text">Replacement text</label>
                    <textarea id="native-replacement-text" value={nativeReplacementText} onChange={(event) => setNativeReplacementText(event.target.value)} rows={3} spellCheck="false" />
                    <small className="native-character-hint">The selected embedded font maps {nativeSelectedRun.fontMetadata?.supportedCharacterCount ?? nativeSelectedRun.supportedCharacters?.length ?? 0} replacement character(s). Unsupported characters are blocked.</small>
                    <button type="button" className="native-replace-button" onClick={() => void applyNativeReplacement()} disabled={nativeEditBusy || !nativeReplacementCompatibility?.supported || nativeReplacementText === nativeSelectedRun.originalText}>
                      {nativeEditBusy ? <FaSpinner className="spin" /> : <FaExchangeAlt />}
                      {nativeEditBusy ? 'Replacing…' : 'Replace original PDF text'}
                    </button>
                    {nativeReplacementCompatibility && !nativeReplacementCompatibility.supported && <small className="native-edit-glyph-warning" role="status">{nativeReplacementCompatibility.reason}</small>}
                  </div>
                )}
                <FontInspectorPanel fonts={fontInspection} run={nativeSelectedRun} replacementText={nativeReplacementText} />
                {nativeEditError && <div className="native-edit-error" role="alert">{nativeEditError}</div>}
                <div className="native-editor-footer">{nativeRuns.length} supported native text runs detected. Viewer text selection is rendered separately from the original PDF content.</div>
              </div>
            ) : (
              <div className="inspector-content document-inspector">
                <span className="document-icon"><FaInfoCircle /></span>
                <h3>Document information</h3>
                <p>Current PDF session details.</p>
                <div className="detail-row"><span>File</span><strong title={fileName}>{fileName}</strong></div>
                <div className="detail-row"><span>File size</span><strong>{formatBytes(fileSize)}</strong></div>
                <div className="detail-row"><span>Pages</span><strong>{pageCount}</strong></div>
                <div className="detail-row"><span>Renderer</span><strong>{engineStatus === 'ready' ? 'PDFium + PDF.js' : 'PDF.js'}</strong></div>
                {selectedViewerText && <div className="selected-viewer-text"><strong>Selected text</strong><p>{selectedViewerText}</p><button type="button" onClick={() => navigator.clipboard?.writeText(selectedViewerText).then(() => showToast('Selected text copied.')).catch(() => showToast('Clipboard access is unavailable.', 'error'))}>Copy selected text</button></div>}
                <div className="privacy-card"><FaLock /><div><strong>Private document session</strong><span>Your PDF is processed locally in this browser tab.</span></div></div>
                <button type="button" className="outline-full-button" onClick={() => { setNativeEditorOpen(true); setShowInspector(true) }} disabled={!documentSession}><FaEdit /> Open native text tools</button>
              </div>
            )}
          </aside>}

          {!showPages && <button type="button" className="reopen-panel left" onClick={() => setShowPages(true)} title="Show pages"><FaList /></button>}
          {!showInspector && <button type="button" className="reopen-panel right" onClick={() => setShowInspector(true)} title="Show properties"><FaSlidersH /></button>}
          </>}
        </section>
      </section>
      <Toast message={toastMessage} type={toast.type} onClose={closeToast} />
    </main>
  )
}

export default App
