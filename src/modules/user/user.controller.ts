import {
  Controller,
  Post,
  Body,
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
import { UserService } from './user.service';
import { CreateAdminDto } from './dto/create-admin.dto';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';

@ApiTags('User')
@Controller('user')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Post()
  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth()
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Create a new admin user',
    description:
      'Creates a new admin user. Requires admin authentication. Only ADMIN or SUPER_ADMIN roles are allowed.',
  })
  @ApiBody({ type: CreateAdminDto })
  @ApiResponse({
    status: 201,
    description: 'Admin user created successfully',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        email: { type: 'string', format: 'email' },
        role: { type: 'string', enum: ['ADMIN', 'SUPER_ADMIN'] },
        isActive: { type: 'boolean' },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
      },
    },
  })
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
}
