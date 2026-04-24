import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Res,
  Req,
  Param,
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
import { QrGateway } from '../ws-notifications/qr.gateway';
import { WsNotificationsGateway } from '../ws-notifications/ws-notifications.gateway';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
    private readonly qrGateway: QrGateway,
    private readonly wsGateway: WsNotificationsGateway,
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
        firstName: { type: 'string' },
        lastName: { type: 'string' },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getAdminMe(
    @Req() req: AdminAuthenticatedRequest,
  ): Promise<{
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    role: string;
    phonePairedAt: string | null;
    phoneName: string | null;
  }> {
    return this.authService.getAdminById(req.user.userId);
  }

  @Patch('admin/me')
  @UseGuards(AdminAuthGuard)
  @ApiOperation({ summary: 'Update current admin profile' })
  @ApiCookieAuth()
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        firstName: { type: 'string' },
        lastName: { type: 'string' },
      },
      required: ['firstName', 'lastName'],
    },
  })
  @ApiResponse({ status: 200, description: 'Updated admin user' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async updateAdminMe(
    @Req() req: AdminAuthenticatedRequest,
    @Body() body: { firstName: string; lastName: string },
  ): Promise<{ id: string; email: string; firstName: string; lastName: string; role: string }> {
    return this.authService.updateAdminById(req.user.userId, body.firstName, body.lastName);
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

  @Post('admin/qr/init')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Initialize a QR login session' })
  async initQrSession(): Promise<{
    sessionId: string;
    qrUrl: string;
    expiresIn: number;
  }> {
    return this.authService.initQrSession();
  }

  @Get('admin/qr/poll/:sessionId')
  @ApiOperation({ summary: 'Poll QR session status' })
  async pollQrSession(
    @Param('sessionId') sessionId: string,
  ): Promise<{ status: 'pending' | 'confirmed' | 'expired' }> {
    return this.authService.pollQrSession(sessionId);
  }

  @Post('admin/qr/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm QR session from phone using phone pairing token' })
  async confirmQrSession(
    @Body('sessionId') sessionId: string,
    @Body('phoneToken') phoneToken: string,
  ): Promise<{ success: boolean }> {
    const result = await this.authService.confirmQrSession(sessionId, phoneToken);
    this.qrGateway.emitConfirmed(sessionId);
    return result;
  }

  @Post('admin/phone/pair/generate')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AdminAuthGuard)
  @ApiOperation({ summary: 'Generate OTP for phone pairing (displayed on desktop)' })
  @ApiCookieAuth()
  async generatePhonePairingOtp(
    @Req() req: AdminAuthenticatedRequest,
    @Body('phoneName') phoneName: string,
  ): Promise<{ otp: string; expiresIn: number; userId: string }> {
    const result = await this.authService.generatePhonePairingOtp(req.user.userId, phoneName);
    // Notify the profile page that pairing was cleared so it refetches immediately
    this.wsGateway.emitToAdmin(req.user.userId, 'phone:paired');
    return result;
  }

  @Post('admin/phone/pair/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify phone pairing OTP from phone (public)' })
  async verifyPhonePairingOtp(
    @Body('userId') userId: string,
    @Body('otp') otp: string,
  ): Promise<{ token: string }> {
    const result = await this.authService.verifyPhonePairingOtp(userId, otp);
    this.wsGateway.emitToAdmin(userId, 'phone:paired');
    return result;
  }

  @Post('admin/qr/consume')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Consume confirmed QR session and set cookie' })
  async consumeQrSession(
    @Body('sessionId') sessionId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ success: boolean }> {
    const { token } = await this.authService.consumeQrSession(sessionId);

    const isProduction = this.configService.get<string>('NODE_ENV') === 'production';
    const cookieName = this.configService.get<string>('AUTH_COOKIE_NAME');
    if (!cookieName) throw new Error('AUTH_COOKIE_NAME is not set');

    res.cookie(cookieName, token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000,
      path: '/',
    });

    return { success: true };
  }
}
