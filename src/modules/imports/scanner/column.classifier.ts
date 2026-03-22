/**
 * column.classifier.ts
 *
 * Analyses a sample of cell values and returns a type confidence score
 * for each possible semantic type.
 */

export interface ColumnTypeScores {
  dateScore: number;
  moneyScore: number;
  phoneScore: number;
  enumScore: number;
  idScore: number;
  nameScore: number;
  quantityScore: number;
  textScore: number;
}

const PHONE_RE = /^[\+\d][\d\s\-\(\)]{7,14}$/;
const DATE_PATTERNS = [
  /^\d{2}\.\d{2}\.\d{4}$/,
  /^\d{4}-\d{2}-\d{2}$/,
  /^\d{2}\/\d{2}\/\d{4}$/,
  /^\d{2}\.\d{2}$/,
];
const ORDER_ID_RE = /^\d{2}\.\d{2}-\d+-\d+$|^[А-Яа-яA-Za-z]{2,5}-\d+(-\d+)?$|^[А-ЯA-Z]{2,4}-\d{4,}$/;
const MONEY_RE = /^[\d\s,.]+$|^\d+[\.,]\d{2}$/;
const CYRILLIC_NAME_RE = /^[А-ЯЁ][а-яё]+(\s+[А-ЯЁ][а-яё]+){1,3}$/;

/**
 * Returns scores 0.0 – 1.0 for each column type based on a sample of values.
 */
export function classifyColumn(sample: (string | number | Date | null | undefined)[]): ColumnTypeScores {
  const cells = sample
    .filter((v) => v !== null && v !== undefined && v !== '')
    .map((v) => (v instanceof Date ? v.toISOString() : String(v).trim()));

  if (cells.length === 0) {
    return { dateScore: 0, moneyScore: 0, phoneScore: 0, enumScore: 0, idScore: 0, nameScore: 0, quantityScore: 0, textScore: 0 };
  }

  let dateHits = 0;
  let moneyHits = 0;
  let phoneHits = 0;
  let idHits = 0;
  let nameHits = 0;
  let quantityHits = 0;
  const uniqueValues = new Set<string>();

  for (const cell of cells) {
    uniqueValues.add(cell.toLowerCase());

    // Date
    if (DATE_PATTERNS.some((re) => re.test(cell))) dateHits++;
    else if (!isNaN(Date.parse(cell)) && cell.length >= 8) dateHits += 0.5;

    // Phone
    if (PHONE_RE.test(cell.replace(/[\s\-\(\)]/g, ''))) phoneHits++;

    // Order ID
    if (ORDER_ID_RE.test(cell)) idHits++;

    // Money — numeric with possible separators, no letters
    if (MONEY_RE.test(cell) && !PHONE_RE.test(cell)) moneyHits++;

    // Name
    if (CYRILLIC_NAME_RE.test(cell)) nameHits++;

    // Quantity — small positive integer
    const num = parseFloat(cell.replace(',', '.'));
    if (!isNaN(num) && Number.isInteger(num) && num >= 1 && num <= 9999 && !PHONE_RE.test(cell)) {
      quantityHits++;
    }
  }

  const n = cells.length;
  const uniqueRatio = uniqueValues.size / n;

  return {
    dateScore: dateHits / n,
    moneyScore: moneyHits / n,
    phoneScore: phoneHits / n,
    idScore: idHits / n,
    nameScore: nameHits / n,
    quantityScore: Math.min(1, quantityHits / n),
    // Enum: low unique ratio = repetitive = likely enum
    enumScore: uniqueRatio < 0.3 ? 1 - uniqueRatio : Math.max(0, 0.6 - uniqueRatio),
    // Text: default fallback score
    textScore: 0.2,
  };
}

/** Return the dominant type label from scores */
export function dominantType(scores: ColumnTypeScores): string {
  const sorted = Object.entries(scores).sort(([, a], [, b]) => b - a);
  return (sorted[0]?.[0] ?? 'textScore').replace('Score', '');
}
