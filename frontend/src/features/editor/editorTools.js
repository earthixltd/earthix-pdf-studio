import {
  FaEraser, FaFont, FaHighlighter, FaICursor, FaImage, FaMousePointer, FaPenNib, FaShapes, FaSignature, FaStickyNote,
} from 'react-icons/fa'

export const TOOLS = [
  { id: 'select', label: 'Select', icon: FaMousePointer, key: 'v', hint: 'Move and resize what you added.' },
  { id: 'edit', label: 'Edit PDF', icon: FaICursor, key: 'e', hint: 'Click text or an image to change it.' },
  { id: 'text', label: 'Add text', icon: FaFont, key: 't', hint: 'Click where you want to type.' },
  { id: 'image', label: 'Image', icon: FaImage, key: 'i', hint: 'Pick a picture to add.' },
  { id: 'highlight', label: 'Highlight', icon: FaHighlighter, key: 'h', hint: 'Select text to highlight it.' },
  { id: 'draw', label: 'Draw', icon: FaPenNib, key: 'p', hint: 'Draw anywhere on the page.' },
  { id: 'shape', label: 'Shapes', icon: FaShapes, key: 'r', hint: 'Drag to draw a shape.' },
  { id: 'note', label: 'Comment', icon: FaStickyNote, key: 'n', hint: 'Click to pin a comment.' },
  { id: 'signature', label: 'Sign', icon: FaSignature, key: 's', hint: 'Click where you want to sign.' },
  { id: 'whiteout', label: 'Whiteout', icon: FaEraser, key: 'w', hint: 'Drag over what you want to hide.' },
]

export const TOOL_BY_ID = new Map(TOOLS.map((tool) => [tool.id, tool]))

/** Tools that create objects by pointing at the page. */
export const CREATION_TOOLS = new Set(['text', 'draw', 'shape', 'note', 'signature', 'whiteout'])
