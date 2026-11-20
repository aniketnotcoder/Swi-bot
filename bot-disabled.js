import http from 'node:http';

// Deliberately does not import or launch the Telegram bot or Storelex service.
// Keep Render's web process healthy while making every application route unavailable.
const port = Number(process.env.PORT || 10000);
const server = http.createServer((_req, res) => {
  res.writeHead(503, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Retry-After': '3600',
  });
  res.end(JSON.stringify({ status: 'disabled', ordersEnabled: false }));
});
server.listen(port, '0.0.0.0', () => console.log('Telegram bot and Storelex web access disabled.'));
