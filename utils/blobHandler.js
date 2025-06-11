// utils/blobHandler.js - Versão melhorada com tratamento robusto de erros
const { put, del } = require('@vercel/blob');

/**
 * Verifica se as variáveis de ambiente do Blob estão configuradas
 * @returns {boolean} - True se configurado
 */
function isBlobConfigured() {
  return !!(process.env.VERCEL_BLOB_READ_WRITE_TOKEN || process.env.BLOB_READ_WRITE_TOKEN);
}

/**
 * Salva um PDF no Vercel Blob com verificação de ambiente
 * @param {Buffer} pdfBuffer - Buffer do arquivo PDF
 * @param {string} filename - Nome do arquivo
 * @returns {Promise<Object>} - Objeto com URL e informações do blob  
 */
async function savePdfToBlob(pdfBuffer, filename) {
  try {
    if (!isBlobConfigured()) {
      throw new Error('Vercel Blob não configurado - verifique VERCEL_BLOB_READ_WRITE_TOKEN');
    }
    
    console.log(`💾 Salvando PDF no Blob: ${filename}, tamanho: ${(pdfBuffer.length / 1024 / 1024).toFixed(2)}MB`);
    
    // Validar buffer
    if (!Buffer.isBuffer(pdfBuffer)) {
      throw new Error('pdfBuffer deve ser um Buffer válido');
    }
    
    if (pdfBuffer.length === 0) {
      throw new Error('Buffer PDF está vazio');
    }
    
    // Gerar nome único
    const uniqueFilename = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}-${filename}`;
    
    // Salvar no Vercel Blob
    const blob = await put(uniqueFilename, pdfBuffer, {
      access: 'public',
      contentType: 'application/pdf',
      addRandomSuffix: false
    });
    
    console.log(`✅ PDF salvo no Blob: ${blob.url}`);
    
    return {
      url: blob.url,
      filename: uniqueFilename,
      originalFilename: filename,
      size: pdfBuffer.length,
      uploadedAt: new Date().toISOString()
    };
    
  } catch (error) {
    console.error('❌ Erro ao salvar PDF no Blob:', error.message);
    
    // Adicionar contexto ao erro
    if (error.message.includes('Network')) {
      throw new Error(`Falha de rede ao salvar no Blob: ${error.message}`);
    }
    
    if (error.message.includes('authentication') || error.message.includes('unauthorized')) {
      throw new Error('Erro de autenticação do Blob - verifique o token');
    }
    
    throw new Error(`Falha ao salvar no Blob: ${error.message}`);
  }
}

/**
 * Baixa um PDF do Vercel Blob com retry automático e timeout
 * @param {string} blobUrl - URL do blob
 * @param {number} maxRetries - Número máximo de tentativas
 * @returns {Promise<Buffer>} - Buffer do arquivo PDF
 */
async function downloadPdfFromBlob(blobUrl, maxRetries = 3) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`⬇️ Baixando PDF (tentativa ${attempt}/${maxRetries}): ${blobUrl}`);
      
      // Criar AbortController para timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout
      
      const response = await fetch(blobUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; PDFProcessor/1.0)',
        }
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      // Verificar content-type
      const contentType = response.headers.get('content-type');
      if (contentType && !contentType.includes('application/pdf') && !contentType.includes('application/octet-stream')) {
        console.warn(`⚠️ Content-Type inesperado: ${contentType}`);
      }
      
      const arrayBuffer = await response.arrayBuffer();
      const pdfBuffer = Buffer.from(arrayBuffer);
      
      // Validar se é realmente um PDF
      if (pdfBuffer.length === 0) {
        throw new Error('Buffer baixado está vazio');
      }
      
      const pdfHeader = pdfBuffer.slice(0, 4).toString();
      if (pdfHeader !== '%PDF') {
        throw new Error('Arquivo baixado não é um PDF válido');
      }
      
      console.log(`✅ PDF baixado com sucesso: ${(pdfBuffer.length / 1024 / 1024).toFixed(2)}MB`);
      
      return pdfBuffer;
      
    } catch (error) {
      lastError = error;
      console.warn(`❌ Tentativa ${attempt}/${maxRetries} falhou: ${error.message}`);
      
      // Não fazer retry para erros definitivos
      if (error.message.includes('404') || error.message.includes('403')) {
        console.error('Erro definitivo, não tentando novamente');
        break;
      }
      
      if (attempt < maxRetries) {
        const waitTime = Math.min(attempt * 2000, 10000); // Max 10s
        console.log(`⏳ Aguardando ${waitTime}ms antes da próxima tentativa...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  
  console.error('❌ Todas as tentativas de download falharam');
  throw new Error(`Falha no download após ${maxRetries} tentativas: ${lastError?.message}`);
}

/**
 * Remove um PDF do Vercel Blob
 * @param {string} blobUrl - URL do blob para remover
 * @returns {Promise<boolean>} - True se removido com sucesso
 */
async function deletePdfFromBlob(blobUrl) {
  try {
    if (!isBlobConfigured()) {
      console.warn('⚠️ Blob não configurado, não é possível deletar');
      return false;
    }
    
    console.log(`🗑️ Removendo PDF do Blob: ${blobUrl}`);
    
    await del(blobUrl);
    
    console.log('✅ PDF removido do Blob com sucesso');
    return true;
    
  } catch (error) {
    console.error('❌ Erro ao remover PDF do Blob:', error.message);
    // Não falhar o processo se a limpeza falhar
    return false;
  }
}

/**
 * Verifica se um arquivo deve usar blob
 * @param {number} fileSize - Tamanho do arquivo em bytes
 * @param {boolean} isVercel - Se está rodando no Vercel
 * @returns {boolean} - True se deve usar blob
 */
function shouldUseBlob(fileSize, isVercel = true) {
  const VERCEL_LIMIT = 4.5 * 1024 * 1024; // 4.5MB
  
  if (!isVercel || !isBlobConfigured()) {
    return false;
  }
  
  return fileSize > VERCEL_LIMIT;
}

/**
 * Processa PDF usando Vercel Blob com fallbacks robustos
 * @param {Buffer} pdfBuffer - Buffer do PDF
 * @param {string} filename - Nome do arquivo
 * @param {Function} processingFunction - Função que processa o PDF
 * @returns {Promise<Object>} - Resultado do processamento
 */
async function processLargePdfWithBlob(pdfBuffer, filename, processingFunction) {
  let blobInfo = null;
  
  try {
    console.log(`🚀 Iniciando processamento via Blob: ${filename}`);
    
    // Verificar se Blob está configurado
    if (!isBlobConfigured()) {
      console.log('⚠️ Blob não configurado, usando processamento direto');
      const results = await processingFunction(pdfBuffer, filename);
      results.blobInfo = {
        processedViaBlob: false,
        fallbackUsed: true,
        fallbackReason: 'Blob não configurado'
      };
      return results;
    }
    
    // Salvar no blob
    blobInfo = await savePdfToBlob(pdfBuffer, filename);
    
    // Tentativa 1: Processar via blob
    try {
      const downloadedBuffer = await downloadPdfFromBlob(blobInfo.url, 3);
      
      console.log('📋 Processando PDF baixado do Blob...');
      const results = await processingFunction(downloadedBuffer, filename);
      
      // Marcar como processado via blob
      results.blobInfo = {
        url: blobInfo.url,
        size: blobInfo.size,
        uploadedAt: blobInfo.uploadedAt,
        processedViaBlob: true,
        fallbackUsed: false
      };
      
      console.log('✅ Processamento via Blob concluído com sucesso');
      return results;
      
    } catch (downloadError) {
      console.error('❌ Falha no download/processamento via Blob:', downloadError.message);
      
      // FALLBACK: Processar buffer original
      console.log('🔄 FALLBACK: Processando buffer original...');
      
      const results = await processingFunction(pdfBuffer, filename);
      
      results.blobInfo = {
        url: blobInfo?.url,
        size: blobInfo?.size,
        uploadedAt: blobInfo?.uploadedAt,
        processedViaBlob: false,
        fallbackUsed: true,
        fallbackReason: `Download falhou: ${downloadError.message}`
      };
      
      console.log('✅ Processamento via fallback concluído');
      return results;
    }
    
  } catch (blobError) {
    console.error('❌ Erro no sistema Blob:', blobError.message);
    
    // FALLBACK COMPLETO: Processar sem Blob
    console.log('🔄 FALLBACK COMPLETO: Processando sem Blob...');
    
    try {
      const results = await processingFunction(pdfBuffer, filename);
      results.blobInfo = {
        processedViaBlob: false,
        fallbackUsed: true,
        fallbackReason: `Falha no Blob: ${blobError.message}`
      };
      
      console.log('✅ Processamento direto concluído');
      return results;
      
    } catch (fallbackError) {
      console.error('❌ Fallback também falhou:', fallbackError.message);
      throw new Error(`Blob falhou: ${blobError.message} | Fallback falhou: ${fallbackError.message}`);
    }
    
  } finally {
    // Limpeza assíncrona do blob (não bloquear resposta)
    if (blobInfo?.url) {
      setTimeout(async () => {
        try {
          await deletePdfFromBlob(blobInfo.url);
        } catch (cleanupError) {
          console.warn('⚠️ Erro na limpeza do blob:', cleanupError.message);
        }
      }, 5000); // 5 segundos de delay
    }
  }
}

/**
 * Valida se arquivo pode ser processado via blob
 * @param {Buffer} pdfBuffer - Buffer do PDF
 * @param {string} filename - Nome do arquivo
 * @returns {Object} - Resultado da validação
 */
function validatePdfForBlob(pdfBuffer, filename) {
  const MAX_BLOB_SIZE = 100 * 1024 * 1024; // 100MB
  const fileSizeMB = pdfBuffer.length / (1024 * 1024);
  
  // Verificar se é um Buffer válido
  if (!Buffer.isBuffer(pdfBuffer)) {
    return {
      valid: false,
      error: 'Arquivo deve ser um Buffer válido',
      size: 0
    };
  }
  
  // Verificar se não está vazio
  if (pdfBuffer.length === 0) {
    return {
      valid: false,
      error: 'Arquivo está vazio',
      size: 0
    };
  }
  
  // Verificar tamanho máximo
  if (pdfBuffer.length > MAX_BLOB_SIZE) {
    return {
      valid: false,
      error: `Arquivo muito grande (${fileSizeMB.toFixed(2)}MB). Máximo: 100MB`,
      size: fileSizeMB
    };
  }
  
  // Verificar se é PDF pelo header
  const pdfHeader = pdfBuffer.slice(0, 4).toString();
  if (pdfHeader !== '%PDF') {
    return {
      valid: false,
      error: 'Arquivo não é um PDF válido (header incorreto)',
      size: fileSizeMB
    };
  }
  
  // Verificar extensão do filename
  if (!filename || !filename.toLowerCase().endsWith('.pdf')) {
    return {
      valid: false,
      error: 'Nome do arquivo deve terminar com .pdf',
      size: fileSizeMB
    };
  }
  
  // Verificar se Blob está configurado
  if (!isBlobConfigured()) {
    return {
      valid: false,
      error: 'Vercel Blob não está configurado (VERCEL_BLOB_READ_WRITE_TOKEN ausente)',
      size: fileSizeMB
    };
  }
  
  return {
    valid: true,
    size: fileSizeMB,
    shouldUseBlob: fileSizeMB > 3, // >3MB recomenda blob
    message: `Arquivo válido: ${fileSizeMB.toFixed(2)}MB`
  };
}

/**
 * Função de diagnóstico para troubleshooting
 * @returns {Object} - Status do sistema Blob
 */
function getBlobSystemStatus() {
  return {
    configured: isBlobConfigured(),
    tokenPresent: !!(process.env.VERCEL_BLOB_READ_WRITE_TOKEN || process.env.BLOB_READ_WRITE_TOKEN),
    environment: process.env.VERCEL === '1' ? 'vercel' : 'local',
    timestamp: new Date().toISOString()
  };
}

module.exports = {
  savePdfToBlob,
  downloadPdfFromBlob,
  deletePdfFromBlob,
  shouldUseBlob,
  processLargePdfWithBlob,
  validatePdfForBlob,
  isBlobConfigured,
  getBlobSystemStatus
};