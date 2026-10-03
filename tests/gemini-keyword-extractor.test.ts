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

  it('sends bounded recent context as data with a constant system prompt and parses precise groups', async () => {
    const requests: any[] = [];
    const extractor = new GeminiKeywordExtractor('/tmp', (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({
        terms: ['Orchid capsule', '租户隔离'], queryGroups: [['Orchid', 'capsule'], ['租户隔离']],
      }) }] } }] });
    }) as typeof fetch, dummyConfig);
    const recentContext = [{ role: 'user' as const, text: 'Implement Orchid capsule with tenant isolation' }];
    const result = await extractor.extract('continue', { recentContext });
    expect(result.queryGroups).toEqual([['Orchid', 'capsule'], ['租户隔离']]);
    expect(JSON.parse(requests[0].contents[0].parts[0].text)).toEqual({ current_request: 'continue', recent_context: recentContext });
    await extractor.extract('switch topic', { recentContext: [{ role: 'assistant', text: 'x'.repeat(10000) }] });
    expect(requests[0].systemInstruction).toEqual(requests[1].systemInstruction);
    expect(requests[1].generationConfig.responseSchema.required).toEqual(['needsMemory', 'subject', 'terms', 'queryGroups', 'memoryTargets']);
    expect(requests[1].contents[0].parts[0].text.length).toBeLessThan(1500);
  });

  it('accepts intentional empty groups without inventing terms', async () => {
    const extractor = new GeminiKeywordExtractor('/tmp', (async () => Response.json({
      candidates: [{ content: { parts: [{ text: '{"needsMemory":false,"terms":["stale subject"],"queryGroups":[["stale subject"]]}' }] } }],
    })) as typeof fetch, dummyConfig);
    const result = await extractor.extract('thanks');
    expect(result.status).toBe('ready');
    expect(result.terms).toEqual([]);
    expect(result.queryGroups).toEqual([]);
  });

  it('fails open on invalid query groups instead of converting them to an intentional empty result', async () => {
    for (const queryGroups of [[['ab']], [[]], [['㍿'.repeat(9)]], [[12]], 'invalid']) {
      const extractor = new GeminiKeywordExtractor('/tmp', (async () => Response.json({
        candidates: [{ content: { parts: [{ text: JSON.stringify({ terms: ['Orchid'], queryGroups }) }] } }],
      })) as typeof fetch, dummyConfig);
      const result = await extractor.extract('Orchid');
      expect(result.status).toBe('error');
      expect(result.terms).toEqual([]);
      expect(result.queryGroups).toBeUndefined();
    }
  });

  it('keeps a dedicated subject-only anchor apart from workflow refinements', async () => {
    const extractor = new GeminiKeywordExtractor('/tmp', (async () => Response.json({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ needsMemory: true, subject: 'Orchid capsule',
        terms: ['Orchid capsule', 'regression tests'], queryGroups: [['Orchid capsule', 'regression tests']] }) }] } }],
    })) as typeof fetch, dummyConfig);
    expect((await extractor.extract('continue testing')).queryGroups).toEqual([['Orchid capsule'], ['Orchid capsule', 'regression tests']]);
  });

  it('rejects unknown needsMemory types and deduplicates subject before the four-group cap', async () => {
    const response = (value: unknown) => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }] });
    for (const needsMemory of ['false', null, 0]) {
      const extractor = new GeminiKeywordExtractor('/tmp', (async () => response({ needsMemory, terms: [], queryGroups: [] })) as typeof fetch, dummyConfig);
      expect((await extractor.extract('Orchid capsule')).status).toBe('error');
    }
    const groups = [['Orchid capsule'], ['tenant isolation'], ['queue refresh'], ['capsule lineage']];
    const extractor = new GeminiKeywordExtractor('/tmp', (async () => response({ needsMemory: true, subject: 'Orchid capsule',
      terms: ['Orchid capsule'], queryGroups: groups })) as typeof fetch, dummyConfig);
    expect((await extractor.extract('continue')).queryGroups).toEqual(groups);
  });

  it('validates model-selected Hermes targets without allowing arbitrary project names', async () => {
    for (const memoryTargets of [['foreign-project'], ['session'], ['failure', 12], []]) {
      const extractor = new GeminiKeywordExtractor('/tmp', (async () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({
        needsMemory: true, subject: 'Orchid capsule', terms: ['Orchid capsule'], queryGroups: [['Orchid capsule']], memoryTargets,
      }) }] } }] })) as typeof fetch, dummyConfig);
      expect((await extractor.extract('continue')).status).toBe('error');
    }
    const extractor = new GeminiKeywordExtractor('/tmp', (async () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({
      needsMemory: true, subject: 'Orchid capsule', terms: ['Orchid capsule'], queryGroups: [['Orchid capsule']], memoryTargets: ['project', 'failure'],
    }) }] } }] })) as typeof fetch, dummyConfig);
    expect((await extractor.extract('continue')).memoryTargets).toEqual(['project', 'failure']);
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
