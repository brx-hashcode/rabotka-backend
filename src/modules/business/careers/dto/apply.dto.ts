import {
  IsIn,
  Matches,
  Equals,
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
} from 'class-validator';

/** The text fields of the multipart form; the CV comes as the `cv` file. */
export class ApplyDto {
  @IsString()
  @Length(1, 80, { message: 'Indiquez votre prénom.' })
  firstName!: string;

  @IsString()
  @Length(1, 80, { message: 'Indiquez votre nom.' })
  lastName!: string;

  @IsEmail({}, { message: 'Cet e-mail ne semble pas valide.' })
  @MaxLength(254)
  email!: string;

  @IsString()
  @Length(6, 30, { message: 'Ce numéro ne semble pas valide.' })
  phone!: string;

  @Equals('true', { message: 'Votre accord est nécessaire pour postuler.' })
  consent!: string;

  /** « Garder ma candidature pour d'autres postes »: an opt-in, 'true' or absent. */
  @IsOptional()
  @IsIn(['true', 'false'])
  poolConsent?: string;

  /** JSON: [{ questionId, value }]. */
  // Up to 5 questions of 3,000 characters each, plus the JSON around them.
  @IsOptional()
  @IsString()
  @MaxLength(20000, { message: 'Vos réponses sont trop longues.' })
  answers?: string;

  /** Where they came from, from `?source=` or the page that sent them. */
  @IsOptional()
  @Matches(/^[a-z0-9-]{1,30}$/)
  source?: string;

  /** Hidden from people: only a bot fills it. */
  @IsOptional()
  @IsString()
  website?: string;
}

export class RefuseExternalDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  message?: string;
}

export class AnalyseExternalDto {
  @IsUUID()
  offerId!: string;

  /** Just this one; without it, those of the offer not yet read. */
  @IsOptional()
  @IsUUID()
  applicationId?: string;
}
