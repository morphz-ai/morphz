import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildSync } from "esbuild";
import {
  cognitiveDocumentBootstrapProtocol,
  createCognitiveDocumentBootstrap,
} from "../../packages/application/src/cognitive-document-bootstrap.js";

// Compile the actual private Host endpoint. It is not shipped in the SDK or
// exposed to the opaque author. Business replies below remain controlled DTOs.
const hostPortCode = buildSync({
  stdin: {
    contents:
      'export { createCognitiveDocumentPort } from "./apps/web/src/host/cognitive-document-port.ts";',
    resolveDir: new URL("../../", import.meta.url).pathname,
    loader: "ts",
  },
  bundle: true,
  platform: "browser",
  format: "iife",
  globalName: "sdkDocumentProductionHost",
  target: "es2023",
  write: false,
}).outputFiles[0]!.text;

/** Actual fixed prefix, facade and MessageChannel; controlled Host business
 * DTOs only. No fake facade, Window transport fallback, or SQL authorization. */
export async function createSdkDocumentBrowserFixture(
  authorHtml: string,
  initialContext: unknown,
  commandFacts: unknown,
) {
  const proof = randomUUID();
  const document = await createCognitiveDocumentBootstrap(authorHtml, proof);
  assert.deepEqual(document.authorBytes, new TextEncoder().encode(authorHtml));
  const literal = (value: unknown) =>
    JSON.stringify(value).replaceAll("<", "\\u003c");
  const parentScript =
    hostPortCode +
    String.raw`
const frame=document.getElementById('guest');
const protocol=${literal(cognitiveDocumentBootstrapProtocol)},proof=${literal(proof)};
let channel=crypto.randomUUID(),context=${literal(initialContext)};
let bridge=null,ready=false,connected=false,acceptingPeer=true,generation=0;
const records=[],accepted=[],rejected=[],retirements=[];
const reverseKeys=value=>Array.isArray(value)?value.map(reverseKeys):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).reverse().map(key=>[key,reverseKeys(value[key])])):value;
const send=data=>bridge?.send(JSON.stringify(data));
const respond=(request,result)=>send({type:'morphz-cognitive-ui/v1:response',channel,requestId:request.requestId,ok:true,result});
const init=()=>{if(ready)send({type:'morphz-cognitive-ui/v1:init',channel,context});};
window.hostFixture={records,accepted,rejected,retirements,hold:false,connects:0,init,channel:()=>channel,
 context:()=>context,
 reviseSilent(){context={...context,view:{...context.view,revision:context.view.revision+1}};},
 reorderInit(){context=reverseKeys(context);init();},
 reorderReady(){context=reverseKeys(context);respond(records.at(-1),context);},
 changeSchema(){context={...context,definition:{...context.definition,operations:context.definition.operations.map(operation=>operation.id==='notes.create'?{...operation,inputSchema:{...operation.inputSchema,maxLength:31}}:operation)}};init();},
 reset(){channel=crypto.randomUUID();context=${literal(initialContext)};window.hostFixture.hold=false;},
 newDocument(){bridge?.dispose();bridge=null;ready=false;connected=false;acceptingPeer=true;window.hostFixture.hold=false;frame.src='/guest?documentGeneration='+ ++generation;return generation;},
 send,respond,
 rotate(){channel=crypto.randomUUID();context={...context,view:{...context.view,bindingRevision:context.view.bindingRevision+1}};init();},
 update(){context={...context,theme:{appearance:'light',accent:'coral'},view:{...context.view,revision:context.view.revision+1,active:false,state:{object:{objectId:'原件/ 😀\n',versionRef:'opaque:next'},view:'reader'}}};init();},
 invalidInit(){send({type:'morphz-cognitive-ui/v1:init',channel,context:{...context,actor:'not accepted'}});},
 sibling(data){const sibling=document.createElement('iframe');sibling.sandbox='allow-scripts';sibling.srcdoc='<script>parent.frames[0].frames[0].postMessage('+JSON.stringify(data)+',"*")<'+'/script>';document.body.append(sibling);},
};
addEventListener('message',event=>{
 const packet=event.data;
 if(packet?.protocol!==protocol)return;
 const observation={origin:event.origin,actualCarrierSource:event.source===frame.contentWindow,proof:packet.proof,ports:event.ports.length};
 if(event.source!==frame.contentWindow||event.origin!==location.origin||packet.proof!==proof||event.ports.length!==1||!acceptingPeer){rejected.push(observation);for(const port of event.ports)port.close();return;}
 acceptingPeer=false;accepted.push(observation);
 bridge=sdkDocumentProductionHost.createCognitiveDocumentPort(event.ports[0],{
  onReady(){ready=true;init();},
  onRetire(){retirements.push({generation});},
  onWire(text){
   const data=JSON.parse(text);
   if(data.type==='morphz-cognitive-ui/v1:connect'){window.hostFixture.connects++;connected=true;if(ready)init();return;}
   if(!connected||data.type!=='morphz-cognitive-ui/v1:request'||data.channel!==channel)return;
   records.push(data);if(window.hostFixture.hold)return;
   const request=data.request;
   if(request.method==='ready')respond(data,context);
   else if(request.method==='readObject')respond(data,{protocol:'morphz-domain/v1',authority:context.authority,object:request.object,kind:'document',title:'Original',content:{format:'text',text:'Body'}});
   else if(request.method==='openObject')respond(data,{opened:true,object:request.object});
   else if(request.method==='compose')respond(data,{prepared:true});
   else if(request.method==='saveState'){context={...context,view:{...context.view,revision:request.expectedRevision+1,state:request.state}};respond(data,{revision:context.view.revision,state:request.state});}
   else if(request.method==='invoke'&&request.commandId===null)respond(data,{protocol:'morphz-domain/v1',authority:context.authority,operationId:request.operationId,result:'Read original'});
   else{
    const command={...${literal(commandFacts)},commandId:request.commandId,state:'committed',projectionState:'pending',receiptRef:'author/receipt',receiptHash:'${"c".repeat(64)}',committedAt:'2026-10-05T10:00:01Z',objects:[]};
    respond(data,request.method==='commandStatus'?command:{kind:'command',commandId:request.commandId,command,hostIssue:'projection-pending'});
   }
  },
 });
});`;
  return {
    parentHtml:
      '<!doctype html><iframe id="guest" src="/guest"></iframe><script>' +
      parentScript +
      "</script>",
    document,
    proof,
  };
}
