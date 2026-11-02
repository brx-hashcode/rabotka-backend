import { ExternalApplicationStatus, Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { LayoutService } from '../../mail/layout.service';
import { MailService } from '../../mail/mail.service';
import { applicationClosedEmail } from '../../mail/templates/external-application';

/** Also how `apply` knows the candidate may try again on a republished offer. */
export const CLOSED_OFFER_REFUSAL = 'Cette offre est maintenant fermée.';

/**
 * Closes the outside applications matching `where`, one email each.
 *
 * A plain function because the worker has no CareersService: the employer's
 * close calls this from the API, and the 15-minute scan from the worker. The
 * guarded update is what keeps the two from emailing a candidate twice.
 */
export async function refuseOutsideCandidates(
  deps: { prisma: PrismaService; mail: MailService; layout: LayoutService },
  where: Prisma.ExternalApplicationWhereInput,
  onMailError: (err: unknown) => void,
): Promise<number> {
  const waiting = await deps.prisma.externalApplication.findMany({
    where: { ...where, status: ExternalApplicationStatus.PENDING },
    select: {
      id: true,
      email: true,
      first_name: true,
      job_offer: {
        select: {
          title: true,
          employer: { select: { business: { select: { name: true } } } },
        },
      },
    },
  });

  let refused = 0;
  for (const application of waiting) {
    const { count } = await deps.prisma.externalApplication.updateMany({
      where: {
        id: application.id,
        status: ExternalApplicationStatus.PENDING,
      },
      data: {
        status: ExternalApplicationStatus.REFUSED,
        refused_at: new Date(),
        refusal_message: CLOSED_OFFER_REFUSAL,
      },
    });
    if (count === 0) continue;
    refused += 1;

    const name =
      application.job_offer.employer.business?.name ?? 'Le recruteur';
    const subject = `Votre candidature chez ${name}`;
    try {
      await deps.mail.sendMail({
        to: application.email,
        subject,
        html: await deps.layout.wrap(
          applicationClosedEmail(
            application.first_name,
            name,
            application.job_offer.title,
          ),
          { previewText: subject, product: 'business' },
        ),
      });
    } catch (err) {
      onMailError(err);
    }
  }
  return refused;
}
