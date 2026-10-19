import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect } from './harness/fixtures.ts';

// Invariant: a page on another origin cannot frame cc — the block comes from cc's own headers —
// while an unrestricted control frame on that embedder's origin loads.
test('a page on another origin cannot frame cc', async ({ page, cc }) => {
  let origin = '';
  const embedder = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(req.url === '/control'
      ? '<!doctype html><body id="control">control</body>'
      : `<!doctype html><body><iframe id="control" src="${origin}/control"></iframe><iframe id="cc" src="${cc.url}/"></iframe></body>`);
  });
  await new Promise<void>((resolve) => embedder.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(embedder.address() as AddressInfo).port}`;
  try {
    expect(origin).not.toBe(cc.url);
    await page.goto(`${origin}/`);
    await page.waitForLoadState('load');
    const control = page.frames().find((f) => f.url() === `${origin}/control`);
    expect(control, 'the control frame exists').toBeDefined();
    await expect(control!.locator('#control')).toHaveText('control');
    const ccFrame = page.frames().find((f) => f !== page.mainFrame() && f !== control);
    expect(ccFrame, 'the cc iframe exists').toBeDefined();
    await expect.poll(() => ccFrame!.url(), 'the cc frame did not navigate to cc').not.toContain(cc.url);
    expect(await ccFrame!.locator('#root').count(), 'cc did not render in the frame').toBe(0);
  } finally {
    await new Promise<void>((resolve) => embedder.close(() => resolve()));
  }
});
