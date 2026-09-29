import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { JevSystemOneRequest, JevSystemOneResponse } from '../types.js';

export class JevClient {
  private endpoint: string;
  private model: string;
  private apiKey: string | null = null;

  constructor(endpoint?: string, model?: string, apiKey?: string) {
    this.endpoint = endpoint || 'https://api.typesafe.ai/v1/systemone';
    this.model = model || 'jev-latest';
    this.apiKey = apiKey || this.resolveApiKey();
  }

  /**
   * Resolve API key from environment or 0600 secret file
   */
  private resolveApiKey(): string | null {
    if (process.env.TYPESAFE_API_KEY) {
      return process.env.TYPESAFE_API_KEY.trim();
    }
    if (process.env.JEV_API_KEY) {
      return process.env.JEV_API_KEY.trim();
    }

    const secretPaths = [
      path.join(os.homedir(), '.pi', 'agent', 'secrets', 'jev.key'),
      path.join(os.homedir(), '.pi', 'secrets', 'jev.key'),
      path.join(process.cwd(), '.pi', 'secrets', 'jev.key'),
    ];

    for (const p of secretPaths) {
      if (fs.existsSync(p)) {
        try {
          return fs.readFileSync(p, 'utf-8').trim();
        } catch {
          // Ignore
        }
      }
    }

    return null;
  }

  public setApiKey(key: string): void {
    this.apiKey = key.trim();
  }

  public getApiKey(): string | null {
    return this.apiKey;
  }

  /**
   * Send a single-round speculative fan-out decision request to Jev System One
   */
  public async evaluate(
    request: Omit<JevSystemOneRequest, 'model'>,
    timeoutMs: number = 15000
  ): Promise<{ response: JevSystemOneResponse; latencyMs: number }> {
    if (!this.apiKey) {
      throw new Error(
        'TypeSafe Jev API Key not found. Please set TYPESAFE_API_KEY environment variable or save key in ~/.pi/agent/secrets/jev.key'
      );
    }

    const fullPayload: JevSystemOneRequest = {
      model: this.model,
      state: request.state,
      questions: request.questions,
    };

    const t0 = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const resp = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': 'pi-jev-navigator/1.0.0',
        },
        body: JSON.stringify(fullPayload),
        signal: controller.signal,
      });

      clearTimeout(timer);
      const latencyMs = Date.now() - t0;

      if (!resp.ok) {
        const errorText = await resp.text();
        throw new Error(`Jev API error (HTTP ${resp.status}): ${errorText}`);
      }

      const json = (await resp.json()) as JevSystemOneResponse;
      return { response: json, latencyMs };
    } catch (err: unknown) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Jev API request timed out after ${timeoutMs}ms`);
      }
      throw err;
    }
  }
}
