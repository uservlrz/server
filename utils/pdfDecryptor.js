// utils/pdfDecryptor.js - Versão completamente corrigida para Buffer e String
const fs = require('fs');
const path = require('path');
const os = require('os');
const { PDFDocument } = require('pdf-lib');

/**
 * Verifica se um ambiente é o Vercel
 * @returns {boolean} - True se o ambiente for Vercel
 */
function isVercelEnvironment() {
  return process.env.VERCEL === '1';
}

/**
 * Detecta tipos específicos de proteção em um PDF - VERSÃO CORRIGIDA
 * @param {string|Buffer} pdfInput - Caminho do arquivo PDF ou Buffer
 * @returns {Promise<object>} - Tipos de proteção detectados
 */
async function detectProtectionType(pdfInput) {
  try {
    let content;
    
    // CORREÇÃO: Verificar se é Buffer ou string (caminho)
    if (Buffer.isBuffer(pdfInput)) {
      content = pdfInput.toString('latin1').slice(0, 20000);
    } else if (typeof pdfInput === 'string') {
      if (!fs.existsSync(pdfInput)) {
        throw new Error(`Arquivo não encontrado: ${pdfInput}`);
      }
      content = fs.readFileSync(pdfInput, 'latin1').slice(0, 20000);
    } else {
      throw new Error('Input deve ser um caminho de arquivo (string) ou Buffer do PDF');
    }
    
    // Verificar flags de permissão no PDF
    // A flag "/P" no PDF controla as permissões. Cada bit representa uma permissão diferente.
    // Valores negativos como "/P -3844" indicam permissões restritivas
    
    // Encontrar o valor de /P
    const pMatch = content.match(/\/P\s+(-?\d+)/);
    const permissionValue = pMatch ? parseInt(pMatch[1]) : 0;
    
    // Códigos de permissão padrão (bits):
    // Bit 3 (valor 8): Permite cópia de texto
    // Bit 4 (valor 16): Permite modificações
    // Bit 11 (valor 2048): Permite impressão
    
    // Detectar permissões específicas baseadas na flag /P
    const permissions = {
      allowPrint: (permissionValue & 4) !== 0,           // Bit 2 (valor 4): Permissão para impressão
      allowModify: (permissionValue & 8) !== 0,          // Bit 3 (valor 8): Permissão para modificação
      allowCopy: (permissionValue & 16) !== 0,           // Bit 4 (valor 16): Permissão para cópia
      allowAnnotations: (permissionValue & 32) !== 0,    // Bit 5 (valor 32): Permissão para anotações
      allowForms: (permissionValue & 256) !== 0,         // Bit 8 (valor 256): Permissão para formulários
      allowAccessibility: (permissionValue & 512) !== 0, // Bit 9 (valor 512): Permissão para acessibilidade
      allowAssemble: (permissionValue & 1024) !== 0,     // Bit 10 (valor 1024): Permissão para montagem
      allowHighQualityPrint: (permissionValue & 2048) !== 0 // Bit 11 (valor 2048): Permissão para impressão de alta qualidade
    };
    
    // Detecção padrão (pelo conteúdo)
    const types = {
      userPassword: content.includes('/R 2') || content.includes('/R 3') || content.includes('/R 4') || content.includes('/R 5') || content.includes('/R 6'),
      print: permissions.allowPrint,
      copy: !permissions.allowCopy,
      modify: !permissions.allowModify,
      forms: !permissions.allowForms,
      accessibility: !permissions.allowAccessibility,
      signature: content.includes('/Type /Sig') || content.includes('/ByteRange')
    };
    
    // Detectar o padrão específico visto na captura de tela: 
    // Impressão permitida, tudo mais bloqueado
    const laboratoryReportPattern = permissions.allowPrint && 
                                   !permissions.allowCopy && 
                                   !permissions.allowModify && 
                                   !permissions.allowAnnotations && 
                                   !permissions.allowForms;
    
    // Determinar o nível de proteção (quantidade de restrições)
    const restrictionCount = Object.values(permissions).filter(perm => !perm).length;
    
    return {
      isProtected: restrictionCount > 0 || types.userPassword,
      permissions: permissions,
      permissionValue: permissionValue,
      types: types,
      protectionLevel: restrictionCount,
      isLaboratoryReport: laboratoryReportPattern,
      description: getProtectionDescription(permissions, laboratoryReportPattern)
    };
  } catch (error) {
    console.error('❌ Erro ao analisar tipo de proteção:', error.message);
    return {
      isProtected: false,
      permissions: {},
      permissionValue: 0,
      types: {},
      protectionLevel: 0,
      isLaboratoryReport: false,
      description: 'Não foi possível determinar o tipo de proteção'
    };
  }
}

/**
 * Retorna uma descrição do tipo de proteção para logs e interface do usuário
 * @param {object} permissions - Objeto com as permissões do PDF
 * @param {boolean} isLaboratoryReport - Se corresponde ao padrão de laudo laboratorial
 * @returns {string} - Descrição dos tipos de proteção
 */
function getProtectionDescription(permissions, isLaboratoryReport) {
  if (isLaboratoryReport) {
    return 'proteção típica de laudo laboratorial (permite impressão, bloqueia cópia)';
  }
  
  const descriptions = [];
  
  if (!permissions.allowPrint) descriptions.push('bloqueio de impressão');
  if (!permissions.allowCopy) descriptions.push('bloqueio de cópia de texto');
  if (!permissions.allowAccessibility) descriptions.push('bloqueio de acessibilidade');
  if (!permissions.allowModify) descriptions.push('bloqueio de edição');
  if (!permissions.allowForms) descriptions.push('bloqueio de formulários');
  if (!permissions.allowAnnotations) descriptions.push('bloqueio de anotações');
  
  if (descriptions.length === 0) return 'proteção genérica';
  
  return descriptions.join(', ');
}

/**
 * Detecta se um PDF está criptografado/protegido - VERSÃO COMPLETAMENTE CORRIGIDA
 * @param {string|Buffer} pdfInput - Caminho do arquivo PDF ou Buffer do PDF
 * @returns {Promise<boolean>} - True se o PDF estiver criptografado ou com permissões restritas
 */
async function isPdfEncrypted(pdfInput) {
  try {
    let content;
    let pdfBytes;
    
    // CORREÇÃO PRINCIPAL: Verificar se é Buffer ou string (caminho)
    if (Buffer.isBuffer(pdfInput)) {
      // Se for Buffer, usar diretamente
      pdfBytes = pdfInput;
      content = pdfInput.toString('latin1').slice(0, 20000);
      console.log('🔍 Verificando criptografia do Buffer PDF...');
    } else if (typeof pdfInput === 'string') {
      // Se for string, ler o arquivo
      if (!fs.existsSync(pdfInput)) {
        throw new Error(`Arquivo não encontrado: ${pdfInput}`);
      }
      content = fs.readFileSync(pdfInput, 'latin1').slice(0, 20000);
      pdfBytes = fs.readFileSync(pdfInput);
      console.log('🔍 Verificando criptografia do arquivo PDF...');
    } else {
      throw new Error('Input deve ser um caminho de arquivo (string) ou Buffer do PDF');
    }
    
    // Verificar se é um PDF válido
    const pdfHeader = pdfBytes.slice(0, 4).toString();
    if (pdfHeader !== '%PDF') {
      console.warn('⚠️ Arquivo não parece ser um PDF válido');
      return false;
    }
    
    // Verificar se o documento tem configurações de permissão restritas
    const pMatch = content.match(/\/P\s+(-?\d+)/);
    if (pMatch) {
      const permissionValue = parseInt(pMatch[1]);
      // Se valor negativo, indica permissões restritas
      if (permissionValue < 0) {
        console.log(`🔒 PDF tem permissões restritas: ${permissionValue}`);
        return true;
      }
    }
    
    // Marcadores adicionais de criptografia
    const encryptionMarkers = [
      '/Encrypt', '/Standard', '/StdCF', '/Crypt', 
      '/EncryptMetadata', '/R ', '/O ', '/U ', '/P '
    ];
    
    // Se encontrar várias marcas de encriptação, é mais provável que esteja protegido
    let encryptionScore = 0;
    for (const marker of encryptionMarkers) {
      if (content.includes(marker)) {
        encryptionScore++;
      }
    }
    
    if (encryptionScore >= 3) {
      console.log(`🔒 PDF tem múltiplos marcadores de criptografia (score: ${encryptionScore})`);
      return true;
    }
    
    // Usar pdf-lib como verificação secundária
    try {
      const pdfDoc = await PDFDocument.load(pdfBytes, { 
        updateMetadata: false,
        throwOnInvalidObject: false
      });
      
      const isEncrypted = pdfDoc.isEncrypted;
      if (isEncrypted) {
        console.log('🔒 PDF detectado como criptografado pelo pdf-lib');
      }
      return isEncrypted;
      
    } catch (error) {
      console.warn('⚠️ pdf-lib falhou ao carregar PDF:', error.message);
      
      // Se o erro contém menções a criptografia
      if (error.message && (
          error.message.includes('encrypted') || 
          error.message.includes('password') ||
          error.message.includes('Encrypt'))) {
        console.log('🔒 Erro indica PDF criptografado');
        return true;
      }
      
      // Tentar verificação manual adicional se pdf-lib falhar
      const manualCheck = content.includes('/Encrypt') || 
                         content.includes('/Standard') || 
                         (content.includes('/P ') && content.includes('/R '));
      
      if (manualCheck) {
        console.log('🔒 Verificação manual detectou criptografia');
      }
      
      return manualCheck;
    }
  } catch (error) {
    console.error('❌ Erro ao verificar criptografia:', error.message);
    
    // Se falhar completamente, usar heurística baseada na mensagem de erro
    if (error.message && (
        error.message.includes('encrypted') || 
        error.message.includes('password') ||
        error.message.includes('crypt'))) {
      console.log('🔒 Mensagem de erro indica criptografia');
      return true;
    }
    
    // Em caso de erro, assumir que não está criptografado
    // para permitir que o processamento continue
    console.log('⚠️ Assumindo PDF não criptografado devido ao erro');
    return false;
  }
}

/**
 * Tenta remover proteção de um PDF usando pdf-lib - VERSÃO CORRIGIDA
 * @param {string|Buffer} pdfInput - Caminho do arquivo PDF original ou Buffer
 * @returns {Promise<object>} - Resultado da operação
 */
async function decryptPdfWithPdfLib(pdfInput) {
  let tempFiles = [];
  let inputPath;
  
  try {
    // CORREÇÃO: Preparar arquivo de entrada baseado no tipo
    if (Buffer.isBuffer(pdfInput)) {
      // Se for Buffer, salvar temporariamente
      inputPath = path.join(os.tmpdir(), `temp_input_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.pdf`);
      fs.writeFileSync(inputPath, pdfInput);
      tempFiles.push(inputPath);
      console.log('💾 Buffer salvo como arquivo temporário para processamento');
    } else if (typeof pdfInput === 'string') {
      if (!fs.existsSync(pdfInput)) {
        throw new Error(`Arquivo não encontrado: ${pdfInput}`);
      }
      inputPath = pdfInput;
      console.log('📄 Usando arquivo existente para processamento');
    } else {
      throw new Error('Input deve ser um caminho de arquivo ou Buffer');
    }
    
    const outputPath = path.join(os.tmpdir(), `decrypted_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.pdf`);
    tempFiles.push(outputPath);
    
    // Verificar tipo específico de proteção
    const protectionInfo = await detectProtectionType(pdfInput);
    console.log(`🔍 Tentando remover proteção (${protectionInfo.description})`);
    
    // Estratégias específicas baseadas no tipo de proteção
    let useAggressive = protectionInfo.isLaboratoryReport;
    
    // Ler o PDF original
    const pdfBytes = fs.readFileSync(inputPath);
    
    // Tentar várias estratégias para carregar o PDF
    let pdfDoc = null;
    let loadMethod = '';
    
    // Estratégia 1: Ignorar criptografia completamente
    try {
      pdfDoc = await PDFDocument.load(pdfBytes, { 
        ignoreEncryption: true,
        updateMetadata: false,
        throwOnInvalidObject: false
      });
      loadMethod = 'ignoreEncryption';
      console.log('✅ PDF carregado ignorando criptografia');
    } catch (firstError) {
      console.log('🔄 Falha ao ignorar criptografia, tentando senhas comuns...');
      
      // Estratégia 2: Tentar senhas comuns
      const commonPasswords = ['', '1234', 'admin', 'password', 'pdf', 'exame', 'laudo', 'laboratorio', '123456'];
      for (const password of commonPasswords) {
        try {
          pdfDoc = await PDFDocument.load(pdfBytes, { 
            password,
            updateMetadata: false,
            throwOnInvalidObject: false
          });
          loadMethod = `senha: "${password}"`;
          console.log(`✅ PDF carregado com senha: "${password}"`);
          break;
        } catch (e) {
          // Continuar tentando
        }
      }
      
      // Se ainda não funcionou, tentar combinações mais agressivas
      if (!pdfDoc || useAggressive) {
        try {
          // Estratégia 3: Carregar em modo de recuperação
          pdfDoc = await PDFDocument.load(pdfBytes, { 
            ignoreEncryption: true,
            throwOnInvalidObject: false,
            updateMetadata: false,
            parseSpeed: 150 // Mais lento, mas mais robusto
          });
          loadMethod = 'modo de recuperação avançado';
          console.log('✅ PDF carregado em modo de recuperação');
        } catch (thirdError) {
          console.error('❌ Falha em todas as tentativas de carregar o PDF:', thirdError.message);
          if (!pdfDoc) {
            throw thirdError;
          }
        }
      }
    }
    
    if (!pdfDoc) {
      throw new Error('Não foi possível carregar o PDF com nenhuma estratégia');
    }
    
    console.log(`✅ PDF carregado com sucesso usando: ${loadMethod}`);
    
    // Criar um novo documento para copiar o conteúdo
    const newPdfDoc = await PDFDocument.create();
    
    // Copiar todas as páginas para o novo documento
    const pageCount = pdfDoc.getPageCount();
    let pagesAdded = 0;
    let errorPages = 0;
    
    console.log(`📄 Copiando ${pageCount} páginas...`);
    
    for (let i = 0; i < pageCount; i++) {
      try {
        // Copiar página por página
        const [copiedPage] = await newPdfDoc.copyPages(pdfDoc, [i]);
        newPdfDoc.addPage(copiedPage);
        pagesAdded++;
      } catch (pageError) {
        console.warn(`⚠️ Não foi possível copiar a página ${i+1}: ${pageError.message}`);
        errorPages++;
        
        // Adicionar uma página em branco para manter a estrutura
        if (errorPages < pageCount) {
          try {
            const blankPage = newPdfDoc.addPage();
            blankPage.drawText(`[Página ${i+1} não pôde ser recuperada]`, {
              x: 50,
              y: blankPage.getHeight() / 2,
              size: 12
            });
          } catch (blankError) {
            console.error('❌ Erro ao adicionar página em branco:', blankError.message);
          }
        }
      }
    }
    
    // Se não conseguimos copiar nenhuma página, falha
    if (pagesAdded === 0) {
      return {
        success: false,
        message: 'Não foi possível decriptar o PDF - proteção muito forte',
        error: 'Nenhuma página copiada'
      };
    }
    
    console.log(`✅ ${pagesAdded} páginas copiadas com sucesso (${errorPages} erros)`);
    
    // Salvar o novo documento sem criptografia
    const newPdfBytes = await newPdfDoc.save({
      useObjectStreams: false // Melhor compatibilidade
    });
    fs.writeFileSync(outputPath, newPdfBytes);
    
    console.log(`💾 PDF desprotegido salvo: ${outputPath}`);
    
    return {
      success: true,
      message: `PDF desprotegido com sucesso (${pagesAdded} de ${pageCount} páginas)`,
      decryptedPath: outputPath,
      pageCount,
      pagesAdded,
      errorPages,
      method: loadMethod,
      protectionType: protectionInfo.description,
      isLaboratoryReport: protectionInfo.isLaboratoryReport
    };
    
  } catch (error) {
    console.error('❌ Erro ao decriptar PDF com pdf-lib:', error.message);
    
    return {
      success: false,
      message: 'Falha ao decriptar o PDF',
      error: error.message
    };
    
  } finally {
    // Limpar apenas arquivos temporários criados por esta função
    // (não limpar o arquivo de saída que será usado depois)
    tempFiles.forEach(tempFile => {
      try {
        if (fs.existsSync(tempFile) && 
            (tempFile.includes('temp_input_') || tempFile === inputPath) &&
            tempFile !== outputPath) {
          fs.unlinkSync(tempFile);
          console.log(`🗑️ Arquivo temporário removido: ${tempFile}`);
        }
      } catch (cleanupError) {
        console.error(`❌ Erro ao limpar ${tempFile}: ${cleanupError.message}`);
      }
    });
  }
}

/**
 * Estratégia para tentar decriptar/desproteger um PDF - VERSÃO CORRIGIDA
 * @param {string|Buffer} pdfInput - Caminho do arquivo PDF ou Buffer
 * @returns {Promise<object>} - Resultado da tentativa de decriptação
 */
async function attemptPdfDecryption(pdfInput) {
  try {
    console.log('🔓 Iniciando tentativa de decriptação...');
    
    // Primeiro, verificar se o PDF está realmente criptografado
    const isEncrypted = await isPdfEncrypted(pdfInput);
    
    if (!isEncrypted) {
      console.log('✅ PDF não está criptografado');
      
      // Se não está criptografado mas pdfInput é Buffer, criar arquivo temporário
      if (Buffer.isBuffer(pdfInput)) {
        const tempPath = path.join(os.tmpdir(), `temp_unencrypted_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.pdf`);
        fs.writeFileSync(tempPath, pdfInput);
        console.log('💾 Buffer convertido para arquivo temporário');
        return {
          success: true,
          message: 'PDF não está criptografado',
          decryptedPath: tempPath
        };
      }
      
      return {
        success: true,
        message: 'PDF não está criptografado',
        decryptedPath: pdfInput
      };
    }
    
    // Analisar o tipo de proteção
    const protectionInfo = await detectProtectionType(pdfInput);
    console.log(`🔒 PDF protegido: ${protectionInfo.description}, Nível: ${protectionInfo.protectionLevel}`);
    
    if (protectionInfo.isLaboratoryReport) {
      console.log('🧪 Detectado padrão de laudo laboratorial');
    }
    
    // Tentar desencriptar com pdf-lib (compatível com Vercel)
    console.log('🔧 Tentando remover proteção com pdf-lib...');
    const pdfLibResult = await decryptPdfWithPdfLib(pdfInput);
    
    if (pdfLibResult.success) {
      console.log(`✅ Proteção removida usando: ${pdfLibResult.method}`);
      
      // Adicionar informações sobre o tipo de proteção ao resultado
      return {
        ...pdfLibResult,
        protectionType: protectionInfo.description,
        permissionValue: protectionInfo.permissionValue,
        isLaboratoryReport: protectionInfo.isLaboratoryReport
      };
    }
    
    // Se chegamos aqui, a tentativa falhou
    console.log('❌ Falha na remoção de proteção');
    return {
      success: false,
      message: `Não foi possível remover a proteção do PDF (${protectionInfo.description})`,
      error: pdfLibResult.error || 'Método falhou',
      protectionType: protectionInfo.description,
      permissionValue: protectionInfo.permissionValue,
      isLaboratoryReport: protectionInfo.isLaboratoryReport
    };
    
  } catch (error) {
    console.error('❌ Erro na tentativa de decriptação:', error.message);
    return {
      success: false,
      message: 'Erro durante a decriptação',
      error: error.message
    };
  }
}

module.exports = {
  isPdfEncrypted,
  detectProtectionType,
  decryptPdfWithPdfLib,
  attemptPdfDecryption,
  isVercelEnvironment
};