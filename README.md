# Shopify Sales Reports - Sistema Automatico de Reportes

Sistema completo para generar reportes automáticos de ventas de Shopify con análisis avanzado de inventario, métricas de conversión, análisis ABC y detección de stock muerto.

## Características Principales

- **Reportes Automáticos**: Diarios, semanales y mensuales
- **Email Automático**: Envío programado vía Resend
- **Análisis Completo**: ABC Analysis, ROP (Reorder Point), Dead Stock
- **Inventario Preciso**: Sistema corregido para location múltiples
- **Métricas de Conversión**: Por canal de venta
- **Gráficos Dinámicos**: Visualización de datos de venta
- **Debug Tools**: Herramientas para diagnosticar problemas de inventario

## Estructura del Proyecto

```
shopify-reports-vercel/
├── api/
│   ├── sales-report.js          # Motor principal de reportes
│   ├── send-sales-email.js      # Sistema de email via Resend
│   ├── debug-inventory.js       # Debug de inventario
│   └── cron/
│       └── smart-report.js      # Cron job automatico
├── package.json
├── vercel.json                  # Configuración Vercel + Cron
└── README.md
```

## Instalación y Setup

### 1. Clonar el Repositorio
```bash
git clone https://github.com/tu-usuario/shopify-reports-vercel.git
cd shopify-reports-vercel
npm install
```

### 2. Variables de Entorno

Configura estas variables en Vercel Dashboard → Settings → Environment Variables:

**Shopify (Requeridas):**
```
SHOPIFY_SHOP=tu-tienda.myshopify.com
SHOPIFY_ADMIN_TOKEN=shpat_xxxxxxxxxxxxx
```

**Email (Resend):**
```
RESEND_API_KEY=re_xxxxxxxxxxxxx
FROM_EMAIL=reports@tu-dominio.com
REPLY_TO_EMAIL=tu-email@gmail.com
```

**Configuración Reports (Opcionales):**
```
DEAD_STOCK_DAYS=90
ROP_LEAD_DAYS=7
ROP_SAFETY_DAYS=3
```

### 3. Deploy en Vercel
```bash
vercel --prod
```

## Uso del Sistema

### Reportes Manuales

**Reporte Diario:**
```
https://tu-proyecto.vercel.app/api/sales-report?period=daily
```

**Reporte de Hoy:**
```
https://tu-proyecto.vercel.app/api/sales-report?period=daily&today=1
```

**Reporte Semanal:**
```
https://tu-proyecto.vercel.app/api/sales-report?period=weekly
```

**Reporte Mensual:**
```
https://tu-proyecto.vercel.app/api/sales-report?period=monthly
```

### Opciones de Inventario

**Solo location activas (default):**
```
https://tu-proyecto.vercel.app/api/sales-report?period=daily&include_all_locations=0
```

**Todas las location (inventario global):**
```
https://tu-proyecto.vercel.app/api/sales-report?period=daily&include_all_locations=1
```

### Debug de Inventario

**Por SKU:**
```
https://tu-proyecto.vercel.app/api/debug-inventory?sku=ABC123
```

**Por Barcode:**
```
https://tu-proyecto.vercel.app/api/debug-inventory?barcode=123456789
```

**Ver todas las location:**
```
https://tu-proyecto.vercel.app/api/debug-inventory?show_locations=true
```

### Email Automático

**Envío manual POST a /api/send-sales-email:**
```json
{
  "period": "daily",
  "recipients": ["email1@ejemplo.com", "email2@ejemplo.com"],
  "today": false,
  "testMode": false,
  "customMessage": "Mensaje personalizado opcional"
}
```

## Cron Jobs

El sistema está configurado para enviar reportes automáticamente:

**Horario**: 8:30 AM (Monterrey, México) todos los días
- Vercel usa UTC, por lo que está configurado como `30 14 * * *` (14:30 UTC = 8:30 AM CST)

**Configuración en vercel.json:**
```json
{
  "crons": [
    {
      "path": "/api/cron/smart-report",
      "schedule": "30 14 * * *"
    }
  ]
}
```

### Solución de Problemas de Cron

Si el cron no funciona:

1. **Verificar en Vercel Dashboard:**
   - Functions → Cron Jobs
   - Revisar logs de ejecución

2. **Crear archivo cron manualmente:**
   - Crear `/api/cron/smart-report.js`
   - Implementar lógica de envío automático

3. **Test manual del cron:**
   ```
   https://tu-proyecto.vercel.app/api/cron/smart-report
   ```

## Análisis Incluidos

### 1. Análisis ABC (Regla 80/20)
- **Categoria A**: Top performers (80% ingresos)
- **Categoria B**: Productos medianos (15% ingresos)  
- **Categoria C**: Cola larga (5% ingresos)

### 2. Dead Stock Detection
- Productos sin ventas en X días (configurable)
- Valor total de inventario estancado
- Recomendaciones de liquidación

### 3. ROP (Reorder Point) Analysis
- Cálculo de punto de reorden
- Urgencia por producto (Critical/Alto/Medio)
- Cobertura de días de stock
- Cantidades recomendadas a comprar

### 4. Métricas de Conversión
- Conversion rate por canal
- AOV (Average Order Value)
- Sesiones estimadas

### 5. Gráficos Visuales
- Canales de venta
- Tipos de pago (Cash, PayPal, Fiserv POS, etc.)
- Horarios de venta
- Rangos de ticket

## Configuración Avanzada

### Parámetros Configurables via Environment Variables

```bash
# Dead Stock Detection (días sin ventas)
DEAD_STOCK_DAYS=90  # Recomendado para farmacia: 90-120 días

# ROP Analysis
ROP_LEAD_DAYS=7     # Tiempo de entrega proveedor
ROP_SAFETY_DAYS=3   # Stock de seguridad

# Email Settings
FROM_EMAIL=reports@tu-dominio.com
REPLY_TO_EMAIL=manager@tu-empresa.com
```

### Cache System

El sistema incluye cache inteligente:
- **Reportes de hoy**: Cache 3 minutos
- **Reportes diarios**: Cache 10 minutos  
- **Reportes semanales**: Cache 30 minutos
- **Reportes mensuales**: Cache 1 hora

## API Endpoints

| Endpoint | Método | Descripción |
|----------|--------|-------------|
| `/api/sales-report` | GET | Reporte principal |
| `/api/send-sales-email` | POST | Envío de email |
| `/api/debug-inventory` | GET | Debug inventario |
| `/api/cron/smart-report` | GET | Cron automático |

## Tipos de Pago Detectados

El sistema reconoce automáticamente:

- **Efectivo**: Solo cash
- **PayPal**: Solo PayPal
- **Terminal Fiserv**: Solo Fiserv POS  
- **Tarjeta (Shopify)**: Shopify Payments
- **Mercado Pago**: Mercado Pago
- **Mixto**: Combinaciones (Cash + Terminal, etc.)

## Troubleshooting

### Problemas Comunes

**1. Inventario muestra 0 pero hay stock:**
```bash
# Debug específico por SKU
curl "https://tu-proyecto.vercel.app/api/debug-inventory?sku=ABC123"

# Comparar métodos
curl "https://tu-proyecto.vercel.app/api/debug-inventory?compare_methods=true"
```

**2. Email no llega:**
- Verificar variables RESEND_API_KEY y FROM_EMAIL
- Revisar logs en Vercel Functions
- Test manual: POST a `/api/send-sales-email`

**3. Cron no funciona:**
- Verificar configuración en vercel.json
- Revisar Vercel Dashboard → Functions → Cron Jobs
- Test manual del endpoint cron

**4. Performance lenta:**
- El sistema usa llamadas individuales por variant para precisión
- Considerar implementar cache adicional para reportes frecuentes

### Debug Mode

Activar modo debug añadiendo `&debug=1` a cualquier URL:
```
https://tu-proyecto.vercel.app/api/sales-report?period=daily&debug=1
```

## Contribuir

1. Fork el repositorio
2. Crear branch feature (`git checkout -b feature/nueva-caracteristica`)
3. Commit cambios (`git commit -m 'Añadir nueva característica'`)
4. Push al branch (`git push origin feature/nueva-caracteristica`)
5. Crear Pull Request

## Licencia

MIT License - Ver archivo LICENSE para detalles.

## Soporte

Para problemas o preguntas:
1. Crear issue en GitHub
2. Revisar logs en Vercel Dashboard
3. Usar herramientas de debug incluidas

---

**Desarrollado para farmacias y retail con análisis avanzado de inventario y ventas automático.**
