import { prisma } from '../../lib/prisma.js';
import { NotFoundError } from '../../lib/errors.js';

// ── Profile ─────────────────────────────────────────────

export async function getProfile(orgId: string) {
  const profile = await prisma.chapanProfile.findUnique({ where: { orgId } });
  if (!profile) throw new NotFoundError('ChapanProfile');

  return {
    displayName: profile.displayName,
    descriptor: profile.descriptor,
    orderPrefix: profile.orderPrefix,
    publicIntakeTitle: profile.publicIntakeTitle,
    publicIntakeDescription: profile.publicIntakeDescription,
    publicIntakeEnabled: profile.publicIntakeEnabled,
    supportLabel: profile.supportLabel,
    kazpostDeliveryFee: profile.kazpostDeliveryFee,
    railDeliveryFee: profile.railDeliveryFee,
    airDeliveryFee: profile.airDeliveryFee,
    bankCommissionPercent: profile.bankCommissionPercent,
  };
}

export async function updateProfile(orgId: string, data: Record<string, unknown>) {
  const profile = await prisma.chapanProfile.upsert({
    where: { orgId },
    create: {
      orgId,
      displayName: data.displayName as string | undefined,
      descriptor: data.descriptor as string | undefined,
      orderPrefix: data.orderPrefix as string | undefined,
      publicIntakeTitle: data.publicIntakeTitle as string | undefined,
      publicIntakeDescription: data.publicIntakeDescription as string | undefined,
      publicIntakeEnabled: data.publicIntakeEnabled as boolean | undefined,
      supportLabel: data.supportLabel as string | undefined,
      kazpostDeliveryFee: data.kazpostDeliveryFee as number | undefined,
      railDeliveryFee: data.railDeliveryFee as number | undefined,
      airDeliveryFee: data.airDeliveryFee as number | undefined,
    },
    update: {
      displayName: data.displayName as string | undefined,
      descriptor: data.descriptor as string | undefined,
      orderPrefix: data.orderPrefix as string | undefined,
      publicIntakeTitle: data.publicIntakeTitle as string | undefined,
      publicIntakeDescription: data.publicIntakeDescription as string | undefined,
      publicIntakeEnabled: data.publicIntakeEnabled as boolean | undefined,
      supportLabel: data.supportLabel as string | undefined,
      kazpostDeliveryFee: data.kazpostDeliveryFee as number | undefined,
      railDeliveryFee: data.railDeliveryFee as number | undefined,
      airDeliveryFee: data.airDeliveryFee as number | undefined,
    },
  });

  return {
    displayName: profile.displayName,
    descriptor: profile.descriptor,
    orderPrefix: profile.orderPrefix,
    publicIntakeTitle: profile.publicIntakeTitle,
    publicIntakeDescription: profile.publicIntakeDescription,
    publicIntakeEnabled: profile.publicIntakeEnabled,
    supportLabel: profile.supportLabel,
    kazpostDeliveryFee: profile.kazpostDeliveryFee,
    railDeliveryFee: profile.railDeliveryFee,
    airDeliveryFee: profile.airDeliveryFee,
    bankCommissionPercent: profile.bankCommissionPercent,
  };
}

export async function updateBankCommission(orgId: string, percent: number) {
  const profile = await prisma.chapanProfile.upsert({
    where: { orgId },
    create: { orgId, bankCommissionPercent: percent },
    update: { bankCommissionPercent: percent },
  });
  return { bankCommissionPercent: profile.bankCommissionPercent };
}

// ── Catalogs ────────────────────────────────────────────

// ── Size sort helpers ──────────────────────────────────
const LETTER_SORT_ORDER: Record<string, number> = {
  'XS': 142, 'xs': 142,
  'S': 144,  's': 144,
  'M': 146,  'm': 146,
  'L': 148,  'l': 148,
  'XL': 150, 'xl': 150,
  'XXL': 152, 'xxl': 152, '2XL': 152, '2xl': 152,
  'XXXL': 154, 'xxxl': 154, '3XL': 154, '3xl': 154,
};

function sizeToSortOrder(name: string): number {
  const n = parseInt(name, 10);
  if (!isNaN(n) && String(n) === name.trim()) return n; // pure numeric: 38, 40...
  return LETTER_SORT_ORDER[name.trim()] ?? 999;
}

export async function getCatalogs(orgId: string) {
  const [products, fabrics, sizes, workers, paymentMethods] = await Promise.all([
    prisma.chapanCatalogProduct.findMany({ where: { orgId }, select: { name: true } }),
    prisma.chapanCatalogFabric.findMany({ where: { orgId }, select: { name: true } }),
    prisma.chapanCatalogSize.findMany({ where: { orgId }, select: { name: true, sortOrder: true }, orderBy: { sortOrder: 'asc' } }),
    prisma.chapanWorker.findMany({ where: { orgId }, select: { name: true } }),
    prisma.chapanCatalogPaymentMethod.findMany({ where: { orgId }, select: { name: true }, orderBy: { name: 'asc' } }),
  ]);

  return {
    productCatalog: products.map((p) => p.name),
    fabricCatalog: fabrics.map((f) => f.name),
    sizeCatalog: sizes.map((s) => s.name), // already sorted by sortOrder asc
    workers: workers.map((w) => w.name),
    paymentMethodCatalog: paymentMethods.map((m) => m.name),
  };
}

export async function saveCatalogs(orgId: string, data: {
  productCatalog?: string[];
  fabricCatalog?: string[];
  sizeCatalog?: string[];
  workers?: string[];
  paymentMethodCatalog?: string[];
}) {
  await prisma.$transaction(async (tx) => {
    if (data.productCatalog) {
      await tx.chapanCatalogProduct.deleteMany({ where: { orgId } });
      const unique = [...new Set(data.productCatalog.map((n) => n.trim()).filter(Boolean))];
      if (unique.length > 0) {
        await tx.chapanCatalogProduct.createMany({
          data: unique.map((name) => ({ orgId, name })),
        });
      }
    }

    if (data.fabricCatalog) {
      await tx.chapanCatalogFabric.deleteMany({ where: { orgId } });
      const unique = [...new Set(data.fabricCatalog.map((n) => n.trim()).filter(Boolean))];
      if (unique.length > 0) {
        await tx.chapanCatalogFabric.createMany({
          data: unique.map((name) => ({ orgId, name })),
        });
      }
    }

    if (data.sizeCatalog) {
      await tx.chapanCatalogSize.deleteMany({ where: { orgId } });
      const unique = [...new Set(data.sizeCatalog.map((n) => n.trim()).filter(Boolean))];
      if (unique.length > 0) {
        await tx.chapanCatalogSize.createMany({
          data: unique.map((name) => ({ orgId, name, sortOrder: sizeToSortOrder(name) })),
        });
      }
    }

    if (data.workers) {
      await tx.chapanWorker.deleteMany({ where: { orgId } });
      const unique = [...new Set(data.workers.map((n) => n.trim()).filter(Boolean))];
      if (unique.length > 0) {
        await tx.chapanWorker.createMany({
          data: unique.map((name) => ({ orgId, name })),
        });
      }
    }

    if (data.paymentMethodCatalog) {
      await tx.chapanCatalogPaymentMethod.deleteMany({ where: { orgId } });
      const unique = [...new Set(data.paymentMethodCatalog.map((n) => n.trim()).filter(Boolean))];
      if (unique.length > 0) {
        await tx.chapanCatalogPaymentMethod.createMany({
          data: unique.map((name) => ({ orgId, name })),
        });
      }
    }
  });
}

// ── Clients ─────────────────────────────────────────────

export async function getClients(orgId: string) {
  return prisma.chapanClient.findMany({
    where: { orgId },
    orderBy: { createdAt: 'desc' },
  });
}

export async function createClient(orgId: string, data: {
  fullName: string;
  phone: string;
  email?: string;
  company?: string;
  notes?: string;
}) {
  return prisma.chapanClient.create({
    data: {
      orgId,
      fullName: data.fullName,
      phone: data.phone,
      email: data.email,
      company: data.company,
      notes: data.notes,
    },
  });
}
