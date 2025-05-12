// index.js - versão otimizada para Vercel
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const { OpenAI } = require('openai');
const { PDFDocument } = require('pdf-lib');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Verificar se API Key existe
if (!process.env.OPENAI_API_KEY) {
  console.error('ERRO: Chave da API da OpenAI não encontrada! Verifique as variáveis de ambiente.');
}

// Configurar OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Verificar ambiente Vercel
const isVercel = process.env.VERCEL || false;
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
  }
});

// Função para dividir o PDF em partes menores (a cada 10 páginas)
async function splitPDF(pdfBuffer) {
  try {
    // Carregar o PDF original - adicionando opção para ignorar criptografia
    const originalPdfDoc = await PDFDocument.load(pdfBuffer, { 
      ignoreEncryption: true 
    });
    const pageCount = originalPdfDoc.getPageCount();
    
    // Determinar quantas partes teremos
    const PAGES_PER_PART = 10;
    const numberOfParts = Math.ceil(pageCount / PAGES_PER_PART);
    
    // Array para armazenar as partes do PDF
    const pdfParts = [];
    
    // Dividir o PDF em partes menores
    for (let i = 0; i < numberOfParts; i++) {
      // Criar um novo documento PDF
      const newPdfDoc = await PDFDocument.create();
      
      // Determinar as páginas para esta parte
      const startPage = i * PAGES_PER_PART;
      const endPage = Math.min((i + 1) * PAGES_PER_PART, pageCount);
      
      // Copiar as páginas do PDF original
      const pagesToCopy = originalPdfDoc.getPages().slice(startPage, endPage);
      const copiedPages = await newPdfDoc.copyPages(originalPdfDoc, pagesToCopy.map((_, index) => startPage + index));
      
      // Adicionar as páginas copiadas ao novo documento
      copiedPages.forEach(page => {
        newPdfDoc.addPage(page);
      });
      
      // Salvar esta parte como um buffer
      const pdfBytes = await newPdfDoc.save();
      pdfParts.push(Buffer.from(pdfBytes));
      
      console.log(`Parte ${i+1}/${numberOfParts} criada (páginas ${startPage+1}-${endPage})`);
    }
    
    return pdfParts;
  } catch (error) {
    console.error('Erro ao dividir o PDF:', error);
    
    // Se ocorrer erro na divisão, retornaremos o PDF original como uma única parte
    console.log('Tentando processar o PDF original sem dividir...');
    return [pdfBuffer];
  }
}

// Função para extrair texto do PDF
async function parsePdf(pdfBuffer) {
  try {
    // Opções adicionais para lidar com PDFs criptografados na biblioteca pdf-parse
    const options = {};
    
    const data = await pdfParse(pdfBuffer, options);
    
    // Retornar apenas o texto de cada parte do PDF
    return [{ 
      page: 'Resultados', 
      text: data.text 
    }];
  } catch (error) {
    console.error('Erro ao analisar o PDF:', error);
    
    // Se houver erro na análise do PDF, tente um método alternativo
    // ou retorne um objeto vazio para evitar quebrar o fluxo
    console.log('Utilizando método alternativo para extrair texto...');
    return [{ 
      page: 'Resultados', 
      text: 'Não foi possível extrair o texto do PDF. É possível que o documento esteja protegido.' 
    }];
  }
}

// Função para extrair o nome do paciente do PDF
async function extractPatientName(pages) {
  try {
    // Pegamos apenas o início do documento para encontrar o nome do paciente
    // Normalmente, essas informações estão nas primeiras páginas
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
"Nome do Exame: Resultado Unidade | Referência: Valor mínimo - Valor máximo"

Formato exato para resultados duplos (percentual e absoluto):
"Nome do Exame: Resultado1 % / Resultado2 Unidade | Referência: Valor mínimo - Valor máximo"

IMPORTANTE:
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

// Rota para verificar se o servidor está funcionando
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', env: isVercel ? 'vercel' : 'local' });
});

// Rota para o upload do PDF
app.post('/api/upload', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'Nenhum arquivo foi enviado' });
    }

    // Caminho do arquivo simplificado
    const filePath = req.file.path;
    console.log(`Arquivo recebido: ${filePath}`);
    
    const pdfBuffer = fs.readFileSync(filePath);
    console.log(`Arquivo lido com sucesso, tamanho: ${pdfBuffer.length} bytes`);
    
    let patientName = '';
    let pdfParts = [];
    let extractionMethod = 'normal';
    
    try {
      // Tentar dividir o PDF em partes menores (a cada 10 páginas)
      console.log("Dividindo o PDF em partes menores...");
      pdfParts = await splitPDF(pdfBuffer);
      console.log(`PDF dividido em ${pdfParts.length} partes.`);
    } catch (splitError) {
      console.error('Erro na divisão do PDF. Tentando processar o arquivo inteiro:', splitError);
      pdfParts = [pdfBuffer]; // Usar o PDF original como uma única parte
      extractionMethod = 'alternativo';
    }
    
    try {
      // Extrair texto da primeira parte para obter o nome do paciente
      console.log("Extraindo informações do paciente...");
      const initialPages = await parsePdf(pdfParts[0]);
      patientName = await extractPatientName(initialPages);
      console.log(`Nome do paciente identificado: ${patientName}`);
    } catch (nameError) {
      console.error('Erro ao extrair o nome do paciente:', nameError);
      patientName = 'Nome do Paciente não identificado';
    }
    
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
    
    try {
      // Limpar arquivo temporário
      fs.unlinkSync(filePath);
      console.log(`Arquivo temporário removido: ${filePath}`);
    } catch (unlinkError) {
      console.error('Erro ao remover arquivo temporário:', unlinkError);
    }

    res.json({ 
      summaries: allSummaries,
      patientName: patientName,
      extractionMethod: extractionMethod
    });
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
  });
}

// Exportar o app para o Vercel
module.exports = app;