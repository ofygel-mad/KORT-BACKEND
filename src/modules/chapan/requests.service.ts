import { prisma } from '../../lib/prisma.js';
import { NotFoundError } from '../../lib/errors.js';

async function nextRequestNumber(orgId: string): Promise<string> {
  const profile = await prisma.chapanProfile.findUnique({ where: { orgId } });
  const counter = (profile?.requestCounter ?? 0) + 1;

  await prisma.chapanProfile.update({
    where: { orgId },
    data: { requestCounter: counter },
  });

  return `RQ-${String(counter).padStart(3, '0')}`;
}

// ── List requests ───────────────────────────────────────

export async function list(orgId: string, statusFilter?: string) {
  const where: Record<string, unknown> = { orgId };
  if (statusFilter && statusFilter !== 'all') {
    where.status = statusFilter;
  }

  return prisma.chapanRequest.findMany({
    where,
    include: { items: true },
    orderBy: { createdAt: 'desc' },
  });
}

// ── Submit request (public or internal) ─────────────────

export async function submit(orgId: string, data: {
  customerName: string;
  phone: string;
  messengers?: string[];
  city?: string;
  deliveryMethod?: string;
  leadSource?: string;
  preferredContact: string;
  desiredDate?: string;
  notes?: string;
  source?: string;
  items: Array<{
    productName: string;
    size?: string;
    quantity: number;
    notes?: string;
  }>;
}) {
  const requestNumber = await nextRequestNumber(orgId);

  return prisma.chapanRequest.create({
    data: {
      orgId,
      requestNumber,
      customerName: data.customerName.trim(),
      phone: data.phone.trim(),
      messengers: data.messengers ?? [],
      city: data.city?.trim(),
      deliveryMethod: data.deliveryMethod?.trim(),
      leadSource: data.leadSource?.trim(),
      preferredContact: data.preferredContact,
      desiredDate: data.desiredDate ? new Date(data.desiredDate) : undefined,
      notes: data.notes?.trim(),
      source: data.source ?? 'public_form',
      items: {
        create: data.items.map((item) => ({
          productName: item.productName.trim(),
          size: item.size?.trim(),
          quantity: Math.max(1, item.quantity),
          notes: item.notes?.trim(),
        })),
      },
    },
    include: { items: true },
  });
}

// ── Update request status ───────────────────────────────

export async function updateStatus(orgId: string, id: string, status: string, createdOrderId?: string) {
  const request = await prisma.chapanRequest.findFirst({ where: { id, orgId } });
  if (!request) throw new NotFoundError('ChapanRequest', id);

  return prisma.chapanRequest.update({
    where: { id },
    data: {
      status,
      createdOrderId: createdOrderId ?? undefined,
    },
  });
}

// ── Get profile for public form ─────────────────────────

export async function getPublicProfile(orgId: string) {
  const profile = await prisma.chapanProfile.findUnique({ where: { orgId } });
  if (!profile || !profile.publicIntakeEnabled) return null;

  // Also fetch catalogs for the form
  const [products, sizes] = await Promise.all([
    prisma.chapanCatalogProduct.findMany({ where: { orgId }, select: { name: true } }),
    prisma.chapanCatalogSize.findMany({ where: { orgId }, select: { name: true } }),
  ]);

  return {
    displayName: profile.displayName,
    publicIntakeTitle: profile.publicIntakeTitle,
    publicIntakeDescription: profile.publicIntakeDescription,
    supportLabel: profile.supportLabel,
    catalogs: {
      products: products.map((p) => p.name),
      sizes: sizes.map((s) => s.name),
    },
  };
}
