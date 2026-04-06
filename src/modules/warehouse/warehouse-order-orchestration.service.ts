import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { ValidationError } from '../../lib/errors.js';
import {
  postWarehouseOperationDocument,
  type PostWarehouseOperationDocumentInput,
} from './warehouse-operations.service.js';

type CanonicalConsumptionSummary = {
  mode: 'canonical' | 'skipped';
  reason?: string;
  consumedCount: number;
  replayedCount: number;
  failedCount: number;
  skippedCount: number;
  items: Array<{ itemId: string; status: string; reason?: string }>;
};

function buildCanonicalConsumptionActivityContent(summary: CanonicalConsumptionSummary) {
  const details = summary.items
    .filter((item) => item.status === 'failed' || item.status === 'skipped')
    .slice(0, 3)
    .map((item) => `${item.itemId}: ${item.reason ?? item.status}`)
    .join('; ');

  if (summary.mode === 'skipped') {
    return `Canonical warehouse consume skipped: ${summary.reason ?? 'unknown_reason'}.`;
  }

  return `Canonical warehouse consume: consumed ${summary.consumedCount}, replayed ${summary.replayedCount}, skipped ${summary.skippedCount}, failed ${summary.failedCount}${details ? `. Details: ${details}` : ''}`;
}

export async function consumeCanonicalWarehouseReservationsForOrder(
  orgId: string,
  orderId: string,
  authorId: string,
  authorName: string,
) {
  try {
    const { consumeOrderWarehouseReservations } = await import('./warehouse.service.js');
    const summary = await consumeOrderWarehouseReservations(orgId, orderId, authorName || 'system');

    await prisma.chapanActivity.create({
      data: {
        orderId,
        type: 'system',
        content: buildCanonicalConsumptionActivityContent(summary),
        authorId,
        authorName,
      },
    });

    if (summary.mode === 'canonical' && summary.failedCount > 0) {
      throw new ValidationError('Failed to fully consume canonical warehouse reservations for order');
    }

    return summary;
  } catch (error) {
    if (error instanceof ValidationError) {
      throw error;
    }

    await prisma.chapanActivity.create({
      data: {
        orderId,
        type: 'system',
        content: 'Canonical warehouse consume was not completed because of an integration error.',
        authorId,
        authorName,
      },
    });

    throw new ValidationError('Failed to execute canonical warehouse consume');
  }
}

async function consumeCanonicalWarehouseReservationsForOrderTx(
  tx: Prisma.TransactionClient,
  orgId: string,
  orderId: string,
  authorId: string,
  authorName: string,
) {
  const { consumeOrderWarehouseReservationsTx } = await import('./warehouse.service.js');
  const summary = await consumeOrderWarehouseReservationsTx(tx, orgId, orderId, authorName || 'system');

  await tx.chapanActivity.create({
    data: {
      orderId,
      type: 'system',
      content: buildCanonicalConsumptionActivityContent(summary),
      authorId,
      authorName,
    },
  });

  if (summary.mode === 'canonical' && summary.failedCount > 0) {
    throw new ValidationError('Failed to fully consume canonical warehouse reservations for order');
  }

  return summary;
}

async function releaseCanonicalWarehouseReservationsForOrderTx(
  tx: Prisma.TransactionClient,
  orgId: string,
  orderId: string,
  authorId: string,
  authorName: string,
) {
  const { releaseOrderReservationsTx } = await import('./warehouse.service.js');
  const summary = await releaseOrderReservationsTx(tx, orgId, orderId, authorName || 'system');

  if (summary.releasedCanonicalCount > 0 || summary.releasedCompatibilityCount > 0) {
    await tx.chapanActivity.create({
      data: {
        orderId,
        type: 'system',
        content:
          `Canonical warehouse reservation release: canonical ${summary.releasedCanonicalCount}, compatibility ${summary.releasedCompatibilityCount}.`,
        authorId,
        authorName,
      },
    });
  }

  return summary;
}

export async function applyWarehouseOrderTransitionSideEffectsTx(
  tx: Prisma.TransactionClient,
  orgId: string,
  input: {
    orderId: string;
    fromStatus: string;
    toStatus: string;
    hasWarehouseItems: boolean;
    authorId: string;
    authorName: string;
    consumeReservations?: boolean;
    releaseReservations?: boolean;
    operationDocument?: Pick<PostWarehouseOperationDocumentInput, 'documentType' | 'idempotencyKey' | 'payload'>;
  },
) {
  if (input.consumeReservations && input.hasWarehouseItems) {
    await consumeCanonicalWarehouseReservationsForOrderTx(
      tx,
      orgId,
      input.orderId,
      input.authorId,
      input.authorName,
    );
  }

  if (input.releaseReservations) {
    await releaseCanonicalWarehouseReservationsForOrderTx(
      tx,
      orgId,
      input.orderId,
      input.authorId,
      input.authorName,
    );
  }

  if (input.operationDocument && input.hasWarehouseItems) {
    await postWarehouseOperationDocument(orgId, {
      orderId: input.orderId,
      documentType: input.operationDocument.documentType,
      idempotencyKey: input.operationDocument.idempotencyKey,
      payload: input.operationDocument.payload,
      createdBy: input.authorName,
    }, tx);
  }
}
