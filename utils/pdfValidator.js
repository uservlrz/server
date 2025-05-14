// utils/pdfValidator.js - Versão aprimorada com validação mais robusta
const fs = require('fs');
const { PDFDocument } = require('pdf-lib');

/**
 * Verifica se um PDF é válido e pode ser processado
 * @param {string} filePath - Caminho do arquivo PDF
 * @returns {Promise<object>} - Objeto contendo status e detalhes da validação
 */
async function validatePdf(filePath) {
  try {
    // Verificar se o arquivo existe
    if (!fs.existsSync(filePath)) {
      return {
        valid: false,
        message: 'Arquivo não encontrado no servidor',
        details: null
      };
    }
    
    // Verificar tamanho do arquivo (PDFs excessivamente grandes podem causar problemas)
    const stats = fs.statSync(filePath);
    const fileSizeInMB = stats.size / (1024 * 1024);
    if (fileSizeInMB > 50) {
      return {
        valid: false,
        message: 'O arquivo PDF é muito grande (máximo 50MB)',
        details: { size: fileSizeInMB }
      };
    }
    
    // Verificar assinatura do arquivo para garantir que é realmente um PDF
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(8);
    fs.readSync(fd, buffer, 0, 8, 0);
    fs.closeSync(fd);
    
    const signature = buffer.toString('ascii', 0, 5);
    if (signature !== '%PDF-') {
      return {
        valid: false,
        message: 'O arquivo não é um PDF válido',
        details: { signature }
      };
    }
    
    // Ler o arquivo como buffer
    const pdfBuffer = fs.readFileSync(filePath);
    
    try {
      // Verificar estrutura do PDF usando pdf-lib com opções permissivas
      const pdfDoc = await PDFDocument.load(pdfBuffer, { 
        ignoreEncryption: true,
        updateMetadata: false,
        throwOnInvalidObject: false
      });
      
      const pageCount = pdfDoc.getPageCount();
      
      // Detectar características específicas do PDF
      const isEncrypted = pdfDoc.isEncrypted;
      const hasXFA = pdfBuffer.includes('XFA');
      const hasAcroForms = pdfBuffer.includes('/AcroForm');
      const isScanned = detectScannedPdf(pdfBuffer);
      
      // Verificar se o PDF tem problemas de estrutura que poderiam afetar a extração
      const structureProblems = detectStructureProblems(pdfBuffer);
      
      return {
        valid: true,
        message: isEncrypted ? 'PDF válido (protegido/criptografado)' : 'PDF válido',
        details: {
          pageCount,
          isEncrypted,
          size: fileSizeInMB,
          version: getPdfVersion(pdfBuffer),
          hasXFA,
          hasAcroForms,
          isScanned,
          structureProblems
        }
      };
    } catch (pdfLibError) {
      // Erro ao carregar com pdf-lib sugere problemas estruturais graves
      console.error('Erro ao validar PDF com pdf-lib:', pdfLibError);
      
      // Verificar o tipo de erro para dar informações mais precisas
      const errorMsg = pdfLibError.message.toLowerCase();
      let problemType = 'formato não suportado';
      
      if (errorMsg.includes('encrypted') || errorMsg.includes('password')) {
        problemType = 'proteção ou criptografia';
      } else if (errorMsg.includes('corrupt') || errorMsg.includes('invalid')) {
        problemType = 'corrupção';
      } else if (errorMsg.includes('linearized') || errorMsg.includes('xref')) {
        problemType = 'estrutura não convencional';
      }
      
      // Tentar uma verificação alternativa mais simples
      const isLikelyValidPdf = isBasicallyValidPdf(pdfBuffer);
      
      if (isLikelyValidPdf) {
        return {
          valid: true,
          message: `PDF válido mas com problemas de ${problemType} (será tentada uma abordagem alternativa)`,
          details: {
            error: pdfLibError.message,
            problemType,
            needsRepair: true
          }
        };
      }
      
      return {
        valid: false,
        message: `O PDF parece ter problemas de ${problemType}`,
        details: {
          error: pdfLibError.message,
          problemType
        }
      };
    }
  } catch (error) {
    console.error('Erro ao validar PDF:', error);
    return {
      valid: false,
      message: 'Erro ao validar o arquivo PDF',
      details: {
        error: error.message
      }
    };
  }
}

/**
 * Detecta se o PDF parece ser um documento escaneado
 * @param {Buffer} pdfBuffer - Buffer do PDF
 * @returns {boolean} - True se o PDF parece ser escaneado
 */
function detectScannedPdf(pdfBuffer) {
  // Verificar strings que indicam um PDF escaneado
  const pdfText = pdfBuffer.toString('latin1', 0, 20000);
  
  // PDFs escaneados geralmente têm imagens DCTDecode (JPEG) ou outras compressões de imagem
  const hasImageCompression = pdfText.includes('/DCTDecode') || 
                              pdfText.includes('/JPXDecode') ||
                              pdfText.includes('/CCITTFaxDecode');
                           
  // PDFs escaneados frequentemente têm poucos objetos de texto
  const lowTextObjCount = (pdfText.match(/\(.*?\)/g) || []).length < 100;
  
  // PDFs escaneados frequentemente usam OCR
  const hasOcrHints = pdfText.includes('OCR') || 
                      pdfText.includes('TextRecognize') ||
                      pdfText.includes('Acrobat Capture');
  
  // Um PDF é provavelmente escaneado se tem compressão de imagem e pouco texto ou indícios de OCR
  return hasImageCompression && (lowTextObjCount || hasOcrHints);
}

/**
 * Detecta problemas comuns na estrutura do PDF
 * @param {Buffer} pdfBuffer - Buffer do PDF
 * @returns {Array} - Array com problemas detectados
 */
function detectStructureProblems(pdfBuffer) {
  const problems = [];
  const pdfText = pdfBuffer.toString('latin1', 0, 20000);
  
  // Verificar referências cruzadas (xref) danificadas
  if (!/xref\s+\d+\s+\d+\s*\n\s*\d{10}\s+\d{5}\s+[fn]/i.test(pdfText)) {
    problems.push('xref_issues');
  }
  
  // Verificar objetos de fluxo potencialmente corrompidos
  if (pdfText.includes('FlateDecode') && 
      pdfText.match(/stream\s*\n.*?\n*endstream/gs)?.length < 5) {
    problems.push('stream_issues');
  }
  
  // Verificar linearização (otimização para web) que pode causar problemas
  if (pdfText.includes('/Linearized')) {
    problems.push('linearized');
  }
  
  // Verificar se há problemas com fontes
  if (pdfText.includes('/Font') && 
      (!pdfText.includes('/FontDescriptor') || !pdfText.includes('/BaseFont'))) {
    problems.push('font_issues');
  }
  
  // Verificar se há muitas advertências de compressão (sinal de corrupção)
  if ((pdfBuffer.toString().match(/Warning: Invalid stream/g) || []).length > 10) {
    problems.push('compression_issues');
  }
  
  return problems;
}

/**
 * Obtém a versão do PDF
 * @param {Buffer} pdfBuffer - Buffer do PDF
 * @returns {string} - Versão do PDF
 */
function getPdfVersion(pdfBuffer) {
  // A versão do PDF está disponível nos primeiros bytes
  const version = pdfBuffer.toString('ascii', 5, 8);
  return version;
}

/**
 * Verifica de forma simplificada se o arquivo parece ser um PDF válido
 * @param {Buffer} pdfBuffer - Buffer do PDF
 * @returns {boolean} - True se o arquivo parece ser um PDF válido
 */
function isBasicallyValidPdf(pdfBuffer) {
  // Verificar assinatura inicial do PDF
  if (!pdfBuffer.toString('ascii', 0, 5).startsWith('%PDF-')) {
    return false;
  }
  
  // Verificar se o arquivo contém estruturas básicas de PDF
  const pdfText = pdfBuffer.toString('ascii', 0, Math.min(20000, pdfBuffer.length));
  
  // Verificar se contém objetos PDF
  const hasObjects = /\d+\s+\d+\s+obj/.test(pdfText);
  
  // Verificar se contém trailer
  const hasTrailer = pdfText.includes('trailer') || pdfText.includes('startxref');
  
  // Verificar páginas
  const hasPages = pdfText.includes('/Pages') || pdfText.includes('/Page');
  
  // Se tiver as estruturas básicas, é provavelmente um PDF
  return hasObjects && hasTrailer && hasPages;
}

/**
 * Tenta reparar um PDF problemático com estratégia aprimorada
 * @param {string} filePath - Caminho do arquivo PDF original
 * @returns {Promise<object>} - Resultado da reparação
 */
async function repairPdf(filePath) {
  const repairedPath = `${filePath}_repaired.pdf`;
  
  try {
    // Analisar a estrutura do PDF para entender os problemas
    const structureInfo = await analyzePdfStructure(filePath);
    console.log('Análise de estrutura do PDF:', structureInfo);
    
    // Ler o PDF original
    const pdfBytes = fs.readFileSync(filePath);
    
    // Estratégia 1: Tentar carregar com tolerância máxima
    let pdfDoc;
    try {
      pdfDoc = await PDFDocument.load(pdfBytes, { 
        ignoreEncryption: true,
        updateMetadata: false,
        throwOnInvalidObject: false
      });
    } catch (firstError) {
      console.warn('Falha na primeira tentativa de carregar o PDF:', firstError.message);
      
      // Estratégia 2: Se o problema parece ser criptografia, tentar senhas comuns
      if (firstError.message.toLowerCase().includes('encrypt') || 
          firstError.message.toLowerCase().includes('password')) {
        
        const commonPasswords = ['', '1234', 'admin', 'password', 'pdf', 'exame', 'laudo'];
        for (const password of commonPasswords) {
          try {
            pdfDoc = await PDFDocument.load(pdfBytes, { 
              password,
              updateMetadata: false,
              throwOnInvalidObject: false
            });
            console.log(`PDF carregado com senha: "${password}"`);
            break;
          } catch (e) {
            // Continuar tentando
          }
        }
      }
      
      // Se ainda não conseguimos carregar, tentar uma estratégia mais agressiva
      if (!pdfDoc) {
        // Tentar interpretar o PDF manualmente
        const modifiedPdfBytes = fixCommonPdfIssues(pdfBytes);
        
        try {
          pdfDoc = await PDFDocument.load(modifiedPdfBytes, { 
            ignoreEncryption: true,
            updateMetadata: false,
            throwOnInvalidObject: false
          });
          console.log('PDF carregado após correções manuais');
        } catch (thirdError) {
          console.error('Todas as tentativas de carregar o PDF falharam', thirdError);
          throw thirdError;
        }
      }
    }
    
    // Criar um novo documento PDF do zero
    const newPdfDoc = await PDFDocument.create();
    
    // Copiar todas as páginas para o novo documento
    const pageCount = pdfDoc.getPageCount();
    let pagesAdded = 0;
    
    for (let i = 0; i < pageCount; i++) {
      try {
        const [copiedPage] = await newPdfDoc.copyPages(pdfDoc, [i]);
        newPdfDoc.addPage(copiedPage);
        pagesAdded++;
      } catch (pageError) {
        console.warn(`Não foi possível copiar a página ${i+1}:`, pageError.message);
        
        // Adicionar uma página em branco com mensagem
        try {
          const blankPage = newPdfDoc.addPage();
          blankPage.drawText(`[Página ${i+1} danificada]`, {
            x: 50,
            y: blankPage.getHeight() / 2,
            size: 12
          });
        } catch (blankError) {
          console.error('Erro ao adicionar página em branco:', blankError);
        }
      }
    }
    
    // Se não conseguimos copiar nenhuma página, falha
    if (pagesAdded === 0) {
      throw new Error('Não foi possível copiar nenhuma página do documento original');
    }
    
    // Salvar o novo documento PDF com opções para maximizar compatibilidade
    const newPdfBytes = await newPdfDoc.save({
      useObjectStreams: false,  // Melhor compatibilidade
      addDefaultPage: false,
      updateMetadata: false
    });
    
    fs.writeFileSync(repairedPath, newPdfBytes);
    
    return {
      success: true,
      message: `PDF reparado com sucesso (${pagesAdded} de ${pageCount} páginas)`,
      repairedPath,
      pageCount,
      pagesAdded,
      structureInfo
    };
  } catch (error) {
    console.error('Erro ao reparar PDF:', error);
    
    // Se o arquivo reparado foi criado parcialmente, remova-o
    if (fs.existsSync(repairedPath)) {
      fs.unlinkSync(repairedPath);
    }
    
    return {
      success: false,
      message: 'Não foi possível reparar o PDF',
      error: error.message
    };
  }
}

/**
 * Tenta corrigir problemas comuns de PDF diretamente nos bytes
 * @param {Buffer} pdfBuffer - Buffer do PDF original
 * @returns {Buffer} - Buffer do PDF corrigido
 */
function fixCommonPdfIssues(pdfBuffer) {
  try {
    // Converter para string para manipulação
    let pdfContent = pdfBuffer.toString('latin1');
    
    // Corrigir problemas comuns
    
    // 1. Falhas na tabela xref - reconstruir referências
    if (!pdfContent.includes('xref\n0 ')) {
      // Adicionar uma tabela xref corrigida antes do trailer
      const trailerPos = pdfContent.lastIndexOf('trailer');
      if (trailerPos > 0) {
        // Contar objetos no documento
        const objMatches = pdfContent.match(/\d+\s+\d+\s+obj/g) || [];
        const objCount = objMatches.length + 1;
        
        // Criar uma tabela xref básica
        let xrefTable = `xref\n0 ${objCount}\n`;
        xrefTable += `0000000000 65535 f\n`;
        
        for (let i = 1; i < objCount; i++) {
          // Offset fictício - não ideal, mas pode ajudar em alguns casos
          xrefTable += `0000000001 00000 n\n`;
        }
        
        // Inserir a tabela xref corrigida
        pdfContent = pdfContent.slice(0, trailerPos) + xrefTable + pdfContent.slice(trailerPos);
      }
    }
    
    // 2. Corrigir streams danificados - remover streams problemáticos
    pdfContent = pdfContent.replace(/stream\s*\n[\x00-\xFF]{0,50}?endstream/g, 'stream\nendstream');
    
    // 3. Remover referências à criptografia
    pdfContent = pdfContent.replace(/\/Encrypt\s+\d+\s+\d+\s+R/g, '');
    pdfContent = pdfContent.replace(/\/Encrypt\s*<<[^>]*>>/g, '');
    
    // 4. Corrigir dicionário de informações
    if (pdfContent.includes('/Info')) {
      pdfContent = pdfContent.replace(/\/Info\s+(\d+)\s+(\d+)\s+R/g, '');
    }
    
    // Voltar para buffer
    return Buffer.from(pdfContent, 'latin1');
  } catch (error) {
    console.error('Erro ao corrigir problemas do PDF:', error);
    return pdfBuffer; // Retornar o buffer original em caso de erro
  }
}

/**
 * Verifica características específicas de um PDF que possam causar problemas
 * @param {string} filePath - Caminho do arquivo PDF
 * @returns {Promise<object>} - Detalhes do PDF
 */
async function analyzePdfStructure(filePath) {
  try {
    // Ler os primeiros 1024 bytes do arquivo para análise rápida
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(1024);
    fs.readSync(fd, buffer, 0, 1024, 0);
    fs.closeSync(fd);
    
    const header = buffer.toString('ascii', 0, 8);
    
    // Verificar se o PDF começa com a assinatura correta
    const isValidHeader = header.startsWith('%PDF-');
    const pdfVersion = isValidHeader ? header.substring(5, 8) : null;
    
    // Verificar se o arquivo contém strings que indicam proteção
    const fullContent = fs.readFileSync(filePath, 'latin1').slice(0, 20000);
    const hasEncryption = fullContent.includes('/Encrypt') || 
                         fullContent.includes('/Encryption') ||
                         fullContent.includes('/Filter /Standard');
    
    // Verificar se o PDF contém fontes incorporadas
    const hasEmbeddedFonts = fullContent.includes('/FontFile') || 
                             fullContent.includes('/FontFile2') ||
                             fullContent.includes('/FontFile3');
    
    // Verificar se o PDF contém imagens (podem causar problemas de processamento)
    const hasImages = fullContent.includes('/XObject') || 
                      fullContent.includes('/Subtype /Image');
    
    // Verificar se parece ser um PDF gerado por scanner (OCR)
    const isLikelyScanned = fullContent.includes('/DCTDecode') && 
                           (fullContent.match(/\(.*?\)/g) || []).length < 100;
    
    // Verificar linearização (web-optimized)
    const isLinearized = fullContent.includes('/Linearized');
    
    // Verificar streams potencialmente problemáticos
    const hasFlateDecodeIssues = (fullContent.match(/Warning.*flate/g) || []).length > 0;
    
    // Verificar referências cruzadas
    const hasXrefIssues = !/xref\s+\d+\s+\d+\s*\n\s*\d{10}\s+\d{5}\s+[fn]/i.test(fullContent);
    
    return {
      isValidHeader,
      pdfVersion,
      hasEncryption,
      hasEmbeddedFonts,
      hasImages,
      isLikelyScanned,
      isLinearized,
      hasFlateDecodeIssues,
      hasXrefIssues,
      fileSize: fs.statSync(filePath).size
    };
  } catch (error) {
    console.error('Erro ao analisar estrutura do PDF:', error);
    return {
      error: error.message
    };
  }
}

module.exports = { validatePdf, repairPdf, analyzePdfStructure };