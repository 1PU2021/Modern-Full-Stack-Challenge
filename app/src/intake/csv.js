'use strict';

// Minimal RFC4180-ish CSV parser: comma-delimited, optional double-quoted
// fields with "" escaping. No external dependency -- the supported format
// (see docs/APP_SPEC.md-adjacent README CSV section) is simple enough that
// hand-rolling this is smaller and more auditable than pulling in a package.
function parseCsvLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

// Returns an array of raw rows (each an array of string cells), including
// the header row as rows[0]. Blank lines are skipped entirely.
function parseCsv(text) {
  return text
    .split(/\r\n|\r|\n/)
    .filter((line) => line.length > 0)
    .map(parseCsvLine);
}

module.exports = { parseCsv, parseCsvLine };
