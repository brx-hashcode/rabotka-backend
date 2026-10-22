import {
  ForbiddenException,
  Global,
  Injectable,
  Module,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SystemConfigService } from '../system-config/system-config.service';
import { fetchWithTimeout } from '../../common/utils/fetch-with-timeout.util';
import { isProxyHostAllowed, storageProxyHosts } from './proxy-hosts';

const STORAGE_DRIVERS = ['CLOUDFLARE', 'S3', 'CLOUDINARY', 'VERCEL_BLOB'];
const LOOPBACK_HOST_RE = /^(localhost|127\.|0\.0\.0\.0$|\[?::1\]?$)/i;

/**
 * The only way the server fetches a file by a url somebody stored: a
 * document's file_url, an advertisement's image.
 *
 * Pentest A2-F07 (#863): documents were fetched from any http(s) url,
 * redirects followed, and the active policy's body served back anonymously —
 * a MANAGER could point it at an internal address and read the answer. The
 * rule is now `GET /file/proxy`'s: our own storage hosts only (proxy-hosts.ts),
 * https in production, no userinfo, no loopback in production, and no
 * redirects. Checked when a url is stored AND again on every fetch, since
 * rows stored before this may hold anything.
 */
@Injectable()
export class StorageFetchService {
  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly systemConfig?: SystemConfigService,
  ) {}

  /** Throws ForbiddenException unless `url` is one of our storage urls. */
  async assertAllowed(url: string): Promise<URL> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ForbiddenException('URL not allowed');
    }
    const isProduction = this.config.get<string>('NODE_ENV') === 'production';
    const schemeOk =
      parsed.protocol === 'https:' ||
      (parsed.protocol === 'http:' && !isProduction);
    if (
      !schemeOk ||
      parsed.username ||
      parsed.password ||
      (isProduction && LOOPBACK_HOST_RE.test(parsed.hostname)) ||
      !isProxyHostAllowed(parsed.hostname, await this.hosts())
    ) {
      throw new ForbiddenException('URL not allowed');
    }
    return parsed;
  }

  /** Checked, then fetched with redirects refused. */
  async fetch(url: string, timeoutMs = 15_000): Promise<Response> {
    const parsed = await this.assertAllowed(url);
    return fetchWithTimeout(
      parsed.toString(),
      { redirect: 'error' },
      timeoutMs,
    );
  }

  /** SystemConfig first, env second — as every storage setting resolves. */
  private async hosts(): Promise<string[]> {
    const overrides: Record<string, string> = {};
    await Promise.all(
      STORAGE_DRIVERS.map(async (driver) => {
        const values = await this.systemConfig
          ?.getStorageEnvOverrides(driver)
          .catch(() => undefined);
        Object.assign(overrides, values ?? {});
      }),
    );
    return storageProxyHosts(
      (key) => (overrides[key] || this.config.get<string>(key) || '').trim(),
      this.config.get<string>('PROXY_ALLOWED_HOSTS') ?? '',
    );
  }
}

/** Global so any module that fetches a stored url gets the same rule. */
@Global()
@Module({
  providers: [StorageFetchService],
  exports: [StorageFetchService],
})
export class StorageFetchModule {}
