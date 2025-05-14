// server/routes/uploadRoute.js
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const router = express.Router();

// Importar utilitários de processamento de PDF
const { parsePdf } = require('../utils/pdfParser');
const { validatePdf, repairPdf, analyzePdfStructure } = require('../utils/pdfValidator');
const { isPdfEncrypted, attemptPdfDecryption, detectProtectionType, isVercelEnvironment } = require('../utils/pdfDecryptor');
const { splitPDF, reconstructProblemPdf, optimizePdfStructure, cleanupTempFiles } = require('../utils/pdfSplitter');
const { tryRepairWithGhostscript } = require('../utils/pdfRepairGhostscript');

// Verificar se estamos no ambiente Vercel
const isVercel = isVercelEnvironment();

// Configurar diretório de uploads
const uploadDir = isVercel ? '/tmp' : 'uploads';

// Criar diretório de uploads se não existir
try {
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
    console.log(`Diretório de uploads criado: ${uploadDir}`);
  }
} catch (err) {
  console.error(`Erro ao criar diretório de uploads: ${err.message}`);
}

// Configuração do Multer
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    // Usar timestamp para garantir nome único e remover caracteres especiais
    const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, Date.now() + '-' + sanitizedName);
  }
});

const upload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Apenas arquivos PDF são permitidos'), false);
    }
  },
  limits: {
    fileSize: 50 * 1024 * 1024 // Limite de 50MB
  }
});

// Função para extrair o nome do paciente do texto do PDF
async function extractPatientName(pages) {
  try {
    // Se não temos páginas ou texto, retornar valor padrão
    if (!pages || !pages.length || !pages[0].text) {
      return 'Nome do Paciente não identificado';
    }
    
    // Pegar apenas o início do documento para encontrar o nome do paciente
    const initialText = pages[0].text.slice(0, 3000);
    
    // Tentar extrair o nome usando expressões regulares
    const regexPatterns = [
      /Paciente\s*[:]\s*([A-ZÀ-ÚÇ\s]+)/i,              // Padrão comum em laudos médicos
      /Nome do Paciente\s*[:]\s*([A-ZÀ-ÚÇ\s]+)/i,      // Outra variação comum
      /Paciente[:]?\s+([A-ZÀ-ÚÇ][A-ZÀ-ÚÇa-zà-úç\s]+)/, // Formato mais genérico
      /Nome[:]?\s+([A-ZÀ-ÚÇ][A-ZÀ-ÚÇa-zà-úç\s]+)/      // Busca por "Nome:"
    ];
    
    for (const pattern of regexPatterns) {
      const match = initialText.match(pattern);
      if (match && match[1]) {
        const extractedName = match[1].trim();
        if (extractedName.length > 3 && extractedName.includes(' ')) {
          console.log(`Nome extraído via regex: ${extractedName}`);
          return extractedName;
        }
      }
    }
    
    // Se não conseguiu extrair com regex, use a OpenAI API se disponível
    // Esta função deve ser implementada no index.js e passada como dependência
    
    return 'Nome do Paciente não identificado';
  } catch (error) {
    console.error('Erro ao extrair nome do paciente:', error);
    return 'Nome do Paciente não identificado';
  }
}

// Função para gerar resumos dos exames
// Esta é uma função simplificada. A implementação completa com OpenAI deve estar no index.js
function generateSummaries(pages, patientName) {
  return pages.map(page => ({
    page: page.page,
    content: `Paciente: ${patientName}\n\n${page.text.substring(0, 1000)}`
  }));
}

/**
 * Verifica e limpa recursos temporários
 * @param {Array} tempFiles - Array com caminhos de arquivos temporários
 * @param {string} originalFile - Caminho do arquivo original
 */
function cleanupResources(tempFiles, originalFile) {
  // Limpar arquivos temporários
  if (tempFiles && tempFiles.length > 0) {
    console.log("Limpando arquivos temporários...");
    tempFiles.forEach(tempFile => {
      try {
        if (fs.existsSync(tempFile)) {
          fs.unlinkSync(tempFile);
          console.log(`Arquivo temporário removido: ${tempFile}`);
        }
      } catch (cleanupError) {
        console.error(`Erro ao remover arquivo temporário ${tempFile}:`, cleanupError);
      }
    });
  }
  
  // Remover arquivo original
  if (originalFile) {
    try {
      if (fs.existsSync(originalFile)) {
        fs.unlinkSync(originalFile);
        console.log(`Arquivo original removido: ${originalFile}`);
      }
    } catch (unlinkError) {
      console.error(`Erro ao remover arquivo original ${originalFile}:`, unlinkError);
    }
  }
}

// Rota de upload
router.post('/upload', upload.single('pdf'), async (req, res) => {
  // Array para armazenar caminhos de arquivos temporários
  let tempFiles = [];
  
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'Nenhum arquivo foi enviado' });
    }

    const filePath = req.file.path;
    console.log(`Arquivo recebido: ${filePath}`);
    
    let patientName = 'Nome do Paciente não identificado';
    let extractionMethod = 'normal';
    let errorDetails = null;
    let processingResults = [];
    
    try {
      // Passo 1: Validar o PDF
      console.log("Validando o PDF...");
      const validationResult = await validatePdf(filePath);
      console.log("Resultado da validação:", validationResult.message);
      
      // Passo 2: Verificar se o PDF está criptografado
      const isEncrypted = await isPdfEncrypted(filePath);
      console.log(`PDF está criptografado? ${isEncrypted ? 'Sim' : 'Não'}`);
      
      // Obter informações sobre o tipo de proteção (se estiver criptografado)
      let protectionInfo = null;
      if (isEncrypted) {
        protectionInfo = await detectProtectionType(filePath);
        console.log(`Tipo de proteção: ${protectionInfo.description}, Nível: ${protectionInfo.protectionLevel}`);
        
        if (protectionInfo.isLaboratoryReport) {
          console.log("Detectado padrão de proteção típico de laudo laboratorial!");
        }
      }
      
      // Armazenar metadados do PDF
      const pdfMetadata = await analyzePdfStructure(filePath);
      let finalText = null;
      
      // TENTATIVA 1: Processamento direto
      try {
        console.log("Tentativa 1: Processando PDF original diretamente...");
        const pages = await parsePdf(filePath);
        
        if (pages && pages.length > 0 && pages[0].text) {
          finalText = pages;
          extractionMethod = 'direto';
          console.log("Processamento direto do PDF original bem-sucedido");
          
          // Extrair nome do paciente
          patientName = await extractPatientName(pages);
        }
      } catch (directError) {
        console.error("Erro no processamento direto:", directError.message);
        processingResults.push({
          method: 'direto',
          success: false,
          error: directError.message
        });
      }
      
      // TENTATIVA 2: Desencriptação (se estiver criptografado)
      if (!finalText && isEncrypted) {
        try {
          console.log(`Tentativa 2: Removendo proteção do PDF (${protectionInfo?.description || 'proteção genérica'})...`);
          const decryptResult = await attemptPdfDecryption(filePath);
          
          if (decryptResult.success) {
            console.log(`Proteção removida com sucesso (${decryptResult.method || 'método padrão'})`);
            tempFiles.push(decryptResult.decryptedPath);
            
            const decryptedPages = await parsePdf(decryptResult.decryptedPath);
            
            if (decryptedPages && decryptedPages.length > 0 && decryptedPages[0].text) {
              finalText = decryptedPages;
              extractionMethod = 'desprotegido';
              console.log("Processamento do PDF desprotegido bem-sucedido");
              
              // Extrair nome do paciente
              patientName = await extractPatientName(decryptedPages);
            }
          } else {
            console.log("Não foi possível remover a proteção do PDF");
            processingResults.push({
              method: 'desproteger',
              success: false,
              error: decryptResult.error
            });
          }
        } catch (decryptError) {
          console.error("Erro ao remover proteção:", decryptError.message);
          processingResults.push({
            method: 'desproteger',
            success: false,
            error: decryptError.message
          });
        }
      }
      
      // TENTATIVA 3: Reparo do PDF
      if (!finalText) {
        try {
          console.log("Tentativa 3: Reparando o PDF...");
          const repairResult = await repairPdf(filePath);
          
          if (repairResult.success) {
            console.log("PDF reparado com sucesso, processando...");
            tempFiles.push(repairResult.repairedPath);
            
            const repairedPages = await parsePdf(repairResult.repairedPath);
            
            if (repairedPages && repairedPages.length > 0 && repairedPages[0].text) {
              finalText = repairedPages;
              extractionMethod = 'reparado';
              console.log("Processamento do PDF reparado bem-sucedido");
              
              // Extrair nome do paciente
              patientName = await extractPatientName(repairedPages);
            }
          } else {
            console.log("Não foi possível reparar o PDF");
            processingResults.push({
              method: 'reparar',
              success: false,
              error: repairResult.error
            });
          }
        } catch (repairError) {
          console.error("Erro ao reparar PDF:", repairError.message);
          processingResults.push({
            method: 'reparar',
            success: false,
            error: repairError.message
          });
        }
      }
      
      // TENTATIVA 4: Ghostscript (apenas em ambiente não-Vercel)
      if (!finalText && !isVercel) {
        try {
          console.log("Tentativa 4: Reparando o PDF com Ghostscript...");
          const gsResult = await tryRepairWithGhostscript(filePath);
          
          if (gsResult.success) {
            console.log("PDF reparado com Ghostscript, processando...");
            tempFiles.push(gsResult.repairedPath);
            
            const gsRepairedPages = await parsePdf(gsResult.repairedPath);
            
            if (gsRepairedPages && gsRepairedPages.length > 0 && gsRepairedPages[0].text) {
              finalText = gsRepairedPages;
              extractionMethod = 'gs_reparado';
              console.log("Processamento do PDF reparado com Ghostscript bem-sucedido");
              
              // Extrair nome do paciente
              patientName = await extractPatientName(gsRepairedPages);
            }
          } else {
            console.log("Não foi possível reparar o PDF com Ghostscript");
            processingResults.push({
              method: 'ghostscript',
              success: false,
              error: gsResult.error
            });
          }
        } catch (gsError) {
          console.error("Erro ao usar Ghostscript:", gsError.message);
          processingResults.push({
            method: 'ghostscript',
            success: false,
            error: gsError.message
          });
        }
      }
      
      // TENTATIVA 5: Divisão em partes
      if (!finalText) {
        try {
          console.log("Tentativa 5: Dividindo o PDF em partes menores...");
          
          // Ler o PDF como buffer
          const pdfBuffer = fs.readFileSync(filePath);
          
          // Dividir o PDF em partes
          const pdfParts = await splitPDF(pdfBuffer);
          console.log(`PDF dividido em ${pdfParts.length} partes`);
          
          // Salvar partes em arquivos temporários para processamento
          const partFiles = [];
          for (let i = 0; i < pdfParts.length; i++) {
            const partPath = `${filePath}_part_${i + 1}.pdf`;
            fs.writeFileSync(partPath, pdfParts[i]);
            partFiles.push(partPath);
            tempFiles.push(partPath);
          }
          
          // Processar cada parte e combinar os resultados
          let combinedPages = [];
          
          for (let i = 0; i < partFiles.length; i++) {
            try {
              console.log(`Processando parte ${i + 1}/${partFiles.length}...`);
              const partPages = await parsePdf(partFiles[i]);
              
              if (partPages && partPages.length > 0) {
                combinedPages = combinedPages.concat(partPages);
              }
            } catch (partError) {
              console.error(`Erro ao processar parte ${i + 1}:`, partError.message);
            }
          }
          
          if (combinedPages.length > 0) {
            finalText = combinedPages;
            extractionMethod = 'partes';
            console.log("Processamento de partes do PDF bem-sucedido");
            
            // Extrair nome do paciente da primeira parte válida
            if (combinedPages[0] && combinedPages[0].text) {
              patientName = await extractPatientName([combinedPages[0]]);
            }
          } else {
            console.log("Nenhuma parte do PDF pôde ser processada");
            processingResults.push({
              method: 'partes',
              success: false,
              error: 'Nenhuma parte do PDF pôde ser processada'
            });
          }
        } catch (splitError) {
          console.error("Erro ao dividir o PDF:", splitError.message);
          processingResults.push({
            method: 'partes',
            success: false,
            error: splitError.message
          });
        }
      }
      
      // Se nenhum método funcionou, retornar uma mensagem informativa
      if (!finalText) {
        console.error("Todos os métodos de processamento falharam");
        
        // Criar um texto básico com informações sobre o problema
        finalText = [{
          page: 'Erro de Processamento',
          text: `Não foi possível processar este documento PDF. O formato pode ser incompatível ou o documento pode estar corrompido ou protegido de uma forma que nosso sistema não consegue processar.`
        }];
        
        extractionMethod = 'falha';
        errorDetails = {
          attempts: processingResults,
          pdfInfo: pdfMetadata,
          protection: isEncrypted ? protectionInfo : null
        };
      }
      
      // Gerar resumos com o texto extraído
      const summaries = generateSummaries(finalText, patientName);
      
      // Limpar arquivos temporários
      cleanupResources(tempFiles, filePath);
      
      // Retornar resultados
      res.json({
        summaries,
        patientName,
        extractionMethod,
        errorDetails,
        protection: isEncrypted ? {
          type: protectionInfo?.description,
          isLaboratoryReport: protectionInfo?.isLaboratoryReport
        } : null
      });
      
    } catch (processingError) {
      console.error("Erro global de processamento:", processingError);
      
      // Limpar arquivos temporários em caso de erro
      cleanupResources(tempFiles, filePath);
      
      // Retornar erro
      res.status(500).json({
        message: 'Erro ao processar o documento: ' + processingError.message,
        error: processingError.toString()
      });
    }
    
  } catch (error) {
    console.error('Erro ao processar a requisição:', error);
    res.status(500).json({ 
      message: 'Erro ao processar a requisição: ' + error.message,
      error: error.toString()
    });
  }
});

module.exports = router;