/* Drawing, geodesic area and browser-local GeoJSON storage for the field manager MVP. */
(() => {
  'use strict';

  const STORAGE_KEY = 'field-manager.geojson.v1';
  const EARTH_RADIUS_METERS = 6371008.8;
  const map = L.map('map', { zoomControl: false, preferCanvas: true }).setView([55.75, 37.62], 5);
  const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);
  L.control.zoom({ position: 'bottomright' }).addTo(map);

  const fieldsLayer = L.featureGroup().addTo(map);
  const fields = new Map();
  let draft = null;
  let selectedId = null;
  let drawHandler = null;
  let nextFieldNumber = 1;
  const $ = (selector) => document.querySelector(selector);
  const ui = {
    add: $('#add-field'), emptyAdd: $('#empty-add-field'), myFields: $('#my-fields'),
    layersToggle: $('#layers-toggle'), layersPanel: $('#layers-panel'),
    searchToggle: $('#search-toggle'), searchPanel: $('#search-panel'),
    hint: $('#map-hint'), drawBanner: $('#draw-banner'), emptyState: $('#empty-state'),
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

  function readStoredFeatures() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{"type":"FeatureCollection","features":[]}');
      if (saved.type !== 'FeatureCollection' || !Array.isArray(saved.features)) return [];
      return saved.features.filter((feature) => feature?.type === 'Feature' && feature.geometry?.type === 'Polygon');
    } catch (error) {
      console.warn('Не удалось прочитать сохранённые поля:', error);
      return [];
    }
  }

  function persistFields() {
    const collection = { type: 'FeatureCollection', features: [...fields.values()].map((field) => field.feature) };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(collection));
      return true;
    } catch (error) {
      console.error('Не удалось сохранить поля в браузере:', error);
      window.alert('Не удалось сохранить поле в браузере. Проверьте свободное место и настройки хранилища.');
      return false;
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

  ui.form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!ui.form.reportValidity()) return;
    if (draft) {
      draft.feature.properties = formProperties(draft.feature.properties);
      const layer = makeLayer(draft.feature, draft.id).addTo(fieldsLayer);
      fields.set(draft.id, { id: draft.id, feature: draft.feature, layer });
      map.removeLayer(draft.layer);
      selectedId = draft.id;
      draft = null;
      updateStyles();
      if (!persistFields()) {
        const item = fields.get(selectedId);
        if (item) fieldsLayer.removeLayer(item.layer);
        fields.delete(selectedId);
        selectedId = null;
        resetCard();
        return;
      }
      fillForm(fields.get(selectedId), false);
      return;
    }
    const field = fields.get(selectedId);
    if (!field) return;
    field.feature.properties = formProperties(field.feature.properties);
    field.layer.remove();
    field.layer = makeLayer(field.feature, field.id).addTo(fieldsLayer);
    updateStyles();
    persistFields();
    fillForm(field, false);
  });

  function resetCard() {
    ui.form.hidden = true;
    ui.emptyState.hidden = false;
  }

  function clearSelection() {
    if (draft) cancelDraft();
    else { selectedId = null; updateStyles(); resetCard(); }
  }

  function deleteSelectedField() {
    const field = fields.get(selectedId);
    if (!field) return;
    if (!window.confirm(`Удалить «${field.feature.properties.name || 'Поле'}»? Это действие нельзя отменить.`)) return;
    fieldsLayer.removeLayer(field.layer);
    fields.delete(selectedId);
    selectedId = null;
    persistFields();
    resetCard();
  }

  function loadFields() {
    for (const feature of readStoredFeatures()) {
      const id = String(feature.properties?.id || `field-${nextFieldNumber}`);
      feature.properties = { name: `Поле ${nextFieldNumber}`, crop: '', variety: '', year: '', yield: '', note: '', ...feature.properties, id };
      const layer = makeLayer(feature, id).addTo(fieldsLayer);
      fields.set(id, { id, feature, layer });
      nextFieldNumber += 1;
    }
  }

  ui.add.addEventListener('click', startDrawing);
  ui.emptyAdd.addEventListener('click', startDrawing);
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
    const open = ui.layersPanel.hidden;
    ui.layersPanel.hidden = !open;
    ui.layersToggle.setAttribute('aria-expanded', String(open));
    ui.searchPanel.hidden = true;
    ui.searchToggle.setAttribute('aria-expanded', 'false');
  });
  ui.searchToggle.addEventListener('click', () => {
    const open = ui.searchPanel.hidden;
    ui.searchPanel.hidden = !open;
    ui.searchToggle.setAttribute('aria-expanded', String(open));
    ui.layersPanel.hidden = true;
    ui.layersToggle.setAttribute('aria-expanded', 'false');
    if (open) $('#map-search').focus();
  });
  ui.searchPanel.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('#map-search');
    input.setCustomValidity(input.value.trim() ? 'Поиск по адресу появится в следующем обновлении.' : 'Введите название места.');
    input.reportValidity();
    input.setCustomValidity('');
  });

  loadFields();
  window.fieldManagerMap = { map, osmLayer, fields, areaHectares };
})();
