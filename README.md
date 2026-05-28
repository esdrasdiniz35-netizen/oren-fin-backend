# Oren IA — Fin Backend

Backend do assistente financeiro Fin da Oren IA.

## Stack
- Node.js + Express
- Anthropic Claude API (streaming SSE)
- Google Apps Script (banco de dados)

## Variáveis de ambiente (Railway)

```
ANTHROPIC_API_KEY=sk-ant-api03-...
APPS_SCRIPT_URL=https://script.google.com/macros/s/SEU_ID/exec
PDF_SERVICE_URL=https://oren-pdf-service-production.up.railway.app
FRONTEND_URL=https://seu-frontend.vercel.app
PORT=3001
```

## Endpoints

- `GET /health` — health check
- `GET /contexto?session_id=xxx` — busca contexto do cliente no Sheets
- `POST /chat` — chat com streaming SSE
- `POST /salvar` — salva histórico no Sheets
- `POST /pdf/:tipo` — proxy pro PDF service

## Deploy

Conectar repositório no Railway e configurar variáveis de ambiente.
