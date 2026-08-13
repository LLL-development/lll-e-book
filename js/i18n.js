/* ==========================================================================
   LLL-E-Book — i18n.js
   Lightweight UI translation engine (no dependencies). Loaded after
   storage.js and the renderers, before app.js. Translates the app's
   interface text only — book content is never translated. Missing
   translations fall back to English, then to the key itself.
   ========================================================================== */
(function () {
  'use strict';

  let currentCode = 'en';

  const languages = [
    { code: 'en', name: 'English' },
    { code: 'ja', name: '日本語' },
    { code: 'zh-Hans', name: '简体中文' },
    { code: 'zh-Hant', name: '繁體中文' },
    { code: 'ko', name: '한국어' },
    { code: 'ms', name: 'Bahasa Melayu' }
  ];

  /* ---------------- dictionaries ---------------- */

  const strings = Object.assign({},
    { en: {
      'header.upload': 'Upload',
      'library.title': 'Your Library',
      'library.subtitle': 'A quiet shelf for the books you\u2019ve opened.',
      'library.empty': 'No books yet. Click <strong>Upload</strong> to add one.',
      'library.read': '{format} \u00b7 {pct}% read',
      'reader.loading': 'Loading\u2026',
      'reader.page_of': 'Page {page} / {total}',
      'reader.percent': '{pct}%',
      'reader.cannot_open': 'Could not open this file',
      'reader.unsupported': ' \u2014 the format is not supported.',
      'reader.corrupt': ' \u2014 it may be corrupt or use an unsupported layout.',
      'reader.reupload': 'This is a record of a previous read. Please re-upload the file to continue reading it (its progress is saved).',
      'toc.title': 'Table of Contents',
      'toc.empty': 'TOC not available for this format yet.',
      'tooltip.back': 'Back to library',
      'nav.home': 'Library',
      'tooltip.prev': 'Previous',
      'tooltip.next': 'Next',
      'tooltip.font_down': 'Decrease font size',
      'tooltip.font_up': 'Increase font size',
      'tooltip.theme': 'Toggle theme',
      'tooltip.bookmark': 'Bookmark this location',
      'tooltip.toc': 'Table of contents',
      'lang.label': 'Language',
      'bookmarks.title': 'Bookmarks',
      'bookmarks.empty': 'No bookmarks yet. Tap the ribbon to save this spot.',
      'bookmarks.remove': 'Remove bookmark',
      'bookmarks.jump': 'Jump to bookmark',
      'bookmarks.label': 'Bookmark {n}',
      'reader.stored': 'Saved offline',
      'reader.remove_stored': 'Remove saved copy',
      'reader.stored_missing': 'This book is not saved on this device. Please re-upload it to read it again.',
      'book.delete': 'Delete',
      'book.delete_title': 'Delete this book',
      'book.delete_confirm': 'Delete "{title}" from your library? Its saved progress and bookmarks will also be removed.',
      'reader.cbz_lib_missing': ' The CBZ reader library could not load (check your internet connection).',
      'reader.cbz_no_images': ' The archive opened, but it contains no image files (JPG/PNG/GIF/WebP/BMP).',
      'reader.cbz_not_zip': ' The file is not a valid ZIP/CBZ (this can happen if it is actually a RAR or 7-Zip file).',
      'reader.too_big': 'Too large to keep offline — re-upload needed next visit.',
      'reader.too_big_alert': 'This book is over the offline-storage limit and will need to be re-uploaded next visit.',
      'format.txt': 'Text',
      'format.html': 'HTML',
      'format.rtf': 'RTF',
      'format.pdf': 'PDF',
      'format.epub': 'EPUB',
      'format.fb2': 'FB2',
      'format.cbz': 'CBZ',
      'format.cbr': 'CBR',
      'format.unknown': 'File'
    } },
    { ms: {
      'header.upload': 'Muat Naik',
      'library.title': 'Perpustakaan Anda',
      'library.subtitle': 'Rak yang tenang untuk buku yang telah anda buka.',
      'library.empty': 'Belum ada buku. Klik <strong>Muat Naik</strong> untuk menambah satu.',
      'library.read': '{format} \u00b7 {pct}% dibaca',
      'reader.loading': 'Memuatkan\u2026',
      'reader.page_of': 'Halaman {page} / {total}',
      'reader.percent': '{pct}%',
      'reader.cannot_open': 'Tidak dapat membuka fail ini',
      'reader.unsupported': ' \u2014 format tidak disokong.',
      'reader.corrupt': ' \u2014 mungkin rosak atau menggunakan susun atur yang tidak disokong.',
      'reader.reupload': 'Ini ialah rekod bacaan terdahulu. Sila muat naik semula fail untuk meneruskan bacaan (kemajuan anda disimpan).',
      'toc.title': 'Senarai Kandungan',
      'toc.empty': 'Senarai kandungan belum tersedia untuk format ini.',
      'tooltip.back': 'Kembali ke perpustakaan',
      'nav.home': 'Perpustakaan',
      'tooltip.prev': 'Sebelum',
      'tooltip.next': 'Seterusnya',
      'tooltip.font_down': 'Kurangkan saiz fon',
      'tooltip.font_up': 'Tambahkan saiz fon',
      'tooltip.theme': 'Tukar tema',
      'tooltip.bookmark': 'Tandakan lokasi ini',
      'tooltip.toc': 'Senarai kandungan',
      'lang.label': 'Bahasa',
      'bookmarks.title': 'Penanda',
      'bookmarks.empty': 'Belum ada penanda. Ketik ikon riben untuk menyimpan lokasi ini.',
      'bookmarks.remove': 'Buang penanda',
      'bookmarks.jump': 'Pergi ke penanda',
      'bookmarks.label': 'Penanda {n}',
      'reader.stored': 'Disimpan luar talian',
      'reader.remove_stored': 'Buang salinan tersimpan',
      'reader.stored_missing': 'Buku ini tidak disimpan pada peranti ini. Sila muat naik semula untuk membacanya semula.',
      'book.delete': 'Padam',
      'book.delete_title': 'Padam buku ini',
      'book.delete_confirm': 'Padam "{title}" daripada perpustakaan anda? Kemajuan dan penanda yang disimpan turut akan dibuang.',
      'reader.cbz_lib_missing': ' Pustaka pembaca CBZ tidak dapat dimuat (sila semak sambungan internet anda).',
      'reader.cbz_no_images': ' Arkib dibuka, tetapi tiada fail imej (JPG/PNG/GIF/WebP/BMP) di dalamnya.',
      'reader.cbz_not_zip': ' Fail ini bukan ZIP/CBZ yang sah (ini boleh berlaku jika ia sebenarnya fail RAR atau 7-Zip).',
      'reader.too_big': 'Terlalu besar untuk disimpan luar talian — perlu muat naik semula pada lawatan seterusnya.',
      'reader.too_big_alert': 'Buku ini melebihi had simpanan luar talian dan perlu dimuat naik semula pada lawatan seterusnya.',
      'format.txt': 'Teks',
      'format.unknown': 'Fail'
    } },
    { ja: {
      'header.upload': 'アップロード',
      'library.title': 'あなたのライブラリ',
      'library.subtitle': '開いた本のための静かな棚。',
      'library.empty': 'まだ本がありません。<strong>アップロード</strong>をクリックして追加してください。',
      'library.read': '{format} \u00b7 {pct}% 読了',
      'reader.loading': '読み込み中…',
      'reader.page_of': '{page} / {total} ページ',
      'reader.percent': '{pct}%',
      'reader.cannot_open': 'このファイルを開けませんでした',
      'reader.unsupported': ' — 対応していない形式です。',
      'reader.corrupt': ' — 破損しているか、対応していない構成の可能性があります。',
      'reader.reupload': 'これは以前読んだ記録です。続きを読むにはファイルを再アップロードしてください（進捗は保存されています）。',
      'toc.title': '目次',
      'toc.empty': 'この形式ではまだ目次を利用できません。',
      'tooltip.back': 'ライブラリに戻る',
      'nav.home': 'ライブラリ',
      'tooltip.prev': '前へ',
      'tooltip.next': '次へ',
      'tooltip.font_down': '文字を小さく',
      'tooltip.font_up': '文字を大きく',
      'tooltip.theme': 'テーマ切替',
      'tooltip.bookmark': 'この場所にしおりを付ける',
      'tooltip.toc': '目次',
      'lang.label': '言語',
      'bookmarks.title': 'しおり',
      'bookmarks.empty': 'まだしおりがありません。リボンアイコンを押すとこの場所を保存できます。',
      'bookmarks.remove': 'しおりを削除',
      'bookmarks.jump': 'しおりへ移動',
      'bookmarks.label': 'しおり {n}',
      'reader.stored': 'オフライン保存済み',
      'reader.remove_stored': '保存したコピーを削除',
      'reader.stored_missing': 'この本はこの端末に保存されていません。もう一度読むには再アップロードしてください。',
      'book.delete': '削除',
      'book.delete_title': 'この本を削除',
      'book.delete_confirm': 'ライブラリから「{title}」を削除しますか？保存された進捗としおりも削除されます。',
      'reader.cbz_lib_missing': ' CBZリーダーライブラリを読み込めませんでした（インターネット接続をご確認ください）。',
      'reader.cbz_no_images': ' アーカイブは開けましたが、画像ファイル（JPG/PNG/GIF/WebP/BMP）が中に見つかりません。',
      'reader.cbz_not_zip': ' このファイルは有効なZIP/CBZではありません（実際にはRARや7-Zipファイルである可能性があります）。',
      'reader.too_big': 'オフライン保存の上限を超えています — 次回は再アップロードが必要です。',
      'reader.too_big_alert': 'この本はオフライン保存の上限を超えているため、次回は再アップロードが必要です。',
      'format.txt': 'テキスト',
      'format.unknown': 'ファイル'
    } },
    { ko: {
      'header.upload': '업로드',
      'library.title': '내 서재',
      'library.subtitle': '열어 본 책을 위한 조용한 책장.',
      'library.empty': '아직 책이 없습니다. <strong>업로드</strong>를 클릭해 추가하세요.',
      'library.read': '{format} \u00b7 {pct}% 읽음',
      'reader.loading': '불러오는 중…',
      'reader.page_of': '{page} / {total}쪽',
      'reader.percent': '{pct}%',
      'reader.cannot_open': '이 파일을 열 수 없습니다',
      'reader.unsupported': ' — 지원하지 않는 형식입니다.',
      'reader.corrupt': ' — 손상되었거나 지원하지 않는 구성일 수 있습니다.',
      'reader.reupload': '이전에 읽은 기록입니다. 계속 읽으려면 파일을 다시 업로드하세요 (진행 상황이 저장되어 있습니다).',
      'toc.title': '목차',
      'toc.empty': '이 형식에서는 아직 목차를 사용할 수 없습니다.',
      'tooltip.back': '서재로 돌아가기',
      'nav.home': '서재',
      'tooltip.prev': '이전',
      'tooltip.next': '다음',
      'tooltip.font_down': '글자 작게',
      'tooltip.font_up': '글자 크게',
      'tooltip.theme': '테마 전환',
      'tooltip.bookmark': '이 위치를 북마크',
      'tooltip.toc': '목차',
      'lang.label': '언어',
      'bookmarks.title': '북마크',
      'bookmarks.empty': '아직 북마크가 없습니다. 리본 아이콘을 눌러 이 위치를 저장하세요.',
      'bookmarks.remove': '북마크 삭제',
      'bookmarks.jump': '북마크로 이동',
      'bookmarks.label': '북마크 {n}',
      'reader.stored': '오프라인 저장됨',
      'reader.remove_stored': '저장된 복사본 삭제',
      'reader.stored_missing': '이 책은 이 기기에 저장되어 있지 않습니다. 다시 읽으려면 다시 업로드하세요.',
      'book.delete': '삭제',
      'book.delete_title': '이 책 삭제',
      'book.delete_confirm': '이 책 "{title}"을(를) 서재에서 삭제할까요? 저장된 진행 상황과 북마크도 삭제됩니다.',
      'reader.cbz_lib_missing': ' CBZ 뷰어 라이브러리를 불러오지 못했습니다(인터넷 연결을 확인하세요).',
      'reader.cbz_no_images': ' 아카이브는 열렸지만 이미지 파일(JPG/PNG/GIF/WebP/BMP)이 없습니다.',
      'reader.cbz_not_zip': ' 이 파일은 유효한 ZIP/CBZ가 아닙니다(실제로 RAR 또는 7-Zip 파일일 수 있습니다).',
      'reader.too_big': '오프라인 저장 한도를 초과했습니다 — 다음 방문 시 다시 업로드해야 합니다.',
      'reader.too_big_alert': '이 책은 오프라인 저장 한도를 초과하여 다음 방문 시 다시 업로드해야 합니다.',
      'format.txt': '텍스트',
      'format.unknown': '파일'
    } },
    { 'zh-Hans': {
      'header.upload': '上传',
      'library.title': '我的书库',
      'library.subtitle': '为已打开的书准备的一面安静书架。',
      'library.empty': '还没有书。点击<strong>上传</strong>添加一本。',
      'library.read': '{format} \u00b7 已读 {pct}%',
      'reader.loading': '正在加载…',
      'reader.page_of': '第 {page} / {total} 页',
      'reader.percent': '{pct}%',
      'reader.cannot_open': '无法打开此文件',
      'reader.unsupported': ' — 不支持该格式。',
      'reader.corrupt': ' — 文件可能已损坏或使用了不支持的版式。',
      'reader.reupload': '这是之前的阅读记录。要继续阅读，请重新上传该文件（进度已保存）。',
      'toc.title': '目录',
      'toc.empty': '此格式暂不支持目录。',
      'tooltip.back': '返回书库',
      'nav.home': '书库',
      'tooltip.prev': '上一页',
      'tooltip.next': '下一页',
      'tooltip.font_down': '减小字号',
      'tooltip.font_up': '增大字号',
      'tooltip.theme': '切换主题',
      'tooltip.bookmark': '在此处添加书签',
      'tooltip.toc': '目录',
      'lang.label': '语言',
      'bookmarks.title': '书签',
      'bookmarks.empty': '还没有书签。点击缎带图标保存此位置。',
      'bookmarks.remove': '删除书签',
      'bookmarks.jump': '跳转到书签',
      'bookmarks.label': '书签 {n}',
      'reader.stored': '已离线保存',
      'reader.remove_stored': '删除已保存的副本',
      'reader.stored_missing': '此书未保存在此设备上。请重新上传后再阅读。',
      'book.delete': '删除',
      'book.delete_title': '删除此书',
      'book.delete_confirm': '从书库中删除“{title}”？已保存的进度和书签也将被删除。',
      'reader.cbz_lib_missing': ' CBZ阅读器库未能加载（请检查网络连接）。',
      'reader.cbz_no_images': ' 压缩包已打开，但其中没有图片文件（JPG/PNG/GIF/WebP/BMP）。',
      'reader.cbz_not_zip': ' 该文件不是有效的ZIP/CBZ（有时它实际上是RAR或7-Zip文件）。',
      'reader.too_big': '超出离线存储上限 — 下次访问需重新上传。',
      'reader.too_big_alert': '此书超出离线存储上限，下次访问时需要重新上传。',
      'format.txt': '文本',
      'format.unknown': '文件'
    } },
    { 'zh-Hant': {
      'header.upload': '上傳',
      'library.title': '我的書庫',
      'library.subtitle': '為已開啟的書準備的一面安靜書架。',
      'library.empty': '還沒有書。點擊<strong>上傳</strong>新增一本。',
      'library.read': '{format} \u00b7 已讀 {pct}%',
      'reader.loading': '正在載入…',
      'reader.page_of': '第 {page} / {total} 頁',
      'reader.percent': '{pct}%',
      'reader.cannot_open': '無法開啟此檔案',
      'reader.unsupported': ' — 不支援該格式。',
      'reader.corrupt': ' — 檔案可能已損毀或使用了不支援的版式。',
      'reader.reupload': '這是先前的閱讀記錄。若要繼續閱讀，請重新上傳該檔案（進度已儲存）。',
      'toc.title': '目錄',
      'toc.empty': '此格式暫不支援目錄。',
      'tooltip.back': '返回書庫',
      'nav.home': '書庫',
      'tooltip.prev': '上一頁',
      'tooltip.next': '下一頁',
      'tooltip.font_down': '縮小字型',
      'tooltip.font_up': '放大字型',
      'tooltip.theme': '切換主題',
      'tooltip.bookmark': '在此處加入書籤',
      'tooltip.toc': '目錄',
      'lang.label': '語言',
      'bookmarks.title': '書籤',
      'bookmarks.empty': '還沒有書籤。點擊緞帶圖示儲存此位置。',
      'bookmarks.remove': '刪除書籤',
      'bookmarks.jump': '跳轉到書籤',
      'bookmarks.label': '書籤 {n}',
      'reader.stored': '已離線儲存',
      'reader.remove_stored': '刪除已儲存的副本',
      'reader.stored_missing': '此書未儲存在此裝置上。請重新上傳後再閱讀。',
      'book.delete': '刪除',
      'book.delete_title': '刪除此書',
      'book.delete_confirm': '從書庫中刪除「{title}」？已儲存的進度和書籤也將被刪除。',
      'reader.cbz_lib_missing': ' CBZ閱讀器程式庫未能載入（請檢查網路連線）。',
      'reader.cbz_no_images': ' 壓縮檔已開啟，但其中沒有圖片檔案（JPG/PNG/GIF/WebP/BMP）。',
      'reader.cbz_not_zip': ' 該檔案不是有效的ZIP/CBZ（有時它實際上是RAR或7-Zip檔案）。',
      'reader.too_big': '超出離線儲存上限 — 下次瀏覽需重新上傳。',
      'reader.too_big_alert': '此書超出離線儲存上限，下次瀏覽時需要重新上傳。',
      'format.txt': '文字',
      'format.unknown': '檔案'
    } }
  );

  /* ---------------- engine ---------------- */

  function interpolate(str, params) {
    if (!params) return str;
    return String(str).replace(/\{(\w+)\}/g, function (m, k) {
      return params[k] !== undefined ? params[k] : m;
    });
  }

  function current() {
    return currentCode;
  }

  function t(key, params) {
    const dict = strings[currentCode] || {};
    const s =
      dict[key] !== undefined
        ? dict[key]
        : strings.en[key] !== undefined
          ? strings.en[key]
          : key;
    return interpolate(s, params);
  }

  function applyToDOM() {
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      const key = el.getAttribute('data-i18n');
      if (key) el.textContent = t(key);
    });
    document.querySelectorAll('[data-i18n-title]').forEach(function (el) {
      const key = el.getAttribute('data-i18n-title');
      if (key) el.setAttribute('title', t(key));
    });
  }

  function populateSelect() {
    const sel = document.getElementById('lang-select');
    if (!sel) return;
    sel.innerHTML = '';
    languages.forEach(function (l) {
      const opt = document.createElement('option');
      opt.value = l.code;
      opt.textContent = l.name;
      sel.appendChild(opt);
    });
    sel.value = currentCode;
  }

  function set(code) {
    if (!strings[code]) code = 'en';
    currentCode = code;
    document.documentElement.setAttribute('lang', code);
    window.LLLBook.Storage.setLang(code);
    applyToDOM();
    const sel = document.getElementById('lang-select');
    if (sel) sel.value = code;
  }

  function init() {
    const saved = window.LLLBook.Storage.getLang();
    currentCode = strings[saved] ? saved : 'en';
    document.documentElement.setAttribute('lang', currentCode);
    populateSelect();
    applyToDOM();
  }

  window.LLLBook = window.LLLBook || {};
  window.LLLBook.I18n = {
    languages: languages,
    t: t,
    set: set,
    current: current,
    applyToDOM: applyToDOM,
    populateSelect: populateSelect,
    init: init
  };
})();