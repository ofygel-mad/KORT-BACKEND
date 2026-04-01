import { prisma } from '../../lib/prisma.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors.js';

// ── WS event hook (wired up in Phase 3) ───────────────────────────────────
export let emitChatEvent: ((userId: string, event: object) => void) | null = null;
export function setChatEventEmitter(fn: (userId: string, event: object) => void) {
  emitChatEvent = fn;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtMessage(m: {
  id: string;
  conversationId: string;
  senderId: string;
  body: string;
  createdAt: Date;
  readAt: Date | null;
}) {
  return {
    id: m.id,
    conversation_id: m.conversationId,
    sender_id: m.senderId,
    body: m.body,
    created_at: m.createdAt.toISOString(),
    read_at: m.readAt?.toISOString() ?? null,
  };
}

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
            orderBy: { createdAt: 'desc' },
            take: 1,
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
      participants: p.conversation.participants.map((cp) => fmtParticipant(cp.user)),
      last_message: lastMsg ? fmtMessage(lastMsg) : null,
    };
  });
}

// ── findOrCreate ───────────────────────────────────────────────────────────

export async function findOrCreate(userId: string, participantId: string, orgId: string) {
  if (userId === participantId) {
    throw new ValidationError('Нельзя создать диалог с самим собой.');
  }

  // Verify both users are in the same org
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

  // Find existing 1-to-1 conversation in this org between these two users
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

  // Create new conversation + both participants in a transaction
  const conv = await prisma.$transaction(async (tx) => {
    const c = await tx.conversation.create({
      data: { orgId },
    });
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
  // Verify the requester is a participant
  const participation = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId: convId, userId } },
  });
  if (!participation) throw new ForbiddenError('Нет доступа к этому диалогу.');

  let messages;

  if (cursor) {
    // Cursor = ID of the oldest displayed message; load messages older than it
    const pivot = await prisma.message.findUnique({ where: { id: cursor } });
    if (!pivot) throw new NotFoundError('Message', cursor);

    messages = await prisma.message.findMany({
      where: { conversationId: convId, createdAt: { lt: pivot.createdAt } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    messages = messages.reverse();
  } else {
    // Initial load — most recent `limit` messages in chronological order
    messages = await prisma.message.findMany({
      where: { conversationId: convId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    messages = messages.reverse();
  }

  return messages.map(fmtMessage);
}

// ── sendMessage ────────────────────────────────────────────────────────────

export async function sendMessage(convId: string, senderId: string, body: string) {
  const trimmed = body.trim();
  if (!trimmed) throw new ValidationError('Сообщение не может быть пустым.');
  if (trimmed.length > 4000) throw new ValidationError('Сообщение слишком длинное (максимум 4000 символов).');

  // Verify sender is a participant
  const senderParticipation = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId: convId, userId: senderId } },
  });
  if (!senderParticipation) throw new ForbiddenError('Нет доступа к этому диалогу.');

  // Get all participants (to increment unread for others)
  const allParticipants = await prisma.conversationParticipant.findMany({
    where: { conversationId: convId },
    select: { userId: true },
  });

  const otherUserIds = allParticipants
    .map((p) => p.userId)
    .filter((id) => id !== senderId);

  // Insert message + increment unread + touch conversation in one transaction
  const message = await prisma.$transaction(async (tx) => {
    const msg = await tx.message.create({
      data: { conversationId: convId, senderId, body: trimmed },
    });

    // Increment unreadCount for all other participants
    if (otherUserIds.length > 0) {
      await tx.conversationParticipant.updateMany({
        where: { conversationId: convId, userId: { in: otherUserIds } },
        data: { unreadCount: { increment: 1 } },
      });
    }

    // Touch conversation.updatedAt so list order refreshes
    await tx.conversation.update({
      where: { id: convId },
      data: { updatedAt: new Date() },
    });

    return msg;
  });

  const formatted = fmtMessage(message);

  // Emit WS event to other participants (no-op until Phase 3)
  for (const uid of otherUserIds) {
    emitChatEvent?.(uid, {
      type: 'message.new',
      conversation_id: convId,
      message: formatted,
    });
  }

  return formatted;
}

// ── markRead ───────────────────────────────────────────────────────────────

export async function markRead(convId: string, userId: string) {
  const participation = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId: convId, userId } },
  });
  if (!participation) throw new ForbiddenError('Нет доступа к этому диалогу.');

  const readAt = new Date();

  await prisma.conversationParticipant.update({
    where: { conversationId_userId: { conversationId: convId, userId } },
    data: { unreadCount: 0, lastReadAt: readAt },
  });

  // Notify other participants that this user has read the conversation
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
