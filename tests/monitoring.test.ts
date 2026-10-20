import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, appendFile, rename, stat, readdir, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { createLogger, errorFingerprint, ErrorBuffer, JsonlDecoder, LogSchemaRegistry, LogTailer, MAX_LOG_LINE_BYTES, parseLogLine, type ErrorBatch, type StandardLogRecord } from '../src/monitoring/index.js';

const dir = () => mkdtemp(join(tmpdir(),'dsh-monitoring-'));
const record = (overrides: Partial<StandardLogRecord> = {}): StandardLogRecord => ({timestamp:'2026-10-20T18:00:00.000Z',level:'ERROR',log_type:'com.example.inventory.sync.v1',message:'Sync failed',...overrides});
const line = (r: StandardLogRecord) => JSON.stringify(r) + '\n';

test('standard parser allows unknown versioned namespaces and extensions but strictly validates known payloads', () => {
  assert.deepEqual(parseLogLine(line(record({data:{nested:[1,true,null]},extension:{safe:true}}))),record({data:{nested:[1,true,null]},extension:{safe:true}}));
  for (const bad of [record({level:'error' as never}),record({log_type:'oops'}),record({timestamp:'today'}),record({log_type:'dsh.http.request.v1',data:{method:'GET',path:'/',status:99}}),record({log_type:'dsh.http.request.v1'}),record({error:{name:'TypeError',message:'bad',code:null as never}})]) assert.equal(parseLogLine(JSON.stringify(bad)),undefined);
  assert.ok(parseLogLine(line(record({log_type:'dsh.http.request.v1',data:{method:'GET',path:'/',status:200,duration_ms:1}}))));
  assert.equal(parseLogLine('{"timestamp":"2026-10-20T18:00:00Z","level":"ERROR","log_type":"com.example.test.v1","message":"bad","data":1e999}'),undefined);
  assert.equal(parseLogLine(JSON.stringify(record({message:'x'.repeat(MAX_LOG_LINE_BYTES)}))),undefined);
  let nested: any = null; for (let i=0;i<34;i++) nested = {nested};
  assert.equal(parseLogLine(JSON.stringify(record({data:nested}))),undefined);
  assert.equal(parseLogLine('not JSON'),undefined);
});

test('payload registry is immutable and rejects unsupported schemas', () => {
  const registry = new LogSchemaRegistry().register('com.example.inventory.sync.v1',{type:'object',required:['count'],properties:{count:{type:'integer',minimum:0}},additionalProperties:false});
  assert.ok(parseLogLine(line(record({data:{count:1}})),registry));
  assert.equal(parseLogLine(line(record({data:{count:'bad'}})),registry),undefined);
  assert.equal(parseLogLine(line(record({data:{count:1,extra:true}})),registry),undefined);
  registry.register('com.example.inventory.sync.v1',{required:['count'],type:'object',additionalProperties:false,properties:{count:{minimum:0,type:'integer'}}});
  assert.throws(() => registry.register('com.example.inventory.sync.v1',{type:'array'}),/immutable/);
  assert.throws(() => registry.register('com.example.other.v1',{anyOf:[]} as never),/Unsupported/);
  const schema = registry.get('com.example.inventory.sync.v1')!; schema.type = 'string';
  assert.ok(registry.validate('com.example.inventory.sync.v1',{count:2}));
});

test('fingerprints ignore time/event/stack/data but retain type, error and code', () => {
  const a = record({error:{name:'Error',message:'No connection',code:'ECONNRESET',stack:'a'}});
  assert.equal(errorFingerprint(a),errorFingerprint({...a,timestamp:'2026-10-21T00:00:00Z',event_id:'another',data:{random:123},error:{...a.error!,stack:'b'}}));
  for (const changed of [{message:'different'},{log_type:'com.example.another.v1'},{error:{...a.error!,code:'EOTHER'}},{error:{...a.error!,name:'TypeError'}}]) assert.notEqual(errorFingerprint(a),errorFingerprint({...a,...changed}));
});

test('logger emits matching event IDs to stdout/file, recursively redacts credentials and flushes', async () => {
  const directory = await dir(); const output: string[] = [];
  const stdout = new Writable({write(chunk,_encoding,callback) { output.push(chunk.toString()); callback(); }});
  const logger = createLogger({logsPath:directory,stdout,private:true});
  const r = logger.error('failed',{password:'secret',nested:{authorization:'Bearer foo',api_key:'key',ok:'visible'},headers:{accept:'json'},list:[{access_token:'hidden'}]}, {log_type:'com.example.service.failed.v1',fatal:true,error:new Error('boom')});
  await logger.close();
  const disk = await readFile(join(directory,'app-log.jsonl'),'utf8');
  assert.equal(disk,output.join('')); assert.equal(parseLogLine(disk)?.event_id,r.event_id);
  assert.match(disk,/REDACTED/); assert.doesNotMatch(disk,/Bearer foo|"secret"|"hidden"|"key"/);
  assert.match(disk,/visible/); assert.equal((await stat(join(directory,'app-log.jsonl'))).mode & 0o777,0o600);
  assert.equal(r.error?.fingerprint,errorFingerprint(r)); assert.equal(r.fatal,true);
  assert.throws(() => logger.info('after close'),/closed/);
});

test('logger rejects lossy JSON, invalid registered payloads, excessive lines and bounded backpressure overflow', async () => {
  const logger = createLogger({stdout:false});
  assert.throws(() => logger.info('bad',{number:NaN}),/finite/);
  assert.throws(() => logger.info('bad',{missing:undefined} as never),/finite/);
  assert.throws(() => logger.info('bad',new Date() as never),/finite/);
  assert.throws(() => logger.info('bad',{method:'GET'},{log_type:'dsh.http.request.v1'}),/Invalid/);
  assert.throws(() => logger.info('x'.repeat(MAX_LOG_LINE_BYTES)),/64 KiB/);
  await logger.close();
  let callback: ((error?: Error | null) => void) | undefined;
  const slow = new Writable({write(_chunk,_encoding,cb) { callback = cb; }});
  const blocked = createLogger({stdout:slow,maxQueueBytes:700});
  blocked.info('x'.repeat(200));
  assert.throws(() => blocked.info('y'.repeat(400)),/queue capacity/);
  await Promise.resolve(); callback!(); await blocked.close();
  assert.equal(slow.listenerCount('error'),0);
});

test('logger rotates by max bytes and UTC day, with five total files by default', async () => {
  const directory = await dir(); let now = new Date('2026-10-20T23:59:00Z');
  const logger = createLogger({logsPath:directory,stdout:false,maxBytes:600,clock:()=>now});
  for (let i=0;i<9;i++) logger.info('x'.repeat(180)+i);
  await logger.flush();
  assert.equal((await readdir(directory)).length,5);
  now = new Date('2026-10-21T00:00:00Z'); logger.info('new day'); await logger.close();
  assert.match(await readFile(join(directory,'app-log.jsonl'),'utf8'),/new day/);
  assert.doesNotMatch(await readFile(join(directory,'app-log.jsonl'),'utf8'),/xxxxx/);
});

test('bounded JSONL decoder handles fragments, multibyte characters, malformed and oversize records', () => {
  const got: StandardLogRecord[] = [];
  const decoder = new JsonlDecoder(r => got.push(r));
  const data = Buffer.from(line(record({message:'héllo 🌎'})));
  const split = data.indexOf(Buffer.from('🌎'))+1;
  decoder.push(data.subarray(0,split)); decoder.push(data.subarray(split));
  decoder.push('bad\n'+'x'.repeat(MAX_LOG_LINE_BYTES+1)); assert.equal(decoder.pendingBytes,0);
  decoder.push('\n'+line(record({message:'after'})));
  assert.deepEqual(got.map(r => r.message),['héllo 🌎','after']);
});

test('ErrorBuffer is level-based, dedups stdout/file IDs, groups deterministically, respects cooldown and flushes stop errors', async () => {
  const directory = await dir(); let now = 1_792_516_800_000; const batches: ErrorBatch[] = [];
  const buffer = new ErrorBuffer({key:'owner:program',directory,deliver:b => { batches.push(b); },bufferMs:60_000,cooldownMs:30_000,clock:()=>now});
  await buffer.ready;
  assert.equal(buffer.add(record({level:'INFO'})),false);
  buffer.add(record({event_id:'same'}),{path:'/tmp/app-log.jsonl',offset:42,run:{id:'run',generation:1}});
  buffer.add(record({event_id:'same'}));
  buffer.add(record({event_id:'unique'}));
  await buffer.flush();
  assert.equal(batches.length,1); assert.equal(batches[0].data.count,2); assert.equal(batches[0].data.groups.length,1);
  assert.deepEqual(batches[0].data.groups[0].source?.run,{id:'run',generation:1});
  assert.ok(parseLogLine(JSON.stringify(batches[0])));
  buffer.add(record({event_id:'later'})); await buffer.flush(); assert.equal(batches.length,1);
  now += 30_001; await buffer.flush(); assert.equal(batches.length,2);
  buffer.add(record({message:'stop failure',log_type:'com.example.other.v1',event_id:'stop'}));
  await buffer.close(); assert.equal(batches.length,3); assert.equal(batches[2].data.groups[0].sample.message,'stop failure');
});

test('ErrorBuffer bounds batch groups and bytes, scopes state, and reports capacity losses', async () => {
  const directory = await dir(); const batches: ErrorBatch[] = [];
  const buffer = new ErrorBuffer({key:'owner:a',directory,deliver:b => { batches.push(b); },bufferMs:60_000,maxPendingGroups:25});
  for (let i=0;i<30;i++) buffer.add(record({message:'failure '+i,event_id:'event-'+i,data:{payload:'x'.repeat(6000)}}));
  await buffer.close();
  assert.equal(batches.length,2); assert.equal(batches.reduce((n,b)=>n+b.data.count,0),25);
  assert.equal(batches[0].data.dropped,5);
  assert.ok(batches.every(b => b.data.groups.length <=20 && Buffer.byteLength(JSON.stringify(b)) <= MAX_LOG_LINE_BYTES));
  const other = new ErrorBuffer({key:'owner:b',directory,deliver:()=>{}}); await other.ready;
  assert.notEqual(other.outboxPath,buffer.outboxPath); await other.close();
});

test('ErrorBuffer persists unavailable routing and pending state, replays receipt event IDs across restart', async () => {
  const directory = await dir(); const failed: ErrorBatch[] = [];
  const first = new ErrorBuffer({key:'owner:p',directory,bufferMs:60_000,retryMs:60_000,deliver:b => { failed.push(b); throw new Error('agent unavailable'); }});
  first.add(record({event_id:'persistent-event'})); await first.flush();
  const persisted = JSON.parse(await readFile(first.outboxPath,'utf8')); assert.equal(persisted.outbox.length,1);
  await first.close();
  const delivered: ErrorBatch[] = [];
  const second = new ErrorBuffer({key:'owner:p',directory,bufferMs:60_000,deliver:b => {delivered.push(b);}});
  await second.ready; await second.flush();
  assert.equal(delivered.length,1); assert.equal(delivered[0].event_id,failed[0].event_id);
  second.add(record({event_id:'persistent-event'})); await second.flush(); assert.equal(delivered.length,1);
  await second.close(); assert.equal(JSON.parse(await readFile(second.outboxPath,'utf8')).outbox.length,0);
});

test('ErrorBuffer reduces deeply nested valid samples so durable batches remain within depth bounds', async () => {
  const directory = await dir(); const batches: ErrorBatch[] = [];
  let data: any = 'leaf'; for (let i=0;i<29;i++) data = {nested:data};
  const original = record({data,event_id:'nested'}); assert.ok(parseLogLine(JSON.stringify(original)));
  const first = new ErrorBuffer({key:'owner:deep',directory,deliver:()=>{throw new Error('unavailable');}}); first.add(original); await first.flush(); await first.close();
  const second = new ErrorBuffer({key:'owner:deep',directory,deliver:b=>{batches.push(b);}}); await second.ready; await second.flush(); await second.close();
  assert.equal(batches.length,1); assert.ok(parseLogLine(JSON.stringify(batches[0])));
});

test('ErrorBuffer bounds noncooperative delivery shutdown and keeps durable outbox', async () => {
  const directory = await dir();
  let started!: () => void; const delivering = new Promise<void>(resolve => {started = resolve;});
  const buffer = new ErrorBuffer({key:'owner:hanging',directory,bufferMs:60_000,deliver:(_batch,signal) => { started(); assert.ok(signal); return new Promise(()=>{}); }});
  buffer.add(record({event_id:'hanging'})); const flushing = buffer.flush();
  await delivering;
  const before = Date.now(); await buffer.close(); await flushing;
  assert.ok(Date.now()-before < 1000);
  const state = JSON.parse(await readFile(buffer.outboxPath,'utf8')); assert.equal(state.outbox.length,1);
});

test('delivery deadline retains one real handler slot across repeated flushes and retries', async () => {
  const directory = await dir(); let calls = 0; let settle!: () => void;
  const handler = new Promise<void>(resolve => {settle = resolve;});
  const buffer = new ErrorBuffer({key:'owner:deadline-slot',directory,bufferMs:60_000,retryMs:60_000,deliveryTimeoutMs:5,deliver:()=>{calls++; return calls === 1 ? handler : undefined;}});
  buffer.add(record({event_id:'deadline'})); await buffer.flush(); assert.equal(calls,1);
  for (let i=0;i<8;i++) await buffer.flush(); assert.equal(calls,1);
  assert.equal(JSON.parse(await readFile(buffer.outboxPath,'utf8')).outbox.length,1);
  settle(); await Promise.resolve(); await buffer.flush(); assert.equal(calls,2);
  assert.equal(JSON.parse(await readFile(buffer.outboxPath,'utf8')).outbox.length,0); await buffer.close();
});

test('closing a timed-out noncooperative callback stays bounded without starting a replacement', async () => {
  const directory = await dir(); let calls = 0;
  const buffer = new ErrorBuffer({key:'owner:deadline-close',directory,deliveryTimeoutMs:5,retryMs:60_000,deliver:()=>{calls++;return new Promise(()=>{});}});
  buffer.add(record()); await buffer.flush(); for (let i=0;i<3;i++) await buffer.flush();
  const start = Date.now(); await buffer.close(); assert.ok(Date.now()-start < 1000); assert.equal(calls,1);
  assert.equal(JSON.parse(await readFile(buffer.outboxPath,'utf8')).outbox.length,1);
});

test('ErrorBuffer ingress is bounded and drops are reported rather than growing an async queue', async () => {
  const directory = await dir(); const batches: ErrorBatch[] = [];
  const buffer = new ErrorBuffer({key:'owner:flood',directory,maxPendingGroups:2,bufferMs:60_000,deliver:b=>{batches.push(b);}});
  let rejected = 0; for (let i=0;i<100;i++) if (!buffer.add(record({event_id:'flood-'+i}))) rejected++;
  assert.equal(rejected,96); await buffer.close(); assert.equal(batches[0].data.count,4); assert.equal(batches[0].data.dropped,96);
});

test('malformed durable state is reported without silently overwriting it', async () => {
  const directory = await dir(); const first = new ErrorBuffer({key:'owner:corrupt',directory,deliver:()=>{}}); await first.ready; await first.close();
  await writeFile(first.outboxPath,'bad JSON');
  const buffer = new ErrorBuffer({key:'owner:corrupt',directory,deliver:()=>{}});
  await assert.rejects(buffer.ready); buffer.add(record()); await assert.rejects(buffer.flush()); await assert.rejects(buffer.close());
  assert.equal(await readFile(first.outboxPath,'utf8'),'bad JSON');
});

test('tailer skips historical contents by default, handles partial lines, malformed lines, truncation and inode rotation', async () => {
  const directory = await dir(); const path = join(directory,'app-log.jsonl');
  await writeFile(path,line(record({message:'historical'})));
  const got: StandardLogRecord[] = [];
  const tail = new LogTailer({logsPath:directory,pollMs:60_000,onRecord:r => {got.push(r);}}); await tail.ready;
  assert.equal(got.length,0);
  const partial = line(record({message:'partial'})); await appendFile(path,'bad\n'+partial.slice(0,-2)); await tail.poll(); assert.equal(got.length,0);
  await appendFile(path,partial.slice(-2)); await tail.poll(); assert.equal(got[0].message,'partial');
  await appendFile(path,'x'.repeat(MAX_LOG_LINE_BYTES*2)+'\n'+line(record({message:'after oversized'}))); await tail.poll(); assert.equal(got[1].message,'after oversized');
  await rename(path,path+'.1'); await writeFile(path,line(record({message:'rotated'}))); await tail.poll(); assert.equal(got[2].message,'rotated');
  await truncate(path,0); await tail.poll(); await appendFile(path,line(record({message:'truncated'}))); await tail.poll(); assert.equal(got[3].message,'truncated');
  await tail.close();
});

test('tailer closes its handle/timer even when a record callback rejects during final capture', async () => {
  const directory = await dir(); const path = join(directory,'app-log.jsonl'); await writeFile(path,'');
  const tail = new LogTailer({logsPath:path,pollMs:60_000,onRecord:()=>{throw new Error('callback failed');}}); await tail.ready;
  await appendFile(path,line(record())); await assert.rejects(tail.close(),/callback failed/);
  assert.equal((tail as any).handle,undefined); assert.equal((tail as any).timer,undefined);
});

test('tailer readExisting and durable cursor resume only new complete records without reading full file', async () => {
  const directory = await dir(); const path = join(directory,'app-log.jsonl'); const cursorPath = join(directory,'cursor.json');
  await writeFile(path,line(record({message:'existing'})));
  const got: string[] = [];
  const first = new LogTailer({logsPath:path,cursorPath,readExisting:true,pollMs:60_000,onRecord:r => {got.push(r.message);}}); await first.ready; await first.close();
  await appendFile(path,line(record({message:'while stopped'})));
  const second = new LogTailer({logsPath:path,cursorPath,pollMs:60_000,onRecord:r => {got.push(r.message);}}); await second.ready; await second.close();
  assert.deepEqual(got,['existing','while stopped']);
  const huge = join(directory,'huge.jsonl'); await writeFile(huge,'x'.repeat(1024*1024));
  const newlyRead: string[] = [];
  const empty = new LogTailer({logsPath:huge,pollMs:60_000,onRecord:r=>{newlyRead.push(r.message);}}); await empty.ready;
  assert.deepEqual(newlyRead,[]);
  await appendFile(huge,'\n'+line(record({message:'new'}))); await empty.poll(); await empty.close();
  assert.deepEqual(newlyRead,['new']);
});
