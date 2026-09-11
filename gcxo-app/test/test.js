// Banco de pruebas del cambio directo de admin y de los dos arreglos.
// Carga los .gs de verdad en un contexto con Apps Script simulado.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { Libro, construirEntorno } = require('./fakegas');

const GAS = path.join(__dirname, '..', 'gas');
// Orden de carga: como en Apps Script, todo acaba en el mismo ámbito global.
const FICHEROS = ['motor_restricciones.gs', 'logica_cambios.gs', 'Turnero.gs',
                  'asignacionSup.gs', 'importador.gs', 'Backend.gs'];

let fallos = 0, pruebas = 0;
function ok(cond, txt, extra) {
  pruebas++;
  if (cond) { console.log('  ✓ ' + txt); }
  else { fallos++; console.log('  ✗ ' + txt + (extra !== undefined ? '\n      → ' + JSON.stringify(extra) : '')); }
}
function seccion(t) { console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 60 - t.length))); }

// ── Montar un libro de prueba ──────────────────────────────────────────────
// Mes futuro, para que no sea "pasado" nunca.
const HOY = new Date();
const MES3 = ['ENE','FEB','MAR','ABR','MAY','JUN','JUL','AGO','SEP','OCT','NOV','DIC'];
const futuro = new Date(HOY.getFullYear(), HOY.getMonth() + 1, 1);
const MES = MES3[futuro.getMonth()] + '-' + ('0' + (futuro.getFullYear() % 100)).slice(-2);
const N_DIAS = new Date(futuro.getFullYear(), futuro.getMonth() + 1, 0).getDate();

function nuevoEntorno() {
  const libro = new Libro();

  // Hoja del mes: fila 3 = días, fila 4+ = personas. Col1 cargo, col3 cta, col4+ días.
  const mes = libro.insertSheet(MES);
  mes.getRange(3, 1, 1, 3 + N_DIAS).setValues([['', '', ''].concat(
    Array.from({ length: N_DIAS }, (_, i) => i + 1))]);

  // Patrón cómodo: AA mañanas los impares, BB tardes los impares, CC supervisor.
  const gente = [
    { cargo: 'SUP',   cta: 'AA' },
    { cargo: '',      cta: 'BB' },
    { cargo: 'SUPIN', cta: 'CC' },
    { cargo: 'JTWR',  cta: 'JJ' }
  ];
  gente.forEach((g, i) => {
    const fila = 4 + i;
    mes.getRange(fila, 1).setValue(g.cargo);
    mes.getRange(fila, 3).setValue(g.cta);
  });
  // Turnos: días 1..6 → AA hace M los días 1 y 3; BB hace T el día 1 y M el 3.
  const poner = (cta, dia, cod) => {
    const fila = 4 + gente.findIndex(g => g.cta === cta);
    mes.getRange(fila, 3 + dia).setValue(cod);
  };
  poner('AA', 1, 'M'); poner('AA', 3, 'M'); poner('AA', 5, 'M');
  poner('BB', 1, 'T'); poner('BB', 3, 'T'); poner('BB', 5, 'T');
  poner('CC', 1, 'Ms'); poner('CC', 3, 'Ms');
  poner('JJ', 1, 'M');

  // CONTROLADORES: A cta, B nombre, C email, D token, E activo, F rol, G puesto…
  const ctrl = libro.insertSheet('CONTROLADORES');
  ctrl.appendRow(['CTA', 'Nombre', 'Email', 'Token', 'Activo', 'Rol', 'puesto', 'grupo', 'activo_extras', 'activo_vacas', 'id', 'alta', 'baja']);
  ctrl.appendRow(['AA', 'Ana A', 'aa@t', 'tok-aa', 'SÍ', 'CTA', 'SUP', 'G1', 'SÍ', 'SÍ', 'P-aa', '', '']);
  ctrl.appendRow(['BB', 'Beto B', 'bb@t', 'tok-bb', 'SÍ', 'CTA', '', 'G1', 'SÍ', 'SÍ', 'P-bb', '', '']);
  ctrl.appendRow(['CC', 'Ceci C', 'cc@t', 'tok-cc', 'SÍ', 'CTA', 'SUPIN', 'G2', 'SÍ', 'SÍ', 'P-cc', '', '']);
  ctrl.appendRow(['JJ', 'Jefa J', 'jj@t', 'tok-jj', 'SÍ', 'CTA', 'JTWR', 'G2', 'SÍ', 'SÍ', 'P-jj', '', '']);
  ctrl.appendRow(['ZZ', 'Zoe Admin', 'zz@t', 'tok-zz', 'SÍ', 'ADMIN', 'SUP', 'G1', 'SÍ', 'SÍ', 'P-zz', '', '']);

  const env = construirEntorno(libro);
  const sandbox = Object.assign({ console, Date, JSON, Math, String, Number, Boolean,
    Array, Object, isNaN, isFinite, parseInt, parseFloat, RegExp, Error, module: {} }, env);
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  FICHEROS.forEach(f => {
    vm.runInContext(fs.readFileSync(path.join(GAS, f), 'utf8'), sandbox, { filename: f });
  });
  return { sandbox, libro, env, mes };
}

const TOK_ADMIN = 'tok-zz';

// ═══════════════════════════════════════════════════════════════════════════
seccion('El motor sigue intacto');
{
  const { sandbox } = nuevoEntorno();
  // 6 mañanas seguidas ya pasan de 50 h: 6 x 8h28 (505' de ventana + 3,5' de
  // relevo del art. 47.10) = 50h51. Así que quitar la 7ª arregla el R2 pero NO
  // el R3 — es el motor haciendo lo suyo, con el suplemento aplicado.
  const r = sandbox.validarBloque(
    { AA: { 1: 'M', 2: 'M', 3: 'M', 4: 'M', 5: 'M', 6: 'M', 7: 'M' } }, { AA: 'SUP' },
    [{ cta: 'AA', dia: 7, de: 'M', a: 'libre' }], { cobertura: false });
  ok(!r.violaciones.some(v => v.regla === 'R2'), 'quitar la 7ª mañana quita el R2');
  ok(r.violaciones.some(v => v.regla === 'R3'), 'pero 6 mañanas ya pasan de 50 h/ciclo (R3)',
     r.violaciones.map(v => v.regla + ' ' + v.detalle));

  const r2 = sandbox.validarHorarioIndividual('AA',
    { 1: 'M', 2: 'M', 3: 'M', 4: 'M', 5: 'M', 6: 'M', 7: 'M' }, {});
  ok(r2.some(v => v.regla === 'R2'), '7 periodos seguidos disparan R2');

  const r3 = sandbox.validarHorarioIndividual('AA', { 1: 'T', 2: 'M' }, {});
  ok(r3.some(v => v.regla === 'R1'), 'T seguido de M al día siguiente dispara R1 (<12h)');
}

// ═══════════════════════════════════════════════════════════════════════════
seccion('Arreglo 1 · la caché de CONTROLADORES ahora acierta');
{
  const { sandbox, env } = nuevoEntorno();
  sandbox.leerControladoresCache();
  const claves = Object.keys(env._cache);
  ok(claves.indexOf('controladores_' + sandbox.CACHE_V) !== -1,
     'se escribe en controladores_' + sandbox.CACHE_V, claves);
  ok(claves.indexOf('controladores') === -1, 'ya no se escribe en la clave sin sufijo', claves);

  // Que el hit de verdad evita releer la hoja: se vacía la hoja y aun así responde.
  const antes = sandbox.leerControladoresCache().length;
  sandbox.SpreadsheetApp.getActive().getSheetByName('CONTROLADORES').deleteRows(2, 5);
  const despues = sandbox.leerControladoresCache().length;
  ok(antes === despues && despues === 5,
     'segunda llamada sale de caché (no relee la hoja)', { antes, despues });

  sandbox.invalidarCacheControladores();
  ok(sandbox.leerControladoresCache().length === 0, 'invalidar la caché sí obliga a releer');
}

// ═══════════════════════════════════════════════════════════════════════════
seccion('Arreglo 2 · registrarCambioAdmin respeta las solicitudes en curso');
{
  const { sandbox } = nuevoEntorno();
  const movs = [{ cta: 'AA', dia: 1, de: 'M', a: 'T' }, { cta: 'BB', dia: 1, de: 'T', a: 'M' }];

  const r1 = sandbox.registrarCambio('tok-aa', MES, movs, '');
  ok(r1.ok === true, 'AA registra un intercambio con BB', r1);

  const r2 = sandbox.registrarCambioAdmin(TOK_ADMIN, 'AA', MES, movs, 'otra vez');
  ok(r2.ok === false, 'el admin YA NO puede registrar otro encima', r2);
  ok(/solicitud en curso/i.test(r2.error || ''), 'y el error dice cuál choca', r2.error);
  ok((r2.error || '').indexOf(r1.id) !== -1, 'nombrando su id (' + r1.id + ')', r2.error);
}
{
  const { sandbox } = nuevoEntorno();
  const r = sandbox.registrarCambioAdmin(TOK_ADMIN, 'AA', MES,
    [{ cta: 'AA', dia: 1, de: 'M', a: 'T' }, { cta: 'BB', dia: 1, de: 'T', a: 'M' }], 'ok');
  ok(r.ok === true, 'sin choque, sigue funcionando igual que antes', r);
}

// ═══════════════════════════════════════════════════════════════════════════
seccion('Candidatos para el admin (en nombre de otro)');
{
  const { sandbox } = nuevoEntorno();
  const r = sandbox.candidatosCambioAdmin(TOK_ADMIN, MES, 1, 'AA');
  ok(r.ok === true, 'devuelve lista para AA aunque quien llama es ZZ', r.error);
  ok(r.cta === 'AA' && r.miTurno === 'M', 'el protagonista es AA y su turno la M del día 1', { cta: r.cta, miTurno: r.miTurno });
  const bb = (r.candidatos || []).filter(c => c.cta === 'BB')[0];
  ok(!!bb, 'BB sale como candidato');
  ok(bb && bb.tipo === 'INTERCAMBIO', 'clasificado como INTERCAMBIO', bb && bb.tipo);
  ok(bb && bb.movimientos.length === 2, 'con los dos movimientos ya montados', bb && bb.movimientos);

  // La vía normal sigue viva y da lo mismo pedida por el propio interesado.
  const propia = sandbox.candidatosCadena('tok-aa', MES, 1, null);
  ok(propia.ok === true && propia.candidatos.length === r.candidatos.length,
     'candidatosCadena (vía normal) devuelve lo mismo tras el refactor',
     { propia: propia.candidatos && propia.candidatos.length, admin: r.candidatos.length });
}
{
  // 🔒: el compañero bloquea el día. Debe desaparecer para el compañero y
  // aparecer marcado para el admin.
  const { sandbox } = nuevoEntorno();
  sandbox.setDisponibilidad('tok-bb', MES, 1, 'BLOQUEADO', '');
  const propia = sandbox.candidatosCadena('tok-aa', MES, 1, null);
  ok(!propia.candidatos.some(c => c.cta === 'BB'), 'BB bloqueado desaparece para AA');
  const admin = sandbox.candidatosCambioAdmin(TOK_ADMIN, MES, 1, 'AA');
  const bb = admin.candidatos.filter(c => c.cta === 'BB')[0];
  ok(!!bb, 'pero el admin sí lo ve');
  ok(bb && bb.bloqueado === true, 'marcado como bloqueado', bb && bb.bloqueado);
  ok(admin.candidatos[admin.candidatos.length - 1].cta === 'BB', 'y ordenado el último');
}

// ═══════════════════════════════════════════════════════════════════════════
seccion('Cambio directo · camino feliz');
{
  const { sandbox, mes } = nuevoEntorno();
  const movs = [{ cta: 'AA', dia: 1, de: 'M', a: 'T' }, { cta: 'BB', dia: 1, de: 'T', a: 'M' }];
  const r = sandbox.cambioDirectoAdmin(TOK_ADMIN, MES, movs, { motivo: 'acordado por teléfono' });

  ok(r.ok === true, 'se aplica sin confirmación ni validación', r);
  ok(r.estado === 'TRANSCRITO', 'nace ya TRANSCRITO', r.estado);
  ok(r.forzado === false, 'no ha hecho falta forzar');
  ok(r.escrito === true, 'se escribió en la hoja del mes');

  // La hoja del mes
  ok(mes.getRange(4, 4).getValue() === 'T', 'la celda de AA del día 1 dice T', mes.getRange(4, 4).getValue());
  ok(mes.getRange(5, 4).getValue() === 'M', 'la celda de BB del día 1 dice M', mes.getRange(5, 4).getValue());
  ok(/SYS: \[ZZ\]/.test(mes.getRange(4, 4).getNote()), 'con la nota SYS firmada por el admin', mes.getRange(4, 4).getNote());

  // La fila de CAMBIOS
  const filaC = sandbox.SpreadsheetApp.getActive().getSheetByName('CAMBIOS')
    .getRange(2, 1, 1, 13).getValues()[0];
  ok(filaC[2] === 'AA', 'el solicitante es AA, no el admin', filaC[2]);
  ok(filaC[8] === 'TRANSCRITO', 'estado TRANSCRITO en la hoja', filaC[8]);
  ok(/Cambio directo aplicado por ZZ: acordado por teléfono/.test(String(filaC[12])),
     'las notas dicen quién y por qué', filaC[12]);
  const parts = JSON.parse(filaC[6]);
  ok(parts.every(p => p.confirma === 'ACEPTA' && p.porAdmin === true),
     'los participantes constan aceptados POR ADMIN', parts);

  // LOG_CELDAS: deshacible
  const log = sandbox.getLogDia(TOK_ADMIN, MES, 'AA', 1);
  ok(log.entradas.length === 1 && log.entradas[0].previo === 'M' && log.entradas[0].nuevo === 'T',
     'LOG_CELDAS guarda M → T con el valor previo', log.entradas);
  const des = sandbox.deshacerDia(TOK_ADMIN, MES, 'AA', 1);
  ok(des.ok === true && mes.getRange(4, 4).getValue() === 'M',
     'y deshacer devuelve la celda a M', { des, celda: mes.getRange(4, 4).getValue() });

  // LOG_CAMBIOS
  const lc = sandbox.SpreadsheetApp.getActive().getSheetByName('LOG_CAMBIOS');
  ok(lc && lc.getLastRow() === 2, 'queda una línea en LOG_CAMBIOS', lc && lc.getLastRow());
}

// ═══════════════════════════════════════════════════════════════════════════
seccion('Cambio directo · el balance lo cuenta');
{
  const { sandbox } = nuevoEntorno();
  // Cesión: AA suelta su M del día 5, BB (que libra ese día... no, BB tiene T) →
  // usamos CC, que el día 5 libra.
  const movs = [{ cta: 'AA', dia: 5, de: 'M', a: 'libre' }, { cta: 'CC', dia: 5, de: 'libre', a: 'M' }];
  const r = sandbox.cambioDirectoAdmin(TOK_ADMIN, MES, movs, { motivo: 'cesión' });
  ok(r.ok === true, 'cesión aplicada', r);
  const bal = sandbox.getBalance('tok-cc');
  const deAA = (bal.saldo || []).filter(x => x.cta === 'AA')[0];
  ok(deAA && deAA.meDeben === 1, 'CC ve que AA le debe un día', bal.saldo);
}

// ═══════════════════════════════════════════════════════════════════════════
seccion('Cambio directo · legalidad');
{
  const { sandbox, mes } = nuevoEntorno();
  // AA tiene M el día 3. Si en vez de M hace T el día 3 y ya tiene M el 5… nada.
  // Forzamos algo ilegal de verdad: BB tiene T el día 1; darle además la M del
  // día 1 no se puede (ya trabaja). Probamos R1: AA hace M el día 3; le damos la
  // T del día 2 de nadie… mejor: intercambio que deja a AA con T el 1 y M el…
  // Lo simple y seguro: pedir un movimiento cuyo `de` no coincide con la hoja.
  const malos = [{ cta: 'AA', dia: 1, de: 'T', a: 'M' }, { cta: 'BB', dia: 1, de: 'M', a: 'T' }];
  const r = sandbox.cambioDirectoAdmin(TOK_ADMIN, MES, malos, {});
  ok(r.ok === false, 'un estado de partida que no cuadra se rechaza', r);
  ok(r.refrescar === true, 'y pide refrescar la pantalla', r);

  const rf = sandbox.cambioDirectoAdmin(TOK_ADMIN, MES, malos, { forzar: true });
  ok(rf.ok === false, 'NI SIQUIERA forzando se aplica (regla ESTADO)', rf);
  ok(mes.getRange(4, 4).getValue() === 'M', 'la hoja no se ha tocado', mes.getRange(4, 4).getValue());
}
{
  // Una violación laboral de verdad: R1. CC tiene Ms el día 1 (mañana).
  // Le damos la T del día 1 de BB → CC pasaría a tener dos turnos... no.
  // Usamos: AA libra el día 2. Le damos una T el día 2 desde alguien.
  // AA tiene M el 1 y M el 3. Una T el día 2 → fin 23:20 del 2, inicio 06:30 del
  // 3 = 7h10 < 12h → R1.
  const { sandbox, mes } = nuevoEntorno();
  mes.getRange(5, 3 + 2).setValue('T');           // BB hace T el día 2
  sandbox.invalidarCacheMes(MES);
  const movs = [{ cta: 'BB', dia: 2, de: 'T', a: 'libre' }, { cta: 'AA', dia: 2, de: 'libre', a: 'T' }];

  const r = sandbox.cambioDirectoAdmin(TOK_ADMIN, MES, movs, {});
  ok(r.ok === false, 'una cesión que rompe el descanso se rechaza por defecto', r);
  ok((r.violaciones || []).some(v => v.regla === 'R1'), 'diciendo que es R1', r.violaciones);

  const rf = sandbox.cambioDirectoAdmin(TOK_ADMIN, MES, movs, { forzar: true, motivo: 'orden de jefatura' });
  ok(rf.ok === true, 'pero forzando SÍ se aplica', rf);
  ok(rf.forzado === true, 'marcado como forzado', rf.forzado);
  ok(mes.getRange(4, 3 + 2).getValue() === 'T', 'y la celda de AA del día 2 queda en T');
  const filaC = sandbox.SpreadsheetApp.getActive().getSheetByName('CAMBIOS').getRange(2, 1, 1, 13).getValues()[0];
  ok(/FORZADO pese a: R1/.test(String(filaC[12])), 'el incumplimiento queda ESCRITO en la fila', filaC[12]);
  ok(JSON.parse(filaC[7]).forzado === true, 'y en la columna de chequeo', filaC[7]);
}

// ═══════════════════════════════════════════════════════════════════════════
seccion('Cambio directo · choque con una solicitud en curso');
{
  const { sandbox } = nuevoEntorno();
  const movs = [{ cta: 'AA', dia: 1, de: 'M', a: 'T' }, { cta: 'BB', dia: 1, de: 'T', a: 'M' }];
  const sol = sandbox.registrarCambio('tok-aa', MES, movs, '');
  ok(sol.ok === true, 'hay una solicitud en curso de AA', sol);

  const r = sandbox.cambioDirectoAdmin(TOK_ADMIN, MES, movs, {});
  ok(r.ok === false, 'el cambio directo se planta', r);
  ok((r.conflictos || []).indexOf(sol.id) !== -1, 'y devuelve el id que choca para poder preguntar', r.conflictos);

  const rf = sandbox.cambioDirectoAdmin(TOK_ADMIN, MES, movs, { forzar: true });
  ok(rf.ok === true, 'forzando se aplica', rf);
  ok((rf.anuladas || []).indexOf(sol.id) !== -1, 'y la solicitud vieja queda anulada', rf.anuladas);

  const filas = sandbox.SpreadsheetApp.getActive().getSheetByName('CAMBIOS').getDataRange().getValues();
  const vieja = filas.filter(f => f[0] === sol.id)[0];
  ok(vieja && String(vieja[8]) === 'ANULADO', 'ANULADO en la hoja', vieja && vieja[8]);
  ok(/Anulada por el cambio directo/.test(String(vieja[12])), 'con el motivo escrito', vieja && vieja[12]);
}

// ═══════════════════════════════════════════════════════════════════════════
seccion('Cambio directo · permisos y guardarraíles');
{
  const { sandbox } = nuevoEntorno();
  const movs = [{ cta: 'AA', dia: 1, de: 'M', a: 'T' }, { cta: 'BB', dia: 1, de: 'T', a: 'M' }];
  let lanzo = false;
  try { sandbox.cambioDirectoAdmin('tok-aa', MES, movs, {}); } catch (e) { lanzo = /no tiene/i.test(String(e.message)); }
  ok(lanzo, 'un CTA raso no puede: le falta la vista «Incidencias»');

  let lanzo2 = false;
  try { sandbox.cambioDirectoAdmin('token-basura', MES, movs, {}); } catch (e) { lanzo2 = /no autorizado/i.test(String(e.message)); }
  ok(lanzo2, 'un token inválido tampoco');

  const vacio = sandbox.cambioDirectoAdmin(TOK_ADMIN, MES, [], {});
  ok(vacio.ok === false, 'sin movimientos, no hace nada', vacio);

  const pasado = sandbox.cambioDirectoAdmin(TOK_ADMIN, 'ENE-20', movs, {});
  ok(pasado.ok === false && /pasó/.test(pasado.error), 'un mes pasado se rechaza', pasado);
}

// ═══════════════════════════════════════════════════════════════════════════
seccion('Cambio directo · jefaturas (permitido a propósito)');
{
  const { sandbox } = nuevoEntorno();
  // JJ es JTWR: fuera del circuito normal de cambios. Intercambio limpio con BB
  // (M por T el mismo día), que conserva la cobertura de las dos franjas.
  const movs = [{ cta: 'JJ', dia: 1, de: 'M', a: 'T' }, { cta: 'BB', dia: 1, de: 'T', a: 'M' }];
  const normal = sandbox.registrarCambio('tok-bb', MES, movs, '');
  ok(normal.ok === false && /no participa/.test(normal.error || ''),
     'el circuito normal sigue dejando fuera a JTWR', normal);
  const directo = sandbox.cambioDirectoAdmin(TOK_ADMIN, MES, movs, { motivo: 'reorganización' });
  ok(directo.ok === true, 'el admin sí puede hacerlo por la vía directa', directo);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(64));
console.log(fallos === 0
  ? `TODO VERDE · ${pruebas} comprobaciones`
  : `${fallos} FALLOS de ${pruebas} comprobaciones`);
process.exit(fallos === 0 ? 0 : 1);
