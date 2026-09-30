import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface FixtureMemory { id?: number; project?: string | null; target?: string; category?: string; content: string; created?: string }
export function makeHermesDatabase(home: string, entries: FixtureMemory[], directory?: string): string {
  const dir = directory ?? path.join(home, '.pi/agent/pi-hermes-memory');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'sessions.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE memories (id INTEGER PRIMARY KEY, project TEXT, target TEXT, category TEXT,
    content TEXT, created TEXT, last_referenced TEXT);
    CREATE VIRTUAL TABLE memory_fts USING fts5(content, content='memories', content_rowid='id', tokenize='trigram');`);
  const insert = db.prepare('INSERT INTO memories VALUES(?,?,?,?,?,?,?)');
  const fts = db.prepare('INSERT INTO memory_fts(rowid,content) VALUES(?,?)');
  for (const [i, entry] of entries.entries()) {
    const id = entry.id ?? i + 1;
    insert.run(id, entry.project ?? null, entry.target ?? 'failure', entry.category ?? 'correction',
      entry.content, entry.created ?? '2026-09-30', entry.created ?? '2026-09-30');
    fts.run(id, entry.content);
  }
  db.close();
  return file;
}
