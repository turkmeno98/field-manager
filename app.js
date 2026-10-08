Warning: truncated output (original token count: 18777)
Total output lines: 1539

/* Drawing, geodesic area and Supabase-backed GeoJSON field records. */
(() => {
  'use strict';

  const TABLE = 'fields';
  const SELECT_COLUMNS = 'id,farm_id,name,area_ha,crop,variety,year,yield_c_ha,notes,geometry,created_at,updated_at';
  const EARTH_RADIUS_METERS = 6371008.8;
  const map = L.map('map', { zoomControl: false, preferCanvas: true }).setView([55.75, 37.62], 5);
  const osmLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);
  const satelliteLayer = L.tileLayer('https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg', {
    maxZoom: 19,
    maxNativeZoom: 14,
    attribution: '<a href="https://cloudless.eox.at/">EOxCloudless</a> by <a href="https://eox.at/">EOX IT Services GmbH</a> (Contains modified Copernicus Sentinel data 2016 &amp; 2017) · <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>'
  });
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.control.scale({ position: 'bottomleft', metric: true, imperial: false, maxWidth: 120 }).addTo(map);

  const fieldsLayer = L.featureGroup().addTo(map);
  const layerControl = L.control.layers({ '🗺️ Карта': osmLayer, '🛰️ Спутник': satelliteLayer }, null, {
    position: 'topright', collapsed: true, autoZIndex: true, sortLayers: false
  }).addTo(map);
  const fields = new Map();
  let supabase = null;
  let isReady = false;
  let authenticatedUser = null;
  let currentSession = null;
  let lastAuthEvent = 'INITIAL_SESSION';
  let farms = [];
  let farmRoles = new Map();
  let activeFarmId = null;
  let authMode = 'login';
  let authSubmitting = false;
  let farmCreating = false;
  let loadInProgress = false;
  let draft = null;
  let selectedId = null;
  let drawHandler = null;
  let nextFieldNumber = 1;
  let seasonCrops = [];
  let seasonVarieties = [];
  let seasonSaving = false;
  let seasonLookupBlocked = false;
  let seasonHistoryRequest = 0;
  let technologyRows = [];
  let technologyListRequest = 0;
  let technologyDetailsRequest = 0;
  const $ = (selector) => document.querySelector(selector);
  const ui = {
    farmSelector: $('#farm-selector'),
    farmRole: $('#farm-role-label'), authControl: $('#auth-control'),
    authModal: $('#auth-modal'), authClose: $('#auth-close'), authTitle: $('#auth-dialog-title'),
    authFormPanel: $('#auth-form-panel'), authForm: $('#auth-form'), authModeLogin: $('#auth-mode-login'),
    authModeRegister: $('#auth-mode-register'), authEmail: $('#auth-email'), authPassword: $('#auth-password'),
    authSubmit: $('#auth-submit'), authMessage: $('#auth-message'), authLoadingPanel: $('#auth-loading-panel'),
    authLoadingMessage: $('#auth-loading-message'), authRetry: $('#auth-retry'),
    noFarmPanel: $('#no-farm-panel'), openFarmCreate: $('#open-farm-create'), noFarmLogout: $('#no-farm-logout'),
    farmCreateForm: $('#farm-create-form'), farmName: $('#farm-name'), farmNotes: $('#farm-notes'),
    farmCreateSubmit: $('#farm-create-submit'), farmCreateCancel: $('#farm-create-cancel'),
    farmCreateMessage: $('#farm-create-message'),
    add: $('#add-field'), emptyAdd: $('#empty-add-field'), myFields: $('#my-fields'),
    layersToggle: $('#layers-toggle'),
    fieldsListView: $('#fields-list-view'), fieldsDetailsView: $('#field-details-view'),
    fieldsList: $('#fields-list'), fieldsListSummary: $('#fields-list-summary'),
    fieldsSearch: $('#fields-list-search'), cropFilter: $('#fields-crop-filter'), yearFilter: $('#fields-year-filter'),
    searchToggle: $('#search-toggle'), searchPanel: $('#search-panel'),
    hint: $('#map-hint'), drawBanner: $('#draw-banner'), emptyState: $('#empty-state'),
    status: $('#sync-status'), statusText: $('.sync-status-text'), retry: $('#retry-sync'),
    form: $('#field-form'), name: $('#field-name'), area: $('#field-area'),
    crop: $('#field-crop'), variety: $('#field-variety'), year: $('#field-year'),
    yield: $('#field-yield'), note: $('#field-note'), heading: $('#field-card-heading'),
    caption: $('#field-caption'), save: $('#save-field'), delete: $('#delete-field'),
    seasonHistory: $('#season-history'), seasonAdd: $('#season-add'), seasonList: $('#season-list'),
    seasonLoading: $('#season-loading'), seasonModal: $('#season-modal'), seasonForm: $('#season-form'),
    seasonFormMessage: $('#season-form-message'), seasonYear: $('#season-year'), seasonStatus: $('#season-status-input'),
    seasonCrop: $('#season-crop-input'), seasonVariety: $('#season-variety-input'),
    seasonPlannedYield: $('#season-planned-yield'), seasonActualYield: $('#season-actual-yield'),
    seasonSave: $('#season-save'),
    cropDirectory: $('#open-crop-directory'), cropModal: $('#crop-modal'), cropClose: $('#crop-close'),
    cropList: $('#crop-list'), cropForm: $('#crop-form'), cropName: $('#crop-name'), cropCode: $('#crop-code'),
    cropSave: $('#crop-save'), cropMessage: $('#crop-message'), cropTitle: $('#crop-dialog-title'),
    cropPanel: $('#crop-directory-panel'), cropTab: $('#crop-directory-tab'),
    technologyTab: $('#technology-directory-tab'), technologyPanel: $('#technology-directory-panel'),
    technologyMessage: $('#technology-message'), technologyList: $('#technology-list'),
    technologyDetails: $('#technology-details'), technologyTitle: $('#technology-title'),
    technologyDescription: $('#technology-description'), technologyOperations: $('#technology-operations'),
    technologyBackList: $('#technology-back-list')
  };

  function geodesicRingArea(ring) {
    if (!Array.isArray(ring) || ring.length < 4) return 0;
    let sum = 0;
    for (let i = 0; i < ring.length - 1; i += 1) {
      const [lon1, lat1] = ring[i];
      const [lon2, lat2] = ring[i + 1];
      const deltaLon = ((lon2 - lon1 + 540) % 360) - 180;
      sum += (deltaLon * Math.PI / 180) * (2 + Math.sin(lat1 * Math.PI / 180) + Math.sin(lat2 * Math.PI / 180));
    }
    return Math.abs(sum * EARTH_RADIUS_METERS * EARTH_RADIUS_METERS / 2);
  }

  function geoJsonAreaSquareMeters(geometry) {
    if (!geometry || geometry.type !== 'Polygon') return 0;
    const rings = geometry.coordinates || [];
    if (!rings.length) return 0;
    return Math.max(0, geodesicRingArea(rings[0]) - rings.slice(1).reduce((total, ring) => total + geodesicRingArea(ring), 0));
  }

  function areaHectares(geometry) {
    return geoJsonAreaSquareMeters(geometry) / 10000;
  }

  function formatArea(area) {
    return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(area);
  }

  function createFeature(geometry, properties = {}) {
    return { type: 'Feature', properties: { ...properties }, geometry };
  }

  function setStatus(message, kind = 'info', retry = false) {
    ui.statusText.textContent = message;
    ui.status.className = `sync-status is-${kind}`;
    ui.status.hidden = !message;
    ui.retry.hidden = !retry;
  }

  function formatSupabaseError(error) {
    const detail = error?.message || error?.details || 'неизвестная ошибка';
    const code = error?.code ? ` (${error.code})` : '';
    return `${detail}${code}`;
  }

  function isRlsError(error) {
    return error?.code === '42501' || /permission denied|row-level security|violates row.level security/i.test(error?.message || '');
  }

  async function getCurrentUser() {
    if (!supabase) return null;
    const { data, error } = await supabase.auth.getUser();
    if (error) throw error;
    return data.user || null;
  }

  async function requireUser() {
    try {
      const user = await getCurrentUser();
      if (user) return user;
      setDataActionsEnabled(false);
      setStatus('Требуется вход. Авторизуйтесь, чтобы открыть хозяйства и поля.', 'info', false);
      return null;
    } catch (error) {
      setDataActionsEnabled(false);
      setStatus(`Не удалось проверить сессию: ${formatSupabaseError(error)}. Требуется действующая сессия Supabase Auth.`, 'error', false);
      return null;
    }
  }

  function updateAuthControl() {
    const isAuthenticated = Boolean(authenticatedUser);
    ui.authControl.textContent = isAuthenticated ? 'Выйти' : 'Войти';
    ui.authControl.setAttribute('aria-label', isAuthenticated ? 'Выйти из аккаунта' : 'Войти в аккаунт');
    ui.authControl.title = isAuthenticated ? `Выйти (${authenticatedUser.email || 'аккаунт'})` : 'Войти или зарегистрироваться';
  }

  function showAuthMessage(message, kind = 'error') {
    ui.authMessage.textContent = message;
    ui.authMessage.className = `auth-message is-${kind}`;
    ui.authMessage.hidden = !message;
  }

  function showFarmCreateMessage(message, kind = 'error') {
    ui.farmCreateMessage.textContent = message;
    ui.farmCreateMessage.className = `auth-message is-${kind}`;
    ui.farmCreateMessage.hidden = !message;
  }

  function setAuthMode(mode) {
    authMode = mode === 'register' ? 'register' : 'login';
    const registering = authMode === 'register';
    ui.authModeLogin.classList.toggle('is-active', !registering);
    ui.authModeRegister.classList.toggle('is-active', registering);
    ui.authModeLogin.setAttribute('aria-pressed', String(!registering));
    ui.authModeRegister.setAttribute('aria-pressed', String(registering));
    ui.authTitle.textContent = registering ? 'Создать аккаунт' : 'Вход в аккаунт';
    ui.authSubmit.textContent = registering ? 'Зарегистрироваться' : 'Войти';
    ui.authPassword.autocomplete = registering ? 'new-password' : 'current-password';
    showAuthMessage('');
  }

  function showAuthForm(mode = 'login') {
    setAuthMode(mode);
    ui.authFormPanel.hidden = false;
    ui.authLoadingPanel.hidden = true;
    ui.noFarmPanel.hidden = true;
    ui.farmCreateForm.hidden = true;
    ui.authClose.hidden = false;
    ui.authModal.hidden = false;
    window.setTimeout(() => ui.authEmail.focus(), 0);
  }

  function showAuthLoading(message = 'Проверяем сессию и загружаем хозяйства…', error = false) {
    ui.authFormPanel.hidden = true;
    ui.authLoadingPanel.hidden = false;
    ui.noFarmPanel.hidden = true;
    ui.farmCreateForm.hidden = true;
    ui.authClose.hidden = true;
    ui.authLoadingMessage.textContent = message;
    ui.authLoadingMessage.className = `auth-message ${error ? 'is-error' : 'is-info'}`;
    ui.authRetry.hidden = !error;
    ui.authModal.hidden = false;
  }

  function showNoFarmState() {
    ui.authFormPanel.hidden = true;
    ui.authLoadingPanel.hidden = true;
    ui.noFarmPanel.hidden = false;
    ui.farmCreateForm.hidden = true;
    ui.authTitle.textContent = 'Настройка хозяйства';
    ui.authClose.hidden = true;
    ui.authModal.hidden = false;
  }

  function showFarmCreateForm() {
    ui.authFormPanel.hidden = true;
    ui.authLoadingPanel.hidden = true;
    ui.noFarmPanel.hidden = true;
    ui.farmCreateForm.hidden = false;
    ui.authTitle.textContent = 'Создать хозяйство';
    ui.farmName.focus();
    showFarmCreateMessage('');
  }

  function authErrorMessage(error, action) {
    const message = String(error?.message || '').toLowerCase();
    if (/invalid login credentials|invalid email or password/.test(message)) return 'Неверный email или пароль.';
    if (/email not confirmed/.test(message)) return 'Подтвердите email по ссылке из письма, затем войдите.';
    if (/already registered|user already exists/.test(message)) return 'Этот email уже зарегистрирован. Переключитесь на вход.';
    if (/password.*(at least|characters|weak)|weak password/.test(message)) return 'Пароль слишком простой. Используйте не менее 6 символов.';
    if (/rate limit|too many requests/.test(message)) return 'Слишком много попыток. Подождите немного и повторите.';
    if (/failed to fetch|network|fetch failed/.test(message)) return 'Нет соединения с Supabase. Проверьте интернет и повторите.';
    return `Не удалось ${action}: ${formatSupabaseError(error)}.`;
  }

  async function submitAuth(event) {
    event.preventDefault();
    if (authSubmitting || !supabase || !ui.authForm.reportValidity()) return;
    const email = ui.authEmail.value.trim();
    const password = ui.authPassword.value;
    authSubmitting = true;
    ui.authSubmit.disabled = true;
    ui.authSubmit.textContent = authMode === 'register' ? 'Создаём аккаунт…' : 'Входим…';
    showAuthMessage('');
    try {
      if (authMode === 'register') {
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        ui.authPassword.value = '';
        if (data.session) {
          await handleAuthStateChange('SIGNED_IN', data.session);
          showAuthMessage('Аккаунт создан. Загружаем доступ к хозяйствам…', 'success');
        } else {
          setAuthMode('login');
          ui.authEmail.value = email;
          showAuthMessage('Аккаунт создан. Проверьте почту и подтвердите адрес, затем войдите.', 'success');
        }
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        ui.authPassword.value = '';
        await handleAuthStateChange('SIGNED_IN', data.session);
      }
    } catch (error) {
      console.error('Ошибка Supabase Auth:', error);
      ui.authPassword.value = '';
      showAuthMessage(authErrorMessage(error, authMode === 'register' ? 'создать аккаунт' : 'войти'));
    } finally {
      authSubmitting = false;
      ui.authSubmit.disabled = false;
      ui.authSubmit.textContent = authMode === 'register' ? 'Зарегистрироваться' : 'Войти';
    }
  }

  async function signOutCurrentUser() {
    if (!supabase) return;
    ui.authControl.disabled = true;
    try {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
    } catch (error) {
      console.error('Ошибка выхода:', error);
      setStatus(`Не удалось выйти: ${formatSupabaseError(error)}`, 'error', false);
      showAuthMessage(authErrorMessage(error, 'выйти'));
    } finally {
      ui.authControl.disabled = false;
    }
  }

  async function createFarm(event) {
    event.preventDefault();
    if (farmCreating || !supabase || !ui.farmCreateForm.reportValidity()) return;
    farmCreating = true;
    ui.farmCreateSubmit.disabled = true;
    ui.farmCreateSubmit.textContent = 'Создаём хозяйство…';
    showFarmCreateMessage('');
    try {
      const user = await requireUser();
      if (!user) return;
      const { data: farmId, error } = await supabase.rpc('create_farm_for_current_user', {
        p_name: ui.farmName.value.trim(),
        p_notes: ui.farmNotes.value.trim() || null
      });
      if (error) throw error;
      if (!farmId) throw new Error('RPC не вернула идентификатор хозяйства.');
      const createdFarmId = String(farmId);
      ui.farmCreateForm.reset();
      const loaded = await loadAccessibleFarms(user, createdFarmId);
      if (!loaded) throw new Error('Хозяйство создано, но не появилось в списке доступных. Проверьте membership и RLS.');
      setStatus('Хозяйство создано. Вам назначена роль владельца.', 'success');
      await loadFieldsFromSupabase();
    } catch (error) {
      console.error('Ошибка создания хозяйства:', error);
      const detail = isRlsError(error)
        ? 'Нет доступа к RPC create_farm_for_current_user. Проверьте EXECUTE для authenticated и действующую сессию.'
        : authErrorMessage(error, 'создать хозяйство');
      showFarmCreateMessage(detail);
    } finally {
      farmCreating = false;
      ui.farmCreateSubmit.disabled = false;
      ui.farmCreateSubmit.textContent = 'Создать хозяйство';
    }
  }

  function farmRoleLabel(role) {
    return ({ owner: 'Владелец', manager: 'Управляющий', agronomist: 'Агроном', operator: 'Оператор', viewer: 'Наблюдатель' })[role] || role || '';
  }

  function updateSelectedFarmRole() {
    const role = farmRoles.get(String(activeFarmId));
    ui.farmRole.textContent = role ? farmRoleLabel(role) : '';
    ui.farmRole.hidden = !role;
  }

  async function handleAuthStateChange(event, session) {
    const nextUser = session?.user || null;
    const previousId = authenticatedUser?.id || null;
    currentSession = session || null;
    lastAuthEvent = event;
    authenticatedUser = nextUser;
    updateAuthControl();
    if (!nextUser) {
      if (previousId || event === 'SIGNED_OUT' || event === 'INITIAL_SESSION') {
        setDataActionsEnabled(false);
        farms = [];
        farmRoles = new Map();
        activeFarmId = null;
        ui.farmSelector.replaceChildren(new Option('Требуется вход', ''));
        ui.farmSelector.disabled = true;
        ui.cropDirectory.disabled = true;
        ui.farmRole.hidden = true;
        clearRenderedFields();
        selectedId = null;
        draft = null;
        resetCard();
        renderFieldsList();
        setStatus('Требуется вход. Авторизуйтесь, чтобы открыть хозяйства и поля.', 'info', false)…9777 tokens truncated…rror', true);
      if (authenticatedUser) showAuthLoading(`Не удалось загрузить данные: ${detail}.${policy}`, true);
    } finally {
      ui.farmSelector.disabled = farms.length === 0;
      loadInProgress = false;
    }
  }

  async function initializeSupabase() {
    const config = window.SUPABASE_CONFIG || {};
    const url = String(config.url || '').trim();
    const key = String(config.publishableKey || config.anonKey || '').trim();
    let legacyRole = '';
    try {
      const payload = key.split('.')[1];
      if (payload) legacyRole = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))).role || '';
    } catch { /* Non-JWT publishable keys are checked by their prefix below. */ }
    const looksLikeServiceKey = key.startsWith('sb_secret_') || legacyRole === 'service_role';
    if (!url || !key) {
      setDataActionsEnabled(false);
      setStatus('Добавьте публичный Supabase publishable/anon key в supabase-config.js, затем перезагрузите страницу.', 'error', false);
      return;
    }
    if (looksLikeServiceKey) {
      setDataActionsEnabled(false);
      setStatus('Подключение остановлено: service_role/secret key нельзя использовать в браузере. Укажите только publishable/anon key.', 'error', false);
      return;
    }
    if (!key.startsWith('sb_publishable_') && legacyRole !== 'anon') {
      setDataActionsEnabled(false);
      setStatus('Неподдерживаемый ключ. Укажите публичный sb_publishable_… key или legacy anon key из настроек проекта.', 'error', false);
      return;
    }
    if (!window.supabase?.createClient) {
      setDataActionsEnabled(false);
      setStatus('Библиотека Supabase не загрузилась. Проверьте интернет и CDN, затем повторите загрузку страницы.', 'error', true);
      return;
    }
    try {
      supabase = window.supabase.createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
      supabase.auth.onAuthStateChange((event, session) => {
        window.setTimeout(() => { void handleAuthStateChange(event, session); }, 0);
      });
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;
      await handleAuthStateChange('INITIAL_SESSION', data.session);
    } catch (error) {
      setDataActionsEnabled(false);
      setStatus(`Не удалось настроить Supabase: ${formatSupabaseError(error)}`, 'error', false);
    }
  }

  function styleForField(id) {
    const selected = id === selectedId;
    return { color: selected ? '#285b39' : '#39734b', weight: selected ? 3 : 2, opacity: 1, fillColor: '#76a97a', fillOpacity: selected ? 0.38 : 0.26, className: 'field-polygon' };
  }

  function makeLayer(feature, id) {
    const layer = L.geoJSON(feature, {
      style: () => styleForField(id),
      onEachFeature: (_item, itemLayer) => {
        itemLayer.bindTooltip(String(feature.properties.name || 'Поле'), { sticky: true });
        itemLayer.on('click', (event) => {
          L.DomEvent.stopPropagation(event);
          selectField(id);
        });
      }
    });
    return layer;
  }

  function updateStyles() {
    fields.forEach((field) => field.layer.setStyle(styleForField(field.id)));
    if (draft?.layer) draft.layer.setStyle({ color: '#39734b', weight: 2, dashArray: '7 5', fillColor: '#a9c79e', fillOpacity: 0.25 });
  }

  function fillForm(field, isNew) {
    const props = field.feature.properties;
    ui.form.reset();
    ui.name.value = props.name || '';
    ui.area.value = formatArea(areaHectares(field.feature.geometry));
    ui.crop.value = props.crop || '';
    ui.variety.value = props.variety || '';
    ui.year.value = props.year ?? '';
    ui.yield.value = props.yield ?? '';
    ui.note.value = props.note || '';
    ui.heading.textContent = isNew ? 'Новое поле' : (props.name || 'Карточка поля');
    ui.caption.textContent = isNew ? 'Черновик — сохраните поле, чтобы оставить его на карте' : 'Данные поля';
    ui.save.textContent = isNew ? 'Сохранить' : 'Сохранить изменения';
    ui.delete.hidden = isNew;
    ui.seasonHistory.hidden = isNew;
    ui.seasonAdd.disabled = isNew || !isReady;
    ui.emptyState.hidden = true;
    ui.form.hidden = false;
  }

  function selectField(id) {
    const field = fields.get(id);
    if (!field) return;
    draft = null;
    selectedId = id;
    openFieldDetails();
    updateStyles();
    fillForm(field, false);
    renderFieldsList();
    loadSeasonHistory(id);
  }

  function stopDrawing() {
    if (drawHandler) drawHandler.disable();
    drawHandler = null;
    ui.drawBanner.hidden = true;
    ui.add.classList.remove('is-active');
    map.getContainer().style.cursor = '';
  }

  function cancelDraft() {
    stopDrawing();
    if (draft?.layer) map.removeLayer(draft.layer);
    draft = null;
    selectedId = null;
    ui.seasonModal.hidden = true;
    updateStyles();
    ui.form.hidden = true;
    ui.emptyState.hidden = false;
  }

  function startDrawing() {
    if (drawHandler) {
      stopDrawing();
      ui.emptyState.hidden = false;
      return;
    }
    if (draft) cancelDraft();
    ui.form.hidden = true;
    ui.emptyState.hidden = true;
    ui.drawBanner.hidden = false;
    ui.add.classList.add('is-active');
    drawHandler = new L.Draw.Polygon(map, {
      allowIntersection: false,
      showArea: false,
      shapeOptions: { color: '#39734b', weight: 2, dashArray: '7 5', fillColor: '#a9c79e', fillOpacity: 0.25 }
    });
    drawHandler.enable();
  }

  function newDraft(layer) {
    stopDrawing();
    const geometry = layer.toGeoJSON().geometry;
    const id = `field-${Date.now()}-${nextFieldNumber}`;
    const feature = createFeature(geometry, { id, farmId: activeFarmId, name: `Поле ${nextFieldNumber}`, crop: '', variety: '', year: '', yield: '', note: '' });
    nextFieldNumber += 1;
    layer.setStyle({ color: '#39734b', weight: 2, dashArray: '7 5', fillColor: '#a9c79e', fillOpacity: 0.25 });
    layer.on('click', () => { if (draft?.id === id) fillForm(draft, true); });
    layer.addTo(map);
    draft = { id, feature, layer };
    selectedId = null;
    fillForm(draft, true);
    ui.name.focus();
  }

  function formProperties(existing = {}) {
    return {
      ...existing,
      id: existing.id || (draft ? draft.id : selectedId),
      name: ui.name.value.trim(),
      crop: ui.crop.value.trim(),
      variety: ui.variety.value.trim(),
      year: ui.year.value ? Number(ui.year.value) : '',
      yield: ui.yield.value ? Number(ui.yield.value) : '',
      note: ui.note.value.trim()
    };
  }

  ui.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!ui.form.reportValidity()) return;
    if (!isReady || !supabase) {
      setStatus('Нет соединения с Supabase. Поле не сохранено; повторите загрузку и попробуйте снова.', 'error', true);
      return;
    }
    const isNew = Boolean(draft);
    const field = isNew ? draft : fields.get(selectedId);
    if (!field) return;
    const properties = formProperties(field.feature.properties);
    const payload = featureToRow(field.feature, properties);
    ui.save.disabled = true;
    ui.delete.disabled = true;
    setStatus(isNew ? 'Сохраняем новое поле в Supabase…' : 'Сохраняем изменения в Supabase…', 'loading');
    try {
      const user = await requireUser();
      if (!user) return;
      let query = isNew
        ? supabase.from(TABLE).insert(payload)
        : supabase.from(TABLE).update(payload).eq('id', field.id);
      const { data, error } = await query.select(SELECT_COLUMNS).single();
      if (error) throw error;
      const savedFeature = rowToFeature(data);
      if (isNew) {
        const savedId = String(data.id);
        const savedLayer = makeLayer(savedFeature, savedId).addTo(fieldsLayer);
        map.removeLayer(draft.layer);
        fields.set(savedId, { id: savedId, feature: savedFeature, layer: savedLayer });
        draft = null;
        selectedId = savedId;
      } else {
        field.layer.remove();
        field.feature = savedFeature;
        field.layer = makeLayer(savedFeature, field.id).addTo(fieldsLayer);
      }
      updateStyles();
      fillForm(fields.get(selectedId), false);
      renderFieldsList();
      setStatus(isNew ? 'Поле сохранено в Supabase.' : 'Изменения сохранены в Supabase.', 'success');
      window.setTimeout(() => { if (ui.status.classList.contains('is-success')) ui.status.hidden = true; }, 3500);
    } catch (error) {
      console.error('Ошибка сохранения поля Supabase:', error);
      const detail = formatSupabaseError(error);
      const operation = isNew ? 'INSERT' : 'UPDATE';
      const policy = isRlsError(error) ? ` Проверьте членство в хозяйстве и RLS-policy ${operation} для authenticated на public.fields.` : ' Проверьте подключение и ограничения таблицы.';
      setStatus(`Не удалось сохранить поле: ${detail}.${policy}`, 'error', true);
    } finally {
      ui.save.disabled = false;
      ui.delete.disabled = false;
    }
  });

  function resetCard() {
    ui.seasonModal.hidden = true;
    ui.form.hidden = true;
    ui.emptyState.hidden = false;
  }

  function clearSelection() {
    if (draft) cancelDraft();
    else { selectedId = null; updateStyles(); resetCard(); }
  }

  async function deleteSelectedField() {
    const field = fields.get(selectedId);
    if (!field) return;
    if (!window.confirm(`Удалить «${field.feature.properties.name || 'Поле'}»? Это действие нельзя отменить.`)) return;
    if (!isReady || !supabase) {
      setStatus('Нет соединения с Supabase. Поле не удалено.', 'error', true);
      return;
    }
    const deletedId = selectedId;
    ui.delete.disabled = true;
    setStatus('Удаляем поле из Supabase…', 'loading');
    try {
      const user = await requireUser();
      if (!user) return;
      const { data, error } = await supabase.from(TABLE).delete().eq('id', deletedId).select('id').single();
      if (error) throw error;
      if (!data) throw new Error('Запись не найдена или удаление запрещено политикой доступа.');
      fieldsLayer.removeLayer(field.layer);
      fields.delete(deletedId);
      selectedId = null;
      resetCard();
      renderFieldsList();
      setStatus('Поле удалено из Supabase.', 'success');
      window.setTimeout(() => { if (ui.status.classList.contains('is-success')) ui.status.hidden = true; }, 3500);
    } catch (error) {
      console.error('Ошибка удаления поля Supabase:', error);
      const detail = formatSupabaseError(error);
      const policy = isRlsError(error) ? ' Проверьте членство в хозяйстве и RLS-policy DELETE для authenticated на public.fields.' : ' Проверьте подключение и ограничения таблицы.';
      setStatus(`Не удалось удалить поле: ${detail}.${policy}`, 'error', true);
    } finally {
      ui.delete.disabled = false;
    }
  }

  ui.add.addEventListener('click', () => { if (isReady) startDrawing(); });
  ui.emptyAdd.addEventListener('click', () => { if (isReady) startDrawing(); });
  $('#cancel-field').addEventListener('click', cancelDraft);
  $('#cancel-add').addEventListener('click', () => {
    stopDrawing();
    ui.emptyState.hidden = false;
  });
  $('#clear-selection').addEventListener('click', clearSelection);
  ui.delete.addEventListener('click', deleteSelectedField);
  ui.cropDirectory.addEventListener('click', openCropDirectory);
  ui.cropClose.addEventListener('click', () => { ui.cropModal.hidden = true; });
  $('#crop-cancel').addEventListener('click', () => { ui.cropModal.hidden = true; });
  ui.cropModal.addEventListener('click', (event) => { if (event.target === ui.cropModal) ui.cropModal.hidden = true; });
  ui.cropForm.addEventListener('submit', saveCrop);
  ui.cropTab.addEventListener('click', () => setDirectoryView('crops'));
  ui.technologyTab.addEventListener('click', () => setDirectoryView('technologies'));
  ui.technologyBackList.addEventListener('click', () => {
    ui.technologyDetails.hidden = true;
    ui.technologyList.hidden = false;
  });
  ui.technologyList.addEventListener('click', (event) => {
    const row = event.target.closest('[data-technology-id]');
    if (row) void openTechnologyDetails(row.dataset.technologyId);
  });
    ui.seasonAdd.addEventListener('click', openSeasonForm);
  $('#season-close').addEventListener('click', () => { ui.seasonModal.hidden = true; });
  $('#season-cancel').addEventListener('click', () => { ui.seasonModal.hidden = true; });
  ui.seasonModal.addEventListener('click', (event) => { if (event.target === ui.seasonModal) ui.seasonModal.hidden = true; });
  ui.seasonForm.addEventListener('submit', saveSeason);
  ui.seasonCrop.addEventListener('change', async () => {
    seasonLookupBlocked = false;
    try {
      await loadSeasonVarieties(ui.seasonCrop.value);
      ui.seasonSave.disabled = seasonCrops.length === 0 || !isReady || seasonLookupBlocked;
    } catch (error) {
      console.error('Ошибка загрузки сортов:', error);
      const detail = formatSupabaseError(error);
      const policy = isRlsError(error) ? ' Проверьте членство и RLS-policy SELECT для authenticated на public.varieties.' : '';
      showSeasonFormMessage(`Не удалось загрузить сорта: ${detail}.${policy}`, 'error');
      setStatus(`Ошибка чтения public.varieties: ${detail}.${policy}`, 'error', false);
      seasonLookupBlocked = true;
      ui.seasonSave.disabled = true;
    }
  });
  $('#dismiss-hint').addEventListener('click', () => { ui.hint.hidden = true; });
  map.on(L.Draw.Event.CREATED, (event) => newDraft(event.layer));
  map.on(L.Draw.Event.DRAWSTOP, () => {
    if (!drawHandler) return;
    drawHandler = null;
    ui.drawBanner.hidden = true;
    ui.add.classList.remove('is-active');
    map.getContainer().style.cursor = '';
    if (ui.form.hidden) ui.emptyState.hidden = false;
  });

  ui.myFields.addEventListener('click', () => {
    if (!isReady) return;
    openFieldsList();
  });
  ui.farmSelector.addEventListener('change', () => {
    activeFarmId = ui.farmSelector.value || null;
    updateSelectedFarmRole();
    clearRenderedFields();
    selectedId = null;
    draft = null;
    resetCard();
    if (activeFarmId) void loadFieldsFromSupabase();
    else setDataActionsEnabled(false);
  });
  $('#fields-list-close').addEventListener('click', openFieldDetails);
  ui.fieldsSearch.addEventListener('input', renderFieldsList);
  ui.cropFilter.addEventListener('change', renderFieldsList);
  ui.yearFilter.addEventListener('change', renderFieldsList);
  ui.layersToggle.addEventListener('click', () => {
    const control = layerControl.getContainer();
    const isExpanded = control.classList.contains('leaflet-control-layers-expanded');
    if (isExpanded) layerControl.collapse();
    else layerControl.expand();
    ui.layersToggle.setAttribute('aria-expanded', String(!isExpanded));
  });
  ui.searchToggle.addEventListener('click', () => {
    const open = ui.searchPanel.hidden;
    ui.searchPanel.hidden = !open;
    ui.searchToggle.setAttribute('aria-expanded', String(open));
    if (open) $('#map-search').focus();
  });
  ui.searchPanel.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('#map-search');
    input.setCustomValidity(input.value.trim() ? 'Поиск по адресу появится в следующем обновлении.' : 'Введите название места.');
    input.reportValidity();
    input.setCustomValidity('');
  });

  ui.retry.addEventListener('click', loadFieldsFromSupabase);
  ui.authControl.addEventListener('click', () => {
    if (authenticatedUser) void signOutCurrentUser();
    else showAuthForm('login');
  });
  ui.authClose.addEventListener('click', () => { if (!authenticatedUser) ui.authModal.hidden = true; });
  ui.authModal.addEventListener('click', (event) => {
    if (event.target === ui.authModal && !authenticatedUser) ui.authModal.hidden = true;
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !authenticatedUser && !ui.authModal.hidden) ui.authModal.hidden = true;
  });
  ui.authModeLogin.addEventListener('click', () => setAuthMode('login'));
  ui.authModeRegister.addEventListener('click', () => setAuthMode('register'));
  ui.authForm.addEventListener('submit', submitAuth);
  ui.openFarmCreate.addEventListener('click', showFarmCreateForm);
  ui.noFarmLogout.addEventListener('click', signOutCurrentUser);
  ui.farmCreateForm.addEventListener('submit', createFarm);
  ui.farmCreateCancel.addEventListener('click', showNoFarmState);
  ui.authRetry.addEventListener('click', () => {
    showAuthLoading();
    void loadFieldsFromSupabase();
  });
  setDataActionsEnabled(false);
  updateAuthControl();
  initializeSupabase();
  window.addEventListener('resize', () => map.invalidateSize({ pan: false }));
  window.fieldManagerMap = { map, osmLayer, satelliteLayer, layerControl, fields, fieldsLayer, areaHectares, loadFieldsFromSupabase, renderFieldsList };
  window.fieldManagerAuth = Object.freeze({
    getCurrentUser,
    requireUser,
    getSession: () => currentSession,
    getLastAuthEvent: () => lastAuthEvent
  });
})();

