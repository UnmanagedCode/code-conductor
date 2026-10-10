import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SpeakButton } from './SpeakButton';
import { voiceStore } from './store';
import { speakStore } from './tts';
import * as tts from './tts';
import { emit } from '@/app/events';
import { startVoice } from './index';

const renderButton = () => render(<TooltipProvider><SpeakButton text="Hello" nodeId="n1" /></TooltipProvider>);

describe('SpeakButton', () => {
  beforeEach(() => {
    voiceStore.set({ ttsAvailable: true, ttsEnabled: false });
    speakStore.set({ activeNodeId: null });
  });

  it('renders nothing until TTS is available', () => {
    voiceStore.set({ ttsAvailable: false });
    const { container } = renderButton();
    expect(container.innerHTML).toBe('');
  });

  it('reads aloud on tap and shows stop while its message is the one speaking', () => {
    const toggle = vi.spyOn(tts, 'toggleSpeak').mockImplementation(() => {});
    renderButton();
    fireEvent.click(screen.getByRole('button', { name: 'Read aloud' }));
    expect(toggle).toHaveBeenCalledWith('Hello', 'n1');
    act(() => speakStore.set({ activeNodeId: 'n1' }));
    expect(screen.getByRole('button', { name: 'Stop reading' }).getAttribute('aria-pressed')).toBe('true');
    act(() => speakStore.set({ activeNodeId: 'other' }));
    expect(screen.getByRole('button', { name: 'Read aloud' })).toBeTruthy();
    toggle.mockRestore();
  });
});

describe('startVoice', () => {
  it('auto-speaks finished replies and stops playback when Speech is switched off', () => {
    const auto = vi.spyOn(tts, 'maybeAutoSpeak').mockImplementation(() => {});
    const stop = vi.spyOn(tts, 'stop').mockImplementation(() => {});
    voiceStore.set({ ttsEnabled: true });
    startVoice();
    emit('assistantText', { text: 'Done.', nodeId: 'n9' });
    expect(auto).toHaveBeenCalledWith('Done.', 'n9');
    voiceStore.set({ ttsEnabled: false });
    expect(stop).toHaveBeenCalledTimes(1);
    auto.mockRestore();
    stop.mockRestore();
  });
});
