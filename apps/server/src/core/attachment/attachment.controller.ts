import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AttachmentService } from './services/attachment.service';
import { FastifyReply, FastifyRequest } from 'fastify';
import { FileInterceptor } from '../../common/interceptors/file.interceptor';
import * as bytes from 'bytes';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Attachment, User, Workspace } from '@docmost/db/types/entity.types';
import { StorageService } from '../../integrations/storage/storage.service';
import {
  getAttachmentFolderPath,
  validAttachmentTypes,
  validateFileType,
} from './attachment.utils';
import { getMimeType, sanitizeFileName } from '../../common/helpers';
import {
  AttachmentType,
  inlineFileExtensions,
  MAX_AVATAR_SIZE,
  validImageExtensions,
} from './attachment.constants';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../casl/interfaces/space-ability.type';
import SpaceAbilityFactory from '../casl/abilities/space-ability.factory';
import {
  WorkspaceCaslAction,
  WorkspaceCaslSubject,
} from '../casl/interfaces/workspace-ability.type';
import WorkspaceAbilityFactory from '../casl/abilities/workspace-ability.factory';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { AttachmentRepo } from '@docmost/db/repos/attachment/attachment.repo';
import { DeleteImageDto, RenameImageDto } from './dto/gallery-image.dto';
import { UpdateGallerySettingsDto } from './dto/gallery-settings.dto';
import { ListGalleryImagesDto } from './dto/gallery-list.dto';
import { validate as isValidUUID } from 'uuid';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { TokenService } from '../auth/services/token.service';
import { JwtAttachmentPayload, JwtType } from '../auth/dto/jwt-payload';
import * as path from 'path';
import { AttachmentInfoDto, RemoveIconDto } from './dto/attachment.dto';
import { PageAccessService } from '../page/page-access/page-access.service';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../integrations/audit/audit.service';
import { SkipThrottle } from '@nestjs/throttler';
import {
  AUTH_THROTTLER,
  AI_CHAT_THROTTLER,
} from '../../integrations/throttle/throttler-names';
import { GalleryThrottlerGuard } from '../../integrations/throttle/gallery-throttler.guard';
import { UserRole } from '../../common/helpers/types/permission';

@Controller()
export class AttachmentController {
  private readonly logger = new Logger(AttachmentController.name);

  constructor(
    private readonly attachmentService: AttachmentService,
    private readonly storageService: StorageService,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
    private readonly spaceAbility: SpaceAbilityFactory,
    private readonly pageRepo: PageRepo,
    private readonly attachmentRepo: AttachmentRepo,
    private readonly environmentService: EnvironmentService,
    private readonly tokenService: TokenService,
    private readonly pageAccessService: PageAccessService,
    private readonly galleryThrottlerGuard: GalleryThrottlerGuard,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  // Deliberately NOT `@UseGuards(..., GalleryThrottlerGuard)`. This one
  // endpoint serves both ordinary page file attachments (PDFs, docx,
  // anything) and Gallery cover uploads, and a decorator can't tell them
  // apart — the "type" field only becomes known once the multipart body
  // has been read, inside the handler below. Applying the guard here
  // would throttle every plain file upload under a policy named
  // "gallery", not just covers. Instead, `checkGalleryLimit` is called
  // manually, only in the branch where the upload is actually a cover —
  // see GalleryThrottlerGuard for why. Every other Gallery-only route
  // below (list-images, gallery-settings, delete-image, rename-image)
  // keeps the standard declarative guard, since those never serve
  // anything but the Gallery.
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('files/upload')
  @UseInterceptors(FileInterceptor)
  async uploadFile(
    @Req() req: any,
    @Res() res: FastifyReply,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const maxFileSize = bytes(this.environmentService.getFileUploadSizeLimit());

    let file: any = null;
    let thumbnailFile: any = null;
    try {
      // req.files() (plural) rather than req.file(): this endpoint now
      // accepts an optional second, named file part ("thumbnail") in the
      // same request for covers, generated client-side. Every part not
      // named "thumbnail" is treated as the main file — same role `file`
      // always played before this change, so everything below this block
      // that reads from `file` is untouched.
      const parts = req.files({
        limits: { fileSize: maxFileSize, fields: 3, files: 2 },
      });
      for await (const part of parts) {
        if (part.fieldname === 'thumbnail') {
          thumbnailFile = part;
        } else {
          file = part;
        }
      }
    } catch (err: any) {
      this.logger.error(err.message);
      if (err?.statusCode === 413) {
        throw new BadRequestException(
          `File too large. Exceeds the ${this.environmentService.getFileUploadSizeLimit()} limit`,
        );
      }
    }

    if (!file) {
      throw new BadRequestException('Failed to upload file');
    }

    const pageId = file.fields?.pageId?.value;
    const attachmentTypeField = file.fields?.type?.value;
    const attachmentType =
      attachmentTypeField === AttachmentType.Cover
        ? AttachmentType.Cover
        : AttachmentType.File;

    if (attachmentType === AttachmentType.Cover) {
      // Manual, scoped throttle check — see the class-level comment above
      // and GalleryThrottlerGuard for the full rationale. Only reached
      // for cover uploads; plain file attachments never hit this.
      await this.galleryThrottlerGuard.checkGalleryLimit(req, workspace.id);
    }

    // The gallery only ever displays these in an <img>, and the client-side
    // accept="image/*" filter is trivially bypassed with a direct request,
    // so the extension is checked here too — reusing the same
    // validateFileType/validImageExtensions already used for avatars and
    // icons (attachment.utils.ts / attachment.constants.ts), rather than a
    // separate cover-specific list. Regular file attachments are
    // deliberately left unrestricted — accepting arbitrary files is an
    // existing product feature of that endpoint.
    if (attachmentType === AttachmentType.Cover) {
      const coverExtension = path.extname(file.filename ?? '').toLowerCase();
      try {
        validateFileType(coverExtension, validImageExtensions);
      } catch {
        throw new BadRequestException(
          `Invalid cover image type. Allowed: ${validImageExtensions.join(', ')}`,
        );
      }
    }

    let spaceId: string;

    if (pageId) {
      const page = await this.pageRepo.findById(pageId);

      if (!page) {
        throw new NotFoundException('Page not found');
      }

      await this.pageAccessService.validateCanEdit(page, user);
      spaceId = page.spaceId;
    } else {
      spaceId = file.fields?.spaceId?.value;

      if (!spaceId) {
        throw new BadRequestException('pageId or spaceId is required');
      }

      const spaceAbility = await this.spaceAbility.createForUser(user, spaceId);
      if (spaceAbility.cannot(SpaceCaslAction.Manage, SpaceCaslSubject.Page)) {
        throw new ForbiddenException();
      }
    }

    const attachmentId = file.fields?.attachmentId?.value;
    if (attachmentId && !isValidUUID(attachmentId)) {
      throw new BadRequestException('Invalid attachment id');
    }

    try {
      const fileResponse = await this.attachmentService.uploadFile({
        filePromise: file,
        thumbnailFilePromise: thumbnailFile,
        pageId: pageId,
        spaceId: spaceId,
        userId: user.id,
        workspaceId: workspace.id,
        attachmentId: attachmentId,
        type: attachmentType,
      });

      this.auditService.log({
        event: AuditEvent.ATTACHMENT_UPLOADED,
        resourceType: AuditResource.ATTACHMENT,
        resourceId: fileResponse?.id ?? attachmentId,
        spaceId,
        metadata: {
          fileName: fileResponse?.fileName,
          pageId,
          spaceId,
        },
      });

      return res.send(fileResponse);
    } catch (err: any) {
      if (err?.statusCode === 413) {
        const errMessage = `File too large. Exceeds the ${this.environmentService.getFileUploadSizeLimit()} limit`;
        this.logger.error(errMessage);
        throw new BadRequestException(errMessage);
      }
      this.logger.error(err);
      throw new BadRequestException('Error processing file upload.');
    }
  }

  @UseGuards(JwtAuthGuard)
  @Get('/files/:fileId/:fileName')
  async getFile(
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Param('fileId') fileId: string,
    @Param('fileName') fileName?: string,
    @Query('variant') variant?: string,
  ) {
    if (!isValidUUID(fileId)) {
      throw new NotFoundException('Invalid file id');
    }

    const attachment = await this.attachmentRepo.findById(fileId);
    if (!attachment || attachment.workspaceId !== workspace.id) {
      throw new NotFoundException();
    }

    if (attachment.aiChatId) {
      // Chat-owned attachment: only the user who uploaded (and therefore
      // owns the chat, per AttachmentRepo.claimAttachmentsForChat) can
      // read it back.
      if (attachment.creatorId !== user.id) {
        throw new NotFoundException();
      }
    } else {
      if (!attachment.spaceId) {
        throw new NotFoundException();
      }

      if (attachment.pageId) {
        const page = await this.pageRepo.findById(attachment.pageId);
        if (!page) {
          throw new NotFoundException();
        }

        await this.pageAccessService.validateCanView(page, user);
      } else {
        // Covers can be uploaded straight to the Gallery without ever
        // being attached to a specific page (pageId is optional for
        // AttachmentType.Cover) — fall back to a space-level Read check
        // in that case, same permission the Gallery list itself is
        // scoped by (AttachmentRepo.getWorkspaceImages).
        const spaceAbility = await this.spaceAbility.createForUser(
          user,
          attachment.spaceId,
        );
        if (spaceAbility.cannot(SpaceCaslAction.Read, SpaceCaslSubject.Page)) {
          throw new NotFoundException();
        }
      }
    }

    try {
      return await this.sendFileResponse(
        req,
        res,
        this.resolveVariant(attachment, variant),
        'private',
      );
    } catch (err) {
      this.logger.error(err);
      throw new NotFoundException('File not found');
    }
  }

  @Get('/files/public/:fileId/:fileName')
  async getPublicFile(
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
    @AuthWorkspace() workspace: Workspace,
    @Param('fileId') fileId: string,
    @Param('fileName') fileName?: string,
    @Query('jwt') jwtToken?: string,
  ) {
    let jwtPayload: JwtAttachmentPayload = null;
    try {
      jwtPayload = await this.tokenService.verifyJwt(
        jwtToken,
        JwtType.ATTACHMENT,
      );
    } catch (err) {
      throw new BadRequestException(
        'Expired or invalid attachment access token',
      );
    }

    if (
      !isValidUUID(fileId) ||
      fileId !== jwtPayload.attachmentId ||
      jwtPayload.workspaceId !== workspace.id
    ) {
      throw new NotFoundException('File not found');
    }

    const attachment = await this.attachmentRepo.findById(fileId);
    if (
      !attachment ||
      attachment.workspaceId !== workspace.id ||
      !attachment.pageId ||
      !attachment.spaceId ||
      jwtPayload.pageId !== attachment.pageId
    ) {
      throw new NotFoundException('File not found');
    }

    try {
      return await this.sendFileResponse(req, res, attachment, 'public');
    } catch (err) {
      this.logger.error(err);
      throw new NotFoundException('File not found');
    }
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('attachments/upload-image')
  @UseInterceptors(FileInterceptor)
  async uploadAvatarOrLogo(
    @Req() req: any,
    @Res() res: FastifyReply,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const maxFileSize = bytes(MAX_AVATAR_SIZE);

    let file = null;
    try {
      file = await req.file({
        limits: { fileSize: maxFileSize, fields: 3, files: 1 },
      });
    } catch (err: any) {
      if (err?.statusCode === 413) {
        throw new BadRequestException(
          `File too large. Exceeds the ${MAX_AVATAR_SIZE} limit`,
        );
      }
    }

    if (!file) {
      throw new BadRequestException('Invalid file upload');
    }

    const attachmentType = file.fields?.type?.value;
    const spaceId = file.fields?.spaceId?.value;

    if (!attachmentType) {
      throw new BadRequestException('attachment type is required');
    }

    if (
      !validAttachmentTypes.includes(attachmentType) ||
      attachmentType === AttachmentType.File ||
      attachmentType === AttachmentType.Cover
    ) {
      throw new BadRequestException('Invalid image attachment type');
    }

    if (attachmentType === AttachmentType.WorkspaceIcon) {
      const ability = this.workspaceAbility.createForUser(user, workspace);
      if (
        ability.cannot(
          WorkspaceCaslAction.Manage,
          WorkspaceCaslSubject.Settings,
        )
      ) {
        throw new ForbiddenException();
      }
    }

    if (attachmentType === AttachmentType.SpaceIcon) {
      if (!spaceId) {
        throw new BadRequestException('spaceId is required');
      }

      const spaceAbility = await this.spaceAbility.createForUser(user, spaceId);
      if (
        spaceAbility.cannot(SpaceCaslAction.Manage, SpaceCaslSubject.Settings)
      ) {
        throw new ForbiddenException();
      }
    }

    try {
      const fileResponse = await this.attachmentService.uploadImage(
        file,
        attachmentType,
        user.id,
        workspace.id,
        spaceId,
      );

      return res.send(fileResponse);
    } catch (err: any) {
      this.logger.error(err);
      throw new BadRequestException('Error processing file upload.');
    }
  }

  @Get('attachments/img/:attachmentType/:fileName')
  async getLogoOrAvatar(
    @Res() res: FastifyReply,
    @AuthWorkspace() workspace: Workspace,
    @Param('attachmentType') attachmentType: AttachmentType,
    @Param('fileName') fileName?: string,
  ) {
    if (
      !validAttachmentTypes.includes(attachmentType) ||
      attachmentType === AttachmentType.File ||
      attachmentType === AttachmentType.Cover
    ) {
      throw new BadRequestException('Invalid image attachment type');
    }

    if (!fileName) {
      throw new BadRequestException('Invalid file name');
    }

    const ext = path.extname(fileName);
    const filenameWithoutExt = path.basename(fileName, ext);

    if (
      !ext ||
      !isValidUUID(filenameWithoutExt) ||
      `${filenameWithoutExt}${ext}` !== fileName
    ) {
      throw new BadRequestException('Invalid file name');
    }

    const filePath = `${getAttachmentFolderPath(attachmentType, workspace.id)}/${fileName}`;

    try {
      const fileStream = await this.storageService.readStream(filePath);
      res.headers({
        'Content-Type': getMimeType(filePath),
        'Cache-Control': 'private, max-age=86400',
      });
      return res.send(fileStream);
    } catch (err) {
      // this.logger.error(err);
      throw new NotFoundException('File not found');
    }
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('files/info')
  async getAttachmentInfo(
    @Body() dto: AttachmentInfoDto,
    @AuthWorkspace() workspace: Workspace,
    @AuthUser() user: User,
  ) {
    const attachment = await this.attachmentRepo.findById(dto.attachmentId);
    if (
      !attachment ||
      !attachment.pageId ||
      attachment.workspaceId !== workspace.id ||
      attachment.type !== AttachmentType.File
    ) {
      throw new NotFoundException('File not found');
    }

    const page = await this.pageRepo.findById(attachment.pageId);
    if (!page) {
      throw new NotFoundException('File not found');
    }

    await this.pageAccessService.validateCanView(page, user);

    return attachment;
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('attachments/remove-icon')
  async removeIcon(
    @Body() dto: RemoveIconDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const { type, spaceId } = dto;

    // remove current user avatar
    if (type === AttachmentType.Avatar) {
      await this.attachmentService.removeUserAvatar(user);
      return;
    }

    // remove space icon
    if (type === AttachmentType.SpaceIcon) {
      if (!spaceId) {
        throw new BadRequestException(
          'spaceId is required to change space icons',
        );
      }

      const spaceAbility = await this.spaceAbility.createForUser(user, spaceId);
      if (
        spaceAbility.cannot(SpaceCaslAction.Manage, SpaceCaslSubject.Settings)
      ) {
        throw new ForbiddenException();
      }

      await this.attachmentService.removeSpaceIcon(spaceId, workspace.id);
      return;
    }

    // remove workspace icon
    if (type === AttachmentType.WorkspaceIcon) {
      const ability = this.workspaceAbility.createForUser(user, workspace);
      if (
        ability.cannot(
          WorkspaceCaslAction.Manage,
          WorkspaceCaslSubject.Settings,
        )
      ) {
        throw new ForbiddenException();
      }
      await this.attachmentService.removeWorkspaceIcon(workspace);
      return;
    }
  }

  // Every route below serves the shared Gallery only, never a mix of
  // Gallery + unrelated traffic — unlike files/upload above, applying the
  // guard declaratively here is unambiguous and correct.
  @UseGuards(JwtAuthGuard, GalleryThrottlerGuard)
  @SkipThrottle({ [AUTH_THROTTLER]: true, [AI_CHAT_THROTTLER]: true })
  @HttpCode(HttpStatus.OK)
  @Post('attachments/list-images')
  async listImages(
    @Body() dto: ListGalleryImagesDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.attachmentRepo.getWorkspaceImages(user.id, workspace.id, dto);
  }

  @UseGuards(JwtAuthGuard, GalleryThrottlerGuard)
  @SkipThrottle({ [AUTH_THROTTLER]: true, [AI_CHAT_THROTTLER]: true })
  @HttpCode(HttpStatus.OK)
  @Post('attachments/gallery-settings')
  async getGallerySettings(@AuthWorkspace() workspace: Workspace) {
    // Read-only, open to any authenticated workspace member — matches the
    // gallery itself being visible to everyone; only *changing* these
    // values requires Manage/Settings, below.
    return this.attachmentService.getGallerySettings(workspace.id);
  }

  @UseGuards(JwtAuthGuard, GalleryThrottlerGuard)
  @SkipThrottle({ [AUTH_THROTTLER]: true, [AI_CHAT_THROTTLER]: true })
  @HttpCode(HttpStatus.OK)
  @Post('attachments/update-gallery-settings')
  async updateGallerySettings(
    @Body() dto: UpdateGallerySettingsDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (
      ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Settings)
    ) {
      throw new ForbiddenException();
    }

    return this.attachmentService.updateGallerySettings(workspace.id, dto);
  }

  // Shared by deleteImage and renameImage: every space that would be
  // affected by a change to this attachment, not just the one it happened
  // to be uploaded through. deleteImage clears coverPhoto workspace-wide
  // (attachment.service.ts) and renameImage changes the name shown for
  // this cover everywhere it's used — a check scoped only to
  // attachment.spaceId would let a user with edit rights in ONE space
  // affect pages in OTHER spaces they may have no access to at all.
  private async assertCanManageGalleryImage(
    user: User,
    workspace: Workspace,
    attachment: Attachment,
  ): Promise<void> {
    const affectedSpaceIds = new Set([
      attachment.spaceId,
      ...(await this.attachmentRepo.getSpaceIdsUsingAttachment(
        attachment.id,
        workspace.id,
      )),
    ]);

    for (const spaceId of affectedSpaceIds) {
      if (!spaceId) continue;
      const spaceAbility = await this.spaceAbility.createForUser(
        user,
        spaceId,
      );
      if (spaceAbility.cannot(SpaceCaslAction.Manage, SpaceCaslSubject.Page)) {
        // Deliberately the same generic ForbiddenException regardless of
        // which space blocked the request — never reveal to the caller
        // that a space they can't see exists.
        throw new ForbiddenException();
      }
    }
  }

  @UseGuards(JwtAuthGuard, GalleryThrottlerGuard)
  @SkipThrottle({ [AUTH_THROTTLER]: true, [AI_CHAT_THROTTLER]: true })
  @HttpCode(HttpStatus.OK)
  @Post('attachments/delete-image')
  async deleteImage(
    @Body() dto: DeleteImageDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const attachment = await this.attachmentRepo.findById(dto.attachmentId);
    if (
      !attachment ||
      attachment.workspaceId !== workspace.id ||
      attachment.type !== AttachmentType.Cover
    ) {
      throw new NotFoundException('File not found');
    }

    const gallerySettings = await this.attachmentService.getGallerySettings(
      workspace.id,
    );

    if (gallerySettings.restrictDeleteToOwners) {
      // Strict workspace OWNER only — deliberately not isAdmin/ADMIN,
      // this is a stricter opt-in policy layered on top of the
      // always-on cross-space check below, not a replacement for it.
      if (user.role !== UserRole.OWNER) {
        throw new ForbiddenException();
      }
    } else {
      await this.assertCanManageGalleryImage(user, workspace, attachment);
    }

    await this.attachmentService.deleteImage(dto.attachmentId, workspace.id);

    this.auditService.log({
      event: AuditEvent.ATTACHMENT_DELETED,
      resourceType: AuditResource.ATTACHMENT,
      resourceId: dto.attachmentId,
      spaceId: attachment.spaceId,
      metadata: {
        fileName: attachment.fileName,
      },
    });
  }

  @UseGuards(JwtAuthGuard, GalleryThrottlerGuard)
  @SkipThrottle({ [AUTH_THROTTLER]: true, [AI_CHAT_THROTTLER]: true })
  @HttpCode(HttpStatus.OK)
  @Post('attachments/rename-image')
  async renameImage(
    @Body() dto: RenameImageDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const attachment = await this.attachmentRepo.findById(dto.attachmentId);
    if (
      !attachment ||
      attachment.workspaceId !== workspace.id ||
      attachment.type !== AttachmentType.Cover
    ) {
      throw new NotFoundException('File not found');
    }

    // Same cross-space check deleteImage uses (see
    // assertCanManageGalleryImage above) — previously this only checked
    // attachment.spaceId (the upload's original space), which let a user
    // with Manage/Page in that one space rename a cover actually in use
    // as a page cover in a different space they have no rights in.
    await this.assertCanManageGalleryImage(user, workspace, attachment);

    // dto.fileName is a display name only (no extension — see
    // gallery-image.dto.ts and gallery-modal.tsx, which strips the
    // extension before showing the rename field). The attachment's
    // original extension is re-appended here so the stored fileName stays
    // a complete, valid filename: Content-Disposition downloads, Draw.io/
    // Excalidraw file matching, search, and everything else that reads
    // attachment.fileName still gets one with an extension, exactly like
    // every other attachment type.
    const trimmedName = sanitizeFileName(dto.fileName).trim();
    if (!trimmedName) {
      throw new BadRequestException('File name is required');
    }

    const newFileName = `${trimmedName}${attachment.fileExt}`;
    const previousName = attachment.fileName;
    const updated = await this.attachmentRepo.updateAttachment(
      { fileName: newFileName },
      dto.attachmentId,
    );

    this.auditService.log({
      event: AuditEvent.ATTACHMENT_RENAMED,
      resourceType: AuditResource.ATTACHMENT,
      resourceId: dto.attachmentId,
      spaceId: attachment.spaceId,
      changes: {
        before: { fileName: previousName },
        after: { fileName: newFileName },
      },
    });

    return updated;
  }

  // Thumbnails are always canvas-generated JPEGs client-side regardless of
  // the original format, so mimeType/fileExt are overridden here rather
  // than reused from the original attachment — otherwise a PNG cover's
  // JPEG thumbnail would be served with an incorrect Content-Type.
  private resolveVariant(attachment: Attachment, variant?: string): Attachment {
    if (variant !== 'thumbnail' || !attachment.thumbnailPath) {
      return attachment;
    }

    return {
      ...attachment,
      filePath: attachment.thumbnailPath,
      fileSize: attachment.thumbnailSize,
      mimeType: 'image/jpeg',
      fileExt: '.jpg',
    };
  }

  private async sendFileResponse(
    req: FastifyRequest,
    res: FastifyReply,
    attachment: Attachment,
    cacheScope: 'private' | 'public',
  ) {
    const fileSize = Number(attachment.fileSize);
    const rangeHeader = req.headers.range;

    res.header('Accept-Ranges', 'bytes');
    res.header(
      'Content-Security-Policy',
      "base-uri 'none'; object-src 'self'; default-src 'self';",
    );

    if (!inlineFileExtensions.includes(attachment.fileExt)) {
      res.header(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(attachment.fileName)}"`,
      );
    }

    if (rangeHeader && fileSize) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        const start = parseInt(match[1], 10);
        const end = match[2]
          ? Math.min(parseInt(match[2], 10), fileSize - 1)
          : fileSize - 1;

        if (start >= fileSize || start > end) {
          res.status(416);
          res.header('Content-Range', `bytes */${fileSize}`);
          return res.send();
        }

        const fileStream = await this.storageService.readRangeStream(
          attachment.filePath,
          { start, end },
        );

        res.status(206);
        res.headers({
          'Content-Type': attachment.mimeType,
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Content-Length': end - start + 1,
          'Cache-Control': `${cacheScope}, max-age=3600`,
        });

        return res.send(fileStream);
      }
    }

    const fileStream = await this.storageService.readStream(
      attachment.filePath,
    );

    res.headers({
      'Content-Type': attachment.mimeType,
      'Cache-Control': `${cacheScope}, max-age=3600`,
    });

    const isSvg = attachment.fileExt === '.svg';
    if (fileSize && !isSvg) {
      res.header('Content-Length', fileSize);
    }

    return res.send(fileStream);
  }
}
