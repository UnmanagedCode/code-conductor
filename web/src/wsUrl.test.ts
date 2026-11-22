// Invariant: the UI's WebSocket connects to /ws under the directory of the page that loaded it, with the page's scheme.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect } from '@shared/ws';

afterEach(() => {
  vi.unstubAllGlobals();
  (window as any).happyDOM.setURL('http://localhost:3000/');
});

function urlConnectedTo(pageUrl: string): string {
  (window as any).happyDOM.setURL(pageUrl);
  const urls: string[] = [];
  class FakeSocket {
    static CLOSED = 3;
    readyState = 0;
    constructor(u: string) { urls.push(u); }
    addEventListener() {}
    close() {}
  }
  vi.stubGlobal('WebSocket', FakeSocket);
  connect();
  return urls[0];
}

describe('ws connect URL', () => {
  it('is /ws at root', () => {
    expect(urlConnectedTo('http://h:8787/')).toBe('ws://h:8787/ws');
  });
  it('is under the page directory when hosted under a prefix, wss on https', () => {
    expect(urlConnectedTo('https://h/p/q/#session=x')).toBe('wss://h/p/q/ws');
  });
});
