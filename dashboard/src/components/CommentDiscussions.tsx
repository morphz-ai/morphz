import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ChevronDown, MessageCircle, Send, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { MessageMarkdown } from './MessageMarkdown'
import type { CommentDiscussionController } from '../../../application/packages/core/src/comment-discussion-controller'
import type { DashboardDiscussionSource } from './useCommentDiscussions'
import {discussionRange,type DiscussionMarks} from '../../../application/packages/core/src/discussion-marks-dom'
import {observeTextPopover,positionTextPopover,type TextAnchor} from '../../../application/packages/core/src/text-popover-layout'
import './comment-discussions.css'

export function CommentDiscussionMarks({owner}:{owner:DiscussionMarks<DashboardDiscussionSource>}) {
  const {t}=useTranslation(),layer=useRef<HTMLDivElement>(null)
  const version=useSyncExternalStore(owner.subscribe,owner.snapshot,owner.snapshot)
  useLayoutEffect(()=>{const node=layer.current;if(!node)return;const zoom=(node as HTMLElement&{currentCSSZoom?:number}).currentCSSZoom??1;[...node.children].forEach((child,index)=>{const mark=owner.marks[index];if(mark&&child instanceof HTMLElement){child.style.left=`${mark.x/zoom}px`;child.style.top=`${mark.y/zoom}px`}})},[owner,version])
  return <div ref={layer} className="discussion-mark-layer" data-discussion-ui="true">{owner.marks.map(mark=><button type="button" key={mark.key} className="discussion-source-mark" title={`${t('discussion.title')} · ${mark.preview}`} aria-label={`${t('discussion.title')} (${mark.count}${mark.more?'+':''})`} onClick={()=>owner.open(mark)}><MessageCircle size={14}/>{(mark.count>1||mark.more)&&<span>{mark.count}{mark.more?'+':''}</span>}</button>)}</div>
}

export function CommentDiscussionPanel({controller,point,readOnly}:{controller:CommentDiscussionController<DashboardDiscussionSource>;point:TextAnchor;readOnly:boolean}) {
  const {t}=useTranslation()
  useSyncExternalStore(controller.subscribe,controller.snapshot,controller.snapshot)
  const view=controller.active,panel=useRef<HTMLElement>(null)
  const messages=useRef<HTMLDivElement>(null),following=useRef(true)
  const [directoryFor,setDirectoryFor]=useState<string|null>(null)
  const directory=!!view&&directoryFor===view.id
  const opened=!!view
  const latest=view?.messages.at(-1)
  useLayoutEffect(()=>{following.current=true},[view?.id])
  useLayoutEffect(()=>{const node=messages.current;if(node&&following.current)node.scrollTop=node.scrollHeight},[view?.id,latest?.id,latest?.text])
  useLayoutEffect(()=>{const field=panel.current?.querySelector('textarea');if(field){field.style.height='auto';field.style.height=`${Math.min(140,field.scrollHeight)}px`}},[view?.id,view?.draft])
  useEffect(()=>{if(!opened)return;const outside=(event:PointerEvent)=>{if(event.target instanceof Node&&!panel.current?.contains(event.target)){setDirectoryFor(null);controller.close()}};document.addEventListener('pointerdown',outside,true);return()=>document.removeEventListener('pointerdown',outside,true)},[controller,opened])
  useLayoutEffect(()=>{
    const element=panel.current;if(!view||!element)return
    return observeTextPopover(element,()=>{
      const id=view.quote.locator.event_id;
      const article=[...document.querySelectorAll<HTMLElement>('article[data-event-id]')].find(node=>node.dataset.eventId===id);
      const body=article?.querySelector<HTMLElement>('.message-body');
      const range=body&&discussionRange(body,{id:view.id,title:'',preview:Array.from(view.quote.text).slice(0,160).join(''),text:view.quote.text,locator:view.quote.locator,created_at_micros:0,publish_to_session:view.publish});
      const rect=range?.getBoundingClientRect();
      void positionTextPopover(element,rect?{x:rect.right,y:rect.bottom,rect}:point,'right-start');
    })
  },[view,point])
  if(!view)return null
  const known=new Map(view.directory.map(item=>[item.id,item.title||item.preview]))
  for(const item of controller.views.values())if(item.quote.key===view.quote.key)known.set(item.id,item.messages.find(message=>message.kind==='input')?.text??item.quote.text)
  return <section ref={panel} className="dashboard-discussion" role="region" aria-label={t('discussion.title')} onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();setDirectoryFor(null);controller.close()}}}>
    <header><button type="button" className="discussion-heading" aria-expanded={directory} onClick={()=>setDirectoryFor(directory?null:view.id)}><MessageCircle size={14}/><span>{t('discussion.title')}</span><ChevronDown size={12}/></button><span/>
      <button type="button" title={t('discussion.close')} aria-label={t('discussion.close')} onClick={()=>{setDirectoryFor(null);controller.close()}}><X size={15}/></button></header>
    {directory&&<nav aria-label={t('discussion.directory')}><button type="button" onClick={()=>{setDirectoryFor(null);controller.open(view.quote,true)}}>{t('discussion.new')}</button>{[...known].map(([id,text])=><button type="button" key={id} aria-current={view.id===id?'true':undefined} onClick={()=>{setDirectoryFor(null);void controller.select(id)}}>{text}</button>)}{view.directoryCursor&&<button type="button" disabled={view.directoryLoading} onClick={()=>controller.olderDiscussions()}>{t('discussion.olderDiscussions')}</button>}</nav>}
    <blockquote className="discussion-source" title={view.quote.text}>{view.quote.text}</blockquote>
    <div ref={messages} className="discussion-messages message-list" aria-live="polite" onScroll={event=>{const node=event.currentTarget;following.current=node.scrollHeight-node.scrollTop-node.clientHeight<32}}>
      {view.nextCursor&&<button type="button" disabled={view.loading} onClick={()=>void controller.older()}>{t('discussion.older')}</button>}
      {view.messages.map(message=><article key={message.id} className={`discussion-message message-row ${message.kind==='input'?'user':message.kind==='error'?'system':'agent'} ${message.streaming?'streaming':''}`}><div className="message-body"><MessageMarkdown text={message.text}/>{message.streaming&&<span className="stream-caret" aria-hidden="true"/>}</div>{message.contentOmitted&&<button className="discussion-action" type="button" disabled={view.loading} onClick={()=>void controller.openMessage(message.id)}>{t(message.text?'discussion.readMore':'discussion.expand')}</button>}</article>)}
      {view.loading&&<small role="status">{t('discussion.loading')}</small>}
    </div>
    {view.error&&<div className="discussion-error" role="alert">{view.error}<button type="button" onClick={()=>view.pending?void controller.send():controller.retryRead()}>{t('discussion.retry')}</button></div>}
    <div className="discussion-compose">
      {!view.submitted&&<label className="discussion-publish"><input type="checkbox" checked={view.publish} disabled={!!view.pending||readOnly} onChange={event=>controller.publish(event.target.checked)}/>{t('discussion.publish')}</label>}
      <form className="composer" onSubmit={event=>{event.preventDefault();void controller.send()}}><span className="composer-prompt" aria-hidden="true">›</span><textarea key={view.id} autoFocus rows={1} maxLength={10000} aria-label={t('discussion.input')} placeholder={t(view.submitted?'discussion.followup':'discussion.placeholder')} disabled={readOnly||!!view.pending} value={view.draft} onChange={event=>controller.draft(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();void controller.send()}}}/>
        <button type="submit" className="send-button discussion-send" disabled={view.sending||!!view.pending||!view.sourceReady||!view.draft.trim()||readOnly} aria-label={t('discussion.send')} title={t('discussion.send')}><Send size={15}/></button>
      </form>
    </div>
  </section>
}
