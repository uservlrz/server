// utils/pdfParser.js - Versão aprimorada com tratamento de erros mais robusto
const pdfParse = require('pdf-parse');
const fs = require('fs');
const { PDFDocument } = require('pdf-lib');

/**
 * Extrai o texto de um PDF usando vários métodos em cascata
 * Função principal que tenta diferentes abordagens
 * @param {string|Buffer} pdfInput - Caminho do arquivo PDF ou buffer
 * @returns {Promise<Array>} - Array de objetos com número da página e texto
 */
async function parsePdf(pdfInput) {
  console.log(`Iniciando extração de texto do PDF`);
  
  // Determinar se a entrada é um caminho de arquivo ou um buffer
  let pdfBuffer;
  if (typeof pdfInput === 'string') {
    try {
      pdfBuffer = fs.readFileSync(pdfInput);
      console.log(`PDF lido do arquivo, tamanho: ${pdfBuffer.length} bytes`);
    } catch (readError) {
      console.error('Erro ao ler arquivo PDF:', readError);
      throw readError;
    }
  } else {
    pdfBuffer = pdfInput;
    console.log(`PDF fornecido como buffer, tamanho: ${pdfBuffer.length} bytes`);
  }
  
  // Array para armazenar os resultados
  let results = null;
  
  // Método 1: Tentar extrair com pdf-parse diretamente (mais rápido)
  try {
    console.log("Método 1: Tentando extrair com pdf-parse diretamente...");
    results = await extractWithPdfParse(pdfBuffer);
    
    // Verificar se o texto extraído tem conteúdo significativo
    if (results && results[0] && results[0].text && results[0].text.length > 50) {
      console.log(`Método 1 bem-sucedido! Extraído ${results[0].text.length} caracteres`);
      return results;
    } else {
      console.warn("Método 1 extraiu texto muito curto, tentando método alternativo");
      throw new Error("Texto extraído muito curto");
    }
  } catch (method1Error) {
    console.warn("Método 1 falhou:", method1Error.message);
    
    // Método 2: Tentar extrair com pdf-lib primeiro e depois pdf-parse
    try {
      console.log("Método 2: Tentando extrair usando pdf-lib e pdf-parse...");
      results = await extractWithPdfLib(pdfBuffer);
      
      // Verificar qualidade do resultado
      if (results && results[0] && results[0].text && results[0].text.length > 50) {
        console.log(`Método 2 bem-sucedido! Extraído ${results[0].text.length} caracteres`);
        return results;
      } else {
        console.warn("Método 2 extraiu texto muito curto, tentando método alternativo");
        throw new Error("Texto extraído muito curto");
      }
    } catch (method2Error) {
      console.warn("Método 2 falhou:", method2Error.message);
      
      // Método 3: Tentar dividir o PDF e extrair partes
      try {
        console.log("Método 3: Tentando extrair dividindo o PDF em partes...");
        results = await extractBySplitting(pdfBuffer);
        
        if (results && results[0] && results[0].text && results[0].text.length > 50) {
          console.log(`Método 3 bem-sucedido! Extraído ${results[0].text.length} caracteres`);
          return results;
        } else {
          console.warn("Método 3 extraiu texto muito curto, tentando último método");
          throw new Error("Texto extraído muito curto");
        }
      } catch (method3Error) {
        console.warn("Método 3 falhou:", method3Error.message);
        
        // Método 4: Último recurso - extrair metadados básicos
        console.log("Método 4: Tentando extrair apenas metadados básicos...");
        results = await extractBasicMetadata(pdfBuffer);
        console.log("Método 4 completado (metadados básicos)");
        return results;
      }
    }
  }
}

/**
 * Método 1: Extrair texto usando pdf-parse diretamente com opções melhoradas
 * @param {Buffer} pdfBuffer - Buffer do arquivo PDF
 * @returns {Promise<Array>} - Array de objetos com página e texto
 */
async function extractWithPdfParse(pdfBuffer) {
  try {
    const options = {
      // Opções para melhorar a compatibilidade
      max: 0,                       // Sem limite de páginas
      pagerender: renderPage,       // Renderização personalizada para lidar com erros
      version: 'v1.10.100'          // Forçar versão específica para compatibilidade
    };
    
    // Função personalizada para renderização de página com tratamento de erros
    function renderPage(pageData) {
      try {
        let render_options = {
          normalizeWhitespace: true,
          disableCombineTextItems: false
        };
        
        return pageData.getTextContent(render_options)
          .then(function(textContent) {
            let text = '';
            let lastY = -1;
            
            for (let item of textContent.items) {
              if (lastY == -1 || Math.abs(lastY - item.transform[5]) > 5) {
                lastY = item.transform[5];
                text += '\n';
              }
              text += item.str;
            }
            
            return text;
          })
          .catch(function(err) {
            console.warn('Erro ao renderizar página:', err);
            return ''; // Retornar string vazia em caso de erro
          });
      } catch (renderError) {
        console.warn('Erro na função de renderização:', renderError);
        return Promise.resolve(''); // Retornar string vazia em caso de erro
      }
    }
    
    const data = await pdfParse(pdfBuffer, options);
    
    // Pós-processamento para melhorar a qualidade do texto
    let cleanedText = data.text
      .replace(/\s+/g, ' ')         // Remover espaços duplicados
      .replace(/\n\s*\n/g, '\n\n')  // Remover linhas em branco duplicadas
      .trim();
      
    // Se o texto tiver muitos caracteres estranhos, é possível que a extração não tenha funcionado corretamente
    const strangeCharRatio = (cleanedText.match(/[^\x20-\x7E\xC0-\xFF\n]/g) || []).length / cleanedText.length;
    if (strangeCharRatio > 0.15) {
      console.warn(`Alta proporção de caracteres estranhos (${(strangeCharRatio * 100).toFixed(2)}%), resultado pode ser impreciso`);
    }
    
    console.log(`Extração com pdf-parse bem-sucedida: ${data.numpages} páginas`);
    
    return [{ 
      page: 'Resultados', 
      text: cleanedText
    }];
  } catch (error) {
    console.error('Erro ao usar pdf-parse:', error);
    throw error;
  }
}

/**
 * Método 2: Extrair usando pdf-lib para pré-processar o PDF com opções aprimoradas
 * @param {Buffer} pdfBuffer - Buffer do arquivo PDF
 * @returns {Promise<Array>} - Array de objetos com página e texto
 */
async function extractWithPdfLib(pdfBuffer) {
  try {
    // Estratégia 1: Carregar o PDF com opções máximas de tolerância
    let pdfDoc;
    try {
      pdfDoc = await PDFDocument.load(pdfBuffer, { 
        ignoreEncryption: true,
        updateMetadata: false,
        throwOnInvalidObject: false
      });
    } catch (loadError) {
      console.warn('Erro ao carregar PDF com opções padrão, tentando modo de recuperação:', loadError.message);
      
      // Estratégia 2: Se falhou, tentar recuperação mais agressiva
      pdfDoc = await PDFDocument.load(pdfBuffer, { 
        ignoreEncryption: true,
        updateMetadata: false,
        throwOnInvalidObject: false,
        parseSpeed: 100          // Mais lento, mas mais robusto
      });
    }
    
    const pageCount = pdfDoc.getPageCount();
    console.log(`PDF carregado com pdf-lib: ${pageCount} páginas`);
    
    // Criar um novo documento PDF "limpo"
    const newPdfDoc = await PDFDocument.create();
    
    // Copiar todas as páginas para o novo documento
    let pagesAdded = 0;
    for (let i = 0; i < pageCount; i++) {
      try {
        const [copiedPage] = await newPdfDoc.copyPages(pdfDoc, [i]);
        newPdfDoc.addPage(copiedPage);
        pagesAdded++;
      } catch (pageError) {
        console.warn(`Não foi possível copiar a página ${i+1}:`, pageError.message);
        
        // Adicionar uma página em branco para manter a estrutura
        try {
          const blankPage = newPdfDoc.addPage();
          // Adicionar um texto indicando que a página não pôde ser processada
          blankPage.drawText(`[Conteúdo da página ${i+1} não pôde ser processado]`, {
            x: 50,
            y: blankPage.getHeight() / 2,
            size: 12
          });
        } catch (blankError) {
          console.error('Erro ao adicionar página em branco:', blankError);
        }
      }
    }
    
    if (pagesAdded === 0) {
      throw new Error('Não foi possível copiar nenhuma página');
    }
    
    // Salvar o novo documento PDF
    const newPdfBytes = await newPdfDoc.save({
      useObjectStreams: false,  // Pode ajudar com compatibilidade
      addDefaultPage: false
    });
    
    // Tentar extrair texto do PDF limpo com pdf-parse
    try {
      const options = {
        max: 0,
        version: 'v1.10.100'
      };
      
      const cleanedData = await pdfParse(newPdfBytes, options);
      
      // Pós-processamento para melhorar a qualidade do texto
      let cleanedText = cleanedData.text
        .replace(/\s+/g, ' ')
        .replace(/\n\s*\n/g, '\n\n')
        .trim();
        
      return [{ 
        page: 'Resultados', 
        text: cleanedText
      }];
    } catch (parseError) {
      console.error('Erro ao processar PDF limpo com pdf-parse:', parseError);
      throw parseError;
    }
  } catch (error) {
    console.error('Erro ao processar PDF com pdf-lib:', error);
    throw error;
  }
}

/**
 * Método 3: Dividir o PDF em partes menores e tentar extrair cada parte
 * @param {Buffer} pdfBuffer - Buffer do arquivo PDF
 * @returns {Promise<Array>} - Array de objetos com página e texto
 */
async function extractBySplitting(pdfBuffer) {
  try {
    // Carregar o PDF com todas as opções de tolerância ativadas
    const pdfDoc = await PDFDocument.load(pdfBuffer, { 
      ignoreEncryption: true,
      updateMetadata: false,
      throwOnInvalidObject: false
    });
    
    const pageCount = pdfDoc.getPageCount();
    console.log(`PDF carregado para divisão: ${pageCount} páginas`);
    
    if (pageCount === 0) {
      throw new Error('PDF não contém páginas');
    }
    
    // Se o PDF tiver apenas uma página, não há necessidade de dividir
    if (pageCount === 1) {
      return await extractWithPdfParse(pdfBuffer);
    }
    
    // Dividir o PDF em partes menores (cada parte com uma página)
    let combinedText = '';
    let validPages = 0;
    let problemPages = 0;
    
    for (let i = 0; i < pageCount; i++) {
      try {
        console.log(`Processando página ${i+1}/${pageCount}`);
        
        // Criar um novo documento PDF com apenas uma página
        const singlePageDoc = await PDFDocument.create();
        
        try {
          const [copiedPage] = await singlePageDoc.copyPages(pdfDoc, [i]);
          singlePageDoc.addPage(copiedPage);
          
          // Salvar a página como um documento separado
          const pageBytes = await singlePageDoc.save({
            useObjectStreams: false  // Melhor compatibilidade
          });
          
          // Tentar extrair texto desta página
          try {
            const pageOptions = {
              max: 1,  // Apenas uma página
              version: 'v1.10.100'
            };
            
            const pageData = await pdfParse(pageBytes, pageOptions);
            
            // Validar o texto extraído
            if (pageData.text && pageData.text.trim().length > 0) {
              // Adicionar ao texto combinado com cabeçalho de página
              combinedText += `\n\n=== PÁGINA ${i+1} ===\n\n`;
              combinedText += pageData.text.trim() + '\n';
              validPages++;
            } else {
              console.warn(`Página ${i+1}: Texto extraído vazio`);
              problemPages++;
            }
          } catch (pageParseError) {
            console.warn(`Não foi possível extrair texto da página ${i+1}:`, pageParseError.message);
            problemPages++;
          }
        } catch (pageCopyError) {
          console.warn(`Erro ao copiar página ${i+1}:`, pageCopyError.message);
          problemPages++;
        }
      } catch (pageError) {
        console.warn(`Erro ao processar página ${i+1}:`, pageError.message);
        problemPages++;
      }
    }
    
    if (combinedText.trim() === '') {
      throw new Error('Não foi possível extrair texto de nenhuma página');
    }
    
    console.log(`Processamento concluído: ${validPages} páginas válidas, ${problemPages} páginas com problemas`);
    
    return [{ 
      page: 'Resultados', 
      text: combinedText.trim(),
      validPages,
      problemPages,
      totalPages: pageCount
    }];
  } catch (error) {
    console.error('Erro ao dividir e processar PDF:', error);
    throw error;
  }
}

/**
 * Método 4: Extrair apenas metadados básicos como último recurso
 * @param {Buffer} pdfBuffer - Buffer do arquivo PDF
 * @returns {Promise<Array>} - Array de objetos com informações básicas
 */
async function extractBasicMetadata(pdfBuffer) {
  try {
    // Tentar extrair metadados básicos com pdf-lib
    const pdfDoc = await PDFDocument.load(pdfBuffer, { 
      ignoreEncryption: true,
      updateMetadata: false,
      throwOnInvalidObject: false
    });
    
    const pageCount = pdfDoc.getPageCount();
    const isEncrypted = pdfDoc.isEncrypted;
    
    // Tentar ler o número de caracteres no PDF original (estimativa)
    const pdfText = pdfBuffer.toString('utf8', 0, 10000);
    const estimatedTextLength = (pdfText.match(/\(/g) || []).length;
    
    // Criar um texto com informações básicas
    let basicInfo = 'INFORMAÇÕES BÁSICAS DO DOCUMENTO\n\n';
    basicInfo += `Número de páginas: ${pageCount}\n`;
    basicInfo += `Documento protegido: ${isEncrypted ? 'Sim' : 'Não'}\n`;
    basicInfo += `Tamanho do arquivo: ${Math.round(pdfBuffer.length / 1024)} KB\n\n`;
    basicInfo += 'O texto completo deste documento não pôde ser extraído devido a restrições no formato do PDF.\n';
    basicInfo += 'Recomendamos solicitar uma versão alternativa do documento, se possível.\n';
    
    // Tentar extrair alguns trechos de texto do PDF, mesmo que incompletos
    try {
      // Buscar strings que possam indicar nome do paciente
      const patientNameMatch = pdfText.match(/[Pp]aciente\s*[:\-]?\s*([A-Za-z\s]+)/);
      if (patientNameMatch && patientNameMatch[1]) {
        basicInfo += `\nPossível nome do paciente: ${patientNameMatch[1].trim()}\n`;
      }
      
      // Buscar datas no formato DD/MM/YYYY ou YYYY-MM-DD
      const dateMatches = pdfText.match(/\d{2}\/\d{2}\/\d{4}|\d{4}-\d{2}-\d{2}/g);
      if (dateMatches && dateMatches.length > 0) {
        basicInfo += `\nDatas encontradas no documento: ${dateMatches.slice(0, 3).join(', ')}\n`;
      }
    } catch (extractError) {
      console.warn('Erro ao extrair informações adicionais:', extractError);
    }
    
    return [{ 
      page: 'Informações Básicas', 
      text: basicInfo 
    }];
  } catch (error) {
    console.error('Erro ao extrair metadados básicos:', error);
    
    // Se tudo falhar, retornar uma mensagem genérica
    return [{ 
      page: 'Erro de Processamento', 
      text: 'Não foi possível processar este documento. O formato do PDF pode ser incompatível ou o documento pode estar corrompido. Por favor, tente obter uma versão alternativa do documento.'
    }];
  }
}

module.exports = { 
  parsePdf,
  extractWithPdfParse,
  extractWithPdfLib,
  extractBySplitting,
  extractBasicMetadata
};