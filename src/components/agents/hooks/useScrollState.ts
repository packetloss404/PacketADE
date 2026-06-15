import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentMessage } from "@/types/agent-conversation";

/**
 * Tracks scroll position in the messages container and pauses auto-scroll
 * once the user has scrolled > 100px from the bottom. Counts unread messages
 * that arrive while the user is scrolled away. Resets on conversation switch
 * and on manual jump-to-bottom.
 */
export function useScrollState(
  conversationId: string,
  messages: AgentMessage[] | undefined,
) {
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const prevMessageCountRef = useRef(0);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const onScroll = () => {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      const atBottom = distFromBottom <= 100;
      setIsAtBottom(atBottom);
      if (atBottom) setUnreadCount(0);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Reset on conversation switch. Intentionally only depends on conversationId.
  useEffect(() => {
    setIsAtBottom(true);
    setUnreadCount(0);
    prevMessageCountRef.current = messages?.length ?? 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  useEffect(() => {
    const count = messages?.length ?? 0;
    const prev = prevMessageCountRef.current;
    prevMessageCountRef.current = count;
    if (isAtBottom) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    } else if (count > prev) {
      setUnreadCount((u) => u + (count - prev));
    }
  }, [messages, isAtBottom]);

  const jumpToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    setUnreadCount(0);
    setIsAtBottom(true);
  }, []);

  return {
    messagesContainerRef,
    messagesEndRef,
    isAtBottom,
    unreadCount,
    jumpToBottom,
  };
}
