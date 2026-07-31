import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
  Req,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBody,
  ApiBearerAuth,
  ApiCookieAuth,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { UserService } from './user.service';
import { CreateAdminDto } from './dto/create-admin.dto';
import { UpdateAdminDto } from './dto/update-admin.dto';
import { AdminListUsersDto } from './dto/admin-list-users.dto';
import { ArchiveService } from '../admin-archive/archive.service';
import { BulkDeleteDto } from '../../common/dto/bulk-delete.dto';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AdminAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { LogService } from '../log/log.service';
import { extractRequestMeta } from '../../common/utils/request-meta.util';

@ApiTags('User')
@Controller('user')
@UseGuards(AdminAuthGuard, RolesGuard)
@ApiBearerAuth()
@ApiCookieAuth()
export class UserController {
  constructor(
    private readonly userService: UserService,
    private readonly logService: LogService,
    private readonly archiveService: ArchiveService,
  ) {}

  @Get()
  @Roles(UserRole.MODERATOR)
  @ApiOperation({
    summary: 'List admin users',
    description:
      'Returns paginated admin users with optional search and role filter.',
  })
  @ApiResponse({ status: 200, description: 'Paginated list of users' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async list(@Query() dto: AdminListUsersDto) {
    return this.userService.getList(dto);
  }

  @Post()
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a new admin user',
    description:
      'Creates a new admin user. Requires admin authentication. Only ADMIN or SUPER_ADMIN roles are allowed.',
  })
  @ApiBody({ type: CreateAdminDto })
  @ApiResponse({ status: 201, description: 'Admin user created successfully' })
  @ApiResponse({ status: 400, description: 'Invalid input or role' })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized - admin access required',
  })
  @ApiResponse({ status: 409, description: 'Email already exists' })
  async createAdmin(
    @Req() req: AdminAuthenticatedRequest,
    @Body() createAdminDto: CreateAdminDto,
  ) {
    const user = await this.userService.createAdmin(createAdminDto);
    await this.logService.create({
      action: 'ADMIN_USER_CREATED',
      entityType: 'user',
      entityId: user.id,
      userId: req.user?.userId,
      metadata: {
        email: user.email,
        role: user.role,
      },
      ...extractRequestMeta(req),
    });
    return {
      id: user.id,
      firstName: user.first_name,
      lastName: user.last_name,
      email: user.email,
      role: user.role,
      isActive: user.is_active,
      createdAt: user.created_at,
      updatedAt: user.updated_at,
    };
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Update an admin user' })
  @ApiBody({ type: UpdateAdminDto })
  @ApiResponse({ status: 200, description: 'Admin user updated successfully' })
  @ApiResponse({ status: 404, description: 'User not found' })
  @ApiResponse({ status: 409, description: 'Email already exists' })
  async updateAdmin(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() updateAdminDto: UpdateAdminDto,
  ) {
    const user = await this.userService.updateAdmin(id, updateAdminDto);
    await this.logService.create({
      action: 'ADMIN_USER_UPDATED',
      entityType: 'user',
      entityId: id,
      userId: req.user?.userId,
      metadata: { changes: { ...updateAdminDto } },
      ...extractRequestMeta(req),
    });
    return {
      id: user.id,
      firstName: user.first_name,
      lastName: user.last_name,
      email: user.email,
      role: user.role,
      isActive: user.is_active,
      lastLoginAt: user.last_login_at,
      createdAt: user.created_at,
      updatedAt: user.updated_at,
    };
  }

  @Patch(':id/activate')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Activate an admin user' })
  @ApiResponse({ status: 200, description: 'User activated successfully' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async activate(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    const user = await this.userService.activate(id);
    await this.logService.create({
      action: 'ADMIN_USER_ACTIVATED',
      entityType: 'user',
      entityId: id,
      userId: req.user?.userId,
      ...extractRequestMeta(req),
    });
    return {
      id: user.id,
      firstName: user.first_name,
      lastName: user.last_name,
      email: user.email,
      role: user.role,
      isActive: user.is_active,
      lastLoginAt: user.last_login_at,
      createdAt: user.created_at,
      updatedAt: user.updated_at,
    };
  }

  @Patch(':id/deactivate')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Deactivate an admin user' })
  @ApiResponse({ status: 200, description: 'User deactivated successfully' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async deactivate(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    const user = await this.userService.deactivate(id);
    await this.logService.create({
      action: 'ADMIN_USER_DEACTIVATED',
      entityType: 'user',
      entityId: id,
      userId: req.user?.userId,
      ...extractRequestMeta(req),
    });
    return {
      id: user.id,
      firstName: user.first_name,
      lastName: user.last_name,
      email: user.email,
      role: user.role,
      isActive: user.is_active,
      lastLoginAt: user.last_login_at,
      createdAt: user.created_at,
      updatedAt: user.updated_at,
    };
  }

  @Post('bulk-restore')
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary: 'Bulk restore archived rows (admin only)',
    description: 'Clears deleted_at. Only rows that are currently archived are affected.',
  })
  @ApiResponse({ status: 201, description: 'Rows restored' })
  async bulkRestore(
    @Body() dto: BulkDeleteDto,
    @Req() req: AdminAuthenticatedRequest,
  ): Promise<{ count: number }> {
    const result = await this.archiveService.restore('users', dto.ids);
    await this.logService.create({
      action: 'ADMIN_USER_BULK_RESTORED',
      entityType: 'user',
      userId: req.user?.userId,
      metadata: { ids: dto.ids, count: result.count },
      ...extractRequestMeta(req),
    });
    return result;
  }

  @Post('bulk-purge')
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Permanently delete archived rows (SUPER_ADMIN only)',
    description:
      'Irreversible. Refuses rows carrying records that must outlive them (financial or compliance), returning 409 with the blocking counts.',
  })
  @ApiResponse({ status: 201, description: 'Rows permanently deleted' })
  @ApiResponse({ status: 409, description: 'Blocked by linked records' })
  async bulkPurge(
    @Body() dto: BulkDeleteDto,
    @Req() req: AdminAuthenticatedRequest,
  ): Promise<{ count: number }> {
    const result = await this.archiveService.purge('users', dto.ids);
    await this.logService.create({
      action: 'ADMIN_USER_BULK_PURGED',
      entityType: 'user',
      userId: req.user?.userId,
      metadata: { ids: dto.ids, count: result.count },
      ...extractRequestMeta(req),
    });
    return result;
  }

  @Post('bulk-delete')
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Bulk archive admin users' })
  @ApiResponse({ status: 201, description: 'Users archived' })
  async bulkDelete(
    @Body() dto: BulkDeleteDto,
    @Req() req: AdminAuthenticatedRequest,
  ): Promise<{ count: number }> {
    const result = await this.userService.bulkSoftDeleteAdmins(dto.ids);
    await this.logService.create({
      action: 'ADMIN_USER_BULK_DELETED',
      entityType: 'user',
      userId: req.user?.userId,
      metadata: { ids: dto.ids, count: result.count },
      ...extractRequestMeta(req),
    });
    return result;
  }

  @Delete(':id')
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Delete an admin user' })
  @ApiResponse({ status: 200, description: 'User deleted successfully' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async deleteAdmin(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    await this.userService.deleteAdmin(id);
    await this.logService.create({
      action: 'ADMIN_USER_DELETED',
      entityType: 'user',
      entityId: id,
      userId: req.user?.userId,
      ...extractRequestMeta(req),
    });
    return { success: true };
  }
}
