#!/usr/bin/python3
"""Probe Bubblewrap, then narrowly prepare an ephemeral Ubuntu GitHub runner.

No production host bootstrap: AppArmor's global settings remain unchanged.
The only policy that may be added is the unmodified distro-packaged profile:
https://gitlab.com/apparmor/apparmor/-/blob/master/profiles/apparmor/profiles/extras/bwrap-userns-restrict
"""

import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile


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


def inspect_profile():
    """Read-only privileged preflight; does not add, replace or remove policy."""
    from apparmor.aare import AARE  # Provided by Ubuntu apparmor-utils/python3-apparmor.

    info = PROFILE.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise RuntimeError('Expected a root-owned, non-writable distro profile file')
    owner = execute(['dpkg-query', '-S', str(PROFILE)]).stdout.strip()
    if owner != f'apparmor-profiles: {PROFILE}':
        raise RuntimeError('Profile is not owned exclusively by apparmor-profiles')
    sums = Path(execute(['dpkg-query', '--control-path', 'apparmor-profiles', 'md5sums']).stdout.strip()).read_text()
    expected = next((line.split()[0] for line in sums.splitlines() if len(line.split()) == 2 and line.split()[1].lstrip('./') == str(PROFILE).lstrip('/')), None)
    data = PROFILE.read_bytes()
    if expected is None or hashlib.md5(data).hexdigest() != expected:
        raise RuntimeError('The installed profile differs from the distribution package')
    validate_profile_text(data.decode())
    for name in ['bwrap-userns-restrict', 'unpriv_bwrap']:
        local = Path('/etc/apparmor.d/local') / name
        if local.exists() and any(line.split('#', 1)[0].strip() for line in local.read_text().splitlines()):
            raise RuntimeError(f'Existing local policy additions require manual review: {local}')
    if Path('/etc/apparmor.d/bwrap-userns-restrict').exists():
        raise RuntimeError('An installed bwrap profile already exists; refusing to override it')
    if not POLICIES.is_dir():
        raise RuntimeError('Cannot inspect active AppArmor profile attachments')
    checked = 0
    for attachment in POLICIES.rglob('attach'):
        checked += 1
        name = attachment.with_name('name').read_text().strip()
        pattern = attachment.read_text().strip()
        if any(part in {'bwrap', 'unpriv_bwrap'} for part in name.split('//')):
            raise RuntimeError(f'Existing loaded profile conflicts: {name}')
        if pattern == '<unknown>' or '@{' in pattern:
            raise RuntimeError(f'Cannot safely resolve existing attachment: {name}: {pattern}')
        if pattern.startswith(('/', '{')):
            matcher = AARE(pattern, is_path=True)
            if any(matcher.match(value) for value in ['/usr/bin/bwrap', '/bin/bwrap']):
                raise RuntimeError(f'Existing attachment conflicts: {name}: {pattern}')
    if not checked:
        raise RuntimeError('No readable AppArmor attachments; cannot prove absence of conflicts')
    return {'profile': str(PROFILE), 'sha256': hashlib.sha256(data).hexdigest(), 'checkedAttachments': checked, 'package': execute(['dpkg-query', '-W', '-f=${Version}', 'apparmor-profiles']).stdout.strip()}


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
