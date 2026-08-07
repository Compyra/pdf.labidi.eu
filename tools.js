/* =============================================================================
   PDF Studio — tool registry & implementations

   Every tool is { id, key, cat, icon, build(view, A) } registered into
   PDFAPP. `A` is the app API from app.js (state, UI builders, pdf plumbing).

   Conventions
   · Tools that TRANSFORM the working copy call runner.applied(bytes) —
     the result becomes the new working copy (undo-able) and can be chained.
   · Tools that PRODUCE separate artifacts (split parts, images, text,
     encrypted copies) call runner.files()/runner.text() instead.
   ========================================================================== */
/* global PDFI18N, PDFLib, pdfjsLib, Tesseract, PDFAPP */
(function () {
    'use strict';

    const A = window.PDFAPP;
    const t = (k, v) => PDFI18N.t(k, v);
    const el = A.el;

    const PAGE_SIZES = {
        a4: [595.28, 841.89], a4l: [841.89, 595.28],
        a3: [841.89, 1190.55], a5: [419.53, 595.28],
        letter: [612, 792], letterl: [792, 612], legal: [612, 1008],
    };

    function loadLib(bytes, extra) {
        return PDFLib.PDFDocument.load(bytes, Object.assign({
            ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false,
        }, extra || {}));
    }
    const readBytes = async (file) => new Uint8Array(await file.arrayBuffer());

    async function embedImageAuto(doc, bytes) {
        if (bytes[0] === 0xFF && bytes[1] === 0xD8) return doc.embedJpg(bytes);
        if (bytes[0] === 0x89 && bytes[1] === 0x50) return doc.embedPng(bytes);
        return doc.embedPng(await A.toPngBytes(bytes));
    }

    function capture(elm, e) {
        try { elm.setPointerCapture(e.pointerId); } catch (err) { /* synthetic or stale pointer */ }
    }

    function dictGet(dict, name) {
        try { return dict && dict.lookup(PDFLib.PDFName.of(name)); } catch (e) { return undefined; }
    }

    /* pdf-lib cannot embed pages that have no Contents stream (fully blank
       pages). Give such pages an invisible drawing so embedding succeeds. */
    function ensureContents(doc) {
        for (const p of doc.getPages()) {
            let has = true;
            try { has = !!p.node.Contents(); } catch (e) { has = false; }
            if (!has) p.drawRectangle({ x: 0, y: 0, width: 0.1, height: 0.1, opacity: 0, borderWidth: 0 });
        }
        return doc;
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    async function pageText(doc, i) {
        const page = await doc.getPage(i + 1);
        const tc = await page.getTextContent();
        let out = '';
        for (const item of tc.items) {
            out += item.str;
            out += item.hasEOL ? '\n' : ' ';
        }
        return out.replace(/[ \t]+\n/g, '\n').replace(/ {2,}/g, ' ').trim();
    }

    function posXY(pos, pw, ph, ow, oh, margin) {
        const m = margin === undefined ? 24 : margin;
        const x = pos.endsWith('l') ? m : pos.endsWith('r') ? pw - ow - m : (pw - ow) / 2;
        const y = pos.startsWith('t') ? ph - oh - m : pos.startsWith('b') ? m : (ph - oh) / 2;
        return { x, y };
    }

    /* Bytes of a user-picked PDF, prompting for the password when encrypted.
       Without this, pdf-lib silently copies still-encrypted (garbage) pages. */
    async function pickedPdfBytes(file) {
        let bytes = await readBytes(file);
        const probe = await loadLib(bytes);
        if (!probe.isEncrypted) return bytes;
        for (;;) {
            const pw = await A.askPassword(file.name);
            if (pw === null) throw new Error(t('err_needpw'));
            try {
                const dec = await PDFLib.PDFDocument.load(bytes, { password: pw, updateMetadata: false, throwOnInvalidObject: false });
                const out = await dec.save();
                return out instanceof Uint8Array ? out : new Uint8Array(out);
            } catch (e) { A.toast(t('pw_wrong'), 'err'); }
        }
    }

    /* ------------------------------------------------- page-nav + canvas -- */
    /* Renders one page of the working copy with ‹ › navigation. onDraw(ctx)
       is called after each render so callers can decorate the overlay. */
    function pageStage(host, opts) {
        const o = opts || {};
        let pageIndex = 0;
        let drawToken = 0;
        const label = el('span', { class: 'fr-size' });
        const wrap = el('div', { class: 'place-wrap' });
        const prev = el('button', { type: 'button', class: 'icon-btn', 'aria-label': '‹' }, '‹');
        const next = el('button', { type: 'button', class: 'icon-btn', 'aria-label': '›' }, '›');
        const bar = el('div', { class: 'btn-row', style: 'margin-bottom:.6rem' }, prev, label, next);
        host.appendChild(bar);
        host.appendChild(wrap);
        let canvas = null;
        async function draw() {
            const my = ++drawToken;
            const doc = await A.getDoc();
            const n = doc.numPages;
            pageIndex = Math.max(0, Math.min(n - 1, pageIndex));
            label.textContent = t('page_n', { n: pageIndex + 1 }) + ' / ' + n;
            prev.disabled = pageIndex === 0;
            next.disabled = pageIndex >= n - 1;
            const r = await A.renderPage(doc, pageIndex, { targetWidth: o.width || 520 });
            if (my !== drawToken) return;   // a newer draw superseded this one
            if (canvas) canvas.remove();
            canvas = r.canvas;
            canvas.className = 'pw-page';
            wrap.insertBefore(canvas, wrap.firstChild);
            if (o.onDraw) o.onDraw(pageIndex, canvas, wrap);
        }
        prev.addEventListener('click', () => { pageIndex--; draw(); });
        next.addEventListener('click', () => { pageIndex++; draw(); });
        draw();
        // stay in sync after apply/undo/redo while this stage is on screen
        document.addEventListener('pdfstudio:workspace', function h() {
            if (!document.body.contains(wrap)) { document.removeEventListener('pdfstudio:workspace', h); return; }
            if (A.state.bytes) draw();
        });
        return { get pageIndex() { return pageIndex; }, redraw: draw, wrap };
    }

    /* draggable/resizable overlay item (signature, stamp, image) */
    function makePlaceItem(wrap, dataUrl, ratio) {
        const item = el('div', { class: 'place-item', style: 'left:10%;top:60%;width:35%;' });
        const img = el('img', { src: dataUrl, alt: '' });
        const handle = el('div', { class: 'pi-resize' });
        item.appendChild(img);
        item.appendChild(handle);
        wrap.appendChild(item);
        item.style.aspectRatio = String(1 / ratio);

        function frac() {
            // left/top/width are maintained as percentages — no layout needed
            const fx = parseFloat(item.style.left) / 100;
            const fy = parseFloat(item.style.top) / 100;
            const fw = parseFloat(item.style.width) / 100;
            if (isFinite(fx) && isFinite(fy) && isFinite(fw)) return { fx, fy, fw };
            const w = wrap.querySelector('canvas.pw-page');
            const wr = w.getBoundingClientRect();
            const ir = item.getBoundingClientRect();
            return {
                fx: (ir.left - wr.left) / (wr.width || 1),
                fy: (ir.top - wr.top) / (wr.height || 1),
                fw: ir.width / (wr.width || 1),
            };
        }

        let drag = null;
        item.addEventListener('pointerdown', (e) => {
            if (e.target === handle) return;
            e.preventDefault();
            capture(item, e);
            const r = item.getBoundingClientRect();
            drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
        });
        item.addEventListener('pointermove', (e) => {
            if (!drag) return;
            const wr = wrap.querySelector('canvas.pw-page').getBoundingClientRect();
            const ir = item.getBoundingClientRect();
            let x = e.clientX - drag.dx - wr.left;
            let y = e.clientY - drag.dy - wr.top;
            x = Math.max(0, Math.min(wr.width - ir.width, x));
            y = Math.max(0, Math.min(wr.height - ir.height, y));
            item.style.left = (x / wr.width * 100) + '%';
            item.style.top = (y / wr.height * 100) + '%';
        });
        item.addEventListener('pointerup', () => { drag = null; });

        let rs = null;
        handle.addEventListener('pointerdown', (e) => {
            e.preventDefault(); e.stopPropagation();
            capture(handle, e);
            const r = item.getBoundingClientRect();
            rs = { x: e.clientX, w: r.width };
        });
        handle.addEventListener('pointermove', (e) => {
            if (!rs) return;
            const wr = wrap.querySelector('canvas.pw-page').getBoundingClientRect();
            const w = Math.max(24, Math.min(wr.width, rs.w + (e.clientX - rs.x)));
            item.style.width = (w / wr.width * 100) + '%';
        });
        handle.addEventListener('pointerup', () => { rs = null; });

        return { item, frac, remove: () => item.remove() };
    }

    /* word-level diff via LCS; falls back when pages are huge */
    function diffWords(aStr, bStr) {
        const a = aStr.split(/\s+/).filter(Boolean);
        const b = bStr.split(/\s+/).filter(Boolean);
        if (a.length * b.length > 4000000) {
            return aStr === bStr ? [] : [{ op: 'del', text: a.join(' ') }, { op: 'add', text: b.join(' ') }];
        }
        const n = a.length, m = b.length;
        const dp = new Uint32Array((n + 1) * (m + 1));
        for (let i = n - 1; i >= 0; i--) {
            for (let j = m - 1; j >= 0; j--) {
                dp[i * (m + 1) + j] = a[i] === b[j]
                    ? dp[(i + 1) * (m + 1) + j + 1] + 1
                    : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
            }
        }
        const ops = [];
        let i = 0, j = 0;
        const push = (op, text) => {
            const last = ops[ops.length - 1];
            if (last && last.op === op) last.text += ' ' + text;
            else ops.push({ op, text });
        };
        while (i < n && j < m) {
            if (a[i] === b[j]) { push('same', a[i]); i++; j++; }
            else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) { push('del', a[i]); i++; }
            else { push('add', b[j]); j++; }
        }
        while (i < n) { push('del', a[i]); i++; }
        while (j < m) { push('add', b[j]); j++; }
        return ops.some((o) => o.op !== 'same') ? ops : [];
    }

    /* rasterize chosen pages through a pixel/canvas transform → new bytes */
    async function rasterTransform(indices, dpi, quality, mutate, progress, opts) {
        const doc = await A.getDoc();
        const map = new Map();
        let k = 0;
        for (const i of indices) {
            const { canvas } = await A.renderPage(doc, i, Object.assign({ dpi, willRead: true }, opts || {}));
            mutate(canvas, i);
            map.set(i, canvas);
            if (progress) progress(++k / indices.length);
        }
        return A.replacePagesWithImages(map, quality);
    }

    function pixelLoop(canvas, fn) {
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        fn(img.data);
        ctx.putImageData(img, 0, 0);
    }

    function toRoman(num) {
        const map = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
            [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
        let out = '';
        for (const [v, s] of map) while (num >= v) { out += s; num -= v; }
        return out;
    }

    /* Write a flat, single-level outline (bookmarks). items: [{title, page}].
       Empty items removes the outline entirely. */
    function writeOutline(doc, items) {
        const N = PDFLib.PDFName.of.bind(PDFLib.PDFName);
        if (!items.length) { doc.catalog.delete(N('Outlines')); return; }
        const ctx = doc.context;
        const refs = items.map(() => ctx.nextRef());
        const outlineRef = ctx.nextRef();
        items.forEach((it, i) => {
            const page = doc.getPage(Math.max(0, Math.min(doc.getPageCount() - 1, it.page)));
            const d = ctx.obj({
                Title: PDFLib.PDFHexString.fromText(it.title || 'Bookmark'),
                Parent: outlineRef,
                Dest: [page.ref, N('Fit')],
            });
            if (i > 0) d.set(N('Prev'), refs[i - 1]);
            if (i < items.length - 1) d.set(N('Next'), refs[i + 1]);
            ctx.assign(refs[i], d);
        });
        ctx.assign(outlineRef, ctx.obj({
            Type: 'Outlines', First: refs[0], Last: refs[refs.length - 1], Count: items.length,
        }));
        doc.catalog.set(N('Outlines'), outlineRef);
    }

    const reg = (def) => A.registerTool(def);

    /* ========================================================== ORGANIZE == */

    reg({
        id: 'merge', key: 'merge', cat: 'organize', icon: '🗂',
        build(view) {
            const body = el('div', { class: 'tool-body' });
            view.appendChild(body);
            const card = el('div', { class: 'card' });
            const picker = A.filePicker({ sortable: true, accept: 'application/pdf,.pdf,image/*' });
            card.appendChild(picker);
            card.appendChild(el('p', { class: 'hint', text: t('merge_hint') + ' ' + t('merge_mixed') }));
            let inclWs = null;
            if (A.state.bytes) {
                inclWs = A.check('merge_use_ws', true);
                card.appendChild(inclWs);
            }
            const addBm = A.check('merge_bm', false);
            card.appendChild(addBm);
            body.appendChild(card);
            const runner = A.makeRunner(body);
            body.insertBefore(el('div', { class: 'btn-row' }, A.runButton('btn_run', async () => {
                try {
                    runner.clear();
                    const files = picker.getFiles();
                    const useWs = inclWs && inclWs.input.checked && A.state.bytes;
                    if (files.length + (useWs ? 1 : 0) < 2) { A.toast(t('merge_need2'), 'err'); return; }
                    const out = await PDFLib.PDFDocument.create();
                    const sources = [];
                    if (useWs) sources.push({ bytes: A.state.bytes, name: A.state.name, isPdf: true });
                    for (const f of files) {
                        const isPdf = /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
                        sources.push({ bytes: isPdf ? await pickedPdfBytes(f) : await readBytes(f), name: f.name, isPdf });
                    }
                    const marks = [];
                    let done = 0;
                    for (const src of sources) {
                        marks.push({ title: src.name.replace(/\.[a-z0-9]+$/i, ''), page: out.getPageCount() });
                        if (src.isPdf) {
                            const d = await loadLib(src.bytes);
                            const pages = await out.copyPages(d, d.getPageIndices());
                            pages.forEach((p) => out.addPage(p));
                        } else {
                            // images become one page each, sized to the picture
                            const img = await embedImageAuto(out, src.bytes);
                            const w = img.width * 72 / 96, h = img.height * 72 / 96;
                            out.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
                        }
                        runner.progress(++done / sources.length);
                    }
                    if (addBm.input.checked) writeOutline(out, marks);
                    const bytes = await out.save();
                    await runner.applied(bytes, { name: 'merged.pdf', downloadName: 'merged.pdf' });
                } catch (e) { runner.error(e); }
            })), runner.host);
        },
    });

    reg({
        id: 'split', key: 'split', cat: 'organize', icon: '✂️',
        build(view) {
            A.workspaceGate(view, (body) => {
                const card = el('div', { class: 'card' });
                const rangesInp = A.input('text', { placeholder: '1-3; 4-6; 7-' });
                const everyInp = A.input('number', { value: '2', min: '1' });
                const sizeInp = A.input('number', { value: '10', min: '1', step: '1' });
                const rangesField = A.field('split_ranges', rangesInp, 'split_ranges_hint');
                const everyField = A.field('split_every_n', everyInp);
                const sizeField = A.field('split_size', sizeInp, 'split_size_hint');
                const seg = A.segmented([
                    { value: 'ranges', label: t('split_ranges') },
                    { value: 'every', label: t('split_every') },
                    { value: 'size', label: t('split_size') },
                    { value: 'bookmarks', label: t('split_bookmarks') },
                ], 'ranges', (v) => {
                    rangesField.style.display = v === 'ranges' ? '' : 'none';
                    everyField.style.display = v === 'every' ? '' : 'none';
                    sizeField.style.display = v === 'size' ? '' : 'none';
                });
                everyField.style.display = 'none';
                sizeField.style.display = 'none';
                card.appendChild(A.field('split_mode', seg));
                card.appendChild(rangesField);
                card.appendChild(everyField);
                card.appendChild(sizeField);
                body.appendChild(card);
                const runner = A.makeRunner(body);
                body.insertBefore(el('div', { class: 'btn-row' }, A.runButton('btn_run', async () => {
                    try {
                        runner.clear();
                        const src = await loadLib(A.state.bytes);
                        const n = src.getPageCount();
                        const base = A.baseName(A.state.name);
                        let groups = [];
                        const mode = seg.getValue();
                        if (mode === 'every') {
                            const step = Math.max(1, +everyInp.value || 1);
                            for (let i = 0; i < n; i += step) groups.push({ name: base + '-' + (groups.length + 1) + '.pdf', idx: Array.from({ length: Math.min(step, n - i) }, (_, k) => i + k) });
                        } else if (mode === 'size') {
                            // greedy page packing measured by real incremental saves
                            const limit = Math.max(0.2, +sizeInp.value || 10) * 1024 * 1024;
                            const parts = [];
                            let cur = [];
                            for (let i = 0; i < n; i++) {
                                cur.push(i);
                                const trial = await PDFLib.PDFDocument.create();
                                (await trial.copyPages(src, cur)).forEach((p) => trial.addPage(p));
                                const sz = (await trial.save()).length;
                                if (sz > limit && cur.length > 1) {
                                    cur.pop();
                                    parts.push(cur);
                                    cur = [i];
                                }
                                runner.progress((i + 1) / n * 0.7);
                            }
                            if (cur.length) parts.push(cur);
                            groups = parts.map((idx, gi) => ({ name: base + '-' + (gi + 1) + '.pdf', idx }));
                        } else if (mode === 'bookmarks') {
                            const doc = await A.getDoc();
                            const outline = await doc.getOutline();
                            if (!outline || !outline.length) { A.toast(t('split_no_bm'), 'err'); return; }
                            const marks = [];
                            for (const item of outline) {
                                try {
                                    let dest = item.dest;
                                    if (typeof dest === 'string') dest = await doc.getDestination(dest);
                                    if (!dest) continue;
                                    const pi = await doc.getPageIndex(dest[0]);
                                    marks.push({ title: item.title || 'section', page: pi });
                                } catch (e) { /* unresolvable dest */ }
                            }
                            marks.sort((a, b) => a.page - b.page);
                            if (!marks.length) { A.toast(t('split_no_bm'), 'err'); return; }
                            if (marks[0].page > 0) marks.unshift({ title: base, page: 0 });
                            for (let i = 0; i < marks.length; i++) {
                                const from = marks[i].page;
                                const to = i + 1 < marks.length ? marks[i + 1].page - 1 : n - 1;
                                if (to < from) continue;
                                const safe = marks[i].title.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'section';
                                groups.push({ name: (i + 1) + '-' + safe + '.pdf', idx: Array.from({ length: to - from + 1 }, (_, k) => from + k) });
                            }
                        } else {
                            const spec = rangesInp.value.trim();
                            // drop empty/garbage segments — parseRanges('') would mean "all pages"
                            const parts = spec
                                ? spec.split(';').map((s) => s.trim()).filter(Boolean)
                                : Array.from({ length: n }, (_, i) => String(i + 1));
                            groups = parts
                                .map((p, gi) => ({ name: base + '-' + (gi + 1) + '.pdf', idx: A.parseRanges(p, n) }))
                                .filter((g) => g.idx.length);
                        }
                        const files = [];
                        let done = 0;
                        const packBase = mode === 'size' ? 0.7 : 0;
                        if (!groups.length) { A.toast(t('hint_pages'), 'err'); runner.done(); return; }
                        for (const g of groups) {
                            const out = await PDFLib.PDFDocument.create();
                            const pages = await out.copyPages(src, g.idx);
                            pages.forEach((p) => out.addPage(p));
                            files.push({ name: g.name, bytes: await out.save(), mime: 'application/pdf' });
                            runner.progress(packBase + (++done / groups.length) * (1 - packBase));
                        }
                        const card2 = runner.files(files);
                        card2.insertBefore(el('p', { class: 'hint', text: t('split_parts', { n: files.length }) }), card2.children[1]);
                    } catch (e) { runner.error(e); }
                })), runner.host);
            });
        },
    });

    reg({
        id: 'mix', key: 'mix', cat: 'organize', icon: '🔀',
        build(view) {
            const body = el('div', { class: 'tool-body' });
            view.appendChild(body);
            body.appendChild(el('p', { class: 'hint', text: t('mix_note') }));
            const card = el('div', { class: 'card' });
            const pickA = A.filePicker({ multiple: false, labelKey: 'btn_choose' });
            const pickB = A.filePicker({ multiple: false, labelKey: 'btn_choose' });
            const fa = A.field(null, pickA);
            fa.insertBefore(el('label', { text: t('mix_a') }), fa.firstChild);
            const fb = A.field(null, pickB);
            fb.insertBefore(el('label', { text: t('mix_b') }), fb.firstChild);
            const rev = A.check('mix_rev', true);
            card.appendChild(el('div', { class: 'field-row' }, fa, fb));
            card.appendChild(rev);
            body.appendChild(card);
            const runner = A.makeRunner(body);
            body.insertBefore(el('div', { class: 'btn-row' }, A.runButton('btn_run', async () => {
                try {
                    runner.clear();
                    if (!pickA.getFiles().length || !pickB.getFiles().length) { A.toast(t('mix_need'), 'err'); return; }
                    const da = await loadLib(await pickedPdfBytes(pickA.getFiles()[0]));
                    const db = await loadLib(await pickedPdfBytes(pickB.getFiles()[0]));
                    const out = await PDFLib.PDFDocument.create();
                    const pa = await out.copyPages(da, da.getPageIndices());
                    let pb = await out.copyPages(db, db.getPageIndices());
                    if (rev.input.checked) pb = pb.reverse();
                    const max = Math.max(pa.length, pb.length);
                    for (let i = 0; i < max; i++) {
                        if (i < pa.length) out.addPage(pa[i]);
                        if (i < pb.length) out.addPage(pb[i]);
                        runner.progress((i + 1) / max);
                    }
                    await runner.applied(await out.save(), { name: 'mixed.pdf', downloadName: 'mixed.pdf' });
                } catch (e) { runner.error(e); }
            })), runner.host);
        },
    });

    reg({
        id: 'insert', key: 'insert', cat: 'organize', icon: '📥',
        build(view) {
            A.workspaceGate(view, (body) => {
                const card = el('div', { class: 'card' });
                const pos = A.input('number', { value: String(A.state.pageCount), min: '0' });
                const posField = A.field('ins_after', pos, 'ins_after_hint');
                const count = A.input('number', { value: '1', min: '1', max: '200' });
                const countField = A.field('ins_count', count);
                const every = A.check('ins_every', false);
                const picker = A.filePicker({ multiple: false, labelKey: 'btn_choose' });
                const fileField = A.field('ins_file', picker);
                fileField.style.display = 'none';
                const mode = A.segmented([
                    { value: 'blank', label: t('ins_mode_blank') }, { value: 'pdf', label: t('ins_mode_pdf') },
                ], 'blank', (v) => {
                    countField.style.display = v === 'blank' ? '' : 'none';
                    every.style.display = v === 'blank' ? '' : 'none';
                    fileField.style.display = v === 'pdf' ? '' : 'none';
                    posField.style.display = (v === 'blank' && every.input.checked) ? 'none' : '';
                });
                every.input.addEventListener('change', () => { posField.style.display = every.input.checked ? 'none' : ''; });
                card.appendChild(A.field(null, mode));
                card.appendChild(posField);
                card.appendChild(countField);
                card.appendChild(every);
                card.appendChild(fileField);
                body.appendChild(card);
                const runner = A.makeRunner(body);
                body.insertBefore(el('div', { class: 'btn-row' }, A.runButton('btn_apply', async () => {
                    try {
                        runner.clear();
                        const src = await loadLib(A.state.bytes);
                        const n = src.getPageCount();
                        const out = await PDFLib.PDFDocument.create();
                        const basePages = await out.copyPages(src, src.getPageIndices());
                        const sizeAt = (i) => {
                            const p = src.getPage(Math.max(0, Math.min(n - 1, i)));
                            return [p.getWidth(), p.getHeight()];
                        };
                        if (mode.getValue() === 'blank' && every.input.checked) {
                            basePages.forEach((p, i) => { out.addPage(p); out.addPage(sizeAt(i)); });
                        } else {
                            const at = Math.max(0, Math.min(n, +pos.value || 0));
                            for (let i = 0; i < at; i++) out.addPage(basePages[i]);
                            if (mode.getValue() === 'blank') {
                                const c = Math.max(1, +count.value || 1);
                                for (let k = 0; k < c; k++) out.addPage(sizeAt(at === 0 ? 0 : at - 1));
                            } else {
                                if (!picker.getFiles().length) { A.toast(t('ins_need'), 'err'); return; }
                                const ins = await loadLib(await pickedPdfBytes(picker.getFiles()[0]));
                                (await out.copyPages(ins, ins.getPageIndices())).forEach((p) => out.addPage(p));
                            }
                            for (let i = at; i < n; i++) out.addPage(basePages[i]);
                        }
                        await runner.applied(await out.save());
                    } catch (e) { runner.error(e); }
                })), runner.host);
            });
        },
    });

    reg({
        id: 'headers-footers', key: 'hf', cat: 'organize', icon: '📰',
        build(view) {
            A.workspaceGate(view, (body) => {
                body.appendChild(el('p', { class: 'hint', text: t('hf_vars') }));
                const card = el('div', { class: 'card' });
                const slots = {};
                for (const rowKey of ['header', 'footer']) {
                    const row = el('div', { class: 'field-row' });
                    for (const colKey of ['l', 'c', 'r']) {
                        const inp = A.input('text', { autocomplete: 'off', spellcheck: 'false' });
                        slots[rowKey + colKey] = inp;
                        const f = A.field(null, inp);
                        f.insertBefore(el('label', { text: t('hf_' + rowKey) + ' — ' + t('hf_' + colKey) }), f.firstChild);
                        row.appendChild(f);
                    }
                    card.appendChild(row);
                }
                slots.footerc.value = '{n} / {total}';
                const size = A.input('number', { value: '9', min: '5', max: '24' });
                const margin = A.input('number', { value: '24', min: '8', max: '120' });
                const batesStart = A.input('number', { value: '1', min: '0' });
                const batesDigits = A.input('number', { value: '6', min: '3', max: '10' });
                card.appendChild(el('div', { class: 'field-row' },
                    A.field('opt_fontsize', size), A.field('opt_margin', margin),
                    A.field('hf_bates_start', batesStart), A.field('hf_bates_digits', batesDigits)));
                const pages = A.pagesField();
                card.appendChild(pages);
                body.appendChild(card);
                const runner = A.makeRunner(body);
                body.insertBefore(el('div', { class: 'btn-row' }, A.runButton('btn_apply', async () => {
                    try {
                        runner.clear();
                        if (!Object.values(slots).some((inp) => inp.value.trim())) { A.toast(t('hf_vars'), 'err'); return; }
                        const doc = await loadLib(A.state.bytes);
                        const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
                        const idx = pages.getIndices(doc.getPageCount());
                        const fs = +size.value || 9;
                        const mg = +margin.value || 24;
                        const date = new Date().toLocaleDateString(PDFI18N.lang);
                        const fname = A.state.name;
                        let bates = Math.max(0, +batesStart.value || 1);
                        const digits = Math.max(3, +batesDigits.value || 6);
                        const total = doc.getPageCount();
                        idx.forEach((i) => {
                            const p = doc.getPage(i);
                            const W = p.getWidth(), H = p.getHeight();
                            const fill = (tpl) => A.winAnsiSafe(String(tpl)
                                .split('{n}').join(String(i + 1))
                                .split('{total}').join(String(total))
                                .split('{date}').join(date)
                                .split('{file}').join(fname)
                                .split('{bates}').join(String(bates).padStart(digits, '0')));
                            for (const [slot, inp] of Object.entries(slots)) {
                                const raw = inp.value.trim();
                                if (!raw) continue;
                                const str = fill(raw);
                                const tw = font.widthOfTextAtSize(str, fs);
                                const x = slot.endsWith('l') ? mg : slot.endsWith('r') ? W - tw - mg : (W - tw) / 2;
                                const y = slot.startsWith('header') ? H - mg : mg - fs / 2;
                                p.drawText(str, { x, y, size: fs, font, color: PDFLib.rgb(0.25, 0.25, 0.28) });
                            }
                            bates++;
                        });
                        await runner.applied(await doc.save());
                    } catch (e) { runner.error(e); }
                })), runner.host);
            });
        },
    });

    reg({
        id: 'organize', key: 'organize', cat: 'organize', icon: '🧩',
        build(view) {
            A.workspaceGate(view, async (body) => {
                body.appendChild(el('p', { class: 'hint', text: t('org_hint') }));
                const bar = el('div', { class: 'btn-row', style: 'margin-bottom:.7rem' });
                const grid = el('div', { class: 'page-grid' });
                body.appendChild(bar);
                body.appendChild(grid);
                const runner = A.makeRunner(body);

                let items = [];          // [{src, rot, thumb}]
                const selected = new Set();
                const selLabel = el('span', { class: 'fr-size' });

                function redraw() {
                    grid.textContent = '';
                    items.forEach((it, i) => {
                        const tile = el('button', { type: 'button', class: 'page-tile' + (selected.has(i) ? ' is-selected' : ''), draggable: 'true', dataset: { idx: i } });
                        const holder = el('span', { class: 'pt-rot', style: 'display:block;transform:rotate(' + it.rot + 'deg)' });
                        if (it.thumb) holder.appendChild(it.thumb.cloneNode ? cloneCanvas(it.thumb) : it.thumb);
                        tile.appendChild(holder);
                        tile.appendChild(el('span', { class: 'pt-num' }, String(i + 1)));
                        if (it.rot) tile.appendChild(el('span', { class: 'pt-badge' }, it.rot + '°'));
                        tile.addEventListener('click', () => {
                            if (selected.has(i)) selected.delete(i); else selected.add(i);
                            redraw();
                        });
                        tile.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(i)); tile.classList.add('is-dragging'); });
                        tile.addEventListener('dragend', () => tile.classList.remove('is-dragging'));
                        tile.addEventListener('dragover', (e) => e.preventDefault());
                        tile.addEventListener('drop', (e) => {
                            e.preventDefault(); e.stopPropagation();
                            const from = +e.dataTransfer.getData('text/plain');
                            if (isNaN(from) || from === i) return;
                            const [m] = items.splice(from, 1);
                            items.splice(i, 0, m);
                            selected.clear();
                            redraw();
                        });
                        grid.appendChild(tile);
                    });
                    selLabel.textContent = t('org_selected', { n: selected.size });
                }
                function cloneCanvas(c) {
                    const d = document.createElement('canvas');
                    d.width = c.width; d.height = c.height;
                    d.getContext('2d').drawImage(c, 0, 0);
                    return d;
                }
                const forSel = (fn) => { if (selected.size) { fn([...selected].sort((a, b) => a - b)); redraw(); } };
                bar.appendChild(el('button', { type: 'button', class: 'btn', onclick: () => forSel((sel) => sel.forEach((i) => { items[i].rot = (items[i].rot + 90) % 360; })) }, '↻ ' + t('org_rotate')));
                bar.appendChild(el('button', {
                    type: 'button', class: 'btn', onclick: () => forSel((sel) => {
                        for (let k = sel.length - 1; k >= 0; k--) items.splice(sel[k] + 1, 0, Object.assign({}, items[sel[k]]));
                        selected.clear();
                    }),
                }, '⧉ ' + t('org_dup')));
                bar.appendChild(el('button', {
                    type: 'button', class: 'btn', onclick: () => forSel((sel) => {
                        for (let k = sel.length - 1; k >= 0; k--) items.splice(sel[k], 1);
                        selected.clear();
                    }),
                }, '🗑 ' + t('org_del')));
                bar.appendChild(el('button', { type: 'button', class: 'btn', onclick: () => { items.reverse(); selected.clear(); redraw(); } }, '⇅ ' + t('org_reverse')));
                bar.appendChild(el('button', { type: 'button', class: 'btn', onclick: () => { items.forEach((_, i) => selected.add(i)); redraw(); } }, t('btn_select_all')));
                bar.appendChild(el('button', { type: 'button', class: 'btn', onclick: () => { selected.clear(); redraw(); } }, t('btn_select_none')));
                bar.appendChild(selLabel);

                body.insertBefore(el('div', { class: 'btn-row', style: 'margin-top:.8rem' }, A.runButton('btn_apply', async () => {
                    try {
                        runner.clear();
                        if (!items.length) { A.toast(t('org_empty'), 'err'); return; }
                        const src = await loadLib(A.state.bytes);
                        const out = await PDFLib.PDFDocument.create();
                        const pages = await out.copyPages(src, items.map((x) => x.src));
                        pages.forEach((p, i) => {
                            if (items[i].rot) p.setRotation(PDFLib.degrees((p.getRotation().angle + items[i].rot) % 360));
                            out.addPage(p);
                        });
                        await runner.applied(await out.save());
                    } catch (e) { runner.error(e); }
                })), runner.host);

                /* thumbnails */
                const doc = await A.getDoc();
                items = Array.from({ length: doc.numPages }, (_, i) => ({ src: i, rot: 0, thumb: null }));
                redraw();
                for (let i = 0; i < Math.min(items.length, 200); i++) {
                    if (!document.body.contains(grid)) return;   // user navigated away
                    const { canvas } = await A.renderPage(doc, i, { targetWidth: 150 });
                    items[i].thumb = canvas;
                    if (i % 4 === 3 || i === items.length - 1) redraw();
                }
                redraw();
            });
        },
    });

    reg({
        id: 'rotate', key: 'rotate', cat: 'organize', icon: '↻',
        build(view) {
            A.workspaceGate(view, (body) => {
                const card = el('div', { class: 'card' });
                const seg = A.segmented([
                    { value: '90', label: '90°' }, { value: '180', label: '180°' }, { value: '270', label: '270°' },
                ], '90');
                const pages = A.pagesField();
                card.appendChild(A.field('opt_angle', seg));
                card.appendChild(pages);
                body.appendChild(card);
                const runner = A.makeRunner(body);
                body.insertBefore(el('div', { class: 'btn-row' }, A.runButton('btn_apply', async () => {
                    try {
                        runner.clear();
                        const doc = await loadLib(A.state.bytes);
                        const idx = pages.getIndices(doc.getPageCount());
                        const add = +seg.getValue();
                        for (const i of idx) {
                            const p = doc.getPage(i);
                            p.setRotation(PDFLib.degrees((p.getRotation().angle + add) % 360));
                        }
                        await runner.applied(await doc.save());
                    } catch (e) { runner.error(e); }
                })), runner.host);
            });
        },
    });

    reg({
        id: 'remove-pages', key: 'removepages', cat: 'organize', icon: '🚮',
        build(view) {
            A.workspaceGate(view, (body) => {
                const card = el('div', { class: 'card' });
                const inp = A.input('text', { placeholder: t('hint_pages_req') });
                card.appendChild(A.field('rm_label', inp, 'hint_pages_req'));
                body.appendChild(card);
                const runner = A.makeRunner(body);
                body.insertBefore(el('div', { class: 'btn-row' }, A.runButton('btn_apply', async () => {
                    try {
                        runner.clear();
                        if (!inp.value.trim()) { A.toast(t('rm_empty'), 'err'); return; }
                        const src = await loadLib(A.state.bytes);
                        const n = src.getPageCount();
                        const rm = new Set(A.parseRanges(inp.value, n));
                        const keep = Array.from({ length: n }, (_, i) => i).filter((i) => !rm.has(i));
                        if (!keep.length) { A.toast(t('rm_all_err'), 'err'); return; }
                        const out = await PDFLib.PDFDocument.create();
                        (await out.copyPages(src, keep)).forEach((p) => out.addPage(p));
                        await runner.applied(await out.save());
                    } catch (e) { runner.error(e); }
                })), runner.host);
            });
        },
    });

    reg({
        id: 'extract-pages', key: 'extract', cat: 'organize', icon: '📑',
        build(view) {
            A.workspaceGate(view, (body) => {
                const card = el('div', { class: 'card' });
                const inp = A.input('text', { placeholder: t('hint_pages') });
                card.appendChild(A.field('ex_label', inp, 'hint_pages'));
                body.appendChild(card);
                const runner = A.makeRunner(body);
                body.insertBefore(el('div', { class: 'btn-row' }, A.runButton('btn_apply', async () => {
                    try {
                        runner.clear();
                        const src = await loadLib(A.state.bytes);
                        const idx = A.parseRanges(inp.value || 'all', src.getPageCount());
                        const out = await PDFLib.PDFDocument.create();
                        (await out.copyPages(src, idx)).forEach((p) => out.addPage(p));
                        await runner.applied(await out.save(), { downloadName: A.baseName(A.state.name) + '-extract.pdf' });
                    } catch (e) { runner.error(e); }
                })), runner.host);
            });
        },
    });

    reg({
        id: 'remove-blank', key: 'removeblank', cat: 'organize', icon: '⬜',
        build(view) {
            A.workspaceGate(view, (body) => {
                const card = el('div', { class: 'card' });
                const sens = A.input('range', { min: '0', max: '100', value: '20' });
                card.appendChild(A.field('rb_sens', sens, 'rb_sens_hint'));
                body.appendChild(card);
                const runner = A.makeRunner(body);
                let found = [];
                const removeBtn = el('button', { type: 'button', class: 'btn btn-primary', hidden: true }, t('rb_remove'));
                removeBtn.addEventListener('click', async () => {
                    if (removeBtn.disabled) return;
                    removeBtn.disabled = true;
                    try {
                        const src = await loadLib(A.state.bytes);
                        const keep = src.getPageIndices().filter((i) => !found.includes(i));
                        if (!keep.length) { A.toast(t('rm_all_err'), 'err'); return; }
                        const out = await PDFLib.PDFDocument.create();
                        (await out.copyPages(src, keep)).forEach((p) => out.addPage(p));
                        removeBtn.hidden = true;
                        found = [];
                        await runner.applied(await out.save());
                    } catch (e) { runner.error(e); }
                    finally { removeBtn.disabled = false; }
                });
                body.insertBefore(el('div', { class: 'btn-row' }, A.runButton('rb_scan', async () => {
                    try {
                        runner.clear();
                        removeBtn.hidden = true;
                        const threshold = 0.00005 + (+sens.value / 100) * 0.002;
                        const doc = await A.getDoc();
                        found = [];
                        for (let i = 0; i < doc.numPages; i++) {
                            const { canvas } = await A.renderPage(doc, i, { dpi: 36, willRead: true });
                            const ctx = canvas.getContext('2d', { willReadFrequently: true });
                            const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
                            let dark = 0;
                            for (let p = 0; p < d.length; p += 4) {
                                if ((d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114) < 240) dark++;
                            }
                            if (dark / (canvas.width * canvas.height) <= threshold) found.push(i);
                            runner.progress((i + 1) / doc.numPages);
                        }
                        runner.done();
                        runner.host.textContent = '';
                        const msg = found.length
                            ? t('rb_found', { list: found.map((i) => i + 1).join(', ') })
                            : t('rb_none');
                        removeBtn.hidden = !found.length;
                        runner.host.appendChild(el('div', { class: 'card result' }, el('p', { class: 'res-title', text: msg }), removeBtn));
                    } catch (e) { runner.error(e); }
                })), runner.host);
            });
        },
    });

    reg({
        id: 'crop', key: 'crop', cat: 'organize', icon: '⛶',
        build(view) {
            A.workspaceGate(view, (body) => {
                body.appendChild(el('p', { class: 'hint', text: t('crop_hint') }));
                const nums = {};
                const row = el('div', { class: 'field-row' });
                for (const k of ['t', 'r', 'b', 'l']) {
                    nums[k] = A.input('number', { value: '0', min: '0', step: '1' });
                    row.appendChild(A.field('crop_' + k, nums[k]));
                }
                const card = el('div', { class: 'card' }, row);
                const stageCard = el('div', { class: 'card' });
                body.appendChild(stageCard);
                body.appendChild(card);
                let rectDiv = null;
                let stage = null;
                function syncRect() {
                    if (!stage) return;
                    const canvas = stage.wrap.querySelector('canvas.pw-page');
                    if (!canvas) return;
                    A.getDoc().then(async (doc) => {
                        const page = await doc.getPage(stage.pageIndex + 1);
                        const vp = page.getViewport({ scale: 1 });
                        const rect = canvas.getBoundingClientRect();
                        const sx = rect.width / vp.width, sy = rect.height / vp.height;
                        if (rectDiv) rectDiv.remove();
                        rectDiv = el('div', { style: 'position:absolute;border:2px dashed var(--accent);pointer-events:none;' });
                        rectDiv.style.left = ((+nums.l.value || 0) * sx) + 'px';
                        rectDiv.style.top = ((+nums.t.value || 0) * sy) + 'px';
                        rectDiv.style.width = Math.max(0, rect.width - ((+nums.l.value || 0) + (+nums.r.value || 0)) * sx) + 'px';
                        rectDiv.style.height = Math.max(0, rect.height - ((+nums.t.value || 0) + (+nums.b.value || 0)) * sy) + 'px';
                        stage.wrap.appendChild(rectDiv);
                    });
                }
                stage = pageStage(stageCard, {
                    onDraw(pi, canvas, wrap) {
                        let start = null;
                        canvas.style.touchAction = 'none';
                        canvas.addEventListener('pointerdown', (e) => {
                            e.preventDefault();
                            capture(canvas, e);
                            const r = canvas.getBoundingClientRect();
                            start = { x: e.clientX - r.left, y: e.clientY - r.top, r };
                        });
                        canvas.addEventListener('pointermove', async (e) => {
                            if (!start) return;
                            const x2 = e.clientX - start.r.left, y2 = e.clientY - start.r.top;
                            const doc = await A.getDoc();
                            const page = await doc.getPage(stage.pageIndex + 1);
                            const vp = page.getViewport({ scale: 1 });
                            const sx = vp.width / start.r.width, sy = vp.height / start.r.height;
                            nums.l.value = Math.round(Math.max(0, Math.min(start.x, x2)) * sx);
                            nums.t.value = Math.round(Math.max(0, Math.min(start.y, y2)) * sy);
                            nums.r.value = Math.round(Math.max(0, (start.r.width - Math.max(start.x, x2))) * sx);
                            nums.b.value = Math.round(Math.max(0, (start.r.height - Math.max(start.y, y2))) * sy);
                            syncRect();
                        });
                        canvas.addEventListener('pointerup', () => { start = null; });
                        syncRect();
                    },
                });
                for (const k of Object.keys(nums)) nums[k].addEventListener('input', syncRect);
                const autoBtn = el('button', { type: 'button', class: 'btn' }, '✨ ' + t('crop_auto'));
                autoBtn.addEventListener('click', async () => {
                    autoBtn.disabled = true;
                    try {
                        // union ink bbox across sampled pages → margins with 6pt padding
                        const doc = await A.getDoc();
                        const n = doc.numPages;
                        const sample = n <= 16 ? Array.from({ length: n }, (_, i) => i)
                            : Array.from({ length: 16 }, (_, i) => Math.floor(i * (n - 1) / 15));
                        let bb = null;
                        let ref = null;
                        for (const i of sample) {
                            const { canvas, page } = await A.renderPage(doc, i, { dpi: 50, willRead: true });
                            const vp = page.getViewport({ scale: 1 });
                            if (!ref) ref = vp;
                            const ctx = canvas.getContext('2d', { willReadFrequently: true });
                            const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
                            let x0 = canvas.width, y0 = canvas.height, x1 = -1, y1 = -1;
                            for (let y = 0; y < canvas.height; y++) {
                                for (let x = 0; x < canvas.width; x++) {
                                    const p = (y * canvas.width + x) * 4;
                                    if ((d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114) < 242) {
                                        if (x < x0) x0 = x;
                                        if (x > x1) x1 = x;
                                        if (y < y0) y0 = y;
                                        if (y > y1) y1 = y;
                                    }
                                }
                            }
                            if (x1 < 0) continue;
                            const s = vp.width / canvas.width;
                            const box = { l: x0 * s, t: y0 * s, r: vp.width - (x1 + 1) * s, b: vp.height - (y1 + 1) * s };
                            bb = bb ? { l: Math.min(bb.l, box.l), t: Math.min(bb.t, box.t), r: Math.min(bb.r, box.r), b: Math.min(bb.b, box.b) } : box;
                        }
                        if (bb) {
                            const pad = 6;
                            nums.l.value = Math.max(0, Math.round(bb.l - pad));
                            nums.t.value = Math.max(0, Math.round(bb.t - pad));
                            nums.r.value = Math.max(0, Math.round(bb.r - pad));
                            nums.b.value = Math.max(0, Math.round(bb.b - pad));
                            syncRect();
                        }
                    } finally { autoBtn.disabled = false; }
                });
                card.appendChild(el('div', { class: 'btn-row' }, autoBtn, el('button', {
                    type: 'button', class: 'btn', onclick: () => { for (const k of Object.keys(nums)) nums[k].value = '0'; syncRect(); },
                }, t('crop_reset'))));
                const runner = A.makeRunner(body);
                body.insertBefore(el('div', { class: 'btn-row' }, A.runButton('btn_apply', async () => {
                    try {
                        runner.clear();
                        const doc = await loadLib(A.state.bytes);
                        const l = +nums.l.value || 0, r = +nums.r.value || 0, tt = +nums.t.value || 0, b = +nums.b.value || 0;
                        for (const p of doc.getPages()) {
                            const mb = p.getMediaBox();
                            const nx = mb.x + l, ny = mb.y + b;
                            const nw = Math.max(24, mb.width - l - r), nh = Math.max(24, mb.height - tt - b);
                            p.setMediaBox(nx, ny, nw, nh);
                            p.setCropBox(nx, ny, nw, nh);
                        }
                        await runner.applied(await doc.save());
                        // fresh margins for the already-cropped result, so a second
                        // Apply doesn't silently crop twice
                        for (const k of Object.keys(nums)) nums[k].value = '0';
                        syncRect();
                    } catch (e) { runner.error(e); }
                })), runner.host);
            });
        },
    });

    reg({
        id: 'split-half', key: 'splithalf', cat: 'organize', icon: '⇹',
        build(view) {
            A.workspaceGate(view, (body) => {
                const card = el('div', { class: 'card' });
                const seg = A.segmented([{ value: 'v', label: t('sh_v') }, { value: 'h', label: t('sh_h') }], 'v');
                card.appendChild(A.field('sh_dir', seg));
                body.appendChild(card);
                const runner = A.makeRunner(body);
                body.insertBefore(el('div', { class: 'btn-row' }, A.runButton('btn_apply', async () => {
                    try {
                        runner.clear();
                        const src = ensureContents(await loadLib(A.state.bytes));
                        const out = await PDFLib.PDFDocument.create();
                        const vertical = seg.getValue() === 'v';
                        const n = src.getPageCount();
                        for (let i = 0; i < n; i++) {
                            const page = src.getPage(i);
                            const mb = page.getMediaBox();
                            const halves = vertical
                                ? [{ left: mb.x, right: mb.x + mb.width / 2, bottom: mb.y, top: mb.y + mb.height },
                                   { left: mb.x + mb.width / 2, right: mb.x + mb.width, bottom: mb.y, top: mb.y + mb.height }]
                                : [{ left: mb.x, right: mb.x + mb.width, bottom: mb.y + mb.height / 2, top: mb.y + mb.height },
                                   { left: mb.x, right: mb.x + mb.width, bottom: mb.y, top: mb.y + mb.height / 2 }];
                            for (const hbox of halves) {
                                const emb = await out.embedPage(page, hbox);
                                const p = out.addPage([hbox.right - hbox.left, hbox.top - hbox.bottom]);
                                p.drawPage(emb, { x: 0, y: 0 });
                            }
                            runner.progress((i + 1) / n);
                        }
                        await runner.applied(await out.save());
                    } catch (e) { runner.error(e); }
                })), runner.host);
            });
        },
    });

    reg({
        id: 'scale', key: 'scale', cat: 'organize', icon: '⤢',
        build(view) {
            A.workspaceGate(view, (body) => {
                const card = el('div', { class: 'card' });
                const target = A.select([
                    { value: 'keep', label: t('keep_size') },
                    { value: 'a4', label: 'A4' }, { value: 'a4l', label: 'A4 ↔' },
                    { value: 'letter', label: 'Letter' }, { value: 'a3', label: 'A3' },
                    { value: 'a5', label: 'A5' }, { value: 'legal', label: 'Legal' },
                ], 'a4');
                const content = A.input('number', { value: '100', min: '10', max: '400' });
                card.appendChild(A.field('sc_target', target));
                card.appendChild(A.field('sc_content', content));
                body.appendChild(card);
                const runner = A.makeRunner(body);
                body.insertBefore(el('div', { class: 'btn-row' }, A.runButton('btn_apply', async () => {
                    try {
                        runner.clear();
                        const src = ensureContents(await loadLib(A.state.bytes));
                        const out = await PDFLib.PDFDocument.create();
                        const cs = Math.max(0.1, (+content.value || 100) / 100);
                        const n = src.getPageCount();
                        for (let i = 0; i < n; i++) {
                            const page = src.getPage(i);
                            const emb = await out.embedPage(page);
                            const [tw, th] = target.value === 'keep' ? [page.getWidth(), page.getHeight()] : PAGE_SIZES[target.value];
                            const fit = target.value === 'keep' ? 1 : Math.min(tw / emb.width, th / emb.height);
                            const w = emb.width * fit * cs, h = emb.height * fit * cs;
                            const p = out.addPage([tw, th]);
                            p.drawPage(emb, { x: (tw - w) / 2, y: (th - h) / 2, width: w, height: h });
                            runner.progress((i + 1) / n);
                        }
                        await runner.applied(await out.save());
                    } catch (e) { runner.error(e); }
                })), runner.host);
            });
        },
    });

    reg({
        id: 'nup', key: 'nup', cat: 'organize', icon: '▦',
        build(view) {
            A.workspaceGate(view, (body) => {
                const card = el('div', { class: 'card' });
                const per = A.segmented([
                    { value: '2', label: '2' }, { value: '4', label: '4' },
                    { value: '9', label: '9' }, { value: '16', label: '16' },
                ], '2');
                const borders = A.check('nup_border', false);
                card.appendChild(A.field('nup_per', per));
                card.appendChild(borders);
                body.appendChild(card);
                const runner = A.makeRunner(body);
                body.insertBefore(el('div', { class: 'btn-row' }, A.runButton('btn_apply', async () => {
                    try {
                        runner.clear();
                        const src = ensureContents(await loadLib(A.state.bytes));
                        const out = await PDFLib.PDFDocument.create();
                        const k = +per.getValue();
                        const grid = { 2: [2, 1], 4: [2, 2], 9: [3, 3], 16: [4, 4] }[k];
                        const [sw, sh] = k === 2 ? PAGE_SIZES.a4l : PAGE_SIZES.a4;
                        const n = src.getPageCount();
                        const embeds = await out.embedPdf(src, src.getPageIndices());
                        const cw = sw / grid[0], ch = sh / grid[1];
                        for (let i = 0; i < n; i += k) {
                            const p = out.addPage([sw, sh]);
                            for (let j = 0; j < k && i + j < n; j++) {
                                const emb = embeds[i + j];
                                const col = j % grid[0], rowi = Math.floor(j / grid[0]);
                                const fit = Math.min((cw - 12) / emb.width, (ch - 12) / emb.height);
                                const w = emb.width * fit, h = emb.height * fit;
                                const x = col * cw + (cw - w) / 2;
                                const y = sh - (rowi + 1) * ch + (ch - h) / 2;
                                p.drawPage(emb, { x, y, width: w, height: h });
                                if (borders.input.checked) p.drawRectangle({ x, y, width: w, height: h, borderColor: PDFLib.rgb(0.6, 0.6, 0.6), borderWidth: 0.75 });
                            }
                            runner.progress(Math.min(1, (i + k) / n));
                        }
                        await runner.applied(await out.save());
                    } catch (e) { runner.error(e); }
                })), runner.host);
            });
        },
    });

    reg({
        id: 'booklet', key: 'booklet', cat: 'organize', icon: '📖',
        build(view) {
            A.workspaceGate(view, (body) => {
                body.appendChild(el('p', { class: 'hint', text: t('bk_hint') }));
                const runner = A.makeRunner(body);
                body.insertBefore(el('div', { class: 'btn-row' }, A.runButton('btn_apply', async () => {
                    try {
                        runner.clear();
                        const src = ensureContents(await loadLib(A.state.bytes));
                        const n = src.getPageCount();
                        const m = Math.ceil(n / 4) * 4;
                        const out = await PDFLib.PDFDocument.create();
                        const embeds = await out.embedPdf(src, src.getPageIndices());
                        const [sw, sh] = PAGE_SIZES.a4l;
                        const pairs = [];
                        let lo = 1, hi = m;
                        while (lo < hi) {
                            pairs.push([hi, lo]); lo++; hi--;
                            pairs.push([lo, hi]); lo++; hi--;
                        }
                        for (const [left, right] of pairs) {
                            const p = out.addPage([sw, sh]);
                            for (const [slot, num] of [[0, left], [1, right]]) {
                                if (num > n) continue;
                                const emb = embeds[num - 1];
                                const fit = Math.min((sw / 2 - 16) / emb.width, (sh - 16) / emb.height);
                                const w = emb.width * fit, h = emb.height * fit;
                                p.drawPage(emb, { x: slot * sw / 2 + (sw / 2 - w) / 2, y: (sh - h) / 2, width: w, height: h });
                            }
                        }
                        await runner.applied(await out.save());
                    } catch (e) { runner.error(e); }
                })), runner.host);
            });
        },
    });

    reg({
        id: 'page-numbers', key: 'pagenums', cat: 'organize', icon: '#️⃣',
        build(view) {
            A.workspaceGate(view, (body) => {
                const card = el('div', { class: 'card' });
                const pos = A.select([
                    { value: 'bc', label: t('pos_bc') }, { value: 'bl', label: t('pos_bl') }, { value: 'br', label: t('pos_br') },
                    { value: 'tc', label: t('pos_tc') }, { value: 'tl', label: t('pos_tl') }, { value: 'tr', label: t('pos_tr') },
                ], 'bc');
                const fmt = A.select([
                    { value: 'n', label: t('pn_fmt_n') }, { value: 'of', label: t('pn_fmt_of') },
                    { value: 'page', label: t('pn_fmt_page') }, { value: 'pageof', label: t('pn_fmt_pageof') },
                    { value: 'roman', label: 'i, ii, iii' }, { value: 'ROMAN', label: 'I, II, III' },
                ], 'n');
                const start = A.input('number', { value: '1' });
                const size = A.input('number', { value: '11', min: '5', max: '48' });
                const pages = A.pagesField();
                const r1 = el('div', { class: 'field-row' }, A.field('opt_position', pos), A.field('pn_fmt', fmt));
                const r2 = el('div', { class: 'field-row' }, A.field('pn_start', start), A.field('opt_fontsize', size));
                card.appendChild(r1); card.appendChild(r2); card.appendChild(pages);
                body.appendChild(card);
                const runner = A.makeRunner(body);
                body.insertBefore(el('div', { class: 'btn-row' }, A.runButton('btn_apply', async () => {
                    try {
                        runner.clear();
                        const doc = await loadLib(A.state.bytes);
                        const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
                        const n = doc.getPageCount();
                        const idx = pages.getIndices(n);
                        const s0 = +start.value || 1;
                        const fs = +size.value || 11;
                        idx.forEach((i, k) => {
                            const num = s0 + k;
                            const total = s0 + idx.length - 1;
                            const label = fmt.value === 'of' ? num + ' / ' + total
                                : fmt.value === 'page' ? t('pn_fmt_page').replace('1', String(num))
                                : fmt.value === 'pageof' ? t('pn_fmt_pageof').replace('1', String(num)).replace('N', String(total))
                                : fmt.value === 'roman' ? toRoman(num)
                                : fmt.value === 'ROMAN' ? toRoman(num).toUpperCase()
                                : String(num);
                            const p = doc.getPage(i);
                            const tw = font.widthOfTextAtSize(label, fs);
                            const { x, y } = posXY(pos.value, p.getWidth(), p.getHeight(), tw, fs, 28);
                            p.drawText(label, { x, y, size: fs, font, color: PDFLib.rgb(0.2, 0.2, 0.2) });
                        });
                        await runner.applied(await doc.save());
                    } catch (e) { runner.error(e); }
                })), runner.host);
            });
        },
    });

    /* =========================================================== CONVERT == */

    reg({
        id: 'img-to-pdf', key: 'img2pdf', cat: 'convert', icon: '🖼',
        build(view) {
            const body = el('div', { class: 'tool-body' });
            view.appendChild(body);
            const card = el('div', { class: 'card' });
            const picker = A.filePicker({ accept: 'image/*', sortable: true, labelKey: 'i2p_add' });
            const size = A.select([
                { value: 'auto', label: t('i2p_size_auto') },
                { value: 'a4', label: 'A4' }, { value: 'a4l', label: 'A4 ↔' }, { value: 'letter', label: 'Letter' },
            ], 'auto');
            const margin = A.input('number', { value: '0', min: '0', max: '120' });
            card.appendChild(picker);
            card.appendChild(el('div', { class: 'field-row' }, A.field('opt_pagesize', size), A.field('i2p_margin', margin)));
            body.appendChild(card);
            const runner = A.makeRunner(body);
            body.insertBefore(el('div', { class: 'btn-row' }, A.runButton('btn_run', async () => {
                try {
                    runner.clear();
                    const files = picker.getFiles();
                    if (!files.length) { A.toast(t('i2p_need'), 'err'); return; }
                    const out = await PDFLib.PDFDocument.create();
                    const mg = +margin.value || 0;
                    let done = 0;
                    for (const f of files) {
                        const bytes = await readBytes(f);
                        const img = await embedImageAuto(out, bytes);
                        if (size.value === 'auto') {
                            const w = img.width * 72 / 96, h = img.height * 72 / 96;
                            out.addPage([w + mg * 2, h + mg * 2]).drawImage(img, { x: mg, y: mg, width: w, height: h });
                        } else {
                            const [pw, ph] = PAGE_SIZES[size.value];
                            const fit = Math.min((pw - mg * 2) / img.width, (ph - mg * 2) / img.height);
                            const w = img.width * fit, h = img.height * fit;
                            out.addPage([pw, ph]).drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
                        }
                        runner.progress(++done / files.length);
                    }
                    await runner.applied(await out.save(), { name: 'images.pdf', downloadName: 'images.pdf' });
                } catch (e) { runner.error(e); }
            })), runner.host);
        },
    });

    reg({
        id: 'pdf-to-img', key: 'pdf2img', cat: 'convert', icon: '🏞',
        build(view) {
            A.workspaceGate(view, (body) => {
                const card = el('div', { class: 'card' });
                const fmt = A.segmented([
                    { value: 'png', label: 'PNG' }, { value: 'jpeg', label: 'JPEG' }, { value: 'webp', label: 'WebP' },
                ], 'png');
                const dpi = A.select([
                    { value: '72', label: '72' }, { value: '150', label: '150' }, { value: '300', label: '300' },
                ], '150');
                const q = A.input('range', { min: '30', max: '100', value: '90' });
                const pages = A.pagesField();
                card.appendChild(A.field('opt_format', fmt));
                card.appendChild(el('div', { class: 'field-row' }, A.field('opt_dpi', dpi), A.field('opt_quality', q)));
                card.appendChild(pages);
                body.appendChild(card);
                const runner = A.makeRunner(body);
                body.insertBefore(el('div', { class: 'btn-row' }, A.runButton('btn_run', async () => {
                    try {
                        runner.clear();
                        const doc = await A.getDoc();
                        const idx = pages.getIndices(doc.numPages);
                        const files = [];
                        const type = 'image/' + fmt.getValue();
                        const ext = fmt.getValue() === 'jpeg' ? 'jpg' : fmt.getValue();
                        for (let k = 0; k < idx.length; k++) {
                            const { canvas } = await A.renderPage(doc, idx[k], { dpi: +dpi.value });
                            files.push({
                                name: A.baseName(A.state.name) + '-p' + (idx[k] + 1) + '.' + ext,
                                bytes: await A.canvasToBytes(canvas, type, (+q.value || 90) / 100),
                                mime: type,
                            });
                            runner.progress((k + 1) / idx.length);
                        }
                        runner.files(files);
                    } catch (e) { runner.error(e); }
                })), runner.host);
            });
        },
    });

    reg({
        id: 'text-to-pdf', key: 'txt2pdf', cat: 'convert', icon: '📝',
        build(view) {
            const body = el('div', { class: 'tool-body' });
            view.appendChild(body);
            const card = el('div', { class: 'card' });
            const ta = el('textarea', { id: 'f-t2p', spellcheck: 'false' });
            const md = A.check('t2p_md', true);
            const font = A.select([
                { value: 'helv', label: 'Helvetica' }, { value: 'times', label: 'Times' }, { value: 'courier', label: 'Courier' },
            ], 'helv');
            const size = A.input('number', { value: '11', min: '6', max: '32' });
            card.appendChild(A.field('t2p_text', ta));
            card.appendChild(md);
            card.appendChild(el('div', { class: 'field-row' }, A.field('t2p_font', font), A.field('opt_fontsize', size)));
            body.appendChild(card);
            const runner = A.makeRunner(body);
            body.insertBefore(el('div', { class: 'btn-row' }, A.runButton('btn_run', async () => {
                try {
                    runner.clear();
                    const text = ta.value;
                    if (!text.trim()) { A.toast(t('t2p_empty'), 'err'); return; }
                    const doc = await PDFLib.PDFDocument.create();
                    const fam = {
                        helv: [PDFLib.StandardFonts.Helvetica, PDFLib.StandardFonts.HelveticaBold],
                        times: [PDFLib.StandardFonts.TimesRoman, PDFLib.StandardFonts.TimesRomanBold],
                        courier: [PDFLib.StandardFonts.Courier, PDFLib.StandardFonts.CourierBold],
                    }[font.value];
                    const reg2 = await doc.embedFont(fam[0]);
                    const bold = await doc.embedFont(fam[1]);
                    const mono = await doc.embedFont(PDFLib.StandardFonts.Courier);
                    const fs = +size.value || 11;
                    const [pw, ph] = PAGE_SIZES.a4;
                    const mg = 56;
                    let page = doc.addPage([pw, ph]);
                    let y = ph - mg;
                    const ensure = (need) => {
                        if (y - need < mg) { page = doc.addPage([pw, ph]); y = ph - mg; }
                    };
                    const writeWrapped = (str, f, s, indent, color) => {
                        const maxW = pw - mg * 2 - indent;
                        const words = A.winAnsiSafe(str).split(/\s+/);
                        let line = '';
                        const flush = () => {
                            if (!line) return;
                            ensure(s * 1.35);
                            page.drawText(line, { x: mg + indent, y: y - s, size: s, font: f, color: color || PDFLib.rgb(0.1, 0.1, 0.12) });
                            y -= s * 1.45;
                            line = '';
                        };
                        for (const w of words) {
                            const cand = line ? line + ' ' + w : w;
                            if (f.widthOfTextAtSize(cand, s) > maxW && line) flush(), line = w;
                            else line = cand;
                        }
                        flush();
                    };
                    const useMd = md.input.checked;
                    let inCode = false;
                    const stripInline = (s) => s
                        .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1')
                        .replace(/\*([^*]+)\*/g, '$1').replace(/_([^_]+)_/g, '$1')
                        .replace(/`([^`]+)`/g, '$1')
                        .replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1');
                    for (const rawLine of text.split(/\r?\n/)) {
                        if (useMd && /^\s*```/.test(rawLine)) { inCode = !inCode; y -= fs * 0.4; continue; }
                        if (inCode) { writeWrapped(rawLine || ' ', mono, fs * 0.9, 10, PDFLib.rgb(0.25, 0.25, 0.3)); continue; }
                        if (!rawLine.trim()) { y -= fs * 0.8; continue; }
                        if (useMd) {
                            const h = rawLine.match(/^(#{1,3})\s+(.*)/);
                            if (h) { y -= fs * 0.5; writeWrapped(stripInline(h[2]), bold, fs * (2.1 - h[1].length * 0.3), 0); y -= fs * 0.2; continue; }
                            if (/^\s*([-*_]){3,}\s*$/.test(rawLine)) {
                                ensure(fs);
                                page.drawLine({ start: { x: mg, y: y - fs / 2 }, end: { x: pw - mg, y: y - fs / 2 }, thickness: 0.75, color: PDFLib.rgb(0.7, 0.7, 0.7) });
                                y -= fs * 1.4; continue;
                            }
                            const li = rawLine.match(/^\s*[-*+]\s+(.*)/);
                            if (li) { writeWrapped('• ' + stripInline(li[1]), reg2, fs, 14); continue; }
                            const ol = rawLine.match(/^\s*(\d+)[.)]\s+(.*)/);
                            if (ol) { writeWrapped(ol[1] + '. ' + stripInline(ol[2]), reg2, fs, 14); continue; }
                            const q = rawLine.match(/^>\s?(.*)/);
                            if (q) { writeWrapped(stripInline(q[1]), reg2, fs, 20, PDFLib.rgb(0.4, 0.4, 0.45)); continue; }
                            writeWrapped(stripInline(rawLine), reg2, fs, 0);
                        } else {
                            writeWrapped(rawLine, reg2, fs, 0);
                        }
                    }
                    await runner.applied(await doc.save(), { name: 'text.pdf', downloadName: 'text.pdf' });
                } catch (e) { runner.error(e); }
            })), runner.host);
        },
    });

    reg({
        id: 'pdf-to-text', key: 'pdf2txt', cat: 'convert', icon: '🔤',
        build(view) {
            A.workspaceGate(view, (body) => {
                const card = el('div', { class: 'card' });
                const marks = A.check('p2t_marks', true);
                const pages = A.pagesField();
                card.appendChild(marks);
                card.appendChild(pages);
                body.appendChild(card);
                const runner = A.makeRunner(body);
                body.insertBefore(el('div', { class: 'btn-row' }, A.runButton('btn_run', async () => {
                    try {
                        runner.clear();
                        const doc = await A.getDoc();
                        const idx = pages.getIndices(doc.numPages);
                        let out = '';
                        for (let k = 0; k < idx.length; k++) {
                            const txt = await pageText(doc, idx[k]);
                            if (marks.input.checked) out += '===== ' + t('page_n', { n: idx[k] + 1 }) + ' =====\n';
                            out += txt + '\n\n';
                            runner.progress((k + 1) / idx.length);
                        }
                        if (!out.trim()) { runner.done(); A.toast(t('p2t_none'), 'err'); return; }
                        runner.text(out.trim() + '\n', A.baseName(A.state.name) + '.txt', 'text/plain');
                    } catch (e) { runner.error(e); }
                })), runner.host);
            });
        },
    });

    reg({
        id: 'pdf-to-html', key: 'pdf2html', cat: 'convert', icon: '🌐',
        build(view) {
            A.workspaceGate(view, (body) => {
                const runner = A.makeRunner(body);
                body.insertBefore(el('div', { class: 'btn-row' }, A.runButton('btn_run', async () => {
                    try {
                        runner.clear();
                        const doc = await A.getDoc();
                        let sections = '';
                        for (let i = 0; i < doc.numPages; i++) {
                            const txt = await pageText(doc, i);
                            const paras = txt.split(/\n{2,}/).map((p) => '<p>' + escapeHtml(p).replace(/\n/g, '<br>') + '</p>').join('\n');
                            sections += '<section data-page="' + (i + 1) + '">\n<h2>' + escapeHtml(t('page_n', { n: i + 1 })) + '</h2>\n' + paras + '\n</section>\n';
                            runner.progress((i + 1) / doc.numPages);
                        }
                        const title = escapeHtml(A.baseName(A.state.name));
                        const html = '<!DOCTYPE html>\n<html lang="' + PDFI18N.lang + '">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>' + title + '</title>\n<style>body{font-family:system-ui,sans-serif;max-width:72ch;margin:2rem auto;padding:0 1rem;line-height:1.6}section{border-bottom:1px solid #ccc;padding-bottom:1rem}h2{font-size:.85rem;color:#888}</style>\n</head>\n<body>\n<h1>' + title + '</h1>\n' + sections + '</body>\n</html>\n';
                        runner.text(html, A.baseName(A.state.name) + '.html', 'text/html');
                    } catch (e) { runner.error(e); }
                })), runner.host);
            });
        },
    });

    reg({
        id: 'pdf-to-csv', key: 'pdf2csv', cat: 'convert', icon: '📊',
        build(view) {
            A.workspaceGate(view, (body) => {
                body.appendChild(el('p', { class: 'hint', text: t('p2c_hint') }));
                const card = el('div', { class: 'card' });
                const pages = A.pagesField();
                card.appendChild(pages);
                body.appendChild(card);
                const runner = A.makeRunner(body);
                body.insertBefore(el('div', { class: 'btn-row' }, A.runButton('btn_run', async () => {
                    try {
                        runner.clear();
                        const doc = await A.getDoc();
                        const idx = pages.getIndices(doc.numPages);
                        const rowsOut = [];
                        for (const i of idx) {
                            const page = await doc.getPage(i + 1);
                            const tc = await page.getTextContent();
                            const rows = new Map();
                            for (const item of tc.items) {
                                if (!item.str.trim()) continue;
                                const y = Math.round(item.transform[5] / 3) * 3;
                                if (!rows.has(y)) rows.set(y, []);
                                rows.get(y).push({ x: item.transform[4], w: item.width, str: item.str });
                            }
                            const ys = [...rows.keys()].sort((a, b) => b - a);
                            for (const y of ys) {
                                const cellsIn = rows.get(y).sort((a, b) => a.x - b.x);
                                const cells = [];
                                let cur = null;
                                for (const c of cellsIn) {
                                    if (cur && c.x - (cur.x + cur.w) < 8) { cur.str += ' ' + c.str; cur.w = c.x + c.w - cur.x; }
                                    else { cur = { x: c.x, w: c.w, str: c.str }; cells.push(cur); }
                                }
                                rowsOut.push(cells.map((c) => {
                                    const v = c.str.trim();
                                    return /[",\n;]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
                                }).join(','));
                            }
                        }
                        runner.text(rowsOut.join('\n') + '\n', A.baseName(A.state.name) + '.csv', 'text/csv');
                    } catch (e) { runner.error(e); }
                })), runner.host);
            });
        },
    });

    reg({
        id: 'extract-images', key: 'extractimg', cat: 'convert', icon: '🎞',
        build(view) {
            A.workspaceGate(view, (body) => {
                const runner = A.makeRunner(body);
                body.insertBefore(el('div', { class: 'btn-row' }, A.runButton('btn_run', async () => {
                    try {
                        runner.clear();
                        const doc = await A.getDoc();
                        const seen = new Set();
                        const files = [];
                        for (let i = 0; i < doc.numPages; i++) {
                            const page = await doc.getPage(i + 1);
                            const ops = await page.getOperatorList();
                            const names = [];
                            for (let k = 0; k < ops.fnArray.length; k++) {
                                if (ops.fnArray[k] === pdfjsLib.OPS.paintImageXObject) names.push(ops.argsArray[k][0]);
                            }
                            for (const name of names) {
                                if (seen.has(name)) continue;
                                seen.add(name);
                                let img = null;
                                try {
                                    img = await new Promise((res, rej) => {
                                        try { page.objs.get(name, (o) => res(o)); } catch (e) { rej(e); }
                                        setTimeout(() => rej(new Error('img timeout')), 4000);
                                    });
                                } catch (e) { continue; }
                                if (!img || !img.width || img.width < 8 || img.height < 8) continue;
                                const c = document.createElement('canvas');
                                c.width = img.width; c.height = img.height;
                                const ctx = c.getContext('2d');
                                if (img.bitmap) {
                                    ctx.drawImage(img.bitmap, 0, 0);
                                } else if (img.data) {
                                    const out = ctx.createImageData(img.width, img.height);
                                    const src = img.data;
                                    const px = img.width * img.height;
                                    if (src.length === px * 4) out.data.set(src);
                                    else if (src.length === px * 3) {
                                        for (let p = 0, q = 0; p < px * 3; p += 3, q += 4) {
                                            out.data[q] = src[p]; out.data[q + 1] = src[p + 1]; out.data[q + 2] = src[p + 2]; out.data[q + 3] = 255;
                                        }
                                    } else if (src.length >= Math.ceil(img.width / 8) * img.height) {
                                        const rowB = Math.ceil(img.width / 8);
                                        for (let yy = 0; yy < img.height; yy++) {
                                            for (let xx = 0; xx < img.width; xx++) {
                                                const bit = (src[yy * rowB + (xx >> 3)] >> (7 - (xx & 7))) & 1;
                                                const q = (yy * img.width + xx) * 4;
                                                out.data[q] = out.data[q + 1] = out.data[q + 2] = bit ? 255 : 0;
                                                out.data[q + 3] = 255;
                                            }
                                        }
                                    } else continue;
                                    ctx.putImageData(out, 0, 0);
                                } else continue;
                                files.push({
                                    name: 'image-' + files.length + '-p' + (i + 1) + '.png',
                                    bytes: await A.canvasToBytes(c, 'image/png'),
                                    mime: 'image/png',
                                });
                            }
                            runner.progress((i + 1) / doc.numPages);
                        }
                        if (!files.length) { runner.done(); A.toast(t('xi_none'), 'err'); return; }
                        runner.files(files);
                    } catch (e) { runner.error(e); }
                })), runner.host);
            });
        },
    });

    reg({
        id: 'ocr', key: 'ocr', cat: 'convert', icon: '🔎',
        build(view) {
            A.workspaceGate(view, (body) => {
                body.appendChild(el('p', { class: 'hint', text: t('ocr_first') }));
                const card = el('div', { class: 'card' });
                const langBox = el('div', { class: 'field' }, el('label', { text: t('ocr_langs') }));
                const langChecks = {};
                const defaults = { en: 'eng', fr: 'fra', nl: 'nld' };
                for (const [code, label] of [['eng', 'English'], ['fra', 'Français'], ['nld', 'Nederlands']]) {
                    const c = A.el('input', { type: 'checkbox', checked: defaults[PDFI18N.lang] === code || null });
                    langChecks[code] = c;
                    langBox.appendChild(el('label', { class: 'check' }, c, el('span', { text: label })));
                }
                const out = A.segmented([
                    { value: 'pdf', label: t('ocr_out_pdf') }, { value: 'txt', label: t('ocr_out_txt') },
                ], 'pdf');
                const pages = A.pagesField();
                card.appendChild(langBox);
                card.appendChild(A.field('ocr_out', out));
                card.appendChild(pages);
                body.appendChild(card);
                const runner = A.makeRunner(body);
                body.insertBefore(el('div', { class: 'btn-row' }, A.runButton('btn_run', async () => {
                    let worker = null;
                    try {
                        runner.clear();
                        const langs = Object.keys(langChecks).filter((k) => langChecks[k].checked);
                        if (!langs.length) { A.toast(t('ocr_none'), 'err'); return; }
                        const doc = await A.getDoc();
                        const idx = pages.getIndices(doc.numPages);
                        runner.progress(0.02, t('working'));
                        const base = new URL('vendor/tesseract/', location.href).href;
                        worker = await Tesseract.createWorker(langs, 1, {
                            workerPath: base + 'worker.min.js',
                            corePath: base,
                            langPath: base + 'lang',
                            gzip: true,
                        });
                        let libDoc = null, font = null;
                        let txtOut = '';
                        if (out.getValue() === 'pdf') {
                            libDoc = await loadLib(A.state.bytes);
                            font = await libDoc.embedFont(PDFLib.StandardFonts.Helvetica);
                        }
                        for (let k = 0; k < idx.length; k++) {
                            const i = idx[k];
                            runner.progress(0.05 + 0.9 * (k / idx.length), t('ocr_page', { i: k + 1, n: idx.length }));
                            const page = await doc.getPage(i + 1);
                            const vp1 = page.getViewport({ scale: 1 });
                            const scale = Math.min(300 / 72, 2500 / vp1.width);
                            const { canvas } = await A.renderPage(doc, i, { scale });
                            const res = await worker.recognize(canvas);
                            if (out.getValue() === 'txt') {
                                txtOut += '===== ' + t('page_n', { n: i + 1 }) + ' =====\n' + (res.data.text || '').trim() + '\n\n';
                            } else {
                                const p = libDoc.getPage(i);
                                const ph = p.getHeight();
                                const words = res.data.words || [];
                                for (const w of words) {
                                    const txt = A.winAnsiSafe((w.text || '').trim());
                                    if (!txt) continue;
                                    const h = (w.bbox.y1 - w.bbox.y0) / scale;
                                    try {
                                        p.drawText(txt, {
                                            x: w.bbox.x0 / scale,
                                            y: ph - w.bbox.y1 / scale,
                                            size: Math.max(3, h * 0.92),
                                            font, opacity: 0,
                                        });
                                    } catch (e) { /* unencodable word */ }
                                }
                            }
                        }
                        await worker.terminate();
                        worker = null;
                        if (out.getValue() === 'txt') {
                            runner.text(txtOut.trim() + '\n', A.baseName(A.state.name) + '-ocr.txt', 'text/plain');
                        } else {
                            await runner.applied(await libDoc.save(), { downloadName: A.baseName(A.state.name) + '-ocr.pdf' });
                        }
                    } catch (e) {
                        if (worker) try { await worker.terminate(); } catch (e2) { /* ignore */ }
                        runner.error(e);
                    }
                })), runner.host);
            });
        },
    });

    reg({
        id: 'flatten', key: 'flattenpdf', cat: 'convert', icon: '🫓',
        build(view) {
            A.workspaceGate(view, (body) => {
                const card = el('div', { class: 'card' });
                const forms = A.check('fl_forms', true);
                const annots = A.check('fl_annots', false);
                card.appendChild(forms);
                card.appendChild(annots);
                body.appendChild(card);
                const runner = A.makeRunner(body);
                body.insertBefore(el('div', { class: 'btn-row' }, A.runButton('btn_apply', async () => {
                    try {
                        runner.clear();
                        let bytes = A.state.bytes;
                        if (forms.input.checked) {
                            const doc = await loadLib(bytes);
                            try {
                                const form = doc.getForm();
                                form.flatten();
                                bytes = await doc.save();
                            } catch (e) { /* no form or unflattenable — continue */ }
                        }
                        if (annots.input.checked) {
                            const doc2 = await A.pdfjsDocFor(bytes);
                            const map = new Map();
                            for (let i = 0; i < doc2.numPages; i++) {
                                const page = await doc2.getPage(i + 1);
                                const vp = page.getViewport({ scale: 150 / 72 });
                                const c = document.createElement('canvas');
                                c.width = Math.round(vp.width); c.height = Math.round(vp.height);
                                const ctx = c.getContext('2d');
                                ctx.fillStyle = '#fff';
                                ctx.fillRect(0, 0, c.width, c.height);
                                await page.render({ canvasContext: ctx, viewport: vp, annotationMode: 2 }).promise;
                                map.set(i, c);
                                runner.progress((i + 1) / doc2.numPages);
                            }
                            doc2.destroy();
                            const src = await loadLib(bytes);
                            const out = await PDFLib.PDFDocument.create();
                            for (let i = 0; i < src.getPageCount(); i++) {
                                let { width, height } = src.getPage(i).getSize();
                                // the canvas has /Rotate baked in — swap dims, drop rotation
                                const rot = ((src.getPage(i).getRotation().angle % 360) + 360) % 360;
                                if (rot === 90 || rot === 270) [width, height] = [height, width];
                                const jpg = await out.embedJpg(await A.canvasToBytes(map.get(i), 'image/jpeg', 0.88));
                                out.addPage([width, height]).drawImage(jpg, { x: 0, y: 0, width, height });
                            }
                            bytes = await out.save();
                        }
                        await runner.applied(bytes);
                    } catch (e) { runner.error(e); }
                })), runner.host);
            });
        },
    });

    /* ========================================================== SECURITY == */

    async function encryptAndSave(bytes, opts) {
        const doc = await loadLib(bytes);
        if (typeof doc.encrypt !== 'function') throw new Error('encryption not supported by this build');
        await doc.encrypt(opts);
        return doc.save({ useObjectStreams: false });
    }

    reg({
        id: 'protect', key: 'protect', cat: 'security', icon: '🔒',
        build(view) {
            A.workspaceGate(view, (body) => {
                const card = el('div', { class: 'card' });
                const user = A.input('password', { autocomplete: 'new-password' });
                const owner = A.input('password', { autocomplete: 'new-password' });
                card.appendChild(A.field('pr_user', user));
                card.appendChild(A.field('pr_owner', owner, 'pr_hint'));
                body.appendChild(card);
                const runner = A.makeRunner(body);
                body.insertBefore(el('div', { class: 'btn-row' }, A.runButton('btn_run', async () => {
                    try {
                        runner.clear();
                        if (!user.value) { A.toast(t('pr_empty'), 'err'); return; }
                        const bytes = await encryptAndSave(A.state.bytes, {
                            userPassword: user.value,
                            ownerPassword: owner.value || user.value,
                        });
                        runner.files([{ name: A.baseName(A.state.name) + '-protected.pdf', bytes, mime: 'application/pdf' }]);
                    } catch (e) { runner.error(e); }
                })), runner.host);
            });
        },
    });

    reg({
        id: 'unlock', key: 'unlock', cat: 'security', icon: '🔓',
        build(view) {
            const body = el('div', { class: 'tool-body' });
            view.appendChild(body);
            body.appendChild(el('p', { class: 'hint', text: t('ul_note') }));
            const card = el('div', { class: 'card' });
            const picker = A.filePicker({ multiple: false, labelKey: 'btn_choose' });
            const pw = A.input('password', { autocomplete: 'off' });
            card.appendChild(A.field('ul_file', picker));
            card.appendChild(A.field('ul_pw', pw));
            body.appendChild(card);
            const runner = A.makeRunner(body);
            body.insertBefore(el('div', { class: 'btn-row' }, A.runButton('btn_run', async () => {
                try {
                    runner.clear();
                    const files = picker.getFiles();
                    const bytes = files.length ? await readBytes(files[0]) : A.state.bytes;
                    if (!bytes) { A.toast(t('need_ws'), 'err'); return; }
                    const name = files.length ? files[0].name : A.state.name;
                    const doc = await PDFLib.PDFDocument.load(bytes, { password: pw.value, updateMetadata: false, throwOnInvalidObject: false });
                    const out = await doc.save();
                    runner.files([{ name: A.baseName(name) + '-unlocked.pdf', bytes: out, mime: 'application/pdf' }]);
                } catch (e) {
                    if (/password/i.test(String(e && e.message))) { runner.done(); A.toast(t('pw_wrong'), 'err'); }
                    else runner.error(e);
                }
            })), runner.host);
        },
    });

    reg({
        id: 'permissions', key: 'permissions', cat: 'security', icon: '🛂',
        build(view) {
            A.workspaceGate(view, (body) => {
                const card = el('div', { class: 'card' });
                const owner = A.input('password', { autocomplete: 'new-password' });
                const cPrint = A.check('pm_print', true);
                const cCopy = A.check('pm_copy', true);
                const cMod = A.check('pm_modify', false);
                const cAnn = A.check('pm_annot', true);
                card.appendChild(A.field('pm_owner_req', owner));
                card.appendChild(cPrint); card.appendChild(cCopy); card.appendChild(cMod); card.appendChild(cAnn);
                body.appendChild(card);
                const runner = A.makeRunner(body);
                body.insertBefore(el('div', { class: 'btn-row' }, A.runButton('btn_run', async () => {
                    try {
                        runner.clear();
                        if (!owner.value) { A.toast(t('pr_empty'), 'err'); return; }
                        const bytes = await encryptAndSave(A.state.bytes, {
                            ownerPassword: owner.value,
                            permissions: {
                                printing: cPrint.input.checked ? 'highResolution' : false,
                                copying: cCopy.input.checked,
                                modifying: cMod.input.checked,
                                annotating: cAnn.input.checked,
                                fillingForms: cAnn.input.checked,
                                contentAccessibility: true,
                                documentAssembly: cMod.input.checked,
                            },
                        });
                        runner.files([{ name: A.baseName(A.state.name) + '-permissions.pdf', bytes, mime: 'application/pdf' }]);
                    } catch (e) { runner.error(e); }
                })), runner.host);
            });
        },
    });

    reg({
        id: 'watermark', key: 'watermark', cat: 'security', icon: '💧',
        build(view) {
            A.workspaceGate(view, (body) => {
                const card = el('div', { class: 'card' });
                const textInp = A.input('text', { value: 'CONFIDENTIAL' });
                const imgInp = el('input', { type: 'file', accept: 'image/*' });
                const textField = A.field('opt_text', textInp);
                const imgField = A.field('wm_img', imgInp);
                imgField.style.display = 'none';
                const type = A.segmented([
                    { value: 'text', label: t('wm_type_text') }, { value: 'img', label: t('wm_type_img') },
                ], 'text', (v) => {
                    textField.style.display = v === 'text' ? '' : 'none';
                    imgField.style.display = v === 'img' ? '' : 'none';
                });
                const size = A.input('number', { value: '48', min: '8', max: '200' });
                const color = el('input', { type: 'color', value: '#d32f2f' });
                const opacity = A.input('range', { min: '5', max: '100', value: '25' });
                const angle = A.input('number', { value: '-45', min: '-180', max: '180' });
                const tile = A.check('wm_tile', false);
                const pages = A.pagesField();
                card.appendChild(A.field(null, type));
                card.appendChild(textField);
                card.appendChild(imgField);
                card.appendChild(el('div', { class: 'field-row' },
                    A.field('opt_fontsize', size), A.field('opt_color', color),
                    A.field('opt_opacity', opacity), A.field('opt_angle', angle)));
                card.appendChild(tile);
                card.appendChild(pages);
                body.appendChild(card);
                const runner = A.makeRunner(body);
                body.insertBefore(el('div', { class: 'btn-row' }, A.runButton('btn_apply', async () => {
                    try {
                        runner.clear();
                        const doc = await loadLib(A.state.bytes);
                        const idx = pages.getIndices(doc.getPageCount());
                        const op = (+opacity.value || 25) / 100;
                        const rad = (+angle.value || 0) * Math.PI / 180;
                        const rot = PDFLib.degrees(+angle.value || 0);
                        if (type.getValue() === 'text') {
                            const font = await doc.embedFont(PDFLib.StandardFonts.HelveticaBold);
                            const str = A.winAnsiSafe(textInp.value || 'CONFIDENTIAL');
                            const fs = +size.value || 48;
                            const tw = font.widthOfTextAtSize(str, fs);
                            const fh = fs * 0.7;
                            for (const i of idx) {
                                const p = doc.getPage(i);
                                const W = p.getWidth(), H = p.getHeight();
                                const draw = (cx, cy) => p.drawText(str, {
                                    x: cx - (tw / 2) * Math.cos(rad) + (fh / 2) * Math.sin(rad),
                                    y: cy - (tw / 2) * Math.sin(rad) - (fh / 2) * Math.cos(rad),
                                    size: fs, font, color: A.hexToRgb(color.value), opacity: op, rotate: rot,
                                });
                                if (tile.input.checked) {
                                    const step = tw + 90;
                                    for (let yy = -H * 0.2; yy < H * 1.2; yy += step * 0.75) {
                                        for (let xx = -W * 0.2; xx < W * 1.2; xx += step) draw(xx, yy);
                                    }
                                } else draw(W / 2, H / 2);
                            }
                        } else {
                            const f = imgInp.files[0];
                            if (!f) { A.toast(t('wm_img'), 'err'); return; }
                            const img = await embedImageAuto(doc, await readBytes(f));
                            for (const i of idx) {
                                const p = doc.getPage(i);
                                const W = p.getWidth(), H = p.getHeight();
                                const w = W * 0.5, h = w * img.height / img.width;
                                const draw = (x, y) => p.drawImage(img, { x, y, width: w, height: h, opacity: op, rotate: rot });
                                if (tile.input.checked) {
                                    for (let yy = -H * 0.2; yy < H * 1.2; yy += h + 120) {
                                        for (let xx = -W * 0.2; xx < W * 1.2; xx += w + 120) draw(xx, yy);
                                    }
                                } else draw((W - w) / 2, (H - h) / 2);
                            }
                        }
                        await runner.applied(await doc.save());
                    } catch (e) { runner.error(e); }
                })), runner.host);
            });
        },
    });

    reg({
        id: 'sign', key: 'sign', cat: 'security', icon: '✒️',
        build(view) {
            A.workspaceGate(view, (body) => {
                body.appendChild(el('p', { class: 'hint', text: t('sg_place_hint') }));
                /* 1 — create the signature */
                const makeCard = el('div', { class: 'card' });
                const pad = el('canvas', { class: 'sigpad', width: '480', height: '160' });
                const padCtx = pad.getContext('2d');
                padCtx.lineWidth = 2.5; padCtx.lineCap = 'round'; padCtx.strokeStyle = '#101040';
                let drawing = false, hasInk = false;
                const pos = (e) => {
                    const r = pad.getBoundingClientRect();
                    return { x: (e.clientX - r.left) * pad.width / r.width, y: (e.clientY - r.top) * pad.height / r.height };
                };
                pad.addEventListener('pointerdown', (e) => { e.preventDefault(); capture(pad, e); drawing = true; const p = pos(e); padCtx.beginPath(); padCtx.moveTo(p.x, p.y); });
                pad.addEventListener('pointermove', (e) => { if (!drawing) return; const p = pos(e); padCtx.lineTo(p.x, p.y); padCtx.stroke(); hasInk = true; });
                pad.addEventListener('pointerup', () => { drawing = false; });
                const typeInp = A.input('text', { placeholder: t('sg_type_ph') });
                const upInp = el('input', { type: 'file', accept: 'image/*' });
                const drawWrap = el('div', {}, pad, el('div', { class: 'btn-row', style: 'margin-top:.5rem' },
                    el('button', { type: 'button', class: 'btn', onclick: () => { padCtx.clearRect(0, 0, pad.width, pad.height); hasInk = false; } }, t('btn_clear'))));
                const typeWrap = A.field(null, typeInp);
                const upWrap = A.field(null, upInp);
                typeWrap.style.display = 'none'; upWrap.style.display = 'none';
                const tabs = A.segmented([
                    { value: 'draw', label: t('sg_draw') }, { value: 'type', label: t('sg_type') }, { value: 'upload', label: t('sg_upload') },
                ], 'draw', (v) => {
                    drawWrap.style.display = v === 'draw' ? '' : 'none';
                    typeWrap.style.display = v === 'type' ? '' : 'none';
                    upWrap.style.display = v === 'upload' ? '' : 'none';
                });
                makeCard.appendChild(A.field(null, tabs));
                makeCard.appendChild(drawWrap);
                makeCard.appendChild(typeWrap);
                makeCard.appendChild(upWrap);
                const addDate = A.check('sg_date', false);
                makeCard.appendChild(addDate);
                const useBtn = el('button', { type: 'button', class: 'btn' }, t('sg_add'));
                makeCard.appendChild(el('div', { class: 'btn-row', style: 'margin-top:.6rem' }, useBtn));
                body.appendChild(makeCard);
                /* 2 — place it */
                const stageCard = el('div', { class: 'card' });
                body.appendChild(stageCard);
                let placed = null;
                const stage = pageStage(stageCard, {
                    onDraw() { if (placed) { stage.wrap.appendChild(placed.item); } },
                });
                async function currentSigDataUrl() {
                    const mode = tabs.getValue();
                    if (mode === 'draw') {
                        if (!hasInk) return null;
                        const trimmed = document.createElement('canvas');
                        trimmed.width = pad.width; trimmed.height = pad.height;
                        trimmed.getContext('2d').drawImage(pad, 0, 0);
                        return { url: trimmed.toDataURL('image/png'), ratio: pad.height / pad.width };
                    }
                    if (mode === 'type') {
                        const txt = typeInp.value.trim();
                        if (!txt) return null;
                        const c = document.createElement('canvas');
                        const ctx0 = c.getContext('2d');
                        ctx0.font = 'italic 64px "Segoe Script","Brush Script MT","Snell Roundhand",cursive';
                        c.width = Math.max(200, Math.ceil(ctx0.measureText(txt).width) + 40);
                        c.height = 110;
                        const ctx = c.getContext('2d');
                        ctx.font = 'italic 64px "Segoe Script","Brush Script MT","Snell Roundhand",cursive';
                        ctx.fillStyle = '#101040';
                        ctx.textBaseline = 'middle';
                        ctx.fillText(txt, 20, 58);
                        return { url: c.toDataURL('image/png'), ratio: c.height / c.width };
                    }
                    const f = upInp.files[0];
                    if (!f) return null;
                    const bytes = await readBytes(f);
                    const img = await A.decodeImage(bytes, f.type);
                    const c = document.createElement('canvas');
                    c.width = img.width; c.height = img.height;
                    c.getContext('2d').drawImage(img, 0, 0);
                    return { url: c.toDataURL('image/png'), ratio: img.height / img.width };
                }
                useBtn.addEventListener('click', async () => {
                    const sig = await currentSigDataUrl();
                    if (!sig) { A.toast(t('sg_none'), 'err'); return; }
                    if (placed) placed.remove();
                    placed = makePlaceItem(stage.wrap, sig.url, sig.ratio);
                    placed.ratio = sig.ratio;
                    placed.url = sig.url;
                });
                const runner = A.makeRunner(body);
                body.insertBefore(el('div', { class: 'btn-row' }, A.runButton('btn_apply', async () => {
                    try {
                        runner.clear();
                        if (!placed) { A.toast(t('sg_none'), 'err'); return; }
                        const fr = placed.frac();
                        const doc = await loadLib(A.state.bytes);
                        const p = doc.getPage(stage.pageIndex);
                        const pngBytes = Uint8Array.from(atob(placed.url.split(',')[1]), (c) => c.charCodeAt(0));
                        const img = await doc.embedPng(pngBytes);
                        const W = p.getWidth(), H = p.getHeight();
                        const w = fr.fw * W;
                        const h = w * placed.ratio;
                        const y = H - (fr.fy * H) - h;
                        p.drawImage(img, { x: fr.fx * W, y, width: w, height: h });
                        if (addDate.input.checked) {
                            const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
                            const ds = new Date().toLocaleDateString(PDFI18N.lang);
                            const fs = Math.max(7, Math.min(12, h * 0.22));
                            p.drawText(ds, { x: fr.fx * W, y: Math.max(4, y - fs - 2), size: fs, font, color: PDFLib.rgb(0.2, 0.2, 0.25) });
                        }
                        placed.remove();
                        placed = null;   // the signature is baked in now — drop the overlay
                        await runner.applied(await doc.save());
                    } catch (e) { runner.error(e); }
                })), runner.host);
            });
        },
    });

    reg({
        id: 'redact', key: 'redact', cat: 'security', icon: '⬛',
        build(view) {
            A.workspaceGate(view, (body) => {
                body.appendChild(el('p', { class: 'hint', text: t('rd_note') }));
                const boxes = new Map(); // pageIndex → [{fx,fy,fw,fh}]
                const card = el('div', { class: 'card' });
                const term = A.input('text', {});
                const cs = A.check('rd_case', false);
                const searchField = A.field('rd_term', term);
                const findBtn = el('button', { type: 'button', class: 'btn' }, t('btn_run'));
                const searchWrap = el('div', {}, searchField, cs, el('div', { class: 'btn-row' }, findBtn));
                searchWrap.style.display = 'none';
                const drawHint = el('p', { class: 'hint', text: t('rd_draw_hint') });
                const mode = A.segmented([
                    { value: 'draw', label: t('rd_mode_draw') }, { value: 'search', label: t('rd_mode_search') },
                ], 'draw', (v) => {
                    searchWrap.style.display = v === 'search' ? '' : 'none';
                    drawHint.style.display = v === 'draw' ? '' : 'none';
                });
                card.appendChild(A.field(null, mode));
                card.appendChild(drawHint);
                card.appendChild(searchWrap);
                body.appendChild(card);
                const stageCard = el('div', { class: 'card' });
                body.appendChild(stageCard);
                const status = el('p', { class: 'hint', text: t('rd_none') });
                body.appendChild(status);

                function refreshStatus() {
                    let n = 0, p = 0;
                    for (const [, arr] of boxes) if (arr.length) { n += arr.length; p++; }
                    status.textContent = n ? t('rd_boxes', { n, p }) : t('rd_none');
                }
                function drawOverlays(pi, wrap) {
                    wrap.querySelectorAll('.redact-box').forEach((b) => b.remove());
                    const canvas = wrap.querySelector('canvas.pw-page');
                    if (!canvas) return;
                    const arr = boxes.get(pi) || [];
                    arr.forEach((bx, i) => {
                        const div = el('div', { class: 'redact-box' });
                        div.style.left = bx.fx * 100 + '%';
                        div.style.top = bx.fy * 100 + '%';
                        div.style.width = bx.fw * 100 + '%';
                        div.style.height = bx.fh * 100 + '%';
                        const x = el('button', { type: 'button', class: 'rb-x', 'aria-label': t('close'), onclick: () => { arr.splice(i, 1); drawOverlays(pi, wrap); refreshStatus(); } }, '✕');
                        div.appendChild(x);
                        wrap.appendChild(div);
                    });
                }
                const stage = pageStage(stageCard, {
                    onDraw(pi, canvas, wrap) {
                        canvas.style.touchAction = 'none';
                        let start = null, band = null;
                        canvas.addEventListener('pointerdown', (e) => {
                            if (mode.getValue() !== 'draw') return;
                            e.preventDefault();
                            capture(canvas, e);
                            const r = canvas.getBoundingClientRect();
                            start = { x: e.clientX - r.left, y: e.clientY - r.top, r };
                            band = el('div', { class: 'redact-box' });
                            wrap.appendChild(band);
                        });
                        canvas.addEventListener('pointermove', (e) => {
                            if (!start || !band) return;
                            const x2 = Math.max(0, Math.min(start.r.width, e.clientX - start.r.left));
                            const y2 = Math.max(0, Math.min(start.r.height, e.clientY - start.r.top));
                            band.style.left = Math.min(start.x, x2) / start.r.width * 100 + '%';
                            band.style.top = Math.min(start.y, y2) / start.r.height * 100 + '%';
                            band.style.width = Math.abs(x2 - start.x) / start.r.width * 100 + '%';
                            band.style.height = Math.abs(y2 - start.y) / start.r.height * 100 + '%';
                        });
                        canvas.addEventListener('pointerup', (e) => {
                            if (!start || !band) return;
                            const r = start.r;
                            const x2 = Math.max(0, Math.min(r.width, e.clientX - r.left));
                            const y2 = Math.max(0, Math.min(r.height, e.clientY - r.top));
                            const fw = Math.abs(x2 - start.x) / r.width, fh = Math.abs(y2 - start.y) / r.height;
                            band.remove(); band = null;
                            if (fw > 0.004 && fh > 0.004) {
                                if (!boxes.has(pi)) boxes.set(pi, []);
                                boxes.get(pi).push({ fx: Math.min(start.x, x2) / r.width, fy: Math.min(start.y, y2) / r.height, fw, fh });
                                drawOverlays(pi, wrap);
                                refreshStatus();
                            }
                            start = null;
                        });
                        drawOverlays(pi, wrap);
                    },
                });
                findBtn.addEventListener('click', async () => {
                    const needle = cs.input.checked ? term.value : term.value.toLowerCase();
                    if (!needle.trim()) return;
                    const doc = await A.getDoc();
                    let hits = 0;
                    for (let i = 0; i < doc.numPages; i++) {
                        const page = await doc.getPage(i + 1);
                        const vp = page.getViewport({ scale: 1 });
                        const tc = await page.getTextContent();
                        for (const item of tc.items) {
                            const hay = cs.input.checked ? item.str : item.str.toLowerCase();
                            if (!hay.includes(needle)) continue;
                            hits++;
                            const x = item.transform[4], y = item.transform[5];
                            const h = Math.hypot(item.transform[2], item.transform[3]) || 10;
                            if (!boxes.has(i)) boxes.set(i, []);
                            boxes.get(i).push({
                                fx: Math.max(0, (x - 1) / vp.width),
                                fy: Math.max(0, (vp.height - y - h - 1) / vp.height),
                                fw: Math.min(1, (item.width + 2) / vp.width),
                                fh: Math.min(1, (h + 4) / vp.height),
                            });
                        }
                    }
                    A.toast(hits ? t('rd_hits', { n: hits }) : t('rd_nohits'), hits ? 'ok' : 'err');
                    refreshStatus();
                    stage.redraw();
                });
                const runner = A.makeRunner(body);
                body.insertBefore(el('div', { class: 'btn-row' }, A.runButton('btn_apply', async () => {
                    try {
                        runner.clear();
                        const idx = [...boxes.keys()].filter((i) => boxes.get(i).length);
                        if (!idx.length) { A.toast(t('rd_none'), 'err'); return; }
                        const bytes = await rasterTransform(idx, 200, 0.9, (canvas, i) => {
                            const ctx = canvas.getContext('2d');
                            ctx.fillStyle = '#000';
                            for (const bx of boxes.get(i)) {
                                ctx.fillRect(bx.fx * canvas.width, bx.fy * canvas.height, bx.fw * canvas.width, bx.fh * canvas.height);
                            }
                        }, (f) => runner.progress(f));
                        boxes.clear();
                        refreshStatus();
                        await runner.applied(bytes);
                        stage.redraw();
                    } catch (e) { runner.error(e); }
                })), runner.host);
            });
        },
    });

    function stripJavaScript(doc) {
        const N = PDFLib.PDFName.of.bind(PDFLib.PDFName);
        const cat = doc.catalog;
        const names = dictGet(cat, 'Names');
        if (names && names.delete) names.delete(N('JavaScript'));
        const oa = dictGet(cat, 'OpenAction');
        if (oa && oa.lookup && dictGet(oa, 'S') === N('JavaScript')) cat.delete(N('OpenAction'));
        cat.delete(N('AA'));
        for (const p of doc.getPages()) p.node.delete(N('AA'));
    }
    function filterAnnots(doc, keepFn) {
        const N = PDFLib.PDFName.of.bind(PDFLib.PDFName);
        for (const p of doc.getPages()) {
            let arr;
            try { arr = p.node.lookup(N('Annots'), PDFLib.PDFArray); } catch (e) { arr = null; }
            if (!arr) continue;
            const kept = [];
            for (let i = 0; i < arr.size(); i++) {
                let a;
                try { a = arr.lookup(i, PDFLib.PDFDict); } catch (e) { a = null; }
                if (a && keepFn(a)) kept.push(arr.get(i));
            }
            if (kept.length === arr.size()) continue;
            if (!kept.length) p.node.delete(N('Annots'));
            else {
                const na = doc.context.obj(kept);
                p.node.set(N('Annots'), na);
            }
        }
    }

    reg({
        id: 'sanitize', key: 'sanitize', cat: 'security', icon: '🧼',
        build(view) {
            A.workspaceGate(view, (body) => {
                const card = el('div', { class: 'card' });
                const cJs = A.check('sz_js', true);
                const cAtt = A.check('sz_att', true);
                const cMeta = A.check('sz_meta', true);
                const cLinks = A.check('sz_links', false);
                const cAnn = A.check('sz_annots', false);
                for (const c of [cJs, cAtt, cMeta, cLinks, cAnn]) card.appendChild(c);
                body.appendChild(card);
                const runner = A.makeRunner(body);
                body.insertBefore(el('div', { class: 'btn-row' }, A.runButton('btn_apply', async () => {
                    try {
                        runner.clear();
                        const doc = await loadLib(A.state.bytes);
                        const N = PDFLib.PDFName.of.bind(PDFLib.PDFName);
                        if (cJs.input.checked) stripJavaScript(doc);
                        if (cAtt.input.checked) {
                            const names = dictGet(doc.catalog, 'Names');
                            if (names && names.delete) names.delete(N('EmbeddedFiles'));
                            filterAnnots(doc, (a) => dictGet(a, 'Subtype') !== N('FileAttachment'));
                        }
                        if (cMeta.input.checked) {
                            doc.catalog.delete(N('Metadata'));
                            doc.context.trailerInfo.Info = undefined;
                        }
                        if (cAnn.input.checked) {
                            filterAnnots(doc, () => false);
                        } else if (cLinks.input.checked) {
                            filterAnnots(doc, (a) => {
                                if (dictGet(a, 'Subtype') !== N('Link')) return true;
                                const act = dictGet(a, 'A');
                                return !(act && dictGet(act, 'S') === N('URI'));
                            });
                        }
                        await runner.applied(await doc.save());
                    } catch (e) { runner.error(e); }
                })), runner.host);
            });
        },
    });

    /* ============================================================== EDIT == */

    reg({
        id: 'metadata', key: 'metadata', cat: 'edit', icon: '🏷',
        build(view) {
            A.workspaceGate(view, async (body) => {
                const card = el('div', { class: 'card' });
                const inputs = {};
                for (const k of ['title', 'author', 'subject', 'keywords', 'creator', 'producer']) {
                    inputs[k] = A.input('text', {});
                    card.appendChild(A.field('md_' + k, inputs[k]));
                }
                const wipe = A.check('md_wipe', false);
                card.appendChild(wipe);
                wipe.input.addEventListener('change', () => {
                    for (const k of Object.keys(inputs)) inputs[k].disabled = wipe.input.checked;
                });
                body.appendChild(card);
                try {
                    const doc = await loadLib(A.state.bytes);
                    inputs.title.value = doc.getTitle() || '';
                    inputs.author.value = doc.getAuthor() || '';
                    inputs.subject.value = doc.getSubject() || '';
                    inputs.keywords.value = doc.getKeywords() || '';
                    inputs.creator.value = doc.getCreator() || '';
                    inputs.producer.value = doc.getProducer() || '';
                } catch (e) { /* metadata unreadable */ }
                const runner = A.makeRunner(body);
                body.insertBefore(el('div', { class: 'btn-row' }, A.runButton('btn_apply', async () => {
                    try {
                        runner.clear();
                        const doc = await loadLib(A.state.bytes);
                        if (wipe.input.checked) {
                            doc.catalog.delete(PDFLib.PDFName.of('Metadata'));
                            doc.context.trailerInfo.Info = undefined;
                        } else {
                            doc.setTitle(inputs.title.value);
                            doc.setAuthor(inputs.author.value);
                            doc.setSubject(inputs.subject.value);
                            doc.setKeywords(inputs.keywords.value.split(',').map((s) => s.trim()).filter(Boolean));
                            doc.setCreator(inputs.creator.value);
                            doc.setProducer(inputs.producer.value);
                            doc.setModificationDate(new Date());
                        }
                        await runner.applied(await doc.save());
                    } catch (e) { runner.error(e); }
                })), runner.host);
            });
        },
    });

    reg({
        id: 'add-image', key: 'addimage', cat: 'edit', icon: '🧷',
        build(view) {
            A.workspaceGate(view, (body) => {
                body.appendChild(el('p', { class: 'hint', text: t('sg_place_hint') }));
                const card = el('div', { class: 'card' });
                const imgInp = el('input', { type: 'file', accept: 'image/*' });
                card.appendChild(A.field('ai_img', imgInp));
                body.appendChild(card);
                const stageCard = el('div', { class: 'card' });
                body.appendChild(stageCard);
                let placed = null;
                const stage = pageStage(stageCard, {
                    onDraw() { if (placed) stage.wrap.appendChild(placed.item); },
                });
                imgInp.addEventListener('change', async () => {
                    const f = imgInp.files[0];
                    if (!f) return;
                    const bytes = await readBytes(f);
                    const img = await A.decodeImage(bytes, f.type);
                    const c = document.createElement('canvas');
                    c.width = img.width; c.height = img.height;
                    c.getContext('2d').drawImage(img, 0, 0);
                    if (placed) placed.remove();
                    placed = makePlaceItem(stage.wrap, c.toDataURL('image/png'), img.height / img.width);
                    placed.ratio = img.height / img.width;
                    placed.bytes = bytes;
                });
                const runner = A.makeRunner(body);
                body.insertBefore(el('div', { class: 'btn-row' }, A.runButton('btn_apply', async () => {
                    try {
                        runner.clear();
                        if (!placed) { A.toast(t('ai_img'), 'err'); return; }
                        const fr = placed.frac();
                        const doc = await loadLib(A.state.bytes);
                        const img = await embedImageAuto(doc, placed.bytes);
                        const p = doc.getPage(stage.pageIndex);
                        const W = p.getWidth(), H = p.getHeight();
                        const w = fr.fw * W, h = w * placed.ratio;
                        p.drawImage(img, { x: fr.fx * W, y: H - fr.fy * H - h, width: w, height: h });
                        placed.remove();
                        placed = null;   // baked in — drop the overlay
                        await runner.applied(await doc.save());
                    } catch (e) { runner.error(e); }
                })), runner.host);
            });
        },
    });

    reg({
        id: 'remove-annotations', key: 'removeannots', cat: 'edit', icon: '🧽',
        build(view) {
            A.workspaceGate(view, (body) => {
                const card = el('div', { class: 'card' });
                const keepLinks = A.check('ra_keep_links', false);
                card.appendChild(keepLinks);
                body.appendChild(card);
                const runner = A.makeRunner(body);
                body.insertBefore(el('div', { class: 'btn-row' }, A.runButton('btn_apply', async () => {
                    try {
                        runner.clear();
                        const doc = await loadLib(A.state.bytes);
                        const N = PDFLib.PDFName.of.bind(PDFLib.PDFName);
                        filterAnnots(doc, (a) => keepLinks.input.checked && dictGet(a, 'Subtype') === N('Link'));
                        await runner.applied(await doc.save());
                    } catch (e) { runner.error(e); }
                })), runner.host);
            });
        },
    });

    reg({
        id: 'fill-form', key: 'fillform', cat: 'edit', icon: '🖊',
        build(view) {
            A.workspaceGate(view, async (body) => {
                const card = el('div', { class: 'card' });
                body.appendChild(card);
                let fields = [];
                try {
                    const doc = await loadLib(A.state.bytes);
                    fields = doc.getForm().getFields();
                } catch (e) { fields = []; }
                if (!fields.length) {
                    card.appendChild(el('p', { class: 'hint', text: t('ff_none') }));
                    return;
                }
                card.appendChild(el('p', { class: 'hint', text: t('ff_fields', { n: fields.length }) }));
                const controls = [];
                for (const f of fields) {
                    const name = f.getName();
                    let kind = null;
                    if (f instanceof PDFLib.PDFTextField) kind = 'text';
                    else if (f instanceof PDFLib.PDFCheckBox) kind = 'check';
                    else if (f instanceof PDFLib.PDFRadioGroup) kind = 'radio';
                    else if (f instanceof PDFLib.PDFDropdown) kind = 'dropdown';
                    else if (f instanceof PDFLib.PDFOptionList) kind = 'optionlist';
                    let ctl = null;
                    try {
                        if (kind === 'text') {
                            ctl = { kind, el: A.input('text', { value: f.getText() || '' }) };
                        } else if (kind === 'check') {
                            ctl = { kind, el: A.el('input', { type: 'checkbox', checked: f.isChecked() || null }) };
                        } else if (kind === 'radio' || kind === 'dropdown' || kind === 'optionlist') {
                            const opts = f.getOptions().map((o) => ({ value: o, label: o }));
                            opts.unshift({ value: '', label: '—' });
                            const sel0 = (f.getSelected && f.getSelected()) || [];
                            ctl = { kind, el: A.select(opts, sel0[0] || '') };
                        }
                    } catch (e) { ctl = null; }
                    if (!ctl) continue;
                    controls.push({ name, ctl });
                    if (ctl.kind === 'check') {
                        card.appendChild(el('div', { class: 'field' },
                            el('label', { class: 'check' }, ctl.el, el('span', { text: name }))));
                    } else {
                        card.appendChild(el('div', { class: 'field' }, el('label', { text: name }), ctl.el));
                    }
                }
                const flat = A.check('ff_flatten', false);
                card.appendChild(flat);
                const runner = A.makeRunner(body);
                body.insertBefore(el('div', { class: 'btn-row' }, A.runButton('btn_apply', async () => {
                    try {
                        runner.clear();
                        const doc = await loadLib(A.state.bytes);
                        const form = doc.getForm();
                        for (const c of controls) {
                            try {
                                if (c.ctl.kind === 'text') form.getTextField(c.name).setText(c.ctl.el.value);
                                else if (c.ctl.kind === 'check') {
                                    const cb = form.getCheckBox(c.name);
                                    if (c.ctl.el.checked) cb.check(); else cb.uncheck();
                                } else if (c.ctl.el.value) {
                                    if (c.ctl.kind === 'radio') form.getRadioGroup(c.name).select(c.ctl.el.value);
                                    else if (c.ctl.kind === 'dropdown') form.getDropdown(c.name).select(c.ctl.el.value);
                                    else if (c.ctl.kind === 'optionlist') form.getOptionList(c.name).select(c.ctl.el.value);
                                }
                            } catch (e) { /* field may be read-only */ }
                        }
                        if (flat.input.checked) form.flatten();
                        await runner.applied(await doc.save());
                    } catch (e) { runner.error(e); }
                })), runner.host);
            });
        },
    });

    reg({
        id: 'compress', key: 'compress', cat: 'edit', icon: '🗜',
        build(view) {
            A.workspaceGate(view, (body) => {
                const card = el('div', { class: 'card' });
                const mode = A.segmented([
                    { value: 'img', label: t('cp_mode_img') }, { value: 'raster', label: t('cp_mode_raster') },
                ], 'img');
                const q = A.input('range', { min: '20', max: '95', value: '60' });
                const dpi = A.select([{ value: '100', label: '100' }, { value: '150', label: '150' }, { value: '200', label: '200' }], '150');
                const gray = A.check('cp_gray', false);
                const target = A.input('number', { min: '0.1', step: '0.1', placeholder: '—' });
                card.appendChild(A.field(null, mode));
                card.appendChild(el('div', { class: 'field-row' }, A.field('opt_quality', q), A.field('opt_dpi', dpi), A.field('cp_target', target, 'cp_target_hint')));
                card.appendChild(gray);
                body.appendChild(card);
                const runner = A.makeRunner(body);
                body.insertBefore(el('div', { class: 'btn-row' }, A.runButton('btn_run', async () => {
                    try {
                        runner.clear();
                        const before = A.state.bytes.length;
                        const quality = (+q.value || 60) / 100;
                        const targetBytes = (+target.value || 0) * 1024 * 1024;
                        let bytes;
                        if (mode.getValue() === 'raster') {
                            const doc = await A.getDoc();
                            const idx = Array.from({ length: doc.numPages }, (_, i) => i);
                            const grayFn = (canvas) => {
                                if (gray.input.checked) pixelLoop(canvas, (d) => {
                                    for (let p = 0; p < d.length; p += 4) {
                                        const g = d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114;
                                        d[p] = d[p + 1] = d[p + 2] = g;
                                    }
                                });
                            };
                            // render once, then re-encode at lower qualities until the target fits
                            const map = new Map();
                            let k = 0;
                            for (const i of idx) {
                                const { canvas } = await A.renderPage(doc, i, { dpi: +dpi.value, willRead: true });
                                grayFn(canvas);
                                map.set(i, canvas);
                                runner.progress(++k / idx.length * 0.6);
                            }
                            const ladder = targetBytes
                                ? [quality, ...[0.5, 0.38, 0.28, 0.2, 0.14].filter((x) => x < quality)]
                                : [quality];
                            bytes = null;
                            for (let li = 0; li < ladder.length; li++) {
                                runner.progress(0.6 + 0.4 * ((li + 1) / ladder.length));
                                const trial = await A.replacePagesWithImages(map, ladder[li]);
                                if (!bytes || trial.length < bytes.length) bytes = trial;
                                if (!targetBytes || trial.length <= targetBytes) break;
                            }
                            if (targetBytes && bytes.length > targetBytes) A.toast(t('cp_target_miss'), 'err');
                        } else {
                            const doc = await loadLib(A.state.bytes);
                            const N = PDFLib.PDFName.of.bind(PDFLib.PDFName);
                            const objs = doc.context.enumerateIndirectObjects();
                            const targets = [];
                            for (const [ref, obj] of objs) {
                                if (!(obj instanceof PDFLib.PDFRawStream)) continue;
                                if (dictGet(obj.dict, 'Subtype') !== N('Image')) continue;
                                let filters = dictGet(obj.dict, 'Filter');
                                const list = [];
                                if (filters instanceof PDFLib.PDFArray) for (let i = 0; i < filters.size(); i++) list.push(filters.get(i));
                                else if (filters) list.push(filters);
                                if (list.some((f) => f === N('DCTDecode'))) targets.push({ ref, obj });
                            }
                            let done = 0;
                            for (const tgt of targets) {
                                try {
                                    const raw = tgt.obj.getContents ? tgt.obj.getContents() : tgt.obj.contents;
                                    const img = await A.decodeImage(raw, 'image/jpeg');
                                    let w = img.width, h = img.height;
                                    const maxDim = 1800;
                                    if (Math.max(w, h) > maxDim) { const s = maxDim / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
                                    const c = document.createElement('canvas');
                                    c.width = w; c.height = h;
                                    const ctx = c.getContext('2d');
                                    ctx.drawImage(img, 0, 0, w, h);
                                    if (img.close) img.close();
                                    if (gray.input.checked) pixelLoop(c, (d) => {
                                        for (let p = 0; p < d.length; p += 4) {
                                            const g = d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114;
                                            d[p] = d[p + 1] = d[p + 2] = g;
                                        }
                                    });
                                    const jpg = await A.canvasToBytes(c, 'image/jpeg', quality);
                                    if (jpg.length >= raw.length) continue;
                                    const dict = doc.context.obj({
                                        Type: 'XObject', Subtype: 'Image',
                                        Width: w, Height: h,
                                        ColorSpace: 'DeviceRGB', BitsPerComponent: 8,
                                        Filter: 'DCTDecode', Length: jpg.length,
                                    });
                                    const keep = ['SMask', 'Mask', 'Interpolate', 'Intent'];
                                    for (const k of keep) {
                                        const v = tgt.obj.dict.get(N(k));
                                        if (v) dict.set(N(k), v);
                                    }
                                    doc.context.assign(tgt.ref, PDFLib.PDFRawStream.of(dict, jpg));
                                } catch (e) { /* skip undecodable image */ }
                                runner.progress(++done / targets.length);
                            }
                            bytes = await doc.save({ useObjectStreams: true });
                            if (targetBytes && bytes.length > targetBytes) A.toast(t('cp_target_miss'), 'err');
                        }
                        const after = bytes.length;
                        if (after < before) {
                            const pct = Math.round((1 - after / before) * 100) + '%';
                            A.toast(t('cp_res', { a: A.fmtSize(before), b: A.fmtSize(after), p: pct }), 'ok');
                            await runner.applied(bytes, { downloadName: A.baseName(A.state.name) + '-compressed.pdf' });
                        } else {
                            runner.done();
                            runner.host.textContent = '';
                            runner.host.appendChild(el('div', { class: 'card result' },
                                el('p', { class: 'res-title', text: t('cp_nores', { a: A.fmtSize(before), b: A.fmtSize(after) }) })));
                        }
                    } catch (e) { runner.error(e); }
                })), runner.host);
            });
        },
    });

    reg({
        id: 'adjust-colors', key: 'colors', cat: 'edit', icon: '🎨',
        build(view) {
            A.workspaceGate(view, (body) => {
                body.appendChild(el('p', { class: 'hint', text: t('ac_note') }));
                const card = el('div', { class: 'card' });
                const mode = A.segmented([
                    { value: 'gray', label: t('ac_mode_gray') }, { value: 'invert', label: t('ac_mode_invert') }, { value: 'sepia', label: t('ac_mode_sepia') },
                ], 'gray');
                const pages = A.pagesField();
                card.appendChild(A.field(null, mode));
                card.appendChild(pages);
                body.appendChild(card);
                const runner = A.makeRunner(body);
                body.insertBefore(el('div', { class: 'btn-row' }, A.runButton('btn_apply', async () => {
                    try {
                        runner.clear();
                        const doc = await A.getDoc();
                        const idx = pages.getIndices(doc.numPages);
                        const m = mode.getValue();
                        const bytes = await rasterTransform(idx, 150, 0.9, (canvas) => {
                            pixelLoop(canvas, (d) => {
                                for (let p = 0; p < d.length; p += 4) {
                                    const r = d[p], g = d[p + 1], b = d[p + 2];
                                    if (m === 'gray') {
                                        const v = r * 0.299 + g * 0.587 + b * 0.114;
                                        d[p] = d[p + 1] = d[p + 2] = v;
                                    } else if (m === 'invert') {
                                        d[p] = 255 - r; d[p + 1] = 255 - g; d[p + 2] = 255 - b;
                                    } else {
                                        d[p] = Math.min(255, r * 0.393 + g * 0.769 + b * 0.189);
                                        d[p + 1] = Math.min(255, r * 0.349 + g * 0.686 + b * 0.168);
                                        d[p + 2] = Math.min(255, r * 0.272 + g * 0.534 + b * 0.131);
                                    }
                                }
                            });
                        }, (f) => runner.progress(f));
                        await runner.applied(bytes);
                    } catch (e) { runner.error(e); }
                })), runner.host);
            });
        },
    });

    reg({
        id: 'overlay', key: 'overlay', cat: 'edit', icon: '🪟',
        build(view) {
            A.workspaceGate(view, (body) => {
                const card = el('div', { class: 'card' });
                const picker = A.filePicker({ multiple: false, labelKey: 'btn_choose' });
                const mode = A.segmented([{ value: 'fg', label: t('ov_fg') }, { value: 'bg', label: t('ov_bg') }], 'bg');
                const repeat = A.check('ov_repeat', true);
                card.appendChild(A.field('ov_file', picker));
                card.appendChild(A.field('opt_position', mode));
                card.appendChild(repeat);
                body.appendChild(card);
                const runner = A.makeRunner(body);
                body.insertBefore(el('div', { class: 'btn-row' }, A.runButton('btn_apply', async () => {
                    try {
                        runner.clear();
                        const files = picker.getFiles();
                        if (!files.length) { A.toast(t('ov_file'), 'err'); return; }
                        const ovBytes = await pickedPdfBytes(files[0]);
                        const ovLib = ensureContents(await loadLib(ovBytes));
                        const ovCount = ovLib.getPageCount();
                        if (mode.getValue() === 'fg') {
                            const doc = await loadLib(A.state.bytes);
                            const embeds = await doc.embedPdf(ovLib, ovLib.getPageIndices());
                            const n = doc.getPageCount();
                            for (let i = 0; i < n; i++) {
                                let oi = i < ovCount ? i : (repeat.input.checked ? ovCount - 1 : -1);
                                if (oi < 0) continue;
                                const p = doc.getPage(i);
                                p.drawPage(embeds[oi], { x: 0, y: 0, width: p.getWidth(), height: p.getHeight() });
                                runner.progress((i + 1) / n);
                            }
                            await runner.applied(await doc.save());
                        } else {
                            const src = ensureContents(await loadLib(A.state.bytes));
                            const out = await PDFLib.PDFDocument.create();
                            const baseEmb = await out.embedPdf(src, src.getPageIndices());
                            const ovEmb = await out.embedPdf(ovLib, ovLib.getPageIndices());
                            const n = baseEmb.length;
                            for (let i = 0; i < n; i++) {
                                const bp = baseEmb[i];
                                const p = out.addPage([bp.width, bp.height]);
                                let oi = i < ovCount ? i : (repeat.input.checked ? ovCount - 1 : -1);
                                if (oi >= 0) p.drawPage(ovEmb[oi], { x: 0, y: 0, width: bp.width, height: bp.height });
                                p.drawPage(bp, { x: 0, y: 0, width: bp.width, height: bp.height });
                                runner.progress((i + 1) / n);
                            }
                            await runner.applied(await out.save());
                        }
                    } catch (e) { runner.error(e); }
                })), runner.host);
            });
        },
    });

    reg({
        id: 'attachments', key: 'attach', cat: 'edit', icon: '📎',
        build(view) {
            A.workspaceGate(view, async (body) => {
                const listCard = el('div', { class: 'card' }, el('h2', { text: t('at_list') }));
                const listBox = el('div', { class: 'res-items' });
                listCard.appendChild(listBox);
                body.appendChild(listCard);
                async function refresh() {
                    listBox.textContent = '';
                    try {
                        const doc = await loadLib(A.state.bytes);
                        const atts = doc.getAttachments ? doc.getAttachments() : [];
                        if (!atts.length) { listBox.appendChild(el('p', { class: 'hint', text: t('at_none') })); return; }
                        for (const a of atts) {
                            listBox.appendChild(el('div', { class: 'res-item' },
                                el('button', { type: 'button', class: 'btn', onclick: () => A.download(a.data, a.name) }, '⭳ ' + a.name),
                                el('span', { class: 'fr-size', text: A.fmtSize(a.data.length) })));
                        }
                    } catch (e) {
                        listBox.appendChild(el('p', { class: 'hint', text: t('at_none') }));
                    }
                }
                await refresh();
                const addCard = el('div', { class: 'card' });
                const picker = A.filePicker({ accept: '*/*', labelKey: 'at_add' });
                addCard.appendChild(picker);
                body.appendChild(addCard);
                const runner = A.makeRunner(body);
                body.insertBefore(el('div', { class: 'btn-row' }, A.runButton('btn_apply', async () => {
                    try {
                        runner.clear();
                        const files = picker.getFiles();
                        if (!files.length) { A.toast(t('at_add'), 'err'); return; }
                        const doc = await loadLib(A.state.bytes);
                        for (const f of files) {
                            await doc.attach(await readBytes(f), f.name, {
                                mimeType: f.type || 'application/octet-stream',
                                creationDate: new Date(), modificationDate: new Date(f.lastModified || Date.now()),
                            });
                        }
                        picker.clear();
                        await runner.applied(await doc.save());
                        await refresh();
                    } catch (e) { runner.error(e); }
                })), runner.host);
            });
        },
    });

    /* ========================================================== ADVANCED == */

    reg({
        id: 'compare', key: 'compare', cat: 'advanced', icon: '⚖️',
        build(view) {
            const body = el('div', { class: 'tool-body' });
            view.appendChild(body);
            const card = el('div', { class: 'card' });
            const pickA = A.filePicker({ multiple: false, labelKey: 'btn_choose' });
            const pickB = A.filePicker({ multiple: false, labelKey: 'btn_choose' });
            const useWs = A.state.bytes ? A.check('cm_use_ws', true) : null;
            const fa = A.field(null, pickA);
            fa.insertBefore(el('label', { text: t('cm_a') }), fa.firstChild);
            if (useWs) fa.appendChild(useWs);
            const fb = A.field(null, pickB);
            fb.insertBefore(el('label', { text: t('cm_b') }), fb.firstChild);
            card.appendChild(el('div', { class: 'field-row' }, fa, fb));
            body.appendChild(card);
            const runner = A.makeRunner(body);
            body.insertBefore(el('div', { class: 'btn-row' }, A.runButton('cm_run', async () => {
                try {
                    runner.clear();
                    let aBytes = null;
                    if (useWs && useWs.input.checked && A.state.bytes) aBytes = A.state.bytes;
                    else if (pickA.getFiles().length) aBytes = await pickedPdfBytes(pickA.getFiles()[0]);
                    const bFiles = pickB.getFiles();
                    if (!aBytes || !bFiles.length) { A.toast(t('cm_b'), 'err'); return; }
                    const bBytes = await pickedPdfBytes(bFiles[0]);
                    const [da, db] = await Promise.all([A.pdfjsDocFor(aBytes), A.pdfjsDocFor(bBytes)]);
                    const n = Math.max(da.numPages, db.numPages);
                    const frag = el('div', { class: 'card result' });
                    frag.appendChild(el('p', { class: 'res-title', text: t('cm_legend') }));
                    let anyDiff = false;
                    for (let i = 0; i < n; i++) {
                        const ta = i < da.numPages ? await pageText(da, i) : '';
                        const tb = i < db.numPages ? await pageText(db, i) : '';
                        runner.progress((i + 1) / n);
                        const ops = diffWords(ta, tb);
                        if (!ops.length) continue;
                        anyDiff = true;
                        const block = el('p', { style: 'font-size:.85rem;line-height:1.6' });
                        block.appendChild(el('strong', { text: t('page_n', { n: i + 1 }) + ' — ' }));
                        for (const op of ops) {
                            if (op.op === 'same') {
                                const words = op.text.split(' ');
                                const shortened = words.length > 14 ? words.slice(0, 6).join(' ') + ' … ' + words.slice(-6).join(' ') : op.text;
                                block.appendChild(document.createTextNode(' ' + shortened + ' '));
                            } else {
                                block.appendChild(el('span', { class: op.op === 'del' ? 'diff-del' : 'diff-add', text: op.text }));
                                block.appendChild(document.createTextNode(' '));
                            }
                        }
                        frag.appendChild(block);
                    }
                    if (!anyDiff) {
                        frag.appendChild(el('p', { text: t('cm_same') }));
                    }
                    /* visual side-by-side of first differing (or first) page */
                    const cols = el('div', { class: 'cmp-cols' });
                    const ra = await A.renderPage(da, 0, { targetWidth: 420 });
                    cols.appendChild(ra.canvas);
                    if (db.numPages) {
                        const rb = await A.renderPage(db, 0, { targetWidth: 420 });
                        cols.appendChild(rb.canvas);
                    }
                    frag.appendChild(cols);
                    da.destroy(); db.destroy();
                    runner.done();
                    runner.host.textContent = '';
                    runner.host.appendChild(frag);
                } catch (e) { runner.error(e); }
            })), runner.host);
        },
    });

    reg({
        id: 'bookmarks', key: 'bookmarks', cat: 'advanced', icon: '🔗',
        build(view) {
            A.workspaceGate(view, async (body) => {
                body.appendChild(el('p', { class: 'hint', text: t('bm_note') }));
                const card = el('div', { class: 'card' });
                const list = el('div', {});
                card.appendChild(list);
                const rows = [];
                function addRow(title, page) {
                    const titleInp = A.input('text', { value: title || '' });
                    const pageInp = A.input('number', { value: String(page || 1), min: '1', max: String(A.state.pageCount) });
                    pageInp.style.maxWidth = '6.5rem';
                    const row = { titleInp, pageInp };
                    const wrap = el('div', { class: 'field-row', style: 'align-items:flex-end;margin-bottom:.6rem' },
                        A.field('bm_title', titleInp),
                        A.field('bm_page', pageInp),
                        el('button', {
                            type: 'button', class: 'icon-btn', 'aria-label': t('close'), style: 'margin-bottom:.1rem',
                            onclick: () => { rows.splice(rows.indexOf(row), 1); wrap.remove(); refreshEmpty(); },
                        }, '✕'));
                    rows.push(row);
                    list.appendChild(wrap);
                    refreshEmpty();
                }
                const emptyMsg = el('p', { class: 'hint', text: t('bm_none') });
                function refreshEmpty() { emptyMsg.style.display = rows.length ? 'none' : ''; }
                card.appendChild(emptyMsg);
                card.appendChild(el('div', { class: 'btn-row' }, el('button', {
                    type: 'button', class: 'btn', onclick: () => addRow('', 1),
                }, '+ ' + t('bm_add'))));
                body.appendChild(card);
                /* load existing top-level bookmarks */
                try {
                    const doc = await A.getDoc();
                    const outline = await doc.getOutline();
                    for (const item of outline || []) {
                        try {
                            let dest = item.dest;
                            if (typeof dest === 'string') dest = await doc.getDestination(dest);
                            const pi = dest ? await doc.getPageIndex(dest[0]) : 0;
                            addRow(item.title || '', pi + 1);
                        } catch (e) { addRow(item.title || '', 1); }
                    }
                } catch (e) { /* no outline */ }
                refreshEmpty();
                const runner = A.makeRunner(body);
                body.insertBefore(el('div', { class: 'btn-row' }, A.runButton('btn_apply', async () => {
                    try {
                        runner.clear();
                        const doc = await loadLib(A.state.bytes);
                        const items = rows
                            .map((r) => ({ title: r.titleInp.value.trim(), page: Math.max(0, (+r.pageInp.value || 1) - 1) }))
                            .filter((x) => x.title);
                        writeOutline(doc, items);
                        await runner.applied(await doc.save());
                    } catch (e) { runner.error(e); }
                })), runner.host);
            });
        },
    });

    reg({
        id: 'info', key: 'info', cat: 'advanced', icon: 'ℹ️',
        build(view) {
            A.workspaceGate(view, async (body) => {
                const card = el('div', { class: 'card' });
                body.appendChild(card);
                const rows = [];
                const push = (k, v) => rows.push([k, v]);
                try {
                    const bytes = A.state.bytes;
                    const doc = await loadLib(bytes);
                    const N = PDFLib.PDFName.of.bind(PDFLib.PDFName);
                    push(t('info_pages'), String(doc.getPageCount()));
                    push(t('info_size'), A.fmtSize(bytes.length));
                    const header = new TextDecoder('latin1').decode(bytes.slice(0, 16));
                    const vm = header.match(/%PDF-(\d\.\d)/);
                    if (vm) push(t('info_version'), vm[1]);
                    const dims = new Map();
                    for (const p of doc.getPages()) {
                        const { width, height } = p.getSize();
                        const key = Math.round(width) + ' × ' + Math.round(height) + ' pt';
                        dims.set(key, (dims.get(key) || 0) + 1);
                    }
                    push(t('info_dims'), [...dims.entries()].map(([k, c]) => k + ' (' + c + ')').join(', '));
                    push(t('info_enc'), doc.isEncrypted ? t('yes') : t('no'));
                    push(t('md_title'), doc.getTitle() || '–');
                    push(t('md_author'), doc.getAuthor() || '–');
                    push(t('md_subject'), doc.getSubject() || '–');
                    push(t('md_keywords'), doc.getKeywords() || '–');
                    push(t('md_creator'), doc.getCreator() || '–');
                    push(t('md_producer'), doc.getProducer() || '–');
                    let formCount = 0;
                    try { formCount = doc.getForm().getFields().length; } catch (e) { /* none */ }
                    push(t('info_form'), String(formCount));
                    let jsCount = 0;
                    try { jsCount = (doc.getDocumentJavaScripts ? doc.getDocumentJavaScripts() : []).length; } catch (e) { /* none */ }
                    push(t('info_js'), String(jsCount));
                    let attCount = 0;
                    try { attCount = (doc.getAttachments ? doc.getAttachments() : []).length; } catch (e) { /* none */ }
                    push(t('info_att'), String(attCount));
                    let fonts = 0, images = 0;
                    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
                        if (obj instanceof PDFLib.PDFDict && dictGet(obj, 'Type') === N('Font')) fonts++;
                        else if (obj instanceof PDFLib.PDFRawStream && dictGet(obj.dict, 'Subtype') === N('Image')) images++;
                    }
                    push(t('info_fonts'), String(fonts));
                    push(t('info_images'), String(images));
                } catch (e) {
                    push('!', String(e && e.message));
                }
                const table = el('table', { class: 'kv' });
                for (const [k, v] of rows) table.appendChild(el('tr', {}, el('td', { text: k }), el('td', { text: v })));
                card.appendChild(table);
            });
        },
    });

    reg({
        id: 'show-js', key: 'showjs', cat: 'advanced', icon: '⚙️',
        build(view) {
            A.workspaceGate(view, async (body) => {
                const card = el('div', { class: 'card' });
                body.appendChild(card);
                let scripts = [];
                try {
                    const doc = await loadLib(A.state.bytes);
                    scripts = doc.getDocumentJavaScripts ? doc.getDocumentJavaScripts() : [];
                } catch (e) { scripts = []; }
                if (!scripts.length) {
                    card.appendChild(el('p', { class: 'res-title', text: t('sj_none') }));
                    return;
                }
                for (const s of scripts) {
                    card.appendChild(el('h2', { text: s.name || 'script' }));
                    const pre = el('pre', { class: 'info-block' });
                    pre.textContent = s.script || '';
                    card.appendChild(pre);
                }
                const runner = A.makeRunner(body);
                body.insertBefore(el('div', { class: 'btn-row' }, A.runButton('sj_strip', async () => {
                    try {
                        runner.clear();
                        const doc = await loadLib(A.state.bytes);
                        stripJavaScript(doc);
                        await runner.applied(await doc.save());
                    } catch (e) { runner.error(e); }
                })), runner.host);
            });
        },
    });

    reg({
        id: 'repair', key: 'repair', cat: 'advanced', icon: '🩹',
        build(view) {
            A.workspaceGate(view, (body) => {
                body.appendChild(el('p', { class: 'hint', text: t('rp_note') }));
                const runner = A.makeRunner(body);
                body.insertBefore(el('div', { class: 'btn-row' }, A.runButton('btn_run', async () => {
                    try {
                        runner.clear();
                        const doc = await loadLib(A.state.bytes);
                        const bytes = await doc.save({ useObjectStreams: true });
                        await runner.applied(bytes, { downloadName: A.baseName(A.state.name) + '-repaired.pdf' });
                    } catch (e) { runner.error(e); }
                })), runner.host);
            });
        },
    });

    reg({
        id: 'scanner', key: 'scanner', cat: 'advanced', icon: '🖨',
        build(view) {
            A.workspaceGate(view, (body) => {
                const card = el('div', { class: 'card' });
                const rot = A.check('scn_rot', true);
                const noise = A.check('scn_noise', true);
                const gray = A.check('scn_gray', true);
                card.appendChild(rot); card.appendChild(noise); card.appendChild(gray);
                body.appendChild(card);
                const runner = A.makeRunner(body);
                body.insertBefore(el('div', { class: 'btn-row' }, A.runButton('btn_apply', async () => {
                    try {
                        runner.clear();
                        const doc = await A.getDoc();
                        const idx = Array.from({ length: doc.numPages }, (_, i) => i);
                        const bytes = await rasterTransform(idx, 150, 0.82, (canvas) => {
                            if (rot.input.checked) {
                                const c2 = document.createElement('canvas');
                                c2.width = canvas.width; c2.height = canvas.height;
                                const ctx2 = c2.getContext('2d');
                                ctx2.fillStyle = '#fff';
                                ctx2.fillRect(0, 0, c2.width, c2.height);
                                ctx2.translate(c2.width / 2, c2.height / 2);
                                ctx2.rotate((Math.random() * 1.4 - 0.7) * Math.PI / 180);
                                ctx2.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
                                canvas.getContext('2d').drawImage(c2, 0, 0);
                            }
                            pixelLoop(canvas, (d) => {
                                for (let p = 0; p < d.length; p += 4) {
                                    let r = d[p], g = d[p + 1], b = d[p + 2];
                                    if (gray.input.checked) {
                                        const v = r * 0.299 + g * 0.587 + b * 0.114;
                                        r = g = b = v;
                                    }
                                    /* slight contrast lift like a cheap scanner */
                                    r = Math.max(0, Math.min(255, (r - 128) * 1.12 + 132));
                                    g = Math.max(0, Math.min(255, (g - 128) * 1.12 + 132));
                                    b = Math.max(0, Math.min(255, (b - 128) * 1.12 + 132));
                                    if (noise.input.checked && Math.random() < 0.22) {
                                        const nz = (Math.random() - 0.5) * 26;
                                        r += nz; g += nz; b += nz;
                                    }
                                    d[p] = r; d[p + 1] = g; d[p + 2] = b;
                                }
                            });
                        }, (f) => runner.progress(f));
                        await runner.applied(bytes, { downloadName: A.baseName(A.state.name) + '-scanned.pdf' });
                    } catch (e) { runner.error(e); }
                })), runner.host);
            });
        },
    });

    reg({
        id: 'auto-rename', key: 'rename', cat: 'advanced', icon: '🔖',
        build(view) {
            A.workspaceGate(view, async (body) => {
                const card = el('div', { class: 'card' });
                const inp = A.input('text', {});
                card.appendChild(A.field('ar_suggest', inp));
                body.appendChild(card);
                try {
                    const doc = await A.getDoc();
                    const page = await doc.getPage(1);
                    const tc = await page.getTextContent();
                    const lines = new Map();
                    for (const item of tc.items) {
                        if (!item.str.trim()) continue;
                        const h = Math.hypot(item.transform[2], item.transform[3]);
                        const y = Math.round(item.transform[5]);
                        const key = y;
                        if (!lines.has(key)) lines.set(key, { h: 0, parts: [] });
                        const L = lines.get(key);
                        L.h = Math.max(L.h, h);
                        L.parts.push(item.str);
                    }
                    let best = null;
                    for (const [, L] of lines) {
                        const txt = L.parts.join(' ').trim();
                        if (txt.length < 4 || txt.length > 120) continue;
                        if (!best || L.h > best.h) best = { h: L.h, txt };
                    }
                    let suggestion = best && best.txt;
                    if (!suggestion) {
                        try {
                            const lib = await loadLib(A.state.bytes);
                            suggestion = lib.getTitle() || '';
                        } catch (e) { suggestion = ''; }
                    }
                    if (suggestion) {
                        inp.value = suggestion.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) + '.pdf';
                    } else {
                        card.appendChild(el('p', { class: 'hint', text: t('ar_none') }));
                    }
                } catch (e) { /* keep manual input */ }
                card.appendChild(el('div', { class: 'btn-row' },
                    el('button', {
                        type: 'button', class: 'btn btn-primary', onclick: () => {
                            const v = inp.value.trim();
                            if (!v) return;
                            A.state.name = /\.pdf$/i.test(v) ? v : v + '.pdf';
                            document.dispatchEvent(new CustomEvent('pdfstudio:workspace'));
                            A.toast(t('toast_applied'), 'ok');
                            const chipName = document.getElementById('ws-name');
                            if (chipName) chipName.textContent = A.state.name;
                        },
                    }, t('ar_use')),
                    el('button', {
                        type: 'button', class: 'btn', onclick: () => {
                            const v = inp.value.trim() || A.state.name;
                            A.download(A.state.bytes, /\.pdf$/i.test(v) ? v : v + '.pdf', 'application/pdf');
                        },
                    }, t('btn_download'))));
            });
        },
    });
})();
