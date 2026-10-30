import type { Prisma } from '@prisma/client';

const MAX_LENGTH = 60;

/** « Café du Port & Fils » becomes `cafe-du-port-fils`. */
export function slugBase(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, MAX_LENGTH)
    .replace(/^-+|-+$/g, '');
  return slug || 'entreprise';
}

/** The first free slug for this name: `kamoa`, then `kamoa-2`, `kamoa-3`… */
export async function uniqueBusinessSlug(
  tx: Pick<Prisma.TransactionClient, 'business'>,
  name: string,
): Promise<string> {
  const base = slugBase(name);
  const rows = await tx.business.findMany({
    where: { public_slug: { startsWith: base } },
    select: { public_slug: true },
  });
  const taken = new Set(rows.map((r) => r.public_slug));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}
