import { Inject, Injectable } from '@nestjs/common';
import { ThrottlerRequest } from '@nestjs/throttler';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { UserThrottlerGuard } from './user-throttler.guard';
import { GALLERY_THROTTLER } from './throttler-names';

// Extends UserThrottlerGuard (not ThrottlerGuard directly) so the per-user
// tracking key it already defines is inherited for free — this guard only
// adds one thing on top: a per-workspace override of the "gallery"
// throttler's limit, read from workspace.settings.gallery.rateLimitPerMinute
// (see AttachmentService.getGallerySettings/updateGallerySettings).
//
// Property injection (@Inject on a class field) is used instead of
// constructor injection deliberately: ThrottlerGuard's own constructor
// signature isn't something this codebase exposes anywhere, and property
// injection lets Nest resolve WorkspaceRepo without needing to know or
// replicate that signature via a custom super() call.
//
// Every throttler other than "gallery" (auth, ai-chat) is untouched —
// handleRequest defers straight to the base implementation for those,
// so nothing about their behavior changes.
@Injectable()
export class GalleryThrottlerGuard extends UserThrottlerGuard {
  @Inject(WorkspaceRepo)
  private readonly workspaceRepo: WorkspaceRepo;

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

    if (workspaceId) {
      const workspace = await this.workspaceRepo.findById(workspaceId);
      const configuredLimit = (workspace?.settings as Record<string, any>)
        ?.gallery?.rateLimitPerMinute;

      if (typeof configuredLimit === 'number' && configuredLimit > 0) {
        limit = configuredLimit;
      }
    }

    return super.handleRequest({ ...requestProps, limit });
  }
}
