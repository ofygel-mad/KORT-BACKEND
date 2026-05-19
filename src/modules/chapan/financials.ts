export interface ChapanOrderFinancialInput {
  itemsSubtotal: number;
  orderDiscount?: number | null;
  deliveryFee?: number | null;
  bankCommissionPercent?: number | null;
  bankCommissionAmount?: number | null;
}

export interface ChapanOrderFinancialSummary {
  itemsSubtotal: number;
  orderDiscount: number;
  discountedSubtotal: number;
  deliveryFee: number;
  bankCommissionPercent: number;
  bankCommissionAmount: number;
  totalDue: number;
}

function toSafeAmount(value: number | null | undefined) {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

export function calculateChapanOrderFinancials(input: ChapanOrderFinancialInput): ChapanOrderFinancialSummary {
  const itemsSubtotal = toSafeAmount(input.itemsSubtotal);
  const orderDiscount = toSafeAmount(input.orderDiscount);
  const deliveryFee = toSafeAmount(input.deliveryFee);
  const bankCommissionPercent = toSafeAmount(input.bankCommissionPercent);
  const manualBankCommissionAmount = toSafeAmount(input.bankCommissionAmount);

  const discountedSubtotal = Math.max(0, itemsSubtotal - orderDiscount);
  const bankCommissionAmount = bankCommissionPercent > 0
    ? Math.round(discountedSubtotal * bankCommissionPercent / 100)
    : manualBankCommissionAmount;
  const totalDue = Math.max(0, discountedSubtotal + deliveryFee + bankCommissionAmount);

  return {
    itemsSubtotal,
    orderDiscount,
    discountedSubtotal,
    deliveryFee,
    bankCommissionPercent,
    bankCommissionAmount,
    totalDue,
  };
}

export function getChapanOrderBalance(totalDue: number, paidAmount: number) {
  return Math.max(0, totalDue - Math.max(0, Number(paidAmount) || 0));
}
