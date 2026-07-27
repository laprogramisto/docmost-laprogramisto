import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { dbOrTx } from '@docmost/db/utils';
import {
  Attachment,
  InsertableAttachment,
  UpdatableAttachment,
} from '@docmost/db/types/entity.types';
import { AttachmentType } from '../../../core/attachment/attachment.constants';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import {
  CursorPaginationResult,
  executeWithCursorPagination,
} from '@docmost/db/pagination/cursor-pagination';
import { SpaceMemberRepo } from '../space/space-member.repo';

@Injectable()
export class AttachmentRepo {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly spaceMemberRepo: SpaceMemberRepo,
  ) {}

  private baseFields: Array<keyof Attachment> = [
    'id',
    'fileName',
    'filePath',
    'fileSize',
    'fileExt',
    'mimeType',
    'type',
    'creatorId',
    'pageId',
    'spaceId',
    'aiChatId',
    'workspaceId',
    'thumbnailPath',
    'thumbnailSize',
    'createdAt',
    'updatedAt',
    'deletedAt',
  ];

  async findById(
    attachmentId: string,
    opts?: {
      trx?: KyselyTransaction;
    },
  ): Promise<Attachment> {
    const db = dbOrTx(this.db, opts?.trx);

    return db
      .selectFrom('attachments')
      .select(this.baseFields)
      .where('id', '=', attachmentId)
      .executeTakeFirst();
  }

  async findByIdWithContent(
    attachmentId: string,
    opts?: {
      trx?: KyselyTransaction;
    },
  ): Promise<Attachment> {
    const db = dbOrTx(this.db, opts?.trx);

    return db
      .selectFrom('attachments')
      .select([...this.baseFields, 'textContent'])
      .where('id', '=', attachmentId)
      .executeTakeFirst();
  }

  async insertAttachment(
    insertableAttachment: InsertableAttachment,
    trx?: KyselyTransaction,
  ): Promise<Attachment> {
    const db = dbOrTx(this.db, trx);

    return db
      .insertInto('attachments')
      .values(insertableAttachment)
      .returning(this.baseFields)
      .executeTakeFirst();
  }

  async findBySpaceId(
    spaceId: string,
    opts?: {
      trx?: KyselyTransaction;
    },
  ): Promise<Attachment[]> {
    const db = dbOrTx(this.db, opts?.trx);

    return db
      .selectFrom('attachments')
      .select(this.baseFields)
      .where('spaceId', '=', spaceId)
      .execute();
  }

  async findByIds(
    ids: string[],
    opts?: {
      trx?: KyselyTransaction;
    },
  ): Promise<Attachment[]> {
    if (ids.length === 0) return [];
    const db = dbOrTx(this.db, opts?.trx);

    return db
      .selectFrom('attachments')
      .select(this.baseFields)
      .where('id', 'in', ids)
      .execute();
  }

  async findByAiChatId(
    aiChatId: string,
    opts?: {
      trx?: KyselyTransaction;
    },
  ): Promise<Attachment[]> {
    const db = dbOrTx(this.db, opts?.trx);

    return db
      .selectFrom('attachments')
      .select(this.baseFields)
      .where('aiChatId', '=', aiChatId)
      .execute();
  }

  updateAttachmentsByPageId(
    updatableAttachment: UpdatableAttachment,
    pageIds: string[],
    trx?: KyselyTransaction,
  ) {
    return dbOrTx(this.db, trx)
      .updateTable('attachments')
      .set(updatableAttachment)
      .where('pageId', 'in', pageIds)
      .returning(this.baseFields)
      .executeTakeFirst();
  }

  async updateAttachment(
    updatableAttachment: UpdatableAttachment,
    attachmentId: string,
  ): Promise<Attachment> {
    return await this.db
      .updateTable('attachments')
      .set(updatableAttachment)
      .where('id', '=', attachmentId)
      .returning(this.baseFields)
      .executeTakeFirst();
  }

  async claimAttachmentsForChat(
    attachmentIds: string[],
    aiChatId: string,
    creatorId: string,
    workspaceId: string,
  ): Promise<void> {
    if (attachmentIds.length === 0) return;

    await this.db
      .updateTable('attachments')
      .set({ aiChatId })
      .where('id', 'in', attachmentIds)
      .where('creatorId', '=', creatorId)
      .where('workspaceId', '=', workspaceId)
      .where('type', '=', AttachmentType.Chat)
      .where('aiChatId', 'is', null)
      .execute();
  }

  async deleteAttachmentById(attachmentId: string): Promise<void> {
    await this.db
      .deleteFrom('attachments')
      .where('id', '=', attachmentId)
      .executeTakeFirst();
  }

  async deleteAttachmentByFilePath(attachmentFilePath: string): Promise<void> {
    await this.db
      .deleteFrom('attachments')
      .where('filePath', '=', attachmentFilePath)
      .executeTakeFirst();
  }

  // Shared Gallery: every Cover-type image the requesting user has access
  // to across the workspace (i.e. uploaded to, or used as a cover in, any
  // space they're a member of). Scoped through spaceMemberRepo the same
  // way findBySpaceId/space listings already are — no cross-space leakage.
  async getWorkspaceImages(
    userId: string,
    workspaceId: string,
    pagination: PaginationOptions,
  ): Promise<CursorPaginationResult<Attachment>> {
    const accessibleSpaceIds =
      this.spaceMemberRepo.getUserSpaceIdsQuery(userId);

    let query = this.db
      .selectFrom('attachments')
      .select(this.baseFields)
      .where('workspaceId', '=', workspaceId)
      .where('type', '=', AttachmentType.Cover)
      .where('deletedAt', 'is', null)
      .where('spaceId', 'in', accessibleSpaceIds);

    if (pagination.query) {
      query = query.where('fileName', 'ilike', `%${pagination.query}%`);
    }

    return executeWithCursorPagination(query, {
      perPage: pagination.limit,
      cursor: pagination.cursor,
      beforeCursor: pagination.beforeCursor,
      fields: [{ expression: 'id', direction: 'desc' }],
      parseCursor: (cursor) => ({ id: cursor.id }),
    });
  }

  // Which spaces currently use this attachment as a page cover — checked
  // via the real FK (pages.cover_attachment_id) rather than pattern
  // matching coverPhoto as a string, so this stays correct regardless of
  // URL format and can use the pages_cover_attachment_id_idx index instead
  // of a full table scan. workspaceId is an extra safety filter (this is
  // always known at the call site, via @AuthWorkspace()) rather than
  // something the query strictly needs — cover_attachment_id already only
  // ever points at an attachment in the same workspace.
  async getSpaceIdsUsingAttachment(
    attachmentId: string,
    workspaceId: string,
  ): Promise<string[]> {
    const rows = await this.db
      .selectFrom('pages')
      .select('spaceId')
      .distinct()
      .where('coverAttachmentId', '=', attachmentId)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .execute();

    return rows.map((row) => row.spaceId);
  }
}
