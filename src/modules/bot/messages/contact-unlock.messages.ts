export function formatContactUnlockPrompt(params: {
  name: string;
  amount: number;
  balance: number;
  profileType: 'WORKER' | 'EMPLOYER';
  isJobLevel?: boolean;
}): string {
  const { name, amount, balance, profileType, isJobLevel } = params;
  const role = profileType === 'EMPLOYER' ? 'travailleur' : 'employeur';
  const hasFunds = balance >= amount;

  const scopeNote =
    profileType === 'EMPLOYER' && isJobLevel
      ? [
          'Ce paiement *couvre tous les candidats acceptés* pour ce poste.',
          "Vous ne payez qu'une seule fois, peu importe le nombre de candidats.",
          '',
        ]
      : [];

  const fundOptions = hasFunds
    ? [
        `1- Utiliser mon crédit (${amount} FCFA)`,
        '2- Payer par mobile money',
        '3- Décider plus tard',
      ]
    : ['1- Payer par mobile money', '2- Décider plus tard'];

  const insufficientFundsWarning = hasFunds
    ? []
    : [`⚠️ *Solde insuffisant* (${balance} FCFA disponibles)`];

  return [
    `*DÉVERROUILLAGE DU CONTACT*`,
    '',
    `Pour voir les coordonnées de votre ${role} *${name}*, vous devez débloquer le contact.`,
    '',
    ...scopeNote,
    `*Frais de déverrouillage*: ${amount} FCFA`,
    `*Solde de votre portefeuille*: ${balance} FCFA`,
    '',
    ...insufficientFundsWarning,
    ...(insufficientFundsWarning.length ? [''] : []),
    '*Choisissez une option* :',
    '',
    ...fundOptions,
    '',
    'Tapez le numéro correspondant.',
  ].join('\n');
}

export function formatContactUnlockedMessage(params: {
  name: string;
  phone: string | null;
  email: string | null;
}): string {
  const { name, phone, email } = params;

  // Normalize phone to digits only (strip +, spaces, dashes) for WhatsApp link
  const waPhone = phone ? phone.replace(/\D/g, '') : null;
  const waLink = waPhone ? `https://wa.me/${waPhone}` : null;

  const contactLines = [
    ...(phone ? [`*Téléphone*: ${phone}`] : []),
    ...(waLink ? [`*WhatsApp*: ${waLink}`] : []),
    ...(email ? [`*Email*: ${email}`] : []),
  ];

  return [
    '*CONTACT DÉVERROUILLÉ !*',
    '',
    `*${name}*`,
    '',
    ...contactLines,
    '',
    'Tapez *Menu* pour revenir au menu principal.',
  ].join('\n');
}

export function formatContactUnlockPending(params: {
  waitingFor: 'worker' | 'employer';
  otherName: string;
  expiresAt: Date | string;
}): string {
  const { waitingFor, otherName, expiresAt } = params;
  const party = waitingFor === 'worker' ? 'travailleur' : 'employeur';
  const deadline = new Date(expiresAt).toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return [
    '*PAIEMENT ENREGISTRÉ*',
    '',
    'Votre paiement a bien été enregistré.',
    '',
    `*En attente du paiement du ${party} (${otherName}).*`,
    '',
    `Une fois le paiement confirmé des deux côtés (vous et ${otherName}), vous recevrez automatiquement les coordonnées.`,
    '',
    `Si l'autre partie ne paie pas avant le *${deadline}*, votre paiement sera reversé vers votre wallet interne.`,
  ].join('\n');
}

export function formatContactUnlockExpiredConversion(amount: number): string {
  return [
    '*DÉVERROUILLAGE EXPIRÉ*',
    '',
    'Le délai de déverrouillage de contact a expiré.',
    '',
    `*${amount} FCFA* ont été recrédités sur votre portefeuille.`,
  ].join('\n');
}
