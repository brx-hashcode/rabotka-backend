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
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@ApiTags('User')
@Controller('user')
@UseGuards(AdminAuthGuard, RolesGuard)
@ApiBearerAuth()
@ApiCookieAuth()
export class UserController {
  constructor(private readonly userService: UserService) {}

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
  async createAdmin(@Body() createAdminDto: CreateAdminDto) {
    const user = await this.userService.createAdmin(createAdminDto);
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
    @Param('id') id: string,
    @Body() updateAdminDto: UpdateAdminDto,
  ) {
    const user = await this.userService.updateAdmin(id, updateAdminDto);
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
  async activate(@Param('id') id: string) {
    const user = await this.userService.activate(id);
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
  async deactivate(@Param('id') id: string) {
    const user = await this.userService.deactivate(id);
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

  @Delete(':id')
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Delete an admin user' })
  @ApiResponse({ status: 200, description: 'User deleted successfully' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async deleteAdmin(@Param('id') id: string) {
    await this.userService.deleteAdmin(id);
    return { success: true };
  }
}
