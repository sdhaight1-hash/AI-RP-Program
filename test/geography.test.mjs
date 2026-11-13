import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioStore } from '../storage.mjs';
import { makeInitialState } from '../engine.mjs';
import { playerActorId } from '../world/canon.mjs';

function setup(t){const store=new StudioStore(':memory:');t.after(()=>store.close());return store;}

test('atlas locations nest within a world and travel links stay world-scoped',t=>{
  const store=setup(t);
  const world=store.worlds.createWorld({name:'Seabrook'});
  const other=store.worlds.createWorld({name:'Separate Reality'});
  const town=store.worlds.createLocation({worldId:world.id,name:'Seabrook',kind:'town'});
  const street=store.worlds.createLocation({worldId:world.id,name:'Harbor District',kind:'neighborhood',parentId:town.id});
  const house=store.worlds.createLocation({worldId:world.id,name:'Mara’s Apartment',kind:'building',parentId:street.id,description:'Second floor'});
  const foreign=store.worlds.createLocation({worldId:other.id,name:'Tower',kind:'building'});
  assert.equal(store.worlds.list().locations.find(x=>x.id===house.id).parentId,street.id);
  assert.throws(()=>store.worlds.createLocation({worldId:world.id,name:'Impossible',parentId:foreign.id}),/another world/);
  const walk=store.worlds.connectLocations({worldId:world.id,fromId:house.id,toId:street.id,kind:'walk',travelMinutes:3});
  assert.equal(store.worlds.list().connections.find(x=>x.id===walk.id).travelMinutes,3);
  assert.throws(()=>store.worlds.connectLocations({worldId:world.id,fromId:house.id,toId:foreign.id}),/same world/);
  assert.throws(()=>store.worlds.connectLocations({worldId:world.id,fromId:house.id,toId:house.id}),/itself/);
  assert.throws(()=>store.worlds.createLocation({worldId:world.id,name:'Bad',kind:'nonexistent'}),/kind/);
});

test('directional relationships connect only entities belonging to one canon world',t=>{
  const store=setup(t);
  const world=store.worlds.createWorld({name:'Everyday coast'});
  const other=store.worlds.createWorld({name:'Other'});
  const a=store.worlds.createEntity({worldId:world.id,name:'Mara',kind:'character'});
  const b=store.worlds.createEntity({worldId:world.id,name:'Elise',kind:'character'});
  const outside=store.worlds.createEntity({worldId:other.id,name:'Outsider',kind:'character'});
  const rel=store.worlds.createRelationship({worldId:world.id,fromId:a.id,toId:b.id,kind:'sister',notes:'Older sister is not mutual respect'});
  assert.equal(store.worlds.list().relationships.find(x=>x.id===rel.id).fromId,a.id);
  assert.equal(store.worlds.list().relationships.find(x=>x.id===rel.id).toId,b.id);
  assert.throws(()=>store.worlds.createRelationship({worldId:world.id,fromId:a.id,toId:outside.id}),/same world/);
  assert.throws(()=>store.worlds.createRelationship({worldId:world.id,fromId:a.id,toId:a.id}),/itself/);
});

test('world clock stores an absolute instant independently for each timeline with IANA display zone',t=>{
  const store=setup(t);const world=store.worlds.createWorld({name:'New Portland'});
  const a=store.worlds.createTimeline({worldId:world.id,name:'Timeline A'});
  const b=store.worlds.createTimeline({worldId:world.id,name:'Timeline B'});
  const clock=store.worlds.setClock({timelineId:a.id,instant:'2002-06-01T21:00:00-07:00',timeZone:'America/Los_Angeles'});
  assert.equal(new Date(clock.instantMs).toISOString(),'2002-06-02T04:00:00.000Z');
  assert.equal(clock.timeZone,'America/Los_Angeles');
  assert.notEqual(store.worlds.list().clocks.find(x=>x.timelineId===b.id).instantMs,clock.instantMs);
  assert.throws(()=>store.worlds.setClock({timelineId:a.id,instant:'June 2002'}),/ISO 8601/);
  assert.throws(()=>store.worlds.setClock({timelineId:a.id,instant:'2002-06-01T21:00:00Z',timeZone:'Mars/Olympus'}),/time zone/);
});

test('actor positions are per timeline and cannot cross worlds',t=>{
  const store=setup(t);
  const w=store.worlds.createWorld({name:'Coast'});const other=store.worlds.createWorld({name:'Different'});
  const home=store.worlds.createLocation({worldId:w.id,name:'Home'});
  const cafe=store.worlds.createLocation({worldId:w.id,name:'Café'});
  const far=store.worlds.createLocation({worldId:other.id,name:'Other world'});
  const t1=store.worlds.createTimeline({worldId:w.id,name:'A'});
  const t2=store.worlds.createTimeline({worldId:w.id,name:'B'});
  const playerA=playerActorId(t1.id);
  store.worlds.setActorLocation({timelineId:t1.id,actorId:playerA,locationId:home.id});
  store.worlds.setActorLocation({timelineId:t2.id,actorId:playerActorId(t2.id),locationId:cafe.id});
  assert.equal(store.worlds.actorLocations(t1.id)[0].locationId,home.id);
  assert.equal(store.worlds.actorLocations(t2.id)[0].locationId,cafe.id);
  assert.throws(()=>store.worlds.setActorLocation({timelineId:t1.id,actorId:playerActorId(t2.id),locationId:home.id}),/Actor is not/);
  assert.throws(()=>store.worlds.setActorLocation({timelineId:t1.id,actorId:playerA,locationId:far.id}),/different world/);
});
