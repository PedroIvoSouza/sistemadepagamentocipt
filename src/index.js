// Importa o "bloco" do Express
const express = require('express');

// Cria a nossa aplicação
const app = express();

// Define a porta em que o servidor vai rodar
const PORT = 3000;

// Cria uma rota de teste
app.get('/', (req, res) => {
  res.send('API do Sistema de Pagamento CIPT no ar!');
});

// Manda o servidor "escutar" por requisições na porta definida
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}.`);
});