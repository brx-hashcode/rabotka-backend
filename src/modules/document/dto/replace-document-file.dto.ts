import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength, IsUrl } from 'class-validator';

export class ReplaceDocumentFileDto {
  @ApiProperty({ description: 'Public URL of the freshly-uploaded replacement file' })
  @IsUrl()
  file_url: string;

  @ApiProperty({ description: 'MIME type of the uploaded file' })
  @IsString()
  @MinLength(1)
  mime_type: string;
}
