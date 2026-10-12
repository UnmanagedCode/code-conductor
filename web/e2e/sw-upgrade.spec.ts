import { test } from '@playwright/test';
import { nothingOldServedFlow, workerReplacedFlow } from './sw-upgrade.shared.ts';

test('a client of the old UI\'s root service worker gets the web UI at / and the web UI\'s worker in place of the old one, in the same registration', workerReplacedFlow);
test('after the upgrade nothing comes from a service worker or the old UI, and /#session=<sid> opens that session', nothingOldServedFlow);
