# STEP 3 — Reusable UI Primitives

## Scope

This step adds reusable, accessible foundations only. It does not refactor the legacy PDF editor toolbar, page thumbnails, or inspector yet.

## Components delivered

| Component | Purpose |
|---|---|
| Button | Common action button variants and sizes |
| IconButton | Accessible icon-only actions |
| Input | Labeled input with helper and error states |
| Badge | Status and category labels |
| Tooltip | Hover/focus contextual help |
| Dropdown | Keyboard-accessible action menu |
| Modal | Accessible dialog with focus trap |
| Divider | Horizontal, vertical and labeled separators |
| Panel | Reusable section surface |
| Loading | Accessible loading indicator |

## Import

```jsx
import { Button, Badge, Input, Modal, Panel } from './components/ui/index.js'
```

## Accessibility notes

- Buttons use explicit native `type="button"` by default.
- IconButton requires `ariaLabel`.
- Input generates stable IDs and wires hint/error text to `aria-describedby`.
- Dropdown supports Escape, arrow keys, Home/End and click-away close.
- Modal uses `role="dialog"`, `aria-modal`, focus trapping, Escape close and focus restoration.
- Loading uses `role="status"` and `aria-live="polite"`.
- Reduced-motion preferences disable decorative transitions and spinners.

## Styling

`frontend/src/components/ui/ui.css` uses the `ex-` class prefix. It consumes tokens from `frontend/src/index.css` and intentionally does not modify legacy `.studio-*` styles.
