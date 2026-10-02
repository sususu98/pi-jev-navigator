import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { JevQuestion, JevSystemOneRequest, JevSystemOneResponse } from '../types.js';
import { assertRequestCapacity } from './capacity.js';

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isProbability = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

/** Treat remote answers as data, not as arbitrary instructions to forward to the main model. */
export function validateJevResponse(
  value: unknown,
  questions: Record<string, JevQuestion>
): asserts value is JevSystemOneResponse {
  if (!isRecord(value) || !isRecord(value.answers) || !isRecord(value.usage)) {
    throw new Error('Invalid Jev response envelope');
  }
  for (const field of ['input_tokens', 'output_tokens']) {
    const count = value.usage[field];
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      throw new Error('Invalid Jev token usage');
    }
  }
  for (const id of Object.keys(value.answers)) {
    if (!Object.hasOwn(questions, id)) throw new Error('Unexpected Jev answer');
  }
  for (const [id, question] of Object.entries(questions)) {
    const answer = value.answers[id];
    if (!isRecord(answer) || answer.type !== question.type
      || (question.type !== 'noul' && !isProbability(answer.confidence))) {
      throw new Error(`Missing or invalid Jev answer: ${id}`);
    }
    if (question.type === 'choice') {
      if (typeof answer.choice !== 'string' || !Object.hasOwn(question.criteria, answer.choice)) {
        throw new Error(`Unknown Jev choice: ${id}`);
      }
      if (answer.probabilities !== undefined) {
        if (!isRecord(answer.probabilities)) throw new Error('Invalid Jev probabilities');
        for (const [key, probability] of Object.entries(answer.probabilities)) {
          if (!Object.hasOwn(question.criteria, key) || !isProbability(probability)) {
            throw new Error(`Invalid Jev choice probability: ${id}`);
          }
        }
      }
    } else if (question.type === 'score') {
      if (typeof answer.score !== 'number' || !Number.isFinite(answer.score) ||
          answer.score < 0 || answer.score > question.criteria.length - 1) {
        throw new Error(`Invalid Jev score: ${id}`);
      }
    } else if (!isProbability(answer.noul)) {
      throw new Error(`Invalid Jev noul: ${id}`);
    }
  }
}

export class JevClient {
  private endpoint: string;
  private model: string;
  private apiKey: string | null;

  constructor(
    endpoint?: string,
    model?: string,
    apiKey?: string,
    keyFilePath?: string,
    homeDir: string = os.homedir(),
    private transport: typeof fetch = globalThis.fetch
  ) {
    this.endpoint = endpoint || 'https://api.typesafe.ai/v1/systemone';
    this.model = model || 'jev-latest';
    this.apiKey = apiKey?.trim() || this.resolveApiKey(keyFilePath, homeDir);
  }

  private resolveApiKey(keyFilePath: string | undefined, homeDir: string): string | null {
    const readKey = (file: string): string | null => {
      try { return fs.readFileSync(file, 'utf-8').trim() || null; } catch { return null; }
    };
    // An explicit trusted key file is authoritative; do not silently use a different account.
    if (keyFilePath) {
      const expanded = keyFilePath.startsWith('~/') ? path.join(homeDir, keyFilePath.slice(2)) : keyFilePath;
      return readKey(expanded);
    }
    const envKey = process.env.TYPESAFE_API_KEY?.trim() || process.env.JEV_API_KEY?.trim();
    if (envKey) return envKey;
    for (const file of [
      path.join(homeDir, '.pi', 'agent', 'secrets', 'jev.key'),
      path.join(homeDir, '.pi', 'secrets', 'jev.key'),
    ]) {
      const key = readKey(file);
      if (key) return key;
    }
    return null;
  }

  public getModel(): string { return this.model; }

  public setApiKey(key: string): void { this.apiKey = key.trim() || null; }
  public getApiKey(): string | null { return this.apiKey; }

  /** Deadline covers headers AND the bounded response body; caller cancellation propagates. */
  public async evaluate(
    request: Omit<JevSystemOneRequest, 'model'>,
    timeoutMs: number = 15000,
    signal?: AbortSignal
  ): Promise<{ response: JevSystemOneResponse; latencyMs: number }> {
    if (!this.apiKey) throw new Error('TypeSafe Jev API Key not configured');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid Jev timeout');
    timeoutMs = Math.min(timeoutMs, 5000);
    assertRequestCapacity(request, this.model);

    const fullPayload: JevSystemOneRequest = { model: this.model, ...request };
    const t0 = Date.now();
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`Jev API request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    // Also bound providers/test transports that fail to reject body reads on abort.
    let rejectAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(controller.signal.reason ?? new Error('Jev request aborted'));
      controller.signal.addEventListener('abort', rejectAbort, { once: true });
      if (controller.signal.aborted) rejectAbort();
    });
    const receive = async (): Promise<JevSystemOneResponse> => {
      controller.signal.throwIfAborted();
      const response = await this.transport(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': 'pi-jev-navigator/1.0.0',
        },
        body: JSON.stringify(fullPayload),
        redirect: 'error',
        signal: controller.signal,
      });
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Empty Jev response');
      const chunks: Uint8Array[] = [];
      let size = 0;
      const cancelReader = () => { void reader.cancel().catch(() => {}); };
      controller.signal.addEventListener('abort', cancelReader, { once: true });
      if (controller.signal.aborted) cancelReader();
      try {
        controller.signal.throwIfAborted();
        while (true) {
          const { done, value } = await reader.read();
          controller.signal.throwIfAborted();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_RESPONSE_BYTES) {
            cancelReader();
            throw new Error('Jev response exceeds size limit');
          }
          chunks.push(value);
        }
      } finally {
        controller.signal.removeEventListener('abort', cancelReader);
        reader.releaseLock();
      }
      // Do not echo remote error bodies: they can contain credentials or private prompts.
      if (!response.ok) throw new Error(`Jev API error (HTTP ${response.status})`);
      let json: unknown;
      try { json = JSON.parse(Buffer.concat(chunks).toString('utf-8')); }
      catch { throw new Error('Invalid Jev JSON response'); }
      validateJevResponse(json, request.questions);
      return json;
    };
    try {
      const response = await Promise.race([receive(), aborted]);
      return { response, latencyMs: Date.now() - t0 };
    } catch (error) {
      if (timedOut) throw new Error(`Jev API request timed out after ${timeoutMs}ms`);
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort);
    }
  }
}
