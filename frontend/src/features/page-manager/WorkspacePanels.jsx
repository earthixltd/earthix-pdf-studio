import { useState } from "react";
import {
  FaArrowDown,
  FaArrowUp,
  FaCheck,
  FaFilePdf,
  FaFolderOpen,
  FaPlus,
  FaUndo,
  FaRedo,
  FaTrash,
  FaUpload,
} from "react-icons/fa";
import { FaScissors } from "react-icons/fa6";
import { PdfPageThumbnail } from "../pdf-viewer/PdfPageThumbnail.jsx";

export function HomeWorkspace({
  onOpenPdf,
  onMerge,
  recentFiles,
  onOpenRecent,
}) {
  return (
    <section className="workspace-home-panel">
      <div className="workspace-hero">
        <span className="workspace-hero-icon">
          <FaFilePdf />
        </span>
        <p className="workspace-eyebrow">EARTHIX PDF STUDIO</p>
        <h1>Everything you need to work with PDFs.</h1>
        <p>Open a PDF or pick a tool. Your files never leave this device.</p>
        <div className="workspace-hero-actions">
          <button
            type="button"
            className="primary-workspace-button"
            onClick={onOpenPdf}
          >
            <FaUpload /> Open PDF
          </button>
          <button
            type="button"
            className="secondary-workspace-button"
            onClick={onMerge}
          >
            <FaFolderOpen /> Merge PDFs
          </button>
        </div>
      </div>
      <section className="workspace-recent-card">
        <div className="workspace-section-heading">
          <div>
            <h2>Recent files</h2>
            <p>Files opened in this browser session</p>
          </div>
        </div>
        {recentFiles.length ? (
          <div className="workspace-recent-list">
            {recentFiles.map((item, index) => (
              <button
                type="button"
                key={`${item.name}-${item.openedAt}-${index}`}
                onClick={() => onOpenRecent(item)}
              >
                <FaFilePdf />
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.sizeLabel}</small>
                </span>
                <small>Open</small>
              </button>
            ))}
          </div>
        ) : (
          <div className="workspace-empty-state">
            Nothing here yet — files you open will show up here.
          </div>
        )}
      </section>
    </section>
  );
}

export function SplitWorkspace({
  pageCount,
  fileName,
  fromPage,
  toPage,
  setFromPage,
  setToPage,
  onSplit,
  processing,
  onOpenPdf,
}) {
  return (
    <section className="workspace-tool-panel">
      <div className="workspace-tool-heading">
        <span className="workspace-tool-icon">
          <FaScissors />
        </span>
        <div>
          <p className="workspace-eyebrow">WORKSPACE TOOL</p>
          <h1>Split PDF</h1>
          <p>Save some pages as a new PDF. Your original stays the same.</p>
        </div>
      </div>
      {pageCount ? (
        <div className="split-tool-card">
          <div className="split-source-file">
            <FaFilePdf />
            <span>
              <strong>{fileName}</strong>
              <small>{pageCount} pages available</small>
            </span>
          </div>
          <div className="split-range-fields">
            <label>
              Start page
              <input
                type="number"
                min="1"
                max={pageCount}
                value={fromPage}
                onChange={(event) => setFromPage(event.target.value)}
              />
            </label>
            <span className="split-range-separator">to</span>
            <label>
              End page
              <input
                type="number"
                min="1"
                max={pageCount}
                value={toPage}
                onChange={(event) => setToPage(event.target.value)}
              />
            </label>
          </div>
          <p className="workspace-field-hint">
            Choose any continuous page range from 1 to {pageCount}.
          </p>
          <button
            type="button"
            className="primary-workspace-button"
            onClick={onSplit}
            disabled={processing}
          >
            <FaScissors />{" "}
            {processing ? "Preparing PDF…" : "Extract pages & download"}
          </button>
        </div>
      ) : (
        <div className="workspace-empty-tool">
          <FaFilePdf />
          <h2>Open a PDF to split</h2>
          <p>
            Select a document first, then choose the page range you want to
            export.
          </p>
          <button
            type="button"
            className="primary-workspace-button"
            onClick={onOpenPdf}
          >
            <FaUpload /> Choose PDF
          </button>
        </div>
      )}
    </section>
  );
}

export function OrganizeWorkspace({
  session,
  plan,
  onMove,
  onRotate,
  onRemove,
  onAddBlank,
  onApply,
  onReset,
  changed,
  processing,
  onOpenPdf,
}) {
  const [dragIndex, setDragIndex] = useState(null);
  return (
    <section className="workspace-tool-panel organize-tool-panel">
      <div className="workspace-tool-heading">
        <span className="workspace-tool-icon">
          <FaFilePdf />
        </span>
        <div>
          <p className="workspace-eyebrow">WORKSPACE TOOL</p>
          <h1>Organize Pages</h1>
          <p>
            Drag pages to reorder, rotate or remove them. Nothing changes until
            you apply.
          </p>
        </div>
      </div>
      {session ? (
        <>
          <div className="organize-toolbar">
            <span>{plan.length} pages in output</span>
            <div>
              <button
                type="button"
                className="secondary-workspace-button compact"
                onClick={onAddBlank}
              >
                <FaPlus /> Add blank page
              </button>
              <button
                type="button"
                className="secondary-workspace-button compact"
                onClick={onReset}
                disabled={!changed}
              >
                Reset
              </button>
              <button
                type="button"
                className="primary-workspace-button compact"
                onClick={onApply}
                disabled={!changed || processing}
              >
                <FaCheck /> {processing ? "Applying…" : "Apply changes"}
              </button>
            </div>
          </div>
          <div className="organize-page-grid">
            {plan.map((item, index) => (
              <article
                key={item.id}
                className={`organize-page-card ${dragIndex === index ? "dragging" : ""}`}
                draggable
                onDragStart={() => setDragIndex(index)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => {
                  if (dragIndex !== null && dragIndex !== index)
                    onMove(dragIndex, index);
                  setDragIndex(null);
                }}
                onDragEnd={() => setDragIndex(null)}
              >
                <div
                  className="organize-page-preview"
                  style={{ transform: `rotate(${item.rotationDelta || 0}deg)` }}
                >
                  {item.isBlank ? (
                    <div className="organize-blank-preview">
                      <FaFilePdf />
                      <small>Blank page</small>
                    </div>
                  ) : (
                    <PdfPageThumbnail
                      session={session}
                      pageIndex={item.sourceIndex}
                      active={false}
                      onClick={() => undefined}
                    />
                  )}
                </div>
                <div className="organize-page-meta">
                  <strong>Page {index + 1}</strong>
                  <small>
                    {item.isBlank
                      ? "New page"
                      : `Original page ${item.sourceIndex + 1}`}
                  </small>
                </div>
                <div className="organize-page-actions">
                  <button
                    type="button"
                    title="Move up"
                    aria-label={`Move page ${index + 1} up`}
                    onClick={() => onMove(index, index - 1)}
                    disabled={index === 0}
                  >
                    <FaArrowUp />
                  </button>
                  <button
                    type="button"
                    title="Move down"
                    aria-label={`Move page ${index + 1} down`}
                    onClick={() => onMove(index, index + 1)}
                    disabled={index === plan.length - 1}
                  >
                    <FaArrowDown />
                  </button>
                  <button
                    type="button"
                    title="Rotate left"
                    aria-label={`Rotate page ${index + 1} left`}
                    onClick={() => onRotate(index, -90)}
                  >
                    <FaUndo />
                  </button>
                  <button
                    type="button"
                    title="Rotate right"
                    aria-label={`Rotate page ${index + 1} right`}
                    onClick={() => onRotate(index, 90)}
                  >
                    <FaRedo />
                  </button>
                  <button
                    type="button"
                    title="Remove page"
                    aria-label={`Remove page ${index + 1}`}
                    onClick={() => onRemove(index)}
                    disabled={plan.length <= 1}
                  >
                    <FaTrash />
                  </button>
                </div>
              </article>
            ))}
          </div>
        </>
      ) : (
        <div className="workspace-empty-tool">
          <FaFilePdf />
          <h2>Open a PDF to organize pages</h2>
          <p>Page thumbnails and organization controls will appear here.</p>
          <button
            type="button"
            className="primary-workspace-button"
            onClick={onOpenPdf}
          >
            <FaUpload /> Choose PDF
          </button>
        </div>
      )}
    </section>
  );
}
