import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { Prisma } from '@prisma/client';

export interface CreateWarehouseSiteDto {
  code: string;
  name: string;
  timezone?: string;
  status?: string;
}

export interface CreateWarehouseZoneDto {
  code: string;
  name: string;
  zoneType?: string;
  status?: string;
  parentZoneId?: string;
  capacityPolicyJson?: Record<string, unknown> | null;
}

export interface CreateWarehouseBinDto {
  zoneId: string;
  aisleId?: string;
  rackId?: string;
  shelfId?: string;
  code: string;
  status?: string;
  binType?: string;
  capacityUnits?: number;
  capacityWeight?: number;
  capacityVolume?: number;
  pickFaceEnabled?: boolean;
}

function normalizeCode(value: string, label: string) {
  const normalized = value.trim().toUpperCase();
  if (!normalized) {
    throw new AppError(400, `${label} обязателен`, 'VALIDATION');
  }
  return normalized;
}

function normalizeName(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized) {
    throw new AppError(400, `${label} обязательно`, 'VALIDATION');
  }
  return normalized;
}

async function createOutboxRecord(tx: Prisma.TransactionClient, input: {
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

export async function getFoundationStatus(orgId: string) {
  const [
    sites,
    zones,
    bins,
    variants,
    balances,
    ledgerEvents,
    layoutVersions,
    pendingOutbox,
    processedInbox,
  ] = await Promise.all([
    prisma.warehouseSite.count({ where: { orgId } }),
    prisma.warehouseZone.count({ where: { orgId } }),
    prisma.warehouseBin.count({ where: { orgId } }),
    prisma.warehouseVariant.count({ where: { orgId } }),
    prisma.warehouseStockBalance.count({ where: { orgId } }),
    prisma.warehouseStockLedgerEvent.count({ where: { orgId } }),
    prisma.warehouseLayoutVersion.count({ where: { orgId } }),
    prisma.warehouseOutbox.count({ where: { orgId, status: 'pending' } }),
    prisma.warehouseProjectionInbox.count({ where: { orgId } }),
  ]);

  return {
    structure: {
      sites,
      zones,
      bins,
      structureReady: sites > 0 && zones > 0,
    },
    inventory: {
      variants,
      balances,
      ledgerEvents,
    },
    system: {
      layoutVersions,
      pendingOutbox,
      processedInbox,
    },
  };
}

export async function listSites(orgId: string) {
  return prisma.warehouseSite.findMany({
    where: { orgId },
    orderBy: [{ name: 'asc' }],
    include: {
      _count: {
        select: {
          zones: true,
          bins: true,
          layoutVersions: true,
        },
      },
    },
  });
}

export async function createSite(orgId: string, dto: CreateWarehouseSiteDto, actorName?: string | null) {
  const code = normalizeCode(dto.code, 'Код склада');
  const name = normalizeName(dto.name, 'Название склада');
  const timezone = dto.timezone?.trim() || 'UTC';
  const status = dto.status?.trim() || 'active';

  const existing = await prisma.warehouseSite.findFirst({
    where: { orgId, code },
    select: { id: true },
  });
  if (existing) {
    throw new AppError(409, 'Склад с таким кодом уже существует', 'CONFLICT');
  }

  return prisma.$transaction(async (tx) => {
    const site = await tx.warehouseSite.create({
      data: {
        orgId,
        code,
        name,
        timezone,
        status,
      },
    });

    const initialLayoutVersion = await tx.warehouseLayoutVersion.create({
      data: {
        orgId,
        warehouseSiteId: site.id,
        versionNo: 1,
        state: 'published',
        publishedAt: new Date(),
        createdBy: actorName?.trim() || 'system',
        notes: 'Initial live layout baseline',
      },
    });

    const updatedSite = await tx.warehouseSite.update({
      where: { id: site.id },
      data: { publishedLayoutVersionId: initialLayoutVersion.id },
      include: {
        _count: {
          select: {
            zones: true,
            bins: true,
            layoutVersions: true,
          },
        },
      },
    });

    await createOutboxRecord(tx, {
      orgId,
      warehouseSiteId: site.id,
      aggregateType: 'warehouse.site',
      aggregateId: site.id,
      eventType: 'warehouse.site.created',
      payload: {
        siteId: site.id,
        code,
        name,
        timezone,
        publishedLayoutVersionId: initialLayoutVersion.id,
      },
    });

    return updatedSite;
  });
}

export async function createZone(orgId: string, siteId: string, dto: CreateWarehouseZoneDto) {
  const code = normalizeCode(dto.code, 'Код зоны');
  const name = normalizeName(dto.name, 'Название зоны');
  const zoneType = dto.zoneType?.trim() || 'storage';
  const status = dto.status?.trim() || 'active';

  const site = await prisma.warehouseSite.findFirst({
    where: { id: siteId, orgId },
    select: { id: true },
  });
  if (!site) {
    throw new AppError(404, 'Склад не найден', 'NOT_FOUND');
  }

  if (dto.parentZoneId) {
    const parentZone = await prisma.warehouseZone.findFirst({
      where: { id: dto.parentZoneId, orgId, warehouseSiteId: siteId },
      select: { id: true },
    });
    if (!parentZone) {
      throw new AppError(404, 'Родительская зона не найдена в этом складе', 'NOT_FOUND');
    }
  }

  const existing = await prisma.warehouseZone.findFirst({
    where: { warehouseSiteId: siteId, code },
    select: { id: true },
  });
  if (existing) {
    throw new AppError(409, 'Зона с таким кодом уже существует', 'CONFLICT');
  }

  return prisma.$transaction(async (tx) => {
    const zone = await tx.warehouseZone.create({
      data: {
        orgId,
        warehouseSiteId: siteId,
        parentZoneId: dto.parentZoneId ?? null,
        code,
        name,
        zoneType,
        status,
        capacityPolicyJson:
          dto.capacityPolicyJson === null
            ? Prisma.JsonNull
            : dto.capacityPolicyJson === undefined
              ? undefined
              : (dto.capacityPolicyJson as Prisma.InputJsonValue),
      },
    });

    await createOutboxRecord(tx, {
      orgId,
      warehouseSiteId: siteId,
      aggregateType: 'warehouse.zone',
      aggregateId: zone.id,
      eventType: 'warehouse.zone.created',
      payload: {
        zoneId: zone.id,
        siteId,
        code,
        name,
        zoneType,
        status,
        parentZoneId: dto.parentZoneId ?? null,
      },
    });

    return zone;
  });
}

export async function createBin(orgId: string, siteId: string, dto: CreateWarehouseBinDto) {
  const code = normalizeCode(dto.code, 'Код ячейки');
  const zone = await prisma.warehouseZone.findFirst({
    where: { id: dto.zoneId, orgId, warehouseSiteId: siteId },
    select: { id: true },
  });
  if (!zone) {
    throw new AppError(404, 'Зона для ячейки не найдена', 'NOT_FOUND');
  }

  if (dto.aisleId) {
    const aisle = await prisma.warehouseAisle.findFirst({
      where: { id: dto.aisleId, orgId, warehouseSiteId: siteId },
      select: { id: true },
    });
    if (!aisle) {
      throw new AppError(404, 'Проход для ячейки не найден', 'NOT_FOUND');
    }
  }

  if (dto.rackId) {
    const rack = await prisma.warehouseRack.findFirst({
      where: { id: dto.rackId, orgId, warehouseSiteId: siteId },
      select: { id: true },
    });
    if (!rack) {
      throw new AppError(404, 'Стеллаж для ячейки не найден', 'NOT_FOUND');
    }
  }

  if (dto.shelfId) {
    const shelf = await prisma.warehouseShelf.findFirst({
      where: {
        id: dto.shelfId,
        rack: {
          is: {
            orgId,
            warehouseSiteId: siteId,
          },
        },
      },
      select: { id: true },
    });
    if (!shelf) {
      throw new AppError(404, 'Полка для ячейки не найдена', 'NOT_FOUND');
    }
  }

  const existing = await prisma.warehouseBin.findFirst({
    where: { warehouseSiteId: siteId, code },
    select: { id: true },
  });
  if (existing) {
    throw new AppError(409, 'Ячейка с таким кодом уже существует', 'CONFLICT');
  }

  return prisma.$transaction(async (tx) => {
    const bin = await tx.warehouseBin.create({
      data: {
        orgId,
        warehouseSiteId: siteId,
        zoneId: dto.zoneId,
        aisleId: dto.aisleId ?? null,
        rackId: dto.rackId ?? null,
        shelfId: dto.shelfId ?? null,
        code,
        status: dto.status?.trim() || 'active',
        binType: dto.binType?.trim() || 'standard',
        capacityUnits: dto.capacityUnits,
        capacityWeight: dto.capacityWeight,
        capacityVolume: dto.capacityVolume,
        pickFaceEnabled: dto.pickFaceEnabled ?? false,
      },
      include: {
        zone: {
          select: {
            id: true,
            code: true,
            name: true,
          },
        },
      },
    });

    await createOutboxRecord(tx, {
      orgId,
      warehouseSiteId: siteId,
      aggregateType: 'warehouse.bin',
      aggregateId: bin.id,
      eventType: 'warehouse.bin.created',
      payload: {
        binId: bin.id,
        siteId,
        zoneId: dto.zoneId,
        code,
        status: bin.status,
        binType: bin.binType,
        pickFaceEnabled: bin.pickFaceEnabled,
      },
    });

    return bin;
  });
}

export async function getSiteStructure(orgId: string, siteId: string) {
  const site = await prisma.warehouseSite.findFirst({
    where: { id: siteId, orgId },
    include: {
      _count: {
        select: {
          zones: true,
          bins: true,
          aisles: true,
          racks: true,
          layoutVersions: true,
        },
      },
    },
  });

  if (!site) {
    throw new AppError(404, 'Склад не найден', 'NOT_FOUND');
  }

  const [zones, bins, liveLayout, pendingOutbox] = await Promise.all([
    prisma.warehouseZone.findMany({
      where: { orgId, warehouseSiteId: siteId },
      orderBy: [{ code: 'asc' }],
      include: {
        _count: {
          select: {
            bins: true,
            aisles: true,
            racks: true,
            childZones: true,
          },
        },
      },
    }),
    prisma.warehouseBin.findMany({
      where: { orgId, warehouseSiteId: siteId },
      orderBy: [{ code: 'asc' }],
      include: {
        zone: {
          select: {
            id: true,
            code: true,
            name: true,
          },
        },
      },
    }),
    site.publishedLayoutVersionId
      ? prisma.warehouseLayoutVersion.findFirst({
          where: { id: site.publishedLayoutVersionId, orgId },
        })
      : null,
    prisma.warehouseOutbox.count({
      where: {
        orgId,
        warehouseSiteId: siteId,
        status: 'pending',
      },
    }),
  ]);

  return {
    site,
    liveLayout,
    zones,
    bins,
    pendingOutbox,
  };
}
