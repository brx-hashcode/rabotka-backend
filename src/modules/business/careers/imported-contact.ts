import { ExternalApplicationOrigin, Prisma } from '@prisma/client';
import type { PrismaService } from '../../../common/services/prisma/prisma.service';

/** What a CV analysis read of the candidate (`CvCandidate`): only what is used here. */
type ReadContact = {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** « Julien MBONGOLO » → Julien / MBONGOLO; one word is a first name. */
export function splitName(full: string): { first: string; last: string } {
  const words = full.trim().split(/\s+/).filter(Boolean);
  return {
    first: (words[0] ?? '').slice(0, 80),
    last: words.slice(1).join(' ').slice(0, 80),
  };
}

/**
 * An imported CV has no name or contact of its own: once its analysis read
 * them, they become the candidate's, so the card has a name and the e-mails a
 * careers candidate gets (refusal, retained, offer closed) reach them too.
 * Never an address already on another candidate of the offer (the same person
 * applied, or was imported twice): that one stays without, rather than failing.
 * Does nothing for a careers-page application: they typed their own.
 */
export async function fillImportedContact(
  prisma: PrismaService,
  resumeId: string,
  read: ReadContact | null | undefined,
): Promise<void> {
  if (!read) return;
  const application = await prisma.externalApplication.findFirst({
    where: { cv_resume_id: resumeId, origin: ExternalApplicationOrigin.IMPORT },
    select: { id: true, job_offer_id: true, email: true, phone: true },
  });
  if (!application) return;

  const data: Prisma.ExternalApplicationUpdateInput = {};
  const name = read.name?.trim();
  if (name) {
    const { first, last } = splitName(name);
    data.first_name = first;
    data.last_name = last;
  }
  const phone = read.phone?.trim();
  if (!application.phone && phone) data.phone = phone.slice(0, 40);
  const email = read.email?.trim().toLowerCase();
  if (!application.email && email && EMAIL.test(email) && email.length <= 254) {
    const taken = await prisma.externalApplication.findFirst({
      where: {
        job_offer_id: application.job_offer_id,
        email,
        id: { not: application.id },
      },
      select: { id: true },
    });
    if (!taken) data.email = email;
  }
  if (Object.keys(data).length === 0) return;

  try {
    await prisma.externalApplication.update({
      where: { id: application.id },
      data,
    });
  } catch (err) {
    // The same address landed on another candidate meanwhile: the rest still.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002' &&
      data.email
    ) {
      delete data.email;
      await prisma.externalApplication.update({
        where: { id: application.id },
        data,
      });
      return;
    }
    throw err;
  }
}
