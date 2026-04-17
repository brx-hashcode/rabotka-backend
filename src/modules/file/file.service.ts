import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { StorageService } from '../../common/services/storage/storage.service';
import { ImageWatermarkService } from '../../common/services/image-watermark/image-watermark.service';
import { UploadOptions } from '../../common/services/storage/types/storage.types';

@Injectable()
export class FileService {
  private readonly logger = new Logger(FileService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
    private readonly imageWatermarkService: ImageWatermarkService,
  ) {}

  /**
   * Uploads a file to storage without creating a database record.
   * Use this when you need to create the File record inside a transaction.
   */
  async uploadToStorage(
    file: Express.Multer.File,
    options?: {
      folder?: string;
      access?: 'public' | 'private';
    },
  ) {
    if (!file.buffer || !file.originalname) {
      throw new Error('Le buffer ou le nom du fichier est manquant');
    }

    const uploadOptions: UploadOptions = {
      mimeType: file.mimetype,
      folder: options?.folder,
      access: options?.access,
    };

    const fileBuffer: Buffer = Buffer.isBuffer(file.buffer)
      ? file.buffer
      : Buffer.from(file.buffer);
    const fileName: string = String(file.originalname);

    let bufferToUpload = fileBuffer;
    if (file.mimetype.startsWith('image/')) {
      bufferToUpload = await this.imageWatermarkService.addWatermark(
        fileBuffer,
        file.mimetype,
      );
    }

    const uploadResult = await this.storageService.upload(
      bufferToUpload,
      fileName,
      uploadOptions,
    );

    return {
      ...uploadResult,
      originalFilename: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
    };
  }

  async uploadFile(
    file: Express.Multer.File,
    options?: {
      profileId?: string;
      uploadedById?: string;
      folder?: string;
    },
  ) {
    try {
      const uploadResult = await this.uploadToStorage(file, {
        folder: options?.folder,
      });

      const fileRecord = await this.prisma.file.create({
        data: {
          filename: uploadResult.key,
          original_filename: uploadResult.originalFilename,
          mime_type: uploadResult.mimeType,
          size: uploadResult.size,
          storage_provider: uploadResult.provider,
          storage_key: uploadResult.key,
          bucket: uploadResult.bucket,
          profile_id: options?.profileId,
          uploaded_by_id: options?.uploadedById,
        },
      });

      this.logger.log(`File uploaded and saved to database: ${fileRecord.id}`);

      return {
        ...fileRecord,
        url: uploadResult.url,
      };
    } catch (error: any) {
      this.logger.error(`Failed to upload file: ${error.message}`, error.stack);
      throw error;
    }
  }

  async getFile(id: string) {
    const file = await this.prisma.file.findUnique({
      where: { id },
    });

    if (!file) {
      throw new NotFoundException(`File with ID ${id} not found`);
    }

    const url = await this.storageService.getUrl(file.storage_key);

    return {
      ...file,
      url,
    };
  }

  async deleteFile(id: string) {
    const file = await this.prisma.file.findUnique({
      where: { id },
    });

    if (!file) {
      throw new NotFoundException(`File with ID ${id} not found`);
    }

    try {
      await this.storageService.delete(file.storage_key);
      await this.prisma.file.delete({
        where: { id },
      });

      this.logger.log(`File deleted: ${id}`);
    } catch (error: any) {
      this.logger.error(`Failed to delete file: ${error.message}`, error.stack);
      throw error;
    }
  }

  async getFilesByProfile(profileId: string) {
    const files = await this.prisma.file.findMany({
      where: { profile_id: profileId },
      orderBy: { created_at: 'desc' },
    });

    const filesWithUrls = await Promise.all(
      files.map(async (file) => {
        const url = await this.storageService.getUrl(file.storage_key);
        return {
          ...file,
          url,
        };
      }),
    );

    return filesWithUrls;
  }
}
