import {
  Controller,
  Get,
  Post,
  Body,
  Res,
  Req,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody, ApiCookieAuth } from '@nestjs/swagger';
import type { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AdminAuthGuard } from './guards/admin-auth.guard';
import type { AdminAuthenticatedRequest } from './guards/jwt-auth.guard';
import {
  SendOtpDto,
  VerifyOtpDto,
  SendAdminOtpDto,
  VerifyAdminOtpDto,
} from './dto';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  @Post('send-otp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send OTP to email or phone',
    description:
      'Sends a 6-digit OTP to the provided email or phone number. Email sends via SMTP, phone logs OTP (mock).',
  })
  @ApiBody({ type: SendOtpDto })
  @ApiResponse({
    status: 200,
    description: 'OTP sent successfully',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        message: { type: 'string', example: 'OTP sent successfully' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid email or phone, or WhatsApp not verified',
  })
  @ApiResponse({ status: 404, description: 'Profile not found' })
  async sendOtp(
    @Body() sendOtpDto: SendOtpDto,
  ): Promise<{ success: boolean; message: string }> {
    const result = await this.authService.sendOtp(sendOtpDto.emailOrPhone);
    return {
      success: result.success,
      message: 'Code de vérification envoyé avec succès',
    };
  }

  @Post('resend-otp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resend OTP to email or phone',
    description:
      'Resends a 6-digit OTP for the same email or phone. Rate-limited with a short cooldown (e.g. 60s).',
  })
  @ApiBody({ type: SendOtpDto })
  @ApiResponse({
    status: 200,
    description: 'OTP resent successfully',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        message: { type: 'string', example: 'OTP sent successfully' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid email or phone, or WhatsApp not verified',
  })
  @ApiResponse({ status: 404, description: 'Profile not found' })
  @ApiResponse({
    status: 429,
    description: 'Resend cooldown active; wait before requesting again',
  })
  async resendOtp(
    @Body() sendOtpDto: SendOtpDto,
  ): Promise<{ success: boolean; message: string }> {
    const result = await this.authService.resendOtp(sendOtpDto.emailOrPhone);
    return {
      success: result.success,
      message: 'Code de vérification envoyé avec succès',
    };
  }

  @Post('verify-otp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify OTP and authenticate',
    description:
      'Verifies the OTP and sets an httpOnly session cookie. Returns only { success: true } for security.',
  })
  @ApiBody({ type: VerifyOtpDto })
  @ApiResponse({
    status: 200,
    description: 'OTP verified, session cookie set',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Invalid or expired OTP' })
  @ApiResponse({ status: 404, description: 'Profile not found' })
  async verifyOtp(
    @Body() verifyOtpDto: VerifyOtpDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ success: boolean }> {
    const result = await this.authService.verifyOtp(
      verifyOtpDto.emailOrPhone,
      verifyOtpDto.otp,
    );

    const isProduction =
      this.configService.get<string>('NODE_ENV') === 'production';
    const cookieName = this.configService.get<string>('AUTH_COOKIE_NAME');
    const maxAge = 24 * 60 * 60 * 1000;

    if (!cookieName) {
      throw new Error('AUTH_COOKIE_NAME is not set');
    }

    res.cookie(cookieName, result.token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      maxAge,
      path: '/',
    });

    return { success: true };
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Logout user',
    description: 'Clears the authentication cookie to log out the user.',
  })
  @ApiResponse({
    status: 200,
    description: 'Logged out successfully',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
      },
    },
  })
  logout(@Res({ passthrough: true }) res: Response): { success: boolean } {
    this.clearAuthCookie(res);
    return { success: true };
  }

  private clearAuthCookie(res: Response): void {
    const cookieName = this.configService.get<string>('AUTH_COOKIE_NAME');
    if (!cookieName) {
      throw new Error('AUTH_COOKIE_NAME is not set');
    }
    res.clearCookie(cookieName, { path: '/' });
  }

  @Post('admin/send-otp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send OTP to admin email',
    description:
      'Sends a 6-digit OTP to the provided admin email address. Email-only authentication for admin users.',
  })
  @ApiBody({ type: SendAdminOtpDto })
  @ApiResponse({
    status: 200,
    description: 'OTP sent successfully',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        message: { type: 'string', example: 'OTP sent successfully' },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Invalid email' })
  @ApiResponse({ status: 404, description: 'User not found' })
  @ApiResponse({ status: 401, description: 'User is inactive' })
  async sendAdminOtp(
    @Body() sendAdminOtpDto: SendAdminOtpDto,
  ): Promise<{ success: boolean; message: string }> {
    const result = await this.authService.sendAdminOtp(sendAdminOtpDto.email);
    return {
      success: result.success,
      message: 'Code de vérification envoyé avec succès',
    };
  }

  @Post('admin/resend-otp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resend OTP to admin email',
    description:
      'Resends a 6-digit OTP for the same admin email. Rate-limited with a short cooldown (e.g. 60s).',
  })
  @ApiBody({ type: SendAdminOtpDto })
  @ApiResponse({
    status: 200,
    description: 'OTP resent successfully',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        message: { type: 'string', example: 'OTP sent successfully' },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Invalid email' })
  @ApiResponse({ status: 404, description: 'User not found' })
  @ApiResponse({ status: 401, description: 'User is inactive' })
  @ApiResponse({
    status: 429,
    description: 'Resend cooldown active; wait before requesting again',
  })
  async resendAdminOtp(
    @Body() sendAdminOtpDto: SendAdminOtpDto,
  ): Promise<{ success: boolean; message: string }> {
    const result = await this.authService.resendAdminOtp(sendAdminOtpDto.email);
    return {
      success: result.success,
      message: 'Code de vérification envoyé avec succès',
    };
  }

  @Post('admin/verify-otp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify admin OTP and authenticate',
    description:
      'Verifies the admin OTP and sets an httpOnly session cookie. Returns only { success: true } for security.',
  })
  @ApiBody({ type: VerifyAdminOtpDto })
  @ApiResponse({
    status: 200,
    description: 'OTP verified, session cookie set',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Invalid or expired OTP' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async verifyAdminOtp(
    @Body() verifyAdminOtpDto: VerifyAdminOtpDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ success: boolean }> {
    const result = await this.authService.verifyAdminOtp(
      verifyAdminOtpDto.email,
      verifyAdminOtpDto.otp,
    );

    const isProduction =
      this.configService.get<string>('NODE_ENV') === 'production';
    const cookieName = this.configService.get<string>('AUTH_COOKIE_NAME');
    const maxAge = 24 * 60 * 60 * 1000;

    if (!cookieName) {
      throw new Error('AUTH_COOKIE_NAME is not set');
    }

    res.cookie(cookieName, result.token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      maxAge,
      path: '/',
    });

    return { success: true };
  }

  @Get('admin/me')
  @UseGuards(AdminAuthGuard)
  @ApiOperation({
    summary: 'Get current admin user',
    description: 'Returns the authenticated admin user. Requires admin session cookie.',
  })
  @ApiCookieAuth()
  @ApiResponse({
    status: 200,
    description: 'Current admin user',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        email: { type: 'string', format: 'email' },
        name: { type: 'string' },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getAdminMe(
    @Req() req: AdminAuthenticatedRequest,
  ): Promise<{ id: string; email: string; name: string; role: string }> {
    return this.authService.getAdminById(req.user.userId);
  }

  @Post('admin/logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Logout admin',
    description: 'Clears the authentication cookie to log out the admin.',
  })
  @ApiResponse({
    status: 200,
    description: 'Logged out successfully',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
      },
    },
  })
  adminLogout(@Res({ passthrough: true }) res: Response): { success: boolean } {
    this.clearAuthCookie(res);
    return { success: true };
  }
}
