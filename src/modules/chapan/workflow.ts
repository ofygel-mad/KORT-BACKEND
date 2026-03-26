export type ProductionFlowStatus = 'queued' | 'in_progress' | 'done';

const LEGACY_STATUS_MAP: Record<string, ProductionFlowStatus> = {
  pending: 'queued',
  cutting: 'queued',
  sewing: 'in_progress',
  finishing: 'in_progress',
  quality_check: 'in_progress',
  queued: 'queued',
  in_progress: 'in_progress',
  done: 'done',
};

export function normalizeProductionStatus(status: string | null | undefined): ProductionFlowStatus {
  if (!status) return 'queued';
  return LEGACY_STATUS_MAP[status] ?? 'queued';
}

export function getProductionStatusLabel(status: string | null | undefined): string {
  const normalized = normalizeProductionStatus(status);

  if (normalized === 'queued') return 'Очередь';
  if (normalized === 'in_progress') return 'В работе';
  return 'Готово';
}

export function deriveOrderStatusFromTasks(statuses: Array<string | null | undefined>): 'confirmed' | 'in_production' | 'ready' {
  const normalized = statuses.map(normalizeProductionStatus);

  if (normalized.length > 0 && normalized.every((status) => status === 'done')) {
    return 'ready';
  }

  if (normalized.every((status) => status === 'queued')) {
    return 'confirmed';
  }

  return 'in_production';
}
