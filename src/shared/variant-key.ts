// Canonical variant-key builder. Shared contract between frontend and backend.
//
// The lookup key for a warehouse SKU must be byte-identical wherever it is
// constructed: backend writes (createItem, reservations, availability check)
// and frontend reads (order form availability lookup). Any drift here means
// the order form silently shows "Нет на складе" for legitimate inventory.
//
// Mirror at src/shared/utils/variantKey.ts must remain identical. A golden
// fixture test in both repos enforces the contract.

export interface VariantFieldDef {
  code: string;
  affectsAvailability: boolean;
}

export type VariantAttributes = Record<string, string | null | undefined>;

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function buildCanonicalVariantKey(
  productName: string,
  attributes: VariantAttributes,
  fields: VariantFieldDef[],
): string {
  if (!Array.isArray(fields)) {
    throw new Error(
      'buildCanonicalVariantKey: fields must be an array of field definitions. ' +
      'Pass [] explicitly if no axis filtering is desired.',
    );
  }

  const allowed = new Set(
    fields.filter((f) => f.affectsAvailability).map((f) => f.code),
  );

  const base = normalize(productName);
  const parts = Object.entries(attributes)
    .filter(([code, raw]) => {
      if (!allowed.has(code)) return false;
      const value = (raw ?? '').toString().trim();
      return value.length > 0;
    })
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, raw]) => `${code}:${normalize((raw ?? '').toString())}`);

  return [base, ...parts].join('|');
}
