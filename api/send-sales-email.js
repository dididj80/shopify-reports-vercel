// /api/send-sales-email.js - Mailgun email sender FIXED
import FormData from 'form-data';
import Mailgun from 'mailgun.js';

const mg = new Mailgun(FormData);
const mailgunClient = mg.client({
  username: 'api',
  key: process.env.MAILGUN_API_KEY,
  url: process.env.MAILGUN_BASE_URL || 'https://api.mailgun.net'
});

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
    if (!process.env.MAILGUN_API_KEY) throw new Error('MAILGUN_API_KEY non configurata');
    if (!process.env.MAILGUN_DOMAIN) throw new Error('MAILGUN_DOMAIN non configurato');
    if (!recipients.length) return res.status(400).json({ error: 'Recipients richiesti nel body' });

    // Costruzione URL base
    let baseUrl;
    if (process.env.VERCEL_URL) {
      baseUrl = process.env.VERCEL_URL.startsWith('http')
        ? process.env.VERCEL_URL
        : `https://${process.env.VERCEL_URL}`;
    } else if (req.headers.host) {
      const protocol = req.headers['x-forwarded-proto'] || 'https';
      baseUrl = `${protocol}://${req.headers.host}`;
    } else {
      baseUrl = 'https://shopify-reports-vercel.vercel.app';
    }

    console.log('📧 Fetching report data from:', `${baseUrl}/api/sales-report`);

    // Fetch report dati email
    const reportUrl = `${baseUrl}/api/sales-report`;
    const params = new URLSearchParams({
      period,
      email: '1',
      ...(today && { today: '1' })
    });

    const reportResponse = await fetch(`${reportUrl}?${params}`, {
      headers: { 'User-Agent': 'Mailgun-Mailer/1.0' }
    });

    if (!reportResponse.ok) {
      const errorText = await reportResponse.text();
      throw new Error(`Report generation failed: ${reportResponse.status} ${errorText}`);
    }

    const reportData = await reportResponse.json();
    
    // 🔥 DEBUG - Verifica struttura
    console.log('📊 Report data structure:', {
      success: reportData.success,
      hasEmail: !!reportData.email,
      emailKeys: reportData.email ? Object.keys(reportData.email) : 'N/A',
      hasStats: !!reportData.stats
    });
    
    if (!reportData.success) {
      throw new Error(reportData.error || 'Report data error');
    }

    // 🔥 FIX: Verifica che email object esista
    if (!reportData.email || !reportData.email.html) {
      throw new Error(`Invalid report structure - missing email.html. Got: ${JSON.stringify(reportData).substring(0, 200)}`);
    }

    // Fetch HTML completo per allegato
    let completeHtml = reportData.email.html;
    try {
      const completeParams = new URLSearchParams({
        period,
        ...(today && { today: '1' })
      });
      
      const completeHtmlResponse = await fetch(`${baseUrl}/api/sales-report?${completeParams}`, {
        headers: { 'User-Agent': 'Complete-HTML-Generator/1.0' }
      });
      
      if (completeHtmlResponse.ok) {
        completeHtml = await completeHtmlResponse.text();
        console.log('✅ Complete HTML fetched successfully');
      } else {
        console.warn('⚠️ Complete HTML fetch failed, using email HTML as fallback');
      }
    } catch (e) {
      console.warn('⚠️ Complete HTML error:', e.message);
    }

    // Prepara subject con stats
    const money = (n) =>
      new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(Number(n || 0));
    
    const { stats } = reportData;
    
    // 🔥 FIX: Usa email.subject direttamente
    const baseSubject = reportData.email.subject || `Reporte ventas ${period}`;
    const subjectLine = `${baseSubject}`;

    console.log('📝 Email subject:', subjectLine);

    // Aggiungi messaggio custom se presente
    let emailHtml = reportData.email.html;
    if (customMessage) {
      emailHtml = emailHtml.replace(
        '<div class="container">',
        `<div class="container">
          <div style="background:#eff6ff;border:1px solid #bfdbfe;padding:12px;margin:0 0 16px;border-radius:6px;">
            <strong>📋 Mensaje:</strong> ${customMessage}
          </div>`
      );
    }

    // Invio con Mailgun
    const fromEmail = process.env.MAILGUN_FROM || `postmaster@${process.env.MAILGUN_DOMAIN}`;
    const isSandbox = /sandbox\.mailgun\.org$/.test(process.env.MAILGUN_DOMAIN);
    const finalRecipients = isSandbox ? [recipients[0]] : (testMode ? [recipients[0]] : recipients);

    console.log('📮 Sending to:', finalRecipients.join(', '));

    const msg = await mailgunClient.messages.create(process.env.MAILGUN_DOMAIN, {
      from: fromEmail,
      to: finalRecipients,
      subject: subjectLine,
      html: emailHtml,
      text: reportData.email.text || `Reporte ventas ${period}`,
      'h:Reply-To': process.env.REPLY_TO_EMAIL || undefined,
      'o:tag': ['sales-report', period],
      attachment: {
        data: Buffer.from(completeHtml, 'utf-8'),
        filename: `reporte-ventas-complete-${period}-${new Date().toISOString().split('T')[0]}.html`,
        contentType: 'text/html'
      }
    });

    if (!msg?.id) throw new Error(`Mailgun response senza ID valido: ${JSON.stringify(msg)}`);

    console.log('✅ Email sent successfully:', msg.id);

    return res.status(200).json({
      success: true,
      messageId: msg.id,
      recipients: finalRecipients.length,
      stats,
      sentAt: new Date().toISOString(),
      provider: 'mailgun',
      testMode,
      webVersion: `${baseUrl}/api/sales-report?period=${period}${today ? '&today=1' : ''}`
    });

  } catch (err) {
    console.error('❌ Mailgun email error:', err);
    return res.status(500).json({
      success: false,
      error: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
      timestamp: new Date().toISOString(),
      provider: 'mailgun',
      config: {
        hasApiKey: !!process.env.MAILGUN_API_KEY,
        hasDomain: !!process.env.MAILGUN_DOMAIN,
        baseUrl: process.env.MAILGUN_BASE_URL || 'https://api.mailgun.net',
        fromEmail: process.env.MAILGUN_FROM || (process.env.MAILGUN_DOMAIN ? `postmaster@${process.env.MAILGUN_DOMAIN}` : 'n/a')
      }
    });
  }
}