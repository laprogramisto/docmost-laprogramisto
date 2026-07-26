import { Kysely } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('attachments')
    .addColumn('thumbnail_path', 'varchar')
    .execute();

  await db.schema
    .alterTable('attachments')
    .addColumn('thumbnail_size', 'bigint')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('attachments')
    .dropColumn('thumbnail_size')
    .execute();

  await db.schema
    .alterTable('attachments')
    .dropColumn('thumbnail_path')
    .execute();
}
