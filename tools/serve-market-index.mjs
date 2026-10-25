// 本地静态索引服务:给 Harness 的 pluginMarket 提供一个可达的 index URL
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';

const ROOT = 'C:/Agent/https-www-npmjs-com-package-deep/work/dsh-project/dsh-billing-compass/market';
const PORT = 8799;
const HOST = '127.0.0.1';
const TYPES = {
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
};

createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  const file = join(ROOT, rel || 'index.json');
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(body);
    console.log(`[${new Date().toISOString()}] 200 ${url.pathname} (${body.length}B)`);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
    console.log(`[${new Date().toISOString()}] 404 ${url.pathname}`);
  }
}).listen(PORT, HOST, () => {
  console.log(`market index server: http://${HOST}:${PORT}/index.json`);
  console.log(`root: ${ROOT}`);
});
