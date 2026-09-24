import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.types import interrupt, Command
from flow import build, Operations
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

    def test_stale_target_rejected(self):
        ops=Operations({'workspace':'/unused','repo':'o/r'})
        live={'state':'open','draft':False,'head':{'sha':'head'}}
        with patch('runner.current',return_value=live),patch('runner.base_sha',return_value='new-base'):
            with self.assertRaisesRegex(RuntimeError,'stale'):ops.check({'head':'head','base':'old-base','pr':{'number':1}})

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
