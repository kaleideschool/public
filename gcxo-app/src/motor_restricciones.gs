/*******************************************************************************
 *
 * MOTOR DE RESTRICCIONES — Aplicación de cambios entre controladores (Fase 1)
 *
 * JavaScript puro, pegable tal cual en Google Apps Script. No usa APIs de
 * SpreadsheetApp: recibe los horarios ya leídos de la hoja y valida.
 *
 * Marco legal: RD 1001/2010 (arts. 5, 6, 7) + restricción operativa de
 * habilitación (supervisión / instrucción).
 *
 * Entrada principal:  validarBloque(base, cargos, movimientos)
 *   - base:        { "JPZ": { 1:"M", 2:"T", ... }, "ABC": {...} }   (mes por CTA)
 *   - cargos:      { "JPZ": "SUP", "ABC": "TIN", ... }
 *   - movimientos: [ { cta:"JPZ", dia:14, de:"T", a:"M" }, ... ]  (bloque atómico)
 *   - Devuelve:    { ok:Boolean, violaciones:[...], resultado:{...} }
 *
 ******************************************************************************/

// ─── Parámetros configurables (irían a la hoja CONFIG_REGLAS) ───────────────
var VERSION_MOTOR = 'motor-28-recibe-reparto';
var H = 60; // minutos por hora
var REGLAS = {
  descansoEntreJornadas: 12 * H,     // R1  ≥ 12 h
  maxJornada:            10 * H,     // R1b ≤ 10 h
  maxPeriodosCiclo:      6,          // R2  ≤ 6 periodos
  maxHorasCiclo:         50 * H,     // R3  ≤ 50 h
  descansoPostCicloFull: 60 * H,     // R4  ≥ 60 h tras ciclo completo
  descansoPostCicloRed:  48 * H,     // R4  ≥ 48 h (reducido, art. 6.3)
  gapCiclo:              48 * H,     // umbral que rompe la racha (§6.3)
  maxHorasMesRD:         200 * H,    // R5  ≤ 200 h (RD 1001/2010, art. 5.2) — referencia
  maxHorasMes:           170 * H     // R5  ≤ 170 h (convenio 2023) — cota efectiva, más estricta
};

// ─── Definición de turnos (irían a la hoja CONFIG_TURNOS) ───────────────────
// inicio/fin en minutos desde medianoche; computo en minutos.
function hm(h, m) { return h * 60 + m; }

// PROLONGACIÓN DEL HORARIO OPERATIVO (art. 47.7.a). GCXO no es H24 y tiene
// prolongación publicada en AIP, así que el servicio que cierra la dependencia
// —la tarde— computa un suplemento: 30 min si NO se efectúa, y el período
// publicado entero (1 h en GCXO) si se efectúa.
//
// ⚠️ HOY LA DEPENDENCIA NO REGISTRA los PPR efectuados: los lleva RR.HH. aparte.
// Por eso el motor computa siempre `base` y el suplemento va como parámetro y
// no sumado a mano dentro de cada 535. El día que haya de dónde leerlos, basta
// con pasar `opts.ppr = { 12: true, 19: true }` a validarBloque /
// minutosDeHorario; no hay que tocar ninguna definición de turno.
//
// Las cifras de verdad están en PARAMETROS_SEMILLA, más abajo, y se editan en
// «Admin: Parámetros». Esto es solo el valor de arranque de la tabla.
var TARDE = 505 + 30;   // 535

var CONFIG_TURNOS = {
  M:  { inicio: hm(6, 30),  fin: hm(14, 55), computo: 505,   trabajada: true,  cambiable: true,  habilitacion: null,         franja: 'M' },
  T:  { inicio: hm(14, 55), fin: hm(23, 20), computo: TARDE, prolongable: true, trabajada: true,  cambiable: true,  habilitacion: null,         franja: 'T' },
  Ms: { inicio: hm(6, 30),  fin: hm(14, 55), computo: 505,   trabajada: true,  cambiable: true,  habilitacion: 'supervisar', franja: 'M' },
  Ts: { inicio: hm(14, 55), fin: hm(23, 20), computo: TARDE, prolongable: true, trabajada: true,  cambiable: true,  habilitacion: 'supervisar', franja: 'T' },
  Mo: { inicio: hm(6, 30),  fin: hm(14, 55), computo: 505,   trabajada: true,  cambiable: true,  habilitacion: 'instruir',   franja: 'M' },
  To: { inicio: hm(14, 55), fin: hm(23, 20), computo: TARDE, prolongable: true, trabajada: true,  cambiable: true,  habilitacion: 'instruir',   franja: 'T' },
  // IMAGINARIAS. Cuentan dos cosas distintas según se activen o no:
  //   · sin activar → 1 h 30 (la ventana de localización, art. 37.1.1)
  //   · activada    → art. 45.1: "toda la duración del servicio [...] incluyendo
  //     el tiempo de relevo y el tiempo que el CTA haya estado efectivamente a
  //     disposición de ENAIRE previamente". O sea, el turno entero + la hora
  //     previa localizable. Al activarla la celda deja de poner "im" y pone "M",
  //     con fondo cian, así que el motor ya no la ve como im.
  // ⚠ El máximo sale del turno que le corresponde, NO de un número escrito a
  // mano: la tarde computa 30' más que la mañana (prolongación, art. 47.7) y la
  // it los arrastra. Antes ambas ponían 565 y la de tarde perdía esa media hora.
  // `computo` es lo REAL de una imaginaria que se queda sin activar;
  // `computoMax`, lo que valdría si se activara.
  im: { inicio: hm(5, 30),  fin: hm(7, 0),   computo: 90, computoMax: 505 + 60,   trabajada: true, cambiable: true, habilitacion: null, franja: 'im' },
  it: { inicio: hm(13, 55), fin: hm(15, 25), computo: 90, computoMax: TARDE + 60, prolongable: true, trabajada: true, cambiable: true, habilitacion: null, franja: 'it' },

  // Actividades NO intercambiables pero que SÍ computan como actividad
  // (imprescindible para ciclos y horas: una EvM cuenta en las 50 h del ciclo).
  // ⚠ VENTANAS/CÓMPUTOS POR DEFECTO, PENDIENTES DE CONFIRMAR (ver README §16).
  // provisional:true ⇒ el descanso R1 NO se evalúa contra ellas (el turnero
  // siempre cumple: una ventana inventada no puede generar violaciones).
  // EvM/EvT confirmadas por el usuario como turnos normales de evaluación.
  EvM: { inicio: hm(6, 30),  fin: hm(14, 55), computo: 505, trabajada: true, cambiable: false, habilitacion: null, franja: 'EvM' },
  EvT: { inicio: hm(14, 55), fin: hm(23, 20), computo: TARDE, prolongable: true, trabajada: true, cambiable: false, habilitacion: null, franja: 'EvT' },
  D:   { inicio: hm(7, 0),   fin: hm(15, 0),  computo: 480, trabajada: true, cambiable: false, habilitacion: null, franja: 'D',   provisional: true },
  SIM: { inicio: hm(7, 0),   fin: hm(15, 0),  computo: 480, trabajada: true, cambiable: false, habilitacion: null, franja: 'SIM', provisional: true },
  Fm:  { inicio: hm(6, 30),  fin: hm(14, 55), computo: 505, trabajada: true, cambiable: false, habilitacion: null, franja: 'Fm',  provisional: true },
  Ft:  { inicio: hm(14, 55), fin: hm(23, 20), computo: TARDE, prolongable: true, trabajada: true, cambiable: false, habilitacion: null, franja: 'Ft',  provisional: true },
  C:   { inicio: hm(9, 0),   fin: hm(17, 0),  computo: 480, trabajada: true, cambiable: false, habilitacion: null, franja: 'C',   provisional: true },
  // REDUCCIÓN DE JORNADA. NO son turnos de despacho: son la mañana y la tarde
  // normales de alguien con la jornada reducida, así que van en su ventana y
  // con su cómputo. Y por eso NO son `provisional`: quien hace un `mr` está de
  // verdad en el fanal de 06:30 a 14:55 y necesita sus 12 h de descanso.
  mr:  { inicio: hm(6, 30),  fin: hm(14, 55), computo: 505, trabajada: true, cambiable: false, habilitacion: null, franja: 'mr' },
  tr:  { inicio: hm(14, 55), fin: hm(23, 20), computo: TARDE, prolongable: true, trabajada: true, cambiable: false, habilitacion: null, franja: 'tr' },

  // No trabajados
  V:    { trabajada: false, cambiable: false, vacaciones: true },
  R:    { trabajada: false, cambiable: false },
  P:    { trabajada: false, cambiable: false },
  FORM: { trabajada: false, cambiable: false },
  OFT:  { trabajada: false, cambiable: false }
};

// ─── Qué cuenta para la DOTACIÓN ────────────────────────────────────────────
// Tres categorías por día y franja: controladores, supervisores e instructores.
// Va DECLARADO y no deducido: deducirlo de la franja o de la habilitación
// funcionaba de casualidad y se rompía con cada código nuevo.
//   'cta' → controlador
//   'sup' → supervisor
//   'ins' → instructor
//   ''    → no cubre plaza (es adicional, o no está en el fanal)
//
// ⚠️ El instructor va POR SU CUENTA, no suma al número de controladores. Antes
// contaba en los dos sitios; si una plaza de instructor tiene que tapar además
// una de controlador, hay que decirlo aquí y no deducirlo.
var DOTACION_TURNO = {
  M: 'cta',  T: 'cta',      // el servicio normal
  Mo: 'ins', To: 'ins',     // instrucción (OJT)
  Ms: 'sup', Ts: 'sup',     // supervisión
  im: '',    it: '',        // una imaginaria sin activar no está en el fanal
  EvM: '',   EvT: '',       // las evaluaciones son adicionales
  Fm: '',    Ft: '',        // la formación en fanal, igual
  // ⚠ PENDIENTE DE CONFIRMAR: si quien tiene la jornada reducida cubre plaza
  // ese día o no. A cero es lo conservador —avisaría de un hueco que quizá
  // esté cubierto—, al revés se callaría un hueco de verdad.
  mr: '',    tr: '',
  D: '', SIM: '', C: ''     // fuera del fanal
};
function rolDotacion(codigo) {
  return DOTACION_TURNO[normalizarCodigo(codigo)] || '';
}

// En qué franja del día se está, que NO es lo mismo que `def.franja`: una EvM
// tiene franja 'EvM' pero se trabaja por la mañana, y quien la hace está en el
// fanal con los demás. Sale de la ventana, que es de donde salen sus horas.
function franjaOperativa(codigo) {
  var perf = _PERFIL_TURNO[normalizarCodigo(codigo)];
  if (!perf) return '';
  if (perf.ventana === 'manana' || perf.ventana === 'evalManana') return 'M';
  if (perf.ventana === 'tarde' || perf.ventana === 'evalTarde') return 'T';
  return '';
}

// ─── Parámetros de cómputo ──────────────────────────────────────────────────
// Todo lo que es una CIFRA DEL CONVENIO y no una decisión del código vive aquí,
// con el artículo al lado. Se edita en «Admin: Parámetros» y se guarda en
// properties; esto son solo los valores de arranque, igual que PUESTOS_DEFECTO.
// El motor sigue funcionando suelto (tests en Node) sin que nadie lo configure.
//
// Dos suplementos de relevo van A CERO a propósito: el convenio los recoge,
// pero antes de aplicarlos hay que confirmar datos de la dependencia (ver más
// abajo). Ponerlos a cero y no aplicarlos es honesto; ponerlos con su cifra sin
// confirmar sería inventar horas que rechazan cambios legales.
var PARAMETROS_SEMILLA = {
  // Límites de jornada — RD 1001/2010 y convenio
  maxHorasMes:            170,   // h/mes (convenio 2023; el RD permite 200)
  maxHorasCiclo:          50,    // h/ciclo
  maxPeriodosCiclo:       6,     // periodos seguidos
  maxJornada:             10,    // h de una jornada
  descansoEntreJornadas:  12,    // h
  descansoPostCicloFull:  60,    // h tras ciclo completo
  descansoPostCicloRed:   48,    // h (reducido, art. 6.3)

  // VENTANAS. Minutos desde medianoche. Son el horario operativo de la
  // dependencia, y de ellas sale TODO lo demás: la duración del servicio no es
  // un campo aparte, es fin − inicio. Tenerla suelta permitía cambiar el
  // cómputo de la mañana a 520 sin que la ventana 06:30–14:55 se enterara, y es
  // la ventana la que decide los descansos entre jornadas.
  inicioManana:           6 * 60 + 30,    // 06:30
  finManana:             14 * 60 + 55,    // 14:55
  inicioTarde:           14 * 60 + 55,    // 14:55
  finTarde:              23 * 60 + 20,    // 23:20
  // Las evaluaciones van APARTE de la mañana y la tarde: hoy coinciden, pero
  // una EvM no tiene por qué durar lo que un servicio normal.
  inicioEvalManana:       6 * 60 + 30,    // 06:30  — EvM
  finEvalManana:         14 * 60 + 55,    // 14:55
  inicioEvalTarde:       14 * 60 + 55,    // 14:55  — EvT
  finEvalTarde:          23 * 60 + 20,    // 23:20
  inicioDespacho:         7 * 60,         // 07:00  — D y SIM
  finDespacho:           15 * 60,         // 15:00
  inicioCurso:            9 * 60,         // 09:00  — C
  finCurso:              17 * 60,         // 17:00

  // La ventana de la imaginaria NO se teclea: sale de la hora de entrada del
  // turno al que acompaña (art. 37.1.1, «desde una hora antes hasta media hora
  // después de la hora de entrada»). Cambiar la entrada de la mañana mueve la
  // imaginaria sola, que es lo correcto.
  imaginariaAntes:        60,    // min antes de la entrada
  imaginariaDespues:      30,    // min después de la entrada

  // Prolongación del horario operativo — art. 47.7.a. Solo la tarde, que es
  // la que cierra la dependencia. GCXO la tiene publicada en AIP, 1 h.
  prolongacionBase:       30,    // si NO se efectúa
  prolongacionEfectuada:  60,    // si se efectúa (el período publicado)

  // Cómputo de la imaginaria — arts. 37.1.1 y 45.1. `imaginariaSinActivar` va
  // suelto y NO derivado de la ventana a propósito: hoy coinciden (60+30=90),
  // pero el 45.1 habla del 20 % de la duración del servicio «o el tiempo a
  // disposición, lo que sea superior», así que pueden separarse.
  imaginariaSinActivar:   90,    // lo que computa si no se activa
  imaginariaHoraPrevia:   60,    // lo que se añade al turno al activarse

  // Suplementos de relevo — arts. 47.9 y 47.10.
  relevoEntradaTarde:     0,     // art. 47.9: 5' al que entra de tarde en no-H24 — PENDIENTE
  briefingInstruccion:    0,     // art. 47.9: 15' por tareas OJTI o de evaluación — PENDIENTE
  // GCXO es GRUPO 5 (confirmado 2026-08-16), o sea el tramo «Grupos 4 a 7»:
  // 3,5' a cada CTA por servicio. Los grupos 1-3 llevan 7,5' y las
  // dependencias de una sola posición integrada (grupo 8) quedan exceptuadas.
  relevoDentroServicio:   3.5    // art. 47.10
};
var PARAMETROS = _clonarParams(PARAMETROS_SEMILLA);

// Los campos que son una HORA del día y no una cantidad: se editan como HH:MM
// y se guardan en minutos desde medianoche. Cada ventana, con su pareja.
var VENTANAS = [
  { id: 'manana',   inicio: 'inicioManana',   fin: 'finManana' },
  { id: 'tarde',    inicio: 'inicioTarde',    fin: 'finTarde' },
  { id: 'evalManana', inicio: 'inicioEvalManana', fin: 'finEvalManana' },
  { id: 'evalTarde',  inicio: 'inicioEvalTarde',  fin: 'finEvalTarde' },
  { id: 'despacho', inicio: 'inicioDespacho', fin: 'finDespacho' },
  { id: 'curso',    inicio: 'inicioCurso',    fin: 'finCurso' }
];
function esCampoHora(id) {
  for (var i = 0; i < VENTANAS.length; i++) {
    if (VENTANAS[i].inicio === id || VENTANAS[i].fin === id) return true;
  }
  return false;
}

// Qué ventana y qué suplementos le tocan a cada turno.
//   ventana  → de dónde salen inicio, fin y la duración
//   tarde    → cierra la dependencia: lleva prolongación y relevo de entrada
//   briefing → tareas OJTI o de evaluación (art. 47.9)
//   servicio → es un servicio de fanal: entra en el relevo del art. 47.10
var _PERFIL_TURNO = {
  M:  { ventana: 'manana', tarde: false, briefing: false, servicio: true },
  Ms: { ventana: 'manana', tarde: false, briefing: false, servicio: true },
  Mo: { ventana: 'manana', tarde: false, briefing: true,  servicio: true },
  EvM:{ ventana: 'evalManana', tarde: false, briefing: true, servicio: true },
  Fm: { ventana: 'manana', tarde: false, briefing: false, servicio: true },
  T:  { ventana: 'tarde',  tarde: true,  briefing: false, servicio: true },
  Ts: { ventana: 'tarde',  tarde: true,  briefing: false, servicio: true },
  To: { ventana: 'tarde',  tarde: true,  briefing: true,  servicio: true },
  EvT:{ ventana: 'evalTarde',  tarde: true,  briefing: true, servicio: true },
  Ft: { ventana: 'tarde',  tarde: true,  briefing: false, servicio: true },
  // Jornada reducida: mismo turno que M y T, misma ventana, mismos suplementos.
  mr: { ventana: 'manana', tarde: false, briefing: false, servicio: true },
  tr: { ventana: 'tarde',  tarde: true,  briefing: false, servicio: true },
  // Fuera del fanal: computan su ventana pelada, sin suplemento ninguno.
  D:  { ventana: 'despacho', tarde: false, briefing: false, servicio: false },
  SIM:{ ventana: 'despacho', tarde: false, briefing: false, servicio: false },
  C:  { ventana: 'curso',    tarde: false, briefing: false, servicio: false }
};

function _clonarParams(o) {
  var c = {};
  for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) c[k] = o[k];
  return c;
}

function _ventanaDe(id) {
  for (var i = 0; i < VENTANAS.length; i++) if (VENTANAS[i].id === id) return VENTANAS[i];
  return null;
}
function _duracionVentana(id) {
  var v = _ventanaDe(id);
  if (!v) return 0;
  return PARAMETROS[v.fin] - PARAMETROS[v.inicio];
}

// Lo que computa un turno: su ventana pelada más los suplementos que le tocan.
function _computoServicio(perf) {
  var p = PARAMETROS;
  var t = _duracionVentana(perf.ventana);
  if (perf.tarde)    t += p.prolongacionBase + p.relevoEntradaTarde;  // la mañana abre, no releva a nadie
  if (perf.servicio) t += p.relevoDentroServicio;
  if (perf.briefing) t += p.briefingInstruccion;
  return t;
}

// Aplica un juego de parámetros: recalcula REGLAS y los cómputos de los turnos.
// Sin argumento, restablece los de arranque. Ignora las claves que no conoce y
// las que no son un número, para que un valor corrupto en properties no deje la
// app sin motor.
function configurarParametros(p) {
  PARAMETROS = _clonarParams(PARAMETROS_SEMILLA);
  if (p) {
    for (var k in PARAMETROS_SEMILLA) {
      if (!Object.prototype.hasOwnProperty.call(p, k)) continue;
      var bruto = p[k];
      // ⚠ Number(null), Number('') y Number(false) valen 0, y un 0 pasa
      // cualquier comprobación numérica: una celda vacía en el panel dejaría
      // la tarde computando cero minutos. Hay que descartarlos ANTES.
      if (bruto === null || bruto === undefined || bruto === '') continue;
      if (typeof bruto === 'boolean') continue;
      var v = Number(bruto);
      if (isNaN(v) || !isFinite(v) || v < 0) continue;
      if (esCampoHora(k) && v > 1439) continue;   // no hay hora 25
      PARAMETROS[k] = v;
    }
  }
  // Una ventana del revés (fin ≤ inicio) daría duraciones negativas y dejaría
  // el motor aprobando cualquier cosa. Se descarta la pareja entera y se vuelve
  // a la semilla, que es lo único seguro que se puede hacer sin adivinar.
  for (var i = 0; i < VENTANAS.length; i++) {
    var w = VENTANAS[i];
    if (PARAMETROS[w.fin] > PARAMETROS[w.inicio]) continue;
    PARAMETROS[w.inicio] = PARAMETROS_SEMILLA[w.inicio];
    PARAMETROS[w.fin]    = PARAMETROS_SEMILLA[w.fin];
  }
  var q = PARAMETROS;

  REGLAS.maxHorasMes           = q.maxHorasMes * H;
  REGLAS.maxHorasCiclo         = q.maxHorasCiclo * H;
  REGLAS.maxPeriodosCiclo      = q.maxPeriodosCiclo;
  REGLAS.maxJornada            = q.maxJornada * H;
  REGLAS.descansoEntreJornadas = q.descansoEntreJornadas * H;
  REGLAS.descansoPostCicloFull = q.descansoPostCicloFull * H;
  REGLAS.descansoPostCicloRed  = q.descansoPostCicloRed * H;

  for (var cod in _PERFIL_TURNO) {
    if (!CONFIG_TURNOS[cod]) continue;
    var perf = _PERFIL_TURNO[cod], w = _ventanaDe(perf.ventana);
    CONFIG_TURNOS[cod].inicio      = q[w.inicio];
    CONFIG_TURNOS[cod].fin         = q[w.fin];
    CONFIG_TURNOS[cod].computo     = _computoServicio(perf);
    CONFIG_TURNOS[cod].prolongable = perf.tarde;
  }

  // Las imaginarias cuelgan del turno al que acompañan y no se teclean:
  //   ventana → de una hora antes de la entrada a media hora después (37.1.1)
  //   computo → la localización si no se activa
  //   máximo  → el servicio entero de su franja + la hora previa (45.1)
  var perfM = { ventana: 'manana', tarde: false, briefing: false, servicio: true };
  var perfT = { ventana: 'tarde',  tarde: true,  briefing: false, servicio: true };
  CONFIG_TURNOS.im.inicio = q.inicioManana - q.imaginariaAntes;
  CONFIG_TURNOS.im.fin    = q.inicioManana + q.imaginariaDespues;
  CONFIG_TURNOS.it.inicio = q.inicioTarde  - q.imaginariaAntes;
  CONFIG_TURNOS.it.fin    = q.inicioTarde  + q.imaginariaDespues;
  CONFIG_TURNOS.im.computo    = q.imaginariaSinActivar;
  CONFIG_TURNOS.it.computo    = q.imaginariaSinActivar;
  CONFIG_TURNOS.im.computoMax = _computoServicio(perfM) + q.imaginariaHoraPrevia;
  CONFIG_TURNOS.it.computoMax = _computoServicio(perfT) + q.imaginariaHoraPrevia;
  CONFIG_TURNOS.it.prolongable = true;

  return PARAMETROS;
}

// Se aplica la semilla NADA MÁS CARGAR. Sin esto, los `computo` escritos a mano
// en CONFIG_TURNOS y los que salen de la semilla podrían discrepar —y ya lo
// hicieron: la tabla decía 505 mientras la semilla computaba 508,5 por el
// relevo del art. 47.10—. Los números literales de arriba son un punto de
// partida legible; el que vale es este. La fuente es una sola.
configurarParametros();

// ─── Puestos y competencias ─────────────────────────────────────────────────
// Qué puede hacer cada puesto NO se decide aquí: se declara en la hoja PUESTOS
// y se carga con configurarPuestos(). Esto son solo los valores de arranque,
// para que el motor siga funcionando suelto (tests en Node) y para sembrar la
// hoja la primera vez.
//
// Que estuviera escrito en el código tenía un coste real: la hoja usa el puesto
// "TINS" y aquí ponía "TIN", así que esos instructores quedaban sin ninguna
// competencia y la regla ROL les impedía recibir un Mo/To. Manda la hoja.
var PUESTOS_DEFECTO = [
  // ALUMNO es un puesto como los demás, y por eso: se adquiere y se deja, y
  // CARGOS_CTA guarda cuándo — que es exactamente lo que pasa cuando alguien
  // termina la instrucción. Sin ninguna capacidad y sin cambiar turnos: no
  // supervisa, no instruye, no propone cambios ni sale como candidato.
  { puesto: 'ALUMNO', capacidades: [], excluido: true },
  { puesto: 'SUP',    capacidades: ['supervisar'],                          excluido: false },
  { puesto: 'TSUP',   capacidades: ['supervisar', 'evaluar'],               excluido: false },
  { puesto: 'SUPIN',  capacidades: ['supervisar', 'instruir', 'evaluar'],   excluido: false },
  { puesto: 'INS',    capacidades: ['instruir'],                            excluido: false },
  { puesto: 'TIN',    capacidades: ['instruir', 'evaluar'],                 excluido: false },
  { puesto: 'TINS',   capacidades: ['instruir'],                excluido: false },
  // SUPEX: controlador raso que puede supervisar SOLO cuando no hay nadie más.
  // Es un puesto excepcional: entra en el reparto en segunda vuelta y jamás
  // compite con un SUP, SUPIN o TSUP aunque tenga menos acumulados.
  { puesto: 'SUPEX',  capacidades: ['supervisar'], excluido: false, excepcional: true },
  // Jefaturas: fuera del circuito de cambios y, de arranque, SIN competencias,
  // que es como se comportaban cuando la lista estaba escrita en el código.
  // Darles 'supervisar' aquí las metería en el reparto de supervisiones sin que
  // nadie lo hubiera pedido. Si deben entrar, se marca en la hoja PUESTOS.
  // ⚠ Las jefaturas tampoco entran en el REPARTO de servicios: no hacen
  // extras, ni voluntarias, ni COS, ni se les activa una imaginaria, ni se
  // desprograman. Salen en la tabla de acumulados —su histórico existe— pero
  // nunca en la lista de «a quién le toca». Va por PUESTO, no por persona: la
  // jefatura cambia de manos y el que la deja vuelve al reparto solo.
  { puesto: 'JTWR',   capacidades: [], excluido: true, sinReparto: true },
  { puesto: 'JSUPIN', capacidades: [], excluido: true, sinReparto: true }
];

var CONFIG_HABILITACIONES = {};   // puesto → ['supervisar','instruir']
var CARGOS_EXCLUIDOS = {};        // puesto → true (jefaturas: fuera del circuito)
var PUESTOS_EXCEPCIONALES = {};   // puesto → true (solo si no hay nadie más)
var PUESTOS_SIN_REPARTO = {};     // puesto → true (no recibe extras/HHVV/COS…)

// Sustituye la configuración viva. `lista` tiene la forma de PUESTOS_DEFECTO.
// Con una lista vacía o inválida se queda con los valores de arranque: es
// preferible seguir funcionando que dejar a todo el mundo sin competencias.
function configurarPuestos(lista) {
  if (!lista || !lista.length) lista = PUESTOS_DEFECTO;
  CONFIG_HABILITACIONES = {};
  CARGOS_EXCLUIDOS = {};
  PUESTOS_EXCEPCIONALES = {};
  PUESTOS_SIN_REPARTO = {};
  lista.forEach(function (p) {
    var nombre = String(p.puesto || '').trim().toUpperCase();
    if (!nombre) return;
    CONFIG_HABILITACIONES[nombre] = (p.capacidades || []).slice();
    if (p.excluido) CARGOS_EXCLUIDOS[nombre] = true;
    if (p.excepcional) PUESTOS_EXCEPCIONALES[nombre] = true;
    if (p.sinReparto) PUESTOS_SIN_REPARTO[nombre] = true;
  });
  return { puestos: Object.keys(CONFIG_HABILITACIONES).length };
}
configurarPuestos(PUESTOS_DEFECTO); // arranque

function capacidadesDeCargo(cargo) {
  return CONFIG_HABILITACIONES[String(cargo || '').trim().toUpperCase()] || [];
}

// Puestos que tienen una capacidad ('supervisar' / 'instruir'). Fuente única
// para saber quién puede recibir un Ms/Ts o un Mo/To, y por tanto quién entra
// en el reparto de supervisiones o de instrucción.
// Por defecto NO devuelve los excepcionales: quien tiene el puesto de verdad
// va primero, y los excepcionales solo entran si no queda nadie. Pásale
// `true` para pedir justo los excepcionales.
function cargosConCapacidad(capacidad, soloExcepcionales) {
  var out = [];
  for (var cargo in CONFIG_HABILITACIONES) {
    if (CONFIG_HABILITACIONES[cargo].indexOf(capacidad) === -1) continue;
    if (!!PUESTOS_EXCEPCIONALES[cargo] !== !!soloExcepcionales) continue;
    out.push(cargo);
  }
  return out;
}
function esPuestoExcepcional(cargo) {
  return !!PUESTOS_EXCEPCIONALES[String(cargo || '').trim().toUpperCase()];
}
// ¿Entra este puesto en el reparto de extras, voluntarias, COS, activaciones y
// desprogramaciones? Lo declara la hoja PUESTOS, columna «Recibe servicios».
// En blanco = SÍ: lo normal es participar, y lo excepcional se marca.
function recibeReparto(cargo) {
  return !PUESTOS_SIN_REPARTO[String(cargo || '').trim().toUpperCase()];
}

// ─── Normalización de códigos ───────────────────────────────────────────────
// Acepta variantes con mayúsculas/minúsculas/espacios y el orden s/o antepuesto.
function normalizarCodigo(v) {
  if (v === null || v === undefined || v === '') return 'libre';
  if (typeof v !== 'string') return v;
  var t = v.trim();
  if (t === '') return 'libre';
  var u = t.toUpperCase();
  // Turnos base
  if (u === 'M') return 'M';
  if (u === 'T') return 'T';
  // Supervisión: Ms, sM
  if (u === 'MS' || u === 'SM') return 'Ms';
  if (u === 'TS' || u === 'ST') return 'Ts';
  // Instrucción: Mo, oM
  if (u === 'MO' || u === 'OM') return 'Mo';
  if (u === 'TO' || u === 'OT') return 'To';
  // Imaginarias
  if (u === 'IM') return 'im';
  if (u === 'IT') return 'it';
  // Actividades no intercambiables que computan
  if (u === 'EVM') return 'EvM';
  if (u === 'EVT') return 'EvT';
  if (u === 'D') return 'D';
  if (u === 'SIM') return 'SIM';
  if (u === 'FM') return 'Fm';
  if (u === 'FT') return 'Ft';
  if (u === 'C') return 'C';
  if (u === 'TR') return 'tr';
  if (u === 'MR') return 'mr';
  // No trabajados
  if (u === 'V') return 'V';
  if (u === 'R') return 'R';
  if (u === 'P') return 'P';
  if (u === 'FORM' || u === 'FORMACION' || u === 'FORMACIÓN') return 'FORM';
  if (u === 'OFT' || u === 'OT.' ) return 'OFT';
  if (u === 'LIBRE') return 'libre';
  return t; // desconocido: se devuelve tal cual (se tratará como no trabajado)
}

function getTurnoDef(codigo) {
  var c = normalizarCodigo(codigo);
  return CONFIG_TURNOS[c] || null;
}
function esTrabajada(codigo) {
  var d = getTurnoDef(codigo);
  return !!(d && d.trabajada);
}
// Un código es intercambiable solo si está definido y marcado cambiable.
// Los códigos desconocidos (Despacho 'D', evaluaciones, simulador…) → NO.
function esCambiable(codigo) {
  var d = getTurnoDef(codigo);
  return !!(d && d.cambiable);
}

// ─── Construcción de jornadas absolutas y ordenadas ─────────────────────────
// Cuánto computa una jornada. Solo es ambiguo en las imaginarias:
//
//   · Una imaginaria YA PASADA sin activar no se va a activar nunca, así que
//     computa lo real: 1 h 30. Contarla como 9 h 25 son horas que no existen,
//     y a final de mes eso rechaza cambios perfectamente legales — alguien con
//     cuatro imaginarias sin activar aparecería con casi 30 h de más.
//   · Una imaginaria por delante SÍ puede activarse, así que computa el máximo.
//
// `opts.diaCorte` es el día a partir del cual las imaginarias siguen vivas
// (normalmente hoy). Sin él se cuenta todo al máximo, que es lo conservador.
// `opts.maximo:false` fuerza la lectura real de todas, para informar.
//
// `opts.ppr` es el otro suplemento: los días en que la prolongación del horario
// operativo se efectuó de verdad, como `{ 12: true, 19: true }`. Ver
// PARAMETROS_SEMILLA abajo. Sin él, todas las tardes computan la base, que es lo que
// pasa hoy porque en la dependencia no se registra.
function _computoDeJornada(def, dia, opts) {
  var extra = _extraProlongacion(def, dia, opts);
  // Las dos ramas de 1 h 30 NUNCA llevan el suplemento: una imaginaria que no
  // se activa no presta servicio, así que no hay horario que prolongar.
  if (!def.computoMax) return def.computo + extra;
  if (opts && opts.maximo === false) return def.computo;
  var corte = opts && opts.diaCorte;
  if (corte && dia < corte) return def.computo;   // pasó y no se activó
  return def.computoMax + extra;
}

// Lo que hay que AÑADIR a un servicio de tarde por haberse efectuado el PPR:
// la diferencia hasta el período publicado, porque la base ya va dentro del
// `computo` del turno. Cero si no consta, que es el caso normal.
function _extraProlongacion(def, dia, opts) {
  if (!def.prolongable) return 0;
  var ppr = opts && opts.ppr;
  if (!ppr || !ppr[dia]) return 0;
  return PARAMETROS.prolongacionEfectuada - PARAMETROS.prolongacionBase;
}

function construirJornadas(schedule, opts) {
  var jornadas = [];
  for (var diaStr in schedule) {
    if (!Object.prototype.hasOwnProperty.call(schedule, diaStr)) continue;
    var codigo = normalizarCodigo(schedule[diaStr]);
    var def = CONFIG_TURNOS[codigo];
    if (!def || !def.trabajada) continue;
    var dia = parseInt(diaStr, 10);
    jornadas.push({
      dia: dia,
      codigo: codigo,
      inicioAbs: dia * 1440 + def.inicio,
      finAbs: dia * 1440 + def.fin,
      computo: _computoDeJornada(def, dia, opts),
      habilitacion: def.habilitacion,
      franja: def.franja,
      provisional: def.provisional === true
    });
  }
  jornadas.sort(function (a, b) { return a.inicioAbs - b.inicioAbs; });
  return jornadas;
}

// Minutos de actividad de un horario. Dos lecturas:
//   maximo:false → lo REAL: las imaginarias que siguen sin activar valen 1h30
//   maximo:true  → el POTENCIAL: como si se activaran todas
// La diferencia entre ambas es lo que separa las columnas HORAS y H.MAX. del
// cuadrante, y es también lo que hace que una imaginaria «gaste» margen
// horario mientras esté viva aunque al final no se active.
function minutosDeHorario(schedule, opts) {
  var js = construirJornadas(schedule, opts);
  var t = 0;
  for (var i = 0; i < js.length; i++) t += js[i].computo;
  return t;
}

// ─── Validadores por controlador ────────────────────────────────────────────

// V-R1: descanso >= 12 h entre jornadas consecutivas; y jornada <= 10 h.
function vR1(cta, jornadas) {
  var viol = [];
  for (var i = 0; i < jornadas.length; i++) {
    // Las ventanas provisionales (sin confirmar) no generan violaciones de
    // descanso: el turnero publicado siempre cumple, así que un R1 contra una
    // ventana inventada sería un falso positivo del motor, no de la persona.
    if (jornadas[i].provisional) continue;
    var dur = jornadas[i].finAbs - jornadas[i].inicioAbs;
    if (dur > REGLAS.maxJornada) {
      viol.push(_v('R1b', cta, jornadas[i].dia,
        'Jornada de ' + _h(dur) + ' > ' + _h(REGLAS.maxJornada)));
    }
    if (i > 0 && !jornadas[i - 1].provisional) {
      var descanso = jornadas[i].inicioAbs - jornadas[i - 1].finAbs;
      if (descanso < REGLAS.descansoEntreJornadas) {
        viol.push(_v('R1', cta, jornadas[i].dia,
          'Descanso de ' + _h(descanso) + ' entre día ' + jornadas[i - 1].dia +
          ' (' + jornadas[i - 1].codigo + ') y día ' + jornadas[i].dia +
          ' (' + jornadas[i].codigo + ') < ' + _h(REGLAS.descansoEntreJornadas)));
      }
    }
  }
  return viol;
}

// Agrupa jornadas en ciclos según el RD (art. 6.1): el ciclo es una cadena de
// PERIODOS DE ACTIVIDAD consecutivos, NO de días naturales. Solo lo rompe un
// descanso >= 48 h entre el fin de un periodo y el inicio del siguiente; un
// día libre por medio con menos de 48 h NO cierra el ciclo: lo continúa
// (p.ej. Ms el 18, libre el 19, im el 20 → mismo ciclo 18–20).
function agruparCiclos(jornadas) {
  var ciclos = [];
  var actual = null;
  for (var i = 0; i < jornadas.length; i++) {
    if (actual === null) {
      actual = { jornadas: [jornadas[i]], horas: jornadas[i].computo, gapPosterior: null };
    } else {
      var gap = jornadas[i].inicioAbs - jornadas[i - 1].finAbs;
      if (gap >= REGLAS.gapCiclo) { // descanso entre ciclos: cierra el actual
        actual.gapPosterior = gap;
        ciclos.push(actual);
        actual = { jornadas: [jornadas[i]], horas: jornadas[i].computo, gapPosterior: null };
      } else {                       // <48h: el ciclo continúa (haya o no día libre)
        actual.jornadas.push(jornadas[i]);
        actual.horas += jornadas[i].computo;
      }
    }
  }
  if (actual !== null) ciclos.push(actual);
  return ciclos;
}

// V-R2, V-R3, V-R4 sobre los ciclos.
function vCiclos(cta, jornadas) {
  var viol = [];
  var ciclos = agruparCiclos(jornadas);
  for (var i = 0; i < ciclos.length; i++) {
    var c = ciclos[i];
    var nPeriodos = c.jornadas.length;
    var d0 = c.jornadas[0].dia;
    var dN = c.jornadas[nPeriodos - 1].dia;

    // Si el ciclo abarca más días que periodos, hay huecos <48h por medio que
    // NO lo cierran; se menciona para que el motivo se lea en términos operativos.
    var encadenado = (dN - d0 + 1) > nPeriodos
      ? ' (los descansos intermedios de <48h no cierran el ciclo)' : '';

    if (nPeriodos > REGLAS.maxPeriodosCiclo) {
      viol.push(_v('R2', cta, d0,
        'Ciclo días ' + d0 + '–' + dN + encadenado + ': ' + nPeriodos +
        ' periodos > ' + REGLAS.maxPeriodosCiclo));
    }
    if (c.horas > REGLAS.maxHorasCiclo) {
      viol.push(_v('R3', cta, d0,
        'Ciclo días ' + d0 + '–' + dN + encadenado + ': suma ' + _h(c.horas) +
        ' > ' + _h(REGLAS.maxHorasCiclo)));
    }
    // R4: si el ciclo llegó al tope (6 periodos o 50 h) y hay ciclo posterior,
    // el descanso de cierre debe ser >= 60 h.
    // R4: los descansos que cierran un ciclo son >= 48 h por definición (es lo
    // que corta la cadena). Solo queda exigir >= 60 h cuando el ciclo quedó
    // LLENO (6 periodos o 50 h), art. 6.1.
    if (c.gapPosterior !== null) {
      var lleno = (nPeriodos >= REGLAS.maxPeriodosCiclo) || (c.horas >= REGLAS.maxHorasCiclo);
      if (lleno && c.gapPosterior < REGLAS.descansoPostCicloFull) {
        viol.push(_v('R4', cta, dN,
          'Descanso tras ciclo completo (días ' + d0 + '–' + dN + ') de ' +
          _h(c.gapPosterior) + ' < ' + _h(REGLAS.descansoPostCicloFull)));
      }
    }
  }
  return viol;
}

/// V-R5: horas de actividad del mes <= 170 h (convenio). Con horarios
// extendidos a meses vecinos, opts {mesDesde, mesHasta} limita la suma a los
// días del mes propio (los días ≤0 y >N solo cuentan para descansos y ciclos).
function vR5(cta, jornadas, opts) {
  var d1 = (opts && opts.mesDesde != null) ? opts.mesDesde : -Infinity;
  var d2 = (opts && opts.mesHasta != null) ? opts.mesHasta : Infinity;
  var total = 0;
  for (var i = 0; i < jornadas.length; i++) {
    if (jornadas[i].dia >= d1 && jornadas[i].dia <= d2) total += jornadas[i].computo;
  }
  if (total > REGLAS.maxHorasMes) {
    return [_v('R5', cta, null,
      'Actividad mensual de ' + _h(total) + ' > ' + _h(REGLAS.maxHorasMes) + ' (convenio)')];
  }
  return [];
}

// Valida el horario completo de un controlador (R1..R5). El schedule puede
// incluir días de meses vecinos en numeración continua (≤0 anterior, >N
// siguiente): descansos y ciclos se evalúan sobre la línea temporal completa.
function validarHorarioIndividual(cta, schedule, opts) {
  var jornadas = construirJornadas(schedule, opts);
  var viol = [];
  viol = viol.concat(vR1(cta, jornadas));
  viol = viol.concat(vCiclos(cta, jornadas));
  viol = viol.concat(vR5(cta, jornadas, opts));
  return viol;
}

// ─── Aplicación de un bloque de movimientos (atómico) ───────────────────────
function clonarBase(base) {
  var out = {};
  for (var cta in base) {
    if (!Object.prototype.hasOwnProperty.call(base, cta)) continue;
    out[cta] = {};
    for (var d in base[cta]) {
      if (Object.prototype.hasOwnProperty.call(base[cta], d)) out[cta][d] = base[cta][d];
    }
  }
  return out;
}

// Aplica los movimientos sobre una copia. Devuelve { resultado, errores }.
function aplicarMovimientos(base, movimientos) {
  var res = clonarBase(base);
  var errores = [];
  for (var i = 0; i < movimientos.length; i++) {
    var m = movimientos[i];
    if (!res[m.cta]) res[m.cta] = {};
    var actual = normalizarCodigo(res[m.cta][m.dia]);
    var de = normalizarCodigo(m.de);
    var a = normalizarCodigo(m.a);

    // El estado de partida debe coincidir con lo que el usuario cree.
    if (actual !== de) {
      errores.push(_v('ESTADO', m.cta, m.dia,
        'Se esperaba "' + de + '" el día ' + m.dia + ' pero hay "' + actual + '"'));
      continue;
    }
    // No se puede ceder un turno no cambiable (V, formación, of. técnica).
    var defDe = CONFIG_TURNOS[de];
    if (de !== 'libre' && defDe && defDe.cambiable === false) {
      errores.push(_v('NO_CAMBIABLE', m.cta, m.dia,
        'El turno "' + de + '" del día ' + m.dia + ' no es intercambiable'));
      continue;
    }
    // No se puede aceptar un turno durante vacaciones (ni sobre V).
    if (actual === 'V' && a !== 'libre') {
      errores.push(_v('VACACIONES', m.cta, m.dia,
        'No puede aceptar turno el día ' + m.dia + ' (vacaciones)'));
      continue;
    }
    // Aplicar
    if (a === 'libre') delete res[m.cta][m.dia];
    else res[m.cta][m.dia] = a;
  }
  return { resultado: res, errores: errores };
}

// V-ROL: turnos especiales solo a quien tenga la habilitación.
function vRol(movimientos, cargos) {
  var viol = [];
  for (var i = 0; i < movimientos.length; i++) {
    var m = movimientos[i];
    var a = normalizarCodigo(m.a);
    var def = CONFIG_TURNOS[a];
    if (def && def.habilitacion) {
      var caps = capacidadesDeCargo(cargos[m.cta]);
      if (caps.indexOf(def.habilitacion) === -1) {
        viol.push(_v('ROL', m.cta, m.dia,
          'El día ' + m.dia + ' recibe "' + a + '" (requiere ' + def.habilitacion +
          ') pero el cargo "' + (cargos[m.cta] || '—') + '" no está habilitado'));
      }
    }
  }
  return viol;
}

// V-COB: cada franja de servicio (M/T/im/it) de cada día conserva su cobertura.
//
// ⚠️ Solo vale para los INTERCAMBIOS entre compañeros, donde nadie puede dejar
// un turno sin cubrir. NO vale para las acciones de admin —activar una
// imaginaria, nombrar una extra, una voluntaria, un COS, una baja—, que
// cambian la cobertura A PROPÓSITO: activar la im de alguien la convierte en
// su M, así que la franja im baja y la M sube, y eso no es un incumplimiento,
// es la operación. Se desactiva con `opts.cobertura = false`.
function vCobertura(base, resultado) {
  var viol = [];
  var antes = _contarFranjas(base);
  var despues = _contarFranjas(resultado);
  var claves = {};
  for (var k in antes) claves[k] = true;
  for (var k2 in despues) claves[k2] = true;
  for (var clave in claves) {
    var a = antes[clave] || 0;
    var d = despues[clave] || 0;
    if (a !== d) {
      var partes = clave.split('|');
      viol.push(_v('COB', null, parseInt(partes[0], 10),
        'Cobertura franja ' + partes[1] + ' del día ' + partes[0] +
        ' pasa de ' + a + ' a ' + d + ' (no se conserva)'));
    }
  }
  return viol;
}
function _contarFranjas(schedules) {
  var cont = {};
  for (var cta in schedules) {
    if (!Object.prototype.hasOwnProperty.call(schedules, cta)) continue;
    for (var dia in schedules[cta]) {
      if (!Object.prototype.hasOwnProperty.call(schedules[cta], dia)) continue;
      var def = getTurnoDef(schedules[cta][dia]);
      if (!def || !def.trabajada) continue;
      var clave = dia + '|' + def.franja;
      cont[clave] = (cont[clave] || 0) + 1;
    }
  }
  return cont;
}

// ─── Entrada principal ──────────────────────────────────────────────────────
// opts (opcional): { mesDesde, mesHasta } para limitar el cómputo mensual (R5)
// cuando el horario incluye días de meses vecinos.
function validarBloque(base, cargos, movimientos, opts) {
  var viol = [];

  // 1) Aplicar movimientos (errores de estado / no cambiable / vacaciones)
  var ap = aplicarMovimientos(base, movimientos);
  viol = viol.concat(ap.errores);

  // 2) Habilitación
  viol = viol.concat(vRol(movimientos, cargos || {}));

  // 3) Cobertura conservada — salvo que se pida lo contrario (ver vCobertura)
  if (!opts || opts.cobertura !== false) {
    viol = viol.concat(vCobertura(base, ap.resultado));
  }

  // 4) Reglas legales sobre cada controlador afectado
  var afectados = {};
  for (var i = 0; i < movimientos.length; i++) afectados[movimientos[i].cta] = true;
  for (var cta in afectados) {
    if (!Object.prototype.hasOwnProperty.call(afectados, cta)) continue;
    viol = viol.concat(validarHorarioIndividual(cta, ap.resultado[cta] || {}, opts));
  }

  return { ok: viol.length === 0, violaciones: viol, resultado: ap.resultado };
}

// ─── Utilidades de formato ──────────────────────────────────────────────────
function _v(regla, cta, dia, detalle) {
  return { regla: regla, cta: cta, dia: dia, detalle: detalle };
}
function _h(min) {
  var s = min < 0 ? '-' : '';
  var m = Math.abs(min);
  var hh = Math.floor(m / 60);
  var mm = m % 60;
  return s + hh + 'h' + (mm < 10 ? '0' + mm : mm);
}

// ─── Export para pruebas en Node (ignorado por Apps Script) ──────────────────
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    validarBloque: validarBloque,
    validarHorarioIndividual: validarHorarioIndividual,
    aplicarMovimientos: aplicarMovimientos,
    agruparCiclos: agruparCiclos,
    construirJornadas: construirJornadas,
    normalizarCodigo: normalizarCodigo,
    esCambiable: esCambiable,
    recibeReparto: recibeReparto,
    CONFIG_TURNOS: CONFIG_TURNOS,
    REGLAS: REGLAS,
    rolDotacion: rolDotacion,
    franjaOperativa: franjaOperativa,
    DOTACION_TURNO: DOTACION_TURNO,
    configurarParametros: configurarParametros,
    PARAMETROS_SEMILLA: PARAMETROS_SEMILLA,
    VENTANAS: VENTANAS,
    esCampoHora: esCampoHora
  };
}
