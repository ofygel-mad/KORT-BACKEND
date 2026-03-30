import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { nanoid } from 'nanoid';
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

function getUploadRoot() {
  return resolve(config.UPLOAD_DIR);
}

function buildStoragePath(orgId: string, orderId: string, filename: string): string {
  return join('chapan', orgId, orderId, filename);
}

async function ensureDir(dir: string) {
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
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

  // Build safe storage path with unique name
  const uniqueName = `${nanoid(10)}${ext}`;
  const relativePath = buildStoragePath(orgId, orderId, uniqueName);
  const absolutePath = join(getUploadRoot(), relativePath);

  await ensureDir(join(getUploadRoot(), 'chapan', orgId, orderId));

  // Stream to disk, track bytes
  let sizeBytes = 0;
  const dest = createWriteStream(absolutePath);

  const countingStream = file.stream.on('data', (chunk: Buffer) => {
    sizeBytes += chunk.length;
    if (sizeBytes > MAX_BYTES) {
      dest.destroy();
      countingStream.destroy(new ValidationError(`Файл превышает ${config.UPLOAD_MAX_FILE_SIZE_MB} МБ`));
    }
  });

  try {
    await pipeline(countingStream, dest);
  } catch (err) {
    // Clean up partial file
    try { await unlink(absolutePath); } catch {}
    throw err;
  }

  // Persist record
  const attachment = await prisma.chapanOrderAttachment.create({
    data: {
      orderId,
      orgId,
      fileName: file.filename,
      mimeType: file.mimetype,
      sizeBytes,
      storagePath: relativePath,
      uploadedBy,
    },
  });

  return attachment;
}

export async function listAttachments(orgId: string, orderId: string) {
  // Verify order belongs to org
  const order = await prisma.chapanOrder.findFirst({ where: { id: orderId, orgId } });
  if (!order) throw new NotFoundError('ChapanOrder', orderId);

  return prisma.chapanOrderAttachment.findMany({
    where: { orderId, orgId },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getAttachmentFile(orgId: string, attachmentId: string) {
  const att = await prisma.chapanOrderAttachment.findFirst({
    where: { id: attachmentId, orgId },
  });
  if (!att) throw new NotFoundError('ChapanOrderAttachment', attachmentId);

  const absolutePath = join(getUploadRoot(), att.storagePath);
  return { att, absolutePath };
}

export async function deleteAttachment(orgId: string, attachmentId: string) {
  const att = await prisma.chapanOrderAttachment.findFirst({
    where: { id: attachmentId, orgId },
  });
  if (!att) throw new NotFoundError('ChapanOrderAttachment', attachmentId);

  const absolutePath = join(getUploadRoot(), att.storagePath);
  await prisma.chapanOrderAttachment.delete({ where: { id: attachmentId } });

  try { await unlink(absolutePath); } catch {}

  return { ok: true };
}
