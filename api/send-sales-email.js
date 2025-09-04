// /api/send-sales-email.js - RESEND implementation - FIXED
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Solo POST method' });
  }

  try {
    const { 
      period = 'daily', 
      recipients = [], 
      today = false,
      customMessage = '',
      testMode = false
    } = req.body;

    // Validazioni
    if (!process.env.RESEND_API_KEY) {
      throw new Error('RESEND_API_KEY non configurata');
    }

    if (!recipients.length) {
      return res.status(400).json({ error: 'Recipients richiesti nel body' });
    }

    console.log(`📧 Inviando report ${period} a ${recipients.length} destinatari`);

    // 1) Genera report JSON - ROBUST URL CONSTRUCTION
    let baseUrl;
    
    // Debug logging
    console.log('DEBUG - VERCEL_URL env:', process.env.VERCEL_URL);
    console.log('DEBUG - req.headers.host:', req.headers.host);
    
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
      // Ultimo fallback per cron jobs
      baseUrl = 'https://shopify-reports-vercel.vercel.app';
    }
    
    console.log('DEBUG - Final baseUrl:', baseUrl);

    const reportUrl = `${baseUrl}/api/sales-report`;
    const params = new URLSearchParams({ 
      period, 
      email: '1',
      ...(today && { today: '1' })
    });

    console.log(`🔍 Fetching report: ${reportUrl}?${params}`);

    const reportResponse = await fetch(`${reportUrl}?${params}`, {
      headers: { 'User-Agent': 'Resend-Mailer/1.0' }
    });

    if (!reportResponse.ok) {
      const errorText = await reportResponse.text();
      throw new Error(`Report generation failed: ${reportResponse.status} ${errorText}`);
    }

    const reportData = await reportResponse.json();
    
    if (!reportData.success) {
      throw new Error(reportData.error || 'Report data error');
    }

    // 2) Prepara subject con stats
    const money = (n) => new Intl.NumberFormat("es-MX",{style:"currency",currency:"MXN"}).format(Number(n||0));
    const { stats } = reportData;
    const subjectLine = `${reportData.email.subject} - ${stats.totalOrders} órdenes, ${money(stats.totalRevenue)}`;
    
    // 3) Aggiungi messaggio custom se presente
    let emailHtml = reportData.email.html;
    if (customMessage) {
      emailHtml = emailHtml.replace(
        '<div class="container">',
        `<div class="container">
          <div style="background:#eff6ff;border:1px solid #bfdbfe;padding:12px;margin:0 0 16px;border-radius:6px;">
            <strong>📝 Mensaje:</strong> ${customMessage}
          </div>`
      );
    }

    // 4) Aggiungi debug links al footer email
    const debugLinks = `
      <div style="background:#f8fafc;border:1px solid #e5e7eb;padding:10px;margin:12px 0;border-radius:6px;">
        <div style="font-weight:600;margin-bottom:6px;color:#374151;font-size:11px;">🔗 Links útiles:</div>
        <div style="font-size:10px;color:#6b7280;line-height:1.4;">
          <strong>Reports:</strong>
          <a href="${baseUrl}/api/sales-report?period=daily&today=1" style="color:#2563eb;">Hoy</a> |
          <a href="${baseUrl}/api/sales-report?period=daily" style="color:#2563eb;">Ayer</a> |
          <a href="${baseUrl}/api/sales-report?period=weekly" style="color:#2563eb;">Semana</a><br>
          <strong>Debug:</strong>
          <a href="${baseUrl}/api/sales-report?period=${period}&debug=1" style="color:#8b5cf6;">Debug</a> |
          <a href="${baseUrl}/api/sales-report?period=${period}&today=1&debug=1" style="color:#8b5cf6;">Debug Hoy</a>
        </div>
      </div>
    `;

    // Inserisci debug links prima del footer
    emailHtml = emailHtml.replace(
      /<footer|<div style="background:#f8fafc;padding:16px;text-align:center;border-top:1px solid #e5e7eb;">/,
      `${debugLinks}$&`
    );

    // 5) INVIO con RESEND - ENHANCED DEBUGGING
    // TEMP FIX: Force use of resend domain until custom domain is verified
    const fromEmail = 'onboarding@resend.dev'; // process.env.FROM_EMAIL || 'onboarding@resend.dev';
    
    console.log('🔍 DEBUG Email config:');
    console.log('- RESEND_API_KEY exists:', !!process.env.RESEND_API_KEY);
    console.log('- RESEND_API_KEY length:', process.env.RESEND_API_KEY?.length || 0);
    console.log('- FROM_EMAIL:', process.env.FROM_EMAIL || 'not set');
    console.log('- Recipients count:', testMode ? 1 : recipients.length);
    console.log('- Recipients:', testMode ? [recipients[0]] : recipients);
    
    if (fromEmail === 'onboarding@resend.dev') {
      console.log('⚠️  Usando dominio temporaneo Resend. Per produzione, configura un dominio proprio.');
    }

    const emailPayload = {
      from: fromEmail.includes('@') ? fromEmail : `Sales Report <${fromEmail}>`,
      to: testMode ? [recipients[0]] : recipients,
      subject: subjectLine,
      html: emailHtml,
      text: reportData.email.text,
      
      // Reply-to opzionale (se vuoi risposte al tuo Gmail)
      reply_to: process.env.REPLY_TO_EMAIL || process.env.FROM_EMAIL,
      
      tags: [
        { name: 'type', value: 'sales-report' },
        { name: 'period', value: period },
        { name: 'domain', value: fromEmail.includes('resend.dev') ? 'trial' : 'custom' }
      ]
    };
    
    console.log('🚀 Sending email with payload structure:', JSON.stringify({
      from: emailPayload.from,
      to: emailPayload.to,
      subject: emailPayload.subject,
      hasHtml: !!emailPayload.html,
      hasText: !!emailPayload.text,
      tagsCount: emailPayload.tags ? emailPayload.tags.length : 0
    }, null, 2));

    const emailResult = await resend.emails.send(emailPayload);
    
    console.log('📧 Resend response:', JSON.stringify(emailResult, null, 2));
    
    if (!emailResult) {
      throw new Error('Resend returned null/undefined response');
    }
    
    if (!emailResult.id) {
      throw new Error(`Resend response missing ID: ${JSON.stringify(emailResult)}`);
    }
    
    console.log(`✅ Email inviata via Resend - ID: ${emailResult.id}`);

    // 6) Log per tracking (opzionale)
    const logEntry = {
      timestamp: new Date().toISOString(),
      period,
      recipients: testMode ? 1 : recipients.length,
      resendId: emailResult.id,
      stats,
      testMode,
      performance: reportData.timing?.total || 'unknown'
    };

    console.log('📊 Email sent log:', JSON.stringify(logEntry));

    return res.status(200).json({
      success: true,
      messageId: emailResult.id,
      recipients: testMode ? 1 : recipients.length,
      stats,
      sentAt: new Date().toISOString(),
      provider: 'resend',
      testMode,
      analyticsUrl: `https://resend.com/emails/${emailResult.id}`,
      webVersion: `${baseUrl}/api/sales-report?period=${period}${today ? '&today=1' : ''}`
    });

  } catch (err) {
    console.error('❌ Resend email error:', err);
    console.error('❌ Error stack:', err.stack);
    
    const errorDetail = {
      success: false,
      error: err.message,
      timestamp: new Date().toISOString(),
      provider: 'resend',
      config: {
        hasApiKey: !!process.env.RESEND_API_KEY,
        apiKeyLength: process.env.RESEND_API_KEY?.length || 0,
        hasFromEmail: !!process.env.FROM_EMAIL,
        fromEmail: process.env.FROM_EMAIL ? 'configured' : 'missing'
      }
    };

    return res.status(500).json(errorDetail);
  }
}
