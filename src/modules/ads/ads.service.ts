import { prisma } from '../../lib/prisma.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';

export type AdChannel = 'target' | 'instagram' | 'partner' | 'other';

export interface UpsertMetricDto {
  campaignId: string;
  date: string;
  spendUsd?: number;
  exchangeRate?: number;
  impressions?: number;
  reach?: number;
  clicks?: number;
  leads?: number;
  sales?: number;
  notes?: string;
}

const NBK_RSS_URL = 'https://nationalbank.kz/rss/rates_all.xml';

function monthRange(period: string) {
  const [year, month] = period.split('-').map(Number);
  if (!year || !month || month < 1 || month > 12) {
    throw new ValidationError('Invalid period. Expected YYYY-MM');
  }

  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 1));
  return { from, to };
}

function dateOnly(value: string | Date) {
  const date = value instanceof Date ? value : new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw new ValidationError('Invalid date');
  }
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

function currentPeriod() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function roundMoney(value: number) {
  return Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
}

function safeRatio(numerator: number, denominator: number) {
  if (!denominator) return 0;
  return numerator / denominator;
}

function aggregate(rows: Array<{
  spendUsd: number;
  spendKzt: number;
  impressions: number;
  reach: number;
  clicks: number;
  leads: number;
  sales: number;
}>) {
  const base = rows.reduce(
    (acc, row) => {
      acc.spendUsd += row.spendUsd;
      acc.spendKzt += row.spendKzt;
      acc.impressions += row.impressions;
      acc.reach += row.reach;
      acc.clicks += row.clicks;
      acc.leads += row.leads;
      acc.sales += row.sales;
      return acc;
    },
    { spendUsd: 0, spendKzt: 0, impressions: 0, reach: 0, clicks: 0, leads: 0, sales: 0 },
  );

  return {
    ...base,
    spendUsd: roundMoney(base.spendUsd),
    spendKzt: roundMoney(base.spendKzt),
    averageRate: safeRatio(base.spendKzt, base.spendUsd),
    ctr: safeRatio(base.clicks, base.impressions),
    cpcUsd: safeRatio(base.spendUsd, base.clicks),
    cpcKzt: safeRatio(base.spendKzt, base.clicks),
    clickToLeadCr: safeRatio(base.leads, base.clicks),
    cplUsd: safeRatio(base.spendUsd, base.leads),
    cplKzt: safeRatio(base.spendKzt, base.leads),
    leadToSaleCr: safeRatio(base.sales, base.leads),
    customerCostUsd: safeRatio(base.spendUsd, base.sales),
    customerCostKzt: safeRatio(base.spendKzt, base.sales),
  };
}

function readTag(xml: string, tag: string) {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  return match?.[1]?.trim() ?? '';
}

function parseNbkUsdRate(xml: string) {
  const item = xml.match(/<item>\s*<title>USD<\/title>[\s\S]*?<\/item>/i)?.[0];
  if (!item) {
    throw new ValidationError('USD rate was not found in NBK feed');
  }

  const rawDate = readTag(item, 'pubDate');
  const rawRate = readTag(item, 'description').replace(',', '.');
  const rawQuant = readTag(item, 'quant') || '1';
  const [day, month, year] = rawDate.split('.').map(Number);
  const rate = Number(rawRate) / Number(rawQuant);

  if (!day || !month || !year || !Number.isFinite(rate) || rate <= 0) {
    throw new ValidationError('Invalid USD rate payload from NBK feed');
  }

  return {
    rate,
    rateDate: new Date(Date.UTC(year, month - 1, day)),
  };
}

async function fetchNbkUsdKztRate() {
  const response = await fetch(NBK_RSS_URL, {
    headers: { Accept: 'application/rss+xml, application/xml, text/xml' },
  });
  if (!response.ok) {
    throw new ValidationError(`NBK rate feed unavailable: ${response.status}`);
  }

  return parseNbkUsdRate(await response.text());
}

export async function getUsdKztRate(inputDate?: string, refresh = false) {
  const requestedDate = inputDate ? dateOnly(inputDate) : dateOnly(new Date());

  if (!refresh) {
    const cached = await prisma.exchangeRate.findUnique({
      where: {
        base_quote_rateDate_source: {
          base: 'USD',
          quote: 'KZT',
          rateDate: requestedDate,
          source: 'NBK',
        },
      },
    });
    if (cached) {
      return { ...cached, isFallback: false };
    }
  }

  try {
    const official = await fetchNbkUsdKztRate();
    const saved = await prisma.exchangeRate.upsert({
      where: {
        base_quote_rateDate_source: {
          base: 'USD',
          quote: 'KZT',
          rateDate: official.rateDate,
          source: 'NBK',
        },
      },
      update: { rate: official.rate, fetchedAt: new Date() },
      create: {
        base: 'USD',
        quote: 'KZT',
        rate: official.rate,
        source: 'NBK',
        rateDate: official.rateDate,
      },
    });

    return { ...saved, isFallback: saved.rateDate.getTime() !== requestedDate.getTime() };
  } catch (error) {
    const latest = await prisma.exchangeRate.findFirst({
      where: { base: 'USD', quote: 'KZT', source: 'NBK' },
      orderBy: { rateDate: 'desc' },
    });
    if (latest) {
      return { ...latest, isFallback: true };
    }
    throw error;
  }
}

export async function createCampaign(orgId: string, dto: {
  name: string;
  channel: AdChannel;
  managerName?: string;
  creativeUrl?: string;
  notes?: string;
}) {
  return prisma.adCampaign.create({
    data: {
      orgId,
      name: dto.name.trim(),
      channel: dto.channel,
      managerName: dto.managerName?.trim() || undefined,
      creativeUrl: dto.creativeUrl?.trim() || undefined,
      notes: dto.notes?.trim() || undefined,
    },
  });
}

export async function updateCampaign(orgId: string, id: string, dto: {
  name?: string;
  channel?: AdChannel;
  status?: string;
  managerName?: string | null;
  creativeUrl?: string | null;
  notes?: string | null;
}) {
  const campaign = await prisma.adCampaign.findFirst({ where: { id, orgId } });
  if (!campaign) throw new NotFoundError('Ad campaign', id);

  return prisma.adCampaign.update({
    where: { id },
    data: {
      name: dto.name?.trim(),
      channel: dto.channel,
      status: dto.status,
      managerName: dto.managerName === null ? null : dto.managerName?.trim(),
      creativeUrl: dto.creativeUrl === null ? null : dto.creativeUrl?.trim(),
      notes: dto.notes === null ? null : dto.notes?.trim(),
    },
  });
}

export async function deleteCampaign(orgId: string, id: string) {
  const campaign = await prisma.adCampaign.findFirst({ where: { id, orgId } });
  if (!campaign) throw new NotFoundError('Ad campaign', id);
  await prisma.adCampaign.delete({ where: { id } });
}

export async function upsertMetric(orgId: string, dto: UpsertMetricDto) {
  const campaign = await prisma.adCampaign.findFirst({
    where: { id: dto.campaignId, orgId },
  });
  if (!campaign) throw new NotFoundError('Ad campaign', dto.campaignId);

  const date = dateOnly(dto.date);
  const spendUsd = Math.max(0, dto.spendUsd ?? 0);
  const rate = dto.exchangeRate && dto.exchangeRate > 0
    ? dto.exchangeRate
    : (await getUsdKztRate(dto.date)).rate;
  const spendKzt = roundMoney(spendUsd * rate);

  return prisma.adDailyMetric.upsert({
    where: { campaignId_date: { campaignId: dto.campaignId, date } },
    update: {
      spendUsd,
      exchangeRate: rate,
      spendKzt,
      impressions: Math.max(0, Math.round(dto.impressions ?? 0)),
      reach: Math.max(0, Math.round(dto.reach ?? 0)),
      clicks: Math.max(0, Math.round(dto.clicks ?? 0)),
      leads: Math.max(0, Math.round(dto.leads ?? 0)),
      sales: Math.max(0, Math.round(dto.sales ?? 0)),
      notes: dto.notes?.trim() || null,
    },
    create: {
      orgId,
      campaignId: dto.campaignId,
      date,
      spendUsd,
      exchangeRate: rate,
      spendKzt,
      impressions: Math.max(0, Math.round(dto.impressions ?? 0)),
      reach: Math.max(0, Math.round(dto.reach ?? 0)),
      clicks: Math.max(0, Math.round(dto.clicks ?? 0)),
      leads: Math.max(0, Math.round(dto.leads ?? 0)),
      sales: Math.max(0, Math.round(dto.sales ?? 0)),
      notes: dto.notes?.trim() || undefined,
    },
  });
}

export async function getDashboard(orgId: string, query: { period?: string; channel?: string }) {
  const period = query.period || currentPeriod();
  const channel = query.channel || 'target';
  const { from, to } = monthRange(period);

  const campaigns = await prisma.adCampaign.findMany({
    where: { orgId, channel },
    orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
    include: {
      metrics: {
        where: { date: { gte: from, lt: to } },
        orderBy: { date: 'asc' },
      },
    },
  });

  const campaignReports = campaigns.map((campaign) => ({
    ...campaign,
    summary: aggregate(campaign.metrics),
  }));

  const summary = aggregate(campaigns.flatMap((campaign) => campaign.metrics));
  const rate = await getUsdKztRate();

  return {
    period,
    channel,
    sourceNotes: [
      'Raw metrics replace manual Excel rows: spend, impressions, reach, clicks, leads, sales.',
      'Derived metrics are calculated from stored daily snapshots.',
      'Historical Excel import is intentionally stubbed until old sheets are approved for migration.',
    ],
    exchangeRate: rate,
    summary,
    campaigns: campaignReports,
  };
}

export async function getExportRows(orgId: string, query: { period?: string; channel?: string }) {
  const dashboard = await getDashboard(orgId, query);
  return dashboard.campaigns.flatMap((campaign) =>
    campaign.metrics.map((metric) => ({
      date: metric.date.toISOString().slice(0, 10),
      channel: campaign.channel,
      campaign: campaign.name,
      managerName: campaign.managerName ?? '',
      spendUsd: metric.spendUsd,
      exchangeRate: metric.exchangeRate,
      spendKzt: metric.spendKzt,
      impressions: metric.impressions,
      reach: metric.reach,
      clicks: metric.clicks,
      ctr: safeRatio(metric.clicks, metric.impressions),
      leads: metric.leads,
      clickToLeadCr: safeRatio(metric.leads, metric.clicks),
      cplUsd: safeRatio(metric.spendUsd, metric.leads),
      cplKzt: safeRatio(metric.spendKzt, metric.leads),
      sales: metric.sales,
      leadToSaleCr: safeRatio(metric.sales, metric.leads),
      customerCostUsd: safeRatio(metric.spendUsd, metric.sales),
      customerCostKzt: safeRatio(metric.spendKzt, metric.sales),
      notes: metric.notes ?? '',
    })),
  );
}
