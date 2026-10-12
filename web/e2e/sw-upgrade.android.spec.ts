import { test } from '@playwright/test';
import { nothingOldServedFlow, workerReplacedFlow } from './sw-upgrade.shared.ts';

test('a client of the old UI\'s root service worker gets the web UI at /: the browser updates the worker in place, in the same registration, and the web UI registers /sw.js', workerReplacedFlow);
test('after the upgrade nothing comes from a service worker or the old UI, and /#session=<sid> opens that session', nothingOldServedFlow);
