import { templateReply } from '../../../common/constants/whatsapp-carousel';
import { WHATSAPP_TEMPLATES } from '../../../common/constants/whatsapp-templates';
import type { PortfolioService } from '../../portfolio/portfolio.service';

/** Shown instead of the button when the slug cannot be resolved. */
export const PORTFOLIO_UNAVAILABLE =
  "Portfolio indisponible pour ce profil pour le moment.\n\nTapez le numéro d'une autre action.";

/**
 * A bot reply carrying the "Voir le portfolio" CTA template for one worker: a
 * URL button that opens `/p/<slug>` inside WhatsApp's in-app browser (the page
 * is public, so no login step).
 *
 * The slug is minted on demand via PortfolioService.ensurePortfolioSlug —
 * workers who never uploaded a realization have none, and their public page is
 * still worth showing (name, note, fiabilité, missions terminées).
 *
 * Never throws: a portfolio link failing must not break the flow it is embedded
 * in (contact unlock, accept/refuse), so any error degrades to a plain-text
 * message and the caller keeps its state.
 */
export async function buildPortfolioReply(
  workerId: string,
  workerName: string,
  portfolioService: PortfolioService,
): Promise<string> {
  try {
    const slug = await portfolioService.ensurePortfolioSlug(workerId);
    return templateReply(
      WHATSAPP_TEMPLATES.viewWorkerPortfolio.contentSid,
      WHATSAPP_TEMPLATES.viewWorkerPortfolio.variables({
        workerName,
        slug,
      }),
    );
  } catch {
    return PORTFOLIO_UNAVAILABLE;
  }
}
