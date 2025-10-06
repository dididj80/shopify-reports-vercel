// /api/cron/smart-report.js - Cron unico che gestisce tutto
export default async function handler(req, res) {
  // Verifica autorizzazione cron
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    console.error('❌ Unauthorized cron call');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const now = new Date();

    // CALCOLO TIMEZONE ESPLICITO
    const monterreyTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Monterrey' }));
    const dayOfWeek = monterreyTime.getDay();
    const dayOfMonth = monterreyTime.getDate();
    
    console.log(`🤖 Smart cron started - Day: ${dayOfWeek}, Date: ${dayOfMonth} (Monterrey time)`);
    console.log(`DEBUG - UTC date: ${now.getDate()}, Monterrey date: ${monterreyTime.getDate()}`);

    // Verifica configurazione
    const recipients = process.env.SALES_REPORT_RECIPIENTS?.split(',')?.map(email => email.trim()) || [];
    
    if (!recipients.length) {
      console.log('⚠️  Nessun destinatario configurato in SALES_REPORT_RECIPIENTS');
      return res.status(200).json({ 
        success: true, 
        message: 'No recipients configured',
        skipped: true,
        timestamp: now.toISOString()
      });
    }

    if (!process.env.MAILGUN_API_KEY) {
      throw new Error('MAILGUN_API_KEY non configurata');
    }

    const results = [];
   // FIX URL CONSTRUCTION - Same logic as send-sales-email.js
    let baseUrl;
    if (process.env.VERCEL_URL) {
      // VERCEL_URL può essere solo il dominio, aggiungiamo https://
      baseUrl = process.env.VERCEL_URL.startsWith('http') 
        ? process.env.VERCEL_URL 
        : `https://${process.env.VERCEL_URL}`;
    } else if (req.headers.host) {
      // Fallback usando req.headers.host
      const protocol = req.headers['x-forwarded-proto'] || 'https';
      baseUrl = `${protocol}://${req.headers.host}`;
    } else {
      // Ultimo fallback hardcoded
      baseUrl = 'https://shopify-reports-vercel.vercel.app';
    }

    console.log('DEBUG - baseUrl:', baseUrl);
    console.log('DEBUG - VERCEL_URL env:', process.env.VERCEL_URL);
    console.log('DEBUG - req.headers.host:', req.headers.host);
    
    // 1) SEMPRE: Report giornaliero (ieri)
    console.log('📧 Inviando report giornaliero...');
    try {
      const dailyResult = await sendReport({
        period: 'daily',
        recipients,
        today: false,
        customMessage: 'Report automatico giornaliero - Performance di ieri',
        baseUrl
      });
      results.push({ type: 'daily', ...dailyResult });
    } catch (err) {
      console.error('❌ Daily report failed:', err.message);
      results.push({ type: 'daily', success: false, error: err.message });
    }

    // 2) LUNEDÌ: Report settimanale  
    if (dayOfWeek === 1) {
      console.log('📧 Inviando report settimanale (lunedì)...');
      try {
        const weeklyResult = await sendReport({
          period: 'weekly',
          recipients,
          customMessage: 'Report automatico settimanale - Riepilogo settimana scorsa',
          baseUrl
        });
        results.push({ type: 'weekly', ...weeklyResult });
      } catch (err) {
        console.error('❌ Weekly report failed:', err.message);
        results.push({ type: 'weekly', success: false, error: err.message });
      }
    }

    // 3) REPORT MENSILE - SOLUZIONE PRINCIPALE (PRIMO DEL MESE)
    if (dayOfMonth === 1) {
      console.log('📧 Inviando report mensile (1 del mese)...');
      try {
        const monthlyResult = await sendReport({
          period: 'monthly',
          recipients,
          customMessage: 'Report automatico mensile - Analisi completa mese precedente',
          baseUrl
        });
        results.push({ type: 'monthly', ...monthlyResult });
      } catch (err) {
        console.error('❌ Monthly report failed:', err.message);
        results.push({ type: 'monthly', success: false, error: err.message });
      }
    }

    // FALLBACK COMMENTATO - Attiva solo se la soluzione principale non funziona
    /*
    // FALLBACK: PRIMO LUNEDI DEL MESE (se la soluzione principale salta)
    const isFirstWeekOfMonth = dayOfMonth >= 1 && dayOfMonth <= 7;
    const shouldSendMonthlyFallback = dayOfWeek === 1 && isFirstWeekOfMonth && dayOfMonth !== 1;
    
    if (shouldSendMonthlyFallback) {
      console.log('FALLBACK: Inviando report mensile (primo lunedi del mese)...');
      try {
        const monthlyResult = await sendReport({
          period: 'monthly',
          recipients,
          customMessage: 'Report automatico mensile (recupero) - Analisi completa mese precedente',
          baseUrl
        });
        results.push({ type: 'monthly-fallback', ...monthlyResult });
      } catch (err) {
        console.error('❌ Monthly fallback failed:', err.message);
        results.push({ type: 'monthly-fallback', success: false, error: err.message });
      }
    }
    */

    // Riepilogo finale
    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    console.log(`✅ Cron completato: ${successful} success, ${failed} failed`);

    return res.status(200).json({
      success: failed === 0,
      timestamp: now.toISOString(),
      day: dayOfWeek,
      date: dayOfMonth,
      results,
      summary: { successful, failed, total: results.length },
      recipients: recipients.length
    });

  } catch (err) {
    console.error('❌ Smart cron critical error:', err);
    return res.status(500).json({
      success: false,
      error: err.message,
      timestamp: new Date().toISOString(),
      criticalFailure: true
    });
  }
}

// Helper per inviare singolo report
// Helper per inviare singolo report
async function sendReport({ period, recipients, today = false, customMessage, baseUrl }) {
  const startTime = Date.now();
  
  try {
    const response = await fetch(`${baseUrl}/api/send-sales-email`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'User-Agent': 'Smart-Cron/1.0'
      },
      body: JSON.stringify({
        period,
        recipients,
        today,
        customMessage
      })
    });

    // AGGIUNGI QUESTO DEBUG
    const responseText = await response.text();
    console.log('DEBUG - Response status:', response.status);
    console.log('DEBUG - Response headers:', Object.fromEntries(response.headers));
    console.log('DEBUG - Response body:', responseText.substring(0, 200));

    // Poi prova il parse JSON
    let result;
    try {
      result = JSON.parse(responseText);
    } catch (err) {
      console.error('JSON parse error:', err.message);
      return { success: false, error: `Invalid JSON response: ${responseText.substring(0, 100)}` };
    }

    const duration = Date.now() - startTime;
    
    if (result.success) {
      console.log(`Report ${period} sent successfully in ${duration}ms - Resend ID: ${result.messageId}`);
      return { 
        ...result, 
        duration,
        success: true 
      };
    } else {
      console.error(`Report ${period} failed:`, result.error);
      return { 
        success: false, 
        error: result.error,
        duration 
      };
    }

  } catch (err) {
    const duration = Date.now() - startTime;
    console.error(`Send ${period} report error:`, err.message);
    return { 
      success: false, 
      error: err.message,
      duration 
    };
  }
}
