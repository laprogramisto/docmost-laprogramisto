import { Inject, Injectable } from '@nestjs/common';
import {
  ThrottlerException,
  ThrottlerRequest,
  ThrottlerStorage,
} from '@nestjs/throttler';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { UserThrottlerGuard } from './user-throttler.guard';
import { GALLERY_THROTTLER } from './throttler-names';

// Extends UserThrottlerGuard (not ThrottlerGuard directly) so the per-user
// tracking key it already defines is inherited for free — this guard only
// adds one thing on top: a per-workspace override of the "gallery"
// throttler's limit, read from workspace.settings.gallery.rateLimitPerMinute
// (see AttachmentService.getGallerySettings/updateGallerySettings).
//
// Two ways this gets used:
//
// 1. `@UseGuards(JwtAuthGuard, GalleryThrottlerGuard)` on routes that are
//    unambiguously gallery-only (list-images, delete-image, rename-image,
//    gallery-settings) — standard NestJS guard usage, same pattern as
//    UserThrottlerGuard/AUTH_THROTTLER on AuthController. handleRequest()
//    below is what NestJS calls for this path.
//
// 2. `checkGalleryLimit(req, workspaceId)` called directly from inside
//    AttachmentController.uploadFile, only in the branch where
//    `type === AttachmentType.Cover`. That endpoint (files/upload) also
//    serves ordinary file attachments that have nothing to do with the
//    Gallery, so it deliberately does NOT carry
//    `@UseGuards(GalleryThrottlerGuard)` — every request there would
//    otherwise be throttled under a policy named "gallery", including
//    plain PDF/docx uploads. A decorator can't conditionally apply itself
//    based on multipart form-data read at runtime, so the check is done
//    imperatively instead, using only the public, documented
//    ThrottlerStorage API (increment) rather than fabricating an
//    ExecutionContext/ThrottlerRequest by hand to call canActivate().
@Injectable()
export class GalleryThrottlerGuard extends UserThrottlerGuard {
  @Inject(WorkspaceRepo)
  private readonly workspaceRepo: WorkspaceRepo;

  @Inject(ThrottlerStorage)
  private readonly throttlerStorage: ThrottlerStorage;

  private static readonly DEFAULT_LIMIT = 150;
  private static readonly TTL_MS = 60_000;

  async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    if (requestProps.throttler.name !== GALLERY_THROTTLER) {
      return super.handleRequest(requestProps);
    }

    let limit = requestProps.limit;

    // Assumption: the request carries a `workspace` property populated by
    // an upstream guard, the same way @AuthWorkspace() resolves it for
    // controller handlers. If that assumption is wrong for this codebase,
    // this simply falls back to the static configured limit (150/min) —
    // it fails safe, never open, if workspaceId can't be read.
    const req = requestProps.context.switchToHttp().getRequest();
    const workspaceId = req?.workspace?.id;
    const configuredLimit = await this.getConfiguredLimit(workspaceId);

    if (configuredLimit) {
      limit = configuredLimit;
    }

    return super.handleRequest({ ...requestProps, limit });
  }

  private async getConfiguredLimit(
    workspaceId: string | undefined,
  ): Promise<number | null> {
    if (!workspaceId) return null;

    const workspace = await this.workspaceRepo.findById(workspaceId);
    const configuredLimit = (workspace?.settings as Record<string, any>)
      ?.gallery?.rateLimitPerMinute;

    return typeof configuredLimit === 'number' && configuredLimit > 0
      ? configuredLimit
      : null;
  }

  // Imperative counterpart to handleRequest() above, for files/upload's
  // Cover branch. Tracks per-user (same key shape UserThrottlerGuard
  // already uses: "user:<id>"), against the same GALLERY_THROTTLER bucket
  // and Redis storage the declarative path uses, so a user can't get a
  // separate allowance by going through one path vs the other.
  async checkGalleryLimit(
    req: { user?: { id?: string } },
    workspaceId: string,
  ): Promise<void> {
    const limit =
      (await this.getConfiguredLimit(workspaceId)) ??
      GalleryThrottlerGuard.DEFAULT_LIMIT;

    const userId = req.user?.id;
    const key = userId ? `user:${userId}` : 'anonymous';
    const throttlerKey = `${GALLERY_THROTTLER}:${key}`;

    const { totalHits, isBlocked } = await this.throttlerStorage.increment(
      throttlerKey,
      GalleryThrottlerGuard.TTL_MS,
      limit,
      0,
      GALLERY_THROTTLER,
    );

    if (isBlocked || totalHits > limit) {
      throw new ThrottlerException('Too many requests');
    }
  }
}
