import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNumber,
  IsInt,
  IsEnum,
  IsOptional,
  IsDateString,
  IsBoolean,
  Min,
  Max,
  MinLength,
  MaxLength,
  ValidateIf,
  IsArray,
  ArrayMaxSize,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { EmploymentType, OfferQuestionKind, PaymentFlow } from '@prisma/client';
import { LocationDto } from '../../../common/dto/location.dto';

/** Mirrored by `ADDRESS_MIN` in the service, which enforces the same bound. */
const ADDRESS_MIN_LENGTH = 10;

/** One question the candidates answer when they apply. */
export class OfferQuestionDto {
  @ApiProperty({ enum: OfferQuestionKind })
  @IsEnum(OfferQuestionKind)
  kind!: OfferQuestionKind;

  @ApiProperty({ example: 'Avez-vous le permis B ?' })
  @IsString()
  @MaxLength(140)
  label!: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'CHOICE: 2 to 6 answers',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  options?: string[];

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @ApiPropertyOptional({
    description:
      '« Éliminatoire »: an answer outside `accepted` flags the application',
  })
  @IsOptional()
  @IsBoolean()
  knockout?: boolean;

  @ApiPropertyOptional({
    type: [String],
    description: 'YES_NO: ["yes"] or ["no"]; CHOICE: some of `options`',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @IsString({ each: true })
  accepted?: string[];
}

export class CreateJobOfferDto extends LocationDto {
  @ApiProperty({ example: 'Plombier pour réparation urgente' })
  @IsString()
  @MinLength(5, { message: 'Le titre doit contenir entre 5 et 100 caractères' })
  @MaxLength(100)
  title!: string;

  @ApiProperty({
    example:
      "Réparation fuite d'eau cuisine, remplacement robinet, vérification tuyauterie",
  })
  @IsString()
  @MinLength(20, {
    message: 'La description doit contenir entre 20 et 1000 caractères',
  })
  @MaxLength(1000)
  description!: string;

  @ApiPropertyOptional({
    enum: EmploymentType,
    default: EmploymentType.MISSION,
    description:
      'What kind of engagement this is. MISSION (the default) is a one-off gig ' +
      'and is the only type that requires a closing date.',
  })
  @IsOptional()
  @IsEnum(EmploymentType)
  employment_type?: EmploymentType;

  @ApiPropertyOptional({
    example: '2026-02-15T09:00:00.000Z',
    description:
      'When the offer CLOSES to applications. Required for a MISSION; may be ' +
      'omitted for CDI/CDD/STAGE, which have no single date. Enforced in the ' +
      'service, which is the only place that knows both fields.',
  })
  @IsOptional()
  @IsDateString()
  scheduled_at?: string;

  @ApiPropertyOptional({
    example: 15000,
    description: 'Amount in FCFA (0 or omitted = not specified)',
  })
  @IsOptional()
  @IsNumber()
  @Min(1_000, { message: 'Le montant minimum est 1 000 FCFA' })
  @Max(1_000_000, { message: 'Le montant maximum est 1 000 000 FCFA' })
  amount?: number;

  @ApiPropertyOptional({ enum: PaymentFlow })
  @IsOptional()
  @IsEnum(PaymentFlow)
  payment_flow?: PaymentFlow | null;

  @ApiPropertyOptional({
    example: '123 Avenue de la Paix, Poto-Poto, Brazzaville',
    description:
      'Always optional. Much of the informal work here happens at the ' +
      "worker's own place — a tailor, a mechanic, a hairdresser — and the " +
      'client travels to them, so there is no address to give. The city and ' +
      'country carry the geography. When supplied it must be a real address ' +
      `of at least ${ADDRESS_MIN_LENGTH} characters.`,
  })
  @IsOptional()
  @IsString()
  // Skipped for "", which is how a client CLEARS an address it had set.
  // Without this the only way to remove one would be to omit the field, and
  // omitting it means "leave it alone" on the update path.
  @ValidateIf((o: CreateJobOfferDto) => (o.address ?? '').trim().length > 0)
  @MinLength(ADDRESS_MIN_LENGTH)
  address?: string;

  @ApiPropertyOptional({
    example: false,
    description: 'A job done from anywhere. Clears address, country and city.',
  })
  @IsOptional()
  @IsBoolean()
  isRemote?: boolean;

  @ApiPropertyOptional({ example: 'Apporter vos propres outils' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({
    example: 'cuid-of-job-category',
    description: 'Optional job category',
  })
  @IsOptional()
  @IsString()
  category_id?: string;

  @ApiProperty({ example: 2, description: 'Number of persons needed' })
  @IsInt()
  @Min(1, { message: 'Au moins 1 personne requise' })
  @Max(100, { message: 'Maximum 100 personnes' })
  quantity!: number;

  @ApiPropertyOptional({
    type: [OfferQuestionDto],
    description:
      'Up to 5 questions the candidates answer when they apply. On an edit, the list replaces the current one; omitted leaves it alone.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => OfferQuestionDto)
  questions?: OfferQuestionDto[];
}
