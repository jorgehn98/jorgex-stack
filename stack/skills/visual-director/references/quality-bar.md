# Quality bar

Use this to evaluate a direction, prototype or deliverable against its brief. A piece does not pass merely because it is technically correct.

## Review a representative sample

Before inspecting, choose the sample that can expose the concept's important risks, and reuse valid existing evidence instead of repeatedly reviewing unchanged areas.

- **Web**: the defining viewport and interaction, relevant narrow and wide layouts, realistic content lengths, and reduced-motion behavior where motion matters.
- **Video**: full playback plus representative frames around important beats, transitions and text, **with audio when present**.
- **Fixed graphic**: the piece at its real viewing size and in its destination context.
- **3D**: the defining view/interaction, realistic target-device conditions, and the fallback when nonessential graphics fail.

Collect related findings in one pass, prioritize what compromises the brief, and correct as a coherent batch; then re-check only the changed areas and affected dependencies. There is no fixed review count: new material defects require another check, while unbounded cosmetic polishing is not a completion criterion. Record what was inspected, the finding and the remaining limit in the existing delivery/checkpoint — not in another review panel, backlog or ledger.

## Two axes

Review both the **creative** axis (direction, coherence, hierarchy, rhythm, legibility, emotion) and the **technical** axis (viability, performance, accessibility, compatibility, export, cost). Either can pass while the other fails. Do not self-congratulate: report evidence, not opinions about your own work.

## Common checks

- **Specificity**: does the design clearly belong to this subject and pass the competitor test in [good design](good-design.md)? Are palette, type, material and motion traceable to the brief?
- **Hierarchy**: is the primary message obvious, one focal point at a time, with quieter secondary information and motion that reinforces rather than competes? One entry dominates, with at least two of scale, weight, space, tracking and alignment pushing the same way. The failures are flat hierarchy (everything similar, such as a ladder of near-identical weights or uniform spacing) and noisy hierarchy (many things competing).
- **Typography**: are typefaces intentional and licensed for the use, are weights/widths/line-heights coherent, is body copy readable at real size, and is display type doing useful work?
- **Color**: is the palette role-based, is contrast sufficient for UI and captions, do accents stay meaningful, and does it survive imagery/video/3D backgrounds?
- **Motion**: can each major animation justify its purpose, is there a consistent vocabulary, enough stillness, and are the biggest motion moments attached to the biggest content moments?
- **Restraint**: when an effect looks unnecessary, compare with and without it; remove it only if clarity or coherence improves — do not strip intentional ambition to satisfy the pass.
- **Stack sanity**: state each library's job in one sentence; if two tools share a job, simplify unless there is a clear reason.

## Look at the render

Judge the picture, not the code: you wrote the code, so you will read your intentions into it. If a problem is visible in the render, it is real. Make each look separately, skip those the medium does not need, and check the [generic tells](good-design.md) as part of it.

1. **One second, then five.** Glance away: what did you see? There should be one answer, not "a website". Then as a stranger: what is this, who is it for, what do I do next?
2. **Squint.** The piece should reduce to two or three large masses with clear size differences. Many similar small masses mean nothing leads.
3. **Cover the logo.** Could this belong to a competitor or another industry? Does the idea reach the end, or turn into stock blocks?
4. **Edges.** Count the distinct left edges of text. Two or three reused on purpose is composed; six means things were placed one at a time.
5. **Space.** Are related things close and unrelated far? Is each gap a rest or a [hole](good-design.md)? Do the margins match?
6. **Type.** Is the jump from body to headline decisive? Are there too many close sizes, orphan words, bad line breaks, display tracking so tight the letters touch, or headings nearly as large as the hero?
7. **Colour.** Name the proportions. An accent in ten places means nothing.
8. **Images.** Is each doing a job? Do the crops and light belong together, or is it a stock mix?
9. **Sameness.** Write one word for each section or scene's layout. The same word three times is the template showing.
10. **Narrow viewport.** Is it a composition of its own, or the wide one squeezed?
11. **Fullness.** Is each screen or frame composed, or could it pass for an unfinished wireframe? A single motif filling the screen with nothing to read is also a hole.
12. **Substance.** Is everything the brief asked for delivered completely and at a readable size?
13. **Collisions.** Does anything cover a headline, statement or button at any scroll position or timestamp?

**Name findings as a designer would to a colleague:** "the supporting paragraph starts 40 px left of the headline's edge", "this is the third split in a row". "Could be more polished" is not a finding. Write each round in the same shape so rounds compare: what you saw in one second, the idea in one sentence, layout words by section, and the top three problems with where each shows and its fix.

**Fix in this order; later items cannot rescue earlier ones:** idea, hierarchy, composition, typography, imagery, colour, detail, motion. When removing something leaves a gap, close it, enlarge what remains or let a picture or field of colour take it, rather than refilling it with an ornament.

## Web checks

Responsive from narrow mobile to the intended desktop range; visible keyboard focus; reduced-motion behavior designed; intentional loading states; no content inaccessible because Canvas/WebGL fails; animation does not destroy scroll/input responsiveness; 3D/media lazy-loads; text reflow and real data lengths do not break the composition; key breakpoints visually inspected where tooling allows.

Objective defects to look for at about 1440, 768 and 390 px, on the production build rather than only a dev server (minifiers change what ships):

| Defect | How to find it |
| --- | --- |
| Horizontal scroll | Drag sideways or see a bar; find the element wider than the viewport |
| Broken image; clip without a poster | Every picture loads; no empty box before playback |
| Covered text | Large text hidden by another element at any scroll position, above all with pins and fixed navigation |
| Clipped text | Ascenders or descenders cut by their box, often from tight leading or line masks |
| Contrast | Body 4.5:1, large text 3:1, on flat ground; over photos or video, check each frame |
| Text too small | Reading text under about 13 px (11 px in dense product UI); body well under 16 px |
| Empty first paint | The headline is not legible in about the first second; a preloader or gate |
| Blank band | A stretch with nothing in it over about half a screen; a reveal that never fired, also checked under reduced motion |
| Unequal frame | Left and right margins differ; header on another inset; text within about 16 px of the edge (12 px on a phone) |
| Empty half | A text section leaving one half or the middle third with nothing |
| No title | No visible `h1` on the first screen, several `h1`, or a bare name that never says what this is; a text section with no heading |
| No focal point | First screen with neither a large headline nor a picture holding about a third of it |
| Sliver overflow | A display line starting on the margin and overrunning the far edge by a few pixels |
| Font not loaded | Declared family rendering in its fallback, so the screenshots are not the design |
| Long pin | The same large text held for three screens or more |

## Video checks

First seconds establish interest quickly enough for the platform; every scene has one primary idea; on-screen copy stays readable for its duration; motion and voiceover do not compete; cuts have rhythm and motivation; the mix supports rather than masks speech; the end card/CTA holds long enough; the message survives with sound off where the destination autoplays muted; a loop joins without a visible hitch; no accidental blank or duplicate frames; a deterministic re-render is stable; codec/container/resolution/fps are correct; compression does not destroy fine lines, gradients or text. For programmatic video, also: measure frame-to-frame change to catch stretches that look animated but are static; export a contact sheet around each transition at the full frame rate; sample overflow, clipping and text contrast at several timestamps rather than one; and for chained clips compare the last frame of one with the first of the next to check the seam.

## Fixed-graphic checks

For explanatory figures, also check two readings (one clear object at 1x, something true to find when zoomed) and that every number shown comes from the model that moves the parts; see [explanatory figures](explanatory-figures.md). Message and eye order are clear; copy is exact; the crop preserves meaning; the piece reads at the actual size; dimensions, alpha and color suit the destination; fonts and assets are licensed.

## 3D checks

Camera/lens intentional; lighting and materials support the subject; scale and framing communicate it clearly; no default orbit/spin unless appropriate; geometry/texture/postprocessing cost fits the target; a fallback exists when 3D is nonessential.
