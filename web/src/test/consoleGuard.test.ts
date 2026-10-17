import { describe, expect, it, vi } from 'vitest';
import { dropFromError, isHappyDomIframeDisabledNotice } from './consoleGuard';

const MESSAGE = (url: string) => `Failed to load iframe page "${url}". Iframe page loading is disabled.`;
const notice = (url: string) => new DOMException(MESSAGE(url), 'NotSupportedError');

describe('isHappyDomIframeDisabledNotice', () => {
  it('accepts the exact notice for a shared-frame and a resident-frame URL', () => {
    expect(isHappyDomIframeDisabledNotice([notice('http://localhost/plugins/a/')])).toBe(true);
    expect(isHappyDomIframeDisabledNotice([notice('http://localhost/plugins/a/?resident=1#/x')])).toBe(true);
  });

  it('rejects anything but that one error object', () => {
    expect(isHappyDomIframeDisabledNotice([MESSAGE('http://x/')])).toBe(false);
    expect(isHappyDomIframeDisabledNotice([new DOMException(MESSAGE('http://x/'), 'SecurityError')])).toBe(false);
    expect(isHappyDomIframeDisabledNotice([new DOMException('Failed to load iframe page "http://x/".', 'NotSupportedError')])).toBe(false);
    expect(isHappyDomIframeDisabledNotice([notice('http://x/'), 'extra'])).toBe(false);
    expect(isHappyDomIframeDisabledNotice([])).toBe(false);
  });
});

describe('isHappyDomIframeDisabledNotice exactness', () => {
  const asNotice = (message: string) => new DOMException(message, 'NotSupportedError');

  it('rejects the notice text with anything before it', () => {
    expect(isHappyDomIframeDisabledNotice([asNotice(`prefix: ${MESSAGE('http://x/')}`)])).toBe(false);
  });

  it('rejects the notice text with anything after it', () => {
    expect(isHappyDomIframeDisabledNotice([asNotice(`${MESSAGE('http://x/')} trailing`)])).toBe(false);
  });

  it('rejects a message whose quoted URL slot contains a quote', () => {
    expect(isHappyDomIframeDisabledNotice([asNotice('Failed to load iframe page "a" x "b". Iframe page loading is disabled.')])).toBe(false);
  });
});

describe('dropFromError', () => {
  it('drops a matching call and forwards every other call once, untouched', () => {
    const original = vi.fn();
    const target = { error: original };
    dropFromError(target, isHappyDomIframeDisabledNotice);
    target.error(notice('http://x/'));
    expect(original).not.toHaveBeenCalled();
    target.error('boom %d', 3);
    expect(original).toHaveBeenCalledOnce();
    expect(original).toHaveBeenCalledWith('boom %d', 3);
  });
});
