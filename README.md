# Sistema de Pagamento CIPT

Este projeto integra o fluxo de assinaturas digitais utilizando o serviço **Assinafy**.

## Token da API do Assinafy
1. Crie uma conta no [painel do Assinafy](https://assinafy.com/).
2. Acesse a área de desenvolvedores e gere um **API Key**.
3. Copie o token e defina-o em sua configuração de ambiente.

## Variáveis de Ambiente
Adicione no arquivo `.env` ou nas variáveis do servidor:

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
