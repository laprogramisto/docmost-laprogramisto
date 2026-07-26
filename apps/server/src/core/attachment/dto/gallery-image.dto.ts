import { IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator';

export class DeleteImageDto {
  @IsUUID()
  attachmentId: string;
}

export class RenameImageDto {
  @IsUUID()
  attachmentId: string;

  // 255 mirrors the cap applied to uploaded file names in
  // attachment.utils.ts (`sanitizedFilename.slice(0, 255)`), so a rename
  // cannot produce a name that an upload would never have created.
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  fileName: string;
}
