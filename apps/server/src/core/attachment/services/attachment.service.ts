import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Readable } from 'stream';
import { StorageService } from '../../../integrations/storage/storage.service';
import { MultipartFile } from '@fastify/multipart';
import {
  getAttachmentFolderPath,
  PreparedFile,
  prepareFile,
  validateFileType,
  validateImageSignature,
} from '../attachment.utils';
import { v4 as uuid4, v7 as uuid7 } from 'uuid';
import { AttachmentRepo } from '@docmost/db/repos/attachment/attachment.repo';
import { AttachmentType, validImageExtensions } from '../attachment.constants';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { Attachment, User, Workspace } from '@docmost/db/types/entity.types';
import { InjectKysely } from 'nestjs-kysely';
import { executeTx } from '@docmost/db/utils';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { SpaceRepo } from '@docmost/db/repos/space/space.repo';
import { InjectQueue } from '@nestjs/bullmq';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';
import { Queue } from 'bullmq';
import { createByteCountingStream } from '../../../common/helpers/utils';

@Injectable()
export class AttachmentService {
  private readonly logger = new Logger(AttachmentService.name);
  constructor(
    private readonly storageService: StorageService,
    private readonly attachmentRepo: AttachmentRepo,
    private readonly userRepo: UserRepo,
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly spaceRepo: SpaceRepo,
    @InjectKysely() private readonly db: KyselyDB,
    @InjectQueue(QueueName.ATTACHMENT_QUEUE) private attachmentQueue: Queue,
  ) {}

  async uploadFile(opts: {
    filePromise: Promise<MultipartFile>;
    pageId?: string;
    userId: string;
    spaceId: string;
    workspaceId: string;
    attachmentId?: string;
    type?: AttachmentType;
  }) {
    const { filePromise, pageId, spaceId, userId, workspaceId } = opts;
    const isCover = opts.type === AttachmentType.Cover;

    // Streamed for every attachment type, covers included — same as
    // upstream docmost's original behavior for this endpoint. A cover's
    // thumbnail is never read here: it arrives via its own, separate
    // call to this same method (routed through attachThumbnail below),
    // never as a second part of this request.
    const preparedFile: PreparedFile = await prepareFile(filePromise, {
      skipBuffer: true,
    });

    let isUpdate = false;
    let attachmentId = null;

    // passing attachmentId to allow for updating diagrams
    // instead of creating new files for each save
    if (opts?.attachmentId) {
      const existingAttachment = await this.attachmentRepo.findById(
        opts.attachmentId,
      );
      if (!existingAttachment) {
        throw new NotFoundException(
          'Existing attachment to overwrite not found',
        );
      }

      if (
        existingAttachment.pageId !== pageId ||
        existingAttachment.fileExt !== preparedFile.fileExtension ||
        existingAttachment.workspaceId !== workspaceId
      ) {
        throw new BadRequestException('File attachment does not match');
      }
      attachmentId = opts.attachmentId;
      isUpdate = true;
    } else {
      attachmentId = uuid7();
    }

    // Covers get their own folder (see getAttachmentFolderPath), same as
    // avatars/workspace-logos/space-logos each do — everything else keeps
    // landing under .../files, unchanged.
    const folderType = isCover ? AttachmentType.Cover : AttachmentType.File;
    const filePath = `${getAttachmentFolderPath(folderType, workspaceId)}/${attachmentId}/${preparedFile.fileName}`;

    const { stream, getBytesRead } = createByteCountingStream(
      preparedFile.multiPartFile.file,
    );
    await this.uploadToDrive(filePath, stream);
    preparedFile.fileSize = getBytesRead();

    let attachment: Attachment = null;
    try {
      if (isUpdate) {
        attachment = await this.attachmentRepo.updateAttachment(
          {
            fileSize: preparedFile.fileSize,
            updatedAt: new Date(),
          },
          attachmentId,
        );
      } else {
        attachment = await this.saveAttachment({
          attachmentId,
          preparedFile,
          filePath,
          type: opts.type ?? AttachmentType.File,
          userId,
          spaceId,
          workspaceId,
          pageId,
        });
      }

      // Only index PDFs and DOCX files
      if (['.pdf', '.docx'].includes(attachment.fileExt.toLowerCase())) {
        await this.attachmentQueue.add(
          QueueJob.ATTACHMENT_INDEX_CONTENT,
          {
            attachmentId: attachmentId,
          },
          {
            attempts: 2,
            backoff: {
              type: 'exponential',
              delay: 10000,
            },
          },
        );
      }
    } catch (err) {
      // delete uploaded file on error
      this.logger.error(err);
    }

    return attachment;
  }

  // The follow-up call for a cover's thumbnail: a small (client-generated,
  // canvas-based JPEG) file, buffered in full — unlike the main upload
  // above, buffering this one is fine, it's always small — validated by
  // content signature, uploaded to storage, then patched onto the
  // already-existing cover attachment via thumbnailPath/thumbnailSize.
  // Never creates a new attachment row.
  //
  // spaceId here is the space the controller already validated the
  // caller's permissions against (validateCanEdit / Manage-Page ability,
  // same checks the main upload went through) — checking the target
  // attachment actually belongs to that space, not just the same
  // workspace, is what stops a forged targetAttachmentId from pointing at
  // someone else's cover in a different space of the same workspace,
  // where the caller may have no rights at all.
  async attachThumbnail(opts: {
    filePromise: Promise<MultipartFile>;
    targetAttachmentId: string;
    workspaceId: string;
    spaceId: string;
  }): Promise<Attachment> {
    const { filePromise, targetAttachmentId, workspaceId, spaceId } = opts;

    const target = await this.attachmentRepo.findById(targetAttachmentId);
    if (
      !target ||
      target.workspaceId !== workspaceId ||
      target.spaceId !== spaceId ||
      target.type !== AttachmentType.Cover
    ) {
      throw new NotFoundException('Cover attachment not found');
    }

    const preparedThumbnail: PreparedFile = await prepareFile(filePromise, {
      skipBuffer: false,
    });
    validateFileType(preparedThumbnail.fileExtension, validImageExtensions);
    validateImageSignature(preparedThumbnail.buffer);

    const thumbnailPath = `${getAttachmentFolderPath(AttachmentType.Cover, workspaceId)}/${targetAttachmentId}/thumbnail_${preparedThumbnail.fileName}`;
    await this.uploadToDrive(thumbnailPath, preparedThumbnail.buffer);

    return this.attachmentRepo.updateAttachment(
      {
        thumbnailPath,
        thumbnailSize: preparedThumbnail.buffer.length,
      },
      targetAttachmentId,
    );
  }

  async uploadImage(
    filePromise: Promise<MultipartFile>,
    type:
      | AttachmentType.Avatar
      | AttachmentType.WorkspaceIcon
      | AttachmentType.SpaceIcon,
    userId: string,
    workspaceId: string,
    spaceId?: string,
  ) {
    const preparedFile: PreparedFile = await prepareFile(filePromise);
    validateFileType(preparedFile.fileExtension, validImageExtensions);

    preparedFile.fileName = uuid4() + preparedFile.fileExtension;

    const filePath = `${getAttachmentFolderPath(type, workspaceId)}/${preparedFile.fileName}`;

    await this.uploadToDrive(filePath, preparedFile.buffer);

    let attachment: Attachment = null;
    let oldFileName: string = null;

    try {
      await executeTx(this.db, async (trx) => {
        attachment = await this.saveAttachment({
          preparedFile,
          filePath,
          type,
          userId,
          workspaceId,
          trx,
        });

        if (type === AttachmentType.Avatar) {
          const user = await this.userRepo.findById(userId, workspaceId, {
            trx,
          });

          oldFileName = user.avatarUrl;

          await this.userRepo.updateUser(
            { avatarUrl: preparedFile.fileName },
            userId,
            workspaceId,
            trx,
          );
        } else if (type === AttachmentType.WorkspaceIcon) {
          const workspace = await this.workspaceRepo.findById(workspaceId, {
            trx,
          });

          oldFileName = workspace.logo;

          await this.workspaceRepo.updateWorkspace(
            { logo: preparedFile.fileName },
            workspaceId,
            trx,
          );
        } else if (type === AttachmentType.SpaceIcon && spaceId) {
          const space = await this.spaceRepo.findById(spaceId, workspaceId, {
            trx,
          });

          oldFileName = space.logo;

          await this.spaceRepo.updateSpace(
            { logo: preparedFile.fileName },
            spaceId,
            workspaceId,
            trx,
          );
        } else {
          throw new BadRequestException(`Image upload aborted.`);
        }
      });
    } catch (err) {
      // delete uploaded file on db update failure
      await this.deleteRedundantFile(filePath);
      throw new BadRequestException('Failed to upload image');
    }

    if (oldFileName && !oldFileName.toLowerCase().startsWith('http')) {
      // delete old avatar or logo
      const oldFilePath =
        getAttachmentFolderPath(type, workspaceId) + '/' + oldFileName;
      await this.deleteRedundantFile(oldFilePath);
    }

    return attachment;
  }

  async deleteRedundantFile(filePath: string) {
    try {
      await this.storageService.delete(filePath);
      await this.attachmentRepo.deleteAttachmentByFilePath(filePath);
    } catch (error) {
      this.logger.error('deleteRedundantFile', error);
    }
  }

  async uploadToDrive(filePath: string, fileContent: Buffer | Readable) {
    try {
      await this.storageService.upload(filePath, fileContent);
    } catch (err) {
      this.logger.error('Error uploading file to drive:', err);
      throw new BadRequestException('Error uploading file to drive');
    }
  }

  async saveAttachment(opts: {
    attachmentId?: string;
    preparedFile: PreparedFile;
    filePath: string;
    type: AttachmentType;
    userId: string;
    workspaceId: string;
    pageId?: string;
    spaceId?: string;
    thumbnailPath?: string | null;
    thumbnailSize?: number | null;
    trx?: KyselyTransaction;
  }): Promise<Attachment> {
    const {
      attachmentId,
      preparedFile,
      filePath,
      type,
      userId,
      workspaceId,
      pageId,
      spaceId,
      thumbnailPath,
      thumbnailSize,
      trx,
    } = opts;
    return this.attachmentRepo.insertAttachment(
      {
        id: attachmentId,
        type: type,
        filePath: filePath,
        // Kept as the full sanitized filename (with extension), same as
        // every other attachment type — do not strip the extension here.
        // The Gallery only wants an extension-less label in its UI; that's
        // handled at display/rename time client-side (see
        // gallery-modal.tsx), not by changing what's stored. Every other
        // consumer of attachment.fileName (Content-Disposition downloads,
        // Draw.io/Excalidraw file matching, AI chat, search, ee/base file
        // cells...) still expects the extension to be there.
        fileName: preparedFile.fileName,
        fileSize: preparedFile.fileSize,
        mimeType: preparedFile.mimeType,
        fileExt: preparedFile.fileExtension,
        creatorId: userId,
        workspaceId: workspaceId,
        pageId: pageId,
        spaceId: spaceId,
        thumbnailPath: thumbnailPath ?? null,
        thumbnailSize: thumbnailSize ?? null,
      },
      trx,
    );
  }

  async handleDeleteAiChatAttachments(aiChatId: string) {
    try {
      const attachments = await this.attachmentRepo.findByAiChatId(aiChatId);
      if (!attachments || attachments.length === 0) {
        return;
      }

      await Promise.all(
        attachments.map(async (attachment) => {
          try {
            await this.storageService.delete(attachment.filePath);
            await this.attachmentRepo.deleteAttachmentById(attachment.id);
          } catch (err) {
            this.logger.log(
              `DeleteAiChatAttachments: failed to delete attachment ${attachment.id}:`,
              err,
            );
          }
        }),
      );
    } catch (err) {
      throw err;
    }
  }

  async handleDeleteSpaceAttachments(spaceId: string) {
    try {
      const attachments = await this.attachmentRepo.findBySpaceId(spaceId);
      if (!attachments || attachments.length === 0) {
        return;
      }

      const failedDeletions = [];

      await Promise.all(
        attachments.map(async (attachment) => {
          try {
            await this.storageService.delete(attachment.filePath);
            await this.attachmentRepo.deleteAttachmentById(attachment.id);
          } catch (err) {
            failedDeletions.push(attachment.id);
            this.logger.log(
              `DeleteSpaceAttachments: failed to delete attachment ${attachment.id}:`,
              err,
            );
          }
        }),
      );

      if (failedDeletions.length === attachments.length) {
        throw new Error(
          `Failed to delete any attachments for spaceId: ${spaceId}`,
        );
      }
    } catch (err) {
      throw err;
    }
  }

  async handleDeleteUserAvatars(userId: string) {
    try {
      const userAvatars = await this.db
        .selectFrom('attachments')
        .select(['id', 'filePath'])
        .where('creatorId', '=', userId)
        .where('type', '=', AttachmentType.Avatar)
        .execute();

      if (!userAvatars || userAvatars.length === 0) {
        return;
      }

      await Promise.all(
        userAvatars.map(async (attachment) => {
          try {
            await this.storageService.delete(attachment.filePath);
            await this.attachmentRepo.deleteAttachmentById(attachment.id);
          } catch (err) {
            this.logger.log(
              `DeleteUserAvatar: failed to delete user avatar ${attachment.id}:`,
              err,
            );
          }
        }),
      );
    } catch (err) {
      throw err;
    }
  }

  async handleDeletePageAttachments(pageId: string) {
    try {
      // Fetch attachments for this page from database
      const attachments = await this.db
        .selectFrom('attachments')
        .select(['id', 'filePath'])
        .where('pageId', '=', pageId)
        .execute();

      if (!attachments || attachments.length === 0) {
        return;
      }

      const failedDeletions = [];

      await Promise.all(
        attachments.map(async (attachment) => {
          try {
            // Delete from storage
            await this.storageService.delete(attachment.filePath);
            // Delete from database
            await this.attachmentRepo.deleteAttachmentById(attachment.id);
          } catch (err) {
            failedDeletions.push(attachment.id);
            this.logger.error(
              `Failed to delete attachment ${attachment.id} for page ${pageId}:`,
              err,
            );
          }
        }),
      );

      if (failedDeletions.length > 0) {
        this.logger.warn(
          `Failed to delete ${failedDeletions.length} attachments for page ${pageId}`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Error in handleDeletePageAttachments for page ${pageId}:`,
        err,
      );
      throw err;
    }
  }

  async removeUserAvatar(user: User) {
    if (user.avatarUrl && !user.avatarUrl.toLowerCase().startsWith('http')) {
      const filePath = `${getAttachmentFolderPath(AttachmentType.Avatar, user.workspaceId)}/${user.avatarUrl}`;
      await this.deleteRedundantFile(filePath);
    }

    await this.userRepo.updateUser(
      { avatarUrl: null },
      user.id,
      user.workspaceId,
    );
  }

  async removeSpaceIcon(spaceId: string, workspaceId: string) {
    const space = await this.spaceRepo.findById(spaceId, workspaceId);

    if (!space) {
      throw new NotFoundException('Space not found');
    }

    if (space.logo && !space.logo.toLowerCase().startsWith('http')) {
      const filePath = `${getAttachmentFolderPath(AttachmentType.SpaceIcon, workspaceId)}/${space.logo}`;
      await this.deleteRedundantFile(filePath);
    }

    await this.spaceRepo.updateSpace({ logo: null }, spaceId, workspaceId);
  }

  async removeWorkspaceIcon(workspace: Workspace) {
    if (workspace.logo && !workspace.logo.toLowerCase().startsWith('http')) {
      const filePath = `${getAttachmentFolderPath(AttachmentType.WorkspaceIcon, workspace.id)}/${workspace.logo}`;
      await this.deleteRedundantFile(filePath);
    }

    await this.workspaceRepo.updateWorkspace({ logo: null }, workspace.id);
  }

  // Deleting an image from the shared Gallery must never leave a page
  // pointing at a cover that no longer exists. Every page currently using
  // this attachment (found via the real FK, not a URL pattern match — see
  // AttachmentRepo.getSpaceIdsUsingAttachment for the same lookup used by
  // the cross-space permission check) has its cover fully cleared: all
  // five cover_* columns, not just coverPhoto/position/size — leaving
  // coverAttachmentId, coverPhotoPositionX or coverPhotoAlt behind would
  // orphan them against a row that's about to be deleted.
  async deleteImage(attachmentId: string, workspaceId: string) {
    const attachment = await this.attachmentRepo.findById(attachmentId);

    if (!attachment || attachment.workspaceId !== workspaceId) {
      throw new NotFoundException('File not found');
    }

    await this.db
      .updateTable('pages')
      .set({
        coverAttachmentId: null,
        coverPhoto: null,
        coverPhotoPosition: null,
        coverPhotoPositionX: null,
        coverPhotoSize: null,
        coverPhotoAlt: null,
      })
      .where('workspaceId', '=', workspaceId)
      .where('coverAttachmentId', '=', attachmentId)
      .execute();

    await this.storageService.delete(attachment.filePath);
    await this.attachmentRepo.deleteAttachmentById(attachmentId);
  }

  // Defaults match the values that were previously hardcoded on both sides
  // (MAX_BULK_FILES in gallery-modal.tsx, limit: 60 in
  // useWorkspaceImagesQuery) — configuring nothing keeps today's behavior
  // identical.
  private static readonly DEFAULT_GALLERY_SETTINGS = {
    maxBulkUploadFiles: 100,
    defaultPageSize: 60,
    rateLimitPerMinute: 150,
    restrictDeleteToOwners: false,
  };

  async getGallerySettings(workspaceId: string) {
    const workspace = await this.workspaceRepo.findById(workspaceId);
    const gallerySettings =
      (workspace?.settings as Record<string, any>)?.gallery ?? {};

    return {
      ...AttachmentService.DEFAULT_GALLERY_SETTINGS,
      ...gallerySettings,
    };
  }

  async updateGallerySettings(
    workspaceId: string,
    dto: {
      maxBulkUploadFiles?: number;
      defaultPageSize?: number;
      rateLimitPerMinute?: number;
      restrictDeleteToOwners?: boolean;
    },
  ) {
    const workspace = await this.workspaceRepo.findById(workspaceId);
    // Settings is a single JSON blob shared with unrelated features (ai,
    // api, sharing, templates...) — spreading the existing object first and
    // only replacing the "gallery" key keeps every other namespace intact.
    const currentSettings = (workspace?.settings as Record<string, any>) ?? {};
    const currentGallery = currentSettings.gallery ?? {};
    const nextGallery = { ...currentGallery, ...dto };

    await this.workspaceRepo.updateWorkspace(
      { settings: { ...currentSettings, gallery: nextGallery } },
      workspaceId,
    );

    return {
      ...AttachmentService.DEFAULT_GALLERY_SETTINGS,
      ...nextGallery,
    };
  }
}
