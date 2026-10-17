import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { installConsoleFilter, installConsoleGuard } from './consoleGuard';

installConsoleFilter();
// Before cleanup: its afterEach then runs after cleanup's (hooks run in stack order).
installConsoleGuard();

afterEach(() => cleanup());
