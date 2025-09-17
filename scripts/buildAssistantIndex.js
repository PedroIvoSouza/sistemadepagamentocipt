#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs/promises');
const path = require('path');

const { vectorStorePath, openAiEmbeddingModel, repoRoot } = require('../src/services/assistant/assistantConfig');
const { getClient, isConfigured } = require('../src/services/assistant/openaiClient');

const INCLUDE_EXTENSIONS = new Set(['.js', '.json', '.md', '.html', '.css', '.sql', '.txt']);
const EXCLUDE_DIRS = new Set([
  'node_modules',
  '.git',
  '.github',
  '.idea',
  '.vscode',
  'config/assistant',
  'sistemadepagamentocipt',
  'extrator-termos-drive',
  'tests/tmp',
]);

const CHUNK_SIZE_LINES = Number(process.env.ASSISTANT_CHUNK_LINES || 48);
const CHUNK_OVERLAP_LINES = Number(process.env.ASSISTANT_CHUNK_OVERLAP || 10);
const MAX_FILE_SIZE_BYTES = Number(process.env.ASSISTANT_MAX_FILE_SIZE || 280000);
const BATCH_SIZE = Number(process.env.ASSISTANT_EMBED_BATCH || 12);

function shouldSkipDir(relativePath) {
  for (const dir of EXCLUDE_DIRS) {
    if (!dir) continue;
    if (relativePath === dir || relativePath.startsWith(`${dir}/`)) {
      return true;
    }
  }
  return false;
}

function shouldIndexFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!INCLUDE_EXTENSIONS.has(ext)) {
    return false;
  }
  return true;
}

async function collectFiles(startDir) {
  const entries = await fs.readdir(startDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absPath = path.join(startDir, entry.name);
    const relPath = path.relative(repoRoot, absPath);

    if (shouldSkipDir(relPath)) {
      continue;
    }

    if (entry.isDirectory()) {
      const childFiles = await collectFiles(absPath);
      files.push(...childFiles);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (!shouldIndexFile(relPath)) {
      continue;
    }

    const stats = await fs.stat(absPath);
    if (stats.size > MAX_FILE_SIZE_BYTES) {
      console.warn(`[assistant:index] Ignorando ${relPath} (arquivo grande: ${stats.size} bytes).`);
      continue;
    }

    files.push({ absPath, relPath });
  }

  return files;
}

function chunkContent(content) {
  const lines = content.split(/\r?\n/);
  const chunks = [];
  if (!lines.length) return chunks;

  const chunkSize = Math.max(CHUNK_SIZE_LINES, 8);
  const overlap = Math.min(CHUNK_OVERLAP_LINES, chunkSize - 1);

  let start = 0;
  while (start < lines.length) {
    const end = Math.min(lines.length, start + chunkSize);
    const slice = lines.slice(start, end);
    const text = slice.join('\n').trim();
    if (text) {
      chunks.push({
        startLine: start + 1,
        endLine: end,
        content: text,
      });
    }
    if (end >= lines.length) {
      break;
    }
    start = end - overlap;
    if (start < 0) start = 0;
  }

  return chunks;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  if (!isConfigured()) {
    console.error('[assistant:index] OPENAI_API_KEY não configurada.');
    process.exit(1);
  }

  const client = getClient();
  if (!client) {
    console.error('[assistant:index] Não foi possível inicializar o cliente OpenAI.');
    process.exit(1);
  }

  console.log('[assistant:index] Coletando arquivos...');
  const files = await collectFiles(repoRoot);
  if (!files.length) {
    console.error('[assistant:index] Nenhum arquivo elegível encontrado.');
    process.exit(1);
  }

  console.log(`[assistant:index] ${files.length} arquivo(s) serão processados.`);
  const vectors = [];
  let chunkCounter = 0;

  for (const file of files) {
    const raw = await fs.readFile(file.absPath, 'utf-8');
    const fileChunks = chunkContent(raw);
    if (!fileChunks.length) {
      continue;
    }

    const batches = [];
    for (let i = 0; i < fileChunks.length; i += BATCH_SIZE) {
      batches.push(fileChunks.slice(i, i + BATCH_SIZE));
    }

    for (const batch of batches) {
      const inputs = batch.map((chunk) => chunk.content);
      const response = await client.embeddings.create({
        model: openAiEmbeddingModel,
        input: inputs,
      });

      if (!response || !response.data || response.data.length !== batch.length) {
        console.warn(`[assistant:index] Resposta inesperada ao processar ${file.relPath}.`);
        continue;
      }

      response.data.forEach((item, idx) => {
        const chunk = batch[idx];
        vectors.push({
          id: `chunk-${chunkCounter}`,
          file: file.relPath,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          content: chunk.content,
          embedding: item.embedding,
        });
        chunkCounter += 1;
      });
    }
  }

  if (!vectors.length) {
    console.error('[assistant:index] Nenhum vetor foi gerado.');
    process.exit(1);
  }

  const payload = {
    model: openAiEmbeddingModel,
    createdAt: new Date().toISOString(),
    repoRoot,
    chunk: {
      sizeLines: CHUNK_SIZE_LINES,
      overlapLines: CHUNK_OVERLAP_LINES,
    },
    filesIndexed: files.length,
    vectors,
  };

  if (dryRun) {
    console.log(`[assistant:index] Execução em modo dry-run. Vetores gerados: ${vectors.length}. Nada foi gravado.`);
    return;
  }

  await fs.mkdir(path.dirname(vectorStorePath), { recursive: true });
  await fs.writeFile(vectorStorePath, JSON.stringify(payload, null, 2), 'utf-8');
  console.log(`[assistant:index] Vetores salvos em ${vectorStorePath}. Total de ${vectors.length} trecho(s).`);
}

main().catch((err) => {
  console.error('[assistant:index] Falha geral:', err.message);
  process.exit(1);
});
