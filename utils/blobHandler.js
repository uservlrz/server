// utils/blobHandler.js - Versão Corrigida com Retry e Fallback
const { put, del } = require('@vercel/blob');

/**
 * Salva um PDF no Vercel Blob
 * @param {Buffer} pdfBuffer - Buffer do arquivo PDF
 * @param {string} filename - Nome do arquivo
 * @returns {Promise<Object>} - Objeto com URL e informações do blob
 */
async function savePdfToBlob(pdfBuffer, filename) {
  try {
    console.log(`Salvando PDF no Blob: ${filename}, tamanho: ${(pdfBuffer.length / 1024 / 1024).toFixed(2)}MB`);
    
    // Gerar nome único para evitar conflitos
    const uniqueFilename = `${Date.now()}-${filename}`;
    
    // Salvar no Vercel Blob
    const blob = await put(uniqueFilename, pdfBuffer, {
      access: 'public',
      contentType: 'application/pdf',
      addRandomSuffix: false // Já temos timestamp
    });
    
    console.log(`PDF salvo no Blob: ${blob.url}`);
    
    return {
      url: blob.url,
      filename: uniqueFilename,
      originalFilename: filename,
      size: pdfBuffer.length,
      uploadedAt: new Date().toISOString()
    };
    
  } catch (error) {
    console.error('Erro ao salvar PDF no Blob:', error);
    throw new Error(`Falha ao salvar arquivo no storage: ${error.message}`);
  }
}

/**
 * Baixa um PDF do Vercel Blob com retry automático
 * @param {string} blobUrl - URL do blob
 * @param {number} maxRetries - Número máximo de tentativas
 * @returns {Promise<Buffer>} - Buffer do arquivo PDF
 */
async function downloadPdfFromBlob(blobUrl, maxRetries = 3) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Baixando PDF do Blob (tentativa ${attempt}/${maxRetries}): ${blobUrl}`);
      
      const response = await fetch(blobUrl, {
        timeout: 30000, // 30 segundos timeout
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; PDFProcessor/1.0)',
        }
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const arrayBuffer = await response.arrayBuffer();
      const pdfBuffer = Buffer.from(arrayBuffer);
      
      console.log(`PDF baixado com sucesso, tamanho: ${(pdfBuffer.length / 1024 / 1024).toFixed(2)}MB`);
      
      return pdfBuffer;
      
    } catch (error) {
      lastError = error;
      console.warn(`Tentativa ${attempt}/${maxRetries} falhou:`, error.message);
      
      if (attempt < maxRetries) {
        const waitTime = attempt * 2000; // 2s, 4s, 6s...
        console.log(`Aguardando ${waitTime}ms antes da próxima tentativa...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  
  console.error('Todas as tentativas de download falharam:', lastError);
  throw new Error(`Falha ao baixar arquivo após ${maxRetries} tentativas: ${lastError.message}`);
}

/**
 * Remove um PDF do Vercel Blob
 * @param {string} blobUrl - URL do blob para remover
 * @returns {Promise<boolean>} - True se removido com sucesso
 */
async function deletePdfFromBlob(blobUrl) {
  try {
    console.log(`Removendo PDF do Blob: ${blobUrl}`);
    
    await del(blobUrl);
    
    console.log('PDF removido do Blob com sucesso');
    return true;
    
  } catch (error) {
    console.error('Erro ao remover PDF do Blob:', error);
    // Não falhamos o processo se a limpeza falhar
    return false;
  }
}

/**
 * Verifica se um arquivo é grande demais para upload direto
 * @param {number} fileSize - Tamanho do arquivo em bytes
 * @param {boolean} isVercel - Se está rodando no Vercel
 * @returns {boolean} - True se deve usar blob
 */
function shouldUseBlob(fileSize, isVercel = true) {
  const VERCEL_LIMIT = 4 * 1024 * 1024; // 4MB
  const BLOB_THRESHOLD = 3 * 1024 * 1024; // 3MB (margem de segurança)
  
  if (!isVercel) {
    return false; // Local pode usar upload direto
  }
  
  return fileSize > BLOB_THRESHOLD;
}

/**
 * Processa um PDF usando Vercel Blob (para arquivos grandes) com fallback
 * @param {Buffer} pdfBuffer - Buffer do PDF
 * @param {string} filename - Nome do arquivo
 * @param {Function} processingFunction - Função que processa o PDF
 * @returns {Promise<Object>} - Resultado do processamento
 */
async function processLargePdfWithBlob(pdfBuffer, filename, processingFunction) {
  let blobInfo = null;
  
  try {
    // Salvar no blob
    blobInfo = await savePdfToBlob(pdfBuffer, filename);
    
    // Tentativa 1: Baixar do blob e processar
    try {
      const downloadedBuffer = await downloadPdfFromBlob(blobInfo.url, 3);
      const results = await processingFunction(downloadedBuffer, filename);
      
      // Adicionar informações do blob aos resultados
      results.blobInfo = {
        url: blobInfo.url,
        size: blobInfo.size,
        uploadedAt: blobInfo.uploadedAt,
        processedViaBlob: true
      };
      
      return results;
      
    } catch (downloadError) {
      console.error('Falha no download do Blob, tentando processar buffer original:', downloadError);
      
      // FALLBACK: Se download falhar, processar o buffer original
      console.log('FALLBACK: Processando buffer original sem usar Blob...');
      
      const results = await processingFunction(pdfBuffer, filename);
      
      // Marcar como processado via fallback
      results.blobInfo = {
        url: blobInfo.url,
        size: blobInfo.size,
        uploadedAt: blobInfo.uploadedAt,
        processedViaBlob: false,
        fallbackUsed: true,
        fallbackReason: 'Download do Blob falhou'
      };
      
      return results;
    }
    
  } catch (error) {
    console.error('Erro no processamento via Blob:', error);
    
    // FALLBACK COMPLETO: Se tudo falhar, processar diretamente
    console.log('FALLBACK COMPLETO: Processando sem Blob...');
    
    try {
      const results = await processingFunction(pdfBuffer, filename);
      results.blobInfo = {
        processedViaBlob: false,
        fallbackUsed: true,
        fallbackReason: 'Falha completa no Blob: ' + error.message
      };
      return results;
    } catch (fallbackError) {
      console.error('Fallback também falhou:', fallbackError);
      throw new Error(`Falha no Blob e no fallback: ${error.message} | ${fallbackError.message}`);
    }
    
  } finally {
    // Limpar blob após processamento (opcional)
    if (blobInfo && blobInfo.url) {
      // Aguardar um pouco antes de limpar para garantir que o processamento terminou
      setTimeout(async () => {
        try {
          await deletePdfFromBlob(blobInfo.url);
        } catch (cleanupError) {
          console.warn('Erro na limpeza do blob:', cleanupError);
        }
      }, 5000); // 5 segundos
    }
  }
}

/**
 * Valida se o arquivo pode ser processado via blob
 * @param {Buffer} pdfBuffer - Buffer do PDF
 * @param {string} filename - Nome do arquivo
 * @returns {Object} - Resultado da validação
 */
function validatePdfForBlob(pdfBuffer, filename) {
  const MAX_BLOB_SIZE = 100 * 1024 * 1024; // 100MB (limite do Vercel Blob)
  const fileSizeMB = pdfBuffer.length / (1024 * 1024);
  
  if (pdfBuffer.length > MAX_BLOB_SIZE) {
    return {
      valid: false,
      error: `Arquivo muito grande (${fileSizeMB.toFixed(2)}MB). Máximo permitido: 100MB`,
      size: fileSizeMB
    };
  }
  
  if (!filename.toLowerCase().endsWith('.pdf')) {
    return {
      valid: false,
      error: 'Apenas arquivos PDF são suportados',
      size: fileSizeMB
    };
  }
  
  return {
    valid: true,
    size: fileSizeMB,
    shouldUseBlob: fileSizeMB > 3 // >3MB usa blob
  };
}

module.exports = {
  savePdfToBlob,
  downloadPdfFromBlob,
  deletePdfFromBlob,
  shouldUseBlob,
  processLargePdfWithBlob,
  validatePdfForBlob
};