import type { FastifyInstance } from 'fastify';
import { createUnpaidAlert, getUnpaidAlerts, resolveAlert } from './alerts.service.js';

export async function alertsRouter(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', app.resolveOrg);

  // GET /api/v1/chapan/alerts/unpaid
  app.get('/unpaid', async (request) => {
    const alerts = await getUnpaidAlerts(request.orgId);
    return { results: alerts, count: alerts.length };
  });

  // POST /api/v1/chapan/alerts/unpaid
  app.post<{ Body: { orderId: string; orderNumber: string } }>('/unpaid', async (request) => {
    const { orderId, orderNumber } = request.body;
    const alert = await createUnpaidAlert(request.orgId, orderId, orderNumber, request.userId);
    return alert;
  });

  // POST /api/v1/chapan/alerts/:alertId/resolve
  app.post<{ Params: { alertId: string } }>('/:alertId/resolve', async (request) => {
    const { alertId } = request.params;
    const updated = await resolveAlert(request.orgId, alertId, request.userId);
    return updated;
  });
}
