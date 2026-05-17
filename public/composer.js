// Wires composer DOM (textarea + send button) to a sendPrompt callback.
// Enter submits, Shift+Enter inserts a newline.

export function attachComposer({ form, textarea, sendBtn, onSubmit }) {
  function setState({ canType, canSend }) {
    textarea.disabled = !canType;
    sendBtn.disabled = !canSend;
  }
  setState({ canType: false, canSend: false });

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
    if (!text) return;
    onSubmit(text);
    textarea.value = '';
  });

  return {
    set(state) { setState(state); },
    disable() { setState({ canType: false, canSend: false }); },
  };
}
