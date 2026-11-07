# Earthix Design System

## Brand

- Primary brand: Earthix violet `#6335df`
- Dark brand: `#5128bd`
- Neutral system: cool slate neutrals from `#f8f9fc` to `#1b2435`
- Surface: `#ffffff`
- Workspace: `#f3f5fa`

## Typography

- UI/body: DM Sans
- Display/editorial headings: DM Serif Display
- Brand and dense UI labels: Manrope
- All fonts have local system fallbacks.

## Breakpoints

- `md`: 48rem
- `lg`: 64rem
- Tailwind's other default breakpoint tokens are disabled for this project.

## Spacing

CSS spacing tokens use a 4px base unit (`--space-1` through `--space-16`). Use Tailwind spacing utilities or the semantic CSS variables instead of introducing arbitrary values.

## Surfaces and controls

- Panels use subtle borders and white surfaces.
- Shadows are not part of the default surface system.
- Inputs and buttons inherit the UI font.
- Keyboard focus uses a visible violet outline.
- Reduced-motion preferences are respected.

## Reusable classes

- `.container`: centered page container with responsive gutters.
- `.font-display` / `.page-title`: display-serif typography.
- `.section-title`: compact Manrope section heading.
- `.body-copy` / `.caption-copy`: semantic text styles.
- `.surface-panel`: bordered panel surface.
- `.control-focus`: keyboard focus treatment.

## Existing editor compatibility

`studio.css` maps the legacy v7 variables (`--earthix`, `--line`, `--canvas`, etc.) to the shared semantic tokens. This keeps the current editor layout stable while newly developed components use the central design system.
