const { fallbackEmail } = require('./assistantConfig');

const sharedNotices = {
  suporteEmail: `Se algo sair do esperado, você pode mandar um e-mail para ${fallbackEmail} e a equipe responde em até 24h úteis.`,
};

module.exports = [
  {
    id: 'permissionario.dars.pendente',
    audiences: ['permissionario', 'public'],
    title: 'Baixar uma DAR pendente',
    summary: 'Orientação passo a passo para localizar e emitir uma DAR que ainda não venceu.',
    keywords: [
      ['dar', 'pendente'],
      ['baixar', 'dar'],
      ['emitir', 'dar'],
      ['segunda', 'via'],
    ],
    minScore: 2,
    steps: [
      {
        title: 'Abrir a área de DARs',
        detail:
          'Depois de entrar no portal, olhe a barra azul do lado esquerdo e clique na opção **“Meus DARs”**.',
      },
      {
        title: 'Filtrar a lista',
        detail:
          'Logo acima da tabela existe o filtro **“Filtrar por Status”**. Deixe em **Pendente** (ou em **Todos**) e, se quiser limitar o período, ajuste também o filtro de ano.',
      },
      {
        title: 'Localizar a guia',
        detail:
          'Na tabela, percorra as linhas até achar a competência desejada. Na última coluna há um botão **“Emitir”** quando a guia está liberada.',
      },
      {
        title: 'Emitir o PDF',
        detail:
          'Clique em **Emitir**. O sistema gera o PDF imediatamente; dependendo do navegador, ele abre em nova aba ou baixa direto para a pasta de downloads.',
      },
      {
        title: 'Conferir o arquivo',
        detail:
          'Verifique se o PDF mostra o código de barras e a data de vencimento correta. Caso prefira, repita o processo para baixar novamente.',
      },
    ],
    followUp:
      'Se o botão **Emitir** não aparecer, confira se a guia já foi paga ou se está vencida. DARs vencidas exibem um aviso pedindo reemissão com juros.',
  },
  {
    id: 'permissionario.dars.vencido',
    audiences: ['permissionario', 'public'],
    title: 'Reemitir uma DAR vencida com juros e multa',
    summary: 'Guia detalhado para atualizar uma DAR atrasada direto pelo portal do permissionário.',
    keywords: [
      ['dar', 'vencid'],
      ['dar', 'atras'],
      ['multa', 'dar'],
      ['juros', 'dar'],
    ],
    minScore: 2,
    steps: [
      {
        title: 'Entrar em “Meus DARs”',
        detail:
          'Após o login, utilize a barra lateral esquerda e selecione **“Meus DARs”**.',
      },
      {
        title: 'Filtrar por vencidas',
        detail:
          'No topo da página há o campo **“Filtrar por Status”**. Escolha **Vencido** ou deixe em **Todos** para listar todas as guias atrasadas.',
      },
      {
        title: 'Abrir a reemissão',
        detail:
          'Localize a linha desejada e clique no botão **“Emitir”** da última coluna. Quando a guia está vencida, o sistema abre o modal **“DAR Vencido – Cálculo de Encargos”**.',
      },
      {
        title: 'Conferir os encargos',
        detail:
          'O modal mostra os dias em atraso, multa de 2% e juros diários (SELIC). Confira o valor atualizado e a nova data de vencimento exibidos em destaque.',
      },
      {
        title: 'Gerar o PDF atualizado',
        detail:
          'Clique em **“Confirmar e Emitir DAR Atualizado”**. O portal envia o pedido à SEFAZ, atualiza a guia e baixa o PDF reajustado automaticamente.',
      },
      {
        title: 'Guardar o comprovante',
        detail:
          'Use o novo PDF para pagar a DAR. O histórico ficará marcado como **Reemitido** até o pagamento ser conciliado.',
      },
    ],
    followUp:
      'Se a janela de reemissão não aparecer ou houver mensagens de erro, verifique se a conexão com a SEFAZ está ativa ou contate o suporte informando o número da DAR.',
  },
  {
    id: 'permissionario.perfil.atualizar',
    audiences: ['permissionario', 'public'],
    title: 'Atualizar dados cadastrais e senha',
    summary: 'Mostra onde editar contatos, responsáveis e senha dentro do portal.',
    keywords: [
      ['atualizar', 'cadastro'],
      ['editar', 'perfil'],
      ['trocar', 'senha'],
      ['alterar', 'email'],
    ],
    minScore: 2,
    steps: [
      {
        title: 'Acessar “Meu Perfil”',
        detail:
          'Com o portal aberto, clique na aba **“Meu Perfil”** na barra lateral azul.',
      },
      {
        title: 'Liberar os campos de edição',
        detail:
          'No canto superior direito do cartão principal há o botão **“Editar Perfil”**. Clique nele para desbloquear os campos de telefone, e-mails e responsáveis.',
      },
      {
        title: 'Salvar as mudanças',
        detail:
          'Depois de preencher, utilize **“Salvar Alterações”** na base do cartão. Use **“Cancelar”** se quiser descartar as edições.',
      },
      {
        title: 'Trocar a senha',
        detail:
          'À direita existe o bloco **“Alterar Senha”**. Informe a senha atual, digite a nova senha duas vezes e confirme em **“Atualizar Senha”**.',
      },
      {
        title: 'Confirmar o resultado',
        detail:
          'O portal mostra um aviso verde quando os dados são salvos com sucesso. Se algum campo obrigatório ficar vazio, ele aparecerá destacado em vermelho.',
      },
    ],
  },
  {
    id: 'permissionario.salas.reservar',
    audiences: ['permissionario', 'public'],
    title: 'Reservar uma sala de reunião',
    summary: 'Fluxo para verificar disponibilidade e registrar uma nova reserva de sala.',
    keywords: [
      ['reservar', 'sala'],
      ['agendar', 'sala'],
      ['sala', 'reuniao'],
    ],
    minScore: 2,
    steps: [
      {
        title: 'Abrir a página de salas',
        detail:
          'Na barra lateral esquerda, clique em **“Salas de reunião”**.',
      },
      {
        title: 'Preencher o formulário “Reservar Sala”',
        detail:
          'Logo no topo há um cartão com os campos de sala, data, horário de início, horário de término e quantidade de pessoas. Escolha a sala desejada e preencha todos os horários.',
      },
      {
        title: 'Checar conflitos',
        detail:
          'O sistema impede reservas sobrepostas. Se existir choque, uma mensagem vermelha informa o horário já ocupado. Ajuste os horários até que a mensagem suma.',
      },
      {
        title: 'Confirmar a reserva',
        detail:
          'Clique em **“Reservar”**. A reserva validada aparece imediatamente na lista **“Minhas Reservas”** logo abaixo.',
      },
      {
        title: 'Cancelar ou editar',
        detail:
          'Em “Minhas Reservas”, use o botão **“Cancelar”** quando precisar liberar o horário. Alterações só são permitidas antes do início da reserva.',
      },
    ],
  },
  {
    id: 'permissionario.certidao',
    audiences: ['permissionario', 'public'],
    title: 'Gerar a certidão de quitação',
    summary: 'Mostra como emitir a certidão de regularidade quando não existem DARs vencidas.',
    keywords: [
      ['certidao'],
      ['regularidade'],
      ['quitacao'],
    ],
    minScore: 1,
    steps: [
      {
        title: 'Abrir o menu de certidão',
        detail:
          'No menu lateral clique em **“Certidão de Quitação”**. Também é possível chegar pelo atalho no topo da dashboard.',
      },
      {
        title: 'Gerar o documento',
        detail:
          'Pressione o botão **“Gerar Certidão (PDF)”**. O portal checa se há DARs vencidas. Estando tudo em dia, a certidão é emitida e baixada automaticamente.',
      },
      {
        title: 'Reabrir quando precisar',
        detail:
          'Depois da emissão o botão **“Abrir em nova aba”** fica ativo, permitindo baixar novamente o PDF gerado.',
      },
      {
        title: 'Caso haja pendências',
        detail:
          'Se existirem DARs vencidas, o portal mostra um alerta impedindo a emissão. Resolva as guias atrasadas e retorne para gerar a certidão.',
      },
    ],
  },
  {
    id: 'admin.dashboard.resumo',
    audiences: ['admin'],
    title: 'Acompanhar indicadores no painel administrativo',
    summary: 'Descreve os cards e o resumo mensal exibidos no dashboard do painel de gestão.',
    keywords: [
      ['dashboard', 'admin'],
      ['resumo', 'mensal'],
      ['indicadores'],
    ],
    minScore: 2,
    steps: [
      {
        title: 'Acessar o dashboard',
        detail:
          'Depois de logar no painel, o item **“Dashboard”** do menu lateral mostra os cards principais com Permissionários, DARs Pendentes, DARs Vencidos e Receita Pendente.',
      },
      {
        title: 'Usar o seletor “Resumo Mensal de DARs”',
        detail:
          'No topo da página existe um seletor que alterna entre visão geral, permissionários e eventos. Ao mudar a opção, tanto os cards quanto o gráfico são recarregados.',
      },
      {
        title: 'Interpretar o gráfico',
        detail:
          'O gráfico de barras exibe a evolução de DARs emitidas, reemitidas e pagas por mês. Passe o mouse em cada barra para ver os números detalhados.',
      },
      {
        title: 'Ver detalhes rápidos',
        detail:
          'Logo abaixo há uma lista com os permissionários que mais devem. Clique no nome para abrir o cadastro completo na tela de Permissionários.',
      },
    ],
  },
  {
    id: 'admin.dars.gerenciar',
    audiences: ['admin'],
    title: 'Filtrar e agir sobre DARs pelo painel',
    summary: 'Explica como localizar guias, enviar notificações e baixar comprovantes.',
    keywords: [
      ['admin', 'dar'],
      ['painel', 'dars'],
      ['notificar', 'dar'],
      ['comprovante', 'dar'],
    ],
    minScore: 2,
    steps: [
      {
        title: 'Abrir o módulo de DARs',
        detail:
          'No menu do painel clique em **“DARs”**. A tabela central é carregada com filtros no topo.',
      },
      {
        title: 'Aplicar filtros',
        detail:
          'Use os campos de busca (nome ou CNPJ), mês, ano e status. Finalize com o botão **“Filtrar”** para atualizar a lista.',
      },
      {
        title: 'Enviar notificação',
        detail:
          'Quando a guia estiver pendente ou vencida, utilize o botão **“Notificar”** na coluna Ações para disparar o e-mail automático ao permissionário.',
      },
      {
        title: 'Emitir ou reemitir',
        detail:
          'Os botões **“Emitir”** e **“Reemitir”** solicitam o PDF atualizado à SEFAZ. O status da linha muda para Emitido/Reemitido ao concluir.',
      },
      {
        title: 'Baixar comprovante',
        detail:
          'Para guias pagas, o botão **“Comprovante”** abre o PDF timbrado com token. Caso não esteja disponível, confira se a conciliação rodou naquele dia.',
      },
    ],
  },
  {
    id: 'admin.permissionarios.cadastro',
    audiences: ['admin'],
    title: 'Consultar e atualizar dados de permissionários',
    summary: 'Passo a passo para abrir o cadastro, editar informações e exportar relatórios.',
    keywords: [
      ['admin', 'permissionario'],
      ['editar', 'permissionario'],
      ['exportar', 'permissionario'],
    ],
    minScore: 2,
    steps: [
      {
        title: 'Listar permissionários',
        detail:
          'No painel, clique em **“Permissionários”**. A página mostra a tabela com campo de busca por nome, CNPJ ou e-mail.',
      },
      {
        title: 'Abrir o cadastro',
        detail:
          'Use o botão **“Ver detalhes”** na linha desejada para abrir o formulário completo. É possível alterar contatos, salas e valores de aluguel.',
      },
      {
        title: 'Salvar alterações',
        detail:
          'Depois de editar, clique em **“Salvar”** para gravar as mudanças. O sistema registra auditoria com o administrador responsável.',
      },
      {
        title: 'Exportar relatórios',
        detail:
          'Na parte superior há botões para exportar CSV, XLSX ou PDF timbrado com QR Code, úteis para compartilhar a lista de permissionários.',
      },
    ],
  },
  {
    id: 'admin.eventos.termo',
    audiences: ['admin'],
    title: 'Gerar e enviar o termo de evento para assinatura',
    summary: 'Mostra o fluxo completo para emitir o termo, enviar à Assinafy e acompanhar o status.',
    keywords: [
      ['termo', 'evento'],
      ['assinar', 'termo'],
      ['assinafy'],
    ],
    minScore: 2,
    steps: [
      {
        title: 'Abrir o evento',
        detail:
          'Dentro do painel, vá em **“Eventos”**, filtre ou pesquise e clique sobre o evento desejado.',
      },
      {
        title: 'Gerar o PDF timbrado',
        detail:
          'Use o botão **“Gerar termo”**. O sistema monta o PDF com token de verificação e salva o arquivo na base.',
      },
      {
        title: 'Enviar para assinatura',
        detail:
          'Em seguida clique em **“Enviar para assinatura”**. A plataforma sobe o PDF para a Assinafy, cria a tarefa de assinatura e envia o e-mail automaticamente.',
      },
      {
        title: 'Acompanhar status',
        detail:
          'O painel exibe a situação da assinatura (pendente, enviado, concluído). Use o botão **“Reenviar link”** caso o cliente reporte que não recebeu.',
      },
      {
        title: 'Baixar o termo assinado',
        detail:
          'Assim que a Assinafy confirmar a assinatura, o botão **“Termo assinado”** fica disponível para download direto no painel.',
      },
    ],
    followUp:
      'Se o envio falhar, verifique as credenciais da Assinafy e o número de telefone para envio opcional via WhatsApp.',
  },
  {
    id: 'cliente_evento.termo.assinar',
    audiences: ['cliente_evento', 'public'],
    title: 'Assinar o termo do evento no portal do cliente',
    summary: 'Instrui clientes de evento a localizar o termo, pedir o link de assinatura e acompanhar o status.',
    keywords: [
      ['termo', 'evento'],
      ['assinar', 'termo'],
      ['link', 'assinatura'],
    ],
    minScore: 2,
    steps: [
      {
        title: 'Acessar o painel de eventos',
        detail:
          'Depois de logar em `/eventos/login-eventos.html`, clique em **“Meus Eventos”** ou abra o evento diretamente pela dashboard.',
      },
      {
        title: 'Visualizar o termo',
        detail:
          'No bloco do evento há o botão **“Ver termo”**. Ele gera o PDF timbrado e mostra o status atual da assinatura.',
      },
      {
        title: 'Gerar ou reenviar o link da Assinafy',
        detail:
          'Caso o link tenha expirado, use **“Gerar novo link de assinatura”**. O sistema reconecta com a Assinafy e envia novamente para o e-mail cadastrado.',
      },
      {
        title: 'Assinar o documento',
        detail:
          'Clique no link recebido. A Assinafy abre a tela com o termo; basta revisar e assinar eletronicamente seguindo o passo a passo do provedor.',
      },
      {
        title: 'Confirmar o status',
        detail:
          'Volte ao portal e atualize a página. O status muda para **Assinado** assim que o arquivo chega devidamente certificado.',
      },
    ],
  },
  {
    id: 'cliente_evento.dar.reemitir',
    audiences: ['cliente_evento', 'public'],
    title: 'Reemitir DAR de evento vencida',
    summary: 'Explica como atualizar guias vinculadas a eventos com juros automáticos.',
    keywords: [
      ['dar', 'evento'],
      ['dar', 'vencid'],
      ['parcela', 'evento'],
    ],
    minScore: 2,
    steps: [
      {
        title: 'Abrir “Minhas DARs”',
        detail:
          'No portal de eventos, use o menu superior e clique em **“Minhas DARs”**.',
      },
      {
        title: 'Localizar a parcela',
        detail:
          'A tabela lista cada parcela com status. Filtre por **Vencido** se necessário e encontre a linha correta.',
      },
      {
        title: 'Solicitar a reemissão',
        detail:
          'Clique em **“Reemitir”**. Um modal aparece com os valores de multa e juros calculados automaticamente.',
      },
      {
        title: 'Confirmar a atualização',
        detail:
          'Use **“Confirmar e gerar DAR atualizada”** para baixar o PDF reajustado. O histórico da parcela fica marcado como **Reemitido**.',
      },
      {
        title: 'Guardar o novo boleto',
        detail:
          'Faça o pagamento usando o arquivo mais recente. Assim que a conciliação rodar, a linha ficará com status **Pago**.',
      },
    ],
  },
  {
    id: 'cliente_evento.remarcar',
    audiences: ['cliente_evento', 'public'],
    title: 'Solicitar remarcação de evento',
    summary: 'Mostra como preencher o pedido de remarcação e acompanhar a resposta da administração.',
    keywords: [
      ['remarcar', 'evento'],
      ['remarcacao'],
      ['adiar', 'evento'],
    ],
    minScore: 2,
    steps: [
      {
        title: 'Abrir o evento',
        detail:
          'No portal do cliente, entre em **“Meus Eventos”** e clique no evento que deseja remarcar.',
      },
      {
        title: 'Preencher o pedido',
        detail:
          'No cartão de remarcação clique em **“Solicitar remarcação”**. Informe a nova data desejada e descreva o motivo no campo de observações.',
      },
      {
        title: 'Enviar para análise',
        detail:
          'Confirme em **“Enviar solicitação”**. O pedido é registrado e fica aguardando aprovação da administração.',
      },
      {
        title: 'Acompanhar o status',
        detail:
          'O histórico do evento mostra o andamento da remarcação (enviado, aprovado ou recusado). A decisão também é enviada por e-mail.',
      },
    ],
    followUp:
      'Enquanto a remarcação estiver em análise, as DARs do evento continuam com as datas originais. Aguarde a resposta antes de cancelar pagamentos.',
  },
  {
    id: 'suporte.contato',
    audiences: ['permissionario', 'admin', 'cliente_evento', 'public'],
    title: 'Contato com o suporte',
    summary: 'Mensagem padrão para quando o assistente não consegue concluir a ação.',
    keywords: [
      ['suporte'],
      ['contato'],
      ['ajuda', 'humana'],
    ],
    minScore: 1,
    steps: [
      {
        title: 'Acionando a equipe do CIPT',
        detail: sharedNotices.suporteEmail,
      },
    ],
  },
];
