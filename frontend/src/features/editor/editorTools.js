import {
  FaEraser, FaFont, FaHighlighter, FaICursor, FaImage, FaMousePointer, FaPenNib, FaShapes, FaSignature, FaStickyNote,
} from 'react-icons/fa'

export const TOOLS = [
  { id: 'select', label: 'Select', icon: FaMousePointer, key: 'v', hint: 'Select, move and resize added items. Drag across page text to copy it.' },
  { id: 'edit', label: 'Edit PDF', icon: FaICursor, key: 'e', hint: 'Click any PDF text to edit or restyle it. Click an image to move, resize or replace it.' },
  { id: 'text', label: 'Add text', icon: FaFont, key: 't', hint: 'Click on the page where the text should start.' },
  { id: 'image', label: 'Image', icon: FaImage, key: 'i', hint: 'Choose a picture to place on this page.' },
  { id: 'highlight', label: 'Highlight', icon: FaHighlighter, key: 'h', hint: 'Select text to mark it, or drag a box over any area.' },
  { id: 'draw', label: 'Draw', icon: FaPenNib, key: 'p', hint: 'Draw freehand with a mouse, pen or finger.' },
  { id: 'shape', label: 'Shapes', icon: FaShapes, key: 'r', hint: 'Drag on the page to draw the shape.' },
  { id: 'note', label: 'Comment', icon: FaStickyNote, key: 'n', hint: 'Click where the comment should be pinned.' },
  { id: 'signature', label: 'Sign', icon: FaSignature, key: 's', hint: 'Click where your signature should go.' },
  { id: 'whiteout', label: 'Whiteout', icon: FaEraser, key: 'w', hint: 'Drag over content to cover it with a white box.' },
]

export const TOOL_BY_ID = new Map(TOOLS.map((tool) => [tool.id, tool]))

/** Tools that create objects by pointing at the page. */
export const CREATION_TOOLS = new Set(['text', 'draw', 'shape', 'note', 'signature', 'whiteout'])
