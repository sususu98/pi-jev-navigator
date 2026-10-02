import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface CPAClientConfig {
  baseUrl?: string;
  apiKey?: string;
}

export interface ExtractionResult {
  terms: string[];
  latencyMs: number;
  status: 'ready' | 'bypassed' | 'timeout' | 'error';
  model?: string;
}

const SYSTEM_INSTRUCTION_TEXT =
  'Jev Memory Keyword Extractor System Prompt v1: Extract 3-6 short technical identifiers or concepts in JSON format with terms array.';

export class GeminiKeywordExtractor {
  constructor(
    private homeDir: string = os.homedir(),
    private transport: typeof fetch = globalThis.fetch,
    private customConfig?: CPAClientConfig
  ) {}

  public resolveCPAConfig(): CPAClientConfig | null {
    if (this.customConfig?.baseUrl && this.customConfig?.apiKey) {
      return this.customConfig;
    }
    const isHostHome = this.homeDir === os.homedir();
    const envBase = isHostHome ? process.env.CPA_BASE_URL?.trim() : undefined;
    const envKey = isHostHome ? (process.env.CPA_API_KEY || process.env.LOCAL_CPA_KEY)?.trim() : undefined;
    if (envBase && envKey) {
      return { baseUrl: envBase, apiKey: envKey };
    }

    const configFile = path.join(this.homeDir, '.pi', 'agent', 'cliproxyapi.json');
    try {
      if (fs.existsSync(configFile)) {
        const raw = fs.readFileSync(configFile, 'utf-8');
        const parsed = JSON.parse(raw);
        const baseUrl = typeof parsed.baseUrl === 'string' ? parsed.baseUrl.trim() : 'http://127.0.0.1:8317';
        const apiKey = typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : '';
        if (baseUrl && apiKey) {
          return { baseUrl, apiKey };
        }
      }
    } catch {
      // Best-effort config read; fail-open on any file error
    }

    if (envKey) {
      return { baseUrl: envBase || 'http://127.0.0.1:8317', apiKey: envKey };
    }
    return null;
  }

  public async extract(
    task: string,
    options: { model?: string; timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<ExtractionResult> {
    const t0 = performance.now();
    const cleanTask = task.normalize('NFKC').trim();
    if (!cleanTask || options.signal?.aborted) {
      return { terms: [], latencyMs: 0, status: 'bypassed' };
    }

    const cpa = this.resolveCPAConfig();
    if (!cpa?.baseUrl || !cpa?.apiKey) {
      return { terms: [], latencyMs: 0, status: 'bypassed' };
    }

    const model = options.model || 'gemini-3.5-flash-lite';
    const timeoutMs = Math.max(100, options.timeoutMs ?? 1200);

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`Gemini keyword extractor timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const onAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    const targetUrl = `${cpa.baseUrl.replace(/\/+$/, '')}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const payload = {
      systemInstruction: {
        parts: [{ text: SYSTEM_INSTRUCTION_TEXT }],
      },
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: `Return JSON only: {"terms":["..."]}. Extract 3-6 short memory-search terms from the task: "${cleanTask.slice(0, 4000)}"`,
            },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            terms: {
              type: 'ARRAY',
              items: { type: 'STRING' },
            },
          },
          required: ['terms'],
        },
        maxOutputTokens: 256,
        thinkingConfig: { thinkingBudget: 0 },
      },
    };

    try {
      controller.signal.throwIfAborted();
      const response = await this.transport(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cpa.apiKey}`,
          'x-goog-api-key': cpa.apiKey,
          'X-Session-ID': 'jev-keyword-extractor',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        return {
          terms: [],
          latencyMs: Math.round(performance.now() - t0),
          status: 'error',
          model,
        };
      }

      const json = await response.json();
      const terms = this.parseTermsFromGeminiResponse(json);
      return {
        terms,
        latencyMs: Math.round(performance.now() - t0),
        status: 'ready',
        model,
      };
    } catch {
      return {
        terms: [],
        latencyMs: Math.round(performance.now() - t0),
        status: timedOut ? 'timeout' : 'error',
        model,
      };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  private parseTermsFromGeminiResponse(data: any): string[] {
    try {
      const parts = data?.candidates?.[0]?.content?.parts;
      if (!Array.isArray(parts)) return [];

      let rawText = '';
      for (const part of parts) {
        if (!part.thought && typeof part.text === 'string' && part.text.trim()) {
          rawText = part.text.trim();
          break;
        }
      }
      if (!rawText) return [];

      let parsed: any;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        // Fallback: strip potential markdown fences if present
        const match = rawText.match(/^\x60\x60\x60(?:json)?\s*\n?([\s\S]*?)\n?\x60\x60\x60$/i);
        if (match) {
          parsed = JSON.parse(match[1].trim());
        }
      }

      if (!parsed || !Array.isArray(parsed.terms)) return [];

      const cleanTerms: string[] = [];
      const seen = new Set<string>();
      for (const item of parsed.terms) {
        if (typeof item !== 'string') continue;
        const term = item.normalize('NFKC').trim();
        // Terms must be meaningful identifiers or phrases (2-32 chars)
        if (term.length >= 2 && term.length <= 32 && !seen.has(term.toLowerCase())) {
          seen.add(term.toLowerCase());
          cleanTerms.push(term);
          if (cleanTerms.length >= 6) break;
        }
      }
      return cleanTerms;
    } catch {
      return [];
    }
  }
}
