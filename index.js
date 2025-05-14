// index.js - Servidor Node.js otimizado para Vercel e ambiente local
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

// Middleware
app.use(express.json());

// Verificar se API Key existe
if (!process.env.OPENAI_API_KEY) {
  console.error('ERRO: Chave da API da OpenAI não encontrada! Verifique as variáveis de ambiente.');
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

// Configuração do Multer para upload de arquivos
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
    fileSize: 50 * 1024 * 1024 // Limite de 50MB
  }
});

// Função para extrair o nome do paciente do PDF
async function extractPatientName(pages) {
  try {
    // Se não temos páginas ou texto, retornar valor padrão
    if (!pages || !pages.length || !pages[0].text) {
      return 'Nome do Paciente não identificado';
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
          Se você não conseguir identificar o nome com certeza, retorne "Nome do Paciente não identificado".
          
          Texto para análise:
          ${initialText}` 
        }
      ],
      max_tokens: 100,
      temperature: 0.1,
    });
    
    const patientName = response.choices[0].message.content.trim();
    return patientName;
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
- NÃO adicione texto explicativo, notas ou métodos
- NÃO adicione informações específicas para gestantes, idosos, etc.
- APENAS extraia os valores principais conforme o formato acima
- Mantenha apenas o valor final de referência, sem explicações adicionais
- Quando o valor do resultado estiver alterado (maior ou menor que o valor de referencia), colocar 3 asteriscos no nome
- SEMPRE EXTRAIA TODOS OS RESULTADOS DO HEMOGRAMA COMPLETO
- SEMPRE EXTRAIA TODOS OS RESULTADOS DO ERITROGRAMA E LEUCOGRAMA


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
            <div class="description">Recebe um arquivo PDF de exames médicos e retorna um resumo estruturado dos dados extraídos.</div>
        </div>
        
        <h2>Como Usar</h2>
        <p>Esta API deve ser consumida pelo frontend da aplicação. Não é destinada para uso direto no navegador.</p>
        
        <footer>
            &copy; 2025 Instituto Paulo Godoi - API de Processamento de Exames
            <p>Ambiente: ${isVercel ? 'Vercel (Produção)' : 'Local (Desenvolvimento)'}</p>
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
    timestamp: new Date().toISOString()
  });
});

// Rota para o upload do PDF com tratamento para PDFs problemáticos
// Usando apenas bibliotecas compatíveis com Vercel
app.post('/api/upload', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'Nenhum arquivo foi enviado' });
    }

    // Caminho do arquivo simplificado
    const filePath = req.file.path;
    console.log(`Arquivo recebido: ${filePath}`);
    
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
      
      // Processando o PDF de acordo com suas características
      if (isEncrypted) {
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
      } else {
        // Se o PDF não está criptografado, dividir em partes normalmente
        console.log("Dividindo o PDF em partes menores...");
        pdfParts = await splitPDF(pdfBuffer);
      }
      
      // Se não conseguimos dividir o PDF, usar o arquivo original como uma única parte
      if (!pdfParts || pdfParts.length === 0) {
        console.log("Falha ao dividir o PDF, usando como parte única");
        pdfParts = [pdfBuffer];
        extractionMethod = 'falha_divisao';
      } else {
        console.log(`PDF dividido em ${pdfParts.length} partes`);
      }
      
      // Extrair texto da primeira parte para obter o nome do paciente
      console.log("Extraindo informações do paciente...");
      const initialPages = await parsePdf(pdfParts[0]);
      patientName = await extractPatientName(initialPages);
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
        processingDetails: processingResults.length > 0 ? processingResults : undefined
      });
      
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

// Iniciar o servidor apenas em ambiente local
if (!isVercel) {
  app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log(`Acesse: http://localhost:${PORT}`);
    console.log(`Verificação de saúde: http://localhost:${PORT}/api/health`);
  });
}

// Exportar o app para o Vercel
module.exports = app;