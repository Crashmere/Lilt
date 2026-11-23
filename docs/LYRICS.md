# Lyrics Workbench

The lyrics workbench combines manual editing, audio-assisted timing and an optional offline Chinese/English singing aligner. It uses the existing track, player, browser storage and metadata publication paths. Model output is a candidate: only an explicit save writes lyrics into the current audio. Production activation belongs to server-operations current-state; the presence of installer sources does not establish that the worker is installed on `nas`.

## Editing Workflow

Open `歌词工作台` from a track's More Features menu or the lyrics panel. The editor reads the complete track and its independent lyrics/audio content versions. Changes stay in the browser until `保存并写回` succeeds. Favorites, playlist membership, listening history and the logical track ID are preserved by the existing metadata writeback.

The row view supports line text/time editing, multi-selection, splitting at the text caret, merging adjacent selected lines, reordering, adding/deleting lines, search/replace, undo/redo and LRC/TXT import/export. Imports accept UTF-8 and BOM-marked UTF-16; other encodings require conversion before import. Source view permits editing the raw stored text. Returning to rows reparses the source and invalidates candidates whose row identities no longer match.

Times use milliseconds. Repeated LRC timestamps expand into editable rows. Unchanged single-timestamp lines and JSON credit records retain their source text; modified credit records retain other top-level fields and replace their displayed fragments. Standard metadata headers remain available in source view. A nonzero document offset serializes as one LRC `offset` header. Same-time adjacent rows are initially linked as translations; linked rows follow the preceding row's start and are excluded from model alignment.

Enhanced LRC uses `<mm:ss.mmm>` word starts. Existing word starts move with their line, and model word intervals can become enhanced LRC. The editor exposes each word's start for correction; the LRC export stores starts, not a separate end-time format. Ordinary playback groups same-time rows and highlights completed word starts. Plain or partially timed lyrics retain the existing plain-text playback behavior.

## Manual Calibration

The workbench auditions through the mounted global player rather than creating another playback engine. Audition saves the current queue position, leaves the queue intact, suppresses audition listening history and browser playback-state writes, and restores the queue paused on exit. Explicit previous/next or a new queue playback ends audition. Normal playback is never resumed audibly merely by closing the editor.

Opening starts a cancelable full-original download without playing audio or waiting before editing. Files up to 128 MiB reuse the service worker's versioned sparse ranges and complete-file cache when its editor protocol is available; otherwise the browser requests the original directly. Editor demand fills the whole file even while audition is paused, with urgent ordinary playback taking priority. Received length and the current original ETag must match before a session-local Blob URL becomes available to the mounted player. The next explicit audition can use that URL without additional media requests; an already playing stream is not replaced automatically. Closing aborts unfinished work, removes editor demand, terminates the peak worker and revokes the Blob URL. Larger files retain streaming audition.

Waveforms contain 4,096 amplitude peaks. The browser decodes at 12 kHz through an OfflineAudioContext, with a 96 MiB decoded-PCM budget, then transfers channels to a dedicated worker for peak calculation. This decode is for visualization, not playback; audition still decodes the supplied original through the same media elements. Cached server waveforms remain usable, and unsupported decoding or files outside the browser budgets expose `服务器生成波形` through the existing FFmpeg worker. Failure to preload or generate peaks does not disable manual editing or streaming audition.

The waveform starts at 4x zoom and follows the media clock. Horizontal trackpad wheel gestures and Shift+wheel pan the view; vertical wheel input scrolls the pane and modifier/zoom gestures remain browser commands. Panning or dragging a marker disables waveform following until `跟随播放` is enabled again. Peaks, markers and the playback cursor have separate drawing layers; marker drags are coalesced into animation frames and only commit a document edit on release. The left list follows the current line and the next line after a stamp, while text entry and recent manual list scrolling defer playback-driven scrolling. Both panes expose independent follow controls.

Space controls workbench audition while the editor is open, including before the first audition; it never starts the outside queue. Text entry, IME composition and modifier shortcuts retain their normal behavior. A/B controls bound looping; audition rates are 0.5, 0.75, 1 and 1.25 with browser pitch preservation. Changing the speed does not alter saved timestamps. Browser visualization and the FFmpeg fallback use CPU; the singing model selects CUDA when available.

`K` stamps the first selected row at the current playback position and selects the next original row. It does not override text entry or IME composition. Selected unlocked rows can shift by 10, 50, 100, 200, 500 or 1,000 milliseconds. Overall offset shifts playback interpretation without changing each stored line start. Locking a row records its initial time as an anchor; after adjusting two or more locked starts, `锚点校准` interpolates existing intervening starts from the old anchor span into the new span. It does not invent times for untimed rows or extrapolate outside the anchors.

## Model Calibration

The engine is SOFA with the upstream Mandarin singing checkpoint and opencpop-extension dictionary, plus tigermeat's `tgm_en_v100` English singing checkpoint and its pinned pronunciation dictionary. Language routing is automatic. Chinese units are individual Han characters; English units are words, including apostrophe contractions and elisions. Case, whitespace and punctuation remain exactly as supplied in the candidate pieces. The worker aligns supplied text against supplied audio; it does not transcribe, rewrite lyrics, fetch lyrics or separate vocals. Numbers require their sung spelling because a written numeral does not identify its reading. Unsupported languages and dictionary misses produce an actionable error rather than silently dropping text.

`发音校正` accepts one space-separated entry per Han character or English word in order. Chinese entries are pinyin; English entries are dictionary spellings or unstressed ARPAbet phones joined with `/`. For example, `我 luv 你` can use `wo l/ah/v ni` without changing the displayed lyrics. A single explicit English phone can start with `/`, such as `/ay`. Leaving the field empty selects contextual pinyin and the English dictionary. Unknown proper names, unusual sung pronunciation and alternative dictionary readings may need this correction.

Single-language sections use their corresponding checkpoint unchanged. A mixed section evaluates both acoustic experts on the same features and frame clock, normalizes each expert over the selected native phones plus silence, and mixes their probabilities with equal language priors. Language-prefixed phone IDs keep distinct sounds separate; shared silence and averaged boundary probabilities feed one monotonic SOFA alignment path. This permits code-switching inside a line without inventing a language split time. Mixed candidates always carry a listening-review warning, and their scores are not directly comparable to single-language scores. Both pinned checkpoints must have identical feature configurations; incompatible replacements fail rather than resample logits or estimate word times.

`校准整首` uses the complete audio range. `校准所选行` uses the A/B range and selected original rows in document order. Locked starts split the monotonic search into sections and remain fixed. Neural evaluation uses bounded windows with overlapping context; the complete section still shares one alignment path. Sparse lyrics, long instrumental gaps, repeated refrains and accompaniment can require smaller selections or extra confirmed anchors.

The worker returns line starts, word intervals, a section confidence score and review warnings. Confidence is a model score, not a measured probability of timestamp accuracy. Candidates can be auditioned, applied individually, applied together or discarded. Changes to selected text, order, pronunciation, locks, offset, audio or raw source invalidate old candidates. Applying a candidate does not save it; the user can adjust it, undo it and audition before publication.

## Drafts And Conflicts

Drafts use the existing IndexedDB settings store, keyed by track and a sessionStorage tab identity. They include the document, source text, base versions and the current alignment receipt/input. Saving is debounced, and closing attempts a final draft write. Reloading the same tab can restore it; a new independent tab does not share that identity. Browser storage eviction or clearing can remove drafts. Export is available when durable local storage is unavailable.

Writes guard both `lyricsVersion` and `audioVersion`; stale writes return 409 and retain the draft. Unrelated favorite/history changes do not invalidate the lyrics version. `查看服务器版本` displays the current text. The user can load it, or confirm keeping the draft against the reviewed base for a later explicit overwrite. The server version is rechecked before this decision takes effect; a newer change requires another review. This is explicit conflict resolution, not an automatic text merge.

## Jobs And Limits

Jobs and heartbeat records live in the existing SQLite `settings` table. A queued job owns a same-filesystem hard link to the exact current audio in `data/analysis/`, so a later metadata publication cannot replace its input. The link is disposable and is not an edit revision. Success, failure and cancellation remove the input and owned inference staging; worker startup removes orphaned staging and marks interrupted running jobs as retryable errors. Queued jobs survive a restart. Only one worker holds the analysis lock.

| Bound | Value |
| --- | --- |
| Queued/running jobs | 8 across the catalog |
| Retained terminal job receipts | 64 after worker processing |
| Track job list | Latest 16 |
| Track duration | At most 30 minutes |
| Job deadline | 20 minutes |
| Selected original rows | At most 2,000 |
| Lyrics payload | At most 1 MiB |
| Alignment path | At most 60 million frame/phoneme cells per section |
| Neural window/context | 24 seconds / 3 seconds each side |

Manual editing, preloading, browser waveforms and native playback remain usable without a server worker. Server waveform jobs need the worker and FFmpeg; alignment also needs the isolated Python runtime, source and weights. No job introduces another HTTP port or public authentication exception. See [API](API.md#lyrics-analysis) and [NAS model installation](OPERATIONS.md#optional-lyrics-worker).

Acceptance used isolated synthetic audio with actual CPU inference on the maintenance computer and CUDA inference under the restricted `lilt` identity on `nas`. It verified English and mixed-language word candidates, contractions, exact text reconstruction, pronunciation correction and locked mixed-to-English-to-Chinese sections. Browser acceptance covered automatic language submission, candidate application and enhanced-LRC save; guarded writeback retained unchanged decoded audio samples. The existing waveform path also passed its synthetic acceptance. Synthetic speech is not an accuracy benchmark for real singing; accuracy on owner-provided songs remains unmeasured.
