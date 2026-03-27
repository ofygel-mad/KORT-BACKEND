import { prisma } from '../../lib/prisma.js';
import type { Prisma } from '@prisma/client';

export function toGoogleSheetsSerial(date: Date): number {
  const excelEpoch = Date.UTC(1899, 11, 30);
  const localMidnight = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.floor((localMidnight - excelEpoch) / 86_400_000);
}

export async function getNextInvoiceNumberCandidate(
  db: Prisma.TransactionClient | typeof prisma,
  orgId: string,
  createdAt: Date,
): Promise<string> {
  const dateSerial = toGoogleSheetsSerial(createdAt);
  const prefix = `${dateSerial}-`;
  const existing = await db.chapanInvoice.findMany({
    where: {
      orgId,
      invoiceNumber: { startsWith: prefix },
    },
    select: { invoiceNumber: true },
  });

  const lastSequence = existing.reduce((max, invoice) => {
    const suffix = Number(invoice.invoiceNumber.slice(prefix.length));
    if (!Number.isInteger(suffix)) {
      return max;
    }
    return Math.max(max, suffix);
  }, 0);

  return `${prefix}${lastSequence + 1}`;
}
