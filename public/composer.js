// Wires composer DOM (textarea + send button + attach button + chips strip)
// to a sendPrompt callback. Enter submits, Shift+Enter inserts a newline.
// Files attached via the + button, paste, or drag-and-drop are surfaced as
// chips above the textarea and handed off to onSubmit alongside the text.

// Soft cap so the WS payload stays sane. base64 inflates by ~33%, and the
// `ws` lib's default maxPayload is 100MB, so 10MB raw / ~13MB encoded is a
// comfortable ceiling for screenshots and small docs.
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

async function fileToBase64(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function isImageMediaType(mt) {
  return typeof mt === 'string' && /^image\/(png|jpeg|gif|webp)$/i.test(mt);
}

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Prepend a <transcribed> marker tag to a message that includes dictated text,
// so the receiving instance knows it contains speech-to-text that may have
// transcription errors. Applied only at send time — the composer keeps the
// dictated text plain while you edit it. No-op when there's no transcript or
// the message is empty (e.g. an attachment-only send).
export function prependTranscribedTag(text, hasTranscript) {
  if (!hasTranscript || !text) return text;
  return `<transcribed>\n${text}`;
}

export function attachComposer({ form, textarea, sendBtn, attachBtn, fileInput, chipsContainer, onSubmit }) {
  // Pending attachments, in the order the user added them. Each entry:
  //   { id, name, size, mediaType, isImage, dataBase64, objectUrl, error }
  const pending = [];
  let nextId = 1;

  let canType = false;
  let canSend = false;

  // Whether the server has whisper.cpp + the model on disk. Flipped by
  // app.js via setMicAvailable() once /api/transcribe/status resolves. When
  // false, an empty composer just shows a disabled Send (no mic affordance).
  let micAvailable = false;

  // Recording state for the merged Send/mic button — declared up here because
  // setState calls updateButton before the dictation block below would
  // otherwise initialise them. 'idle' | 'recording' | 'transcribing'.
  let recordingState = 'idle';
  let mediaRecorder = null;
  let mediaStream = null;
  let recordedChunks = [];
  // True once dictation has contributed to the current draft, so the message
  // gets a leading <transcribed> tag at send time. Reset on send, on prefill,
  // and whenever the composer is emptied (so a cleared-then-retyped draft
  // doesn't inherit a stale tag).
  let hasTranscript = false;
  let wakeLock = null;

  function setState({ canType: ct, canSend: cs }) {
    canType = ct; canSend = cs;
    textarea.disabled = !ct;
    if (attachBtn) attachBtn.disabled = !ct;
    if (fileInput) fileInput.disabled = !ct;
    updateButton();
  }
  setState({ canType: false, canSend: false });

  // Single source of truth for the Send/mic button's mode, label, icon,
  // enabled state, and title. Mode is content-driven (WhatsApp-style):
  // empty + session active → mic (tap-to-toggle); otherwise → Send.
  function updateButton() {
    const hasContent = textarea.value.trim().length > 0 || pending.some(p => !p.error);
    let mode;
    if (recordingState === 'recording') mode = 'recording';
    else if (recordingState === 'transcribing') mode = 'transcribing';
    else if (hasContent) mode = 'send';
    else if (canType) mode = 'mic';
    else mode = 'send';

    sendBtn.classList.toggle('mode-mic', mode === 'mic');
    sendBtn.classList.toggle('mode-send', mode === 'send');
    sendBtn.classList.toggle('recording', mode === 'recording');
    sendBtn.classList.toggle('transcribing', mode === 'transcribing');

    if (mode === 'recording') {
      sendBtn.disabled = false;
      sendBtn.title = 'Recording — tap to stop and transcribe';
    } else if (mode === 'transcribing') {
      sendBtn.disabled = true;
      sendBtn.title = 'Transcribing…';
    } else if (mode === 'mic') {
      sendBtn.disabled = !micAvailable;
      sendBtn.title = micAvailable
        ? 'Tap to start recording — tap again to stop and transcribe'
        : 'Install Whisper to enable voice dictation (Settings → Transcribe)';
    } else {
      sendBtn.disabled = !canSend || !hasContent;
      sendBtn.title = 'Send message';
    }
  }
  // Alias so the existing call sites keep reading naturally.
  const refreshSendEnabled = updateButton;
  function autoGrow() {
    textarea.style.height = 'auto';
    const capped = textarea.scrollHeight > 240;
    textarea.style.overflowY = capped ? 'auto' : 'hidden';
    textarea.style.height = Math.min(textarea.scrollHeight, 240) + 'px';
  }

  textarea.addEventListener('input', updateButton);
  // Clearing the composer by hand drops the transcribed-content marker.
  textarea.addEventListener('input', () => { if (!textarea.value.trim()) hasTranscript = false; });
  textarea.addEventListener('input', autoGrow);

  function renderChips() {
    if (!chipsContainer) return;
    chipsContainer.textContent = '';
    if (!pending.length) { chipsContainer.hidden = true; return; }
    chipsContainer.hidden = false;
    for (const att of pending) {
      const chip = document.createElement('div');
      chip.className = 'composer-attachment-chip' + (att.error ? ' has-error' : '');
      if (att.isImage && att.objectUrl) {
        const img = document.createElement('img');
        img.src = att.objectUrl;
        img.alt = att.name;
        chip.appendChild(img);
      } else {
        const icon = document.createElement('span');
        icon.className = 'cac-icon';
        icon.textContent = '📎';
        chip.appendChild(icon);
      }
      const meta = document.createElement('span');
      meta.className = 'cac-meta';
      meta.textContent = att.error
        ? `${att.name} — ${att.error}`
        : `${att.name} · ${fmtSize(att.size)}`;
      chip.appendChild(meta);
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'cac-remove';
      rm.title = 'Remove attachment';
      rm.textContent = '×';
      rm.addEventListener('click', () => removeAttachment(att.id));
      chip.appendChild(rm);
      chipsContainer.appendChild(chip);
    }
  }

  function removeAttachment(id) {
    const idx = pending.findIndex(p => p.id === id);
    if (idx < 0) return;
    const a = pending[idx];
    if (a.objectUrl) URL.revokeObjectURL(a.objectUrl);
    pending.splice(idx, 1);
    renderChips();
    refreshSendEnabled();
  }

  function clearAttachments() {
    for (const a of pending) if (a.objectUrl) URL.revokeObjectURL(a.objectUrl);
    pending.length = 0;
    renderChips();
  }

  async function addFile(file) {
    if (!file) return;
    const id = nextId++;
    const mediaType = file.type || 'application/octet-stream';
    const isImage = isImageMediaType(mediaType);
    const entry = { id, name: file.name || 'file', size: file.size, mediaType, isImage };
    if (file.size > MAX_ATTACHMENT_BYTES) {
      entry.error = `too large (max ${fmtSize(MAX_ATTACHMENT_BYTES)})`;
      pending.push(entry);
      renderChips();
      refreshSendEnabled();
      return;
    }
    if (isImage) {
      try { entry.objectUrl = URL.createObjectURL(file); } catch { /* no preview */ }
    }
    pending.push(entry);
    renderChips();
    refreshSendEnabled();
    try {
      entry.dataBase64 = await fileToBase64(file);
    } catch (e) {
      entry.error = `read failed: ${e.message ?? e}`;
    }
    renderChips();
    refreshSendEnabled();
  }

  if (attachBtn && fileInput) {
    attachBtn.addEventListener('click', () => { if (!attachBtn.disabled) fileInput.click(); });
    fileInput.addEventListener('change', async () => {
      const files = Array.from(fileInput.files || []);
      fileInput.value = '';
      for (const f of files) await addFile(f);
    });
  }

  // Paste handler — screenshots from the clipboard arrive as files here.
  textarea.addEventListener('paste', async (e) => {
    if (!canType) return;
    const files = Array.from(e.clipboardData?.files || []);
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) await addFile(f);
  });

  // Drag-and-drop onto the whole composer form.
  form.addEventListener('dragover', (e) => {
    if (!canType) return;
    if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
    e.preventDefault();
    form.classList.add('drag-over');
  });
  form.addEventListener('dragleave', () => form.classList.remove('drag-over'));
  form.addEventListener('drop', async (e) => {
    form.classList.remove('drag-over');
    if (!canType) return;
    const files = Array.from(e.dataTransfer?.files || []);
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) await addFile(f);
  });

  // ── Dictation (hold the Send button while the composer is empty) ──────
  // idle → recording → transcribing → idle. The merged Send/mic button only
  // offers the mic affordance when the composer is empty and whisper is
  // installed; updateButton() owns the visuals. We never auto-record.
  async function acquireWakeLock() {
    if (!navigator.wakeLock) return;
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch { /* unavailable */ }
  }
  function releaseWakeLock() {
    if (!wakeLock) return;
    try { wakeLock.release(); } catch { /* ignore */ }
    wakeLock = null;
  }

  function setMicState(next) {
    if (next === 'recording') void acquireWakeLock();
    else if (next === 'idle') releaseWakeLock();
    recordingState = next;
    updateButton();
  }

  function insertAtCursor(text) {
    if (!text) return;
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    // Add a space between adjacent words so back-to-back dictations don't run together.
    const needsLeadingSpace = before.length > 0 && !/\s$/.test(before) && !/^\s/.test(text);
    const insert = (needsLeadingSpace ? ' ' : '') + text;
    textarea.value = before + insert + after;
    autoGrow();
    const caret = start + insert.length;
    try { textarea.setSelectionRange(caret, caret); } catch { /* ignore */ }
    try { textarea.focus(); } catch { /* ignore */ }
    refreshSendEnabled();
  }

  async function startRecording() {
    if (recordingState !== 'idle') return;
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      alert(`Microphone access denied: ${e.message || e}`);
      return;
    }
    recordedChunks = [];
    try {
      mediaRecorder = new MediaRecorder(mediaStream);
    } catch (e) {
      stopMediaTracks();
      alert(`MediaRecorder unavailable: ${e.message || e}`);
      return;
    }
    mediaRecorder.addEventListener('dataavailable', (ev) => {
      if (ev.data && ev.data.size > 0) recordedChunks.push(ev.data);
    });
    mediaRecorder.addEventListener('stop', () => {
      const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      stopMediaTracks();
      recordedChunks = [];
      void postForTranscript(blob);
    });
    mediaRecorder.start();
    setMicState('recording');
  }

  function stopRecording() {
    if (recordingState !== 'recording' || !mediaRecorder) return;
    setMicState('transcribing');
    try { mediaRecorder.stop(); } catch { /* fall through to cleanup */ }
  }

  function stopMediaTracks() {
    if (mediaStream) {
      for (const t of mediaStream.getTracks()) try { t.stop(); } catch { /* ignore */ }
      mediaStream = null;
    }
    mediaRecorder = null;
  }

  async function postForTranscript(blob) {
    try {
      const res = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'content-type': blob.type || 'audio/webm' },
        body: blob,
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      const { text } = await res.json();
      if (text && text.trim()) hasTranscript = true;
      insertAtCursor(text);
    } catch (e) {
      alert(`Transcription failed: ${e.message || e}`);
    } finally {
      setMicState('idle');
    }
  }

  // Whether the button is currently acting as a tap-to-record mic (empty
  // composer, whisper installed, not already mid-recording/transcribing).
  function inMicMode() {
    return sendBtn.classList.contains('mode-mic') && recordingState === 'idle';
  }

  // Suppress long-press text-selection / callout on Android when the button
  // is in mic or recording mode (no hold gesture needed for tap-toggle, but
  // the OS still fires long-press on a sustained finger contact).
  sendBtn.addEventListener('pointerdown', (e) => {
    if (inMicMode() || recordingState === 'recording') e.preventDefault();
  });

  // Tap-toggle: first tap starts recording, second tap stops and transcribes.
  // A plain click sends when there's content; transcribing clicks are ignored.
  sendBtn.addEventListener('click', () => {
    if (sendBtn.classList.contains('mode-send') && !sendBtn.disabled) {
      form.requestSubmit();
    } else if (inMicMode()) {
      void startRecording();
    } else if (recordingState === 'recording') {
      stopRecording();
    }
  });

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!sendBtn.disabled) form.requestSubmit();
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (sendBtn.disabled) return;
    const text = textarea.value.trim();
    // Only ship attachments that finished encoding and have no error.
    const ready = pending.filter(p => !p.error && typeof p.dataBase64 === 'string');
    if (!text && ready.length === 0) return;
    const attachments = ready.map(p => ({
      name: p.name, mediaType: p.mediaType, dataBase64: p.dataBase64,
    }));
    onSubmit({ text: prependTranscribedTag(text, hasTranscript), attachments });
    textarea.value = '';
    autoGrow();
    hasTranscript = false;
    clearAttachments();
    refreshSendEnabled();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && recordingState !== 'idle') void acquireWakeLock();
  });

  autoGrow();
  return {
    set(state) { setState(state); },
    disable() { setState({ canType: false, canSend: false }); },
    // app.js flips this on once /api/transcribe/status confirms whisper is
    // installed; an empty composer then turns the Send button into a mic.
    setMicAvailable(v) { micAvailable = !!v; updateButton(); },
    // Drop any pending attachments + set the textarea to `text`, leaving
    // the cursor at the end so the user can edit immediately. Used after
    // a rewind/fork so the discarded prompt is one keystroke away from
    // being re-sent.
    prefill(text) {
      clearAttachments();
      hasTranscript = false;
      textarea.value = typeof text === 'string' ? text : '';
      autoGrow();
      // Move caret to end and focus — `focus()` is a no-op when the textarea
      // is disabled, which is fine: the user can still see the value, and
      // it'll focus when the next status transition flips canType on.
      try { textarea.focus(); } catch { /* ignore */ }
      try { textarea.setSelectionRange(textarea.value.length, textarea.value.length); }
      catch { /* ignore */ }
      refreshSendEnabled();
    },
  };
}
