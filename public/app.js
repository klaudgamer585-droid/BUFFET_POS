const state = {
  snapshot: null,
  selectedTableId: null,
  selectedPromoId: null,
  customDiscountPct: 0,
  lastReceipt: null,
  salesPage: 1,
  salesTotalPages: 0,
  salesRows: [],
  databaseTable: 'sales',
  databasePage: 1,
  databaseTotalPages: 0,
  databaseRecords: [],
  databaseSearch: '',
  databaseAuthenticated: false
};

const $ = (selector) => document.querySelector(selector);
const money = (value) => new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(Number(value) || 0);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || 'The request could not be completed.');
  return result;
}

async function refreshSalesSummary() {
  try {
    const summary = await api('/api/sales/summary');
    $('#earningsMetric').textContent = money(summary.earnings);
    $('#guestsServedMetric').textContent = summary.guestCount.toLocaleString();
    $('#salesCountMetric').textContent = `Across ${summary.saleCount.toLocaleString()} completed sales`;
  } catch (error) {
    notify(`Could not load sales totals: ${error.message}`, true);
  }
}

function salesFilters() {
  const form = $('#salesFilterForm');
  const values = new FormData(form);
  return {
    search: String(values.get('search') || '').trim(),
    startDate: String(values.get('startDate') || ''),
    endDate: String(values.get('endDate') || ''),
    source: String(values.get('source') || 'all')
  };
}

async function loadSales(page = 1) {
  const filters = salesFilters();
  const timezoneOffset = String(new Date().getTimezoneOffset());
  const query = new URLSearchParams({ ...filters, timezoneOffset, page: String(page), pageSize: '25' });
  const summaryQuery = new URLSearchParams({
    startDate: filters.startDate,
    endDate: filters.endDate,
    timezoneOffset,
    source: filters.source
  });
  $('#salesResultsStatus').textContent = 'Loading sales…';
  $('#salesPreviousButton').disabled = true;
  $('#salesNextButton').disabled = true;
  try {
    const [result, summary] = await Promise.all([
      api(`/api/sales?${query}`),
      api(`/api/sales/summary?${summaryQuery}`)
    ]);
    state.salesRows = result.sales;
    state.salesPage = result.page;
    state.salesTotalPages = result.totalPages;
    $('#salesEarningsMetric').textContent = money(summary.earnings);
    $('#salesCountValue').textContent = summary.saleCount.toLocaleString();
    $('#salesGuestsMetric').textContent = summary.guestCount.toLocaleString();
    $('#salesResultsStatus').textContent = `${result.totalCount.toLocaleString()} matching sale${result.totalCount === 1 ? '' : 's'}`;
    $('#salesPageLabel').textContent = `Page ${result.totalPages ? result.page : 0} of ${result.totalPages}`;
    $('#salesPreviousButton').disabled = result.page <= 1;
    $('#salesNextButton').disabled = result.page >= result.totalPages;
    renderSalesRows();
  } catch (error) {
    $('#salesResultsStatus').textContent = 'Could not load sales.';
    notify(error.message, true);
  }
}

function setDatabaseAdminAccess(authenticated) {
  state.databaseAuthenticated = authenticated;
  $('#databaseLoginPanel').classList.toggle('hidden', authenticated);
  $('#databaseAdminPanel').classList.toggle('hidden', !authenticated);
  $('#databaseLogoutButton').classList.toggle('hidden', !authenticated);
  $('#refreshDatabaseButton').classList.toggle('hidden', !authenticated);
  if (authenticated) loadDatabaseRecords(1);
}

async function openDatabaseAdmin() {
  const loginForm = $('#databaseLoginForm');
  loginForm.classList.add('hidden');
  $('#databaseLoginMessage').textContent = 'Checking admin access…';
  $('#databaseLoginMessage').classList.remove('error-text');
  setDatabaseAdminAccess(false);
  try {
    const session = await api('/api/admin/session');
    if (!session.configured) {
      $('#databaseLoginMessage').textContent = 'Database admin is disabled. Set ADMIN_PASSWORD to a password of at least 12 characters, then restart the server.';
      return;
    }
    if (session.authenticated) {
      setDatabaseAdminAccess(true);
      return;
    }
    $('#databaseLoginMessage').textContent = 'Sign in with the admin password configured for this server.';
    $('#databaseAdminUsername').value = session.username || 'admin';
    loginForm.classList.remove('hidden');
  } catch (error) {
    $('#databaseLoginMessage').textContent = error.message;
    $('#databaseLoginMessage').classList.add('error-text');
  }
}

async function loadDatabaseRecords(page = 1) {
  const table = state.databaseTable;
  const query = new URLSearchParams({
    page: String(page),
    search: state.databaseSearch
  });
  $('#databaseRecordsStatus').textContent = 'Loading database records…';
  $('#databasePreviousButton').disabled = true;
  $('#databaseNextButton').disabled = true;
  try {
    const result = await api(`/api/admin/records/${table}?${query}`);
    if (result.totalPages && page > result.totalPages) return loadDatabaseRecords(result.totalPages);
    state.databaseRecords = result.records;
    state.databasePage = result.page;
    state.databaseTotalPages = result.totalPages;
    renderDatabaseRecords();
    $('#databaseRecordsStatus').textContent = `${result.totalCount.toLocaleString()} ${databaseRecordLabel(table)}${result.totalCount === 1 ? '' : 's'}${state.databaseSearch ? ' matching the search' : ''}`;
    $('#databasePageLabel').textContent = `Page ${result.totalPages ? result.page : 0} of ${result.totalPages}`;
    $('#databasePreviousButton').disabled = result.page <= 1;
    $('#databaseNextButton').disabled = result.page >= result.totalPages;
  } catch (error) {
    $('#databaseRecordsStatus').textContent = 'Could not load database records.';
    handleExpiredDatabaseSession(error);
    notify(error.message, true);
  }
}

function databaseRecordLabel(table) {
  return { sales: 'sale', 'dish-costs': 'dish-cost entry', dishes: 'saved dish' }[table] || 'record';
}

function handleExpiredDatabaseSession(error) {
  if (error.message !== 'Admin sign-in is required.') return false;
  setDatabaseAdminAccess(false);
  $('#databaseLoginMessage').textContent = 'Your admin session expired. Sign in again.';
  $('#databaseLoginForm').classList.remove('hidden');
  return true;
}

function renderDatabaseRecords() {
  const table = state.databaseTable;
  const headings = {
    sales: ['Date & time', 'Receipt', 'Type', 'Guests', 'Payment', 'Total', 'Actions'],
    'dish-costs': ['Business date', 'Dish', 'Total cost', 'Actions'],
    dishes: ['Dish', 'Default cost', 'Last updated', 'Actions']
  }[table];
  $('#databaseRecordsHead').innerHTML = `<tr>${headings.map((heading) => `<th scope="col">${heading}</th>`).join('')}</tr>`;
  const body = $('#databaseRecordsBody');
  if (!state.databaseRecords.length) {
    body.innerHTML = `<tr><td class="sales-empty" colspan="${headings.length}">No ${databaseRecordLabel(table)}s found.</td></tr>`;
    return;
  }

  body.innerHTML = state.databaseRecords.map((record) => {
    const actions = `<div class="database-actions">
      <button class="button subtle" type="button" data-database-edit="${escapeHtml(record.id)}">Edit</button>
      <button class="button subtle database-delete-button" type="button" data-database-delete="${escapeHtml(record.id)}">Delete</button>
    </div>`;
    if (table === 'sales') {
      const date = new Date(record.createdAt);
      const dateLabel = Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleString();
      return `<tr>
        <td>${escapeHtml(dateLabel)}</td>
        <td class="sale-id-cell">${escapeHtml(record.id)}</td>
        <td>${record.source === 'menu' ? 'Menu' : 'Buffet'}</td>
        <td>${Number(record.guestCount) || 0}</td>
        <td>${escapeHtml(record.paymentMethod || '—')}</td>
        <td class="sale-total-cell">${money(record.total)}</td>
        <td>${actions}</td>
      </tr>`;
    }
    if (table === 'dish-costs') {
      return `<tr>
        <td>${escapeHtml(record.businessDate)}</td>
        <td class="sale-id-cell">${escapeHtml(record.dish)}</td>
        <td class="sale-total-cell">${money(record.totalCost)}</td>
        <td>${actions}</td>
      </tr>`;
    }
    const date = new Date(record.updatedAt);
    const dateLabel = Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
    return `<tr>
      <td class="sale-id-cell">${escapeHtml(record.dish)}</td>
      <td class="sale-total-cell">${money(record.defaultCost)}</td>
      <td>${escapeHtml(dateLabel)}</td>
      <td>${actions}</td>
    </tr>`;
  }).join('');

  body.querySelectorAll('[data-database-edit]').forEach((button) => {
    button.addEventListener('click', () => openDatabaseRecordEditor(button.dataset.databaseEdit));
  });
  body.querySelectorAll('[data-database-delete]').forEach((button) => {
    button.addEventListener('click', () => deleteDatabaseRecord(button.dataset.databaseDelete));
  });
}

function localDateTimeValue(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function openDatabaseRecordEditor(id) {
  const record = state.databaseRecords.find((entry) => entry.id === id);
  if (!record) return;
  const table = state.databaseTable;
  const form = $('#databaseRecordForm');
  $('#databaseRecordTitle').textContent = `Edit ${databaseRecordLabel(table)}`;
  form.dataset.recordId = record.id;

  if (table === 'sales') {
    form.innerHTML = `
      <label>Sale date and time<input name="createdAt" type="datetime-local" value="${escapeHtml(localDateTimeValue(record.createdAt))}" required /></label>
      <label>Payment method<select name="paymentMethod" required>
        <option value="cash" ${record.paymentMethod === 'cash' ? 'selected' : ''}>Cash</option>
        <option value="card" ${record.paymentMethod === 'card' ? 'selected' : ''}>Card</option>
        <option value="mobile" ${record.paymentMethod === 'mobile' ? 'selected' : ''}>Mobile wallet</option>
      </select></label>
      <label>Corrected total<input name="total" type="number" min="0" max="9999999999.99" step="0.01" value="${escapeHtml(record.total)}" required /></label>
      <p class="database-record-help">The stored discount is adjusted so the receipt's subtotal, service charge, tax, and corrected total remain consistent.</p>
      <p class="database-form-error" role="status" aria-live="polite"></p>
      <div class="database-form-actions"><button class="button subtle" type="button" data-close-database-record>Cancel</button><button class="button primary" type="submit">Save changes</button></div>`;
  } else if (table === 'dish-costs') {
    form.innerHTML = `
      <label>Business date<input name="businessDate" type="date" value="${escapeHtml(record.businessDate)}" required /></label>
      <label>Dish name<input name="dish" type="text" maxlength="80" value="${escapeHtml(record.dish)}" required /></label>
      <label>Total cost<span class="money-input"><b>₱</b><input name="totalCost" type="number" min="0" max="9999999999.99" step="0.01" value="${escapeHtml(record.totalCost)}" required /></span></label>
      <p class="database-form-error" role="status" aria-live="polite"></p>
      <div class="database-form-actions"><button class="button subtle" type="button" data-close-database-record>Cancel</button><button class="button primary" type="submit">Save changes</button></div>`;
  } else {
    form.innerHTML = `
      <label>Dish name<input name="dish" type="text" maxlength="80" value="${escapeHtml(record.dish)}" required /></label>
      <label>Default cost<span class="money-input"><b>₱</b><input name="defaultCost" type="number" min="0" max="9999999999.99" step="0.01" value="${escapeHtml(record.defaultCost)}" required /></span></label>
      <p class="database-form-error" role="status" aria-live="polite"></p>
      <div class="database-form-actions"><button class="button subtle" type="button" data-close-database-record>Cancel</button><button class="button primary" type="submit">Save changes</button></div>`;
  }
  form.querySelector('[data-close-database-record]').addEventListener('click', () => $('#databaseRecordDialog').close());
  $('#databaseRecordDialog').showModal();
}

async function saveDatabaseRecord(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  const payload = {};
  if (state.databaseTable === 'sales') {
    const dateValue = String(values.get('createdAt') || '');
    const saleDate = new Date(dateValue);
    if (!dateValue || Number.isNaN(saleDate.getTime())) {
      form.querySelector('.database-form-error').textContent = 'Enter a valid sale date and time.';
      return;
    }
    payload.createdAt = saleDate.toISOString();
    payload.paymentMethod = String(values.get('paymentMethod') || '');
    payload.total = Number(values.get('total'));
  } else if (state.databaseTable === 'dish-costs') {
    payload.businessDate = String(values.get('businessDate') || '');
    payload.dish = String(values.get('dish') || '').trim();
    payload.totalCost = Number(values.get('totalCost'));
  } else {
    payload.dish = String(values.get('dish') || '').trim();
    payload.defaultCost = Number(values.get('defaultCost'));
  }
  const error = form.querySelector('.database-form-error');
  error.textContent = '';
  try {
    await api(`/api/admin/records/${state.databaseTable}/${encodeURIComponent(form.dataset.recordId)}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
    $('#databaseRecordDialog').close();
    notify(`${databaseRecordLabel(state.databaseTable)} updated.`);
    await loadDatabaseRecords(state.databasePage);
    await refreshSalesSummary();
  } catch (saveError) {
    handleExpiredDatabaseSession(saveError);
    error.textContent = saveError.message;
  }
}

async function deleteDatabaseRecord(id) {
  const record = state.databaseRecords.find((entry) => entry.id === id);
  if (!record) return;
  const label = state.databaseTable === 'sales'
    ? `sale ${record.id} for ${money(record.total)}`
    : `${databaseRecordLabel(state.databaseTable)} "${record.dish}"`;
  if (!window.confirm(`Permanently delete ${label}? This cannot be undone.`)) return;
  try {
    await api(`/api/admin/records/${state.databaseTable}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    notify(`${databaseRecordLabel(state.databaseTable)} deleted.`);
    await loadDatabaseRecords(state.databasePage);
    await refreshSalesSummary();
  } catch (error) {
    handleExpiredDatabaseSession(error);
    notify(error.message, true);
  }
}

function salesGuestLabel(sale) {
  const categories = [
    [sale.adults, 'adult'],
    [sale.seniorCount, 'senior / PWD'],
    [sale.children, 'kid 3–4 ft'],
    [sale.freeChildCount, 'under 3 ft']
  ].filter(([count]) => Number(count) > 0)
    .map(([count, label]) => `${count} ${label}${Number(count) === 1 ? '' : 's'}`);
  return categories.length ? categories.join(', ') : `${Number(sale.guestCount ?? sale.paxCount ?? 0)} guests`;
}

function renderSalesRows() {
  const body = $('#salesTableBody');
  if (!state.salesRows.length) {
    body.innerHTML = '<tr><td class="sales-empty" colspan="7">No completed sales match these filters.</td></tr>';
    return;
  }
  body.innerHTML = state.salesRows.map((sale) => {
    const date = new Date(sale.createdAt);
    const dateLabel = Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleString();
    const saleType = sale.source === 'menu' ? 'Menu' : 'Buffet';
    const tableLabel = sale.tableId ? `${saleType} · ${sale.tableId}` : saleType;
    return `<tr>
      <td>${escapeHtml(dateLabel)}</td>
      <td class="sale-id-cell">${escapeHtml(sale.id)}</td>
      <td>${escapeHtml(tableLabel)}</td>
      <td>${escapeHtml(salesGuestLabel(sale))}</td>
      <td>${escapeHtml(sale.paymentMethod || '—')}</td>
      <td class="sale-total-cell">${money(sale.total)}</td>
      <td><button class="button subtle sale-details-button" type="button" data-sale-id="${escapeHtml(sale.id)}">Details</button></td>
    </tr>`;
  }).join('');
  body.querySelectorAll('[data-sale-id]').forEach((button) => {
    button.addEventListener('click', () => showSaleDetails(button.dataset.saleId));
  });
}

function showSaleDetails(saleId) {
  const sale = state.salesRows.find((entry) => entry.id === saleId);
  if (!sale) return;
  const date = new Date(sale.createdAt);
  const dateLabel = Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleString();
  const items = Array.isArray(sale.items) && sale.items.length
    ? `<div class="sale-detail-section"><h3>Items</h3>${sale.items.map((item) => `<div class="sale-detail-line"><span>${escapeHtml(item.name || 'Item')} × ${Number(item.quantity) || 1}</span><strong>${money(Number(item.price) * (Number(item.quantity) || 1))}</strong></div>`).join('')}</div>`
    : '';
  const categoryRows = [
    ['Adults', sale.adults],
    ['Senior / PWD', sale.seniorCount],
    ['Kids 3–4 ft', sale.children],
    ['Kids below 3 ft', sale.freeChildCount]
  ].filter(([, count]) => count !== null && count !== undefined);
  const guestRows = categoryRows.map(([label, count]) => `<div class="sale-detail-line"><span>${label}</span><strong>${Number(count)}</strong></div>`).join('');
  $('#saleDetailTitle').textContent = `Sale ${sale.id}`;
  $('#saleDetailContent').innerHTML = `
    <dl class="sale-detail-meta">
      <div><dt>Date</dt><dd>${escapeHtml(dateLabel)}</dd></div>
      <div><dt>Sale type</dt><dd>${sale.source === 'menu' ? 'Menu' : 'Buffet'}</dd></div>
      <div><dt>Table</dt><dd>${escapeHtml(sale.tableId || '—')}</dd></div>
      <div><dt>Payment</dt><dd>${escapeHtml(sale.paymentMethod || '—')}</dd></div>
      <div><dt>Guests</dt><dd>${Number(sale.guestCount ?? sale.paxCount ?? 0)}</dd></div>
    </dl>
    ${guestRows ? `<div class="sale-detail-section"><h3>Guest categories</h3>${guestRows}</div>` : ''}
    ${items}
    <div class="sale-detail-section">
      <h3>Payment summary</h3>
      <div class="sale-detail-line"><span>Subtotal</span><strong>${money(sale.subtotal)}</strong></div>
      <div class="sale-detail-line"><span>Discount</span><strong>−${money(sale.discountAmount)}</strong></div>
      <div class="sale-detail-line sale-detail-total"><span>Total paid</span><strong>${money(sale.total)}</strong></div>
    </div>`;
  $('#saleDetailDialog').showModal();
}

function notify(message, error = false) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.toggle('error', error);
  toast.classList.add('visible');
  clearTimeout(notify.timeout);
  notify.timeout = setTimeout(() => toast.classList.remove('visible'), 3200);
}

function selectedTable() {
  return state.snapshot?.tables.find((table) => table.id === state.selectedTableId) || null;
}

function selectedParty() {
  return selectedTable()?.party || null;
}

function currentDraft() {
  const table = selectedTable();
  if (!table || table.party) return null;
  const adults = Math.max(0, Number($('#adultInput').value) || 0);
  const seniorCount = Math.max(0, Number($('#seniorInput').value) || 0);
  const children = Math.max(0, Number($('#childInput').value) || 0);
  const freeChildCount = Math.max(0, Number($('#freeChildInput').value) || 0);
  return { adults, seniorCount, children, freeChildCount, paxCount: adults + seniorCount + children + freeChildCount };
}

function formatClock() {
  const now = new Date();
  $('#serviceClock').textContent = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  $('#todayLabel').textContent = now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

function renderSnapshot(snapshot) {
  state.snapshot = snapshot;
  const activeTables = snapshot.tables.filter((table) => table.party);
  const stockPct = snapshot.stockPct || 0;
  $('#dinersMetric').textContent = snapshot.totalDiners;
  $('#partyMetric').textContent = `Across ${activeTables.length} ${activeTables.length === 1 ? 'table' : 'tables'}`;
  $('#cleanMetric').textContent = snapshot.availableStock;
  $('#plateCapacityMetric').textContent = `of ${snapshot.plates.initialCleanStock} in opening stock`;
  $('#dirtyMetric').textContent = snapshot.plates.inDishwashing;
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const turnover = snapshot.plateEvents
    .filter((event) => event.type === 'bussed' && new Date(event.at).getTime() >= oneHourAgo)
    .reduce((sum, event) => sum + event.quantity, 0);
  $('#turnoverMetric').innerHTML = `${turnover}<span class="metric-unit">/hr</span>`;
  $('#stockCount').textContent = snapshot.availableStock;
  $('#setCleanForm').elements.quantity.value = snapshot.availableStock;
  $('#openingStock').textContent = snapshot.plates.initialCleanStock;
  $('#inUseCount').textContent = snapshot.plates.inUse;
  $('#inWashCount').textContent = snapshot.plates.inDishwashing;
  $('#markCleanButton').disabled = snapshot.plates.inDishwashing === 0;
  updateUnavailablePartyOptions();
  $('#thresholdInput').value = snapshot.plates.minimumThresholdPct;
  $('#stockProgress').style.width = `${Math.max(0, Math.min(100, stockPct))}%`;
  $('#stockProgress').classList.toggle('low', stockPct <= snapshot.plates.minimumThresholdPct);
  const isLow = stockPct <= snapshot.plates.minimumThresholdPct;
  $('#stockWarning').classList.toggle('hidden', !isLow);
  $('#stockWarningText').textContent = `${snapshot.availableStock} plates remain (${Math.floor(stockPct)}% of opening stock), below the ${snapshot.plates.minimumThresholdPct}% alert threshold.`;
  $('#tableCountLabel').textContent = `· ${snapshot.tables.length}`;
  renderTables();
  renderTableSelect();
  renderActivity();
  renderPartyWorkspace();
  renderPromos();
  renderPricing();
  renderEstimate();
}

function renderTables() {
  $('#tableGrid').innerHTML = state.snapshot.tables.map((table) => {
    const party = table.party;
    const selected = table.id === state.selectedTableId;
    const status = party ? `${party.paxCount} guests` : `${table.seats} seats`;
    return `<button type="button" class="table-tile ${party ? 'occupied' : 'available'} ${selected ? 'selected' : ''}" data-table-id="${escapeHtml(table.id)}" aria-pressed="${selected}">
      <span class="table-topline"><strong>${escapeHtml(table.id)}</strong><i class="table-state">${party ? 'Seated' : 'Open'}</i></span>
      <span class="table-visual" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
      <span class="table-bottomline"><span>${status}</span>${party ? `<span class="table-plate-count">${party.assignedPlates} plates</span>` : ''}</span>
    </button>`;
  }).join('');
  document.querySelectorAll('[data-table-id]').forEach((button) => {
    button.addEventListener('click', () => selectTable(button.dataset.tableId));
  });
}

function renderTableSelect() {
  const select = $('#tableSelect');
  const openTables = state.snapshot.tables.filter((table) => !table.party);
  select.innerHTML = openTables.map((table) => `<option value="${escapeHtml(table.id)}" ${table.id === state.selectedTableId ? 'selected' : ''}>${escapeHtml(table.id)} · ${table.seats} seats</option>`).join('');
  if (!openTables.some((table) => table.id === state.selectedTableId) && !selectedParty()) {
    state.selectedTableId = openTables[0]?.id || null;
    if (state.selectedTableId) select.value = state.selectedTableId;
  }
  select.disabled = !openTables.length;
}

function renderActivity() {
  const events = state.snapshot.plateEvents.slice(0, 5);
  $('#plateActivity').innerHTML = events.length ? events.map((event) => {
    const eventDetails = {
      bussed: { label: 'Plates bussed', icon: '↙', className: 'returned', sign: '+' },
      distributed: { label: 'Plates distributed', icon: '↗', className: '', sign: '−' },
      received: { label: 'Clean plates added', icon: '↗', className: '', sign: '+' },
      removed: { label: 'Clean plates removed', icon: '↙', className: 'returned', sign: '−' },
      unavailable: { label: 'Plates marked unavailable', icon: '×', className: 'returned', sign: '−' }
    }[event.type] || { label: 'Plate stock updated', icon: '↔', className: '', sign: '' };
    const details = eventDetails;
    const time = new Date(event.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const table = state.snapshot.parties.find((party) => party.id === event.partyId)?.tableId || '';
    const source = { clean: 'clean stock', 'in-use': 'in use', dishwashing: 'dishwashing' }[event.source];
    const context = table || source || '';
    const description = [context, event.reason].filter(Boolean).map(escapeHtml).join(' · ');
    return `<div class="activity-row"><span class="activity-icon ${details.className}">${details.icon}</span><div><strong>${details.label}</strong><small>${description ? `${description} · ` : ''}${time}</small></div><b>${details.sign}${event.quantity}</b></div>`;
  }).join('') : '<p class="empty-activity">Plate activity will appear here.</p>';
}

function updateUnavailablePartyOptions() {
  const source = $('#unavailableSource').value;
  const partyField = $('#unavailablePartyField');
  const partySelect = $('#unavailableParty');
  const partyOptions = state.snapshot.tables
    .filter((table) => table.party && table.party.assignedPlates > 0)
    .map((table) => `<option value="${escapeHtml(table.party.id)}">${escapeHtml(table.id)} · ${table.party.assignedPlates} plates</option>`);
  partyField.classList.toggle('hidden', source !== 'in-use');
  partySelect.innerHTML = partyOptions.join('');
  partySelect.required = source === 'in-use';
  partySelect.disabled = source !== 'in-use' || partyOptions.length === 0;
  $('#unavailableForm').querySelector('button[type="submit"]').disabled = source === 'in-use' && partyOptions.length === 0;
}

function selectTable(tableId) {
  state.selectedTableId = tableId;
  state.selectedPromoId = null;
  state.customDiscountPct = 0;
  renderTables();
  renderTableSelect();
  renderPartyWorkspace();
  renderEstimate();
  $('#selectionStatus').textContent = selectedParty() ? 'Active table selected' : 'Ready to check in';
}

function renderPartyWorkspace() {
  const table = selectedTable();
  const party = table?.party;
  $('#partyEmpty').classList.toggle('hidden', Boolean(table));
  $('#checkinForm').classList.toggle('hidden', !table || Boolean(party));
  $('#activeParty').classList.toggle('hidden', !party);
  $('#estimatePanel').classList.toggle('hidden', !table);
  $('#selectionStatus').textContent = party ? 'Active table selected' : table ? 'Ready to check in' : 'Select a table to get started';
  if (!table) return;
  if (party) {
    $('#activeTable').textContent = table.id;
    $('#activePax').textContent = `${party.adults} adults · ${party.seniorCount || 0} senior / pwd · ${party.children} kids 3–4 ft · ${party.freeChildCount || 0} under 3 ft`;
    const overPax = party.assignedPlates > party.paxCount;
    $('#activePlates').innerHTML = `${party.assignedPlates} plates assigned${overPax ? ' <span class="over-pax">Above recorded guests</span>' : ''}`;
    $('#partyPlateCount').value = party.assignedPlates;
    $('#checkoutButton').disabled = false;
  } else {
    $('#tableSelect').value = table.id;
    $('#checkinButton').disabled = !state.snapshot.tables.some((entry) => !entry.party);
  }
}

function promoDiscount(promo, party, subtotal, adultSubtotal, childSubtotal) {
  if (!promo) return 0;
  if (promo.type === 'percentage') {
    const basis = promo.appliesTo === 'adults' ? adultSubtotal : promo.appliesTo === 'children' ? childSubtotal : subtotal;
    return basis * promo.value / 100;
  }
  if (promo.type === 'fixed') return Math.min(subtotal, promo.value);
  if (promo.type === 'tier' && party.paxCount >= Number(promo.conditions.minPax || 0)) return subtotal * promo.value / 100;
  if (promo.type === 'birthday') {
    const freeEvery = Math.max(1, Number(promo.conditions.freeEvery || 4));
    return Math.min(adultSubtotal, Math.floor(party.adults / freeEvery) * state.snapshot.pricing.adultPrice * weekendMultiplier());
  }
  return 0;
}

function weekendMultiplier() {
  return [0, 6].includes(new Date().getDay()) ? 1 + state.snapshot.pricing.weekendSurcharge / 100 : 1;
}

function calculateEstimate(party) {
  const pricing = state.snapshot.pricing;
  const seniorCount = Math.max(0, Number(party.seniorCount || 0));
  const freeChildCount = Math.max(0, Number(party.freeChildCount || 0));
  const adultSubtotal = Math.max(0, Number(party.adults || 0)) * pricing.adultPrice * weekendMultiplier();
  const seniorSubtotal = seniorCount * pricing.seniorPrice * weekendMultiplier();
  const childSubtotal = Math.max(0, Number(party.children || 0)) * pricing.childPrice * weekendMultiplier();
  const subtotal = adultSubtotal + seniorSubtotal + childSubtotal;
  const selectedPromo = state.snapshot.promos.find((promo) => promo.id === state.selectedPromoId && promo.active);
  const discount = state.customDiscountPct > 0 ? subtotal * state.customDiscountPct / 100 : promoDiscount(selectedPromo, party, subtotal, adultSubtotal, childSubtotal);
  return { subtotal, discount, total: subtotal - discount, promo: state.customDiscountPct > 0 ? null : selectedPromo };
}

function renderEstimate() {
  const party = selectedParty() || currentDraft();
  const hasTable = Boolean(selectedTable());
  $('#estimatePanel').classList.toggle('hidden', !hasTable);
  if (!party) return;
  const bill = calculateEstimate(party);
  const seniorText = party.seniorCount ? `, ${party.seniorCount} senior${party.seniorCount === 1 ? '' : 's'}` : '';
  const childText = party.children ? `, ${party.children} kid${party.children === 1 ? '' : 's'} 3–4 ft` : '';
  const freeChildText = party.freeChildCount ? `, ${party.freeChildCount} under 3 ft` : '';
  $('#estimatePax').textContent = `${party.paxCount} ${party.paxCount === 1 ? 'guest' : 'guests'} · ${party.adults} adult${party.adults === 1 ? '' : 's'}${seniorText}${childText}${freeChildText}`;
  $('#estimateTotal').textContent = money(bill.total);
  $('#estimateSubtotal').textContent = money(bill.subtotal);
  $('#estimateDiscount').textContent = `−${money(bill.discount)}`;
  $('#discountOutput').textContent = `${state.customDiscountPct}%`;
  $('#customDiscount').value = state.customDiscountPct;
  document.querySelectorAll('[data-promo-chip]').forEach((button) => {
    button.classList.toggle('active', button.dataset.promoChip === state.selectedPromoId && state.customDiscountPct === 0);
  });
  const overCapacity = selectedTable() && party.paxCount > selectedTable().seats;
  const noPlates = party.paxCount > state.snapshot.availableStock;
  $('#checkinNotice').textContent = overCapacity ? `Table capacity is ${selectedTable().seats} guests.` : noPlates ? `Only ${state.snapshot.availableStock} clean plates are available.` : '';
  $('#checkinNotice').classList.toggle('error-text', Boolean(overCapacity || noPlates));
  $('#checkinButton').disabled = !party.paxCount || overCapacity || noPlates;
}

function renderPricing() {
  if (!state.snapshot) return;
  const form = $('#pricingForm');
  Object.entries(state.snapshot.pricing).forEach(([name, value]) => {
    if (form.elements[name]) form.elements[name].value = value;
  });
}

function renderPromos() {
  if (!state.snapshot) return;
  const promos = state.snapshot.promos;
  $('#promoCount').textContent = `${promos.filter((promo) => promo.active).length} active`;
  $('#promoChips').innerHTML = promos.filter((promo) => promo.active).map((promo) => `<button class="promo-chip ${promo.id === state.selectedPromoId && state.customDiscountPct === 0 ? 'active' : ''}" type="button" data-promo-chip="${escapeHtml(promo.id)}">${escapeHtml(promo.name)}</button>`).join('') || '<span class="no-promos">No active promos</span>';
  document.querySelectorAll('[data-promo-chip]').forEach((button) => button.addEventListener('click', () => {
    state.selectedPromoId = state.selectedPromoId === button.dataset.promoChip ? null : button.dataset.promoChip;
    state.customDiscountPct = 0;
    renderPromos();
    renderEstimate();
  }));
  $('#promoList').innerHTML = promos.map((promo) => {
    const ruleValue = promo.type === 'percentage' || promo.type === 'tier' ? `${promo.value}%` : promo.type === 'fixed' ? money(promo.value) : `1 free per ${promo.conditions.freeEvery || 4}`;
    const condition = promo.type === 'tier' ? ` · ${promo.conditions.minPax || 0}+ guests` : promo.appliesTo !== 'subtotal' ? ` · ${promo.appliesTo}` : '';
    return `<article class="promo-rule ${promo.active ? '' : 'inactive'}" data-promo-id="${escapeHtml(promo.id)}"><div class="promo-rule-head"><div><strong>${escapeHtml(promo.name)}</strong><span>${escapeHtml(promo.code)} · ${escapeHtml(promo.type)}${condition}</span></div><label class="switch" title="${promo.active ? 'Deactivate' : 'Activate'} ${escapeHtml(promo.name)}"><input type="checkbox" data-promo-active="${escapeHtml(promo.id)}" ${promo.active ? 'checked' : ''} /><span></span></label></div><div class="promo-rule-edit"><label>Name<input data-promo-name="${escapeHtml(promo.id)}" value="${escapeHtml(promo.name)}" maxlength="40" /></label><label>${promo.type === 'birthday' ? 'Free every' : 'Value'}<input data-promo-value="${escapeHtml(promo.id)}" type="number" min="0" step="0.01" value="${promo.type === 'birthday' ? promo.conditions.freeEvery || 4 : promo.value}" /></label><button class="icon-button save-promo" type="button" data-save-promo="${escapeHtml(promo.id)}" aria-label="Save ${escapeHtml(promo.name)}">✓</button></div><small>${escapeHtml(ruleValue)}</small></article>`;
  }).join('') || '<p class="empty-activity">No promotion rules yet.</p>';
  document.querySelectorAll('[data-promo-active]').forEach((input) => input.addEventListener('change', () => updatePromo(input.dataset.promoActive, { active: input.checked })));
  document.querySelectorAll('[data-save-promo]').forEach((button) => button.addEventListener('click', () => {
    const id = button.dataset.savePromo;
    const rule = state.snapshot.promos.find((promo) => promo.id === id);
    const name = $(`[data-promo-name="${CSS.escape(id)}"]`).value.trim();
    const value = Number($(`[data-promo-value="${CSS.escape(id)}"]`).value);
    const payload = { name };
    if (rule.type === 'birthday') payload.conditions = { freeEvery: value };
    else payload.value = value;
    updatePromo(id, payload);
  }));
}

async function refreshSnapshot(message) {
  const snapshot = await api('/api/buffet/state');
  renderSnapshot(snapshot);
  if (message) notify(message);
}

async function updatePromo(id, payload) {
  try {
    await api(`/api/buffet/promos/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
    await refreshSnapshot('Promotion saved.');
  } catch (error) {
    notify(error.message, true);
    await refreshSnapshot();
  }
}

async function checkIn() {
  const party = currentDraft();
  const tableId = $('#tableSelect').value;
  if (!party || !tableId) return;
  try {
    const result = await api('/api/buffet/parties', { method: 'POST', body: JSON.stringify({ tableId, adults: party.adults, seniorCount: party.seniorCount, children: party.children, freeChildCount: party.freeChildCount }) });
    state.selectedTableId = tableId;
    state.selectedPromoId = null;
    state.customDiscountPct = 0;
    renderSnapshot(result.state);
    notify(`${result.party.paxCount} guests checked in at ${tableId}.`);
  } catch (error) {
    notify(error.message, true);
  }
}

async function changePlates(action) {
  const party = selectedParty();
  const quantity = Math.max(1, Number($('#plateAdjustQty').value) || 1);
  if (!party) return;
  try {
    const result = await api(`/api/buffet/parties/${encodeURIComponent(party.id)}/plates`, { method: 'PATCH', body: JSON.stringify({ action, quantity }) });
    renderSnapshot(result.state);
    if (action === 'distribute' && result.party.assignedPlates > result.party.paxCount) {
      notify(`Warning: ${result.party.assignedPlates} assigned plates exceed ${result.party.paxCount} recorded guests.`, true);
    } else {
      notify(action === 'bus' ? `${quantity} plates moved to dishwashing.` : `${quantity} plates assigned.`);
    }
  } catch (error) {
    notify(error.message, true);
  }
}

async function setPartyPlateCount() {
  const party = selectedParty();
  const rawPlateCount = $('#partyPlateCount').value.trim();
  const plateCount = Number(rawPlateCount);
  if (!party) return;
  if (!rawPlateCount || !Number.isInteger(plateCount) || plateCount < 0) {
    notify('Plate count must be a non-negative whole number.', true);
    return;
  }
  try {
    const result = await api(`/api/buffet/parties/${encodeURIComponent(party.id)}/plates`, {
      method: 'PATCH',
      body: JSON.stringify({ action: 'set', quantity: plateCount })
    });
    renderSnapshot(result.state);
    if (result.party.assignedPlates > result.party.paxCount) {
      notify(`Warning: ${result.party.assignedPlates} assigned plates exceed ${result.party.paxCount} recorded guests.`, true);
    } else {
      notify(`Assigned plate count updated to ${result.party.assignedPlates}.`);
    }
  } catch (error) {
    notify(error.message, true);
  }
}

async function markAllClean() {
  const quantity = state.snapshot?.plates.inDishwashing || 0;
  if (!quantity) return;
  try {
    const snapshot = await api('/api/buffet/plates', { method: 'PATCH', body: JSON.stringify({ action: 'wash-all' }) });
    renderSnapshot(snapshot);
    notify(`${quantity} plates returned to clean stock.`);
  } catch (error) {
    notify(error.message, true);
  }
}

async function releaseParty() {
  const party = selectedParty();
  if (!party) return;
  try {
    const result = await api(`/api/buffet/parties/${encodeURIComponent(party.id)}/release`, { method: 'PATCH', body: JSON.stringify({}) });
    state.selectedTableId = null;
    state.selectedPromoId = null;
    state.customDiscountPct = 0;
    closeModal('releaseModal');
    renderSnapshot(result.state);
    notify(`${party.tableId} is available. No payment was recorded.`);
  } catch (error) {
    notify(error.message, true);
  }
}

function checkoutBreakdown() {
  const party = selectedParty();
  if (!party) return null;
  const bill = calculateEstimate(party);
  const promo = bill.promo ? `<div class="bill-line"><span>${escapeHtml(bill.promo.name)}</span><strong>−${money(bill.discount)}</strong></div>` : state.customDiscountPct ? `<div class="bill-line"><span>Manual discount (${state.customDiscountPct}%)</span><strong>−${money(bill.discount)}</strong></div>` : `<div class="bill-line"><span>Discount</span><strong>−${money(bill.discount)}</strong></div>`;
  $('#checkoutBreakdown').innerHTML = `<div class="bill-party"><span class="table-tag">${escapeHtml(party.tableId)}</span><div><strong>${party.paxCount} guests</strong><small>${party.adults} adults · ${party.seniorCount || 0} senior / pwd · ${party.children} kids 3–4 ft · ${party.freeChildCount || 0} under 3 ft · ${party.assignedPlates} plates</small></div></div><div class="bill-lines"><div class="bill-line"><span>Adults · ${party.adults} × ${money(state.snapshot.pricing.adultPrice)}</span><strong>${money(party.adults * state.snapshot.pricing.adultPrice * weekendMultiplier())}</strong></div><div class="bill-line"><span>Senior / PWD · ${party.seniorCount || 0} × ${money(state.snapshot.pricing.seniorPrice)}</span><strong>${money((party.seniorCount || 0) * state.snapshot.pricing.seniorPrice * weekendMultiplier())}</strong></div><div class="bill-line"><span>Kids 3–4 ft · ${party.children} × ${money(state.snapshot.pricing.childPrice)}</span><strong>${money(party.children * state.snapshot.pricing.childPrice * weekendMultiplier())}</strong></div>${party.freeChildCount ? `<div class="bill-line"><span>Kids below 3 ft · ${party.freeChildCount} × ${money(0)}</span><strong>${money(0)}</strong></div>` : ''}<div class="bill-line"><span>Subtotal</span><strong>${money(bill.subtotal)}</strong></div>${promo}<div class="bill-total"><span>Amount due</span><strong>${money(bill.total)}</strong></div></div>`;
  return bill;
}

async function completeCheckout() {
  const party = selectedParty();
  if (!party) return;
  const paymentMethod = $('#paymentMethod').value;
  try {
    const result = await api('/api/buffet/checkout', { method: 'POST', body: JSON.stringify({ partyId: party.id, promoId: state.customDiscountPct ? null : state.selectedPromoId, customDiscountPct: state.customDiscountPct, paymentMethod }) });
    state.lastReceipt = result.order;
    state.selectedTableId = null;
    state.selectedPromoId = null;
    state.customDiscountPct = 0;
    closeModal('checkoutModal');
    renderSnapshot(result.state);
    const receipt = result.order;
    $('#lastReceipt').innerHTML = `<span class="receipt-mark">✓</span><div class="receipt-details"><p class="eyebrow">Payment complete · ${escapeHtml(receipt.id)}</p><strong>${escapeHtml(receipt.tableId)} · ${receipt.paxCount} guests</strong><small>${receipt.adults} adult${receipt.adults === 1 ? '' : 's'} · ${receipt.children} child${receipt.children === 1 ? '' : 'ren'} · ${escapeHtml(receipt.paymentMethod)} · ${new Date(receipt.createdAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</small></div><strong class="receipt-total">${money(receipt.total)}</strong>`;
    $('#lastReceipt').classList.remove('hidden');
    notify(`Payment complete · ${money(receipt.total)} collected.`);
    await refreshSalesSummary();
  } catch (error) {
    notify(error.message, true);
  }
}

function openModal(id) {
  const modal = document.getElementById(id);
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
}

function closeModal(id) {
  const modal = document.getElementById(id);
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
}

function setView(view) {
  document.querySelectorAll('.view').forEach((element) => element.classList.toggle('active', element.id === `${view}View`));
  document.querySelectorAll('[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  if (view === 'sales') loadSales(1);
  if (view === 'database') openDatabaseAdmin();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function bindEvents() {
  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
  document.querySelectorAll('.back-to-floor').forEach((button) => button.addEventListener('click', () => setView('service')));
  $('#openCheckin').addEventListener('click', () => {
    if (!state.snapshot) return notify('Service data is still loading.', true);
    const firstOpen = state.snapshot.tables.find((table) => !table.party);
    if (!firstOpen) return notify('No open tables are available.', true);
    selectTable(firstOpen.id);
    $('#adultInput').focus();
    $('#partyTitle').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  $('#tableSelect').addEventListener('change', (event) => selectTable(event.target.value));
  $('#adultInput').addEventListener('input', renderEstimate);
  $('#seniorInput').addEventListener('input', renderEstimate);
  $('#childInput').addEventListener('input', renderEstimate);
  $('#freeChildInput').addEventListener('input', renderEstimate);
  document.querySelectorAll('[data-step]').forEach((button) => button.addEventListener('click', () => {
    const fieldMap = {
      adults: $('#adultInput'),
      senior: $('#seniorInput'),
      children: $('#childInput'),
      freeChildren: $('#freeChildInput')
    };
    const input = fieldMap[button.dataset.step];
    if (!input) return;
    input.value = Math.max(0, Number(input.value) + Number(button.dataset.delta));
    renderEstimate();
  }));
  $('#checkinButton').addEventListener('click', checkIn);
  $('#distributePlates').addEventListener('click', () => changePlates('distribute'));
  $('#busPlates').addEventListener('click', () => changePlates('bus'));
  $('#setPartyPlates').addEventListener('click', setPartyPlateCount);
  $('#checkoutButton').addEventListener('click', () => {
    if (!selectedParty()) return;
    checkoutBreakdown();
    openModal('checkoutModal');
  });
  $('#releasePartyButton').addEventListener('click', () => {
    if (selectedParty()) openModal('releaseModal');
  });
  $('#confirmRelease').addEventListener('click', releaseParty);
  $('#confirmCheckout').addEventListener('click', completeCheckout);
  $('#customDiscount').addEventListener('input', (event) => {
    state.customDiscountPct = Number(event.target.value);
    if (state.customDiscountPct) state.selectedPromoId = null;
    renderPromos();
    renderEstimate();
  });
  $('#openPlateActions').addEventListener('click', () => openModal('plateModal'));
  $('#markCleanButton').addEventListener('click', markAllClean);
  $('#receiveForm').addEventListener('submit', (event) => submitPlateAction(event, 'receive'));
  $('#removeForm').addEventListener('submit', (event) => submitPlateAction(event, 'remove'));
  $('#setCleanForm').addEventListener('submit', (event) => submitPlateAction(event, 'set-available'));
  $('#washForm').addEventListener('submit', (event) => submitPlateAction(event, 'wash'));
  $('#unavailableSource').addEventListener('change', updateUnavailablePartyOptions);
  $('#unavailableForm').addEventListener('submit', (event) => submitPlateAction(event, 'unavailable'));
  $('#thresholdInput').addEventListener('change', async (event) => {
    try {
      const result = await api('/api/buffet/threshold', { method: 'PATCH', body: JSON.stringify({ minimumThresholdPct: Number(event.target.value) }) });
      renderSnapshot(result);
      notify('Low-stock threshold updated.');
    } catch (error) {
      notify(error.message, true);
      await refreshSnapshot();
    }
  });
  $('#pricingForm').addEventListener('submit', savePricing);
  $('#promoForm').addEventListener('submit', createPromo);
  $('#promoForm').elements.type.addEventListener('change', updatePromoForm);
  $('#salesFilterForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const { startDate, endDate } = salesFilters();
    if (startDate && endDate && startDate > endDate) {
      notify('Start date must be on or before end date.', true);
      return;
    }
    loadSales(1);
  });
  $('#refreshSalesButton').addEventListener('click', () => loadSales(state.salesPage || 1));
  $('#salesPreviousButton').addEventListener('click', () => loadSales(Math.max(1, state.salesPage - 1)));
  $('#salesNextButton').addEventListener('click', () => loadSales(Math.min(state.salesTotalPages, state.salesPage + 1)));
  $('#closeSaleDetailButton').addEventListener('click', () => $('#saleDetailDialog').close());
  $('#databaseLoginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const username = String(values.get('username') || '').trim();
    const password = String(values.get('password') || '');
    const message = $('#databaseLoginMessage');
    message.textContent = 'Signing in…';
    message.classList.remove('error-text');
    try {
      await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ username, password }) });
      form.reset();
      message.textContent = '';
      setDatabaseAdminAccess(true);
    } catch (error) {
      message.textContent = error.message;
      message.classList.add('error-text');
    }
  });
  $('#databaseLogoutButton').addEventListener('click', async () => {
    try {
      await api('/api/admin/logout', { method: 'POST' });
      setDatabaseAdminAccess(false);
      $('#databaseLoginMessage').textContent = 'You have signed out.';
      $('#databaseLoginForm').classList.remove('hidden');
    } catch (error) {
      notify(error.message, true);
    }
  });
  $('#refreshDatabaseButton').addEventListener('click', () => loadDatabaseRecords(state.databasePage || 1));
  document.querySelectorAll('[data-admin-table]').forEach((button) => button.addEventListener('click', () => {
    state.databaseTable = button.dataset.adminTable;
    state.databasePage = 1;
    document.querySelectorAll('[data-admin-table]').forEach((tab) => {
      const selected = tab === button;
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-selected', String(selected));
    });
    loadDatabaseRecords(1);
  }));
  $('#databaseSearchForm').addEventListener('submit', (event) => {
    event.preventDefault();
    state.databaseSearch = String(new FormData(event.currentTarget).get('search') || '').trim();
    loadDatabaseRecords(1);
  });
  $('#databasePreviousButton').addEventListener('click', () => loadDatabaseRecords(Math.max(1, state.databasePage - 1)));
  $('#databaseNextButton').addEventListener('click', () => loadDatabaseRecords(Math.min(state.databaseTotalPages, state.databasePage + 1)));
  $('#databaseRecordForm').addEventListener('submit', saveDatabaseRecord);
  $('#closeDatabaseRecordButton').addEventListener('click', () => $('#databaseRecordDialog').close());
  document.querySelectorAll('[data-dismiss]').forEach((element) => element.addEventListener('click', () => closeModal(element.dataset.dismiss)));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') document.querySelectorAll('.modal:not(.hidden)').forEach((modal) => closeModal(modal.id));
  });
}

async function submitPlateAction(event, action) {
  event.preventDefault();
  const form = event.currentTarget;
  const formValues = new FormData(form);
  const quantity = Number(formValues.get('quantity'));
  const unavailableDetails = action === 'unavailable' ? {
    source: String(formValues.get('source') || ''),
    partyId: String(formValues.get('partyId') || ''),
    reason: String(formValues.get('reason') || '').trim()
  } : {};
  try {
    const result = await api('/api/buffet/plates', { method: 'PATCH', body: JSON.stringify({ action, quantity, ...unavailableDetails }) });
    renderSnapshot(result);
    const notices = {
      receive: `${quantity} clean plates received.`,
      remove: `${quantity} clean plates removed from available stock.`,
      'set-available': `Available clean plate count set to ${quantity}.`,
      wash: `${quantity} clean plates returned from dishwashing.`,
      unavailable: `${quantity} plates marked unavailable (${unavailableDetails.reason}).`
    };
    notify(notices[action]);
    if (action === 'unavailable') {
      form.elements.quantity.value = 1;
      form.elements.reason.value = '';
      updateUnavailablePartyOptions();
    } else {
      form.reset();
    }
    if (action === 'set-available') {
      form.elements.quantity.value = result.availableStock;
    } else if (action !== 'unavailable') {
      form.elements.quantity.value = action === 'wash' ? 10 : action === 'remove' ? 1 : 24;
    }
    $('#plateModalNotice').textContent = '';
    $('#plateModalNotice').classList.remove('error-text');
  } catch (error) {
    $('#plateModalNotice').textContent = error.message;
    $('#plateModalNotice').classList.add('error-text');
  }
}

async function savePricing(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const pricing = Object.fromEntries(['adultPrice', 'seniorPrice', 'childPrice', 'childFreeHeightFt', 'weekendSurcharge'].map((key) => [key, Number(form.get(key))]));
  try {
    await api('/api/buffet/pricing', { method: 'PATCH', body: JSON.stringify(pricing) });
    await refreshSnapshot();
    $('#pricingStatus').textContent = 'Saved. New bills use these rates.';
    notify('Buffet pricing updated.');
  } catch (error) {
    $('#pricingStatus').textContent = error.message;
    notify(error.message, true);
  }
}

function updatePromoForm() {
  const form = $('#promoForm');
  const type = form.elements.type.value;
  const value = form.elements.value;
  const conditionLabel = $('#conditionLabel');
  value.disabled = false;
  value.removeAttribute('max');
  conditionLabel.innerHTML = 'Minimum guests<input name="minPax" type="number" min="1" value="10" />';
  if (type === 'percentage') value.max = 100;
  value.value = type === 'percentage' ? 10 : 5;
}

async function createPromo(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  const type = values.get('type');
  const payload = {
    name: String(values.get('name')).trim(),
    code: String(values.get('code')).trim().toUpperCase(),
    type,
    value: type === 'birthday' ? 0 : Number(values.get('value')),
    appliesTo: values.get('appliesTo'),
    minPax: Number(values.get('minPax') || 0),
    freeEvery: Number(values.get('freeEvery') || 4)
  };
  try {
    await api('/api/buffet/promos', { method: 'POST', body: JSON.stringify(payload) });
    form.reset();
    updatePromoForm();
    await refreshSnapshot();
    notify('Promotion created.');
  } catch (error) {
    notify(error.message, true);
  }
}

async function initialize() {
  bindEvents();
  formatClock();
  setInterval(formatClock, 30000);
  try {
    await refreshSnapshot();
    $('#connectionStatus').innerHTML = '<i class="legend-dot available"></i> Connected';
  } catch (error) {
    $('#connectionStatus').innerHTML = '<i class="legend-dot disconnected"></i> Server unavailable';
    notify(error.message, true);
  }
  await refreshSalesSummary();
}

initialize();