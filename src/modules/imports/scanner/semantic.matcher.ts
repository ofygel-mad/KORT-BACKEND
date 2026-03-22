/**
 * semantic.matcher.ts
 *
 * Maps raw column headers + type scores to system field names.
 * Uses token-based matching + type compatibility heuristics.
 */

import type { ColumnTypeScores } from './column.classifier.js';

// ─────────────────────────────────────────────────────────────
//  Field definitions per import target
// ─────────────────────────────────────────────────────────────

export type ImportTarget =
  | 'customers'
  | 'leads'
  | 'warehouse_items'
  | 'warehouse_stock'
  | 'orders'
  | 'catalog'
  | 'accounting'
  | 'employees';

interface FieldDef {
  key: string;
  label: string;
  aliases: string[];       // normalized keywords to match against
  preferredType?: keyof ColumnTypeScores; // bonus for this type score
  required?: boolean;
}

const FIELD_DEFS: Record<ImportTarget, FieldDef[]> = {
  customers: [
    { key: 'full_name',    label: 'Имя клиента',  aliases: ['имя', 'клиент', 'name', 'фио', 'контакт'], preferredType: 'nameScore', required: true },
    { key: 'phone',        label: 'Телефон',       aliases: ['тел', 'phone', 'номер', 'телефон'],          preferredType: 'phoneScore' },
    { key: 'email',        label: 'Email',         aliases: ['email', 'почта', 'e-mail'] },
    { key: 'company_name', label: 'Компания',      aliases: ['компания', 'company', 'организация', 'фирма'] },
    { key: 'source',       label: 'Источник',      aliases: ['источник', 'source', 'откуда'],               preferredType: 'enumScore' },
    { key: 'status',       label: 'Статус',        aliases: ['статус', 'status'],                           preferredType: 'enumScore' },
    { key: 'notes',        label: 'Примечания',    aliases: ['коммент', 'notes', 'примеч', 'доп'] },
  ],
  leads: [
    { key: 'full_name',    label: 'Имя лида',      aliases: ['имя', 'клиент', 'name', 'фио'],               preferredType: 'nameScore', required: true },
    { key: 'phone',        label: 'Телефон',        aliases: ['тел', 'phone', 'номер', 'телефон'],           preferredType: 'phoneScore', required: true },
    { key: 'email',        label: 'Email',          aliases: ['email', 'почта'] },
    { key: 'source',       label: 'Источник лида',  aliases: ['источник', 'source', 'откуда', 'канал'],      preferredType: 'enumScore' },
    { key: 'budget',       label: 'Бюджет',         aliases: ['бюджет', 'budget', 'сумма'],                  preferredType: 'moneyScore' },
    { key: 'comment',      label: 'Комментарий',    aliases: ['коммент', 'comment', 'примеч'] },
  ],
  orders: [
    { key: 'order_number',   label: '№ Заказа',        aliases: ['заказ', 'зак', 'order', 'номер', '№'],       preferredType: 'idScore', required: true },
    { key: 'customer_name',  label: 'Клиент',           aliases: ['клиент', 'имя клиента', 'заказчик'],         preferredType: 'nameScore' },
    { key: 'phone',          label: 'Телефон',          aliases: ['тел', 'phone', 'номер'],                     preferredType: 'phoneScore' },
    { key: 'product_name',   label: 'Товар',            aliases: ['товар', 'product', 'наименование', 'изделие'] },
    { key: 'fabric',         label: 'Ткань',            aliases: ['ткань', 'fabric', 'материал'],               preferredType: 'enumScore' },
    { key: 'size',           label: 'Размер',           aliases: ['размер', 'size'],                            preferredType: 'enumScore' },
    { key: 'color',          label: 'Цвет',             aliases: ['цвет', 'color', 'colour'],                   preferredType: 'enumScore' },
    { key: 'gender',         label: 'Муж/Жен',          aliases: ['муж', 'жен', 'gender', 'пол'],               preferredType: 'enumScore' },
    { key: 'quantity',       label: 'Кол-во',           aliases: ['кол', 'количество', 'qty', 'count', 'шт'],   preferredType: 'quantityScore' },
    { key: 'unit_price',     label: 'Цена',             aliases: ['цена', 'price', 'стоимость'],                 preferredType: 'moneyScore' },
    { key: 'total_amount',   label: 'Сумма',            aliases: ['сумма', 'итого', 'total', 'amount'],          preferredType: 'moneyScore' },
    { key: 'payment_method', label: 'Вид оплаты',       aliases: ['оплат', 'payment', 'метод', 'вид'],           preferredType: 'enumScore' },
    { key: 'created_at',     label: 'Дата продажи',     aliases: ['дата', 'date', 'продажи', 'created'],         preferredType: 'dateScore' },
    { key: 'due_date',       label: 'Дата выполнения',  aliases: ['завершен', 'выполнен', 'срок', 'due'],        preferredType: 'dateScore' },
    { key: 'status',         label: 'Статус',           aliases: ['статус', 'готово', 'status'],                 preferredType: 'enumScore' },
    { key: 'city',           label: 'Город',            aliases: ['город', 'city'] },
    { key: 'manager_name',   label: 'Менеджер',         aliases: ['менедж', 'manager', 'продавец'],              preferredType: 'nameScore' },
    { key: 'notes',          label: 'Примечание',       aliases: ['коммент', 'примеч', 'notes', 'доп'] },
    { key: 'cost_price',     label: 'Себестоимость',    aliases: ['себес', 'cost', 'cost_price', 'закуп'],       preferredType: 'moneyScore' },
    { key: 'discount',       label: 'Скидка',           aliases: ['скидка', 'discount', 'discnt'],               preferredType: 'moneyScore' },
    { key: 'delivery_method',label: 'Доставка',         aliases: ['доставк', 'delivery', 'транспорт'],           preferredType: 'enumScore' },
  ],
  catalog: [
    { key: 'name',       label: 'Наименование',  aliases: ['наимен', 'name', 'товар', 'изделие', 'продукт'], required: true },
    { key: 'category',   label: 'Категория',     aliases: ['катал', 'категор', 'category', 'коллекц'] },
    { key: 'fabric',     label: 'Ткань',         aliases: ['ткань', 'fabric', 'материал'] },
    { key: 'size_range', label: 'Размерный ряд', aliases: ['размер', 'size', 'ряд'] },
    { key: 'colors',     label: 'Цвета',         aliases: ['цвет', 'color', 'colour'] },
    { key: 'unit_price', label: 'Цена',          aliases: ['цена', 'price', 'стоим'],                       preferredType: 'moneyScore' },
    { key: 'notes',      label: 'Описание',      aliases: ['описан', 'notes', 'коммент'] },
  ],
  warehouse_items: [
    { key: 'name',       label: 'Название',       aliases: ['наимен', 'name', 'товар', 'позиц'],             required: true },
    { key: 'sku',        label: 'Артикул',        aliases: ['артикул', 'sku', 'код', 'id'] },
    { key: 'unit',       label: 'Ед. изм.',       aliases: ['ед', 'unit', 'единиц'],                         preferredType: 'enumScore' },
    { key: 'qty',        label: 'Количество',     aliases: ['кол', 'qty', 'количество', 'остат'],             preferredType: 'quantityScore' },
    { key: 'cost_price', label: 'Себестоимость',  aliases: ['себес', 'cost', 'цена', 'price'],               preferredType: 'moneyScore' },
    { key: 'category',   label: 'Категория',      aliases: ['категор', 'category', 'группа'] },
    { key: 'location',   label: 'Место хранения', aliases: ['место', 'склад', 'location', 'полка'] },
    { key: 'notes',      label: 'Примечания',     aliases: ['примеч', 'notes', 'коммент'] },
  ],
  warehouse_stock: [
    { key: 'name',  label: 'Название',    aliases: ['наимен', 'name', 'товар'],   required: true },
    { key: 'qty',   label: 'Количество',  aliases: ['кол', 'qty', 'остат', 'ост'], preferredType: 'quantityScore', required: true },
    { key: 'unit',  label: 'Ед. изм.',    aliases: ['ед', 'unit'] },
  ],
  accounting: [
    { key: 'type',        label: 'Тип',         aliases: ['тип', 'type', 'вид'],                             preferredType: 'enumScore' },
    { key: 'amount',      label: 'Сумма',       aliases: ['сумма', 'amount', 'итого', 'оборот'],             preferredType: 'moneyScore', required: true },
    { key: 'category',    label: 'Категория',   aliases: ['категор', 'category', 'статья'] },
    { key: 'account',     label: 'Счёт',        aliases: ['счёт', 'счет', 'account', 'касса'] },
    { key: 'counterparty',label: 'Контрагент',  aliases: ['контраг', 'counterp', 'клиент', 'поставщ'] },
    { key: 'date',        label: 'Дата',        aliases: ['дата', 'date', 'created'],                        preferredType: 'dateScore', required: true },
    { key: 'notes',       label: 'Примечание',  aliases: ['примеч', 'notes', 'коммент'] },
  ],
  employees: [
    { key: 'full_name',   label: 'ФИО',         aliases: ['фио', 'имя', 'name', 'сотрудник'],               preferredType: 'nameScore', required: true },
    { key: 'phone',       label: 'Телефон',     aliases: ['тел', 'phone', 'номер'],                         preferredType: 'phoneScore' },
    { key: 'role',        label: 'Роль',        aliases: ['роль', 'role', 'должность', 'позиц'],             preferredType: 'enumScore' },
    { key: 'department',  label: 'Отдел',       aliases: ['отдел', 'departm', 'цех'],                        preferredType: 'enumScore' },
  ],
};

// ─────────────────────────────────────────────────────────────
//  Normalizer
// ─────────────────────────────────────────────────────────────

function normalize(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^а-яёa-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenOverlap(a: string, b: string): number {
  const ta = new Set(normalize(a).split(' ').filter(Boolean));
  const tb = new Set(normalize(b).split(' ').filter(Boolean));
  let hits = 0;
  for (const t of ta) {
    if ([...tb].some((bt) => bt.startsWith(t) || t.startsWith(bt))) hits++;
  }
  return hits / Math.max(ta.size, tb.size, 1);
}

// ─────────────────────────────────────────────────────────────
//  Main: compute mapping
// ─────────────────────────────────────────────────────────────

export interface MappingSuggestion {
  sourceColumn: string;
  targetField: string | null;
  targetLabel: string | null;
  confidence: number;   // 0.0 – 1.0
}

export function suggestMapping(
  headers: string[],
  columnScores: ColumnTypeScores[],
  target: ImportTarget,
): MappingSuggestion[] {
  const fields = FIELD_DEFS[target] ?? [];
  const emptyScores: ColumnTypeScores = {
    dateScore: 0,
    moneyScore: 0,
    phoneScore: 0,
    enumScore: 0,
    idScore: 0,
    nameScore: 0,
    quantityScore: 0,
    textScore: 0,
  };

  // For each source column, find best matching field
  const usedFields = new Set<string>();

  return headers.map((header, idx) => {
    const scores = columnScores[idx] ?? emptyScores;
    let bestField: FieldDef | null = null;
    let bestScore = 0;

    for (const field of fields) {
      if (usedFields.has(field.key)) continue;

      // Token overlap against all aliases
      const aliasScore = Math.max(...field.aliases.map((a) => tokenOverlap(header, a)));

      // Type bonus
      const typeBonus = field.preferredType ? (scores[field.preferredType] ?? 0) * 0.3 : 0;

      const total = aliasScore * 0.7 + typeBonus;

      if (total > bestScore) {
        bestScore = total;
        bestField = field;
      }
    }

    // Threshold: below 0.15 → no match
    if (bestScore < 0.15 || !bestField) {
      return { sourceColumn: header, targetField: null, targetLabel: null, confidence: 0 };
    }

    usedFields.add(bestField.key);
    return {
      sourceColumn: header,
      targetField: bestField.key,
      targetLabel: bestField.label,
      confidence: Math.min(1, bestScore),
    };
  });
}

/**
 * Auto-detect most likely import target from column headers.
 * Returns { target, confidence }
 */
export function detectTarget(headers: string[]): { target: ImportTarget; confidence: number } {
  const normalized = headers.map(normalize).join(' ');

  const signals: Array<{ target: ImportTarget; keywords: string[]; weight: number }> = [
    { target: 'orders',          keywords: ['заказ', 'товар', 'ткань', 'размер', 'цех'], weight: 0 },
    { target: 'catalog',         keywords: ['каталог', 'наименован', 'ткань', 'коллекц'], weight: 0 },
    { target: 'warehouse_items', keywords: ['артикул', 'sku', 'остат', 'склад', 'ед изм'], weight: 0 },
    { target: 'customers',       keywords: ['клиент', 'покупател', 'контакт', 'организац'], weight: 0 },
    { target: 'accounting',      keywords: ['приход', 'расход', 'оборот', 'счёт', 'проводк'], weight: 0 },
    { target: 'employees',       keywords: ['сотрудник', 'мастер', 'исполнитель', 'рабочий'], weight: 0 },
  ];

  for (const s of signals) {
    for (const kw of s.keywords) {
      if (normalized.includes(kw)) s.weight++;
    }
  }

  signals.sort((a, b) => b.weight - a.weight);
  const best = signals[0];
  if (!best) {
    return { target: 'customers', confidence: 0 };
  }
  const maxWeight = best.keywords.length;

  return {
    target: best.weight > 0 ? best.target : 'customers',
    confidence: best.weight > 0 ? Math.min(1, best.weight / maxWeight) : 0,
  };
}

export { FIELD_DEFS };
