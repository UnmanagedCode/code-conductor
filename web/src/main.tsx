import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import '@/app/theme';
import { App } from './App';
import { startController } from '@/app/controller';
import { startAccountUsagePolling } from '@/app/accountUsage';
import { loadModels } from '@/app/models';
import { probeVoice } from '@/features/voice/store';
import { startViewedMarker } from '@/app/viewedMarker';
import { startNotifications } from '@/features/notifications';
import { startVoice } from '@/features/voice';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

startController();
startAccountUsagePolling();
void loadModels();
probeVoice();
startViewedMarker();
startNotifications();
startVoice();
