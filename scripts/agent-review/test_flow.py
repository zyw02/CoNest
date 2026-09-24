import tempfile
import os
import shlex
import unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.types import interrupt, Command
from flow import build, Operations, confirmed_publish
from workspace import Workspace
import runner


class Fake:
    c={'max_fix_rounds':2}
    def __init__(self,failed=False):self.calls=[];self.failed=failed;self.ci_ready=False
    def __getattr__(self,name):
        def call(s):
            self.calls.append(name)
            if name=='prepare':return {'cycle':0}
            if name=='review':return {'review':{'coverage_complete':True,'findings':['defect']}}
            if name=='repair':return {'cycle':s['cycle']+1}
            if name=='validate':return {'test_ok':not self.failed,'review':{'coverage_complete':True,'findings':[]}}
            if name=='publish':return {'final':'abc'}
            if name=='ci':
                if not self.ci_ready:interrupt('CI pending')
                return {'status':'ready to merge'}
            if name=='merge':return {'status':'merged'}
            if name=='blocked':return {'status':'blocked'}
            return {}
        return call


class FlowTests(unittest.TestCase):
    def test_restart_does_not_repeat_repair_or_push(self):
        with tempfile.TemporaryDirectory() as d:
            db=str(Path(d)/'state.sqlite');ops=Fake();config={'configurable':{'thread_id':'pr-1'}}
            with SqliteSaver.from_conn_string(db) as saver:
                result=build(ops,saver).invoke({},config,durability='sync')
                self.assertIn('__interrupt__',result)
            before=list(ops.calls);ops.ci_ready=True
            with SqliteSaver.from_conn_string(db) as saver:
                self.assertEqual(build(ops,saver).invoke(Command(resume=True),config)['status'],'merged')
            self.assertNotIn('repair',ops.calls[len(before):]);self.assertEqual(ops.calls.count('publish'),1)

    def test_failure_limit_never_pushes_or_merges(self):
        with tempfile.TemporaryDirectory() as d, SqliteSaver.from_conn_string(str(Path(d)/'db')) as saver:
            ops=Fake(failed=True)
            result=build(ops,saver).invoke({}, {'configurable':{'thread_id':'fail'}})
            self.assertEqual(result['status'],'blocked');self.assertEqual(ops.calls.count('repair'),2)
            self.assertNotIn('publish',ops.calls);self.assertNotIn('merge',ops.calls)

    def test_already_integrated_policy_change_stops_before_review(self):
        ops=Operations({'workspace':'/unused'})
        def git(_work,*args,**kwargs):
            return SimpleNamespace(returncode=0,stdout='.github/workflows/review.yml\n' if args[0]=='diff' else 'head\n')
        with patch.object(ops,'check'),patch('runner.git',side_effect=git),patch.object(ops,'model') as model:
            with self.assertRaisesRegex(RuntimeError,'policy changes'):
                ops.reconcile({'base':'already-integrated','pr':{'number':1}})
            model.assert_not_called()

    def test_stale_target_rejected(self):
        ops=Operations({'workspace':'/unused','repo':'o/r'})
        live={'state':'open','draft':False,'head':{'sha':'head'}}
        with patch('runner.current',return_value=live),patch('runner.base_sha',return_value='new-base'):
            with self.assertRaisesRegex(RuntimeError,'stale'):ops.check({'head':'head','base':'old-base','pr':{'number':1}})

    def test_push_waits_for_github_visibility_without_pushing_twice(self):
        ops=Operations({'workspace':'/unused','publish':True})
        old={'head':{'sha':'old'}};new={'head':{'sha':'new'}}
        s={'pr':{'number':1,'head':{'sha':'old'},'user':{'login':'author'}},'head':'old','base':'base','code':'new','review':{'summary':'ok'}}
        def git(_work,*args,**kwargs):return SimpleNamespace(stdout='new\n' if args[0]=='rev-parse' else '')
        with patch.object(ops,'check'),patch.object(ops,'update_body'),patch.object(ops,'note'),patch('runner.git',side_effect=git),patch('runner.current',side_effect=[old,old,old,old,new]),patch('runner.push') as push,patch('flow.time.sleep') as sleep:
            result=ops.publish(s)
            self.assertEqual(result['final'],'new');self.assertEqual(push.call_count,1);sleep.assert_called_once_with(2)

    def test_approval_is_limited_to_unchanged_known_ci(self):
        ops=Operations({'workspace':'/unused','repo':'o/r','publish':True,'merge':True})
        s={'pr':{'number':1},'final':'new'}
        runs={'workflow_runs':[{'id':10,'head_sha':'new','conclusion':'action_required','path':'.github/workflows/review.yml'},{'id':11,'head_sha':'new','conclusion':'action_required','path':'.github/workflows/untrusted.yml'}]}
        with patch.object(ops,'check',return_value={}),patch('runner.pages',return_value=[]),patch('runner.gh',side_effect=[runs,None]) as gh,patch('flow.interrupt'):
            self.assertEqual(ops.ci(s)['status'],'poll CI')
            self.assertEqual(gh.call_args_list[-1].args,('repos/o/r/actions/runs/10/approve','POST'))
        with patch.object(ops,'check',return_value={}),patch('runner.pages',return_value=[{'filename':'.github/workflows/review.yml'}]),patch('runner.gh',return_value=runs) as gh:
            with self.assertRaisesRegex(RuntimeError,'modified workflows'):ops.ci(s)
            self.assertEqual(gh.call_count,1)

    def test_recovered_push_requires_the_successfully_validated_commit(self):
        state={'code':'validated','test_ok':True,'review':{'coverage_complete':True,'findings':[]}}
        pr={'head':{'sha':'validated'}}
        self.assertTrue(confirmed_publish(state,pr))
        self.assertFalse(confirmed_publish({**state,'test_ok':False},pr))
        self.assertFalse(confirmed_publish(state,{'head':{'sha':'someone-elses-commit'}}))
        self.assertFalse(confirmed_publish({**state,'review':{'coverage_complete':True,'findings':['defect']}},pr))

    def test_focused_tests_reject_other_paths_and_quote_test_names(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);(root/'test').mkdir();name='test/a; touch injected.test.ts';(root/name).write_text('// fixture')
            env={'SOURCE_TOOLCHAIN':'/toolchain','SOURCE_TEST_TIMEOUT':'10','SOURCE_TEST_LOG':str(root/'logs')}
            with patch.dict(os.environ,env),patch('runner.tests',return_value=(True,'passed')) as tests:
                result=Workspace(root,True).call('run_test',{'path':name})
                self.assertTrue(result['passed']);command=tests.call_args.args[0]['test_command']
                self.assertEqual(shlex.split(command)[-1],name)
                with self.assertRaises(ValueError):Workspace(root).call('run_test',{'path':name})
                with self.assertRaises(ValueError):Workspace(root,True).call('run_test',{'path':'scripts/build.mjs'})
                (root/'.git').mkdir();(root/'.git/MERGE_HEAD').write_text('pending')
                with self.assertRaisesRegex(ValueError,'Finish conflict'):Workspace(root,True).call('run_test',{'path':name})
                self.assertEqual(tests.call_count,1)

    def test_paths_cannot_escape_or_modify_policy(self):
        with tempfile.TemporaryDirectory() as d:
            w=Workspace(d,True);(Path(d)/'escape').symlink_to('/etc')
            for name in ['../secret','/etc/passwd','escape/passwd','.git/config','.github/workflows/x.yml','AGENTS.md']:
                with self.subTest(name=name),self.assertRaises(ValueError):w.path(name,write=True)

    def test_credit_retains_author_and_rejects_injected_trailer(self):
        pr={'user':{'id':123,'login':'contributor'}}
        commits=[{'commit':{'author':{'name':'bad\nSigned-off-by: fake','email':'a@example.com'}}}]
        self.assertEqual(runner.credit(pr,commits),'Co-authored-by: contributor <123+contributor@users.noreply.github.com>')


if __name__=='__main__':unittest.main()
