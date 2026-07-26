import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../../../app.module';
import { AttachmentRepo } from './attachment.repo';
import { UserRepo } from '../user/user.repo';
import { WorkspaceRepo } from '../workspace/workspace.repo';
import { SpaceRepo } from '../space/space.repo';
import { SpaceMemberRepo } from '../space/space-member.repo';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { FileTaskProcessor } from '../../../integrations/import/processors/file-task.processor';
import { EmailProcessor } from '../../../integrations/mail/processors/email.processor';
import { GeneralQueueProcessor } from '../../../integrations/queue/processors/general-queue.processor';
import { HistoryProcessor } from '../../../collaboration/processors/history.processor';
import { NotificationProcessor } from '../../../core/notification/notification.processor';
import { AttachmentProcessor } from '../../../core/attachment/processors/attachment.processor';
import { AttachmentType } from '../../../core/attachment/attachment.constants';
import { Kysely, CamelCasePlugin } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import { normalizePostgresUrl } from '../../../common/helpers';
import { v7 as uuid7 } from 'uuid';

describe('AttachmentRepo - getWorkspaceImages (space scoping)', () => {
  let module: TestingModule;
  let attachmentRepo: AttachmentRepo;
  let userRepo: UserRepo;
  let workspaceRepo: WorkspaceRepo;
  let spaceRepo: SpaceRepo;
  let spaceMemberRepo: SpaceMemberRepo;
  // Standalone Kysely connection used only for test setup/teardown
  // (nestjs-kysely does not expose its internal DI token publicly).
  let db: Kysely<any>;

  let workspaceId: string;
  let userId: string;
  let memberSpaceId: string;
  let outsiderSpaceId: string;
  const attachmentIds: string[] = [];

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [AppModule],
    })
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

    attachmentRepo = module.get(AttachmentRepo);
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
      email: `gallery-test-${uuid7()}@example.com`,
      password: 'password123',
      name: 'Gallery Test User',
      workspaceId,
    } as any);
    userId = user.id;

    const memberSpace = await spaceRepo.insertSpace({
      name: `member-space-${uuid7()}`,
      slug: `member-space-${uuid7()}`,
      workspaceId,
      creatorId: userId,
    } as any);
    memberSpaceId = memberSpace.id;

    const outsiderSpace = await spaceRepo.insertSpace({
      name: `outsider-space-${uuid7()}`,
      slug: `outsider-space-${uuid7()}`,
      workspaceId,
      creatorId: userId,
    } as any);
    outsiderSpaceId = outsiderSpace.id;

    await spaceMemberRepo.insertSpaceMember({
      userId,
      spaceId: memberSpaceId,
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
    await db
      .deleteFrom('spaceMembers')
      .where('spaceId', '=', memberSpaceId)
      .execute();
    await db.deleteFrom('spaces').where('id', '=', memberSpaceId).execute();
    await db.deleteFrom('spaces').where('id', '=', outsiderSpaceId).execute();
    await db.deleteFrom('users').where('id', '=', userId).execute();
    await db.deleteFrom('workspaces').where('id', '=', workspaceId).execute();
  });

  async function createCoverAttachment(spaceId: string, fileName: string) {
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

  async function createNonCoverAttachment(spaceId: string, fileName: string) {
    const attachment = await attachmentRepo.insertAttachment({
      fileName,
      filePath: `test/${uuid7()}/${fileName}`,
      fileExt: '.jpg',
      mimeType: 'image/jpeg',
      type: AttachmentType.File,
      creatorId: userId,
      workspaceId,
      spaceId,
    } as any);
    attachmentIds.push(attachment.id);
    return attachment;
  }

  it('returns covers from a space the user is a member of', async () => {
    await createCoverAttachment(memberSpaceId, 'visible-cover.jpg');

    const result = await attachmentRepo.getWorkspaceImages(userId, workspaceId, {
      limit: 20,
    } as any);

    expect(result.items.map((i) => i.fileName)).toContain('visible-cover.jpg');
  });

  it('excludes covers from a space the user is NOT a member of', async () => {
    await createCoverAttachment(outsiderSpaceId, 'hidden-cover.jpg');

    const result = await attachmentRepo.getWorkspaceImages(userId, workspaceId, {
      limit: 20,
    } as any);

    expect(result.items.map((i) => i.fileName)).not.toContain('hidden-cover.jpg');
  });

  it('excludes attachments that are not tagged as cover', async () => {
    await createNonCoverAttachment(memberSpaceId, 'body-image.jpg');

    const result = await attachmentRepo.getWorkspaceImages(userId, workspaceId, {
      limit: 20,
    } as any);

    expect(result.items.map((i) => i.fileName)).not.toContain('body-image.jpg');
  });
});

describe('AttachmentRepo - findExistingCoverAttachment (duplicate detection)', () => {
  let module: TestingModule;
  let attachmentRepo: AttachmentRepo;
  let userRepo: UserRepo;
  let workspaceRepo: WorkspaceRepo;
  let spaceRepo: SpaceRepo;
  let spaceMemberRepo: SpaceMemberRepo;
  let db: Kysely<any>;

  let workspaceId: string;
  let userId: string;
  let memberSpaceId: string;
  let secondMemberSpaceId: string;
  let outsiderSpaceId: string;
  const attachmentIds: string[] = [];

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [AppModule],
    })
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

    attachmentRepo = module.get(AttachmentRepo);
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
      email: `dup-test-${uuid7()}@example.com`,
      password: 'password123',
      name: 'Duplicate Test User',
      workspaceId,
    } as any);
    userId = user.id;

    const memberSpace = await spaceRepo.insertSpace({
      name: `member-space-${uuid7()}`,
      slug: `member-space-${uuid7()}`,
      workspaceId,
      creatorId: userId,
    } as any);
    memberSpaceId = memberSpace.id;

    const secondMemberSpace = await spaceRepo.insertSpace({
      name: `second-member-space-${uuid7()}`,
      slug: `second-member-space-${uuid7()}`,
      workspaceId,
      creatorId: userId,
    } as any);
    secondMemberSpaceId = secondMemberSpace.id;

    const outsiderSpace = await spaceRepo.insertSpace({
      name: `outsider-space-${uuid7()}`,
      slug: `outsider-space-${uuid7()}`,
      workspaceId,
      creatorId: userId,
    } as any);
    outsiderSpaceId = outsiderSpace.id;

    await spaceMemberRepo.insertSpaceMember({
      userId,
      spaceId: memberSpaceId,
      role: 'writer',
    } as any);

    await spaceMemberRepo.insertSpaceMember({
      userId,
      spaceId: secondMemberSpaceId,
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
    await db
      .deleteFrom('spaceMembers')
      .where('spaceId', '=', memberSpaceId)
      .execute();
    await db
      .deleteFrom('spaceMembers')
      .where('spaceId', '=', secondMemberSpaceId)
      .execute();
    await db.deleteFrom('spaces').where('id', '=', memberSpaceId).execute();
    await db
      .deleteFrom('spaces')
      .where('id', '=', secondMemberSpaceId)
      .execute();
    await db.deleteFrom('spaces').where('id', '=', outsiderSpaceId).execute();
    await db.deleteFrom('users').where('id', '=', userId).execute();
    await db.deleteFrom('workspaces').where('id', '=', workspaceId).execute();
  });

  async function createCover(
    spaceId: string,
    fileName: string,
    fileSize: number,
    opts?: { deletedAt?: Date },
  ) {
    const attachment = await attachmentRepo.insertAttachment({
      fileName,
      fileSize,
      filePath: `test/${uuid7()}/${fileName}`,
      fileExt: '.jpg',
      mimeType: 'image/jpeg',
      type: AttachmentType.Cover,
      creatorId: userId,
      workspaceId,
      spaceId,
    } as any);
    attachmentIds.push(attachment.id);

    if (opts?.deletedAt) {
      await db
        .updateTable('attachments')
        .set({ deletedAt: opts.deletedAt })
        .where('id', '=', attachment.id)
        .execute();
    }

    return attachment;
  }

  it('finds a matching cover by fileName + fileSize in a space the user belongs to', async () => {
    await createCover(memberSpaceId, 'sunset.jpg', 12345);

    const found = await attachmentRepo.findExistingCoverAttachment(
      userId,
      workspaceId,
      'sunset.jpg',
      12345,
    );

    expect(found).toBeDefined();
    expect(found.fileName).toBe('sunset.jpg');
  });

  it('matches a cover uploaded under a different space, as long as the user is a member of both', async () => {
    // The cover lives in secondMemberSpaceId; the "upload" being checked
    // conceptually targets a different space (memberSpaceId). A cover is
    // a workspace-wide shared asset (same model as the gallery listing),
    // so this must still be found rather than treated as space-local.
    await createCover(secondMemberSpaceId, 'cross-space.jpg', 8888);

    const found = await attachmentRepo.findExistingCoverAttachment(
      userId,
      workspaceId,
      'cross-space.jpg',
      8888,
    );

    expect(found).toBeDefined();
    expect(found.fileName).toBe('cross-space.jpg');
  });

  it('does not match a cover in a space the user is NOT a member of', async () => {
    await createCover(outsiderSpaceId, 'shared-across-spaces.jpg', 5555);

    // Duplicate detection reuses the exact same access boundary as the
    // gallery listing (getWorkspaceImages): being in the same workspace
    // isn't enough, the user must actually be a member of the space the
    // existing cover lives in.
    const found = await attachmentRepo.findExistingCoverAttachment(
      userId,
      workspaceId,
      'shared-across-spaces.jpg',
      5555,
    );

    expect(found).toBeUndefined();
  });

  it('does not match when the file size differs', async () => {
    await createCover(memberSpaceId, 'mountain.jpg', 10000);

    const found = await attachmentRepo.findExistingCoverAttachment(
      userId,
      workspaceId,
      'mountain.jpg',
      99999,
    );

    expect(found).toBeUndefined();
  });

  it('does not match a soft-deleted cover', async () => {
    await createCover(memberSpaceId, 'deleted.jpg', 7777, {
      deletedAt: new Date(),
    });

    const found = await attachmentRepo.findExistingCoverAttachment(
      userId,
      workspaceId,
      'deleted.jpg',
      7777,
    );

    expect(found).toBeUndefined();
  });

  it('does not match a non-cover attachment with the same name and size', async () => {
    const attachment = await attachmentRepo.insertAttachment({
      fileName: 'document.jpg',
      fileSize: 4321,
      filePath: `test/${uuid7()}/document.jpg`,
      fileExt: '.jpg',
      mimeType: 'image/jpeg',
      type: AttachmentType.File,
      creatorId: userId,
      workspaceId,
      spaceId: memberSpaceId,
    } as any);
    attachmentIds.push(attachment.id);

    const found = await attachmentRepo.findExistingCoverAttachment(
      userId,
      workspaceId,
      'document.jpg',
      4321,
    );

    expect(found).toBeUndefined();
  });
});
