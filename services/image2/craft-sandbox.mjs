import { access, mkdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const quoted = value => JSON.stringify(value);
const failure = message => Object.assign(new Error(message), { status: 503, code: 'CRAFT_SANDBOX_UNAVAILABLE' });

/** Native parsers may follow file references even when all command parameters are validated. */
export async function craftSandboxCommand(binary, args, { workDir, platform = process.platform } = {}) {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw failure('无效的原生引擎参数');
  const work = await realpath(resolve(workDir));
  const executable = await realpath(binary);
  if (work === '/' || work === homedir()) throw failure('原生任务必须使用独立工作目录');
  const home = join(work, 'home'), temp = join(work, 'tmp');
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(temp, { recursive: true, mode: 0o700 });
  const env = { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: `${temp}/`, TMP: temp, TEMP: temp, XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), XDG_DATA_HOME: join(home, '.local/share'), LANG: platform === 'linux' ? 'C.UTF-8' : 'en_US.UTF-8', LC_ALL: platform === 'linux' ? 'C.UTF-8' : 'en_US.UTF-8', RUST_BACKTRACE: '0' };
  if (platform === 'darwin') {
    const launcher = '/usr/bin/sandbox-exec';
    try { await access(launcher, constants.X_OK); } catch { throw failure('本机缺少原生任务隔离器，未启动引擎'); }
    // Directory metadata is needed by dyld; data reads outside these roots remain denied.
    const reads = ['/System', '/usr/lib', '/usr/share', '/usr/bin', '/usr/libexec', '/bin', '/dev', '/Library/Apple', '/Library/Fonts', join(homedir(), 'Library/Fonts'), work];
    const literals = ['/', '/private', '/private/var', '/Library', '/Users', '/usr', '/private/etc/localtime', '/private/etc/passwd', '/private/etc/group', executable];
    const exclusions = [...reads.map(path => `(require-not (subpath ${quoted(path)}))`), ...literals.map(path => `(require-not (literal ${quoted(path)}))`)];
    const profile = `(version 1)(allow default)(deny network*)(deny file-read-data (require-all ${exclusions.join(' ')}))(deny file-write* (require-all (require-not (subpath ${quoted(work)})) (require-not (literal "/dev/null"))))(deny process-exec (require-not (literal ${quoted(executable)})))`;
    return { file: launcher, args: ['-p', profile, executable, ...args], cwd: work, env, isolation: 'macos-seatbelt' };
  }
  if (platform === 'linux') {
    let launcher;
    for (const candidate of ['/usr/bin/bwrap', '/bin/bwrap']) { try { await access(candidate, constants.X_OK); launcher = candidate; break; } catch { /* Try the other known installation path. */ } }
    if (!launcher) throw failure('Linux 原生任务需要 bubblewrap；未降级为无隔离执行');
    const flags = ['--die-with-parent', '--unshare-all', '--new-session', '--cap-drop', 'ALL'];
    for (const path of ['/usr', '/lib', '/lib64', '/bin', '/etc/fonts', '/etc/ld.so.cache']) { try { await access(path); flags.push('--ro-bind', path, path); } catch { /* Optional system runtime path. */ } }
    flags.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--ro-bind', executable, executable, '--bind', work, work, '--chdir', work, '--', executable, ...args);
    return { file: launcher, args: flags, cwd: work, env, isolation: 'linux-bubblewrap' };
  }
  throw failure('此平台尚无经验证的原生任务隔离器，请使用 Linux 引擎容器');
}
