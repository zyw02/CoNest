import assert from 'node:assert/strict';
import {lstat, mkdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);
export function assertRuntime(platform=process.platform,arch=process.arch,node=process.versions.node,glibc=process.report.getReport().header.glibcVersionRuntime){
 const [major,minor]=node.split('.').map(Number);
 assert(arch==='x64' && ['linux','win32'].includes(platform),'CoNest supports Linux x64 (glibc) and Windows x64');
 assert(major===24&&minor>=16,'CoNest requires Node >=24.16.0 <25');
 if(platform==='linux'){const [a,b]=(glibc??'0.0').split('.').map(Number);assert(a>2||a===2&&b>=28,'CoNest requires glibc >=2.28 (RHEL 8 or newer)');}
}
async function acl(file, protect) {
  const common = `
    $ErrorActionPreference = 'Stop'
    $p = $env:CONEST_ACL_PATH
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $allowed = @($sid, 'S-1-5-18', 'S-1-5-32-544')
    $a = if ([System.IO.Directory]::Exists($p)) {
      [System.IO.Directory]::GetAccessControl($p)
    } else {
      [System.IO.File]::GetAccessControl($p)
    }
  `;
  const update = `
    $a.SetAccessRuleProtection($true, $false)
    foreach ($r in @($a.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))) {
      $a.RemoveAccessRuleSpecific($r)
    }
    foreach ($id in $allowed) {
      $who = [System.Security.Principal.SecurityIdentifier]::new($id)
      $r = [System.Security.AccessControl.FileSystemAccessRule]::new($who, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
      $a.AddAccessRule($r)
    }
    [System.IO.Directory]::SetAccessControl($p, $a)
  `;
  const verify = `
    foreach ($r in $a.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
      if ($r.AccessControlType -eq 'Allow' -and $allowed -notcontains $r.IdentityReference.Value) {
        throw 'Private state ACL permits another identity'
      }
    }
  `;
  const script = common + (protect ? update : verify);
  const command = execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], {
    env: { ...process.env, CONEST_ACL_PATH: file }, windowsHide: true, timeout: 20000,
  });
  // Close unused stdin so Windows PowerShell cannot wait for interactive input.
  command.child.stdin?.end();
  await command;
}
export async function protectDirectory(directory){
 await mkdir(directory,{recursive:true,mode:0o700});
 const s=await lstat(directory);assert(s.isDirectory()&&!s.isSymbolicLink(),'CoNest state must be a regular directory');
 if(process.platform==='win32')await acl(directory,true);
}
export async function assertPrivateFile(file){
 const s=await lstat(file);assert(s.isFile()&&!s.isSymbolicLink(),'Credentials must be a regular file');
 if(process.platform==='win32'){
  try{await acl(file,false);}catch(cause){throw new Error('Credentials must be owner-only; the Windows ACL permits another identity or cannot be verified',{cause});}
 }
 else assert((s.mode&0o077)===0&&s.uid===process.getuid?.(),'Credentials must be current-user-owned and owner-only (mode 600 or 400)');
}
export async function assertPrivateDirectory(directory){
 const s=await lstat(directory);assert(s.isDirectory()&&!s.isSymbolicLink(),'State must be a regular directory');
 if(process.platform==='win32')await acl(directory,false);
 else assert((s.mode&0o077)===0&&s.uid===process.getuid?.(),'State must be current-user-owned and owner-only (mode 700)');
}
export async function stopProcessTree(child){
 if(child.exitCode!==null||child.signalCode!==null)return;
 if(process.platform==='win32'){
  try{await execute('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:15000});}catch(error){if(child.exitCode===null&&child.signalCode===null)throw error;}
 }else{
  child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,5000))]);
  if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
 }
}
