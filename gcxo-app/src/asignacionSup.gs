/*******************************************************************************
 *
 * REPARTO DE SERVICIOS — asigna los turnos marcados del mes (supervisión
 * Ms/Ts, instrucción Mo/To) entre quien tiene la competencia, y registra el
 * resultado en el log de su tipo. Ver TIPOS_REPARTO.
 *
 * Comparte con la app de cambios la lectura de la hoja (leerMes), la
 * normalización de códigos (normalizarCodigo) y la escritura al turnero
 * (_aplicarTurnoCelda → LOG_CELDAS, deshacible).
 *
 ******************************************************************************/

var VERSION_SUPERVISIONES = 'sup-7-franja';

// ═══════════════════════════════════════════════════════════════════════════
// TIPOS DE REPARTO
// ═══════════════════════════════════════════════════════════════════════════
// Supervisión e instrucción se reparten con el mismo criterio; lo único que
// cambia es qué código se escribe, quién es elegible y dónde se registra. Todo
// eso vive aquí, y el motor de reparto no sabe de cuál de los dos se trata.
//
// Quién es elegible NO se escribe aquí: sale de la capacidad declarada en la
// hoja PUESTOS, vía cargosConCapacidad(). Añadir un puesto nuevo o quitarle la
// competencia a otro no toca este fichero.
var TIPOS_REPARTO = {
  supervision: {
    id: 'supervision',
    etiqueta: 'Supervisión',
    capacidad: 'supervisar',        // en PUESTOS
    codigo: { M: 'Ms', T: 'Ts' },   // lo que se escribe en la celda
    log: 'LOG_SUPERVISIONES'
  },
  instruccion: {
    id: 'instruccion',
    etiqueta: 'Instrucción',
    capacidad: 'instruir',
    codigo: { M: 'Mo', T: 'To' },
    log: 'LOG_INSTRUCCION'
  }
};

// Servicios que cuentan como "servicios del mes" (el denominador del reparto y
// la base del tope). Son todos los turnos de mañana y tarde que se trabajan,
// lleven o no marca de supervisión o instrucción: quien hace un Mo ese día ha
// trabajado ese servicio igual que quien hace un M.
//
// ⚠ Antes esta lista era ['M','Ms','T','Ts'] y dejaba fuera Mo/To. Para un SUP
// puro daba igual, pero a un SUPIN que da instrucción le rebajaba el total y,
// con él, su tope mensual. Y para el reparto de instrucción era inservible: sus
// propios Mo/To no contaban, así que nunca subía de tope.
var SERVICIOS_DEL_MES = ['M', 'T', 'Ms', 'Ts', 'Mo', 'To'];

// Servicios que NO se prestan como Controlador raso: llevan marca de
// supervisión o de instrucción. Se derivan de TIPOS_REPARTO para que añadir un
// tipo nuevo no obligue a acordarse de tocar esta lista.
function _serviciosMarcados_() {
  var out = [];
  for (var k in TIPOS_REPARTO) {
    out.push(TIPOS_REPARTO[k].codigo.M, TIPOS_REPARTO[k].codigo.T);
  }
  return out;
}

// ─── El tope del art. 69.2.4 ────────────────────────────────────────────────
// III Convenio ENAIRE-CTA, art. 69.2.4:
//
//   «Con objeto de garantizar la cualificación operativa de los instructores se
//    les asignará, como mínimo, un 25 % de los servicios diurnos nombrados de
//    su jornada en promedio trimestral o, excepcionalmente, en promedio
//    semestral, como Controlador o Controlador PTD.»
//
// Es un SUELO de servicios como Controlador raso, no un techo por actividad.
// De ahí el 0,75: si al menos el 25 % ha de ser como Controlador, como mucho
// el 75 % puede llevar marca.
//
// Y es un tope COMBINADO. Un Ms no es Controlador y un Mo tampoco, así que lo
// que no puede pasar del 75 % es la SUMA de supervisión e instrucción. Contarlo
// por separado —como se hacía— dejaba pasar a un SUPIN con 50 % de Ms y 50 % de
// Mo: 100 % marcado y ni un solo servicio como Controlador.
//
// ⚠ Dos diferencias conocidas con el texto, ambas del lado seguro:
//   · El convenio promedia por TRIMESTRE (o semestre); aquí se aplica mes a
//     mes, que es más estricto y no permite compensar entre meses.
//   · El filtro es `marcadosMes < limiteMes` (estricto), así que en la práctica
//     el tope efectivo es limiteMes − 1. Con `<=` se ajustaría al 25 % exacto.
var TOPE_MARCADOS = 0.75;

function _tipoReparto_(id) {
  var t = TIPOS_REPARTO[String(id || 'supervision').trim().toLowerCase()];
  if (!t) throw new Error('Tipo de reparto desconocido: ' + id);
  return t;
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILIDADES INTERNAS
// ═══════════════════════════════════════════════════════════════════════════

function getHojaActual() {
  const sheet = SpreadsheetApp.getActiveSheet();
  return { id: sheet.getSheetId(), nombre: sheet.getName() };
}


// La normalización de códigos (Ms/sM/ms → 'Ms') y la detección de baja por
// fondo rojo ya viven en el motor y en Turnero.js: normalizarCodigo() y
// _esColorRojo(). Aquí se usaban copias propias, que había que mantener
// sincronizadas a mano. Se han retirado en favor de las comunes.

// Elimina _leerSupAnualPrevio_ y pon esta en su lugar
function _leerHistorialAnual_(ss, anio, hojaActualNombre, tipo) {
  const mapa = {}; // id → { supAnual, serviciosAnuales } (del tipo que sea)
  const mesesContados = {}; // evita contar los servicios del mismo mes varias veces

  const logSheet = ss.getSheetByName(tipo.log);
  if (!logSheet || logSheet.getLastRow() < 2) return mapa;

  logSheet.getDataRange().getValues().slice(1).forEach(r => {
    if (r[0] !== anio || r[1] === hojaActualNombre || !r[7]) return;

    const id = r[7]; // Asignado Final
    const mes = r[1];

    if (!mapa[id]) mapa[id] = { supAnual: 0, serviciosAnuales: 0 };
    mapa[id].supAnual++;

    // Servicios totales del mes: columna 14 (nueva), contar solo una vez por persona/mes
    const claveMes = `${id}|${mes}`;
    if (!mesesContados[claveMes] && r[14]) {
      mapa[id].serviciosAnuales += r[14];
      mesesContados[claveMes] = true;
    }
  });

  return mapa;
}

// Estructura de trabajo del mes, derivada de leerMes() — el ÚNICO lector de la
// hoja del turnero. Antes esto era _leerEstructuraHoja_, una segunda lectura
// con sus propias constantes de layout (FILA_DIAS, COL_CARGO, COL_PERSONA…)
// duplicadas de Turnero.js: dos sitios que había que cambiar a la vez el día
// que se moviera una columna.
//
// Equivalencias con lo que devuelve leerMes():
//   servicios[dia]  ← base[cta][dia]   ('' si libra o está de vacaciones; el
//                                       código ya viene normalizado)
//   fondoRojo[dia]  ← bajas[cta][dia]  (misma detección de rojo de siempre)
//
// Devuelve también el `mes` crudo, que hace falta para escribir por
// _aplicarTurnoCelda (necesita filaDeCta y diaACol).
function _estructuraDelMes_(nombreMes) {
  const m = leerMes(nombreMes);
  const personas = [];
  const personaFila = {};

  Object.keys(m.filaDeCta).forEach(cta => {
    const servicios = {};
    const fondoRojo = {};
    m.dias.forEach(d => {
      servicios[d] = (m.base[cta] || {})[d] || '';
      fondoRojo[d] = !!(m.bajas[cta] || {})[d];
    });
    personas.push({ id: cta, cargo: m.cargos[cta], fila: m.filaDeCta[cta], servicios, fondoRojo });
    personaFila[cta] = m.filaDeCta[cta];
  });

  return {
    dias: m.dias.map(d => ({ dia: d, col: m.diaACol[d] })),
    diaACol: m.diaACol,
    personas,
    personaFila,
    mes: m
  };
}

// Iniciales del controlador a partir de su correo, para firmar el log de
// celdas. El sidebar se identifica por email; el resto de la app, por CTA.
function _ctaDeEmail_(email) {
  const e = String(email || '').trim().toLowerCase();
  const ctas = leerControladoresCache().filter(c => String(c.email).trim().toLowerCase() === e);
  return ctas.length ? ctas[0].cta : '';
}


// ═══════════════════════════════════════════════════════════════════════════
// ACUMULADOS Y CUPO
// ═══════════════════════════════════════════════════════════════════════════
// Cuánto lleva cada elegible y cuánto le queda antes del tope del art. 69.2.4.
// Vivía dentro de calcularPropuestas, pero el reparto de instrucción ya no se
// calcula solo: lo decide el JSUPIN a mano en su pantalla, y ahí hace falta lo
// mismo SIN proponer nada. Una sola vía para contar, o los dos sitios acabarían
// diciendo números distintos del mismo mes.
//
// Muta `personas` (añade totalMes, supMes, marcadosMes…) porque calcularPropuestas
// sigue leyendo esos campos de cada persona más abajo.
function _estadisticasReparto_(personas, dias, historialAnual, tipo) {
  var CODIGOS = [tipo.codigo.M, tipo.codigo.T];   // Ms/Ts o Mo/To: ESTE tipo
  var MARCADOS = _serviciosMarcados_();           // Ms/Ts Y Mo/To: el tope es común

  personas.forEach(function (p) {
    var totalMes = 0, supMes = 0, marcadosMes = 0, marcados = {}, deTipo = {};
    dias.forEach(function (d) {
      if (p.fondoRojo[d.dia]) return;
      var v = p.servicios[d.dia];
      var franja = String(v).charAt(0) === 'T' ? 'T' : 'M';
      if (SERVICIOS_DEL_MES.indexOf(v) !== -1) totalMes++;
      if (CODIGOS.indexOf(v) !== -1) { supMes++; deTipo[d.dia + '_' + franja] = true; }
      if (MARCADOS.indexOf(v) !== -1) {
        marcadosMes++;                            // supervisión + instrucción
        // Qué días gasta ya cupo, para que la pantalla pueda sumar en vivo lo
        // que hay en el borrador sin contar dos veces lo que ya está escrito.
        marcados[d.dia + '_' + franja] = true;
      }
    });
    p.totalMes = totalMes;
    p.supMes = supMes;
    p.marcadosMes = marcadosMes;
    p.marcados = marcados;
    p.deTipo = deTipo;      // solo los de ESTE tipo: los que el borrador puede quitar
    p.supAnual = ((historialAnual[p.id] || {}).supAnual || 0) + supMes;
    p.serviciosAnuales = ((historialAnual[p.id] || {}).serviciosAnuales || 0) + totalMes;
    p.pctAnual = p.serviciosAnuales > 0 ? p.supAnual / p.serviciosAnuales : 0;
    p.limiteMes = Math.floor(totalMes * TOPE_MARCADOS);
  });

  var ROLES_VALIDOS = cargosConCapacidad(tipo.capacidad);
  var ROLES_EXCEPCIONALES = cargosConCapacidad(tipo.capacidad, true);
  var elegibles = personas.filter(function (p) {
    return ROLES_VALIDOS.indexOf(p.cargo) !== -1 || ROLES_EXCEPCIONALES.indexOf(p.cargo) !== -1;
  });

  var resumen = {};
  elegibles.forEach(function (p) {
    resumen[p.id] = {
      cargo: p.cargo,
      excepcional: ROLES_EXCEPCIONALES.indexOf(p.cargo) !== -1,
      supAnual: p.supAnual,
      serviciosAnuales: p.serviciosAnuales,
      pctAnual: p.pctAnual,
      supMes: p.supMes,
      marcadosMes: p.marcadosMes,   // supervisión + instrucción: lo que gasta cupo
      marcados: p.marcados,         // {dia_franja: true} de lo YA escrito
      deTipo: p.deTipo,             // de esos, los de este tipo (los reversibles)
      totalMes: p.totalMes,
      limiteMes: p.limiteMes,
      supAnualPrevio: (historialAnual[p.id] || {}).supAnual || 0
    };
  });

  return { resumen: resumen, elegibles: elegibles };
}

// Los acumulados de un mes y un tipo, SIN proponer ningún reparto. Es lo que
// necesita la pantalla de instrucción para repartir a ojo.
function acumuladosReparto(nombreMes, tipoId) {
  var tipo = _tipoReparto_(tipoId);
  var ss = SpreadsheetApp.getActive();
  var est = _estructuraDelMes_(nombreMes);
  var historial = _leerHistorialAnual_(ss, new Date().getFullYear(), nombreMes, tipo);
  var r = _estadisticasReparto_(est.personas, est.dias, historial, tipo);
  return {
    mes: nombreMes, tipo: tipo.id, etiqueta: tipo.etiqueta,
    tope: TOPE_MARCADOS, resumen: r.resumen
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// CALCULAR PROPUESTAS
// ═══════════════════════════════════════════════════════════════════════════

// tipoId: 'supervision' (por defecto) o 'instruccion'. nombreMes es opcional:
// si no viene, se usa la hoja activa (el sidebar trabaja sobre la que tienes
// abierta). Al pasar a la web app, la pantalla dirá mes y tipo.
function calcularPropuestas(nombreMes, tipoId) {
  const tipo = _tipoReparto_(tipoId);
  const sheet = nombreMes
    ? SpreadsheetApp.getActive().getSheetByName(nombreMes)
    : SpreadsheetApp.getActiveSheet();
  if (!sheet) throw new Error('No existe la hoja "' + nombreMes + '"');
  const ss = SpreadsheetApp.getActive();
  const HOJA_NOMBRE = sheet.getName();
  // Quién es elegible lo dice la hoja PUESTOS (dentro de _estadisticasReparto_),
  // no una lista escrita aquí. Los EXCEPCIONALES (SUPEX) van aparte: solo entran
  // si no queda nadie.
  const ROLES_EXCEPCIONALES = cargosConCapacidad(tipo.capacidad, true);
  const ANIO = new Date().getFullYear();

  const { dias, diaACol, personas, personaFila } = _estructuraDelMes_(HOJA_NOMBRE);
  const historialAnual = _leerHistorialAnual_(ss, ANIO, HOJA_NOMBRE, tipo);

  const est = _estadisticasReparto_(personas, dias, historialAnual, tipo);
  const supervisores = est.elegibles;
  const esExcep = p => ROLES_EXCEPCIONALES.includes(p.cargo);
  const resumen = est.resumen;

  const propuestas = {};

  // ── BLOQUE 1: Ms/Ts ya existentes → bloqueadas por defecto ───────────────
  supervisores.forEach(p => {
    dias.forEach(d => {
      if (p.fondoRojo[d.dia]) return;

      const v = p.servicios[d.dia];
      const turno = v === tipo.codigo.M ? 'M' : v === tipo.codigo.T ? 'T' : null;
      if (!turno) return;

      const clave = `${d.dia}_${turno}`;
      if (propuestas[clave]) {
        propuestas[clave].conflicto = true;
        return;
      }

      const candidatos = supervisores
        .filter(c =>
          !c.fondoRojo[d.dia] &&
          (c.servicios[d.dia] === turno || c.servicios[d.dia] === tipo.codigo[turno])
        )
        .map(c => ({
          id: c.id, supAnual: c.supAnual, supMes: c.supMes,
          limiteMes: c.limiteMes, totalMes: c.totalMes
        }));

      propuestas[clave] = {
        dia: d.dia,
        turno,
        propuestaSistema: p.id,
        asignadoActual: p.id,
        origen: 'AUTO',
        bloqueado: true,
        conflicto: false,
        // Para el LOG: valores actuales del supervisor ya asignado
        supAnualAntes: p.supAnual - 1,  // ya estaba contado al construir p.supAnual
        supMesAntes: p.supMes - 1,
        supAnualDespues: p.supAnual,
        limiteMes: p.limiteMes,
        candidatos
      };
    });
  });

  // ── BLOQUE 2: Huecos libres (M/T sin supervisión asignada) ───────────────
  dias.forEach(d => {
    ['M', 'T'].forEach(turno => {
      const clave = `${d.dia}_${turno}`;
      if (propuestas[clave]) return;

      // ⚠ Hay servicio esa franja si trabaja ALGUIEN en ella, lleve marca o no.
      // Antes miraba solo `M`/`Ms`, así que una mañana cubierta únicamente por
      // instructores (`Mo`) no generaba hueco de supervisión: había gente en el
      // fanal y el reparto decía que ese turno no existía. La lista se deriva
      // de SERVICIOS_DEL_MES para que un código nuevo entre solo.
      const codigosFranja = SERVICIOS_DEL_MES.filter(c => c.charAt(0) === turno);
      const hayServicio = personas.some(p =>
        !p.fondoRojo[d.dia] && codigosFranja.indexOf(p.servicios[d.dia]) !== -1);
      if (!hayServicio) return;

      const disponibles = supervisores.filter(p =>
        !p.fondoRojo[d.dia] &&
        p.servicios[d.dia] === turno &&
        p.marcadosMes < p.limiteMes   // cupo del art. 69.2.4, combinado
      );
      // Dos vueltas: los excepcionales son la ÚLTIMA opción, no un candidato
      // más. Nunca compiten con quien tiene el puesto de verdad, aunque lleven
      // menos acumulados.
      const normales = disponibles.filter(p => !esExcep(p));
      const candidatos = normales.length ? normales : disponibles;
      const porExcepcion = !normales.length && disponibles.length > 0;

      if (!candidatos.length) {
        propuestas[clave] = {
          dia: d.dia, turno,
          propuestaSistema: null, asignadoActual: null,
          origen: 'AUTO', bloqueado: false, conflicto: true,
          supAnualAntes: '', supMesAntes: '', supAnualDespues: '', limiteMes: '',
          candidatos: []
        };
        return;
      }

      candidatos.sort((a, b) =>
        a.pctAnual !== b.pctAnual ? a.pctAnual - b.pctAnual :
          a.supMes !== b.supMes ? a.supMes - b.supMes :
            b.totalMes - a.totalMes
      );

      const elegido = candidatos[0];

      // Capturar ANTES del incremento
      const supAnualAntes = elegido.supAnual;
      const supMesAntes = elegido.supMes;

      elegido.supMes++;
      elegido.supAnual++;
      elegido.marcadosMes++;
      resumen[elegido.id].supMes++;
      resumen[elegido.id].supAnual++;
      resumen[elegido.id].marcadosMes++;

      propuestas[clave] = {
        dia: d.dia,
        turno,
        propuestaSistema: elegido.id,
        asignadoActual: elegido.id,
        origen: porExcepcion ? 'EXCEPCION' : 'AUTO',
        excepcional: porExcepcion,   // no había nadie con el puesto de verdad
        bloqueado: false,
        conflicto: false,
        supAnualAntes,
        supMesAntes,
        supAnualDespues: elegido.supAnual,
        limiteMes: elegido.limiteMes,
        candidatos: candidatos.map(c => ({
          id: c.id, supAnual: c.supAnual, supMes: c.supMes,
          limiteMes: c.limiteMes, totalMes: c.totalMes,
          cargo: c.cargo, excepcional: esExcep(c)
        }))
      };
    });
  });

  return {
    meta: {
      anio: ANIO,
      tipo: tipo.id,
      etiqueta: tipo.etiqueta,
      mes: HOJA_NOMBRE,
      mesId: sheet.getSheetId(),
      diaACol: diaACol,
      dias: dias.map(d => d.dia),
      fechaGeneracion: new Date().toISOString(),
      usuario: Session.getActiveUser().getEmail()
    },
    resumen,
    propuestas
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// RECALCULAR PROPUESTAS
// ═══════════════════════════════════════════════════════════════════════════


function recalcularPropuestas(propuestasActuales, nombreMes, tipoId) {
  const tipo = _tipoReparto_(tipoId);
  const sheet = nombreMes
    ? SpreadsheetApp.getActive().getSheetByName(nombreMes)
    : SpreadsheetApp.getActiveSheet();
  if (!sheet) throw new Error('No existe la hoja "' + nombreMes + '"');
  const ss = SpreadsheetApp.getActive();
  const HOJA_NOMBRE = sheet.getName();
  // Quién es elegible lo dice la hoja PUESTOS, no una lista escrita aquí.
  // Los EXCEPCIONALES (SUPEX) van aparte: solo entran si no queda nadie.
  const ROLES_VALIDOS = cargosConCapacidad(tipo.capacidad);
  const ROLES_EXCEPCIONALES = cargosConCapacidad(tipo.capacidad, true);
  const ANIO = new Date().getFullYear();

  const { dias, diaACol, personas, personaFila } = _estructuraDelMes_(HOJA_NOMBRE);
  const historialAnual = _leerHistorialAnual_(ss, ANIO, HOJA_NOMBRE, tipo);
  const CODIGOS = [tipo.codigo.M, tipo.codigo.T];
  const MARCADOS = _serviciosMarcados_();

  // ── Estadísticas base: meses anteriores; supMes empieza en 0 ─────────────
  const personasPorId = {};
  personas.forEach(p => {
    let totalMes = 0;
    let marcadosOtros = 0;
    dias.forEach(d => {
      if (p.fondoRojo[d.dia]) return;
      const v = p.servicios[d.dia];
      if (SERVICIOS_DEL_MES.includes(v)) totalMes++;
      // Las marcas del OTRO tipo no se recalculan: son hechos de la hoja y
      // consumen tope igual.
      if (MARCADOS.includes(v) && !CODIGOS.includes(v)) marcadosOtros++;
    });
    p.totalMes = totalMes;
    p.supMes = 0;
    p.marcadosMes = marcadosOtros;
    p.supAnual = historialAnual[p.id]?.supAnual || 0;
    p.serviciosAnuales = historialAnual[p.id]?.serviciosAnuales || 0;
    p.pctAnual = p.serviciosAnuales > 0
      ? p.supAnual / p.serviciosAnuales
      : 0;
    p.limiteMes = Math.floor(totalMes * TOPE_MARCADOS);
    personasPorId[p.id] = p;
  });

  const supervisores = personas.filter(p => ROLES_VALIDOS.includes(p.cargo) || ROLES_EXCEPCIONALES.includes(p.cargo));
  const esExcep = p => ROLES_EXCEPCIONALES.includes(p.cargo);

  const resumen = {};
  supervisores.forEach(p => {
    resumen[p.id] = {
      cargo: p.cargo,
      excepcional: esExcep(p),
      supAnual: p.supAnual,
      serviciosAnuales: p.serviciosAnuales,
      pctAnual: p.pctAnual,
      supMes: p.supMes,
      marcadosMes: p.marcadosMes,   // supervisión + instrucción: lo que gasta cupo
      totalMes: p.totalMes,
      limiteMes: p.limiteMes,
      supAnualPrevio: historialAnual[p.id]?.supAnual || 0
    };
  });

  // ── Aplicar bloqueos ──────────────────────────────────────────────────────
  Object.values(propuestasActuales).forEach(p => {
    if (!p.bloqueado || !p.asignadoActual) return;
    const persona = personasPorId[p.asignadoActual];
    if (!persona) return;
    persona.supMes++;
    persona.supAnual++;
    persona.marcadosMes++;
    if (resumen[p.asignadoActual]) {
      resumen[p.asignadoActual].supMes++;
      resumen[p.asignadoActual].supAnual++;
      resumen[p.asignadoActual].marcadosMes++;
    }
  });

  // ── Recalcular pctAnual tras aplicar bloqueos ─────────────────────────────
  supervisores.forEach(p => {
    const serviciosAnualesConMes = p.serviciosAnuales + p.totalMes;
    p.serviciosAnuales = serviciosAnualesConMes;
    p.pctAnual = serviciosAnualesConMes > 0 ? p.supAnual / serviciosAnualesConMes : 0;
    if (resumen[p.id]) {
      resumen[p.id].serviciosAnuales = serviciosAnualesConMes;
      resumen[p.id].pctAnual = p.pctAnual;
    }
  });

  // ── Recalcular solo los NO bloqueados ─────────────────────────────────────
  const nuevasPropuestas = {};

  dias.forEach(d => {
    ['M', 'T'].forEach(turno => {
      const clave = `${d.dia}_${turno}`;
      const anterior = propuestasActuales[clave];

      // Bloqueado → copiar sin tocar
      if (anterior && anterior.bloqueado) {
        nuevasPropuestas[clave] = anterior;
        return;
      }

      // ⚠ Hay servicio esa franja si trabaja ALGUIEN en ella, lleve marca o no.
      // Antes miraba solo `M`/`Ms`, así que una mañana cubierta únicamente por
      // instructores (`Mo`) no generaba hueco de supervisión: había gente en el
      // fanal y el reparto decía que ese turno no existía. La lista se deriva
      // de SERVICIOS_DEL_MES para que un código nuevo entre solo.
      const codigosFranja = SERVICIOS_DEL_MES.filter(c => c.charAt(0) === turno);
      const hayServicio = personas.some(p =>
        !p.fondoRojo[d.dia] && codigosFranja.indexOf(p.servicios[d.dia]) !== -1);
      if (!hayServicio) return;

      const disponibles = supervisores.filter(p =>
        !p.fondoRojo[d.dia] &&
        p.servicios[d.dia] === turno &&
        p.marcadosMes < p.limiteMes   // cupo del art. 69.2.4, combinado
      );
      // Dos vueltas: los excepcionales son la ÚLTIMA opción, no un candidato
      // más. Nunca compiten con quien tiene el puesto de verdad, aunque lleven
      // menos acumulados.
      const normales = disponibles.filter(p => !esExcep(p));
      const candidatos = normales.length ? normales : disponibles;
      const porExcepcion = !normales.length && disponibles.length > 0;

      if (!candidatos.length) {
        nuevasPropuestas[clave] = {
          dia: d.dia, turno,
          propuestaSistema: null, asignadoActual: null,
          origen: 'AUTO', bloqueado: false, conflicto: true,
          supAnualAntes: '', supMesAntes: '', supAnualDespues: '', limiteMes: '',
          candidatos: []
        };
        return;
      }

      candidatos.sort((a, b) =>
        a.pctAnual !== b.pctAnual ? a.pctAnual - b.pctAnual :
          a.supMes !== b.supMes ? a.supMes - b.supMes :
            b.totalMes - a.totalMes
      );

      const elegido = candidatos[0];

      // Capturar ANTES del incremento
      const supAnualAntes = elegido.supAnual;
      const supMesAntes = elegido.supMes;

      elegido.supMes++;
      elegido.supAnual++;
      elegido.marcadosMes++;
      if (resumen[elegido.id]) {
        resumen[elegido.id].supMes++;
        resumen[elegido.id].supAnual++;
        resumen[elegido.id].marcadosMes++;
      }

      nuevasPropuestas[clave] = {
        dia: d.dia,
        turno,
        propuestaSistema: elegido.id,
        asignadoActual: elegido.id,
        origen: porExcepcion ? 'EXCEPCION' : 'AUTO',
        excepcional: porExcepcion,
        bloqueado: false,
        conflicto: false,
        supAnualAntes,
        supMesAntes,
        supAnualDespues: elegido.supAnual,
        limiteMes: elegido.limiteMes,
        candidatos: candidatos.map(c => ({
          id: c.id, supAnual: c.supAnual, supMes: c.supMes,
          limiteMes: c.limiteMes, totalMes: c.totalMes,
          cargo: c.cargo, excepcional: esExcep(c)
        }))
      };
    });
  });

  return {
    meta: {
      anio: ANIO,
      tipo: tipo.id,
      etiqueta: tipo.etiqueta,
      mes: HOJA_NOMBRE,
      mesId: sheet.getSheetId(),
      diaACol: diaACol,
      dias: dias.map(d => d.dia),
      fechaGeneracion: new Date().toISOString(),
      usuario: Session.getActiveUser().getEmail()
    },
    resumen,
    propuestas: nuevasPropuestas
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// APLICAR PROPUESTAS
// ═══════════════════════════════════════════════════════════════════════════

function aplicarPropuestas(data) {
  const tipo = _tipoReparto_(data.meta.tipo);
  const ss = SpreadsheetApp.getActive();
  const HOJA_NOMBRE = data.meta.mes;
  const sheet = ss.getSheetByName(HOJA_NOMBRE);
  if (!sheet) throw new Error('No existe la hoja "' + HOJA_NOMBRE + '"');
  const ANIO = data.meta.anio;
  const USUARIO = data.meta.usuario;
  const AUTOR = _ctaDeEmail_(USUARIO) || USUARIO;
  const TIMESTAMP = new Date();

  const { diaACol, dias, personas, personaFila, mes } = _estructuraDelMes_(HOJA_NOMBRE);
  // ── Índice id→persona (debe ir antes de cualquier uso) ───────────────────
  const personasPorId = {};
  personas.forEach(p => { personasPorId[p.id] = p; });

  // ── Servicios totales del mes por persona (para el LOG) ──────────────────
  const totalMesPorPersona = {};
  personas.forEach(p => {
    let total = 0;
    dias.forEach(d => {
      if (p.fondoRojo[d.dia]) return;
      const v = p.servicios[d.dia];
      if (SERVICIOS_DEL_MES.includes(v)) total++;
    });
    totalMesPorPersona[p.id] = total;
  });

  // ── LOG ──────────────────────────────────────────────────────────────────
  const logSheet = ss.getSheetByName(tipo.log) || ss.insertSheet(tipo.log);

  if (logSheet.getLastRow() === 0) {
    logSheet.appendRow([
      'Año', 'Mes', 'Día', 'Turno',
      'Servicio Original', 'Código final en hoja',
      'Propuesto por sistema', 'Asignado Final',
      'Origen', 'Bloqueado', 'Conflicto',
      'Supervisiones anuales ANTES', 'Supervisiones mensuales ANTES',
      'Límite mensual', 'Servicios totales del mes',   // ← nueva col 15
      'Supervisiones anuales DESPUÉS',
      'Fecha/hora de ejecución', 'Usuario que valida',
      'Observaciones / motivo'
    ]);
  }

  // Leer LOG existente guardando fila y asignado actual
  // clave → { filaLog, asignadoLog }
  const existentes = {};
  if (logSheet.getLastRow() > 1) {
    logSheet
      .getRange(2, 1, logSheet.getLastRow() - 1, 8)
      .getValues()
      .forEach((r, i) => {
        const clave = `${r[0]}|${r[1]}|${r[2]}|${r[3]}`;
        existentes[clave] = {
          filaLog: i + 2,   // +2 por cabecera y base-0
          asignadoLog: r[7]     // columna H = Asignado Final
        };
      });
  }

  const logRowsNuevos = [];
  const logRowsActualizar = []; // { fila, valores }

  Object.values(data.propuestas).forEach(p => {
    if (!p.asignadoActual) return;

    const col = diaACol[p.dia];
    if (!col) return;

    const valorMs = tipo.codigo[p.turno];   // Ms/Ts o Mo/To
    const valorBase = p.turno;

    const filaSupNuevo = personaFila[p.asignadoActual];
    if (!filaSupNuevo) return;

    // Toda escritura pasa por _aplicarTurnoCelda: guarda el valor previo en
    // LOG_CELDAS, con lo que una asignación de supervisión se puede deshacer
    // desde el panel igual que cualquier otro movimiento del turnero.
    const traza = {
      tipo: tipo.id.toUpperCase(), origen: 'REPARTO',
      ref: ANIO + '|' + HOJA_NOMBRE + '|' + p.dia + '|' + p.turno,
      autor: AUTOR
    };

    // ── Revertir supervisor anterior si ha cambiado ───────────────────────
    personas.forEach(persona => {
      if (persona.fila === filaSupNuevo) return;
      if (persona.fondoRojo[p.dia]) return;
      if (persona.servicios[p.dia] === valorMs) {
        _aplicarTurnoCelda(sheet, mes, HOJA_NOMBRE, persona.id, p.dia, valorBase,
          Object.assign({}, traza, { motivo: 'Deja la ' + tipo.etiqueta.toLowerCase() + ' del día ' + p.dia + ' ' + p.turno + ' (pasa a ' + p.asignadoActual + ')' }));
        persona.servicios[p.dia] = valorBase;
      }
    });

    // ── Escribir nuevo supervisor (solo si la celda cambia) ───────────────
    const personaNueva = personasPorId[p.asignadoActual];
    const valorActual = personaNueva ? personaNueva.servicios[p.dia] : null;
    if (valorActual !== valorMs) {
      _aplicarTurnoCelda(sheet, mes, HOJA_NOMBRE, p.asignadoActual, p.dia, valorMs,
        Object.assign({}, traza, { motivo: 'Asignada la ' + tipo.etiqueta.toLowerCase() + ' del día ' + p.dia + ' ' + p.turno }));
      if (personaNueva) personaNueva.servicios[p.dia] = valorMs;
    }

    // ── LOG ───────────────────────────────────────────────────────────────
    const claveLog = `${ANIO}|${HOJA_NOMBRE}|${p.dia}|${p.turno}`;
    const entrada = existentes[claveLog];

    const fila = [
      ANIO,                                    // 0  Año
      HOJA_NOMBRE,                             // 1  Mes
      p.dia,                                   // 2  Día
      p.turno,                                 // 3  Turno
      p.turno,                                 // 4  Servicio Original
      valorMs,                                 // 5  Código final en hoja
      p.propuestaSistema || '',               // 6  Propuesto por sistema
      p.asignadoActual,                        // 7  Asignado Final
      p.origen || 'AUTO',           // 8  Origen
      p.bloqueado ? 'SI' : 'NO',       // 9  Bloqueado
      p.conflicto ? 'SI' : 'NO',       // 10 Conflicto
      p.supAnualAntes ?? '',               // 11 Sup. anuales ANTES
      p.supMesAntes ?? '',               // 12 Sup. mensuales ANTES
      p.limiteMes ?? '',               // 13 Límite mensual
      totalMesPorPersona[p.asignadoActual] || '', // 14 Servicios totales del mes ← nueva
      p.supAnualDespues ?? '',               // 15 Sup. anuales DESPUÉS
      TIMESTAMP,                               // 16 Fecha/hora
      USUARIO,                                 // 17 Usuario que valida
      ''                                       // 18 Observaciones
    ];

    if (!entrada) {
      // Slot nuevo → insertar
      logRowsNuevos.push(fila);
      existentes[claveLog] = { asignadoLog: p.asignadoActual };

    } else if (entrada.asignadoLog !== p.asignadoActual) {
      // Mismo slot, persona distinta → actualizar fila existente
      logRowsActualizar.push({ filaLog: entrada.filaLog, valores: fila });
    }
    // Si entrada existe y asignado es el mismo → no hacer nada (idempotente)
  });

  // ── Escribir nuevos en bloque ─────────────────────────────────────────────
  if (logRowsNuevos.length > 0) {
    logSheet
      .getRange(logSheet.getLastRow() + 1, 1, logRowsNuevos.length, 19)
      .setValues(logRowsNuevos);
  }

  // ── Actualizar filas modificadas (una por una, son casos puntuales) ───────
  logRowsActualizar.forEach(({ filaLog, valores }) => {
    logSheet.getRange(filaLog, 1, 1, 19).setValues([valores]);
  });

  // La app de cambios cachea la matriz del mes 6 h y la invalida con onEdit,
  // que NO se dispara cuando quien edita es un script. Sin esto, el calendario
  // y los candidatos seguirían viendo el turnero de antes de la asignación.
  invalidarCacheMes(HOJA_NOMBRE);

 // SpreadsheetApp.getUi().alert('Cambios aplicados correctamente y LOG actualizado.');
}


function mostrarSidebar() {
  const email = Session.getActiveUser().getEmail();

  const autorizados = [
    'ground.contact@gmail.com',
    'ignacio.perez79@gmail.com'
  ];

  if (!autorizados.includes(email)) {
    SpreadsheetApp.getUi().alert(
      'Acceso restringido',
      'No tienes permisos para usar el gestor de supervisiones.',
      SpreadsheetApp.getUi().ButtonSet.OK
    );
    return;
  }

  const html = HtmlService
    .createTemplateFromFile('sidebar')
    .evaluate()
    .setTitle('Asignación de supervisiones');

  SpreadsheetApp.getUi().showSidebar(html);
}


// ÚNICO onOpen del proyecto. Había dos —este y el de searchNotes.js— y Apps
// Script solo se queda con uno, así que uno de los dos menús no llegaba a
// aparecer nunca. Ahora los dos cuelgan de aquí.
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Supervisiones')
    .addItem('Gestor de supervisiones', 'mostrarSidebar')
    .addSeparator()
    .addItem('Buscar en notas', 'searchNotes')
    .addToUi();
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}
