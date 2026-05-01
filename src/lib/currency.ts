const DEFAULT_ORG_CURRENCY = 'KZT';

const SUPPORTED_ORG_CURRENCIES = new Set([
  'KZT',
  'USD',
  'EUR',
  'CNY',
]);

const ORG_CURRENCY_LOCALES: Record<string, string> = {
  KZT: 'kk-KZ',
  USD: 'en-US',
  EUR: 'de-DE',
  CNY: 'zh-CN',
};

export function normalizeOrgCurrency(value: string | null | undefined): string {
  const currency = value?.trim().toUpperCase() ?? '';

  if (!currency) {
    return DEFAULT_ORG_CURRENCY;
  }

  return SUPPORTED_ORG_CURRENCIES.has(currency)
    ? currency
    : DEFAULT_ORG_CURRENCY;
}

export function normalizeOrgCurrencyInput(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const currency = value.trim();
  if (!currency) {
    return undefined;
  }

  return normalizeOrgCurrency(currency);
}

export function getOrgCurrencyLocale(value: string | null | undefined): string {
  const currency = normalizeOrgCurrency(value);
  return ORG_CURRENCY_LOCALES[currency] ?? 'kk-KZ';
}

export function getOrgCurrencySymbol(value: string | null | undefined): string {
  const currency = normalizeOrgCurrency(value);
  const locale = getOrgCurrencyLocale(currency);

  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })
    .formatToParts(0)
    .find((part) => part.type === 'currency')
    ?.value ?? currency;
}

export function formatOrgCurrencyAmount(amount: number, value: string | null | undefined): string {
  const currency = normalizeOrgCurrency(value);
  const locale = getOrgCurrencyLocale(currency);

  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}
