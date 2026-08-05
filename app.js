/**
 * Local-only control panel for all 5 storefronts + the bot's price catalog.
 * NOT meant to be deployed publicly: it writes directly to files on the
 * admin's own disk via the File System Access API (Chrome/Edge). Connect
 * the "мініапп" folder once and the "MyBot/products" folder once — handles
 * are remembered (IndexedDB) so you don't reconnect every visit. Saving a
 * category writes both the site's products.json AND the bot's copy in one
 * click, so the two can't drift out of sync.
 */
(function () {
  const supportsFS = 'showDirectoryPicker' in window;

  // folder/repo are the same now: each shop is its own top-level folder
  // locally (under legit-shops/) AND its own GitHub repo of the same name.
  const CATEGORIES = [
    { key: 'steam', folder: 'legit-shop-steam', repo: 'legit-shop-steam', label: 'Steam Акаунти', accent: '#1a9fff' },
    { key: 'proxy', folder: 'legit-shop-proxy', repo: 'legit-shop-proxy', label: 'Проксі', accent: '#14c4c4' },
    { key: 'telegram', folder: 'legit-shop-telegram', repo: 'legit-shop-telegram', label: 'Telegram Товари', accent: '#2AABEE' },
    { key: 'smm', folder: 'legit-shop-smm', repo: 'legit-shop-smm', label: 'SMM Товари', accent: '#d946ef' },
    { key: 'verify', folder: 'legit-shop-verify', repo: 'legit-shop-verify', label: 'Крипто Верифікації', accent: '#16c07d' },
  ];
  const SHARED_FOLDER = 'legit-assets-shared';

  let siteDirHandle = null; // handle to ./legit-shops
  let botDirHandle = null;  // handle to .../MyBot/products
  let activeCategory = null;
  // Per-category in-memory session: { data, dirty }
  const sessions = {};

  const el = (id) => document.getElementById(id);
  const statusLine = el('statusLine');
  const categoryNav = el('categoryNav');
  const categoryHeader = el('categoryHeader');
  const categoryTitle = el('categoryTitle');
  const dirtyBadge = el('dirtyBadge');
  const itemsTable = el('itemsTable');
  const addItemBtn = el('addItemBtn');
  const saveBtn = el('saveBtn');
  const reloadBtn = el('reloadBtn');
  const markupPanel = el('markupPanel');
  const marketPriceInput = el('marketPriceInput');
  const markupPctInput = el('markupPctInput');
  const markupResult = el('markupResult');
  const applyMarkupBtn = el('applyMarkupBtn');
  const botUsernameInput = el('botUsernameInput');
  const fallbackFileInput = el('fallbackFileInput');

  let selectedItemIndex = null;
  let expandedItemIndex = null;
  let pendingFallbackCategory = null; // category key waiting on the file <input>

  function setStatus(msg) {
    statusLine.textContent = msg;
  }

  // Toast for the moments that matter (save success/error) — the thin gray
  // status line above is easy to miss, this is not.
  const toastStack = el('toastStack');
  function notify(msg, type) {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type || 'info'}`;
    toast.textContent = msg;
    toastStack.appendChild(toast);
    const timeout = type === 'error' ? 7000 : 4000;
    setTimeout(() => toast.remove(), timeout);
  }

  function updateGhBadge() {
    const badge = el('ghBadge');
    const cfg = window.LA_GH.getConfig();
    if (window.LA_GH.isConfigured()) {
      badge.className = 'gh-badge gh-badge-on';
      badge.textContent = `🟢 GitHub: ${cfg.owner}/${cfg.repo}`;
    } else {
      badge.className = 'gh-badge gh-badge-off';
      badge.textContent = '⚪ GitHub не підключено';
    }
  }

  // ---- IndexedDB: remember directory handles between visits -------------
  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('la-admin', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('handles');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbSet(key, value) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('handles', 'readwrite');
      tx.objectStore('handles').put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function idbGet(key) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('handles', 'readonly');
      const req = tx.objectStore('handles').get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function ensurePermission(handle) {
    if (!handle) return false;
    const opts = { mode: 'readwrite' };
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    if ((await handle.requestPermission(opts)) === 'granted') return true;
    return false;
  }

  // ---- Connecting folders -------------------------------------------------
  el('connectSiteBtn').addEventListener('click', async () => {
    if (!supportsFS) {
      setStatus('Ваш браузер не підтримує пряме збереження файлів (потрібен Chrome/Edge).');
      return;
    }
    try {
      siteDirHandle = await window.showDirectoryPicker();
      await idbSet('site', siteDirHandle);
      setStatus('Папку legit-shops підключено.');
      await loadSettings();
      renderCategoryNav();
    } catch (e) {
      if (e.name !== 'AbortError') { setStatus('Помилка: ' + e.message); notify('Помилка: ' + e.message, 'error'); }
    }
  });

  el('connectBotBtn').addEventListener('click', async () => {
    if (!supportsFS) return;
    try {
      botDirHandle = await window.showDirectoryPicker();
      await idbSet('bot', botDirHandle);
      setStatus('Папку бота (products/) підключено.');
      renderCategoryNav();
    } catch (e) {
      if (e.name !== 'AbortError') setStatus('Помилка: ' + e.message);
    }
  });

  async function restoreHandles() {
    renderCategoryNav(); // category list works in fallback mode too
    if (!supportsFS) {
      setStatus('Пряме збереження на диск недоступне в цьому браузері/сесії — працюємо в режимі "відкрити файл → відредагувати → завантажити". Оберіть категорію зліва.');
      el('connectSiteBtn').disabled = true;
      el('connectBotBtn').disabled = true;
      return;
    }
    const [savedSite, savedBot] = await Promise.all([idbGet('site'), idbGet('bot')]);
    if (savedSite && (await ensurePermission(savedSite))) {
      siteDirHandle = savedSite;
    }
    if (savedBot && (await ensurePermission(savedBot))) {
      botDirHandle = savedBot;
    }
    if (siteDirHandle) {
      setStatus('Підключення відновлено.');
      await loadSettings();
    } else {
      setStatus('Підключіть папку "legit-shops", щоб почати редагування.');
    }
    renderCategoryNav();
  }

  // ---- Shared config (shared-config.json) ---------------------------------
  let currentSharedConfig = {};
  const exchangeRateInput = el('exchangeRateInput');
  const defaultLangSelect = el('defaultLangSelect');

  async function loadSettings() {
    if (!siteDirHandle) return;
    try {
      const sharedDir = await siteDirHandle.getDirectoryHandle(SHARED_FOLDER);
      const fh = await sharedDir.getFileHandle('shared-config.json');
      const file = await fh.getFile();
      currentSharedConfig = JSON.parse(await file.text());
    } catch (e) {
      currentSharedConfig = {};
    }
    botUsernameInput.value = currentSharedConfig.botUsername || '';
    exchangeRateInput.value = currentSharedConfig.exchangeRateUAH || 41.5;
    defaultLangSelect.value = currentSharedConfig.defaultLang || 'ru';
  }

  el('saveSettingsBtn').addEventListener('click', async () => {
    const newConfig = Object.assign({}, currentSharedConfig, {
      botUsername: botUsernameInput.value.trim(),
      exchangeRateUAH: parseFloat(exchangeRateInput.value || '41.5'),
      defaultLang: defaultLangSelect.value,
    });
    currentSharedConfig = newConfig;
    const json = JSON.stringify(newConfig, null, 2) + '\n';

    if (siteDirHandle) {
      try {
        const sharedDir = await siteDirHandle.getDirectoryHandle(SHARED_FOLDER, { create: true });
        const fh = await sharedDir.getFileHandle('shared-config.json', { create: true });
        const writable = await fh.createWritable();
        await writable.write(json);
        await writable.close();
        setStatus('Налаштування збережено для всіх 5 сайтів ✅');
        notify('Налаштування збережено локально ✅', 'success');
      } catch (e) {
        setStatus('Помилка запису: ' + e.message);
        notify('Помилка запису налаштувань: ' + e.message, 'error');
      }
      return;
    }
    downloadJson(json, 'shared-config.json');
    setStatus(`Завантажено shared-config.json — замініть ним файл у ${SHARED_FOLDER}/.`);
  });

  // ---- GitHub API config (edit from any device, no local files needed) ----
  const ghOwnerInput = el('ghOwnerInput');
  const ghRepoInput = el('ghRepoInput');
  const ghBranchInput = el('ghBranchInput');
  const ghTokenInput = el('ghTokenInput');
  const ghStatus = el('ghStatus');
  const ghSaveBtn = el('ghSaveBtn');
  const ghSaveSettingsBtn = el('ghSaveSettingsBtn');

  function loadGhConfigIntoForm() {
    const cfg = window.LA_GH.getConfig();
    ghOwnerInput.value = cfg.owner || 'liltesso';
    ghRepoInput.value = cfg.repo || 'legit-assets-shared';
    ghBranchInput.value = cfg.branch || 'main';
    ghTokenInput.placeholder = cfg.token ? '•••• (збережено, введіть новий щоб замінити)' : 'github_pat_...';
    ghSaveBtn.disabled = !window.LA_GH.isConfigured() || !activeCategory;
    updateGhBadge();
  }

  // Strips anything outside plain ASCII — a stray smart-quote, non-breaking
  // space, or invisible character from copy-paste breaks fetch() headers
  // with a cryptic "non ISO-8859-1 code point" error otherwise.
  function sanitizeAscii(str) {
    return (str || '').replace(/[^\x20-\x7E]/g, '').trim();
  }

  el('ghSaveConfigBtn').addEventListener('click', async () => {
    const existing = window.LA_GH.getConfig();
    const rawToken = ghTokenInput.value.trim() || existing.token || '';
    const cfg = {
      owner: sanitizeAscii(ghOwnerInput.value),
      repo: sanitizeAscii(ghRepoInput.value),
      branch: sanitizeAscii(ghBranchInput.value) || 'main',
      token: sanitizeAscii(rawToken),
    };
    if (!cfg.owner || !cfg.repo || !cfg.token) {
      ghStatus.textContent = 'Заповніть власника, репозиторій і токен.';
      return;
    }
    if (cfg.token !== rawToken.trim()) {
      ghStatus.textContent = 'Токен містив зайві символи — я їх прибрав автоматично, пробую підключитись…';
    }
    if (!/^github_pat_[A-Za-z0-9_]+$/.test(cfg.token) && !/^ghp_[A-Za-z0-9]+$/.test(cfg.token)) {
      ghStatus.textContent = 'Це не схоже на GitHub-токен (має починатись з github_pat_ або ghp_) — перевірте, що скопіювали правильний рядок цілком.';
      notify('Токен виглядає некоректно — перевірте, що скопійовано правильно', 'error');
      return;
    }
    window.LA_GH.setConfig(cfg);
    ghTokenInput.value = '';
    ghStatus.textContent = 'Перевіряю доступ…';
    try {
      await window.LA_GH.getFile('shared-config.json');
      ghStatus.textContent = `Підключено до ${cfg.owner}/${cfg.repo}@${cfg.branch} ✅`;
      notify(`GitHub підключено: ${cfg.owner}/${cfg.repo}`, 'success');
      if (activeCategory) await loadCategoryFromGitHub(activeCategory);
    } catch (e) {
      ghStatus.textContent = 'Помилка доступу: ' + e.message + ' (перевірте токен і права Contents: Read/write)';
      notify('Не вдалося підключити GitHub: ' + e.message, 'error');
    }
    loadGhConfigIntoForm();
  });

  el('ghClearConfigBtn').addEventListener('click', () => {
    window.LA_GH.clearConfig();
    ghOwnerInput.value = 'liltesso';
    ghRepoInput.value = 'legit-assets-shared';
    ghBranchInput.value = 'main';
    ghTokenInput.value = '';
    ghTokenInput.placeholder = 'github_pat_...';
    ghStatus.textContent = 'Токен забуто.';
    loadGhConfigIntoForm();
  });

  ghSaveSettingsBtn.addEventListener('click', async () => {
    if (!window.LA_GH.isConfigured()) {
      ghStatus.textContent = 'Спершу підключіть GitHub вище.';
      return;
    }
    const newConfig = Object.assign({}, currentSharedConfig, {
      botUsername: botUsernameInput.value.trim(),
      exchangeRateUAH: parseFloat(exchangeRateInput.value || '41.5'),
      defaultLang: defaultLangSelect.value,
    });
    currentSharedConfig = newConfig;
    const json = JSON.stringify(newConfig, null, 2) + '\n';
    setStatus('Пушу shared-config.json в GitHub…');
    try {
      await window.LA_GH.putFile('shared-config.json', json, 'Update shared-config.json via admin panel');
      setStatus('Запушено в GitHub ✅ (сайт оновиться за ~хвилину)');
      notify('Налаштування запушено в GitHub ✅', 'success');
    } catch (e) {
      setStatus('Помилка GitHub: ' + e.message);
    }
  });

  // ---- Category navigation -------------------------------------------------
  function renderCategoryNav() {
    categoryNav.innerHTML = '';
    CATEGORIES.forEach((cat) => {
      const btn = document.createElement('button');
      btn.className = 'category-nav-item' + (cat.key === activeCategory ? ' active' : '');
      const dirty = sessions[cat.key] && sessions[cat.key].dirty;
      btn.innerHTML = `<span class="dot" style="background:${cat.accent}"></span>${cat.label}${dirty ? ' ●' : ''}`;
      btn.addEventListener('click', () => selectCategory(cat.key));
      categoryNav.appendChild(btn);
    });
  }

  async function selectCategory(key) {
    if (activeCategory && sessions[activeCategory] && sessions[activeCategory].dirty) {
      const ok = confirm('У поточній категорії є незбережені зміни. Перейти без збереження?');
      if (!ok) return;
    }
    activeCategory = key;
    selectedItemIndex = null;
    markupPanel.hidden = false;
    applyMarkupBtn.disabled = true;
    renderCategoryNav();

    // GitHub takes priority over local files — if connected, load straight
    // from the repo, no file picker involved at all.
    if (window.LA_GH.isConfigured()) {
      await loadCategoryFromGitHub(key);
      return;
    }
    if (supportsFS && siteDirHandle) {
      await loadCategory(key);
      return;
    }
    if (sessions[key]) {
      renderCategory(); // already opened once this session via fallback picker
      return;
    }
    if (!supportsFS) {
      const cat = CATEGORIES.find((c) => c.key === key);
      setStatus(`Оберіть файл ${cat.folder}/products.json на диску…`);
      pendingFallbackCategory = key;
      fallbackFileInput.click();
    } else {
      setStatus('Спершу підключіть папку legit-shops кнопкою вгорі, або підключіть GitHub вище.');
    }
  }

  async function loadCategoryFromGitHub(key) {
    const cat = CATEGORIES.find((c) => c.key === key);
    setStatus(`Завантажую products.json з ${cat.repo}…`);
    try {
      const productsFile = await window.LA_GH.getFile('products.json', cat.repo);
      if (!productsFile) throw new Error('products.json не знайдено в репозиторії');
      const data = JSON.parse(productsFile.content);

      let meta = null;
      try {
        const metaFile = await window.LA_GH.getFile('meta.json', cat.repo);
        meta = metaFile ? JSON.parse(metaFile.content) : null;
      } catch (e) { meta = null; }

      let availability = { banner: '', soldOut: [] };
      try {
        const availFile = await window.LA_GH.getFile('availability.json', cat.repo);
        availability = availFile ? JSON.parse(availFile.content) : { banner: '', soldOut: [] };
      } catch (e) { availability = { banner: '', soldOut: [] }; }

      let pricing = null;
      if (cat.key === 'proxy') {
        try {
          const pricingFile = await window.LA_GH.getFile('pricing.json', cat.repo);
          pricing = pricingFile ? JSON.parse(pricingFile.content) : null;
        } catch (e) { pricing = null; }
      }

      // Reuse the existing "no local file handle" save path (download +
      // GitHub push) — same as the fallback file-picker mode, just skipping
      // the file-picker step entirely since we already have the data.
      sessions[key] = {
        data, meta, availability, pricing, dirty: false,
        fallback: true, fallbackName: 'products.json',
        catDir: null,
      };
      setStatus(`Відкрито ${cat.repo}/products.json з GitHub`);
      renderCategory();
    } catch (e) {
      setStatus(`Не вдалося завантажити ${cat.repo} з GitHub: ${e.message}`);
      notify(`Не вдалося завантажити ${cat.repo}: ${e.message}`, 'error');
    }
  }

  async function loadCategory(key) {
    const cat = CATEGORIES.find((c) => c.key === key);
    try {
      const catDir = await siteDirHandle.getDirectoryHandle(cat.folder);
      const fh = await catDir.getFileHandle('products.json');
      const file = await fh.getFile();
      const data = JSON.parse(await file.text());
      let meta = null;
      let metaFileHandle = null;
      try {
        metaFileHandle = await catDir.getFileHandle('meta.json');
        meta = JSON.parse(await (await metaFileHandle.getFile()).text());
      } catch (e) {
        meta = null; // no meta.json yet — fine, form falls back to defaults
      }
      let availability = { banner: '', soldOut: [] };
      let availFileHandle = null;
      try {
        availFileHandle = await catDir.getFileHandle('availability.json');
        availability = JSON.parse(await (await availFileHandle.getFile()).text());
      } catch (e) {
        availability = { banner: '', soldOut: [] };
      }
      let pricing = null;
      let pricingFileHandle = null;
      if (cat.key === 'proxy') {
        try {
          pricingFileHandle = await catDir.getFileHandle('pricing.json');
          pricing = JSON.parse(await (await pricingFileHandle.getFile()).text());
        } catch (e) {
          pricing = null;
        }
      }
      sessions[key] = {
        data, meta, availability, pricing, dirty: false,
        siteFileHandle: fh, metaFileHandle, availFileHandle, pricingFileHandle, catDir,
      };
      setStatus(`Відкрито ${cat.folder}/products.json`);
      renderCategory();
    } catch (e) {
      setStatus(`Не вдалося прочитати ${cat.folder}/products.json: ${e.message}`);
      notify(`Не вдалося прочитати ${cat.folder}: ${e.message}`, 'error');
    }
  }

  fallbackFileInput.addEventListener('change', async () => {
    const file = fallbackFileInput.files[0];
    fallbackFileInput.value = '';
    if (!file || !pendingFallbackCategory) return;
    try {
      const data = JSON.parse(await file.text());
      sessions[pendingFallbackCategory] = { data, dirty: false, fallback: true, fallbackName: file.name };
      setStatus(`Відкрито ${file.name} (режим завантаження — без прямого запису на диск)`);
      renderCategory();
    } catch (e) {
      setStatus('Файл не є коректним JSON: ' + e.message);
      notify('Файл не є коректним JSON: ' + e.message, 'error');
    }
    pendingFallbackCategory = null;
  });

  reloadBtn.addEventListener('click', () => {
    if (!activeCategory) return;
    if (window.LA_GH.isConfigured()) {
      loadCategoryFromGitHub(activeCategory);
    } else if (supportsFS && siteDirHandle) {
      loadCategory(activeCategory);
    } else {
      delete sessions[activeCategory];
      selectCategory(activeCategory);
    }
  });

  function markDirty() {
    if (!activeCategory) return;
    sessions[activeCategory].dirty = true;
    dirtyBadge.hidden = false;
    saveBtn.disabled = false;
    renderCategoryNav();
  }

  // ---- i18n-aware text fields ----------------------------------------------
  // name/desc are {uk,ru,en} objects in every catalog now, but this stays
  // backward-compatible with a plain string too (old/unmigrated files).
  let editLang = 'ru';

  function getText(item, field) {
    const val = item[field];
    if (val == null) return '';
    if (typeof val === 'string') return val;
    return val[editLang] || '';
  }

  function setText(item, field, value) {
    const val = item[field];
    if (val == null || typeof val === 'string') {
      item[field] = { uk: '', ru: '', en: '' };
      item[field][editLang] = value;
    } else {
      val[editLang] = value;
    }
  }

  function renderLangBar() {
    const existing = el('adminEditLang');
    if (existing) existing.remove();
    const bar = document.createElement('div');
    bar.id = 'adminEditLang';
    bar.className = 'admin-edit-lang';
    bar.innerHTML = ['uk', 'ru', 'en']
      .map((code) => `<button class="lang-pill${code === editLang ? ' active' : ''}" data-lang="${code}">${code.toUpperCase()}</button>`)
      .join('') + '<span class="admin-edit-lang-hint">— мова полів "Назва"/"Опис" нижче</span>';
    categoryHeader.insertAdjacentElement('afterend', bar);
    bar.querySelectorAll('.lang-pill').forEach((btn) => {
      btn.addEventListener('click', () => {
        editLang = btn.dataset.lang;
        renderItems();
        renderLangBar();
      });
    });
  }

  // ---- Rendering the item table -------------------------------------------
  function renderCategory() {
    const cat = CATEGORIES.find((c) => c.key === activeCategory);
    const session = sessions[activeCategory];
    categoryHeader.hidden = false;
    addItemBtn.hidden = false;
    categoryTitle.textContent = `${cat.label} — ${session.data.items.length} товарів`;
    dirtyBadge.hidden = !session.dirty;
    saveBtn.disabled = !session.dirty;
    ghSaveBtn.disabled = !window.LA_GH.isConfigured();
    renderLangBar();
    renderItems();
    renderMetaPanel();
    renderAvailabilityPanel();
    renderPricingPanel();
  }

  // ---- Per-shop meta.json (title + accent colors) --------------------------
  const metaPanel = el('metaPanel');
  const metaTitleUk = el('metaTitleUk');
  const metaTitleRu = el('metaTitleRu');
  const metaTitleEn = el('metaTitleEn');
  const metaAccent = el('metaAccent');
  const metaAccent2 = el('metaAccent2');
  const metaHeaderEmoji = el('metaHeaderEmoji');
  let metaHeaderStickerImage = null;

  function updateHeaderStickerBtnLabel() {
    const btn = el('metaHeaderStickerBtn');
    if (btn) btn.textContent = metaHeaderStickerImage ? '✨ Преміум-стікер обрано (клікни, щоб змінити)' : '✨ Обрати преміум-стікер';
  }

  function renderMetaPanel() {
    const cat = CATEGORIES.find((c) => c.key === activeCategory);
    const session = sessions[activeCategory];
    metaPanel.hidden = false;
    const meta = session.meta || {};
    const title = meta.siteTitle || {};
    metaTitleUk.value = title.uk || cat.label;
    metaTitleRu.value = title.ru || cat.label;
    metaTitleEn.value = title.en || cat.label;
    metaAccent.value = meta.accent || cat.accent;
    metaAccent2.value = meta.accent2 || cat.accent;
    metaHeaderEmoji.value = meta.headerEmoji || '';
    metaHeaderStickerImage = meta.headerStickerImage || null;
    updateHeaderStickerBtnLabel();
  }

  function buildMetaFromForm() {
    const out = {
      siteTitle: { uk: metaTitleUk.value.trim(), ru: metaTitleRu.value.trim(), en: metaTitleEn.value.trim() },
      accent: metaAccent.value,
      accent2: metaAccent2.value,
      accentGlow: hexToGlow(metaAccent.value),
    };
    const emoji = metaHeaderEmoji.value.trim();
    if (emoji) out.headerEmoji = emoji;
    if (metaHeaderStickerImage) out.headerStickerImage = metaHeaderStickerImage;
    return out;
  }

  function hexToGlow(hex) {
    const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return 'rgba(0,102,255,0.45)';
    const r = parseInt(m[1].slice(0, 2), 16);
    const g = parseInt(m[1].slice(2, 4), 16);
    const b = parseInt(m[1].slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, 0.45)`;
  }

  el('metaSaveBtn').addEventListener('click', async () => {
    if (!activeCategory) return;
    const session = sessions[activeCategory];
    const meta = buildMetaFromForm();
    session.meta = meta;
    const json = JSON.stringify(meta, null, 2) + '\n';
    if (session.catDir) {
      try {
        const fh = session.metaFileHandle || await session.catDir.getFileHandle('meta.json', { create: true });
        const writable = await fh.createWritable();
        await writable.write(json);
        await writable.close();
        session.metaFileHandle = fh;
        setStatus('meta.json збережено локально ✅');
        notify('Назву/колір збережено локально ✅', 'success');
      } catch (e) {
        setStatus('Помилка запису meta.json: ' + e.message);
        notify('Помилка запису meta.json: ' + e.message, 'error');
      }
    } else {
      downloadJson(json, 'meta.json');
      setStatus('Завантажено meta.json — покладіть його в корінь папки цього магазину.');
    }
  });

  el('metaGhSaveBtn').addEventListener('click', async () => {
    if (!window.LA_GH.isConfigured() || !activeCategory) {
      setStatus('Спершу підключіть GitHub вище.');
      return;
    }
    const cat = CATEGORIES.find((c) => c.key === activeCategory);
    const session = sessions[activeCategory];
    const meta = buildMetaFromForm();
    session.meta = meta;
    const json = JSON.stringify(meta, null, 2) + '\n';
    setStatus(`Пушу meta.json в ${cat.repo}…`);
    try {
      await window.LA_GH.putFile('meta.json', json, 'Update shop name/colors via admin panel', cat.repo);
      setStatus(`Запушено meta.json в ${cat.repo} ✅ (сайт оновиться за ~хвилину)`);
      notify(`Назву/колір запушено в ${cat.repo} ✅`, 'success');
    } catch (e) {
      setStatus('Помилка GitHub: ' + e.message);
      notify('Помилка GitHub: ' + e.message, 'error');
    }
  });

  // ---- Banner + stock (availability.json) ----------------------------------
  const availabilityPanel = el('availabilityPanel');
  const availBannerInput = el('availBannerInput');
  const availItemsList = el('availItemsList');

  function renderAvailabilityPanel() {
    const session = sessions[activeCategory];
    availabilityPanel.hidden = false;
    const availability = session.availability || { banner: '', soldOut: [] };
    const banner = availability.banner;
    availBannerInput.value = typeof banner === 'string' ? banner : (banner ? getTextFromObj(banner) : '');
    const soldOut = new Set(availability.soldOut || []);
    availItemsList.innerHTML = session.data.items
      .map((item) => {
        const label = getText(item, 'name') || item.id;
        return `<div class="avail-item-row">
          <label><input type="checkbox" data-id="${item.id}" ${soldOut.has(item.id) ? '' : 'checked'}> ${item.emoji || ''} ${label} <span class="row-id">(${soldOut.has(item.id) ? 'немає в наявності' : 'в наявності'})</span></label>
        </div>`;
      })
      .join('');
  }

  function getTextFromObj(obj) {
    return obj[editLang] || obj.ru || obj.uk || obj.en || '';
  }

  function buildAvailabilityFromForm() {
    const soldOut = Array.from(availItemsList.querySelectorAll('input[type="checkbox"]'))
      .filter((cb) => !cb.checked)
      .map((cb) => cb.dataset.id);
    return { banner: availBannerInput.value.trim() || null, soldOut };
  }

  el('availSaveBtn').addEventListener('click', async () => {
    if (!activeCategory) return;
    const session = sessions[activeCategory];
    const availability = buildAvailabilityFromForm();
    session.availability = availability;
    const json = JSON.stringify(availability, null, 2) + '\n';
    if (session.catDir) {
      try {
        const fh = session.availFileHandle || await session.catDir.getFileHandle('availability.json', { create: true });
        const writable = await fh.createWritable();
        await writable.write(json);
        await writable.close();
        session.availFileHandle = fh;
        setStatus('availability.json збережено локально ✅');
        notify('Банер/наявність збережено локально ✅', 'success');
      } catch (e) {
        setStatus('Помилка запису availability.json: ' + e.message);
        notify('Помилка запису: ' + e.message, 'error');
      }
    } else {
      downloadJson(json, 'availability.json');
      setStatus('Завантажено availability.json — покладіть його в корінь папки цього магазину.');
    }
    renderAvailabilityPanel();
  });

  el('availGhSaveBtn').addEventListener('click', async () => {
    if (!window.LA_GH.isConfigured() || !activeCategory) {
      setStatus('Спершу підключіть GitHub вище.');
      return;
    }
    const cat = CATEGORIES.find((c) => c.key === activeCategory);
    const session = sessions[activeCategory];
    const availability = buildAvailabilityFromForm();
    session.availability = availability;
    const json = JSON.stringify(availability, null, 2) + '\n';
    setStatus(`Пушу availability.json в ${cat.repo}…`);
    try {
      await window.LA_GH.putFile('availability.json', json, 'Update banner/stock via admin panel', cat.repo);
      setStatus(`Запушено availability.json в ${cat.repo} ✅ (сайт оновиться за ~хвилину)`);
      notify(`Банер/наявність запушено в ${cat.repo} ✅`, 'success');
    } catch (e) {
      setStatus('Помилка GitHub: ' + e.message);
      notify('Помилка GitHub: ' + e.message, 'error');
    }
    renderAvailabilityPanel();
  });

  // ---- Proxy configurator pricing formula (Прокси/pricing.json only) -------
  const pricingPanel = el('pricingPanel');
  const pricingFields = el('pricingFields');
  const PRICING_LABELS = {
    netTypeBasePerDay: 'База за тип мережі ($/день)',
    ipVersionMultiplier: 'Множник версії IP',
    protocolAddPerDay: 'Надбавка за протокол ($/день)',
    modeAddPerDay: 'Надбавка за режим ($/день)',
    rotationFreqAddPerDay: 'Надбавка за частоту ротації ($/день)',
    regionModifierPerDay: 'Надбавка за регіон ($/день)',
  };

  function renderPricingPanel() {
    if (activeCategory !== 'proxy') {
      pricingPanel.hidden = true;
      return;
    }
    const session = sessions[activeCategory];
    if (!session.pricing) {
      pricingPanel.hidden = true;
      return;
    }
    pricingPanel.hidden = false;
    const pricing = session.pricing;
    pricingFields.innerHTML = Object.keys(PRICING_LABELS)
      .filter((key) => pricing[key] && typeof pricing[key] === 'object')
      .map((key) => {
        const fieldsHtml = Object.entries(pricing[key])
          .map(([subKey, val]) => `
            <label class="pricing-field">${subKey}
              <input type="number" step="0.01" value="${val}" data-group="${key}" data-key="${subKey}">
            </label>
          `)
          .join('');
        return `<div class="pricing-group"><h3>${PRICING_LABELS[key]}</h3><div class="pricing-group-fields">${fieldsHtml}</div></div>`;
      })
      .join('');
  }

  function buildPricingFromForm() {
    const session = sessions[activeCategory];
    const pricing = JSON.parse(JSON.stringify(session.pricing)); // deep clone, keep currency/periods untouched
    pricingFields.querySelectorAll('input').forEach((input) => {
      const group = input.dataset.group;
      const key = input.dataset.key;
      pricing[group][key] = parseFloat(input.value || '0');
    });
    return pricing;
  }

  el('pricingSaveBtn').addEventListener('click', async () => {
    if (activeCategory !== 'proxy') return;
    const session = sessions[activeCategory];
    const pricing = buildPricingFromForm();
    session.pricing = pricing;
    const json = JSON.stringify(pricing, null, 2) + '\n';
    if (session.catDir) {
      try {
        const fh = session.pricingFileHandle || await session.catDir.getFileHandle('pricing.json', { create: true });
        const writable = await fh.createWritable();
        await writable.write(json);
        await writable.close();
        session.pricingFileHandle = fh;
        setStatus('pricing.json збережено локально ✅');
        notify('Формулу цін збережено локально ✅ — не забудьте оновити копію для бота (MyBot/products/proxy_pricing.json)', 'success');
      } catch (e) {
        setStatus('Помилка запису pricing.json: ' + e.message);
        notify('Помилка запису: ' + e.message, 'error');
      }
    } else {
      downloadJson(json, 'pricing.json');
      setStatus('Завантажено pricing.json — покладіть його в Прокси і в MyBot/products/proxy_pricing.json.');
    }
  });

  el('pricingGhSaveBtn').addEventListener('click', async () => {
    if (!window.LA_GH.isConfigured() || activeCategory !== 'proxy') {
      setStatus('Спершу підключіть GitHub вище.');
      return;
    }
    const cat = CATEGORIES.find((c) => c.key === activeCategory);
    const session = sessions[activeCategory];
    const pricing = buildPricingFromForm();
    session.pricing = pricing;
    const json = JSON.stringify(pricing, null, 2) + '\n';
    setStatus(`Пушу pricing.json в ${cat.repo}…`);
    try {
      await window.LA_GH.putFile('pricing.json', json, 'Update proxy pricing formula via admin panel', cat.repo);
      setStatus(`Запушено pricing.json в ${cat.repo} ✅`);
      notify(`Формулу цін запушено в ${cat.repo} ✅ — оновіть копію для бота вручну`, 'success');
    } catch (e) {
      setStatus('Помилка GitHub: ' + e.message);
      notify('Помилка GitHub: ' + e.message, 'error');
    }
  });

  function renderItems() {
    const session = sessions[activeCategory];
    const items = session.data.items;
    const currency = session.data.currency || '$';
    itemsTable.innerHTML = '';

    items.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'item-row glass-card' + (index === selectedItemIndex ? ' selected' : '');
      row.innerHTML = `
        <div class="col-emoji"><input type="text" value="${item.emoji || ''}" data-field="emoji" maxlength="4"></div>
        <div class="col-name">
          <input type="text" value="${getText(item, 'name')}" data-field="name" placeholder="Назва (${editLang})">
          <span class="row-id">id: ${item.id}${item.group ? ' · group: ' + item.group : ''}</span>
        </div>
        <div class="col-price"><input type="number" step="0.01" value="${item.price ?? 0}" data-field="price"></div>
        <div class="col-desc"><input type="text" value="${getText(item, 'desc')}" data-field="desc" placeholder="Опис (${editLang})"></div>
        <div class="col-preview">
          <div class="mini-preview">
            <span class="mp-top">${item.emoji || '📦'} <b>${getText(item, 'name')}</b></span>
            <span class="mp-price">${(item.price || 0).toFixed(2)}${currency}</span>
          </div>
        </div>
        <div class="col-move">
          <button class="move-btn" data-dir="-1" ${index === 0 ? 'disabled' : ''}>↑</button>
          <button class="move-btn" data-dir="1" ${index === items.length - 1 ? 'disabled' : ''}>↓</button>
        </div>
        <div class="col-del">
          <button class="extra-toggle-btn" title="Додаткові поля (прапор/бейджі/спосіб видачі)">⚙</button>
          <button class="dup-btn" title="Дублювати">⧉</button>
          <button class="del-btn" title="Видалити">✕</button>
        </div>
      `;

      const extraRow = document.createElement('div');
      extraRow.className = 'item-extra-row glass-card' + (expandedItemIndex === index ? '' : ' collapsed');
      extraRow.innerHTML = `
        <label>Прапор (фон картки)<input type="text" value="${item.flag || ''}" data-xfield="flag" maxlength="8" placeholder="🇺🇦"></label>
        <label>Бейдж — ранг (${editLang})<input type="text" value="${getText(item, 'badgeRank')}" data-xfield="badgeRank" placeholder="Trust: High"></label>
        <label>Бейдж — рік/відлежка (${editLang})<input type="text" value="${getText(item, 'badgeYear')}" data-xfield="badgeYear" placeholder="Створено: 2021"></label>
        <label>Спосіб видачі (тільки verify)
          <select data-xfield="deliveryType">
            <option value="" ${!item.deliveryType ? 'selected' : ''}>Звичайний (пошта+пароль)</option>
            <option value="fragment" ${item.deliveryType === 'fragment' ? 'selected' : ''}>Fragment (телефон+код)</option>
          </select>
        </label>
      `;

      row.addEventListener('click', (ev) => {
        if (ev.target.tagName !== 'INPUT') {
          selectedItemIndex = index;
          applyMarkupBtn.disabled = false;
          renderItems();
        }
      });

      row.querySelectorAll('input').forEach((input) => {
        input.addEventListener('input', () => {
          const field = input.dataset.field;
          if (field === 'price') {
            item.price = parseFloat(input.value || '0');
          } else if (field === 'name' || field === 'desc') {
            setText(item, field, input.value);
          } else {
            item[field] = input.value;
          }
          markDirty();
          // live-update just the preview text without a full re-render
          const preview = row.querySelector('.mini-preview');
          preview.querySelector('.mp-top').innerHTML = `${item.emoji || '📦'} <b>${getText(item, 'name')}</b>`;
          preview.querySelector('.mp-price').textContent = `${(item.price || 0).toFixed(2)}${currency}`;
        });
      });

      row.querySelectorAll('.move-btn').forEach((btn) => {
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const dir = parseInt(btn.dataset.dir, 10);
          const target = index + dir;
          if (target < 0 || target >= items.length) return;
          [items[index], items[target]] = [items[target], items[index]];
          markDirty();
          renderItems();
        });
      });

      row.querySelector('.dup-btn').addEventListener('click', (ev) => {
        ev.stopPropagation();
        const copy = Object.assign({}, item, { id: item.id + '_copy' });
        items.splice(index + 1, 0, copy);
        markDirty();
        renderCategory();
      });

      row.querySelector('.del-btn').addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (!confirm(`Видалити "${getText(item, 'name')}"?`)) return;
        items.splice(index, 1);
        selectedItemIndex = null;
        markDirty();
        renderCategory();
      });

      row.querySelector('.extra-toggle-btn').addEventListener('click', (ev) => {
        ev.stopPropagation();
        expandedItemIndex = expandedItemIndex === index ? null : index;
        renderItems();
      });

      extraRow.querySelectorAll('[data-xfield]').forEach((input) => {
        const handler = () => {
          const field = input.dataset.xfield;
          if (field === 'badgeRank' || field === 'badgeYear') {
            setText(item, field, input.value);
          } else if (field === 'deliveryType') {
            if (input.value) item.deliveryType = input.value;
            else delete item.deliveryType;
          } else {
            item[field] = input.value;
          }
          markDirty();
        };
        input.addEventListener('input', handler);
        input.addEventListener('change', handler);
      });

      itemsTable.appendChild(row);
      itemsTable.appendChild(extraRow);
    });
  }

  addItemBtn.addEventListener('click', () => {
    const newId = prompt('id нового товару (латиниця, без пробілів):', 'new_item');
    if (!newId) return;
    sessions[activeCategory].data.items.push({
      id: newId,
      name: { uk: 'Новий товар', ru: 'Новый товар', en: 'New item' },
      emoji: '📦',
      price: 0,
      desc: { uk: '', ru: '', en: '' },
    });
    markDirty();
    renderCategory();
  });

  // ---- Markup calculator ---------------------------------------------------
  function computeMarkup() {
    const market = parseFloat(marketPriceInput.value || '0');
    const pct = parseFloat(markupPctInput.value || '0');
    const result = market * (1 + pct / 100);
    markupResult.textContent = result.toFixed(2);
    return result;
  }
  marketPriceInput.addEventListener('input', computeMarkup);
  markupPctInput.addEventListener('input', computeMarkup);

  applyMarkupBtn.addEventListener('click', () => {
    if (selectedItemIndex === null || !activeCategory) return;
    const price = computeMarkup();
    sessions[activeCategory].data.items[selectedItemIndex].price = Math.round(price * 100) / 100;
    markDirty();
    renderItems();
  });

  // ---- Saving: writes to the site AND the bot's copy in one click ---------
  function downloadJson(json, filename) {
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  saveBtn.addEventListener('click', async () => {
    const cat = CATEGORIES.find((c) => c.key === activeCategory);
    const session = sessions[activeCategory];
    const json = JSON.stringify(session.data, null, 2) + '\n';

    if (session.fallback) {
      downloadJson(json, session.fallbackName || 'products.json');
      downloadJson(json, `${cat.key}.json`);
      session.dirty = false;
      dirtyBadge.hidden = true;
      saveBtn.disabled = true;
      renderCategoryNav();
      setStatus(
        `Завантажено 2 файли: замініть ними ${cat.folder}/products.json і Нова тека 1/MyBot/products/${cat.key}.json вручну.`
      );
      return;
    }

    try {
      const writable = await session.siteFileHandle.createWritable();
      await writable.write(json);
      await writable.close();
    } catch (e) {
      setStatus('Помилка запису у файл сайту: ' + e.message);
      notify('Помилка запису: ' + e.message, 'error');
      return;
    }

    let botMsg = '';
    if (botDirHandle) {
      try {
        const botFh = await botDirHandle.getFileHandle(`${cat.key}.json`, { create: true });
        const writable = await botFh.createWritable();
        await writable.write(json);
        await writable.close();
        botMsg = ' + копію для бота';
      } catch (e) {
        botMsg = ` (⚠️ не вдалось оновити копію бота: ${e.message})`;
      }
    } else {
      botMsg = ' (папку бота не підключено — не забудьте оновити products/ вручну)';
    }

    session.dirty = false;
    dirtyBadge.hidden = true;
    saveBtn.disabled = true;
    renderCategoryNav();
    setStatus(`Збережено: ${cat.folder}/products.json${botMsg} ✅`);
    notify(`Товари "${cat.label}" збережено локально ✅`, 'success');
  });

  ghSaveBtn.addEventListener('click', async () => {
    if (!window.LA_GH.isConfigured() || !activeCategory) return;
    const cat = CATEGORIES.find((c) => c.key === activeCategory);
    const session = sessions[activeCategory];
    const json = JSON.stringify(session.data, null, 2) + '\n';
    // Each shop is its own repo now, so the file sits at the repo root.
    const path = 'products.json';

    setStatus(`Пушу products.json в ${cat.repo}…`);
    ghSaveBtn.disabled = true;
    try {
      await window.LA_GH.putFile(path, json, `Update products via admin panel`, cat.repo);
      session.dirty = false;
      dirtyBadge.hidden = true;
      saveBtn.disabled = true;
      renderCategoryNav();
      setStatus(
        `Запушено в ${cat.repo} ✅ (сайт оновиться за ~хвилину). Не забудьте оновити копію для бота — ` +
        `${cat.key}.json — вона в GitHub НЕ лежить (бот читає її локально/на своєму сервері).`
      );
      notify(`Товари "${cat.label}" запушено в GitHub ✅`, 'success');
    } catch (e) {
      setStatus('Помилка GitHub: ' + e.message);
      notify('Помилка GitHub: ' + e.message, 'error');
    } finally {
      ghSaveBtn.disabled = !window.LA_GH.isConfigured();
    }
  });

  window.addEventListener('beforeunload', (e) => {
    const hasDirty = Object.values(sessions).some((s) => s.dirty);
    if (hasDirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // ── Преміум-емодзі picker (той самий UX, що й у TG Bot Designer/studio.html):
  // ✨ кнопка внизу праворуч відкриває сітку стікерів із premium_emoji.js,
  // клік записує і текстовий фолбек (item.flag), і реальну картинку
  // (item.flagImage — те, що сайт покаже фоном картки) у поточний
  // розгорнутий (⚙-open) товар. ──
  const emojiFab = el('emojiFab');
  const emojiPicker = el('emojiPicker');
  const epGrid = el('epGrid');
  const epSearch = el('epSearch');
  const epCloseBtn = el('epCloseBtn');

  // pickerTarget визначає, куди піде обраний стікер: картка товару
  // (той самий фон-прапор, що й раніше) чи великий стікер у шапці сайту
  // (meta.json → headerStickerImage). Обидва використовують один picker.
  let pickerTarget = 'item';

  function openEmojiPickerFor(target) {
    if (!emojiPicker) return;
    if (target === 'item' && expandedItemIndex === null) {
      notify('Спочатку відкрий ⚙ у товарі, для якого обираєш стікер', 'error');
      return;
    }
    pickerTarget = target;
    emojiPicker.classList.add('open');
    renderEmojiPicker('');
    if (epSearch) {
      epSearch.value = '';
      setTimeout(() => epSearch.focus(), 50);
    }
  }

  function toggleEmojiPicker() {
    if (!emojiPicker) return;
    if (emojiPicker.classList.contains('open') && pickerTarget === 'item') {
      closeEmojiPicker();
      return;
    }
    openEmojiPickerFor('item');
  }

  function closeEmojiPicker() {
    if (emojiPicker) emojiPicker.classList.remove('open');
  }

  function renderEmojiPicker(q) {
    if (!epGrid) return;
    const list = (typeof PREMIUM_EMOJIS !== 'undefined' && PREMIUM_EMOJIS) ? PREMIUM_EMOJIS : [];
    q = (q || '').toLowerCase().trim();
    const filt = q ? list.filter((e) => (e.char || '').toLowerCase().includes(q) || (e.id || '').includes(q)) : list;
    if (!filt.length) {
      epGrid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:#8e8e93;font-size:11px;padding:16px">Нічого не знайдено</div>';
      return;
    }
    const limit = Math.min(filt.length, 240);
    let html = '';
    for (let i = 0; i < limit; i++) {
      const em = filt[i];
      html += `<div class="ep-item" title="${em.char || ''}" data-idx="${i}"><img src="${em.img}" loading="lazy"></div>`;
    }
    epGrid.innerHTML = html;
    epGrid.querySelectorAll('.ep-item').forEach((node) => {
      node.addEventListener('click', () => applyPremiumSticker(filt[parseInt(node.dataset.idx, 10)]));
    });
  }

  function applyPremiumSticker(em) {
    if (!em) return;
    if (pickerTarget === 'header') {
      metaHeaderEmoji.value = em.char || '';
      metaHeaderStickerImage = em.img || '';
      updateHeaderStickerBtnLabel();
      closeEmojiPicker();
      notify('Стікер шапки обрано — не забудь зберегти', 'success');
      return;
    }
    if (expandedItemIndex === null || !activeCategory) return;
    const item = sessions[activeCategory].data.items[expandedItemIndex];
    if (!item) return;
    item.flag = em.char || '';
    item.flagImage = em.img || '';
    markDirty();
    closeEmojiPicker();
    renderItems();
    notify('Стікер застосовано — не забудь зберегти', 'success');
  }

  if (emojiFab) emojiFab.addEventListener('click', toggleEmojiPicker);
  if (epCloseBtn) epCloseBtn.addEventListener('click', closeEmojiPicker);
  if (epSearch) epSearch.addEventListener('input', () => renderEmojiPicker(epSearch.value));

  const metaHeaderStickerBtn = el('metaHeaderStickerBtn');
  const metaHeaderStickerClear = el('metaHeaderStickerClear');
  if (metaHeaderStickerBtn) metaHeaderStickerBtn.addEventListener('click', () => openEmojiPickerFor('header'));
  if (metaHeaderStickerClear) metaHeaderStickerClear.addEventListener('click', () => {
    metaHeaderEmoji.value = '';
    metaHeaderStickerImage = null;
    updateHeaderStickerBtnLabel();
    notify('Стікер шапки прибрано — не забудь зберегти', 'success');
  });

  loadGhConfigIntoForm();
  restoreHandles();
})();
