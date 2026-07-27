const fs = require('fs');
const pdfjsLib = require('pdfjs-dist/build/pdf.js');

async function testPDF() {
  console.log('[Test] pdfjs-dist version:', pdfjsLib.version);
  
  const pdfPath = '/Users/kevinsheffer/Desktop/Organizations and Callings.pdf';
  if (!fs.existsSync(pdfPath)) {
    console.error('[Test] PDF file not found at:', pdfPath);
    return;
  }

  const data = fs.readFileSync(pdfPath);
  console.log('[Test] PDF file size:', data.length, 'bytes');

  try {
    const doc = await pdfjsLib.getDocument({ data }).promise;
    console.log('[Test] ✅ PDF loaded successfully with', doc.numPages, 'pages');
    
    // Try to extract text from first page
    const page = await doc.getPage(1);
    const textContent = await page.getTextContent();
    const text = textContent.items.map(item => item.str).join(' ');
    console.log('[Test] ✅ Extracted text from page 1 (first 100 chars):', text.substring(0, 100));
  } catch (err) {
    console.error('[Test] ❌ Error:', err.message);
  }
}

testPDF();
