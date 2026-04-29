import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import * as svc from './ads.service.js';

const channelSchema = z.enum(['target', 'instagram', 'partner', 'other']);

export const adsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', app.resolveOrg);

  app.get<{ Querystring: { period?: string; channel?: string } }>('/dashboard', async (req) => {
    const query = z.object({
      period: z.string().regex(/^\d{4}-\d{2}$/).optional(),
      channel: channelSchema.optional(),
    }).parse(req.query);
    return svc.getDashboard(req.orgId, query);
  });

  app.get<{ Querystring: { date?: string; refresh?: string } }>('/exchange-rate', async (req) => {
    const query = z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      refresh: z.string().optional(),
    }).parse(req.query);
    return svc.getUsdKztRate(query.date, query.refresh === 'true');
  });

  app.post('/campaigns', async (req, reply) => {
    const body = z.object({
      name: z.string().trim().min(1),
      channel: channelSchema.default('target'),
      managerName: z.string().trim().optional(),
      creativeUrl: z.string().trim().optional(),
      notes: z.string().trim().optional(),
    }).parse(req.body);

    const campaign = await svc.createCampaign(req.orgId, body);
    return reply.status(201).send(campaign);
  });

  app.patch<{ Params: { id: string } }>('/campaigns/:id', async (req) => {
    const body = z.object({
      name: z.string().trim().min(1).optional(),
      channel: channelSchema.optional(),
      status: z.enum(['active', 'paused', 'archived']).optional(),
      managerName: z.string().trim().nullable().optional(),
      creativeUrl: z.string().trim().nullable().optional(),
      notes: z.string().trim().nullable().optional(),
    }).parse(req.body);

    return svc.updateCampaign(req.orgId, req.params.id, body);
  });

  app.delete<{ Params: { id: string } }>('/campaigns/:id', async (req, reply) => {
    await svc.deleteCampaign(req.orgId, req.params.id);
    return reply.status(204).send();
  });

  app.post('/metrics', async (req, reply) => {
    const body = z.object({
      campaignId: z.string().min(1),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      spendUsd: z.number().min(0).optional(),
      exchangeRate: z.number().min(0).optional(),
      impressions: z.number().min(0).optional(),
      reach: z.number().min(0).optional(),
      clicks: z.number().min(0).optional(),
      leads: z.number().min(0).optional(),
      sales: z.number().min(0).optional(),
      notes: z.string().trim().optional(),
    }).parse(req.body);

    const metric = await svc.upsertMetric(req.orgId, body);
    return reply.status(201).send(metric);
  });

  app.get<{ Querystring: { period?: string; channel?: string } }>('/export', async (req) => {
    const query = z.object({
      period: z.string().regex(/^\d{4}-\d{2}$/).optional(),
      channel: channelSchema.optional(),
    }).parse(req.query);

    const rows = await svc.getExportRows(req.orgId, query);
    return {
      rows,
      exportedAt: new Date().toISOString(),
      count: rows.length,
    };
  });

  app.post('/import/preview', async (_req, reply) => {
    return reply.status(202).send({
      status: 'stub',
      message: 'Excel import is reserved for the next migration step. The parser will normalize old RNP sheets into campaigns and daily metrics.',
    });
  });
};
