import {
  cityOf,
  EMPLOYMENT_LABEL,
  excerpt,
  frDate,
  jobPostingLd,
  maskContacts,
  offerPath,
  payLabel,
  publicEmployer,
  type PublicOfferRow,
} from './job-page-model';
import type { Listing } from './job-pages.service';

/**
 * The public job pages as plain HTML: readable by search engines and link
 * previews (WhatsApp, Facebook) without running any script. Same look as the
 * candidate app — its colours, its Gilroy headings (served by the app at
 * `/fonts`), its logo — light or dark as the phone is.
 */

export const esc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** JSON inside a <script>: nothing in it may close the tag. */
const ldJson = (data: unknown) => JSON.stringify(data).replace(/</g, '\\u003c');

const STYLE = `
@font-face{font-family:Gilroy;src:url(/fonts/Gilroy-ExtraBold.otf) format("opentype");font-weight:800;font-display:swap}
:root{--bg:#f2f5f9;--card:#fff;--ink:#0f2416;--muted:#6b7280;--line:#e3e8ef;--green:#25d366;--green-dark:#1fb155;--lime:#d4ffa3;--lime-ink:#0f2416;--chip:#eef2f7}
@media (prefers-color-scheme:dark){:root{--bg:#0b120d;--card:#141c16;--ink:#ecf3ee;--muted:#9aa5a0;--line:#223027;--chip:#1c2620;--lime:#2b4a1d;--lime-ink:#d4ffa3}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
a{color:inherit}
.wrap{max-width:1040px;margin:0 auto;padding:0 16px}
header.top{position:sticky;top:0;z-index:2;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(10px)}
header.top .wrap{display:flex;align-items:center;justify-content:space-between;gap:12px;height:64px}
.brand{display:flex;align-items:center;gap:10px;text-decoration:none;font:800 20px/1 Gilroy,system-ui,sans-serif}
.brand img{width:34px;height:34px;border-radius:10px}
header.top nav{display:flex;align-items:center;gap:6px}
header.top nav a{text-decoration:none;font-weight:500;font-size:15px;padding:10px 14px;border-radius:999px}
header.top nav a:hover{background:var(--card)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;text-decoration:none;font-weight:600;border-radius:999px;padding:12px 20px;background:var(--ink);color:var(--bg)}
.btn:hover{opacity:.9}
.btn.green{background:var(--green);color:#fff}
.btn.soft{background:var(--chip);color:var(--ink)}
header.top nav .btn{padding:10px 16px;font-size:15px}
@media (max-width:520px){header.top nav .hide-sm{display:none}}
h1,h2{font-family:Gilroy,system-ui,sans-serif;font-weight:800;letter-spacing:-.01em;line-height:1.15;margin:0}
h1{font-size:clamp(28px,5vw,44px)}
h2{font-size:22px}
.crumbs{display:flex;flex-wrap:wrap;gap:6px;font-size:14px;color:var(--muted);margin:20px 0 14px}
.crumbs a{text-decoration:none}.crumbs a:hover{text-decoration:underline}
.hero{padding:8px 0 20px}
.hero p{color:var(--muted);margin:10px 0 0;font-size:17px}
.panel{background:var(--card);border-radius:28px;padding:24px}
@media (min-width:720px){.panel{padding:32px}}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{display:inline-flex;align-items:center;border-radius:999px;padding:6px 12px;font-size:14px;font-weight:500;background:var(--chip);text-decoration:none;white-space:nowrap}
a.chip:hover{background:var(--lime);color:var(--lime-ink)}
.chip.on{background:var(--ink);color:var(--bg)}
.chip.pay{background:var(--lime);color:var(--lime-ink)}
.chip small{opacity:.6;margin-left:6px;font-weight:500}
.filters{display:grid;gap:14px;margin:0 0 20px}
.filters .label{font-size:13px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px}
.list{list-style:none;margin:0;padding:0;display:grid;gap:12px}
.card{display:flex;gap:14px;align-items:flex-start;background:var(--card);border-radius:24px;padding:18px;text-decoration:none}
.card:hover{outline:2px solid var(--green)}
.logo{flex:none;width:52px;height:52px;border-radius:16px;background:var(--chip);display:flex;align-items:center;justify-content:center;font-weight:700;overflow:hidden}
.logo img{width:100%;height:100%;object-fit:cover}
.card .t{display:block;font-weight:650;font-size:17px;line-height:1.3}
.card .m{display:block;color:var(--muted);font-size:14px;margin:3px 0 10px}
.card .body{min-width:0;flex:1}
.count{color:var(--muted);margin:0 0 12px;font-size:15px}
.pager{display:flex;justify-content:space-between;gap:12px;margin:20px 0 0}
.grid{display:grid;gap:20px;align-items:start}
@media (min-width:900px){.grid{grid-template-columns:minmax(0,1fr) 320px}.aside{position:sticky;top:84px}}
.head{display:flex;gap:16px;align-items:center;margin-bottom:18px}
.head .logo{width:64px;height:64px;border-radius:20px;font-size:22px}
.employer{font-weight:600}
.employer small{display:block;color:var(--muted);font-weight:400;font-size:14px}
.facts{display:grid;gap:12px;margin:0}
.facts div{background:var(--bg);border-radius:18px;padding:12px 16px}
.facts dt{font-size:13px;color:var(--muted)}
.facts dd{margin:2px 0 0;font-weight:600}
.desc{white-space:pre-line;overflow-wrap:anywhere;margin:14px 0 0}
.section{margin-top:28px}
.apply p{color:var(--muted);font-size:14px;margin:12px 0 0;text-align:center}
.apply .btn{width:100%;padding:15px 20px;font-size:17px}
.apply .row{display:flex;gap:8px;margin-top:10px}
.apply .row .btn{font-size:15px;padding:12px}
.apply-sm{margin-top:18px}.apply-sm .btn{width:100%;padding:14px 20px;font-size:16px}
@media (min-width:900px){.apply-sm{display:none}}
.note{background:var(--lime);color:var(--lime-ink);border-radius:20px;padding:14px 18px;margin:0 0 16px;font-weight:500}
.empty{text-align:center;padding:40px 16px}
.empty p{color:var(--muted)}
footer{margin:48px 0 0;padding:32px 0 40px;color:var(--muted);font-size:14px}
footer .links{display:flex;flex-wrap:wrap;gap:8px 18px;margin:0 0 14px}
footer a{text-decoration:none}footer a:hover{text-decoration:underline}
`;

type Layout = {
  site: string;
  title: string;
  description: string;
  /** Path on the site, e.g. `/emplois/brazzaville`. */
  path: string;
  noindex?: boolean;
  jsonLd?: unknown[];
  footerCities?: { slug: string; name: string }[];
  body: string;
};

export function layout(p: Layout): string {
  const url = `${p.site}${p.path}`;
  const image = `${p.site}/og-image.jpg`;
  const cities = (p.footerCities ?? []).slice(0, 8);
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(p.title)}</title>
<meta name="description" content="${esc(p.description)}">
<meta name="robots" content="${p.noindex ? 'noindex, follow' : 'index, follow, max-snippet:-1, max-image-preview:large'}">
<link rel="canonical" href="${esc(url)}">
<meta name="theme-color" content="#25d366">
<link rel="icon" href="/favicon.ico">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Rabotka">
<meta property="og:locale" content="fr_FR">
<meta property="og:title" content="${esc(p.title)}">
<meta property="og:description" content="${esc(p.description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<style>${STYLE}</style>
${(p.jsonLd ?? []).map((d) => `<script type="application/ld+json">${ldJson(d)}</script>`).join('\n')}
</head>
<body>
<header class="top"><div class="wrap">
<a class="brand" href="/"><img src="/rabotka-logo.png" alt="" width="34" height="34">Rabotka</a>
<nav><a class="hide-sm" href="/emplois">Offres d'emploi</a><a class="btn" href="/login">Se connecter</a></nav>
</div></header>
<main class="wrap">
${p.body}
</main>
<footer><div class="wrap">
${cities.length ? `<div class="links"><a href="/emplois">Toutes les offres</a>${cities.map((c) => `<a href="/emplois/${esc(c.slug)}">Emploi ${esc(c.name)}</a>`).join('')}</div>` : ''}
<div>Rabotka · Trouvez une mission ou un emploi, recrutez près de chez vous · <a href="/">www.rabotka.work</a></div>
</div></footer>
</body>
</html>`;
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');

function logo(o: PublicOfferRow): string {
  const e = publicEmployer(o);
  if (e.logoUrl)
    return `<span class="logo"><img src="${esc(e.logoUrl)}" alt="" loading="lazy"></span>`;
  return `<span class="logo" aria-hidden="true">${esc(e.verifiedBusiness ? initials(e.name) : '💼')}</span>`;
}

function crumbs(items: { name: string; path?: string }[]): string {
  return `<nav class="crumbs" aria-label="Fil d'Ariane">${items
    .map((i, n) =>
      i.path && n < items.length - 1
        ? `<a href="${esc(i.path)}">${esc(i.name)}</a><span aria-hidden="true">›</span>`
        : `<span>${esc(i.name)}</span>`,
    )
    .join('')}</nav>`;
}

function crumbsLd(site: string, items: { name: string; path?: string }[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((i, n) => ({
      '@type': 'ListItem',
      position: n + 1,
      name: i.name,
      ...(i.path ? { item: `${site}${i.path}` } : {}),
    })),
  };
}

function offerCard(o: PublicOfferRow): string {
  const e = publicEmployer(o);
  const city = cityOf(o);
  const pay = payLabel(o);
  return `<li><a class="card" href="${esc(offerPath(o))}">${logo(o)}<span class="body">
<span class="t">${esc(o.title)}</span>
<span class="m">${esc(e.name)} · ${esc(city ?? (o.is_remote ? 'En ligne' : '—'))} · ${esc(frDate(o.created_at))}</span>
<span class="chips"><span class="chip">${EMPLOYMENT_LABEL[o.employment_type]}</span>${pay ? `<span class="chip pay">${esc(pay)}</span>` : ''}${o.category ? `<span class="chip">${esc(o.category.name)}</span>` : ''}</span>
</span></a></li>`;
}

const listingTitle = (l: Pick<Listing, 'city' | 'trade'>) =>
  l.trade && l.city
    ? `${l.trade.name} : offres d'emploi à ${l.city.name}`
    : l.trade
      ? `${l.trade.name} : offres d'emploi`
      : l.city
        ? `Offres d'emploi à ${l.city.name}`
        : "Offres d'emploi";

export function listingPath(
  l: { city?: { slug: string } | null; trade?: { slug: string } | null },
  page = 1,
): string {
  // A trade alone has no page of its own: it is a filter on « all cities ».
  const base = l.city
    ? `/emplois/${l.city.slug}${l.trade ? `/${l.trade.slug}` : ''}`
    : '/emplois';
  const query =
    !l.city && l.trade ? `?metier=${encodeURIComponent(l.trade.slug)}` : '';
  const sep = query ? '&' : '?';
  return `${base}${query}${page > 1 ? `${sep}page=${page}` : ''}`;
}

export function listingPage(site: string, l: Listing): string {
  const title = listingTitle(l);
  const where = l.city ? ` à ${l.city.name}` : '';
  const description = l.total
    ? `${l.total} offre${l.total > 1 ? 's' : ''} d'emploi${l.trade ? ` en ${l.trade.name.toLowerCase()}` : ''}${where} sur Rabotka. Postulez gratuitement avec votre compte.`
    : `Aucune offre ouverte${where} pour le moment. Découvrez les autres offres d'emploi sur Rabotka.`;
  const items = [
    { name: "Offres d'emploi", path: '/emplois' },
    ...(l.city ? [{ name: l.city.name, path: `/emplois/${l.city.slug}` }] : []),
    ...(l.trade ? [{ name: l.trade.name }] : []),
  ];

  const cityChips = l.cities
    .slice(0, 14)
    .map((c) => {
      const on = c.slug === l.city?.slug;
      const href = listingPath({ city: on ? null : c, trade: l.trade });
      return `<a class="chip${on ? ' on' : ''}" href="${esc(href)}">${esc(c.name)}<small>${c.count}</small></a>`;
    })
    .join('');
  const tradeChips = l.trades
    .slice(0, 16)
    .map((t) => {
      const on = t.slug === l.trade?.slug;
      const href = listingPath({ city: l.city, trade: on ? null : t });
      return `<a class="chip${on ? ' on' : ''}" href="${esc(href)}">${esc(t.name)}<small>${t.count}</small></a>`;
    })
    .join('');

  const pager =
    l.pages > 1
      ? `<div class="pager">${l.page > 1 ? `<a class="btn soft" href="${esc(listingPath(l, l.page - 1))}">← Plus récentes</a>` : '<span></span>'}${l.page < l.pages ? `<a class="btn soft" href="${esc(listingPath(l, l.page + 1))}">Plus anciennes →</a>` : ''}</div>`
      : '';

  const body = `${crumbs(items)}
<section class="hero"><h1>${esc(title)}</h1><p>${
    l.city
      ? `Missions et emplois près de chez vous${where}. Postulez gratuitement avec votre compte Rabotka.`
      : 'Missions et emplois près de chez vous. Postulez gratuitement avec votre compte Rabotka.'
  }</p></section>
<div class="filters">
${cityChips ? `<div><div class="label">Villes</div><div class="chips">${cityChips}</div></div>` : ''}
${tradeChips ? `<div><div class="label">Métiers</div><div class="chips">${tradeChips}</div></div>` : ''}
</div>
${
  l.offers.length
    ? `<p class="count">${l.total} offre${l.total > 1 ? 's' : ''} ouverte${l.total > 1 ? 's' : ''}${l.pages > 1 ? ` · page ${l.page} sur ${l.pages}` : ''}</p><ul class="list">${l.offers.map(offerCard).join('')}</ul>${pager}`
    : `<div class="panel empty"><h2>Aucune offre ouverte ici pour le moment</h2><p>De nouvelles offres sont publiées chaque jour.</p><a class="btn" href="/emplois">Voir toutes les offres</a></div>`
}`;

  return layout({
    site,
    title: `${title}${l.page > 1 ? ` (page ${l.page})` : ''} | Rabotka`,
    description,
    path: listingPath(l, l.page),
    noindex: l.offers.length === 0,
    jsonLd: [crumbsLd(site, items)],
    footerCities: l.cities,
    body,
  });
}

export function offerPage(
  site: string,
  o: PublicOfferRow,
  similar: PublicOfferRow[],
  cities: { slug: string; name: string }[],
  citySlug: string | null,
): string {
  const e = publicEmployer(o);
  const city = cityOf(o);
  const pay = payLabel(o);
  const where = city ?? (o.is_remote ? 'En ligne' : null);
  const path = offerPath(o);
  const applyUrl = `/offres/${o.id}`;
  const description = maskContacts(o.description).trim();
  const items = [
    { name: "Offres d'emploi", path: '/emplois' },
    ...(city && citySlug ? [{ name: city, path: `/emplois/${citySlug}` }] : []),
    ...(o.category && citySlug
      ? [
          {
            name: o.category.name,
            path: `/emplois/${citySlug}/${o.category.slug}`,
          },
        ]
      : []),
    { name: o.title },
  ];
  const share = encodeURIComponent(
    `${o.title}${where ? ` – ${where}` : ''}\n${site}${path}`,
  );

  const facts = [
    ['Rémunération', pay ?? 'À discuter'],
    ['Lieu', where ?? '—'],
    ['Type', EMPLOYMENT_LABEL[o.employment_type]],
    ...(o.category ? [['Métier', o.category.name]] : []),
    ...(o.quantity > 1 ? [['Postes', `${o.quantity} personnes`]] : []),
    ...(o.scheduled_at
      ? [['Candidatures jusqu’au', frDate(o.scheduled_at)]]
      : []),
    ['Publiée le', frDate(o.created_at)],
  ]
    .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`)
    .join('');

  const body = `${crumbs(items)}
<div class="grid">
<article class="panel">
<div class="head">${logo(o)}<div class="employer">${esc(e.name)}<small>${e.verifiedBusiness ? 'Entreprise vérifiée par Rabotka' : 'Offre publiée sur Rabotka'}</small></div></div>
<h1>${esc(o.title)}</h1>
<div class="chips" style="margin-top:14px">${pay ? `<span class="chip pay">${esc(pay)}</span>` : ''}<span class="chip">${EMPLOYMENT_LABEL[o.employment_type]}</span>${where ? `<span class="chip">${esc(where)}</span>` : ''}</div>
<div class="apply-sm"><a class="btn green" href="${esc(applyUrl)}" rel="nofollow">Postuler sur Rabotka</a></div>
<div class="section"><h2>Description</h2><p class="desc">${esc(description)}</p></div>
</article>
<aside class="aside">
<div class="panel apply">
<dl class="facts">${facts}</dl>
<div style="margin-top:18px"><a class="btn green" href="${esc(applyUrl)}" rel="nofollow">Postuler sur Rabotka</a></div>
<p>Gratuit. Connectez-vous ou créez votre compte en une minute.</p>
<div class="row"><a class="btn soft" style="flex:1" href="https://wa.me/?text=${share}" target="_blank" rel="noopener nofollow">Partager sur WhatsApp</a></div>
</div>
</aside>
</div>
${
  similar.length
    ? `<section class="section"><h2 style="margin-bottom:14px">Offres similaires</h2><ul class="list">${similar.map(offerCard).join('')}</ul></section>`
    : ''
}`;

  const summary = [pay, EMPLOYMENT_LABEL[o.employment_type], where]
    .filter(Boolean)
    .join(' · ');
  return layout({
    site,
    title: `${o.title}${where ? ` – ${where}` : ''} | Offre d'emploi Rabotka`,
    description: `${summary}. ${excerpt(description, 150)}`,
    path,
    jsonLd: [jobPostingLd(o, site), crumbsLd(site, items)],
    footerCities: cities,
    body,
  });
}

/** An offer that has closed: say so, and point to the ones still open. */
export function gonePage(
  site: string,
  o: PublicOfferRow,
  similar: PublicOfferRow[],
  cities: { slug: string; name: string }[],
): string {
  const body = `<section class="hero" style="padding-top:28px">
<p class="note">Cette offre n'accepte plus de candidatures.</p>
<h1>${esc(o.title)}</h1>
<p>Elle a été pourvue ou a expiré. D'autres offres vous attendent.</p>
<p style="margin-top:18px"><a class="btn" href="/emplois">Voir les offres ouvertes</a></p>
</section>
${similar.length ? `<section class="section"><h2 style="margin-bottom:14px">Offres similaires</h2><ul class="list">${similar.map(offerCard).join('')}</ul></section>` : ''}`;
  return layout({
    site,
    title: `Offre expirée : ${o.title} | Rabotka`,
    description:
      "Cette offre n'accepte plus de candidatures. Découvrez les offres d'emploi ouvertes sur Rabotka.",
    path: offerPath(o),
    noindex: true,
    footerCities: cities,
    body,
  });
}

export function notFoundPage(site: string, path: string): string {
  return layout({
    site,
    title: 'Page introuvable | Rabotka',
    description:
      "Cette page n'existe pas ou plus. Découvrez les offres d'emploi ouvertes sur Rabotka.",
    path,
    noindex: true,
    body: `<div class="panel empty" style="margin-top:28px"><h1>Page introuvable</h1><p>Cette page n'existe pas ou plus.</p><a class="btn" href="/emplois">Voir les offres d'emploi</a></div>`,
  });
}

export function sitemapXml(
  site: string,
  entries: { path: string; lastmod: Date }[],
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries
  .map(
    (e) =>
      `<url><loc>${esc(`${site}${e.path}`)}</loc><lastmod>${e.lastmod.toISOString()}</lastmod></url>`,
  )
  .join('\n')}
</urlset>`;
}
