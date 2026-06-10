require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3001;
const MASTER_SPREADSHEET_ID = process.env.MASTER_SPREADSHEET_ID;
const FOCUS_TOKEN = process.env.FOCUS_NFE_TOKEN;
const FOCUS_AMBIENTE = process.env.FOCUS_NFE_AMBIENTE || 'homologacao';
const FOCUS_BASE_URL = 'https://api.focusnfe.com.br';
const CODIGO_MUNICIPIO_BH = 3106200;

function getGoogleAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
}

const clienteCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

async function getAppsScriptUrl(slug) {
  const cached = clienteCache.get(slug);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.url;
  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: MASTER_SPREADSHEET_ID,
    range: 'clientes!A:F'
  });
  const rows = response.data.values || [];
  for (let i = 1; i < rows.length; i++) {
    const [rowSlug, rowUrl, , , rowStatus] = rows[i];
    if (rowSlug === slug) {
      if (rowStatus !== 'ativo') throw new Error(`Cliente ${slug} não está ativo`);
      clienteCache.set(slug, { url: rowUrl, ts: Date.now() });
      return rowUrl;
    }
  }
  throw new Error(`Cliente não encontrado: ${slug}`);
}

async function resolveAppsScriptUrl(slug) {
  if (!slug) return process.env.APPS_SCRIPT_URL;
  try {
    return await getAppsScriptUrl(slug);
  } catch (err) {
    console.error(`[resolveAppsScriptUrl] Erro slug=${slug}:`, err.message);
    if (slug === 'pethousebh4821') return process.env.APPS_SCRIPT_URL;
    throw err;
  }
}

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || /\.orenia\.com\.br$/.test(origin)) return callback(null, true);
    const allowed = [process.env.FRONTEND_URL, 'http://localhost:5173', 'http://localhost:3000', 'https://oren-fin-frontend.vercel.app'].filter(Boolean);
    callback(null, allowed.includes(origin) || true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-client-slug']
}));
app.options('*', cors());
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const FIN_TOOLS = [
  {
    name: 'registrar_lancamento',
    description: 'Registra uma receita ou despesa financeira. Use para qualquer serviço prestado, produto vendido ou despesa paga. O Apps Script calcula taxa e líquido automaticamente — sempre envie taxa e liquido como 0.',
    input_schema: {
      type: 'object',
      properties: {
        tipo: { type: 'string', enum: ['receita', 'despesa'], description: 'Tipo do lançamento' },
        descricao: { type: 'string', description: 'Descrição do serviço ou despesa. Ex: "Banho - Rex", "Material de limpeza"' },
        categoria: { type: 'string', description: 'Categoria. Ex: servicos_salao, servicos_veterinarios, produtos, despesas_fixas' },
        forma_pagamento: { type: 'string', description: 'Forma de pagamento: dinheiro, pix, crédito, débito, transferência, pendente' },
        bruto: { type: 'number', description: 'Valor bruto em reais' },
        taxa: { type: 'number', description: 'Sempre 0 — o Apps Script calcula' },
        liquido: { type: 'number', description: 'Sempre 0 — o Apps Script calcula' },
        cliente: { type: 'string', description: 'Nome do tutor/cliente. Obrigatório para receitas.' },
        animal: { type: 'string', description: 'Nome do pet/animal' },
        id_cliente: { type: 'string', description: 'ID do cliente se já existir no cadastro' },
        data_lancamento: { type: 'string', description: 'Data no formato YYYY-MM-DD. Vazio = hoje' }
      },
      required: ['tipo', 'descricao', 'forma_pagamento', 'bruto']
    }
  },
  {
    name: 'registrar_pacote',
    description: 'Cria um pacote de serviços pré-pago. Sempre chame DEPOIS de registrar_lancamento para o pagamento do pacote.',
    input_schema: {
      type: 'object',
      properties: {
        cliente: { type: 'string', description: 'Nome do tutor' },
        relacionado: { type: 'string', description: 'Nome do pet' },
        servico: { type: 'string', description: 'Nome do serviço do pacote. Ex: "4 Banhos + 1 Hidratação"' },
        sessoes_total: { type: 'number', description: 'Total de sessões do pacote' },
        valor_total: { type: 'number', description: 'Valor total pago pelo pacote' },
        id_cliente: { type: 'string', description: 'ID do cliente — obrigatório' },
        data_lancamento: { type: 'string', description: 'Data da compra YYYY-MM-DD. Vazio = hoje' }
      },
      required: ['cliente', 'relacionado', 'servico', 'sessoes_total', 'valor_total', 'id_cliente']
    }
  },
  {
    name: 'usar_sessao',
    description: 'Registra uso de uma sessão de pacote HOJE. Use apenas para sessões do dia atual.',
    input_schema: {
      type: 'object',
      properties: {
        cliente: { type: 'string', description: 'Nome do tutor' },
        relacionado: { type: 'string', description: 'Nome do pet' },
        servico: { type: 'string', description: 'Nome do serviço do pacote' },
        data_lancamento: { type: 'string', description: 'Data YYYY-MM-DD. Vazio = hoje' }
      },
      required: ['cliente', 'relacionado', 'servico']
    }
  },
  {
    name: 'registrar_sessoes_retroativas',
    description: 'Registra múltiplas sessões de pacote de datas passadas de uma vez. Use para sessões que já aconteceram antes de hoje.',
    input_schema: {
      type: 'object',
      properties: {
        cliente: { type: 'string', description: 'Nome do tutor' },
        relacionado: { type: 'string', description: 'Nome do pet' },
        servico: { type: 'string', description: 'Nome do serviço do pacote' },
        datas: { type: 'array', items: { type: 'string' }, description: 'Array de datas no formato DD/MM/AAAA' }
      },
      required: ['cliente', 'relacionado', 'servico', 'datas']
    }
  },
  {
    name: 'registrar_cliente',
    description: 'Cadastra um novo cliente explicitamente. Use APENAS quando o usuário pedir cadastro explícito sem lançamento. Para serviços, o cliente é cadastrado automaticamente via registrar_lancamento.',
    input_schema: {
      type: 'object',
      properties: {
        nome: { type: 'string', description: 'Nome do tutor — obrigatório' },
        relacionado: { type: 'string', description: 'Nome do pet' },
        telefone: { type: 'string', description: 'Telefone do cliente' },
        cpf: { type: 'string', description: 'CPF do cliente' }
      },
      required: ['nome']
    }
  },
  {
    name: 'atualizar_cliente',
    description: 'Atualiza dados de um cliente existente.',
    input_schema: {
      type: 'object',
      properties: {
        id_cliente: { type: 'string', description: 'ID do cliente' },
        nome: { type: 'string' },
        telefone: { type: 'string' },
        relacionado: { type: 'string', description: 'Nome do pet' },
        cpf: { type: 'string' }
      },
      required: ['id_cliente']
    }
  },
  {
    name: 'inativar_lancamento',
    description: 'Inativa (cancela) um lançamento existente. Sempre use o id_lancamento.',
    input_schema: {
      type: 'object',
      properties: {
        id_lancamento: { type: 'string', description: 'ID do lançamento — obrigatório' },
        descricao: { type: 'string', description: 'Descrição para log' }
      },
      required: ['id_lancamento']
    }
  },
  {
    name: 'ativar_lancamento',
    description: 'Ativa um lançamento pendente (fiado), registrando o recebimento do pagamento.',
    input_schema: {
      type: 'object',
      properties: {
        id_lancamento: { type: 'string', description: 'ID do lançamento pendente' },
        descricao: { type: 'string', description: 'Descrição do lançamento se não souber o ID' },
        forma_pagamento: { type: 'string', description: 'Forma de pagamento efetivo recebido' }
      },
      required: ['forma_pagamento']
    }
  },
  {
    name: 'cadastrar_conta_pagar',
    description: 'Cadastra uma conta fixa ou recorrente a pagar.',
    input_schema: {
      type: 'object',
      properties: {
        descricao: { type: 'string', description: 'Nome da conta. Ex: Aluguel, Internet' },
        valor: { type: 'number', description: 'Valor da conta' },
        dia_vencimento: { type: 'number', description: 'Dia do mês que vence' },
        recorrente: { type: 'boolean', description: 'true para contas mensais fixas' },
        categoria: { type: 'string', description: 'Categoria da despesa' }
      },
      required: ['descricao', 'valor', 'dia_vencimento']
    }
  },
  {
    name: 'pagar_conta',
    description: 'Registra o pagamento de uma conta cadastrada. O lançamento de despesa é criado automaticamente — não chame registrar_lancamento separado.',
    input_schema: {
      type: 'object',
      properties: {
        descricao: { type: 'string', description: 'Nome da conta a pagar' },
        id_conta: { type: 'string', description: 'ID da conta se souber' },
        forma_pagamento: { type: 'string', description: 'Forma de pagamento' },
        data_lancamento: { type: 'string', description: 'Data YYYY-MM-DD. Vazio = hoje' }
      },
      required: ['descricao', 'forma_pagamento']
    }
  },
  {
    name: 'cadastrar_produto',
    description: 'Cadastra um produto no estoque.',
    input_schema: {
      type: 'object',
      properties: {
        nome: { type: 'string', description: 'Nome do produto' },
        categoria: { type: 'string', description: 'Categoria. Ex: higiene, medicamento, acessório' },
        quantidade: { type: 'number', description: 'Quantidade inicial em estoque' },
        custo: { type: 'number', description: 'Preço de custo' },
        preco_venda: { type: 'number', description: 'Preço de venda' },
        unidade: { type: 'string', description: 'Unidade: un, kg, ml, cx' },
        codigo_barras: { type: 'string', description: 'Código de barras opcional' }
      },
      required: ['nome', 'quantidade', 'custo', 'preco_venda']
    }
  },
  {
    name: 'entrada_estoque',
    description: 'Registra entrada de produtos no estoque.',
    input_schema: {
      type: 'object',
      properties: {
        nome: { type: 'string', description: 'Nome do produto' },
        quantidade: { type: 'number', description: 'Quantidade a adicionar' },
        custo: { type: 'number', description: 'Novo custo unitário (opcional)' }
      },
      required: ['nome', 'quantidade']
    }
  },
  {
    name: 'saida_estoque',
    description: 'Registra venda de produto. O lançamento de receita é criado automaticamente — não chame registrar_lancamento separado.',
    input_schema: {
      type: 'object',
      properties: {
        nome: { type: 'string', description: 'Nome do produto' },
        quantidade: { type: 'number', description: 'Quantidade vendida' },
        preco_venda: { type: 'number', description: 'Preço unitário de venda' },
        registrar_venda: { type: 'boolean', description: 'Sempre true' },
        forma_pagamento: { type: 'string', description: 'Forma de pagamento' },
        cliente: { type: 'string', description: 'Nome do cliente' },
        id_cliente: { type: 'string', description: 'ID do cliente' },
        data_lancamento: { type: 'string', description: 'Data YYYY-MM-DD. Vazio = hoje' }
      },
      required: ['nome', 'quantidade', 'preco_venda', 'forma_pagamento']
    }
  },
  {
    name: 'emitir_nota',
    description: 'Emite nota fiscal NFS-e para um serviço prestado.',
    input_schema: {
      type: 'object',
      properties: {
        descricao: { type: 'string', description: 'Descrição do serviço' },
        valor: { type: 'number', description: 'Valor do serviço' },
        nome_tomador: { type: 'string', description: 'Nome completo do cliente' },
        cpf_tomador: { type: 'string', description: 'CPF do cliente' },
        id_cliente: { type: 'string', description: 'ID do cliente' },
        email_tomador: { type: 'string', description: 'Email do cliente (opcional)' }
      },
      required: ['descricao', 'valor', 'nome_tomador', 'cpf_tomador']
    }
  },
  {
    name: 'registrar_funcionario',
    description: 'Cadastra um funcionário.',
    input_schema: {
      type: 'object',
      properties: {
        nome: { type: 'string' },
        cargo: { type: 'string' },
        comissao: { type: 'number', description: 'Percentual de comissão' }
      },
      required: ['nome', 'cargo']
    }
  },
  {
    name: 'criar_evento',
    description: 'Cria um evento na agenda.',
    input_schema: {
      type: 'object',
      properties: {
        titulo: { type: 'string' },
        data: { type: 'string', description: 'YYYY-MM-DD' },
        hora: { type: 'string', description: 'HH:MM' },
        descricao_evento: { type: 'string' }
      },
      required: ['titulo', 'data']
    }
  },
  {
    name: 'criar_evento_recorrente',
    description: 'Cria um evento semanal recorrente na agenda.',
    input_schema: {
      type: 'object',
      properties: {
        titulo: { type: 'string' },
        dia_semana: { type: 'string', description: 'segunda/terca/quarta/quinta/sexta/sabado/domingo' },
        hora: { type: 'string', description: 'HH:MM' },
        descricao_evento: { type: 'string' }
      },
      required: ['titulo', 'dia_semana']
    }
  },
  {
    name: 'cancelar_evento',
    description: 'Cancela evento(s) na agenda.',
    input_schema: {
      type: 'object',
      properties: {
        titulo: { type: 'string' },
        data: { type: 'string', description: 'YYYY-MM-DD. Vazio = cancela todos com esse título' }
      },
      required: ['titulo']
    }
  },
  {
    name: 'registrar_lembrete',
    description: 'Registra um lembrete para um cliente.',
    input_schema: {
      type: 'object',
      properties: {
        cliente: { type: 'string' },
        relacionado: { type: 'string', description: 'Nome do pet' },
        descricao: { type: 'string' },
        data_lembrete: { type: 'string', description: 'DD/MM/YYYY' }
      },
      required: ['descricao']
    }
  },
  {
    name: 'registrar_historico_mensal',
    description: 'Salva dados históricos de um mês passado.',
    input_schema: {
      type: 'object',
      properties: {
        mes: { type: 'number' },
        ano: { type: 'number' },
        banhos: { type: 'number' },
        consultas: { type: 'number' },
        receita_total: { type: 'number' },
        despesas_total: { type: 'number' }
      },
      required: ['mes', 'ano']
    }
  }
];

const SYSTEM_PROMPT_PETSHOP = `Você é o Fin, assistente financeiro inteligente da Oren IA, criado para donos de pet shops controlarem finanças em linguagem natural — sem planilha, sem sistema complexo.

============================================================
IDENTIDADE
============================================================
Seu nome é Fin, da Oren IA. Nunca mencione Claude, Anthropic ou qualquer outra empresa.
Seja direto, organizado e levemente descontraído. Fale sempre em português brasileiro.
Chame o negócio pelo nome do estabelecimento. Não se apresente novamente após a saudação inicial.
Respostas curtas para confirmações simples. Nunca diga "Como IA...".

EMOJIS — use apenas: ✅ confirmações | ⬜ sessões pendentes de pacote | 📊 relatórios | 📄 nota fiscal

============================================================
CONTEXTO DO NEGÓCIO
============================================================
Estabelecimento: {estabelecimento}
Serviços do salão: {servicos_salao}
Serviços veterinários: {servicos_veterinarios}
Produtos: {produtos}
Taxa crédito: {taxa_credito}% | Taxa débito: {taxa_debito}% | Taxa adiantamento: {taxa_adiantamento}%
Comissão padrão: {comissao_padrao}%

DADOS EM TEMPO REAL:
{contexto_sheets}

============================================================
LENDO O CONTEXTO — REGRAS
============================================================
Nunca recalcule dados que já vieram calculados no contexto. Use diretamente:
- RESUMO DO DIA → use para resumos do dia
- LANÇAMENTOS DO MÊS ATUAL → use SEMPRE para relatórios mensais (nunca use só os últimos 50)
- ÚLTIMOS LANÇAMENTOS → use para consultas rápidas e histórico recente. Lançamentos com [PENDENTE] são fiados ainda não pagos.
- CLIENTES CADASTRADOS → use para identificar tutores e seus IDs
- PACOTES ATIVOS → use para verificar sessões disponíveis
- CONTAS A VENCER → avise proativamente quando houver contas nos próximos 7 dias
- ESTOQUE DE PRODUTOS → avise proativamente quando houver ⚠️ ESTOQUE BAIXO
- CONTAS A PAGAR CADASTRADAS → use para consultas de contas fixas

Para períodos anteriores ao mês atual: informe que os dados cobrem o mês atual e os últimos 50 lançamentos.

============================================================
REGRA CENTRAL — CLIENTES E TUTORES
============================================================
O sistema identifica clientes pelo par TUTOR + PET. Siga sempre esta ordem:

PASSO 1 — Nome do tutor é obrigatório para receitas
Se a mensagem não trouxer o nome do tutor, pergunte ANTES de chamar qualquer tool:
"Qual o nome do tutor de [animal]?"
NUNCA chame registrar_lancamento com o campo "cliente" vazio para receitas.

PASSO 2 — Verificar na lista CLIENTES CADASTRADOS
- Tutor não existe → novo cliente, registra normalmente
- Tutor existe com o mesmo pet → mesmo cliente, use o id_cliente existente
- Tutor existe mas com pet diferente → mesmo tutor, pet novo. Use o id_cliente existente.
- Mais de um tutor com o mesmo nome → pergunte qual é o correto ANTES de chamar a tool:
  "Encontrei mais de um(a) [Nome] cadastrado(a). É o(a) tutor(a) de [animal existente] ou é um(a) novo(a)?"

PASSO 3 — Sempre inclua id_cliente quando o tutor já existir
NUNCA deixe id_cliente vazio se o tutor já está na lista.

PASSO 4 — APÓS RESOLVER AMBIGUIDADE, chame a tool imediatamente
Quando o usuário confirmar qual tutor é, chame registrar_lancamento na mesma resposta.
NUNCA confirme sem chamar a tool.

PASSO 5 — Para serviços, chame APENAS registrar_lancamento
O sistema cadastra o cliente automaticamente. Não chame registrar_cliente separado para serviços.
Use registrar_cliente apenas para cadastro explícito sem lançamento (ex: "cadastra a Maria com o Rex").

============================================================
REGISTRAR RECEITA E DESPESA
============================================================
Interprete a mensagem, identifique serviço/produto, valor, forma de pagamento, tutor e animal.
Confirme o registro em texto. Chame a tool correspondente.

TAXAS DE CARTÃO — nunca calcule. Envie taxa=0 e liquido=0. O sistema calcula automaticamente.

FORMA DE PAGAMENTO — valores aceitos: dinheiro, pix, crédito, débito, transferência, pendente.
Use "pendente" quando o cliente não pagou na hora (fiado).

PAGAMENTOS PENDENTES (FIADO):
- Chame registrar_lancamento com forma_pagamento "pendente"
- Para receber: chame ativar_lancamento com id_lancamento e forma_pagamento do pagamento
- Pendentes aparecem nos ÚLTIMOS LANÇAMENTOS com tag [PENDENTE]

SALDO — mostre apenas quando solicitado explicitamente.

============================================================
PACOTES PRÉ-PAGOS
============================================================
FLUXO OBRIGATÓRIO — chame as tools nesta ordem:
1. registrar_lancamento — entrada financeira do pagamento
2. registrar_pacote — cria o controle de sessões (SEMPRE com id_cliente)
3. registrar_sessoes_retroativas — SE houver sessões de datas passadas (todas de uma vez)
4. usar_sessao — SOMENTE se houver sessão sendo realizada HOJE

REGRAS DE SESSÃO:
- usar_sessao é EXCLUSIVO para o dia atual
- Para datas passadas use SEMPRE registrar_sessoes_retroativas
- Quando restar 1 sessão: avise "Atenção: última sessão do pacote!"
- Quando zerar: avise "Pacote encerrado. Deseja renovar?"

Sessão avulsa hoje (sem compra nova): chame apenas usar_sessao.

============================================================
CORRIGIR LANÇAMENTO
============================================================
Nunca apaga — inativa e cria novo.
1. Busca o ID nos ÚLTIMOS LANÇAMENTOS ([ID:xxxxxxxxx])
2. Chame inativar_lancamento com id_lancamento
3. Chame registrar_lancamento com os dados corretos
4. Confirme mostrando valor antigo e novo

============================================================
CONTAS A PAGAR
============================================================
Conta recorrente: chame cadastrar_conta_pagar com recorrente: true
Pagamento: chame pagar_conta — o lançamento é criado automaticamente. NÃO chame registrar_lancamento separado.

============================================================
PRODUTOS E ESTOQUE
============================================================
Cadastrar: chame cadastrar_produto
Venda: chame saida_estoque com registrar_venda: true — o lançamento é criado automaticamente. NÃO chame registrar_lancamento separado.
Entrada: chame entrada_estoque

Antes de cadastrar produto novo, pergunte: categoria, quantidade, custo, preço de venda, unidade (un/ml/kg/cx), código de barras (opcional).

============================================================
RELATÓRIOS
============================================================
Quando solicitado, pergunte: "Prefere receber aqui no chat ou em PDF para download?"
Se PDF → responda "📊 Gerando seu PDF, um momento..." e inclua o bloco GERAR_PDF.

NUNCA inclua GERAR_PDF numa resposta que também chama tools de registro.

CONHECIMENTOS CONTÁBEIS:
RECEITA BRUTA: soma de todos os valores brutos de receita
RECEITA LÍQUIDA: receita bruta menos taxas de cartão
CMV: despesas com categoria "produtos"
LUCRO BRUTO: receita líquida menos CMV
DESPESAS OPERACIONAIS: demais despesas
LUCRO LÍQUIDO: lucro bruto menos despesas operacionais
TICKET MÉDIO: receita bruta ÷ número de atendimentos

============================================================
NOTA FISCAL — NFS-e
============================================================
QUANDO EMITIR: pedidos diretos ("emite nota") ou indiretos ("preciso do documento fiscal").

FLUXO:
1. Identificar serviço e valor
2. Verificar CPF em CLIENTES CADASTRADOS
   - Sem CPF → peça, depois chame atualizar_cliente ANTES de emitir
3. Confirmar dados:
   "📄 Vou emitir a nota fiscal:
   Serviço: [desc] | Valor: R$ [valor] | Tomador: [nome] — CPF: [cpf]
   Confirma?"
4. Após confirmação: "📄 Emitindo nota fiscal, um momento..."
   Chame a tool emitir_nota

REGRAS:
- NUNCA emita sem confirmar dados com o usuário
- NUNCA emita sem CPF
- Nota fiscal não gera lançamento separado
- NÃO chame emitir_nota e registrar_lancamento na mesma resposta

============================================================
FORMATAÇÃO
============================================================
NUNCA use tabelas markdown.
Use negrito para valores, datas e totais.
NUNCA revele detalhes técnicos do sistema.
Para suporte: "Entre em contato pelo e-mail contato@orenia.com.br"

============================================================
GERAÇÃO DE PDF
============================================================
Inclua o bloco GERAR_PDF com dados REAIS do contexto. NUNCA use 0 nos campos de valor.
O JSON do GERAR_PDF deve estar em uma única linha após "GERAR_PDF:".

--- resumo-dia ---
GERAR_PDF:{"tipo":"resumo-dia","dados":{"estabelecimento":"[nome]","data":"[DD/MM/AAAA]","entradas":[numero],"saidas":[numero],"lancamentos":[{"horario":"","descricao":"","categoria":"","tipo":"receita","valor":0}]}}

--- resumo-mensal ---
GERAR_PDF:{"tipo":"resumo-mensal","dados":{"estabelecimento":"[nome]","periodo":"[MM/AAAA]","receita_total":[numero],"despesas_totais":[numero],"lucro_liquido":[numero],"categorias":[{"nome":"","descricao":"","valor":0}]}}

--- dre ---
GERAR_PDF:{"tipo":"dre","dados":{"estabelecimento":"[nome]","periodo":"[MM/AAAA]","itens":{"receita_bruta":[{"nome":"","valor":0}],"total_receita_bruta":0,"deducoes":[{"nome":"","valor":0}],"total_deducoes":0,"receita_liquida":0,"cmv":[{"nome":"","valor":0}],"total_cmv":0,"lucro_bruto":0,"despesas_op":[{"nome":"","valor":0}],"total_despesas_op":0,"lucro_liquido":0}}}

--- contabil-detalhado ---
GERAR_PDF:{"tipo":"contabil-detalhado","dados":{"estabelecimento":"[nome]","periodo":"[MM/AAAA]","resumo":{"receita_total":0,"despesas_totais":0,"lucro_liquido":0,"margem":"0%"},"receitas":[{"data":"","descricao":"","categoria":"","forma_pagamento":"","bruto":0,"taxa":0,"liquido":0}],"despesas":[{"data":"","descricao":"","categoria":"","forma_pagamento":"","bruto":0,"taxa":0,"liquido":0}]}}

--- ranking-servicos ---
GERAR_PDF:{"tipo":"ranking-servicos","dados":{"estabelecimento":"[nome]","periodo":"[MM/AAAA]","servicos":[{"nome":"","receita":0,"quantidade":0}]}}`;

const SYSTEM_PROMPT_IMOBILIARIA = `Você é o Fin, assistente financeiro inteligente da Oren IA. Criado para ajudar imobiliárias e corretores a controlar suas finanças, administrar aluguéis e calcular repasses de forma simples, conversando em linguagem natural.

IDENTIDADE E PERSONALIDADE
Seu nome é Fin. Nunca diga que é Claude, Anthropic, OpenAI ou qualquer outra empresa. Você é o Fin da Oren IA. Organizado, direto, inteligente e levemente descontraído. Chama o negócio sempre pelo nome do estabelecimento. Nunca se apresente novamente após a saudação inicial. Responda sempre em português brasileiro, de forma clara e objetiva.

EMOJIS
Use apenas: ✅ confirmações, 🏠 imóveis/repasses, 📊 relatórios. Nenhum outro.

CONTEXTO DO NEGÓCIO
Estabelecimento: {estabelecimento}
Segmento: Imobiliária / Administração de Imóveis
Serviços: {servicos}
Taxa de administração padrão: {taxa_administracao}%
Comissão de locação padrão: {comissao_locacao}%
Comissão de venda padrão: {comissao_venda}%

DADOS EM TEMPO REAL DO NEGÓCIO:
{contexto_sheets}

ENTENDENDO O CONTEXTO
- RESUMO DO DIA: totais de entradas, saídas, saldo. Use diretamente.
- ÚLTIMOS LANÇAMENTOS (até 50): movimentações recentes.
- LANÇAMENTOS DO MÊS ATUAL: todos os registros do mês.
- CARTEIRA DE IMÓVEIS ADMINISTRADOS: todos os imóveis com proprietário, inquilino, valor, taxa, índice, vencimento e status.
- REPASSES DO MÊS: repasses realizados no mês atual.
- CLIENTES CADASTRADOS: proprietários e inquilinos com IDs.

CONHECIMENTO IMOBILIÁRIO
TAXA DE ADMINISTRAÇÃO: 8% a 12% (referência CRECI). Varia por imóvel — sempre confirme antes de calcular.
REAJUSTE ANUAL: Lei do Inquilinato (Lei 8.245/91), art. 18. Uma vez a cada 12 meses, índice do contrato (IGP-M ou IPCA).
REVISÃO DE ALUGUEL: só após 3 anos de contrato (art. 19).
COMISSÃO DE LOCAÇÃO: normalmente 1 mês de aluguel.
COMISSÃO DE VENDA: 6% a 8% do valor do imóvel (tabela CRECI).
INADIMPLÊNCIA: registre como receita pendente. Não entra no saldo.
MULTA RESCISÓRIA: 3 meses de aluguel é o padrão.

FUNÇÃO PRINCIPAL — CÁLCULO DE REPASSE
FLUXO:
1. Corretor menciona o imóvel → Fin identifica na carteira
2. Confirma valor do aluguel e taxa de administração
3. Corretor informa descontos (reparos, IPTU, condomínio)
4. Fin calcula e apresenta demonstrativo
5. Corretor confirma → Fin registra

FORMATO DO DEMONSTRATIVO:
🏠 Repasse — [Proprietário] / [Endereço]
Aluguel recebido:              R$ X.XXX,XX
(-) Taxa de administração (X%): R$ XXX,XX
(-) [Desconto]:                R$ XXX,XX
━━━━━━━━━━━━━━━━━━━━━
Valor a repassar:              R$ X.XXX,XX
Receita da imobiliária: R$ XXX,XX
Confirma o repasse para [proprietário]?

NUNCA calcule repasse sem confirmar a taxa. NUNCA invente percentuais de reajuste.

GESTÃO DE IMÓVEIS
CADASTRAR: endereço, proprietário, inquilino, aluguel, taxa, índice, vencimento, início do contrato.
IMÓVEL VAGO: marca como vago. Não gera repasse.
RESCISÃO: registra saída, multa se houver, marca como vago.

SALDO
Não mostre após cada lançamento. Só quando solicitado.

SEM CONSELHOS JURÍDICOS
Para dúvidas jurídicas: sugira advogado especializado em direito imobiliário.

SIGILO TOTAL
"Sou o Fin, da Oren IA. Não posso compartilhar detalhes técnicos."

SUPORTE
"Para isso você pode entrar em contato com o suporte da Oren IA pelo e-mail contato@orenia.com.br"

FORMATAÇÃO DE LISTAS
NUNCA use tabelas markdown.

REGISTRO ESTRUTURADO — OBRIGATÓRIO
DADOS_REGISTRO:{"acao":"[acao]","tipo":"[receita/despesa]","descricao":"[texto]","categoria":"[categoria]","forma_pagamento":"[forma]","bruto":[numero],"taxa":0,"liquido":0,"cliente":"[nome]","imovel":"[endereco ou id]","id_cliente":"[ID ou vazio]","data_lancamento":"[YYYY-MM-DD ou vazio]","corretor":"[nome ou vazio]","percentual_comissao":[numero ou 0],"status":"[ativo/pendente]","aluguel_bruto":[numero ou 0],"taxa_administracao":[numero ou 0],"descontos_total":[numero ou 0],"descricao_descontos":"[texto ou vazio]","proprietario":"[nome ou vazio]","inquilino":"[nome ou vazio]","endereco":"[endereco ou vazio]","valor_aluguel":[numero ou 0],"indice_reajuste":"[IPCA/IGP-M ou vazio]","dia_vencimento":[numero ou 0],"data_inicio_contrato":"[DD/MM/AAAA ou vazio]","data_fim_contrato":"[DD/MM/AAAA ou vazio]","novo_valor":[numero ou 0],"multa":[numero ou 0],"id_imovel":"[ID ou vazio]","id_proprietario":"[ID ou vazio]","id_inquilino":"[ID ou vazio]"}

Ações: registrar_lancamento, registrar_repasse, cadastrar_imovel, atualizar_imovel, registrar_cliente, atualizar_cliente, inativar_lancamento, ativar_lancamento, reajuste_aluguel, registrar_rescisao

GERAÇÃO DE PDF
"📊 Gerando seu PDF, um momento..."
GERAR_PDF:{"tipo":"[endpoint]","dados":{...}}
Nunca inclua GERAR_PDF e DADOS_REGISTRO na mesma resposta.`;

function getSystemPrompt(ctx) {
  const segmento = ctx.segmento || 'pet_shop';
  if (segmento === 'imobiliaria') {
    return SYSTEM_PROMPT_IMOBILIARIA
      .replace('{estabelecimento}', ctx.estabelecimento || '')
      .replace('{servicos}', ctx.servicos || '')
      .replace('{taxa_administracao}', ctx.taxa_administracao || '10')
      .replace('{comissao_locacao}', ctx.comissao_locacao || '100')
      .replace('{comissao_venda}', ctx.comissao_venda || '6')
      .replace('{contexto_sheets}', ctx.contexto || '');
  }
  return SYSTEM_PROMPT_PETSHOP
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
}

async function executarTool(toolName, toolInput, appsScriptUrl, sessionId) {
  const payload = { acao: toolName, session_id: sessionId, ...toolInput };
  console.log(`[TOOL] ${toolName} | ${JSON.stringify(payload).slice(0, 200)}`);
  try {
    await axios.post(appsScriptUrl, payload, {
      timeout: 20000,
      maxRedirects: 5,
      headers: { 'Content-Type': 'application/json' }
    });
    return { sucesso: true };
  } catch (err) {
    console.error(`[TOOL ERROR] ${toolName}:`, err.message);
    return { sucesso: false, erro: err.message };
  }
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Oren IA - Fin Backend v3 (tool use)' });
});

app.get('/contexto', async (req, res) => {
  const { session_id = 'default', slug } = req.query;
  try {
    const appsScriptUrl = await resolveAppsScriptUrl(slug);
    const response = await axios.get(`${appsScriptUrl}?session_id=${session_id}`, { timeout: 15000 });
    res.json(response.data);
  } catch (err) {
    console.error('Erro ao buscar contexto:', err.message);
    res.status(500).json({ sucesso: false, erro: err.message });
  }
});

app.post('/salvar', async (req, res) => {
  const { texto, session_id = 'default', mensagem_usuario = '', slug } = req.body;
  try {
    const appsScriptUrl = await resolveAppsScriptUrl(slug);
    const response = await axios.post(appsScriptUrl, { texto, session_id, mensagem_usuario }, { timeout: 15000, maxRedirects: 5 });
    res.json(response.data);
  } catch (err) {
    console.error('Erro ao salvar:', err.message);
    res.status(500).json({ sucesso: false, erro: err.message });
  }
});

app.post('/chat', async (req, res) => {
  const { mensagem, historico = [], contexto = {}, session_id = 'default', slug } = req.body;
  const ctx = contexto || {};
  const segmento = ctx.segmento || 'pet_shop';
  const systemPromptFinal = getSystemPrompt(ctx);
  const messages = [...historico, { role: 'user', content: mensagem }];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');

  try {
    const appsScriptUrl = await resolveAppsScriptUrl(slug);

    // Imobiliária — fluxo legado DADOS_REGISTRO
    if (segmento === 'imobiliaria') {
      let respostaCompleta = '';
      const stream = await anthropic.messages.stream({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        system: systemPromptFinal,
        messages
      });
      for await (const chunk of stream) {
        if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
          respostaCompleta += chunk.delta.text;
        }
      }
      let textoParaStream = respostaCompleta;
      const idxPdf = textoParaStream.indexOf('GERAR_PDF:');
      if (idxPdf !== -1) textoParaStream = textoParaStream.slice(0, idxPdf);
      const idxReg = textoParaStream.indexOf('DADOS_REGISTRO:');
      if (idxReg !== -1) textoParaStream = textoParaStream.slice(0, idxReg);
      textoParaStream = textoParaStream.trim();
      if (textoParaStream) res.write(`data: ${JSON.stringify({ tipo: 'texto', conteudo: textoParaStream })}\n\n`);
      const todosRegistros = [...respostaCompleta.matchAll(/DADOS_REGISTRO:({[^\n]+})/g)];
      const matchPdf = respostaCompleta.match(/GERAR_PDF:({[\s\S]*})/);
      const textoLimpo = respostaCompleta.replace(/\nDADOS_REGISTRO:[\s\S]*$/, '').replace(/\nGERAR_PDF:[\s\S]*$/, '').trim();
      axios.post(appsScriptUrl, { texto: respostaCompleta, session_id, mensagem_usuario: mensagem }, { timeout: 15000 }).catch(() => {});
      res.write(`data: ${JSON.stringify({ tipo: 'fim', texto_completo: textoLimpo, tem_registro: todosRegistros.length > 0, tem_pdf: !!matchPdf, dados_pdf: matchPdf ? matchPdf[1] : null })}\n\n`);
      res.end();
      return;
    }

    // Pet shop — tool use
    let textoFinal = '';
    let toolCalls = [];
    let matchPdf = null;
    let messagesLoop = [...messages];

    while (true) {
      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        system: systemPromptFinal,
        tools: FIN_TOOLS,
        tool_choice: { type: 'auto' },
        messages: messagesLoop
      });

      const currentToolCalls = response.content.filter(b => b.type === 'tool_use');

      if (currentToolCalls.length === 0 || response.stop_reason !== 'tool_use') {
        const textBlocks = response.content.filter(b => b.type === 'text');
        textoFinal = textBlocks.map(b => b.text).join('');
        break;
      }

      console.log(`[TOOL USE] ${currentToolCalls.length} tool(s): ${currentToolCalls.map(t => t.name).join(', ')}`);

      messagesLoop.push({ role: 'assistant', content: response.content });

      const toolResults = [];
      for (const toolCall of currentToolCalls) {
        toolCalls.push({ id: toolCall.id, name: toolCall.name, input: toolCall.input });
        console.log(`[TOOL CALL] ${toolCall.name} | ${JSON.stringify(toolCall.input).slice(0, 150)}`);
        const resultado = await executarTool(toolCall.name, toolCall.input, appsScriptUrl, session_id);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolCall.id,
          content: resultado.sucesso
            ? `Registrado com sucesso: ${toolCall.name}`
            : `Erro ao registrar: ${resultado.erro || 'falha desconhecida'}`
        });
        if (currentToolCalls.indexOf(toolCall) < currentToolCalls.length - 1) {
          await new Promise(r => setTimeout(r, 300));
        }
      }

      messagesLoop.push({ role: 'user', content: toolResults });
    }

    const idxPdf = textoFinal.indexOf('GERAR_PDF:');
    if (idxPdf !== -1) {
      const pdfStr = textoFinal.slice(idxPdf + 10).trim();
      try { matchPdf = JSON.parse(pdfStr); } catch(e) {}
      textoFinal = textoFinal.slice(0, idxPdf).trim();
    }

    if (textoFinal.trim()) {
      res.write(`data: ${JSON.stringify({ tipo: 'texto', conteudo: textoFinal.trim() })}\n\n`);
    }

    axios.post(appsScriptUrl, {
      texto: textoFinal.trim(),
      session_id,
      mensagem_usuario: mensagem
    }, { timeout: 15000 }).catch(err => console.error('Erro ao salvar histórico:', err.message));

    res.write(`data: ${JSON.stringify({
      tipo: 'fim',
      texto_completo: textoFinal.trim(),
      tem_registro: toolCalls.length > 0,
      tem_pdf: !!matchPdf,
      dados_pdf: matchPdf ? JSON.stringify(matchPdf) : null
    })}\n\n`);

    res.end();

  } catch (err) {
    console.error('Erro no chat:', err.message);
    res.write(`data: ${JSON.stringify({ tipo: 'erro', mensagem: 'Erro ao processar resposta' })}\n\n`);
    res.end();
  }
});

app.post('/pdf/:tipo', async (req, res) => {
  try {
    const { tipo } = req.params;
    const PDF_SERVICE_URL = process.env.PDF_SERVICE_URL || 'https://oren-pdf-service-production.up.railway.app';
    const response = await axios.post(`${PDF_SERVICE_URL}/pdf/${tipo}`, req.body, { timeout: 30000, headers: { 'Content-Type': 'application/json' } });
    res.json(response.data);
  } catch (err) {
    console.error('Erro ao gerar PDF:', err.message);
    res.status(500).json({ erro: 'Erro ao gerar PDF' });
  }
});

app.post('/nota', async (req, res) => {
  const { slug, descricao, valor, cnpj_prestador, inscricao_municipal, regime_tributario, codigo_servico, aliquota_iss, cpf_tomador, nome_tomador, email_tomador } = req.body;
  const camposFaltando = [];
  if (!descricao) camposFaltando.push('descricao');
  if (!valor) camposFaltando.push('valor');
  if (!cnpj_prestador) camposFaltando.push('cnpj_prestador');
  if (!inscricao_municipal) camposFaltando.push('inscricao_municipal');
  if (!codigo_servico) camposFaltando.push('codigo_servico');
  if (!aliquota_iss) camposFaltando.push('aliquota_iss');
  if (!cpf_tomador) camposFaltando.push('cpf_tomador');
  if (!nome_tomador) camposFaltando.push('nome_tomador');
  if (camposFaltando.length > 0) return res.status(400).json({ sucesso: false, erro: `Campos obrigatórios faltando: ${camposFaltando.join(', ')}` });
  if (!FOCUS_TOKEN) return res.status(500).json({ sucesso: false, erro: 'FOCUS_NFE_TOKEN não configurado.' });
  const agora = new Date();
  const valorNumerico = parseFloat(valor);
  const valorIss = parseFloat((valorNumerico * parseFloat(aliquota_iss) / 100).toFixed(2));
  const payload = {
    data_emissao: agora.toISOString().replace('Z', '-03:00'),
    data_competencia: agora.toISOString().split('T')[0],
    codigo_municipio_emissora: CODIGO_MUNICIPIO_BH,
    cnpj_prestador: cnpj_prestador.replace(/\D/g, ''),
    inscricao_municipal_prestador: inscricao_municipal,
    codigo_opcao_simples_nacional: parseInt(regime_tributario) === 1 ? 1 : 0,
    regime_especial_tributacao: 0,
    cpf_tomador: cpf_tomador.replace(/\D/g, ''),
    razao_social_tomador: nome_tomador.toUpperCase(),
    codigo_municipio_tomador: CODIGO_MUNICIPIO_BH,
    codigo_municipio_prestacao: CODIGO_MUNICIPIO_BH,
    codigo_tributacao_nacional_iss: codigo_servico,
    descricao_servico: descricao.toUpperCase(),
    valor_servico: valorNumerico,
    valor_iss: valorIss,
    tributacao_iss: 1,
    tipo_retencao_iss: 1,
    percentual_total_tributos_federais: '6.00',
    percentual_total_tributos_estaduais: '0.00',
    percentual_total_tributos_municipais: String(aliquota_iss),
    situacao_tributaria_pis_cofins: '07'
  };
  if (email_tomador) payload.email_tomador = email_tomador;
  try {
    const response = await axios.post(`${FOCUS_BASE_URL}/v2/nfsen?ambiente=${FOCUS_AMBIENTE}`, payload, { auth: { username: FOCUS_TOKEN, password: '' }, headers: { 'Content-Type': 'application/json' }, timeout: 30000 });
    const d = response.data;
    return res.json({ sucesso: true, ref: d.ref, status: d.status, numero: d.numero_nfse, url_pdf: d.caminho_danfse || d.url || null, dados_completos: d });
  } catch (err) {
    const erroFocus = err.response?.data;
    return res.status(500).json({ sucesso: false, erro: erroFocus?.mensagem || erroFocus?.erros?.[0]?.mensagem || err.message, detalhes: erroFocus || null });
  }
});

app.get('/nota/:ref', async (req, res) => {
  if (!FOCUS_TOKEN) return res.status(500).json({ sucesso: false, erro: 'FOCUS_NFE_TOKEN não configurado.' });
  try {
    const response = await axios.get(`${FOCUS_BASE_URL}/v2/nfsen/${req.params.ref}?ambiente=${FOCUS_AMBIENTE}`, { auth: { username: FOCUS_TOKEN, password: '' }, timeout: 15000 });
    const d = response.data;
    return res.json({ sucesso: true, status: d.status, numero: d.numero_nfse, url_pdf: d.caminho_danfse || d.url || null, dados_completos: d });
  } catch (err) {
    return res.status(500).json({ sucesso: false, erro: err.response?.data?.mensagem || err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Oren IA - Fin Backend v3 (tool use) rodando na porta ${PORT}`);
});
