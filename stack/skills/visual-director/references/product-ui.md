# Product UI

Read for screens people work in: dashboards, admin and analytics views, settings, inboxes, queues, editors. For a marketing page that shows its product, the page follows [web craft](web-craft.md) and each fragment's insides follow this file.

Reuse the product's existing components and tokens first; a new pattern needs a reason the current ones cannot meet. Brand wins over every number here. The values come from 23 real product screens from 17 products, desktop only and chosen by one author; mobile, loading and error guidance is judgement, not measurement. Use them as starting points.

In blind model-judged tests, quiet clean screens lost to richer ones. Their first screen was thin, the product had no name, restraint hid meaning (two metrics in the same grey), there was nothing to do, and rows were uneven. Quiet is the starting point, not the goal; what fills the gap is the product itself.

## Before drawing

- **Inventory in 8-12 lines:** objects and fields with units, realistic magnitudes (a new account has 1, 6 or 9 things), people and how often they come, the jobs (the most frequent first), and what belongs to this product (name, brand, scope, recognizable objects).
- **One data file** renders everything, with totals computed from the rows and assertions for what must add up.
- **Data truth:** a fact shown twice is one variable; totals and deltas are computed from the parts shown; every relative figure names its base ("vs a typical Monday"). If a legend must explain which bar is which, encode it in the chart.

## One question per screen

- Name the screen's question and its finding, the fact of today that most needs attention. The largest thing answers the question. Put the finding under the title beside the action that resolves it: in tests, a finding in a 14 px footnote made the whole screen read flat.
- List blocks as answers to the next questions, and delete a block with no question.
- At 1440×900, everything the brief names shows its header and first rows: lists of 4-6 rows with "View all", urgent items before long tables. A chart that is flat most of the time does not earn full width.
- The most frequent job is one click away. Evidence sits beside the answer, such as the peak annotated with its cause.

## Shell

Measured archetypes: open plan with a labelled sidebar on the ground (5 screens); a tinted frame with an inset white sheet, radius 10-16 and no shadow (8); a T with 1 px rules (4); a 50-60 px icon rail (3); no sidebar with a centred column of 1088-1208 px (3).

- Labelled sidebar: 210-292 px, rows of 32 px, icons 14-20 px, labels 14 px regular. Active state: a neutral grey pill, or only brightness on dark. No light screen in the study used a dark or saturated sidebar.
- A top bar only if it holds something real. A floating button only if it is the main action and covers nothing.
- Name the product in the shell, with brand and scope: a screen that could belong to anything looks like a template.
- Counters only on queues that ask for action, with a clear noun. Navigation items reach other screens, never anchors in the current one.

## Canvas and title

- One gutter, horizontal and vertical. Mixed gaps were flagged in 8 of 23 screens. One left edge and one right edge, and write out the grid arithmetic so it closes.
- The commonest failure (10 of 23) is a grid that does not fit the data, such as four KPIs in three columns. Choose columns from the number of items.
- Cards in a row share a bottom edge. Only an action or a total may stick to the foot of a stretched card.
- `h1` is a noun (the object's name) at 18-32 px, not a greeting with an emoji. A grey second line about the data is fine. One primary action per screen; a date range at page or card level, never both.

## KPIs

No card of their own: a container divided by 1 px rules, or bare text. Label above value. Values 16-40 px with nothing at 48 or more; labels 12-16 px in sentence case. The figure that answers the question is 30-36 px and at least 1.3× its siblings.

A delta is optional, no larger than the label, with its window in words. Colour means good or bad, not up or down, since rising latency is bad. A zero or undefined delta stays grey ("+4 (new)"), never a green "+0" or ">999%". A KPI acting as a tab is not greyed out, which reads as disabled.

## Charts

- Shape from the question: line for time, columns for quantity per period, sorted bar list for ranking, a thin ring of up to 5 parts for proportion when not already listed beside it. With few numbers, no chart.
- One series per chart, 3 at most per screen. 3-5 horizontal gridlines, the baseline strongest. 4-7 round y ticks, zero as the bar base, 4-8 flat x labels.
- Straight 1-3 px lines, since smoothing invents values. Markers only on hover.
- One hue on one datum: the screen's main one, such as today. A screen all in ink read as a kit. At most 4 colours per screen, the same subject the same colour.
- Annotate the event that matters. Forecasts are dashed with a final value. Short or empty histories are drawn honestly.

## Tables and lists

- One-line rows of 36-53 px, two-line rows of 56-92 px. Header at 11-14 px in grey sentence case. No zebra (0 of 23).
- Figures right-aligned with `tabular-nums`, fixed decimals per metric, a sign on every change. Check that the face really has tabular figures.
- The identity column gets the width (a third to a half), never the truncated one. Shorten names editorially.
- Primary ink only for identity and the key figure. Missing data is a grey dash; a real zero is printed.
- One status marker per row: a pale pill with dark text of the same hue, never compressed. Saturated fill only for the one rare call to action.
- No pagination on overviews: limit rows and offer "View all" with the total. A full list screen shows the total, a fixed header and "1-50 of 1,284".
- Row actions sit in a fixed last column in ink, never faded grey.

## Forms and settings

- Label above the field, no floating labels and no placeholder as label. One input height per context: 38-40 px in forms, 28-40 in filters. Spacing of about 24 px from description to first label and 16 px between fields.
- Disabled stays legible and says why.
- Settings: label and panel columns separated by rules. Each area opens its own view with its name as `h1`; a long page of anchors was penalized.
- One save model per view, never mixed. Show the setting's result with a preview. Destructive actions come last, with the consequence in words and a confirmation naming the object.

## Type, colour and density

- Usually one grotesk; a second face has one job. Title 18-32 px, body and cells 13-16 (median 14), meta 11-14, pills at 11 or more. About six sizes in a clean scale such as 12/14/18/24. Sentence case.
- Three text levels, all at 4.5:1 including placeholders. Dark grounds: a neutral near-black with surfaces separated by a lightness step or a 1 px line.
- A border or a shadow, not both; shadows only on what floats. Radii bimodal (4-8 hard, 16-24 soft), scaling down when nested, three at most on panels. Outline icons at 14-20 px in grey, no box.
- Density is three settings that move together: row step, padding and type size. Placed space is calm; leftover space is unfinished (a grid that does not fit, an empty column in every row, a card stretched to match its neighbour). Design for the data the account has today, not the one it wants.

## States

These extend the state coverage in [frontend routing](frontend-routing.md).

- Counts and sublines follow the filtered view.
- An empty section keeps its frame and header, with one sentence spanning the block. First use shows the frame, the title and the first action where the data will be.
- Red is a signal, not a texture: one red mark per object.
- Loading: the final layout with each value as a flat grey bar at its real size, labels visible, no shimmer and no shift. Refresh keeps the previous values and updates a freshness mark.
- Error: inside the failing block, one sentence with what failed and when it was last good, and a retry.

## Phone

The navigation folds (a 48 px bar with a menu, or a bottom bar of 4-5 destinations). Margins of 16-20 px, targets of 44 px or more, data at 14 px. KPIs in two columns or a label-value list; an odd one spans the width. Charts run full width at 160-200 px. Under about 640 px, tables become two-line row lists, with fields moved and not removed; a table that must stay scrolls inside itself with a fixed first column, and the page never scrolls sideways. Blocks carrying actions move up. Design a tablet band of its own.

## Tells of a generated dashboard

Prompts to justify, as in [good design](good-design.md): a navy sidebar with a coloured pill; "Welcome back" with an emoji; four KPIs with icons in tinted circles; a green "+12.5%" on everything; a sparkline in every KPI; a smoothed area chart with a dot per datum; rainbow series; a fat donut with labels on the slices; cards with large radius, border and big shadow; zebra tables with all-caps headers and checkbox, avatar, chip and kebab in every row; saturated chips with white text; the accent on every button, tab and link; search, bell and avatar on every top bar; export, share and date picker crowded beside the title; placeholder people and companies; pagination under a short list; an equal grid of four whatever the data; a default kit of a neutral sans on light grey with white 12 px cards.

Without tells and without substance you get a tidy template. Give the product a face from its own world: words of its trade in labels and empty states, one element only this product has, and the brand colour on the main datum.
