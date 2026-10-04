// Fixed finite recipes independently captured from actual Git 57e7d4ce.
// Historical source provenance is not a whole-current-file CI lock.
export const fixedControlRoles = {
  baseline: "57e7d4ce97416bf39fc2a1eb2f00951bca6def8d",
  common: [
    {
      source: "styles.css",
      phase: "base",
      selector: "button,\ninput,\ntextarea,\nselect",
      context: [],
      declarations: [
        {
          property: "font",
          value: "inherit",
          important: false,
        },
        {
          property: "min-width",
          value: "0",
          important: false,
        },
      ],
      rawSha256:
        "5c4b43fbee4ca44cdd8c557dec546bfb118d47cb9ab3ab830dd75b24d70d858b",
    },
    {
      source: "styles.css",
      phase: "base",
      selector: "button",
      context: [],
      declarations: [
        {
          property: "cursor",
          value: "pointer",
          important: false,
        },
      ],
      rawSha256:
        "e9ba1d4e4df2c8ad1c9c92e43009b4440295829b0af3fe3257b52778f038ec98",
    },
    {
      source: "styles.css",
      phase: "base",
      selector: "button:disabled",
      context: [],
      declarations: [
        {
          property: "cursor",
          value: "default",
          important: false,
        },
        {
          property: "opacity",
          value: "0.45",
          important: false,
        },
      ],
      rawSha256:
        "02707c6e57385e5a23aa597fe23017d2f4e506ccb7b1dcd38f3228d08717cae6",
    },
    {
      source: "styles.css",
      phase: "base",
      selector: ".app button,\n.startup button,\n.connection-screen button",
      context: [],
      declarations: [
        {
          property: "border",
          value: "0",
          important: false,
        },
        {
          property: "background",
          value: "transparent",
          important: false,
        },
        {
          property: "color",
          value: "inherit",
          important: false,
        },
        {
          property: "display",
          value: "inline-flex",
          important: false,
        },
        {
          property: "align-items",
          value: "center",
          important: false,
        },
        {
          property: "gap",
          value: "8px",
          important: false,
        },
        {
          property: "border-radius",
          value: "7px",
          important: false,
        },
        {
          property: "padding",
          value: "7px 10px",
          important: false,
        },
        {
          property: "text-align",
          value: "left",
          important: false,
        },
        {
          property: "line-height",
          value: "1.4",
          important: false,
        },
        {
          property: "font-size",
          value: "12px",
          important: false,
        },
      ],
      rawSha256:
        "437347e40824b59c33b0d4ecdcfc982b36ba14e38164f58a8b35968319b15ec7",
    },
    {
      source: "styles.css",
      phase: "base",
      selector:
        ".app button:hover:not(:disabled),\n.startup button:hover,\n.connection-screen button:hover:not(:disabled)",
      context: [],
      declarations: [
        {
          property: "background",
          value: "var(--soft)",
          important: false,
        },
      ],
      rawSha256:
        "25ef714799ad85eb0ae2918edde489b078a9aba9d2ee575ae43fb0fe32baeed7",
    },
    {
      source: "styles.css",
      phase: "base",
      selector:
        ".app button:focus-visible,\n.app a:focus-visible,\n.connection-screen button:focus-visible",
      context: [],
      declarations: [
        {
          property: "outline",
          value: "2px solid var(--accent)",
          important: false,
        },
        {
          property: "outline-offset",
          value: "3px",
          important: false,
        },
      ],
      rawSha256:
        "d0a65b9e68478b2a2ad1d1affcf06d43f24c8cd079a9ad174e0c1ab3980bb728",
    },
    {
      source: "styles.css",
      phase: "base",
      selector:
        ".app input,\n.app textarea,\n.app select,\n.connection-screen input",
      context: [],
      declarations: [
        {
          property: "background",
          value: "var(--paper)",
          important: false,
        },
        {
          property: "color",
          value: "var(--ink)",
          important: false,
        },
        {
          property: "border",
          value: "1px solid var(--line)",
          important: false,
        },
        {
          property: "border-radius",
          value: "8px",
          important: false,
        },
        {
          property: "padding",
          value: "9px 11px",
          important: false,
        },
      ],
      rawSha256:
        "2ae46b1f6838e75cdd0af062e504a0f2ac1043930dee1a3a7125885d2a66cd9d",
    },
    {
      source: "styles.css",
      phase: "base",
      selector: ".app textarea",
      context: [],
      declarations: [
        {
          property: "resize",
          value: "vertical",
          important: false,
        },
        {
          property: "line-height",
          value: "1.8",
          important: false,
        },
      ],
      rawSha256:
        "b18e75e588d61fb33578ea37c3dfc013e26fbdf21600b4ecf248ee85395d5756",
    },
    {
      source: "styles.css",
      phase: "base",
      selector: ".app input::placeholder,\n.app textarea::placeholder",
      context: [],
      declarations: [
        {
          property: "color",
          value: "var(--muted)",
          important: false,
        },
        {
          property: "opacity",
          value: "0.85",
          important: false,
        },
      ],
      rawSha256:
        "b0f6e650e1d9a055eec1537ac55f4337b92c581289f2eab66166d0be37e96c27",
    },
    {
      source: "styles.css",
      phase: "base",
      selector:
        ".app input:focus,\n.app textarea:focus,\n.app select:focus,\n.connection-screen input:focus",
      context: [],
      declarations: [
        {
          property: "outline",
          value: "2px solid var(--accent)",
          important: false,
        },
        {
          property: "outline-offset",
          value: "2px",
          important: false,
        },
      ],
      rawSha256:
        "87a6e215cf93c6fbc775b0f6faaa628eb9c7d6837d820d0a8e48d4e0d4c59ca3",
    },
    {
      source: "styles.css",
      phase: "base",
      selector: ".app .primary,\n.connection-screen .primary",
      context: [],
      declarations: [
        {
          property: "background",
          value: "var(--accent)",
          important: false,
        },
        {
          property: "color",
          value: "var(--on-accent)",
          important: false,
        },
        {
          property: "padding",
          value: "9px 14px",
          important: false,
        },
        {
          property: "font-weight",
          value: "550",
          important: false,
        },
      ],
      rawSha256:
        "d3bcdf0391953451f7571eb7b2eb4e1ccb9aa559fc3cbb07d269cf8c6dfc6b22",
    },
    {
      source: "styles.css",
      phase: "base",
      selector:
        ".app .primary:hover:not(:disabled),\n.app .send:hover:not(:disabled),\n.connection-screen .primary:hover:not(:disabled)",
      context: [],
      declarations: [
        {
          property: "background",
          value: "var(--accent-strong)",
          important: false,
        },
      ],
      rawSha256:
        "6404888c9dd5527f81068c77dca7b560516023406f77360b75c66fe4719810f9",
    },
    {
      source: "styles.css",
      phase: "base",
      selector: ".app .outline",
      context: [],
      declarations: [
        {
          property: "border",
          value: "1px solid var(--line)",
          important: false,
        },
        {
          property: "background",
          value: "var(--paper)",
          important: false,
        },
        {
          property: "padding",
          value: "8px 11px",
          important: false,
        },
        {
          property: "box-shadow",
          value: "0 1px 2px var(--shadow)",
          important: false,
        },
      ],
      rawSha256:
        "8ff6e12abe81589798f5e218667f83f848d6c9f305042083b2cbb18160e92ecb",
    },
    {
      source: "styles.css",
      phase: "base",
      selector: ".app .icon-button",
      context: [],
      declarations: [
        {
          property: "justify-content",
          value: "center",
          important: false,
        },
        {
          property: "width",
          value: "32px",
          important: false,
        },
        {
          property: "height",
          value: "32px",
          important: false,
        },
        {
          property: "padding",
          value: "7px",
          important: false,
        },
        {
          property: "flex-shrink",
          value: "0",
          important: false,
        },
      ],
      rawSha256:
        "1ba50a4dfd5e9a23860840b552a345c0979b21ffbba244e279633e59c71ed7ed",
    },
    {
      source: "styles.css",
      phase: "base",
      selector: ".field",
      context: [],
      declarations: [
        {
          property: "display",
          value: "flex",
          important: false,
        },
        {
          property: "flex-direction",
          value: "column",
          important: false,
        },
        {
          property: "gap",
          value: "7px",
          important: false,
        },
        {
          property: "color",
          value: "var(--muted)",
          important: false,
        },
        {
          property: "font-size",
          value: "11px",
          important: false,
        },
        {
          property: "margin",
          value: "14px 0",
          important: false,
        },
      ],
      rawSha256:
        "54c69f8276b8949abd42cf6b916906fe35821c37c596d38b29239fcb4f0d7990",
    },
    {
      source: "styles.css",
      phase: "base",
      selector: ".field input,\n.field select,\n.field textarea",
      context: [],
      declarations: [
        {
          property: "width",
          value: "100%",
          important: false,
        },
        {
          property: "color",
          value: "var(--ink)",
          important: false,
        },
        {
          property: "font-size",
          value: "13px",
          important: false,
        },
      ],
      rawSha256:
        "252987599f72b197bf6c27a870e02f6666d8135b6631ce34c25a3b338f7a1398",
    },
    {
      source: "styles.css",
      phase: "adaptive",
      selector: ".app button",
      context: [["media", "(pointer: coarse)"]],
      declarations: [
        {
          property: "min-height",
          value: "44px",
          important: false,
        },
      ],
      rawSha256:
        "88cc87bff11057413ffa6535ba6b03d17e5d9522d85015629420617db4a3fab1",
    },
    {
      source: "styles.css",
      phase: "adaptive",
      selector: ".app textarea,\n  .app input,\n  .app select",
      context: [["media", "(pointer: coarse)"]],
      declarations: [
        {
          property: "font-size",
          value: "16px",
          important: false,
        },
      ],
      rawSha256:
        "bf341cf38bc5f48dd05bd5ed002b525701052c44591256ef54c5ac8489f6dcec",
    },
    {
      source: "styles.css",
      phase: "adaptive",
      selector: ".app .icon-button,\n  .app .send",
      context: [["media", "(pointer: coarse)"]],
      declarations: [
        {
          property: "width",
          value: "44px",
          important: false,
        },
        {
          property: "height",
          value: "44px",
          important: false,
        },
      ],
      rawSha256:
        "8f6a06828cd9b4d0baddba0a5b8e9c9fc20e7f2e52ff3b41ce01afc86c31912e",
    },
    {
      source: "styles.css",
      phase: "adaptive",
      selector: "button",
      context: [["media", "(prefers-reduced-motion: no-preference)"]],
      declarations: [
        {
          property: "transition",
          value: "background-color 0.12s ease",
          important: false,
        },
      ],
      rawSha256:
        "c46b07c281b6b132c35bbe30278d4cad0201ba9041a3d023d85ae5d53e3ea39b",
    },
    {
      source: "ui.css",
      phase: "metrics",
      selector: ".app .primary",
      context: [],
      declarations: [
        {
          property: "background",
          value: "var(--accent-strong)",
          important: false,
        },
      ],
      rawSha256:
        "b76e5d55de27965ea452941ece606d616665cba864ed10d35e1c3dc6c0d460a2",
    },
    {
      source: "ui.css",
      phase: "metrics",
      selector: ".app input::placeholder,\n.app textarea::placeholder",
      context: [],
      declarations: [
        {
          property: "color",
          value: "var(--muted)",
          important: false,
        },
        {
          property: "opacity",
          value: "1",
          important: false,
        },
      ],
      rawSha256:
        "259d705e92bbb9f8db212648213d4de921eef8055ac66d7c50373eea7036209a",
    },
    {
      source: "ui.css",
      phase: "metrics",
      selector: ".app .icon-button",
      context: [],
      declarations: [
        {
          property: "min-width",
          value: "32px",
          important: false,
        },
        {
          property: "min-height",
          value: "32px",
          important: false,
        },
      ],
      rawSha256:
        "3a332eb0932c148c0207c2c7eb78e3382962c5ff6f1d8e0608ce28298470e130",
    },
    {
      source: "visual-system.css",
      phase: "surfaces",
      selector: ".app button:active:not(:disabled)",
      context: [],
      declarations: [
        {
          property: "background-color",
          value: "var(--hover)",
          important: false,
        },
      ],
      rawSha256:
        "1da0e0f207a78aa674fd0479ae9cb3f0f85f997d4035dea0a5ce09a85304adf9",
    },
    {
      source: "visual-system.css",
      phase: "surfaces",
      selector: ".app .outline",
      context: [],
      declarations: [
        {
          property: "background",
          value: "var(--surface-control)",
          important: false,
        },
        {
          property: "border-color",
          value: "var(--line)",
          important: false,
        },
        {
          property: "box-shadow",
          value: "var(--elevation-small)",
          important: false,
        },
      ],
      rawSha256:
        "59bad4d41c0a8292b9b142d4462b3069dd46fbade2b79fbf8b92e230bb01056d",
    },
    {
      source: "visual-system.css",
      phase: "surfaces",
      selector: ".app .primary",
      context: [],
      declarations: [
        {
          property: "box-shadow",
          value: "var(--elevation-small)",
          important: false,
        },
      ],
      rawSha256:
        "d66d382991ac4d48f33fe1906b5e2f6ad84b5e979bb2d7d5b50b9a83ef4b1c22",
    },
    {
      source: "visual-system.css",
      phase: "surfaces",
      selector:
        ".app .secondary-action,\n.app .create-dialog > footer > button:not(.primary),\n.app .create-dialog > form > footer > button:not(.primary),\n.app .search-dialog > footer > button,\n.app .editor-actions > button:not(.primary)",
      context: [],
      declarations: [
        {
          property: "min-height",
          value: "28px",
          important: false,
        },
        {
          property: "padding",
          value: "4px 9px",
          important: false,
        },
        {
          property: "gap",
          value: "6px",
          important: false,
        },
        {
          property: "border",
          value: "1px solid var(--control-border)",
          important: false,
        },
        {
          property: "border-radius",
          value: "6px",
          important: false,
        },
        {
          property: "background",
          value: "var(--control-fill)",
          important: false,
        },
        {
          property: "color",
          value: "var(--ink)",
          important: false,
        },
        {
          property: "font-size",
          value: "12px",
          important: false,
        },
        {
          property: "font-weight",
          value: "500",
          important: false,
        },
        {
          property: "line-height",
          value: "18px",
          important: false,
        },
        {
          property: "white-space",
          value: "nowrap",
          important: false,
        },
        {
          property: "box-shadow",
          value: "none",
          important: false,
        },
      ],
      rawSha256:
        "a5cc7820850ddee7003b1e4c21de52c08adc05ddad0389a44c5804d9df59ad13",
    },
    {
      source: "visual-system.css",
      phase: "surfaces",
      selector:
        ".app .secondary-action:hover:not(:disabled),\n.app .create-dialog > footer > button:not(.primary):hover:not(:disabled),\n.app .create-dialog > form > footer > button:not(.primary):hover:not(:disabled),\n.app .search-dialog > footer > button:hover:not(:disabled),\n.app .editor-actions > button:not(.primary):hover:not(:disabled)",
      context: [],
      declarations: [
        {
          property: "background",
          value: "var(--hover)",
          important: false,
        },
        {
          property: "border-color",
          value: "var(--muted)",
          important: false,
        },
      ],
      rawSha256:
        "c9f229f3d607842f1d16b0f8d0c2bb1de58092030bb7911827bb45fe19619831",
    },
    {
      source: "visual-system.css",
      phase: "surfaces",
      selector: ".app .secondary-action:active:not(:disabled)",
      context: [],
      declarations: [
        {
          property: "background",
          value: "var(--selection)",
          important: false,
        },
      ],
      rawSha256:
        "f8667334a42aa7825c6a3b0fe54c2329d794c604320499feb08b69247958dcd8",
    },
    {
      source: "visual-system.css",
      phase: "surfaces",
      selector: ".app .creation-actions .secondary-action strong",
      context: [],
      declarations: [
        {
          property: "font-weight",
          value: "500",
          important: false,
        },
      ],
      rawSha256:
        "b364cb093cba09d930a83c19616ce7d7f144c33a82ba7d15fdef8da4062b11a5",
    },
    {
      source: "visual-system.css",
      phase: "surfaces",
      selector: ".app .secondary-action .creation-icon",
      context: [],
      declarations: [
        {
          property: "color",
          value: "inherit",
          important: false,
        },
      ],
      rawSha256:
        "e029330a105e2ffa8b3f0a77ba4dfb906b3af6ec64b60d7cd8a612b2034cd680",
    },
  ],
  browser: {
    file: "styles.css",
    phase: "browser",
    selector: ".browser-toolbar input",
    context: [],
    declarations: [
      {
        property: "min-width",
        value: "60px",
        important: false,
      },
      {
        property: "width",
        value: "100%",
        important: false,
      },
      {
        property: "border",
        value: "0",
        important: false,
      },
      {
        property: "background",
        value: "transparent",
        important: false,
      },
      {
        property: "color",
        value: "inherit",
        important: false,
      },
      {
        property: "font-size",
        value: "12px",
        important: false,
      },
    ],
    rawSha256:
      "099ca4026780b9c05ea8821d6d7ee7cadd07054d9265cfc553418e079735ad96",
  },
} as const;

// Complete current production components, not class-only replicas. The loader
// relocates __SOURCE__/__CORE__; controlled reads never call a business Host.
export const controlRoleBrowserFixture = String.raw`
import React,{useState,useLayoutEffect} from 'react';
import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';
import{BrowserHost}from'__SOURCE__/BrowserHost.tsx';
import{ArtifactEditor}from'__SOURCE__/ArtifactEditor.tsx';
import{CreateDialog}from'__SOURCE__/features/creation/CreateDialog.tsx';
import{InteractiveArtifact}from'__SOURCE__/InteractiveArtifact.tsx';
import{ComposerToolButtons}from'__SOURCE__/ComposerToolButtons.tsx';
import{initialWorkspace}from'__CORE__/model.ts';
import{storageScope}from'__SOURCE__/local-preferences.ts';
const h=React.createElement,stamp='2026-10-04T00:00:00.000Z',state=initialWorkspace(stamp),project=state.projects[0];
const bookmark={id:'role-bookmark',url:'https://example.invalid/',title:'原收藏',revision:1,createdAt:stamp,updatedAt:stamp};
state.bookmarks=[bookmark];
const content={kind:'document',markdown:'# 原文\n\n保持内容与草稿。'};
const artifact={id:'role-document',projectId:project.id,title:'原对象',content,revision:1,createdAt:stamp,updatedAt:stamp,
 createdBy:{actantId:'human'},versions:[{revision:1,title:'原对象',content,author:{actantId:'human'},createdAt:stamp}]};
state.artifacts.push(artifact);
storageScope('role-center','role-human');
const events=[],requests=[];let pending;
const client={online:true,workspaceChangeRevision:1,contentCatalogVersion:1,contentCatalog:[],contentCounts:[],taskCounts:[],
 boot:{centerId:'role-center',principalId:'role-human',csrfToken:'role-csrf',workspace:state,capabilities:{browserBookmarks:false}},
 bookmarkList:async()=>{requests.push('bookmarkList');return [bookmark];},
 workRelationsFor:async()=>{requests.push('workRelationsFor');return [];},
 resolveCatalogContent:async()=>{requests.push('resolveCatalogContent');return null;},
 execute:command=>{events.push(['execute',command.type]);return new Promise(resolve=>{pending=resolve;});},
 refresh:async()=>{events.push(['refresh']);},
};
const initial={mode:'browser',appearance:'light',accent:'cyan',zoom:1,outside:false};let configure,activeFacts=initial;
function Frame(){
 const[facts,setFacts]=useState(initial),[toolbar,setToolbar]=useState(null),[table,setTable]=useState({kind:'interactive',layout:'table',description:'原说明',
 columns:[{id:'title',title:'名称',type:'text',required:false},{id:'done',title:'完成',type:'boolean',required:false}],rows:[{id:'row1',cells:{title:'原记录',done:false}}]});
 configure=value=>{events.length=0;requests.length=0;flushSync(()=>setFacts(old=>({...old,...value})));};activeFacts=facts;
 useLayoutEffect(()=>{document.documentElement.dataset.appearance=facts.appearance;},[facts.appearance]);
 let child;
 if(facts.mode==='browser')child=h(BrowserHost,{client,initialURL:bookmark.url,onReturn:()=>events.push(['return'])});
 else if(facts.mode==='editor')child=h(ArtifactEditor,{artifact,state,client,onOpen:id=>events.push(['open',id]),onSelect:()=>events.push(['select']),
 onNotice:text=>events.push(['notice',text]),toolbarTarget:toolbar,onTaskInput:()=>events.push(['task-input'])});
 else if(facts.mode==='table')child=h(InteractiveArtifact,{value:table,onChange:setTable});
 else child=h(CreateDialog,{kind:facts.mode==='project'?'project':'document',projectId:project.id,client,
 onClose:()=>configure({mode:'browser'}),onCreated:()=>events.push(['created']),...(facts.mode==='document'?{toolbarTarget:toolbar}:{})});
 return h('div',{className:facts.outside?'role-compatibility':'app without-collaboration','data-appearance':facts.appearance,'data-accent':facts.accent,
 style:{display:'block',height:'100dvh',minHeight:0,overflow:'auto',zoom:facts.zoom,padding:16}},
 h('main',{className:facts.outside?'role-compatibility-main':'workspace',style:{display:'block',minHeight:0}},
 h('div',{ref:setToolbar,className:'workspace-page-toolbar'}),child,
 facts.mode==='browser'?h(ComposerToolButtons,{options:[{id:'history',label:'原交流图标',iconId:'message-square-text',onSelect:()=>events.push(['tool'])}]}):null));
}
const ids=new WeakMap();let nextId=0;
const props=['font-size','font-weight','line-height','width','height','min-width','min-height','padding-top','padding-right','padding-bottom','padding-left',
 'margin-top','margin-right','margin-bottom','margin-left','gap','display','align-items','justify-content','flex-shrink','text-align','white-space',
 'border-top-width','border-top-style','border-top-color','border-radius','background-color','background-image','color','box-shadow','outline-width',
 'outline-style','outline-color','outline-offset','opacity','cursor','transition-property','transition-duration','animation-name','transform'];
const parts=()=>[...document.querySelectorAll('input,textarea,select,button,label.field')];
function snapshot(){return {facts:activeFacts,media:{coarse:matchMedia('(pointer:coarse)').matches,reduced:matchMedia('(prefers-reduced-motion:reduce)').matches,contrast:matchMedia('(prefers-contrast:more)').matches},
 parts:parts().map(node=>{if(!ids.has(node))ids.set(node,++nextId);const r=node.getBoundingClientRect(),style=getComputedStyle(node);return {
 identity:ids.get(node),tag:node.tagName,label:node.getAttribute('aria-label')??node.textContent.trim(),classes:node.className,type:node.getAttribute('type'),
 disabled:node.matches(':disabled'),value:'value'in node?node.value:null,pressed:node.getAttribute('aria-pressed'),
 rect:[r.x,r.y,r.width,r.height],style:Object.fromEntries(props.map(p=>[p,style.getPropertyValue(p)])),
 svg:[...node.querySelectorAll('svg')].map(icon=>{const r=icon.getBoundingClientRect();return[r.width,r.height];})};}),
 dialog:!!document.querySelector('dialog:modal'),portal:document.querySelector('.browser-bookmarks-dialog')?.parentElement?.className??null,events:[...events],requests:[...requests]};}
createRoot(document.getElementById('root')).render(h(React.StrictMode,null,h(Frame)));
window.controlRoles={configure:value=>configure(value),snapshot,ready:()=>!!configure,
 release:()=>{pending?.({entityId:'created-role'});pending=undefined;},
 identity:()=>parts(),same:nodes=>{const now=parts();return nodes.length===now.length&&nodes.every((node,index)=>now[index]===node);}};
`;
