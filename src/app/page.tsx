'use client';
/**
 * Student chat page.
 * - Restores the conversation from the cookie on load.
 * - Shows emergency numbers instantly from local safety signals, before the server even answers.
 * - A failed send keeps the text AND its requestId, so retrying can never create a duplicate case.
 */
import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { requestJson } from '../lib/client-api';
import { emergencyText, riskSignals } from '../lib/safety';
import type { PublicTurn } from '../lib/conversation-service';
import type { Resource } from '../lib/catalogue';
import ChatComposer from './chat-composer';

type Conversation = { greeting: string; turns: PublicTurn[]; contact: { name?: string; email?: string } };
const SUGGESTIONS = ['Where can I find past exam papers?', 'My scholarship payment is delayed.', 'I need help but don’t know where to start.'];

export default function StudentPage() {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [showEmergency, setShowEmergency] = useState(false);
  const retry = useRef<{ text: string; requestId: string } | null>(null);
  const end = useRef<HTMLDivElement>(null);

  async function load() {
    try {
      const data = await requestJson<Conversation>('/api/conversations', 'POST');
      console.log("DATA",data)
      setConversation(data);
      setShowEmergency(data.turns.some(turn => turn.emergency));
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [conversation?.turns.length, sending]);

  async function send(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    // Reuse the requestId when retrying the same text, so the server can return the already-saved result.
    const request = retry.current?.text === text ? retry.current : { text, requestId: crypto.randomUUID() };
    retry.current = request;
    if (riskSignals(text).danger) setShowEmergency(true);
    setSending(text);
    setDraft('');
    setError('');
    try {
      const { turn } = await requestJson<{ turn: PublicTurn }>('/api/chat', 'POST', request);
      setConversation(current => current && { ...current, turns: [...current.turns.filter(t => t.id !== turn.id), turn] });
      if (turn.emergency) setShowEmergency(true);
      retry.current = null;
    } catch (err) {
      setError((err as Error).message);
      setDraft(text);
    } finally {
      setSending(null);
    }
  }

  const emergency = showEmergency || riskSignals(draft).danger;

  return (
    <div className="app-shell">
      <header className="topbar">
        <Link className="brand" href="/"><span className="brand-mark">s.</span> student support</Link>
        <Link className="quiet-link" href="/staff">Staff workspace <span aria-hidden="true">↗</span></Link>
      </header>

      <main className="student-layout">
        <aside className="intro">
          <span className="eyebrow">A LITTLE SUPPORT GOES A LONG WAY</span>
          <h1>Let’s find your<br />next step.</h1>
          <p>Money, studying, housing, or how you’re feeling. You don’t need to have it all figured out to start.</p>
          <div className="support-note">
            <span className="small-icon" aria-hidden="true">✳</span>
            <div>
              <strong>How this works</strong>
              <p>I answer from the university’s own guidance, ask if I need more detail, and bring in a member of staff when that’s the right next step.</p>
            </div>
          </div>
          {conversation && <ContactPanel initial={conversation.contact} />}
          <p className="demo-note">Demo for an assessment: please use made-up details.</p>
        </aside>

        <section className="chat-panel" aria-label="Student support conversation">
          <div className="chat-heading">
            <span className="assistant-avatar" aria-hidden="true">✳</span>
            <div><h2>Your support assistant</h2><span>Guidance, one step at a time</span></div>
          </div>

          <div className="messages" role="log" aria-live="polite">
            <Bubble who="assistant" text={conversation?.greeting ?? 'Hi, I’m the student support assistant. What’s going on?'} />
            {conversation && !conversation.turns.length && !sending && (
              <div className="suggestions">
                {SUGGESTIONS.map(text => <button key={text} onClick={() => setDraft(text)}>{text}<span aria-hidden="true"> ↗</span></button>)}
              </div>
            )}
            {conversation?.turns.map(turn => (
              <div key={turn.id}>
                <Bubble who="student" text={turn.text} />
                <AssistantTurn turn={turn} />
              </div>
            ))}
            {sending && <><Bubble who="student" text={sending} /><TypingIndicator /></>}
            <div ref={end} />
          </div>

          <div className="composer-area">
            {emergency && <EmergencyBanner />}
            {error && (
              <div className="error" role="alert">
                {error}
                {!conversation && <button className="text-button" onClick={() => void load()}>Try again</button>}
              </div>
            )}
            <ChatComposer draft={draft} onChange={setDraft} onSend={send} busy={Boolean(sending)} ready={Boolean(conversation)} />
          </div>
        </section>
      </main>
    </div>
  );
}

function Bubble({ who, text, children }: { who: 'student' | 'assistant'; text: string; children?: React.ReactNode }) {
  return (
    <article className={`message ${who}`}>
      <span className="message-label">{who === 'student' ? 'YOU' : 'SUPPORT ASSISTANT'}</span>
      <p>{text}</p>
      {children}
    </article>
  );
}

function AssistantTurn({ turn }: { turn: PublicTurn }) {
  return (
    <Bubble who="assistant" text={turn.reply ?? 'Still working on this. If nothing appears, send your message again.'}>
      {turn.disposition === 'escalate' && <span className="handoff-label">Passed to the support team</span>}
      {turn.resources.map(resource => <ResourceCard key={resource.id} resource={resource} />)}
    </Bubble>
  );
}

/** Typing bubble; after a few seconds it reassures the student that the message is still being worked on. */
function TypingIndicator() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 6000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <article className="message assistant typing" role="status" aria-label="The assistant is replying">
      <span className="message-label">SUPPORT ASSISTANT</span>
      <p><span className="dots" aria-hidden="true"><i /><i /><i /></span>{slow && <span className="slow-note"> Still with you, just checking the guidance…</span>}</p>
    </article>
  );
}

function ResourceCard({ resource }: { resource: Resource }) {
  const external = resource.url.startsWith('https://') || resource.url.startsWith('tel:');
  return (
    <div className="resource-card">
      <span>RESOURCE</span>
      {external
        ? <a href={resource.url} target="_blank" rel="noreferrer">{resource.title} ↗</a>
        : <><strong>{resource.title}</strong><small>{resource.url}</small></>}
    </div>
  );
}

function EmergencyBanner() {
  return (
    <p className="emergency-banner" role="alert">
      If you might be in immediate danger, call <a href="tel:999">999</a>. For urgent emotional support, call Samaritans free
      on <a href="tel:116123">116 123</a>, any time. <span className="sr-only">{emergencyText}</span>
    </p>
  );
}

/** Name and email so staff can follow up. Optional to start chatting, so urgent help is never blocked by a form. */
function ContactPanel({ initial }: { initial: { name?: string; email?: string } }) {
  const [name, setName] = useState(initial.name ?? '');
  const [email, setEmail] = useState(initial.email ?? '');
  const [status, setStatus] = useState(initial.name && initial.email ? 'Saved.' : '');

  async function save(event: FormEvent) {
    event.preventDefault();
    setStatus('Saving…');
    try {
      await requestJson('/api/conversations', 'PATCH', { name, email });
      setStatus('Saved. Staff can now reach you if needed.');
    } catch (err) {
      setStatus((err as Error).message);
    }
  }

  return (
    <section className="contact-panel" aria-label="Your details">
      <h2>Your details</h2>
      <p>So a member of staff can follow up with you if needed.</p>
      <form onSubmit={save}>
        <label>Name<input value={name} onChange={e => { setName(e.target.value); setStatus(''); }} maxLength={100} required /></label>
        <label>Email<input type="email" value={email} onChange={e => { setEmail(e.target.value); setStatus(''); }} maxLength={254} required /></label>
        <button className="secondary">Save details</button>
        <span role="status">{status}</span>
      </form>
    </section>
  );
}
