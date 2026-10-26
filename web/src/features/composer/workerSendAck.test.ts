import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ACK_CAP, WORKER_SEND_ACK_KEY, ackWorkerSend, isWorkerSendAcked } from './workerSendAck';

beforeEach(() => localStorage.clear());

const stored = () => JSON.parse(localStorage.getItem(WORKER_SEND_ACK_KEY) ?? 'null');

describe('worker send ack', () => {
  it('an ack survives a module reload (vi.resetModules) under code-conductor:worker-send-ack', async () => {
    expect(WORKER_SEND_ACK_KEY).toBe('code-conductor:worker-send-ack');
    ackWorkerSend('s-persist');
    expect(stored()).toEqual(['s-persist']);
    vi.resetModules();
    const fresh = await import('./workerSendAck');
    expect(fresh.isWorkerSendAcked('s-persist')).toBe(true);
  });

  it('acks are per sessionId', () => {
    expect(isWorkerSendAcked('s-a')).toBe(false);
    ackWorkerSend('s-a');
    expect(isWorkerSendAcked('s-a')).toBe(true);
    expect(isWorkerSendAcked('s-b')).toBe(false);
  });

  it('an unparseable or non-array value reads as empty', () => {
    localStorage.setItem(WORKER_SEND_ACK_KEY, '{nope');
    expect(isWorkerSendAcked('s-g')).toBe(false);
    localStorage.setItem(WORKER_SEND_ACK_KEY, JSON.stringify({ 's-g': true }));
    expect(isWorkerSendAcked('s-g')).toBe(false);
  });

  it('an ack after an unparseable value rewrites the key as a valid array holding the sid', () => {
    localStorage.setItem(WORKER_SEND_ACK_KEY, '{nope');
    ackWorkerSend('s-repair');
    expect(stored()).toEqual(['s-repair']);
    localStorage.setItem(WORKER_SEND_ACK_KEY, JSON.stringify({ 's-repair': true }));
    ackWorkerSend('s-repair2');
    expect(stored()).toEqual(['s-repair2']);
  });

  it('with storage absent the in-memory set holds the ack for the page', () => {
    vi.stubGlobal('localStorage', undefined);
    try {
      expect(isWorkerSendAcked('s-absent')).toBe(false);
      ackWorkerSend('s-absent');
      expect(isWorkerSendAcked('s-absent')).toBe(true);
      expect(isWorkerSendAcked('s-absent-other')).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('over ACK_CAP the oldest is dropped, a re-ack refreshes', () => {
    for (let i = 0; i < ACK_CAP; i++) ackWorkerSend(`s-${i}`);
    ackWorkerSend('s-0'); // refresh the oldest
    ackWorkerSend('s-new');
    expect(stored()).toHaveLength(ACK_CAP);
    expect(isWorkerSendAcked('s-0')).toBe(true);
    expect(isWorkerSendAcked('s-1')).toBe(false);
    expect(stored().at(-1)).toBe('s-new');
    expect(stored().at(-2)).toBe('s-0');
  });

  it('an unreadable storage holds the ack in memory, per session', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } });
    try {
      expect(isWorkerSendAcked('s-mem')).toBe(false);
      ackWorkerSend('s-mem');
      expect(isWorkerSendAcked('s-mem')).toBe(true);
      expect(isWorkerSendAcked('s-other')).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(localStorage.getItem(WORKER_SEND_ACK_KEY), 'the ack never reached real storage').toBeNull();
    expect(isWorkerSendAcked('s-mem'), 'and the page still holds it').toBe(true);
  });

  it('a storage that reads but throws on write (quota) still holds the ack in memory', () => {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: () => { throw new Error('quota'); } });
    try {
      ackWorkerSend('s-quota');
      expect(data.size, 'nothing was stored').toBe(0);
      expect(isWorkerSendAcked('s-quota')).toBe(true);
      expect(isWorkerSendAcked('s-quota-other')).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a re-ack under the cap leaves one entry for the sid, moved to the end', () => {
    ackWorkerSend('s-u1');
    ackWorkerSend('s-u2');
    ackWorkerSend('s-u3');
    ackWorkerSend('s-u1');
    expect(stored()).toEqual(['s-u2', 's-u3', 's-u1']);
  });
});
