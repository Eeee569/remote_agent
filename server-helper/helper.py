#!/usr/bin/env python3
"""Remote Agent server-side helper.

Uploaded to ~/.remote-agent/bin/helper on remote servers and invoked over
`ssh exec`. Every invocation prints EXACTLY ONE JSON envelope on stdout:

    success: {"ok": true,  "data": ...}                                exit 0
    failure: {"ok": false, "error": {"code": "...", "message": "..."}} exit 1

Diagnostics go to stderr only. Stdlib only; Python 3.8+ compatible.
Data shapes must stay in sync with src/shared/helper-protocol.ts.
"""

import argparse
import errno
import fcntl
import hashlib
import json
import os
import re
import shlex
import shutil
import stat as stat_mod
import subprocess
import sys
import tempfile
import time
import traceback

VERSION = '1.0.0'

TMUX_PREFIX = 'ra-'


class HelperError(Exception):
    """Error carrying a machine-readable code from HELPER_ERROR_CODES."""

    def __init__(self, code, message):
        super(HelperError, self).__init__(message)
        self.code = code
        self.message = message


# ---------------------------------------------------------------- utilities


def home_dir():
    raw = os.environ.get('REMOTE_AGENT_HOME') or '~/.remote-agent'
    return os.path.abspath(os.path.expanduser(raw))


def tmux_base():
    base = ['tmux']
    sock = os.environ.get('REMOTE_AGENT_TMUX_SOCKET')
    if sock:
        base += ['-L', sock]
    return base


def run_proc(cmd, stdin_data=None):
    """Run a subprocess capturing output; never lets it touch our stdout."""
    try:
        return subprocess.run(
            cmd,
            input=stdin_data,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            universal_newlines=True
        )
    except FileNotFoundError:
        raise HelperError('internal', 'executable not found: %s' % cmd[0])


def run_git(git_args):
    try:
        return subprocess.run(
            ['git'] + git_args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            universal_newlines=True
        )
    except FileNotFoundError:
        raise HelperError('git-failed', 'git executable not found')


def stderr_tail(text, limit=400):
    text = (text or '').strip()
    if len(text) > limit:
        return '...' + text[-limit:]
    return text


def emit(obj):
    sys.stdout.write(json.dumps(obj))
    sys.stdout.write('\n')
    sys.stdout.flush()


# ---------------------------------------------------------------- init / version


def cmd_init(_args):
    home = home_dir()
    os.makedirs(os.path.join(home, 'bin'), exist_ok=True)
    os.makedirs(os.path.join(home, 'state'), exist_ok=True)
    with open(os.path.join(home, 'VERSION'), 'w', encoding='utf-8') as fh:
        fh.write(VERSION + '\n')
    return {'version': VERSION, 'home': home}


def cmd_version(_args):
    digest = hashlib.sha256()
    with open(os.path.abspath(__file__), 'rb') as fh:
        digest.update(fh.read())
    return {'version': VERSION, 'sha256': digest.hexdigest(), 'home': home_dir()}


# ---------------------------------------------------------------- ls-tree


def cmd_ls_tree(args):
    return _ls_tree(args.path, args.hidden)


def cmd_ls_trees(args):
    """Several directories in one round trip — the file tree refreshes every
    expanded directory at once, and each ssh exec costs a channel."""
    trees = []
    for path in args.path:
        try:
            trees.append(dict(_ls_tree(path, args.hidden), path=path))
        except HelperError as exc:
            # one unreadable directory (deleted, permissions) must not sink
            # the whole refresh
            trees.append({'path': path, 'error': {'code': exc.code,
                                                  'message': exc.message}})
    return {'trees': trees}


def _ls_tree(raw_path, hidden):
    root = os.path.abspath(os.path.expanduser(raw_path))
    if not os.path.exists(root):
        raise HelperError('not-found', 'no such path: %s' % root)
    if not os.path.isdir(root):
        raise HelperError('not-a-dir', 'not a directory: %s' % root)

    entries = []
    try:
        with os.scandir(root) as it:
            for entry in it:
                if not hidden and entry.name.startswith('.'):
                    continue
                full = os.path.join(root, entry.name)
                try:
                    st = entry.stat(follow_symlinks=False)
                except OSError:
                    continue  # vanished between scandir and stat
                mode = st.st_mode
                if stat_mod.S_ISLNK(mode):
                    etype = 'symlink'
                elif stat_mod.S_ISDIR(mode):
                    etype = 'dir'
                elif stat_mod.S_ISREG(mode):
                    etype = 'file'
                else:
                    etype = 'other'
                item = {
                    'name': entry.name,
                    'path': full,
                    'type': etype,
                    'size': st.st_size,
                    'mtime': int(st.st_mtime),
                    'mode': format(stat_mod.S_IMODE(mode) & 0o777, 'o')
                }
                if etype == 'symlink':
                    if os.path.isdir(full):
                        item['linkTargetType'] = 'dir'
                    elif os.path.isfile(full):
                        item['linkTargetType'] = 'file'
                entries.append(item)
    except PermissionError as exc:
        raise HelperError('io-error', str(exc))

    def sort_key(item):
        is_dir = item['type'] == 'dir' or item.get('linkTargetType') == 'dir'
        return (0 if is_dir else 1, item['name'].casefold(), item['name'])

    entries.sort(key=sort_key)
    return {'entries': entries}


# ---------------------------------------------------------------- fs edits


def _fs_path(raw, label):
    """Absolute, expanded path that is never the filesystem or home root."""
    path = os.path.abspath(os.path.expanduser(raw))
    if path == '/' or path == os.path.expanduser('~') or path == home_dir():
        raise HelperError('bad-args', 'refusing to %s %s' % (label, path))
    return path


def cmd_fs_move(args):
    src = _fs_path(args.src, 'move')
    dest = _fs_path(args.dest, 'move onto')
    if not os.path.lexists(src):
        raise HelperError('not-found', 'no such path: %s' % src)
    if os.path.lexists(dest):
        raise HelperError('exists', 'already exists: %s' % dest)
    parent = os.path.dirname(dest) or '/'
    if not os.path.isdir(parent):
        raise HelperError('not-a-dir', 'not a directory: %s' % parent)
    # moving a directory inside itself would detach the subtree
    if os.path.isdir(src) and not os.path.islink(src):
        if dest == src or dest.startswith(src.rstrip('/') + '/'):
            raise HelperError('bad-args', 'cannot move %s into itself' % src)
    try:
        shutil.move(src, dest)
    except (OSError, shutil.Error) as exc:
        raise HelperError('io-error', 'cannot move: %s' % exc)
    return {'path': dest}


def cmd_fs_delete(args):
    path = _fs_path(args.path, 'delete')
    if not os.path.lexists(path):
        raise HelperError('not-found', 'no such path: %s' % path)
    try:
        if os.path.islink(path) or not os.path.isdir(path):
            os.unlink(path)
        elif args.recursive:
            shutil.rmtree(path)
        else:
            os.rmdir(path)
    except OSError as exc:
        if getattr(exc, 'errno', None) == errno.ENOTEMPTY:
            raise HelperError('not-empty', 'directory is not empty: %s' % path)
        raise HelperError('io-error', 'cannot delete: %s' % exc)
    return {}


def cmd_fs_mkdir(args):
    path = _fs_path(args.path, 'create')
    if os.path.lexists(path):
        raise HelperError('exists', 'already exists: %s' % path)
    try:
        os.makedirs(path)
    except OSError as exc:
        raise HelperError('io-error', 'cannot create directory: %s' % exc)
    return {'path': path}


# ---------------------------------------------------------------- git-status


def _unquote_git_path(s):
    """Undo git's C-style quoting of unusual pathnames."""
    if len(s) < 2 or not (s.startswith('"') and s.endswith('"')):
        return s
    inner = s[1:-1]
    out = bytearray()
    i = 0
    escapes = {
        'a': b'\a', 'b': b'\b', 't': b'\t', 'n': b'\n',
        'v': b'\v', 'f': b'\f', 'r': b'\r', '\\': b'\\', '"': b'"'
    }
    while i < len(inner):
        ch = inner[i]
        if ch == '\\' and i + 1 < len(inner):
            nxt = inner[i + 1]
            if nxt in escapes:
                out += escapes[nxt]
                i += 2
            elif nxt.isdigit():
                out.append(int(inner[i + 1:i + 4], 8))
                i += 4
            else:
                out += nxt.encode('utf-8')
                i += 2
        else:
            out += ch.encode('utf-8')
            i += 1
    return out.decode('utf-8', 'replace')


def _empty_git_status(is_repo):
    return {
        'isRepo': is_repo,
        'hasCommit': False,
        'branch': None,
        'upstream': None,
        'ahead': 0,
        'behind': 0,
        'staged': [],
        'modified': [],
        'untracked': []
    }


def cmd_git_status(args):
    path = os.path.abspath(os.path.expanduser(args.path))
    res = run_git([
        '-C', path, '-c', 'core.quotepath=false',
        'status', '--porcelain=v2', '--branch'
    ])
    if res.returncode == 128:
        return _empty_git_status(False)
    if res.returncode != 0:
        raise HelperError('git-failed', stderr_tail(res.stderr) or 'git status failed')

    out = _empty_git_status(True)
    staged = set()
    modified = set()
    untracked = set()
    for line in res.stdout.splitlines():
        if line.startswith('# branch.oid '):
            # "(initial)" until the first commit exists
            out['hasCommit'] = line[len('# branch.oid '):] != '(initial)'
        elif line.startswith('# branch.head '):
            value = line[len('# branch.head '):]
            out['branch'] = None if value == '(detached)' else value
        elif line.startswith('# branch.upstream '):
            out['upstream'] = line[len('# branch.upstream '):]
        elif line.startswith('# branch.ab '):
            match = re.match(r'\+(\d+) -(\d+)$', line[len('# branch.ab '):])
            if match:
                out['ahead'] = int(match.group(1))
                out['behind'] = int(match.group(2))
        elif line.startswith('1 '):
            parts = line.split(' ', 8)
            if len(parts) < 9:
                continue
            xy = parts[1]
            rel = _unquote_git_path(parts[8])
            if xy[0:1] not in ('.', ''):
                staged.add(rel)
            if xy[1:2] not in ('.', ''):
                modified.add(rel)
        elif line.startswith('2 '):
            parts = line.split(' ', 9)
            if len(parts) < 10:
                continue
            xy = parts[1]
            rel = _unquote_git_path(parts[9].split('\t')[0])
            if xy[0:1] not in ('.', ''):
                staged.add(rel)
            if xy[1:2] not in ('.', ''):
                modified.add(rel)
        elif line.startswith('u '):
            parts = line.split(' ', 10)
            if len(parts) < 11:
                continue
            modified.add(_unquote_git_path(parts[10]))
        elif line.startswith('? '):
            untracked.add(_unquote_git_path(line[2:]))
    out['staged'] = sorted(staged)
    out['modified'] = sorted(modified)
    out['untracked'] = sorted(untracked)
    return out


# ---------------------------------------------------------------- git-init


def _git_toplevel(path):
    """Root of the repo containing `path`, or None if it is not inside one."""
    res = run_git(['-C', path, 'rev-parse', '--show-toplevel'])
    return (res.stdout.strip() or None) if res.returncode == 0 else None


def _git_has_commit(path):
    """False on an "unborn" HEAD — a fresh `git init` has no commit yet, and
    `git worktree add` has nothing to branch from until it does."""
    return run_git(['-C', path, 'rev-parse', '--verify', '--quiet', 'HEAD']).returncode == 0


def _git_branch(path):
    res = run_git(['-C', path, 'symbolic-ref', '--short', 'HEAD'])
    return (res.stdout.strip() or None) if res.returncode == 0 else None


def _git_identity_args(path):
    """`-c` overrides for whichever identity git cannot resolve itself, so a
    server that has one configured keeps using it."""
    args = []
    for key, fallback in (('user.name', 'Remote Agent'),
                          ('user.email', 'remote-agent@localhost')):
        if run_git(['-C', path, 'config', '--get', key]).returncode != 0:
            args += ['-c', '%s=%s' % (key, fallback)]
    return args


def cmd_git_init(args):
    """Make `path` a git repo with at least one commit, creating the directory
    if it is missing. A directory already inside a repo is left as it is, except
    that a repo with no commits still gets its first one."""
    path = _fs_path(args.path, 'initialize')
    if not os.path.exists(path):
        try:
            os.makedirs(path)
        except OSError as exc:
            raise HelperError('io-error', 'cannot create directory: %s' % exc)
    elif not os.path.isdir(path):
        raise HelperError('not-a-dir', 'not a directory: %s' % path)

    initialized = _git_toplevel(path) is None
    if initialized:
        res = run_git(['-C', path, 'init', '-q'])
        if res.returncode != 0:
            raise HelperError('git-failed', stderr_tail(res.stderr) or 'git init failed')

    committed = False
    if not _git_has_commit(path):
        # "-- ." keeps the pathspec inside `path`: bare `add -A` is repo-wide,
        # which would reach outside when path is a subdirectory
        add = run_git(['-C', path, 'add', '-A', '--', '.'])
        if add.returncode != 0:
            raise HelperError('git-failed', stderr_tail(add.stderr) or 'git add failed')
        commit = run_git(
            ['-C', path] + _git_identity_args(path) + [
                # --allow-empty so an empty directory still gets the root commit
                # worktrees need; gpgsign off because there is no terminal here
                # to unlock a signing key on, and it would hang waiting
                '-c', 'commit.gpgsign=false',
                'commit', '-q', '--allow-empty', '-m', 'Initial commit'
            ]
        )
        if commit.returncode != 0:
            raise HelperError('git-failed', stderr_tail(commit.stderr) or 'git commit failed')
        committed = True

    return {
        'path': path,
        'initialized': initialized,
        'committed': committed,
        'branch': _git_branch(path)
    }


# ---------------------------------------------------------------- sessions


def cmd_session_list(_args):
    if shutil.which('tmux') is None:
        return {'sessions': []}
    fmt = '#{session_name}\t#{session_created}\t#{session_attached}\t#{session_path}'
    res = run_proc(tmux_base() + ['ls', '-F', fmt])
    if res.returncode != 0:
        # no server running on this socket (or tmux otherwise unavailable)
        return {'sessions': []}

    def as_int(text):
        try:
            return int(text)
        except (TypeError, ValueError):
            return None

    sessions = []
    for line in res.stdout.splitlines():
        parts = line.split('\t', 3)
        if len(parts) < 4 or not parts[0].startswith(TMUX_PREFIX):
            continue
        attached = as_int(parts[2])
        sessions.append({
            'tmuxName': parts[0],
            'alive': True,
            'attachedClients': attached if attached is not None else 0,
            'cwd': parts[3] or None,
            'createdAt': as_int(parts[1])
        })
    return {'sessions': sessions}


def _wrapped_program(cmd):
    """Wrap an agent command so login-shell env applies and a crashed agent
    drops to a shell instead of killing the pane."""
    sh = os.environ.get('SHELL') or 'sh'
    qsh = shlex.quote(sh)
    script = (
        '{c}; ec=$?; '
        'if [ $ec -ne 0 ]; then echo; '
        'echo "[{c} exited with status $ec]"; '
        'exec {sh} -l; fi'
    ).format(c=cmd, sh=qsh)
    return '{sh} -lc {script}'.format(sh=qsh, script=shlex.quote(script))


def cmd_session_create(args):
    if shutil.which('tmux') is None:
        raise HelperError('tmux-missing', 'tmux is not installed on this server')
    name = args.name
    if not name:
        raise HelperError('bad-args', '--name must not be empty')
    cwd = os.path.abspath(os.path.expanduser(args.cwd))
    if not os.path.isdir(cwd):
        raise HelperError('not-a-dir', 'not a directory: %s' % cwd)

    has = run_proc(tmux_base() + ['has-session', '-t', '=' + name])
    if has.returncode == 0:
        raise HelperError('session-exists', 'tmux session already exists: %s' % name)

    cmd = args.cmd
    if cmd is None and args.agent in ('claude', 'codex'):
        cmd = args.agent

    tmux_args = tmux_base()
    conf = os.path.join(home_dir(), 'tmux.conf')
    if os.path.isfile(conf):
        tmux_args += ['-f', conf]
    tmux_args += ['new-session', '-d', '-s', name, '-c', cwd]
    if cmd:
        tmux_args.append(_wrapped_program(cmd))

    res = run_proc(tmux_args)
    if res.returncode != 0:
        raise HelperError('tmux-failed', stderr_tail(res.stderr) or 'tmux new-session failed')
    return {'tmuxName': name}


def cmd_session_kill(args):
    if shutil.which('tmux') is None:
        raise HelperError('tmux-missing', 'tmux is not installed on this server')
    res = run_proc(tmux_base() + ['kill-session', '-t', '=' + args.name])
    if res.returncode != 0:
        err = stderr_tail(res.stderr)
        low = err.lower()
        if ("can't find" in low or 'session not found' in low
                or 'no server' in low or 'error connecting' in low):
            raise HelperError('session-missing', 'no such session: %s' % args.name)
        raise HelperError('tmux-failed', err or 'tmux kill-session failed')
    return {}


# ---------------------------------------------------------------- worktrees


def cmd_worktree_add(args):
    repo = os.path.abspath(os.path.expanduser(args.repo))
    path = os.path.abspath(os.path.expanduser(args.path))
    branch = args.branch

    exists = run_git(['-C', repo, 'show-ref', '--verify', '--quiet',
                      'refs/heads/' + branch])
    if exists.returncode == 0:
        res = run_git(['-C', repo, 'worktree', 'add', path, branch])
    else:
        res = run_git(['-C', repo, 'worktree', 'add', '-b', branch, path,
                       args.base or 'HEAD'])
    if res.returncode != 0:
        raise HelperError('git-failed', stderr_tail(res.stderr) or 'git worktree add failed')
    return {'path': path, 'branch': branch}


def cmd_worktree_list(args):
    repo = os.path.abspath(os.path.expanduser(args.repo))
    res = run_git(['-C', repo, 'worktree', 'list', '--porcelain'])
    if res.returncode == 128:
        raise HelperError('not-a-repo', stderr_tail(res.stderr) or 'not a git repository: %s' % repo)
    if res.returncode != 0:
        raise HelperError('git-failed', stderr_tail(res.stderr) or 'git worktree list failed')

    worktrees = []
    current = None
    for line in res.stdout.splitlines():
        if line.startswith('worktree '):
            current = {
                'path': line[len('worktree '):],
                'branch': None,
                'head': '',
                'isMain': len(worktrees) == 0
            }
            worktrees.append(current)
        elif current is None:
            continue
        elif line.startswith('HEAD '):
            current['head'] = line[len('HEAD '):]
        elif line.startswith('branch '):
            ref = line[len('branch '):]
            current['branch'] = ref[len('refs/heads/'):] if ref.startswith('refs/heads/') else ref
        elif line == 'detached':
            current['branch'] = None
    return {'worktrees': worktrees}


def cmd_worktree_remove(args):
    repo = os.path.abspath(os.path.expanduser(args.repo))
    path = os.path.abspath(os.path.expanduser(args.path))
    git_args = ['-C', repo, 'worktree', 'remove']
    if args.force:
        git_args.append('--force')
    git_args.append(path)
    res = run_git(git_args)
    if res.returncode != 0:
        raise HelperError('git-failed', stderr_tail(res.stderr) or 'git worktree remove failed')
    return {}


# ---------------------------------------------------------------- state


def state_file(project):
    state_dir = os.path.join(home_dir(), 'state')
    if project is None:
        return os.path.join(state_dir, 'index.json')
    if not re.match(r'^[A-Za-z0-9][A-Za-z0-9._-]*$', project):
        raise HelperError('bad-args', 'invalid project id: %s' % project)
    return os.path.join(state_dir, 'project-%s.json' % project)


def _load_state_doc(path):
    with open(path, 'r', encoding='utf-8') as fh:
        return json.load(fh)


def cmd_read_state(args):
    path = state_file(args.project)
    if not os.path.exists(path):
        return {'version': 0, 'state': None}
    try:
        doc = _load_state_doc(path)
    except (OSError, ValueError) as exc:
        raise HelperError('io-error', 'cannot read state file: %s' % exc)
    if not isinstance(doc, dict):
        raise HelperError('io-error', 'corrupt state file: %s' % path)
    version = doc.get('version')
    return {
        'version': version if isinstance(version, int) else 0,
        'state': doc.get('state')
    }


def cmd_write_state(args):
    if not args.stdin_json:
        raise HelperError('bad-args', 'write-state requires --stdin-json')
    raw = sys.stdin.read()
    try:
        body = json.loads(raw)
    except ValueError as exc:
        raise HelperError('bad-args', 'invalid JSON on stdin: %s' % exc)

    path = state_file(args.project)
    state_dir = os.path.dirname(path)
    os.makedirs(state_dir, exist_ok=True)

    lock_path = path + '.lock'
    try:
        lock_fh = open(lock_path, 'w')
    except OSError as exc:
        raise HelperError('io-error', 'cannot open lock file: %s' % exc)
    try:
        fcntl.flock(lock_fh.fileno(), fcntl.LOCK_EX)

        current = 0
        if os.path.exists(path):
            try:
                doc = _load_state_doc(path)
            except (OSError, ValueError) as exc:
                raise HelperError('io-error', 'cannot read state file: %s' % exc)
            if isinstance(doc, dict) and isinstance(doc.get('version'), int):
                current = doc['version']

        if args.version != current:
            raise HelperError(
                'conflict',
                'expected version %d, found %d' % (args.version, current)
            )

        new_doc = {
            'version': args.version + 1,
            'state': body,
            'updatedAt': int(time.time())
        }
        fd, tmp_path = tempfile.mkstemp(prefix='.state-', dir=state_dir)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as fh:
                json.dump(new_doc, fh)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp_path, path)
        except OSError as exc:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise HelperError('io-error', 'cannot write state file: %s' % exc)
        return {'version': args.version + 1}
    finally:
        lock_fh.close()


# ---------------------------------------------------------------- CLI plumbing


class ArgParser(argparse.ArgumentParser):
    """argparse that reports usage problems as bad-args envelopes."""

    def error(self, message):
        raise HelperError('bad-args', message)


def build_parser():
    parser = ArgParser(prog='helper', add_help=False)
    sub = parser.add_subparsers(dest='subcommand')

    def add(name, func):
        p = sub.add_parser(name, add_help=False)
        p.set_defaults(func=func)
        return p

    add('init', cmd_init)
    add('version', cmd_version)

    p = add('ls-tree', cmd_ls_tree)
    p.add_argument('--path', required=True)
    p.add_argument('--hidden', action='store_true')

    p = add('ls-trees', cmd_ls_trees)
    p.add_argument('--path', required=True, action='append')
    p.add_argument('--hidden', action='store_true')

    p = add('git-status', cmd_git_status)
    p.add_argument('--path', required=True)

    p = add('git-init', cmd_git_init)
    p.add_argument('--path', required=True)

    p = add('fs-move', cmd_fs_move)
    p.add_argument('--src', required=True)
    p.add_argument('--dest', required=True)

    p = add('fs-delete', cmd_fs_delete)
    p.add_argument('--path', required=True)
    p.add_argument('--recursive', action='store_true')

    p = add('fs-mkdir', cmd_fs_mkdir)
    p.add_argument('--path', required=True)

    add('session-list', cmd_session_list)

    p = add('session-create', cmd_session_create)
    p.add_argument('--name', required=True)
    p.add_argument('--cwd', required=True)
    p.add_argument('--agent', required=True, choices=['claude', 'codex', 'shell'])
    p.add_argument('--cmd')

    p = add('session-kill', cmd_session_kill)
    p.add_argument('--name', required=True)

    p = add('worktree-add', cmd_worktree_add)
    p.add_argument('--repo', required=True)
    p.add_argument('--path', required=True)
    p.add_argument('--branch', required=True)
    p.add_argument('--base')

    p = add('worktree-list', cmd_worktree_list)
    p.add_argument('--repo', required=True)

    p = add('worktree-remove', cmd_worktree_remove)
    p.add_argument('--repo', required=True)
    p.add_argument('--path', required=True)
    p.add_argument('--force', action='store_true')

    p = add('read-state', cmd_read_state)
    p.add_argument('--project', default=None)

    p = add('write-state', cmd_write_state)
    p.add_argument('--project', default=None)
    p.add_argument('--version', required=True, type=int)
    p.add_argument('--stdin-json', action='store_true')

    return parser


def main(argv):
    try:
        parser = build_parser()
        args = parser.parse_args(argv)
        if not getattr(args, 'func', None):
            raise HelperError('bad-args', 'missing subcommand')
        data = args.func(args)
        emit({'ok': True, 'data': data})
        return 0
    except HelperError as exc:
        emit({'ok': False, 'error': {'code': exc.code, 'message': exc.message}})
        return 1
    except OSError as exc:
        emit({'ok': False, 'error': {'code': 'io-error', 'message': str(exc)}})
        return 1
    except Exception as exc:  # noqa: BLE001 - last-resort envelope
        traceback.print_exc(file=sys.stderr)
        emit({'ok': False, 'error': {'code': 'internal', 'message': str(exc)}})
        return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
