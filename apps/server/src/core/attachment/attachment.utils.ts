import { MultipartFile } from '@fastify/multipart';
import * as path from 'path';
import { AttachmentType } from './attachment.constants';
import { sanitizeFileName } from '../../common/helpers';
import { getMimeType } from '../../common/helpers';

export interface PreparedFile {
  buffer?: Buffer;
  fileName: string;
  fileSize: number;
  fileExtension: string;
  mimeType: string;
  multiPartFile?: MultipartFile;
}

export async function prepareFile(
  filePromise: Promise<MultipartFile>,
  options: { skipBuffer?: boolean } = {},
): Promise<PreparedFile> {
  const file = await filePromise;

  if (!file) {
    throw new Error('No file provided');
  }

  try {
    let buffer: Buffer | undefined;
    let fileSize = 0;

    if (!options.skipBuffer) {
      buffer = await file.toBuffer();
      fileSize = buffer.length;
    }

    const sanitizedFilename = sanitizeFileName(file.filename);
    const fileName = sanitizedFilename.slice(0, 255);
    const fileExtension = path.extname(file.filename).toLowerCase();

    return {
      buffer,
      fileName,
      fileSize,
      fileExtension,
      mimeType: getMimeType(file.filename),
      multiPartFile: file,
    };
  } catch (error) {
    throw error;
  }
}

export function validateFileType(
  fileExtension: string,
  allowedTypes: string[],
) {
  if (!allowedTypes.includes(fileExtension)) {
    throw new Error('Invalid file type');
  }
}

// Leading bytes ("magic numbers") for the two formats currently covered by
// validImageExtensions (.jpg/.jpeg/.png). Extension checks alone are
// trivially defeated by renaming an arbitrary file, so this inspects the
// actual content instead. Kept deliberately in lockstep with
// validImageExtensions — add a signature here if that list ever grows.
const IMAGE_SIGNATURES: Buffer[] = [
  Buffer.from([0xff, 0xd8, 0xff]), // JPEG
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG
];

export function validateImageSignature(buffer: Buffer) {
  const matches = IMAGE_SIGNATURES.some(
    (signature) =>
      buffer.length >= signature.length &&
      buffer.subarray(0, signature.length).equals(signature),
  );

  if (!matches) {
    throw new Error('File content does not match a supported image format');
  }
}

export function getAttachmentFolderPath(
  type: AttachmentType,
  workspaceId: string,
): string {
  switch (type) {
    case AttachmentType.Avatar:
      return `${workspaceId}/avatars`;
    case AttachmentType.WorkspaceIcon:
      return `${workspaceId}/workspace-logos`;
    case AttachmentType.SpaceIcon:
      return `${workspaceId}/space-logos`;
    case AttachmentType.File:
      return `${workspaceId}/files`;
    case AttachmentType.Chat:
      return `${workspaceId}/chat-files`;
    case AttachmentType.Cover:
      return `${workspaceId}/covers`;
    default:
      return `${workspaceId}/files`;
  }
}

export const validAttachmentTypes = Object.values(AttachmentType);
