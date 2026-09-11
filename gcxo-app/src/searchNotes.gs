function searchNotes() {

  var allSheets = SpreadsheetApp.getActive().getSheets();

  var sheet = SpreadsheetApp.getActiveSheet();
  var cell = sheet.getActiveCell();
  var searchTerm = cell.getValue().toString().toLowerCase();
  var results = [];

  for(var s in allSheets){
    var dataRange = allSheets[s].getDataRange();
    var notes = dataRange.getNotes();
    for (var i = 0; i < notes.length; i++) {
      for (var j = 0; j < notes[0].length; j++) {
        var note = notes[i][j].toLowerCase();
        if (note && note.indexOf(searchTerm) !== -1) {
          results.push(allSheets[s].getName() + ': ' + dataRange.offset(i, j, 1, 1).getA1Notation() + ': ' + notes[i][j] + '\n\n');
        }
      }
    }
  }
  cell.setValue(results.join('') || 'Not found');
}

// El menú lo monta el onOpen único de asignacionSup.js. Aquí había un segundo
// onOpen: Apps Script solo admite uno por proyecto y el otro se perdía.
