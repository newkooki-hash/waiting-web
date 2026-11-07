import { useEffect, useRef } from 'react';

/** 서버 실시간 알림(SSE). 메시지가 올 때마다 handler를 부른다. */
export function useEvents(handler: (data: string) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const es = new EventSource('/api/events');
    es.onmessage = (e) => ref.current(e.data);
    return () => es.close();
  }, []);
}
