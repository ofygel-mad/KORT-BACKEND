import { prisma } from '../../lib/prisma.js';
import { NotFoundError } from '../../lib/errors.js';
import { normalizeOrgCurrency, normalizeOrgCurrencyInput } from '../../lib/currency.js';

function sanitizeSlug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9а-яё\s-]/gi, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 48) || `company-${Date.now()}`
  );
}

/**
 * Serializes a full organization record including extended profile fields
 * used by the Settings → Организация section.
 */
function serializeOrg(org: {
  id: string;
  name: string;
  slug: string;
  mode: string;
  currency: string;
  industry: string | null;
  onboardingCompleted: boolean;
  legalName: string | null;
  bin: string | null;
  iin: string | null;
  legalForm: string | null;
  director: string | null;
  accountant: string | null;
  address: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  bankName: string | null;
  bankBik: string | null;
  bankAccount: string | null;
  shipmentResponsibleName: string | null;
  shipmentResponsiblePosition: string | null;
  transportOrganization: string | null;
  attorneyNumber: string | null;
  attorneyDate: string | null;
  attorneyIssuedBy: string | null;
}) {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    mode: org.mode,
    currency: normalizeOrgCurrency(org.currency),
    industry: org.industry,
    onboarding_completed: org.onboardingCompleted,
    // Extended profile
    legal_name: org.legalName,
    bin: org.bin,
    iin: org.iin,
    legal_form: org.legalForm,
    director: org.director,
    accountant: org.accountant,
    address: org.address,
    city: org.city,
    phone: org.phone,
    email: org.email,
    website: org.website,
    bank_name: org.bankName,
    bank_bik: org.bankBik,
    bank_account: org.bankAccount,
    shipment_responsible_name: org.shipmentResponsibleName,
    shipment_responsible_position: org.shipmentResponsiblePosition,
    transport_organization: org.transportOrganization,
    attorney_number: org.attorneyNumber,
    attorney_date: org.attorneyDate,
    attorney_issued_by: org.attorneyIssuedBy,
  };
}

export async function getOrganization(orgId: string) {
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) throw new NotFoundError('Organization', orgId);
  return serializeOrg(org);
}

export async function updateOrganization(
  orgId: string,
  data: Record<string, unknown>,
) {
  const s = (v: unknown): string | undefined =>
    typeof v === 'string' ? v.trim() || undefined : undefined;
  const b = (v: unknown): boolean | undefined =>
    typeof v === 'boolean' ? v : undefined;

  const org = await prisma.organization.update({
    where: { id: orgId },
    data: {
      // Core fields
      name: s(data.name),
      slug: data.slug ? sanitizeSlug(String(data.slug)) : undefined,
      mode: s(data.mode),
      currency: normalizeOrgCurrencyInput(data.currency),
      industry: s(data.industry),
      onboardingCompleted: b(data.onboarding_completed),
      // Extended profile
      legalName: s(data.legal_name),
      bin: s(data.bin),
      iin: s(data.iin),
      legalForm: s(data.legal_form),
      director: s(data.director),
      accountant: s(data.accountant),
      address: s(data.address),
      city: s(data.city),
      phone: s(data.phone),
      email: s(data.email),
      website: s(data.website),
      bankName: s(data.bank_name),
      bankBik: s(data.bank_bik),
      bankAccount: s(data.bank_account),
      shipmentResponsibleName: s(data.shipment_responsible_name),
      shipmentResponsiblePosition: s(data.shipment_responsible_position),
      transportOrganization: s(data.transport_organization),
      attorneyNumber: s(data.attorney_number),
      attorneyDate: s(data.attorney_date),
      attorneyIssuedBy: s(data.attorney_issued_by),
    },
  });

  return serializeOrg(org);
}

export async function searchCompanies(query: string) {
  if (!query.trim()) return [];

  const q = query.toLowerCase().trim();
  const results = await prisma.organization.findMany({
    where: {
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { slug: { contains: q, mode: 'insensitive' } },
      ],
    },
    take: 20,
    select: {
      id: true,
      name: true,
      slug: true,
      mode: true,
      currency: true,
      industry: true,
      onboardingCompleted: true,
    },
  });

  return results.map((org) => ({
    id: org.id,
    name: org.name,
    slug: org.slug,
    mode: org.mode,
    currency: normalizeOrgCurrency(org.currency),
    industry: org.industry,
    onboarding_completed: org.onboardingCompleted,
  }));
}
