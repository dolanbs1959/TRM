const fs = require('fs');

let content = fs.readFileSync('functions/pdfGenerator.js', 'utf8');

// Replace UOM calculations in PDF
content = content.replace(
    /const multiplier = isPerSquareUnit\(uom\) \? sqFootage : 1;/,
    "const multiplier = isPerSquareUnit(uom) ? sqFootage : (uom.toLowerCase().includes('lf') ? sqFootage : 1);"
);

fs.writeFileSync('functions/pdfGenerator.js', content);
