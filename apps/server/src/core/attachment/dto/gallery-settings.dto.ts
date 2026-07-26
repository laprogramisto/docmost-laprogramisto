import { IsInt, IsOptional, Max, Min } from 'class-validator';

// Bounds are deliberately conservative: this protects the workspace admin
// from misconfiguring their own instance (e.g. a bulk upload limit of 0 or
// 100000) more than it protects against abuse — the throttler (see
// throttle.module.ts) remains the actual abuse safety net and is not
// affected by these values.
export class UpdateGallerySettingsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  maxBulkUploadFiles?: number;

  @IsOptional()
  @IsInt()
  @Min(6)
  @Max(200)
  defaultPageSize?: number;
}
