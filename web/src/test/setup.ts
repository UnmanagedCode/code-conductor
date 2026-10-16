import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { installConsoleFilter } from './consoleGuard';

installConsoleFilter();

afterEach(() => cleanup());
