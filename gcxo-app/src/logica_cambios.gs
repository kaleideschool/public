/*******************************************************************************
 *
 * LÓGICA DE CAMBIOS (pura) — sin dependencias de Apps Script.
 * Deriva el tipo de cambio, los participantes y un resumen legible a partir
 * de la lista de movimientos. Testeable en Node.
 *
 ******************************************************************************/

var VERSION_LOGICA = 'logica-1';

// Participantes distintos de un bloque de movimientos.
function participantesDe(movimientos) {
  var set = {};
  for (var i = 0; i < movimientos.length; i++) set[movimientos[i].cta] = true;
  return Object.keys(set);
}

// Clasifica el bloque: CESION / INTERCAMBIO / CADENA / MULTI.
function derivarTipo(movimientos) {
  var participantes = participantesDe(movimientos);
  var hayLibre = movimientos.some(function (m) {
    return String(m.de).toLowerCase() === 'libre' || String(m.a).toLowerCase() === 'libre';
  });
  if (participantes.length >= 3) return 'CADENA';
  if (participantes.length === 2) return hayLibre ? 'CESION' : 'INTERCAMBIO';
  if (participantes.length === 1) return 'MULTI';
  return 'MULTI';
}

// Resumen legible: "JPZ · día 14 · T→M | ABC · día 14 · M→T"
function resumirCambio(movimientos) {
  return movimientos.map(function (m) {
    return m.cta + ' · día ' + m.dia + ' · ' + m.de + '→' + m.a;
  }).join(' | ');
}

// Movimientos que afectan a un controlador concreto.
function movimientosDe(movimientos, cta) {
  return movimientos.filter(function (m) { return m.cta === cta; });
}

// Comprueba que un bloque está "equilibrado" por franja y día: para cada
// (día, franja) la cantidad que sale es igual a la que entra. Es una
// comprobación barata previa al motor (evita registros incoherentes).
function bloqueEquilibrado(movimientos, franjaDe) {
  var balance = {}; // clave "dia|franja" -> neto
  movimientos.forEach(function (m) {
    var fDe = franjaDe(m.de), fA = franjaDe(m.a);
    if (fDe) { var k1 = m.dia + '|' + fDe; balance[k1] = (balance[k1] || 0) - 1; }
    if (fA)  { var k2 = m.dia + '|' + fA;  balance[k2] = (balance[k2] || 0) + 1; }
  });
  var desequilibrios = [];
  for (var k in balance) if (balance[k] !== 0) desequilibrios.push({ clave: k, neto: balance[k] });
  return { equilibrado: desequilibrios.length === 0, desequilibrios: desequilibrios };
}

// Export para Node (ignorado por Apps Script).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    participantesDe: participantesDe,
    derivarTipo: derivarTipo,
    resumirCambio: resumirCambio,
    movimientosDe: movimientosDe,
    bloqueEquilibrado: bloqueEquilibrado
  };
}
