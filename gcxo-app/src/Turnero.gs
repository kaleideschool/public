/*******************************************************************************
 *
 * TURNERO.gs — Acceso a las hojas: turnero mensual, CONTROLADORES y CONFIG.
 * Incluye caché (CacheService) para acelerar las lecturas repetidas.
 * Depende de SpreadsheetApp → se ejecuta dentro del proyecto de Apps Script.
 * Prueba
 *
 ******************************************************************************/

var VERSION_TURNERO = 'turnero-33-cache-ctas';
var TURNERO = {
  FILA_DIAS: 3, FILA_CTA_INICIO: 4, COL_CARGO: 1, COL_CTA: 3, COL_DIA_INICIO: 4
};
// La matriz se mantiene en caché y se invalida SOLO cuando se edita la hoja
// (disparador onEdit, ver Backend.gs). Por eso la vida es larga (máx. de GAS).
var CACHE_SEG_MES = 21600;   // 6 h — vida de la caché del turnero
var CACHE_SEG_CTAS = 21600;  // 6 h — vida de la caché de CONTROLADORES
// Sufijo de las claves de caché. SÚBELO cada vez que cambie la FORMA de lo que
// se cachea (un campo nuevo en leerMes, en leerControladores…). Si no, durante
// 6 h se sigue sirviendo el objeto viejo sin ese campo, y el síntoma —una
// columna que sale vacía— no se parece en nada a la causa.
var CACHE_V = 'v7';   // v7: leerMes añade `paleta`/`paletaN` (tonos detectados en la hoja)

function _ss() { return SpreadsheetApp.getActive(); }
function _cache() { return CacheService.getScriptCache(); }

// ─── CONTROLADORES ──────────────────────────────────────────────────────────
// A iniciales · B nombre · C email · D token · E activo · F rol_app ·
// G puesto · H grupo · I activo_extras · J activo_vacas · K id · L alta · M baja
//
// ⚠️ LAS INICIALES NO SON LA IDENTIDAD. Son una etiqueta que se muestra y que
// puede pasar de una persona a otra: quien se va deja las suyas libres, y quien
// entra después puede recibirlas. La identidad es `id` (columna K), que se
// asigna una vez y no cambia nunca.
//
// De ahí que las iniciales solo tengan que ser únicas entre los ACTIVOS. Las
// columnas `alta` y `baja` acotan cuándo las tuvo cada uno, que es lo que
// permite saber a quién se refiere un registro antiguo.
//
// FUENTE ÚNICA de los datos de persona. Las columnas G-J vienen de la vieja
// pestaña LISTA ATC, que ningún código leía (solo fórmulas de la hoja) y que
// tenía 24 de 43 puestos vacíos. Se importan con importarDesdeListaAtc().
//
// `rol` es el papel en la APP (CTA/VALIDADOR/ADMIN); `puesto`, el del turnero
// (SUP, SUPIN, TINS, JSUPIN…), que decide competencias y permiso de reparto.
// El puesto del CUADRANTE manda sobre este; el de aquí es solo una red de
// seguridad para quien no tenga fila en ningún cuadrante vigente. `grupo` es
// para vacaciones.
function leerControladores() {
  var sh = _ss().getSheetByName('CONTROLADORES');
  if (!sh || sh.getLastRow() < 2) return [];
  var nCols = Math.min(13, sh.getMaxColumns());
  var val = sh.getRange(2, 1, sh.getLastRow() - 1, nCols).getValues();
  var out = [];
  val.forEach(function (r) {
    if (!r[0]) return;
    out.push({
      cta: String(r[0]).trim(),
      nombre: String(r[1] || '').trim(),
      email: String(r[2] || '').trim(),
      token: String(r[3] || '').trim(),
      activo: String(r[4]).toUpperCase() !== 'NO',
      rol: (String(r[5] || 'CTA').trim().toUpperCase() || 'CTA'),
      puesto: String(r[6] || '').trim().toUpperCase(),
      grupo: String(r[7] || '').trim(),
      activoExtras: _siSalvoQueDigaNo(r[8]),   // en blanco = sí participa
      activoVacas: _siSalvoQueDigaNo(r[9]),
      id: String(r[10] || '').trim(),          // identidad: no cambia nunca
      alta: _fechaDeCelda(r[11]),
      baja: _fechaDeCelda(r[12])
    });
  });
  return out;
}
function leerControladoresCache() {
  var hit = _cache().get('controladores_' + CACHE_V);
  if (hit) {
    try {
      // JSON convierte las fechas a texto: hay que revivirlas o personaDeCta
      // compararía Date contra String y no acertaría nunca.
      return JSON.parse(hit).map(function (c) {
        c.alta = c.alta ? new Date(c.alta) : null;
        c.baja = c.baja ? new Date(c.baja) : null;
        return c;
      });
    } catch (e) {}
  }
  var c = leerControladores();
  // ⚠️ La clave DEBE llevar el sufijo CACHE_V, igual que el `get` de arriba y
  // que `invalidarCacheControladores`. Sin él se escribía en 'controladores' y
  // se leía de 'controladores_v7', así que el `get` no acertaba NUNCA: cada
  // llamada releía la hoja CONTROLADORES entera. Y esta función se llama en
  // cada petición varias veces (identificarPorToken la usa la primera),
  // así que era la lectura más cara de la app repetida sin motivo.
  try { _cache().put('controladores_' + CACHE_V, JSON.stringify(c), CACHE_SEG_CTAS); } catch (e) {}
  return c;
}
function invalidarCacheControladores() { _cache().remove('controladores_' + CACHE_V); }

// ⚠️ Un ALUMNO no entra en la app: está dado de alta para poder programarle
// instrucción, no para usarla. Si algún día se le da acceso, será quitando
// este filtro y decidiendo qué pestañas ve.
function identificarPorToken(token) {
  if (!token) return null;
  var t = String(token).trim();
  var c = leerControladoresCache().filter(function (x) {
    return x.activo && x.token === t && !esAlumno(x);
  });
  return c.length ? c[0] : null;
}

// Alumno es un PUESTO, no un rol de la app: se adquiere y se deja, como SUP o
// SUPIN, y CARGOS_CTA guarda cuándo — que es justo lo que pasa cuando alguien
// termina la instrucción.
//
// Se resuelve por el orden de siempre (`_cargoDeCta`: CARGOS_CTA → cuadrante →
// columna G), porque el alta escribe el puesto en CARGOS_CTA y no en la
// columna. El `typeof` es para que el motor y este fichero sigan pudiendo
// cargarse sueltos en los tests, sin Backend.
var PUESTO_ALUMNO = 'ALUMNO';
function esAlumno(c) {
  if (!c) return false;
  var cta = String(c.cta || '').trim().toUpperCase();
  var p = '';
  if (cta && typeof _cargoDeCta === 'function') {
    try { p = String(_cargoDeCta(cta) || '').trim().toUpperCase(); } catch (e) {}
  }
  if (!p) p = String(c.puesto || '').trim().toUpperCase();
  return p === PUESTO_ALUMNO;
}
// Unas iniciales pueden aparecer en varias filas a lo largo del tiempo, así que
// estos mapas se quedan con quien las tiene AHORA. Para saber de quién eran en
// una fecha pasada, hay que ir a personaDeCta(cta, fecha).
function ctaAEmail() {
  var m = {};
  leerControladoresCache().forEach(function (c) { if (c.activo || !m[c.cta]) m[c.cta] = c.email; });
  return m;
}
function ctaANombre() {
  var m = {};
  leerControladoresCache().forEach(function (c) { if (c.activo || !m[c.cta]) m[c.cta] = c.nombre; });
  return m;
}

// Quién tenía esas iniciales en una fecha. Sin fecha, quien las tiene hoy.
// Es lo que hace que un registro viejo siga apuntando a la persona correcta
// aunque esas iniciales sean ya de otro.
function personaDeCta(cta, fecha) {
  var ref = fecha ? (_fechaDeCelda(fecha) || fecha) : null;
  var todas = leerControladoresCache().filter(function (c) {
    return String(c.cta).trim().toUpperCase() === String(cta).trim().toUpperCase();
  });
  if (!todas.length) return null;
  if (!ref) {
    var vivo = todas.filter(function (c) { return c.activo; })[0];
    return vivo || todas[todas.length - 1];
  }
  var enFecha = todas.filter(function (c) {
    return (!c.alta || ref >= c.alta) && (!c.baja || ref <= c.baja);
  });
  return enFecha.length ? enFecha[enFecha.length - 1] : null;
}

// ─── CARGOS_CTA: quién ocupa qué puesto, y desde cuándo ─────────────────────
// A CTA · B Puesto · C Desde · D Hasta · E Notas.
//
// Un puesto no es un atributo fijo de la persona: se adquiere y se deja. Una
// fila por periodo, con `Hasta` vacío para el que sigue vigente. Así se puede
// dar de alta a alguien como SUPIN a partir de una fecha sin reescribir el
// pasado, y el puesto de cualquier mes se deduce de la vigencia en lugar de
// tener que mirar el cuadrante de ese mes.
//
// Fechas en dd/MM/yyyy. `Desde` vacío = desde siempre; `Hasta` vacío = sigue.
var HOJA_CARGOS = 'CARGOS_CTA';
var CABECERA_CARGOS = ['CTA', 'Puesto', 'Desde', 'Hasta', 'Notas', 'ID persona'];

function _fechaDeCelda(v) {
  if (v instanceof Date) return new Date(v.getFullYear(), v.getMonth(), v.getDate());
  var s = String(v == null ? '' : v).trim();
  if (!s) return null;
  var m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);   // dd/MM/yyyy
  if (m) return _fechaValida(Number(m[3]), Number(m[2]), Number(m[1]));
  var i = s.match(/^(\d{4})-(\d{2})-(\d{2})/);                   // ISO
  if (i) return _fechaValida(Number(i[1]), Number(i[2]), Number(i[3]));
  return null;
}
// new Date(2026, 12, 32) no protesta: desborda a enero de 2027. Comprobamos
// que la fecha construida es la que se pidió, o no es una fecha.
function _fechaValida(anio, mes, dia) {
  var d = new Date(anio, mes - 1, dia);
  if (d.getFullYear() !== anio || d.getMonth() !== mes - 1 || d.getDate() !== dia) return null;
  return d;
}
function _fechaTexto(d) {
  if (!d) return '';
  return ('0' + d.getDate()).slice(-2) + '/' + ('0' + (d.getMonth() + 1)).slice(-2) + '/' + d.getFullYear();
}

function hojaCargos() {
  var sh = _ss().getSheetByName(HOJA_CARGOS);
  if (!sh) {
    sh = _ss().insertSheet(HOJA_CARGOS);
    sh.appendRow(CABECERA_CARGOS);
    sh.getRange(1, 3, sh.getMaxRows(), 2).setNumberFormat('@'); // fechas como TEXTO
  }
  return sh;
}

function leerCargos() {
  var sh = hojaCargos();
  if (sh.getLastRow() < 2) return [];
  var val = sh.getRange(2, 1, sh.getLastRow() - 1, CABECERA_CARGOS.length).getValues();
  var out = [];
  val.forEach(function (r, i) {
    var cta = String(r[0] || '').trim().toUpperCase();
    var puesto = String(r[1] || '').trim().toUpperCase();
    if (!cta || !puesto) return;
    out.push({
      fila: i + 2, cta: cta, puesto: puesto,
      desde: _fechaDeCelda(r[2]), hasta: _fechaDeCelda(r[3]),
      notas: String(r[4] || ''),
      idCta: String(r[5] || '').trim()   // identidad, por si las iniciales cambian de dueño
    });
  });
  return out;
}

function leerCargosCache() {
  var hit = _cache().get('cargos_cta_' + CACHE_V);
  if (hit) {
    try {
      return JSON.parse(hit).map(function (c) {
        c.desde = c.desde ? new Date(c.desde) : null;
        c.hasta = c.hasta ? new Date(c.hasta) : null;
        return c;
      });
    } catch (e) {}
  }
  var c = leerCargos();
  try { _cache().put('cargos_cta_' + CACHE_V, JSON.stringify(c), CACHE_SEG_CTAS); } catch (e) {}
  return c;
}
function invalidarCacheCargos() { _cache().remove('cargos_cta_' + CACHE_V); }

// Puesto vigente de un CTA en una fecha. Si hay varios que solapan —no debería,
// pero la hoja la escribe gente— gana el de `Desde` más reciente.
function puestoVigente(cta, fecha) {
  var ref = fecha ? _fechaDeCelda(fecha) || fecha : new Date();
  var mejor = null;
  leerCargosCache().forEach(function (c) {
    if (String(c.cta).toUpperCase() !== String(cta).trim().toUpperCase()) return;
    if (c.desde && ref < c.desde) return;
    if (c.hasta && ref > c.hasta) return;
    if (!mejor || (c.desde && (!mejor.desde || c.desde > mejor.desde))) mejor = c;
  });
  return mejor ? mejor.puesto : '';
}

// ─── PUESTOS y competencias ─────────────────────────────────────────────────
// A Puesto · B Supervisar · C Instruir · D Cambia turnos · E Notas.
// Es la fuente de verdad de qué puede hacer cada puesto; el motor solo trae
// unos valores de arranque. Se siembra sola con esos valores la primera vez.
//
// Las tres columnas se leen igual: "puede hacer esto".
//   Supervisar    → puede recibir Ms/Ts y entra en el reparto de supervisiones
//   Instruir      → puede recibir Mo/To y entra en el reparto de instrucción
//   Cambia turnos → participa en el intercambio de turnos entre compañeros:
//                   puede proponer, sale como candidato y sus cambios se
//                   registran. En NO (las jefaturas) queda fuera del circuito.
var HOJA_PUESTOS = 'PUESTOS';
// «Evaluar» se añadió después: va al final para no descolocar las columnas de
// las hojas que ya existían, y `hojaPuestos()` completa la cabecera si falta.
// ⚠ Las columnas nuevas van AL FINAL, para no descolocar las hojas que ya
// existen. Las filas viejas traen la última vacía y `_siSalvoQueDigaNo` la lee
// como SÍ, que es lo conservador: participar es lo normal.
var CABECERA_PUESTOS = ['Puesto', 'Supervisar', 'Instruir', 'Cambia turnos', 'Solo si no hay nadie', 'Notas', 'Evaluar', 'Recibe servicios'];

function _si(v) {
  var s = String(v == null ? '' : v).trim().toUpperCase();
  return s === 'SÍ' || s === 'SI' || s === 'X' || s === '1' || s === 'TRUE' || s === 'VERDADERO';
}
// Para "Cambia turnos": la celda en blanco significa SÍ. Lo normal es
// participar, y una fila añadida a medias no debe dejar a nadie fuera del
// circuito sin que se haya escrito un NO explícito.
function _siSalvoQueDigaNo(v) {
  var s = String(v == null ? '' : v).trim().toUpperCase();
  if (s === '') return true;
  return !(s === 'NO' || s === 'N' || s === '0' || s === 'FALSE' || s === 'FALSO');
}
function _sn(b) { return b ? 'SÍ' : 'NO'; }

function hojaPuestos() {
  var sh = _ss().getSheetByName(HOJA_PUESTOS);
  if (!sh) {
    sh = _ss().insertSheet(HOJA_PUESTOS);
    sh.appendRow(CABECERA_PUESTOS);
    PUESTOS_DEFECTO.forEach(function (p) {   // del motor
      sh.appendRow([p.puesto, _sn(p.capacidades.indexOf('supervisar') !== -1),
        _sn(p.capacidades.indexOf('instruir') !== -1), _sn(!p.excluido),
        _sn(!!p.excepcional), '', _sn(p.capacidades.indexOf('evaluar') !== -1),
        _sn(!p.sinReparto)]);
    });
    return sh;
  }
  // Cabecera de una versión anterior: se completa.
  if (sh.getLastColumn() < CABECERA_PUESTOS.length) {
    sh.getRange(1, 1, 1, CABECERA_PUESTOS.length).setValues([CABECERA_PUESTOS]);
  }
  _sembrarColumnasNuevas(sh);
  return sh;
}

// ⚠️ Al AÑADIR una columna, las filas que ya existían la traen VACÍA — y vacía
// no es neutro: «Recibe servicios» en blanco se lee como SÍ, así que las
// jefaturas entraban en el reparto pese a que la semilla dice lo contrario.
// Completar solo la cabecera no basta: hay que darle a cada puesto CONOCIDO el
// valor de la semilla, y solo donde esté en blanco — nunca pisando un SÍ/NO
// que alguien haya puesto a mano. Un puesto que no esté en la semilla se queda
// en blanco, que es lo conservador: participa.
function _sembrarColumnasNuevas(sh) {
  if (sh.getLastRow() < 2) return;
  var COL_REPARTO = CABECERA_PUESTOS.indexOf('Recibe servicios') + 1;
  if (!COL_REPARTO) return;
  var n = sh.getLastRow() - 1;
  var nombres = sh.getRange(2, 1, n, 1).getValues();
  var rango = sh.getRange(2, COL_REPARTO, n, 1);
  var val = rango.getValues();
  var semilla = {};
  PUESTOS_DEFECTO.forEach(function (p) { semilla[p.puesto] = !p.sinReparto; });
  var tocado = false;
  for (var i = 0; i < n; i++) {
    if (String(val[i][0] || '').trim() !== '') continue;      // ya dice algo
    var nombre = String(nombres[i][0] || '').trim().toUpperCase();
    if (!(nombre in semilla)) continue;                      // no lo conozco: en blanco = sí
    val[i][0] = _sn(semilla[nombre]);
    tocado = true;
  }
  if (tocado) rango.setValues(val);
}

function leerPuestos() {
  var sh = hojaPuestos();
  if (sh.getLastRow() < 2) return [];
  var val = sh.getRange(2, 1, sh.getLastRow() - 1, CABECERA_PUESTOS.length).getValues();
  var out = [];
  val.forEach(function (r) {
    var nombre = String(r[0] || '').trim().toUpperCase();
    if (!nombre) return;
    var caps = [];
    if (_si(r[1])) caps.push('supervisar');
    if (_si(r[2])) caps.push('instruir');
    if (_si(r[6])) caps.push('evaluar');
    // La hoja declara "Cambia turnos"; dentro se sigue manejando como excluido.
    out.push({
      puesto: nombre, capacidades: caps, excluido: !_siSalvoQueDigaNo(r[3]),
      excepcional: _si(r[4]),          // «Solo si no hay nadie»: última opción
      // «Recibe servicios»: extras, voluntarias, COS, activaciones y
      // desprogramaciones. En blanco = SÍ.
      sinReparto: !_siSalvoQueDigaNo(r[7]),
      notas: String(r[5] || '')
    });
  });
  return out;
}

function leerPuestosCache() {
  var hit = _cache().get('puestos_' + CACHE_V);
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  var p = leerPuestos();
  try { _cache().put('puestos_' + CACHE_V, JSON.stringify(p), CACHE_SEG_CTAS); } catch (e) {}
  return p;
}
function invalidarCachePuestos() { _cache().remove('puestos_' + CACHE_V); }

// Carga la configuración de la hoja en el motor. Barata (va por caché) y hay
// que llamarla antes de cualquier decisión que dependa de competencias.
function aplicarConfigPuestos() {
  try { configurarPuestos(leerPuestosCache()); }
  catch (e) { _logApp('WARN', 'aplicarConfigPuestos', 'no se pudo leer PUESTOS, se usan los valores de arranque: ' + e); }
}

// ─── Meses ──────────────────────────────────────────────────────────────────
function listarMeses() {
  var re = /^[A-ZÁÉÍÓÚÑ]+-\d{2}$/i;
  return _ss().getSheets().map(function (s) { return s.getName(); })
    .filter(function (n) { return re.test(n); });
}

// ─── Lectura de un mes ──────────────────────────────────────────────────────
// { base:{cta:{dia:code}}, cargos:{cta}, dias:[], diaACol:{}, filaDeCta:{},
//   bajas:{cta:{dia:true}}, vacaciones:{cta:{dia:true}} }
function leerMes(nombreMes) {
  var sh = _ss().getSheetByName(nombreMes);
  if (!sh) throw new Error('No existe la hoja "' + nombreMes + '"');

  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  var valores = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var fondos = sh.getRange(1, 1, lastRow, lastCol).getBackgrounds();

  var dias = [], diaACol = {};
  for (var c = TURNERO.COL_DIA_INICIO; c <= lastCol; c++) {
    var v = valores[TURNERO.FILA_DIAS - 1][c - 1];
    if (typeof v !== 'number' || v < 1 || v > 31) break;
    dias.push(v); diaACol[v] = c;
  }

  // Columnas calculadas a la derecha de los días: HORAS y H.MAX. son fórmulas
  // de la hoja, no se pueden derivar aquí (H.MAX. depende de vacaciones,
  // ajustes…). Se localizan por su ETIQUETA en la fila de días, no por
  // posición: así aguantan que se inserte una columna.
  var colHoras = 0, colHMax = 0;
  for (var ce = TURNERO.COL_DIA_INICIO; ce <= lastCol; ce++) {
    var et = String(valores[TURNERO.FILA_DIAS - 1][ce - 1] || '').trim().toUpperCase().replace(/[.\s]/g, '');
    if (et === 'HORAS') colHoras = ce;
    else if (et === 'HMAX') colHMax = ce;
  }

  // Los tonos que usa ESTA hoja para cada marca, con cuántas celdas los llevan.
  // NO se usan al escribir —para eso está la paleta guardada en properties—:
  // sirven para DETECTARLOS y proponerlos en «Configuración → Colores».
  // Gana el más repetido, así que una celda suelta mal pintada no arrastra.
  var cuentaFondos = {};
  var base = {}, cargos = {}, filaDeCta = {}, bajas = {}, vac = {}, marcas = {};
  for (var r = TURNERO.FILA_CTA_INICIO; r <= lastRow; r++) {
    var cta = valores[r - 1][TURNERO.COL_CTA - 1];
    if (!cta && cta !== 0) break;
    cta = String(cta).trim();
    if (!cta) break;
    cargos[cta] = String(valores[r - 1][TURNERO.COL_CARGO - 1] || '').trim().toUpperCase();
    filaDeCta[cta] = r; base[cta] = {}; bajas[cta] = {}; vac[cta] = {};
    dias.forEach(function (d) {
      var col = diaACol[d];
      var bg = fondos[r - 1][col - 1];
      var code = normalizarCodigo(valores[r - 1][col - 1]); // del motor
      var marca = claseDeFondo(bg);
      if (marca) {
        if (!marcas[cta]) marcas[cta] = {};
        marcas[cta][d] = marca;
        var hx = String(bg || '').toLowerCase();
        if (!cuentaFondos[marca]) cuentaFondos[marca] = {};
        cuentaFondos[marca][hx] = (cuentaFondos[marca][hx] || 0) + 1;
      }
      // La baja guarda SU CÓDIGO, no un simple true: en la hoja pone "-M" o
      // "-Ts" y esa información se perdía, así que en el turnero global el día
      // salía en blanco y parecía que libraba.
      if (marca === 'baja') { bajas[cta][d] = code || true; return; }
      if (code === 'V') vac[cta][d] = true;
      else if (code && code !== 'libre') base[cta][d] = code;
    });
  }
  // De cada marca, el tono más repetido en la hoja y en cuántas celdas.
  var paleta = {}, paletaN = {};
  for (var mk in cuentaFondos) {
    var mejor = '', n = -1;
    for (var hex in cuentaFondos[mk]) {
      if (cuentaFondos[mk][hex] > n) { n = cuentaFondos[mk][hex]; mejor = hex; }
    }
    if (mejor) { paleta[mk] = mejor; paletaN[mk] = n; }
  }

  // Se leen como TEXTO VISIBLE: en la hoja son duraciones ("156:17") y
  // getValues() las devolvería como Date, que además no puede viajar al
  // cliente. getDisplayValues() da lo mismo que se ve.
  var resumen = {};
  if (colHoras || colHMax) {
    var c1 = Math.min.apply(null, [colHoras || colHMax, colHMax || colHoras]);
    var c2 = Math.max.apply(null, [colHoras || colHMax, colHMax || colHoras]);
    try {
      var filasCta = [];
      for (var k in filaDeCta) filasCta.push(filaDeCta[k]);
      if (filasCta.length) {
        var f1 = Math.min.apply(null, filasCta), f2 = Math.max.apply(null, filasCta);
        var vis = sh.getRange(f1, c1, f2 - f1 + 1, c2 - c1 + 1).getDisplayValues();
        for (var cta2 in filaDeCta) {
          var fi = filaDeCta[cta2] - f1;
          resumen[cta2] = {
            horas: colHoras ? String((vis[fi] || [])[colHoras - c1] || '') : '',
            hmax: colHMax ? String((vis[fi] || [])[colHMax - c1] || '') : ''
          };
        }
      }
    } catch (e) { resumen = {}; }
  }

  return { base: base, cargos: cargos, dias: dias, diaACol: diaACol,
    filaDeCta: filaDeCta, bajas: bajas, vacaciones: vac, resumen: resumen, marcas: marcas,
    paleta: paleta, paletaN: paletaN };
}

// Versión cacheada para las vistas interactivas (calendario, candidatos).
// Las operaciones que ESCRIBEN o validan de forma autoritativa usan leerMes (fresco).
function leerMesCache(nombreMes) {
  var key = 'mes_' + CACHE_V + '_' + nombreMes;
  var hit = _cache().get(key);
  if (hit) {
    try { var m0 = JSON.parse(hit); _logApp('DEBUG', 'leerMes', nombreMes + ' (caché)'); return m0; } catch (e) {}
  }
  var t0 = Date.now();
  var m = leerMes(nombreMes);
  try { _cache().put(key, JSON.stringify(m), CACHE_SEG_MES); }
  catch (e) { _logApp('WARN', 'leerMes', nombreMes + ' no cacheable: ' + e); }
  _logApp('DEBUG', 'leerMes', nombreMes + ' (LEÍDO de hoja)', '', Date.now() - t0);
  return m;
}
function invalidarCacheMes(nombreMes) { _cache().remove('mes_' + CACHE_V + '_' + nombreMes); }

// ─── El color del fondo ES información ──────────────────────────────────────
// En el cuadrante, el mismo código puede significar cosas distintas según cómo
// esté pintada la celda: una M sobre verde es una extra, sobre azul una hora
// voluntaria, sobre cian una imaginaria activada. Adivinarlo del texto es
// imposible, así que se clasifica el fondo.
//
// Leyenda de la hoja:
//   rojo    → baja            verde → extra / COS
//   azul    → horas voluntarias   cian  → imaginaria activada
//   naranja → jornada fuera de ciclo
//   gris    → vacaciones y reducción de jornada (mr/tr/imr/itr)
function claseDeFondo(hex) {
  if (!hex) return '';
  var h = String(hex).replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length !== 6) return '';
  var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  if (r > 240 && g > 240 && b > 240) return '';           // blanco: sin marca
  var max = Math.max(r, g, b), min = Math.min(r, g, b);

  if (max - min < 28) return (max < 235) ? 'gris' : '';   // gris neutro
  if (r > 150 && g < 110 && b < 110) return 'baja';       // rojo
  if (g > 150 && r < 150 && b < 150) return 'extra';      // verde
  if (g > 170 && b > 170 && r < 160) return 'activada';   // cian
  if (b > 150 && r < 140) return 'voluntaria';            // azul
  if (r > 200 && g > 110 && g < 210 && b < 120) return 'fueraCiclo'; // naranja
  return '';
}

// El camino contrario de `claseDeFondo`: qué fondo hay que ESCRIBIR para cada
// marca. Son los tonos que ya usa la hoja, y cada uno vuelve a clasificarse
// como su marca —hay un test que lo comprueba en los dos sentidos—, así que
// escribir y volver a leer no cambia el significado.
// Los cuatro primeros son los de la hoja «Turneros GCXO», dictados por Diego
// el 2026-08-16. Los otros dos siguen siendo aproximaciones, pendientes de
// confirmar — y de todos modos la app los detecta sola del cuadrante.
var FONDO_DE_MARCA = {
  baja:       '#ff0000',   // rojo    ✔ confirmado
  extra:      '#00ff00',   // verde   ✔ confirmado (extras y COS)
  voluntaria: '#4a86e8',   // azul    ✔ confirmado
  activada:   '#00ffff',   // cian    ✔ confirmado (imaginaria activada)
  fueraCiclo: '#f6b26b',   // naranja — sin confirmar
  gris:       '#cccccc',   // gris    — sin confirmar (vacaciones y reducción)
  '':         '#ffffff'    // sin marca
};
function fondoDeMarca(marca) {
  var f = FONDO_DE_MARCA[marca || ''];
  return f || '#ffffff';
}

function _esColorRojo(hex) {
  if (!hex || hex === '#ffffff') return false;
  var h = hex.replace('#', '');
  if (h.length !== 6) return false;
  var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return r > 150 && g < 100 && b < 100;
}

/* ═══════════════════════════════════════════════════════════════════════════
   DOTACIÓN  —  cuánta gente hace falta cada día

   Hoja `DOTACION`: una fila por mes y franja, una columna por día.
   `Mes · Franja · D1 … D31`, con los valores en el formato del cuadrante:
   `4+1` = 4 controladores y 1 supervisor; `4` = `4+0`; vacío = sin exigencia.

   Día a día y sin patrones, a propósito (decidido el 2026-08-15): las
   necesidades van por día y cualquier regla por día de la semana falla justo
   el día raro, que es el que importa. Las plantillas RELLENAN la rejilla de
   una vez, pero lo guardado siguen siendo los 31 valores explícitos y nada
   los consulta al leer.
   ═══════════════════════════════════════════════════════════════════════════ */

var HOJA_DOTACION = 'DOTACION';
var HOJA_PLANTILLAS_DOT = 'PLANTILLAS_DOTACION';
var FRANJAS_DOTACION = ['M', 'T'];

function _cabeceraDotacion(primera) {
  var c = [primera, 'Franja'];
  for (var d = 1; d <= 31; d++) c.push('D' + d);
  return c;
}

function _hojaDotacion() {
  var sh = _ss().getSheetByName(HOJA_DOTACION);
  if (sh) return _asegurarCabecera(_mesComoTexto(sh), _cabeceraDotacion('Mes'));
  if (!sh) {
    sh = _ss().insertSheet(HOJA_DOTACION);
    sh.appendRow(_cabeceraDotacion('Mes'));
    sh.getRange(1, 1, sh.getMaxRows(), 2).setNumberFormat('@'); // "AGO-26" y "M" como TEXTO
  }
  return sh;
}

// Controladores + supervisores + instructores, en ese orden:
//   "4+1+1" → {cta:4, sup:1, ins:1}
//   "4+1"   → {cta:4, sup:1, ins:0}     (lo que ya había escrito)
//   "4"     → {cta:4, sup:0, ins:0}
//   ""      → null, que es «ese día no se comprueba»
function parsearDotacion(txt) {
  var t = String(txt == null ? '' : txt).trim();
  if (!t) return null;
  var m = t.match(/^(\d+)\s*(?:\+\s*(\d+))?\s*(?:\+\s*(\d+))?$/);
  if (!m) return null;
  return {
    cta: parseInt(m[1], 10),
    sup: m[2] ? parseInt(m[2], 10) : 0,
    ins: m[3] ? parseInt(m[3], 10) : 0
  };
}
// Se escribe lo justo: los ceros de la derecha no se ponen.
function formatearDotacion(d) {
  if (!d) return '';
  if (d.ins) return d.cta + '+' + d.sup + '+' + d.ins;
  if (d.sup) return d.cta + '+' + d.sup;
  return String(d.cta);
}

// { M: {1:'4+1', 2:'4', …}, T: {…} } — el texto tal cual está guardado.
function leerDotacion(mes) {
  var sh = _hojaDotacion();
  var out = {};
  FRANJAS_DOTACION.forEach(function (f) { out[f] = {}; });
  if (sh.getLastRow() < 2) return out;
  var val = sh.getRange(2, 1, sh.getLastRow() - 1, 33).getValues();
  var mk = _mesKeyDot(mes);
  val.forEach(function (r) {
    if (_mesKeyDot(r[0]) !== mk) return;
    var franja = String(r[1] || '').trim().toUpperCase();
    if (FRANJAS_DOTACION.indexOf(franja) === -1) return;
    for (var d = 1; d <= 31; d++) {
      var t = String(r[1 + d] == null ? '' : r[1 + d]).trim();
      if (t) out[franja][d] = t;
    }
  });
  return out;
}

// ⚠️ Google convierte «AGO-26» en una FECHA en cuanto puede: la celda queda
// alineada a la derecha y pone «ago-26», pero dentro hay un Date. Al leerla,
// String(fecha) no se parece en nada a «AGO-26» y la fila deja de encontrarse
// —está a la vista en la hoja y la app jura que no hay ninguna—. Se formatea
// la columna como texto al abrir la hoja, y aun así se acepta el Date al leer:
// las filas que ya se escribieron así siguen valiendo.
var MES3_DOT = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
function _mesKeyDot(m) {
  if (m instanceof Date) {
    return MES3_DOT[m.getMonth()] + '-' + ('0' + (m.getFullYear() % 100)).slice(-2);
  }
  return String(m == null ? '' : m).trim().toUpperCase();
}

// Sobreescribe las filas de ese mes. `datos` = { M:{1:'4+1',…}, T:{…} }.
function guardarDotacion(mes, datos) {
  var sh = _hojaDotacion();
  var mk = _mesKeyDot(mes);
  // Fuera las filas viejas de ese mes, de abajo arriba para no descolocar.
  if (sh.getLastRow() > 1) {
    var val = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
    for (var i = val.length - 1; i >= 0; i--) {
      if (_mesKeyDot(val[i][0]) === mk) sh.deleteRow(i + 2);
    }
  }
  FRANJAS_DOTACION.forEach(function (f) {
    var fila = [mk, f];
    for (var d = 1; d <= 31; d++) fila.push(String((datos[f] || {})[d] || '').trim());
    sh.appendRow(fila);
  });
  return true;
}

// La fila DOTACIÓN del cuadrante, para sembrar sin teclear. Se busca por su
// texto en la columna de iniciales; si hay dos, la primera es la mañana y la
// segunda la tarde, y si solo hay una vale para las dos.
function dotacionDelCuadrante(mes) {
  var sh = _ss().getSheetByName(mes);
  if (!sh) return null;
  var lastRow = Math.min(sh.getLastRow(), 80), lastCol = sh.getLastColumn();
  if (lastRow < TURNERO.FILA_DIAS) return null;
  var valores = sh.getRange(1, 1, lastRow, lastCol).getValues();

  var diaACol = {};
  for (var c = TURNERO.COL_DIA_INICIO; c <= lastCol; c++) {
    var v = valores[TURNERO.FILA_DIAS - 1][c - 1];
    var n = parseInt(v, 10);
    if (n >= 1 && n <= 31 && !diaACol[n]) diaACol[n] = c;
  }
  if (!Object.keys(diaACol).length) return null;

  var filas = [];
  for (var r = 1; r <= lastRow; r++) {
    var etiqueta = String(valores[r - 1][TURNERO.COL_CTA - 1] || '').trim();
    if (/^DOTACI[OÓ]N/i.test(etiqueta)) filas.push(r);
  }
  if (!filas.length) return null;

  var out = {};
  FRANJAS_DOTACION.forEach(function (f, i) {
    var fila = filas[i] || filas[0];
    out[f] = {};
    for (var d in diaACol) {
      var t = String(valores[fila - 1][diaACol[d] - 1] || '').trim();
      if (t) out[f][d] = t;
    }
  });
  return { filas: filas, datos: out };
}

// ─── Plantillas ─────────────────────────────────────────────────────────────
// `Nombre · Franja · D1 … D31`. Rellenan la rejilla de un mes de una vez; NADA
// las consulta al leer la dotación.
function _hojaPlantillasDot() {
  var sh = _ss().getSheetByName(HOJA_PLANTILLAS_DOT);
  if (!sh) {
    sh = _ss().insertSheet(HOJA_PLANTILLAS_DOT);
    sh.appendRow(_cabeceraDotacion('Nombre'));
    sh.getRange(1, 1, sh.getMaxRows(), 2).setNumberFormat('@');
  }
  return sh;
}

function leerPlantillasDot() {
  var sh = _hojaPlantillasDot();
  if (sh.getLastRow() < 2) return [];
  var val = sh.getRange(2, 1, sh.getLastRow() - 1, 33).getValues();
  var porNombre = {};
  val.forEach(function (r) {
    var nombre = String(r[0] || '').trim();
    var franja = String(r[1] || '').trim().toUpperCase();
    if (!nombre || FRANJAS_DOTACION.indexOf(franja) === -1) return;
    if (!porNombre[nombre]) { porNombre[nombre] = { nombre: nombre, datos: { M: {}, T: {} } }; }
    for (var d = 1; d <= 31; d++) {
      var t = String(r[1 + d] == null ? '' : r[1 + d]).trim();
      if (t) porNombre[nombre].datos[franja][d] = t;
    }
  });
  return Object.keys(porNombre).map(function (n) { return porNombre[n]; });
}

function guardarPlantillaDot(nombre, datos) {
  var sh = _hojaPlantillasDot();
  var nk = String(nombre).trim();
  if (sh.getLastRow() > 1) {
    var val = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
    for (var i = val.length - 1; i >= 0; i--) {
      if (String(val[i][0] || '').trim().toUpperCase() === nk.toUpperCase()) sh.deleteRow(i + 2);
    }
  }
  FRANJAS_DOTACION.forEach(function (f) {
    var fila = [nk, f];
    for (var d = 1; d <= 31; d++) fila.push(String((datos[f] || {})[d] || '').trim());
    sh.appendRow(fila);
  });
  return true;
}

function borrarPlantillaDot(nombre) {
  var sh = _hojaPlantillasDot();
  if (sh.getLastRow() < 2) return false;
  var nk = String(nombre).trim().toUpperCase();
  var val = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
  var n = 0;
  for (var i = val.length - 1; i >= 0; i--) {
    if (String(val[i][0] || '').trim().toUpperCase() === nk) { sh.deleteRow(i + 2); n++; }
  }
  return n > 0;
}

/* ═══════════════════════════════════════════════════════════════════════════
   TURNERO DE ALUMNOS  —  hoja propia

   `TURNERO_ALUMNOS`: una fila por mes y alumno, una columna por día.
   `Mes · CTA · D1 … D31`.

   La hoja del mes tiene más abajo un bloque de instrucción con instructores y
   alumnos, pero está maquetado para leerlo en Sheets: sin rótulos, con las
   personas donde caen y con bloques de cursos en medio. Se descartó leer de
   ahí —había que adivinar dónde empieza cada cosa— y se guarda aparte, que es
   lo coherente con usar la hoja como ALMACÉN y la app como interfaz.

   Los turnos de los INSTRUCTORES no se guardan aquí: son sus Mo/To del
   cuadrante, que ya lee `leerMes`.
   ═══════════════════════════════════════════════════════════════════════════ */

var HOJA_ALUMNOS = 'TURNERO_ALUMNOS';

function _hojaAlumnos() {
  var sh = _ss().getSheetByName(HOJA_ALUMNOS);
  if (sh) return _asegurarCabecera(_mesComoTexto(sh), _cabeceraDotacion('Mes'));
  if (!sh) {
    sh = _ss().insertSheet(HOJA_ALUMNOS);
    sh.appendRow(_cabeceraDotacion('Mes'));            // Mes · CTA · D1…D31
    sh.getRange(1, 2).setValue('CTA');
    sh.getRange(1, 1, sh.getMaxRows(), 2).setNumberFormat('@');
  }
  return sh;
}

// { WT: {1:'T', 2:'T'}, GS: {…} }
function leerTurnoAlumnos(mes) {
  var sh = _hojaAlumnos();
  var out = {};
  if (sh.getLastRow() < 2) return out;
  var val = sh.getRange(2, 1, sh.getLastRow() - 1, 33).getValues();
  var mk = _mesKeyDot(mes);
  val.forEach(function (r) {
    if (_mesKeyDot(r[0]) !== mk) return;
    var cta = String(r[1] || '').trim().toUpperCase();
    if (!cta) return;
    if (!out[cta]) out[cta] = {};
    for (var d = 1; d <= 31; d++) {
      var t = String(r[1 + d] == null ? '' : r[1 + d]).trim();
      if (t) out[cta][d] = t;
    }
  });
  return out;
}

// Escribe un día. Devuelve lo que había, para poder deshacerlo.
function guardarTurnoAlumno(mes, cta, dia, turno) {
  var sh = _hojaAlumnos();
  var mk = _mesKeyDot(mes), ck = String(cta).trim().toUpperCase();
  dia = Number(dia);
  if (!(dia >= 1 && dia <= 31)) throw new Error('Día fuera de rango: ' + dia);

  var fila = 0;
  if (sh.getLastRow() > 1) {
    var val = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
    for (var i = 0; i < val.length; i++) {
      if (_mesKeyDot(val[i][0]) === mk && String(val[i][1] || '').trim().toUpperCase() === ck) {
        fila = i + 2; break;
      }
    }
  }
  if (!fila) {
    var nueva = [mk, ck];
    for (var d = 1; d <= 31; d++) nueva.push('');
    sh.appendRow(nueva);
    fila = sh.getLastRow();
  }
  var celda = sh.getRange(fila, 2 + dia);
  var previo = String(celda.getValue() == null ? '' : celda.getValue()).trim();
  celda.setValue(String(turno).toLowerCase() === 'libre' ? '' : String(turno).trim());
  return previo;
}

/* ═══════════════════════════════════════════════════════════════════════════
   PAREJAS  —  quién va con quién

   Hoja `PAREJAS`: Mes · Día · Turno · Tipo · Quién · Con quién.

   · `instruccion` → quién = el instructor (`Mo`/`To`), con quién = el alumno
   · `evaluacion`  → quién = el evaluador (`EvM`/`EvT`), con quién = el evaluado

   Los dos son el mismo problema: el cuadrante dice que ese día hay una
   instrucción o una evaluación, pero no CON QUIÉN, y sin eso «Mi calendario»
   solo puede enseñar todos los candidatos de la franja. Se decide donde se
   reparte y se guarda aquí.
   ═══════════════════════════════════════════════════════════════════════════ */

/* ─── Saldos declarados a mano ──────────────────────────────────────────────
   Acumulados de los que NO se tiene el detalle: no hay fecha, ni día, ni qué
   celda fue. Meterlos en LOG_DIAS o en LOG_CELDAS con una fecha inventada
   ensuciaría el histórico con hechos falsos — un día que nadie trabajó.

   Así que van aparte, como un **saldo inicial** de contabilidad: una cifra
   declarada por persona, tipo y año, que el lector SUMA a lo que sí está
   registrado. Se ve en la hoja, se edita a mano y se puede borrar el día que
   ese año salga del trienio.
   ───────────────────────────────────────────────────────────────────────── */
var HOJA_AJUSTES = 'AJUSTES_ACUM';
var CABECERA_AJUSTES = ['CTA', 'Tipo', 'Año', 'Cantidad', 'Nota'];

function hojaAjustesAcum() {
  var sh = _ss().getSheetByName(HOJA_AJUSTES);
  if (!sh) { sh = _ss().insertSheet(HOJA_AJUSTES); sh.appendRow(CABECERA_AJUSTES); return sh; }
  return _asegurarCabecera(sh, CABECERA_AJUSTES);
}

// [{cta, tipo, anio, n, nota, fila}]. Las cantidades no numéricas se descartan:
// un saldo que no es un número no es un saldo.
function leerAjustesAcum() {
  var sh = hojaAjustesAcum();
  if (sh.getLastRow() < 2) return [];
  var val = sh.getRange(2, 1, sh.getLastRow() - 1, CABECERA_AJUSTES.length).getValues();
  var out = [];
  val.forEach(function (r, i) {
    var cta = String(r[0] || '').trim().toUpperCase();
    var tipo = String(r[1] || '').trim().toUpperCase();
    var anio = Number(r[2]);
    var n = Number(r[3]);
    if (!cta || !tipo || !anio || !isFinite(n) || n <= 0) return;
    out.push({ cta: cta, tipo: tipo, anio: anio, n: n, nota: String(r[4] || ''), fila: i + 2 });
  });
  return out;
}

var HOJA_PAREJAS = 'PAREJAS';
var CABECERA_PAREJAS = ['Mes', 'Día', 'Turno', 'Tipo', 'Quién', 'Con quién'];
var TIPOS_PAREJA = ['instruccion', 'evaluacion'];

// ⚠️ Toda la lectura de estas hojas da por hecho que la FILA 1 es la cabecera:
// `getRange(2, ...)`. Si falta —se borró, o la creó alguien a mano—, la primera
// fila de datos se toma por cabecera y desaparece sin más, que es un síntoma
// horrible: la fila está a la vista en la hoja y la app jura que no hay nada.
// La columna del mes, siempre como texto: si no, la siguiente escritura vuelve
// a convertirse en fecha.
function _mesComoTexto(sh) {
  try { sh.getRange(1, 1, sh.getMaxRows(), 1).setNumberFormat('@'); } catch (e) {}
  return sh;
}

function _asegurarCabecera(sh, cabecera) {
  var primera = sh.getLastRow() ? String(sh.getRange(1, 1).getValue() || '').trim() : '';
  if (primera === cabecera[0]) return sh;
  sh.insertRowBefore(1);
  sh.getRange(1, 1, 1, cabecera.length).setValues([cabecera]);
  return sh;
}

function _hojaParejas() {
  var sh = _ss().getSheetByName(HOJA_PAREJAS);
  if (!sh) {
    sh = _ss().insertSheet(HOJA_PAREJAS);
    sh.appendRow(CABECERA_PAREJAS);
    sh.getRange(1, 1, sh.getMaxRows(), 1).setNumberFormat('@');   // "AGO-26" como TEXTO
    return sh;
  }
  return _asegurarCabecera(_mesComoTexto(sh), CABECERA_PAREJAS);
}

// ⚠️ La clave lleva QUIÉN. Sin él, dos instrucciones la misma mañana —dos
// instructores con Mo— se pisaban y solo sobrevivía una.
function _clavePareja(dia, turno, tipo, quien) {
  return Number(dia) + '_' + String(turno).toUpperCase() + '_' +
         String(tipo).toLowerCase() + '_' + String(quien).toUpperCase();
}

// { '18_M_instruccion_MH': { dia, turno, tipo, quien, conQuien }, … }
function leerParejas(mes, tipo) {
  var sh = _hojaParejas();
  var out = {};
  if (sh.getLastRow() < 2) return out;
  var val = sh.getRange(2, 1, sh.getLastRow() - 1, CABECERA_PAREJAS.length).getValues();
  var mk = _mesKeyDot(mes), tk = tipo ? String(tipo).toLowerCase() : '';
  val.forEach(function (r) {
    if (_mesKeyDot(r[0]) !== mk) return;
    var dia = Number(r[1]);
    var turno = String(r[2] || '').trim().toUpperCase();
    var t = String(r[3] || '').trim().toLowerCase();
    var quien = String(r[4] || '').trim().toUpperCase();
    if (!dia || !turno || !t || !quien) return;
    if (tk && t !== tk) return;
    out[_clavePareja(dia, turno, t, quien)] = {
      dia: dia, turno: turno, tipo: t,
      quien: quien, conQuien: String(r[5] || '').trim().toUpperCase()
    };
  });
  return out;
}

// Fija (o borra) UNA pareja. Es lo que usa la pantalla de emparejamientos, que
// va una a una: el JSUPIN decide con quién va cada alumno, no hay reparto
// automático que valga.
function guardarPareja(mes, dia, turno, tipo, quien, conQuien) {
  var sh = _hojaParejas();
  var mk = _mesKeyDot(mes), tk = String(tipo).toLowerCase();
  var tu = String(turno).toUpperCase(), qk = String(quien || '').toUpperCase();
  dia = Number(dia);

  var fila = 0;
  if (sh.getLastRow() > 1) {
    var val = sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues();
    for (var i = 0; i < val.length; i++) {
      if (_mesKeyDot(val[i][0]) === mk && Number(val[i][1]) === dia &&
          String(val[i][2] || '').toUpperCase() === tu &&
          String(val[i][3] || '').toLowerCase() === tk &&
          String(val[i][4] || '').toUpperCase() === qk) { fila = i + 2; break; }
    }
  }
  var con = String(conQuien || '').trim().toUpperCase();
  if (!con) {                       // sin pareja: se retira la fila
    if (fila) sh.deleteRow(fila);
    return { ok: true, borrada: !!fila };
  }
  if (fila) sh.getRange(fila, 6).setValue(con);
  else sh.appendRow([mk, dia, tu, tk, qk, con]);
  return { ok: true };
}

// Reescribe las parejas de un mes Y UN TIPO. Se sustituye entero porque el
// reparto decide el mes de una vez; el otro tipo no se toca.
function guardarParejas(mes, tipo, parejas) {
  var sh = _hojaParejas();
  var mk = _mesKeyDot(mes), tk = String(tipo).toLowerCase();
  if (sh.getLastRow() > 1) {
    var val = sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues();
    for (var i = val.length - 1; i >= 0; i--) {
      if (_mesKeyDot(val[i][0]) === mk && String(val[i][3] || '').trim().toLowerCase() === tk) {
        sh.deleteRow(i + 2);
      }
    }
  }
  var n = 0;
  Object.keys(parejas || {}).forEach(function (clave) {
    var p = parejas[clave];
    if (!p || !p.quien) return;
    sh.appendRow([mk, Number(p.dia), String(p.turno).toUpperCase(), tk,
                  String(p.quien).toUpperCase(), String(p.conQuien || '').toUpperCase()]);
    n++;
  });
  return n;
}
