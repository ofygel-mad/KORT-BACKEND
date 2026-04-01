import { extname } from 'node:path';
import type { Readable } from 'node:stream';
import { nanoid } from 'nanoid';
import { PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { r2, R2_BUCKET } from '../../lib/r2.js';
import { prisma } from '../../lib/prisma.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { config } from '../../config.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
]);

const ALLOWED_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif',
  '.pdf', '.xlsx', '.xls',
]);

export const MAX_BYTES = config.UPLOAD_MAX_FILE_SIZE_MB * 1024 * 1024;

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildStorageKey(orgId: string, orderId: string, filename: string): string {
  return `chapan/${orgId}/${orderId}/${filename}`;
}

// ── Service ───────────────────────────────────────────────────────────────────

export async function uploadAttachment(
  orgId: string,
  orderId: string,
  uploadedBy: string,
  file: {
    filename: string;
    mimetype: string;
    stream: Readable;
  },
) {
  // Validate order belongs to org
  const order = await prisma.chapanOrder.findFirst({ where: { id: orderId, orgId } });
  if (!order) throw new NotFoundError('ChapanOrder', orderId);

  // Validate extension
  const ext = extname(file.filename).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new ValidationError(`Тип файла не разрешён. Допустимые: ${[...ALLOWED_EXTENSIONS].join(', ')}`);
  }

  // Validate mime type
  if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
    throw new ValidationError('MIME-тип файла не разрешён');
  }

  // Build unique R2 key
  const uniqueName = `${nanoid(10)}${ext}`;
  const storageKey = buildStorageKey(orgId, orderId, uniqueName);

  // Buffer stream, count bytes, enforce size limit
  const chunks: Buffer[] = [];
  let sizeBytes = 0;

  for await (const chunk of file.stream) {
    sizeBytes += (chunk as Buffer).length;
    if (sizeBytes > MAX_BYTES) {
      throw new ValidationError(`Файл превышает ${config.UPLOAD_MAX_FILE_SIZE_MB} МБ`);
    }
    chunks.push(chunk as Buffer);
  }

  const body = Buffer.concat(chunks);

  // Upload to R2
  await r2.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: storageKey,
    Body: body,
    ContentType: file.mimetype,
    ContentLength: sizeBytes,
  }));

  // Persist record
  const attachment = await prisma.chapanOrderAttachment.create({
    data: {
      orderId,
      orgId,
      fileName: file.filename,
      mimeType: file.mimetype,
      sizeBytes,
      storagePath: storageKey,
      uploadedBy,
    },
  });

  return attachment;
}

export async function listAttachments(orgId: string, orderId: string) {
  const order = await prisma.chapanOrder.findFirst({ where: { id: orderId, orgId } });
  if (!order) throw new NotFoundError('ChapanOrder', orderId);

  return prisma.chapanOrderAttachment.findMany({
    where: { orderId, orgId },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getAttachmentDownloadUrl(orgId: string, attachmentId: string): Promise<{ att: { fileName: string; mimeType: string }; url: string }> {
  const att = await prisma.chapanOrderAttachment.findFirst({
    where: { id: attachmentId, orgId },
  });
  if (!att) throw new NotFoundError('ChapanOrderAttachment', attachmentId);

  const url = await getSignedUrl(
    r2,
    new GetObjectCommand({
      Bucket: R2_BUCKET,
      Key: att.storagePath,
      ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(att.fileName)}`,
      ResponseContentType: att.mimeType,
    }),
    { expiresIn: 3600 },
  );

  return { att, url };
}

export async function deleteAttachment(orgId: string, attachmentId: string) {
  const att = await prisma.chapanOrderAttachment.findFirst({
    where: { id: attachmentId, orgId },
  });
  if (!att) throw new NotFoundError('ChapanOrderAttachment', attachmentId);

  await prisma.chapanOrderAttachment.delete({ where: { id: attachmentId } });

  try {
    await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: att.storagePath }));
  } catch {}

  return { ok: true };
}
