#!/usr/bin/env node
/**
 * One-off data copy: dev.db (SQLite) → the Supabase Postgres mirror at
 * DATABASE_PROD_URL, whose schema was created by
 * `npx prisma db push --schema=prisma/schema.postgres.prisma`.
 *
 * Two Prisma Clients, not a raw SQL dump: the SQLite client and the Postgres
 * client both marshal DB values to/from the same JS types (dates become
 * `Date`, SQLite's 0/1 booleans become `boolean`, etc.), so reading a row from
 * one and `createMany`-ing it straight into the other needs no manual type
 * translation, as long as the two schemas stay field-for-field identical
 * (which `schema.postgres.prisma` is — see its header comment).
 *
 * Insertion order and foreign keys: rather than topologically sorting 137
 * models by their relations, this disables Postgres's trigger-based FK
 * enforcement for the session (`session_replication_role = replica` — a
 * normal session-level GUC, not a superuser-only one; confirmed against this
 * Supabase project before relying on it) and restores it in a `finally`. Load
 * order then genuinely does not matter, including self-referential FKs like
 * `TechnicalAudit.previousAuditId`.
 *
 * Idempotent-ish: `skipDuplicates: true` means a re-run after a partial
 * failure only inserts what is still missing, it does not double-insert.
 */

require('dotenv').config();
const path = require('node:path');
const fs = require('node:fs');

const { PrismaClient: SqliteClient } = require('@prisma/client');
const { PrismaClient: PgClient } = require('../node_modules/.prisma/client-postgres');

/** Model names in schema declaration order, read straight from the schema
 *  file rather than hand-maintained here — the two schemas are guaranteed to
 *  agree on this list because `schema.postgres.prisma` is a copy of it. */
function modelNames() {
  const schema = fs.readFileSync(path.join(__dirname, '../prisma/schema.prisma'), 'utf8');
  return [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]);
}

/** Prisma Client exposes each model as a delegate named in camelCase. */
function delegateName(modelName) {
  return modelName.charAt(0).toLowerCase() + modelName.slice(1);
}

const BATCH_SIZE = 500;

async function main() {
  const sqlite = new SqliteClient();
  const pg = new PgClient();

  const models = modelNames();
  console.log(`${models.length} models to copy.`);

  await pg.$executeRawUnsafe('SET session_replication_role = replica;');

  const summary = [];
  try {
    for (const model of models) {
      const key = delegateName(model);
      if (typeof sqlite[key]?.findMany !== 'function' || typeof pg[key]?.createMany !== 'function') {
        console.warn(`  ! skipping ${model} — no matching delegate on one of the clients`);
        continue;
      }

      const rows = await sqlite[key].findMany();
      if (rows.length === 0) {
        summary.push({ model, source: 0, inserted: 0 });
        continue;
      }

      let inserted = 0;
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        const result = await pg[key].createMany({ data: batch, skipDuplicates: true });
        inserted += result.count;
      }
      summary.push({ model, source: rows.length, inserted });
      console.log(`  ${model}: ${inserted}/${rows.length} copied`);
    }
  } finally {
    await pg.$executeRawUnsafe('SET session_replication_role = DEFAULT;');
  }

  console.log('\n--- Reconciliation ---');
  let mismatches = 0;
  for (const { model, source, inserted } of summary) {
    const key = delegateName(model);
    const nowInPg = await pg[key].count();
    const ok = nowInPg === source;
    if (!ok) mismatches += 1;
    if (source > 0) {
      console.log(`${ok ? 'OK  ' : 'DIFF'} ${model}: sqlite=${source} inserted=${inserted} postgres-now=${nowInPg}`);
    }
  }
  console.log(mismatches === 0 ? '\nAll non-empty tables match.' : `\n${mismatches} table(s) mismatched — see DIFF lines above.`);

  await sqlite.$disconnect();
  await pg.$disconnect();
  process.exit(mismatches === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
