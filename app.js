/* Drawing, geodesic area and Supabase-backed GeoJSON field records. */
(() => {
  'use strict';

  const TABLE = 'fields';
  const SELECT_COLUMNS = 'id,name,area_ha,crop,variety,year,yield_c_ha,notes,geometry,created_at,updated_at';
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
  let loadInProgress = false;
  let draft = null;
  let selectedId = null;
  let drawHandler = null;
  let nextFieldNumber = 1;
  const $ = (selector) => document.querySelector(selector);
  const ui = {
    add: $('#add-field'), emptyAdd: $('#empty-add-field'), myFields: $('#my-fields'),
    layersToggle: $('#layers-toggle'),
    searchToggle: $('#search-toggle'), searchPanel: $('#search-panel'),
    hint: $('#map-hint'), drawBanner: $('#draw-banner'), emptyState: $('#empty-state'),
    status: $('#sync-status'), statusText: $('.sync-status-text'), retry: $('#retry-sync'),
    form: $('#field-form'), name: $('#field-name'), area: $('#field-area'),
    crop: $('#field-crop'), variety: $('#field-variety'), year: $('#field-year'),
    yield: $('#field-yield'), note: $('#field-note'), heading: $('#field-card-heading'),
    caption: $('#field-caption'), save: $('#save-field'), delete: $('#delete-field')
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

  function rowToFeature(row) {
    let geometry = row.geometry;
    if (typeof geometry === 'string') geometry = JSON.parse(geometry);
    if (geometry?.type === 'Feature') geometry = geometry.geometry;
    if (geometry?.type !== 'Polygon' || !Array.isArray(geometry.coordinates)) {
      throw new Error(`У поля «${row.name || row.id}» отсутствует корректная GeoJSON Polygon геометрия.`);
    }
    return createFeature(geometry, {
      id: String(row.id), name: row.name || '', crop: row.crop || '', variety: row.variety || '',
      year: row.year ?? '', yield: row.yield_c_ha ?? '', note: row.notes || ''
    });
  }

  function featureToRow(feature, properties = feature.properties) {
    return {
      name: properties.name,
      area_ha: areaHectares(feature.geometry),
      crop: properties.crop || null,
      variety: properties.variety || null,
      year: properties.year === '' || properties.year == null ? null : Number(properties.year),
      yield_c_ha: properties.yield === '' || properties.yield == null ? null : Number(properties.yield),
      notes: properties.note || null,
      geometry: feature.geometry
    };
  }

  function renderFeature(feature) {
    const id = String(feature.properties.id);
    const layer = makeLayer(feature, id).addTo(fieldsLayer);
    fields.set(id, { id, feature, layer });
  }

  function clearRenderedFields() {
    fieldsLayer.clearLayers();
    fields.clear();
    selectedId = null;
  }

  function setDataActionsEnabled(enabled) {
    isReady = enabled;
    ui.add.disabled = !enabled;
    ui.emptyAdd.disabled = !enabled;
    ui.myFields.disabled = !enabled;
  }

  async function loadFieldsFromSupabase() {
    if (!supabase || loadInProgress) return;
    loadInProgress = true;
    setDataActionsEnabled(false);
    setStatus('Загружаем поля из Supabase…', 'loading');
    try {
      const { data, error } = await supabase.from(TABLE).select(SELECT_COLUMNS).order('created_at', { ascending: false });
      if (error) throw error;
      clearRenderedFields();
      const invalidRows = [];
      for (const row of data || []) {
        try { renderFeature(rowToFeature(row)); }
        catch (error) { invalidRows.push(error.message); }
      }
      setDataActionsEnabled(true);
      if (invalidRows.length) {
        setStatus(`Загружено ${fields.size} полей. Пропущено записей с ошибочной геометрией: ${invalidRows.length}. ${invalidRows[0]}`, 'error', true);
      } else {
        setStatus(fields.size ? `Загружено полей: ${fields.size}` : 'Подключено к Supabase. Полей пока нет.', 'success');
        window.setTimeout(() => { if (ui.status.classList.contains('is-success')) ui.status.hidden = true; }, 4500);
      }
      ui.emptyState.hidden = false;
      ui.form.hidden = true;
    } catch (error) {
      console.error('Ошибка загрузки полей Supabase:', error);
      setDataActionsEnabled(false);
      setStatus(`Не удалось загрузить поля: ${formatSupabaseError(error)}. Проверьте ключ, доступ к Data API и RLS-политики таблицы public.fields.`, 'error', true);
    } finally {
      loadInProgress = false;
    }
  }

  function initializeSupabase() {
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
      supabase = window.supabase.createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
      loadFieldsFromSupabase();
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
    ui.emptyState.hidden = true;
    ui.form.hidden = false;
  }

  function selectField(id) {
    const field = fields.get(id);
    if (!field) return;
    draft = null;
    selectedId = id;
    updateStyles();
    fillForm(field, false);
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
    const feature = createFeature(geometry, { id, name: `Поле ${nextFieldNumber}`, crop: '', variety: '', year: '', yield: '', note: '' });
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
      setStatus(isNew ? 'Поле сохранено в Supabase.' : 'Изменения сохранены в Supabase.', 'success');
      window.setTimeout(() => { if (ui.status.classList.contains('is-success')) ui.status.hidden = true; }, 3500);
    } catch (error) {
      console.error('Ошибка сохранения поля Supabase:', error);
      setStatus(`Не удалось сохранить поле: ${formatSupabaseError(error)}. Проверьте разрешения INSERT/UPDATE и RLS-политики.`, 'error', true);
    } finally {
      ui.save.disabled = false;
      ui.delete.disabled = false;
    }
  });

  function resetCard() {
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
      const { data, error } = await supabase.from(TABLE).delete().eq('id', deletedId).select('id').single();
      if (error) throw error;
      if (!data) throw new Error('Запись не найдена или удаление запрещено политикой доступа.');
      fieldsLayer.removeLayer(field.layer);
      fields.delete(deletedId);
      selectedId = null;
      resetCard();
      setStatus('Поле удалено из Supabase.', 'success');
      window.setTimeout(() => { if (ui.status.classList.contains('is-success')) ui.status.hidden = true; }, 3500);
    } catch (error) {
      console.error('Ошибка удаления поля Supabase:', error);
      setStatus(`Не удалось удалить поле: ${formatSupabaseError(error)}. Проверьте разрешение DELETE и RLS-политику.`, 'error', true);
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
    if (!fields.size) {
      ui.emptyState.querySelector('h2').textContent = 'Пока нет добавленных полей';
      ui.emptyState.querySelector('p').textContent = 'Нажмите «Добавить поле» и обведите границу на карте.';
      ui.emptyState.hidden = false;
      ui.form.hidden = true;
      return;
    }
    map.fitBounds(fieldsLayer.getBounds().pad(0.12), { maxZoom: 15 });
    const first = fields.values().next().value;
    selectField(first.id);
  });
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
  setDataActionsEnabled(false);
  initializeSupabase();
  window.addEventListener('resize', () => map.invalidateSize({ pan: false }));
  window.fieldManagerMap = { map, osmLayer, satelliteLayer, layerControl, fields, fieldsLayer, areaHectares, loadFieldsFromSupabase };
})();
