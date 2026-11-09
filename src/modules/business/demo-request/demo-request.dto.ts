import { DemoRequestStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { BUSINESS_SIZES } from '../business-catalog';
import { DEMO_INTERESTS } from './demo-request.constants';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** « Demander une démo », from the business site. */
export class CreateDemoRequestDto {
  @Transform(trim)
  @IsString()
  @Length(1, 80, { message: 'Indiquez votre prénom.' })
  firstName!: string;

  @Transform(trim)
  @IsString()
  @Length(1, 80, { message: 'Indiquez votre nom.' })
  lastName!: string;

  @Transform(trim)
  @IsEmail({}, { message: 'Cet e-mail ne semble pas valide.' })
  @MaxLength(254)
  email!: string;

  @Transform(trim)
  @IsString()
  @Matches(/^\+?[0-9 ().-]{6,30}$/, {
    message: 'Ce numéro ne semble pas valide.',
  })
  phone!: string;

  @Transform(trim)
  @IsString()
  @Length(1, 120, { message: 'Indiquez le nom de votre entreprise.' })
  company!: string;

  @Transform(trim)
  @IsString()
  @Length(1, 120, { message: 'Indiquez votre fonction.' })
  jobTitle!: string;

  /** Checked against the business countries by the service. */
  @IsString()
  @Length(2, 2, { message: 'Choisissez votre pays.' })
  country!: string;

  @IsIn(BUSINESS_SIZES, {
    message: 'Choisissez la taille de votre entreprise.',
  })
  companySize!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(DEMO_INTERESTS.length)
  @IsIn(DEMO_INTERESTS, { each: true })
  interests?: string[];

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000, {
    message: 'Votre message est trop long (2 000 caractères au plus).',
  })
  message?: string;

  /** Hidden from people: only a bot fills it. */
  @IsOptional()
  @IsString()
  website?: string;
}

const toArray = (v: unknown) => (typeof v === 'string' ? v.split(',') : v);

export class AdminDemoRequestsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsEnum(DemoRequestStatus, { each: true })
  status?: DemoRequestStatus[];

  @IsOptional()
  @IsString()
  @Length(2, 2)
  country?: string;
}

export class UpdateDemoRequestDto {
  @IsOptional()
  @IsEnum(DemoRequestStatus)
  status?: DemoRequestStatus;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  notes?: string;
}
