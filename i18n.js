/* =============================================================================
   PDF Studio — localisation layer (EN / FR / NL)

   Load order: i18n.js → app.js → tools.js

   Picks the active language (?lang= → saved choice → browser → English),
   holds every interface string, applies them to [data-i18n*] elements and
   lets app.js re-apply everything live when the language changes.
   Mirrors the pattern used by md.labidi.eu / library.labidi.eu.
   ========================================================================== */
const PDFI18N = (function () {
    'use strict';

    const LANGS = ['en', 'fr', 'nl'];
    const STORE_KEY = 'pdftools:lang';

    /* ---------------------------------------------------------------- EN -- */
    const en = {
        lang_name: 'English',
        lang_label: 'Language',

        app_title: 'PDF Studio · Local PDF toolbox',
        app_desc: 'Merge, split, compress, convert, OCR, sign, watermark and protect PDFs — 40+ tools running fully in your browser. No uploads, no tracking, works offline.',
        brand_sub: 'local · private · offline',
        nav_tools: 'Tools',
        search_tools: 'Search tools…',
        no_results: 'No tool matches your search.',
        theme_toggle: 'Light / dark theme',
        close: 'Close',

        as_switch: 'Switch project',
        as_note: 'Code editor',
        as_md: 'Markdown editor',
        as_todo: 'Notes & tasks',
        as_all: 'All projects',

        ws_preview: 'Preview the current document',
        ws_undo: 'Undo',
        ws_redo: 'Redo',
        ws_download: 'Download the current document',
        ws_close: 'Close file',
        ws_pages: '{n} p',
        ws_confirm_close: 'Close the current document? Unsaved changes will be lost.',
        pv_title: 'Preview',

        drop_hint: 'Drop your PDF anywhere',
        foot_privacy: 'Every operation runs in your browser. Files never leave your device.',

        home_h1: 'Every PDF tool, right on this device',
        home_lead: 'Open a PDF once, then chain any tool: the result of each step becomes the working copy, with full undo. Nothing is ever uploaded — this page even works offline.',
        up_title: 'Open a PDF',
        up_hint: 'Click to browse, or drop a file anywhere on the page',
        home_all_tools: 'All tools',

        cat_organize: 'Pages & organisation',
        cat_convert: 'Convert & extract',
        cat_security: 'Security & signing',
        cat_edit: 'Edit & optimise',
        cat_advanced: 'Inspect & advanced',

        /* generic tool UI */
        need_ws: 'This tool works on the current document. Open a PDF first — drop one anywhere or use the box below.',
        open_here: 'Open a PDF',
        current_doc: 'Current document',
        btn_run: 'Run',
        btn_apply: 'Apply',
        btn_download: 'Download',
        btn_download_all: 'Download all (ZIP)',
        btn_add_files: 'Add files…',
        btn_choose: 'Choose file…',
        btn_copy: 'Copy',
        btn_clear: 'Clear',
        btn_select_all: 'All',
        btn_select_none: 'None',
        btn_back: 'All tools',
        working: 'Working…',
        res_ready: 'Done — your files are ready',
        res_applied: 'Applied to the working copy — use ↶ to undo.',
        err_generic: 'Something went wrong: {msg}',
        err_badpdf: 'This file could not be read as a PDF.',
        err_needpw: 'This PDF is password-protected.',
        enter_pw: 'Password for {name}',
        pw_wrong: 'Wrong password, try again.',
        unlock_btn: 'Unlock',
        toast_loaded: 'Loaded {name}',
        toast_applied: 'Working copy updated',
        toast_undo: 'Undone',
        toast_redo: 'Redone',
        toast_copied: 'Copied to clipboard',
        pages_of: '{n} pages · {size}',

        opt_pages: 'Pages',
        hint_pages: 'e.g. 1-3, 5, 8- (empty = all pages)',
        opt_quality: 'Quality',
        opt_dpi: 'Resolution (DPI)',
        opt_format: 'Format',
        opt_password: 'Password',
        opt_text: 'Text',
        opt_fontsize: 'Font size',
        opt_color: 'Colour',
        opt_opacity: 'Opacity',
        opt_angle: 'Angle',
        opt_position: 'Position',
        opt_margin: 'Margin',
        opt_pagesize: 'Page size',
        keep_size: 'Keep original size',
        pos_tl: 'Top left', pos_tc: 'Top centre', pos_tr: 'Top right',
        pos_bl: 'Bottom left', pos_bc: 'Bottom centre', pos_br: 'Bottom right',
        pos_c: 'Centre',
        page_n: 'Page {n}',

        /* tools: organize */
        t_merge: 'Merge PDFs',
        t_merge_d: 'Combine several PDFs into a single file.',
        merge_hint: 'Drag files to reorder — they are joined top to bottom.',
        merge_need2: 'Add at least two PDF files.',
        merge_use_ws: 'The current document is included as the first file.',

        t_split: 'Split PDF',
        t_split_d: 'Cut one PDF into several files.',
        split_mode: 'Split by',
        split_ranges: 'Custom ranges',
        split_every: 'Every N pages',
        split_bookmarks: 'Top-level bookmarks',
        split_ranges_hint: 'Separate parts with ; — e.g. “1-3; 4-6; 7-”. Empty = one file per page.',
        split_every_n: 'Pages per part',
        split_no_bm: 'This PDF has no bookmarks.',
        split_parts: '{n} parts created',

        t_organize: 'Organise pages',
        t_organize_d: 'Reorder, rotate, duplicate or delete pages visually.',
        org_hint: 'Drag pages to reorder them. Tap pages to select, then use the buttons.',
        org_rotate: 'Rotate 90°',
        org_dup: 'Duplicate',
        org_del: 'Delete',
        org_reverse: 'Reverse all',
        org_selected: '{n} selected',
        org_empty: 'You removed every page — nothing to save.',

        t_rotate: 'Rotate pages',
        t_rotate_d: 'Turn pages by 90, 180 or 270 degrees.',

        t_removepages: 'Remove pages',
        t_removepages_d: 'Delete chosen pages from the document.',
        rm_label: 'Pages to remove',
        rm_all_err: 'You cannot remove every page.',

        t_extract: 'Extract pages',
        t_extract_d: 'Keep only chosen pages as a new PDF.',
        ex_label: 'Pages to keep',

        t_removeblank: 'Remove blank pages',
        t_removeblank_d: 'Detect and delete empty pages automatically.',
        rb_sens: 'Sensitivity',
        rb_sens_hint: 'Higher removes pages with faint specks or scanner noise.',
        rb_scan: 'Scan for blank pages',
        rb_found: 'Blank pages found: {list}',
        rb_none: 'No blank pages detected.',
        rb_remove: 'Remove them',

        t_crop: 'Crop pages',
        t_crop_d: 'Trim the margins of every page.',
        crop_hint: 'Drag on the preview to draw the crop area, or type margins in points.',
        crop_t: 'Top', crop_r: 'Right', crop_b: 'Bottom', crop_l: 'Left',
        crop_reset: 'Reset',

        t_splithalf: 'Split pages in half',
        t_splithalf_d: 'Cut each page into two — great for two-up scans.',
        sh_dir: 'Direction',
        sh_v: 'Vertical (left | right)',
        sh_h: 'Horizontal (top | bottom)',

        t_scale: 'Scale pages',
        t_scale_d: 'Change the paper size or scale the content.',
        sc_target: 'Target size',
        sc_content: 'Content scale',

        t_nup: 'Multi-page layout',
        t_nup_d: 'Place 2, 4, 9 or 16 pages on one sheet.',
        nup_per: 'Pages per sheet',
        nup_border: 'Draw borders around pages',

        t_booklet: 'Booklet',
        t_booklet_d: 'Reorder and pair pages for saddle-stitch printing.',
        bk_hint: 'Print the result double-sided (flip on short edge), fold, staple.',

        t_pagenums: 'Add page numbers',
        t_pagenums_d: 'Stamp page numbers in any corner.',
        pn_start: 'First number',
        pn_fmt: 'Format',
        pn_fmt_n: '1', pn_fmt_of: '1 / N', pn_fmt_page: 'Page 1', pn_fmt_pageof: 'Page 1 of N',

        /* tools: convert */
        t_img2pdf: 'Images to PDF',
        t_img2pdf_d: 'Turn JPG, PNG, WebP or GIF images into a PDF.',
        i2p_add: 'Add images…',
        i2p_size_auto: 'Fit page to image',
        i2p_margin: 'Margin',
        i2p_need: 'Add at least one image.',

        t_pdf2img: 'PDF to images',
        t_pdf2img_d: 'Export pages as PNG, JPEG or WebP pictures.',

        t_txt2pdf: 'Text / Markdown to PDF',
        t_txt2pdf_d: 'Type or paste text — headings, lists and code blocks understood.',
        t2p_text: 'Your text',
        t2p_md: 'Interpret Markdown (#, lists, ``` code, > quotes…)',
        t2p_font: 'Font',
        t2p_empty: 'Type some text first.',

        t_pdf2txt: 'PDF to text',
        t_pdf2txt_d: 'Extract all text into a .txt file.',
        p2t_marks: 'Insert page separators',
        p2t_none: 'No extractable text found — the document is probably scanned. Try the OCR tool.',

        t_pdf2html: 'PDF to HTML',
        t_pdf2html_d: 'Export the text content as a simple HTML page.',

        t_pdf2csv: 'PDF to CSV',
        t_pdf2csv_d: 'Best-effort table extraction into a CSV file.',
        p2c_hint: 'Works best on PDFs with clear, grid-like tables.',

        t_extractimg: 'Extract images',
        t_extractimg_d: 'Pull the pictures embedded in the PDF.',
        xi_none: 'No embedded images found.',

        t_ocr: 'OCR — recognise text',
        t_ocr_d: 'Make scanned PDFs searchable, or export recognised text.',
        ocr_langs: 'Document language(s)',
        ocr_out: 'Output',
        ocr_out_pdf: 'Searchable PDF (invisible text layer)',
        ocr_out_txt: 'Plain text (.txt)',
        ocr_first: 'The first run loads the OCR engine (≈4 MB) and language data from this site; afterwards it also works offline.',
        ocr_page: 'Recognising page {i} / {n}…',
        ocr_none: 'Pick at least one language.',

        t_flattenpdf: 'Flatten',
        t_flattenpdf_d: 'Make form fields and annotations part of the page.',
        fl_forms: 'Flatten form fields',
        fl_annots: 'Flatten annotations too (converts pages to images)',

        /* tools: security */
        t_protect: 'Protect (password)',
        t_protect_d: 'Encrypt the PDF with a password.',
        pr_user: 'Password to open the document',
        pr_owner: 'Owner password (optional)',
        pr_hint: 'The owner password only limits editing/printing rights.',
        pr_empty: 'Enter a password.',

        t_unlock: 'Remove password',
        t_unlock_d: 'Save a decrypted copy of a protected PDF.',
        ul_file: 'Protected PDF',
        ul_pw: 'Current password',
        ul_note: 'You need the password — this does not crack unknown passwords.',

        t_permissions: 'Change permissions',
        t_permissions_d: 'Allow or forbid printing, copying and editing.',
        pm_owner_req: 'Owner password (required to enforce)',
        pm_print: 'Allow printing',
        pm_copy: 'Allow copying text & images',
        pm_modify: 'Allow editing content',
        pm_annot: 'Allow comments & form filling',

        t_watermark: 'Watermark',
        t_watermark_d: 'Stamp text or an image across the pages.',
        wm_type_text: 'Text', wm_type_img: 'Image',
        wm_tile: 'Repeat across the page',
        wm_img: 'Watermark image',

        t_sign: 'Sign & stamp',
        t_sign_d: 'Draw, type or upload a signature and place it on the page.',
        sg_draw: 'Draw', sg_type: 'Type', sg_upload: 'Image',
        sg_type_ph: 'Type your name…',
        sg_place_hint: 'Drag the signature into place; use the round handle to resize.',
        sg_none: 'Create a signature first (draw, type or upload).',
        sg_add: 'Place on page',

        t_redact: 'Redact',
        t_redact_d: 'Black out sensitive content — permanently.',
        rd_mode_draw: 'Draw boxes',
        rd_mode_search: 'Find text',
        rd_term: 'Text to find',
        rd_case: 'Match case',
        rd_hits: '{n} matches found',
        rd_nohits: 'No matches found.',
        rd_draw_hint: 'Drag on the page to draw boxes over what must disappear.',
        rd_note: 'Redacted pages are converted to images, so the hidden content is truly gone.',
        rd_none: 'No redaction boxes yet.',
        rd_boxes: '{n} boxes on {p} pages',

        t_sanitize: 'Sanitise',
        t_sanitize_d: 'Strip scripts, attachments, metadata and hidden data.',
        sz_js: 'Remove JavaScript',
        sz_att: 'Remove embedded files',
        sz_meta: 'Remove metadata',
        sz_links: 'Remove external links',
        sz_annots: 'Remove all annotations',

        /* tools: edit */
        t_metadata: 'Edit metadata',
        t_metadata_d: 'View and change title, author, keywords…',
        md_title: 'Title', md_author: 'Author', md_subject: 'Subject',
        md_keywords: 'Keywords', md_creator: 'Creator', md_producer: 'Producer',
        md_wipe: 'Remove all metadata instead',

        t_addimage: 'Add image',
        t_addimage_d: 'Place a picture, logo or stamp on a page.',
        ai_img: 'Image (JPG, PNG, WebP…)',

        t_removeannots: 'Remove annotations',
        t_removeannots_d: 'Delete comments, highlights and links.',
        ra_keep_links: 'Keep hyperlinks',

        t_fillform: 'Fill form',
        t_fillform_d: 'Fill in the PDF’s form fields.',
        ff_none: 'This PDF contains no form fields.',
        ff_flatten: 'Flatten after filling (fields become plain content)',
        ff_fields: '{n} fields found',

        t_compress: 'Compress',
        t_compress_d: 'Shrink the file by recompressing images.',
        cp_mode_img: 'Recompress images (text stays sharp)',
        cp_mode_raster: 'Rasterise pages (max reduction, text becomes image)',
        cp_gray: 'Convert to grayscale',
        cp_res: '{a} → {b} ({p} smaller)',
        cp_nores: 'No further reduction achieved ({a} → {b}). The file is already tight.',

        t_colors: 'Adjust colours',
        t_colors_d: 'Grayscale, sepia or inverted colours for reading comfort.',
        ac_mode_gray: 'Grayscale', ac_mode_invert: 'Invert', ac_mode_sepia: 'Sepia',
        ac_note: 'Pages are converted to images with the new colours.',

        t_overlay: 'Overlay PDFs',
        t_overlay_d: 'Stamp one PDF over (or under) another — e.g. letterheads.',
        ov_file: 'Overlay PDF',
        ov_fg: 'On top of the page', ov_bg: 'Behind the page',
        ov_repeat: 'Repeat the overlay’s last page if it is shorter',

        t_attach: 'Attachments',
        t_attach_d: 'Embed files into the PDF, or extract them.',
        at_add: 'Attach files…',
        at_list: 'Files inside this PDF',
        at_none: 'No attachments in this PDF.',

        /* tools: advanced */
        t_compare: 'Compare PDFs',
        t_compare_d: 'See text differences between two versions.',
        cm_a: 'Original', cm_b: 'Revised',
        cm_run: 'Compare',
        cm_same: 'The extractable text is identical.',
        cm_legend: 'Red = removed, green = added.',

        t_info: 'Document info',
        t_info_d: 'Pages, sizes, metadata, encryption, fonts and more.',
        info_pages: 'Pages', info_size: 'File size', info_dims: 'Page sizes',
        info_enc: 'Encrypted', info_form: 'Form fields', info_js: 'JavaScript entries',
        info_att: 'Attachments', info_fonts: 'Fonts', info_images: 'Images',
        info_version: 'PDF version',
        yes: 'yes', no: 'no',

        t_showjs: 'Show JavaScript',
        t_showjs_d: 'Reveal scripts embedded in the document.',
        sj_none: 'No JavaScript found in this PDF. ✓',
        sj_strip: 'Remove all JavaScript',

        t_repair: 'Repair',
        t_repair_d: 'Rebuild a broken or bloated PDF structure.',
        rp_note: 'The file is parsed leniently and rewritten with a clean structure. Fixes many “cannot open” PDFs.',

        t_scanner: 'Scanner effect',
        t_scanner_d: 'Make a clean PDF look like it was scanned.',
        scn_rot: 'Slight random rotation',
        scn_noise: 'Noise',
        scn_gray: 'Grayscale',

        t_rename: 'Smart rename',
        t_rename_d: 'Suggest a filename from the document’s content.',
        ar_suggest: 'Suggested name',
        ar_none: 'Not enough text to suggest a name.',
        ar_use: 'Use this name',
    };

    /* ---------------------------------------------------------------- FR -- */
    const fr = {
        lang_name: 'Français',
        lang_label: 'Langue',

        app_title: 'PDF Studio · Boîte à outils PDF locale',
        app_desc: 'Fusionnez, divisez, compressez, convertissez, océrisez, signez et protégez vos PDF — plus de 40 outils qui tournent entièrement dans votre navigateur. Aucun envoi, aucun traçage, fonctionne hors ligne.',
        brand_sub: 'local · privé · hors ligne',
        nav_tools: 'Outils',
        search_tools: 'Rechercher un outil…',
        no_results: 'Aucun outil ne correspond à votre recherche.',
        theme_toggle: 'Thème clair / sombre',
        close: 'Fermer',

        as_switch: 'Changer de projet',
        as_note: 'Éditeur de code',
        as_md: 'Éditeur Markdown',
        as_todo: 'Notes et tâches',
        as_all: 'Tous les projets',

        ws_preview: 'Aperçu du document actuel',
        ws_undo: 'Annuler',
        ws_redo: 'Rétablir',
        ws_download: 'Télécharger le document actuel',
        ws_close: 'Fermer le fichier',
        ws_pages: '{n} p',
        ws_confirm_close: 'Fermer le document actuel ? Les modifications non enregistrées seront perdues.',
        pv_title: 'Aperçu',

        drop_hint: 'Déposez votre PDF n’importe où',
        foot_privacy: 'Chaque opération s’exécute dans votre navigateur. Vos fichiers ne quittent jamais votre appareil.',

        home_h1: 'Tous les outils PDF, directement sur cet appareil',
        home_lead: 'Ouvrez un PDF une fois, puis enchaînez les outils : le résultat de chaque étape devient la copie de travail, avec annulation complète. Rien n’est jamais envoyé — cette page fonctionne même hors ligne.',
        up_title: 'Ouvrir un PDF',
        up_hint: 'Cliquez pour parcourir, ou déposez un fichier n’importe où sur la page',
        home_all_tools: 'Tous les outils',

        cat_organize: 'Pages et organisation',
        cat_convert: 'Convertir et extraire',
        cat_security: 'Sécurité et signature',
        cat_edit: 'Modifier et optimiser',
        cat_advanced: 'Inspecter et avancé',

        need_ws: 'Cet outil agit sur le document actuel. Ouvrez d’abord un PDF — déposez-le n’importe où ou utilisez la zone ci-dessous.',
        open_here: 'Ouvrir un PDF',
        current_doc: 'Document actuel',
        btn_run: 'Lancer',
        btn_apply: 'Appliquer',
        btn_download: 'Télécharger',
        btn_download_all: 'Tout télécharger (ZIP)',
        btn_add_files: 'Ajouter des fichiers…',
        btn_choose: 'Choisir un fichier…',
        btn_copy: 'Copier',
        btn_clear: 'Effacer',
        btn_select_all: 'Tout',
        btn_select_none: 'Aucun',
        btn_back: 'Tous les outils',
        working: 'Traitement…',
        res_ready: 'Terminé — vos fichiers sont prêts',
        res_applied: 'Appliqué à la copie de travail — utilisez ↶ pour annuler.',
        err_generic: 'Une erreur est survenue : {msg}',
        err_badpdf: 'Ce fichier n’a pas pu être lu comme un PDF.',
        err_needpw: 'Ce PDF est protégé par un mot de passe.',
        enter_pw: 'Mot de passe pour {name}',
        pw_wrong: 'Mot de passe incorrect, réessayez.',
        unlock_btn: 'Déverrouiller',
        toast_loaded: '{name} chargé',
        toast_applied: 'Copie de travail mise à jour',
        toast_undo: 'Annulé',
        toast_redo: 'Rétabli',
        toast_copied: 'Copié dans le presse-papiers',
        pages_of: '{n} pages · {size}',

        opt_pages: 'Pages',
        hint_pages: 'ex. 1-3, 5, 8- (vide = toutes les pages)',
        opt_quality: 'Qualité',
        opt_dpi: 'Résolution (DPI)',
        opt_format: 'Format',
        opt_password: 'Mot de passe',
        opt_text: 'Texte',
        opt_fontsize: 'Taille de police',
        opt_color: 'Couleur',
        opt_opacity: 'Opacité',
        opt_angle: 'Angle',
        opt_position: 'Position',
        opt_margin: 'Marge',
        opt_pagesize: 'Taille de page',
        keep_size: 'Conserver la taille d’origine',
        pos_tl: 'Haut gauche', pos_tc: 'Haut centre', pos_tr: 'Haut droite',
        pos_bl: 'Bas gauche', pos_bc: 'Bas centre', pos_br: 'Bas droite',
        pos_c: 'Centre',
        page_n: 'Page {n}',

        t_merge: 'Fusionner des PDF',
        t_merge_d: 'Combinez plusieurs PDF en un seul fichier.',
        merge_hint: 'Glissez les fichiers pour les réordonner — ils sont assemblés de haut en bas.',
        merge_need2: 'Ajoutez au moins deux fichiers PDF.',
        merge_use_ws: 'Le document actuel est inclus comme premier fichier.',

        t_split: 'Diviser un PDF',
        t_split_d: 'Découpez un PDF en plusieurs fichiers.',
        split_mode: 'Diviser par',
        split_ranges: 'Plages personnalisées',
        split_every: 'Toutes les N pages',
        split_bookmarks: 'Signets de premier niveau',
        split_ranges_hint: 'Séparez les parties par ; — ex. « 1-3; 4-6; 7- ». Vide = un fichier par page.',
        split_every_n: 'Pages par partie',
        split_no_bm: 'Ce PDF ne contient pas de signets.',
        split_parts: '{n} parties créées',

        t_organize: 'Organiser les pages',
        t_organize_d: 'Réordonnez, tournez, dupliquez ou supprimez les pages visuellement.',
        org_hint: 'Glissez les pages pour les réordonner. Touchez-les pour les sélectionner, puis utilisez les boutons.',
        org_rotate: 'Tourner 90°',
        org_dup: 'Dupliquer',
        org_del: 'Supprimer',
        org_reverse: 'Inverser tout',
        org_selected: '{n} sélectionnée(s)',
        org_empty: 'Vous avez supprimé toutes les pages — rien à enregistrer.',

        t_rotate: 'Tourner les pages',
        t_rotate_d: 'Faites pivoter les pages de 90, 180 ou 270 degrés.',

        t_removepages: 'Supprimer des pages',
        t_removepages_d: 'Retirez les pages choisies du document.',
        rm_label: 'Pages à supprimer',
        rm_all_err: 'Impossible de supprimer toutes les pages.',

        t_extract: 'Extraire des pages',
        t_extract_d: 'Ne gardez que les pages choisies dans un nouveau PDF.',
        ex_label: 'Pages à conserver',

        t_removeblank: 'Supprimer les pages vides',
        t_removeblank_d: 'Détectez et supprimez automatiquement les pages vides.',
        rb_sens: 'Sensibilité',
        rb_sens_hint: 'Plus élevé : supprime aussi les pages avec de légères traces de scan.',
        rb_scan: 'Rechercher les pages vides',
        rb_found: 'Pages vides trouvées : {list}',
        rb_none: 'Aucune page vide détectée.',
        rb_remove: 'Les supprimer',

        t_crop: 'Rogner les pages',
        t_crop_d: 'Réduisez les marges de toutes les pages.',
        crop_hint: 'Dessinez la zone sur l’aperçu, ou saisissez les marges en points.',
        crop_t: 'Haut', crop_r: 'Droite', crop_b: 'Bas', crop_l: 'Gauche',
        crop_reset: 'Réinitialiser',

        t_splithalf: 'Couper les pages en deux',
        t_splithalf_d: 'Coupez chaque page en deux — idéal pour les scans à deux pages.',
        sh_dir: 'Direction',
        sh_v: 'Verticale (gauche | droite)',
        sh_h: 'Horizontale (haut | bas)',

        t_scale: 'Redimensionner les pages',
        t_scale_d: 'Changez le format du papier ou l’échelle du contenu.',
        sc_target: 'Format cible',
        sc_content: 'Échelle du contenu',

        t_nup: 'Mise en page multiple',
        t_nup_d: 'Placez 2, 4, 9 ou 16 pages sur une feuille.',
        nup_per: 'Pages par feuille',
        nup_border: 'Tracer un cadre autour des pages',

        t_booklet: 'Livret',
        t_booklet_d: 'Réordonnez les pages pour une impression en livret agrafé.',
        bk_hint: 'Imprimez recto-verso (retourner sur le bord court), pliez, agrafez.',

        t_pagenums: 'Numéroter les pages',
        t_pagenums_d: 'Ajoutez des numéros de page dans le coin voulu.',
        pn_start: 'Premier numéro',
        pn_fmt: 'Format',
        pn_fmt_n: '1', pn_fmt_of: '1 / N', pn_fmt_page: 'Page 1', pn_fmt_pageof: 'Page 1 sur N',

        t_img2pdf: 'Images en PDF',
        t_img2pdf_d: 'Transformez des images JPG, PNG, WebP ou GIF en PDF.',
        i2p_add: 'Ajouter des images…',
        i2p_size_auto: 'Adapter la page à l’image',
        i2p_margin: 'Marge',
        i2p_need: 'Ajoutez au moins une image.',

        t_pdf2img: 'PDF en images',
        t_pdf2img_d: 'Exportez les pages en images PNG, JPEG ou WebP.',

        t_txt2pdf: 'Texte / Markdown en PDF',
        t_txt2pdf_d: 'Tapez ou collez du texte — titres, listes et blocs de code compris.',
        t2p_text: 'Votre texte',
        t2p_md: 'Interpréter le Markdown (#, listes, ``` code, > citations…)',
        t2p_font: 'Police',
        t2p_empty: 'Saisissez d’abord du texte.',

        t_pdf2txt: 'PDF en texte',
        t_pdf2txt_d: 'Extrayez tout le texte dans un fichier .txt.',
        p2t_marks: 'Insérer des séparateurs de page',
        p2t_none: 'Aucun texte extractible — le document est sans doute scanné. Essayez l’outil OCR.',

        t_pdf2html: 'PDF en HTML',
        t_pdf2html_d: 'Exportez le contenu textuel en page HTML simple.',

        t_pdf2csv: 'PDF en CSV',
        t_pdf2csv_d: 'Extraction de tableaux (au mieux) vers un fichier CSV.',
        p2c_hint: 'Fonctionne mieux avec des tableaux bien alignés.',

        t_extractimg: 'Extraire les images',
        t_extractimg_d: 'Récupérez les images intégrées au PDF.',
        xi_none: 'Aucune image intégrée trouvée.',

        t_ocr: 'OCR — reconnaître le texte',
        t_ocr_d: 'Rendez les scans interrogeables, ou exportez le texte reconnu.',
        ocr_langs: 'Langue(s) du document',
        ocr_out: 'Sortie',
        ocr_out_pdf: 'PDF interrogeable (couche de texte invisible)',
        ocr_out_txt: 'Texte brut (.txt)',
        ocr_first: 'Au premier lancement, le moteur OCR (≈4 Mo) et les données de langue sont chargés depuis ce site ; ensuite, tout fonctionne hors ligne.',
        ocr_page: 'Reconnaissance de la page {i} / {n}…',
        ocr_none: 'Choisissez au moins une langue.',

        t_flattenpdf: 'Aplatir',
        t_flattenpdf_d: 'Intégrez les champs de formulaire et annotations à la page.',
        fl_forms: 'Aplatir les champs de formulaire',
        fl_annots: 'Aplatir aussi les annotations (pages converties en images)',

        t_protect: 'Protéger (mot de passe)',
        t_protect_d: 'Chiffrez le PDF avec un mot de passe.',
        pr_user: 'Mot de passe d’ouverture',
        pr_owner: 'Mot de passe propriétaire (facultatif)',
        pr_hint: 'Le mot de passe propriétaire limite seulement les droits d’édition/impression.',
        pr_empty: 'Saisissez un mot de passe.',

        t_unlock: 'Retirer le mot de passe',
        t_unlock_d: 'Enregistrez une copie déchiffrée d’un PDF protégé.',
        ul_file: 'PDF protégé',
        ul_pw: 'Mot de passe actuel',
        ul_note: 'Le mot de passe est nécessaire — cet outil ne casse pas les mots de passe inconnus.',

        t_permissions: 'Modifier les permissions',
        t_permissions_d: 'Autorisez ou interdisez l’impression, la copie, l’édition.',
        pm_owner_req: 'Mot de passe propriétaire (requis)',
        pm_print: 'Autoriser l’impression',
        pm_copy: 'Autoriser la copie du texte et des images',
        pm_modify: 'Autoriser la modification du contenu',
        pm_annot: 'Autoriser commentaires et remplissage de formulaires',

        t_watermark: 'Filigrane',
        t_watermark_d: 'Apposez un texte ou une image sur les pages.',
        wm_type_text: 'Texte', wm_type_img: 'Image',
        wm_tile: 'Répéter sur toute la page',
        wm_img: 'Image du filigrane',

        t_sign: 'Signer et tamponner',
        t_sign_d: 'Dessinez, tapez ou importez une signature et placez-la sur la page.',
        sg_draw: 'Dessiner', sg_type: 'Taper', sg_upload: 'Image',
        sg_type_ph: 'Tapez votre nom…',
        sg_place_hint: 'Glissez la signature à sa place ; la poignée ronde sert à redimensionner.',
        sg_none: 'Créez d’abord une signature (dessin, texte ou image).',
        sg_add: 'Placer sur la page',

        t_redact: 'Caviarder',
        t_redact_d: 'Noircissez le contenu sensible — définitivement.',
        rd_mode_draw: 'Dessiner des zones',
        rd_mode_search: 'Rechercher du texte',
        rd_term: 'Texte à rechercher',
        rd_case: 'Respecter la casse',
        rd_hits: '{n} occurrences trouvées',
        rd_nohits: 'Aucune occurrence trouvée.',
        rd_draw_hint: 'Dessinez des rectangles sur ce qui doit disparaître.',
        rd_note: 'Les pages caviardées sont converties en images : le contenu masqué est réellement supprimé.',
        rd_none: 'Aucune zone de caviardage pour l’instant.',
        rd_boxes: '{n} zones sur {p} pages',

        t_sanitize: 'Assainir',
        t_sanitize_d: 'Supprimez scripts, pièces jointes, métadonnées et données cachées.',
        sz_js: 'Supprimer le JavaScript',
        sz_att: 'Supprimer les fichiers intégrés',
        sz_meta: 'Supprimer les métadonnées',
        sz_links: 'Supprimer les liens externes',
        sz_annots: 'Supprimer toutes les annotations',

        t_metadata: 'Modifier les métadonnées',
        t_metadata_d: 'Consultez et changez titre, auteur, mots-clés…',
        md_title: 'Titre', md_author: 'Auteur', md_subject: 'Sujet',
        md_keywords: 'Mots-clés', md_creator: 'Créateur', md_producer: 'Producteur',
        md_wipe: 'Plutôt tout effacer',

        t_addimage: 'Ajouter une image',
        t_addimage_d: 'Placez une image, un logo ou un tampon sur une page.',
        ai_img: 'Image (JPG, PNG, WebP…)',

        t_removeannots: 'Supprimer les annotations',
        t_removeannots_d: 'Effacez commentaires, surlignages et liens.',
        ra_keep_links: 'Conserver les hyperliens',

        t_fillform: 'Remplir un formulaire',
        t_fillform_d: 'Remplissez les champs de formulaire du PDF.',
        ff_none: 'Ce PDF ne contient aucun champ de formulaire.',
        ff_flatten: 'Aplatir après remplissage (les champs deviennent du contenu)',
        ff_fields: '{n} champs trouvés',

        t_compress: 'Compresser',
        t_compress_d: 'Réduisez la taille en recompressant les images.',
        cp_mode_img: 'Recompresser les images (le texte reste net)',
        cp_mode_raster: 'Rastériser les pages (réduction max, le texte devient image)',
        cp_gray: 'Convertir en niveaux de gris',
        cp_res: '{a} → {b} ({p} de moins)',
        cp_nores: 'Aucune réduction supplémentaire ({a} → {b}). Le fichier est déjà optimisé.',

        t_colors: 'Ajuster les couleurs',
        t_colors_d: 'Niveaux de gris, sépia ou couleurs inversées.',
        ac_mode_gray: 'Niveaux de gris', ac_mode_invert: 'Inverser', ac_mode_sepia: 'Sépia',
        ac_note: 'Les pages sont converties en images avec les nouvelles couleurs.',

        t_overlay: 'Superposer des PDF',
        t_overlay_d: 'Apposez un PDF sur (ou sous) un autre — ex. papier à en-tête.',
        ov_file: 'PDF à superposer',
        ov_fg: 'Au-dessus de la page', ov_bg: 'Derrière la page',
        ov_repeat: 'Répéter la dernière page de la superposition si elle est plus courte',

        t_attach: 'Pièces jointes',
        t_attach_d: 'Intégrez des fichiers au PDF, ou extrayez-les.',
        at_add: 'Joindre des fichiers…',
        at_list: 'Fichiers contenus dans ce PDF',
        at_none: 'Aucune pièce jointe dans ce PDF.',

        t_compare: 'Comparer des PDF',
        t_compare_d: 'Visualisez les différences de texte entre deux versions.',
        cm_a: 'Original', cm_b: 'Révisé',
        cm_run: 'Comparer',
        cm_same: 'Le texte extractible est identique.',
        cm_legend: 'Rouge = supprimé, vert = ajouté.',

        t_info: 'Infos du document',
        t_info_d: 'Pages, formats, métadonnées, chiffrement, polices et plus.',
        info_pages: 'Pages', info_size: 'Taille du fichier', info_dims: 'Formats de page',
        info_enc: 'Chiffré', info_form: 'Champs de formulaire', info_js: 'Entrées JavaScript',
        info_att: 'Pièces jointes', info_fonts: 'Polices', info_images: 'Images',
        info_version: 'Version PDF',
        yes: 'oui', no: 'non',

        t_showjs: 'Afficher le JavaScript',
        t_showjs_d: 'Révélez les scripts intégrés au document.',
        sj_none: 'Aucun JavaScript trouvé dans ce PDF. ✓',
        sj_strip: 'Supprimer tout le JavaScript',

        t_repair: 'Réparer',
        t_repair_d: 'Reconstruisez la structure d’un PDF endommagé ou alourdi.',
        rp_note: 'Le fichier est analysé avec tolérance puis réécrit proprement. Répare bien des PDF « impossibles à ouvrir ».',

        t_scanner: 'Effet scanner',
        t_scanner_d: 'Donnez à un PDF propre l’apparence d’un document scanné.',
        scn_rot: 'Légère rotation aléatoire',
        scn_noise: 'Bruit',
        scn_gray: 'Niveaux de gris',

        t_rename: 'Renommage intelligent',
        t_rename_d: 'Proposez un nom de fichier d’après le contenu du document.',
        ar_suggest: 'Nom proposé',
        ar_none: 'Pas assez de texte pour proposer un nom.',
        ar_use: 'Utiliser ce nom',
    };

    /* ---------------------------------------------------------------- NL -- */
    const nl = {
        lang_name: 'Nederlands',
        lang_label: 'Taal',

        app_title: 'PDF Studio · Lokale PDF-toolbox',
        app_desc: 'Voeg PDF’s samen, splits, comprimeer, converteer, herken tekst, onderteken en beveilig — meer dan 40 tools die volledig in je browser draaien. Geen uploads, geen tracking, werkt offline.',
        brand_sub: 'lokaal · privé · offline',
        nav_tools: 'Tools',
        search_tools: 'Tool zoeken…',
        no_results: 'Geen tool gevonden voor je zoekopdracht.',
        theme_toggle: 'Licht / donker thema',
        close: 'Sluiten',

        as_switch: 'Ander project kiezen',
        as_note: 'Code-editor',
        as_md: 'Markdown-editor',
        as_todo: 'Notities en taken',
        as_all: 'Alle projecten',

        ws_preview: 'Voorbeeld van het huidige document',
        ws_undo: 'Ongedaan maken',
        ws_redo: 'Opnieuw',
        ws_download: 'Huidig document downloaden',
        ws_close: 'Bestand sluiten',
        ws_pages: '{n} p',
        ws_confirm_close: 'Het huidige document sluiten? Niet-opgeslagen wijzigingen gaan verloren.',
        pv_title: 'Voorbeeld',

        drop_hint: 'Sleep je PDF hier eender waar naartoe',
        foot_privacy: 'Elke bewerking gebeurt in je browser. Bestanden verlaten je toestel nooit.',

        home_h1: 'Alle PDF-tools, gewoon op dit toestel',
        home_lead: 'Open één keer een PDF en schakel dan tools aan elkaar: het resultaat van elke stap wordt de werkkopie, met volledige ongedaan-maken-geschiedenis. Er wordt nooit iets geüpload — deze pagina werkt zelfs offline.',
        up_title: 'Een PDF openen',
        up_hint: 'Klik om te bladeren, of sleep een bestand eender waar op de pagina',
        home_all_tools: 'Alle tools',

        cat_organize: 'Pagina’s en indeling',
        cat_convert: 'Converteren en uitpakken',
        cat_security: 'Beveiliging en ondertekening',
        cat_edit: 'Bewerken en optimaliseren',
        cat_advanced: 'Inspecteren en geavanceerd',

        need_ws: 'Deze tool werkt op het huidige document. Open eerst een PDF — sleep er een binnen of gebruik het vak hieronder.',
        open_here: 'Een PDF openen',
        current_doc: 'Huidig document',
        btn_run: 'Uitvoeren',
        btn_apply: 'Toepassen',
        btn_download: 'Downloaden',
        btn_download_all: 'Alles downloaden (ZIP)',
        btn_add_files: 'Bestanden toevoegen…',
        btn_choose: 'Bestand kiezen…',
        btn_copy: 'Kopiëren',
        btn_clear: 'Wissen',
        btn_select_all: 'Alles',
        btn_select_none: 'Geen',
        btn_back: 'Alle tools',
        working: 'Bezig…',
        res_ready: 'Klaar — je bestanden staan klaar',
        res_applied: 'Toegepast op de werkkopie — gebruik ↶ om ongedaan te maken.',
        err_generic: 'Er ging iets mis: {msg}',
        err_badpdf: 'Dit bestand kon niet als PDF worden gelezen.',
        err_needpw: 'Deze PDF is beveiligd met een wachtwoord.',
        enter_pw: 'Wachtwoord voor {name}',
        pw_wrong: 'Verkeerd wachtwoord, probeer opnieuw.',
        unlock_btn: 'Ontgrendelen',
        toast_loaded: '{name} geladen',
        toast_applied: 'Werkkopie bijgewerkt',
        toast_undo: 'Ongedaan gemaakt',
        toast_redo: 'Opnieuw uitgevoerd',
        toast_copied: 'Gekopieerd naar het klembord',
        pages_of: '{n} pagina’s · {size}',

        opt_pages: 'Pagina’s',
        hint_pages: 'bv. 1-3, 5, 8- (leeg = alle pagina’s)',
        opt_quality: 'Kwaliteit',
        opt_dpi: 'Resolutie (DPI)',
        opt_format: 'Formaat',
        opt_password: 'Wachtwoord',
        opt_text: 'Tekst',
        opt_fontsize: 'Lettergrootte',
        opt_color: 'Kleur',
        opt_opacity: 'Dekking',
        opt_angle: 'Hoek',
        opt_position: 'Positie',
        opt_margin: 'Marge',
        opt_pagesize: 'Paginaformaat',
        keep_size: 'Oorspronkelijk formaat behouden',
        pos_tl: 'Linksboven', pos_tc: 'Middenboven', pos_tr: 'Rechtsboven',
        pos_bl: 'Linksonder', pos_bc: 'Middenonder', pos_br: 'Rechtsonder',
        pos_c: 'Midden',
        page_n: 'Pagina {n}',

        t_merge: 'PDF’s samenvoegen',
        t_merge_d: 'Combineer meerdere PDF’s tot één bestand.',
        merge_hint: 'Sleep bestanden om de volgorde te wijzigen — ze worden van boven naar onder samengevoegd.',
        merge_need2: 'Voeg minstens twee PDF-bestanden toe.',
        merge_use_ws: 'Het huidige document wordt als eerste bestand opgenomen.',

        t_split: 'PDF splitsen',
        t_split_d: 'Knip één PDF in meerdere bestanden.',
        split_mode: 'Splitsen op',
        split_ranges: 'Eigen bereiken',
        split_every: 'Elke N pagina’s',
        split_bookmarks: 'Bladwijzers (hoogste niveau)',
        split_ranges_hint: 'Scheid delen met ; — bv. “1-3; 4-6; 7-”. Leeg = één bestand per pagina.',
        split_every_n: 'Pagina’s per deel',
        split_no_bm: 'Deze PDF bevat geen bladwijzers.',
        split_parts: '{n} delen gemaakt',

        t_organize: 'Pagina’s ordenen',
        t_organize_d: 'Herschik, draai, dupliceer of verwijder pagina’s visueel.',
        org_hint: 'Sleep pagina’s om ze te herschikken. Tik om te selecteren en gebruik dan de knoppen.',
        org_rotate: '90° draaien',
        org_dup: 'Dupliceren',
        org_del: 'Verwijderen',
        org_reverse: 'Alles omkeren',
        org_selected: '{n} geselecteerd',
        org_empty: 'Je hebt alle pagina’s verwijderd — niets om op te slaan.',

        t_rotate: 'Pagina’s draaien',
        t_rotate_d: 'Draai pagina’s 90, 180 of 270 graden.',

        t_removepages: 'Pagina’s verwijderen',
        t_removepages_d: 'Haal gekozen pagina’s uit het document.',
        rm_label: 'Te verwijderen pagina’s',
        rm_all_err: 'Je kunt niet alle pagina’s verwijderen.',

        t_extract: 'Pagina’s uitpakken',
        t_extract_d: 'Bewaar alleen gekozen pagina’s als nieuwe PDF.',
        ex_label: 'Te behouden pagina’s',

        t_removeblank: 'Lege pagina’s verwijderen',
        t_removeblank_d: 'Spoor lege pagina’s automatisch op en verwijder ze.',
        rb_sens: 'Gevoeligheid',
        rb_sens_hint: 'Hoger: verwijdert ook pagina’s met lichte scanvlekjes.',
        rb_scan: 'Zoeken naar lege pagina’s',
        rb_found: 'Lege pagina’s gevonden: {list}',
        rb_none: 'Geen lege pagina’s gevonden.',
        rb_remove: 'Verwijder ze',

        t_crop: 'Pagina’s bijsnijden',
        t_crop_d: 'Snij de marges van elke pagina bij.',
        crop_hint: 'Teken het kader op het voorbeeld, of typ de marges in punten.',
        crop_t: 'Boven', crop_r: 'Rechts', crop_b: 'Onder', crop_l: 'Links',
        crop_reset: 'Herstellen',

        t_splithalf: 'Pagina’s halveren',
        t_splithalf_d: 'Knip elke pagina in twee — handig voor dubbele scans.',
        sh_dir: 'Richting',
        sh_v: 'Verticaal (links | rechts)',
        sh_h: 'Horizontaal (boven | onder)',

        t_scale: 'Pagina’s schalen',
        t_scale_d: 'Wijzig het papierformaat of schaal de inhoud.',
        sc_target: 'Doelformaat',
        sc_content: 'Schaal van de inhoud',

        t_nup: 'Meerdere pagina’s per blad',
        t_nup_d: 'Zet 2, 4, 9 of 16 pagina’s op één blad.',
        nup_per: 'Pagina’s per blad',
        nup_border: 'Kader rond elke pagina tekenen',

        t_booklet: 'Boekje',
        t_booklet_d: 'Herschik pagina’s voor geniet boekdrukwerk.',
        bk_hint: 'Druk dubbelzijdig af (omslaan over korte zijde), vouw en niet.',

        t_pagenums: 'Paginanummers toevoegen',
        t_pagenums_d: 'Zet paginanummers in de gewenste hoek.',
        pn_start: 'Eerste nummer',
        pn_fmt: 'Formaat',
        pn_fmt_n: '1', pn_fmt_of: '1 / N', pn_fmt_page: 'Pagina 1', pn_fmt_pageof: 'Pagina 1 van N',

        t_img2pdf: 'Afbeeldingen naar PDF',
        t_img2pdf_d: 'Maak een PDF van JPG-, PNG-, WebP- of GIF-afbeeldingen.',
        i2p_add: 'Afbeeldingen toevoegen…',
        i2p_size_auto: 'Pagina aan afbeelding aanpassen',
        i2p_margin: 'Marge',
        i2p_need: 'Voeg minstens één afbeelding toe.',

        t_pdf2img: 'PDF naar afbeeldingen',
        t_pdf2img_d: 'Exporteer pagina’s als PNG-, JPEG- of WebP-afbeeldingen.',

        t_txt2pdf: 'Tekst / Markdown naar PDF',
        t_txt2pdf_d: 'Typ of plak tekst — koppen, lijsten en codeblokken worden herkend.',
        t2p_text: 'Je tekst',
        t2p_md: 'Markdown interpreteren (#, lijsten, ``` code, > citaten…)',
        t2p_font: 'Lettertype',
        t2p_empty: 'Typ eerst wat tekst.',

        t_pdf2txt: 'PDF naar tekst',
        t_pdf2txt_d: 'Haal alle tekst eruit als .txt-bestand.',
        p2t_marks: 'Paginascheidingen invoegen',
        p2t_none: 'Geen tekst gevonden — het document is waarschijnlijk gescand. Probeer de OCR-tool.',

        t_pdf2html: 'PDF naar HTML',
        t_pdf2html_d: 'Exporteer de tekstinhoud als eenvoudige HTML-pagina.',

        t_pdf2csv: 'PDF naar CSV',
        t_pdf2csv_d: 'Tabellen (zo goed mogelijk) omzetten naar CSV.',
        p2c_hint: 'Werkt het best bij PDF’s met duidelijke, rasterachtige tabellen.',

        t_extractimg: 'Afbeeldingen uitpakken',
        t_extractimg_d: 'Haal de ingesloten afbeeldingen uit de PDF.',
        xi_none: 'Geen ingesloten afbeeldingen gevonden.',

        t_ocr: 'OCR — tekst herkennen',
        t_ocr_d: 'Maak gescande PDF’s doorzoekbaar, of exporteer de herkende tekst.',
        ocr_langs: 'Taal of talen van het document',
        ocr_out: 'Uitvoer',
        ocr_out_pdf: 'Doorzoekbare PDF (onzichtbare tekstlaag)',
        ocr_out_txt: 'Platte tekst (.txt)',
        ocr_first: 'Bij de eerste keer worden de OCR-engine (≈4 MB) en de taaldata vanaf deze site geladen; daarna werkt alles ook offline.',
        ocr_page: 'Pagina {i} / {n} wordt herkend…',
        ocr_none: 'Kies minstens één taal.',

        t_flattenpdf: 'Afvlakken',
        t_flattenpdf_d: 'Maak formuliervelden en annotaties deel van de pagina.',
        fl_forms: 'Formuliervelden afvlakken',
        fl_annots: 'Ook annotaties afvlakken (pagina’s worden afbeeldingen)',

        t_protect: 'Beveiligen (wachtwoord)',
        t_protect_d: 'Versleutel de PDF met een wachtwoord.',
        pr_user: 'Wachtwoord om het document te openen',
        pr_owner: 'Eigenaarswachtwoord (optioneel)',
        pr_hint: 'Het eigenaarswachtwoord beperkt alleen bewerken/afdrukken.',
        pr_empty: 'Voer een wachtwoord in.',

        t_unlock: 'Wachtwoord verwijderen',
        t_unlock_d: 'Sla een ontsleutelde kopie van een beveiligde PDF op.',
        ul_file: 'Beveiligde PDF',
        ul_pw: 'Huidig wachtwoord',
        ul_note: 'Je hebt het wachtwoord nodig — dit kraakt geen onbekende wachtwoorden.',

        t_permissions: 'Rechten wijzigen',
        t_permissions_d: 'Sta afdrukken, kopiëren en bewerken toe of verbied het.',
        pm_owner_req: 'Eigenaarswachtwoord (vereist)',
        pm_print: 'Afdrukken toestaan',
        pm_copy: 'Tekst en afbeeldingen kopiëren toestaan',
        pm_modify: 'Inhoud bewerken toestaan',
        pm_annot: 'Opmerkingen en formulieren invullen toestaan',

        t_watermark: 'Watermerk',
        t_watermark_d: 'Zet tekst of een afbeelding over de pagina’s.',
        wm_type_text: 'Tekst', wm_type_img: 'Afbeelding',
        wm_tile: 'Herhalen over de hele pagina',
        wm_img: 'Watermerkafbeelding',

        t_sign: 'Ondertekenen en stempelen',
        t_sign_d: 'Teken, typ of upload een handtekening en plaats ze op de pagina.',
        sg_draw: 'Tekenen', sg_type: 'Typen', sg_upload: 'Afbeelding',
        sg_type_ph: 'Typ je naam…',
        sg_place_hint: 'Sleep de handtekening op haar plaats; met het ronde handvat wijzig je de grootte.',
        sg_none: 'Maak eerst een handtekening (tekenen, typen of uploaden).',
        sg_add: 'Op de pagina plaatsen',

        t_redact: 'Zwartlakken',
        t_redact_d: 'Maak gevoelige inhoud zwart — definitief.',
        rd_mode_draw: 'Vakken tekenen',
        rd_mode_search: 'Tekst zoeken',
        rd_term: 'Te zoeken tekst',
        rd_case: 'Hoofdlettergevoelig',
        rd_hits: '{n} treffers gevonden',
        rd_nohits: 'Geen treffers gevonden.',
        rd_draw_hint: 'Teken rechthoeken over wat moet verdwijnen.',
        rd_note: 'Zwartgelakte pagina’s worden afbeeldingen, zodat de verborgen inhoud echt weg is.',
        rd_none: 'Nog geen zwartlakvakken.',
        rd_boxes: '{n} vakken op {p} pagina’s',

        t_sanitize: 'Opschonen',
        t_sanitize_d: 'Verwijder scripts, bijlagen, metadata en verborgen gegevens.',
        sz_js: 'JavaScript verwijderen',
        sz_att: 'Ingesloten bestanden verwijderen',
        sz_meta: 'Metadata verwijderen',
        sz_links: 'Externe links verwijderen',
        sz_annots: 'Alle annotaties verwijderen',

        t_metadata: 'Metadata bewerken',
        t_metadata_d: 'Bekijk en wijzig titel, auteur, trefwoorden…',
        md_title: 'Titel', md_author: 'Auteur', md_subject: 'Onderwerp',
        md_keywords: 'Trefwoorden', md_creator: 'Maker', md_producer: 'Producent',
        md_wipe: 'Liever alle metadata wissen',

        t_addimage: 'Afbeelding toevoegen',
        t_addimage_d: 'Plaats een afbeelding, logo of stempel op een pagina.',
        ai_img: 'Afbeelding (JPG, PNG, WebP…)',

        t_removeannots: 'Annotaties verwijderen',
        t_removeannots_d: 'Wis opmerkingen, markeringen en links.',
        ra_keep_links: 'Hyperlinks behouden',

        t_fillform: 'Formulier invullen',
        t_fillform_d: 'Vul de formuliervelden van de PDF in.',
        ff_none: 'Deze PDF bevat geen formuliervelden.',
        ff_flatten: 'Na het invullen afvlakken (velden worden gewone inhoud)',
        ff_fields: '{n} velden gevonden',

        t_compress: 'Comprimeren',
        t_compress_d: 'Verklein het bestand door afbeeldingen te hercomprimeren.',
        cp_mode_img: 'Afbeeldingen hercomprimeren (tekst blijft scherp)',
        cp_mode_raster: 'Pagina’s rasteren (maximale winst, tekst wordt afbeelding)',
        cp_gray: 'Omzetten naar grijstinten',
        cp_res: '{a} → {b} ({p} kleiner)',
        cp_nores: 'Geen extra winst ({a} → {b}). Het bestand is al compact.',

        t_colors: 'Kleuren aanpassen',
        t_colors_d: 'Grijstinten, sepia of omgekeerde kleuren voor leescomfort.',
        ac_mode_gray: 'Grijstinten', ac_mode_invert: 'Omkeren', ac_mode_sepia: 'Sepia',
        ac_note: 'Pagina’s worden afbeeldingen met de nieuwe kleuren.',

        t_overlay: 'PDF’s over elkaar leggen',
        t_overlay_d: 'Leg één PDF op (of onder) een andere — bv. briefpapier.',
        ov_file: 'Overlay-PDF',
        ov_fg: 'Bovenop de pagina', ov_bg: 'Achter de pagina',
        ov_repeat: 'Laatste pagina van de overlay herhalen als die korter is',

        t_attach: 'Bijlagen',
        t_attach_d: 'Sluit bestanden in de PDF in, of haal ze eruit.',
        at_add: 'Bestanden bijvoegen…',
        at_list: 'Bestanden in deze PDF',
        at_none: 'Geen bijlagen in deze PDF.',

        t_compare: 'PDF’s vergelijken',
        t_compare_d: 'Bekijk tekstverschillen tussen twee versies.',
        cm_a: 'Origineel', cm_b: 'Herziene versie',
        cm_run: 'Vergelijken',
        cm_same: 'De tekst is identiek.',
        cm_legend: 'Rood = verwijderd, groen = toegevoegd.',

        t_info: 'Documentinfo',
        t_info_d: 'Pagina’s, formaten, metadata, versleuteling, lettertypes en meer.',
        info_pages: 'Pagina’s', info_size: 'Bestandsgrootte', info_dims: 'Paginaformaten',
        info_enc: 'Versleuteld', info_form: 'Formuliervelden', info_js: 'JavaScript-items',
        info_att: 'Bijlagen', info_fonts: 'Lettertypes', info_images: 'Afbeeldingen',
        info_version: 'PDF-versie',
        yes: 'ja', no: 'nee',

        t_showjs: 'JavaScript tonen',
        t_showjs_d: 'Laat de scripts in het document zien.',
        sj_none: 'Geen JavaScript gevonden in deze PDF. ✓',
        sj_strip: 'Alle JavaScript verwijderen',

        t_repair: 'Repareren',
        t_repair_d: 'Herbouw de structuur van een kapotte of logge PDF.',
        rp_note: 'Het bestand wordt soepel ingelezen en netjes herschreven. Herstelt veel “niet te openen” PDF’s.',

        t_scanner: 'Scannereffect',
        t_scanner_d: 'Laat een strakke PDF eruitzien als een gescand document.',
        scn_rot: 'Lichte willekeurige rotatie',
        scn_noise: 'Ruis',
        scn_gray: 'Grijstinten',

        t_rename: 'Slim hernoemen',
        t_rename_d: 'Stel een bestandsnaam voor op basis van de inhoud.',
        ar_suggest: 'Voorgestelde naam',
        ar_none: 'Te weinig tekst om een naam voor te stellen.',
        ar_use: 'Deze naam gebruiken',
    };

    const DICTS = { en, fr, nl };

    /* --------------------------------------------------------- machinery -- */
    function detect() {
        try {
            const q = new URLSearchParams(location.search).get('lang');
            if (q && LANGS.includes(q)) { localStorage.setItem(STORE_KEY, q); return q; }
            const saved = localStorage.getItem(STORE_KEY);
            if (saved && LANGS.includes(saved)) return saved;
        } catch (e) { /* storage may be blocked */ }
        const nav = (navigator.languages || [navigator.language || 'en']).map((l) => String(l).slice(0, 2).toLowerCase());
        for (const l of nav) if (LANGS.includes(l)) return l;
        return 'en';
    }

    let current = detect();

    function t(key, vars) {
        let s = (DICTS[current] && DICTS[current][key]) || en[key] || key;
        if (vars) for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(String(vars[k]));
        return s;
    }

    function apply(root) {
        const scope = root || document;
        scope.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.getAttribute('data-i18n')); });
        scope.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.getAttribute('data-i18n-title')); });
        scope.querySelectorAll('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria'))); });
        scope.querySelectorAll('[data-i18n-content]').forEach((el) => { el.setAttribute('content', t(el.getAttribute('data-i18n-content'))); });
        scope.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder'))); });
        document.documentElement.lang = current;
        document.title = t('app_title');
    }

    function set(lang) {
        if (!LANGS.includes(lang)) return;
        current = lang;
        try { localStorage.setItem(STORE_KEY, lang); } catch (e) { /* ignore */ }
        apply();
        document.dispatchEvent(new CustomEvent('pdfstudio:lang', { detail: lang }));
    }

    return { t, set, apply, get lang() { return current; }, LANGS };
})();
