import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

// Deliberately not extending the shared PaginationOptions class — this
// endpoint is now the only one in the app that also accepts a search
// query, and keeping it self-contained avoids any risk to unrelated
// paginated endpoints if that shared class's validation ever changes.
export class ListGalleryImagesDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @IsString()
  beforeCursor?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  query?: string;
}
