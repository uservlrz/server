// utils/pdfSplitter.js - Versão aprimorada para melhor tratamento de PDFs problemáticos
const fs = require('fs');
const { PDFDocument } = require('pdf-lib');

/**
 * Divide um PDF em partes menores para processamento mais fácil com manipulação aprimorada de erros
 * @param {Buffer} pdfBuffer - Buffer do arquivo PDF original
 * @param {number} pagesPerPart - Número de páginas por parte (padrão: 5)
 * @returns {Promise<Array<Buffer>>} - Array de buffers, um para cada parte do PDF
 */
async function splitPDF(pdfBuffer, pagesPerPart = 5) {
  try {
    console.log(`Tentando dividir o PDF em partes de ${pagesPerPart} páginas...`);
    
    // Carregar o PDF original com opções para ignorar criptografia e outros problemas
    let originalPdfDoc;
    try {
      originalPdfDoc = await PDFDocument.load(pdfBuffer, { 
        ignoreEncryption: true,
        updateMetadata: false,
        throwOnInvalidObject: false
      });
    } catch (loadError) {
      console.warn('Erro ao carregar PDF para divisão:', loadError.message);
      
      // Tentar carregar com senhas comuns
      const commonPasswords = ['', '1234', 'admin', 'password', 'pdf', 'exame', 'laudo'];
      for (const password of commonPasswords) {
        try {
          originalPdfDoc = await PDFDocument.load(pdfBuffer, { 
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
      
      // Se ainda não conseguimos carregar, tentar uma última opção
      if (!originalPdfDoc) {
        try {
          // Tentar uma abordagem mais agressiva
          originalPdfDoc = await PDFDocument.load(pdfBuffer, { 
            ignoreEncryption: true,
            updateMetadata: false,
            throwOnInvalidObject: false,
            parseSpeed: 150 // Mais lento, mas mais robusto
          });
        } catch (finalError) {
          console.error('Falha em todas as tentativas de carregar o PDF:', finalError);
          
          // Se não conseguir carregar para divisão em partes, retornar o PDF original como uma única parte
          console.log('PDF não pôde ser carregado para divisão, retornando como parte única');
          return [pdfBuffer];
        }
      }
    }
    
    const pageCount = originalPdfDoc.getPageCount();
    console.log(`PDF original tem ${pageCount} páginas`);
    
    // Se o PDF tiver poucas páginas, não dividir
    if (pageCount <= pagesPerPart) {
      console.log('PDF tem poucas páginas, não será dividido');
      return [pdfBuffer];
    }
    
    // Verificar se o tamanho do PDF já é pequeno (<1MB)
    if (pdfBuffer.length < 1024 * 1024) {
      console.log('PDF já é pequeno, não será dividido');
      return [pdfBuffer];
    }
    
    // Determinar quantas partes teremos
    const numberOfParts = Math.ceil(pageCount / pagesPerPart);
    console.log(`Dividindo em ${numberOfParts} partes`);
    
    // Array para armazenar as partes do PDF
    const pdfParts = [];
    
    // Dividir o PDF em partes menores
    for (let i = 0; i < numberOfParts; i++) {
      try {
        // Criar um novo documento PDF com opções para maximizar compatibilidade
        const newPdfDoc = await PDFDocument.create();
        
        // Determinar as páginas para esta parte
        const startPage = i * pagesPerPart;
        const endPage = Math.min((i + 1) * pagesPerPart, pageCount);
        
        // Copiar as páginas do PDF original
        let pagesAdded = 0;
        
        for (let pageIndex = startPage; pageIndex < endPage; pageIndex++) {
          try {
            const [copiedPage] = await newPdfDoc.copyPages(originalPdfDoc, [pageIndex]);
            newPdfDoc.addPage(copiedPage);
            pagesAdded++;
          } catch (pageError) {
            console.warn(`Não foi possível copiar a página ${pageIndex + 1}:`, pageError.message);
            
            // Adicionar uma página em branco para manter a estrutura
            try {
              const blankPage = newPdfDoc.addPage();
              // Adicionar mensagem indicando problema
              blankPage.drawText(`[Conteúdo da página ${pageIndex + 1} não pôde ser processado]`, {
                x: 50,
                y: blankPage.getHeight() / 2,
                size: 12
              });
            } catch (blankError) {
              console.error('Erro ao adicionar página em branco:', blankError);
            }
          }
        }
        
        // Verificar se conseguimos adicionar pelo menos uma página
        if (pagesAdded > 0 || newPdfDoc.getPageCount() > 0) {
          // Salvar esta parte como um buffer com opções para maximizar compatibilidade
          const pdfBytes = await newPdfDoc.save({
            useObjectStreams: false,
            addDefaultPage: false
          });
          
          pdfParts.push(Buffer.from(pdfBytes));
          console.log(`Parte ${i+1}/${numberOfParts} criada (páginas ${startPage+1}-${endPage})`);
        } else {
          console.warn(`Não foi possível adicionar nenhuma página para a parte ${i+1}`);
        }
      } catch (partError) {
        console.error(`Erro ao criar parte ${i+1}:`, partError);
      }
    }
    
    // Verificar se conseguimos criar pelo menos uma parte
    if (pdfParts.length === 0) {
      console.warn('Não foi possível criar nenhuma parte válida do PDF, retornando o PDF original');
      return [pdfBuffer];
    }
    
    return pdfParts;
  } catch (error) {
    console.error('Erro ao dividir o PDF:', error);
    
    // Se ocorrer erro na divisão, retornaremos o PDF original como uma única parte
    console.log('Falha na divisão, retornando o PDF original como uma única parte...');
    return [pdfBuffer];
  }
}

/**
 * Divide um PDF por páginas individuais com tratamento aprimorado de erros
 * @param {Buffer} pdfBuffer - Buffer do arquivo PDF original
 * @returns {Promise<Array<{pageNumber: number, buffer: Buffer}>>} - Array de objetos com número da página e buffer
 */
async function splitPDFByPages(pdfBuffer) {
  try {
    // Carregar o PDF original com opções para maximizar compatibilidade
    let originalPdfDoc;
    try {
      originalPdfDoc = await PDFDocument.load(pdfBuffer, { 
        ignoreEncryption: true,
        updateMetadata: false,
        throwOnInvalidObject: false
      });
    } catch (loadError) {
      console.warn('Erro ao carregar PDF para divisão por páginas:', loadError.message);
      
      // Tentar outras opções (similar ao método splitPDF)
      const commonPasswords = ['', '1234', 'admin', 'password', 'pdf', 'exame', 'laudo'];
      let loaded = false;
      
      for (const password of commonPasswords) {
        try {
          originalPdfDoc = await PDFDocument.load(pdfBuffer, { 
            password,
            updateMetadata: false,
            throwOnInvalidObject: false
          });
          loaded = true;
          console.log(`PDF carregado com senha: "${password}"`);
          break;
        } catch (e) {
          // Continuar tentando
        }
      }
      
      if (!loaded) {
        try {
          // Tentar uma abordagem mais agressiva
          originalPdfDoc = await PDFDocument.load(pdfBuffer, { 
            ignoreEncryption: true,
            updateMetadata: false,
            throwOnInvalidObject: false,
            parseSpeed: 150 // Mais lento, mas mais robusto
          });
          loaded = true;
        } catch (finalError) {
          throw new Error('Não foi possível carregar o PDF para divisão por páginas: ' + finalError.message);
        }
      }
    }
    
    const pageCount = originalPdfDoc.getPageCount();
    console.log(`Dividindo PDF em ${pageCount} páginas individuais`);
    
    // Array para armazenar cada página como um PDF separado
    const pages = [];
    
    // Processar cada página individualmente
    for (let i = 0; i < pageCount; i++) {
      try {
        // Criar um novo documento PDF para esta página
        const singlePageDoc = await PDFDocument.create();
        
        // Tentar copiar a página do PDF original
        try {
          const [copiedPage] = await singlePageDoc.copyPages(originalPdfDoc, [i]);
          singlePageDoc.addPage(copiedPage);
        } catch (copyError) {
          console.warn(`Erro ao copiar página ${i+1}:`, copyError.message);
          
          // Adicionar página em branco com mensagem indicando problemas
          const blankPage = singlePageDoc.addPage();
          blankPage.drawText(`[Conteúdo da página ${i+1} não pôde ser processado]`, {
            x: 50,
            y: blankPage.getHeight() / 2,
            size: 12
          });
        }
        
        // Salvar esta página como um buffer com opções para maximizar compatibilidade
        const pdfBytes = await singlePageDoc.save({
          useObjectStreams: false,
          addDefaultPage: false
        });
        
        pages.push({
          pageNumber: i + 1,
          buffer: Buffer.from(pdfBytes)
        });
        
        console.log(`Página ${i+1}/${pageCount} processada com sucesso`);
      } catch (pageError) {
        console.warn(`Erro ao processar página ${i+1}:`, pageError.message);
      }
    }
    
    // Verificar se conseguimos processar pelo menos uma página
    if (pages.length === 0) {
      throw new Error('Não foi possível processar nenhuma página do PDF');
    }
    
    return pages;
  } catch (error) {
    console.error('Erro ao dividir o PDF por páginas:', error);
    throw error;
  }
}

/**
 * Tenta reconstruir um PDF com problemas combinando páginas de diferentes partes
 * @param {Buffer} pdfBuffer - Buffer do PDF original
 * @returns {Promise<Buffer>} - Buffer do PDF reconstruído
 */
async function reconstructProblemPdf(pdfBuffer) {
  try {
    console.log('Tentando reconstruir PDF com problemas...');
    
    // Dividir em páginas individuais
    const pages = await splitPDFByPages(pdfBuffer);
    console.log(`PDF dividido em ${pages.length} páginas individuais`);
    
    // Criar um novo PDF para reconstrução
    const newPdfDoc = await PDFDocument.create();
    
    // Contadores para relatório
    let successPages = 0;
    let failedPages = 0;
    
    // Tentar adicionar cada página individualmente
    for (const page of pages) {
      try {
        // Carregar o PDF de página única
        const pageDoc = await PDFDocument.load(page.buffer, {
          ignoreEncryption: true,
          updateMetadata: false,
          throwOnInvalidObject: false
        });
        
        // Copiar a página para o novo documento
        if (pageDoc.getPageCount() > 0) {
          const [copiedPage] = await newPdfDoc.copyPages(pageDoc, [0]);
          newPdfDoc.addPage(copiedPage);
          successPages++;
        } else {
          throw new Error('PDF de página única não contém páginas');
        }
      } catch (pageError) {
        console.warn(`Erro ao adicionar página ${page.pageNumber}:`, pageError.message);
        failedPages++;
        
        // Adicionar página em branco para manter a estrutura
        const blankPage = newPdfDoc.addPage();
        blankPage.drawText(`[Página ${page.pageNumber} não pôde ser recuperada]`, {
          x: 50,
          y: blankPage.getHeight() / 2,
          size: 12
        });
      }
    }
    
    // Verificar se conseguimos reconstruir alguma página
    if (successPages === 0) {
      throw new Error('Não foi possível reconstruir nenhuma página do PDF');
    }
    
    console.log(`PDF reconstruído com ${successPages} páginas recuperadas e ${failedPages} páginas com falha`);
    
    // Salvar o novo documento
    const newPdfBytes = await newPdfDoc.save({
      useObjectStreams: false,
      addDefaultPage: false
    });
    
    return Buffer.from(newPdfBytes);
  } catch (error) {
    console.error('Erro ao reconstruir PDF problemático:', error);
    throw error;
  }
}

/**
 * Tenta otimizar a estrutura de um PDF para melhor processamento
 * @param {Buffer} pdfBuffer - Buffer do PDF original
 * @returns {Promise<Buffer>} - Buffer do PDF otimizado
 */
async function optimizePdfStructure(pdfBuffer) {
  try {
    console.log('Tentando otimizar estrutura do PDF...');
    
    // Carregar o PDF com opções máximas de tolerância
    const pdfDoc = await PDFDocument.load(pdfBuffer, {
      ignoreEncryption: true,
      updateMetadata: false,
      throwOnInvalidObject: false
    });
    
    // Criar um novo documento simplificado
    const newPdfDoc = await PDFDocument.create();
    
    // Copiar apenas o conteúdo essencial - páginas sem anotações extras
    const pageCount = pdfDoc.getPageCount();
    let pagesAdded = 0;
    
    for (let i = 0; i < pageCount; i++) {
      try {
        // Copiar página
        const [copiedPage] = await newPdfDoc.copyPages(pdfDoc, [i]);
        newPdfDoc.addPage(copiedPage);
        pagesAdded++;
      } catch (pageError) {
        console.warn(`Erro ao copiar página ${i+1} durante otimização:`, pageError.message);
      }
    }
    
    if (pagesAdded === 0) {
      throw new Error('Não foi possível copiar nenhuma página durante otimização');
    }
    
    // Salvar o documento otimizado com opções para maximizar compatibilidade
    const newPdfBytes = await newPdfDoc.save({
      useObjectStreams: false,         // Desativar streams de objetos para melhor compatibilidade
      addDefaultPage: false,           // Não adicionar páginas padrão
      preserveOutputIntent: false,     // Remover informações de intenção de saída
      preserveXFA: false,              // Remover XFA (formulários XML)
      omitXrefTable: false,            // Incluir tabela xref para maior compatibilidade
      objectsPerTick: 50               // Processar menos objetos por tick para maior estabilidade
    });
    
    console.log(`PDF otimizado: ${pagesAdded} páginas processadas de ${pageCount}`);
    return Buffer.from(newPdfBytes);
  } catch (error) {
    console.error('Erro ao otimizar estrutura do PDF:', error);
    return pdfBuffer; // Retornar o buffer original em caso de erro
  }
}

/**
 * Salva partes do PDF em arquivos temporários para processamento
 * @param {Array<Buffer>} pdfParts - Array de buffers das partes do PDF
 * @param {string} basePath - Caminho base para salvar os arquivos
 * @returns {Promise<Array<string>>} - Array com os caminhos dos arquivos temporários
 */
async function savePdfPartsToFiles(pdfParts, basePath) {
  const filePaths = [];
  
  for (let i = 0; i < pdfParts.length; i++) {
    const partPath = `${basePath}_part_${i+1}.pdf`;
    
    try {
      fs.writeFileSync(partPath, pdfParts[i]);
      filePaths.push(partPath);
      console.log(`Parte ${i+1} salva em ${partPath}`);
    } catch (writeError) {
      console.error(`Erro ao salvar parte ${i+1}:`, writeError);
    }
  }
  
  return filePaths;
}

/**
 * Remove arquivos temporários das partes do PDF
 * @param {Array<string>} filePaths - Array com os caminhos dos arquivos temporários
 */
function cleanupTempFiles(filePaths) {
  for (const filePath of filePaths) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`Arquivo temporário removido: ${filePath}`);
      }
    } catch (unlinkError) {
      console.error(`Erro ao remover arquivo temporário ${filePath}:`, unlinkError);
    }
  }
}

module.exports = {
  splitPDF,
  splitPDFByPages,
  reconstructProblemPdf,
  optimizePdfStructure,
  savePdfPartsToFiles,
  cleanupTempFiles
};