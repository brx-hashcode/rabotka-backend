# PROJECT_CONTEXT.md — Rabotka

> Context file for the AI support assistant. Consumed by Claude Code alongside
> `CLAUDE_CODE_PROMPT.md`, and used as the source for the `help_docs` corpus.
>
> **Provenance legend** — every factual claim carries one:
>
> | Tag | Meaning |
> |---|---|
> | `[CODE]` | Verified against this repository, with the path. If the code moves, this line is wrong — re-check before trusting it. |
> | `[RUNTIME]` | True shape, but the *value* lives in the DB (`SystemConfig`) or in a user's row. The assistant explains the mechanism and **reads the number from a tool**, never from here. |
> | `[PITCH]` | From the investor/pitch document. Positioning language — accurate as intent, but it is not what the product does today, and it must not be restated to a user as fact. |
> | `[OPEN]` | Genuinely undecided. Never let the assistant state an `[OPEN]` item to a user. |
>
> **The rule that matters**: this file is *ground truth about the product*, not
> the corpus, and not a place to invent vocabulary. A fact with no tag is a bug
> in this document.

---

## 1. Product identity

| Field | Value | |
|---|---|---|
| Name | Rabotka | |
| One line | Plateforme WhatsApp de mise en relation entre travailleurs informels et employeurs de confiance | `[PITCH]` |
| Launch market | Brazzaville, République du Congo — but the platform is **not geofenced**: 252 countries and their cities are selectable at onboarding | `[CODE]` `src/modules/geo/data/geo-dataset.json` |
| In-product tagline | « Trouvez une mission. Trouvez de l'aide. Directement sur WhatsApp. » | `[CODE]` `rabotka-client/src/content/landing/hero.ts` |
| Pitch tagline | « Parce que chaque personne mérite un emploi. » | `[PITCH]` — appears nowhere in the product. Do not put it in a user reply. |
| Entry / notification channel | **WhatsApp bot** — Twilio *or* Meta Cloud API, selected by `WHATSAPP_PROVIDER` | `[CODE]` `src/modules/whatsapp/whatsapp.config.ts`, `docs/whatsapp-providers.md` |
| Main surface | React SPA at `https://rabotka.work`, opened from WhatsApp links | `[CODE]` `rabotka-client/` |
| App type | **Web app (SPA, nginx-served)**, plus an Expo/React-Native app (`scheme: rabotkamobile`) | `[CODE]` `rabotka-client/nginx.conf`, `rabotka-mobile/app.config.ts` |
| Currency | FCFA / XAF, integer amounts | `[CODE]` `src/modules/bot/messages/*.ts` |

The WhatsApp bot is the doorway, not the destination. The bot's links are
rewritten into **one-tap auto-login links** before sending (see §8.2), so
"opens the app" means *lands signed-in on the right screen*, not "shows a login
form". Both surfaces are live, and the assistant must work on both.

**Consequence for the assistant**: one brain, two renderers. Same agent, same
tools, same canonical action ids — only the presentation layer differs. See §8.

### 1.1 « C'est quoi Rabotka ? » — la réponse de référence

**« C'est quoi Rabotka ? » / « Que veut dire Rabotka ? »** — the canonical
description `[PITCH]`:

> Rabotka est une plateforme de mise en relation professionnelle pensée pour les
> réalités du marché informel urbain. Au lieu de demander aux utilisateurs de
> télécharger une application ou de maîtriser des outils complexes, Rabotka
> fonctionne principalement à travers WhatsApp, un canal déjà utilisé au
> quotidien par les travailleurs, les familles et les petites entreprises.

For end users, compress to two sentences and go straight to the next action
(« Vous cherchez une mission, ou vous cherchez quelqu'un ? »). Suggested
user-facing form:

> Rabotka met en relation les personnes qui cherchent une mission et celles qui
> cherchent quelqu'un de confiance — directement sur WhatsApp, sans application
> à installer.

**Étymologie du nom** `[OPEN — non-blocking]`. Still undocumented, and nothing in
the codebase names an origin. If asked specifically about the origin or literal
meaning of the word and `rechercher_aide` returns nothing, **do not guess** —
give the "c'est quoi Rabotka" answer instead, which is what the user almost
certainly wanted. Keep this as a named hallucination test in the eval set:
brand etymology is a claim models invent confidently.

---

## 2. Users

**Travailleur** (`ProfileType.WORKER`) — informal-sector worker offering
services. Often low digital literacy, on a low-end Android phone,
data-conscious, may speak French as a second language.

**Employeur / Recruteur** (`ProfileType.EMPLOYER`) — a household, individual, or
small business hiring for a mission. Wants speed and reassurance about who
they're letting into their home.

Both go through the same trust gate: register → KYC → activate WhatsApp →
transact. `[CODE]` `prisma/schema.prisma` (`Profile`, `ProfileType`)

**Vocabulary the product actually uses** `[CODE]` — the client repo unified this
deliberately (commit *"unify the work vocabulary on mission"*):

- « **mission** » for a unit of work. Not « job », not « annonce », not « boulot ».
- « **travailleur** » and « **recruteur** » (the UI says *recruteur*; the code
  says `EMPLOYER`).
- « **candidature** » for an application, « **offre** » for the posting.
- `Contract` in code = the generated PDF agreement, **not** the offer type.

---

## 3. Core flows `[CODE]`

### Worker
1. Registers on the web app: identity, city/country, categories, description.
   A **welcome credit** is granted `[RUNTIME]`.
2. Uploads KYC — ID document **and** a selfie — reviewed by an admin.
   `VerificationStatus PENDING → APPROVED/REJECTED`, `AccountStatus
   PENDING_ACTIVATION → ACTIVE`.
3. Receives a WhatsApp activation message; sending `/` opens the menu.
4. Browses missions, receives recommendations, or opens a specific offer by its
   **reference** (`JobOffer.reference`, unique, user-quotable).
5. Applies → employer accepts → **both sides pay to unlock contact** → performs
   the mission → mutual rating.

### Employer
1. Registers, KYC, activation — identical gate.
2. Publishes a mission: title, description, category, `employment_type`
   (default and effectively only supported value: `MISSION`), amount +
   `payment_flow` (HOURLY/DAILY/MONTHLY), address / country / city / lat-lng or
   `is_remote`, closing date (`scheduled_at`), `quantity` (seats).
3. Receives applications and recommended profiles, each with a reliability
   score.
4. Accepts a worker → unlocks contact → follows the mission → rates.

**Daily application cap** exists (`fees.max_daily_applications`) `[RUNTIME]` —
a worker hitting it is not broken, and the assistant should say so plainly.

---

## 4. Domain concepts the assistant must explain correctly

| Concept | Meaning | Assistant must know |
|---|---|---|
| **Vérification (KYC)** | ID document + selfie, reviewed by a human admin `[CODE]` `KycDocument`, `KycVerificationImage` | Mandatory, not optional. Rejection carries a reason (`rejection_reason`) the user can read. Never promise a delay. |
| **Contact masqué** | Phone/email hidden until unlock | Core safety **and** revenue mechanism. Never circumvent, never hint. |
| **Déblocage de contact** | Bilateral paid action after acceptance | Both sides pay. Flat fee, different per side. Read it from a tool. See §4.1. |
| **Crédit de bienvenue** | Wallet credit granted at registration | Sized so the first contact is effectively covered. Explain it exists; read the balance from a tool. |
| **Portefeuille / wallet** | Per-profile ledger, top-up-able by mobile money `[CODE]` `Wallet`, `WalletTransaction` | Balances and history come from a tool, always. |
| **Pénalité** | Fee for late cancellation / no-show `[CODE]` `Penalty` | Unpaid penalties escalate `BillingStatus` to `BLOCKED`. Payable by mobile money. |
| **Évaluations** | 1–5★, both directions, post-mission `[CODE]` `Rating`, `RatingDirection` | Feeds the reliability score. |
| **Score de fiabilité** | `Profile.reliability_score`, starts at 100 `[CODE]` | Explain *how to improve it*; never invent the user's number, never quote the deltas from memory. |
| **Référence d'offre** | `JobOffer.reference`, unique string | The handle a user can paste to reach one offer. |
| **Gestion des litiges** | `Claim` + `ClaimComment`, assignable to an admin `[CODE]` | Always escalate. Never adjudicate. |
| **Recommandations** | Vector matching + behavioural signals | See §5. |

### 4.1 The contact-unlock state machine `[CODE]` `src/modules/contact-unlock/`

This is the single most support-heavy mechanism in the product, and "will I get
my money back?" is a top-3 question. The assistant must get it right:

| `ContactUnlockStatus` | What the user experiences |
|---|---|
| `PENDING_BOTH` | Neither side has paid yet. |
| `PENDING_EMPLOYER` / `PENDING_WORKER` | One side paid; waiting on the other. |
| `UNLOCKED` | Both paid — contacts revealed on both sides, delivered by WhatsApp template. |
| `EXPIRED` | The window elapsed with only one side paid. |
| `CONVERTED_TO_CREDIT` | **The payer's money went back to their wallet as credit.** Not lost. |

Rules that follow, and that the assistant must never get backwards:
- Payment is **per side**, and the second payer is what completes it.
- **A multi-seat offer is paid once by the employer** (`employer_unlock_paid`).
- The expiry window is configurable (`fees.contact_unlock_expiry_hours`) `[RUNTIME]`.
- An unlock reached from the **recommendation feed** is a different, one-sided
  path with its own fee (`fees.contact_recommendation_fee_employer`) `[RUNTIME]`.

### 4.2 Account state gating — the assistant is not exempt `[CODE]` `src/modules/bot/services/bot-orchestrator.service.ts`

The bot already answers differently per state, and the assistant must mirror it
rather than promising actions the platform will refuse:

| State | What the user can do |
|---|---|
| `PENDING_ACTIVATION` | KYC pending — browsing and transacting are gated. Answer: what's missing, and that a human reviews it. |
| `ACTIVE` | Full access. |
| `SUSPENDED` | Everything answers with the **support card**, carrying the admin's `suspension_reason`. |
| `BANNED` | Terminal. Escalate; do not negotiate. |
| `BillingStatus.BLOCKED` | Unpaid penalties gate every feature until settled. The reply must name the way out (pay), never just refuse. |

**`support` is answered in every state** — including suspended and
KYC-rejected, because those are exactly the users who need it. Any scope rule
the assistant applies must preserve that.

---

## 5. Recommendations — how to describe them to users

Two rankers exist behind a percentage rollout (`legacy` / `v2`, bucketed by a
stable hash of the profile id) `[CODE]`
`src/modules/recommendation-engine/engine-rollout.service.ts`. **The assistant
must never claim to know which engine served a result, or why a specific offer
was recommended** — it has no access to ranking internals.

What is true of both `[CODE]` `prisma/schema.prisma` (`InteractionKind`),
`src/modules/interest-graph/`:

- User actions are read as signals, graded from passive to committed:
  `VIEW` / `PROFILE_VIEW` → `SEARCH`, `SAVE` → `APPLY`, `ACCEPT`,
  `CONTACT_UNLOCK` / `CONTACT_PAID` (the strongest employer signal there is) →
  `COMPLETE`, `RATE_POSITIVE`. Negatives: `SKIP`, `DISLIKE`, `APPLY_CANCEL`,
  `NO_SHOW`, `RATE_NEGATIVE`.
- **An auto-rejection is not a negative signal.** `RejectionSource.AUTO_FILL`
  (the offer filled up) is deliberately distinguished from an employer actively
  turning someone down, so losing a race never narrows a worker's feed. If a
  user asks « pourquoi je ne reçois plus d'offres dans mon métier ? », the
  honest answer is about profile completeness and activity — never "you were
  rejected too often".
- Ranking mixes match quality, proximity (country/city are **filters** in the
  vector payload, not just score terms), and freshness, and reserves a share of
  discovery.
- Behaviour by maturity: new user → declared profile (skills, description,
  categories); active user → adapts to what they view/save/apply to;
  experienced user → more stable, less swayed by any single action.

**Framing rule**: plain language — *« plus vous utilisez Rabotka, mieux il
comprend ce que vous cherchez »*. Do not say *algorithme*, *machine learning*,
*embedding*, *vecteur*, or *score* to end users unless they ask a technical
question.

---

## 6. Vocabulary — there is no secret jargon

**Correction to an earlier draft of this file**: the term *zakaz* was listed
here as `[CONFIRMED]` product vocabulary. It appears **nowhere** in the backend,
the client, the mobile app, the database schema, or any user-facing string —
`grep -ri zakaz` matches only this document. It was an inference from the name
*Rabotka* (< rabota), not a product decision.

Rules, therefore:

1. The product noun is « **mission** ». The assistant says *mission*. It does not
   introduce, gloss, or answer to invented Slavic vocabulary.
2. If a user types an unknown word, treat it as a normal query — do not assume it
   is internal jargon.
3. If the team later *does* adopt a product term, it lands here **with the commit
   that puts it in the UI**, not before. A bot speaking a word the screen does not
   show is worse than no vocabulary at all.

**Never translated**, in any language: category slugs, action ids, the offer
`reference`, and status names. They are identifiers, not words.

### 6.1 Retrieval reality — read this before writing the corpus `[CODE]` `src/modules/qdrant/qdrant.service.ts`

The stack is already hybrid, so the "enable hybrid search" recommendation in the
earlier draft is **done**:

| Piece | Value |
|---|---|
| Dense model | `EmbeddingModel.BGESmallENV15` — **384 dims** |
| Sparse model | `SparseEmbeddingModel.SpladePPEnV1` |
| Store | Qdrant, named vectors `dense` + `sparse`, Cosine |
| Collections | `rabotka_{dev,prod}_` × `workers`, `jobs`, `employers`, `signals`, `user_interests` |
| Payload schema version | `INDEX_SCHEMA_VERSION = 2` — **bump it whenever a payload field changes**, or `reindexPending` will never rewrite old points and a new filter will silently empty retrieval |
| Guardrail | `QdrantService` refuses to operate on any collection not prefixed `rabotka_{env}_` — a `help_docs` collection **must** follow that prefix or every call throws |

**The real risk is not jargon — it is that both embedding models are
English-only** (`BGE-small-*-en-v1.5`, `SPLADE++ En v1`) while the corpus, the
UI, and the users are French. Before building `help_docs`:

1. **Measure French retrieval** on a held-out set of real questions. Do not
   assume the current models are adequate for prose French just because they
   rank job/skill text acceptably.
2. If recall is weak, use a **multilingual dense model for `help_docs` only**
   (a separate collection can carry its own model and dimension — matching and
   help retrieval need not share one).
3. Keep the sparse leg regardless: exact lexical matches on *pénalité*,
   *déblocage*, *KYC*, and a pasted offer `reference` are precisely what dense
   vectors blur.
4. Seed the corpus with the words users actually type, including misspellings
   and unaccented forms (*penalite*, *deblocage*) — phone keyboards drop
   accents, and the bot's own command lists already account for this `[CODE]`
   `src/modules/bot/bot.constants.ts`.

---

## 7. Service categories and locations

### Categories — 76 seeded, kebab-case `[CODE]` `prisma/seed/job-category.seed.ts`

The earlier draft listed ~11 hand-written snake_case slugs (`menage`,
`garde_enfants`). Both the count and the format were wrong. The real taxonomy is
**76 categories**, slugged kebab-case, grouped as: travaux & bricolage,
déménagement & manutention, nettoyage & entretien, cuisine & traiteur, services
à la personne, beauté & bien-être, couture & artisanat, mécanique & réparations,
sécurité, transport, commerce & administration, agriculture, a
Congo-Brazzaville-specific block (moto-taxi, vente ambulante, vulcanisation,
poissonnerie, vannerie-tissage, teinturerie, forgeron…), a qualified-trades
block, and `autre`.

Representative slugs — **not the whole list**:

```
maconnerie · electricite · plomberie · menuiserie · peinture-decoration
nettoyage · femme-de-menage · blanchisserie-repassage · jardinage-espaces-verts
garde-enfants · nourrice · aide-domicile · cours-particuliers · soins-domicile
coiffure · barbier · esthetique-beaute · couture-retouche · cordonnerie
mecanique-automobile · reparation-motos · vulcanisation · reparation-electromenager
livraison-courses · demenagement · manutention · moto-taxi · transport-conduite
cuisine-restauration · traiteur-evenementiel · patisserie-boulangerie
gardiennage-securite · vente-ambulante · poissonnerie · peche · elevage-volailles
informatique-developpement · comptabilite-finance · autre
```

> **Build rule**: generate the tool enum from the database (or from
> `job-category.seed.ts`, which is its source), and fail the build on drift.
> 76 hand-copied strings will rot within a sprint, and a slug the model invents
> silently returns zero results instead of erroring.

### Locations — country + city, not arrondissements `[CODE]` `src/modules/geo/`

There is no Brazzaville-quartier taxonomy. What exists:

- `country_code` (ISO 3166-1 alpha-2) + `country_name` + `city`, on both
  `Profile` and `JobOffer`, plus optional `latitude`/`longitude`.
- A checked-in dataset of **252 countries and ~184 000 cities**, read at runtime
  from `src/modules/geo/data/geo-dataset.json` (58 cities for `CG`, Brazzaville
  and Pointe-Noire among them). Deliberately offline: onboarding must not depend
  on a third-party API.
- `JobOffer.is_remote` — a remote mission has **no** address, and distance is
  removed from its ranking entirely. Any location-shaped answer must handle it.

So `zone` in a tool signature is **country + city**, validated against the geo
dataset — never free text from the model, and never a neighbourhood.

---

## 8. Two surfaces, one agent

### 8.1 The command surface as it actually is `[CODE]` `src/modules/bot/bot.constants.ts`, `src/modules/bot/utils/chat-input.ts`

The earlier draft described `/start` and `/support`. The real design is more
forgiving, and the assistant must not regress it:

- `expandSlashCommand` rewrites a bare `/` to `menu`, and `/word` to `word`.
  **A bare `/` is the documented entry point** — it is what the landing page
  tells users to send.
- Matching is on **word lists**, accented and unaccented, not on slash syntax:
  - `CMD_MENU` — `menu`, `aide`, `help`, `bonjour`, `*`, `start`, `démarrer`,
    `demarrer`, `commencer`, `/`
  - `CMD_SUPPORT` — `support`, `aide`, `assistance`, `contact`, `réclamation`,
    `reclamation`
  - `CMD_PAY` — `payer`, `régler`, `regler`, `payer pénalités`, …
- These words **also escape a live flow**. Someone stuck mid-flow typing
  « start » gets out; that behaviour is load-bearing and must survive the
  assistant.
- Unrecognized free-form input today returns `unknownCommandMessage()` —
  *« Je n'ai pas compris votre réponse… Envoyez */* pour revenir aux options. »*

**That message is the assistant's seam.** Everything currently falling through
to it is exactly the traffic the agent should take: *« j'ai un problème »*,
*« nazali na problème »*, a voice note, a pasted offer reference. Deterministic
commands stay a fast path — never route `CMD_*` matches or an active flow step
through the LLM. A deterministic card is faster, cheaper, and cannot fail over.

**Flows own the conversation while they are open** `[CODE]` `FLOW_IDS`,
`FLOW_TTL_SECONDS`: accept/refuse a candidate, cancel a candidature, pay
penalties, rate an assignment, republish an expired offer, verify WhatsApp,
job-status check, post-cancellation actions. Each has its own TTL (10 min for
OTP-like, 1–2 h for payment/rating). **The assistant must not interject
mid-flow** — a numbered reply inside `pay_penalties` means a penalty, not a
question for the agent.

### 8.2 Deep links already exist — and they log the user in `[CODE]` `src/modules/auth/login-link.controller.ts`, `src/modules/whatsapp/whatsapp-outbound.processor.ts`

The earlier draft proposed building a redirect endpoint (`/go?t={{1}}`). **It
exists**, and it is better than the sketch:

- Every first-party URL the bot sends is rewritten by `withLoginLinks` into
  `https://rabotka.work/s/<code>` before delivery.
- `GET /s/:code` resolves the code to **both the profile and the destination**,
  sets the auth cookie, and redirects to the real page. One tap, no OTP.
- Codes are single-use, base64url, throttled at 20/min. A re-tapped old link
  falls back gracefully to an existing session rather than bouncing to `/login`.
- That is exactly what makes a template button the fixed string `…/s/{{1}}` —
  one variable, at the end, where WhatsApp requires it. **No new Meta review per
  destination.**

Real destinations to land on (client routes) `[CODE]` `rabotka-client/src/app/routes/index.tsx`:

```
/home · /jobs · /recherche-offres · /offres/:id · /mes-candidatures
/candidatures/:id · /candidatures/:id/paiement · /applications/:id
/missions · /missions/:id · /job-offers/new · /job-offers/:id
/dashboard · /profils-contactes · /recommandations/:workerId · /recherche
/profile · /profile/portfolio · /portefeuille · /favoris
/penalites/paiement · /claims · /claims/new · /claims/:id
/p/:slug (portfolio public) · /pay/:token · /s/:code · /r/:hash
```

So `ouvrir_app(cible, …)` takes a **canonical enum of these destinations**, the
server mints the `/s/<code>`, and the model never emits a URL. The gap the draft
worried about ("only the home screen") does not exist.

| Surface | Rendering |
|---|---|
| WhatsApp | CTA-URL button or text link, carrying the minted `/s/<code>` |
| In-app assistant | Client-side route push, no reload |

### 8.3 WhatsApp constraints

**No token streaming.** WhatsApp delivers whole messages. Budget the entire
fallback chain: target p95 under 5 s, with a holding message if a tool call runs
long.

**Interactive limits.**

| Primitive | Limit |
|---|---|
| Reply buttons | max 3, ~20 chars per label |
| List message | max 10 rows, sectioned |
| CTA URL button | 1 per message |

The button/row **id** is canonical (`action:publier_mission`); the **title** is
localized. Nothing downstream parses a user-language string. `[CODE]` — the
inbound normalizer already collapses Twilio `ButtonPayload` and Cloud
`interactive`/`button` into one `interactive_reply { replyId, title }`, so
flows cannot tell the providers apart.

**Message length is a product constraint.** Cap replies at ~600 characters;
prefer two buttons over a paragraph. Long explanations belong in the app behind
a deep link.

**No markdown.** WhatsApp supports `*bold*`, `_italic_`, and hyphen lists only.
Strip everything else — models emit `##` headers otherwise. The bot already ships
a `stripChatFormattingChars` helper `[CODE]`.

**24-hour window.** Inside the window (any inbound message opens it, each new one
restarts it) the assistant sends free-form service messages and interactive
messages, including `cta_url` with runtime URLs — **no template approval
needed**, which covers ~all assistant traffic since it only ever replies.

Outside the window, only approved templates re-initiate contact. Consequences:

1. The CTA base URL is frozen at approval time; only a trailing suffix varies.
   **Already solved by `/s/{{1}}`** (§8.2).
2. **LLM text can never go in a template body.** Template re-opens the window →
   user replies → *then* the assistant speaks.

**The template registry is real and typed** `[CODE]`
`src/common/constants/whatsapp-templates.ts` — **29 templates**, each with a
category (`AUTHENTICATION` / `UTILITY` / `MARKETING`), a Twilio `contentSid`,
a Meta Cloud name, and a typed `variables()` builder. Cloud default language is
`fr`. Existing keys include `otp`, `welcomePlatform`, `kyc`, `kycRejected`,
`accountSuspended`, `accountActivatedWorker/Employer`, `newApplication`,
`applicationAccepted`, `applicationAcceptedUnlock`, `applicationRejected`,
`contactUnlocked`, `contactUnlockedRecommendation`, `unlockExpiredConversion`,
`jobRecommendation`, `reminder24h`, `reminderStart`, `statusCheck`,
`cancellation`, `offerExpired*`, `adminMessage`.

**Before proposing a new template, check this registry** — most re-engagement
the assistant might want already has one. And note two are already **WhatsApp
Flows** (`flowTokenVar`), used to collect post-unlock feedback: interactive
forms are an available primitive, not a future one.

The assistant must never promise a follow-up it can only deliver via template —
that is a scheduled job, not an agent action.

**Voice notes** `[CODE]` — inbound audio **is** received and normalized
(`{ type: 'audio', mediaId, mimeType }` in `inbound-normalizer.ts`, alongside
image/video/document/location/reaction and an `unsupported` catch-all). **There
is no transcription anywhere in the codebase.** So today an audio message
reaches the bot as an unhandled type. Decision needed `[OPEN]`: wire an ASR step
before the agent, or reply with a short "envoyez-moi ça en texte" nudge.
Transcription of Lingala/Kituba is weak — if ASR ships, route low-confidence
transcripts to a clarifying question rather than guessing.

### 8.4 In-app assistant

Inside the app: SSE streaming, token/action/status events, client-side
navigation on `action`. Richer context is available — current screen, the offer
being viewed, and the app already stamps a request id used to correlate a feed
with the taps that follow `[CODE]` `src/common/middleware/request-id.middleware.ts`.
Inject it. Same agent, same tools; only the transport and the renderer differ.

---

## 9. Languages

| Tier | Languages | Reality |
|---|---|---|
| Primary | **Français** | The product language. All bot copy, all templates (`CLOUD_DEFAULT_LANGUAGE = 'fr'`), the whole client UI. Corpus language, fallback default. `[CODE]` |
| Backend i18n | fr, **en**, **ru** | `src/i18n/{en,fr,ru}` exists and is resolved from `Accept-Language` — but only API messages are translated, not the bot. `[CODE]` |
| Aspirational | English, Português, Lingala, Kituba | **Zero support in the codebase today.** `[PITCH]` / `[OPEN]` |

The earlier draft assigned Lingala and Kituba a "best-effort" support tier. Not
supported by anything in the repo — and given the embedding models are
English-only (§6.1), cross-lingual retrieval into a French corpus is an
unvalidated assumption, not a tier. Validate against real Brazzaville usage
before promising any of it.

Rule: reply in the language of the user's last message; on mixed input use the
dominant language; when unsure, **French**; never comment on the language
choice. Category slugs, city names, action ids, and offer references stay
canonical always.

---

## 10. Assistant scope

### It should
- Explain how Rabotka works: KYC, contact unlock, credit, wallet, ratings,
  reliability score, penalties.
- Tell a user what's missing from their profile and why it matters.
- Explain **where a user is** in a flow: candidature status, unlock status,
  penalty balance — read from tools, in the user's own words (§11).
- Search offers (worker) or guide publishing a mission (employer), one question
  at a time.
- Explain why a contact unlock costs something, what the user gets, and **what
  happens if the other side never pays** (§4.1 — the money comes back as
  credit).
- Hand off to a human for disputes, payment problems, and verification failures.

### It must never
- **Reveal or hint at a phone number or email, or help users exchange contact
  outside the unlock flow.** Simultaneously the revenue model and the safety
  model. Hard refusal, politely phrased — including when the user claims the
  unlock already happened, since only a tool can confirm that.
- Quote a price, fee, credit balance, reliability score, penalty amount, or
  delay from memory. These come from a tool or they don't get said.
- Promise a job, a hire, an income, or a timeframe for either — **including KYC
  review time**, which is a human queue with no SLA in code.
- Claim a user or an offer is verified/trustworthy without a tool confirming it.
- Take an action on the user's behalf — applying, publishing, unlocking,
  cancelling, paying. It proposes; the user confirms via button, and the
  existing flow executes.
- Interrupt or reinterpret an open bot flow (§8.1).
- Adjudicate a dispute, assign blame, or discuss another user's data.
- Give legal, contractual, tax, or immigration advice. Escalate instead.

### Sensitive category: `garde-enfants` / `nourrice`
Childcare missions involve minors. Never coach anyone on appearing more
trustworthy, never downplay verification, and surface the safety guidance (meet
first, verify identity, never leave the platform) on every childcare exchange.
Any request that looks like an attempt to reach a child, or to bypass vetting,
is escalated to a human immediately and is not handled conversationally.

### Escalation triggers → human support
Dispute or complaint · payment or mobile-money failure · verification rejected ·
account suspended or banned · safety concern, harassment, or a mission that went
wrong · anything involving a minor's safety · user explicitly asks for a person ·
assistant has failed to resolve the same question twice.

**Escalation has a real destination** `[CODE]`: a `Claim` (title, description,
attachments, `ClaimStatus CREATED → IN_PROGRESS → COMPLETED/REJECTED`,
assignable to an admin `User`, with threaded `ClaimComment`s and WebSocket
notifications). `escalader_support` should create or point at a claim —
`/claims/new` is a real client route, and the KYC-rejection template already
sends users there. The support card itself carries `contact.email` /
`contact.phone` from `SystemConfig` `[RUNTIME]` and states the hours: **lundi–samedi, 8h–18h**.

---

## 11. Tools the assistant needs `[schemas TO BUILD against the existing REST API]`

| Tool | Purpose | Notes |
|---|---|---|
| `rechercher_aide(question_fr)` | RAG over `help_docs` | Only source of policy/how-to facts |
| `etat_du_profil()` | Missing fields, `verification_status`, `status`, `billing_status`, % complete | `profile_id` injected server-side, never an arg |
| `rechercher_offres(description_fr, categorie_slug, pays, ville)` | Worker-side offer search | `categorie_slug` from the generated 76-value enum; `pays`/`ville` validated against the geo dataset; must handle `is_remote` |
| `offre_par_reference(reference)` | Resolve a pasted `JobOffer.reference` | High-value, purely lexical — the sparse leg earns its keep here |
| `mes_candidatures()` | `ApplicationStatus` per candidature | Translate to French user-facing wording, never raw enum |
| `etat_deblocage(candidature_id)` | `ContactUnlockStatus` + who still owes | Answers "et mon argent ?" correctly (§4.1) |
| `solde_credit()` | Wallet balance + welcome credit | The only source of any number about money |
| `tarif_deblocage(offre_id)` | Current unlock fee for this side | Never memorized |
| `mes_penalites()` | Unpaid penalties + `billing_status` | Must name the way out, like `hasPenaltiesBotMessage` does |
| `assistant_publication(...)` | Guided mission publication | Proposes; user confirms; hands to the existing create flow |
| `proposer_actions(...)` / `proposer_liste(...)` | Buttons / list replies | Limits in §8.3 |
| `ouvrir_app(cible, label)` | Deep link | `cible` is a canonical enum of §8.2 routes; the server mints `/s/<code>` |
| `carte_support()` | Emits the same support card as the `support` command | Deterministic, no LLM in the path, works in every account state |
| `escalader_support(motif)` | Creates / points at a `Claim` | See triggers above |

Every tool's arguments are flat: strings, enums, numbers. No nested objects, no
`anyOf` — they break portability across providers and the fallback then fails on
a 400.

**Note**: there is **no LLM dependency in the backend today** (`grep -riE
"anthropic|openai|@ai-sdk"` → nothing). This module is greenfield; every tool
above wraps an existing service (`ProfileService`, `JobOfferService`,
`ContactUnlockService`, `WalletService`, `PenaltyService`, `ClaimService`),
which is the cheap path — the business rules are already written and tested.

---

## 12. Help corpus (`help_docs`) — what to write

The pitch document is **not** the corpus: it is investor-facing and contains
positioning language that must never reach a user. Write the corpus separately,
as short user-facing articles, one per question:

- C'est quoi Rabotka et comment ça marche (§1.1)
- Comment m'inscrire sur Rabotka
- Comment fonctionne la vérification (KYC), et pourquoi elle est obligatoire
- Ma vérification a été refusée — que faire
- Comment compléter mon profil de travailleur
- Comment publier une mission (recruteur)
- Pourquoi les numéros sont masqués
- Qu'est-ce que le déblocage de contact et comment ça marche
- **Et si l'autre personne ne paie pas ? (expiration et conversion en crédit)**
- Qu'est-ce que le crédit de bienvenue
- Mon portefeuille : solde, recharge, transactions
- Pénalités : pourquoi, combien, comment payer, et le déblocage du compte
- Comment fonctionnent les évaluations
- Qu'est-ce que le score de fiabilité et comment l'améliorer
- Pourquoi je reçois ces offres (recommandations, in plain language)
- Retrouver une offre avec sa référence
- Mon compte est suspendu — que faire
- Sécurité : conseils avant une première mission
- Sécurité : missions de garde d'enfants
- Que faire en cas de problème ou de litige (réclamations)
- Paiement et mobile money
- Contacter le support humain

Each: French, under 400 words, plain vocabulary, no jargon, ending with the
concrete next action. Chunk by heading. Store `source`, `section`, and
`action_id` in the Qdrant payload so a retrieved chunk can suggest its own
button — and **carry the `INDEX_SCHEMA_VERSION` discipline over** (§6.1): a
payload change without a version bump leaves the back catalogue unfilterable.

Where an article states a number (fee, penalty, delay, cap), write it as a
**placeholder that the assistant fills from a tool**, never as literal text. The
values are admin-editable at runtime; a corpus that hardcodes them will be wrong
without anyone noticing.

---

## 13. Open questions — answer before phase 3

Answered by this pass (kept for the record):

- ~~Exact category and zone slugs~~ → §7: 76 kebab-case slugs from
  `job-category.seed.ts`; locations are country + city from the geo dataset.
- ~~Do deep links to specific screens exist?~~ → §8.2: yes, `/s/<code>`, with
  auto-login.
- ~~Cloud API or BSP?~~ → both, behind `WHATSAPP_PROVIDER`; 29 typed templates,
  Cloud names already registered, Flows in use.
- ~~Unlock pricing model?~~ → §4.1: flat, per side, plus a distinct
  recommendation-path fee; all in `SystemConfig`.
- ~~What does verification require?~~ → §4: ID document + selfie, human review,
  reason on rejection. **No SLA exists — never quote a delay.**
- ~~Existing Qdrant collections / model / dimension?~~ → §6.1.
- ~~Is there a support inbox to hand off to?~~ → §10: the `Claim` system.

Still open:

1. **Voice notes in v1?** Audio arrives and is normalized; nothing transcribes
   it (§8.3).
2. **Ship WhatsApp-first, in-app-first, or both?** Nothing in the code decides
   this.
3. **French retrieval quality** with English-only embedding models — measure
   before committing to `help_docs` (§6.1).
4. **Opt-in mechanics for proactive recommendation templates** — `jobRecommendation`
   exists and is governed by `matching.recommendations_enabled` and
   `matching.min_notification_score`, but there is no per-user consent flag.
5. **Does the assistant get its own `SystemConfig` kill switch?** Everything else
   risky in this platform has one; it should too.
6. **Eval set**, including the named hallucination tests: brand etymology (§1.1),
   invented jargon (§6), a quoted fee (§10), and a promised KYC delay (§10).
