import { createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import { mkdirSync, chmodSync, lstatSync, existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createConnection, createServer, type Server } from "node:net";
import Database from "better-sqlite3";
import bs58 from "bs58";
import { getTransactionEncoder } from "@solana/kit";
import { decodeWire, verifyExternalSignature } from "../live/transaction-review.js";
import { digest } from "../live/protocol.js";
import { SignerPolicySchema, privateRegularFile, validatePolicySigningRequest, assertSigningCriticalSection, type PolicySigningRequest, type SignerPolicy } from "./signer-policy.js";

const need = (ok: unknown, code: string): void => { if (!ok) throw Error(code); };
const publicAddress = (key:KeyObject) => bs58.encode(createPublicKey(key).export({format:"der",type:"spki"}).subarray(-32));
const safeError = (error:unknown) => error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "POLICY_SIGNER_REJECTED";

/** Append policy binding inside the existing archive transaction. Exported for
 * keyless exact-liability tests; no second signature store is introduced. */
export function bindSignerArchivePolicy(db:Database.Database,policy:SignerPolicy):void {
  const encoded=JSON.stringify(policy),old=db.prepare("SELECT v FROM signer_meta WHERE k='policy'").get() as {v:string}|undefined;
  const linked=policy.linkedExitAuthority;
  if(linked){
    need(linked.approval==="FUNDS_AUTHORIZED","FUNDS_NOT_AUTHORIZED");
    const {linkedExitAuthority:_linked,...parentPolicy}=policy;
    need(old&&old.v===JSON.stringify(parentPolicy),"SIGNER_LINKED_PARENT_POLICY_CHANGED");
    const rows=db.prepare("SELECT attempt,signature FROM signed_requests WHERE protocol=?").all(linked.parentProtocolDigest) as {attempt:string;signature:string}[];
    need(rows.length===1&&rows[0]!.attempt==="BUY"&&rows[0]!.signature===linked.buySignature,"SIGNER_ARCHIVE_SELL_OR_BUY_IDENTITY");
    const k="exit-policy:"+digest(JSON.stringify(linked)),bound=db.prepare("SELECT v FROM signer_meta WHERE k=?").get(k) as {v:string}|undefined;
    need(!bound||bound.v===encoded,"SIGNER_STATE_POLICY_CHANGED");
    db.prepare("INSERT OR IGNORE INTO signer_meta VALUES (?,?)").run(k,encoded);
  }else{
    need(!old||old.v===encoded,"SIGNER_STATE_POLICY_CHANGED");
    db.prepare("INSERT OR IGNORE INTO signer_meta VALUES ('policy',?)").run(encoded);
  }
}

/** Separate signer process: no Provider, quote, send, or private-key export API.
 * Its private directory stores signatures as responsibility evidence, never logs
 * them. OS isolation and operator-provisioned credentials remain deployment work.
 */
export class PolicySigner {
  private readonly db: Database.Database;
  readonly policy: SignerPolicy;
  constructor(policy:unknown, private readonly key:KeyObject, directory:string, private readonly now:()=>number=Date.now) {
    this.policy=SignerPolicySchema.parse(policy);
    need(key.asymmetricKeyType === "ed25519" && publicAddress(key)===this.policy.wallet,"SIGNER_KEY_WALLET_MISMATCH");
    mkdirSync(directory,{recursive:true,mode:0o700});
    const dir=resolve(directory),info=lstatSync(dir);
    need(info.isDirectory()&&!info.isSymbolicLink()&&realpathSync(dir)===dir&&(info.mode&0o077)===0,"SIGNER_STATE_DIRECTORY_PERMISSIONS");
    this.db=new Database(resolve(dir,"signer.sqlite"));
    chmodSync(resolve(dir,"signer.sqlite"),0o600);
    this.db.pragma("journal_mode = WAL"); this.db.pragma("synchronous = FULL");
    this.db.exec("CREATE TABLE IF NOT EXISTS signer_meta(k TEXT PRIMARY KEY,v TEXT NOT NULL); CREATE TABLE IF NOT EXISTS signed_requests(id TEXT PRIMARY KEY,protocol TEXT NOT NULL,attempt TEXT NOT NULL,message TEXT NOT NULL,bytes TEXT NOT NULL,signature TEXT NOT NULL,at_ms INTEGER NOT NULL,UNIQUE(protocol,attempt));");
    this.db.transaction(()=>bindSignerArchivePolicy(this.db,this.policy)).immediate();
  }
  /** Recovery is retrieval of the already persisted artifact, not re-signing.
   * It remains available after expiry so a client crash cannot hide a signature. */
  recover(protocolDigest:string,attemptId:string) {
    need(/^[a-f0-9]{64}$/.test(protocolDigest)&&/^[A-Z0-9-]{1,32}$/.test(attemptId),"SIGNER_RECOVERY_IDENTITY");
    const row=this.db.prepare("SELECT bytes,signature,message,at_ms FROM signed_requests WHERE protocol=? AND attempt=?").get(protocolDigest,attemptId) as {bytes:string;signature:string;message:string;at_ms:number}|undefined;
    return row?{signedTransaction:row.bytes,signature:row.signature,messageDigest:row.message,signedAtMs:row.at_ms}:null;
  }
  async sign(request:PolicySigningRequest) {
    const verified=await validatePolicySigningRequest(this.policy,request,this.now());
    // The async independent review precedes a synchronous transaction. Race on
    // duplicate requests cannot sign an alternative message for the same attempt.
    return this.db.transaction(()=>{
      assertSigningCriticalSection(this.policy,request,this.now(),verified.stateFingerprint);
      const protocol=String(request.request.protocolDigest), attempt=String(request.request.attemptId);
      need(!this.recover(protocol,attempt),"SIGNER_ALREADY_SIGNED_USE_RECOVERY");
      const wire=decodeWire(verified.unsignedTransaction);
      const signature=sign(null,Buffer.from(wire.transaction.messageBytes),this.key);
      const transaction={...wire.transaction,signatures:{...wire.transaction.signatures,[this.policy.wallet]:signature}};
      const bytes=Buffer.from(getTransactionEncoder().encode(transaction as Parameters<ReturnType<typeof getTransactionEncoder>["encode"]>[0])).toString("base64");
      const checked=verifyExternalSignature(verified.unsignedTransaction,bytes,this.policy.wallet);
      const at=this.now();
      this.db.prepare("INSERT INTO signed_requests VALUES (?,?,?,?,?,?,?)").run(verified.id,protocol,attempt,checked.messageDigest,bytes,checked.signature,at);
      return {signedTransaction:bytes,signature:checked.signature,messageDigest:checked.messageDigest,signedAtMs:at};
    }).immediate();
  }
  close(){this.db.close();}
}

export function loadProvisionedSignerKey({encryptedKeyPath,passphrasePath,repositoryRoot}:{encryptedKeyPath:string;passphrasePath:string;repositoryRoot:string}):KeyObject {
  const encrypted=privateRegularFile(encryptedKeyPath,repositoryRoot),passphrase=privateRegularFile(passphrasePath,repositoryRoot);
  try {
    need(encrypted.toString("ascii").startsWith("-----BEGIN ENCRYPTED PRIVATE KEY-----"),"SIGNER_ENCRYPTED_PKCS8_REQUIRED");
    return createPrivateKey({key:encrypted,format:"pem",passphrase});
  } catch(error) { throw Error(safeError(error)); }
  finally { encrypted.fill(0); passphrase.fill(0); }
}

/** Read-only recovery service: no private key is loaded and expiry does not hide
 * already signed evidence. A missing/unreadable archive is never "not signed". */
export class PolicySignatureArchive {
  private readonly db:Database.Database;
  constructor(policy:unknown,directory:string){
    const p=SignerPolicySchema.parse(policy),dir=resolve(directory),info=lstatSync(dir);
    need(info.isDirectory()&&!info.isSymbolicLink()&&realpathSync(dir)===dir&&(info.mode&0o077)===0,"SIGNER_STATE_DIRECTORY_PERMISSIONS");
    this.db=new Database(resolve(dir,"signer.sqlite"),{readonly:true,fileMustExist:true});this.db.pragma("query_only=ON");
    try{const k=p.linkedExitAuthority?"exit-policy:"+digest(JSON.stringify(p.linkedExitAuthority)):"policy";
      const row=this.db.prepare("SELECT v FROM signer_meta WHERE k=?").get(k) as {v:string}|undefined;need(row?.v===JSON.stringify(p),"SIGNER_STATE_POLICY_CHANGED");}catch(error){this.db.close();throw error;}
  }
  /** Identity-only proof for a linked exit. Never expose signed bytes in logs. */
  assertNoSellSignature(protocolDigest:string,buySignature:string):void {
    const rows=this.db.prepare("SELECT attempt,signature FROM signed_requests WHERE protocol=?").all(protocolDigest) as {attempt:string;signature:string}[];
    need(rows.length===1&&rows[0]!.attempt==="BUY"&&rows[0]!.signature===buySignature,"SIGNER_ARCHIVE_SELL_OR_BUY_IDENTITY");
  }
  recover(protocolDigest:string,attemptId:string){
    need(/^[a-f0-9]{64}$/.test(protocolDigest)&&/^[A-Z0-9-]{1,32}$/.test(attemptId),"SIGNER_RECOVERY_IDENTITY");
    const row=this.db.prepare("SELECT bytes,signature,message,at_ms FROM signed_requests WHERE protocol=? AND attempt=?").get(protocolDigest,attemptId) as {bytes:string;signature:string;message:string;at_ms:number}|undefined;
    return row?{signedTransaction:row.bytes,signature:row.signature,messageDigest:row.message,signedAtMs:row.at_ms}:null;
  }
  async sign(_request:PolicySigningRequest):Promise<never>{throw Error("SIGNATURE_ARCHIVE_READ_ONLY");}
  close(){this.db.close();}
}

export async function servePolicySigner(signer:Pick<PolicySigner,"sign"|"recover">,socketPath:string,sharedGroup?:number):Promise<Server> {
  const absolute=resolve(socketPath),dir=dirname(absolute),info=lstatSync(dir);
  need(info.isDirectory()&&!info.isSymbolicLink()&&realpathSync(dir)===dir&&
    (sharedGroup===undefined?(info.mode&0o077)===0:(info.mode&0o027)===0&&info.gid===sharedGroup&&process.getgid?.()===sharedGroup),"SIGNER_SOCKET_DIRECTORY_PERMISSIONS");
  need(!existsSync(absolute),"SIGNER_SOCKET_ALREADY_EXISTS");
  const server=createServer(socket=>{
    let bytes=0,buf="",finished=false;
    socket.setTimeout(5000,()=>socket.destroy());
    socket.on("error",()=>{});
    socket.on("data",chunk=>{
      if(finished)return;
      bytes+=chunk.length;
      if(bytes>2*1024*1024){finished=true;socket.end(JSON.stringify({error:"SIGNER_REQUEST_SIZE"})+"\n");return;}
      buf+=chunk.toString("utf8");
      if(!buf.includes("\n"))return;
      finished=true;
      void (async()=>{
        try {
          need(buf.indexOf("\n")===buf.length-1,"SIGNER_ONE_REQUEST_ONLY");
          const message=JSON.parse(buf);
          const result=message.kind==="RECOVER"?signer.recover(message.protocolDigest,message.attemptId):
            message.kind==="SIGN"?await signer.sign(message.request):(()=>{throw Error("SIGNER_OPERATION_INVALID");})();
          socket.end(JSON.stringify({result})+"\n");
        } catch(error){socket.end(JSON.stringify({error:safeError(error)})+"\n");}
      })();
    });
  });
  await new Promise<void>((resolvePromise,reject)=>{server.once("error",reject);server.listen(absolute,()=>{chmodSync(absolute,sharedGroup===undefined?0o600:0o660);resolvePromise();});});
  return server;
}

/** One bounded IPC attempt, no retry and no logging of request/signed bytes. */
export class UnixPolicySignerClient {
  constructor(readonly socketPath:string,private readonly peer?:{uid:number;gid:number}){}
  private async request(message:unknown) {
    const file=resolve(this.socketPath),info=lstatSync(file),dir=lstatSync(dirname(file));
    need(info.isSocket()&&!info.isSymbolicLink()&&
      (this.peer?info.uid===this.peer.uid&&info.gid===this.peer.gid&&dir.uid===this.peer.uid&&dir.gid===this.peer.gid&&
        (info.mode&0o007)===0&&(dir.mode&0o027)===0&&process.getgroups?.().includes(this.peer.gid):
        (info.mode&0o077)===0&&(dir.mode&0o077)===0&&info.uid===process.getuid?.()),"SIGNER_SOCKET_PERMISSIONS");
    return new Promise<any>((resolvePromise,reject)=>{
      const socket=createConnection(file); let buf="",bytes=0;
      socket.setTimeout(5000,()=>socket.destroy(Error("SIGNER_IPC_TIMEOUT_RESPONSIBILITY_UNKNOWN")));
      socket.on("connect",()=>socket.write(JSON.stringify(message)+"\n"));
      socket.on("error",()=>reject(Error("SIGNER_IPC_FAILURE_RESPONSIBILITY_UNKNOWN")));
      socket.on("data",chunk=>{bytes+=chunk.length;if(bytes>16384){socket.destroy();reject(Error("SIGNER_RESPONSE_SIZE"));return;}buf+=chunk.toString("utf8");});
      socket.on("end",()=>{try {const data=JSON.parse(buf);if(data.error)throw Error(/^[A-Z0-9_]+$/.test(data.error)?data.error:"SIGNER_REJECTED");resolvePromise(data.result);}catch(error){reject(error);}});
    });
  }
  sign(request:PolicySigningRequest){return this.request({kind:"SIGN",request});}
  recover(protocolDigest:string,attemptId:string){return this.request({kind:"RECOVER",protocolDigest,attemptId});}
}
