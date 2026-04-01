import { prisma } from '../../lib/prisma.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function buildVariantKey(productName: string, attributes: Record<string, string>): string {
  const base = normalizeName(productName);
  const parts = Object.entries(attributes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${normalizeName(v)}`);
  return [base, ...parts].join('|');
}

// ── Field Definitions ──────────────────────────────────────────────────────────

export async function getFieldDefinitions(orgId: string) {
  return prisma.warehouseFieldDefinition.findMany({
    where: { orgId },
    include: {
      options: {
        where: { isActive: true },
        orderBy: { sortOrder: 'asc' },
      },
    },
    orderBy: { sortOrder: 'asc' },
  });
}

export async function createFieldDefinition(orgId: string, data: {
  code: string;
  label: string;
  inputType: string;
  entityScope?: string;
  isRequired?: boolean;
  isVariantAxis?: boolean;
  showInWarehouseForm?: boolean;
  showInOrderForm?: boolean;
  showInDocuments?: boolean;
  affectsAvailability?: boolean;
  sortOrder?: number;
}) {
  return prisma.warehouseFieldDefinition.create({
    data: {
      orgId,
      code: data.code.trim().toLowerCase().replace(/\s+/g, '_'),
      label: data.label.trim(),
      inputType: data.inputType,
      entityScope: data.entityScope ?? 'both',
      isRequired: data.isRequired ?? false,
      isVariantAxis: data.isVariantAxis ?? false,
      showInWarehouseForm: data.showInWarehouseForm ?? true,
      showInOrderForm: data.showInOrderForm ?? true,
      showInDocuments: data.showInDocuments ?? true,
      affectsAvailability: data.affectsAvailability ?? true,
      sortOrder: data.sortOrder ?? 0,
    },
    include: { options: true },
  });
}

export async function updateFieldDefinition(id: string, data: {
  label?: string;
  isRequired?: boolean;
  isVariantAxis?: boolean;
  showInWarehouseForm?: boolean;
  showInOrderForm?: boolean;
  showInDocuments?: boolean;
  affectsAvailability?: boolean;
  sortOrder?: number;
}) {
  return prisma.warehouseFieldDefinition.update({
    where: { id },
    data: {
      ...(data.label !== undefined && { label: data.label.trim() }),
      ...(data.isRequired !== undefined && { isRequired: data.isRequired }),
      ...(data.isVariantAxis !== undefined && { isVariantAxis: data.isVariantAxis }),
      ...(data.showInWarehouseForm !== undefined && { showInWarehouseForm: data.showInWarehouseForm }),
      ...(data.showInOrderForm !== undefined && { showInOrderForm: data.showInOrderForm }),
      ...(data.showInDocuments !== undefined && { showInDocuments: data.showInDocuments }),
      ...(data.affectsAvailability !== undefined && { affectsAvailability: data.affectsAvailability }),
      ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
    },
    include: { options: true },
  });
}

export async function deleteFieldDefinition(id: string) {
  await prisma.warehouseFieldDefinition.delete({ where: { id } });
  return { ok: true };
}

// ── Field Options ──────────────────────────────────────────────────────────────

export async function addFieldOption(definitionId: string, data: {
  value: string;
  label: string;
  sortOrder?: number;
  colorHex?: string;
}) {
  const value = data.value.trim();
  const label = data.label.trim();
  return prisma.warehouseFieldOption.upsert({
    where: { definitionId_value: { definitionId, value } },
    create: { definitionId, value, label, sortOrder: data.sortOrder ?? 0, colorHex: data.colorHex },
    update: { label, isActive: true, colorHex: data.colorHex ?? undefined },
  });
}

export async function updateFieldOption(id: string, data: { label?: string; colorHex?: string }) {
  return prisma.warehouseFieldOption.update({
    where: { id },
    data: {
      ...(data.label !== undefined && { label: data.label.trim() }),
      ...(data.colorHex !== undefined && { colorHex: data.colorHex }),
    },
  });
}

export async function deleteFieldOption(id: string) {
  await prisma.warehouseFieldOption.delete({ where: { id } });
  return { ok: true };
}

export async function bulkAddFieldOptions(
  definitionId: string,
  values: Array<{ value: string; label: string; sortOrder?: number }>,
): Promise<{ created: number; skipped: number }> {
  let created = 0;
  let skipped = 0;
  for (const v of values) {
    const value = v.value.trim();
    const label = v.label.trim();
    if (!value) { skipped++; continue; }
    const existing = await prisma.warehouseFieldOption.findUnique({
      where: { definitionId_value: { definitionId, value } },
    });
    if (existing) { skipped++; continue; }
    await prisma.warehouseFieldOption.create({
      data: { definitionId, value, label, sortOrder: v.sortOrder ?? 0 },
    });
    created++;
  }
  return { created, skipped };
}

// ── Product Catalog ────────────────────────────────────────────────────────────

export async function getProductCatalog(orgId: string) {
  return prisma.warehouseProductCatalog.findMany({
    where: { orgId, isActive: true },
    include: {
      fieldLinks: {
        include: {
          definition: {
            include: {
              options: {
                where: { isActive: true },
                orderBy: { sortOrder: 'asc' },
              },
            },
          },
        },
        orderBy: { sortOrder: 'asc' },
      },
    },
    orderBy: { name: 'asc' },
  });
}

export async function createProduct(orgId: string, data: {
  name: string;
  source?: string;
}) {
  const name = data.name.trim();
  const normalizedName = normalizeName(name);
  return prisma.warehouseProductCatalog.upsert({
    where: { orgId_normalizedName: { orgId, normalizedName } },
    create: { orgId, name, normalizedName, source: data.source ?? 'manual' },
    update: { name, isActive: true },
  });
}

export async function updateProduct(id: string, data: { name: string }) {
  const name = data.name.trim();
  const normalizedName = normalizeName(name);
  return prisma.warehouseProductCatalog.update({
    where: { id },
    data: { name, normalizedName },
  });
}

export async function deleteProduct(id: string) {
  await prisma.warehouseProductCatalog.delete({ where: { id } });
  return { ok: true };
}

export async function setProductFields(
  productId: string,
  fields: Array<{ definitionId: string; isRequired?: boolean; sortOrder?: number }>,
) {
  // Replace all field links for this product
  await prisma.warehouseProductField.deleteMany({ where: { productId } });
  if (fields.length > 0) {
    await prisma.warehouseProductField.createMany({
      data: fields.map((f, i) => ({
        productId,
        definitionId: f.definitionId,
        isRequired: f.isRequired ?? false,
        sortOrder: f.sortOrder ?? i,
      })),
    });
  }
  return prisma.warehouseProductCatalog.findUnique({
    where: { id: productId },
    include: {
      fieldLinks: {
        include: { definition: { include: { options: true } } },
        orderBy: { sortOrder: 'asc' },
      },
    },
  });
}

// ── Order-Form Catalog (live dropdowns) ───────────────────────────────────────

export async function getOrderFormCatalog(orgId: string) {
  const products = await prisma.warehouseProductCatalog.findMany({
    where: { orgId, isActive: true },
    include: {
      fieldLinks: {
        include: {
          definition: {
            include: {
              options: {
                where: { isActive: true },
                orderBy: { sortOrder: 'asc' },
              },
            },
          },
        },
        orderBy: { sortOrder: 'asc' },
      },
    },
    orderBy: { name: 'asc' },
  });

  return {
    products: products.map((p) => ({
      id: p.id,
      name: p.name,
      fields: p.fieldLinks
        .filter((fl) => fl.definition.showInOrderForm)
        .map((fl) => ({
          code: fl.definition.code,
          label: fl.definition.label,
          inputType: fl.definition.inputType,
          isRequired: fl.isRequired || fl.definition.isRequired,
          affectsAvailability: fl.definition.affectsAvailability,
          options: fl.definition.options.map((o) => ({ value: o.value, label: o.label })),
        })),
    })),
  };
}

// ── Variant Availability ───────────────────────────────────────────────────────

export async function checkVariantAvailability(orgId: string, data: {
  productName: string;
  attributes: Record<string, string>;
}) {
  // First find the product catalog entry to get which fields affect availability
  const normalizedName = normalizeName(data.productName);
  const product = await prisma.warehouseProductCatalog.findFirst({
    where: { orgId, normalizedName },
    include: {
      fieldLinks: {
        include: { definition: true },
      },
    },
  });

  // Build variant key using only fields that affect availability
  let attributesForKey = data.attributes;
  if (product) {
    const availabilityFields = new Set(
      product.fieldLinks
        .filter((fl) => fl.definition.affectsAvailability)
        .map((fl) => fl.definition.code),
    );
    attributesForKey = Object.fromEntries(
      Object.entries(data.attributes).filter(([k]) => availabilityFields.has(k)),
    );
  }

  const variantKey = buildVariantKey(data.productName, attributesForKey);

  const item = await prisma.warehouseItem.findFirst({
    where: { orgId, variantKey },
    select: { id: true, qty: true, qtyReserved: true, qtyMin: true, name: true },
  });

  if (!item) {
    // Fallback: search by product name only (no variant match)
    const byName = await prisma.warehouseItem.findFirst({
      where: {
        orgId,
        name: { contains: data.productName.trim(), mode: 'insensitive' },
      },
      select: { qty: true, qtyReserved: true, qtyMin: true },
    });
    return {
      status: 'unknown' as const,
      variantKey,
      qty: byName ? byName.qty - byName.qtyReserved : null,
    };
  }

  const available = item.qty - item.qtyReserved;
  const status =
    available <= 0
      ? 'out_of_stock'
      : available <= item.qtyMin
        ? 'low'
        : 'in_stock';

  return { status, variantKey, qty: available, itemId: item.id };
}

// ── Seed default field definitions ────────────────────────────────────────────

export async function seedDefaultFieldDefinitions(orgId: string): Promise<{
  created: string[];
  skipped: string[];
}> {
  const defaults = [
    {
      code: 'size',
      label: 'Размер',
      inputType: 'select',
      isVariantAxis: true,
      affectsAvailability: true,
      sortOrder: 0,
      options: ['38','40','42','44','46','48','50','52','54','56','58','60','62','64','66','68','70','72','74','детский'],
    },
    {
      code: 'color',
      label: 'Цвет / Материал',
      inputType: 'select',
      isVariantAxis: true,
      affectsAvailability: true,
      sortOrder: 1,
      options: [] as string[],
    },
    {
      code: 'gender',
      label: 'Пол',
      inputType: 'select',
      isVariantAxis: true,
      affectsAvailability: false,
      sortOrder: 2,
      options: ['Мужской', 'Женский'],
    },
    {
      code: 'length',
      label: 'Длина изделия',
      inputType: 'select',
      isVariantAxis: true,
      affectsAvailability: true,
      sortOrder: 3,
      options: ['Длинный', 'Короткий', 'Стандарт'],
    },
  ];

  const created: string[] = [];
  const skipped: string[] = [];

  for (const def of defaults) {
    const existing = await prisma.warehouseFieldDefinition.findUnique({
      where: { orgId_code: { orgId, code: def.code } },
    });

    if (existing) {
      skipped.push(def.code);
      // Still seed missing options
      let optIdx = 0;
      for (const val of def.options) {
        await prisma.warehouseFieldOption.upsert({
          where: { definitionId_value: { definitionId: existing.id, value: val } },
          create: { definitionId: existing.id, value: val, label: val, sortOrder: optIdx },
          update: {},
        });
        optIdx++;
      }
      continue;
    }

    const newDef = await prisma.warehouseFieldDefinition.create({
      data: {
        orgId,
        code: def.code,
        label: def.label,
        inputType: def.inputType,
        isSystem: true,
        isVariantAxis: def.isVariantAxis,
        affectsAvailability: def.affectsAvailability,
        sortOrder: def.sortOrder,
      },
    });

    let optIdx2 = 0;
    for (const val of def.options) {
      await prisma.warehouseFieldOption.create({
        data: { definitionId: newDef.id, value: val, label: val, sortOrder: optIdx2 },
      });
      optIdx2++;
    }

    created.push(def.code);
  }

  return { created, skipped };
}

// ── Excel import ───────────────────────────────────────────────────────────────

// ── Smart import (one-click robot) ────────────────────────────────────────────

export async function smartImportProducts(
  orgId: string,
  rows: string[],
): Promise<{ fields: { created: string[]; skipped: string[] }; products: { created: number; skipped: number; errors: string[] } }> {
  // Step 1: seed all default fields automatically
  const fields = await seedDefaultFieldDefinitions(orgId);

  // Step 2: get all field definitions for this org (to link to products)
  const allDefs = await prisma.warehouseFieldDefinition.findMany({
    where: { orgId },
    select: { id: true, code: true, sortOrder: true },
    orderBy: { sortOrder: 'asc' },
  });

  // Step 3: import products in parallel batches (avoid N×M sequential queries on remote DB)
  const BATCH = 50;
  let created = 0;
  let skipped = 0;
  const errors: string[] = [];
  const productIds: string[] = [];

  const validRows = rows.map((r) => r.trim()).filter(Boolean);
  skipped += rows.length - validRows.length;

  for (let i = 0; i < validRows.length; i += BATCH) {
    const chunk = validRows.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      chunk.map((name) => {
        const normalizedName = normalizeName(name);
        return prisma.warehouseProductCatalog.upsert({
          where: { orgId_normalizedName: { orgId, normalizedName } },
          create: { orgId, name, normalizedName, source: 'excel_import' },
          update: { name, isActive: true },
          select: { id: true },
        });
      }),
    );
    for (const [j, r] of results.entries()) {
      if (r.status === 'fulfilled') {
        productIds.push(r.value.id);
        created++;
      } else {
        errors.push(`"${chunk[j] ?? ''}": ${(r.reason as any)?.message ?? 'unknown error'}`);
      }
    }
  }

  // Step 4: link all field definitions to every product in one batch query
  if (productIds.length > 0 && allDefs.length > 0) {
    const fieldLinks = productIds.flatMap((productId) =>
      allDefs.map((def, fieldIdx) => ({
        productId,
        definitionId: def.id,
        isRequired: false,
        sortOrder: fieldIdx,
      })),
    );
    await prisma.warehouseProductField.createMany({
      data: fieldLinks,
      skipDuplicates: true,
    });
  }

  return { fields, products: { created, skipped, errors } };
}

export async function smartImportColors(
  orgId: string,
  rows: string[],
): Promise<{ field: string; created: number; skipped: number; errors: string[] }> {
  // Ensure color field exists
  await seedDefaultFieldDefinitions(orgId);

  const result = await importFieldOptionsFromRows(orgId, 'color', rows);
  return { field: 'color', ...result };
}

export async function importProductsFromRows(
  orgId: string,
  rows: string[],
): Promise<{ created: number; skipped: number; errors: string[] }> {
  let created = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const raw of rows) {
    const name = raw.trim();
    if (!name) { skipped++; continue; }
    const normalizedName = normalizeName(name);
    try {
      await prisma.warehouseProductCatalog.upsert({
        where: { orgId_normalizedName: { orgId, normalizedName } },
        create: { orgId, name, normalizedName, source: 'excel_import' },
        update: { name, isActive: true },
      });
      created++;
    } catch (e: any) {
      errors.push(`"${name}": ${e?.message ?? 'unknown error'}`);
    }
  }

  return { created, skipped, errors };
}

export async function importFieldOptionsFromRows(
  orgId: string,
  definitionCode: string,
  rows: string[],
): Promise<{ created: number; skipped: number; errors: string[] }> {
  const definition = await prisma.warehouseFieldDefinition.findUnique({
    where: { orgId_code: { orgId, code: definitionCode } },
  });

  if (!definition) {
    throw new Error(`Поле с кодом "${definitionCode}" не найдено. Сначала создайте поле.`);
  }

  const values = rows.map((r) => r.trim()).filter(Boolean);
  const skipped = rows.length - values.length;

  // Fetch existing values in one query to count skips accurately
  const existing = await prisma.warehouseFieldOption.findMany({
    where: { definitionId: definition.id, value: { in: values } },
    select: { value: true },
  });
  const existingSet = new Set(existing.map((e) => e.value));

  const newValues = values.filter((v) => !existingSet.has(v));

  const result = await prisma.warehouseFieldOption.createMany({
    data: newValues.map((value, idx) => ({
      definitionId: definition.id,
      value,
      label: value,
      sortOrder: idx,
    })),
    skipDuplicates: true,
  });

  return {
    created: result.count,
    skipped: skipped + existingSet.size,
    errors: [],
  };
}
