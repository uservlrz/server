// routes/uploadRoute.js - Versão otimizada
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const { OpenAI } = require('openai');

// Importar utilitários de processamento de PDF
const { parsePdf } = require('../utils/pdfParser');
const { validatePdf, repairPdf } = require('../utils/pdfValidator');
const { isPdfEncrypted, attemptPdfDecryption, isVercelEnvironment } = require('../utils/pdfDecryptor');
const { cleanupTempFiles } = require('../utils/pdfSplitter');
// Importar o serviço OCR aprimorado
const { processOcr, adaptiveSplitPDF } = require('../utils/ocrService');

// Configurar OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Verificar ambiente
const isVercel = isVercelEnvironment();

// Configurar diretório de uploads
const uploadDir = isVercel ? '/tmp' : 'uploads';

// Criar diretório de uploads se não existir
try {
  if (!isVercel && !fs.existsSync(uploadDir)) {
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

// Função para extrair o nome do paciente do texto do PDF usando IA
async function extractPatientNameWithAI(text) {
  try {
    console.log("Usando IA para extrair o nome do paciente...");
    
    const response = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { 
          role: 'system', 
          content: 'Você é um extrator preciso de informações de documentos médicos. Extraia apenas o nome completo do paciente sem adicionar nenhuma informação extra.'
        },
        { 
          role: 'user', 
          content: `Extraia APENAS o nome completo do paciente do seguinte trecho de um exame laboratorial. 
          Retorne SOMENTE o nome completo, sem nenhum texto adicional, prefixo ou sufixo.
          Se você não conseguir identificar o nome com certeza, retorne "Nome do Paciente não identificado".
          
          Texto para análise:
          ${text.slice(0, 3000)}` 
        }
      ],
      max_tokens: 100,
      temperature: 0.1,
    });
    
    const patientName = response.choices[0].message.content.trim();
    return patientName;
  } catch (error) {
    console.error('Erro ao extrair nome do paciente com IA:', error);
    return 'Nome do Paciente não identificado';
  }
}

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
    
    // Se não conseguiu extrair com regex, usar a IA
    return await extractPatientNameWithAI(initialText);
  } catch (error) {
    console.error('Erro ao extrair nome do paciente:', error);
    return 'Nome do Paciente não identificado';
  }
}

// Função para gerar resumos com GPT-3.5
async function generateSummaries(pages, patientName) {
  const summaries = [];

  function splitTextIntoChunks(text, maxTokens = 3000) {
    const chunkSize = maxTokens * 4;
    const chunks = [];
    
    for (let i = 0; i < text.length; i += chunkSize) {
      chunks.push(text.slice(i, i + chunkSize));
    }
    
    return chunks;
  }

  for (const page of pages) {
    try {
      const textChunks = splitTextIntoChunks(page.text);
      let pageResumo = `Paciente: ${patientName}\n\n`;
      
      for (const chunk of textChunks) {
        // Prompt específico para extrair apenas referências numéricas com valores
        const prompt = `Analise o seguinte texto de um documento de exames laboratoriais e extraia APENAS:
- Nome do exame
- Resultado numérico SEM UNIDADE
- Valor de referência (apenas os números, sem texto adicional)

Formato exato para resultados únicos:
"Nome do Exame: Resultado Unidade | VR: Valor mínimo - Valor máximo"

Formato exato para resultados duplos (percentual e absoluto):
"Nome do Exame: Resultado1 % / Resultado2 Unidade | VR: Valor mínimo - Valor máximo"

IMPORTANTE:
- Nunca arredonde casas decimais, sempre extraia o valor bruto
- Extraia as informações de TODAS as paginas, sem excessões
- NÃO adicione texto explicativo, notas ou métodos
- NÃO adicione informações específicas para gestantes, idosos, etc.
- APENAS extraia os valores principais conforme o formato acima
- Mantenha apenas o valor final de referência, sem explicações adicionais

Texto para análise:
${chunk}`;
        
        const response = await openai.chat.completions.create({
          model: 'gpt-3.5-turbo',
          messages: [
            { 
              role: 'system', 
              content: 'Você é um extrator preciso de resultados de exames laboratoriais. Você segue EXATAMENTE as instruções do usuário sem adicionar nenhuma informação extra. Você extrai apenas os nomes dos exames, resultados e valores de referência básicos, sem texto explicativo adicional. Você é extremamente minimalista e objetivo.'
            },
            { role: 'user', content: prompt }
          ],
          max_tokens: 1000,
          temperature: 0.1,
        });
        
        const chunkResumo = response.choices[0].message.content.trim();
        pageResumo += chunkResumo + '\n\n';
      }
      
      summaries.push({
        page: page.page,
        content: pageResumo.trim()
      });
    } catch (error) {
      console.error(`Erro ao gerar resumo para a página ${page.page}:`, error);
      summaries.push({
        page: page.page,
        content: `Paciente: ${patientName}\n\nErro ao gerar resumo para esta página.`
      });
    }
  }
  
  return summaries;
}

// Função para remover duplicatas nos resultados
function removeDuplicates(content) {
  // Preservar a primeira linha com o nome do paciente
  const lines = content.split('\n');
  const patientLine = lines[0]; // Linha com "Paciente: Nome do Paciente"
  
  // Processar as linhas de exames (começando da linha 2, após o cabeçalho e a linha em branco)
  const examLines = lines.slice(2);
  const uniqueLines = [];
  const seenExams = new Set();
  
  for (const line of examLines) {
    // Extrair o nome do exame (assumindo formato "NOME DO EXAME: resultado")
    const match = line.match(/^([^:]+):/);
    if (match) {
      const examName = match[1].trim();
      if (!seenExams.has(examName)) {
        seenExams.add(examName);
        uniqueLines.push(line);
      }
    } else {
      // Se não conseguir extrair o nome do exame, inclua a linha de qualquer forma
      uniqueLines.push(line);
    }
  }
  
  // Reconstruir o conteúdo: linha do paciente + linha em branco + exames únicos
  return `${patientLine}\n\n${uniqueLines.join('\n')}`;
}

// Função para limpar recursos temporários
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

// Rota de upload com estratégia otimizada para PDFs grandes
router.post('/upload', upload.single('pdf'), async (req, res) => {
  // Array para armazenar caminhos de arquivos temporários
  let tempFiles = [];
  
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'Nenhum arquivo foi enviado' });
    }

    const filePath = req.file.path;
    console.log(`Arquivo recebido: ${filePath}`);
    
    // Verificar tamanho do arquivo
    const fileStats = fs.statSync(filePath);
    const fileSizeKB = Math.round(fileStats.size / 1024);
    console.log(`Tamanho do arquivo: ${fileSizeKB}KB`);
    
    let patientName = 'Nome do Paciente não identificado';
    let extractionMethod = 'normal';
    let processingResults = [];
    
    try {
      // Validar o PDF
      console.log("Validando o PDF...");
      const validationResult = await validatePdf(filePath);
      console.log("Resultado da validação:", validationResult.message);
      
      // Verificar se o PDF está criptografado
      const isEncrypted = await isPdfEncrypted(filePath);
      console.log(`PDF está criptografado? ${isEncrypted ? 'Sim' : 'Não'}`);
      
      // Estratégia de processamento baseada no tamanho e estado do PDF
      let finalText = null;
      
      // ESTRATÉGIA 1: Para PDFs pequenos não criptografados, processar diretamente
      if (fileSizeKB <= 1000 && !isEncrypted) {
        try {
          console.log("Estratégia 1: Processando PDF diretamente (pequeno/não criptografado)...");
          
          const pages = await parsePdf(filePath);
          
          if (pages && pages.length > 0 && pages[0].text) {
            finalText = pages;
            extractionMethod = 'direto';
            console.log("Processamento direto bem-sucedido");
            
            // Extrair nome do paciente
            patientName = await extractPatientName(pages);
          }
        } catch (directError) {
          console.error("Erro no processamento direto:", directError);
          processingResults.push({
            method: 'direto',
            success: false,
            error: directError.message
          });
        }
      }
      
      // ESTRATÉGIA 2: Para PDFs criptografados, tentar remover a proteção primeiro
      if (!finalText && isEncrypted) {
        try {
          console.log("Estratégia 2: Removendo proteção do PDF...");
          
          const decryptResult = await attemptPdfDecryption(filePath);
          
          if (decryptResult.success) {
            console.log("PDF desprotegido com sucesso");
            tempFiles.push(decryptResult.decryptedPath);
            
            // Processar o PDF desprotegido
            const pages = await parsePdf(decryptResult.decryptedPath);
            
            if (pages && pages.length > 0 && pages[0].text) {
              finalText = pages;
              extractionMethod = 'desprotegido';
              console.log("Processamento do PDF desprotegido bem-sucedido");
              
              // Extrair nome do paciente
              patientName = await extractPatientName(pages);
            }
          } else {
            console.log("Não foi possível remover a proteção, tentando outras estratégias");
            processingResults.push({
              method: 'desproteger',
              success: false,
              error: decryptResult.error
            });
          }
        } catch (decryptError) {
          console.error("Erro ao remover proteção:", decryptError);
          processingResults.push({
            method: 'desproteger',
            success: false,
            error: decryptError.message
          });
        }
      }
      
      // ESTRATÉGIA 3: Para PDFs grandes ou problemáticos, usar OCR
      if (!finalText) {
        try {
          console.log("Estratégia 3: Usando OCR para processar o PDF...");
          
          // Usar o novo serviço OCR otimizado
          const ocrResults = await processOcr(filePath);
          
          if (ocrResults && ocrResults.length > 0 && ocrResults[0].text) {
            finalText = ocrResults;
            extractionMethod = 'ocr';
            console.log("OCR bem-sucedido");
            
            // Extrair nome do paciente
            patientName = await extractPatientName(ocrResults);
          } else {
            console.log("OCR não retornou resultados utilizáveis");
            processingResults.push({
              method: 'ocr',
              success: false,
              error: 'Sem resultados úteis do OCR'
            });
          }
        } catch (ocrError) {
          console.error("Erro no processamento OCR:", ocrError);
          processingResults.push({
            method: 'ocr',
            success: false,
            error: ocrError.message
          });
        }
      }
      
      // ESTRATÉGIA 4: Como último recurso, tentar reparar o PDF
      if (!finalText) {
        try {
          console.log("Estratégia 4: Tentando reparar o PDF...");
          
          const repairResult = await repairPdf(filePath);
          
          if (repairResult.success) {
            console.log("PDF reparado com sucesso");
            tempFiles.push(repairResult.repairedPath);
            
            // Processar o PDF reparado
            const pages = await parsePdf(repairResult.repairedPath);
            
            if (pages && pages.length > 0 && pages[0].text) {
              finalText = pages;
              extractionMethod = 'reparado';
              console.log("Processamento do PDF reparado bem-sucedido");
              
              // Extrair nome do paciente
              patientName = await extractPatientName(pages);
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
          console.error("Erro ao reparar PDF:", repairError);
          processingResults.push({
            method: 'reparar',
            success: false,
            error: repairError.message
          });
        }
      }
      
      // Se nenhuma estratégia funcionou, informar o usuário
      if (!finalText) {
        console.error("Todas as estratégias de processamento falharam");
        
        // Criar mensagem de erro informativa
        finalText = [{
          page: 'Erro de Processamento',
          text: `Não foi possível processar este documento PDF. O formato pode ser incompatível ou o documento pode estar corrompido ou protegido de uma forma que nosso sistema não consegue processar. Por favor, tente converter o PDF para um formato mais simples ou entre em contato com o suporte.`
        }];
        
        extractionMethod = 'falha';
      }
      
      // Gerar resumos com o texto extraído
      console.log("Gerando resumos do conteúdo extraído...");
      const summaries = await generateSummaries(finalText, patientName);
      
      // Processar os resultados para remover duplicatas
      console.log("Removendo duplicatas nos resultados...");
      const processedSummaries = summaries.map(summary => ({
        ...summary,
        content: removeDuplicates(summary.content)
      }));
      
      // Limpar arquivos temporários
      cleanupResources(tempFiles, filePath);
      
      // Retornar resultados
      res.json({
        summaries: processedSummaries,
        patientName,
        extractionMethod,
        processingDetails: processingResults.length > 0 ? processingResults : undefined
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