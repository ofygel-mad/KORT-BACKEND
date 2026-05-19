const KASPI_API_BASE_URL = 'https://kaspi.kz/shop/api/v2';
const JSON_API_CONTENT_TYPE = 'application/vnd.api+json';
const KASPI_MAX_ORDER_RANGE_DAYS = 14;
const KASPI_REQUEST_TIMEOUT_MS = 20_000;

export type JsonApiResource = {
  id?: string;
  type?: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, unknown>;
  links?: Record<string, unknown>;
};

type JsonApiCollectionResponse = {
  data?: JsonApiResource[];
};

type JsonApiSingleResponse = {
  data?: JsonApiResource;
};

export interface KaspiOrderSummary {
  id: string;
  code: string | null;
  state: string | null;
  status: string | null;
  deliveryMode: string | null;
  updatedAt: string | null;
  raw: JsonApiResource;
}

export interface KaspiMerchantProductSummary {
  id: string;
  code: string | null;
  name: string | null;
  manufacturer: string | null;
  raw: JsonApiResource;
}

export interface KaspiOrderEntrySummary {
  id: string;
  entryNumber: number | null;
  quantity: number | null;
  totalPrice: number | null;
  basePrice: number | null;
  deliveryCost: number | null;
  weight: number | null;
  unitType: string | null;
  categoryCode: string | null;
  categoryTitle: string | null;
  masterProductId: string | null;
  raw: JsonApiResource;
}

export interface KaspiHydratedOrder {
  summary: KaspiOrderSummary;
  payload: {
    order: JsonApiResource;
    entries: Array<{
      entry: JsonApiResource;
      merchantProduct: JsonApiResource | null;
    }>;
  };
}

function buildHeaders(apiToken: string, extraHeaders?: Record<string, string>) {
  return {
    'Content-Type': JSON_API_CONTENT_TYPE,
    'X-Auth-Token': apiToken,
    ...extraHeaders,
  };
}

async function requestKaspi<T>(
  apiToken: string,
  path: string,
  init?: {
    method?: 'GET' | 'POST';
    body?: unknown;
    headers?: Record<string, string>;
  },
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${KASPI_API_BASE_URL}${path}`, {
      method: init?.method ?? 'GET',
      headers: buildHeaders(apiToken, init?.headers),
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(KASPI_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error(`Kaspi API timeout after ${KASPI_REQUEST_TIMEOUT_MS}ms`);
    }
    throw error;
  }

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`Kaspi API ${response.status}: ${bodyText || response.statusText}`);
  }

  return response.json() as Promise<T>;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeOrder(resource: JsonApiResource): KaspiOrderSummary {
  const attributes = resource.attributes ?? {};
  const updatedAt =
    readString(attributes.updatedAt)
    ?? readString(attributes.statusUpdateDate)
    ?? readString(attributes.creationDate);

  return {
    id: readString(resource.id) ?? '',
    code: readString(attributes.code),
    state: readString(attributes.state),
    status: readString(attributes.status),
    deliveryMode: readString(attributes.deliveryMode),
    updatedAt,
    raw: resource,
  };
}

function resolveKaspiOrderDateRange(params?: {
  creationDateFromMs?: number;
  creationDateToMs?: number;
}) {
  const now = Date.now();
  const defaultFrom = now - (KASPI_MAX_ORDER_RANGE_DAYS * 24 * 60 * 60 * 1000);

  const from = Number.isFinite(params?.creationDateFromMs)
    ? Math.trunc(params!.creationDateFromMs!)
    : defaultFrom;
  const to = Number.isFinite(params?.creationDateToMs)
    ? Math.trunc(params!.creationDateToMs!)
    : now;

  return {
    from: Math.min(from, to),
    to: Math.max(from, to),
  };
}

export async function listKaspiOrders(
  apiToken: string,
  params?: {
    pageNumber?: number;
    pageSize?: number;
    state?: string;
    status?: string;
    creationDateFromMs?: number;
    creationDateToMs?: number;
  },
): Promise<KaspiOrderSummary[]> {
  const search = new URLSearchParams();
  const range = resolveKaspiOrderDateRange(params);
  search.set('page[number]', String(params?.pageNumber ?? 0));
  search.set('page[size]', String(params?.pageSize ?? 100));
  search.set('filter[orders][creationDate][$ge]', String(range.from));
  search.set('filter[orders][creationDate][$le]', String(range.to));
  if (params?.state) search.set('filter[orders][state]', params.state);
  if (params?.status) search.set('filter[orders][status]', params.status);

  const payload = await requestKaspi<JsonApiCollectionResponse>(apiToken, `/orders?${search.toString()}`);
  return (payload.data ?? [])
    .map(normalizeOrder)
    .filter((order) => order.id);
}

export async function getKaspiOrderByCode(apiToken: string, orderCode: string): Promise<KaspiOrderSummary | null> {
  const search = new URLSearchParams();
  search.set('filter[orders][code]', orderCode);
  search.set('page[number]', '0');
  search.set('page[size]', '1');

  const payload = await requestKaspi<JsonApiCollectionResponse>(apiToken, `/orders?${search.toString()}`);
  const order = (payload.data ?? []).map(normalizeOrder).find((item) => item.id);
  return order ?? null;
}

export async function getKaspiOrderEntries(apiToken: string, orderId: string): Promise<KaspiOrderEntrySummary[]> {
  const payload = await requestKaspi<JsonApiCollectionResponse>(apiToken, `/orders/${orderId}/entries`);

  return (payload.data ?? [])
    .map((resource) => {
      const attributes = resource.attributes ?? {};
      const relationships = resource.relationships ?? {};
      const productRelation = relationships.product as Record<string, unknown> | undefined;
      const productData = productRelation?.data as Record<string, unknown> | undefined;
      const category = attributes.category as Record<string, unknown> | undefined;

      return {
        id: readString(resource.id) ?? '',
        entryNumber: readNumber(attributes.entryNumber),
        quantity: readNumber(attributes.quantity),
        totalPrice: readNumber(attributes.totalPrice),
        basePrice: readNumber(attributes.basePrice),
        deliveryCost: readNumber(attributes.deliveryCost),
        weight: readNumber(attributes.weight),
        unitType: readString(attributes.unitType),
        categoryCode: readString(category?.code),
        categoryTitle: readString(category?.title),
        masterProductId: readString(productData?.id),
        raw: resource,
      } satisfies KaspiOrderEntrySummary;
    })
    .filter((entry) => entry.id);
}

export async function getKaspiMerchantProduct(apiToken: string, masterProductId: string): Promise<KaspiMerchantProductSummary | null> {
  const payload = await requestKaspi<JsonApiSingleResponse>(apiToken, `/masterproducts/${masterProductId}/merchantProduct`);
  if (!payload.data) {
    return null;
  }

  const attributes = payload.data.attributes ?? {};
  return {
    id: readString(payload.data.id) ?? '',
    code: readString(attributes.code),
    name: readString(attributes.name),
    manufacturer: readString(attributes.manufacturer),
    raw: payload.data,
  };
}

export async function hydrateKaspiOrder(apiToken: string, summary: KaspiOrderSummary): Promise<KaspiHydratedOrder> {
  const detailedOrder = summary.code
    ? await getKaspiOrderByCode(apiToken, summary.code)
    : null;
  const effectiveSummary = detailedOrder ?? summary;
  const entries = await getKaspiOrderEntries(apiToken, summary.id);

  const merchantProducts = new Map<string, JsonApiResource | null>();
  for (const entry of entries) {
    if (!entry.masterProductId) {
      continue;
    }

    if (!merchantProducts.has(entry.masterProductId)) {
      const merchantProduct = await getKaspiMerchantProduct(apiToken, entry.masterProductId);
      merchantProducts.set(entry.masterProductId, merchantProduct?.raw ?? null);
    }
  }

  return {
    summary: effectiveSummary,
    payload: {
      order: effectiveSummary.raw,
      entries: entries.map((entry) => ({
        entry: entry.raw,
        merchantProduct: entry.masterProductId ? (merchantProducts.get(entry.masterProductId) ?? null) : null,
      })),
    },
  };
}

export async function sendKaspiCompletionCode(apiToken: string, orderId: string, orderCode: string): Promise<KaspiOrderSummary> {
  const payload = await requestKaspi<JsonApiSingleResponse>(apiToken, '/orders', {
    method: 'POST',
    headers: {
      'X-Security-Code': '',
      'X-Send-Code': 'true',
    },
    body: {
      data: {
        type: 'orders',
        id: orderId,
        attributes: {
          code: orderCode,
          status: 'COMPLETED',
        },
      },
    },
  });

  if (!payload.data) {
    throw new Error('Kaspi API returned empty order payload while sending completion code');
  }

  return normalizeOrder(payload.data);
}

export async function confirmKaspiCompletedOrder(
  apiToken: string,
  orderId: string,
  orderCode: string,
  securityCode: string,
): Promise<KaspiOrderSummary> {
  const payload = await requestKaspi<JsonApiSingleResponse>(apiToken, '/orders', {
    method: 'POST',
    headers: {
      'X-Security-Code': securityCode,
      'X-Send-Code': 'true',
    },
    body: {
      data: {
        type: 'orders',
        id: orderId,
        attributes: {
          code: orderCode,
          status: 'COMPLETED',
        },
      },
    },
  });

  if (!payload.data) {
    throw new Error('Kaspi API returned empty order payload while confirming completion');
  }

  return normalizeOrder(payload.data);
}
