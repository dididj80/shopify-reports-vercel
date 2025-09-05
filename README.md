# Shopify Sales Reports System

Sistema completo de reportes automáticos de ventas para tiendas Shopify con análisis avanzado de inventario, notificaciones por email y dashboard interactivo.

## Características Principales

### 📊 Análisis de Ventas
- **Reportes Periódicos**: Diarios, semanales y mensuales
- **Análisis ABC**: Clasificación de productos por regla 80/20
- **Breakdown por Location**: Ventas por tienda física vs online
- **Conversion Rate**: Análisis por canal de venta
- **Métodos de Pago**: Desglose detallado (efectivo, tarjeta, PayPal, etc.)

### 📦 Gestión de Inventario
- **Stock Crítico**: Alertas automáticas para productos sin stock o con 1 unidad
- **Dead Stock Detection**: Productos sin ventas en 60+ días
- **Reorder Point (ROP)**: Cálculo automático de puntos de reorden
- **Inventario Multi-location**: Soporte para múltiples ubicaciones

### 📧 Notificaciones Automáticas
- **Emails Programados**: Envío automático vía Mailgun
- **Templates Responsivos**: Optimizados para email y web
- **Adjuntos HTML**: Reportes completos con gráficos interactivos
- **Personalización**: Mensajes custom por reporte

### 📈 Dashboard Interactivo
- **Gráficos SVG**: Donut charts responsivos
- **Tablas Dinámicas**: Filtrado y ordenamiento avanzado
- **Cache Inteligente**: Sistema de cache para mejor performance
- **Responsive Design**: Optimizado para móvil y desktop

## Arquitectura del Sistema

```
/api/
├── sales-report.js          # Generador principal de reportes
├── send-sales-email.js      # Sistema de envío de emails
├── debug-inventory.js       # Herramientas de debug
└── cron/
    └── smart-report.js      # Cron job automático
```

## Instalación y Configuración

### 1. Variables de Entorno

Crea un archivo `.env.local` con las siguientes variables:

```env
# Shopify Configuration
SHOPIFY_SHOP=tu-tienda.myshopify.com
SHOPIFY_ADMIN_TOKEN=shpat_xxxxxxxxxxxxx

# Mailgun Configuration
MAILGUN_API_KEY=key-xxxxxxxxxxxxxxxx
MAILGUN_DOMAIN=mg.tudominio.com
MAILGUN_FROM=noreply@mg.tudominio.com
MAILGUN_BASE_URL=https://api.mailgun.net

# Email Recipients
SALES_REPORT_RECIPIENTS=email1@tudominio.com,email2@tudominio.com

# Cron Security
CRON_SECRET=tu-secreto-seguro-aqui

# Optional Settings
REPLY_TO_EMAIL=admin@tudominio.com
DEAD_STOCK_DAYS=90
ROP_LEAD_DAYS=7
ROP_SAFETY_DAYS=3
```

### 2. Configuración de Shopify

1. **Crear Private App**:
   - Ve a Shopify Admin → Apps → App and sales channel settings
   - Click "Develop apps" → "Create an app"
   - Configura permisos: `read_orders`, `read_products`, `read_inventory`, `read_locations`

2. **Configurar Webhook** (opcional):
   - Para notificaciones en tiempo real de stock bajo

### 3. Configuración de Mailgun

1. **Añadir Dominio**:
   - Crea un subdominio (ej: `mg.tudominio.com`)
   - Configura records DNS (SPF, DKIM, MX)

2. **Generar API Key**:
   - Crea una Sending Key específica para el dominio

### 4. Deploy en Vercel

```bash
# Clona el repositorio
git clone https://github.com/tu-usuario/shopify-reports-vercel.git
cd shopify-reports-vercel

# Instala dependencias
npm install

# Deploy en Vercel
vercel

# Configura variables de entorno en Vercel Dashboard
```

## Uso del Sistema

### Endpoints Principales

#### 📊 Generar Reportes
```
GET /api/sales-report
```

**Parámetros:**
- `period`: `daily` | `weekly` | `monthly`
- `today`: `1` (para datos del día actual)
- `email`: `1` (formato email)
- `preview`: `1` (preview del email)
- `include_all_locations`: `1` (incluir locations inactivas)

**Ejemplos:**
```
/api/sales-report?period=daily                    # Reporte ayer
/api/sales-report?period=daily&today=1            # Reporte hoy
/api/sales-report?period=weekly                   # Reporte semanal
/api/sales-report?period=monthly                  # Reporte mensual
/api/sales-report?period=daily&preview=1          # Preview email
```

#### 📧 Enviar Emails
```
POST /api/send-sales-email
```

**Body:**
```json
{
  "period": "daily",
  "recipients": ["admin@tudominio.com"],
  "today": false,
  "customMessage": "Mensaje personalizado",
  "testMode": false
}
```

#### 🛠 Debug Inventario
```
GET /api/debug-inventory
```

**Parámetros:**
- `variant_id`: ID específico de variante
- `sku`: Buscar por SKU
- `barcode`: Buscar por código de barras
- `compare_methods`: `1` (comparar métodos de cálculo)
- `show_locations`: `1` (mostrar todas las locations)

### Cron Jobs Automáticos

El sistema incluye un cron job inteligente que envía reportes automáticamente:

- **Diario**: Todos los días a las 7:00 AM (Monterrey)
- **Semanal**: Lunes a las 7:00 AM
- **Mensual**: Primer día del mes a las 7:00 AM

**Configuración en vercel.json:**
```json
{
  "crons": [
    {
      "path": "/api/cron/smart-report",
      "schedule": "0 13 * * *"
    }
  ]
}
```

## Análisis Avanzados

### Análisis ABC (Regla 80/20)
Clasifica productos en categorías:
- **A**: Top performers (80% de ingresos)
- **B**: Productos medianos (15% de ingresos)
- **C**: Cola larga (5% de ingresos)

### Reorder Point (ROP)
Calcula automáticamente cuándo reordenar productos basado en:
- Velocidad de venta (últimos 30 días)
- Lead time del proveedor
- Stock de seguridad
- Cobertura en días

### Dead Stock Detection
Identifica productos estancados:
- Sin ventas en 60+ días configurables
- Valor total del inventario estancado
- Recomendaciones de acción

### Conversion Rate por Canal
Estima conversión por canal de venta:
- **POS**: ~50% (estimado)
- **Online**: ~2.2% (estimado)
- **PayPal**: Basado en datos históricos

## Personalización

### Modificar Gráficos
Los gráficos SVG se generan dinámicamente en `chartsHTML()`:

```javascript
// Personalizar colores
const PALETTE = ["#2563EB", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6"];

// Añadir nuevos tipos de análisis
const newAnalysis = {
  title: "Mi Análisis",
  parts: customData.map(item => ({label: item.name, value: item.count}))
};
```

### Agregar Nuevos Períodos
Extiende `computeRange()` para períodos personalizados:

```javascript
if (period === "quarterly") {
  start = now.startOf("quarter");
  end = now.endOf("quarter");
}
```

### Templates de Email
Modifica `buildEmailHTML()` para personalizar el diseño:

```javascript
// Añadir secciones personalizadas
const customSection = `
<div class="section">
  <h3>Mi Sección Custom</h3>
  <div class="stat-row">
    <span class="stat-label">Mi Métrica:</span>
    <span class="stat-value">${miValor}</span>
  </div>
</div>`;
```

## API de Debug

### Verificar Configuración
```bash
curl -X GET "https://tu-dominio.vercel.app/api/debug-inventory?show_locations=true"
```

### Analizar Producto Específico
```bash
curl -X GET "https://tu-dominio.vercel.app/api/debug-inventory?sku=TU-SKU-123"
```

### Comparar Métodos de Inventario
```bash
curl -X GET "https://tu-dominio.vercel.app/api/debug-inventory?compare_methods=true&sample_size=20"
```

## Troubleshooting

### Problemas Comunes

#### 1. Mailgun 403 Forbidden
```
Error: Domain mg.tudominio.com is not allowed to send
```
**Solución**: Verificar que todos los records DNS estén propagados:
```bash
nslookup -type=TXT mg.tudominio.com
nslookup -type=MX mg.tudominio.com
```

#### 2. Inventario Incorrecto
**Problema**: Discrepancias entre `variant.inventory_quantity` y suma de `inventory_levels`
**Solución**: Usar `include_all_locations=0` para solo locations activas

#### 3. Performance Issues
**Problema**: Timeouts en reportes grandes
**Solución**: 
- Verificar cache está funcionando
- Aumentar `maxDuration` en `vercel.json`
- Optimizar rate limiting

#### 4. Cron Jobs No Funcionan
**Verificaciones**:
- `CRON_SECRET` configurado correctamente
- Timezone correcto en `vercel.json`
- Headers de autorización en requests

### Logs y Monitoring

```javascript
// Habilitar debug mode
GET /api/sales-report?debug=1

// Verificar performance
GET /api/sales-report (check X-Timing header)

// Verificar cache
GET /api/sales-report (check X-Cache header)
```

## Dependencias

```json
{
  "dependencies": {
    "luxon": "^3.5.0",
    "mailgun.js": "^9.2.0",
    "form-data": "^4.0.0"
  }
}
```

## Estructura de Archivos

```
├── api/
│   ├── sales-report.js           # Generador principal
│   ├── send-sales-email.js       # Sistema de emails
│   ├── debug-inventory.js        # Herramientas debug
│   └── cron/
│       └── smart-report.js       # Automatización
├── package.json                  # Dependencias
├── vercel.json                   # Configuración Vercel
└── README.md                     # Esta documentación
```

## Contribuir

1. Fork el repositorio
2. Crea una rama para tu feature (`git checkout -b feature/nueva-funcionalidad`)
3. Commit tus cambios (`git commit -am 'Añadir nueva funcionalidad'`)
4. Push a la rama (`git push origin feature/nueva-funcionalidad`)
5. Crea un Pull Request

## Licencia

MIT License - ver archivo LICENSE para más detalles.

## Soporte

Para reportar bugs o solicitar features:
- Crear un issue en GitHub
- Enviar email a admin@tudominio.com

---

**Versión**: 2.1.0  
**Última actualización**: Enero 2025  
**Compatibilidad**: Shopify Admin API 2024-07
