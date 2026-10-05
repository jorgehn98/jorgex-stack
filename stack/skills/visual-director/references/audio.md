# Audio

Use when voice, music, SFX, mixing or captions matter. Audio is a support capability across web, audiovisual and assets; it is not required by default. Choose each element by need and rights, and decide explicitly rather than assuming "a missing voiceover means bad voice".

## When audio is needed

- **Voice**: use when narration carries the message; consider text-on-screen or image-led order instead when it does not. Determine whether the voice is recorded, synthesized, or duplicated from an approved source.
- **Music**: use for macro rhythm and tone; a piece can work image-led or silent if that serves the brief.
- **SFX**: use to sell contact, impact, movement, UI and transitions, not to fill every beat.
- Each choice is justified by the brief, not by habit.

## Mixing, loudness and peaks are distinct

Do not confuse the three:

- **Mixing** balances voice, music and effects so speech stays intelligible.
- **Loudness** is the perceived level over time and the platform's target.
- **Peaks** are momentary maximums that can clip.

Use ducking (lowering music under speech) so it sounds natural, not as pumping; there is no canonical LUFS target for every destination — check the real platform or broadcast requirement. Keep narration above music, and verify on the intended playback system.

## Cues depend on the approved audio

If the approved narration or music changes, even at the same duration, existing captions, cues and animations synchronized to it are invalid and must be re-checked. Derive cue timing from the actual approved audio, not from an earlier version.

When an existing track must be preserved, keep the master untouched and clarify whether that means unchanged musical content or an identical final mix. Added SFX, ducking, edits or regenerated vocals are not implicit permission; use them only when the approved brief allows them. Fit visual clips to the master timeline without silently changing the song to suit generated footage.

## Captions and labels

Distinguish **captions** (for spoken audio and meaningful sound) from on-screen **labels/rótulos** (titles and design text). Captions are timed to speech and sound; labels are design elements. Do not treat a sound-file transcript as a substitute for either. Verify grouping, legibility and safe areas at the destination size, and separate user-declared timing from measured timing.

Phrase windows and character-count karaoke are authored approximations, not verified word or phoneme alignment. Singing lip-sync needs its own audiovisual check; supplying lyrics or audio to a generator does not prove it. Use approximate cues when they serve the brief, label their precision honestly, and verify tighter synchronization against the actual vocals when required.

Waveform correlation or spectrogram similarity can identify returned-audio offsets and candidate aligned intervals; they do not establish that visible mouth movements match the vocals. Inspect the paired video and audio in those intervals before claiming lip-sync. Report what was compared and the denominator of any success rate: accepted word time in selected singing windows is not a percentage of the whole film.

## One owner, one pass

Keep one owner per audio property (voice level, music level, effects) so two processes do not fight the same bus. Apply processing only where it serves intelligibility. Play the full piece on the intended destination before accepting; if you cannot listen to it, the check is pending, not passed.

## Delivery

Produce an editable project source plus the requested export; an editable source is not mandatory in every case. Inspect the existing project directory before assuming a new one, and handle Unicode file names. Confirm the requested format rather than defaulting.

## Rights and consent

Voice cloning and likeness use require explicit permission before any use. Verify the current model, tool and license for the actual service — do not rely on credentials, credits, or a model name as a license. If permission, budget or a tool is missing, state the concrete fallback and its limitation instead of faking a pass or silently substituting. MCP connectors and accounts do not transfer permission to spend, upload or publish; see [generative media](generative-media.md) and [official docs](official-docs.md).
