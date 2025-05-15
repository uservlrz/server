// utils/pdfSizeManager.js - Nova utilidade para gerenciar PDFs grandes
const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const { splitPDF, splitPDFByPages } = require('./pdfSplitter');

/**
 * Classe utilitária para gerenciar PDFs grandes
 */
class PdfSizeManager {
  /**
   * Analisa um PDF e retorna informações sobre seu tamanho e páginas
   * @param {string} filePath - Caminho do arquivo PDF
   * @returns {Promise<Object>} - Objeto com informações do PDF
   */
  static async analyzeSize(filePath) {
    try {
      if (!fs.existsSync(filePath)) {
        throw new Error('Arquivo não encontrado');
      }
      
      const fileStats = fs.statSync(filePath);
      const fileSizeKB = Math.round(fileStats.size / 1024);
      
      let pageCount = 0;
      let avgPageSizeKB = 0;
      
      try {
        // Tentar carregar o PDF para obter contagem de páginas
        const pdfBuffer = fs.readFileSync(filePath);
        const pdfDoc = await PDFDocument.load(pdfBuffer, {
          ignoreEncryption: true,
          updateMetadata: false,
          throwOnInvalidObject: false
        });
        
        pageCount = pdfDoc.getPageCount();
        avgPageSizeKB = Math.round(fileSizeKB / pageCount);
      } catch (error) {
        console.warn('Não foi possível determinar o número de páginas:', error.message);
      }
      
      return {
        sizeKB: fileSizeKB,
        pageCount,
        avgPageSizeKB,
        isLarge: fileSizeKB > 950, // Limite API OCR.space
        isVeryLarge: fileSizeKB > 5000, // PDFs muito grandes (5MB+)
        needsCompression: avgPageSizeKB > 950 // Se cada página excede o limite
      };
    } catch (error) {
      console.error('Erro ao analisar tamanho do PDF:', error);
      throw error;
    }
  }
  
  /**
   * Determina a melhor estratégia de processamento com base no tamanho
   * @param {Object} sizeInfo - Informações de tamanho do PDF
   * @returns {Object} - Estratégia recomendada
   */
  static determineStrategy(sizeInfo) {
    const strategy = {
      recommendedMethod: 'direct', // direto, dividir, ocr, compressão
      pagesPerPart: 1,
      requiresCompression: false,
      compressionLevel: 'normal', // normal, agressivo
      message: ''
    };
    
    if (!sizeInfo.isLarge) {
      // PDF pequeno, processar diretamente
      strategy.message = 'PDF dentro do limite de tamanho, processamento direto';
      return strategy;
    }
    
    if (sizeInfo.isVeryLarge) {
      // PDF muito grande
      strategy.recommendedMethod = 'dividir';
      strategy.pagesPerPart = Math.max(1, Math.floor(950 / sizeInfo.avgPageSizeKB));
      strategy.requiresCompression = true;
      strategy.compressionLevel = 'agressivo';
      strategy.message = `PDF muito grande (${sizeInfo.sizeKB}KB), dividir em ${strategy.pagesPerPart} páginas por parte com compressão agressiva`;
      return strategy;
    }
    
    if (sizeInfo.needsCompression) {
      // Páginas individuais excedem o limite
      if (sizeInfo.avgPageSizeKB > 2000) {
        // Páginas extremamente grandes
        strategy.recommendedMethod = 'ocr';
        strategy.requiresCompression = true;
        strategy.compressionLevel = 'agressivo';
        strategy.message = `Páginas extremamente grandes (${sizeInfo.avgPageSizeKB}KB média), usar OCR com compressão máxima`;
      } else {
        // Páginas grandes mas gerenciáveis
        strategy.recommendedMethod = 'dividir';
        strategy.pagesPerPart = 1; // Uma página por parte
        strategy.requiresCompression = true;
        strategy.message = `Páginas grandes (${sizeInfo.avgPageSizeKB}KB média), dividir em páginas individuais com compressão`;
      }
      return strategy;
    }
    
    // PDF grande mas com páginas pequenas
    strategy.recommendedMethod = 'dividir';
    // Calcular quantas páginas por parte para ficar abaixo do limite
    strategy.pagesPerPart = Math.max(1, Math.floor(950 / sizeInfo.avgPageSizeKB));
    strategy.message = `PDF grande (${sizeInfo.sizeKB}KB) com páginas pequenas, dividir em ${strategy.pagesPerPart} páginas por parte`;
    
    return strategy;
  }
  
  /**
   * Verifica se uma parte do PDF está dentro do limite de tamanho
   * @param {Buffer} pdfBuffer - Buffer da parte do PDF
   * @param {number} maxSizeKB - Tamanho máximo em KB
   * @returns {boolean} - true se estiver dentro do limite
   */
  static isWithinSizeLimit(pdfBuffer, maxSizeKB = 950) {
    const sizeKB = Math.round(pdfBuffer.length / 1024);
    return sizeKB <= maxSizeKB;
  }
  
  /**
   * Gerencia automaticamente o processamento do PDF com base em seu tamanho
   * @param {string} filePath - Caminho do arquivo PDF
   * @param {Function} processorFn - Função para processar cada parte do PDF
   * @param {Object} options - Opções adicionais
   * @returns {Promise<Array>} - Resultados do processamento
   */
  static async processWithSizeManagement(filePath, processorFn, options = {}) {
    try {
      console.log(`Iniciando gerenciamento de tamanho para: ${filePath}`);
      
      // Opções padrão
      const defaultOptions = {
        maxSizeKB: 950,
        pagesPerPart: 1,
        useCompression: true,
        compressionLevel: 'normal', // normal, agressivo
        tempDir: path.dirname(filePath)
      };
      
      const finalOptions = { ...defaultOptions, ...options };
      
      // Analisar tamanho do PDF
      const sizeInfo = await this.analyzeSize(filePath);
      console.log(`Análise de tamanho: ${JSON.stringify(sizeInfo)}`);
      
      // Determinar estratégia
      const strategy = this.determineStrategy(sizeInfo);
      console.log(`Estratégia recomendada: ${JSON.stringify(strategy)}`);
      
      // Implementar estratégia
      const pdfBuffer = fs.readFileSync(filePath);
      const results = [];
      const tempFiles = [];
      
      if (strategy.recommendedMethod === 'direct' && this.isWithinSizeLimit(pdfBuffer, finalOptions.maxSizeKB)) {
        // Processamento direto
        console.log(`Processando PDF diretamente (${sizeInfo.sizeKB}KB)`);
        const result = await processorFn(filePath);
        results.push(result);
      } else if (strategy.recommendedMethod === 'dividir') {
        // Dividir o PDF em partes
        console.log(`Dividindo PDF em partes de ${strategy.pagesPerPart} páginas`);
        
        const pdfParts = await splitPDF(pdfBuffer, strategy.pagesPerPart);
        console.log(`PDF dividido em ${pdfParts.length} partes`);
        
        // Processar cada parte
        for (let i = 0; i < pdfParts.length; i++) {
          const partBuffer = pdfParts[i];
          const partSizeKB = Math.round(partBuffer.length / 1024);
          
          console.log(`Parte ${i+1}/${pdfParts.length}: ${partSizeKB}KB`);
          
          // Comprimir se necessário
          let processBuffer = partBuffer;
          if (strategy.requiresCompression && partSizeKB > finalOptions.maxSizeKB) {
            console.log(`Comprimindo parte ${i+1} (${partSizeKB}KB > ${finalOptions.maxSizeKB}KB)`);
            
            try {
              const compressedBuffer = await this.compressPdf(
                partBuffer, 
                finalOptions.maxSizeKB, 
                strategy.compressionLevel === 'agressivo'
              );
              
              const compressedSizeKB = Math.round(compressedBuffer.length / 1024);
              console.log(`Parte ${i+1} comprimida: ${compressedSizeKB}KB`);
              
              processBuffer = compressedBuffer;
            } catch (compressError) {
              console.error(`Erro ao comprimir parte ${i+1}:`, compressError);
            }
          }
          
          // Salvar em arquivo temporário
          const tempPath = path.join(finalOptions.tempDir, `temp_part_${i+1}_${Date.now()}.pdf`);
          fs.writeFileSync(tempPath, processBuffer);
          tempFiles.push(tempPath);
          
          // Processar esta parte
          try {
            const partResult = await processorFn(tempPath, {
              partIndex: i,
              totalParts: pdfParts.length,
              partSizeKB: Math.round(processBuffer.length / 1024),
              isCompressed: processBuffer !== partBuffer
            });
            
            results.push(partResult);
          } catch (processError) {
            console.error(`Erro ao processar parte ${i+1}:`, processError);
            results.push({
              error: true,
              message: `Erro ao processar parte ${i+1}: ${processError.message}`,
              partIndex: i
            });
          }
          
          // Adicionar um pequeno atraso para evitar sobrecarregar a API
          if (i < pdfParts.length - 1) {
            console.log('Aguardando 1 segundo antes da próxima parte...');
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
      } else if (strategy.recommendedMethod === 'ocr') {
        // Comprimir o PDF para OCR
        console.log('Comprimindo PDF para processamento OCR');
        
        let processBuffer = pdfBuffer;
        if (strategy.requiresCompression) {
          try {
            processBuffer = await this.compressPdf(
              pdfBuffer, 
              finalOptions.maxSizeKB, 
              strategy.compressionLevel === 'agressivo'
            );
            
            const compressedSizeKB = Math.round(processBuffer.length / 1024);
            console.log(`PDF comprimido para OCR: ${compressedSizeKB}KB`);
          } catch (compressError) {
            console.error('Erro ao comprimir PDF para OCR:', compressError);
          }
        }
        
        // Verificar se ainda precisa dividir após compressão
        if (processBuffer.length / 1024 > finalOptions.maxSizeKB) {
          console.log('PDF ainda grande após compressão, dividindo em páginas individuais');
          
          try {
            const pages = await splitPDFByPages(processBuffer);
            console.log(`PDF dividido em ${pages.length} páginas individuais`);
            
            // Processar cada página
            for (let i = 0; i < pages.length; i++) {
              const page = pages[i];
              const pageSizeKB = Math.round(page.buffer.length / 1024);
              
              console.log(`Página ${page.pageNumber}/${pages.length}: ${pageSizeKB}KB`);
              
              // Comprimir página se necessário
              let pageBuffer = page.buffer;
              if (pageSizeKB > finalOptions.maxSizeKB) {
                try {
                  pageBuffer = await this.compressPdf(
                    page.buffer, 
                    finalOptions.maxSizeKB, 
                    true // compressão agressiva para páginas individuais
                  );
                  
                  const reducedSizeKB = Math.round(pageBuffer.length / 1024);
                  console.log(`Página ${page.pageNumber} comprimida: ${reducedSizeKB}KB`);
                } catch (pageCompressError) {
                  console.error(`Erro ao comprimir página ${page.pageNumber}:`, pageCompressError);
                }
              }
              
              // Salvar em arquivo temporário
              const tempPath = path.join(finalOptions.tempDir, `temp_page_${page.pageNumber}_${Date.now()}.pdf`);
              fs.writeFileSync(tempPath, pageBuffer);
              tempFiles.push(tempPath);
              
              // Processar esta página
              try {
                const pageResult = await processorFn(tempPath, {
                  pageNumber: page.pageNumber,
                  totalPages: pages.length,
                  pageSizeKB: Math.round(pageBuffer.length / 1024),
                  isCompressed: pageBuffer !== page.buffer
                });
                
                results.push(pageResult);
              } catch (processError) {
                console.error(`Erro ao processar página ${page.pageNumber}:`, processError);
                results.push({
                  error: true,
                  message: `Erro ao processar página ${page.pageNumber}: ${processError.message}`,
                  pageNumber: page.pageNumber
                });
              }
              
              // Adicionar um pequeno atraso
              if (i < pages.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 1000));
              }
            }
          } catch (splitError) {
            console.error('Erro ao dividir em páginas:', splitError);
            
            // Tentar processar o PDF comprimido diretamente
            console.log('Tentando processar PDF comprimido diretamente');
            
            const tempPath = path.join(finalOptions.tempDir, `temp_compressed_${Date.now()}.pdf`);
            fs.writeFileSync(tempPath, processBuffer);
            tempFiles.push(tempPath);
            
            const result = await processorFn(tempPath, {
              isCompressed: processBuffer !== pdfBuffer,
              sizeKB: Math.round(processBuffer.length / 1024)
            });
            
            results.push(result);
          }
        } else {
          // PDF comprimido está dentro do limite, processar diretamente
          console.log('PDF comprimido dentro do limite, processando diretamente');
          
          const tempPath = path.join(finalOptions.tempDir, `temp_compressed_${Date.now()}.pdf`);
          fs.writeFileSync(tempPath, processBuffer);
          tempFiles.push(tempPath);
          
          const result = await processorFn(tempPath, {
            isCompressed: processBuffer !== pdfBuffer,
            sizeKB: Math.round(processBuffer.length / 1024)
          });
          
          results.push(result);
        }
      }
      
      // Limpar arquivos temporários
      console.log('Limpando arquivos temporários...');
      tempFiles.forEach(tempFile => {
        try {
          if (fs.existsSync(tempFile)) {
            fs.unlinkSync(tempFile);
          }
        } catch (unlinkError) {
          console.error(`Erro ao remover arquivo temporário ${tempFile}:`, unlinkError);
        }
      });
      
      return results;
    } catch (error) {
      console.error('Erro no gerenciamento de tamanho:', error);
      throw error;
    }
  }
  
  /**
   * Comprime um PDF para reduzir seu tamanho
   * @param {Buffer} pdfBuffer - Buffer do PDF original
   * @param {number} targetSizeKB - Tamanho alvo em KB
   * @param {boolean} aggressive - Se deve usar compressão agressiva
   * @returns {Promise<Buffer>} - Buffer do PDF comprimido
   */
  static async compressPdf(pdfBuffer, targetSizeKB = 950, aggressive = false) {
    try {
      // Verificar se já está abaixo do alvo
      const originalSizeKB = Math.round(pdfBuffer.length / 1024);
      if (originalSizeKB <= targetSizeKB) {
        return pdfBuffer;
      }
      
      console.log(`Comprimindo PDF de ${originalSizeKB}KB para menos de ${targetSizeKB}KB${aggressive ? ' (modo agressivo)' : ''}`);
      
      // Carregar o PDF
      const pdfDoc = await PDFDocument.load(pdfBuffer, {
        ignoreEncryption: true,
        updateMetadata: false,
        throwOnInvalidObject: false
      });
      
      // Opções de compressão básica
      const compressionOptions = {
        useObjectStreams: true,
        addDefaultPage: false,
        compress: true
      };
      
      // Adicionar opções de compressão agressiva se necessário
      if (aggressive) {
        Object.assign(compressionOptions, {
          objectsPerTick: 10,
          preserveOutputIntent: false,
          preserveXFA: false
        });
      }
      
      // Salvar com compressão
      const compressedPdfBytes = await pdfDoc.save(compressionOptions);
      const compressedBuffer = Buffer.from(compressedPdfBytes);
      const newSizeKB = Math.round(compressedBuffer.length / 1024);
      
      console.log(`Compressão resultou em ${newSizeKB}KB (redução de ${Math.round((originalSizeKB - newSizeKB) / originalSizeKB * 100)}%)`);
      
      // Se compressão normal não foi suficiente e o modo agressivo foi solicitado
      if (newSizeKB > targetSizeKB && aggressive) {
        console.log('Aplicando técnicas de compressão extrema...');
        
        // Criar um novo documento e copiar apenas o conteúdo essencial
        const newDoc = await PDFDocument.create();
        
        // Copiar as páginas sem metadados e anotações extras
        const pageCount = pdfDoc.getPageCount();
        
        for (let i = 0; i < pageCount; i++) {
          try {
            const [copiedPage] = await newDoc.copyPages(pdfDoc, [i]);
            newDoc.addPage(copiedPage);
          } catch (pageError) {
            console.warn(`Erro ao copiar página ${i+1} durante compressão extrema:`, pageError);
          }
        }
        
        // Salvar com configurações extremamente otimizadas
        const ultraCompressedBytes = await newDoc.save({
          useObjectStreams: true,
          addDefaultPage: false,
          compress: true,
          objectsPerTick: 5
        });
        
        const ultraCompressedBuffer = Buffer.from(ultraCompressedBytes);
        const ultraCompressedSizeKB = Math.round(ultraCompressedBuffer.length / 1024);
        
        console.log(`Compressão extrema resultou em ${ultraCompressedSizeKB}KB`);
        
        if (ultraCompressedSizeKB < newSizeKB) {
          return ultraCompressedBuffer;
        }
      }
      
      return compressedBuffer;
    } catch (error) {
      console.error('Erro ao comprimir PDF:', error);
      return pdfBuffer; // Retornar o buffer original em caso de erro
    }
  }
}

module.exports = PdfSizeManager;