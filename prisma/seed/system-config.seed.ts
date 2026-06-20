import type { PrismaClient } from '@prisma/client';
import { DEFAULT_SYSTEM_CONFIGS } from '../../src/modules/system-config/system-config.constants';

export async function seedSystemConfig(prisma: PrismaClient): Promise<void> {
  const existing = await prisma.systemConfig.findMany({ select: { key: true } });
  const existingKeys = new Set(existing.map((r) => r.key));

  const toInsert = DEFAULT_SYSTEM_CONFIGS.filter((cfg) => !existingKeys.has(cfg.key));

  if (toInsert.length === 0) {
    console.log('[SystemConfig seed] Skipped (all keys already present).');
    return;
  }

  await prisma.systemConfig.createMany({
    data: toInsert.map((cfg) => ({
      key: cfg.key,
      value: cfg.value,
      category: cfg.category,
      label: cfg.label,
      is_secret: cfg.isSecret,
    })),
  });

  console.log(`[SystemConfig seed] Inserted ${toInsert.length} new config keys.`);
}
