import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';

// Extends the shared PaginationOptions (cursor/beforeCursor/limit/query
// are all already defined there — see ListNotificationsDto for the same
// pattern) instead of redeclaring them. `query` in particular was already
// on the base class; this only needs to widen `limit`'s upper bound for
// the Gallery's grid view.
export class ListGalleryImagesDto extends PaginationOptions {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  limit = 20;
}
