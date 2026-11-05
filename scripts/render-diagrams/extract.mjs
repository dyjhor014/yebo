import fs from 'node:fs';
const [,, dom, outDir] = process.argv;
const html = fs.readFileSync(dom, 'utf8');
const dec = s => s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ').replace(/&amp;/g,'&');
const re = /<textarea class="x" data-id="([^"]+)">([\s\S]*?)<\/textarea>/g; let m, n=0;
fs.mkdirSync(outDir, { recursive: true });
const index = [];
while ((m = re.exec(html))) {
  const [file, num] = m[1].split('#');
  const name = file.replace(/^docs\//,'').replace(/\.md$/,'').replace(/\//g,'_') + '-' + String(num).padStart(2,'0') + '.svg';
  let svg = dec(m[2]);
  if (!svg.startsWith('<?xml')) svg = '<?xml version="1.0" encoding="UTF-8"?>\n' + svg;
  fs.writeFileSync(`${outDir}/${name}`, svg); index.push({ src: m[1], name }); n++;
}
fs.writeFileSync(`${outDir}/index.json`, JSON.stringify(index, null, 1));
console.log(n + ' svg exported');
