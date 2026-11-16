import { escapeHtml, type MailLanguage } from './layout';

/**
 * What a code is for. The subject and the sentence around the code say it,
 * so a business creating its account, someone logging in to the client app,
 * an admin and an agent never receive the same undifferentiated message.
 */
export type OtpPurpose =
  'business-signup' | 'business-login' | 'login' | 'admin' | 'agent';

const COPY: Record<
  OtpPurpose,
  { subject: string; intro: string; signOff: string }
> = {
  'business-signup': {
    subject: 'Votre code pour créer votre compte Rabotka Business',
    intro:
      'Pour confirmer votre adresse e-mail et créer le compte de votre organisation sur Rabotka Business, saisissez ce code :',
    signOff: "L'équipe Rabotka Business",
  },
  'business-login': {
    subject: 'Votre code de connexion à Rabotka Business',
    intro:
      'Pour vous connecter à votre espace Rabotka Business, saisissez ce code :',
    signOff: "L'équipe Rabotka Business",
  },
  login: {
    subject: 'Votre code de connexion à Rabotka',
    intro: 'Pour vous connecter à Rabotka, saisissez ce code :',
    signOff: "L'équipe Rabotka",
  },
  admin: {
    subject: "Votre code de connexion à l'administration Rabotka",
    intro:
      "Pour vous connecter à l'administration Rabotka, saisissez ce code :",
    signOff: "L'équipe Rabotka",
  },
  agent: {
    subject: 'Votre code de connexion Rabotka Agent',
    intro:
      'Pour vous connecter à votre espace agent Rabotka, saisissez ce code :',
    signOff: "L'équipe Rabotka",
  },
};

const COPY_EN: typeof COPY = {
  'business-signup': {
    subject: 'Your code to create your Rabotka Business account',
    intro:
      'To confirm your email address and create your organisation’s account on Rabotka Business, enter this code:',
    signOff: 'The Rabotka Business team',
  },
  'business-login': {
    subject: 'Your Rabotka Business sign-in code',
    intro: 'To sign in to your Rabotka Business workspace, enter this code:',
    signOff: 'The Rabotka Business team',
  },
  login: {
    subject: 'Your Rabotka sign-in code',
    intro: 'To sign in to Rabotka, enter this code:',
    signOff: 'The Rabotka team',
  },
  admin: {
    subject: 'Your Rabotka administration sign-in code',
    intro: 'To sign in to the Rabotka administration, enter this code:',
    signOff: 'The Rabotka team',
  },
  agent: {
    subject: 'Your Rabotka Agent sign-in code',
    intro: 'To sign in to your Rabotka agent workspace, enter this code:',
    signOff: 'The Rabotka team',
  },
};

export function otpEmailSubject(
  purpose: OtpPurpose,
  language: MailLanguage = 'fr',
): string {
  return (language === 'en' ? COPY_EN : COPY)[purpose].subject;
}

/** The inbox preview: the purpose and the code, readable without opening. */
export function otpEmailPreview(
  purpose: OtpPurpose,
  code: string,
  language: MailLanguage = 'fr',
): string {
  return language === 'en'
    ? `${COPY_EN[purpose].subject}: ${code}`
    : `${COPY[purpose].subject} : ${code}`;
}

export function sendOtpEmail(
  code: string,
  first_name?: string,
  purpose: OtpPurpose = 'login',
  language: MailLanguage = 'fr',
): string {
  if (language === 'en') {
    const copy = COPY_EN[purpose];
    return `
    <p>${first_name ? `Hello ${escapeHtml(first_name)},` : 'Hello,'}</p>

    <p>${copy.intro}</p>

    <p style="margin:20px 0;">
      <span style="display:inline-block;padding:12px 20px;border-radius:6px;background:#f5f4ef;font-size:28px;font-weight:600;letter-spacing:6px;color:#2a322e;">${escapeHtml(code)}</span>
    </p>

    <p>
      For security reasons, this code is valid for
      <strong>5 minutes</strong>. Do not share it with anyone: our team will
      never ask you for it.
    </p>

    <p>
      If you did not request this code, you can ignore this email.
    </p>

    <p>
      Kind regards,<br />
      <strong>${copy.signOff}</strong>
    </p>
  `;
  }
  // The name is whatever the profile typed, and this mail can go to an address
  // the profile chose — escaped like every other template (pentest A2-F17, #873).
  const greeting = first_name
    ? `Bonjour ${escapeHtml(first_name)},`
    : 'Bonjour,';
  const copy = COPY[purpose];
  return `
    <p>${greeting}</p>

    <p>${copy.intro}</p>

    <p style="margin:20px 0;">
      <span style="display:inline-block;padding:12px 20px;border-radius:6px;background:#f5f4ef;font-size:28px;font-weight:600;letter-spacing:6px;color:#2a322e;">${escapeHtml(code)}</span>
    </p>

    <p>
      Pour des raisons de sécurité, ce code est valable pendant
      <strong>5 minutes</strong>. Ne le communiquez à personne : notre équipe
      ne vous le demandera jamais.
    </p>

    <p>
      Si vous n'avez pas demandé ce code, vous pouvez ignorer cet e-mail.
    </p>

    <p>
      Cordialement,<br />
      <strong>${copy.signOff}</strong>
    </p>
  `;
}
