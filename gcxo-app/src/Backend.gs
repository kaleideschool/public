/*******************************************************************************
 *
 * BACKEND.gs — Web App (doGet), API para el cliente y almacén de CAMBIOS.
 * Orquesta motor (chequeo de legalidad) + turnero (lectura) + estado.
 *
 * Despliegue: Implementar > Nueva implementación > Aplicación web
 *   - Ejecutar como: YO (propietario)
 *   - Quién tiene acceso: Cualquier usuario
 * Cada controlador entra con su enlace personal:  .../exec?token=SU_TOKEN
 *
 ******************************************************************************/

var HOJA_CAMBIOS = 'CAMBIOS';
var HOJA_LOG = 'LOG_CAMBIOS';
var CADUCIDAD_HORAS = 72;
// Versión de ESTE fichero. Cada .gs y .html tiene la suya; versiones() las reúne
// y se registran en LOG_APP y en el pie de la app para detectar ficheros sin
// actualizar o un despliegue viejo. Sube el número al pegar una versión nueva.
var VERSION_BACKEND = 'backend-105-cambio-directo';

// Puestos fuera del circuito de cambios (jefaturas): ni ceden ni reciben turnos.
// La lista ya no vive aquí: sale de la hoja PUESTOS y la carga el motor
// (CARGOS_EXCLUIDOS, en motor_restricciones.js). Declararla también en este
// fichero crearía dos `var` con el mismo nombre en el mismo proyecto y ganaría
// la que cargase la última.
function _cargoExcluido(cargo) { return !!CARGOS_EXCLUIDOS[String(cargo || '').trim().toUpperCase()]; }

// Columnas de CAMBIOS (1-based)
var COLS = {
  ID: 1, TS: 2, SOLICITANTE: 3, MES: 4, TIPO: 5, MOVIMIENTOS: 6,
  PARTICIPANTES: 7, CHEQUEO: 8, ESTADO: 9, VALIDADO_POR: 10,
  REF: 11, CADUCA: 12, NOTAS: 13
};
var CABECERA_CAMBIOS = [
  'ID', 'Fecha/hora', 'Solicitante', 'Mes', 'Tipo', 'Movimientos (JSON)',
  'Participantes (JSON)', 'Chequeo legal (JSON)', 'Estado', 'Validado por',
  'Ref. aprobación', 'Caduca', 'Notas'
];

// ═══════════════════════════════════════════════════════════════════════════
// WEB APP
// ═══════════════════════════════════════════════════════════════════════════
function doGet(e) {
  var token = (e && e.parameter && e.parameter.token) ? e.parameter.token : '';
  var usuario = identificarPorToken(token);
  _logApp('INFO', 'doGet', 'VERSIONES ' + JSON.stringify(versiones()) + ' · usuario=' + (usuario ? usuario.cta : '—'));

  var t = HtmlService.createTemplateFromFile('App');
  t.token = token;
  t.usuarioJson = JSON.stringify(usuario || null);
  return t.evaluate()
    .setTitle('Cambios de turno')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// NOTA: la función include(filename) YA existe en la app de supervisión
// (asignacionSup.gs). Como esta webapp convive en el mismo proyecto, se
// reutiliza esa y NO se redefine aquí para evitar la colisión de nombres.

// Disparador simple: refresca la caché de la matriz SOLO cuando se edita la
// hoja (nuevo turnero publicado, celda modificada). Evita releer en cada acción.
function onEdit(e) {
  try {
    var nombre = e.range.getSheet().getName();
    if (nombre === 'CONTROLADORES') invalidarCacheControladores();
    else if (_indiceDeMes(nombre) !== -1) invalidarCacheMes(nombre);
    else if (nombre === 'CAMBIOS') invalidarCacheCambios();
  } catch (err) { /* onEdit nunca debe fallar */ }
}


/**
 * Registra una acción administrativa (Bajas, Extra, Voluntarias, COS, Desprogramación, Activación)
 * Escribe en LOG_DIAS y actualiza la celda del turnero.
 */
// LOG_DIAS lleva el tipo en UNA LETRA (su cabecera dice E/V/D/C/A/B) y de ahí
// comen las fórmulas de las pestañas-resumen. La pantalla mandaba la palabra
// entera —"EXTRA", "BAJA"—, así que ninguna fórmula casaba y el guardián de
// las bajas (tipo !== 'B') tampoco saltaba nunca. Se normaliza aquí, aceptando
// las dos formas para no romper lo que ya haya por ahí.
var TIPOS_ACCION = {
  E: 'E', EXTRA: 'E', EXTRAS: 'E', HHEE: 'E',
  V: 'V', VOLUNTARIA: 'V', VOLUNTARIAS: 'V', HHVV: 'V',
  D: 'D', DESPROGRAMACION: 'D', 'DESPROGRAMACIÓN': 'D',
  C: 'C', COS: 'C',
  A: 'A', ACTIVACION: 'A', 'ACTIVACIÓN': 'A', IMAGINARIA: 'A',
  B: 'B', BAJA: 'B',
  R: 'R', RESTABLECER: 'R',
  X: 'X', CAMBIO: 'X',          // cambio directo: no cuenta en ningún resumen
  VAC: 'VAC', VACACIONES: 'VAC'
};
// Qué dice el FONDO de la celda según lo que se acaba de hacer. Escribir solo
// el código dejaba el color anterior, que sigue significando otra cosa: tras
// activar una imaginaria la celda ponía "M" pero seguía en blanco, así que ni
// el motor ni nadie sabía que era una activación.
//   `undefined` = no tocar el fondo (un cambio de turno no cambia su naturaleza)
//   ''          = dejarlo en blanco (restablecer quita la marca)
var MARCA_DE_TIPO = {
  A: 'activada',    // imaginaria activada → cian
  E: 'extra',       // extra                → verde
  C: 'extra',       // COS                  → verde, igual que las extras
  V: 'voluntaria',  // horas voluntarias    → azul
  B: 'baja',        // baja                 → rojo
  VAC: 'gris',      // vacaciones           → gris
  R: ''             // restablecer          → sin marca
};

function _tipoAccion(t) {
  var k = String(t || '').trim().toUpperCase();
  return TIPOS_ACCION[k] || k;
}

function registrarAccionAdmin(token, payload) {
  var u = _exigirVista(token, 'gestion.rapido');

  var mes = payload.mes;             // Ej: "AGO-26"
  var cta = payload.cta;             // Ej: "CS"
  var dia = Number(payload.dia);     // Ej: 15
  var tipo = _tipoAccion(payload.tipo);   // siempre una letra: E/V/D/C/A/B/R/X/VAC
  var nuevoTurno = payload.nuevoTurno; // Ej: "M", "T", "-M", "Ts", etc.
  var motivo = payload.motivo || '';

  var esRestablecer = (tipo === 'R' || nuevoTurno === 'RESTABLECER');

  // 1. Abrimos la hoja del mes y los logs
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var shLog = ss.getSheetByName('LOG_DIAS');
  var shCambios = ss.getSheetByName('LOG_CAMBIOS');
  var shMes = ss.getSheetByName(mes);

  if (!shMes) throw new Error("La hoja del mes " + mes + " no existe.");
  if (!shLog) throw new Error("La hoja LOG_DIAS no existe.");

  // 2. Comprobación de seguridad: Si el turno actual es Baja (-), no permite sobreescribir salvo que sea tipo 'B' o 'RESTABLECER'
  var m = leerMesCache(mes);
  var turnoActual = (m.base[cta] && m.base[cta][dia]) ? String(m.base[cta][dia]) : '';
  if (turnoActual.indexOf('-') === 0 && tipo !== 'B' && !esRestablecer) {
    throw new Error("El día seleccionado está marcado como BAJA (" + turnoActual + "). Debes modificar la baja primero o seleccionar Restablecer.");
  }

  // 3. Formateamos la fecha para LOG_DIAS (dd/MM/yyyy)
  var p = mes.split('-');
  var mesIdx = MES3.indexOf((p[0] || '').toUpperCase().slice(0, 3));
  var anio = 2000 + parseInt(p[1], 10);
  var fechaObj = new Date(anio, mesIdx, dia);
  var fechaStr = Utilities.formatDate(fechaObj, ss.getSpreadsheetTimeZone(), "dd/MM/yyyy");

  // 4. Localizamos la fila del controlador en la hoja del mes
  var dataCtas = shMes.getRange(TURNERO.FILA_CTA_INICIO, TURNERO.COL_CTA, 50, 1).getValues();
  var filaEncontrada = -1;
  for (var i = 0; i < dataCtas.length; i++) {
    if (String(dataCtas[i][0]).trim().toUpperCase() === cta.toUpperCase()) {
      filaEncontrada = TURNERO.FILA_CTA_INICIO + i;
      break;
    }
  }

  if (filaEncontrada === -1) throw new Error("No se encontró al controlador " + cta + " en la hoja " + mes);

  var colDia = TURNERO.COL_DIA_INICIO + (dia - 1);
  var turnoAAplicar = nuevoTurno;

  // 5. PROCESAR RESTABLECER: Buscar estado original en logs y limpiar sobreescrituras
  if (esRestablecer) {
    var turnoOriginalEncontrado = null;

    // A0) LOG_CELDAS es la fuente buena: guarda el valor PREVIO de cada
    //     escritura. Ver _turnoBaseSegunLog.
    turnoOriginalEncontrado = _turnoBaseSegunLog(mes, cta, dia);

    // A) Buscar turno original en LOG_CAMBIOS (si existe la hoja)
    if (turnoOriginalEncontrado === null && shCambios) {
      var dataCambios = shCambios.getDataRange().getValues();
      for (var r = dataCambios.length - 1; r >= 1; r--) {
        var fila = dataCambios[r];
        var fStr = fila[0] instanceof Date 
          ? Utilities.formatDate(fila[0], ss.getSpreadsheetTimeZone(), "dd/MM/yyyy") 
          : String(fila[0]);

        if (fStr === fechaStr) {
          for (var c = 0; c < fila.length; c++) {
            if (String(fila[c]).trim().toUpperCase() === cta.toUpperCase()) {
              if (fila[c + 1] && String(fila[c + 1]).trim() !== '') {
                turnoOriginalEncontrado = String(fila[c + 1]).trim();
                break;
              }
            }
          }
        }
        if (turnoOriginalEncontrado) break;
      }
    }

    // B) Limpiar sobreescrituras previas de esta persona y fecha en LOG_DIAS
    var lastRowLog = shLog.getLastRow();
    if (lastRowLog > 1) {
      var dataLog = shLog.getRange(1, 1, lastRowLog, 5).getValues();
      for (var iLog = dataLog.length - 1; iLog >= 1; iLog--) {
        var fLog = dataLog[iLog][0] instanceof Date 
          ? Utilities.formatDate(dataLog[iLog][0], ss.getSpreadsheetTimeZone(), "dd/MM/yyyy") 
          : String(dataLog[iLog][0]);
        var ctaLog = String(dataLog[iLog][3]).trim().toUpperCase();

        if (fLog === fechaStr && ctaLog === cta.toUpperCase()) {
          shLog.deleteRow(iLog + 1);
        }
      }
    }

    // C) Determinar el turno a restituir. Ojo: el original PUEDE ser cadena
    //     vacía (el día se libraba y la app le metió algo), y eso es un valor
    //     legítimo, no un "no encontrado".
    if (turnoOriginalEncontrado !== null) {
      turnoAAplicar = turnoOriginalEncontrado;
    } else if (nuevoTurno && nuevoTurno !== 'RESTABLECER' && nuevoTurno !== 'R') {
      turnoAAplicar = nuevoTurno;
    } else {
      // Si no hay rastro previo en logs, recuperamos el valor base no-baja
      turnoAAplicar = (m.base[cta] && m.base[cta][dia] && String(m.base[cta][dia]).indexOf('-') !== 0) 
        ? String(m.base[cta][dia]) 
        : '';
    }

    // Asignamos 'R' como tipo para la auditoría de restablecimiento
    tipo = 'R';
    shLog.appendRow([fechaStr, turnoAAplicar, tipo, cta, motivo || 'Restablecido a turno original por Admin']);

  } else {
    // Registro normal (Baja, Vacaciones, Cambio directo, COS, Activación...)
    shLog.appendRow([fechaStr, nuevoTurno, tipo, cta, motivo]);
  }

  // 6. Escribir el turno definitivo en la cuadrícula de la hoja del mes.
  //    Pasa por el punto único de escritura para que quede en LOG_CELDAS con
  //    el valor PREVIO, que es lo que después permite deshacer la acción.
  var celdaDia = shMes.getRange(filaEncontrada, colDia);
  var turnoPrevio = _txtCelda(celdaDia.getValue());
  var fondoPrevioCelda = '';
  try { fondoPrevioCelda = String(celdaDia.getBackground() || '').toLowerCase(); } catch (eFp) {}
  celdaDia.setValue(turnoAAplicar);
  // El fondo, que es la mitad de la información: la misma "M" sobre cian es una
  // imaginaria activada y sobre verde una extra. Ver MARCA_DE_TIPO.
  var marcaFondo = MARCA_DE_TIPO[tipo];
  if (marcaFondo !== undefined) {
    // El tono sale de la paleta GUARDADA (properties), que se lee una vez de
    // la hoja y se edita en «Configuración → Colores». No se deduce en cada
    // escritura: así se sabe siempre qué se va a pintar y se puede corregir.
    var hexFondo = paletaGuardada()[marcaFondo] || fondoDeMarca(marcaFondo);
    try { celdaDia.setBackground(hexFondo); }
    catch (eBg) { _logApp('WARN', 'registrarAccionAdmin', 'no se pudo pintar el fondo: ' + eBg, u.cta); }
  }
  _registrarLogCelda({
    mes: mes, dia: dia, cta: cta, previo: turnoPrevio, nuevo: _txtCelda(turnoAAplicar),
    tipo: tipo, origen: 'ADMIN', ref: '', motivo: motivo, autor: u.cta,
    fondoPrevio: fondoPrevioCelda
  });

  // 7. Limpiamos la caché del mes para forzar lectura fresca
  invalidarCacheMes(mes);

  _logApp('INFO', 'registrarAccionAdmin', cta + ' día ' + dia + ' ' + mes + ' -> ' + (turnoAAplicar || 'LIBRE') + ' (' + tipo + ')', u.cta);

  return { 
    ok: true, 
    mensaje: esRestablecer 
      ? "Turno restablecido correctamente al estado original (" + (turnoAAplicar || "Libre") + ")." 
      : "Registrado correctamente en LOG_DIAS y turnero actualizado." 
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Recupera la hoja del turnero. 
// ═══════════════════════════════════════════════════════════════════════════

function getCalendarioGlobal(token, mes) {
  var u = _exigirUsuario(token);
  
  // Aplicamos los cambios validados y leemos el cuadrante
  var m = _aplicarValidados(mes, leerMesCache(mes));
  var nombres = ctaANombre();
  var grupos = {};
  leerControladoresCache().forEach(function (c) { grupos[c.cta] = c.grupo || ''; });
  
  // Construimos la rejilla incluyendo las vacaciones ('V')
  var rejilla = {};
  for (var cta in m.base) {
    rejilla[cta] = {};
    for (var dia in m.base[cta]) {
      rejilla[cta][dia] = m.base[cta][dia];
    }
  }
  
  // Superponemos las vacaciones guardadas en la hoja
  for (var c2 in m.vacaciones) {
    if (!rejilla[c2]) rejilla[c2] = {};
    for (var d2 in m.vacaciones[c2]) {
      rejilla[c2][d2] = 'V';
    }
  }
  // Y las BAJAS, con su código ("-M", "-Ts"…). Sin esto el día salía en blanco
  // y no se distinguía de librar, que es justo lo contrario.
  var bajas = {};
  for (var c3 in m.bajas) {
    for (var d3 in m.bajas[c3]) {
      if (!rejilla[c3]) rejilla[c3] = {};
      var cod = m.bajas[c3][d3];
      rejilla[c3][d3] = (typeof cod === 'string' && cod) ? cod : '—';
      if (!bajas[c3]) bajas[c3] = {};
      bajas[c3][d3] = true;
    }
  }

  return {
    mes: mes,
    dias: m.dias,
    controladores: Object.keys(m.cargos || m.base).map(function(cta) {
      return {
        cta: cta, nombre: nombres[cta] || cta,
        cargo: (m.cargos && m.cargos[cta]) || '',
        grupo: grupos[cta] || '',  // para separar visualmente los grupos
        horas: ((m.resumen || {})[cta] || {}).horas || '',
        hmax: ((m.resumen || {})[cta] || {}).hmax || ''
      };
    }),
    rejilla: rejilla,
    bajas: bajas,          // para pintarlas en rojo aunque su código no lo delate
    marcas: m.marcas || {} // extra, voluntaria, activada, fuera de ciclo, gris
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// API — estado inicial y calendario
// ═══════════════════════════════════════════════════════════════════════════
function getEstadoInicial(token) {
  var u = _exigirUsuario(token);
  var meses = _mesesVigentes(); // solo mes actual y futuros
  var mesActual = _mesActualVigente(meses);
  var calendario = null;
  try { if (mesActual) calendario = getCalendario(token, mesActual); } catch (e) { _logApp('WARN', 'getEstadoInicial', 'calendario inicial falló: ' + e); }
  // El permiso de reparto va por CARGO (JSUPIN en el turnero), no por rol_app,
  // así que viaja aquí para que la pestaña aparezca o no desde el primer viaje.
  var cargo = '';
  try { cargo = String(_cargoDeCta(u.cta) || '').trim().toUpperCase(); } catch (e) {}
  return {
    // `base` es el nivel que el servidor exige de verdad; `rol` es el nombre
    // del perfil, que puede ser uno creado a mano. El cliente decide con base.
    usuario: { cta: u.cta, nombre: u.nombre, rol: _perfilDe(u.rol), cargo: cargo },
    puedeRepartir: _esAdministrador(u) || !!CARGOS_REPARTO[cargo],
    // Qué pestañas puede ver este perfil. Se configura en «Configuración →
    // Permisos»; el cliente pinta el menú a partir de esto y no decide nada.
    vistas: vistasDeRol(u.rol),
    meses: meses,
    mesActual: mesActual,
    calendario: calendario,   // ← el mes actual viaja en la MISMA llamada (1 viaje en vez de 2)
    versiones: versiones()
  };
}

function getCalendario(token, mes) {
  var u = _exigirUsuario(token);
  var m = _aplicarValidados(mes, leerMesCache(mes)); // el turnero muestra ya los cambios validados
  var nombres = ctaANombre();
  var rejilla = {};
  m.dias.forEach(function (d) { rejilla[d] = {}; });
  for (var cta in m.base) for (var dia in m.base[cta]) rejilla[dia][cta] = m.base[cta][dia];
  for (var c2 in m.vacaciones) for (var d2 in m.vacaciones[c2]) rejilla[d2][c2] = 'V';
  var controladores = Object.keys(m.cargos).map(function (cta) {
    return { cta: cta, nombre: nombres[cta] || cta, cargo: m.cargos[cta] };
  });
  // Estado por día de MIS cambios: activos (REGISTRADO/CONFIRMADO/VALIDADO) y,
  // Un día RESERVANTE (REGISTRADO/CONFIRMADO) bloquea y manda en la marca; si no
  // lo hay, un VALIDADO se muestra ✅ pero NO bloquea (el turno ya es el nuevo y
  // se puede volver a cambiar); si tampoco, el último RECHAZADO como aviso. Se
  // ignoran ANULADO/CADUCADO y TRANSCRITO (el turno ya sale cambiado en la celda).
  var reserva = {}, validado = {}, rechazado = {};
  var mk = _mesKey(mes);
  _leerCambiosCache().forEach(function (c) {
    if (_mesKey(c.mes) !== mk) return;
    var est = String(c.estado).trim().toUpperCase();
    (c.movimientos || []).forEach(function (mv) {
      if (!_mismaCta(mv.cta, u.cta)) return;
      var d = Number(mv.dia);
      if (est === 'REGISTRADO' || est === 'CONFIRMADO') {
        if (reserva[d] !== 'CONFIRMADO') reserva[d] = est; // CONFIRMADO gana a REGISTRADO
      } else if (est === 'VALIDADO') {
        validado[d] = true;
      } else if (est === 'RECHAZADO') {
        if (!rechazado[d] || String(c.timestamp) > String(rechazado[d])) rechazado[d] = c.timestamp;
      }
    });
  });
  var estadoDia = {}, pendientes = [];
  m.dias.forEach(function (d) {
    if (reserva[d]) { estadoDia[d] = reserva[d]; pendientes.push(Number(d)); }
    else if (validado[d]) { estadoDia[d] = 'VALIDADO'; }       // marcado pero NO reserva
    else if (rechazado[d]) { estadoDia[d] = 'RECHAZADO'; }
  });
  _logApp('DEBUG', 'getCalendario', mes + ' · estados de ' + u.cta + ' = ' + JSON.stringify(estadoDia), u.cta);
  return {
    mes: mes, dias: m.dias, rejilla: rejilla, controladores: controladores,
    pendientes: pendientes, estados: estadoDia,
    disponibilidad: _misDisponibilidades(mes, u.cta) // 🔒/🙋 propios, en el mismo viaje
  };
}

// Día a partir del cual las imaginarias de ese mes siguen vivas y, por tanto,
// pueden activarse. Las anteriores ya pasaron sin activarse y computan lo real.
//   · mes en curso  → hoy
//   · mes futuro    → 0: todas por delante
//   · mes pasado    → 32: ninguna se va a activar ya
function _diaCorte(mes) {
  var idx = _indiceDeMes(mes), act = _indiceMesActual();
  if (idx < 0) return 0;
  if (idx > act) return 0;
  if (idx < act) return 32;
  return new Date().getDate();
}

// ─── Fronteras de mes ────────────────────────────────────────────────────────
// Un ciclo puede cruzar de mes: para validar los primeros/últimos días hay que
// ver los días vecinos. Se construye un horario EXTENDIDO en numeración
// continua: últimos días del mes anterior como ≤0 y primeros del siguiente
// como >N. Solo se usa para VALIDAR; la vista sigue siendo el mes propio.
var DIAS_FRONTERA = 8;

function _nombreMesVecino(mes, delta) {
  var idx = _indiceDeMes(mes);
  if (idx === -1) return null;
  var objetivo = idx + delta;
  var lista = listarMeses();
  for (var i = 0; i < lista.length; i++) if (_indiceDeMes(lista[i]) === objetivo) return lista[i];
  return null; // la pestaña vecina no existe: se valida sin ella
}

function _extBase(mes, mActual) {
  var m = _aplicarValidados(mes, mActual || leerMesCache(mes)); // validados ya aplicados (idempotente)
  var n = m.dias.length;
  var ext = { base: {}, cargos: {}, nDias: n };
  for (var cta in m.base) {
    if (!Object.prototype.hasOwnProperty.call(m.base, cta)) continue;
    ext.base[cta] = {};
    for (var d in m.base[cta]) ext.base[cta][d] = m.base[cta][d];
  }
  for (var c2 in m.cargos) ext.cargos[c2] = m.cargos[c2];

  var prevName = _nombreMesVecino(mes, -1);
  if (prevName) {
    try {
      var p = _aplicarValidados(prevName, leerMesCache(prevName)), nPrev = p.dias.length;
      for (var ca in p.base) {
        for (var dp in p.base[ca]) {
          var dd = Number(dp);
          if (dd > nPrev - DIAS_FRONTERA) {
            if (!ext.base[ca]) ext.base[ca] = {};
            ext.base[ca][dd - nPrev] = p.base[ca][dp]; // día 31 del anterior → 0; 30 → −1…
          }
        }
        if (!(ca in ext.cargos) && p.cargos[ca]) ext.cargos[ca] = p.cargos[ca];
      }
    } catch (e) { _logApp('WARN', '_extBase', 'mes anterior ilegible: ' + e); }
  }
  var nextName = _nombreMesVecino(mes, 1);
  if (nextName) {
    try {
      var q = _aplicarValidados(nextName, leerMesCache(nextName));
      for (var cb in q.base) {
        for (var dq in q.base[cb]) {
          var dn = Number(dq);
          if (dn <= DIAS_FRONTERA) {
            if (!ext.base[cb]) ext.base[cb] = {};
            ext.base[cb][n + dn] = q.base[cb][dq]; // día 1 del siguiente → N+1…
          }
        }
        if (!(cb in ext.cargos) && q.cargos[cb]) ext.cargos[cb] = q.cargos[cb];
      }
    } catch (e2) { _logApp('WARN', '_extBase', 'mes siguiente ilegible: ' + e2); }
  }
  return ext;
}

// Validación completa con fronteras + R5 limitado a los días del mes propio.
function _chequeoConFronteras(mes, mActual, movimientos) {
  var m = mActual || leerMesCache(mes);
  var ext = _extBase(mes, m);
  var r = validarBloque(ext.base, ext.cargos, movimientos, {
    mesDesde: 1, mesHasta: ext.nDias, diaCorte: _diaCorte(mes)
  });
  (r.violaciones || []).forEach(function (v) {
    if (typeof v.dia === 'number' && v.dia < 1) v.detalle += ' [los días ≤0 corresponden al mes anterior]';
    else if (typeof v.dia === 'number' && v.dia > ext.nDias) v.detalle += ' [los días >' + ext.nDias + ' corresponden al mes siguiente]';
  });
  r.avisos = _avisosFrontera(mes, ext, r.resultado, movimientos);
  return r;
}

// Aviso por patrón 5+3: cuando la pestaña vecina NO existe, quien tiene sus
// libres pegados a la frontera probablemente entra de servicio el día 1 del
// mes siguiente (o venía de servicio el último del anterior). Si el cambio
// deja actividad en los 2 días de borde, se simula una M en el día fronterizo:
// si esa hipótesis generaría violaciones, se AVISA (sin bloquear) y quedará
// sujeta a la revalidación cuando se publique el cuadrante.
function _avisosFrontera(mes, ext, resultado, movimientos) {
  var avisos = [];
  var faltaPrev = !_nombreMesVecino(mes, -1);
  var faltaNext = !_nombreMesVecino(mes, 1);
  if (!faltaPrev && !faltaNext) return avisos;

  // El aviso solo aplica si EL CAMBIO toca los días de borde; el servicio de
  // frontera ya publicado no genera ruido en cambios de mitad de mes.
  var movsDe = {};
  (movimientos || []).forEach(function (mv) {
    if (!movsDe[mv.cta]) movsDe[mv.cta] = [];
    movsDe[mv.cta].push(Number(mv.dia));
  });

  for (var cta in movsDe) {
    if (!Object.prototype.hasOwnProperty.call(movsDe, cta)) continue;
    var tocaFin = movsDe[cta].some(function (d3) { return d3 >= ext.nDias - 2; });
    var tocaInicio = movsDe[cta].some(function (d4) { return d4 <= 3; });
    if (!tocaFin && !tocaInicio) continue;

    var res = (resultado && resultado[cta]) || {};
    var dias = [];
    for (var d in res) {
      var dd = Number(d);
      if (dd >= 1 && dd <= ext.nDias && esTrabajada(res[d])) dias.push(dd);
    }
    if (!dias.length) continue;
    dias.sort(function (a, b) { return a - b; });

    var escenarios = [];
    if (faltaNext && tocaFin && (ext.nDias - dias[dias.length - 1]) <= 2) escenarios.push(ext.nDias + 1);
    if (faltaPrev && tocaInicio && dias[0] <= 2) escenarios.push(0);

    for (var i = 0; i < escenarios.length; i++) {
      var diaSim = escenarios[i];
      var previas = {};
      validarHorarioIndividual(cta, res, { mesDesde: 1, mesHasta: ext.nDias })
        .forEach(function (v) { previas[v.regla + '|' + v.dia] = true; });
      var sim = {};
      for (var d2 in res) sim[d2] = res[d2];
      sim[diaSim] = 'M';
      var nuevas = [];
      validarHorarioIndividual(cta, sim, { mesDesde: 1, mesHasta: ext.nDias })
        .forEach(function (v) { if (!previas[v.regla + '|' + v.dia] && nuevas.indexOf(v.regla) === -1) nuevas.push(v.regla); });
      if (nuevas.length) {
        avisos.push('⚠ ' + cta + ': el mes ' + (diaSim === 0 ? 'anterior' : 'siguiente') +
          ' no está publicado y, por el patrón 5+3, es probable que tenga servicio pegado a la frontera. ' +
          'Si fuera una mañana, saltarían: ' + nuevas.join(', ') + '. Se revalidará al publicarse el cuadrante.');
      }
    }
  }
  return avisos;
}

// Chequeo de legalidad en vivo (no persiste nada). Valida el horario resultante
// completo, con visibilidad de los meses vecinos en los días frontera.
function chequear(token, mes, movimientos) {
  _exigirUsuario(token);
  return _chequeoConFronteras(mes, null, movimientos);
}

// Comprobación local de "turno intercambiable" (no depende del motor, para ser
// resistente a un pegado a medias). Intercambiables: M, T, Ms, Ts, Mo, To, im, it.
var _CAMBIABLES = { M: 1, T: 1, Ms: 1, Ts: 1, Mo: 1, To: 1, im: 1, it: 1 };
function _esCambiable(code) {
  return !!_CAMBIABLES[normalizarCodigo(code)]; // normalizarCodigo existe desde la 1ª versión
}

// ─── Caché de la hoja CAMBIOS (60 s, invalidada en cada mutación) ────────────
// Evita releer la hoja entera en cada vista. Las operaciones que ESCRIBEN usan
// siempre lectura fresca bajo lock (la integridad no depende de esta caché).
// Versión literal, no CACHE_V de Turnero.js: esto se evalúa al cargar el
// fichero y el orden de carga entre .gs no está garantizado. Súbela a la vez
// que CACHE_V cuando cambie la forma de lo que se cachea.
var _CAMBIOS_KEY = 'cambios_v5';
function _leerCambiosCache() {
  try {
    var hit = CacheService.getScriptCache().get(_CAMBIOS_KEY);
    if (hit) return JSON.parse(hit);
  } catch (e) {}
  var r = _leerCambios();
  try { CacheService.getScriptCache().put(_CAMBIOS_KEY, JSON.stringify(r), 60); } catch (e) {}
  return r;
}
function _invalidarCambios() { try { CacheService.getScriptCache().remove(_CAMBIOS_KEY); } catch (e) {} }

// Una solicitud "activa" (aún no aplicada ni rechazada) reserva su (mes,cta,día)
// para impedir crear otra solicitud sobre el mismo servicio.
var ESTADOS_ACTIVOS = { REGISTRADO: true, CONFIRMADO: true, VALIDADO: true };
// google.script.run NO puede devolver objetos Date al navegador (el cliente
// recibe null sin error). Todo lo que salga hacia la UI pasa por estos helpers.
function _mesCanon(mes) {
  if (mes instanceof Date) return MES3[mes.getMonth()] + '-' + ('0' + (mes.getFullYear() % 100)).slice(-2);
  return String(mes).trim().toUpperCase();
}
function _fechaIso(v) { return (v instanceof Date) ? v.toISOString() : String(v == null ? '' : v); }

// Canonicaliza el mes a un índice año*12+mes, tanto si viene como texto
// ("JUL-26"/"JULIO-26") como si Google Sheets lo devolvió convertido en FECHA
// (guarda "jul-26" y al leer devuelve un Date). Así ambas formas casan.
function _mesKey(mes) {
  if (mes instanceof Date) return mes.getFullYear() * 12 + mes.getMonth();
  return _indiceDeMes(mes); // -1 si no parsea
}
// Clave robusta: mes canónico + cta sin mayúsculas/espacios + día numérico.
function _kb(mes, cta, dia) { return _mesKey(mes) + '|' + String(cta).trim().toUpperCase() + '|' + Number(dia); }
// Estados que RESERVAN el día (aún en negociación/aprobación). Un VALIDADO ya
// NO reserva: se considera turnero modificado y el nuevo turno vuelve a ser
// intercambiable (se refleja con _aplicarValidados). TRANSCRITO ya está en la
// hoja; ANULADO/RECHAZADO/CADUCADO no cuentan.
var ESTADOS_RESERVAN = { REGISTRADO: true, CONFIRMADO: true };
function _bloqueados(fresh) {
  var set = {};
  var activos = 0;
  (fresh ? _leerCambios() : _leerCambiosCache()).forEach(function (c) {
    if (!ESTADOS_RESERVAN[String(c.estado).trim().toUpperCase()]) return;
    activos++;
    (c.movimientos || []).forEach(function (m) { set[_kb(c.mes, m.cta, m.dia)] = c.id; });
  });
  _logApp('DEBUG', '_bloqueados', activos + ' solicitudes que reservan → ' + Object.keys(set).length + ' celdas: ' + Object.keys(set).join(', '));
  return set;
}

// Aplica sobre la matriz los cambios ya VALIDADOS (aún sin transcribir) de ese
// mes: el turnero se considera modificado desde la validación, así que el nuevo
// turno es el que cuenta para calendario, candidatos y legalidad. Idempotente.
function _aplicarValidados(mes, m) {
  if (!m || !m.base) return m;
  var mk = _mesKey(mes);
  var vals = _leerCambiosCache().filter(function (c) {
    return String(c.estado).trim().toUpperCase() === 'VALIDADO' && _mesKey(c.mes) === mk;
  });
  if (!vals.length) return m;
  var base = {};
  for (var cta in m.base) { base[cta] = {}; for (var d in m.base[cta]) base[cta][d] = m.base[cta][d]; }
  vals.forEach(function (c) {
    (c.movimientos || []).forEach(function (mv) {
      if (!base[mv.cta]) base[mv.cta] = {};
      base[mv.cta][mv.dia] = (String(mv.a).toLowerCase() === 'libre') ? '' : mv.a;
    });
  });
  var out = {};
  for (var k in m) out[k] = m[k];
  out.base = base;
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// DISPONIBILIDAD — bloquear / ofrecer días
// ═══════════════════════════════════════════════════════════════════════════
// Cada controlador puede marcar días propios:
//   · BLOQUEADO — «no me propongáis nada este día»: desaparece de la lista de
//     candidatos de los demás para ese día.
//   · OFRECIDO  — «me viene bien cambiar este día»: sale marcado y ordenado
//     primero. Si además indica preferencia (pref) y el turno con el que
//     acabaría coincide con ella, sale ★ arriba del todo.
// La marca es una DECLARACIÓN DE INTENCIONES, no una reserva: no bloquea la
// hoja ni impide nada al propio interesado, que sigue pudiendo proponer sobre
// ese día. Solo filtra y ordena lo que ven los demás.
var HOJA_DISP = 'DISPONIBILIDAD';
var CABECERA_DISP = ['CTA', 'Mes', 'Día', 'Modo', 'Preferencia', 'Fecha/hora', 'ID persona'];
var DCOLS = { CTA: 1, MES: 2, DIA: 3, MODO: 4, PREF: 5, TS: 6, IDCTA: 7 };
var MODOS_DISP = { BLOQUEADO: true, OFRECIDO: true };

function _hojaDisponibilidad() {
  var sh = _ss().getSheetByName(HOJA_DISP);
  if (!sh) {
    sh = _ss().insertSheet(HOJA_DISP);
    sh.appendRow(CABECERA_DISP);
    sh.getRange(1, DCOLS.MES, sh.getMaxRows(), 1).setNumberFormat('@'); // "JUL-26" como TEXTO, no fecha
  }
  return sh;
}

function _leerDisponibilidad() {
  var sh = _hojaDisponibilidad();
  if (sh.getLastRow() < 2) return [];
  var val = sh.getRange(2, 1, sh.getLastRow() - 1, CABECERA_DISP.length).getValues();
  var out = [];
  val.forEach(function (r, i) {
    var cta = String(r[DCOLS.CTA - 1] || '').trim().toUpperCase();
    var modo = String(r[DCOLS.MODO - 1] || '').trim().toUpperCase();
    if (!cta || !MODOS_DISP[modo]) return; // fila vacía o modo desconocido: se ignora
    out.push({
      fila: i + 2,
      cta: cta,
      mes: _mesCanon(r[DCOLS.MES - 1]),      // sin Date: siempre texto
      dia: Number(r[DCOLS.DIA - 1]),
      modo: modo,
      pref: String(r[DCOLS.PREF - 1] || '').trim(),
      ts: _fechaIso(r[DCOLS.TS - 1])         // sin Date
    });
  });
  return out;
}

// Caché igual que la de CAMBIOS: las lecturas de vista la usan; las escrituras
// releen fresco bajo lock.
var _DISP_KEY = 'disp_v5';
function _leerDispCache() {
  try {
    var hit = CacheService.getScriptCache().get(_DISP_KEY);
    if (hit) return JSON.parse(hit);
  } catch (e) {}
  var r = _leerDisponibilidad();
  try { CacheService.getScriptCache().put(_DISP_KEY, JSON.stringify(r), 60); } catch (e) {}
  return r;
}
function _invalidarDisp() { try { CacheService.getScriptCache().remove(_DISP_KEY); } catch (e) {} }

// Mapa _kb(mes,cta,dia) → { modo, pref }. Misma clave robusta que _bloqueados().
function _dispMapa(fresh) {
  var set = {};
  (fresh ? _leerDisponibilidad() : _leerDispCache()).forEach(function (d) {
    set[_kb(d.mes, d.cta, d.dia)] = { modo: d.modo, pref: d.pref };
  });
  return set;
}

// Mis marcas del mes, para pintar 🔒/🙋 en el calendario: { dia: {modo,pref} }.
function _misDisponibilidades(mes, cta) {
  var mk = _mesKey(mes);
  var out = {};
  _leerDispCache().forEach(function (d) {
    if (_mesKey(d.mes) !== mk || !_mismaCta(d.cta, cta)) return;
    out[d.dia] = { modo: d.modo, pref: d.pref };
  });
  return out;
}

function getDisponibilidad(token, mes) {
  var u = _exigirUsuario(token);
  return { ok: true, mes: _mesCanon(mes), dias: _misDisponibilidades(mes, u.cta) };
}

// Marca (o desmarca, con modo vacío) un día propio. Un (cta,mes,día) tiene como
// mucho una fila: se sobreescribe en vez de acumular.
function setDisponibilidad(token, mes, dia, modo, pref) {
  var u = _exigirUsuario(token);
  if (_mesEsPasado(mes)) return { ok: false, error: 'Ese mes ya pasó: no admite cambios.' };
  dia = Number(dia);
  if (!dia) return { ok: false, error: 'Día no válido.' };
  modo = String(modo || '').trim().toUpperCase();
  if (modo && !MODOS_DISP[modo]) return { ok: false, error: 'Modo no válido: ' + modo + '.' };
  // La preferencia solo tiene sentido al ofrecer, y ha de ser un turno
  // intercambiable o "libre" (= «ese día lo que quiero es librar»).
  pref = String(pref || '').trim();
  if (pref && modo !== 'OFRECIDO') pref = '';
  if (pref && normalizarCodigo(pref) !== 'libre' && !_esCambiable(pref)) {
    return { ok: false, error: 'Preferencia no válida: ' + pref + '.' };
  }
  // Un turno que no se intercambia (vacaciones, baja, D, SIM, C, una evaluación…)
  // no se puede ni ofrecer ni bloquear: no hay nada que ceder ni de qué
  // excluirse. QUITAR la marca sí se deja siempre — puede haberse puesto antes
  // de que ese día pasara a ser un despacho.
  if (modo) {
    var mDisp = _aplicarValidados(mes, leerMesCache(mes)) || {};
    var suyo = ((mDisp.base || {})[u.cta] || {})[dia] || '';
    if (((mDisp.vacaciones || {})[u.cta] || {})[dia]) {
      return { ok: false, error: 'Ese día estás de vacaciones: no se puede ofrecer ni bloquear.' };
    }
    if (((mDisp.bajas || {})[u.cta] || {})[dia]) {
      return { ok: false, error: 'Ese día estás de baja: no se puede ofrecer ni bloquear.' };
    }
    if (suyo && !_esCambiable(suyo)) {
      return { ok: false, error: 'El turno ' + suyo + ' no se intercambia: no se puede ofrecer ni bloquear.' };
    }
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = _hojaDisponibilidad();
    var mk = _mesKey(mes);
    var previa = null;
    _leerDisponibilidad().forEach(function (d) { // fresco bajo lock
      if (_mesKey(d.mes) === mk && _mismaCta(d.cta, u.cta) && d.dia === dia) previa = d;
    });

    if (!modo) {
      if (previa) sh.deleteRow(previa.fila);
      _invalidarDisp();
      _logApp('INFO', 'setDisponibilidad', _mesCanon(mes) + ' d' + dia + ' → sin marca', u.cta);
      return { ok: true, modo: '', pref: '' };
    }

    var fila = [u.cta, _mesCanon(mes), dia, modo, pref, new Date().toISOString(), u.id || _idDe(u.cta)];
    if (previa) sh.getRange(previa.fila, 1, 1, CABECERA_DISP.length).setValues([fila]);
    else sh.appendRow(fila);
    _invalidarDisp();
    _logApp('INFO', 'setDisponibilidad', _mesCanon(mes) + ' d' + dia + ' → ' + modo + (pref ? ' (pref ' + pref + ')' : ''), u.cta);
    return { ok: true, modo: modo, pref: pref };
  } finally {
    lock.releaseLock();
  }
}

// ─── Candidatos en CADENA ───────────────────────────────────────────────────
// Candidatos con quienes se puede cambiar el día "dia" del usuario, marcando
// quién cumple y quién tendría incumplimientos, y teniendo en cuenta los tramos
// ya añadidos al borrador (movs). Con ello:
//  · Mi turno del día se calcula sobre la base + borrador (encadenar Ms→M→T).
//  · Puedo RECIBIR en un día que libro (tramo inverso de un cruce de días).
//  · El ✓/⚠ de cada candidato se evalúa sobre el BLOQUE COMPLETO (borrador +
//    este tramo), no sobre el tramo aislado: una cadena multi-día puede ser
//    ilegal por tramos y legal en conjunto. Solo el bloque entero manda.
function candidatosCadena(token, mes, dia, movsJson) {
  var t0 = Date.now();
  try {
    var r = _candidatosCadena(token, mes, dia, movsJson);
    _logApp('DEBUG', 'candidatosCadena', mes + ' d' + dia + ' → ' +
      (r.candidatos ? r.candidatos.length + ' candidatos' : (r.error || 'sin resultado')), '', Date.now() - t0);
    return r;
  } catch (err) {
    _logApp('ERROR', 'candidatosCadena', mes + ' d' + dia + ' → ' + _errStr(err), '', Date.now() - t0);
    throw err;
  }
}
function _candidatosCadena(token, mes, dia, movsJson) {
  var u = _exigirUsuario(token);
  return _candidatosPara(u.cta, mes, dia, movsJson, null);
}

// El núcleo, con el protagonista como PARÁMETRO en vez de «quien llama».
// Antes esto era el cuerpo de _candidatosCadena y leía `u.cta` directamente, así
// que solo servía para uno mismo. El admin necesita lo mismo para OTRA persona
// (ver `candidatosCambioAdmin`), y duplicar noventa líneas habría dejado dos
// listas de candidatos que se irían separando con cada arreglo.
//
// opts.incluirBloqueados: no descarta a quien haya marcado 🔒 ese día, sino que
// lo devuelve con `bloqueado:true`. El 🔒 es una cortesía entre compañeros —
// «no me propongáis nada»—, no una prohibición, y un admin que ordena un cambio
// tiene que poder verlo y decidir.
function _candidatosPara(yo, mes, dia, movsJson, opts) {
  opts = opts || {};
  if (_mesEsPasado(mes)) return { ok: false, error: 'Ese mes ya pasó: no admite cambios.' };
  dia = Number(dia);
  // ⚠️ Sin .toUpperCase(): las claves de `m.base`/`m.cargos` son las iniciales
  // TAL CUAL están en la hoja (leerMes solo hace trim), y aquí se comparan por
  // igualdad exacta. Normalizarlas aquí dejaría de encontrar la fila.
  yo = String(yo || '').trim();
  var movs = [];
  if (movsJson) { try { movs = (typeof movsJson === 'string') ? JSON.parse(movsJson) : movsJson; } catch (e) { movs = []; } }
  if (!Array.isArray(movs)) movs = [];

  var m = _aplicarValidados(mes, leerMesCache(mes)); // publicado + validados
  // Base EFECTIVA (para leer turnos): base + tramos del borrador, en orden.
  var eff = {};
  for (var c in m.base) { eff[c] = {}; for (var d in m.base[c]) eff[c][d] = m.base[c][d]; }
  movs.forEach(function (mv) { if (!eff[mv.cta]) eff[mv.cta] = {}; eff[mv.cta][mv.dia] = (String(mv.a).toLowerCase() === 'libre') ? '' : mv.a; });

  if (_cargoExcluido(m.cargos[yo])) return { ok: false, error: 'Tu puesto (' + m.cargos[yo] + ') no participa en el circuito de cambios.' };
  var bloq = _bloqueados(); // solicitudes YA registradas (el borrador no reserva)
  if (bloq[_kb(mes, yo, dia)]) return { ok: false, error: 'Ese día ya tiene una solicitud registrada; resuélvela antes.' };
  if ((m.vacaciones[yo] || {})[dia] || (m.bajas[yo] || {})[dia]) return { ok: false, error: 'No estás disponible ese día.' };

  var miTurno = (eff[yo] || {})[dia] || '';
  var miLibre = !miTurno;
  if (!miLibre && !_esCambiable(miTurno)) return { ok: false, error: 'Ese turno no es intercambiable.' };

  var nombres = ctaANombre();
  var disp = _dispMapa(); // 🔒 bloqueados fuera · 🙋 oferentes marcados y primero
  // Base de LEGALIDAD (frontera + validados, SIN borrador): validarBloque aplica
  // el bloque completo (borrador + tramo) una sola vez sobre ella.
  var ext = _extBase(mes, m);
  var corte = _diaCorte(mes);   // las imaginarias ya pasadas no computan al máximo
  var lista = [];
  Object.keys(m.cargos).forEach(function (cta) {
    if (cta === yo) return;
    if (_cargoExcluido(m.cargos[cta])) return;
    if ((m.vacaciones[cta] || {})[dia] || (m.bajas[cta] || {})[dia]) return;
    if (bloq[_kb(mes, cta, dia)]) return; // reservado por otra solicitud registrada
    var dsp = disp[_kb(mes, cta, dia)];
    var haBloqueado = !!(dsp && dsp.modo === 'BLOQUEADO');
    // Entre compañeros, quien bloquea el día desaparece de la lista. Para el
    // admin sale, marcado: ver `opts.incluirBloqueados`.
    if (haBloqueado && !opts.incluirBloqueados) return;
    var suTurno = (eff[cta] || {})[dia] || '';
    var movs2, tipo;
    if (!miLibre) {
      if (!suTurno) { tipo = 'CESION'; movs2 = [{ cta: yo, dia: dia, de: miTurno, a: 'libre' }, { cta: cta, dia: dia, de: 'libre', a: miTurno }]; }
      else {
        if (!_esCambiable(suTurno)) return;
        if (normalizarCodigo(suTurno) === normalizarCodigo(miTurno)) return;
        tipo = 'INTERCAMBIO'; movs2 = [{ cta: yo, dia: dia, de: miTurno, a: suTurno }, { cta: cta, dia: dia, de: suTurno, a: miTurno }];
      }
    } else {
      if (!suTurno || !_esCambiable(suTurno)) return; // libre: solo puedo RECIBIR
      tipo = 'RECEPCION'; movs2 = [{ cta: cta, dia: dia, de: suTurno, a: 'libre' }, { cta: yo, dia: dia, de: 'libre', a: suTurno }];
    }
    var full = movs.concat(movs2);
    var r;
    try { r = validarBloque(ext.base, ext.cargos, full, { mesDesde: 1, mesHasta: ext.nDias }); }
    catch (err) { return; }
    // Anota los días de fronteras (≤0 mes anterior; >N mes siguiente).
    var viol = (r.violaciones || []).map(function (v) {
      var det = v.detalle;
      if (typeof v.dia === 'number' && v.dia < 1) det += ' [días ≤0 = mes anterior]';
      else if (typeof v.dia === 'number' && v.dia > ext.nDias) det += ' [días >' + ext.nDias + ' = mes siguiente]';
      return { regla: v.regla, detalle: det, cta: v.cta, mia: (v.cta === yo) };
    });
    // Turno con el que se queda el candidato tras este tramo (su pata del
    // movimiento). Si coincide con lo que pidió al ofrecerse, es un ★.
    var suNuevo = '';
    for (var k2 = 0; k2 < movs2.length; k2++) if (movs2[k2].cta === cta) suNuevo = movs2[k2].a;
    var ofrece = !!(dsp && dsp.modo === 'OFRECIDO');
    lista.push({
      cta: cta, nombre: nombres[cta] || cta, tipo: tipo, suTurno: suTurno || 'libre',
      ok: r.ok,
      bloqueado: haBloqueado,   // 🔒 ese día (solo llega si incluirBloqueados)
      ofrece: ofrece,
      pref: ofrece ? (dsp.pref || '') : '',
      prefCoincide: !!(ofrece && dsp.pref && normalizarCodigo(dsp.pref) === normalizarCodigo(suNuevo)),
      reglas: viol.map(function (v) { return v.regla; }),
      detalles: viol.map(function (v) { return v.detalle; }),
      violaciones: viol,
      movimientos: movs2
    });
  });
  // Orden: ★ (se ofrece y le encaja el turno) › 🙋 (se ofrece) › resto; y dentro
  // de cada grupo, primero los que cumplen. Un ⚠ que se ofrece va por delante de
  // un ✓ que no: el ⚠ puede volverse legal al encadenar otro tramo, y quien se
  // ha ofrecido es quien más probable es que diga que sí.
  // Quien ha bloqueado el día va al final de todo: solo lo ve el admin, y ahí
  // abajo es donde estorba menos sin dejar de estar disponible.
  function _rango(c) {
    return (c.bloqueado ? -8 : 0) + (c.prefCoincide ? 4 : 0) + (c.ofrece ? 2 : 0) + (c.ok ? 1 : 0);
  }
  lista.sort(function (a, b) { return _rango(b) - _rango(a); });
  return {
    ok: true, dia: dia, miTurno: miTurno || 'libre', miLibre: miLibre,
    miDisp: (disp[_kb(mes, yo, dia)] || null), // mi propia marca de ese día
    candidatos: lista
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// API — registrar un cambio
// ═══════════════════════════════════════════════════════════════════════════
// Estampa la identidad de cada participante dentro del JSON, que es donde cabe
// sin tocar las 13 columnas de CAMBIOS ni lo que las lea.
function _conIdentidad(lista) {
  return (lista || []).map(function (x) {
    var y = {}; for (var k in x) y[k] = x[k];
    if (x.cta && !y.id) y.id = _idDe(x.cta);
    return y;
  });
}

function registrarCambio(token, mes, movimientos, refAprobacion) {
  var u = _exigirUsuario(token);
  if (_mesEsPasado(mes)) return { ok: false, error: 'No se pueden solicitar cambios de meses ya pasados.' };
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var m = _aplicarValidados(mes, leerMes(mes)); // base efectiva: incluye lo ya validado
    // Jefaturas fuera del circuito de cambios.
    for (var x = 0; x < movimientos.length; x++) {
      if (_cargoExcluido(m.cargos[movimientos[x].cta])) {
        return { ok: false, error: 'El puesto ' + m.cargos[movimientos[x].cta] + ' (' + movimientos[x].cta + ') no participa en el circuito de cambios.' };
      }
    }
    // Anti-solapamiento: lectura FRESCA bajo lock (la integridad no usa caché).
    var bloq = _bloqueados(true);
    for (var b = 0; b < movimientos.length; b++) {
      var kb = _kb(mes, movimientos[b].cta, movimientos[b].dia);
      if (bloq[kb]) {
        _logApp('WARN', 'registrar', u.cta + ' choque en ' + kb + ' con #' + bloq[kb]);
        return { ok: false, error: 'Ya hay una solicitud en curso (#' + bloq[kb] + ') para el día ' + movimientos[b].dia + ' de ' + movimientos[b].cta + '. Debe resolverse antes de crear otra.' };
      }
    }
    var chequeo = _chequeoConFronteras(mes, m, movimientos);
    if (!chequeo.ok) {
      // BLOQUEANTE ABSOLUTO: no se registra nada (§3.1).
      return { ok: false, violaciones: chequeo.violaciones };
    }

    var participantes = participantesDe(movimientos).map(function (cta) {
      return { cta: cta, confirma: cta === u.cta ? 'ACEPTA' : 'PENDIENTE' };
    });
    var pendientes = participantes.filter(function (p) { return p.confirma === 'PENDIENTE'; });
    var estado = pendientes.length ? 'REGISTRADO' : 'CONFIRMADO';

    var id = Utilities.getUuid().slice(0, 8);
    var ahora = new Date();
    var caduca = new Date(ahora.getTime() + CADUCIDAD_HORAS * 3600 * 1000);

    var fila = [];
    fila[COLS.ID - 1] = id;
    fila[COLS.TS - 1] = ahora;
    fila[COLS.SOLICITANTE - 1] = u.cta;
    fila[COLS.MES - 1] = mes;
    fila[COLS.TIPO - 1] = derivarTipo(movimientos);
    fila[COLS.MOVIMIENTOS - 1] = JSON.stringify(_conIdentidad(movimientos));
    fila[COLS.PARTICIPANTES - 1] = JSON.stringify(_conIdentidad(participantes));
    fila[COLS.CHEQUEO - 1] = JSON.stringify({ ok: true });
    fila[COLS.ESTADO - 1] = estado;
    fila[COLS.VALIDADO_POR - 1] = '';
    fila[COLS.REF - 1] = refAprobacion || '';
    fila[COLS.CADUCA - 1] = caduca;
    fila[COLS.NOTAS - 1] = (chequeo.avisos && chequeo.avisos.length) ? chequeo.avisos.join(' | ') : '';

    _hojaCambios().appendRow(fila);
    _invalidarCambios();
    _notificarParticipantes(u, mes, movimientos, pendientes, id);
    _logApp('INFO', 'registrar', u.cta + ' → ' + resumirCambio(movimientos) + ' [' + id + ']');
    return { ok: true, id: id, estado: estado, avisos: chequeo.avisos || [] };
  } finally {
    lock.releaseLock();
  }
}


// ════════════════════════════════════════════════════════════════════════════
// API — Admin hace el cambio COMPLETO en nombre de un controlador
// ════════════════════════════════════════════════════════════════════════════

function registrarCambioAdmin(token, ctaSolicitante, mes, movimientos, motivo) {
  var admin = _exigirVista(token, 'gestion.rapido');
  
  // Validar que el admin existe y tiene ese rol
  var solicitante = identificarPorToken(_tokenDe(ctaSolicitante));
  if (!solicitante) return { ok: false, error: 'Controlador no encontrado: ' + ctaSolicitante };
  
  if (_mesEsPasado(mes)) return { ok: false, error: 'No se pueden registrar cambios de meses ya pasados.' };

  // Usar la lógica de registro normal pero con el ADMIN como solicitante temporal
  // Luego cambia el solicitante al controlador real
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var m = _aplicarValidados(mes, leerMes(mes));

    // Anti-solapamiento, igual que en registrarCambio: si ese (mes, cta, día) ya
    // tiene una solicitud en curso, crear otra encima deja dos reservas sobre la
    // misma celda y la que se resuelva la segunda pisa a la primera.
    // ⚠️ Faltaba aquí: la vía de admin se saltaba la comprobación que sí hace la
    // vía normal, así que era la única forma de llegar a ese estado.
    var bloq = _bloqueados(true);   // lectura FRESCA bajo lock
    for (var b = 0; b < movimientos.length; b++) {
      var kb = _kb(mes, movimientos[b].cta, movimientos[b].dia);
      if (bloq[kb]) {
        _logApp('WARN', 'registrarCambioAdmin', admin.cta + ' choque en ' + kb + ' con #' + bloq[kb]);
        return { ok: false, error: 'Ya hay una solicitud en curso (#' + bloq[kb] + ') para el día ' +
          movimientos[b].dia + ' de ' + movimientos[b].cta + '. Debe resolverse antes de crear otra.' };
      }
    }

    // Validaciones de legalidad iguales
    var chequeo = _chequeoConFronteras(mes, m, movimientos);
    if (!chequeo.ok) return { ok: false, violaciones: chequeo.violaciones };
    
    // Crear el registro con todos CONFIRMANDO AL INSTANTE
    var participantes = participantesDe(movimientos).map(function (cta) {
      return { cta: cta, confirma: 'ACEPTA', cancela: null }; // Todos aceptan
    });
    
    var id = Utilities.getUuid().slice(0, 8);
    var fila = [];
    fila[COLS.ID - 1] = id;
    fila[COLS.TS - 1] = new Date();
    fila[COLS.SOLICITANTE - 1] = ctaSolicitante; // El controlador, no el admin
    fila[COLS.MES - 1] = mes;
    fila[COLS.TIPO - 1] = derivarTipo(movimientos);
    fila[COLS.MOVIMIENTOS - 1] = JSON.stringify(_conIdentidad(movimientos));
    fila[COLS.PARTICIPANTES - 1] = JSON.stringify(_conIdentidad(participantes));
    fila[COLS.CHEQUEO - 1] = JSON.stringify({ ok: true });
    fila[COLS.ESTADO - 1] = 'CONFIRMADO'; // ← Salta REGISTRADO
    fila[COLS.VALIDADO_POR - 1] = '';
    fila[COLS.REF - 1] = '';
    fila[COLS.CADUCA - 1] = new Date(new Date().getTime() + CADUCIDAD_HORAS * 3600 * 1000);
    fila[COLS.NOTAS - 1] = 'Registrado por admin ' + admin.cta + ': ' + (motivo || '');
    
    _hojaCambios().appendRow(fila);
    _invalidarCambios();
    
    _logApp('INFO', 'registrarCambioAdmin', admin.cta + ' registra para ' + ctaSolicitante + 
            ' → ' + resumirCambio(movimientos) + ' [' + id + ']');
    
    return { ok: true, id: id, estado: 'CONFIRMADO', avisos: chequeo.avisos || [] };
  } finally {
    lock.releaseLock();
  }
}

// Admin valida directamente (salta la cola de confirmación)
function validarYTranscribirAdmin(token, id) {
  var admin = _exigirVista(token, 'gestion.val');
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var loc = _localizar(id);
    if (!loc) return { ok: false, error: 'Cambio no encontrado' };
    var c = loc.cambio;
    
    var estado = String(c.estado).trim().toUpperCase();
    if (estado === 'TRANSCRITO') return { ok: false, error: 'Ya transcrito' };
    
    // 1. Validar
    _actualizarCelda(loc.fila, COLS.ESTADO, 'VALIDADO');
    _actualizarCelda(loc.fila, COLS.VALIDADO_POR, admin.cta + ' · ' + new Date().toISOString());
    
    // 2. Aplicar al turnero automáticamente
    try {
      _aplicarMovimientosAlTurnero(c.mes, c.movimientos, admin.cta, c.id);
    } catch (err) {
      _logApp('WARN', 'validarYTranscribirAdmin', 'No se pudo actualizar turnero: ' + _errStr(err));
    }
    
    // 3. Marcar como transcrito
    _actualizarCelda(loc.fila, COLS.ESTADO, 'TRANSCRITO');
    _log(c, admin.cta, true);
    
    // ← AGREGAR AQUÍ: Invalidar la caché del mes
    invalidarCacheMes(c.mes);  // Refresca el calendario
    
    _invalidarCambios();
    _logApp('INFO', 'validarYTranscribirAdmin', admin.cta + ' valida y transcribe ' + id);
    
    return { ok: true, estado: 'TRANSCRITO' };
  } finally {
    lock.releaseLock();
  }
}


/* ═══════════════════════════════════════════════════════════════════════════
   CAMBIO DIRECTO ENTRE CONTROLADORES  —  «Gestión → Incidencias»

   El circuito normal tiene tres pasos y tres personas: uno propone, el otro
   acepta, jefatura valida. Es lo correcto cuando el cambio nace de un acuerdo
   entre compañeros, porque la aceptación ES la prueba del acuerdo.

   Pero hay casos en que el acuerdo ya existe fuera de la app —se ha hablado por
   teléfono, se ha pedido por escrito, lo impone la operación— y hacer pasar a
   todo el mundo por las tres pantallas solo retrasa lo inevitable. Para eso
   está esto: el admin aplica el cambio de una vez y queda registrado como lo
   que es, un cambio hecho por jefatura.

   Lo que NO se salta:
   · La legalidad. Se comprueba igual, con fronteras de mes. Se puede forzar
     —hay días en que hay que hacerlo—, pero entonces las violaciones quedan
     escritas en la fila, no se pierden.
   · El estado de partida. Si la hoja no dice lo que el admin cree (regla
     ESTADO), NO se aplica ni forzando: eso no es una regla laboral que
     saltarse, es que se está mirando una foto vieja y se escribiría sobre otra
     cosa.
   · La traza. Va por _aplicarMovimientosAlTurnero → _aplicarTurnoCelda, así que
     deja LOG_CELDAS con el valor previo y se puede deshacer día a día como
     cualquier otro movimiento.

   Sí se permite, a diferencia del circuito normal, meter en el cambio a un
   puesto excluido (las jefaturas): el admin ya puede escribir esa celda a mano
   desde «Cambio directo de turno», y prohibirlo aquí solo le empujaría a
   hacerlo en dos escrituras sueltas, perdiendo el emparejamiento y el chequeo.
   ═══════════════════════════════════════════════════════════════════════════ */

// Con quién puede cambiar OTRO controlador el día `dia`. Es la misma lista que
// ve cada uno en su calendario (mismo núcleo, `_candidatosPara`), pero pedida
// en nombre de un tercero y sin ocultar a quien haya bloqueado el día.
function candidatosCambioAdmin(token, mes, dia, cta) {
  _exigirVista(token, 'gestion.rapido');
  var quien = String(cta || '').trim();
  if (!quien) return { ok: false, error: 'Falta el controlador.' };
  var t0 = Date.now();
  try {
    var r = _candidatosPara(quien, mes, dia, null, { incluirBloqueados: true });
    r.cta = quien;
    _logApp('DEBUG', 'candidatosCambioAdmin', mes + ' d' + dia + ' ' + quien + ' → ' +
      (r.candidatos ? r.candidatos.length + ' candidatos' : (r.error || 'sin resultado')), '', Date.now() - t0);
    return _sanear(r);
  } catch (err) {
    _logApp('ERROR', 'candidatosCambioAdmin', mes + ' d' + dia + ' ' + quien + ' → ' + _errStr(err), '', Date.now() - t0);
    throw err;
  }
}

// Aplica el bloque de movimientos de una sentada: lo escribe en CAMBIOS ya como
// TRANSCRITO, lo vuelca al turnero y lo registra en LOG_CAMBIOS.
//
// opts: { motivo, solicitante, forzar }
//   · solicitante — a quién se le atribuye la petición. Por defecto, el primero
//     del bloque: la fila de CAMBIOS sigue diciendo de quién era el cambio, no
//     del admin que lo tecleó (que queda en NOTAS y en LOG_CELDAS).
//   · forzar — aplicar pese a las violaciones, y pese a pisar solicitudes en
//     curso (que se anulan, porque ya no representan nada).
function cambioDirectoAdmin(token, mes, movimientos, opts) {
  var admin = _exigirVista(token, 'gestion.rapido');
  opts = opts || {};
  if (_mesEsPasado(mes)) return { ok: false, error: 'Ese mes ya pasó: no admite cambios.' };
  movimientos = movimientos || [];
  if (!movimientos.length) return { ok: false, error: 'No hay ningún movimiento que aplicar.' };

  var forzar = !!opts.forzar;
  var motivo = String(opts.motivo || '').trim();

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var m = _aplicarValidados(mes, leerMes(mes));   // fresco bajo lock

    // 1. ¿Pisamos alguna solicitud en curso? Se mira SIEMPRE, porque dejar dos
    //    reservas sobre la misma celda es el estado del que no se sale solo.
    var bloq = _bloqueados(true);
    var choques = {};
    movimientos.forEach(function (mv) {
      var id = bloq[_kb(mes, mv.cta, mv.dia)];
      if (id) choques[id] = true;
    });
    var idsChoque = Object.keys(choques);
    if (idsChoque.length && !forzar) {
      return { ok: false, conflictos: idsChoque,
        error: 'Hay ' + (idsChoque.length === 1 ? 'una solicitud en curso' : idsChoque.length + ' solicitudes en curso') +
          ' sobre esos días (#' + idsChoque.join(', #') + '). Aplicar el cambio directo las dejaría sin sentido: ' +
          'resuélvelas antes, o confirma para anularlas.' };
    }

    // 2. Legalidad, con fronteras de mes.
    var chequeo = _chequeoConFronteras(mes, m, movimientos);
    var viol = chequeo.violaciones || [];

    // 2b. ESTADO no se fuerza NUNCA: significa que la celda no contiene lo que
    //     el cliente creía, así que `a` se escribiría encima de otra cosa.
    var desfase = viol.filter(function (v) { return v.regla === 'ESTADO'; });
    if (desfase.length) {
      return { ok: false, refrescar: true, violaciones: desfase,
        error: 'El cuadrante ha cambiado desde que cargaste la pantalla. Actualiza y vuelve a intentarlo.' };
    }
    if (!chequeo.ok && !forzar) {
      return { ok: false, violaciones: viol, avisos: chequeo.avisos || [] };
    }

    // 3. Forzando: las solicitudes que pisamos se anulan, con su motivo. Antes
    //    de escribir nada nuestro, para que el orden del histórico se lea bien.
    var anuladas = [];
    idsChoque.forEach(function (id) {
      var loc = _localizar(id);
      if (!loc) return;
      _actualizarCelda(loc.fila, COLS.ESTADO, 'ANULADO');
      _actualizarCelda(loc.fila, COLS.NOTAS,
        'Anulada por el cambio directo aplicado por ' + admin.cta + ' el ' + new Date().toISOString());
      anuladas.push(id);
    });

    // 4. La fila en CAMBIOS, ya transcrita.
    var solicitante = String(opts.solicitante || movimientos[0].cta || '').trim() || admin.cta;
    var participantes = participantesDe(movimientos).map(function (cta) {
      // Nadie ha pulsado «acepto»: lo hace constar el admin. `porAdmin` deja
      // dicho que la aceptación no salió de esta app, que es la diferencia real
      // con un cambio del circuito normal.
      return { cta: cta, confirma: 'ACEPTA', cancela: null, porAdmin: true };
    });

    var id = Utilities.getUuid().slice(0, 8);
    var ahora = new Date();
    var notas = 'Cambio directo aplicado por ' + admin.cta + (motivo ? ': ' + motivo : '');
    if (anuladas.length) notas += ' · anula #' + anuladas.join(', #');
    if (!chequeo.ok) {
      notas += ' · ⚠ FORZADO pese a: ' + viol.map(function (v) {
        return v.regla + (v.cta ? ' (' + v.cta + ')' : '') + ' ' + v.detalle;
      }).join(' | ');
    }
    if (chequeo.avisos && chequeo.avisos.length) notas += ' · ' + chequeo.avisos.join(' | ');

    var fila = [];
    fila[COLS.ID - 1] = id;
    fila[COLS.TS - 1] = ahora;
    fila[COLS.SOLICITANTE - 1] = solicitante;
    fila[COLS.MES - 1] = _mesCanon(mes);
    fila[COLS.TIPO - 1] = derivarTipo(movimientos);
    fila[COLS.MOVIMIENTOS - 1] = JSON.stringify(_conIdentidad(movimientos));
    fila[COLS.PARTICIPANTES - 1] = JSON.stringify(_conIdentidad(participantes));
    fila[COLS.CHEQUEO - 1] = JSON.stringify({ ok: chequeo.ok, violaciones: viol, forzado: !chequeo.ok });
    fila[COLS.ESTADO - 1] = 'TRANSCRITO';
    fila[COLS.VALIDADO_POR - 1] = admin.cta + ' · directo · ' + ahora.toISOString();
    fila[COLS.REF - 1] = String(opts.ref || '');
    fila[COLS.CADUCA - 1] = '';      // no caduca: ya está hecho
    fila[COLS.NOTAS - 1] = notas.slice(0, 4000);
    _hojaCambios().appendRow(fila);

    // 5. Al turnero. Punto único de escritura → LOG_CELDAS → deshacible.
    var escrito = true;
    try {
      _aplicarMovimientosAlTurnero(mes, movimientos, admin.cta, id);
    } catch (err) {
      escrito = false;
      _logApp('ERROR', 'cambioDirectoAdmin', 'registrado ' + id + ' pero NO escrito en el turnero: ' + _errStr(err), admin.cta);
    }

    _log({ id: id, mes: _mesCanon(mes), tipo: derivarTipo(movimientos), movimientos: movimientos,
           solicitante: solicitante, validadoPor: admin.cta + ' (directo)' }, admin.cta, chequeo.ok);

    _invalidarCambios();
    invalidarCacheMes(mes);
    _logApp('INFO', 'cambioDirectoAdmin', admin.cta + ' aplica ' + resumirCambio(movimientos) +
      ' [' + id + ']' + (chequeo.ok ? '' : ' FORZADO') + (anuladas.length ? ' · anula #' + anuladas.join(', #') : ''), admin.cta);

    return {
      ok: true, id: id, estado: 'TRANSCRITO',
      escrito: escrito,
      forzado: !chequeo.ok,
      violaciones: chequeo.ok ? [] : viol,
      anuladas: anuladas,
      avisos: chequeo.avisos || [],
      resumen: resumirCambio(movimientos),
      error: escrito ? '' : 'El cambio quedó registrado pero no se pudo escribir en la hoja del mes. Revísalo a mano.'
    };
  } finally {
    lock.releaseLock();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// API — bandejas
// ═══════════════════════════════════════════════════════════════════════════
function _mismaCta(a, b) { return String(a).trim().toUpperCase() === String(b).trim().toUpperCase(); }

// Identidad de quien tiene AHORA esas iniciales. Se estampa en cada registro
// nuevo para que, el día que esas iniciales pasen a otra persona, siga
// sabiéndose de quién era sin tener que deducirlo por la fecha.
function _idDe(cta) {
  // La identidad es un dato de apoyo: si no se puede resolver, se deja vacío.
  // Nunca merece tumbar la operación que se estaba haciendo.
  try {
    var p = personaDeCta(cta);
    return (p && p.id) || '';
  } catch (e) { return ''; }
}

function getEnviados(token) {
  var u = _exigirUsuario(token);
  var todos = _leerCambiosCache();
  var r = todos.filter(function (c) { return _mismaCta(c.solicitante, u.cta); }).map(_tagHistorico);
  _logApp('DEBUG', 'getEnviados', 'yo=' + u.cta + ' · solicitantes=[' + todos.map(function (c) { return c.solicitante; }).join(',') + '] → ' + r.length, u.cta);
  return r;
}

// Etiqueta cada cambio con banderas que la interfaz usa para filtrar el
// histórico sin recalcular: `activo` (estado en curso) y `pasado` (su mes ya
// quedó atrás). Devuelve el MISMO objeto con dos campos añadidos.
function _tagHistorico(c) {
  c.activo = !!ESTADOS_ACTIVOS[String(c.estado).trim().toUpperCase()];
  c.pasado = _mesEsPasado(c.mes);
  return c;
}

// Cambios EN CURSO que afectan a un día concreto para el usuario (para
// gestionarlos desde el propio calendario). Incluye la marca de si el usuario
// es el solicitante (puede anular en solitario si aún está REGISTRADO).
function getCambiosDia(token, mes, dia) {
  var u = _exigirUsuario(token);
  var d = Number(dia);
  var mk = _mesKey(mes);
  var r = _leerCambiosCache().filter(function (c) {
    if (!ESTADOS_ACTIVOS[String(c.estado).trim().toUpperCase()]) return false;
    if (_mesKey(c.mes) !== mk) return false;
    return (c.movimientos || []).some(function (mv) {
      return _mismaCta(mv.cta, u.cta) && Number(mv.dia) === d;
    });
  }).map(function (c) {
    var soy = _mismaCta(c.solicitante, u.cta);
    var yoP = (c.participantes || []).filter(function (p) { return _mismaCta(p.cta, u.cta); })[0];
    return {
      id: c.id, tipo: c.tipo, estado: c.estado, mes: _mesCanon(c.mes),
      solicitante: c.solicitante, soySolicitante: soy,
      movimientos: c.movimientos, participantes: c.participantes,
      ref: c.ref, yoCancele: !!(yoP && yoP.cancela === 'SI')
    };
  });
  _logApp('DEBUG', 'getCambiosDia', mes + ' d' + d + ' → ' + r.length, u.cta);
  return r;
}

// ─── Preferencias por usuario (histórico) ───────────────────────────────────
// La webapp se ejecuta como el propietario, así que UserProperties serían las
// del propietario para todos. Guardamos por CTA en ScriptProperties.
function getPrefs(token) {
  var u = _exigirUsuario(token);
  var raw = PropertiesService.getScriptProperties().getProperty('PREF_' + u.cta);
  return _parse(raw, {});
}
function setPrefs(token, prefs) {
  var u = _exigirUsuario(token);
  var txt = JSON.stringify(prefs || {});
  if (txt.length > 2000) return { ok: false, error: 'Preferencias demasiado grandes.' };
  PropertiesService.getScriptProperties().setProperty('PREF_' + u.cta, txt);
  return { ok: true };
}

// Cambios en los que soy participante y aún debo confirmar.
function getRecibidos(token) {
  var u = _exigirUsuario(token);
  var r = _leerCambiosCache().filter(function (c) {
    var estado = String(c.estado).trim().toUpperCase();
    if (!ESTADOS_ACTIVOS[estado]) return false;
    var yo = (c.participantes || []).filter(function (p) { return _mismaCta(p.cta, u.cta); })[0];
    if (!yo) return false;
    // Me toca confirmar o rechazar
    if (estado === 'REGISTRADO' && String(yo.confirma).trim().toUpperCase() === 'PENDIENTE') return true;
    // Alguien pidió anular y falta mi cancelación
    var pideCancel = (c.participantes || []).some(function (p) { return p.cancela === 'SI'; });
    if (pideCancel && yo.cancela !== 'SI') return true;
    return false;
  });
  _logApp('DEBUG', 'getRecibidos', r.length + ' pendientes', u.cta);
  return r;
}

function confirmarCambio(token, id, acepta) {
  var u = _exigirUsuario(token);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var loc = _localizar(id);
    if (!loc) return { ok: false, error: 'Cambio no encontrado' };
    var c = loc.cambio;
    if (c.estado !== 'REGISTRADO') return { ok: false, error: 'El cambio ya no admite confirmación' };

    var yo = (c.participantes || []).filter(function (p) { return p.cta === u.cta; })[0];
    if (!yo) return { ok: false, error: 'No eres participante de este cambio' };

    yo.confirma = acepta ? 'ACEPTA' : 'RECHAZA';
    var nuevoEstado = c.estado;
    if (!acepta) nuevoEstado = 'RECHAZADO';
    else if (c.participantes.every(function (p) { return p.confirma === 'ACEPTA'; })) nuevoEstado = 'CONFIRMADO';

    _actualizarCelda(loc.fila, COLS.PARTICIPANTES, JSON.stringify(c.participantes));
    _actualizarCelda(loc.fila, COLS.ESTADO, nuevoEstado);
    _invalidarCambios();
    _notificarSolicitante(c, u.cta, acepta, nuevoEstado);
    _logApp('INFO', 'confirmar', u.cta + ' ' + (acepta ? 'ACEPTA' : 'RECHAZA') + ' ' + id + ' → ' + nuevoEstado);
    return { ok: true, estado: nuevoEstado };
  } finally {
    lock.releaseLock();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// API — anular una solicitud (solo antes de validar)
//   · Sin aceptaciones (REGISTRADO): el solicitante anula unilateralmente.
//   · Aceptado pero sin validar (CONFIRMADO): deben cancelar TODOS los
//     participantes (campo cancela); al completarse → ANULADO.
//   · VALIDADO/TRANSCRITO: no se anula; se revierte con un cambio nuevo.
// ═══════════════════════════════════════════════════════════════════════════
function anularCambio(token, id) {
  var u = _exigirUsuario(token);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var loc = _localizar(id);
    if (!loc) return { ok: false, error: 'Cambio no encontrado' };
    var c = loc.cambio;
    var estado = String(c.estado).trim().toUpperCase();
    if (estado === 'TRANSCRITO') return { ok: false, error: 'Ya está transcrito en el turnero; pide la reversión a un supervisor.' };
    // Un cambio VALIDADO no se anula: el turno ya cuenta como el nuevo. Para
    // deshacerlo se propone un cambio nuevo (transacción hacia delante, auditable).
    if (estado === 'VALIDADO') return { ok: false, error: 'Un cambio validado no se anula: propón un cambio nuevo para revertirlo.' };
    if (!ESTADOS_RESERVAN[estado]) return { ok: false, error: 'El cambio ya no admite anulación (' + estado + ').' };

    var parts = c.participantes || [];
    var yo = parts.filter(function (p) { return _mismaCta(p.cta, u.cta); })[0];
    if (!yo) return { ok: false, error: 'No participas en este cambio.' };

    // Sin aceptaciones todavía → anulación unilateral del solicitante.
    if (estado === 'REGISTRADO') {
      if (!_mismaCta(c.solicitante, u.cta)) return { ok: false, error: 'Aún está pendiente de confirmación: usa "Rechazar" para salirte.' };
      _actualizarCelda(loc.fila, COLS.ESTADO, 'ANULADO');
      _actualizarCelda(loc.fila, COLS.NOTAS, 'Anulado unilateralmente por ' + u.cta + ' (sin confirmaciones)');
      _invalidarCambios();
      _logApp('INFO', 'anular', u.cta + ' anula ' + id + ' (unilateral)');
      _notificarAnulacion(c, u.cta, true);
      return { ok: true, estado: 'ANULADO' };
    }

    // Ya hubo aceptación → anulación de mutuo acuerdo (todos deben cancelar).
    if (yo.cancela === 'SI') return { ok: false, error: 'Ya habías solicitado la anulación; falta la otra parte.' };
    yo.cancela = 'SI';
    var todos = parts.every(function (p) { return p.cancela === 'SI'; });
    _actualizarCelda(loc.fila, COLS.PARTICIPANTES, JSON.stringify(parts));
    if (todos) {
      _actualizarCelda(loc.fila, COLS.ESTADO, 'ANULADO');
      _actualizarCelda(loc.fila, COLS.NOTAS, 'Anulado de mutuo acuerdo');
    }
    _invalidarCambios();
    _logApp('INFO', 'anular', u.cta + ' solicita anulación de ' + id + (todos ? ' → ANULADO' : ' (falta el resto)'));
    _notificarAnulacion(c, u.cta, todos);
    return {
      ok: true,
      estado: todos ? 'ANULADO' : estado,
      pendienteDe: parts.filter(function (p) { return p.cancela !== 'SI'; }).map(function (p) { return p.cta; })
    };
  } finally { lock.releaseLock(); }
}

function _notificarAnulacion(cambio, quien, definitivo) {
  try {
    var emails = ctaAEmail();
    (cambio.participantes || []).forEach(function (p) {
      if (_mismaCta(p.cta, quien)) return;
      var email = emails[p.cta];
      if (!email) return;
      MailApp.sendEmail({
        to: email,
        subject: definitivo ? ('Cambio ' + cambio.id + ' ANULADO') : ('Solicitud de anulación del cambio ' + cambio.id),
        htmlBody: definitivo
          ? (quien + ' ha anulado el cambio <b>' + cambio.id + '</b>. Ya no está en curso.')
          : (quien + ' quiere anular el cambio <b>' + cambio.id + '</b>, que tú ya habías aceptado. Entra en la aplicación (pestaña Recibidos) para aceptar la anulación.')
      });
    });
  } catch (e) { _logApp('WARN', 'notificarAnulacion', _errStr(e)); }
}

// ═══════════════════════════════════════════════════════════════════════════
// API — validación oficial (roles VALIDADOR / ADMIN)
// ═══════════════════════════════════════════════════════════════════════════
function getColaValidacion(token) {
  _exigirVista(token, 'gestion.val');
  // Cola + histórico de validaciones: pendientes (CONFIRMADO) y ya resueltas
  // (VALIDADO/RECHAZADO). `activo`=pendiente de validar; `pasado`=mes atrás.
  // El filtro por defecto del cliente ("En curso") muestra solo las CONFIRMADO.
  var REL = { CONFIRMADO: 1, VALIDADO: 1, RECHAZADO: 1 };
  return _leerCambiosCache().filter(function (c) { return REL[String(c.estado).trim().toUpperCase()]; })
    .map(function (c) {
      c.activo = String(c.estado).trim().toUpperCase() === 'CONFIRMADO';
      c.pasado = _mesEsPasado(c.mes);
      return c;
    });
}

function validarCambio(token, id, aprueba, motivo) {
  var u = _exigirVista(token, 'gestion.val');
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var loc = _localizar(id);
    if (!loc) return { ok: false, error: 'Cambio no encontrado' };
    if (loc.cambio.estado !== 'CONFIRMADO') return { ok: false, error: 'El cambio no está confirmado' };

    if (aprueba) {
      _actualizarCelda(loc.fila, COLS.ESTADO, 'VALIDADO');
      _actualizarCelda(loc.fila, COLS.VALIDADO_POR, u.cta + ' · ' + new Date().toISOString());

      // ← NEW: Auto-update the schedule sheet with shift changes and notes
      try {
        _aplicarMovimientosAlTurnero(loc.cambio.mes, loc.cambio.movimientos, u.cta, loc.cambio.id);
        _logApp('INFO', 'validarCambio', 'Turnero actualizado automáticamente para cambio ' + id);
      } catch (err) {
        _logApp('WARN', 'validarCambio', 'No se pudo actualizar turnero: ' + _errStr(err));
        // Don't throw: validation is already successful, this is just sheet update
      }
    } else {
      _actualizarCelda(loc.fila, COLS.ESTADO, 'RECHAZADO');
      _actualizarCelda(loc.fila, COLS.NOTAS, 'Rechazo validación: ' + (motivo || '') + ' (' + u.cta + ')');
    }    _invalidarCambios();
    _logApp('INFO', 'validar', u.cta + (aprueba ? ' VALIDA ' : ' RECHAZA ') + id);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// API — cola de transcripción (ADMIN)
// ═══════════════════════════════════════════════════════════════════════════
function getColaTranscripcion(token) {
  _exigirVista(token, 'gestion.val');
  // Cola + histórico: pendientes de transcribir (VALIDADO) y ya transcritos
  // (TRANSCRITO). `activo`=pendiente; `pasado`=mes atrás. Orden CRONOLÓGICO
  // (más antiguo primero): si dos validados tocan la misma celda, transcribir
  // en orden preserva el resultado (el cliente puede reordenar solo la vista).
  var REL = { VALIDADO: 1, TRANSCRITO: 1 };
  var cambios = _leerCambiosCache().filter(function (c) { return REL[String(c.estado).trim().toUpperCase()]; })
    .sort(function (a, b) { return String(a.timestamp) < String(b.timestamp) ? -1 : (String(a.timestamp) > String(b.timestamp) ? 1 : 0); });
  var cacheMes = {};
  cambios.forEach(function (c) {
    if (!(c.mes in cacheMes)) {
      try { cacheMes[c.mes] = leerMes(c.mes); } catch (err) { cacheMes[c.mes] = null; }
    }
    var m = cacheMes[c.mes];
    // Celda exacta a editar en el turnero para cada movimiento (ayuda a transcribir).
    c.celdas = c.movimientos.map(function (mv) {
      var celda = '?';
      if (m && m.diaACol[mv.dia] && m.filaDeCta[mv.cta]) {
        celda = _colLetra(m.diaACol[mv.dia]) + m.filaDeCta[mv.cta];
      }
      return { cta: mv.cta, dia: mv.dia, celda: celda, a: mv.a };
    });
    c.activo = String(c.estado).trim().toUpperCase() === 'VALIDADO'; // pendiente de transcribir
    c.pasado = _mesEsPasado(c.mes);
  });
  return cambios;
}

// Número de columna (1-based) a letra A1: 1->A, 27->AA.
function _colLetra(col) {
  var s = '';
  while (col > 0) { var m = (col - 1) % 26; s = String.fromCharCode(65 + m) + s; col = Math.floor((col - 1) / 26); }
  return s;
}

// ═══════════════════════════════════════════════════════════════════════════
// API — BALANCE (días que me deben / debo)
// ═══════════════════════════════════════════════════════════════════════════
// Deuda por turno trabajado: en una cesión, quien se libra del turno (pasa a
// 'libre') debe un día a quien lo cubre. Los intercambios son neutros (delta 0).
var ESTADOS_FIRMES = { VALIDADO: true, TRANSCRITO: true };

function getBalance(token) {
  var u = _exigirUsuario(token);
  var nombres = ctaANombre();
  var saldo = {}; // cta -> { meDeben, debo }
  function get(cta) { if (!saldo[cta]) saldo[cta] = { meDeben: 0, debo: 0 }; return saldo[cta]; }

  _leerCambiosCache().forEach(function (c) {
    if (!ESTADOS_FIRMES[c.estado]) return;
    var delta = _deltasTrabajo(c.movimientos);
    // Emparejar quien trabaja de más (+) con quien trabaja de menos (−).
    var pos = [], neg = [];
    Object.keys(delta).forEach(function (cta) {
      var n = Math.abs(delta[cta]);
      for (var k = 0; k < n; k++) (delta[cta] > 0 ? pos : neg).push(cta);
    });
    var n = Math.min(pos.length, neg.length);
    for (var i = 0; i < n; i++) {
      var deudor = neg[i], acreedor = pos[i]; // deudor debe un día al acreedor
      if (deudor === u.cta) get(acreedor).debo++;
      else if (acreedor === u.cta) get(deudor).meDeben++;
    }
  });

  var lista = Object.keys(saldo).map(function (cta) {
    return { cta: cta, nombre: nombres[cta] || cta, meDeben: saldo[cta].meDeben, debo: saldo[cta].debo, neto: saldo[cta].meDeben - saldo[cta].debo };
  }).filter(function (x) { return x.meDeben || x.debo; });
  lista.sort(function (a, b) { return b.neto - a.neto; });

  var totMe = 0, totDebo = 0;
  lista.forEach(function (x) { totMe += x.meDeben; totDebo += x.debo; });
  return { saldo: lista, totalMeDeben: totMe, totalDebo: totDebo };
}

// delta[cta] = turnos trabajados después − antes (dentro de un cambio).
function _deltasTrabajo(movimientos) {
  var delta = {};
  (movimientos || []).forEach(function (m) {
    var antes = String(m.de).toLowerCase() !== 'libre';
    var despues = String(m.a).toLowerCase() !== 'libre';
    if (antes && !despues) delta[m.cta] = (delta[m.cta] || 0) - 1;
    else if (!antes && despues) delta[m.cta] = (delta[m.cta] || 0) + 1;
  });
  return delta;
}

// Sugerencias para saldar lo que debo: días en meses vigentes donde puedo
// cubrir un turno del acreedor (yo trabajo de más) cumpliendo las reglas.
function getSugerencias(token) {
  var u = _exigirUsuario(token);
  var bal = getBalance(token);
  var debo = bal.saldo.filter(function (x) { return x.neto < 0; });
  var meses = _mesesVigentes();
  var out = [];

  debo.forEach(function (x) {
    var sugs = [];
    for (var mi = 0; mi < meses.length && sugs.length < 5; mi++) {
      var m = leerMesCache(meses[mi]);
      var diasX = m.base[x.cta] || {};
      var yoDias = m.base[u.cta] || {};
      for (var d in diasX) {
        if (sugs.length >= 5) break;
        var turnoX = diasX[d];
        if (!_esCambiable(turnoX)) continue;
        if (yoDias[d]) continue; // yo ya trabajo ese día
        if ((m.vacaciones[u.cta] || {})[d] || (m.bajas[u.cta] || {})[d]) continue;
        var movs = [{ cta: x.cta, dia: Number(d), de: turnoX, a: 'libre' }, { cta: u.cta, dia: Number(d), de: 'libre', a: turnoX }];
        if (_chequeoConFronteras(meses[mi], m, movs).ok) sugs.push({ mes: meses[mi], dia: Number(d), turno: turnoX });
      }
    }
    out.push({ cta: x.cta, nombre: x.nombre, debo: -x.neto, sugerencias: sugs });
  });
  _logApp('DEBUG', 'getSugerencias', 'deudas=' + debo.length + ' · meses=' + meses.length, u.cta);
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// Caducidad (disparador temporal — ver README)
// ═══════════════════════════════════════════════════════════════════════════
// Mantiene la caché de la matriz SIEMPRE CALIENTE: relee y recachea los meses
// vigentes y los controladores. Pensada para un disparador cada 5 minutos, de
// modo que la webapp siempre lea de memoria y presente los datos al instante.
function precalentarCache() {
  try {
    invalidarCacheControladores();
    leerControladoresCache();
    _mesesVigentes().forEach(function (m) { invalidarCacheMes(m); leerMesCache(m); });
    _logApp('DEBUG', 'precalentarCache', 'meses vigentes recacheados');
  } catch (e) { _logApp('ERROR', 'precalentarCache', _errStr(e)); }
}

// Ejecutar UNA VEZ desde el editor para instalar los disparadores de tiempo
// (caché caliente + barrido de caducadas). Reinstalable sin duplicar.
function instalarTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var h = t.getHandlerFunction();
    if (h === 'precalentarCache' || h === 'barrerCaducados') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('precalentarCache').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('barrerCaducados').timeBased().everyHours(1).create();
  return 'Instalados: precalentarCache (cada 5 min) y barrerCaducados (cada hora).';
}

function barrerCaducados() {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ahora = new Date();
    _leerCambios().forEach(function (c) {
      if (c.estado === 'REGISTRADO' && c.caduca && new Date(c.caduca) < ahora) {
        var loc = _localizar(c.id);
        if (loc) { _actualizarCelda(loc.fila, COLS.ESTADO, 'CADUCADO'); _invalidarCambios(); }
      }
    });
  } finally {
    lock.releaseLock();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Utilidades internas
// ═══════════════════════════════════════════════════════════════════════════
function _exigirUsuario(token) {
  var u = identificarPorToken(token);
  if (!u) throw new Error('Acceso no autorizado: token no válido.');
  // Punto de paso de casi toda la API: es el sitio natural para asegurar que
  // las competencias de la hoja PUESTOS están cargadas antes de decidir nada.
  // Va por caché, así que cuesta lo que una lectura de CacheService.
  aplicarConfigPuestos();
  // Lo mismo con las cifras del convenio: si el admin las ha tocado en
  // «Admin: Parámetros», el motor tiene que validar con ESAS, no con las de
  // arranque. Es una lectura de properties.
  aplicarConfigParametros();
  return u;
}
// `_exigirRol(token, ['ADMIN'])` vivía aquí y era el error de fondo: ataba el
// permiso al NOMBRE del perfil, así que los tres de fábrica no se podían tocar
// y uno nuevo no podía hacer nada que el código no supiera nombrar. Lo
// sustituye `_exigirVista`, arriba, junto al catálogo de perfiles.

function _hojaCambios() {
  var sh = _ss().getSheetByName(HOJA_CAMBIOS);
  if (!sh) {
    sh = _ss().insertSheet(HOJA_CAMBIOS);
    sh.appendRow(CABECERA_CAMBIOS);
    sh.getRange(1, COLS.MES, sh.getMaxRows(), 1).setNumberFormat('@'); // Mes como TEXTO (evita que "JUL-26" se vuelva fecha)
  }
  return sh;
}

function _leerCambios() {
  var sh = _hojaCambios();
  if (sh.getLastRow() < 2) return [];
  var val = sh.getRange(2, 1, sh.getLastRow() - 1, CABECERA_CAMBIOS.length).getValues();
  return val.map(function (r) {
    return {
      id: r[COLS.ID - 1],
      timestamp: _fechaIso(r[COLS.TS - 1]),          // sin Date: el cliente recibiría null
      solicitante: r[COLS.SOLICITANTE - 1],
      mes: _mesCanon(r[COLS.MES - 1]),               // sin Date: siempre texto "JUL-26"
      tipo: r[COLS.TIPO - 1],
      movimientos: _parse(r[COLS.MOVIMIENTOS - 1], []),
      participantes: _parse(r[COLS.PARTICIPANTES - 1], []),
      chequeo: _parse(r[COLS.CHEQUEO - 1], {}),
      estado: r[COLS.ESTADO - 1],
      validadoPor: r[COLS.VALIDADO_POR - 1],
      ref: r[COLS.REF - 1],
      caduca: _fechaIso(r[COLS.CADUCA - 1]),         // sin Date
      notas: r[COLS.NOTAS - 1]
    };
  });
}

function _localizar(id) {
  var sh = _hojaCambios();
  if (sh.getLastRow() < 2) return null;
  var ids = sh.getRange(2, COLS.ID, sh.getLastRow() - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) {
      var fila = i + 2;
      var cambios = _leerCambios();
      return { fila: fila, cambio: cambios[i] };
    }
  }
  return null;
}

function _actualizarCelda(fila, col, valor) {
  _hojaCambios().getRange(fila, col).setValue(valor);
}

function _parse(s, def) {
  try { return s ? JSON.parse(s) : def; } catch (e) { return def; }
}

// ─── Logger de la aplicación (hoja LOG_APP) ─────────────────────────────────
// Registro persistente y visible, con niveles, usuario y duración, para
// depurar a fondo. El umbral se controla con la propiedad de script LOG_NIVEL
// (DEBUG muestra todo; INFO es el valor por defecto). Cambiar con setLogNivel().
var _LOG_NIVELES = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
var _LOG_MAX_FILAS = 5000;

function _logNivelMin() {
  try {
    var p = PropertiesService.getScriptProperties().getProperty('LOG_NIVEL');
    return _LOG_NIVELES[p] || _LOG_NIVELES.INFO;
  } catch (e) { return _LOG_NIVELES.INFO; }
}

// _logApp(nivel, accion, detalle[, cta][, ms]) — cta y ms son opcionales.
function _logApp(nivel, accion, detalle, cta, ms) {
  _rtPush(nivel, accion, detalle, ms); // SIEMPRE al log en tiempo real (caché, sin coste de Sheets)
  try {
    if ((_LOG_NIVELES[nivel] || 20) < _logNivelMin()) return; // por debajo del umbral
    var sh = _ss().getSheetByName('LOG_APP') || _ss().insertSheet('LOG_APP');
    if (sh.getLastRow() === 0) sh.appendRow(['Fecha/hora', 'Nivel', 'Usuario', 'Acción', 'Detalle', 'ms']);
    sh.appendRow([new Date(), nivel, cta || '', accion, String(detalle == null ? '' : detalle).slice(0, 4000), (ms == null ? '' : ms)]);
    var n = sh.getLastRow();
    if (n > _LOG_MAX_FILAS + 200) sh.deleteRows(2, n - _LOG_MAX_FILAS); // recorte del histórico
  } catch (e) { /* el log nunca debe romper la app */ }
}

function _errStr(err) { return err && err.stack ? err.stack : (err && err.message ? err.message : String(err)); }

// ─── Versiones de cada fichero (para comprobar que todo está actualizado) ────
function versiones() {
  return {
    Backend: (typeof VERSION_BACKEND !== 'undefined') ? VERSION_BACKEND : 'SIN ACTUALIZAR',
    Turnero: (typeof VERSION_TURNERO !== 'undefined') ? VERSION_TURNERO : 'SIN ACTUALIZAR',
    Motor: (typeof VERSION_MOTOR !== 'undefined') ? VERSION_MOTOR : 'SIN ACTUALIZAR',
    Logica: (typeof VERSION_LOGICA !== 'undefined') ? VERSION_LOGICA : 'SIN ACTUALIZAR',
    Importador: (typeof VERSION_IMPORTADOR !== 'undefined') ? VERSION_IMPORTADOR : 'SIN ACTUALIZAR',
    Supervisiones: (typeof VERSION_SUPERVISIONES !== 'undefined') ? VERSION_SUPERVISIONES : 'SIN ACTUALIZAR',
    Js: _versionHtml('Js', /VERSION_JS\s*=\s*'([^']+)'/),
    Estilos: _versionHtml('Estilos', /--version-est:\s*([^;\s]+)/),
    App: _versionHtml('App', /name="version-app"\s+content="([^"]+)"/)
  };
}
// getContent() elimina los comentarios, por eso los marcadores van como
// contenido real (variable JS, propiedad CSS y meta).
function _versionHtml(nombre, re) {
  try {
    var m = HtmlService.createHtmlOutputFromFile(nombre).getContent().match(re);
    return m ? m[1] : 'SIN MARCA';
  } catch (e) { return 'no encontrado'; }
}

// ─── Diagnóstico completo (para ver en la app qué hay guardado y qué bloquea) ─
function diagnostico(token) {
  var u = _exigirUsuario(token);
  var sh = _hojaCambios();
  var filas = sh.getLastRow() < 2 ? [] : sh.getRange(2, 1, sh.getLastRow() - 1, CABECERA_CAMBIOS.length).getValues();
  var cambios = filas.map(function (r) {
    var movRaw = r[COLS.MOVIMIENTOS - 1];
    var movs = _parse(movRaw, null);
    return {
      id: r[COLS.ID - 1],
      estado: r[COLS.ESTADO - 1],
      activo: !!ESTADOS_ACTIVOS[String(r[COLS.ESTADO - 1]).trim().toUpperCase()],
      mes: _mesCanon(r[COLS.MES - 1]),
      solicitante: r[COLS.SOLICITANTE - 1],
      parseMovimientosOK: movs !== null,
      movimientos: movs,
      movimientosRaw: String(movRaw).slice(0, 300),
      clavesBloqueo: (movs || []).map(function (m) { return _kb(r[COLS.MES - 1], m.cta, m.dia); })
    };
  });
  return {
    versiones: versiones(),
    usuarioActual: u.cta,
    bloqueados: _bloqueados(),          // { clave: idSolicitud }
    totalCambios: cambios.length,
    cambios: cambios
  };
}

// Cambia el nivel de log en caliente. Ejecuta setLogNivel('DEBUG') para depurar.
// ═══════════════════════════════════════════════════════════════════════════
// REPARTO DE SERVICIOS — supervisión e instrucción desde la web app
// ═══════════════════════════════════════════════════════════════════════════
// Sustituye al sidebar de la hoja. Lo maneja la jefatura de supervisión e
// instrucción, que se reconoce por su CARGO en el turnero (JSUPIN), no por una
// lista de correos escrita en el código. Un ADMIN también entra.
var HOJA_BORRADORES = 'BORRADORES';
var CABECERA_BORRADORES = ['Mes', 'Tipo', 'Autor', 'Fecha/hora', 'Propuestas (JSON)'];
var CARGOS_REPARTO = { JSUPIN: true };

// Puesto de un controlador. MANDA EL CUADRANTE del mes; CONTROLADORES.puesto
// solo rellena el hueco de quien no tiene fila en él.
//
// Por qué en ese orden, y no al revés: el puesto del cuadrante es la realidad
// operativa de ESE mes y puede cambiar de un mes a otro según se habilite la
// gente. Todo el resto de la app ya decide con él —la regla ROL del motor lee
// `m.cargos` directamente—, así que hacer que otra tabla lo pisara abriría la
// puerta a que la legalidad y los permisos discreparan. Hoy pasaría de hecho:
// MH figura SUPIN en el cuadrante y SUP en la tabla de personas.
//
// El respaldo de CONTROLADORES es solo una red de seguridad, para quien no
// tenga fila en ningún cuadrante vigente. Las jefaturas SÍ la tienen (JTWR y
// JSUPIN están en las hojas de mes), así que su permiso de reparto ya salía
// bien leyendo únicamente del cuadrante.
function _cargoDeCta(cta, fecha) {
  // 1. Histórico con fechas: es lo único que sabe que alguien dejó de ser TINS
  //    en marzo. Si hay un periodo vigente en esa fecha, manda.
  var vig = puestoVigente(cta, fecha);
  if (vig) return vig;
  // 2. El cuadrante del mes.
  var meses = _mesesVigentes();
  for (var i = 0; i < meses.length; i++) {
    var m;
    try { m = leerMesCache(meses[i]); } catch (e) { continue; }
    for (var c in m.cargos) if (_mismaCta(c, cta) && m.cargos[c]) return m.cargos[c];
  }
  // 3. Lo declarado sin fechas en CONTROLADORES.
  var decl = leerControladoresCache().filter(function (c) { return _mismaCta(c.cta, cta); })[0];
  return (decl && decl.puesto) || '';
}

// Primer día del mes de un turnero ("AGO-26" → 1/8/2026), que es la fecha de
// referencia para saber qué puesto tenía cada uno ESE mes.
function _fechaDelMes(mes) {
  var p = String(mes).split('-');
  var idx = MES3.indexOf((p[0] || '').toUpperCase().slice(0, 3));
  if (idx < 0) return null;
  return new Date(2000 + parseInt(p[1], 10), idx, 1);
}

// ─── Alta y baja de cargos ──────────────────────────────────────────────────
function getCargos(token) {
  _exigirUsuario(token);
  var hoy = new Date();
  return _sanear({
    ok: true,
    cargos: leerCargosCache().map(function (c) {
      return {
        fila: c.fila, cta: c.cta, puesto: c.puesto,
        desde: _fechaTexto(c.desde), hasta: _fechaTexto(c.hasta),
        vigente: (!c.desde || hoy >= c.desde) && (!c.hasta || hoy <= c.hasta),
        notas: c.notas
      };
    }),
    puestos: leerPuestosCache().map(function (p) { return p.puesto; }),
    controladores: leerControladoresCache()
      .map(function (c) {
        return {
          cta: c.cta, nombre: c.nombre, email: c.email, rol: c.rol,
          grupo: c.grupo, activo: c.activo,
          activoExtras: c.activoExtras, activoVacas: c.activoVacas,
          tieneToken: !!c.token,           // el token NO viaja al cliente
          puesto: puestoVigente(c.cta)
        };
      })
      .sort(function (a, b) { return a.cta < b.cta ? -1 : 1; }),
    // Quién no tiene ningún puesto vigente: lo que hay que rellenar.
    roles: Object.keys(_perfiles()),
    sinPuesto: leerControladoresCache()
      .filter(function (c) { return c.activo && !puestoVigente(c.cta); })
      .map(function (c) { return c.cta; })
  });
}

// Da de alta un puesto. Si el CTA ya tenía otro vigente y no se dice otra cosa,
// se le cierra el día anterior: nadie ocupa dos puestos a la vez.
function altaCargo(token, cta, puesto, desde, notas) {
  var u = _exigirVista(token, 'config.gente');
  cta = String(cta || '').trim().toUpperCase();
  puesto = String(puesto || '').trim().toUpperCase();
  if (!cta || !puesto) return { ok: false, error: 'Hacen falta controlador y puesto.' };
  var fDesde = _fechaDeCelda(desde);
  if (desde && !fDesde) return { ok: false, error: 'Fecha de alta no válida: ' + desde + ' (usa dd/mm/aaaa).' };

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = hojaCargos();
    if (fDesde) {
      var previo = leerCargos().filter(function (c) {
        return c.cta === cta && !c.hasta && (!c.desde || c.desde < fDesde);
      })[0];
      if (previo) {
        var vispera = new Date(fDesde.getFullYear(), fDesde.getMonth(), fDesde.getDate() - 1);
        sh.getRange(previo.fila, 4).setValue(_fechaTexto(vispera));
      }
    }
    sh.appendRow([cta, puesto, _fechaTexto(fDesde), '', String(notas || ''), _idDe(cta)]);
    invalidarCacheCargos();
    _logApp('INFO', 'altaCargo', cta + ' → ' + puesto + (fDesde ? ' desde ' + _fechaTexto(fDesde) : ''), u.cta);
    return { ok: true };
  } finally { lock.releaseLock(); }
}

function bajaCargo(token, fila, hasta) {
  var u = _exigirVista(token, 'config.gente');
  var f = _fechaDeCelda(hasta);
  if (hasta && !f) return { ok: false, error: 'Fecha de baja no válida: ' + hasta + ' (usa dd/mm/aaaa).' };
  var c = leerCargos().filter(function (x) { return x.fila === Number(fila); })[0];
  if (!c) return { ok: false, error: 'No encuentro esa línea.' };
  if (f && c.desde && f < c.desde) return { ok: false, error: 'La baja no puede ser anterior al alta.' };
  hojaCargos().getRange(Number(fila), 4).setValue(_fechaTexto(f));
  invalidarCacheCargos();
  _logApp('INFO', 'bajaCargo', c.cta + ' deja ' + c.puesto + (f ? ' el ' + _fechaTexto(f) : ' (baja retirada)'), u.cta);
  return { ok: true };
}

// Cierra el puesto VIGENTE de alguien, sin tener que saber en qué línea está.
// Es lo que hace falta para quitarle el puesto desde su ficha: allí se conoce
// al controlador, no la fila de CARGOS_CTA.
function bajaCargoDeCta(token, cta, hasta) {
  var u = _exigirVista(token, 'config.gente');
  var ck = String(cta || '').trim().toUpperCase();
  var vig = leerCargos().filter(function (x) {
    return String(x.cta || '').trim().toUpperCase() === ck && x.vigente;
  });
  if (!vig.length) return { ok: true, sinCargo: true };   // no tenía: nada que cerrar
  // Si hubiera más de uno vigente —no debería—, se cierran todos: dejar la
  // mitad abierta sería peor que no tocar nada.
  var r = { ok: true };
  vig.forEach(function (c) {
    var x = bajaCargo(token, c.fila, hasta);
    if (x && x.ok === false) r = x;
  });
  _logApp('INFO', 'bajaCargoDeCta', ck + ' se queda sin puesto', u.cta);
  return r;
}

// ─── Unificación: LISTA ATC → CONTROLADORES ─────────────────────────────────
// Los datos de persona estaban repartidos entre CONTROLADORES (identidad y
// acceso) y una pestaña de personas con grupo, activo para extras, activo para
// vacaciones y puesto, que NINGÚN código leía: solo la usaban fórmulas de la
// hoja. Esto trae esas columnas a CONTROLADORES, que pasa a ser la fuente
// única. La pestaña vieja se queda donde está: las fórmulas siguen apuntando a
// ella hasta que se migren.
//
// Se localiza por su CABECERA, no por su nombre, porque el nombre exacto de la
// pestaña no es de fiar.
function _hojaListaAtc() {
  var hojas = _ss().getSheets();
  for (var i = 0; i < hojas.length; i++) {
    var sh = hojas[i];
    if (sh.getLastRow() < 2 || sh.getLastColumn() < 6) continue;
    var cab = sh.getRange(1, 1, Math.min(5, sh.getLastRow()), Math.min(10, sh.getLastColumn())).getValues();
    for (var f = 0; f < cab.length; f++) {
      var fila = cab[f].map(function (x) { return String(x || '').trim().toLowerCase(); });
      if (fila.indexOf('iniciales') !== -1 && fila.indexOf('activoextras') !== -1) {
        return { hoja: sh, filaCab: f + 1, cols: {
          nombre: fila.indexOf('nombre') + 1, cta: fila.indexOf('iniciales') + 1,
          grupo: fila.indexOf('grupo') + 1, activo: fila.indexOf('activo') + 1,
          extras: fila.indexOf('activoextras') + 1, vacas: fila.indexOf('activovacas') + 1,
          puesto: fila.indexOf('puesto') + 1
        } };
      }
    }
  }
  return null;
}

function _exigirReparto(token) {
  var u = _exigirUsuario(token);
  if (_esAdministrador(u)) return u;
  var cargo = String(_cargoDeCta(u.cta) || '').trim().toUpperCase();
  if (CARGOS_REPARTO[cargo]) return u;
  throw new Error('Solo la jefatura de supervisión e instrucción puede repartir servicios.');
}

// google.script.run no puede devolver Date: el viaje de ida y vuelta por JSON
// los convierte a texto y de paso deja el objeto plano.
function _sanear(o) { try { return JSON.parse(JSON.stringify(o)); } catch (e) { return o; } }

function _hojaBorradores() {
  var sh = _ss().getSheetByName(HOJA_BORRADORES);
  if (!sh) {
    sh = _ss().insertSheet(HOJA_BORRADORES);
    sh.appendRow(CABECERA_BORRADORES);
    sh.getRange(1, 1, sh.getMaxRows(), 1).setNumberFormat('@'); // "JUL-26" como TEXTO
  }
  return sh;
}

function _filaBorrador(mes, tipo) {
  var sh = _hojaBorradores();
  if (sh.getLastRow() < 2) return 0;
  var val = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
  var mk = _mesKey(mes);
  for (var i = 0; i < val.length; i++) {
    if (_mesKey(val[i][0]) === mk && String(val[i][1]).trim().toLowerCase() === String(tipo).trim().toLowerCase()) {
      return i + 2;
    }
  }
  return 0;
}

// Qué se puede repartir, quién eres y qué borradores hay a medias, en un solo
// viaje: así la pantalla sabe desde el principio si tiene algo que recuperar y
// no obliga a recalcular lo que ya estaba guardado.
function getRepartoInicial(token) {
  var u = _exigirUsuario(token);
  var cargo = String(_cargoDeCta(u.cta) || '').trim().toUpperCase();
  var puede = _esAdministrador(u) || !!CARGOS_REPARTO[cargo];
  var meses = _mesesVigentes();
  // ⚠ Solo SUPERVISIÓN. El motor sigue siendo genérico (`TIPOS_REPARTO` con sus
  // dos tipos, y el tope del 75 % los suma) pero la instrucción ya NO se reparte
  // sola: se planifica a mano en su pantalla, donde el lado fijo es el alumno.
  // Dejar aquí el otro tipo ofrecía dos caminos para lo mismo, y uno de ellos
  // repartía Mo/To sin saber a quién instruye cada cual.
  return _sanear({
    ok: true, puede: puede, cargo: cargo,
    tipo: TIPOS_REPARTO.supervision.id,
    etiqueta: TIPOS_REPARTO.supervision.etiqueta,
    meses: meses, mesActual: _mesActualVigente(meses),
    // ⚠ Solo los de supervisión. La hoja BORRADORES la comparten el reparto y
    // el plan de instrucción, y el plan usa el tipo `instruccion` — el mismo id
    // que tenía el reparto de instrucción. Sin filtrar, un plan a medias salía
    // aquí como «otro borrador de reparto», que no es.
    borradores: puede ? _listarBorradores().filter(function (b) {
      return b.tipo === TIPOS_REPARTO.supervision.id;
    }) : []
  });
}

// Resumen de los borradores guardados, sin su JSON: solo para saber cuáles hay.
function _listarBorradores() {
  var sh = _hojaBorradores();
  if (sh.getLastRow() < 2) return [];
  var val = sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues();
  return val.filter(function (r) { return r[0] && r[1]; }).map(function (r) {
    return { mes: _mesCanon(r[0]), tipo: String(r[1]).trim(), autor: String(r[2]), ts: _fechaIso(r[3]) };
  });
}

// Calcula desde cero. Si hay borrador guardado para ese mes y tipo, lo aplica
// encima: las asignaciones que tocaste a mano y los bloqueos se conservan.
// ignorarBorrador: empezar de cero descartando lo guardado (el usuario lo pide
// explícitamente; el borrador NO se borra de la hoja hasta que guarde encima).
function calcularReparto(token, mes, tipo, ignorarBorrador) {
  var u = _exigirReparto(token);
  var borrador = ignorarBorrador ? null : _leerBorrador(mes, tipo);
  var r = borrador
    ? recalcularPropuestas(borrador.propuestas, mes, tipo)
    : calcularPropuestas(mes, tipo);
  r.meta.usuario = _emailDe(u.cta) || u.cta;   // la web app corre como el desplegador
  r.borrador = borrador ? { autor: borrador.autor, ts: borrador.ts } : null;
  _logApp('INFO', 'calcularReparto', mes + ' · ' + tipo + (borrador ? ' (con borrador)' : ''), u.cta);
  return _sanear(r);
}

function recalcularReparto(token, mes, tipo, propuestas) {
  var u = _exigirReparto(token);
  var r = recalcularPropuestas(_parse(propuestas, propuestas) || {}, mes, tipo);
  r.meta.usuario = _emailDe(u.cta) || u.cta;
  return _sanear(r);
}

function _emailDe(cta) {
  var m = ctaAEmail();
  for (var c in m) if (_mismaCta(c, cta)) return m[c];
  return '';
}

// ─── Borradores ─────────────────────────────────────────────────────────────
// Un borrador NO toca el turnero: es una propuesta guardada, editable, que se
// puede dejar a medias y retomar. Solo al aplicar se escriben las celdas.
// Se guarda sin `candidatos`, que es lo voluminoso y se recalcula solo.
function _podarPropuestas(props) {
  var out = {};
  for (var k in props) {
    var p = props[k];
    out[k] = {
      dia: p.dia, turno: p.turno,
      propuestaSistema: p.propuestaSistema, asignadoActual: p.asignadoActual,
      origen: p.origen, bloqueado: !!p.bloqueado, conflicto: !!p.conflicto,
      supAnualAntes: p.supAnualAntes, supMesAntes: p.supMesAntes,
      supAnualDespues: p.supAnualDespues, limiteMes: p.limiteMes
    };
  }
  return out;
}

function _leerBorrador(mes, tipo) {
  var fila = _filaBorrador(mes, tipo);
  if (!fila) return null;
  var v = _hojaBorradores().getRange(fila, 1, 1, CABECERA_BORRADORES.length).getValues()[0];
  var props = _parse(v[4], null);
  if (!props) return null;
  return { mes: _mesCanon(v[0]), tipo: String(v[1]), autor: String(v[2]), ts: _fechaIso(v[3]), propuestas: props };
}

function getBorradorReparto(token, mes, tipo) {
  _exigirReparto(token);
  return _sanear({ ok: true, borrador: _leerBorrador(mes, tipo) });
}

function guardarBorradorReparto(token, mes, tipo, propuestas) {
  var u = _exigirReparto(token);
  var props = _parse(propuestas, propuestas) || {};
  var txt = JSON.stringify(_podarPropuestas(props));
  if (txt.length > 45000) return { ok: false, error: 'El borrador es demasiado grande para una celda.' };
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = _hojaBorradores();
    var fila = [_mesCanon(mes), String(tipo), u.cta, new Date().toISOString(), txt];
    var f = _filaBorrador(mes, tipo);
    if (f) sh.getRange(f, 1, 1, CABECERA_BORRADORES.length).setValues([fila]);
    else sh.appendRow(fila);
    _logApp('INFO', 'guardarBorrador', mes + ' · ' + tipo + ' · ' + Object.keys(props).length + ' huecos', u.cta);
    return { ok: true, ts: fila[3] };
  } finally { lock.releaseLock(); }
}

function borrarBorradorReparto(token, mes, tipo) {
  var u = _exigirReparto(token);
  var f = _filaBorrador(mes, tipo);
  if (f) _hojaBorradores().deleteRow(f);
  _logApp('INFO', 'borrarBorrador', mes + ' · ' + tipo, u.cta);
  return { ok: true };
}

// Aplicar: escribe el turnero (por _aplicarTurnoCelda, así que queda en
// LOG_CELDAS y se puede deshacer), registra en el log del tipo y retira el
// borrador, que ya no representa nada pendiente.
function aplicarReparto(token, mes, tipo, propuestas) {
  var u = _exigirReparto(token);
  if (_mesEsPasado(mes)) return { ok: false, error: 'Ese mes ya pasó: no admite cambios.' };
  var props = _parse(propuestas, propuestas) || {};
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var data = recalcularPropuestas(props, mes, tipo);
    // Manda lo que el usuario dejó en pantalla, no lo que el motor recalcule.
    for (var k in props) if (data.propuestas[k]) data.propuestas[k].asignadoActual = props[k].asignadoActual;
    data.meta.usuario = _emailDe(u.cta) || u.cta;
    aplicarPropuestas(data);
    var f = _filaBorrador(mes, tipo);
    if (f) _hojaBorradores().deleteRow(f);
    var n = 0;
    for (var k2 in data.propuestas) if (data.propuestas[k2].asignadoActual) n++;
    _logApp('INFO', 'aplicarReparto', mes + ' · ' + tipo + ' · ' + n + ' asignaciones', u.cta);
    return { ok: true, asignaciones: n };
  } finally { lock.releaseLock(); }
}

// Notas e historial de TODO el mes, en una sola llamada.
//
// Pedirlo celda a celda era un viaje al servidor por cada clic, y no hace
// falta: Range.getNotes() devuelve la rejilla entera de una vez, al mismo
// coste que una celda suelta. Con esto el cliente pide una vez al abrir y el
// resto de clics son instantáneos.
//
// Solo viajan las celdas que tienen algo, que son pocas: un mes entero son
// ~30×31 celdas, pero con nota o historial hay un puñado.
function getDetalleMes(token, mes) {
  _exigirUsuario(token);
  var m = leerMesCache(mes);
  var notas = {};

  var filas = [];
  for (var cta in m.filaDeCta) filas.push(m.filaDeCta[cta]);
  if (filas.length && m.dias.length) {
    var f1 = Math.min.apply(null, filas), f2 = Math.max.apply(null, filas);
    var c1 = m.diaACol[m.dias[0]], c2 = m.diaACol[m.dias[m.dias.length - 1]];
    try {
      var sh = _ss().getSheetByName(mes);
      var nn = sh.getRange(f1, c1, f2 - f1 + 1, c2 - c1 + 1).getNotes();
      for (var c2a in m.filaDeCta) {
        var fi = m.filaDeCta[c2a] - f1;
        m.dias.forEach(function (d) {
          var txt = (nn[fi] || [])[m.diaACol[d] - c1];
          if (txt && String(txt).trim()) {
            if (!notas[c2a]) notas[c2a] = {};
            notas[c2a][d] = String(txt);
          }
        });
      }
    } catch (e) {
      _logApp('WARN', 'getDetalleMes', mes + ': no se pudieron leer las notas: ' + _errStr(e));
    }
  }

  // Historial de LOG_CELDAS del mes, agrupado por celda y lo reciente primero.
  var mk = _mesKey(mes), hist = {};
  _leerLogCeldas().forEach(function (l) {
    if (_mesKey(l.mes) !== mk) return;
    var k = l.cta + '|' + l.dia;
    if (!hist[k]) hist[k] = [];
    hist[k].unshift(l);
  });

  return _sanear({ ok: true, mes: _mesCanon(mes), notas: notas, historial: hist });
}

// ─── Quién puede cubrir un hueco ────────────────────────────────────────────
// Para ofrecer extras, voluntarias o COS: dado un día y una franja, quién
// puede hacerlo SIN incumplir nada, y quién lleva menos acumulados.
//
// El filtro que importa no es "quién libra" —eso es fácil— sino que meterle
// ese turno no le rompa descansos, los 6 días seguidos, el ciclo de 50 h ni
// las 170 h del mes. Eso lo decide el motor, no una lista.

/* ─── Acumulados: de dónde se cuentan ──────────────────────────────────────
   LOG_CELDAS es la fuente. LOG_DIAS solo completa lo que a LOG_CELDAS le
   falte, que después de migrar el histórico no debería ser nada — y por eso se
   deja: es lo que permite comprobar que la migración no cambió ningún número.

   ⚠️ **LOG_DIAS es un HISTÓRICO, no una foto.** Un registro normal solo añade
   una fila; lo único que borra filas es «Restablecer», que limpia todas las de
   ese (fecha, cta) y deja una de tipo `R` — el día vuelve a como estaba, así
   que sus acciones no cuentan. Contar «la última acción de cada celda» daría
   DE MENOS: dos extras del mismo día a la misma persona son dos.

   Así que de LOG_CELDAS se cuentan **todas** las acciones con tipo repartible,
   con las dos mismas excepciones:
   · las marcadas como deshechas, y
   · las de un (mes, día, cta) que después se RESTABLECIÓ.
   ⚠️ La primera es la única divergencia conocida con la hoja: `deshacerDia`
   no toca LOG_DIAS, así que allí una acción deshecha sigue contando. Se
   excluye a propósito —deshacer es decir que no pasó— y se dice aquí para que
   un número que no cuadre tenga explicación.
   ───────────────────────────────────────────────────────────────────────── */
var ORIGEN_IMPORTADO = 'IMPORT';

// La clave con la que se casan las filas de LOG_DIAS con las de LOG_CELDAS.
// ⚠️ NO identifica una fila: siendo LOG_DIAS un histórico, puede haber varias
// con la misma clave. Por eso lo que se compara son CUENTAS, no presencia.
function _claveAcum(f, cta, tipo) {
  if (!f) return '';
  return f.getFullYear() + '-' + (f.getMonth() + 1) + '-' + f.getDate() + '|' +
         String(cta).trim().toUpperCase() + '|' + tipo;
}

function _acumuladosLogCeldas() {
  var vivas = [], restablecidas = {};
  try {
    var todas = _leerLogCeldas();
    // Primero, qué celdas se restablecieron y cuándo: lo anterior a eso no vale.
    todas.forEach(function (l, i) {
      if (_tipoAccion(l.tipo) !== 'R') return;
      var k = _mesKey(l.mes) + '|' + Number(l.dia) + '|' + String(l.cta || '').trim().toUpperCase();
      restablecidas[k] = i;                    // el índice del último restablecer
    });
    todas.forEach(function (l, i) {
      var tipo = _tipoAccion(l.tipo);
      if (!TIPOS_LOG_DIAS[tipo] || tipo === 'R' || l.deshecho) return;
      var cta = String(l.cta || '').trim().toUpperCase();
      if (!cta || !l.fecha) return;
      var k = _mesKey(l.mes) + '|' + Number(l.dia) + '|' + cta;
      if (restablecidas[k] !== undefined && restablecidas[k] > i) return;   // borrada por el restablecer
      vivas.push({ fecha: l.fecha, cta: cta, tipo: tipo });
    });
  } catch (e) { _logApp('WARN', '_acumuladosLogCeldas', _errStr(e)); return { cuentas: {}, conteo: {} }; }

  var out = {}, conteo = {};
  vivas.forEach(function (x) {
    var f = (x.fecha instanceof Date) ? x.fecha : _fechaDeCelda(x.fecha);
    if (!f) return;
    if (!out[x.cta]) out[x.cta] = {};
    if (!out[x.cta][x.tipo]) out[x.cta][x.tipo] = {};
    out[x.cta][x.tipo][f.getFullYear()] = (out[x.cta][x.tipo][f.getFullYear()] || 0) + 1;
    var k = _claveAcum(f, x.cta, x.tipo);
    conteo[k] = (conteo[k] || 0) + 1;
  });
  return { cuentas: out, conteo: conteo };
}

// Lo que hay en LOG_DIAS, con su clave, para completar y para migrar.
//
// ⚠️ Un tipo que no se reconoce se DESCARTA, y descartarlo en silencio es
// exactamente cómo se pierde un año entero sin que nadie se entere. Lo que no
// casa se recoge en `_DESCARTADOS_LOG_DIAS` y la pantalla lo enseña.
var _DESCARTADOS_LOG_DIAS = {};
function _filasLogDias() {
  var out = [];
  _DESCARTADOS_LOG_DIAS = {};
  try {
    var sh = _ss().getSheetByName('LOG_DIAS');
    if (!sh || sh.getLastRow() < 2) return out;
    var val = sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues();
    val.forEach(function (r, i) {
      var cta = String(r[3] || '').trim().toUpperCase();
      var crudo = String(r[2] == null ? '' : r[2]).trim();
      var tipo = _tipoAccion(crudo);
      var f = (r[0] instanceof Date) ? r[0] : _fechaDeCelda(r[0]);
      if (!cta || !f) return;                       // fila sin persona o sin fecha
      if (!TIPOS_LOG_DIAS[tipo]) {
        // Ni siquiera es un tipo que el proyecto conozca: se anota con su
        // nombre tal cual y el año, que es lo que hace falta para arreglarlo.
        var k = crudo || '(vacío)';
        if (!_DESCARTADOS_LOG_DIAS[k]) _DESCARTADOS_LOG_DIAS[k] = { tipo: k, n: 0, anios: {} };
        _DESCARTADOS_LOG_DIAS[k].n++;
        _DESCARTADOS_LOG_DIAS[k].anios[f.getFullYear()] = (_DESCARTADOS_LOG_DIAS[k].anios[f.getFullYear()] || 0) + 1;
        return;
      }
      if (tipo === 'R') return;                     // el restablecer no se acumula
      out.push({ fila: i + 2, fecha: f, turno: _txtCelda(r[1]), tipo: tipo, cta: cta,
                 motivo: _txtCelda(r[4]), clave: _claveAcum(f, cta, tipo) });
    });
  } catch (e) { _logApp('WARN', '_filasLogDias', _errStr(e)); }
  return out;
}

// Lo que a LOG_CELDAS le falta de LOG_DIAS. Se compara POR CUENTA: si el mismo
// día hay dos extras de la misma persona, faltan las dos menos las que ya haya.
function _pendientesDeLogDias(conteo) {
  var visto = {}, out = [];
  _filasLogDias().forEach(function (r) {
    visto[r.clave] = (visto[r.clave] || 0) + 1;
    if (visto[r.clave] <= (conteo[r.clave] || 0)) return;   // esa ya está
    out.push(r);
  });
  return out;
}

// Acumulados por tipo: {cta: {tipo: {anio: n}}}.
// Suma tres cosas, en este orden: LOG_CELDAS, lo que a LOG_CELDAS le falte de
// LOG_DIAS, y los SALDOS DECLARADOS a mano (ver hoja AJUSTES_ACUM).
function _acumuladosLogDias() {
  var base = _acumuladosLogCeldas();
  var out = base.cuentas;
  var sumar = function (cta, tipo, anio, n) {
    if (!out[cta]) out[cta] = {};
    if (!out[cta][tipo]) out[cta][tipo] = {};
    out[cta][tipo][anio] = (out[cta][tipo][anio] || 0) + n;
  };
  // Solo lo que LOG_CELDAS no tenga. Tras migrar, esto no añade nada.
  _pendientesDeLogDias(base.conteo).forEach(function (r) {
    sumar(r.cta, r.tipo, r.fecha.getFullYear(), 1);
  });
  // ⚠️ Los saldos declarados NO son un log: no tienen día ni celda. Se suman
  // aquí y se marcan aparte para que en la pantalla se vea cuáles son.
  try {
    leerAjustesAcum().forEach(function (a) {
      if (!TIPOS_LOG_DIAS[a.tipo]) return;
      sumar(a.cta, a.tipo, a.anio, a.n);
    });
  } catch (e) { _logApp('WARN', '_acumuladosLogDias', 'AJUSTES_ACUM: ' + _errStr(e)); }
  return out;
}

// {cta: {tipo: {anio: n}}} solo de lo declarado a mano, para poder marcarlo.
function _mapaAjustes() {
  var out = {};
  try {
    leerAjustesAcum().forEach(function (a) {
      if (!TIPOS_LOG_DIAS[a.tipo]) return;
      if (!out[a.cta]) out[a.cta] = {};
      if (!out[a.cta][a.tipo]) out[a.cta][a.tipo] = {};
      out[a.cta][a.tipo][a.anio] = (out[a.cta][a.tipo][a.anio] || 0) + a.n;
    });
  } catch (e) {}
  return out;
}

/* ─── Guardar saldos declarados ────────────────────────────────────────────
   Para acumulados de los que solo se tiene el TOTAL: se sabe que alguien hizo
   4 activaciones en 2024, pero no qué días. Se guardan como cifra, no como
   log — inventarles una fecha sería meter en el histórico días que nadie
   trabajó, y esos días saldrían luego en el turnero y en «deshacer».
   ───────────────────────────────────────────────────────────────────────── */
function guardarAjustesAcum(token, tipo, anio, filas) {
  var u = _exigirVista(token, 'gestion.rapido');
  tipo = _tipoAccion(tipo);
  anio = Number(anio);
  if (!TIPOS_LOG_DIAS[tipo]) return { ok: false, error: 'Tipo no válido: ' + tipo + '.' };
  if (!anio || anio < 2000 || anio > 2100) return { ok: false, error: 'Año no válido: ' + anio + '.' };
  filas = filas || [];

  // Solo se aceptan iniciales que existan: un valor que caiga en una persona
  // que no está es peor que no tener el dato.
  var conocidas = {};
  try { leerControladoresCache().forEach(function (c) { conocidas[String(c.cta).toUpperCase()] = true; }); }
  catch (e) { return { ok: false, error: 'No se pudo leer CONTROLADORES.' }; }
  var malas = [];
  var limpias = [];
  filas.forEach(function (f) {
    var cta = String((f && f.cta) || '').trim().toUpperCase();
    var n = Number(f && f.n);
    if (!cta) return;
    if (!conocidas[cta]) { malas.push(cta); return; }
    if (!isFinite(n) || n <= 0) return;      // un 0 no es un saldo: es no tener nada
    limpias.push([cta, tipo, anio, n, 'Declarado a mano por ' + u.cta]);
  });
  if (malas.length) {
    return { ok: false, error: 'Estas iniciales no existen en CONTROLADORES: ' + malas.join(', ') + '.' };
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = hojaAjustesAcum();
    // Se REEMPLAZA lo de ese (tipo, año): guardar dos veces no acumula.
    var previas = leerAjustesAcum()
      .filter(function (a) { return a.tipo === tipo && a.anio === anio; })
      .map(function (a) { return a.fila; })
      .sort(function (x, y) { return y - x; });      // de abajo arriba
    previas.forEach(function (f) { sh.deleteRow(f); });
    if (limpias.length) {
      sh.getRange(sh.getLastRow() + 1, 1, limpias.length, CABECERA_AJUSTES.length).setValues(limpias);
    }
    _logApp('INFO', 'guardarAjustesAcum', tipo + ' ' + anio + ': ' + limpias.length +
      ' saldos (reemplazan ' + previas.length + ')', u.cta);
    return { ok: true, guardados: limpias.length, reemplazados: previas.length };
  } finally { lock.releaseLock(); }
}

/* ─── Migrar el histórico de LOG_DIAS a LOG_CELDAS ─────────────────────────
   Una sola vez. NO borra nada de LOG_DIAS: la hoja se sigue escribiendo,
   porque las pestañas-resumen leen de ella con fórmulas.

   Las filas importadas se marcan con origen `IMPORT` y **no llevan turno
   previo**, porque LOG_DIAS nunca lo guardó. Por eso quedan fuera de
   `deshacerDia` y de `_turnoBaseSegunLog`: deshacer una dejaría la celda en
   blanco creyendo que ese día se libraba.
   ───────────────────────────────────────────────────────────────────────── */
function previsualizarMigracionLogDias(token) {
  _exigirVista(token, 'gestion.rapido');
  var base = _acumuladosLogCeldas();
  var todas = _filasLogDias();
  var pendientes = _pendientesDeLogDias(base.conteo);
  var porAnio = {};
  pendientes.forEach(function (r) {
    var a = r.fecha.getFullYear();
    porAnio[a] = (porAnio[a] || 0) + 1;
  });
  return _sanear({
    ok: true, total: todas.length, pendientes: pendientes.length,
    yaEstaban: todas.length - pendientes.length, porAnio: porAnio
  });
}

function migrarLogDias(token) {
  var u = _exigirVista(token, 'gestion.rapido');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var base = _acumuladosLogCeldas();
    var pendientes = _pendientesDeLogDias(base.conteo);
    if (!pendientes.length) {
      return { ok: true, escritas: 0, mensaje: 'No había nada pendiente: LOG_CELDAS ya lo tenía todo.' };
    }
    // Más viejas primero, para que el orden del log siga siendo cronológico.
    pendientes.sort(function (a, b) { return a.fecha - b.fecha; });

    var sh = _hojaLogCeldas();
    var id = sh.getLastRow();
    var filas = pendientes.map(function (r) {
      id++;
      return [
        id, new Date(), _mesDeFecha(r.fecha), r.fecha.getDate(), r.fecha,
        r.cta,
        '',                      // ⚠️ turno previo DESCONOCIDO, no "libraba"
        r.turno, r.tipo, ORIGEN_IMPORTADO, 'LOG_DIAS:' + r.fila,
        r.motivo, u.cta, '', _idDe(r.cta), ''
      ];
    });
    sh.getRange(sh.getLastRow() + 1, 1, filas.length, CABECERA_LOG_CELDAS.length).setValues(filas);
    _logApp('INFO', 'migrarLogDias', filas.length + ' filas importadas de LOG_DIAS', u.cta);
    return { ok: true, escritas: filas.length,
             mensaje: filas.length + ' filas traídas de LOG_DIAS. No se ha borrado nada de allí.' };
  } finally { lock.releaseLock(); }
}

// "AGO-26" a partir de un Date. Lo necesita la migración, que parte de fechas.
function _mesDeFecha(f) {
  return MES3[f.getMonth()] + '-' + ('0' + (f.getFullYear() % 100)).slice(-2);
}

function candidatosParaCubrir(token, mes, dia, turno, tipo) {
  _exigirVista(token, 'gestion.rapido');
  dia = Number(dia);
  turno = String(turno || 'M').trim();
  tipo = _tipoAccion(tipo || 'E');
  if (_mesEsPasado(mes)) return { ok: false, error: 'Ese mes ya pasó.' };

  var m = _aplicarValidados(mes, leerMesCache(mes));
  var ext = _extBase(mes, m);              // con fronteras: los ciclos cruzan de mes
  var nombres = ctaANombre();
  var acum = _acumuladosLogDias();
  var anio = 0; var fm = _fechaDelMes(mes); if (fm) anio = fm.getFullYear();
  var ctrl = {};
  leerControladoresCache().forEach(function (c) { ctrl[c.cta] = c; });

  var def = CONFIG_TURNOS[normalizarCodigo(turno)];
  var necesita = def && def.habilitacion;   // Ms/Ts piden supervisar, Mo/To instruir

  // ACTIVAR UNA IMAGINARIA NO ES CUBRIR UN HUECO. La persona YA tiene im o it
  // ese día, y activarla convierte esa imaginaria en el turno: im → M, it → T.
  // Así que el candidato no es quien libra, sino justo quien tiene la
  // imaginaria de esa franja.
  var esActivacion = (tipo === 'A');
  var IMAGINARIA = { M: 'im', T: 'it' };
  var imNecesaria = IMAGINARIA[normalizarCodigo(turno)] || '';
  if (esActivacion && !imNecesaria) {
    return { ok: false, error: 'Solo se pueden activar imaginarias hacia M (desde im) o T (desde it).' };
  }

  var lista = [];
  Object.keys(m.cargos).forEach(function (cta) {
    var c = ctrl[cta];
    if (c && !c.activo) return;
    if (_cargoExcluido(m.cargos[cta])) return;                 // jefaturas
    var suyo = (m.base[cta] || {})[dia] || '';
    if (esActivacion) {
      if (suyo !== imNecesaria) return;                        // no tiene ESA imaginaria
    } else if (suyo) {
      return;                                                  // ya trabaja ese día
    }
    if ((m.vacaciones[cta] || {})[dia] || (m.bajas[cta] || {})[dia]) return;
    // «Activo para extras» de CONTROLADORES: hay puestos que no las hacen.
    if ((tipo === 'E' || tipo === 'C') && c && c.activoExtras === false) return;
    if (necesita && capacidadesDeCargo(m.cargos[cta]).indexOf(necesita) === -1) return;

    var movs = [{ cta: cta, dia: dia, de: esActivacion ? imNecesaria : 'libre', a: turno }];
    var r;
    // `cobertura: false`: esto NO es un intercambio. Cubrir un hueco añade a
    // la franja y activar una imaginaria la mueve de im a M — que la cobertura
    // cambie es el objetivo, no una violación.
    try {
      r = validarBloque(ext.base, ext.cargos, movs, {
        mesDesde: 1, mesHasta: ext.nDias, diaCorte: _diaCorte(mes), cobertura: false
      });
    }
    catch (e) { return; }

    var porTipo = ((acum[cta] || {})[tipo]) || {};
    var esteAnio = porTipo[anio] || 0;
    var trienio = (porTipo[anio] || 0) + (porTipo[anio - 1] || 0) + (porTipo[anio - 2] || 0);
    lista.push({
      cta: cta, nombre: nombres[cta] || cta, puesto: m.cargos[cta] || '',
      desde: suyo || 'libre',
      ok: r.ok,
      violaciones: (r.violaciones || []).map(function (v) { return { regla: v.regla, detalle: v.detalle }; }),
      esteAnio: esteAnio, trienio: trienio,
      grupo: (c && c.grupo) || ''
    });
  });

  // Reparto justo (decisión 6): primero quien cumple; entre ellos, el que menos
  // lleva DE ESTE TIPO este año, y a igualdad el que menos en el trienio.
  // Vale para todo lo que se reparte: extras, voluntarias, COS y activaciones
  // de imaginaria cuando hay más de un nombrado.
  lista.sort(function (a, b) {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    if (a.esteAnio !== b.esteAnio) return a.esteAnio - b.esteAnio;
    if (a.trienio !== b.trienio) return a.trienio - b.trienio;
    return a.cta < b.cta ? -1 : 1;   // desempate estable, para que no baile
  });
  // El primero que cumple es a quien le toca. Se marca para que no haya que
  // deducirlo del orden.
  for (var i = 0; i < lista.length; i++) {
    if (lista[i].ok) { lista[i].recomendado = true; break; }
  }

  return _sanear({
    ok: true, mes: _mesCanon(mes), dia: dia, turno: turno, tipo: tipo, anio: anio,
    activacion: esActivacion, desdeImaginaria: imNecesaria,
    etiqueta: (TIPOS_LOG_DIAS[tipo] || tipo), candidatos: lista
  });
}

// ─── Resumen del mes de UN controlador ──────────────────────────────────────
// Junta lo que está repartido en tres sitios: la rejilla (cuántos servicios de
// cada tipo), las columnas calculadas de la hoja (HORAS y H.MAX., que son
// fórmulas y no se pueden derivar) y LOG_DIAS (extras, voluntarias, COS…, que
// no están en la rejilla).
var TIPOS_LOG_DIAS = {
  E: 'Extras', V: 'Voluntarias', D: 'Desprogramaciones',
  C: 'COS', A: 'Activaciones', B: 'Bajas', R: 'Restablecidos'
};

function getResumenMes(token, mes) {
  var u = _exigirUsuario(token);
  var m = _aplicarValidados(mes, leerMesCache(mes));
  var mios = m.base[u.cta] || {};

  // Servicios del mes, por código, contando solo lo que se trabaja.
  var porCodigo = {}, trabajados = 0;
  m.dias.forEach(function (d) {
    if ((m.bajas[u.cta] || {})[d]) return;
    var c = mios[d];
    if (!c) return;
    porCodigo[c] = (porCodigo[c] || 0) + 1;
    if (esTrabajada(c)) trabajados++;
  });
  var vac = Object.keys(m.vacaciones[u.cta] || {}).length;
  var bajas = Object.keys(m.bajas[u.cta] || {}).length;

  // Lo que dice la hoja. Si no están esas columnas, se queda vacío y la
  // pantalla lo dice, en vez de enseñar un número inventado.
  var res = (m.resumen || {})[u.cta] || {};

  // LOG_DIAS: extras, voluntarias y demás, del AÑO del mes que se mira.
  var anio = 0;
  var fm = _fechaDelMes(mes);
  if (fm) anio = fm.getFullYear();
  var acumulado = {}, esteMes = {};
  try {
    var sh = _ss().getSheetByName('LOG_DIAS');
    if (sh && sh.getLastRow() > 1) {
      var val = sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues();
      var mesIdx = fm ? fm.getMonth() : -1;
      val.forEach(function (r) {
        if (!_mismaCta(r[3], u.cta)) return;
        var f = (r[0] instanceof Date) ? r[0] : _fechaDeCelda(r[0]);
        if (!f || f.getFullYear() !== anio) return;
        var t = String(r[2] || '').trim().toUpperCase();
        if (!TIPOS_LOG_DIAS[t]) return;
        acumulado[t] = (acumulado[t] || 0) + 1;
        if (f.getMonth() === mesIdx) esteMes[t] = (esteMes[t] || 0) + 1;
      });
    }
  } catch (e) {
    _logApp('WARN', 'getResumenMes', 'LOG_DIAS: ' + _errStr(e), u.cta);
  }

  return _sanear({
    ok: true, mes: _mesCanon(mes), cta: u.cta, anio: anio,
    servicios: trabajados, porCodigo: porCodigo, vacaciones: vac, bajas: bajas,
    horas: res.horas || '', hmax: res.hmax || '',
    tipos: TIPOS_LOG_DIAS, esteMes: esteMes, acumulado: acumulado
  });
}

// ─── Resumen ANUAL de UN controlador ───────────────────────────────────────
// Lo mismo que el mensual, mes a mes y con el total del año. Las fuentes son
// las tres de siempre: la rejilla, las columnas calculadas de la hoja (HORAS y
// H.MAX., que son fórmulas) y LOG_DIAS.
//
// ⚠️ Solo los meses **cumplidos** entran en el total. El mes en curso sale como
// una fila más, marcada, pero NO suma: si sumara, cualquier comparación con el
// año pasado saldría torcida sin que se viera por qué. Los futuros ni se leen.
//
// "156:17" → minutos. La hoja lo da como TEXTO (getDisplayValues), porque
// dentro es una duración y un Date no puede viajar al cliente.
function _minutosDeHHMM(txt) {
  var t = String(txt == null ? '' : txt).trim();
  var m = t.match(/^(\d+)\s*:\s*(\d{1,2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}
function _hhmm(min) {
  if (min == null) return '';
  var n = Math.max(0, Math.round(min));
  return Math.floor(n / 60) + ':' + ('0' + (n % 60)).slice(-2);
}

function getResumenAnual(token, anio) {
  var u = _exigirUsuario(token);
  anio = Number(anio) || new Date().getFullYear();
  var idxActual = _indiceMesActual();

  var deEsteAnio = listarMeses().filter(function (n) {
    if (_indiceDeMes(n) === -1) return false;
    var f = _fechaDelMes(n);
    return f && f.getFullYear() === anio;
  }).sort(function (a, b) { return _indiceDeMes(a) - _indiceDeMes(b); });

  // LOG_DIAS del año entero, repartido por mes. Una sola lectura para los doce.
  var porMesLog = {};
  try {
    var sh = _ss().getSheetByName('LOG_DIAS');
    if (sh && sh.getLastRow() > 1) {
      var val = sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues();
      val.forEach(function (r) {
        if (!_mismaCta(r[3], u.cta)) return;
        var f = (r[0] instanceof Date) ? r[0] : _fechaDeCelda(r[0]);
        if (!f || f.getFullYear() !== anio) return;
        var t = String(r[2] || '').trim().toUpperCase();
        if (!TIPOS_LOG_DIAS[t]) return;
        if (!porMesLog[f.getMonth()]) porMesLog[f.getMonth()] = {};
        porMesLog[f.getMonth()][t] = (porMesLog[f.getMonth()][t] || 0) + 1;
      });
    }
  } catch (e) {
    _logApp('WARN', 'getResumenAnual', 'LOG_DIAS: ' + _errStr(e), u.cta);
  }

  var meses = [], avisos = [];
  deEsteAnio.forEach(function (n) {
    var idx = _indiceDeMes(n);
    if (idx > idxActual) return;                 // un mes que no ha empezado no resume nada
    var enCurso = (idx === idxActual);
    var m;
    try { m = _aplicarValidados(n, leerMesCache(n)); }
    catch (e2) { avisos.push(n + ': no se pudo leer (' + _errStr(e2) + ')'); return; }
    if (!m.filaDeCta || m.filaDeCta[u.cta] === undefined) {
      avisos.push(n + ': no tienes fila en ese cuadrante');
      return;
    }

    var mios = m.base[u.cta] || {};
    var porCodigo = {}, servicios = 0, mananas = 0, tardes = 0, imaginarias = 0, activadas = 0, otros = 0;
    m.dias.forEach(function (d) {
      if ((m.bajas[u.cta] || {})[d]) return;
      var c = mios[d];
      if (!c) return;
      porCodigo[c] = (porCodigo[c] || 0) + 1;
      if (!esTrabajada(c)) return;
      servicios++;
      var nc = normalizarCodigo(c);
      // ⚠️ Al ACTIVAR una imaginaria, la celda deja de poner `im` y pone `M`,
      // con fondo cian. Así que las activadas hay que contarlas por la MARCA,
      // no dentro de la rama de `im`/`it` —donde nunca caen— o salen siempre a
      // cero. Es la misma trampa que ya advierte «El color del cuadrante ES
      // información»: una `M` sobre cian no es una mañana cualquiera.
      // Una activada NO es un bucket aparte: ya es un servicio de mañana o de
      // tarde y cuenta como tal. Es una etiqueta sobre él.
      if (((m.marcas[u.cta] || {})[d]) === 'activada') activadas++;
      // Las imaginarias que siguen SIN activar van aparte: computan distinto
      // (1 h 30) y no son un servicio de fanal. Lo demás se agrupa por su
      // franja OPERATIVA, no por la letra: una EvM se trabaja por la mañana.
      if (nc === 'im' || nc === 'it') { imaginarias++; return; }
      // ⚠ La franja sale de `franjaOperativa`, no de la letra: una EvM se
      // trabaja por la mañana. Lo que no cae en ninguna franja de fanal
      // —despacho, SIM, curso, reunión— va a «otros», y NO se calla: si no,
      // servicios ≠ mañanas + tardes + imaginarias y la fila no cuadraría.
      var fr = franjaOperativa(c);
      if (fr === 'M') mananas++; else if (fr === 'T') tardes++; else otros++;
    });

    var res = (m.resumen || {})[u.cta] || {};
    var fm = _fechaDelMes(n);
    meses.push({
      mes: _mesCanon(n),
      enCurso: enCurso,
      servicios: servicios, mananas: mananas, tardes: tardes,
      imaginarias: imaginarias, activadas: activadas, otros: otros,
      vacaciones: Object.keys(m.vacaciones[u.cta] || {}).length,
      bajas: Object.keys(m.bajas[u.cta] || {}).length,
      porCodigo: porCodigo,
      horas: res.horas || '', hmax: res.hmax || '',
      minutos: _minutosDeHHMM(res.horas),
      minutosMax: _minutosDeHHMM(res.hmax),
      log: (fm ? porMesLog[fm.getMonth()] : null) || {}
    });
  });

  // El total: solo lo cumplido.
  var cumplidos = meses.filter(function (x) { return !x.enCurso; });
  var suma = function (campo) {
    return cumplidos.reduce(function (n, x) { return n + (x[campo] || 0); }, 0);
  };
  // ⚠️ Si a algún mes le falta la columna HORAS, el total sería una mentira
  // discreta: se dice cuántos faltan en vez de sumar lo que haya.
  var sinHoras = cumplidos.filter(function (x) { return x.minutos == null; }).map(function (x) { return x.mes; });
  var minutos = sinHoras.length ? null : suma('minutos');
  var minutosMax = cumplidos.some(function (x) { return x.minutosMax == null; }) ? null : suma('minutosMax');

  var log = {};
  cumplidos.forEach(function (x) {
    Object.keys(x.log).forEach(function (t) { log[t] = (log[t] || 0) + x.log[t]; });
  });

  return _sanear({
    ok: true, cta: u.cta, anio: anio, anios: _aniosConCuadrante(),
    meses: meses,
    total: {
      meses: cumplidos.length,
      servicios: suma('servicios'), mananas: suma('mananas'), tardes: suma('tardes'),
      imaginarias: suma('imaginarias'), activadas: suma('activadas'), otros: suma('otros'),
      vacaciones: suma('vacaciones'), bajas: suma('bajas'),
      horas: _hhmm(minutos), hmax: _hhmm(minutosMax),
      log: log
    },
    sinHoras: sinHoras,
    tipos: TIPOS_LOG_DIAS,
    avisos: avisos
  });
}

/* ─── Acumulados y orden de prelación ──────────────────────────────────────
   Quién lleva cuántas extras, voluntarias, COS, desprogramaciones y
   activaciones en los tres últimos años, y a quién le toca la siguiente.

   Es lo que hoy hacen a mano las pestañas-resumen de la hoja (EXTRAS /
   VOLUNTARIOS / DESPROGRAMACIONES por año + LISTA DE ASIGNACIÓN) con fórmulas
   sobre LOG_DIAS. Aquí se cuenta lo mismo desde el mismo sitio, así que si un
   número no cuadra con la hoja es que la fórmula mira otra cosa — no que haya
   dos verdades.

   ⚠️ Cada tipo va POR SU CUENTA (decisión 6 + fase 9): las extras de alguien no
   le penalizan para voluntarias. El total E+V+C se enseña como dato, pero el
   orden se calcula por tipo.
   ───────────────────────────────────────────────────────────────────────── */

// Los tipos que se reparten y de los que interesa el acumulado. `B` (bajas) y
// `R` (restablecidos) no se reparten: no son un servicio que se dé a alguien.
var TIPOS_ACUMULADOS = ['E', 'V', 'C', 'D', 'A'];
// Los que suman al total combinado, que es lo que enseña la hoja como
// «TOTALES (E+V+C)». Ni las desprogramaciones ni las activaciones entran: una
// desprogramación es lo contrario de un servicio y una activación no se reparte.
var TIPOS_TOTAL_COMBINADO = ['E', 'V', 'C'];

function getAcumulados(token, anioFin) {
  var u = _exigirUsuario(token);
  var fin = Number(anioFin) || new Date().getFullYear();
  var anios = [fin, fin - 1, fin - 2];

  var cuentas = _acumuladosLogDias();          // {cta: {tipo: {anio: n}}}
  var ajustes = _mapaAjustes();                // de esos, los declarados a mano
  var descartados = Object.keys(_DESCARTADOS_LOG_DIAS).map(function (k) {
    var x = _DESCARTADOS_LOG_DIAS[k];
    return { tipo: x.tipo, n: x.n,
             anios: Object.keys(x.anios).sort().map(function (a) { return a + ': ' + x.anios[a]; }).join(', ') };
  });
  var ctas = [];
  try {
    ctas = leerControladoresCache().filter(function (c) { return c.activo && !esAlumno(c); });
  } catch (e) { ctas = []; }

  var filas = ctas.map(function (c) {
    // ⚠ Va por PUESTO, no por persona: una jefatura cambia de manos y quien la
    // deja vuelve al reparto solo, sin tocar nada. Se resuelve con
    // `_cargoDeCta` (CARGOS_CTA → cuadrante → columna G), como todo lo demás.
    var cargo = '';
    try { cargo = String(_cargoDeCta(c.cta) || '').trim().toUpperCase(); } catch (e0) { cargo = c.puesto || ''; }
    var por = {}, trienio = {}, combinado = 0;
    TIPOS_ACUMULADOS.forEach(function (t) {
      por[t] = {};
      var suma = 0;
      anios.forEach(function (a) {
        var n = (((cuentas[c.cta] || {})[t] || {})[a]) || 0;
        por[t][a] = n; suma += n;
      });
      trienio[t] = suma;
      if (TIPOS_TOTAL_COMBINADO.indexOf(t) !== -1) combinado += suma;
    });
    return {
      cta: c.cta, nombre: c.nombre || c.cta, cargo: cargo,
      // Quien no participa en extras no entra en el reparto de E y C, así que
      // se marca: si no, parecería que siempre le toca a él.
      activoExtras: c.activoExtras !== false,
      // Y su PUESTO puede estar fuera del reparto entero (las jefaturas).
      recibe: recibeReparto(cargo),
      por: por, trienio: trienio, combinado: combinado,
      // Qué parte de esas cifras es un saldo declarado y no un registro.
      ajustes: ajustes[c.cta] || {}
    };
  });

  // ⚠️ Una columna entera a cero rara vez significa «nadie hizo nada»: casi
  // siempre es que eso no está registrado. Se mira POR TIPO Y AÑO, no por año
  // entero: 2024 puede tener extras y ninguna activación, y decir «2024 está
  // vacío» sería falso y despistaría.
  var vacios = [];
  anios.forEach(function (a) {
    if (!filas.some(function (f) {
      return TIPOS_ACUMULADOS.some(function (t) { return f.por[t][a]; });
    })) vacios.push(a);
  });
  var celdasVacias = [];
  TIPOS_ACUMULADOS.forEach(function (t) {
    anios.forEach(function (a) {
      if (vacios.indexOf(a) !== -1) return;      // ya se avisa del año entero
      if (!filas.some(function (f) { return f.por[t][a]; })) {
        celdasVacias.push({ tipo: t, txt: TIPOS_LOG_DIAS[t], anio: a });
      }
    });
  });

  return _sanear({
    ok: true, anios: anios, anioFin: fin,
    tipos: TIPOS_ACUMULADOS.map(function (t) { return { id: t, txt: TIPOS_LOG_DIAS[t] }; }),
    combinan: TIPOS_TOTAL_COMBINADO,
    filas: filas,
    ordenes: _ordenesDePrelacion(filas, anios),
    aniosSinDatos: vacios,
    sinDatos: celdasVacias,
    // Lo que hay en LOG_DIAS y no se está contando, con su nombre y su año.
    descartados: descartados,
    // Las iniciales activas, en orden, para emparejar una lista pegada a mano.
    ctas: ctas.map(function (c) { return c.cta; }).sort(),
    yo: u.cta
  });
}

// A quién le toca la siguiente, por tipo. Ranking de la decisión 6: **año en
// curso ascendente**, y a igualdad **el trienio ascendente**. El desempate
// final es alfabético, para que el orden no baile entre dos peticiones.
function _ordenesDePrelacion(filas, anios) {
  var out = {};
  TIPOS_ACUMULADOS.forEach(function (t) {
    out[t] = filas.slice()
      // ⚠ Un puesto fuera del reparto no entra en NINGUNA lista de siguientes.
      // Sí sale en la tabla: su histórico existe y hay que poder verlo.
      .filter(function (f) { return f.recibe; })
      // Quien no participa en extras no entra en el orden de E ni de C.
      .filter(function (f) { return f.activoExtras || (t !== 'E' && t !== 'C'); })
      .sort(function (a, b) {
        var aa = a.por[t][anios[0]] || 0, bb = b.por[t][anios[0]] || 0;
        if (aa !== bb) return aa - bb;
        if (a.trienio[t] !== b.trienio[t]) return a.trienio[t] - b.trienio[t];
        return a.cta < b.cta ? -1 : 1;
      })
      .map(function (f) { return f.cta; });
  });
  return out;
}

// Los años que tienen algún cuadrante, para el selector. Sale de las hojas que
// hay, no de una lista escrita: el día que se cree ENE-27 aparece solo.
function _aniosConCuadrante() {
  var out = [];
  listarMeses().forEach(function (n) {
    var f = _fechaDelMes(n);
    if (f && out.indexOf(f.getFullYear()) === -1) out.push(f.getFullYear());
  });
  return out.sort(function (a, b) { return b - a; });
}

// Escribir la nota de una celda del turnero. Solo ADMIN: la nota la ve
// cualquiera que abra la hoja y es donde queda la traza de los cambios.
function setNotaCelda(token, mes, cta, dia, texto) {
  var u = _exigirVista(token, 'gestion.rapido');
  if (_mesEsPasado(mes)) return { ok: false, error: 'Ese mes ya pasó.' };
  dia = Number(dia);
  var m = leerMes(mes);   // fresco: la fila y la columna han de ser las de ahora
  var fila = m.filaDeCta[cta], col = m.diaACol[dia];
  if (!fila || !col) return { ok: false, error: 'No encuentro la celda de ' + cta + ' el día ' + dia + '.' };

  var celda = _ss().getSheetByName(mes).getRange(fila, col);
  var antes = String(celda.getNote() || '');
  var ahora = String(texto == null ? '' : texto).trim();
  if (ahora.length > 4000) return { ok: false, error: 'La nota es demasiado larga.' };

  // Las líneas SYS: son la traza que deja la app al escribir el turnero. No se
  // impide borrarlas —a veces hay que limpiar—, pero queda dicho quién lo hizo.
  var sysAntes = antes.split('\n').filter(function (l) { return l.indexOf('SYS:') === 0; }).length;
  var sysAhora = ahora.split('\n').filter(function (l) { return l.indexOf('SYS:') === 0; }).length;

  celda.setNote(ahora);
  invalidarCacheMes(mes);
  _logApp(sysAhora < sysAntes ? 'WARN' : 'INFO', 'setNotaCelda',
    _mesCanon(mes) + ' d' + dia + ' ' + cta + ': nota de ' + antes.length + ' a ' + ahora.length + ' car.' +
    (sysAhora < sysAntes ? ' · SE HAN PERDIDO ' + (sysAntes - sysAhora) + ' línea(s) SYS:' : ''), u.cta);
  return { ok: true, nota: ahora, sysPerdidas: Math.max(0, sysAntes - sysAhora) };
}

// ─── Puestos y competencias (hoja PUESTOS) ──────────────────────────────────
// Quién puede supervisar, quién puede instruir y qué jefaturas quedan fuera del
// circuito de cambios se declara en la hoja, no en el código.
function getPuestos(token) {
  _exigirUsuario(token);
  var lista = leerPuestosCache();
  return {
    ok: true,
    puestos: lista,
    capacidades: ['supervisar', 'instruir', 'evaluar'],
    enUso: revisarCargos(token).cargosEnHoja  // cuántas personas tiene cada puesto
  };
}

function setPuestos(token, filas) {
  var u = _exigirVista(token, 'config.puestos');
  if (!filas || !filas.length) return { ok: false, error: 'No se puede dejar la tabla de puestos vacía.' };
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = hojaPuestos();
    if (sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
    var valores = filas.map(function (p) {
      var caps = p.capacidades || [];
      return [
        String(p.puesto || '').trim().toUpperCase(),
        _sn(caps.indexOf('supervisar') !== -1),
        _sn(caps.indexOf('instruir') !== -1),
        _sn(!p.excluido),   // la hoja lo declara en positivo: "Cambia turnos"
        _sn(!!p.excepcional),
        String(p.notas || ''),
        _sn(caps.indexOf('evaluar') !== -1),
        _sn(!p.sinReparto)   // «Recibe servicios», en positivo como las demás
      ];
    }).filter(function (r) { return r[0]; });
    if (!valores.length) return { ok: false, error: 'Ningún puesto válido en la tabla.' };
    sh.getRange(2, 1, valores.length, CABECERA_PUESTOS.length).setValues(valores);
    invalidarCachePuestos();
    aplicarConfigPuestos();
    _logApp('INFO', 'setPuestos', valores.length + ' puestos declarados', u.cta);
    return { ok: true, puestos: leerPuestosCache() };
  } finally {
    lock.releaseLock();
  }
}

// ─── Cruce de cargos y capacidades ──────────────────────────────────────────
// Un cargo escrito en la hoja que el motor no conoce (una errata como "TINS"
// por "TIN") no da error: simplemente deja a esa persona SIN capacidades, y a
// partir de ahí no puede recibir un Ms/Ts ni un Mo/To, ni entra en el reparto.
// Falla en silencio, así que conviene poder preguntarlo.
function revisarCargos(token) {
  _exigirUsuario(token);
  var conocidos = {};
  // Declarado en PUESTOS cuenta como conocido aunque no tenga competencias:
  // un puesto sin capacidades puede ser una decisión, no una errata.
  leerPuestosCache().forEach(function (p) { conocidos[p.puesto] = true; });
  var vistos = {}, huerfanos = {};
  _mesesVigentes().forEach(function (mes) {
    var m;
    try { m = leerMesCache(mes); } catch (e) { return; }
    for (var cta in m.cargos) {
      var cargo = String(m.cargos[cta] || '').trim().toUpperCase();
      if (!cargo) continue;                    // CTA raso: sin cargo, normal
      if (CARGOS_EXCLUIDOS[cargo]) continue;   // jefaturas: fuera del circuito
      vistos[cargo] = (vistos[cargo] || 0) + 1;
      if (!conocidos[cargo]) {
        if (!huerfanos[cargo]) huerfanos[cargo] = {};
        huerfanos[cargo][cta] = true;
      }
    }
  });
  var avisos = [];
  for (var h in huerfanos) {
    avisos.push('El cargo "' + h + '" no está en CONFIG_HABILITACIONES: ' +
      Object.keys(huerfanos[h]).join(', ') + ' no pueden recibir turnos con habilitación.');
  }
  return { ok: avisos.length === 0, cargosEnHoja: vistos, conocidos: Object.keys(conocidos), avisos: avisos };
}

function setLogNivel(nivel) {
  PropertiesService.getScriptProperties().setProperty('LOG_NIVEL', String(nivel).toUpperCase());
  return 'LOG_NIVEL = ' + String(nivel).toUpperCase();
}

// ─── Log EN TIEMPO REAL (CacheService: rápido, sin tocar Sheets) ─────────────
// Anillo con las últimas ~200 entradas de TODOS los niveles. La consola de la
// pestaña Diagnóstico lo lee con getRtLog() cada pocos segundos.
var _RT_KEY = 'rtlog_v1';
function _rtPush(nivel, accion, detalle, ms) {
  try {
    var c = CacheService.getScriptCache();
    var arr = [];
    var hit = c.get(_RT_KEY);
    if (hit) { try { arr = JSON.parse(hit); } catch (e) {} }
    arr.push({ t: new Date().toISOString(), n: nivel, a: accion, d: String(detalle == null ? '' : detalle).slice(0, 300), ms: (ms == null ? '' : ms) });
    if (arr.length > 200) arr = arr.slice(arr.length - 200);
    c.put(_RT_KEY, JSON.stringify(arr), 3600);
  } catch (e) { /* nunca romper la app */ }
}
function getRtLog(token) {
  _exigirUsuario(token);
  try { return JSON.parse(CacheService.getScriptCache().get(_RT_KEY) || '[]'); }
  catch (e) { return []; }
}

// Latido sin dependencias (no toca hojas ni caché de datos): si esto responde
// rápido pero otra llamada no, el atasco está en esa llamada, no en el servidor.
function ping() {
  return { ok: true, t: new Date().toISOString(), version: VERSION_BACKEND };
}

// ─── Notificaciones ─────────────────────────────────────────────────────────
// URL base de la app para los correos. NO se deduce de ScriptApp: eso devuelve
// la de la implementación que está sirviendo, y desde la de pruebas (@HEAD)
// mandaríamos a todo el mundo un enlace que no es el suyo. Manda la propiedad
// URL_APP; ScriptApp solo es el respaldo.
function _urlApp() {
  try {
    var fija = PropertiesService.getScriptProperties().getProperty('URL_APP');
    if (fija) return String(fija).trim();
  } catch (e) {}
  return ScriptApp.getService().getUrl();
}

function getUrlApp(token) {
  _exigirVista(token, 'config.gente');
  var fija = '';
  try { fija = PropertiesService.getScriptProperties().getProperty('URL_APP') || ''; } catch (e) {}
  var actual = '';
  try { actual = ScriptApp.getService().getUrl(); } catch (e) {}
  return {
    ok: true, url: _urlApp(), fija: fija, sirviendo: actual,
    // Si no hay URL fijada y estás en una implementación distinta de la de
    // producción, los enlaces que se envíen apuntarán aquí.
    aviso: !fija ? 'No hay URL fijada: los enlaces usarán la de la implementación que sirva la app en ese momento.' : ''
  };
}

function setUrlApp(token, url) {
  var u = _exigirVista(token, 'config.gente');
  url = String(url || '').trim();
  if (url && !/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url)) {
    return { ok: false, error: 'Eso no parece la URL /exec de una implementación.' };
  }
  var props = PropertiesService.getScriptProperties();
  if (url) props.setProperty('URL_APP', url); else props.deleteProperty('URL_APP');
  _logApp('INFO', 'setUrlApp', url || '(sin fijar)', u.cta);
  return { ok: true, url: _urlApp() };
}

// ─── Alta, edición y baja de controladores ──────────────────────────────────
// Las iniciales NO se editan: son la clave con la que están escritos el
// cuadrante, CAMBIOS, los logs y CARGOS_CTA. Cambiarlas dejaría huérfano todo
// el histórico. Si alguien necesita otras, es alta nueva y baja de la vieja.
//
// La baja tampoco borra la fila: marca activo=NO. Quien se va deja detrás
// cambios, logs y cargos que deben seguir cuadrando, e identificarPorToken ya
// filtra por activo, así que pierde el acceso igual.
var COLS_CTA = { CTA: 1, NOMBRE: 2, EMAIL: 3, TOKEN: 4, ACTIVO: 5, ROL: 6, PUESTO: 7, GRUPO: 8, EXTRAS: 9, VACAS: 10, ID: 11, ALTA: 12, BAJA: 13 };
var CABECERA_CTA_EXTRA = ['puesto', 'grupo', 'activo_extras', 'activo_vacas', 'id', 'alta', 'baja'];
// ⚠️ Los perfiles ya NO son una lista fija: se dan de alta en «Configuración →
// Permisos». Lo que valida un `rol_app` es el catálogo (`_perfiles()`).
function _rolValido(rol) { return !!_perfiles()[String(rol || '').trim().toUpperCase()]; }

function _filaDeControlador(sh, cta) {
  if (sh.getLastRow() < 2) return 0;
  var val = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
  for (var i = 0; i < val.length; i++) {
    if (String(val[i][0]).trim().toUpperCase() === String(cta).trim().toUpperCase()) return i + 2;
  }
  return 0;
}

function crearControlador(token, datos) {
  var u = _exigirVista(token, 'config.gente');
  datos = datos || {};
  var cta = String(datos.cta || '').trim().toUpperCase();
  var nombre = String(datos.nombre || '').trim();
  if (!cta) return { ok: false, error: 'Hacen falta las iniciales.' };
  if (!/^[A-ZÁÉÍÓÚÑ]{2,4}$/.test(cta)) return { ok: false, error: 'Iniciales no válidas: ' + cta + ' (2 a 4 letras).' };
  if (!nombre) return { ok: false, error: 'Hace falta el nombre.' };
  var rol = String(datos.rol || 'CTA').trim().toUpperCase();
  if (!_rolValido(rol)) return { ok: false, error: 'Perfil no válido: ' + rol + '.' };

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = _ss().getSheetByName('CONTROLADORES');
    if (!sh) return { ok: false, error: 'No existe la hoja CONTROLADORES.' };

    // Las iniciales solo tienen que ser únicas entre los ACTIVOS: son una
    // etiqueta, no la identidad. Si las tuvo alguien que ya cursó baja, quedan
    // libres y se le pueden dar a otro — con FILA e IDENTIDAD propias, así que
    // no hereda nada de lo que hizo el anterior.
    var activos = leerControladoresCache().filter(function (c) {
      return c.activo && String(c.cta).trim().toUpperCase() === cta;
    });
    if (activos.length) return { ok: false, error: 'Las iniciales ' + cta + ' ya son de ' + activos[0].nombre + '.' };

    var hoy = _fechaDeCelda(datos.desde) || new Date();
    sh.getRange(1, COLS_CTA.PUESTO, 1, CABECERA_CTA_EXTRA.length).setValues([CABECERA_CTA_EXTRA]);
    sh.appendRow([
      cta, nombre, String(datos.email || '').trim(),
      Utilities.getUuid().replace(/-/g, ''),   // token desde el principio
      'SÍ', rol, '', String(datos.grupo || '').trim(), 'SÍ', 'SÍ',
      'P-' + Utilities.getUuid().slice(0, 8),  // identidad, para siempre
      _fechaTexto(hoy), ''
    ]);
    invalidarCacheControladores();
    // El puesto va por CARGOS_CTA, que es donde vive con sus fechas.
    if (datos.puesto) altaCargo(token, cta, datos.puesto, datos.desde || '', 'Alta de controlador');
    _logApp('INFO', 'crearControlador', cta + ' · ' + nombre + (datos.puesto ? ' · ' + datos.puesto : ''), u.cta);
    return { ok: true, cta: cta };
  } finally { lock.releaseLock(); }
}

// Solo toca los campos que vengan. Las iniciales y el token no se tocan nunca.
function actualizarControlador(token, cta, campos) {
  var u = _exigirVista(token, 'config.gente');
  campos = campos || {};
  var sh = _ss().getSheetByName('CONTROLADORES');
  var fila = sh ? _filaDeControlador(sh, cta) : 0;
  if (!fila) return { ok: false, error: 'No encuentro a ' + cta + '.' };
  if (campos.rol && !_rolValido(campos.rol)) {
    return { ok: false, error: 'Perfil no válido: ' + campos.rol + '.' };
  }
  var mapa = {
    nombre: COLS_CTA.NOMBRE, email: COLS_CTA.EMAIL, rol: COLS_CTA.ROL,
    grupo: COLS_CTA.GRUPO, activoExtras: COLS_CTA.EXTRAS, activoVacas: COLS_CTA.VACAS
  };
  var tocados = [];
  for (var k in mapa) {
    if (campos[k] === undefined) continue;
    var v = campos[k];
    if (k === 'activoExtras' || k === 'activoVacas') v = _sn(!!v);
    else if (k === 'rol') v = String(v).trim().toUpperCase();
    else v = String(v).trim();
    sh.getRange(fila, mapa[k]).setValue(v);
    tocados.push(k);
  }
  if (!tocados.length) return { ok: false, error: 'Nada que cambiar.' };
  invalidarCacheControladores();
  _logApp('INFO', 'actualizarControlador', cta + ' · ' + tocados.join(', '), u.cta);
  return { ok: true, cta: cta, campos: tocados };
}

// Baja: pierde el acceso y se le cierra el cargo vigente, pero la fila se queda.
function bajaControlador(token, cta, fecha) {
  var u = _exigirVista(token, 'config.gente');
  var sh = _ss().getSheetByName('CONTROLADORES');
  var fila = sh ? _filaDeControlador(sh, cta) : 0;
  if (!fila) return { ok: false, error: 'No encuentro a ' + cta + '.' };
  var f = _fechaDeCelda(fecha) || new Date();
  sh.getRange(fila, COLS_CTA.ACTIVO).setValue('NO');
  // Acota hasta cuándo fueron suyas esas iniciales: a partir de aquí quedan
  // libres, y un registro anterior sigue apuntando a él y no a quien venga.
  sh.getRange(fila, COLS_CTA.BAJA).setValue(_fechaTexto(f));
  invalidarCacheControladores();

  var cerrados = 0;
  leerCargos().forEach(function (c) {
    if (_mismaCta(c.cta, cta) && !c.hasta) {
      hojaCargos().getRange(c.fila, 4).setValue(_fechaTexto(f));
      cerrados++;
    }
  });
  invalidarCacheCargos();
  _logApp('INFO', 'bajaControlador', cta + ' dado de baja el ' + _fechaTexto(f) + ' · ' + cerrados + ' cargos cerrados', u.cta);
  return { ok: true, cta: cta, cargosCerrados: cerrados };
}

function reactivarControlador(token, cta) {
  var u = _exigirVista(token, 'config.gente');
  var sh = _ss().getSheetByName('CONTROLADORES');
  var fila = sh ? _filaDeControlador(sh, cta) : 0;
  if (!fila) return { ok: false, error: 'No encuentro a ' + cta + '.' };
  sh.getRange(fila, COLS_CTA.ACTIVO).setValue('SÍ');
  invalidarCacheControladores();
  _logApp('INFO', 'reactivarControlador', cta, u.cta);
  return { ok: true, cta: cta };
}

// ─── Plantilla del correo de invitación ─────────────────────────────────────
// Editable desde el panel. Marcas: {{nombre}} {{cta}} {{enlace}}.
var PLANTILLA_INVITACION_DEFECTO = [
  'Hola {{nombre}},',
  '',
  'Ya puedes entrar en la aplicación de cambios de turno con tu enlace personal:',
  '',
  '{{enlace}}',
  '',
  'Ese enlace lleva tu identificación dentro, así que no lo compartas: quien lo tenga entra como tú.',
  'Guárdalo en favoritos y úsalo siempre para entrar.',
  '',
  'Si crees que alguien más lo tiene, avisa a jefatura para que se te genere uno nuevo.'
].join('\n');

function getPlantillaInvitacion(token) {
  _exigirVista(token, 'config.gente');
  var t = '';
  try { t = PropertiesService.getScriptProperties().getProperty('PLANTILLA_INVITACION') || ''; } catch (e) {}
  return {
    ok: true, texto: t || PLANTILLA_INVITACION_DEFECTO,
    personalizada: !!t, defecto: PLANTILLA_INVITACION_DEFECTO,
    marcas: ['{{nombre}}', '{{cta}}', '{{enlace}}']
  };
}

function setPlantillaInvitacion(token, texto) {
  var u = _exigirVista(token, 'config.gente');
  texto = String(texto == null ? '' : texto);
  var props = PropertiesService.getScriptProperties();
  if (!texto.trim()) { props.deleteProperty('PLANTILLA_INVITACION'); _logApp('INFO', 'setPlantilla', 'restaurada la de fábrica', u.cta); return { ok: true, texto: PLANTILLA_INVITACION_DEFECTO, personalizada: false }; }
  if (texto.indexOf('{{enlace}}') === -1) {
    return { ok: false, error: 'La plantilla debe incluir {{enlace}}: sin él, el correo no sirve de nada.' };
  }
  if (texto.length > 8000) return { ok: false, error: 'Demasiado larga.' };
  props.setProperty('PLANTILLA_INVITACION', texto);
  _logApp('INFO', 'setPlantilla', texto.length + ' caracteres', u.cta);
  return { ok: true, texto: texto, personalizada: true };
}

function _cuerpoInvitacion(nombre, cta, enlace) {
  var t = getPlantillaInvitacion_(  );
  return t
    .split('{{nombre}}').join(nombre || cta)
    .split('{{cta}}').join(cta)
    .split('{{enlace}}').join(enlace);
}
function getPlantillaInvitacion_() {
  try {
    var t = PropertiesService.getScriptProperties().getProperty('PLANTILLA_INVITACION');
    if (t) return t;
  } catch (e) {}
  return PLANTILLA_INVITACION_DEFECTO;
}

// Texto plano a HTML sencillo: párrafos por línea y el enlace clicable.
function _htmlDeTexto(txt) {
  return txt.split('\n').map(function (l) {
    var e = String(l)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    e = e.replace(/(https:\/\/[^\s]+)/g, '<a href="$1">$1</a>');
    return l.trim() ? '<p style="margin:0 0 8px">' + e + '</p>' : '<div style="height:6px"></div>';
  }).join('');
}

// ─── Invitar a un controlador ───────────────────────────────────────────────
// Genera el token si no lo tiene y le manda su enlace personal. Devuelve
// siempre el enlace, para poder pasarlo a mano si el correo falla.
function invitarControlador(token, cta, soloEnlace) {
  var u = _exigirVista(token, 'config.gente');
  cta = String(cta || '').trim().toUpperCase();
  var sh = _ss().getSheetByName('CONTROLADORES');
  if (!sh || sh.getLastRow() < 2) return { ok: false, error: 'CONTROLADORES está vacía.' };

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var n = sh.getLastRow() - 1;
    var val = sh.getRange(2, 1, n, 6).getValues();
    var fila = -1;
    for (var i = 0; i < val.length; i++) {
      if (String(val[i][0]).trim().toUpperCase() === cta) { fila = i + 2; break; }
    }
    if (fila < 0) return { ok: false, error: 'No encuentro a ' + cta + ' en CONTROLADORES.' };

    var nombre = String(val[fila - 2][1] || '').trim();
    var email = String(val[fila - 2][2] || '').trim();
    var tok = String(val[fila - 2][3] || '').trim();
    if (!tok) {
      tok = Utilities.getUuid().replace(/-/g, '');
      sh.getRange(fila, 4).setValue(tok);
      invalidarCacheControladores();
      _logApp('INFO', 'invitar', 'token generado para ' + cta, u.cta);
    }
    var enlace = _urlApp() + '?token=' + tok;
    if (soloEnlace) return { ok: true, cta: cta, enlace: enlace, enviado: false };
    if (!email) return { ok: false, error: cta + ' no tiene correo en CONTROLADORES.', enlace: enlace };

    var cuerpo = _cuerpoInvitacion(nombre, cta, enlace);
    MailApp.sendEmail({
      to: email,
      subject: 'Tu acceso a Cambios de turno GCXO',
      body: cuerpo,
      htmlBody: _htmlDeTexto(cuerpo)
    });
    _logApp('INFO', 'invitar', cta + ' invitado a ' + email, u.cta);
    return { ok: true, cta: cta, enlace: enlace, enviado: true, email: email };
  } finally { lock.releaseLock(); }
}
function _notificarParticipantes(solicitante, mes, movimientos, pendientes, id) {
  var emails = ctaAEmail();
  var resumen = resumirCambio(movimientos);
  pendientes.forEach(function (p) {
    var email = emails[p.cta];
    if (!email) return;
    var link = _urlApp() + '?token=' + _tokenDe(p.cta);
    MailApp.sendEmail({
      to: email,
      subject: 'Cambio de turno pendiente de tu confirmación (' + mes + ')',
      htmlBody: 'Hola ' + p.cta + ',<br><br>' + solicitante.cta +
        ' ha registrado un cambio que te afecta:<br><b>' + resumen + '</b><br><br>' +
        'Entra a confirmarlo o rechazarlo aquí:<br><a href="' + link + '">Abrir la aplicación</a>' +
        '<br><br>(Referencia ' + id + ')'
    });
  });
}
function _notificarSolicitante(cambio, ctaQueResponde, acepta, nuevoEstado) {
  var emails = ctaAEmail();
  var email = emails[cambio.solicitante];
  if (!email) return;
  MailApp.sendEmail({
    to: email,
    subject: 'Tu cambio ' + cambio.id + ': ' + (acepta ? 'confirmado' : 'rechazado') + ' por ' + ctaQueResponde,
    htmlBody: 'El estado de tu cambio ' + cambio.id + ' es ahora: <b>' + nuevoEstado + '</b>.'
  });
}
function _tokenDe(cta) {
  var c = leerControladores().filter(function (x) { return x.cta === cta; });
  return c.length ? c[0].token : '';
}

// ═══════════════════════════════════════════════════════════════════════════
// LOG UNIFICADO DEL TURNERO — una fila por celda tocada, con el valor PREVIO
// ═══════════════════════════════════════════════════════════════════════════
// Toda escritura en el turnero (acción de admin o cambio validado) pasa por
// _aplicarTurnoCelda y deja aquí una fila con lo que HABÍA y lo que se puso.
// Guardar el valor previo es lo que hace posible deshacer: revertir la celda
// (controlador, día) a su valor anterior, sin adivinar ni reconstruir nada.
//
// El valor previo se lee de la CELDA EN CRUDO, no de la matriz de leerMes():
// esa normaliza ('V' va a vacaciones, los códigos se canonizan) y perdería el
// texto exacto que había escrito.
//
// TRANSICIÓN: LOG_DIAS y LOG_CAMBIOS se siguen escribiendo igual que antes.
// Las pestañas-resumen (EXTRAS/VOLUNTARIOS/DESPROGRAMACIONES, LISTA DE
// ASIGNACIÓN) leen de ellas con fórmulas, y jubilarlas exige adaptarlas
// primero. Este log es ya el unificado; la retirada de los viejos es el paso
// siguiente, cuando se hayan revisado esas fórmulas.
var HOJA_LOG_CELDAS = 'LOG_CELDAS';
// «Fondo previo» es tan parte del valor de la celda como el turno: el color
// dice si esa M es una extra, una voluntaria o una imaginaria activada, así que
// sin guardarlo no se puede deshacer de verdad — se devolvía el código y la
// celda se quedaba con el color de la acción deshecha.
var CABECERA_LOG_CELDAS = [
  'ID', 'Fecha/hora', 'Mes', 'Día', 'Fecha', 'CTA', 'Turno previo', 'Turno nuevo',
  'Tipo', 'Origen', 'Ref', 'Motivo', 'Autor', 'Deshecho por', 'ID persona', 'Fondo previo'
];
var LT = {
  ID: 1, TS: 2, MES: 3, DIA: 4, FECHA: 5, CTA: 6, PREVIO: 7, NUEVO: 8,
  TIPO: 9, ORIGEN: 10, REF: 11, MOTIVO: 12, AUTOR: 13, DESHECHO: 14, IDCTA: 15,
  FONDO: 16
};

function _hojaLogCeldas() {
  var sh = _ss().getSheetByName(HOJA_LOG_CELDAS);
  if (!sh) {
    sh = _ss().insertSheet(HOJA_LOG_CELDAS);
    sh.appendRow(CABECERA_LOG_CELDAS);
    sh.getRange(1, LT.MES, sh.getMaxRows(), 1).setNumberFormat('@'); // "JUL-26" como TEXTO
    return sh;
  }
  // Cabecera de una versión anterior: se completa sin tocar las filas, que
  // simplemente traerán vacío en las columnas nuevas.
  if (sh.getLastColumn() < CABECERA_LOG_CELDAS.length) {
    sh.getRange(1, 1, 1, CABECERA_LOG_CELDAS.length).setValues([CABECERA_LOG_CELDAS]);
  }
  return sh;
}

// Valor de una celda tal cual, sin normalizar y sin Date suelto hacia el cliente.
function _txtCelda(v) {
  if (v instanceof Date) return _fechaIso(v);
  return String(v == null ? '' : v).trim();
}

// Fecha real del día del turnero, en dd/MM/yyyy, para que el log unificado se
// pueda filtrar por año igual que LOG_DIAS.
function _fechaDeDia(mes, dia) {
  var p = String(mes).split('-');
  var mesIdx = MES3.indexOf((p[0] || '').toUpperCase().slice(0, 3));
  if (mesIdx < 0) return '';
  var d = new Date(2000 + parseInt(p[1], 10), mesIdx, Number(dia));
  return ('0' + d.getDate()).slice(-2) + '/' + ('0' + (d.getMonth() + 1)).slice(-2) + '/' + d.getFullYear();
}

function _leerLogCeldas() {
  var sh = _hojaLogCeldas();
  if (sh.getLastRow() < 2) return [];
  var val = sh.getRange(2, 1, sh.getLastRow() - 1, CABECERA_LOG_CELDAS.length).getValues();
  return val.map(function (r, i) {
    return {
      fila: i + 2,
      id: Number(r[LT.ID - 1]) || 0,
      ts: _fechaIso(r[LT.TS - 1]),
      mes: _mesCanon(r[LT.MES - 1]),
      dia: Number(r[LT.DIA - 1]),
      fecha: _txtCelda(r[LT.FECHA - 1]),
      cta: String(r[LT.CTA - 1] || '').trim().toUpperCase(),
      previo: _txtCelda(r[LT.PREVIO - 1]),
      nuevo: _txtCelda(r[LT.NUEVO - 1]),
      tipo: String(r[LT.TIPO - 1] || '').trim(),
      origen: String(r[LT.ORIGEN - 1] || '').trim(),
      ref: _txtCelda(r[LT.REF - 1]),
      motivo: _txtCelda(r[LT.MOTIVO - 1]),
      autor: String(r[LT.AUTOR - 1] || '').trim().toUpperCase(),
      deshecho: _txtCelda(r[LT.DESHECHO - 1]),
      idCta: String(r[LT.IDCTA - 1] || '').trim(),
      fondoPrevio: String(r[LT.FONDO - 1] || '').trim().toLowerCase()
    };
  });
}

function _registrarLogCelda(ent) {
  var sh = _hojaLogCeldas();
  var id = sh.getLastRow(); // cabecera = fila 1, así que la 1ª entrada es la id 1
  sh.appendRow([
    id, new Date(), _mesCanon(ent.mes), Number(ent.dia), _fechaDeDia(ent.mes, ent.dia),
    String(ent.cta).trim().toUpperCase(), ent.previo, ent.nuevo,
    ent.tipo || '', ent.origen || '', ent.ref || '', ent.motivo || '',
    String(ent.autor || '').trim().toUpperCase(), '',
    _idDe(ent.cta),    // de quién es esta celda, pase lo que pase con las iniciales
    ent.fondoPrevio || ''
  ]);
  return id;
}

// ÚNICO punto de escritura del turnero: lee lo que había, escribe lo nuevo y
// deja la traza. Devuelve el id de la entrada, o null si la celda no existe.
function _aplicarTurnoCelda(shMes, m, mes, cta, dia, nuevo, meta) {
  var fila = m.filaDeCta[cta], col = m.diaACol[dia];
  if (!fila || !col) return null;
  var celda = shMes.getRange(fila, col);
  var previo = _txtCelda(celda.getValue());
  // El fondo se guarda ANTES de tocar nada: es la mitad del valor de la celda.
  var fondoPrevio = '';
  try { fondoPrevio = String(celda.getBackground() || '').toLowerCase(); } catch (e) {}
  var valor = (String(nuevo).toLowerCase() === 'libre') ? '' : nuevo;
  celda.setValue(valor);
  meta = meta || {};

  // `meta.fondo` pinta un color concreto (lo usa deshacer, para devolver el que
  // había). `meta.marca` pinta el de esa marca según la paleta guardada.
  // Ninguno de los dos = no se toca el fondo.
  var hex = '';
  if (typeof meta.fondo === 'string') hex = meta.fondo || '#ffffff';
  else if (meta.marca !== undefined) hex = paletaGuardada()[meta.marca] || fondoDeMarca(meta.marca);
  if (hex) {
    try { celda.setBackground(hex); }
    catch (e2) { _logApp('WARN', '_aplicarTurnoCelda', 'no se pudo pintar el fondo: ' + e2); }
  }

  return _registrarLogCelda({
    mes: mes, dia: dia, cta: cta, previo: previo, nuevo: _txtCelda(valor),
    tipo: meta.tipo, origen: meta.origen, ref: meta.ref, motivo: meta.motivo, autor: meta.autor,
    fondoPrevio: fondoPrevio
  });
}

// El turno que tenía la celda ANTES de que la app la tocara por primera vez:
// el `previo` de la entrada más antigua de LOG_CELDAS para esa celda. Devuelve
// `null` si nunca se tocó desde la app —y solo entonces—, porque la cadena
// vacía es un valor legítimo: el día se libraba y la app le metió algo.
//
// ⚠️ Esto es lo que hace bien «Restablecer al turno base». Antes se acababa
// leyendo la REJILLA ACTUAL, que ya lleva el cambio, así que restablecer
// devolvía el turno a sí mismo: tras activar una imaginaria el historial
// anotaba «M → M» en vez de «M → im». LOG_CAMBIOS no servía porque solo
// recoge intercambios, no las acciones de admin.
function _turnoBaseSegunLog(mes, cta, dia) {
  var h = _leerLogCeldas().filter(function (l) {
    return _mesKey(l.mes) === _mesKey(mes) && Number(l.dia) === Number(dia) && _mismaCta(l.cta, cta) &&
           l.origen !== ORIGEN_IMPORTADO;   // ver `migrarLogDias`: no traen previo
  });
  return h.length ? String(h[0].previo == null ? '' : h[0].previo).trim() : null;
}

// Historial de una celda (controlador, día), lo más reciente primero.
function getLogDia(token, mes, cta, dia) {
  _exigirUsuario(token);
  var mk = _mesKey(mes);
  dia = Number(dia);
  var out = _leerLogCeldas().filter(function (l) {
    return _mesKey(l.mes) === mk && l.dia === dia && _mismaCta(l.cta, cta);
  });
  out.reverse();
  return { ok: true, mes: _mesCanon(mes), cta: String(cta).trim().toUpperCase(), dia: dia, entradas: out };
}

// Deshacer = devolver la celda al valor previo de la última entrada viva de esa
// celda. No borra historia: marca la entrada como deshecha y añade otra entrada
// que documenta la reversión, de modo que el log siga siendo una cadena legible.
function deshacerDia(token, mes, cta, dia) {
  var u = _exigirVista(token, 'gestion.rapido');
  if (_mesEsPasado(mes)) return { ok: false, error: 'Ese mes ya pasó: no admite cambios.' };
  dia = Number(dia);
  var mk = _mesKey(mes);

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var vivas = _leerLogCeldas().filter(function (l) {
      // ⚠️ Las IMPORTADAS no se deshacen: vienen de LOG_DIAS, que nunca guardó
      // el valor previo, así que «deshacer» dejaría la celda en blanco creyendo
      // que ese día se libraba. Cuentan para los acumulados y nada más.
      return _mesKey(l.mes) === mk && l.dia === dia && _mismaCta(l.cta, cta) && !l.deshecho &&
             l.origen !== 'DESHACER' && l.origen !== ORIGEN_IMPORTADO;
    });
    if (!vivas.length) return { ok: false, error: 'No hay nada que deshacer en el día ' + dia + ' de ' + cta + '.' };
    var ent = vivas[vivas.length - 1];

    var m = leerMes(mes); // fresco: la fila/columna han de ser las de ahora
    var shMes = _ss().getSheetByName(mes);
    if (!shMes) return { ok: false, error: 'No existe la hoja del mes ' + mes + '.' };
    if (!m.filaDeCta[cta] || !m.diaACol[dia]) {
      return { ok: false, error: 'No se encuentra la celda de ' + cta + ' el día ' + dia + ' en ' + mes + '.' };
    }

    // Revertir escribiendo por el mismo camino: la reversión también queda logueada.
    // El fondo que tenía antes de aquella acción. Si la entrada es de antes de
    // que se guardara (columna nueva), se deduce: si aquella acción pintaba
    // algo, deshacerla deja la celda en blanco.
    var fondoVuelta = ent.fondoPrevio;
    if (!fondoVuelta) {
      var marcaDeAquella = MARCA_DE_TIPO[String(ent.tipo || '').trim().toUpperCase()];
      fondoVuelta = (marcaDeAquella !== undefined) ? '#ffffff' : null;
    }
    var idNuevo = _aplicarTurnoCelda(shMes, m, mes, cta, dia, ent.previo, {
      tipo: 'DESHACER', origen: 'DESHACER', ref: String(ent.id),
      fondo: (typeof fondoVuelta === 'string') ? fondoVuelta : undefined,
      motivo: 'Deshecha la entrada #' + ent.id + ' (' + (ent.previo || 'libre') + ' → ' + (ent.nuevo || 'libre') + ')',
      autor: u.cta
    });

    // Marcar la entrada deshecha para que no se pueda deshacer dos veces.
    _hojaLogCeldas().getRange(ent.fila, LT.DESHECHO).setValue(u.cta + ' · ' + new Date().toISOString());

    invalidarCacheMes(mes);
    _logApp('INFO', 'deshacerDia', _mesCanon(mes) + ' d' + dia + ' ' + cta + ': ' +
      (ent.nuevo || 'libre') + ' → ' + (ent.previo || 'libre') + ' (deshecha #' + ent.id + ')', u.cta);
    return {
      ok: true, id: idNuevo, deshecha: ent.id,
      cta: String(cta).trim().toUpperCase(), dia: dia,
      turno: ent.previo, anterior: ent.nuevo
    };
  } finally {
    lock.releaseLock();
  }
}

// ─── Log de transcripción ───────────────────────────────────────────────────
function _log(cambio, adminCta, revOk) {
  var sh = _ss().getSheetByName(HOJA_LOG) || _ss().insertSheet(HOJA_LOG);
  if (sh.getLastRow() === 0) {
    sh.appendRow(['ID cambio', 'Mes', 'Tipo', 'Movimientos', 'Solicitante',
      'Validado por', 'Transcrito por', 'Revalidación OK', 'Fecha/hora']);
  }
  sh.appendRow([cambio.id, cambio.mes, cambio.tipo, resumirCambio(cambio.movimientos),
    cambio.solicitante, cambio.validadoPor, adminCta, revOk ? 'SÍ' : 'CON AVISOS', new Date()]);
}

// ─── Meses: orden y filtrado (acepta "JUL-26" y "JULIO-26") ─────────────────
var MES3 = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];

// Índice absoluto anio*12+mes a partir del nombre de pestaña. -1 si no parsea.
function _indiceDeMes(nombre) {
  var p = String(nombre).split('-');
  if (p.length < 2) return -1;
  var mi = MES3.indexOf(p[0].trim().toUpperCase().slice(0, 3));
  var anio = 2000 + parseInt(p[1], 10);
  if (mi === -1 || isNaN(anio)) return -1;
  return anio * 12 + mi;
}
function _indiceMesActual() { var d = new Date(); return d.getFullYear() * 12 + d.getMonth(); }
function _mesEsPasado(nombre) { var i = _indiceDeMes(nombre); return i !== -1 && i < _indiceMesActual(); }

// Meses vigentes (actual y futuros), ordenados cronológicamente.
function _mesesVigentes() {
  return listarMeses()
    .filter(function (n) { return _indiceDeMes(n) !== -1 && !_mesEsPasado(n); })
    .sort(function (a, b) { return _indiceDeMes(a) - _indiceDeMes(b); });
}
// Mes por defecto: el actual si está, si no el primero vigente.
function _mesActualVigente(meses) {
  var act = _indiceMesActual();
  for (var i = 0; i < meses.length; i++) if (_indiceDeMes(meses[i]) === act) return meses[i];
  return meses.length ? meses[0] : null;
}



// Turno tal y como se escribe en la nota: el hueco se nombra "libre".
function _turnoEnNota(t) {
  var s = String(t == null ? '' : t).trim();
  return (s === '' || s.toLowerCase() === 'libre') ? 'libre' : s;
}

// Nota única del bloque:  "SYS: [REG] DG d4 Ms→M | DI d5 M→Ms"
// [REG] = iniciales de quien registra; el resto, el resumen del bloque entero.
// Es la MISMA para todas las celdas que toca el bloque: cada celda queda así
// con la traza completa del cambio, no solo con su pata.
// Cada pata lleva SU día (dN): en una cadena multi-día la nota se pega en
// celdas de días distintos, y sin el día no habría forma de saber a qué día
// corresponde cada pata.
function _notaSys(movimientos, registradorCta) {
  var reg = String(registradorCta || '').trim().toUpperCase() || 'XX';
  var resumen = movimientos.map(function (mv) {
    return mv.cta + ' d' + mv.dia + ' ' + _turnoEnNota(mv.de) + '→' + _turnoEnNota(mv.a);
  }).join(' | ');
  return 'SYS: [' + reg + '] ' + resumen;
}

function _aplicarMovimientosAlTurnero(mes, movimientos, registradorCta, ref) {
  var m = leerMes(mes);
  var sh = _ss().getSheetByName(mes);
  var nuevaNota = _notaSys(movimientos, registradorCta);
  var resumen = _notaSys(movimientos, registradorCta).replace(/^SYS: /, '');

  movimientos.forEach(function (mv) {
    var fila = m.filaDeCta[mv.cta];
    var col = m.diaACol[mv.dia];
    if (!fila || !col) return; // el cta o el día no están en la hoja: se omite

    // 1. El turno, por el punto único de escritura: deja en LOG_CELDAS lo que
    //    había y lo que se pone, que es lo que permite deshacerlo después.
    _aplicarTurnoCelda(sh, m, mes, mv.cta, mv.dia, mv.a, {
      tipo: 'CAMBIO', origen: 'CAMBIO', ref: ref || '', motivo: resumen, autor: registradorCta
    });

    // 2. La nota: se AÑADE a lo que ya hubiera, nunca reemplaza (la celda puede
    //    llevar anotaciones previas —de un cambio anterior o del planificador—
    //    y perderlas sería perder historia).
    var celda = sh.getRange(fila, col);
    var nota = celda.getNote() || '';
    celda.setNote(nota ? nota + '\n' + nuevaNota : nuevaNota);
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   PARÁMETROS DE CÓMPUTO  —  «Admin: Parámetros»

   Las cifras del convenio (170 h, las ventanas del horario operativo, la
   prolongación del art. 47.7, la imaginaria del 45.1, los suplementos de
   relevo del 47.9/47.10) NO viven en el código: viven en properties.

   `PARAMETROS_SEMILLA`, en el motor, es exactamente eso — una semilla. Se
   vuelca ENTERA a properties la primera vez que alguien entra y a partir de
   ahí manda properties y solo properties. Es el mismo trato que la hoja
   PUESTOS: el motor trae `PUESTOS_DEFECTO` para poder sembrarla, no para
   decidir con ella.

   Se guardan TODAS las claves, no solo las que difieren, para que no haya dos
   sitios donde mirar. El precio es que al añadir un parámetro nuevo hay que
   sembrarlo: `_sembrarParametros` rellena las claves que falten sin tocar las
   que ya están, así que eso se resuelve solo en la primera petición.

   Properties y no una hoja: son dos docenas de números que cambian con el
   convenio, no datos de negocio que nadie vaya a cruzar con fórmulas.
   ═══════════════════════════════════════════════════════════════════════════ */

var _PARAMS_KEY = 'PARAMETROS_COMPUTO';

// Los grupos, las etiquetas y las ayudas viven aquí y no en el cliente: el
// panel se pinta a partir de lo que el servidor declara, así que añadir un
// parámetro no obliga a tocar el HTML.
//   tipo 'hora' → se edita como HH:MM y se guarda en minutos desde medianoche
var PARAMETROS_META = [
  { grupo: 'Límites de jornada', norma: 'RD 1001/2010 · convenio art. 29', campos: [
    { id: 'maxHorasMes',           etiqueta: 'Máximo de horas al mes',         unidad: 'h',    ayuda: 'Cota del convenio 2023. El RD permite 200, pero manda la más estricta.' },
    { id: 'maxHorasCiclo',         etiqueta: 'Máximo de horas por ciclo',      unidad: 'h',    ayuda: 'RD 1001/2010, art. 5.' },
    { id: 'maxPeriodosCiclo',      etiqueta: 'Periodos seguidos por ciclo',    unidad: 'días', ayuda: 'Días de servicio consecutivos antes del descanso largo.' },
    { id: 'maxJornada',            etiqueta: 'Duración máxima de una jornada', unidad: 'h',    ayuda: '' },
    { id: 'descansoEntreJornadas', etiqueta: 'Descanso entre jornadas',        unidad: 'h',    ayuda: 'Mínimo entre el fin de un servicio y el comienzo del siguiente.' },
    { id: 'descansoPostCicloFull', etiqueta: 'Descanso tras ciclo completo',   unidad: 'h',    ayuda: '' },
    { id: 'descansoPostCicloRed',  etiqueta: 'Descanso tras ciclo reducido',   unidad: 'h',    ayuda: 'Art. 6.3 del RD.' }
  ]},
  { grupo: 'Ventanas del horario operativo', norma: 'horario de la dependencia', ventanas: true, campos: [
    { id: 'inicioManana',   etiqueta: 'Mañana — entrada',   tipo: 'hora', ayuda: 'Afecta a M, Ms, Mo, mr y Fm. Y arrastra la ventana de la imaginaria de mañana. EvM tiene la suya.' },
    { id: 'finManana',      etiqueta: 'Mañana — salida',    tipo: 'hora', ayuda: '' },
    { id: 'inicioTarde',    etiqueta: 'Tarde — entrada',    tipo: 'hora', ayuda: 'Afecta a T, Ts, To, tr y Ft. Y a la imaginaria de tarde. EvT tiene la suya.' },
    { id: 'finTarde',       etiqueta: 'Tarde — salida',     tipo: 'hora', ayuda: 'Sin contar la prolongación, que se suma aparte.' },
    { id: 'inicioEvalManana', etiqueta: 'Evaluación de mañana — entrada', tipo: 'hora', ayuda: 'EvM va aparte de la mañana normal: hoy coinciden, pero una evaluación no tiene por qué durar lo mismo.' },
    { id: 'finEvalManana',    etiqueta: 'Evaluación de mañana — salida',  tipo: 'hora', ayuda: '' },
    { id: 'inicioEvalTarde',  etiqueta: 'Evaluación de tarde — entrada',  tipo: 'hora', ayuda: 'EvT, igual. Sigue llevando la prolongación: cierra la dependencia como cualquier tarde.' },
    { id: 'finEvalTarde',     etiqueta: 'Evaluación de tarde — salida',   tipo: 'hora', ayuda: '' },
    { id: 'inicioDespacho', etiqueta: 'Despacho — entrada', tipo: 'hora', ayuda: 'Afecta a D y SIM. Las reducciones de jornada mr y tr NO van aquí: son la mañana y la tarde normales de quien tiene la jornada reducida.' },
    { id: 'finDespacho',    etiqueta: 'Despacho — salida',  tipo: 'hora', ayuda: '' },
    { id: 'inicioCurso',    etiqueta: 'Curso — entrada',    tipo: 'hora', ayuda: 'Afecta a C.' },
    { id: 'finCurso',       etiqueta: 'Curso — salida',     tipo: 'hora', ayuda: '' }
  ]},
  { grupo: 'Ventana de la imaginaria', norma: 'convenio art. 37.1.1', campos: [
    { id: 'imaginariaAntes',   etiqueta: 'Antes de la entrada',   unidad: 'min', ayuda: '«Desde una hora antes…». Se cuenta sobre la entrada del turno que acompaña, así que si mueves la mañana, la imaginaria se mueve sola.' },
    { id: 'imaginariaDespues', etiqueta: 'Después de la entrada', unidad: 'min', ayuda: '«…hasta media hora después de la hora de entrada».' }
  ]},
  { grupo: 'Prolongación del horario operativo', norma: 'convenio art. 47.7.a', campos: [
    { id: 'prolongacionBase',      etiqueta: 'Si NO se efectúa', unidad: 'min', ayuda: 'GCXO no es H24: la tarde computa esto siempre, se prolongue o no.' },
    { id: 'prolongacionEfectuada', etiqueta: 'Si se efectúa',    unidad: 'min', ayuda: 'El período publicado en AIP. En GCXO, una hora. Hoy no se registra cuándo ocurre, así que el motor computa la base.' }
  ]},
  { grupo: 'Cómputo de la imaginaria', norma: 'convenio art. 45.1', campos: [
    { id: 'imaginariaSinActivar', etiqueta: 'Sin activar',          unidad: 'min', ayuda: 'Hoy coincide con la ventana de localización, pero va suelto: el art. 45.1 habla del 20 % de la duración del servicio «o el tiempo a disposición, lo que sea superior».' },
    { id: 'imaginariaHoraPrevia', etiqueta: 'Añadido al activarse', unidad: 'min', ayuda: 'Activada computa el servicio entero MÁS esto, que es la hora previa localizable.' }
  ]},
  { grupo: 'Suplementos de relevo', norma: 'convenio arts. 47.9 y 47.10', campos: [
    { id: 'relevoEntradaTarde',   etiqueta: 'Entrada de tarde',           unidad: 'min', pendiente: true, ayuda: 'Art. 47.9: 5 min al CTA que entra de tarde en dependencia no H24. La mañana no lleva: abre la dependencia y no releva a nadie.' },
    { id: 'briefingInstruccion',  etiqueta: 'Instrucción y evaluación',   unidad: 'min', pendiente: true, ayuda: 'Art. 47.9: 15 min de briefing y debriefing por tareas OJTI o de evaluación. Afecta a Mo, To, EvM y EvT.' },
    { id: 'relevoDentroServicio', etiqueta: 'Relevos dentro del servicio',unidad: 'min', ayuda: 'Art. 47.10. GCXO es grupo 5, o sea el tramo «Grupos 4 a 7»: 3,5 min a cada CTA por servicio. Se aplica a todos los servicios de fanal; no a D, SIM, C ni a las reducciones.' }
  ]}
];

function _leerParametrosCrudo() {
  var raw = '';
  try { raw = PropertiesService.getScriptProperties().getProperty(_PARAMS_KEY) || ''; } catch (e) {}
  if (!raw) return null;
  try {
    var o = JSON.parse(raw);
    return (o && typeof o === 'object') ? o : null;
  } catch (e) {
    _logApp('WARN', 'parametros', 'JSON corrupto en properties; se resiembra desde la semilla');
    return null;
  }
}

// Deja properties con TODAS las claves. Las que ya estén no se tocan; las que
// falten se escriben desde la semilla. Devuelve las que ha tenido que crear,
// que en régimen normal es la lista vacía.
function _sembrarParametros() {
  var actual = _leerParametrosCrudo();
  var creadas = [], fin = {};
  for (var k in PARAMETROS_SEMILLA) {
    if (actual && Object.prototype.hasOwnProperty.call(actual, k) &&
        actual[k] !== null && actual[k] !== '' && !isNaN(Number(actual[k]))) {
      fin[k] = Number(actual[k]);
    } else {
      fin[k] = PARAMETROS_SEMILLA[k];
      creadas.push(k);
    }
  }
  if (creadas.length || !actual) {
    PropertiesService.getScriptProperties().setProperty(_PARAMS_KEY, JSON.stringify(fin));
    _logApp('INFO', 'parametros', 'sembradas ' + creadas.length + ' claves: ' + creadas.join(', '));
    // ⚠ Se anota en la ejecución porque `_exigirUsuario` siembra ANTES de que
    // `getParametros` llegue a mirar: para cuando el panel pregunta, ya no
    // queda nada por crear y la lista saldría siempre vacía. Cada ejecución de
    // Apps Script arranca limpia, así que esto no se arrastra entre peticiones.
    _SEMBRADAS_EN_ESTA_EJECUCION = creadas;
  }
  return { valores: fin, creadas: creadas };
}
var _SEMBRADAS_EN_ESTA_EJECUCION = [];

// Se llama en cada petición desde _exigirUsuario. No puede tirar la app: si
// algo va mal, el motor se queda con la semilla, que es lo que ya tiene.
function aplicarConfigParametros() {
  try { configurarParametros(_sembrarParametros().valores); }
  catch (e) { _logApp('WARN', 'aplicarConfigParametros', 'no se pudieron aplicar: ' + e); }
}

function getParametros(token) {
  _exigirVista(token, 'config.params');
  var s = _sembrarParametros();
  var valores = configurarParametros(s.valores);
  return {
    ok: true,
    meta: PARAMETROS_META,
    valores: valores,
    semilla: PARAMETROS_SEMILLA,
    horas: _idsDeHora(),
    recienSembradas: _SEMBRADAS_EN_ESTA_EJECUCION,
    computos: _fotoComputos()
  };
}

// Guarda el juego COMPLETO. Lo que no venga en la llamada conserva su valor
// actual; nada se queda sin escribir.
function setParametros(token, valores) {
  var u = _exigirVista(token, 'config.params');
  if (!valores || typeof valores !== 'object') return { ok: false, error: 'No has mandado nada que guardar.' };

  var vigentes = _sembrarParametros().valores;
  var fin = {}, tocados = 0;
  for (var k in PARAMETROS_SEMILLA) {
    if (!Object.prototype.hasOwnProperty.call(valores, k)) { fin[k] = vigentes[k]; continue; }
    var bruto = valores[k];
    if (bruto === null || bruto === undefined || bruto === '') {
      return { ok: false, error: 'Falta el valor de "' + _etiquetaDe(k) + '".' };
    }
    var v = _aNumero(bruto);
    if (isNaN(v) || !isFinite(v) || v < 0) {
      return { ok: false, error: '"' + _etiquetaDe(k) + '" no es un número válido: ' + bruto };
    }
    if (esCampoHora(k) && v > 1439) {
      return { ok: false, error: '"' + _etiquetaDe(k) + '" no es una hora del día.' };
    }
    fin[k] = v;
    if (v !== vigentes[k]) tocados++;
  }

  // Una ventana del revés daría duraciones negativas: el motor aprobaría
  // cualquier cosa. Se rechaza aquí, con nombre y apellidos, en vez de dejar
  // que el motor la descarte por lo callado.
  for (var i = 0; i < VENTANAS.length; i++) {
    var w = VENTANAS[i];
    if (fin[w.fin] <= fin[w.inicio]) {
      return { ok: false, error: 'La salida de "' + _etiquetaDe(w.fin) + '" tiene que ser posterior a la entrada.' };
    }
  }

  PropertiesService.getScriptProperties().setProperty(_PARAMS_KEY, JSON.stringify(fin));
  configurarParametros(fin);
  _logApp('INFO', 'setParametros', tocados + ' valores cambiados', u.cta);
  return { ok: true, valores: PARAMETROS, tocados: tocados, computos: _fotoComputos() };
}

// Vuelve a los valores del convenio. No borra la clave: la reescribe entera,
// porque properties sigue siendo el único sitio donde se mira.
function restaurarParametros(token) {
  var u = _exigirVista(token, 'config.params');
  PropertiesService.getScriptProperties().setProperty(_PARAMS_KEY, JSON.stringify(PARAMETROS_SEMILLA));
  configurarParametros(PARAMETROS_SEMILLA);
  _logApp('INFO', 'restaurarParametros', 'vuelta a la semilla', u.cta);
  return { ok: true, valores: PARAMETROS, computos: _fotoComputos() };
}

// Aquí se escribe "3,5", no "3.5", y Number('3,5') es NaN.
function _aNumero(x) {
  if (typeof x === 'number') return x;
  return Number(String(x).trim().replace(',', '.'));
}

function _idsDeHora() {
  var ids = [];
  for (var i = 0; i < VENTANAS.length; i++) ids.push(VENTANAS[i].inicio, VENTANAS[i].fin);
  return ids;
}

function _etiquetaDe(id) {
  for (var i = 0; i < PARAMETROS_META.length; i++) {
    var cs = PARAMETROS_META[i].campos;
    for (var j = 0; j < cs.length; j++) if (cs[j].id === id) return cs[j].etiqueta;
  }
  return id;
}

// Lo que computa cada turno con los parámetros vigentes, para enseñarlo en el
// panel y que el admin vea el efecto sin echar la cuenta de cabeza.
function _fotoComputos() {
  var orden = ['M', 'Ms', 'Mo', 'EvM', 'T', 'Ts', 'To', 'EvT', 'im', 'it', 'D', 'C'];
  var extra = PARAMETROS.prolongacionEfectuada - PARAMETROS.prolongacionBase;
  return orden.map(function (c) {
    var d = CONFIG_TURNOS[c];
    if (!d) return null;
    return {
      codigo: c,
      inicio: d.inicio, fin: d.fin,
      minutos: d.computo,
      minutosMax: d.computoMax || null,
      conPPR: d.prolongable ? d.computo + extra : null
    };
  }).filter(function (x) { return x; });
}

/* ═══════════════════════════════════════════════════════════════════════════
   PERMISOS DE VISTA  —  «Configuración → Permisos»

   Qué pestañas ve cada perfil. Mismo patrón que los parámetros: el catálogo
   y la semilla viven aquí, lo que manda está en properties.

   ⚠️ LA VISTA **ES** EL PERMISO. Cada función de la API exige la vista desde
   la que se usa (`_exigirVista`), así que conceder «Incidencias» concede de
   verdad tocar el turnero de otro, y quitarla lo quita. No es una capa de
   visibilidad sobre otra de seguridad: es la misma.

   Esto era al revés hasta el 2026-08-16 —`_exigirRol(token, ['ADMIN'])`— y de
   ahí venía todo lo torcido: el catálogo tenía que declarar qué rol EXIGE cada
   vista, el panel avisaba con una ⚠ de las casillas que no servían de nada, y
   los tres nombres de perfil eran intocables. Nada de eso hace falta ya.
   ═══════════════════════════════════════════════════════════════════════════ */

var _PERMISOS_KEY = 'PERMISOS_VISTAS';
// Los ids de vista que este proyecto YA conocía la última vez. Sirve para
// distinguir «vista nueva que acabo de añadir al catálogo» de «vista que el
// admin quitó a propósito»: sin esta lista no se pueden separar, porque las
// dos se ven igual —un id del catálogo que no está en la lista de un rol—.
var _PERMISOS_IDS_KEY = 'PERMISOS_VISTAS_CONOCIDAS';
// ─── Perfiles de acceso ────────────────────────────────────────────────────
// Un perfil es UN NOMBRE Y UNA LISTA DE VISTAS. Nada más. Lo que puede hacer
// se deduce de las vistas que tiene concedidas, no de cómo se llama.
//
// ⚠️ **Esto estaba al revés y era un error de diseño.** Había tres nombres
// —CTA, VALIDADOR, ADMIN— escritos en unas 45 llamadas a `_exigirRol`, así que
// un perfil nuevo tenía que declarar «me comporto como un ADMIN» y los tres de
// fábrica no se podían ni renombrar ni borrar sin dejar a todo el mundo fuera.
// Ahora **la vista ES el permiso**: cada función de la API exige la vista desde
// la que se usa (`_exigirVista`), y no queda un solo nombre de perfil escrito
// en el código. Se puede borrar CTA, crear TORRE con las mismas vistas y todo
// sigue funcionando igual.
//
// Consecuencia buscada: la pantalla de permisos ya no es «solo visibilidad».
// Quitar una vista quita de verdad el permiso, y por eso desapareció el aviso
// de «la vería, pero las acciones se le rechazarían».
var _PERFILES_KEY = 'PERFILES_APP';
var _PERFIL_DEFECTO_KEY = 'PERFIL_DEFECTO';

// Solo para la PRIMERA vez: tres perfiles de ejemplo con los que arrancar,
// igual que `PUESTOS_DEFECTO` siembra la hoja PUESTOS. A partir de ahí manda
// properties, y estos tres son tan borrables como cualquier otro.
var PERFILES_SEMILLA = {
  CTA:       'Controlador. Ve lo suyo y propone cambios.',
  VALIDADOR: 'Además valida los cambios de los demás.',
  ADMIN:     'Todo, incluida la configuración.'
};

// Solo las HOJAS se marcan. Una pestaña contenedora (Mi calendario, Gestión,
// Configuración) aparece sola si al usuario le queda alguna hija dentro, así
// que no puede quedar un menú incoherente: no hay nada que cuadrar a mano.
var VISTAS_APP = [
  { id: 'guia',            grupo: '',               txt: 'Guía' },
  { id: 'global',          grupo: 'Turnero Global', txt: 'Turnero del mes' },
  { id: 'global.acum',     grupo: 'Turnero Global', txt: 'Acumulados y prelación',
    nota: 'Extras, voluntarias, COS, desprogramaciones y activaciones de los tres últimos años, y a quién le toca la siguiente.' },
  { id: 'cal.cal',         grupo: 'Mi calendario',  txt: 'Calendario de cambios' },
  { id: 'cal.bal',         grupo: 'Mi calendario',  txt: 'Balance' },
  { id: 'cal.env',         grupo: 'Mi calendario',  txt: 'Enviados' },
  { id: 'cal.rec',         grupo: 'Mi calendario',  txt: 'Recibidos' },
  { id: 'cal.anual',       grupo: 'Mi calendario',  txt: 'Resumen anual',
    nota: 'Horas y servicios mes a mes del año, con el total de los meses cumplidos.' },
  { id: 'gestion.rapido',  grupo: 'Gestión',        txt: 'Incidencias',
    nota: 'Tocar el turnero de otro: bajas, extras, voluntarias, activar imaginarias, cubrir huecos, deshacer un día y editar la nota de una celda.' },
  { id: 'gestion.val',     grupo: 'Gestión',        txt: 'Validación',
    nota: 'Aprobar o rechazar los cambios que llegan, y escribirlos en el turnero.' },
  { id: 'gestion.reparto', grupo: 'Gestión',        txt: 'Supervisión',
    nota: 'Además hace falta un cargo con permiso de reparto (JSUPIN). Sin él no aparece aunque esté marcada.' },
  { id: 'gestion.instr',   grupo: 'Gestión',        txt: 'Instrucción',
    nota: 'Ver y planificar la instrucción del mes. Aprobarla exige además el cargo de reparto.' },
  { id: 'gestion.eval',    grupo: 'Gestión',        txt: 'Evaluación',
    nota: 'Programar evaluaciones. Aprobarlas exige además el cargo de reparto.' },
  { id: 'diag',            grupo: '',               txt: 'Diagnóstico' },
  { id: 'config.puestos',  grupo: 'Configuración',  txt: 'Puestos y competencias' },
  { id: 'config.gente',    grupo: 'Configuración',  txt: 'Controladores y cargos',
    nota: 'Alta, baja y edición de controladores, sus cargos y la invitación por correo.' },
  { id: 'config.params',   grupo: 'Configuración',  txt: 'Parámetros de cómputo' },
  { id: 'config.dotacion', grupo: 'Configuración',  txt: 'Dotación' },
  { id: 'config.colores',  grupo: 'Configuración',  txt: 'Colores del cuadrante' },
  { id: 'config.permisos', grupo: 'Configuración',  txt: 'Permisos',
    nota: 'Quien tiene esta vista manda: crea perfiles y reparte todas las demás. Siempre ha de tenerla alguien.' }
];

var PERMISOS_SEMILLA = {
  CTA:       ['guia', 'global', 'global.acum', 'cal.cal', 'cal.bal', 'cal.env', 'cal.rec', 'cal.anual', 'gestion.reparto', 'diag'],
  VALIDADOR: ['guia', 'global', 'global.acum', 'cal.cal', 'cal.bal', 'cal.env', 'cal.rec', 'cal.anual', 'gestion.reparto', 'gestion.val', 'gestion.instr', 'gestion.eval', 'diag'],
  ADMIN:     VISTAS_APP.map(function (v) { return v.id; })
};

// Sin esta vista un ADMIN se deja fuera de la única pantalla desde la que
// podría volver a entrar. No es negociable.
var _VISTA_IRRENUNCIABLE = 'config.permisos';

function _idsVista() { return VISTAS_APP.map(function (v) { return v.id; }); }

// ─── El catálogo de perfiles ───────────────────────────────────────────────
// La primera vez se siembra con los tres de ejemplo; después manda properties.
// Solo hay un invariante: **no puede quedar vacío**, o no habría perfil al que
// caer y nadie entraría.
function _perfiles() {
  var raw = '';
  try { raw = PropertiesService.getScriptProperties().getProperty(_PERFILES_KEY) || ''; } catch (e) {}
  var o = null;
  if (raw) { try { o = JSON.parse(raw); } catch (e2) { o = null; } }
  if (!o || typeof o !== 'object') o = {};

  var fin = {};
  Object.keys(o).forEach(function (n) {
    var nombre = String(n).trim().toUpperCase();
    if (!nombre) return;
    fin[nombre] = { desc: String((o[n] || {}).desc || '') };
  });
  if (!Object.keys(fin).length) {
    Object.keys(PERFILES_SEMILLA).forEach(function (n) { fin[n] = { desc: PERFILES_SEMILLA[n] }; });
  }
  return fin;
}
function _guardarPerfiles(p) {
  PropertiesService.getScriptProperties().setProperty(_PERFILES_KEY, JSON.stringify(p));
}

// ⚠️ El perfil al que cae quien no tiene uno válido: la casilla `rol_app` en
// blanco, o un nombre que ya no existe porque se borró el perfil. Se guarda en
// properties y se puede cambiar, para que tampoco AQUÍ haya un nombre escrito.
// Si apunta a un perfil que ya no está, se coge el primero que haya — nunca
// «ninguno», que dejaría a esa persona sin una sola pantalla.
function _perfilDefecto() {
  var perfiles = _perfiles();
  var n = '';
  try { n = String(PropertiesService.getScriptProperties().getProperty(_PERFIL_DEFECTO_KEY) || '').toUpperCase(); } catch (e) {}
  if (n && perfiles[n]) return n;
  // Sin puntero válido se coge el perfil con MENOS vistas. Es la única
  // elección segura: caer aquí significa «no sé quién eres», y de ahí no puede
  // salir nunca más permiso del que ya había. El primero por orden alfabético
  // habría dado ADMIN.
  var todo = _leerPermisosCrudo() || {};
  var todos = Object.keys(perfiles).sort(function (a, b) {
    var na = (todo[a] || []).length, nb = (todo[b] || []).length;
    return na - nb || (a < b ? -1 : 1);
  });
  return todos[0] || '';
}
function _perfilDe(rol) {
  var n = String(rol || '').trim().toUpperCase();
  return _perfiles()[n] ? n : _perfilDefecto();
}

// Lo único que decide qué puede hacer alguien: las vistas que tiene concedidas.
function _tieneVista(u, vista) {
  return vistasDeRol(u && u.rol).indexOf(vista) !== -1;
}
// Cada función de la API exige LA VISTA desde la que se usa. No hay niveles ni
// nombres de perfil: si la pantalla no la tienes, la acción tampoco.
function _exigirVista(token, vista) {
  var u = _exigirUsuario(token);
  if (!_tieneVista(u, vista)) {
    var v = VISTAS_APP.filter(function (x) { return x.id === vista; })[0];
    throw new Error('Tu perfil (' + u.rol + ') no tiene «' + ((v && v.txt) || vista) + '».');
  }
  return u;
}
// Quien reparte los permisos es, por definición, quien administra la app. Es
// lo más cerca de «ADMIN» que queda, y sale de la configuración, no de un
// nombre.
function _esAdministrador(u) { return _tieneVista(u, 'config.permisos'); }

function _leerPermisosCrudo() {
  var raw = '';
  try { raw = PropertiesService.getScriptProperties().getProperty(_PERMISOS_KEY) || ''; } catch (e) {}
  if (!raw) return null;
  try {
    var o = JSON.parse(raw);
    return (o && typeof o === 'object') ? o : null;
  } catch (e) {
    _logApp('WARN', 'permisos', 'JSON corrupto en properties; se resiembra');
    return null;
  }
}

// Deja properties con los tres roles y solo con ids que existan. Los roles que
// falten se siembran enteros; una vista que ya no exista se descarta.
//
// ⚠️ Y las vistas NUEVAS del catálogo se reparten según la semilla. Sin esto,
// añadir una pantalla no la veía nadie: los permisos ya estaban guardados sin
// ella y el admin no tenía forma de enterarse — pasó con «Colores del
// cuadrante». Se sabe cuáles son nuevas porque se guarda la lista de ids ya
// conocidos; si no, no se distinguirían de las que el admin quitó a propósito.
function _sembrarPermisos() {
  var actual = _leerPermisosCrudo();
  var perfiles = _perfiles();
  var nombres = Object.keys(perfiles);
  // Solo los tres nombres de la semilla tienen una lista de fábrica. Un perfil
  // creado a mano no: sus vistas se las dio quien lo creó (copiando de otro o a
  // mano), y aquí no hay nada que adivinar.
  var semillaDe = function (rol) { return PERMISOS_SEMILLA[rol] || []; };
  var validos = _idsVista(), fin = {}, creados = [];
  nombres.forEach(function (rol) {
    var lista = actual && Array.isArray(actual[rol]) ? actual[rol] : null;
    if (!lista) { fin[rol] = semillaDe(rol).slice(); creados.push(rol); return; }
    fin[rol] = lista.filter(function (id) { return validos.indexOf(id) !== -1; });
  });
  // Un perfil borrado deja su lista atrás; se recoge para que properties no
  // acumule roles fantasma.
  var sobran = actual ? Object.keys(actual).filter(function (r) { return nombres.indexOf(r) === -1; }) : [];

  var conocidas = [];
  try {
    var rawIds = PropertiesService.getScriptProperties().getProperty(_PERMISOS_IDS_KEY) || '';
    if (rawIds) conocidas = JSON.parse(rawIds) || [];
  } catch (e) { conocidas = []; }
  // La primera vez no existe la lista. Darlas todas por conocidas sería lo
  // cómodo y lo equivocado: dejaría fuera para siempre las vistas añadidas
  // ANTES de que existiera este control, que es exactamente lo que pasó con
  // «Colores del cuadrante». Se deducen de lo que hay guardado: conocido es
  // lo que alguien tiene concedido.
  if (!conocidas.length && actual) {
    nombres.forEach(function (rol) {
      (actual[rol] || []).forEach(function (id) {
        if (conocidas.indexOf(id) === -1) conocidas.push(id);
      });
    });
  }

  var nuevas = validos.filter(function (id) { return conocidas.indexOf(id) === -1; });
  nuevas.forEach(function (id) {
    nombres.forEach(function (rol) {
      if (semillaDe(rol).indexOf(id) !== -1 && fin[rol].indexOf(id) === -1) fin[rol].push(id);
    });
  });

  // ⚠️ Alguien tiene que conservar «Permisos» o la app queda cerrada por dentro
  // y sin forma de volver a abrirla. Antes esto decía `fin.ADMIN`, que era el
  // último nombre de perfil escrito en el código. Ahora, si no la tiene nadie,
  // se le da al perfil con más vistas —el que de hecho administra— y se anota.
  var conPermisos = nombres.filter(function (r) { return fin[r].indexOf(_VISTA_IRRENUNCIABLE) !== -1; });
  var rescatado = '';
  if (!conPermisos.length && nombres.length) {
    rescatado = nombres.slice().sort(function (a, b) { return fin[b].length - fin[a].length; })[0];
    fin[rescatado].push(_VISTA_IRRENUNCIABLE);
  }

  if (creados.length || nuevas.length || sobran.length || rescatado || !actual) {
    var props = PropertiesService.getScriptProperties();
    props.setProperty(_PERMISOS_KEY, JSON.stringify(fin));
    props.setProperty(_PERMISOS_IDS_KEY, JSON.stringify(validos));
    _logApp('INFO', 'permisos', 'sembrados: ' + (creados.join(', ') || '—') +
      (nuevas.length ? ' · vistas nuevas: ' + nuevas.join(', ') : '') +
      (sobran.length ? ' · perfiles retirados: ' + sobran.join(', ') : '') +
      (rescatado ? ' · «Permisos» devuelta a ' + rescatado + ', que nadie la tenía' : ''));
    _SEMBRADAS_EN_ESTA_EJECUCION_VISTAS = nuevas;
  } else if (conocidas.length !== validos.length) {
    PropertiesService.getScriptProperties().setProperty(_PERMISOS_IDS_KEY, JSON.stringify(validos));
  }
  return fin;
}
var _SEMBRADAS_EN_ESTA_EJECUCION_VISTAS = [];

// Las vistas que puede ver un rol. Es lo que viaja en getEstadoInicial.
function vistasDeRol(rol) {
  var todo = _sembrarPermisos();
  var n = String(rol || '').toUpperCase();
  if (todo[n]) return todo[n].slice();
  // Ni `todo.CTA` ni nada escrito a mano: el que esté marcado por defecto.
  return (todo[_perfilDefecto()] || []).slice();
}

function getPermisos(token) {
  var u = _exigirVista(token, 'config.permisos');
  var perfiles = _perfiles();
  // Cuánta gente tiene cada perfil: sin eso, borrar es a ciegas.
  var cuenta = _cuentaPorPerfil(perfiles);
  var defecto = _perfilDefecto();
  return {
    ok: true,
    vistas: VISTAS_APP,
    roles: Object.keys(perfiles),
    perfiles: Object.keys(perfiles).map(function (n) {
      return { nombre: n, desc: perfiles[n].desc, personas: cuenta[n] || 0, defecto: n === defecto };
    }),
    defecto: defecto,
    permisos: _sembrarPermisos(),
    vistasNuevas: _SEMBRADAS_EN_ESTA_EJECUCION_VISTAS,
    semilla: PERMISOS_SEMILLA,
    irrenunciable: _VISTA_IRRENUNCIABLE,
    miPerfil: _perfilDe(u.rol)
  };
}

// Cuánta gente tiene cada perfil. Quien tenga la casilla en blanco o un perfil
// que ya no existe cuenta en el POR DEFECTO, que es donde acaba de verdad.
function _cuentaPorPerfil(perfiles) {
  var cuenta = {};
  Object.keys(perfiles).forEach(function (n) { cuenta[n] = 0; });
  try {
    leerControladoresCache().forEach(function (c) {
      if (!c.activo) return;
      var r = _perfilDe(c.rol);
      if (r) cuenta[r] = (cuenta[r] || 0) + 1;
    });
  } catch (e) {}
  return cuenta;
}

function setPermisos(token, mapa) {
  var u = _exigirVista(token, 'config.permisos');
  if (!mapa || typeof mapa !== 'object') return { ok: false, error: 'No has mandado nada que guardar.' };

  var validos = _idsVista(), vigente = _sembrarPermisos(), fin = {};
  var nombres = Object.keys(_perfiles());
  for (var i = 0; i < nombres.length; i++) {
    var rol = nombres[i];
    if (!Array.isArray(mapa[rol])) { fin[rol] = vigente[rol]; continue; }
    fin[rol] = mapa[rol].filter(function (id) { return validos.indexOf(id) !== -1; });
  }
  // ⚠️ El único invariante, y ya no habla de ADMIN: **alguien** ha de conservar
  // la pantalla de permisos. Si no, es una puerta cerrada por dentro y no queda
  // forma de volver a abrirla desde la app.
  var conPermisos = Object.keys(fin).filter(function (r) { return fin[r].indexOf(_VISTA_IRRENUNCIABLE) !== -1; });
  if (!conPermisos.length) {
    return { ok: false, error: 'Ningún perfil se quedaría con «Permisos»: sería una puerta cerrada por dentro. ' +
      'Déjasela al menos a uno.' };
  }
  // Y tampoco puedes quitártela a ti mismo aunque otro la conserve: te
  // expulsaría de la única pantalla desde la que podrías rectificar.
  var mio = _perfilDe(u.rol);
  if (fin[mio] && fin[mio].indexOf(_VISTA_IRRENUNCIABLE) === -1) {
    return { ok: false, error: 'Es tu propio perfil (' + mio + '): quitarle «Permisos» te dejaría fuera. ' +
      'Que te lo quite otro, si es lo que quieres.' };
  }

  PropertiesService.getScriptProperties().setProperty(_PERMISOS_KEY, JSON.stringify(fin));
  _logApp('INFO', 'setPermisos', Object.keys(fin).map(function (r) { return r + '=' + fin[r].length; }).join(' '), u.cta);
  return { ok: true, permisos: fin };
}

/* ─── Alta, edición y baja de perfiles ─────────────────────────────────────
   Un perfil es un nombre y una lista de vistas: se crea, se renombra y se
   borra cualquiera, los tres de la semilla incluidos. Se puede borrar CTA,
   crear TORRE con las mismas vistas y todo sigue funcionando igual.

   Los guardarraíles NO hablan de nombres —eso era el problema—, sino de lo que
   pasaría después: que nadie pueda entrar, que alguien se quede sin perfil, o
   que te expulses a ti mismo.
   ───────────────────────────────────────────────────────────────────────── */

// Quién tiene cada perfil ahora mismo. Es lo que impide borrar uno en uso.
function _ctasConPerfil(nombre) {
  var n = String(nombre || '').toUpperCase();
  try {
    return leerControladoresCache()
      .filter(function (c) { return c.activo && String(c.rol || '').trim().toUpperCase() === n; })
      .map(function (c) { return c.cta; });
  } catch (e) { return []; }
}

function _validarNombrePerfil(nombre, perfiles, permitir) {
  var n = String(nombre || '').trim().toUpperCase();
  if (!n) return { error: 'Hace falta un nombre para el perfil.' };
  // Sin espacios ni acentos: viaja en una celda, en properties y en el chip.
  if (!/^[A-Z0-9_]{2,20}$/.test(n)) {
    return { error: 'Nombre no válido: «' + nombre + '». Solo letras sin acentos, números y _, de 2 a 20.' };
  }
  if (perfiles[n] && n !== permitir) return { error: 'Ya existe un perfil llamado ' + n + '.' };
  return { nombre: n };
}

// `copiarDe` es lo útil de verdad: casi siempre lo que se quiere es «como el
// que ya tengo, pero sin esto». Sin él, arranca sin ninguna vista.
function crearPerfil(token, nombre, desc, copiarDe) {
  var u = _exigirVista(token, 'config.permisos');
  var perfiles = _perfiles();
  var v = _validarNombrePerfil(nombre, perfiles, null);
  if (v.error) return { ok: false, error: v.error };

  var vistas = [];
  var origen = String(copiarDe || '').trim().toUpperCase();
  if (origen) {
    if (!perfiles[origen]) return { ok: false, error: 'No existe el perfil ' + origen + ' del que copiar.' };
    vistas = vistasDeRol(origen);
  }

  perfiles[v.nombre] = { desc: String(desc || '').trim() };
  _guardarPerfiles(perfiles);
  var todo = _leerPermisosCrudo() || {};
  todo[v.nombre] = vistas;
  PropertiesService.getScriptProperties().setProperty(_PERMISOS_KEY, JSON.stringify(todo));
  _logApp('INFO', 'crearPerfil', v.nombre + (origen ? ' (copia de ' + origen + ')' : ' (sin vistas)'), u.cta);
  return { ok: true, nombre: v.nombre, vistas: vistas.length };
}

// Renombrar ARRASTRA: quien tuviera el perfil viejo pasa al nuevo, y su lista
// de vistas se muda con él. Sin eso, esa gente se quedaría con un `rol_app`
// que ya no existe y caería en el perfil por defecto sin avisar.
function editarPerfil(token, nombre, campos) {
  var u = _exigirVista(token, 'config.permisos');
  campos = campos || {};
  var viejo = String(nombre || '').trim().toUpperCase();
  var perfiles = _perfiles();
  if (!perfiles[viejo]) return { ok: false, error: 'No existe el perfil ' + viejo + '.' };

  var nuevo = viejo;
  if (campos.nombre != null && String(campos.nombre).trim()) {
    var v = _validarNombrePerfil(campos.nombre, perfiles, viejo);
    if (v.error) return { ok: false, error: v.error };
    nuevo = v.nombre;
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var desc = campos.desc != null ? String(campos.desc).trim() : (perfiles[viejo].desc || '');
    if (nuevo !== viejo) delete perfiles[viejo];
    perfiles[nuevo] = { desc: desc };
    _guardarPerfiles(perfiles);

    if (nuevo === viejo) {
      _logApp('INFO', 'editarPerfil', nuevo + ' (descripción)', u.cta);
      return { ok: true, nombre: nuevo, movidos: 0 };
    }

    var props = PropertiesService.getScriptProperties();
    var todo = _leerPermisosCrudo() || {};
    if (todo[viejo]) { todo[nuevo] = todo[viejo]; delete todo[viejo]; }
    props.setProperty(_PERMISOS_KEY, JSON.stringify(todo));
    // El puntero del perfil por defecto también se muda: si no, apuntaría a un
    // nombre que ya no existe y el defecto saltaría a otro cualquiera.
    if (_perfilDefectoCrudo() === viejo) props.setProperty(_PERFIL_DEFECTO_KEY, nuevo);
    var movidos = _renombrarRolEnControladores(viejo, nuevo);
    _logApp('INFO', 'editarPerfil', viejo + ' → ' + nuevo + ' (' + movidos + ' personas)', u.cta);
    return { ok: true, nombre: nuevo, movidos: movidos };
  } finally { lock.releaseLock(); }
}

function _perfilDefectoCrudo() {
  try { return String(PropertiesService.getScriptProperties().getProperty(_PERFIL_DEFECTO_KEY) || '').toUpperCase(); }
  catch (e) { return ''; }
}

// Cuál se aplica a quien tenga la casilla `rol_app` en blanco o un perfil que
// ya no existe. Que sea configurable es lo que permite borrar cualquiera de
// los tres de la semilla: sin esto, «CTA» seguiría siendo un nombre escrito.
function setPerfilDefecto(token, nombre) {
  var u = _exigirVista(token, 'config.permisos');
  var n = String(nombre || '').trim().toUpperCase();
  if (!_perfiles()[n]) return { ok: false, error: 'No existe el perfil ' + n + '.' };
  PropertiesService.getScriptProperties().setProperty(_PERFIL_DEFECTO_KEY, n);
  _logApp('INFO', 'setPerfilDefecto', n, u.cta);
  return { ok: true, defecto: n };
}

function _renombrarRolEnControladores(viejo, nuevo) {
  var sh = _ss().getSheetByName('CONTROLADORES');
  if (!sh || sh.getLastRow() < 2) return 0;
  var n = sh.getLastRow() - 1;
  var col = sh.getRange(2, COLS_CTA.ROL, n, 1);
  var val = col.getValues(), tocados = 0;
  for (var i = 0; i < val.length; i++) {
    if (String(val[i][0] || '').trim().toUpperCase() === viejo) { val[i][0] = nuevo; tocados++; }
  }
  if (tocados) { col.setValues(val); invalidarCacheControladores(); }
  return tocados;
}

function borrarPerfil(token, nombre) {
  var u = _exigirVista(token, 'config.permisos');
  var n = String(nombre || '').trim().toUpperCase();
  var perfiles = _perfiles();
  if (!perfiles[n]) return { ok: false, error: 'No existe el perfil ' + n + '.' };

  // 1. Ha de quedar alguno: si no, nadie tendría a qué caer.
  if (Object.keys(perfiles).length <= 1) {
    return { ok: false, error: 'Es el único perfil que queda: tiene que haber al menos uno.' };
  }
  // 2. El propio, no: te quedarías fuera de la pantalla desde la que rectificar.
  if (_perfilDe(u.rol) === n) return { ok: false, error: 'Es tu propio perfil: no puedes borrarlo.' };
  // 3. Ni uno en uso. Se dice QUIÉN lo tiene, que es lo que hace falta saber.
  var quienes = _ctasConPerfil(n);
  if (quienes.length) {
    return { ok: false, error: 'Lo tienen ' + quienes.length + ' persona(s): ' + quienes.join(', ') +
      '. Cámbiales el perfil antes de borrarlo.' };
  }
  // 4. Ni el último que conserve «Permisos»: sería una puerta cerrada por dentro.
  var permisos = _sembrarPermisos();
  var otrosConPermisos = Object.keys(permisos).filter(function (r) {
    return r !== n && permisos[r].indexOf(_VISTA_IRRENUNCIABLE) !== -1;
  });
  if (permisos[n] && permisos[n].indexOf(_VISTA_IRRENUNCIABLE) !== -1 && !otrosConPermisos.length) {
    return { ok: false, error: 'Es el único perfil con «Permisos»: borrarlo cerraría la puerta por dentro.' };
  }

  delete perfiles[n];
  _guardarPerfiles(perfiles);
  var props = PropertiesService.getScriptProperties();
  var todo = _leerPermisosCrudo() || {};
  delete todo[n];
  props.setProperty(_PERMISOS_KEY, JSON.stringify(todo));
  // Si era el por defecto, se apunta a otro: `_perfilDefecto()` ya cae en el
  // primero que haya, pero dejarlo escrito evita que cambie solo más adelante.
  if (_perfilDefectoCrudo() === n) props.setProperty(_PERFIL_DEFECTO_KEY, Object.keys(perfiles).sort()[0]);
  _logApp('INFO', 'borrarPerfil', n, u.cta);
  return { ok: true };
}

function restaurarPermisos(token) {
  var u = _exigirVista(token, 'config.permisos');
  var perfiles = _perfiles(), fin = {};
  // Los perfiles creados a mano NO tienen «fábrica» a la que volver, así que
  // se quedan como están: restaurar no puede inventarles una lista.
  Object.keys(perfiles).forEach(function (r) {
    fin[r] = PERMISOS_SEMILLA[r] ? PERMISOS_SEMILLA[r].slice() : vistasDeRol(r);
  });
  PropertiesService.getScriptProperties().setProperty(_PERMISOS_KEY, JSON.stringify(fin));
  _logApp('INFO', 'restaurarPermisos', 'vuelta a la semilla', u.cta);
  return { ok: true, permisos: fin };
}

/* ═══════════════════════════════════════════════════════════════════════════
   PALETA DEL CUADRANTE  —  «Configuración → Colores»

   Qué tono lleva cada marca al escribir en la hoja. Se lee UNA VEZ del
   cuadrante —«Leer de la hoja» propone el más repetido de cada marca— y se
   guarda en properties. A partir de ahí manda lo guardado: no se deduce en
   cada escritura, así se sabe siempre qué se va a pintar y se puede corregir.

   ⚠️ El color no es decoración: `claseDeFondo()` lo lee para saber si una M
   es una extra, una voluntaria o una imaginaria activada. Un tono que no se
   reconozca deja la celda muda.
   ═══════════════════════════════════════════════════════════════════════════ */

var _PALETA_KEY = 'PALETA_CUADRANTE';

var MARCAS_PALETA = [
  { id: 'activada',   txt: 'Imaginaria activada', ayuda: 'La celda deja de poner im y pone M.' },
  { id: 'extra',      txt: 'Extra y COS',         ayuda: '' },
  { id: 'voluntaria', txt: 'Horas voluntarias',   ayuda: '' },
  { id: 'baja',       txt: 'Baja',                ayuda: 'El código además lleva un guion delante.' },
  { id: 'fueraCiclo', txt: 'Jornada fuera de ciclo', ayuda: '' },
  { id: 'gris',       txt: 'Vacaciones y reducción de jornada', ayuda: '' }
];

function _leerPaletaCruda() {
  var raw = '';
  try { raw = PropertiesService.getScriptProperties().getProperty(_PALETA_KEY) || ''; } catch (e) {}
  if (!raw) return null;
  try {
    var o = JSON.parse(raw);
    return (o && typeof o === 'object') ? o : null;
  } catch (e) {
    _logApp('WARN', 'paleta', 'JSON corrupto en properties; se resiembra');
    return null;
  }
}

// Deja properties con las seis marcas. Las que ya estén no se tocan.
//
// Lo que falte se toma DEL CUADRANTE: el tono más repetido de esa marca en el
// mes vigente. Así la primera persona que entre deja registrados los colores
// de verdad sin que nadie tenga que hacer nada, que es lo suyo — los tonos de
// la hoja no cambian y no tiene sentido pedir que se copien a mano. Los hex
// del código quedan de último recurso, para una marca que no aparezca en
// ninguna celda de ese mes.
function _sembrarPaleta() {
  var actual = _leerPaletaCruda(), fin = {}, faltan = [];
  MARCAS_PALETA.forEach(function (m) {
    var v = actual && typeof actual[m.id] === 'string' ? _hexValido(actual[m.id]) : '';
    if (v) fin[m.id] = v; else faltan.push(m.id);
  });
  if (!faltan.length && actual) return fin;

  // Solo se lee la hoja si de verdad falta algo, así que esto ocurre una vez.
  var deLaHoja = {};
  try {
    var mesV = _mesActualVigente(_mesesVigentes());
    if (mesV) deLaHoja = leerMesCache(mesV).paleta || {};
  } catch (e) {
    _logApp('WARN', 'paleta', 'no se pudo leer el cuadrante para sembrar: ' + e);
  }

  var origen = [];
  faltan.forEach(function (id) {
    var hex = _hexValido(deLaHoja[id] || '');
    // Solo vale si al releerlo se reconoce como su marca; si no, el código.
    if (hex && claseDeFondo(hex) === id) { fin[id] = hex; origen.push(id + '=hoja'); }
    else { fin[id] = fondoDeMarca(id); origen.push(id + '=defecto'); }
  });

  PropertiesService.getScriptProperties().setProperty(_PALETA_KEY, JSON.stringify(fin));
  _logApp('INFO', 'paleta', 'sembradas: ' + origen.join(' '));
  return fin;
}

function paletaGuardada() {
  try { return _sembrarPaleta(); }
  catch (e) { _logApp('WARN', 'paletaGuardada', String(e)); return {}; }
}

// '#a1b2c3' en minúsculas, o '' si no es un color. Acepta la forma corta.
function _hexValido(x) {
  var h = String(x == null ? '' : x).trim().toLowerCase().replace('#', '');
  if (/^[0-9a-f]{3}$/.test(h)) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return /^[0-9a-f]{6}$/.test(h) ? '#' + h : '';
}

// La lectura del cuadrante ya la hace la siembra, así que aquí basta con lo
// guardado: la pantalla es para VER qué se escribe y corregirlo si hace falta.
function getPaleta(token) {
  _exigirVista(token, 'config.colores');
  return {
    ok: true,
    marcas: MARCAS_PALETA,
    paleta: _sembrarPaleta(),
    semilla: MARCAS_PALETA.reduce(function (o, m) { o[m.id] = fondoDeMarca(m.id); return o; }, {})
  };
}

function setPaleta(token, mapa) {
  var u = _exigirVista(token, 'config.colores');
  if (!mapa || typeof mapa !== 'object') return { ok: false, error: 'No has mandado nada que guardar.' };
  var vigente = _sembrarPaleta(), fin = {};
  for (var i = 0; i < MARCAS_PALETA.length; i++) {
    var id = MARCAS_PALETA[i].id;
    if (!Object.prototype.hasOwnProperty.call(mapa, id)) { fin[id] = vigente[id]; continue; }
    var hex = _hexValido(mapa[id]);
    if (!hex) return { ok: false, error: '"' + mapa[id] + '" no es un color válido (usa #rrggbb).' };
    // Si el tono no vuelve a clasificarse como su marca, la celda quedaría
    // muda: se escribiría el color pero nadie sabría leerlo después.
    var leido = claseDeFondo(hex);
    if (leido !== id) {
      return { ok: false, error: 'El color ' + hex + ' para "' + id + '" no se reconoce como tal al releerlo' +
        (leido ? ' (se lee como "' + leido + '")' : '') + '. Prueba con un tono más saturado.' };
    }
    fin[id] = hex;
  }
  PropertiesService.getScriptProperties().setProperty(_PALETA_KEY, JSON.stringify(fin));
  _logApp('INFO', 'setPaleta', JSON.stringify(fin), u.cta);
  return { ok: true, paleta: fin };
}

function restaurarPaleta(token) {
  var u = _exigirVista(token, 'config.colores');
  var fin = {};
  MARCAS_PALETA.forEach(function (m) { fin[m.id] = fondoDeMarca(m.id); });
  PropertiesService.getScriptProperties().setProperty(_PALETA_KEY, JSON.stringify(fin));
  _logApp('INFO', 'restaurarPaleta', 'vuelta a la semilla', u.cta);
  return { ok: true, paleta: fin };
}

/* ═══════════════════════════════════════════════════════════════════════════
   DOTACIÓN  —  configuración y detección de huecos

   Dos cosas distintas:
   · «Configuración → Dotación» declara CUÁNTA gente hace falta cada día.
   · «Gestión → Huecos» compara eso con el cuadrante y dice DÓNDE falta.

   Lo segundo enlaza con `candidatosParaCubrir`, que ya existía: hasta ahora el
   hueco había que verlo a ojo.
   ═══════════════════════════════════════════════════════════════════════════ */

var CATEGORIAS_DOTACION = [
  { id: 'cta', txt: 'Controladores', corto: 'Ctr' },
  { id: 'sup', txt: 'Supervisores',  corto: 'Sup' },
  { id: 'ins', txt: 'Instructores',  corto: 'Ins' }
];

function getDotacion(token, mes) {
  _exigirVista(token, 'config.dotacion');
  var meses = _mesesVigentes();
  var m = mes || _mesActualVigente(meses);

  var cuadrante = null;
  try { cuadrante = dotacionDelCuadrante(m); } catch (e) {
    _logApp('WARN', 'getDotacion', 'no se pudo leer la fila DOTACIÓN de ' + m + ': ' + e);
  }

  // Lo REQUERIDO y lo EXISTENTE viajan juntos: la pantalla enseña los dos y
  // marca la diferencia, que es lo único que de verdad se mira.
  var dias = [], real = { M: {}, T: {} };
  try {
    var matriz = _aplicarValidados(m, leerMesCache(m));
    dias = matriz.dias || [];
    real = _contarDotacionReal(matriz);
  } catch (e2) {
    _logApp('WARN', 'getDotacion', 'no se pudo contar el cuadrante de ' + m + ': ' + e2);
    for (var d = 1; d <= 31; d++) dias.push(d);
  }

  return {
    ok: true,
    mes: _mesCanon(m),
    meses: meses,
    dias: dias,
    franjas: FRANJAS_DOTACION,
    categorias: CATEGORIAS_DOTACION,
    dotacion: leerDotacion(m),          // lo requerido, tal cual está escrito
    real: real,                         // lo que hay en el cuadrante
    delCuadrante: cuadrante ? cuadrante.datos : null,
    filasCuadrante: cuadrante ? cuadrante.filas : [],
    plantillas: leerPlantillasDot()
  };
}

function setDotacion(token, mes, datos) {
  var u = _exigirVista(token, 'config.dotacion');
  if (!mes) return { ok: false, error: 'Falta el mes.' };
  if (!datos || typeof datos !== 'object') return { ok: false, error: 'No has mandado nada que guardar.' };

  // Se valida ENTERO antes de tocar la hoja: media rejilla guardada y media
  // rechazada sería peor que no guardar nada.
  var limpio = {}, n = 0;
  for (var i = 0; i < FRANJAS_DOTACION.length; i++) {
    var f = FRANJAS_DOTACION[i];
    limpio[f] = {};
    var fila = datos[f] || {};
    for (var d in fila) {
      var t = String(fila[d] == null ? '' : fila[d]).trim();
      if (!t) continue;
      var parsed = parsearDotacion(t);
      if (!parsed) {
        return { ok: false, error: 'El día ' + d + ' de la franja ' + f + ' pone "' + t +
          '", que no es una dotación. Se escribe controladores+supervisores+instructores: 4+1+1, o 4+1, o 4.' };
      }
      limpio[f][d] = formatearDotacion(parsed);   // normalizada
      n++;
    }
  }
  guardarDotacion(mes, limpio);
  _logApp('INFO', 'setDotacion', _mesCanon(mes) + ': ' + n + ' días', u.cta);
  return { ok: true, mes: _mesCanon(mes), dotacion: leerDotacion(mes) };
}

function guardarPlantillaDotacion(token, nombre, datos) {
  var u = _exigirVista(token, 'config.dotacion');
  var nk = String(nombre || '').trim();
  if (!nk) return { ok: false, error: 'Ponle un nombre a la plantilla.' };
  guardarPlantillaDot(nk, datos || {});
  _logApp('INFO', 'guardarPlantillaDotacion', nk, u.cta);
  return { ok: true, plantillas: leerPlantillasDot() };
}

function borrarPlantillaDotacion(token, nombre) {
  var u = _exigirVista(token, 'config.dotacion');
  var ok = borrarPlantillaDot(String(nombre || '').trim());
  _logApp('INFO', 'borrarPlantillaDotacion', String(nombre), u.cta);
  return { ok: ok, plantillas: leerPlantillasDot() };
}

// Cuánta gente hay DE VERDAD cada día y franja, según el cuadrante.
// Quien esté de baja o de vacaciones no cubre plaza aunque tenga código.
function _contarDotacionReal(m) {
  var cuenta = {};
  FRANJAS_DOTACION.forEach(function (f) { cuenta[f] = {}; });
  Object.keys(m.base || {}).forEach(function (cta) {
    var suyo = m.base[cta] || {};
    Object.keys(suyo).forEach(function (diaStr) {
      var dia = Number(diaStr);
      if ((m.vacaciones[cta] || {})[dia] || (m.bajas[cta] || {})[dia]) return;
      var rol = rolDotacion(suyo[diaStr]);
      if (!rol) return;
      var def = CONFIG_TURNOS[normalizarCodigo(suyo[diaStr])];
      var franja = def && def.franja === 'T' ? 'T' : (def && def.franja === 'M' ? 'M' : '');
      if (!franja) return;
      if (!cuenta[franja][dia]) cuenta[franja][dia] = { cta: 0, sup: 0, ins: 0, quien: {} };
      cuenta[franja][dia][rol]++;
      if (!cuenta[franja][dia].quien[rol]) cuenta[franja][dia].quien[rol] = [];
      cuenta[franja][dia].quien[rol].push(cta);
    });
  });
  return cuenta;
}


/* ═══════════════════════════════════════════════════════════════════════════
   INSTRUCCIÓN  —  «Gestión → Instrucción»

   Programar los turnos de los alumnos. Los instructores salen al lado, en
   solo lectura: sus turnos vienen del cuadrante y se tocan por las vías de
   siempre, no desde aquí.

   ⚠️ La fila se busca por las INICIALES, nunca por su número. Si no aparecen,
   NO se escribe: antes dejar la programación sin hacer que meterle un turno a
   otra persona.
   ═══════════════════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════════════════
   EQUIPO DEL DÍA  —  con quién trabajas

   Al pulsar un día en «Mi calendario», quién más está esa franja. Lo que se
   destaca depende de tu papel ESE DÍA, no de tu puesto:
   · supervisas (`Ms`/`Ts`) → todo el equipo: controladores, instructores y alumnos
   · instruyes (`Mo`/`To`)  → tu alumno
   · controlador raso       → quién supervisa

   El papel sale de `rolDotacion`, la misma tabla con la que se cuenta la
   dotación: si algún día cambia lo que es cada código, cambia en un solo sitio.
   ═══════════════════════════════════════════════════════════════════════════ */

function getEquipoDia(token, mes, dia) {
  var u = _exigirUsuario(token);
  dia = Number(dia);
  var m = _aplicarValidados(mes, leerMesCache(mes));
  var nombres = ctaANombre();

  var miTurno = (m.base[u.cta] || {})[dia] || '';
  // La franja OPERATIVA, no `def.franja`: una EvM se trabaja por la mañana.
  var franja = franjaOperativa(miTurno);
  if (!franja) {
    return { ok: true, mes: _mesCanon(mes), dia: dia, miTurno: miTurno, franja: '', miRol: '' };
  }

  var grupos = { cta: [], sup: [], ins: [] };
  var evaluadores = [];
  Object.keys(m.base).forEach(function (cta) {
    var cod = (m.base[cta] || {})[dia];
    if (!cod) return;
    if ((m.vacaciones[cta] || {})[dia] || (m.bajas[cta] || {})[dia]) return;
    if (franjaOperativa(cod) !== franja) return;
    var quien = { cta: cta, nombre: nombres[cta] || cta, turno: cod, soyYo: cta === u.cta };
    var n = normalizarCodigo(cod);
    if (n === 'EvM' || n === 'EvT') { evaluadores.push(quien); return; }
    var rol = rolDotacion(cod);
    if (!rol) return;                       // formación, reducción: no cubren plaza
    grupos[rol].push(quien);
  });
  ['cta', 'sup', 'ins'].forEach(function (k) {
    grupos[k].sort(function (a, b) { return a.cta < b.cta ? -1 : 1; });
  });
  evaluadores.sort(function (a, b) { return a.cta < b.cta ? -1 : 1; });

  // Los alumnos van en su propia hoja, no en el cuadrante.
  var alumnos = [];
  try {
    var prog = leerTurnoAlumnos(mes);
    Object.keys(prog).forEach(function (cta) {
      var cod = prog[cta][dia];
      if (!cod || franjaOperativa(cod) !== franja) return;
      alumnos.push({ cta: cta, nombre: nombres[cta] || cta, turno: cod });
    });
    alumnos.sort(function (a, b) { return a.cta < b.cta ? -1 : 1; });
  } catch (e) {
    _logApp('WARN', 'getEquipoDia', 'no se pudo leer el turnero de alumnos: ' + e);
  }

  // Quién va con quién, si el reparto lo dejó registrado.
  var parejas = {};
  try { parejas = leerParejas(mes); } catch (e2) {
    _logApp('WARN', 'getEquipoDia', 'no se pudieron leer las parejas: ' + e2);
  }
  var conNombre = function (cta) {
    return cta ? { cta: cta, nombre: nombres[cta] || cta } : null;
  };
  var deTipo = function (tipo) {
    var out = [];
    Object.keys(parejas).forEach(function (k) {
      var p = parejas[k];
      if (p.dia !== dia || p.turno !== franja || p.tipo !== tipo) return;
      out.push({ quien: conNombre(p.quien), conQuien: conNombre(p.conQuien) });
    });
    return out;
  };
  var instrucciones = deTipo('instruccion');
  var evaluaciones = deTipo('evaluacion');
  var miPareja = function (lista) {
    var mia = lista.filter(function (p) { return p.quien && p.quien.cta === u.cta; })[0];
    return mia ? mia.conQuien : null;
  };
  // Y al revés: quién me evalúa a MÍ.
  var quienMeEvalua = function () {
    var mia = evaluaciones.filter(function (p) { return p.conQuien && p.conQuien.cta === u.cta; })[0];
    return mia ? mia.quien : null;
  };
  var miEvaluador = quienMeEvalua();
  var miEvaluado = miPareja(evaluaciones);

  var nMio = normalizarCodigo(miTurno);
  // ⚠️ Tener `EvM`/`EvT` NO significa evaluar: si te evalúan a ti, la EvM es
  // TUYA y el evaluador es otro. El papel sale de la pareja registrada, y solo
  // si no hay ninguna se cae en «hay una evaluación, pero sin asignar».
  var esDiaDeEval = (nMio === 'EvM' || nMio === 'EvT');
  var miRol = miEvaluado ? 'evalua'
            : (miEvaluador ? 'evaluado'
            : (esDiaDeEval ? 'eval' : rolDotacion(miTurno)));

  // La dotación de esa franja: lo requerido y lo que hay. Lo que hay ya está
  // contado arriba —son los mismos grupos—, así que no se recorre otra vez.
  var dot = null;
  try {
    var pide = parsearDotacion((leerDotacion(mes)[franja] || {})[dia]);
    var hay = { cta: grupos.cta.length, sup: grupos.sup.length, ins: grupos.ins.length };
    dot = {
      pide: pide ? formatearDotacion(pide) : '',
      hay: formatearDotacion(hay),
      falta: pide ? ['cta', 'sup', 'ins'].some(function (k) { return hay[k] < pide[k]; }) : false
    };
  } catch (e3) {
    _logApp('WARN', 'getEquipoDia', 'no se pudo leer la dotación: ' + e3);
  }

  // La nota de MI celda: es la misma que se ve en el turnero global, y aquí
  // es donde se busca cuando el día trae algo raro.
  var nota = '';
  try {
    var shMes = _ss().getSheetByName(mes);
    var fila = m.filaDeCta[u.cta], col = m.diaACol[dia];
    if (shMes && fila && col) nota = String(shMes.getRange(fila, col).getNote() || '').trim();
  } catch (e4) {
    _logApp('WARN', 'getEquipoDia', 'no se pudo leer la nota: ' + e4);
  }

  return {
    nota: nota,
    dotacion: dot,
    ok: true,
    mes: _mesCanon(mes), dia: dia, franja: franja,
    miTurno: miTurno,
    miRol: miRol,                          // 'sup' | 'ins' | 'eval' | 'cta' | ''
    controladores: grupos.cta,
    supervisores: grupos.sup,
    instructores: grupos.ins,
    evaluadores: evaluadores,
    alumnos: alumnos,
    instrucciones: instrucciones,          // [{quien, conQuien}] del reparto
    evaluaciones: evaluaciones,
    miAlumno: miPareja(instrucciones),     // si soy instructor y consta
    miEvaluado: miEvaluado,                // a quién evalúo, si consta
    miEvaluador: miEvaluador,              // quién me evalúa, si consta
    diaDeEval: esDiaDeEval,                // tengo EvM/EvT ese día
    // Sin pareja registrada solo se sabe cuántos hay. Con uno no hay duda.
    parejaSegura: alumnos.length === 1 && grupos.ins.length === 1
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   EMPAREJAMIENTOS  —  quién instruye o evalúa a quién, día a día

   No hay reparto automático: lo decide el JSUPIN. Se parte de lo que SÍ es un
   dato —los instructores y evaluadores que tienen turno cada día, que salen
   del cuadrante— y a partir de ahí se asigna el alumno o el evaluado.
   ═══════════════════════════════════════════════════════════════════════════ */

// El permiso de reparto va por CARGO, igual que en la pestaña de Reparto.
function _puedeRepartir(u) {
  if (_esAdministrador(u)) return true;
  var cargo = '';
  try { cargo = String(_cargoDeCta(u.cta) || '').trim().toUpperCase(); } catch (e) {}
  return !!CARGOS_REPARTO[cargo];
}

// Quién puede instruir un día y franja concretos, y quién lo hace ya. Se pide
// al abrir el día, así que no depende de que una lectura del mes entero esté
// al día: al programar el turno del alumno, el selector aparece y punto.
function getCandidatosInstructor(token, mes, dia, franja) {
  _exigirVista(token, 'gestion.instr');
  dia = Number(dia);
  var m = _aplicarValidados(mes, leerMesCache(mes));
  var nombres = ctaANombre();

  var candidatos = [];
  Object.keys(m.base).forEach(function (cta) {
    var cod = (m.base[cta] || {})[dia];
    if (!cod) return;
    if ((m.vacaciones[cta] || {})[dia] || (m.bajas[cta] || {})[dia]) return;
    if (franjaOperativa(cod) !== franja) return;
    var n = normalizarCodigo(cod);
    if (n !== 'M' && n !== 'T' && n !== 'Mo' && n !== 'To') return;
    if (capacidadesDeCargo(m.cargos[cta]).indexOf('instruir') === -1) return;
    candidatos.push({
      cta: cta, nombre: nombres[cta] || cta, puesto: m.cargos[cta],
      turno: cod, yaInstruye: (n === 'Mo' || n === 'To')
    });
  });
  candidatos.sort(function (a, b) { return a.cta < b.cta ? -1 : 1; });

  return { ok: true, dia: dia, franja: franja, candidatos: candidatos };
}

/* ═══════════════════════════════════════════════════════════════════════════
   PLANIFICACIÓN DE INSTRUCCIÓN  —  borrador, y solo al final el turnero

   Antes cada clic escribía en el turnero: se asignaba un instructor y su celda
   pasaba a Mo al momento. Eso hace imposible planificar —probar, quitar,
   ajustar, dejarlo a medias y seguir mañana— y además cualquier fallo de
   guardado se ve como que un día «desaparece», porque cada acción reléia todo.

   Ahora se trabaja sobre un BORRADOR (hoja BORRADORES, tipo `instruccion`):
   turnos de los alumnos, parejas y evaluaciones. Nada toca el turnero hasta
   «Aprobar», y ahí se escribe todo de una vez y se retira el borrador.
   ═══════════════════════════════════════════════════════════════════════════ */

var TIPO_PLAN_INSTR = 'instruccion';

// Lo APLICADO: lo que hay de verdad en las hojas. Es el punto de partida de un
// borrador nuevo y con lo que se compara al aplicar.
function _planAplicado(mes) {
  var turnos = {};
  try { turnos = leerTurnoAlumnos(mes) || {}; } catch (e) {}
  var parejas = {}, evaluaciones = [];
  try {
    var ps = leerParejas(mes);
    Object.keys(ps).forEach(function (k) {
      var p = ps[k];
      if (p.tipo === 'instruccion') {
        if (p.conQuien) parejas[p.dia + '_' + p.turno + '_' + p.conQuien] = p.quien;
      } else if (p.tipo === 'evaluacion') {
        evaluaciones.push({ dia: p.dia, franja: p.turno, quien: p.quien, conQuien: p.conQuien });
      }
    });
  } catch (e2) {}
  return { turnos: turnos, parejas: parejas, evaluaciones: evaluaciones };
}

// Los acumulados de instrucción de cada instructor, con su nombre. Salen del
// MISMO contador que el reparto de supervisión (`acumuladosReparto`), así que
// las dos pantallas no pueden acabar diciendo números distintos del mismo mes.
//
// Es lo que sustituye al reparto automático de instrucción: el JSUPIN asigna a
// mano, pero con el cupo del art. 69.2.4 delante.
function _cuposInstruccion(mes) {
  try {
    var a = acumuladosReparto(mes, 'instruccion');
    var nombres = ctaANombre();
    var out = [];
    Object.keys(a.resumen || {}).forEach(function (cta) {
      var r = a.resumen[cta];
      out.push({
        cta: cta, nombre: nombres[cta] || cta, puesto: r.cargo,
        excepcional: !!r.excepcional,
        totalMes: r.totalMes,          // servicios del mes: el denominador
        marcadosMes: r.marcadosMes,    // Ms/Ts + Mo/To ya escritos: gastan cupo
        instrMes: r.supMes,            // solo los Mo/To
        limiteMes: r.limiteMes,        // floor(totalMes × 0,75)
        marcados: r.marcados || {},    // {dia_franja: true} de lo YA escrito
        instrAnual: r.supAnual,
        serviciosAnuales: r.serviciosAnuales,
        pctAnual: r.pctAnual,
        instrAnualPrevio: r.supAnualPrevio
      });
    });
    // El que menos lleva en el año, primero: es a quien le toca.
    out.sort(function (x, y) {
      return (x.instrAnual - y.instrAnual) || (x.marcadosMes - y.marcadosMes) ||
             (x.cta < y.cta ? -1 : 1);
    });
    return { ok: true, tope: a.tope, instructores: out };
  } catch (e) {
    // Sin LOG_INSTRUCCION todavía, o sin hoja del mes: la pantalla sigue
    // sirviendo para planificar, solo que sin los contadores.
    return { ok: false, error: String(e && e.message ? e.message : e), instructores: [] };
  }
}

function getPlanInstruccion(token, mes) {
  var u = _exigirVista(token, 'gestion.instr');
  var meses = _mesesVigentes();
  var m = mes || _mesActualVigente(meses);
  var nombres = ctaANombre();

  var dias = [];
  try { dias = leerMesCache(m).dias || []; } catch (e) { for (var d = 1; d <= 31; d++) dias.push(d); }

  var alumnos = leerControladoresCache()
    .filter(function (c) { return c.activo && esAlumno(c); })
    .map(function (c) { return { cta: c.cta, nombre: c.nombre || c.cta }; });

  var evaluadores = leerControladoresCache()
    .filter(function (c) {
      if (!c.activo || esAlumno(c)) return false;
      var cargo = '';
      try { cargo = _cargoDeCta(c.cta); } catch (e0) { cargo = c.puesto; }
      return capacidadesDeCargo(cargo).indexOf('evaluar') !== -1;
    })
    .map(function (c) { return { cta: c.cta, nombre: c.nombre || c.cta }; });

  var evaluables = leerControladoresCache()
    .filter(function (c) { return c.activo; })
    .map(function (c) { return { cta: c.cta, nombre: c.nombre || c.cta }; });

  var b = null;
  try { b = _leerBorrador(m, TIPO_PLAN_INSTR); } catch (e3) {}

  return _sanear({
    ok: true,
    mes: _mesCanon(m), meses: meses, dias: dias,
    alumnos: alumnos, evaluadores: evaluadores, evaluables: evaluables,
    // Cuánto lleva cada instructor y cuánto le queda de cupo. Sin esto no se
    // puede repartir a ojo, que es lo que sustituyó al reparto automático.
    cupos: _cuposInstruccion(m),
    aplicado: _planAplicado(m),                  // lo que hay en las hojas
    borrador: b ? b.propuestas : null,           // lo que hay a medias, si lo hay
    borradorAutor: b ? b.autor : '',
    borradorTs: b ? b.ts : '',
    // Las evaluaciones llevan SU borrador: son otra cosa y se aprueban aparte.
    evaluaciones: _evaluacionesAplicadas(m),
    borradorEvals: (function () {
      try { var be = _leerBorrador(m, TIPO_PLAN_EVAL); return be ? be.propuestas : null; }
      catch (e4) { return null; }
    })(),
    nombres: nombres,
    puedeEditar: _puedeRepartir(u)
  });
}

function guardarPlanInstruccion(token, mes, plan) {
  var u = _exigirVista(token, 'gestion.instr');
  if (!_puedeRepartir(u)) return { ok: false, error: 'No tienes el reparto de instrucción.' };
  var txt = JSON.stringify(plan || {});
  if (txt.length > 45000) return { ok: false, error: 'El borrador es demasiado grande para una celda.' };
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = _hojaBorradores();
    var fila = [_mesCanon(mes), TIPO_PLAN_INSTR, u.cta, new Date().toISOString(), txt];
    var f = _filaBorrador(mes, TIPO_PLAN_INSTR);
    if (f) sh.getRange(f, 1, 1, CABECERA_BORRADORES.length).setValues([fila]);
    else sh.appendRow(fila);
    _logApp('INFO', 'guardarPlanInstruccion', _mesCanon(mes), u.cta);
    return { ok: true, ts: fila[3] };
  } finally { lock.releaseLock(); }
}

function descartarPlanInstruccion(token, mes) {
  var u = _exigirVista(token, 'gestion.instr');
  if (!_puedeRepartir(u)) return { ok: false, error: 'No tienes el reparto de instrucción.' };
  var f = _filaBorrador(mes, TIPO_PLAN_INSTR);
  if (f) _hojaBorradores().deleteRow(f);
  _logApp('INFO', 'descartarPlanInstruccion', _mesCanon(mes), u.cta);
  return { ok: true, aplicado: _planAplicado(mes) };
}

// Aprobar: escribe TODO de una vez —turnos de alumno, parejas y los Mo/To de
// los instructores— y retira el borrador. Es el único punto que toca el
// turnero, y va por `_aplicarTurnoCelda`, así que queda en LOG_CELDAS.
function aplicarPlanInstruccion(token, mes, plan) {
  var u = _exigirVista(token, 'gestion.instr');
  if (!_puedeRepartir(u)) return { ok: false, error: 'No tienes el reparto de instrucción.' };
  if (_mesEsPasado(mes)) return { ok: false, error: 'Ese mes ya pasó: no admite cambios.' };
  plan = plan || {};

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var antes = _planAplicado(mes);
    var nTurnos = 0, nParejas = 0, nCeldas = 0;

    // 1. Turnos de los alumnos.
    var turnos = plan.turnos || {};
    Object.keys(turnos).forEach(function (cta) {
      Object.keys(turnos[cta] || {}).forEach(function (dia) {
        var nuevo = String(turnos[cta][dia] || '');
        var viejo = String((antes.turnos[cta] || {})[dia] || '');
        if (nuevo === viejo) return;
        guardarTurnoAlumno(mes, cta, dia, nuevo || 'libre');
        nTurnos++;
      });
    });
    // Y los que el borrador ha borrado.
    Object.keys(antes.turnos).forEach(function (cta) {
      Object.keys(antes.turnos[cta] || {}).forEach(function (dia) {
        if (((turnos[cta] || {})[dia]) === undefined && antes.turnos[cta][dia]) {
          guardarTurnoAlumno(mes, cta, dia, 'libre');
          nTurnos++;
        }
      });
    });

    // 2. Parejas de instrucción. La clave del plan es dia_franja_ALUMNO.
    var pares = plan.parejas || {};
    var instructoresFinales = {};       // dia_franja_instructor → true
    var parejasHoja = {};
    Object.keys(pares).forEach(function (k) {
      var ins = pares[k];
      if (!ins) return;
      var p = k.split('_');
      var dia = Number(p[0]), franja = p[1], alumno = p[2];
      parejasHoja[_clavePareja(dia, franja, 'instruccion', ins)] = {
        dia: dia, turno: franja, tipo: 'instruccion', quien: ins, conQuien: alumno
      };
      instructoresFinales[dia + '_' + franja + '_' + ins] = true;
      nParejas++;
    });
    guardarParejas(mes, 'instruccion', parejasHoja);

    // 4. El cuadrante: quien instruye pasa a Mo/To, y quien deja de hacerlo
    //    vuelve a M/T. Es la CONSECUENCIA de lo anterior.
    var m = leerMes(mes);
    var sh = _ss().getSheetByName(mes);
    var instructoresAntes = {};
    Object.keys(antes.parejas).forEach(function (k) {
      var p = k.split('_');
      instructoresAntes[p[0] + '_' + p[1] + '_' + antes.parejas[k]] = true;
    });
    var poner = function (clave, quiere) {
      var p = clave.split('_');
      var dia = Number(p[0]), franja = p[1], cta = p[2];
      if (!sh || !m.filaDeCta[cta]) return;
      var actual = (m.base[cta] || {})[dia] || '';
      var cod = quiere ? (franja === 'T' ? 'To' : 'Mo') : (franja === 'T' ? 'T' : 'M');
      if (normalizarCodigo(actual) === cod) return;
      _aplicarTurnoCelda(sh, m, mes, cta, dia, cod, {
        tipo: 'X', origen: 'ADMIN',
        motivo: quiere ? 'Instrucción aprobada' : 'Instrucción retirada', autor: u.cta
      });
      nCeldas++;
    };
    Object.keys(instructoresFinales).forEach(function (k) { poner(k, true); });
    Object.keys(instructoresAntes).forEach(function (k) {
      if (!instructoresFinales[k]) poner(k, false);
    });

    // 5. Fuera el borrador: ya no representa nada pendiente.
    var f = _filaBorrador(mes, TIPO_PLAN_INSTR);
    if (f) _hojaBorradores().deleteRow(f);

    invalidarCacheMes(mes);
    _logApp('INFO', 'aplicarPlanInstruccion', _mesCanon(mes) + ': ' + nTurnos + ' turnos, ' +
      nParejas + ' parejas, ' + nCeldas + ' celdas', u.cta);
    return { ok: true, turnos: nTurnos, parejas: nParejas, celdas: nCeldas, aplicado: _planAplicado(mes) };
  } finally {
    lock.releaseLock();
  }
}

// Propuesta sobre el BORRADOR: devuelve un plan nuevo con los huecos llenos,
// sin guardar ni tocar nada. Lo que se aprueba después es lo que quede en la
// pantalla, no esto.
function proponerPlanInstruccion(token, mes, plan) {
  var u = _exigirVista(token, 'gestion.instr');
  if (!_puedeRepartir(u)) return { ok: false, error: 'No tienes el reparto de instrucción.' };
  plan = plan || {};
  var turnos = plan.turnos || {}, pares = JSON.parse(JSON.stringify(plan.parejas || {}));
  var m = _aplicarValidados(mes, leerMesCache(mes));

  // Quién puede instruir cada día y franja: turno de esa franja y puesto que
  // instruya. Se calcula una vez por día que haga falta.
  var cacheCand = {};
  function candidatos(dia, franja) {
    var k = dia + '_' + franja;
    if (cacheCand[k]) return cacheCand[k];
    var out = [];
    Object.keys(m.base).forEach(function (cta) {
      var cod = (m.base[cta] || {})[dia];
      if (!cod) return;
      if ((m.vacaciones[cta] || {})[dia] || (m.bajas[cta] || {})[dia]) return;
      if (franjaOperativa(cod) !== franja) return;
      var n = normalizarCodigo(cod);
      if (n !== 'M' && n !== 'T' && n !== 'Mo' && n !== 'To') return;
      if (capacidadesDeCargo(m.cargos[cta]).indexOf('instruir') === -1) return;
      out.push(cta);
    });
    cacheCand[k] = out.sort();
    return out;
  }

  // Cuántos lleva ya cada instructor en el plan, y quién está pillado ese día.
  var lleva = {}, ocupado = {};
  Object.keys(pares).forEach(function (k) {
    var ins = pares[k];
    if (!ins) return;
    var p = k.split('_');
    lleva[ins] = (lleva[ins] || 0) + 1;
    ocupado[p[0] + '_' + p[1] + '_' + ins] = true;
  });

  var puestas = 0, sinCandidato = 0;
  Object.keys(turnos).forEach(function (alumno) {
    Object.keys(turnos[alumno] || {}).forEach(function (dia) {
      var franja = franjaOperativa(turnos[alumno][dia]);
      if (!franja) return;
      var clave = Number(dia) + '_' + franja + '_' + alumno;
      if (pares[clave]) return;                      // ya decidido
      var cand = candidatos(Number(dia), franja).filter(function (c) {
        return !ocupado[dia + '_' + franja + '_' + c];
      });
      if (!cand.length) { sinCandidato++; return; }
      cand.sort(function (a, b) { return (lleva[a] || 0) - (lleva[b] || 0) || (a < b ? -1 : 1); });
      pares[clave] = cand[0];
      ocupado[dia + '_' + franja + '_' + cand[0]] = true;
      lleva[cand[0]] = (lleva[cand[0]] || 0) + 1;
      puestas++;
    });
  });

  return { ok: true, puestas: puestas, sinCandidato: sinCandidato,
           plan: { turnos: turnos, parejas: pares, evaluaciones: plan.evaluaciones || [] } };
}


/* ═══════════════════════════════════════════════════════════════════════════
   EVALUACIONES  —  su propio borrador y su propia aprobación

   Son OTRA COSA que la instrucción, y por eso no comparten el borrador: se
   planifican y se aprueban aparte. Pero sí escriben en el turnero, porque el
   `EvM`/`EvT` puede estar ya en el cuadrante o no estarlo: al aprobar se pone
   a quien le falte.

   ⚠️ Solo se escribe encima de una `M`/`T` PELADA. A quien tenga `Ms`, `Mo` o
   cualquier otra cosa NO se le pisa el código —eso perdería información— y se
   dice en el resultado. El día que haga falta, se decide qué hacer con ellos.
   ═══════════════════════════════════════════════════════════════════════════ */

var TIPO_PLAN_EVAL = 'evaluacion';

function _evaluacionesAplicadas(mes) {
  var out = [];
  try {
    var ps = leerParejas(mes, 'evaluacion');
    Object.keys(ps).forEach(function (k) {
      var p = ps[k];
      out.push({ dia: p.dia, franja: p.turno, quien: p.quien, conQuien: p.conQuien });
    });
  } catch (e) {}
  out.sort(function (a, b) { return a.dia - b.dia || (a.franja < b.franja ? -1 : 1); });
  return out;
}

function guardarBorradorEvaluaciones(token, mes, lista) {
  var u = _exigirVista(token, 'gestion.eval');
  if (!_puedeRepartir(u)) return { ok: false, error: 'No tienes el reparto de instrucción.' };
  var txt = JSON.stringify(lista || []);
  if (txt.length > 45000) return { ok: false, error: 'El borrador es demasiado grande para una celda.' };
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = _hojaBorradores();
    var fila = [_mesCanon(mes), TIPO_PLAN_EVAL, u.cta, new Date().toISOString(), txt];
    var f = _filaBorrador(mes, TIPO_PLAN_EVAL);
    if (f) sh.getRange(f, 1, 1, CABECERA_BORRADORES.length).setValues([fila]);
    else sh.appendRow(fila);
    _logApp('INFO', 'guardarBorradorEvaluaciones', _mesCanon(mes), u.cta);
    return { ok: true, ts: fila[3] };
  } finally { lock.releaseLock(); }
}

function descartarBorradorEvaluaciones(token, mes) {
  var u = _exigirVista(token, 'gestion.eval');
  if (!_puedeRepartir(u)) return { ok: false, error: 'No tienes el reparto de instrucción.' };
  var f = _filaBorrador(mes, TIPO_PLAN_EVAL);
  if (f) _hojaBorradores().deleteRow(f);
  return { ok: true, evaluaciones: _evaluacionesAplicadas(mes) };
}

function aplicarEvaluaciones(token, mes, lista) {
  var u = _exigirVista(token, 'gestion.eval');
  if (!_puedeRepartir(u)) return { ok: false, error: 'No tienes el reparto de instrucción.' };
  if (_mesEsPasado(mes)) return { ok: false, error: 'Ese mes ya pasó: no admite cambios.' };
  lista = lista || [];

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var antes = _evaluacionesAplicadas(mes);

    // 1. Las parejas.
    var evs = {};
    lista.forEach(function (ev) {
      if (!ev || !ev.quien) return;
      evs[_clavePareja(ev.dia, ev.franja, 'evaluacion', ev.quien)] = {
        dia: Number(ev.dia), turno: ev.franja, tipo: 'evaluacion',
        quien: ev.quien, conQuien: ev.conQuien || ''
      };
    });
    guardarParejas(mes, 'evaluacion', evs);

    // 2. El turnero: EvM/EvT a los dos lados, si les falta.
    var m = leerMes(mes);
    var sh = _ss().getSheetByName(mes);
    var quiere = {};    // dia_franja_cta → true
    lista.forEach(function (ev) {
      if (!ev || !ev.quien) return;
      quiere[Number(ev.dia) + '_' + ev.franja + '_' + ev.quien] = true;
      if (ev.conQuien) quiere[Number(ev.dia) + '_' + ev.franja + '_' + ev.conQuien] = true;
    });
    var habia = {};
    antes.forEach(function (ev) {
      habia[ev.dia + '_' + ev.franja + '_' + ev.quien] = true;
      if (ev.conQuien) habia[ev.dia + '_' + ev.franja + '_' + ev.conQuien] = true;
    });

    var escritas = 0, respetadas = [];
    var tocar = function (clave, poner) {
      var p = clave.split('_');
      var dia = Number(p[0]), franja = p[1], cta = p[2];
      if (!sh || !(m.filaDeCta || {})[cta]) return;
      var actual = normalizarCodigo((m.base[cta] || {})[dia] || '');
      var base = (franja === 'T') ? 'T' : 'M';
      var ev = (franja === 'T') ? 'EvT' : 'EvM';
      if (poner) {
        if (actual === ev) return;                 // ya lo tenía
        if (actual !== base) { respetadas.push(cta + ' d' + dia + ' (' + actual + ')'); return; }
        _aplicarTurnoCelda(sh, m, mes, cta, dia, ev, {
          tipo: 'X', origen: 'ADMIN', motivo: 'Evaluación aprobada', autor: u.cta
        });
      } else {
        if (actual !== ev) return;                 // no lo puso esto
        _aplicarTurnoCelda(sh, m, mes, cta, dia, base, {
          tipo: 'X', origen: 'ADMIN', motivo: 'Evaluación retirada', autor: u.cta
        });
      }
      escritas++;
    };
    Object.keys(quiere).forEach(function (k) { tocar(k, true); });
    Object.keys(habia).forEach(function (k) { if (!quiere[k]) tocar(k, false); });

    var f = _filaBorrador(mes, TIPO_PLAN_EVAL);
    if (f) _hojaBorradores().deleteRow(f);

    invalidarCacheMes(mes);
    _logApp('INFO', 'aplicarEvaluaciones', _mesCanon(mes) + ': ' + lista.length + ' evaluaciones, ' +
      escritas + ' celdas', u.cta);
    return {
      ok: true, evaluaciones: _evaluacionesAplicadas(mes),
      celdas: escritas, respetadas: respetadas
    };
  } finally { lock.releaseLock(); }
}
