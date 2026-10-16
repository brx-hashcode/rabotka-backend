import { ConfigCategory } from '@prisma/client';

export interface ConfigDefault {
  key: string;
  value: string;
  category: ConfigCategory;
  label: string;
  isSecret: boolean;
}

// The `twilio.*` keys lived here until WhatsApp gained a second provider.
// Messaging credentials are environment-only now, for both Twilio and Meta
// Cloud — see whatsapp.config.ts. `ConfigCategory.TWILIO` stays in the Prisma
// enum: it is unused, and removing a Postgres enum value is a destructive
// migration for no gain.
export const DEFAULT_SYSTEM_CONFIGS: ConfigDefault[] = [
  // ── FEES ──────────────────────────────────────────────────────────────────
  {
    key: 'fees.late_cancellation_penalty_fcfa',
    value: '5000',
    category: ConfigCategory.FEES,
    label: 'Pénalité annulation tardive (FCFA)',
    isSecret: false,
  },
  {
    key: 'fees.late_cancellation_score_deduction',
    value: '5',
    category: ConfigCategory.FEES,
    label: 'Déduction score fiabilité (annulation tardive)',
    isSecret: false,
  },
  {
    key: 'fees.cancellation_threshold_hours',
    value: '4',
    category: ConfigCategory.FEES,
    label: 'Délai annulation sans pénalité (heures)',
    isSecret: false,
  },
  {
    key: 'fees.reliability_score_min',
    value: '50',
    category: ConfigCategory.FEES,
    label: 'Score fiabilité minimum',
    isSecret: false,
  },
  {
    key: 'fees.employer_late_cancel_score_deduction',
    value: '5',
    category: ConfigCategory.FEES,
    label:
      'Déduction score employeur (annulation tardive ou offre non démarrée avec travailleur accepté)',
    isSecret: false,
  },
  {
    key: 'fees.completion_score_reward',
    value: '1',
    category: ConfigCategory.FEES,
    label: 'Bonus score fiabilité (travail terminé)',
    isSecret: false,
  },
  {
    key: 'fees.rating_score_delta_1',
    value: '-4',
    category: ConfigCategory.FEES,
    label: 'Ajustement score fiabilité — note 1★',
    isSecret: false,
  },
  {
    key: 'fees.rating_score_delta_2',
    value: '-2',
    category: ConfigCategory.FEES,
    label: 'Ajustement score fiabilité — note 2★',
    isSecret: false,
  },
  {
    key: 'fees.rating_score_delta_3',
    value: '0',
    category: ConfigCategory.FEES,
    label: 'Ajustement score fiabilité — note 3★',
    isSecret: false,
  },
  {
    key: 'fees.rating_score_delta_4',
    value: '1',
    category: ConfigCategory.FEES,
    label: 'Ajustement score fiabilité — note 4★',
    isSecret: false,
  },
  {
    key: 'fees.rating_score_delta_5',
    value: '3',
    category: ConfigCategory.FEES,
    label: 'Ajustement score fiabilité — note 5★',
    isSecret: false,
  },
  {
    key: 'fees.billing_block_threshold',
    value: '2',
    category: ConfigCategory.FEES,
    label: 'Nombre de pénalités impayées avant blocage',
    isSecret: false,
  },
  {
    // Distinct from `billing_block_threshold` on purpose: blocking flips
    // `billing_status`, suspending flips the account itself. It is the harsher
    // of the two, so it must sit at or above the block threshold — an admin who
    // pushes the block line past this one gets suspension first, which is the
    // wrong order. Was `process.env.PENALTY_THRESHOLD` (default 3), which no
    // deployment set and no admin could reach.
    key: 'fees.penalty_suspension_threshold',
    value: '3',
    category: ConfigCategory.FEES,
    label: 'Nombre de pénalités impayées avant suspension du compte',
    isSecret: false,
  },
  {
    // Reliability points lost for walking away from ANY committed mission
    // (accepted, paying, hired), early or late — on top of the late deduction
    // when it is late. 0 = only late cancellations cost points, as before.
    key: 'fees.cancellation_score_deduction',
    value: '0',
    category: ConfigCategory.FEES,
    label: 'Points de fiabilité perdus pour toute annulation de mission',
    isSecret: false,
  },
  {
    // Suspension for walking away repeatedly, independent of penalties: a
    // worker who cancels this many times within the window below — a mission
    // they were accepted on, or an application still waiting for an answer —
    // is suspended until an admin lifts it. Early or late makes no difference.
    key: 'fees.cancellation_suspension_count',
    value: '3',
    category: ConfigCategory.FEES,
    label: 'Annulations (missions ou candidatures) avant suspension du compte',
    isSecret: false,
  },
  {
    key: 'fees.cancellation_suspension_window_days',
    value: '30',
    category: ConfigCategory.FEES,
    label: 'Période de comptage des annulations (jours)',
    isSecret: false,
  },
  {
    // The hard block: one penalty left unpaid this long stops the account from
    // applying, publishing, or unlocking a contact, and drops it out of the
    // recommendation fan-out. Quoted verbatim in the message the user gets, so
    // the number and the text can never drift apart.
    key: 'fees.penalty_hard_block_days',
    value: '3',
    category: ConfigCategory.FEES,
    label: 'Délai avant blocage dur pour pénalité impayée (jours)',
    isSecret: false,
  },
  {
    key: 'fees.penalty_max_notifications',
    value: '3',
    category: ConfigCategory.FEES,
    label: 'Nombre max de rappels envoyés par pénalité impayée',
    isSecret: false,
  },
  {
    // Slightly under 24h so a daily reminder never drifts later and later:
    // a scan an hour after yesterday's send still finds the penalty eligible.
    key: 'fees.penalty_notification_interval_hours',
    value: '23',
    category: ConfigCategory.FEES,
    label: 'Délai minimum entre deux rappels de pénalité (heures)',
    isSecret: false,
  },
  {
    key: 'fees.max_daily_applications',
    value: '10',
    category: ConfigCategory.FEES,
    label: 'Nombre max de candidatures par jour (par travailleur)',
    isSecret: false,
  },
  {
    key: 'fees.contact_unlock_fee_employer',
    value: '500',
    category: ConfigCategory.FEES,
    label: 'Frais déverrouillage contact – Employeur (FCFA)',
    isSecret: false,
  },
  {
    key: 'fees.contact_unlock_fee_worker',
    value: '100',
    category: ConfigCategory.FEES,
    label: 'Frais déverrouillage contact – Travailleur (FCFA)',
    isSecret: false,
  },
  {
    key: 'fees.contact_unlock_expiry_hours',
    value: '48',
    category: ConfigCategory.FEES,
    label: 'Délai expiration déverrouillage contact (heures)',
    isSecret: false,
  },
  {
    key: 'fees.contact_recommendation_fee_employer',
    value: '1000',
    category: ConfigCategory.FEES,
    label: 'Frais contact depuis recommandation – Employeur (FCFA)',
    isSecret: false,
  },
  {
    key: 'fees.welcome_credit_worker',
    value: '100',
    category: ConfigCategory.FEES,
    label: 'Crédit de bienvenue – Travailleur (FCFA)',
    isSecret: false,
  },
  {
    key: 'fees.welcome_credit_employer',
    value: '500',
    category: ConfigCategory.FEES,
    label: 'Crédit de bienvenue – Employeur (FCFA)',
    isSecret: false,
  },
  {
    // Paid to the parrain when their filleul makes their first mobile-money
    // payment for a connection — never at signup, which would be farmable with
    // throwaway accounts.
    //
    // 300 + 200 rather than 500 + 250 so the total (500) is covered by an
    // employer contact unlock, which is also 500. The payout can never exceed
    // the payment that triggered it, so at 750 the only qualifying trigger left
    // was the 1000 FCFA recommendation contact — the program quietly paid on
    // one of its three entry points.
    key: 'fees.referral_credit_referrer',
    value: '300',
    category: ConfigCategory.FEES,
    label: 'Crédit parrainage – Parrain (FCFA)',
    isSecret: false,
  },
  {
    // Paid to the filleul at the same moment, from the same claim. Note the
    // two together are capped at the amount of the triggering payment, so
    // raising either can silently stop small payments from qualifying — see
    // ReferralService.settleForReferee.
    key: 'fees.referral_credit_referee',
    value: '200',
    category: ConfigCategory.FEES,
    label: 'Crédit parrainage – Filleul (FCFA)',
    isSecret: false,
  },
  {
    // Counts REWARDED referrals only: a parrain past the cap still has their
    // referrals recorded and visible, they just stop paying. 0 = unlimited,
    // resolved to null in getReferralCredits so no call site compares against
    // the sentinel.
    key: 'fees.referral_max_rewarded_per_referrer',
    value: '10',
    category: ConfigCategory.FEES,
    label: 'Parrainages rémunérés max par parrain (0 = illimité)',
    isSecret: false,
  },
  {
    // What the two credit values above MEAN — absolute FCFA, or a percentage of
    // the payment that triggered the settlement.
    //
    // Defaults to FIXED so every existing install keeps its 300/200 behaviour
    // without anyone touching it. The unit switches with this key, so the two
    // are validated together and never one at a time — see
    // SystemConfigService.setMany.
    key: 'fees.referral_commission_type',
    value: 'FIXED',
    category: ConfigCategory.FEES,
    label: 'Type de commission parrainage (FIXED = FCFA, PERCENTAGE = %)',
    isSecret: false,
  },
  {
    // Absolute ceiling on one parrainage payout, 0 = aucun.
    //
    // Matters mainly in PERCENTAGE mode, where the payout follows a base the
    // admin never types and only sees after the fact: a mis-set connection fee
    // would issue credit quietly rather than visibly. In FIXED mode the amounts
    // are already the ceiling, so leaving this at 0 is the norm.
    key: 'fees.referral_max_payout_per_referral',
    value: '0',
    category: ConfigCategory.FEES,
    label: 'Plafond de commission par parrainage (FCFA, 0 = aucun)',
    isSecret: false,
  },

  // ── MATCHING ──────────────────────────────────────────────────────────────
  {
    key: 'matching.use_embeddings',
    value: 'true',
    category: ConfigCategory.MATCHING,
    label: 'Activer algorithme de similarité (embeddings)',
    isSecret: false,
  },
  {
    // Written automatically when `matching.use_embeddings` flips false → true.
    // While embeddings are off the indexers stamp `vector_indexed_at` without
    // writing a vector, so `reindexPending` — which looks for a null stamp —
    // would find nothing to do forever. Comparing against this timestamp is what
    // lets the scan reclaim those rows. Empty means "never enabled".
    key: 'matching.embeddings_enabled_at',
    value: '',
    category: ConfigCategory.MATCHING,
    label: 'Dernière activation des embeddings (ISO, automatique)',
    isSecret: false,
  },
  {
    // Written by `reindexPending` after it rewrites every point at the current
    // payload schema. Compared against `INDEX_SCHEMA_VERSION` in qdrant.config —
    // a mismatch triggers one full rewrite and suppresses any filter that
    // depends on fields the old points do not carry. Empty means "never".
    key: 'matching.index_schema_version',
    value: '',
    category: ConfigCategory.MATCHING,
    label: 'Version du schéma de payload Qdrant (automatique)',
    isSecret: false,
  },
  {
    // Read by `getMatchingReliabilityThreshold`, which was falling back to its
    // hardcoded '50' on every call because the key was never seeded — so the
    // admin screen had no row for it and it could not be changed at all.
    key: 'matching.reliability_threshold',
    value: '50',
    category: ConfigCategory.MATCHING,
    label: 'Score fiabilité minimum (moteur de matching)',
    isSecret: false,
  },
  {
    key: 'matching.min_notification_score',
    value: '0.55',
    category: ConfigCategory.MATCHING,
    label: 'Score minimum pour notification de recommandation',
    isSecret: false,
  },
  {
    key: 'matching.recommendations_enabled',
    value: 'true',
    category: ConfigCategory.MATCHING,
    label: 'Activer les notifications de recommandation de jobs',
    isSecret: false,
  },
  {
    key: 'matching.recommendation_min_score',
    value: '0.3',
    category: ConfigCategory.MATCHING,
    label: 'Score minimum pour le fil de profils recommandés (employeur)',
    isSecret: false,
  },
  {
    // A worker's cancellation lowers their compatibility with THAT employer,
    // both ways, whatever the timing. Each cancellation multiplies the pair's
    // score by (1 − this), fading back to nothing over the decay below.
    key: 'matching.pair_cancel_penalty',
    value: '0.25',
    category: ConfigCategory.MATCHING,
    label: 'Baisse de compatibilité par annulation (candidat ↔ recruteur, 0–1)',
    isSecret: false,
  },
  {
    key: 'matching.pair_cancel_decay_days',
    value: '180',
    category: ConfigCategory.MATCHING,
    label: 'Durée d’effet d’une annulation sur la compatibilité (jours)',
    isSecret: false,
  },
  {
    // The agent app's suggested workers. Its own key rather than the employer
    // feed's: a tight threshold chosen for what an employer is shown must not
    // silently empty the list an agent is meant to call through.
    key: 'agent.candidate_min_score',
    value: '0.3',
    category: ConfigCategory.MATCHING,
    label: 'Score minimum des travailleurs suggérés aux agents',
    isSecret: false,
  },
  // ── AGENT ───────────────────────────────────────────────────────────────
  {
    // How many worker phone numbers one agent may reveal per day (Brazzaville
    // days). Every reveal is logged; the cap bounds what a single account can
    // harvest.
    key: 'agent.phone_reveal_daily_cap',
    value: '30',
    category: ConfigCategory.AGENT,
    label: 'Numéros de travailleurs révélés par agent et par jour',
    isSecret: false,
  },
  {
    // How long an agent holds a lead without inviting the worker. After it,
    // any agent covering the city may claim it.
    key: 'agent.lead_claim_hours',
    value: '24',
    category: ConfigCategory.AGENT,
    label: 'Durée de réservation d’un candidat par un agent (heures)',
    isSecret: false,
  },
  {
    key: 'agent.invite_expiry_hours',
    value: '48',
    category: ConfigCategory.AGENT,
    label: 'Validité du lien d’invitation envoyé au travailleur (heures)',
    isSecret: false,
  },
  {
    // Paid to the agent for each placement that reaches a completed contact
    // unlock. Snapshotted on the commission, so changing it never rewrites
    // what was already earned. 0 turns commissions off.
    key: 'agent.commission_per_placement_fcfa',
    value: '400',
    category: ConfigCategory.AGENT,
    label: 'Commission de l’agent par placement (FCFA)',
    isSecret: false,
  },
  {
    // What starts the confirmation window: UNLOCKED (both parties paid) or
    // COMPLETED (the mission was marked done).
    key: 'agent.commission_release_event',
    value: 'UNLOCKED',
    category: ConfigCategory.AGENT,
    label:
      'Événement qui démarre le délai de confirmation (UNLOCKED ou COMPLETED)',
    isSecret: false,
  },
  {
    // Hours after that event before the commission can be withdrawn. A
    // mission cancelled or a no-show in the meantime cancels it.
    key: 'agent.commission_confirmation_hours',
    value: '72',
    category: ConfigCategory.AGENT,
    label:
      'Délai de confirmation avant que la commission soit retirable (heures)',
    isSecret: false,
  },
  {
    // Only placements the worker paid by Mobile Money earn — not wallet
    // credit the platform itself issued.
    key: 'agent.commission_requires_momo_worker',
    value: 'true',
    category: ConfigCategory.AGENT,
    label: 'Exiger un paiement Mobile Money du travailleur',
    isSecret: false,
  },
  {
    key: 'agent.commission_requires_momo_employer',
    value: 'true',
    category: ConfigCategory.AGENT,
    label: 'Exiger un paiement Mobile Money de l’employeur',
    isSecret: false,
  },
  {
    // Multi-seat offers, where the employer pays once for every seat:
    // PER_PLACEMENT — each placed worker earns; FIRST_ONLY — only the
    // placement that carried the employer's payment does.
    key: 'agent.commission_multi_seat_mode',
    value: 'PER_PLACEMENT',
    category: ConfigCategory.AGENT,
    label: 'Offres à plusieurs postes : commission par placement ou une seule',
    isSecret: false,
  },
  {
    // The smallest amount an agent can ask to withdraw. Each payout is a
    // Mobile Money transfer an admin sends by hand, so tiny ones cost more
    // than they pay.
    key: 'agent.withdrawal_min_fcfa',
    value: '2000',
    category: ConfigCategory.AGENT,
    label: 'Montant minimum d’un retrait agent (FCFA)',
    isSecret: false,
  },
  {
    // Send the agent's invitation to the worker by WhatsApp (template
    // rabotka_agent_invitation_v1). Off until Meta approves the template; while
    // off, the agent shares the link from their own phone.
    key: 'agent.invite_whatsapp_enabled',
    value: 'false',
    category: ConfigCategory.AGENT,
    label: 'Envoyer l’invitation de l’agent au travailleur par WhatsApp',
    isSecret: false,
  },
  {
    key: 'matching.cf_enabled',
    value: 'false',
    category: ConfigCategory.MATCHING,
    label: 'Activer le filtrage collaboratif (recommandations croisées)',
    isSecret: false,
  },
  {
    key: 'matching.engine_version',
    value: 'v2',
    category: ConfigCategory.MATCHING,
    label: 'Moteur de recommandation actif (legacy | v2)',
    isSecret: false,
  },
  {
    key: 'matching.v2_rollout_percent',
    value: '0',
    category: ConfigCategory.MATCHING,
    label: 'Pourcentage d’utilisateurs sur le moteur v2 (0-100)',
    isSecret: false,
  },
  {
    // Deliberately narrow. This is the real fan-out width now that the
    // notification path no longer runs its candidates through a per-category
    // diversity cap — that cap had been limiting every categorised offer to
    // five recipients regardless of what this said. Five keeps a fresh
    // environment behaving like the one that has actually been running, and
    // makes widening a decision someone takes rather than inherits: each extra
    // recipient is a paid MARKETING template sent to somebody who did not ask
    // for it, and the WhatsApp quality rating is what pays for getting that
    // wrong.
    key: 'matching.max_notification_workers',
    value: '5',
    category: ConfigCategory.MATCHING,
    label: 'Nombre max de travailleurs notifiés par offre',
    isSecret: false,
  },
  {
    key: 'matching.notify_require_verified',
    value: 'false',
    category: ConfigCategory.MATCHING,
    label: 'Exiger la vérification KYC pour notifier un travailleur',
    isSecret: false,
  },
  {
    key: 'matching.notification_cooldown_minutes',
    value: '60',
    category: ConfigCategory.MATCHING,
    label: 'Délai minimum entre deux notifications de recommandation (minutes)',
    isSecret: false,
  },
  {
    key: 'matching.new_application_notify_cooldown_minutes',
    value: '30',
    category: ConfigCategory.MATCHING,
    label:
      'Délai minimum entre deux notifications de candidature pour une même ' +
      'offre (minutes, 0 = notifier à chaque candidature)',
    isSecret: false,
  },
  {
    // What one MARKETING template costs, in FCFA, used only to show an admin an
    // ESTIMATE before they confirm a broadcast. Meta bills in USD per
    // conversation and the rate moves, so this is a dial the team keeps roughly
    // right rather than a figure the system derives — the truth afterwards is
    // `whatsapp_messages.billable`, which the estimate can be compared against.
    key: 'fees.marketing_template_cost_fcfa',
    value: '15',
    category: ConfigCategory.FEES,
    label: 'Coût estimé d’un modèle MARKETING WhatsApp (FCFA)',
    isSecret: false,
  },
  // ── WhatsApp, per kind of notification ────────────────────────────────────
  // Off sends the event in-app only. See whatsapp-notification-groups.ts.
  {
    key: 'whatsapp.notify.job_recommendations',
    value: 'true',
    category: ConfigCategory.MATCHING,
    label: 'WhatsApp — Offres recommandées (alertes emploi)',
    isSecret: false,
  },
  {
    key: 'whatsapp.notify.new_application',
    value: 'true',
    category: ConfigCategory.MATCHING,
    label: 'WhatsApp — Nouvelle candidature, à l’employeur',
    isSecret: false,
  },
  {
    key: 'whatsapp.notify.application_accepted',
    value: 'true',
    category: ConfigCategory.MATCHING,
    label: 'WhatsApp — Candidature acceptée, au travailleur',
    isSecret: false,
  },
  {
    key: 'whatsapp.notify.contact_unlocked',
    value: 'true',
    category: ConfigCategory.MATCHING,
    label: 'WhatsApp — Contact débloqué (coordonnées)',
    isSecret: false,
  },
  {
    key: 'whatsapp.notify.application_rejected',
    value: 'false',
    category: ConfigCategory.MATCHING,
    label: 'WhatsApp — Candidature non retenue',
    isSecret: false,
  },
  {
    key: 'whatsapp.notify.cancellations',
    value: 'false',
    category: ConfigCategory.MATCHING,
    label: 'WhatsApp — Annulations (par le travailleur ou l’employeur)',
    isSecret: false,
  },
  {
    key: 'whatsapp.notify.offer_updates',
    value: 'false',
    category: ConfigCategory.MATCHING,
    label: 'WhatsApp — Offre modifiée (date, lieu, rémunération)',
    isSecret: false,
  },
  {
    key: 'whatsapp.notify.mission_reminders',
    value: 'false',
    category: ConfigCategory.MATCHING,
    label: 'WhatsApp — Rappels de mission (veille, début, démarrage, fin)',
    isSecret: false,
  },
  {
    key: 'whatsapp.notify.offer_expired',
    value: 'false',
    category: ConfigCategory.MATCHING,
    label: 'WhatsApp — Offre expirée',
    isSecret: false,
  },
  {
    key: 'whatsapp.notify.account_status',
    value: 'false',
    category: ConfigCategory.MATCHING,
    label: 'WhatsApp — KYC refusé, compte suspendu',
    isSecret: false,
  },
  {
    key: 'whatsapp.notify.unlock_credit',
    value: 'false',
    category: ConfigCategory.MATCHING,
    label: 'WhatsApp — Paiement de déblocage converti en crédit',
    isSecret: false,
  },
  {
    key: 'whatsapp.notify.claim_replies',
    value: 'false',
    category: ConfigCategory.MATCHING,
    label: 'WhatsApp — Réponse à une réclamation',
    isSecret: false,
  },
  {
    key: 'whatsapp.notify.mission_contract_pdf',
    value: 'false',
    category: ConfigCategory.MATCHING,
    label: 'WhatsApp — Contrat de mission en PDF',
    isSecret: false,
  },
  {
    // The kill switch for the window-aware send path. On, a notification to
    // someone who wrote to us in the last 24h goes out as free-form text with a
    // button — same words, same destination, no template fee. Off, every
    // notification goes back to its approved template, which is how this
    // codebase behaved before `NotificationDispatcher` existed.
    //
    // It exists because the saving rests on two things this repo cannot verify
    // for itself: that Meta bills utility templates inside the window, and that
    // an interactive message's button opens the in-app browser the way a
    // template's CTA does. If either turns out false, flipping this key undoes
    // the change everywhere without a deploy.
    key: 'notifications.prefer_free_form',
    value: 'true',
    category: ConfigCategory.MATCHING,
    label:
      'Envoyer en texte libre (gratuit) quand la fenêtre WhatsApp de 24h est ' +
      'ouverte, au lieu d’un modèle payant',
    isSecret: false,
  },
  {
    key: 'notifications.profile_views_whatsapp_threshold',
    value: '5',
    category: ConfigCategory.MATCHING,
    label:
      'Vues de profil non lues au-delà desquelles le travailleur est prévenu ' +
      'sur WhatsApp (0 = désactivé)',
    isSecret: false,
  },
  {
    key: 'notifications.profile_views_whatsapp_cooldown_hours',
    value: '168',
    category: ConfigCategory.MATCHING,
    label:
      'Délai minimum entre deux rappels WhatsApp de vues de profil (heures)',
    isSecret: false,
  },

  // ── GENERAL ───────────────────────────────────────────────────────────────
  {
    key: 'general.description',
    value:
      'Plateforme de mise en relation entre employeurs et travailleurs informels en Afrique.',
    category: ConfigCategory.GENERAL,
    label: 'Description courte de Rabotka (utilisée dans les emails)',
    isSecret: false,
  },

  // ── VOVA AI (assistant) ───────────────────────────────────────────────────
  {
    key: 'vova.enabled',
    value: 'false',
    category: ConfigCategory.GENERAL,
    label: 'Activer l’assistant Vova AI',
    isSecret: false,
  },
  {
    // On by default on purpose: turning the assistant on should NOT be the same
    // action as letting it speak to a user.
    key: 'vova.shadow_mode',
    value: 'true',
    category: ConfigCategory.GENERAL,
    label:
      'Vova AI en observation (calcule la réponse, envoie la carte d’accueil)',
    isSecret: false,
  },
  {
    key: 'vova.rollout_percent',
    value: '0',
    category: ConfigCategory.GENERAL,
    label: 'Pourcentage de profils servis par Vova AI',
    isSecret: false,
  },
  {
    key: 'vova.timeout_ms',
    value: '25000',
    category: ConfigCategory.GENERAL,
    label: 'Budget de réponse Vova AI (ms)',
    isSecret: false,
  },
  {
    // Off by default, and gated by `vova.enabled` as well. Answering a number
    // with no account is the only path where somebody who never signed up can
    // spend tokens, so it switches independently of the assistant itself.
    key: 'vova.anonymous_enabled',
    value: 'false',
    category: ConfigCategory.GENERAL,
    label: 'Vova AI répond aux numéros non inscrits',
    isSecret: false,
  },
  {
    // Suspended, KYC en cours, KYC refusé. Ces profils ne coûtaient rien tant
    // que le bot leur répondait par une carte figée ; ce sont aussi ceux qui
    // ont le plus de raisons d'insister et le moins de chances de rapporter.
    key: 'vova.walled_daily_limit',
    value: '10',
    category: ConfigCategory.GENERAL,
    label: 'Réponses Vova AI par jour pour un compte bloqué',
    isSecret: false,
  },
  {
    key: 'vova.anon_daily_limit',
    value: '10',
    category: ConfigCategory.GENERAL,
    label: 'Réponses IA par jour et par numéro non inscrit',
    isSecret: false,
  },

  // ── MESSAGERIE ────────────────────────────────────────────────────────────
  // GENERAL rather than CONTACT: that category holds RABOTKA's own contact
  // details (contact.email, contact.orange_money_number), which is a different
  // subject entirely. GENERAL already hosts the Vova settings above, and the
  // admin renders it with one card per family.
  {
    key: 'messaging.enabled',
    value: 'true',
    category: ConfigCategory.GENERAL,
    label: 'Messagerie entre profils activée',
    isSecret: false,
  },
  {
    // The local prefixes are not in this repo and I have no authoritative
    // source for them, so the default is EMPTY rather than a guess. An empty
    // list simply adds no pattern; the generic phone shapes still apply.
    key: 'messaging.operator_prefixes',
    value: '',
    category: ConfigCategory.GENERAL,
    label: 'Préfixes opérateurs à masquer (séparés par des virgules)',
    isSecret: false,
  },
  {
    // Above this share of the message withheld, delivering it tells the
    // recipient nothing except that somebody tried something — so it is held
    // whole instead of delivered as confetti.
    key: 'messaging.held_ratio_threshold',
    value: '0.5',
    category: ConfigCategory.GENERAL,
    label: 'Part masquée au-delà de laquelle le message est retenu (0–1)',
    isSecret: false,
  },
  {
    key: 'messaging.rate_limit_per_minute',
    value: '20',
    category: ConfigCategory.GENERAL,
    label: 'Messages par minute et par profil',
    isSecret: false,
  },
  {
    key: 'messaging.max_new_conversations_per_day',
    value: '20',
    category: ConfigCategory.GENERAL,
    label: 'Discussions sans candidature ouvertes par jour et par profil',
    isSecret: false,
  },
  {
    key: 'messaging.nudge_delay_seconds',
    value: '300',
    category: ConfigCategory.GENERAL,
    label: 'Délai avant relance WhatsApp d’un message non lu (secondes)',
    isSecret: false,
  },
  {
    key: 'messaging.nudge_template_enabled',
    value: 'false',
    category: ConfigCategory.GENERAL,
    label: 'Relancer hors fenêtre 24h (modèle WhatsApp payant)',
    isSecret: false,
  },

  // ── CONTACT ───────────────────────────────────────────────────────────────
  {
    key: 'contact.email',
    value: 'contact@rabotka.com',
    category: ConfigCategory.CONTACT,
    label: 'Email de contact',
    isSecret: false,
  },
  {
    key: 'contact.phone',
    value: '',
    category: ConfigCategory.CONTACT,
    label: 'Téléphone de contact',
    isSecret: false,
  },
  {
    key: 'contact.address',
    value: '',
    category: ConfigCategory.CONTACT,
    label: 'Adresse physique',
    isSecret: false,
  },
  {
    key: 'contact.orange_money_number',
    value: '06 000 0000',
    category: ConfigCategory.CONTACT,
    label: 'Numéro Orange Money (paiement pénalités)',
    isSecret: false,
  },
  {
    key: 'contact.airtel_money_number',
    value: '07 000 0000',
    category: ConfigCategory.CONTACT,
    label: 'Numéro Airtel Money (paiement pénalités)',
    isSecret: false,
  },

  // ── STORAGE ───────────────────────────────────────────────────────────────
  {
    key: 'storage.driver',
    value: 'S3',
    category: ConfigCategory.STORAGE,
    label: 'Fournisseur actif (S3 | CLOUDFLARE | CLOUDINARY | VERCEL_BLOB)',
    isSecret: false,
  },
  // S3
  {
    key: 'storage.s3.bucket',
    value: '',
    category: ConfigCategory.STORAGE,
    label: 'S3 – Nom du bucket',
    isSecret: false,
  },
  {
    key: 'storage.s3.region',
    value: 'us-east-1',
    category: ConfigCategory.STORAGE,
    label: 'S3 – Région',
    isSecret: false,
  },
  {
    key: 'storage.s3.access_key_id',
    value: '',
    category: ConfigCategory.STORAGE,
    label: 'S3 – Access Key ID',
    isSecret: true,
  },
  {
    key: 'storage.s3.secret_access_key',
    value: '',
    category: ConfigCategory.STORAGE,
    label: 'S3 – Secret Access Key',
    isSecret: true,
  },
  {
    key: 'storage.s3.endpoint',
    value: '',
    category: ConfigCategory.STORAGE,
    label: 'S3 – Endpoint personnalisé (optionnel)',
    isSecret: false,
  },
  // Cloudflare R2
  {
    key: 'storage.cloudflare.account_id',
    value: '',
    category: ConfigCategory.STORAGE,
    label: 'Cloudflare R2 – Account ID',
    isSecret: false,
  },
  {
    key: 'storage.cloudflare.bucket_name',
    value: '',
    category: ConfigCategory.STORAGE,
    label: 'Cloudflare R2 – Nom du bucket',
    isSecret: false,
  },
  {
    key: 'storage.cloudflare.kyc_bucket_name',
    value: '',
    category: ConfigCategory.STORAGE,
    // Séparé du bucket principal PARCE QUE R2 n'a pas d'ACL par objet : un
    // bucket est public ou privé en entier. Les avatars et les images de
    // réclamation doivent rester publics, les pièces d'identité non — il faut
    // donc deux buckets, et non deux réglages sur le même.
    label: 'Cloudflare R2 – Bucket KYC (privé)',
    isSecret: false,
  },
  {
    key: 'storage.cloudflare.access_key_id',
    value: '',
    category: ConfigCategory.STORAGE,
    label: 'Cloudflare R2 – Access Key ID',
    isSecret: true,
  },
  {
    key: 'storage.cloudflare.secret_access_key',
    value: '',
    category: ConfigCategory.STORAGE,
    label: 'Cloudflare R2 – Secret Access Key',
    isSecret: true,
  },
  {
    key: 'storage.cloudflare.public_base_url',
    value: '',
    category: ConfigCategory.STORAGE,
    label: 'Cloudflare R2 – Public Base URL (ex: https://pub-xxx.r2.dev)',
    isSecret: false,
  },
  // Cloudinary
  {
    key: 'storage.cloudinary.cloud_name',
    value: '',
    category: ConfigCategory.STORAGE,
    label: 'Cloudinary – Cloud Name',
    isSecret: false,
  },
  {
    key: 'storage.cloudinary.api_key',
    value: '',
    category: ConfigCategory.STORAGE,
    label: 'Cloudinary – API Key',
    isSecret: true,
  },
  {
    key: 'storage.cloudinary.api_secret',
    value: '',
    category: ConfigCategory.STORAGE,
    label: 'Cloudinary – API Secret',
    isSecret: true,
  },
  // Vercel Blob
  {
    key: 'storage.vercel_blob.token',
    value: '',
    category: ConfigCategory.STORAGE,
    label: 'Vercel Blob – Read/Write Token',
    isSecret: true,
  },
];

export const STORAGE_ENV_OVERRIDES: Record<string, Record<string, string>> = {
  S3: {
    AWS_S3_BUCKET: 'storage.s3.bucket',
    AWS_REGION: 'storage.s3.region',
    AWS_ACCESS_KEY_ID: 'storage.s3.access_key_id',
    AWS_SECRET_ACCESS_KEY: 'storage.s3.secret_access_key',
    AWS_ENDPOINT_URL: 'storage.s3.endpoint',
  },
  CLOUDFLARE: {
    CLOUDFLARE_ACCOUNT_ID: 'storage.cloudflare.account_id',
    CLOUDFLARE_BUCKET_NAME: 'storage.cloudflare.bucket_name',
    CLOUDFLARE_KYC_BUCKET_NAME: 'storage.cloudflare.kyc_bucket_name',
    CLOUDFLARE_ACCESS_KEY_ID: 'storage.cloudflare.access_key_id',
    CLOUDFLARE_SECRET_ACCESS_KEY: 'storage.cloudflare.secret_access_key',
    CLOUDFLARE_PUBLIC_BASE_URL: 'storage.cloudflare.public_base_url',
  },
  CLOUDINARY: {
    CLOUDINARY_CLOUD_NAME: 'storage.cloudinary.cloud_name',
    CLOUDINARY_API_KEY: 'storage.cloudinary.api_key',
    CLOUDINARY_API_SECRET: 'storage.cloudinary.api_secret',
  },
  VERCEL_BLOB: {
    BLOB_READ_WRITE_TOKEN: 'storage.vercel_blob.token',
  },
};
