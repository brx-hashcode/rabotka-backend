import { IsString, MinLength } from 'class-validator';

export class RejectAdvertisementDto {
  @IsString()
  @MinLength(5)
  reason: string;
}
