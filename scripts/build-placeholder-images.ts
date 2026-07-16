/**
 * Generate the two WhatsApp carousel placeholder images (job + profile) and
 * write them to assets/whatsapp/. They reproduce the admin's WhatsApp doodle
 * background (#e5ddd5, from chat-doodle-bg.tsx) with a single centered icon
 * (briefcase for jobs, person for profiles).
 *
 * After generating, upload the two PNGs to R2 (public) at the exact keys the
 * carousel templates expect, under CLOUDFLARE_PUBLIC_BASE_URL:
 *   whatsapp/job-placeholder.png
 *   whatsapp/profile-placeholder.png
 * (see JOB_PLACEHOLDER_KEY / PROFILE_PLACEHOLDER_KEY in whatsapp-carousel.ts).
 *
 * Usage: pnpm wa:build-placeholders   (tsx scripts/build-placeholder-images.ts)
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const SIZE = 800;
const BG = '#e5ddd5';
const STROKE = '#111b21';

// Doodle group copied from
// rabotka-admin/src/pages/profile-detail/components/chat-doodle-bg.tsx.
const DOODLE = `
  <g fill="none" stroke="${STROKE}" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" opacity="0.07">
    <rect x="20" y="15" width="16" height="26" rx="3" />
    <path d="M70 20h30a4 4 0 0 1 4 4v14a4 4 0 0 1-4 4H80l-6 6v-6h-4a4 4 0 0 1-4-4V24a4 4 0 0 1 4-4z" />
    <circle cx="155" cy="30" r="14" /><polyline points="155,20 155,30 163,34" />
    <rect x="210" y="22" width="28" height="20" rx="3" /><circle cx="224" cy="32" r="6" />
    <path d="M28 80l18 16 18-16" /><circle cx="85" cy="95" r="5" />
    <polygon points="150,68 154,80 167,80 157,88 160,100 150,92 140,100 143,88 133,80 146,80" />
    <rect x="205" y="72" width="28" height="20" rx="2" /><polyline points="205,72 219,86 233,72" />
    <circle cx="30" cy="160" r="14" /><circle cx="90" cy="160" r="14" />
    <rect x="210" y="155" width="16" height="14" rx="2" /><path d="M213 155v-5a5 5 0 0 1 10 0v5" />
    <rect x="75" y="220" width="28" height="22" rx="2" /><path d="M150 222l20-4-8 12z" />
    <rect x="260" y="15" width="20" height="26" rx="2" /><circle cx="270" cy="82" r="3" />
    <rect x="250" y="150" width="22" height="16" rx="2" />
    <line x1="255" y1="240" x2="275" y2="220" />
  </g>`;

// Centered icon badge: white circle + a WhatsApp-green icon.
const GREEN = '#128C7E';
const briefcase = `
  <rect x="-70" y="-40" width="140" height="100" rx="14" fill="none" stroke="${GREEN}" stroke-width="10"/>
  <path d="M-30 -40 v-16 a10 10 0 0 1 10 -10 h40 a10 10 0 0 1 10 10 v16" fill="none" stroke="${GREEN}" stroke-width="10"/>
  <line x1="-70" y1="8" x2="70" y2="8" stroke="${GREEN}" stroke-width="10"/>`;
const person = `
  <circle cx="0" cy="-28" r="34" fill="none" stroke="${GREEN}" stroke-width="10"/>
  <path d="M-56 66 a56 56 0 0 1 112 0" fill="none" stroke="${GREEN}" stroke-width="10"/>`;

function svg(icon: string): Buffer {
  const c = SIZE / 2;
  return Buffer.from(`
<svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <pattern id="d" x="0" y="0" width="300" height="300" patternUnits="userSpaceOnUse">${DOODLE}</pattern>
  </defs>
  <rect width="${SIZE}" height="${SIZE}" fill="${BG}"/>
  <rect width="${SIZE}" height="${SIZE}" fill="url(#d)"/>
  <circle cx="${c}" cy="${c}" r="150" fill="#ffffff" opacity="0.92"/>
  <g transform="translate(${c}, ${c})">${icon}</g>
</svg>`);
}

async function main(): Promise<void> {
  const outDir = join(process.cwd(), 'assets', 'whatsapp');
  mkdirSync(outDir, { recursive: true });

  const targets: Array<[string, string]> = [
    ['job-placeholder.png', briefcase],
    ['profile-placeholder.png', person],
  ];

  for (const [name, icon] of targets) {
    const out = join(outDir, name);
    await sharp(svg(icon)).png().toFile(out);
    console.log(`✔  ${out}`);
  }

  console.log(
    '\nNext: upload both PNGs to R2 (public) at these exact keys:\n' +
      '  whatsapp/job-placeholder.png\n' +
      '  whatsapp/profile-placeholder.png\n' +
      'They must resolve under CLOUDFLARE_PUBLIC_BASE_URL (approval fetches them).',
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
