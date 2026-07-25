import {
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ArrayMaxSize,
  ValidateNested,
  IsInt,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateDirectDto {
  @ApiProperty()
  @IsUUID()
  userId!: string;
}

export class CreateGroupDto {
  @ApiProperty()
  @IsString()
  @MaxLength(120)
  name!: string;

  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  memberIds!: string[];
}

export class AttachmentDto {
  @IsString() url!: string;
  @IsString() key!: string;
  @IsString() name!: string;
  @IsString() mime!: string;
  @IsInt() @Min(0) size!: number;
}

export class SendMessageDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  body?: string;

  @ApiPropertyOptional({ type: [AttachmentDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => AttachmentDto)
  attachments?: AttachmentDto[];
}

export class EditMessageDto {
  @ApiProperty()
  @IsString()
  @MaxLength(8000)
  body!: string;
}
