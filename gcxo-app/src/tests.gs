function generarTokensQueFalten() {
  var sh = SpreadsheetApp.getActive().getSheetByName('CONTROLADORES');
  var n = sh.getLastRow() - 1;
  var rng = sh.getRange(2, 4, n, 1); // columna D
  var val = rng.getValues();
  for (var i = 0; i < val.length; i++) {
    if (!val[i][0]) val[i][0] = Utilities.getUuid().replace(/-/g, '');
  }
  rng.setValues(val);
}