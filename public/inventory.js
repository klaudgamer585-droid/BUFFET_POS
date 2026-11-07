const dateForm = document.getElementById('dishDateForm');
const dateInput = document.getElementById('dishCostDate');
const dishCostForm = document.getElementById('dishCostForm');
const savedDishSelect = document.getElementById('savedDishSelect');
const dishNameInput = document.getElementById('dishName');
const dishCostInput = document.getElementById('dishTotalCost');
const saveDishToCatalogInput = document.getElementById('saveDishToCatalog');
const dishCostRows = document.getElementById('dishCostRows');
const dishCostStatus = document.getElementById('dishCostStatus');
let savedDishes = [];

const formatCurrency = (value) => new Intl.NumberFormat('en-PH', {
  style: 'currency',
  currency: 'PHP'
}).format(Number(value) || 0);

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
})[character]);

function localDateValue(date = new Date()) {
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return localDate.toISOString().slice(0, 10);
}

function displayDate(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString('en-PH', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers
    }
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || 'The request could not be completed.');
  return result;
}

function renderDishEntries(entries) {
  document.getElementById('dishEntryCount').textContent = `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`;
  dishCostRows.innerHTML = entries.length
    ? entries.map((entry) => `
        <tr>
          <td class="dish-entry-name">${escapeHtml(entry.dish)}</td>
          <td class="dish-entry-cost">${formatCurrency(entry.totalCost)}</td>
          <td><button class="secondary-btn small-btn delete-dish-cost" type="button" data-entry-id="${escapeHtml(entry.id)}" aria-label="Delete ${escapeHtml(entry.dish)} cost entry">Remove</button></td>
        </tr>
      `).join('')
    : '<tr><td class="dish-cost-empty" colspan="3">No dish costs recorded for this date.</td></tr>';
}

function renderSavedDishes() {
  const selectedId = savedDishSelect.value;
  savedDishSelect.innerHTML = '<option value="">Enter a new dish</option>' + savedDishes
    .map((dish) => `<option value="${escapeHtml(dish.id)}">${escapeHtml(dish.dish)} · ${formatCurrency(dish.defaultCost)}</option>`)
    .join('');
  if (savedDishes.some((dish) => dish.id === selectedId)) savedDishSelect.value = selectedId;
}

async function loadSavedDishes() {
  savedDishes = await api('/api/dishes');
  renderSavedDishes();
}

async function loadDishCosts() {
  const date = dateInput.value;
  if (!date) {
    dishCostStatus.textContent = 'Choose a date to view its dish costs and earnings.';
    dishCostStatus.classList.add('error-text');
    return;
  }
  document.getElementById('dishEntryDate').textContent = displayDate(date);
  dishCostStatus.textContent = 'Loading daily totals…';
  dishCostStatus.classList.remove('error-text');
  try {
    const timezoneOffset = new Date().getTimezoneOffset();
    const report = await api(`/api/dish-costs?date=${encodeURIComponent(date)}&timezoneOffset=${timezoneOffset}`);
    document.getElementById('dailyEarnings').textContent = formatCurrency(report.earnings);
    document.getElementById('dailyDishCosts').textContent = formatCurrency(report.dishCostTotal);
    document.getElementById('earningsAfterCosts').textContent = formatCurrency(report.earningsAfterDishCosts);
    document.getElementById('dailySaleCount').textContent = `${report.saleCount} completed ${report.saleCount === 1 ? 'sale' : 'sales'}`;
    renderDishEntries(report.entries);
    dishCostStatus.textContent = `Showing totals for ${displayDate(report.date)}.`;
  } catch (error) {
    dishCostStatus.textContent = error.message;
    dishCostStatus.classList.add('error-text');
  }
}

savedDishSelect.addEventListener('change', () => {
  const dish = savedDishes.find((entry) => entry.id === savedDishSelect.value);
  if (!dish) return;
  dishNameInput.value = dish.dish;
  dishCostInput.value = Number(dish.defaultCost).toFixed(2);
  saveDishToCatalogInput.checked = false;
  dishNameInput.focus();
});

dateForm.addEventListener('submit', (event) => {
  event.preventDefault();
  loadDishCosts();
});

dateInput.addEventListener('change', () => {
  if (dateInput.value) document.getElementById('dishEntryDate').textContent = displayDate(dateInput.value);
});

dishCostForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const dish = dishNameInput.value.trim();
  const totalCost = Number(dishCostInput.value);
  if (!dish || !Number.isFinite(totalCost) || totalCost < 0 || !dateInput.value) {
    dishCostStatus.textContent = 'Enter a dish name, valid total cost, and date.';
    dishCostStatus.classList.add('error-text');
    return;
  }
  const saveButton = document.getElementById('saveDishCostButton');
  saveButton.disabled = true;
  try {
    const savedEntry = await api('/api/dish-costs', {
      method: 'POST',
      body: JSON.stringify({
        dish,
        totalCost,
        date: dateInput.value,
        saveToCatalog: saveDishToCatalogInput.checked
      })
    });
    savedDishes = await api('/api/dishes');
    renderSavedDishes();
    savedDishSelect.value = '';
    dishNameInput.value = '';
    dishCostInput.value = '';
    saveDishToCatalogInput.checked = false;
    dishCostStatus.textContent = `${dish} cost added for ${displayDate(dateInput.value)}${savedEntry.savedDish ? ' and saved for future use' : ''}.`;
    dishCostStatus.classList.remove('error-text');
    await loadDishCosts();
    dishNameInput.focus();
  } catch (error) {
    dishCostStatus.textContent = error.message;
    dishCostStatus.classList.add('error-text');
  } finally {
    saveButton.disabled = false;
  }
});

dishCostRows.addEventListener('click', async (event) => {
  const button = event.target.closest('.delete-dish-cost');
  if (!button) return;
  button.disabled = true;
  try {
    await api(`/api/dish-costs/${encodeURIComponent(button.dataset.entryId)}`, { method: 'DELETE' });
    await loadDishCosts();
  } catch (error) {
    dishCostStatus.textContent = error.message;
    dishCostStatus.classList.add('error-text');
    button.disabled = false;
  }
});

dateInput.value = localDateValue();
document.getElementById('dishEntryDate').textContent = displayDate(dateInput.value);
loadSavedDishes().catch((error) => {
  dishCostStatus.textContent = error.message;
  dishCostStatus.classList.add('error-text');
});
loadDishCosts();
