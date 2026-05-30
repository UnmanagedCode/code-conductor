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

export function attachComposer({ form, textarea, sendBtn, attachBtn, micBtn, fileInput, chipsContainer, onSubmit }) {
  // Pending attachments, in the order the user added them. Each entry:
  //   { id, name, size, mediaType, isImage, dataBase64, objectUrl, error }
  const pending = [];
  let nextId = 1;

  let canType = false;
  let canSend = false;

  // Recording state for the mic button — declared up here because setState
  // calls refreshMicEnabled before the dictation block below would otherwise
  // initialise them. 'idle' | 'recording' | 'transcribing'.
  let recordingState = 'idle';
  let mediaRecorder = null;
  let mediaStream = null;
  let recordedChunks = [];

  function setState({ canType: ct, canSend: cs }) {
    canType = ct; canSend = cs;
    textarea.disabled = !ct;
    if (attachBtn) attachBtn.disabled = !ct;
    if (fileInput) fileInput.disabled = !ct;
    refreshMicEnabled();
    refreshSendEnabled();
  }
  setState({ canType: false, canSend: false });

  function refreshSendEnabled() {
    const hasText = textarea.value.trim().length > 0;
    const hasAtt = pending.some(p => !p.error);
    sendBtn.disabled = !canSend || (!hasText && !hasAtt);
  }
  textarea.addEventListener('input', refreshSendEnabled);

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

  // ── Dictation (mic button) ──────────────────────────────────────────
  // idle → recording → transcribing → idle. Mic is hidden by default in
  // markup; app.js reveals it after /api/transcribe/status returns
  // available:true. We never auto-record on mount; user must tap.
  function refreshMicEnabled() {
    if (!micBtn) return;
    if (recordingState === 'transcribing') micBtn.disabled = true;
    else if (recordingState === 'recording') micBtn.disabled = false;
    else micBtn.disabled = !canType;
  }

  function setMicState(next) {
    recordingState = next;
    if (micBtn) {
      micBtn.classList.toggle('recording', next === 'recording');
      micBtn.classList.toggle('transcribing', next === 'transcribing');
      micBtn.title = next === 'recording'
        ? 'Recording — tap to stop and transcribe'
        : next === 'transcribing'
          ? 'Transcribing…'
          : 'Dictate — tap to record, tap again to transcribe (local Whisper)';
    }
    refreshMicEnabled();
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
      insertAtCursor(text);
    } catch (e) {
      alert(`Transcription failed: ${e.message || e}`);
    } finally {
      setMicState('idle');
    }
  }

  if (micBtn) {
    micBtn.addEventListener('click', () => {
      if (recordingState === 'idle') void startRecording();
      else if (recordingState === 'recording') stopRecording();
    });
  }

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
    onSubmit({ text, attachments });
    textarea.value = '';
    clearAttachments();
    refreshSendEnabled();
  });

  return {
    set(state) { setState(state); },
    disable() { setState({ canType: false, canSend: false }); },
    // Drop any pending attachments + set the textarea to `text`, leaving
    // the cursor at the end so the user can edit immediately. Used after
    // a rewind/fork so the discarded prompt is one keystroke away from
    // being re-sent.
    prefill(text) {
      clearAttachments();
      textarea.value = typeof text === 'string' ? text : '';
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
