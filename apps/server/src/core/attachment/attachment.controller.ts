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
import {
  DeleteImageDto,
  RenameImageDto,
} from './dto/gallery-image.dto';
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
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { SkipThrottle } from '@nestjs/throttler';
import {
  AUTH_THROTTLER,
  AI_CHAT_THROTTLER,
} from '../../integrations/throttle/throttler-names';
import { UserThrottlerGuard } from '../../integrations/throttle/user-throttler.guard';

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
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  @UseGuards(JwtAuthGuard, UserThrottlerGuard)
  @SkipThrottle({ [AUTH_THROTTLER]: true, [AI_CHAT_THROTTLER]: true })
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

    let file = null;
    try {
      file = await req.file({
        limits: { fileSize: maxFileSize, fields: 3, files: 1 },
      });
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
      return await this.sendFileResponse(req, res, attachment, 'private');
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
      attachmentType === AttachmentType.File
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
      attachmentType === AttachmentType.File
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

  @UseGuards(JwtAuthGuard, UserThrottlerGuard)
  @SkipThrottle({ [AUTH_THROTTLER]: true, [AI_CHAT_THROTTLER]: true })
  @HttpCode(HttpStatus.OK)
  @Post('attachments/list-images')
  async listImages(
    @Body() pagination: PaginationOptions,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.attachmentRepo.getWorkspaceImages(
      user.id,
      workspace.id,
      pagination,
    );
  }

  @UseGuards(JwtAuthGuard, UserThrottlerGuard)
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

    const spaceAbility = await this.spaceAbility.createForUser(user, attachment.spaceId);
    if (spaceAbility.cannot(SpaceCaslAction.Manage, SpaceCaslSubject.Page)) {
      throw new ForbiddenException();
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

  @UseGuards(JwtAuthGuard, UserThrottlerGuard)
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

    const spaceAbility = await this.spaceAbility.createForUser(user, attachment.spaceId);
    if (spaceAbility.cannot(SpaceCaslAction.Manage, SpaceCaslSubject.Page)) {
      throw new ForbiddenException();
    }

    // Renames go through the same sanitization as uploads
    // (attachment.utils.ts) so a cover's stored fileName follows one set of
    // rules whichever path produced it. Length is capped by the DTO.
    const trimmedName = sanitizeFileName(dto.fileName).trim();
    if (!trimmedName) {
      throw new BadRequestException('File name is required');
    }

    const previousName = attachment.fileName;
    const updated = await this.attachmentRepo.updateAttachment(
      { fileName: trimmedName },
      dto.attachmentId,
    );

    this.auditService.log({
      event: AuditEvent.ATTACHMENT_RENAMED,
      resourceType: AuditResource.ATTACHMENT,
      resourceId: dto.attachmentId,
      spaceId: attachment.spaceId,
      changes: {
        before: { fileName: previousName },
        after: { fileName: trimmedName },
      },
    });

    return updated;
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
