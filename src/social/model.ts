import { GoogleGenAI } from '@google/genai';

/** A JSON-answering model. `system` is the trusted instruction; `prompt` may carry quoted untrusted data. */
export interface Model {
  json<T>(model: string, prompt: string, system?: string): Promise<T>;
}

/** The part of the Gemini client this module uses (the same shape as src/fund/judge.ts). */
export interface GeminiLike {
  models: { generateContent(params: { model: string; contents: string; config: Record<string, unknown> }): Promise<unknown> };
}

/** The day's Gemini call budget is spent: no call was made. */
export class GeminiCapError extends Error {
  constructor() {
    super('gemini cap: the daily Gemini call budget is spent');
    this.name = 'GeminiCapError';
  }
}

/** v1beta serves the `-latest` aliases; v1 answers 404 for them (see src/fund/judge.ts). */
export const GEMINI_API_VERSION = 'v1beta';
/** One call's limit; a call that times out fails this attempt only. */
export const GEMINI_TIMEOUT_MS = 120_000;
/** Room for thinking before the answer; a short limit cuts the JSON off (MAX_TOKENS, a failure). */
export const GEMINI_MAX_TOKENS = 8000;

/**
 * A Model over Gemini. `allowCall` is asked once per call, before anything else; false throws GeminiCapError and
 * no request is made. A blocked prompt, a finish reason other than STOP, an empty answer or unparsable JSON throws.
 * `client` is for tests; by default a client is built on first use.
 */
export function geminiModel(apiKey: string, allowCall: () => boolean, client?: GeminiLike): Model {
  let c = client;
  return {
    async json<T>(model: string, prompt: string, system?: string): Promise<T> {
      if (!allowCall()) throw new GeminiCapError();
      c ??= new GoogleGenAI({ apiKey, apiVersion: GEMINI_API_VERSION, httpOptions: { timeout: GEMINI_TIMEOUT_MS, retryOptions: { attempts: 1 } } }) as unknown as GeminiLike;
      const config: Record<string, unknown> = { maxOutputTokens: GEMINI_MAX_TOKENS, responseMimeType: 'application/json' };
      if (system !== undefined) config.systemInstruction = system;
      const res = (await c.models.generateContent({ model, contents: prompt, config })) as {
        promptFeedback?: { blockReason?: string };
        candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
      };
      if (res?.promptFeedback?.blockReason) throw new Error(`gemini blocked the prompt: ${res.promptFeedback.blockReason}`);
      const cand = res?.candidates?.[0];
      if (!cand) throw new Error('gemini returned no candidate');
      if (cand.finishReason !== 'STOP') throw new Error(`gemini did not finish: ${cand.finishReason ?? 'no finish reason'}`);
      const text = (cand.content?.parts ?? [])
        .filter((p) => !p.thought && typeof p.text === 'string')
        .map((p) => p.text)
        .join('');
      if (!text) throw new Error('gemini returned no text');
      return JSON.parse(text) as T;
    },
  };
}
