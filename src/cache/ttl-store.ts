import * as fs from 'fs';
import * as path from 'path';
import { writeSafeConfig } from '../config/safe-file.js';

export interface CacheEntry<T> {
  timestamp: number;
  data: T;
}

export class TTLStore {
  private cacheDir: string;
  private ttlMs: number;
  private projectRoot: string;

  constructor(projectRoot: string, ttlDays: number = 7) {
    this.projectRoot = path.resolve(projectRoot);
    this.cacheDir = path.join(this.projectRoot, '.pi');
    this.ttlMs = ttlDays * 24 * 60 * 60 * 1000;
  }

  private cachePath(fileName: string): string {
    // Cache APIs accept a filename, never a path or traversal outside .pi.
    if (!fileName || fileName === '.' || fileName === '..' || /[/\\:\0]/.test(fileName)) {
      throw new Error('Invalid cache filename');
    }
    return path.join(this.cacheDir, fileName);
  }

  private writeCache(fileName: string, content: string): void {
    // Reuse link/parent identity checks and atomic replacement; never truncate
    // a project-controlled link's target.
    writeSafeConfig(this.cachePath(fileName), this.projectRoot, [], () => content);
  }

  public get<T>(key: string): T | null {
    const filePath = this.cachePath(`${key}.json`);
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
    const entry: CacheEntry<T> = {
      timestamp: Date.now(),
      data,
    };
    this.writeCache(`${key}.json`, JSON.stringify(entry, null, 2));
  }

  public getRawFile(fileName: string): string | null {
    const filePath = this.cachePath(fileName);
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
    this.writeCache(fileName, content);
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
