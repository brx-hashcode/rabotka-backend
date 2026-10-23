import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { ALLOWED_IMAGE_MIME_TYPES } from '../../common/constants/image-upload';
import { sniffFileType } from '../../common/utils/file-signature.util';
import { ProfileAuthGuard } from '../auth/guards/profile-auth.guard';
import { BusinessProfileGuard } from '../auth/guards/business-profile.guard';
import type { ProfileAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { ProfileService } from '../profile/profile.service';
import { sendPrivateFile } from '../profile/send-private-file';
import { UpdateBusinessDto } from './dto/update-business.dto';
import { UploadBusinessDocumentDto } from './dto/upload-business-document.dto';

/**
 * The business dashboard's own routes. Guarded at class level, so no route
 * can be added here without them: a signed-in profile, and a business one.
 */
@ApiTags('Business')
@ApiBearerAuth()
@Controller('business')
@UseGuards(ProfileAuthGuard, BusinessProfileGuard)
export class BusinessController {
  constructor(private readonly profileService: ProfileService) {}

  @Get('me')
  @ApiOperation({
    summary: 'The signed-in business: its organisation, papers and review',
  })
  @ApiResponse({ status: 403, description: 'Not a business account' })
  getMe(@Req() req: ProfileAuthenticatedRequest) {
    return this.profileService.getBusinessForAdmin(req.user.profileId);
  }

  @Patch('me')
  @ApiOperation({
    summary: 'Edit the organisation',
    description:
      'Changing name, type, legal form, RCCM, NIU or SCIEN sends a decided business back to review; contact details do not.',
  })
  async updateMe(
    @Req() req: ProfileAuthenticatedRequest,
    @Body() dto: UpdateBusinessDto,
  ) {
    return this.profileService.updateBusiness(req.user.profileId, dto, 'owner');
  }

  @Post('me/documents')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 10 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        const allowed: string[] = [
          ...ALLOWED_IMAGE_MIME_TYPES,
          'application/pdf',
        ];
        cb(null, allowed.includes(file.mimetype));
      },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'documentType'],
      properties: {
        file: { type: 'string', format: 'binary' },
        documentType: { type: 'string' },
        replacesId: { type: 'string', format: 'uuid' },
      },
    },
  })
  @ApiOperation({
    summary: 'Send a paper: a new one, or the replacement of a refused one',
    description:
      'The replaced version is kept as history. A refused business goes back to review.',
  })
  async uploadDocument(
    @Req() req: ProfileAuthenticatedRequest,
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadBusinessDocumentDto,
  ) {
    if (!file) {
      throw new BadRequestException(
        'Envoyez une photo (JPG, PNG, WEBP) ou un PDF de 10 Mo au plus.',
      );
    }
    // The declared type is a header anyone can set: the bytes must agree.
    if (sniffFileType(file.buffer) !== file.mimetype) {
      throw new BadRequestException(
        'Fichier non reconnu : envoyez une photo (JPG, PNG, WEBP) ou un PDF.',
      );
    }
    return this.profileService.uploadBusinessDocument(
      req.user.profileId,
      file,
      dto.documentType,
      dto.replacesId,
    );
  }

  @Get('me/documents/:documentId/raw')
  @ApiOperation({ summary: 'One of its own papers, any version' })
  async streamDocument(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Res() res: Response,
  ): Promise<void> {
    sendPrivateFile(
      res,
      await this.profileService.streamBusinessDocument(
        req.user.profileId,
        documentId,
      ),
    );
  }
}
