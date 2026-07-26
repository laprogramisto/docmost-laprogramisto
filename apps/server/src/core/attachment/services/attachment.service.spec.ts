import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../../../app.module';
import { AttachmentService } from './attachment.service';
import { AttachmentRepo } from '@docmost/db/repos/attachment/attachment.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { SpaceRepo } from '@docmost/db/repos/space/space.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { StorageService } from '../../../integrations/storage/storage.service';
import { FileTaskProcessor } from '../../../integrations/import/processors/file-task.processor';
import { EmailProcessor } from '../../../integrations/mail/processors/email.processor';
import { GeneralQueueProcessor } from '../../../integrations/queue/processors/general-queue.processor';
import { HistoryProcessor } from '../../../collaboration/processors/history.processor';
import { NotificationProcessor } from '../../notification/notification.processor';
import { AttachmentProcessor } from '../processors/attachment.processor';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { AttachmentType } from '../attachment.constants';
import { Kysely, CamelCasePlugin } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import { normalizePostgresUrl } from '../../../common/helpers';
import { v7 as uuid7 } from 'uuid';

describe('AttachmentService - deleteImage (cover cleanup)', () => {
  let module: TestingModule;
  let attachmentService: AttachmentService;
  let attachmentRepo: AttachmentRepo;
  let pageRepo: PageRepo;
  let userRepo: UserRepo;
  let workspaceRepo: WorkspaceRepo;
  let spaceRepo: SpaceRepo;
  let spaceMemberRepo: SpaceMemberRepo;
  // Standalone Kysely connection used only for test setup/teardown
  // (nestjs-kysely does not expose its internal DI token publicly).
  let db: Kysely<any>;

  let workspaceId: string;
  let userId: string;
  let spaceId: string;
  const pageIds: string[] = [];
  const attachmentIds: string[] = [];

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [AppModule],
    })
      // Never touch real disk/S3 storage from a test run.
      .overrideProvider(StorageService)
      .useValue({ delete: jest.fn().mockResolvedValue(undefined) })
      // Six processors extend BullMQ's WorkerHost across the app; none of
      // their workers get a chance to fully initialize in this short-lived
      // test module, which makes their own onModuleDestroy throw during
      // teardown. None of them relate to attachments/covers, so they're
      // all stubbed out here.
      .overrideProvider(FileTaskProcessor)
      .useValue({ onModuleDestroy: async () => {} })
      .overrideProvider(EmailProcessor)
      .useValue({ onModuleDestroy: async () => {} })
      .overrideProvider(GeneralQueueProcessor)
      .useValue({ onModuleDestroy: async () => {} })
      .overrideProvider(HistoryProcessor)
      .useValue({ onModuleDestroy: async () => {} })
      .overrideProvider(NotificationProcessor)
      .useValue({ onModuleDestroy: async () => {} })
      .overrideProvider(AttachmentProcessor)
      .useValue({ onModuleDestroy: async () => {} })
      .compile();

    attachmentService = module.get(AttachmentService);
    attachmentRepo = module.get(AttachmentRepo);
    pageRepo = module.get(PageRepo);
    userRepo = module.get(UserRepo);
    workspaceRepo = module.get(WorkspaceRepo);
    spaceRepo = module.get(SpaceRepo);
    spaceMemberRepo = module.get(SpaceMemberRepo);

    const environmentService = module.get(EnvironmentService);
    db = new Kysely<any>({
      dialect: new PostgresJSDialect({
        postgres: postgres(normalizePostgresUrl(environmentService.getDatabaseURL())),
      }),
      plugins: [new CamelCasePlugin()],
    });
  });

  afterAll(async () => {
    await db.destroy();
    await module.close();
  });

  beforeEach(async () => {
    const workspace = await workspaceRepo.insertWorkspace({
      name: `test-ws-${uuid7()}`,
      hostname: `test-${uuid7()}`,
    } as any);
    workspaceId = workspace.id;

    const user = await userRepo.insertUser({
      email: `cover-test-${uuid7()}@example.com`,
      password: 'password123',
      name: 'Cover Test User',
      workspaceId,
    } as any);
    userId = user.id;

    const space = await spaceRepo.insertSpace({
      name: `test-space-${uuid7()}`,
      slug: `test-space-${uuid7()}`,
      workspaceId,
      creatorId: userId,
    } as any);
    spaceId = space.id;

    await spaceMemberRepo.insertSpaceMember({
      userId,
      spaceId,
      role: 'writer',
    } as any);
  });

  afterEach(async () => {
    if (attachmentIds.length) {
      await db
        .deleteFrom('attachments')
        .where('id', 'in', attachmentIds)
        .execute();
      attachmentIds.length = 0;
    }
    if (pageIds.length) {
      await db.deleteFrom('pages').where('id', 'in', pageIds).execute();
      pageIds.length = 0;
    }
    await db.deleteFrom('spaceMembers').where('spaceId', '=', spaceId).execute();
    await db.deleteFrom('spaces').where('id', '=', spaceId).execute();
    await db.deleteFrom('users').where('id', '=', userId).execute();
    await db.deleteFrom('workspaces').where('id', '=', workspaceId).execute();
  });

  async function createPage(coverPhoto: string | null) {
    const page = await pageRepo.insertPage({
      slugId: uuid7(),
      title: 'Test page',
      position: 'a0',
      spaceId,
      workspaceId,
      creatorId: userId,
      lastUpdatedById: userId,
      coverPhoto,
    } as any);
    pageIds.push(page.id);
    return page;
  }

  async function createCoverAttachment(fileName = 'test-cover.jpg') {
    const attachment = await attachmentRepo.insertAttachment({
      fileName,
      filePath: `test/${uuid7()}/${fileName}`,
      fileExt: '.jpg',
      mimeType: 'image/jpeg',
      type: AttachmentType.Cover,
      creatorId: userId,
      workspaceId,
      spaceId,
    } as any);
    attachmentIds.push(attachment.id);
    return attachment;
  }

  it('clears coverPhoto on every page that referenced the deleted attachment', async () => {
    const attachment = await createCoverAttachment();
    const coverUrl = `/api/files/${attachment.id}/${attachment.fileName}`;

    const pageA = await createPage(coverUrl);
    const pageB = await createPage(coverUrl);

    await attachmentService.deleteImage(attachment.id, workspaceId);

    const refreshedA = await pageRepo.findById(pageA.id);
    const refreshedB = await pageRepo.findById(pageB.id);

    expect(refreshedA.coverPhoto).toBeNull();
    expect(refreshedB.coverPhoto).toBeNull();

    const found = await attachmentRepo.findById(attachment.id);
    expect(found).toBeUndefined();

    attachmentIds.length = 0;
  });

  it('does not touch a page that never referenced the deleted attachment', async () => {
    const targetAttachment = await createCoverAttachment('target.jpg');
    const unrelatedAttachment = await createCoverAttachment('unrelated.jpg');

    const targetUrl = `/api/files/${targetAttachment.id}/${targetAttachment.fileName}`;
    const unrelatedUrl = `/api/files/${unrelatedAttachment.id}/${unrelatedAttachment.fileName}`;

    const untouchedPage = await createPage(unrelatedUrl);

    await attachmentService.deleteImage(targetAttachment.id, workspaceId);

    const refreshed = await pageRepo.findById(untouchedPage.id);
    expect(refreshed.coverPhoto).toBe(unrelatedUrl);

    attachmentIds.splice(attachmentIds.indexOf(targetAttachment.id), 1);
  });

  it('throws when the attachment belongs to a different workspace', async () => {
    const otherWorkspace = await workspaceRepo.insertWorkspace({
      name: `other-ws-${uuid7()}`,
      hostname: `other-${uuid7()}`,
    } as any);

    const attachment = await attachmentRepo.insertAttachment({
      fileName: 'foreign.jpg',
      filePath: `test/${uuid7()}/foreign.jpg`,
      fileExt: '.jpg',
      mimeType: 'image/jpeg',
      type: AttachmentType.Cover,
      creatorId: userId,
      workspaceId: otherWorkspace.id,
      spaceId,
    } as any);

    await expect(
      attachmentService.deleteImage(attachment.id, workspaceId),
    ).rejects.toThrow();

    await db.deleteFrom('attachments').where('id', '=', attachment.id).execute();
    await db.deleteFrom('workspaces').where('id', '=', otherWorkspace.id).execute();
  });
});
