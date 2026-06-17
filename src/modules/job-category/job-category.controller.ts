import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  Req,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiCookieAuth,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { JobCategoryService } from './job-category.service';
import { CreateJobCategoryDto } from './dto/create-job-category.dto';
import { UpdateJobCategoryDto } from './dto/update-job-category.dto';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AdminAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { LogService } from '../log/log.service';
import { extractRequestMeta } from '../../common/utils/request-meta.util';

@ApiTags('Job Categories')
@Controller('job-categories')
export class JobCategoryController {
  constructor(private readonly jobCategoryService: JobCategoryService) {}

  @Get()
  @ApiOperation({ summary: 'List all job categories (public)' })
  @ApiResponse({ status: 200 })
  findAll() {
    return this.jobCategoryService.findAll();
  }
}

@ApiTags('Admin — Job Categories')
@ApiCookieAuth()
@UseGuards(AdminAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.MANAGER)
@Controller('admin/job-categories')
export class AdminJobCategoryController {
  constructor(
    private readonly jobCategoryService: JobCategoryService,
    private readonly logService: LogService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List all categories (admin)' })
  findAll() {
    return this.jobCategoryService.findAll();
  }

  @Post()
  @ApiOperation({ summary: 'Create a category' })
  @ApiResponse({ status: 201 })
  async create(
    @Req() req: AdminAuthenticatedRequest,
    @Body() dto: CreateJobCategoryDto,
  ) {
    const category = await this.jobCategoryService.create(dto);
    await this.logService.create({
      action: 'JOB_CATEGORY_CREATED',
      entityType: 'job_category',
      entityId: (category as { id?: string })?.id,
      userId: req.user?.userId,
      metadata: { ...dto },
      ...extractRequestMeta(req),
    });
    return category;
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a category' })
  async update(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateJobCategoryDto,
  ) {
    const category = await this.jobCategoryService.update(id, dto);
    await this.logService.create({
      action: 'JOB_CATEGORY_UPDATED',
      entityType: 'job_category',
      entityId: id,
      userId: req.user?.userId,
      metadata: { changes: { ...dto } },
      ...extractRequestMeta(req),
    });
    return category;
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a category' })
  async remove(@Req() req: AdminAuthenticatedRequest, @Param('id') id: string) {
    const result = await this.jobCategoryService.remove(id);
    await this.logService.create({
      action: 'JOB_CATEGORY_DELETED',
      entityType: 'job_category',
      entityId: id,
      userId: req.user?.userId,
      ...extractRequestMeta(req),
    });
    return result;
  }
}
