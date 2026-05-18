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

export function attachComposer({ form, textarea, sendBtn, attachBtn, fileInput, chipsContainer, onSubmit }) {
  // Pending attachments, in the order the user added them. Each entry:
  //   { id, name, size, mediaType, isImage, dataBase64, objectUrl, error }
  const pending = [];
  let nextId = 1;

  let canType = false;
  let canSend = false;

  function setState({ canType: ct, canSend: cs }) {
    canType = ct; canSend = cs;
    textarea.disabled = !ct;
    if (attachBtn) attachBtn.disabled = !ct;
    if (fileInput) fileInput.disabled = !ct;
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
  };
}
