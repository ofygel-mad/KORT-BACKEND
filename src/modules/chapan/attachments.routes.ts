import type { FastifyInstance } from 'fastify';
import * as svc from './attachments.service.js';

export async function chapanAttachmentsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', app.resolveOrg);

  /**
   * POST /api/v1/chapan/orders/:orderId/attachments
   * Upload a file attachment to an order.
   */
  app.post<{ Params: { orderId: string } }>('/:orderId/attachments', async (request, reply) => {
    const { orderId } = request.params;

    const data = await request.file({
      limits: { fileSize: svc.MAX_BYTES },
    });

    if (!data) {
      return reply.status(400).send({ code: 'NO_FILE', message: 'Файл не прикреплён' });
    }

    const uploaderName = (request as any).user?.full_name ?? (request as any).user?.email ?? 'unknown';

    const attachment = await svc.uploadAttachment(
      request.orgId,
      orderId,
      uploaderName,
      {
        filename: data.filename,
        mimetype: data.mimetype,
        stream: data.file,
      },
    );

    return reply.status(201).send(attachment);
  });

  /**
   * GET /api/v1/chapan/orders/:orderId/attachments
   * List attachments for an order.
   */
  app.get<{ Params: { orderId: string } }>('/:orderId/attachments', async (request) => {
    const { orderId } = request.params;
    return svc.listAttachments(request.orgId, orderId);
  });

  /**
   * GET /api/v1/chapan/orders/:orderId/attachments/:attachmentId/file
   * Redirect to a presigned R2 download URL (valid 1 hour).
   */
  app.get<{ Params: { orderId: string; attachmentId: string } }>(
    '/:orderId/attachments/:attachmentId/file',
    async (request, reply) => {
      const { attachmentId } = request.params;
      const { url } = await svc.getAttachmentDownloadUrl(request.orgId, attachmentId);
      return reply.redirect(url, 302);
    },
  );

  /**
   * DELETE /api/v1/chapan/orders/:orderId/attachments/:attachmentId
   * Delete an attachment.
   */
  app.delete<{ Params: { orderId: string; attachmentId: string } }>(
    '/:orderId/attachments/:attachmentId',
    async (request) => {
      const { attachmentId } = request.params;
      return svc.deleteAttachment(request.orgId, attachmentId);
    },
  );
}
