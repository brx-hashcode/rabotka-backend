/**
 * The CVs `cv-eval.ts` measures the scoring on. Every person, employer and
 * contact here is invented: never put a real candidate's CV in this file.
 *
 * Each job has strong, partial and weak CVs, and some made to mislead a naive
 * score: near but unqualified, qualified but far, no dates, keywords only.
 * How well each FITS is rated by a person, in the ratings sheet, not here.
 * `musts` are facts of the text, so they can be written down: 'MET' when the CV
 * says it, 'MISSING' when it says the contrary, 'UNCLEAR' when it says nothing.
 */
export type MustFact = 'MET' | 'MISSING' | 'UNCLEAR';

export type EvalJob = {
  id: string;
  title: string;
  text: string;
  musts: { key: string; label: string }[];
};

export type EvalCv = {
  id: string;
  job: string;
  text: string;
  musts: Record<string, MustFact>;
};

export const JOBS: EvalJob[] = [
  {
    id: 'compta',
    title: 'Comptable',
    text: `Type : CDI
Métier : Comptabilité
Lieu : Pointe-Noire, Congo

Nous recherchons un ou une comptable pour une société de négoce. Missions : saisie et contrôle des écritures, rapprochements bancaires, déclarations fiscales et sociales (TVA, IUTS, CNSS), préparation du bilan selon le SYSCOHADA.
Profil : diplôme Bac+3 en comptabilité ou gestion obligatoire, trois ans d'expérience minimum dans un poste comparable, maîtrise de Sage Comptabilité et d'Excel. Rigueur et respect des délais.`,
    musts: [
      { key: 'diploma', label: 'Bac+3 en comptabilité ou gestion' },
      { key: 'years', label: 'Trois ans d’expérience comptable' },
    ],
  },
  {
    id: 'livreur',
    title: 'Chauffeur-livreur',
    text: `Type : CDD
Métier : Transport
Lieu : Brazzaville, Congo

Livraison de produits alimentaires aux boutiques et restaurants. Chargement, tournées, encaissement, entretien courant du véhicule.
Profil : permis B en cours de validité obligatoire, deux ans de conduite professionnelle, bonne connaissance des quartiers de Brazzaville, ponctualité, sens du contact avec les clients. Notions de mécanique appréciées.`,
    musts: [{ key: 'licence', label: 'Permis B' }],
  },
  {
    id: 'dev',
    title: 'Full-stack web developer',
    text: `Type: CDI
Trade: Software development
Place: remote

You build and maintain our booking platform with a team of four. React, TypeScript and Node.js every day, PostgreSQL for the data, automated tests, code reviews in English.
Profile: at least two years in a similar position, solid TypeScript, React and Node.js, working knowledge of SQL, professional written English (required). Docker and CI are a plus.`,
    musts: [{ key: 'english', label: 'Professional written English' }],
  },
  {
    id: 'rh',
    title: 'Assistant ou assistante RH',
    text: `Type : CDD
Métier : Ressources humaines
Lieu : Brazzaville, Congo

Administration du personnel d'une entreprise de 120 salariés : contrats, dossiers, congés, préparation de la paie, déclarations CNSS, publication d'offres et organisation des entretiens.
Profil : Bac+3 en ressources humaines ou droit social, trois ans d'expérience en administration du personnel, maîtrise de Word et Excel, discrétion. La connaissance d'un logiciel de paie est un plus.`,
    musts: [{ key: 'diploma', label: 'Bac+3 en RH ou droit social' }],
  },
  {
    id: 'elec',
    title: 'Électricien bâtiment',
    text: `Type : CDI
Métier : Électricité
Lieu : Abidjan, Côte d'Ivoire

Installation électrique de logements et de bureaux : tirage de câbles, pose de tableaux, mise aux normes, dépannage, lecture de plans.
Profil : CAP ou BT en électricité, deux ans de chantier minimum, habilitation électrique obligatoire, travail en hauteur, autonomie. La pose de panneaux solaires est un plus.`,
    musts: [{ key: 'clearance', label: 'Habilitation électrique' }],
  },
];

export const CVS: EvalCv[] = [
  // ── Comptable ──────────────────────────────────────────────────────
  {
    id: 'compta-1',
    job: 'compta',
    musts: { diploma: 'MET', years: 'MET' },
    text: `Clarisse Ngoma
Comptable — Pointe-Noire
EXPÉRIENCE
Comptable, Atlantique Négoce, Pointe-Noire, 03/2020 à aujourd'hui (CDI). Tenue complète de la comptabilité sur Sage Comptabilité 100, rapprochements bancaires de quatre banques, déclarations mensuelles de TVA, IUTS et CNSS, préparation du bilan SYSCOHADA avec le cabinet. Délai de clôture mensuelle ramené de 15 à 8 jours.
Assistante comptable, Cabinet Mbou & Associés, 06/2018 à 02/2020. Saisie, lettrage, classement.
FORMATION
Licence en comptabilité et gestion, Université Marien Ngouabi, 2018.
OUTILS : Sage Comptabilité, Excel (tableaux croisés), Word. LANGUES : français.`,
  },
  {
    id: 'compta-2',
    job: 'compta',
    musts: { diploma: 'MET', years: 'MET' },
    text: `Didier Essomba
Responsable comptable — Douala, Cameroun (mobile)
Chef comptable adjoint, Industries du Wouri, Douala, 01/2015 à aujourd'hui. Supervision de trois comptables, états financiers SYSCOHADA, liasse fiscale, relations avec les commissaires aux comptes, Sage X3 et Sage 100.
Comptable, Transit Littoral, Douala, 2011 à 2014. Comptabilité générale, TVA, CNPS.
Master en comptabilité, contrôle et audit, Université de Douala, 2011. Excel avancé.
Français et anglais courants. Prêt à s'installer à Pointe-Noire.`,
  },
  {
    id: 'compta-3',
    job: 'compta',
    musts: { diploma: 'MET', years: 'MISSING' },
    text: `Ruth Malonga
Jeune diplômée en comptabilité — Pointe-Noire
Stage de fin d'études, service comptable, Port Logistique, 02/2026 à 07/2026. Saisie de factures fournisseurs sur Sage, rapprochements bancaires sous contrôle, classement.
Licence professionnelle comptabilité-finance, 2026, mention bien. Projet : états financiers SYSCOHADA d'une PME.
Excel, Word, notions de Sage Comptabilité. Français. Aucune autre expérience professionnelle.`,
  },
  {
    id: 'compta-4',
    job: 'compta',
    musts: { diploma: 'MISSING', years: 'MET' },
    text: `Patrice Okemba
Aide-comptable — Pointe-Noire
Aide-comptable, Quincaillerie du Port, 2016 à aujourd'hui. Saisie des écritures sur Sage Comptabilité, caisse, rapprochements bancaires, préparation des pièces pour la TVA et la CNSS.
Caissier, Supermarché Océan, 2013 à 2016.
Baccalauréat G2, 2012. Pas d'études supérieures ; formation interne Sage, 2017.
Excel, Sage. Français, kituba.`,
  },
  {
    id: 'compta-5',
    job: 'compta',
    musts: { diploma: 'MISSING', years: 'MISSING' },
    text: `Grâce Tchicaya
Vendeuse — Pointe-Noire, quartier Mpita
Vendeuse en boutique de vêtements, 2021 à aujourd'hui : accueil, vente, caisse, mise en rayon.
Serveuse, restaurant La Plage, 2019 à 2021.
Niveau terminale. Français, lingala. Habite à dix minutes du centre. Motivée pour apprendre la comptabilité, sans expérience ni diplôme dans ce domaine.`,
  },
  {
    id: 'compta-6',
    job: 'compta',
    musts: { diploma: 'UNCLEAR', years: 'UNCLEAR' },
    text: `Serge Bemba
Comptable
Compétences : comptabilité générale, Sage Comptabilité, Excel, TVA, IUTS, CNSS, SYSCOHADA, bilan, rapprochements bancaires, rigueur, respect des délais.
Parcours : plusieurs postes dans des entreprises de la place en comptabilité et gestion.
Langues : français. Disponible immédiatement à Pointe-Noire. Références sur demande.`,
  },
  // ── Chauffeur-livreur ──────────────────────────────────────────────
  {
    id: 'livreur-1',
    job: 'livreur',
    musts: { licence: 'MET' },
    text: `Alphonse Mabiala
Chauffeur-livreur — Brazzaville
Chauffeur-livreur, Boissons du Pool, Brazzaville, 05/2021 à aujourd'hui. Tournées quotidiennes dans Bacongo, Poto-Poto, Talangaï et Moungali, 40 clients par jour, encaissement, zéro accident en quatre ans. Vidange et petites réparations.
Chauffeur de taxi, Brazzaville, 2018 à 2021.
Permis B et C valides jusqu'en 2030. BEPC. Français, lingala.`,
  },
  {
    id: 'livreur-2',
    job: 'livreur',
    musts: { licence: 'MISSING' },
    text: `Jonas Ibara
Coursier à moto — Brazzaville
Livreur à moto, Express Repas, Brazzaville, 2022 à aujourd'hui. Livraison de repas, encaissement, très bonne connaissance de tous les quartiers, 50 courses par jour.
Permis A (moto) uniquement ; je n'ai pas encore le permis B, inscription prévue.
Bon contact avec les clients, ponctuel. Lingala, français.`,
  },
  {
    id: 'livreur-3',
    job: 'livreur',
    musts: { licence: 'MET' },
    text: `Hubert Ossete
Chauffeur poids lourd — Ouesso
Chauffeur grumier, Société Forestière du Nord, Ouesso, 2012 à aujourd'hui. Transport de bois sur longue distance, entretien du camion, mécanique.
Permis B, C et E valides. Mécanicien de formation (CAP, 2010).
Je cherche à venir à Brazzaville, ville que je connais peu. Français, lingala.`,
  },
  {
    id: 'livreur-4',
    job: 'livreur',
    musts: { licence: 'UNCLEAR' },
    text: `Fidèle Loubaki
Brazzaville
Manutentionnaire, dépôt alimentaire Savorgnan, 2020 à aujourd'hui. Chargement et déchargement des camions, préparation des commandes, accompagnement du chauffeur pendant les tournées chez les commerçants.
Gardien, 2018 à 2020.
Ponctuel, sérieux, connaît bien les clients et les quartiers. Français, lingala.`,
  },
  {
    id: 'livreur-5',
    job: 'livreur',
    musts: { licence: 'MET' },
    text: `Mireille Koumba
Assistante administrative — Brazzaville
Assistante de direction, Agence Fleuve, 2017 à aujourd'hui : courrier, agenda, accueil, classement.
BTS secrétariat bureautique, 2016. Permis B obtenu en 2019, conduite personnelle.
Word, Excel. Français, anglais scolaire.`,
  },
  {
    id: 'livreur-6',
    job: 'livreur',
    musts: { licence: 'MET' },
    text: `Trésor Ngatsé
Chauffeur — Brazzaville
Chauffeur de direction, ONG Santé Bassin, Brazzaville, 01/2024 à 12/2025. Transport du personnel, courses en ville, carnet d'entretien du véhicule.
Livreur-vendeur à mi-temps, Pain Doré, Brazzaville, 2023.
Permis B depuis 2020. Français, lingala, munukutuba.`,
  },
  // ── Developer ──────────────────────────────────────────────────────
  {
    id: 'dev-1',
    job: 'dev',
    musts: { english: 'MET' },
    text: `Amina Diallo
Full-stack developer — Dakar, Senegal
Full-stack developer, TicketWave (remote), 02/2022 to present. React and TypeScript front end, Node.js (NestJS) API, PostgreSQL, Jest and Playwright tests, GitHub Actions, Docker. Cut the checkout page load time by 40%. Daily work and code reviews in English with a team in Kenya and the UK.
Front-end developer, Agence Baobab, Dakar, 2020 to 2022. React, REST APIs.
MSc in Computer Science, Dakar, 2020. English fluent (C1), French native.`,
  },
  {
    id: 'dev-2',
    job: 'dev',
    musts: { english: 'MET' },
    text: `Kevin Mensah
Software engineer — Accra, Ghana
Backend engineer, PayRoute, Accra, 2019 to present. Java and Spring services, PostgreSQL, Docker, CI pipelines. Some TypeScript on an internal admin page (2025).
BSc Computer Engineering, 2018. Native English speaker, documentation and reviews written in English. Learning React through a personal project.`,
  },
  {
    id: 'dev-3',
    job: 'dev',
    musts: { english: 'MISSING' },
    text: `Yannick Moukala
Développeur web — Brazzaville
Développeur full-stack, Studio Fleuve, 2021 à aujourd'hui. Applications React, TypeScript et Node.js, PostgreSQL, tests Jest, Docker. Plateforme de réservation pour trois hôtels.
Licence en informatique, 2021.
Langues : français courant, anglais débutant (je ne travaille pas encore en anglais).`,
  },
  {
    id: 'dev-4',
    job: 'dev',
    musts: { english: 'UNCLEAR' },
    text: `Junior Elenga
Formation développeur web — Pointe-Noire
Bootcamp développement web de six mois, 2026 : HTML, CSS, JavaScript, React, Node.js, PostgreSQL. Projets : une liste de tâches et un petit site de recettes.
Technicien informatique, cybercafé, 2022 à 2025 : dépannage, installation.
Curieux et autonome. GitHub sur demande.`,
  },
  {
    id: 'dev-5',
    job: 'dev',
    musts: { english: 'MET' },
    text: `Sarah Okafor
Community manager — Lagos, Nigeria
Community manager, Bright Media, 2020 to present: content, campaigns, reporting, WordPress updates.
BA in Communication, 2019. Fluent English. Keywords of interest: React, TypeScript, Node.js, SQL, Docker, CI.`,
  },
  {
    id: 'dev-6',
    job: 'dev',
    musts: { english: 'MET' },
    text: `Thierry Nkodia
Web developer — Libreville, Gabon
Freelance developer, 06/2023 to present. React and TypeScript front ends, Express APIs, MySQL, for clients in France and Canada. Written English used every day with two clients.
WordPress integrator, 2021 to 2023.
Two-year diploma in networks and software, 2021. Git, basic Docker.`,
  },
  // ── Assistant RH ───────────────────────────────────────────────────
  {
    id: 'rh-1',
    job: 'rh',
    musts: { diploma: 'MET' },
    text: `Prisca Mouanda
Gestionnaire du personnel — Brazzaville
Assistante RH, Télécom Congo Services, 04/2021 à aujourd'hui. Contrats et dossiers de 150 salariés, congés et absences, préparation de la paie sur Sage Paie, déclarations CNSS, publication des offres et planification des entretiens.
Stagiaire RH, Ministère de la Fonction publique, 2020.
Licence en gestion des ressources humaines, 2020. Word, Excel avancé. Français.`,
  },
  {
    id: 'rh-2',
    job: 'rh',
    musts: { diploma: 'MET' },
    text: `Bienvenu Samba
Juriste — Brazzaville
Juriste en droit social, Cabinet Équité, 2019 à aujourd'hui. Rédaction de contrats de travail, conseil aux entreprises sur les licenciements, suivi des contentieux, relations avec l'Inspection du travail et la CNSS.
Master en droit social, 2018. Word. Aucune pratique de la paie.`,
  },
  {
    id: 'rh-3',
    job: 'rh',
    musts: { diploma: 'MISSING' },
    text: `Solange Ebata
Secrétaire — Brazzaville
Secrétaire administrative, École Les Palmiers, 2014 à aujourd'hui. Dossiers du personnel enseignant (35 personnes), suivi des absences, courrier, classement, accueil. Transmet chaque mois les éléments de paie au comptable.
BTS assistanat de direction, 2013 (Bac+2). Word, Excel. Français, lingala.`,
  },
  {
    id: 'rh-4',
    job: 'rh',
    musts: { diploma: 'MET' },
    text: `Arnaud Bouity
Jeune diplômé RH — Brazzaville
Stage, service du personnel, Brasserie du Congo, 03/2026 à 08/2026 : classement des dossiers, suivi des congés, aide à l'organisation des entretiens.
Licence en ressources humaines, 2025. Responsable bénévole d'une association étudiante. Word, Excel. Français, anglais moyen.`,
  },
  {
    id: 'rh-5',
    job: 'rh',
    musts: { diploma: 'MISSING' },
    text: `Dieudonné Pambou
Agent de sécurité — Brazzaville
Agent de sécurité, Vigile Plus, 2016 à aujourd'hui : rondes, contrôle des accès, registre des visiteurs.
Niveau bac. Français, lingala, kituba. Habite à Brazzaville, disponible tout de suite.`,
  },
  {
    id: 'rh-6',
    job: 'rh',
    musts: { diploma: 'MET' },
    text: `Estelle Nguimbi
Responsable RH — Kinshasa, RDC
Responsable des ressources humaines, Mines du Katanga, Kinshasa, 2014 à aujourd'hui. Équipe de six personnes, 900 salariés, paie, relations sociales, politique de formation, budget.
Assistante RH, 2009 à 2014.
Master en gestion des ressources humaines, 2009. Sage Paie, Excel. Français, anglais, lingala. Cherche un poste à Brazzaville pour raisons professionnelles.`,
  },
  // ── Électricien ────────────────────────────────────────────────────
  {
    id: 'elec-1',
    job: 'elec',
    musts: { clearance: 'MET' },
    text: `Moussa Koné
Électricien bâtiment — Abidjan
Électricien, Bâti Lagune, Abidjan, 2020 à aujourd'hui. Installation complète de 60 logements, tableaux, mise aux normes, lecture de plans, dépannage. Chef d'équipe de deux aides depuis 2024.
Habilitation électrique BR/B2V renouvelée en 2025. BT électrotechnique, 2019. Travail en hauteur. Pose de panneaux solaires depuis 2023.`,
  },
  {
    id: 'elec-2',
    job: 'elec',
    musts: { clearance: 'UNCLEAR' },
    text: `Ibrahim Ouattara
Électricien — Bouaké
Électricien à mon compte, Bouaké, 2015 à aujourd'hui. Câblage de maisons, remplacement de tableaux, dépannage chez les particuliers, quelques chantiers de bureaux.
CAP électricité bâtiment, 2014. Lecture de plans. Mobile à Abidjan.`,
  },
  {
    id: 'elec-3',
    job: 'elec',
    musts: { clearance: 'MISSING' },
    text: `Franck Yao
Électricien automobile — Abidjan
Électricien auto, Garage Marcory, 2017 à aujourd'hui : faisceaux, alternateurs, diagnostic électronique.
CAP électricité automobile, 2016. Je n'ai pas d'habilitation électrique et n'ai jamais travaillé en bâtiment. Habite à Abidjan.`,
  },
  {
    id: 'elec-4',
    job: 'elec',
    musts: { clearance: 'MET' },
    text: `Aïcha Traoré
Technicienne en électrotechnique — Abidjan
Alternance, Énergie Ivoire, 09/2024 à 08/2026 : tirage de câbles, pose d'appareillage et de tableaux sur chantiers de bureaux, sous la direction d'un chef de chantier.
BTS électrotechnique, 2026. Habilitation B1V, 2025. Formation au travail en hauteur.`,
  },
  {
    id: 'elec-5',
    job: 'elec',
    musts: { clearance: 'UNCLEAR' },
    text: `Jean-Marc Kouassi
Maçon — Abidjan
Maçon, Grands Travaux du Sud, 2012 à aujourd'hui : fondations, élévation, enduits, travail en hauteur, lecture de plans.
CAP maçonnerie, 2011. Aide ponctuelle aux électriciens pour les saignées. Habite à Yopougon, Abidjan.`,
  },
  {
    id: 'elec-6',
    job: 'elec',
    musts: { clearance: 'MET' },
    text: `Désiré Gnamien
Électricien industriel — San-Pédro
Électricien de maintenance, Usine Cacao Ouest, San-Pédro, 2010 à aujourd'hui : armoires électriques, moteurs, automates, astreintes.
BT électricité industrielle, 2009. Habilitation BR/BC/HTA, 2024. Peu de chantiers de logements. Prêt à déménager à Abidjan.`,
  },
];

/** The same CV under another name must score the same. */
export const NAME_SWAPS: Record<string, string[]> = {
  'compta-1': ['Christian Ngoma', 'Fatoumata Traoré', 'Li Wei Zhang'],
  'livreur-1': ['Alphonsine Mabiala', 'Mohamed Ould Salem', 'Pierre Lefèvre'],
  'dev-1': ['Amadou Diallo', 'Jane Smith', 'Rajesh Kumar'],
  'rh-1': ['Pascal Mouanda', 'Mariam Haïdara', 'Olga Petrova'],
  'elec-1': ['Awa Koné', 'John Williams', 'Nguyen Van An'],
};
