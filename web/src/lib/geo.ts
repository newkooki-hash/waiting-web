import { useEffect, useState } from 'react';

/** 오란다볼링파크 좌표와 허용 반경 (PRD 4.3, 결정 23) */
export const STORE = { lat: 37.4910422, lng: 126.9899568 };
export const ALLOWED_RADIUS_M = 300;

/** 두 좌표 사이 거리(m), 하버사인 */
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371000, r = (x: number) => (x * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * 접수 화면용 소프트 위치 확인. 접수를 막지 않고 값을 저장·전송하지 않는다.
 * 거부·오류·시간 초과(5초)는 모두 null로 두고 안내 없이 건너뛴다.
 * 반환값: 매장까지 거리(m), 구하지 못했으면 null
 */
export function useStoreDistance(enabled: boolean) {
  const [meters, setMeters] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled || !('geolocation' in navigator)) return;
    let live = true;
    navigator.geolocation.getCurrentPosition(
      (p) => { if (live) setMeters(distanceM(STORE, { lat: p.coords.latitude, lng: p.coords.longitude })); },
      () => {},
      { enableHighAccuracy: false, timeout: 5000, maximumAge: 60000 },
    );
    return () => { live = false; };
  }, [enabled]);
  return meters;
}

export const formatDistance = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${Math.round(m / 10) * 10}m`);
