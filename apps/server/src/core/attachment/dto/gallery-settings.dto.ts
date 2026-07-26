import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

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

  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(1000)
  rateLimitPerMinute?: number;

  // When true, only workspace OWNER (strict — not ADMIN) can delete
  // covers from the shared Gallery. Independent of the always-on
  // cross-space blast-radius check in deleteImage(): this is a policy
  // choice on top of that safety check, not a replacement for it.
  @IsOptional()
  @IsBoolean()
  restrictDeleteToOwners?: boolean;
}
