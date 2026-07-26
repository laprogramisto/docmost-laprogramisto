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

  @IsOptional()
  @IsString()
  coverPhoto?: string;

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
