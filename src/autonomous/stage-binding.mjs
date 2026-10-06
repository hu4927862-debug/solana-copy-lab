import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {AutonomousJournalRuntime} from './journal-runtime.ts';

const need=(ok,code)=>{if(!ok)throw Error(code)};

/** Read the stage's existing immutable Store binding; the sealed Store still
 * performs its own equality check when opened for writes. A concurrent change
 * therefore fails closed instead of silently rebinding the historic ledger. */
export function openHistoricallyBoundStage({directory,owners}){
 const file=path.join(directory,'collector.sqlite');
 need(fs.existsSync(file),'EXISTING_STAGE_REQUIRED');
 const stat=fs.lstatSync(file);
 need(stat.isFile()&&!stat.isSymbolicLink(),'EXISTING_STAGE_FILE_TYPE');
 const db=new Database(file,{readonly:true,fileMustExist:true});
 let config;
 try{
  db.pragma('query_only = ON');db.exec('BEGIN');
  const row=db.prepare("SELECT v FROM kv WHERE k='config'").get();
  try{config=JSON.parse(row?.v??'null')}catch{throw Error('STAGE_BOUND_CONFIG_INVALID')}
  need(config&&typeof config==='object'&&!Array.isArray(config)&&Object.keys(config).length>0,'STAGE_BOUND_CONFIG_INVALID');
  db.exec('ROLLBACK');
 }finally{db.close()}
 return new owners.Store(directory,config,owners.systemClock);
}

/** The local startup pair owns both handles. A runtime identity rejection must
 * not strand an open historical Store; an old empty runtime is never rebound. */
export function openLocalRuntimeBindings({stageDirectory,owners,stateDirectory,identity}){
 const stage=openHistoricallyBoundStage({directory:stageDirectory,owners});
 let runtime;
 try{runtime=new AutonomousJournalRuntime(stateDirectory,identity)}
 catch(error){stage.close();throw error}
 return{stage,runtime,close(){try{runtime.close()}finally{stage.close()}}};
}
