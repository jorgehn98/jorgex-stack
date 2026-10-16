# Palette, typography, layout and motion system

Use this when the user has no locked brand system or when an existing system must be translated into motion, video or fixed graphics.

Dose expression by type. A marketing page or campaign can carry a strong voice and a defining moment; a product UI needs a restrained, consistent system where density, legibility and component states come first (see [frontend routing](frontend-routing.md)). The guidance below on voice, alignment bias and signature motion applies in full to the first and in reduced form to the second.

## Palette: start from meaning, build roles

Choose color from the subject and desired perception, not a generic moodboard. Identify dominant material/world (paper, glass, metal, plastic, fabric, light, nature, UI), temperature, energy, trust level and content type.

Build a compact system by role instead of a pile of hex values: `background`, `surface`, `text-primary`, `text-muted`, `accent-primary`, optional `accent-secondary`. Add semantic success/warning/error/info only when the interface needs them. Do not add accents merely because the palette feels empty.

Prefer perceptual consistency (for example OKLCH ramps) so lightness and chroma are easier to reason about, then export to what the target environment requires. Test real combinations: text/background contrast, overlays on imagery or video, hover/focus states, dark/light scenes and compression effects, not isolated swatches.

Spend the accent like a budget: neutrals carry most of the surface and the accent appears in about two visible places per screen. Pure black and pure white as the only extremes read as undesigned; tint neutrals toward the brand hue, and in dark themes prefer solid borders over translucent ones.

## Typography: choose the role first

Decide what the type must communicate (precision, warmth, editorial authority, speed, luxury, playfulness, technical rigor, cinematic scale), then choose typefaces. Use one family when its range covers the system, or two when contrast between roles helps; avoid pairing two families doing the same job.

Specify actual behavior: family, role, optical size if relevant, weight range, width usage, line-height, letter-spacing, casing, alignment and responsive scaling. For variable fonts use only the axes the design needs. Plan fallback metrics and `font-display`; avoid unnecessary weights and files; consider privacy and performance of hosted fonts.

Starting numbers, which a brand system overrides: a modular scale of six to eight sizes at most and no more than three sizes above the fold; body lines of about 50-75 characters; tracking of about +0.06 to +0.1 em on all-caps text and slightly negative on large display type; no justified body text on the web. Hierarchy comes from several vectors working together (scale, weight, space, tracking, alignment), not from size alone.

## Layout, shape and material

Define maximum content width, primary grid, alignment bias, spacing rhythm, section density, small-screen edge behavior and overlap rules. Do not center everything by default: alignment is part of the voice.

Choose deliberately: corner radii (none/small/medium/organic/mixed by hierarchy), borders (semantic vs decorative), shadows (none/physical/soft/hard), depth (flat/layered/spatial), surfaces (opaque/translucent/textured/photographic) and line style. One radius on every element usually weakens hierarchy.

## Motion tokens

Define a small vocabulary instead of inventing every animation: `micro` (state feedback), `ui` (panels, menus, reorders), `reveal` (content/scene entrance), `hero` (signature moment), `camera` (large spatial movement). For each, define duration range, easing/spring character, distance/scale limits, stagger, blur/opacity policy and whether overshoot is allowed. Do not make every token share one duration and ease. As starting ranges: `micro` about 100-200 ms, `ui` 200-300 ms, `reveal` 300-500 ms, with `hero` and `camera` longer by design; see [motion graphics](motion-graphics.md) for easing direction and limits.

## Extracting a kit from an existing site

When the brand exists only as a live site, derive it by measuring: every value you record must trace to a stylesheet, token, computed style or asset you inspected. Assign the measured colors to roles (background, surface, foreground, muted, border, accent, secondary accent); the most frequent near-white or near-black is usually the background and the most frequent saturated color the accent. Keep several logo candidates and let the user choose. If the typeface is proprietary, record the real family plus the closest available substitute, marked as a stand-in. If an anti-bot wall blocks inspection, stop and ask instead of bypassing it. Record the result as **observed** in the design record.

## Web accessibility

Respect `prefers-reduced-motion`, replacing nonessential transforms, zoom or parallax with still states or gentler opacity changes. Maintain visible keyboard focus, and ensure decorative canvas/3D never makes core content inaccessible. The reduced version must still look designed, not like broken animations switched off.

## Video and fixed-graphic adjustments

Account for viewing distance and phone-size playback, title/action-safe areas when the platform requires them, minimum readable hold time, motion blur and compression, bright or dark footage behind text, and caption contrast. Fixed graphics add actual-size readability, print/alpha/color-space requests when the destination needs them, and self-contained slides where necessary information is visible without interaction.

## Responsive and format adaptation

Define how the system adapts across breakpoints, aspect ratios and output formats rather than only one scene. Avoid over-specifying: a system that pins every value cannot adapt, while one that leaves alignment and density undecided produces drift. State the few rules that must stay constant and where each format may recompose. See [design record](design-record.md) for how changes are tracked.

## Brand precedence

If a supplied brand system conflicts with these defaults, the brand system wins unless the user explicitly asks for a reinterpretation. A working direction is provisional; it does not overwrite an existing kit. Exact values have one owner (code, tokens or the master file); this reference explains intent, it does not duplicate values. See [design record](design-record.md).
