/**
 * Storage layer for the Cardio AI Operations Platform.
 *
 * Two interchangeable drivers behind one async interface:
 *   - Postgres  (used automatically when DATABASE_URL is set, e.g. on Render)
 *   - JSON file (zero-setup fallback for local development)
 *
 * Data is stored as documents: each record is a JSON object kept in a
 * generic `documents` table (collection, id, data) so the flexible shapes
 * from seed.json work without per-field migrations. Singletons (financials)
 * live in a `singletons` table.
 */

const fs = require('fs');
const path = require('path');

const SEED_FILE = path.join(__dirname, 'seed.json');

// Which top-level keys in seed.json are collections vs singletons.
const SINGLETON_KEYS = ['financials', 'kpis'];

function loadSeed() {
  return JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
}

function genId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// ===========================================================================
// Postgres driver
// ===========================================================================
function createPostgresStore(connectionString, pgLib) {
  const { Pool } = pgLib || require('pg');

  // Render's managed Postgres requires SSL. Local connections do not.
  const isLocal = /@(localhost|127\.0\.0\.1)/.test(connectionString);
  const pool = new Pool({
    connectionString,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  });

  async function init() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS documents (
        collection TEXT NOT NULL,
        id         TEXT NOT NULL,
        position   BIGSERIAL,
        data       JSONB NOT NULL,
        PRIMARY KEY (collection, id)
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS singletons (
        key  TEXT PRIMARY KEY,
        data JSONB NOT NULL
      );
    `);

    // Seed once, if empty.
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM documents;');
    const seedCount = rows[0].n;
    const singletonCount = (await pool.query('SELECT COUNT(*)::int AS n FROM singletons;')).rows[0].n;

    if (seedCount === 0 && singletonCount === 0) {
      const seed = loadSeed();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const [key, value] of Object.entries(seed)) {
          if (SINGLETON_KEYS.includes(key)) {
            await client.query(
              'INSERT INTO singletons (key, data) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING;',
              [key, value]
            );
          } else if (Array.isArray(value)) {
            for (const item of value) {
              await client.query(
                'INSERT INTO documents (collection, id, data) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING;',
                [key, item.id, item]
              );
            }
          }
        }
        await client.query('COMMIT');
        console.log('[storage] Seeded Postgres from seed.json');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    }
  }

  return {
    driver: 'postgres',
    init,
    async list(collection) {
      const { rows } = await pool.query(
        'SELECT data FROM documents WHERE collection = $1 ORDER BY position ASC;',
        [collection]
      );
      return rows.map((r) => r.data);
    },
    async get(collection, id) {
      const { rows } = await pool.query(
        'SELECT data FROM documents WHERE collection = $1 AND id = $2;',
        [collection, id]
      );
      return rows[0] ? rows[0].data : null;
    },
    async create(collection, prefix, data) {
      const item = { ...data, id: genId(prefix) };
      await pool.query(
        'INSERT INTO documents (collection, id, data) VALUES ($1, $2, $3);',
        [collection, item.id, item]
      );
      return item;
    },
    async update(collection, id, patch) {
      const current = await this.get(collection, id);
      if (!current) return null;
      const next = { ...current, ...patch, id };
      await pool.query(
        'UPDATE documents SET data = $3 WHERE collection = $1 AND id = $2;',
        [collection, id, next]
      );
      return next;
    },
    async remove(collection, id) {
      const { rows } = await pool.query(
        'DELETE FROM documents WHERE collection = $1 AND id = $2 RETURNING data;',
        [collection, id]
      );
      return rows[0] ? rows[0].data : null;
    },
    async getSingleton(key) {
      const { rows } = await pool.query('SELECT data FROM singletons WHERE key = $1;', [key]);
      return rows[0] ? rows[0].data : null;
    },
    async putSingleton(key, data) {
      await pool.query(
        `INSERT INTO singletons (key, data) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data;`,
        [key, data]
      );
      return data;
    },
    _pool: pool, // exposed so the session store can reuse the pool
  };
}

// ===========================================================================
// JSON-file driver (local dev fallback)
// ===========================================================================
function createJsonStore(dataFile) {
  let cache = null;

  function read() {
    if (cache) return cache;
    try {
      if (fs.existsSync(dataFile)) {
        cache = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
        return cache;
      }
    } catch (e) {
      console.error('[storage] Could not read', dataFile, '-> reseeding:', e.message);
    }
    cache = loadSeed();
    write();
    return cache;
  }
  function write() {
    fs.writeFileSync(dataFile, JSON.stringify(cache, null, 2));
  }

  return {
    driver: 'json',
    async init() {
      read();
      console.log('[storage] Using JSON file store at', dataFile);
    },
    async list(collection) {
      return read()[collection] || [];
    },
    async get(collection, id) {
      return (read()[collection] || []).find((x) => x.id === id) || null;
    },
    async create(collection, prefix, data) {
      const db = read();
      if (!db[collection]) db[collection] = [];
      const item = { ...data, id: genId(prefix) };
      db[collection].push(item);
      write();
      return item;
    },
    async update(collection, id, patch) {
      const db = read();
      const list = db[collection] || [];
      const idx = list.findIndex((x) => x.id === id);
      if (idx === -1) return null;
      list[idx] = { ...list[idx], ...patch, id };
      write();
      return list[idx];
    },
    async remove(collection, id) {
      const db = read();
      const list = db[collection] || [];
      const idx = list.findIndex((x) => x.id === id);
      if (idx === -1) return null;
      const [removed] = list.splice(idx, 1);
      write();
      return removed;
    },
    async getSingleton(key) {
      return read()[key] || null;
    },
    async putSingleton(key, data) {
      const db = read();
      db[key] = { ...(db[key] || {}), ...data };
      write();
      return db[key];
    },
  };
}

// ===========================================================================
// Factory
// ===========================================================================
function createStore() {
  const url = process.env.DATABASE_URL;
  if (url) {
    console.log('[storage] DATABASE_URL detected -> using Postgres');
    return createPostgresStore(url);
  }
  console.log('[storage] No DATABASE_URL -> using JSON file (local dev)');
  return createJsonStore(path.join(__dirname, 'data.json'));
}

module.exports = { createStore, createPostgresStore, createJsonStore, genId };
