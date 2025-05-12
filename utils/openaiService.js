// server/utils/openaiService.js
const { OpenAI } = require('openai');
require('dotenv').config();

// Inicializar cliente OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Gera resumos para cada página do PDF usando GPT-3.5 Turbo
 * @param {Array} pages - Array de objetos com número da página e texto
 * @returns {Promise<Array>} - Array de objetos com número da página e resumo
 */
async function generateSummaries(pages) {
  const summaries = [];

  // Função para dividir o texto em chunks menores
  function splitTextIntoChunks(text, maxTokens = 3000) {
    // Estimativa aproximada: 1 token ≈ 4 caracteres para texto em português
    const chunkSize = maxTokens * 4;
    const chunks = [];
    
    for (let i = 0; i < text.length; i += chunkSize) {
      chunks.push(text.slice(i, i + chunkSize));
    }
    
    return chunks;
  }

  // Para cada página, gerar resumo
  for (const page of pages) {
    try {
      // Dividir o texto em chunks se for muito grande
      const textChunks = splitTextIntoChunks(page.text);
      let pageResumo = '';
      
      // Processar cada chunk separadamente para economizar tokens
      for (const chunk of textChunks) {
        // Prompt específico para extrair apenas referências numéricas com valores
        const prompt = `Analise o seguinte texto de um documento e liste APENAS as referências numéricas 
        com seus respectivos valores. Formato desejado: "Referência X: Valor". Ignore qualquer outro 
        conteúdo que não seja referência numérica com valor associado. Texto:

        ${chunk}`;
        
        const response = await openai.chat.completions.create({
          model: 'gpt-3.5-turbo',
          messages: [
            { role: 'system', content: 'Você é um assistente especializado em extrair e resumir informações de documentos. Extraia apenas referências numéricas com seus valores.' },
            { role: 'user', content: prompt }
          ],
          max_tokens: 800,
          temperature: 0.3, // Baixa temperatura para respostas mais precisas
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
        content: 'Erro ao gerar resumo para esta página.'
      });
    }
  }
  
  return summaries;
}

module.exports = { generateSummaries };