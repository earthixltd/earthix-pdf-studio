import { useEffect, useRef, useState } from 'react'
import {
  FaAlignCenter, FaAlignLeft, FaAlignRight, FaArrowDown, FaChevronDown, FaChevronUp, FaArrowUp, FaBold, FaClone, FaDesktop, FaEraser, FaExchangeAlt,
  FaFont, FaHighlighter, FaICursor, FaImage, FaInfoCircle, FaItalic, FaKeyboard, FaLock, FaLongArrowAltRight,
  FaPenNib, FaRedoAlt, FaRegCircle, FaRegSquare, FaShapes, FaSlash, FaStickyNote,
  FaStrikethrough, FaTimes, FaTrashAlt, FaUnderline, FaUndoAlt,
} from 'react-icons/fa'
import { STANDARD_FAMILIES, isStandardFamily, textWeight } from '../../engine/page-objects/textLayout.js'
import { COLOR_SWATCHES, HIGHLIGHT_COLORS, NOTE_COLORS, isLineShape, objectLabel } from './objectFactory.js'

const TYPE_ICONS = { text: FaFont, image: FaImage, shape: FaShapes, ink: FaPenNib, highlight: FaHighlighter, note: FaStickyNote }
const round = (value, digits = 1) => (Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : 0)

// ---------------------------------------------------------------------------
// Small controls
// ---------------------------------------------------------------------------

const HEX = /^#[0-9a-f]{6}$/i

function ColorPicker({ value, onChange, colors = COLOR_SWATCHES, allowNone = false, label }) {
  const pickerRef = useRef(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  // The picker keeps its own value while open; it is committed when the
  // browser's colour dialog closes (change) or the input loses focus.
  const [custom, setCustom] = useState(HEX.test(value || '') ? value : '#000000')
  const committedRef = useRef(value)
  useEffect(() => {
    committedRef.current = value
    if (HEX.test(value || '')) setCustom(value)
  }, [value])
  useEffect(() => {
    const input = pickerRef.current
    if (!input) return undefined
    const commit = () => {
      const next = input.value.toUpperCase()
      if (next !== String(committedRef.current || '').toUpperCase()) {
        committedRef.current = next
        onChangeRef.current(next)
      }
    }
    input.addEventListener('change', commit)
    input.addEventListener('blur', commit)
    return () => {
      input.removeEventListener('change', commit)
      input.removeEventListener('blur', commit)
    }
  }, [])
  const current = (value || '').toUpperCase()
  const isCustom = Boolean(value) && !colors.some((color) => color.toUpperCase() === current)
  return (
    <div className="swatches" role="group" aria-label={label}>
      {allowNone && <button type="button" className={`swatch none ${!value ? 'active' : ''}`} title="None" aria-label="No colour" onClick={() => onChange(null)} />}
      {colors.map((color) => (
        <button key={color} type="button" className={`swatch ${current === color.toUpperCase() ? 'active' : ''}`} style={{ background: color }} title={color} aria-label={color} onClick={() => onChange(color)} />
      ))}
      <label className={`swatch-picker ${isCustom ? 'active' : ''}`} title="Pick any colour" style={isCustom ? { background: value } : undefined}>
        <input ref={pickerRef} type="color" value={custom} onChange={(event) => setCustom(event.target.value)} aria-label="Pick any colour" />
      </label>
    </div>
  )
}

/** Slider that previews while dragging and commits on release. */
function RangeField({ label, value, min, max, step, format = (v) => v, onPreview, onCommit, disabled }) {
  const [local, setLocal] = useState(value)
  const activeRef = useRef(false)
  useEffect(() => { if (!activeRef.current) setLocal(value) }, [value])
  const commit = () => {
    if (!activeRef.current) return
    activeRef.current = false
    onCommit(Number(local))
  }
  return (
    <div className="field">
      <label>{label}</label>
      <div className="range-row">
        <input
          type="range" min={min} max={max} step={step} value={local} disabled={disabled}
          onChange={(event) => { activeRef.current = true; setLocal(event.target.value); onPreview?.(Number(event.target.value)) }}
          onPointerUp={commit} onKeyUp={commit} onBlur={commit} onTouchEnd={commit}
        />
        <span>{format(Number(local))}</span>
      </div>
    </div>
  )
}

/** Number box that commits on Enter or blur. */
function NumberField({ label, value, onCommit, min = -100000, max = 100000, step = 1, suffix, prefix, disabled }) {
  const [local, setLocal] = useState(String(round(value)))
  useEffect(() => { setLocal(String(round(value))) }, [value])
  const commit = () => {
    const parsed = Number(local)
    if (!Number.isFinite(parsed)) { setLocal(String(round(value))); return }
    const clamped = Math.max(min, Math.min(max, parsed))
    if (Math.abs(clamped - value) > 0.001) onCommit(clamped)
    else setLocal(String(round(value)))
  }
  const input = (
    <input
      className="input" type="number" inputMode="decimal" value={local} step={step} min={min} max={max} disabled={disabled}
      onChange={(event) => setLocal(event.target.value)} onBlur={commit}
      onKeyDown={(event) => { if (event.key === 'Enter') { event.currentTarget.blur() } }}
    />
  )
  return (
    <div className="field">
      {label && <label>{label}</label>}
      {suffix ? <div className="input-affix">{input}<span>{suffix}</span></div> : prefix ? <div className="input-prefix">{input}<span>{prefix}</span></div> : input}
    </div>
  )
}

function Segmented({ options, value, onChange, label }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => {
        const Icon = option.icon
        return (
          <button key={option.value} type="button" className={value === option.value ? 'active' : ''} title={option.title || option.label} aria-pressed={value === option.value} onClick={() => onChange(option.value)}>
            {Icon && <Icon />}{option.label && <span>{option.label}</span>}
          </button>
        )
      })}
    </div>
  )
}

function FontSelect({ value, source, localFonts, onChange, extraFamily, disabled }) {
  const localValue = source === 'local' ? `local:${value}` : `std:${value}`
  const current = extraFamily && value === extraFamily && source === 'original' ? 'original' : localValue
  return (
    <select
      className="select" value={current} disabled={disabled}
      onChange={(event) => {
        const raw = event.target.value
        if (raw === 'load') { localFonts.onLoad(); return }
        if (raw === 'upload') { localFonts.onUpload(); return }
        if (raw === 'original') return
        const [kind, family] = [raw.slice(0, raw.indexOf(':')), raw.slice(raw.indexOf(':') + 1)]
        onChange({ fontFamily: family, fontSource: kind === 'local' ? 'local' : 'standard' })
      }}
    >
      {extraFamily && <option value="original">{extraFamily} (original)</option>}
      <optgroup label="Standard PDF fonts">
        {STANDARD_FAMILIES.map((family) => <option key={family.id} value={`std:${family.id}`}>{family.label}</option>)}
      </optgroup>
      {localFonts.uploaded.length > 0 && (
        <optgroup label="Your fonts">
          {localFonts.uploaded.map((family) => <option key={family} value={`local:${family}`}>{family}</option>)}
        </optgroup>
      )}
      <optgroup label="Free fonts">
        {localFonts.free.filter((family) => !localFonts.uploaded.includes(family)).map((family) => <option key={family} value={`local:${family}`}>{family}</option>)}
      </optgroup>
      {localFonts.families.length > 0 && (
        <optgroup label="Fonts on this computer">
          {localFonts.families.filter((family) => !localFonts.uploaded.includes(family) && !localFonts.free.includes(family)).map((family) => <option key={family} value={`local:${family}`}>{family}</option>)}
        </optgroup>
      )}
      {!localFonts.families.length && localFonts.supported && <option value="load">More fonts from this computer…</option>}
      <option value="upload">Upload a font…</option>
    </select>
  )
}

const WEIGHT_NAMES = { 100: 'Thin', 200: 'Extra Light', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'Semibold', 700: 'Bold', 800: 'Extra Bold', 900: 'Black' }

/** Only the weights this font really has on this computer, plus the current one. */
function WeightSelect({ family, value, localFonts, onChange, disabled }) {
  const standard = isStandardFamily(family)
  const options = [...new Set([...(standard ? [400, 700] : localFonts.weightsFor(family)), value])].sort((a, b) => a - b)
  const canLoad = !standard && !localFonts.families.length && localFonts.supported
  return (
    <div className="field">
      <label>Weight</label>
      <select
        className="select" value={value} aria-label="Font weight" disabled={disabled || (options.length < 2 && !canLoad)}
        onChange={(event) => {
          if (event.target.value === 'load') { localFonts.onLoad(); return }
          onChange(Number(event.target.value))
        }}
      >
        {options.map((weight) => <option key={weight} value={weight}>{WEIGHT_NAMES[weight] || weight}</option>)}
        {canLoad && <option value="load">More from this computer…</option>}
      </select>
    </div>
  )
}

function ToggleRow({ items }) {
  return (
    <div className="segmented">
      {items.map((item) => {
        const Icon = item.icon
        return <button key={item.title} type="button" className={item.active ? 'active' : ''} aria-pressed={item.active} title={item.title} onClick={item.onClick} disabled={item.disabled}><Icon /></button>
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Object properties
// ---------------------------------------------------------------------------

function TextProperties({ object, update, preview, localFonts }) {
  return (
    <>
      <div className="prop-section">
        <p className="prop-title">Text</p>
        <div className="field">
          <label>Font</label>
          <FontSelect value={object.fontFamily} source={object.fontSource} localFonts={localFonts} onChange={(patch) => update(patch, 'Change font')} />
        </div>
        <WeightSelect family={object.fontFamily} value={textWeight(object)} localFonts={localFonts} onChange={(weight) => update({ weight, bold: weight >= 600 }, 'Change weight')} />
        <div className="field-row">
          <NumberField label="Size" value={object.fontSize} min={4} max={300} step={0.5} suffix="pt" onCommit={(fontSize) => update({ fontSize }, 'Change text size')} />
          <div className="field">
            <label>Line spacing</label>
            <select className="select" value={object.lineHeight || 1.25} onChange={(event) => update({ lineHeight: Number(event.target.value) }, 'Change line spacing')}>
              {[1, 1.15, 1.25, 1.5, 2].map((value) => <option key={value} value={value}>{value.toFixed(2)}</option>)}
            </select>
          </div>
        </div>
        <div className="field-row">
          <ToggleRow items={[
            { title: 'Bold', icon: FaBold, active: textWeight(object) >= 600, onClick: () => update({ bold: textWeight(object) < 600, weight: textWeight(object) < 600 ? 700 : 400 }, 'Bold') },
            { title: 'Italic', icon: FaItalic, active: object.italic, onClick: () => update({ italic: !object.italic }, 'Italic') },
            { title: 'Underline', icon: FaUnderline, active: object.underline, onClick: () => update({ underline: !object.underline }, 'Underline') },
            { title: 'Strikethrough', icon: FaStrikethrough, active: object.strike, onClick: () => update({ strike: !object.strike }, 'Strikethrough') },
          ]} />
          <Segmented label="Alignment" value={object.align || 'left'} onChange={(align) => update({ align }, 'Align text')} options={[
            { value: 'left', icon: FaAlignLeft, title: 'Align left' }, { value: 'center', icon: FaAlignCenter, title: 'Centre' }, { value: 'right', icon: FaAlignRight, title: 'Align right' },
          ]} />
        </div>
        <div className="field"><label>Colour</label><ColorPicker value={object.color} onChange={(color) => update({ color }, 'Text colour')} /></div>
        <div className="field"><label>Background</label><ColorPicker value={object.backgroundColor} allowNone colors={['#FFFFFF', '#FFF4CC', '#E0EAFF', '#DCFAE6', '#FEE4E2', '#1B2333']} onChange={(backgroundColor) => update({ backgroundColor }, 'Text background')} /></div>
        <label className="check-row"><input type="checkbox" checked={!object.autoWidth} onChange={(event) => update({ autoWidth: !event.target.checked }, event.target.checked ? 'Wrap text' : 'Auto width')} /> Wrap text inside a fixed width</label>
      </div>
      <OpacityRotation object={object} update={update} preview={preview} rotate />
    </>
  )
}

function OpacityRotation({ object, update, preview, rotate = false }) {
  return (
    <div className="prop-section">
      <p className="prop-title">Appearance</p>
      <RangeField label="Opacity" value={Math.round((object.opacity ?? 1) * 100)} min={10} max={100} step={1} format={(value) => `${value}%`}
        onPreview={(value) => preview({ ...object, opacity: value / 100 })} onCommit={(value) => update({ opacity: value / 100 }, 'Change opacity')} />
      {rotate && (
        <div className="field-row">
          <NumberField label="Rotation" value={object.rotation || 0} min={-360} max={360} suffix="°" onCommit={(rotation) => update({ rotation: ((rotation % 360) + 360) % 360 }, 'Rotate')} />
          <div className="field"><label>&nbsp;</label><div className="button-row">
            <button type="button" className="btn btn-secondary btn-sm" title="Rotate left 90°" onClick={() => update({ rotation: (((object.rotation || 0) - 90) % 360 + 360) % 360 }, 'Rotate')}><FaUndoAlt /></button>
            <button type="button" className="btn btn-secondary btn-sm" title="Rotate right 90°" onClick={() => update({ rotation: ((object.rotation || 0) + 90) % 360 }, 'Rotate')}><FaRedoAlt /></button>
          </div></div>
        </div>
      )}
    </div>
  )
}

function GeometryFields({ object, update }) {
  if (isLineShape(object) || object.type === 'highlight') return null
  const isNote = object.type === 'note'
  return (
    <div className="prop-section">
      <p className="prop-title">Position &amp; size <small>pt</small></p>
      <div className="field-row">
        <NumberField prefix="X" value={object.x} onCommit={(x) => update({ x }, 'Move')} />
        <NumberField prefix="Y" value={object.y} onCommit={(y) => update({ y }, 'Move')} />
        {!isNote && object.type !== 'text' && <NumberField prefix="W" value={object.width} min={2} onCommit={(width) => update({ width, ...(object.type === 'image' && object.keepAspect !== false ? { height: width * (object.height / object.width) } : {}) }, 'Resize')} />}
        {!isNote && object.type !== 'text' && <NumberField prefix="H" value={object.height} min={2} onCommit={(height) => update({ height, ...(object.type === 'image' && object.keepAspect !== false ? { width: height * (object.width / object.height) } : {}) }, 'Resize')} />}
        {object.type === 'text' && !object.autoWidth && <NumberField prefix="W" value={object.width} min={10} onCommit={(width) => update({ width }, 'Resize')} />}
      </div>
    </div>
  )
}

function ObjectProperties({ object, actions, localFonts }) {
  const update = (patch, label) => actions.update({ ...object, ...patch }, label)
  const preview = actions.preview
  const Icon = TYPE_ICONS[object.type] || FaShapes
  return (
    <>
      <div className="prop-section">
        <div className="prop-hero">
          <span className="prop-hero-icon"><Icon /></span>
          <div><strong>{objectLabel(object)}</strong><small>Page {object.pageIndex + 1}</small></div>
          <div className="prop-actions">
            <button type="button" className="icon-btn sm" title="Bring forward" onClick={() => actions.arrange(object, 1)}><FaArrowUp /></button>
            <button type="button" className="icon-btn sm" title="Send backward" onClick={() => actions.arrange(object, -1)}><FaArrowDown /></button>
            <button type="button" className="icon-btn sm" title="Duplicate (Ctrl+D)" onClick={() => actions.duplicate(object)}><FaClone /></button>
            <button type="button" className="icon-btn sm" title="Delete (Del)" onClick={() => actions.remove(object)}><FaTrashAlt /></button>
          </div>
        </div>
        {object.type === 'text' && <p className="notice" style={{ marginTop: 12 }}><FaInfoCircle />Double-tap to type. Drag the corners to resize.</p>}
      </div>

      {object.type === 'text' && <TextProperties object={object} update={update} preview={preview} localFonts={localFonts} />}

      {object.type === 'image' && (
        <>
          <OpacityRotation object={object} update={update} preview={preview} rotate />
          <div className="prop-section">
            <p className="prop-title">Image</p>
            <div className="button-row">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => actions.replaceImage(object)}><FaExchangeAlt /> Replace</button>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => actions.readImageText(object)}><FaICursor /> Edit text</button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => update({ height: object.width * ((object.pixelHeight || 1) / (object.pixelWidth || 1)) }, 'Reset proportions')}>Reset ratio</button>
            </div>
          </div>
        </>
      )}

      {object.type === 'shape' && (
        <>
          <div className="prop-section">
            <p className="prop-title">{object.whiteout ? 'Whiteout' : 'Shape'}</p>
            {object.whiteout ? (
              <p className="notice"><FaEraser />Hides what’s underneath. The text is still in the file.</p>
            ) : (
              <>
                <div className="field"><label>Outline colour</label><ColorPicker value={object.strokeColor} allowNone={!isLineShape(object)} onChange={(strokeColor) => update({ strokeColor, strokeWidth: strokeColor && !object.strokeWidth ? 2 : object.strokeWidth }, 'Outline colour')} /></div>
                {!isLineShape(object) && <div className="field"><label>Fill</label><ColorPicker value={object.fillColor} allowNone onChange={(fillColor) => update({ fillColor }, 'Fill colour')} /></div>}
                <RangeField label="Line width" value={object.strokeWidth ?? 2} min={0} max={20} step={0.5} format={(value) => `${value} pt`}
                  onPreview={(strokeWidth) => preview({ ...object, strokeWidth })} onCommit={(strokeWidth) => update({ strokeWidth }, 'Line width')} />
                <label className="check-row"><input type="checkbox" checked={Boolean(object.dashed)} onChange={(event) => update({ dashed: event.target.checked }, 'Dashed line')} /> Dashed line</label>
              </>
            )}
          </div>
          {object.whiteout
            ? <div className="prop-section"><p className="prop-title">Colour</p><ColorPicker value={object.fillColor} colors={['#FFFFFF', '#F2F4F7', '#000000']} onChange={(fillColor) => update({ fillColor: fillColor || '#FFFFFF' }, 'Whiteout colour')} /></div>
            : <OpacityRotation object={object} update={update} preview={preview} rotate={!isLineShape(object)} />}
        </>
      )}

      {object.type === 'ink' && (
        <>
          <div className="prop-section">
            <p className="prop-title">{object.signature ? 'Signature' : 'Drawing'}</p>
            <div className="field"><label>Colour</label><ColorPicker value={object.color} onChange={(color) => update({ color }, 'Drawing colour')} /></div>
            <RangeField label="Pen width" value={object.strokeWidth ?? 2} min={0.5} max={16} step={0.5} format={(value) => `${value} pt`}
              onPreview={(strokeWidth) => preview({ ...object, strokeWidth })} onCommit={(strokeWidth) => update({ strokeWidth }, 'Pen width')} />
          </div>
          <OpacityRotation object={object} update={update} preview={preview} />
        </>
      )}

      {object.type === 'highlight' && (
        <div className="prop-section">
          <p className="prop-title">Markup</p>
          <div className="field">
            <Segmented label="Markup type" value={object.kind || 'highlight'} onChange={(kind) => update({ kind, opacity: kind === 'highlight' ? 0.45 : 1 }, 'Change markup')} options={[
              { value: 'highlight', icon: FaHighlighter, label: 'Highlight' }, { value: 'underline', icon: FaUnderline, title: 'Underline' }, { value: 'strikeout', icon: FaStrikethrough, title: 'Strikethrough' },
            ]} />
          </div>
          <div className="field"><label>Colour</label><ColorPicker value={object.color} colors={(object.kind || 'highlight') === 'highlight' ? HIGHLIGHT_COLORS : COLOR_SWATCHES} onChange={(color) => update({ color }, 'Markup colour')} /></div>
          {(object.kind || 'highlight') === 'highlight' && (
            <RangeField label="Strength" value={Math.round((object.opacity ?? 0.45) * 100)} min={15} max={90} step={1} format={(value) => `${value}%`}
              onPreview={(value) => preview({ ...object, opacity: value / 100 })} onCommit={(value) => update({ opacity: value / 100 }, 'Highlight strength')} />
          )}
          <div className="field"><label>Comment</label><CommitTextarea key={object.id} value={object.comment || ''} placeholder="Add a note to this highlight…" onCommit={(comment) => update({ comment }, 'Edit comment')} /></div>
          {object.text && <p className="notice"><FaInfoCircle />“{object.text.length > 120 ? `${object.text.slice(0, 120)}…` : object.text}”</p>}
        </div>
      )}

      {object.type === 'note' && (
        <div className="prop-section">
          <p className="prop-title">Comment</p>
          <div className="field"><CommitTextarea key={object.id} autoFocus={!object.text} value={object.text || ''} placeholder="Write your comment…" onCommit={(text) => update({ text }, 'Edit comment')} /></div>
          <div className="field"><label>Colour</label><ColorPicker value={object.color} colors={NOTE_COLORS} onChange={(color) => update({ color }, 'Comment colour')} /></div>
          <p className="notice"><FaInfoCircle />Other PDF apps will show this comment too.</p>
        </div>
      )}

      <GeometryFields object={object} update={update} />
    </>
  )
}

/** Saves by itself shortly after typing stops, and whenever it is left or closed. */
function CommitTextarea({ value, onCommit, placeholder, autoFocus }) {
  const [local, setLocal] = useState(value)
  const savedRef = useRef(value)
  const pendingRef = useRef(null)
  const timerRef = useRef(null)
  const onCommitRef = useRef(onCommit)
  onCommitRef.current = onCommit

  const flush = () => {
    window.clearTimeout(timerRef.current)
    const text = pendingRef.current
    pendingRef.current = null
    if (text === null || text === savedRef.current) return
    savedRef.current = text
    onCommitRef.current(text)
  }
  const flushRef = useRef(flush)
  flushRef.current = flush

  useEffect(() => {
    if (value !== savedRef.current && pendingRef.current === null) {
      savedRef.current = value
      setLocal(value)
    }
  }, [value])
  useEffect(() => () => flushRef.current(), [])

  return (
    <textarea className="textarea" value={local} placeholder={placeholder} autoFocus={autoFocus}
      onChange={(event) => {
        setLocal(event.target.value)
        pendingRef.current = event.target.value
        window.clearTimeout(timerRef.current)
        timerRef.current = window.setTimeout(() => flushRef.current(), 350)
      }}
      onBlur={flush}
      onKeyDown={(event) => event.stopPropagation()} />
  )
}

// ---------------------------------------------------------------------------
// Existing PDF text and images
// ---------------------------------------------------------------------------

function BlockProperties({ block, busy, onStyle, localFonts, editing }) {
  const family = block.fontMetadata?.fontFamily || block.fontResource || 'Original font'
  const bold = (block.fontWeight || 400) >= 600
  const italic = block.fontStyle === 'italic'
  return (
    <>
      <div className="prop-section">
        <div className="prop-hero">
          <span className="prop-hero-icon"><FaICursor /></span>
          <div><strong>PDF text</strong><small>Page {block.pageNumber} · {editing ? 'typing…' : 'selected'}</small></div>
        </div>
        <p className="notice" style={{ marginTop: 12 }}><FaInfoCircle />Type on the page. Enter saves, Esc cancels.</p>
      </div>
      <div className="prop-section">
        <p className="prop-title">Style {busy && <small>Saving…</small>}</p>
        <div className="field">
          <label>Font</label>
          <FontSelect value={family} source="original" extraFamily={family} localFonts={localFonts} disabled={busy} onChange={(patch) => onStyle(block, patch)} />
        </div>
        <WeightSelect family={family} value={block.fontWeight || 400} localFonts={localFonts} disabled={busy} onChange={(weight) => onStyle(block, { weight })} />
        <div className="field-row">
          <NumberField label="Size" value={block.fontSizeUser} min={2} max={300} step={0.5} suffix="pt" disabled={busy} onCommit={(fontSize) => onStyle(block, { fontSize })} />
          <div className="field">
            <label>Style</label>
            <ToggleRow items={[
              { title: 'Bold', icon: FaBold, active: bold, disabled: busy, onClick: () => onStyle(block, { bold: !bold }) },
              { title: 'Italic', icon: FaItalic, active: italic, disabled: busy, onClick: () => onStyle(block, { italic: !italic }) },
            ]} />
          </div>
        </div>
        <div className="field"><label>Colour</label><ColorPicker value={block.fillColor} onChange={(color) => { if (!busy && color) onStyle(block, { color }) }} /></div>
        {block.twinKeys?.length > 0 && <p className="notice"><FaInfoCircle />This text has a shadow copy — both change together.</p>}
      </div>
    </>
  )
}

function PageImageProperties({ image, busy, onImage }) {
  const rect = image.viewRect
  const transform = (to) => onImage(image, { type: 'transform', from: rect, to })
  return (
    <>
      <div className="prop-section">
        <div className="prop-hero">
          <span className="prop-hero-icon"><FaImage /></span>
          <div><strong>PDF image</strong><small>Page {image.pageNumber} · {image.pixelWidth || '?'} × {image.pixelHeight || '?'} px</small></div>
          {image.editable && <div className="prop-actions"><button type="button" className="icon-btn sm" title="Delete image" disabled={busy} onClick={() => onImage(image, { type: 'delete' })}><FaTrashAlt /></button></div>}
        </div>
        {!image.editable && <p className="notice warning" style={{ marginTop: 12 }}><FaLock />{image.reason}</p>}
      </div>
      {image.editable && (
        <>
          <div className="prop-section">
            <p className="prop-title">Position &amp; size <small>pt</small></p>
            <div className="field-row">
              <NumberField prefix="X" value={rect.x} disabled={busy} onCommit={(x) => transform({ ...rect, x })} />
              <NumberField prefix="Y" value={rect.y} disabled={busy} onCommit={(y) => transform({ ...rect, y })} />
              <NumberField prefix="W" value={rect.width} min={2} disabled={busy} onCommit={(width) => transform({ ...rect, width, height: width * (rect.height / rect.width) })} />
              <NumberField prefix="H" value={rect.height} min={2} disabled={busy} onCommit={(height) => transform({ ...rect, height, width: height * (rect.width / rect.height) })} />
            </div>
            <div className="button-row">
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => onImage(image, { type: 'transform', from: rect, to: rect, rotation: -90 })}><FaUndoAlt /> Rotate</button>
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => onImage(image, { type: 'transform', from: rect, to: rect, rotation: 90 })}><FaRedoAlt /> Rotate</button>
            </div>
          </div>
          <div className="prop-section">
            <p className="prop-title">Image</p>
            <RangeField label="Opacity" value={100} min={10} max={100} step={5} format={(value) => `${value}%`} disabled={busy}
              onCommit={(value) => { if (value < 100) onImage(image, { type: 'opacity', value: value / 100 }) }} />
            <button type="button" className="btn btn-primary btn-block" disabled={busy} onClick={() => onImage(image, { type: 'read-text' })} style={{ marginBottom: 8 }}><FaICursor /> Edit text in this image</button>
            <button type="button" className="btn btn-secondary btn-block" disabled={busy || image.kind !== 'xobject'} onClick={() => onImage(image, { type: 'replace' })}><FaExchangeAlt /> Replace image…</button>
          </div>
        </>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Tool defaults and document information
// ---------------------------------------------------------------------------

function ToolSettings({ tool, settings, onSettings, localFonts }) {
  if (tool === 'text') {
    const text = settings.text
    const set = (patch) => onSettings('text', patch)
    return (
      <div className="prop-section">
        <p className="prop-title">New text</p>
        <div className="field"><label>Font</label><FontSelect value={text.fontFamily} source={text.fontSource} localFonts={localFonts} onChange={set} /></div>
        <WeightSelect family={text.fontFamily} value={textWeight(text)} localFonts={localFonts} onChange={(weight) => set({ weight, bold: weight >= 600 })} />
        <div className="field-row">
          <NumberField label="Size" value={text.fontSize} min={4} max={300} step={0.5} suffix="pt" onCommit={(fontSize) => set({ fontSize })} />
          <div className="field"><label>Style</label><ToggleRow items={[
            { title: 'Bold', icon: FaBold, active: textWeight(text) >= 600, onClick: () => set({ bold: textWeight(text) < 600, weight: textWeight(text) < 600 ? 700 : 400 }) },
            { title: 'Italic', icon: FaItalic, active: text.italic, onClick: () => set({ italic: !text.italic }) },
            { title: 'Underline', icon: FaUnderline, active: text.underline, onClick: () => set({ underline: !text.underline }) },
          ]} /></div>
        </div>
        <div className="field"><label>Colour</label><ColorPicker value={text.color} onChange={(color) => set({ color })} /></div>
      </div>
    )
  }
  if (tool === 'highlight') {
    const highlight = settings.highlight
    const set = (patch) => onSettings('highlight', patch)
    return (
      <div className="prop-section">
        <p className="prop-title">Markup</p>
        <div className="field"><Segmented label="Markup type" value={highlight.kind} onChange={(kind) => set({ kind, opacity: kind === 'highlight' ? 0.45 : 1, color: kind === 'highlight' ? HIGHLIGHT_COLORS[0] : '#D92D20' })} options={[
          { value: 'highlight', icon: FaHighlighter, label: 'Highlight' }, { value: 'underline', icon: FaUnderline, title: 'Underline' }, { value: 'strikeout', icon: FaStrikethrough, title: 'Strikethrough' },
        ]} /></div>
        <div className="field"><label>Colour</label><ColorPicker value={highlight.color} colors={highlight.kind === 'highlight' ? HIGHLIGHT_COLORS : COLOR_SWATCHES} onChange={(color) => set({ color })} /></div>
      </div>
    )
  }
  if (tool === 'draw') {
    const draw = settings.draw
    const set = (patch) => onSettings('draw', patch)
    return (
      <div className="prop-section">
        <p className="prop-title">Pen</p>
        <div className="field"><label>Colour</label><ColorPicker value={draw.color} onChange={(color) => set({ color })} /></div>
        <RangeField label="Width" value={draw.width} min={0.5} max={16} step={0.5} format={(value) => `${value} pt`} onCommit={(width) => set({ width })} />
        <RangeField label="Opacity" value={Math.round(draw.opacity * 100)} min={10} max={100} step={5} format={(value) => `${value}%`} onCommit={(value) => set({ opacity: value / 100 })} />
      </div>
    )
  }
  if (tool === 'shape') {
    const shape = settings.shape
    const set = (patch) => onSettings('shape', patch)
    return (
      <div className="prop-section">
        <p className="prop-title">Shape</p>
        <div className="field"><Segmented label="Shape" value={shape.shape} onChange={(value) => set({ shape: value })} options={[
          { value: 'rect', icon: FaRegSquare, title: 'Rectangle' }, { value: 'ellipse', icon: FaRegCircle, title: 'Ellipse' }, { value: 'line', icon: FaSlash, title: 'Line' }, { value: 'arrow', icon: FaLongArrowAltRight, title: 'Arrow' },
        ]} /></div>
        <div className="field"><label>Outline colour</label><ColorPicker value={shape.strokeColor} onChange={(strokeColor) => set({ strokeColor: strokeColor || '#1B2333' })} /></div>
        {shape.shape !== 'line' && shape.shape !== 'arrow' && <div className="field"><label>Fill</label><ColorPicker value={shape.fillColor} allowNone onChange={(fillColor) => set({ fillColor })} /></div>}
        <RangeField label="Line width" value={shape.strokeWidth} min={0.5} max={20} step={0.5} format={(value) => `${value} pt`} onCommit={(strokeWidth) => set({ strokeWidth })} />
        <label className="check-row"><input type="checkbox" checked={shape.dashed} onChange={(event) => set({ dashed: event.target.checked })} /> Dashed line</label>
        <p className="notice" style={{ marginTop: 12 }}><FaKeyboard />Hold Shift for perfect squares and straight lines.</p>
      </div>
    )
  }
  if (tool === 'note') {
    return (
      <div className="prop-section">
        <p className="prop-title">Comment</p>
        <div className="field"><label>Colour</label><ColorPicker value={settings.note.color} colors={NOTE_COLORS} onChange={(color) => onSettings('note', { color })} /></div>
      </div>
    )
  }
  return null
}

export function PropertiesPanel({
  selection, tool, toolSettings, onToolSettings, objectActions, blockBusy, onBlockStyle, onImage, imageBusy,
  localFonts, onClose,
  collapsible = false, collapsed = false, onToggleCollapsed,
}) {
  let title = 'Properties'
  let subtitle = ''
  let body
  if (selection?.kind === 'object') {
    title = objectLabel(selection.object)
    subtitle = 'Added item'
    body = <ObjectProperties object={selection.object} actions={objectActions} localFonts={localFonts} />
  } else if (selection?.kind === 'block') {
    title = 'Text'
    subtitle = 'Original PDF text'
    body = <BlockProperties block={selection.block} editing={selection.editing} busy={blockBusy} onStyle={onBlockStyle} localFonts={localFonts} />
  } else if (selection?.kind === 'image') {
    title = 'Image'
    subtitle = 'Original PDF image'
    body = <PageImageProperties image={selection.image} busy={imageBusy} onImage={onImage} />
  } else {
    if (['text', 'highlight', 'draw', 'shape', 'note'].includes(tool)) {
      title = 'Tool options'
      subtitle = 'Applies to new items'
      body = <ToolSettings tool={tool} settings={toolSettings} onSettings={onToolSettings} localFonts={localFonts} />
    } else {
      body = <p className="empty-note">Select something on the page to see its options.</p>
    }
  }
  return (
    <aside className={`side-panel right ${collapsible && collapsed ? 'collapsed' : ''}`} aria-label="Properties">
      <div className="panel-head" onClick={collapsible ? (event) => { if (!event.target.closest('button')) onToggleCollapsed?.() } : undefined}>
        <div><h2>{title}</h2>{(subtitle || (collapsible && collapsed)) && <small>{collapsible && collapsed ? 'Tap to show options' : subtitle}</small>}</div>
        <div style={{ display: 'flex', gap: 2 }}>
          {collapsible && (
            <button type="button" className="icon-btn sm" onClick={onToggleCollapsed} title={collapsed ? 'Show options' : 'Make smaller'} aria-label={collapsed ? 'Show options' : 'Make smaller'}>
              {collapsed ? <FaChevronUp /> : <FaChevronDown />}
            </button>
          )}
          <button type="button" className="icon-btn sm" onClick={onClose} title="Hide panel" aria-label="Hide panel"><FaTimes /></button>
        </div>
      </div>
      <div className="panel-body">
        {body}
        {localFonts.status === 'denied' && (selection?.kind === 'block' || tool === 'text' || selection?.object?.type === 'text') && (
          <p className="notice warning" style={{ marginTop: 12 }}><FaDesktop />Font access is off, so only standard fonts are listed.</p>
        )}
      </div>
    </aside>
  )
}
