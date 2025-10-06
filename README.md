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
- `VPN_HEALTHCHECK_TLS_INSECURE` (opcional): defina como `true` para permitir certificados TLS autoassinados no health-check HTTP da VPN/infovia. Mantenha ausente ou `false` para validar os certificados normalmente.
- `SEFAZ_MIN_CONSULTA_INTERVAL_MS` (opcional): intervalo mínimo entre consultas à SEFAZ em milissegundos. O padrão é `300000` (5 minutos), conforme orientação do órgão. Valores menores são aceitos apenas para ambientes de teste.

Certifique-se de reiniciar o servidor após alterar as variáveis.

## Status das DARs

As DARs utilizam os seguintes status padronizados:

- `Pendente` – guia gerada mas ainda não emitida.
- `Emitido` / `Reemitido` – guia emitida para pagamento.
- `Pago` – pagamento confirmado.
- `Vencido` – vencimento ultrapassado sem pagamento.

O valor legado `Vencida` foi unificado para `Vencido` e não deve mais ser utilizado.

- `POST /api/admin/dars/conciliar` — dispara manualmente a conciliação das DARs. Informe `{ "data": "YYYY-MM-DD" }` no corpo para selecionar o dia; caso omita, utiliza o padrão configurado (ontem). O endpoint respeita o intervalo mínimo entre consultas imposto pela SEFAZ.

### Como configurar e executar a conciliação manual das DARs

1. **Variáveis de ambiente**
   - Garanta que `SQLITE_STORAGE` aponte para o arquivo `sistemacipt.db` utilizado em produção ou no ambiente de homologação (ex.: `SQLITE_STORAGE=/var/cipt/sistemacipt.db`).
   - Ajuste `CONCILIAR_BASE_DIA` para `ontem` (padrão) ou `hoje` quando precisar conciliar o mesmo dia da consulta.
   - Mantenha `SEFAZ_MIN_CONSULTA_INTERVAL_MS` com pelo menos 300000 (5 minutos), conforme orientação da SEFAZ, para evitar bloqueios durante as chamadas de consulta.

2. **Instalar dependências e preparar o banco**
   ```bash
   npm install
   npx sequelize-cli db:migrate
   ```
   As migrações garantem que a tabela `dars` contenha as colunas utilizadas pelo conciliador.

3. **Executar a conciliação via CLI**
   - Para rodar apenas um dia (ex.: 2025-09-18):
     ```bash
     node cron/conciliarPagamentosmes.js --date=2025-09-18
     ```
   - Para um intervalo contínuo de dias: `node cron/conciliarPagamentosmes.js --range=2025-09-01:2025-09-18`
   - Sem parâmetros, o script usa `CONCILIAR_BASE_DIA` para definir o dia padrão (ontem por padrão). Em todos os casos o arquivo de lock `/tmp/cipt-concilia.lock` evita execuções concorrentes.

4. **Executar pelo painel administrativo**
   - Autentique-se como `SUPER_ADMIN` ou `FINANCE_ADMIN`.
   - Chame `POST /api/admin/dars/conciliar` com corpo opcional `{ "data": "YYYY-MM-DD" }`. Quando omitido, o endpoint usa o mesmo padrão do script (ontem). O retorno informa quantos pagamentos foram importados e quantas DARs emitidas pelo sistema foram atualizadas para `Pago` (o conciliador ignora registros já pagos ou ainda não emitidos).

5. **Escopo: apenas DARs emitidas pelo sistema**
   O conciliador cruza os pagamentos da SEFAZ com as DARs cujo status ainda não é `Pago`, filtrando por permissionário, eventos vinculados e número da guia antes de aplicar tolerâncias de valor. Assim, somente as guias geradas pelo sistema são atualizadas; pagamentos sem correspondência permanecem em análise manual.

## Dashboard Administrativo

Na página `/admin/dashboard.html` há um seletor ao lado do título **Resumo Mensal de DARs** que permite filtrar os dados por:

- Todas as DARs
- Permissionários
- Eventos

Ao alterar o filtro, os indicadores, tabela e gráfico são recarregados com as informações correspondentes.

## Migrações do Banco de Dados

Para configurar um novo ambiente, execute as migrações do Sequelize antes de iniciar o servidor:

```bash
npx sequelize-cli db:migrate
```

O projeto também tenta rodar esse comando automaticamente na inicialização, mas executar manualmente garante que o schema esteja atualizado.

Após atualizar o código para versões mais recentes, execute novamente as migrações para criar novas estruturas de banco de dados,
como a tabela de auditoria de reservas (`reservas_audit`).

Arquivos de banco de dados criados antes da inclusão da coluna `valor_aluguel` em `permissionarios` precisam ser migrados ou
recriados para que essa coluna seja adicionada corretamente.

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

## Assistente virtual (chat com IA)

O portal agora exibe um botão de ajuda no canto inferior direito. Ao clicar, abre-se o assistente virtual com roteiros
pré-configurados e capacidade de consultar o código do repositório quando a dúvida não estiver na base.

### Como preparar o ambiente

1. Defina as variáveis de ambiente:
   - `OPENAI_API_KEY`: chave da API do modelo GPT.
   - (Opcional) `OPENAI_MODEL` e `OPENAI_EMBEDDING_MODEL` para personalizar os modelos.
   - (Opcional) `ASSISTANT_VECTOR_STORE` para salvar o índice vetorial em outro caminho.
2. Gere o índice do repositório para o assistente:

   ```bash
   npm run assistant:index
   ```

   > Utilize `npm run assistant:index:dry-run` para testar o processo sem gravar arquivos.

3. Reinicie o servidor para habilitar os endpoints do chat.

### Endpoints

- `GET /api/assistant/portal/bootstrap` e `POST /api/assistant/portal/message` — portal do permissionário.
- `GET /api/assistant/admin/bootstrap` e `POST /api/assistant/admin/message` — painel administrativo.
- `GET /api/assistant/eventos/bootstrap` e `POST /api/assistant/eventos/message` — portal do cliente de evento.
- `GET /api/assistant/public/bootstrap` e `POST /api/assistant/public/message` — consultas sem autenticação.

Quando a pergunta precisa acessar o código, o assistente avisa o usuário (“estou consultando o código da plataforma”) e busca a
resposta com o índice vetorial. Se mesmo assim não for possível resolver, o chat exibe automaticamente o e-mail `supcti@secti.al.gov.br`
para escalonamento.

## Relatório de DARs de Eventos

Endpoint disponível para administradores:

`GET /api/admin/relatorios/eventos-dars?dataInicio=YYYY-MM-DD&dataFim=YYYY-MM-DD`

Retorna um PDF com as DARs de eventos emitidas no intervalo informado. Quando não existem registros, a resposta é `204 No Content`.

## Advertências

Para registrar uma advertência:

1. No painel de gestão, acesse **Eventos → Advertências**.
2. Preencha o formulário com:
   - **DOS FATOS**: relato detalhado do ocorrido.
   - Marque as cláusulas infringidas.
   - Informe o **valor da multa**.
   - Defina a **data de inaptidão**.
   - Indique o número de **dias para recurso**.

Após o envio, as sanções previstas para as cláusulas selecionadas serão aplicadas, incluindo a cobrança da multa e a inaptidão a partir da data informada.

## Termo do Evento

O termo de permissão de uso é obtido pela rota oficial:

`GET /api/admin/eventos/:id/termo`

Este endpoint gera ou retorna o PDF do termo utilizando o serviço atualizado com token e bloco de assinatura eletrônica.
A rota legada `/api/admin/eventos/:id/termo-pdf` foi descontinuada e redireciona para o caminho acima.

## Backfill de endereços de clientes

Preenche automaticamente os campos de endereço nas tabelas `Clientes_Eventos` e `Clientes` a partir do CEP.

```bash
# execução direta
node scripts/backfillClienteEnderecos.js

# via npm
npm run backfill-clientes-enderecos
```

O script consulta a API de CEP e atualiza apenas registros sem logradouro preenchido. Ele pode ser reexecutado com segurança e, se desejado, agendado periodicamente via `cron` ou ferramenta similar.
