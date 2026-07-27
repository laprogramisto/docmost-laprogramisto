import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { Transform } from 'class-transformer';

export type ContentFormat = 'json' | 'markdown' | 'html';

export class CreatePageDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  icon?: string;

  // The id of an existing Attachment (type: "cover") to use as this page's
  // cover — never a raw URL. PageService resolves this server-side (must
  // exist, must be type Cover, must belong to the same workspace) and
  // derives the public coverPhoto URL itself; a client can never set
  // coverPhoto directly. See PageService.resolveCoverAttachment.
  @IsOptional()
  @IsUUID()
  coverAttachmentId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  coverPhotoPosition?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  coverPhotoPositionX?: number;

  @IsOptional()
  @IsIn(['small', 'large'])
  coverPhotoSize?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  coverPhotoAlt?: string;

  @IsOptional()
  @IsString()
  parentPageId?: string;

  @IsUUID()
  spaceId: string;

  @IsOptional()
  content?: string | object;

  @ValidateIf((o) => o.content !== undefined)
  @Transform(({ value }) => value?.toLowerCase() ?? 'json')
  @IsIn(['json', 'markdown', 'html'])
  format?: ContentFormat;
}
