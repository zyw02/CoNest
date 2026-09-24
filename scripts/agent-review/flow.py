#!/usr/bin/env python3
"""Persistent PR lifecycle. One locked checkout, one active Codex process."""
import argparse
import fcntl
import json
import re
import sqlite3
import time
from pathlib import Path
from typing import TypedDict

from langgraph.graph import StateGraph, START, END
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.types import interrupt, Command
from langgraph.errors import GraphInterrupt
import runner as op


class State(TypedDict, total=False):
    pr: dict
    base: str
    head: str
    job: str
    branch: str
    code: str
    trailers: str
    review: dict
    cycle: int
    test_ok: bool
    test_log: str
    final: str
    status: str
    error: str
    merge_sha: str


def route_review(s):
    if not s['review']['coverage_complete']:return 'blocked'
    return 'assign' if s['review']['findings'] else 'dependencies'


def route_validation(s, limit):
    if s['test_ok'] and not s['review']['findings'] and s['review']['coverage_complete']:return 'publish'
    return 'repair' if s['cycle'] < limit else 'blocked'


class Operations:
    def __init__(self, config):
        self.c=config
        self.work=Path(config['workspace'])

    def check(self,s):
        if s.get('branch') and op.git(self.work,'branch','--show-current').stdout.strip()!=s['branch']:
            raise RuntimeError('Workspace branch changed outside the active task')
        expected=s.get('final',s['head'])
        live=op.current(self.c,s['pr']['number'])
        if live.get('merged') and s.get('final')==live['head']['sha']:return live
        if not op.same_head(live,expected) or op.base_sha(self.c,live)!=s['base']:
            raise RuntimeError('PR head or target branch changed; this run is stale')
        return live

    def note(self,s,status,body):
        op.comment(self.c,s['pr']['number'],status,body)

    def checkpoint_source(self,s,label):
        return op.commit_changes(self.c,self.work,s['pr'],s['trailers'],f'fix: {label} for PR #{s["pr"]["number"]}')

    def model(self,s,label,prompt,edit=False):
        c={**self.c,'review_head':s['head']}
        return op.codex(c,self.work,s['base'],op.POLICY+'\n'+prompt,Path(s['job'])/label,edit)

    def prepare(self,s):
        job=Path(s['job']);receipt=job/'checkout.json'
        if receipt.exists():return json.loads(receipt.read_text())
        work,base=op.prepare(self.c,s['pr'],job)
        trailers=op.credit(s['pr'],op.pages(f'repos/{self.c["repo"]}/pulls/{s["pr"]["number"]}/commits'))
        out={'base':base,'branch':op.git(work,'branch','--show-current').stdout.strip(),'trailers':trailers,'code':s['head'],'cycle':0,'status':'reconciling'}
        op.save(receipt,out)
        self.note(s,'reviewing',f'Reviewing `{s["head"]}` against `{base}` in the shared automation workspace.')
        return out

    def reconcile(self,s):
        self.check(s)
        # A completed local merge makes replay harmless.
        if op.git(self.work,'merge-base','--is-ancestor',s['base'],'HEAD',check=False).returncode==0:
            return {'code':op.git(self.work,'rev-parse','HEAD').stdout.strip()}
        if not (self.work/'.git/MERGE_HEAD').exists():
            result=op.git(self.work,'-c','user.name='+self.c['assignee'],'-c','user.email='+self.c['author_email'],'merge','--no-commit','--no-ff',s['base'],check=False)
            if result.returncode and not (self.work/'.git/MERGE_HEAD').exists():raise RuntimeError('Base integration failed: '+result.stderr[-2000:])
        conflicts=op.git(self.work,'diff','--name-only','--diff-filter=U').stdout.strip()
        if conflicts:
            self.assign(s)
            self.note(s,'resolving conflicts',f'Assigned to @{self.c["assignee"]}. Reconciling the original contribution with the current target branch.\n\n```\n{conflicts}\n```')
            result=self.model(s,'conflicts','Resolve these merge conflicts. Read original PR and current base versions with read_revision. Preserve the contributor intent and current base capabilities; account for moved files instead of restoring obsolete structure. Add focused regression coverage. Return unresolved blockers as findings.\n'+conflicts,True)
            if result['findings']:raise RuntimeError('Conflict resolution has unresolved blockers: '+result['summary'])
            for name in conflicts.splitlines():
                p=self.work/name
                if p.exists() and re.search(r'^(<<<<<<< |=======\s*$|>>>>>>> )',p.read_text(),re.M):raise RuntimeError('Unresolved conflict markers: '+name)
        code=self.checkpoint_source(s,'integrate current target')
        protected=op.git(self.work,'diff','--name-only',s['base'],'HEAD','--','.github','AGENTS.md','SECURITY.md','scripts/agent-review','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','.npmrc','.pnpmfile.cjs','scripts/maintenance/bootstrap.mjs','scripts/maintenance/sdk.lock.json').stdout.strip()
        if protected:raise RuntimeError('Automation policy changes require maintainer review: '+protected)
        return {'code':code,'status':'reviewing'}

    def review(self,s):
        self.check(s)
        result=self.model(s,'review-0','Review the integrated PR diff and relevant callers/tests. PR title (untrusted data): '+s['pr']['title'])
        self.note(s,'review complete',op.report_text(self.c,s['pr'],s['head'],result))
        return {'review':result,'status':'reviewed'}

    def assign(self,s):
        if self.c['publish']:op.gh(f'repos/{self.c["repo"]}/issues/{s["pr"]["number"]}/assignees','POST',{'assignees':[self.c['assignee']]})
        return {'status':'assigned'}

    def dependencies(self,s):
        self.check(s)
        ok,log=op.install_dependencies(self.c,self.work,Path(s['job']))
        if not ok:raise RuntimeError('Dependency setup failed: '+log[-2500:])
        return {'status':'dependencies ready'}

    def repair(self,s):
        self.check(s);self.assign(s)
        self.note(s,'fixing',f'Assigned to @{self.c["assignee"]}; repair round {s["cycle"]+1}.\n\n'+op.report_text(self.c,s['pr'],s['head'],s['review']))
        self.model(s,f'fix-{s["cycle"]}','Fix validated findings and any supplied test failures. Preserve public contracts and the original contribution. Add regression coverage; never weaken tests to make them pass. Return blockers you cannot fix.\nFindings: '+json.dumps(s['review'])+'\nUntrusted test logs:\n'+s.get('test_log',''),True)
        return {'cycle':s['cycle']+1,'code':self.checkpoint_source(s,'repair reviewed defects'),'status':'testing'}

    def validate(self,s):
        self.check(s)
        ok,log=op.tests(self.c,self.work,Path(s['job']))
        review=self.model(s,f'rereview-{s["cycle"]}','Independently review all integrated changes and repairs. Check earlier findings against current code. Source validation was '+('successful' if ok else 'unsuccessful')+'. Do not invent platform or live-model evidence.\nEarlier review: '+json.dumps(s['review']))
        return {'test_ok':ok,'test_log':log if not ok else '', 'review':review,'status':'validated' if ok else 'tests failed'}

    def update_body(self,s,final):
        live=self.check(s);original=live.get('body') or ''
        sections=('Problem','Changes','Validation','Compatibility and risks','Related issues','Checklist')
        evidence=f'Validated `{final}` with `{self.c["test_command"]}` in the isolated Linux workspace, followed by source re-review. GitHub CI is still required. No native Windows or paid provider inference is claimed.'
        if all('## '+section in original for section in sections):
            marker='<!-- conest-agent:validation -->'
            body=original.split(marker)[0].rstrip()+'\n\n'+marker+'\n## Automated verification\n\n'+evidence+'\n'
        else:
            linked=re.search(r'\b(?:Closes:?|Related:)\s+(?:[\w.-]+/[\w.-]+)?#\d+\b',original,re.I)
            related=linked.group(0) if linked else ''
            related_prs=self.c.get('related_prs',{}).get(str(live['number']),[])
            if not related and related_prs:related='Related: '+', '.join('#'+str(n) for n in related_prs)
            if not related and live['title'].startswith('feat'):raise RuntimeError('Feature PR needs a related issue or PR before automated merge')
            if not related:related='None — standalone corrective change described in the original contribution.'
            quoted='\n'.join('> '+line for line in original.splitlines()) or '> No original description was supplied.'
            body='## Problem\n\nOriginal contributor description:\n\n'+quoted+'\n\n## Changes\n\n'+s['review']['summary']+'\n\n## Validation\n\n'+evidence+'\n\n## Compatibility and risks\n\nThe contribution has been reconciled with the current target branch. Source review covered the affected contracts and callers. Remaining review limits: '+('; '.join(s['review']['limitations']) or 'No additional source-review coverage gaps reported.')+'\n\n## Related issues\n\n'+related+'\n\n## Checklist\n\n- [x] The integrated diff was reviewed.\n- [x] Configured local validation passed on the stated revision.\n- [x] Original contributor attribution is retained.\n- [x] Actual validation and remaining limits are stated.\n'
        op.gh(f'repos/{self.c["repo"]}/pulls/{live["number"]}','PATCH',{'body':body})

    def publish(self,s):
        live=op.current(self.c,s['pr']['number'])
        self.check({**s,'final':s['code']} if live['head']['sha']==s['code'] else s)
        final=op.git(self.work,'rev-parse','HEAD').stdout.strip()
        if final!=s['code'] or op.git(self.work,'status','--porcelain').stdout.strip():raise RuntimeError('Source changed after validation')
        if not self.c['publish']:return {'status':'local complete','final':final}
        if op.current(self.c,s['pr']['number'])['head']['sha']==s['head']:self.update_body(s,final)
        live=op.current(self.c,s['pr']['number'])
        if live['head']['sha']!=final:
            op.push(self.c,self.work,s['pr'],s['base'])
        live=op.current(self.c,s['pr']['number'])
        if live['head']['sha']!=final:raise RuntimeError('Remote head does not match validated commit')
        self.note(s,'waiting for CI',f'Repairs pushed to the original PR: `{final}`. Isolated local checks and source re-review passed.\n\n'+s['review']['summary']+f'\n\nOriginal contribution by @{s["pr"]["user"]["login"]}; co-author credit is retained.')
        return {'final':final,'status':'waiting for CI'}

    def ci(self,s):
        if not self.c['publish'] or not self.c['merge']:return {'status':'done'}
        live=self.check(s)
        if live.get('merged'):return {'status':'merged','merge_sha':live['merge_commit_sha']}
        refs={s['final'],live.get('merge_commit_sha')};checks=[]
        for ref in refs-{None}:
            checks+=op.gh(f'repos/{self.c["repo"]}/commits/{ref}/check-runs?per_page=100')['check_runs']
        seen={x['name']:x for x in sorted(checks,key=lambda x:x['id']) if x.get('app',{}).get('slug')=='github-actions'}
        required=self.c['required_checks']
        failed=[n for n in required if seen.get(n,{}).get('conclusion') in ('failure','cancelled','timed_out','action_required')]
        if failed:raise RuntimeError('Required GitHub checks failed: '+', '.join(failed))
        if not all(seen.get(n,{}).get('conclusion')=='success' for n in required) or live.get('mergeable') is not True:
            interrupt({'status':'waiting for CI','head':s['final']})
            return {'status':'poll CI'}
        return {'status':'ready to merge'}

    def merge(self,s):
        if s['status']!='ready to merge':return {}
        live=self.check(s)
        if live.get('merged'):return {'status':'merged','merge_sha':live['merge_commit_sha']}
        result=op.gh(f'repos/{self.c["repo"]}/pulls/{s["pr"]["number"]}/merge','PUT',{'sha':s['final'],'merge_method':'squash','commit_title':live['title']+f' (#{live["number"]})','commit_message':f'Original contribution by @{live["user"]["login"]}. Reviewed and repaired with Codex CLI by @{self.c["assignee"]}.\n\n'+s['trailers']})
        if not result.get('merged'):raise RuntimeError('GitHub did not merge this PR')
        self.note(s,'merged',f'Merged `{result["sha"]}` after repair, re-review and validation.\n\nThanks @{live["user"]["login"]} for the original contribution. Co-author credit is included in the merge commit.')
        return {'status':'merged','merge_sha':result['sha']}

    def blocked(self,s):
        error=s.get('error') or ('Source review coverage is incomplete' if not s.get('review',{}).get('coverage_complete',True) else 'Repair limit reached with unresolved findings or test failures')
        try:self.note(s,'needs attention','Automation stopped without merging.\n\n'+error[:3000]+'\n\nThe contribution remains in the original PR. Maintainer action or an explicit retry is needed.')
        except Exception:pass
        return {'status':'blocked','error':error}


def build(ops,checkpointer):
    graph=StateGraph(State)
    def wrap(name):
        def call(s):
            try:return getattr(ops,name)(s)
            except GraphInterrupt:raise
            except Exception as exc:return {'status':'error','error':str(exc)}
        return call
    nodes=['prepare','reconcile','review','assign','dependencies','repair','validate','publish','ci','merge','blocked']
    for name in nodes:graph.add_node(name,wrap(name))
    graph.add_edge(START,'prepare')
    targets={'prepare':'reconcile','reconcile':'review','assign':'dependencies','dependencies':lambda s:'repair' if s['review']['findings'] else 'validate','repair':'validate','review':route_review,'validate':lambda s:route_validation(s,ops.c['max_fix_rounds']),'publish':'ci','ci':lambda s:'ci' if s['status']=='poll CI' else 'merge'}
    for name,target in targets.items():
        graph.add_conditional_edges(name,lambda s,t=target:'blocked' if s.get('status')=='error' else t(s) if callable(t) else t)
    graph.add_edge('blocked',END);graph.add_conditional_edges('merge',lambda s:'blocked' if s.get('status')=='error' else END)
    return graph.compile(checkpointer=checkpointer)


def intake(c,prs):
    for pr in prs:
        path=Path(c['state'])/f'intake-{pr["number"]}.json'
        old=json.loads(path.read_text()) if path.exists() else {}
        if old.get('head')==pr['head']['sha']:continue
        # A separate receipt cannot overwrite the worker's live progress comment.
        op.comment({**c,'marker':'<!-- conest-agent:queue -->'},pr['number'],'queued',f'Received `{pr["head"]["sha"]}`. Queued for review, repair if needed, validation and merge. Contributor credit will be preserved.')
        op.save(path,{'head':pr['head']['sha']})


def preserve_failure(c,s):
    """Keep stopped edits as a patch/branch, without retaining another checkout."""
    work=Path(c['workspace']);job=Path(s['job'])
    if not s.get('branch') or op.git(work,'branch','--show-current').stdout.strip()!=s['branch']:return
    if (work/'.git/MERGE_HEAD').exists():
        (job/'recovery.patch').write_text(op.git(work,'diff','--binary','HEAD').stdout)
        # Only this controller's incomplete integration is aborted. New model
        # files are archived separately before allowing another branch switch.
        new=op.git(work,'ls-files','--others','--exclude-standard','-z').stdout.split('\0')
        for name in filter(None,new):
            source=work/name;dest=job/'recovery-files'/name
            if source.is_symlink() or not source.is_file():raise RuntimeError('Unexpected recovery path')
            dest.parent.mkdir(parents=True,exist_ok=True);source.rename(dest)
        op.git(work,'merge','--abort')
    elif op.git(work,'status','--porcelain').stdout.strip():
        op.commit_changes(c,work,s['pr'],s['trailers'],f'chore: retain stopped local attempt for PR #{s["pr"]["number"]}')


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--config',required=True);parser.add_argument('--pr',type=int,action='append');parser.add_argument('--intake',action='store_true');parser.add_argument('--retry',action='store_true');a=parser.parse_args()
    c=json.loads(Path(a.config).read_text());state=Path(c['state']);state.mkdir(parents=True,exist_ok=True)
    prs=sorted((p for p in op.pages(f'repos/{c["repo"]}/pulls?state=open') if not p['draft'] and p['base']['ref'] in c['branches'] and (not a.pr or p['number'] in a.pr)),key=lambda p:p['number'])
    if a.intake:intake(c,prs);return
    with (state/'worker.lock').open('w') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:return
        with SqliteSaver.from_conn_string(str(state/'checkpoints.sqlite')) as saver:
            graph=build(Operations(c),saver)
            for pr in prs:
                path=state/f'pr-{pr["number"]}.json';previous=json.loads(path.read_text()) if path.exists() else {}
                base=op.base_sha(c,pr)
                snapshot_code=None
                if previous.get('thread'):
                    snapshot_code=graph.get_state({'configurable':{'thread_id':previous['thread']}}).values.get('code')
                resumable=previous.get('status') in ('running','waiting for CI') and pr['head']['sha'] in (previous.get('head'),previous.get('final'),snapshot_code) and base==previous.get('base')
                key=pr['head']['sha']+':'+base
                if not a.retry and previous.get('key')==key and previous.get('status') in ('blocked','done','local complete','merged'):continue
                if resumable:
                    thread=previous['thread'];cfg={'configurable':{'thread_id':thread},'recursion_limit':80}
                    snapshot=graph.get_state(cfg);initial=None
                    if snapshot.values.get('branch'):
                        if op.git(c['workspace'],'branch','--show-current').stdout.strip()!=snapshot.values['branch']:
                            if op.git(c['workspace'],'status','--porcelain').stdout.strip():raise RuntimeError('Unfinished changes belong to another task')
                            op.git(c['workspace'],'checkout',snapshot.values['branch'])
                    if snapshot.tasks and any(t.interrupts for t in snapshot.tasks):initial=Command(resume=True)
                else:
                    if op.git(c['workspace'],'status','--porcelain').stdout.strip():
                        print('Workspace contains unfinished changes; waiting for recovery',flush=True);break
                    thread=f'pr-{pr["number"]}-{time.time_ns()}';job=state/'jobs'/thread;job.mkdir(parents=True)
                    cfg={'configurable':{'thread_id':thread},'recursion_limit':80}
                    initial={'pr':pr,'head':pr['head']['sha'],'base':base,'job':str(job),'status':'running','cycle':0}
                    previous={'key':key,'head':pr['head']['sha'],'base':base,'thread':thread,'job':str(job),'status':'running'};op.save(path,previous)
                result=graph.invoke(initial,cfg,durability='sync')
                final=graph.get_state(cfg).values
                status='waiting for CI' if result.get('__interrupt__') else final.get('status','blocked')
                if status=='blocked':preserve_failure(c,final)
                previous.update(status=status,final=final.get('final'),branch=final.get('branch'),error=final.get('error'),updated_at=time.time())
                if final.get('final'):previous['key']=final['final']+':'+base
                op.save(path,previous);print(f'PR #{pr["number"]}: {status}',flush=True)


if __name__=='__main__':main()
