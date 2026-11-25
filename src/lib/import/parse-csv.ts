import Papa from "papaparse";

// A real personal-finance history is a few hundred rows; these only stop a wrong file (a
// database dump, a photo renamed .csv) from freezing the browser tab.
export const MAX_ROWS = 5000;
export const MAX_CHARS = 2_000_000;

export interface ParsedCsv {
  headers: Array<string>;
  rows: Array<Array<string>>;
  /** Each row's line in the file (1-based), counting the blank lines that were dropped. */
  lines: Array<number>;
}

/** Reads CSV text in the browser. Throws an Error with a plain-language message on a bad file. */
export function parseCsv(text: string): ParsedCsv {
  if (text.length > MAX_CHARS) {
    throw new Error("The file is too large (limit is 2 MB). Is it the right file?");
  }
  const clean = text.replace(/^\uFEFF/, "");
  if (clean.trim() === "") throw new Error("The file is empty.");

  // Guess the delimiter with blank lines skipped (they would read as one-column rows), then
  // read every line with it.
  const { delimiter } = Papa.parse<Array<string>>(clean, {
    delimitersToGuess: [",", ";", "\t", "|"],
    skipEmptyLines: "greedy",
    preview: 50,
  }).meta;
  const result = Papa.parse<Array<string>>(clean, { delimiter });

  const brokenQuote = result.errors.find((e) => e.type === "Quotes");
  if (brokenQuote) {
    throw new Error(`The file has a broken quote near line ${(brokenQuote.row ?? 0) + 1}.`);
  }

  // Blank lines are dropped here, not by the parser, so each row keeps its line in the file
  // (a quoted cell spanning lines counts each of them).
  const kept: Array<{ row: Array<string>; line: number }> = [];
  let line = 1;
  for (const row of result.data) {
    if (row.some((c) => c.trim() !== "")) kept.push({ row, line });
    line += 1 + row.reduce((n, c) => n + (c.match(/\n/g)?.length ?? 0), 0);
  }
  const [header, ...body] = kept;
  const headerRow = header?.row;
  if (!headerRow || body.length === 0) throw new Error("The file has no data rows, only a header.");
  if (body.length > MAX_ROWS) {
    throw new Error(`The file has too many rows (limit is ${MAX_ROWS}).`);
  }

  return {
    headers: headerRow.map((h) => h.trim()),
    rows: body.map(({ row }) => row.map((cell) => cell.trim())),
    lines: body.map((r) => r.line),
  };
}

/**
 * A file's bytes as text. Most exports are UTF-8; older bank and Excel exports in Europe are
 * Windows-1252, where "é" or "€" are single bytes that are not valid UTF-8. Excel's "Unicode
 * text" is UTF-16.
 */
export function decodeCsv(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // Excel's "Unicode text" is UTF-16 and starts with a byte-order mark.
  if (view[0] === 0xff && view[1] === 0xfe) return new TextDecoder("utf-16le").decode(view);
  if (view[0] === 0xfe && view[1] === 0xff) return new TextDecoder("utf-16be").decode(view);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/** A picked file as CSV text, in any of the encodings decodeCsv reads. Refuses a file too large
 * to be under MAX_CHARS characters (at most 4 bytes each) before loading it into memory. */
export async function readCsvFile(file: Blob): Promise<string> {
  if (file.size > MAX_CHARS * 4) {
    throw new Error("The file is too large (limit is 8 MB). Is it the right file?");
  }
  return decodeCsv(await file.arrayBuffer());
}
