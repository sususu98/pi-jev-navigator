import * as fs from 'fs';
import * as path from 'path';

export interface CacheEntry<T> {
  timestamp: number;
  data: T;
}

export class TTLStore {
  private cacheDir: string;
  private ttlMs: number;

  constructor(projectRoot: string, ttlDays: number = 7) {
    this.cacheDir = path.join(projectRoot, '.pi');
    this.ttlMs = ttlDays * 24 * 60 * 60 * 1000;
  }

  private ensureDir() {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  public get<T>(key: string): T | null {
    const filePath = path.join(this.cacheDir, `${key}.json`);
    if (!fs.existsSync(filePath)) return null;

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const entry = JSON.parse(raw) as CacheEntry<T>;
      const now = Date.now();

      if (now - entry.timestamp > this.ttlMs) {
        return null; // Expired
      }
      return entry.data;
    } catch {
      return null;
    }
  }

  public set<T>(key: string, data: T): void {
    this.ensureDir();
    const filePath = path.join(this.cacheDir, `${key}.json`);
    const entry: CacheEntry<T> = {
      timestamp: Date.now(),
      data,
    };
    fs.writeFileSync(filePath, JSON.stringify(entry, null, 2), 'utf-8');
  }

  public getRawFile(fileName: string): string | null {
    const filePath = path.join(this.cacheDir, fileName);
    if (!fs.existsSync(filePath)) return null;
    try {
      const stat = fs.statSync(filePath);
      if (Date.now() - stat.mtimeMs > this.ttlMs) {
        return null;
      }
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  public setRawFile(fileName: string, content: string): void {
    this.ensureDir();
    const filePath = path.join(this.cacheDir, fileName);
    fs.writeFileSync(filePath, content, 'utf-8');
  }

  public clear(): void {
    if (fs.existsSync(this.cacheDir)) {
      try {
        const files = fs.readdirSync(this.cacheDir);
        for (const file of files) {
          if (file.startsWith('codegraph') || file.startsWith('cpa-macro-map') || file.endsWith('.dsl')) {
            fs.unlinkSync(path.join(this.cacheDir, file));
          }
        }
      } catch {
        // Ignore
      }
    }
  }
}
