import { Kysely, sql } from 'kysely';

// All "page cover" fields in one migration. Position, positionX, size and
// alt were previously added across five separate same-week migrations —
// consolidated here since they shipped together as a single feature and
// were never independently released.
//
// coverAttachmentId is the source of truth for which uploaded image is the
// page's cover: a real FK into attachments, not a string parsed out of a
// URL. coverPhoto (see the pre-existing 20240324T086300-pages.ts column)
// stays as-is and is treated as a server-derived, read-only field going
// forward — see CreatePageDto/UpdatePageDto and PageService.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('pages')
    .addColumn('cover_attachment_id', 'uuid', (col) =>
      col.references('attachments.id').onDelete('set null'),
    )
    .addColumn('cover_photo_position', 'integer')
    .addColumn('cover_photo_position_x', 'integer')
    .addColumn('cover_photo_size', 'varchar')
    .addColumn('cover_photo_alt', 'varchar')
    .execute();

  // Used by AttachmentRepo.getSpaceIdsUsingAttachment (cross-space check
  // before deleting a cover from the shared Gallery) and by the cleanup
  // query in AttachmentService.deleteImage.
  await db.schema
    .createIndex('pages_cover_attachment_id_idx')
    .on('pages')
    .column('cover_attachment_id')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .dropIndex('pages_cover_attachment_id_idx')
    .on('pages')
    .execute();

  await db.schema
    .alterTable('pages')
    .dropColumn('cover_photo_alt')
    .dropColumn('cover_photo_size')
    .dropColumn('cover_photo_position_x')
    .dropColumn('cover_photo_position')
    .dropColumn('cover_attachment_id')
    .execute();
}
