# pdf.labidi.eu — PDF Studio

A Stirling-PDF-inspired PDF toolbox that runs **entirely in the browser**.
No server, no uploads, no accounts, no tracking — files never leave the device,
and after the first visit the whole app works offline (PWA).

**Live:** <https://pdf.labidi.eu/>

## Highlights

- **Stateful workspace** — open a PDF once, chain any number of tools; every
  transform auto-applies to the working copy with full undo/redo
  (`Ctrl+Z`/`Ctrl+Y`, `Ctrl+O` to open, `Ctrl+S` to download).
- **Built-in viewer** — the 👁 button in the file chip (and on every result
  card) opens a side panel showing the document as it is *right now*. It
  refreshes after each tool, so you can check the change before downloading.
  Pages are drawn as you scroll, so long documents open instantly.
- **54 tools** in five groups:
  - *Pages & organisation* — merge (PDFs **and** images, optional bookmark
    per file), split (ranges / every N / **max file size** / bookmarks),
    **mix & interleave two PDFs** (duplex-scan rescue with reverse option),
    **insert pages** (blank or another PDF, or a blank after every page),
    visual organise (reorder, rotate, duplicate, delete), rotate, remove /
    extract pages, remove blank pages, crop (**auto-detect margins**),
    split-in-half, scale, N-up, booklet imposition, page numbers (incl.
    roman numerals), **header & footer with Bates numbering**,
    **clickable table of contents** built from the bookmarks.
  - *Convert & extract* — images ⇄ PDF, text/Markdown → PDF, PDF → text /
    HTML / CSV, extract embedded images, OCR (searchable PDF or .txt,
    EN/FR/NL via tesseract.js), flatten forms & annotations.
  - *Security & signing* — password protect, remove password, permissions,
    watermark (text/image, tiled), draw/type/upload signatures & stamps with
    drag-and-drop placement (optional date line), true redaction (redacted
    pages are rasterised so hidden content is gone), sanitise (JS,
    attachments, metadata, links), **steganography** — hide a message or a
    file inside the PDF, optionally AES-256 encrypted, and read it back,
    **threat scan** and **defang** (see below).
  - *Edit & optimise* — metadata editor, add image, remove annotations, fill
    forms, compress (image recompression or full rasterise, the latter with
    optional **target size in MB**), colour modes (grayscale / invert / sepia),
    overlay PDFs (letterhead), attachments.
  - *Inspect & advanced* — compare two PDFs (word-level text diff),
    bookmark editor, document info, show/strip JavaScript, repair,
    scanner effect, smart rename, **create / open ZIP archives**
    (real DEFLATE compression), **print**.
- **Page ranges everywhere** understand `1-3, 5, 8-` plus `odd`, `even`,
  `first`, `last` (also in French/Dutch: `impair/pair`, `oneven/even`).
- **Favourites** — star any tool to pin it to the top of the sidebar and
  home screen.
- **EN / FR / NL** interface (`?lang=` override, saved choice, browser detect).
- Mobile-first responsive layout; installable; strict CSP; system dark/light.

### Security warning & incident-response tooling

A PDF can carry scripts, actions that fire the moment it is opened, embedded
executables and links. **Every file you open is scanned automatically** and a
banner appears when something active is found — with a plain-language summary
and two buttons: *Inspect* and *Make it harmless*. Nothing in the document is
ever executed; this page has no way to run PDF JavaScript.

- **Threat scan (PDF triage)** — read-only analysis: SHA-256, document and
  action JavaScript (shown as text, with known exploit techniques and their
  CVEs flagged), `/OpenAction` and `/AA` auto-run hooks, `/Launch`,
  `/SubmitForm`, `/GoToR`, embedded files, XFA, JBIG2, hex-obfuscated names
  (`/J#61vaScript`), and every URL — shown **defanged** (`hxxp[://]host[.]tld`)
  and rated (raw IP, punycode, credentials, shorteners, direct payload links).
  Includes a pdfid-style raw keyword census, and exports a `.txt` report or
  `.json` for tooling.
- **Defang (make harmless)** — strips scripts, auto-run and program-starting
  actions, attachments, media and, optionally, forms and metadata; clickable
  links are disabled while the visible text stays. Attachment payload streams
  are emptied, not merely unlinked, so the file no longer carries the binary.
  Optionally rebuilds every page as an image for maximum certainty. You get a
  change log of exactly what was removed, plus the defanged list of every link
  that was disabled — and the result is **re-scanned afterwards**, so the tool
  either confirms nothing active is left or tells you plainly what remains.
  The cleaned file is parsed before it replaces your working copy: if it cannot
  be read back, nothing is applied and your document stays untouched.

Severity is graded conservatively: an ordinary `https://` link is *low*, and a
rating is only raised when there is a concrete reason, which is always shown
(raw IP address, punycode, embedded credentials, URL shortener, unusual port,
direct executable link). A warning that fires on every document teaches people
to ignore warnings.

Because the whole toolbox runs locally, a suspicious document can be triaged
without uploading it to a third-party scanner — which matters when the sample
is a customer's invoice or contains personal data.

### About the steganography tool

Two hiding places are offered and the UI is explicit about the trade-off:

- *Inside the page image* — the chosen page becomes a PNG whose colour
  least-significant-bits carry the payload. Invisible to the eye and
  undetectable in a normal viewer, but destroyed if another tool
  re-compresses the images.
- *Inside the file structure* — a hidden PDF object. Pages stay untouched and
  large files fit, but anyone inspecting the raw PDF can find it.

Adding a password encrypts the payload with AES-256-GCM (PBKDF2, 150 000
iterations) before hiding, so obscurity is never the only protection.

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
| Browser built-ins | `CompressionStream` for real ZIP deflate, WebCrypto for AES-256-GCM |

All vendored under `vendor/` — the CSP has no CDN origins; `connect-src 'self'`
exists only for same-origin worker/wasm/lang-data fetches, and `frame-src blob:`
only so the print preview can be handed to the browser.

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