import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import ExcelJS from 'exceljs';
import * as svc from './warehouse-catalog.service.js';

async function loadRows(buffer: Uint8Array): Promise<string[]> {
  const wb = new ExcelJS.Workbook();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await wb.xlsx.load(Buffer.from(buffer) as any);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  return extractColumnValues(ws);
}

function extractColumnValues(ws: ExcelJS.Worksheet): string[] {
  const rows: string[] = [];
  ws.eachRow((row, rowNum) => {
    if (rowNum === 1) return;
    // Try column 2 first (most xlsx have index col + data col), then column 1
    const c2 = String(row.getCell(2).value ?? '').trim();
    const c1 = String(row.getCell(1).value ?? '').trim();
    const val = c2 || c1;
    if (val && val !== '0' && !/^(название|цвет|товар)/i.test(val)) rows.push(val);
  });
  return rows;
}

export async function warehouseCatalogRoutes(app: FastifyInstance) {
  const auth = { preHandler: [app.authenticate, app.resolveOrg] };

  // ── Field Definitions ──────────────────────────────────────────────────────

  app.get('/catalog/definitions', auth, async (req) => {
    return svc.getFieldDefinitions(req.orgId);
  });

  app.post('/catalog/definitions', auth, async (req) => {
    const body = z.object({
      code:                 z.string().min(1),
      label:                z.string().min(1),
      inputType:            z.enum(['select', 'multiselect', 'text', 'number', 'boolean']),
      entityScope:          z.enum(['warehouse_item', 'order_item', 'both']).optional(),
      isRequired:           z.boolean().optional(),
      isVariantAxis:        z.boolean().optional(),
      showInWarehouseForm:  z.boolean().optional(),
      showInOrderForm:      z.boolean().optional(),
      showInDocuments:      z.boolean().optional(),
      affectsAvailability:  z.boolean().optional(),
      sortOrder:            z.number().int().optional(),
    }).parse(req.body);
    return svc.createFieldDefinition(req.orgId, body);
  });

  app.patch('/catalog/definitions/:id', auth, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z.object({
      label:                z.string().min(1).optional(),
      isRequired:           z.boolean().optional(),
      isVariantAxis:        z.boolean().optional(),
      showInWarehouseForm:  z.boolean().optional(),
      showInOrderForm:      z.boolean().optional(),
      showInDocuments:      z.boolean().optional(),
      affectsAvailability:  z.boolean().optional(),
      sortOrder:            z.number().int().optional(),
    }).parse(req.body);
    return svc.updateFieldDefinition(id, body);
  });

  app.delete('/catalog/definitions/:id', auth, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    return svc.deleteFieldDefinition(id);
  });

  // ── Field Options ──────────────────────────────────────────────────────────

  app.post('/catalog/definitions/:id/options', auth, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z.object({
      value:    z.string().min(1),
      label:    z.string().min(1),
      sortOrder: z.number().int().optional(),
      colorHex:  z.string().optional(),
    }).parse(req.body);
    return svc.addFieldOption(id, body);
  });

  app.patch('/catalog/definitions/:defId/options/:optId', auth, async (req) => {
    const { optId } = z.object({ defId: z.string(), optId: z.string() }).parse(req.params);
    const body = z.object({
      label:    z.string().min(1).optional(),
      colorHex: z.string().optional(),
    }).parse(req.body);
    return svc.updateFieldOption(optId, body);
  });

  app.delete('/catalog/definitions/:defId/options/:optId', auth, async (req) => {
    const { optId } = z.object({ defId: z.string(), optId: z.string() }).parse(req.params);
    return svc.deleteFieldOption(optId);
  });

  // ── Product Catalog ────────────────────────────────────────────────────────

  app.get('/catalog/products', auth, async (req) => {
    return svc.getProductCatalog(req.orgId);
  });

  app.post('/catalog/products', auth, async (req) => {
    const body = z.object({
      name:   z.string().min(1),
      source: z.string().optional(),
    }).parse(req.body);
    return svc.createProduct(req.orgId, body);
  });

  app.patch('/catalog/products/:id', auth, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z.object({ name: z.string().min(1) }).parse(req.body);
    return svc.updateProduct(id, body);
  });

  app.delete('/catalog/products/:id', auth, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    return svc.deleteProduct(id);
  });

  app.put('/catalog/products/:id/fields', auth, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z.object({
      fields: z.array(z.object({
        definitionId: z.string(),
        isRequired:   z.boolean().optional(),
        sortOrder:    z.number().int().optional(),
      })),
    }).parse(req.body);
    return svc.setProductFields(id, body.fields);
  });

  // ── Seed defaults ──────────────────────────────────────────────────────────

  app.post('/catalog/seed-defaults', auth, async (req) => {
    return svc.seedDefaultFieldDefinitions(req.orgId);
  });

  // ── Order Form Catalog (live dropdowns) ────────────────────────────────────

  app.get('/order-form/catalog', auth, async (req) => {
    return svc.getOrderFormCatalog(req.orgId);
  });

  // ── Variant Availability ───────────────────────────────────────────────────

  app.post('/availability/check-variant', auth, async (req) => {
    const body = z.object({
      productName: z.string().min(1),
      attributes:  z.record(z.string(), z.string()),
    }).parse(req.body);
    return svc.checkVariantAvailability(req.orgId, body);
  });

  // ── Smart import (one-click robot) ────────────────────────────────────────

  app.post('/catalog/smart-import/products', auth, async (req) => {
    const data = await req.file();
    if (!data) throw app.httpErrors.badRequest('Файл не найден');
    const rows = await loadRows(await data.toBuffer());
    return svc.smartImportProducts(req.orgId, rows);
  });

  app.post('/catalog/smart-import/colors', auth, async (req) => {
    const data = await req.file();
    if (!data) throw app.httpErrors.badRequest('Файл не найден');
    const rows = await loadRows(await data.toBuffer());
    return svc.smartImportColors(req.orgId, rows);
  });

  // ── Excel import — products (raw, for advanced use) ────────────────────────

  app.post('/catalog/import/products', auth, async (req) => {
    const data = await req.file();
    if (!data) throw app.httpErrors.badRequest('Файл не найден');
    const rows = await loadRows(await data.toBuffer());
    return svc.importProductsFromRows(req.orgId, rows);
  });

  // ── Excel import — field options ───────────────────────────────────────────

  app.post('/catalog/import/field-options/:code', auth, async (req) => {
    const { code } = z.object({ code: z.string().min(1) }).parse(req.params);
    const data = await req.file();
    if (!data) throw app.httpErrors.badRequest('Файл не найден');
    const rows = await loadRows(await data.toBuffer());
    return svc.importFieldOptionsFromRows(req.orgId, code, rows);
  });

  // ── Bulk add field options from JSON (manual input) ────────────────────────

  app.post('/catalog/definitions/:id/options/bulk', auth, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z.object({
      values: z.array(z.object({
        value:     z.string().min(1),
        label:     z.string().min(1),
        sortOrder: z.number().int().optional(),
      })).min(1),
    }).parse(req.body);
    return svc.bulkAddFieldOptions(id, body.values);
  });
}
