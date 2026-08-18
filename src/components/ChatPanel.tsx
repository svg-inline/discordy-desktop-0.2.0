import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef } from 'react';
import type { ChatMessage } from '../lib/types';

type ChatPanelProps = {
  messages: ChatMessage[];
  selfId: string | null;
  draft: string;
  typingNames: string[];
  readyPeerCount: number;
  remotePeerCount: number;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  onClose: () => void;
};

const URL_PATTERN = /(https?:\/\/[^\s<]+)/gi;

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function renderMessageText(text: string) {
  const parts = text.split(URL_PATTERN);
  return parts.map((part, index) => {
    if (/^https?:\/\//i.test(part)) {
      return <a key={`${part}-${index}`} href={part} target="_blank" rel="noreferrer noopener">{part}</a>;
    }
    return <span key={index}>{part}</span>;
  });
}

export function ChatPanel({ messages, selfId, draft, typingNames, readyPeerCount, remotePeerCount, onDraftChange, onSend, onClose }: ChatPanelProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const canSend = remotePeerCount > 0 && readyPeerCount > 0;
  const connectionLabel = remotePeerCount === 0
    ? 'Aguardando outro participante'
    : readyPeerCount === remotePeerCount
      ? `P2P conectado · ${readyPeerCount}/${remotePeerCount}`
      : `P2P conectando · ${readyPeerCount}/${remotePeerCount}`;

  const typingLabel = useMemo(() => {
    if (typingNames.length === 0) return '';
    if (typingNames.length === 1) return `${typingNames[0]} está digitando...`;
    if (typingNames.length === 2) return `${typingNames[0]} e ${typingNames[1]} estão digitando...`;
    return `${typingNames.length} pessoas estão digitando...`;
  }, [typingNames]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [messages, typingLabel]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (draft.trim() && canSend) onSend();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (draft.trim() && canSend) onSend();
    }
  };

  return (
    <aside className="chat-panel" aria-label="Chat P2P">
      <header className="chat-panel__header">
        <div>
          <strong>Chat P2P</strong>
          <span>{connectionLabel}</span>
        </div>
        <button className="text-button" onClick={onClose}>Fechar</button>
      </header>

      <div className="chat-messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="chat-empty">
            <strong>Comece uma conversa</strong>
            <span>As mensagens trafegam diretamente pelos RTCDataChannels e só ficam nesta sessão.</span>
          </div>
        )}
        {messages.map((message) => {
          const own = message.senderId === selfId;
          return (
            <article className={`chat-message ${own ? 'chat-message--own' : ''}`} key={message.id}>
              <div className="chat-message__avatar">{message.senderName.trim().charAt(0).toUpperCase() || '?'}</div>
              <div className="chat-message__body">
                <header>
                  <strong>{own ? 'Você' : message.senderName}</strong>
                  <time dateTime={new Date(message.sentAt).toISOString()}>{formatTime(message.sentAt)}</time>
                  <button
                    className="chat-copy-button"
                    title="Copiar mensagem"
                    onClick={() => void navigator.clipboard.writeText(message.text)}
                  >
                    Copiar
                  </button>
                </header>
                <p>{renderMessageText(message.text)}</p>
              </div>
            </article>
          );
        })}
        {typingLabel && <div className="chat-typing"><span className="typing-dots"><i /><i /><i /></span>{typingLabel}</div>}
      </div>

      <form className="chat-composer" onSubmit={submit}>
        <textarea
          value={draft}
          maxLength={2000}
          rows={2}
          disabled={!canSend}
          placeholder={canSend ? 'Mensagem para a sala' : connectionLabel}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="chat-composer__footer">
          <span>{draft.length}/2000 · Enter envia · Shift+Enter quebra linha</span>
          <button className="button button--primary" type="submit" disabled={!canSend || !draft.trim()}>Enviar</button>
        </div>
      </form>
    </aside>
  );
}
