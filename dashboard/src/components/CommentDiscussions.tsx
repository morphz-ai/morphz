import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ArrowUp, ChevronDown, MessageCircle, Plus, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import type { CommentDiscussionController } from '../../../application/packages/core/src/comment-discussion-controller'
import type { DashboardDiscussionSource } from './useCommentDiscussions'
import './comment-discussions.css'

export function CommentDiscussionPanel({controller,point,readOnly}:{controller:CommentDiscussionController<DashboardDiscussionSource>;point:{x:number;y:number};readOnly:boolean}) {
  const {t}=useTranslation()
  useSyncExternalStore(controller.subscribe,controller.snapshot,controller.snapshot)
  const view=controller.active,panel=useRef<HTMLElement>(null)
  const [directoryFor,setDirectoryFor]=useState<string|null>(null)
  const directory=!!view&&directoryFor===view.id
  useLayoutEffect(()=>{
    const element=panel.current;if(!view||!element)return
    const position=()=>{
      const zoom=(element as HTMLElement&{currentCSSZoom?:number}).currentCSSZoom??1
      element.style.maxWidth=`${innerWidth/zoom-24}px`;element.style.maxHeight=`${innerHeight/zoom-24}px`
      element.style.left=`${Math.max(12,Math.min(point.x/zoom-element.offsetWidth/2,innerWidth/zoom-element.offsetWidth-12))}px`
      const below=point.y/zoom+16
      element.style.top=`${Math.max(12,Math.min(below,innerHeight/zoom-element.offsetHeight-12))}px`
    }
    const observer=new ResizeObserver(position);observer.observe(element)
    window.addEventListener('resize',position);position()
    return()=>{observer.disconnect();window.removeEventListener('resize',position)}
  },[view,point])
  if(!view)return null
  const known=new Map(view.directory.map(item=>[item.id,item.title||item.preview]))
  for(const item of controller.views.values())if(item.quote.key===view.quote.key)known.set(item.id,item.messages.find(message=>message.kind==='input')?.text??item.quote.text)
  return <section ref={panel} className="dashboard-discussion" role="region" aria-label={t('discussion.title')} onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();setDirectoryFor(null);controller.close()}}}>
    <header><button type="button" className="discussion-heading" aria-expanded={directory} onClick={()=>setDirectoryFor(directory?null:view.id)}><MessageCircle size={14}/><span>{t('discussion.title')}</span><ChevronDown size={12}/></button><span/>
      <button type="button" title={t('discussion.new')} aria-label={t('discussion.new')} onClick={()=>controller.open(view.quote,true)}><Plus size={15}/></button>
      <button type="button" title={t('discussion.close')} aria-label={t('discussion.close')} onClick={()=>{setDirectoryFor(null);controller.close()}}><X size={15}/></button></header>
    {directory&&<nav aria-label={t('discussion.directory')}>{[...known].map(([id,text])=><button type="button" key={id} aria-current={view.id===id?'true':undefined} onClick={()=>{setDirectoryFor(null);void controller.select(id)}}>{text}</button>)}{view.directoryCursor&&<button type="button" disabled={view.directoryLoading} onClick={()=>controller.olderDiscussions()}>{t('discussion.olderDiscussions')}</button>}</nav>}
    <blockquote className="discussion-source" title={view.quote.text}>{view.quote.text}</blockquote>
    <div className="discussion-messages" aria-live="polite">
      {view.nextCursor&&<button type="button" disabled={view.loading} onClick={()=>void controller.older()}>{t('discussion.older')}</button>}
      {view.messages.map(message=><article key={message.id} className={`discussion-message ${message.kind}`}>{message.kind==='input'?<p>{message.text}</p>:<ReactMarkdown remarkPlugins={[remarkGfm,remarkBreaks]} components={{a:({href,children})=><a href={href} target="_blank" rel="noopener noreferrer">{children}</a>}}>{message.text}</ReactMarkdown>}{message.contentOmitted&&<button type="button" disabled={view.loading} onClick={()=>void controller.openMessage(message.id)}>{t(message.text?'discussion.readMore':'discussion.expand')}</button>}</article>)}
      {view.loading&&<small role="status">{t('discussion.loading')}</small>}
    </div>
    {view.error&&<div className="discussion-error" role="alert">{view.error}<button type="button" onClick={()=>view.pending?void controller.send():controller.retryRead()}>{t('discussion.retry')}</button></div>}
    <form onSubmit={event=>{event.preventDefault();void controller.send()}}><textarea key={view.id} autoFocus rows={2} maxLength={10000} aria-label={t('discussion.input')} placeholder={t(view.submitted?'discussion.followup':'discussion.placeholder')} disabled={readOnly||!!view.pending} value={view.draft} onChange={event=>controller.draft(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();void controller.send()}}}/>
      <div className="discussion-compose-footer">{!view.submitted&&<label><input type="checkbox" checked={view.publish} disabled={!!view.pending||readOnly} onChange={event=>controller.publish(event.target.checked)}/>{t('discussion.publish')}</label>}<button type="submit" className="discussion-send" disabled={view.sending||!!view.pending||!view.sourceReady||!view.draft.trim()||readOnly} aria-label={t('discussion.send')} title={t('discussion.send')}><ArrowUp size={16}/></button></div>
    </form>
  </section>
}
