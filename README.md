# shopify-reports-vercel
Report giornalieri, settimanali, mensile shopify
# Shopify Reports on Vercel

Report automatici giornalieri, settimanali e mensili via email:
- Tabella prodotti (vendite, inventario, incoming)
- Grafici a torta (POS vs Online, metodi di pagamento)

## Variabili d'ambiente (Vercel → Settings → Environment Variables)
- SHOPIFY_SHOP → es. dermaboutique.myshopify.com
- SHOPIFY_ADMIN_TOKEN → token Admin API (scopes: read_orders, read_products, read_inventory; + read_all_orders per >60gg)
- RESEND_API_KEY → API key Resend (se REPORT_DRYRUN=false)
- REPORT_TO_EMAIL → destinatario
- REPORT_FROM_EMAIL → mittente verificato
- REPORT_DRYRUN → "true" per test senza invio, "false" (o assente) per invio reale
- opz.: REPORT_CURRENCY (default MXN), REPORT_LOCALE (default es-MX)

## Rotte di test
- /api/sales-report?period=daily
- /api/sales-report?period=weekly
- /api/sales-report?period=monthly

Con REPORT_DRYRUN=true: la function risponde JSON e logga anteprima HTML nei Logs.  
Con REPORT_DRYRUN=false: invia la mail tramite Resend.

## Cron (UTC)
- Daily: 06:05
- Weekly: Lunedì 06:10
- Monthly: Giorno 1 06:15
