import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * What the web client's error boundary sends when a page fails to render.
 *
 * Every field is capped: the endpoint is public, so the limits are what keep a
 * report a log line rather than a way to write arbitrary volume into the logs.
 * The client truncates to the same sizes before sending.
 */
export class ClientErrorReportDto {
  @ApiProperty({ example: 'TypeError' })
  @IsString()
  @MaxLength(200)
  name!: string;

  @ApiProperty({
    example: "Cannot read properties of undefined (reading 'title')",
  })
  @IsString()
  @MaxLength(1000)
  message!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  stack?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  componentStack?: string;

  /** Already sanitised client-side — routes can carry payment tokens. */
  @ApiProperty({ example: '/candidatures/:id/paiement' })
  @IsString()
  @MaxLength(500)
  path!: string;

  @ApiPropertyOptional({ example: '1.4.0' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  version?: string;
}
