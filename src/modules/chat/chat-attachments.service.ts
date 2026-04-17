import { extname } from 'node:path';
import type { Readable } from 'node:stream';
import { nanoid } from 'nanoid';
import { PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { r2, R2_BUCKET, isR2Configured } from '../../lib/r2.js';
import { prisma } from '../../lib/prisma.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { config } from '../../config.js';
import * as chatService from './chat.service.js';

// ── Constants ─────────────────────────────────────────────────────────────

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

const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export const MAX_BYTES = config.UPLOAD_MAX_FILE_SIZE_MB * 1024 * 1024;

function ensureR2Configured() {
  if (!isR2Configured || !r2 || !R2_BUCKET) {
    throw new ValidationError('Файловое хранилище не настроено. Заполните переменные R2_*');
  }
}

// ── uploadChatAttachment ───────────────────────────────────────────────────

export async function uploadChatAttachment(
  convId: string,
  orgId: string,
  senderId: string,
  file: { filename: string; mimetype: string; stream: Readable },
) {
  ensureR2Configured();

  // Verify sender is participant
  const participation = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId: convId, userId: senderId } },
  });
  if (!participation) throw new ForbiddenError('Нет доступа к этому диалогу.');

  const ext = extname(file.filename).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new ValidationError(`Тип файла не разрешён. Допустимые: ${[...ALLOWED_EXTENSIONS].join(', ')}`);
  }
  if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
    throw new ValidationError('MIME-тип файла не разрешён.');
  }

  const uniqueName = `${nanoid(10)}${ext}`;
  const storageKey = `chat/${orgId}/${convId}/${uniqueName}`;

  // Buffer stream and enforce size limit
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
  const isImage = IMAGE_MIME_TYPES.has(file.mimetype);
  const msgType = isImage ? 'IMAGE' : 'FILE';

  await r2!.send(new PutObjectCommand({
    Bucket: R2_BUCKET!,
    Key: storageKey,
    Body: body,
    ContentType: file.mimetype,
    ContentLength: sizeBytes,
  }));

  // Get all other participants for unread increment
  const allParticipants = await prisma.conversationParticipant.findMany({
    where: { conversationId: convId },
    select: { userId: true },
  });
  const otherUserIds = allParticipants.map((p) => p.userId).filter((id) => id !== senderId);

  const message = await prisma.$transaction(async (tx) => {
    const msg = await tx.message.create({
      data: {
        conversationId: convId,
        senderId,
        body: file.filename,
        type: msgType as 'IMAGE' | 'FILE',
        attachments: {
          create: {
            orgId,
            fileName: file.filename,
            mimeType: file.mimetype,
            sizeBytes,
            storagePath: storageKey,
          },
        },
      },
      include: {
        replyTo: { include: { sender: { select: { fullName: true } } } },
        attachments: {
          select: {
            id: true, fileName: true, mimeType: true,
            sizeBytes: true, width: true, height: true,
          },
        },
      },
    });

    if (otherUserIds.length > 0) {
      await tx.conversationParticipant.updateMany({
        where: { conversationId: convId, userId: { in: otherUserIds } },
        data: { unreadCount: { increment: 1 } },
      });
    }

    await tx.conversation.update({
      where: { id: convId },
      data: { updatedAt: new Date() },
    });

    return msg;
  });

  // Build formatted message inline (same shape as fmtMessage in chat.service.ts)
  const attachment = message.attachments[0]!;
  const formatted = {
    id: message.id,
    conversation_id: message.conversationId,
    sender_id: message.senderId,
    body: message.body,
    type: message.type,
    reply_to_id: null,
    reply_to: null,
    edited_at: null,
    deleted_at: null,
    order_id: null,
    created_at: message.createdAt.toISOString(),
    read_at: null,
    attachment: {
      id: attachment.id,
      file_name: attachment.fileName,
      mime_type: attachment.mimeType,
      size_bytes: attachment.sizeBytes,
      width: attachment.width,
      height: attachment.height,
    },
  };

  for (const uid of otherUserIds) {
    chatService.emitChatEvent?.(uid, {
      type: 'message.new',
      conversation_id: convId,
      message: formatted,
    });
  }

  return formatted;
}

// ── getAttachmentDownloadUrl ───────────────────────────────────────────────

export async function getAttachmentDownloadUrl(attachmentId: string, userId: string) {
  ensureR2Configured();

  const att = await prisma.chatAttachment.findUnique({
    where: { id: attachmentId },
    include: {
      message: {
        include: {
          conversation: {
            include: { participants: { select: { userId: true } } },
          },
        },
      },
    },
  });

  if (!att) throw new NotFoundError('Вложение', attachmentId);

  const isParticipant = att.message.conversation.participants.some((p) => p.userId === userId);
  if (!isParticipant) throw new ForbiddenError('Нет доступа к этому файлу.');

  const url = await getSignedUrl(
    r2!,
    new GetObjectCommand({
      Bucket: R2_BUCKET!,
      Key: att.storagePath,
      ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(att.fileName)}`,
      ResponseContentType: att.mimeType,
    }),
    { expiresIn: 3600 },
  );

  return { att, url };
}

// ── deleteAttachment (used when soft-deleting messages) ───────────────────

export async function deleteAttachmentFromStorage(storagePath: string) {
  if (!isR2Configured || !r2 || !R2_BUCKET) return;
  try {
    await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: storagePath }));
  } catch {}
}
