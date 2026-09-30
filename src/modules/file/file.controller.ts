import {
  Controller,
  Post,
  Get,
  UseInterceptors,
  UploadedFiles,
  BadRequestException,
  ForbiddenException,
  Optional,
  UseGuards,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { FilesInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiConsumes,
  ApiBody,
  ApiResponse,
  ApiQuery,
} from '@nestjs/swagger';
import { randomBytes } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { StorageService } from '../../common/services/storage/storage.service';
import { fetchWithTimeout } from '../../common/utils/fetch-with-timeout.util';
import { AdminAuthGuard } from '../auth/guards';
import { SystemConfigService } from '../system-config/system-config.service';
import { isProxyHostAllowed, storageProxyHosts } from './proxy-hosts';
import { ACCEPTED_UPLOAD_EXTENSIONS, resolveUploadType } from './upload-types';

/** The drivers whose settings can name a host a stored file lives on. */
const STORAGE_DRIVERS = ['CLOUDFLARE', 'S3', 'CLOUDINARY', 'VERCEL_BLOB'];

/**
 * Largest body the proxy will relay. It buffers the whole response, so without
 * a ceiling one request for a large object is a memory spike in the API
 * process. Platform documents and KYC scans are a few megabytes.
 */
const PROXY_MAX_BYTES = 30 * 1024 * 1024;

const LOOPBACK_HOST_RE = /^(localhost|127\.|0\.0\.0\.0$|\[?::1\]?$)/i;

/**
 * Both routes are for the admin, and only the admin calls them: the documents
 * screens, the advertisement and partner-app forms, and the KYC viewer.
 *
 * They were behind `JwtAuthGuard`, which accepts ANY valid token — every
 * signed-in profile could make the server fetch a url of their choosing, and
 * upload a file of any type into the public bucket.
 *
 * `AdminAuthGuard` alone, without `RolesGuard`: every admin role uses these,
 * the lateral ones included (SUPPORT opens KYC documents), and `RolesGuard`
 * admits a lateral role only to controller paths in its area map.
 */
@ApiTags('File')
@Controller('file')
export class FileController {
  constructor(
    private readonly storageService: StorageService,
    private readonly configService: ConfigService,
    @Optional() private readonly systemConfig?: SystemConfigService,
  ) {}

  @Get('proxy')
  @UseGuards(AdminAuthGuard)
  async proxyFile(@Query('url') fileUrl: string, @Res() res: Response) {
    if (!fileUrl) {
      return res.status(400).json({ message: 'url query param is required' });
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(fileUrl);
    } catch {
      return res.status(400).json({ message: 'Invalid url' });
    }

    if (decoded.startsWith('blob:')) {
      return res.status(400).json({
        message:
          'Blob URLs cannot be proxied. The file was not properly uploaded to storage.',
      });
    }

    let parsed: URL;
    try {
      parsed = new URL(decoded);
    } catch {
      return res.status(400).json({ message: 'Invalid url' });
    }

    // Only our own storage, and only over TLS in production. See proxy-hosts.ts
    // for why this is an allow-list of hosts and not a block-list of addresses.
    const isProduction =
      this.configService.get<string>('NODE_ENV') === 'production';
    const schemeOk =
      parsed.protocol === 'https:' ||
      (parsed.protocol === 'http:' && !isProduction);
    if (
      !schemeOk ||
      parsed.username ||
      parsed.password ||
      // A local storage endpoint is a development setting. If one is ever left
      // in a production environment, it must not make the API's own loopback
      // reachable through here.
      (isProduction && LOOPBACK_HOST_RE.test(parsed.hostname)) ||
      !isProxyHostAllowed(parsed.hostname, await this.proxyHosts())
    ) {
      throw new ForbiddenException('URL not allowed');
    }

    // `redirect: 'error'`: the host was checked, and a redirect is the storage
    // host choosing a different one for us.
    const upstream = await fetchWithTimeout(
      parsed.toString(),
      { redirect: 'error' },
      15_000,
    ).catch(() => null);
    if (!upstream) {
      return res.status(502).json({ message: 'Failed to fetch file' });
    }
    if (!upstream.ok) {
      return res
        .status(upstream.status)
        .json({ message: 'Failed to fetch file' });
    }

    const declaredLength = Number(upstream.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > PROXY_MAX_BYTES) {
      return res.status(413).json({ message: 'File too large to proxy' });
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    if (buffer.length > PROXY_MAX_BYTES) {
      return res.status(413).json({ message: 'File too large to proxy' });
    }

    const contentType =
      upstream.headers.get('content-type') ?? 'application/octet-stream';

    res.setHeader('Content-Type', contentType);
    // Relayed bytes are never to be sniffed into something else, and always a
    // download: this response is served from the API's own origin.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeFilename(parsed.pathname)}"`,
    );
    res.setHeader('Content-Length', String(buffer.length));
    return res.send(buffer);
  }

  /**
   * SystemConfig first, env second — the order every storage setting resolves
   * in. Production keeps the real values in SystemConfig and only placeholders
   * in env, so reading env alone would allow the wrong hosts there.
   */
  private async proxyHosts(): Promise<string[]> {
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
      (key) =>
        (overrides[key] || this.configService.get<string>(key) || '').trim(),
      this.configService.get<string>('PROXY_ALLOWED_HOSTS') ?? '',
    );
  }

  @Post('upload')
  @UseGuards(AdminAuthGuard)
  @UseInterceptors(
    FilesInterceptor('files', 10, { limits: { fileSize: 10 * 1024 * 1024 } }),
  )
  @ApiOperation({ summary: 'Upload file(s)' })
  @ApiConsumes('multipart/form-data')
  @ApiQuery({
    name: 'is_multipl',
    required: false,
    type: Boolean,
    description: 'Set to true to upload multiple files',
  })
  @ApiQuery({
    name: 'access',
    required: false,
    enum: ['public', 'private'],
    description:
      'Override storage access level (default: public for images, private for others)',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: {
            type: 'string',
            format: 'binary',
          },
          description: 'File(s) to upload',
        },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'File(s) uploaded successfully' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  async uploadFile(
    @UploadedFiles() files: Express.Multer.File[],
    @Query('is_multipl') isMultiple?: string,
    @Query('access') accessOverride?: string,
  ) {
    if (!files || files.length === 0) {
      throw new BadRequestException('Aucun fichier fourni');
    }

    const isMulti = isMultiple === 'true';

    if (!isMulti && files.length > 1) {
      throw new BadRequestException(
        'Multiple files provided but is_multipl is not set to true',
      );
    }

    const store = async (file: Express.Multer.File) => {
      if (!file.buffer || !file.originalname) {
        throw new BadRequestException(
          'Le buffer ou le nom du fichier est manquant',
        );
      }

      const type = resolveUploadType(file.originalname, file.mimetype);
      if (!type) {
        throw new BadRequestException(
          `Type de fichier non accepté. Formats acceptés : ${ACCEPTED_UPLOAD_EXTENSIONS.join(', ')}`,
        );
      }

      const access: 'public' | 'private' =
        accessOverride === 'public' || accessOverride === 'private'
          ? accessOverride
          : type.isImage
            ? 'public'
            : 'private';

      const fileBuffer: Buffer = Buffer.isBuffer(file.buffer)
        ? file.buffer
        : Buffer.from(file.buffer);
      // Random from the CSPRNG: a public object's name is its only secret.
      const fileName = `${Date.now()}_${randomBytes(8).toString('hex')}.${type.extension}`;

      return this.storageService.upload(fileBuffer, fileName, {
        mimeType: type.contentType,
        folder: 'files',
        access,
      });
    };

    if (isMulti) {
      // Validated before anything is stored, so one bad file in a batch does
      // not leave the others uploaded and orphaned.
      for (const file of files) {
        if (
          file.originalname &&
          !resolveUploadType(file.originalname, file.mimetype)
        ) {
          throw new BadRequestException(
            `Type de fichier non accepté. Formats acceptés : ${ACCEPTED_UPLOAD_EXTENSIONS.join(', ')}`,
          );
        }
      }

      const uploadResults = await Promise.all(
        files.map(async (file) => {
          const uploadResult = await store(file);
          return {
            file_url: uploadResult.url,
            filename: file.originalname,
          };
        }),
      );

      return {
        files: uploadResults,
      };
    }

    const uploadResult = await store(files[0]);

    return {
      file_url: uploadResult.url,
    };
  }
}

/**
 * A filename safe to put inside a quoted `Content-Disposition` value: the last
 * path segment, reduced to characters that cannot close the quote or start a
 * new header.
 */
function safeFilename(pathname: string): string {
  const last = pathname.split('/').pop() ?? '';
  let name = last;
  try {
    name = decodeURIComponent(last);
  } catch {
    // Keep the raw segment.
  }
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return cleaned || 'download';
}
