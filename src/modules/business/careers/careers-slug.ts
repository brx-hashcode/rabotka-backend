import type { Prisma } from '@prisma/client';

const MAX_LENGTH = 60;
/** Paths of the careers API that a slug would shadow. */
const RESERVED = new Set(['sitemap', 'feed', 'offers', 'partners']);

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

/**
 * The first free slug for this name: `kamoa`, then `kamoa-2`, `kamoa-3`…
 *
 * A slug a business had before a rename is taken too: it still leads to that
 * business (CareersService redirects it), so nobody else may have it. The
 * business's own old slugs are not — `ownId` lets it take one back when it
 * returns to a former name.
 */
export async function uniqueBusinessSlug(
  tx: Pick<Prisma.TransactionClient, 'business'>,
  name: string,
  ownId?: string,
): Promise<string> {
  const base = slugBase(name);
  const rows: {
    id?: string;
    public_slug: string | null;
    previous_slugs?: string[];
  }[] = await tx.business.findMany({
    where: {
      // Renames are rare: every business with an old slug is a short list.
      OR: [
        { public_slug: { startsWith: base } },
        { previous_slugs: { isEmpty: false } },
      ],
    },
    select: { id: true, public_slug: true, previous_slugs: true },
  });
  const taken = new Set<string | null>(RESERVED);
  for (const r of rows) {
    if (ownId && r.id === ownId) continue;
    taken.add(r.public_slug);
    for (const s of r.previous_slugs ?? []) taken.add(s);
  }
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/** Whether `slug` was made from `name`: `kamoa` or `kamoa-3` for « Kamoa ». */
export function slugFitsName(slug: string | null, name: string): boolean {
  if (!slug) return false;
  const base = slugBase(name);
  return slug === base || new RegExp(`^${base}-\\d+$`).test(slug);
}

/**
 * The slug fields after a rename, or nothing when the slug already fits the
 * name. The careers page's address follows the business's name; the old one
 * is kept in `previous_slugs`, so links already shared (WhatsApp, posters,
 * job sites) lead to the new one.
 */
export async function slugAfterRename(
  tx: Pick<Prisma.TransactionClient, 'business'>,
  business: {
    id: string;
    public_slug: string | null;
    previous_slugs: string[];
  },
  name: string,
): Promise<{ public_slug: string; previous_slugs: string[] } | null> {
  if (slugFitsName(business.public_slug, name)) return null;
  const slug = await uniqueBusinessSlug(tx, name, business.id);
  const previous = business.previous_slugs.filter((s) => s !== slug);
  if (business.public_slug && business.public_slug !== slug) {
    previous.push(business.public_slug);
  }
  return { public_slug: slug, previous_slugs: previous };
}
