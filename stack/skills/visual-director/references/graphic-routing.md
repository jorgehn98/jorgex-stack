# Fixed graphics routing

Use when the deliverable is a non-temporal, non-interactive piece: poster, banner, social thumbnail, illustration, or a static slide. It excludes a full identity system and advanced prepress unless the user explicitly asks.

## Message, eye order and composition

Start from the single message and the order in which the eye should move. Then compose:

- layout and margins by hierarchy and relationship, not uniform scale;
- typography sized to the real content, with a legible body size, coherent leading and bounded line length;
- imagery chosen for the subject, with deliberate crop and context.

Zero in on the **actual viewing size and distance**. A thumbnail is judged small and short, a poster at larger scale, a slide on the destination screen. Verify readability and that the copy is exact — every character, name and figure. A crop must not remove context that changes the meaning or misleads the reader.

## Recompose, do not rescale

An approved invariant composition is **recomposed** for each aspect ratio and target: rebuild the layout for the new frame instead of scaling or upscaling a single master. Reposition, re-crop and re-balance type and image for each format. Do not call a uniform upscale a new variant.

## Authoring and assets

- Choose **SVG** for crisp vectors, diagrams, line art and text that must stay exact; choose **raster** when photographic texture or detail is the point.
- Confirm rights, fonts, alpha and color profile against the real destination before exporting. A default editor font does not imply a free license, and software licenses do not transfer to produced assets.
- For text, labels or geometry that must be exact, prefer controlled authoring. Authorized generation for UI mockups, labels or geometric shapes is allowed only with real QA of the result; it promises no prompt fidelity and does not authorize deceptive or factually false claims.
- There are no mandatory font bans, palette rules or base-knob defaults, and images are not required. Claims that generation will reproduce exact text or measurements are not made.

## Variants and composition

For a poster or thumbnail, produce compositional crop variants anchored to the approved subject and copy, not a grid of near-identical options. For a slide, decide the chart type from the data and the hierarchy, and review it at the destination size with a real reader in mind. Keep diagram geometry separate from illustration.

## Fixed slide vs interactive

A **fixed** export shows the necessary information without interaction; reading time is not imposed. If the slide must time itself or allow navigation, treat it as an interactive piece with an explicit contract (reading time and navigation stated, nothing essential lost in a static export) and route to [frontend routing](frontend-routing.md) as appropriate.

## Delivery

Export the accepted master with exact copy, correct dimensions, alpha and color for each destination, and the assets' own license verified. Do not enter advanced prepress by default; if the destination requires it, confirm the specific profile, bleed and separation needs first. If a preview at real size or the final render cannot be inspected, record the check as pending.

## Boundaries

This route does not create a new token system, does not declare an accepted final style by itself, and does not impose setup commands. Existing tokens live with their owner; see [design system](design-system.md) and [design record](design-record.md). If the piece moves, its motion is designed separately, not forced onto the static asset.
