import fs from 'node:fs';
import path from 'node:path';
const [, , root, out] = process.argv;
const files = process.argv.slice(4);
const diagrams = [];
for (const f of files) {
  const txt = fs.readFileSync(path.join(root, f), 'utf8');
  const re = /```mermaid\n([\s\S]*?)```/g;
  let m,
    i = 0;
  while ((m = re.exec(txt))) {
    i++;
    const line = txt.slice(0, m.index).split('\n').length;
    diagrams.push({ id: `${f}#${i}`, line, src: m[1] });
  }
}
const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:sans-serif;background:#fff;margin:16px;width:1400px}h3{font-size:14px;margin:24px 0 4px;color:#333}.err{color:#b00;white-space:pre-wrap}.d svg{max-width:1380px;height:auto}</style>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11.12.0/dist/mermaid.min.js"></script></head><body>
<pre id="status">RUNNING</pre><div id="out"></div>
<script>
const diagrams = ${JSON.stringify(diagrams)};
mermaid.initialize({ startOnLoad:false, theme:'default', securityLevel:'strict' });
(async () => {
  const res = [];
  for (let k=0;k<diagrams.length;k++) {
    const d = diagrams[k]; const h = document.createElement('h3'); h.textContent = d.id + ' (línea ' + d.line + ')'; out.appendChild(h);
    const box = document.createElement('div'); box.className='d'; out.appendChild(box);
    try { const { svg } = await mermaid.render('m'+k, d.src); box.innerHTML = svg; const ta=document.createElement('textarea'); ta.className='x'; ta.dataset.id=d.id; ta.textContent=new XMLSerializer().serializeToString(box.querySelector('svg')); out.appendChild(ta); res.push({id:d.id, ok:true, svgLen: svg.length}); }
    catch(e) { box.innerHTML = '<div class=err>'+String(e.message||e)+'</div>'; res.push({id:d.id, ok:false, err:String(e.message||e).slice(0,300)}); }
  }
  status.textContent = 'RESULT ' + JSON.stringify(res);
})();
</script></body></html>`;
fs.writeFileSync(out, html);
console.log(diagrams.length + ' diagrams');
