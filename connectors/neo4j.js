/**
 * connectors/neo4j.js — Neo4j graph database
 * Requires: neo4j-driver (npm install neo4j-driver)
 *
 * Usage:
 *   vex migrate --from vektor --to neo4j --neo4j-url bolt://localhost:7687 --neo4j-user neo4j --neo4j-password secret
 *   vex export --from neo4j --neo4j-url bolt://localhost:7687 --neo4j-user neo4j --neo4j-password secret --output out.vmig.jsonl
 *
 * Aura (Neo4j Cloud):
 *   vex migrate ... --neo4j-url neo4j+s://xxx.databases.neo4j.io --neo4j-user neo4j --neo4j-password <key>
 *
 * Graph model:
 *   (:Memory {id, content, namespace, importance, tags, created_at, source})
 *   (:Entity {name})
 *   (:Memory)-[:MENTIONS]->(:Entity)
 *   (:Memory)-[:TEMPORAL_NEXT]->(:Memory)   (from graph edges if available)
 *   (:Memory)-[:RELATED_TO]->(:Memory)      (tag-based similarity)
 */

import { toRecord } from '../formats/vmig.js';
import { createRequire } from 'module';

const require      = createRequire(import.meta.url);
const DEFAULT_URL  = 'bolt://localhost:7687';
const DEFAULT_USER = 'neo4j';
const BATCH_SIZE   = 200;

function getDriver(opts) {
  try {
    const neo4j  = require('neo4j-driver');
    const url     = opts['neo4j-url'] || opts.url || process.env.NEO4J_URL || DEFAULT_URL;
    const user    = opts['neo4j-user'] || opts.username || process.env.NEO4J_USER || DEFAULT_USER;
    const pass    = opts['neo4j-password'] || opts.password || process.env.NEO4J_PASSWORD || '';
    return neo4j.driver(url, neo4j.auth.basic(user, pass));
  } catch {
    throw new Error('neo4j-driver not found — run: npm install neo4j-driver');
  }
}

export const neo4jConnector = {
  name: 'neo4j',

  async extract(opts) {
    const driver  = getDriver(opts);
    const session = driver.session();
    const ns      = opts.namespace;
    const limit   = parseInt(opts.limit || '10000');

    try {
      const query  = ns
        ? 'MATCH (m:Memory {namespace: $ns}) RETURN m LIMIT $limit'
        : 'MATCH (m:Memory) RETURN m LIMIT $limit';
      const params = ns ? { ns, limit } : { limit };
      const result = await session.run(query, params);

      const records = result.records.map(rec => {
        const m = rec.get('m').properties;
        return toRecord({
          id:         m.id,
          text:       m.content || '',
          vector:     m.vector ? JSON.parse(m.vector) : null,
          namespace:  m.namespace || 'default',
          importance: m.importance || 0.6,
          tags:       m.tags || '',
          created_at: m.created_at ? m.created_at.toNumber?.() ?? m.created_at : 0,
        }, 'neo4j');
      });

      console.log(`[neo4j] extracted ${records.length} Memory nodes`);
      return records;
    } finally {
      await session.close();
      await driver.close();
    }
  },

  async load(records, opts) {
    const driver  = getDriver(opts);
    const session = driver.session();
    let   upserted = 0;
    let   skipped  = 0;

    try {
      // Create constraints + indexes once
      await session.run('CREATE CONSTRAINT memory_id IF NOT EXISTS FOR (m:Memory) REQUIRE m.id IS UNIQUE');
      await session.run('CREATE CONSTRAINT entity_name IF NOT EXISTS FOR (e:Entity) REQUIRE e.name IS UNIQUE');
      await session.run('CREATE INDEX memory_namespace IF NOT EXISTS FOR (m:Memory) ON (m.namespace)');
      await session.run('CREATE INDEX memory_importance IF NOT EXISTS FOR (m:Memory) ON (m.importance)');

      // Batch upsert Memory nodes
      for (let i = 0; i < records.length; i += BATCH_SIZE) {
        const batch = records.slice(i, i + BATCH_SIZE).map(r => ({
          id:         String(r.id),
          content:    r.text || '',
          namespace:  r.namespace || 'default',
          importance: r.metadata?.importance || 0.6,
          tags:       Array.isArray(r.metadata?.tags)
                        ? r.metadata.tags.join(',')
                        : (r.metadata?.tags || ''),
          entities:   Array.isArray(r.metadata?.entities)
                        ? r.metadata.entities
                        : [],
          created_at: r.created_at || Math.floor(Date.now() / 1000),
          source:     r.source || 'vex',
          // Store vector as JSON string -- Neo4j doesn't have native float array yet
          vector:     r.vector ? JSON.stringify(r.vector) : null,
        }));

        // MERGE Memory nodes
        await session.run(`
          UNWIND $batch AS row
          MERGE (m:Memory {id: row.id})
          SET m.content    = row.content,
              m.namespace  = row.namespace,
              m.importance = row.importance,
              m.tags       = row.tags,
              m.created_at = row.created_at,
              m.source     = row.source,
              m.vector     = row.vector
        `, { batch });

        // MERGE Entity nodes + MENTIONS edges
        const withEntities = batch.filter(r => r.entities.length > 0);
        if (withEntities.length > 0) {
          await session.run(`
            UNWIND $batch AS row
            MATCH (m:Memory {id: row.id})
            UNWIND row.entities AS entityName
            MERGE (e:Entity {name: entityName})
            MERGE (m)-[:MENTIONS]->(e)
          `, { batch: withEntities });
        }

        upserted += batch.length;
        process.stdout.write(`\r[neo4j] ${Math.min(i + BATCH_SIZE, records.length)}/${records.length}`);
      }

      process.stdout.write('\n');

      // Build TEMPORAL_NEXT edges -- chain memories by created_at within namespace
      console.log('[neo4j] building temporal edges...');
      await session.run(`
        MATCH (m:Memory)
        WITH m ORDER BY m.namespace, m.created_at ASC
        WITH collect(m) AS memories
        UNWIND range(0, size(memories)-2) AS i
        WITH memories[i] AS a, memories[i+1] AS b
        WHERE a.namespace = b.namespace
          AND b.created_at - a.created_at < 3600
        MERGE (a)-[:TEMPORAL_NEXT]->(b)
      `);

      // Build RELATED_TO edges -- shared tags
      console.log('[neo4j] building tag-similarity edges...');
      await session.run(`
        MATCH (a:Memory), (b:Memory)
        WHERE a.id < b.id
          AND a.namespace = b.namespace
          AND any(tag IN split(a.tags, ',') WHERE tag IN split(b.tags, ','))
          AND tag <> ''
        MERGE (a)-[:RELATED_TO]->(b)
      `);

      console.log(`[neo4j] wrote ${upserted} Memory nodes (${skipped} failed)`);
      return { upserted, skipped };
    } catch (e) {
      console.error(`[neo4j] error: ${e.message}`);
      skipped = records.length - upserted;
      return { upserted, skipped };
    } finally {
      await session.close();
      await driver.close();
    }
  },
};
