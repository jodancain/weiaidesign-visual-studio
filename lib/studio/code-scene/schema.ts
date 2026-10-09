/** Versioned, declarative story directions. No executable source or remote asset URLs. */
export type V3 = [number, number, number];
export type FilmId = 'three-knocks' | 'borrow-sunshine' | 'last-seed-of-light';
export const ACTIONS = {
  'three-knocks': ['look-up', 'hear-knocks', 'knock-door', 'grasp-wheel', 'scout-approach', 'turn-wheel', 'scout-enter', 'inspect-thruster', 'plug-cell', 'answer-knocks'],
  'borrow-sunshine': ['put-scissors', 'offer-umbrella', 'open-cloth-box', 'look-umbrella', 'cut-patch', 'give-umbrella', 'shop-alone', 'attach-sun', 'wave-thanks', 'light-shop'],
  'last-seed-of-light': ['walk-lantern', 'hug-lantern', 'show-tree', 'hesitate', 'test-bridge', 'jump-bridge', 'hold-seed', 'drop-seed', 'grow-light', 'catch-new-seed'],
} as const;
export type ActionKind = typeof ACTIONS[FilmId][number];
export type CodeShot = {
  id: string; startFrame: number; endFrame: number;
  camera: { position: V3; positionEnd: V3; target: V3; targetEnd: V3; lensMm: number };
  action: { kind: ActionKind; startFrame: number; endFrame: number; beatFrames?: number[] };
  blocking?: Array<{ id: string; position: V3; yaw: number }>;
};
export type SceneProgram = {
  schemaVersion: 1; id: string; title: string; film: FilmId;
  fps: 24; width: 1280; height: 720; totalFrames: 1440; seed: number;
  look?: { exposure: number; keyIntensity: number; fillIntensity: number };
  shots: CodeShot[];
};
const exact = (o: unknown, keys: string[], where: string) => {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw Error(`${where}: expected object`);
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw Error(`${where}: unknown field ${k}`);
};
const number = (v: unknown, lo: number, hi: number, where: string, integer = false) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi || (integer && !Number.isInteger(v))) throw Error(`${where}: invalid number`);
};
const vec = (v: unknown, where: string) => { if (!Array.isArray(v) || v.length !== 3) throw Error(`${where}: expected vec3`); v.forEach(n => number(n, -30, 30, where)); };
export function validateSceneProgram(input: unknown): SceneProgram {
  exact(input, ['schemaVersion', 'id', 'title', 'film', 'fps', 'width', 'height', 'totalFrames', 'seed', 'look', 'shots'], 'program');
  const p = input as SceneProgram;
  if (p.schemaVersion !== 1 || p.fps !== 24 || p.width !== 1280 || p.height !== 720 || p.totalFrames !== 1440) throw Error('Program must be v1, 1280x720, 24fps, 1440 frames');
  if (!Object.hasOwn(ACTIONS, p.film)) throw Error('Unsupported film');
  if (typeof p.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(p.id) || typeof p.title !== 'string' || p.title.length < 1 || p.title.length > 100) throw Error('Invalid program identity');
  number(p.seed, 0, 2147483647, 'seed', true);
  if (p.look) { exact(p.look, ['exposure', 'keyIntensity', 'fillIntensity'], 'look'); number(p.look.exposure, .3, 2, 'exposure'); number(p.look.keyIntensity, .1, 8, 'key'); number(p.look.fillIntensity, 0, 3, 'fill'); }
  if (!Array.isArray(p.shots) || p.shots.length !== 10) throw Error('Expected ten shots');
  const actors = p.film === 'three-knocks' ? ['ashuan', 'scout'] : p.film === 'borrow-sunshine' ? ['bear', 'mouse'] : ['fox'];
  p.shots.forEach((s, i) => {
    exact(s, ['id', 'startFrame', 'endFrame', 'camera', 'action', 'blocking'], `shot ${i}`);
    if (s.id !== `s${String(i + 1).padStart(2, '0')}` || s.startFrame !== i * 144 || s.endFrame !== (i + 1) * 144) throw Error(`Shot ${i}: id/range mismatch`);
    exact(s.camera, ['position', 'positionEnd', 'target', 'targetEnd', 'lensMm'], 'camera');
    for (const k of ['position', 'positionEnd', 'target', 'targetEnd'] as const) vec(s.camera[k], `camera.${k}`);
    number(s.camera.lensMm, 18, 100, 'lensMm');
    if (s.camera.position.every((n,j)=>n===s.camera.target[j]) || s.camera.positionEnd.every((n,j)=>n===s.camera.targetEnd[j])) throw Error('Camera position equals target');
    exact(s.action, ['kind', 'startFrame', 'endFrame', 'beatFrames'], 'action');
    if (s.action.kind !== ACTIONS[p.film][i]) throw Error(`Shot ${s.id} action must be ${ACTIONS[p.film][i]}`);
    number(s.action.startFrame, 0, 120, 'action.startFrame', true); number(s.action.endFrame, 1, 143, 'action.endFrame', true);
    if (s.action.endFrame <= s.action.startFrame) throw Error('Invalid action range');
    if (s.action.beatFrames) { if (!Array.isArray(s.action.beatFrames) || s.action.beatFrames.length !== 3) throw Error('Exactly three beat frames required'); s.action.beatFrames.forEach((n,j)=>{number(n, s.action.startFrame, s.action.endFrame, 'beat', true); if(j && n<=s.action.beatFrames![j-1])throw Error('Beat frames must increase');}); }
    if (s.blocking) { if (!Array.isArray(s.blocking) || s.blocking.length > 0) throw Error('Invalid blocking'); const seen = new Set(); for (const b of s.blocking) { exact(b, ['id','position','yaw'],'blocking'); if (!actors.includes(b.id) || seen.has(b.id)) throw Error('Unknown/duplicate actor'); seen.add(b.id); vec(b.position, 'blocking.position'); number(b.yaw, -Math.PI*2, Math.PI*2, 'blocking.yaw'); } }
  });
  return structuredClone(p);
}
