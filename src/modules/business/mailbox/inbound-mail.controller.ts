import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { ApiExcludeController } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

import { Public } from '../../auth/decorators/public.decorator';
import { InboxService } from './inbox.service';

class InboundMailDto {
  @IsString()
  @MaxLength(320)
  to!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  from?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  subject?: string;
}

/**
 * Where the Cloudflare Email Worker posts a mail forwarded to a business's CV
 * address. Authenticated by a shared secret, never by a session.
 */
@ApiExcludeController()
@Controller('public/inbound-mail')
export class InboundMailController {
  constructor(private readonly inbox: InboxService) {}

  @Public()
  @Post()
  @HttpCode(200)
  // One Worker posts for every business, from Cloudflare's addresses.
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @UseInterceptors(
    FilesInterceptor('files', 10, {
      limits: { fileSize: 10 * 1024 * 1024, files: 10 },
    }),
  )
  receive(
    @Headers('x-inbound-secret') secret: string | undefined,
    @Body() dto: InboundMailDto,
    @UploadedFiles() files: Express.Multer.File[] = [],
  ) {
    return this.inbox.receive(secret, dto, files);
  }
}
