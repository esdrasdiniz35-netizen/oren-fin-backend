require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3001;

const MASTER_SPREADSHEET_ID = process.env.MASTER_SPREADSHEET_ID;

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

app.use(cors({
  origin: function(origin, callback) {
    const allowed = [
      process.env.FRONTEND_URL,
      'http://localhost:5173',
      'http://localhost:3000',
      'https://oren-fin-frontend.vercel.app'
    ].filter(Boolean);
    if (!origin || allowed.includes(origin) || /\.orenia\.com\.br$/.test(origin)) {
      callback(null, true);
    } else {
      callback(null, true);
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-client-slug']
}));

app.options('*', cors());
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const APPS_SCRIPT_URL_FALLBACK = process.env.APPS_SCRIPT_URL;

// Focus NFe
const FOCUS_TOKEN = process.env.FOCUS_NFE_TOKEN;
const FOCUS_AMBIENTE = process.env.FOCUS_NFE_AMBIENTE || 'homologacao';
const FOCUS_BASE_URL = 'https://api.focusnfe.com.br';
const CODIGO_MUNICIPIO_BH = 3106200;

async function resolveAppsScriptUrl(slug) {
  if (!slug) return APPS_SCRIPT_URL_FALLBACK;
  try {
    const url = await getAppsScriptUrl(slug);
    console.log(`[resolveAppsScriptUrl] slug=${slug} → ${url}`);
    return url;
  } catch (err) {
    console.error(`[resolveAppsScriptUrl] Erro para slug=${slug}:`, err.message);
    if (slug === 'pethousebh4821') return APPS_SCRIPT_URL_FALLBACK;
    throw err;
  }
}

// ============================================================
// SYSTEM PROMPT — PET SHOP v2
// ============================================================
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

PASSO 1 — Nome do tutor é obrigatório
Se a mensagem não trouxer o nome do tutor, pergunte ANTES de qualquer registro:
"Qual o nome do tutor de [animal]?"
NUNCA envie DADOS_REGISTRO com o campo "cliente" vazio.

PASSO 2 — Verificar na lista CLIENTES CADASTRADOS
- Tutor não existe na lista → novo cliente, cadastra normalmente
- Tutor existe com o mesmo pet → mesmo cliente, use o id_cliente existente
- Tutor existe mas com pet diferente → mesmo tutor, pet novo. Use o id_cliente existente do tutor.
- Mais de um tutor com o mesmo nome → pergunte qual é o correto ANTES de registrar:
  "Encontrei mais de um(a) [Nome] cadastrado(a). É o(a) tutor(a) de [animal existente] ou é um(a) novo(a)?"

PASSO 3 — Sempre inclua id_cliente quando o tutor já existir
NUNCA deixe id_cliente vazio se o tutor já está na lista. Isso evita duplicatas.

NUNCA assuma que dois tutores com o mesmo nome são a mesma pessoa sem confirmar.

============================================================
REGISTRAR RECEITA E DESPESA
============================================================
Interprete a mensagem, identifique serviço/produto, valor, forma de pagamento, tutor e animal.
Confirme o registro sem mostrar saldo.

TAXAS DE CARTÃO — nunca calcule você mesmo. O campo "taxa" e "liquido" no DADOS_REGISTRO devem ser sempre 0. O Apps Script calcula automaticamente com base na forma de pagamento.

FORMA DE PAGAMENTO — valores aceitos: dinheiro, pix, crédito, débito, transferência, pendente, fiado.
Use "pendente" quando o cliente não pagou na hora (fiado).

PAGAMENTOS PENDENTES (FIADO):
- Registra com forma_pagamento "pendente" — o valor NÃO entra no saldo
- Para receber o pagamento: use ativar_lancamento com id_lancamento e forma_pagamento do pagamento efetivo
- Pendentes aparecem nos ÚLTIMOS LANÇAMENTOS com tag [PENDENTE]

SALDO — mostre apenas quando solicitado explicitamente.

============================================================
PACOTES PRÉ-PAGOS
============================================================
FLUXO OBRIGATÓRIO ao registrar pacote — sempre nesta ordem:
1. registrar_lancamento — entrada financeira do pagamento
2. registrar_pacote — cria o controle de sessões (SEMPRE com id_cliente preenchido)
3. registrar_sessoes_retroativas — SE houver sessões já realizadas em datas passadas (todas de uma vez em array de strings "DD/MM/AAAA")
4. usar_sessao — SOMENTE se houver sessão sendo realizada HOJE

REGRAS DE SESSÃO:
- usar_sessao é EXCLUSIVO para a sessão do dia atual
- Para datas passadas use SEMPRE registrar_sessoes_retroativas, nunca usar_sessao
- Quando restar 1 sessão: avise "Atenção: última sessão do pacote!"
- Quando zerar: avise "Pacote encerrado. Deseja renovar?"
- NUNCA registre uso de sessão apenas no texto — sempre mande o DADOS_REGISTRO correto

Exemplo — pacote com 2 sessões passadas e 1 hoje:
DADOS_REGISTRO:{"acao":"registrar_lancamento","tipo":"receita","descricao":"Pacote 4 Banhos + 1 Hidratação - Toby","categoria":"servicos_salao","forma_pagamento":"pix","bruto":220,"taxa":0,"liquido":0,"cliente":"Dora","animal":"Toby","id_cliente":"123","data_lancamento":"2026-06-01"}
DADOS_REGISTRO:{"acao":"registrar_pacote","cliente":"Dora","relacionado":"Toby","servico":"4 Banhos + 1 Hidratação","sessoes_total":5,"valor_total":220,"id_cliente":"123","data_lancamento":"2026-06-01"}
DADOS_REGISTRO:{"acao":"registrar_sessoes_retroativas","cliente":"Dora","relacionado":"Toby","servico":"4 Banhos + 1 Hidratação","datas":["18/05/2026","25/05/2026"]}
DADOS_REGISTRO:{"acao":"usar_sessao","cliente":"Dora","relacionado":"Toby","servico":"4 Banhos + 1 Hidratação","data_lancamento":"2026-06-01"}

Exemplo — pacote sem nenhuma sessão ainda:
DADOS_REGISTRO:{"acao":"registrar_lancamento",...}
DADOS_REGISTRO:{"acao":"registrar_pacote",...}

Sessão avulsa hoje (sem compra nova):
DADOS_REGISTRO:{"acao":"usar_sessao","cliente":"Carlos","relacionado":"Jade","servico":"Banho + Hidratação"}

============================================================
CORRIGIR LANÇAMENTO
============================================================
Nunca apaga — apenas marca como INATIVO e cria novo.
1. Busca o lançamento nos ÚLTIMOS LANÇAMENTOS pelo ID [ID:xxxxxxxxx]
2. Manda DOIS blocos: primeiro inativar_lancamento com id_lancamento, depois registrar_lancamento correto
3. Sempre inclua id_lancamento ao inativar. Nunca inativa sem ID.
4. Confirme mostrando valor antigo e novo.
Lançamentos [INATIVO] nos resumos e relatórios devem ser ignorados.

============================================================
CONTAS A PAGAR
============================================================
Conta recorrente (ex: "aluguel todo dia 5, R$ 3.200"):
- Use cadastrar_conta_pagar com recorrente: true
- Confirme: descrição, valor, dia de vencimento, categoria

Pagamento de conta (ex: "paguei o aluguel"):
- Identifique a conta no contexto pela descrição
- Use pagar_conta — o lançamento de despesa é registrado automaticamente
- NÃO registre um lançamento de despesa separado — o pagar_conta já faz isso

============================================================
PRODUTOS E ESTOQUE
============================================================
Cadastrar produto novo:
- Pergunte: nome, categoria, quantidade inicial, custo, preço de venda, unidade (un/kg/ml/cx)
- Código de barras é opcional
- Use cadastrar_produto

Venda de produto:
- Use saida_estoque com registrar_venda: true e os campos: nome, quantidade, preco_venda, forma_pagamento, cliente, id_cliente
- O lançamento de receita é registrado automaticamente pelo sistema
- NÃO registre um registrar_lancamento separado — o saida_estoque já faz isso
- SEMPRE confirme com o cliente ANTES de registrar, igual ao fluxo de qualquer receita

Entrada de estoque:
- Use entrada_estoque com nome, quantidade e custo (opcional)

============================================================
RELATÓRIOS
============================================================
Quando solicitado, pergunte primeiro: "Prefere receber aqui no chat ou em PDF para download?"
Se chat → gera em texto formatado com dados do contexto.
Se PDF → responde com GERAR_PDF e os dados estruturados.

NUNCA inclua GERAR_PDF e DADOS_REGISTRO na mesma resposta.
Se o cliente pedir PDF explicitamente, gere direto sem perguntar.

RESUMO DE SERVIÇOS DO DIA — mostre DOIS blocos separados:
Serviços pagos: valor bruto e forma de pagamento
Sessões de pacote: sem valor, só serviço e animal

CONHECIMENTOS CONTÁBEIS:
RECEITA BRUTA: soma de todos os valores brutos de receita
RECEITA LÍQUIDA: receita bruta menos taxas de cartão
CMV: despesas com categoria "produtos"
LUCRO BRUTO: receita líquida menos CMV
DESPESAS OPERACIONAIS: demais despesas
LUCRO LÍQUIDO: lucro bruto menos despesas operacionais
TICKET MÉDIO: receita bruta ÷ número de atendimentos

NÚMEROS E CÁLCULOS — todos os totais vêm calculados no contexto. Nunca some por conta própria.

============================================================
FUNCIONÁRIOS
============================================================
Cadastra nome, cargo e percentual de comissão.
Calcula comissão por período quando solicitado.

============================================================
AGENDA E LEMBRETES
============================================================
Data sempre YYYY-MM-DD e hora HH:MM.
Recorrência semanal: usar_evento_recorrente — o sistema cria 52 eventos automaticamente.

============================================================
NOTA FISCAL — NFS-e
============================================================
QUANDO EMITIR: reconheça pedidos diretos ("emite nota para Vanessa") ou indiretos ("preciso do documento fiscal").

FLUXO OBRIGATÓRIO:
1. Identificar serviço e valor — se não estiver claro, pergunte
2. Verificar CPF em CLIENTES CADASTRADOS
   - Sem CPF → pergunte, depois atualize com atualizar_cliente ANTES de emitir
3. Confirmar dados SEMPRE antes de emitir:
   "📄 Vou emitir a nota fiscal:
   Serviço: [descrição] | Valor: R$ [valor] | Tomador: [nome] — CPF: [cpf]
   Confirma?"
4. Após confirmação: "📄 Emitindo nota fiscal, um momento..."
   DADOS_REGISTRO:{"acao":"emitir_nota","descricao":"[desc]","valor":[numero],"nome_tomador":"[nome]","cpf_tomador":"[cpf]","id_cliente":"[id]","email_tomador":""}
5. Retorno:
   - Sucesso: "✅ Nota emitida! Número [número]. PDF: [link se houver]."
   - Erro: oriente conforme tabela abaixo

REGRAS:
- NUNCA emita sem confirmar dados com o usuário
- NUNCA emita sem CPF — é obrigatório por lei
- Nota fiscal é apenas o documento — NÃO registre lançamento separado
- emitir_nota e registrar_lancamento NUNCA juntos na mesma resposta
- Atualmente só NFS-e (serviços). NF-e (produtos) é implementação futura.

DIAGNÓSTICO DE ERROS:
Configuração (suporte Oren): "Configuração fiscal incompleta", "empresa_nao_habilitada", "permissao_negada" (403)
Dados do cliente (resolver no chat): "CPF inválido" → peça novo CPF | "razao_social_tomador ausente" → peça nome completo
Dados fiscais (contabilidade): "inscricao_municipal inválida", "codigo_tributacao inválido", "aliquota_iss inválida"
Certificado (contabilidade): "certificado inválido", "Falha no reconhecimento da autoria" (código 202), "CNPJ do certificado difere" (código 213)
Duplicidade: "Duplicidade de NF-e" (código 204) → nota já emitida, não reenvie
Prefeitura instável: "Serviço paralisado" (código 108) → tente novamente em minutos
HTTP 400 = dados incorretos | HTTP 403 = autenticação | HTTP 404 = não encontrado | HTTP 500 = tente novamente

Nota rejeitada: pode ser corrigida e reenviada.
Nota denegada: problema fiscal grave — contate a contabilidade.

============================================================
HISTÓRICO MENSAL
============================================================
Quando o usuário informar dados de meses anteriores (ex: "em março tivemos 280 banhos"):
DADOS_REGISTRO:{"acao":"registrar_historico_mensal","mes":3,"ano":2026,"banhos":280,"consultas":4,"receita_total":18500,"despesas_total":5000}

============================================================
REGISTRO ESTRUTURADO — OBRIGATÓRIO
============================================================
Ao final de CADA resposta que registra algo, inclua o(s) bloco(s) DADOS_REGISTRO necessários.
O JSON deve ser válido, sem quebras de linha, em uma única linha por bloco.
Para consultas não inclua DADOS_REGISTRO.

CAMPOS OBRIGATÓRIOS POR AÇÃO:

registrar_lancamento:
{"acao":"registrar_lancamento","tipo":"receita ou despesa","descricao":"[texto]","categoria":"[categoria]","forma_pagamento":"[forma]","bruto":[numero],"taxa":0,"liquido":0,"cliente":"[nome ou vazio se despesa]","animal":"[nome ou vazio]","id_cliente":"[ID ou vazio]","data_lancamento":"[YYYY-MM-DD ou vazio se hoje]"}

registrar_cliente:
{"acao":"registrar_cliente","nome":"[nome tutor — NUNCA vazio]","relacionado":"[nome pet]","telefone":"[ou vazio]","cpf":"[ou vazio]"}

atualizar_cliente:
{"acao":"atualizar_cliente","id_cliente":"[ID]","nome":"[opcional]","telefone":"[opcional]","relacionado":"[opcional]","cpf":"[opcional]"}

registrar_pacote:
{"acao":"registrar_pacote","cliente":"[nome]","relacionado":"[pet]","servico":"[nome do serviço]","sessoes_total":[numero],"valor_total":[numero],"id_cliente":"[ID — obrigatório]","data_lancamento":"[YYYY-MM-DD ou vazio]"}

usar_sessao:
{"acao":"usar_sessao","cliente":"[nome]","relacionado":"[pet]","servico":"[nome do serviço]","data_lancamento":"[YYYY-MM-DD ou vazio se hoje]"}

registrar_sessoes_retroativas:
{"acao":"registrar_sessoes_retroativas","cliente":"[nome]","relacionado":"[pet]","servico":"[nome do serviço]","datas":["DD/MM/AAAA","DD/MM/AAAA"]}

inativar_lancamento:
{"acao":"inativar_lancamento","id_lancamento":"[ID obrigatório]","descricao":"[opcional]"}

ativar_lancamento:
{"acao":"ativar_lancamento","id_lancamento":"[ID se souber]","descricao":"[ou descrição]","forma_pagamento":"[forma do pagamento efetivo]"}

cadastrar_conta_pagar:
{"acao":"cadastrar_conta_pagar","descricao":"[nome da conta]","valor":[numero],"dia_vencimento":[numero],"recorrente":true,"categoria":"[categoria]"}

pagar_conta:
{"acao":"pagar_conta","descricao":"[nome da conta]","forma_pagamento":"[forma]","data_lancamento":"[YYYY-MM-DD ou vazio]"}

cadastrar_produto:
{"acao":"cadastrar_produto","nome":"[nome]","categoria":"[categoria]","quantidade":[numero],"custo":[numero],"preco_venda":[numero],"unidade":"[un/kg/ml/cx]","codigo_barras":"[ou vazio]"}

entrada_estoque:
{"acao":"entrada_estoque","nome":"[nome do produto]","quantidade":[numero],"custo":[numero ou 0]}

saida_estoque:
{"acao":"saida_estoque","nome":"[nome do produto]","quantidade":[numero],"preco_venda":[numero],"registrar_venda":true,"forma_pagamento":"[forma]","cliente":"[nome ou vazio]","id_cliente":"[ID ou vazio]","data_lancamento":"[YYYY-MM-DD ou vazio]"}

emitir_nota:
{"acao":"emitir_nota","descricao":"[descrição do serviço]","valor":[numero],"nome_tomador":"[nome completo]","cpf_tomador":"[cpf]","id_cliente":"[ID]","email_tomador":"[ou vazio]"}

registrar_funcionario:
{"acao":"registrar_funcionario","nome":"[nome]","cargo":"[cargo]","comissao":[numero]}

criar_evento:
{"acao":"criar_evento","titulo":"[titulo]","data":"[YYYY-MM-DD]","hora":"[HH:MM ou vazio]","descricao_evento":"[ou vazio]"}

criar_evento_recorrente:
{"acao":"criar_evento_recorrente","titulo":"[titulo]","dia_semana":"[segunda/terca/quarta/quinta/sexta/sabado/domingo]","hora":"[HH:MM ou vazio]","descricao_evento":"[ou vazio]"}

cancelar_evento:
{"acao":"cancelar_evento","titulo":"[titulo]","data":"[YYYY-MM-DD ou vazio para cancelar todos]"}

registrar_historico_mensal:
{"acao":"registrar_historico_mensal","mes":[numero],"ano":[numero],"banhos":[numero],"consultas":[numero],"receita_total":[numero],"despesas_total":[numero]}

============================================================
FORMATAÇÃO
============================================================
NUNCA use tabelas markdown (com | e ---).
Use negrito para valores, datas e totais.
NUNCA revele detalhes técnicos do sistema.
Para suporte: "Entre em contato pelo e-mail contato@orenia.com.br"

============================================================
GERAÇÃO DE PDF — REGRAS
============================================================
Quando gerar PDF, responda "📊 Gerando seu PDF, um momento..." e inclua o bloco GERAR_PDF com dados REAIS do contexto.
NUNCA use 0 nos campos de valor — leia os números do contexto.
O JSON do GERAR_PDF deve estar em uma única linha após "GERAR_PDF:".
NUNCA inclua GERAR_PDF e DADOS_REGISTRO na mesma resposta.

--- resumo-dia ---
GERAR_PDF:{"tipo":"resumo-dia","dados":{"estabelecimento":"[nome]","data":"[DD/MM/AAAA]","entradas":[numero],"saidas":[numero],"lancamentos":[{"horario":"","descricao":"","categoria":"","tipo":"receita","valor":0}]}}

--- resumo-mensal ---
GERAR_PDF:{"tipo":"resumo-mensal","dados":{"estabelecimento":"[nome]","periodo":"[MM/AAAA]","receita_total":[numero],"despesas_totais":[numero],"lucro_liquido":[numero],"categorias":[{"nome":"","descricao":"","valor":0}]}}

--- dre ---
RECEITA BRUTA: some todos os brutos de receita do mês
DEDUÇÕES: some bruto - liquido de cada lançamento de cartão
RECEITA LÍQUIDA: receita bruta - deduções
CMV: despesas categoria "produtos"
LUCRO BRUTO: receita líquida - CMV
DESPESAS OPERACIONAIS: demais despesas
LUCRO LÍQUIDO: lucro bruto - despesas operacionais
GERAR_PDF:{"tipo":"dre","dados":{"estabelecimento":"[nome]","periodo":"[MM/AAAA]","itens":{"receita_bruta":[{"nome":"","valor":0}],"total_receita_bruta":0,"deducoes":[{"nome":"","valor":0}],"total_deducoes":0,"receita_liquida":0,"cmv":[{"nome":"","valor":0}],"total_cmv":0,"lucro_bruto":0,"despesas_op":[{"nome":"","valor":0}],"total_despesas_op":0,"lucro_liquido":0}}}

--- contabil-detalhado ---
Taxa crédito = bruto × {taxa_credito} / 100 | Taxa débito = bruto × {taxa_debito} / 100 | Líquido = bruto - taxa
GERAR_PDF:{"tipo":"contabil-detalhado","dados":{"estabelecimento":"[nome]","periodo":"[MM/AAAA]","resumo":{"receita_total":0,"despesas_totais":0,"lucro_liquido":0,"margem":"0%"},"receitas":[{"data":"","descricao":"","categoria":"","forma_pagamento":"","bruto":0,"taxa":0,"liquido":0}],"despesas":[{"data":"","descricao":"","categoria":"","forma_pagamento":"","bruto":0,"taxa":0,"liquido":0}]}}

--- ranking-servicos ---
GERAR_PDF:{"tipo":"ranking-servicos","dados":{"estabelecimento":"[nome]","periodo":"[MM/AAAA]","servicos":[{"nome":"","receita":0,"quantidade":0}]}}`;

// ============================================================
// SYSTEM PROMPT — IMOBILIÁRIA
// ============================================================
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

// ============================================================
// SYSTEM PROMPT DINÂMICO
// ============================================================
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

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Oren IA - Fin Backend' });
});

// ============================================================
// CONTEXTO
// ============================================================
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

// ============================================================
// SALVAR
// ============================================================
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

// ============================================================
// CHAT — STREAMING
// ============================================================
app.post('/chat', async (req, res) => {
  const { mensagem, historico = [], contexto = {}, session_id = 'default', slug } = req.body;
  const ctx = contexto || {};
  const systemPromptFinal = getSystemPrompt(ctx);
  const messages = [...historico, { role: 'user', content: mensagem }];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');

  let respostaCompleta = '';

  try {
    const appsScriptUrl = await resolveAppsScriptUrl(slug);

    const stream = await anthropic.messages.stream({
      model: 'claude-sonnet-4-6',
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

    if (textoParaStream) {
      res.write(`data: ${JSON.stringify({ tipo: 'texto', conteudo: textoParaStream })}\n\n`);
    }

    const todosRegistros = [...respostaCompleta.matchAll(/DADOS_REGISTRO:({[^\n]+})/g)];
    const matchPdf = respostaCompleta.match(/GERAR_PDF:({[\s\S]*})/);

    const textoLimpo = respostaCompleta
      .replace(/\nDADOS_REGISTRO:[\s\S]*$/, '')
      .replace(/\nGERAR_PDF:[\s\S]*$/, '')
      .trim();

    if (matchPdf) {
      console.log(`[PDF] GERAR_PDF detectado: ${matchPdf[1].slice(0, 300)}`);
    }

    axios.post(appsScriptUrl, {
      texto: respostaCompleta,
      session_id,
      mensagem_usuario: mensagem
    }, { timeout: 15000 }).catch(err => console.error('Erro ao salvar histórico:', err.message));

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
// PDF
// ============================================================
app.post('/pdf/:tipo', async (req, res) => {
  try {
    const { tipo } = req.params;
    const PDF_SERVICE_URL = process.env.PDF_SERVICE_URL || 'https://oren-pdf-service-production.up.railway.app';
    console.log(`[PDF] Endpoint: ${tipo} | Body: ${JSON.stringify(req.body).slice(0, 400)}`);
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

// ============================================================
// NOTA FISCAL — emissão via Focus NFe
// ============================================================
app.post('/nota', async (req, res) => {
  const {
    slug,
    descricao,
    valor,
    cnpj_prestador,
    inscricao_municipal,
    regime_tributario,
    codigo_servico,
    aliquota_iss,
    cpf_tomador,
    nome_tomador,
    email_tomador
  } = req.body;

  const camposFaltando = [];
  if (!descricao)           camposFaltando.push('descricao');
  if (!valor)               camposFaltando.push('valor');
  if (!cnpj_prestador)      camposFaltando.push('cnpj_prestador');
  if (!inscricao_municipal)  camposFaltando.push('inscricao_municipal');
  if (!codigo_servico)      camposFaltando.push('codigo_servico');
  if (!aliquota_iss)        camposFaltando.push('aliquota_iss');
  if (!cpf_tomador)         camposFaltando.push('cpf_tomador');
  if (!nome_tomador)        camposFaltando.push('nome_tomador');

  if (camposFaltando.length > 0) {
    return res.status(400).json({
      sucesso: false,
      erro: `Campos obrigatórios faltando: ${camposFaltando.join(', ')}`
    });
  }

  if (!FOCUS_TOKEN) {
    return res.status(500).json({
      sucesso: false,
      erro: 'FOCUS_NFE_TOKEN não configurado. Adicione a variável de ambiente no Railway.'
    });
  }

  const agora = new Date();
  const dataEmissao = agora.toISOString().replace('Z', '-03:00');
  const dataCompetencia = agora.toISOString().split('T')[0];

  const valorNumerico = parseFloat(valor);
  const aliquotaDecimal = parseFloat(aliquota_iss) / 100;
  const valorIss = parseFloat((valorNumerico * aliquotaDecimal).toFixed(2));
  const cpfLimpo = cpf_tomador.replace(/\D/g, '');

  const payload = {
    data_emissao: dataEmissao,
    data_competencia: dataCompetencia,
    codigo_municipio_emissora: CODIGO_MUNICIPIO_BH,
    cnpj_prestador: cnpj_prestador.replace(/\D/g, ''),
    inscricao_municipal_prestador: inscricao_municipal,
    codigo_opcao_simples_nacional: parseInt(regime_tributario) === 1 ? 1 : 0,
    regime_especial_tributacao: 0,
    cpf_tomador: cpfLimpo,
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

  console.log(`[NOTA] Emitindo NFS-e | slug=${slug} | valor=${valor} | tomador=${nome_tomador} | ambiente=${FOCUS_AMBIENTE}`);

  try {
    const response = await axios.post(
      `${FOCUS_BASE_URL}/v2/nfsen?ambiente=${FOCUS_AMBIENTE}`,
      payload,
      {
        auth: { username: FOCUS_TOKEN, password: '' },
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000
      }
    );

    const dadosNota = response.data;
    console.log(`[NOTA] Sucesso | ref=${dadosNota.ref || 'sem ref'} | status=${dadosNota.status}`);

    return res.json({
      sucesso: true,
      ref: dadosNota.ref,
      status: dadosNota.status,
      numero: dadosNota.numero_nfse,
      url_pdf: dadosNota.caminho_danfse || dadosNota.url || null,
      dados_completos: dadosNota
    });

  } catch (err) {
    const erroFocus = err.response?.data;
    console.error('[NOTA] Erro Focus NFe:', JSON.stringify(erroFocus || err.message));
    return res.status(500).json({
      sucesso: false,
      erro: erroFocus?.mensagem || erroFocus?.erros?.[0]?.mensagem || err.message,
      detalhes: erroFocus || null
    });
  }
});

// ============================================================
// NOTA FISCAL — consultar status por ref
// ============================================================
app.get('/nota/:ref', async (req, res) => {
  const { ref } = req.params;

  if (!FOCUS_TOKEN) {
    return res.status(500).json({ sucesso: false, erro: 'FOCUS_NFE_TOKEN não configurado.' });
  }

  try {
    const response = await axios.get(
      `${FOCUS_BASE_URL}/v2/nfsen/${ref}?ambiente=${FOCUS_AMBIENTE}`,
      {
        auth: { username: FOCUS_TOKEN, password: '' },
        timeout: 15000
      }
    );
    const dados = response.data;
    return res.json({
      sucesso: true,
      status: dados.status,
      numero: dados.numero_nfse,
      url_pdf: dados.caminho_danfse || dados.url || null,
      dados_completos: dados
    });
  } catch (err) {
    return res.status(500).json({
      sucesso: false,
      erro: err.response?.data?.mensagem || err.message
    });
  }
});

// ============================================================
// START
// ============================================================
app.listen(PORT, () => {
  console.log(`Oren IA - Fin Backend rodando na porta ${PORT}`);
});
