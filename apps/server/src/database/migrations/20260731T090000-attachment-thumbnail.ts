import { Kysely, sql } from 'kysely';

// Kept separate from 20260730T090000-page-cover.ts: this alters
// `attachments`, not `pages` — a distinct table with its own lifecycle.
// Thumbnails are generated client-side (canvas) at cover-upload time and
// stored alongside the full-size image; see AttachmentService.uploadFile
// and lib/generate-thumbnail.ts.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('attachments')
    .addColumn('thumbnail_path', 'varchar')
    .addColumn('thumbnail_size', 'bigint')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('attachments')
    .dropColumn('thumbnail_size')
    .dropColumn('thumbnail_path')
    .execute();
}
