import { memo } from 'react'
import { cssFontFamily, isStandardFamily, textWeight } from '../../engine/page-objects/textLayout.js'
import { arrowHeadSegments, arrowShaftEnd, ellipseSegments, rectSegments, segmentsToSvg, strokeSegments } from '../../engine/page-objects/shapePaths.js'
import { layoutTextObject } from './textMeasure.js'
import { imageUrlFor } from './imageImport.js'
import { isLineShape } from './objectFactory.js'

const NOTE_ICON = 'M3 1.5 L17 1.5 C18.2 1.5 19 2.3 19 3.5 L19 12.5 C19 13.7 18.2 14.5 17 14.5 L9 14.5 L5 18.5 L6 14.5 L3 14.5 C1.8 14.5 1 13.7 1 12.5 L1 3.5 C1 2.3 1.8 1.5 3 1.5 Z'

function darken(hex, amount = 0.55) {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex || '')
  if (!match) return '#333333'
  const value = parseInt(match[1], 16)
  const channel = (shift) => Math.round(((value >> shift) & 255) * amount).toString(16).padStart(2, '0')
  return `#${channel(16)}${channel(8)}${channel(0)}`
}

const boxTransform = (object, width = object.width, height = object.height) => (
  `translate(${object.x} ${object.y})${object.rotation ? ` rotate(${object.rotation} ${width / 2} ${height / 2})` : ''}`
)

function TextShape({ object, hideText }) {
  const layout = layoutTextObject(object)
  const size = object.fontSize || 12
  const lineWidth = Math.max(0.5, size * 0.055)
  return (
    <g transform={boxTransform(object, layout.width, layout.height)}>
      {object.backgroundColor && <rect width={layout.width} height={layout.height} fill={object.backgroundColor} />}
      {object.borderColor && object.borderWidth > 0 && (
        <rect x={object.borderWidth / 2} y={object.borderWidth / 2} width={Math.max(0, layout.width - object.borderWidth)} height={Math.max(0, layout.height - object.borderWidth)} fill="none" stroke={object.borderColor} strokeWidth={object.borderWidth} />
      )}
      {!hideText && layout.lines.map((line, index) => (
        <g key={index}>
          <text
            x={line.x}
            y={line.baseline}
            fill={object.color || '#000000'}
            style={{
              fontFamily: cssFontFamily(object.fontFamily),
              fontWeight: textWeight(object),
              fontStyle: object.italic ? 'italic' : 'normal',
              fontSize: `${size}px`,
              whiteSpace: 'pre',
              fontKerning: isStandardFamily(object.fontFamily) ? 'none' : 'auto',
              textRendering: 'geometricPrecision',
            }}
          >{line.text}</text>
          {object.underline && line.text.trim() && <rect x={line.x} y={line.baseline + size * 0.1} width={line.width} height={lineWidth} fill={object.color} />}
          {object.strike && line.text.trim() && <rect x={line.x} y={line.baseline - size * 0.3} width={line.width} height={lineWidth} fill={object.color} />}
        </g>
      ))}
      <rect className="object-hit" width={layout.width} height={layout.height} />
    </g>
  )
}

function ShapeBox({ object }) {
  const strokeWidth = Math.max(0, object.strokeWidth ?? 2)
  const stroke = strokeWidth > 0 && object.strokeColor ? object.strokeColor : 'none'
  const inset = stroke !== 'none' ? strokeWidth / 2 : 0
  const width = Math.max(0, object.width - inset * 2)
  const height = Math.max(0, object.height - inset * 2)
  const segments = object.shape === 'ellipse'
    ? ellipseSegments(object.width / 2, object.height / 2, width / 2, height / 2)
    : rectSegments(inset, inset, width, height)
  return (
    <g transform={boxTransform(object)}>
      <path
        d={segmentsToSvg(segments)}
        fill={object.fillColor || 'none'}
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        strokeDasharray={object.dashed && stroke !== 'none' ? `${strokeWidth * 3} ${strokeWidth * 2}` : undefined}
      />
      <rect className="object-hit" width={object.width} height={object.height} />
    </g>
  )
}

function LineShape({ object }) {
  const [from, to] = object.points || []
  if (!from || !to) return null
  const strokeWidth = Math.max(0.5, object.strokeWidth ?? 2)
  const end = object.shape === 'arrow' ? arrowShaftEnd(from, to, strokeWidth) : to
  const color = object.strokeColor || '#000000'
  return (
    <g>
      <line x1={from.x} y1={from.y} x2={end.x} y2={end.y} stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeDasharray={object.dashed ? `${strokeWidth * 3} ${strokeWidth * 2}` : undefined} />
      {object.shape === 'arrow' && <path d={segmentsToSvg(arrowHeadSegments(from, to, strokeWidth))} fill={color} />}
      <line className="object-hit-stroke" x1={from.x} y1={from.y} x2={to.x} y2={to.y} strokeWidth={Math.max(12, strokeWidth + 10)} />
    </g>
  )
}

function InkShape({ object }) {
  const width = object.strokeWidth ?? 2
  return (
    <g>
      {(object.strokes || []).map((stroke, index) => (
        <path key={index} d={segmentsToSvg(strokeSegments(stroke))} fill="none" stroke={object.color || '#000000'} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" />
      ))}
      {(object.strokes || []).map((stroke, index) => (
        <path key={`hit-${index}`} className="object-hit-stroke" d={segmentsToSvg(strokeSegments(stroke))} strokeWidth={Math.max(12, width + 10)} />
      ))}
    </g>
  )
}

function HighlightShape({ object }) {
  const color = object.color || '#FFE066'
  const kind = object.kind || 'highlight'
  const opacity = Number.isFinite(object.opacity) ? object.opacity : kind === 'highlight' ? 0.45 : 1
  return (
    <g style={kind === 'highlight' ? { mixBlendMode: 'multiply' } : undefined} opacity={opacity}>
      {(object.rects || []).map((rect, index) => {
        if (kind === 'underline') return <rect key={index} x={rect.x} y={rect.y + rect.height * 0.9} width={rect.width} height={Math.max(0.6, rect.height * 0.08)} fill={color} />
        if (kind === 'strikeout') return <rect key={index} x={rect.x} y={rect.y + rect.height * 0.52} width={rect.width} height={Math.max(0.6, rect.height * 0.08)} fill={color} />
        return <rect key={index} x={rect.x} y={rect.y} width={rect.width} height={rect.height} fill={color} />
      })}
      {(object.rects || []).map((rect, index) => <rect key={`hit-${index}`} className="object-hit" x={rect.x} y={rect.y} width={rect.width} height={rect.height} />)}
    </g>
  )
}

function NoteShape({ object }) {
  const color = object.color || '#FDB022'
  const dark = darken(color)
  return (
    <g transform={`translate(${object.x} ${object.y})`} className="note-icon">
      <path d={NOTE_ICON} fill={color} stroke={dark} strokeWidth="1" strokeLinejoin="round" />
      <rect x="4.5" y="4.3" width="11" height="1.2" fill={dark} />
      <rect x="4.5" y="7.3" width="11" height="1.2" fill={dark} />
      <rect x="4.5" y="10.3" width="7" height="1.2" fill={dark} />
      <rect className="object-hit" width="20" height="20" />
    </g>
  )
}

function ImageShape({ object }) {
  return (
    <g transform={boxTransform(object)}>
      <image href={imageUrlFor(object)} width={object.width} height={object.height} preserveAspectRatio="none" />
      <rect className="object-hit" width={object.width} height={object.height} />
    </g>
  )
}

function ObjectShape({ object, hideText }) {
  switch (object.type) {
    case 'text': return <TextShape object={object} hideText={hideText} />
    case 'image': return <ImageShape object={object} />
    case 'shape': return isLineShape(object) ? <LineShape object={object} /> : <ShapeBox object={object} />
    case 'ink': return <InkShape object={object} />
    case 'highlight': return <HighlightShape object={object} />
    case 'note': return <NoteShape object={object} />
    default: return null
  }
}

export const ObjectView = memo(function ObjectView({ object, interactive, hideText = false, onPointerDown, onDoubleClick, title }) {
  const opacity = object.type === 'highlight' ? 1 : (Number.isFinite(object.opacity) ? object.opacity : 1)
  return (
    <g
      className={`object-node ${interactive ? 'is-interactive' : ''}`}
      data-object-id={object.id}
      opacity={opacity}
      onPointerDown={interactive ? (event) => onPointerDown?.(event, object) : undefined}
      onDoubleClick={interactive ? (event) => onDoubleClick?.(event, object) : undefined}
    >
      {title && <title>{title}</title>}
      <ObjectShape object={object} hideText={hideText} />
    </g>
  )
})
