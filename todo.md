# PDF Studio — todo & changelog

## Round 8 — a real viewer (2026-08-07) ✅

The preview existed but was reachable only by clicking the filename, which
nobody discovers. Made it a first-class feature.

- [x] **👁 View button in the file chip**, always visible while a document is
      open, with `aria-pressed` reflecting the panel state.
- [x] **View button on every applied-result card**, so the changed version can
      be checked before downloading it. The defang report gets it too.
- [x] **Lazy page rendering.** The panel used to draw up to 120 pages up front;
      now only what is near the viewport is drawn, on scroll. A 200-page
      document opens immediately.
- [x] Page count in the preview bar; each page keeps its `n / total` label.
- [x] `openPreview` / `closePreview` / `togglePreview` exported on the app API.

Bugs found while building it:

- [x] **The flex column was squashing every page.** `.preview-pages` is a
      column flex container, so the pages shrank to fit the panel height
      instead of making the list scroll — placeholders measured 49 px instead
      of 554 px. Fixed with `flex: none` on pages, placeholders and labels.
- [x] **Zoom did nothing.** `max-width: 100%` clamped the canvas, so 125 %
      still rendered at panel width. The panel now scrolls sideways when
      zoomed, and only clamps at 100 % or less (so no stray scrollbar there).
- [x] **The page counter pushed the close button out of the panel** on a phone.
      Counter is hidden below 560 px; every page is numbered anyway.

Verified: open/close toggle, zoom 75/100/125 %, the panel refreshing after an
edit (removing 2 of 4 pages updated it to “2 pages”), lazy drawing filling in
on scroll, EN/FR/NL labels, 360 px and 1400 px layouts, all 54 tools still
rendering clean, no console errors.

Correction to the round 6 notes: pdf.js *does* work in this environment — the
earlier "renderer cannot run here" conclusion was wrong, it was a wedged shared
worker caused by my own aborted calls. The time-boxes added then are still
worth keeping, but they were not compensating for a broken renderer.

## Round 7 — defang hardening (2026-08-07) ✅

A focused pass on the tool that makes a hostile document safe, because a
security tool that overstates what it did is worse than no tool at all.

- [x] **Catalog entries were cut before the object walk**, so a file
      specification sitting directly in the `/Names/EmbeddedFiles` tree became
      unreachable — and its payload stream was written out untouched. The walk
      now runs first; the catalog is tidied afterwards. Added a final sweep that
      empties any `/Type /EmbeddedFile` stream nothing points at any more.
      Verified: a 3 000-byte marker payload is absent from the output bytes.
- [x] **The attachment count was wrong.** Deleting the name tree *and* each file
      specification both bumped the counter, so one attachment was reported as
      “−2 embedded files”. Only real specifications are counted now.
- [x] **Metadata was always reported as removed**, even when there was none —
      `trailerInfo.Info` was cleared and counted unconditionally.
- [x] **The result is parsed before it replaces the working copy.** If the
      cleaned file cannot be read back, nothing is applied, the document is left
      untouched and the user is told so (`df_broken`).
- [x] **The headline now follows the verification, not the change log.** With
      options unticked the tool used to claim “The document has been
      neutralised” while two HIGH findings remained. Three honest variants:
      neutralised / partly cleaned / nothing to take out.
- [x] **Rasterise is time-boxed and checked.** It is the option the tool itself
      recommends for certainty, so a renderer that stalls or produces no pages
      now fails loudly and applies nothing, instead of spinning forever.
- [x] Page-count mismatch between pdf.js and pdf-lib guarded in the raster loop;
      disabled links de-duplicated and capped in the report.

Verified: hostile fixture (catalog `OpenAction`, catalog `/AA`, a
`/Names/JavaScript` tree, an inline `/A` URI action, `Launch`, `GoToR`, a
`Screen` annotation, page-level `/AA` and a real attachment) → `clean`, 0
findings, 0 scripts, 0 URLs, payload gone, banner cleared — identically in
EN/FR/NL with no raw keys, no overflow and no console errors. Orphaned indirect
actions (reachable only through an `/AA` that gets deleted) are also neutralised,
confirmed by marker strings being absent from the saved bytes.

## Round 6 — accuracy & usability audit (2026-08-07) ✅

A pass over every claim the app makes, checking that it is actually true.

### Correctness bugs found and fixed

- [x] **Inline actions were invisible to both the scanner and the defanger.**
      Both walked only top-level indirect objects, but writers normally put the
      `/A` action *inside* the annotation as a direct dictionary. Consequence:
      an ordinary phishing link survived “Disable clickable links” while the
      report cheerfully claimed the document was neutralised. Both now walk
      every reachable dictionary, direct or indirect.
- [x] **“Neutralised” is now verified, not asserted.** After defanging, the tool
      re-scans its own output and reports what is left. Either
      “✓ Checked afterwards: no active or risky content” or an honest list.
- [x] **Attachment payloads survived defanging.** Unlinking a file specification
      left the compressed stream in the bytes, so a “cleaned” document still
      carried the executable. The payload streams are now emptied.
- [x] **Removed annotations left recognisable objects behind**, so a re-scan
      still flagged them. Dropped annotations are now blanked.
- [x] **Attachment sizes were wrong** — the compressed stream length was shown
      as the file size. Now reads `/Params /Size` (5 000-byte file reported as
      5 000 bytes, not 43).
- [x] **A stalled renderer could hang the whole app.** `countPages()` waited on
      pdf.js forever; a malformed file therefore froze the workspace load *and*
      suppressed the risk banner. Now time-boxed with a pdf-lib fallback.
- [x] **The optional page-text sweep is time-boxed** too, and if it does not
      finish the report says so instead of silently omitting those links.

### Accuracy of what the user is told

- [x] **Severity retuned so the banner means something.** Plain external links
      dropped to `low`, JBIG2 to `low` (it is normal in scans). An everyday PDF
      with a link no longer raises a warning — a banner that cries wolf is a
      banner nobody reads.
- [x] **URL grading rewritten.** Every URL used to default to `medium` with no
      stated reason. An ordinary `https://` link is now `low`, and severity is
      only raised with a reason shown (IP address, punycode, credentials,
      shortener, odd port, payload extension). Verified against 12 cases.
- [x] **Plural grammar.** The banner literally read “1 external links · 1
      embedded files”. `PDFI18N.t()` now supports a `<key>_one` variant, added
      across EN/FR/NL for links, files, parts, matches, fields and ZIP entries.
- [x] **Compression’s target-size hint was misleading** — the quality ladder
      only exists in rasterise mode. Resolution and target size are now shown
      only in that mode.
- [x] **Sanitise vs Defang were described almost identically.** Sanitise is now
      “tick what to strip”, with a note pointing at Threat scan + Defang for
      files you do not trust.

### Performance

- [x] **The raw-byte census no longer runs on every edit.** It used to decode
      the whole file and `split()` it 16 times *per keystroke-level change*;
      it is now an `indexOf` loop behind an explicit `deep` flag used only by
      the Threat scan. Background banner scan of a hostile file: 11 ms.

### Layout

- [x] **The SHA-256 pushed the page sideways on a phone** (64 unbreakable
      characters, 312 px of horizontal overflow). Fingerprint table now wraps.
- [x] **The top bar collided with itself** once a file was open on a narrow
      screen — filename over the logo, and Download/Close pushed off-screen and
      unreachable. Below 430 px the file chip now takes its own row.

### Verified after the changes

- 54 tools × 3 languages render with no raw keys, no `undefined`, no overflow
- hostile fixture → `danger`, 11 findings → defang → `clean`, 0 findings,
  banner gone, payload confirmed absent from the bytes
- ordinary PDF with a link → `clean`, no banner
- core tools still work (extract 4→2 pages, remove 4→3, rotate, page numbers,
  metadata, sanitise, blank-page scan)
- three dictionaries at 603 keys each, matching placeholders
- assets `?v=3` = `sw.js V='3'`; no missing files; no duplicate tool ids;
  no `console.log`/`debugger`/TODO left behind

## Round 5 — security warnings & IR tooling (2026-08-07) ✅

A PDF is a program container, so the app now says so out loud.

- [x] **Automatic risk scan on every document** — runs on load and after every
      edit/undo. A banner appears when the file contains scripts, auto-run
      actions, embedded files or external links, in plain language
      (“3× JavaScript · 1 embedded file · runs something when opened”) with
      *Inspect* / *Make it harmless* buttons, and it disappears by itself once
      the document is clean. Reassures explicitly: nothing has run.
- [x] **Threat scan (PDF triage)** — new tool, cat. security:
      verdict + SHA-256 fingerprint; findings catalogue with severity and a
      one-line explanation of *why it matters*; document/action JavaScript
      shown as text with exploit indicators (`util.printf` → CVE-2008-2992,
      `Collab.getIcon` → CVE-2009-0927, NOP sleds, `unescape`, `launchURL`…);
      `/OpenAction`, `/AA`, `/Launch`, `/SubmitForm`, `/GoToR`, XFA, JBIG2,
      embedded files; **all URLs defanged** and rated (raw IP, punycode,
      credentials-in-URL, shorteners, unusual port, direct `.exe` links);
      pdfid-style raw keyword census; optional deep scan of visible page text
      (catches phishing links that are only printed, not linked);
      export as `.txt` report or `.json`.
- [x] **Defang (make harmless)** — new tool: empties every risky action
      dictionary in place (so even oddly-referenced actions die), removes the
      script catalogue, `/OpenAction`, `/AA`, attachments, media/3D annotations,
      optionally flattens forms + XFA and strips metadata, and disables
      clickable links while keeping the visible text. Optional “rebuild every
      page as an image” for certainty. Produces a change log and the defanged
      list of disabled links — the evidence trail an IR write-up needs.
- [x] Verified end-to-end on a crafted hostile PDF (doc JS + OpenAction JS +
      `/AA` + `/Launch` + IP/port/.exe link + embedded `invoice.exe` +
      printed phishing URL): **danger → 11 findings → defang → clean, 0
      findings, banner gone, page text still readable.**
- [x] Precision fix: hex-escaped names are only flagged when they decode to a
      keyword worth hiding — a legitimate `/application#2Foctet` MIME type no
      longer raises a false alarm, while `/J#61vaScript` still does.
- [x] Precision fix: file specifications without actual embedded data are no
      longer reported as attachments.
- [x] Version bumped to `?v=3` / `V='3'`.

## Round 4 — steganography, ZIP & production prep (2026-08-07) ✅

### New tools (47 → 52)

- [x] **Hide a secret (steganography)** — one tool, two directions:
      *Hide* a typed message or any file inside the current PDF, *Reveal*
      searches a document for data hidden by this tool.
      - Hiding place 1 — **inside the page image**: the chosen page is rendered
        to a PNG whose colour least-significant-bits carry the payload
        (invisible; the carrier resolution is picked automatically, capped at
        400 dpi so phones cope).
      - Hiding place 2 — **inside the file structure**: a hidden PDF object,
        pages untouched, no size limit worth mentioning.
      - Optional password → **AES-256-GCM** (PBKDF2-SHA256, 150 000 rounds)
        before hiding, so the secret is protected even once found.
      - Reveal reads the image streams straight out of the PDF and inflates
        them itself — pdf.js hands back an `ImageBitmap` that is not
        bit-exact, which silently broke the first implementation.
- [x] **Create a ZIP** — bundle the working copy and any other files into a
      real DEFLATE-compressed archive (`CompressionStream`), duplicate names
      auto-renamed, shows the compression ratio. Test: 6.4 KB → 1.3 KB.
- [x] **Open a ZIP** — read an archive, list its files, download them
      individually or all at once, and open any PDF inside it straight into
      the workspace. Handles stored + deflated entries, and explains
      password-protected/ZIP64 entries instead of failing silently.
- [x] **Table of contents** — build a contents page from the bookmarks, with
      leader dots, page numbers and **clickable links**; existing bookmarks
      are remapped to their new page positions.
- [x] **Print** — hand the working copy to the browser's print dialog
      (hidden `blob:` iframe) with an "open in a new tab" fallback.

### Also in this round

- [x] "Download all (ZIP)" everywhere now produces **compressed** archives
      instead of stored ones.
- [x] Results are cleared when a **different document** is opened — a stale
      "here is your extracted secret" card could otherwise linger.
- [x] Service worker ignores non-http(s) requests, so the print preview is
      never intercepted.
- [x] `zipRead` guards every entry (damaged offsets, ZIP64, unknown methods).
- [x] CSP gained `frame-src blob:` (print) — still no external origin anywhere.
- [x] **Production version bump**: `?v=2` in index.html + `V='2'` in sw.js.

## Still not added — and why

| Idea | Status |
| --- | --- |
| Batch mode (one tool over many files) | **Next up.** Biggest remaining win; needs a queue UI + per-file results. Especially useful for defanging a folder of samples. |
| YARA-style custom rules in the threat scan | Interesting for IR teams, but a rule engine + editor is a project of its own. |
| Hash lookup against threat-intel feeds | Deliberately not done: it would send a hash of your document to a third party, which breaks the promise that nothing leaves the device. The SHA-256 is shown so you can look it up yourself. |
| Saved signatures | Wanted, but storing a signature image in localStorage on a privacy-first tool needs a very explicit opt-in. |
| Deskew / auto-straighten scans | Feasible (projection-profile angle search); costs a full extra raster pass. Queued behind batch mode. |
| Multiple signature placements per pass | Small win, moderate rework of the placement widget. |
| Nested bookmark levels in the editor | Editor is one level deep; nested trees need a different UI. |
| Auto-rotate from text orientation (OSD) | Tesseract OSD data is not in the fast models we ship; would add ~10 MB. |
| Split on QR/divider sheets | Needs a QR decoder (+150 KB) for a niche workflow. |
| Visual (pixel) diff in Compare | Text diff covers most needs; pixel diff on rotated/scaled pages is noisy. |
| Recent-files / session restore | Would mean persisting document bytes to IndexedDB. Deliberately not done: nothing about your files should outlive the tab. |
| PDF/A conversion | Structure can be written, compliance cannot be *verified* client-side. Claiming PDF/A without validation would be dishonest. |
| Certificate (PAdES) signing | Needs real certificate handling and a signing library; also legally meaningful, so half-support is worse than none. |
| Word / Excel / PowerPoint conversion | Impossible faithfully without LibreOffice. Intentionally absent. |

## Deploy checklist

- [x] `?v=` in index.html and `V` in sw.js bumped together (now **3**).
- [x] i18n parity verified across EN/FR/NL.
- [x] All 54 tools render error-free in all three languages; new features
      tested end-to-end.
- [ ] `git add -A && git commit`, push, enable GitHub Pages
      (CNAME `pdf.labidi.eu` is in place).
- [ ] Cloudflare: Rocket Loader / Email Obfuscation / Web Analytics **off**
      (the CSP blocks them — family convention).
- [ ] Register in the family indexes: labidi.eu/js/projects.js (all 4 language
      descriptions), labidi.eu/todo-rami.md, rami.party registries if listed.
- [ ] After deploy: hard-reload once and confirm the new service worker takes
      over (DevTools → Application → Service Workers).

## Round 3 — full code review & hardening (2026-08-07) ✅

Line-by-line review of app.js/tools.js/i18n.js plus browser edge-case testing.
Fixed:

- [x] **Encrypted files picked inside tools** (merge, mix, insert, overlay,
      compare) were copied while still encrypted → garbage pages. Now every
      picked PDF goes through a password prompt when needed (`pickedPdfBytes`).
- [x] **Split "custom ranges" with empty/garbage segments** (e.g. `xyz;;;`)
      silently expanded to *all pages*; segments are now validated and an
      empty result shows a hint instead of an empty card.
- [x] **Single-file pickers** (unlock, overlay, mix, insert, compare) appended
      files — choosing a second file kept using the first. Newest now replaces.
- [x] **Crop double-apply footgun** — margin fields reset to 0 after a
      successful crop so a second Apply doesn't crop twice.
- [x] **Sign / Add image** left the draggable overlay visible after applying,
      which looked like a doubled signature. Overlay is removed once baked in.
- [x] **Remove blank pages** could run twice on double-click and delete the
      wrong pages the second time — button now disables while running.
- [x] **Page stages** (sign, redact, crop, add-image) now redraw after
      apply/undo/redo, so the preview always shows the current document; a
      race between rapid ‹ › clicks leaving two canvases was also fixed.
- [x] **Header & footer `{n}`/`{total}`** now use the physical page number and
      the document total (stamping pages 3-4 shows "3 / 4", not "1 / 2").
- [x] **Fill form** rendered checkbox names twice.
- [x] **Compare** reused merge's checkbox label; now says "Use the current
      document as the original" (all 3 languages).
- [x] **Remove pages** hint no longer claims "empty = all pages" (empty input
      is rejected there).
- [x] Dropping a non-PDF file on the page now shows feedback instead of
      silently doing nothing.
- [x] Async tool builders that fail now render an error card (previously an
      unhandled rejection left a blank tool).
- [x] `countPages` falls back to pdf-lib if pdf.js can't parse the bytes,
      so the workspace can't end up half-updated.
- [x] Organize stops rendering thumbnails after you navigate away.
- [x] Compress quality ladder no longer tries qualities above the chosen one.

Re-verified after fixes: all 47 tools render error-free, chained
rotate→watermark→page-numbers with undo×2, encrypted-input mix E2E with the
password modal, crop reset, stage refresh on undo, i18n parity 380×3.

## Round 2 — community-requested features (2026-08-06) ✅

Researched what users of Stirling PDF, PDFsam, Sejda and iLovePDF request and
love most, then added:

- [x] **Mix / interleave** (`#/tool/mix`) — alternate pages from two PDFs with a
      "reverse second file" option. *The* tool for single-sided scanners
      (scan fronts, scan backs, combine). PDFsam's signature feature.
- [x] **Insert pages** (`#/tool/insert`) — blank page(s) or another PDF at any
      position, or a blank page after every page (print + hand-written notes).
- [x] **Header & footer** (`#/tool/headers-footers`) — 6 text slots
      (header/footer × left/centre/right) with `{n}`, `{total}`, `{date}`,
      `{file}` and `{bates}` placeholders → includes **Bates numbering**
      (start + digit count) for legal workflows.
- [x] **Bookmark editor** (`#/tool/bookmarks`) — view, rename, add, delete
      bookmarks; written back as a real PDF outline.
- [x] **Split by max file size** — new split mode (MB limit) for e-mail
      attachment caps; greedy packing measured with real saves.
- [x] **Merge accepts images** — drop JPG/PNG/WebP straight into merge, each
      becomes a page; plus optional **bookmark per merged file**.
- [x] **Auto-detect margins** in Crop — samples pages, finds the ink bounding
      box, fills the margin fields (e-reader users' favourite).
- [x] **Compress to target size** — optional MB target; quality steps down
      until the file fits (raster mode), notice when unreachable.
- [x] **Roman numerals** (i, ii / I, II) in page numbers.
- [x] **Date under signature** option in Sign & stamp.
- [x] **`odd` / `even` / `first` / `last`** keywords in every page-range field
      (localised: also `impair/pair`, `oneven/even`).
- [x] **Favourites** — star any tool; pinned tools appear first in the sidebar
      and on the home screen (stored locally).
- [x] **Keyboard shortcuts** — `Ctrl+O` open a PDF, `Ctrl+S` download the
      working copy, `Ctrl+Z` / `Ctrl+Y` undo/redo.

### Bug fixes found in the round-2 review
- [x] Rasterising tools (redact, colours, scanner, compress-raster, flatten)
      double-rotated pages that carried a `/Rotate` flag — page boxes are now
      swapped and rotation reset, matching the rendered canvas.
- [x] Remove pages: empty input used to select *all* pages (guarded by the
      "can't remove everything" error) — now asks for explicit input.
- [x] File pickers now filter dropped files by the tool's accepted types.
- [x] Insert tool: position field stayed hidden when switching modes while
      "after every page" was ticked.
- [x] Control characters are stripped before WinAnsi text drawing (OCR safety).
- [x] Removed the unused `innerHTML` branch from the DOM helper (hardening).

## Round 1 — initial build (2026-08-06) ✅

- [x] 43 tools across 5 categories (pages/convert/security/edit/advanced),
      Stirling-PDF parity where client-side is possible — see README.
- [x] Stateful workspace with undo/redo, chained tools, live preview.
- [x] EN/FR/NL i18n (379 keys × 3), PWA/offline, strict CSP, dark/light,
      responsive to 360 px.
- [x] Vendored: @cantoo/pdf-lib 2.8.1 (encryption), pdf.js 3.11.174 legacy,
      tesseract.js 5.1.1 + eng/fra/nld fast models.
- [x] Fixes: rAF fallback for hidden tabs, single shared pdf.js worker,
      blank-page embedding, `[hidden]` CSS guard, form-field detection via
      `instanceof`, pointer-capture guards.

*(The backlog and the deploy checklist live at the top of this file, with the
newest round.)*
