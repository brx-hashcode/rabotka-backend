import {
  Controller,
  Post,
  Get,
  UseInterceptors,
  UploadedFiles,
  BadRequestException,
  ForbiddenException,
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
import { ConfigService } from '@nestjs/config';
import { StorageService } from '../../common/services/storage/storage.service';
import { fetchWithTimeout } from '../../common/utils/fetch-with-timeout.util';
import { JwtAuthGuard } from '../auth/guards';

const PRIVATE_IP_RE =
  /^(localhost$|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/;

@ApiTags('File')
@Controller('file')
export class FileController {
  constructor(
    private readonly storageService: StorageService,
    private readonly configService: ConfigService,
  ) {}

  @Get('proxy')
  @UseGuards(JwtAuthGuard)
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

    if (PRIVATE_IP_RE.test(parsed.hostname)) {
      throw new ForbiddenException('URL not allowed');
    }

    const allowedHosts = (
      this.configService.get<string>('PROXY_ALLOWED_HOSTS') ?? ''
    )
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);

    if (
      allowedHosts.length > 0 &&
      !allowedHosts.some(
        (h) => parsed.hostname === h || parsed.hostname.endsWith(`.${h}`),
      )
    ) {
      throw new ForbiddenException('URL not allowed');
    }

    const upstream = await fetchWithTimeout(decoded, {}, 15_000);
    if (!upstream.ok) {
      return res
        .status(upstream.status)
        .json({ message: 'Failed to fetch file' });
    }

    const contentType =
      upstream.headers.get('content-type') ?? 'application/octet-stream';
    const contentLength = upstream.headers.get('content-length');

    const filename = decoded.split('/').pop()?.split('?')[0] ?? 'download';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    if (contentLength) res.setHeader('Content-Length', contentLength);

    const buffer = await upstream.arrayBuffer();
    return res.send(Buffer.from(buffer));
  }

  @Post('upload')
  @UseGuards(JwtAuthGuard)
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

    const resolveAccess = (mimetype: string): 'public' | 'private' => {
      if (accessOverride === 'public') return 'public';
      if (accessOverride === 'private') return 'private';
      return mimetype.startsWith('image/') ? 'public' : 'private';
    };

    if (isMulti) {
      const uploadResults = await Promise.all(
        files.map(async (file) => {
          if (!file.buffer || !file.originalname) {
            throw new BadRequestException(
              'Le buffer ou le nom du fichier est manquant',
            );
          }

          const fileBuffer: Buffer = Buffer.isBuffer(file.buffer)
            ? file.buffer
            : Buffer.from(file.buffer);
          const ext = String(file.originalname).split('.').pop()?.replace(/[^a-zA-Z0-9]/g, '') ?? 'bin';
          const fileName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;

          const uploadResult = await this.storageService.upload(
            fileBuffer,
            fileName,
            {
              mimeType: file.mimetype,
              folder: 'files',
              access: resolveAccess(file.mimetype),
            },
          );

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

    const file = files[0];
    if (!file.buffer || !file.originalname) {
      throw new BadRequestException(
        'Le buffer ou le nom du fichier est manquant',
      );
    }

    const fileBuffer: Buffer = Buffer.isBuffer(file.buffer)
      ? file.buffer
      : Buffer.from(file.buffer);
    const ext = String(file.originalname).split('.').pop()?.replace(/[^a-zA-Z0-9]/g, '') ?? 'bin';
    const fileName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;

    const uploadResult = await this.storageService.upload(
      fileBuffer,
      fileName,
      {
        mimeType: file.mimetype,
        folder: 'files',
        access: resolveAccess(file.mimetype),
      },
    );

    return {
      file_url: uploadResult.url,
    };
  }
}
