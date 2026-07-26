import { Kysely } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('pages')
    .addColumn('cover_photo_position_x', 'integer')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('pages')
    .dropColumn('cover_photo_position_x')
    .execute();
}
