import { prisma } from '../../lib/prisma.js';
import { paginate, paginatedResponse, type PaginationParams } from '../../lib/pagination.js';
import { NotFoundError } from '../../lib/errors.js';

export async function list(orgId: string, params: PaginationParams & { pipeline?: string; stage?: string }) {
  const where: Record<string, unknown> = { orgId };
  if (params.pipeline) where.pipeline = params.pipeline;
  if (params.stage) where.stage = params.stage;

  const [items, total] = await Promise.all([
    prisma.lead.findMany({
      where,
      ...paginate(params),
      orderBy: { updatedAt: 'desc' },
      include: { history: { orderBy: { createdAt: 'desc' }, take: 5 } },
    }),
    prisma.lead.count({ where }),
  ]);

  return paginatedResponse(items, total, params);
}

export async function getById(orgId: string, id: string) {
  const lead = await prisma.lead.findFirst({
    where: { id, orgId },
    include: { history: { orderBy: { createdAt: 'desc' } } },
  });
  if (!lead) throw new NotFoundError('Lead', id);
  return lead;
}

export async function create(orgId: string, data: {
  fullName: string;
  phone: string;
  source: string;
  pipeline?: string;
  assignedTo?: string;
  assignedName?: string;
  budget?: number;
  comment?: string;
  email?: string;
  companyName?: string;
}) {
  return prisma.lead.create({
    data: {
      orgId,
      fullName: data.fullName,
      phone: data.phone,
      source: data.source,
      pipeline: data.pipeline ?? 'qualifier',
      assignedTo: data.assignedTo,
      assignedName: data.assignedName,
      budget: data.budget,
      comment: data.comment,
      email: data.email,
      companyName: data.companyName,
      history: {
        create: {
          type: 'system',
          content: 'Лид создан',
          author: 'Система',
        },
      },
    },
    include: { history: true },
  });
}

export async function update(orgId: string, id: string, data: Record<string, unknown>, authorName: string) {
  const lead = await prisma.lead.findFirst({ where: { id, orgId } });
  if (!lead) throw new NotFoundError('Lead', id);

  const oldStage = lead.stage;
  const newStage = data.stage as string | undefined;

  const updated = await prisma.lead.update({
    where: { id },
    data: {
      fullName: data.fullName as string | undefined,
      phone: data.phone as string | undefined,
      source: data.source as string | undefined,
      stage: newStage,
      pipeline: data.pipeline as string | undefined,
      assignedTo: data.assignedTo as string | undefined,
      assignedName: data.assignedName as string | undefined,
      callbackAt: data.callbackAt ? new Date(data.callbackAt as string) : undefined,
      meetingAt: data.meetingAt ? new Date(data.meetingAt as string) : undefined,
      budget: data.budget as number | undefined,
      comment: data.comment as string | undefined,
      email: data.email as string | undefined,
      companyName: data.companyName as string | undefined,
      checklistDone: data.checklistDone as string[] | undefined,
    },
    include: { history: { orderBy: { createdAt: 'desc' } } },
  });

  if (newStage && newStage !== oldStage) {
    await prisma.leadHistory.create({
      data: {
        leadId: id,
        type: 'stage_change',
        content: `${oldStage} → ${newStage}`,
        author: authorName,
      },
    });
  }

  return updated;
}

export async function addHistory(orgId: string, leadId: string, data: { type: string; content: string; author: string }) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, orgId } });
  if (!lead) throw new NotFoundError('Lead', leadId);

  return prisma.leadHistory.create({
    data: {
      leadId,
      type: data.type,
      content: data.content,
      author: data.author,
    },
  });
}

export async function toggleChecklist(orgId: string, leadId: string, itemId: string, done: boolean) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, orgId } });
  if (!lead) throw new NotFoundError('Lead', leadId);

  const current = lead.checklistDone ?? [];
  const updated = done
    ? current.includes(itemId) ? current : [...current, itemId]
    : current.filter(i => i !== itemId);

  return prisma.lead.update({
    where: { id: leadId },
    data: { checklistDone: updated },
  });
}
