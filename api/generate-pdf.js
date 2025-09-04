// /api/generate-pdf.js - PDF Generator con Puppeteer
import chromium from '@sparticuz/chromium-min';
import puppeteer from 'puppeteer-core';

export const config = {
  maxDuration: 60, // Richiede piano Vercel Pro
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Solo POST method' });
  }

  let browser = null;

  try {
    const { html, filename = 'report.pdf' } = req.body;
    
    if (!html) {
      return res.status(400).json({ error: 'HTML content richiesto' });
    }

    console.log('🔄 Launching Puppeteer...');

    // Launch browser
    browser = await puppeteer.launch({
      executablePath: await chromium.executablePath(
        'https://github.com/Sparticuz/chromium/releases/download/v131.0.1/chromium-v131.0.1-pack.tar'
      ),
      args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox'],
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    
    // Set viewport for consistent rendering
    await page.setViewport({ width: 1200, height: 800 });
    
    // Set content
    await page.setContent(html, { 
      waitUntil: 'networkidle0',
      timeout: 30000 
    });

    console.log('📄 Generating PDF...');

    // Generate PDF
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { 
        top: '20px', 
        bottom: '20px', 
        left: '20px', 
        right: '20px' 
      },
      displayHeaderFooter: false,
      preferCSSPageSize: true
    });

    await browser.close();
    browser = null;

    console.log(`✅ PDF generated: ${pdf.length} bytes`);

    // Return PDF buffer
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdf.length.toString());
    res.status(200).send(pdf);

  } catch (err) {
    console.error('❌ PDF generation error:', err);
    
    if (browser) {
      try {
        await browser.close();
      } catch (closeErr) {
        console.error('❌ Browser close error:', closeErr);
      }
    }

    return res.status(500).json({
      error: err.message,
      timestamp: new Date().toISOString(),
      type: 'pdf_generation_error'
    });
  }
}
