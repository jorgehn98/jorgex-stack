# Palette, typography, layout and motion system

Use this when the user has no locked brand system or when an existing system must be translated into motion, video or fixed graphics.

Dose expression by type. A marketing page or campaign can carry a strong voice and a defining moment; a product UI needs a restrained, consistent system where density, legibility and component states come first (see [frontend routing](frontend-routing.md)). The guidance below on voice, alignment bias and signature motion applies in full to the first and in reduced form to the second, whose specifics live in [product UI](product-ui.md).

## Palette: start from meaning, build roles

Choose color from the subject and desired perception, not a generic moodboard. Identify dominant material/world (paper, glass, metal, plastic, fabric, light, nature, UI), temperature, energy, trust level and content type.

Build a compact system by role instead of a pile of hex values: `background`, `surface`, `text-primary`, `text-muted`, `accent-primary`, optional `accent-secondary`. Add semantic success/warning/error/info only when the interface needs them. Do not add accents merely because the palette feels empty.

Prefer perceptual consistency (for example OKLCH ramps) so lightness and chroma are easier to reason about, then export to what the target environment requires. Test real combinations: text/background contrast, overlays on imagery or video, hover/focus states, dark/light scenes and compression effects, not isolated swatches.

Spend the accent like a budget: neutrals carry most of the surface and the accent appears in about two visible places per screen. Pure black and pure white as the only extremes read as undesigned; tint neutrals toward the brand hue, and in dark themes prefer solid borders over translucent ones.

A ground usually holds 70-90% of the surface and the accent under about 5% of any screen. Once it appears in five places it no longer means "here".

- **Surfaces:** a small lightness step separates a panel; if it does not read, try more padding before a second tone. Do not nest panels.
- **Fields of colour:** when a section takes a whole field, meet its neighbour with a hard edge, give it its own assigned ink, and let neighbours differ in lightness as well as hue or the page vibrates. Order them like chapters.
- **Dark themes:** a tinted dark ground with a soft ink, and depth from surface steps rather than glow. Check muted text at 4.5:1, where dark pages usually fail. Light text on dark looks heavier, so drop a weight or open the leading.
- **Contrast:** 4.5:1 for body, 3:1 for display and large figures. Recalculate when lowering text opacity. Hover and focus raise contrast, never lower it.

## Typography: choose the role first

Decide what the type must communicate (precision, warmth, editorial authority, speed, luxury, playfulness, technical rigor, cinematic scale), then choose typefaces. Use one family when its range covers the system, or two when contrast between roles helps; avoid pairing two families doing the same job.

Specify actual behavior: family, role, optical size if relevant, weight range, width usage, line-height, letter-spacing, casing, alignment and responsive scaling. For variable fonts use only the axes the design needs. Plan fallback metrics and `font-display`; avoid unnecessary weights and files; consider privacy and performance of hosted fonts.

Starting numbers, which a brand system overrides:

- **Scale:** on expressive work, two or three sizes do the visible work and five is a sensible ceiling, far apart rather than a graded ladder; display at about four times the body or more on desktop. Product UI needs more steps (about six). No more than three sizes above the fold. If two sizes look alike, make them the same.
- **Text:** lines of about 45-75 characters, leading of about 1.45-1.6, no justified body text on the web, no centred paragraph over three lines. Secondary text is the same face in a softer ink, not thinner or under about 13 px.
- **Display:** tracking tighter as the size grows (about -0.02 to -0.05 em) and leading of about 0.85-1.05. All caps take about +0.06 to +0.1 em at text size and 0 to +0.03 em at display size.

Hierarchy comes from several vectors working together (scale, weight, space, tracking, alignment), not from size alone. Web typesetting details are in [web craft](web-craft.md).

## Layout, shape and material

Define maximum content width, primary grid, alignment bias, spacing rhythm, section density, small-screen edge behavior and overlap rules. Do not center everything by default: alignment is part of the voice.

Choose deliberately: corner radii (none/small/medium/organic/mixed by hierarchy), borders (semantic vs decorative), shadows (none/physical/soft/hard), depth (flat/layered/spatial), surfaces (opaque/translucent/textured/photographic) and line style. One radius on every element usually weakens hierarchy.

## Motion tokens

Define a small vocabulary instead of inventing every animation: `micro` (state feedback), `ui` (panels, menus, reorders), `reveal` (content/scene entrance), `hero` (signature moment), `camera` (large spatial movement). For each, define duration range, easing/spring character, distance/scale limits, stagger, blur/opacity policy and whether overshoot is allowed. Do not make every token share one duration and ease. Starting ranges, easing direction and limits are in [motion graphics](motion-graphics.md).

## Extracting a kit from an existing site

When the brand exists only as a live site, derive it by measuring: every value you record must trace to a stylesheet, token, computed style or asset you inspected. Assign the measured colors to roles (background, surface, foreground, muted, border, accent, secondary accent); the most frequent near-white or near-black is usually the background and the most frequent saturated color the accent. Keep several logo candidates and let the user choose. If the typeface is proprietary, record the real family plus the closest available substitute, marked as a stand-in. If an anti-bot wall blocks inspection, stop and ask instead of bypassing it. Record the result as **observed** in the design record.

## Web accessibility

Reduced motion is designed in [motion graphics](motion-graphics.md). Maintain visible keyboard focus, and ensure decorative canvas/3D never makes core content inaccessible.

## Video and fixed-graphic adjustments

Account for viewing distance and phone-size playback, title/action-safe areas when the platform requires them, minimum readable hold time, motion blur and compression, bright or dark footage behind text, and caption contrast. Fixed graphics add actual-size readability, print/alpha/color-space requests when the destination needs them, and self-contained slides where necessary information is visible without interaction.

## Responsive and format adaptation

Define how the system adapts across breakpoints, aspect ratios and output formats rather than only one scene. Avoid over-specifying: a system that pins every value cannot adapt, while one that leaves alignment and density undecided produces drift. State the few rules that must stay constant and where each format may recompose. See [design record](design-record.md) for how changes are tracked.

## Brand precedence

If a supplied brand system conflicts with these defaults, the brand system wins unless the user explicitly asks for a reinterpretation. A working direction is provisional; it does not overwrite an existing kit. Exact values have one owner (code, tokens or the master file); this reference explains intent, it does not duplicate values. See [design record](design-record.md).
