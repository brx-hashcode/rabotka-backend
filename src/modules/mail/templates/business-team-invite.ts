import { emailButton, escapeHtml } from './layout';

/** How a role reads in an invitation. */
export const BUSINESS_ROLE_LABEL = {
  ADMIN: 'administrateur',
  RECRUITER: 'recruteur',
  REVIEWER: 'évaluateur',
} as const;

const ROLE_SCOPE = {
  ADMIN:
    'gérer les offres et les candidats, l’abonnement, l’organisation et l’équipe',
  RECRUITER:
    'publier les offres, trier les candidats, organiser les entretiens et échanger avec eux',
  REVIEWER: 'consulter les candidats et donner votre avis',
} as const;

/** To someone invited to join a business's space on Rabotka Business. */
export function businessTeamInviteEmail(args: {
  name: string;
  /** Null: sent by Rabotka's team, for the organisation. */
  invitedBy: string | null;
  businessName: string;
  role: keyof typeof BUSINESS_ROLE_LABEL;
  signInUrl: string;
}): string {
  return `
    <p>Bonjour ${escapeHtml(args.name)},</p>
    <p>
      ${
        args.invitedBy
          ? `${escapeHtml(args.invitedBy)} vous invite à rejoindre l’équipe de
      <strong>${escapeHtml(args.businessName)}</strong>`
          : `L’équipe de <strong>${escapeHtml(args.businessName)}</strong> vous
      invite à la rejoindre`
      } sur Rabotka Business,
      en tant que <strong>${BUSINESS_ROLE_LABEL[args.role]}</strong> : vous
      pourrez ${ROLE_SCOPE[args.role]}.
    </p>
    ${emailButton(args.signInUrl, 'Rejoindre l’équipe')}
    <p>
      Connectez-vous avec cette adresse e-mail : un code de connexion vous est
      envoyé à chaque fois, aucun mot de passe à retenir.
    </p>
  `;
}

export function businessTeamInviteSubject(businessName: string): string {
  return `${businessName} vous invite sur Rabotka Business`;
}
