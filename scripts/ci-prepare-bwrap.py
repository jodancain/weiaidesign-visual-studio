#!/usr/bin/python3
"""Probe Bubblewrap, then narrowly prepare an ephemeral Ubuntu GitHub runner.

No production host bootstrap: AppArmor's global settings remain unchanged.
The only policy that may be added is the unmodified distro-packaged profile:
https://gitlab.com/apparmor/apparmor/-/blob/master/profiles/apparmor/profiles/extras/bwrap-userns-restrict
"""

import hashlib
import ctypes
import errno
import json
import os
from pathlib import Path
import re
import stat
import signal
import subprocess
import sys
import tempfile
import time


PROFILE = Path('/usr/share/apparmor/extra-profiles/bwrap-userns-restrict')
POLICIES = Path('/sys/kernel/security/apparmor/policy/profiles')
RESTRICTION = Path('/proc/sys/kernel/apparmor_restrict_unprivileged_userns')
PROBE = r'''
import json, os, socket, sys
from pathlib import Path
status = dict(line.split(':', 1) for line in Path('/proc/self/status').read_text().splitlines() if ':' in line)
for key in ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']:
    assert int(status[key].strip(), 16) == 0, (key, status[key])
assert status['NoNewPrivs'].strip() == '1'
net = os.readlink('/proc/self/ns/net')
assert net != sys.argv[1], 'Network namespace was shared with the host'
assert all(name == 'lo' for _, name in socket.if_nameindex()), 'Host network interface is visible'
try:
    Path(sys.argv[2]).read_bytes()
except OSError:
    pass
else:
    raise AssertionError('File outside the workspace was readable')
Path('inside.txt').write_text('workspace write succeeds')
label = Path('/proc/self/attr/current').read_text().strip()
if sys.argv[3] == 'require-profile':
    assert 'unpriv_bwrap' in label and '(enforce)' in label, label
print(json.dumps({'networkNamespace': net, 'interfaces': socket.if_nameindex(), 'capabilities': 'all-zero', 'outsideFile': 'denied', 'apparmor': label}))
'''


def execute(args, *, check=True, timeout=30, **kwargs):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout, **kwargs)
    if len(result.stdout) + len(result.stderr) > 262144:
        raise RuntimeError('Bootstrap command exceeded its output budget')
    if check and result.returncode:
        raise RuntimeError(f'{args[0]} exited {result.returncode}: {result.stderr.strip()}')
    return result


def probe(require_profile=False):
    with tempfile.TemporaryDirectory(prefix='craft-bwrap-ci-') as temp:
        root = Path(temp)
        work = root / 'workspace'
        work.mkdir(mode=0o700)
        secret = root / 'outside.txt'
        secret.write_text('This sibling must not be visible in the sandbox.')
        args = ['/usr/bin/bwrap', '--die-with-parent', '--unshare-all', '--new-session', '--cap-drop', 'ALL']
        for value in ['/usr', '/lib', '/lib64', '/bin', '/etc/fonts', '/etc/ld.so.cache']:
            if Path(value).exists():
                args += ['--ro-bind', value, value]
        args += ['--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--bind', str(work), str(work), '--chdir', str(work), '--', '/usr/bin/python3', '-I', '-c', PROBE, os.readlink('/proc/self/ns/net'), str(secret), 'require-profile' if require_profile else 'probe']
        return execute(args, check=False, cwd=work, env={'PATH': '/usr/bin:/bin', 'HOME': str(work), 'LANG': 'C.UTF-8'}, timeout=15)


def diagnose():
    for value in ['/etc/os-release', str(RESTRICTION), '/proc/sys/kernel/unprivileged_userns_clone', '/proc/sys/user/max_user_namespaces', '/sys/module/apparmor/parameters/enabled']:
        try:
            print(f'{value}: {Path(value).read_text().strip()}', flush=True)
        except OSError as error:
            print(f'{value}: unavailable ({error})', flush=True)
    for command in [
        ['dpkg-query', '-W', 'bubblewrap', 'apparmor', 'apparmor-profiles', 'apparmor-utils'],
        ['sudo', '-n', 'aa-status', '--json'],
    ]:
        result = execute(command, check=False)
        print(f'{command[0]} diagnostics: {result.stdout.strip()} {result.stderr.strip()}', flush=True)


def require_ephemeral_runner():
    if os.environ.get('GITHUB_ACTIONS') != 'true' or os.environ.get('RUNNER_ENVIRONMENT') != 'github-hosted' or os.environ.get('RUNNER_OS') != 'Linux':
        raise RuntimeError('Policy setup is limited to ephemeral GitHub-hosted Linux runners')
    release = dict(line.split('=', 1) for line in Path('/etc/os-release').read_text().splitlines() if '=' in line)
    if release.get('ID', '').strip('"') != 'ubuntu' or release.get('VERSION_ID', '').strip('"') != '24.04':
        raise RuntimeError('Scoped policy setup has only been defined for Ubuntu 24.04')
    if RESTRICTION.read_text().strip() != '1':
        raise RuntimeError('The global AppArmor user-namespace restriction must remain enabled')
    execute(['sudo', '-n', 'true'])


def validate_profile_text(text):
    policy = '\n'.join(line.split('#', 1)[0] for line in text.splitlines())
    parent = re.search(r'profile\s+bwrap\s+/usr/bin/bwrap\s+flags=\([^)]*\)\s*\{(.*?)^\}', policy, re.S | re.M)
    child = re.search(r'profile\s+unpriv_bwrap\s+flags=\([^)]*\)\s*\{(.*?)^\}', policy, re.S | re.M)
    if not parent or not child:
        raise RuntimeError('Distro profile lacks the expected parent/child profile declarations')
    # Noble's packaged 4.0 profile uses px -> bwrap//&unpriv_bwrap.
    # Upstream's newer profile uses pix -> &bwrap//&unpriv_bwrap.
    # Both must stack the capability-denying child; no generic ix/ux fallback.
    rules = [
        (parent.group(1), r'allow\s+capability\s*,'),
        (parent.group(1), r'allow\s+(?:px\s+/\*\*\s*->\s*bwrap//&unpriv_bwrap|pix\s+/\*\*\s*->\s*&bwrap//&unpriv_bwrap)\s*,'),
        (child.group(1), r'audit\s+deny\s+capability\s*,'),
        (child.group(1), r'allow\s+pix\s+/\*\*\s*->\s*&unpriv_bwrap\s*,'),
    ]
    if any(not re.search(rule, body) for body, rule in rules):
        raise RuntimeError('Distro profile lacks the expected setup/child capability separation')


def verified_package_bytes(file, expected_package=None):
    info = file.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or info.st_size > 1048576:
        raise RuntimeError(f'Expected a bounded root-owned, non-writable distro profile file: {file}')
    ownership = execute(['dpkg-query', '-S', str(file)]).stdout.strip()
    match = re.fullmatch(r'([a-z0-9][a-z0-9+.-]*(?::[a-z0-9-]+)?): ' + re.escape(str(file)), ownership)
    if not match or (expected_package and match.group(1) != expected_package):
        raise RuntimeError(f'Profile is not owned exclusively by the expected distro package: {file}')
    package = match.group(1)
    if execute(['dpkg-query', '-W', '-f=${Status}', package]).stdout.strip() != 'install ok installed':
        raise RuntimeError(f'Profile owner package is not installed: {package}')
    sums = Path(execute(['dpkg-query', '--control-path', package, 'md5sums']).stdout.strip()).read_text()
    expected = next((line.split()[0] for line in sums.splitlines() if len(line.split()) == 2 and line.split()[1].lstrip('./') == str(file).lstrip('/')), None)
    if expected is None:
        conffiles = execute(['dpkg-query', '-W', '-f=${Conffiles}', package]).stdout
        expected = next((line.split()[1] for line in conffiles.splitlines() if len(line.split()) >= 2 and line.split()[0] == str(file)), None)
    data = file.read_bytes()
    if expected is None or hashlib.md5(data).hexdigest() != expected:
        raise RuntimeError(f'The installed profile differs from the distribution package: {file}')
    return data


def wait_child(pid, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            waited, status = os.waitpid(pid, os.WNOHANG | os.WUNTRACED)
        except InterruptedError:
            continue
        if waited == pid:
            return status
        time.sleep(0.01)
    raise RuntimeError('Timed out waiting for the Bubblewrap attachment probe')


def inspect_bwrap_attachment():
    """Ask the kernel which profile actually attaches, before bwrap can run.

    A traced exec stops at SIGTRAP after the kernel's exec/LSM transition and
    before the new program starts. This resolves AAREs/variables without
    guessing from incomplete securityfs attachment strings or runner sources.
    https://man7.org/linux/man-pages/man2/ptrace.2.html
    """
    binary = Path('/usr/bin/bwrap')
    verified_package_bytes(binary, 'bubblewrap')
    if binary.resolve() != binary or binary.stat().st_mode & (stat.S_ISUID | stat.S_ISGID):
        raise RuntimeError('Attachment probe requires the exact non-setuid /usr/bin/bwrap')
    try:
        if os.getxattr(binary, 'security.capability'):
            raise RuntimeError('Attachment probe refuses a binary with file capabilities')
    except OSError as error:
        if error.errno != errno.ENODATA:
            raise
    libc = ctypes.CDLL(None, use_errno=True)
    libc.ptrace.restype = ctypes.c_long
    libc.ptrace.argtypes = [ctypes.c_uint, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p]
    pid = os.fork()
    if pid == 0:
        try:
            if libc.ptrace(0, 0, None, None) != 0:  # PTRACE_TRACEME
                raise OSError(ctypes.get_errno(), 'PTRACE_TRACEME denied')
            os.execve(str(binary), [str(binary), '--version'], {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})
        except Exception as error:
            os.write(2, f'Bubblewrap attachment child failed: {error}\n'.encode())
            os._exit(127)
    reaped = False
    try:
        status = wait_child(pid)
        if os.WIFEXITED(status) or os.WIFSIGNALED(status):
            reaped = True
            raise RuntimeError(f'Bubblewrap exited before its exec stop (status {status})')
        if not os.WIFSTOPPED(status) or os.WSTOPSIG(status) != signal.SIGTRAP:
            raise RuntimeError(f'Bubblewrap did not stop at the required exec SIGTRAP (status {status})')
        executable = os.readlink(f'/proc/{pid}/exe')
        if executable != str(binary):
            raise RuntimeError(f'Unexpected executable at the exec stop: {executable}')
        label = Path(f'/proc/{pid}/attr/current').read_text().strip()
        if label != 'unconfined':
            raise RuntimeError(f'An existing AppArmor profile attaches to bwrap: {label}')
        return {'executable': executable, 'execStop': 'SIGTRAP', 'apparmor': label}
    except ChildProcessError as error:
        reaped = True
        raise RuntimeError('Lost ownership of the Bubblewrap attachment probe') from error
    finally:
        if not reaped:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            status = wait_child(pid)
            if not (os.WIFEXITED(status) or os.WIFSIGNALED(status)):
                raise RuntimeError('Could not reap the stopped Bubblewrap attachment probe')


def inspect_profile():
    """Read-only privileged preflight; does not add, replace or remove policy."""
    data = verified_package_bytes(PROFILE, 'apparmor-profiles')
    validate_profile_text(data.decode())
    for name in ['bwrap-userns-restrict', 'unpriv_bwrap']:
        local = Path('/etc/apparmor.d/local') / name
        if local.exists() and any(line.split('#', 1)[0].strip() for line in local.read_text().splitlines()):
            raise RuntimeError(f'Existing local policy additions require manual review: {local}')
    if Path('/etc/apparmor.d/bwrap-userns-restrict').exists():
        raise RuntimeError('An installed bwrap profile already exists; refusing to override it')
    if not POLICIES.is_dir():
        raise RuntimeError('Cannot inspect active AppArmor profile attachments')
    checked, opaque, conflicts = 0, 0, []
    for attachment in POLICIES.rglob('attach'):
        checked += 1
        try:
            name = attachment.with_name('name').read_text().strip()
            pattern = attachment.read_text().strip()
            if any(part in {'bwrap', 'unpriv_bwrap'} for part in name.split('//')):
                raise RuntimeError(f'Existing loaded profile conflicts: {name}')
            opaque += int(pattern == '<unknown>')
            if pattern in {'/usr/bin/bwrap', '/bin/bwrap'}:
                raise RuntimeError(f'Existing attachment conflicts: {name}: {pattern}')
        except Exception as error:
            # Report the complete preflight in one CI run; any error still
            # prevents all policy mutation, including otherwise valid entries.
            conflicts.append(str(error)[:1024])
    if not checked:
        raise RuntimeError('No readable AppArmor attachments; cannot prove absence of conflicts')
    if conflicts:
        raise RuntimeError('Existing policy attachment preflight failed:\n' + '\n'.join(conflicts[:50]))
    return {'profile': str(PROFILE), 'sha256': hashlib.sha256(data).hexdigest(), 'checkedAttachments': checked, 'opaqueAttachmentsCheckedByExecProbe': opaque, 'package': execute(['dpkg-query', '-W', '-f=${Version}', 'apparmor-profiles']).stdout.strip()}


def main():
    if sys.argv[1:] == ['--inspect-profile']:
        print(json.dumps(inspect_profile()))
        return
    if sys.argv[1:]:
        raise RuntimeError('No arguments are accepted by the bootstrap entry point')
    if sys.platform != 'linux' or os.geteuid() == 0:
        raise RuntimeError('Run the probe as the ordinary Linux CI user, not root')
    first = probe()
    if first.returncode == 0:
        print(f'Bubblewrap already isolates this runner; no policy changed. {first.stdout.strip()}')
        return
    print(f'Initial Bubblewrap probe failed: {first.stderr.strip()}', flush=True)
    diagnose()
    require_ephemeral_runner()
    print(f'Kernel bwrap attachment preflight: {json.dumps(inspect_bwrap_attachment())}', flush=True)
    checked = execute(['sudo', '-n', '/usr/bin/python3', str(Path(__file__).resolve()), '--inspect-profile'])
    print(f'Distro profile preflight: {checked.stdout.strip()}', flush=True)
    parser = ['sudo', '-n', 'apparmor_parser', '--skip-cache', '--base', '/etc/apparmor.d']
    execute(parser + ['--skip-kernel-load', str(PROFILE)])
    # --add intentionally fails if a profile appeared since preflight; never --replace.
    execute(parser + ['--add', str(PROFILE)])
    if RESTRICTION.read_text().strip() != '1':
        raise RuntimeError('Global AppArmor restriction changed unexpectedly')
    final = probe(require_profile=True)
    if final.returncode:
        diagnose()
        raise RuntimeError(f'Bubblewrap still cannot isolate this runner: {final.stderr.strip()}')
    print(f'Scoped distro profile loaded; global restriction remains 1. {final.stdout.strip()}')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'CI Bubblewrap bootstrap failed closed: {error}', file=sys.stderr)
        sys.exit(1)
