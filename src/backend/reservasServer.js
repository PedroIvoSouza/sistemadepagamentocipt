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

function findReserva(id) {
  for (const salaId of Object.keys(reservasPorSala)) {
    const lista = reservasPorSala[salaId];
    const idx = lista.findIndex(r => r.id === id);
    if (idx !== -1) {
      return { salaId, idx, reserva: lista[idx] };
    }
  }
  return null;
}

const server = http.createServer((req, res) => {
  const { pathname } = url.parse(req.url, true);

  const disponibilidadeMatch = pathname.match(/^\/salas\/(\d+)\/disponibilidade$/);
  if (req.method === 'GET' && disponibilidadeMatch) {
    const salaId = disponibilidadeMatch[1];
    const ocupados = reservasPorSala[salaId] || [];
    const livres = calcularLivres(ocupados);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ocupados, livres }));
    return;
  }

  const reservaMatch = pathname.match(/^\/reservas\/(\d+)$/);
  if (reservaMatch) {
    const id = parseInt(reservaMatch[1], 10);
    if (req.method === 'PUT') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const dados = JSON.parse(body || '{}');
          const found = findReserva(id);
          if (!found) {
            res.statusCode = 404;
            res.end('Reserva não encontrada');
            return;
          }
          if (dados.start) found.reserva.start = dados.start;
          if (dados.end) found.reserva.end = dados.end;
          res.statusCode = 204;
          res.end();
        } catch (e) {
          res.statusCode = 400;
          res.end('JSON inválido');
        }
      });
      return;
    }
    if (req.method === 'DELETE') {
      const found = findReserva(id);
      if (!found) {
        res.statusCode = 404;
        res.end('Reserva não encontrada');
        return;
      }
      reservasPorSala[found.salaId].splice(found.idx, 1);
      res.statusCode = 204;
      res.end();
      return;
    }
  }

  res.statusCode = 404;
  res.end('Not Found');
});

export default server;

if (process.env.RUN_SERVER) {
  const PORT = process.env.PORT || 3001;
  server.listen(PORT, () => console.log(`Servidor de reservas rodando na porta ${PORT}`));
}
