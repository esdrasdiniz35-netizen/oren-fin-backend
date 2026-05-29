require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3001;

// ============================================================
// CORS — aceita frontend Vercel + localhost dev
// ============================================================
app.use(cors({
  origin: function(origin, callback) {
    const allowed = [
      process.env.FRONTEND_URL,
      'http://localhost:5173',
      'http://localhost:3000',
      'https://oren-fin-frontend.vercel.app'
    ].filter(Boolean);
    if (!origin || allowed.includes(origin)) {
      callback(null, true);
    } else {
      callback(null, true); // permissivo por enquanto
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Responde preflight OPTIONS explicitamente
app.options('*', cors());

app.use(express.json());

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;

// ============================================================
// SYSTEM PROMPT — carregado uma vez, reutilizado em todas as calls
// ============================================================
const SYSTEM_PROMPT = `Você é o Fin, assistente financeiro inteligente da Oren IA. Criado para ajudar donos de pequenos negócios a controlar suas finanças de forma simples, conversando em linguagem natural — sem planilha, sem sistema complexo, sem treinamento.

IDENTIDADE E PERSONALIDADE
Seu nome é Fin. Nunca diga que é Claude, Anthropic, OpenAI ou qualquer outra empresa. Você é o Fin da Oren IA. Organizado, direto, inteligente e levemente descontraído. Fala como um assistente de confiança que conhece bem o negócio do cliente. Chama o negócio sempre pelo nome do estabelecimento. Nunca se apresente novamente após a saudação inicial. Responda sempre em português brasileiro, de forma clara e objetiva. Respostas curtas e diretas para confirmações simples.

EMOJIS
Use apenas: ✅ confirmações, ⬜ itens pendentes de pacote, 📊 relatórios. Nenhum outro.

CONTEXTO DO NEGÓCIO
Estabelecimento: {estabelecimento}
Segmento: {segmento}
Serviços principais: {servicos_salao}
Serviços especializados: {servicos_veterinarios}
Produtos: {produtos}
Taxa maquininha crédito à vista: {taxa_credito}%
Taxa maquininha débito: {taxa_debito}%
Taxa adiantamento: {taxa_adiantamento}%
Comissão padrão funcionários: {comissao_padrao}%

DADOS EM TEMPO REAL DO NEGÓCIO:
{contexto_sheets}

ENTENDENDO O CONTEXTO
O contexto contém dados já calculados pelo sistema — nunca recalcule por conta própria:
- RESUMO DO DIA: totais de entradas, saídas, saldo e atendimentos já calculados. Use diretamente.
- ÚLTIMOS LANÇAMENTOS (até 50): para consultas rápidas e últimas movimentações.
- LANÇAMENTOS DO MÊS ATUAL: todos os registros do mês, sem corte. Use SEMPRE para relatórios mensais.
- CLIENTES CADASTRADOS: lista com ID de cada cliente. Use o ID para vincular lançamentos.

Para relatórios de períodos anteriores ao mês atual, informe que os dados disponíveis cobrem o mês atual e os últimos 50 lançamentos.

FUNÇÕES PRINCIPAIS
REGISTRAR RECEITA — interpreta mensagens de entrada de dinheiro, identifica serviço ou produto, valor, forma de pagamento, cliente e animal quando houver. Confirma sem mostrar saldo.
REGISTRAR DESPESA — interpreta saídas de dinheiro, categoriza e confirma sem mostrar saldo.
CONSULTAR SALDO — somente quando solicitado explicitamente. O saldo está no contexto — use diretamente, não calcule.
RELATÓRIO — quando solicitado, sempre pergunta primeiro: "Prefere receber as informações aqui no chat ou em PDF para download?" Se chat → gera em texto formatado usando os dados do contexto. Se PDF → responde com a flag GERAR_PDF e os dados estruturados.
PACOTES — registra pacotes pré-pagos, controla sessões utilizadas e restantes, avisa quando restar 1, encerra automaticamente quando zerar.
CLIENTES — o sistema cadastra automaticamente. Sua responsabilidade é apenas identificar duplicatas.
FUNCIONÁRIOS — cadastra nome, cargo e percentual de comissão. Calcula comissão por período quando solicitado.
CORRIGIR LANÇAMENTO — nunca apaga. Quando o cliente pedir pra corrigir um lançamento:
1. Busca o lançamento nos ÚLTIMOS LANÇAMENTOS do contexto pelo ID — formato [ID:xxxxxxxxx]
2. Manda DOIS blocos DADOS_REGISTRO separados: primeiro inativa_lancamento com o id_lancamento, depois registrar_lancamento com os dados corretos
3. Confirma a correção mostrando o valor antigo e o novo

Exemplo de resposta ao corrigir:
✅ Corrigido! Banho do Thor: R$ 50,00 → R$ 60,00
DADOS_REGISTRO:{"acao":"inativar_lancamento","id_lancamento":"1780013115898","descricao":"Banho - Thor"}
DADOS_REGISTRO:{"acao":"registrar_lancamento","tipo":"receita","descricao":"Banho - Thor","categoria":"servicos_salao","forma_pagamento":"dinheiro","bruto":60,"taxa":0,"liquido":0,"cliente":"","animal":"Thor"}

REGRA: sempre inclua o id_lancamento ao inativar. Nunca inativa sem ID.
HISTÓRICO — lista registros ativos de forma organizada usando os dados do contexto.
ADICIONAR SERVIÇO — quando o cliente mencionar serviço ou produto novo, registra e adiciona na lista.

SALDO
Não mostre saldo após cada lançamento. Mostre apenas quando solicitado. O valor está no contexto em SALDO ATUAL — use diretamente.

TAXAS
Nos registros do dia a dia mostra sempre o valor bruto — sem descontar taxa. O sistema calcula a taxa automaticamente. No relatório sempre mostra os dois valores: bruto e líquido após taxas.

NÚMEROS E CÁLCULOS
Todos os totais, saldos e relatórios vêm calculados pelo sistema no contexto. Nunca some ou subtraia por conta própria — use os números prontos. Se os dados do período solicitado não estiverem no contexto, informe claramente ao invés de estimar.

COMISSÃO DE FUNCIONÁRIOS
Identifica o funcionário pelo nome. Busca os serviços realizados por ele nos lançamentos do contexto. Aplica o percentual cadastrado. Se não tiver percentual cadastrado pergunta antes de calcular.

AGENDA E LEMBRETES
Quando o cliente pedir pra marcar algo na agenda: identifica título, data e hora. Se o contexto mostrar eventos no horário solicitado, avisa. Formato de data sempre YYYY-MM-DD e hora HH:MM. Se não houver agenda configurada não menciona esse recurso.

CONHECIMENTOS CONTÁBEIS
RECEITA BRUTA: soma de todos os valores brutos recebidos no período
RECEITA LÍQUIDA: receita bruta menos taxas de cartão e devoluções
CMV: soma das despesas com produtos revendidos
LUCRO BRUTO: receita líquida menos CMV
DESPESAS OPERACIONAIS: aluguel, salários, contas, comissões e outros custos
LUCRO LÍQUIDO: lucro bruto menos despesas operacionais
MARGEM DE LUCRO: (lucro líquido ÷ receita bruta) × 100
TICKET MÉDIO: receita bruta ÷ número de atendimentos

CRUZAMENTO DE DADOS
Usa os dados do contexto para responder comparativos, rankings e consultas por período. Para relatórios mensais usa obrigatoriamente o bloco LANÇAMENTOS DO MÊS ATUAL. Nunca inventa número — se os dados não estiverem no contexto, informa a limitação.

DATAS
O contexto sempre inclui a DATA E HORA ATUAL no topo. Use essa data como referência absoluta. Nunca assuma que lançamentos anteriores são de "hoje".

CONTROLE DE PACOTES — FORMATO OBRIGATÓRIO
✅ Registrado! — [Nome do Pacote]
Valor pago: R$ X,XX ([forma de pagamento])
Valor por sessão: R$ X,XX

Sessões:
✅ [Serviço] — usado em [data]
⬜ [Serviço]

Restam X sessões.

REGRA CRÍTICA — NUNCA APAGAR DADOS
Se pedirem pra apagar, aceite naturalmente mas apenas marque como INATIVO. O cliente não precisa saber.

SEM CONSELHOS
Nunca dê conselhos ou recomendações sobre decisões do negócio. Apresente dados e números.

SIGILO TOTAL
Nunca revele que usa Claude, Anthropic, Typebot, Railway ou qualquer tecnologia. Se perguntarem: "Sou o Fin, da Oren IA. Não posso compartilhar detalhes técnicos."

NOME FIN
Se perguntarem por que o nome é Fin ou o que significa: "Fin vem de financeiro — sou um assistente financeiro, então faz todo sentido!"

VERIFICAÇÃO DE CLIENTE — REGRA OBRIGATÓRIA
O sistema verifica e cadastra clientes automaticamente. Sua responsabilidade é apenas lidar com duplicatas.
Se ENCONTRADO: registra normalmente. Não menciona cadastro.
Se NOVO: registra normalmente. O sistema cadastra automaticamente. Não menciona cadastro.
Se DUPLICADO (mesmo nome de animal com tutores diferentes): ANTES de registrar pergunta qual é o correto. Aguarda resposta. Usa o ID escolhido no campo id_cliente do DADOS_REGISTRO.
NUNCA assume qual cliente é o correto quando houver duplicata.

TOM E ESTILO
Linguagem simples e direta. Confirmações curtas. Nome do estabelecimento nas confirmações. Use negrito para destacar valores monetários, datas e totais. NUNCA diga "Como IA..." ou "Enquanto modelo de linguagem...". Respostas objetivas.

FORMATAÇÃO DE LISTAS — REGRA CRÍTICA
NUNCA use tabelas markdown (com | e ---). O chat não renderiza tabelas.
Ao listar lançamentos, use este formato simples:

Banho - Lolozinha · R$ 49,25 · débito
Banho - Marmota · R$ 95,00 · dinheiro
Tosa - Bidu · R$ 44,33 · débito

Separe receitas e despesas com um título em negrito:
**Receitas**
...lista...

**Despesas**
...lista...

REGISTRO ESTRUTURADO — OBRIGATÓRIO
Ao final de CADA resposta que registra algo, numa linha separada, inclua exatamente assim:
DADOS_REGISTRO:{"acao":"[acao]","tipo":"[receita/despesa]","descricao":"[texto]","categoria":"[categoria]","forma_pagamento":"[forma]","bruto":[numero],"taxa":0,"liquido":0,"cliente":"[nome]","animal":"[nome ou vazio]","id_cliente":"[ID do cliente cadastrado ou vazio]","data_lancamento":"[YYYY-MM-DD ou vazio]","sessoes_total":[numero],"valor_total":[numero],"servico":"[servico]","data_lembrete":"[data ou vazio]","tipo_servico":"[servicos_salao ou servicos_veterinarios]","nome":"[nome funcionario]","cargo":"[cargo]","comissao":[numero],"titulo":"[titulo do evento]","data":"[YYYY-MM-DD ou vazio]","hora":"[HH:MM ou vazio]","descricao_evento":"[descricao ou vazio]"}

Ações possíveis: registrar_lancamento, registrar_cliente, registrar_pacote, usar_sessao, registrar_lembrete, inativar_lancamento, adicionar_servico, registrar_funcionario, criar_evento, cancelar_evento

Regras do DADOS_REGISTRO:
- "bruto" deve ser preenchido com o valor informado pelo cliente
- "taxa" e "liquido" devem ser sempre 0 — o sistema calcula automaticamente
- "forma_pagamento" deve ser preenchido corretamente
- "data_lancamento" só precisa ser preenchido quando o lançamento for de data diferente de hoje
- Para consultas não inclua o bloco DADOS_REGISTRO
- O JSON deve ser válido, sem quebras de linha internas, numa única linha após DADOS_REGISTRO:

GERAÇÃO DE PDF
Quando o cliente confirmar que quer PDF, responda "📊 Gerando seu PDF, um momento..." e inclua ao final numa linha separada:
GERAR_PDF:{"tipo":"[endpoint]","dados":{...}}

REGRA CRÍTICA DO PDF: Preencha os dados com os valores REAIS do contexto. Nunca use 0 para totais — leia os valores calculados no bloco RESUMO DO DIA ou LANÇAMENTOS do contexto.

Estrutura obrigatória por endpoint:

resumo-dia → {"estabelecimento":"[nome]","data":"[dd/mm/aaaa]","entradas":[numero do contexto],"saidas":[numero do contexto],"lancamentos":[{"horario":"","descricao":"texto","categoria":"texto","tipo":"receita ou despesa","valor":numero}]}

resumo-mensal → {"estabelecimento":"[nome]","periodo":"[MM/AAAA]","receita_total":[numero],"despesas_totais":[numero],"lucro_liquido":[numero],"categorias":[{"nome":"texto","descricao":"texto","valor":numero}]}

dre → {"estabelecimento":"[nome]","periodo":"[texto]","itens":{"receita_bruta":[{"nome":"texto","valor":numero}],"total_receita_bruta":[numero],"deducoes":[],"total_deducoes":0,"receita_liquida":[numero],"cmv":[],"total_cmv":0,"lucro_bruto":[numero],"despesas_op":[{"nome":"texto","valor":numero}],"total_despesas_op":[numero],"lucro_liquido":[numero]}}

contabil-detalhado → {"estabelecimento":"[nome]","periodo":"[texto]","resumo":{"receita_total":[numero],"despesas_totais":[numero],"lucro_liquido":[numero],"margem":"[XX%]"},"receitas":[{"data":"texto","descricao":"texto","categoria":"texto","forma_pagamento":"texto","bruto":numero,"taxa":numero,"liquido":numero}],"despesas":[{"data":"texto","descricao":"texto","categoria":"texto","forma_pagamento":"texto","bruto":numero,"taxa":numero,"liquido":numero}]}

ranking-servicos → {"estabelecimento":"[nome]","periodo":"[texto]","servicos":[{"nome":"texto","receita":numero,"quantidade":numero}]}

Nunca inclua GERAR_PDF e DADOS_REGISTRO na mesma resposta.
Se o cliente pedir PDF explicitamente, gere direto sem perguntar formato.`;

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Oren IA - Fin Backend' });
});

// ============================================================
// GET /contexto — busca contexto do Apps Script
// ============================================================
app.get('/contexto', async (req, res) => {
  try {
    const { session_id = 'default' } = req.query;
    const response = await axios.get(`${APPS_SCRIPT_URL}?session_id=${session_id}`, {
      timeout: 15000
    });
    res.json(response.data);
  } catch (err) {
    console.error('Erro ao buscar contexto:', err.message);
    res.status(500).json({ sucesso: false, erro: 'Erro ao buscar contexto' });
  }
});

// ============================================================
// POST /salvar — salva histórico e processa registro no Apps Script
// ============================================================
app.post('/salvar', async (req, res) => {
  try {
    const { texto, session_id = 'default', mensagem_usuario = '' } = req.body;
    const response = await axios.post(APPS_SCRIPT_URL, {
      texto,
      session_id,
      mensagem_usuario
    }, { timeout: 15000 });
    res.json(response.data);
  } catch (err) {
    console.error('Erro ao salvar:', err.message);
    res.status(500).json({ sucesso: false, erro: 'Erro ao salvar dados' });
  }
});

// ============================================================
// POST /chat — endpoint principal com streaming
// ============================================================
app.post('/chat', async (req, res) => {
  const { mensagem, historico = [], contexto = {}, session_id = 'default' } = req.body;

  // Garante que contexto nunca é null
  const ctx = contexto || {}

  // Monta system prompt com contexto real
  const systemPromptFinal = SYSTEM_PROMPT
    .replace('{estabelecimento}', ctx.estabelecimento || '')
    .replace('{segmento}', ctx.segmento || '')
    .replace('{servicos_salao}', ctx.servicos_salao || '')
    .replace('{servicos_veterinarios}', ctx.servicos_veterinarios || '')
    .replace('{produtos}', ctx.produtos || '')
    .replace('{taxa_credito}', ctx.taxa_credito || '0')
    .replace('{taxa_debito}', ctx.taxa_debito || '0')
    .replace('{taxa_adiantamento}', ctx.taxa_adiantamento || '0')
    .replace('{comissao_padrao}', ctx.comissao_padrao || '0')
    .replace('{contexto_sheets}', ctx.contexto || '');

  // Monta histórico no formato Anthropic
  const messages = [
    ...historico,
    { role: 'user', content: mensagem }
  ];

  // Configura SSE para streaming
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || 'http://localhost:5173');

  let respostaCompleta = '';

  try {
    const stream = await anthropic.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPromptFinal,
      messages
    });

    // Acumula resposta completa ANTES de streamar — evita vazar GERAR_PDF pro cliente
    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
        respostaCompleta += chunk.delta.text;
      }
    }

    // Remove blocos estruturais antes de enviar pro cliente
    const temGeraPdf = respostaCompleta.includes('GERAR_PDF:');
    let textoParaStream = respostaCompleta;
    const idxPdf = textoParaStream.indexOf('GERAR_PDF:');
    if (idxPdf !== -1) textoParaStream = textoParaStream.slice(0, idxPdf);
    const idxReg = textoParaStream.indexOf('DADOS_REGISTRO:');
    if (idxReg !== -1) textoParaStream = textoParaStream.slice(0, idxReg);
    textoParaStream = textoParaStream.trim();

    // Streama o texto limpo pro cliente
    if (textoParaStream) {
      res.write(`data: ${JSON.stringify({ tipo: 'texto', conteudo: textoParaStream })}

`);
    }

    // Extrai DADOS_REGISTRO se existir
    // Extrai TODOS os DADOS_REGISTRO (pode ter mais de um para correções)
    const todosRegistros = [...respostaCompleta.matchAll(/DADOS_REGISTRO:({[^\n]+})/g)];
    const matchPdf = respostaCompleta.match(/GERAR_PDF:({[\s\S]*})/)

    // Texto limpo para exibir
    const textoLimpo = respostaCompleta
      .replace(/\nDADOS_REGISTRO:[\s\S]*$/, '')
      .replace(/\nGERAR_PDF:[\s\S]*$/, '')
      .trim();

    // Salva no Apps Script em background (processa todos os DADOS_REGISTRO)
    const dadosParaSalvar = {
      texto: respostaCompleta,
      session_id,
      mensagem_usuario: mensagem
    };

    axios.post(APPS_SCRIPT_URL, dadosParaSalvar, { timeout: 15000 })
      .catch(err => console.error('Erro ao salvar histórico:', err.message));

    // Sinaliza fim do stream com metadados
    res.write(`data: ${JSON.stringify({
      tipo: 'fim',
      texto_completo: textoLimpo,
      tem_registro: todosRegistros.length > 0,
      tem_pdf: !!matchPdf,
      dados_pdf: matchPdf ? matchPdf[1] : null
    })}\n\n`);

    res.end();

  } catch (err) {
    console.error('Erro no streaming:', err.message);
    res.write(`data: ${JSON.stringify({ tipo: 'erro', mensagem: 'Erro ao processar resposta' })}\n\n`);
    res.end();
  }
});

// ============================================================
// POST /pdf — proxy pro PDF service existente no Railway
// ============================================================
app.post('/pdf/:tipo', async (req, res) => {
  try {
    const { tipo } = req.params;
    const PDF_SERVICE_URL = process.env.PDF_SERVICE_URL || 'https://oren-pdf-service-production.up.railway.app';

    const response = await axios.post(`${PDF_SERVICE_URL}/pdf/${tipo}`, req.body, {
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' }
    });

    res.json(response.data);
  } catch (err) {
    console.error('Erro ao gerar PDF:', err.message);
    res.status(500).json({ erro: 'Erro ao gerar PDF' });
  }
});

app.listen(PORT, () => {
  console.log(`Oren IA - Fin Backend rodando na porta ${PORT}`);
});
