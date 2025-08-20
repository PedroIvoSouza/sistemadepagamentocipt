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
