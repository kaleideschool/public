/*******************************************************************************
 *
 * IMPORTADOR DE CUADRANTES — de un CSV a la hoja del mes.
 *
 * El PDF lo convierte a CSV un script de pdfplumber que corre en una GitHub
 * Action (ver README de la Action). Aquí empieza el trabajo difícil, que es
 * TRADUCIR: el CSV viene con los nombres completos y con códigos que cambian
 * cada mes, y la hoja necesita iniciales y los códigos del motor.
 *
 * Nada se escribe hasta que el operador ha resuelto las dos traducciones y ha
 * visto la vista previa.
 *
 ******************************************************************************/

var VERSION_IMPORTADOR = 'imp-2-vista';

var HOJA_MAPEO = 'MAPEO_IMPORT';
var CABECERA_MAPEO = ['Clase', 'Origen', 'Destino', 'Notas'];
// Clases: 'codigo' (MFCO2 → C), 'nombre' (MILLAN DE SILVA CARLOS → CS),
//         'categoria' (TI → TINS).

// ─── Análisis del CSV ───────────────────────────────────────────────────────
// Formato observado: una fila de cabecera con "1 J", "2 V"… y una última
// columna de horas; una fila por persona con nombre, categoría y 31 días.
function analizarCsv(texto) {
  var filas = _csvAFilas(String(texto || ''));
  if (filas.length < 2) return { ok: false, error: 'El CSV no tiene filas suficientes.' };

  var cab = filas[0];
  // Las columnas de día son las que ponen "<número> <letra>".
  var dias = [], colDia = {};
  for (var c = 0; c < cab.length; c++) {
    var m = String(cab[c] || '').trim().match(/^(\d{1,2})\s*([LMXJVSD])?$/i);
    if (m) { var d = Number(m[1]); if (d >= 1 && d <= 31) { dias.push(d); colDia[d] = c; } }
  }
  if (!dias.length) return { ok: false, error: 'No encuentro las columnas de día en la cabecera.' };

  var colNombre = -1, colCateg = -1;
  for (var c2 = 0; c2 < (colDia[dias[0]] || 0); c2++) {
    var t = String(cab[c2] || '').trim().toLowerCase();
    if (t.indexOf('categ') === 0) colCateg = c2;
    else if (t.indexOf('nombre') === 0 || t.indexOf('apellido') === 0) colNombre = c2;
  }
  // Si la cabecera no lo dice —en el CSV de muestra viene vacía—, el nombre es
  // la última columna antes de los días con texto en la MAYORÍA DE LAS FILAS DE
  // DATOS. Contando la cabecera nunca salía la cuenta con pocas filas.
  var nDatos = filas.length - 1;
  for (var c3 = (colDia[dias[0]] || 0) - 1; colNombre < 0 && c3 >= 0; c3--) {
    if (c3 === colCateg) continue;
    var conTexto = filas.slice(1).filter(function (f) { return String(f[c3] || '').trim().length > 3; }).length;
    if (nDatos > 0 && conTexto * 2 >= nDatos) colNombre = c3;
  }
  if (colNombre < 0) return { ok: false, error: 'No encuentro la columna de nombres.' };

  var personas = [], codigos = {}, categorias = {};
  for (var f = 1; f < filas.length; f++) {
    var fila = filas[f];
    var nombre = String(fila[colNombre] || '').trim();
    if (!nombre) continue;
    var categ = colCateg >= 0 ? String(fila[colCateg] || '').trim() : '';
    if (categ) categorias[categ] = (categorias[categ] || 0) + 1;
    var turnos = {};
    dias.forEach(function (d) {
      var v = String(fila[colDia[d]] || '').trim();
      if (!v) return;
      turnos[d] = v;
      codigos[v] = (codigos[v] || 0) + 1;
    });
    personas.push({ nombre: nombre, categoria: categ, turnos: turnos });
  }
  return { ok: true, dias: dias, personas: personas, codigos: codigos, categorias: categorias };
}

// CSV con comillas: lo justo para no romperse con un nombre que lleve coma.
function _csvAFilas(txt) {
  var filas = [], fila = [], campo = '', dentro = false;
  for (var i = 0; i < txt.length; i++) {
    var ch = txt[i];
    if (dentro) {
      if (ch === '"') { if (txt[i + 1] === '"') { campo += '"'; i++; } else dentro = false; }
      else campo += ch;
    } else if (ch === '"') dentro = true;
    else if (ch === ',') { fila.push(campo); campo = ''; }
    else if (ch === '\n') { fila.push(campo); filas.push(fila); fila = []; campo = ''; }
    else if (ch !== '\r') campo += ch;
  }
  if (campo.length || fila.length) { fila.push(campo); filas.push(fila); }
  return filas.filter(function (f) { return f.some(function (x) { return String(x).trim(); }); });
}

// ─── Memoria de traducciones ────────────────────────────────────────────────
// Los códigos del PDF cambian cada mes y los nombres vienen completos. Lo que
// el operador decida una vez queda aquí, y el mes siguiente solo se pregunta
// por lo que no se haya visto nunca.
function hojaMapeo() {
  var sh = _ss().getSheetByName(HOJA_MAPEO);
  if (!sh) { sh = _ss().insertSheet(HOJA_MAPEO); sh.appendRow(CABECERA_MAPEO); }
  return sh;
}

function leerMapeo() {
  var sh = hojaMapeo();
  if (sh.getLastRow() < 2) return {};
  var val = sh.getRange(2, 1, sh.getLastRow() - 1, CABECERA_MAPEO.length).getValues();
  var out = { codigo: {}, nombre: {}, categoria: {} };
  val.forEach(function (r) {
    var clase = String(r[0] || '').trim().toLowerCase();
    var origen = String(r[1] || '').trim();
    if (!out[clase] || !origen) return;
    out[clase][clase === 'codigo' ? origen : origen.toUpperCase()] = String(r[2] || '').trim();
  });
  return out;
}

function leerMapeoCache() {
  var hit = _cache().get('mapeo_' + CACHE_V);
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  var m = leerMapeo();
  try { _cache().put('mapeo_' + CACHE_V, JSON.stringify(m), CACHE_SEG_CTAS); } catch (e) {}
  return m;
}
function invalidarCacheMapeo() { _cache().remove('mapeo_' + CACHE_V); }

// Guarda o actualiza traducciones. `filas`: [{clase, origen, destino, notas}].
function guardarMapeos(token, filas) {
  // La vista ES el permiso (ver Backend.js). El importador escribe el cuadrante,
  // igual que «Incidencias», así que pide esa: no tiene pantalla propia todavía.
  var u = _exigirVista(token, 'gestion.rapido');
  filas = filas || [];
  if (!filas.length) return { ok: false, error: 'Nada que guardar.' };
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = hojaMapeo();
    var actuales = sh.getLastRow() > 1
      ? sh.getRange(2, 1, sh.getLastRow() - 1, CABECERA_MAPEO.length).getValues() : [];
    var indice = {};
    actuales.forEach(function (r, i) {
      indice[String(r[0]).trim().toLowerCase() + '|' + String(r[1]).trim().toUpperCase()] = i + 2;
    });
    var nuevas = [], n = 0;
    filas.forEach(function (f) {
      var clase = String(f.clase || '').trim().toLowerCase();
      var origen = String(f.origen || '').trim();
      if (!clase || !origen) return;
      var fila = [clase, origen, String(f.destino == null ? '' : f.destino).trim(), String(f.notas || '')];
      var k = clase + '|' + origen.toUpperCase();
      if (indice[k]) sh.getRange(indice[k], 1, 1, CABECERA_MAPEO.length).setValues([fila]);
      else nuevas.push(fila);
      n++;
    });
    if (nuevas.length) sh.getRange(sh.getLastRow() + 1, 1, nuevas.length, CABECERA_MAPEO.length).setValues(nuevas);
    invalidarCacheMapeo();
    _logApp('INFO', 'guardarMapeos', n + ' traducciones', u.cta);
    return { ok: true, guardadas: n };
  } finally { lock.releaseLock(); }
}

// ─── Emparejar nombres con iniciales ────────────────────────────────────────
// El PDF trae "MILLAN DE SILVA CARLOS" y hace falta "CS". No es derivable —hay
// dos Carlos y las iniciales salen de combinaciones distintas—, así que se
// PROPONE y lo confirma el operador. La propuesta puntúa dos señales:
//   · que cada letra de las iniciales sea inicial de alguna palabra del nombre
//     (CS = Carlos + Silva; CB = Carlos + Bregón)
//   · que el nombre de pila coincida con el que hay en CONTROLADORES
function _palabras(txt) {
  return String(txt || '').toUpperCase()
    .replace(/[^A-ZÁÉÍÓÚÑ\s.-]/g, ' ')
    .split(/[\s.-]+/).filter(function (p) { return p.length > 1; });
}
function proponerIniciales(nombrePdf, controladores) {
  var pal = _palabras(nombrePdf);
  if (!pal.length) return [];
  var props = [];
  controladores.forEach(function (c) {
    var cta = String(c.cta || '').toUpperCase();
    if (!cta) return;
    var punt = 0, todas = true;
    // ¿cada letra de las iniciales inicia alguna palabra del nombre?
    for (var i = 0; i < cta.length; i++) {
      var hay = pal.some(function (p) { return p.charAt(0) === cta.charAt(i); });
      if (hay) punt += 2; else todas = false;
    }
    // ¿coincide el nombre de pila? En CONTROLADORES suele ser "CARLOS MI.".
    // Se admite el diminutivo por prefijo: DANI casa con DANIEL. Lo que no hay
    // manera de casar es un apodo sin relación —MABEL con MARIA ISABEL—, y para
    // eso está la confirmación: se pregunta una vez y queda recordado.
    var pila = _palabras(c.nombre)[0];
    if (pila) {
      if (pal.indexOf(pila) !== -1) punt += 4;
      else if (pal.some(function (x) {
        return (x.length >= 4 && pila.length >= 4) && (x.indexOf(pila) === 0 || pila.indexOf(x) === 0);
      })) punt += 3;
    }
    if (punt > 0) props.push({ cta: cta, nombre: c.nombre, punt: punt, seguro: todas && punt >= 6 });
  });
  props.sort(function (a, b) { return b.punt - a.punt; });
  return props.slice(0, 4);
}

// ─── El asistente ───────────────────────────────────────────────────────────
// Analiza el CSV, aplica lo que ya se sabe traducir y devuelve SOLO lo que hay
// que decidir. Nada se escribe aquí.
function prepararImportacion(token, csv) {
  _exigirVista(token, 'gestion.rapido');
  var a = analizarCsv(csv);
  if (!a.ok) return a;

  var mapa = leerMapeoCache();
  var ctrls = leerControladoresCache().filter(function (c) { return c.activo; });
  var puestos = leerPuestosCache().map(function (p) { return p.puesto; });

  // Códigos: los conocidos por el motor pasan solos; el resto, a decidir.
  var codigos = [];
  Object.keys(a.codigos).sort(function (x, y) { return a.codigos[y] - a.codigos[x]; }).forEach(function (cod) {
    var norm = normalizarCodigo(cod);
    var yaVale = !!CONFIG_TURNOS[norm];
    var guardado = mapa.codigo && mapa.codigo[cod];
    codigos.push({
      origen: cod, veces: a.codigos[cod],
      destino: guardado !== undefined ? guardado : (yaVale ? norm : ''),
      resuelto: guardado !== undefined || yaVale,
      automatico: guardado === undefined && yaVale
    });
  });

  // Nombres: propuesta por apellidos y nombre de pila.
  var nombres = a.personas.map(function (p) {
    var guardado = mapa.nombre && mapa.nombre[p.nombre.toUpperCase()];
    var props = guardado ? [] : proponerIniciales(p.nombre, ctrls);
    return {
      origen: p.nombre,
      destino: guardado !== undefined ? guardado : ((props[0] && props[0].seguro) ? props[0].cta : ''),
      resuelto: guardado !== undefined || !!(props[0] && props[0].seguro),
      propuestas: props
    };
  });

  // Categorías del PDF (CON, SUP, TI…) a puestos.
  var categorias = Object.keys(a.categorias).map(function (cat) {
    var guardado = mapa.categoria && mapa.categoria[cat.toUpperCase()];
    var directo = puestos.indexOf(cat.toUpperCase()) !== -1 ? cat.toUpperCase() : '';
    return {
      origen: cat, veces: a.categorias[cat],
      destino: guardado !== undefined ? guardado : directo,
      resuelto: guardado !== undefined || !!directo
    };
  });

  return _sanear({
    ok: true,
    dias: a.dias, personas: a.personas.length,
    codigos: codigos, nombres: nombres, categorias: categorias,
    puestos: puestos,
    codigosConocidos: Object.keys(CONFIG_TURNOS),
    pendientes: {
      codigos: codigos.filter(function (c) { return !c.resuelto; }).length,
      nombres: nombres.filter(function (n) { return !n.resuelto; }).length,
      categorias: categorias.filter(function (c) { return !c.resuelto; }).length
    }
  });
}
