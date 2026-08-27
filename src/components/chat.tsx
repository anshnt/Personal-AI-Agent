'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { MessageParts } from './message-parts';

interface ConversationSummary {
  id: string;
  title: string | null;
  updated_at: string;
}

const SUGGESTIONS = [
  "What do you know about me?",
  "Remember that I prefer short answers",
  "Add a task to renew my passport by Friday",
  "What's on my list this week?",
];

export function Chat() {
  const [conversationId, setConversationId] = useState(() => crypto.randomUUID());
  const [initialMessages, setInitialMessages] = useState<UIMessage[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [input, setInput] = useState('');

  const transport = useMemo(() => new DefaultChatTransport({ api: '/api/chat' }), []);

  const { messages, sendMessage, status, stop, error, clearError, setMessages } = useChat({
    // Keying on the conversation id makes switching threads reset chat state.
    id: conversationId,
    messages: initialMessages,
    transport,
  });

  const refreshConversations = useCallback(async () => {
    try {
      const response = await fetch('/api/conversations');
      if (!response.ok) return;
      const body = (await response.json()) as { conversations: ConversationSummary[] };
      setConversations(body.conversations);
    } catch {
      // The sidebar is a convenience; a failed load should not break the chat.
    }
  }, []);

  useEffect(() => {
    void refreshConversations();
  }, [refreshConversations]);

  // The list is only accurate once a turn has been persisted server-side.
  useEffect(() => {
    if (status === 'ready' && messages.length > 0) {
      void refreshConversations();
    }
  }, [status, messages.length, refreshConversations]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  const busy = status === 'submitted' || status === 'streaming';

  const submit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0 || busy) return;
      clearError();
      setInput('');
      void sendMessage({ text: trimmed });
    },
    [busy, clearError, sendMessage],
  );

  const startNewConversation = useCallback(() => {
    stop();
    setInitialMessages([]);
    setMessages([]);
    setConversationId(crypto.randomUUID());
    setInput('');
  }, [setMessages, stop]);

  const openConversation = useCallback(
    async (id: string) => {
      if (id === conversationId) return;
      stop();

      try {
        const response = await fetch(`/api/conversations/${id}`);
        if (!response.ok) return;
        const body = (await response.json()) as { messages: UIMessage[] };
        // Seed before switching the key so the remounted hook starts populated.
        setInitialMessages(body.messages);
        setConversationId(id);
      } catch {
        // Leave the current conversation in place on a failed load.
      }
    },
    [conversationId, stop],
  );

  return (
    <div className="app">
      <aside className="sidebar">
        <header>
          <h1>
            Personal agent
            <span>Remembers you, acts for you</span>
          </h1>
        </header>

        <div className="sidebar-scroll">
          <button className="secondary new-chat" onClick={startNewConversation} type="button">
            New conversation
          </button>

          <div className="section-label">Recent</div>
          {conversations.length === 0 && <div className="memory-chip">No conversations yet</div>}
          {conversations.map((conversation) => (
            <button
              className="conversation-item"
              key={conversation.id}
              onClick={() => void openConversation(conversation.id)}
              aria-current={conversation.id === conversationId}
              type="button"
              title={conversation.title ?? 'Untitled'}
            >
              {conversation.title ?? 'Untitled'}
            </button>
          ))}
        </div>
      </aside>

      <main className="chat">
        <div className="messages">
          {messages.length === 0 ? (
            <div className="empty-state">
              <h2>What can I help with?</h2>
              <p>
                I keep long-term memory about you, manage your tasks, and can reach outside
                services. Everything I do is visible in the trace under each answer.
              </p>
              <div className="suggestions">
                {SUGGESTIONS.map((suggestion) => (
                  <button
                    className="suggestion"
                    key={suggestion}
                    onClick={() => submit(suggestion)}
                    type="button"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="messages-inner">
              {messages.map((message) => (
                <article className={`message ${message.role}`} key={message.id}>
                  <div className="message-role">{message.role === 'user' ? 'You' : 'Agent'}</div>
                  <MessageParts message={message} />
                </article>
              ))}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        <div className="composer">
          {error && (
            <div className="error-banner" role="alert">
              {error.message}
            </div>
          )}

          <form
            className="composer-inner"
            onSubmit={(event) => {
              event.preventDefault();
              submit(input);
            }}
          >
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                // Enter sends; Shift+Enter is a newline.
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  submit(input);
                }
              }}
              placeholder="Ask, or tell me something to remember..."
              rows={1}
              aria-label="Message"
            />
            {busy ? (
              <button className="primary" onClick={stop} type="button">
                Stop
              </button>
            ) : (
              <button className="primary" disabled={input.trim().length === 0} type="submit">
                Send
              </button>
            )}
          </form>

          <p className="hint">
            {busy ? 'Working...' : 'Enter to send, Shift+Enter for a new line.'}
          </p>
        </div>
      </main>
    </div>
  );
}
