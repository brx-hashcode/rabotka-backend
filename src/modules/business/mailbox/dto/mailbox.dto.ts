import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/** The mails list: a search, and the page the previous one pointed to. */
export class MailboxMailsQueryDto {
  @ApiPropertyOptional({ description: 'Words searched in the mails' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @ApiPropertyOptional({ description: 'The `next` of the previous page' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  page?: string;
}
