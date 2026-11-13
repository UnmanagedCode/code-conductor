import { createStore } from '@/state/createStore';
import type { ResumeNotice } from './api';

// The continue notices a gated restore is holding, and whether a Continue or
// Dismiss is in flight.
export const resumeNoticesStore = createStore<{ notices: ResumeNotice[]; busy: boolean }>({ notices: [], busy: false });
