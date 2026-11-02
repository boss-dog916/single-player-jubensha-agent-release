"use client";

import { useEffect, useRef } from "react";
import { chatMessageKey, type PendingReply } from "@/components/conversationPresentation";
import { quotePreview } from "./playerInteraction";
import type { Message } from "@/src/lib/types/game";

type ChatPanelProps = {
  messages: Message[];
  queuedMessages?: Message[];
  pendingReply?: PendingReply | null;
  status?: string;
  onReply?: (message: Message) => void;
  replyDisabled?: (message: Message) => boolean;
};

export function ChatPanel({ messages, queuedMessages = [], pendingReply = null, status = "", onReply, replyDisabled }: ChatPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const lastQueuedRef = useRef<string | undefined>(undefined);
  const lastQueued = queuedMessages.at(-1)?.message_id;
  useEffect(() => {
    const node = scrollRef.current;
    const ownMessageAdded = !!lastQueued && lastQueued !== lastQueuedRef.current;
    if (node && (followRef.current || ownMessageAdded)) {
      node.scrollTop = node.scrollHeight;
      followRef.current = true;
    }
    lastQueuedRef.current = lastQueued;
  }, [messages, queuedMessages, pendingReply?.id, pendingReply?.content, lastQueued]);
  const displayMessages = [...messages, ...(pendingReply ? [{
    message_id: pendingReply.id, speaker_type: "ai_player" as const, speaker_name: pendingReply.roleName,
    content: pendingReply.content
  }] : []), ...queuedMessages];
  return (
    <main className="flex min-h-0 flex-col rounded-lg border border-ink/10 bg-white/90 shadow-panel">
      <header className="border-b border-ink/10 px-5 py-4">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brass">
          Public Discussion
        </p>
        <h2 className="mt-1 text-xl font-semibold text-ink">公开讨论</h2>
        <p role="status" aria-live="polite" className="mt-2 min-h-5 text-xs text-ink/60">{status}</p>
      </header>

      <div ref={scrollRef} onScroll={() => {
        const node = scrollRef.current;
        if (node) followRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100;
      }} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
        {displayMessages.map((message) => (
          <article
            id={`message-${message.message_id}`}
            key={"phase" in message ? chatMessageKey(message) : message.message_id}
            aria-busy={message.message_id === pendingReply?.id}
            className={[
              "rounded-lg border p-4",
              message.speaker_type === "dm" || message.speaker_type === "system"
                ? "border-brass/35 bg-brass/10"
                : "",
              message.speaker_type === "user" ? "border-ember/35 bg-ember/10" : "",
              message.speaker_type === "ai_player" ? "border-pine/35 bg-pine/10" : ""
            ].join(" ")}
          >
            <div className="flex flex-wrap items-baseline gap-2">
              <h3 className="text-sm font-semibold text-ink">{message.speaker_name}</h3>
              <span className="text-xs text-ink/52">{getSpeakerLabel(message.speaker_type)}</span>
              {onReply && "phase" in message && messages.some(m => m.message_id === message.message_id) && message.speaker_type !== "system" ? <button
                type="button" className="ml-auto shrink-0 text-xs text-pine underline disabled:opacity-40" disabled={replyDisabled?.(message)}
                onClick={() => onReply(message)} aria-label={`回复${message.speaker_name ?? "这条消息"}的发言`}>回复</button> : null}
            </div>
            {"phase" in message && message.speaker_type !== "system" ? <div className="mt-2 text-xs text-ink/60">
              {message.reply_to_message_id ? <a href={`#message-${message.reply_to_message_id}`}>
                回复 {messages.find(m => m.message_id === message.reply_to_message_id)?.speaker_name ?? "某条消息"}：
                {quotePreview(messages.find(m => m.message_id === message.reply_to_message_id)?.content ?? "原消息", 100)}
              </a> : <span>公开发言</span>}
            </div> : null}
            <p className="mt-3 whitespace-pre-line text-sm leading-7 text-ink/78">{message.content}</p>
          </article>
        ))}
      </div>
    </main>
  );
}

function getSpeakerLabel(speakerType: Message["speaker_type"]): string {
  const labels: Record<Message["speaker_type"], string> = {
    dm: "DM",
    user: "你",
    ai_player: "AI 玩家",
    system: "系统"
  };

  return labels[speakerType];
}
