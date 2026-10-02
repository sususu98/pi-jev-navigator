import { describe, it, expect } from 'bun:test';
import { GeminiKeywordExtractor } from '../src/memory/gemini-keyword-extractor.ts';

describe('GeminiKeywordExtractor', () => {
  const dummyConfig = {
    baseUrl: 'http://127.0.0.1:8317',
    apiKey: 'sk-test-dummy-key',
  };

  it('successfully extracts terms via Gemini native protocol and sends X-Session-ID', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: any = null;

    const fakeTransport = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = init?.headers as Record<string, string>;
      capturedBody = JSON.parse(init?.body as string);

      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    text: JSON.stringify({
                      terms: ['prefix cache', 'local-cpa', 'timeout investigation'],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    const extractor = new GeminiKeywordExtractor('/tmp', fakeTransport, dummyConfig);
    const result = await extractor.extract('investigate prefix cache drop in local-cpa');

    expect(result.status).toBe('ready');
    expect(result.terms).toEqual(['prefix cache', 'local-cpa', 'timeout investigation']);
    expect(capturedUrl).toContain('/v1beta/models/gemini-3.5-flash-lite:generateContent');
    expect(capturedHeaders['X-Session-ID']).toBe('jev-keyword-extractor');
    expect(capturedHeaders['x-goog-api-key']).toBe('sk-test-dummy-key');
    expect(capturedBody.systemInstruction?.parts?.[0]?.text).toContain('Jev Memory Keyword Extractor');
    expect(capturedBody.generationConfig?.thinkingConfig?.thinkingBudget).toBe(0);
    expect(capturedBody.generationConfig?.responseMimeType).toBe('application/json');
  });

  it('fails open immediately on timeout without throwing', async () => {
    const fakeTransport = (async (_url: string, init?: RequestInit) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      init?.signal?.throwIfAborted();
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;

    const extractor = new GeminiKeywordExtractor('/tmp', fakeTransport, dummyConfig);
    const result = await extractor.extract('test prompt', { timeoutMs: 50 });

    expect(result.status).toBe('timeout');
    expect(result.terms).toEqual([]);
    expect(result.latencyMs).toBeGreaterThanOrEqual(40);
  });

  it('fails open on upstream HTTP 500 error', async () => {
    const fakeTransport = (async () => {
      return new Response('Internal Server Error', { status: 500 });
    }) as typeof fetch;

    const extractor = new GeminiKeywordExtractor('/tmp', fakeTransport, dummyConfig);
    const result = await extractor.extract('test error handling');

    expect(result.status).toBe('error');
    expect(result.terms).toEqual([]);
  });

  it('normalizes markdown json fences defensively', async () => {
    const fakeTransport = (async () => {
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    thought: true,
                    text: 'thinking...',
                  },
                  {
                    text: '```json\n{"terms": ["cache-invariance", "sqlite-fts5"]}\n```',
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    const extractor = new GeminiKeywordExtractor('/tmp', fakeTransport, dummyConfig);
    const result = await extractor.extract('test fence fallback');

    expect(result.status).toBe('ready');
    expect(result.terms).toEqual(['cache-invariance', 'sqlite-fts5']);
  });

  it('bypasses immediately on empty input or cancelled signal', async () => {
    const extractor = new GeminiKeywordExtractor('/tmp', globalThis.fetch, dummyConfig);
    const emptyResult = await extractor.extract('   ');
    expect(emptyResult.status).toBe('bypassed');
    expect(emptyResult.terms).toEqual([]);

    const controller = new AbortController();
    controller.abort();
    const abortedResult = await extractor.extract('valid task', { signal: controller.signal });
    expect(abortedResult.status).toBe('bypassed');
    expect(abortedResult.terms).toEqual([]);
  });
});
