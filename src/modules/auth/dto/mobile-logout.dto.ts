import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class MobileLogoutDto {
  @ApiPropertyOptional({
    description:
      'Optional refresh token to invalidate. The long-lived mobile token has no refresh token, so the bearer access token alone is enough to revoke the session.',
  })
  @IsOptional()
  @IsString()
  refreshToken?: string;
}
