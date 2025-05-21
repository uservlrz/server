const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { PDFDocument } = require('pdf-lib');
const { splitPDF, savePdfPartsToFiles, cleanupTempFiles } = require('./pdfSplitter');

/**
 * @param {string} pdfPath 
 * @returns {Promise<Array>} 
 */
async function processOcr(pdfPath) {
  try {
    console.log(`Iniciando OCR via API para o arquivo: ${pdfPath}`);
    
    // Verificar se o arquivo existe
    if (!fs.existsSync(pdfPath)) {
      throw new Error(`Arquivo não encontrado: ${pdfPath}`);
    }

    // Verificar tamanho do arquivo
    const fileStats = fs.statSync(pdfPath);
    const fileSizeKB = Math.round(fileStats.size / 1024);
    console.log(`Tamanho do arquivo: ${fileSizeKB}KB`);
    
    // Lista para arquivos temporários a serem limpos depois
    let tempFiles = [];
    
    // Ler o PDF como buffer
    const pdfBuffer = fs.readFileSync(pdfPath);
    
    // Se o arquivo for maior que o limite, dividir em partes usando seu splitPDF existente
    let pdfParts = [pdfBuffer];
    if (fileSizeKB > 1000) {
      console.log(`Arquivo excede limite de 1MB para API gratuita, dividindo em partes...`);
      
      // Aqui estamos aproveitando seu código existente de splitPDF!
      pdfParts = await splitPDF(pdfBuffer, 1); // 1 página por parte para garantir tamanho pequeno
      console.log(`PDF dividido em ${pdfParts.length} partes para OCR`);
      
      // Reduzir tamanho se alguma parte ainda estiver muito grande
      for (let i = 0; i < pdfParts.length; i++) {
        const partSizeKB = Math.round(pdfParts[i].length / 1024);
        if (partSizeKB > 950) {
          console.log(`Parte ${i+1} ainda está grande (${partSizeKB}KB), reduzindo qualidade...`);
          try {
            pdfParts[i] = await reducePdfQuality(pdfParts[i]);
          } catch (e) {
            console.warn(`Falha ao reduzir qualidade da parte ${i+1}:`, e.message);
          }
        }
      }
    }
    
    // Salvar partes em arquivos temporários para processamento OCR
    const tempDir = path.dirname(pdfPath);
    const partPaths = [];
    for (let i = 0; i < pdfParts.length; i++) {
      const partPath = `${pdfPath}_ocr_part_${i+1}.pdf`;
      fs.writeFileSync(partPath, pdfParts[i]);
      partPaths.push(partPath);
      tempFiles.push(partPath);
    }
    
    // Array para armazenar todos os resultados OCR
    const allResults = [];
    
    // Processar cada parte
    for (let partIndex = 0; partIndex < partPaths.length; partIndex++) {
      const partPath = partPaths[partIndex];
      const partSize = Math.round(fs.statSync(partPath).size / 1024);
      console.log(`Processando parte ${partIndex+1}/${partPaths.length}: ${partPath} (${partSize}KB)`);
      
      // Verificar se a parte ainda é grande demais
      if (partSize > 1000) {
        console.warn(`Parte ${partIndex+1} ainda excede limite de 1MB (${partSize}KB), pulando...`);
        allResults.push({
          page: `Parte ${partIndex+1}`,
          text: `Esta parte do documento é muito grande para OCR (${partSize}KB > 1000KB limite).`
        });
        continue;
      }
      
      try {
        // Criar FormData para envio
        const formData = new FormData();
        formData.append('file', fs.createReadStream(partPath));
        
        // Configurar parâmetros para melhor resultado com documentos médicos
        formData.append('language', 'por');           // Português
        formData.append('OCREngine', '2');            // Motor OCR mais avançado
        formData.append('scale', 'true');             // Redimensionamento automático
        formData.append('detectOrientation', 'true'); // Detectar orientação da página
        formData.append('isCreateSearchablePdf', 'false');
        formData.append('isSearchablePdfHideTextLayer', 'false');
        
        // Obter API Key de variável de ambiente
        const apiKey = process.env.OCR_API_KEY || 'helloworld';
        
        console.log(`Enviando parte ${partIndex+1} para processamento OCR...`);
        
        // Chamar a API OCR.space
        const response = await axios.post(
          'https://api.ocr.space/parse/image',
          formData,
          {
            headers: {
              ...formData.getHeaders(),
              'apikey': apiKey
            },
            timeout: 60000 // 60 segundos de timeout
          }
        );
        
        // Validar resposta
        if (response.data && response.data.ParsedResults) {
          const results = response.data.ParsedResults;
          console.log(`OCR bem-sucedido para parte ${partIndex+1}: ${results.length} resultados`);
          
          // Pós-processamento específico para laudos médicos
          const processedResults = results.map((result, index) => ({
            page: `Parte ${partIndex+1}${results.length > 1 ? ` - Seção ${index+1}` : ''}`,
            text: cleanMedicalLabText(result.ParsedText || '')
          }));
          
          // Adicionar ao array de resultados
          allResults.push(...processedResults);
        } else if (response.data && response.data.ErrorMessage) {
          console.error(`Erro na API OCR (parte ${partIndex+1}):`, response.data.ErrorMessage);
          allResults.push({
            page: `Parte ${partIndex+1}`,
            text: `Erro no processamento OCR: ${response.data.ErrorMessage}`
          });
        }
      } catch (partError) {
        console.error(`Erro ao processar parte ${partIndex+1}:`, partError);
        allResults.push({
          page: `Parte ${partIndex+1}`,
          text: `Erro de processamento: ${partError.message}`
        });
      }
    }
    
    // Limpar arquivos temporários
    console.log('Limpando arquivos temporários...');
    tempFiles.forEach(tempFile => {
      try {
        if (fs.existsSync(tempFile)) {
          fs.unlinkSync(tempFile);
          console.log(`Arquivo temporário removido: ${tempFile}`);
        }
      } catch (cleanupError) {
        console.error(`Erro ao remover arquivo temporário:`, cleanupError);
      }
    });
    
    if (allResults.length === 0) {
      throw new Error('Nenhum resultado obtido do OCR');
    }
    
    return allResults;
  } catch (error) {
    console.error('Erro no processamento OCR:', error);
    throw error;
  }
}

/**
 * Reduz a qualidade de um PDF para diminuir o tamanho do arquivo
 * @param {Buffer} pdfBuffer - Buffer do PDF
 * @returns {Promise<Buffer>} - Buffer do PDF com qualidade reduzida
 */
async function reducePdfQuality(pdfBuffer) {
  try {
    // Carregar o PDF
    const pdfDoc = await PDFDocument.load(pdfBuffer, {
      ignoreEncryption: true,
      updateMetadata: false
    });
    
    // Salvar com configurações de compressão
    const compressedPdfBytes = await pdfDoc.save({
      useObjectStreams: false,
      addDefaultPage: false,
      // Opções para reduzir qualidade/tamanho
      objectsPerTick: 20
    });
    
    return Buffer.from(compressedPdfBytes);
  } catch (error) {
    console.error('Erro ao reduzir qualidade do PDF:', error);
    return pdfBuffer; // Retorna o buffer original em caso de erro
  }
}

/**
 * Limpa e aprimora o texto OCR para maior precisão em laudos médicos
 * @param {string} text - Texto bruto do OCR
 * @returns {string} - Texto limpo e processado
 */
function cleanMedicalLabText(text) {
  if (!text) return '';
  
  // Remover espaços e quebras de linha excessivas
  let cleaned = text
    .replace(/\s+/g, ' ')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();
  
  // Correções específicas para laudos médicos
  const medicalReplacements = [
    // Números e unidades
    { from: /([0-9]),([0-9])/g, to: '$1.$2' },     // Corrigir vírgulas em números
    { from: /rng\/dL/g, to: 'mg/dL' },             // Corrigir unidades
    { from: /µg\/dL/g, to: 'µg/dL' },              // Preservar unidades corretas
    { from: /pg\/mL/g, to: 'pg/mL' },              // Preservar unidades corretas
    { from: /ng\/mL/g, to: 'ng/mL' },              // Preservar unidades corretas
    { from: /([0-9])o([0-9])/g, to: '$1.0$2' },    // Corrigir caracteres mal reconhecidos
    { from: /\bO\b/g, to: '0' },                   // O -> 0 quando isolado
    
    // Termos médicos comuns
    { from: /Hernoglobina/g, to: 'Hemoglobina' },
    { from: /Leucócítos/g, to: 'Leucócitos' },
    { from: /Glicernia/g, to: 'Glicemia' },
    
    // Cabeçalhos e seções comuns em laudos
    { from: /Pacíente/g, to: 'Paciente' },
    { from: /Resutado/g, to: 'Resultado' },
    { from: /\/alor/g, to: 'Valor' },
    { from: /VR:/g, to: 'VR:' },                   // Preservar formato de valor referencial
    
    // Estrutura de nome e data
    { from: /D[nN]:/g, to: 'DN:' },                // Corrigir data de nascimento
    { from: /\bvls\b/g, to: 'ais' }                // Correção para nomes
  ];
  
  // Aplicar todas as correções
  medicalReplacements.forEach(({ from, to }) => {
    cleaned = cleaned.replace(from, to);
  });
  
  return cleaned;
}

module.exports = { processOcr };