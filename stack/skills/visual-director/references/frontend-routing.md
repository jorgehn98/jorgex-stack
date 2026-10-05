# Frontend and interface routing

Use technology according to the visual job. Preserve the existing application stack unless changing it is part of the brief. Cover both the visual journey and the interface states before adding heavy graphics.

## Two speeds: read vs act

Design for two reading speeds: a **read** path that lets a visitor understand without being pushed, and an **act** path with an independent call to action. Do not hijack the reader: motion, autoplay or scroll behavior must not capture control away from someone who is reading. Both paths can share one page; the CTA does not need to interrupt comprehension.

## Narrative and CRO

- Choose the interaction form (state, time, scroll) because it fits the semantic meaning, not because it is available. Scroll-driven storytelling is justified only when scroll genuinely carries the story.
- Distinguish **real product states** from **mockups placed to look real**. A demo can use simulated data, but do not present a fake success state as if it were the product's live result.
- Treat conversion optimization as a **hypothesis with a qualified task and lead metric**, not a guarantee. Scroll depth, time on page or added CSS do not prove conversion by themselves.
- Run the accessibility checks relevant to the change; do not claim whole-suite coverage where none exists, and state factual limits honestly.

## States, focus and fallback

Preserve real, distinct states: loading, empty, no-results, error and success. Keep the recovery action real, not a decorative illustration as the only way out. Keep states semantic and do not mix, for example, "no results" with "loading".

- Preserve keyboard focus: visible focus, logical order, focus return after closing popovers, `Escape` to cancel, no inconsistent tree state.
- Keep the layout stable under reflow down to the declared narrow width; semantic relationships survive even where the reflow does not cover every exception.
- Respect `prefers-reduced-motion` per animation, and verify it in the actual integration rather than assuming it is inherited.
- Provide a fallback when decorative canvas/3D fails, and design for worst-case content lengths and slow loading. Do not announce every state change; announce only meaningful status messages, without focus.
- Navigation and back/forward correctness belong to the project's routing plan, not to a component library.

## Baseline layers and motion routing

- **HTML/React framework layer**: application structure, not the visual direction. For greenfield, choose it by product requirements.
- **CSS**: layout, type, color, responsive behavior, states, simple transitions, masks, gradients, filters, scroll-driven CSS where support allows. Prefer CSS for local effects that need no orchestration. **Tailwind**: use when the project already does; it is not the motion architecture.
- **Motion**: best for React component presence, layout, gesture and state-driven motion. **GSAP**: best for synchronized multi-element choreography, complex timelines, scroll narrative/pinning, SVG masks, and coordinating DOM/Canvas/Three values. **Anime.js, WAAPI and View Transitions**: use native or compact engines when they solve the problem without adding a competing runtime.
- **SVG / Rive / Lottie**: SVG for vectors, diagrams, paths, masks and charts; Rive for interactive state-machine illustration; Lottie to play back an existing After Effects asset, not as the default for code-native animation.
- **D3**: data-to-visual mapping, scales, axes and chart geometry; pair with the scene-timing owner.
- **Canvas / PixiJS**: dense 2D, sprites, particles and filters; keep text and semantic UI in the DOM. **Three.js / R3F** only when 3D is conceptually meaningful; see [3D and shaders](3d-shaders.md).

Keep ownership clear: one engine per property and one primary clock. See [motion graphics](motion-graphics.md) for the motion vocabulary and [design system](design-system.md) for tokens.

## Content and media

Use real or specific content, not lorem. Design for worst-case text lengths, missing images and slow networks; media and 3D load lazily and never block core content. A page that only works with the demo data is not finished.

## Performance and integrity

Before adding heavy graphics: profile first meaningful paint and interaction; lazy-load noncritical 3D/media; cap device pixel ratio where needed; compress textures and models; reduce shadow/postprocessing cost on low-power devices; suspend offscreen render loops. Always preserve a readable, functional experience when decorative graphics fail or are disabled.
