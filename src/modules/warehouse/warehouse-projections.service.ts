import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { resolveWarehouseSiteForOrder } from './warehouse-operations.service.js';
import { syncWarehouseOperationalState } from './warehouse-runtime.service.js';

type Tx = Prisma.TransactionClient | PrismaClient;

function jsonHash(value: unknown) {
  const raw = JSON.stringify(value ?? null);
  let hash = 0;

  for (let index = 0; index < raw.length; index += 1) {
    hash = ((hash << 5) - hash) + raw.charCodeAt(index);
    hash |= 0;
  }

  return String(hash >>> 0);
}

function asRecord(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function getOrderIdFromOutboxPayload(payload: Record<string, unknown>) {
  if (typeof payload.orderId === 'string' && payload.orderId) {
    return payload.orderId;
  }

  if (typeof payload.sourceId === 'string' && payload.sourceId) {
    const sourceType = typeof payload.sourceType === 'string' ? payload.sourceType : '';
    if (sourceType.startsWith('chapan_order')) {
      return payload.sourceId;
    }
  }

  return null;
}

function ensureWarehouseSiteAccess<T extends Tx>(db: T, orgId: string, siteId: string) {
  return db.warehouseSite.findFirst({
    where: { id: siteId, orgId },
    select: { id: true, code: true, name: true },
  });
}

function buildSiteControlAlerts(input: {
  zones: number;
  bins: number;
  qtyAvailable: number;
  qtyReserved: number;
  activeReservations: number;
  queuedTasks: number;
  overdueTasks: number;
  unassignedTasks: number;
  openExceptions: number;
  criticalExceptions: number;
  ownerlessExceptions: number;
  breachedExceptions: number;
  urgentReplenishment: number;
  failedOutbox: number;
  pendingOutbox: number;
}) {
  const alerts: Array<{
    id: string;
    level: 'info' | 'warning' | 'critical';
    code: string;
    title: string;
    description: string;
  }> = [];

  if (input.zones === 0 || input.bins === 0) {
    alerts.push({
      id: 'structure-bootstrap-gap',
      level: 'warning',
      code: 'structure.bootstrap_gap',
      title: 'Structure is not fully bootstrapped',
      description: 'Site still has missing zones or bins, so operational routing remains incomplete.',
    });
  }

  if (input.activeReservations > 0 && input.qtyAvailable <= 0) {
    alerts.push({
      id: 'inventory-stock-pressure',
      level: 'critical',
      code: 'inventory.stock_pressure',
      title: 'Active reservations have no available stock buffer',
      description: 'There are active reservations while available stock is depleted on the site.',
    });
  } else if (input.activeReservations > 0 && input.qtyReserved >= input.qtyAvailable) {
    alerts.push({
      id: 'inventory-reservation-pressure',
      level: 'warning',
      code: 'inventory.reservation_pressure',
      title: 'Reservation pressure is rising',
      description: 'Reserved quantity is close to or exceeds the currently available stock buffer.',
    });
  }

  if (input.criticalExceptions > 0) {
    alerts.push({
      id: 'operations-critical-exceptions',
      level: 'critical',
      code: 'operations.critical_exceptions',
      title: 'Critical warehouse exceptions detected',
      description: 'One or more warehouse hotspots require immediate supervisor intervention.',
    });
  } else if (input.openExceptions > 0) {
    alerts.push({
      id: 'operations-open-exceptions',
      level: 'warning',
      code: 'operations.open_exceptions',
      title: 'Warehouse exceptions are accumulating',
      description: 'There are unresolved warehouse pressure points in bins or zones.',
    });
  }

  if (input.overdueTasks > 0) {
    alerts.push({
      id: 'operations-task-sla-breach',
      level: input.overdueTasks >= 3 ? 'critical' : 'warning',
      code: 'operations.task_sla_breach',
      title: 'Warehouse task SLA is slipping',
      description: 'One or more execution tasks have breached their expected response window.',
    });
  }

  if (input.unassignedTasks > 0) {
    alerts.push({
      id: 'operations-unassigned-tasks',
      level: input.unassignedTasks >= 4 ? 'warning' : 'info',
      code: 'operations.unassigned_tasks',
      title: 'Execution queue lacks ownership',
      description: 'Several warehouse tasks are still unassigned and need an owner.',
    });
  }

  if (input.ownerlessExceptions > 0 || input.breachedExceptions > 0) {
    alerts.push({
      id: 'operations-ownerless-exceptions',
      level: input.breachedExceptions > 0 ? 'critical' : 'warning',
      code: 'operations.ownerless_exceptions',
      title: 'Exception ownership is incomplete',
      description: 'Open exceptions need assignment or have already breached their response window.',
    });
  }

  if (input.urgentReplenishment > 0) {
    alerts.push({
      id: 'operations-replenishment-pressure',
      level: input.urgentReplenishment >= 3 ? 'critical' : 'warning',
      code: 'operations.replenishment_pressure',
      title: 'Replenishment pressure detected',
      description: 'Pick-facing bins are depleting and should be refilled before flow stalls.',
    });
  }

  if (input.queuedTasks >= 8) {
    alerts.push({
      id: 'operations-task-pressure',
      level: 'warning',
      code: 'operations.task_pressure',
      title: 'Operational queue pressure is rising',
      description: 'Warehouse execution queues indicate growing work-in-progress across the site.',
    });
  }

  if (input.failedOutbox > 0) {
    alerts.push({
      id: 'realtime-outbox-failed',
      level: 'critical',
      code: 'realtime.outbox_failed',
      title: 'Projection delivery failures detected',
      description: 'At least one warehouse outbox event failed and requires investigation.',
    });
  }

  if (input.pendingOutbox >= 10) {
    alerts.push({
      id: 'realtime-outbox-backlog',
      level: 'warning',
      code: 'realtime.outbox_backlog',
      title: 'Projection backlog is growing',
      description: 'Pending outbox volume is high and may delay control-tower freshness.',
    });
  }

  if (alerts.length === 0) {
    alerts.push({
      id: 'site-healthy',
      level: 'info',
      code: 'site.healthy',
      title: 'Site health is stable',
      description: 'No immediate structural, stock-pressure or projection issues were detected.',
    });
  }

  return alerts;
}

type SiteControlLevel = 'info' | 'warning' | 'critical';

function buildSiteAlertClasses(alerts: Array<{
  level: SiteControlLevel;
}>) {
  return [
    {
      id: 'critical',
      label: 'Critical',
      level: 'critical' as const,
      count: alerts.filter((alert) => alert.level === 'critical').length,
    },
    {
      id: 'warning',
      label: 'Warning',
      level: 'warning' as const,
      count: alerts.filter((alert) => alert.level === 'warning').length,
    },
    {
      id: 'info',
      label: 'Info',
      level: 'info' as const,
      count: alerts.filter((alert) => alert.level === 'info').length,
    },
  ];
}

function buildSiteActionableCounters(input: {
  qtyAvailable: number;
  qtyReserved: number;
  activeReservations: number;
  queuedTasks: number;
  overdueTasks: number;
  unassignedTasks: number;
  openExceptions: number;
  criticalExceptions: number;
  ownerlessExceptions: number;
  breachedExceptions: number;
  replenishmentCandidates: number;
  urgentReplenishment: number;
  pendingOutbox: number;
  failedOutbox: number;
}) {
  return [
    {
      id: 'active-reservations',
      label: 'Active reservations',
      value: input.activeReservations,
      level:
        input.activeReservations > 0
          ? (input.qtyAvailable <= 0 ? 'critical' : 'warning')
          : 'info',
      note:
        input.activeReservations > 0 && input.qtyAvailable <= 0
          ? 'No available stock buffer'
          : `${input.qtyAvailable} available buffer`,
    },
    {
      id: 'reservation-pressure',
      label: 'Reservation pressure',
      value: input.qtyReserved,
      level:
        input.qtyReserved > input.qtyAvailable
          ? 'warning'
          : 'info',
      note: `${input.qtyAvailable} available`,
    },
    {
      id: 'queued-tasks',
      label: 'Execution tasks',
      value: input.queuedTasks,
      level:
        input.queuedTasks >= 8
          ? 'warning'
          : (input.queuedTasks > 0 ? 'info' : 'info'),
      note: 'Pick / putaway / replenishment execution layer',
    },
    {
      id: 'overdue-tasks',
      label: 'Overdue tasks',
      value: input.overdueTasks,
      level:
        input.overdueTasks > 0
          ? (input.overdueTasks >= 3 ? 'critical' : 'warning')
          : 'info',
      note: `${input.unassignedTasks} without owner`,
    },
    {
      id: 'warehouse-exceptions',
      label: 'Warehouse exceptions',
      value: input.openExceptions,
      level:
        input.criticalExceptions > 0
          ? 'critical'
          : (input.openExceptions > 0 ? 'warning' : 'info'),
      note: `${input.criticalExceptions} critical hotspots`,
    },
    {
      id: 'exception-ownership',
      label: 'Exception ownership gaps',
      value: input.ownerlessExceptions + input.breachedExceptions,
      level:
        input.breachedExceptions > 0
          ? 'critical'
          : (input.ownerlessExceptions > 0 ? 'warning' : 'info'),
      note: `${input.ownerlessExceptions} ownerless / ${input.breachedExceptions} breached`,
    },
    {
      id: 'replenishment-hotspots',
      label: 'Replenishment hotspots',
      value: input.replenishmentCandidates,
      level:
        input.urgentReplenishment > 0
          ? 'warning'
          : 'info',
      note: `${input.urgentReplenishment} urgent pick-face gaps`,
    },
    {
      id: 'projection-backlog',
      label: 'Projection backlog',
      value: input.pendingOutbox + input.failedOutbox,
      level:
        input.failedOutbox > 0
          ? 'critical'
          : (input.pendingOutbox >= 10 ? 'warning' : 'info'),
      note: `${input.pendingOutbox} pending / ${input.failedOutbox} failed`,
    },
  ];
}

function buildSiteActionCards(input: {
  zones: number;
  bins: number;
  qtyAvailable: number;
  activeReservations: number;
  queuedTasks: number;
  pickQueue: number;
  putawayQueue: number;
  overdueTasks: number;
  unassignedTasks: number;
  openExceptions: number;
  criticalExceptions: number;
  ownerlessExceptions: number;
  breachedExceptions: number;
  replenishmentCandidates: number;
  urgentReplenishment: number;
  pendingOutbox: number;
  failedOutbox: number;
}) {
  const cards: Array<{
    id: string;
    level: SiteControlLevel;
    title: string;
    description: string;
    actionLabel: string;
    href: string;
    metric?: string;
  }> = [];

  if (input.zones === 0 || input.bins === 0) {
    cards.push({
      id: 'bootstrap-structure',
      level: 'warning',
      title: 'Bootstrap physical structure',
      description: 'The site still lacks enough zones or bins to behave like a real operational twin.',
      actionLabel: 'Open Foundation',
      href: '/warehouse',
      metric: `${input.zones} zones / ${input.bins} bins`,
    });
  }

  if (input.activeReservations > 0 && input.qtyAvailable <= 0) {
    cards.push({
      id: 'inject-stock-buffer',
      level: 'critical',
      title: 'Inject stock buffer now',
      description: 'Active reservations are competing for zero available stock. Post receipt or rebalance stock immediately.',
      actionLabel: 'Open Receipt Flow',
      href: '/warehouse/operations#receipt-panel',
      metric: `${input.activeReservations} active reservations`,
    });
  }

  if (input.criticalExceptions > 0) {
    cards.push({
      id: 'resolve-hotspots',
      level: 'critical',
      title: 'Resolve warehouse hotspots',
      description: 'Critical exception hotspots are active in the live warehouse and should be triaged first.',
      actionLabel: 'Open Exceptions',
      href: '/warehouse/control-tower#exceptions-panel',
      metric: `${input.criticalExceptions} critical`,
    });
  }

  if (input.overdueTasks > 0 || input.unassignedTasks > 0) {
    cards.push({
      id: 'stabilize-execution-layer',
      level: input.overdueTasks > 0 ? 'critical' : 'warning',
      title: 'Stabilize execution ownership',
      description: 'Warehouse tasks are missing owners or have exceeded their expected execution window.',
      actionLabel: 'Open Twin Commands',
      href: '/warehouse/twin#routes-panel',
      metric: `${input.overdueTasks} overdue / ${input.unassignedTasks} unassigned`,
    });
  }

  if (input.ownerlessExceptions > 0 || input.breachedExceptions > 0) {
    cards.push({
      id: 'claim-exception-resolution',
      level: input.breachedExceptions > 0 ? 'critical' : 'warning',
      title: 'Claim exception resolution',
      description: 'Exception cases need explicit ownership and resolution flow, not just passive monitoring.',
      actionLabel: 'Open Twin Exceptions',
      href: '/warehouse/twin#exceptions-panel',
      metric: `${input.ownerlessExceptions} ownerless / ${input.breachedExceptions} breached`,
    });
  }

  if (input.urgentReplenishment > 0) {
    cards.push({
      id: 'replenish-pick-face',
      level: input.urgentReplenishment >= 3 ? 'critical' : 'warning',
      title: 'Replenish pick-face bins',
      description: 'Low-buffer pick bins are visible on the site map and should be refilled before picks stall.',
      actionLabel: 'Open Site Map',
      href: '/warehouse/twin#scene-panel',
      metric: `${input.urgentReplenishment} urgent / ${input.replenishmentCandidates} total`,
    });
  }

  if (input.pickQueue > 0 || input.putawayQueue > 0 || input.queuedTasks >= 8) {
    cards.push({
      id: 'focus-operational-pressure',
      level: input.queuedTasks >= 8 ? 'warning' : 'info',
      title: 'Focus operational pressure',
      description: 'Picking and putaway demand is building up; use the spatial shell to focus the hottest zones first.',
      actionLabel: 'Open Operations',
      href: '/warehouse/twin#routes-panel',
      metric: `${input.pickQueue} pick / ${input.putawayQueue} putaway`,
    });
  }

  if (input.failedOutbox > 0) {
    cards.push({
      id: 'repair-projection-failures',
      level: 'critical',
      title: 'Repair projection delivery',
      description: 'Outbox failures are degrading control-tower freshness and must be investigated.',
      actionLabel: 'Inspect Realtime',
      href: '/warehouse/control-tower#realtime-panel',
      metric: `${input.failedOutbox} failed`,
    });
  }

  if (input.pendingOutbox >= 10) {
    cards.push({
      id: 'clear-event-backlog',
      level: 'warning',
      title: 'Clear event backlog',
      description: 'Projection backlog is growing and can delay the warehouse twin from reflecting reality.',
      actionLabel: 'Open Feed',
      href: '/warehouse/control-tower#feed-panel',
      metric: `${input.pendingOutbox} pending`,
    });
  }

  if (!cards.length) {
    cards.push({
      id: 'steady-state',
      level: 'info',
      title: 'Site is in a stable state',
      description: 'No high-priority warehouse actions are required right now. Use the shell to simulate or monitor.',
      actionLabel: 'Open Control Tower',
      href: '/warehouse/control-tower',
      metric: 'steady state',
    });
  }

  return cards.slice(0, 4);
}

function levelRank(level: SiteControlLevel) {
  if (level === 'critical') return 3;
  if (level === 'warning') return 2;
  return 1;
}

function maxLevel(...levels: SiteControlLevel[]) {
  return levels.reduce<SiteControlLevel>((current, next) => (
    levelRank(next) > levelRank(current) ? next : current
  ), 'info');
}

function buildVariantLabel(input: {
  variantKey: string;
  attributesSummary: string | null;
  productCatalog?: { name: string } | null;
}) {
  const base = input.productCatalog?.name ?? input.variantKey;
  return input.attributesSummary?.trim()
    ? `${base} · ${input.attributesSummary.trim()}`
    : base;
}

function buildOperationalPressureModel(input: {
  zones: Array<{
    id: string;
    code: string;
    name: string;
    zoneType: string;
    status: string;
    _count: { bins: number };
  }>;
  bins: Array<{
    id: string;
    code: string;
    zoneId: string;
    status: string;
    binType: string;
    pickFaceEnabled: boolean;
    capacityUnits: number | null;
    zone: {
      id: string;
      code: string;
      name: string;
      zoneType: string;
    };
  }>;
  balanceRows: Array<{
    binId: string;
    qtyOnHand: number;
    qtyReserved: number;
    qtyAvailable: number;
    variant: {
      variantKey: string;
      attributesSummary: string | null;
      productCatalog?: { name: string } | null;
    };
  }>;
  reservationSummary: {
    active: number;
  };
}) {
  const zoneMap = new Map(input.zones.map((zone) => [zone.id, {
    id: zone.id,
    code: zone.code,
    name: zone.name,
    zoneType: zone.zoneType,
    status: zone.status,
    binCount: zone._count.bins,
    activeBins: 0,
    blockedBins: 0,
    qtyOnHand: 0,
    qtyAvailable: 0,
    qtyReserved: 0,
    totalCapacityUnits: 0,
    exceptionCount: 0,
    pickBins: 0,
    putawayBins: 0,
    replenishmentCandidates: 0,
    urgentReplenishment: 0,
    dominantSignal: 'stable',
    level: 'info' as SiteControlLevel,
  }]));

  const binMap = new Map(input.bins.map((bin) => [bin.id, {
    id: bin.id,
    code: bin.code,
    zoneId: bin.zoneId,
    zoneCode: bin.zone.code,
    zoneName: bin.zone.name,
    zoneType: bin.zone.zoneType,
    status: bin.status,
    binType: bin.binType,
    pickFaceEnabled: bin.pickFaceEnabled,
    capacityUnits: bin.capacityUnits ?? 0,
    qtyOnHand: 0,
    qtyAvailable: 0,
    qtyReserved: 0,
    occupancyRate: null as number | null,
    reservationPressure: 0,
    replenishmentLevel: 'info' as SiteControlLevel,
    level: (bin.status !== 'active' ? 'critical' : 'info') as SiteControlLevel,
    primaryVariantLabel: null as string | null,
    signals: [] as string[],
  }]));

  for (const balance of input.balanceRows) {
    const bin = binMap.get(balance.binId);
    if (!bin) continue;

    bin.qtyOnHand += balance.qtyOnHand;
    bin.qtyAvailable += balance.qtyAvailable;
    bin.qtyReserved += balance.qtyReserved;

    if (!bin.primaryVariantLabel || balance.qtyReserved > 0 || balance.qtyOnHand > 0) {
      bin.primaryVariantLabel = buildVariantLabel(balance.variant);
    }

    const zone = zoneMap.get(bin.zoneId);
    if (!zone) continue;

    zone.qtyOnHand += balance.qtyOnHand;
    zone.qtyAvailable += balance.qtyAvailable;
    zone.qtyReserved += balance.qtyReserved;
  }

  const exceptions: Array<{
    id: string;
    level: SiteControlLevel;
    category: 'structure' | 'stockout' | 'replenishment' | 'blocked' | 'capacity';
    title: string;
    description: string;
    zoneId?: string;
    zoneCode?: string;
    binId?: string;
    binCode?: string;
    href: string;
  }> = [];

  let pickQueue = 0;
  let putawayQueue = 0;
  let replenishmentCandidates = 0;
  let urgentReplenishment = 0;

  for (const bin of binMap.values()) {
    const zone = zoneMap.get(bin.zoneId);
    if (!zone) continue;

    zone.totalCapacityUnits += Math.max(0, bin.capacityUnits);

    if (bin.qtyOnHand > 0 || bin.qtyReserved > 0 || bin.qtyAvailable > 0) {
      zone.activeBins += 1;
    }

    if (bin.status !== 'active') {
      bin.signals.push('blocked');
      zone.blockedBins += 1;
      zone.exceptionCount += 1;
      zone.level = maxLevel(zone.level, 'critical');
      exceptions.push({
        id: `blocked:${bin.id}`,
        level: 'critical',
        category: 'blocked',
        title: `Blocked bin ${bin.code}`,
        description: `${bin.zoneCode} contains a non-active bin that can break pick or putaway flow.`,
        zoneId: bin.zoneId,
        zoneCode: bin.zoneCode,
        binId: bin.id,
        binCode: bin.code,
        href: '/warehouse#site-map-panel',
      });
    }

    if (bin.capacityUnits > 0) {
      bin.occupancyRate = Number((bin.qtyOnHand / bin.capacityUnits).toFixed(3));
    }

    if (bin.qtyReserved > 0) {
      pickQueue += 1;
      zone.pickBins += 1;
      bin.signals.push('pick');
    }

    bin.reservationPressure = bin.qtyReserved > 0
      ? Number((bin.qtyReserved / Math.max(bin.qtyAvailable, 1)).toFixed(3))
      : 0;

    if (bin.qtyReserved > 0 && bin.qtyAvailable <= 0) {
      bin.level = maxLevel(bin.level, 'critical');
      bin.signals.push('stockout');
      zone.exceptionCount += 1;
      zone.level = maxLevel(zone.level, 'critical');
      exceptions.push({
        id: `stockout:${bin.id}`,
        level: 'critical',
        category: 'stockout',
        title: `Stockout pressure at ${bin.code}`,
        description: `${bin.zoneCode} has reserved demand with no available buffer in the bin.`,
        zoneId: bin.zoneId,
        zoneCode: bin.zoneCode,
        binId: bin.id,
        binCode: bin.code,
        href: '/warehouse#site-map-panel',
      });
    } else if (bin.qtyReserved > 0 && bin.reservationPressure >= 1) {
      bin.level = maxLevel(bin.level, 'warning');
      bin.signals.push('reservation-pressure');
      zone.exceptionCount += 1;
      zone.level = maxLevel(zone.level, 'warning');
      exceptions.push({
        id: `reservation:${bin.id}`,
        level: 'warning',
        category: 'stockout',
        title: `Reservation pressure at ${bin.code}`,
        description: `${bin.zoneCode} is nearing depletion while active demand is already reserved.`,
        zoneId: bin.zoneId,
        zoneCode: bin.zoneCode,
        binId: bin.id,
        binCode: bin.code,
        href: '/warehouse#site-map-panel',
      });
    }

    const isPickFace = bin.pickFaceEnabled || bin.binType === 'pick_face' || bin.zoneType === 'picking';
    const replenishmentRatio = bin.capacityUnits > 0
      ? (bin.qtyAvailable / bin.capacityUnits)
      : (bin.qtyAvailable <= 0 ? 0 : 1);

    if (isPickFace && (replenishmentRatio <= 0.25 || (bin.qtyAvailable <= 0 && bin.qtyReserved > 0))) {
      replenishmentCandidates += 1;
      zone.replenishmentCandidates += 1;
      bin.signals.push('replenishment');

      const level: SiteControlLevel = replenishmentRatio <= 0.1 || bin.qtyAvailable <= 0
        ? 'critical'
        : 'warning';

      bin.replenishmentLevel = level;
      bin.level = maxLevel(bin.level, level);
      zone.level = maxLevel(zone.level, level);

      if (level === 'critical') {
        urgentReplenishment += 1;
        zone.urgentReplenishment += 1;
      }

      exceptions.push({
        id: `replenishment:${bin.id}`,
        level,
        category: 'replenishment',
        title: `Replenishment needed at ${bin.code}`,
        description: `${bin.zoneCode} pick face is running low${bin.primaryVariantLabel ? ` for ${bin.primaryVariantLabel}` : ''}.`,
        zoneId: bin.zoneId,
        zoneCode: bin.zoneCode,
        binId: bin.id,
        binCode: bin.code,
        href: '/warehouse#site-map-panel',
      });
    }

    if ((bin.zoneType === 'receiving' || bin.zoneType === 'staging') && bin.qtyOnHand > 0) {
      putawayQueue += 1;
      zone.putawayBins += 1;
      zone.level = maxLevel(zone.level, 'warning');
      bin.signals.push('putaway');
    }

    if (bin.capacityUnits > 0 && bin.qtyOnHand > bin.capacityUnits) {
      bin.level = maxLevel(bin.level, 'warning');
      bin.signals.push('capacity');
      zone.exceptionCount += 1;
      zone.level = maxLevel(zone.level, 'warning');
      exceptions.push({
        id: `capacity:${bin.id}`,
        level: 'warning',
        category: 'capacity',
        title: `Capacity overflow at ${bin.code}`,
        description: `${bin.zoneCode} bin is carrying more units than its declared capacity.`,
        zoneId: bin.zoneId,
        zoneCode: bin.zoneCode,
        binId: bin.id,
        binCode: bin.code,
        href: '/warehouse#site-map-panel',
      });
    }
  }

  for (const zone of zoneMap.values()) {
    if (zone.binCount === 0) {
      zone.level = maxLevel(zone.level, 'warning');
      zone.dominantSignal = 'structure-gap';
      zone.exceptionCount += 1;
      exceptions.push({
        id: `structure:${zone.id}`,
        level: 'warning',
        category: 'structure',
        title: `Zone ${zone.code} has no bins`,
        description: 'This zone exists in the layout but has no addressable storage locations yet.',
        zoneId: zone.id,
        zoneCode: zone.code,
        href: '/warehouse#site-map-panel',
      });
      continue;
    }

    if (zone.urgentReplenishment > 0) {
      zone.dominantSignal = 'replenishment';
    } else if (zone.exceptionCount > 0) {
      zone.dominantSignal = 'exception';
    } else if (zone.putawayBins > 0) {
      zone.dominantSignal = 'putaway';
    } else if (zone.pickBins > 0) {
      zone.dominantSignal = 'pick';
    } else {
      zone.dominantSignal = 'stable';
    }
  }

  const zoneHeat = Array.from(zoneMap.values())
    .map((zone) => ({
      id: zone.id,
      code: zone.code,
      name: zone.name,
      zoneType: zone.zoneType,
      status: zone.status,
      binCount: zone.binCount,
      activeBins: zone.activeBins,
      blockedBins: zone.blockedBins,
      qtyOnHand: zone.qtyOnHand,
      qtyAvailable: zone.qtyAvailable,
      qtyReserved: zone.qtyReserved,
      occupancyRate: zone.totalCapacityUnits > 0
        ? Number((zone.qtyOnHand / zone.totalCapacityUnits).toFixed(3))
        : null,
      reservationPressure: zone.qtyReserved > 0
        ? Number((zone.qtyReserved / Math.max(zone.qtyAvailable, 1)).toFixed(3))
        : 0,
      taskPressure: zone.pickBins + zone.putawayBins + zone.replenishmentCandidates,
      exceptionCount: zone.exceptionCount,
      replenishmentCandidates: zone.replenishmentCandidates,
      urgentReplenishment: zone.urgentReplenishment,
      dominantSignal: zone.dominantSignal,
      level: zone.level,
    }))
    .sort((left, right) => (
      levelRank(right.level) - levelRank(left.level)
      || right.taskPressure - left.taskPressure
      || right.exceptionCount - left.exceptionCount
      || left.code.localeCompare(right.code)
    ));

  const binHeat = Array.from(binMap.values())
    .map((bin) => ({
      id: bin.id,
      code: bin.code,
      zoneId: bin.zoneId,
      zoneCode: bin.zoneCode,
      zoneName: bin.zoneName,
      zoneType: bin.zoneType,
      status: bin.status,
      binType: bin.binType,
      pickFaceEnabled: bin.pickFaceEnabled,
      capacityUnits: bin.capacityUnits > 0 ? bin.capacityUnits : null,
      qtyOnHand: bin.qtyOnHand,
      qtyAvailable: bin.qtyAvailable,
      qtyReserved: bin.qtyReserved,
      occupancyRate: bin.occupancyRate,
      reservationPressure: bin.reservationPressure,
      replenishmentLevel: bin.replenishmentLevel,
      level: bin.level,
      primaryVariantLabel: bin.primaryVariantLabel,
      signals: bin.signals,
    }))
    .sort((left, right) => (
      levelRank(right.level) - levelRank(left.level)
      || right.qtyReserved - left.qtyReserved
      || right.qtyOnHand - left.qtyOnHand
      || left.code.localeCompare(right.code)
    ));

  const taskQueues = [
    {
      id: 'pick',
      label: 'Pick pressure',
      queueType: 'pick',
      count: Math.max(input.reservationSummary.active, pickQueue),
      level: input.reservationSummary.active > 0 ? (pickQueue > 0 ? 'warning' : 'info') : 'info',
      description: 'Reserved demand that needs active picking focus.',
      href: '/warehouse#site-map-panel',
    },
    {
      id: 'putaway',
      label: 'Putaway backlog',
      queueType: 'putaway',
      count: putawayQueue,
      level: putawayQueue > 0 ? 'warning' : 'info',
      description: 'Stock sitting in receiving or staging zones waiting for placement.',
      href: '/warehouse/operations#transfer-panel',
    },
    {
      id: 'replenishment',
      label: 'Replenishment queue',
      queueType: 'replenishment',
      count: replenishmentCandidates,
      level: urgentReplenishment > 0 ? 'critical' : (replenishmentCandidates > 0 ? 'warning' : 'info'),
      description: 'Pick-facing bins that need refill before order flow degrades.',
      href: '/warehouse#site-map-panel',
    },
    {
      id: 'exceptions',
      label: 'Exception queue',
      queueType: 'exception',
      count: exceptions.length,
      level: exceptions.some((row) => row.level === 'critical') ? 'critical' : (exceptions.length > 0 ? 'warning' : 'info'),
      description: 'Synthetic warehouse exception backlog built from stock, capacity and structure pressure.',
      href: '/warehouse/control-tower#exceptions-panel',
    },
  ];

  return {
    taskSummary: {
      queued: taskQueues.reduce((sum, row) => sum + row.count, 0),
      active: Math.max(input.reservationSummary.active, pickQueue),
      blocked: exceptions.filter((row) => row.level === 'critical').length,
    },
    exceptionSummary: {
      open: exceptions.length,
      critical: exceptions.filter((row) => row.level === 'critical').length,
    },
    replenishmentSummary: {
      candidateBins: replenishmentCandidates,
      urgentBins: urgentReplenishment,
      urgentZones: zoneHeat.filter((zone) => zone.urgentReplenishment > 0).length,
    },
    taskQueues,
    exceptions: exceptions
      .sort((left, right) => (
        levelRank(right.level) - levelRank(left.level)
        || left.title.localeCompare(right.title)
      ))
      .slice(0, 8),
    replenishmentHotspots: binHeat
      .filter((bin) => bin.signals.includes('replenishment'))
      .slice(0, 8)
      .map((bin) => ({
        id: `replenishment:${bin.id}`,
        binId: bin.id,
        binCode: bin.code,
        zoneId: bin.zoneId,
        zoneCode: bin.zoneCode,
        zoneName: bin.zoneName,
        level: bin.replenishmentLevel,
        qtyAvailable: bin.qtyAvailable,
        qtyReserved: bin.qtyReserved,
        capacityUnits: bin.capacityUnits,
        primaryVariantLabel: bin.primaryVariantLabel,
      })),
    siteMap: {
      zones: zoneHeat,
      bins: binHeat,
    },
  };
}

export async function listSiteReservations(
  orgId: string,
  siteId: string,
  filters?: { status?: string },
) {
  const site = await prisma.warehouseSite.findFirst({
    where: { id: siteId, orgId },
    select: { id: true, code: true, name: true },
  });

  if (!site) {
    throw new AppError(404, 'Склад не найден', 'NOT_FOUND');
  }

  const results = await prisma.warehouseStockReservation.findMany({
    where: {
      orgId,
      warehouseSiteId: siteId,
      ...(filters?.status ? { status: filters.status } : {}),
    },
    include: {
      site: {
        select: {
          id: true,
          code: true,
          name: true,
        },
      },
      variant: {
        include: {
          productCatalog: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      },
      allocations: {
        include: {
          bin: {
            select: {
              id: true,
              code: true,
            },
          },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return {
    site,
    count: results.length,
    results,
  };
}

export async function listSiteOperationDocuments(
  orgId: string,
  siteId: string,
  filters?: { documentType?: string },
) {
  const site = await prisma.warehouseSite.findFirst({
    where: { id: siteId, orgId },
    select: { id: true, code: true, name: true },
  });

  if (!site) {
    throw new AppError(404, 'Склад не найден', 'NOT_FOUND');
  }

  const results = await prisma.warehouseOperationDocument.findMany({
    where: {
      orgId,
      warehouseSiteId: siteId,
      ...(filters?.documentType ? { documentType: filters.documentType } : {}),
    },
    include: {
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

  return {
    site,
    count: results.length,
    results,
  };
}

export async function getSiteFeed(
  orgId: string,
  siteId: string,
  limit = 24,
) {
  const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 24;

  const site = await prisma.warehouseSite.findFirst({
    where: { id: siteId, orgId },
    select: { id: true, code: true, name: true },
  });

  if (!site) {
    throw new AppError(404, 'Склад не найден', 'NOT_FOUND');
  }

  const [reservations, documents, outbox, inbox, tasks, exceptions] = await Promise.all([
    prisma.warehouseStockReservation.findMany({
      where: { orgId, warehouseSiteId: siteId },
      include: {
        variant: {
          include: {
            productCatalog: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
      take: safeLimit,
    }),
    prisma.warehouseOperationDocument.findMany({
      where: { orgId, warehouseSiteId: siteId },
      orderBy: { postedAt: 'desc' },
      take: safeLimit,
    }),
    prisma.warehouseOutbox.findMany({
      where: { orgId, warehouseSiteId: siteId },
      orderBy: [{ createdAt: 'desc' }],
      take: safeLimit,
      select: {
        id: true,
        aggregateType: true,
        aggregateId: true,
        eventType: true,
        status: true,
        retryCount: true,
        lastError: true,
        createdAt: true,
        processedAt: true,
      },
    }),
    prisma.warehouseProjectionInbox.findMany({
      where: { orgId, warehouseSiteId: siteId },
      orderBy: { processedAt: 'desc' },
      take: safeLimit,
      select: {
        id: true,
        consumer: true,
        eventId: true,
        status: true,
        processedAt: true,
      },
    }),
    prisma.warehouseTask.findMany({
      where: { orgId, warehouseSiteId: siteId },
      orderBy: { updatedAt: 'desc' },
      take: safeLimit,
      select: {
        id: true,
        taskType: true,
        status: true,
        title: true,
        assigneeName: true,
        updatedAt: true,
      },
    }),
    prisma.warehouseException.findMany({
      where: { orgId, warehouseSiteId: siteId },
      orderBy: { updatedAt: 'desc' },
      take: safeLimit,
      select: {
        id: true,
        exceptionType: true,
        status: true,
        title: true,
        ownerName: true,
        updatedAt: true,
      },
    }),
  ]);

  const events = [
    ...reservations.map((reservation) => ({
      id: `reservation:${reservation.id}`,
      kind: 'reservation',
      status: reservation.status,
      eventType: `reservation.${reservation.status}`,
      title: `Reservation ${reservation.status}`,
      description:
        `${reservation.variant.productCatalog?.name ?? reservation.variant.variantKey} · qty ${reservation.qtyReserved} · ${reservation.sourceType}`,
      occurredAt: reservation.updatedAt.toISOString(),
      createdAt: reservation.updatedAt.toISOString(),
      referenceId: reservation.id,
      aggregateId: reservation.id,
      aggregateType: 'warehouse.reservation',
    })),
    ...documents.map((document) => ({
      id: `document:${document.id}`,
      kind: 'document',
      status: document.status,
      eventType: `document.${document.documentType}`,
      title: document.documentType === 'shipment' ? 'Shipment posted' : 'Handoff posted',
      description: document.referenceNo ?? document.orderId ?? document.documentType,
      occurredAt: document.postedAt.toISOString(),
      createdAt: document.postedAt.toISOString(),
      referenceId: document.id,
      aggregateId: document.id,
      aggregateType: 'warehouse.document',
    })),
    ...tasks.map((task) => ({
      id: `task:${task.id}`,
      kind: 'task',
      status: task.status,
      eventType: `task.${task.status}`,
      title: task.title,
      description: `${task.taskType} · ${task.assigneeName ?? 'unassigned'}`,
      occurredAt: task.updatedAt.toISOString(),
      createdAt: task.updatedAt.toISOString(),
      referenceId: task.id,
      aggregateId: task.id,
      aggregateType: 'warehouse.task',
    })),
    ...exceptions.map((item) => ({
      id: `exception:${item.id}`,
      kind: 'exception',
      status: item.status,
      eventType: `exception.${item.status}`,
      title: item.title,
      description: `${item.exceptionType} · ${item.ownerName ?? 'ownerless'}`,
      occurredAt: item.updatedAt.toISOString(),
      createdAt: item.updatedAt.toISOString(),
      referenceId: item.id,
      aggregateId: item.id,
      aggregateType: 'warehouse.exception',
    })),
    ...outbox.map((row) => ({
      id: `outbox:${row.id}`,
      kind: 'outbox',
      status: row.status,
      eventType: row.eventType,
      title: row.eventType,
      description:
        row.lastError
          ? `retry ${row.retryCount} · ${row.lastError}`
          : `${row.aggregateType} · ${row.aggregateId.slice(0, 8)}`,
      occurredAt: (row.processedAt ?? row.createdAt).toISOString(),
      createdAt: (row.processedAt ?? row.createdAt).toISOString(),
      referenceId: row.id,
      aggregateId: row.aggregateId,
      aggregateType: row.aggregateType,
    })),
    ...inbox.map((row) => ({
      id: `inbox:${row.id}`,
      kind: 'projection',
      status: row.status,
      eventType: `projection.${row.consumer}`,
      title: row.consumer,
      description: `Processed event ${row.eventId.slice(0, 8)}`,
      occurredAt: row.processedAt.toISOString(),
      createdAt: row.processedAt.toISOString(),
      referenceId: row.id,
      aggregateId: row.eventId,
      aggregateType: 'warehouse.projection',
    })),
  ]
    .sort((left, right) => new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime())
    .slice(0, safeLimit);

  return {
    site,
    count: events.length,
    results: events,
  };
}

export async function getSiteHealthSnapshot(orgId: string, siteId: string) {
  const site = await prisma.warehouseSite.findFirst({
    where: { id: siteId, orgId },
    select: {
      id: true,
      code: true,
      name: true,
      _count: {
        select: {
          zones: true,
          bins: true,
          layoutVersions: true,
        },
      },
    },
  });

  if (!site) {
    throw new AppError(404, 'Склад не найден', 'NOT_FOUND');
  }

  const [
    balanceTotals,
    balanceRows,
    variantsWithStock,
    reservationBuckets,
    documentBuckets,
    outboxBuckets,
    lastDocument,
  ] = await Promise.all([
    prisma.warehouseStockBalance.aggregate({
      where: { orgId, warehouseSiteId: siteId },
      _sum: {
        qtyOnHand: true,
        qtyReserved: true,
        qtyAvailable: true,
      },
    }),
    prisma.warehouseStockBalance.count({
      where: { orgId, warehouseSiteId: siteId },
    }),
    prisma.warehouseStockBalance.groupBy({
      by: ['variantId'],
      where: { orgId, warehouseSiteId: siteId, qtyOnHand: { gt: 0 } },
    }),
    prisma.warehouseStockReservation.groupBy({
      by: ['status'],
      where: { orgId, warehouseSiteId: siteId },
      _count: { status: true },
    }),
    prisma.warehouseOperationDocument.groupBy({
      by: ['documentType'],
      where: { orgId, warehouseSiteId: siteId },
      _count: { documentType: true },
    }),
    prisma.warehouseOutbox.groupBy({
      by: ['status'],
      where: { orgId, warehouseSiteId: siteId },
      _count: { status: true },
    }),
    prisma.warehouseOperationDocument.findFirst({
      where: { orgId, warehouseSiteId: siteId },
      orderBy: { postedAt: 'desc' },
      select: {
        id: true,
        documentType: true,
        status: true,
        postedAt: true,
        referenceNo: true,
      },
    }),
  ]);

  const reservationSummary = {
    active: 0,
    consumed: 0,
    released: 0,
  };

  for (const bucket of reservationBuckets) {
    if (bucket.status === 'active') reservationSummary.active = bucket._count.status;
    if (bucket.status === 'consumed') reservationSummary.consumed = bucket._count.status;
    if (bucket.status === 'released') reservationSummary.released = bucket._count.status;
  }

  const documentSummary = {
    total: documentBuckets.reduce((sum, bucket) => sum + bucket._count.documentType, 0),
    handoffs: 0,
    shipments: 0,
  };

  for (const bucket of documentBuckets) {
    if (bucket.documentType === 'handoff_to_warehouse') documentSummary.handoffs = bucket._count.documentType;
    if (bucket.documentType === 'shipment') documentSummary.shipments = bucket._count.documentType;
  }

  const outboxSummary = {
    pending: 0,
    processing: 0,
    processed: 0,
    failed: 0,
  };

  for (const bucket of outboxBuckets) {
    if (bucket.status === 'pending') outboxSummary.pending = bucket._count.status;
    if (bucket.status === 'processing') outboxSummary.processing = bucket._count.status;
    if (bucket.status === 'processed') outboxSummary.processed = bucket._count.status;
    if (bucket.status === 'failed') outboxSummary.failed = bucket._count.status;
  }

  return {
    site,
    structure: {
      zones: site._count.zones,
      bins: site._count.bins,
      layoutVersions: site._count.layoutVersions,
    },
    inventory: {
      balanceRows,
      variantsWithStock: variantsWithStock.length,
      qtyOnHand: balanceTotals._sum.qtyOnHand ?? 0,
      qtyReserved: balanceTotals._sum.qtyReserved ?? 0,
      qtyAvailable: balanceTotals._sum.qtyAvailable ?? 0,
    },
    operations: {
      reservations: reservationSummary,
      documents: documentSummary,
      lastDocument,
    },
    realtime: outboxSummary,
  };
}

export async function buildWarehouseSiteSnapshot(db: Tx, orgId: string, siteId: string) {
  const site = await ensureWarehouseSiteAccess(db, orgId, siteId);

  if (!site) {
    throw new AppError(404, 'Склад не найден', 'NOT_FOUND');
  }

  const [
    structureCounts,
    zones,
    bins,
    balanceTotals,
    balanceRowCount,
    balanceRows,
    variantsWithStock,
    reservationBuckets,
    documentBuckets,
    outboxBuckets,
    topReservations,
    recentDocuments,
    recentOutbox,
    recentInbox,
    siteTasks,
    siteExceptions,
  ] = await Promise.all([
    db.warehouseSite.findFirst({
      where: { id: siteId, orgId },
      select: {
        _count: {
          select: {
            zones: true,
            bins: true,
            layoutVersions: true,
          },
        },
      },
    }),
    db.warehouseZone.findMany({
      where: { orgId, warehouseSiteId: siteId },
      select: {
        id: true,
        code: true,
        name: true,
        zoneType: true,
        status: true,
        _count: {
          select: {
            bins: true,
          },
        },
      },
      orderBy: [{ code: 'asc' }],
    }),
    db.warehouseBin.findMany({
      where: { orgId, warehouseSiteId: siteId },
      select: {
        id: true,
        code: true,
        zoneId: true,
        status: true,
        binType: true,
        pickFaceEnabled: true,
        capacityUnits: true,
        zone: {
          select: {
            id: true,
            code: true,
            name: true,
            zoneType: true,
          },
        },
      },
      orderBy: [{ code: 'asc' }],
    }),
    db.warehouseStockBalance.aggregate({
      where: { orgId, warehouseSiteId: siteId },
      _sum: {
        qtyOnHand: true,
        qtyReserved: true,
        qtyAvailable: true,
      },
    }),
    db.warehouseStockBalance.count({
      where: { orgId, warehouseSiteId: siteId },
    }),
    db.warehouseStockBalance.findMany({
      where: {
        orgId,
        warehouseSiteId: siteId,
        OR: [
          { qtyOnHand: { gt: 0 } },
          { qtyReserved: { gt: 0 } },
          { qtyAvailable: { gt: 0 } },
        ],
      },
      select: {
        binId: true,
        qtyOnHand: true,
        qtyReserved: true,
        qtyAvailable: true,
        variant: {
          select: {
            variantKey: true,
            attributesSummary: true,
            productCatalog: {
              select: {
                name: true,
              },
            },
          },
        },
      },
    }),
    db.warehouseStockBalance.groupBy({
      by: ['variantId'],
      where: { orgId, warehouseSiteId: siteId, qtyOnHand: { gt: 0 } },
    }),
    db.warehouseStockReservation.groupBy({
      by: ['status'],
      where: { orgId, warehouseSiteId: siteId },
      _count: { status: true },
    }),
    db.warehouseOperationDocument.groupBy({
      by: ['documentType'],
      where: { orgId, warehouseSiteId: siteId },
      _count: { documentType: true },
    }),
    db.warehouseOutbox.groupBy({
      by: ['status'],
      where: { orgId, warehouseSiteId: siteId },
      _count: { status: true },
    }),
    db.warehouseStockReservation.findMany({
      where: { orgId, warehouseSiteId: siteId },
      include: {
        variant: {
          include: {
            productCatalog: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
        allocations: {
          include: {
            bin: {
              select: {
                id: true,
                code: true,
              },
            },
          },
        },
      },
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
      take: 5,
    }),
    db.warehouseOperationDocument.findMany({
      where: { orgId, warehouseSiteId: siteId },
      include: {
        site: {
          select: {
            id: true,
            code: true,
            name: true,
          },
        },
      },
      orderBy: { postedAt: 'desc' },
      take: 5,
    }),
    db.warehouseOutbox.findMany({
      where: { orgId, warehouseSiteId: siteId },
      orderBy: [{ createdAt: 'desc' }],
      take: 8,
      select: {
        id: true,
        aggregateType: true,
        aggregateId: true,
        eventType: true,
        status: true,
        retryCount: true,
        lastError: true,
        createdAt: true,
        processedAt: true,
      },
    }),
    db.warehouseProjectionInbox.findMany({
      where: { orgId, warehouseSiteId: siteId },
      orderBy: { processedAt: 'desc' },
      take: 8,
      select: {
        id: true,
        consumer: true,
        eventId: true,
        status: true,
        processedAt: true,
      },
    }),
    db.warehouseTask.findMany({
      where: {
        orgId,
        warehouseSiteId: siteId,
        status: {
          notIn: ['completed', 'cancelled'],
        },
      },
      orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
      take: 24,
      include: {
        zone: {
          select: { id: true, code: true, name: true },
        },
        bin: {
          select: { id: true, code: true },
        },
        sourceBin: {
          select: { id: true, code: true },
        },
        targetBin: {
          select: { id: true, code: true },
        },
        variant: {
          include: {
            productCatalog: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
    }),
    db.warehouseException.findMany({
      where: {
        orgId,
        warehouseSiteId: siteId,
        status: {
          not: 'resolved',
        },
      },
      orderBy: [{ severity: 'desc' }, { updatedAt: 'desc' }],
      take: 24,
      include: {
        zone: {
          select: { id: true, code: true, name: true },
        },
        bin: {
          select: { id: true, code: true },
        },
        task: {
          select: { id: true, title: true, taskType: true, status: true },
        },
      },
    }),
  ]);

  const reservationSummary = {
    active: 0,
    consumed: 0,
    released: 0,
  };

  for (const bucket of reservationBuckets) {
    if (bucket.status === 'active') reservationSummary.active = bucket._count.status;
    if (bucket.status === 'consumed') reservationSummary.consumed = bucket._count.status;
    if (bucket.status === 'released') reservationSummary.released = bucket._count.status;
  }

  const documentSummary = {
    total: documentBuckets.reduce((sum, bucket) => sum + bucket._count.documentType, 0),
    handoffs: 0,
    shipments: 0,
  };

  for (const bucket of documentBuckets) {
    if (bucket.documentType === 'handoff_to_warehouse') documentSummary.handoffs = bucket._count.documentType;
    if (bucket.documentType === 'shipment') documentSummary.shipments = bucket._count.documentType;
  }

  const realtimeSummary = {
    pending: 0,
    processing: 0,
    processed: 0,
    failed: 0,
  };

  for (const bucket of outboxBuckets) {
    if (bucket.status === 'pending') realtimeSummary.pending = bucket._count.status;
    if (bucket.status === 'processing') realtimeSummary.processing = bucket._count.status;
    if (bucket.status === 'processed') realtimeSummary.processed = bucket._count.status;
    if (bucket.status === 'failed') realtimeSummary.failed = bucket._count.status;
  }

  const recentFeed = [
    ...topReservations.map((reservation) => ({
      id: `reservation:${reservation.id}`,
      kind: 'reservation',
      status: reservation.status,
      eventType: `reservation.${reservation.status}`,
      title: `Reservation ${reservation.status}`,
      description:
        `${reservation.variant.productCatalog?.name ?? reservation.variant.variantKey} · qty ${reservation.qtyReserved} · ${reservation.sourceType}`,
      occurredAt: reservation.updatedAt.toISOString(),
      createdAt: reservation.updatedAt.toISOString(),
      referenceId: reservation.id,
      aggregateId: reservation.id,
      aggregateType: 'warehouse.reservation',
    })),
    ...recentDocuments.map((document) => ({
      id: `document:${document.id}`,
      kind: 'document',
      status: document.status,
      eventType: `document.${document.documentType}`,
      title: document.documentType === 'shipment' ? 'Shipment posted' : 'Handoff posted',
      description: document.referenceNo ?? document.orderId ?? document.documentType,
      occurredAt: document.postedAt.toISOString(),
      createdAt: document.postedAt.toISOString(),
      referenceId: document.id,
      aggregateId: document.id,
      aggregateType: 'warehouse.document',
    })),
    ...siteTasks.slice(0, 6).map((task) => ({
      id: `task:${task.id}`,
      kind: 'projection',
      status: task.status,
      eventType: `task.${task.taskType}`,
      title: task.title,
      description: task.description ?? task.taskType,
      occurredAt: task.updatedAt.toISOString(),
      createdAt: task.updatedAt.toISOString(),
      referenceId: task.id,
      aggregateId: task.id,
      aggregateType: 'warehouse.task',
    })),
    ...siteExceptions.slice(0, 6).map((item) => ({
      id: `exception:${item.id}`,
      kind: 'projection',
      status: item.status,
      eventType: `exception.${item.exceptionType}`,
      title: item.title,
      description: item.description ?? item.exceptionType,
      occurredAt: item.updatedAt.toISOString(),
      createdAt: item.updatedAt.toISOString(),
      referenceId: item.id,
      aggregateId: item.id,
      aggregateType: 'warehouse.exception',
    })),
    ...recentOutbox.map((row) => ({
      id: `outbox:${row.id}`,
      kind: 'outbox',
      status: row.status,
      eventType: row.eventType,
      title: row.eventType,
      description:
        row.lastError
          ? `retry ${row.retryCount} · ${row.lastError}`
          : `${row.aggregateType} · ${row.aggregateId.slice(0, 8)}`,
      occurredAt: (row.processedAt ?? row.createdAt).toISOString(),
      createdAt: (row.processedAt ?? row.createdAt).toISOString(),
      referenceId: row.id,
      aggregateId: row.aggregateId,
      aggregateType: row.aggregateType,
    })),
    ...recentInbox.map((row) => ({
      id: `inbox:${row.id}`,
      kind: 'projection',
      status: row.status,
      eventType: `projection.${row.consumer}`,
      title: row.consumer,
      description: `Processed event ${row.eventId.slice(0, 8)}`,
      occurredAt: row.processedAt.toISOString(),
      createdAt: row.processedAt.toISOString(),
      referenceId: row.id,
      aggregateId: row.eventId,
      aggregateType: 'warehouse.projection',
    })),
  ]
    .sort((left, right) => new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime())
    .slice(0, 8);

  const structure = {
    zones: structureCounts?._count.zones ?? 0,
    bins: structureCounts?._count.bins ?? 0,
    layoutVersions: structureCounts?._count.layoutVersions ?? 0,
  };

  const inventory = {
    balanceRows: balanceRowCount,
    variantsWithStock: variantsWithStock.length,
    qtyOnHand: balanceTotals._sum.qtyOnHand ?? 0,
    qtyReserved: balanceTotals._sum.qtyReserved ?? 0,
    qtyAvailable: balanceTotals._sum.qtyAvailable ?? 0,
  };

  const operationalPressure = buildOperationalPressureModel({
    zones,
    bins,
    balanceRows,
    reservationSummary,
  });
  const overdueTasks = siteTasks.filter((task) => task.slaStatus === 'breached').length;
  const unassignedTasks = siteTasks.filter((task) => !task.assigneeName && !['completed', 'cancelled'].includes(task.status)).length;
  const ownedExceptions = siteExceptions.filter((item) => Boolean(item.ownerName)).length;
  const breachedExceptions = siteExceptions.filter((item) => item.slaStatus === 'breached').length;
  const taskSummary = {
    queued: siteTasks.length,
    active: siteTasks.filter((task) => ['accepted', 'in_progress', 'paused'].includes(task.status)).length,
    blocked: siteExceptions.filter((item) => item.severity === 'critical').length,
    assigned: siteTasks.filter((task) => Boolean(task.assigneeName)).length,
    overdue: overdueTasks,
  };
  const exceptionSummary = {
    open: siteExceptions.length,
    critical: siteExceptions.filter((item) => item.severity === 'critical').length,
    owned: ownedExceptions,
    breached: breachedExceptions,
  };
  const replenishmentTasks = siteTasks.filter((task) => task.taskType === 'replenishment');
  const replenishmentSummary = {
    candidateBins: replenishmentTasks.length,
    urgentBins: replenishmentTasks.filter((task) => task.priority === 'high').length,
    urgentZones: new Set(replenishmentTasks.map((task) => task.zoneId).filter(Boolean)).size,
  };
  const pickCount = siteTasks.filter((task) => task.taskType === 'pick').length;
  const putawayCount = siteTasks.filter((task) => task.taskType === 'putaway').length;
  const taskQueues = [
    {
      id: 'pick',
      label: 'Pick pressure',
      queueType: 'pick',
      count: pickCount,
      level: pickCount > 0 ? 'warning' : 'info',
      description: 'Real warehouse pick tasks materialized from active reservations.',
      href: '/warehouse/twin#routes-panel',
    },
    {
      id: 'putaway',
      label: 'Putaway backlog',
      queueType: 'putaway',
      count: putawayCount,
      level: putawayCount > 0 ? 'warning' : 'info',
      description: 'Inbound stock waiting to move from receiving or staging into storage.',
      href: '/warehouse/twin#routes-panel',
    },
    {
      id: 'replenishment',
      label: 'Replenishment queue',
      queueType: 'replenishment',
      count: replenishmentSummary.candidateBins,
      level: replenishmentSummary.urgentBins > 0 ? 'critical' : (replenishmentSummary.candidateBins > 0 ? 'warning' : 'info'),
      description: 'Real replenishment tasks targeting low-buffer pick-face bins.',
      href: '/warehouse/twin#routes-panel',
    },
    {
      id: 'exception',
      label: 'Exception queue',
      queueType: 'exception',
      count: exceptionSummary.open,
      level: exceptionSummary.critical > 0 ? 'critical' : (exceptionSummary.open > 0 ? 'warning' : 'info'),
      description: 'Open warehouse exceptions requiring acknowledgement or resolution.',
      href: '/warehouse/control-tower#exceptions-panel',
    },
  ];
  const exceptionList = siteExceptions.slice(0, 8).map((item) => ({
    id: item.id,
    level: item.severity as SiteControlLevel,
    category: item.exceptionType,
    title: item.title,
    description: item.description ?? item.exceptionType,
    zoneId: item.zoneId ?? undefined,
    zoneCode: item.zone?.code ?? undefined,
    binId: item.binId ?? undefined,
    binCode: item.bin?.code ?? undefined,
    href: '/warehouse/control-tower#exceptions-panel',
  }));
  const replenishmentHotspots = replenishmentTasks.slice(0, 8).map((task) => ({
    id: task.id,
    binId: task.targetBinId ?? task.binId ?? '',
    binCode: task.targetBin?.code ?? task.bin?.code ?? 'BIN',
    zoneId: task.zoneId ?? '',
    zoneCode: task.zone?.code ?? 'ZONE',
    zoneName: task.zone?.name ?? 'Zone',
    level: (task.priority === 'high' ? 'critical' : 'warning') as SiteControlLevel,
    qtyAvailable: Number((asRecord(task.metadataJson).qtyAvailable as number | undefined) ?? 0),
    qtyReserved: Number((asRecord(task.metadataJson).qtyReserved as number | undefined) ?? 0),
    capacityUnits: null,
    primaryVariantLabel: task.variant?.productCatalog?.name ?? task.variant?.variantKey ?? null,
  }));

  const alerts = buildSiteControlAlerts({
    zones: structure.zones,
    bins: structure.bins,
    qtyAvailable: inventory.qtyAvailable,
    qtyReserved: inventory.qtyReserved,
    activeReservations: reservationSummary.active,
    queuedTasks: taskSummary.queued,
    overdueTasks,
    unassignedTasks,
    openExceptions: exceptionSummary.open,
    criticalExceptions: exceptionSummary.critical,
    ownerlessExceptions: Math.max(siteExceptions.length - ownedExceptions, 0),
    breachedExceptions,
    urgentReplenishment: replenishmentSummary.urgentBins,
    failedOutbox: realtimeSummary.failed,
    pendingOutbox: realtimeSummary.pending,
  });
  const alertClasses = buildSiteAlertClasses(alerts);
  const actionableCounters = buildSiteActionableCounters({
    qtyAvailable: inventory.qtyAvailable,
    qtyReserved: inventory.qtyReserved,
    activeReservations: reservationSummary.active,
    queuedTasks: taskSummary.queued,
    overdueTasks,
    unassignedTasks,
    openExceptions: exceptionSummary.open,
    criticalExceptions: exceptionSummary.critical,
    ownerlessExceptions: Math.max(siteExceptions.length - ownedExceptions, 0),
    breachedExceptions,
    replenishmentCandidates: replenishmentSummary.candidateBins,
    urgentReplenishment: replenishmentSummary.urgentBins,
    pendingOutbox: realtimeSummary.pending,
    failedOutbox: realtimeSummary.failed,
  });
  const actionCards = buildSiteActionCards({
    zones: structure.zones,
    bins: structure.bins,
    qtyAvailable: inventory.qtyAvailable,
    activeReservations: reservationSummary.active,
    queuedTasks: taskSummary.queued,
    pickQueue: pickCount,
    putawayQueue: putawayCount,
    overdueTasks,
    unassignedTasks,
    openExceptions: exceptionSummary.open,
    criticalExceptions: exceptionSummary.critical,
    ownerlessExceptions: Math.max(siteExceptions.length - ownedExceptions, 0),
    breachedExceptions,
    replenishmentCandidates: replenishmentSummary.candidateBins,
    urgentReplenishment: replenishmentSummary.urgentBins,
    pendingOutbox: realtimeSummary.pending,
    failedOutbox: realtimeSummary.failed,
  });

  const healthScore = Math.max(0, 100
    - (realtimeSummary.failed > 0 ? 35 : 0)
    - (realtimeSummary.pending >= 10 ? 15 : 0)
    - (reservationSummary.active > 0 && inventory.qtyAvailable <= 0 ? 30 : 0)
    - (exceptionSummary.critical > 0 ? 20 : 0)
    - (breachedExceptions > 0 ? 10 : 0)
    - (overdueTasks > 0 ? 10 : 0)
    - (replenishmentSummary.urgentBins >= 3 ? 10 : 0)
    - (structure.zones === 0 || structure.bins === 0 ? 20 : 0));

  return {
    site,
    refreshedAt: new Date().toISOString(),
    healthScore,
    structure,
    inventory,
    operations: {
      reservations: reservationSummary,
      documents: documentSummary,
      realtime: realtimeSummary,
      tasks: taskSummary,
      exceptions: exceptionSummary,
      replenishment: replenishmentSummary,
    },
    alerts,
    alertClasses,
    actionableCounters,
    actionCards,
    taskQueues,
    exceptions: exceptionList,
    replenishmentHotspots,
    siteMap: operationalPressure.siteMap,
    topReservations,
    recentDocuments,
    recentFeed,
  };
}

export async function refreshWarehouseSiteReadModel(
  orgId: string,
  siteId: string,
  tx?: Tx,
  lastEvent?: { id?: string | null; type?: string | null },
) {
  const db = tx ?? prisma;
  await syncWarehouseOperationalState(orgId, siteId, db);
  const snapshot = await buildWarehouseSiteSnapshot(db, orgId, siteId);
  const now = new Date();

  await db.warehouseSiteReadModel.upsert({
    where: {
      orgId_warehouseSiteId: {
        orgId,
        warehouseSiteId: siteId,
      },
    },
    create: {
      orgId,
      warehouseSiteId: siteId,
      snapshotJson: snapshot as Prisma.InputJsonValue,
      status: 'fresh',
      lastEventId: lastEvent?.id ?? null,
      lastEventType: lastEvent?.type ?? null,
      refreshedAt: now,
    },
    update: {
      snapshotJson: snapshot as Prisma.InputJsonValue,
      status: 'fresh',
      lastEventId: lastEvent?.id ?? null,
      lastEventType: lastEvent?.type ?? null,
      refreshedAt: now,
    },
  });

  return snapshot;
}

export async function getWarehouseSiteControlTower(orgId: string, siteId: string) {
  return refreshWarehouseSiteReadModel(orgId, siteId);
}

export async function getWarehouseSiteLiveSnapshot(orgId: string, siteId: string, feedLimit = 12) {
  const [controlTower, siteFeed, siteHealth] = await Promise.all([
    getWarehouseSiteControlTower(orgId, siteId),
    getSiteFeed(orgId, siteId, feedLimit),
    getSiteHealthSnapshot(orgId, siteId),
  ]);

  return {
    siteId,
    generatedAt: new Date().toISOString(),
    controlTower,
    siteFeed,
    siteHealth,
  };
}

export async function getOutboxRuntimeStatus(orgId: string) {
  const [statusBuckets, recentOutbox, recentInbox] = await Promise.all([
    prisma.warehouseOutbox.groupBy({
      by: ['status'],
      where: { orgId },
      _count: { status: true },
    }),
    prisma.warehouseOutbox.findMany({
      where: { orgId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        aggregateType: true,
        aggregateId: true,
        eventType: true,
        status: true,
        retryCount: true,
        lastError: true,
        availableAt: true,
        processedAt: true,
        createdAt: true,
        warehouseSiteId: true,
      },
    }),
    prisma.warehouseProjectionInbox.findMany({
      where: { orgId },
      orderBy: { processedAt: 'desc' },
      take: 20,
      select: {
        id: true,
        consumer: true,
        eventId: true,
        status: true,
        processedAt: true,
        warehouseSiteId: true,
      },
    }),
  ]);

  const summary = {
    pending: 0,
    processing: 0,
    processed: 0,
    failed: 0,
  };

  for (const bucket of statusBuckets) {
    if (bucket.status === 'pending') summary.pending = bucket._count.status;
    if (bucket.status === 'processing') summary.processing = bucket._count.status;
    if (bucket.status === 'processed') summary.processed = bucket._count.status;
    if (bucket.status === 'failed') summary.failed = bucket._count.status;
  }

  return {
    summary,
    recentOutbox,
    recentInbox,
  };
}

export async function buildWarehouseOrderSnapshot(db: Tx, orgId: string, orderId: string) {
  const order = await db.chapanOrder.findFirst({
    where: { id: orderId, orgId },
    include: {
      items: true,
    },
  });

  if (!order) {
    throw new AppError(404, 'Заказ не найден', 'NOT_FOUND');
  }

  const [reservations, documents] = await Promise.all([
    db.warehouseStockReservation.findMany({
      where: {
        orgId,
        sourceType: 'chapan_order_item',
        sourceId: orderId,
      },
      include: {
        site: {
          select: {
            id: true,
            code: true,
            name: true,
          },
        },
        variant: {
          include: {
            productCatalog: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
        allocations: {
          include: {
            bin: {
              select: {
                id: true,
                code: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    }),
    db.warehouseOperationDocument.findMany({
      where: {
        orgId,
        orderId,
      },
      include: {
        site: {
          select: {
            id: true,
            code: true,
            name: true,
          },
        },
      },
      orderBy: { postedAt: 'asc' },
    }),
  ]);

  const globalSite =
    reservations[0]?.site
    ?? documents[0]?.site
    ?? await resolveWarehouseSiteForOrder(db, orgId, orderId);

  const reservationSummary = {
    total: reservations.length,
    active: reservations.filter((row) => row.status === 'active').length,
    consumed: reservations.filter((row) => row.status === 'consumed').length,
    released: reservations.filter((row) => row.status === 'released').length,
    qtyReserved: reservations.reduce((sum, row) => sum + row.qtyReserved, 0),
  };

  const documentSummary = {
    total: documents.length,
    handoff: documents.filter((row) => row.documentType === 'handoff_to_warehouse').length,
    shipment: documents.filter((row) => row.documentType === 'shipment').length,
  };

  const items = order.items
    .filter((item) => item.fulfillmentMode === 'warehouse' || reservations.some((row) => row.sourceLineId === item.id))
    .map((item) => {
      const itemReservations = reservations.filter((row) => row.sourceLineId === item.id);
      const latestReservation = itemReservations[itemReservations.length - 1] ?? null;
      const binCodes = [...new Set(
        itemReservations.flatMap((row) => row.allocations.map((allocation) => allocation.bin.code)),
      )];

      return {
        orderItemId: item.id,
        productName: item.productName,
        quantity: item.quantity,
        fulfillmentMode: item.fulfillmentMode,
        variantKey: latestReservation?.variant.variantKey ?? item.variantKey ?? null,
        attributesSummary: latestReservation?.variant.attributesSummary ?? item.attributesSummary ?? null,
        reservationId: latestReservation?.id ?? null,
        reservationStatus: latestReservation?.status ?? 'missing',
        qtyReserved: latestReservation?.qtyReserved ?? 0,
        site: latestReservation?.site ?? globalSite ?? null,
        binCodes,
      };
    });

  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    orderStatus: order.status,
    site: globalSite ?? null,
    reservationSummary,
    documentSummary,
    documents: documents.map((document) => ({
      id: document.id,
      documentType: document.documentType,
      status: document.status,
      referenceNo: document.referenceNo,
      postedAt: document.postedAt,
      site: document.site,
    })),
    items,
  };
}

export async function refreshWarehouseOrderReadModel(
  orgId: string,
  orderId: string,
  tx?: Tx,
  lastEvent?: { id?: string | null; type?: string | null },
) {
  const db = tx ?? prisma;
  const snapshot = await buildWarehouseOrderSnapshot(db, orgId, orderId);
  const siteId = snapshot.site?.id ?? null;
  const now = new Date();

  await db.warehouseOrderReadModel.upsert({
    where: {
      orgId_orderId: {
        orgId,
        orderId,
      },
    },
    create: {
      orgId,
      orderId,
      warehouseSiteId: siteId,
      snapshotJson: snapshot as Prisma.InputJsonValue,
      status: 'fresh',
      lastEventId: lastEvent?.id ?? null,
      lastEventType: lastEvent?.type ?? null,
      refreshedAt: now,
    },
    update: {
      warehouseSiteId: siteId,
      snapshotJson: snapshot as Prisma.InputJsonValue,
      status: 'fresh',
      lastEventId: lastEvent?.id ?? null,
      lastEventType: lastEvent?.type ?? null,
      refreshedAt: now,
    },
  });

  return snapshot;
}

export async function getWarehouseOrderState(orgId: string, orderId: string) {
  const existing = await prisma.warehouseOrderReadModel.findFirst({
    where: {
      orgId,
      orderId,
    },
    select: {
      snapshotJson: true,
    },
  });

  if (existing?.snapshotJson) {
    return asRecord(existing.snapshotJson);
  }

  return refreshWarehouseOrderReadModel(orgId, orderId);
}

export async function getWarehouseOrderStates(orgId: string, orderIds: string[]) {
  const uniqueOrderIds = [...new Set(orderIds.map((id) => id.trim()).filter(Boolean))];

  if (!uniqueOrderIds.length) {
    return [];
  }

  const existing = await prisma.warehouseOrderReadModel.findMany({
    where: {
      orgId,
      orderId: { in: uniqueOrderIds },
    },
    select: {
      orderId: true,
      snapshotJson: true,
    },
  });

  const snapshotMap = new Map<string, Record<string, unknown>>();

  for (const row of existing) {
    if (row.snapshotJson) {
      snapshotMap.set(row.orderId, asRecord(row.snapshotJson));
    }
  }

  const missingIds = uniqueOrderIds.filter((orderId) => !snapshotMap.has(orderId));

  if (missingIds.length) {
    const refreshed = await Promise.all(
      missingIds.map(async (orderId) => ({
        orderId,
        snapshot: await refreshWarehouseOrderReadModel(orgId, orderId),
      })),
    );

    for (const row of refreshed) {
      snapshotMap.set(row.orderId, row.snapshot);
    }
  }

  return uniqueOrderIds
    .map((orderId) => snapshotMap.get(orderId))
    .filter((snapshot): snapshot is Record<string, unknown> => Boolean(snapshot));
}

export async function getWarehouseOrderLiveSnapshot(orgId: string, orderId: string) {
  const warehouseState = await getWarehouseOrderState(orgId, orderId);

  return {
    orderId,
    generatedAt: new Date().toISOString(),
    warehouseState,
  };
}

async function ensureProjectionInboxRecord(
  tx: Prisma.TransactionClient,
  input: {
    orgId: string;
    warehouseSiteId?: string | null;
    consumer: string;
    eventId: string;
    payload: Prisma.JsonValue;
  },
) {
  const existingInbox = await tx.warehouseProjectionInbox.findFirst({
    where: {
      orgId: input.orgId,
      consumer: input.consumer,
      eventId: input.eventId,
    },
    select: { id: true },
  });

  if (existingInbox) {
    return existingInbox;
  }

  return tx.warehouseProjectionInbox.create({
    data: {
      orgId: input.orgId,
      warehouseSiteId: input.warehouseSiteId ?? null,
      consumer: input.consumer,
      eventId: input.eventId,
      status: 'processed',
      payloadHash: jsonHash(input.payload),
      processedAt: new Date(),
    },
    select: { id: true },
  });
}

export async function processWarehouseOutboxRecord(recordId: string) {
  const orderConsumer = 'warehouse.order-read-model.v1';
  const siteConsumer = 'warehouse.site-read-model.v1';

  return prisma.$transaction(async (tx) => {
    const record = await tx.warehouseOutbox.findUnique({
      where: { id: recordId },
    });

    if (!record) {
      throw new AppError(404, 'Outbox record not found', 'NOT_FOUND');
    }

    const payload = asRecord(record.payload);
    const orderId = getOrderIdFromOutboxPayload(payload);

    if (orderId) {
      await ensureProjectionInboxRecord(tx, {
        orgId: record.orgId,
        warehouseSiteId: record.warehouseSiteId,
        consumer: orderConsumer,
        eventId: record.id,
        payload: record.payload,
      });

      await refreshWarehouseOrderReadModel(record.orgId, orderId, tx, {
        id: record.id,
        type: record.eventType,
      });
    }

    if (record.warehouseSiteId) {
      await ensureProjectionInboxRecord(tx, {
        orgId: record.orgId,
        warehouseSiteId: record.warehouseSiteId,
        consumer: siteConsumer,
        eventId: record.id,
        payload: record.payload,
      });

      await refreshWarehouseSiteReadModel(record.orgId, record.warehouseSiteId, tx, {
        id: record.id,
        type: record.eventType,
      });
    }

    await tx.warehouseOutbox.update({
      where: { id: record.id },
      data: {
        status: 'processed',
        processedAt: new Date(),
        lastError: null,
      },
    });

    return {
      recordId: record.id,
      orderId,
      warehouseSiteId: record.warehouseSiteId,
      consumers: [orderId ? orderConsumer : null, record.warehouseSiteId ? siteConsumer : null].filter(Boolean),
    };
  });
}
