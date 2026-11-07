import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ActionChip } from "./ActionCards.tsx";
import { SEATS, type SeatId, type Snapshot, type WarMessage } from "../shared/types.ts";
import { hhmm } from "./useSim.ts";

export const SEAT_NAME = Object.fromEntries(SEATS.map((s) => [s.id, s.name])) as Record<SeatId, string>;
export type ChatView = SeatId | "all" | null; // null = the chat list

const Avatar = ({ seat }: { seat: SeatId }) => <img className="chat-avatar" src={`/avatars/${seat}.png`} alt="" />;

/** Left glass panel: a chat list (one row per seat), and a scrollable bubble thread for one seat or the whole room. */
export function ChatPanel(props: { snap: Snapshot; view: ChatView; onView: (v: ChatView) => void; open: boolean; onOpen: (open: boolean) => void }) {
  const { snap, view, onView, open, onOpen } = props;
  if (!open)
    return (
      <button className="glass chat-pill" onClick={() => onOpen(true)}>
        War-room chats <span className="chat-count">{snap.messages.length}</span>
      </button>
    );
  return (
    <aside className="glass chat">
      <button className="chat-close" onClick={() => onOpen(false)} aria-label="Hide chats" title="Hide chats">
        ×
      </button>
      {view ? <Thread key={view} snap={snap} view={view} onBack={() => onView(null)} /> : <List snap={snap} onOpen={onView} />}
    </aside>
  );
}

function List({ snap, onOpen }: { snap: Snapshot; onOpen: (v: ChatView) => void }) {
  const last = snap.messages.at(-1);
  return (
    <>
      <div className="panel-head chat-head">
        <span>War-room chats</span>
        <small className="muted">{snap.messages.length} messages</small>
      </div>
      <div className="chat-scroll">
        <button className="chat-row" onClick={() => onOpen("all")}>
          <span className="chat-avatar all" aria-hidden>
            ◎
          </span>
          <span className="chat-row-body">
            <span className="chat-row-top">
              <b>All seats</b>
              <time>{last ? hhmm(last.t) : ""}</time>
            </span>
            <span className="chat-preview">{last ? `${SEAT_NAME[last.from]}: ${last.text}` : "No messages yet"}</span>
          </span>
        </button>
        {SEATS.map((s) => {
          const mine = snap.messages.filter((m) => m.from === s.id || m.to === s.id);
          const m = mine.at(-1);
          const thinking = snap.thinking.includes(s.id);
          return (
            <button key={s.id} className="chat-row" onClick={() => onOpen(s.id)}>
              <Avatar seat={s.id} />
              <span className="chat-row-body">
                <span className="chat-row-top">
                  <b>{s.name}</b>
                  <time>{m ? hhmm(m.t) : ""}</time>
                </span>
                {snap.agentModel && <span className="chat-model">{snap.agentModel}</span>}
                {snap.care?.budgets[s.id] && <Budget {...snap.care.budgets[s.id]!} />}
                <span className={`chat-preview ${thinking ? "typing" : ""}`}>{thinking ? "thinking…" : m ? (m.from === s.id ? m.text : `${SEAT_NAME[m.from]}: ${m.text}`) : "Quiet so far"}</span>
              </span>
              {mine.length > 0 && <span className="chat-count">{mine.length}</span>}
            </button>
          );
        })}
      </div>
    </>
  );
}

function Thread({ snap, view, onBack }: { snap: Snapshot; view: Exclude<ChatView, null>; onBack: () => void }) {
  const msgs = view === "all" ? snap.messages : snap.messages.filter((m) => m.from === view || m.to === view);
  const thinking = view === "all" ? snap.thinking : snap.thinking.filter((s) => s === view);
  const ref = useRef<HTMLDivElement>(null);
  // Follow the newest message unless the reader has scrolled up; then offer a jump back instead of yanking them down.
  const [pinned, setPinned] = useState(true);
  const [seen, setSeen] = useState(msgs.length);
  const toBottom = () => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
    setPinned(true);
    setSeen(msgs.length);
  };
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned) el.scrollTop = el.scrollHeight;
  });
  useEffect(() => {
    if (pinned) setSeen(msgs.length);
  }, [pinned, msgs.length]);
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  };
  const unseen = Math.max(0, msgs.length - seen);

  const d = snap.decision;
  // The human approval sits in the room's timeline, just before the first message posted after it.
  const at = d?.approved?.at;
  const firstAfter = at === undefined ? -1 : (i => (i < 0 ? msgs.length : i))(msgs.findIndex((m) => m.t > at));
  const approvedBefore = (i: number) => view === "all" && i === firstAfter;
  return (
    <>
      <div className="panel-head chat-head">
        <button className="chat-back" onClick={onBack} aria-label="Back to all chats">
          ‹
        </button>
        {view === "all" ? <span className="chat-avatar all small">◎</span> : <Avatar seat={view} />}
        <span className="chat-title">
          {view === "all" ? "All seats" : SEAT_NAME[view]}
          {snap.agentModel && <span className="chat-model">{view === "all" ? `6 seats · ${snap.agentModel}` : snap.agentModel}</span>}
        </span>
        <small className="muted">{msgs.length}</small>
      </div>
      <div className="chat-scroll bubbles" ref={ref} onScroll={onScroll}>
        {msgs.length === 0 && thinking.length === 0 && <p className="muted small chat-empty">No messages yet. Press Play to start the run.</p>}
        {msgs.map((m, i) => (
          <Fragment key={m.id}>
            {approvedBefore(i) && <Approved d={d!} />}
            <Bubble m={m} own={view !== "all" && m.from === view} showSender={view === "all" || m.from !== view} />
          </Fragment>
        ))}
        {approvedBefore(msgs.length) && <Approved d={d!} />}
        {thinking.map((s) => (
          <div key={s} className="bubble typing-bubble">
            {view === "all" && <span className="bubble-from">{SEAT_NAME[s]}</span>}
            <span className="dots" aria-label="thinking">
              <i />
              <i />
              <i />
            </span>
          </div>
        ))}
      </div>
      {!pinned && unseen > 0 && (
        <button className="chat-jump" onClick={toBottom}>
          ↓ {unseen} new
        </button>
      )}
    </>
  );
}

const Approved = ({ d }: { d: NonNullable<Snapshot["decision"]> }) => (
  <div className="chat-system">
    {hhmm(d.approved!.at)} · YOU approved plan {d.approved!.planId}
  </div>
);

function Budget({ spent, limit }: { spent: number; limit: number }) {
  const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  return (
    <span className="budget" title={`Delegated budget: AED ${spent.toLocaleString("en-US")} of ${limit.toLocaleString("en-US")} spent`}>
      <span className="bar"><span style={{ width: `${Math.min(100, (spent / limit) * 100)}%` }} /></span>
      AED {k(spent)} / {k(limit)}
    </span>
  );
}

function Bubble({ m, own, showSender }: { m: WarMessage; own: boolean; showSender: boolean }) {
  return (
    <div className={`bubble ${own ? "own" : ""}`}>
      {m.stance && (
        <span className={`stance plan-${m.stance.plan}`}>
          Backs plan {m.stance.plan} · debate round {m.stance.round}
        </span>
      )}
      {(showSender || m.to) && (
        <span className="bubble-from">
          {showSender ? SEAT_NAME[m.from] : ""}
          {m.to ? `${showSender ? " " : ""}→ ${SEAT_NAME[m.to]}` : ""}
        </span>
      )}
      <span className="bubble-text">{m.text}</span>
      {m.action && <ActionChip a={m.action} />}
      <span className="bubble-meta">
        {m.tools?.length ? `checked: ${m.tools.join(", ")} · ` : ""}
        <time>{hhmm(m.t)}</time>
      </span>
    </div>
  );
}
