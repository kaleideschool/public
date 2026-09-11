// Simulacro mínimo de Apps Script para poder ejercitar el backend en Node.
// No pretende ser fiel a todo: solo a lo que este proyecto usa.

function Celda() { return { v: '', bg: '#ffffff', note: '' }; }

class Hoja {
  constructor(nombre, id) {
    this.nombre = nombre; this.id = id;
    this.filas = [];            // array de arrays de Celda
    this.maxCols = 40;
  }
  _asegurar(fila, col) {
    while (this.filas.length < fila) {
      const f = []; for (let i = 0; i < this.maxCols; i++) f.push(Celda());
      this.filas.push(f);
    }
    for (const f of this.filas) while (f.length < col) f.push(Celda());
    if (col > this.maxCols) this.maxCols = col;
  }
  getName() { return this.nombre; }
  getSheetId() { return this.id; }
  getMaxRows() { return Math.max(this.filas.length, 100); }
  getMaxColumns() { return this.maxCols; }
  getLastRow() {
    let ult = 0;
    this.filas.forEach((f, i) => { if (f.some(c => String(c.v) !== '')) ult = i + 1; });
    return ult;
  }
  getLastColumn() {
    let ult = 0;
    this.filas.forEach(f => f.forEach((c, j) => { if (String(c.v) !== '' && j + 1 > ult) ult = j + 1; }));
    return ult;
  }
  getRange(fila, col, nf, nc) {
    nf = nf || 1; nc = nc || 1;
    this._asegurar(fila + nf - 1, col + nc - 1);
    return new Rango(this, fila, col, nf, nc);
  }
  getDataRange() { return this.getRange(1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
  appendRow(vals) {
    const fila = this.getLastRow() + 1;
    this._asegurar(fila, vals.length);
    vals.forEach((v, j) => { this.filas[fila - 1][j].v = v === undefined ? '' : v; });
  }
  deleteRow(fila) { this.filas.splice(fila - 1, 1); }
  deleteRows(fila, n) { this.filas.splice(fila - 1, n); }
  insertRowBefore(fila) {
    const f = []; for (let i = 0; i < this.maxCols; i++) f.push(Celda());
    this.filas.splice(fila - 1, 0, f);
  }
}

class Rango {
  constructor(hoja, fila, col, nf, nc) {
    Object.assign(this, { hoja, fila, col, nf, nc });
  }
  _celdas() {
    const out = [];
    for (let i = 0; i < this.nf; i++) {
      const f = [];
      for (let j = 0; j < this.nc; j++) f.push(this.hoja.filas[this.fila - 1 + i][this.col - 1 + j]);
      out.push(f);
    }
    return out;
  }
  getValues() { return this._celdas().map(f => f.map(c => c.v)); }
  getDisplayValues() { return this._celdas().map(f => f.map(c => String(c.v == null ? '' : c.v))); }
  getBackgrounds() { return this._celdas().map(f => f.map(c => c.bg)); }
  getNotes() { return this._celdas().map(f => f.map(c => c.note)); }
  getValue() { return this._celdas()[0][0].v; }
  getBackground() { return this._celdas()[0][0].bg; }
  getNote() { return this._celdas()[0][0].note; }
  setValues(m) { this._celdas().forEach((f, i) => f.forEach((c, j) => { c.v = (m[i] || [])[j] === undefined ? '' : m[i][j]; })); return this; }
  setValue(v) { this._celdas().forEach(f => f.forEach(c => { c.v = v; })); return this; }
  setBackground(hex) { this._celdas().forEach(f => f.forEach(c => { c.bg = hex; })); return this; }
  setNote(t) { this._celdas().forEach(f => f.forEach(c => { c.note = t; })); return this; }
  setNumberFormat() { return this; }
}

class Libro {
  constructor() { this.hojas = []; this.seq = 1; }
  getSheets() { return this.hojas.slice(); }
  getSheetByName(n) { return this.hojas.filter(h => h.nombre === n)[0] || null; }
  insertSheet(n) { const h = new Hoja(n, this.seq++); this.hojas.push(h); return h; }
  getSpreadsheetTimeZone() { return 'Atlantic/Canary'; }
  getActiveSheet() { return this.hojas[0]; }
}

function construirEntorno(libro) {
  const cache = {};
  const props = {};
  const correos = [];
  return {
    SpreadsheetApp: {
      getActive: () => libro,
      getActiveSpreadsheet: () => libro,
      getActiveSheet: () => libro.getActiveSheet(),
      getUi: () => ({ alert() {}, createMenu: () => ({ addItem() { return this; }, addSeparator() { return this; }, addToUi() {} }) })
    },
    CacheService: {
      getScriptCache: () => ({
        get: k => (cache[k] === undefined ? null : cache[k]),
        put: (k, v) => { cache[k] = v; },
        remove: k => { delete cache[k]; }
      })
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (props[k] === undefined ? null : props[k]),
        setProperty: (k, v) => { props[k] = v; },
        deleteProperty: k => { delete props[k]; }
      })
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: {
      getUuid: () => 'uuid-' + Math.random().toString(36).slice(2, 12),
      formatDate: (d, tz, fmt) => {
        const p = n => ('0' + n).slice(-2);
        return fmt.replace('dd', p(d.getDate())).replace('MM', p(d.getMonth() + 1)).replace('yyyy', d.getFullYear());
      }
    },
    MailApp: { sendEmail: o => correos.push(o) },
    Session: { getActiveUser: () => ({ getEmail: () => 'admin@test' }) },
    HtmlService: {
      createTemplateFromFile: () => ({ evaluate: () => ({ setTitle() { return this; }, addMetaTag() { return this; }, setXFrameOptionsMode() { return this; } }) }),
      createHtmlOutputFromFile: () => ({ getContent: () => '' }),
      XFrameOptionsMode: { ALLOWALL: 1 }
    },
    ScriptApp: {
      getProjectTriggers: () => [],
      getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/TEST/exec' })
    },
    _correos: correos, _cache: cache, _props: props
  };
}

module.exports = { Libro, Hoja, construirEntorno };
