import { useMemo } from 'react'
import { FaCheckCircle, FaExclamationTriangle, FaFont, FaLock } from 'react-icons/fa'
import { assessFontReplacement, getFontStyleLabel } from '../../engine/font-engine/fontCapabilities.js'
import { findFontForRun } from '../../engine/font-engine/FontInspector.js'
import './FontInspectorPanel.css'

function formatNumber(value, digits = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)).toString() : '—'
}

function Property({ label, value, mono = false }) {
  return (
    <div className="font-inspector-property">
      <dt>{label}</dt>
      <dd className={mono ? 'font-inspector-mono' : ''}>{value ?? '—'}</dd>
    </div>
  )
}

function FontSummary({ font, selected = false }) {
  return (
    <div className={`font-inspector-font-summary ${selected ? 'selected' : ''}`}>
      <span className="font-inspector-font-icon"><FaFont /></span>
      <span className="font-inspector-font-copy">
        <strong>{font.fontFamily || font.baseFontName || 'Unknown font'}</strong>
        <small>{font.resourceName} · {font.subtype} · {font.encoding}</small>
      </span>
      <span className={`font-inspector-status ${font.canNativeReplace ? 'supported' : 'unsupported'}`}>
        {font.canNativeReplace ? 'Editable' : 'Limited'}
      </span>
    </div>
  )
}

export function FontInspectorPanel({ fonts = [], run = null, replacementText = '' }) {
  const selectedFont = useMemo(() => {
    if (!run) return null
    return findFontForRun(fonts, run)
  }, [fonts, run])

  const compatibility = useMemo(() => (
    run && selectedFont ? assessFontReplacement(selectedFont, replacementText) : null
  ), [run, selectedFont, replacementText])

  if (!fonts.length && !run) {
    return (
      <section className="font-inspector" aria-labelledby="font-inspector-title">
        <div className="font-inspector-heading">
          <FaFont />
          <div><h3 id="font-inspector-title">Font Inspector</h3><small>No font information available</small></div>
        </div>
        <p className="font-inspector-empty">Open a PDF to inspect its font resources and text runs.</p>
      </section>
    )
  }

  return (
    <section className="font-inspector" aria-labelledby="font-inspector-title">
      <div className="font-inspector-heading">
        <FaFont />
        <div>
          <h3 id="font-inspector-title">Font Inspector</h3>
          <small>{fonts.length} font resource(s) detected</small>
        </div>
      </div>

      {selectedFont ? (
        <>
          <FontSummary font={selectedFont} selected />
          <dl className="font-inspector-grid">
            <Property label="Base font" value={selectedFont.baseFontName} mono />
            <Property label="Font type" value={selectedFont.subtype} />
            <Property label="Encoding" value={selectedFont.encoding} />
            <Property label="Style" value={getFontStyleLabel(selectedFont)} />
            <Property label="Weight" value={selectedFont.fontWeight} />
            <Property label="Font flags" value={selectedFont.fontFlags} />
            <Property label="Embedded" value={selectedFont.isEmbedded ? 'Yes' : 'No'} />
            <Property label="Subset font" value={selectedFont.isSubset ? 'Yes' : 'No'} />
            <Property label="ToUnicode map" value={selectedFont.hasToUnicode ? 'Available' : 'Missing'} />
            <Property label="Unicode entries" value={selectedFont.unicodeMapEntries} />
            <Property label="Supported glyphs" value={selectedFont.supportedCharacterCount} />
            <Property label="Width metrics" value={selectedFont.widthMetricCount} />
          </dl>

          {run && (
            <>
              <div className="font-inspector-section-title">Selected text run</div>
              <dl className="font-inspector-grid">
                <Property label="Page" value={run.pageNumber} />
                <Property label="Text operator" value={run.tokenType} />
                <Property label="Font size" value={`${formatNumber(run.fontSize)} pt`} />
                <Property label="Character spacing" value={`${formatNumber(run.characterSpacing)} pt`} />
                <Property label="Word spacing" value={`${formatNumber(run.wordSpacing)} pt`} />
                <Property label="Horizontal scale" value={`${formatNumber(run.horizontalScaling)}%`} />
                <Property label="Text position" value={run.position ? `${formatNumber(run.position.x)}, ${formatNumber(run.position.y)} pt` : 'Not available'} />
                <Property label="Rendering mode" value={run.textRenderingMode} />
                <Property label="Text rise" value={`${formatNumber(run.textRise)} pt`} />
              </dl>
              <div className="font-inspector-color-row">
                <span>Fill color</span>
                <span className="font-inspector-color-value"><i style={{ backgroundColor: run.fillColor || '#000000' }} />{run.fillColor || 'Unknown'}</span>
                <span>Stroke color</span>
                <span className="font-inspector-color-value"><i style={{ backgroundColor: run.strokeColor || '#000000' }} />{run.strokeColor || 'Unknown'}</span>
              </div>
            </>
          )}

          <div className={`font-inspector-compatibility ${compatibility?.supported ? 'is-supported' : 'is-limited'}`} role="status">
            {compatibility?.supported ? <FaCheckCircle /> : <FaExclamationTriangle />}
            <div>
              <strong>{compatibility?.supported ? 'Replacement glyphs available' : 'Replacement compatibility'}</strong>
              <small>{compatibility?.reason || (selectedFont.canNativeReplace ? 'The selected run uses a readable Identity-H font map.' : selectedFont.limitations?.[0]) || 'Inspect the selected run before replacing text.'}</small>
            </div>
          </div>

          {!selectedFont.isEmbedded && (
            <div className="font-inspector-note"><FaLock /><span>The font program is not embedded. Native character replacement may be possible, but visual font fidelity cannot be guaranteed.</span></div>
          )}
        </>
      ) : (
        <div className="font-inspector-font-list">
          <p className="font-inspector-empty">Select an editable text run to inspect its exact font and text properties.</p>
          {fonts.map((font) => <FontSummary key={font.id} font={font} />)}
        </div>
      )}
    </section>
  )
}
