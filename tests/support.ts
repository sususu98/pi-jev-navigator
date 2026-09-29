import * as fs from 'node:fs';
import * as path from 'node:path';
import type { JevSystemOneRequest, JevSystemOneResponse, JevAnswer } from '../src/types.js';

export function put(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A schema-correct offline Jev response, without any network requests. */
export function responseFor(request: Pick<JevSystemOneRequest, 'questions'>): JevSystemOneResponse {
  const answers: Record<string, JevAnswer> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    if (question.type === 'choice') {
      const keys = Object.keys(question.criteria);
      const choice = ['none', 'none_or_new', 'standard_safe'].find((key) => keys.includes(key)) ?? keys[0];
      answers[id] = { type: 'choice', choice, confidence: 1, probabilities: { [choice]: 1 } };
    } else if (question.type === 'score') {
      answers[id] = { type: 'score', score: 0, confidence: 1 };
    } else {
      answers[id] = { type: 'noul', noul: 0, confidence: 1 };
    }
  }
  return { model: 'test', answers, usage: { input_tokens: 100, output_tokens: 5 } };
}

export const offlineTransport = (async (_url, init) => {
  return Response.json(responseFor(JSON.parse(String(init?.body))));
}) as typeof fetch;
