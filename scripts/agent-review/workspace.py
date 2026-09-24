#!/usr/bin/env python3
"""A bounded MCP file interface. Never executes repository code or shell text."""
import json, os, subprocess, sys
from pathlib import Path, PurePosixPath

class Workspace:
    def __init__(self, root, editable=False):
        self.root = Path(root).resolve()
        self.editable = editable

    def path(self, name, write=False):
        p = PurePosixPath(name)
        if not name or p.is_absolute() or any(x in ('..', '.git', '.codex', '.local', '.vendor', '.pnpm-store', 'node_modules') for x in p.parts):
            raise ValueError('Path is outside the source workspace')
        dest = self.root.joinpath(*p.parts)
        if any(x.is_symlink() for x in [dest, *dest.parents] if x != self.root.parent):
            raise ValueError('Symlinks are not supported')
        if not dest.resolve().is_relative_to(self.root): raise ValueError('Path escapes workspace')
        if write and (not self.editable or name.startswith('.github/') or p.name in ('AGENTS.md','SECURITY.md')):
            raise ValueError('This path cannot be modified by the worker')
        return dest

    def git(self, *args):
        return subprocess.check_output(['git','-c','core.hooksPath=/dev/null',*args],cwd=self.root,timeout=30).decode('utf8','replace')

    def files(self):
        return sorted(set(x for x in self.git('ls-files','--cached','--others','--exclude-standard').splitlines() if x and not x.startswith(('.git/', '.vendor/', 'node_modules/'))))

    def call(self, name, a):
        if name == 'list_files': return [x for x in self.files() if a.get('contains','') in x][:1000]
        if name == 'read_file':
            p=self.path(a['path']); start=max(1,int(a.get('start',1))); count=min(400,max(1,int(a.get('count',200))))
            if p.stat().st_size>1_000_000: raise ValueError('File too large; inspect diff or narrow the task')
            raw=p.read_bytes()
            if b'\0' in raw: raise ValueError('Binary file')
            lines=raw.decode('utf8','replace').splitlines()
            return {'total_lines':len(lines),'content':'\n'.join(f'{i+1}: {l}' for i,l in enumerate(lines) if start-1<=i<start-1+count)}
        if name == 'search':
            needle=a['text']
            if not needle or len(needle)>500: raise ValueError('Search text must be 1-500 characters')
            matches=[]
            for f in self.files():
                if a.get('path_contains','') not in f:continue
                try:
                    p=self.path(f)
                    if p.stat().st_size>500_000:continue
                    for i,l in enumerate(p.read_text(errors='replace').splitlines()):
                        if needle in l:matches.append({'path':f,'line':i+1,'text':l[:800]})
                        if len(matches)>=100:return {'matches':matches,'truncated':True}
                except (OSError,ValueError):continue
            return {'matches':matches,'truncated':False}
        if name == 'diff':
            base=os.environ['REVIEW_BASE_SHA']
            if len(base)!=40 or any(c not in '0123456789abcdef' for c in base):raise ValueError('Invalid base revision')
            args=['diff','--no-ext-diff','--no-textconv','--unified=5',base,'--']
            if a.get('path'):self.path(a['path']);args.append(a['path'])
            output=self.git(*args)
            return {'content':output[:100000],'truncated':len(output)>100000}
        if name == 'changes':
            return self.git('diff','--no-ext-diff','--no-textconv','--stat',os.environ['REVIEW_BASE_SHA'])
        if name == 'read_revision':
            self.path(a['path'])
            ref=os.environ['REVIEW_BASE_SHA'] if a['revision']=='base' else os.environ['REVIEW_HEAD_SHA']
            if len(ref)!=40 or any(c not in '0123456789abcdef' for c in ref):raise ValueError('Invalid revision')
            lines=self.git('show',ref+':'+a['path']).splitlines(); start=max(1,a.get('start',1)); count=min(400,a.get('count',200))
            return {'total_lines':len(lines),'content':'\n'.join(f'{i+1}: {l}' for i,l in enumerate(lines) if start-1<=i<start-1+count)}
        if name == 'restore_base':
            p=self.path(a['path'],write=True);ref=os.environ['REVIEW_BASE_SHA']
            if len(ref)!=40 or any(c not in '0123456789abcdef' for c in ref):raise ValueError('Invalid revision')
            exists=subprocess.run(['git','cat-file','-e',ref+':'+a['path']],cwd=self.root,capture_output=True).returncode==0
            if exists:
                content=self.git('show',ref+':'+a['path'])
                if len(content)>1_000_000:raise ValueError('File too large')
                p.parent.mkdir(parents=True,exist_ok=True);p.write_text(content)
            elif p.is_file():p.unlink()
            return 'restored base version' if exists else 'removed path absent from base'
        if name == 'delete_file':
            p=self.path(a['path'],write=True)
            if not p.is_file():raise ValueError('Expected source file')
            p.unlink();return 'deleted'
        if name == 'edit_file':
            p=self.path(a['path'],write=True);before=a['old'];after=a['new']
            if len(after)>100000:raise ValueError('Edit too large')
            text=p.read_text()
            if not before or text.count(before)!=1:raise ValueError('old must match exactly once')
            p.write_text(text.replace(before,after,1));return 'updated'
        if name == 'create_file':
            p=self.path(a['path'],write=True)
            if p.exists() or len(a['content'])>100000:raise ValueError('File exists or content too large')
            p.parent.mkdir(parents=True,exist_ok=True);p.write_text(a['content']);return 'created'
        raise ValueError('Unknown tool')

def tools(editable):
    specs=[('list_files','List source paths; optional contains filter',{'contains':{'type':'string'}},[]),
           ('read_file','Read numbered source lines',{'path':{'type':'string'},'start':{'type':'integer'},'count':{'type':'integer'}},['path']),
           ('search','Search literal text in source files',{'text':{'type':'string'},'path_contains':{'type':'string'}},['text']),
           ('diff','Read changes relative to the pinned review base',{'path':{'type':'string'}},[]),
           ('changes','List changed files and diff sizes',{},[]),
           ('read_revision','Read original PR or base source before conflict resolution',{'path':{'type':'string'},'revision':{'type':'string','enum':['base','pr']},'start':{'type':'integer'},'count':{'type':'integer'}},['path','revision'])]
    if editable:specs += [('edit_file','Replace one exact source fragment',{'path':{'type':'string'},'old':{'type':'string'},'new':{'type':'string'}},['path','old','new']),('create_file','Create a new source or regression test file',{'path':{'type':'string'},'content':{'type':'string'}},['path','content'])]
    if editable:specs += [('restore_base','Restore one path from the pinned base; removes the path if absent there. Use only after confirming that this preserves the contribution.',{'path':{'type':'string'}},['path']),('delete_file','Delete an obsolete source file',{'path':{'type':'string'}},['path'])]
    return [{'name':n,'description':d,'inputSchema':{'type':'object','properties':p,'required':r,'additionalProperties':False},'annotations':{'readOnlyHint':n not in ('edit_file','create_file','delete_file','restore_base'),'openWorldHint':False}} for n,d,p,r in specs]

def main():
    w=Workspace(sys.argv[1],len(sys.argv)>2 and sys.argv[2]=='edit')
    for line in sys.stdin:
        req={}
        try:
            req=json.loads(line)
            if 'id' not in req:continue
            m=req['method']
            if m=='initialize':result={'protocolVersion':req['params']['protocolVersion'],'capabilities':{'tools':{}},'serverInfo':{'name':'conest-source','version':'1.0'}}
            elif m=='tools/list':result={'tools':tools(w.editable)}
            elif m=='tools/call':
                try:
                    val=w.call(req['params']['name'],req['params'].get('arguments',{}))
                    result={'content':[{'type':'text','text':json.dumps(val,ensure_ascii=False)}]}
                except Exception as exc:result={'isError':True,'content':[{'type':'text','text':str(exc)}]}
            elif m=='ping':result={}
            else:raise ValueError('Unsupported method')
            print(json.dumps({'jsonrpc':'2.0','id':req['id'],'result':result}),flush=True)
        except Exception as exc:
            print(json.dumps({'jsonrpc':'2.0','id':req.get('id'),'error':{'code':-32603,'message':str(exc)}}),flush=True)

if __name__=='__main__':main()
