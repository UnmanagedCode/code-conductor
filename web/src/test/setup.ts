import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';
import { installConsoleFilter, installConsoleGuard } from './consoleGuard';

installConsoleFilter();
// Before cleanup: its afterEach then runs after cleanup's (hooks run in stack order).
installConsoleGuard();

// Testing Library's own default is far below testTimeout (web/vitest.config.ts): on a box shared
// with another suite, a waitFor/findBy whose condition does hold reds first. Kept well below
// testTimeout so a condition that never holds fails with its own last assertion error, not the
// runner's timeout.
configure({ asyncUtilTimeout: 5_000 });

afterEach(() => cleanup());
