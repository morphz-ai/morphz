// Actual complete production declarations, not rewritten dialog replicas.
// Private functions receive only the appended export recorded by the loader.
export const dialogFramePrivateExports = {
  "BrowserBookmarks.tsx": "BookmarkDialog",
  "Notifications.tsx": "ScopedNotifications",
  "AttachmentPreview.tsx": "Preview",
  "Reader.tsx": "NoteDialog",
  "ApplicationHost.tsx": "InstallApplication",
} as const;

export const dialogFrameConsumers = [
  "project-create",
  "execution",
  "bookmarks",
  "speech-consent",
  "speech-voice",
  "connection",
  "notifications",
  "settings",
  "attachment",
  "project-action",
  "content-metadata",
  "script",
  "reader-note",
  "install",
  "search",
  "capture",
] as const;

// __SOURCE__ is replaced with the current source root by the isolated Vite loader.
// All Client methods are bounded controlled ports; forbidden writes throw.
export const dialogFrameBrowserFixture = String.raw`
import React, {useState, useRef, useLayoutEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {CreateDialog} from '__SOURCE__/features/creation/CreateDialog.tsx';
import {ExecutionDialog} from '__SOURCE__/ExecutionDialog.tsx';
import {__dialogFrame_BookmarkDialog as BookmarkDialog} from '__SOURCE__/BrowserBookmarks.tsx';
import {SpeechDialog} from '__SOURCE__/SpeechDialog.tsx';
import {ConnectionDetails} from '__SOURCE__/ConnectionDetails.tsx';
import {__dialogFrame_ScopedNotifications as Notifications} from '__SOURCE__/Notifications.tsx';
import {SettingsDialog} from '__SOURCE__/SettingsDialog.tsx';
import {__dialogFrame_Preview as Preview} from '__SOURCE__/AttachmentPreview.tsx';
import {ProjectActionDialog} from '__SOURCE__/ProjectManagement.tsx';
import {ContentMetadata} from '__SOURCE__/ContentMetadata.tsx';
import {StudioDialog} from '__SOURCE__/ScriptStudio.tsx';
import {__dialogFrame_NoteDialog as NoteDialog} from '__SOURCE__/Reader.tsx';
import {__dialogFrame_InstallApplication as InstallApplication} from '__SOURCE__/ApplicationHost.tsx';
import {SearchDocuments} from '__SOURCE__/LibraryDialogs.tsx';
import {CaptureDialog} from '__SOURCE__/CaptureDialog.tsx';
import {useModal} from '__SOURCE__/useModal.ts';
import {storageScope} from '__SOURCE__/local-preferences.ts';
import {interfacePreferences} from '__SOURCE__/interface-preferences.ts';
import {initialWorkspace} from '__CORE__/model.ts';
const h=React.createElement, events=[], requests=[];
const stamp='2026-10-04T12:00:00.000Z';
const state=initialWorkspace(stamp);
const project=state.projects[0];
const note=(name,value)=>events.push([name,value??null]);
const forbid=name=>(...args)=>{note('forbidden',name);throw Error('Unrequested business operation '+name);};
const read=(name,value)=>(...args)=>{requests.push(name);return Promise.resolve(structuredClone(value));};
const client={
  online:true,workspaceChangeRevision:1,contentCatalogVersion:1,contentCatalog:[],taskCounts:[],contentCounts:[],
  boot:{centerId:'isolated-center',principalId:'isolated-human',csrfToken:'isolated-csrf',workspace:state,
    runtime:{connected:true,configured:true},capabilities:{modelSettings:false,teamAuthentication:false}},
  execute:async()=>{note('execute');throw Error('受控保存失败：'+ '保留原草稿与权限。'.repeat(8));},
  refresh:read('refresh',undefined),checkConnection:read('connection',{state:'not-configured',modelState:'unknown',
    model:'',message:'受控连接信息',checkedAt:null,configurable:true,version:'1',endpoint:''}),
  notifications:read('notifications',{mode:'all',revision:1,unread:0,items:[]}),
  bookmarkList:read('bookmarks',[]),bookmarkCommand:forbid('bookmarkCommand'),
  listContentPage:read('content-page',{items:[],total:0,offset:0,limit:6}),search:read('search',{hits:[],total:0}),
  executionSnapshot:read('execution',{jobs:[],approvals:[],limit:100}),
  executionResult:forbid('executionResult'),controlExecution:forbid('controlExecution'),
  speechStatus:read('speech-status',{configured:true,provider:'controlled-provider',providerLabel:'受控语音',streaming:true}),
  transcribe:forbid('transcribe'),createSpeechStream:forbid('createSpeechStream'),
  upload:forbid('upload'),uploadAttachment:forbid('uploadAttachment'),configureConnection:forbid('configureConnection'),
};
storageScope('isolated-center','isolated-human');
const entry={kind:'artifact',value:{id:'isolated-content',title:'原内容名称',projectId:project.id,catalogRevision:1,
  content:{kind:'document',markdown:'原正文'},revision:1,createdAt:stamp,updatedAt:stamp}};
const app={format:'morphz.application.v1',id:'isolated.application',title:'原安装确认',version:'1.0.0',
  description:'明确的受控安装说明。'.repeat(6),icon:'document',permissions:['artifacts.read','input.compose'],
  harness:null,ui:{type:'sandbox',html:'<p>Not executed</p>'}};
const image='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="320"><rect width="640" height="320" fill="gray"/></svg>');
const scope={projectId:project.id,conversationId:project.id,artifactId:null};
const initial={accent:'cyan',appearance:'light',zoom:1,left:160,right:24,top:60,bottom:48,busy:false,compact:false};
let updateFacts,updateActive,currentFacts=initial;
function RoleProbe(){
  const dialog=useRef(null);useModal(dialog);
  return h('dialog',{ref:dialog,className:'create-dialog library-dialog', 'aria-label':'补充公共role probe'},
    h('header',null,h('h2',null,'Library footer contract'),h('button',{onClick:close,'aria-label':'关闭role probe'},'×')),
    h('footer',null,h('button',{onClick:()=>note('role-cancel')},'取消'),h('button',{onClick:()=>note('role-confirm')},'确认')));
}
function Fields(){
  const excluded=['checkbox','radio','range','file','color','hidden','button','submit','reset','image'];
  return h('form',{onSubmit:e=>e.preventDefault()},
    h('label',{className:'field'},'真实角色组合槽',h('input',{'aria-label':'普通单行',defaultValue:'原稿'})),
    ...['search','email','password','url','number','tel','date','time'].map(type=>h('input',{key:type,type,'aria-label':type,defaultValue:type==='number'?'1':undefined})),
    h('select',{'aria-label':'单选'},h('option',null,'原选项')),
    h('select',{multiple:true,'aria-label':'多选'},h('option',null,'多选一'),h('option',null,'多选二')),
    h('select',{size:3,'aria-label':'列表选择'},h('option',null,'列表一'),h('option',null,'列表二')),
    h('textarea',{'aria-label':'多行正文',rows:4,defaultValue:'多行原稿'}),
    ...excluded.map(type=>h('input',{key:type,type,'aria-label':'排除-'+type,...(type==='image'?{src:image}:{}),...(type==='radio'?{name:'radio-group'}:{})})),
    h('div',{className:'dialog-actions'},h('button',{className:'model-service-button',type:'button'},'复合账号行'),
      h('button',{className:'icon-button',type:'button','aria-label':'动作图标'},'×')),
    h('footer',null,h('button',{type:'button',onClick:close},'取消'),h('button',{className:'primary',disabled:true},'禁用确认')));
}
function close(){note('close');flushSync(()=>updateActive(null));}
function Frame(){
  const [facts,setFacts]=useState(initial),[active,setActive]=useState(null),[toolbar,setToolbar]=useState(null),[inline,setInline]=useState(null);
  updateFacts=setFacts;updateActive=setActive;currentFacts=facts;
  useLayoutEffect(()=>{document.documentElement.dataset.appearance=facts.appearance;document.documentElement.dataset.accent=facts.accent;},[facts.appearance,facts.accent]);
  const p={client,onClose:close};let child=null;
  switch(active){
    case 'project-create':child=h(CreateDialog,{...p,kind:'project',projectId:project.id,onCreated:forbid('created')});break;
    case 'document':child=h(CreateDialog,{...p,kind:'document',projectId:project.id,toolbarTarget:toolbar,onCreated:forbid('created')});break;
    case 'execution':case 'execution-embedded':child=h(ExecutionDialog,{...p,scope,onOpen:forbid('open'),embedded:active==='execution-embedded'});break;
    case 'bookmarks':child=h(BookmarkDialog,{...p,selected:{id:'original-bookmark',title:'原收藏名称',url:'https://example.invalid',revision:1},onChanged:forbid('changed'),onOpen:forbid('open')});break;
    case 'speech-consent':case 'speech-voice':child=h(SpeechDialog,{...p,scope,title:'原输入范围',onInsert:forbid('insert'),...(active==='speech-consent'?{inlineTarget:inline}: {})});break;
    case 'connection':child=h(ConnectionDetails,p);break;
    case 'notifications':child=h(Notifications,{...p,open:true,hideTrigger:true,onOpen:forbid('open'),onSettings:()=>note('notification-settings'),onOpenChange:value=>{if(!value)close();}});break;
    case 'settings':child=h(SettingsDialog,{...p,initialSection:'appearance',prefs:interfacePreferences(facts),onPreference:value=>setFacts(old=>({...old,...value}))});break;
    case 'attachment':child=h(Preview,{a:{assetId:'isolated-image',mime:'image/svg+xml',name:'原比例图片'},url:image,onClose:close});break;
    case 'project-action':child=h(ProjectActionDialog,{...p,project,action:'rename',onSaved:forbid('saved')});break;
    case 'content-metadata':case 'content-move':child=h(ContentMetadata,{...p,entry,projects:state.projects,mode:active==='content-move'?'move':'rename',onSaved:forbid('saved')});break;
    case 'script':case 'fields':child=h(StudioDialog,{title:'原剧本对话框',onClose:close,compact:facts.compact},active==='fields'?h(Fields):h('form',{onSubmit:e=>e.preventDefault()},
      h('label',{className:'field'},'名称',h('input',{'aria-label':'剧本名称',defaultValue:'原剧本'})),
      h('label',{className:'field'},'正文',h('textarea',{'aria-label':'剧本正文',rows:12,defaultValue:'保留领域长正文。\n'.repeat(24)})),
      h('p',{role:'alert'},'受控错误信息。'.repeat(12)),h('footer',null,h('button',{type:'button',onClick:close},'取消'),h('button',{className:'primary'},'保存'))));break;
    case 'reader-note':child=h(NoteDialog,{quote:'原引用。'.repeat(45),initial:'原批注正文',busy:facts.busy,onClose:close,onSave:body=>note('note-save',body)});break;
    case 'install':child=h(InstallApplication,{...p,app,onInstalled:forbid('installed')});break;
    case 'search':child=h(SearchDocuments,{...p,onOpen:forbid('open'),onQuote:forbid('quote')});break;
    case 'capture':child=h(CaptureDialog,{...p,projectId:project.id,onSaved:forbid('saved')});break;
    case 'library-role':child=h(RoleProbe);break;
  }
  return h('div',{className:'app without-collaboration', 'data-accent':facts.accent,'data-appearance':facts.appearance,style:{zoom:facts.zoom,display:'block',height:'100dvh',minHeight:0}},
    h('input',{id:'origin', 'aria-label':'原输入草稿',defaultValue:'不要丢弃的原始草稿',style:{position:'fixed',left:4,top:4,width:200}}),
    h('main',{className:'workspace',style:{position:'fixed',display:'block',left:facts.left/facts.zoom,right:facts.right/facts.zoom,top:facts.top/facts.zoom,bottom:facts.bottom/facts.zoom,minWidth:0,minHeight:0,overflow:'auto'}},
      h('section',{className:'document-draft',hidden:active!=='document'},h('div',{ref:setToolbar})),h('div',{ref:setInline}),child));
}
const ids=new WeakMap();let nextId=0;
const properties=['display','position','width','height','min-width','max-width','min-height','max-height','padding-top','padding-right','padding-bottom','padding-left','margin-top','margin-right','margin-bottom','margin-left','gap','column-gap','row-gap','font-size','line-height','border-top-width','border-top-color','border-radius','background-color','color','outline-style','outline-width','outline-offset','box-shadow','overflow-x','overflow-y','flex-wrap','justify-content','align-items','transform','translate','animation-name','animation-duration'];
const rect=node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
function snapshot(){
  const dialog=document.querySelector('dialog[open]'),section=document.querySelector('.execution-details'),doc=document.querySelector('section.document-draft[aria-label]');
  const root=dialog??section??doc;
  const one=node=>{if(!ids.has(node))ids.set(node,++nextId);const s=getComputedStyle(node);const r=rect(node),x=r.x+r.width/2,y=r.y+r.height/2;const hit=document.elementFromPoint(x,y);
    return {identity:ids.get(node),tag:node.tagName,classes:node.className,label:node.getAttribute('aria-label')??node.id,
      type:node.getAttribute('type'),disabled:node.matches(':disabled'),value:'value'in node?node.value:null,rect:r,
      style:Object.fromEntries(properties.map(p=>[p,s.getPropertyValue(p)])),hit:!!hit&&(hit===node||node.contains(hit)),
      scrollHeight:node.scrollHeight,clientHeight:node.clientHeight,scrollTop:node.scrollTop};};
  return {root:root?one(root):null,native:!!dialog,modal:dialog?.matches(':modal')??false,
    parts:root?[...root.querySelectorAll('header,h2,strong,footer,label.field,input,select,textarea,button,img')].map(one):[],
    workspace:rect(document.querySelector('.workspace')),vars:dialog?['--modal-center','--modal-max-width','--modal-max-height'].map(k=>dialog.style.getPropertyValue(k)):[],
    active:document.activeElement?.getAttribute('aria-label')??document.activeElement?.id??'',
    events:[...events],requests:[...requests],media:{coarse:matchMedia('(pointer:coarse)').matches,reduced:matchMedia('(prefers-reduced-motion: reduce)').matches},facts:currentFacts};
}
createRoot(document.getElementById('root')).render(h(Frame));
window.dialogFrame={snapshot,open:name=>{events.length=0;requests.length=0;flushSync(()=>updateActive(name));},close,
  configure:value=>flushSync(()=>updateFacts(old=>({...old,...value}))),focusOrigin:()=>{const input=document.getElementById('origin');input.focus();input.setSelectionRange(3,9);},
  ready:()=>!!updateActive};
`;
