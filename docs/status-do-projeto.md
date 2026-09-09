# Agente Autônomo de Atendimento — Status do Projeto

**Data:** 31 de agosto de 2026 · **atualizado em 8 de setembro de 2026** (bloco "Atualização de 08/09" logo abaixo; o plano vive no [`roadmap.md`](roadmap.md))
**Para:** grupo de sócios da SETA
**Preparado por:** Renato Martins

> Este documento é uma fotografia do momento. Ele descreve o que já foi construído,
> o que estamos aprendendo com os primeiros testes reais, e o caminho até atender
> clientes de verdade. Não usa linguagem técnica; há um glossário no final.

---

## Atualização de 08/09/2026

Desde a fotografia de 31/08:

- **Tudo o que estava pronto entrou no histórico principal do código** em 08/09, com
  esteira verde e **373 testes automáticos**. O erro de ordem na integração, encontrado
  na revisão de 06/09, foi corrigido e o histórico voltou a ser confiável.
- **As quatro melhorias do teste real estão prontas.** O agente não fica mais mudo antes
  de o atendente assumir; mensagens que chegam durante a resposta são fundidas em uma
  só; o painel virou uma tela de atendimento no estilo WhatsApp Web; e a **cobrança pelo
  WhatsApp** (boleto, PIX ou link de cartão) funciona de ponta a ponta, por enquanto com o
  fornecedor de pagamentos em modo de teste.
- **Mensagens proativas existem.** Campanhas com modelo aprovado pela Meta para a
  carteira, com funil de entrega e leitura; quem responde cai no atendimento normal.
- **Agente de vendas.** Quem escreve sem cadastro é qualificado, recebe oferta dentro da
  alçada de 3% e é encaminhado ao comercial. O núcleo está pronto; a aprovação das
  exceções pelo painel é o próximo passo.
- **Proteção de dados foi além.** Nome e CPF nunca saíam do banco; agora nomes,
  telefones, e-mails e documentos **digitados nas conversas** também viram códigos antes
  de qualquer coisa ir ao fornecedor de IA.
- **Painel redesenhado** conforme o design aprovado, em sete áreas: Atendimento,
  Campanhas, Cobranças, Leads, Aprendizado, Métricas e Configurações. Métricas ganhou um
  **relatório de campanhas** que cruza o resultado (respostas, cobranças, pagamentos)
  com a meta de conversão, com filtros por período e exportação.
- **Blindagem para exposição.** O sistema recusa subir em produção com chaves de
  desenvolvimento, as senhas saíram do arquivo de instalação e a imagem só é publicada
  com a esteira verde.

**O que continua igual:** o servidor de demonstração ainda roda a versão de agosto.
Publicar é o próximo passo (marco M0 do roadmap), junto com a transferência do
repositório para a organização. As decisões que só os sócios podem tomar estão no
roadmap (D1 a D9): a mais urgente é quem constrói (D9, 13/09) e a que mais move o
calendário é a saída de dados para o fornecedor de IA (D6, 27/09).

---

## Em uma página

Construímos um **atendente digital completo** e já o colocamos para conversar por
WhatsApp de verdade. Ele responde perguntas com dados reais do sistema de gestão,
reconhece seus próprios limites, passa a conversa para um atendente humano quando
precisa, e aprende com esse atendimento — sempre com aprovação de uma pessoa antes
de mudar de comportamento.

Os 11 módulos planejados foram construídos, testados e integrados. **O protótipo já
está em teste, conversando por WhatsApp real** — e o ciclo completo já se fechou em
condições reais: o agente respondeu, reconheceu um limite, transferiu para um
atendente humano, aprendeu com a correção e teve a melhoria aprovada. Ainda roda na
máquina do desenvolvedor, não no servidor — publicá-lo é o próximo passo imediato.

Aconteceram duas coisas importantes nos últimos dias:

1. **Mudamos o cenário do produto para o negócio real.** O protótipo foi construído
   com um cenário genérico de distribuidora. Agora temos acesso a uma cópia do banco
   de dados de um cliente real do setor de **multipropriedade** — resorts vendidos em
   cotas. O produto está sendo ajustado para esse negócio, que é o mercado de fato
   do TS Explorer.

2. **O teste real já gerou aprendizado.** Conversar com o agente pelo WhatsApp
   revelou quatro melhorias concretas, todas já mapeadas e detalhadas. Uma delas
   abre uma frente nova de produto: **enviar cobrança com link de pagamento**.

**O que já temos:** a prova de que a arquitetura funciona, validada em conversa real,
e o acesso ao dado do negócio verdadeiro.

**O que vem a seguir:** ajustar o produto ao domínio de multipropriedade, aplicar as
melhorias que o teste real apontou, e preparar a operação para receber clientes.

---

## O que estamos construindo

Um **atendente digital** para empresas que usam o ERP TS Explorer — o mercado real
desse sistema é o de **multipropriedade**: resorts vendidos em cotas, em que o cliente
compra uma fração de uso de uma unidade e paga em parcelas por vários anos.

O agente atende o cotista pelo WhatsApp e:

- **Responde com dado real.** "Quanto ainda devo?", "Qual o vencimento da próxima
  parcela?", "Qual é a minha unidade?", "Como está meu pedido de cancelamento?" — as
  respostas vêm do sistema de gestão, não de um texto genérico.
- **Admite quando não sabe.** Se não existe caminho para a informação, ele diz que
  não sabe e oferece um atendente humano. Ele não inventa resposta. Essa é a regra
  mais importante do sistema, verificada automaticamente a cada resposta.
- **Não negocia valor.** Se o cliente pede desconto ou abatimento, o agente não fecha
  nada: transfere para uma pessoa. Qualquer valor em dinheiro que ele mencione
  precisa ter origem comprovada numa consulta ao sistema — se não tiver, a resposta é
  bloqueada antes de sair.
- **Aprende com o atendimento.** Quando um atendente humano corrige ou complementa o
  agente, isso vira matéria-prima. O sistema analisa esses casos e **propõe**
  melhorias de comportamento. Um responsável aprova ou rejeita cada proposta, com
  histórico de versões e botão de desfazer.
- **Registra tudo.** Cada resposta pode ser reconstituída passo a passo: o que o
  agente consultou, quais travas foram acionadas, o que respondeu, quanto custou e
  quanto demorou.

**Três públicos usam o sistema:**

| Quem | Onde | Faz o quê |
|---|---|---|
| Cotista | WhatsApp | Pergunta sobre parcelas, saldo devedor, sua cota, distrato, chamados |
| Atendente | Painel de controle | Assume conversas escaladas, responde, devolve ao agente |
| Curador | Painel de controle | Aprova ou rejeita as melhorias que o agente propõe |

---

## Onde estamos

O caminho até o produto tem três estágios. O primeiro está concluído e em teste.

| Estágio | O que é | Status |
|---|---|---|
| **1. Protótipo demonstrável** | Sistema completo, conversando por WhatsApp real | ✅ **Concluído** (08/09: integrado; publicação no servidor pendente) |
| **2. Piloto com um cliente real** | Ligado ao sistema de gestão de um resort, atendendo os cotistas dele | 🔄 **Em preparação** — depende das decisões D1–D9 do roadmap |
| **3. Produto para vários clientes** | Uma base de código, **uma instalação por cliente** (redefinido em 02/09: parte dos clientes não permite dado saindo da rede deles) | ⬜ A iniciar |

### O que o estágio 1 entregou, em números

| Indicador | Resultado |
|---|---|
| Módulos planejados × construídos | **11 de 11** em 31/08; **18 especificações entregues** em 08/09 |
| Tarefas de desenvolvimento concluídas | **22** em 31/08; as 5 em aberto e mais 7 entregas até 08/09 |
| Tarefas em aberto | **nenhuma** das identificadas no teste real; o restante está no roadmap |
| Testes automáticos | **373**, executados a cada alteração |
| Rodadas de revisão de qualidade | **5** — 11 pontos de robustez em 31/08 e a blindagem para exposição em 08/09 |
| Pendências de código esquecidas | **nenhuma** |
| Período de construção | 26 de agosto a 8 de setembro de 2026 |

A cada alteração no código, uma esteira automática verifica o projeto inteiro:
padrão de escrita, consistência, banco de dados real, os 373 testes e a compilação
final. Nada entra no sistema sem passar por ela.

### O que os testes reais já registraram

Estes números não vêm de simulação: são conversas de verdade, por WhatsApp, com
celulares reais, entre 30 e 31 de agosto.

| O que aconteceu | Registro |
|---|---|
| Conversas por WhatsApp real | **2 celulares**, em duas sessões |
| Mensagens trocadas | **24** |
| Respostas geradas pelo agente | **10** |
| Transferências para atendente humano | **2** — uma por pedido de desconto, outra porque o cliente pediu para falar com uma pessoa |
| Atendente humano assumindo a conversa no painel | **sim**, com o histórico e a auditoria completos |
| Aprendizados coletados | **6** — correções do atendente, travas acionadas e transferências |
| Melhorias propostas pelo sistema e **aprovadas** por uma pessoa | **1** |
| Tempo médio de resposta | cerca de **4 segundos** |

O último item é o mais significativo. Ele mostra que o ciclo inteiro fechou sozinho
em condições reais: o agente errou ou esbarrou num limite, um humano corrigiu, o
sistema transformou isso em uma proposta de melhoria, e um responsável aprovou. É
exatamente o diferencial do produto, e não é mais uma promessa de arquitetura — já
aconteceu.

Vale a proporção: são **quatro conversas**, não quatro mil. Isso é teste, não
operação. Mas é teste de verdade.

---

## O que já funciona hoje

A demonstração roda em menos de 10 minutos, do celular, e cobre quatro situações:

**1. Autonomia com dado real.**
O cliente pergunta pela situação financeira e recebe valores e vencimentos reais.
Pergunta sobre seu contrato e recebe os dados. Pergunta algo sem resposta possível e
o agente admite que não sabe e oferece um humano. Pergunta sobre uma política da
empresa e ele responde citando o documento oficial.

**2. Trava de segurança e passagem para humano.**
O cliente pede desconto. O agente não negocia: avisa que vai chamar alguém e abre um
chamado. No painel, o atendente vê o chamado aguardando, assume a conversa (o agente
fica em silêncio), responde manualmente e devolve. Nada se perde no meio do caminho,
mesmo se o sistema for reiniciado durante a conversa.

**3. Aprendizado com aprovação humana.**
O curador abre o painel e pede que o sistema analise os atendimentos recentes. O
sistema apresenta propostas de melhoria, com a evidência que justifica cada uma. O
curador aprova uma delas. Na conversa seguinte, o agente já responde melhor. Se a
melhoria der problema, um clique desativa ou volta à versão anterior.

**4. Auditoria e números.**
Qualquer resposta pode ser aberta e destrinchada. E há uma tela de indicadores:
conversas por dia, percentual resolvido sem humano, motivos das transferências para
atendente, e o custo estimado de inteligência artificial no período.

**5. Campanhas e cobrança** *(novo em setembro)*.
O atendente escolhe um modelo aprovado pela Meta e dispara para a carteira; o painel
mostra entregas e leituras. Quando o cotista quer pagar, o agente lista as parcelas em
aberto, ele escolhe boleto, PIX ou cartão, confirma, e o meio de pagamento chega na
própria conversa. O pagamento é conciliado de volta e o cotista recebe a confirmação.

**6. Agente de vendas** *(novo em setembro)*.
Um número sem cadastro pergunta preço. O agente qualifica (quantas pessoas, época de
uso), apresenta o que há disponível, oferta na tabela ou com até 3% de desconto e
agenda com o comercial. Acima disso, o pedido vira pendência para uma pessoa — a
inteligência artificial nunca calcula o valor.

**7. Relatório de campanhas** *(novo em setembro)*.
Para cada campanha: quantos receberam, leram, responderam, geraram cobrança e pagaram;
a conversão contra a meta; comparação com o período anterior; leitura em prosa do que
os números dizem; exportação em planilha e PDF.

**O painel de controle** foi redesenhado em setembro conforme o design aprovado:
Atendimento (estilo WhatsApp Web, com o contexto do cotista ao lado), Campanhas,
Cobranças, Leads, Aprendizado, Métricas e Configurações.

---

## A virada para o negócio real

Esta é a mudança mais relevante desde a última conversa.

**O que era.** O protótipo foi construído com um cenário inventado — uma
distribuidora de bebidas, com pedidos e estoque. Serviu para provar que a arquitetura
funciona, mas não é o negócio dos clientes do TS Explorer.

**O que é agora.** Temos acesso a uma **cópia do banco de dados de um cliente real**
do setor de multipropriedade, com 36 tabelas replicadas e sincronizadas. Ela revela o
negócio como ele é: um resort em 2 blocos, 146 unidades, cerca de 5.700 cotas
vendidas em seis categorias, financiamento próprio que chega a centenas de parcelas —
e o **cancelamento de contrato (distrato) como problema central da operação**.

**Por que a troca é rápida.** O motor do agente não muda. Toda a inteligência,
as travas, o aprendizado, a auditoria e o painel são independentes do ramo de negócio.
O que muda é o **conteúdo**: quais perguntas ele sabe responder, quais documentos
consulta e como ele se apresenta. É exatamente a flexibilidade que a arquitetura foi
desenhada para ter, e esta é a primeira prova prática disso.

**As perguntas que o agente passará a responder:** saldo devedor e parcelas restantes;
o que está vencido e desde quando; vencimento da próxima parcela com o código de
pagamento; quanto já foi pago; qual é a cota e a unidade; qual categoria e quantos
períodos de uso; situação de um pedido de cancelamento, com multa e reembolso; e o
andamento de chamados abertos.

**Um ponto de cuidado já resolvido.** O acesso à cópia do banco foi configurado com
proteção de dados pessoais desde o início: o sistema **não consegue** ler nome nem
CPF dos titulares — ele enxerga apenas um identificador anônimo do contrato. Isso não
foi improviso; foi montado assim de propósito.

**Um limite honesto que virou vantagem.** O banco real mostra que reservas, calendário
de uso e check-in **não existem** nesse sistema. Então, quando um cotista perguntar
"posso reservar a semana do Natal?", o agente vai admitir que não sabe e chamar um
humano — e agora essa limitação é verdadeira, não encenada para a demonstração.

---

## O que o teste real nos ensinou

As conversas reais da seção anterior revelaram quatro melhorias que nenhum teste
automático apontaria. **As quatro foram entregues e integradas até 08/09.**

| # | O que descobrimos | Por que importa |
|---|---|---|
| **1** | **O bot fica mudo cedo demais.** Quando o cliente pede algo que exige um humano, o agente para de responder **tudo** — inclusive perguntas simples e sem relação, que ele saberia responder. Numa conversa real, o cliente pediu desconto, o agente escalou, e as duas perguntas seguintes (sobre o pedido dele) ficaram sem resposta. | Para o cliente, parece que o atendimento morreu. A correção é silenciar o agente só quando o atendente **assume** a conversa, e não no momento da transferência. |
| **2** | **Mensagem que chega durante a resposta gera resposta duplicada.** Se o cliente complementa a pergunta enquanto o agente está processando, ele recebe duas respostas — às vezes contraditórias — e paga-se o dobro de inteligência artificial. Além disso, o tempo de espera antes de responder (4 segundos) é curto demais para quem digita no celular. | Afeta diretamente a qualidade percebida e o custo. |
| **3** | **O painel é uma fila de pendências, não uma tela de atendimento.** Hoje o atendente só enxerga o que foi escalado, cada conversa abre numa página separada e não há indicação de mensagem nova. Além disso, quando o atendente responde, o cliente não sabe que agora está falando com uma pessoa. | Proposta: uma tela única no estilo WhatsApp Web, com todas as conversas à esquerda e a conversa aberta à direita, e o nome do atendente aparecendo na mensagem que chega ao cliente. |
| **4** | **Falta o passo que fecha o ciclo: cobrar.** O agente sabe dizer que existe uma parcela vencida, mas não consegue enviar o meio de pagamento. Este é o item que transforma o atendimento em resultado financeiro — e é também o de maior risco, porque envolve dinheiro. Tem seção própria nas decisões, mais abaixo. | É a diferença entre informar e resolver. |

Vale registrar o que isso significa: os três primeiros itens são ajustes de
comportamento e de interface, não falhas de arquitetura. Eles só apareceram porque
saímos do teste controlado e fomos conversar de verdade — que é exatamente para isso
que serve um protótipo em teste.

---

## O que foi deixado de fora de propósito

Isto não é atraso — foi decidido no início do projeto para chegar rápido a algo
demonstrável. Cada item volta ao plano nas fases seguintes.

| Deixado de fora | Por quê |
|---|---|
| Conexão direta com o sistema de gestão do cliente | Já temos uma cópia do banco real para desenvolver com segurança. A conexão ao ambiente vivo é etapa do piloto. |
| Conta comercial de WhatsApp | Exige processo de aprovação junto à Meta. Para testar, um número de teste resolve. |
| Mensagens proativas (cobrança, lembrete de vencimento) | ✅ Entregue em setembro: campanhas com modelo aprovado pela Meta. Em escala real, ainda depende da conta comercial. |
| Inteligência artificial rodando dentro da empresa | Exige servidor com placa de vídeo. Hoje usamos um fornecedor externo — e o sistema foi construído para trocar de fornecedor sem reescrever nada. |
| Atender vários clientes na mesma instalação | Redefinido em 02/09: cada cliente terá a sua instalação. O trabalho passa a ser versionar e instalar bem. |
| Envio de fotos, áudios e documentos pelo WhatsApp | Hoje o agente só troca texto. |

---

## Próximos passos até produção

> **Seção substituída em 06/09/2026 pelo [`roadmap.md`](roadmap.md).** O texto abaixo é
> mantido como registro do plano de 31/08. O que mudou desde então:
> - A **Fase A está pronta em código** (as três melhorias, o domínio de multipropriedade,
>   os disparos de template e a cobrança pelo WhatsApp), mas **não publicada** — o
>   servidor ainda roda a versão de agosto. Publicar é o marco M0 do roadmap.
> - A **Fase D deixa de ser "vários clientes na mesma instalação"**: o briefing da
>   empresa de 02/09 define instalação isolada por cliente (uma base de código, muitas
>   instalações). O que precisamos é versionar e instalar bem, não multi-cliente.
> - O roadmap integra o backlog da empresa (Project "SETA — Backlog") e as decisões que
>   só os sócios podem tomar, com dono, prazo e consequência.
> - **08/09:** a Fase A está integrada no histórico principal (falta só o servidor); as
>   Fases B e C viraram os marcos M1 a M4 do roadmap, que traz a situação de cada item.

Quatro fases, nesta ordem. Só a primeira tem previsão de data — as demais dependem de
decisões que ainda serão tomadas.

### Fase A — Consolidar o protótipo em teste

> **O protótipo já está conversando por WhatsApp real, na máquina do desenvolvedor.**
> Falta publicá-lo no servidor para que fique disponível o tempo todo, sem depender
> de um computador ligado. **Previsão otimista: primeira semana de setembro de 2026.**

- Publicar no servidor, que já está preparado e com o processo automatizado.
- Aplicar as três melhorias de atendimento que o teste real apontou (bot que fica
  mudo cedo demais, resposta duplicada, painel estilo WhatsApp Web).
- Trocar o cenário de distribuidora pelo domínio de multipropriedade, usando a cópia
  do banco real.

**Destrava:** um protótipo disponível continuamente, no negócio certo, apresentável a
qualquer momento e utilizável internamente todos os dias.

### Fase B — Validação comercial

- Apresentar o produto para resorts de multipropriedade da base TS Explorer.
- Coletar objeções, perguntas frequentes e o que eles esperariam do agente.
- Escolher o cliente que será o primeiro piloto.
- **Decidir se pagamentos entra no piloto** (ver seção de decisões).

**Destrava:** a decisão de investir na Fase C com um cliente concreto, e não com uma
suposição.

### Fase C — Piloto com cliente real

Aqui o protótipo vira sistema em operação:

- **Conectar ao sistema de gestão vivo** do cliente-piloto — hoje trabalhamos com uma
  cópia. Esse trabalho já começou com vantagem: a estrutura do banco real está
  mapeada e as regras de negócio, auditadas.
- **Habilitar a conta comercial de WhatsApp** do resort.
- **Ampliar o repertório** de perguntas conforme o que o piloto mostrar.
- **Preparar a operação para o dia a dia**, o bloco menos visível e mais importante.
  São itens padrão de qualquer sistema em produção, ainda não necessários num teste:
  - proteção contra sobrecarga e uso abusivo;
  - alertas automáticos avisando a equipe se algo parar;
  - verificação contínua de saúde do sistema;
  - backup automático, com restauração testada;
  - gestão de senhas e chaves de acesso em cofre próprio;
  - um ambiente separado para testar antes de publicar;
  - política de proteção de dados pessoais (LGPD). O mecanismo técnico já está
    construído e em uso; falta a política formal de uso, retenção e descarte.

**Destrava:** o primeiro cliente pagante em operação real.

### Fase D — Produto para vários clientes

- **Transformar a instalação única em plataforma.** Hoje, cada cliente novo exigiria
  uma instalação separada. É o maior investimento de desenvolvimento da lista, e o
  que define a capacidade de escala do negócio.
- Configurar cliente, base de conhecimento e catálogo de perguntas pela própria
  interface, sem programador.
- Gestão de usuários e permissões pela interface.
- Mensagens proativas: lembrete de vencimento, aviso de parcela em atraso.

**Destrava:** crescer em número de clientes sem crescer na mesma proporção em custo
de operação.

---

## Decisão que precisa dos sócios: cobrança pelo WhatsApp

Esta merece destaque separado, porque é a primeira funcionalidade que **movimenta
dinheiro** — e isso muda o nível de risco do produto.

**Situação em 08/09:** o fluxo está construído e testado com o fornecedor de pagamentos
em **modo de teste** (nenhuma cobrança real é emitida). As três perguntas ao fim desta
seção continuam abertas — são a decisão D1 do roadmap, com prazo 27/09.

**A oportunidade.** Hoje o agente informa que existe uma parcela vencida. Se ele
puder enviar o link de pagamento junto, o atendimento deixa de ser informação e vira
recebimento. Num negócio de crediário longo, com inadimplência relevante, esse é
provavelmente o maior retorno financeiro direto do produto.

**O que muda no risco.** Até agora o sistema **só lê** dados — o pior erro possível é
o agente dizer algo errado. Enviar cobrança é a primeira ação com efeito no mundo
real. Um erro de valor, de destinatário ou uma cobrança duplicada deixa de ser um
problema de conversa e vira um problema financeiro e jurídico.

**Como pretendemos tratar.** O plano técnico já está escrito e é deliberadamente
conservador:

- O agente **não cria** cobranças novas na primeira etapa — apenas envia o link de
  uma parcela que **já existe** no sistema de gestão. Criar cobrança fica para depois,
  com aprovação humana obrigatória.
- O **valor nunca vem da inteligência artificial**. Ele vem da consulta ao sistema. O
  agente escolhe qual parcela, nunca quanto.
- Confirmação explícita do cliente antes de enviar.
- Proteção contra cobrança duplicada e teto de valor acima do qual um humano precisa
  aprovar.
- O sistema **nunca** recebe nem armazena dados de cartão — apenas envia um link.

**O que precisa da decisão de vocês:**

1. Pagamentos entra já no piloto, ou fica para depois que o atendimento estiver
   estável?
2. Qual o teto de valor acima do qual um humano precisa aprovar?
3. Contratar um novo fornecedor de pagamentos é uma dependência a mais na operação —
   é aceitável?

---

## Riscos e decisões

| Risco / decisão | Impacto | Encaminhamento |
|---|---|---|
| **Dependência de fornecedor externo de IA** e custo por conversa | Custo variável, proporcional ao volume de atendimento | O sistema já mede o custo por dia. A arquitetura permite trocar de fornecedor — ou trazer a IA para dentro — sem reescrever o sistema |
| **Aprovação da conta comercial de WhatsApp pela Meta** | Prazo fora do nosso controle; sem ela, não há mensagem proativa nem volume real | Iniciar o processo cedo, em paralelo com a Fase B |
| **Acesso ao sistema de gestão vivo do cliente-piloto** | Sem ele, a Fase C não começa | Depende de negociação comercial. Já temos vantagem: a cópia do banco está mapeada |
| **Cobrança pelo WhatsApp movimenta dinheiro** | Muda o nível de risco do produto | Ver seção acima — decisão pendente dos sócios |
| **Infraestrutura atual é um servidor pequeno de teste** | Suporta o protótipo, não suporta operação com volume | Dimensionar junto com a definição do piloto |
| **Dados de cotistas reais e LGPD** | Obrigação legal a partir do primeiro cliente real | O mecanismo técnico já está em uso e, desde 08/09, dados pessoais digitados nas conversas são anonimizados antes de sair. Falta a política formal e o contrato com o fornecedor de IA (D6 do roadmap, 27/09) |

---

## Glossário

| Termo | O que significa aqui |
|---|---|
| **Agente** | O atendente digital — o software que conversa com o cliente |
| **Multipropriedade** | Modelo em que uma unidade de resort é vendida em frações de uso (cotas) a vários compradores |
| **Cota** | A fração de uso vendida ao cliente. É o produto do negócio, não o apartamento inteiro |
| **Cotista** | O cliente que comprou uma cota |
| **Distrato** | O cancelamento do contrato pelo cliente, com multa e eventual reembolso |
| **ERP** | O sistema de gestão da empresa, onde ficam contratos, parcelas e cotas. No nosso caso, o TS Explorer |
| **Escalonamento** | Quando o agente transfere a conversa para um atendente humano |
| **Trava (guardrail)** | Regra automática que impede o agente de fazer algo — como negociar desconto ou citar um valor sem origem comprovada |
| **Habilidade (skill)** | Uma instrução de comportamento que o agente aprende e passa a seguir, depois de aprovada por uma pessoa |
| **Curador** | A pessoa responsável por aprovar ou rejeitar as habilidades que o agente propõe |
| **Base de conhecimento** | Os documentos da empresa (regulamento, taxas, regras de cancelamento) que o agente consulta |
| **Piloto** | A primeira operação com um cliente real, em escala controlada |
| **Protótipo** | Versão funcional construída para provar que a ideia funciona, antes de investir no produto completo |
