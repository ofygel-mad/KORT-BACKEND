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
    },
    update: {
      displayName: data.displayName as string | undefined,
      descriptor: data.descriptor as string | undefined,
      orderPrefix: data.orderPrefix as string | undefined,
      publicIntakeTitle: data.publicIntakeTitle as string | undefined,
      publicIntakeDescription: data.publicIntakeDescription as string | undefined,
      publicIntakeEnabled: data.publicIntakeEnabled as boolean | undefined,
      supportLabel: data.supportLabel as string | undefined,
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
  };
}

// ── Catalogs ────────────────────────────────────────────

export async function getCatalogs(orgId: string) {
  const [products, fabrics, sizes, workers] = await Promise.all([
    prisma.chapanCatalogProduct.findMany({ where: { orgId }, select: { name: true } }),
    prisma.chapanCatalogFabric.findMany({ where: { orgId }, select: { name: true } }),
    prisma.chapanCatalogSize.findMany({ where: { orgId }, select: { name: true } }),
    prisma.chapanWorker.findMany({ where: { orgId }, select: { name: true } }),
  ]);

  return {
    productCatalog: products.map((p) => p.name),
    fabricCatalog: fabrics.map((f) => f.name),
    sizeCatalog: sizes.map((s) => s.name),
    workers: workers.map((w) => w.name),
  };
}

export async function saveCatalogs(orgId: string, data: {
  productCatalog?: string[];
  fabricCatalog?: string[];
  sizeCatalog?: string[];
  workers?: string[];
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
          data: unique.map((name) => ({ orgId, name })),
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
