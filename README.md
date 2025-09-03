# Sistema de Pagamento CIPT

Este projeto integra o fluxo de assinaturas digitais utilizando o serviço **Assinafy**.

## Token da API do Assinafy
1. Crie uma conta no [painel do Assinafy](https://assinafy.com/).
2. Acesse a área de desenvolvedores e gere um **API Key**.
3. Copie o token e defina-o em sua configuração de ambiente.

## Variáveis de Ambiente
Adicione no arquivo `.env` ou nas variáveis do servidor:

- `SQLITE_STORAGE`: caminho do arquivo SQLite utilizado pela aplicação e pelos scripts de conciliação, por exemplo `./sistemacipt.db`.
- `ASSINAFY_API_KEY`: token de acesso gerado no painel.
- `ASSINAFY_API_URL` (opcional): URL base da API. Padrão `https://api.assinafy.com`.
- `ASSINAFY_CALLBACK_URL`: URL pública para o retorno após a assinatura, ex.: `https://seusistema/api/documentos/assinafy/callback`.

Certifique-se de reiniciar o servidor após alterar as variáveis.

## Status das DARs

As DARs utilizam os seguintes status padronizados:

- `Pendente` – guia gerada mas ainda não emitida.
- `Emitido` / `Reemitido` – guia emitida para pagamento.
- `Pago` – pagamento confirmado.
- `Vencido` – vencimento ultrapassado sem pagamento.

O valor legado `Vencida` foi unificado para `Vencido` e não deve mais ser utilizado.

## Migrações do Banco de Dados

Para configurar um novo ambiente, execute as migrações do Sequelize antes de iniciar o servidor:

```bash
npx sequelize-cli db:migrate
```

O projeto também tenta rodar esse comando automaticamente na inicialização, mas executar manualmente garante que o schema esteja atualizado.

Após atualizar o código para versões mais recentes, execute novamente as migrações para criar novas estruturas de banco de dados,
como a tabela de auditoria de reservas (`reservas_audit`).

## Salas de Reunião

Para habilitar o módulo de salas:

1. Execute as migrações do projeto:

   ```bash
   npm run migrate
   ```

   > Caso o script `migrate` não esteja configurado, utilize o comando equivalente:
   >
   > ```bash
   > npx sequelize-cli db:migrate
   > ```

2. Popule a tabela `salas_reuniao` com os registros iniciais:

   ```bash
   npx sequelize-cli db:seed --seed src/migrations/20250819150001-seed-salas.js
   ```

3. Acesso às interfaces:

   - **Portal do Permissionário** (`/salas.html`): requer autenticação de um permissionário. O token `authToken` é obtido via `/login.html`.
   - **Painel de Gestão** (`/admin/salas.html`): restrito a administradores. Utilize as credenciais criadas pelo script `criar_admin.js` (padrão `supcti@secti.al.gov.br` / `Supcti@2025#`).

## Relatório de DARs de Eventos

Endpoint disponível para administradores:

`GET /api/admin/relatorios/eventos-dars?dataInicio=YYYY-MM-DD&dataFim=YYYY-MM-DD`

Retorna um PDF com as DARs de eventos emitidas no intervalo informado. Quando não existem registros, a resposta é `204 No Content`.
