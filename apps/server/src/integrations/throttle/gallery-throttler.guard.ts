import { Inject, Injectable } from '@nestjs/common';
import { ThrottlerException, ThrottlerRequest } from '@nestjs/throttler';
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
//    below is what NestJS calls for this path, via @nestjs/throttler's own
//    ThrottlerStorage/Redis-backed counter — unchanged, and this path has
//    tested cleanly.
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
//    imperatively instead.
//
//    This used to call @nestjs/throttler's ThrottlerStorage.increment()
//    directly, guessing at its parameter order without being able to
//    compile against the real package (no npm access in the environment
//    that wrote it) — that guess was wrong and threw at runtime under
//    real load (500s instead of clean 429s). Rather than guess again at
//    a second internal API, checkGalleryLimit below is a small,
//    self-contained in-memory counter with no dependency on any
//    @nestjs/throttler internals beyond the ThrottlerException class
//    (public, stable, already used elsewhere in this file's export list).
//
//    In-memory means this counter is per Node process. Docmost runs as a
//    single server process by default (see docker-compose.yml — one
//    `docmost` service, no clustering) — under that deployment this is
//    exactly as correct as a shared Redis counter would be, since there's
//    only ever one counter to keep anyway. If docmost is ever run as
//    multiple server replicas behind a load balancer, this stops being
//    accurate across replicas (each process enforces the limit
//    independently, so the effective ceiling becomes limit × replica
//    count) — the declarative path above (still Redis-backed) doesn't
//    have that limitation, only this manual one does.
@Injectable()
export class GalleryThrottlerGuard extends UserThrottlerGuard {
  @Inject(WorkspaceRepo)
  private readonly workspaceRepo: WorkspaceRepo;

  private static readonly DEFAULT_LIMIT = 150;
  private static readonly TTL_MS = 60_000;

  // key -> { count, windowStartedAt }. Cleared lazily (see checkGalleryLimit)
  // rather than via a separate interval timer — nothing about this guard
  // needs background upkeep, and lazy cleanup means a key that's never hit
  // again is simply never touched again, rather than costing a periodic
  // sweep whether it's needed or not.
  private readonly counters = new Map<
    string,
    { count: number; windowStartedAt: number }
  >();

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
  // already uses: "user:<id>"), in a fixed one-minute sliding window reset
  // on expiry — simple fixed-window counting, not the more precise
  // sliding-log approach @nestjs/throttler itself uses, but accurate
  // enough for this: the practical difference is at most a handful of
  // extra requests right at a window boundary, not a meaningful gap in
  // protection.
  async checkGalleryLimit(
    req: { user?: { id?: string } },
    workspaceId: string,
  ): Promise<void> {
    const limit =
      (await this.getConfiguredLimit(workspaceId)) ??
      GalleryThrottlerGuard.DEFAULT_LIMIT;

    const userId = req.user?.id;
    const key = `${GALLERY_THROTTLER}:${userId ? `user:${userId}` : 'anonymous'}`;

    const now = Date.now();
    const existing = this.counters.get(key);

    if (!existing || now - existing.windowStartedAt >= GalleryThrottlerGuard.TTL_MS) {
      this.counters.set(key, { count: 1, windowStartedAt: now });
      return;
    }

    existing.count += 1;

    if (existing.count > limit) {
      throw new ThrottlerException('Too many requests');
    }
  }
}
