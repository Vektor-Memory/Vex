/**
 * connectors/index.js — connector registry
 * Maps connector name strings to connector modules
 */

import { vektorConnector }    from './vektor.js';
import { jsonlConnector }     from './jsonl.js';
import { pineconeConnector }  from './pinecone.js';
import { qdrantConnector }    from './qdrant.js';
import { chromaConnector }    from './chroma.js';
import { weaviateConnector }  from './weaviate.js';
import { pgvectorConnector }  from './pgvector.js';
import { redisConnector }     from './redis.js';
import { milvusConnector }    from './milvus.js';
import { neo4jConnector }     from './neo4j.js';
import { claudeExportConnector }  from './claude-export.js';
import { chatgptExportConnector } from './chatgpt-export.js';

export const connectors = {
  'vektor':         vektorConnector,
  'jsonl':          jsonlConnector,
  'pinecone':       pineconeConnector,
  'qdrant':         qdrantConnector,
  'chroma':         chromaConnector,
  'weaviate':       weaviateConnector,
  'pgvector':       pgvectorConnector,
  'postgres':       pgvectorConnector,   // alias
  'redis':          redisConnector,
  'milvus':         milvusConnector,
  'zilliz':         milvusConnector,     // alias
  'neo4j':          neo4jConnector,
  'claude-export':  claudeExportConnector,
  'chatgpt-export': chatgptExportConnector,
};

export function getConnector(name) {
  const c = connectors[name?.toLowerCase()];
  if (!c) {
    const available = Object.keys(connectors).join(', ');
    throw new Error(`Unknown connector: "${name}". Available: ${available}`);
  }
  return c;
}
