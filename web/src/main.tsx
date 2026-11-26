import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import '@/app/theme';
import { App } from './App';
import { startController } from '@/app/controller';
import { loadModels } from '@/app/models';
import { probeVoice } from '@/features/voice/store';
import { startViewedMarker } from '@/app/viewedMarker';
import { startNotifications } from '@/features/notifications';
import { startVoice } from '@/features/voice';
import { startPluginSessionBridge } from '@/features/views/pluginSession';
import { startPluginSessionWidth } from '@/features/views/pluginSessionWidth';
import { startPluginLinkHost } from '@/features/views/pluginLinkHost';
import { startResumeNotices } from '@/features/resume';
import { startViewportFollow } from '@/app/viewport';
import { startViewOnlyNotice } from '@/app/viewOnlyNotice';
import { loadCapabilities } from '@shared/capabilities';
import { readPageFocus } from '@/app/focus';

// Before the first render, so a page marked `?focus=<sid>` never paints a sidebar.
readPageFocus();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

startViewOnlyNotice();
void loadCapabilities();
startController();
void loadModels();
probeVoice();
startViewedMarker();
startNotifications();
startVoice();
startPluginSessionBridge();
startPluginSessionWidth();
startPluginLinkHost();
startResumeNotices();
startViewportFollow();
