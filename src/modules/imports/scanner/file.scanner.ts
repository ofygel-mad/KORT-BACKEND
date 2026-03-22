/**
 * file.scanner.ts
 *
 * Parses uploaded XLSX / CSV files and runs the analysis pipeline:
 *  1. Parse → raw rows + headers
 *  2. Classify columns (type scores)
 *  3. Semantic match → field mapping suggestions
 *  4. Detect target module
 *  5. Return preview + mapping
 *
 * Depends on: exceljs, papaparse (to be installed)
 * Falls back gracefully if packages are not available.
 */

import { readFileSync, existsSync } from 'node:fs';
import { extname } from 'node:path';
import { classifyColumn } from './column.classifier.js';
import { suggestMapping, detectTarget } from './semantic.matcher.js';
import type { ImportTarget } from './semantic.matcher.js';

const SAMPLE_ROWS = 50;
const PREVIEW_ROWS = 8;

export interface SheetInfo {
  name: string;
  headers: string[];
  rows: (string | number | null)[][];
  totalRows: number;
  columnScores: ReturnType<typeof classifyColumn>[];
  suggestions: ReturnType<typeof suggestMapping>;
  detectedTarget: { target: ImportTarget; confidence: number };
}

export interface ScanResult {
  fileName: string;
  extension: string;
  sheets: SheetInfo[];
  isPdf: boolean;
}

// ─────────────────────────────────────────────────────────────
//  XLSX parser (uses exceljs if available, else basic fallback)
// ─────────────────────────────────────────────────────────────

async function parseXlsx(filePath: string): Promise<Array<{ name: string; rows: unknown[][] }>> {
  try {
    // Dynamic import — works when exceljs is installed
    const ExcelJS = await import('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);

    const sheets: Array<{ name: string; rows: unknown[][] }> = [];

    wb.eachSheet((ws) => {
      // Skip purely technical/formula sheets
      if (ws.name.startsWith('техн') || ws.name === 'черн' || ws.name === 'Формулы') return;

      const rows: unknown[][] = [];
      ws.eachRow({ includeEmpty: false }, (row) => {
        const vals = row.values as unknown[];
        // row.values is 1-indexed, first element is undefined
        rows.push(
          vals.slice(1).map((v) => {
            if (v === null || v === undefined) return null;
            if (typeof v === 'object' && 'result' in (v as Record<string, unknown>)) {
              // Formula cell — use computed result
              return (v as { result: unknown }).result ?? null;
            }
            if (v instanceof Date) return v.toISOString().slice(0, 10);
            return v;
          }),
        );
      });

      if (rows.length > 0) {
        sheets.push({ name: ws.name, rows });
      }
    });

    return sheets;
  } catch (err) {
    // Fallback: try openpyxl via child_process (for dev environments)
    console.warn('[scanner] exceljs not available, returning empty parse:', err);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
//  CSV parser
// ─────────────────────────────────────────────────────────────

async function parseCsv(filePath: string): Promise<Array<{ name: string; rows: unknown[][] }>> {
  try {
    const Papa = await import('papaparse');
    const content = readFileSync(filePath, 'utf-8');
    const result = Papa.default.parse(content, { header: false, skipEmptyLines: true });
    return [{ name: 'Sheet1', rows: result.data as unknown[][] }];
  } catch {
    // Manual CSV parse fallback
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim());
    const rows = lines.map((l) =>
      l.split(',').map((cell) => cell.trim().replace(/^"|"$/g, '')),
    );
    return [{ name: 'Sheet1', rows }];
  }
}

// ─────────────────────────────────────────────────────────────
//  Find header row (first row with mostly non-empty strings)
// ─────────────────────────────────────────────────────────────

function findHeaderRow(rows: unknown[][]): { headerIdx: number; dataStartIdx: number } {
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    const row = rows[i] as (string | number | null)[];
    const strCells = row.filter((v) => v !== null && typeof v === 'string' && v.trim().length > 1);
    if (strCells.length >= Math.max(2, row.length * 0.4)) {
      return { headerIdx: i, dataStartIdx: i + 1 };
    }
  }
  return { headerIdx: 0, dataStartIdx: 1 };
}

// ─────────────────────────────────────────────────────────────
//  Clean a cell value to string/number/null
// ─────────────────────────────────────────────────────────────

function cleanCell(v: unknown): string | number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (!s) return null;
  return s;
}

// ─────────────────────────────────────────────────────────────
//  Analyze a single sheet
// ─────────────────────────────────────────────────────────────

function analyzeSheet(
  sheetName: string,
  rawRows: unknown[][],
  target?: ImportTarget,
): SheetInfo {
  const { headerIdx, dataStartIdx } = findHeaderRow(rawRows);

  const headerRow = rawRows[headerIdx] as (string | number | null)[];
  const headers = headerRow
    .map((h) => (h !== null && h !== undefined ? String(h).trim() : ''))
    .filter((h) => h.length > 0);

  const dataRows = rawRows.slice(dataStartIdx);
  const totalRows = dataRows.length;

  // Build clean rows for preview + sampling
  const sample = dataRows.slice(0, SAMPLE_ROWS);
  const preview = dataRows.slice(0, PREVIEW_ROWS).map((row) =>
    headers.map((_, colIdx) => cleanCell((row as unknown[])[colIdx])),
  );

  // Column classification
  const columnScores = headers.map((_, colIdx) => {
    const colSample = sample.map((row) => cleanCell((row as unknown[])[colIdx]));
    return classifyColumn(colSample);
  });

  // Detect target if not provided
  const detectedTarget = target
    ? { target, confidence: 1.0 }
    : detectTarget(headers);

  // Suggest mapping
  const suggestions = suggestMapping(headers, columnScores, detectedTarget.target);

  return {
    name: sheetName,
    headers,
    rows: preview,
    totalRows,
    columnScores,
    suggestions,
    detectedTarget,
  };
}

// ─────────────────────────────────────────────────────────────
//  Main scan entry point
// ─────────────────────────────────────────────────────────────

export async function scanFile(filePath: string, hintTarget?: ImportTarget): Promise<ScanResult> {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const ext = extname(filePath).toLowerCase();
  const fileName = filePath.split('/').pop() ?? '';

  if (ext === '.pdf') {
    // PDF: return minimal result — handled separately
    return { fileName, extension: ext, sheets: [], isPdf: true };
  }

  let rawSheets: Array<{ name: string; rows: unknown[][] }> = [];

  if (ext === '.xlsx' || ext === '.xlsm' || ext === '.xls') {
    rawSheets = await parseXlsx(filePath);
  } else if (ext === '.csv' || ext === '.tsv') {
    rawSheets = await parseCsv(filePath);
  } else if (ext === '.ods') {
    // ODS: try exceljs or skip
    rawSheets = await parseXlsx(filePath).catch(() => []);
  }

  const sheets = rawSheets
    .filter((s) => s.rows.length > 1) // skip empty sheets
    .map((s) => analyzeSheet(s.name, s.rows, hintTarget));

  return { fileName, extension: ext, sheets, isPdf: false };
}

/**
 * Quick dedup check: given parsed rows + target field key for ID/phone,
 * returns list of row indices that look like duplicates.
 */
export function detectDuplicatesInFile(
  rows: (string | number | null)[][],
  keyColIdx: number,
): number[] {
  const seen = new Map<string, number>();
  const dupes: number[] = [];

  for (let i = 0; i < rows.length; i++) {
    const val = rows[i]?.[keyColIdx];
    if (val === null) continue;
    const key = String(val).trim().toLowerCase();
    if (seen.has(key)) {
      dupes.push(i);
    } else {
      seen.set(key, i);
    }
  }

  return dupes;
}
