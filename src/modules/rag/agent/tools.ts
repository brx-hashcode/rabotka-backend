import { Logger } from '@nestjs/common';
import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import { ApplicationStatus, ProfileType } from '@prisma/client';
import { HelpRetrieveService } from '../retrieval/retrieve.service';
import type { HelpAudience } from '../retrieval/help-docs.store';
import type {
  ReadOnlyApplications,
  ReadOnlyJobOffers,
  ReadOnlyProfiles,
  ReadOnlySystemConfig,
  ReadOnlyUnlock,
  ReadOnlyWallet,
} from './read-only';
import { JobCategoryRegistry } from '../intents/job-category.registry';
import {
  APPLICATION_SUMMARY,
  JOB_OFFER_SUMMARY,
  PENALTY_SUMMARY,
  PROFILE_STATE,
  UNLOCK_STATE,
} from '../intents/dto';
import { project, projectMany } from '../intents/projections';

export const APP_DESTINATIONS = {
  accueil: '/home',
  offres: '/jobs',
  recherche_offres: '/recherche-offres',
  mes_candidatures: '/mes-candidatures',
  mes_missions: '/missions',
  publier_mission: '/job-offers/new',
  tableau_de_bord: '/dashboard',
  profil: '/profile',
  portfolio: '/profile/portfolio',
  portefeuille: '/portefeuille',
  favoris: '/favoris',
  penalites: '/penalites/paiement',
  reclamations: '/claims',
  nouvelle_reclamation: '/claims/new',
} as const;

export type AppDestination = keyof typeof APP_DESTINATIONS;

export interface ToolContext {
  profileId: string;
  profileType: ProfileType;
}

/**
 * What the agent may touch — every entry a read.
 *
 * The types are `Pick<>`s of the real services (see `read-only.ts`), so a tool
 * that tries to debit a wallet or open a claim does not compile. `ClaimService`
 * is absent altogether rather than narrowed: the assistant has no read it needs
 * from claims, and a handle it does not hold is one it cannot misuse.
 */
export interface ToolDeps {
  profiles: ReadOnlyProfiles;
  jobOffers: ReadOnlyJobOffers;
  applications: ReadOnlyApplications;
  wallet: ReadOnlyWallet;
  unlock: ReadOnlyUnlock;
  systemConfig: ReadOnlySystemConfig;
  help: HelpRetrieveService;
  categories: JobCategoryRegistry;
}

const logger = new Logger('VovaTools');

function ok(payload: unknown): string {
  return JSON.stringify(payload);
}

function fail(tool: string, err: unknown): string {
  logger.error(`Tool ${tool} failed`, err);
  return JSON.stringify({
    erreur: 'indisponible',
    message: "Cette information n'a pas pu être récupérée.",
  });
}

/**
 * The corpus search, built for one audience.
 *
 * Extracted so the anonymous path can hold the SAME tool with a different
 * filter, rather than a second copy that drifts from this one.
 */
function makeRechercherAide(
  deps: ToolDeps,
  audience: HelpAudience,
): StructuredToolInterface {
  return tool(
    async ({ question_fr }: { question_fr: string }) => {
      try {
        // Same role filter as the pre-retrieval. Without it the model reaches
        // worker-only passages by calling the tool — and it did: an employer
        // was told to add réalisations to a screen they do not have.
        const result = await deps.help.search(question_fr, undefined, audience);
        if (result.hits.length === 0) {
          return ok({ resultats: [], note: 'aucun article pertinent' });
        }
        return ok({
          resultats: result.hits.map((h) => ({
            titre: h.title,
            section: h.section,
            texte: h.text,
            action_id: h.actionId,
          })),
          outils_requis: result.requiredTools,
        });
      } catch (err) {
        return fail('rechercher_aide', err);
      }
    },
    {
      name: 'rechercher_aide',
      description:
        'Cherche dans la documentation Rabotka. SEULE source autorisée pour expliquer ' +
        'le fonctionnement de la plateforme : vérification, déblocage de contact, ' +
        'pénalités, évaluations, sécurité, réclamations. À utiliser avant toute ' +
        'explication. Si `outils_requis` est renseigné, appeler ces outils avant de répondre.',
      schema: z.object({
        question_fr: z
          .string()
          .describe('La question, reformulée en français simple.'),
      }),
    },
  );
}

/** The domain check. Reads the category registry and nothing about the user. */
function makeVerifierDomaine(deps: ToolDeps): StructuredToolInterface {
  return tool(
    async ({ metier }: { metier: string }) => {
      try {
        const found = await deps.categories.resolve(metier);
        if (found) {
          return ok({ couvert: true, domaine: found.name, slug: found.slug });
        }
        return ok({
          couvert: false,
          metier_demande: metier,
          // NEUTRE EN RÔLE, délibérément.
          //
          // Disait « ce métier peut tout de même être PUBLIÉ », ce qui décrit
          // le geste d'un recruteur. Le modèle a repris ce mot pour quelqu'un
          // qui venait d'écrire « je cherche une mission » et lui a proposé
          // quatre fois d'en publier une. Le biais était dans la réponse de
          // l'outil, pas dans le prompt — le même texte sert un travailleur et
          // un recruteur, il ne doit donc supposer ni l'un ni l'autre.
          note:
            'Aucun domaine ne correspond exactement, mais ce métier a sa place ' +
            'sur Rabotka : le domaine « Autre » existe pour ça. Ne dis jamais ' +
            'que Rabotka ne couvre pas ce besoin. Réponds selon ce que la ' +
            "personne cherche — travailler, ou trouver quelqu'un — sans le " +
            'supposer.',
        });
      } catch (err) {
        return fail('verifier_domaine', err);
      }
    },
    {
      name: 'verifier_domaine',
      description:
        "Vérifie qu'un métier existe bien sur Rabotka et donne son nom officiel. " +
        "OBLIGATOIRE avant d'affirmer qu'un métier est couvert ou non : la liste " +
        'des domaines vit en base et change, tu ne la connais pas par cœur. ' +
        // Sans cette phrase, « OBLIGATOIRE » se lisait comme une invitation à
        // re-vérifier sans fin : le modèle appelait l'outil, recevait « Autre »,
        // demandait une précision, rappelait l'outil — quatre tours d'affilée.
        'UNE SEULE FOIS par métier : son résultat CONCLUT. Ne demande jamais ' +
        'une précision pour rappeler cet outil — « Autre » est une réponse ' +
        'valable, pas un échec à affiner.',
      schema: z.object({
        metier: z
          .string()
          .describe("Le métier tel que l'utilisateur l'a écrit."),
      }),
    },
  );
}

/**
 * Everything an anonymous caller may reach: the corpus, and the domain check.
 *
 * Not a narrowed version of `buildTools` — a deliberately separate, tiny list.
 * Every other tool takes a `profileId` and answers with somebody's private
 * data; a stranger has no profile, so there is nothing for them to read and no
 * ambiguity about whose data it would be. `carte_support` is absent too:
 * `support` is a bot command that already answers in every account state,
 * including no account at all.
 */
export function buildAnonymousTools(deps: ToolDeps): StructuredToolInterface[] {
  return [makeRechercherAide(deps, 'anonymous'), makeVerifierDomaine(deps)];
}

export function buildTools(
  deps: ToolDeps,
  ctx: ToolContext,
  categorySlugs: string[],
): StructuredToolInterface[] {
  const isWorker = ctx.profileType === ProfileType.WORKER;

  const rechercherAide = makeRechercherAide(
    deps,
    isWorker ? 'worker' : 'employer',
  );

  const rechercherOffres = tool(
    async ({
      categorie_slug,
      ville,
    }: {
      categorie_slug?: string;
      ville?: string;
    }) => {
      try {
        const category = categorie_slug
          ? await deps.categories.resolve(categorie_slug)
          : null;

        if (categorie_slug && !category) {
          return ok({
            erreur: 'domaine_inconnu',
            domaine_demande: categorie_slug,
            domaines_possibles: categorySlugs.slice(0, 40),
          });
        }

        // AVEC un domaine : un compte, et rien d'autre.
        //
        // Deux raisons, et la seconde est la plus importante.
        //
        // 1. C'était FAUX. Le domaine était résolu puis jeté : la recherche
        //    renvoyait les dix offres ouvertes les plus imminentes, toutes
        //    catégories confondues, avec `domaine: "plomberie"` posé à côté. Le
        //    modèle les annonçait donc comme des missions de plomberie. Filtrer
        //    cette page de dix ne suffisait pas non plus : si aucune des dix
        //    plus imminentes n'est en plomberie, un filtre local conclut « aucune
        //    mission » alors qu'il en existe plus loin. Seul un COUNT en base
        //    répond à la question posée.
        // 2. Le modèle ne reçoit aucun détail, donc il ne peut en divulguer
        //    aucun — ni titre, ni montant, ni adresse. La discrétion vient ici
        //    de la forme du retour, pas d'une consigne de prompt qu'un message
        //    bien tourné pourrait contourner.
        // DÈS QU'UN CRITÈRE EST DONNÉ — domaine, ville, ou les deux — on compte
        // en base et on ne renvoie que le nombre.
        //
        // Deux raisons, et la seconde est la plus importante.
        //
        // 1. C'était FAUX. Le domaine était résolu puis jeté : la recherche
        //    renvoyait les dix offres ouvertes les plus imminentes, toutes
        //    catégories confondues, avec `domaine: "plomberie"` posé à côté. Le
        //    modèle les annonçait donc comme des missions de plomberie. Filtrer
        //    cette page de dix ne suffisait pas non plus, et c'est vrai de la
        //    ville comme du domaine : si aucune des dix plus imminentes n'est à
        //    Pointe-Noire, un filtre local conclut « aucune mission » alors
        //    qu'il en existe plus loin. Seul un COUNT répond à la question.
        // 2. Le modèle ne reçoit aucun détail, donc il ne peut en divulguer
        //    aucun — ni titre, ni montant, ni adresse. La discrétion vient ici
        //    de la forme du retour, pas d'une consigne de prompt qu'un message
        //    bien tourné pourrait contourner.
        if (category || ville) {
          const nombre = await deps.jobOffers.countOpenOffers({
            categoryId: category?.id ?? null,
            city: ville ?? null,
            excludeWorkerId: ctx.profileId,
          });
          return ok({
            domaine: category?.slug ?? null,
            ville: ville ?? null,
            nombre,
          });
        }

        // AUCUN critère : le parcours « je veux juste voir ce qui existe ».
        const { data } = await deps.jobOffers.findActive(
          10,
          undefined,
          ctx.profileId,
        );

        return ok({
          missions: projectMany(
            data as unknown as Record<string, unknown>[],
            JOB_OFFER_SUMMARY,
            'public',
            'JOB_OFFER_SUMMARY',
          ),
          domaine: null,
          ville: null,
        });
      } catch (err) {
        return fail('rechercher_offres', err);
      }
    },
    {
      name: 'rechercher_offres',
      description:
        'Missions ouvertes. Réservé aux travailleurs. Avec `categorie_slug` et/ou ' +
        '`ville`, renvoie UNIQUEMENT le nombre de missions correspondantes (`nombre`) — ' +
        "aucun titre, aucun montant, aucune adresse : c'est voulu, annonce le nombre et " +
        "propose d'ouvrir la liste. Sans aucun critère, renvoie un échantillon à " +
        "parcourir. `categorie_slug` : passer le mot de l'utilisateur tel quel, il sera " +
        'résolu, ou la liste des domaines connus sera renvoyée. `ville` : uniquement si ' +
        "la personne l'a mentionnée d'elle-même — ne la demande jamais.",
      schema: z.object({
        categorie_slug: z
          .string()
          .optional()
          .describe('Domaine, ex. "plomberie", "garde-enfants".'),
        ville: z.string().optional().describe('Ville, ex. "Brazzaville".'),
      }),
    },
  );

  const offreParReference = tool(
    async ({ reference }: { reference: string }) => {
      try {
        const offer = await deps.jobOffers.findByReference(reference.trim());
        if (!offer) {
          return ok({ erreur: 'introuvable', reference });
        }
        return ok({
          mission: project(
            offer as unknown as Record<string, unknown>,
            JOB_OFFER_SUMMARY,
            'public',
            'JOB_OFFER_SUMMARY',
          ),
        });
      } catch (err) {
        return fail('offre_par_reference', err);
      }
    },
    {
      name: 'offre_par_reference',
      description:
        "Retrouve une mission à partir de sa référence unique, telle que l'utilisateur " +
        "l'a écrite. À utiliser dès qu'un message contient quelque chose qui ressemble à une référence.",
      schema: z.object({
        reference: z.string().describe('La référence, sans la modifier.'),
      }),
    },
  );

  const etatDuProfil = tool(
    async () => {
      try {
        const profile = await deps.profiles.findById(ctx.profileId);
        return ok({
          profil: project(
            profile as unknown as Record<string, unknown>,
            PROFILE_STATE,
            'owner',
            'PROFILE_STATE',
          ),
        });
      } catch (err) {
        return fail('etat_du_profil', err);
      }
    },
    {
      name: 'etat_du_profil',
      description:
        "État du profil de l'utilisateur : statut de vérification et MOTIF DE REFUS " +
        'éventuel, score de fiabilité, note, ville, domaines, portfolio. À appeler dès ' +
        "que l'utilisateur demande pourquoi sa vérification a échoué, ce qui manque à " +
        'son profil, ou comment gagner en crédibilité. Ne jamais citer un de ces ' +
        'éléments sans avoir appelé cet outil.',
      schema: z.object({}),
    },
  );

  const mesCandidatures = tool(
    async () => {
      try {
        const result = await deps.profiles.getApplicationsByProfileId(
          ctx.profileId,
          1,
          10,
        );
        const paged = result as unknown as {
          data?: unknown[];
          total?: number;
        };
        const rows = paged.data ?? [];
        return ok({
          // Le service renvoyait déjà `total` et l'outil le jetait. Le modèle
          // ne voyait donc que dix lignes, alors que le prompt lui demande
          // d'être concret (« *4 candidatures, 2 en attente* ») : il comptait
          // les lignes et annonçait « 10 » à quelqu'un qui en avait trente.
          nombre: paged.total ?? rows.length,
          candidatures: projectMany(
            rows as Record<string, unknown>[],
            APPLICATION_SUMMARY,
            'owner',
            'APPLICATION_SUMMARY',
          ),
        });
      } catch (err) {
        return fail('mes_candidatures', err);
      }
    },
    {
      name: 'mes_candidatures',
      description:
        "Les candidatures de l'utilisateur et leur statut. `nombre` est le vrai total " +
        '— utilise-le tel quel et ne compte JAMAIS les lignes de `candidatures`, qui ' +
        'ne sont que les dix plus récentes. Traduire les statuts en français courant, ' +
        'ne jamais renvoyer le code brut.',
      schema: z.object({}),
    },
  );

  const mesPenalites = tool(
    async () => {
      try {
        const penalties = await deps.profiles.getPenaltiesByProfileId(
          ctx.profileId,
        );
        return ok({
          penalites: projectMany(
            penalties as unknown as Record<string, unknown>[],
            PENALTY_SUMMARY,
            'owner',
            'PENALTY_SUMMARY',
          ),
        });
      } catch (err) {
        return fail('mes_penalites', err);
      }
    },
    {
      name: 'mes_penalites',
      description:
        "Les pénalités de l'utilisateur, payées et impayées. Toujours nommer la sortie : " +
        'sur WhatsApp, taper *payer* ouvre le règlement.',
      schema: z.object({}),
    },
  );

  const soldeCredit = tool(
    async () => {
      try {
        const balance = await deps.wallet.getProfileWalletBalance(
          ctx.profileId,
        );
        return ok({
          // Self-describing keys, because the model reads them as prose. With a
          // bare `solde_fcfa` it wrote « 1 FCFA au lieu de 502 FCFA », turning a
          // wallet balance into a former price it never had.
          solde_disponible_fcfa: balance,
          signification:
            'Montant disponible sur le portefeuille, à cet instant. Ce n’est ' +
            'ni un prix, ni une remise, ni un montant dû. Tu ne sais PAS d’où ' +
            'il vient : n’explique ni comment il a été obtenu, ni ce qui a été ' +
            'dépensé avant.',
        });
      } catch (err) {
        return fail('solde_credit', err);
      }
    },
    {
      name: 'solde_credit',
      description:
        "Solde du portefeuille. SEULE source d'un montant concernant l'utilisateur. " +
        'Ne jamais annoncer un solde sans cet outil.',
      schema: z.object({}),
    },
  );

  const tarifDeblocage = tool(
    async () => {
      try {
        const fees = await deps.systemConfig.getContactUnlockFees();
        return ok({
          prix_du_deblocage_fcfa: isWorker
            ? fees.workerFeeFcfa
            : fees.employerFeeFcfa,
          role: isWorker ? 'travailleur' : 'recruteur',
          // Named for what it IS. As `delai_expiration_heures` the model
          // announced « ce tarif est valable 48 heures » — the window is for the
          // two sides to pay each other, not a price that expires.
          delai_pour_que_les_deux_paient_heures: fees.expiryHours,
          signification:
            'Prix actuel du déblocage pour CE rôle. Le délai est celui dont les ' +
            'deux parties disposent pour payer chacune leur part ; passé ce ' +
            'délai la somme déjà versée revient en crédit. Ce prix n’est ni une ' +
            'remise ni une promotion.',
        });
      } catch (err) {
        return fail('tarif_deblocage', err);
      }
    },
    {
      name: 'tarif_deblocage',
      description:
        'Le tarif actuel du déblocage de contact pour cet utilisateur, et le délai ' +
        "d'expiration. Obligatoire avant d'énoncer un montant : les tarifs sont " +
        'modifiables par un administrateur et changent sans préavis.',
      schema: z.object({}),
    },
  );

  const etatDeblocage = tool(
    async ({ candidature_id }: { candidature_id: string }) => {
      try {
        const attempt = await deps.unlock.getByApplicationId(candidature_id);
        if (!attempt) return ok({ erreur: 'aucun_deblocage', candidature_id });

        const belongsToCaller =
          attempt.worker_id === ctx.profileId ||
          attempt.employer_id === ctx.profileId;
        if (!belongsToCaller) {
          logger.warn(
            `etat_deblocage denied: ${ctx.profileId} asked for attempt ${attempt.id}`,
          );
          return ok({ erreur: 'non_autorise' });
        }

        return ok({
          deblocage: project(
            attempt as unknown as Record<string, unknown>,
            UNLOCK_STATE,
            'owner',
            'UNLOCK_STATE',
          ),
        });
      } catch (err) {
        return fail('etat_deblocage', err);
      }
    },
    {
      name: 'etat_deblocage',
      description:
        "Où en est le déblocage de contact d'une candidature : qui a payé, quand le " +
        "délai expire. Répond à « et si l'autre ne paie pas » : la somme revient en crédit. " +
        'Ne renvoie JAMAIS de coordonnées, même une fois débloqué.',
      schema: z.object({
        candidature_id: z.string().describe('Identifiant de la candidature.'),
      }),
    },
  );

  const carteSupport = tool(
    () =>
      Promise.resolve(
        ok({
          // Deliberately returns NO email and NO phone number.
          //
          // VoVa offered « souhaitez-vous leurs coordonnées ? », the user said
          // yes, and the reply came back as the contact refusal: the model had
          // rewritten the support number's spacing, so the allow-list (an exact
          // string match) missed it and the leak detector caught it. Rather than
          // teach the mask every format a model might invent, the assistant
          // stops carrying contacts entirely — `support` is a bot command that
          // answers with the official card, in every account state, with no
          // model in the path.
          instruction:
            'Dire à l’utilisateur de taper *support* dans cette conversation. ' +
            'Il recevra aussitôt les coordonnées officielles de l’équipe. ' +
            'N’écris toi-même ni numéro ni adresse e-mail.',
        }),
      ),
    {
      name: 'carte_support',
      description:
        "Comment joindre l'équipe Rabotka. À utiliser dès que quelqu'un demande " +
        'le support, un contact, ou une réponse que tu ne peux pas donner. ' +
        'Ne renvoie aucune coordonnée : le mot *support* les affiche.',
      schema: z.object({}),
    },
  );

  const demanderAssistance = tool(
    async () => {
      try {
        const contact = await deps.systemConfig.getContactInfo();
        return ok({
          // Deliberately NOT an action. Creating the claim here would be the
          // assistant acting for the user — the one thing `PROJECT_CONTEXT.md`
          // §10 rules out — and it would do it on the strength of a sentence
          // rather than a confirmed intent. The user opens it themselves, on a
          // screen that shows them what they are filing.
          ou_ouvrir_une_reclamation: APP_DESTINATIONS.nouvelle_reclamation,
          // No coordinates here either — *support* prints them, deterministically.
          joindre_l_equipe: 'Taper *support* dans cette conversation.',
          horaires: 'lundi–samedi, 8h–18h',
          note:
            "Dire à l'utilisateur d'ouvrir la réclamation depuis l'application. " +
            "Ne jamais affirmer qu'une réclamation a été créée.",
        });
      } catch (err) {
        return fail('demander_assistance', err);
      }
    },
    {
      name: 'demander_assistance',
      description:
        'À utiliser pour un litige, un paiement bloqué, une vérification refusée, un ' +
        "compte suspendu, un problème de sécurité, ou quand l'utilisateur demande une " +
        'personne. Renvoie où ouvrir une réclamation et les coordonnées du support. ' +
        "N'ouvre RIEN : c'est l'utilisateur qui la crée dans l'application.",
      schema: z.object({}),
    },
  );

  const mesMissionsPubliees = tool(
    async () => {
      try {
        const offers = await deps.jobOffers.findByEmployerId(ctx.profileId);
        return ok({
          nombre: offers.length,
          missions: projectMany(
            offers as unknown as Record<string, unknown>[],
            JOB_OFFER_SUMMARY,
            'owner',
            'JOB_OFFER_SUMMARY',
          ).slice(0, 10),
        });
      } catch (err) {
        return fail('mes_missions_publiees', err);
      }
    },
    {
      name: 'mes_missions_publiees',
      description:
        'Les missions que CE recruteur a publiées, avec leur statut et leur nombre. ' +
        "À appeler dès qu'il demande combien d'offres il a créées, où en est une " +
        "annonce, ou ce qu'il a publié.",
      schema: z.object({}),
    },
  );

  const candidaturesRecues = tool(
    async () => {
      try {
        // La surcharge PAGINÉE, pour ses `total`. La version `{ limit: 20 }`
        // renvoyait un tableau plafonné dont on comptait la longueur : un
        // recruteur avec 45 candidatures s'entendait répondre « vous en avez
        // *20* ». Un chiffre faux et présenté avec autorité, sur la question
        // même que cet outil existe pour trancher — « combien ? ».
        //
        // Deux requêtes plutôt qu'un filtre local, pour la même raison :
        // compter les PENDING parmi les vingt ramenées donne le nombre de
        // pending dans la page, pas le nombre de pending.
        const [page, pendingPage] = await Promise.all([
          deps.applications.findByEmployer(ctx.profileId, {
            page: 1,
            pageSize: 10,
          }),
          deps.applications.findByEmployer(ctx.profileId, {
            status: ApplicationStatus.PENDING,
            page: 1,
            pageSize: 1,
          }),
        ]);

        return ok({
          total: page.total,
          en_attente: pendingPage.total,
          candidatures: projectMany(
            page.items as unknown as Record<string, unknown>[],
            APPLICATION_SUMMARY,
            'owner',
            'APPLICATION_SUMMARY',
          ),
        });
      } catch (err) {
        return fail('candidatures_recues', err);
      }
    },
    {
      name: 'candidatures_recues',
      description:
        'Les candidatures reçues par CE recruteur. `total` et `en_attente` sont les ' +
        'vrais comptes, sur toute la base — utilise-les tels quels et ne compte JAMAIS ' +
        'les lignes de `candidatures`, qui ne sont que les dix plus récentes. ' +
        "À appeler dès qu'il demande s'il a des candidatures, combien, ou où " +
        'elles en sont. Ne jamais répondre par un solde ni par un autre chiffre.',
      schema: z.object({}),
    },
  );

  const verifierDomaine = makeVerifierDomaine(deps);

  const common = [
    rechercherAide,
    verifierDomaine,
    etatDuProfil,
    soldeCredit,
    tarifDeblocage,
    etatDeblocage,
    carteSupport,
    demanderAssistance,
    offreParReference,
  ];

  return isWorker
    ? [...common, rechercherOffres, mesCandidatures, mesPenalites]
    : [...common, mesMissionsPubliees, candidaturesRecues];
}
