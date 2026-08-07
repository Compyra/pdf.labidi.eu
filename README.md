# pdf.labidi.eu — PDF Studio

A Stirling-PDF-inspired PDF toolbox that runs **entirely in the browser**.
No server, no uploads, no accounts, no tracking — files never leave the device,
and after the first visit the whole app works offline (PWA).

**Live:** <https://pdf.labidi.eu/>

## Highlights

- **Stateful workspace** — open a PDF once, chain any number of tools; every
  transform auto-applies to the working copy with full undo/redo
  (`Ctrl+Z`/`Ctrl+Y`, `Ctrl+O` to open, `Ctrl+S` to download).
- **47 tools** in five groups:
  - *Pages & organisation* — merge (PDFs **and** images, optional bookmark
    per file), split (ranges / every N / **max file size** / bookmarks),
    **mix & interleave two PDFs** (duplex-scan rescue with reverse option),
    **insert pages** (blank or another PDF, or a blank after every page),
    visual organise (reorder, rotate, duplicate, delete), rotate, remove /
    extract pages, remove blank pages, crop (**auto-detect margins**),
    split-in-half, scale, N-up, booklet imposition, page numbers (incl.
    roman numerals), **header & footer with Bates numbering**.
  - *Convert & extract* — images ⇄ PDF, text/Markdown → PDF, PDF → text /
    HTML / CSV, extract embedded images, OCR (searchable PDF or .txt,
    EN/FR/NL via tesseract.js), flatten forms & annotations.
  - *Security & signing* — password protect, remove password, permissions,
    watermark (text/image, tiled), draw/type/upload signatures & stamps with
    drag-and-drop placement (optional date line), true redaction (redacted
    pages are rasterised so hidden content is gone), sanitise (JS,
    attachments, metadata, links).
  - *Edit & optimise* — metadata editor, add image, remove annotations, fill
    forms, compress (image recompression or full rasterise, optional
    **target size in MB**), colour modes (grayscale / invert / sepia),
    overlay PDFs (letterhead), attachments.
  - *Inspect & advanced* — compare two PDFs (word-level text diff),
    **bookmark editor**, document info, show/strip JavaScript, repair,
    scanner effect, smart rename.
- **Page ranges everywhere** understand `1-3, 5, 8-` plus `odd`, `even`,
  `first`, `last` (also in French/Dutch: `impair/pair`, `oneven/even`).
- **Favourites** — star any tool to pin it to the top of the sidebar and
  home screen.
- **EN / FR / NL** interface (`?lang=` override, saved choice, browser detect).
- Mobile-first responsive layout; installable; strict CSP; system dark/light.

### Not feasible fully client-side (by design)

Office conversions (Word/Excel/PowerPoint need LibreOffice), PDF/A validation
and cryptographic certificate signing (PAdES) are the few Stirling features
that genuinely require a server or heavy native tooling; everything else is
implemented locally.

## Stack

| Piece | Role |
| --- | --- |
| [@cantoo/pdf-lib](https://github.com/cantoo-scribe/pdf-lib) | create/modify PDFs, encryption/decryption, forms, attachments |
| [pdf.js](https://mozilla.github.io/pdf.js/) (legacy build) | rendering, text extraction, outlines, image decoding |
| [tesseract.js](https://tesseract.projectnaptha.com/) + tessdata_fast | OCR (eng/fra/nld) |

All vendored under `vendor/` — the CSP has no CDN origins; `connect-src 'self'`
exists only for same-origin worker/wasm/lang-data fetches.

## Files

- `index.html` — shell (topbar, sidebar, workspace chip, preview panel)
- `app.js` — state/undo, router, i18n glue, preview, UI builders, ZIP writer
- `tools.js` — the tool registry and all implementations
- `i18n.js` — every UI string in EN/FR/NL
- `sw.js` — network-first shell, cache-first assets (bump `V` + `?v=` together)
- `todo.md` — changelog, backlog and deploy checklist

## Local development

```
python -m http.server 8902 --bind 127.0.0.1
```

Then open <http://127.0.0.1:8902/?nosw> — the `nosw` parameter skips the
service-worker registration so edits show up on plain reload. Without it,
unregister the worker (DevTools → Application) when testing cache changes.