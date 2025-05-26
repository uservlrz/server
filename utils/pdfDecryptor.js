// utils/pdfDecryptor.js - Versão aprimorada para detecção específica de proteções
const fs = require('fs');
const { PDFDocument } = require('pdf-lib');

/**
 * Verifica se um ambiente é o Vercel
 * @returns {boolean} - True se o ambiente for Vercel
 */
function isVercelEnvironment() {
  return process.env.VERCEL === '1';
}

/**
 * Detecta tipos específicos de proteção em um PDF
 * @param {string} filePath - Caminho do arquivo PDF
 * @returns {Promise<object>} - Tipos de proteção detectados
 */
async function detectProtectionType(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'latin1').slice(0, 20000);
    
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
    console.error('Erro ao analisar tipo de proteção:', error);
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
 * Detecta se um PDF está criptografado/protegido
 * @param {string|Buffer} pdfInput - Caminho do arquivo PDF ou Buffer do PDF
 * @returns {Promise<boolean>} - True se o PDF estiver criptografado ou com permissões restritas
 */
async function isPdfEncrypted(pdfInput) {
  try {
    let content;
    let pdfBytes;
    
    // Verificar se é Buffer ou string (caminho)
    if (Buffer.isBuffer(pdfInput)) {
      // Se for Buffer, usar diretamente
      pdfBytes = pdfInput;
      content = pdfInput.toString('latin1').slice(0, 20000);
    } else if (typeof pdfInput === 'string') {
      // Se for string, ler o arquivo
      content = fs.readFileSync(pdfInput, 'latin1').slice(0, 20000);
      pdfBytes = fs.readFileSync(pdfInput);
    } else {
      throw new Error('Input deve ser um caminho de arquivo (string) ou Buffer do PDF');
    }
    
    // Verificar se o documento tem configurações de permissão restritas
    const pMatch = content.match(/\/P\s+(-?\d+)/);
    if (pMatch) {
      const permissionValue = parseInt(pMatch[1]);
      // Se valor negativo, indica permissões restritas
      if (permissionValue < 0) {
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
      return true;
    }
    
    // Usar pdf-lib como verificação secundária
    try {
      const pdfDoc = await PDFDocument.load(pdfBytes, { 
        updateMetadata: false 
      });
      return pdfDoc.isEncrypted;
    } catch (error) {
      // Se o erro contém menções a criptografia
      if (error.message && (
          error.message.includes('encrypted') || 
          error.message.includes('password') ||
          error.message.includes('Encrypt'))) {
        return true;
      }
      
      // Tentar verificação manual adicional se pdf-lib falhar
      return content.includes('/Encrypt') || 
             content.includes('/Standard') || 
             (content.includes('/P ') && content.includes('/R '));
    }
  } catch (error) {
    console.error('Erro ao verificar criptografia:', error);
    
    // Se falhar completamente, usar heurística baseada na mensagem de erro
    if (error.message && (
        error.message.includes('encrypted') || 
        error.message.includes('password') ||
        error.message.includes('crypt'))) {
      return true;
    }
    
    return false;
  }
}

/**
 * Tenta remover proteção de um PDF usando pdf-lib com estratégia aprimorada para laudos laboratoriais
 * @param {string} inputPath - Caminho do arquivo PDF original
 * @returns {Promise<object>} - Resultado da operação
 */
async function decryptPdfWithPdfLib(inputPath) {
  const outputPath = `${inputPath}_decrypted.pdf`;
  
  try {
    // Verificar tipo específico de proteção
    const protectionInfo = await detectProtectionType(inputPath);
    console.log(`Tentando remover proteção (${protectionInfo.description})`);
    
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
    } catch (firstError) {
      console.log('Falha ao carregar PDF ignorando criptografia, tentando senhas comuns...');
      
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
        } catch (thirdError) {
          console.error('Falha em todas as tentativas de carregar o PDF:', thirdError);
          if (!pdfDoc) {
            throw thirdError;
          }
        }
      }
    }
    
    console.log(`PDF carregado com sucesso usando ${loadMethod}`);
    
    // Criar um novo documento para copiar o conteúdo
    const newPdfDoc = await PDFDocument.create();
    
    // Copiar todas as páginas para o novo documento
    const pageCount = pdfDoc.getPageCount();
    let pagesAdded = 0;
    let errorPages = 0;
    
    for (let i = 0; i < pageCount; i++) {
      try {
        // Copiar página por página
        const [copiedPage] = await newPdfDoc.copyPages(pdfDoc, [i]);
        newPdfDoc.addPage(copiedPage);
        pagesAdded++;
      } catch (pageError) {
        console.warn(`Não foi possível copiar a página ${i+1}:`, pageError.message);
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
            console.error('Erro ao adicionar página em branco:', blankError);
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
    
    // Salvar o novo documento sem criptografia
    const newPdfBytes = await newPdfDoc.save({
      useObjectStreams: false // Melhor compatibilidade
    });
    fs.writeFileSync(outputPath, newPdfBytes);
    
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
    console.error('Erro ao decriptar PDF com pdf-lib:', error);
    
    // Limpar arquivo de saída se foi criado
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }
    
    return {
      success: false,
      message: 'Falha ao decriptar o PDF',
      error: error.message
    };
  }
}

/**
 * Estratégia para tentar decriptar/desproteger um PDF
 * Usa apenas métodos compatíveis com Vercel
 * @param {string} filePath - Caminho do arquivo PDF original
 * @returns {Promise<object>} - Resultado da tentativa de decriptação
 */
async function attemptPdfDecryption(filePath) {
  // Primeiro, verificar se o PDF está realmente criptografado
  const isEncrypted = await isPdfEncrypted(filePath);
  
  if (!isEncrypted) {
    return {
      success: true,
      message: 'PDF não está criptografado',
      decryptedPath: filePath
    };
  }
  
  // Analisar o tipo de proteção
  const protectionInfo = await detectProtectionType(filePath);
  console.log(`PDF está protegido. Tipo: ${protectionInfo.description}, Nível: ${protectionInfo.protectionLevel}`);
  
  if (protectionInfo.isLaboratoryReport) {
    console.log('Detectado padrão típico de laudo laboratorial (permite impressão, bloqueia cópias)');
  }
  
  // Tentar desencriptar com pdf-lib (compatível com Vercel)
  console.log('Tentando remover proteção com pdf-lib...');
  const pdfLibResult = await decryptPdfWithPdfLib(filePath);
  
  if (pdfLibResult.success) {
    console.log(`Proteção removida com sucesso usando ${pdfLibResult.method}`);
    
    // Adicionar informações sobre o tipo de proteção ao resultado
    return {
      ...pdfLibResult,
      protectionType: protectionInfo.description,
      permissionValue: protectionInfo.permissionValue,
      isLaboratoryReport: protectionInfo.isLaboratoryReport
    };
  }
  
  // Se chegamos aqui, a tentativa falhou
  return {
    success: false,
    message: `Não foi possível remover a proteção do PDF (${protectionInfo.description})`,
    error: 'Método falhou',
    protectionType: protectionInfo.description,
    permissionValue: protectionInfo.permissionValue,
    isLaboratoryReport: protectionInfo.isLaboratoryReport
  };
}

module.exports = {
  isPdfEncrypted,
  detectProtectionType,
  decryptPdfWithPdfLib,
  attemptPdfDecryption,
  isVercelEnvironment
};