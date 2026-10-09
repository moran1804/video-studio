'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ProjectBundle } from '@/lib/types';
import { apiGet } from '@/lib/api';

interface Ctx {
  bundle: ProjectBundle;
  setBundle: (b: ProjectBundle) => void;
  refresh: () => Promise<void>;
}

const ProjectCtx = createContext<Ctx | null>(null);

export function ProjectProvider({
  initial,
  children,
}: {
  initial: ProjectBundle;
  children: React.ReactNode;
}) {
  const [bundle, setBundleState] = useState(initial);
  const fingerprint = useRef<string | null>(null);
  const id = initial.project.id;

  // Every state write bumps this counter. A refresh only applies its result if nothing
  // newer (e.g. a mutation response) landed while it was in flight, so a slow poll can
  // never overwrite fresher data with a stale snapshot.
  const version = useRef(0);

  const refresh = useCallback(async () => {
    const started = version.current;
    const b = await apiGet<ProjectBundle>(`/api/projects/${id}`);
    if (version.current !== started) return;
    version.current++;
    setBundleState(b);
  }, [id]);

  const setBundle = useCallback(
    (b: ProjectBundle) => {
      // Mutation responses return the full bundle; accept only for this project.
      if (b?.project?.id !== id) return;
      version.current++;
      setBundleState(b);
      // Background jobs may finish before the next poll; force a comparison-free refresh.
      fingerprint.current = null;
    },
    [id],
  );

  // Poll a cheap fingerprint endpoint and refetch only when something changed.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      let active = bundle.activeJobs > 0;
      try {
        const s = await apiGet<{ activeJobs: number; fingerprint: string }>(`/api/projects/${id}/status`);
        active = s.activeJobs > 0;
        // Refresh when anything changed – or when we have no baseline yet, because the
        // bundle in state may already be older than the first fingerprint we see.
        if (fingerprint.current !== s.fingerprint) await refresh();
        fingerprint.current = s.fingerprint;
      } catch {
        /* transient */
      }
      if (!stopped) timer = setTimeout(tick, active ? 2000 : 8000);
    };
    timer = setTimeout(tick, 1000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [id, refresh, bundle.activeJobs]);

  return <ProjectCtx.Provider value={{ bundle, setBundle, refresh }}>{children}</ProjectCtx.Provider>;
}

export function useProject(): Ctx {
  const ctx = useContext(ProjectCtx);
  if (!ctx) throw new Error('useProject must be used inside ProjectProvider');
  return ctx;
}
