import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, expect, vi } from 'vitest';

export interface InterceptedRequest {
  url: string;
  init: RequestInit;
}

/** Offline only: there is deliberately no saved native fetch or network fallback. */
export function installOfflineOutbound(testFile: string) {
  const file = testFile.startsWith('file:') ? fileURLToPath(testFile) : testFile;
  let requests: InterceptedRequest[] = [];
  let blocked = 0;
  let mockedRequestCount = 0;
  let unmockedRequestCount = 0;
  let permitted: { url: string; respond: (request: InterceptedRequest) => Response | Promise<Response> } | undefined;
  const cases: { fullName: string; mockedRequestCount: number; unmockedRequestCount: number }[] = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // Both the exact URL and an intercepted responder must be installed for this case.
    if (!permitted || url !== permitted.url || !new URL(url).hostname.endsWith('.invalid')) {
      blocked++;
      unmockedRequestCount++;
      throw new Error('Offline AI evaluation blocked an unexpected fetch');
    }
    const request = { url, init: { ...init } };
    requests.push(request);
    mockedRequestCount++;
    return permitted.respond(request);
  });

  // Also deny requests during suite collection; reset permissions for every case.
  vi.stubGlobal('fetch', fetchMock);
  beforeEach(() => {
    requests = [];
    blocked = 0;
    permitted = undefined;
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    cases.push({ fullName: expect.getState().currentTestName ?? '(unknown case)', mockedRequestCount: requests.length, unmockedRequestCount: blocked });
    expect(blocked, 'Unexpected fetch calls were blocked, never sent').toBe(0);
    permitted = undefined;
  });
  afterAll(() => {
    const directory = process.env.AI_EVAL_TELEMETRY_DIR;
    if (directory) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, `${basename(file)}.json`), JSON.stringify({ file, mockedRequestCount, unmockedRequestCount, cases }, null, 2) + '\n');
    }
    expect(unmockedRequestCount, 'Suite must not attempt requests without an explicit offline mock').toBe(0);
  });

  return {
    get requests() { return requests; },
    get blockedRequestCount() { return blocked; },
    respondWith(url: string, respond: (request: InterceptedRequest) => Response | Promise<Response>) {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.invalid')) {
        throw new Error('Offline AI evaluation mocks require an https://*.invalid endpoint');
      }
      permitted = { url, respond };
    },
  };
}
