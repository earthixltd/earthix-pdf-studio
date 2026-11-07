# Earthix UI Primitives

Reusable, accessible UI foundations. Import from `@/components/ui` after the project configures an alias, or use relative imports today:

```jsx
import { Badge, Button, Input, Panel } from './components/ui/index.js'
```

## Components

- `Button`: primary, secondary, outline, ghost, danger variants; sm/md/lg sizes; loading and icon slots.
- `IconButton`: icon-only action with a required accessible `ariaLabel`.
- `Input`: label, hint, error, required, disabled, leading icon and trailing slot.
- `Badge`: neutral, brand, success, warning, danger, info variants and optional dot.
- `Tooltip`: hover/focus tooltip, positioned top/right/bottom/left.
- `Dropdown`: accessible action menu with click-away, Escape and arrow-key navigation.
- `Modal`: portal dialog with Escape, focus trap, body scroll lock and optional footer.
- `Divider`: horizontal, vertical or labeled separator.
- `Panel`: semantic section with title, description, actions, body and footer.
- `Loading`: accessible inline status with reduced-motion support.

All styles live in `ui.css` and use the `ex-` namespace to avoid collisions with legacy editor CSS.

## Examples

```jsx
<Button variant="primary" leftIcon={<SaveIcon />} onClick={save}>Save</Button>
<IconButton icon={<CloseIcon />} ariaLabel="Close panel" onClick={close} />
<Input label="Document name" placeholder="Untitled.pdf" error={error} />
<Badge variant="success" dot>Saved</Badge>
<Dropdown label="More actions" items={[{ label: 'Rename', onSelect: rename }]} />
<Modal open={open} onClose={close} title="Rename document">...</Modal>
<Panel title="Document properties" description="Details for the current file">...</Panel>
<Loading label="Preparing document" />
```
