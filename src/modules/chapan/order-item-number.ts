const ORDER_ITEM_SUFFIX_RE = /^(.*-\d+)-(\d+)$/;

function trimOrderNumber(value: string): string {
  return value.trim().replace(/^#/, '').replace(/\s+/g, ' ');
}

export function stripOrderItemSuffix(orderNumber: string): string {
  const normalized = trimOrderNumber(orderNumber);
  const match = normalized.match(ORDER_ITEM_SUFFIX_RE);

  if (!match) {
    return normalized;
  }

  return match[1] ?? normalized;
}

export function formatOrderItemNumber(orderNumber: string, position?: number | null): string {
  const baseOrderNumber = stripOrderItemSuffix(orderNumber);
  const numericPosition = Number(position);

  if (Number.isFinite(numericPosition) && numericPosition > 0) {
    return `${baseOrderNumber}-${Math.trunc(numericPosition)}`;
  }

  return baseOrderNumber;
}

export function parseOrderItemNumber(orderItemNumber: string): { orderNumber: string; position: number | null } {
  const normalized = trimOrderNumber(orderItemNumber);
  const match = normalized.match(ORDER_ITEM_SUFFIX_RE);

  if (!match) {
    return { orderNumber: normalized, position: null };
  }

  const position = Number(match[2]);
  if (!Number.isFinite(position) || position <= 0) {
    return { orderNumber: normalized, position: null };
  }

  return {
    orderNumber: match[1] ?? normalized,
    position: Math.trunc(position),
  };
}

export function getNextOrderItemPosition(items: Array<{ position?: number | null }>): number {
  const maxPosition = items.reduce((max, item) => {
    const numericPosition = Number(item.position ?? 0);
    return Number.isFinite(numericPosition) && numericPosition > max ? numericPosition : max;
  }, 0);

  return maxPosition + 1;
}

export function sortOrderItemsByPosition<T extends { id: string; position?: number | null }>(items: T[]): T[] {
  return [...items].sort((left, right) => {
    const leftPosition = Number(left.position ?? 0);
    const rightPosition = Number(right.position ?? 0);

    if (leftPosition !== rightPosition) {
      return leftPosition - rightPosition;
    }

    return left.id.localeCompare(right.id);
  });
}
