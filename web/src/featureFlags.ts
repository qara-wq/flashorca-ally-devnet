import type React from 'react';

declare global {
  interface Window {
    __FEATURE_FLAGS__?: Record<string, unknown>;
  }
}

// 추가할 때 여기에 이름을 확장하세요
export type FeatureName = 'dashTabs';

const defaults: Record<FeatureName, boolean> = {
  // 개발 기본값은 true, 배포도 현재는 true. 필요시 조정하세요.
  dashTabs: true,
};

const toBool = (v: unknown): boolean => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return ['1', 'true', 'on', 'yes', 'y'].includes(v.toLowerCase());
  if (typeof v === 'number') return v !== 0;
  return !!v;
};

const envKeyFor = (name: FeatureName) =>
  'VITE_FEATURE_' + name.replace(/[A-Z]/g, (m) => '_' + m).toUpperCase();

const readFromWindow = (name: FeatureName): boolean | undefined => {
  if (typeof window === 'undefined') return undefined;
  const flags = window.__FEATURE_FLAGS__;
  if (flags && Object.prototype.hasOwnProperty.call(flags, name)) {
    return toBool(flags[name]);
  }
  return undefined;
};

const readFromEnv = (name: FeatureName): boolean | undefined => {
  const key = envKeyFor(name);
  const raw = (import.meta as any).env?.[key];
  if (typeof raw === 'undefined') return undefined;
  return toBool(raw);
};

const readFromQuery = (name: FeatureName): boolean | undefined => {
  if (typeof window === 'undefined') return undefined;
  const p = new URLSearchParams(window.location.search);
  if (!p.has('ff')) return undefined;
  const entries = p.getAll('ff');
  const map: Record<string, string> = {};
  for (const item of entries) {
    try {
      const s = item.trim();
      if (!s) continue;
      if (s.startsWith('{')) {
        Object.assign(map, JSON.parse(s));
      } else {
        s.split(',').forEach((pair) => {
          const [k, v] = pair.split(':').map((q) => q.trim());
          if (k) map[k] = v ?? 'true';
        });
      }
    } catch {
      // ignore malformed
    }
  }
  if (Object.prototype.hasOwnProperty.call(map, name)) {
    return toBool(map[name]);
  }
  return undefined;
};

export function isFeatureEnabled(name: FeatureName): boolean {
  return (
    readFromWindow(name) ??
    readFromQuery(name) ??
    readFromEnv(name) ??
    defaults[name]
  );
}

export function FeatureGate(props: { name: FeatureName; children: React.ReactNode }) {
  return isFeatureEnabled(props.name) ? (props.children as any) : null;
}
