# Earthix Design System

## Brand

- Primary brand: Earthix teal `#317d90` (buttons use `#368497` to `#2d7587`)
- Hover: `#2a6c7e`
- Light theme only, no shadows; separate areas with `#e4e9ee` borders
- Surface: `#ffffff`
- Workspace: `#f6f8fa`

## Typography

- UI, body and headings: Inter
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
