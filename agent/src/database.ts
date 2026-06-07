import pg from "pg";
import { randomBytes } from "crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
import { basename, join } from "path";

const { Client } = pg;

const PG_HOST = process.env.PG_HOST ?? "postgres";
const PG_PORT = parseInt(process.env.PG_PORT ?? "5432");
const PG_ADMIN_USER = process.env.PG_ADMIN_USER ?? "postgres";
const PG_ADMIN_PASSWORD = process.env.PG_ADMIN_PASSWORD ?? "postgres";
const PG_ADMIN_DB = process.env.PG_ADMIN_DB ?? "postgres";
const DATA_DIR = process.env.DATA_DIR ?? "/data";

function adminClient() {
  return new Client({
    host: PG_HOST,
    port: PG_PORT,
    user: PG_ADMIN_USER,
    password: PG_ADMIN_PASSWORD,
    database: PG_ADMIN_DB,
  });
}

export interface DbCredentials {
  dbName: string;
  dbUser: string;
  password: string;
  connectionUrl: string;
}

function credsDir() {
  return join(DATA_DIR, "databases");
}

function credsPath(slug: string) {
  return join(credsDir(), `${slug}.json`);
}

function loadCreds(slug: string): DbCredentials | null {
  try {
    return JSON.parse(readFileSync(credsPath(slug), "utf8")) as DbCredentials;
  } catch {
    return null;
  }
}

function saveCreds(slug: string, creds: DbCredentials): void {
  mkdirSync(credsDir(), { recursive: true });
  writeFileSync(credsPath(slug), JSON.stringify(creds, null, 2));
}

export async function provisionDatabase(slug: string, connLimit = 10): Promise<string> {
  const existing = loadCreds(slug);

  const dbName = `app_${slug}`.replace(/-/g, "_");
  const dbUser = `user_${slug}`.replace(/-/g, "_").slice(0, 32);
  // Reuse existing password if credentials exist — prevents DATABASE_URL drift
  const password = existing?.password ?? randomBytes(16).toString("hex");

  const client = adminClient();
  await client.connect();

  try {
    // Create or update user — reuse password, update connection limit
    await client.query(
      `DO $$ BEGIN
         CREATE USER "${dbUser}" WITH PASSWORD '${password}' CONNECTION LIMIT ${connLimit};
       EXCEPTION WHEN duplicate_object THEN
         ALTER USER "${dbUser}" WITH PASSWORD '${password}' CONNECTION LIMIT ${connLimit};
       END $$;`
    );

    // Create database if not exists
    const existing_db = await client.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [dbName]
    );
    if (existing_db.rowCount === 0) {
      await client.query(`CREATE DATABASE "${dbName}" OWNER "${dbUser}"`);
    }

    await client.query(
      `GRANT ALL PRIVILEGES ON DATABASE "${dbName}" TO "${dbUser}"`
    );

    // Ikke la andre apperoller koble til denne databasen (kun eier + superuser)
    await client.query(`REVOKE CONNECT ON DATABASE "${dbName}" FROM PUBLIC`);
    await client.query(`GRANT CONNECT ON DATABASE "${dbName}" TO "${dbUser}"`);

    // Begrens langtrengende spørringer og hengende transaksjoner (ressursbruk)
    await client.query(
      `ALTER ROLE "${dbUser}" SET statement_timeout TO '120s'`
    );
    await client.query(
      `ALTER ROLE "${dbUser}" SET idle_in_transaction_session_timeout TO '60s'`
    );
  } finally {
    await client.end();
  }

  const connectionUrl = `postgresql://${dbUser}:${password}@${PG_HOST}:${PG_PORT}/${dbName}`;
  saveCreds(slug, { dbName, dbUser, password, connectionUrl });
  return connectionUrl;
}

export function getDbCredentials(slug: string): DbCredentials | null {
  return loadCreds(slug);
}

/** Diskbruk for app-databasen (byte), eller null hvis databasen ikke finnes. */
export async function getDatabaseDiskBytesForSlug(slug: string): Promise<number | null> {
  const dbName = `app_${slug}`.replace(/-/g, "_");
  const client = adminClient();
  await client.connect();
  try {
    const r = await client.query<{ b: string }>(
      `SELECT pg_database_size(d.oid)::text AS b FROM pg_database d WHERE d.datname = $1`,
      [dbName]
    );
    if (r.rowCount === 0) return null;
    return Number(r.rows[0].b);
  } finally {
    await client.end();
  }
}

/** Summert disk for flere app-databaser (byte). Manglende DB teller som 0. */
export async function getTotalDatabaseDiskBytesForSlugs(slugs: string[]): Promise<number> {
  if (slugs.length === 0) return 0;
  const names = [...new Set(slugs)].map((s) => `app_${s}`.replace(/-/g, "_"));
  const client = adminClient();
  await client.connect();
  try {
    const r = await client.query<{ s: string }>(
      `SELECT coalesce(sum(pg_database_size(d.oid)), 0)::text AS s
       FROM pg_database d WHERE d.datname = ANY($1::text[])`,
      [names]
    );
    return Number(r.rows[0]?.s ?? 0);
  } finally {
    await client.end();
  }
}

export async function dropDatabase(slug: string): Promise<void> {
  const dbName = `app_${slug}`.replace(/-/g, "_");
  const dbUser = `user_${slug}`.replace(/-/g, "_").slice(0, 32);

  const client = adminClient();
  await client.connect();

  try {
    await client.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
      [dbName]
    );
    await client.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await client.query(`DROP USER IF EXISTS "${dbUser}"`);
  } finally {
    await client.end();
  }
}

export interface BackupInfo {
  filename: string;
  size: number;
  createdAt: string;
}

/** Maks antall .sql-backuper per app (eldste slettes ved nye). */
const BACKUP_MAX_FILES = Math.max(
  1,
  parseInt(process.env.BACKUP_MAX_FILES_PER_APP ?? "5", 10) || 5
);

export function listBackups(slug: string): BackupInfo[] {
  const dir = join(DATA_DIR, "backups", slug);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql") || f.endsWith(".sql.gz"))
    .map((f) => {
      const st = statSync(join(dir, f));
      return { filename: f, size: st.size, createdAt: st.birthtime.toISOString() };
    })
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

/** Sletter elste backuper når antall overstiger grensen (diskbeskyttelse). */
export function pruneExcessBackups(slug: string): void {
  const list = listBackups(slug);
  if (list.length <= BACKUP_MAX_FILES) return;
  const dir = join(DATA_DIR, "backups", slug);
  for (const b of list.slice(BACKUP_MAX_FILES)) {
    try {
      unlinkSync(join(dir, b.filename));
    } catch {
      /* ignore */
    }
  }
}

export function backupDir(slug: string): string {
  const dir = join(DATA_DIR, "backups", slug);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Absolutt sti til backup hvis filen er trygg og finnes, ellers null. */
const SAFE_BACKUP_NAME = /^backup-[0-9A-Za-z.-]+\.sql$/;

export function resolveBackupFilePath(slug: string, filename: string): string | null {
  const base = basename(filename);
  if (base !== filename || !SAFE_BACKUP_NAME.test(base)) return null;
  const dir = join(DATA_DIR, "backups", slug);
  const full = join(dir, base);
  if (!existsSync(full)) return null;
  const st = statSync(full);
  if (!st.isFile()) return null;
  return full;
}

export function deleteBackupFile(slug: string, filename: string): boolean {
  const full = resolveBackupFilePath(slug, filename);
  if (!full) return false;
  unlinkSync(full);
  return true;
}

/** Klient med app-bruker (read-only skjema-spørringer). */
function appReadClient(creds: DbCredentials): InstanceType<typeof Client> {
  return new Client({
    host: PG_HOST,
    port: PG_PORT,
    user: creds.dbUser,
    password: creds.password,
    database: creds.dbName,
  });
}

export interface InspectColumn {
  name: string;
  dataType: string;
  isNullable: boolean;
  default: string | null;
}

export interface InspectTable {
  schema: string;
  name: string;
  kind: "table" | "view" | "foreign";
  rowEstimate: number | null;
  columns: InspectColumn[];
}

export interface InspectExtension {
  name: string;
  version: string;
}

export interface DbInspectResult {
  database: string;
  extensions: InspectExtension[];
  tables: InspectTable[];
}

function formatColumnDisplayType(row: {
  data_type: string;
  udt_name: string;
  character_maximum_length: number | null;
  numeric_precision: number | null;
  numeric_scale: number | null;
  datetime_precision: number | null;
}): string {
  const dt = row.data_type;
  if ((dt === "character varying" || dt === "varchar") && row.character_maximum_length != null) {
    return row.character_maximum_length === -1
      ? "varchar"
      : `varchar(${row.character_maximum_length})`;
  }
  if (dt === "character" && row.character_maximum_length != null) {
    return `char(${row.character_maximum_length})`;
  }
  if (dt === "numeric" && row.numeric_precision != null) {
    return row.numeric_scale != null && row.numeric_scale > 0
      ? `numeric(${row.numeric_precision},${row.numeric_scale})`
      : `numeric(${row.numeric_precision})`;
  }
  if (
    (dt === "timestamp without time zone" || dt === "timestamp with time zone") &&
    row.datetime_precision != null &&
    row.datetime_precision > 0
  ) {
    return dt.includes("with time zone")
      ? `timestamptz(${row.datetime_precision})`
      : `timestamp(${row.datetime_precision})`;
  }
  if (dt === "ARRAY") {
    const base = row.udt_name.startsWith("_") ? row.udt_name.slice(1) : row.udt_name;
    return `${base}[]`;
  }
  if (dt === "USER-DEFINED") return row.udt_name;
  return dt;
}

/** Lesbare tabeller, kolonner og utvidelser (information_schema + pg_stat). */
export async function inspectAppDatabase(slug: string): Promise<DbInspectResult | null> {
  const creds = getDbCredentials(slug);
  if (!creds) return null;
  const client = appReadClient(creds);
  await client.connect();
  try {
    let extensions: InspectExtension[] = [];
    try {
      const ext = await client.query<{ extname: string; extversion: string }>(
        `SELECT extname, extversion FROM pg_extension ORDER BY extname`
      );
      extensions = ext.rows.map((r) => ({ name: r.extname, version: r.extversion }));
    } catch {
      /* mangler rettighet */
    }

    const tablesRes = await client.query<{
      table_schema: string;
      table_name: string;
      table_type: string;
    }>(
      `SELECT table_schema, table_name, table_type
       FROM information_schema.tables
       WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
         AND table_type IN ('BASE TABLE', 'VIEW', 'FOREIGN TABLE')
       ORDER BY table_schema, table_name`
    );

    const kindMap: Record<string, InspectTable["kind"]> = {
      "BASE TABLE": "table",
      VIEW: "view",
      "FOREIGN TABLE": "foreign",
    };

    const tables: InspectTable[] = [];

    for (const t of tablesRes.rows) {
      const cols = await client.query<{
        column_name: string;
        data_type: string;
        udt_name: string;
        is_nullable: string;
        column_default: string | null;
        character_maximum_length: number | null;
        numeric_precision: number | null;
        numeric_scale: number | null;
        datetime_precision: number | null;
      }>(
        `SELECT column_name, data_type, udt_name, is_nullable, column_default,
                character_maximum_length, numeric_precision, numeric_scale, datetime_precision
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
         ORDER BY ordinal_position`,
        [t.table_schema, t.table_name]
      );

      let rowEstimate: number | null = null;
      if (t.table_type === "BASE TABLE") {
        try {
          const st = await client.query<{ n: string | null }>(
            `SELECT n_live_tup::text AS n FROM pg_stat_user_tables
             WHERE schemaname = $1 AND relname = $2`,
            [t.table_schema, t.table_name]
          );
          if (st.rows[0]?.n != null) rowEstimate = Number(st.rows[0].n);
        } catch {
          /* ignore */
        }
      }

      tables.push({
        schema: t.table_schema,
        name: t.table_name,
        kind: kindMap[t.table_type] ?? "table",
        rowEstimate,
        columns: cols.rows.map((c) => ({
          name: c.column_name,
          dataType: formatColumnDisplayType(c),
          isNullable: c.is_nullable === "YES",
          default: c.column_default,
        })),
      });
    }

    return { database: creds.dbName, extensions, tables };
  } finally {
    await client.end();
  }
}
