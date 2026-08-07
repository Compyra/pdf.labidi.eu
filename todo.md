# PDF Studio — todo & changelog

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

## Backlog — possible later rounds

- [ ] Batch mode: run one tool over many files in a row (protect 20 PDFs…).
- [ ] Multiple signature placements in one pass + saved signatures
      (localStorage opt-in).
- [ ] Printable table-of-contents page generated from bookmarks.
- [ ] Nested bookmark levels in the editor (currently one level).
- [ ] QR/divider-sheet auto-split for batch scanning.
- [ ] Deskew (auto-straighten) option in Scanner/OCR pipeline.
- [ ] PDF/A conversion — needs a validator to be honest about compliance;
      revisit if a light client-side verifier becomes available.
- [ ] Certificate (PAdES) signing — requires a crypto library and real
      certificate handling; out of scope for a no-dependency client app.
- [ ] Word/Excel/PowerPoint conversion — impossible faithfully without
      LibreOffice; intentionally not offered (honesty > checkbox).

## Deploy checklist

- [ ] `git add -A && git commit` in this repo, push, enable GitHub Pages
      (CNAME `pdf.labidi.eu` is in place).
- [ ] Cloudflare: Rocket Loader / Email Obfuscation / Web Analytics **off**
      (CSP blocks them — family convention).
- [ ] After any future asset change: bump `?v=` in index.html **and** `V` in
      sw.js together.
- [ ] Register in the family indexes: labidi.eu/js/projects.js (all 4 language
      descriptions), labidi.eu/todo-rami.md, rami.party registries if listed.
