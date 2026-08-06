/* =============================================================================
   PDF Studio — application core

   Load order: i18n.js → app.js → tools.js (all deferred; tools.js registers
   into PDFAPP.tools before DOMContentLoaded fires, then init() runs).

   Everything is local: pdf-lib (@cantoo fork, adds encryption), pdf.js for
   rendering/text, tesseract.js for OCR — all vendored under vendor/.

   The app is stateful like Stirling V2: one "working copy" PDF lives in
   memory, every tool that transforms it auto-applies its result (with a
   byte-snapshot undo history) so tools can be chained without re-uploading.
   ========================================================================== */
/* global PDFI18N, PDFLib, pdfjsLib */
(function () {
    'use strict';

    const t = (k, v) => PDFI18N.t(k, v);
    const $ = (sel, root) => (root || document).querySelector(sel);

    /* pdf.js paces rendering with requestAnimationFrame, which browsers stop
       delivering in hidden/background tabs — a long OCR or compress run would
       freeze the moment the user switches tabs. Fall back to setTimeout when
       the page is not visible so processing always makes progress. */
    (function shimRaf() {
        const nativeRaf = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : null;
        window.requestAnimationFrame = (cb) => {
            if (nativeRaf && !document.hidden) return nativeRaf(cb);
            return setTimeout(() => cb((performance || Date).now()), 16);
        };
        const nativeCancel = window.cancelAnimationFrame ? window.cancelAnimationFrame.bind(window) : null;
        window.cancelAnimationFrame = (id) => {
            if (nativeCancel) try { nativeCancel(id); } catch (e) { /* ignore */ }
            clearTimeout(id);
        };
    })();


    /* ------------------------------------------------------------ state -- */
    const state = {
        bytes: null,            // Uint8Array — current working copy
        name: 'document.pdf',
        pageCount: 0,
        history: [],            // snapshots for undo
        future: [],             // snapshots for redo
        _pdfjsDoc: null,        // cached pdf.js document (invalidated on change)
        _pdfjsPromise: null,
    };
    const MAX_HIST = 15;
    const MAX_HIST_BYTES = 300 * 1024 * 1024;

    /* ------------------------------------------------------- tiny utils -- */
    function el(tag, attrs, ...children) {
        const n = document.createElement(tag);
        if (attrs) for (const k of Object.keys(attrs)) {
            const v = attrs[k];
            if (v === null || v === undefined || v === false) continue;
            if (k === 'class') n.className = v;
            else if (k === 'text') n.textContent = v;
            else if (k === 'html') n.innerHTML = v; // only ever fed app-built markup
            else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
            else if (k === 'dataset') for (const d of Object.keys(v)) n.dataset[d] = v[d];
            else if (v === true) n.setAttribute(k, '');
            else n.setAttribute(k, v);
        }
        for (const c of children) {
            if (c === null || c === undefined || c === false) continue;
            n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
        }
        return n;
    }

    function fmtSize(bytes) {
        if (!isFinite(bytes)) return '–';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    }

    function toast(msg, kind) {
        const box = $('#toasts');
        const item = el('div', { class: 'toast' + (kind ? ' ' + kind : '') }, msg);
        box.appendChild(item);
        setTimeout(() => { item.style.opacity = '0'; item.style.transition = 'opacity .3s'; }, 3200);
        setTimeout(() => item.remove(), 3600);
    }

    /* "1-3, 5, 8-" → sorted unique 0-based indices (empty spec → all pages) */
    function parseRanges(spec, n) {
        spec = String(spec || '').trim().toLowerCase();
        if (!spec || spec === 'all') return Array.from({ length: n }, (_, i) => i);
        const out = [];
        const seen = new Set();
        for (const tokRaw of spec.split(',')) {
            const tok = tokRaw.trim();
            if (!tok) continue;
            const m = tok.match(/^(\d+)?\s*-\s*(\d+)?$/);
            let a, b;
            if (m && (m[1] || m[2])) { a = m[1] ? +m[1] : 1; b = m[2] ? +m[2] : n; }
            else if (/^\d+$/.test(tok)) { a = b = +tok; }
            else continue;
            if (a > b) [a, b] = [b, a];
            a = Math.max(1, a); b = Math.min(n, b);
            for (let i = a; i <= b; i++) if (!seen.has(i - 1)) { seen.add(i - 1); out.push(i - 1); }
        }
        return out;
    }

    function download(bytes, name, mime) {
        const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: mime || 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = el('a', { href: url, download: name });
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
    }

    /* ----------------------------------------------------- ZIP (stored) -- */
    const CRC_TABLE = (() => {
        const tb = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            let c = i;
            for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
            tb[i] = c >>> 0;
        }
        return tb;
    })();
    function crc32(u8) {
        let c = 0xFFFFFFFF;
        for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
        return (c ^ 0xFFFFFFFF) >>> 0;
    }
    /* entries: [{name, data:Uint8Array}] → Uint8Array of a stored (method 0) zip */
    function zipStore(entries) {
        const enc = new TextEncoder();
        const now = new Date();
        const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
        const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;
        const locals = [];
        const centrals = [];
        let offset = 0;
        for (const e of entries) {
            const nameB = enc.encode(e.name);
            const crc = crc32(e.data);
            const lh = new DataView(new ArrayBuffer(30));
            lh.setUint32(0, 0x04034b50, true);
            lh.setUint16(4, 20, true);
            lh.setUint16(6, 0x0800, true);   // UTF-8 names
            lh.setUint16(8, 0, true);        // stored
            lh.setUint16(10, dosTime, true);
            lh.setUint16(12, dosDate, true);
            lh.setUint32(14, crc, true);
            lh.setUint32(18, e.data.length, true);
            lh.setUint32(22, e.data.length, true);
            lh.setUint16(26, nameB.length, true);
            lh.setUint16(28, 0, true);
            locals.push(new Uint8Array(lh.buffer), nameB, e.data);
            const ch = new DataView(new ArrayBuffer(46));
            ch.setUint32(0, 0x02014b50, true);
            ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
            ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
            ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true);
            ch.setUint32(16, crc, true);
            ch.setUint32(20, e.data.length, true); ch.setUint32(24, e.data.length, true);
            ch.setUint16(28, nameB.length, true);
            ch.setUint32(42, offset, true);
            centrals.push(new Uint8Array(ch.buffer), nameB);
            offset += 30 + nameB.length + e.data.length;
        }
        let cdSize = 0;
        for (const c of centrals) cdSize += c.length;
        const eocd = new DataView(new ArrayBuffer(22));
        eocd.setUint32(0, 0x06054b50, true);
        eocd.setUint16(8, entries.length, true);
        eocd.setUint16(10, entries.length, true);
        eocd.setUint32(12, cdSize, true);
        eocd.setUint32(16, offset, true);
        const total = offset + cdSize + 22;
        const out = new Uint8Array(total);
        let p = 0;
        for (const part of locals) { out.set(part, p); p += part.length; }
        for (const part of centrals) { out.set(part, p); p += part.length; }
        out.set(new Uint8Array(eocd.buffer), p);
        return out;
    }

    /* -------------------------------------------------- image utilities -- */
    async function decodeImage(bytes, mime) {
        const blob = new Blob([bytes], { type: mime || 'image/png' });
        if (window.createImageBitmap) {
            try { return await createImageBitmap(blob); } catch (e) { /* fall through */ }
        }
        return new Promise((res, rej) => {
            const url = URL.createObjectURL(blob);
            const img = new Image();
            img.onload = () => { URL.revokeObjectURL(url); res(img); };
            img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('image decode failed')); };
            img.src = url;
        });
    }

    function canvasToBytes(canvas, type, quality) {
        return new Promise((res, rej) => {
            const done = async (blob) => {
                if (!blob) return rej(new Error('canvas export failed'));
                res(new Uint8Array(await blob.arrayBuffer()));
            };
            canvas.toBlob(done, type || 'image/png', quality);
        });
    }

    /* PNG bytes from any image file (webp/gif/bmp/svg → canvas → png) */
    async function toPngBytes(bytes, mime) {
        const img = await decodeImage(bytes, mime);
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        c.getContext('2d').drawImage(img, 0, 0);
        if (img.close) img.close();
        return canvasToBytes(c, 'image/png');
    }

    /* Replace characters WinAnsi cannot encode so standard fonts never throw */
    function winAnsiSafe(str) {
        return String(str)
            .replace(/[\u2018\u2019\u201A\u2039\u203A]/g, "'")
            .replace(/[\u201C\u201D\u201E]/g, '"')
            .replace(/[\u2013\u2212]/g, '-').replace(/\u2014/g, '--')
            .replace(/\u2026/g, '...')
            .replace(/[\u00A0\u2007\u202F]/g, ' ')
            .replace(/\t/g, '    ')
            .replace(/[^\u0000-\u00FF\u0152\u0153\u0160\u0161\u0178\u017D\u017E\u20AC\u2022\u2020\u2021\u2030\u2122\u0192]/g, '?');
    }

    function hexToRgb(hex) {
        const m = String(hex).replace('#', '');
        return PDFLib.rgb(parseInt(m.slice(0, 2), 16) / 255, parseInt(m.slice(2, 4), 16) / 255, parseInt(m.slice(4, 6), 16) / 255);
    }

    /* -------------------------------------------------- pdf.js plumbing -- */
    /* One shared pdf.js worker for every document this session. Spawning a
       fresh worker per getDocument() leaks worker slots (browsers cap them
       per page) and eventually wedges long tool-chaining sessions. When an
       external worker is passed, loadingTask/doc destroy() leaves it alive. */
    let sharedPdfWorker = null;
    function pdfWorker() {
        if (!sharedPdfWorker || sharedPdfWorker.destroyed) {
            sharedPdfWorker = new pdfjsLib.PDFWorker({ name: 'pdf-studio-shared' });
        }
        return sharedPdfWorker;
    }

    function pdfjsDocFor(bytes) {
        // pdf.js may transfer the buffer to its worker — always hand it a copy.
        return pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false, worker: pdfWorker() }).promise;
    }

    function getDoc() {
        if (!state.bytes) return Promise.reject(new Error('no document'));
        if (!state._pdfjsPromise) {
            state._pdfjsPromise = pdfjsDocFor(state.bytes).then((d) => { state._pdfjsDoc = d; return d; });
        }
        return state._pdfjsPromise;
    }

    async function renderPage(doc, pageIndex, opts) {
        const page = await doc.getPage(pageIndex + 1);
        const o = opts || {};
        let scale;
        if (o.dpi) scale = o.dpi / 72;
        else if (o.targetWidth) scale = o.targetWidth / page.getViewport({ scale: 1 }).width;
        else scale = o.scale || 1;
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(viewport.width));
        canvas.height = Math.max(1, Math.round(viewport.height));
        const ctx = canvas.getContext('2d', { willReadFrequently: !!o.willRead });
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({
            canvasContext: ctx, viewport,
            annotationMode: o.annotationMode !== undefined ? o.annotationMode : 1,
        }).promise;
        return { canvas, page, viewport };
    }

    /* Rebuild the working copy replacing some pages with rendered canvases.
       map: Map(pageIndex → canvas). Untouched pages are copied losslessly. */
    async function replacePagesWithImages(map, quality) {
        const src = await PDFLib.PDFDocument.load(state.bytes, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false });
        const out = await PDFLib.PDFDocument.create();
        const n = src.getPageCount();
        const keepIdx = [];
        for (let i = 0; i < n; i++) if (!map.has(i)) keepIdx.push(i);
        const copied = keepIdx.length ? await out.copyPages(src, keepIdx) : [];
        let k = 0;
        for (let i = 0; i < n; i++) {
            if (map.has(i)) {
                const canvas = map.get(i);
                const srcPage = src.getPage(i);
                const { width, height } = srcPage.getSize();
                const jpg = await out.embedJpg(await canvasToBytes(canvas, 'image/jpeg', quality || 0.85));
                const p = out.addPage([width, height]);
                p.drawImage(jpg, { x: 0, y: 0, width, height });
            } else {
                out.addPage(copied[k++]);
            }
        }
        return out.save();
    }

    /* --------------------------------------------------- workspace core -- */
    function invalidateDocCache() {
        if (state._pdfjsDoc) { try { state._pdfjsDoc.destroy(); } catch (e) { /* ignore */ } }
        state._pdfjsDoc = null;
        state._pdfjsPromise = null;
    }

    function trimHistory() {
        while (state.history.length > MAX_HIST) state.history.shift();
        let total = state.history.reduce((s, h) => s + h.bytes.length, 0);
        while (total > MAX_HIST_BYTES && state.history.length > 1) total -= state.history.shift().bytes.length;
    }

    async function countPages(bytes) {
        const doc = await pdfjsDocFor(bytes);
        const n = doc.numPages;
        doc.destroy();
        return n;
    }

    async function setWorkspace(bytes, opts) {
        const o = opts || {};
        if (state.bytes && !o.fresh) {
            state.history.push({ bytes: state.bytes, name: state.name, pageCount: state.pageCount });
            trimHistory();
            state.future = [];
        }
        if (o.fresh) { state.history = []; state.future = []; }
        state.bytes = bytes;
        if (o.name) state.name = o.name;
        invalidateDocCache();
        state.pageCount = o.pageCount !== undefined ? o.pageCount : await countPages(bytes);
        updateChip();
        document.dispatchEvent(new CustomEvent('pdfstudio:workspace'));
        if (previewOpen) renderPreview();
    }

    function undo() {
        if (!state.history.length) return;
        state.future.push({ bytes: state.bytes, name: state.name, pageCount: state.pageCount });
        const s = state.history.pop();
        state.bytes = s.bytes; state.name = s.name; state.pageCount = s.pageCount;
        invalidateDocCache(); updateChip(); toast(t('toast_undo'));
        document.dispatchEvent(new CustomEvent('pdfstudio:workspace'));
        if (previewOpen) renderPreview();
    }
    function redo() {
        if (!state.future.length) return;
        state.history.push({ bytes: state.bytes, name: state.name, pageCount: state.pageCount });
        const s = state.future.pop();
        state.bytes = s.bytes; state.name = s.name; state.pageCount = s.pageCount;
        invalidateDocCache(); updateChip(); toast(t('toast_redo'));
        document.dispatchEvent(new CustomEvent('pdfstudio:workspace'));
        if (previewOpen) renderPreview();
    }

    function closeWorkspace() {
        if (!state.bytes) return;
        if (!confirm(t('ws_confirm_close'))) return;
        state.bytes = null; state.history = []; state.future = []; state.pageCount = 0;
        invalidateDocCache(); updateChip(); closePreview();
        document.dispatchEvent(new CustomEvent('pdfstudio:workspace'));
        route();
    }

    function updateChip() {
        const chip = $('#ws-chip');
        if (!state.bytes) { chip.hidden = true; return; }
        chip.hidden = false;
        $('#ws-name').textContent = state.name;
        $('#ws-meta').textContent = t('ws_pages', { n: state.pageCount }) + ' · ' + fmtSize(state.bytes.length);
        $('#ws-undo').disabled = !state.history.length;
        $('#ws-redo').disabled = !state.future.length;
    }

    /* password prompt (modal) — resolves string or null on cancel */
    function askPassword(fileName) {
        return new Promise((resolve) => {
            const modal = $('#modal');
            $('#modal-title').textContent = t('enter_pw', { name: fileName });
            const body = $('#modal-body');
            body.textContent = '';
            const input = el('input', { type: 'password', autocomplete: 'off', class: '' });
            input.style.cssText = 'width:100%;padding:.55rem .7rem;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--text);font:inherit';
            const err = el('p', { class: 'hint', text: '' });
            err.style.color = 'var(--err)';
            const ok = el('button', { class: 'btn btn-primary', type: 'button' }, t('unlock_btn'));
            const wrap = el('div', {},
                el('div', { class: 'field' }, input, err),
                el('div', { class: 'btn-row' }, ok));
            body.appendChild(wrap);
            let settled = false;
            const finish = (val) => { if (!settled) { settled = true; modal.close(); resolve(val); } };
            ok.addEventListener('click', () => finish(input.value));
            input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(input.value); });
            modal.addEventListener('close', () => finish(null), { once: true });
            if (typeof modal.showModal === 'function') { modal.showModal(); input.focus(); }
            else resolve(prompt(t('enter_pw', { name: fileName })) || null);
        });
    }

    /* Load a File into the workspace, decrypting if needed */
    async function loadWorkspaceFile(file) {
        try {
            let bytes = new Uint8Array(await file.arrayBuffer());
            let probe;
            try {
                probe = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false });
            } catch (e) {
                toast(t('err_badpdf'), 'err');
                return false;
            }
            if (probe.isEncrypted) {
                let opened = null;
                while (!opened) {
                    const pw = await askPassword(file.name);
                    if (pw === null) return false;
                    try {
                        const dec = await PDFLib.PDFDocument.load(bytes, { password: pw, updateMetadata: false });
                        opened = await dec.save();
                    } catch (e) { toast(t('pw_wrong'), 'err'); }
                }
                bytes = opened instanceof Uint8Array ? opened : new Uint8Array(opened);
            }
            await setWorkspace(bytes, { fresh: true, name: file.name });
            toast(t('toast_loaded', { name: file.name }), 'ok');
            return true;
        } catch (e) {
            console.error(e);
            toast(t('err_badpdf'), 'err');
            return false;
        }
    }

    /* ---------------------------------------------------------- preview -- */
    let previewOpen = false;
    let previewZoom = 1;
    let previewToken = 0;

    async function renderPreview() {
        const host = $('#pv-pages');
        host.textContent = '';
        $('#pv-zoom-label').textContent = Math.round(previewZoom * 100) + '%';
        if (!state.bytes) return;
        const my = ++previewToken;
        try {
            const doc = await getDoc();
            const width = Math.min(560, (host.clientWidth || 300) - 8) * previewZoom;
            const max = Math.min(doc.numPages, 120);
            for (let i = 0; i < max; i++) {
                if (my !== previewToken) return;
                const { canvas } = await renderPage(doc, i, { targetWidth: Math.max(80, width) });
                if (my !== previewToken) return;
                host.appendChild(canvas);
                host.appendChild(el('div', { class: 'pv-num' }, String(i + 1) + ' / ' + doc.numPages));
            }
        } catch (e) { console.error(e); }
    }

    function openPreview() {
        if (!state.bytes) return;
        previewOpen = true;
        $('#preview').hidden = false;
        renderPreview();
    }
    function closePreview() {
        previewOpen = false;
        previewToken++;
        $('#preview').hidden = true;
    }

    /* -------------------------------------------------------- UI blocks -- */
    function field(labelKey, control, hintKey) {
        const f = el('div', { class: 'field' });
        if (labelKey) {
            const lab = el('label', { text: t(labelKey) });
            if (control.id) lab.setAttribute('for', control.id);
            f.appendChild(lab);
        }
        f.appendChild(control);
        if (hintKey) f.appendChild(el('span', { class: 'hint', text: t(hintKey) }));
        return f;
    }

    let uid = 0;
    function input(type, attrs) {
        const a = Object.assign({ type, id: 'f' + (++uid) }, attrs || {});
        return el('input', a);
    }

    function select(options, value) {
        const s = el('select', { id: 'f' + (++uid) });
        for (const o of options) s.appendChild(el('option', { value: o.value, text: o.label, selected: o.value === value }));
        return s;
    }

    function segmented(options, value, onChange) {
        const wrap = el('div', { class: 'seg', role: 'group' });
        const set = (v) => {
            wrap.dataset.value = v;
            wrap.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
            if (onChange) onChange(v);
        };
        for (const o of options) {
            wrap.appendChild(el('button', {
                type: 'button', dataset: { v: o.value }, 'aria-pressed': String(o.value === value),
                onclick: () => set(o.value),
            }, o.label));
        }
        wrap.dataset.value = value;
        wrap.getValue = () => wrap.dataset.value;
        return wrap;
    }

    function check(labelKey, checked) {
        const c = input('checkbox', { checked: checked || null });
        const lab = el('label', { class: 'check' }, c, el('span', { text: t(labelKey) }));
        lab.input = c;
        return lab;
    }

    function pagesField() {
        const inp = input('text', { placeholder: t('hint_pages'), autocomplete: 'off', spellcheck: 'false' });
        const f = field('opt_pages', inp, 'hint_pages');
        f.getIndices = (n) => parseRanges(inp.value, n);
        f.input = inp;
        return f;
    }

    /* generic multi-file picker card */
    function filePicker(opts) {
        const o = opts || {};
        const files = [];
        const list = el('div', { class: 'filelist' });
        const inp = el('input', { type: 'file', hidden: true, accept: o.accept || 'application/pdf,.pdf', multiple: o.multiple !== false });
        const btn = el('button', { type: 'button', class: 'btn' }, t(o.labelKey || 'btn_add_files'));
        const zone = el('div', { class: 'filepick' }, btn, list, inp);
        function redraw() {
            list.textContent = '';
            files.forEach((f, i) => {
                const row = el('div', { class: 'file-row', draggable: o.sortable ? 'true' : null, dataset: { idx: i } },
                    el('span', { 'aria-hidden': 'true' }, o.sortable ? '⋮⋮ ' : '📄'),
                    el('span', { class: 'fr-name', text: f.name }),
                    el('span', { class: 'fr-size', text: fmtSize(f.size !== undefined ? f.size : f.bytes.length) }),
                    el('button', {
                        type: 'button', class: 'icon-btn', 'aria-label': t('close'),
                        onclick: () => { files.splice(i, 1); redraw(); },
                    }, '✕'));
                if (o.sortable) {
                    row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(i)); row.classList.add('is-dragging'); });
                    row.addEventListener('dragend', () => row.classList.remove('is-dragging'));
                    row.addEventListener('dragover', (e) => e.preventDefault());
                    row.addEventListener('drop', (e) => {
                        e.preventDefault(); e.stopPropagation();
                        const from = +e.dataTransfer.getData('text/plain');
                        const to = i;
                        if (from === to || isNaN(from)) return;
                        const [moved] = files.splice(from, 1);
                        files.splice(to, 0, moved);
                        redraw();
                    });
                }
                list.appendChild(row);
            });
            if (o.onChange) o.onChange(files);
        }
        async function add(fileList) {
            for (const f of fileList) files.push(f);
            redraw();
        }
        btn.addEventListener('click', () => inp.click());
        inp.addEventListener('change', () => { add([...inp.files]); inp.value = ''; });
        zone.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); zone.classList.add('is-over'); });
        zone.addEventListener('dragleave', () => zone.classList.remove('is-over'));
        zone.addEventListener('drop', (e) => {
            e.preventDefault(); e.stopPropagation(); zone.classList.remove('is-over');
            add([...e.dataTransfer.files].filter((f) => !o.accept || o.accept.includes('pdf') === /pdf$/i.test(f.name) || true));
        });
        zone.getFiles = () => files.slice();
        zone.clear = () => { files.length = 0; redraw(); };
        return zone;
    }

    /* per-tool progress + result rail */
    function makeRunner(view) {
        const prog = el('div', { class: 'progress' },
            el('div', { class: 'bar' }, el('i')),
            el('span', { class: 'plabel' }, ''));
        const resultHost = el('div');
        view.appendChild(prog);
        view.appendChild(resultHost);
        const api = {
            progress(frac, label) {
                prog.classList.add('is-on');
                prog.querySelector('i').style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%';
                prog.querySelector('.plabel').textContent = label || Math.round(frac * 100) + '%';
            },
            done() { prog.classList.remove('is-on'); },
            clear() { resultHost.textContent = ''; prog.classList.remove('is-on'); },
            error(err) {
                api.done();
                console.error(err);
                resultHost.textContent = '';
                resultHost.appendChild(el('div', { class: 'card result' },
                    el('p', { class: 'error', text: t('err_generic', { msg: (err && err.message) || String(err) }) })));
            },
            /* files: [{name, bytes, mime}] */
            files(files, titleKey) {
                api.done();
                resultHost.textContent = '';
                const card = el('div', { class: 'card result' });
                card.appendChild(el('p', { class: 'res-title', text: t(titleKey || 'res_ready') }));
                const itemsBox = el('div', { class: 'res-items' });
                for (const f of files) {
                    itemsBox.appendChild(el('div', { class: 'res-item' },
                        el('button', { type: 'button', class: 'btn', onclick: () => download(f.bytes, f.name, f.mime) }, '⭳ ' + f.name),
                        el('span', { class: 'fr-size', text: fmtSize(f.bytes.length) })));
                }
                card.appendChild(itemsBox);
                if (files.length > 1) {
                    card.appendChild(el('div', { class: 'btn-row', style: 'margin-top:.7rem' },
                        el('button', {
                            type: 'button', class: 'btn btn-primary',
                            onclick: () => download(zipStore(files.map((f) => ({ name: f.name, data: f.bytes }))), baseName(state.name || 'files') + '.zip', 'application/zip'),
                        }, t('btn_download_all'))));
                }
                resultHost.appendChild(card);
                return card;
            },
            /* a transformed working copy: auto-apply + offer download */
            async applied(bytes, opts) {
                const o = opts || {};
                await setWorkspace(bytes, { name: o.name });
                api.done();
                resultHost.textContent = '';
                const outName = o.downloadName || state.name;
                resultHost.appendChild(el('div', { class: 'card result' },
                    el('p', { class: 'res-title', text: t('res_applied') }),
                    el('div', { class: 'btn-row' },
                        el('button', { type: 'button', class: 'btn btn-primary', onclick: () => download(state.bytes, outName, 'application/pdf') }, t('btn_download') + ' — ' + outName),
                        el('span', { class: 'fr-size', text: fmtSize(bytes.length) }))));
                toast(t('toast_applied'), 'ok');
            },
            text(str, name, mime) {
                api.done();
                resultHost.textContent = '';
                const pre = el('pre', { class: 'info-block' });
                pre.textContent = str.length > 40000 ? str.slice(0, 40000) + '\n…' : str;
                resultHost.appendChild(el('div', { class: 'card result' },
                    el('p', { class: 'res-title', text: t('res_ready') }),
                    pre,
                    el('div', { class: 'btn-row', style: 'margin-top:.7rem' },
                        el('button', { type: 'button', class: 'btn btn-primary', onclick: () => download(new TextEncoder().encode(str), name, mime || 'text/plain') }, t('btn_download') + ' — ' + name),
                        el('button', {
                            type: 'button', class: 'btn',
                            onclick: () => navigator.clipboard && navigator.clipboard.writeText(str).then(() => toast(t('toast_copied'), 'ok')),
                        }, t('btn_copy')))));
            },
            host: resultHost,
        };
        return api;
    }

    function runButton(labelKey, handler) {
        const btn = el('button', { type: 'button', class: 'btn btn-primary' }, t(labelKey || 'btn_run'));
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            const old = btn.textContent;
            btn.textContent = t('working');
            try { await handler(); }
            finally { btn.disabled = false; btn.textContent = old; }
        });
        return btn;
    }

    function baseName(name) { return String(name || 'document').replace(/\.pdf$/i, ''); }

    /* card that shows current doc or an inline uploader when none is loaded */
    function workspaceGate(view, buildTool) {
        const container = el('div');
        view.appendChild(container);
        function draw() {
            container.textContent = '';
            if (!state.bytes) {
                const inp = el('input', { type: 'file', accept: 'application/pdf,.pdf', hidden: true });
                const up = el('div', { class: 'uploader', tabindex: '0', role: 'button' },
                    el('span', { class: 'up-ico', 'aria-hidden': 'true' }, '📄'),
                    el('strong', { text: t('open_here') }),
                    el('small', { text: t('need_ws') }), inp);
                up.addEventListener('click', () => inp.click());
                up.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inp.click(); } });
                inp.addEventListener('change', async () => { if (inp.files[0]) await loadWorkspaceFile(inp.files[0]); });
                container.appendChild(up);
            } else {
                const body = el('div', { class: 'tool-body' });
                container.appendChild(body);
                buildTool(body);
            }
        }
        draw();
        const rebuild = () => { if (document.body.contains(container)) draw(); };
        document.addEventListener('pdfstudio:workspace', function h(e) {
            if (!document.body.contains(container)) { document.removeEventListener('pdfstudio:workspace', h); return; }
            // Only rebuild when presence toggles — tools handle their own refresh.
            const hasUi = !!container.querySelector('.tool-body');
            if (hasUi !== !!state.bytes) rebuild();
        });
        return container;
    }

    /* ----------------------------------------------------------- router -- */
    const tools = [];   // filled by tools.js
    const CATS = ['organize', 'convert', 'security', 'edit', 'advanced'];

    function buildNav() {
        const nav = $('#side-nav');
        nav.textContent = '';
        for (const cat of CATS) {
            const items = tools.filter((x) => x.cat === cat);
            if (!items.length) continue;
            nav.appendChild(el('div', { class: 'side-cat', dataset: { cat } }, t('cat_' + cat)));
            for (const tool of items) {
                nav.appendChild(el('a', {
                    class: 'side-item', href: '#/tool/' + tool.id, dataset: { tool: tool.id },
                    onclick: () => { $('#side').classList.remove('is-open'); $('#nav-toggle').setAttribute('aria-expanded', 'false'); },
                }, el('span', { class: 't-ico', 'aria-hidden': 'true' }, tool.icon), el('span', { text: t('t_' + tool.key) })));
            }
        }
        applySearch();
        markCurrent();
    }

    function applySearch() {
        const q = ($('#tool-search').value || '').trim().toLowerCase();
        const nav = $('#side-nav');
        let any = false;
        nav.querySelectorAll('.side-item').forEach((a) => {
            const tool = tools.find((x) => x.id === a.dataset.tool);
            const hay = (t('t_' + tool.key) + ' ' + t('t_' + tool.key + '_d')).toLowerCase();
            const show = !q || hay.includes(q);
            a.style.display = show ? '' : 'none';
            if (show) any = true;
        });
        nav.querySelectorAll('.side-cat').forEach((c) => {
            let sib = c.nextElementSibling, visible = false;
            while (sib && !sib.classList.contains('side-cat')) {
                if (sib.style.display !== 'none') { visible = true; break; }
                sib = sib.nextElementSibling;
            }
            c.style.display = visible ? '' : 'none';
        });
        let empty = nav.querySelector('.side-empty');
        if (!any) {
            if (!empty) nav.appendChild(el('p', { class: 'side-empty hint', style: 'padding:.5rem', text: t('no_results') }));
        } else if (empty) empty.remove();
    }

    function markCurrent() {
        const id = currentToolId();
        $('#side-nav').querySelectorAll('.side-item').forEach((a) => {
            if (a.dataset.tool === id) a.setAttribute('aria-current', 'page');
            else a.removeAttribute('aria-current');
        });
    }

    function currentToolId() {
        const m = location.hash.match(/^#\/tool\/([a-z0-9-]+)/);
        return m ? m[1] : null;
    }

    function renderHome() {
        const view = $('#view');
        view.textContent = '';
        const hero = el('div', { class: 'hero' },
            el('h1', { text: t('home_h1') }),
            el('p', { text: t('home_lead') }));
        view.appendChild(hero);

        const inp = el('input', { type: 'file', accept: 'application/pdf,.pdf', hidden: true });
        const up = el('div', { class: 'uploader', tabindex: '0', role: 'button' },
            el('span', { class: 'up-ico', 'aria-hidden': 'true' }, '📄'),
            el('strong', { text: t('up_title') }),
            el('small', { text: t('up_hint') }), inp);
        up.addEventListener('click', () => inp.click());
        up.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inp.click(); } });
        inp.addEventListener('change', async () => { if (inp.files[0]) await loadWorkspaceFile(inp.files[0]); });
        view.appendChild(up);

        for (const cat of CATS) {
            const items = tools.filter((x) => x.cat === cat);
            if (!items.length) continue;
            view.appendChild(el('h2', { class: 'home-cat', text: t('cat_' + cat) }));
            const grid = el('div', { class: 'tool-grid' });
            for (const tool of items) {
                grid.appendChild(el('a', { class: 'tool-card', href: '#/tool/' + tool.id },
                    el('span', { class: 't-ico', 'aria-hidden': 'true' }, tool.icon),
                    el('strong', { text: t('t_' + tool.key) }),
                    el('small', { text: t('t_' + tool.key + '_d') })));
            }
            view.appendChild(grid);
        }
    }

    function renderTool(tool) {
        const view = $('#view');
        view.textContent = '';
        view.appendChild(el('a', { class: 'back-link', href: '#/' }, '← ' + t('btn_back')));
        view.appendChild(el('div', { class: 'tool-head' },
            el('span', { class: 't-ico', 'aria-hidden': 'true' }, tool.icon),
            el('div', {},
                el('h1', { text: t('t_' + tool.key) }),
                el('p', { text: t('t_' + tool.key + '_d') }))));
        try {
            tool.build(view, API);
        } catch (e) {
            console.error(e);
            view.appendChild(el('p', { class: 'error', text: t('err_generic', { msg: e.message }) }));
        }
        $('#main').focus({ preventScroll: true });
        window.scrollTo(0, 0);
    }

    function route() {
        const id = currentToolId();
        const tool = id && tools.find((x) => x.id === id);
        if (tool) renderTool(tool);
        else renderHome();
        markCurrent();
    }

    /* -------------------------------------------------------- top-level -- */
    function wireMenu(btnSel, menuSel) {
        const btn = $(btnSel), menu = $(menuSel);
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const open = !menu.hidden;
            document.querySelectorAll('.menu-list').forEach((m) => { m.hidden = true; });
            menu.hidden = open;
            btn.setAttribute('aria-expanded', String(!open));
        });
    }

    function applyTheme(theme) {
        document.documentElement.dataset.theme = theme;
        $('#meta-theme').setAttribute('content', theme === 'light' ? '#faf3ee' : '#140a08');
        try { localStorage.setItem('pdftools:theme', theme); } catch (e) { /* ignore */ }
    }

    function init() {
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js';

        PDFI18N.apply();
        try { applyTheme(localStorage.getItem('pdftools:theme') || 'dark'); } catch (e) { applyTheme('dark'); }

        wireMenu('#apps-btn', '#apps-menu');
        wireMenu('#lang-btn', '#lang-menu');
        document.addEventListener('click', () => {
            document.querySelectorAll('.menu-list').forEach((m) => { m.hidden = true; });
            document.querySelectorAll('.menu > button').forEach((b) => b.setAttribute('aria-expanded', 'false'));
        });

        $('#lang-current').textContent = PDFI18N.lang.toUpperCase();
        $('#lang-menu').querySelectorAll('button[data-lang]').forEach((b) => {
            b.setAttribute('aria-current', String(b.dataset.lang === PDFI18N.lang));
            b.addEventListener('click', () => {
                PDFI18N.set(b.dataset.lang);
                $('#lang-current').textContent = b.dataset.lang.toUpperCase();
                $('#lang-menu').querySelectorAll('button[data-lang]').forEach((x) => x.setAttribute('aria-current', String(x === b)));
                buildNav(); route(); updateChip();
            });
        });

        $('#theme-btn').addEventListener('click', () => {
            applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
        });

        $('#nav-toggle').addEventListener('click', (e) => {
            e.stopPropagation();
            const side = $('#side');
            const open = side.classList.toggle('is-open');
            $('#nav-toggle').setAttribute('aria-expanded', String(open));
        });
        document.addEventListener('click', (e) => {
            const side = $('#side');
            if (side.classList.contains('is-open') && !side.contains(e.target) && e.target.id !== 'nav-toggle') {
                side.classList.remove('is-open');
                $('#nav-toggle').setAttribute('aria-expanded', 'false');
            }
        });

        $('#tool-search').addEventListener('input', applySearch);

        $('#ws-undo').addEventListener('click', undo);
        $('#ws-redo').addEventListener('click', redo);
        $('#ws-close').addEventListener('click', closeWorkspace);
        $('#ws-download').addEventListener('click', () => state.bytes && download(state.bytes, state.name, 'application/pdf'));
        $('#ws-open-preview').addEventListener('click', () => (previewOpen ? closePreview() : openPreview()));
        $('#pv-close').addEventListener('click', closePreview);
        $('#pv-zoom-in').addEventListener('click', () => { previewZoom = Math.min(3, previewZoom + 0.25); renderPreview(); });
        $('#pv-zoom-out').addEventListener('click', () => { previewZoom = Math.max(0.5, previewZoom - 0.25); renderPreview(); });
        $('#modal-close').addEventListener('click', () => $('#modal').close());

        document.addEventListener('keydown', (e) => {
            const tag = (e.target.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
            if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
            else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); redo(); }
        });

        /* global drag & drop */
        const dz = $('#dropzone');
        let dragDepth = 0;
        const hideDz = () => { dragDepth = 0; dz.hidden = true; };
        window.addEventListener('dragenter', (e) => {
            if (![...(e.dataTransfer && e.dataTransfer.items || [])].some((i) => i.kind === 'file')) return;
            dragDepth++;
            dz.hidden = false;
        });
        window.addEventListener('dragleave', () => { if (--dragDepth <= 0) hideDz(); });
        window.addEventListener('dragover', (e) => e.preventDefault());
        // capture phase: runs before tool-local pickers stopPropagation on their drops
        window.addEventListener('drop', hideDz, true);
        window.addEventListener('dragend', hideDz);
        window.addEventListener('drop', async (e) => {
            e.preventDefault();
            hideDz();
            // Drops on tool-local pickers are handled there (they stopPropagation).
            const f = [...e.dataTransfer.files].find((x) => /\.pdf$/i.test(x.name) || x.type === 'application/pdf');
            if (f) await loadWorkspaceFile(f);
        });

        $('#file-global').addEventListener('change', async (e) => {
            if (e.target.files[0]) await loadWorkspaceFile(e.target.files[0]);
            e.target.value = '';
        });

        window.addEventListener('hashchange', route);
        buildNav();
        route();
        updateChip();

        if ('serviceWorker' in navigator && !new URLSearchParams(location.search).has('nosw')
            && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
            navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => { /* offline install is a bonus */ });
        }
    }

    /* ------------------------------------------------------- public API -- */
    const API = {
        t, el, field, input, select, segmented, check, pagesField, filePicker,
        makeRunner, runButton, workspaceGate, baseName,
        state, setWorkspace, loadWorkspaceFile, undo, redo,
        getDoc, pdfjsDocFor, renderPage, replacePagesWithImages,
        parseRanges, download, zipStore, crc32, fmtSize, toast,
        decodeImage, canvasToBytes, toPngBytes, winAnsiSafe, hexToRgb,
        askPassword,
        tools,
        registerTool(def) { tools.push(def); },
        get PDFLib() { return PDFLib; },
        route, buildNav,
    };
    window.PDFAPP = API;

    document.addEventListener('DOMContentLoaded', init);
})();
