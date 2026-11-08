import { stripContacts } from '../../profile-cv/strip-contacts';
import type { ApplicantFacts } from './applicant-assessment';

const day = (d: Date) =>
  d.toLocaleDateString('fr-FR', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

/**
 * A Rabotka applicant's CV as text, for CV analysis: what their Rabotka CV
 * says, then « Mon CV » when they sent it. Their answers to the offer's
 * questions go beside it (`CvUpload.answers`), read as answers, not as CV. Never their contacts, which stay
 * paid: the uploaded file has them printed on it, so it is its text (already
 * stripped) that goes, and the whole is stripped once more, since the
 * presentation is free text too.
 */
export function applicantCvText(name: string, a: ApplicantFacts): string {
  const lines = [
    name,
    a.trades.length ? `Métiers : ${a.trades.join(', ')}` : null,
    [a.city, a.country].some(Boolean)
      ? `Ville : ${[a.city, a.country].filter(Boolean).join(', ')}`
      : null,
    `Membre de Rabotka depuis ${day(a.memberSince)}`,
    a.ratingCount > 0 && a.ratingAvg !== null
      ? `Note des employeurs : ${a.ratingAvg.toFixed(1).replace('.', ',')}/5 (${a.ratingCount} avis)`
      : null,
    '',
    a.description?.trim() ? `Présentation\n${a.description.trim()}` : null,
    a.missions.length
      ? `Missions menées à terme sur Rabotka\n${a.missions
          .map(
            (m) =>
              `- ${m.title}${m.trade ? ` (${m.trade})` : ''}${m.completedAt ? `, ${day(m.completedAt)}` : ''}`,
          )
          .join('\n')}`
      : 'Missions menées à terme sur Rabotka : aucune pour l’instant',
    a.portfolio.length
      ? `Réalisations publiées\n${a.portfolio.map((p) => `- ${p}`).join('\n')}`
      : null,
    a.cvText?.trim() ? `\nCV joint par le candidat\n${a.cvText.trim()}` : null,
  ];
  return stripContacts(
    lines.filter((l): l is string => l !== null).join('\n'),
  ).trim();
}
