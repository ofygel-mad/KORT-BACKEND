import { prisma } from '../../lib/prisma.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors.js';

// ── WS event hook ──────────────────────────────────────────────────────────
export let emitChatEvent: ((userId: string, event: object) => void) | null = null;
export function setChatEventEmitter(fn: (userId: string, event: object) => void) {
  emitChatEvent = fn;
}

// ── Helpers ────────────────────────────────────────────────────────────────

type RawMessage = {
  id: string;
  conversationId: string;
  senderId: string;
  body: string;
  type: string;
  replyToId: string | null;
  editedAt: Date | null;
  deletedAt: Date | null;
  orderId: string | null;
  createdAt: Date;
  readAt: Date | null;
  replyTo?: {
    id: string;
    body: string;
    senderId: string;
    sender: { fullName: string };
    type: string;
    deletedAt: Date | null;
  } | null;
  attachments?: Array<{
    id: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    width: number | null;
    height: number | null;
  }>;
};

function fmtMessage(m: RawMessage) {
  const attachment = m.attachments?.[0] ?? null;
  const replyTo = m.replyTo
    ? {
        id: m.replyTo.id,
        sender_name: m.replyTo.sender.fullName,
        body: m.replyTo.deletedAt
          ? 'Сообщение удалено'
          : m.replyTo.body.slice(0, 80),
        type: m.replyTo.type as 'TEXT' | 'IMAGE' | 'FILE' | 'ORDER_REF',
      }
    : null;

  return {
    id: m.id,
    conversation_id: m.conversationId,
    sender_id: m.senderId,
    body: m.deletedAt ? '' : m.body,
    type: m.type as 'TEXT' | 'IMAGE' | 'FILE' | 'ORDER_REF',
    reply_to_id: m.replyToId ?? null,
    reply_to: replyTo,
    edited_at: m.editedAt?.toISOString() ?? null,
    deleted_at: m.deletedAt?.toISOString() ?? null,
    order_id: m.orderId ?? null,
    created_at: m.createdAt.toISOString(),
    read_at: m.readAt?.toISOString() ?? null,
    attachment: attachment
      ? {
          id: attachment.id,
          file_name: attachment.fileName,
          mime_type: attachment.mimeType,
          size_bytes: attachment.sizeBytes,
          width: attachment.width,
          height: attachment.height,
        }
      : null,
  };
}

const MESSAGE_INCLUDE = {
  replyTo: {
    include: {
      sender: { select: { fullName: true } },
    },
  },
  attachments: {
    select: {
      id: true,
      fileName: true,
      mimeType: true,
      sizeBytes: true,
      width: true,
      height: true,
    },
  },
} as const;

function fmtParticipant(u: {
  id: string;
  fullName: string;
  avatarUrl: string | null;
  phone: string | null;
}) {
  return {
    id: u.id,
    full_name: u.fullName,
    avatar_url: u.avatarUrl,
    phone: u.phone,
  };
}

// ── getConversations ───────────────────────────────────────────────────────

export async function getConversations(userId: string) {
  const participations = await prisma.conversationParticipant.findMany({
    where: { userId },
    orderBy: { conversation: { updatedAt: 'desc' } },
    include: {
      conversation: {
        include: {
          participants: {
            include: {
              user: { select: { id: true, fullName: true, avatarUrl: true, phone: true } },
            },
          },
          messages: {
            where: { deletedAt: null },
            orderBy: { createdAt: 'desc' },
            take: 1,
            include: MESSAGE_INCLUDE,
          },
        },
      },
    },
  });

  return participations.map((p) => {
    const lastMsg = p.conversation.messages[0] ?? null;
    return {
      id: p.conversation.id,
      updated_at: p.conversation.updatedAt.toISOString(),
      unread_count: p.unreadCount,
      my_last_read_at: p.lastReadAt?.toISOString() ?? null,
      participants: p.conversation.participants.map((cp) => fmtParticipant(cp.user)),
      last_message: lastMsg ? fmtMessage(lastMsg as RawMessage) : null,
    };
  });
}

// ── findOrCreate ───────────────────────────────────────────────────────────

export async function findOrCreate(userId: string, participantId: string, orgId: string) {
  if (userId === participantId) {
    throw new ValidationError('Нельзя создать диалог с самим собой.');
  }

  const [myMembership, theirMembership] = await Promise.all([
    prisma.membership.findUnique({
      where: { userId_orgId: { userId, orgId } },
      select: { status: true },
    }),
    prisma.membership.findUnique({
      where: { userId_orgId: { userId: participantId, orgId } },
      select: { status: true },
    }),
  ]);

  if (!myMembership || myMembership.status !== 'active') {
    throw new ForbiddenError('У вас нет доступа к этой организации.');
  }
  if (!theirMembership || theirMembership.status !== 'active') {
    throw new NotFoundError('Сотрудник');
  }

  const myConvIds = (
    await prisma.conversationParticipant.findMany({
      where: { userId },
      select: { conversationId: true },
    })
  ).map((p) => p.conversationId);

  const existing = await prisma.conversationParticipant.findFirst({
    where: {
      userId: participantId,
      conversationId: { in: myConvIds },
      conversation: { orgId },
    },
    select: { conversationId: true },
  });

  if (existing) return { id: existing.conversationId };

  const conv = await prisma.$transaction(async (tx) => {
    const c = await tx.conversation.create({ data: { orgId } });
    await tx.conversationParticipant.createMany({
      data: [
        { conversationId: c.id, userId },
        { conversationId: c.id, userId: participantId },
      ],
    });
    return c;
  });

  return { id: conv.id };
}

// ── getMessages ────────────────────────────────────────────────────────────

export async function getMessages(
  convId: string,
  userId: string,
  cursor: string | null,
  limit: number,
) {
  const participation = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId: convId, userId } },
  });
  if (!participation) throw new ForbiddenError('Нет доступа к этому диалогу.');

  let messages;

  if (cursor) {
    const pivot = await prisma.message.findUnique({ where: { id: cursor } });
    if (!pivot) throw new NotFoundError('Message', cursor);

    messages = await prisma.message.findMany({
      where: { conversationId: convId, createdAt: { lt: pivot.createdAt } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: MESSAGE_INCLUDE,
    });
    messages = messages.reverse();
  } else {
    messages = await prisma.message.findMany({
      where: { conversationId: convId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: MESSAGE_INCLUDE,
    });
    messages = messages.reverse();
  }

  return messages.map((m) => fmtMessage(m as unknown as RawMessage));
}

// ── sendMessage ────────────────────────────────────────────────────────────

export async function sendMessage(
  convId: string,
  senderId: string,
  body: string,
  opts?: { replyToId?: string },
) {
  const trimmed = body.trim();
  if (!trimmed) throw new ValidationError('Сообщение не может быть пустым.');
  if (trimmed.length > 4000) throw new ValidationError('Сообщение слишком длинное (максимум 4000 символов).');

  const senderParticipation = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId: convId, userId: senderId } },
  });
  if (!senderParticipation) throw new ForbiddenError('Нет доступа к этому диалогу.');

  if (opts?.replyToId) {
    const replyMsg = await prisma.message.findUnique({ where: { id: opts.replyToId } });
    if (!replyMsg || replyMsg.conversationId !== convId) {
      throw new ValidationError('Сообщение для ответа не найдено.');
    }
  }

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
        body: trimmed,
        replyToId: opts?.replyToId ?? null,
      },
      include: MESSAGE_INCLUDE,
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

  const formatted = fmtMessage(message as unknown as RawMessage);

  for (const uid of otherUserIds) {
    emitChatEvent?.(uid, {
      type: 'message.new',
      conversation_id: convId,
      message: formatted,
    });
  }

  return formatted;
}

// ── editMessage ────────────────────────────────────────────────────────────

export async function editMessage(messageId: string, userId: string, newBody: string) {
  const trimmed = newBody.trim();
  if (!trimmed) throw new ValidationError('Сообщение не может быть пустым.');
  if (trimmed.length > 4000) throw new ValidationError('Сообщение слишком длинное (максимум 4000 символов).');

  const msg = await prisma.message.findUnique({
    where: { id: messageId },
    include: { conversation: { include: { participants: { select: { userId: true } } } } },
  });
  if (!msg) throw new NotFoundError('Message', messageId);
  if (msg.senderId !== userId) throw new ForbiddenError('Можно редактировать только свои сообщения.');
  if (msg.deletedAt) throw new ValidationError('Нельзя редактировать удалённое сообщение.');

  const ageMs = Date.now() - msg.createdAt.getTime();
  if (ageMs > 24 * 60 * 60 * 1000) throw new ValidationError('Редактирование доступно только в течение 24 часов.');

  const updated = await prisma.message.update({
    where: { id: messageId },
    data: { body: trimmed, editedAt: new Date() },
    include: MESSAGE_INCLUDE,
  });

  const formatted = fmtMessage(updated as unknown as RawMessage);

  const participantIds = msg.conversation.participants.map((p) => p.userId);
  for (const uid of participantIds) {
    emitChatEvent?.(uid, {
      type: 'message.edited',
      conversation_id: msg.conversationId,
      message: formatted,
    });
  }

  return formatted;
}

// ── deleteMessage ──────────────────────────────────────────────────────────

export async function deleteMessage(messageId: string, userId: string) {
  const msg = await prisma.message.findUnique({
    where: { id: messageId },
    include: { conversation: { include: { participants: { select: { userId: true } } } } },
  });
  if (!msg) throw new NotFoundError('Message', messageId);
  if (msg.senderId !== userId) throw new ForbiddenError('Можно удалять только свои сообщения.');
  if (msg.deletedAt) return { ok: true };

  const ageMs = Date.now() - msg.createdAt.getTime();
  if (ageMs > 24 * 60 * 60 * 1000) throw new ValidationError('Удаление доступно только в течение 24 часов.');

  const deletedAt = new Date();
  await prisma.message.update({
    where: { id: messageId },
    data: { deletedAt, body: '' },
  });

  const participantIds = msg.conversation.participants.map((p) => p.userId);
  for (const uid of participantIds) {
    emitChatEvent?.(uid, {
      type: 'message.deleted',
      conversation_id: msg.conversationId,
      message_id: messageId,
      deleted_at: deletedAt.toISOString(),
    });
  }

  return { ok: true };
}

// ── markRead ───────────────────────────────────────────────────────────────

export async function markRead(convId: string, userId: string) {
  const participation = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId: convId, userId } },
  });
  if (!participation) throw new ForbiddenError('Нет доступа к этому диалогу.');

  const readAt = new Date();

  await prisma.$transaction([
    prisma.conversationParticipant.update({
      where: { conversationId_userId: { conversationId: convId, userId } },
      data: { unreadCount: 0, lastReadAt: readAt },
    }),
    prisma.message.updateMany({
      where: {
        conversationId: convId,
        senderId: { not: userId },
        readAt: null,
        deletedAt: null,
      },
      data: { readAt },
    }),
  ]);

  const others = await prisma.conversationParticipant.findMany({
    where: { conversationId: convId, userId: { not: userId } },
    select: { userId: true },
  });

  const event = {
    type: 'message.read',
    conversation_id: convId,
    reader_id: userId,
    read_at: readAt.toISOString(),
  };

  for (const p of others) {
    emitChatEvent?.(p.userId, event);
  }

  return { ok: true };
}

// ── getOrderPreview ────────────────────────────────────────────────────────

export async function getOrderPreview(orderId: string, userId: string) {
  // Verify the user has an active membership in some org that owns this order
  const order = await prisma.chapanOrder.findFirst({
    where: { id: orderId },
  });
  if (!order) throw new NotFoundError('Заказ', orderId);

  // Verify user is in the same org
  const membership = await prisma.membership.findFirst({
    where: { userId, orgId: order.orgId, status: 'active' },
  });
  if (!membership) throw new ForbiddenError('Нет доступа к этому заказу.');

  return {
    id: order.id,
    order_number: order.orderNumber,
    status: order.status,
    client_name: order.clientName ?? 'Без клиента',
    total_amount: order.totalAmount ?? 0,
    created_at: order.createdAt.toISOString(),
  };
}
