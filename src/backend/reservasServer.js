import http from 'http';
import url from 'url';

const reservasPorSala = {
  1: [
    { id: 1, start: '2024-10-02T10:00:00Z', end: '2024-10-02T11:00:00Z' },
    { id: 2, start: '2024-10-02T14:00:00Z', end: '2024-10-02T15:30:00Z' }
  ]
};

function calcularLivres(reservas) {
  const startDay = new Date('2024-10-02T08:00:00Z');
  const endDay = new Date('2024-10-02T18:00:00Z');
  const sorted = [...reservas].sort((a, b) => new Date(a.start) - new Date(b.start));
  const livres = [];
  let cursor = startDay;
  for (const r of sorted) {
    const inicio = new Date(r.start);
    if (cursor < inicio) {
      livres.push({ start: cursor.toISOString(), end: inicio.toISOString() });
    }
    const fim = new Date(r.end);
    if (fim > cursor) cursor = fim;
  }
  if (cursor < endDay) {
    livres.push({ start: cursor.toISOString(), end: endDay.toISOString() });
  }
  return livres;
}

const server = http.createServer((req, res) => {
  const { pathname } = url.parse(req.url, true);
  const match = pathname.match(/^\/salas\/(\d+)\/disponibilidade$/);
  if (req.method === 'GET' && match) {
    const salaId = match[1];
    const ocupados = reservasPorSala[salaId] || [];
    const livres = calcularLivres(ocupados);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ocupados, livres }));
    return;
  }
  res.statusCode = 404;
  res.end('Not Found');
});

export default server;

if (process.env.RUN_SERVER) {
  const PORT = process.env.PORT || 3001;
  server.listen(PORT, () => console.log(`Servidor de reservas rodando na porta ${PORT}`));
}
