// An NPC's text is not world state. Changes are staged against the exact selected
// response and may be committed only through a separate, validated decision.
import { createHash, randomUUID } from 'node:crypto';

export function sourceFingerprint(message) {
  const source={role:message.role,speakerId:message.speakerId,channelId:message.channelId || 'in_person',
    witnessIds:[...(message.witnessIds || [])].sort(),content:message.content};
  return createHash('sha256').update(JSON.stringify(source)).digest('hex');
}
const kinds = new Set(['observation', 'npc_move']);
const row = x => x && ({ id:x.id, timelineId:x.timeline_id, sceneId:x.scene_id,
  sourceMessageId:x.source_message_id, actorId:x.actor_id, kind:x.kind,
  description:x.description, locationId:x.location_id, status:x.status,
  createdAt:x.created_at, decidedAt:x.decided_at });

export function initializeEventLedger(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS event_proposals (
    id TEXT PRIMARY KEY,
    timeline_id TEXT NOT NULL REFERENCES timelines(id),
    scene_id TEXT NOT NULL,
    source_message_id TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('observation','npc_move')),
    description TEXT NOT NULL,
    location_id TEXT REFERENCES world_locations(id),
    status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected')),
    created_at INTEGER NOT NULL,
    decided_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS event_proposals_scene_idx ON event_proposals(scene_id,created_at);
  CREATE TABLE IF NOT EXISTS timeline_events (
    id TEXT PRIMARY KEY,
    timeline_id TEXT NOT NULL REFERENCES timelines(id),
    scene_id TEXT NOT NULL,
    proposal_id TEXT NOT NULL UNIQUE REFERENCES event_proposals(id),
    actor_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    description TEXT NOT NULL,
    location_id TEXT,
    game_time_ms INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS timeline_event_observers (
    event_id TEXT NOT NULL REFERENCES timeline_events(id),
    actor_id TEXT NOT NULL,
    PRIMARY KEY(event_id,actor_id)
  );
  CREATE INDEX IF NOT EXISTS timeline_observer_actor_idx ON timeline_event_observers(actor_id,event_id);`);
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (3,?)').run(Date.now());
}

function requireScene(store, sceneId, timelineId) {
  if (typeof sceneId !== 'string' || !sceneId || typeof timelineId !== 'string' || !timelineId) throw new Error('Scene and timeline are required');
  const scene = store.load().state?.sessions?.find(s => s.id === sceneId && !s.trashedAt);
  if (!scene || scene.timelineId !== timelineId) throw new Error('Scene is not in this timeline');
  return scene;
}

export class EventLedger {
  constructor(store) { this.store = store; this.db = store.db; }

  propose({sceneId, timelineId, sourceMessageId, kind = 'observation', description, locationId = null}) {
    const scene = requireScene(this.store,sceneId,timelineId);
    if (!kinds.has(kind)) throw new Error('Unsupported event kind');
    if (typeof description !== 'string' || !description.trim() || description.trim().length > 1000)
      throw new Error('Description must contain 1–1000 characters');
    if (typeof sourceMessageId !== 'string' || scene.messages.at(-1)?.id !== sourceMessageId)
      throw new Error('Event must reference the latest selected NPC reply');
    const source = scene.messages.at(-1);
    if (source.role !== 'assistant' || typeof source.speakerId !== 'string') throw new Error('Source must be an NPC reply');
    if (!this.store.load().state.characters.some(c=>c.id===source.speakerId && !c.trashedAt)) throw new Error('NPC is unavailable');
    this.store.worlds.authorize(timelineId,source.speakerId,'npc','npc-action-proposal');
    if (kind === 'npc_move') {
      const timeline = this.db.prepare('SELECT world_id AS worldId FROM timelines WHERE id=?').get(timelineId);
      const location = this.db.prepare('SELECT world_id AS worldId FROM world_locations WHERE id=?').get(locationId);
      if (!location || location.worldId !== timeline.worldId) throw new Error('Target location must belong to this world');
    } else if (locationId !== null) throw new Error('Only a movement proposal may specify a destination');
    const value={id:randomUUID(),timelineId,sceneId,sourceMessageId,actorId:source.speakerId,kind,
      description:description.trim(),locationId,sourceHash:sourceFingerprint(source),status:'pending',createdAt:Date.now()};
    this.db.prepare(`INSERT INTO event_proposals
      (id,timeline_id,scene_id,source_message_id,source_hash,actor_id,kind,description,location_id,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(value.id,timelineId,sceneId,sourceMessageId,value.sourceHash,value.actorId,kind,value.description,locationId,'pending',value.createdAt);
    const {sourceHash, ...publicValue}=value;
    return publicValue;
  }

  list(sceneId) {
    if (typeof sceneId !== 'string' || !sceneId || sceneId.length > 160) throw new Error('Valid scene ID required');
    return this.db.prepare('SELECT * FROM event_proposals WHERE scene_id=? ORDER BY created_at DESC,rowid DESC LIMIT 40').all(sceneId).map(row);
  }

  decide({proposalId,decision}) {
    if (typeof proposalId !== 'string' || !proposalId || !['accept','reject'].includes(decision)) throw new Error('Invalid proposal decision');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const p=this.db.prepare('SELECT * FROM event_proposals WHERE id=?').get(proposalId);
      if (!p || p.status !== 'pending') throw new Error('Proposal is not pending');
      const scene=requireScene(this.store,p.scene_id,p.timeline_id);
      if(decision==='accept') {
        const source=scene.messages.find(m=>m.id===p.source_message_id);
        if (!source || source.role!=='assistant' || source.speakerId!==p.actor_id || sourceFingerprint(source)!==p.source_hash || scene.messages.at(-1)?.id!==source.id)
          throw new Error('Source reply changed; reject this stale proposal and create a new one');
        this.store.worlds.authorize(p.timeline_id,p.actor_id,'npc','npc-action-proposal');
        const world=this.db.prepare('SELECT world_id AS worldId FROM timelines WHERE id=?').get(p.timeline_id);
        if(p.kind==='npc_move'){
          const loc=this.db.prepare('SELECT world_id AS worldId FROM world_locations WHERE id=?').get(p.location_id);
          if (!loc || loc.worldId!==world.worldId) throw new Error('Destination no longer belongs to this world');
        }
        const clock=this.db.prepare('SELECT instant_ms AS instantMs,is_explicit AS explicit FROM timeline_clocks WHERE timeline_id=?').get(p.timeline_id);
        const eventId=randomUUID();
        this.db.prepare(`INSERT INTO timeline_events
          (id,timeline_id,scene_id,proposal_id,actor_id,kind,description,location_id,game_time_ms,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(eventId,p.timeline_id,p.scene_id,p.id,p.actor_id,p.kind,p.description,p.location_id,clock?.explicit?clock.instantMs:null,Date.now());
        if (p.kind==='npc_move') {
          this.db.prepare(`INSERT INTO timeline_positions(timeline_id,actor_id,location_id,updated_at) VALUES (?,?,?,?)
            ON CONFLICT(timeline_id,actor_id) DO UPDATE SET location_id=excluded.location_id,updated_at=excluded.updated_at`)
            .run(p.timeline_id,p.actor_id,p.location_id,Date.now());
        }
        // NPC retains knowledge of their own action. Only the recipients of the
        // corresponding visible message inherit an observation of a spoken fact.
        const observerIds=p.kind==='observation' ? [...new Set([p.actor_id,...(source.witnessIds||[])])] : [p.actor_id];
        const insert=this.db.prepare('INSERT INTO timeline_event_observers(event_id,actor_id) VALUES (?,?)');
        for(const actorId of observerIds) {
          const known=this.db.prepare('SELECT 1 FROM timeline_actors WHERE timeline_id=? AND actor_id=?').get(p.timeline_id,actorId);
          if(known)insert.run(eventId,actorId);
        }
      }
      this.db.prepare('UPDATE event_proposals SET status=?,decided_at=? WHERE id=?').run(decision==='accept'?'accepted':'rejected',Date.now(),p.id);
      this.db.exec('COMMIT');
      return {...row({...p,status:decision==='accept'?'accepted':'rejected'}),status:decision==='accept'?'accepted':'rejected'};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }

  visible(timelineId,actorId,limit=12) {
    if(typeof timelineId!=='string'||!timelineId||typeof actorId!=='string'||!actorId)throw new Error('Timeline and actor required');
    if(!this.db.prepare('SELECT 1 FROM timeline_actors WHERE timeline_id=? AND actor_id=?').get(timelineId,actorId))throw new Error('Actor is not in this timeline');
    return this.db.prepare(`SELECT e.id,e.timeline_id AS timelineId,e.scene_id AS sceneId,
      e.actor_id AS actorId,e.kind,e.description,e.location_id AS locationId,e.game_time_ms AS gameTimeMs
      FROM timeline_events e JOIN timeline_event_observers o ON o.event_id=e.id
      WHERE e.timeline_id=? AND o.actor_id=? ORDER BY e.created_at DESC,e.rowid DESC LIMIT ?`)
      .all(timelineId,actorId,Math.min(30,Math.max(1,limit))).reverse();
  }
}
