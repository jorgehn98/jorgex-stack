# Imagery

Read when deciding which pictures a piece uses, finding them, or placing and treating them. Generating them is in [generative media](generative-media.md); clearing rights is everyone's job before use.

Numbers below come from a gallery study (see [good design](good-design.md) §6): leanings of current fashion, not laws. Brand and brief override them.

## Where pictures come from

Do not plan around pictures you do not have. In order of preference for where a given picture comes from; this does not decide which picture leads, and an idea can make a drawing or a page of type the lead:

1. **The project's own.** Even ordinary photographs of the real thing beat beautiful photographs of something else. When real footage of the product or process exists, lead with it.
2. **Generated**, when a tool is authorized. Brief it like a photographer: subject, angle, light, background, crop, "no text". Make the hero first and match the rest to its light.
3. **Found in open collections**, whenever an honest one exists.
4. **Drawn from the subject**, for what no honest picture exists of.
5. **Honestly generic stock**, only where generic is true (the open sea for a house on the sea), never standing in for a specific product, dish, room, person or screen.
6. **Type and colour alone**, on purpose. This is legitimate: pages with no images scored as well as those with them in a very small sample (7 sites).

## Honesty

A found picture shows the world around the client: its city, materials, history, the kind of thing it makes. It is never presented as the client's own product, room, dish, person or team. A caption says what the picture is; do not add sentences about what it is not.

## Finding pictures of the subject's world

Openverse, Wikimedia Commons, the Art Institute of Chicago, the Met, the Internet Archive and NASA publish searchable material. Search the [subject inventory](good-design.md), not the category:

- Use the place's own words (`azulejo`, not "blue tile") and add a medium or decade: postcard, engraving, old map, lithograph, 1950s.
- Categories that work: the place, maps, materials up close, the history of the trade, museum objects of the kind, scientific plates.
- A good find belongs to this subject, reads at its crop, is at least twice its displayed width, and has no watermark, text or recognizable person.
- Keep to one family: all engravings or all photographs of one period. A mix reads as a scrapbook.

**Licences.** Read each one on the source page. CC0, public domain and CC BY are usable; CC BY-SA requires sharing alike when altered; NC and ND are out for client work. Download rather than hotlink, and record source, author, licence and page for each file. Carry the credit where the licence requires it, small and away from anything suggesting it is the client's.

## Drawing the subject

Draw the subject's own things (the stool's three legs, the enamel sign, the street plan, the invoice the tool produces). If you cannot name what a drawing depicts in the subject's world, it is decoration.

- **Three levels of detail:** big shapes that read at a glance, middle shapes that describe, small details that reward a second look. A drawing that would pass as a placeholder icon at full size is not finished.
- **One graphic language**, in the palette's real colours. Light comes from flat tone steps (a lit face and a shaded face), not gradients.
- Draw large and let the motif return at different scales. Scattered small doodles read as filler.
- If a client could be mistaken for showing real products, say nearby that these are drawings until photographs exist.
- Avoid gradient 3D blobs, isometric clip art and generic people at laptops.

For a drawn object that explains a concept, see [explanatory figures](explanatory-figures.md).

## Placement and crop

- **A picture leads its screen or stays small.** Screens tend to be all or nothing: 42% had no image, 19% were 90% or more image, and only 19% sat between 20% and 60%. A leading image takes about 60% or more of its screen; an accent stays under about 10%. Screens of type alone are the rest between pictures.
- **Few faithful ratios.** Two ratios cover about three quarters of pictures in the study. 4:5 for portraits and 16:9 or 16:10 for landscapes are common defaults.
- Go large and touch edges. A picture floating with equal margins looks placed by default. Set `object-position` per image and re-crop for the phone rather than shrinking.
- One treatment of corners: square (94% in the study) or a single radius. No frames, device mockups or stock shadows.
- Avoid repeating the same split three times, a picture floating mid-half, mosaics of random ratios, and a marquee of things people must read.

Starting geometry for common placements at 1440×900, to be adapted:

| Placement | Geometry |
| --- | --- |
| Split | Image 33-49% of the width at full section height, touching the outer edge; text starts on the 50% line |
| Full-bleed band | 100% wide, 100-150vh; 4-10% oversize for parallax; text in one corner at least 32 px in |
| Growing frame | From 35-50% of the width to full screen over 720-2700 px of scroll, one per page, nothing else moving |
| Uneven mosaic | Two or three widths (about 32/48/65%), offsets of 120-190 px from a small set |
| Sideways gallery | Cards 25-35% wide with a cut fourth; 75-80% on the phone with the next visible. Common everywhere and raises nothing by itself |
| Index with preview | Rows of 45-80 px, names of 30-60 px, swap in about 0.3 s; a thumbnail of about 100 px on the phone |
| Object on a flat field | Object 35-60% of the width |

A 3D gallery was the one layout associated with lower scores and worse usability. Treat it as a cost to justify.

## Treatment

Choose one per piece: untouched; all greyscale; multiply on a light field (which removes a white studio ground); or slightly darkened on a dark page. Colour-washing photos in the brand colour, duotone, blur, fake grain, vignettes and polaroid shadows are effects, not treatments, unless the concept asks for them.

When photographs carry the colour, keep the interface neutral and take its ink from the image's darkest tone. A flat field sampled from the picture (its sky or shadow) anchors a section to it.

## Text over pictures

Only display text goes over a picture: a headline, one line and one action. Body text sits beside or below it. Use a calm area of the image, or a neutral scrim limited to the text (40-55% black, or a fade from 55% to 0 in the lower third). Measure contrast at the text's position, across the whole loop on video.

## Showing software

Show a real fragment built in HTML at real size, cropped to the point (one control, one row), with real labels, figures that add up and one element in a hover or selected state. This is the strongest picture a software page has. Grey bars standing in for text are worse than nothing, and a laptop frame adds little. Build its insides by [product UI](product-ui.md) rules.

## Moving pictures on the web

- A clip of 5-20 s that loops without a visible jump; under 5 MB in a section and 10 MB in a hero; 720p is enough behind type.
- Always a poster (only 31% had one, and empty boxes before playback registered as failures).
- `autoplay muted loop playsinline`, hidden from assistive technology when decorative, paused out of view, showing the poster under reduced motion.
- One moving picture per screen. Nothing important only on hover. A full film goes behind a play button with controls and sound off by default.
