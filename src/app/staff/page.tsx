'use client';
/**
 * Staff workspace: sign in, see the priority queue, open a case with its full conversation,
 * claim it (the server guarantees only one person can) and resolve it (owner only).
 */
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { requestJson } from '../../lib/client-api';

type CaseRecord = {
  id: string; name: string | null; email: string | null; category: string; urgency: string;
  safeguarding: boolean; summary: string; status: 'new' | 'in_progress' | 'resolved'; claimed_by: string | null; created_at: string;
};
type Turn = { id: string; student_text: string; reply: string | null; disposition: string | null; urgency: string | null; category: string | null; reason: string | null };
type CaseDetail = CaseRecord & { turns: Turn[] };

const REFRESH_MS = 10_000;
const label = (value: string) => value.replaceAll('_', ' ');

export default function StaffPage() {
  const [staffId, setStaffId] = useState('');
  const [cases, setCases] = useState<CaseRecord[] | null>(null);
  const [selected, setSelected] = useState<CaseDetail | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const selectedId = useRef<string | null>(null);

  const loadCase = useCallback(async (id: string) => {
    selectedId.current = id;
    const detail = await requestJson<CaseDetail>(`/api/staff/cases/${id}`);
    if (selectedId.current === id) setSelected(detail); // ignore a slow response for a case no longer open
  }, []);

  const refresh = useCallback(async () => {
    try {
      setCases((await requestJson<{ cases: CaseRecord[] }>('/api/staff/cases')).cases);
      if (selectedId.current) await loadCase(selectedId.current);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [loadCase]);

  useEffect(() => {
    requestJson<{ staffId: string }>('/api/staff/session').then(data => setStaffId(data.staffId)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!staffId) return;
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [staffId, refresh]);

  async function act(action: 'claim' | 'resolve') {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      await requestJson(`/api/staff/cases/${selected.id}`, 'PATCH', { action });
    } catch (err) {
      setError((err as Error).message); // e.g. 409 "already claimed by bea"
    } finally {
      await refresh();
      setBusy(false);
    }
  }

  async function signOut() {
    await requestJson('/api/staff/session', 'DELETE').catch(() => {});
    selectedId.current = null;
    setStaffId('');
    setCases(null);
    setSelected(null);
  }

  const open = cases?.filter(c => c.status !== 'resolved') ?? [];

  return (
    <div className="app-shell">
      <header className="topbar">
        <Link className="brand" href="/"><span className="brand-mark">s.</span> student support</Link>
        <div className="header-actions">
          <Link href="/">Student chat ↗</Link>
          {staffId && <button className="text-button" onClick={() => void signOut()}>Sign out ({staffId})</button>}
        </div>
      </header>

      <main className="staff-main">
        <div className="workspace-title">
          <div>
            <span className="eyebrow">STAFF WORKSPACE</span>
            <h1>Escalated cases</h1>
            <p>Most urgent first. Claim a case before you start, so nobody else picks it up.</p>
          </div>
          {staffId && <button className="secondary" onClick={() => void refresh()}>Refresh</button>}
        </div>

        {error && <p className="error" role="alert">{error}</p>}

        {!staffId ? <LoginForm onSignedIn={setStaffId} onError={setError} /> : (
          <>
            <div className="queue-summary">
              <span><strong>{open.length}</strong> open</span>
              <span><strong>{open.filter(c => c.urgency === 'critical').length}</strong> critical</span>
              <span><strong>{open.filter(c => c.safeguarding).length}</strong> safeguarding</span>
              <span>Refreshes every 10 seconds</span>
            </div>
            <div className="staff-grid">
              <section className="queue-list" aria-label="Priority queue">
                <h2>Priority queue</h2>
                {cases === null && <p>Loading…</p>}
                {cases?.length === 0 && <div className="empty-state"><h3>No escalations yet</h3><p>Cases appear here when the assistant hands a conversation to staff.</p></div>}
                {cases?.map(item => (
                  <CaseCard key={item.id} item={item} selected={selected?.id === item.id}
                    onOpen={() => { setError(''); loadCase(item.id).catch(err => setError(err.message)); }} />
                ))}
              </section>
              <section className="case-detail" aria-label="Selected case">
                {selected
                  ? <CaseView item={selected} staffId={staffId} busy={busy} onAct={act} />
                  : <div className="empty-state"><h2>Select a case</h2><p>Read the conversation and see who is helping.</p></div>}
              </section>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function Badges({ item }: { item: CaseRecord }) {
  return (
    <div className="case-badges">
      <span className={`badge ${item.urgency}`}>{item.urgency}</span>
      {item.safeguarding && <span className="badge safeguarding">Safeguarding</span>}
      <span className="badge">{label(item.category)}</span>
      <span className="case-status">{label(item.status)}</span>
    </div>
  );
}

function CaseCard({ item, selected, onOpen }: { item: CaseRecord; selected: boolean; onOpen: () => void }) {
  return (
    <button className={`case-card ${selected ? 'selected' : ''}`} onClick={onOpen}>
      <Badges item={item} />
      <h3>{item.name || <span className="contact-missing">No contact details yet</span>}</h3>
      <p>{item.summary}</p>
      <div className="case-meta">
        <span>{item.claimed_by ? `Owner: ${item.claimed_by}` : 'Unclaimed'}</span>
        <time dateTime={item.created_at}>{new Date(item.created_at).toLocaleString('en-GB')}</time>
      </div>
    </button>
  );
}

function CaseView({ item, staffId, busy, onAct }: { item: CaseDetail; staffId: string; busy: boolean; onAct: (a: 'claim' | 'resolve') => void }) {
  return (
    <>
      <span className="eyebrow">CASE</span>
      <h2>{item.name || <span className="contact-missing">No contact details yet</span>}</h2>
      <p>{item.email || 'No email provided'}</p>
      <Badges item={item} />
      <p className="case-summary">{item.summary}</p>

      <div className="case-controls">
        <span>{item.claimed_by ? `Owned by ${item.claimed_by}` : 'Not claimed yet'}</span>
        {item.status === 'new' && <button disabled={busy} onClick={() => onAct('claim')}>Claim case</button>}
        {item.status === 'in_progress' && item.claimed_by === staffId && <button disabled={busy} onClick={() => onAct('resolve')}>Mark resolved</button>}
        {item.status === 'resolved' && <strong>Resolved</strong>}
      </div>

      <h3>Conversation</h3>
      <div className="staff-transcript">
        {item.turns.map(turn => (
          <div key={turn.id}>
            <article className="message student"><span className="message-label">STUDENT</span><p>{turn.student_text}</p></article>
            <article className="message assistant">
              <span className="message-label">ASSISTANT</span>
              <p>{turn.reply ?? 'Reply pending'}</p>
              {turn.disposition && (
                <div className="turn-meta">
                  <span>{label(turn.disposition)}</span>
                  {turn.urgency && <span>{turn.urgency}</span>}
                  {turn.category && <span>{label(turn.category)}</span>}
                  {turn.reason && <span>reason: {label(turn.reason)}</span>}
                </div>
              )}
            </article>
          </div>
        ))}
      </div>
    </>
  );
}

function LoginForm({ onSignedIn, onError }: { onSignedIn: (id: string) => void; onError: (message: string) => void }) {
  const [staffId, setStaffId] = useState('alex');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    onError('');
    try {
      const data = await requestJson<{ staffId: string }>('/api/staff/session', 'POST', { staffId, password });
      onSignedIn(data.staffId);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="login-card" onSubmit={submit}>
      <h2>Staff sign-in</h2>
      <label>Staff member
        <select value={staffId} onChange={e => setStaffId(e.target.value)}><option value="alex">Alex</option><option value="bea">Bea</option></select>
      </label>
      <label>Password<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required /></label>
      <button disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
    </form>
  );
}
