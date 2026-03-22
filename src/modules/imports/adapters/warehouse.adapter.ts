/**
 * adapters/warehouse.adapter.ts
 *
 * Imports warehouse items (positions) and/or stock levels.
 * Supports targets: 'warehouse_items', 'warehouse_stock', 'catalog'
 */

import { prisma } from '../../../lib/prisma.js';

function parseNum(v: unknown): number {
  if (typeof v === 'number') return v;
  if (!v) return 0;
  return parseFloat(String(v).replace(/[^\d.,\-]/g, '').replace(',', '.')) || 0;
}

export interface WarehouseItemRow {
  name?: string;
  sku?: string;
  unit?: string;
  qty?: number | string;
  cost_price?: number | string;
  category?: string;
  location?: string;
  notes?: string;
}

export interface CatalogRow {
  name?: string;
  category?: string;
  fabric?: string;
  size_range?: string;
  colors?: string;
  unit_price?: number | string;
  notes?: string;
}

export interface AdapterResult {
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
}

// ─────────────────────────────────────────────────────────────
//  Import warehouse items (positions)
// ─────────────────────────────────────────────────────────────

export async function importWarehouseItems(
  orgId: string,
  rows: WarehouseItemRow[],
): Promise<AdapterResult> {
  const result: AdapterResult = { created: 0, updated: 0, skipped: 0, errors: [] };

  for (const row of rows) {
    const name = row.name?.trim();
    if (!name) { result.skipped++; continue; }

    try {
      // Find/create category
      let categoryId: string | undefined;
      if (row.category?.trim()) {
        const cat = await prisma.warehouseCategory.upsert({
          where: { orgId_name: { orgId, name: row.category.trim() } },
          update: {},
          create: { orgId, name: row.category.trim(), color: '#888888' },
        });
        categoryId = cat.id;
      }

      // Find/create location
      let locationId: string | undefined;
      if (row.location?.trim()) {
        const loc = await prisma.warehouseLocation.upsert({
          where: { orgId_name: { orgId, name: row.location.trim() } },
          update: {},
          create: { orgId, name: row.location.trim() },
        });
        locationId = loc.id;
      }

      // Upsert item by name
      const existing = await prisma.warehouseItem.findFirst({
        where: { orgId, name },
      });

      const qty = parseNum(row.qty);
      const costPrice = parseNum(row.cost_price) || undefined;

      if (existing) {
        await prisma.warehouseItem.update({
          where: { id: existing.id },
          data: {
            qty: { increment: qty },
            ...(costPrice ? { costPrice } : {}),
            ...(categoryId ? { categoryId } : {}),
            ...(locationId ? { locationId } : {}),
            ...(row.sku?.trim() ? { sku: row.sku.trim() } : {}),
            ...(row.unit?.trim() ? { unit: row.unit.trim() } : {}),
            ...(row.notes?.trim() ? { notes: row.notes.trim() } : {}),
          },
        });
        result.updated++;
      } else {
        await prisma.warehouseItem.create({
          data: {
            orgId,
            name,
            sku: row.sku?.trim() || undefined,
            unit: row.unit?.trim() || 'шт',
            qty,
            costPrice,
            categoryId,
            locationId,
            notes: row.notes?.trim() || undefined,
          },
        });
        result.created++;
      }
    } catch (err) {
      result.errors.push(`${name}: ${(err as Error).message}`);
    }
  }

  return result;
}

// ─────────────────────────────────────────────────────────────
//  Import catalog (creates warehouse items + chapan catalog entries)
// ─────────────────────────────────────────────────────────────

export async function importCatalog(
  orgId: string,
  rows: CatalogRow[],
): Promise<AdapterResult> {
  const result: AdapterResult = { created: 0, updated: 0, skipped: 0, errors: [] };

  for (const row of rows) {
    const name = row.name?.trim();
    if (!name) { result.skipped++; continue; }

    try {
      // Upsert ChapanCatalogProduct
      await prisma.chapanCatalogProduct.upsert({
        where: { orgId_name: { orgId, name } },
        update: {},
        create: { orgId, name },
      });

      // If fabric is known, upsert ChapanCatalogFabric
      if (row.fabric?.trim()) {
        await prisma.chapanCatalogFabric.upsert({
          where: { orgId_name: { orgId, name: row.fabric.trim() } },
          update: {},
          create: { orgId, name: row.fabric.trim() },
        });
      }

      // Build size entries
      if (row.size_range?.trim()) {
        // e.g. "42-58" → individual sizes or store as-is
        const sizeStr = row.size_range.trim();
        await prisma.chapanCatalogSize.upsert({
          where: { orgId_name: { orgId, name: sizeStr } },
          update: {},
          create: { orgId, name: sizeStr },
        });
      }

      // Create warehouse item for the catalog product
      const unitPrice = parseNum(row.unit_price) || undefined;
      const tags: string[] = [];
      if (row.fabric) tags.push(row.fabric.trim());
      if (row.category) tags.push(row.category.trim());
      if (row.colors) tags.push(...row.colors.split(',').map((c) => c.trim()).filter(Boolean));

      const existing = await prisma.warehouseItem.findFirst({ where: { orgId, name } });
      if (!existing) {
        // Find/create "Готовые изделия" category
        const cat = await prisma.warehouseCategory.upsert({
          where: { orgId_name: { orgId, name: row.category?.trim() ?? 'Готовые изделия' } },
          update: {},
          create: { orgId, name: row.category?.trim() ?? 'Готовые изделия', color: '#6366f1' },
        });

        await prisma.warehouseItem.create({
          data: {
            orgId,
            name,
            unit: 'шт',
            qty: 0,
            costPrice: unitPrice,
            categoryId: cat.id,
            tags,
            notes: [row.fabric, row.size_range, row.notes].filter(Boolean).join(' | ') || undefined,
          },
        });
        result.created++;
      } else {
        result.updated++;
      }
    } catch (err) {
      result.errors.push(`${name}: ${(err as Error).message}`);
    }
  }

  return result;
}
