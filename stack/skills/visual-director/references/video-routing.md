# Video and audiovisual routing

Decide the **method** before the runtime. Programmatic generation, recorded/edited footage, 3D and generative media are methods that combine by scene or asset; do not start from a framework name. The visual layers and the orchestration model come after the method is clear.

## Intent, storyboard and frame grammar

Define the piece before animating:

- hook in the first seconds where the platform demands it, then beats/scenes, information density, typography load, visual peak, transition logic, audio relationship and end card/CTA;
- shot framing and camera grammar (lens, POV, movement, cut) as design decisions; a storyboard orients camera and acting and may depart from the board to serve clarity or emotion;
- one primary render clock. Programmatic work ties animation to frame/time, never wall-clock; live capture is valid when the case asks for it, and native capture is not universally wrong.

Avoid "slide 1 / fade / slide 2 / fade" as the default grammar. Think continuous transformations, motivated cuts, camera continuity, graphic matches and rhythm. A good single frame does not prove rhythm, and fps metadata does not prove smoothness.

### Music-led pieces

Build from the approved audio: map relevant phrases and musical changes to meaning, action or abstraction, emotion, focal element and transition. Reuse a motif when it helps recognition; decide how its returns develop rather than treating each lyric as an unrelated illustration. Keep this breakdown in the existing storyboard, not a second mandatory document.

Compose lyrics with the shot: decide when text leads and when it supports, reserve readable space, and allow enough time at the destination size. Character movement, camera and typography need not all peak together or hit every beat. Across scene handoffs, preserve the intended pose, position, lighting, motif and entry/exit relationship. See [audio](audio.md) for master-track and synchronization checks.

## Sub-flow A — Programmatic video

Use when the piece is authored by code or a timeline that must render the same frame deterministically.

- Build visual layers from the layers the piece needs: DOM/CSS for typography, layout and UI reconstruction; SVG for diagrams and vector infographics; a timeline engine for choreographed scenes, kinetic typography and masks; Canvas/Pixi for dense 2D; Three.js for spatial scenes; D3 for data-to-visual mapping; Blender or another offline renderer when authored fidelity is required.
- Keep one owner per property and one clock. For a programmatic render, values must derive from frame time or an integration designed for that frame model; avoid unseeded randomness, wall-clock timers, network assets that are not ready before capture, and live state that changes between frames.
- One primary orchestration model is enough. **Remotion** renders React components frame by frame and fits reuse of an existing React stack and typed variants; **HyperFrames** composes seekable HTML/CSS/JS and fits webpage-native sources and browser runtimes. Neither is a mandatory default, and setup is an explicit, separately approved action — consult [official docs](official-docs.md) before committing. For an offline 3D cinematic, the 3D environment may itself be the primary render.
- For many personalized outputs, separate the immutable design system, reusable scene components, input schema, media assets, timing rules and text constraints; design for worst-case text and media lengths.

Reconstruct each frame from its requested time, including seeded randomness and any simulation state, so seeking or parallel rendering does not depend on previous playback. Artistic exposure or line-jitter cadence can differ from export fps; test the intended movement, not only the metadata. When reusing cached frames, confirm that their source, code, assets, fonts and timing settings still match; invalidate affected frames when they do not. A filename or file size alone is not that check.

Check render and encoder exit status, the complete expected frame sequence or stream, and a decodable output before reporting export success. A log saying "wrote" or an existing file is insufficient; a failed export stays failed even if a preview looked good. Then inspect playback as required by the [quality bar](quality-bar.md).

## Sub-flow B — Recorded footage: editing and transcription

This covers the case "I have a recording, I want an edited version". Clarify the goal before selecting sources: subtitles only, silence/rough-cut, reordering, rate change. These interventions are independent and may be combined when they serve the approved brief; do not silently add unrelated edits.

### Transcript: ASR, alignment and VAD are different

- **ASR** produces word-level timestamps that are estimates, not truth. A Spanish, multilingual or accented piece needs a model that declares language support — for example a multilingual model, not an `.en` model, and not an automatic translator. Local ASR can require downloading model weights; state that before running.
- **Forced alignment** estimates where supplied, corrected text occurs in the audio; it does not correct the transcript or verify what was said. Text can align to the wrong audio and still pass a source-word confidence gate, so alignment gives no practical timing-precision guarantee. Missing or interpolated boundaries remain estimates.
- **VAD** classifies speech activity; low-volume detection (e.g. FFmpeg `silencedetect`) detects level below a threshold, not speech. Non-speech may include music, SFX or breathing, and transcript gaps can hide ASR omissions. Use the checks that address the actual uncertainty and review audio where possible; do not infer silence or safe cuts solely from transcript gaps.

### Timeline, cuts and clock

- Record a source-to-timeline contract: source in/out, target position, rate/speed changes, reorder, and audio offsets. Use a rational frame rate and account for VFR/PTS so speed changes do not silently drift A/V.
- The final audio duration includes real tails and room tone: extend to the **full media duration**, not to the last transcribed word. Leave guard bands around cuts and review the audio at the joins.
- Repetitions are an editorial decision, not a lexical detector. Review meaning and context: a repeated word may be emphasis or a functional verbal tic; if it is noise, mark the range and let the editor decide rather than auto-deleting.
- Preserve the master. Update captions by mapping only retained words and splitting at cuts; a final re-transcription or re-alignment is optional and applied when it adds value, not on every edit.

### Deliverables and QA

- Review captions for grouping, legibility, timing and safe areas, separating spoken captions from on-screen labels/rótulos. Produce an editable project source plus the requested export, without mandating a new folder for every case; inspect the existing directory and handle Unicode names.
- QA by playing the full edited version with audio and captions: A/V drift at start, middle and end; audio and subtitles synchronized; cuts matching the editorial decision; the clock inventory (duration, offset, channels, rotation, CFR/VFR) recorded. If no player or render is available, record the technical verification as **pending** and **not passed**; a separate user art approval may still stand and is kept distinct.
- If source files are missing, do not pretend to know precise cuts or claim a frame list was reviewed. Keep **user-declared approximate timings** separate from **measured timings**.

### Intended animation vs raw cadence

When a recording is inspected, verify the media by its metadata and decode path. Raw capture fps and the animation's intended timing can differ, causing dropped or duplicated frames. Probe where animation actually occurs rather than rejecting intentional static holds. Do not use a blanket "no intentional holds" rule, and do not lower the frame rate and re-encode to higher fps as if that restored motion.

## Mixing methods and media infrastructure

For each used clip, apply one source-to-timeline contract to its video, associated source audio and cues, including trims, speed and synchronization offsets; a separate master track keeps its approved timeline. Derive the usable interval from that contract and the actual available footage, not just the nominal clip duration. Translate inherited cue times into the local time of a cover or replacement segment; review words overlapping its boundary instead of dropping them with an arbitrary start threshold. If footage ends early, choose an editorially justified replacement or an explicitly intended hold, not a silent last-frame freeze. If only approximate metadata is available, the calculated range remains provisional until the clip can be decoded and inspected.

FFmpeg and similar tools are media infrastructure: transcode, mux, concatenate, overlay, mix/normalize audio, convert frame sequences and encode the final delivery. Do not use them as the primary art-directed motion layer when a richer runtime is more maintainable. Combine programmatic, recorded, 3D and generated material by scene; keep one clock owner and one property owner across the piece.
