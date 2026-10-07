import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../net/remote.js';
import type { GameSession } from '../net/session.js';

/** 联机聊天面板（热座模式自动隐藏） */
export function ChatPanel({ session, myPlayerId }: { session: GameSession; myPlayerId?: string | null }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!session.onChat) return;
    return session.onChat(setMessages);
  }, [session]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  if (!session.onChat || !session.sendChat) return null;

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    session.sendChat!(trimmed.slice(0, 120));
    setText('');
  };

  return (
    <div className="panel chat-panel">
      <div className="panel-title">房间聊天</div>
      <div className="chat-list" ref={listRef}>
        {messages.length === 0 && <div className="chat-empty">还没有消息，打个招呼吧～</div>}
        {messages.map((m, i) => (
          <div key={i} className={`chat-msg ${m.fromId === myPlayerId ? 'mine' : ''}`}>
            <span className="chat-name">{m.fromName}</span>
            <span className="chat-text">{m.text}</span>
          </div>
        ))}
      </div>
      <div className="chat-input-row">
        <input
          value={text}
          placeholder="发送消息…"
          maxLength={120}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send();
          }}
        />
        <button onClick={send} disabled={!text.trim()}>
          发送
        </button>
      </div>
    </div>
  );
}
