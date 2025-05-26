// index.js - Servidor Node.js otimizado para Vercel e ambiente local com Vercel Blob
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { OpenAI } = require('openai');
require('dotenv').config();

// Importar utilitários de processamento de PDF
const { parsePdf } = require('./utils/pdfParser');
const { validatePdf, repairPdf } = require('./utils/pdfValidator');
const { isPdfEncrypted, attemptPdfDecryption, isVercelEnvironment } = require('./utils/pdfDecryptor');
const { splitPDF, cleanupTempFiles } = require('./utils/pdfSplitter');
const { processOcr } = require('./utils/ocrService');
// ADIÇÃO: Importar o gerenciador do Vercel Blob
const { 
  shouldUseBlob, 
  processLargePdfWithBlob, 
  validatePdfForBlob 
} = require('./utils/blobHandler');

const app = express();
const PORT = process.env.PORT || 5000;

// Verificar ambiente
const isVercel = isVercelEnvironment();
console.log(`Ambiente: ${isVercel ? 'Vercel' : 'Local'}`);

// Configuração CORS melhorada para permitir acesso do frontend
app.use(cors({
  origin: '*', // Permite qualquer origem - ajuste para produção se necessário
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: 86400 // 24 horas em segundos
}));

// Middleware para parsing JSON com limite aumentado
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Verificar se API Keys existem
if (!process.env.OPENAI_API_KEY) {
  console.error('ERRO: Chave da API da OpenAI não encontrada! Verifique as variáveis de ambiente.');
}

if (!process.env.OCR_API_KEY || process.env.OCR_API_KEY === 'helloworld') {
  console.warn('AVISO: Usando chave de API OCR padrão. Obtenha uma chave em ocr.space para melhor funcionamento.');
}

// Verificar se Vercel Blob está configurado (apenas para logs)
if (isVercel && !process.env.BLOB_READ_WRITE_TOKEN) {
  console.warn('AVISO: BLOB_READ_WRITE_TOKEN não encontrado. Vercel Blob pode não funcionar.');
}

// Configurar OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Configurar diretório de uploads
const uploadDir = isVercel ? '/tmp' : 'uploads';

// Criar diretório de uploads apenas para desenvolvimento local
try {
  if (!isVercel && !fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
    console.log(`Diretório de uploads criado: ${uploadDir}`);
  }
} catch (err) {
  console.error(`Erro ao criar diretório de uploads: ${err.message}`);
}

// Configuração do Multer para upload de arquivos com limites dinâmicos
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname);
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
    // Limites dinâmicos baseados no ambiente
    fileSize: isVercel ? 4 * 1024 * 1024 : 100 * 1024 * 1024 // 4MB Vercel, 100MB local
  }
});

// Middleware para verificar tamanho antes do upload
app.use('/api/upload', (req, res, next) => {
  const contentLength = parseInt(req.headers['content-length'] || '0');
  const maxSize = isVercel ? 4 * 1024 * 1024 : 100 * 1024 * 1024;
  
  if (contentLength > maxSize) {
    const sizeMB = (contentLength / 1024 / 1024).toFixed(2);
    const maxSizeMB = (maxSize / 1024 / 1024).toFixed(0);
    
    return res.status(413).json({ 
      message: `Arquivo muito grande (${sizeMB}MB). Use a rota /api/upload-large para arquivos maiores que ${maxSizeMB}MB.`,
      currentSize: sizeMB + 'MB',
      maxSize: maxSizeMB + 'MB',
      environment: isVercel ? 'vercel' : 'local',
      shouldUseLargeUpload: true
    });
  }
  next();
});

// Nova função para extrair o nome do paciente via OCR
async function extractPatientNameViaOcr(filePath) {
  try {
    console.log("Extraindo nome do paciente via OCR (fallback)...");
    
    // Executar OCR no arquivo
    const ocrResults = await processOcr(filePath);
    
    if (!ocrResults || ocrResults.length === 0 || !ocrResults[0].text) {
      throw new Error("OCR não retornou resultados utilizáveis");
    }
    
    // Extrair nome do paciente do texto OCR
    const initialOcrText = ocrResults[0].text.slice(0, 3000);
    
    // Tentar regex primeiro
    const regexPatterns = [
      /Paciente\s*[:]\s*([A-ZÀ-ÚÇ\s]+)/i,
      /Nome do Paciente\s*[:]\s*([A-ZÀ-ÚÇ\s]+)/i,
      /Paciente[:]?\s+([A-ZÀ-ÚÇ][A-ZÀ-ÚÇa-zà-úç\s]+)/,
      /Nome[:]?\s+([A-ZÀ-ÚÇ][A-ZÀ-ÚÇa-zà-úç\s]+)/
    ];
    
    for (const pattern of regexPatterns) {
      const match = initialOcrText.match(pattern);
      if (match && match[1]) {
        const extractedName = match[1].trim();
        if (extractedName.length > 3 && extractedName.includes(' ')) {
          console.log(`Nome extraído via OCR regex: ${extractedName}`);
          return extractedName;
        }
      }
    }
    
    // Se regex falhar, usar GPT no resultado OCR
    console.log("Usando GPT para extrair o nome do paciente do texto OCR...");
    const response = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { 
          role: 'system', 
          content: 'Você é um extrator preciso de informações de documentos médicos. Você extrai apenas o nome completo do paciente sem adicionar nenhuma informação extra.'
        },
        { 
          role: 'user', 
          content: `Extraia APENAS o nome completo do paciente do seguinte trecho de um exame laboratorial processado por OCR. 
          Retorne SOMENTE o nome completo, sem nenhum texto adicional, prefixo ou sufixo.
          
          Texto para análise:
          ${initialOcrText}` 
        }
      ],
      max_tokens: 100,
      temperature: 0.1,
    });
    
    const patientName = response.choices[0].message.content.trim();
    console.log(`Nome extraído via OCR + GPT: ${patientName}`);
    return patientName;
  } catch (error) {
    console.error("Erro ao extrair nome via OCR:", error);
    return "Nome do Paciente não identificado";
  }
}

// Função para extrair o nome do paciente do PDF com fallback para OCR
async function extractPatientName(pages, filePath) {
  try {
    // Se não temos páginas ou texto, recorrer ao OCR imediatamente
    if (!pages || !pages.length || !pages[0].text) {
      console.log("Sem texto extraível, recorrendo ao OCR para nome do paciente...");
      return await extractPatientNameViaOcr(filePath);
    }
    
    // Pegamos apenas o início do documento para encontrar o nome do paciente
    const initialText = pages[0].text.slice(0, 3000);
    
    // Primeiro, tenta extrair o nome usando expressões regulares (mais rápido e econômico)
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
    
    // Se não conseguiu extrair com regex, usa o GPT
    console.log("Usando GPT para extrair o nome do paciente...");
    const response = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { 
          role: 'system', 
          content: 'Você é um extrator preciso de informações de documentos médicos. Você extrai apenas o nome completo do paciente sem adicionar nenhuma informação extra.'
        },
        { 
          role: 'user', 
          content: `Extraia APENAS o nome completo do paciente do seguinte trecho de um exame laboratorial. 
          Retorne SOMENTE o nome completo, sem nenhum texto adicional, prefixo ou sufixo.
          Se você não conseguir identificar o nome com certeza, retorne "FALLBACK_TO_OCR".
          
          Texto para análise:
          ${initialText}` 
        }
      ],
      max_tokens: 100,
      temperature: 0.1,
    });
    
    const patientName = response.choices[0].message.content.trim();
    
    // Se o GPT não conseguiu extrair o nome com confiança, tentar OCR como fallback
    if (patientName === "FALLBACK_TO_OCR" || 
        patientName === "Nome do Paciente não identificado" || 
        patientName.length < 4 || 
        !patientName.includes(" ")) {
      console.log("GPT não conseguiu extrair o nome com confiança. Tentando OCR como fallback...");
      return await extractPatientNameViaOcr(filePath);
    }
    
    return patientName;
  } catch (error) {
    console.error('Erro ao extrair nome do paciente:', error);
    
    // Se ocorrer um erro, tentamos OCR como último recurso
    try {
      console.log("Erro na extração normal, tentando OCR como fallback...");
      return await extractPatientNameViaOcr(filePath);
    } catch (ocrError) {
      console.error('Erro ao extrair nome via OCR:', ocrError);
      return 'Nome do Paciente não identificado';
    }
  }
}

// Função para gerar resumos com GPT-3.5 - versão simplificada mantendo a ordem original
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

  // Manter um registro global dos exames já extraídos entre todas as páginas
  const seenExams = new Set();
  let allResults = [];

  for (const page of pages) {
    try {
      const textChunks = splitTextIntoChunks(page.text);
      let pageResults = [];
      
      for (const chunk of textChunks) {
        // Prompt específico para extrair apenas referências numéricas com valores
        const prompt = `Analise o seguinte texto de um documento de exames laboratoriais e extraia as informações conforme estas instruções EXATAS:

1. EXTRAIA APENAS:
   - Nome do exame (exatamente como aparece no documento)
   - Valor numérico do resultado (sem unidades de medida). Geralmente vem depois da palavra "Resultado" 
   - Intervalo de referência (somente os valores numéricos mínimo e máximo)

2. FORMATO EXATO para cada linha:
   "Nome do Exame: Valor | VR: Mínimo - Máximo"

3. APENAS para resultados com percentual E valor absoluto, use:
   "Nome do Exame: Percentual % / Valor absoluto | VR: Mínimo - Máximo"

4. REGRAS OBRIGATÓRIAS:
   - NUNCA adicione unidades de medida junto com os valores numéricos
   - NÃO use hífen ou outro caractere no início da linha
   - SEMPRE marque resultados ALTERADOS (fora do VR) adicionando *** APÓS o valor numérico
   - NUNCA adicione texto explicativo ou notas adicionais
   - NUNCA adicione métodos ou informações sobre a técnica utilizada
   - MANTENHA os números EXATAMENTE como aparecem no texto (não arredonde)
   - Para valores com sinal menor ou maior (ex: "<0,5"), mantenha exatamente como aparece
   - Quando o valor de referência é "até X" ou "menor que X", use o formato "0 - X"
   - Para intervalos de referência baseados em idade/sexo, escolha o mais apropriado ou use o intervalo geral

5. EXAMES PRIORITÁRIOS (sempre extrair se presentes):
   - Perfil Lipídico: Colesterol Total, HDL, LDL, VLDL, Triglicerídeos
   - Hormônios: Testosterona Total, SHBG, Testosterona Livre, Testosterona Biodisponível, DHT, Cortisol
   - Metabólicos: Glicose, Insulina, Hemoglobina Glicada, HOMA-IR
   - Função Hepática: TGO/AST, TGP/ALT, GGT, Fosfatase Alcalina, Bilirrubina
   - Função Renal: Ureia, Creatinina, Taxa de Filtração Glomerular, Ácido Úrico
   - Vitaminas e Minerais: Ferro, Ferritina, Vitamina D, Vitamina B12, Zinco, Magnésio, Sódio, Potássio, Cálcio
   - Hematológicos: Hemoglobina, Hematócrito, Leucócitos, Plaquetas
   - Outros: TSH, T4 Livre, T3, Proteína C Reativa, PSA

6. EXEMPLOS CORRETOS:
   - "Glicose: 95 | VR: 70 - 99"
   - "Colesterol Total: 220*** | VR: 0 - 190"
   - "Hemoglobina: 13,5 | VR: 13,0 - 18,0"
   - "Neutrófilos: 65 % / 3900 | VR: 40 - 70"
   - "TSH: <0,01*** | VR: 0,27 - 4,20"

Texto para análise:
${chunk}`;
        
        const response = await openai.chat.completions.create({
          model: 'gpt-3.5-turbo',
          messages: [
            { 
              role: 'system', 
              content: 'Você é um extrator especializado de resultados laboratoriais com extrema precisão. Extraia APENAS a primeira ocorrência de cada exame, mantendo a ordem exata em que aparecem no texto. Não adicione informações extras ou explicações.'
            },
            { role: 'user', content: prompt }
          ],
          max_tokens: 1000,
          temperature: 0.1,
        });
        
        // Processar a resposta linha por linha
        const extractedLines = response.choices[0].message.content.trim().split('\n');
        
        extractedLines.forEach(line => {
          // Ignorar linhas vazias
          if (!line.trim()) return;
          
          // Remover hífens no início e espaços extras
          line = line.replace(/^-\s*/, '').trim();
          
          // Extrair o nome do exame para verificar duplicatas
          const match = line.match(/^([^:]+):/);
          if (match) {
            const examName = match[1].trim().toLowerCase();
            
            // Verificar variantes comuns do mesmo exame (ex: tgo, ast, tgp, alt)
            let examKey = examName;
            if (/\b(tgo|ast|aspartato)\b/.test(examName)) examKey = 'tgo';
            else if (/\b(tgp|alt|alanina)\b/.test(examName)) examKey = 'tgp';
            else if (/\b(gamma|gama|ggt)\b/.test(examName)) examKey = 'ggt';
            else if (/\b(glicose|glicemia)\b/.test(examName)) examKey = 'glicose';
            
            // Apenas adicionar se não vimos este exame antes
            if (!seenExams.has(examKey)) {
              seenExams.add(examKey);
              pageResults.push(line);
            }
          } else {
            // Se não conseguir extrair o nome, adicionar linha mesmo assim
            pageResults.push(line);
          }
        });
      }
      
      // Adicionar resultados desta página ao acumulado global, mantendo a ordem
      allResults = [...allResults, ...pageResults];
      
    } catch (error) {
      console.error(`Erro ao gerar resumo para a página ${page.page}:`, error);
    }
  }
  
  // Montar o resumo final com todos os resultados coletados
  let finalContent = `Paciente: ${patientName}\n\n` + allResults.join('\n');
  
  // Retornar como um único resumo
  return [{
    page: 1,
    content: finalContent
  }];
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

// NOVA FUNÇÃO: Processamento principal de PDF (extraída para reutilização)
async function processPdfMain(pdfBuffer, filename, filePath = null) {
  let tempFiles = [];
  let patientName = 'Nome do Paciente não identificado';
  let extractionMethod = 'normal';
  let processingResults = [];
  
  try {
    console.log(`Processando PDF: ${filename}, tamanho: ${(pdfBuffer.length / 1024 / 1024).toFixed(2)}MB`);
    
    // Passo 1: Validar o PDF
    console.log("Validando o PDF...");
    
    // Passo 2: Verificar se o PDF está criptografado
    const isEncrypted = await isPdfEncrypted(pdfBuffer);
    console.log(`PDF está criptografado? ${isEncrypted ? 'Sim' : 'Não'}`);
    
    let pdfParts = null;
    let finalText = null;
    
    // ADIÇÃO: Tentar OCR primeiro se o PDF estiver criptografado
    if (isEncrypted) {
      try {
        console.log("Tentativa OCR: Processando PDF protegido via API OCR...");
        
        // Para usar OCR, precisamos salvar temporariamente
        let tempPath = null;
        if (filePath) {
          tempPath = filePath;
        } else {
          tempPath = `/tmp/${Date.now()}-${filename}`;
          fs.writeFileSync(tempPath, pdfBuffer);
          tempFiles.push(tempPath);
        }
        
        const ocrResults = await processOcr(tempPath);
        
        if (ocrResults && ocrResults.length > 0 && ocrResults[0].text) {
          console.log("OCR via API bem-sucedido!");
          finalText = ocrResults;
          extractionMethod = 'ocr_api';
          
          // Extrair nome do paciente do texto OCR
          patientName = await extractPatientName(ocrResults, tempPath);
          console.log(`Nome do paciente identificado via OCR: ${patientName}`);
          
          // Preparar os resumos
          const summaries = await generateSummaries(finalText, patientName);
          
          // Processar os resultados para remover duplicatas
          const processedSummaries = summaries.map(summary => ({
            ...summary,
            content: removeDuplicates(summary.content)
          }));
          
          return {
            summaries: processedSummaries,
            patientName: patientName,
            extractionMethod: extractionMethod,
            processingDetails: processingResults.length > 0 ? processingResults : undefined
          };
        } else {
          console.log("OCR via API não retornou texto utilizável, tentando outros métodos");
          processingResults.push({
            method: 'ocr_api',
            success: false,
            error: 'Sem texto reconhecido'
          });
        }
      } catch (ocrError) {
        console.error("Erro no processamento OCR via API:", ocrError);
        processingResults.push({
          method: 'ocr_api',
          success: false,
          error: ocrError.message
        });
      }
    }
    
    // Se OCR falhou ou não foi utilizado, continuar com fluxo normal
    
    // Processando o PDF de acordo com suas características
    if (isEncrypted && !finalText) {
      // Se o PDF estiver criptografado, tentar remover a proteção
      console.log("PDF está criptografado, tentando remover proteção...");
      const decryptResult = await attemptPdfDecryption(filePath || pdfBuffer);
      
      if (decryptResult.success) {
        console.log("Proteção removida com sucesso, processando PDF desprotegido...");
        tempFiles.push(decryptResult.decryptedPath);
        extractionMethod = 'desprotegido';
        
        // Usar o arquivo desprotegido para os próximos passos
        const decryptedBuffer = fs.readFileSync(decryptResult.decryptedPath);
        pdfParts = await splitPDF(decryptedBuffer);
      } else {
        console.log("Não foi possível remover a proteção, tentando reparar...");
        processingResults.push({
          method: 'desproteger',
          success: false,
          error: decryptResult.error
        });
        
        // Tentar reparar o PDF
        const repairResult = await repairPdf(filePath || pdfBuffer);
        
        if (repairResult.success) {
          console.log("PDF reparado com sucesso, processando...");
          tempFiles.push(repairResult.repairedPath);
          extractionMethod = 'reparado';
          
          // Usar o arquivo reparado para os próximos passos
          const repairedBuffer = fs.readFileSync(repairResult.repairedPath);
          pdfParts = await splitPDF(repairedBuffer);
        } else {
          // Se não conseguimos desproteger nem reparar, tentar com o arquivo original
          console.log("Não foi possível reparar, tentando processar o arquivo original...");
          pdfParts = await splitPDF(pdfBuffer);
        }
      }
    } else if (!isEncrypted) {
      // Se o PDF não está criptografado, dividir em partes normalmente
      console.log("Dividindo o PDF em partes menores...");
      pdfParts = await splitPDF(pdfBuffer);
    }
    
    // Se ainda não temos um resultado final do OCR, continuamos o processamento normal
    if (!finalText) {
      // Se não conseguimos dividir o PDF, usar o arquivo original como uma única parte
      if (!pdfParts || pdfParts.length === 0) {
        console.log("Falha ao dividir o PDF, usando como parte única");
        pdfParts = [pdfBuffer];
        if (extractionMethod === 'normal') {
          extractionMethod = 'falha_divisao';
        }
      } else {
        console.log(`PDF dividido em ${pdfParts.length} partes`);
      }
      
      // Extrair texto da primeira parte para obter o nome do paciente
      console.log("Extraindo informações do paciente...");
      const initialPages = await parsePdf(pdfParts[0]);
      
      // Usar a nova função de extração de nome com fallback para OCR
      const tempPathForName = filePath || (tempFiles.length > 0 ? tempFiles[0] : null);
      patientName = await extractPatientName(initialPages, tempPathForName);
      console.log(`Nome do paciente identificado: ${patientName}`);
      
      const allSummaries = [];
      
      // Processar cada parte do PDF
      for (let i = 0; i < pdfParts.length; i++) {
        try {
          console.log(`Processando parte ${i+1}/${pdfParts.length}...`);
          const partBuffer = pdfParts[i];
          
          // Extrair texto desta parte
          const pages = await parsePdf(partBuffer);
          
          // Gerar resumos para esta parte, incluindo o nome do paciente
          const summaries = await generateSummaries(pages, patientName);
          
          // Adicionar os resumos ao array geral
          allSummaries.push(...summaries);
        } catch (partError) {
          console.error(`Erro ao processar a parte ${i+1}:`, partError);
          allSummaries.push({
            page: `Parte ${i+1}`,
            content: `Paciente: ${patientName}\n\nErro ao processar esta parte do documento.`
          });
        }
      }
      
      // Processar os resultados para remover duplicatas
      for (let i = 0; i < allSummaries.length; i++) {
        allSummaries[i].content = removeDuplicates(allSummaries[i].content);
      }
      
      return {
        summaries: allSummaries,
        patientName: patientName,
        extractionMethod: extractionMethod,
        processingDetails: processingResults.length > 0 ? processingResults : undefined
      };
    }
    
  } catch (error) {
    console.error('Erro no processamento:', error);
    throw error;
  } finally {
    // Limpar arquivos temporários
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
}

// Rota para a página inicial
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="pt-br">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>API de Processamento de Exames</title>
        <style>
            body {
                font-family: Arial, sans-serif;
                line-height: 1.6;
                margin: 0;
                padding: 20px;
                color: #333;
                max-width: 800px;
                margin: 0 auto;
            }
            h1 {
                color: #2c3e50;
                border-bottom: 2px solid #3498db;
                padding-bottom: 10px;
            }
            h2 {
                color: #2980b9;
            }
            .endpoint {
                background-color: #f8f9fa;
                border-left: 4px solid #3498db;
                padding: 10px 15px;
                margin: 15px 0;
            }
            .method {
                font-weight: bold;
                color: #e74c3c;
            }
            .path {
                font-family: monospace;
                background-color: #eee;
                padding: 2px 5px;
                border-radius: 3px;
            }
            .description {
                margin-top: 5px;
            }
            footer {
                margin-top: 30px;
                border-top: 1px solid #eee;
                padding-top: 10px;
                font-size: 0.8em;
                color: #7f8c8d;
            }
            .blob-info {
                background: #e7f3ff;
                padding: 15px;
                border-radius: 5px;
                margin: 20px 0;
            }
        </style>
    </head>
    <body>
        <h1>API de Processamento de Exames</h1>
        <p>Esta é a API do sistema de processamento de laudos laboratoriais. Esta API fornece endpoints para processar arquivos PDF de exames médicos e extrair informações relevantes.</p>
        
        <h2>Endpoints Disponíveis</h2>
        
        <div class="endpoint">
            <div><span class="method">GET</span> <span class="path">/api/health</span></div>
            <div class="description">Verifica se a API está funcionando corretamente.</div>
        </div>
        
        <div class="endpoint">
            <div><span class="method">POST</span> <span class="path">/api/upload</span></div>
            <div class="description">Recebe um arquivo PDF de exames médicos (até 4MB) e retorna um resumo estruturado dos dados extraídos.</div>
        </div>
        
        <div class="endpoint">
            <div><span class="method">POST</span> <span class="path">/api/upload-large</span></div>
            <div class="description">Processa arquivos PDF grandes (até 100MB) usando Vercel Blob storage.</div>
        </div>
        
        <div class="blob-info">
            <h3>💡 Suporte para Arquivos Grandes</h3>
            <p><strong>Arquivos até 4MB:</strong> Use /api/upload (upload direto)</p>
            <p><strong>Arquivos maiores que 4MB:</strong> Use /api/upload-large (via Vercel Blob)</p>
            <p><strong>Limite máximo:</strong> 100MB por arquivo</p>
        </div>
        
        <h2>Como Usar</h2>
        <p>Esta API deve ser consumida pelo frontend da aplicação. Não é destinada para uso direto no navegador.</p>
        
        <footer>
            &copy; 2025 Instituto Paulo Godoi - API de Processamento de Exames
            <p>Ambiente: ${isVercel ? 'Vercel (Produção)' : 'Local (Desenvolvimento)'}</p>
            <p>Blob Storage: ${process.env.BLOB_READ_WRITE_TOKEN ? 'Configurado' : 'Não configurado'}</p>
        </footer>
    </body>
    </html>
  `);
});

// Rota para verificação de saúde da API
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    env: isVercel ? 'vercel' : 'local',
    timestamp: new Date().toISOString(),
    blobSupport: !!process.env.BLOB_READ_WRITE_TOKEN,
    limits: {
      smallFiles: '4MB (upload direto)',
      largeFiles: '100MB (via Blob)'
    }
  });
});

// Rota para upload de PDFs pequenos (método original)
app.post('/api/upload', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'Nenhum arquivo foi enviado' });
    }

    const filePath = req.file.path;
    const fileSize = fs.statSync(filePath).size;
    const fileSizeMB = fileSize / (1024 * 1024);
    
    console.log(`Arquivo recebido via upload direto: ${req.file.originalname} (${fileSizeMB.toFixed(2)}MB)`);
    
    // Lista para armazenar caminhos de arquivos temporários para limpeza
    let tempFiles = [];
    let patientName = 'Nome do Paciente não identificado';
    let extractionMethod = 'normal';
    let errorDetails = null;
    
    try {
      // Ler o arquivo PDF
      const pdfBuffer = fs.readFileSync(filePath);
      console.log(`Arquivo lido com sucesso, tamanho: ${pdfBuffer.length} bytes`);
      
      // Passo 1: Validar o PDF
      console.log("Validando o PDF...");
      const validationResult = await validatePdf(filePath);
      console.log("Resultado da validação:", validationResult.message);
      
      // Passo 2: Verificar se o PDF está criptografado
      const isEncrypted = await isPdfEncrypted(filePath);
      console.log(`PDF está criptografado? ${isEncrypted ? 'Sim' : 'Não'}`);
      
      // Array para armazenar os resultados das tentativas
      let processingResults = [];
      let pdfParts = null;
      let finalText = null;
      
      // ADIÇÃO: Tentar OCR primeiro se o PDF estiver criptografado
      if (isEncrypted) {
        try {
          console.log("Tentativa OCR: Processando PDF protegido via API OCR...");
          
          // Executar OCR usando API externa
          const ocrResults = await processOcr(filePath);
          
          if (ocrResults && ocrResults.length > 0 && ocrResults[0].text) {
            console.log("OCR via API bem-sucedido!");
            finalText = ocrResults;
            extractionMethod = 'ocr_api';
            
            // Extrair nome do paciente do texto OCR
            patientName = await extractPatientName(ocrResults, filePath);
            console.log(`Nome do paciente identificado via OCR: ${patientName}`);
            
            // Preparar os resumos
            const summaries = await generateSummaries(finalText, patientName);
            
            // Processar os resultados para remover duplicatas
            const processedSummaries = summaries.map(summary => ({
              ...summary,
              content: removeDuplicates(summary.content)
            }));
            
            // Limpar arquivos temporários
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
            
            // Limpar arquivo original
            try {
              if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                console.log(`Arquivo original removido: ${filePath}`);
              }
            } catch (unlinkError) {
              console.error(`Erro ao remover arquivo original ${filePath}:`, unlinkError);
            }
            
            // Retornar resultados do OCR
            return res.json({ 
              summaries: processedSummaries,
              patientName: patientName,
              extractionMethod: extractionMethod,
              uploadMethod: 'direct',
              fileSize: fileSizeMB.toFixed(2) + 'MB',
              processingDetails: processingResults.length > 0 ? processingResults : undefined
            });
          } else {
            console.log("OCR via API não retornou texto utilizável, tentando outros métodos");
            processingResults.push({
              method: 'ocr_api',
              success: false,
              error: 'Sem texto reconhecido'
            });
          }
        } catch (ocrError) {
          console.error("Erro no processamento OCR via API:", ocrError);
          processingResults.push({
            method: 'ocr_api',
            success: false,
            error: ocrError.message
          });
        }
      }
      
      // Se OCR falhou ou não foi utilizado, continuar com fluxo normal
      
      // Processando o PDF de acordo com suas características
      if (isEncrypted && !finalText) {
        // Se o PDF estiver criptografado, tentar remover a proteção
        console.log("PDF está criptografado, tentando remover proteção...");
        const decryptResult = await attemptPdfDecryption(filePath);
        
        if (decryptResult.success) {
          console.log("Proteção removida com sucesso, processando PDF desprotegido...");
          tempFiles.push(decryptResult.decryptedPath);
          extractionMethod = 'desprotegido';
          
          // Usar o arquivo desprotegido para os próximos passos
          const decryptedBuffer = fs.readFileSync(decryptResult.decryptedPath);
          pdfParts = await splitPDF(decryptedBuffer);
        } else {
          console.log("Não foi possível remover a proteção, tentando reparar...");
          processingResults.push({
            method: 'desproteger',
            success: false,
            error: decryptResult.error
          });
          
          // Tentar reparar o PDF
          const repairResult = await repairPdf(filePath);
          
          if (repairResult.success) {
            console.log("PDF reparado com sucesso, processando...");
            tempFiles.push(repairResult.repairedPath);
            extractionMethod = 'reparado';
            
            // Usar o arquivo reparado para os próximos passos
            const repairedBuffer = fs.readFileSync(repairResult.repairedPath);
            pdfParts = await splitPDF(repairedBuffer);
          } else {
            // Se não conseguimos desproteger nem reparar, tentar com o arquivo original
            console.log("Não foi possível reparar, tentando processar o arquivo original...");
            pdfParts = await splitPDF(pdfBuffer);
          }
        }
      } else if (!isEncrypted) {
        // Se o PDF não está criptografado, dividir em partes normalmente
        console.log("Dividindo o PDF em partes menores...");
        pdfParts = await splitPDF(pdfBuffer);
      }
      
      // Se ainda não temos um resultado final do OCR, continuamos o processamento normal
      if (!finalText) {
        // Se não conseguimos dividir o PDF, usar o arquivo original como uma única parte
        if (!pdfParts || pdfParts.length === 0) {
          console.log("Falha ao dividir o PDF, usando como parte única");
          pdfParts = [pdfBuffer];
          if (extractionMethod === 'normal') {
            extractionMethod = 'falha_divisao';
          }
        } else {
          console.log(`PDF dividido em ${pdfParts.length} partes`);
        }
        
        // Extrair texto da primeira parte para obter o nome do paciente
        console.log("Extraindo informações do paciente...");
        const initialPages = await parsePdf(pdfParts[0]);
        
        // Usar a nova função de extração de nome com fallback para OCR
        patientName = await extractPatientName(initialPages, filePath);
        console.log(`Nome do paciente identificado: ${patientName}`);
        
        const allSummaries = [];
        
        // Processar cada parte do PDF
        for (let i = 0; i < pdfParts.length; i++) {
          try {
            console.log(`Processando parte ${i+1}/${pdfParts.length}...`);
            const partBuffer = pdfParts[i];
            
            // Extrair texto desta parte
            const pages = await parsePdf(partBuffer);
            
            // Gerar resumos para esta parte, incluindo o nome do paciente
            const summaries = await generateSummaries(pages, patientName);
            
            // Adicionar os resumos ao array geral
            allSummaries.push(...summaries);
          } catch (partError) {
            console.error(`Erro ao processar a parte ${i+1}:`, partError);
            allSummaries.push({
              page: `Parte ${i+1}`,
              content: `Paciente: ${patientName}\n\nErro ao processar esta parte do documento.`
            });
          }
        }
        
        // Processar os resultados para remover duplicatas
        for (let i = 0; i < allSummaries.length; i++) {
          allSummaries[i].content = removeDuplicates(allSummaries[i].content);
        }
        
        // Limpar arquivos temporários
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
        
        // Limpar arquivo original
        try {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`Arquivo original removido: ${filePath}`);
          }
        } catch (unlinkError) {
          console.error(`Erro ao remover arquivo original ${filePath}:`, unlinkError);
        }
        
        // Retornar resultados
        res.json({ 
          summaries: allSummaries,
          patientName: patientName,
          extractionMethod: extractionMethod,
          uploadMethod: 'direct',
          fileSize: fileSizeMB.toFixed(2) + 'MB',
          processingDetails: processingResults.length > 0 ? processingResults : undefined
        });
      }
    } catch (processingError) {
      console.error("Erro global de processamento:", processingError);
      
      // Limpar arquivos temporários em caso de erro
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
      
      // Limpar arquivo original
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log(`Arquivo original removido: ${filePath}`);
        }
      } catch (unlinkError) {
        console.error(`Erro ao remover arquivo original ${filePath}:`, unlinkError);
      }
      
      // Retornar erro
      res.status(500).json({ 
        message: 'Erro ao processar o documento: ' + processingError.message,
        error: processingError.toString()
      });
    }
  } catch (error) {
    console.error('Erro ao processar o PDF:', error);
    res.status(500).json({ 
      message: 'Erro ao processar o documento: ' + error.message,
      error: error.toString()
    });
  }
});

// NOVA ROTA: Upload para arquivos grandes usando Vercel Blob
app.post('/api/upload-large', async (req, res) => {
  try {
    const { filename, fileData } = req.body;
    
    if (!filename || !fileData) {
      return res.status(400).json({ 
        message: 'Dados obrigatórios: filename e fileData (base64)' 
      });
    }
    
    console.log(`Processando arquivo grande via Blob: ${filename}`);
    
    // Converter base64 de volta para buffer
    const pdfBuffer = Buffer.from(fileData, 'base64');
    const fileSizeMB = pdfBuffer.length / (1024 * 1024);
    
    console.log(`Tamanho do arquivo: ${fileSizeMB.toFixed(2)}MB`);
    
    // Validar arquivo para blob
    const validation = validatePdfForBlob(pdfBuffer, filename);
    if (!validation.valid) {
      return res.status(400).json({
        message: validation.error,
        size: validation.size + 'MB'
      });
    }
    
    try {
      // Processar usando Vercel Blob
      const results = await processLargePdfWithBlob(
        pdfBuffer, 
        filename, 
        (buffer, fname) => processPdfMain(buffer, fname)
      );
      
      console.log(`Arquivo processado com sucesso via Blob: ${filename}`);
      
      // Retornar resultados
      res.json({
        ...results,
        uploadMethod: 'blob',
        fileSize: fileSizeMB.toFixed(2) + 'MB'
      });
      
    } catch (processingError) {
      console.error("Erro no processamento via Blob:", processingError);
      res.status(500).json({ 
        message: 'Erro ao processar o documento via Blob: ' + processingError.message,
        error: processingError.toString()
      });
    }
    
  } catch (error) {
    console.error('Erro geral no upload-large:', error);
    res.status(500).json({ 
      message: 'Erro ao processar o documento: ' + error.message,
      error: error.toString()
    });
  }
});

// Handler de erro do Multer
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      const maxSize = isVercel ? 4 : 100;
      return res.status(413).json({
        message: `Arquivo excede o limite de ${maxSize}MB permitido`,
        error: 'FILE_TOO_LARGE',
        maxSize: maxSize + 'MB',
        suggestion: 'Use a rota /api/upload-large para arquivos maiores que 4MB'
      });
    }
  }
  
  if (error.message.includes('413')) {
    return res.status(413).json({
      message: 'Arquivo muito grande para processamento',
      error: 'PAYLOAD_TOO_LARGE',
      suggestion: 'Use a rota /api/upload-large para arquivos maiores'
    });
  }
  
  console.error('Erro não tratado:', error);
  res.status(500).json({ message: 'Erro interno do servidor', error: error.message });
});

// Iniciar o servidor apenas em ambiente local
if (!isVercel) {
  app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log(`Acesse: http://localhost:${PORT}`);
    console.log(`Verificação de saúde: http://localhost:${PORT}/api/health`);
    console.log(`Blob support: ${process.env.BLOB_READ_WRITE_TOKEN ? 'Sim' : 'Não'}`);
  });
}

// Exportar o app para o Vercel
module.exports = app;