import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiCookieAuth,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ProfileAuthGuard } from '../auth/guards/profile-auth.guard';
import { UnblockedProfileGuard } from '../auth/guards/unblocked-profile.guard';
import type { ProfileAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { PortfolioService } from './portfolio.service';
import { CreatePortfolioItemDto } from './dto/create-portfolio-item.dto';
import { UpdatePortfolioItemDto } from './dto/update-portfolio-item.dto';
import { isAllowedImageMimeType } from '../../common/constants/image-upload';

const IMAGE_UPLOAD_OPTIONS = {
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB per image
  // Silent reject kept on purpose — see the note in `profile.controller.ts`.
  fileFilter: (
    _req: unknown,
    file: Express.Multer.File,
    cb: (error: Error | null, acceptFile: boolean) => void,
  ) => {
    cb(null, isAllowedImageMimeType(file.mimetype));
  },
};

@ApiTags('Portfolio')
@Controller('profile/portfolio')
@UseGuards(ProfileAuthGuard)
export class PortfolioController {
  constructor(private readonly portfolioService: PortfolioService) {}

  @Post()
  @UseGuards(UnblockedProfileGuard)
  @UseInterceptors(FilesInterceptor('images', 10, IMAGE_UPLOAD_OPTIONS))
  @ApiBearerAuth()
  @ApiCookieAuth()
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Create a portfolio item with one or more images' })
  create(
    @Req() req: ProfileAuthenticatedRequest,
    @Body() dto: CreatePortfolioItemDto,
    @UploadedFiles() images: Express.Multer.File[],
  ) {
    return this.portfolioService.createItem(req.user.profileId, dto, images);
  }

  @Get()
  @ApiBearerAuth()
  @ApiCookieAuth()
  @ApiOperation({ summary: "List the authenticated worker's portfolio items" })
  list(@Req() req: ProfileAuthenticatedRequest) {
    return this.portfolioService.listOwn(req.user.profileId);
  }

  @Patch(':id')
  @UseGuards(UnblockedProfileGuard)
  @ApiBearerAuth()
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Update a portfolio item (title / description)' })
  update(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePortfolioItemDto,
  ) {
    return this.portfolioService.updateItem(req.user.profileId, id, dto);
  }

  @Delete(':id')
  @UseGuards(UnblockedProfileGuard)
  @ApiBearerAuth()
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Delete a portfolio item and its images' })
  async remove(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.portfolioService.deleteItem(req.user.profileId, id);
    return { success: true };
  }

  @Post(':id/images')
  @UseGuards(UnblockedProfileGuard)
  @UseInterceptors(FilesInterceptor('images', 10, IMAGE_UPLOAD_OPTIONS))
  @ApiBearerAuth()
  @ApiCookieAuth()
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Add images to an existing portfolio item' })
  addImages(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFiles() images: Express.Multer.File[],
  ) {
    return this.portfolioService.addImages(req.user.profileId, id, images);
  }

  @Delete(':id/images/:imageId')
  @UseGuards(UnblockedProfileGuard)
  @ApiBearerAuth()
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Remove a single image from a portfolio item' })
  async removeImage(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('imageId', ParseUUIDPipe) imageId: string,
  ) {
    await this.portfolioService.removeImage(req.user.profileId, id, imageId);
    return { success: true };
  }
}
