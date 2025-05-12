// server/utils/pdfParser.js
const pdfParse = require('pdf-parse');
const fs = require('fs');

/**
 * Extrai o texto de um arquivo PDF e separa por páginas
 * @param {string} filePath - Caminho do arquivo PDF
 * @returns {Promise<Array>} - Array de objetos com número da página e texto
 */
async function parsePdf(filePath) {
  try {
    const dataBuffer = fs.readFileSync(filePath);
    const data = await pdfParse(dataBuffer);
    
    // Dividir o texto por páginas
    // Nota: pdf-parse não fornece texto separado por página por padrão,
    // então usamos uma abordagem aproximada baseada em quebras de página
    const textContent = data.text;
    const pageCount = data.numpages;
    
    // Se o PDF tiver apenas uma página
    if (pageCount === 1) {
      return [{ page: 1, text: textContent }];
    }
    
    // Dividir o texto em partes aproximadamente iguais para cada página
    const textPerPage = Math.ceil(textContent.length / pageCount);
    const pages = [];
    
    for (let i = 0; i < pageCount; i++) {
      const startIndex = i * textPerPage;
      const endIndex = Math.min(startIndex + textPerPage, textContent.length);
      const pageText = textContent.substring(startIndex, endIndex);
      
      pages.push({
        page: i + 1,
        text: pageText.trim()
      });
    }
    
    return pages;
  } catch (error) {
    console.error('Erro ao analisar o PDF:', error);
    throw error;
  }
}

module.exports = { parsePdf };