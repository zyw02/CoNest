window.__ModuleLoader__.load({ id: "@local/conest-dsh-ui", factory(require) {
const React = require('react');
const inject = ['slots'];
function CoNestPanel() {
  const [url, setUrl] = React.useState(() => localStorage.getItem('conest-studio-url') || 'http://127.0.0.1:18791/plugins/conest-studio');
  const [draft, setDraft] = React.useState(url);
  const [view,setView]=React.useState('catalog');
  const container=React.useRef(null);
  const displayUrl=new URL(url);displayUrl.searchParams.set('view',view);
  return React.createElement('section', { ref:container, style: { width: '100%', height: '80vh', background:'#fff',padding:8, display: 'flex', flexDirection: 'column', gap: 12 } },
    React.createElement('form', { onSubmit(event) { event.preventDefault(); const parsed = new URL(draft); if (!['http:', 'https:'].includes(parsed.protocol)) return; localStorage.setItem('conest-studio-url', parsed.href); setUrl(parsed.href); }, style: { display: 'flex', gap: 8 } },
      React.createElement('input', { value: draft, onChange: e => setDraft(e.target.value), 'aria-label': 'CoNest Studio address', style: { flex: 1, padding: 8 } }),
      React.createElement('button', { type: 'submit' }, '连接 CoNest')),
    React.createElement('div',{style:{display:'flex',gap:12}},...Object.entries({catalog:'统一清单',overview:'任务工作台',memory:'共享记忆'}).map(([id,label])=>React.createElement('button',{key:id,onClick:()=>setView(id),style:{padding:'6px 12px',borderRadius:6,border:'1px solid #ddd',background:view===id?'#c8f882':'#fff'}},label)),React.createElement('button',{onClick:()=>{if(document.fullscreenElement)document.exitFullscreen();else container.current.requestFullscreen();},style:{marginLeft:'auto'}},'⛶ 全屏演示')),
    React.createElement('iframe', { src: displayUrl.href, title: 'CoNest Studio · 统一生态清单', style: { flex: 1, width: '100%', border: 0, borderRadius: 12 } }));
}
function apply(ctx) {
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({ name: 'settings.plugins.tab', id: 'conest-studio', order: 5, label: 'CoNest 统一生态' }, CoNestPanel));
}

return {inject,apply};
}});
