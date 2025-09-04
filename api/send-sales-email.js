// /api/send-sales-email.js — MAILGUN implementation
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

    console.log(`📧 Inviando report ${period} a ${recipients.length} destinatari (Mailgun)`);

    // 1) Genera report JSON - ROBUST URL CONSTRUCTION
    let baseUrl;
    console.log('DEBUG - VERCEL_URL env:', process.env.VERCEL_URL);
    console.log('DEBUG - req.headers.host:', req.headers.host);

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

    console.log('DEBUG - Final baseUrl:', baseUrl);

    const reportUrl = `${baseUrl}/api/sales-report`;
    const params = new URLSearchParams({
      period,
      email: '1',
      ...(today && { today: '1' })
    });

    const completeParams = new URLSearchParams({
      period,
      ...(today && { today: '1' })
    });
    console.log('📄 Fetching complete HTML for attachment...');
    const completeHtmlResponse = await fetch(`${baseUrl}/api/sales-report?${completeParams}`, {
      headers: { 'User-Agent': 'Complete-HTML-Generator/1.0' }
    });

    let completeHtml = reportData.email.html; // fallback alla versione email
    if (completeHtmlResponse.ok) {
      completeHtml = await completeHtmlResponse.text();
      console.log('✅ Complete HTML generated for attachment');
    } else {
      console.log('⚠️ Using email HTML for attachment (complete version failed)');
    }

    console.log(`🔍 Fetching report: ${reportUrl}?${params}`);
    const reportResponse = await fetch(`${reportUrl}?${params}`, {
      headers: { 'User-Agent': 'Mailgun-Mailer/1.0' }
    });

    if (!reportResponse.ok) {
      const errorText = await reportResponse.text();
      throw new Error(`Report generation failed: ${reportResponse.status} ${errorText}`);
    }

    const reportData = await reportResponse.json();
    if (!reportData.success) throw new Error(reportData.error || 'Report data error');

    // 2) Prepara subject con stats
    const money = (n) =>
      new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(Number(n || 0));
    const { stats } = reportData;
    const subjectLine = `${reportData.email.subject} - ${stats.totalOrders} órdenes, ${money(
      stats.totalRevenue
    )}`;

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

    // 4) Debug links
    const debugLinks = `
      <div style="background:#f8fafc;border:1px solid #e5e7eb;padding:10px;margin:12px 0;border-radius:6px;">
        <div style="font-weight:600;margin-bottom:6px;color:#374151;font-size:11px;">🔗 Links útiles:</div>
        <div style="font-size:10px;color:#6b7280;line-height:1.4;">
          <strong>Reports:</strong>
          <a href="${baseUrl}/api/sales-report?period=daily&today=1" style="color:#2563eb;">Hoy</a> |
          <a href="${baseUrl}/api/sales-report?period=daily" style="color:#2563eb;">Ayer</a> |
          <a href="${baseUrl}/api/sales-report?period=weekly" style="color:#2563eb;">Semana</a><br>
          <strong>Trigger Manual:</strong>
          <a href="${baseUrl}/api/cron/smart-report?trigger=daily" style="color:#059669;">Diario</a> |
          <a href="${baseUrl}/api/cron/smart-report?trigger=weekly" style="color:#2563eb;">Semanal</a> |
          <a href="${baseUrl}/api/cron/smart-report?trigger=monthly" style="color:#8b5cf6;">Mensual</a>
        </div>
      </div>
    `;
    emailHtml = emailHtml.replace(
      /<footer|<div style="background:#f8fafc;padding:16px;text-align:center;border-top:1px solid #e5e7eb;">/,
      `${debugLinks}$&`
    );

    // 5) INVIO con MAILGUN
    const fromEmail = process.env.MAILGUN_FROM || `postmaster@${process.env.MAILGUN_DOMAIN}`;
    const isSandbox = /sandbox\.mailgun\.org$/.test(process.env.MAILGUN_DOMAIN);
    const finalRecipients = isSandbox ? [recipients[0]] : (testMode ? [recipients[0]] : recipients);

    const msg = await mailgunClient.messages.create(process.env.MAILGUN_DOMAIN, {
      from: fromEmail,
      to: finalRecipients,
      subject: subjectLine,
      html: emailHtml,
      text: reportData.email.text,
      'h:Reply-To': process.env.REPLY_TO_EMAIL || undefined,
      'o:tag': ['sales-report', period],
      attachment: {
        data: Buffer.from(completeHtml, 'utf-8'),
        filename: `reporte-ventas-complete-${period}-${new Date().toISOString().split('T')[0]}.html`,
        contentType: 'text/html'
      }
    });

    console.log('📧 Mailgun response:', msg);
    if (!msg?.id) throw new Error(`Mailgun response senza ID valido: ${JSON.stringify(msg)}`);

    // 6) Response
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
