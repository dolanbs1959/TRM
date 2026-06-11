const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

async function generate() {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  
  // Load the template you just created
  const html = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');
  await page.setContent(html, { waitUntil: 'networkidle0' });
  
  // Generate the PDF
  await page.pdf({ 
    path: 'preview.pdf', 
    format: 'Letter',
    printBackground: true 
  });
  
  console.log('PDF generated successfully: preview.pdf');
  await browser.close();
}

generate().catch(console.error);