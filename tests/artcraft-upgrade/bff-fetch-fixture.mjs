// Injected only by the local probe tests. Every fetch is synthetic and network-free.
const scenario = process.env.ARTCRAFT_TEST_SCENARIO;
const owner = '11111111-1111-4111-8111-111111111111';
const doc = { id: 'doc', assetIds: ['empty-list','off-canvas','missing','pin-corrupt'].includes(scenario) ? [] : ['ordinary'] };
globalThis.fetch = async (url, options = {}) => {
  const { pathname, hostname } = new URL(url), direct = hostname === 'image2';
  if (pathname === '/') return new Response('<script src="/_next/static/fixture.js"></script>');
  if (pathname === '/api/v1/health') return Response.json({ status: 'ok' });
  if (pathname.endsWith('/craft/capabilities')) return Response.json({ data: { engines: Array.from({ length: 13 }, (_, id) => ({ id, available: true })) } });
  if (pathname.endsWith('/craft/projects')) return Response.json({ data: [{ nativeAssetId: 'checkpoint', latestOutput: { accepted: true, assets: [{ id: 'preview' }] } }] });
  if (pathname.endsWith('/capabilities')) return Response.json({ data: { operations: [] } });
  if (pathname.endsWith('/documents/doc')) {
    if (!direct && !options.headers.cookie?.includes(owner)) return new Response('', { status: 404 });
    return Response.json({ data: doc });
  }
  if (pathname.endsWith('/content') && scenario === 'missing') return new Response('', { status: 404 });
  if (pathname.endsWith('/content')) return new Response(!direct && scenario === 'empty' ? '' : !direct && scenario === 'corrupt' ? 'wrong' : 'verified native bytes', { headers: { 'content-type': 'application/octet-stream' } });
  throw Error('unexpected fixture request');
};
