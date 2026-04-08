import {
  Controller,
  Post,
  Get,
  UseInterceptors,
  UploadedFiles,
  BadRequestException,
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
import { StorageService } from '../../common/services/storage/storage.service';

@ApiTags('File')
@Controller('file')
export class FileController {
  constructor(private readonly storageService: StorageService) {}

  @Get('proxy')
  async proxyFile(
    @Query('url') fileUrl: string,
    @Res() res: Response,
  ) {
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
      return res.status(400).json({ message: 'Blob URLs cannot be proxied. The file was not properly uploaded to storage.' });
    }

    const upstream = await fetch(decoded);
    if (!upstream.ok) {
      return res.status(upstream.status).json({ message: 'Failed to fetch file' });
    }

    const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream';
    const contentLength = upstream.headers.get('content-length');

    res.setHeader('Content-Type', contentType);
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    const buffer = await upstream.arrayBuffer();
    return res.send(Buffer.from(buffer));
  }

  @Post('upload')
  @UseInterceptors(FilesInterceptor('files', 10))
  @ApiOperation({ summary: 'Upload file(s)' })
  @ApiConsumes('multipart/form-data')
  @ApiQuery({
    name: 'is_multipl',
    required: false,
    type: Boolean,
    description: 'Set to true to upload multiple files',
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
          const fileName: string = String(file.originalname);

          const uploadResult = await this.storageService.upload(
            fileBuffer,
            fileName,
            {
              mimeType: file.mimetype,
              folder: 'files',
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
      throw new BadRequestException('Le buffer ou le nom du fichier est manquant');
    }

    const fileBuffer: Buffer = Buffer.isBuffer(file.buffer)
      ? file.buffer
      : Buffer.from(file.buffer);
    const fileName: string = String(file.originalname);

    const uploadResult = await this.storageService.upload(
      fileBuffer,
      fileName,
      {
        mimeType: file.mimetype,
        folder: 'files',
      },
    );

    return {
      file_url: uploadResult.url,
    };
  }
}
