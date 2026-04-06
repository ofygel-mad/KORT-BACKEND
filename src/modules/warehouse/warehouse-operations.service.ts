import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';

type Tx = Prisma.TransactionClient | PrismaClient;

export interface PostWarehouseOperationDocumentInput {
  orderId?: string | null;
  warehouseSiteId?: string | null;
  documentType: 'handoff_to_warehouse' | 'shipment';
  idempotencyKey: string;
  referenceNo?: string | null;
  payload?: Record<string, unknown> | null;
  createdBy?: string | null;
}

async function createOutboxRecord(tx: Tx, input: {
  orgId: string;
  warehouseSiteId?: string | null;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
}) {
  await tx.warehouseOutbox.create({
    data: {
      orgId: input.orgId,
      warehouseSiteId: input.warehouseSiteId ?? null,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      eventType: input.eventType,
      payload: input.payload as Prisma.InputJsonValue,
    },
  });
}

async function getSingleActiveWarehouseSite(db: Tx, orgId: string) {
  const sites = await db.warehouseSite.findMany({
    where: { orgId, status: 'active' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, code: true, name: true },
    take: 2,
  });

  if (sites.length !== 1) {
    return null;
  }

  return sites[0];
}

export async function resolveWarehouseSiteForOrder(db: Tx, orgId: string, orderId?: string | null) {
  if (!orderId) {
    return getSingleActiveWarehouseSite(db, orgId);
  }

  const reservationSite = await db.warehouseStockReservation.findFirst({
    where: {
      orgId,
      sourceType: 'chapan_order_item',
      sourceId: orderId,
    },
    select: {
      warehouseSiteId: true,
      site: {
        select: {
          id: true,
          code: true,
          name: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  if (reservationSite?.site) {
    return reservationSite.site;
  }

  const documentSite = await db.warehouseOperationDocument.findFirst({
    where: {
      orgId,
      orderId,
      warehouseSiteId: { not: null },
    },
    select: {
      site: {
        select: {
          id: true,
          code: true,
          name: true,
        },
      },
    },
    orderBy: { postedAt: 'desc' },
  });

  if (documentSite?.site) {
    return documentSite.site;
  }

  return getSingleActiveWarehouseSite(db, orgId);
}

async function postWarehouseOperationDocumentTx(
  tx: Tx,
  orgId: string,
  input: PostWarehouseOperationDocumentInput,
) {
  const existing = await tx.warehouseOperationDocument.findFirst({
    where: { orgId, idempotencyKey: input.idempotencyKey },
  });

  if (existing) {
    return {
      replayed: true,
      document: existing,
    };
  }

  let resolvedSiteId = input.warehouseSiteId ?? null;
  if (resolvedSiteId) {
    const site = await tx.warehouseSite.findFirst({
      where: { id: resolvedSiteId, orgId },
      select: { id: true },
    });
    if (!site) {
      throw new AppError(404, 'Склад для документа не найден', 'NOT_FOUND');
    }
  } else {
    const fallbackSite = await resolveWarehouseSiteForOrder(tx, orgId, input.orderId);
    resolvedSiteId = fallbackSite?.id ?? null;
  }

  const document = await tx.warehouseOperationDocument.create({
    data: {
      orgId,
      warehouseSiteId: resolvedSiteId,
      orderId: input.orderId ?? null,
      documentType: input.documentType,
      status: 'posted',
      idempotencyKey: input.idempotencyKey,
      referenceNo: input.referenceNo ?? null,
      payload:
        input.payload === null
          ? Prisma.JsonNull
          : input.payload === undefined
            ? undefined
            : (input.payload as Prisma.InputJsonValue),
      createdBy: input.createdBy?.trim() || 'system',
    },
  });

  await createOutboxRecord(tx, {
    orgId,
    warehouseSiteId: resolvedSiteId,
    aggregateType: 'warehouse.document',
    aggregateId: document.id,
    eventType: 'warehouse.document.posted',
    payload: {
      documentId: document.id,
      documentType: input.documentType,
      orderId: input.orderId ?? null,
      warehouseSiteId: resolvedSiteId,
      referenceNo: input.referenceNo ?? null,
    },
  });

  return {
    replayed: false,
    document,
  };
}

export async function postWarehouseOperationDocument(
  orgId: string,
  input: PostWarehouseOperationDocumentInput,
  tx?: Tx,
) {
  if (tx) {
    return postWarehouseOperationDocumentTx(tx, orgId, input);
  }

  return prisma.$transaction((innerTx) => postWarehouseOperationDocumentTx(innerTx, orgId, input));
}
