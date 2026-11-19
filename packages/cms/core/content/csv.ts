/**
 * A small RFC 4180 reader, for importing records. Quoted fields may hold commas, newlines and
 * doubled quotes; a row's trailing spaces are kept, since a text field may want them. The
 * separator is detected from the header line, so a semicolon file from a spreadsheet works.
 */

export interface CsvProblem {
  line: number;
  message: string;
}

const SEPARATORS = [",", ";", "\t"] as const;

/** The separator the header line uses: whichever of comma, semicolon or tab appears most outside quotes. */
export function detectSeparator(text: string) {
  const header = firstLine(text);
  let best: string = SEPARATORS[0];
  let most = 0;
  for (const candidate of SEPARATORS) {
    const count = countOutsideQuotes(header, candidate);
    if (count > most) {
      most = count;
      best = candidate;
    }
  }
  return best;
}

function firstLine(text: string) {
  let quoted = false;
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === "\n" || char === "\r")) return text.slice(0, at);
  }
  return text;
}

function countOutsideQuotes(line: string, separator: string) {
  let quoted = false;
  let count = 0;
  for (const char of line) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === separator) count++;
  }
  return count;
}

/** Every row as a list of cells. A quote inside a quoted cell is written twice. */
export function parseCsvRows(text: string, separator: string): { rows: string[][]; problems: CsvProblem[] } {
  const rows: string[][] = [];
  const problems: CsvProblem[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let started = false;

  const endCell = () => {
    cells.push(cell);
    cell = "";
  };
  const endRow = () => {
    endCell();
    // A blank line is not a row.
    if (cells.length > 1 || cells[0] !== "") rows.push(cells);
    cells = [];
  };

  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (quoted) {
      if (char === '"') {
        if (text[at + 1] === '"') {
          cell += '"';
          at++;
        } else quoted = false;
      } else {
        if (char === "\n") line++;
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      if (cell !== "") problems.push({ line, message: "A quote in the middle of a cell. Quote the whole cell, and write a quote inside it twice." });
      quoted = true;
      started = true;
      continue;
    }
    if (char === separator) {
      endCell();
      started = true;
      continue;
    }
    if (char === "\r") continue;
    if (char === "\n") {
      endRow();
      line++;
      started = false;
      continue;
    }
    cell += char;
    started = true;
  }
  if (quoted) problems.push({ line, message: "A quoted cell is never closed." });
  if (started || cells.length) endRow();
  return { rows, problems };
}

export interface CsvTable {
  columns: string[];
  /** One object per row, by column name. A row with fewer cells than the header leaves the rest out. */
  rows: Array<Record<string, string>>;
  problems: CsvProblem[];
}

/** The file as a header and rows by column name. A column with no name, or a repeated one, is a problem. */
export function parseCsv(text: string, separator = detectSeparator(text)): CsvTable {
  const { rows: raw, problems } = parseCsvRows(text.replace(/^﻿/, ""), separator);
  if (!raw.length) return { columns: [], rows: [], problems: [...problems, { line: 1, message: "The file is empty." }] };
  const columns = raw[0].map((name) => name.trim());
  const seen = new Set<string>();
  for (const [index, name] of columns.entries()) {
    if (!name) problems.push({ line: 1, message: `Column ${index + 1} has no name.` });
    else if (seen.has(name)) problems.push({ line: 1, message: `There is more than one column called "${name}".` });
    seen.add(name);
  }
  const rows = raw.slice(1).map((cells) => {
    const row: Record<string, string> = {};
    for (const [index, name] of columns.entries()) if (name && index < cells.length) row[name] = cells[index];
    return row;
  });
  return { columns, rows, problems };
}
