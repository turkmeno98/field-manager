/* MVP: карта и данные текущей сессии. */
(() => {
  'use strict';
  const map = L.map('map', { zoomControl: false, preferCanvas: true }).setView([55.75, 37.62], 5);
  const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(map);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  const fields = [];
  let addingField = false;
  let nextFieldNumber = 1;
  const $ = (selector) => document.querySelector(selector);
  const ui = { add: $('#add-field'), emptyAdd: $('#empty-add-field'), myFields: $('#my-fields'), layersToggle: $('#layers-toggle'), layersPanel: $('#layers-panel'), searchToggle: $('#search-toggle'), searchPanel: $('#search-panel'), hint: $('#map-hint'), drawBanner: $('#draw-banner'), emptyState: $('#empty-state'), fieldInfo: $('#field-info') };

  function setAddingField(enabled) {
    addingField = enabled;
    ui.drawBanner.hidden = !enabled;
    ui.add.classList.toggle('is-active', enabled);
    map.getContainer().style.cursor = enabled ? 'crosshair' : '';
  }
  function showField(field) {
    ui.emptyState.hidden = true;
    ui.fieldInfo.hidden = false;
    $('#field-name').textContent = field.name;
    $('#field-coordinates').textContent = `${field.lat.toFixed(5)}, ${field.lng.toFixed(5)}`;
  }
  function resetSelection() { ui.fieldInfo.hidden = true; ui.emptyState.hidden = false; }
  function addFieldAt(latlng) {
    const field = { id: nextFieldNumber, name: `Поле ${nextFieldNumber}`, lat: latlng.lat, lng: latlng.lng };
    nextFieldNumber += 1;
    field.marker = L.circleMarker(latlng, { radius: 8, color: '#fff', weight: 2, fillColor: '#39734b', fillOpacity: 1 }).addTo(map);
    field.marker.bindTooltip(field.name, { direction: 'top', offset: [0, -8] });
    field.marker.on('click', () => showField(field));
    fields.push(field);
    showField(field);
    setAddingField(false);
  }
  ui.add.addEventListener('click', () => setAddingField(!addingField));
  ui.emptyAdd.addEventListener('click', () => setAddingField(true));
  $('#cancel-add').addEventListener('click', () => setAddingField(false));
  map.on('click', (event) => { if (addingField) addFieldAt(event.latlng); });
  $('#clear-selection').addEventListener('click', resetSelection);
  $('#dismiss-hint').addEventListener('click', () => { ui.hint.hidden = true; });
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
  ui.myFields.addEventListener('click', () => {
    if (!fields.length) {
      ui.emptyState.querySelector('h2').textContent = 'Пока нет добавленных полей';
      ui.emptyState.querySelector('p').textContent = 'Нажмите «Добавить поле», а затем выберите место на карте.';
      ui.emptyState.hidden = false;
      ui.fieldInfo.hidden = true;
      return;
    }
    const group = L.featureGroup(fields.map((field) => field.marker));
    map.fitBounds(group.getBounds().pad(0.25), { maxZoom: 13 });
    showField(fields[fields.length - 1]);
  });
  // Слой вынесен отдельно, чтобы позже подключить спутниковую подложку и наложения.
  window.fieldManagerMap = { map, osmLayer, fields };
})();
