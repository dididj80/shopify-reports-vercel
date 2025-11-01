# GraphQL Testing Guide

## Overview

Questo progetto ora ha **2 endpoint paralleli**:

- `/api/sales-report` - **PROD** (REST API) ✅
- `/api/sales-report-graphql` - **TEST** (GraphQL API) 🧪

## Come testare

### 1. Test connessione base

```bash
curl "https://your-app.vercel.app/api/sales-report-graphql?period=daily"
```

Risposta attesa:

```json
{
  "success": true,
  "method": "GraphQL",
  "timing": {
    "orders": 1200,
    "processing": 3500,
    "total": 5000
  },
  "stats": {
    "totalProducts": 128,
    "graphqlUsage": "128/128 products"
  },
  "comparison": {
    "expectedRESTTime": "~25s",
    "actualGraphQLTime": "3.5s",
    "speedup": "~7.1x faster"
  }
}
```

### 2. Confronta REST vs GraphQL

**REST (attuale):**

```bash
time curl "https://your-app.vercel.app/api/sales-report?period=monthly"
```

**GraphQL (nuovo):**

```bash
time curl "https://your-app.vercel.app/api/sales-report-graphql?period=monthly"
```

### 3. Verifica dati identici

```javascript
// Script di confronto
const rest = await fetch("/api/sales-report?period=daily&email=1");
const graphql = await fetch("/api/sales-report-graphql?period=daily");

const restData = await rest.json();
const graphqlData = await graphql.json();

// Verifica che i prodotti siano gli stessi
console.log("REST products:", restData.stats.totalProducts);
console.log("GraphQL products:", graphqlData.stats.totalProducts);
console.log(
  "Match:",
  restData.stats.totalProducts === graphqlData.stats.totalProducts
);
```

### 4. Test con debug

```bash
curl "https://your-app.vercel.app/api/sales-report-graphql?period=daily&debug=1"
```

## Differenze

| Aspetto                  | REST           | GraphQL |
| ------------------------ | -------------- | ------- |
| **API calls**            | 128+           | 1-2     |
| **Tempo (128 prodotti)** | 40-50s         | 5-10s   |
| **Tempo (350 prodotti)** | 90-120s        | 15-20s  |
| **Rate limiting**        | Alto           | Basso   |
| **Fallback usage**       | 2-3%           | 0-1%    |
| **Chunking necessario**  | Sì (>300 prod) | No      |

## Quando fare lo switch

### 🟢 Ora - Non fare nulla

- REST funziona perfettamente
- <200 prodotti/mese
- Nessun problema di timeout

### 🟡 Tra 3-6 mesi - Inizia testing

- 200-300 prodotti/mese
- Tempo esecuzione >50s
- Testa GraphQL in parallelo

### 🔴 Quando necessario - Switch

- > 300 prodotti/mese
- Timeout frequenti
- Fai lo switch in produzione

## Come fare lo switch (quando pronto)

### Opzione A: Redirect (più semplice)

```javascript
// api/sales-report.js
export { default } from "./sales-report-graphql.js";
```

### Opzione B: Feature flag (più controllato)

```javascript
// api/sales-report.js
const USE_GRAPHQL = process.env.USE_GRAPHQL === "true";

if (USE_GRAPHQL) {
  // import e usa GraphQL
} else {
  // usa REST (attuale)
}
```

### Opzione C: Graduale per periodo

```javascript
// api/sales-report.js
const period = req.query.period;

if (period === "monthly" && variantIds.length > 250) {
  // usa GraphQL per monthly pesanti
} else {
  // usa REST per tutto il resto
}
```

## Rollback

Se GraphQL ha problemi dopo lo switch:

1. Rimuovi redirect/flag
2. Redeploy (30 secondi)
3. Torna a REST immediatamente
4. Zero data loss

## Files del progetto

```
shopify-reports-vercel/
├── api/
│   ├── sales-report.js           ✅ PROD (REST)
│   ├── sales-report-graphql.js   🧪 TEST (GraphQL)
│   ├── send-sales-email.js
│   ├── debug-inventory.js
│   └── cron/
│       └── smart-report.js
├── lib/
│   └── shopify-graphql.js        🆕 Nuova libreria
├── package.json
├── vercel.json
├── README.md
└── GRAPHQL-TESTING.md            📄 Questo file
```

## Troubleshooting

### GraphQL connection failed

```
Verifica:
- SHOPIFY_SHOP è configurato
- SHOPIFY_ADMIN_TOKEN è valido
- Token ha permessi: read_products, read_inventory
```

### Dati diversi REST vs GraphQL

```
Possibile causa:
- include_all_locations diverso
- Cache attiva solo su REST

Soluzione:
- Aggiungi ?debug=1 per vedere dettagli
- Confronta con cache disabilitata
```

### Performance non migliora

```
Verifica:
- GraphQL effettivamente usato (check _fromGraphQL)
- Numero prodotti sufficiente (>100)
- Network non è il bottleneck
```

## Note finali

- ✅ **GraphQL è PRONTO** ma non attivo in prod
- ✅ **REST continua** a funzionare normalmente
- ✅ **Zero rischi** per prod
- ✅ **Testa quando** hai tempo libero
- ✅ **Switch quando** arrivi a 250-300 prodotti/mese

---

**Created:** Gennaio 2025  
**Version:** 1.0.0  
**Status:** Testing Phase
