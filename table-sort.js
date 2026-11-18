/* All dashboard tables share one reversible, accessible sorting behavior. */
(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SamuraiTableSort = api;
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const states = new WeakMap();
  const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });
  const ignoredClasses = ['table-sub', 'sample-small', 'muted-dash', 'table-sort-indicator'];
  let installedDocument = null;
  let observer = null;
  let liveRegion = null;

  function normalized(value) {
    return String(value ?? '').replace(/[\u00a0\u202f\u2009]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function parsedDate(year, month, day, hour = 0, minute = 0, second = 0) {
    const value = Date.UTC(+year, +month - 1, +day, +hour, +minute, +second);
    const d = new Date(value);
    return d.getUTCFullYear() === +year && d.getUTCMonth() === +month - 1 && d.getUTCDate() === +day &&
      d.getUTCHours() === +hour && d.getUTCMinutes() === +minute && d.getUTCSeconds() === +second ? value : null;
  }

  function parseValue(raw) {
    const text = normalized(raw);
    if (!text || /^[—–−-]+$/.test(text) || /^(?:нет (?:данных|игр|оценки)|не (?:рассчитан|оцен[её]н)|н\s*\/\s*д)(?=\s|[.,·:]|$)/iu.test(text)) {
      return { kind: 'missing', value: null };
    }
    let match = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (match) {
      const value = parsedDate(match[3], match[2], match[1], match[4] || 0, match[5] || 0, match[6] || 0);
      if (value !== null) return { kind: 'date', value };
    }
    match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/);
    if (match) {
      const checked = parsedDate(match[1], match[2], match[3], match[4] || 0, match[5] || 0, match[6] || 0);
      const value = checked === null ? NaN : Date.parse(text.length === 10 ? text + 'T00:00:00Z' : text);
      if (Number.isFinite(value)) return { kind: 'date', value };
    }
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text) && Number.isFinite(Number(text))) {
      return { kind: 'number', value: Number(text) };
    }
    // Ratios, confidence intervals and counts sort by their leading value.
    // A title such as “36 обезьян” stays text; only known numeric suffixes qualify.
    match = text.replace(/[−–]/g, '-').match(/^([+-]?(?:\d{1,3}(?:[ '\u2019]\d{3})+|\d+)(?:[.,]\d+)?)(.*)$/u);
    if (match && /^(?:\s*%?\s*|\s*\/\s*[\d\s.,]+|\s*[-—]\s*[+-]?[\d\s.,]+|\s*(?:участник[а-яё]*|человек[а-яё]*|игр[а-яё]*|турнир[а-яё]*|вопрос[а-яё]*|команд[а-яё]*|балл[а-яё]*|секунд[а-яё]*|с|минут[а-яё]*|мин)\.?)$/iu.test(match[2])) {
      const value = Number(match[1].replace(/[ '\u2019]/g, '').replace(',', '.'));
      if (Number.isFinite(value)) return { kind: 'number', value };
    }
    return { kind: 'text', value: text.replace(/\s*[↗↘]\s*$/u, '') };
  }

  function compareValues(a, b, direction = 'asc') {
    const x = a && typeof a === 'object' && 'kind' in a ? a : parseValue(a);
    const y = b && typeof b === 'object' && 'kind' in b ? b : parseValue(b);
    // Unknown values belong at the end in both directions.
    if (x.kind === 'missing' || y.kind === 'missing') return x.kind === y.kind ? 0 : x.kind === 'missing' ? 1 : -1;
    const comparison = x.kind !== 'text' && y.kind !== 'text' ? x.value - y.value : collator.compare(String(x.value), String(y.value));
    return direction === 'desc' ? -comparison : comparison;
  }

  function primaryText(node) {
    if (!node) return '';
    if (node.nodeType === 3) return node.nodeValue || '';
    if (node.nodeType !== 1) return '';
    if (['SCRIPT', 'STYLE'].includes(node.tagName) || node.hidden || node.getAttribute('aria-hidden') === 'true' ||
        ignoredClasses.some(name => node.classList && node.classList.contains(name)) || node.tagName === 'SMALL') return '';
    return Array.from(node.childNodes || []).map(primaryText).join(' ');
  }

  function cellValue(cell) {
    if (!cell) return parseValue('');
    const explicit = cell.getAttribute('data-sort-value');
    return parseValue(explicit !== null ? explicit : primaryText(cell));
  }

  function cellAt(row, column) {
    let offset = 0;
    for (const cell of Array.from(row.cells || [])) {
      const span = Number(cell.colSpan) || 1;
      if (column >= offset && column < offset + span) return cell;
      offset += span;
    }
    return null;
  }

  function headerRow(table) {
    const headRows = table.tHead && table.tHead.rows;
    if (headRows && headRows.length) return headRows[headRows.length - 1];
    return Array.from(table.rows || []).find(row => Array.from(row.cells || []).some(cell => cell.tagName === 'TH')) || null;
  }

  function updateHeaders(state) {
    for (const header of state.headers) {
      const active = state.column === header.column && state.direction;
      const current = active === 'asc' ? 'ascending' : active === 'desc' ? 'descending' : 'none';
      const next = active === 'asc' ? 'по убыванию' : active === 'desc' ? 'в исходном порядке' : 'по возрастанию';
      header.cell.setAttribute('aria-sort', current);
      header.button.title = `Нажмите: ${next}. Три нажатия: возрастание → убывание → исходный порядок.`;
      header.button.setAttribute('aria-label', `${header.label}. ${active === 'asc' ? 'По возрастанию. ' : active === 'desc' ? 'По убыванию. ' : ''}Нажмите: ${next}.`);
      const icon = active === 'asc' ? '↑' : active === 'desc' ? '↓' : '↕';
      if (header.indicator.textContent !== icon) header.indicator.textContent = icon;
    }
  }

  function ensureState(table) {
    let state = states.get(table);
    const row = headerRow(table);
    if (!row) return null;
    if (!state) { state = { table, headerRow: row, headers: [], bodies: [], column: -1, direction: null }; states.set(table, state); }
    state.headerRow = row;
    const existing = new Map(state.headers.map(header => [header.cell, header]));
    state.headers = [];
    let column = 0;
    for (const cell of Array.from(row.cells || [])) {
      const span = Number(cell.colSpan) || 1;
      if (span !== 1) { column += span; continue; }
      let header = existing.get(cell);
      if (!header) {
        const doc = table.ownerDocument;
        const label = normalized(primaryText(cell));
        let button = cell.children.length === 1 && cell.children[0].tagName === 'BUTTON' ? cell.children[0] : null;
        if (!button) {
          button = doc.createElement('button');
          while (cell.firstChild) button.appendChild(cell.firstChild);
          cell.appendChild(button);
        }
        button.type = 'button';
        button.classList.add('table-sort-button');
        cell.classList.add('table-sortable');
        const indicator = doc.createElement('span');
        indicator.className = 'table-sort-indicator';
        indicator.setAttribute('aria-hidden', 'true');
        button.appendChild(indicator);
        header = { cell, button, indicator, label, column };
      }
      header.column = column;
      cell.setAttribute('data-table-sort-column', String(column));
      cell.setAttribute('scope', 'col');
      state.headers.push(header);
      column += span;
    }
    const oldBodies = new Map(state.bodies.map(body => [body.node, body]));
    state.bodies = Array.from(table.tBodies || []).map(node => {
      const rows = Array.from(node.rows || []).filter(row => row !== state.headerRow);
      const body = oldBodies.get(node) || { node, original: rows };
      const current = new Set(rows), known = new Set(body.original);
      body.original = body.original.filter(row => current.has(row)).concat(rows.filter(row => !known.has(row)));
      return body;
    });
    updateHeaders(state);
    return state;
  }

  function applyOrder(state) {
    for (const body of state.bodies) {
      const originalIndex = new Map(body.original.map((row, index) => [row, index]));
      const keys = new Map(body.original.map(row => [row, cellValue(cellAt(row, state.column))]));
      const ordered = state.direction ? body.original.slice().sort((a, b) => compareValues(keys.get(a), keys.get(b), state.direction) || originalIndex.get(a) - originalIndex.get(b)) : body.original;
      const current = Array.from(body.node.rows || []).filter(row => row !== state.headerRow);
      if (ordered.some((row, index) => row !== current[index])) ordered.forEach(row => body.node.appendChild(row));
    }
  }

  function sort(table, column, direction) {
    const state = ensureState(table);
    if (!state || !state.headers.some(header => header.column === Number(column))) return false;
    state.column = Number(column);
    state.direction = direction === 'asc' || direction === 'desc' ? direction : null;
    updateHeaders(state);
    applyOrder(state);
    return true;
  }

  function refresh(scope) {
    const target = scope || installedDocument;
    if (!target) return;
    const tables = target.tagName === 'TABLE' ? [target] : Array.from(target.querySelectorAll ? target.querySelectorAll('table') : []);
    for (const table of tables) { const state = ensureState(table); if (state) applyOrder(state); }
  }

  function activate(cell) {
    const table = cell.closest('table'), state = table && ensureState(table);
    if (!state) return;
    const column = Number(cell.getAttribute('data-table-sort-column'));
    const direction = state.column !== column || !state.direction ? 'asc' : state.direction === 'asc' ? 'desc' : null;
    sort(table, column, direction);
    const header = state.headers.find(header => header.column === column);
    if (liveRegion && header) liveRegion.textContent = `${header.label}: ${direction === 'asc' ? 'по возрастанию' : direction === 'desc' ? 'по убыванию' : 'исходный порядок'}.`;
  }

  function install(doc) {
    if (!doc || installedDocument === doc) return;
    installedDocument = doc;
    // Capture protects the single sorting cycle from older delegated handlers.
    doc.addEventListener('click', event => {
      const cell = event.target.closest && event.target.closest('[data-table-sort-column]');
      if (!cell) return;
      event.preventDefault(); event.stopPropagation();
      activate(cell);
    }, true);
    doc.addEventListener('keydown', event => {
      const cell = event.target.closest && event.target.closest('[data-table-sort-column]');
      if (!cell || event.target.closest('button') || !['Enter', ' '].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation(); activate(cell);
    }, true);
    if (doc.body) {
      liveRegion = doc.createElement('span');
      liveRegion.className = 'table-sort-status';
      liveRegion.setAttribute('role', 'status');
      liveRegion.setAttribute('aria-live', 'polite');
      doc.body.appendChild(liveRegion);
    }
    refresh(doc);
    if (typeof root.MutationObserver === 'function') {
      observer = new root.MutationObserver(records => {
        const scopes = new Set();
        for (const record of records) {
          const owner = record.target.nodeType === 1 ? record.target : record.target.parentElement;
          const table = owner && owner.closest && owner.closest('table');
          if (table) scopes.add(table);
          for (const node of Array.from(record.addedNodes || [])) {
            if (node.nodeType !== 1) continue;
            if (node.tagName === 'TABLE') scopes.add(node);
            else if (node.querySelectorAll) node.querySelectorAll('table').forEach(table => scopes.add(table));
          }
        }
        scopes.forEach(refresh);
      });
      observer.observe(doc.documentElement || doc, { childList: true, subtree: true, characterData: true });
    }
  }

  if (root && root.document) {
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', () => install(root.document), { once: true });
    else install(root.document);
  }
  return { install, refresh, sort, parseValue, compareValues, cellValue };
});
