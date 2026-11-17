import { emailButton, escapeHtml, type MailLanguage } from './layout';

/** How a role reads in an invitation. */
export const BUSINESS_ROLE_LABEL = {
  ADMIN: 'administrateur',
  RECRUITER: 'recruteur',
  REVIEWER: 'évaluateur',
} as const;

const ROLE_LABEL_EN = {
  ADMIN: 'administrator',
  RECRUITER: 'recruiter',
  REVIEWER: 'reviewer',
} as const;

const ROLE_SCOPE = {
  ADMIN:
    'gérer les offres et les candidats, l’abonnement, l’organisation et l’équipe',
  RECRUITER:
    'publier les offres, trier les candidats, organiser les entretiens et échanger avec eux',
  REVIEWER: 'consulter les candidats et donner votre avis',
} as const;

const ROLE_SCOPE_EN = {
  ADMIN:
    'manage jobs and candidates, the subscription, the organisation and the team',
  RECRUITER:
    'publish jobs, sort candidates, organise interviews and talk with them',
  REVIEWER: 'view candidates and give your opinion',
} as const;

type InviteArgs = {
  name: string;
  /** Null: sent by Rabotka's team, for the organisation. */
  invitedBy: string | null;
  businessName: string;
  role: keyof typeof BUSINESS_ROLE_LABEL;
  signInUrl: string;
  /** The reader's language; French unless said. */
  language?: MailLanguage;
};

/** To someone invited to join a business's space on Rabotka Business. */
export function businessTeamInviteEmail(args: InviteArgs): string {
  return args.language === 'en' ? english(args) : french(args);
}

function french(args: InviteArgs): string {
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

function english(args: InviteArgs): string {
  return `
    <p>Hello ${escapeHtml(args.name)},</p>
    <p>
      ${
        args.invitedBy
          ? `${escapeHtml(args.invitedBy)} invites you to join the team of
      <strong>${escapeHtml(args.businessName)}</strong>`
          : `The team of <strong>${escapeHtml(args.businessName)}</strong>
      invites you to join it`
      } on Rabotka Business,
      as <strong>${ROLE_LABEL_EN[args.role]}</strong>: you will be able to
      ${ROLE_SCOPE_EN[args.role]}.
    </p>
    ${emailButton(args.signInUrl, 'Join the team')}
    <p>
      Sign in with this email address: a sign-in code is sent to you each
      time, no password to remember.
    </p>
  `;
}

export function businessTeamInviteSubject(
  businessName: string,
  language: MailLanguage = 'fr',
): string {
  return language === 'en'
    ? `${businessName} invites you to Rabotka Business`
    : `${businessName} vous invite sur Rabotka Business`;
}
