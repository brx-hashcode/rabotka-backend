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
  constructor(private readonly jobCategoryService: JobCategoryService) {}

  @Get()
  @ApiOperation({ summary: 'List all categories (admin)' })
  findAll() {
    return this.jobCategoryService.findAll();
  }

  @Post()
  @ApiOperation({ summary: 'Create a category' })
  @ApiResponse({ status: 201 })
  create(@Body() dto: CreateJobCategoryDto) {
    return this.jobCategoryService.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a category' })
  update(@Param('id') id: string, @Body() dto: UpdateJobCategoryDto) {
    return this.jobCategoryService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a category' })
  remove(@Param('id') id: string) {
    return this.jobCategoryService.remove(id);
  }
}
