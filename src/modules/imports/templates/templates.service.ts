/**
 * templates.service.ts
 * CRUD for saved import mapping templates.
 */

import { prisma } from '../../../lib/prisma.js';
import { AppError } from '../../../lib/errors.js';

export interface CreateTemplateDto {
  name: string;
  target: string;
  mapping: Record<string, string>;
  headerRowIndex?: number;
  dataStartRow?: number;
  sheetName?: string;
}

export async function listTemplates(orgId: string) {
  return prisma.importTemplate.findMany({
    where: { orgId },
    orderBy: [{ usedCount: 'desc' }, { createdAt: 'desc' }],
  });
}

export async function createTemplate(orgId: string, dto: CreateTemplateDto) {
  return prisma.importTemplate.create({
    data: {
      orgId,
      name: dto.name,
      target: dto.target,
      mapping: dto.mapping,
      headerRowIndex: dto.headerRowIndex ?? 0,
      dataStartRow: dto.dataStartRow ?? 1,
      sheetName: dto.sheetName,
    },
  });
}

export async function deleteTemplate(orgId: string, id: string) {
  const t = await prisma.importTemplate.findFirst({ where: { id, orgId } });
  if (!t) throw new AppError(404, 'Template not found');
  await prisma.importTemplate.delete({ where: { id } });
}

export async function touchTemplate(orgId: string, id: string) {
  await prisma.importTemplate.updateMany({
    where: { id, orgId },
    data: { usedCount: { increment: 1 }, lastUsedAt: new Date() },
  });
}

/** Find templates whose mapping keys overlap with given headers */
export async function findSimilar(orgId: string, headers: string[]): Promise<Array<{
  id: string; name: string; target: string; overlap: number;
}>> {
  const all = await prisma.importTemplate.findMany({ where: { orgId } });
  const norm = headers.map((h) => h.toLowerCase().trim());

  return all
    .map((t) => {
      const keys = Object.keys(t.mapping as Record<string, string>).map((k) => k.toLowerCase().trim());
      const overlap = keys.filter((k) => norm.some((n) => n.includes(k) || k.includes(n))).length;
      return { id: t.id, name: t.name, target: t.target, overlap };
    })
    .filter((r) => r.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, 3);
}
