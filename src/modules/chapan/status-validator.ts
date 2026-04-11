/**
 * Centralized order status transition validation
 * Ensures consistent state transitions across all Chapan modules
 */

import type { OrderStatus } from './types.js';

/**
 * Valid status transitions for Chapan orders
 * Maps from status -> allowed next statuses
 */
export const STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  new: ['confirmed', 'cancelled'],
  confirmed: ['in_production', 'on_warehouse', 'cancelled'],
  in_production: ['ready', 'cancelled'],
  ready: ['transferred', 'on_warehouse', 'cancelled'],
  transferred: ['on_warehouse', 'cancelled'],
  on_warehouse: ['shipped', 'ready', 'cancelled'],
  shipped: ['completed', 'cancelled'],
  completed: [],
  cancelled: ['ready'], // Allow un-cancellation back to ready
};

/**
 * Validate if a status transition is allowed
 */
export function validateStatusTransition(
  currentStatus: OrderStatus,
  targetStatus: OrderStatus,
): { valid: boolean; reason?: string } {
  // Can't transition if same status
  if (currentStatus === targetStatus) {
    return { valid: false, reason: `Already in status ${currentStatus}` };
  }

  // Can't transition from completed
  if (currentStatus === 'completed') {
    return { valid: false, reason: 'Cannot change completed orders' };
  }

  const allowedTransitions = STATUS_TRANSITIONS[currentStatus] ?? [];
  if (!allowedTransitions.includes(targetStatus)) {
    return {
      valid: false,
      reason: `Cannot transition from "${currentStatus}" to "${targetStatus}". Allowed: ${allowedTransitions.join(', ')}`,
    };
  }

  return { valid: true };
}

/**
 * Status-specific validation rules
 */
export function validateStatusTransitionRules(
  currentStatus: OrderStatus,
  targetStatus: OrderStatus,
  context: {
    hasProductionTasks?: boolean;
    productionTasksCompleted?: boolean;
    hasWarehouseItems?: boolean;
    requiresInvoice?: boolean;
    hasConfirmedInvoice?: boolean;
  },
): { valid: boolean; reason?: string } {
  const basicValidation = validateStatusTransition(currentStatus, targetStatus);
  if (!basicValidation.valid) {
    return basicValidation;
  }

  // Ready → on_warehouse: needs warehouse items and optionally a confirmed invoice
  if (currentStatus === 'ready' && targetStatus === 'on_warehouse') {
    if (!context.hasWarehouseItems) {
      return {
        valid: false,
        reason: 'Cannot advance order without warehouse items. Order must have items with warehouse fulfillment mode.',
      };
    }
    if (context.requiresInvoice && !context.hasConfirmedInvoice) {
      return {
        valid: false,
        reason: 'Invoice is required for this order. Please create and confirm invoice first.',
      };
    }
  }

  // in_production → ready: all production tasks must be completed
  if (currentStatus === 'in_production' && targetStatus === 'ready') {
    if (context.hasProductionTasks && !context.productionTasksCompleted) {
      return {
        valid: false,
        reason: 'All production tasks must be completed before marking order as ready',
      };
    }
  }

  return { valid: true };
}

/**
 * Check what transitions are available from current status
 */
export function getAvailableTransitions(status: OrderStatus): OrderStatus[] {
  return STATUS_TRANSITIONS[status] ?? [];
}

/**
 * Get user-friendly status labels
 */
export const STATUS_LABELS: Record<OrderStatus, string> = {
  new: 'Новый',
  confirmed: 'Подтверждён',
  in_production: 'В цехе',
  ready: 'Готово',
  transferred: 'Передан',
  on_warehouse: 'На складе',
  shipped: 'Отправлен',
  completed: 'Завершён',
  cancelled: 'Отменён',
};
