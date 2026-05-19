import { extname } from 'node:path';
import type { Readable } from 'node:stream';
import { nanoid } from 'nanoid';
import { PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { r2, R2_BUCKET, isR2Configured } from '../../lib/r2.js';
import { prisma } from '../../lib/prisma.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { config } from '../../config.js';

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

export const MAX_BYTES = config.UPLOAD_MAX_FILE_SIZE_MB * 1024 * 1024;

function buildStorageKey(orgId: string, productId: string, filename: string): string {
  return `catalog/${orgId}/${productId}/${filename}`;
}

function ensureR2Configured() {
  if (!isR2Configured || !r2 || !R2_BUCKET) {
    throw new ValidationError('\u0424\u0430\u0439\u043B\u043E\u0432\u043E\u0435 \u0445\u0440\u0430\u043D\u0438\u043B\u0438\u0449\u0435 \u043D\u0435 \u043D\u0430\u0441\u0442\u0440\u043E\u0435\u043D\u043E. \u0417\u0430\u043F\u043E\u043B\u043D\u0438\u0442\u0435 \u043F\u0435\u0440\u0435\u043C\u0435\u043D\u043D\u044B\u0435 R2_*');
  }
}

function getR2Bucket(): string {
  ensureR2Configured();
  return R2_BUCKET!;
}

function getR2Client() {
  ensureR2Configured();
  return r2!;
}

async function buildFileUrl(storagePath: string, mimeType: string): Promise<string> {
  const bucket = getR2Bucket();
  const r2Client = getR2Client();

  return getSignedUrl(
    r2Client,
    new GetObjectCommand({
      Bucket: bucket,
      Key: storagePath,
      ResponseContentType: mimeType,
    }),
    { expiresIn: 3600 },
  );
}

async function serializeProductPhoto<T extends { storagePath: string; mimeType: string }>(photo: T) {
  return {
    ...photo,
    fileUrl: await buildFileUrl(photo.storagePath, photo.mimeType),
  };
}

export async function listProductPhotos(orgId: string, productId: string) {
  const product = await prisma.warehouseProductCatalog.findFirst({ where: { id: productId, orgId } });
  if (!product) throw new NotFoundError('WarehouseProductCatalog', productId);

  const photos = await prisma.warehouseProductPhoto.findMany({
    where: { productId, orgId },
    orderBy: { sortOrder: 'asc' },
  });

  return Promise.all(photos.map((photo) => serializeProductPhoto(photo)));
}

export async function uploadProductPhoto(
  orgId: string,
  productId: string,
  file: { filename: string; mimetype: string; stream: Readable },
) {
  const bucket = getR2Bucket();
  const r2Client = getR2Client();

  const product = await prisma.warehouseProductCatalog.findFirst({ where: { id: productId, orgId } });
  if (!product) throw new NotFoundError('WarehouseProductCatalog', productId);

  const ext = extname(file.filename).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new ValidationError(`\u0422\u0438\u043F \u0444\u0430\u0439\u043B\u0430 \u043D\u0435 \u0440\u0430\u0437\u0440\u0435\u0448\u0451\u043D. \u0414\u043E\u043F\u0443\u0441\u0442\u0438\u043C\u044B\u0435: ${[...ALLOWED_EXTENSIONS].join(', ')}`);
  }
  if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
    throw new ValidationError('\u041CIME-\u0442\u0438\u043F \u0444\u0430\u0439\u043B\u0430 \u043D\u0435 \u0440\u0430\u0437\u0440\u0435\u0448\u0451\u043D. \u0420\u0430\u0437\u0440\u0435\u0448\u0435\u043D\u044B \u0442\u043E\u043B\u044C\u043A\u043E \u0438\u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u044F JPG, PNG, WebP');
  }

  const uniqueName = `${nanoid(10)}${ext}`;
  const storageKey = buildStorageKey(orgId, productId, uniqueName);

  const chunks: Buffer[] = [];
  let sizeBytes = 0;
  for await (const chunk of file.stream) {
    sizeBytes += (chunk as Buffer).length;
    if (sizeBytes > MAX_BYTES) {
      throw new ValidationError(`\u0424\u0430\u0439\u043B \u043F\u0440\u0435\u0432\u044B\u0448\u0430\u0435\u0442 ${config.UPLOAD_MAX_FILE_SIZE_MB} \u041C\u0411`);
    }
    chunks.push(chunk as Buffer);
  }
  const body = Buffer.concat(chunks);

  await r2Client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: storageKey,
    Body: body,
    ContentType: file.mimetype,
    ContentLength: sizeBytes,
  }));

  const count = await prisma.warehouseProductPhoto.count({ where: { productId, orgId } });

  const photo = await prisma.warehouseProductPhoto.create({
    data: {
      productId,
      orgId,
      fileName: file.filename,
      mimeType: file.mimetype,
      sizeBytes,
      storagePath: storageKey,
      sortOrder: count,
    },
  });

  return serializeProductPhoto(photo);
}

export async function getProductPhotoUrl(orgId: string, productId: string, photoId: string): Promise<string> {
  const photo = await prisma.warehouseProductPhoto.findFirst({ where: { id: photoId, orgId, productId } });
  if (!photo) throw new NotFoundError('WarehouseProductPhoto', photoId);

  return buildFileUrl(photo.storagePath, photo.mimeType);
}

export async function deleteProductPhoto(orgId: string, photoId: string) {
  const bucket = getR2Bucket();
  const r2Client = getR2Client();

  const photo = await prisma.warehouseProductPhoto.findFirst({ where: { id: photoId, orgId } });
  if (!photo) throw new NotFoundError('WarehouseProductPhoto', photoId);

  await prisma.warehouseProductPhoto.delete({ where: { id: photoId } });

  try {
    await r2Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: photo.storagePath }));
  } catch {}

  return { ok: true };
}
