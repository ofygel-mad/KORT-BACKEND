import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { processWarehouseOutboxRecord } from './warehouse-projections.service.js';

function nextRetryAt(retryCount: number) {
  const delayMs = Math.min(5_000 * (2 ** Math.min(retryCount, 4)), 60_000);
  return new Date(Date.now() + delayMs);
}

export function startWarehouseOutboxWorker(log: FastifyBaseLogger) {
  let isRunning = false;
  const intervalMs = 4_000;

  const tick = async () => {
    if (isRunning) {
      return;
    }

    isRunning = true;

    try {
      const pending = await prisma.warehouseOutbox.findMany({
        where: {
          status: 'pending',
          availableAt: { lte: new Date() },
        },
        orderBy: [{ availableAt: 'asc' }, { createdAt: 'asc' }],
        take: 20,
        select: { id: true },
      });

      for (const candidate of pending) {
        const claimed = await prisma.warehouseOutbox.updateMany({
          where: {
            id: candidate.id,
            status: 'pending',
          },
          data: {
            status: 'processing',
          },
        });

        if (claimed.count === 0) {
          continue;
        }

        try {
          await processWarehouseOutboxRecord(candidate.id);
        } catch (error) {
          const current = await prisma.warehouseOutbox.findUnique({
            where: { id: candidate.id },
            select: { retryCount: true },
          });
          const nextRetryCount = (current?.retryCount ?? 0) + 1;

          await prisma.warehouseOutbox.update({
            where: { id: candidate.id },
            data: {
              status: 'pending',
              retryCount: { increment: 1 },
              availableAt: nextRetryAt(nextRetryCount),
              processedAt: null,
              lastError: error instanceof Error ? error.message.slice(0, 1_000) : 'warehouse_outbox_processing_failed',
            },
          });

          log.error(
            {
              outboxRecordId: candidate.id,
              error,
            },
            'Warehouse outbox record processing failed',
          );
        }
      }
    } catch (error) {
      log.error({ error }, 'Warehouse outbox worker tick failed');
    } finally {
      isRunning = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);

  void tick();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
