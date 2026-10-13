import type { StudioProject } from './types';

const stable = (value: unknown): string => {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter(k => (value as Record<string, unknown>)[k] !== undefined).map(k => `${k}:${stable((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value);
};
const equal = (a: unknown, b: unknown) => stable(a) === stable(b);
const keyed = (value: unknown): value is Array<Record<string, unknown> & { id: string }> => Array.isArray(value) && value.every(v => v && typeof v === 'object' && typeof v.id === 'string');

function merge(base: unknown, local: unknown, remote: unknown, path: string): unknown {
  if (equal(local, base)) return remote;
  if (equal(remote, base) || equal(local, remote)) return local;
  if (keyed(base) && keyed(local) && keyed(remote)) {
    const ids = [...new Set([...remote.map(x => x.id), ...local.map(x => x.id)])];
    return ids.map(id => merge(base.find(x => x.id === id), local.find(x => x.id === id), remote.find(x => x.id === id), `${path}/${id}`)).filter(Boolean);
  }
  if (base && local && remote && typeof base === 'object' && typeof local === 'object' && typeof remote === 'object' && !Array.isArray(base) && !Array.isArray(local) && !Array.isArray(remote)) {
    const b = base as Record<string, unknown>, l = local as Record<string, unknown>, r = remote as Record<string, unknown>;
    return Object.fromEntries([...new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)])].map(key => [key, merge(b[key], l[key], r[key], `${path}/${key}`)]).filter(([, value]) => value !== undefined));
  }
  throw new Error(`项目同时发生了冲突修改（${path}）。本地草稿已保留，请重新打开项目核对。`);
}

function authored(project: StudioProject): unknown {
  const value = structuredClone(project);
  value.assets = []; value.revision = 0; value.updatedAt = '';
  for (const shot of value.shots) { delete shot.approval; shot.takes = []; }
  for (const scene of value.scenes) scene.revision = 0;
  return value;
}

/** Background job assets/takes/approvals are server-owned and never discarded by autosave. */
export function mergeProject(base: StudioProject, local: StudioProject, remote: StudioProject): StudioProject {
  if (base.id !== local.id || local.id !== remote.id) throw new Error('不能合并不同项目');
  const value = merge(authored(base), authored(local), authored(remote), 'project') as StudioProject;
  value.assets = structuredClone(remote.assets); value.revision = remote.revision; value.updatedAt = remote.updatedAt;
  for (const shot of value.shots) {
    const saved = remote.shots.find(s => s.id === shot.id);
    shot.takes = structuredClone(saved?.takes || []);
    if (saved?.approval) shot.approval = structuredClone(saved.approval); else delete shot.approval;
  }
  for (const scene of value.scenes) scene.revision = remote.scenes.find(s => s.id === scene.id)?.revision || 1;
  return value;
}
export const authoringEqual = (a: StudioProject, b: StudioProject) => equal(authored(a), authored(b));
