# The Good Bits

**Live app: https://clickysteve.github.io/the-good-bits/**

Point it at folders (or individual files) of long source recordings - solo
horns, Rhodes, drum breaks - and it finds candidate musical phrases for you
to audition and load into hardware samplers later. It does **not** try to
replace your own chopping/sampling decisions; it's a fast first-pass editor.

Everything runs client-side: no server, no upload, nothing leaves your
browser. That's also what makes it possible to host for free as a static
site on GitHub Pages.

## Features

- **Five tasks, not a difficulty setting.** The app opens on one question:
  what are you here to do?
  - **Chop** cuts audio into chops and one-shots. No processing at all -
    original tempo, no colouration.
  - **Stretch** is the time-stretch tool on its own. Nothing is cut; whole
    files go through the stretch and lo-fi chain.
  - **Both** does the lot, with every option available at once.
  - **Play nice** conforms a pile of unrelated loops to one shared tempo and
    key, so samples that had nothing to do with each other can be used
    together. See [Play nice](#play-nice) below.
  - **Flip** takes one loop and hands it back to you wrong - a batch of
    automatic remixes of it, eight at a time, rearranged at every scale from
    whole bars down to micro-fragments, with key-aware pitch mutation. Click
    through until one of them is better than what you started with. See
    [Flip](#flip) below.

  This replaced a Simple/Advanced toggle, which was the wrong axis: it
  described how much of the interface you could see, said nothing about what
  you were trying to do, buried time-stretch as an optional panel inside a
  mode called "Advanced", and made "Advanced" mean two unrelated things at
  once - reveal the settings *and* switch the effects chain on. Task is the
  honest split, and it needs no special cases: under Chop there is simply no
  stretch stage to bypass. How much you see is separate, and lives behind the
  **Settings** button.
- **Process shows you the cuts; Export writes them.** **Process** runs the
  entire batch and saves nothing: every waveform with its cut points marked,
  every chop and one-shot with a player, and a live editor. **Export** is the
  only button that touches your disk. So: drop a file and hit Export if you
  trust it, or hit Process first, fix what you don't like, and Export when
  it looks right. Export reuses the analysis Process already did, so the
  second pass skips key, tempo and onset detection entirely.
- **The waveform is always live.** There is no "edit mode" to enter. Every
  processed file shows an interactive waveform straight away: scroll to zoom,
  click a slice to select it, **Space** to hear it (straight from memory, no
  re-processing), **Delete** to remove it, double-click to add one, and drag
  any boundary to move it. Selecting a slice highlights its row in the list
  below, so removing "number six" doesn't involve counting. Because chops from
  a break are contiguous, the end of one slice and the start of the next are
  drawn and dragged as a single shared boundary - stacking two identical
  handles on the same pixel made a drag look like it hadn't worked. Where
  slices genuinely don't touch (phrase mode leaves gaps) the edges stay
  independent and carry a direction flag. Every edit - a drag, an add, a
  delete, a re-chop - is canonical the instant it happens: Export always
  cuts where the waveform currently shows, with no separate commit step.
  **Update previews** just re-renders the audio players below the waveform
  so you can audition the edited audio in-browser; it has no bearing on
  what Export produces. **Revert** discards edits back to the last
  detection or re-chop. Nothing touches disk until Export either way.
- **Undo/Redo, per file.** Every region-mutating action on the waveform - a
  drag, an add, a delete, a double-click split, Re-chop, Clear, Revert - is
  one step on that file's own Undo stack, kept independent of every other
  file's. A drag is a single step no matter how many times it moved while
  held: Undo restores the boundary to where it was before the drag started,
  not one step per pixel. **Cmd/Ctrl+Z** undoes, **Cmd/Ctrl+Shift+Z** (or
  **Ctrl+Y**) redoes, or use the compact Undo/Redo buttons in the waveform
  toolbar; making a new edit after an Undo drops whatever was available to
  redo, same as any other editor. Selecting a slice, playback, zoom/pan and
  a plain Process rerun never touch this history.
- **Re-chop and manual chopping, from the editor.** Beyond dragging
  boundaries, a file's card has an explicit (and deliberately destructive)
  **re-chop**: replace every current chop with a target number of
  equal-length slices (**Equal slices**), or with break-sized loops at a
  chosen bar length (**By bars**). **Start on downbeat** starts them on the
  detected first downbeat (untick it to treat 0:00 as bar 1, or - with no
  tempo - to keep leading silence). **From chop NN** re-chops only from the
  selected chop onward, with its start as bar 1, and leaves everything
  before it alone: the way to carve off an intro fill or count-in that
  throws the phrasing out. A hand-placed start within a beat's tenth (50ms
  max) snaps onto the beat. **Clear all** empties the chop
  list entirely so you can build one from scratch with **+ Add** - the
  same editor either way, not a separate manual-chopping mode. A single
  edited chop can also be exported on its own with **Export selected**,
  without touching any other chop already on disk.
- **The first batch processes itself.** Adding audio to an empty queue
  (Add folder/files, or a drop) runs a Process pass automatically, so
  there's something to look at without a separate "now click Process"
  step. Adding more files later never re-triggers this, so it can't
  clobber edits already sitting in the editor.
- **Per-file one-shot opt-out.** Hit extraction is a heuristic and on some
  breaks it returns junk, so each file has an **export one-shots** tickbox:
  drop that file's hits and keep the rest of the batch.
- **One palette, checked by the test suite.** There used to be three
  interface themes. Two of them shipped body text below the readable
  minimum without anyone noticing (Console's panel labels measured 2.55:1,
  and even the default theme's were 3.34:1, against a 4.5:1 floor), because
  maintaining three parallel skins meant none of them got audited. They're
  gone, replaced by a single dark palette with a signal-red accent, and
  `test/contrast.test.mjs` now fails the build if any text role drops under
  4.5:1 against the surface it sits on. Note the accent buttons use
  near-black labels rather than white: white on that red is only 3.32:1.
- **Auto or manual detection settings.** Auto mode (on by default) just uses
  sensible defaults per mode, so you don't have to make any decisions to get
  started - flip it off if you want to hand-tune silence sensitivity, phrase
  length targets, fade/click protection, and so on.
- **Loudness-adaptive silence detection.** Instead of one fixed volume
  threshold for every file, the gate is set from both the recording's own
  noise floor and how loud it actually plays - so a hissy transfer doesn't
  read its own quiet playing as silence, and a file containing true digital
  silence doesn't end up with a gate below anything that ever happens.
- **Phrase chopping follows the playing.** For horns and Rhodes a phrase ends
  where the line drops away and the next one starts - a breath, a released
  chord - so boundaries are scored on the dip before an attack and the attack
  itself, and the cut is placed on the note, to the sample. Lengths vary with
  the music instead of landing every N seconds; a continuous take with no
  breath in it is still cut at the most phrase-like point available rather
  than at whatever frame happened to be quietest.
- **Auto key and tempo detection** (via [essentia.js](https://mtg.github.io/essentia.js/), see licensing note below), shown per source file and baked into the output folder/file name.
- **Tempo-locked drum chopping, in bars.** Choose a chop length in bars (1,
  2, 3, 4, 6, 8, 16…) and it's converted to seconds from the detected tempo,
  then every boundary - the first one included - snaps to the **bar** grid, so
  each chop is an exact whole number of bars and loops cleanly. The grid's
  phase is measured to the sample against the file's real downbeat rather than
  taken from the first detected onset; see Chopping on the bar line. If tempo isn't confidently detected on a drums-mode file, you get
  a warning and a choice: continue with a fixed fallback length, or skip
  that file - with an option to apply your choice to the rest of the batch.
- **Editing chops and one-shots is independent.** A file with both shows a
  Chops / One-shots switch above the waveform; adjusting one set never
  discards the other. On tempo-locked drum chops the toolbar's **Snap**
  granularity (Off, 1/16, 1/8, 1/4, 1/2 bar, 1, 2 or 4 bars - remembered,
  1 bar by default) makes drags, double-clicks and **+ Add** land on the
  nearest line of that grid - live while dragging - and Shift+arrow step by
  it. Bar lines count from bar 1, not from 0:00. **Off**, and
  everything that isn't tempo-locked, snaps to the nearest zero-crossing on
  release instead, so a deliberately off-grid cut stays click-free.
- **One-shot extraction that returns usable hits.** Hits used to be cut hard
  at the next onset, so on a busy break every "one-shot" came out as a ~40ms
  stub with its tail chopped off, and a dedupe pass that clustered on three
  coarse band ratios then collapsed 32 detected hits down to 2. Now a hit is
  allowed to ring a little way into what follows it, its decay is measured
  against its own peak rather than a whole-file noise floor (which sits at
  digital silence on a dense break, so the test never fired), and dedupe
  clusters on a five-band log-spectral fingerprint with the unreliable
  kick/snare/hat label kept out of it entirely. On a test break built from
  five deliberately distinct drums, the old code recovered 3 of them and the
  new code recovers all 5.
- **Optional time-stretch.** Stretch chops on export while preserving
  pitch, either by matching every file to one target tempo (handy for
  normalizing a batch to a single BPM, up to 300 BPM) or by a fixed
  stretch ratio applied to everything. Five "character" presets trade off
  cleanliness for vibe: Clean is a transparent stretch, Vintage adds the
  grainy warble of a 90s hardware sampler, Glitch pushes that further into
  metallic, low-bit territory, Warped uses short choppy grains for a
  wobbly, broken-pitch feel, and Crushed keeps smooth grains but
  bit-crushes harder than Glitch. Applies to the main chops, and also
  produces a separate processed copy of the full source track in `wav/`
  (see **Lo-fi character** below for how that file gets named when both
  time-stretch and lo-fi processing are on) - handy for dropping the
  whole recording into a sampler at the target tempo. A file with no
  confident tempo detected exports unstretched in target-tempo mode.
- **Optional lo-fi character.** Three independent, stackable stages
  (applied in this order): an **output-stage character** modeled on
  tape/vinyl/radio/broadcast-chain coloration (Cassette, Reel-to-Reel,
  Damaged, Vinyl, Boombox, AM Radio, VHS Hi-Fi, Bus Comp, Lathe, Phone
  Bus - each with its own Mix and Intensity), a **drive** saturation
  stage (Tape/Tube/Diode/Fuzz, with an amount knob), and a **crunch**
  bitcrusher (bit depth + sample-rate divide). Same export scope as
  time-stretch, controlled by **Processing scope** below. The output-stage
  character presets are inspired by the output-stage designs in
  [Loop Saboteur](https://github.com/clickysteve/Loop-Saboteur), the
  author's own open-source glitch/chop plugin - ported here as offline,
  whole-buffer processing rather than a real-time audio-thread effect.
- **Processing scope, for one-shots and clean copies.** Time-stretch and
  lo-fi are off for one-shots by default - they stay untouched, clean drum
  hits - but **"Also apply to one-shots"** runs the same chain over them
  too. Separately, **"Keep an unprocessed copy alongside the processed
  one"** writes both a raw and a processed version of every chop (and
  one-shot, if that toggle is also on) whenever any processing is active,
  landing the raw copies in sibling `chops clean/` / `one shots clean/`
  folders with file names matching their processed counterparts.
- **Typable values, not just sliders.** Every range control (fade length,
  zero-crossing window, target BPM, stretch ratio, output-stage mix and
  intensity, drive amount, crunch bits and rate) has a number field next
  to it - drag the slider or type an exact value, either one updates the
  other.
- **One-shot hit extraction (drums, optional).** Pulls individual
  kick/snare/hat/cymbal-type hits out of a break into their own
  `one shots/` folder, deduplicated so a loop's repeated hits don't all
  get kept, and named with plain sequential numbers (01.wav, 02.wav, ...)
  since the kick/snare/hat classification is a rough heuristic used only
  to group similar-sounding hits together, not reliable enough to trust
  in a filename.
- **Typable output naming, with a live preview.** Type your own chop
  filename pattern using `{name}`, `{folder}`, `{tag}`, `{key}`, `{tempo}`
  and `{number}` tokens in any order or combination (a number is always
  included even if you leave `{number}` out of the pattern, so chops can
  never silently overwrite each other), pick the separator used inside the
  auto-generated key/tempo tag, and see an example of the resulting
  file/folder names update as you type. `{folder}` is the source file's own
  parent folder, which is what tells stem exports apart when every one of
  them is called `other.m4a`.
- **Two sources can never write to the same place.** If two files in a run
  resolve to the same output folder name, the later ones get ` 2`, ` 3` and
  so on, and the log says so - without that, the second file's export would
  overwrite the first's (and clear it first). Each queued file also gets its
  own analysis, even when it has the same name and path as another.
- **Click-free boundaries - except where they'd break a loop.** Phrase chops
  and one-shots get their cut points snapped to the nearest zero-crossing plus
  a short fade in/out, so they don't pop at the edges. Bar-locked drum chops
  get neither, deliberately: the fades would put a 10ms hole at the loop seam
  on every cycle, and the zero-crossing snap moves each end independently, so
  a chop that was an exact whole number of bars comes out a few milliseconds
  long or short and drifts off the grid. A cut that lands on the bar line
  doesn't need the protection - the sample after the chop's end is the sample
  at its start, by construction.
- **Folders or individual files, by button or drag-and-drop.** Click
  **+ Add Source Folder** / **+ Add Individual Files**, or just drag a
  folder or audio files from your file manager and drop them anywhere in
  the Source panel - both routes feed the same pipeline. In Chrome/Edge a
  dropped folder gets full read/write access like a folder added by
  button; in Safari/Firefox (no File System Access API) a drop still
  works, falling back to the same ZIP-on-export behavior as any other
  source added there.
- **Optional per-subfolder batching.** Point it at one parent folder full
  of session subfolders and tick **"Split into one batch per subfolder"**
  *before* adding it, to have each subfolder processed as its own
  independent source (own `wav/`, own `chops/`), instead of one flat
  batch.
- **In-browser audition.** Every generated chop gets an inline audio player
  in the results panel - no need to dig through Finder to hear what you got.
- **A batch that survives one bad file.** If a single file fails to decode
  or analyze, it's logged and skipped; the rest of the batch keeps going.
- **Progress and cancel.** Both Process and Export show a progress bar as
  they work through the queue, and a **Cancel** button stops after the file
  currently in flight finishes (mid-file cancellation isn't possible, but
  nothing further starts). The heavy per-chop work - time-stretch, the
  lo-fi chain, and WAV encoding - runs off the main thread in a background
  worker so the page stays responsive during a large batch.
- **Folder permissions are remembered.** In Chrome/Edge, folders you've
  added stick around across page reloads: on your next visit they show up
  as pending with a **Reconnect** button (browsers require a fresh click to
  re-grant filesystem permission each session - they never persist the
  grant itself) or a **×** to forget them for good.

The version number shown next to the title (e.g. `v0.8`) ticks up with each
meaningful change, so you can tell at a glance whether you're looking at the
latest build.

## Play nice

> Choose a destination, or give it a loop to follow. Drop more loops in. Make
> them play nice together. Export.

Everything else in the app works on one recording at a time. **Play nice**
works on a *pile* of them, and its question is different: not "what's good in
this file?" but "how do I make these twenty unrelated loops usable in the same
track?"

### The target

There are two ways to say what everything should conform to, and the
processing pipeline cannot tell them apart - both produce the same internal
`TargetContext` (see `js/play-nice/target-context.js`), and nothing downstream
branches on where it came from.

- **Defined** - type it. `128 BPM`, root note, major/minor.
- **Reference loop** - follow a loop you already like. Drop one on the
  reference zone, *or* hit **Use as reference** on any loop already in the
  batch - the reference is a pointer to an item in the list, not a separate
  upload, so switching which loop everything follows is one click and needs no
  reloading. The reference stays in the batch, badged, and conforms to itself
  as an exact no-op.

A detected target is a *starting point*, never a verdict. The detected values
are shown as detected, the values actually in force are shown separately and
stay editable, and **Reset to detected** is always one click away. Tempo
detection lands an octave out more often than it gets anything else wrong, so
the reference loop gets an **Interpret as** row - `Detected: 64 BPM ->
[32] [64] [128] [256]` - that fixes it without retyping. The row also offers the 2/3 and
3/2 readings: a straight 136 BPM break is routinely detected at 90.67 - exactly two
thirds - when the pattern is syncopated enough to make the beat ambiguous, and with
octaves alone no chip reaches the right answer at all. If the reference has
no meaningful key (a drum loop, noise), key conforming switches itself off
rather than inventing a key; pick one yourself to turn it back on.

### Loops

Each loop is **one scannable row**: what it was, what it becomes, how, and whether it wants
looking at. Clicking a row opens the detection editors, the numbers and the audition player,
and closes whichever row was open before.

That is the whole reason the row exists. The fully-detailed card was about 450px tall, so a
twelve-loop batch put *zero* loops fully on screen and a twenty-loop one needed nine
thousand pixels of scrolling - in a feature whose entire premise is throwing twenty loops at
it. Collapsed, twelve real loops occupy 552px and fit at once. The Target panel collapses to
its own summary line as soon as loops arrive, for the same reason.

**Needs a look.** The batch job isn't "check twenty loops", it's "find the two that went
wrong". Anything whose conform is probably not what you wanted - a length that isn't a whole
number of beats, a key or tempo that couldn't be fitted, a failed render, a six-semitone
shift - gets a dot, and the filter above the list shows only those. On a twelve-loop test
set of real material it flagged exactly the two files whose detected tempo disagreed with
their own filename.

**Solo and mute** sit on every row, because once more than three things are playing they are
the two controls you reach for constantly.

Drop as many as you like. Each is analysed as it arrives (one at a time, so
the page keeps responding), and one unreadable file marks itself failed
without taking the batch with it. Every loop gets a card showing:

- a headline **`104 BPM · G major → 120 BPM · D# major`** line: what the loop was, and
  what it becomes. Both halves are built from what will actually happen, so a loop with
  tempo fitting off keeps its own tempo on the right, and one conformed to the target's
  relative key says `relative key` rather than naming a key it never reaches.
- the detected source BPM and key, **and** the values actually in force,
  which are editable - including the same one-click half/double **Interpret
  as** row. Changing them recalculates the required stretch immediately.
- **No key**, for percussion, noise or anything atonal - skip key matching for
  that loop only, without disturbing the rest of the batch.
- independent **TEMPO** and **PITCH** switches, each `Fit` or `Off`, so you
  can conform only tempo, only pitch, both, or neither.
- the resulting stretch ratio, tempo change, semitone shift and output length.
- **Original vs. Conformed** side by side, as two players - only one plays at
  a time, so it's a real A/B.
- **In mix**, controlling whether the loop is included in Play all.
- individual **Export**, plus **Export all** for the batch.

Changing anything on a loop - its stretch method, a tempo correction, a Fit switch -
**re-renders it automatically**, so you can hear the change without going and finding a
button first. The render is debounced, so dragging a control doesn't start one per tick,
and a slower method finishing late can never overwrite a newer result. Changing a
session-wide setting refreshes only the loops you have *already* rendered, so tweaking the
target doesn't silently kick off twenty renders you never asked for.

### The mix bar

Auditioning loops one at a time tells you each is the right tempo. It does not tell you
they work *together*, which is the only result anyone cares about.

A transport bar sits along the bottom of the window whenever PLAY NICE is open, in the
same slot the other tasks give to Process/Export. It shows the **whole batch as one summed
waveform** - what you will actually hear, with shorter loops tiled the way they will
repeat - overlaid with **bar lines at the target tempo** (every fourth heavier, so phrases
are countable) and a playhead you can drag to move around in. The readout is **bar.beat**
alongside the clock, because everything else here is musical and "is this loop starting
where a bar starts?" is not a question you answer in seconds. Play/pause, stop, a **Loop**
toggle, the **Original / Conformed** switch, and on the right, **Process all** and
**Export all**.

The batch actions live there rather than down in the loops list because they are what the
whole screen is for: burying the only button that writes files among "Add loops" and
"Clear", halfway down a page you have to scroll, was exactly backwards. The bar is the one
piece of chrome that never scrolls away, so you hear the batch and export it from the same
place. It takes part in the app's normal layout rather than floating over it, so the log
panel underneath stays visible.

Mute, solo and Original/Conformed are **gain changes on sources that never stop**, not
stop-and-restart. Every loop gets a source for each variant it has, all started together and
all running for as long as the mix plays; what you hear is whichever gains are open, ramped
over 12ms so nothing clicks. Measured: two mutes, two solos and two source switches during
playback cause **zero** buffer rebuilds and the playhead never pauses.

That matters most for the A/B - comparing two versions of a loop is impossible if the thing
you are comparing keeps beginning again. The cost is a second set of buffers while both
variants exist, which is the price of an instant, sample-accurate comparison.

Switching Original to Conformed keeps playing from the same position, so it is a true A/B
rather than a restart - and the duration readout tells the story on its own: the same two
loops read `0:36.92` as originals and `0:32.00` conformed, because conformed loops are
exact multiples of each other and originals are not.

Pressing play on the conformed mix renders anything not yet processed first. Starting a
single loop's own player stops the mix, and vice versa; they are the same speakers. Each
card has an **In mix** checkbox, because twenty loops at once is mush.

The log panel above it carries a running account of the batch - what was added, what
analysis found for each file, what was processed and exported, and anything that failed:

```
Added 3 loops. Analysing…
  Drums - 136.wav: 136 BPM / A minor
  Rhodes - 100.wav: 100 BPM / C minor
⚠ Skipped "broken.wav": Not a RIFF/WAV file
Processing 2 loops to 120 BPM / C minor…
✓ Processed 2 loops to 120 BPM / C minor.
```


### Getting loops to actually lock

Conforming a loop to the right tempo is not the same as making it sit tightly against
another loop, and the gap between the two is where "musically loose" lives. Four
separate things had to be right:

**Downbeat alignment.** A loop exported from a DAW, trimmed by hand, or pulled out of a
longer file almost never begins exactly on its first transient. Conforming does not
remove that lead-in - it *scales* it, so 31ms at 100 BPM becomes 27ms at 117 and the loop
still enters late. PLAY NICE now measures how far a loop's attacks sit off its own beat
grid and rotates the loop to fix it.

Rotating, not trimming: the head wraps round to the tail, so the length stays exactly a
whole number of beats. And the correction is measured against a **sixteenth-note grid**,
not against zero, which is what keeps it from destroying musical intent - a loop that
deliberately starts on the "e" of beat 1, or opens with a bar of rest, is already on the
grid and is left alone. Only the sub-subdivision slop is removed, so nothing ever moves by
more than half a sixteenth.

The measurement is a correlation of the loop's whole onset envelope against a pulse train
at its own tempo, so **every** attack votes rather than hanging the alignment on a single
detected onset - which would fail on a loop with a quiet first hit, a rest at the start, or
an attack the stretch engine smeared. The correlation picks which grid line; a
sample-accurate onset detector then fixes the exact position within it.

**And it knows when to do nothing.** On percussive material the winning grid phase scores
five to eight times the average, because the attacks really are all in one place. On a
sustained pad or a soft-attack arpeggio there are no attacks to find, every phase scores
within about 4% of every other, and the "winner" is noise - acting on it shoved a
sixteen-bar arpeggio 66ms (about a 32nd note) sideways for no reason, which is exactly how
a conformed loop ends up sounding late. Alignment now requires the correlation to be
decisive before it moves anything, and the card says `no clear beat - left as-is` when it
isn't. Leaving a pad exactly where the musician put it is the right answer.

It runs twice: once on the source, and once on the finished audio, because stretch engines
have latency of their own and that is a property of the method rather than the source.

**One stretch pass, not two.** Conforming tempo *and* key used to run the audio through the
stretch engine twice - once for tempo, and again inside the pitch shifter, which is itself
a stretch plus a resample. Every pass smears transients, and two passes measurably doubled
and blurred the attacks. Stretching by `tempoRatio x pitchFactor` and then resampling by
`1/pitchFactor` lands on exactly the same duration and pitch with one pass through the
engine. On the two-loop test this alone was worth 16ms.

**A stretch that reaches the end of its own buffer.** WSOLA - the engine behind Clean,
Tight, Vintage and the other splice-based characters - accumulated the similarity search's
forward nudges into its read position. Those nudges compound, so the read ran through the
input faster than the ratio intended, hit the end, and stopped while the output buffer was
only part-written: a break came back the right *length* with silence on the end. The
analysis position is now derived from where each grain lands in the output rather than
accumulated from the last one, which fills the buffer and, as a side effect, cut those
characters' rhythmic drift from 70-240ms down to under 20ms. Every character's window,
search radius, hop and bit depth are untouched, so they still sound like themselves.

**A default method that holds the grid.** Measured on a percussive loop stretched to a new
tempo, the transient-preserving phase vocoder holds every hit to well under a millisecond
of its ideal position, while WSOLA's similarity search moves splice points around and
visibly softens some attacks. Both are perfectly good stretches of a single file; only one
of them stays tight against a reference. PLAY NICE therefore defaults to **Transient**
where STRETCH defaults to Clean.

The other methods are all still there - that is the whole point of METHOD - and if the one
you pick leaves a loop rhythmically loose, the card measures it and says so rather than
letting you wonder.

**Half and double time, resolved automatically.** With a target in hand, a detected 70 BPM
against a 117 BPM target is unambiguous, so PLAY NICE now just fixes it and shows an
`auto → 140` badge instead of waiting for you to notice. A tempo *you* set is never
overruled - it gets a suggestion, not a silent doubling.

Together, on a synthetic two-loop test (reference at 117 with 9ms of slop, candidate at
100 with 31ms of slop and a half-time detection), these took the candidate from **35ms
adrift to within 3ms** - and 3ms is the resolution of the measurement, not a residual you
can hear.

### Half-time, double-time

A 174 BPM break in an 87 BPM track has two honest answers: crush it to fit, or play it
**half-time** - twice as long per bar, big and stretchy, and still locked to the grid
because one bar of the break is exactly two bars of the track. Conforming "correctly" is
precisely what prevents the second one.

Every loop has a feel selector: `¼× ½× 1× 2× 4×`. It conforms the loop to a *multiple* of
the target tempo rather than to the target itself - half-time against 120 BPM means
conforming to 60. Nothing downstream needed changing: the ratio, the bar snapping and the
alignment grid all follow from the tempo they are given, and the mixer already tiles loops
of different lengths against each other. A half-time loop plays once per two cycles of a
normal one, in time throughout.

Measured on the Amen: a 1.74s one-bar break against a 120 BPM target comes out at 2.00s
normally (one bar), **4.00s at half-time** (two bars) and 8.00s at quarter-time (four
bars) - exact multiples every time.

One subtlety that took a fix: automatic half/double correction has to aim at the *session*
target, not the feel-adjusted one. Pointed at the halved target it picks whichever octave
needs least stretching from there - which is exactly the stretch you just asked for, so the
feel silently cancelled itself out.

### Drum loops

Key matching has nothing to match on percussion, so PLAY NICE detects it and switches key
fitting off for that loop by default - visibly, with the same **No key** checkbox available
to turn it back on.

The obvious signals both fail. Essentia's key *strength* ranks a chiptune lead as less tonal
than every drum loop in the set; onset-grid confidence ranks that same lead above them,
because staccato square waves have attacks as sharp as a snare. **Spectral flatness**
separates them, because it measures the thing that actually differs - snares and hats are
broadband noise, leads and keys are harmonic peaks with gaps between them. Measured across
twelve real loops: drums 0.62-0.73, every melodic loop 0.005-0.55, chiptune lead at 0.25
where it belongs.

It is deliberately conservative - it wants a noisy spectrum *and* a strongly rhythmic one -
because the two ways of being wrong are not equal. Missing a drum loop transposes it a few
semitones, usually inaudible. Wrongly calling a melody percussion leaves it in the wrong key
against everything else, which is a bum note.

### Levels

Real batches are not level-matched. Measured across twelve loops pulled from actual sample
folders, integrated loudness ran from **-10.3 dB to -29.2 dB** - nearly 19dB of spread. Sum
that flat and the loudest loop buries the quietest, and the conclusion you draw is "these
don't play nice" when nothing about the conforming is wrong at all.

**Match levels** (on by default, on the transport) balances what you *hear*. It never
touches what you export - a file quietly gain-changed on the way out would be a nasty
surprise, and the point of the export is a faithful conform. The measure is gated integrated
RMS, so a loop that is half music and half tail reads at the level of its music rather than
being dragged down by its own silence.

### Snap loops to musical lengths

On by default, and the reason Play all is usable at all.

Tempo detection is accurate to a fraction of a percent - it reports 99.86 BPM
for a loop that is plainly exactly 100. Conformed from 99.86, that loop comes
out about 15ms away from a whole number of bars. Played once, inaudible.
Played round and round against other loops, the error compounds every cycle
until the batch is flamming.

A loop's *duration* is exact - it's a sample count - while its detected tempo
is an estimate. So if the duration is within a hair of a whole number of beats
at the estimated tempo, the whole-beat reading is almost certainly the truth,
and the tempo it implies is exact. Snapping uses that instead, and the card
shows what it concluded (`16 beats · 100.00 BPM`).

Rounding to the nearest whole beat is not enough on its own. A sixteen-bar arpeggio
measured at 64.6 beats rounds to **sixty-five**, which is not a length any loop has ever
been, and conforming from it leaves the loop over a beat wrong by the end. So candidates
are tried in order of musical likelihood - powers of two bars first, then any whole number
of bars, then anything even, then an arbitrary count - and the first that fits without
moving the tempo more than 2.5% wins. An honest three-bar loop still lands on 12 beats
rather than being forced to 8 or 16.

It only ever *refines* the tempo in force - that 2.5% ceiling means it can never quietly
overrule a half/double correction you made yourself. Material that doesn't look like a
clean loop is left alone and says `not snapped`.

If a loop's detected tempo is an octave out, the card says so *and* names the
tempo it probably should be - "Reading this as 140 BPM instead of 70 would
need far less stretching". Finding the two loops out of twenty that need
correcting is the slow part of this workflow, so the app does the looking.

### FIT and METHOD

The most important idea in Play nice:

> **FIT** determines what needs to change. **METHOD** determines how Good Bits
> changes it.

The stretch required to get a 100 BPM loop to 128 is a fact about the two
tempos - `0.781x`, whichever algorithm performs it. *Which* algorithm performs
it is a creative choice, and it is yours. Play nice exposes the app's entire
existing stretch palette (all 29 characters, the same registry the Stretch
task browses) as the **Method** control: a session-wide default plus a
per-loop override, so twelve loops can conform cleanly while three go through
Shred, Glitch or Spectral because you prefer the damage.

Correcting a BPM never changes the method; changing the method never changes
the ratio. That independence is enforced in `js/play-nice/conform.js` and
tested in `test/play-nice-conform.test.mjs`.

The one method that is not tempo-transparent is **Tape** (varispeed), where
pitch follows speed by design. Conforming tempo through it therefore also
transposes the audio - so when pitch fitting is on, the pitch stage subtracts
that drift and the result still lands on the target key; when it's off, the
drift is left in (it's the sound you asked for) and reported on the card.

### Tempo and pitch are independent

Changing tempo does not change pitch. Changing pitch does not change duration.
Pitch shifting is stretch-then-resample built on the existing phase vocoder
(`js/dsp/pitch-shift.js`), and its output length is pinned to the input's
exactly rather than "near enough".

Transposition always takes the short way round the chromatic circle - C to B
is one semitone down, never eleven up, and no conform is ever more than six
semitones. Key matching is a pluggable strategy
(`js/play-nice/key-matching.js`), so alternative compatible-key behaviour can
be added later without touching the pipeline.

### Major, minor, and what to do about it

Transposition moves a recording's root. It cannot change its mode - the third
is baked into the audio, and no amount of pitch shifting turns a major loop
minor. But it doesn't have to, and **Key matching** offers the two honest
answers:

- **Match root** moves the source root onto the target root. Predictable, and
  correct whenever the modes already agree. When they don't, it puts a major
  third against a minor context (or vice versa) - a real clash - so it says so
  rather than pretending.
- **Match scale** *(default)* matches the target's **scale** instead of its
  tonic. A major key and its relative minor contain exactly the same seven
  notes, so when the modes differ, the source is transposed onto the target's
  relative key: a loop in F minor conformed to a C major target goes to A
  minor, and every note in it belongs to C major. The loop stays the minor
  recording it always was, and fits anyway.

Match scale is identical to Match root whenever the modes agree, and only
differs in exactly the case Match root handles badly - which is why it's the
default. It also stops pointless work: a loop already in A minor conformed to
a C major target needs **zero** semitones, where matching roots would have
moved it three for no reason and made it sound worse.

Because the result isn't always the key you typed, the card reports where the
loop actually landed - `+4 st → A minor`.

What this does *not* claim: the source keeps its own tonal centre, so a minor
loop over a major track still reads as the relative minor rather than the
major. Related, not transformed. That's a fact about transposition, not a
shortcut - and it's why per-loop **PITCH Off** and **No key** exist.

### Export

WAV, 24-bit, never over the source files. Names keep the original stem and
record what happened: `Amen Break play nice Em 128bpm.wav`. **Export all**
writes into one clearly-named folder per target (`play nice Em 128bpm/`), so
conforming the same pile to two different targets gives you two folders rather
than one mixed one; names that would collide are numbered rather than
overwritten. Browsers without the File System Access API get the same batch as
a ZIP, exactly as elsewhere in the app.

### Input roles

Play nice distinguishes three kinds of input as data rather than as
assumptions (`js/play-nice/roles.js`): a **reference** defines the target and
is never conformed or exported; a **loop** has a tempo of its own and is
conformed to both; a **one-shot** has pitch but no meaningful tempo. Nothing
in the pipeline asks "is this a loop?" - it asks the role what it supports.
Only the loop workflow is built today; the role model exists so the one-shot
workflow can be added without unpicking a tempo assumption spread across five
files.

## Flip

> Give me this loop back, but wrong.

Everything else in the app takes audio apart so *you* can decide what to do
with it. **Flip** decides for you, eight times, and lets you throw seven of
them away.

Drop in one ordinary musical loop - a boring four-bar piano part will do -
and Flip analyses it, understands it as a piece of music with bars and beats
in it, and proposes a batch of alternative arrangements. Sometimes it rewrites
the phrase. Sometimes it repeats something unexpectedly. Sometimes it leaves
almost everything alone and does one ridiculous roll. Sometimes it finds a new
melody in the one you already had.

It is deliberately **not** a manual slicer, a pad instrument or a sequencer.
There is no way to specify an individual edit, because specifying individual
edits is what your DAW is for. Every control changes the *character* of what
gets proposed.

### The workflow

1. Pick **Flip** in the top bar and drop a loop on the page.
2. Check the tempo and key it detected. The tempo *is* the slice grid and the
   key constrains every transposition, so these are the two things worth a
   glance before you generate - both are correctable in place.
3. Choose a remix type. Adjust **Structure**, **Activity** and **Depth** if you
   want to; the defaults are chosen to be useful.
4. Press **GENERATE**.
5. Click down the list. **ORIGINAL** sits at the top in the same shape as the
   variations, so `ORIGINAL → FLIP 01 → FLIP 02` is one continuous audition
   rather than an A/B you have to set up. Only one row plays at a time.
6. Press **GENERATE 8 MORE** until something is interesting. Export the ones
   that are.

### Presets

Eight one-click starting points that already sound like something, because
being handed four sliders and told to discover that Structure 85 / Activity 30
/ Depth 65 / Rolls 90 is "the fills one" is not a way to begin:

| | |
| --- | --- |
| **Subtle** | Your loop, with something quietly different about it. Whole bars untouched. |
| **Bar swap** | Bars and half-bars change places, repeat and answer each other. |
| **New groove** | Same bars, different rhythm. |
| **Fills** | Leaves the loop alone and adds fills at the ends of bars and the phrase. |
| **Melodic** | Finds a new tune in the one you already had. |
| **Stutter** | The glitchy end - micro-slices, rolls and rapid repeats. |
| **Rebuild** | Takes the phrase apart and puts it back in a different order. |
| **Destroy** | Everything, at every scale, as far as it goes. |

Each is a full settings snapshot - including the chop size, because the grid is
half of what a remix type sounds like - so clicking one always lands on a
complete, coherent state. Move any slider afterwards and the chip simply stops being
highlighted - nothing is locked. Everything else lives behind **Fine tuning**.

The overall shape - a division/rearrangement rule crossed with a treatment
category - is borrowed from the Yamaha RS7000's Loop Remix, whose `TYPE` (how
the data is divided and rearranged) and `VARIATION` (`NORMAL` / `REVERSE` /
`BREAK` / `PITCH` / `ROLL`) is the same separation, and which exposes it as
numbered presets for the same reason.

### Chop size

The chop is the atom - the smallest thing Flip can move. It's sized in musical
units, from a whole bar down to a thirty-second note:

```
1 bar    ½ bar    1/4    1/8    1/16    1/32
```

On an eight-bar loop those give 8, 16, 32, 64, 128 and 256 chops respectively,
and the readout shows the count, because the count is what you're really
choosing. This is the RS7000's model - detect the phrase length, pick how many
chops to cut it into - expressed as a size rather than a raw number so the grid
stays on the bar line and the label tells you what you're going to hear.

**It matters more than it sounds like it should.** At `1 bar`, whole bars are
the only thing that can move, and results look like `6 2 3 4 5 5 7 8` - genuine
bar-level arrangement. At `1/32`, Flip works down to micro-fragments. Measured
across a batch on an eight-bar loop:

| Chop size | Chops | Avg edit span | Stutters per variation |
| --- | --- | --- | --- |
| 1 bar | 8 | 1.00 bars | 1.5 |
| ½ bar | 16 | 0.62 bars | 1.6 |
| 1/4 | 32 | 0.44 bars | 1.5 |
| 1/16 | 128 | 0.32 bars | 2.4 |
| 1/32 | 256 | 0.32 bars | 4.4 |

Earlier versions sized the grid as a subdivision of the *beat*, which
structurally forbade a chop bigger than one - so the smallest movable thing was
always a beat or less, and bar-scale operations could only ever be assembled
out of runs of small pieces.

Presets pick a chop size of their own (Bar swap wants half-bars; Stutter wants
sixteenths), and a size that would leave too few chops to rearrange - whole-bar
chops on a one-bar break - steps finer automatically rather than handing you a
dead GENERATE button.

### Hierarchical remixing

A loop is not a flat list of slices, and the difference between a remix and a
glitch plugin is whether the machine knows that. Flip understands the source at
seven scales at once:

```
PHRASE
└── BAR 1 / BAR 2 / BAR 3 / BAR 4
    └── half-bars
        └── beats
            └── half-beats
                └── slices
                    └── micro-fragments
```

Every intervention picks a scale first and a place second, so one variation can
combine sizes the way an arrangement does:

```
bar 1  untouched
bar 2  repeat, roll
bar 3  reverse a slice, return to an earlier motif
bar 4  substitute
```

That bar-by-bar summary is what each variation row actually prints, so you can
see the shape of a result before you play it, and see at a glance which ones
left most of your loop alone.

**Why this matters:** the first version of Flip walked the phrase one beat at a
time and applied one operation per beat it decided to touch. Every edit was
therefore roughly one beat wide, everywhere - and a remix that edits uniformly
has no shape. It sounded like generic glitch processing because structurally
that is what it was.

### Restraint

Flip is comfortable doing nothing. Bars are left alone by *explicit decision*,
not by failing to be picked, and at low **Activity** most of them will be. A
good remix might only touch 20-30% of the source; the original material is
what supplies the musical coherence, and Flip should exploit that rather than
feel obliged to demonstrate itself constantly.

### Phrase form

Deciding each bar independently produces a scatter of treated and untreated
bars; music produces *shapes*. So a variation will often adopt a form - `ABAB`,
`AABA`, `AAAB` - and concentrate its changes accordingly, which is what makes
the result sound arranged rather than processed: you hear a pattern of change,
not just change. (The RS7000 exposes the same idea as an `INTERVAL` parameter -
"remix every other measure".)

It's a weighting, not a rule, and it's mean-neutral: a form redistributes
activity, it never adds any.

### The opening

Where the loop starts is the first thing you hear, so it's the first thing that
has to differ between one variation and the next. Flip relocates the entry
point to another bar line in roughly two thirds of variations at default
settings - eight alternatives that all begin identically read as one result,
however different their middles are.

**Structure** still protects the opening, it just no longer protects it almost
absolutely, and the batch deliberately spreads: the first variation in a batch
is always the most faithful one.

### Three controls, not one

A single "intensity" slider conflates three different musical intentions.
These are separate because you want them in different combinations:

| | |
| --- | --- |
| **Structure** | How much of the large-scale shape survives. High keeps bars where they are, protects downbeats and the opening, borrows material from nearby, and pushes edits to finer scales so they happen *inside* the existing structure. Low lets bars move, repeat and be substituted wholesale, and takes edits off the beat grid entirely. |
| **Activity** | How often Flip intervenes at all. Low leaves whole bars untouched. |
| **Depth** | How far any one intervention goes. Low substitutes a neighbour or repeats a beat; high jumps across the phrase, subdivides into micro-slices, reverses and reaches for wider intervals. |

So **Structure 85 / Activity 25 / Depth 75** gives you something recognisably
your phrase, mostly left alone, that occasionally does something dramatic -
which is not expressible with one slider at all.

### Remix types

Not effect presets. A type changes which hierarchy levels are worked at, which
families of transformation are reached for, where in the bar it prefers to
intervene, and how it bends your three settings. Two types on identical
settings produce structurally different music.

| Type | What it does |
| --- | --- |
| **Gentle** | Barely touches it. Repeats a beat, substitutes a neighbour, leaves most of the loop alone. |
| **Groove** | Rhythmic reinterpretation - beats and half-beats move around inside bars that stay put. |
| **Phrase** | Large-scale restructuring. Bars and half-bars move, repeat and answer each other. Best on melodic material. |
| **Fill** | Leaves the loop alone and adds fills - rolls, repeats and reverses at the ends of bars and the end of the phrase. |
| **Repeater** | Builds motifs by repeating what's there - beats, half-bars, groups. Not stutter. |
| **Cut-up** | Aggressive small-scale rearrangement. Where the glitchier end of Flip lives. |
| **Reconstruct** | Rebuilds the phrase. Bars and beats change places. |
| **Wild** | The whole vocabulary at every scale at once. Expect to throw most of these away. |
| **Mixed** | A bit of everything at every scale, still trying to sound like a version of your loop. The default. |

### The transformation vocabulary

Every operation declares a **family** and the **scales** it makes sense at, so
the same idea - repeat, reverse, substitute - is written once and applied to a
bar, a beat or a single slice depending on what was chosen.

- **Structural** — repeat, repeat half, substitute a neighbour, swap halves,
  jump, return to an earlier motif, A/B/A, call and response, relocate the
  entry point, and *preserve* (doing nothing, deliberately and on the record).
- **Micro** — rearrange inside a node, repeat the tail, reverse a group,
  reverse a slice, stutter.
- **Break** — drop out, cut a rhythmic gap.
- **Roll** — its own family and its own pass.
- **Pitch** — a decoration pass over what the arrangement produced.

Operations compose: call-and-response can answer itself with a reversal, a
stutter or a rest - but only ones the chosen type would reach for anyway, so
Repeater never silences anything and Gentle never micro-edits.

### Roll

Roll is a first-class transformation, not a synonym for stutter. It takes one
fragment and repeats it rapidly to fill a fixed region of musical time, at a
rate expressed relative to the slice grid so it stays musical whatever the
slice size is:

- **coarser than a slot** — the roll repeats a *group* of whole slots (a 1/8
  roll on a 1/16 grid)
- **finer than a slot** — each slot is subdivided into 2, 3, 4, 6 or 8
  fragments (1/32, 1/64 and beyond), which is Flip's micro-slicing, now with a
  musical reason to be where it is

Rolls vary in length (a beat, half a beat, a short burst), can run backwards,
and can accelerate by doubling their rate as they go. They are placed by
**musical position** in a pass of their own, independently of wherever the
structural walk happened to be: a roll belongs at the end of a beat, a bar or
the phrase. **Fill** weights those positions enormously; **Wild** doesn't care.
Two rolls are never allowed to overlap.

A roll always *replaces* the time it occupies. It cannot lengthen anything.

### Pitch, and the key

Flip reuses the app's existing key detection rather than growing a second one,
and constrains transposition to the detected key. Moving a fragment by an
arbitrary chromatic amount is not a musical accident, it is just wrong notes -
in A minor, up three semitones lands on C and belongs; up one lands on A# and
does not.

The unit is **scale degrees**, not semitones, so a third is a third whether it
happens to be three semitones or four.

**It favours chord tones, not small movements.** This is the opposite of the
obvious rule and it matters: transposing a *sampled* fragment leaves the rest
of the loop where it is, so the moved fragment has to agree with harmony that
is still sounding. That makes thirds, fifths, fourths and octaves the useful
intervals - they're consonant against whatever the loop is sitting on - while a
second or a seventh is a passing note: the smallest move on paper and the most
dissonant one in practice. About 80% of the weight sits on chord tones. (An
earlier version weighted the second highest of all, which is exactly why in-key
shifts still sounded like wrong notes.)

**Repeats become sequences.** A sequence - restating a figure transposed by a
consistent interval each time - is the oldest melodic development technique
there is, and it's the difference between four transpositions of a fragment and
a line going somewhere. Descending thirds, ascending thirds and descending
fifths are the strongest; ascending steps read as a build. A figure repeated
four times can come back as `root / third / fifth / seventh` - an arpeggio built
out of your own loop.

**Pitch modes:** `Off`, `Octaves` (always safe - an octave is the same note),
`In key` (scale-degree moves inside the detected key), `Mixed` (in-key plus
octaves, with the occasional deliberate surprise once Depth is high).

**Pitch covers musical spans**, not scattered single slices. Its targets are
rolls (which can rise or fall through the scale as they go), repetitions (which
become sequences), and **whole bars or half-bars** - "bar 3 is bar 3, a third
down" is an obvious, instantly musical variation that needs no repetition to
hang off. Over 85% of transposed slices are part of a transposed span.

In **Octaves** mode the sequences are constrained too, so "octaves" means
octaves everywhere, including inside a melodic shape.

**Pitch amount** keeps it a minority of the loop - it works best as an accident
you notice, not as a wash. The detected key is shown next to the tempo and both
the root and the mode can be corrected; detection gets the mode wrong often
enough that this matters.

### Batch diversity

Eight seeds on one set of parameters explores one region of the space eight
times: the details differ, the character doesn't, and you conclude Flip has one
trick. So each slot in a batch gets a **profile** - a modest push in a
different direction. One variation stays close to the original, one leans on
phrase rearrangement, one goes after pitch, one leaves almost everything alone
and does one big gesture, one fractures at every scale.

Profiles *lean*, they don't override: with Activity at 10, nothing in the batch
will come back busy. The order is reshuffled per batch so pressing GENERATE
again deals fresh, but slot 1 is always the most faithful one - the top of the
list is where you look first.

### Timing: the exported file is always exactly as long as the original

This is structural rather than something the code checks afterwards. A
variation is a list of instructions with **exactly one instruction per slice of
the original**, and the renderer writes each one into its own pre-computed
window. There is no path through it that can produce a longer or shorter file,
whatever a repeat or an eight-way roll asked for.

So a four-bar 120 BPM loop comes back as a four-bar 120 BPM loop. Drag it into
Logic and it occupies the same four bars.

### Clicks, gaps and levels

Flip rearranges audio; it should not damage it. The naive fix - a fade in and
out on every slice - dips the level at every boundary and blunts every attack
that lands on one, which is exactly what makes chopped-up audio *sound* chopped
up. Instead:

- A boundary where the incoming audio genuinely continues the outgoing audio is
  left completely alone. **Stretches you didn't edit come out bit-identical to
  the original**, including an untouched loop seam.
- An edit boundary gets a real crossfade, about 1.5ms, using **pre-roll**: the
  source samples that naturally precede the incoming slice. The crossfade
  finishes *at* the boundary, so the incoming attack is at full level and
  completely untouched.
- Boundaries are counted at fragment level, not slice level. A roll is several
  hard splices *inside* one slice and they click just as loudly.
- Pre-roll that falls off either end of the file wraps around, because the
  source is a loop.
- Crossfades are linear, not constant-power, because Flip's two sides are often
  the same material (a repeated fragment crossfading into another copy of
  itself) where constant-power overshoots and clips.
- Transposition uses the app's existing duration-preserving pitch shifter, not
  a playback-rate change, and is applied to whole contiguous regions at once. A
  transposed region is level-guarded back to the level it came in at, and the
  shifter is given extra audio past the region so its tail artefact lands in
  samples that get thrown away.
- Silence from a drop-out is written zeros, crossfaded in and out like anything
  else. It's a deliberate rest, not a hole.

### Seeds

Every variation shows its seed, and the seed box is an input, not a label. The
same **source + settings + key + seed** always produces the same arrangement,
so a take you liked is recoverable: write the number down (or read it off the
exported filename), type it into any row, press Enter, and it comes back.

All the randomness in Flip runs through one seeded generator - the same
`mulberry32` used by the creative time-stretch engines. The only
non-deterministic thing in the whole feature is where the seeds themselves come
from.

### Regenerating one at a time

Seven good ones and one dud shouldn't cost you the seven. The **⟳** button on a
row replaces just that variation, in place, keeping its profile.

Changing a setting doesn't throw the batch away either - the existing
variations stay playable and are flagged **settings changed**.

### When the tempo is wrong

The detected tempo *is* the slice grid, so a half-time reading doesn't just
mislabel the file, it halves the resolution of every variation. Flip reuses the
app's detection with the same **analysis proposes, user overrides** correction
Stretch has: type a tempo, or use **½** / **×2**.

Two things happen automatically:

- **The grid prefers a whole number of bars.** Detection is rarely exact - a
  true 120 BPM four-bar loop comes back as 119.87 and asks for 256.3
  sixteenths - so when a whole-bar count is within reach the grid snaps to it
  and is then fitted to the file's exact length. This is what keeps bar-level
  operations lined up with the music.
- **When nothing musical is within reach, it says so.** A file that comes out
  as 3.13 bars is almost always a detection failure rather than a strange loop.

If there's no confident tempo at all, Flip divides the loop evenly into four
bars' worth of slices and says so.

### Export

Each variation exports as a WAV at the source's own sample rate and channel
count, at 24- or 16-bit, and at exactly the original length. **Export all**
writes the whole batch - to a folder you pick (Chrome/Edge) or as a zip
(everywhere else).

Names carry the seed, which is the point of putting it there:

```
Dusty Piano Cm 80 BPM_FLIP_03_seed458577206.wav
```

### Limits

- One loop at a time. Flip is not a batch tool; it's a slot machine.
- It rearranges **time and pitch**, not tempo. Nothing is time-stretched - use
  **Stretch** or **Play nice** for that.
- Chops are capped at 512 per loop, so a very long file at `1/32` will be cut
  more coarsely than the setting implies.
- At whole-bar chops only single-bar moves are possible, since a bar is the
  atom. One size finer (`½ bar`) brings grouped movement back.
- It assumes 4/4.
- Pitch needs a region of at least ~1024 samples to shift, so transpositions on
  extremely short micro-fragments are skipped rather than smeared.

## Quick start

**You must serve this folder over local HTTP - do not just double-click
`index.html`.** Chrome (and other browsers) refuse to load this app's
JavaScript at all from a `file://` URL, which makes every button on the page
silently do nothing. The page will detect this and show a red banner if you
open it the wrong way. (This only matters for running it locally - the
live GitHub Pages link above is already served correctly.)

Pick whichever of these you have available and run it from inside this
folder:

```
python3 -m http.server 8000
```

or, if you have Node:

```
npx http-server -c-1 .
```

Then open the URL it prints (typically `http://localhost:8000`).

## Using it

Pick a task first: **Chop**, **Stretch** or **Both**. Chop and Both add a
**Source material** section to the Settings rail (Horns / Rhodes / Drums);
Stretch never cuts anything, so that section unmounts entirely rather than
sitting there disabled.

Then either **Add folder** (repeatable, to build a multi-folder batch),
**Add files** (pick one or more loose audio files), or drag a folder or
audio files from your file manager and drop them anywhere on the page. The
first audio you add to an empty batch, by any of those methods, processes
itself automatically - no separate "now click Process" step. In Chop,
dropping something into an already-populated batch runs a full Export
straight away instead; every other case (Stretch, Both, or a batch that
already has results on screen) just processes so you can look before you
commit.

From there it's two buttons:

- **Export** runs the batch and writes it. If you trust the detection, this
  is the whole workflow.
- **Process** does the same work and saves nothing. You get every waveform
  with its cuts marked, a player for every chop and one-shot, and a live
  editor. Drag boundaries, select a slice and hit Space to hear it, Delete to
  remove it, double-click to add one - every edit is live the instant you
  make it, so there's nothing to remember to commit before hitting
  **Export**. Untick **export one-shots** on any file whose hits came out
  badly, then hit **Export** when you're happy. Export reuses what Process
  already worked out, so it doesn't redetect.

Everything else is behind the **Settings** button, which opens a rail down
the left, open by default. What's in it depends on the task: Chop gets
source material, naming, detection and export; Stretch gets naming, export,
time-stretch and lo-fi (with stretch itself always on, since stretching is
the entire point of that task); Both gets source material plus all of it,
with time-stretch back to being optional. Auto detection is on by default,
so you can go straight to Export - untick **Auto** in the Detection section
if you want to adjust the parameters first.

If a folder you add contains several session subfolders rather than audio
files directly, tick **"Split into one batch per subfolder"** before
adding it, and each qualifying subfolder becomes its own independent batch
entry with its own `wav/`/`chops/` output, instead of everything being
flattened into one.

For individual files: in Chrome/Edge you'll be asked to pick a destination
folder the first time (there's no way for a browser to write back next to a
loose file without asking) - that choice is remembered for the rest of the
session.

Pick **Stretch** instead of **Chop**/**Both** if you don't want the file cut
up at all - key/tempo detection, the `wav/` copy, and any time-stretch/lo-fi
processing you've turned on still run, just nothing gets chopped. In Chop
or Both with Drums selected, the Source material section in the rail grows
a **chop length** in bars (converted to seconds from the detected tempo)
and an opt-in checkbox to also pull out one-shot hits into a `one shots/`
folder alongside the usual break-length chops.

The **Output naming** panel controls how chop files are named: type a
pattern using `{name}`, `{tag}` and `{number}` tokens (e.g.
`{name} {tag} {number}` or just `{number}`), pick the separator used
inside the auto-generated key/tempo tag, and a live preview underneath
shows exactly what that'll produce. Independent of mode. Your choices
(and most other settings) are remembered in this browser between visits.

Once a file has processed, its result card shows its waveform live and
ready to edit straight away - no separate edit mode to enter. A file with
both chops and one-shots gets a **Chops** / **One-shots** switch above it;
editing one set never disturbs the other. Drag a handle to move a cut
point (released, it snaps to the beat grid on tempo-locked drum chops and to
the nearest zero-crossing otherwise), scroll or
use the Zoom in/out/Fit buttons to work at finer detail, drag the
waveform itself to pan around once zoomed in, and hit **▶** to hear a
selected chop before you commit. Below the waveform, **Revert** discards
edits back to the last detection/re-chop, **Export selected** exports just
the one selected chop without touching any others already on disk, and
**Update previews** re-renders the audio players below with your edits (a
convenience for auditioning in-browser - Export doesn't need it, since it
always cuts from your current edits regardless). The **Re-chop** row lets
you throw the current chops away and generate a fresh set by count or by
bars, or clear them entirely to build your own from scratch. The optional
**Time-stretch** and **Lo-fi character** sections
(in the Settings rail) both apply to every export in the batch, not
per-file: turn time-stretch on, pick a mode (match a target tempo, or a
fixed ratio) and a character, and it's baked into every chop as it's
exported - including a manual re-export from the editor - plus a
full-length processed copy of each source file. The lo-fi stages
(output-stage character, drive, crunch) stack the same way and share that
full-length copy: when time-stretch and lo-fi are both on, you get one
combined `<name> stretched lofi.wav`, not two separate files. **Processing
scope**, right below, decides whether that chain also touches one-shots,
and whether a raw unprocessed copy gets written alongside the processed
one.

In the Stretch task specifically, the character grid has a small checkbox
on every card, separate from clicking the card itself to audition it.
Checking a card queues that character for a **multi-variation export**:
hit Export with, say, Glitch, Vintage and Tight all checked, and instead of
the one processed copy you'd normally get, every included source writes
one file per checked character into a `variations/` folder - `<name>
Glitch.wav`, `<name> Vintage.wav`, `<name> Tight.wav` - all in a single
run, at whatever stretch ratio and lo-fi settings are currently set (those
stay shared across every variation; only the character differs between
them). The card you have selected for on-screen audition is completely
independent of what's queued - preview one thing while exporting a batch
of others, or leave nothing checked to fall back to the single derived
copy exactly as before. **Clear** next to the character grid empties the
queue in one click; unchecking everything does the same thing one card at
a time. Re-running Export against a shrunk queue cleans up any variation
files from a previous run that are no longer checked, the same way a
shrinking chop count already tidies up `chops/`.

## Deploying to GitHub Pages

1. Push this folder to a GitHub repo.
2. In the repo's Settings → Pages, set the source to the branch/folder
   containing `index.html` (root, or `/docs` if you move it there).
3. GitHub Pages serves over HTTPS automatically, which is required for the
   File System Access API and for Web Audio use - no extra configuration
   needed.

No build step, no bundler, no dependencies to install - it's a static site.

## Output: direct-to-folder vs. ZIP

- **Chrome / Edge** (and other browsers supporting the File System Access
  API): chops are written straight into each source folder's `wav/` and
  `chops/` subfolders. The first time you add a folder, the browser will
  ask you to confirm read/write access to it.
- **Safari / Firefox** (no File System Access API): there's no way for a
  web page to write directly to your filesystem in these browsers, so the
  whole batch is bundled into one ZIP file for you to download and unzip
  wherever you like. The ZIP mirrors the exact same folder structure a
  direct-write run would have produced.

The app detects which mode it's in and tells you at the top of the page.

## Folder layout

```
Source Folder/
    original source files
    wav/       <- 24-bit WAV copies of any non-WAV source (WAV sources aren't duplicated here);
                  also holds a full-track processed copy whenever time-stretch and/or a lo-fi
                  stage is on, named "<name> stretched.wav", "<name> lofi.wav", or
                  "<name> stretched lofi.wav" depending on which are active - UNLESS one or more
                  characters are queued in the Stretch workspace's character browser (see below),
                  in which case this single derived copy isn't written at all and variations/
                  (next) takes over instead
    variations/                         <- only in the Stretch task, and only once at least one
        <source file name> C#m 120bpm/     character is queued for export in the character
            <name> Glitch.wav               browser - one file per queued character, instead of
            <name> Vintage lofi.wav         the single derived copy wav/ would otherwise hold.
            ...                              Queuing zero characters (the default) reverts to
                                             that single wav/ copy - the two are never both
                                             written for the same source in the same run.
    chops/
        <source file name> C#m 120bpm/
            01.wav
            02.wav
            ...
    chops clean/                        <- only when "Keep an unprocessed copy" is on and
        <source file name> C#m 120bpm/     processing is actually active; same file names as
            01.wav                         chops/, but the raw pre-stretch/lo-fi audio
            02.wav
            ...
    one shots/                          <- only when the drums one-shot option is on
        <source file name> C#m 120bpm/
            01.wav
            02.wav
            ...
    one shots clean/                    <- only when one-shots are also in Processing scope
        <source file name> C#m 120bpm/     and "Keep an unprocessed copy" is on
            01.wav
            02.wav
            ...
```

The `C#m 120bpm`-style tag is plain text (no brackets or commas) and is
appended to the containing folder name by default, not repeated on every
numbered chop, since key and tempo are detected once per source recording
and every chop from it shares the same tag - see **Output naming** above for
the options to change the separator, or drop the tag from the folder name
entirely. It's only added when detection actually succeeds - if key/tempo
detection is off or unavailable, names just keep their plain form.

Re-running a folder deletes and replaces its previously-generated numbered
chops and one-shots (anything you've renamed or added yourself is left
alone).

## Format support

`.wav` and `.aif`/`.aiff` are parsed by hand-written readers built into this
app, so they work identically and reliably in every browser at the source's
original sample rate and bit depth - no dependency on what the browser
happens to support natively.

`.mp3`, `.m4a`, and `.flac` go through the browser's built-in audio decoder
(`decodeAudioData`). Support for these varies a little by browser - Chrome
and Firefox are the most permissive, Safari is pickier about FLAC in
particular. If a file can't be decoded, you'll see a clear error for that
file in the log and the batch continues with everything else; it won't fail
silently.

## Parameters

**Sax/Trumpet and Rhodes** share the same pipeline: gate the file into runs of
playing, then cut those runs where a phrase actually ends - a dip in the line
followed by a fresh attack - placing each boundary on the note, to the sample.
Anything still longer than the maximum gets the most phrase-like boundary
available inside it. Phrase length follows the playing; *Preferred phrase
length* only decides roughly where an over-long stretch is broken.

- *Silence sensitivity* - how many dB above the file's own measured noise
  floor counts as "still silence." Lower = only near-total silence breaks a
  phrase (good for Rhodes, so a chord's decay doesn't get treated as a gap).
  Higher = more readily splits on quieter moments (good for horns, so
  breaths register as phrase breaks).
- *Minimum silence to count as a gap* / *Bridge gaps shorter than* - protects
  against a short breath or the gap between chord attacks fragmenting one
  musical idea into several.
- *Minimum/preferred/maximum phrase length* - target lengths; only the
  "maximum" is a hard cap, and even then the actual cut point is chosen at a
  natural low-energy moment nearby rather than exactly at the cap.
- *Padding* - extra room left on each side of a detected phrase before
  fade/zero-crossing snapping happens.

**Drums** walks the file in chunks sized from the chosen **chop length in
bars** and the detected tempo (falling back to a fixed length if no
confident tempo was found), snapping each boundary to a nearby detected
transient (or the quietest nearby point if none is found), then - if "snap
to tempo grid" is on and a confident tempo was detected - nudging that
boundary onto the nearest **bar** line, so the chop's length is a whole
number of bars. *Onset sensitivity* is the one manual knob left for drums,
behind Auto like everything else.

#### Chopping on the bar line

Three things have to hold before a chop actually loops, and snapping alone
only buys the first.

**Every chop is a whole number of bars.** Beat snapping is not enough: a
boundary can be a whole number of *beats* from the last one and still land on
beat 3, which loops as audio but not as music. And the first boundary has to
be on the grid too - starting the walk at t=0 regardless made chop 1 the one
chop in the file guaranteed not to loop, since it ran from 0 to the first
grid line plus N bars.

**The grid's phase is accurate to the sample.** This is the one that bites.
The phase used to come from the first detected onset, which is read off a
10ms-hop RMS envelope and timestamped at its window's start - so it is
quantised to 10ms before anything else goes wrong, and lags the attack that
produced it. On a real 128 BPM bounce that put the grid 10ms late: past the
*peak* of the downbeat kick. Every chop then opened mid-kick with its
transient sliced off and closed with the first few milliseconds of the next
kick glued to its tail, so looping it flammed on every cycle even though the
chop was an exact 8 bars long.

The first onset alone cannot fix that, because the first hit in a file is
routinely a few milliseconds later than the rest - a fade-in on the bounce, a
softer opening hit. So every bar votes: at each bar line predicted from the
coarse anchor, the loudest sample nearby is walked back to where its attack
begins, and a **low percentile** of those offsets becomes the correction. Low,
not the median, deliberately - cutting a hair early costs a millisecond or two
of the previous bar's decaying tail and is inaudible, while cutting late
destroys a transient. When the two errors are that lopsided, aim early. The
whole correction is bounded to a 32nd note and needs several agreeing bars, so
material with no clear downbeat keeps its coarse anchor rather than being
shoved somewhere the noise floor pointed at.

**Nothing downstream rounds the length off.** See Click-free boundaries: the
export fades and the zero-crossing snap are both bypassed on bar-locked chops,
because both of them break a loop rather than clean it up.

**One-shot extraction** (drums, opt-in) finds the same onsets, trims each
hit to where it decays back toward the noise floor (or the next onset,
whichever comes first, capped around 1.2s), then sorts each hit into a
rough kick/snare/hat/cymbal/perc bucket from its low/mid/high energy
balance and duration, purely so hits that look like repeats of the same
sound can be deduplicated - keeping only the loudest few per bucket, so a
break with the same kick sample hit forty times doesn't produce forty
near-identical files. The bucket itself isn't reliable enough to trust in
a filename, so the kept hits are written out as plain sequential numbers.

**Export settings** (all modes): fade length and zero-crossing search window
control click protection at every cut; export bit depth is 16 or 24-bit. Both
click-protection settings are bypassed on bar-locked drum chops, where they
would break the loop rather than clean it up - see Click-free boundaries.

All of the above are hidden behind **Auto** by default (see Features) -
they're only relevant once you switch to manual tuning. None of these
values are "correct" in some absolute sense - they're reasonable starting
points. Turn them up or down and reprocess; nothing is destructive to your
original files.

## Licensing note on essentia.js

Key and tempo detection uses [essentia.js](https://github.com/MTG/essentia.js),
loaded from a CDN, which is licensed **AGPL-3.0**. That's a network-copyleft
license: if you deploy an app using it publicly, the corresponding source
must be available to anyone who uses it over the network. A public GitHub
Pages repo (source visible in the repo that serves the Pages site) already
satisfies that. It's worth knowing about if you ever want to keep a fork of
this app closed-source - in that case, dropping essentia.js for a
permissively-licensed alternative (e.g. a standalone BPM-detection library)
would be the way around it, at the cost of losing key detection specifically
(BPM-only alternatives are easier to find than good in-browser key detection).
See `THIRD_PARTY_NOTICES.md` for the full breakdown, and `LICENSE` for this
repo's own (MIT) license.

## Testing

The core detection algorithms, the WAV/AIFF codec, the folder/file grouping
logic and the whole of Flip's remix engine are pure functions with no browser
dependencies, so they're unit-tested with plain Node. `flip-render.test.mjs`
is worth knowing about: it asserts the two promises Flip makes about audio -
that a variation is always exactly as long as its source, and that
rearranging it introduces no clicks, gaps, level changes or clipping. `contrast.test.mjs` is the odd one out: it
parses the palette straight out of `css/style.css` and asserts every text
role against the surface it actually sits on, so a re-tint that drops a
label under 4.5:1 fails here rather than shipping.

```
node --test test/*.test.mjs
```

or individually:

```
node test/dsp.test.mjs
node test/io-fs.test.mjs
node test/timestretch.test.mjs
node test/outputstage.test.mjs
node test/contrast.test.mjs
node test/pitch-shift.test.mjs
node test/play-nice-conform.test.mjs
node test/play-nice-key-matching.test.mjs
node test/play-nice-naming.test.mjs
node test/play-nice-downbeat.test.mjs
node test/flip-recipe.test.mjs
node test/flip-render.test.mjs
```

There are also a few optional browser-integration tests that exercise the
real essentia.js/JSZip pipeline, the page's DOM wiring, and (for
`run-e2e-check.mjs`) a full process-a-file run through the actual UI, in a
real browser (requires the `playwright` package):

```
npm install --no-save playwright && npx playwright install chromium
npx http-server -c-1 . -p 8877 &
node test/run-smoke.mjs
node test/run-ui-check.mjs
node test/run-e2e-check.mjs   # needs a fixture WAV - see the file's header comment
```

## Upgrading to v0.9 Beta

**Time-stretch output changed for the WSOLA-family characters** (Clean, Tight, Vintage,
Glitch, Choppy, Warped, Crushed, and the two Stutter characters). This is a bug fix, not a
retune: the engine accumulated its similarity search's forward nudges into its read
position, so it ran out of input while the output buffer was only part-written - a stretched
break came back the right *length* with silence on the end - and the same compounding drift
pulled the result off the beat by 70-240ms. Both are fixed, and every character's window,
search radius, hop and bit depth are untouched.

That means **STRETCH renders differently in this release than in v1.1**, and better, but differently.
A saved character will sound like the same character; it will not be sample-identical.

## Known limitations / natural next steps

- Detection/analysis (silence and onset finding, key/tempo detection) still
  runs on the main thread and yields between files so the page stays
  responsive; only the heavy per-chop work (time-stretch, lo-fi, WAV
  encoding) has been moved into a Web Worker so far. A very large batch
  (hundreds of long files) will still feel slower than a native app during
  the analysis phase. Play nice's *rendering* does run in that worker, but
  its analysis shares this limitation.
- **Tempo detection reports one number for a whole file.** Everything in the
  app, Play nice included, assumes a loop has a single constant tempo. A loop
  that drifts, rubatos or changes tempo part-way will be conformed as if it
  didn't, and no amount of correcting the source BPM fixes that - the fix
  would be beat-tracking and warping, which is a much bigger feature.
- **Key detection reports one key for a whole file, and only major/minor.**
  A loop that modulates gets a single answer; modal, chromatic and atonal
  material gets an answer that may be technically defensible and musically
  useless. That is exactly why every detected key in Play nice is editable and
  why "No key" exists per loop.
- **Play nice conforms notes, not harmony.** Match scale gets a loop into the
  target's pitch collection, but a recording keeps its own tonal centre - a
  minor loop over a major target reads as the relative minor, not the major.
  Modal interchange, dominant/subdominant relationships and "nearest key that
  shares a scale" are further strategies the registry in
  `js/play-nice/key-matching.js` is built to take.
- **The browser-integration checks don't know about PLAY NICE.** `test/run-smoke.mjs`,
  `run-ui-check.mjs` and `run-e2e-check.mjs` still only exercise CHOP, and they need
  `playwright` installed to run at all. The Node suite covers PLAY NICE's logic and DSP
  thoroughly, but nothing automated opens the task and clicks through it.
- **The reference pane duplicates a card.** Now that any loop can be promoted, the Target
  panel's own waveform and transport show a loop that is also in the list below.
- **No undo.** Remove and Clear both confirm now, which covers the destructive cases, but
  there is no undo stack the way CHOP has one for edits.
- **Alignment can only help material with audible attacks.** Pads, drones, soft-attack
  arpeggios and heavily reverbed material give the grid correlation nothing to lock onto,
  so they are deliberately left untouched (`no clear beat - left as-is`). If such a loop
  arrives with real slop on the front, PLAY NICE cannot detect or fix it - trim it first.
- **Downbeat alignment assumes a steady tempo and a subdivision grid.** It corrects slop
  against a sixteenth-note grid at the loop's own tempo, which is the right model for
  loops and the wrong one for rubato, swung sixteenths finer than the grid, or anything
  whose first phrase enters somewhere unquantised. Those are left alone rather than
  guessed at, which is the safe failure, but it does mean PLAY NICE cannot rescue a loop
  that was never on a grid to begin with.
- **The WSOLA-family methods are the loosest of the palette.** Clean, Tight and Vintage
  hold the grid to within about 10-20ms where the phase-vocoder characters manage 0-3ms.
  That is a property of splice-based stretching, not a defect, and the card measures and
  reports it - but if you want a loop locked, Transient and Punch are the safest.
- **Bar snapping assumes a loop is a whole number of beats.** True of loops,
  false of one-shots, breakbeats with a tail, and anything with silence padded
  onto the end - those are left unsnapped (the card says `not snapped`) and
  keep whatever tempo detection gave them, so a mix containing them can still
  drift. Trimming to the loop point is the fix, and Chop is where that would
  live.
- **Extreme conforms sound extreme.** Stretch-then-resample pitch shifting and
  large tempo ratios both degrade; a loop needing 1.5x stretch and five
  semitones will sound like it. Play nice flags likely octave errors precisely
  because most "this sounds terrible" results are actually a wrong source BPM.
- Play nice's **TRY ALL** - run one loop through every stretch method and
  audition the variants - isn't built, but the architecture is ready for it:
  the method is an explicit parameter of a conform plan rather than something
  the conforming logic chooses, so it's a loop over `methodKeys()` building
  one plan each.
- Play nice's **one-shot** input role is declared and planned for
  (`js/play-nice/roles.js`) but the generator that would arrange a pile of
  one-shots into a phrase at the target tempo and key doesn't exist yet.
- Zero-crossing snapping uses a single reference (the mono mix) so all
  channels of a stereo file cut at the same sample - this keeps channels
  aligned but means the snap isn't independently optimal per channel.
- One-shot classification is a simple band-energy/duration heuristic, not a
  trained model - it's a reasonable sort for kick/snare/hat/cymbal-ish
  sounds for grouping repeats, but will mislabel unusual or layered hits;
  that's why it's used internally for dedupe only and never shown in a
  filename. Always worth a quick listen through the `one shots/` folder.
- Time-stretch and the lo-fi stages are each one setting for the whole
  batch, not per-chop; proper per-chop controls would need the editor
  built out further first (a deliberate choice for now, not a gap).
