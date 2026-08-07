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

    /* "1-3, 5, 8-, odd" → sorted unique 0-based indices (empty spec → all) */
    function parseRanges(spec, n) {
        spec = String(spec || '').trim().toLowerCase();
        if (!spec || spec === 'all') return Array.from({ length: n }, (_, i) => i);
        const out = [];
        const seen = new Set();
        const push = (i) => { if (i >= 0 && i < n && !seen.has(i)) { seen.add(i); out.push(i); } };
        for (const tokRaw of spec.split(',')) {
            const tok = tokRaw.trim();
            if (!tok) continue;
            if (tok === 'all') { for (let i = 0; i < n; i++) push(i); continue; }
            if (tok === 'odd' || tok === 'impair' || tok === 'oneven') { for (let i = 0; i < n; i += 2) push(i); continue; }
            if (tok === 'even' || tok === 'pair') { for (let i = 1; i < n; i += 2) push(i); continue; }
            if (tok === 'first' || tok === 'premier' || tok === 'eerste') { push(0); continue; }
            if (tok === 'last' || tok === 'dernier' || tok === 'laatste') { push(n - 1); continue; }
            const m = tok.match(/^(\d+)?\s*-\s*(\d+)?$/);
            let a, b;
            if (m && (m[1] || m[2])) { a = m[1] ? +m[1] : 1; b = m[2] ? +m[2] : n; }
            else if (/^\d+$/.test(tok)) { a = b = +tok; }
            else continue;
            if (a > b) [a, b] = [b, a];
            a = Math.max(1, a); b = Math.min(n, b);
            for (let i = a; i <= b; i++) push(i - 1);
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

    /* ------------------------------------------------------------- ZIP -- */
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

    const HAS_CS = typeof CompressionStream === 'function';
    const HAS_DS = typeof DecompressionStream === 'function';

    async function streamBytes(bytes, stream) {
        const copy = bytes.slice();          // detach from any pooled buffer
        const piped = new Blob([copy]).stream().pipeThrough(stream);
        return new Uint8Array(await new Response(piped).arrayBuffer());
    }
    async function deflateRaw(bytes) {
        if (!HAS_CS) return null;
        try { return await streamBytes(bytes, new CompressionStream('deflate-raw')); }
        catch (e) { return null; }
    }
    async function inflateRaw(bytes) {
        if (!HAS_DS) throw new Error('DecompressionStream unavailable');
        return streamBytes(bytes, new DecompressionStream('deflate-raw'));
    }
    /* PDF FlateDecode streams carry the zlib wrapper, not raw deflate */
    async function inflateZlib(bytes) {
        if (!HAS_DS) throw new Error('DecompressionStream unavailable');
        return streamBytes(bytes, new DecompressionStream('deflate'));
    }

    function dosStamp(d) {
        return {
            time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF,
            date: (((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF,
        };
    }

    /* entries: [{name, data:Uint8Array}] → zip bytes.
       Deflated when the browser can (all current ones), stored otherwise.
       Repeated names are numbered — a zip with duplicates confuses extractors. */
    async function zipMake(entries, onProgress) {
        const enc = new TextEncoder();
        const stamp = dosStamp(new Date());
        const locals = [];
        const centrals = [];
        const used = new Set();
        let offset = 0;
        let done = 0;
        for (const e of entries) {
            let name = e.name || 'file';
            if (used.has(name)) {
                let n = 2;
                while (used.has(name.replace(/(\.[^./]+)?$/, '-' + n + '$1'))) n++;
                name = name.replace(/(\.[^./]+)?$/, '-' + n + '$1');
            }
            used.add(name);
            const nameB = enc.encode(name);
            const raw = e.data;
            const crc = crc32(raw);
            let method = 0;
            let body = raw;
            if (raw.length > 64) {
                const def = await deflateRaw(raw);
                if (def && def.length < raw.length) { method = 8; body = def; }
            }
            const lh = new DataView(new ArrayBuffer(30));
            lh.setUint32(0, 0x04034b50, true);
            lh.setUint16(4, 20, true);
            lh.setUint16(6, 0x0800, true);   // UTF-8 names
            lh.setUint16(8, method, true);
            lh.setUint16(10, stamp.time, true);
            lh.setUint16(12, stamp.date, true);
            lh.setUint32(14, crc, true);
            lh.setUint32(18, body.length, true);
            lh.setUint32(22, raw.length, true);
            lh.setUint16(26, nameB.length, true);
            lh.setUint16(28, 0, true);
            locals.push(new Uint8Array(lh.buffer), nameB, body);
            const ch = new DataView(new ArrayBuffer(46));
            ch.setUint32(0, 0x02014b50, true);
            ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
            ch.setUint16(8, 0x0800, true); ch.setUint16(10, method, true);
            ch.setUint16(12, stamp.time, true); ch.setUint16(14, stamp.date, true);
            ch.setUint32(16, crc, true);
            ch.setUint32(20, body.length, true); ch.setUint32(24, raw.length, true);
            ch.setUint16(28, nameB.length, true);
            ch.setUint32(42, offset, true);
            centrals.push(new Uint8Array(ch.buffer), nameB);
            offset += 30 + nameB.length + body.length;
            if (onProgress) onProgress(++done / entries.length);
        }
        let cdSize = 0;
        for (const c of centrals) cdSize += c.length;
        const eocd = new DataView(new ArrayBuffer(22));
        eocd.setUint32(0, 0x06054b50, true);
        eocd.setUint16(8, entries.length, true);
        eocd.setUint16(10, entries.length, true);
        eocd.setUint32(12, cdSize, true);
        eocd.setUint32(16, offset, true);
        const out = new Uint8Array(offset + cdSize + 22);
        let p = 0;
        for (const part of locals) { out.set(part, p); p += part.length; }
        for (const part of centrals) { out.set(part, p); p += part.length; }
        out.set(new Uint8Array(eocd.buffer), p);
        return out;
    }

    /* zip bytes → [{name, data}] (entries we cannot read carry .error) */
    async function zipRead(bytes) {
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let eocd = -1;
        const floor = Math.max(0, bytes.length - 66000);
        for (let i = bytes.length - 22; i >= floor; i--) {
            if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
        }
        if (eocd < 0) throw new Error('not a ZIP archive');
        const count = dv.getUint16(eocd + 10, true);
        let p = dv.getUint32(eocd + 16, true);
        if (p === 0xFFFFFFFF || count === 0xFFFF) throw new Error('ZIP64 archives are not supported');
        const dec = new TextDecoder();
        const out = [];
        for (let i = 0; i < count && p + 46 <= bytes.length; i++) {
            if (dv.getUint32(p, true) !== 0x02014b50) break;
            let name = '(unnamed)';
            try {
                const flags = dv.getUint16(p + 8, true);
                const method = dv.getUint16(p + 10, true);
                const compSize = dv.getUint32(p + 20, true);
                const nameLen = dv.getUint16(p + 28, true);
                const extraLen = dv.getUint16(p + 30, true);
                const cmtLen = dv.getUint16(p + 32, true);
                const lho = dv.getUint32(p + 42, true);
                name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
                p += 46 + nameLen + extraLen + cmtLen;
                if (name.endsWith('/')) continue;                       // directory entry
                if (flags & 1) { out.push({ name, error: 'encrypted' }); continue; }
                if (compSize === 0xFFFFFFFF) { out.push({ name, error: 'zip64' }); continue; }
                if (lho + 30 > bytes.length) { out.push({ name, error: 'damaged' }); continue; }
                const lnameLen = dv.getUint16(lho + 26, true);
                const lextraLen = dv.getUint16(lho + 28, true);
                const start = lho + 30 + lnameLen + lextraLen;
                if (start + compSize > bytes.length) { out.push({ name, error: 'damaged' }); continue; }
                const raw = bytes.subarray(start, start + compSize);
                if (method === 0) out.push({ name, data: raw.slice() });
                else if (method === 8) out.push({ name, data: await inflateRaw(raw) });
                else out.push({ name, error: 'method' + method });
            } catch (e) { out.push({ name, error: (e && e.message) || 'read failed' }); }
        }
        return out;
    }

    /* ------------------------------------------------------ WebCrypto -- */
    const cryptoOk = () => !!(window.crypto && window.crypto.subtle);

    async function deriveKey(password, salt) {
        const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
        return crypto.subtle.deriveKey(
            { name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' },
            km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    }
    /* layout: salt(16) | iv(12) | ciphertext+tag */
    async function aesEncrypt(bytes, password) {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const key = await deriveKey(password, salt);
        const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
        const out = new Uint8Array(28 + ct.length);
        out.set(salt, 0); out.set(iv, 16); out.set(ct, 28);
        return out;
    }
    async function aesDecrypt(bytes, password) {
        if (bytes.length < 29) throw new Error('payload too short');
        const key = await deriveKey(password, bytes.subarray(0, 16));
        const plain = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: bytes.subarray(16, 28) }, key, bytes.subarray(28));
        return new Uint8Array(plain);
    }

    async function sha256Hex(bytes) {
        if (!cryptoOk()) return null;
        const h = await crypto.subtle.digest('SHA-256', bytes.slice());
        return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
    }

    /* ============================================== security analysis == */
    /* A PDF can carry scripts, auto-run actions, embedded files and links.
       Everything below only *reads* the document; nothing is executed. */

    /* action /S values that can do something to the reader.
       Ordinary links are 'low' on purpose: almost every real document has
       them, and a banner that cries wolf is a banner nobody reads. A link
       that actually looks dangerous is reported separately as high. */
    const RISK_ACTIONS = {
        JavaScript: 'high', Launch: 'high', SubmitForm: 'high', ImportData: 'high',
        RichMediaExecute: 'high', GoToR: 'medium', Movie: 'medium',
        Sound: 'medium', Rendition: 'medium', URI: 'low', Hide: 'low',
        SetOCGState: 'low', Trans: 'low', Named: 'low',
    };

    /* annotation subtypes that embed active or external content */
    const RISK_ANNOTS = {
        FileAttachment: 'high', RichMedia: 'high', Movie: 'medium',
        Sound: 'medium', Screen: 'medium', '3D': 'medium',
    };

    /* pdfid-style raw keyword census — also catches things a parser may miss */
    const RAW_KEYWORDS = ['/JavaScript', '/JS', '/OpenAction', '/AA', '/Launch',
        '/EmbeddedFile', '/XFA', '/AcroForm', '/RichMedia', '/JBIG2Decode',
        '/JPXDecode', '/SubmitForm', '/GoToR', '/URI', '/ObjStm', '/Encrypt'];

    /* script fragments seen in weaponised PDFs; tokens stay untranslated
       because that is how analysts search for them */
    const JS_IOCS = [
        { re: /\beval\s*\(/i, token: 'eval()', kind: 'suspicious' },
        { re: /unescape\s*\(/i, token: 'unescape()', kind: 'suspicious' },
        { re: /String\.fromCharCode/i, token: 'String.fromCharCode', kind: 'suspicious' },
        { re: /app\.launchURL/i, token: 'app.launchURL', kind: 'suspicious' },
        { re: /this\.exportDataObject/i, token: 'exportDataObject', kind: 'suspicious' },
        { re: /submitForm\s*\(/i, token: 'submitForm()', kind: 'suspicious' },
        { re: /getAnnots\s*\(/i, token: 'getAnnots()', kind: 'suspicious' },
        { re: /app\.openDoc|this\.getURL/i, token: 'openDoc/getURL', kind: 'suspicious' },
        { re: /(%u9090|\\u9090|\\x90\\x90)/i, token: 'NOP sled', kind: 'exploit' },
        { re: /util\.printf/i, token: 'util.printf', kind: 'exploit', cve: 'CVE-2008-2992' },
        { re: /media\.newPlayer/i, token: 'media.newPlayer', kind: 'exploit', cve: 'CVE-2009-4324' },
        { re: /Collab\.collectEmailInfo/i, token: 'Collab.collectEmailInfo', kind: 'exploit', cve: 'CVE-2007-5659' },
        { re: /Collab\.getIcon/i, token: 'Collab.getIcon', kind: 'exploit', cve: 'CVE-2009-0927' },
        { re: /spell\.customDictionaryOpen/i, token: 'spell.customDictionaryOpen', kind: 'exploit', cve: 'CVE-2009-1493' },
    ];

    const URL_SHORTENERS = new Set(['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'is.gd',
        'ow.ly', 'cutt.ly', 'rb.gy', 'shorturl.at', 'buff.ly', 't.ly', 'rebrand.ly']);

    /* hxxp://example[.]com — safe to paste into a ticket or a chat */
    function defangUrl(url) {
        return String(url)
            .replace(/^http/i, 'hxxp')
            .replace(/^ftp/i, 'fxp')
            .replace(/:\/\//, '[://]')
            .replace(/\./g, '[.]')
            .replace(/@/g, '[@]');
    }

    /* Grades a URL. An ordinary https link is 'low': flagging every address as
       suspicious would drown the genuinely nasty ones. Severity is only raised
       when there is a concrete reason, and that reason is always shown. */
    function classifyUrl(url) {
        const why = [];
        let sev = 'low';
        const scheme = (String(url).split(':')[0] || '').toLowerCase();
        if (scheme === 'javascript' || scheme === 'data') { sev = 'high'; why.push('scheme'); }
        else if (scheme === 'file') { sev = 'high'; why.push('local'); }
        else if (scheme !== 'http' && scheme !== 'https' && scheme !== 'mailto') { sev = 'medium'; why.push('scheme'); }
        let u = null;
        try { u = new URL(url); } catch (e) { /* not parseable, judge on scheme only */ }
        if (u) {
            const bump = (s) => { if (s === 'high' || sev === 'low') sev = s; };
            const host = u.hostname.toLowerCase();
            if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) { sev = 'high'; why.push('ip'); }
            if (host.startsWith('xn--') || host.includes('.xn--')) { sev = 'high'; why.push('punycode'); }
            if (u.username || u.password) { sev = 'high'; why.push('credentials'); }
            if (u.port && u.port !== '80' && u.port !== '443') { bump('medium'); why.push('port'); }
            if (URL_SHORTENERS.has(host.replace(/^www\./, ''))) { bump('medium'); why.push('shortener'); }
            if ((u.href.match(/%[0-9a-f]{2}/gi) || []).length > 8) { bump('medium'); why.push('encoded'); }
            if (/\.(exe|scr|js|vbs|hta|jar|ps1|bat|cmd|zip|7z|iso|lnk)$/i.test(u.pathname)) { sev = 'high'; why.push('payload'); }
        }
        return { sev, why };
    }

    function pdfTextValue(v) {
        try {
            if (!v) return '';
            if (v instanceof PDFLib.PDFHexString) return v.decodeText();
            if (v instanceof PDFLib.PDFString) return v.asString();
        } catch (e) { /* unreadable string object */ }
        return '';
    }

    /* Reads a /JS value: literal string, hex string, or a (possibly
       compressed) stream. */
    async function readJsValue(v) {
        const direct = pdfTextValue(v);
        if (direct) return direct;
        try {
            if (v instanceof PDFLib.PDFRawStream) {
                const filter = v.dict.get(PDFLib.PDFName.of('Filter'));
                let raw = v.contents;
                if (filter === PDFLib.PDFName.of('FlateDecode')) raw = await inflateZlib(raw);
                return new TextDecoder().decode(raw);
            }
        } catch (e) { /* undecodable script stream */ }
        return '';
    }

    const SEV_ORDER = { high: 3, medium: 2, low: 1, info: 0 };

    /* Read-only triage of a PDF.
         opts.deep     also sweeps the raw bytes (keyword census, stray URLs)
                       and hashes the file — skipped for the background scan
                       that only feeds the warning banner.
         opts.pageText also reads visible page text for links (uses pdf.js). */
    async function analyzePdf(bytes, opts) {
        const o = opts || {};
        const N = (s) => PDFLib.PDFName.of(s);
        const rep = {
            size: bytes.length, sha256: null, version: null, pageCount: 0,
            encrypted: false, findings: [], uris: [], scripts: [], embedded: [],
            raw: {}, verdict: 'clean', highest: 'info',
        };
        const add = (key, sev, item) => {
            let f = rep.findings.find((x) => x.key === key);
            if (!f) { f = { key, sev, count: 0, items: [] }; rep.findings.push(f); }
            f.count++;
            if (item && f.items.length < 40 && !f.items.includes(item)) f.items.push(item);
        };
        const seenUrl = new Map();
        const addUrl = (url, where) => {
            const clean = String(url).trim().replace(/[)>\].,;'"]+$/, '');
            if (clean.length < 5 || clean.length > 500) return;
            const prev = seenUrl.get(clean);
            if (prev) { if (!prev.where.includes(where)) prev.where.push(where); return; }
            const cls = classifyUrl(clean);
            seenUrl.set(clean, { url: clean, defanged: defangUrl(clean), where: [where], sev: cls.sev, why: cls.why });
        };

        const header = new TextDecoder('latin1').decode(bytes.subarray(0, 32));
        const vm = header.match(/%PDF-(\d\.\d)/);
        rep.version = vm ? vm[1] : null;

        const doc = await PDFLib.PDFDocument.load(bytes, {
            ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false,
        });
        rep.encrypted = !!doc.isEncrypted;
        try { rep.pageCount = doc.getPageCount(); } catch (e) { rep.pageCount = 0; }
        if (rep.encrypted) add('encrypted', 'low');

        /* ---- catalog-level auto-run hooks ---- */
        const cat = doc.catalog;
        const openAction = cat.get(N('OpenAction'));
        if (openAction) {
            let kind = 'GoTo';
            try {
                const oa = cat.lookup(N('OpenAction'));
                if (oa instanceof PDFLib.PDFDict) {
                    const s = oa.get(N('S'));
                    kind = s ? String(s).replace('/', '') : 'GoTo';
                }
            } catch (e) { /* unreadable OpenAction */ }
            add('openaction', RISK_ACTIONS[kind] === 'high' ? 'high' : 'medium', kind);
        }
        if (cat.get(N('AA'))) add('catalog_aa', 'high');
        try {
            const acro = cat.lookup(N('AcroForm'), PDFLib.PDFDict);
            if (acro) {
                add('acroform', 'low');
                if (acro.get(N('XFA'))) add('xfa', 'high');
            }
        } catch (e) { /* no form */ }

        /* ---- every dictionary in the file ----
           Not just the indirect objects: most writers inline the /A action
           dictionary inside the link annotation, so walking only the top level
           would miss ordinary URI, Launch and JavaScript actions. */
        let objects = 0;
        const seen = new Set();
        const stack = [];
        const visit = (v) => {
            if (!v || seen.has(v)) return;
            if (v instanceof PDFLib.PDFDict || v instanceof PDFLib.PDFArray) { seen.add(v); stack.push(v); }
        };
        for (const [, obj] of doc.context.enumerateIndirectObjects()) {
            objects++;
            if (obj instanceof PDFLib.PDFDict) visit(obj);
            else if (obj instanceof PDFLib.PDFRawStream) visit(obj.dict);
        }
        visit(cat);
        rep.objects = objects;

        while (stack.length) {
            const node = stack.pop();
            if (node instanceof PDFLib.PDFArray) {
                for (let i = 0; i < node.size(); i++) visit(node.get(i));
                continue;
            }
            const dict = node;

            const sVal = dict.get(N('S'));
            if (sVal) {
                const kind = String(sVal).replace('/', '');
                const sev = RISK_ACTIONS[kind];
                if (sev) {
                    if (kind === 'URI') {
                        const uri = pdfTextValue(dict.lookup(N('URI')));
                        if (uri) addUrl(uri, 'link');
                        add('act_URI', 'low', uri || null);
                    } else if (kind === 'JavaScript') {
                        const code = await readJsValue(dict.lookup(N('JS')));
                        if (code) rep.scripts.push({ name: 'action', code });
                        add('act_JavaScript', 'high');
                    } else if (kind === 'Launch') {
                        let target = '';
                        try {
                            const f = dict.lookup(N('F'));
                            target = pdfTextValue(f) || pdfTextValue(f && f.lookup && f.lookup(N('F'))) || '';
                        } catch (e) { /* opaque target */ }
                        add('act_Launch', 'high', target || null);
                    } else {
                        add('act_' + kind, sev);
                    }
                }
            }

            const sub = dict.get(N('Subtype'));
            if (sub) {
                const name = String(sub).replace('/', '');
                if (RISK_ANNOTS[name]) add('annot_' + name, RISK_ANNOTS[name]);
            }

            const type = dict.get(N('Type'));
            if (type && String(type) === '/Filespec') {
                // a specification without /EF carries no payload — the action
                // that points at it is reported separately
                let bytesLen = null;
                let hasData = false;
                try {
                    const ef = dict.lookup(N('EF'), PDFLib.PDFDict);
                    const st = ef && ef.lookup(N('F'));
                    if (ef) hasData = true;
                    /* /Params /Size is the real file size; st.contents is the
                       compressed stream, which would be a misleading figure. */
                    if (st && st.dict) {
                        const prm = st.dict.lookup(N('Params'), PDFLib.PDFDict);
                        const sz = prm && prm.lookup(N('Size'));
                        if (sz && typeof sz.asNumber === 'function') bytesLen = sz.asNumber();
                    }
                    if (bytesLen === null && st && st.contents) bytesLen = st.contents.length;
                } catch (e) { /* size unknown */ }
                if (hasData) {
                    const fname = pdfTextValue(dict.lookup(N('UF'))) || pdfTextValue(dict.lookup(N('F'))) || '(unnamed)';
                    const risky = /\.(exe|scr|js|jse|vbs|vbe|wsf|hta|jar|ps1|bat|cmd|com|pif|lnk|dll|iso|img|docm|xlsm|pptm|zip|7z|rar)$/i.test(fname);
                    rep.embedded.push({ name: fname, size: bytesLen, risky });
                    add('embedded_file', risky ? 'high' : 'medium', fname);
                }
            }

            if (dict.get(N('AA'))) add('object_aa', 'medium');
            if (dict.get(N('JS')) && !sVal) {
                const code = await readJsValue(dict.lookup(N('JS')));
                if (code) rep.scripts.push({ name: 'entry', code });
                add('js_entry', 'high');
            }

            const filt = dict.get(N('Filter'));
            if (filt) {
                const fs = String(filt);
                // common in scanned documents; only interesting next to other signals
                if (fs.includes('JBIG2Decode')) add('filter_jbig2', 'low');
                if (fs.includes('JPXDecode')) add('filter_jpx', 'low');
            }

            for (const v of dict.values()) visit(v);
        }

        /* ---- document-level script name tree ---- */
        try {
            const scripts = doc.getDocumentJavaScripts ? doc.getDocumentJavaScripts() : [];
            for (const s of scripts) {
                if (s && s.script) {
                    rep.scripts.push({ name: s.name || 'document', code: s.script });
                    add('doc_javascript', 'high', s.name || null);
                }
            }
        } catch (e) { /* no scripts */ }

        /* ---- raw keyword census + obfuscation check ---- */
        if (o.deep) {
            const rawText = new TextDecoder('latin1').decode(bytes);
            for (const kw of RAW_KEYWORDS) {
                let n = 0;
                for (let i = rawText.indexOf(kw); i !== -1; i = rawText.indexOf(kw, i + kw.length)) n++;
                if (n) rep.raw[kw] = n;
            }

            /* Hex-escaped names only matter when they decode to a keyword worth
               hiding — random "#4a" byte pairs inside streams are meaningless. */
            const EVADED = /^(JavaScript|JS|OpenAction|AA|Launch|EmbeddedFile|EmbeddedFiles|XFA|URI|SubmitForm|ImportData|RichMedia|Filespec|Names|Action)$/i;
            const hexNames = rawText.match(/\/[A-Za-z0-9#]{0,40}#[0-9A-Fa-f]{2}[A-Za-z0-9#]{0,40}/g) || [];
            const evaded = [];
            for (const rawName of hexNames) {
                const decoded = rawName.slice(1).replace(/#([0-9A-Fa-f]{2})/g, (mm, h) => String.fromCharCode(parseInt(h, 16)));
                if (EVADED.test(decoded) && !evaded.some((x) => x.startsWith(rawName))) evaded.push(rawName + ' \u2192 /' + decoded);
            }
            for (const e of evaded.slice(0, 10)) add('obfuscated_names', 'high', e);

            /* ---- URLs in the raw bytes (metadata, uncompressed streams) ---- */
            const urlRe = /\b(?:https?|ftp|file|mailto|javascript):(?:\/\/)?[^\s<>()"'\\{}\[\]]{4,300}/gi;
            let m;
            let rawUrls = 0;
            while ((m = urlRe.exec(rawText)) && rawUrls < 400) {
                if (!/[\x20-\x7E]{6,}/.test(m[0])) continue;
                addUrl(m[0], 'file');
                rawUrls++;
            }
        }

        /* ---- optional: links that are only visible as page text ---- */
        if (o.pageText) {
            /* Best effort, and time-boxed: everything above already produced a
               usable report, so a renderer that stalls on a malformed file must
               not leave the user staring at a progress bar forever. */
            let pdoc = null;
            try {
                const budget = new Promise((resolve) => setTimeout(() => resolve('timeout'), 30000));
                const sweep = (async () => {
                    pdoc = await pdfjsDocFor(bytes);
                    const max = Math.min(pdoc.numPages, 60);
                    for (let i = 0; i < max; i++) {
                        const page = await pdoc.getPage(i + 1);
                        const tc = await page.getTextContent();
                        const txt = tc.items.map((it) => it.str).join(' ');
                        let mm;
                        const re2 = /\b(?:https?:\/\/|www\.)[^\s<>()"']{4,300}/gi;
                        while ((mm = re2.exec(txt))) addUrl(mm[0].startsWith('www.') ? 'http://' + mm[0] : mm[0], 'text');
                        if (o.onProgress) o.onProgress((i + 1) / max);
                    }
                    return 'done';
                })();
                rep.textScan = await Promise.race([sweep, budget]);
            } catch (e) {
                rep.textScan = 'failed';
            }
            try { if (pdoc) pdoc.destroy(); } catch (e) { /* already gone */ }
        }

        rep.uris = [...seenUrl.values()].sort((a, b) => SEV_ORDER[b.sev] - SEV_ORDER[a.sev]);
        for (const u of rep.uris) if (u.sev === 'high') add('suspicious_url', 'high', u.defanged);
        if (rep.uris.length) add('external_links', 'low');

        /* ---- script indicators ---- */
        const allCode = rep.scripts.map((s) => s.code).join('\n');
        rep.jsIocs = [];
        if (allCode) {
            for (const ioc of JS_IOCS) {
                if (ioc.re.test(allCode)) {
                    rep.jsIocs.push({ token: ioc.token, kind: ioc.kind, cve: ioc.cve || null });
                    if (ioc.kind === 'exploit') add('js_exploit', 'high', ioc.token + (ioc.cve ? ' (' + ioc.cve + ')' : ''));
                }
            }
            if (allCode.length > 20000) add('js_large', 'medium', fmtSize(allCode.length));
        }

        rep.sha256 = o.deep ? await sha256Hex(bytes) : null;
        rep.findings.sort((a, b) => SEV_ORDER[b.sev] - SEV_ORDER[a.sev]);
        for (const f of rep.findings) if (SEV_ORDER[f.sev] > SEV_ORDER[rep.highest]) rep.highest = f.sev;
        rep.verdict = rep.highest === 'high' ? 'danger' : rep.highest === 'medium' ? 'caution' : 'clean';
        return rep;
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
            .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
            .replace(/[^\u0020-\u00FF\u0152\u0153\u0160\u0161\u0178\u017D\u017E\u20AC\u2022\u2020\u2021\u2030\u2122\u0192]/g, '?');
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
       map: Map(pageIndex → canvas). Untouched pages are copied losslessly.
       Rendered canvases already have /Rotate baked in by the pdf.js viewport,
       so rotated pages get swapped dimensions and rotation 0. */
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
                let { width, height } = srcPage.getSize();
                const rot = ((srcPage.getRotation().angle % 360) + 360) % 360;
                if (rot === 90 || rot === 270) [width, height] = [height, width];
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
        try {
            /* Time-boxed: a malformed file can leave pdf.js waiting forever, and
               that would stall the whole workspace load — including the warning
               banner, which is exactly what a hostile file must not be able to
               suppress. pdf-lib parses in this thread and always answers. */
            const doc = await Promise.race([
                pdfjsDocFor(bytes),
                new Promise((_, reject) => setTimeout(() => reject(new Error('pdfjs timeout')), 15000)),
            ]);
            const n = doc.numPages;
            doc.destroy();
            return n;
        } catch (e) {
            // pdf.js choked but pdf-lib produced these bytes — count there instead
            try {
                const d = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false });
                return d.getPageCount();
            } catch (e2) { return 0; }
        }
    }

    async function setWorkspace(bytes, opts) {
        const o = opts || {};
        if (state.bytes && !o.fresh) {
            state.history.push({ bytes: state.bytes, name: state.name, pageCount: state.pageCount });
            trimHistory();
            state.future = [];
        }
        if (o.fresh) { state.history = []; state.future = []; riskDismissed = false; }
        state.bytes = bytes;
        if (o.name) state.name = o.name;
        invalidateDocCache();
        try {
            state.pageCount = o.pageCount !== undefined ? o.pageCount : await countPages(bytes);
        } catch (e) { state.pageCount = 0; }
        updateChip();
        document.dispatchEvent(new CustomEvent('pdfstudio:workspace', { detail: { fresh: !!o.fresh } }));
        if (previewOpen) renderPreview();
        refreshRisk();
    }

    function undo() {
        if (!state.history.length) return;
        state.future.push({ bytes: state.bytes, name: state.name, pageCount: state.pageCount });
        const s = state.history.pop();
        state.bytes = s.bytes; state.name = s.name; state.pageCount = s.pageCount;
        invalidateDocCache(); updateChip(); toast(t('toast_undo'));
        document.dispatchEvent(new CustomEvent('pdfstudio:workspace'));
        if (previewOpen) renderPreview();
        refreshRisk();
    }
    function redo() {
        if (!state.future.length) return;
        state.history.push({ bytes: state.bytes, name: state.name, pageCount: state.pageCount });
        const s = state.future.pop();
        state.bytes = s.bytes; state.name = s.name; state.pageCount = s.pageCount;
        invalidateDocCache(); updateChip(); toast(t('toast_redo'));
        document.dispatchEvent(new CustomEvent('pdfstudio:workspace'));
        if (previewOpen) renderPreview();
        refreshRisk();
    }

    function closeWorkspace() {
        if (!state.bytes) return;
        if (!confirm(t('ws_confirm_close'))) return;
        state.bytes = null; state.history = []; state.future = []; state.pageCount = 0;
        invalidateDocCache(); updateChip(); closePreview();
        document.dispatchEvent(new CustomEvent('pdfstudio:workspace'));
        renderRiskBanner(null);
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

    /* ------------------------------------------------------ risk banner -- */
    let riskDismissed = false;
    let riskToken = 0;
    let lastRisk = null;

    function renderRiskBanner(rep) {
        const banner = $('#risk-banner');
        banner.textContent = '';
        if (!rep || riskDismissed || (rep.verdict !== 'danger' && rep.verdict !== 'caution')) {
            banner.hidden = true;
            return;
        }
        const high = rep.verdict === 'danger';
        banner.className = 'risk-banner' + (high ? '' : ' is-medium');
        banner.hidden = false;
        const parts = [];
        const scripts = rep.findings.filter((f) => f.key === 'doc_javascript' || f.key === 'act_JavaScript' || f.key === 'js_entry')
            .reduce((s, f) => s + f.count, 0);
        if (scripts) parts.push(t('rb_p_js', { n: scripts }));
        if (rep.uris.length) parts.push(t('rb_p_links', { n: rep.uris.length }));
        if (rep.embedded.length) parts.push(t('rb_p_files', { n: rep.embedded.length }));
        if (rep.findings.some((f) => f.key === 'openaction' || f.key === 'catalog_aa')) parts.push(t('rb_p_auto'));
        if (rep.findings.some((f) => f.key === 'act_Launch')) parts.push(t('rb_p_launch'));

        banner.appendChild(el('span', { class: 'rb-ico', 'aria-hidden': 'true' }, high ? '⚠️' : 'ℹ️'));
        banner.appendChild(el('div', { class: 'rb-text' },
            el('strong', { text: high ? t('rb_title_high') : t('rb_title_med') }),
            el('span', { text: (parts.join(' · ') || t('rb_p_other')) + ' — ' + t('rb_advice') })));
        const dismiss = el('button', { type: 'button', class: 'icon-btn', 'aria-label': t('close'), title: t('close') }, '✕');
        dismiss.addEventListener('click', () => { riskDismissed = true; banner.hidden = true; });
        banner.appendChild(el('div', { class: 'rb-actions' },
            el('a', { class: 'btn', href: '#/tool/threat-scan' }, '🔬 ' + t('rb_inspect')),
            el('a', { class: 'btn', href: '#/tool/defang' }, '🛡️ ' + t('rb_defang')),
            dismiss));
    }

    /* Re-runs after every change so the warning always matches the document
       currently in the workspace (defanging clears it). */
    async function refreshRisk() {
        const my = ++riskToken;
        if (!state.bytes) { lastRisk = null; renderRiskBanner(null); return; }
        if (state.bytes.length > 150 * 1024 * 1024) { renderRiskBanner(null); return; }
        try {
            const rep = await analyzePdf(state.bytes);
            if (my !== riskToken) return;
            lastRisk = rep;
            renderRiskBanner(rep);
        } catch (e) {
            if (my === riskToken) { lastRisk = null; renderRiskBanner(null); }
        }
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
    let previewOnScroll = null;

    async function renderPreview() {
        const host = $('#pv-pages');
        if (previewOnScroll) { host.removeEventListener('scroll', previewOnScroll); previewOnScroll = null; }
        host.textContent = '';
        $('#pv-zoom-label').textContent = Math.round(previewZoom * 100) + '%';
        if (!state.bytes) { $('#pv-count').textContent = ''; return; }
        const my = ++previewToken;
        try {
            const doc = await getDoc();
            if (my !== previewToken) return;
            $('#pv-count').textContent = t('pv_pages', { n: doc.numPages });
            // fits the panel at 100%; beyond that the panel scrolls sideways
            const width = Math.max(80, Math.min(560, (host.clientWidth || 320) - 32) * previewZoom);
            host.classList.toggle('is-zoomed', previewZoom > 1);
            // one page's shape is enough to reserve space for the rest
            const vp = (await doc.getPage(1)).getViewport({ scale: 1 });
            const ratio = vp.height / vp.width;

            const slots = [];
            for (let i = 0; i < doc.numPages; i++) {
                const slot = el('div', { class: 'pv-slot', dataset: { i: String(i) } });
                slot.style.width = Math.round(width) + 'px';
                slot.style.height = Math.round(width * ratio) + 'px';
                host.appendChild(slot);
                host.appendChild(el('div', { class: 'pv-num' }, String(i + 1) + ' / ' + doc.numPages));
                slots.push(slot);
            }

            const draw = (slot) => {
                if (slot.dataset.done) return;
                slot.dataset.done = '1';
                renderPage(doc, +slot.dataset.i, { targetWidth: width }).then(({ canvas }) => {
                    if (my !== previewToken) return;
                    slot.textContent = '';
                    slot.style.height = 'auto';
                    slot.appendChild(canvas);
                }).catch(() => { slot.classList.add('is-failed'); });
            };
            /* Only what is near the viewport gets drawn: rendering a 200-page
               document up front would freeze the panel for a long time. */
            const drawVisible = () => {
                const from = host.scrollTop - 400;
                const to = host.scrollTop + host.clientHeight + 400;
                for (const slot of slots) {
                    if (slot.dataset.done) continue;
                    if (slot.offsetTop <= to && slot.offsetTop + slot.offsetHeight >= from) draw(slot);
                }
            };

            let raf = 0;
            previewOnScroll = () => {
                if (raf) return;
                raf = requestAnimationFrame(() => { raf = 0; if (my === previewToken) drawVisible(); });
            };
            host.addEventListener('scroll', previewOnScroll);
            drawVisible();
        } catch (e) {
            host.appendChild(el('p', { class: 'hint', text: t('pv_failed') }));
        }
    }

    function openPreview() {
        if (!state.bytes) return;
        previewOpen = true;
        $('#preview').hidden = false;
        const btn = $('#ws-view');
        if (btn) btn.setAttribute('aria-pressed', 'true');
        renderPreview();
    }
    function closePreview() {
        previewOpen = false;
        previewToken++;
        const host = $('#pv-pages');
        if (previewOnScroll) { host.removeEventListener('scroll', previewOnScroll); previewOnScroll = null; }
        $('#preview').hidden = true;
        const btn = $('#ws-view');
        if (btn) btn.setAttribute('aria-pressed', 'false');
    }
    function togglePreview() { return previewOpen ? closePreview() : openPreview(); }

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
            const arr = [...fileList];
            if (o.multiple === false) {
                // single-slot picker: the newest choice replaces the old one
                files.length = 0;
                if (arr.length) files.push(arr[0]);
            } else {
                for (const f of arr) files.push(f);
            }
            redraw();
        }
        btn.addEventListener('click', () => inp.click());
        inp.addEventListener('change', () => { add([...inp.files]); inp.value = ''; });
        const accepts = (f) => {
            const a = o.accept || 'application/pdf,.pdf';
            if (a === '*/*') return true;
            const isPdf = /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
            const isImg = /^image\//.test(f.type) || /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(f.name);
            return (a.includes('pdf') && isPdf) || (a.includes('image') && isImg);
        };
        zone.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); zone.classList.add('is-over'); });
        zone.addEventListener('dragleave', () => zone.classList.remove('is-over'));
        zone.addEventListener('drop', (e) => {
            e.preventDefault(); e.stopPropagation(); zone.classList.remove('is-over');
            add([...e.dataTransfer.files].filter(accepts));
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
                    const zipBtn = el('button', { type: 'button', class: 'btn btn-primary' }, t('btn_download_all'));
                    zipBtn.addEventListener('click', async () => {
                        zipBtn.disabled = true;
                        const label = zipBtn.textContent;
                        zipBtn.textContent = t('working');
                        try {
                            const zip = await zipMake(files.map((f) => ({ name: f.name, data: f.bytes })));
                            download(zip, baseName(state.name || 'files') + '.zip', 'application/zip');
                        } catch (err) { toast(t('err_generic', { msg: (err && err.message) || String(err) }), 'err'); }
                        finally { zipBtn.disabled = false; zipBtn.textContent = label; }
                    });
                    card.appendChild(el('div', { class: 'btn-row', style: 'margin-top:.7rem' }, zipBtn));
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
                        el('button', { type: 'button', class: 'btn', onclick: openPreview }, '👁 ' + t('btn_view')),
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
        // a different document makes any result on screen meaningless
        document.addEventListener('pdfstudio:workspace', function h(e) {
            if (!document.body.contains(resultHost)) { document.removeEventListener('pdfstudio:workspace', h); return; }
            if (e.detail && e.detail.fresh) api.clear();
        });
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
                // builders may be async — surface their failures instead of dying silently
                Promise.resolve(buildTool(body)).catch((err) => {
                    console.error(err);
                    body.appendChild(el('p', { class: 'error', text: t('err_generic', { msg: (err && err.message) || String(err) }) }));
                });
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

    /* favourites (pinned tools) */
    function getFavs() {
        try { return JSON.parse(localStorage.getItem('pdftools:favs') || '[]'); } catch (e) { return []; }
    }
    function toggleFav(id) {
        const favs = getFavs();
        const i = favs.indexOf(id);
        if (i >= 0) favs.splice(i, 1); else favs.push(id);
        try { localStorage.setItem('pdftools:favs', JSON.stringify(favs)); } catch (e) { /* ignore */ }
        buildNav();
        if (!currentToolId()) renderHome();
        return i < 0;
    }
    function favStar(toolId) {
        const isFav = getFavs().includes(toolId);
        const star = el('button', {
            type: 'button', class: 'fav-star' + (isFav ? ' is-fav' : ''),
            'aria-pressed': String(isFav), title: t('fav_toggle'), 'aria-label': t('fav_toggle'),
        }, isFav ? '★' : '☆');
        star.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            const nowFav = toggleFav(toolId);
            star.textContent = nowFav ? '★' : '☆';
            star.classList.toggle('is-fav', nowFav);
            star.setAttribute('aria-pressed', String(nowFav));
        });
        return star;
    }

    function buildNav() {
        const nav = $('#side-nav');
        nav.textContent = '';
        const favs = getFavs();
        const addItem = (tool) => {
            nav.appendChild(el('a', {
                class: 'side-item', href: '#/tool/' + tool.id, dataset: { tool: tool.id },
                onclick: () => { $('#side').classList.remove('is-open'); $('#nav-toggle').setAttribute('aria-expanded', 'false'); },
            }, el('span', { class: 't-ico', 'aria-hidden': 'true' }, tool.icon), el('span', { text: t('t_' + tool.key) })));
        };
        const favTools = favs.map((id) => tools.find((x) => x.id === id)).filter(Boolean);
        if (favTools.length) {
            nav.appendChild(el('div', { class: 'side-cat', dataset: { cat: 'favs' } }, '★ ' + t('cat_favs')));
            favTools.forEach(addItem);
        }
        for (const cat of CATS) {
            const items = tools.filter((x) => x.cat === cat);
            if (!items.length) continue;
            nav.appendChild(el('div', { class: 'side-cat', dataset: { cat } }, t('cat_' + cat)));
            items.forEach(addItem);
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
            if (!tool) return;
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

        const card = (tool) => {
            const a = el('a', { class: 'tool-card', href: '#/tool/' + tool.id },
                el('span', { class: 't-ico', 'aria-hidden': 'true' }, tool.icon),
                el('strong', { text: t('t_' + tool.key) }),
                el('small', { text: t('t_' + tool.key + '_d') }));
            a.appendChild(favStar(tool.id));
            return a;
        };
        const favTools = getFavs().map((id) => tools.find((x) => x.id === id)).filter(Boolean);
        if (favTools.length) {
            view.appendChild(el('h2', { class: 'home-cat', text: '★ ' + t('cat_favs') }));
            const grid = el('div', { class: 'tool-grid' });
            favTools.forEach((tool) => grid.appendChild(card(tool)));
            view.appendChild(grid);
        }
        for (const cat of CATS) {
            const items = tools.filter((x) => x.cat === cat);
            if (!items.length) continue;
            view.appendChild(el('h2', { class: 'home-cat', text: t('cat_' + cat) }));
            const grid = el('div', { class: 'tool-grid' });
            items.forEach((tool) => grid.appendChild(card(tool)));
            view.appendChild(grid);
        }
    }

    function renderTool(tool) {
        const view = $('#view');
        view.textContent = '';
        view.appendChild(el('a', { class: 'back-link', href: '#/' }, '← ' + t('btn_back')));
        const head = el('div', { class: 'tool-head' },
            el('span', { class: 't-ico', 'aria-hidden': 'true' }, tool.icon),
            el('div', {},
                el('h1', { text: t('t_' + tool.key) }),
                el('p', { text: t('t_' + tool.key + '_d') })));
        head.appendChild(favStar(tool.id));
        view.appendChild(head);
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
                renderRiskBanner(lastRisk);
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
        $('#ws-open-preview').addEventListener('click', togglePreview);
        $('#ws-view').addEventListener('click', togglePreview);
        $('#pv-close').addEventListener('click', closePreview);
        $('#pv-zoom-in').addEventListener('click', () => { previewZoom = Math.min(3, previewZoom + 0.25); renderPreview(); });
        $('#pv-zoom-out').addEventListener('click', () => { previewZoom = Math.max(0.5, previewZoom - 0.25); renderPreview(); });
        $('#modal-close').addEventListener('click', () => $('#modal').close());

        document.addEventListener('keydown', (e) => {
            const tag = (e.target.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
            if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
            else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); redo(); }
            else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); $('#file-global').click(); }
            else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && state.bytes) { e.preventDefault(); download(state.bytes, state.name, 'application/pdf'); }
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
            else if (e.dataTransfer.files.length) toast(t('err_badpdf'), 'err');
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
        openPreview, closePreview, togglePreview,
        getDoc, pdfjsDocFor, renderPage, replacePagesWithImages,
        parseRanges, download, zipMake, zipRead, crc32, fmtSize, toast,
        deflateRaw, inflateRaw, inflateZlib, aesEncrypt, aesDecrypt, cryptoOk,
        analyzePdf, defangUrl, classifyUrl, sha256Hex, refreshRisk,
        get lastRisk() { return lastRisk; },
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
