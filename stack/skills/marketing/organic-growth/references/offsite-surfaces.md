# Off-site surfaces

Some of the text an assistant quotes about the brand is never on the site. LinkedIn carries professional and B2B answers; YouTube carries how-to queries. Both are read as text, and both are volatile.

## LinkedIn

Which LinkedIn surface gets cited depends on the engine, and the mix moved during 2026:

| Engine | What it cites (2026 snapshots) |
|---|---|
| ChatGPT | Feed posts; citations of `/pulse/` articles fell while `/posts/` rose between May and October 2026 |
| Perplexity | Articles and company pages, with company pages taking the largest share |
| Copilot | Articles, posts and company pages |
| Google AI Overviews and AI Mode | Posts, articles and company pages |
| Gemini | Almost nothing; do not count on LinkedIn for Gemini |

Practical rules:

- **Publish both.** Feed posts for ChatGPT; long-form articles for Perplexity, Copilot and Google's AI features. Skip collaborative articles.
- **Keep the company page and the person's profile consistent** with the About page: same segment, same category, same proposition.
- **The first words of a post become its slug.** Front-load the phrase a buyer would use.
- **No Unicode bold or italic.** In a study of about 4,000 posts, Unicode formatting was associated with a 58% drop in the post's own citations (Scrunch, 2026; vendor causal model, directional).
- **Publish on the owned site first, then adapt.** LinkedIn sets its own canonical, so a full republish competes with the page it came from. An adapted version, or a summary that links back, keeps the original as the source.
- **Check `noindex` on articles.** It is applied per crawler and the logged-in author does not see it: request the URL as `Googlebot`, `bingbot` and `OAI-SearchBot` and read both the meta robots tag and the `X-Robots-Tag` header.
- **Track per engine, monthly.** LinkedIn's share of answers has moved in opposite directions on different engines in the same months.

## YouTube

Models do not watch the video; they read the text layer. A question-shaped title, corrected captions, chapter titles written as sub-questions, a description that restates the key points, and a pinned comment with the summary and links do more for citation than production value. Say the product and category names out loud: if they only appear on a slide, the transcript may never carry them.

## Why not to concentrate here

Third-party citation mixes change with retrieval updates: a surface can lose most of its citations in a week while another gains. Off-site work is a portfolio, and the owned site is the one surface no platform can drop. Measure these surfaces in `citation-check.md`; a post performing well is not evidence that it will be cited.

Sources: adapted and condensed from Marketing Skills by Corey Haines (MIT, revision 88c79f6): the `ai-seo` references on LinkedIn and YouTube citations, and the studies they cite (Ahrefs, OtterlyAI, Semrush and Scrunch, 2026). All figures are dated vendor snapshots; verify them against your own prompts.
