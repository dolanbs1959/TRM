const fs = require('fs');

let content = fs.readFileSync('functions/pdfGenerator.js', 'utf8');

// Replace UOM calculations in PDF to be mathematically sound for LF as well, but wait, the prompt asks:
// If UOM contains sq, line total = qty * unit price * square footage.
// If UOM contains LF, line total = qty * unit price * linear feet.
// BUT sqFootage is the field holding linear feet in the UI if unit is lf
// Wait, linear feet means they put the linear feet in "sqFootage" field or "qty" field?
// "If UOM contains LF, line total = qty × unit price × linear feet."
// "Otherwise, line total = qty × unit price."
