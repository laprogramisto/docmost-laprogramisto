import { Module } from '@nestjs/common';
import { AttachmentService } from './services/attachment.service';
import { AttachmentController } from './attachment.controller';
import { StorageModule } from '../../integrations/storage/storage.module';
import { UserModule } from '../user/user.module';
import { WorkspaceModule } from '../workspace/workspace.module';
import { AttachmentProcessor } from './processors/attachment.processor';
import { TokenModule } from '../auth/token.module';
import { GalleryThrottlerGuard } from '../../integrations/throttle/gallery-throttler.guard';

@Module({
  imports: [StorageModule, UserModule, WorkspaceModule, TokenModule],
  controllers: [AttachmentController],
  // GalleryThrottlerGuard is both a declarative @UseGuards target (the
  // Gallery-only routes below files/upload) and injected directly into
  // AttachmentController's constructor (for the manual checkGalleryLimit
  // call on files/upload's Cover branch) — either use requires it to be a
  // registered provider here. ThrottlerStorage/ThrottlerModuleOptions are
  // available to it globally via ThrottleModule (mounted once in
  // app.module.ts), the same way ThrottlerGuard already works in
  // auth.module.ts without AuthModule importing ThrottleModule itself.
  providers: [AttachmentService, AttachmentProcessor, GalleryThrottlerGuard],
})
export class AttachmentModule {}
