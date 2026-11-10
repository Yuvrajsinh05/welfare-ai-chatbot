'use client';
/** Message editor: Enter submits, Shift+Enter adds a line, and IME composition never sends accidentally. */
import { useEffect, useRef, type FormEvent } from 'react';

type Props = {
  draft: string;
  onChange: (value: string) => void;
  onSend: (event: FormEvent<HTMLFormElement>) => void;
  busy: boolean;
  ready: boolean;
};

export default function ChatComposer({ draft, onChange, onSend, busy, ready }: Props) {
  const editor = useRef<HTMLTextAreaElement>(null);
  const wasBusy = useRef(busy);

  useEffect(() => {
    const field = editor.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, 160)}px`;
  }, [draft]);

  useEffect(() => {
    // Restore keyboard focus after a reply without stealing focus on the first page load.
    if (wasBusy.current && !busy) editor.current?.focus();
    wasBusy.current = busy;
  }, [busy]);

  return <>
    <form className="composer composer-refined" onSubmit={onSend} aria-busy={busy}>
      <label className="sr-only" htmlFor="message">Your message</label>
      <textarea
        ref={editor}
        id="message"
        placeholder="What would you like help with?"
        value={draft}
        onChange={event => onChange(event.target.value)}
        onKeyDown={event => {
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          event.preventDefault();
          if (!event.repeat && ready && !busy && draft.trim()) event.currentTarget.form?.requestSubmit();
        }}
        readOnly={busy}
        aria-describedby="composer-hint"
        maxLength={2000}
        rows={1}
        required
      />
      <button className="send-button" disabled={busy || !ready || !draft.trim()} type="submit" aria-label={busy ? 'Sending message' : 'Send message'} title="Send message (Enter)">
        {busy ? <span className="send-spinner" aria-hidden="true" /> : <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>}
      </button>
    </form>
    <div className="composer-footer"><span id="composer-hint"><kbd>Enter</kbd> to send <span aria-hidden="true">·</span> <kbd>Shift + Enter</kbd> for a new line</span><span aria-label={`${draft.length} of 2000 characters`}>{draft.length}/2000</span></div>
  </>;
}
