#!/usr/bin/env python3
"""Unit tests for server-helper/helper.py.

Run with:  python3 server-helper/test_helper.py

Every test invokes the helper as a subprocess with REMOTE_AGENT_HOME pointed
at a fresh temp dir and REMOTE_AGENT_TMUX_SOCKET set to a unique name, and
asserts stdout carries exactly one JSON document.
"""

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import uuid

ROOT = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.join(ROOT, 'helper.py')
TMUX_CONF = os.path.join(ROOT, 'tmux.conf')
TMUX = shutil.which('tmux')
GIT = shutil.which('git')


class HelperTestCase(unittest.TestCase):
    """Base: fresh REMOTE_AGENT_HOME + unique tmux socket per test."""

    def setUp(self):
        self.home = tempfile.mkdtemp(prefix='ra-helper-test-')
        self.socket = 'ra-test-%s' % uuid.uuid4().hex[:12]
        self.addCleanup(shutil.rmtree, self.home, True)

    def env(self):
        env = dict(os.environ)
        env['REMOTE_AGENT_HOME'] = self.home
        env['REMOTE_AGENT_TMUX_SOCKET'] = self.socket
        return env

    def run_helper(self, *args, **kwargs):
        stdin_data = kwargs.pop('stdin_data', None)
        assert not kwargs, 'unexpected kwargs: %s' % kwargs
        proc = subprocess.run(
            [sys.executable, HELPER] + list(args),
            input=stdin_data,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            universal_newlines=True,
            env=self.env(),
            timeout=60
        )
        # stdout must be exactly one JSON document (json.loads rejects extras)
        try:
            doc = json.loads(proc.stdout)
        except ValueError:
            self.fail('stdout is not a single JSON doc: %r (stderr: %r)'
                      % (proc.stdout, proc.stderr))
        self.assertIsInstance(doc, dict)
        self.assertIn('ok', doc)
        if doc['ok']:
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertIn('data', doc)
            self.assertNotIn('error', doc)
        else:
            self.assertEqual(proc.returncode, 1, proc.stderr)
            self.assertIn('error', doc)
            self.assertIsInstance(doc['error'].get('code'), str)
            self.assertIsInstance(doc['error'].get('message'), str)
        return doc, proc

    def ok(self, *args, **kwargs):
        doc, proc = self.run_helper(*args, **kwargs)
        self.assertTrue(doc['ok'], 'expected ok:true, got %r (stderr: %r)'
                        % (doc, proc.stderr))
        return doc['data']

    def fail_code(self, code, *args, **kwargs):
        doc, _proc = self.run_helper(*args, **kwargs)
        self.assertFalse(doc['ok'], 'expected ok:false, got %r' % doc)
        self.assertEqual(doc['error']['code'], code, doc['error'])
        return doc['error']

    # ---- git fixtures ----

    def git(self, *args, **kwargs):
        cwd = kwargs.pop('cwd')
        assert not kwargs
        subprocess.run(
            [GIT or 'git'] + list(args),
            cwd=cwd,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE
        )

    def make_repo(self, name='repo'):
        repo = os.path.join(self.home, name)
        os.makedirs(repo)
        try:
            self.git('init', '-b', 'main', cwd=repo)
        except subprocess.CalledProcessError:
            self.git('init', cwd=repo)
            self.git('symbolic-ref', 'HEAD', 'refs/heads/main', cwd=repo)
        self.git('config', 'user.email', 'test@example.com', cwd=repo)
        self.git('config', 'user.name', 'Test', cwd=repo)
        with open(os.path.join(repo, 'a.txt'), 'w') as fh:
            fh.write('one\n')
        self.git('add', 'a.txt', cwd=repo)
        self.git('commit', '-m', 'initial', cwd=repo)
        return repo


class EnvelopeTests(HelperTestCase):
    def test_unknown_subcommand_is_bad_args(self):
        err = self.fail_code('bad-args', 'no-such-subcommand')
        self.assertTrue(err['message'])

    def test_missing_subcommand_is_bad_args(self):
        self.fail_code('bad-args')

    def test_missing_required_flag_is_bad_args(self):
        self.fail_code('bad-args', 'ls-tree')

    def test_non_int_version_is_bad_args(self):
        self.fail_code('bad-args', 'write-state', '--version', 'abc',
                       '--stdin-json', stdin_data='{}')


class InitVersionTests(HelperTestCase):
    def test_init_creates_dirs_and_version_file(self):
        data = self.ok('init')
        self.assertEqual(data['version'], '1.0.0')
        self.assertEqual(data['home'], self.home)
        self.assertTrue(os.path.isdir(os.path.join(self.home, 'bin')))
        self.assertTrue(os.path.isdir(os.path.join(self.home, 'state')))
        with open(os.path.join(self.home, 'VERSION')) as fh:
            self.assertEqual(fh.read().strip(), '1.0.0')

    def test_version_reports_own_sha256(self):
        data = self.ok('version')
        self.assertEqual(data['version'], '1.0.0')
        self.assertEqual(data['home'], self.home)
        with open(HELPER, 'rb') as fh:
            expected = hashlib.sha256(fh.read()).hexdigest()
        self.assertEqual(data['sha256'], expected)


class LsTreeTests(HelperTestCase):
    def setUp(self):
        super(LsTreeTests, self).setUp()
        self.tree = os.path.join(self.home, 'tree')
        os.makedirs(os.path.join(self.tree, 'alpha'))
        os.makedirs(os.path.join(self.tree, 'Beta'))
        os.makedirs(os.path.join(self.tree, '.hdir'))
        for name in ('a.txt', 'B.txt', 'ünïcode.txt', '.hidden'):
            with open(os.path.join(self.tree, name), 'w') as fh:
                fh.write('x')
        os.chmod(os.path.join(self.tree, 'a.txt'), 0o644)
        os.symlink(os.path.join(self.tree, 'alpha'), os.path.join(self.tree, 'zlink'))
        os.symlink(os.path.join(self.tree, 'a.txt'), os.path.join(self.tree, 'flink'))
        os.symlink('/nonexistent-target-xyz', os.path.join(self.tree, 'broken'))

    def entries(self, *extra):
        data = self.ok('ls-tree', '--path', self.tree, *extra)
        return data['entries']

    def test_order_dirs_first_case_insensitive(self):
        names = [e['name'] for e in self.entries()]
        self.assertEqual(
            names,
            ['alpha', 'Beta', 'zlink', 'a.txt', 'B.txt', 'broken', 'flink', 'ünïcode.txt']
        )

    def test_entry_fields(self):
        by_name = {e['name']: e for e in self.entries()}
        f = by_name['a.txt']
        self.assertEqual(f['type'], 'file')
        self.assertEqual(f['path'], os.path.join(self.tree, 'a.txt'))
        self.assertEqual(f['size'], 1)
        self.assertEqual(f['mode'], '644')
        self.assertIsInstance(f['mtime'], int)
        self.assertGreater(f['mtime'], 0)
        self.assertEqual(by_name['alpha']['type'], 'dir')

    def test_symlink_target_types(self):
        by_name = {e['name']: e for e in self.entries()}
        self.assertEqual(by_name['zlink']['type'], 'symlink')
        self.assertEqual(by_name['zlink']['linkTargetType'], 'dir')
        self.assertEqual(by_name['flink']['type'], 'symlink')
        self.assertEqual(by_name['flink']['linkTargetType'], 'file')
        self.assertEqual(by_name['broken']['type'], 'symlink')
        self.assertNotIn('linkTargetType', by_name['broken'])

    def test_hidden_filtering(self):
        names = {e['name'] for e in self.entries()}
        self.assertNotIn('.hidden', names)
        self.assertNotIn('.hdir', names)
        with_hidden = [e['name'] for e in self.entries('--hidden')]
        self.assertIn('.hidden', with_hidden)
        self.assertIn('.hdir', with_hidden)
        # hidden dir still sorts within the dirs group
        self.assertLess(with_hidden.index('.hdir'), with_hidden.index('a.txt'))

    def test_unicode_name_roundtrips(self):
        names = {e['name'] for e in self.entries()}
        self.assertIn('ünïcode.txt', names)

    def test_not_found(self):
        self.fail_code('not-found', 'ls-tree', '--path',
                       os.path.join(self.tree, 'nope'))

    def test_not_a_dir(self):
        self.fail_code('not-a-dir', 'ls-tree', '--path',
                       os.path.join(self.tree, 'a.txt'))


@unittest.skipUnless(GIT, 'git not installed')
class GitStatusTests(HelperTestCase):
    def test_clean_repo(self):
        repo = self.make_repo()
        data = self.ok('git-status', '--path', repo)
        self.assertEqual(data, {
            'isRepo': True,
            'branch': 'main',
            'upstream': None,
            'ahead': 0,
            'behind': 0,
            'staged': [],
            'modified': [],
            'untracked': []
        })

    def test_staged_modified_untracked(self):
        repo = self.make_repo()
        # tracked subdir committed up front (untracked file added there below)
        os.makedirs(os.path.join(repo, 'sub2'))
        with open(os.path.join(repo, 'sub2', 'tracked.txt'), 'w') as fh:
            fh.write('t\n')
        self.git('add', 'sub2/tracked.txt', cwd=repo)
        self.git('commit', '-m', 'tracked subdir', cwd=repo)
        # modified (worktree change, not staged)
        with open(os.path.join(repo, 'a.txt'), 'a') as fh:
            fh.write('more\n')
        # staged new file
        with open(os.path.join(repo, 'b.txt'), 'w') as fh:
            fh.write('b\n')
        self.git('add', 'b.txt', cwd=repo)
        # untracked, incl. an untracked subdir (git collapses it to 'sub/')
        with open(os.path.join(repo, 'c.txt'), 'w') as fh:
            fh.write('c\n')
        os.makedirs(os.path.join(repo, 'sub'))
        with open(os.path.join(repo, 'sub', 'e.txt'), 'w') as fh:
            fh.write('e\n')
        # untracked file inside a tracked dir -> repo-relative '?' path
        with open(os.path.join(repo, 'sub2', 'new.txt'), 'w') as fh:
            fh.write('n\n')
        data = self.ok('git-status', '--path', repo)
        self.assertTrue(data['isRepo'])
        self.assertEqual(data['staged'], ['b.txt'])
        self.assertEqual(data['modified'], ['a.txt'])
        self.assertEqual(sorted(data['untracked']), ['c.txt', 'sub/', 'sub2/new.txt'])
        self.assertEqual(data['ahead'], 0)
        self.assertEqual(data['behind'], 0)

    def test_staged_and_modified_same_file(self):
        repo = self.make_repo()
        with open(os.path.join(repo, 'a.txt'), 'a') as fh:
            fh.write('staged part\n')
        self.git('add', 'a.txt', cwd=repo)
        with open(os.path.join(repo, 'a.txt'), 'a') as fh:
            fh.write('worktree part\n')
        data = self.ok('git-status', '--path', repo)
        self.assertIn('a.txt', data['staged'])
        self.assertIn('a.txt', data['modified'])

    def test_deleted_file_counts_as_modified(self):
        repo = self.make_repo()
        os.unlink(os.path.join(repo, 'a.txt'))
        data = self.ok('git-status', '--path', repo)
        self.assertEqual(data['modified'], ['a.txt'])
        self.assertEqual(data['staged'], [])

    def test_non_repo_dir(self):
        plain = os.path.join(self.home, 'plain')
        os.makedirs(plain)
        data = self.ok('git-status', '--path', plain)
        self.assertEqual(data, {
            'isRepo': False,
            'branch': None,
            'upstream': None,
            'ahead': 0,
            'behind': 0,
            'staged': [],
            'modified': [],
            'untracked': []
        })


@unittest.skipUnless(GIT, 'git not installed')
class WorktreeTests(HelperTestCase):
    def test_add_new_branch_list_remove(self):
        repo = self.make_repo()
        wt1 = os.path.join(self.home, 'wt1')

        data = self.ok('worktree-add', '--repo', repo, '--path', wt1,
                       '--branch', 'feat1')
        self.assertEqual(data['path'], wt1)
        self.assertEqual(data['branch'], 'feat1')
        self.assertTrue(os.path.isdir(wt1))

        data = self.ok('worktree-list', '--repo', repo)
        wts = data['worktrees']
        self.assertEqual(len(wts), 2)
        self.assertTrue(wts[0]['isMain'])
        self.assertEqual(os.path.realpath(wts[0]['path']), os.path.realpath(repo))
        self.assertEqual(wts[0]['branch'], 'main')
        self.assertFalse(wts[1]['isMain'])
        self.assertEqual(wts[1]['branch'], 'feat1')
        for wt in wts:
            self.assertRegex(wt['head'], r'^[0-9a-f]{40,64}$')

        self.ok('worktree-remove', '--repo', repo, '--path', wt1)
        data = self.ok('worktree-list', '--repo', repo)
        self.assertEqual(len(data['worktrees']), 1)

    def test_add_existing_branch(self):
        repo = self.make_repo()
        self.git('branch', 'feat2', cwd=repo)
        wt2 = os.path.join(self.home, 'wt2')
        data = self.ok('worktree-add', '--repo', repo, '--path', wt2,
                       '--branch', 'feat2')
        self.assertEqual(data['branch'], 'feat2')
        data = self.ok('worktree-list', '--repo', repo)
        branches = [w['branch'] for w in data['worktrees']]
        self.assertIn('feat2', branches)

    def test_add_with_base_ref(self):
        repo = self.make_repo()
        wt3 = os.path.join(self.home, 'wt3')
        self.ok('worktree-add', '--repo', repo, '--path', wt3,
                '--branch', 'feat3', '--base', 'main')
        self.assertTrue(os.path.isfile(os.path.join(wt3, 'a.txt')))

    def test_add_failure_is_git_failed(self):
        repo = self.make_repo()
        wt = os.path.join(self.home, 'wt-dup')
        self.ok('worktree-add', '--repo', repo, '--path', wt, '--branch', 'featd')
        # same branch checked out elsewhere -> git refuses
        err = self.fail_code('git-failed', 'worktree-add', '--repo', repo,
                             '--path', os.path.join(self.home, 'wt-dup2'),
                             '--branch', 'featd')
        self.assertTrue(err['message'])

    def test_list_non_repo(self):
        plain = os.path.join(self.home, 'plain')
        os.makedirs(plain)
        self.fail_code('not-a-repo', 'worktree-list', '--repo', plain)


class StateTests(HelperTestCase):
    def test_missing_file_reads_version_zero(self):
        data = self.ok('read-state')
        self.assertEqual(data, {'version': 0, 'state': None})
        data = self.ok('read-state', '--project', 'p1')
        self.assertEqual(data, {'version': 0, 'state': None})

    def test_roundtrip_and_increment(self):
        body = {'projects': [{'id': 'x', 'name': 'ü'}], 'n': 1}
        data = self.ok('write-state', '--version', '0', '--stdin-json',
                       stdin_data=json.dumps(body))
        self.assertEqual(data, {'version': 1})
        self.assertTrue(os.path.isfile(os.path.join(self.home, 'state', 'index.json')))

        data = self.ok('read-state')
        self.assertEqual(data['version'], 1)
        self.assertEqual(data['state'], body)

        data = self.ok('write-state', '--version', '1', '--stdin-json',
                       stdin_data=json.dumps({'n': 2}))
        self.assertEqual(data, {'version': 2})
        data = self.ok('read-state')
        self.assertEqual(data['version'], 2)
        self.assertEqual(data['state'], {'n': 2})

    def test_version_conflict(self):
        self.ok('write-state', '--version', '0', '--stdin-json', stdin_data='{"a":1}')
        err = self.fail_code('conflict', 'write-state', '--version', '5',
                             '--stdin-json', stdin_data='{"a":2}')
        self.assertEqual(err['message'], 'expected version 5, found 1')
        # state untouched
        data = self.ok('read-state')
        self.assertEqual(data['state'], {'a': 1})

    def test_stale_zero_after_first_write_conflicts(self):
        self.ok('write-state', '--version', '0', '--stdin-json', stdin_data='{"a":1}')
        err = self.fail_code('conflict', 'write-state', '--version', '0',
                             '--stdin-json', stdin_data='{"a":2}')
        self.assertEqual(err['message'], 'expected version 0, found 1')

    def test_project_files_are_independent(self):
        self.ok('write-state', '--version', '0', '--stdin-json', stdin_data='{"idx":true}')
        self.ok('write-state', '--project', 'abc', '--version', '0',
                '--stdin-json', stdin_data='{"proj":true}')
        self.assertTrue(os.path.isfile(
            os.path.join(self.home, 'state', 'project-abc.json')))
        self.assertEqual(self.ok('read-state')['state'], {'idx': True})
        self.assertEqual(self.ok('read-state', '--project', 'abc')['state'],
                         {'proj': True})

    def test_write_state_bad_input(self):
        self.fail_code('bad-args', 'write-state', '--version', '0',
                       '--stdin-json', stdin_data='not json')
        self.fail_code('bad-args', 'write-state', '--version', '0',
                       stdin_data='{}')
        self.fail_code('bad-args', 'write-state', '--project', '../evil',
                       '--version', '0', '--stdin-json', stdin_data='{}')

    def test_stored_file_has_updated_at(self):
        self.ok('write-state', '--version', '0', '--stdin-json', stdin_data='{"a":1}')
        with open(os.path.join(self.home, 'state', 'index.json')) as fh:
            doc = json.load(fh)
        self.assertEqual(doc['version'], 1)
        self.assertEqual(doc['state'], {'a': 1})
        self.assertIsInstance(doc['updatedAt'], int)


@unittest.skipUnless(TMUX, 'tmux not installed')
class SessionTests(HelperTestCase):
    def setUp(self):
        super(SessionTests, self).setUp()
        # install the app tmux.conf into the isolated home so session-create
        # exercises the -f path
        shutil.copy(TMUX_CONF, os.path.join(self.home, 'tmux.conf'))
        self.workdir = os.path.join(self.home, 'work')
        os.makedirs(self.workdir)

    def tearDown(self):
        subprocess.run(
            [TMUX, '-L', self.socket, 'kill-server'],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )
        super(SessionTests, self).tearDown()

    def test_list_without_server_is_empty(self):
        data = self.ok('session-list')
        self.assertEqual(data, {'sessions': []})

    def test_create_list_kill_roundtrip(self):
        name = 'ra-test-sess'
        data = self.ok('session-create', '--name', name, '--cwd', self.workdir,
                       '--agent', 'shell')
        self.assertEqual(data, {'tmuxName': name})

        data = self.ok('session-list')
        sessions = {s['tmuxName']: s for s in data['sessions']}
        self.assertIn(name, sessions)
        sess = sessions[name]
        self.assertTrue(sess['alive'])
        self.assertEqual(sess['attachedClients'], 0)
        self.assertEqual(os.path.realpath(sess['cwd']),
                         os.path.realpath(self.workdir))
        self.assertIsInstance(sess['createdAt'], int)

        # duplicate name refused
        self.fail_code('session-exists', 'session-create', '--name', name,
                       '--cwd', self.workdir, '--agent', 'shell')

        self.ok('session-kill', '--name', name)
        data = self.ok('session-list')
        self.assertNotIn(name, [s['tmuxName'] for s in data['sessions']])

        # killing again -> session-missing
        self.fail_code('session-missing', 'session-kill', '--name', name)

    def test_kill_unknown_on_running_server(self):
        self.ok('session-create', '--name', 'ra-keepalive', '--cwd',
                self.workdir, '--agent', 'shell')
        self.fail_code('session-missing', 'session-kill', '--name', 'ra-nope')

    def test_non_ra_sessions_filtered(self):
        subprocess.run(
            [TMUX, '-L', self.socket, 'new-session', '-d', '-s', 'other',
             '-c', self.workdir],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )
        data = self.ok('session-list')
        self.assertNotIn('other', [s['tmuxName'] for s in data['sessions']])

    def test_create_with_wrapped_command(self):
        name = 'ra-test-cmd'
        data = self.ok('session-create', '--name', name, '--cwd', self.workdir,
                       '--agent', 'shell', '--cmd', 'sleep 30')
        self.assertEqual(data, {'tmuxName': name})
        data = self.ok('session-list')
        self.assertIn(name, [s['tmuxName'] for s in data['sessions']])

    def test_crashed_command_drops_to_shell(self):
        # command exits non-zero -> pane must survive on a fallback shell
        name = 'ra-test-crash'
        self.ok('session-create', '--name', name, '--cwd', self.workdir,
                '--agent', 'shell', '--cmd', 'definitely-not-a-command-xyz')
        deadline = 30
        alive = False
        while deadline > 0:
            data = self.ok('session-list')
            alive = name in [s['tmuxName'] for s in data['sessions']]
            if alive:
                break
            deadline -= 1
        self.assertTrue(alive, 'session died instead of dropping to a shell')
        # give the wrapper a moment, then confirm it is still there
        import time as _time
        _time.sleep(1.0)
        data = self.ok('session-list')
        self.assertIn(name, [s['tmuxName'] for s in data['sessions']])

    def test_create_in_missing_dir(self):
        self.fail_code('not-a-dir', 'session-create', '--name', 'ra-x',
                       '--cwd', os.path.join(self.home, 'nope'),
                       '--agent', 'shell')

    def test_bad_agent_is_bad_args(self):
        self.fail_code('bad-args', 'session-create', '--name', 'ra-x',
                       '--cwd', self.workdir, '--agent', 'gemini')


if __name__ == '__main__':
    unittest.main(verbosity=2)
